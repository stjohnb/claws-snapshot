/**
 * Planner runs — the in-process registry behind the planner MCP tools
 * (`claws_save_plan`, `claws_report_outcome`, `claws_step_back_verdict`,
 * `claws_followup_verdict`, `claws_keep_plan`).
 *
 * Each planner invocation opens a run with {@link withPlannerRun}: a random
 * UUID mapped to the issue, its stage and the allow-lists the prompt offered.
 * The UUID is baked into that invocation's MCP config, and it is the only
 * thing the tools can act on, so an agent cannot write to any other issue.
 * A tool call reaches {@link submitPlan} / {@link submitOutcome} /
 * {@link submitStepBack} / {@link submitFollowupVerdict} / {@link submitKeepPlan}
 * through `POST /api/planner-runs/:id/...`; each
 * validates the input, returns an error the agent can fix and retry, and on
 * success records the submission on the run (the last call wins).
 *
 * Nothing is published from here. The refiner reads the submission with
 * {@link getSubmission} after the CLI exits, and only then posts the plan
 * comment and writes `claws_issue_prs` — so a timed-out or withheld run never
 * leaves a half-published plan. The registry is in memory on purpose, in
 * whichever process runs the refiner: a restart of that process kills the
 * worktree job holding the run anyway, and the tool call then gets a 404.
 *
 * Where the routes are served follows the registry. In the service
 * (`CLAWS_WORK_BACKEND=in-process`) `server.ts` mounts {@link plannerRunHandler}
 * under `/api/planner-runs`. In an agent pod the refiner runs inside the pod,
 * so the pod serves the same routes itself on a loopback listener
 * (`src/planner-run-listener.ts`) and the MCP child posts there
 * (`CLAWS_MCP_PLANNER_BASE_URL`); the service's copy of the routes never
 * knows a pod's run and would answer 404 (#clw_01M3A42ZTGECAB11S0BZA6NG1A).
 *
 * Every rejected call is counted on the run ({@link getRunRejections}) so the
 * refiner can tell "never called the tool" from "called it and was refused",
 * and refuse to publish the CLI's final message as a plan in the latter case.
 */

import crypto from "node:crypto";
import type { Context } from "hono";
import { parseIssueRef, sameIssueRef, type IssueRef } from "./issue-id.js";
import { findManualActionsSection, isWhatChangesTitle, parsePlan, parsePlanSections, verificationOnlyManualSteps } from "./plan-parser.js";
import { circularManualAction, effectiveDependencies } from "./phase-coverage.js";
import { RequirementsRecordSchema, type RequirementsRecord } from "./requirements-record.js";
import { validateInfraDeclaration, type InfraDeclaration } from "./infra-declaration.js";

export const PLAN_HEADER = "## Implementation Plan";

export function stripLeadingPlanHeader(output: string): string {
  const trimmed = output.trim();
  if (!trimmed.startsWith(PLAN_HEADER)) return trimmed;
  const rest = trimmed.slice(PLAN_HEADER.length);
  // Only strip a standalone header line — "## Implementation Plan for X" must survive.
  if (rest !== "" && !rest.startsWith("\n")) return trimmed;
  return rest.trim();
}

/**
 * `followup` answers comments on an issue whose plan already has open PRs; it
 * may also amend the plan in place without changing its PR set
 * ({@link submitFollowupVerdict}).
 *
 * `verify` checks an existing plan when its issue returns from a dated Backlog
 * park: the run either keeps the plan ({@link submitKeepPlan}) or saves a
 * revised one ({@link submitPlan}); the later call wins.
 */
export type PlannerStage = "plan" | "refine" | "step_back" | "followup" | "verify";

/** Longest `claws_keep_plan` reason accepted. */
export const MAX_KEEP_PLAN_REASON_CHARS = 400;

export const MAX_PLANNED_PRS = 20;
export const MAX_PLANNED_PR_TITLE_CHARS = 200;
export const MAX_MANUAL_ACTION_CHARS = 300;

function verificationOnlyStepError(item: string): string {
  const shown = item.length > 120 ? `${item.slice(0, 120).trim()}…` : item;
  return `operator step "${shown}" is only verification or a CI re-run — CI already runs the change's workflows on main and Claws raises main-branch failures automatically. Delete it (and the Manual actions section if it is left empty); put any check the plan needs into CI in a PR step`;
}

const IMPLEMENTATION_MODELS = ["haiku", "sonnet", "opus"] as const;
const REVIEW_MODELS = ["sonnet", "opus"] as const;
export type ImplementationModel = typeof IMPLEMENTATION_MODELS[number];
export type ReviewModel = typeof REVIEW_MODELS[number];

export interface PlannedPR {
  repo: string;
  title: string;
  /** Earlier positions this PR must land after; `[]` is independent, null unspecified (after the previous PR). */
  dependsOn: number[] | null;
  /**
   * `pr` is a `### PR N:` section; `manual` is the plan's manual-actions
   * section with no PR (see {@link findManualActionsSection}): last, right
   * after PR k when its heading ends `(after PR k)`, or just before the first
   * PR that sets `after_manual_actions` or whose header says `(after manual)`.
   */
  kind: "pr" | "manual";
  /** The operator step that must be done before this PR merges, or null. */
  manualAction: string | null;
  /** The Tofu changes this PR is expected to make (`infra_changes`), or null. */
  infraChanges?: InfraDeclaration | null;
}

export interface PlanSubmission {
  kind: "plan";
  /** Plan text with any leading `## Implementation Plan` header stripped. */
  plan: string;
  prs: PlannedPR[];
  implementationModel: ImplementationModel;
  reviewModel: ReviewModel;
  targetPr: number | null;
  /** Reply to the feedback — refine stage only. */
  response: string | null;
}

/** Why a planner reported `no_code_changes`; decides whether Claws closes the issue or sends it to the Backlog. */
export const NO_CHANGE_KINDS = ["already_resolved", "transient", "operator_task"] as const;
export type NoChangeKind = (typeof NO_CHANGE_KINDS)[number];

export type PlannerOutcome =
  | { kind: "duplicate"; duplicateOf: IssueRef }
  | { kind: "blocked" }
  | { kind: "no_code_changes"; noChangeKind: NoChangeKind };

export interface OutcomeSubmission {
  kind: "outcome";
  outcome: PlannerOutcome;
  explanation: string;
}

export interface StepBackSubmission {
  kind: "step_back";
  verdict: "sound" | "reconsider";
  critique: string | null;
  revised: PlanSubmission | null;
}

export type PlannerSubmission = PlanSubmission | OutcomeSubmission | StepBackSubmission;

/** A PR named by repo and number, canonical repo spelling. */
export interface PRRef {
  repo: string;
  number: number;
}

/**
 * What a design change does to one PR of the old plan: `close` it, `rework` it
 * into the revised plan's step at `position` (its branch takes that step's
 * work), `keep` it as covering that step, or `retire` a merged PR — it
 * shipped, and no step of the revised plan stands for it. `position` is null
 * only for `close` and `retire`.
 */
export interface PRFate extends PRRef {
  fate: "close" | "rework" | "keep" | "retire";
  position: number | null;
}

/**
 * A follow-up run's verdict. `answered` changes nothing but the reply;
 * `plan_amendment` edits the plan in place through the run's `claws_save_plan`
 * submission, which keeps the stored PR set. `design_change` revises the
 * requirements and the plan — whose PR set may change — and holds them for the
 * operator's re-approval (`reapproval.ts`). `affectedPrs` are the open step
 * PRs that must change to match an amendment — empty otherwise.
 */
export interface FollowupVerdict {
  verdict: "answered" | "plan_amendment" | "design_change";
  affectedPrs: PRRef[];
  /** `design_change` only: the revised requirements record, stored unapproved. */
  requirements?: RequirementsRecord;
  /** `design_change` only: one fate per open step PR and per merged step PR. */
  prFates?: PRFate[];
}

/** The error a follow-up amendment that changes the PR set gets. */
export const PR_SET_CHANGED_ERROR =
  "This changes the PR set — that is a design change, not an amendment. Report verdict \"design_change\" instead, with the revised requirements and a fate for every open PR.";

export interface PlannerRunInput {
  repo: string;
  issueRef: IssueRef;
  stage: PlannerStage;
  /** Repos a `prs[].repo` may name, canonical spelling. */
  allowedRepos: readonly string[];
  /**
   * Further managed repos a `prs[].repo` may name, canonical spelling — a
   * native issue's planner adds them to the issue when it records the plan.
   * Default none.
   */
  addableRepos?: readonly string[];
  /** Issues offered as duplicate candidates; empty means the outcome is not offered. */
  allowedDuplicates?: readonly IssueRef[];
  /** False for a pass that may only save a plan (a refinement); default true. */
  allowOutcomes?: boolean;
  /**
   * Follow-up stage: the issue's stored PR list (`getIssuePlannedPRs`), which
   * an amendment must keep — same count and kind at each position, and the same repo for PR entries.
   */
  plannedPrs?: readonly Pick<PlannedPR, "repo" | "kind">[];
  /**
   * Refine/verify stage: stored entries already shipped (linked to a PR or
   * claimed done), by position counting the manual step. A re-plan must keep
   * each at its position, in its repo and kind — the PR body phase markers and
   * `claws-phase-done` claims are numbered against them.
   */
  shippedEntries?: readonly { position: number; repo: string; kind: PlannedPR["kind"] }[];
  /** Follow-up stage: the open step PRs `affected_prs` may name, and a design change must give a fate. */
  openPrs?: readonly PRRef[];
  /**
   * Follow-up stage: the plan's merged step PRs — the stored list's merged
   * links and the merged PRs covering a done step by marker. A design change
   * must `keep` each as covering a step of the revised plan, or `retire` it.
   */
  linkedPrs?: readonly PRRef[];
}

interface PlannerRun extends Required<PlannerRunInput> {
  submission: PlannerSubmission | null;
  /** The follow-up stage's verdict, held apart from the plan it may come with. */
  followupVerdict: FollowupVerdict | null;
  /** The verify stage's "the plan still fits" verdict; cleared by a later `claws_save_plan`. */
  keepPlan: { reason: string } | null;
  /** Tool calls this run refused (validation failures); the "no such run" path has no run to count on. */
  rejectedCalls: number;
  lastRejection: string | null;
}

export type SubmitResult = { ok: true } | { ok: false; error: string };

/** Distinguishes "no such run" (404) from a validation failure (400). */
export const NO_SUCH_PLANNER_RUN = "no such planner run";

const runs = new Map<string, PlannerRun>();

/**
 * Open a planner run for the length of `fn`. The run is always deleted when
 * `fn` settles, so a late tool call from a lingering MCP child gets a 404.
 */
export async function withPlannerRun<T>(input: PlannerRunInput, fn: (runId: string) => Promise<T>): Promise<T> {
  const id = crypto.randomUUID();
  runs.set(id, {
    repo: input.repo,
    issueRef: input.issueRef,
    stage: input.stage,
    allowedRepos: [...input.allowedRepos],
    addableRepos: [...(input.addableRepos ?? [])],
    allowedDuplicates: [...(input.allowedDuplicates ?? [])],
    allowOutcomes: input.allowOutcomes ?? true,
    plannedPrs: (input.plannedPrs ?? []).map((p) => ({ repo: p.repo, kind: p.kind })),
    shippedEntries: (input.shippedEntries ?? []).map((e) => ({ position: e.position, repo: e.repo, kind: e.kind })),
    openPrs: (input.openPrs ?? []).map((p) => ({ repo: p.repo, number: p.number })),
    linkedPrs: (input.linkedPrs ?? []).map((p) => ({ repo: p.repo, number: p.number })),
    submission: null,
    followupVerdict: null,
    keepPlan: null,
    rejectedCalls: 0,
    lastRejection: null,
  });
  try {
    return await fn(id);
  } finally {
    runs.delete(id);
  }
}

export function hasPlannerRun(runId: string): boolean {
  return runs.has(runId);
}

export function getSubmission(runId: string): PlannerSubmission | null {
  return runs.get(runId)?.submission ?? null;
}

/** The follow-up verdict `runId` recorded, or null when it never called `claws_followup_verdict`. */
export function getFollowupVerdict(runId: string): FollowupVerdict | null {
  return runs.get(runId)?.followupVerdict ?? null;
}

/** The keep verdict `runId` recorded, or null when it never called `claws_keep_plan` (or saved a plan after). */
export function getKeepPlan(runId: string): { reason: string } | null {
  return runs.get(runId)?.keepPlan ?? null;
}

/** How many tool calls `runId` rejected and the last error text; zero/null for an unknown run. */
export function getRunRejections(runId: string): { count: number; last: string | null } {
  const run = runs.get(runId);
  return { count: run?.rejectedCalls ?? 0, last: run?.lastRejection ?? null };
}

/** Record a refused call on its run, then pass the result through. */
function counted(runId: string, result: SubmitResult): SubmitResult {
  if (!result.ok) {
    const run = runs.get(runId);
    if (run) {
      run.rejectedCalls += 1;
      run.lastRejection = result.error;
    }
  }
  return result;
}

/**
 * The HTTP handler behind `POST …/planner-runs/:id/<route>`, shared by the
 * service (`server.ts`) and the agent pod's loopback listener: 404 with
 * {@link NO_SUCH_PLANNER_RUN} for an unknown run, 400 for a body that is not
 * JSON or that `submit` refuses, else `{ ok: true }`.
 */
export function plannerRunHandler(submit: (runId: string, input: unknown) => SubmitResult): (c: Context) => Promise<Response> {
  return async (c) => {
    const runId = c.req.param("id") ?? "";
    if (!hasPlannerRun(runId)) return c.json({ error: NO_SUCH_PLANNER_RUN }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const result = submit(runId, body);
    if (!result.ok) return c.json({ error: result.error }, result.error === NO_SUCH_PLANNER_RUN ? 404 : 400);
    return c.json({ ok: true });
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A positive issue number from `458` or `"#458"`, or a native id; else null. */
function coerceIssueRef(value: unknown): IssueRef | null {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const ref = parseIssueRef(value);
  return typeof ref === "number" && ref <= 0 ? null : ref;
}

/** Longest allowed body of a plan's opening "What changes" section. */
const MAX_WHAT_CHANGES_CHARS = 800;

/**
 * Insert the manual step at stored position `m` (the first flagged PR's) and
 * rewrite every PR entry's `depends_on` from PR numbers to stored positions:
 * `d` becomes `d < m ? d : d + 1`, null becomes the previous position, and each
 * flagged PR also waits on `m`.
 */
function insertManualStep(
  prs: PlannedPR[],
  afterManual: readonly boolean[],
  m: number,
  manualEntry: (dependsOn: number[]) => PlannedPR,
): void {
  const toPosition = (d: number) => (d < m ? d : d + 1);
  const remapped = prs.map((pr, i) => {
    const position = toPosition(i + 1);
    const deps = pr.dependsOn === null ? (position > 1 ? [position - 1] : []) : pr.dependsOn.map(toPosition);
    if (afterManual[i]) deps.push(m);
    return { ...pr, dependsOn: [...new Set(deps)].sort((a, b) => a - b) };
  });
  prs.splice(0, prs.length, ...remapped.slice(0, m - 1), manualEntry(m > 1 ? [m - 1] : []), ...remapped.slice(m - 1));
}

/** Validate a plan payload against `run`; returns the canonical submission or an error. */
function validatePlan(run: PlannerRun, input: unknown, stage: PlannerStage): PlanSubmission | string {
  if (!isRecord(input)) return "the plan must be an object";
  const plan = typeof input["plan"] === "string" ? stripLeadingPlanHeader(input["plan"]) : "";
  if (!plan) return "`plan` is empty — pass the complete plan text";

  const rawPrs = input["prs"];
  if (!Array.isArray(rawPrs) || rawPrs.length === 0) {
    return "`prs` must list at least one PR: one {repo, title} entry per `### PR N:` section, in order (a single-PR plan has one entry)";
  }
  // Only `### PR N:` entries are passed; the manual step is derived below.
  if (rawPrs.length > MAX_PLANNED_PRS) return `\`prs\` has ${rawPrs.length} entries — at most ${MAX_PLANNED_PRS} are allowed`;
  const prs: PlannedPR[] = [];
  // Per PR entry: whether it sets `after_manual_actions`.
  const afterManual: boolean[] = [];
  for (const [i, entry] of rawPrs.entries()) {
    const n = i + 1;
    if (!isRecord(entry)) return `prs[${n}] must be an object with \`repo\` and \`title\``;
    const repo = typeof entry["repo"] === "string" ? entry["repo"].trim() : "";
    const title = typeof entry["title"] === "string" ? entry["title"].trim().slice(0, MAX_PLANNED_PR_TITLE_CHARS).trim() : "";
    if (!repo) return `prs[${n}].repo is empty`;
    if (!title) return `prs[${n}].title is empty`;
    // Case-insensitive match returning the CANONICAL spelling — never trust the model's casing.
    const canonical = [...run.allowedRepos, ...run.addableRepos].find((r) => r.toLowerCase() === repo.toLowerCase());
    if (!canonical) {
      const addable = run.addableRepos.length > 0 ? `, nor a managed repository Claws can add to it: ${run.addableRepos.join(", ")}` : "";
      return `prs[${n}].repo "${repo}" is not one of this issue's repositories: ${run.allowedRepos.join(", ") || "(none)"}${addable}`;
    }
    let dependsOn: number[] | null = null;
    const rawDeps = entry["depends_on"];
    if (rawDeps !== undefined && rawDeps !== null) {
      // Only earlier positions: that keeps the dependency graph acyclic.
      const range = n === 1 ? "must be [] for the first PR" : `may only name positions 1..${n - 1}`;
      if (!Array.isArray(rawDeps) || !rawDeps.every((d) => Number.isInteger(d) && d >= 1 && d < n)) {
        return `prs[${n}].depends_on must be an array of earlier positions — it ${range}`;
      }
      dependsOn = [...new Set(rawDeps as number[])].sort((a, b) => a - b);
    }
    let manualAction: string | null = null;
    const rawManual = entry["manual_action_before_merge"];
    if (rawManual !== undefined && rawManual !== null) {
      if (typeof rawManual !== "string") return `prs[${n}].manual_action_before_merge must be a string`;
      manualAction = rawManual.trim() || null;
      const verifyOnlyPr = manualAction === null ? [] : verificationOnlyManualSteps(manualAction);
      if (verifyOnlyPr.length > 0) return `prs[${n}].manual_action_before_merge: ${verificationOnlyStepError(verifyOnlyPr[0])}`;
      if (manualAction !== null && manualAction.length > MAX_MANUAL_ACTION_CHARS) {
        return `prs[${n}].manual_action_before_merge is ${manualAction.length} characters — keep it to ${MAX_MANUAL_ACTION_CHARS}: name the operator step, the plan holds the detail`;
      }
    }
    const rawAfter = entry["after_manual_actions"];
    if (rawAfter !== undefined && rawAfter !== null && typeof rawAfter !== "boolean") {
      return `prs[${n}].after_manual_actions must be true or false`;
    }
    let infraChanges: InfraDeclaration | null = null;
    const rawInfra = entry["infra_changes"];
    if (rawInfra !== undefined && rawInfra !== null) {
      const declared = validateInfraDeclaration(rawInfra);
      if (typeof declared === "string") return `prs[${n}].infra_changes ${declared}`;
      infraChanges = declared;
    }
    afterManual.push(rawAfter === true);
    prs.push({ repo: canonical, title, dependsOn, kind: "pr", manualAction, ...(infraChanges ? { infraChanges } : {}) });
  }
  // The stored list decides the phase count, so a list that disagrees with the
  // plan text would silently drop (or invent) steps — reject it while the agent
  // can still fix it. A plan with no `### PR N:` headers counts as one section.
  const parsedPlan = parsePlan(plan);
  const sections = parsedPlan.totalPhases;
  if (prs.length !== sections) {
    return `\`prs\` has ${prs.length} entr${prs.length === 1 ? "y" : "ies"} but the plan has ${sections} \`### PR N:\` section${sections === 1 ? "" : "s"} — list one entry per section, in order`;
  }
  // A `### PR N: … (after manual)` header waits for the operator step exactly
  // as `after_manual_actions: true` does; the flag is derived from it when absent.
  const headerAfterManual = parsedPlan.phases.map((p) => p.afterManual === true);
  for (const [i, flagged] of headerAfterManual.entries()) if (flagged) afterManual[i] = true;
  const flagSource = (i: number) => (headerAfterManual[i] ? `PR ${i + 1}'s header says (after manual)` : `prs[${i + 1}].after_manual_actions is set`);

  if (stage !== "followup") {
    const opening = parsePlanSections(plan)[0];
    if (!opening || !isWhatChangesTitle(opening.title) || !opening.markdown) {
      return 'the plan must start with a "### What changes" section: 2–5 plain sentences saying what will be done on approval, what will behave differently and which repository each PR lands in — before Decisions, root causes or rationale';
    }
    if (opening.markdown.length > MAX_WHAT_CHANGES_CHARS) {
      return `"### What changes" is ${opening.markdown.length} characters — keep it to ${MAX_WHAT_CHANGES_CHARS}; put detail under Implementation`;
    }
    if (opening.markdown.includes("`")) {
      return '"### What changes" must be plain language — remove backticks and code spans, and describe the outcome without file or function names';
    }
    const lowered = opening.markdown.toLowerCase();
    for (const repo of new Set(prs.filter((p) => p.kind === "pr").map((p) => p.repo))) {
      const bare = repo.slice(repo.lastIndexOf("/") + 1).toLowerCase();
      if (!lowered.includes(repo.toLowerCase()) && !lowered.includes(bare)) {
        return `"### What changes" does not name repository ${repo} — say which repository each PR lands in`;
      }
    }
  }

  const impl = typeof input["implementation_model"] === "string" ? input["implementation_model"].trim().toLowerCase() : "";
  if (!(IMPLEMENTATION_MODELS as readonly string[]).includes(impl)) {
    return `\`implementation_model\` must be one of ${IMPLEMENTATION_MODELS.join(", ")}`;
  }
  const review = typeof input["review_model"] === "string" ? input["review_model"].trim().toLowerCase() : "";
  if (!(REVIEW_MODELS as readonly string[]).includes(review)) {
    return `\`review_model\` must be one of ${REVIEW_MODELS.join(", ")}`;
  }

  let targetPr: number | null = null;
  const rawTarget = input["target_pr"];
  if (rawTarget !== undefined && rawTarget !== null) {
    const n = typeof rawTarget === "string" ? Number(rawTarget.trim().replace(/^#/, "")) : rawTarget;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return "`target_pr` must be a positive PR number";
    if (prs.length !== 1) return `\`target_pr\` is only allowed on a single-PR plan — this plan lists ${prs.length} PRs`;
    targetPr = n;
  }

  // A plan's manual-actions section is tracked as a step with no PR, so the
  // issue stays open until the operator claims it done. It lands after every
  // PR — or right after PR k when its heading ends `(after PR k)`, or just
  // before the first PR flagged `after_manual_actions` or `(after manual)`;
  // the PR after it then waits for it — and lives in the run's primary repo
  // (`run.repo`).
  const manual = findManualActionsSection(plan);
  const firstFlagged = afterManual.indexOf(true);
  // A shipped operator step is pinned at its recorded position whatever the planner flags.
  const shippedManual = run.shippedEntries.find((e) => e.kind === "manual");
  if (shippedManual && !manual) {
    return `step ${shippedManual.position} (the operator step) is already done and stays at position ${shippedManual.position}, but this plan has no \`### Manual actions (operator)\` section — keep the section, say it is done, and do not list it in \`prs\``;
  }
  if (shippedManual && shippedManual.position > prs.length + 1) {
    return `step ${shippedManual.position} (the operator step) is already done and stays at position ${shippedManual.position}, but this plan lists only ${prs.length} PRs — keep the ${shippedManual.position - 1} PR entries recorded before it`;
  }
  if (!shippedManual && firstFlagged >= 0 && !manual) {
    return `${flagSource(firstFlagged)} but the plan has no \`### Manual actions (operator)\` section — add the section or drop the flag`;
  }
  if (manual) {
    const verifyOnly = verificationOnlyManualSteps(manual.body);
    if (verifyOnly.length > 0) return verificationOnlyStepError(verifyOnly[0]);
    const title = manual.heading.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_PLANNED_PR_TITLE_CHARS).trim();
    const manualEntry = (dependsOn: number[]): PlannedPR => ({
      repo: run.allowedRepos.find((r) => r.toLowerCase() === run.repo.toLowerCase()) ?? run.repo,
      title: title || "Manual actions",
      dependsOn,
      kind: "manual",
      manualAction: null,
    });
    if (shippedManual) {
      const m = shippedManual.position;
      const flags = prs.map((_, i) => i === m - 1);
      insertManualStep(prs, flags, m, manualEntry);
    } else if (manual.afterPr !== null) {
      const k = manual.afterPr;
      if (k < 1 || k > prs.length) {
        return `the \`${manual.heading} (after PR ${k})\` heading names PR ${k}, but the plan has PRs 1..${prs.length}`;
      }
      if (firstFlagged >= 0 && firstFlagged !== k) {
        return `the \`${manual.heading} (after PR ${k})\` heading puts the operator step after PR ${k}, but ${flagSource(firstFlagged)}, which puts it before PR ${firstFlagged + 1} — make the heading and the flag agree`;
      }
      if (k === prs.length) {
        prs.push(manualEntry(prs.map((_, i) => i + 1)));
      } else {
        const flags = afterManual.map((f, i) => f || i === k);
        insertManualStep(prs, flags, k + 1, manualEntry);
      }
    } else if (firstFlagged < 0) {
      prs.push(manualEntry(prs.map((_, i) => i + 1)));
    } else {
      insertManualStep(prs, afterManual, firstFlagged + 1, manualEntry);
    }
  }

  // Moving the manual step shifts every entry after it, which would unlink the
  // shipped ones (their PR link is keyed by position, repo and kind).
  for (const shipped of run.shippedEntries) {
    const at = prs[shipped.position - 1];
    if (!at || at.kind !== shipped.kind || (shipped.kind === "pr" && at.repo.toLowerCase() !== shipped.repo.toLowerCase())) {
      const found = !at ? "nothing" : at.kind === "manual" ? "the operator step" : `a PR in ${at.repo}`;
      return shipped.kind === "manual"
        ? `step ${shipped.position} (the operator step) has already shipped at position ${shipped.position}, but this plan has ${found} there — keep the \`### Manual actions (operator)\` section where the recorded list has it`
        : `step ${shipped.position} (${shipped.repo}) has already shipped at position ${shipped.position}, but this plan has ${found} there — keep every shipped \`### PR N:\` header and its \`prs\` entry at its position, in its repo`;
    }
  }

  // A plan-level hold on PR N that names a later step depending on N can
  // never clear: that step only starts once N merges.
  const dependencies = effectiveDependencies(prs.length, prs.map((p) => p.dependsOn));
  for (const [i, pr] of prs.entries()) {
    if (pr.kind !== "pr" || !pr.manualAction) continue;
    const hit = circularManualAction(pr.manualAction, i + 1, prs, dependencies);
    if (!hit) continue;
    const prNumber = prs.slice(0, i + 1).filter((p) => p.kind === "pr").length;
    return `prs[${prNumber}].manual_action_before_merge names ${hit.repo === pr.repo ? `"${hit.matched}"` : hit.repo}, which PR ${hit.prNumber} (step ${hit.dependentPhase}) delivers and which depends on PR ${prNumber} — reorder the steps or drop the hold`;
  }

  const response = optionalString(input["response"]);
  if (response !== null && stage !== "refine") {
    return "`response` is only accepted when refining a plan after feedback — omit it";
  }

  return {
    kind: "plan",
    plan,
    prs,
    implementationModel: impl as ImplementationModel,
    reviewModel: review as ReviewModel,
    targetPr,
    response,
  };
}

export function submitPlan(runId: string, input: unknown): SubmitResult {
  return counted(runId, submitPlanImpl(runId, input));
}

function submitPlanImpl(runId: string, input: unknown): SubmitResult {
  const run = runs.get(runId);
  if (!run) return { ok: false, error: NO_SUCH_PLANNER_RUN };
  if (run.stage === "step_back") return { ok: false, error: "this is a step-back pass — report through claws_step_back_verdict instead" };
  if (run.submission?.kind === "outcome") {
    return { ok: false, error: "an outcome was already reported in this run — a run reports either a plan or an outcome, not both" };
  }
  const result = validatePlan(run, input, run.stage);
  if (typeof result === "string") return { ok: false, error: result };
  // A plan replacing the one an amendment verdict was checked against must
  // pass the same PR-set check, or the verdict would vouch for a plan it never saw.
  if (run.followupVerdict?.verdict === "plan_amendment" && !keepsPlannedPrSet(run, result)) {
    return { ok: false, error: PR_SET_CHANGED_ERROR };
  }
  // Likewise a design change's fates were checked against the plan it saw.
  if (run.followupVerdict?.verdict === "design_change") {
    const fateError = checkFatePositions(result, run.followupVerdict.prFates ?? []);
    if (fateError) return { ok: false, error: `${fateError} — call claws_followup_verdict again with fates that match this plan` };
  }
  run.submission = result;
  run.keepPlan = null;
  return { ok: true };
}

export function submitKeepPlan(runId: string, input: unknown): SubmitResult {
  return counted(runId, submitKeepPlanImpl(runId, input));
}

function submitKeepPlanImpl(runId: string, input: unknown): SubmitResult {
  const run = runs.get(runId);
  if (!run) return { ok: false, error: NO_SUCH_PLANNER_RUN };
  if (run.stage !== "verify") return { ok: false, error: "claws_keep_plan is only available when verifying a plan after a Backlog return" };
  if (!isRecord(input)) return { ok: false, error: "the verdict must be an object" };
  const reason = optionalString(input["reason"]);
  if (!reason) return { ok: false, error: "`reason` is required — one or two sentences on why the plan still fits" };
  if (reason.length > MAX_KEEP_PLAN_REASON_CHARS) return { ok: false, error: `\`reason\` is ${reason.length} characters — keep it to ${MAX_KEEP_PLAN_REASON_CHARS}` };
  run.keepPlan = { reason };
  // The later of keep and save wins.
  run.submission = null;
  return { ok: true };
}

/** True when `plan`'s PR list matches the run's stored list: same count and kind at each position, and the same repo for PR entries. */
function keepsPlannedPrSet(run: PlannerRun, plan: PlanSubmission): boolean {
  if (plan.prs.length !== run.plannedPrs.length) return false;
  return plan.prs.every((p, i) => {
    const stored = run.plannedPrs[i];
    // A manual step's repo is not significant: older plans stored it under the alphabetical repo.
    return p.kind === stored.kind && (p.kind !== "pr" || p.repo.toLowerCase() === stored.repo.toLowerCase());
  });
}

export function submitFollowupVerdict(runId: string, input: unknown): SubmitResult {
  return counted(runId, submitFollowupVerdictImpl(runId, input));
}

function submitFollowupVerdictImpl(runId: string, input: unknown): SubmitResult {
  const run = runs.get(runId);
  if (!run) return { ok: false, error: NO_SUCH_PLANNER_RUN };
  if (run.stage !== "followup") return { ok: false, error: "claws_followup_verdict is only available when answering follow-up comments" };
  if (!isRecord(input)) return { ok: false, error: "the verdict must be an object" };
  const verdict = typeof input["verdict"] === "string" ? input["verdict"].trim().toLowerCase() : "";
  if (verdict !== "answered" && verdict !== "plan_amendment" && verdict !== "design_change") {
    return { ok: false, error: "`verdict` must be \"answered\", \"plan_amendment\" or \"design_change\"" };
  }
  if (verdict === "answered") {
    run.followupVerdict = { verdict, affectedPrs: [] };
    return { ok: true };
  }
  if (verdict === "design_change") return submitDesignChange(run, input);

  const rawAffected = input["affected_prs"] ?? [];
  if (!Array.isArray(rawAffected)) return { ok: false, error: "`affected_prs` must be an array of {repo, number}" };
  const affectedPrs: PRRef[] = [];
  for (const [i, entry] of rawAffected.entries()) {
    const n = i + 1;
    if (!isRecord(entry)) return { ok: false, error: `affected_prs[${n}] must be an object with \`repo\` and \`number\`` };
    const repo = typeof entry["repo"] === "string" ? entry["repo"].trim() : "";
    const raw = entry["number"];
    const open = findPRRef(run.openPrs, repo, raw);
    if (!open) {
      const offered = run.openPrs.map((p) => `${p.repo}#${p.number}`).join(", ") || "(none)";
      return { ok: false, error: `affected_prs[${n}] (${repo || "?"}#${String(raw)}) is not one of this issue's open step PRs: ${offered}` };
    }
    if (!affectedPrs.some((p) => p.repo === open.repo && p.number === open.number)) affectedPrs.push({ ...open });
  }

  const plan = run.submission;
  if (plan?.kind !== "plan") {
    return { ok: false, error: "a plan amendment needs the complete amended plan — call claws_save_plan first, then this tool" };
  }
  if (run.plannedPrs.length === 0) {
    return { ok: false, error: "this issue has no stored PR list to amend against — report verdict \"design_change\" instead, with the revised requirements and a fate for every open PR" };
  }
  if (!keepsPlannedPrSet(run, plan)) return { ok: false, error: PR_SET_CHANGED_ERROR };
  run.followupVerdict = { verdict, affectedPrs };
  return { ok: true };
}

/**
 * Case-insensitive match of `repo`/`raw` (a number, or `"#9"`) against `refs`,
 * returning the CANONICAL spelling — never trust the model's casing.
 */
function findPRRef(refs: readonly PRRef[], repo: string, raw: unknown): PRRef | undefined {
  const number = typeof raw === "string" ? Number(raw.trim().replace(/^#/, "")) : raw;
  return refs.find((p) => p.repo.toLowerCase() === repo.toLowerCase() && p.number === number);
}

/**
 * The `design_change` half of {@link submitFollowupVerdict}: the revised
 * requirements must be a valid record, a revised plan must already be saved
 * (its PR set may change), every open step PR needs exactly one fate, and
 * every merged step PR is kept at a step or retired.
 */
function submitDesignChange(run: PlannerRun, input: Record<string, unknown>): SubmitResult {
  const requirements = RequirementsRecordSchema.safeParse(input["requirements"]);
  if (!requirements.success) {
    return { ok: false, error: `\`requirements\` must be the complete revised requirements record: ${requirements.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` };
  }
  const rawFates = input["pr_fates"] ?? [];
  if (!Array.isArray(rawFates)) return { ok: false, error: "`pr_fates` must be an array of {repo, number, fate, position}" };
  const fates: PRFate[] = [];
  for (const [i, entry] of rawFates.entries()) {
    const n = i + 1;
    if (!isRecord(entry)) return { ok: false, error: `pr_fates[${n}] must be an object with \`repo\`, \`number\` and \`fate\`` };
    const repo = typeof entry["repo"] === "string" ? entry["repo"].trim() : "";
    const raw = entry["number"];
    const open = findPRRef(run.openPrs, repo, raw);
    const linked = open ? undefined : findPRRef(run.linkedPrs, repo, raw);
    const pr = open ?? linked;
    if (!pr) {
      const offered = [...run.openPrs, ...run.linkedPrs].map((p) => `${p.repo}#${p.number}`).join(", ") || "(none)";
      return { ok: false, error: `pr_fates[${n}] (${repo || "?"}#${String(raw)}) is not one of this issue's step PRs: ${offered}` };
    }
    if (fates.some((f) => f.repo === pr.repo && f.number === pr.number)) {
      return { ok: false, error: `pr_fates names ${pr.repo}#${pr.number} more than once — give each PR exactly one fate` };
    }
    const fate = typeof entry["fate"] === "string" ? entry["fate"].trim().toLowerCase() : "";
    if (fate !== "close" && fate !== "rework" && fate !== "keep" && fate !== "retire") {
      return { ok: false, error: `pr_fates[${n}].fate must be "close", "rework", "keep" or "retire"` };
    }
    if (linked && fate !== "keep" && fate !== "retire") {
      return { ok: false, error: `pr_fates[${n}]: ${pr.repo}#${pr.number} is no longer open — only an open PR can be closed or reworked; keep a merged PR at its step or retire it` };
    }
    if (open && fate === "retire") {
      return { ok: false, error: `pr_fates[${n}]: ${pr.repo}#${pr.number} is still open — only a merged PR can be retired; close, rework or keep an open PR` };
    }
    const rawPosition = entry["position"];
    let position: number | null = null;
    if (fate !== "close" && fate !== "retire") {
      if (typeof rawPosition !== "number" || !Number.isInteger(rawPosition) || rawPosition < 1) {
        return { ok: false, error: `pr_fates[${n}]: a "${fate}" fate needs \`position\`, the revised plan's step (1-based) the PR covers` };
      }
      position = rawPosition;
    }
    fates.push({ repo: pr.repo, number: pr.number, fate, position });
  }
  const missing = run.openPrs.filter((p) => !fates.some((f) => f.repo === p.repo && f.number === p.number));
  if (missing.length > 0) {
    return { ok: false, error: `every open step PR needs exactly one fate — missing: ${missing.map((p) => `${p.repo}#${p.number}`).join(", ")}` };
  }
  const missingMerged = run.linkedPrs.filter((p) => !fates.some((f) => f.repo === p.repo && f.number === p.number));
  if (missingMerged.length > 0) {
    return { ok: false, error: `every merged step PR needs a fate — keep it at its step or retire it — missing: ${missingMerged.map((p) => `${p.repo}#${p.number}`).join(", ")}` };
  }

  const plan = run.submission;
  if (plan?.kind !== "plan") {
    return { ok: false, error: "a design change needs the complete revised plan — call claws_save_plan first, then this tool" };
  }
  const fateError = checkFatePositions(plan, fates);
  if (fateError) return { ok: false, error: fateError };
  run.followupVerdict = { verdict: "design_change", affectedPrs: [], requirements: requirements.data, prFates: fates };
  return { ok: true };
}

/**
 * Null when every `rework`/`keep` fate names a `### PR N:` step of `plan` in
 * the PR's own repo, at most one PR per step; else the error to return.
 */
function checkFatePositions(plan: PlanSubmission, fates: readonly PRFate[]): string | null {
  const taken = new Map<number, PRFate>();
  for (const f of fates) {
    if (f.position === null) continue;
    const entry = plan.prs[f.position - 1];
    if (!entry || entry.kind !== "pr") {
      return `${f.repo}#${f.number}: position ${f.position} is not a PR step of the revised plan, which has ${plan.prs.filter((p) => p.kind === "pr").length}`;
    }
    if (entry.repo.toLowerCase() !== f.repo.toLowerCase()) {
      return `${f.repo}#${f.number}: step ${f.position} of the revised plan is in ${entry.repo} — a PR can only cover a step in its own repository`;
    }
    const other = taken.get(f.position);
    if (other) return `${other.repo}#${other.number} and ${f.repo}#${f.number} both cover step ${f.position} — give each step at most one PR`;
    taken.set(f.position, f);
  }
  return null;
}

export function submitOutcome(runId: string, input: unknown): SubmitResult {
  return counted(runId, submitOutcomeImpl(runId, input));
}

function submitOutcomeImpl(runId: string, input: unknown): SubmitResult {
  const run = runs.get(runId);
  if (!run) return { ok: false, error: NO_SUCH_PLANNER_RUN };
  if (run.stage === "step_back") return { ok: false, error: "this is a step-back pass — report through claws_step_back_verdict instead" };
  if (!run.allowOutcomes) return { ok: false, error: "this pass cannot report an outcome — save the plan with claws_save_plan" };
  if (run.submission?.kind === "plan") {
    return { ok: false, error: "a plan was already saved in this run — a run reports either a plan or an outcome, not both" };
  }
  if (!isRecord(input)) return { ok: false, error: "the outcome must be an object" };
  const explanation = optionalString(input["explanation"]);
  if (!explanation) return { ok: false, error: "`explanation` is required — 2-4 sentences saying why" };

  const kind = typeof input["outcome"] === "string" ? input["outcome"].trim().toLowerCase() : "";
  let outcome: PlannerOutcome;
  switch (kind) {
    case "duplicate": {
      if (run.allowedDuplicates.length === 0) return { ok: false, error: "no duplicate candidates were offered in this run — the duplicate outcome is not available" };
      const n = coerceIssueRef(input["duplicate_of"]);
      if (n === null || !run.allowedDuplicates.some((c) => sameIssueRef(c, n))) {
        return { ok: false, error: `duplicate_of ${JSON.stringify(input["duplicate_of"])} is not one of the candidates offered: ${run.allowedDuplicates.map((c) => `#${c}`).join(", ")}` };
      }
      outcome = { kind: "duplicate", duplicateOf: n };
      break;
    }
    case "blocked":
      outcome = { kind: "blocked" };
      break;
    case "no_code_changes": {
      const rawKind = typeof input["no_change_kind"] === "string" ? input["no_change_kind"].trim().toLowerCase() : "";
      const noChangeKind = NO_CHANGE_KINDS.find((k) => k === rawKind);
      if (!noChangeKind) {
        return { ok: false, error: `no_change_kind is required for no_code_changes — one of: ${NO_CHANGE_KINDS.join(", ")}` };
      }
      outcome = { kind: "no_code_changes", noChangeKind };
      break;
    }
    default:
      return { ok: false, error: `unknown outcome ${JSON.stringify(input["outcome"])} — use one of: ${[...(run.allowedDuplicates.length ? ["duplicate"] : []), "blocked", "no_code_changes"].join(", ")}` };
  }
  run.submission = { kind: "outcome", outcome, explanation };
  return { ok: true };
}

export function submitStepBack(runId: string, input: unknown): SubmitResult {
  return counted(runId, submitStepBackImpl(runId, input));
}

function submitStepBackImpl(runId: string, input: unknown): SubmitResult {
  const run = runs.get(runId);
  if (!run) return { ok: false, error: NO_SUCH_PLANNER_RUN };
  if (run.stage !== "step_back") return { ok: false, error: "claws_step_back_verdict is only available in a step-back pass" };
  if (!isRecord(input)) return { ok: false, error: "the verdict must be an object" };
  const verdict = typeof input["verdict"] === "string" ? input["verdict"].trim().toLowerCase() : "";
  if (verdict !== "sound" && verdict !== "reconsider") return { ok: false, error: "`verdict` must be \"sound\" or \"reconsider\"" };
  const critique = optionalString(input["critique"]);
  let revised: PlanSubmission | null = null;
  if (input["revised"] !== undefined && input["revised"] !== null) {
    if (verdict === "sound") return { ok: false, error: "a `revised` plan is only accepted with verdict \"reconsider\"" };
    const result = validatePlan(run, input["revised"], "step_back");
    if (typeof result === "string") return { ok: false, error: `revised: ${result}` };
    revised = result;
  }
  run.submission = { kind: "step_back", verdict, critique, revised };
  return { ok: true };
}
