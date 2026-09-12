import { createSqliteDriver, type SqlDriver } from "./db-driver.js";
import { createPgDriver, createPgLiteDriver } from "./db-driver-pg.js";
import { DB_PATH, DATABASE_URL, DATABASE_PASSWORD } from "./config.js";
import * as log from "./log.js";
import { buildFailureOutcome, PRE_WORK_FAILURE_CATEGORIES_SQL } from "./outcome.js";
import { recordGitHubEvent } from "./github-events.js";
import type { DmarcReport } from "./dmarc.js";

let driver: SqlDriver | null = null;

/**
 * Timestamp in SQLite's `datetime('now')` format — UTC, `YYYY-MM-DD HH:MM:SS`.
 * Every write that used to call `datetime('now')` in SQL now binds this instead,
 * so the SQL stays dialect-neutral while stored values (and the string
 * comparisons and ORDER BYs over them) keep their exact current form.
 */
function nowSql(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/** {@link nowSql} offset by `deltaMs` — the replacement for `datetime('now', '-N days')`. */
function nowSqlOffsetMs(deltaMs: number): string {
  return new Date(Date.now() + deltaMs).toISOString().slice(0, 19).replace("T", " ");
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Host and database name of a Postgres connection string — never the
 * credentials. Since fleet-infra#1300 the URL carries the password inline, so
 * this builds the label from parsed components only and degrades to a bare
 * "PostgreSQL" rather than ever echoing the string it was given.
 */
export function describePostgresTarget(url: string): string {
  try {
    const u = new URL(url);
    const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    const target = [host, database].filter(Boolean).join("/");
    return target ? `PostgreSQL (${target})` : "PostgreSQL";
  } catch {
    return "PostgreSQL";
  }
}

/** Human label for the active backend — safe to log and to render on /verify. */
export function describeDatabaseTarget(): string {
  if (DATABASE_URL) return describePostgresTarget(DATABASE_URL);
  if (process.env["CLAWS_TEST_PGLITE"] === "1") return "PGlite (test lane)";
  return `SQLite (${DB_PATH})`;
}

/** Picks the backend from the environment — never from `isContainer()`, so a
 *  container without CLAWS_DATABASE_URL still runs on its own SQLite file. */
async function openDriver(): Promise<SqlDriver> {
  const target = describeDatabaseTarget();
  log.info(`Database backend: ${target}`);
  if (DATABASE_URL) return createPgDriver({ url: DATABASE_URL, password: DATABASE_PASSWORD });
  if (process.env["CLAWS_TEST_PGLITE"] === "1") return await createPgLiteDriver();
  return createSqliteDriver(DB_PATH);
}

export async function initDb(): Promise<void> {
  driver = await openDriver();
  jobLogBuffer.length = 0;
  jobLogsDropped = 0;
  startJobLogDrain();

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            {{PK_AUTOINC}},
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

  await getDb().exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)
  `);

  await getDb().exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_repo_item ON tasks(repo, item_number)
  `);

  // Migration: add run_id column to tasks (links tasks to job_runs)
  await getDb().addColumn("tasks", "run_id", "TEXT");
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON tasks(run_id)`);

  // Migration: add outcome column to tasks (structured outcome metadata)
  await getDb().addColumn("tasks", "outcome", "TEXT");

  // Migration: add model_used column to tasks (tracks which Claude model was used)
  await getDb().addColumn("tasks", "model_used", "TEXT");

  // Migration: add provider_used column to tasks (tracks which AI provider was used)
  await getDb().addColumn("tasks", "provider_used", "TEXT");

  // Migration: add token and cost tracking columns
  await getDb().addColumn("tasks", "tokens_used", "INTEGER");
  await getDb().addColumn("tasks", "cost_usd", "DOUBLE PRECISION");

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS task_effectiveness_events (
      id            {{PK_AUTOINC}},
      task_id       INTEGER NOT NULL,
      source        TEXT NOT NULL,
      source_repo   TEXT NOT NULL,
      source_number INTEGER NOT NULL,
      source_sha    TEXT NOT NULL DEFAULT '',
      signal        TEXT NOT NULL,
      score         DOUBLE PRECISION,
      details       TEXT,
      created_at    TEXT NOT NULL DEFAULT {{NOW}}
    )
  `);
  await getDb().exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_effectiveness_unique
    ON task_effectiveness_events(task_id, source, source_repo, source_number, source_sha)
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_task_effectiveness_task ON task_effectiveness_events(task_id)`);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_task_effectiveness_source ON task_effectiveness_events(source_repo, source_number, source_sha)`);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS job_runs (
      id           {{PK_AUTOINC}},
      run_id       TEXT NOT NULL UNIQUE,
      job_name     TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'running',
      started_at   TEXT NOT NULL,
      completed_at TEXT
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_job_runs_job_name ON job_runs(job_name)`);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_job_runs_started_at ON job_runs(started_at)`);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS job_logs (
      id        {{PK_AUTOINC}},
      run_id    TEXT NOT NULL,
      level     TEXT NOT NULL,
      message   TEXT NOT NULL,
      logged_at TEXT NOT NULL
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_job_logs_run_id ON job_logs(run_id)`);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS queue_snapshots (
      id          {{PK_AUTOINC}},
      total_items INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_queue_snapshots_recorded_at ON queue_snapshots(recorded_at)`);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS work_queue (
      id            {{PK_AUTOINC}},
      kind          TEXT NOT NULL,
      repo          TEXT NOT NULL,
      item_number   INTEGER NOT NULL,
      args_json     TEXT NOT NULL DEFAULT '{}',
      priority      INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'queued',
      pid           INTEGER,
      attempts      INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      enqueued_at   TEXT NOT NULL DEFAULT {{NOW}},
      started_at    TEXT,
      completed_at  TEXT,
      run_id        TEXT
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_work_queue_dispatch ON work_queue(status, priority DESC, id ASC)`);
  await getDb().exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_queue_active ON work_queue(kind, repo, item_number) WHERE status IN ('queued', 'running')`);

  await getDb().exec(`
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
      synced_at      TEXT NOT NULL DEFAULT {{NOW}}
    )
  `);
  await getDb().addColumn("workflow_runs", "head_sha", "TEXT");
  await getDb().addColumn("workflow_runs", "html_url", "TEXT");
  await getDb().addColumn("workflow_runs", "run_attempt", "INTEGER");
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_repo ON workflow_runs(repo)`);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)`);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_created_at ON workflow_runs(created_at)`);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_synced_at ON workflow_runs(synced_at)`);

  await getDb().exec(`
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
  await getDb().addColumn("sessions", "summary", "TEXT");
  await getDb().addColumn("sessions", "summary_updated_at", "INTEGER");
  await getDb().addColumn("sessions", "extra_worktrees", "TEXT");
  await getDb().addColumn("sessions", "capabilities", "TEXT");
  await getDb().addColumn("sessions", "ended_at", "INTEGER");
  await getDb().addColumn("sessions", "resume_repos", "TEXT");
  await getDb().addColumn("sessions", "provider", "TEXT");
  await getDb().addColumn("sessions", "summary_manual", "INTEGER NOT NULL DEFAULT 0");
  await getDb().addColumn("sessions", "model", "TEXT");

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_events (
      id          {{PK_AUTOINC}},
      event_type  TEXT NOT NULL,
      detail      TEXT,
      occurred_at TEXT NOT NULL DEFAULT {{NOW}}
    )
  `);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS verification_reports (
      id         {{PK_AUTOINC}},
      ts         INTEGER NOT NULL,
      payload    TEXT NOT NULL
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_verification_reports_ts ON verification_reports(ts)`);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS processed_repos_daily (
      job_name      TEXT NOT NULL,
      repo          TEXT NOT NULL,
      local_date    TEXT NOT NULL,
      processed_at  TEXT NOT NULL DEFAULT {{NOW}},
      PRIMARY KEY (job_name, repo, local_date)
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_processed_repos_daily_date ON processed_repos_daily(local_date)`);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS ha_upgrader_state (
      entity_id      TEXT PRIMARY KEY,
      version        TEXT NOT NULL,
      first_seen_at  INTEGER NOT NULL,
      attempted_at   INTEGER NOT NULL DEFAULT 0,
      failure_count  INTEGER NOT NULL DEFAULT 0
    )
  `);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS ha_deploy_watcher_state (
      addon_slug          TEXT PRIMARY KEY,
      last_notified_sha   TEXT NOT NULL,
      last_seen_at        INTEGER NOT NULL
    )
  `);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS ha_entity_unavailable (
      entity_id      TEXT PRIMARY KEY,
      first_seen_at  INTEGER NOT NULL
    )
  `);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS doc_intent_backfill (
      repo            TEXT PRIMARY KEY,
      oldest_scanned  TEXT,
      complete        INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT {{NOW}}
    )
  `);
  await getDb().addColumn("doc_intent_backfill", "window_exhausted", "INTEGER NOT NULL DEFAULT 0");
  await getDb().addColumn("doc_intent_backfill", "source_version", "INTEGER NOT NULL DEFAULT 0");
  await getDb().addColumn("doc_intent_backfill", "memory_digest", "TEXT");

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS notified_untrusted_actors (
      repo          TEXT NOT NULL,
      issue_number  INTEGER NOT NULL,
      notified_at   TEXT NOT NULL DEFAULT {{NOW}},
      PRIMARY KEY (repo, issue_number)
    )
  `);

  await getDb().exec(`
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

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS reminder_notifications (
      repo         TEXT NOT NULL,
      reminder_id  TEXT NOT NULL,
      notify_on    TEXT NOT NULL,
      issue_number INTEGER,
      created_at   TEXT NOT NULL DEFAULT {{NOW}},
      PRIMARY KEY (repo, reminder_id, notify_on)
    )
  `);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS upstream_watch_fires (
      watch_id     TEXT NOT NULL,
      repo         TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      fired_at     TEXT NOT NULL DEFAULT {{NOW}},
      PRIMARY KEY (watch_id, repo, issue_number)
    )
  `);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS main_build_failures (
      run_id        TEXT PRIMARY KEY,
      repo          TEXT NOT NULL,
      workflow_name TEXT NOT NULL,
      run_url       TEXT NOT NULL,
      detected_at   TEXT NOT NULL DEFAULT {{NOW}},
      retried       INTEGER NOT NULL DEFAULT 0,
      outcome       TEXT,
      reported      INTEGER NOT NULL DEFAULT 0,
      closed_at     TEXT,
      event         TEXT NOT NULL DEFAULT ''
    )
  `);
  await getDb().addColumn("main_build_failures", "event", "TEXT NOT NULL DEFAULT ''");
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_main_build_failures_wf ON main_build_failures(repo, workflow_name)`);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS blog_draft_ports (
      repo         TEXT NOT NULL,
      path         TEXT NOT NULL,
      issue_number INTEGER,
      created_at   TEXT NOT NULL DEFAULT {{NOW}},
      PRIMARY KEY (repo, path)
    )
  `);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS promotion_actions (
      repo         TEXT NOT NULL,
      site_id      TEXT NOT NULL,
      channel_id   TEXT NOT NULL,
      target_repo  TEXT NOT NULL,
      issue_number INTEGER,
      title        TEXT NOT NULL,
      filed_at     TEXT NOT NULL DEFAULT {{NOW}}
    )
  `);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS shopping_searches (
      repo             TEXT NOT NULL,
      manifest         TEXT NOT NULL,
      item_id          TEXT NOT NULL,
      last_searched_at TEXT NOT NULL DEFAULT {{NOW}},
      result_json      TEXT NOT NULL,
      PRIMARY KEY (repo, manifest, item_id)
    )
  `);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS shopping_sourcing_errors (
      repo       TEXT NOT NULL,
      manifest   TEXT NOT NULL,
      error      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT {{NOW}},
      PRIMARY KEY (repo, manifest)
    )
  `);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS damp_readings (
      id           {{PK_AUTOINC}},
      location     TEXT NOT NULL,
      point        TEXT NOT NULL,
      value        DOUBLE PRECISION NOT NULL,
      reading_date TEXT NOT NULL,
      recorded_at  TEXT NOT NULL
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_damp_readings_point ON damp_readings(location, point)`);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_damp_readings_date ON damp_readings(reading_date DESC)`);

  await getDb().exec(`
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
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_dmarc_reports_domain ON dmarc_reports(domain, date_begin DESC)`);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS dmarc_rows (
      id            {{PK_AUTOINC}},
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
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_dmarc_rows_domain_date ON dmarc_rows(domain, date_begin)`);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_dmarc_rows_source_ip ON dmarc_rows(source_ip)`);

  await getDb().exec(`
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
  const dampSeed = await getDb().get(`SELECT COUNT(*) AS n FROM damp_readings WHERE location = ? AND point = ?`, ["Hall Closet", "utility"]) as { n: number };
  if (dampSeed.n === 0) {
    await getDb().run(`INSERT INTO damp_readings (location, point, value, reading_date, recorded_at) VALUES (?, ?, ?, ?, ?)`, ["Hall Closet", "utility", 0.5, "2026-07-02", "2026-07-02T00:00:00.000Z"]);
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
  for (const [r, n] of staleBotUntrustedRows) {
    await getDb().run(`DELETE FROM notified_untrusted_actors WHERE repo = ? AND issue_number = ?`, [r, n]);
  }

  log.info("Database initialized");
}

export interface TaskOutcome {
  commits?: number;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  prNumber?: number;
  prAction?: "created" | "updated" | "reviewed" | "skipped";
  headSha?: string;
  reviewResult?: "clean" | "advisory" | "blocking" | "escalated" | "empty-diff";
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

export interface TaskEffectivenessEventInput {
  taskId: number;
  source: string;
  sourceRepo: string;
  sourceNumber: number;
  sourceSha: string;
  signal: string;
  score: number | null;
  details?: unknown;
}

export interface RecentEffectivenessEvent {
  taskId: number;
  jobName: string;
  repo: string;
  itemNumber: number;
  provider: string;
  model: string;
  signal: string;
  score: number | null;
  source: string;
  sourceRepo: string;
  sourceNumber: number;
  sourceSha: string;
  details: string | null;
  createdAt: string;
}

function getDb(): SqlDriver {
  if (!driver) throw new Error("Database not initialized — call initDb() first");
  return driver;
}

let runIdProvider: (() => string | undefined) | null = null;

export function setRunIdProvider(provider: () => string | undefined): void {
  runIdProvider = provider;
}

export async function recordTaskStart(
  jobName: string,
  repo: string,
  itemNumber: number,
  triggerLabel: string | null,
): Promise<number> {
  const currentRunId = runIdProvider?.() ?? null;
  const result = await getDb().insert(
    `INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    [jobName, repo, itemNumber, triggerLabel, currentRunId, nowSql()],
  );
  recordGitHubEvent({ kind: "task-started", repo, number: itemNumber, related: [], detail: jobName });
  return result.id;
}

export async function updateTaskWorktree(
  taskId: number,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  await getDb().run(`UPDATE tasks SET worktree_path = ?, branch_name = ? WHERE id = ?`, [worktreePath, branchName, taskId]);
}

export async function updateTaskModel(taskId: number, model: string): Promise<void> {
  await getDb().run(`UPDATE tasks SET model_used = ? WHERE id = ?`, [model, taskId]);
}

export async function updateTaskProvider(taskId: number, provider: string): Promise<void> {
  await getDb().run(`UPDATE tasks SET provider_used = ? WHERE id = ?`, [provider, taskId]);
}

export async function updateTaskTokenUsage(taskId: number, tokensUsed: number, costUsd: number): Promise<void> {
  await getDb().run(`UPDATE tasks SET tokens_used = ?, cost_usd = ? WHERE id = ?`, [tokensUsed, costUsd, taskId]);
}

/**
 * Returns an onTokensUsed callback bound to taskId that persists cumulative
 * token/cost via updateTaskTokenUsage. The same callback may be reused across
 * multiple runClaude calls for one task — totals accumulate and the running
 * sum is written on every invocation. Never fires for providers without usage
 * data (e.g. Codex), so nothing is written in that case. Also records the
 * reporting backend into `tasks.provider_used` on every call that supplies
 * one; when a task spans two backends, the last reporter wins.
 *
 * The callback stays synchronous — `runClaude` invokes it from a stream handler
 * — so the writes are issued without being awaited. The driver serialises them
 * in call order, so the last write still wins.
 */
export function trackTaskTokens(taskId: number): (tokensUsed: number, costUsd: number, provider?: string) => void {
  let tokens = 0;
  let cost = 0;
  let lastProvider: string | undefined;
  return (t, c, provider) => {
    tokens += t;
    cost += c;
    void updateTaskTokenUsage(taskId, tokens, cost).catch((err: unknown) => {
      log.warn(`trackTaskTokens(${taskId}) usage write failed: ${err}`);
    });
    if (provider && provider !== lastProvider) {
      lastProvider = provider;
      void updateTaskProvider(taskId, provider).catch((err: unknown) => {
        log.warn(`trackTaskTokens(${taskId}) provider write failed: ${err}`);
      });
    }
  };
}

export async function recordTaskEffectivenessEvent(input: TaskEffectivenessEventInput): Promise<void> {
  const details = input.details === undefined || input.details === null
    ? null
    : typeof input.details === "string"
      ? input.details
      : JSON.stringify(input.details);
  await getDb().run(`
      INSERT INTO task_effectiveness_events
        (task_id, source, source_repo, source_number, source_sha, signal, score, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, source, source_repo, source_number, source_sha) DO UPDATE SET
        signal = excluded.signal,
        score = excluded.score,
        details = excluded.details,
        created_at = excluded.created_at
    `, [
      input.taskId,
      input.source,
      input.sourceRepo,
      input.sourceNumber,
      input.sourceSha,
      input.signal,
      input.score,
      details,
      nowSql(),
    ]);
}

export async function findLatestCompletedTaskForPrHead(repo: string, prNumber: number, headSha: string): Promise<Task | null> {
  const row = await getDb().get(`
      SELECT *
      FROM tasks
      WHERE repo = ?
        AND status = 'completed'
        AND outcome IS NOT NULL
        AND CAST(json_extract(outcome, '$.prNumber') AS INTEGER) = ?
        AND json_extract(outcome, '$.headSha') = ?
      ORDER BY completed_at DESC, id DESC
      LIMIT 1
    `, [repo, prNumber, headSha]) as Task | undefined;
  return row ?? null;
}

export async function getLastUsedByProvider(): Promise<Record<string, string | null>> {
  const rows = await getDb().all(`
      SELECT provider_used, MAX(completed_at) as last_used
      FROM tasks
      WHERE provider_used IS NOT NULL AND completed_at IS NOT NULL
      GROUP BY provider_used
    `) as Array<{ provider_used: string; last_used: string }>;
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
async function lookupTaskSubject(taskId: number): Promise<{ repo: string; item_number: number; job_name: string } | null> {
  try {
    const row = await getDb().get(`SELECT repo, item_number, job_name FROM tasks WHERE id = ?`, [taskId]) as { repo: string; item_number: number; job_name: string } | undefined;
    if (!row || typeof row.repo !== "string" || !row.repo) return null;
    return row;
  } catch (err) {
    log.warn(`lookupTaskSubject(${taskId}) failed: ${err}`);
    return null;
  }
}

export async function recordTaskComplete(taskId: number, outcome?: TaskOutcome): Promise<void> {
  const outcomeJson = outcome ? JSON.stringify(outcome) : null;
  await getDb().run(`UPDATE tasks SET status = 'completed', outcome = ?, completed_at = ? WHERE id = ?`, [outcomeJson, nowSql(), taskId]);
  const row = await lookupTaskSubject(taskId);
  if (row) recordGitHubEvent({ kind: "task-completed", repo: row.repo, number: row.item_number, related: [], detail: row.job_name });
}

export async function recordTaskFailed(taskId: number, error: string, outcome?: TaskOutcome): Promise<void> {
  const outcomeJson = outcome ? JSON.stringify(outcome) : null;
  await getDb().run(`UPDATE tasks SET status = 'failed', error = ?, outcome = ?, completed_at = ? WHERE id = ?`, [error, outcomeJson, nowSql(), taskId]);
  const row = await lookupTaskSubject(taskId);
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
  const taskId = await recordTaskStart(jobName, repo, itemNumber, triggerLabel);
  try {
    return await fn(taskId);
  } catch (err) {
    await recordTaskFailed(taskId, String(err), buildFailureOutcome(err));
    throw err;
  }
}

export async function getOrphanedTasks(): Promise<Task[]> {
  return await getDb().all(`SELECT * FROM tasks WHERE status = 'running'`) as Task[];
}

export async function getRunningTasks(): Promise<Task[]> {
  return await getDb().all(`SELECT * FROM tasks WHERE status = 'running' ORDER BY started_at ASC`) as Task[];
}

// ── Smart scheduling ledger ──

export async function markRepoProcessedDaily(jobName: string, repo: string, localDate: string): Promise<void> {
  await getDb().run(`INSERT OR IGNORE INTO processed_repos_daily (job_name, repo, local_date) VALUES (?, ?, ?)`, [jobName, repo, localDate]);
}

/**
 * Atomically records that we Slack-notified about an untrusted-actor dispatch
 * skip for this issue. Returns true if this is the FIRST time (row inserted) —
 * the caller should send the Slack message. Returns false if a row already
 * existed — the caller should stay silent. Durable across process restarts,
 * unlike an in-memory Set, so a still-ignored issue is notified at most once ever.
 */
export async function markUntrustedActorNotified(repo: string, issueNumber: number): Promise<boolean> {
  const result = await getDb().run(`INSERT OR IGNORE INTO notified_untrusted_actors (repo, issue_number) VALUES (?, ?)`, [repo, issueNumber]);
  return result.changes === 1;
}

/** Returns a map of repo → most-recent `processed_at` (epoch ms) for the given job.
 *  SQLite stores `datetime('now')` as `"YYYY-MM-DD HH:MM:SS"` in UTC; we convert to
 *  epoch ms by appending `T` + `Z` so JS Date.parse treats it as UTC. */
export async function getLastProcessedTimestampsForJob(jobName: string): Promise<Map<string, number>> {
  const rows = await getDb().all(`SELECT repo, MAX(processed_at) AS ts FROM processed_repos_daily WHERE job_name = ? GROUP BY repo`, [jobName]) as { repo: string; ts: string }[];
  const map = new Map<string, number>();
  for (const r of rows) {
    if (!r.ts) continue;
    const epochMs = Date.parse(r.ts.replace(" ", "T") + "Z");
    if (!Number.isNaN(epochMs)) map.set(r.repo, epochMs);
  }
  return map;
}

export async function pruneProcessedReposDailyOlderThan(daysToKeep: number): Promise<number> {
  const result = await getDb().run(`DELETE FROM processed_repos_daily WHERE local_date < ?`, [nowSqlOffsetMs(-daysToKeep * DAY_MS).slice(0, 10)]);
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

export async function enqueueWork(
  kind: string,
  repo: string,
  itemNumber: number,
  opts: { priority?: boolean; args?: Record<string, unknown> } = {},
): Promise<EnqueueResult | null> {
  const priority = opts.priority ? 1 : 0;
  const argsJson = JSON.stringify(opts.args ?? {});
  const result = await getDb().insert(`
      INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, enqueued_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?)
      ON CONFLICT(kind, repo, item_number) WHERE status IN ('queued', 'running') DO NOTHING
    `, [kind, repo, itemNumber, argsJson, priority, nowSql()]);
  if (result.changes === 1) {
    return { id: result.id, alreadyQueued: false };
  }
  // No insert — the row already exists in queued/running state. Return its id.
  const existing = await getDb().get(`SELECT id FROM work_queue WHERE kind = ? AND repo = ? AND item_number = ? AND status IN ('queued', 'running') LIMIT 1`, [kind, repo, itemNumber]) as { id: number } | undefined;
  return existing ? { id: existing.id, alreadyQueued: true } : null;
}

export async function claimNextWork(runId: string | null): Promise<WorkQueueRow | null> {
  const d = getDb();
  if (d.dialect === "postgres") {
    // One statement, no explicit transaction: SKIP LOCKED lets concurrent
    // claimers step over each other's rows instead of serialising on the head
    // of the queue.
    const rows = await d.all<WorkQueueRow>(`
      UPDATE work_queue
      SET status = 'running',
          pid = ?,
          started_at = ?,
          attempts = attempts + 1,
          run_id = ?
      WHERE id = (SELECT id FROM work_queue WHERE status = 'queued'
                  ORDER BY priority DESC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *
    `, [process.pid, nowSql(), runId]);
    return rows[0] ?? null;
  }
  return await d.transaction(async (tx) => {
    const row = await tx.get<WorkQueueRow>(`
      SELECT * FROM work_queue
      WHERE status = 'queued'
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `);
    if (!row) return null;
    await tx.run(`
      UPDATE work_queue
      SET status = 'running',
          pid = ?,
          started_at = ?,
          attempts = attempts + 1,
          run_id = ?
      WHERE id = ?
    `, [process.pid, nowSql(), runId, row.id]);
    return (await tx.get<WorkQueueRow>(`SELECT * FROM work_queue WHERE id = ?`, [row.id])) ?? null;
  });
}

export async function markWorkSucceeded(id: number): Promise<void> {
  await getDb().run(`UPDATE work_queue SET status = 'completed', completed_at = ?, error_message = NULL WHERE id = ?`, [nowSql(), id]);
}

export async function markWorkFailed(id: number, errorMessage: string): Promise<void> {
  await getDb().run(`UPDATE work_queue SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ?`, [nowSql(), errorMessage.slice(0, 4000), id]);
}

/** Terminal 'cancelled' state for a work row whose run was cancelled by an
 *  operator (POST /cancel or POST /logs/:runId/cancel) while the service kept
 *  running. Must not be left 'running': recoverWorkOnStartup() only resets rows
 *  whose pid differs from the live process, so a row left running by a
 *  no-restart cancellation blocks re-enqueue forever via idx_work_queue_active
 *  (#2685). */
export async function markWorkCancelled(id: number, reason: string): Promise<void> {
  await getDb().run(`UPDATE work_queue SET status = 'cancelled', completed_at = ?, error_message = ? WHERE id = ?`, [nowSql(), reason.slice(0, 4000), id]);
}

export async function listQueuedWork(limit = 200): Promise<WorkQueueRow[]> {
  return await getDb().all(`
      SELECT * FROM work_queue
      WHERE status IN ('queued', 'running')
      ORDER BY status DESC, priority DESC, id ASC
      LIMIT ?
    `, [limit]) as WorkQueueRow[];
}

export async function countWorkByStatus(): Promise<Record<string, number>> {
  const rows = await getDb().all(`SELECT status, COUNT(*) as cnt FROM work_queue GROUP BY status`) as Array<{ status: string; cnt: number }>;
  const result: Record<string, number> = {};
  for (const r of rows) result[r.status] = r.cnt;
  return result;
}

/** Count running+queued work_queue rows whose `kind` is NOT in the excluded set.
 *  Used by smart-schedule to ignore long-running PR work when deciding whether
 *  the system is "busy". */
export async function countActiveWorkExcludingKinds(excludedKinds: string[]): Promise<number> {
  if (excludedKinds.length === 0) {
    const row = await getDb().get(`SELECT COUNT(*) AS cnt FROM work_queue WHERE status IN ('queued', 'running')`) as { cnt: number };
    return row.cnt;
  }
  const placeholders = excludedKinds.map(() => "?").join(",");
  const row = await getDb().get(`SELECT COUNT(*) AS cnt FROM work_queue WHERE status IN ('queued', 'running') AND kind NOT IN (${placeholders})`, [...excludedKinds]) as { cnt: number };
  return row.cnt;
}

export async function recoverWorkOnStartup(): Promise<{ resetRunning: number }> {
  const result = await getDb().run(`
      UPDATE work_queue
      SET status = 'queued', pid = NULL, started_at = NULL
      WHERE status = 'running' AND (pid IS NULL OR pid != ?)
    `, [process.pid]);
  return { resetRunning: Number(result.changes) };
}

export async function pruneWorkQueue(retentionHours = 168): Promise<number> {
  const result = await getDb().run(`
      DELETE FROM work_queue
      WHERE status IN ('completed', 'failed', 'cancelled')
        AND completed_at < ?
    `, [nowSqlOffsetMs(-retentionHours * 60 * 60 * 1000)]);
  return Number(result.changes);
}

/** Active = currently running. Used by auto-merger sweep to skip PRs being modified. */
export async function hasActiveWorkForPR(repo: string, prNumber: number, kinds: string[]): Promise<boolean> {
  if (kinds.length === 0) return false;
  const placeholders = kinds.map(() => "?").join(",");
  const row = await getDb().get(`
      SELECT 1 FROM work_queue
      WHERE status = 'running'
        AND repo = ?
        AND item_number = ?
        AND kind IN (${placeholders})
      LIMIT 1
    `, [repo, prNumber, ...kinds]);
  return row !== undefined;
}

/** @internal — for tests only */
export async function clearAllWorkQueueForTests(): Promise<void> {
  await getDb().run(`DELETE FROM work_queue`);
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
  runId: string;
  level: string;
  message: string;
  loggedAt: string;
}

/** Bounded so a database outage costs log lines rather than the process's memory. */
const JOB_LOG_BUFFER_LIMIT = 10_000;
const JOB_LOG_BATCH_SIZE = 200;
const JOB_LOG_DRAIN_MS = 250;

const jobLogBuffer: BufferedJobLog[] = [];
let jobLogsDropped = 0;
let jobLogDrainTimer: NodeJS.Timeout | null = null;
let jobLogDrainInFlight = false;

/**
 * Buffers one job log line. Deliberately synchronous and void-returning: every
 * `log.*` call in the service funnels through here, and `src/log.ts` must stay
 * free of awaits. The rows are written by {@link startJobLogDrain}'s timer.
 *
 * Diagnostics here use `console.*`, never `log.*` — log.ts calls back into this
 * function, so a `log.warn` would recurse.
 */
export function insertJobLog(runId: string, level: string, message: string): void {
  if (jobLogBuffer.length >= JOB_LOG_BUFFER_LIMIT) {
    jobLogBuffer.shift();
    jobLogsDropped++;
    if (jobLogsDropped % 1_000 === 1) {
      console.warn(`[db] job_logs buffer full — dropped ${jobLogsDropped} log lines`);
    }
  }
  jobLogBuffer.push({ runId, level, message, loggedAt: nowSql() });
}

/** Writes one batch of buffered log lines. Returns false when there was nothing to write. */
async function drainJobLogBatch(): Promise<boolean> {
  if (jobLogBuffer.length === 0 || !driver) return false;
  const batch = jobLogBuffer.splice(0, JOB_LOG_BATCH_SIZE);
  const values = batch.map(() => "(?, ?, ?, ?)").join(", ");
  const params: unknown[] = [];
  for (const entry of batch) params.push(entry.runId, entry.level, entry.message, entry.loggedAt);
  try {
    await getDb().run(`INSERT INTO job_logs (run_id, level, message, logged_at) VALUES ${values}`, params);
  } catch (err) {
    // Matches the pre-buffer behaviour: a DB error must never interrupt the job
    // that emitted the line. console.error, not log.error — log.ts recurses here.
    console.error(`[db] job_logs insert failed: ${err}`);
    // Requeue so a transient failure costs a retry on the next drain tick rather
    // than silently dropping the batch; bounded so a persistent outage still
    // costs log lines rather than memory.
    const room = JOB_LOG_BUFFER_LIMIT - jobLogBuffer.length;
    if (room > 0) jobLogBuffer.unshift(...batch.slice(0, room));
    return false;
  }
  return true;
}

function startJobLogDrain(): void {
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

export async function getRecentJobRuns(limit = 50, jobFilter?: string): Promise<JobRun[]> {
  if (jobFilter) {
    return await getDb().all(`SELECT run_id, job_name, status, started_at, completed_at FROM job_runs WHERE job_name = ? ORDER BY started_at DESC LIMIT ?`, [jobFilter, limit]) as JobRun[];
  }
  return await getDb().all(`SELECT run_id, job_name, status, started_at, completed_at FROM job_runs ORDER BY started_at DESC LIMIT ?`, [limit]) as JobRun[];
}

export async function getDistinctJobNames(): Promise<string[]> {
  return (await getDb().all(`SELECT DISTINCT job_name FROM job_runs ORDER BY job_name`))
    .map((r: any) => r.job_name);
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
  return await getDb().all(`SELECT * FROM tasks WHERE run_id = ? ORDER BY id ASC`, [runId]) as Task[];
}

export async function getWorkItemsForRuns(runIds: string[]): Promise<Map<string, Task[]>> {
  if (runIds.length === 0) return new Map();
  const placeholders = runIds.map(() => "?").join(",");
  const rows = await getDb().all(`SELECT * FROM tasks WHERE run_id IN (${placeholders}) ORDER BY id ASC`, [...runIds]) as Task[];
  const map = new Map<string, Task[]>();
  for (const row of rows) {
    if (!row.run_id) continue;
    const list = map.get(row.run_id) ?? [];
    list.push(row);
    map.set(row.run_id, list);
  }
  return map;
}

export async function getRecentWorkItems(limit = 10): Promise<Array<{ repo: string; item_number: number }>> {
  return await getDb().all(`
      SELECT repo, item_number, MAX(started_at) AS last_seen
      FROM tasks
      WHERE item_number > 0
      GROUP BY repo, item_number
      ORDER BY last_seen DESC
      LIMIT ?
    `, [limit]) as Array<{ repo: string; item_number: number }>;
}

export async function getRunsForIssue(repo: string, itemNumber: number): Promise<JobRun[]> {
  return await getDb().all(`
      SELECT DISTINCT jr.run_id, jr.job_name, jr.status, jr.started_at, jr.completed_at
      FROM job_runs jr
      INNER JOIN tasks t ON t.run_id = jr.run_id
      WHERE t.repo = ? AND t.item_number = ?
      ORDER BY jr.started_at DESC
    `, [repo, itemNumber]) as JobRun[];
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

export async function searchRunsByItem(search: string, limit = 50): Promise<JobRun[]> {
  const hashMatch = search.match(/^(.+)#(\d+)$/);
  if (hashMatch) {
    const [, repoPart, numberPart] = hashMatch;
    return await getDb().all(`
        SELECT DISTINCT jr.run_id, jr.job_name, jr.status, jr.started_at, jr.completed_at
        FROM job_runs jr
        INNER JOIN tasks t ON t.run_id = jr.run_id
        WHERE t.repo LIKE ? AND CAST(t.item_number AS TEXT) = ?
        ORDER BY jr.started_at DESC LIMIT ?
      `, [`%${repoPart}%`, numberPart, limit]) as JobRun[];
  }

  return await getDb().all(`
      SELECT DISTINCT jr.run_id, jr.job_name, jr.status, jr.started_at, jr.completed_at
      FROM job_runs jr
      INNER JOIN tasks t ON t.run_id = jr.run_id
      WHERE t.repo LIKE ? OR CAST(t.item_number AS TEXT) = ?
      ORDER BY jr.started_at DESC LIMIT ?
    `, [`%${search}%`, search, limit]) as JobRun[];
}

export async function countRecentTimeouts(repo: string, itemNumber: number, windowMs: number = 2 * 60 * 60 * 1000): Promise<number> {
  // Format cutoff to match SQLite's datetime() format (YYYY-MM-DD HH:MM:SS)
  const cutoff = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const row = await getDb().get(`SELECT COUNT(*) AS cnt FROM tasks
       WHERE repo = ? AND item_number = ? AND status = 'failed'
       AND error LIKE '%timed out%'
       AND completed_at > ?`, [repo, itemNumber, cutoff]) as { cnt: number };
  return row.cnt;
}

/** Number of task rows this job has started for `repo` within `windowMs`. Used by
 *  improvement-identifier to throttle its expensive whole-repo analysis. */
export async function countRecentTasksForJobRepo(jobName: string, repo: string, windowMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const row = await getDb().get(`SELECT COUNT(*) AS n FROM tasks WHERE job_name = ? AND repo = ? AND started_at >= ?`, [jobName, repo, cutoff]) as { n: number };
  return row.n;
}

export async function countRecentMemoryLimits(repo: string, itemNumber: number, windowMs: number = 2 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const row = await getDb().get(`SELECT COUNT(*) AS cnt FROM tasks
       WHERE repo = ? AND item_number = ? AND status = 'failed'
       AND error LIKE '%exceeded memory limit%'
       AND completed_at > ?`, [repo, itemNumber, cutoff]) as { cnt: number };
  return row.cnt;
}

export async function countRecentNoCommitCompletions(
  repo: string,
  itemNumber: number,
  windowMs: number = 6 * 60 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const row = await getDb().get(`SELECT COUNT(*) AS cnt FROM tasks
       WHERE job_name = 'issue-worker'
       AND repo = ? AND item_number = ? AND status = 'completed'
       AND CAST(json_extract(outcome, '$.commits') AS INTEGER) = 0
       AND json_extract(outcome, '$.prNumber') IS NULL
       AND completed_at > ?
       AND completed_at > COALESCE(
         (SELECT MAX(completed_at) FROM tasks
          WHERE job_name = 'issue-worker'
          AND repo = ? AND item_number = ? AND status = 'completed'
          AND json_extract(outcome, '$.prNumber') IS NOT NULL),
         '1970-01-01')`, [repo, itemNumber, cutoff, repo, itemNumber]) as { cnt: number };
  return row.cnt;
}

export async function hasPreviousCiFixerTasks(repo: string, prNumber: number): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 FROM tasks WHERE job_name = 'ci-fixer' AND repo = ? AND item_number = ? AND status = 'completed' LIMIT 1`, [repo, prNumber]);
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
export async function getCIFixerBreakerState(repo: string, prNumber: number): Promise<CIFixerBreakerState | undefined> {
  const row = await getDb().get(`SELECT tripped_sha, tripped_at, last_claws_sha, budget_floor_at, grants
       FROM ci_fixer_breaker WHERE repo = ? AND item_number = ?`, [repo, prNumber]) as
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
export async function recordCIFixerBreakerTrip(repo: string, prNumber: number, headSha: string | null): Promise<void> {
  await getDb().run(`INSERT INTO ci_fixer_breaker (repo, item_number, tripped_sha, tripped_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo, item_number) DO UPDATE SET
         tripped_sha = excluded.tripped_sha,
         tripped_at  = excluded.tripped_at`, [repo, prNumber, headSha, new Date().toISOString()]);
}

/**
 * Record a head SHA that Claws itself pushed to a PR branch. Guards the
 * new-commit grant against Claws resetting its own budget with its own fixes.
 */
export async function recordCIFixerPush(repo: string, prNumber: number, headSha: string): Promise<void> {
  await getDb().run(`INSERT INTO ci_fixer_breaker (repo, item_number, last_claws_sha)
       VALUES (?, ?, ?)
       ON CONFLICT(repo, item_number) DO UPDATE SET last_claws_sha = excluded.last_claws_sha`, [repo, prNumber, headSha]);
}

/**
 * Grant a fresh fix budget after a new head commit. Clears the trip, advances
 * the budget floor so pre-trip attempts stop counting, and either resets the
 * lifetime grant count (the new head is green) or spends one grant.
 */
export async function recordCIFixerBreakerGrant(repo: string, prNumber: number, opts: { recovered: boolean }): Promise<void> {
  const now = new Date().toISOString();
  await getDb().run(`INSERT INTO ci_fixer_breaker (repo, item_number, tripped_sha, tripped_at, budget_floor_at, grants)
       VALUES (?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(repo, item_number) DO UPDATE SET
         tripped_sha     = NULL,
         tripped_at      = NULL,
         budget_floor_at = excluded.budget_floor_at,
         grants          = ${opts.recovered ? "0" : "ci_fixer_breaker.grants + 1"}`, [repo, prNumber, now, opts.recovered ? 0 : 1]);
}

/**
 * Full reset for "a human (or the diagnoser) cleared the problematic label" —
 * drops the trip, zeroes the lifetime grants and advances the budget floor so
 * the pre-existing attempts in the 24h window can't immediately re-trip.
 */
export async function resetCIFixerBreakerGrants(repo: string, prNumber: number): Promise<void> {
  await getDb().run(`INSERT INTO ci_fixer_breaker (repo, item_number, tripped_sha, tripped_at, budget_floor_at, grants)
       VALUES (?, ?, NULL, NULL, ?, 0)
       ON CONFLICT(repo, item_number) DO UPDATE SET
         tripped_sha     = NULL,
         tripped_at      = NULL,
         budget_floor_at = excluded.budget_floor_at,
         grants          = 0`, [repo, prNumber, new Date().toISOString()]);
}

/**
 * Count CI fixer attempts for a PR within a time window.
 * Returns counts for total attempts, failed attempts, and successful attempts.
 * `preWorkFailed` counts attempts that failed before the agent ran (see
 * `PRE_WORK_FAILURE_CATEGORIES`) — callers subtract these from `failed` so a
 * provider outage does not trip the CI-fix circuit breaker.
 *
 * `sinceIso` is an optional budget floor (ISO timestamp): when it is newer than
 * the window cutoff, attempts before it are excluded. An older floor never
 * widens the window.
 */
export async function countCIFixerAttempts(
  repo: string,
  prNumber: number,
  windowMs: number = 24 * 60 * 60 * 1000, // 24 hours default
  sinceIso?: string | null,
): Promise<{ total: number; failed: number; successful: number; preWorkFailed: number }> {
  const windowCutoff = new Date(Date.now() - windowMs).toISOString();
  const cutoff = sinceIso && sinceIso > windowCutoff ? sinceIso : windowCutoff;
  const result = await getDb().get(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as successful,
        COALESCE(SUM(CASE WHEN status = 'failed'
          AND json_extract(outcome, '$.failureCategory') IN (${PRE_WORK_FAILURE_CATEGORIES_SQL})
          THEN 1 ELSE 0 END), 0) as "preWorkFailed"
      FROM tasks
      -- Conflict resolution has its own budget (countConflictResolutionAttempts) so a
      -- conflict loop cannot exhaust the CI-fix budget or vice-versa (#2389).
      WHERE (job_name = 'ci-fixer' OR (job_name LIKE 'ci-fixer:%' AND job_name != 'ci-fixer:merge-conflict'))
        AND repo = ?
        AND item_number = ?
        AND datetime(started_at) >= datetime(?)
    `, [repo, prNumber, cutoff]) as { total: number; failed: number; successful: number; preWorkFailed: number };
  return result;
}

/**
 * Count merge-conflict resolution attempts for a PR within a window.
 * `unproductive` counts attempts that failed after the agent had a chance to
 * work, or completed without producing a commit — a successful resolution is
 * progress, not a loop, so it does not consume the conflict budget (#2389).
 * Attempts that failed before the agent ran (see `PRE_WORK_FAILURE_CATEGORIES`)
 * still count in `total` (so the dashboard/task history stay honest) but not in
 * `unproductive`. `recentPreWorkFailed` counts such failures within
 * `providerBackoffMs` of now, so callers can back off instead of re-dispatching
 * into an ongoing outage (#2977).
 */
export async function countConflictResolutionAttempts(
  repo: string,
  prNumber: number,
  windowMs: number = 24 * 60 * 60 * 1000,
  providerBackoffMs: number = 0,
): Promise<{ total: number; unproductive: number; preWorkFailed: number; recentPreWorkFailed: number }> {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const backoffCutoff = new Date(Date.now() - providerBackoffMs).toISOString();
  const result = await getDb().get(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN (status = 'failed'
            AND COALESCE(json_extract(outcome, '$.failureCategory'), '') NOT IN (${PRE_WORK_FAILURE_CATEGORIES_SQL}))
          OR (status = 'completed' AND COALESCE(CAST(json_extract(outcome, '$.commits') AS INTEGER), 0) = 0)
          THEN 1 ELSE 0 END), 0) AS unproductive,
        COALESCE(SUM(CASE WHEN status = 'failed'
          AND json_extract(outcome, '$.failureCategory') IN (${PRE_WORK_FAILURE_CATEGORIES_SQL})
          THEN 1 ELSE 0 END), 0) AS "preWorkFailed",
        COALESCE(SUM(CASE WHEN status = 'failed'
          AND json_extract(outcome, '$.failureCategory') IN (${PRE_WORK_FAILURE_CATEGORIES_SQL})
          AND datetime(started_at) >= datetime(?)
          THEN 1 ELSE 0 END), 0) AS "recentPreWorkFailed"
      FROM tasks
      WHERE job_name = 'ci-fixer:merge-conflict'
        AND repo = ?
        AND item_number = ?
        AND datetime(started_at) >= datetime(?)
    `, [backoffCutoff, repo, prNumber, cutoff]) as { total: number; unproductive: number; preWorkFailed: number; recentPreWorkFailed: number };
  return result;
}

/**
 * Get recent CI fixer error messages for a PR.
 * Used to provide context when marking a PR as problematic.
 */
export async function getRecentCIFixerErrors(
  repo: string,
  prNumber: number,
  limit: number = 5,
): Promise<Array<{ error: string; timestamp: string }>> {
  return await getDb().all(`
      SELECT error, completed_at as timestamp
      FROM tasks
      WHERE (job_name = 'ci-fixer' OR job_name LIKE 'ci-fixer:%')
        AND repo = ?
        AND item_number = ?
        AND status = 'failed'
        AND error IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT ?
    `, [repo, prNumber, limit]) as Array<{ error: string; timestamp: string }>;
}

export async function pruneOldLogs(retentionDays: number, keepPerJob = 20): Promise<number> {
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
  return result.changes;
}

/**
 * Delete terminal task rows older than the retention period. Never deletes
 * `running` rows — startup orphan recovery (`getOrphanedTasks`) depends on them.
 * Rows whose `run_id` still exists in `job_runs` are kept so the dashboard's
 * retained run pages (`getTasksByRunId`) don't render with an empty task list.
 */
export async function pruneTasks(retentionDays = 90): Promise<number> {
  const result = await getDb().run(`
      DELETE FROM tasks
      WHERE status IN ('completed', 'failed')
        AND COALESCE(completed_at, started_at) < ?
        AND (run_id IS NULL OR run_id NOT IN (SELECT run_id FROM job_runs))
    `, [nowSqlOffsetMs(-retentionDays * DAY_MS)]);
  return Number(result.changes);
}

// ── Queue snapshots & average durations ──

/** Batch-fetch average durations for all job prefixes, keyed by the prefix before the first
 *  colon (so "ci-fixer:revert" and "ci-fixer:merge-conflict" both roll up under "ci-fixer").
 *  Considers only the most recent `limit` completed tasks per prefix. Duration comes from SQL
 *  `strftime('%s')`, which truncates to whole seconds — negligible for tasks running minutes. */
export async function getAllAverageTaskDurations(limit = 20): Promise<Record<string, number>> {
  const rows = await getDb().all(`SELECT job_prefix, AVG(duration_ms) as avg_ms FROM (
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
      ) AS ranked
      WHERE rn <= ?
      GROUP BY job_prefix`, [limit]) as Array<{ job_prefix: string; avg_ms: number }>;
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.job_prefix] = Math.round(row.avg_ms);
  }
  return result;
}

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
  const result = await getDb().run(`DELETE FROM queue_snapshots WHERE recorded_at < ?`, [nowSqlOffsetMs(-retentionHours * 60 * 60 * 1000)]);
  return result.changes;
}

export async function pruneWorkflowRuns(retentionDays = 30): Promise<number> {
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
): Promise<void> {
  await getDb().run(`
      INSERT OR IGNORE INTO main_build_failures (run_id, repo, workflow_name, run_url, retried, outcome, event)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [runId, repo, workflowName, runUrl, retried ? 1 : 0, outcome, event]);
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
  const result = await getDb().run(`DELETE FROM main_build_failures WHERE detected_at < ?`, [nowSqlOffsetMs(-retentionDays * DAY_MS)]);
  return result.changes;
}

// ── Per-repo queries ──

export async function getRecentTasksForRepo(repo: string, limit = 20): Promise<Task[]> {
  return await getDb().all(`SELECT * FROM tasks WHERE repo = ? ORDER BY started_at DESC LIMIT ?`, [repo, limit]) as Task[];
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

export async function getLastTaskTimePerRepo(): Promise<Map<string, string>> {
  const rows = await getDb().all(`SELECT repo, MAX(started_at) AS last_task FROM tasks GROUP BY repo`) as Array<{ repo: string; last_task: string }>;
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.repo, row.last_task);
  return map;
}

// ── Usage / cost aggregation ──

export interface UsageStats {
  repoStats: Array<UsageStatRow & { repo: string }>;
  jobStats: Array<UsageStatRow & { jobName: string }>;
  providerStats: Array<UsageStatRow & { provider: string; model: string }>;
}

export interface UsageTotals {
  taskCount: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface UsageStatRow {
  taskCount: number;
  completedCount: number;
  failedCount: number;
  changedCount: number;
  prCreatedCount: number;
  reviewClean: number;
  reviewAdvisory: number;
  reviewBlocking: number;
  reviewEscalated: number;
  reviewEmptyDiff: number;
  mergedCount: number;
  reviewScoreTotal: number;
  reviewScoreCount: number;
  totalTokens: number;
  totalCostUsd: number;
  avgDurationSeconds: number | null;
}

export interface UsageFilters {
  repo?: string;
  job?: string;      // job-name prefix, matching the jobStats grouping
  provider?: string; // "unknown" matches rows with NULL provider_used
  model?: string;    // "unknown" matches rows with NULL model_used
}

const JOB_PREFIX_SQL = `CASE WHEN INSTR(job_name, ':') > 0 THEN SUBSTR(job_name, 1, INSTR(job_name, ':') - 1) ELSE job_name END`;
const USAGE_BASE_SQL = `(tokens_used IS NOT NULL OR provider_used IS NOT NULL OR model_used IS NOT NULL)`;
const EFFECTIVENESS_JOIN_SQL = `
      LEFT JOIN (
        SELECT task_id,
               SUM(CASE WHEN signal = 'pr-review-clean' THEN 1 ELSE 0 END) AS review_clean,
               SUM(CASE WHEN signal = 'pr-review-advisory' THEN 1 ELSE 0 END) AS review_advisory,
               SUM(CASE WHEN signal = 'pr-review-blocking' THEN 1 ELSE 0 END) AS review_blocking,
               SUM(CASE WHEN signal = 'pr-review-escalated' THEN 1 ELSE 0 END) AS review_escalated,
               SUM(CASE WHEN signal = 'pr-review-empty-diff' THEN 1 ELSE 0 END) AS review_empty_diff,
               SUM(CASE WHEN signal = 'pr-merged' THEN 1 ELSE 0 END) AS merged_count,
               COALESCE(SUM(CASE WHEN source = 'pr-review' AND score IS NOT NULL THEN score ELSE 0 END), 0) AS review_score_total,
               SUM(CASE WHEN source = 'pr-review' AND score IS NOT NULL THEN 1 ELSE 0 END) AS review_score_count
        FROM task_effectiveness_events
        GROUP BY task_id
      ) te ON te.task_id = tasks.id
`;
const USAGE_AGG_SQL = `
             COUNT(*) AS task_count,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
             SUM(CASE WHEN status = 'completed' AND CAST(json_extract(outcome, '$.commits') AS INTEGER) > 0 THEN 1 ELSE 0 END) AS changed_count,
             SUM(CASE WHEN json_extract(outcome, '$.prAction') = 'created' THEN 1 ELSE 0 END) AS pr_created_count,
             COALESCE(SUM(te.review_clean), 0) AS review_clean,
             COALESCE(SUM(te.review_advisory), 0) AS review_advisory,
             COALESCE(SUM(te.review_blocking), 0) AS review_blocking,
             COALESCE(SUM(te.review_escalated), 0) AS review_escalated,
             COALESCE(SUM(te.review_empty_diff), 0) AS review_empty_diff,
             COALESCE(SUM(te.merged_count), 0) AS merged_count,
             COALESCE(SUM(te.review_score_total), 0) AS review_score_total,
             COALESCE(SUM(te.review_score_count), 0) AS review_score_count,
             COALESCE(SUM(tokens_used), 0) AS total_tokens,
             COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
             AVG(CASE WHEN status IN ('completed', 'failed') AND completed_at IS NOT NULL THEN (julianday(completed_at) - julianday(started_at)) * 86400.0 END) AS avg_duration_seconds
`;

type UsageAggRow = {
  task_count: number;
  completed_count: number;
  failed_count: number;
  changed_count: number;
  pr_created_count: number;
  review_clean: number;
  review_advisory: number;
  review_blocking: number;
  review_escalated: number;
  review_empty_diff: number;
  merged_count: number;
  review_score_total: number;
  review_score_count: number;
  total_tokens: number;
  total_cost_usd: number;
  avg_duration_seconds: number | null;
};

function mapUsageAgg(r: UsageAggRow): UsageStatRow {
  return {
    taskCount: r.task_count,
    completedCount: r.completed_count,
    failedCount: r.failed_count,
    changedCount: r.changed_count,
    prCreatedCount: r.pr_created_count,
    reviewClean: r.review_clean,
    reviewAdvisory: r.review_advisory,
    reviewBlocking: r.review_blocking,
    reviewEscalated: r.review_escalated,
    reviewEmptyDiff: r.review_empty_diff,
    mergedCount: r.merged_count,
    reviewScoreTotal: r.review_score_total,
    reviewScoreCount: r.review_score_count,
    totalTokens: r.total_tokens,
    totalCostUsd: r.total_cost_usd,
    avgDurationSeconds: r.avg_duration_seconds,
  };
}

function usageWhere(days: number, filters?: UsageFilters): { sql: string; params: unknown[] } {
  const clauses = [USAGE_BASE_SQL, `started_at >= ?`];
  const params: unknown[] = [nowSqlOffsetMs(-days * DAY_MS)];
  if (filters?.repo) { clauses.push(`repo = ?`); params.push(filters.repo); }
  if (filters?.job) { clauses.push(`${JOB_PREFIX_SQL} = ?`); params.push(filters.job); }
  if (filters?.provider) { clauses.push(`COALESCE(provider_used, 'unknown') = ?`); params.push(filters.provider); }
  if (filters?.model) { clauses.push(`COALESCE(model_used, 'unknown') = ?`); params.push(filters.model); }
  return { sql: clauses.join(" AND "), params };
}

export async function getUsageStats(days: number, filters?: UsageFilters): Promise<UsageStats> {
  const d = getDb();
  const where = usageWhere(days, filters);
  const repoRows = await d
    .all(`
      SELECT repo,
             ${USAGE_AGG_SQL}
      FROM tasks
      ${EFFECTIVENESS_JOIN_SQL}
      WHERE ${where.sql}
      GROUP BY repo
      ORDER BY total_cost_usd DESC
    `, [...where.params]) as Array<UsageAggRow & { repo: string }>;

  const jobRows = await d
    .all(`
      SELECT
        ${JOB_PREFIX_SQL} AS job_prefix,
        ${USAGE_AGG_SQL}
      FROM tasks
      ${EFFECTIVENESS_JOIN_SQL}
      WHERE ${where.sql}
      GROUP BY job_prefix
      ORDER BY total_cost_usd DESC
    `, [...where.params]) as Array<UsageAggRow & { job_prefix: string }>;

  const providerRows = await d
    .all(`
      SELECT COALESCE(provider_used, 'unknown') AS provider_used,
             COALESCE(model_used, 'unknown') AS model_used,
             ${USAGE_AGG_SQL}
      FROM tasks
      ${EFFECTIVENESS_JOIN_SQL}
      WHERE ${where.sql}
      GROUP BY 1, 2
      ORDER BY total_cost_usd DESC
    `, [...where.params]) as Array<UsageAggRow & { provider_used: string; model_used: string }>;

  return {
    repoStats: repoRows.map((r) => ({
      repo: r.repo,
      ...mapUsageAgg(r),
    })),
    jobStats: jobRows.map((r) => ({
      jobName: r.job_prefix,
      ...mapUsageAgg(r),
    })),
    providerStats: providerRows.map((r) => ({
      provider: r.provider_used,
      model: r.model_used,
      ...mapUsageAgg(r),
    })),
  };
}

export async function getTotalUsage(days: number, filters?: UsageFilters): Promise<UsageTotals> {
  const where = usageWhere(days, filters);
  const row = await getDb().get(`
      SELECT COUNT(*) AS task_count,
             COALESCE(SUM(tokens_used), 0) AS total_tokens,
             COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM tasks
      WHERE ${where.sql}
    `, [...where.params]) as { task_count: number; total_tokens: number; total_cost_usd: number };
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

export async function getUsageFilterOptions(days: number): Promise<UsageFilterOptions> {
  const d = getDb();
  const baseWhere = `${USAGE_BASE_SQL} AND started_at >= ?`;
  const cutoff = nowSqlOffsetMs(-days * DAY_MS);
  const repos = (await d.all(`SELECT DISTINCT repo FROM tasks WHERE ${baseWhere} ORDER BY 1`, [cutoff]) as Array<{ repo: string }>).map((r) => r.repo);
  const jobs = (await d.all(`SELECT DISTINCT ${JOB_PREFIX_SQL} AS job FROM tasks WHERE ${baseWhere} ORDER BY 1`, [cutoff]) as Array<{ job: string }>).map((r) => r.job);
  const providers = (await d.all(`SELECT DISTINCT COALESCE(provider_used, 'unknown') AS provider FROM tasks WHERE ${baseWhere} ORDER BY 1`, [cutoff]) as Array<{ provider: string }>).map((r) => r.provider);
  const models = (await d.all(`SELECT DISTINCT COALESCE(model_used, 'unknown') AS model FROM tasks WHERE ${baseWhere} ORDER BY 1`, [cutoff]) as Array<{ model: string }>).map((r) => r.model);
  return { repos, jobs, providers, models };
}

export async function getRecentEffectivenessEvents(days: number, filters?: UsageFilters, limit = 25): Promise<RecentEffectivenessEvent[]> {
  const where = usageWhere(days, filters);
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
      item_number: number;
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
  return rows.map((r) => ({
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

export interface WorkflowRunStats {
  repoStats: Array<{ repo: string; total: number; queued: number; inProgress: number; avgQueueWaitS: number; avgRunDurationS: number; totalDurationS: number }>;
  workflowStats: Array<{ repo: string; workflowName: string; total: number; queued: number; inProgress: number; avgQueueWaitS: number; avgRunDurationS: number; totalDurationS: number }>;
}

export async function getWorkflowRunStats(days: number): Promise<WorkflowRunStats> {
  const d = getDb();
  const cutoff = nowSqlOffsetMs(-days * DAY_MS);

  const repoStats = await d.all(`
    SELECT
      repo,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
      AVG(CASE WHEN run_started_at IS NOT NULL THEN (julianday(run_started_at) - julianday(created_at)) * 86400 END) AS avg_queue_wait_s,
      AVG(CASE WHEN conclusion IS NOT NULL AND run_started_at IS NOT NULL THEN (julianday(updated_at) - julianday(run_started_at)) * 86400 END) AS avg_run_duration_s,
      SUM(CASE WHEN conclusion IS NOT NULL AND run_started_at IS NOT NULL THEN (julianday(updated_at) - julianday(run_started_at)) * 86400 END) AS total_duration_s
    FROM workflow_runs
    WHERE created_at >= ?
    GROUP BY repo
    ORDER BY total_duration_s DESC
  `, [cutoff]) as Array<{ repo: string; total: number; queued: number; in_progress: number; avg_queue_wait_s: number | null; avg_run_duration_s: number | null; total_duration_s: number | null }>;

  const workflowStats = await d.all(`
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
    WHERE created_at >= ?
    GROUP BY repo, workflow_name
    ORDER BY total_duration_s DESC
  `, [cutoff]) as Array<{ repo: string; workflow_name: string; total: number; queued: number; in_progress: number; avg_queue_wait_s: number | null; avg_run_duration_s: number | null; total_duration_s: number | null }>;

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

export async function getLastWorkflowRunSync(): Promise<string | null> {
  const row = await getDb().get(`SELECT MAX(synced_at) AS last_sync FROM workflow_runs`) as { last_sync: string | null };
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
  /** Model id passed to the agent CLI as `--model`. NULL / empty means the provider default; every read path must coalesce to `null` (#2873). */
  model: string | null;
}

export async function insertSession(row: Omit<PersistedSession, "ended_at" | "resume_repos" | "summary_manual">): Promise<void> {
  await getDb().run(`
    INSERT INTO sessions (id, tmux_name, mode, repo, cwd, worktree_path, extra_worktrees, capabilities, created_at, provider, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [row.id, row.tmux_name, row.mode, row.repo, row.cwd, row.worktree_path, row.extra_worktrees, row.capabilities, row.created_at, row.provider, row.model]);
}

/** Distinct models previously chosen for `provider`, most-recently-used first. */
export async function getRecentSessionModels(provider: string, limit = 5): Promise<string[]> {
  return (await getDb().all(`
    SELECT model, MAX(created_at) AS last_used FROM sessions
    WHERE model IS NOT NULL AND model != '' AND COALESCE(provider, 'claude') = ?
    GROUP BY model ORDER BY last_used DESC LIMIT ?
  `, [provider, limit]) as Array<{ model: string }>).map((r) => r.model);
}

export async function getAllPersistedSessions(): Promise<PersistedSession[]> {
  return await getDb().all(`SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY created_at`) as PersistedSession[];
}

export async function getEndedSessions(): Promise<PersistedSession[]> {
  return await getDb().all(`SELECT * FROM sessions WHERE ended_at IS NOT NULL ORDER BY ended_at DESC, id DESC`) as PersistedSession[];
}

export async function getPersistedSession(id: string): Promise<PersistedSession | undefined> {
  return await getDb().get(`SELECT * FROM sessions WHERE id = ?`, [id]) as PersistedSession | undefined;
}

export async function markSessionEnded(id: string, endedAt: number, resumeRepos: string | null): Promise<void> {
  await getDb().run(`UPDATE sessions SET ended_at = ?, resume_repos = ? WHERE id = ?`, [endedAt, resumeRepos, id]);
}

export async function clearSessionEnded(id: string): Promise<void> {
  await getDb().run(`UPDATE sessions SET ended_at = NULL WHERE id = ?`, [id]);
}

export async function pruneEndedSessions(keep: number): Promise<string[]> {
  // SQLite: LIMIT -1 OFFSET keep = "all rows past the first `keep`"
  const rows = await getDb().all(`
    SELECT id
    FROM sessions
    WHERE ended_at IS NOT NULL
    ORDER BY ended_at DESC, id DESC
    LIMIT -1 OFFSET ?
  `, [keep]) as Array<{ id: string }>;
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const deleteChunkSize = 900;
  for (let i = 0; i < ids.length; i += deleteChunkSize) {
    const chunk = ids.slice(i, i + deleteChunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    await getDb().run(`DELETE FROM sessions WHERE id IN (${placeholders})`, [...chunk]);
  }
  return ids;
}

export async function deletePersistedSession(id: string): Promise<void> {
  await getDb().run(`DELETE FROM sessions WHERE id = ?`, [id]);
}

export async function updateSessionSummary(id: string, summary: string, updatedAt: number): Promise<void> {
  await getDb().run(`UPDATE sessions SET summary = ?, summary_updated_at = ? WHERE id = ? AND summary_manual = 0`, [summary, updatedAt, id]);
}

/** Set (or clear, with `summary === null`) a user-authored session description. Returns true if a row was updated. */
export async function setManualSessionSummary(id: string, summary: string | null, updatedAt: number | null): Promise<boolean> {
  const info = await getDb().run(`UPDATE sessions SET summary = ?, summary_updated_at = ?, summary_manual = ? WHERE id = ?`, [summary, updatedAt, summary === null ? 0 : 1, id]);
  return info.changes > 0;
}

export interface WhatsappEvent {
  id: number;
  event_type: string;
  detail: string | null;
  occurred_at: string;
}

export async function recordWhatsappEvent(eventType: string, detail?: string): Promise<void> {
  try {
    await getDb().run(`INSERT INTO whatsapp_events (event_type, detail) VALUES (?, ?)`, [eventType, detail ?? null]);
  } catch (err) {
    log.warn(`[whatsapp] Failed to record event: ${err}`);
  }
}

export async function getRecentWhatsappEvents(limit = 50): Promise<WhatsappEvent[]> {
  return await getDb().all(`SELECT id, event_type, detail, occurred_at FROM whatsapp_events ORDER BY occurred_at DESC LIMIT ?`, [Math.min(limit, 200)]) as WhatsappEvent[];
}

/** @internal — only for tests that need raw SQL (e.g. backdating timestamps) */
export function _rawDb(): SqlDriver {
  return getDb();
}

export async function healthCheck(): Promise<void> {
  await getDb().get("SELECT 1");
}

export interface VerificationReportRow {
  id: number;
  ts: number;
  payload: string;
}

export async function insertVerificationReport(payload: string): Promise<void> {
  await getDb().run(`INSERT INTO verification_reports (ts, payload) VALUES (?, ?)`, [Date.now(), payload]);
}

export async function getLatestVerificationReport(): Promise<VerificationReportRow | null> {
  const row = await getDb().get(`SELECT id, ts, payload FROM verification_reports ORDER BY ts DESC LIMIT 1`) as VerificationReportRow | undefined;
  return row ?? null;
}

export interface HaUpgraderStateRow {
  entity_id: string;
  version: string;
  first_seen_at: number;
  attempted_at: number;
  failure_count: number;
}

export async function getHaUpgraderState(entityId: string): Promise<HaUpgraderStateRow | null> {
  const row = await getDb().get(`SELECT entity_id, version, first_seen_at, attempted_at, failure_count FROM ha_upgrader_state WHERE entity_id = ?`, [entityId]) as HaUpgraderStateRow | undefined;
  return row ?? null;
}

export async function upsertHaUpgraderFirstSeen(entityId: string, version: string, now: number): Promise<HaUpgraderStateRow> {
  const existing = await getHaUpgraderState(entityId);
  if (existing && existing.version === version) return existing;
  await getDb().run(`
    INSERT INTO ha_upgrader_state (entity_id, version, first_seen_at, attempted_at, failure_count)
    VALUES (?, ?, ?, 0, 0)
    ON CONFLICT(entity_id) DO UPDATE SET
      version = excluded.version,
      first_seen_at = excluded.first_seen_at,
      attempted_at = 0,
      failure_count = 0
  `, [entityId, version, now]);
  return { entity_id: entityId, version, first_seen_at: now, attempted_at: 0, failure_count: 0 };
}

export async function recordHaUpgraderAttempt(
  entityId: string,
  version: string,
  attemptedAt: number,
  failureCount: number,
): Promise<void> {
  await getDb().run(`
    UPDATE ha_upgrader_state
    SET attempted_at = ?, failure_count = ?
    WHERE entity_id = ? AND version = ?
  `, [attemptedAt, failureCount, entityId, version]);
}

export async function clearHaUpgraderStateForTests(): Promise<void> {
  await getDb().run(`DELETE FROM ha_upgrader_state`);
}

export async function getAllHaUpgraderStates(): Promise<HaUpgraderStateRow[]> {
  return await getDb().all(`SELECT entity_id, version, first_seen_at, attempted_at, failure_count FROM ha_upgrader_state ORDER BY entity_id`) as HaUpgraderStateRow[];
}

export interface DampReadingRow {
  id: number;
  location: string;
  point: string;
  value: number;
  reading_date: string;
  recorded_at: string;
}

export async function upsertDampReading(
  location: string,
  point: string,
  value: number,
  readingDate: string,
  recordedAt: string,
): Promise<void> {
  const res = await getDb()
    .run(`UPDATE damp_readings SET value = ?, recorded_at = ?
       WHERE location = ? AND point = ? AND reading_date = ?`, [value, recordedAt, location, point, readingDate]);
  if (res.changes === 0) {
    await getDb().run(`INSERT INTO damp_readings (location, point, value, reading_date, recorded_at) VALUES (?, ?, ?, ?, ?)`, [location, point, value, readingDate, recordedAt]);
  }
}

export async function deleteDampReading(
  location: string,
  point: string,
  readingDate: string,
): Promise<void> {
  await getDb().run(`DELETE FROM damp_readings WHERE location = ? AND point = ? AND reading_date = ?`, [location, point, readingDate]);
}

export async function getRecentDampReadings(limit = 200): Promise<DampReadingRow[]> {
  return await getDb().all(`SELECT * FROM damp_readings ORDER BY reading_date DESC, recorded_at DESC, location, point LIMIT ?`, [limit]) as DampReadingRow[];
}

export async function getDampTrendRows(): Promise<DampReadingRow[]> {
  return await getDb().all(`SELECT * FROM damp_readings ORDER BY location, point, reading_date DESC, recorded_at DESC`) as DampReadingRow[];
}

export async function hasDampReadingLoggedSince(sinceIso: string): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 AS n FROM damp_readings WHERE recorded_at >= ? LIMIT 1`, [sinceIso]) as { n: number } | undefined;
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

export async function hasDmarcReport(orgName: string, reportId: string): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 AS n FROM dmarc_reports WHERE org_name = ? AND report_id = ? LIMIT 1`, [orgName, reportId]) as { n: number } | undefined;
  return row !== undefined;
}

export async function getLatestDmarcReportForDomain(domain: string): Promise<DmarcReportRow | undefined> {
  return await getDb().get(`SELECT ${DMARC_REPORT_COLUMNS} FROM dmarc_reports WHERE domain = ?
       ORDER BY date_begin DESC, received_at DESC LIMIT 1`, [domain]) as DmarcReportRow | undefined;
}

/** The only read path that touches `raw_xml` — kept separate so the hot queries stay small. */
export async function getDmarcReportXml(orgName: string, reportId: string): Promise<string | undefined> {
  const row = await getDb().get(`SELECT raw_xml FROM dmarc_reports WHERE org_name = ? AND report_id = ?`, [orgName, reportId]) as { raw_xml: string } | undefined;
  return row?.raw_xml;
}

/**
 * Store a parsed report and its rows in one transaction. Returns false without
 * writing anything when `(org_name, report_id)` is already present, so a
 * re-forwarded or duplicate report is idempotent and raises no second alert.
 */
export async function insertDmarcReport(report: DmarcReport, rawXml: string, receivedAt: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const dup = await tx.get(`SELECT 1 AS n FROM dmarc_reports WHERE org_name = ? AND report_id = ? LIMIT 1`, [report.orgName, report.reportId]) as { n: number } | undefined;
    if (dup !== undefined) return false;
    await tx.run(
      `INSERT INTO dmarc_reports (org_name, report_id, report_email, domain, date_begin, date_end,
         policy_p, policy_sp, policy_adkim, policy_aspf, policy_pct, row_count, received_at, raw_xml)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ],
    );
    for (const [i, r] of report.rows.entries()) {
      await tx.run(
        `INSERT INTO dmarc_rows (org_name, report_id, row_index, domain, date_begin, date_end,
           source_ip, count, disposition, eval_dkim, eval_spf, header_from, envelope_from, envelope_to,
           dkim_results, spf_results, reasons, verdict, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
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
        ],
      );
    }
    return true;
  });
}

export async function getDmarcVerdictCounts(sinceIso: string): Promise<Array<{ domain: string; verdict: string; n: number }>> {
  return await getDb().all(`SELECT domain, verdict, COUNT(*) AS n FROM dmarc_rows WHERE date_begin >= ?
       GROUP BY domain, verdict ORDER BY domain, verdict`, [sinceIso]) as Array<{ domain: string; verdict: string; n: number }>;
}

export interface DmarcSourceIpRow {
  source_ip: string;
  verdict: string;
  domain: string;
  messages: number;
  last_seen: string;
}

export async function getDmarcSourceIps(sinceIso: string, limit = 200): Promise<DmarcSourceIpRow[]> {
  return await getDb().all(`SELECT source_ip, verdict, domain, SUM(count) AS messages, MAX(date_end) AS last_seen
       FROM dmarc_rows WHERE date_begin >= ?
       GROUP BY source_ip, verdict, domain ORDER BY last_seen DESC LIMIT ?`, [sinceIso, limit]) as DmarcSourceIpRow[];
}

/** Latest report per (domain, reporter) pair — the "is anything still arriving?" view. */
export async function getLatestDmarcReportsPerReporter(): Promise<DmarcReportRow[]> {
  return await getDb().all(`SELECT ${DMARC_REPORT_COLUMNS}, max_begin FROM (
         SELECT ${DMARC_REPORT_COLUMNS}, date_begin AS max_begin,
                ROW_NUMBER() OVER (PARTITION BY domain, org_name ORDER BY date_begin DESC) AS rn
         FROM dmarc_reports
       ) AS latest
       WHERE rn = 1
       ORDER BY max_begin DESC, domain, org_name`) as DmarcReportRow[];
}

/**
 * Delete reports and their rows past the retention window. `received_at` is ISO 8601, which
 * still compares correctly against datetime('now', …) at day granularity — same as pruneWorkflowRuns.
 */
export async function pruneDmarcReports(retentionDays = 365): Promise<number> {
  const cutoff = nowSqlOffsetMs(-retentionDays * DAY_MS);
  return await getDb().transaction(async (tx) => {
    await tx.run(`DELETE FROM dmarc_rows WHERE received_at < ?`, [cutoff]);
    return (await tx.run(`DELETE FROM dmarc_reports WHERE received_at < ?`, [cutoff])).changes;
  });
}

export async function getRecentDmarcRows(limit = 100): Promise<DmarcRowRow[]> {
  return await getDb().all(`SELECT * FROM dmarc_rows ORDER BY date_begin DESC, id DESC LIMIT ?`, [limit]) as DmarcRowRow[];
}

export async function hasReminderFired(repo: string, reminderId: string, notifyOn: string): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 AS n FROM reminder_notifications WHERE repo = ? AND reminder_id = ? AND notify_on = ? LIMIT 1`, [repo, reminderId, notifyOn]) as { n: number } | undefined;
  return row !== undefined;
}

export async function recordReminderFired(repo: string, reminderId: string, notifyOn: string, issueNumber: number): Promise<void> {
  await getDb().run(`INSERT OR IGNORE INTO reminder_notifications (repo, reminder_id, notify_on, issue_number) VALUES (?, ?, ?, ?)`, [repo, reminderId, notifyOn, issueNumber]);
}

/** True once `watchId` has unblocked `repo#issueNumber` — stops a re-comment
 *  loop if a human later re-applies `Claws Ignore`. (#2617) */
export async function hasUpstreamWatchFired(watchId: string, repo: string, issueNumber: number): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 AS n FROM upstream_watch_fires WHERE watch_id = ? AND repo = ? AND issue_number = ? LIMIT 1`, [watchId, repo, issueNumber]) as { n: number } | undefined;
  return row !== undefined;
}

export async function recordUpstreamWatchFired(watchId: string, repo: string, issueNumber: number): Promise<void> {
  await getDb().run(`INSERT OR IGNORE INTO upstream_watch_fires (watch_id, repo, issue_number) VALUES (?, ?, ?)`, [watchId, repo, issueNumber]);
}

export async function hasBlogDraftPortFiled(repo: string, path: string): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 AS n FROM blog_draft_ports WHERE repo = ? AND path = ? LIMIT 1`, [repo, path]) as { n: number } | undefined;
  return row !== undefined;
}

export async function recordBlogDraftPortFiled(repo: string, path: string, issueNumber: number): Promise<void> {
  await getDb().run(`INSERT OR IGNORE INTO blog_draft_ports (repo, path, issue_number) VALUES (?, ?, ?)`, [repo, path, issueNumber]);
}

/**
 * Records one promotion action filed by `site-promoter`. Append-only history —
 * the cadence gate reads `MAX(filed_at)` per channel, so a re-filed channel
 * simply adds a newer row rather than overwriting the audit trail.
 */
export async function recordPromotionActionFiled(
  repo: string,
  siteId: string,
  channelId: string,
  targetRepo: string,
  issueNumber: number,
  title: string,
): Promise<void> {
  await getDb().run(`INSERT INTO promotion_actions (repo, site_id, channel_id, target_repo, issue_number, title)
       VALUES (?, ?, ?, ?, ?, ?)`, [repo, siteId, channelId, targetRepo, issueNumber, title]);
}

/** Latest filing timestamp per channel for one site. Values are UTC without a zone suffix. */
export async function getPromotionActionTimestamps(repo: string, siteId: string): Promise<Map<string, string>> {
  const rows = await getDb().all(`SELECT channel_id, MAX(filed_at) AS last FROM promotion_actions
       WHERE repo = ? AND site_id = ? GROUP BY channel_id`, [repo, siteId]) as Array<{ channel_id: string; last: string }>;
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
export async function recordShoppingSearch(
  repo: string,
  manifest: string,
  itemId: string,
  resultJson: string,
): Promise<void> {
  await getDb().run(`INSERT INTO shopping_searches (repo, manifest, item_id, result_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo, manifest, item_id)
       DO UPDATE SET last_searched_at = ?, result_json = excluded.result_json`, [repo, manifest, itemId, resultJson, nowSql()]);
}

/** Latest stored search per item for one manifest. `lastSearchedAt` is UTC without a zone suffix. */
export async function getShoppingSearches(repo: string, manifest: string): Promise<ShoppingSearchRow[]> {
  const rows = await getDb().all(`SELECT item_id, last_searched_at, result_json FROM shopping_searches WHERE repo = ? AND manifest = ?`, [repo, manifest]) as Array<{ item_id: string; last_searched_at: string; result_json: string }>;
  return rows.map((r) => ({
    itemId: r.item_id,
    lastSearchedAt: r.last_searched_at,
    resultJson: r.result_json,
  }));
}

/** Every stored shopping search row across all repos/manifests — for cross-project store hints. */
export async function getAllShoppingSearches(): Promise<Array<{ repo: string; manifest: string; resultJson: string }>> {
  const rows = await getDb().all(`SELECT repo, manifest, result_json FROM shopping_searches`) as Array<{ repo: string; manifest: string; result_json: string }>;
  return rows.map((r) => ({ repo: r.repo, manifest: r.manifest, resultJson: r.result_json }));
}

/**
 * Records (or clears, with `error === null`) the last sourcing failure for one
 * manifest. The consolidated tracking issue's "candidates may be stale" banner
 * is rebuilt from these rows, so both the sourcer and the comment processor
 * render the same warning without either having to parse the issue body.
 */
export async function recordShoppingSourcingError(repo: string, manifest: string, error: string | null): Promise<void> {
  if (error === null) {
    await getDb().run(`DELETE FROM shopping_sourcing_errors WHERE repo = ? AND manifest = ?`, [repo, manifest]);
    return;
  }
  await getDb().run(`INSERT INTO shopping_sourcing_errors (repo, manifest, error)
       VALUES (?, ?, ?)
       ON CONFLICT(repo, manifest)
       DO UPDATE SET error = excluded.error, updated_at = ?`, [repo, manifest, error, nowSql()]);
}

/** The last recorded sourcing failure for one manifest, or undefined when the last run succeeded. */
export async function getShoppingSourcingError(repo: string, manifest: string): Promise<string | undefined> {
  const row = await getDb().get(`SELECT error FROM shopping_sourcing_errors WHERE repo = ? AND manifest = ?`, [repo, manifest]) as { error: string } | undefined;
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

export async function upsertBlogDraft(
  repo: string,
  path: string,
  content: string,
  baseSha: string | null,
  title: string | null,
  updatedAt: string,
): Promise<void> {
  await getDb().run(`INSERT INTO blog_drafts (repo, path, content, base_sha, title, status, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?)
       ON CONFLICT(repo, path) DO UPDATE SET
         content = excluded.content,
         base_sha = excluded.base_sha,
         title = excluded.title,
         status = 'draft',
         updated_at = excluded.updated_at`, [repo, path, content, baseSha, title, updatedAt]);
}

export async function getBlogDraft(repo: string, path: string): Promise<BlogDraftRow | null> {
  return (
    (await getDb().get(`SELECT * FROM blog_drafts WHERE repo = ? AND path = ?`, [repo, path]) as BlogDraftRow | undefined) ?? null
  );
}

export async function listBlogDrafts(repo: string): Promise<BlogDraftRow[]> {
  return await getDb().all(`SELECT * FROM blog_drafts WHERE repo = ? ORDER BY updated_at DESC`, [repo]) as BlogDraftRow[];
}

export async function setBlogDraftPushed(
  repo: string,
  path: string,
  prNumber: number,
  branch: string,
): Promise<void> {
  await getDb().run(`UPDATE blog_drafts SET status = 'pushed', pr_number = ?, pr_branch = ? WHERE repo = ? AND path = ?`, [prNumber, branch, repo, path]);
}

// Drop a stale PR pointer (PR merged/closed/deleted) so the next push opens a fresh PR.
export async function clearBlogDraftPR(repo: string, path: string): Promise<void> {
  await getDb().run(`UPDATE blog_drafts SET status = 'draft', pr_number = NULL, pr_branch = NULL WHERE repo = ? AND path = ?`, [repo, path]);
}

export interface HaDeployWatcherState {
  addonSlug: string;
  lastNotifiedSha: string;
  lastSeenAt: number;
}

export async function getHaDeployWatcherState(addonSlug: string): Promise<HaDeployWatcherState | null> {
  const row = await getDb().get(`SELECT addon_slug, last_notified_sha, last_seen_at FROM ha_deploy_watcher_state WHERE addon_slug = ?`, [addonSlug]) as { addon_slug: string; last_notified_sha: string; last_seen_at: number } | undefined;
  if (!row) return null;
  return { addonSlug: row.addon_slug, lastNotifiedSha: row.last_notified_sha, lastSeenAt: row.last_seen_at };
}

export async function upsertHaDeployWatcherState(addonSlug: string, sha: string, now: number): Promise<void> {
  await getDb().run(`
    INSERT INTO ha_deploy_watcher_state (addon_slug, last_notified_sha, last_seen_at)
    VALUES (?, ?, ?)
    ON CONFLICT(addon_slug) DO UPDATE SET
      last_notified_sha = excluded.last_notified_sha,
      last_seen_at = excluded.last_seen_at
  `, [addonSlug, sha, now]);
}

// First time an HA entity was seen unreadable (absent/unavailable/unknown).
// Insert-if-missing so the clock starts once and is not restarted by later
// ticks; cleared as soon as the entity reads a usable value again. HA Core
// restarts reset a template entity's last_changed, so a persistent blind spot
// can only be measured from claws' own durable record.
export async function recordHaEntityUnavailable(entityId: string, now: number): Promise<number> {
  const db = getDb();
  await db.run(`INSERT INTO ha_entity_unavailable (entity_id, first_seen_at) VALUES (?, ?) ON CONFLICT(entity_id) DO NOTHING`, [entityId, now]);
  const row = await db.get(`SELECT first_seen_at FROM ha_entity_unavailable WHERE entity_id = ?`, [entityId]) as { first_seen_at: number } | undefined;
  return row?.first_seen_at ?? now;
}

export async function clearHaEntityUnavailable(entityId: string): Promise<void> {
  await getDb().run(`DELETE FROM ha_entity_unavailable WHERE entity_id = ?`, [entityId]);
}

export async function clearHaEntityUnavailableForTests(): Promise<void> {
  await getDb().run(`DELETE FROM ha_entity_unavailable`);
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
export async function getIntentBackfillState(
  repo: string,
): Promise<{ oldestScanned: string | null; complete: boolean; windowExhausted: boolean; sourceVersion: number } | null> {
  const row = await getDb().get(`SELECT oldest_scanned, complete, window_exhausted, source_version FROM doc_intent_backfill WHERE repo = ?`, [repo]) as { oldest_scanned: string | null; complete: number; window_exhausted: number; source_version: number } | undefined;
  if (!row) return null;
  return {
    oldestScanned: row.oldest_scanned,
    complete: row.complete === 1,
    windowExhausted: row.window_exhausted === 1,
    sourceVersion: row.source_version ?? 0,
  };
}

/** Records how far back the intent backfill has walked for `repo`. */
export async function recordIntentBackfillChunk(
  repo: string,
  oldestScanned: string | null,
  complete: boolean,
  windowExhausted: boolean,
  sourceVersion: number,
): Promise<void> {
  await getDb().run(`
    INSERT INTO doc_intent_backfill (repo, oldest_scanned, complete, window_exhausted, source_version)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repo) DO UPDATE SET
      oldest_scanned = excluded.oldest_scanned,
      complete = excluded.complete,
      window_exhausted = excluded.window_exhausted,
      source_version = excluded.source_version,
      updated_at = ?
  `, [repo, oldestScanned, complete ? 1 : 0, windowExhausted ? 1 : 0, sourceVersion, nowSql()]);
}

/** Returns the SHA-256 digest of the agent memory files last folded into docs for `repo`, or null if never folded. */
export async function getDocMemoryDigest(repo: string): Promise<string | null> {
  const row = await getDb().get(`SELECT memory_digest FROM doc_intent_backfill WHERE repo = ?`, [repo]) as { memory_digest: string | null } | undefined;
  return row?.memory_digest ?? null;
}

/** Records the digest of the agent memory files last folded into docs for `repo`. */
export async function recordDocMemoryDigest(repo: string, digest: string): Promise<void> {
  await getDb().run(`
    INSERT INTO doc_intent_backfill (repo, memory_digest)
    VALUES (?, ?)
    ON CONFLICT(repo) DO UPDATE SET
      memory_digest = excluded.memory_digest,
      updated_at = ?
  `, [repo, digest, nowSql()]);
}

export async function clearHaDeployWatcherStateForTests(): Promise<void> {
  await getDb().run(`DELETE FROM ha_deploy_watcher_state`);
}

export async function closeDb(): Promise<void> {
  if (jobLogDrainTimer) {
    clearInterval(jobLogDrainTimer);
    jobLogDrainTimer = null;
  }
  if (driver) {
    await flushJobLogs();
    const closing = driver;
    driver = null;
    await closing.close();
    log.info("Database closed");
  }
}
