import type { Repo } from "../config.js";
import { isJobDisabledForRepo, getProdAlertWorkflows, getMainBuildIgnoreWorkflows, forgejoRepoUrl } from "../config.js";
import * as db from "../db.js";
import * as gh from "../github.js";
import * as forgejo from "../forgejo.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { ensureAlertIssue, resolveAlertIssue, upsertAlertIssue, closeAlertIssueIfResolved } from "../occurrence-tracking.js";
import { notifyProdAlert } from "../slack.js";
import { CI_UNRELATED_TITLE, isPoolSaturated, isActionsPermissionDenied, reportActionsPermissionDenied } from "../agents/ci-fixer.js";
import { mapWithConcurrency } from "../util.js";
import { resolveTrackerId } from "../planned-prs.js";
import { stripAnsi } from "../log-excerpt.js";

export const NAME = "main-build-monitor";

/** A service restart must not resurrect day-old runs and re-run them. */
const MAX_RUN_AGE_MS = 4 * 60 * 60 * 1000;
const MAX_RERUNS_PER_PASS = 5;
const MAX_LOG_FETCHES_PER_PASS = 5;
const LOG_TAIL_CHARS = 60_000;
const REPO_CONCURRENCY = 4;

/**
 * Errors that mean the build never got a verdict on the repo's own code — a network
 * blip, a registry hiccup, a runner going away. Never widen this list to bare
 * `/error/` or `/exit code 1/`: a false positive spends a real CI run and, worse,
 * hides a genuine red main behind an automatic retry.
 */
/**
 * A job killed by `timeout-minutes` logs "The operation was canceled." — which matches the
 * transient list — but re-running it just repeats the hang and holds the runner pool for
 * another full timeout window (#2861). A timeout is a real failure: report it, never retry.
 */
const JOB_TIMEOUT_RE = /has exceeded the maximum execution time of/i;

export const TRANSIENT_LOG_PATTERNS: RegExp[] = [
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bEAI_AGAIN\b/,
  /\bENETUNREACH\b/,
  /\bEHOSTUNREACH\b/,
  /npm (?:error|ERR!) network/i,
  /Temporary failure in name resolution/i,
  /Could not resolve host/i,
  /connection reset by peer/i,
  /The remote end hung up unexpectedly/i,
  /TLS handshake timeout/i,
  /net\/http: request canceled/i,
  /\bi\/o timeout\b/i,
  /context deadline exceeded/i,
  /\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out)\b/i,
  /\b429 Too Many Requests\b/,
  /(?:secondary )?rate limit exceeded/i,
  /Service Temporarily Unavailable/i,
  /error pulling image configuration/i,
  /\btoomanyrequests\b/i,
  /unexpected status from (?:HEAD|GET) request/i,
  /The runner has received a shutdown signal/i,
  /lost communication with the server/i,
  /Received request to deprovision/i,
  /The operation was canceled/i,
  // The forge itself answering a git checkout with a 502 (bonkus run 352). Git-specific on
  // purpose: a bare "The requested URL returned error: 502" is also what a step's
  // `curl -f` smoke test prints when the app it deployed is down — a genuine failure.
  // The trailing `fatal: expected 'packfile'` is not matched on its own: it can follow
  // other git errors, and in this shape it always comes after the `RPC failed` line.
  /fatal: unable to access '[^']*': The requested URL returned error: 502\b/,
  /error: RPC failed; HTTP 502\b/,
];

export function isTransientLog(text: string): boolean {
  if (JOB_TIMEOUT_RE.test(text)) return false;
  return text.length > 0 && TRANSIENT_LOG_PATTERNS.some((re) => re.test(text));
}

/**
 * Whether a failed default-branch run may be re-run at all, before any classification.
 *
 * The tip-SHA equality is load-bearing: re-running a superseded run republishes a stale
 * artefact (namey's failing workflow pushes `latest` to GHCR). Never relax it, and never
 * fall back to retrying when the tip is unknown.
 */
export function isRetryCandidate(run: db.MainBuildRunRow, tipSha: string, nowMs: number): boolean {
  if ((run.run_attempt ?? 1) > 1) return false;
  if (run.head_sha === null || run.head_sha !== tipSha) return false;
  return nowMs - Date.parse(run.created_at) <= MAX_RUN_AGE_MS;
}

// Per-pass budgets: a burst of failures must not turn into a burst of CI runs.
let rerunsThisPass = 0;
let logFetchesThisPass = 0;

/**
 * Take a re-run slot, or return false when the pass has spent its budget.
 *
 * Repos are processed four at a time, so a check-then-increment split by an `await`
 * would let four concurrent repos each pass the check before any of them increments
 * and blow through the budget. The slot is claimed synchronously and handed back via
 * `releaseRerunSlot` whenever the re-run does not actually happen.
 */
function reserveRerunSlot(): boolean {
  if (rerunsThisPass >= MAX_RERUNS_PER_PASS) return false;
  rerunsThisPass++;
  return true;
}

function releaseRerunSlot(): void {
  rerunsThisPass--;
}

function runUrlFor(repo: Repo, run: db.MainBuildRunRow): string {
  if (run.html_url) return run.html_url;
  if (repo.forge === "forgejo") return `${forgejoRepoUrl(repo.fullName)}/actions/runs/${run.run_id}`;
  return `https://github.com/${repo.fullName}/actions/runs/${run.run_id}`;
}

/** Forgejo run ids are small per-instance integers; namespace them so they can never
 *  collide with a GitHub run id in the shared main_build_failures primary key. */
export function runKey(repo: Repo, runId: number): string {
  return repo.forge === "forgejo" ? `${FORGEJO_KEY_PREFIX}${runId}` : String(runId);
}

const FORGEJO_KEY_PREFIX = "forgejo:";

/**
 * What Claws did about the failure, as the issue body must describe it. `rerun-errored`
 * exists so a re-run whose API call itself blew up is not reported as "did not match the
 * transient-error heuristic" — it did match, the retry just never started.
 */
type RetryState = "not-attempted" | "rerun-errored" | "failed-again" | "retry-timed-out";

const RETRY_STATE_TEXT: Record<RetryState, string> = {
  "not-attempted": `Claws did not retry this run — the failure did not match its transient-error heuristic.`,
  "rerun-errored": `Claws classified this failure as transient and asked the forge to re-run the failed jobs, but the re-run request itself errored — no retry ran.`,
  "failed-again": `Claws re-ran the failed jobs once (the failure matched its transient-error heuristic) and the retry failed too.`,
  "retry-timed-out": `Claws re-ran the failed jobs once (the failure matched its transient-error heuristic), but the retry never reached a conclusion within 24h — treating it as failed.`,
};

async function reportFailure(
  repo: Repo,
  workflowName: string,
  runId: string,
  runUrl: string,
  event: string,
  retryState: RetryState,
): Promise<void> {
  const title = `Build failure: ${workflowName}`;
  await ensureAlertIssue({
    repo: repo.fullName,
    title,
    body: [
      `Workflow **${workflowName}** failed on \`${repo.defaultBranch}\`: ${runUrl}`,
      ``,
      `**Triggered by:** \`${event}\``,
      RETRY_STATE_TEXT[retryState],
      ``,
      `Auto-filed by Claws' \`main-build-monitor\` job.`,
    ].join("\n"),
    // Deliberately unlabelled — see docs/label-audit.md.
    labels: [],
    legacyTitles: [`[main] ${workflowName} failed on main`],
    logPrefix: NAME,
    // The body carries this run's URL and event, so a later failure of the same workflow
    // must rewrite it rather than only bump the occurrence block.
    refreshBody: true,
  });

  await db.markMainBuildReported(runId);

  if (getProdAlertWorkflows(repo.fullName).includes(workflowName)) {
    // A Slack outage must never abort issue filing.
    try {
      await notifyProdAlert(
        `:rotating_light: *${repo.fullName}* — \`${workflowName}\` FAILED on ${repo.defaultBranch}. ` +
          `Prod-down class failure; investigate now.\n${runUrl}`,
      );
    } catch (err) {
      log.warn(`[${NAME}] Slack prod alert for ${repo.fullName} ${workflowName} failed: ${err}`);
    }
  }
}

type CloseResult = "held" | "closed" | "failed";

/**
 * Close an alert issue once its build is green. Refined and an open Claws PR hold the
 * close (work in flight); Claws Ignore deliberately does not.
 */
async function closeIfGreen(
  repo: Repo,
  issue: { number: gh.Issue["number"]; labels: string[] },
  comment: string,
): Promise<CloseResult> {
  try {
    if (issue.labels.includes("Refined")) {
      log.info(`[${NAME}] Not closing ${repo.fullName}#${issue.number} — Refined, work in flight`);
      return "held";
    }
    const trackerId = await resolveTrackerId(repo.fullName, issue.number);
    if (trackerId && (await db.listOpenClawsPrsForIssue(trackerId)).length > 0) {
      log.info(`[${NAME}] Not closing ${repo.fullName}#${issue.number} — open Claws PR`);
      return "held";
    }
    await gh.commentOnIssue(repo.fullName, issue.number, comment, { agentName: NAME });
    await gh.closeIssue(repo.fullName, issue.number, "completed");
    log.info(`[${NAME}] Closed ${repo.fullName}#${issue.number} — build is green again`);
    return "closed";
  } catch (err) {
    log.warn(`[${NAME}] Closing ${repo.fullName}#${issue.number} failed, will retry: ${err}`);
    return "failed";
  }
}

/** True when no open tracking issue remains (none found, or it was closed). */
async function closeTrackingIssue(
  repo: Repo,
  workflowName: string,
  successRun: db.MainBuildRunRow,
): Promise<boolean> {
  const issue = await resolveAlertIssue({
    repo: repo.fullName,
    title: `Build failure: ${workflowName}`,
    legacyTitles: [`[main] ${workflowName} failed on main`],
    logPrefix: NAME,
  });
  if (!issue) return true;
  const where = successRun.html_url ?? `run ${successRun.run_id}`;
  const result = await closeIfGreen(
    repo,
    issue,
    `A later \`${repo.defaultBranch}\` run of **${workflowName}** passed (${where}), so this build is green again. Closing.`,
  );
  return result === "closed";
}

/** Close the `[ci-unrelated]` tracker once every default-branch workflow is green after its last update. */
async function closeUnrelatedIfGreen(repo: Repo, latest: db.MainBuildRunRow[]): Promise<void> {
  try {
    if (latest.length === 0 || !latest.every((r) => r.conclusion === "success")) return;
    const issue = await resolveAlertIssue({ repo: repo.fullName, title: CI_UNRELATED_TITLE, logPrefix: NAME });
    if (!issue?.updatedAt) return;
    const newest = latest.reduce((a, b) => (Date.parse(b.created_at) > Date.parse(a.created_at) ? b : a));
    if (!(Date.parse(newest.created_at) > Date.parse(issue.updatedAt))) return;
    await closeIfGreen(
      repo,
      issue,
      `Every workflow on \`${repo.defaultBranch}\` is green again (${runUrlFor(repo, newest)}), so the tracked failures have cleared. Closing.`,
    );
  } catch (err) {
    log.warn(`[${NAME}] [ci-unrelated] close check for ${repo.fullName} failed: ${err}`);
  }
}

/** True when the failure looks like infrastructure or a network blip rather than the repo's code. */
async function classifyTransient(repo: Repo, run: db.MainBuildRunRow): Promise<string | null> {
  if (repo.forge === "forgejo") return await classifyForgejoTransient(repo, run);
  const jobs = await gh.getRunJobSummaries(repo.fullName, String(run.run_id));
  if (gh.isInfrastructureOutage(jobs) || gh.isPreRepoStepFailure(jobs)) return "infra";

  // `fetchFailedJobLog` reads only the *first* failed job, so with two failures a transient
  // one could mask a genuine one. Only classify from the log when there is exactly one.
  // The returned text has already had ANSI escapes stripped, so the patterns below match
  // colourised Docker/buildx output too.
  if (jobs.filter((j) => j.conclusion === "failure").length !== 1) return null;
  if (logFetchesThisPass >= MAX_LOG_FETCHES_PER_PASS) return null;
  logFetchesThisPass++;
  const text = await gh.fetchFailedJobLog(repo.fullName, run.run_id, LOG_TAIL_CHARS);
  return isTransientLog(text) ? "log-pattern" : null;
}

/**
 * The Forgejo side of {@link classifyTransient}, read through the image's job-log patch
 * endpoints. Forgejo has no job summaries, so there are no `infra` checks — only the log.
 * Every failed step's log is joined: the job's later `if: always()` steps fail too, and
 * the checkout's error lines must stay in the matched text.
 */
async function classifyForgejoTransient(repo: Repo, run: db.MainBuildRunRow): Promise<string | null> {
  const runNumber = run.run_number;
  if (runNumber == null) return null;
  try {
    const { jobs } = await forgejo.getActionRunJobs(repo.fullName, runNumber);
    // Same single-failure rule as GitHub: a transient failure must not mask a genuine one.
    const failed = jobs.filter((j) => j.status === "failure");
    if (failed.length !== 1) return null;
    if (logFetchesThisPass >= MAX_LOG_FETCHES_PER_PASS) return null;
    logFetchesThisPass++;
    const { steps } = await forgejo.getActionJobStepLogs(repo.fullName, runNumber, failed[0].index);
    const text = stripAnsi(
      steps
        .filter((s) => s.status === "failure")
        .map((s) => s.log)
        .join("\n"),
    ).slice(-LOG_TAIL_CHARS);
    return isTransientLog(text) ? "log-pattern" : null;
  } catch (err) {
    log.warn(`[${NAME}] Reading the log of ${repo.fullName} run ${runNumber} failed, not retrying: ${err}`);
    return null;
  }
}

/** Re-run a run's failed jobs on whichever forge hosts it. */
async function rerunFailed(repo: Repo, run: db.MainBuildRunRow): Promise<void> {
  if (repo.forge === "forgejo") {
    // The retry gate guarantees `run_number` on Forgejo.
    await forgejo.rerunFailedJobsByIndex(repo.fullName, run.run_number as number);
    return;
  }
  await gh.rerunFailedJobs(repo.fullName, String(run.run_id));
}

/** True when the re-run was refused because the run is already going again. */
function isAlreadyRunning(repo: Repo, err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (repo.forge === "forgejo") {
    return (err as { status?: unknown }).status === 409 && /action run is not done/i.test(err.message);
  }
  return /already running/i.test(err.message);
}

async function processRepo(repo: Repo, rows: db.MainBuildRunRow[]): Promise<void> {
  if (rows.length === 0) return;

  const ignored = getMainBuildIgnoreWorkflows(repo.fullName);
  // Rows are newest-first, so the first row per workflow is that workflow's latest run.
  const latestPerWorkflow = new Map<string, db.MainBuildRunRow>();
  for (const row of rows) {
    if (ignored.includes(row.workflow_name)) continue;
    if (!latestPerWorkflow.has(row.workflow_name)) latestPerWorkflow.set(row.workflow_name, row);
  }

  // Fetched at most once per repo; `null` means the tip is unknown, which never retries.
  let tipSha: string | null | undefined;

  for (const [workflowName, latest] of latestPerWorkflow) {
    if (latest.conclusion === "success") {
      if (await db.hasUnclosedReportedFailure(repo.fullName, workflowName)) {
        // Rows stay unclosed until the issue is closed or gone, so a held or failed
        // close is retried on the next pass.
        if (await closeTrackingIssue(repo, workflowName, latest)) {
          await db.markMainBuildFailuresClosed(repo.fullName, workflowName);
        }
      }
      continue;
    }
    // cancelled / skipped / startup_failure / null: neither file nor close. Matches the
    // `conclusion == 'failure'` gate the per-repo workflows used.
    if (latest.conclusion !== "failure") continue;

    const runId = runKey(repo, latest.run_id);
    if (await db.hasMainBuildFailure(runId)) continue;
    // `classifyTransient`/`rerunFailed` take the real forge run id, not the
    // namespaced DB key.
    const forgeRunId = String(latest.run_id);

    const runUrl = runUrlFor(repo, latest);
    if (tipSha === undefined) {
      // `getBranchTipCommit` is GitHub-only (assertGitHubOnly).
      tipSha =
        repo.forge === "forgejo"
          ? await forgejo.getBranchTipSha(repo.fullName, repo.defaultBranch)
          : ((await gh.getBranchTipCommit(repo.fullName, repo.defaultBranch))?.sha ?? null);
    }

    let reason: string | null = null;
    // Deferral is per workflow, not per repo: the later entries may only need a
    // close-on-green or a report, neither of which spends any budget.
    //
    // Forgejo's job-log and re-run endpoints take the web run number, so a Forgejo
    // too old to report it never retries.
    if (
      tipSha !== null &&
      (repo.forge !== "forgejo" || latest.run_number != null) &&
      isRetryCandidate(latest, tipSha, Date.now())
    ) {
      if (!reserveRerunSlot()) {
        log.info(`[${NAME}] Deferring ${repo.fullName} ${workflowName} (${runUrl}): rerun budget spent this pass`);
        continue;
      }
      if (await isPoolSaturated()) {
        releaseRerunSlot();
        log.info(`[${NAME}] Deferring ${repo.fullName} ${workflowName} (${runUrl}): runner pool saturated`);
        continue;
      }
      reason = await classifyTransient(repo, latest);
      if (reason === null) releaseRerunSlot();
    }

    let retryState: RetryState = "not-attempted";
    if (reason !== null) {
      try {
        await rerunFailed(repo, latest);
        await db.recordMainBuildFailure(runId, repo.fullName, workflowName, runUrl, true, null, latest.event);
        log.info(`[${NAME}] Re-ran failed jobs of ${repo.fullName} ${workflowName} (${runUrl}) — ${reason}`);
        continue;
      } catch (err) {
        if (isAlreadyRunning(repo, err)) {
          await db.recordMainBuildFailure(runId, repo.fullName, workflowName, runUrl, true, null, latest.event);
          log.info(`[${NAME}] ${repo.fullName} ${workflowName} run ${forgeRunId} already running`);
          continue;
        }
        // No CI run was spent, so hand the reserved slot back to the pass.
        releaseRerunSlot();
        retryState = "rerun-errored";
        // The permission alert is about a GitHub token; a Forgejo error never raises it.
        if (repo.forge !== "forgejo" && isActionsPermissionDenied(err)) {
          await reportActionsPermissionDenied(repo.fullName, forgeRunId);
        } else {
          log.warn(`[${NAME}] Re-run of ${repo.fullName} ${workflowName} run ${forgeRunId} failed: ${err}`);
        }
      }
    }

    // `outcome` doubles as the stored form of `retryState` so a failed `reportFailure` below
    // can be retried later (see `getUnreportedMainBuildFailures`) with the same wording.
    await db.recordMainBuildFailure(
      runId,
      repo.fullName,
      workflowName,
      runUrl,
      false,
      retryState === "rerun-errored" ? "rerun-errored" : "not-retried",
      latest.event,
    );
    // A per-workflow report failure (e.g. `ensureAlertIssue` throwing on a transient GitHub
    // API error) must not abort the rest of this repo's workflows — the row above is already
    // recorded with `reported = 0`, so `getUnreportedMainBuildFailures` retries it next pass.
    try {
      await reportFailure(repo, workflowName, runId, runUrl, latest.event, retryState);
    } catch (err) {
      reportError(`${NAME}:report-failure`, repo.fullName, err, { repo: repo.fullName });
    }
  }

  await closeUnrelatedIfGreen(repo, [...latestPerWorkflow.values()]);
}

/** Resolves the runs re-run on an earlier pass, then scans every repo's default branch. */
export async function run(repos: Repo[]): Promise<void> {
  rerunsThisPass = 0;
  logFetchesThisPass = 0;

  // One runs listing per Forgejo repo, shared by all of that repo's pending retries.
  const forgejoRuns = new Map<string, Promise<db.MainBuildRunRow[]>>();
  for (const row of await db.getPendingMainBuildRetries()) {
    try {
      let fresh: { status: string; conclusion: string | null; event: string } | "not_found" | null;
      if (row.run_id.startsWith(FORGEJO_KEY_PREFIX)) {
        // Forgejo has no fetch-run-by-id; re-list the repo's runs. A re-run keeps its id,
        // and the listing drops runs that have not finished, so an absent run stays pending
        // until the 24h expiry below.
        const repo = repos.find((r) => r.fullName === row.repo);
        if (!repo) continue;
        let runs = forgejoRuns.get(repo.fullName);
        if (!runs) {
          runs = forgejo.listDefaultBranchActionRuns(repo.fullName, repo.defaultBranch);
          forgejoRuns.set(repo.fullName, runs);
        }
        const id = Number(row.run_id.slice(FORGEJO_KEY_PREFIX.length));
        const found = (await runs).find((r) => r.run_id === id);
        fresh = found ? { status: "completed", conclusion: found.conclusion, event: found.event } : null;
      } else {
        fresh = await gh.fetchWorkflowRunById(row.repo, Number(row.run_id));
      }
      if (fresh === "not_found") {
        await db.setMainBuildRetryOutcome(row.run_id, "abandoned");
        continue;
      }
      // A transient API failure or a still-running retry stays pending for the next pass.
      if (fresh === null || fresh.status !== "completed") continue;

      if (fresh.conclusion === "success") {
        await db.setMainBuildRetryOutcome(row.run_id, "success");
        log.info(`[${NAME}] Retry of ${row.repo} ${row.workflow_name} (${row.run_url}) passed`);
        continue;
      }

      // cancelled / skipped / startup_failure / null: neither a pass nor a genuine
      // failure. Leave the row pending, matching the scan path's tri-state handling.
      if (fresh.conclusion !== "failure") continue;

      await db.setMainBuildRetryOutcome(row.run_id, "failure");
      const repo = repos.find((r) => r.fullName === row.repo);
      if (!repo) continue;
      await reportFailure(repo, row.workflow_name, row.run_id, row.run_url, fresh.event, "failed-again");
    } catch (err) {
      reportError("main-build-monitor:resolve", row.repo, err, { repo: row.repo });
    }
  }

  // A retry that never resolved within the 24h window `getPendingMainBuildRetries` looks
  // at (e.g. a self-hosted runner pool down long enough the re-run never completed) must
  // not just silently drop out of that query — force it to a terminal outcome so it flows
  // into `getUnreportedMainBuildFailures` below and actually gets reported.
  for (const row of await db.getExpiredMainBuildRetries()) {
    await db.setMainBuildRetryOutcome(row.run_id, "retry-timed-out");
    log.warn(
      `[${NAME}] Retry of ${row.repo} ${row.workflow_name} (${row.run_url}) never resolved within 24h — reporting as failed`,
    );
  }

  // A row can reach a terminal outcome (above, or in `processRepo`) without ever getting
  // `reported = 1` — `ensureAlertIssue` itself can throw. Retry those every pass so a single
  // GitHub API hiccup can't permanently and silently drop a build-failure report.
  for (const row of await db.getUnreportedMainBuildFailures()) {
    const repo = repos.find((r) => r.fullName === row.repo);
    if (!repo) continue;
    const retryState: RetryState =
      row.outcome === "failure"
        ? "failed-again"
        : row.outcome === "rerun-errored"
          ? "rerun-errored"
          : row.outcome === "retry-timed-out"
            ? "retry-timed-out"
            : "not-attempted";
    try {
      await reportFailure(repo, row.workflow_name, row.run_id, row.run_url, row.event, retryState);
    } catch (err) {
      reportError("main-build-monitor:resolve", row.repo, err, { repo: row.repo });
    }
  }

  const targets = repos.filter((r) => !isJobDisabledForRepo(NAME, r.fullName));
  await mapWithConcurrency(targets, REPO_CONCURRENCY, (r) =>
    loadRuns(r)
      .then((rows) => processRepo(r, rows))
      .catch((err) => reportError("main-build-monitor:process-repo", r.fullName, err, { repo: r.fullName })),
  );
}

/**
 * A repo's completed default-branch push/schedule runs. GitHub reads the locally
 * synced `workflow_runs` table; Forgejo has no such sync, so its runs are fetched
 * directly (#2779) — `gh.listRepos()` already omits Forgejo repos when no token is
 * configured, so this never runs unauthenticated.
 */
async function loadRuns(repo: Repo): Promise<db.MainBuildRunRow[]> {
  if (repo.forge === "forgejo") {
    return loadForgejoRuns(repo);
  }
  return await db.getDefaultBranchRuns(repo.fullName, repo.defaultBranch, 7);
}

const UNREADABLE_TITLE = "Claws cannot read this repo on Forgejo";

/** Repos already warned about for a 404 runs listing; cleared when a listing succeeds. */
const actionsUnavailableWarned = new Set<string>();

function isNotFound(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status === 404;
}

/**
 * Forgejo answers 404 on the runs listing when Actions is disabled for the repo
 * (nothing to monitor) and also when the token cannot read the repo at all. Probe
 * the repo itself to tell them apart; only the latter is worth an alert.
 */
async function loadForgejoRuns(repo: Repo): Promise<db.MainBuildRunRow[]> {
  let rows: db.MainBuildRunRow[];
  try {
    rows = await forgejo.listDefaultBranchActionRuns(repo.fullName, repo.defaultBranch);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    try {
      await forgejo.getRepo(repo.fullName);
    } catch (repoErr) {
      if (!isNotFound(repoErr)) throw repoErr;
      await upsertUnreadableAlert(repo);
      return [];
    }
    if (!actionsUnavailableWarned.has(repo.fullName)) {
      actionsUnavailableWarned.add(repo.fullName);
      log.warn(
        `[${NAME}] ${repo.fullName}: Forgejo Actions runs endpoint returned 404 but the repo is readable — Actions is likely disabled for this repo; nothing to monitor`,
      );
    }
    await clearUnreadableAlert(repo);
    return [];
  }
  actionsUnavailableWarned.delete(repo.fullName);
  await clearUnreadableAlert(repo);
  return rows;
}

async function upsertUnreadableAlert(repo: Repo): Promise<void> {
  const body = [
    `**Symptom:** \`GET /repos/${repo.fullName}\` and \`GET /repos/${repo.fullName}/actions/runs\` both return HTTP 404 for Claws' Forgejo bot token.`,
    "",
    "**Likely cause:** the token (`CLAWS_FORGEJO_TOKEN` / `forgejoToken`) expired, lacks `read:repository` scope, or the bot account lost access to the repo.",
    "",
    "**Action:** rotate or re-scope the token, or re-grant the bot account access to the repo. This issue closes automatically once the repo is readable again.",
    "",
    "Auto-filed by Claws' main-build-monitor job.",
  ].join("\n");
  await upsertAlertIssue({ repo: repo.fullName, title: UNREADABLE_TITLE, body, labels: [], logPrefix: NAME });
}

async function clearUnreadableAlert(repo: Repo): Promise<void> {
  try {
    await closeAlertIssueIfResolved({
      repo: repo.fullName,
      title: UNREADABLE_TITLE,
      logPrefix: NAME,
      reason: "repo readable again",
    });
  } catch (err) {
    log.warn(`[${NAME}] Closing unreadable-repo alert for ${repo.fullName} failed: ${err}`);
  }
}
