import type { Repo } from "../config.js";
import { isJobDisabledForRepo, PROD_ALERT_WORKFLOWS, MAIN_BUILD_IGNORE_WORKFLOWS, forgejoRepoUrl } from "../config.js";
import * as db from "../db.js";
import * as gh from "../github.js";
import * as forgejo from "../forgejo.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { ensureAlertIssue } from "../occurrence-tracking.js";
import { notifyProdAlert } from "../slack.js";
import { isPoolSaturated, isActionsPermissionDenied, reportActionsPermissionDenied } from "../agents/ci-fixer.js";
import { mapWithConcurrency } from "../util.js";

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
];

export function isTransientLog(text: string): boolean {
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
  return repo.forge === "forgejo" ? `forgejo:${runId}` : String(runId);
}

/**
 * What Claws did about the failure, as the issue body must describe it. `rerun-errored`
 * exists so a re-run whose API call itself blew up is not reported as "did not match the
 * transient-error heuristic" — it did match, the retry just never started.
 */
type RetryState = "not-attempted" | "rerun-errored" | "failed-again" | "retry-timed-out";

const RETRY_STATE_TEXT: Record<RetryState, string> = {
  "not-attempted": `Claws did not retry this run — the failure did not match its transient-error heuristic.`,
  "rerun-errored": `Claws classified this failure as transient and asked GitHub to re-run the failed jobs, but the re-run request itself errored — no retry ran.`,
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

  db.markMainBuildReported(runId);

  if ((PROD_ALERT_WORKFLOWS[repo.fullName] ?? []).includes(workflowName)) {
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

async function closeTrackingIssue(
  repo: Repo,
  workflowName: string,
  successRun: db.MainBuildRunRow,
): Promise<void> {
  const issue = await gh.findIssueByExactTitle(repo.fullName, `Build failure: ${workflowName}`);
  if (!issue) return;
  // Never close an issue already being implemented or carrying an open PR.
  if (issue.labels.some((l) => l === "Refined" || l === "In Review" || l === "Claws Ignore")) return;

  const where = successRun.html_url ?? `run ${successRun.run_id}`;
  await gh.commentOnIssue(
    repo.fullName,
    issue.number,
    `A later \`${repo.defaultBranch}\` run of **${workflowName}** passed (${where}), so this build is green again. Closing.`,
    { agentName: NAME },
  );
  await gh.closeIssue(repo.fullName, issue.number, "completed");
  log.info(`[${NAME}] Closed ${repo.fullName}#${issue.number} — ${workflowName} is green again`);
}

/** True when the failure looks like infrastructure or a network blip rather than the repo's code. */
async function classifyTransient(repo: Repo, run: db.MainBuildRunRow): Promise<string | null> {
  const jobs = await gh.getRunJobSummaries(repo.fullName, String(run.run_id));
  if (gh.isInfrastructureOutage(jobs) || gh.isPreRepoStepFailure(jobs)) return "infra";

  // `fetchFailedJobLog` reads only the *first* failed job, so with two failures a transient
  // one could mask a genuine one. Only classify from the log when there is exactly one.
  if (jobs.filter((j) => j.conclusion === "failure").length !== 1) return null;
  if (logFetchesThisPass >= MAX_LOG_FETCHES_PER_PASS) return null;
  logFetchesThisPass++;
  const text = await gh.fetchFailedJobLog(repo.fullName, run.run_id, LOG_TAIL_CHARS);
  return isTransientLog(text) ? "log-pattern" : null;
}

async function processRepo(repo: Repo, rows: db.MainBuildRunRow[]): Promise<void> {
  if (rows.length === 0) return;

  const ignored = MAIN_BUILD_IGNORE_WORKFLOWS[repo.fullName] ?? [];
  // Rows are newest-first, so the first row per workflow is that workflow's latest run.
  const latestPerWorkflow = new Map<string, db.MainBuildRunRow>();
  for (const row of rows) {
    if (ignored.includes(row.workflow_name)) continue;
    if (!latestPerWorkflow.has(row.workflow_name)) latestPerWorkflow.set(row.workflow_name, row);
  }

  let tip: Awaited<ReturnType<typeof gh.getBranchTipCommit>> | undefined;

  for (const [workflowName, latest] of latestPerWorkflow) {
    if (latest.conclusion === "success") {
      if (db.hasUnclosedReportedFailure(repo.fullName, workflowName)) {
        await closeTrackingIssue(repo, workflowName, latest);
        // Marked closed regardless of whether an issue was found, so a missing issue
        // does not retry the lookup forever.
        db.markMainBuildFailuresClosed(repo.fullName, workflowName);
      }
      continue;
    }
    // cancelled / skipped / startup_failure / null: neither file nor close. Matches the
    // `conclusion == 'failure'` gate the per-repo workflows used.
    if (latest.conclusion !== "failure") continue;

    const runId = runKey(repo, latest.run_id);
    if (db.hasMainBuildFailure(runId)) continue;
    // `classifyTransient`/`rerunFailedJobs` take the real forge run id, not the
    // namespaced DB key.
    const forgeRunId = String(latest.run_id);

    const runUrl = runUrlFor(repo, latest);
    // `getBranchTipCommit` is GitHub-only (assertGitHubOnly) — Forgejo never takes
    // the retry path below, so its tip is never needed and must never be fetched.
    if (repo.forge !== "forgejo" && tip === undefined) {
      tip = await gh.getBranchTipCommit(repo.fullName, repo.defaultBranch);
    }

    let reason: string | null = null;
    // Deferral is per workflow, not per repo: the later entries may only need a
    // close-on-green or a report, neither of which spends any budget.
    //
    // Forgejo has no rerun endpoint — rerunFailedJobs is a documented no-op
    // (src/forgejo.ts) — so every Forgejo failure goes straight to the issue.
    if (repo.forge !== "forgejo" && tip !== undefined && tip !== null && isRetryCandidate(latest, tip.sha, Date.now())) {
      if (!reserveRerunSlot()) {
        log.info(`[${NAME}] Deferring ${repo.fullName} ${workflowName} (${runUrl}): rerun budget spent this pass`);
        continue;
      }
      if (isPoolSaturated()) {
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
        await gh.rerunFailedJobs(repo.fullName, forgeRunId);
        db.recordMainBuildFailure(runId, repo.fullName, workflowName, runUrl, true, null, latest.event);
        log.info(`[${NAME}] Re-ran failed jobs of ${repo.fullName} ${workflowName} (${runUrl}) — ${reason}`);
        continue;
      } catch (err) {
        if (err instanceof Error && /already running/i.test(err.message)) {
          db.recordMainBuildFailure(runId, repo.fullName, workflowName, runUrl, true, null, latest.event);
          log.info(`[${NAME}] ${repo.fullName} ${workflowName} run ${forgeRunId} already running`);
          continue;
        }
        // No CI run was spent, so hand the reserved slot back to the pass.
        releaseRerunSlot();
        retryState = "rerun-errored";
        if (isActionsPermissionDenied(err)) {
          await reportActionsPermissionDenied(repo.fullName, forgeRunId);
        } else {
          log.warn(`[${NAME}] Re-run of ${repo.fullName} ${workflowName} run ${forgeRunId} failed: ${err}`);
        }
      }
    }

    // `outcome` doubles as the stored form of `retryState` so a failed `reportFailure` below
    // can be retried later (see `getUnreportedMainBuildFailures`) with the same wording.
    db.recordMainBuildFailure(
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
      reportError(`${NAME}:report-failure`, repo.fullName, err);
    }
  }
}

/** Resolves the runs re-run on an earlier pass, then scans every repo's default branch. */
export async function run(repos: Repo[]): Promise<void> {
  rerunsThisPass = 0;
  logFetchesThisPass = 0;

  for (const row of db.getPendingMainBuildRetries()) {
    try {
      // Invariant: Forgejo runs are never retried, so they never reach the pending set.
      // `fetchWorkflowRunById` is GitHub-only and `Number("forgejo:3")` is NaN.
      if (row.run_id.startsWith("forgejo:")) {
        db.setMainBuildRetryOutcome(row.run_id, "abandoned");
        continue;
      }
      const fresh = await gh.fetchWorkflowRunById(row.repo, Number(row.run_id));
      if (fresh === "not_found") {
        db.setMainBuildRetryOutcome(row.run_id, "abandoned");
        continue;
      }
      // A transient API failure or a still-running retry stays pending for the next pass.
      if (fresh === null || fresh.status !== "completed") continue;

      if (fresh.conclusion === "success") {
        db.setMainBuildRetryOutcome(row.run_id, "success");
        log.info(`[${NAME}] Retry of ${row.repo} ${row.workflow_name} (${row.run_url}) passed`);
        continue;
      }

      // cancelled / skipped / startup_failure / null: neither a pass nor a genuine
      // failure. Leave the row pending, matching the scan path's tri-state handling.
      if (fresh.conclusion !== "failure") continue;

      db.setMainBuildRetryOutcome(row.run_id, "failure");
      const repo = repos.find((r) => r.fullName === row.repo);
      if (!repo) continue;
      await reportFailure(repo, row.workflow_name, row.run_id, row.run_url, fresh.event, "failed-again");
    } catch (err) {
      reportError("main-build-monitor:resolve", row.repo, err);
    }
  }

  // A retry that never resolved within the 24h window `getPendingMainBuildRetries` looks
  // at (e.g. a self-hosted runner pool down long enough the re-run never completed) must
  // not just silently drop out of that query — force it to a terminal outcome so it flows
  // into `getUnreportedMainBuildFailures` below and actually gets reported.
  for (const row of db.getExpiredMainBuildRetries()) {
    db.setMainBuildRetryOutcome(row.run_id, "retry-timed-out");
    log.warn(
      `[${NAME}] Retry of ${row.repo} ${row.workflow_name} (${row.run_url}) never resolved within 24h — reporting as failed`,
    );
  }

  // A row can reach a terminal outcome (above, or in `processRepo`) without ever getting
  // `reported = 1` — `ensureAlertIssue` itself can throw. Retry those every pass so a single
  // GitHub API hiccup can't permanently and silently drop a build-failure report.
  for (const row of db.getUnreportedMainBuildFailures()) {
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
      reportError("main-build-monitor:resolve", row.repo, err);
    }
  }

  const targets = repos.filter((r) => !isJobDisabledForRepo(NAME, r.fullName));
  await mapWithConcurrency(targets, REPO_CONCURRENCY, (r) =>
    loadRuns(r)
      .then((rows) => processRepo(r, rows))
      .catch((err) => reportError("main-build-monitor:process-repo", r.fullName, err)),
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
    return forgejo.listDefaultBranchActionRuns(repo.fullName, repo.defaultBranch);
  }
  return db.getDefaultBranchRuns(repo.fullName, repo.defaultBranch, 7);
}
