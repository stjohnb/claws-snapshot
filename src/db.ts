import Database from "better-sqlite3";
import { DB_PATH } from "./config.js";
import * as log from "./log.js";
import { buildFailureOutcome } from "./outcome.js";
import { recordGitHubEvent } from "./github-events.js";
import type { DmarcReport } from "./dmarc.js";

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

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_repo_item ON tasks(repo, item_number)
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
      head_sha       TEXT,
      html_url       TEXT,
      run_attempt    INTEGER,
      synced_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  try { db.exec(`ALTER TABLE workflow_runs ADD COLUMN head_sha TEXT`); } catch {}
  try { db.exec(`ALTER TABLE workflow_runs ADD COLUMN html_url TEXT`); } catch {}
  try { db.exec(`ALTER TABLE workflow_runs ADD COLUMN run_attempt INTEGER`); } catch {}
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
  try { db.exec(`ALTER TABLE sessions ADD COLUMN extra_worktrees TEXT`); } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN capabilities TEXT`); } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN ended_at INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN resume_repos TEXT`); } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN provider TEXT`); } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN summary_manual INTEGER NOT NULL DEFAULT 0`); } catch {}

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
    CREATE TABLE IF NOT EXISTS ha_entity_unavailable (
      entity_id      TEXT PRIMARY KEY,
      first_seen_at  INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_intent_backfill (
      repo            TEXT PRIMARY KEY,
      oldest_scanned  TEXT,
      complete        INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  try { db.exec(`ALTER TABLE doc_intent_backfill ADD COLUMN window_exhausted INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE doc_intent_backfill ADD COLUMN source_version INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE doc_intent_backfill ADD COLUMN memory_digest TEXT`); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS notified_untrusted_actors (
      repo          TEXT NOT NULL,
      issue_number  INTEGER NOT NULL,
      notified_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (repo, issue_number)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ci_fixer_breaker (
      repo            TEXT NOT NULL,
      item_number     INTEGER NOT NULL,
      tripped_sha     TEXT,
      tripped_at      TEXT,
      last_claws_sha  TEXT,
      budget_floor_at TEXT,
      grants          INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (repo, item_number)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reminder_notifications (
      repo         TEXT NOT NULL,
      reminder_id  TEXT NOT NULL,
      notify_on    TEXT NOT NULL,
      issue_number INTEGER,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (repo, reminder_id, notify_on)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS upstream_watch_fires (
      watch_id     TEXT NOT NULL,
      repo         TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      fired_at     TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (watch_id, repo, issue_number)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS main_build_failures (
      run_id        TEXT PRIMARY KEY,
      repo          TEXT NOT NULL,
      workflow_name TEXT NOT NULL,
      run_url       TEXT NOT NULL,
      detected_at   TEXT NOT NULL DEFAULT (datetime('now')),
      retried       INTEGER NOT NULL DEFAULT 0,
      outcome       TEXT,
      reported      INTEGER NOT NULL DEFAULT 0,
      closed_at     TEXT,
      event         TEXT NOT NULL DEFAULT ''
    )
  `);
  try { db.exec(`ALTER TABLE main_build_failures ADD COLUMN event TEXT NOT NULL DEFAULT ''`); } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_main_build_failures_wf ON main_build_failures(repo, workflow_name)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS blog_draft_ports (
      repo         TEXT NOT NULL,
      path         TEXT NOT NULL,
      issue_number INTEGER,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (repo, path)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS promotion_actions (
      repo         TEXT NOT NULL,
      site_id      TEXT NOT NULL,
      channel_id   TEXT NOT NULL,
      target_repo  TEXT NOT NULL,
      issue_number INTEGER,
      title        TEXT NOT NULL,
      filed_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS shopping_searches (
      repo             TEXT NOT NULL,
      manifest         TEXT NOT NULL,
      item_id          TEXT NOT NULL,
      last_searched_at TEXT NOT NULL DEFAULT (datetime('now')),
      result_json      TEXT NOT NULL,
      PRIMARY KEY (repo, manifest, item_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS shopping_sourcing_errors (
      repo       TEXT NOT NULL,
      manifest   TEXT NOT NULL,
      error      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (repo, manifest)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS damp_readings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      location     TEXT NOT NULL,
      point        TEXT NOT NULL,
      value        REAL NOT NULL,
      reading_date TEXT NOT NULL,
      recorded_at  TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_damp_readings_point ON damp_readings(location, point)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_damp_readings_date ON damp_readings(reading_date DESC)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS dmarc_reports (
      org_name     TEXT NOT NULL,
      report_id    TEXT NOT NULL,
      report_email TEXT NOT NULL DEFAULT '',
      domain       TEXT NOT NULL,
      date_begin   TEXT NOT NULL,
      date_end     TEXT NOT NULL,
      policy_p     TEXT NOT NULL DEFAULT '',
      policy_sp    TEXT NOT NULL DEFAULT '',
      policy_adkim TEXT NOT NULL DEFAULT '',
      policy_aspf  TEXT NOT NULL DEFAULT '',
      policy_pct   INTEGER,
      row_count    INTEGER NOT NULL DEFAULT 0,
      received_at  TEXT NOT NULL,
      raw_xml      TEXT NOT NULL,
      PRIMARY KEY (org_name, report_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dmarc_reports_domain ON dmarc_reports(domain, date_begin DESC)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS dmarc_rows (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      org_name      TEXT NOT NULL,
      report_id     TEXT NOT NULL,
      row_index     INTEGER NOT NULL,
      domain        TEXT NOT NULL,
      date_begin    TEXT NOT NULL,
      date_end      TEXT NOT NULL,
      source_ip     TEXT NOT NULL,
      count         INTEGER NOT NULL,
      disposition   TEXT NOT NULL DEFAULT '',
      eval_dkim     TEXT NOT NULL DEFAULT '',
      eval_spf      TEXT NOT NULL DEFAULT '',
      header_from   TEXT NOT NULL DEFAULT '',
      envelope_from TEXT NOT NULL DEFAULT '',
      envelope_to   TEXT NOT NULL DEFAULT '',
      dkim_results  TEXT NOT NULL DEFAULT '[]',
      spf_results   TEXT NOT NULL DEFAULT '[]',
      reasons       TEXT NOT NULL DEFAULT '[]',
      verdict       TEXT NOT NULL,
      received_at   TEXT NOT NULL,
      UNIQUE (org_name, report_id, row_index)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dmarc_rows_domain_date ON dmarc_rows(domain, date_begin)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_dmarc_rows_source_ip ON dmarc_rows(source_ip)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS blog_drafts (
      repo       TEXT NOT NULL,
      path       TEXT NOT NULL,
      content    TEXT NOT NULL,
      base_sha   TEXT,
      title      TEXT,
      status     TEXT NOT NULL DEFAULT 'draft',   -- 'draft' | 'pushed'
      pr_number  INTEGER,
      pr_branch  TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repo, path)
    )
  `);

  // One-time backfill (issue #1824): the "Hall Closet / utility" point was added
  // after the other points' first readings were logged. Seed its 2026-07-02 value
  // of 0.5. Idempotent — only inserts when the point has no rows yet.
  const dampSeed = db
    .prepare(`SELECT COUNT(*) AS n FROM damp_readings WHERE location = ? AND point = ?`)
    .get("Hall Closet", "utility") as { n: number };
  if (dampSeed.n === 0) {
    db.prepare(
      `INSERT INTO damp_readings (location, point, value, reading_date, recorded_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("Hall Closet", "utility", 0.5, "2026-07-02", "2026-07-02T00:00:00.000Z");
  }

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
  recordGitHubEvent({ kind: "task-started", repo, number: itemNumber, related: [], detail: jobName });
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

/**
 * Returns an onTokensUsed callback bound to taskId that persists cumulative
 * token/cost via updateTaskTokenUsage. The same callback may be reused across
 * multiple runClaude calls for one task — totals accumulate and the running
 * sum is written on every invocation. Never fires for providers without usage
 * data (e.g. Codex), so nothing is written in that case. Also records the
 * reporting backend into `tasks.provider_used` on every call that supplies
 * one; when a task spans two backends, the last reporter wins.
 */
export function trackTaskTokens(taskId: number): (tokensUsed: number, costUsd: number, provider?: string) => void {
  let tokens = 0;
  let cost = 0;
  let lastProvider: string | undefined;
  return (t, c, provider) => {
    tokens += t;
    cost += c;
    updateTaskTokenUsage(taskId, tokens, cost);
    if (provider && provider !== lastProvider) {
      lastProvider = provider;
      updateTaskProvider(taskId, provider);
    }
  };
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

/**
 * The repo/item/job a task is about, for the #2832 event bus. `recordTaskComplete`
 * and `recordTaskFailed` only receive a task id, so the subject has to be read
 * back. Returns null on any failure — a lookup must never break task accounting.
 */
function lookupTaskSubject(taskId: number): { repo: string; item_number: number; job_name: string } | null {
  try {
    const row = getDb()
      .prepare(`SELECT repo, item_number, job_name FROM tasks WHERE id = ?`)
      .get(taskId) as { repo: string; item_number: number; job_name: string } | undefined;
    if (!row || typeof row.repo !== "string" || !row.repo) return null;
    return row;
  } catch (err) {
    log.warn(`lookupTaskSubject(${taskId}) failed: ${err}`);
    return null;
  }
}

export function recordTaskComplete(taskId: number, outcome?: TaskOutcome): void {
  const outcomeJson = outcome ? JSON.stringify(outcome) : null;
  getDb()
    .prepare(
      `UPDATE tasks SET status = 'completed', outcome = ?, completed_at = datetime('now') WHERE id = ?`,
    )
    .run(outcomeJson, taskId);
  const row = lookupTaskSubject(taskId);
  if (row) recordGitHubEvent({ kind: "task-completed", repo: row.repo, number: row.item_number, related: [], detail: row.job_name });
}

export function recordTaskFailed(taskId: number, error: string, outcome?: TaskOutcome): void {
  const outcomeJson = outcome ? JSON.stringify(outcome) : null;
  getDb()
    .prepare(
      `UPDATE tasks SET status = 'failed', error = ?, outcome = ?, completed_at = datetime('now') WHERE id = ?`,
    )
    .run(error, outcomeJson, taskId);
  const row = lookupTaskSubject(taskId);
  if (row) {
    recordGitHubEvent({
      kind: "task-failed",
      repo: row.repo,
      number: row.item_number,
      related: [],
      detail: `${row.job_name}: ${error.slice(0, 200)}`,
    });
  }
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

/** Terminal 'cancelled' state for a work row whose run was cancelled by an
 *  operator (POST /cancel or POST /logs/:runId/cancel) while the service kept
 *  running. Must not be left 'running': recoverWorkOnStartup() only resets rows
 *  whose pid differs from the live process, so a row left running by a
 *  no-restart cancellation blocks re-enqueue forever via idx_work_queue_active
 *  (#2685). */
export function markWorkCancelled(id: number, reason: string): void {
  getDb()
    .prepare(`UPDATE work_queue SET status = 'cancelled', completed_at = datetime('now'), error_message = ? WHERE id = ?`)
    .run(reason.slice(0, 4000), id);
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

/** Number of task rows this job has started for `repo` within `windowMs`. Used by
 *  improvement-identifier to throttle its expensive whole-repo analysis. */
export function countRecentTasksForJobRepo(jobName: string, repo: string, windowMs: number): number {
  const cutoff = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE job_name = ? AND repo = ? AND started_at >= ?`)
    .get(jobName, repo, cutoff) as { n: number };
  return row.n;
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

/** Per-PR circuit-breaker bookkeeping, backing the new-commit fix grant. */
export interface CIFixerBreakerState {
  trippedSha: string | null;
  trippedAt: string | null;
  lastClawsSha: string | null;
  budgetFloorAt: string | null;
  grants: number;
}

/** Read the breaker state for a PR, or `undefined` when the breaker never tripped. */
export function getCIFixerBreakerState(repo: string, prNumber: number): CIFixerBreakerState | undefined {
  const row = getDb()
    .prepare(
      `SELECT tripped_sha, tripped_at, last_claws_sha, budget_floor_at, grants
       FROM ci_fixer_breaker WHERE repo = ? AND item_number = ?`,
    )
    .get(repo, prNumber) as
    | { tripped_sha: string | null; tripped_at: string | null; last_claws_sha: string | null; budget_floor_at: string | null; grants: number }
    | undefined;
  if (!row) return undefined;
  return {
    trippedSha: row.tripped_sha,
    trippedAt: row.tripped_at,
    lastClawsSha: row.last_claws_sha,
    budgetFloorAt: row.budget_floor_at,
    grants: row.grants,
  };
}

/**
 * Record the head SHA a PR was sitting on when the circuit breaker tripped.
 * Deliberately leaves `grants`, `budget_floor_at` and `last_claws_sha` alone —
 * a re-trip must not wipe the lifetime grant count.
 */
export function recordCIFixerBreakerTrip(repo: string, prNumber: number, headSha: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO ci_fixer_breaker (repo, item_number, tripped_sha, tripped_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo, item_number) DO UPDATE SET
         tripped_sha = excluded.tripped_sha,
         tripped_at  = excluded.tripped_at`,
    )
    .run(repo, prNumber, headSha, new Date().toISOString());
}

/**
 * Record a head SHA that Claws itself pushed to a PR branch. Guards the
 * new-commit grant against Claws resetting its own budget with its own fixes.
 */
export function recordCIFixerPush(repo: string, prNumber: number, headSha: string): void {
  getDb()
    .prepare(
      `INSERT INTO ci_fixer_breaker (repo, item_number, last_claws_sha)
       VALUES (?, ?, ?)
       ON CONFLICT(repo, item_number) DO UPDATE SET last_claws_sha = excluded.last_claws_sha`,
    )
    .run(repo, prNumber, headSha);
}

/**
 * Grant a fresh fix budget after a new head commit. Clears the trip, advances
 * the budget floor so pre-trip attempts stop counting, and either resets the
 * lifetime grant count (the new head is green) or spends one grant.
 */
export function recordCIFixerBreakerGrant(repo: string, prNumber: number, opts: { recovered: boolean }): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO ci_fixer_breaker (repo, item_number, tripped_sha, tripped_at, budget_floor_at, grants)
       VALUES (?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(repo, item_number) DO UPDATE SET
         tripped_sha     = NULL,
         tripped_at      = NULL,
         budget_floor_at = excluded.budget_floor_at,
         grants          = ${opts.recovered ? "0" : "ci_fixer_breaker.grants + 1"}`,
    )
    .run(repo, prNumber, now, opts.recovered ? 0 : 1);
}

/**
 * Full reset for "a human (or the diagnoser) cleared the problematic label" —
 * drops the trip, zeroes the lifetime grants and advances the budget floor so
 * the pre-existing attempts in the 24h window can't immediately re-trip.
 */
export function resetCIFixerBreakerGrants(repo: string, prNumber: number): void {
  getDb()
    .prepare(
      `INSERT INTO ci_fixer_breaker (repo, item_number, tripped_sha, tripped_at, budget_floor_at, grants)
       VALUES (?, ?, NULL, NULL, ?, 0)
       ON CONFLICT(repo, item_number) DO UPDATE SET
         tripped_sha     = NULL,
         tripped_at      = NULL,
         budget_floor_at = excluded.budget_floor_at,
         grants          = 0`,
    )
    .run(repo, prNumber, new Date().toISOString());
}

/**
 * Count CI fixer attempts for a PR within a time window.
 * Returns counts for total attempts, failed attempts, and successful attempts.
 *
 * `sinceIso` is an optional budget floor (ISO timestamp): when it is newer than
 * the window cutoff, attempts before it are excluded. An older floor never
 * widens the window.
 */
export function countCIFixerAttempts(
  repo: string,
  prNumber: number,
  windowMs: number = 24 * 60 * 60 * 1000, // 24 hours default
  sinceIso?: string | null,
): { total: number; failed: number; successful: number; transientApiFailed: number } {
  const windowCutoff = new Date(Date.now() - windowMs).toISOString();
  const cutoff = sinceIso && sinceIso > windowCutoff ? sinceIso : windowCutoff;
  const result = getDb()
    .prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as successful,
        COALESCE(SUM(CASE WHEN status = 'failed' AND json_extract(outcome, '$.failureCategory') = 'transient-api' THEN 1 ELSE 0 END), 0) as transientApiFailed
      FROM tasks
      -- Conflict resolution has its own budget (countConflictResolutionAttempts) so a
      -- conflict loop cannot exhaust the CI-fix budget or vice-versa (#2389).
      WHERE (job_name = 'ci-fixer' OR (job_name LIKE 'ci-fixer:%' AND job_name != 'ci-fixer:merge-conflict'))
        AND repo = ?
        AND item_number = ?
        AND datetime(started_at) >= datetime(?)
    `)
    .get(repo, prNumber, cutoff) as { total: number; failed: number; successful: number; transientApiFailed: number };
  return result;
}

/**
 * Count merge-conflict resolution attempts for a PR within a window.
 * `unproductive` counts attempts that failed OR completed without producing a
 * commit — a successful resolution is progress, not a loop, so it does not
 * consume the conflict budget (#2389).
 */
export function countConflictResolutionAttempts(
  repo: string,
  prNumber: number,
  windowMs: number = 24 * 60 * 60 * 1000,
): { total: number; unproductive: number } {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const result = getDb()
    .prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'failed'
          OR (status = 'completed' AND COALESCE(json_extract(outcome, '$.commits'), 0) = 0)
          THEN 1 ELSE 0 END), 0) AS unproductive
      FROM tasks
      WHERE job_name = 'ci-fixer:merge-conflict'
        AND repo = ?
        AND item_number = ?
        AND datetime(started_at) >= datetime(?)
    `)
    .get(repo, prNumber, cutoff) as { total: number; unproductive: number };
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

/**
 * Delete terminal task rows older than the retention period. Never deletes
 * `running` rows — startup orphan recovery (`getOrphanedTasks`) depends on them.
 * Rows whose `run_id` still exists in `job_runs` are kept so the dashboard's
 * retained run pages (`getTasksByRunId`) don't render with an empty task list.
 */
export function pruneTasks(retentionDays = 90): number {
  const result = getDb()
    .prepare(`
      DELETE FROM tasks
      WHERE status IN ('completed', 'failed')
        AND COALESCE(completed_at, started_at) < datetime('now', '-' || ? || ' days')
        AND (run_id IS NULL OR run_id NOT IN (SELECT run_id FROM job_runs))
    `)
    .run(retentionDays);
  return Number(result.changes);
}

// ── Queue snapshots & average durations ──

/** Batch-fetch average durations for all job prefixes, keyed by the prefix before the first
 *  colon (so "ci-fixer:revert" and "ci-fixer:merge-conflict" both roll up under "ci-fixer").
 *  Considers only the most recent `limit` completed tasks per prefix. Duration comes from SQL
 *  `strftime('%s')`, which truncates to whole seconds — negligible for tasks running minutes. */
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
}

/** Completed push/schedule runs on a repo's default branch, newest first.
 *  `workflow_dispatch` is excluded on purpose — a human pressing "Run workflow"
 *  sees their own failure. */
export function getDefaultBranchRuns(repo: string, branch: string, sinceDays = 7): MainBuildRunRow[] {
  return getDb()
    .prepare(`
      SELECT run_id, workflow_name, conclusion, event, created_at, head_sha, html_url, run_attempt
      FROM workflow_runs
      WHERE repo = ? AND head_branch = ? AND status = 'completed'
        AND event IN ('push','schedule')
        AND created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY created_at DESC
    `)
    .all(repo, branch, sinceDays) as MainBuildRunRow[];
}

export function recordMainBuildFailure(
  runId: string,
  repo: string,
  workflowName: string,
  runUrl: string,
  retried: boolean,
  outcome: string | null,
  event = "",
): void {
  getDb()
    .prepare(`
      INSERT OR IGNORE INTO main_build_failures (run_id, repo, workflow_name, run_url, retried, outcome, event)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(runId, repo, workflowName, runUrl, retried ? 1 : 0, outcome, event);
}

export function hasMainBuildFailure(runId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 AS n FROM main_build_failures WHERE run_id = ? LIMIT 1`)
    .get(runId) as { n: number } | undefined;
  return row !== undefined;
}

export function getPendingMainBuildRetries(): MainBuildFailureRow[] {
  return getDb()
    .prepare(`
      SELECT * FROM main_build_failures
      WHERE retried = 1 AND outcome IS NULL AND detected_at > datetime('now', '-1 day')
      ORDER BY detected_at ASC
    `)
    .all() as MainBuildFailureRow[];
}

/**
 * Retries that fell out of `getPendingMainBuildRetries()`'s 24h window without ever
 * resolving — e.g. a self-hosted runner pool down long enough that the re-run never
 * completed. Left alone these rows would sit with `outcome = NULL` until
 * `pruneMainBuildFailures` quietly deleted them, and the failure they represent would
 * never get reported.
 */
export function getExpiredMainBuildRetries(): MainBuildFailureRow[] {
  return getDb()
    .prepare(`
      SELECT * FROM main_build_failures
      WHERE retried = 1 AND outcome IS NULL AND detected_at <= datetime('now', '-1 day')
      ORDER BY detected_at ASC
    `)
    .all() as MainBuildFailureRow[];
}

export function setMainBuildRetryOutcome(runId: string, outcome: string): void {
  getDb().prepare(`UPDATE main_build_failures SET outcome = ? WHERE run_id = ?`).run(outcome, runId);
}

export function markMainBuildReported(runId: string): void {
  getDb().prepare(`UPDATE main_build_failures SET reported = 1 WHERE run_id = ?`).run(runId);
}

/**
 * Rows whose terminal outcome required filing/updating the tracking issue, but that never
 * got marked `reported` — i.e. the `ensureAlertIssue` call in `reportFailure` threw. Retried
 * every pass until it succeeds, so a single GitHub API hiccup can't permanently drop a build
 * failure (`retried = 1 AND outcome IS NULL` rows are still-pending retries, handled by
 * `getPendingMainBuildRetries`, and are excluded here since `outcome` is non-null).
 */
export function getUnreportedMainBuildFailures(): MainBuildFailureRow[] {
  return getDb()
    .prepare(`
      SELECT * FROM main_build_failures
      WHERE reported = 0 AND outcome IS NOT NULL AND outcome NOT IN ('success', 'abandoned')
      ORDER BY detected_at ASC
    `)
    .all() as MainBuildFailureRow[];
}

export function hasUnclosedReportedFailure(repo: string, workflowName: string): boolean {
  const row = getDb()
    .prepare(`
      SELECT 1 AS n FROM main_build_failures
      WHERE repo = ? AND workflow_name = ? AND reported = 1 AND closed_at IS NULL
      LIMIT 1
    `)
    .get(repo, workflowName) as { n: number } | undefined;
  return row !== undefined;
}

export function markMainBuildFailuresClosed(repo: string, workflowName: string): void {
  getDb()
    .prepare(`
      UPDATE main_build_failures SET closed_at = datetime('now')
      WHERE repo = ? AND workflow_name = ? AND closed_at IS NULL
    `)
    .run(repo, workflowName);
}

export function pruneMainBuildFailures(retentionDays = 30): number {
  const result = getDb()
    .prepare(`DELETE FROM main_build_failures WHERE detected_at < datetime('now', '-' || ? || ' days')`)
    .run(retentionDays);
  return result.changes;
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

export interface UsageFilters {
  repo?: string;
  job?: string;      // job-name prefix, matching the jobStats grouping
  provider?: string; // "unknown" matches rows with NULL provider_used
  model?: string;    // "unknown" matches rows with NULL model_used
}

const JOB_PREFIX_SQL = `CASE WHEN INSTR(job_name, ':') > 0 THEN SUBSTR(job_name, 1, INSTR(job_name, ':') - 1) ELSE job_name END`;

function usageWhere(days: number, filters?: UsageFilters): { sql: string; params: unknown[] } {
  const clauses = [`tokens_used IS NOT NULL`, `started_at >= datetime('now', '-' || ? || ' days')`];
  const params: unknown[] = [days];
  if (filters?.repo) { clauses.push(`repo = ?`); params.push(filters.repo); }
  if (filters?.job) { clauses.push(`${JOB_PREFIX_SQL} = ?`); params.push(filters.job); }
  if (filters?.provider) { clauses.push(`COALESCE(provider_used, 'unknown') = ?`); params.push(filters.provider); }
  if (filters?.model) { clauses.push(`COALESCE(model_used, 'unknown') = ?`); params.push(filters.model); }
  return { sql: clauses.join(" AND "), params };
}

export function getUsageStats(days: number, filters?: UsageFilters): UsageStats {
  const d = getDb();
  const where = usageWhere(days, filters);
  const repoRows = d
    .prepare(`
      SELECT repo,
             COUNT(*) AS task_count,
             COALESCE(SUM(tokens_used), 0) AS total_tokens,
             COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM tasks
      WHERE ${where.sql}
      GROUP BY repo
      ORDER BY total_cost_usd DESC
    `)
    .all(...where.params) as Array<{ repo: string; task_count: number; total_tokens: number; total_cost_usd: number }>;

  const jobRows = d
    .prepare(`
      SELECT
        ${JOB_PREFIX_SQL} AS job_prefix,
        COUNT(*) AS task_count,
        COALESCE(SUM(tokens_used), 0) AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM tasks
      WHERE ${where.sql}
      GROUP BY job_prefix
      ORDER BY total_cost_usd DESC
    `)
    .all(...where.params) as Array<{ job_prefix: string; task_count: number; total_tokens: number; total_cost_usd: number }>;

  const providerRows = d
    .prepare(`
      SELECT COALESCE(provider_used, 'unknown') AS provider_used,
             COALESCE(model_used, 'unknown') AS model_used,
             COUNT(*) AS task_count,
             COALESCE(SUM(tokens_used), 0) AS total_tokens,
             COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM tasks
      WHERE ${where.sql}
      GROUP BY 1, 2
      ORDER BY total_cost_usd DESC
    `)
    .all(...where.params) as Array<{ provider_used: string; model_used: string; task_count: number; total_tokens: number; total_cost_usd: number }>;

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

export function getTotalUsage(days: number, filters?: UsageFilters): UsageTotals {
  const where = usageWhere(days, filters);
  const row = getDb()
    .prepare(`
      SELECT COUNT(*) AS task_count,
             COALESCE(SUM(tokens_used), 0) AS total_tokens,
             COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM tasks
      WHERE ${where.sql}
    `)
    .get(...where.params) as { task_count: number; total_tokens: number; total_cost_usd: number };
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
}

export function getUsageFilterOptions(days: number): UsageFilterOptions {
  const d = getDb();
  const baseWhere = `tokens_used IS NOT NULL AND started_at >= datetime('now', '-' || ? || ' days')`;
  const repos = (d.prepare(`SELECT DISTINCT repo FROM tasks WHERE ${baseWhere} ORDER BY 1`).all(days) as Array<{ repo: string }>).map((r) => r.repo);
  const jobs = (d.prepare(`SELECT DISTINCT ${JOB_PREFIX_SQL} AS job FROM tasks WHERE ${baseWhere} ORDER BY 1`).all(days) as Array<{ job: string }>).map((r) => r.job);
  const providers = (d.prepare(`SELECT DISTINCT COALESCE(provider_used, 'unknown') AS provider FROM tasks WHERE ${baseWhere} ORDER BY 1`).all(days) as Array<{ provider: string }>).map((r) => r.provider);
  const models = (d.prepare(`SELECT DISTINCT COALESCE(model_used, 'unknown') AS model FROM tasks WHERE ${baseWhere} ORDER BY 1`).all(days) as Array<{ model: string }>).map((r) => r.model);
  return { repos, jobs, providers, models };
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

export function upsertWorkflowRuns(runs: WorkflowRunRow[]): void {
  if (runs.length === 0) return;
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR REPLACE INTO workflow_runs (run_id, repo, workflow_name, status, conclusion, event, head_branch, created_at, run_started_at, updated_at, head_sha, html_url, run_attempt, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const tx = d.transaction((items: WorkflowRunRow[]) => {
    for (const r of items) {
      stmt.run(r.run_id, r.repo, r.workflow_name, r.status, r.conclusion, r.event, r.head_branch, r.created_at, r.run_started_at, r.updated_at, r.head_sha, r.html_url, r.run_attempt);
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
  extra_worktrees: string | null;
  capabilities: string | null;
  created_at: number;
  summary: string | null;
  summary_updated_at: number | null;
  ended_at: number | null;
  resume_repos: string | null;
  /** Agent CLI the session runs (`claude` | `codex`). NULL on rows written before #2664 — every read path must coalesce to `"claude"`. */
  provider: string | null;
  summary_manual: number;
}

export function insertSession(row: Omit<PersistedSession, "ended_at" | "resume_repos" | "summary_manual">): void {
  getDb().prepare(`
    INSERT INTO sessions (id, tmux_name, mode, repo, cwd, worktree_path, extra_worktrees, capabilities, created_at, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.tmux_name, row.mode, row.repo, row.cwd, row.worktree_path, row.extra_worktrees, row.capabilities, row.created_at, row.provider);
}

export function getAllPersistedSessions(): PersistedSession[] {
  return getDb().prepare(`SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY created_at`).all() as PersistedSession[];
}

export function getEndedSessions(): PersistedSession[] {
  return getDb().prepare(`SELECT * FROM sessions WHERE ended_at IS NOT NULL ORDER BY ended_at DESC, id DESC`).all() as PersistedSession[];
}

export function getPersistedSession(id: string): PersistedSession | undefined {
  return getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as PersistedSession | undefined;
}

export function markSessionEnded(id: string, endedAt: number, resumeRepos: string | null): void {
  getDb().prepare(`UPDATE sessions SET ended_at = ?, resume_repos = ? WHERE id = ?`).run(endedAt, resumeRepos, id);
}

export function clearSessionEnded(id: string): void {
  getDb().prepare(`UPDATE sessions SET ended_at = NULL WHERE id = ?`).run(id);
}

export function pruneEndedSessions(keep: number): string[] {
  // SQLite: LIMIT -1 OFFSET keep = "all rows past the first `keep`"
  const rows = getDb().prepare(`
    SELECT id
    FROM sessions
    WHERE ended_at IS NOT NULL
    ORDER BY ended_at DESC, id DESC
    LIMIT -1 OFFSET ?
  `).all(keep) as Array<{ id: string }>;
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const deleteChunkSize = 900;
  for (let i = 0; i < ids.length; i += deleteChunkSize) {
    const chunk = ids.slice(i, i + deleteChunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    getDb().prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...chunk);
  }
  return ids;
}

export function deletePersistedSession(id: string): void {
  getDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

export function updateSessionSummary(id: string, summary: string, updatedAt: number): void {
  getDb().prepare(`UPDATE sessions SET summary = ?, summary_updated_at = ? WHERE id = ? AND summary_manual = 0`)
    .run(summary, updatedAt, id);
}

/** Set (or clear, with `summary === null`) a user-authored session description. Returns true if a row was updated. */
export function setManualSessionSummary(id: string, summary: string | null, updatedAt: number | null): boolean {
  const info = getDb().prepare(`UPDATE sessions SET summary = ?, summary_updated_at = ?, summary_manual = ? WHERE id = ?`)
    .run(summary, updatedAt, summary === null ? 0 : 1, id);
  return info.changes > 0;
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

export interface DampReadingRow {
  id: number;
  location: string;
  point: string;
  value: number;
  reading_date: string;
  recorded_at: string;
}

export function upsertDampReading(
  location: string,
  point: string,
  value: number,
  readingDate: string,
  recordedAt: string,
): void {
  const db = getDb();
  const res = db
    .prepare(
      `UPDATE damp_readings SET value = ?, recorded_at = ?
       WHERE location = ? AND point = ? AND reading_date = ?`,
    )
    .run(value, recordedAt, location, point, readingDate);
  if (res.changes === 0) {
    db.prepare(
      `INSERT INTO damp_readings (location, point, value, reading_date, recorded_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(location, point, value, readingDate, recordedAt);
  }
}

export function deleteDampReading(
  location: string,
  point: string,
  readingDate: string,
): void {
  getDb()
    .prepare(`DELETE FROM damp_readings WHERE location = ? AND point = ? AND reading_date = ?`)
    .run(location, point, readingDate);
}

export function getRecentDampReadings(limit = 200): DampReadingRow[] {
  return getDb()
    .prepare(`SELECT * FROM damp_readings ORDER BY reading_date DESC, recorded_at DESC, location, point LIMIT ?`)
    .all(limit) as DampReadingRow[];
}

export function getDampTrendRows(): DampReadingRow[] {
  return getDb()
    .prepare(`SELECT * FROM damp_readings ORDER BY location, point, reading_date DESC, recorded_at DESC`)
    .all() as DampReadingRow[];
}

export function hasDampReadingLoggedSince(sinceIso: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 AS n FROM damp_readings WHERE recorded_at >= ? LIMIT 1`)
    .get(sinceIso) as { n: number } | undefined;
  return row !== undefined;
}

/** A `dmarc_reports` row minus `raw_xml`, which every read path except getDmarcReportXml() excludes. */
export interface DmarcReportRow {
  org_name: string;
  report_id: string;
  report_email: string;
  domain: string;
  date_begin: string;
  date_end: string;
  policy_p: string;
  policy_sp: string;
  policy_adkim: string;
  policy_aspf: string;
  policy_pct: number | null;
  row_count: number;
  received_at: string;
}

export interface DmarcRowRow {
  id: number;
  org_name: string;
  report_id: string;
  row_index: number;
  domain: string;
  date_begin: string;
  date_end: string;
  source_ip: string;
  count: number;
  disposition: string;
  eval_dkim: string;
  eval_spf: string;
  header_from: string;
  envelope_from: string;
  envelope_to: string;
  dkim_results: string;
  spf_results: string;
  reasons: string;
  verdict: string;
  received_at: string;
}

const DMARC_REPORT_COLUMNS = `org_name, report_id, report_email, domain, date_begin, date_end,
       policy_p, policy_sp, policy_adkim, policy_aspf, policy_pct, row_count, received_at`;

export function hasDmarcReport(orgName: string, reportId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 AS n FROM dmarc_reports WHERE org_name = ? AND report_id = ? LIMIT 1`)
    .get(orgName, reportId) as { n: number } | undefined;
  return row !== undefined;
}

export function getLatestDmarcReportForDomain(domain: string): DmarcReportRow | undefined {
  return getDb()
    .prepare(
      `SELECT ${DMARC_REPORT_COLUMNS} FROM dmarc_reports WHERE domain = ?
       ORDER BY date_begin DESC, received_at DESC LIMIT 1`,
    )
    .get(domain) as DmarcReportRow | undefined;
}

/** The only read path that touches `raw_xml` — kept separate so the hot queries stay small. */
export function getDmarcReportXml(orgName: string, reportId: string): string | undefined {
  const row = getDb()
    .prepare(`SELECT raw_xml FROM dmarc_reports WHERE org_name = ? AND report_id = ?`)
    .get(orgName, reportId) as { raw_xml: string } | undefined;
  return row?.raw_xml;
}

/**
 * Store a parsed report and its rows in one transaction. Returns false without
 * writing anything when `(org_name, report_id)` is already present, so a
 * re-forwarded or duplicate report is idempotent and raises no second alert.
 */
export function insertDmarcReport(report: DmarcReport, rawXml: string, receivedAt: string): boolean {
  if (hasDmarcReport(report.orgName, report.reportId)) return false;
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO dmarc_reports (org_name, report_id, report_email, domain, date_begin, date_end,
         policy_p, policy_sp, policy_adkim, policy_aspf, policy_pct, row_count, received_at, raw_xml)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      report.orgName,
      report.reportId,
      report.reportEmail,
      report.domain,
      report.dateBegin,
      report.dateEnd,
      report.policyP,
      report.policySp,
      report.policyAdkim,
      report.policyAspf,
      report.policyPct,
      report.rows.length,
      receivedAt,
      rawXml,
    );
    const insertRow = db.prepare(
      `INSERT INTO dmarc_rows (org_name, report_id, row_index, domain, date_begin, date_end,
         source_ip, count, disposition, eval_dkim, eval_spf, header_from, envelope_from, envelope_to,
         dkim_results, spf_results, reasons, verdict, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    report.rows.forEach((r, i) => {
      insertRow.run(
        report.orgName,
        report.reportId,
        i,
        report.domain,
        report.dateBegin,
        report.dateEnd,
        r.sourceIp,
        r.count,
        r.disposition,
        r.evalDkim,
        r.evalSpf,
        r.headerFrom,
        r.envelopeFrom,
        r.envelopeTo,
        JSON.stringify(r.dkimResults),
        JSON.stringify(r.spfResults),
        JSON.stringify(r.reasons),
        r.verdict,
        receivedAt,
      );
    });
  })();
  return true;
}

export function getDmarcVerdictCounts(sinceIso: string): Array<{ domain: string; verdict: string; n: number }> {
  return getDb()
    .prepare(
      `SELECT domain, verdict, COUNT(*) AS n FROM dmarc_rows WHERE date_begin >= ?
       GROUP BY domain, verdict ORDER BY domain, verdict`,
    )
    .all(sinceIso) as Array<{ domain: string; verdict: string; n: number }>;
}

export interface DmarcSourceIpRow {
  source_ip: string;
  verdict: string;
  domain: string;
  messages: number;
  last_seen: string;
}

export function getDmarcSourceIps(sinceIso: string, limit = 200): DmarcSourceIpRow[] {
  return getDb()
    .prepare(
      `SELECT source_ip, verdict, domain, SUM(count) AS messages, MAX(date_end) AS last_seen
       FROM dmarc_rows WHERE date_begin >= ?
       GROUP BY source_ip, verdict, domain ORDER BY last_seen DESC LIMIT ?`,
    )
    .all(sinceIso, limit) as DmarcSourceIpRow[];
}

/** Latest report per (domain, reporter) pair — the "is anything still arriving?" view. */
export function getLatestDmarcReportsPerReporter(): DmarcReportRow[] {
  return getDb()
    .prepare(
      `SELECT ${DMARC_REPORT_COLUMNS}, MAX(date_begin) AS max_begin FROM dmarc_reports
       GROUP BY domain, org_name ORDER BY max_begin DESC, domain, org_name`,
    )
    .all() as DmarcReportRow[];
}

/**
 * Delete reports and their rows past the retention window. `received_at` is ISO 8601, which
 * still compares correctly against datetime('now', …) at day granularity — same as pruneWorkflowRuns.
 */
export function pruneDmarcReports(retentionDays = 365): number {
  const db = getDb();
  return db.transaction(() => {
    db.prepare(`DELETE FROM dmarc_rows WHERE received_at < datetime('now', '-' || ? || ' days')`).run(retentionDays);
    return db
      .prepare(`DELETE FROM dmarc_reports WHERE received_at < datetime('now', '-' || ? || ' days')`)
      .run(retentionDays).changes;
  })();
}

export function getRecentDmarcRows(limit = 100): DmarcRowRow[] {
  return getDb()
    .prepare(`SELECT * FROM dmarc_rows ORDER BY date_begin DESC, id DESC LIMIT ?`)
    .all(limit) as DmarcRowRow[];
}

export function hasReminderFired(repo: string, reminderId: string, notifyOn: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 AS n FROM reminder_notifications WHERE repo = ? AND reminder_id = ? AND notify_on = ? LIMIT 1`)
    .get(repo, reminderId, notifyOn) as { n: number } | undefined;
  return row !== undefined;
}

export function recordReminderFired(repo: string, reminderId: string, notifyOn: string, issueNumber: number): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO reminder_notifications (repo, reminder_id, notify_on, issue_number) VALUES (?, ?, ?, ?)`,
    )
    .run(repo, reminderId, notifyOn, issueNumber);
}

/** True once `watchId` has unblocked `repo#issueNumber` — stops a re-comment
 *  loop if a human later re-applies `Claws Ignore`. (#2617) */
export function hasUpstreamWatchFired(watchId: string, repo: string, issueNumber: number): boolean {
  const row = getDb()
    .prepare(`SELECT 1 AS n FROM upstream_watch_fires WHERE watch_id = ? AND repo = ? AND issue_number = ? LIMIT 1`)
    .get(watchId, repo, issueNumber) as { n: number } | undefined;
  return row !== undefined;
}

export function recordUpstreamWatchFired(watchId: string, repo: string, issueNumber: number): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO upstream_watch_fires (watch_id, repo, issue_number) VALUES (?, ?, ?)`)
    .run(watchId, repo, issueNumber);
}

export function hasBlogDraftPortFiled(repo: string, path: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 AS n FROM blog_draft_ports WHERE repo = ? AND path = ? LIMIT 1`)
    .get(repo, path) as { n: number } | undefined;
  return row !== undefined;
}

export function recordBlogDraftPortFiled(repo: string, path: string, issueNumber: number): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO blog_draft_ports (repo, path, issue_number) VALUES (?, ?, ?)`)
    .run(repo, path, issueNumber);
}

/**
 * Records one promotion action filed by `site-promoter`. Append-only history —
 * the cadence gate reads `MAX(filed_at)` per channel, so a re-filed channel
 * simply adds a newer row rather than overwriting the audit trail.
 */
export function recordPromotionActionFiled(
  repo: string,
  siteId: string,
  channelId: string,
  targetRepo: string,
  issueNumber: number,
  title: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO promotion_actions (repo, site_id, channel_id, target_repo, issue_number, title)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(repo, siteId, channelId, targetRepo, issueNumber, title);
}

/** Latest filing timestamp per channel for one site. Values are UTC without a zone suffix. */
export function getPromotionActionTimestamps(repo: string, siteId: string): Map<string, string> {
  const rows = getDb()
    .prepare(
      `SELECT channel_id, MAX(filed_at) AS last FROM promotion_actions
       WHERE repo = ? AND site_id = ? GROUP BY channel_id`,
    )
    .all(repo, siteId) as Array<{ channel_id: string; last: string }>;
  return new Map(rows.map((r) => [r.channel_id, r.last]));
}

export interface ShoppingSearchRow {
  itemId: string;
  lastSearchedAt: string;
  resultJson: string;
}

/**
 * Records the outcome of a shopping-sourcer search for one manifest item.
 * Empty results are recorded too — the timestamp is what throttles re-searching
 * of hard-to-find items via each item's `recheck_days`.
 */
export function recordShoppingSearch(
  repo: string,
  manifest: string,
  itemId: string,
  resultJson: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO shopping_searches (repo, manifest, item_id, result_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo, manifest, item_id)
       DO UPDATE SET last_searched_at = datetime('now'), result_json = excluded.result_json`,
    )
    .run(repo, manifest, itemId, resultJson);
}

/** Latest stored search per item for one manifest. `lastSearchedAt` is UTC without a zone suffix. */
export function getShoppingSearches(repo: string, manifest: string): ShoppingSearchRow[] {
  const rows = getDb()
    .prepare(
      `SELECT item_id, last_searched_at, result_json FROM shopping_searches WHERE repo = ? AND manifest = ?`,
    )
    .all(repo, manifest) as Array<{ item_id: string; last_searched_at: string; result_json: string }>;
  return rows.map((r) => ({
    itemId: r.item_id,
    lastSearchedAt: r.last_searched_at,
    resultJson: r.result_json,
  }));
}

/** Every stored shopping search row across all repos/manifests — for cross-project store hints. */
export function getAllShoppingSearches(): Array<{ repo: string; manifest: string; resultJson: string }> {
  const rows = getDb()
    .prepare(`SELECT repo, manifest, result_json FROM shopping_searches`)
    .all() as Array<{ repo: string; manifest: string; result_json: string }>;
  return rows.map((r) => ({ repo: r.repo, manifest: r.manifest, resultJson: r.result_json }));
}

/**
 * Records (or clears, with `error === null`) the last sourcing failure for one
 * manifest. The consolidated tracking issue's "candidates may be stale" banner
 * is rebuilt from these rows, so both the sourcer and the comment processor
 * render the same warning without either having to parse the issue body.
 */
export function recordShoppingSourcingError(repo: string, manifest: string, error: string | null): void {
  if (error === null) {
    getDb()
      .prepare(`DELETE FROM shopping_sourcing_errors WHERE repo = ? AND manifest = ?`)
      .run(repo, manifest);
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO shopping_sourcing_errors (repo, manifest, error)
       VALUES (?, ?, ?)
       ON CONFLICT(repo, manifest)
       DO UPDATE SET error = excluded.error, updated_at = datetime('now')`,
    )
    .run(repo, manifest, error);
}

/** The last recorded sourcing failure for one manifest, or undefined when the last run succeeded. */
export function getShoppingSourcingError(repo: string, manifest: string): string | undefined {
  const row = getDb()
    .prepare(`SELECT error FROM shopping_sourcing_errors WHERE repo = ? AND manifest = ?`)
    .get(repo, manifest) as { error: string } | undefined;
  return row?.error;
}

export interface BlogDraftRow {
  repo: string;
  path: string;
  content: string;
  base_sha: string | null;
  title: string | null;
  status: string;
  pr_number: number | null;
  pr_branch: string | null;
  updated_at: string;
}

export function upsertBlogDraft(
  repo: string,
  path: string,
  content: string,
  baseSha: string | null,
  title: string | null,
  updatedAt: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO blog_drafts (repo, path, content, base_sha, title, status, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?)
       ON CONFLICT(repo, path) DO UPDATE SET
         content = excluded.content,
         base_sha = excluded.base_sha,
         title = excluded.title,
         status = 'draft',
         updated_at = excluded.updated_at`,
    )
    .run(repo, path, content, baseSha, title, updatedAt);
}

export function getBlogDraft(repo: string, path: string): BlogDraftRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM blog_drafts WHERE repo = ? AND path = ?`)
      .get(repo, path) as BlogDraftRow | undefined) ?? null
  );
}

export function listBlogDrafts(repo: string): BlogDraftRow[] {
  return getDb()
    .prepare(`SELECT * FROM blog_drafts WHERE repo = ? ORDER BY updated_at DESC`)
    .all(repo) as BlogDraftRow[];
}

export function setBlogDraftPushed(
  repo: string,
  path: string,
  prNumber: number,
  branch: string,
): void {
  getDb()
    .prepare(
      `UPDATE blog_drafts SET status = 'pushed', pr_number = ?, pr_branch = ? WHERE repo = ? AND path = ?`,
    )
    .run(prNumber, branch, repo, path);
}

// Drop a stale PR pointer (PR merged/closed/deleted) so the next push opens a fresh PR.
export function clearBlogDraftPR(repo: string, path: string): void {
  getDb()
    .prepare(
      `UPDATE blog_drafts SET status = 'draft', pr_number = NULL, pr_branch = NULL WHERE repo = ? AND path = ?`,
    )
    .run(repo, path);
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

// First time an HA entity was seen unreadable (absent/unavailable/unknown).
// Insert-if-missing so the clock starts once and is not restarted by later
// ticks; cleared as soon as the entity reads a usable value again. HA Core
// restarts reset a template entity's last_changed, so a persistent blind spot
// can only be measured from claws' own durable record.
export function recordHaEntityUnavailable(entityId: string, now: number): number {
  const db = getDb();
  db.prepare(`INSERT INTO ha_entity_unavailable (entity_id, first_seen_at) VALUES (?, ?) ON CONFLICT(entity_id) DO NOTHING`).run(entityId, now);
  const row = db.prepare(`SELECT first_seen_at FROM ha_entity_unavailable WHERE entity_id = ?`).get(entityId) as { first_seen_at: number } | undefined;
  return row?.first_seen_at ?? now;
}

export function clearHaEntityUnavailable(entityId: string): void {
  getDb().prepare(`DELETE FROM ha_entity_unavailable WHERE entity_id = ?`).run(entityId);
}

export function clearHaEntityUnavailableForTests(): void {
  getDb().prepare(`DELETE FROM ha_entity_unavailable`).run();
}

// ── doc-maintainer human-intent backfill watermark ──
//
// The intent pass walks a repo's history BACKWARDS in dated chunks across
// successive nightly runs (a single unbounded pass would need thousands of
// per-item comment fetches). `oldest_scanned` is the oldest `YYYY-MM-DD` the
// walk has reached; `complete` flips to 1 once a chunk exhausts history.
// `window_exhausted` is the other terminal state: the walk consumed everything
// the fixed-size `gh list` window can reach but older history exists beyond it,
// so the walk stops WITHOUT having covered full history — distinguishable from
// `complete` so an operator can tell the two apart (clear the column to resume
// after raising the fetch limit).
// `source_version` records which INTENT_SOURCE_VERSION captured the walk; when
// doc-maintainer learns a new source (review comments, closed-unmerged PRs, …) it
// bumps that constant and the stale stamp restarts the walk so the new source
// reaches old items.
// An absent row means the backfill has never started for that repo.

/** Returns the backfill watermark for `repo`, or null if the walk never started. */
export function getIntentBackfillState(
  repo: string,
): { oldestScanned: string | null; complete: boolean; windowExhausted: boolean; sourceVersion: number } | null {
  const row = getDb()
    .prepare(`SELECT oldest_scanned, complete, window_exhausted, source_version FROM doc_intent_backfill WHERE repo = ?`)
    .get(repo) as { oldest_scanned: string | null; complete: number; window_exhausted: number; source_version: number } | undefined;
  if (!row) return null;
  return {
    oldestScanned: row.oldest_scanned,
    complete: row.complete === 1,
    windowExhausted: row.window_exhausted === 1,
    sourceVersion: row.source_version ?? 0,
  };
}

/** Records how far back the intent backfill has walked for `repo`. */
export function recordIntentBackfillChunk(
  repo: string,
  oldestScanned: string | null,
  complete: boolean,
  windowExhausted: boolean,
  sourceVersion: number,
): void {
  getDb().prepare(`
    INSERT INTO doc_intent_backfill (repo, oldest_scanned, complete, window_exhausted, source_version)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repo) DO UPDATE SET
      oldest_scanned = excluded.oldest_scanned,
      complete = excluded.complete,
      window_exhausted = excluded.window_exhausted,
      source_version = excluded.source_version,
      updated_at = datetime('now')
  `).run(repo, oldestScanned, complete ? 1 : 0, windowExhausted ? 1 : 0, sourceVersion);
}

/** Returns the SHA-256 digest of the agent memory files last folded into docs for `repo`, or null if never folded. */
export function getDocMemoryDigest(repo: string): string | null {
  const row = getDb()
    .prepare(`SELECT memory_digest FROM doc_intent_backfill WHERE repo = ?`)
    .get(repo) as { memory_digest: string | null } | undefined;
  return row?.memory_digest ?? null;
}

/** Records the digest of the agent memory files last folded into docs for `repo`. */
export function recordDocMemoryDigest(repo: string, digest: string): void {
  getDb().prepare(`
    INSERT INTO doc_intent_backfill (repo, memory_digest)
    VALUES (?, ?)
    ON CONFLICT(repo) DO UPDATE SET
      memory_digest = excluded.memory_digest,
      updated_at = datetime('now')
  `).run(repo, digest);
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
