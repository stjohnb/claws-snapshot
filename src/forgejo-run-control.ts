/**
 * Cancel Forgejo Actions runs and disable or enable a workflow, for the
 * session tools `claws_cancel_runs` / `claws_set_workflow_enabled` and the
 * dashboard (#clw_01M7X2XQESHRXWHA4Z59EXWT7Y). The forge calls go through the
 * `github.ts` façade to the image's run-control API patch; every cancel and
 * toggle is recorded in `actions_control_log`, logged at `info` and counted
 * in `claws_actions_control_total`.
 */
import * as gh from "./github.js";
import * as log from "./log.js";
import { deleteDisabledWorkflow, recordActionsControl, upsertDisabledWorkflow, type ActionsControlAction } from "./db.js";
import { recordActionsControlMetric } from "./metrics.js";
import { ForgejoActionNotFoundError, ForgejoRunControlEndpointUnavailableError } from "./forgejo.js";
import { mapSettledWithConcurrency, mapWithConcurrency } from "./util.js";

const COMPONENT = "actions-control";

/** Most runs one filtered cancel may match; more is refused with the count. */
export const MAX_FILTERED_CANCEL = 200;
/** Most run numbers one explicit cancel may name. */
export const MAX_EXPLICIT_RUNS = 100;
/** Concurrent cancel calls against Forgejo. */
const CANCEL_CONCURRENCY = 4;

/** Workflow files the toggle accepts: a bare `.yml`/`.yaml` file name. */
export const WORKFLOW_FILE_RE = /^[\w.-]+\.ya?ml$/;

/** A refused request: `status` is the HTTP status the routes answer with. */
export class RunControlRequestError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "RunControlRequestError";
  }
}

/**
 * Which runs to cancel: either `runs` (explicit run numbers, 1–100) or a
 * filter of at least one of `prNumbers`, `workflow` and `event`. A filter
 * matches waiting and blocked runs, plus running ones with `includeRunning`.
 * `dryRun` lists the matches and cancels nothing.
 */
export interface CancelSelector {
  runs?: number[];
  prNumbers?: number[];
  workflow?: string;
  event?: string;
  includeRunning?: boolean;
  dryRun?: boolean;
}

/** One run in a cancel result. `pr` is set when the run was matched through `prNumbers`. */
export interface CancelRunEntry {
  run: number;
  workflow: string;
  event: string;
  ref: string | null;
  status: string;
  pr?: number;
  error?: string;
}

export type CancelRunsResult =
  | { would_cancel: CancelRunEntry[] }
  | { cancelled: CancelRunEntry[]; already_finished: CancelRunEntry[]; failed: CancelRunEntry[] };

export interface WorkflowToggleResult {
  workflow: string;
  enabled: boolean;
  /** Every workflow file now disabled on the repo, sorted. */
  disabled_workflows: string[];
}

const UNFINISHED = ["waiting", "blocked"];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Validate a selector and say whether it is an explicit run list. */
function validateSelector(selector: CancelSelector): "runs" | "filter" {
  const hasRuns = selector.runs !== undefined;
  const hasFilter = (selector.prNumbers?.length ?? 0) > 0 || !!selector.workflow || !!selector.event;
  if (hasRuns && (hasFilter || selector.includeRunning)) {
    throw new RunControlRequestError(400, "Pass either runs or a filter (pr_numbers, workflow, event), not both");
  }
  if (hasRuns) {
    const runs = selector.runs!;
    if (runs.length === 0 || runs.length > MAX_EXPLICIT_RUNS) {
      throw new RunControlRequestError(400, `runs must name 1–${MAX_EXPLICIT_RUNS} run numbers`);
    }
    if (runs.some((r) => !Number.isInteger(r) || r < 1)) throw new RunControlRequestError(400, "runs must be positive run numbers");
    return "runs";
  }
  if (!hasFilter) {
    throw new RunControlRequestError(400, "Pass runs, or a filter with at least one of pr_numbers, workflow or event");
  }
  if (selector.workflow && !WORKFLOW_FILE_RE.test(selector.workflow)) {
    throw new RunControlRequestError(400, `workflow must be a workflow file name such as ci.yml`);
  }
  return "filter";
}

/** The refs a PR's runs carry, each with the `prettyref` Forgejo reports for it. */
async function prRefs(repo: string, prNumbers: number[]): Promise<Array<{ pr: number; ref: string; prettyref: string }>> {
  const defaultBranch = await gh.getDefaultBranch(repo);
  const out: Array<{ pr: number; ref: string; prettyref: string }> = [];
  for (const pr of prNumbers) {
    let head: string;
    let crossRepo: boolean;
    try {
      const info = await gh.getPR(repo, pr);
      head = info.headRefName;
      crossRepo = info.isCrossRepository === true;
    } catch (err) {
      throw new RunControlRequestError(404, `Could not read PR #${pr}: ${errorMessage(err)}`);
    }
    out.push({ pr, ref: `refs/pull/${pr}/head`, prettyref: `#${pr}` });
    // A branch push run belongs to the PR only for a same-repo head that is not
    // the default branch: a fork's branch name means nothing here.
    if (!crossRepo && head && head !== defaultBranch) out.push({ pr, ref: `refs/heads/${head}`, prettyref: head });
  }
  return out;
}

/** The runs a filter matches, de-duplicated and sorted by run number. */
async function selectRuns(repo: string, selector: CancelSelector): Promise<CancelRunEntry[]> {
  const statuses = selector.includeRunning ? [...UNFINISHED, "running"] : UNFINISHED;
  const refs: Array<{ pr?: number; ref?: string; prettyref?: string }> =
    (selector.prNumbers?.length ?? 0) > 0 ? await prRefs(repo, selector.prNumbers!) : [{}];
  const queries = refs.flatMap((r) => statuses.map((status) => ({ ...r, status })));
  const lists = await mapWithConcurrency(queries, 4, async (q) => ({
    q,
    runs: await gh.listActionRuns(repo, {
      status: q.status,
      ...(q.ref ? { ref: q.ref } : {}),
      ...(selector.workflow ? { workflowId: selector.workflow } : {}),
    }),
  }));
  const byRun = new Map<number, CancelRunEntry>();
  for (const { q, runs } of lists) {
    for (const r of runs) {
      // Re-check every server-side filter: an image that ignored one must not
      // widen the cancel to unrelated runs.
      if (r.status !== q.status) continue;
      if (q.prettyref !== undefined && r.ref !== q.prettyref) continue;
      if (selector.workflow && r.workflow !== selector.workflow) continue;
      if (selector.event && r.event !== selector.event) continue;
      if (byRun.has(r.run)) continue;
      byRun.set(r.run, {
        run: r.run,
        workflow: r.workflow,
        event: r.event,
        ref: r.ref,
        status: r.status,
        ...(q.pr !== undefined ? { pr: q.pr } : {}),
      });
    }
  }
  return [...byRun.values()].sort((a, b) => a.run - b.run);
}

/** Look up each explicitly named run; an unknown run lands in `missing`. */
async function lookupRuns(repo: string, runs: number[]): Promise<{ found: CancelRunEntry[]; missing: CancelRunEntry[] }> {
  const unique = [...new Set(runs)].sort((a, b) => a - b);
  const settled = await mapSettledWithConcurrency(unique, CANCEL_CONCURRENCY, (run) => gh.getActionRunByNumber(repo, run));
  const found: CancelRunEntry[] = [];
  const missing: CancelRunEntry[] = [];
  settled.forEach((s, i) => {
    const run = unique[i]!;
    if (s.status === "rejected") {
      missing.push({ run, workflow: "", event: "", ref: null, status: "unknown", error: errorMessage(s.reason) });
    } else if (s.value === null) {
      missing.push({ run, workflow: "", event: "", ref: null, status: "unknown", error: "run not found" });
    } else {
      found.push({ run, workflow: s.value.workflowId, event: s.value.event, ref: s.value.ref, status: s.value.status });
    }
  });
  return { found, missing };
}

/** Record one row; a failed write is logged, never fails the action that already happened. */
async function recordLogged(entry: Parameters<typeof recordActionsControl>[0]): Promise<void> {
  try {
    await recordActionsControl(entry);
  } catch (err) {
    log.warn("actions control audit row not written", { component: COMPONENT, repo: entry.repo, action: entry.action, target: entry.target, actor: entry.actor }, err);
  }
}

/**
 * Cancel the runs `selector` names on `repo` as `actor` (`session:<sid>` or
 * `dashboard`). A filter matching more than {@link MAX_FILTERED_CANCEL} runs is
 * refused with the count. A run that finished between listing and cancel is
 * reported under `already_finished`. Throws {@link RunControlRequestError} for
 * a bad selector, and {@link ForgejoRunControlEndpointUnavailableError} when
 * this Forgejo lacks the cancel route.
 */
export async function cancelRuns(repo: string, selector: CancelSelector, actor: string): Promise<CancelRunsResult> {
  const kind = validateSelector(selector);
  let targets: CancelRunEntry[];
  const failed: CancelRunEntry[] = [];
  if (kind === "runs") {
    const { found, missing } = await lookupRuns(repo, selector.runs!);
    targets = found;
    failed.push(...missing);
  } else {
    targets = await selectRuns(repo, selector);
    if (targets.length > MAX_FILTERED_CANCEL) {
      throw new RunControlRequestError(409, `The filter matches ${targets.length} runs, over the limit of ${MAX_FILTERED_CANCEL} per call; narrow it (pr_numbers, workflow or event)`);
    }
  }
  if (selector.dryRun) return { would_cancel: targets };

  const cancelled: CancelRunEntry[] = [];
  const alreadyFinished: CancelRunEntry[] = [];
  let unavailable: ForgejoRunControlEndpointUnavailableError | null = null;
  const settled = await mapSettledWithConcurrency(targets, CANCEL_CONCURRENCY, (t) => gh.cancelActionRunByIndex(repo, t.run));
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    const s = settled[i]!;
    if (s.status === "fulfilled") {
      const entry = { ...target, status: s.value.run.status };
      if (s.value.cancelled) {
        cancelled.push(entry);
        recordActionsControlMetric("cancel-run", "ok");
        log.info("actions_run_cancelled", { component: COMPONENT, repo, run: target.run, workflow: target.workflow, actor, ...(target.pr !== undefined ? { pr: target.pr } : {}) });
        await recordLogged({
          repo,
          actor,
          action: "cancel-run",
          target: String(target.run),
          prNumber: target.pr ?? null,
          detail: `${target.workflow} (${target.event}${target.ref ? `, ${target.ref}` : ""}) was ${target.status}`,
        });
      } else {
        alreadyFinished.push(entry);
        recordActionsControlMetric("cancel-run", "already_finished");
      }
      continue;
    }
    const err = s.reason;
    if (err instanceof ForgejoActionNotFoundError) {
      failed.push({ ...target, error: "run not found" });
    } else {
      if (err instanceof ForgejoRunControlEndpointUnavailableError) unavailable = err;
      failed.push({ ...target, error: errorMessage(err) });
    }
    recordActionsControlMetric("cancel-run", "failed");
    log.warn("actions run cancel failed", { component: COMPONENT, repo, run: target.run, actor, error: errorMessage(err) });
  }
  // On an image without the route nothing can be cancelled: say so plainly.
  if (unavailable && cancelled.length === 0 && alreadyFinished.length === 0) throw unavailable;
  return { cancelled, already_finished: alreadyFinished, failed };
}

/**
 * Disable (`enabled` false) or enable workflow file `workflow` on `repo` as
 * `actor`. Disabling needs the file under `.forgejo/workflows` on the default
 * branch; enabling does not, so a deleted workflow can still be cleared.
 * Writes through to `disabled_workflows` with `actor`, so the dashboard's
 * banner changes at once. Answers the repo's full disabled list afterwards.
 */
export async function setWorkflowEnabled(repo: string, workflow: string, enabled: boolean, actor: string): Promise<WorkflowToggleResult> {
  if (!WORKFLOW_FILE_RE.test(workflow)) {
    throw new RunControlRequestError(400, "workflow must be a workflow file name such as ci.yml");
  }
  const action: ActionsControlAction = enabled ? "enable-workflow" : "disable-workflow";
  if (!enabled) {
    const entries = await gh.listRepoDirectory(repo, ".forgejo/workflows");
    if (!entries.some((e) => e.type === "file" && e.name === workflow)) {
      throw new RunControlRequestError(404, `No workflow .forgejo/workflows/${workflow} on ${repo}'s default branch`);
    }
  }
  try {
    await gh.setWorkflowDisabled(repo, workflow, !enabled);
  } catch (err) {
    recordActionsControlMetric(action, "failed");
    log.warn(`actions workflow ${enabled ? "enable" : "disable"} failed`, { component: COMPONENT, repo, workflow, actor, error: errorMessage(err) });
    throw err;
  }
  recordActionsControlMetric(action, "ok");
  log.info(enabled ? "actions_workflow_enabled" : "actions_workflow_disabled", { component: COMPONENT, repo, workflow, actor });
  await recordLogged({ repo, actor, action, target: workflow });
  // Write through to the banner's cache so it changes at once, not at the
  // runner monitor's next tick.
  try {
    if (enabled) await deleteDisabledWorkflow(repo, workflow);
    else await upsertDisabledWorkflow(repo, workflow, actor);
  } catch (err) {
    log.warn("disabled workflow cache not updated", { component: COMPONENT, repo, workflow, actor }, err);
  }
  const disabled = await gh.listDisabledWorkflows(repo);
  return { workflow, enabled, disabled_workflows: disabled };
}
