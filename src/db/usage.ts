// Queue snapshots, controller status and commands, main-build failures,
// per-repo queries, usage aggregation, agent event totals, the usage ledger
// and workflow runs. Reached only through the src/db.ts façade.
import type { SqlDriver } from "../db-driver.js";
import * as log from "../log.js";
import { flushGitHubEvents } from "../github-events.js";
import { pruneGateState } from "../gate-events.js";
import { normalizeItemNumbers, type IssueRef } from "../issue-id.js";
import { DAY_MS, getDb, nowSql, nowSqlOffsetMs, timedDb } from "./core.js";
import type { ProviderHoldRow } from "./providers.js";
import type { RecentEffectivenessEvent, Task } from "./tasks.js";

// ── Queue snapshots & average durations ──

export async function recordQueueSnapshot(totalItems: number): Promise<void> {
  await getDb().run(`INSERT INTO queue_snapshots (total_items, recorded_at) VALUES (?, ?)`, [totalItems, nowSql()]);
}

export async function getQueueSnapshots(hours = 24): Promise<Array<{ totalItems: number; recordedAt: string }>> {
  const rows = await getDb().all(`SELECT total_items, recorded_at FROM queue_snapshots
       WHERE recorded_at > ?
       ORDER BY recorded_at ASC`, [nowSqlOffsetMs(-hours * 60 * 60 * 1000)]) as Array<{ total_items: number; recorded_at: string }>;
  return rows.map((r) => ({ totalItems: r.total_items, recordedAt: r.recorded_at }));
}

export async function pruneQueueSnapshots(retentionHours = 72): Promise<number> {
  return timedDb("prune-queue-snapshots", () => pruneQueueSnapshotsUntimed(retentionHours));
}

async function pruneQueueSnapshotsUntimed(retentionHours = 72): Promise<number> {
  const result = await getDb().run(`DELETE FROM queue_snapshots WHERE recorded_at < ?`, [nowSqlOffsetMs(-retentionHours * 60 * 60 * 1000)]);
  return result.changes;
}

/**
 * Deletes `claws_events` rows older than `retentionHours`; nobody waits that
 * long. Also prunes stale inactive `claws_gate_state` rows (`pruneGateState`).
 */
export async function pruneClawsEvents(retentionHours = 24): Promise<number> {
  return timedDb("prune-claws-events", () => pruneClawsEventsUntimed(retentionHours));
}

async function pruneClawsEventsUntimed(retentionHours = 24): Promise<number> {
  await flushGitHubEvents();
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString();
  const result = await getDb().run(`DELETE FROM claws_events WHERE at < ?`, [cutoff]);
  await pruneGateState().catch((err) => log.warn(`pruneGateState failed: ${err}`));
  return result.changes;
}

/** Deletes controller commands completed more than `retentionDays` ago. */
export async function pruneControllerCommands(retentionDays = 7): Promise<number> {
  return timedDb("prune-controller-commands", () => pruneControllerCommandsUntimed(retentionDays));
}

async function pruneControllerCommandsUntimed(retentionDays = 7): Promise<number> {
  const result = await getDb().run(`DELETE FROM controller_commands WHERE completed_at IS NOT NULL AND completed_at < ?`, [nowSqlOffsetMs(-retentionDays * DAY_MS)]);
  return result.changes;
}

// ── Controller status and commands (src/controller-client.ts) ──

/** Upserts one `controller_status` topic as JSON. */
export async function writeControllerStatus(key: string, value: unknown): Promise<void> {
  await getDb().run(`
    INSERT INTO controller_status (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `, [key, JSON.stringify(value), nowSql()]);
}

/** One `controller_status` topic's parsed value, or null when it was never written. */
export async function readControllerStatus<T>(key: string): Promise<T | null> {
  const row = await getDb().get<{ value_json: string }>(`SELECT value_json FROM controller_status WHERE key = ?`, [key]);
  return row ? JSON.parse(row.value_json) as T : null;
}

/** A row of `controller_commands`. */
export interface ControllerCommandRow {
  id: number;
  kind: string;
  args_json: string;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  result_json: string | null;
}

function toControllerCommandRow(row: ControllerCommandRow): ControllerCommandRow {
  return { ...row, id: Number(row.id) };
}

/** Files a command for the controller; returns its id. */
export async function insertControllerCommand(kind: string, args: unknown): Promise<number> {
  const { id } = await getDb().insert(
    `INSERT INTO controller_commands (kind, args_json, created_at) VALUES (?, ?, ?)`,
    [kind, JSON.stringify(args ?? {}), nowSql()],
  );
  return id;
}

export async function getControllerCommand(id: number): Promise<ControllerCommandRow | null> {
  const row = await getDb().get<ControllerCommandRow>(`SELECT * FROM controller_commands WHERE id = ?`, [id]);
  return row ? toControllerCommandRow(row) : null;
}

/**
 * Claims up to `limit` unclaimed commands, oldest first. Each claim is a
 * conditional update, so a command is only ever returned to one claimer.
 */
export async function claimControllerCommands(limit = 20): Promise<ControllerCommandRow[]> {
  const rows = (await getDb().all<ControllerCommandRow>(
    `SELECT * FROM controller_commands WHERE claimed_at IS NULL ORDER BY id LIMIT ${Math.max(1, Math.floor(limit))}`,
  )).map(toControllerCommandRow);
  const claimed: ControllerCommandRow[] = [];
  for (const row of rows) {
    const at = nowSql();
    const { changes } = await getDb().run(`UPDATE controller_commands SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL`, [at, row.id]);
    if (changes === 1) claimed.push({ ...row, claimed_at: at });
  }
  return claimed;
}

/** Records a claimed command's result. */
export async function completeControllerCommand(id: number, result: unknown): Promise<void> {
  await getDb().run(`UPDATE controller_commands SET completed_at = ?, result_json = ? WHERE id = ?`, [nowSql(), JSON.stringify(result ?? null), id]);
}

export async function pruneWorkflowRuns(retentionDays = 30): Promise<number> {
  return timedDb("prune-workflow-runs", () => pruneWorkflowRunsUntimed(retentionDays));
}

async function pruneWorkflowRunsUntimed(retentionDays = 30): Promise<number> {
  const result = await getDb().run(`DELETE FROM workflow_runs WHERE created_at < ?`, [nowSqlOffsetMs(-retentionDays * DAY_MS)]);
  return result.changes;
}

export async function deleteWorkflowRun(runId: number): Promise<void> {
  await getDb().run(`DELETE FROM workflow_runs WHERE run_id = ?`, [runId]);
}

// ── Default-branch build failures (main-build-monitor) ──

/** A completed default-branch run, as the main-build-monitor sees it. */
export interface MainBuildRunRow {
  run_id: number;
  workflow_name: string;
  conclusion: string | null;
  event: string;
  created_at: string;
  head_sha: string | null;
  html_url: string | null;
  run_attempt: number | null;
  /** Forgejo only: the run number in the web URL (`/actions/runs/<n>`), which the job-log
   *  and re-run endpoints take. GitHub rows leave it unset. */
  run_number?: number | null;
}

/** `outcome` is NULL only while a retry is in flight; otherwise
 *  "success" | "failure" | "abandoned" | "not-retried" | "rerun-errored" | "retry-timed-out". */
export interface MainBuildFailureRow {
  run_id: string;
  repo: string;
  workflow_name: string;
  run_url: string;
  detected_at: string;
  retried: number;
  outcome: string | null;
  reported: number;
  closed_at: string | null;
  event: string;
  /** JSON `RetryOutcome` from main-build-monitor stating why no retry ran; NULL on retried and legacy rows. */
  retry_detail: string | null;
}

/** Completed push/schedule runs on a repo's default branch, newest first.
 *  `workflow_dispatch` is excluded on purpose — a human pressing "Run workflow"
 *  sees their own failure. */
export async function getDefaultBranchRuns(repo: string, branch: string, sinceDays = 7): Promise<MainBuildRunRow[]> {
  return await getDb().all(`
      SELECT run_id, workflow_name, conclusion, event, created_at, head_sha, html_url, run_attempt
      FROM workflow_runs
      WHERE repo = ? AND head_branch = ? AND status = 'completed'
        AND event IN ('push','schedule')
        AND created_at >= ?
      ORDER BY created_at DESC
    `, [repo, branch, nowSqlOffsetMs(-sinceDays * DAY_MS)]) as MainBuildRunRow[];
}

export async function recordMainBuildFailure(
  runId: string,
  repo: string,
  workflowName: string,
  runUrl: string,
  retried: boolean,
  outcome: string | null,
  event = "",
  retryDetail: string | null = null,
): Promise<void> {
  await getDb().run(`
      INSERT OR IGNORE INTO main_build_failures (run_id, repo, workflow_name, run_url, retried, outcome, event, retry_detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [runId, repo, workflowName, runUrl, retried ? 1 : 0, outcome, event, retryDetail]);
}

export async function hasMainBuildFailure(runId: string): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 AS n FROM main_build_failures WHERE run_id = ? LIMIT 1`, [runId]) as { n: number } | undefined;
  return row !== undefined;
}

export async function getPendingMainBuildRetries(): Promise<MainBuildFailureRow[]> {
  return await getDb().all(`
      SELECT * FROM main_build_failures
      WHERE retried = 1 AND outcome IS NULL AND detected_at > ?
      ORDER BY detected_at ASC
    `, [nowSqlOffsetMs(-DAY_MS)]) as MainBuildFailureRow[];
}

/**
 * Retries that fell out of `getPendingMainBuildRetries()`'s 24h window without ever
 * resolving — e.g. a self-hosted runner pool down long enough that the re-run never
 * completed. Left alone these rows would sit with `outcome = NULL` until
 * `pruneMainBuildFailures` quietly deleted them, and the failure they represent would
 * never get reported.
 */
export async function getExpiredMainBuildRetries(): Promise<MainBuildFailureRow[]> {
  return await getDb().all(`
      SELECT * FROM main_build_failures
      WHERE retried = 1 AND outcome IS NULL AND detected_at <= ?
      ORDER BY detected_at ASC
    `, [nowSqlOffsetMs(-DAY_MS)]) as MainBuildFailureRow[];
}

export async function setMainBuildRetryOutcome(runId: string, outcome: string): Promise<void> {
  await getDb().run(`UPDATE main_build_failures SET outcome = ? WHERE run_id = ?`, [outcome, runId]);
}

export async function markMainBuildReported(runId: string): Promise<void> {
  await getDb().run(`UPDATE main_build_failures SET reported = 1 WHERE run_id = ?`, [runId]);
}

/**
 * Rows whose terminal outcome required filing/updating the tracking issue, but that never
 * got marked `reported` — i.e. the `ensureAlertIssue` call in `reportFailure` threw. Retried
 * every pass until it succeeds, so a single GitHub API hiccup can't permanently drop a build
 * failure (`retried = 1 AND outcome IS NULL` rows are still-pending retries, handled by
 * `getPendingMainBuildRetries`, and are excluded here since `outcome` is non-null).
 */
export async function getUnreportedMainBuildFailures(): Promise<MainBuildFailureRow[]> {
  return await getDb().all(`
      SELECT * FROM main_build_failures
      WHERE reported = 0 AND outcome IS NOT NULL AND outcome NOT IN ('success', 'abandoned')
      ORDER BY detected_at ASC
    `) as MainBuildFailureRow[];
}

export async function hasUnclosedReportedFailure(repo: string, workflowName: string): Promise<boolean> {
  const row = await getDb().get(`
      SELECT 1 AS n FROM main_build_failures
      WHERE repo = ? AND workflow_name = ? AND reported = 1 AND closed_at IS NULL
      LIMIT 1
    `, [repo, workflowName]) as { n: number } | undefined;
  return row !== undefined;
}

export async function markMainBuildFailuresClosed(repo: string, workflowName: string): Promise<void> {
  await getDb().run(`
      UPDATE main_build_failures SET closed_at = ?
      WHERE repo = ? AND workflow_name = ? AND closed_at IS NULL
    `, [nowSql(), repo, workflowName]);
}

export async function pruneMainBuildFailures(retentionDays = 30): Promise<number> {
  return timedDb("prune-main-build-failures", () => pruneMainBuildFailuresUntimed(retentionDays));
}

async function pruneMainBuildFailuresUntimed(retentionDays = 30): Promise<number> {
  const result = await getDb().run(`DELETE FROM main_build_failures WHERE detected_at < ?`, [nowSqlOffsetMs(-retentionDays * DAY_MS)]);
  return result.changes;
}

// ── Per-repo queries ──

export async function getRecentTasksForRepo(repo: string, limit = 20): Promise<Task[]> {
  return normalizeItemNumbers(await getDb().all(`SELECT * FROM tasks WHERE repo = ? ORDER BY started_at DESC LIMIT ?`, [repo, limit]) as Task[]);
}

export async function getDailyTaskStats(repo: string, days = 30): Promise<Array<{ date: string; completed: number; failed: number }>> {
  return await getDb().all(`
      SELECT
        strftime('%Y-%m-%d', started_at) AS date,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM tasks
      WHERE repo = ? AND started_at > ?
      GROUP BY date
      ORDER BY date ASC
    `, [repo, nowSqlOffsetMs(-days * DAY_MS)]) as Array<{ date: string; completed: number; failed: number }>;
}

// ── Usage / cost aggregation ──

export interface UsageTotals {
  taskCount: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface UsageFilters {
  repo?: string;
  job?: string;      // job-name prefix, matching the jobStats grouping
  provider?: string; // "unknown" matches rows with NULL provider_used
  model?: string;    // "unknown" matches rows with NULL model_used
  account?: string;  // Claude account id recorded in account_used
}

export type SessionUsageWarningLevel = "none" | "warn" | "critical";

/** One task or interactive session in the `/usage` window, the row the page's pivot groups. */
export interface UsageItem {
  kind: "task" | "session";
  taskId: number | null;
  /** The task's `job_runs` id, for its `/logs/<runId>` link; null for sessions and older tasks. */
  runId: string | null;
  sessionId: string | null;
  /** The task's repo, or the session's repo; null for a directory-only session (see `cwd`). */
  repo: string | null;
  cwd: string | null;
  job: string;
  provider: string;
  /** The Claude account that served a task, "" when none was recorded. */
  account: string;
  model: string;
  /** The task status, or "Live"/"Ended" for a session. */
  state: string;
  tokens: number;
  /** Null when the cost is unknown (a session whose transcript exposes none). */
  costUsd: number | null;
  /** A session's last context size; null for tasks. */
  lastContextTokens: number | null;
  /** UTC `YYYY-MM-DD`: a task's started day or a session's created day. */
  day: string;
  /** A session still running; false for tasks. */
  alive: boolean;
}

const JOB_PREFIX_SQL = `CASE WHEN INSTR(job_name, ':') > 0 THEN SUBSTR(job_name, 1, INSTR(job_name, ':') - 1) ELSE job_name END`;

/** A job name's prefix (the text before the first `:`), as {@link JOB_PREFIX_SQL} computes it. */
export function jobPrefix(jobName: string): string {
  const i = jobName.indexOf(":");
  return i >= 0 ? jobName.slice(0, i) : jobName;
}

// ── Agent event totals (`agent_event_totals`) ──

export type AgentEventMetric = "task_failures" | "items_removed";

/** Add 1 to one `agent_event_totals` row, creating it at 1. */
export async function bumpAgentEventTotal(metric: AgentEventMetric, job: string, reason: string, podClass: string): Promise<void> {
  await getDb().run(`
      INSERT INTO agent_event_totals (metric, job, reason, pod_class, n) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (metric, job, reason, pod_class) DO UPDATE SET n = agent_event_totals.n + 1
    `, [metric, job, reason, podClass]);
}

/**
 * Count one item removed from the queue (auto-skipped) after repeated
 * `reason` kills (`memory-limit`, `timeout`) of a `jobName` run in `podClass`
 * (`default`, `large`, or `none` when not in an agent pod). Exported as
 * `claws_agent_items_removed_from_queue_total`.
 */
export async function recordItemRemovedFromQueue(jobName: string, reason: string, podClass: string): Promise<void> {
  await bumpAgentEventTotal("items_removed", jobPrefix(jobName), reason, podClass);
}

export interface AgentEventTotal {
  metric: AgentEventMetric;
  job: string;
  reason: string;
  podClass: string;
  count: number;
}

/** Every `agent_event_totals` row: lifetime task failures by reason and queue removals. */
export async function getAgentEventTotals(): Promise<AgentEventTotal[]> {
  return timedDb("agent-event-totals", async () => {
    const rows = await getDb().all<{ metric: AgentEventMetric; job: string; reason: string; pod_class: string; n: number }>(
      `SELECT metric, job, reason, pod_class, n FROM agent_event_totals`,
    );
    return rows.map((r) => ({ metric: r.metric, job: r.job, reason: r.reason, podClass: r.pod_class, count: Number(r.n) }));
  });
}

// ── Agent usage ledger (`usage_retired_totals`) and metric readers ──

/** The agent usage metric labels of a `tasks` row: repo, job prefix, provider, model, account. */
const TASK_USAGE_LABELS_SQL = `repo, ${JOB_PREFIX_SQL}, COALESCE(provider_used, 'unknown'), COALESCE(model_used, 'unknown'), COALESCE(account_used, '')`;
/** The same labels for a `sessions` row; `repo` is never the cwd. */
const SESSION_USAGE_LABELS_SQL = `COALESCE(repo, ''), 'interactive-session', COALESCE(provider, 'claude'), COALESCE(model, 'unknown'), ''`;
const RETIRED_UPSERT_SQL = `
      ON CONFLICT (repo, job, provider, model, account, outcome) DO UPDATE SET
        tasks = usage_retired_totals.tasks + excluded.tasks,
        tokens = usage_retired_totals.tokens + excluded.tokens,
        cost_usd = usage_retired_totals.cost_usd + excluded.cost_usd`;

/**
 * Fold the `tasks` rows matching `where` into `usage_retired_totals` before
 * they are deleted (`counted`: outcome is the status and each row counts as a
 * task) or their usage is overwritten by a lower snapshot (outcome `''`, no task).
 */
export async function retireTaskUsage(tx: SqlDriver, where: string, params: unknown[], counted: boolean): Promise<void> {
  const groupBy = counted ? `${TASK_USAGE_LABELS_SQL}, status` : TASK_USAGE_LABELS_SQL;
  await tx.run(`
      INSERT INTO usage_retired_totals (repo, job, provider, model, account, outcome, tasks, tokens, cost_usd)
      SELECT ${TASK_USAGE_LABELS_SQL}, ${counted ? "status" : "''"}, ${counted ? "COUNT(*)" : "0"}, COALESCE(SUM(tokens_used), 0), COALESCE(SUM(cost_usd), 0)
      FROM tasks
      WHERE ${where}
      GROUP BY ${groupBy}${RETIRED_UPSERT_SQL}
    `, params);
}

/** Fold the usage of the `sessions` rows matching `where` into `usage_retired_totals` before they are deleted or reset. */
export async function retireSessionUsage(tx: SqlDriver, where: string, params: unknown[]): Promise<void> {
  await tx.run(`
      INSERT INTO usage_retired_totals (repo, job, provider, model, account, outcome, tasks, tokens, cost_usd)
      SELECT ${SESSION_USAGE_LABELS_SQL}, '', 0, COALESCE(SUM(tokens_used), 0), COALESCE(SUM(cost_usd), 0)
      FROM sessions
      WHERE (${where}) AND mode != 'repo-zsh' AND (tokens_used IS NOT NULL OR cost_usd IS NOT NULL)
      GROUP BY COALESCE(repo, ''), COALESCE(provider, 'claude'), COALESCE(model, 'unknown')${RETIRED_UPSERT_SQL}
    `, params);
}

export interface AgentUsageTotal {
  provider: string;
  model: string;
  account: string;
  repo: string;
  job: string;
  tokens: number;
  costUsd: number;
}

/**
 * Lifetime agent tokens and cost by provider, model, account, repo and job:
 * finished `tasks` (running ones relabel as provider and model land, which
 * would read as a counter reset) and live `sessions` rows (not `repo-zsh` shells) plus the ledger of
 * deleted and reset ones, so each total only ever grows.
 */
export async function getAgentUsageTotals(): Promise<AgentUsageTotal[]> {
  return timedDb("agent-usage-totals", async () => {
    const rows = await getDb().all<{ repo: string; job: string; provider: string; model: string; account: string; tokens: number; cost_usd: number }>(`
      SELECT repo, job, provider, model, account, SUM(tokens) AS tokens, SUM(cost_usd) AS cost_usd
      FROM (
        SELECT repo, ${JOB_PREFIX_SQL} AS job, COALESCE(provider_used, 'unknown') AS provider, COALESCE(model_used, 'unknown') AS model,
               COALESCE(account_used, '') AS account, COALESCE(tokens_used, 0) AS tokens, COALESCE(cost_usd, 0) AS cost_usd
        FROM tasks
        WHERE (tokens_used IS NOT NULL OR cost_usd IS NOT NULL) AND status IN ('completed', 'failed')
        UNION ALL
        SELECT COALESCE(repo, '') AS repo, 'interactive-session' AS job, COALESCE(provider, 'claude') AS provider, COALESCE(model, 'unknown') AS model,
               '' AS account, COALESCE(tokens_used, 0) AS tokens, COALESCE(cost_usd, 0) AS cost_usd
        FROM sessions
        WHERE mode != 'repo-zsh' AND (tokens_used IS NOT NULL OR cost_usd IS NOT NULL)
        UNION ALL
        SELECT repo, job, provider, model, account, tokens, cost_usd FROM usage_retired_totals
      ) u
      GROUP BY repo, job, provider, model, account
    `);
    return rows
      .map((r) => ({ provider: r.provider, model: r.model, account: r.account, repo: r.repo, job: r.job, tokens: Number(r.tokens), costUsd: Number(r.cost_usd) }))
      .filter((r) => r.tokens > 0 || r.costUsd > 0);
  });
}

export interface AgentTaskOutcomeTotal {
  job: string;
  outcome: "completed" | "failed";
  tasks: number;
}

/** Lifetime finished tasks by job prefix and outcome, pruned ones included. */
export async function getAgentTaskOutcomeTotals(): Promise<AgentTaskOutcomeTotal[]> {
  return timedDb("agent-task-outcome-totals", async () => {
    const rows = await getDb().all<{ job: string; outcome: "completed" | "failed"; tasks: number }>(`
      SELECT job, outcome, SUM(n) AS tasks
      FROM (
        SELECT ${JOB_PREFIX_SQL} AS job, status AS outcome, COUNT(*) AS n
        FROM tasks
        WHERE status IN ('completed', 'failed')
        GROUP BY ${JOB_PREFIX_SQL}, status
        UNION ALL
        SELECT job, outcome, tasks AS n FROM usage_retired_totals WHERE outcome IN ('completed', 'failed') AND tasks > 0
      ) t
      GROUP BY job, outcome
    `);
    return rows.map((r) => ({ job: r.job, outcome: r.outcome, tasks: Number(r.tasks) }));
  });
}

/** Running tasks by job prefix. */
export async function getRunningTaskCountsByJob(): Promise<Array<{ job: string; count: number }>> {
  return timedDb("running-task-counts", async () => {
    const rows = await getDb().all<{ job: string; n: number }>(`
      SELECT ${JOB_PREFIX_SQL} AS job, COUNT(*) AS n FROM tasks WHERE status = 'running' GROUP BY ${JOB_PREFIX_SQL}
    `);
    return rows.map((r) => ({ job: r.job, count: Number(r.n) }));
  });
}

/** Queued and running `work_queue` rows by kind and status. */
export async function getWorkQueueCounts(): Promise<Array<{ kind: string; status: "queued" | "running"; count: number }>> {
  return timedDb("work-queue-counts", async () => {
    const rows = await getDb().all<{ kind: string; status: "queued" | "running"; n: number }>(`
      SELECT kind, status, COUNT(*) AS n FROM work_queue WHERE status IN ('queued', 'running') GROUP BY kind, status
    `);
    return rows.map((r) => ({ kind: r.kind, status: r.status, count: Number(r.n) }));
  });
}

/** Open `claws_prs` rows (stage not `merged` or `closed`) by stage. */
export async function getOpenClawsPrCountsByStage(): Promise<Array<{ stage: string; count: number }>> {
  return timedDb("open-claws-pr-counts", async () => {
    const rows = await getDb().all<{ stage: string; n: number }>(`
      SELECT stage, COUNT(*) AS n FROM claws_prs WHERE stage NOT IN ('merged', 'closed') GROUP BY stage
    `);
    return rows.map((r) => ({ stage: r.stage, count: Number(r.n) }));
  });
}

/** Provider holds still in force at epoch-ms `nowMs`. */
export async function getActiveProviderHolds(nowMs: number): Promise<ProviderHoldRow[]> {
  return timedDb("active-provider-holds", async () => {
    const rows = await getDb().all<ProviderHoldRow>(`SELECT key, until_ms, reason, updated_at FROM provider_holds WHERE until_ms > ?`, [Math.round(nowMs)]);
    return rows.map((r) => ({ ...r, until_ms: Number(r.until_ms) }));
  });
}

/** Each job prefix's latest finished (`completed` or `failed`) `job_runs` row. */
export async function getJobLastRuns(): Promise<Array<{ job: string; completedAt: string; status: "completed" | "failed" }>> {
  return timedDb("job-last-runs", async () => {
    const rows = await getDb().all<{ job: string; completed_at: string; status: "completed" | "failed" }>(`
      SELECT ${JOB_PREFIX_SQL} AS job, completed_at, status
      FROM job_runs
      WHERE id IN (
        SELECT MAX(id) FROM job_runs
        WHERE status IN ('completed', 'failed') AND completed_at IS NOT NULL
        GROUP BY ${JOB_PREFIX_SQL}
      )
    `);
    return rows.map((r) => ({ job: r.job, completedAt: r.completed_at, status: r.status }));
  });
}
const USAGE_BASE_SQL = `(tokens_used IS NOT NULL OR provider_used IS NOT NULL OR model_used IS NOT NULL)`;
/** The context-growth warning level for a session's last context size. */
export function usageWarningLevel(lastContextTokens: number): SessionUsageWarningLevel {
  if (lastContextTokens >= 180_000) return "critical";
  if (lastContextTokens >= 100_000) return "warn";
  return "none";
}

function usageItemsCte(days: number, filters?: UsageFilters): { cte: string; where: string; params: unknown[] } {
  const cutoffText = nowSqlOffsetMs(-days * DAY_MS);
  const cutoffMs = Date.now() - days * DAY_MS;
  const clauses = ["1 = 1"];
  const params: unknown[] = [cutoffText, cutoffMs];
  if (filters?.repo) { clauses.push(`repo = ?`); params.push(filters.repo); }
  if (filters?.job) { clauses.push(`job_prefix = ?`); params.push(filters.job); }
  if (filters?.provider) { clauses.push(`provider = ?`); params.push(filters.provider); }
  if (filters?.model) { clauses.push(`model = ?`); params.push(filters.model); }
  if (filters?.account) { clauses.push(`account = ?`); params.push(filters.account); }
  return {
    cte: `
      WITH usage_items AS (
        SELECT
          'task' AS item_type,
          id AS task_id,
          run_id,
          NULL AS session_id,
          repo,
          ${JOB_PREFIX_SQL} AS job_prefix,
          COALESCE(provider_used, 'unknown') AS provider,
          COALESCE(account_used, '') AS account,
          COALESCE(model_used, 'unknown') AS model,
          tokens_used,
          cost_usd,
          status,
          outcome,
          started_at,
          completed_at,
          NULL AS last_context_tokens,
          NULL AS session_created_at,
          NULL AS session_ended_at,
          NULL AS cwd
        FROM tasks
        WHERE ${USAGE_BASE_SQL} AND started_at >= ?
        UNION ALL
        SELECT
          'session' AS item_type,
          NULL AS task_id,
          NULL AS run_id,
          id AS session_id,
          COALESCE(repo, cwd) AS repo,
          'interactive-session' AS job_prefix,
          COALESCE(provider, 'claude') AS provider,
          '' AS account,
          COALESCE(model, 'unknown') AS model,
          tokens_used,
          cost_usd,
          NULL AS status,
          NULL AS outcome,
          NULL AS started_at,
          NULL AS completed_at,
          last_context_tokens,
          created_at AS session_created_at,
          ended_at AS session_ended_at,
          cwd
        FROM sessions
        WHERE mode != 'repo-zsh'
          AND (tokens_used IS NOT NULL OR last_context_tokens IS NOT NULL OR provider IS NOT NULL OR model IS NOT NULL)
          AND COALESCE(usage_updated_at, created_at) >= ?
      )
    `,
    where: clauses.join(" AND "),
    params,
  };
}

function taskUsageWhere(days: number, filters?: UsageFilters): { sql: string; params: unknown[] } {
  const clauses = [USAGE_BASE_SQL, `started_at >= ?`];
  const params: unknown[] = [nowSqlOffsetMs(-days * DAY_MS)];
  if (filters?.repo) { clauses.push(`repo = ?`); params.push(filters.repo); }
  if (filters?.job) { clauses.push(`${JOB_PREFIX_SQL} = ?`); params.push(filters.job); }
  if (filters?.provider) { clauses.push(`COALESCE(provider_used, 'unknown') = ?`); params.push(filters.provider); }
  if (filters?.model) { clauses.push(`COALESCE(model_used, 'unknown') = ?`); params.push(filters.model); }
  if (filters?.account) { clauses.push(`COALESCE(account_used, '') = ?`); params.push(filters.account); }
  return { sql: clauses.join(" AND "), params };
}

/** Every task and interactive session in the window matching `filters`, one row each, for the `/usage` pivot. */
export async function getUsageItems(days: number, filters?: UsageFilters): Promise<UsageItem[]> {
  const usage = usageItemsCte(days, filters);
  const rows = await getDb().all(`
    ${usage.cte}
    SELECT item_type, task_id, run_id, session_id, repo, cwd, job_prefix, provider, account, model,
           tokens_used, cost_usd, status, started_at, last_context_tokens, session_created_at, session_ended_at
    FROM usage_items
    WHERE ${usage.where}
  `, [...usage.params]) as Array<{
    item_type: "task" | "session";
    task_id: number | null;
    run_id: string | null;
    session_id: string | null;
    repo: string | null;
    cwd: string | null;
    job_prefix: string;
    provider: string;
    account: string;
    model: string;
    tokens_used: number | null;
    cost_usd: number | null;
    status: string | null;
    started_at: string | null;
    last_context_tokens: number | null;
    session_created_at: number | string | null;
    session_ended_at: number | string | null;
  }>;
  return rows.map((r): UsageItem => {
    const session = r.item_type === "session";
    const createdMs = r.session_created_at == null ? null : Number(r.session_created_at);
    return {
      kind: r.item_type,
      taskId: r.task_id == null ? null : Number(r.task_id),
      runId: r.run_id ?? null,
      sessionId: r.session_id ?? null,
      repo: session && r.repo === r.cwd ? null : r.repo,
      cwd: r.cwd ?? null,
      job: r.job_prefix,
      provider: r.provider,
      account: r.account ?? "",
      model: r.model,
      state: session ? (r.session_ended_at == null ? "Live" : "Ended") : (r.status ?? "unknown"),
      tokens: r.tokens_used == null ? 0 : Number(r.tokens_used),
      costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
      lastContextTokens: session && r.last_context_tokens != null ? Number(r.last_context_tokens) : null,
      day: session
        ? (createdMs != null && Number.isFinite(createdMs) ? new Date(createdMs).toISOString().slice(0, 10) : "unknown")
        : String(r.started_at ?? "unknown").slice(0, 10),
      alive: session && r.session_ended_at == null,
    };
  });
}

export async function getTotalUsage(days: number, filters?: UsageFilters): Promise<UsageTotals> {
  const usage = usageItemsCte(days, filters);
  const row = await getDb().get(`
      ${usage.cte}
      SELECT COUNT(*) AS task_count,
             COALESCE(SUM(tokens_used), 0) AS total_tokens,
             COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM usage_items
      WHERE ${usage.where}
    `, [...usage.params]) as { task_count: number; total_tokens: number; total_cost_usd: number };
  return {
    taskCount: row.task_count,
    totalTokens: row.total_tokens,
    totalCostUsd: row.total_cost_usd,
  };
}

export interface UsageFilterOptions {
  repos: string[];
  jobs: string[];
  providers: string[];
  models: string[];
  /** Claude accounts recorded on tasks in the window. */
  accounts: string[];
}

export async function getUsageFilterOptions(days: number): Promise<UsageFilterOptions> {
  const d = getDb();
  const usage = usageItemsCte(days);
  const repos = (await d.all(`${usage.cte} SELECT DISTINCT repo FROM usage_items WHERE repo IS NOT NULL ORDER BY 1`, usage.params) as Array<{ repo: string }>).map((r) => r.repo);
  const jobs = (await d.all(`${usage.cte} SELECT DISTINCT job_prefix AS job FROM usage_items ORDER BY 1`, usage.params) as Array<{ job: string }>).map((r) => r.job);
  const providers = (await d.all(`${usage.cte} SELECT DISTINCT provider FROM usage_items ORDER BY 1`, usage.params) as Array<{ provider: string }>).map((r) => r.provider);
  const models = (await d.all(`${usage.cte} SELECT DISTINCT model FROM usage_items ORDER BY 1`, usage.params) as Array<{ model: string }>).map((r) => r.model);
  const accounts = (await d.all(`${usage.cte} SELECT DISTINCT account FROM usage_items WHERE account != '' ORDER BY 1`, usage.params) as Array<{ account: string }>).map((r) => r.account);
  return { repos, jobs, providers, models, accounts };
}

export async function getRecentEffectivenessEvents(days: number, filters?: UsageFilters, limit = 25): Promise<RecentEffectivenessEvent[]> {
  const where = taskUsageWhere(days, filters);
  const rows = await getDb().all(`
      SELECT
        tasks.id AS task_id,
        ${JOB_PREFIX_SQL} AS job_name,
        tasks.repo AS repo,
        tasks.item_number AS item_number,
        COALESCE(tasks.provider_used, 'unknown') AS provider,
        COALESCE(tasks.model_used, 'unknown') AS model,
        e.signal AS signal,
        e.score AS score,
        e.source AS source,
        e.source_repo AS source_repo,
        e.source_number AS source_number,
        e.source_sha AS source_sha,
        e.details AS details,
        e.created_at AS created_at
      FROM task_effectiveness_events e
      JOIN tasks ON tasks.id = e.task_id
      WHERE ${where.sql}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ?
    `, [...where.params, limit]) as Array<{
      task_id: number;
      job_name: string;
      repo: string;
      item_number: IssueRef;
      provider: string;
      model: string;
      signal: string;
      score: number | null;
      source: string;
      source_repo: string;
      source_number: number;
      source_sha: string;
      details: string | null;
      created_at: string;
    }>;
  return normalizeItemNumbers(rows).map((r) => ({
    taskId: r.task_id,
    jobName: r.job_name,
    repo: r.repo,
    itemNumber: r.item_number,
    provider: r.provider,
    model: r.model,
    signal: r.signal,
    score: r.score,
    source: r.source,
    sourceRepo: r.source_repo,
    sourceNumber: r.source_number,
    sourceSha: r.source_sha,
    details: r.details,
    createdAt: r.created_at,
  }));
}

// ── Workflow runs (runner metrics) ──

export interface WorkflowRunRow {
  run_id: number;
  repo: string;
  workflow_name: string;
  status: string;
  conclusion: string | null;
  event: string;
  head_branch: string | null;
  created_at: string;
  run_started_at: string | null;
  updated_at: string;
  head_sha: string | null;
  html_url: string | null;
  run_attempt: number | null;
}

export async function upsertWorkflowRuns(runs: WorkflowRunRow[]): Promise<void> {
  if (runs.length === 0) return;
  await getDb().transaction(async (tx) => {
    for (const r of runs) {
      await tx.run(`
        INSERT INTO workflow_runs (run_id, repo, workflow_name, status, conclusion, event, head_branch, created_at, run_started_at, updated_at, head_sha, html_url, run_attempt, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          repo = excluded.repo,
          workflow_name = excluded.workflow_name,
          status = excluded.status,
          conclusion = excluded.conclusion,
          event = excluded.event,
          head_branch = excluded.head_branch,
          created_at = excluded.created_at,
          run_started_at = excluded.run_started_at,
          updated_at = excluded.updated_at,
          head_sha = excluded.head_sha,
          html_url = excluded.html_url,
          run_attempt = excluded.run_attempt,
          synced_at = excluded.synced_at
      `, [r.run_id, r.repo, r.workflow_name, r.status, r.conclusion, r.event, r.head_branch, r.created_at, r.run_started_at, r.updated_at, r.head_sha, r.html_url, r.run_attempt, nowSql()]);
    }
  });
}

export async function getWorkflowRunCount(): Promise<number> {
  const row = await getDb().get(`SELECT COUNT(*) AS cnt FROM workflow_runs`) as { cnt: number };
  return row.cnt;
}

export async function getActiveWorkflowRuns(): Promise<WorkflowRunRow[]> {
  return await getDb().all(`SELECT * FROM workflow_runs WHERE status IN ('queued', 'in_progress') ORDER BY created_at ASC`) as WorkflowRunRow[];
}

export async function hasRecentlyCompletedTasks(minutesAgo: number): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 FROM tasks WHERE status IN ('completed', 'failed') AND completed_at >= ? LIMIT 1`, [nowSqlOffsetMs(-minutesAgo * 60 * 1000)]);
  return row !== undefined;
}

