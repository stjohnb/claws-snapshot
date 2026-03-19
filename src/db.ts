import Database from "better-sqlite3";
import { DB_PATH } from "./config.js";
import * as log from "./log.js";

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

  log.info("Database initialized");
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

export function recordTaskComplete(taskId: number): void {
  getDb()
    .prepare(
      `UPDATE tasks SET status = 'completed', completed_at = datetime('now') WHERE id = ?`,
    )
    .run(taskId);
}

export function recordTaskFailed(taskId: number, error: string): void {
  getDb()
    .prepare(
      `UPDATE tasks SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?`,
    )
    .run(error, taskId);
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

export function completeJobRun(runId: string, status: "completed" | "failed"): void {
  getDb()
    .prepare(
      `UPDATE job_runs SET status = ?, completed_at = datetime('now') WHERE run_id = ?`,
    )
    .run(status, runId);
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

export function hasPreviousCiFixerTasks(repo: string, prNumber: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM tasks WHERE job_name = 'ci-fixer' AND repo = ? AND item_number = ? AND status = 'completed' LIMIT 1`,
    )
    .get(repo, prNumber);
  return row !== undefined;
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

/** @internal — only for tests that need raw SQL (e.g. backdating timestamps) */
export function _rawDb(): Database.Database {
  return getDb();
}

export function closeDb(): void {
  insertLogStmt = null;
  if (db) {
    db.close();
    db = null;
    log.info("Database closed");
  }
}
