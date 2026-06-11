import Database from "better-sqlite3";
import { DB_PATH } from "./config.js";
import * as log from "./log.js";
import { buildFailureOutcome } from "./outcome.js";

let db: Database.Database | null = null;

export function initDb(): void {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name      TEXT NOT NULL,
      repo          TEXT NOT NULL,
      item_number   INTEGER NOT NULL,
      trigger_label TEXT,
      worktree_path TEXT,
      branch_name   TEXT,
      status        TEXT NOT NULL DEFAULT 'running',
      error         TEXT,
      started_at    TEXT NOT NULL,
      completed_at  TEXT
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)
  `);

  // Migration: add run_id column to tasks (links tasks to job_runs)
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN run_id TEXT`);
  } catch {
    // Column already exists — safe to ignore
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON tasks(run_id)`);

  // Migration: add outcome column to tasks (structured outcome metadata)
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN outcome TEXT`);
  } catch {
    // Column already exists — safe to ignore
  }

  // Migration: add model_used column to tasks (tracks which Claude model was used)
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN model_used TEXT`);
  } catch {
    // Column already exists — safe to ignore
  }

  // Migration: add provider_used column to tasks (tracks which AI provider was used)
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN provider_used TEXT`);
  } catch {
    // Column already exists — safe to ignore
  }

  // Migration: add token and cost tracking columns
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN tokens_used INTEGER`);
  } catch {
    // Column already exists — safe to ignore
  }
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN cost_usd REAL`);
  } catch {
    // Column already exists — safe to ignore
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS job_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT NOT NULL UNIQUE,
      job_name     TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'running',
      started_at   TEXT NOT NULL,
      completed_at TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_job_runs_job_name ON job_runs(job_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_job_runs_started_at ON job_runs(started_at)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS job_logs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    TEXT NOT NULL,
      level     TEXT NOT NULL,
      message   TEXT NOT NULL,
      logged_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_job_logs_run_id ON job_logs(run_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      total_items INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_snapshots_recorded_at ON queue_snapshots(recorded_at)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_queue (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind          TEXT NOT NULL,
      repo          TEXT NOT NULL,
      item_number   INTEGER NOT NULL,
      args_json     TEXT NOT NULL DEFAULT '{}',
      priority      INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'queued',
      pid           INTEGER,
      attempts      INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      enqueued_at   TEXT NOT NULL DEFAULT (datetime('now')),
      started_at    TEXT,
      completed_at  TEXT,
      run_id        TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_work_queue_dispatch ON work_queue(status, priority DESC, id ASC)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_queue_active ON work_queue(kind, repo, item_number) WHERE status IN ('queued', 'running')`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id         INTEGER PRIMARY KEY,
      repo           TEXT NOT NULL,
      workflow_name  TEXT NOT NULL,
      status         TEXT NOT NULL,
      conclusion     TEXT,
      event          TEXT NOT NULL,
      head_branch    TEXT,
      created_at     TEXT NOT NULL,
      run_started_at TEXT,
      updated_at     TEXT NOT NULL,
      synced_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_repo ON workflow_runs(repo)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_created_at ON workflow_runs(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_synced_at ON workflow_runs(synced_at)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id             TEXT PRIMARY KEY,
      tmux_name      TEXT NOT NULL,
      mode           TEXT NOT NULL,
      repo           TEXT,
      cwd            TEXT NOT NULL,
      worktree_path  TEXT,
      created_at     INTEGER NOT NULL
    )
  `);
  try { db.exec(`ALTER TABLE sessions ADD COLUMN summary TEXT`); } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN summary_updated_at INTEGER`); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type  TEXT NOT NULL,
      detail      TEXT,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS verification_reports (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      payload    TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_verification_reports_ts ON verification_reports(ts)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_repos_daily (
      job_name      TEXT NOT NULL,
      repo          TEXT NOT NULL,
      local_date    TEXT NOT NULL,
      processed_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (job_name, repo, local_date)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_processed_repos_daily_date ON processed_repos_daily(local_date)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ha_upgrader_state (
      entity_id      TEXT PRIMARY KEY,
      version        TEXT NOT NULL,
      first_seen_at  INTEGER NOT NULL,
      attempted_at   INTEGER NOT NULL DEFAULT 0,
      failure_count  INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ha_deploy_watcher_state (
      addon_slug          TEXT PRIMARY KEY,
      last_notified_sha   TEXT NOT NULL,
      last_seen_at        INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS notified_untrusted_actors (
      repo          TEXT NOT NULL,
      issue_number  INTEGER NOT NULL,
      notified_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (repo, issue_number)
    )
  `);

  // One-off cleanup (#1505): drop stale github-actions[bot] CI-alert rows that
  // predate the broad CI-bot exemption. These were never genuine disallowed
  // human actors. Safe to re-run on every startup: it only ever matches these
  // fixed bot-issue identities, which the dispatcher now skips silently and so
  // will never re-insert.
  const staleBotUntrustedRows: Array<[string, number]> = [
    ["St-John-Software/TempoStatusBar", 133],
    ["St-John-Software/bonkus", 1129],
    ["St-John-Software/vr-rooms", 412],
    ["St-John-Software/namey", 1429],
    ["St-John-Software/namey", 1462],
    ["St-John-Software/namey", 1463],
  ];
  const deleteStaleBotUntrusted = db.prepare(
    `DELETE FROM notified_untrusted_actors WHERE repo = ? AND issue_number = ?`,
  );
  for (const [r, n] of staleBotUntrustedRows) deleteStaleBotUntrusted.run(r, n);

  log.info("Database initialized");
}

export interface TaskOutcome {
  commits?: number;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  prNumber?: number;
  prAction?: "created" | "updated" | "reviewed" | "skipped";
  failureCategory?: string;
}

export interface Task {
  id: number;
  job_name: string;
  repo: string;
  item_number: number;
  trigger_label: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  run_id: string | null;
  status: string;
  error: string | null;
  outcome: string | null;
  model_used: string | null;
  provider_used: string | null;
  tokens_used: number | null;
  cost_usd: number | null;
  started_at: string;
  completed_at: string | null;
}

function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized — call initDb() first");
  return db;
}

let runIdProvider: (() => string | undefined) | null = null;

export function setRunIdProvider(provider: () => string | undefined): void {
  runIdProvider = provider;
}

export function recordTaskStart(
  jobName: string,
  repo: string,
  itemNumber: number,
  triggerLabel: string | null,
): number {
  const currentRunId = runIdProvider?.() ?? null;
  const stmt = getDb().prepare(`
    INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at)
    VALUES (?, ?, ?, ?, ?, 'running', datetime('now'))
  `);
  const result = stmt.run(jobName, repo, itemNumber, triggerLabel, currentRunId);
  return Number(result.lastInsertRowid);
}

export function updateTaskWorktree(
  taskId: number,
  worktreePath: string,
  branchName: string,
): void {
  getDb()
    .prepare(`UPDATE tasks SET worktree_path = ?, branch_name = ? WHERE id = ?`)
    .run(worktreePath, branchName, taskId);
}

export function updateTaskModel(taskId: number, model: string): void {
  getDb()
    .prepare(`UPDATE tasks SET model_used = ? WHERE id = ?`)
    .run(model, taskId);
}

export function updateTaskProvider(taskId: number, provider: string): void {
  getDb()
    .prepare(`UPDATE tasks SET provider_used = ? WHERE id = ?`)
    .run(provider, taskId);
}

export function updateTaskTokenUsage(taskId: number, tokensUsed: number, costUsd: number): void {
  getDb()
    .prepare(`UPDATE tasks SET tokens_used = ?, cost_usd = ? WHERE id = ?`)
    .run(tokensUsed, costUsd, taskId);
}

export function getLastUsedByProvider(): Record<string, string | null> {
  const rows = getDb()
    .prepare(`
      SELECT provider_used, MAX(completed_at) as last_used
      FROM tasks
      WHERE provider_used IS NOT NULL AND completed_at IS NOT NULL
      GROUP BY provider_used
    `)
    .all() as Array<{ provider_used: string; last_used: string }>;
  const result: Record<string, string | null> = { claude: null, codex: null, opencode: null };
  for (const row of rows) {
    result[row.provider_used] = row.last_used;
  }
  return result;
}

export function recordTaskComplete(taskId: number, outcome?: TaskOutcome): void {
  const outcomeJson = outcome ? JSON.stringify(outcome) : null;
  getDb()
    .prepare(
      `UPDATE tasks SET status = 'completed', outcome = ?, completed_at = datetime('now') WHERE id = ?`,
    )
    .run(outcomeJson, taskId);
}

export function recordTaskFailed(taskId: number, error: string, outcome?: TaskOutcome): void {
  const outcomeJson = outcome ? JSON.stringify(outcome) : null;
  getDb()
    .prepare(
      `UPDATE tasks SET status = 'failed', error = ?, outcome = ?, completed_at = datetime('now') WHERE id = ?`,
    )
    .run(error, outcomeJson, taskId);
}

/**
 * Wraps a function with task lifecycle recording: records task start, invokes
 * the inner function with the new task ID, and on error records failure (with a
 * categorized outcome from {@link buildFailureOutcome}) before re-throwing.
 *
 * The inner function is responsible for calling {@link recordTaskComplete} along
 * its success paths — completion is left to the caller because outcomes vary
 * across paths (e.g. early returns, "no commits", PR-created, branch-deleted).
 */
export async function withTaskRecording<T>(
  jobName: string,
  repo: string,
  itemNumber: number,
  triggerLabel: string | null,
  fn: (taskId: number) => Promise<T>,
): Promise<T> {
  const taskId = recordTaskStart(jobName, repo, itemNumber, triggerLabel);
  try {
    return await fn(taskId);
  } catch (err) {
    recordTaskFailed(taskId, String(err), buildFailureOutcome(err));
    throw err;
  }
}

export function getOrphanedTasks(): Task[] {
  return getDb()
    .prepare(`SELECT * FROM tasks WHERE status = 'running'`)
    .all() as Task[];
}

export function getRunningTasks(): Task[] {
  return getDb()
    .prepare(`SELECT * FROM tasks WHERE status = 'running' ORDER BY started_at ASC`)
    .all() as Task[];
}

// ── Smart scheduling ledger ──

export function markRepoProcessedDaily(jobName: string, repo: string, localDate: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO processed_repos_daily (job_name, repo, local_date) VALUES (?, ?, ?)`)
    .run(jobName, repo, localDate);
}

/**
 * Atomically records that we Slack-notified about an untrusted-actor dispatch
 * skip for this issue. Returns true if this is the FIRST time (row inserted) —
 * the caller should send the Slack message. Returns false if a row already
 * existed — the caller should stay silent. Durable across process restarts,
 * unlike an in-memory Set, so a still-ignored issue is notified at most once ever.
 */
export function markUntrustedActorNotified(repo: string, issueNumber: number): boolean {
  const result = getDb()
    .prepare(`INSERT OR IGNORE INTO notified_untrusted_actors (repo, issue_number) VALUES (?, ?)`)
    .run(repo, issueNumber);
  return result.changes === 1;
}

/** Returns a map of repo → most-recent `processed_at` (epoch ms) for the given job.
 *  SQLite stores `datetime('now')` as `"YYYY-MM-DD HH:MM:SS"` in UTC; we convert to
 *  epoch ms by appending `T` + `Z` so JS Date.parse treats it as UTC. */
export function getLastProcessedTimestampsForJob(jobName: string): Map<string, number> {
  const rows = getDb()
    .prepare(`SELECT repo, MAX(processed_at) AS ts FROM processed_repos_daily WHERE job_name = ? GROUP BY repo`)
    .all(jobName) as { repo: string; ts: string }[];
  const map = new Map<string, number>();
  for (const r of rows) {
    if (!r.ts) continue;
    const epochMs = Date.parse(r.ts.replace(" ", "T") + "Z");
    if (!Number.isNaN(epochMs)) map.set(r.repo, epochMs);
  }
  return map;
}

export function pruneProcessedReposDailyOlderThan(daysToKeep: number): number {
  const result = getDb()
    .prepare(`DELETE FROM processed_repos_daily WHERE local_date < date('now', '-' || ? || ' days')`)
    .run(daysToKeep);
  return result.changes;
}

// ── Work queue (durable agent dispatch) ──

export interface WorkQueueRow {
  id: number;
  kind: string;
  repo: string;
  item_number: number;
  args_json: string;
  priority: number;
  status: string;
  pid: number | null;
  attempts: number;
  error_message: string | null;
  enqueued_at: string;
  started_at: string | null;
  completed_at: string | null;
  run_id: string | null;
}

export interface EnqueueResult {
  id: number;
  alreadyQueued: boolean;
}

export function enqueueWork(
  kind: string,
  repo: string,
  itemNumber: number,
  opts: { priority?: boolean; args?: Record<string, unknown> } = {},
): EnqueueResult | null {
  const priority = opts.priority ? 1 : 0;
  const argsJson = JSON.stringify(opts.args ?? {});
  const result = getDb()
    .prepare(`
      INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, enqueued_at)
      VALUES (?, ?, ?, ?, ?, 'queued', datetime('now'))
      ON CONFLICT(kind, repo, item_number) WHERE status IN ('queued', 'running') DO NOTHING
    `)
    .run(kind, repo, itemNumber, argsJson, priority);
  if (result.changes === 1) {
    return { id: Number(result.lastInsertRowid), alreadyQueued: false };
  }
  // No insert — the row already exists in queued/running state. Return its id.
  const existing = getDb()
    .prepare(`SELECT id FROM work_queue WHERE kind = ? AND repo = ? AND item_number = ? AND status IN ('queued', 'running') LIMIT 1`)
    .get(kind, repo, itemNumber) as { id: number } | undefined;
  return existing ? { id: existing.id, alreadyQueued: true } : null;
}

export function claimNextWork(runId: string | null): WorkQueueRow | null {
  const d = getDb();
  const tx = d.transaction(() => {
    const row = d.prepare(`
      SELECT * FROM work_queue
      WHERE status = 'queued'
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `).get() as WorkQueueRow | undefined;
    if (!row) return null;
    d.prepare(`
      UPDATE work_queue
      SET status = 'running',
          pid = ?,
          started_at = datetime('now'),
          attempts = attempts + 1,
          run_id = ?
      WHERE id = ?
    `).run(process.pid, runId, row.id);
    return d.prepare(`SELECT * FROM work_queue WHERE id = ?`).get(row.id) as WorkQueueRow;
  });
  return tx();
}

export function markWorkSucceeded(id: number): void {
  getDb()
    .prepare(`UPDATE work_queue SET status = 'completed', completed_at = datetime('now'), error_message = NULL WHERE id = ?`)
    .run(id);
}

export function markWorkFailed(id: number, errorMessage: string): void {
  getDb()
    .prepare(`UPDATE work_queue SET status = 'failed', completed_at = datetime('now'), error_message = ? WHERE id = ?`)
    .run(errorMessage.slice(0, 4000), id);
}

export function listQueuedWork(limit = 200): WorkQueueRow[] {
  return getDb()
    .prepare(`
      SELECT * FROM work_queue
      WHERE status IN ('queued', 'running')
      ORDER BY status DESC, priority DESC, id ASC
      LIMIT ?
    `)
    .all(limit) as WorkQueueRow[];
}

export function countWorkByStatus(): Record<string, number> {
  const rows = getDb()
    .prepare(`SELECT status, COUNT(*) as cnt FROM work_queue GROUP BY status`)
    .all() as Array<{ status: string; cnt: number }>;
  const result: Record<string, number> = {};
  for (const r of rows) result[r.status] = r.cnt;
  return result;
}

/** Count running+queued work_queue rows whose `kind` is NOT in the excluded set.
 *  Used by smart-schedule to ignore long-running PR work when deciding whether
 *  the system is "busy". */
export function countActiveWorkExcludingKinds(excludedKinds: string[]): number {
  if (excludedKinds.length === 0) {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS cnt FROM work_queue WHERE status IN ('queued', 'running')`)
      .get() as { cnt: number };
    return row.cnt;
  }
  const placeholders = excludedKinds.map(() => "?").join(",");
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS cnt FROM work_queue WHERE status IN ('queued', 'running') AND kind NOT IN (${placeholders})`)
    .get(...excludedKinds) as { cnt: number };
  return row.cnt;
}

export function recoverWorkOnStartup(): { resetRunning: number } {
  const result = getDb()
    .prepare(`
      UPDATE work_queue
      SET status = 'queued', pid = NULL, started_at = NULL
      WHERE status = 'running' AND (pid IS NULL OR pid != ?)
    `)
    .run(process.pid);
  return { resetRunning: Number(result.changes) };
}

export function pruneWorkQueue(retentionHours = 168): number {
  const result = getDb()
    .prepare(`
      DELETE FROM work_queue
      WHERE status IN ('completed', 'failed', 'cancelled')
        AND completed_at < datetime('now', '-' || ? || ' hours')
    `)
    .run(retentionHours);
  return Number(result.changes);
}

/** Active = currently running. Used by auto-merger sweep to skip PRs being modified. */
export function hasActiveWorkForPR(repo: string, prNumber: number, kinds: string[]): boolean {
  if (kinds.length === 0) return false;
  const placeholders = kinds.map(() => "?").join(",");
  const row = getDb()
    .prepare(`
      SELECT 1 FROM work_queue
      WHERE status = 'running'
        AND repo = ?
        AND item_number = ?
        AND kind IN (${placeholders})
      LIMIT 1
    `)
    .get(repo, prNumber, ...kinds);
  return row !== undefined;
}

/** @internal — for tests only */
export function clearAllWorkQueueForTests(): void {
  getDb().prepare(`DELETE FROM work_queue`).run();
}

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

export function insertJobRun(runId: string, jobName: string): void {
  getDb()
    .prepare(
      `INSERT INTO job_runs (run_id, job_name, status, started_at) VALUES (?, ?, 'running', datetime('now'))`,
    )
    .run(runId, jobName);
}

export function completeJobRun(runId: string, status: "completed" | "failed" | "cancelled"): void {
  getDb()
    .prepare(
      `UPDATE job_runs SET status = ?, completed_at = datetime('now') WHERE run_id = ? AND status != 'cancelled'`,
    )
    .run(status, runId);
}

export function cancelJobRunIfRunning(runId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE job_runs SET status = 'cancelled', completed_at = datetime('now') WHERE run_id = ? AND status = 'running'`,
    )
    .run(runId);
  return result.changes > 0;
}

let insertLogStmt: Database.Statement | null = null;

export function insertJobLog(runId: string, level: string, message: string): void {
  const d = getDb();
  if (!insertLogStmt) {
    insertLogStmt = d.prepare(
      `INSERT INTO job_logs (run_id, level, message, logged_at) VALUES (?, ?, ?, datetime('now'))`,
    );
  }
  insertLogStmt.run(runId, level, message);
}

export function getRecentJobRuns(limit = 50, jobFilter?: string): JobRun[] {
  if (jobFilter) {
    return getDb()
      .prepare(`SELECT run_id, job_name, status, started_at, completed_at FROM job_runs WHERE job_name = ? ORDER BY started_at DESC LIMIT ?`)
      .all(jobFilter, limit) as JobRun[];
  }
  return getDb()
    .prepare(`SELECT run_id, job_name, status, started_at, completed_at FROM job_runs ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as JobRun[];
}

export function getDistinctJobNames(): string[] {
  return getDb()
    .prepare(`SELECT DISTINCT job_name FROM job_runs ORDER BY job_name`)
    .all()
    .map((r: any) => r.job_name);
}

export function getJobRunLogs(runId: string): JobLog[] {
  return getDb()
    .prepare(`SELECT id, run_id, level, message, logged_at FROM job_logs WHERE run_id = ? ORDER BY id ASC`)
    .all(runId) as JobLog[];
}

export function getJobRunLogsSince(runId: string, afterId: number): JobLog[] {
  return getDb()
    .prepare(`SELECT id, run_id, level, message, logged_at FROM job_logs WHERE run_id = ? AND id > ? ORDER BY id ASC`)
    .all(runId, afterId) as JobLog[];
}

export function getLatestRunIdsByJob(): Map<string, { runId: string; status: string; startedAt: string; completedAt: string | null }> {
  const rows = getDb()
    .prepare(`SELECT job_name, run_id, status, started_at, completed_at FROM job_runs WHERE id IN (SELECT MAX(id) FROM job_runs GROUP BY job_name)`)
    .all() as Array<{ job_name: string; run_id: string; status: string; started_at: string; completed_at: string | null }>;
  const map = new Map<string, { runId: string; status: string; startedAt: string; completedAt: string | null }>();
  for (const row of rows) {
    map.set(row.job_name, { runId: row.run_id, status: row.status, startedAt: row.started_at, completedAt: row.completed_at });
  }
  return map;
}

export function getJobRun(runId: string): JobRun | undefined {
  return getDb()
    .prepare(`SELECT run_id, job_name, status, started_at, completed_at FROM job_runs WHERE run_id = ?`)
    .get(runId) as JobRun | undefined;
}

export function getTasksByRunId(runId: string): Task[] {
  return getDb()
    .prepare(`SELECT * FROM tasks WHERE run_id = ? ORDER BY id ASC`)
    .all(runId) as Task[];
}

export function getWorkItemsForRuns(runIds: string[]): Map<string, Task[]> {
  if (runIds.length === 0) return new Map();
  const placeholders = runIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT * FROM tasks WHERE run_id IN (${placeholders}) ORDER BY id ASC`)
    .all(...runIds) as Task[];
  const map = new Map<string, Task[]>();
  for (const row of rows) {
    if (!row.run_id) continue;
    const list = map.get(row.run_id) ?? [];
    list.push(row);
    map.set(row.run_id, list);
  }
  return map;
}

export function getRecentWorkItems(limit = 10): Array<{ repo: string; item_number: number }> {
  return getDb()
    .prepare(`
      SELECT repo, item_number, MAX(started_at) AS last_seen
      FROM tasks
      WHERE item_number > 0
      GROUP BY repo, item_number
      ORDER BY last_seen DESC
      LIMIT ?
    `)
    .all(limit) as Array<{ repo: string; item_number: number }>;
}

export function getRunsForIssue(repo: string, itemNumber: number): JobRun[] {
  return getDb()
    .prepare(`
      SELECT DISTINCT jr.run_id, jr.job_name, jr.status, jr.started_at, jr.completed_at
      FROM job_runs jr
      INNER JOIN tasks t ON t.run_id = jr.run_id
      WHERE t.repo = ? AND t.item_number = ?
      ORDER BY jr.started_at DESC
    `)
    .all(repo, itemNumber) as JobRun[];
}

export function getLogsForRuns(runIds: string[]): Map<string, JobLog[]> {
  if (runIds.length === 0) return new Map();
  const placeholders = runIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT id, run_id, level, message, logged_at FROM job_logs WHERE run_id IN (${placeholders}) ORDER BY id ASC`)
    .all(...runIds) as JobLog[];
  const map = new Map<string, JobLog[]>();
  for (const row of rows) {
    const list = map.get(row.run_id) ?? [];
    list.push(row);
    map.set(row.run_id, list);
  }
  return map;
}

export function searchRunsByItem(search: string, limit = 50): JobRun[] {
  const hashMatch = search.match(/^(.+)#(\d+)$/);
  if (hashMatch) {
    const [, repoPart, numberPart] = hashMatch;
    return getDb()
      .prepare(`
        SELECT DISTINCT jr.run_id, jr.job_name, jr.status, jr.started_at, jr.completed_at
        FROM job_runs jr
        INNER JOIN tasks t ON t.run_id = jr.run_id
        WHERE t.repo LIKE ? AND CAST(t.item_number AS TEXT) = ?
        ORDER BY jr.started_at DESC LIMIT ?
      `)
      .all(`%${repoPart}%`, numberPart, limit) as JobRun[];
  }

  return getDb()
    .prepare(`
      SELECT DISTINCT jr.run_id, jr.job_name, jr.status, jr.started_at, jr.completed_at
      FROM job_runs jr
      INNER JOIN tasks t ON t.run_id = jr.run_id
      WHERE t.repo LIKE ? OR CAST(t.item_number AS TEXT) = ?
      ORDER BY jr.started_at DESC LIMIT ?
    `)
    .all(`%${search}%`, search, limit) as JobRun[];
}

export function countRecentTimeouts(repo: string, itemNumber: number, windowMs: number = 2 * 60 * 60 * 1000): number {
  // Format cutoff to match SQLite's datetime() format (YYYY-MM-DD HH:MM:SS)
  const cutoff = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS cnt FROM tasks
       WHERE repo = ? AND item_number = ? AND status = 'failed'
       AND error LIKE '%timed out%'
       AND completed_at > ?`,
    )
    .get(repo, itemNumber, cutoff) as { cnt: number };
  return row.cnt;
}

export function countRecentMemoryLimits(repo: string, itemNumber: number, windowMs: number = 2 * 60 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS cnt FROM tasks
       WHERE repo = ? AND item_number = ? AND status = 'failed'
       AND error LIKE '%exceeded memory limit%'
       AND completed_at > ?`,
    )
    .get(repo, itemNumber, cutoff) as { cnt: number };
  return row.cnt;
}

export function countRecentNoCommitCompletions(
  repo: string,
  itemNumber: number,
  windowMs: number = 6 * 60 * 60 * 1000,
): number {
  const cutoff = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS cnt FROM tasks
       WHERE job_name = 'issue-worker'
       AND repo = ? AND item_number = ? AND status = 'completed'
       AND json_extract(outcome, '$.commits') = 0
       AND json_extract(outcome, '$.prNumber') IS NULL
       AND completed_at > ?
       AND completed_at > COALESCE(
         (SELECT MAX(completed_at) FROM tasks
          WHERE job_name = 'issue-worker'
          AND repo = ? AND item_number = ? AND status = 'completed'
          AND json_extract(outcome, '$.prNumber') IS NOT NULL),
         '1970-01-01')`,
    )
    .get(repo, itemNumber, cutoff, repo, itemNumber) as { cnt: number };
  return row.cnt;
}

export function hasPreviousCiFixerTasks(repo: string, prNumber: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM tasks WHERE job_name = 'ci-fixer' AND repo = ? AND item_number = ? AND status = 'completed' LIMIT 1`,
    )
    .get(repo, prNumber);
  return row !== undefined;
}

/**
 * Count CI fixer attempts for a PR within a time window.
 * Returns counts for total attempts, failed attempts, and successful attempts.
 */
export function countCIFixerAttempts(
  repo: string,
  prNumber: number,
  windowMs: number = 24 * 60 * 60 * 1000, // 24 hours default
): { total: number; failed: number; successful: number; transientApiFailed: number } {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const result = getDb()
    .prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as successful,
        COALESCE(SUM(CASE WHEN status = 'failed' AND json_extract(outcome, '$.failureCategory') = 'transient-api' THEN 1 ELSE 0 END), 0) as transientApiFailed
      FROM tasks
      WHERE (job_name = 'ci-fixer' OR job_name LIKE 'ci-fixer:%')
        AND repo = ?
        AND item_number = ?
        AND datetime(started_at) >= datetime(?)
    `)
    .get(repo, prNumber, cutoff) as { total: number; failed: number; successful: number; transientApiFailed: number };
  return result;
}

/**
 * Get recent CI fixer error messages for a PR.
 * Used to provide context when marking a PR as problematic.
 */
export function getRecentCIFixerErrors(
  repo: string,
  prNumber: number,
  limit: number = 5,
): Array<{ error: string; timestamp: string }> {
  return getDb()
    .prepare(`
      SELECT error, completed_at as timestamp
      FROM tasks
      WHERE (job_name = 'ci-fixer' OR job_name LIKE 'ci-fixer:%')
        AND repo = ?
        AND item_number = ?
        AND status = 'failed'
        AND error IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT ?
    `)
    .all(repo, prNumber, limit) as Array<{ error: string; timestamp: string }>;
}

export function pruneOldLogs(retentionDays: number, keepPerJob = 20): number {
  const d = getDb();
  const cutoff = `datetime('now', '-${retentionDays} days')`;
  const result = d.prepare(`
    DELETE FROM job_runs
    WHERE started_at < ${cutoff}
    AND id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY job_name ORDER BY started_at DESC) AS rn
        FROM job_runs
      ) WHERE rn <= ?
    )
  `).run(keepPerJob);
  d.prepare(`DELETE FROM job_logs WHERE run_id NOT IN (SELECT run_id FROM job_runs)`).run();
  return result.changes;
}

// ── Queue snapshots & average durations ──

/** Average duration for a job name and its colon sub-variants
 *  (e.g. "ci-fixer" matches "ci-fixer" and "ci-fixer:revert", but not "ci-fixer-v2").
 *  This uses the same colon-based prefix semantics as `getAllAverageTaskDurations`.
 *
 *  Not called in production (only `getAllAverageTaskDurations` is used via `server.ts`),
 *  but kept as a public API for single-job lookups by the MCP server or ad-hoc callers. */
export function getAverageTaskDurationMs(jobName: string, limit = 20): number | null {
  const rows = getDb()
    .prepare(
      `SELECT started_at, completed_at FROM tasks
       WHERE (job_name = ? OR job_name LIKE ? || ':%') AND status = 'completed' AND completed_at IS NOT NULL
       ORDER BY completed_at DESC LIMIT ?`,
    )
    .all(jobName, jobName, limit) as Array<{ started_at: string; completed_at: string }>;
  if (rows.length === 0) return null;
  let totalMs = 0;
  for (const row of rows) {
    totalMs += new Date(row.completed_at + "Z").getTime() - new Date(row.started_at + "Z").getTime();
  }
  return Math.round(totalMs / rows.length);
}

/** Batch-fetch average durations for all job prefixes. Uses SQL `strftime('%s')` for duration,
 *  which truncates to whole seconds (unlike `getAverageTaskDurationMs` which uses JS Date
 *  sub-second arithmetic). The difference is negligible for tasks running minutes. */
export function getAllAverageTaskDurations(limit = 20): Record<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT job_prefix, AVG(duration_ms) as avg_ms FROM (
        SELECT
          CASE WHEN INSTR(job_name, ':') > 0
            THEN SUBSTR(job_name, 1, INSTR(job_name, ':') - 1)
            ELSE job_name
          END as job_prefix,
          (CAST(strftime('%s', completed_at) AS INTEGER) - CAST(strftime('%s', started_at) AS INTEGER)) * 1000 as duration_ms,
          ROW_NUMBER() OVER (
            PARTITION BY CASE WHEN INSTR(job_name, ':') > 0
              THEN SUBSTR(job_name, 1, INSTR(job_name, ':') - 1)
              ELSE job_name
            END
            ORDER BY completed_at DESC
          ) as rn
        FROM tasks
        WHERE status = 'completed' AND completed_at IS NOT NULL
      )
      WHERE rn <= ?
      GROUP BY job_prefix`,
    )
    .all(limit) as Array<{ job_prefix: string; avg_ms: number }>;
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.job_prefix] = Math.round(row.avg_ms);
  }
  return result;
}

export function recordQueueSnapshot(totalItems: number): void {
  getDb()
    .prepare(`INSERT INTO queue_snapshots (total_items, recorded_at) VALUES (?, datetime('now'))`)
    .run(totalItems);
}

export function getQueueSnapshots(hours = 24): Array<{ totalItems: number; recordedAt: string }> {
  const rows = getDb()
    .prepare(
      `SELECT total_items, recorded_at FROM queue_snapshots
       WHERE recorded_at > datetime('now', '-' || ? || ' hours')
       ORDER BY recorded_at ASC`,
    )
    .all(hours) as Array<{ total_items: number; recorded_at: string }>;
  return rows.map((r) => ({ totalItems: r.total_items, recordedAt: r.recorded_at }));
}

export function pruneQueueSnapshots(retentionHours = 72): number {
  const result = getDb()
    .prepare(`DELETE FROM queue_snapshots WHERE recorded_at < datetime('now', '-' || ? || ' hours')`)
    .run(retentionHours);
  return result.changes;
}

export function pruneWorkflowRuns(retentionDays = 30): number {
  const result = getDb()
    .prepare(`DELETE FROM workflow_runs WHERE created_at < datetime('now', '-' || ? || ' days')`)
    .run(retentionDays);
  return result.changes;
}

export function deleteWorkflowRun(runId: number): void {
  getDb().prepare(`DELETE FROM workflow_runs WHERE run_id = ?`).run(runId);
}

// ── Per-repo queries ──

export function getRecentTasksForRepo(repo: string, limit = 20): Task[] {
  return getDb()
    .prepare(`SELECT * FROM tasks WHERE repo = ? ORDER BY started_at DESC LIMIT ?`)
    .all(repo, limit) as Task[];
}

export function getDailyTaskStats(repo: string, days = 30): Array<{ date: string; completed: number; failed: number }> {
  return getDb()
    .prepare(`
      SELECT
        strftime('%Y-%m-%d', started_at) AS date,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM tasks
      WHERE repo = ? AND started_at > datetime('now', '-' || ? || ' days')
      GROUP BY date
      ORDER BY date ASC
    `)
    .all(repo, days) as Array<{ date: string; completed: number; failed: number }>;
}

export function getLastTaskTimePerRepo(): Map<string, string> {
  const rows = getDb()
    .prepare(`SELECT repo, MAX(started_at) AS last_task FROM tasks GROUP BY repo`)
    .all() as Array<{ repo: string; last_task: string }>;
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.repo, row.last_task);
  return map;
}

// ── Usage / cost aggregation ──

export interface UsageStats {
  repoStats: Array<{ repo: string; taskCount: number; totalTokens: number; totalCostUsd: number }>;
  jobStats: Array<{ jobName: string; taskCount: number; totalTokens: number; totalCostUsd: number }>;
  providerStats: Array<{ provider: string; model: string; taskCount: number; totalTokens: number; totalCostUsd: number }>;
}

export interface UsageTotals {
  taskCount: number;
  totalTokens: number;
  totalCostUsd: number;
}

export function getUsageStats(days: number): UsageStats {
  const d = getDb();
  const repoRows = d
    .prepare(`
      SELECT repo,
             COUNT(*) AS task_count,
             COALESCE(SUM(tokens_used), 0) AS total_tokens,
             COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM tasks
      WHERE tokens_used IS NOT NULL
        AND started_at >= datetime('now', '-' || ? || ' days')
      GROUP BY repo
      ORDER BY total_cost_usd DESC
    `)
    .all(days) as Array<{ repo: string; task_count: number; total_tokens: number; total_cost_usd: number }>;

  const jobRows = d
    .prepare(`
      SELECT
        CASE WHEN INSTR(job_name, ':') > 0
          THEN SUBSTR(job_name, 1, INSTR(job_name, ':') - 1)
          ELSE job_name
        END AS job_prefix,
        COUNT(*) AS task_count,
        COALESCE(SUM(tokens_used), 0) AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM tasks
      WHERE tokens_used IS NOT NULL
        AND started_at >= datetime('now', '-' || ? || ' days')
      GROUP BY job_prefix
      ORDER BY total_cost_usd DESC
    `)
    .all(days) as Array<{ job_prefix: string; task_count: number; total_tokens: number; total_cost_usd: number }>;

  const providerRows = d
    .prepare(`
      SELECT provider_used,
             model_used,
             COUNT(*) AS task_count,
             COALESCE(SUM(tokens_used), 0) AS total_tokens,
             COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM tasks
      WHERE tokens_used IS NOT NULL
        AND provider_used IS NOT NULL
        AND model_used IS NOT NULL
        AND started_at >= datetime('now', '-' || ? || ' days')
      GROUP BY provider_used, model_used
      ORDER BY total_cost_usd DESC
    `)
    .all(days) as Array<{ provider_used: string; model_used: string; task_count: number; total_tokens: number; total_cost_usd: number }>;

  return {
    repoStats: repoRows.map((r) => ({
      repo: r.repo,
      taskCount: r.task_count,
      totalTokens: r.total_tokens,
      totalCostUsd: r.total_cost_usd,
    })),
    jobStats: jobRows.map((r) => ({
      jobName: r.job_prefix,
      taskCount: r.task_count,
      totalTokens: r.total_tokens,
      totalCostUsd: r.total_cost_usd,
    })),
    providerStats: providerRows.map((r) => ({
      provider: r.provider_used,
      model: r.model_used,
      taskCount: r.task_count,
      totalTokens: r.total_tokens,
      totalCostUsd: r.total_cost_usd,
    })),
  };
}

export function getTotalUsage(days: number): UsageTotals {
  const row = getDb()
    .prepare(`
      SELECT COUNT(*) AS task_count,
             COALESCE(SUM(tokens_used), 0) AS total_tokens,
             COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM tasks
      WHERE tokens_used IS NOT NULL
        AND started_at >= datetime('now', '-' || ? || ' days')
    `)
    .get(days) as { task_count: number; total_tokens: number; total_cost_usd: number };
  return {
    taskCount: row.task_count,
    totalTokens: row.total_tokens,
    totalCostUsd: row.total_cost_usd,
  };
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
}

export function upsertWorkflowRuns(runs: WorkflowRunRow[]): void {
  if (runs.length === 0) return;
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR REPLACE INTO workflow_runs (run_id, repo, workflow_name, status, conclusion, event, head_branch, created_at, run_started_at, updated_at, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const tx = d.transaction((items: WorkflowRunRow[]) => {
    for (const r of items) {
      stmt.run(r.run_id, r.repo, r.workflow_name, r.status, r.conclusion, r.event, r.head_branch, r.created_at, r.run_started_at, r.updated_at);
    }
  });
  tx(runs);
}

export function getWorkflowRunCount(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS cnt FROM workflow_runs`).get() as { cnt: number };
  return row.cnt;
}

export function getActiveWorkflowRuns(): WorkflowRunRow[] {
  return getDb()
    .prepare(`SELECT * FROM workflow_runs WHERE status IN ('queued', 'in_progress') ORDER BY created_at ASC`)
    .all() as WorkflowRunRow[];
}

export function hasRecentlyCompletedTasks(minutesAgo: number): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM tasks WHERE status IN ('completed', 'failed') AND completed_at >= datetime('now', '-' || ? || ' minutes') LIMIT 1`)
    .get(minutesAgo);
  return row !== undefined;
}

export interface WorkflowRunStats {
  repoStats: Array<{ repo: string; total: number; queued: number; inProgress: number; avgQueueWaitS: number; avgRunDurationS: number; totalDurationS: number }>;
  workflowStats: Array<{ repo: string; workflowName: string; total: number; queued: number; inProgress: number; avgQueueWaitS: number; avgRunDurationS: number; totalDurationS: number }>;
}

export function getWorkflowRunStats(days: number): WorkflowRunStats {
  const d = getDb();

  const repoStats = d.prepare(`
    SELECT
      repo,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
      AVG(CASE WHEN run_started_at IS NOT NULL THEN (julianday(run_started_at) - julianday(created_at)) * 86400 END) AS avg_queue_wait_s,
      AVG(CASE WHEN conclusion IS NOT NULL AND run_started_at IS NOT NULL THEN (julianday(updated_at) - julianday(run_started_at)) * 86400 END) AS avg_run_duration_s,
      SUM(CASE WHEN conclusion IS NOT NULL AND run_started_at IS NOT NULL THEN (julianday(updated_at) - julianday(run_started_at)) * 86400 END) AS total_duration_s
    FROM workflow_runs
    WHERE created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY repo
    ORDER BY total_duration_s DESC
  `).all(days) as Array<{ repo: string; total: number; queued: number; in_progress: number; avg_queue_wait_s: number | null; avg_run_duration_s: number | null; total_duration_s: number | null }>;

  const workflowStats = d.prepare(`
    SELECT
      repo,
      workflow_name,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
      AVG(CASE WHEN run_started_at IS NOT NULL THEN (julianday(run_started_at) - julianday(created_at)) * 86400 END) AS avg_queue_wait_s,
      AVG(CASE WHEN conclusion IS NOT NULL AND run_started_at IS NOT NULL THEN (julianday(updated_at) - julianday(run_started_at)) * 86400 END) AS avg_run_duration_s,
      SUM(CASE WHEN conclusion IS NOT NULL AND run_started_at IS NOT NULL THEN (julianday(updated_at) - julianday(run_started_at)) * 86400 END) AS total_duration_s
    FROM workflow_runs
    WHERE created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY repo, workflow_name
    ORDER BY total_duration_s DESC
  `).all(days) as Array<{ repo: string; workflow_name: string; total: number; queued: number; in_progress: number; avg_queue_wait_s: number | null; avg_run_duration_s: number | null; total_duration_s: number | null }>;

  return {
    repoStats: repoStats.map(r => ({
      repo: r.repo,
      total: r.total,
      queued: r.queued,
      inProgress: r.in_progress,
      avgQueueWaitS: Math.round(r.avg_queue_wait_s ?? 0),
      avgRunDurationS: Math.round(r.avg_run_duration_s ?? 0),
      totalDurationS: Math.round(r.total_duration_s ?? 0),
    })),
    workflowStats: workflowStats.map(r => ({
      repo: r.repo,
      workflowName: r.workflow_name,
      total: r.total,
      queued: r.queued,
      inProgress: r.in_progress,
      avgQueueWaitS: Math.round(r.avg_queue_wait_s ?? 0),
      avgRunDurationS: Math.round(r.avg_run_duration_s ?? 0),
      totalDurationS: Math.round(r.total_duration_s ?? 0),
    })),
  };
}

export function getLastWorkflowRunSync(): string | null {
  const row = getDb()
    .prepare(`SELECT MAX(synced_at) AS last_sync FROM workflow_runs`)
    .get() as { last_sync: string | null };
  return row.last_sync;
}

// ── Terminal sessions (persist across Claws restarts via tmux) ──

export interface PersistedSession {
  id: string;
  tmux_name: string;
  mode: string;
  repo: string | null;
  cwd: string;
  worktree_path: string | null;
  created_at: number;
  summary: string | null;
  summary_updated_at: number | null;
}

export function insertSession(row: PersistedSession): void {
  getDb().prepare(`
    INSERT INTO sessions (id, tmux_name, mode, repo, cwd, worktree_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.tmux_name, row.mode, row.repo, row.cwd, row.worktree_path, row.created_at);
}

export function getAllPersistedSessions(): PersistedSession[] {
  return getDb().prepare(`SELECT * FROM sessions ORDER BY created_at`).all() as PersistedSession[];
}

export function deletePersistedSession(id: string): void {
  getDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

export function updateSessionSummary(id: string, summary: string, updatedAt: number): void {
  getDb().prepare(`UPDATE sessions SET summary = ?, summary_updated_at = ? WHERE id = ?`)
    .run(summary, updatedAt, id);
}

export interface WhatsappEvent {
  id: number;
  event_type: string;
  detail: string | null;
  occurred_at: string;
}

export function recordWhatsappEvent(eventType: string, detail?: string): void {
  try {
    getDb()
      .prepare(`INSERT INTO whatsapp_events (event_type, detail) VALUES (?, ?)`)
      .run(eventType, detail ?? null);
  } catch (err) {
    log.warn(`[whatsapp] Failed to record event: ${err}`);
  }
}

export function getRecentWhatsappEvents(limit = 50): WhatsappEvent[] {
  return getDb()
    .prepare(`SELECT id, event_type, detail, occurred_at FROM whatsapp_events ORDER BY occurred_at DESC LIMIT ?`)
    .all(Math.min(limit, 200)) as WhatsappEvent[];
}

/** @internal — only for tests that need raw SQL (e.g. backdating timestamps) */
export function _rawDb(): Database.Database {
  return getDb();
}

export function healthCheck(): void {
  getDb().prepare("SELECT 1").get();
}

export interface VerificationReportRow {
  id: number;
  ts: number;
  payload: string;
}

export function insertVerificationReport(payload: string): void {
  getDb()
    .prepare(`INSERT INTO verification_reports (ts, payload) VALUES (?, ?)`)
    .run(Date.now(), payload);
}

export function getLatestVerificationReport(): VerificationReportRow | null {
  const row = getDb()
    .prepare(`SELECT id, ts, payload FROM verification_reports ORDER BY ts DESC LIMIT 1`)
    .get() as VerificationReportRow | undefined;
  return row ?? null;
}

export async function backupDb(destPath: string): Promise<void> {
  await getDb().backup(destPath);
}

export interface HaUpgraderStateRow {
  entity_id: string;
  version: string;
  first_seen_at: number;
  attempted_at: number;
  failure_count: number;
}

export function getHaUpgraderState(entityId: string): HaUpgraderStateRow | null {
  const row = getDb()
    .prepare(`SELECT entity_id, version, first_seen_at, attempted_at, failure_count FROM ha_upgrader_state WHERE entity_id = ?`)
    .get(entityId) as HaUpgraderStateRow | undefined;
  return row ?? null;
}

export function upsertHaUpgraderFirstSeen(entityId: string, version: string, now: number): HaUpgraderStateRow {
  const existing = getHaUpgraderState(entityId);
  if (existing && existing.version === version) return existing;
  getDb().prepare(`
    INSERT INTO ha_upgrader_state (entity_id, version, first_seen_at, attempted_at, failure_count)
    VALUES (?, ?, ?, 0, 0)
    ON CONFLICT(entity_id) DO UPDATE SET
      version = excluded.version,
      first_seen_at = excluded.first_seen_at,
      attempted_at = 0,
      failure_count = 0
  `).run(entityId, version, now);
  return { entity_id: entityId, version, first_seen_at: now, attempted_at: 0, failure_count: 0 };
}

export function recordHaUpgraderAttempt(
  entityId: string,
  version: string,
  attemptedAt: number,
  failureCount: number,
): void {
  getDb().prepare(`
    UPDATE ha_upgrader_state
    SET attempted_at = ?, failure_count = ?
    WHERE entity_id = ? AND version = ?
  `).run(attemptedAt, failureCount, entityId, version);
}

export function clearHaUpgraderStateForTests(): void {
  getDb().prepare(`DELETE FROM ha_upgrader_state`).run();
}

export function getAllHaUpgraderStates(): HaUpgraderStateRow[] {
  return getDb()
    .prepare(`SELECT entity_id, version, first_seen_at, attempted_at, failure_count FROM ha_upgrader_state ORDER BY entity_id`)
    .all() as HaUpgraderStateRow[];
}

export interface HaDeployWatcherState {
  addonSlug: string;
  lastNotifiedSha: string;
  lastSeenAt: number;
}

export function getHaDeployWatcherState(addonSlug: string): HaDeployWatcherState | null {
  const row = getDb()
    .prepare(`SELECT addon_slug, last_notified_sha, last_seen_at FROM ha_deploy_watcher_state WHERE addon_slug = ?`)
    .get(addonSlug) as { addon_slug: string; last_notified_sha: string; last_seen_at: number } | undefined;
  if (!row) return null;
  return { addonSlug: row.addon_slug, lastNotifiedSha: row.last_notified_sha, lastSeenAt: row.last_seen_at };
}

export function upsertHaDeployWatcherState(addonSlug: string, sha: string, now: number): void {
  getDb().prepare(`
    INSERT INTO ha_deploy_watcher_state (addon_slug, last_notified_sha, last_seen_at)
    VALUES (?, ?, ?)
    ON CONFLICT(addon_slug) DO UPDATE SET
      last_notified_sha = excluded.last_notified_sha,
      last_seen_at = excluded.last_seen_at
  `).run(addonSlug, sha, now);
}

export function clearHaDeployWatcherStateForTests(): void {
  getDb().prepare(`DELETE FROM ha_deploy_watcher_state`).run();
}

export function closeDb(): void {
  insertLogStmt = null;
  if (db) {
    db.close();
    db = null;
    log.info("Database closed");
  }
}
