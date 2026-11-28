// Job runs and their logs: the in-memory job-log buffer and its drain,
// log readers, and log and task pruning. Reached only through the src/db.ts façade.
import * as diagnosticQueries from "../diagnostic-queries.js";
import * as log from "../log.js";
import * as logCore from "../log-core.js";
import { normalizeItemNumbers, type IssueRef } from "../issue-id.js";
import { DAY_MS, driver, getDb, nowSql, nowSqlOffsetMs, refParam, timedDb } from "./core.js";
import type { Task } from "./tasks.js";
import { retireTaskUsage } from "./usage.js";

// ── Job run log capture ──

export interface JobRun {
  run_id: string;
  job_name: string;
  status: string;
  started_at: string;
  completed_at: string | null;
}

export interface JobLog {
  id: number;
  run_id: string;
  level: string;
  message: string;
  logged_at: string;
}

export async function insertJobRun(runId: string, jobName: string): Promise<void> {
  await getDb().run(`INSERT INTO job_runs (run_id, job_name, status, started_at) VALUES (?, ?, 'running', ?)`, [runId, jobName, nowSql()]);
}

export async function completeJobRun(runId: string, status: "completed" | "failed" | "cancelled"): Promise<void> {
  await getDb().run(`UPDATE job_runs SET status = ?, completed_at = ? WHERE run_id = ? AND status != 'cancelled'`, [status, nowSql(), runId]);
}

export async function cancelJobRunIfRunning(runId: string): Promise<boolean> {
  const result = await getDb().run(`UPDATE job_runs SET status = 'cancelled', completed_at = ? WHERE run_id = ? AND status = 'running'`, [nowSql(), runId]);
  return result.changes > 0;
}

interface BufferedJobLog {
  diagnosticReason: string | null;
  diagnosticContext: string;
  runId: string;
  level: string;
  message: string;
  loggedAt: string;
}

/** Bounded so a database outage costs log lines rather than the process's memory. */
const JOB_LOG_BUFFER_LIMIT = 10_000;
const JOB_LOG_BATCH_SIZE = 200;
const JOB_LOG_DRAIN_MS = 250;

/**
 * #3113: a debug line that embedded raw `find` stderr wrote 437 rows of 7.2 MB
 * each before it was bounded upstream (#3039 / PR #3053). Cap every stored
 * `job_logs.message` at write time so no single row can do that again.
 */
export const JOB_LOG_MAX_MESSAGE_CHARS = 32_000;

/**
 * #3113: prune threshold for historical oversized rows, in bytes. Set above
 * the largest row {@link capJobLogMessage} can produce (32,000 UTF-16 units is
 * at most ~96 KB of UTF-8), so capped rows are never pruned.
 */
export const JOB_LOG_PRUNE_MESSAGE_BYTES = 128_000;

/**
 * Truncates `message` to {@link JOB_LOG_MAX_MESSAGE_CHARS} UTF-16 units, appending
 * a marker that states how much was cut. Returns `message` unchanged when it's
 * already at or under the cap. Never splits a surrogate pair at the boundary.
 */
export function capJobLogMessage(message: string): string {
  if (message.length <= JOB_LOG_MAX_MESSAGE_CHARS) return message;
  let cutAt = JOB_LOG_MAX_MESSAGE_CHARS;
  const lastUnit = message.charCodeAt(cutAt - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) cutAt--;
  const remaining = message.length - cutAt;
  return `${message.slice(0, cutAt)}\n… [truncated: ${remaining} more chars]`;
}

const jobLogBuffer: BufferedJobLog[] = [];
let jobLogsDropped = 0;
let jobLogDrainTimer: NodeJS.Timeout | null = null;
let jobLogDrainInFlight = false;

/**
 * Buffers one job log line. Deliberately synchronous and void-returning: every
 * `log.*` call in the service funnels through here, and `src/log.ts` must stay
 * free of awaits. The rows are written by {@link startJobLogDrain}'s timer.
 *
 * Diagnostics here use `log-core.js`, never `log.*` — log.ts calls back into this
 * function, so a `log.warn` would recurse.
 */
export function insertJobLog(runId: string, level: string, message: string, reason?: diagnosticQueries.DiagnosticReason, context?: diagnosticQueries.DiagnosticContext): void {
  if (jobLogBuffer.length >= JOB_LOG_BUFFER_LIMIT) {
    jobLogBuffer.shift();
    jobLogsDropped++;
    if (jobLogsDropped % 1_000 === 1) {
      logCore.warn(`[db] job_logs buffer full — dropped ${jobLogsDropped} log lines`);
    }
  }
  jobLogBuffer.push({ diagnosticContext: JSON.stringify(diagnosticQueries.diagnosticContext(context)), diagnosticReason: diagnosticQueries.diagnosticReason(reason)?.code ?? null, runId, level, message: capJobLogMessage(message), loggedAt: nowSql() });
}

/** Writes one batch of buffered log lines. Returns false when there was nothing to write. */
async function drainJobLogBatch(): Promise<boolean> {
  if (jobLogBuffer.length === 0 || !driver) return false;
  const batch = jobLogBuffer.splice(0, JOB_LOG_BATCH_SIZE);
  const values = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
  const params: unknown[] = [];
  for (const entry of batch) params.push(entry.runId, entry.level, entry.message, entry.loggedAt, entry.diagnosticReason, entry.diagnosticContext);
  try {
    await getDb().run(`INSERT INTO job_logs (run_id, level, message, logged_at, diagnostic_reason, diagnostic_context) VALUES ${values}`, params);
  } catch (err) {
    // Matches the pre-buffer behaviour: a DB error must never interrupt the job
    // that emitted the line. log-core.js has no job_logs sink; log.error would recurse here.
    logCore.error(`[db] job_logs insert failed: ${err}`);
    // Requeue so a transient failure costs a retry on the next drain tick rather
    // than silently dropping the batch; bounded so a persistent outage still
    // costs log lines rather than memory.
    const room = JOB_LOG_BUFFER_LIMIT - jobLogBuffer.length;
    if (room > 0) jobLogBuffer.unshift(...batch.slice(0, room));
    return false;
  }
  return true;
}

/** Empties the buffer and its dropped-line count; {@link initDb} calls it on open. */
export function resetJobLogBuffer(): void {
  jobLogBuffer.length = 0;
  jobLogsDropped = 0;
}

/** Stops the drain timer; {@link closeDb} calls it before the final flush. */
export function stopJobLogDrain(): void {
  if (jobLogDrainTimer) {
    clearInterval(jobLogDrainTimer);
    jobLogDrainTimer = null;
  }
}

export function startJobLogDrain(): void {
  if (jobLogDrainTimer) return;
  jobLogDrainTimer = setInterval(() => {
    if (jobLogDrainInFlight) return;
    jobLogDrainInFlight = true;
    void drainJobLogBatch().finally(() => {
      jobLogDrainInFlight = false;
    });
  }, JOB_LOG_DRAIN_MS);
  jobLogDrainTimer.unref();
}

/** Flushes every buffered log line. Read paths call this so the dashboard's log
 *  tail never misses lines that are still sitting in the buffer. */
export async function flushJobLogs(): Promise<void> {
  while (await drainJobLogBatch());
}

/** One job log line as an agent pod ships it (`db-remote.ts`'s buffer). */
export interface JobLogRowInput {
  level: string;
  message: string;
  loggedAt: string;
  diagnosticReason: string | null;
  diagnosticContext: string;
}

/**
 * Writes an agent pod's batch of job log lines for `runId` directly, bypassing
 * this process's buffer: the pod buffers and batches on its side.
 */
export async function insertJobLogRows(runId: string, rows: readonly JobLogRowInput[]): Promise<void> {
  for (let i = 0; i < rows.length; i += JOB_LOG_BATCH_SIZE) {
    const batch = rows.slice(i, i + JOB_LOG_BATCH_SIZE);
    const values = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params: unknown[] = [];
    for (const entry of batch) params.push(runId, entry.level, capJobLogMessage(entry.message), entry.loggedAt, entry.diagnosticReason, entry.diagnosticContext);
    await getDb().run(`INSERT INTO job_logs (run_id, level, message, logged_at, diagnostic_reason, diagnostic_context) VALUES ${values}`, params);
  }
}

export async function getJobRunLogs(runId: string): Promise<JobLog[]> {
  await flushJobLogs();
  return await getDb().all(`SELECT id, run_id, level, message, logged_at FROM job_logs WHERE run_id = ? ORDER BY id ASC`, [runId]) as JobLog[];
}

export async function getJobRunLogsSince(runId: string, afterId: number): Promise<JobLog[]> {
  await flushJobLogs();
  return await getDb().all(`SELECT id, run_id, level, message, logged_at FROM job_logs WHERE run_id = ? AND id > ? ORDER BY id ASC`, [runId, afterId]) as JobLog[];
}

export async function getLatestRunIdsByJob(): Promise<Map<string, { runId: string; status: string; startedAt: string; completedAt: string | null }>> {
  const rows = await getDb().all(`SELECT job_name, run_id, status, started_at, completed_at FROM job_runs WHERE id IN (SELECT MAX(id) FROM job_runs GROUP BY job_name)`) as Array<{ job_name: string; run_id: string; status: string; started_at: string; completed_at: string | null }>;
  const map = new Map<string, { runId: string; status: string; startedAt: string; completedAt: string | null }>();
  for (const row of rows) {
    map.set(row.job_name, { runId: row.run_id, status: row.status, startedAt: row.started_at, completedAt: row.completed_at });
  }
  return map;
}

export async function getJobRun(runId: string): Promise<JobRun | undefined> {
  return await getDb().get(`SELECT run_id, job_name, status, started_at, completed_at FROM job_runs WHERE run_id = ?`, [runId]) as JobRun | undefined;
}

export async function getTasksByRunId(runId: string): Promise<Task[]> {
  return normalizeItemNumbers(await getDb().all(`SELECT * FROM tasks WHERE run_id = ? ORDER BY id ASC`, [runId]) as Task[]);
}

export async function getWorkItemsForRuns(runIds: string[]): Promise<Map<string, Task[]>> {
  if (runIds.length === 0) return new Map();
  const placeholders = runIds.map(() => "?").join(",");
  const rows = normalizeItemNumbers(await getDb().all(`SELECT * FROM tasks WHERE run_id IN (${placeholders}) ORDER BY id ASC`, [...runIds]) as Task[]);
  const map = new Map<string, Task[]>();
  for (const row of rows) {
    if (!row.run_id) continue;
    const list = map.get(row.run_id) ?? [];
    list.push(row);
    map.set(row.run_id, list);
  }
  return map;
}

export async function getRunsForIssue(repo: string, itemNumber: IssueRef): Promise<JobRun[]> {
  return await getDb().all(`
      SELECT DISTINCT jr.run_id, jr.job_name, jr.status, jr.started_at, jr.completed_at
      FROM job_runs jr
      INNER JOIN tasks t ON t.run_id = jr.run_id
      WHERE t.repo = ? AND t.item_number = ?
      ORDER BY jr.started_at DESC
    `, [repo, refParam(itemNumber)]) as JobRun[];
}

export async function getLogsForRuns(runIds: string[]): Promise<Map<string, JobLog[]>> {
  if (runIds.length === 0) return new Map();
  await flushJobLogs();
  const placeholders = runIds.map(() => "?").join(",");
  const rows = await getDb().all(`SELECT id, run_id, level, message, logged_at FROM job_logs WHERE run_id IN (${placeholders}) ORDER BY id ASC`, [...runIds]) as JobLog[];
  const map = new Map<string, JobLog[]>();
  for (const row of rows) {
    const list = map.get(row.run_id) ?? [];
    list.push(row);
    map.set(row.run_id, list);
  }
  return map;
}
export async function pruneOldLogs(retentionDays: number, keepPerJob = 20): Promise<number> {
  return timedDb("prune-old-logs", () => pruneOldLogsUntimed(retentionDays, keepPerJob));
}

async function pruneOldLogsUntimed(retentionDays: number, keepPerJob = 20): Promise<number> {
  const d = getDb();
  const result = await d.run(`
    DELETE FROM job_runs
    WHERE started_at < ?
    AND id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY job_name ORDER BY started_at DESC) AS rn
        FROM job_runs
      ) WHERE rn <= ?
    )
  `, [nowSqlOffsetMs(-retentionDays * DAY_MS), keepPerJob]);
  await d.run(`DELETE FROM job_logs WHERE run_id NOT IN (SELECT run_id FROM job_runs)`);
  const sizeResult = await d.run(`DELETE FROM job_logs WHERE octet_length(message) > ?`, [JOB_LOG_PRUNE_MESSAGE_BYTES]);
  if (sizeResult.changes > 0) {
    logCore.info(`[db] pruned ${sizeResult.changes} oversized job_logs row(s)`);
  }
  return result.changes;
}

/**
 * Delete terminal task rows older than the retention period. Never deletes
 * `running` rows — startup orphan recovery (`getOrphanedTasks`) depends on them.
 * Rows whose `run_id` still exists in `job_runs` are kept so the dashboard's
 * retained run pages (`getTasksByRunId`) don't render with an empty task list.
 */
export async function pruneTasks(retentionDays = 90): Promise<number> {
  return timedDb("prune-tasks", () => pruneTasksUntimed(retentionDays));
}

async function pruneTasksUntimed(retentionDays = 90): Promise<number> {
  const where = `status IN ('completed', 'failed')
        AND COALESCE(completed_at, started_at) < ?
        AND (run_id IS NULL OR run_id NOT IN (SELECT run_id FROM job_runs))`;
  const params = [nowSqlOffsetMs(-retentionDays * DAY_MS)];
  return await getDb().transaction(async (tx) => {
    // Fold first, so the agent usage and task counters keep what is deleted.
    await retireTaskUsage(tx, where, params, true);
    const result = await tx.run(`DELETE FROM tasks WHERE ${where}`, params);
    return Number(result.changes);
  });
}

