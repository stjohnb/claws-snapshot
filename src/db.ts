import * as diagnosticQueries from "./diagnostic-queries.js";
import { createSqliteDriver, type SqlDriver } from "./db-driver.js";
import { createPgDriver, createPgLiteDriver } from "./db-driver-pg.js";
import { DB_PATH, DATABASE_URL, DATABASE_PASSWORD } from "./config.js";
import { CONFIG_STORE_DDL, setConfigStoreDriver } from "./config-store.js";
import { CAPABILITY_RENAMES, renameCapabilityIds } from "./capability-renames.js";
import * as log from "./log.js";
import * as logCore from "./log-core.js";
import { buildFailureOutcome, PRE_WORK_FAILURE_CATEGORIES_SQL } from "./outcome.js";
import { CLAWS_EVENTS_DDL, CLAWS_EVENTS_INDEX_DDL, flushGitHubEvents, recordGitHubEvent, setGitHubEventsDriver } from "./github-events.js";
import { CLAWS_GATE_STATE_DDL, evaluatePrGates, pruneGateState, setGateEventsDriver } from "./gate-events.js";
import type { DmarcReport } from "./dmarc.js";
import { currentIssueActor, currentRunId } from "./issue-history-actor.js";
import { canonicalIssueRef, newUlid, newClawsIssueId, newClawsCommentId, newClawsAttachmentId, newClawsLinkId, newClawsSessionFileId, normalizeItemNumbers, refFromColumn, type IssueRef } from "./issue-id.js";
import { isPlanComment, normalizePlanText } from "./marker-text.js";
import type { RequirementsRecord } from "./requirements-record.js";
import { RETIRED_GATE_LABELS, STATE_LABELS, labelForLifecycle, lifecycleForLabel, resolveStage, splitStateLabels, type IssueLifecycle } from "./issue-lifecycle.js";
import { atLeast, isApprovedThrough, maxApproval, type ApprovedThrough } from "./issue-approval.js";
import { planningKindsSql, stageRankSql, type WorkLane } from "./work-order.js";
import { VERSION } from "./version.js";

let driver: SqlDriver | null = null;

/**
 * An issue reference as the TEXT column stores it.
 *
 * Always a string, never the raw number: better-sqlite3 binds a JS number as a
 * double, and SQLite's TEXT affinity would then write `42` as `"42.0"` —
 * which no later `= ?` lookup would ever match.
 *
 * Canonicalised here too, so "canonical on write" is structural rather than a
 * promise every caller has to keep. On Postgres these columns are TEXT and `=`
 * is case-sensitive, and `idx_work_queue_active` is unique over
 * `(kind, repo, item_number)`: a ref that reached `enqueueWork` spelled
 * `clw_01jbq…` would not collide with the canonical row, it would quietly add
 * a second queue entry for the same issue that no `= ?` lookup ever finds. A
 * ref that is not a reference at all is passed through unchanged so the caller
 * still sees its own bad input in the error.
 */
function refParam(ref: IssueRef): string {
  return String(canonicalIssueRef(ref) ?? ref);
}

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

/** Human label for the active backend — safe to log and to render in /config's connectivity checks. */
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

/**
 * Retire the `manual-action` PR stage and the `Manual Action` label
 * (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK). A PR hold is the row's
 * `manual_action_reason` alone, so a row at the old stage moves to
 * `ci-failing` when its CI fails and `awaiting-review` otherwise; the next
 * review pass corrects it from there. Native issues drop the label
 * (DMARC alert issues use `Blocked` instead). Idempotent, so it runs every
 * boot.
 */
export async function migrateRetiredManualAction(): Promise<void> {
  await getDb().run(`UPDATE claws_prs SET stage = CASE WHEN ci_status = 'failing' THEN 'ci-failing' ELSE 'awaiting-review' END WHERE stage = 'manual-action'`);
  await getDb().run(`DELETE FROM claws_issue_labels WHERE label = 'Manual Action'`);
}

/**
 * Rewrite renamed capability ids (`CAPABILITY_RENAMES`, e.g. `ssh:k3s` and
 * `ssh:homeassistant` -> `ssh:thinkcentre`) in stored session grants and remembered form defaults.
 * Idempotent and DDL-free, so it runs every controller boot with no
 * SCHEMA_VERSION bump. Unparseable rows are skipped.
 */
export async function migrateRenamedCapabilities(): Promise<void> {
  const where = Object.keys(CAPABILITY_RENAMES).map((old) => `capabilities LIKE '%"${old}"%'`).join(" OR ");
  for (const [table, key] of [["sessions", "id"], ["session_capability_defaults", "repo_key"]] as const) {
    const rows = await getDb().all(`SELECT ${key} AS k, capabilities FROM ${table} WHERE ${where}`) as Array<{ k: string; capabilities: string }>;
    for (const row of rows) {
      let ids: unknown;
      try { ids = JSON.parse(row.capabilities); } catch { continue; }
      if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string")) continue;
      await getDb().run(`UPDATE ${table} SET capabilities = ? WHERE ${key} = ?`, [JSON.stringify(renameCapabilityIds(ids as string[])), row.k]);
    }
  }
}

/**
 * The schema this build's DDL produces. Bump it with every DDL change in
 * {@link migrateSchema}: the controller records it in `controller_status`
 * after migrating, and a web pod waits until the recorded version is at least
 * its own (src/main-web.ts). Schema changes stay additive within a release —
 * a column or table is dropped only one release after nothing reads it — so
 * the previous build keeps working against the migrated schema.
 */
export const SCHEMA_VERSION = 7;

/** The `controller_status` key the controller records {@link SCHEMA_VERSION} under. */
export const SCHEMA_VERSION_KEY = "schema_version";

/**
 * Opens the database and starts the job-log drain. With `migrate` (the
 * default) it also runs every migration and records {@link SCHEMA_VERSION};
 * only the controller (`CLAWS_ROLE` `controller` or `all`) does that, so the
 * web tier passes `{ migrate: false }`.
 */
export async function initDb(opts: { migrate?: boolean } = {}): Promise<void> {
  driver = await openDriver();
  jobLogBuffer.length = 0;
  jobLogsDropped = 0;
  startJobLogDrain();
  // Operator config (src/config-store.ts); writeConfig publishes through this connection.
  setConfigStoreDriver(driver);
  // Claws-originated change events (src/github-events.ts), read by every
  // process's /api/events long-polls.
  setGitHubEventsDriver(driver);
  // Gate transitions (src/gate-events.ts) behind the derived wait events.
  setGateEventsDriver(driver);
  if (opts.migrate === false) {
    log.info("Database opened (migrations are the controller's)");
    return;
  }
  await migrateSchema();
  await recordSchemaVersion();
  log.info("Database initialized");
}

/**
 * Records {@link SCHEMA_VERSION}, never lowering it: a rolled-back controller
 * leaves the newer schema's additive changes in place, so the higher version
 * still describes the database.
 */
async function recordSchemaVersion(): Promise<void> {
  const recorded = await readSchemaVersion();
  if (recorded !== null && recorded >= SCHEMA_VERSION) return;
  await writeControllerStatus(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
}

/**
 * The schema version the controller last recorded, or null when it never has
 * (or `controller_status` does not exist yet, before the first migration).
 */
export async function readSchemaVersion(): Promise<number | null> {
  try {
    const value = await readControllerStatus<unknown>(SCHEMA_VERSION_KEY);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Every table, column, index and data migration; run by {@link initDb} in the controller only. */
async function migrateSchema(): Promise<void> {
  await getDb().exec(CONFIG_STORE_DDL);
  await getDb().exec(CLAWS_EVENTS_DDL);
  await getDb().exec(CLAWS_EVENTS_INDEX_DDL);
  await getDb().exec(CLAWS_GATE_STATE_DDL);

  // What the background controller last published about itself (heartbeat,
  // scheduler, providers, worker, queue snapshot), keyed by topic, for a
  // process that cannot ask it in-process (src/controller-client.ts).
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS controller_status (
      key        TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Requests for the controller (trigger, cancel, clear a rate limit), run in
  // id order by src/controller-publisher.ts, including ones filed while it was down.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS controller_commands (
      id           {{PK_AUTOINC}},
      kind         TEXT NOT NULL,
      args_json    TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      claimed_at   TEXT,
      completed_at TEXT,
      result_json  TEXT
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_controller_commands_unclaimed ON controller_commands(claimed_at, id)`);

  // Provider usage-limit holds (src/provider-holds.ts), keyed `claude`,
  // `claude@<account>`, `claude@<account>:<tier>`, `codex`, …, so the
  // controller, the web tier and agent pods act on the same holds.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS provider_holds (
      key        TEXT PRIMARY KEY,
      until_ms   INTEGER NOT NULL,
      reason     TEXT,
      updated_at TEXT
    )
  `);

  // When an opted-in app's contentModeration queue first answered 404/405
  // continuously (src/jobs/content-moderator.ts), so the grace period survives restarts.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS content_moderation_not_live (
      repo     TEXT PRIMARY KEY,
      since_ms INTEGER NOT NULL
    )
  `);

  // The Claude Max accounts Claws runs Claude work on and each one's OAuth
  // token (src/claude-accounts.ts), managed on /reauth. `token` is null until
  // the account's first login; it never leaves the database except to the
  // process that runs Claude with it.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claude_accounts (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      token      TEXT,
      position   INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            {{PK_AUTOINC}},
      job_name      TEXT NOT NULL,
      repo          TEXT NOT NULL,
      item_number   TEXT NOT NULL,
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

  // Migration: add account_used column to tasks (which Claude account served the task)
  await getDb().addColumn("tasks", "account_used", "TEXT");

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

  // One row per completed pr-reviewer round — what the reviewer and the
  // PR_REVIEWER handler read to decide whether (and how much) to re-review.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS pr_reviews (
      id               {{PK_AUTOINC}},
      repo             TEXT NOT NULL,
      pr_number        INTEGER NOT NULL,
      head_sha         TEXT NOT NULL,
      reviewed_sha     TEXT,
      base_sha         TEXT NOT NULL DEFAULT '',
      verdict          TEXT NOT NULL,
      mode             TEXT NOT NULL DEFAULT 'full',
      iteration        INTEGER NOT NULL DEFAULT 1,
      reviewer_task_id INTEGER,
      provider         TEXT,
      model            TEXT,
      findings         TEXT,
      created_at       TEXT NOT NULL DEFAULT {{NOW}}
    )
  `);
  await getDb().exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_reviews_head ON pr_reviews(repo, pr_number, head_sha)`);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_pr_reviews_pr ON pr_reviews(repo, pr_number, id)`);
  await backfillPRReviews();

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
  await getDb().addColumn("job_logs", "diagnostic_reason", "TEXT");
  await getDb().addColumn("job_logs", "diagnostic_context", "TEXT");
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
      item_number   TEXT NOT NULL,
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
  // Name of the agent pod running this row under CLAWS_WORK_BACKEND=k8s-pod; NULL when in-process.
  await getDb().addColumn("work_queue", "agent_pod", "TEXT");
  // SHA-256 of that pod's claws-state bearer token, so it authenticates across service restarts.
  await getDb().addColumn("work_queue", "agent_mcp_token_sha256", "TEXT");
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
  await getDb().addColumn("sessions", "backend", "TEXT");
  await getDb().addColumn("sessions", "agent_status", "TEXT");
  await getDb().addColumn("sessions", "agent_status_updated_at", "INTEGER");
  await getDb().addColumn("sessions", "launched_at", "INTEGER");
  await getDb().addColumn("sessions", "tokens_used", "INTEGER");
  await getDb().addColumn("sessions", "cost_usd", "REAL");
  await getDb().addColumn("sessions", "last_context_tokens", "INTEGER");
  await getDb().addColumn("sessions", "usage_updated_at", "INTEGER");
  await getDb().addColumn("sessions", "startup_state", "TEXT");
  await getDb().addColumn("sessions", "startup_step", "TEXT");
  await getDb().addColumn("sessions", "startup_detail", "TEXT");
  await getDb().addColumn("sessions", "startup_started_at", "INTEGER");
  await getDb().addColumn("sessions", "startup_updated_at", "INTEGER");
  await getDb().addColumn("sessions", "startup_ready_at", "INTEGER");
  await getDb().addColumn("sessions", "startup_failed_at", "INTEGER");
  await getDb().addColumn("sessions", "startup_failure", "TEXT");
  await getDb().addColumn("sessions", "exit_code", "INTEGER");
  await getDb().addColumn("sessions", "last_output", "TEXT");
  await getDb().addColumn("sessions", "mcp_token_sha256", "TEXT");
  await getDb().addColumn("sessions", "launched_version", "TEXT");
  await getDb().addColumn("sessions", "brief", "TEXT");
  await getDb().addColumn("sessions", "spawned_by_session", "TEXT");
  await getDb().addColumn("sessions", "spawned_for_issue", "TEXT");
  await getDb().addColumn("sessions", "spawned_from", "TEXT");
  await getDb().addColumn("sessions", "spawned_for_pr", "TEXT");
  await getDb().addColumn("sessions", "initial_prompt", "TEXT");
  await getDb().addColumn("sessions", "initial_prompt_sent_at", "INTEGER");
  // Session memory capture (claude-memory-backup): when the ended session's memory files were
  // read off its PVC, and how many attempts have failed since it last ended.
  await getDb().addColumn("sessions", "memories_captured_at", "INTEGER");
  await getDb().addColumn("sessions", "memory_capture_attempts", "INTEGER NOT NULL DEFAULT 0");
  // The Claude account id the live pod was launched with (#clw_01M623AMK66JB6TBB4PP55Q2V6).
  await getDb().addColumn("sessions", "claude_account", "TEXT");

  // Last explicitly submitted capability set per repo combination, keyed by
  // `sessionCapabilityDefaultsKey`; the /sessions create forms pre-tick it.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS session_capability_defaults (
      repo_key     TEXT PRIMARY KEY,
      capabilities TEXT NOT NULL,
      updated_at   INTEGER NOT NULL
    )
  `);
  await migrateRenamedCapabilities();

  // The operator's remembered New session agent: one row per agent holding the
  // model last used with it; the most recently updated row is the last-chosen
  // agent. Read by the /sessions forms and `claws_start_session`.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS session_agent_defaults (
      provider   TEXT PRIMARY KEY,
      model      TEXT,
      updated_at INTEGER NOT NULL
    )
  `);

  // The memory files last read off an ended k8s session's PVC, waiting for (or
  // already in) claude-memory-backup's push. Outlives the session row on purpose:
  // the files are pushed after the PVC and row may be gone.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS session_memory_captures (
      session_id  TEXT PRIMARY KEY,
      captured_at INTEGER NOT NULL,
      files_json  TEXT NOT NULL,
      pushed_at   INTEGER
    )
  `);

  // Agent capability requests and their decisions (#3072): the only copy, so
  // a pending request or a denial survives a restart and every Claws process
  // sees the same state.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS session_capability_requests (
      session_id   TEXT NOT NULL,
      capability   TEXT NOT NULL,
      status       TEXT NOT NULL,
      reason       TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      decided_at   INTEGER,
      PRIMARY KEY (session_id, capability)
    )
  `);
  await getDb().addColumn("session_capability_requests", "last_polled_at", "INTEGER");
  await getDb().addColumn("session_capability_requests", "grant_seen_at", "INTEGER");

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
  await getDb().addColumn("doc_intent_backfill", "fleet_links_digest", "TEXT");

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS notified_untrusted_actors (
      repo          TEXT NOT NULL,
      issue_number  TEXT NOT NULL,
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
      issue_number TEXT,
      created_at   TEXT NOT NULL DEFAULT {{NOW}},
      PRIMARY KEY (repo, reminder_id, notify_on)
    )
  `);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS upstream_watch_fires (
      watch_id     TEXT NOT NULL,
      repo         TEXT NOT NULL,
      issue_number TEXT NOT NULL,
      fired_at     TEXT NOT NULL DEFAULT {{NOW}},
      PRIMARY KEY (watch_id, repo, issue_number)
    )
  `);

  // One row per spend warning (e.g. `opencode-anthropic`): the threshold it last
  // warned at, so a warning fires once per threshold value.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS spend_warnings (
      key           TEXT PRIMARY KEY,
      threshold_usd REAL NOT NULL,
      notified_at   TEXT NOT NULL DEFAULT {{NOW}}
    )
  `);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS imported_issues (
      repo         TEXT NOT NULL,
      forge_number TEXT NOT NULL,
      native_id    TEXT NOT NULL,
      imported_at  TEXT NOT NULL DEFAULT {{NOW}},
      PRIMARY KEY (repo, forge_number)
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_imported_issues_native ON imported_issues(native_id)`);

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
  await getDb().addColumn("main_build_failures", "retry_detail", "TEXT");
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_main_build_failures_wf ON main_build_failures(repo, workflow_name)`);

  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS blog_draft_ports (
      repo         TEXT NOT NULL,
      path         TEXT NOT NULL,
      issue_number TEXT,
      created_at   TEXT NOT NULL DEFAULT {{NOW}},
      PRIMARY KEY (repo, path)
    )
  `);

  // The central shopping sourcer and its comment processor are retired
  // (#clw_01M533FKWN23CRBXXRTDABBHAH); each repo now owns its shopping lists.
  await getDb().exec(`DROP TABLE IF EXISTS shopping_searches`);
  await getDb().exec(`DROP TABLE IF EXISTS shopping_sourcing_errors`);

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

  // Agent friction notes (claws_note_friction), rolled up fleet-wide by
  // jobs/friction-retrospective.ts; see docs/database-schema.md.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS friction_notes (
      id                     {{PK_AUTOINC}},
      repo                   TEXT NOT NULL,
      category               TEXT NOT NULL,
      text                   TEXT NOT NULL,
      reference              TEXT,
      task_id                INTEGER,
      session_id             TEXT,
      origin                 TEXT,
      created_at             TEXT NOT NULL,
      triaged_at             TEXT,
      retrospective_issue_id TEXT
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_friction_notes_repo_triaged ON friction_notes(repo, triaged_at)`);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_friction_notes_retro ON friction_notes(retrospective_issue_id)`);

  // ── Claws-native issue tracker (see docs/issue-tracker.md) ──
  //
  // One global stream of issues, each tagged with the managed repository (or
  // repositories) it concerns. Ids are prefixed ULIDs minted in-process by
  // `issue-id.ts`, so no sequence is read back out of the database.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claws_issues (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      body         TEXT NOT NULL DEFAULT '',
      author_login TEXT NOT NULL,
      state        TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'closed'
      state_reason TEXT,                           -- 'completed' | 'not_planned'
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      closed_at    TEXT
    )
  `);
  // `kind` tells an operator-facing native issue (`issue`) from a *shadow*
  // (#3246): the native backing record of an issue that is still live on a
  // forge, which `jobs/issue-shadow-sync.ts` keeps in sync with it so
  // tracker-side columns cover every issue Claws works and not only the
  // natively filed ones. Added by ALTER rather than written into the
  // CREATE above, so an existing database gains it on the next boot with every
  // row defaulting to `issue`.
  await getDb().addColumn("claws_issues", "kind", "TEXT NOT NULL DEFAULT 'issue'");
  // When `issue-shadow-sync` last looked at a shadow, whether or not the look
  // changed anything. `updated_at` cannot stand in for it: a shadow the job
  // checks and finds unchanged is deliberately left untouched, so ordering
  // `listShadowIssues` on `updated_at` alone would park the same few rows at
  // the head of the queue forever and starve the tail of a large repository's
  // shadow set. NULL until the first check, and `COALESCE`d to `updated_at` in
  // that ordering so a freshly minted shadow sorts as just-checked rather than
  // as the most overdue row in the repo.
  await getDb().addColumn("claws_issues", "shadow_checked_at", "TEXT");
  // The forge `updatedAt` `issue-shadow-sync` last processed for an imported
  // forge issue that is back in the open listing — reopened or edited after
  // its move. The job forwards the forge copy to its native issue only when
  // the forge moves past this, so a native issue closed after its fix is not
  // reopened on every run while the forge copy stays open. NULL until the job
  // first sees the forge copy again (docs/jobs/issue-shadow-sync.md).
  await getDb().addColumn("imported_issues", "forge_synced_at", "TEXT");
  // The issue's lifecycle state — `ideas`, `planning`, `awaiting-plan-review`,
  // `blocked` or `backlog` — held in one field rather than as `Blocked` /
  // `Backlog` label rows, so an issue cannot carry two contradictory states.
  // Readers see Blocked and Backlog as the label they replaced (see
  // `toClawsRecords`). Added by ALTER for the same reason as `kind`; the
  // backfill below moves the old label rows into it.
  // Every INSERT names the value, so a database whose column was created with
  // the old `'inbox'` default never relies on it (`migrateInboxToIdeas`).
  await getDb().addColumn("claws_issues", "lifecycle", "TEXT NOT NULL DEFAULT 'ideas'");
  // When the issue entered its current board column, for the board's age chip.
  // Not `updated_at`: a comment or an edit bumps that, so it cannot mean
  // "entered this column". Set whenever the column could change — a
  // `lifecycle` change, a close or reopen. NULL
  // on rows that predate it; the façade reads NULL as `updated_at`, so there
  // is no backfill and existing rows converge as they move.
  await getDb().addColumn("claws_issues", "stage_changed_at", "TEXT");
  // The requirements version a human (or auto-promotion) approved, who approved
  // it and when (docs/refinements/issue-flow.md "Promotion"). NULL until then;
  // the versions themselves live in `claws_issue_requirements`.
  await getDb().addColumn("claws_issues", "approved_requirements_version", "INTEGER");
  await getDb().addColumn("claws_issues", "requirements_approved_by", "TEXT");
  await getDb().addColumn("claws_issues", "requirements_approved_at", "TEXT");
  // Where the issue came from (`dashboard`, `session`, `agent`, `automation`,
  // `whatsapp` or `forge`), which decides whether its requirements wait for a
  // human or auto-promote; `auto_promote` is the per-issue override (1/0, NULL
  // for "follow the policy"); `filed_title` keeps the title the issue was
  // filed under once promotion renamed it to the approved record's title
  // (docs/refinements/issue-flow.md "Promotion"). No default: every INSERT
  // names it, and a NULL left by the ALTER on an existing row is exactly what
  // `migrateInboxToIdeas`'s unconditional backfill below looks for, so a boot
  // that fails partway through never leaves a row's source unbackfilled — it
  // is retried on every later boot instead of exactly once.
  await getDb().addColumn("claws_issues", "source", "TEXT");
  await getDb().addColumn("claws_issues", "auto_promote", "INTEGER");
  await getDb().addColumn("claws_issues", "filed_title", "TEXT");
  // The optional key a `claws_create_issue` caller names the work by, so a
  // second call with the same key in the same primary repo returns the open
  // issue instead of filing a duplicate (docs/issue-tracker.md "Dedupe on
  // create"). NULL on every issue filed without one.
  await getDb().addColumn("claws_issues", "dedupe_key", "TEXT");
  // A repo pinned as the issue's primary (owner of planning, labels and phase
  // sequencing) however its repos sort. Only the friction retrospective sets
  // it, so claws keeps owning one that names repos sorting before it
  // (docs/issue-tracker.md "Repositories and the primary repository").
  // Honoured only while it is one of the issue's repos; NULL otherwise.
  await getDb().addColumn("claws_issues", "primary_repo", "TEXT");
  // Why Claws parked the issue in Blocked for a human (`issue-handback.ts`'s
  // `parkForHuman`), and when. The board shows the reason only while the
  // issue is still `blocked` and the reason is no older than that stage, so a
  // stale reason never labels a later, unrelated Blocked. NULL otherwise.
  await getDb().addColumn("claws_issues", "blocked_reason", "TEXT");
  await getDb().addColumn("claws_issues", "blocked_reason_at", "TEXT");
  // Which alert path filed the issue (`ensureAlertIssue`'s log prefix,
  // `alert-bridge`, `ci-fixer`, or `legacy` for a backfilled one), so the
  // dashboard's `/alerts` page lists every open alert. NULL on every issue
  // that is not an alert; `migrateAlertKindBackfill` marks the old ones.
  await getDb().addColumn("claws_issues", "alert_kind", "TEXT");
  // When an alert issue's stalled automatic fix last posted its one Slack
  // line (`claimAlertAttention`), so another park of the same Blocked stay
  // posts nothing. Every lifecycle write that leaves `blocked` clears it, so
  // a later stall alerts again. NULL otherwise.
  await getDb().addColumn("claws_issues", "alert_attention_notified_at", "TEXT");
  // The calendar day (`YYYY-MM-DD`) a native issue parked in the Backlog
  // returns on, and when it was set (docs/issue-tracker.md#backlog). Every
  // lifecycle write that leaves `backlog` clears both, so a date only ever
  // describes the park it was set for. NULL otherwise.
  await getDb().addColumn("claws_issues", "backlog_until", "TEXT");
  await getDb().addColumn("claws_issues", "backlog_until_at", "TEXT");
  // 1 while `issue-importer` is still assembling the issue (it promotes a
  // shadow with the flag set and clears it once the forge copy is closed), so
  // every dispatcher holds it and an interrupted import is recognisable
  // without a user-visible label (#clw_01M55F0ACDZP8ND1BNRZ8TNGPD).
  await getDb().addColumn("claws_issues", "import_pending", "INTEGER NOT NULL DEFAULT 0");
  // How far along the Requirements → Plan → Merge track the issue is approved
  // (`none`, `requirements`, `plan` or `merge`, `issue-approval.ts`), who
  // last set it and when — the one record of approval, which replaced the
  // `Refined` / `Ready` / `Ship` / `Claws Auto-Refine` / `Automerge` labels
  // (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F). A forge issue's lives on its shadow.
  // `migrateGateLabelsToApprovedThrough` fills it from those labels.
  await getDb().addColumn("claws_issues", "approved_through", "TEXT NOT NULL DEFAULT 'none'");
  await getDb().addColumn("claws_issues", "approved_through_by", "TEXT");
  await getDb().addColumn("claws_issues", "approved_through_at", "TEXT");
  // When the value last rose to `plan` or beyond from below, NULL while it is
  // below `plan`. `approved_through_at` moves on every change (Plan → Merge
  // and back too), so whatever dates work against the Plan approval — a
  // closed PR, human feedback — reads this instead.
  await getDb().addColumn("claws_issues", "plan_approved_at", "TEXT");
  // Whether the issue goes through the requirements stage before Planning (1)
  // or skips straight to Planning with no record (0) — by default only a
  // hand-filed issue gets one ({@link HUMAN_ISSUE_SOURCES}). Both INSERTs
  // always name it, so the backfill only ever touches rows that predate the
  // column: those keep today's flow, and it is safe to repeat on every boot.
  await getDb().addColumn("claws_issues", "requirements_stage", "INTEGER");
  await getDb().run(`UPDATE claws_issues SET requirements_stage = 1 WHERE requirements_stage IS NULL`);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_claws_issues_dedupe_key ON claws_issues(dedupe_key) WHERE dedupe_key IS NOT NULL`);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_claws_issues_state ON claws_issues(state, updated_at)`);
  // `idx_claws_issues_state` cannot serve `closed_at >= ? ORDER BY closed_at
  // DESC`, which is how `listClosedClawsIssuesSince` reads the closed half.
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_claws_issues_closed ON claws_issues(state, closed_at)`);
  // The façade's two reads gained a `kind <> 'shadow'` clause (#3246), and
  // once shadows exist there is one `claws_issues` row per open forge issue
  // fleet-wide: the two indexes above would match every one of them and throw
  // nearly all of them away after the scan, on the path every dispatcher cycle
  // runs. A plain b-tree on `kind` cannot help — `<>` is not a seekable
  // predicate — but a partial copy can, because the planner proves the index
  // predicate from the query's own literal clause, the same trick
  // `idx_work_queue_active` uses. New names rather than redefinitions:
  // `CREATE INDEX IF NOT EXISTS` leaves an existing index alone, so redefining
  // the two above in place would need a DROP migration and buy nothing —
  // `listShadowIssues` reaches a shadow through `imported_issues`' primary
  // key, not through any index on `kind`.
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_claws_issues_live_state ON claws_issues(state, updated_at) WHERE kind <> 'shadow'`);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_claws_issues_live_closed ON claws_issues(state, closed_at) WHERE kind <> 'shadow'`);
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claws_issue_repos (
      issue_id TEXT NOT NULL,
      repo     TEXT NOT NULL,
      PRIMARY KEY (issue_id, repo),
      FOREIGN KEY (issue_id) REFERENCES claws_issues(id) ON DELETE CASCADE
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_claws_issue_repos_repo ON claws_issue_repos(repo)`);
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claws_issue_labels (
      issue_id TEXT NOT NULL,
      label    TEXT NOT NULL,
      PRIMARY KEY (issue_id, label),
      FOREIGN KEY (issue_id) REFERENCES claws_issues(id) ON DELETE CASCADE
    )
  `);
  await migrateStateLabelsToLifecycle();
  // The retired `In Review` label (#clw_01M39G3H99HV6ED4378ZXHER6K): the board
  // reads `claws_prs` instead. Idempotent, so it runs every boot.
  await getDb().run(`DELETE FROM claws_issue_labels WHERE label = 'In Review'`);
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claws_issue_comments (
      id           TEXT PRIMARY KEY,
      issue_id     TEXT NOT NULL,
      author_login TEXT NOT NULL,
      body         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES claws_issues(id) ON DELETE CASCADE
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_claws_issue_comments_issue ON claws_issue_comments(issue_id)`);
  // Soft delete (docs/issue-tracker.md#deleting-comments): a deleted comment
  // keeps its row, stamped with when and by whom, and every read filters it out.
  await getDb().addColumn("claws_issue_comments", "deleted_at", "TEXT");
  await getDb().addColumn("claws_issue_comments", "deleted_by", "TEXT");
  // Every version of a native issue's plan (docs/issue-tracker.md#plans). The
  // plan comment stays the pipeline's source of truth; a row is recorded as a
  // side effect of each plan-comment write whose normalised text changed.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claws_issue_plans (
      issue_id   TEXT NOT NULL,
      version    INTEGER NOT NULL,
      comment_id TEXT,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (issue_id, version),
      FOREIGN KEY (issue_id) REFERENCES claws_issues(id) ON DELETE CASCADE,
      FOREIGN KEY (comment_id) REFERENCES claws_issue_comments(id) ON DELETE SET NULL
    )
  `);
  await backfillClawsIssuePlans();
  await migrateInboxToIdeas();
  await migrateClawsIgnoreLabel();
  // Every version of an issue's requirements record, as the requirements writer
  // saved it (docs/issue-tracker.md#requirements). Keyed by the tracker id, so a
  // forge issue is covered through its shadow row. `comment_id` names the
  // `## Requirements` comment the version was rendered into; it is plain text
  // with no foreign key because a forge comment id is not a native comment.
  // The two list columns hold JSON arrays of strings.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claws_issue_requirements (
      issue_id            TEXT NOT NULL,
      version             INTEGER NOT NULL,
      title               TEXT NOT NULL,
      kind                TEXT NOT NULL,
      context             TEXT NOT NULL,
      requirement         TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      out_of_scope        TEXT NOT NULL,
      comment_id          TEXT,
      created_at          TEXT NOT NULL,
      PRIMARY KEY (issue_id, version),
      FOREIGN KEY (issue_id) REFERENCES claws_issues(id) ON DELETE CASCADE
    )
  `);
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claws_issue_comment_reactions (
      comment_id TEXT NOT NULL,
      login      TEXT NOT NULL,
      content    TEXT NOT NULL,
      PRIMARY KEY (comment_id, login, content),
      FOREIGN KEY (comment_id) REFERENCES claws_issue_comments(id) ON DELETE CASCADE
    )
  `);
  // The PRs an issue's plan needs, as the planner saved them through
  // `claws_save_plan` (src/planner-runs.ts). Keyed by the tracker id, so a forge
  // issue is covered through its shadow row. `pr_number` is set once Claws opens
  // (or pushes onto) the PR for that position; see src/planned-prs.ts.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claws_issue_prs (
      issue_id  TEXT NOT NULL,
      position  INTEGER NOT NULL,
      repo      TEXT NOT NULL,
      title     TEXT NOT NULL,
      pr_number INTEGER,
      PRIMARY KEY (issue_id, position),
      FOREIGN KEY (issue_id) REFERENCES claws_issues(id) ON DELETE CASCADE
    )
  `);
  // JSON array of the earlier positions this PR must land after; `[]` is
  // independent, NULL is unspecified (after the previous PR). See
  // src/phase-coverage.ts `finishCoverage`.
  await getDb().addColumn("claws_issue_prs", "depends_on", "TEXT");
  // `pr` is a step Claws implements; `manual` is the plan's trailing operator
  // step (its "Manual actions" section), which has no PR and completes only on
  // a `claws-phase-done:` claim. `manual_action` is the operator step a `pr`
  // entry must wait for before it merges, recorded on its PR at creation.
  await getDb().addColumn("claws_issue_prs", "kind", "TEXT NOT NULL DEFAULT 'pr'");
  await getDb().addColumn("claws_issue_prs", "manual_action", "TEXT");
  // The open PR an approved design change reworks into this step: the
  // implementer pushes the step onto that PR's branch instead of opening a new
  // one (src/reapproval.ts). NULL for every other entry.
  await getDb().addColumn("claws_issue_prs", "target_pr_number", "INTEGER");
  // A design change waiting for the operator's re-approval, one row per issue
  // keyed by the tracker id (src/reapproval.ts). `prs` is the revised plan's PR
  // list, which replaces `claws_issue_prs` only on approval; `fates` says what
  // happens to each open PR of the old plan; both are JSON. `approved_at` stays
  // NULL while the change is pending, and once set fences off the old plan's
  // PRs from coverage (src/planned-prs.ts).
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claws_issue_reapprovals (
      issue_id             TEXT PRIMARY KEY,
      requirements_version INTEGER NOT NULL,
      plan_comment_id      TEXT,
      prs                  TEXT NOT NULL,
      fates                TEXT NOT NULL,
      source_comment_ids   TEXT NOT NULL,
      requested_at         TEXT NOT NULL,
      approved_at          TEXT,
      approved_by          TEXT,
      FOREIGN KEY (issue_id) REFERENCES claws_issues(id) ON DELETE CASCADE
    )
  `);
  // One row per PR Claws works (docs/refinements/issue-flow.md "Pull request
  // state"). Phase 1: written alongside the PR state labels by the github.ts
  // label hook (src/pr-state.ts) and refreshed by the PR dispatcher; read only
  // by the issue auditor's comparison. See docs/database-schema.md.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claws_prs (
      repo                 TEXT NOT NULL,
      pr_number            INTEGER NOT NULL,
      issue_id             TEXT,
      phase                INTEGER,
      head_sha             TEXT,
      observed_at          TEXT,
      stage                TEXT NOT NULL DEFAULT 'opened',
      ci_status            TEXT,
      mergeable_state      TEXT,
      review_verdict       TEXT,
      reviewed_sha         TEXT,
      merge_approved_by    TEXT,
      merge_approved_at    TEXT,
      manual_action_reason TEXT,
      needs_human_review   INTEGER NOT NULL DEFAULT 0,
      ci_blocked_reason    TEXT,
      created_at           TEXT NOT NULL DEFAULT {{NOW}},
      updated_at           TEXT NOT NULL DEFAULT {{NOW}},
      PRIMARY KEY (repo, pr_number)
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_claws_prs_stage ON claws_prs(repo, stage)`);
  await getDb().addColumn("claws_prs", "title", "TEXT");
  await getDb().addColumn("claws_prs", "dispatch_note", "TEXT");
  await getDb().addColumn("claws_prs", "dispatch_note_at", "TEXT");
  // A human's board approval of an infrastructure PR's merge, bound to the head it was given for.
  await getDb().addColumn("claws_prs", "infra_merge_approved_by", "TEXT");
  await getDb().addColumn("claws_prs", "infra_merge_approved_at", "TEXT");
  await getDb().addColumn("claws_prs", "infra_merge_approved_sha", "TEXT");
  await migrateRetiredManualAction();
  // After the issue-label backfills. A single PR's merge approval is not read:
  // it stays on its `claws_prs` row, the partial Merge state.
  await migrateGateLabelsToApprovedThrough();
  await migrateAlertKindBackfill();
  // PR recovery actions an interactive session took through its session-only
  // tools (docs/product/interactive-sessions.md): who did what to which PR, so
  // the store tells a session's re-run or unmark apart from an operator's click.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS session_pr_actions (
      id          {{PK_AUTOINC}},
      repo        TEXT NOT NULL,
      pr_number   INTEGER NOT NULL,
      session_id  TEXT NOT NULL,
      action      TEXT NOT NULL,
      detail      TEXT,
      comment_id  TEXT,
      created_at  TEXT NOT NULL DEFAULT {{NOW}}
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_session_pr_actions_pr ON session_pr_actions(repo, pr_number)`);
  // Files attached to a native issue (#3289, docs/issue-tracker.md). A NULL
  // `issue_id` is a pending upload from the New Issue form, claimed when the
  // issue is created; `stored_path` is relative to WORK_DIR so the store
  // survives a data-dir move.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claws_issue_attachments (
      id             TEXT PRIMARY KEY,
      issue_id       TEXT,
      comment_id     TEXT,
      filename       TEXT NOT NULL,
      stored_path    TEXT NOT NULL,
      content_type   TEXT NOT NULL,
      size           INTEGER NOT NULL,
      uploader_login TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES claws_issues(id) ON DELETE CASCADE,
      FOREIGN KEY (comment_id) REFERENCES claws_issue_comments(id) ON DELETE SET NULL
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_claws_issue_attachments_issue ON claws_issue_attachments(issue_id)`);
  // Where the bytes live: `fs` under WORK_DIR (`stored_path`), or `s3` in the
  // attachments bucket under `<id>/<filename>` (#clw_01M5APX7YF3AGWHV1S1WMHJDR6).
  await getDb().addColumn("claws_issue_attachments", "storage", "TEXT NOT NULL DEFAULT 'fs'");
  // Files an interactive session published for the user to download
  // (`claws_publish_file`, docs/product/interactive-sessions.md). The bytes
  // live under WORK_DIR/session-files/<session_id>/, so they outlive the pod;
  // `session-files.ts` removes rows and files together when the session is
  // deleted or pruned.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS session_files (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      filename     TEXT NOT NULL,
      stored_path  TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size         INTEGER NOT NULL,
      created_at   TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_session_files_session ON session_files(session_id)`);
  // Files the operator attached to a new session's Initial prompt on the
  // Sessions page (`session-attachments.ts`, docs/product/interactive-sessions.md
  // "Attach files to a new session's first message"). Staged before the session
  // exists, so `session_id` is NULL until the create claims the row and fixes
  // `pod_name`, the file's name in the pod's uploads directory. The bytes live
  // in the attachments bucket (`storage` = `s3`) or under
  // WORK_DIR/session-attachments/pending/ (`fs`).
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS session_attachments (
      id           TEXT PRIMARY KEY,
      session_id   TEXT,
      filename     TEXT NOT NULL,
      pod_name     TEXT,
      stored_path  TEXT NOT NULL,
      storage      TEXT NOT NULL DEFAULT 'fs',
      content_type TEXT NOT NULL,
      size         INTEGER NOT NULL,
      created_at   TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_session_attachments_session ON session_attachments(session_id)`);
  // Typed links between tracker issues (docs/issue-tracker.md#links). One row
  // per fact, read from both ends: `depends_on` means source depends on target
  // ("target blocks source"); `relates_to` is undirected and stored with the
  // smaller id as `source_id`, so the unique key dedups both spellings.
  // `released_at` is stamped when the dispatcher's sweep unparks the source on
  // the link, so a later human re-park is not undone every cycle.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claws_issue_links (
      id          TEXT PRIMARY KEY,
      source_id   TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      created_by  TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      released_at TEXT,
      UNIQUE (source_id, target_id, kind),
      FOREIGN KEY (source_id) REFERENCES claws_issues(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES claws_issues(id) ON DELETE CASCADE
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_claws_issue_links_source ON claws_issue_links(source_id)`);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_claws_issue_links_target ON claws_issue_links(target_id)`);
  // Every recorded change to a native issue, shown in its History block
  // (docs/issue-tracker.md#history). Written by the issue writes below in the
  // same transaction as the change; a shadow never gets a row.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claws_issue_history (
      id         TEXT PRIMARY KEY,
      issue_id   TEXT NOT NULL,
      field      TEXT NOT NULL,
      old_value  TEXT,
      new_value  TEXT,
      actor_kind TEXT NOT NULL,
      actor      TEXT NOT NULL,
      run_id     TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES claws_issues(id) ON DELETE CASCADE
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_claws_issue_history_issue ON claws_issue_history(issue_id)`);
  // The per-issue model plan (docs/model-selection.md): one optional
  // provider/tier cell per pipeline phase. Keyed by (repo, ref) rather than by a
  // foreign key into claws_issues, so a forge number and a native `clw_…` id are
  // both valid refs and forge issues get planner-suggested cells too.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS issue_model_plan (
      repo       TEXT NOT NULL,
      issue_ref  TEXT NOT NULL,
      phase      TEXT NOT NULL,
      provider   TEXT,
      tier       TEXT,
      source     TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repo, issue_ref, phase)
    )
  `);

  await migrateIssueRefColumnsToText();

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
    await getDb().run(`DELETE FROM notified_untrusted_actors WHERE repo = ? AND issue_number = ?`, [r, refParam(n)]);
  }
}

/**
 * The issue-reference columns widened to TEXT so a Claws-native `clw_…` id can
 * be stored beside a forge number (#3215). `ci_fixer_breaker.item_number` is
 * deliberately absent: it is keyed by PR, and PRs are always forge-numbered.
 */
const ISSUE_REF_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["tasks", "item_number"],
  ["work_queue", "item_number"],
  ["notified_untrusted_actors", "issue_number"],
  ["reminder_notifications", "issue_number"],
  ["upstream_watch_fires", "issue_number"],
  ["blog_draft_ports", "issue_number"],
];

/**
 * Backfill `claws_issues.lifecycle` from the `Blocked` / `Backlog` label
 * rows it replaced, then delete those rows. The retired `Ready` and
 * `Refined` rows are {@link migrateGateLabelsToApprovedThrough}'s.
 *
 * Runs every boot and is idempotent: once no state label rows remain, every
 * statement matches nothing. The UPDATEs run in ascending precedence
 * (Blocked, Backlog) so the highest one an issue carries is the one left
 * standing — the board's `columnFor` order. Shadows are covered too; they are
 * `claws_issues` rows like any other. Plain UPDATE-with-EXISTS then DELETE, so
 * the same SQL runs on SQLite and Postgres.
 *
 * @internal Exported for `db.test.ts`, which writes the old label rows back to
 * exercise a migration a freshly created schema never needs.
 */
export async function migrateStateLabelsToLifecycle(): Promise<void> {
  for (const label of [...STATE_LABELS].reverse()) {
    await getDb().run(
      `UPDATE claws_issues SET lifecycle = ?
        WHERE EXISTS (SELECT 1 FROM claws_issue_labels l WHERE l.issue_id = claws_issues.id AND l.label = ?)`,
      [lifecycleForLabel(label), label],
    );
  }
  await getDb().run(
    `DELETE FROM claws_issue_labels WHERE label IN (${STATE_LABELS.map(() => "?").join(", ")})`,
    [...STATE_LABELS],
  );
}

/**
 * Fill `claws_issues.approved_through` from the retired gate labels and the
 * retired `approved` lifecycle (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F), then
 * delete those label rows. Per issue, the highest of:
 *
 * - `merge` — an `Automerge` label row on an issue the rules below already
 *   approve through Plan (a single PR's own merge approval stays on its
 *   `claws_prs` row, the partial Merge state). `Automerge` was only ever a
 *   merge pre-approval, and `merge` also approves the plan, so on an issue
 *   with no plan approval it is dropped and logged by issue id — the one
 *   value cannot hold "merge approved, plan not" — for an operator to
 *   re-approve through Merge once the plan is reviewed;
 * - `plan` — lifecycle `approved`, or a `Refined` or `Ship` row: a plan
 *   approval someone already gave;
 * - `plan` too for a `Claws Auto-Refine` row or a `[ci-unrelated]` title (the
 *   refiner used to approve those trackers by title), but only while no plan
 *   awaits review — lifecycle `ideas` or `planning` and no `Ready` row. Those
 *   approved only a plan not yet written, and the refiner held back one it
 *   had posted (a `reconsider` verdict, say), so such a plan stays for a human;
 * - `requirements` — approved requirements, or a lifecycle past Ideas.
 *
 * The first run, recorded under {@link APPROVED_THROUGH_MIGRATED_KEY} in
 * `controller_status` in the same transaction, applies every rule to the
 * rows never written since the column arrived (`approved_through_at IS
 * NULL`) and to every row holding a gate label or the `approved` lifecycle,
 * so an issue approved through Requirements since keeps its gate labels'
 * approval. Later runs, while leftover gate label rows or an `approved`
 * lifecycle remain (an old-build pod during a rollout — the issue dispatcher
 * runs this pass every tick, so it does not wait for the next controller
 * boot), consider only the issues that
 * hold one and raise them from those labels and that lifecycle alone, so a
 * later issue is never approved by its title. The value only
 * ever rises, so it is idempotent, and a withdrawal is undone only by a fresh
 * gate label. An issue with a plan and any open or merged phase PR rises to
 * `plan` too: the implementer removed `Refined` while a step's PR was open.
 * `approved_through_by` reads `migration`, and a raise through
 * Plan sets `plan_approved_at`. Then `approved`
 * becomes `awaiting-plan-review` and a `Ready` or `Refined` row moves an
 * issue still in Ideas or Planning there. One transaction, plain SQL on both
 * drivers.
 *
 * Run by `migrateSchema` at boot and by the issue dispatcher each tick.
 */
export async function migrateGateLabelsToApprovedThrough(): Promise<void> {
  const gateParams = RETIRED_GATE_LABELS.map(() => "?").join(", ");
  const holdsGateState = `(lifecycle = 'approved'
       OR EXISTS (SELECT 1 FROM claws_issue_labels l WHERE l.issue_id = claws_issues.id AND l.label IN (${gateParams})))`;
  const pending = await getDb().get(
    `SELECT 1 AS n FROM claws_issues WHERE ${holdsGateState} LIMIT 1`,
    [...RETIRED_GATE_LABELS],
  ) as { n: number } | undefined;
  const firstRun = (await readControllerStatus<unknown>(APPROVED_THROUGH_MIGRATED_KEY)) === null;
  if (!pending && !firstRun) return;
  await getDb().transaction(async (tx) => {
    const rows = await tx.all(
      `SELECT id, title, lifecycle, requirements_approved_at, approved_through FROM claws_issues
        WHERE ${firstRun ? `approved_through_at IS NULL OR ${holdsGateState}` : holdsGateState}`,
      [...RETIRED_GATE_LABELS],
    ) as Array<{ id: string; title: string; lifecycle: string; requirements_approved_at: string | null; approved_through: string }>;
    const labelRows = await tx.all(
      `SELECT issue_id, label FROM claws_issue_labels WHERE label IN (${gateParams})`,
      [...RETIRED_GATE_LABELS],
    ) as Array<{ issue_id: string; label: string }>;
    const labels = new Map<string, Set<string>>();
    for (const r of labelRows) labels.set(r.issue_id, (labels.get(r.issue_id) ?? new Set()).add(r.label));
    // The implementer removed `Refined` while a step's PR was open, so an issue
    // with a plan and any open or merged PR is mid-plan and stays approved through Plan.
    const inFlight = new Set((await tx.all(
      `SELECT DISTINCT p.issue_id FROM claws_prs p JOIN claws_issue_plans pl ON pl.issue_id = p.issue_id WHERE p.stage <> 'closed'`,
    ) as Array<{ issue_id: string }>).map((r) => r.issue_id));
    const now = nowSql();
    for (const row of rows) {
      const held = labels.get(row.id) ?? new Set<string>();
      let value: ApprovedThrough = isApprovedThrough(row.approved_through) ? row.approved_through : "none";
      // A Ready or Refined row moves the issue past Ideas below, so it counts as past Ideas here.
      const pastIdeas = ["planning", "awaiting-plan-review", "approved"].includes(row.lifecycle) || held.has("Ready") || held.has("Refined");
      if (row.requirements_approved_at !== null || pastIdeas) value = maxApproval(value, "requirements");
      if (row.lifecycle === "approved" || held.has("Refined") || held.has("Ship") || inFlight.has(row.id)) value = maxApproval(value, "plan");
      // A standing pre-approval covers only a plan still to come.
      const noPlanAwaitingReview = (row.lifecycle === "ideas" || row.lifecycle === "planning") && !held.has("Ready");
      if (noPlanAwaitingReview && (held.has("Claws Auto-Refine") || (firstRun && row.title.startsWith("[ci-unrelated]")))) {
        value = maxApproval(value, "plan");
      }
      if (held.has("Automerge")) {
        if (atLeast(value, "plan")) value = maxApproval(value, "merge");
        else logCore.warn(`[db] ${row.id}: dropped its Automerge merge pre-approval — its plan is not approved; approve it through Merge once the plan is reviewed`);
      }
      if (value === row.approved_through) continue;
      const risesThroughPlan = atLeast(value, "plan") && !atLeast(row.approved_through, "plan");
      await tx.run(
        `UPDATE claws_issues SET approved_through = ?, approved_through_by = 'migration', approved_through_at = ?${risesThroughPlan ? ", plan_approved_at = ?" : ""} WHERE id = ?`,
        [value, now, ...(risesThroughPlan ? [now] : []), row.id],
      );
    }
    // The derived Approved column keeps an `approved` card where it was, so its time-in-column stands.
    await tx.run(`UPDATE claws_issues SET lifecycle = 'awaiting-plan-review' WHERE lifecycle = 'approved'`);
    await tx.run(
      `UPDATE claws_issues SET lifecycle = 'awaiting-plan-review', stage_changed_at = ?
        WHERE lifecycle IN ('ideas', 'planning')
          AND EXISTS (SELECT 1 FROM claws_issue_labels l WHERE l.issue_id = claws_issues.id AND l.label IN ('Ready', 'Refined'))`,
      [now],
    );
    await tx.run(`DELETE FROM claws_issue_labels WHERE label IN (${gateParams})`, [...RETIRED_GATE_LABELS]);
    if (firstRun) {
      await tx.run(
        `INSERT INTO controller_status (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        [APPROVED_THROUGH_MIGRATED_KEY, JSON.stringify(true), now],
      );
    }
  });
}

/** The `controller_status` key that records {@link migrateGateLabelsToApprovedThrough}'s first run. */
export const APPROVED_THROUGH_MIGRATED_KEY = "approved_through_migrated";

/** Title prefixes the alert paths filed under before `alert_kind` existed. */
const LEGACY_ALERT_TITLE_PREFIXES = [
  "[claws-error]", "[ci-unrelated]", "[runner-monitor]", "[host-disk-monitor]", "[dmarc]", "[snapshot]",
  "[upstream-watcher]", "[disallowed-actor]", "[main]", "Build failure: ",
];

/** The `controller_status` key that records {@link migrateAlertKindBackfill}'s run. */
export const ALERT_KIND_BACKFILLED_KEY = "alert_kind_backfilled";

/**
 * Mark the open alert issues filed before `claws_issues.alert_kind` existed
 * as `legacy`, once: an open issue by `claws` whose title or filed title
 * starts with one of {@link LEGACY_ALERT_TITLE_PREFIXES}, whose dedupe key
 * starts `alert-`, or that carries an `alert` / `grafana-alert` label. A
 * recurring alert the prefixes miss marks itself on its next occurrence
 * (`ensureAlertIssue`'s update path). Recorded under
 * {@link ALERT_KIND_BACKFILLED_KEY} in the same transaction.
 *
 * @internal Exported for `db.test.ts`.
 */
export async function migrateAlertKindBackfill(): Promise<void> {
  if ((await readControllerStatus<unknown>(ALERT_KIND_BACKFILLED_KEY)) !== null) return;
  const titleClauses = LEGACY_ALERT_TITLE_PREFIXES.map(() => `title LIKE ? OR filed_title LIKE ?`).join(" OR ");
  const titleParams = LEGACY_ALERT_TITLE_PREFIXES.flatMap((prefix) => [`${prefix}%`, `${prefix}%`]);
  await getDb().transaction(async (tx) => {
    await tx.run(
      `UPDATE claws_issues SET alert_kind = 'legacy'
        WHERE state = 'open' AND kind <> 'shadow' AND author_login = 'claws' AND alert_kind IS NULL
          AND (${titleClauses} OR dedupe_key LIKE 'alert-%'
            OR EXISTS (SELECT 1 FROM claws_issue_labels l WHERE l.issue_id = claws_issues.id AND l.label IN ('alert', 'grafana-alert')))`,
      titleParams,
    );
    await tx.run(
      `INSERT INTO controller_status (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [ALERT_KIND_BACKFILLED_KEY, JSON.stringify(true), nowSql()],
    );
  });
}

/**
 * Move issues off the lifecycle values the requirements stage retired
 * (#clw_01M39G3SREWPRP5AH0THJR0P24): `awaiting-review` becomes
 * `awaiting-plan-review`, and `inbox` becomes `planning` for an issue that
 * already has a plan or an approved requirements version — the same
 * predicate `clawsIssues.entryLifecycle` and `ENTRY_LIFECYCLE_SQL` use, so
 * every path that decides "has this issue's requirements been approved"
 * agrees, plus a shadow, which gets no `ENTRY_LIFECYCLE_SQL` exception: a
 * shadow's plan lives on the forge, not in `claws_issue_plans` (only a native
 * plan comment writes that table), so the general predicate alone would send
 * a planned forge issue sitting in `inbox` to Ideas. A forge issue that
 * reached the old Inbox had already been through the forge flow, and the
 * forge has no Ideas stage to send it back to, so every shadow goes straight
 * to Planning here — and `ideas` for whatever native issue is left.
 *
 * The same pass backfills `source` on every row that predates it, matched on
 * `source IS NULL` and re-run every boot rather than gated to the one that
 * adds the column: a shadow is `forge`, an issue Claws itself filed
 * (`author_login = 'claws'`) is `automation`, and everything else is
 * `dashboard`. A boot that fails partway through — after the column is added
 * but before this runs — still finds every unbackfilled row NULL on its next
 * attempt, rather than leaving them stuck under the column's old default
 * forever. `createShadowIssue` and `createClawsIssue` write a non-NULL source
 * outright, so a re-run touches nothing a prior run or a normal create
 * already set.
 *
 * The lifecycle rename itself still runs every boot but does nothing unless
 * some row still holds `inbox` or `awaiting-review`, and moves every such
 * row, so a second run changes nothing there either. The queued-planner skip
 * below it runs unconditionally instead, keyed on current state
 * (`lifecycle = 'ideas'`) rather than on which rows this run's rename just
 * touched: a boot that dies between the rename's commit and that skip would
 * otherwise leave a queued `issue-refiner:` row free to bypass the promotion
 * gate forever, since the next boot's `pending` check finds nothing left to
 * rename and never revisits it.
 *
 * @internal Exported for `db.test.ts`.
 */
export async function migrateInboxToIdeas(): Promise<void> {
  await getDb().run(
    `UPDATE claws_issues SET source = CASE WHEN kind = 'shadow' THEN 'forge' WHEN author_login = 'claws' THEN 'automation' ELSE 'dashboard' END WHERE source IS NULL`,
  );
  const pending = await getDb().get(
    `SELECT 1 AS n FROM claws_issues WHERE lifecycle IN ('inbox', 'awaiting-review') LIMIT 1`,
  ) as { n: number } | undefined;
  if (pending) {
    await getDb().transaction(async (tx) => {
      await tx.run(`UPDATE claws_issues SET lifecycle = 'awaiting-plan-review' WHERE lifecycle = 'awaiting-review'`);
      await tx.run(
        `UPDATE claws_issues SET lifecycle = 'planning' WHERE lifecycle = 'inbox' AND kind = 'shadow'`,
      );
      await tx.run(`UPDATE claws_issues SET lifecycle = ${ENTRY_LIFECYCLE_SQL} WHERE lifecycle = 'inbox'`);
    });
  }
  // Keyed on current state, not on the rename above — see the docblock.
  const inIdeas = await getDb().all(`SELECT id FROM claws_issues WHERE lifecycle = 'ideas'`) as Array<{ id: string }>;
  for (const row of inIdeas) {
    await skipQueuedPlannerWork(row.id, "issue is in Ideas");
  }
}

/**
 * Retire the `Claws Ignore` label from the native tracker
 * (#clw_01M55F0ACDZP8ND1BNRZ8TNGPD): an open issue or shadow that carries it
 * moves to the Backlog, so it stays parked, and then every `Claws Ignore`
 * label row is deleted — a closed issue just loses the row.
 *
 * Runs every boot and is idempotent: once no label row remains, both
 * statements match nothing. `stage_changed_at` and `updated_at` move only
 * for a row whose lifecycle actually changes.
 *
 * @internal Exported for `db.test.ts`.
 */
export async function migrateClawsIgnoreLabel(): Promise<void> {
  const now = nowSql();
  await getDb().transaction(async (tx) => {
    await tx.run(
      `UPDATE claws_issues SET lifecycle = 'backlog', stage_changed_at = ?, updated_at = ?
        WHERE state = 'open' AND lifecycle <> 'backlog'
          AND EXISTS (SELECT 1 FROM claws_issue_labels l WHERE l.issue_id = claws_issues.id AND l.label = 'Claws Ignore')`,
      [now, now],
    );
    await tx.run(`DELETE FROM claws_issue_labels WHERE label = 'Claws Ignore'`);
  });
}

/**
 * Skip any `issue-refiner:` work still queued for an issue that just moved to
 * Ideas — a demotion, or {@link migrateInboxToIdeas} — so a queued planner run
 * cannot bypass the gate every issue reaching Ideas the normal way is subject
 * to. A shadow's queued row is keyed by the forge ref `getImportedIssueByNative`
 * names; a native issue's may be queued under any repo it is assigned to,
 * since the dispatcher enqueues `issue-refiner:` work per repo it dispatches
 * from. Shared by both callers so they agree on which repos' queued rows get
 * skipped.
 */
export async function skipQueuedPlannerWork(issueId: string, reason: string): Promise<void> {
  const imported = await getImportedIssueByNative(issueId);
  if (imported) {
    await skipQueuedWorkForItem("issue-refiner:", imported.repo, imported.forgeNumber, reason);
    return;
  }
  const repos = await getDb().all(`SELECT repo FROM claws_issue_repos WHERE issue_id = ?`, [issueId]) as Array<{ repo: string }>;
  for (const { repo } of repos) {
    await skipQueuedWorkForItem("issue-refiner:", repo, issueId, reason);
  }
}

/**
 * Widen the {@link ISSUE_REF_COLUMNS} from BIGINT to TEXT on an existing
 * Postgres database.
 *
 * SQLite needs nothing: `CREATE TABLE` above already declares TEXT, and its
 * column affinity is per-value anyway, so an old file keeps working. Postgres
 * is strict, so the live database has to be rewritten in place.
 *
 * All six ALTERs go out as **one** `exec()` string wrapped in an explicit
 * transaction, over the simple protocol: either every column changes or none
 * does, so a partial failure can never leave the schema half-widened while the
 * code assumes TEXT.
 *
 * Two timeouts, because they bound different things. `lock_timeout` caps the
 * wait to *acquire* each ACCESS EXCLUSIVE lock; `statement_timeout` caps the
 * table rewrite that follows, which is unbounded otherwise — `tasks` carries
 * 90 days of retention plus every row pinned by a `job_runs` row, and a slow
 * rewrite is exactly the hung migration this guards against. Either way boot
 * fails with a logged Postgres error instead of the startup probe killing the
 * pod mid-`ALTER` with nothing to say why.
 *
 * Rolling back to a pre-migration image needs the reverse ALTER run by hand —
 * see docs/database-schema.md.
 *
 * **The migration is forward-only, and the workload must not surge.** The
 * pre-change `getRecentWorkItems` ran `WHERE item_number > 0`; against a
 * `text` column Postgres rejects that with `operator does not exist: text >
 * integer`, so an old pod still serving after a new one commits this would
 * start failing. Claws is deployed as the single-replica StatefulSet
 * `claws` (`podManagementPolicy: OrderedReady`,
 * `updateStrategy: RollingUpdate`) — a StatefulSet rolls by terminating the
 * old pod *before* creating its replacement, so no such overlap exists. Do not
 * move this workload to a `Deployment` with a non-zero `maxSurge` without
 * re-examining that.
 *
 * @internal Exported for `db.test.ts`, which narrows the columns back to
 * BIGINT to exercise a migration a freshly created schema never needs.
 */
export async function migrateIssueRefColumnsToText(): Promise<void> {
  if (getDb().dialect !== "postgres") return;

  // Scoped to the six pairs rather than every non-text column in the schema:
  // the probe runs on every boot, and `information_schema.columns` is a join
  // over the whole catalogue.
  const tables = [...new Set(ISSUE_REF_COLUMNS.map(([table]) => table))];
  const columns = [...new Set(ISSUE_REF_COLUMNS.map(([, column]) => column))];
  const rows = await getDb().all(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND data_type <> 'text'
        AND table_name IN (${tables.map(() => "?").join(",")})
        AND column_name IN (${columns.map(() => "?").join(",")})`,
    [...tables, ...columns],
  ) as Array<{ table_name: string; column_name: string; data_type: string }>;
  const stale = ISSUE_REF_COLUMNS.filter(([table, column]) =>
    rows.some((r) => r.table_name === table && r.column_name === column));
  if (stale.length === 0) return;

  log.info(`Migrating ${stale.length} issue-reference column(s) to TEXT: ${stale.map(([t, c]) => `${t}.${c}`).join(", ")}`);
  const started = Date.now();
  // Only the stale columns: every ALTER takes an ACCESS EXCLUSIVE lock and
  // rewrites the table, so re-stating an already-TEXT column in a mixed state
  // would pay the full cost of a migration that has nothing to do.
  try {
    await getDb().exec([
      "BEGIN",
      "SET LOCAL lock_timeout = '30s'",
      "SET LOCAL statement_timeout = '120s'",
      ...stale.map(([table, column]) =>
        `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE TEXT USING ${column}::text`),
      "COMMIT",
    ].join(";\n") + ";");
  } catch (err) {
    // The simple protocol discards the rest of the batch once a statement
    // fails — the trailing COMMIT included — so the connection is left sitting
    // inside an aborted transaction. The ALTERs are already rolled back at
    // that point; this only releases the connection, so the error that aborts
    // boot is the migration's own and not "current transaction is aborted"
    // from whatever ran next.
    await getDb().exec("ROLLBACK").catch(() => {});
    throw err;
  }
  log.info(`Issue-reference columns migrated to TEXT in ${Date.now() - started}ms`);
}

export interface TaskOutcome {
  commits?: number;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  prNumber?: number;
  /** The repo `prNumber` is in, when it is not the task's own `repo` — a
   *  multi-repo issue's step whose PR is in another of the issue's repos. */
  prRepo?: string;
  prAction?: "created" | "updated" | "reviewed" | "skipped";
  headSha?: string;
  reviewResult?: "clean" | "advisory" | "blocking" | "escalated" | "empty-diff";
  /** The pr-reviewer round number this outcome completed; read back by
   *  `backfillPRReviews()` so a task-outcome-only backfilled row (no matching
   *  effectiveness event) doesn't restart iteration counting at 1. */
  reviewIteration?: number;
  failureCategory?: string;
  /** Effective agent memory cap, in bytes, that an `AgentMemoryLimitError` breached.
   *  Lets `countRecentMemoryLimits()` count same-cap strikes structurally instead of
   *  parsing the rendered error message. */
  memoryLimitBytes?: number;
  /** Reason a CI-fixer agent gave (its `CI-FIX-GIVE-UP:` line) for not fixing the
   *  failure; a run carrying one counts towards the fix-attempt cap. */
  giveUpReason?: string;
  /** Why a pre-spawn re-validation skipped the row (`merged`, `closed`, `parked`, ...). */
  skipReason?: string;
}

export interface Task {
  id: number;
  job_name: string;
  repo: string;
  item_number: IssueRef;
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
  itemNumber: IssueRef;
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

/** Stamp every task started in this process with the current run context's run id. Each role calls this at boot. */
export function stampTasksWithRunContext(): void {
  setRunIdProvider(() => logCore.runContext.getStore()?.runId);
}

export async function recordTaskStart(
  jobName: string,
  repo: string,
  itemNumber: IssueRef,
  triggerLabel: string | null,
): Promise<number> {
  const currentRunId = runIdProvider?.() ?? null;
  const result = await getDb().insert(
    `INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    [jobName, repo, refParam(itemNumber), triggerLabel, currentRunId, nowSql()],
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

/**
 * Record the provider serving task `taskId`, and the Claude account it ran on
 * (`account_used`; cleared when the provider ran on no Claude account).
 */
export async function updateTaskProvider(taskId: number, provider: string, account?: string): Promise<void> {
  await getDb().run(`UPDATE tasks SET provider_used = ?, account_used = ? WHERE id = ?`, [provider, account ?? null, taskId]);
}

export interface ProviderHoldRow {
  key: string;
  until_ms: number;
  reason: string | null;
  updated_at: string | null;
}

/** Every recorded provider hold, lapsed ones included (callers judge `until_ms` against the clock). */
export async function listProviderHolds(): Promise<ProviderHoldRow[]> {
  const rows = await getDb().all<ProviderHoldRow>(`SELECT key, until_ms, reason, updated_at FROM provider_holds`);
  return rows.map((r) => ({ ...r, until_ms: Number(r.until_ms) }));
}

/** Epoch-ms when `repo`'s moderation endpoint first answered 404/405, or null when it is live. */
export async function getContentModerationNotLiveSince(repo: string): Promise<number | null> {
  const row = await getDb().get<{ since_ms: number }>(`SELECT since_ms FROM content_moderation_not_live WHERE repo = ?`, [repo]);
  return row ? Number(row.since_ms) : null;
}

/** Record the first sighting of the not-live state; an existing row keeps its earlier time. */
export async function markContentModerationNotLive(repo: string, sinceMs: number): Promise<void> {
  await getDb().run(`INSERT INTO content_moderation_not_live (repo, since_ms) VALUES (?, ?) ON CONFLICT(repo) DO NOTHING`, [repo, Math.round(sinceMs)]);
}

/** Forget `repo`'s not-live state. */
export async function clearContentModerationNotLive(repo: string): Promise<void> {
  await getDb().run(`DELETE FROM content_moderation_not_live WHERE repo = ?`, [repo]);
}

/** Record (or replace) the hold `key` until epoch-ms `untilMs`. */
export async function setProviderHold(key: string, untilMs: number, reason: string | null): Promise<void> {
  await getDb().run(
    `INSERT INTO provider_holds (key, until_ms, reason, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET until_ms = excluded.until_ms, reason = excluded.reason, updated_at = excluded.updated_at`,
    [key, Math.round(untilMs), reason, new Date().toISOString()],
  );
}

/**
 * Delete the hold `prefix` and every hold under it (`<prefix>:…` tier holds and
 * `<prefix>@…` account holds); an empty prefix deletes every hold. Returns the
 * number of rows deleted.
 */
export async function clearProviderHolds(prefix: string): Promise<number> {
  if (!prefix) return (await getDb().run(`DELETE FROM provider_holds`)).changes;
  const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  const res = await getDb().run(
    `DELETE FROM provider_holds WHERE key = ? OR key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\'`,
    [prefix, `${escaped}:%`, `${escaped}@%`],
  );
  return res.changes;
}

export interface ClaudeAccountRow {
  id: string;
  label: string;
  token: string | null;
  position: number;
}

/** Every stored Claude account, tokens included, in `position` order. Never send a row to a browser. */
export async function listClaudeAccounts(): Promise<ClaudeAccountRow[]> {
  const rows = await getDb().all<ClaudeAccountRow>(`SELECT id, label, token, position FROM claude_accounts ORDER BY position, id`);
  return rows.map((r) => ({ ...r, position: Number(r.position) }));
}

/** Add Claude account `id` after every existing one, with no token. Throws when `id` already exists. */
export async function insertClaudeAccount(id: string, label: string): Promise<void> {
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO claude_accounts (id, label, token, position, created_at, updated_at)
     VALUES (?, ?, NULL, (SELECT COALESCE(MAX(position), -1) + 1 FROM claude_accounts), ?, ?)`,
    [id, label, now, now],
  );
}

/** Relabel Claude account `id`; false when it does not exist. */
export async function updateClaudeAccountLabel(id: string, label: string): Promise<boolean> {
  const res = await getDb().run(`UPDATE claude_accounts SET label = ?, updated_at = ? WHERE id = ?`, [label, new Date().toISOString(), id]);
  return res.changes > 0;
}

/** Store Claude account `id`'s OAuth token; false when the account does not exist. */
export async function setClaudeAccountToken(id: string, token: string | null): Promise<boolean> {
  const res = await getDb().run(`UPDATE claude_accounts SET token = ?, updated_at = ? WHERE id = ?`, [token, new Date().toISOString(), id]);
  return res.changes > 0;
}

/** Delete Claude account `id` and its token; false when it does not exist. */
export async function deleteClaudeAccount(id: string): Promise<boolean> {
  const res = await getDb().run(`DELETE FROM claude_accounts WHERE id = ?`, [id]);
  return res.changes > 0;
}

/** The `run_id` task `taskId` was recorded under, or null when it has none or does not exist. */
export async function getTaskRunId(taskId: number): Promise<string | null> {
  const row = await getDb().get<{ run_id: string | null }>(`SELECT run_id FROM tasks WHERE id = ?`, [taskId]);
  return row?.run_id ?? null;
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
 * reporting backend into `tasks.provider_used` (and its Claude account into
 * `tasks.account_used`) on every call that supplies one; when a task spans two
 * backends or accounts, the last reporter wins.
 *
 * The callback stays synchronous — `runClaude` invokes it from a stream handler
 * — so the writes are issued without being awaited. The driver serialises them
 * in call order, so the last write still wins.
 */
export function trackTaskTokens(taskId: number): (tokensUsed: number, costUsd: number, provider?: string, account?: string) => void {
  let tokens = 0;
  let cost = 0;
  let lastProvider: string | undefined;
  let lastAccount: string | undefined;
  return (t, c, provider, account) => {
    tokens += t;
    cost += c;
    void updateTaskTokenUsage(taskId, tokens, cost).catch((err: unknown) => {
      log.warn(`trackTaskTokens(${taskId}) usage write failed: ${err}`);
    });
    if (provider && (provider !== lastProvider || account !== lastAccount)) {
      lastProvider = provider;
      lastAccount = account;
      void updateTaskProvider(taskId, provider, account).catch((err: unknown) => {
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

/**
 * The task that produced `headSha` on the PR. Every pr-reviewer outcome
 * records the head it reviewed, so a reviewer round only counts as a producer
 * when it pushed (the advisory self-fix, `commits > 0`).
 */
export async function findLatestCompletedTaskForPrHead(repo: string, prNumber: number, headSha: string): Promise<Task | null> {
  const row = await getDb().get(`
      SELECT *
      FROM tasks
      WHERE COALESCE(json_extract(outcome, '$.prRepo'), repo) = ?
        AND status = 'completed'
        AND outcome IS NOT NULL
        AND CAST(json_extract(outcome, '$.prNumber') AS INTEGER) = ?
        AND json_extract(outcome, '$.headSha') = ?
        AND NOT (job_name = 'pr-reviewer' AND COALESCE(CAST(json_extract(outcome, '$.commits') AS INTEGER), 0) = 0)
      ORDER BY completed_at DESC, id DESC
      LIMIT 1
    `, [repo, prNumber, headSha]) as Task | undefined;
  return row ? normalizeItemNumbers([row])[0]! : null;
}

/** Verdict of a completed pr-reviewer round — the `TaskOutcome.reviewResult` union. */
export type PRReviewVerdict = NonNullable<TaskOutcome["reviewResult"]>;

/** Max characters of review text stored in `pr_reviews.findings`. */
const PR_REVIEW_FINDINGS_MAX_CHARS = 20_000;

export interface PRReviewRecord {
  id: number;
  repo: string;
  prNumber: number;
  /** Full head SHA recorded for the round — the PR's head once the round finished, which on
   * an advisory self-fix round is the commit the reviewer pushed, not what the model reviewed
   * (see `reviewedSha`). */
  headSha: string;
  /** The commit the model actually reviewed. Equal to `headSha` except on an advisory
   * self-fix round, where it is the pre-fix commit — the correct start of the next
   * incremental delta, so the fix itself is not silently skipped. `null` for rows that
   * predate this column (backfilled rows; treat as `headSha`). */
  reviewedSha: string | null;
  /** `git merge-base origin/<base> HEAD` at review time; `''` for backfilled rows. */
  baseSha: string;
  verdict: PRReviewVerdict;
  mode: "full" | "incremental";
  iteration: number;
  reviewerTaskId: number | null;
  provider: string | null;
  model: string | null;
  findings: string | null;
  /** ISO-8601 UTC timestamp. */
  createdAt: string;
}

export type PRReviewInput = Omit<PRReviewRecord, "id" | "createdAt">;

interface PRReviewRow {
  id: number;
  repo: string;
  pr_number: number;
  head_sha: string;
  reviewed_sha: string | null;
  base_sha: string;
  verdict: string;
  mode: string;
  iteration: number;
  reviewer_task_id: number | null;
  provider: string | null;
  model: string | null;
  findings: string | null;
  created_at: string;
}

/** A SQL `datetime('now')` string (`YYYY-MM-DD HH:MM:SS`, UTC) as ISO-8601; an ISO value passes through. */
function sqlTimeToIso(value: string): string;
function sqlTimeToIso(value: string | null): string | null;
function sqlTimeToIso(value: string | null): string | null {
  if (value === null || value === undefined) return null;
  return value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
}

function toPRReviewRecord(row: PRReviewRow): PRReviewRecord {
  return {
    id: Number(row.id),
    repo: row.repo,
    prNumber: Number(row.pr_number),
    headSha: row.head_sha,
    reviewedSha: row.reviewed_sha,
    baseSha: row.base_sha,
    verdict: row.verdict as PRReviewVerdict,
    mode: row.mode === "incremental" ? "incremental" : "full",
    iteration: Number(row.iteration),
    reviewerTaskId: row.reviewer_task_id === null ? null : Number(row.reviewer_task_id),
    provider: row.provider,
    model: row.model,
    findings: row.findings,
    createdAt: sqlTimeToIso(row.created_at),
  };
}

/** Record a completed review round. Re-reviewing the same head (a rebuttal round) overwrites its row. */
export async function recordPRReview(input: PRReviewInput): Promise<void> {
  await getDb().run(`
      INSERT INTO pr_reviews
        (repo, pr_number, head_sha, reviewed_sha, base_sha, verdict, mode, iteration, reviewer_task_id, provider, model, findings, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo, pr_number, head_sha) DO UPDATE SET
        reviewed_sha = excluded.reviewed_sha,
        base_sha = excluded.base_sha,
        verdict = excluded.verdict,
        mode = excluded.mode,
        iteration = excluded.iteration,
        reviewer_task_id = excluded.reviewer_task_id,
        provider = excluded.provider,
        model = excluded.model,
        findings = excluded.findings,
        created_at = excluded.created_at
    `, [
      input.repo,
      input.prNumber,
      input.headSha,
      input.reviewedSha,
      input.baseSha,
      input.verdict,
      input.mode,
      input.iteration,
      input.reviewerTaskId,
      input.provider,
      input.model,
      input.findings === null ? null : input.findings.slice(0, PR_REVIEW_FINDINGS_MAX_CHARS),
      nowSql(),
    ]);
  // `review-posted` carries the verdict, so a waiter acts without fetching the
  // review comment; the PR's issue rides in `related`.
  let issueId: string | null = null;
  try {
    issueId = (await getClawsPr(input.repo, input.prNumber))?.issueId ?? null;
  } catch (err) {
    log.warn(`recordPRReview: could not read ${input.repo}#${input.prNumber}'s issue: ${err}`);
  }
  const issueRef = issueId ? canonicalIssueRef(issueId) : null;
  recordGitHubEvent({
    kind: "review-posted",
    repo: input.repo,
    number: input.prNumber,
    related: issueRef === null || issueRef === 0 ? [] : [issueRef],
    detail: reviewPostedDetail(input.verdict),
  });
}

/** A review verdict as `review-posted`'s detail: `clean` when it does not block the merge, else `blocking`. */
export function reviewPostedDetail(verdict: PRReviewVerdict): "clean" | "blocking" {
  return verdict === "clean" || verdict === "advisory" || verdict === "empty-diff" ? "clean" : "blocking";
}

/**
 * Newest first by `created_at`, then `id`. `created_at` leads so a rebuttal
 * re-review (an upsert of an existing, lower-id row) and backfilled rows (whose
 * insertion order does not follow review order) still sort chronologically.
 */
export async function listPRReviews(repo: string, prNumber: number, limit = 5): Promise<PRReviewRecord[]> {
  const rows = await getDb().all(`
      SELECT * FROM pr_reviews
      WHERE repo = ? AND pr_number = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `, [repo, prNumber, limit]) as PRReviewRow[];
  return rows.map(toPRReviewRecord);
}

/** The most recent completed review round for a PR, or null if none is recorded. */
export async function getLatestPRReview(repo: string, prNumber: number): Promise<PRReviewRecord | null> {
  return (await listPRReviews(repo, prNumber, 1))[0] ?? null;
}

/**
 * Seed `pr_reviews` from the observability rows written before the table
 * existed: `pr-review` effectiveness events, then completed pr-reviewer task
 * outcomes carrying both `headSha` and `reviewResult`. Backfilled rows get
 * `base_sha = ''`, so the next round on those PRs is always a full review.
 *
 * One-shot: skipped once `pr_reviews` holds any row. Running this on every
 * boot would let it race live writes — a self-fix round's `pr_reviews` row
 * and its effectiveness event (recorded on the pre-fix SHA) can have the same
 * `created_at` ordering, so a later backfill can insert a same-`created_at`
 * phantom row for the pre-fix event that outranks the live row in
 * `listPRReviews`'s `created_at DESC, id DESC` order.
 */
export async function backfillPRReviews(): Promise<void> {
  try {
    const existing = await getDb().get(`SELECT 1 FROM pr_reviews LIMIT 1`);
    if (existing) return;
    await getDb().run(`
      INSERT INTO pr_reviews
        (repo, pr_number, head_sha, reviewed_sha, base_sha, verdict, mode, iteration, reviewer_task_id, provider, model, findings, created_at)
      SELECT
        e.source_repo,
        e.source_number,
        e.source_sha,
        NULL,
        '',
        CASE e.signal
          WHEN 'pr-review-clean' THEN 'clean'
          WHEN 'pr-review-advisory' THEN 'advisory'
          WHEN 'pr-review-blocking' THEN 'blocking'
          WHEN 'pr-review-escalated' THEN 'escalated'
          ELSE 'empty-diff'
        END,
        'full',
        COALESCE(CAST(json_extract(e.details, '$.iteration') AS INTEGER), 1),
        CAST(json_extract(e.details, '$.reviewerTaskId') AS INTEGER),
        t.provider_used,
        t.model_used,
        NULL,
        e.created_at
      FROM task_effectiveness_events e
      LEFT JOIN tasks t ON t.id = CAST(json_extract(e.details, '$.reviewerTaskId') AS INTEGER)
      WHERE e.source = 'pr-review'
        AND e.source_sha <> ''
        AND e.signal IN ('pr-review-clean', 'pr-review-advisory', 'pr-review-blocking', 'pr-review-escalated', 'pr-review-empty-diff')
        AND NOT EXISTS (
          SELECT 1 FROM pr_reviews p
          WHERE p.reviewer_task_id = CAST(json_extract(e.details, '$.reviewerTaskId') AS INTEGER)
        )
      ORDER BY e.created_at, e.id
      ON CONFLICT(repo, pr_number, head_sha) DO NOTHING
    `);
    await getDb().run(`
      INSERT INTO pr_reviews
        (repo, pr_number, head_sha, reviewed_sha, base_sha, verdict, mode, iteration, reviewer_task_id, provider, model, findings, created_at)
      SELECT
        repo,
        CAST(json_extract(outcome, '$.prNumber') AS INTEGER),
        json_extract(outcome, '$.headSha'),
        NULL,
        '',
        json_extract(outcome, '$.reviewResult'),
        'full',
        COALESCE(CAST(json_extract(outcome, '$.reviewIteration') AS INTEGER), 1),
        id,
        provider_used,
        model_used,
        NULL,
        COALESCE(completed_at, started_at)
      FROM tasks
      WHERE job_name = 'pr-reviewer'
        AND status = 'completed'
        AND outcome IS NOT NULL
        AND json_extract(outcome, '$.headSha') IS NOT NULL
        AND json_extract(outcome, '$.reviewResult') IS NOT NULL
        AND json_extract(outcome, '$.prNumber') IS NOT NULL
      ORDER BY completed_at, id
      ON CONFLICT(repo, pr_number, head_sha) DO NOTHING
    `);
  } catch (err) {
    log.warn(`backfillPRReviews failed: ${err}`);
  }
}

export async function getLastUsedByProvider(): Promise<Record<string, string | null>> {
  const rows = await getDb().all(`
      SELECT provider_used, MAX(completed_at) as last_used
      FROM tasks
      WHERE provider_used IS NOT NULL AND completed_at IS NOT NULL
      GROUP BY provider_used
    `) as Array<{ provider_used: string; last_used: string }>;
  const result: Record<string, string | null> = { claude: null, codex: null, opencode: null, pi: null };
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
async function lookupTaskSubject(taskId: number): Promise<{ repo: string; item_number: IssueRef; job_name: string } | null> {
  try {
    const row = await getDb().get(`SELECT repo, item_number, job_name FROM tasks WHERE id = ?`, [taskId]) as { repo: string; item_number: IssueRef; job_name: string } | undefined;
    if (!row || typeof row.repo !== "string" || !row.repo) return null;
    return normalizeItemNumbers([row])[0]!;
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
  itemNumber: IssueRef,
  triggerLabel: string | null,
  fn: (taskId: number) => Promise<T>,
): Promise<T> {
  const taskId = await recordTaskStart(jobName, repo, itemNumber, triggerLabel);
  try {
    return await fn(taskId);
  } catch (err) {
    // A refused or failed recording must not replace the agent's own error.
    try {
      await recordTaskFailed(taskId, String(err), buildFailureOutcome(err));
    } catch (recordErr) {
      logCore.warn(`[db] recordTaskFailed(${taskId}) failed: ${recordErr} (original error: ${err})`);
    }
    throw err;
  }
}

/** Running tasks no live process owns — except those of a pod-backed running row, whose agent pod is still running them. */
export async function getOrphanedTasks(): Promise<Task[]> {
  return normalizeItemNumbers(await getDb().all(`
      SELECT * FROM tasks
      WHERE status = 'running'
        AND (run_id IS NULL OR run_id NOT IN (
          SELECT run_id FROM work_queue
          WHERE status = 'running' AND agent_pod IS NOT NULL AND run_id IS NOT NULL
        ))
    `) as Task[]);
}

export async function getRunningTasks(): Promise<Task[]> {
  return normalizeItemNumbers(await getDb().all(`SELECT * FROM tasks WHERE status = 'running' ORDER BY started_at ASC`) as Task[]);
}

/** Running tasks as the `claws_status` MCP tool reports them — same columns as `mcp-server.ts`. */
export async function getRunningTaskSummaries(): Promise<Array<Pick<Task, "job_name" | "repo" | "item_number" | "started_at">>> {
  return normalizeItemNumbers(await getDb().all(
    `SELECT job_name, repo, item_number, started_at FROM tasks WHERE status = 'running' ORDER BY started_at ASC`,
  ) as Array<Pick<Task, "job_name" | "repo" | "item_number" | "started_at">>);
}

/** Whether a `jobName` task for `(repo, itemNumber)` is running right now. */
export async function hasRunningTask(jobName: string, repo: string, itemNumber: IssueRef): Promise<boolean> {
  const row = await getDb().get(
    `SELECT 1 AS n FROM tasks WHERE job_name = ? AND repo = ? AND item_number = ? AND status = 'running' LIMIT 1`,
    [jobName, repo, refParam(itemNumber)],
  );
  return !!row;
}

/**
 * The implementer attempt for `(repo, issueNumber)` whose agent pod was lost
 * with its node: the newest `issue-worker` task, but only when the launcher
 * failed it as `external-kill` while it worked on a `claws/issue-<ref>-`
 * branch. The re-run resumes on that branch so it never opens a second PR.
 * Null when the newest implementer task ended any other way — a later run
 * already settled the item — or worked on another issue's PR (target-PR mode).
 */
export async function findLostImplementerAttempt(repo: string, issueNumber: IssueRef): Promise<Task | null> {
  const row = await getDb().get(`
      SELECT *
      FROM tasks
      WHERE job_name = 'issue-worker' AND repo = ? AND item_number = ?
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `, [repo, refParam(issueNumber)]) as Task | undefined;
  if (!row || row.status !== "failed" || !row.outcome || !row.branch_name) return null;
  let category: unknown;
  try {
    category = (JSON.parse(row.outcome) as { failureCategory?: unknown }).failureCategory;
  } catch {
    return null;
  }
  if (category !== "external-kill") return null;
  if (!row.branch_name.startsWith(`claws/issue-${refParam(issueNumber)}-`)) return null;
  return normalizeItemNumbers([row])[0]!;
}

/** Last 20 tasks for a repo (optionally one item) as the `claws_task_history` MCP tool reports them. */
export async function getMcpTaskHistory(repo: string, itemNumber?: IssueRef): Promise<unknown[]> {
  if (itemNumber !== undefined) {
    return normalizeItemNumbers(await getDb().all(`
      SELECT t.job_name, t.item_number, t.status, t.error, t.outcome, t.started_at, t.completed_at,
             jr.job_name AS run_job
      FROM tasks t
      LEFT JOIN job_runs jr ON t.run_id = jr.run_id
      WHERE t.repo = ? AND t.item_number = ?
      ORDER BY t.started_at DESC LIMIT 20
    `, [repo, refParam(itemNumber)]) as object[]);
  }
  return normalizeItemNumbers(await getDb().all(`
    SELECT t.job_name, t.item_number, t.status, t.error, t.outcome, t.started_at, t.completed_at,
           jr.job_name AS run_job
    FROM tasks t
    LEFT JOIN job_runs jr ON t.run_id = jr.run_id
    WHERE t.repo = ?
    ORDER BY t.started_at DESC LIMIT 20
  `, [repo]) as object[]);
}

export interface McpRecentJobRun {
  diagnostics: Array<Pick<McpRecentJobLog, "id" | "diagnostic_reason" | "diagnostic_context" | "logged_at">>;
  diagnostics_truncated: boolean;
  diagnostic_reason: ReturnType<typeof diagnosticQueries.diagnosticReason>;
  run_id: string;
  job_name: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  latest_error: string | null;
  latest_log_excerpt: string | null;
}

export async function getMcpRecentJobRuns(limit = 20, jobFilter?: string): Promise<McpRecentJobRun[]> {
  await flushJobLogs();
  return diagnosticQueries.getMcpRecentJobRuns(getDb(), limit, jobFilter);
}

export interface McpRecentJobLog {
  diagnostic_context: diagnosticQueries.DiagnosticContext;
  diagnostic_reason: ReturnType<typeof diagnosticQueries.diagnosticReason>;
  id: number;
  run_id: string;
  job_name: string;
  level: string;
  message: string;
  logged_at: string;
}

export async function getMcpRecentJobLogs(opts: { runId?: string; jobName?: string; limit?: number } = {}): Promise<McpRecentJobLog[]> {
  await flushJobLogs();
  return diagnosticQueries.getMcpRecentJobLogs(getDb(), opts);
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
export async function markUntrustedActorNotified(repo: string, issueNumber: IssueRef): Promise<boolean> {
  const result = await getDb().run(`INSERT OR IGNORE INTO notified_untrusted_actors (repo, issue_number) VALUES (?, ?)`, [repo, refParam(issueNumber)]);
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
//
// A queued row is a candidate, not a decision: workers claim by `priority`,
// then pipeline stage (`stageRankSql`, merge-nearest first), then age, and
// re-validate the winner against the forge before an agent spawns.

export interface WorkQueueRow {
  id: number;
  kind: string;
  repo: string;
  item_number: IssueRef;
  args_json: string;
  /** 0/1 Priority-label flag. Refreshed by `enqueueWork` each time a
   *  dispatcher re-discovers a still-queued item, and by the worker's
   *  pre-spawn re-validation, so it tracks the live label. */
  priority: number;
  status: string;
  pid: number | null;
  attempts: number;
  error_message: string | null;
  enqueued_at: string;
  started_at: string | null;
  completed_at: string | null;
  run_id: string | null;
  /** Agent pod running this row (`claws-agent-<id>`), set once the pod has been created; NULL for in-process runs. */
  agent_pod: string | null;
  /** SHA-256 (hex) of the agent pod's claws-state bearer token; NULL for in-process runs. */
  agent_mcp_token_sha256: string | null;
}

export interface EnqueueResult {
  id: number;
  alreadyQueued: boolean;
  /** True when an already-queued row's `priority` was changed to the caller's flag. */
  priorityChanged?: boolean;
}

export async function enqueueWork(
  kind: string,
  repo: string,
  itemNumber: IssueRef,
  opts: { priority?: boolean; args?: Record<string, unknown> } = {},
): Promise<EnqueueResult | null> {
  const priority = opts.priority ? 1 : 0;
  const argsJson = JSON.stringify(opts.args ?? {});
  const result = await getDb().insert(`
      INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, enqueued_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?)
      ON CONFLICT(kind, repo, item_number) WHERE status IN ('queued', 'running') DO NOTHING
    `, [kind, repo, refParam(itemNumber), argsJson, priority, nowSql()]);
  if (result.changes === 1) {
    return { id: result.id, alreadyQueued: false };
  }
  // No insert — the row already exists in queued/running state. Refresh a
  // queued row's priority to the caller's current flag so a Priority label
  // added after enqueue changes the claim order; running rows are untouched.
  // A repo-scoped row (item 0, e.g. auto-merger:sweep) is shared by every PR
  // in the repo, so it may only be raised here, never lowered — otherwise a
  // later non-Priority caller would bump a Priority PR's pending sweep behind
  // other Priority rows.
  const refreshed = itemNumber === 0
    ? await getDb().run(`UPDATE work_queue SET priority = ? WHERE kind = ? AND repo = ? AND item_number = ? AND status = 'queued' AND priority < ?`, [priority, kind, repo, refParam(itemNumber), priority])
    : await getDb().run(`UPDATE work_queue SET priority = ? WHERE kind = ? AND repo = ? AND item_number = ? AND status = 'queued' AND priority <> ?`, [priority, kind, repo, refParam(itemNumber), priority]);
  const existing = await getDb().get(`SELECT id FROM work_queue WHERE kind = ? AND repo = ? AND item_number = ? AND status IN ('queued', 'running') LIMIT 1`, [kind, repo, refParam(itemNumber)]) as { id: number } | undefined;
  return existing ? { id: existing.id, alreadyQueued: true, priorityChanged: refreshed.changes > 0 } : null;
}

export async function claimNextWork(
  runId: string | null,
  opts?: { priorityOnly?: boolean; planningOnly?: boolean; kinds?: readonly string[] },
): Promise<WorkQueueRow | null> {
  // `kinds` restricts the claim (an off-node-only fiber takes only kinds that
  // may leave the session node); an empty list claims nothing.
  if (opts?.kinds && opts.kinds.length === 0) return null;
  const d = getDb();
  const kindParams = opts?.kinds ? [...opts.kinds] : [];
  // The express worker fiber claims only priority rows (Priority or an
  // incident label), so an alert never waits for a busy regular worker. The
  // planning-lane fiber claims only planning and requirements kinds, so a
  // plan waits only behind other planning work.
  const priorityFilter = (opts?.priorityOnly ? " AND priority = 1" : "") +
    (opts?.planningOnly ? ` AND ${planningKindsSql()}` : "") +
    (kindParams.length > 0 ? ` AND kind IN (${kindParams.map(() => "?").join(", ")})` : "");
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
      WHERE id = (SELECT id FROM work_queue WHERE status = 'queued'${priorityFilter}
                  ORDER BY priority DESC, ${stageRankSql()} ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *
    `, [process.pid, nowSql(), runId, ...kindParams]);
    return rows[0] ? normalizeItemNumbers(rows)[0]! : null;
  }
  return await d.transaction(async (tx) => {
    const row = await tx.get<WorkQueueRow>(`
      SELECT * FROM work_queue
      WHERE status = 'queued'${priorityFilter}
      ORDER BY priority DESC, ${stageRankSql()} ASC, id ASC
      LIMIT 1
    `, kindParams);
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
    const claimed = await tx.get<WorkQueueRow>(`SELECT * FROM work_queue WHERE id = ?`, [row.id]);
    return claimed ? normalizeItemNumbers([claimed])[0]! : null;
  });
}

export async function getWorkRow(id: number): Promise<WorkQueueRow | undefined> {
  const row = await getDb().get<WorkQueueRow>(`SELECT * FROM work_queue WHERE id = ?`, [id]);
  return row ? normalizeItemNumbers([row])[0] : undefined;
}

/**
 * Record the SHA-256 of the MCP token in a claimed row's agent pod Secret.
 * Written before the Secret exists, so the pod's token is accepted from its
 * first request.
 */
export async function setWorkAgentMcpToken(id: number, mcpTokenSha256: string): Promise<void> {
  await getDb().run(`UPDATE work_queue SET agent_mcp_token_sha256 = ? WHERE id = ?`, [mcpTokenSha256, id]);
}

/**
 * Record the agent pod a claimed row runs in. Written only once the Pod was
 * created, so every pod-backed row had a pod: a boot that crashed before that
 * leaves `agent_pod` NULL and recoverWorkOnStartup() re-queues the row.
 */
export async function setWorkAgentPod(id: number, podName: string): Promise<void> {
  await getDb().run(`UPDATE work_queue SET agent_pod = ? WHERE id = ?`, [podName, id]);
}

/**
 * Whether `mcpTokenSha256` is the MCP token hash of a running pod-backed row.
 * The service's per-boot INTERNAL_MCP_TOKEN cannot authenticate a pod that
 * outlives the boot, so the API accepts these too, until the row ends.
 */
export async function isRunningAgentPodMcpToken(mcpTokenSha256: string): Promise<boolean> {
  const row = await getDb().get<{ id: number }>(
    `SELECT id FROM work_queue WHERE status = 'running' AND agent_mcp_token_sha256 = ?`,
    [mcpTokenSha256],
  );
  return row !== undefined;
}

/** Running rows owned by an agent pod; the launcher adopts them at boot. */
export async function listPodBackedRunningWork(): Promise<WorkQueueRow[]> {
  return normalizeItemNumbers(await getDb().all(
    `SELECT * FROM work_queue WHERE status = 'running' AND agent_pod IS NOT NULL ORDER BY id ASC`,
  ) as WorkQueueRow[]);
}

/**
 * Put a row claimed under `runId` back in the queue before anything ran it;
 * false when it is no longer running under that run. Clears `agent_pod`; a
 * `note` is stored as the row's `error_message` (otherwise it is left as is).
 */
export async function releaseClaimedWork(id: number, runId: string, note?: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE work_queue SET status = 'queued', pid = NULL, started_at = NULL, run_id = NULL, agent_mcp_token_sha256 = NULL, agent_pod = NULL${note === undefined ? "" : ", error_message = ?"}
     WHERE id = ? AND status = 'running' AND run_id = ?`,
    note === undefined ? [id, runId] : [note, id, runId],
  );
  return Number(result.changes) > 0;
}

/**
 * Put a 'running' row this process just claimed straight back onto the queue,
 * without charging a failed attempt. Unlike `releaseClaimedWork`, this does
 * not match on `run_id`: the in-process (non-pod) backend never records one
 * on the rows it claims, but a fiber that just claimed a row is its only
 * owner while it stays 'running', so matching on id and status is enough.
 */
export async function releaseClaimedWorkById(id: number): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE work_queue SET status = 'queued', pid = NULL, started_at = NULL, run_id = NULL, agent_mcp_token_sha256 = NULL
     WHERE id = ? AND status = 'running'`,
    [id],
  );
  return Number(result.changes) > 0;
}

/** `note` is kept as the row's queue note (e.g. a re-validation failure the run proceeded past). */
export async function markWorkSucceeded(id: number, note?: string): Promise<void> {
  await getDb().run(`UPDATE work_queue SET status = 'completed', completed_at = ?, error_message = ? WHERE id = ?`, [nowSql(), note?.slice(0, 4000) ?? null, id]);
}

export async function markWorkFailed(id: number, errorMessage: string): Promise<void> {
  await getDb().run(`UPDATE work_queue SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ?`, [nowSql(), errorMessage.slice(0, 4000), id]);
}

/** `markWorkSucceeded` only while the row is still `running` under `runId`; false when it had already ended. */
export async function markWorkSucceededIfRunning(id: number, runId: string, note?: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE work_queue SET status = 'completed', completed_at = ?, error_message = ? WHERE id = ? AND status = 'running' AND run_id = ?`,
    [nowSql(), note?.slice(0, 4000) ?? null, id, runId],
  );
  return Number(result.changes) > 0;
}

/** `markWorkFailed` only while the row is still `running` under `runId`; false when it had already ended. */
export async function markWorkFailedIfRunning(id: number, runId: string, errorMessage: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE work_queue SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ? AND status = 'running' AND run_id = ?`,
    [nowSql(), errorMessage.slice(0, 4000), id, runId],
  );
  return Number(result.changes) > 0;
}

/** Record the pre-spawn re-validation's result on the row's claim
 *  (display only — the row is already running). */
export async function setWorkPriority(id: number, priority: boolean): Promise<void> {
  await getDb().run(`UPDATE work_queue SET priority = ? WHERE id = ?`, [priority ? 1 : 0, id]);
}

/** `setWorkPriority` only while the row is still `running` under `runId`; false when it had already ended. */
export async function setWorkPriorityIfRunning(id: number, runId: string, priority: boolean): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE work_queue SET priority = ? WHERE id = ? AND status = 'running' AND run_id = ?`,
    [priority ? 1 : 0, id, runId],
  );
  return Number(result.changes) > 0;
}

/** Terminal state for a claimed row the worker dropped without spawning an
 *  agent because the item is no longer actionable (merged, closed, parked).
 *  `completed`, not `cancelled` (operator cancels) or `failed` (errors), with
 *  the reason as `skipped: <reason>`. Frees `idx_work_queue_active`. */
export async function markWorkSkipped(id: number, reason: string): Promise<void> {
  await getDb().run(`UPDATE work_queue SET status = 'completed', completed_at = ?, error_message = ? WHERE id = ?`, [nowSql(), `skipped: ${reason}`.slice(0, 4000), id]);
}

/**
 * Skip every still-`queued` row for one item whose kind starts with
 * `kindPrefix` (e.g. `issue-refiner:`), returning how many it skipped. A
 * `running` row is left alone: it has already started and finishes on its own.
 * Demoting an issue back to Ideas uses it to drop a queued planner run.
 */
export async function skipQueuedWorkForItem(kindPrefix: string, repo: string, itemNumber: IssueRef, reason: string): Promise<number> {
  const result = await getDb().run(
    `UPDATE work_queue SET status = 'completed', completed_at = ?, error_message = ?
      WHERE repo = ? AND item_number = ? AND status = 'queued' AND substr(kind, 1, ?) = ?`,
    [nowSql(), `skipped: ${reason}`.slice(0, 4000), repo, refParam(itemNumber), kindPrefix.length, kindPrefix],
  );
  return Number(result.changes);
}

/** `markWorkSkipped` only while the row is still `running` under `runId`; false when it had already ended. */
export async function markWorkSkippedIfRunning(id: number, runId: string, reason: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE work_queue SET status = 'completed', completed_at = ?, error_message = ? WHERE id = ? AND status = 'running' AND run_id = ?`,
    [nowSql(), `skipped: ${reason}`.slice(0, 4000), id, runId],
  );
  return Number(result.changes) > 0;
}

/** Terminal 'cancelled' state for a work row whose run was cancelled by an
 *  operator (POST /cancel or POST /logs/:runId/cancel) while the service kept
 *  running. Must not be left 'running': recoverWorkOnStartup() only resets
 *  'running' rows at the next restart, and reapStaleRunningWork() only reaps
 *  them after STALE_RUNNING_WORK_MS, so a row left running by a no-restart
 *  cancellation would otherwise block re-enqueue via idx_work_queue_active
 *  for up to that long (#2685, #3144). */
export async function markWorkCancelled(id: number, reason: string): Promise<void> {
  await getDb().run(`UPDATE work_queue SET status = 'cancelled', completed_at = ?, error_message = ? WHERE id = ?`, [nowSql(), reason.slice(0, 4000), id]);
}

/** `markWorkCancelled` only while the row is still `running` under `runId`; false when it had already ended. */
export async function markWorkCancelledIfRunning(id: number, runId: string, reason: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE work_queue SET status = 'cancelled', completed_at = ?, error_message = ? WHERE id = ? AND status = 'running' AND run_id = ?`,
    [nowSql(), reason.slice(0, 4000), id, runId],
  );
  return Number(result.changes) > 0;
}

export async function listQueuedWork(limit = 200): Promise<WorkQueueRow[]> {
  return normalizeItemNumbers(await getDb().all(`
      SELECT * FROM work_queue
      WHERE status IN ('queued', 'running')
      ORDER BY status DESC, priority DESC, ${stageRankSql()} ASC, id ASC
      LIMIT ?
    `, [limit]) as WorkQueueRow[]);
}

export type McpWorkQueueRow = Pick<WorkQueueRow,
  "id" | "kind" | "repo" | "item_number" | "priority" | "status" | "pid" |
  "attempts" | "error_message" | "enqueued_at" | "started_at" | "completed_at" | "run_id"
> & {
  /** Pipeline stage rank from `work-order.ts`; lower is nearer to merge. */
  stage: number;
  /** Worker lane that claims the row: `planning`, `express` (priority) or `regular`. */
  lane: WorkLane;
};

export async function getMcpWorkQueue(limit = 100, statuses: readonly string[] = ["queued", "running"]): Promise<McpWorkQueueRow[]> {
  return await diagnosticQueries.getMcpWorkQueue(getDb(), limit, statuses);
}

export interface McpRepoProcessingState {
  job_name: string;
  repo: string;
  local_date: string;
  processed_at: string;
}

export async function getMcpRepoProcessingState(opts: { jobName?: string; repo?: string; limit?: number } = {}): Promise<McpRepoProcessingState[]> {
  return diagnosticQueries.getMcpRepoProcessingState(getDb(), opts);
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

/**
 * #3144: inside the production container tini is PID 1 and the Node process is
 * always PID 7, so `pid` is not a liveness signal in this pod's PID namespace —
 * a stale row's `pid` is indistinguishable from the live process's own. A reset-all
 * is safe here because there is exactly one live writer per database.
 */
export async function recoverWorkOnStartup(): Promise<{ resetRunning: number }> {
  // Pod-backed rows outlive the service; the agent pod launcher adopts them.
  const result = await getDb().run(`
      UPDATE work_queue
      SET status = 'queued', pid = NULL, started_at = NULL, agent_mcp_token_sha256 = NULL
      WHERE status = 'running' AND agent_pod IS NULL
    `);
  return { resetRunning: Number(result.changes) };
}

/**
 * Staleness floor for reapStaleRunningWork()'s no-restart sweep — it matches
 * CLAUDE_TIMEOUT_MS / CLAUDE_LIVENESS_TIMEOUT_MS in src/config.ts, since no work
 * row should outlive its own agent's ceiling.
 */
export const STALE_RUNNING_WORK_MS = 6 * 60 * 60 * 1000;

/**
 * Between-restart self-heal for #3144: reset 'running' rows old enough that no
 * worker could still legitimately be executing them and that aren't in the
 * caller's live in-flight set. Unlike recoverWorkOnStartup(), this runs while
 * the service stays up, so it must not touch a row a fiber is actually running.
 * Pod-backed rows are skipped: the agent pod launcher enforces their ceiling.
 */
export async function reapStaleRunningWork(activeIds: readonly number[], maxAgeMs = STALE_RUNNING_WORK_MS): Promise<number> {
  const cutoff = nowSqlOffsetMs(-maxAgeMs);
  if (activeIds.length === 0) {
    const result = await getDb().run(`
        UPDATE work_queue
        SET status = 'queued', pid = NULL, started_at = NULL, agent_mcp_token_sha256 = NULL
        WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?
          AND agent_pod IS NULL
      `, [cutoff]);
    return Number(result.changes);
  }
  const placeholders = activeIds.map(() => "?").join(",");
  const result = await getDb().run(`
      UPDATE work_queue
      SET status = 'queued', pid = NULL, started_at = NULL, agent_mcp_token_sha256 = NULL
      WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?
        AND agent_pod IS NULL
        AND id NOT IN (${placeholders})
    `, [cutoff, ...activeIds]);
  return Number(result.changes);
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
    `, [repo, refParam(prNumber), ...kinds]);
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

export async function countRecentTimeouts(repo: string, itemNumber: IssueRef, windowMs: number = 2 * 60 * 60 * 1000): Promise<number> {
  // Format cutoff to match SQLite's datetime() format (YYYY-MM-DD HH:MM:SS)
  const cutoff = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const row = await getDb().get(`SELECT COUNT(*) AS cnt FROM tasks
       WHERE repo = ? AND item_number = ? AND status = 'failed'
       AND error LIKE '%timed out%'
       AND completed_at > ?`, [repo, refParam(itemNumber), cutoff]) as { cnt: number };
  return row.cnt;
}

/** Failed `work_queue` rows for this kind/repo/item within `windowMs` whose error starts with `errorPrefix`. */
export async function countRecentWorkFailures(kind: string, repo: string, itemNumber: IssueRef, errorPrefix: string, windowMs: number = 2 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const escaped = errorPrefix.replace(/[\\%_]/g, "\\$&");
  const row = await getDb().get(`SELECT COUNT(*) AS cnt FROM work_queue
       WHERE kind = ? AND repo = ? AND item_number = ? AND status = 'failed'
       AND error_message LIKE ? ESCAPE '\\'
       AND completed_at > ?`, [kind, repo, refParam(itemNumber), `${escaped}%`, cutoff]) as { cnt: number };
  return Number(row.cnt);
}

/** Number of task rows this job has started for `repo` within `windowMs`. Used by
 *  improvement-identifier to throttle its expensive whole-repo analysis. */
export async function countRecentTasksForJobRepo(jobName: string, repo: string, windowMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const row = await getDb().get(`SELECT COUNT(*) AS n FROM tasks WHERE job_name = ? AND repo = ? AND started_at >= ?`, [jobName, repo, cutoff]) as { n: number };
  return row.n;
}

export async function countRecentMemoryLimits(repo: string, itemNumber: IssueRef, limitBytes?: number, windowMs: number = 2 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  if (limitBytes === undefined) {
    const row = await getDb().get(`SELECT COUNT(*) AS cnt FROM tasks
       WHERE repo = ? AND item_number = ? AND status = 'failed'
       AND error LIKE '%exceeded memory limit%'
       AND completed_at > ?`, [repo, refParam(itemNumber), cutoff]) as { cnt: number };
    return row.cnt;
  }
  // Rows written since #3168 carry the breached cap structurally in the outcome
  // JSON, so the same-cap count is plain SQL and survives any rewording of
  // AgentMemoryLimitError's message.
  const structural = await getDb().get(`SELECT COUNT(*) AS cnt FROM tasks
       WHERE repo = ? AND item_number = ? AND status = 'failed'
       AND CAST(json_extract(outcome, '$.memoryLimitBytes') AS INTEGER) = ?
       AND completed_at > ?`, [repo, refParam(itemNumber), limitBytes, cutoff]) as { cnt: number };
  // Fallback for rows written before that field existed: parse the cap out of
  // the stored message. Scoped to rows with no structural value so the two
  // branches can never double-count the same task.
  const legacyRows = await getDb().all(`SELECT error FROM tasks
       WHERE repo = ? AND item_number = ? AND status = 'failed'
       AND json_extract(outcome, '$.memoryLimitBytes') IS NULL
       AND error LIKE '%exceeded memory limit%'
       AND completed_at > ?`, [repo, refParam(itemNumber), cutoff]) as Array<{ error: string | null }>;
  const targetMiB = Math.round(limitBytes / 1048576);
  const legacy = legacyRows.filter((row) => {
    const match = /\((?:\d+)MiB > (\d+)MiB\)/.exec(row.error ?? "");
    return match ? Number(match[1]) === targetMiB : false;
  }).length;
  return structural.cnt + legacy;
}

/**
 * How many `issue-worker` runs for `repo#itemNumber` completed with no
 * commits and no PR within the last `windowMs`, since the last run that
 * opened a PR. With `since` (ISO 8601) only runs completed after it count —
 * the implementer's circuit breaker passes the time it last tripped, so a
 * human's retry after the trip starts the count again.
 */
export async function countRecentNoCommitCompletions(
  repo: string,
  itemNumber: IssueRef,
  windowMs: number = 6 * 60 * 60 * 1000,
  since?: string | null,
): Promise<number> {
  const windowStart = new Date(Date.now() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const sinceMs = since ? Date.parse(since) : NaN;
  const sinceSql = Number.isNaN(sinceMs) ? null : new Date(sinceMs).toISOString().slice(0, 19).replace("T", " ");
  const cutoff = sinceSql !== null && sinceSql > windowStart ? sinceSql : windowStart;
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
         '1970-01-01')`, [repo, refParam(itemNumber), cutoff, repo, refParam(itemNumber)]) as { cnt: number };
  return row.cnt;
}

export async function hasPreviousCiFixerTasks(repo: string, prNumber: number): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 FROM tasks WHERE job_name = 'ci-fixer' AND repo = ? AND item_number = ? AND status = 'completed' LIMIT 1`, [repo, refParam(prNumber)]);
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

/** A PR recovery action an interactive session took (`session_pr_actions.action`). */
export type SessionPrAction = "rerun" | "unmark-problematic" | "rediagnose" | "feedback" | "merge" | "approve-merge";

/** Record that session `sessionId` took `action` on `repo#prNumber`. */
export async function recordSessionPrAction(entry: {
  repo: string;
  prNumber: number;
  sessionId: string;
  action: SessionPrAction;
  detail?: string | null;
  commentId?: string | null;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO session_pr_actions (repo, pr_number, session_id, action, detail, comment_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entry.repo, entry.prNumber, entry.sessionId, entry.action, entry.detail ?? null, entry.commentId ?? null, new Date().toISOString()],
  );
}

/**
 * Ids of the comments sessions posted on `repo#prNumber` through
 * `claws_comment_on_pr` — the allowlist of bot-authored comments the review
 * readers take as human feedback rather than Claws output.
 */
export async function getSessionFeedbackCommentIds(repo: string, prNumber: number): Promise<Set<string>> {
  const rows = await getDb().all(
    `SELECT comment_id FROM session_pr_actions WHERE repo = ? AND pr_number = ? AND action = 'feedback' AND comment_id IS NOT NULL`,
    [repo, prNumber],
  ) as Array<{ comment_id: string }>;
  return new Set(rows.map((r) => String(r.comment_id)));
}

/**
 * Count CI fixer attempts for a PR within a time window.
 * Returns counts for total attempts, failed attempts, and successful attempts.
 * `preWorkFailed` counts attempts that failed before the agent ran (see
 * `PRE_WORK_FAILURE_CATEGORIES`) — callers subtract these from `failed` so a
 * provider outage does not trip the CI-fix circuit breaker. `rerunOnly` counts
 * attempts that read no CI log and only re-ran the workflow (or found it already
 * running) — callers exclude them from the fix budget and bound them separately,
 * since they changed nothing in the PR. `pushed` counts completed runs that
 * pushed a commit (`prAction: "updated"`) and `gaveUp` counts runs whose agent
 * gave up with a stated reason (`giveUpReason`); callers count only these two
 * towards the fix-attempt cap.
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
): Promise<{ total: number; failed: number; successful: number; preWorkFailed: number; rerunOnly: number; pushed: number; gaveUp: number }> {
  const windowCutoff = new Date(Date.now() - windowMs).toISOString();
  const cutoff = sinceIso && sinceIso > windowCutoff ? sinceIso : windowCutoff;
  const result = await getDb().get(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as successful,
        COALESCE(SUM(CASE WHEN status = 'failed'
          AND json_extract(outcome, '$.failureCategory') IN (${PRE_WORK_FAILURE_CATEGORIES_SQL})
          THEN 1 ELSE 0 END), 0) as "preWorkFailed",
        COALESCE(SUM(CASE WHEN status = 'failed'
          AND json_extract(outcome, '$.failureCategory') = 'rerun-only'
          THEN 1 ELSE 0 END), 0) as "rerunOnly",
        COALESCE(SUM(CASE WHEN status = 'completed'
          AND json_extract(outcome, '$.prAction') = 'updated'
          THEN 1 ELSE 0 END), 0) as pushed,
        COALESCE(SUM(CASE WHEN json_extract(outcome, '$.giveUpReason') IS NOT NULL
          THEN 1 ELSE 0 END), 0) as "gaveUp"
      FROM tasks
      -- Conflict resolution has its own budget (countConflictResolutionAttempts) so a
      -- conflict loop cannot exhaust the CI-fix budget or vice-versa (#2389).
      WHERE (job_name = 'ci-fixer' OR (job_name LIKE 'ci-fixer:%' AND job_name != 'ci-fixer:merge-conflict'))
        AND repo = ?
        AND item_number = ?
        AND datetime(started_at) >= datetime(?)
    `, [repo, refParam(prNumber), cutoff]) as { total: number; failed: number; successful: number; preWorkFailed: number; rerunOnly: number; pushed: number; gaveUp: number };
  return result;
}

/**
 * CI-fixer runs on one PR head that pushed nothing: `noop` counts completed runs
 * that also gave no reason (not fix attempts, so `countCIFixerAttempts` never caps
 * them), `gaveUp` counts runs whose agent gave up with a stated reason. Both match
 * on the outcome's `headSha`, so a new commit starts from zero. `identifyPRWork`
 * uses them to stop re-dispatching against a head nothing has changed on. Same
 * window and budget-floor rules as `countCIFixerAttempts`.
 */
export async function countCIFixerIdleRunsOnHead(
  repo: string,
  prNumber: number,
  headSha: string,
  windowMs: number = 24 * 60 * 60 * 1000,
  sinceIso?: string | null,
): Promise<{ noop: number; gaveUp: number }> {
  const windowCutoff = new Date(Date.now() - windowMs).toISOString();
  const cutoff = sinceIso && sinceIso > windowCutoff ? sinceIso : windowCutoff;
  const result = await getDb().get(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'completed'
          AND json_extract(outcome, '$.prAction') IS NULL
          AND json_extract(outcome, '$.giveUpReason') IS NULL
          THEN 1 ELSE 0 END), 0) as noop,
        COALESCE(SUM(CASE WHEN json_extract(outcome, '$.giveUpReason') IS NOT NULL
          THEN 1 ELSE 0 END), 0) as "gaveUp"
      FROM tasks
      WHERE (job_name = 'ci-fixer' OR (job_name LIKE 'ci-fixer:%' AND job_name != 'ci-fixer:merge-conflict'))
        AND repo = ?
        AND item_number = ?
        AND json_extract(outcome, '$.headSha') = ?
        AND datetime(started_at) >= datetime(?)
    `, [repo, refParam(prNumber), headSha, cutoff]) as { noop: number; gaveUp: number };
  return result;
}

/**
 * Whether a CI-fixer run gave up on `headSha` of the PR with a stated reason
 * (`giveUpReason`). No time window, unlike {@link countCIFixerIdleRunsOnHead}:
 * the PR-stall park reads it to keep an issue in Blocked while a held PR's CI
 * cannot pass, which outlasts the CI fixer's own window and a restart.
 */
export async function hasCiFixerGiveUpOnHead(repo: string, prNumber: number, headSha: string): Promise<boolean> {
  const row = await getDb().get(`
      SELECT 1 AS hit
      FROM tasks
      WHERE (job_name = 'ci-fixer' OR (job_name LIKE 'ci-fixer:%' AND job_name != 'ci-fixer:merge-conflict'))
        AND repo = ?
        AND item_number = ?
        AND json_extract(outcome, '$.headSha') = ?
        AND json_extract(outcome, '$.giveUpReason') IS NOT NULL
      LIMIT 1
    `, [repo, refParam(prNumber), headSha]);
  return !!row;
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
    `, [backoffCutoff, repo, refParam(prNumber), cutoff]) as { total: number; unproductive: number; preWorkFailed: number; recentPreWorkFailed: number };
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
    `, [repo, refParam(prNumber), limit]) as Array<{ error: string; timestamp: string }>;
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
  const result = await getDb().run(`
      DELETE FROM tasks
      WHERE status IN ('completed', 'failed')
        AND COALESCE(completed_at, started_at) < ?
        AND (run_id IS NULL OR run_id NOT IN (SELECT run_id FROM job_runs))
    `, [nowSqlOffsetMs(-retentionDays * DAY_MS)]);
  return Number(result.changes);
}

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
  const result = await getDb().run(`DELETE FROM queue_snapshots WHERE recorded_at < ?`, [nowSqlOffsetMs(-retentionHours * 60 * 60 * 1000)]);
  return result.changes;
}

/**
 * Deletes `claws_events` rows older than `retentionHours`; nobody waits that
 * long. Also prunes stale inactive `claws_gate_state` rows (`pruneGateState`).
 */
export async function pruneClawsEvents(retentionHours = 24): Promise<number> {
  await flushGitHubEvents();
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString();
  const result = await getDb().run(`DELETE FROM claws_events WHERE at < ?`, [cutoff]);
  await pruneGateState().catch((err) => log.warn(`pruneGateState failed: ${err}`));
  return result.changes;
}

/** Deletes controller commands completed more than `retentionDays` ago. */
export async function pruneControllerCommands(retentionDays = 7): Promise<number> {
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
  /** `account` is the Claude account that served the rows, "" when none was recorded. */
  providerStats: Array<UsageStatRow & { provider: string; account: string; model: string }>;
  sessionStats: SessionUsageStat[];
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
  account?: string;  // Claude account id recorded in account_used
}

export type SessionUsageWarningLevel = "none" | "warn" | "critical";

export interface SessionUsageStat {
  id: string;
  repo: string | null;
  cwd: string;
  provider: string;
  model: string;
  alive: boolean;
  totalTokens: number;
  costUsd: number | null;
  lastContextTokens: number;
  createdAt: number;
  endedAt: number | null;
  warningLevel: SessionUsageWarningLevel;
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

function usageWarningLevel(lastContextTokens: number): SessionUsageWarningLevel {
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

export async function getUsageStats(days: number, filters?: UsageFilters): Promise<UsageStats> {
  const d = getDb();
  const usage = usageItemsCte(days, filters);
  const repoRows = await d
    .all(`
      ${usage.cte}
      SELECT repo,
             ${USAGE_AGG_SQL}
      FROM usage_items
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
      ) te ON te.task_id = usage_items.task_id
      WHERE ${usage.where}
      GROUP BY repo
      ORDER BY total_cost_usd DESC
    `, [...usage.params]) as Array<UsageAggRow & { repo: string }>;

  const jobRows = await d
    .all(`
      ${usage.cte}
      SELECT
        job_prefix,
        ${USAGE_AGG_SQL}
      FROM usage_items
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
      ) te ON te.task_id = usage_items.task_id
      WHERE ${usage.where}
      GROUP BY job_prefix
      ORDER BY total_cost_usd DESC
    `, [...usage.params]) as Array<UsageAggRow & { job_prefix: string }>;

  const providerRows = await d
    .all(`
      ${usage.cte}
      SELECT provider AS provider_used,
             account AS account_used,
             model AS model_used,
             ${USAGE_AGG_SQL}
      FROM usage_items
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
      ) te ON te.task_id = usage_items.task_id
      WHERE ${usage.where}
      GROUP BY 1, 2, 3
      ORDER BY total_cost_usd DESC
    `, [...usage.params]) as Array<UsageAggRow & { provider_used: string; account_used: string; model_used: string }>;

  const sessionRows = await d.all(`
      ${usage.cte}
      SELECT session_id, repo, cwd, provider, model, tokens_used, cost_usd, last_context_tokens, session_created_at, session_ended_at
      FROM usage_items
      WHERE ${usage.where} AND item_type = 'session'
      ORDER BY CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END, cost_usd DESC, tokens_used DESC, last_context_tokens DESC
    `, [...usage.params]) as Array<{
      session_id: string;
      repo: string | null;
      cwd: string;
      provider: string;
      model: string;
      tokens_used: number | null;
      cost_usd: number | null;
      last_context_tokens: number | null;
      session_created_at: number;
      session_ended_at: number | null;
    }>;

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
      account: r.account_used,
      model: r.model_used,
      ...mapUsageAgg(r),
    })),
    sessionStats: sessionRows.map((r) => ({
      id: r.session_id,
      repo: r.repo === r.cwd ? null : r.repo,
      cwd: r.cwd,
      provider: r.provider,
      model: r.model,
      alive: r.session_ended_at == null,
      totalTokens: r.tokens_used ?? 0,
      costUsd: r.cost_usd,
      lastContextTokens: r.last_context_tokens ?? 0,
      createdAt: r.session_created_at,
      endedAt: r.session_ended_at,
      warningLevel: usageWarningLevel(r.last_context_tokens ?? 0),
    })),
  };
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
  /** Session backend that owns the row (#3026): `"k8s-pod"`. NULL or `"local-tmux"` marks a legacy row from the removed host tmux backend, kept as history only and never resumable. */
  backend: string | null;
  /** Self-reported agent state set via `claws_set_session_status` (#3083): `working` | `monitoring` | `waiting` | `done`. NULL until the agent reports. */
  agent_status: string | null;
  agent_status_updated_at: number | null;
  /** When the session's pod was last launched (`k8s-pod`, reconcile's grace clock): `created_at` at insert, then each resume that relaunches it. NULL on rows written before #3061. */
  launched_at: number | null;
  tokens_used: number | null;
  cost_usd: number | null;
  last_context_tokens: number | null;
  usage_updated_at: number | null;
  startup_state: string | null;
  startup_step: string | null;
  startup_detail: string | null;
  startup_started_at: number | null;
  startup_updated_at: number | null;
  startup_ready_at: number | null;
  startup_failed_at: number | null;
  startup_failure: string | null;
  /** Exit code of the session's process once it ended on its own (#3311); NULL while running, after resume, or when unknown. */
  exit_code: number | null;
  /** Tail of the session's final terminal output, VT sequences stripped (#3311); NULL when none was captured. */
  last_output: string | null;
  /** SHA-256 (`hashAgentMcpToken`) of a legacy `local-tmux` session's per-launch `/mcp/sessions/:id` bearer (history only); NULL for k8s-pod rows, `repo-zsh` shells and rows written before it existed. */
  mcp_token_sha256: string | null;
  /** Claws `VERSION` the session's agent was launched or relaunched under; `sessionUpgradedSince` compares it with the running one. NULL on rows written before it existed. */
  launched_version: string | null;
  /** Issue brief appended to the session prompt on every launch and resume, for a session another session started (`claws_start_session`); NULL otherwise. */
  brief: string | null;
  /** Id of the session whose `claws_start_session` call created this one, for the audit trail only. A plain string, never a live link: ending or deleting that session never touches this row. */
  spawned_by_session: string | null;
  /** Canonical `clw_…` id of the issue this session was started for, alongside `spawned_by_session`. */
  spawned_for_issue: string | null;
  /** `issue-page` when started by the issue page's Create Session button; NULL for board, PRs page and agent starts. */
  spawned_from: string | null;
  /** `owner/name#123` of the pull request the operator started this session for from the PRs page; NULL otherwise. */
  spawned_for_pr: string | null;
  /** Operator's own first message from a dashboard New Session form's Initial prompt field, handed to the agent CLI at launch; NULL when none was given. Kept after delivery and never shown. */
  initial_prompt: string | null;
  /** When the session's startup first reached `ready` with `initial_prompt` set (`markSessionInitialPromptSent`); while NULL, every relaunch carries the prompt again. */
  initial_prompt_sent_at: number | null;
  /** When this ended session's memory files were captured into `session_memory_captures`; NULL while live, pending, or given up. Reset by every reopen. */
  memories_captured_at?: number | null;
  /** Failed capture attempts since the session last ended; capture gives up at `MAX_MEMORY_CAPTURE_ATTEMPTS` (`session-memory-capture.ts`). Reset by every reopen. */
  memory_capture_attempts?: number | null;
  /** Claude account id the live pod was launched with, shared by the Claude login and pi's Anthropic credential; NULL when it has neither grant, and on rows written before it existed. */
  claude_account?: string | null;
}

export async function insertSession(
  row: Omit<PersistedSession, "ended_at" | "resume_repos" | "backend" | "agent_status" | "agent_status_updated_at" | "launched_at" | "tokens_used" | "cost_usd" | "last_context_tokens" | "usage_updated_at" | "startup_state" | "startup_step" | "startup_detail" | "startup_started_at" | "startup_updated_at" | "startup_ready_at" | "startup_failed_at" | "startup_failure" | "exit_code" | "last_output" | "mcp_token_sha256" | "launched_version" | "brief" | "spawned_by_session" | "spawned_for_issue" | "spawned_from" | "spawned_for_pr" | "initial_prompt" | "initial_prompt_sent_at" | "summary_manual"> & { backend?: string | null; mcp_token_sha256?: string | null; brief?: string | null; spawned_by_session?: string | null; spawned_for_issue?: string | null; spawned_from?: string | null; spawned_for_pr?: string | null; initial_prompt?: string | null; summary_manual?: number },
): Promise<void> {
  await getDb().run(`
    INSERT INTO sessions (id, tmux_name, mode, repo, cwd, worktree_path, extra_worktrees, capabilities, created_at, provider, model, backend, launched_at, startup_started_at, startup_updated_at, mcp_token_sha256, launched_version, brief, spawned_by_session, spawned_for_issue, spawned_from, spawned_for_pr, initial_prompt, summary, summary_updated_at, summary_manual, claude_account)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [row.id, row.tmux_name, row.mode, row.repo, row.cwd, row.worktree_path, row.extra_worktrees, row.capabilities, row.created_at, row.provider, row.model, row.backend ?? null, row.created_at, row.created_at, row.created_at, row.mcp_token_sha256 ?? null, VERSION, row.brief ?? null, row.spawned_by_session ?? null, row.spawned_for_issue ?? null, row.spawned_from ?? null, row.spawned_for_pr ?? null, row.initial_prompt ?? null, row.summary ?? null, row.summary_updated_at ?? null, row.summary_manual ?? 0, row.claude_account ?? null]);
}

/** Record the Claude account id a session's live pod was launched with (`PersistedSession.claude_account`); null for none. */
export async function setSessionClaudeAccount(id: string, accountId: string | null): Promise<void> {
  await getDb().run(`UPDATE sessions SET claude_account = ? WHERE id = ?`, [accountId, id]);
}

/** Record that a session's `initial_prompt` reached a ready agent. Only the first call writes, so the earliest timestamp wins; returns whether this call wrote it. */
export async function markSessionInitialPromptSent(id: string, at: number): Promise<boolean> {
  const result = await getDb().run(`UPDATE sessions SET initial_prompt_sent_at = ? WHERE id = ? AND initial_prompt_sent_at IS NULL`, [at, id]);
  return result.changes === 1;
}

/** Live (`ended_at IS NULL`) sessions that `claws_start_session` created from session `sessionId`: the fan-out cap's count. */
export async function countLiveSessionsSpawnedBy(sessionId: string): Promise<number> {
  const row = await getDb().get(`SELECT COUNT(*) AS n FROM sessions WHERE spawned_by_session = ? AND ended_at IS NULL`, [sessionId]) as { n: number | string } | undefined;
  return Number(row?.n ?? 0);
}

/** The board's "Go to session" source: issue id -> newest live (not ended) session started from a board card (`spawned_for_issue` set, `spawned_by_session` and `spawned_for_pr` NULL). */
export async function listLiveBoardStartedSessions(): Promise<Map<string, string>> {
  const rows = await getDb().all(`SELECT id, spawned_for_issue FROM sessions WHERE ended_at IS NULL AND spawned_by_session IS NULL AND spawned_for_pr IS NULL AND (spawned_from IS NULL OR spawned_from <> 'issue-page') AND spawned_for_issue IS NOT NULL ORDER BY created_at DESC`, []) as { id: string; spawned_for_issue: string }[];
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.spawned_for_issue)) out.set(r.spawned_for_issue, r.id);
  return out;
}

/** The PRs page's "Go to session" source: `owner/name#123` -> newest live (not ended) session started from a PR row (`spawned_for_pr` set, `spawned_by_session` NULL). */
export async function listLivePrStartedSessions(): Promise<Map<string, string>> {
  const rows = await getDb().all(`SELECT id, spawned_for_pr FROM sessions WHERE ended_at IS NULL AND spawned_by_session IS NULL AND spawned_for_pr IS NOT NULL ORDER BY created_at DESC`, []) as { id: string; spawned_for_pr: string }[];
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.spawned_for_pr)) out.set(r.spawned_for_pr, r.id);
  return out;
}

/** Replace a session's MCP bearer hash: each resume mints a new token (see `PersistedSession.mcp_token_sha256`). `clearEnded` also reopens the row so the new token is accepted before the agent spawns. */
export async function setSessionMcpTokenHash(id: string, sha256: string | null, clearEnded = false): Promise<void> {
  await getDb().run(`UPDATE sessions SET mcp_token_sha256 = ?${clearEnded ? `, ended_at = NULL, ${REOPEN_MEMORY_CAPTURE}` : ""} WHERE id = ?`, [sha256, id]);
}

export interface SessionStartupDbUpdate {
  state?: string | null;
  step?: string | null;
  detail?: string | null;
  startedAt?: number | null;
  updatedAt: number;
  readyAt?: number | null;
  failedAt?: number | null;
  failure?: string | null;
  clearFailure?: boolean;
  /**
   * Optimistic-concurrency guard for a writer that derived this update from a row it read
   * earlier and holds no lock on: the `startup_updated_at` it saw. The write is a no-op if
   * anything has written the row since, so a status derived from a stale pod read can never
   * land on top of — and erase the failure detail of — a newer authoritative write. Omit it
   * to write unconditionally, which is what a caller holding the session's lock does.
   */
  expectUpdatedAt?: number | null;
}

/** Whether the row was written; only ever `false` for an `expectUpdatedAt` that no longer matches. */
export async function updateSessionStartup(id: string, update: SessionStartupDbUpdate): Promise<boolean> {
  const sets = ["startup_updated_at = ?"];
  const values: unknown[] = [update.updatedAt];
  if ("state" in update) { sets.push("startup_state = ?"); values.push(update.state ?? null); }
  if ("step" in update) { sets.push("startup_step = ?"); values.push(update.step ?? null); }
  if ("detail" in update) { sets.push("startup_detail = ?"); values.push(update.detail ?? null); }
  if ("startedAt" in update) { sets.push("startup_started_at = ?"); values.push(update.startedAt ?? null); }
  if ("readyAt" in update) { sets.push("startup_ready_at = ?"); values.push(update.readyAt ?? null); }
  if ("failedAt" in update) { sets.push("startup_failed_at = ?"); values.push(update.failedAt ?? null); }
  if ("failure" in update) { sets.push("startup_failure = ?"); values.push(update.failure ?? null); }
  if (update.clearFailure) {
    if (!("failedAt" in update)) sets.push("startup_failed_at = NULL");
    if (!("failure" in update)) sets.push("startup_failure = NULL");
  }
  values.push(id);
  // `IS NULL` rather than `= ?` for the null case: no driver here compares NULL as equal.
  let where = "id = ?";
  if (update.expectUpdatedAt !== undefined) {
    if (update.expectUpdatedAt === null) where += " AND startup_updated_at IS NULL";
    else { where += " AND startup_updated_at = ?"; values.push(update.expectUpdatedAt); }
  }
  const res = await getDb().run(`UPDATE sessions SET ${sets.join(", ")} WHERE ${where}`, values);
  return res.changes > 0;
}

export interface SessionUsageDbSnapshot {
  tokensUsed: number;
  costUsd: number | null;
  lastContextTokens: number;
  usageUpdatedAt: number | null;
}

export async function updateSessionUsage(id: string, snapshot: SessionUsageDbSnapshot): Promise<void> {
  await getDb().run(`
    UPDATE sessions
    SET tokens_used = ?, cost_usd = ?, last_context_tokens = ?, usage_updated_at = ?
    WHERE id = ?
  `, [snapshot.tokensUsed, snapshot.costUsd, snapshot.lastContextTokens, snapshot.usageUpdatedAt, id]);
}

/** Distinct models previously chosen for `provider`, most-recently-used first. */
export async function getRecentSessionModels(provider: string, limit = 5): Promise<string[]> {
  return (await getDb().all(`
    SELECT model, MAX(created_at) AS last_used FROM sessions
    WHERE model IS NOT NULL AND model != '' AND COALESCE(provider, 'claude') = ?
    GROUP BY model ORDER BY last_used DESC LIMIT ?
  `, [provider, limit]) as Array<{ model: string }>).map((r) => r.model);
}

/** Key for a repo combination in `session_capability_defaults`: the repo full
 *  names de-duplicated, sorted and joined with a newline, so one repo is keyed
 *  by its own name and a multi-repo set is order-insensitive. Sorts by plain
 *  code-unit order, not `localeCompare`, so the key matches the browser-side
 *  one built in sessions-list.ts regardless of either side's locale. */
export function sessionCapabilityDefaultsKey(repos: string[]): string {
  return [...new Set(repos)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n");
}

/** Remember `capabilities` as the create-form default for this repo
 *  combination, replacing any earlier set. An empty list is stored as `[]`,
 *  distinct from no row. No-op for an empty `repos`. */
export async function rememberSessionCapabilityDefaults(repos: string[], capabilities: string[], updatedAt = Date.now()): Promise<void> {
  if (repos.length === 0) return;
  await getDb().run(`
    INSERT INTO session_capability_defaults (repo_key, capabilities, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(repo_key) DO UPDATE SET capabilities = excluded.capabilities, updated_at = excluded.updated_at
  `, [sessionCapabilityDefaultsKey(repos), JSON.stringify(capabilities), updatedAt]);
}

/** Every remembered capability set, keyed by `sessionCapabilityDefaultsKey`.
 *  Rows whose JSON is unparseable or not a string array are skipped. */
export async function getAllSessionCapabilityDefaults(): Promise<Map<string, string[]>> {
  const rows = await getDb().all(`SELECT repo_key, capabilities FROM session_capability_defaults`) as Array<{ repo_key: string; capabilities: string }>;
  const out = new Map<string, string[]>();
  for (const row of rows) {
    let parsed: unknown;
    try { parsed = JSON.parse(row.capabilities); } catch { continue; }
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) continue;
    out.set(row.repo_key, parsed as string[]);
  }
  return out;
}

/** Remember `provider` as the operator's last-chosen agent. A non-null `model`
 *  replaces that agent's remembered model; null keeps the earlier one. */
export async function rememberSessionAgentDefault(provider: string, model: string | null, updatedAt = Date.now()): Promise<void> {
  await getDb().run(`
    INSERT INTO session_agent_defaults (provider, model, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      model = COALESCE(excluded.model, session_agent_defaults.model),
      updated_at = excluded.updated_at
  `, [provider, model, updatedAt]);
}

/** The last-chosen agent (highest `updated_at`) and each agent's remembered model. */
export async function getSessionAgentDefaults(): Promise<{ lastProvider: string | null; models: Record<string, string> }> {
  const rows = await getDb().all(`SELECT provider, model, updated_at FROM session_agent_defaults ORDER BY updated_at DESC`) as Array<{ provider: string; model: string | null; updated_at: number }>;
  const models: Record<string, string> = {};
  for (const row of rows) if (row.model) models[row.provider] = row.model;
  return { lastProvider: rows[0]?.provider ?? null, models };
}

/** A row of `session_capability_requests`. */
export interface SessionCapabilityRequestRow {
  session_id: string;
  capability: string;
  status: string;
  reason: string;
  requested_at: number;
  decided_at: number | null;
  /** When the agent last hit a request route for the pair. */
  last_polled_at: number | null;
  /** When a request route last returned the pair to the agent as granted. */
  grant_seen_at: number | null;
}

const CAPABILITY_REQUEST_COLUMNS = "session_id, capability, status, reason, requested_at, decided_at, last_polled_at, grant_seen_at";

function toSessionCapabilityRequestRow(row: SessionCapabilityRequestRow): SessionCapabilityRequestRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    ...row,
    requested_at: Number(row.requested_at),
    decided_at: num(row.decided_at),
    last_polled_at: num(row.last_polled_at),
    grant_seen_at: num(row.grant_seen_at),
  };
}

/** Insert or replace the stored request for a (session, capability) pair. */
export async function upsertSessionCapabilityRequest(row: SessionCapabilityRequestRow): Promise<void> {
  await getDb().run(`
    INSERT INTO session_capability_requests (${CAPABILITY_REQUEST_COLUMNS})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, capability) DO UPDATE SET
      status = excluded.status, reason = excluded.reason,
      requested_at = excluded.requested_at, decided_at = excluded.decided_at,
      last_polled_at = excluded.last_polled_at, grant_seen_at = excluded.grant_seen_at
  `, [row.session_id, row.capability, row.status, row.reason, row.requested_at, row.decided_at, row.last_polled_at, row.grant_seen_at]);
}

/** Insert a request unless the pair already has one; true when this call inserted it. */
export async function insertSessionCapabilityRequestIfAbsent(row: SessionCapabilityRequestRow): Promise<boolean> {
  const { changes } = await getDb().run(`
    INSERT INTO session_capability_requests (${CAPABILITY_REQUEST_COLUMNS})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, capability) DO NOTHING
  `, [row.session_id, row.capability, row.status, row.reason, row.requested_at, row.decided_at, row.last_polled_at, row.grant_seen_at]);
  return changes > 0;
}

/** The stored request for a (session, capability) pair, if any. */
export async function getSessionCapabilityRequest(sessionId: string, capability: string): Promise<SessionCapabilityRequestRow | undefined> {
  const row = await getDb().get<SessionCapabilityRequestRow>(
    `SELECT ${CAPABILITY_REQUEST_COLUMNS} FROM session_capability_requests WHERE session_id = ? AND capability = ?`,
    [sessionId, capability],
  );
  return row ? toSessionCapabilityRequestRow(row) : undefined;
}

/** Every stored request of one session, oldest first. */
export async function listSessionCapabilityRequests(sessionId: string): Promise<SessionCapabilityRequestRow[]> {
  const rows = await getDb().all<SessionCapabilityRequestRow>(
    `SELECT ${CAPABILITY_REQUEST_COLUMNS} FROM session_capability_requests WHERE session_id = ? ORDER BY requested_at, capability`,
    [sessionId],
  );
  return rows.map(toSessionCapabilityRequestRow);
}

/**
 * Set a stored request's status and decision time. With `onlyIfPending` the
 * update applies only to a pending request, so two processes deciding the same
 * request at once cannot both win. True when a row changed.
 */
export async function setSessionCapabilityRequestStatus(
  sessionId: string,
  capability: string,
  status: string,
  decidedAt: number,
  opts: { onlyIfPending?: boolean } = {},
): Promise<boolean> {
  const { changes } = await getDb().run(
    `UPDATE session_capability_requests SET status = ?, decided_at = ? WHERE session_id = ? AND capability = ?${opts.onlyIfPending ? " AND status = 'pending'" : ""}`,
    [status, decidedAt, sessionId, capability],
  );
  return changes > 0;
}

/** Record when the agent last polled, or last collected a grant for, a stored request; nothing without one. */
export async function markSessionCapabilityRequest(
  sessionId: string,
  capability: string,
  column: "last_polled_at" | "grant_seen_at",
  at: number,
): Promise<void> {
  await getDb().run(`UPDATE session_capability_requests SET ${column} = ? WHERE session_id = ? AND capability = ?`, [at, sessionId, capability]);
}

/** Delete a session's stored request for one capability, or every one of its
 *  requests when `capability` is omitted. */
export async function deleteSessionCapabilityRequest(sessionId: string, capability?: string): Promise<void> {
  if (capability === undefined) {
    await getDb().run(`DELETE FROM session_capability_requests WHERE session_id = ?`, [sessionId]);
    return;
  }
  await getDb().run(`DELETE FROM session_capability_requests WHERE session_id = ? AND capability = ?`, [sessionId, capability]);
}

/** Delete the stored requests of sessions that have ended or no longer exist;
 *  returns how many rows went. */
export async function pruneSessionCapabilityRequestsForEndedSessions(): Promise<number> {
  const { changes } = await getDb().run(`
    DELETE FROM session_capability_requests
    WHERE session_id NOT IN (SELECT id FROM sessions WHERE ended_at IS NULL)
  `);
  return changes;
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
  await getDb().run(`UPDATE sessions SET ended_at = ?, resume_repos = ?, startup_state = COALESCE(startup_state, 'ended'), startup_updated_at = ? WHERE id = ?`, [endedAt, resumeRepos, endedAt, id]);
}

/** Record the exit code and final output of a session whose process ended (#3311). Does not end the row. */
export async function recordSessionExit(id: string, exitCode: number | null, lastOutput: string | null): Promise<void> {
  await getDb().run(`UPDATE sessions SET exit_code = ?, last_output = ? WHERE id = ?`, [exitCode, lastOutput, id]);
}

/** Reopen an ended session; `launchedAt` also records a pod relaunch and stamps the running `VERSION` as `launched_version` (see `PersistedSession.launched_at`). Adopting a still-running pod leaves the version alone — use `setSessionLaunchedVersion` where a fresh agent starts. */
export async function clearSessionEnded(id: string, launchedAt?: number): Promise<void> {
  if (launchedAt === undefined) {
    await getDb().run(`UPDATE sessions SET ended_at = NULL, agent_status = NULL, agent_status_updated_at = NULL, exit_code = NULL, last_output = NULL, ${REOPEN_MEMORY_CAPTURE} WHERE id = ?`, [id]);
    return;
  }
  await getDb().run(`
    UPDATE sessions
    SET ended_at = NULL, agent_status = NULL, agent_status_updated_at = NULL, exit_code = NULL, last_output = NULL, ${REOPEN_MEMORY_CAPTURE}, launched_at = ?,
        startup_started_at = ?, startup_updated_at = ?, startup_ready_at = NULL, startup_failed_at = NULL, startup_failure = NULL,
        launched_version = ?
    WHERE id = ?
  `, [launchedAt, launchedAt, launchedAt, VERSION, id]);
}

/** Stamp the running `VERSION` as the session's `launched_version`, for a resume that starts a fresh agent process. */
export async function setSessionLaunchedVersion(id: string): Promise<void> {
  await getDb().run(`UPDATE sessions SET launched_version = ? WHERE id = ?`, [VERSION, id]);
}

/**
 * Ids of `backend`'s ended sessions past its newest `keep`, without deleting them.
 * Each backend prunes only its own rows, so the other's cleanup (upload/MCP dirs,
 * session PVCs) is never skipped.
 */
export async function getPrunableEndedSessionIds(keep: number, backend: "local-tmux" | "k8s-pod"): Promise<string[]> {
  const backendFilter = backend === "k8s-pod" ? "backend = 'k8s-pod'" : "(backend IS NULL OR backend = 'local-tmux')";
  // SQLite: LIMIT -1 OFFSET keep = "all rows past the first `keep`"
  const rows = await getDb().all(`
    SELECT id
    FROM sessions
    WHERE ended_at IS NOT NULL AND ${backendFilter}
    ORDER BY ended_at DESC, id DESC
    LIMIT -1 OFFSET ?
  `, [keep]) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export async function pruneEndedSessions(keep: number, backend: "local-tmux" | "k8s-pod"): Promise<string[]> {
  const ids = await getPrunableEndedSessionIds(keep, backend);
  if (ids.length === 0) return [];
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

/** Delete a session row only while it is still ended; false when it was reopened (or is gone). */
export async function deleteEndedPersistedSession(id: string): Promise<boolean> {
  const result = await getDb().run(`DELETE FROM sessions WHERE id = ? AND ended_at IS NOT NULL`, [id]);
  return result.changes > 0;
}

// ── Session memory captures (claude-memory-backup) ──

/** SET clause every reopen of a session row applies, so its next end captures its memories again. */
const REOPEN_MEMORY_CAPTURE = "memories_captured_at = NULL, memory_capture_attempts = 0";

/** project-slug → (filename → content), as read off a session's `~/.claude/projects`. */
export type SessionMemoryFiles = Record<string, Record<string, string>>;

export interface SessionMemoryCapture {
  session_id: string;
  captured_at: number;
  files: SessionMemoryFiles;
}

function endedAtMatch(endedAt: number | null): { sql: string; params: number[] } {
  return endedAt === null ? { sql: "ended_at IS NULL", params: [] } : { sql: "ended_at = ?", params: [endedAt] };
}

/**
 * Store the memory files just read off session `id`'s PVC, replacing any earlier
 * capture and clearing its `pushed_at` so claude-memory-backup pushes it again,
 * and stamp the row captured. Only while the row still has `endedAt` (NULL for an
 * open row being deleted): a capture that raced a resume is discarded, and
 * false is returned. A row already deleted is not stamped but its files are kept.
 */
export async function recordSessionMemoryCapture(id: string, endedAt: number | null, files: SessionMemoryFiles, capturedAt: number): Promise<boolean> {
  const match = endedAtMatch(endedAt);
  return await getDb().transaction(async (tx) => {
    const row = await tx.get(`SELECT id FROM sessions WHERE id = ? AND ${match.sql}`, [id, ...match.params]) as { id: string } | undefined;
    if (!row) return false;
    await tx.run(`
      INSERT INTO session_memory_captures (session_id, captured_at, files_json, pushed_at) VALUES (?, ?, ?, NULL)
      ON CONFLICT(session_id) DO UPDATE SET captured_at = excluded.captured_at, files_json = excluded.files_json, pushed_at = NULL
    `, [id, capturedAt, JSON.stringify(files)]);
    await tx.run(`UPDATE sessions SET memories_captured_at = ? WHERE id = ?`, [capturedAt, id]);
    return true;
  });
}

/** Count one failed capture attempt for session `id`, while it still has `endedAt`. */
export async function noteSessionMemoryCaptureFailed(id: string, endedAt: number | null): Promise<void> {
  const match = endedAtMatch(endedAt);
  await getDb().run(`UPDATE sessions SET memory_capture_attempts = COALESCE(memory_capture_attempts, 0) + 1 WHERE id = ? AND ${match.sql}`, [id, ...match.params]);
}

/** Ended `k8s-pod` sessions not yet captured and with fewer than `maxAttempts` failed attempts, most recently ended first. */
export async function getSessionsNeedingMemoryCapture(maxAttempts: number, limit: number): Promise<PersistedSession[]> {
  return await getDb().all(`
    SELECT * FROM sessions
    WHERE backend = 'k8s-pod' AND ended_at IS NOT NULL AND memories_captured_at IS NULL
      AND COALESCE(memory_capture_attempts, 0) < ?
    ORDER BY ended_at DESC, id DESC
    LIMIT ?
  `, [maxAttempts, limit]) as PersistedSession[];
}

/** Captures whose current files claude-memory-backup has not pushed yet, oldest first. */
export async function listUnpushedSessionMemoryCaptures(): Promise<SessionMemoryCapture[]> {
  const rows = await getDb().all(`
    SELECT session_id, captured_at, files_json FROM session_memory_captures WHERE pushed_at IS NULL ORDER BY captured_at, session_id
  `) as Array<{ session_id: string; captured_at: number; files_json: string }>;
  const out: SessionMemoryCapture[] = [];
  for (const row of rows) {
    let files: SessionMemoryFiles = {};
    try {
      const parsed = JSON.parse(row.files_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) files = parsed as SessionMemoryFiles;
    } catch {
      // A corrupt row pushes as empty: the session's directories are cleared rather than left stale.
    }
    out.push({ session_id: row.session_id, captured_at: Number(row.captured_at), files });
  }
  return out;
}

/** Mark a capture pushed, unless a newer capture of that session replaced it since it was listed. */
export async function markSessionMemoryCapturePushed(sessionId: string, capturedAt: number, pushedAt: number): Promise<void> {
  await getDb().run(`UPDATE session_memory_captures SET pushed_at = ? WHERE session_id = ? AND captured_at = ?`, [pushedAt, sessionId, capturedAt]);
}

export async function updateSessionSummary(id: string, summary: string, updatedAt: number): Promise<void> {
  await getDb().run(`UPDATE sessions SET summary = ?, summary_updated_at = ? WHERE id = ? AND summary_manual = 0`, [summary, updatedAt, id]);
}

/** Set (or clear, with `summary === null`) a user-authored session description. Returns true if a row was updated. */
export async function setManualSessionSummary(id: string, summary: string | null, updatedAt: number | null): Promise<boolean> {
  const info = await getDb().run(`UPDATE sessions SET summary = ?, summary_updated_at = ?, summary_manual = ? WHERE id = ?`, [summary, updatedAt, summary === null ? 0 : 1, id]);
  return info.changes > 0;
}

/** Replace a session row's granted capability ids (#3072 runtime grant). */
export async function updateSessionCapabilities(id: string, caps: string[]): Promise<void> {
  await getDb().run(`UPDATE sessions SET capabilities = ? WHERE id = ?`, [JSON.stringify(caps), id]);
}

/** Record a live session's self-reported agent status. Returns false when the row is missing or already ended. */
export async function setSessionAgentStatus(id: string, status: string, updatedAt: number): Promise<boolean> {
  const info = await getDb().run(`UPDATE sessions SET agent_status = ?, agent_status_updated_at = ? WHERE id = ? AND ended_at IS NULL`, [status, updatedAt, id]);
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

export async function recordReminderFired(repo: string, reminderId: string, notifyOn: string, issueNumber: IssueRef): Promise<void> {
  await getDb().run(`INSERT OR IGNORE INTO reminder_notifications (repo, reminder_id, notify_on, issue_number) VALUES (?, ?, ?, ?)`, [repo, reminderId, notifyOn, refParam(issueNumber)]);
}

/** True once `watchId` has unblocked `repo#issueNumber` — stops a re-comment
 *  loop if a human later re-applies `Blocked`. (#2617) */
export async function hasUpstreamWatchFired(watchId: string, repo: string, issueNumber: IssueRef): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 AS n FROM upstream_watch_fires WHERE watch_id = ? AND repo = ? AND issue_number = ? LIMIT 1`, [watchId, repo, refParam(issueNumber)]) as { n: number } | undefined;
  return row !== undefined;
}

export async function recordUpstreamWatchFired(watchId: string, repo: string, issueNumber: IssueRef): Promise<void> {
  await getDb().run(`INSERT OR IGNORE INTO upstream_watch_fires (watch_id, repo, issue_number) VALUES (?, ?, ?)`, [watchId, repo, refParam(issueNumber)]);
}

/**
 * All-time reported OpenCode-on-Anthropic spend in USD: the CLI's own
 * `cost_usd` for every OpenCode task and session whose model is `anthropic/…`.
 * Not limited to the Usage page's day window.
 */
export async function getOpencodeAnthropicSpendUsd(): Promise<number> {
  const startedAt = Date.now();
  const row = await getDb().get(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total FROM (
      SELECT cost_usd FROM tasks
      WHERE provider_used = 'opencode' AND model_used LIKE 'anthropic/%' AND cost_usd IS NOT NULL
      UNION ALL
      SELECT cost_usd FROM sessions
      WHERE provider = 'opencode' AND model LIKE 'anthropic/%' AND cost_usd IS NOT NULL
    ) opencode_anthropic_spend
  `) as { total: number | string | null } | undefined;
  log.info(`[opencode-spend] all-time spend query took duration_ms=${Date.now() - startedAt}`);
  return Number(row?.total ?? 0);
}

/** The threshold (USD) the `key` spend warning last fired at, or null when it never has. */
export async function getSpendWarningThreshold(key: string): Promise<number | null> {
  const row = await getDb().get(`SELECT threshold_usd FROM spend_warnings WHERE key = ?`, [key]) as { threshold_usd: number | string } | undefined;
  return row ? Number(row.threshold_usd) : null;
}

/** Records that the `key` spend warning fired at `thresholdUsd`. */
export async function recordSpendWarning(key: string, thresholdUsd: number): Promise<void> {
  await getDb().run(
    `INSERT INTO spend_warnings (key, threshold_usd, notified_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET threshold_usd = excluded.threshold_usd, notified_at = excluded.notified_at`,
    [key, thresholdUsd, nowSql()],
  );
}

export interface ImportedIssue {
  repo: string;
  /** The forge issue number the import closed. */
  forgeNumber: IssueRef;
  /** The `clw_…` id it became. */
  nativeId: string;
}

/**
 * Record that `repo#forgeNumber` was imported into the native tracker as
 * `nativeId` (#3245).
 *
 * `INSERT OR IGNORE` on `(repo, forge_number)`: this is `issue-importer`'s
 * idempotency key, so a re-run that reaches the write again must not replace
 * the row that already names the native issue it created.
 *
 * Returns whether the stored row names `nativeId` — true both when this call
 * inserted it and when a previous one already recorded the same id. False
 * means the key was taken by a *different* native issue, which the caller must
 * treat as a failure rather than as idempotency: it has just built an issue
 * nothing links to. A write whose whole job is idempotency must not be able to
 * disagree with its caller in silence (#3246).
 */
export async function recordImportedIssue(repo: string, forgeNumber: IssueRef, nativeId: string): Promise<boolean> {
  const id = refParam(nativeId);
  const res = await getDb().run(
    `INSERT OR IGNORE INTO imported_issues (repo, forge_number, native_id) VALUES (?, ?, ?)`,
    [repo, refParam(forgeNumber), id],
  );
  if (res.changes > 0) return true;
  const row = await getDb().get(
    `SELECT native_id FROM imported_issues WHERE repo = ? AND forge_number = ?`,
    [repo, refParam(forgeNumber)],
  ) as { native_id: string } | undefined;
  return row !== undefined && String(row.native_id) === id;
}

/**
 * Every recorded import, for the in-process index in `imported-refs.ts`.
 *
 * `forge_number` is TEXT, so Postgres hands `7` back as `"7"` — normalised
 * here, or every `sameIssueRef` comparison against a forge number would
 * silently stop matching on Postgres while still passing on SQLite.
 *
 * Shadows have a linkage row too, and they are excluded here (#3246): the
 * index is an *alias* index, and a live forge issue is not an alias of its
 * shadow. Leave them in and every forge ref on the fleet would resolve to a
 * hidden native id, doubling `listMergedPRsForIssue` and
 * `listDuplicateIssuesOf`'s API calls and pointing the watcher's writes at a
 * row nothing reads. The join is an INNER one on purpose: a linkage row whose
 * native issue has been deleted names nothing to alias to either.
 */
export async function listImportedIssues(): Promise<ImportedIssue[]> {
  const rows = await getDb().all(`
    SELECT i.repo, i.forge_number, i.native_id
      FROM imported_issues i
      JOIN claws_issues c ON c.id = i.native_id
     WHERE c.kind <> 'shadow'
  `) as { repo: string; forge_number: unknown; native_id: string }[];
  return rows.map((r) => ({ repo: r.repo, forgeNumber: refFromColumn(r.forge_number), nativeId: String(r.native_id) }));
}

/**
 * The forge `updatedAt` `issue-shadow-sync` last processed for
 * `repo#forgeNumber`, or null when it has not yet — or there is no row.
 */
export async function getImportedForgeSyncedAt(repo: string, forgeNumber: IssueRef): Promise<string | null> {
  const row = await getDb().get(
    `SELECT forge_synced_at FROM imported_issues WHERE repo = ? AND forge_number = ?`,
    [repo, refParam(forgeNumber)],
  ) as { forge_synced_at: string | null } | undefined;
  return row?.forge_synced_at ?? null;
}

/** Record the forge `updatedAt` just processed for `repo#forgeNumber`. A missing row is left missing. */
export async function setImportedForgeSyncedAt(repo: string, forgeNumber: IssueRef, updatedAt: string): Promise<void> {
  await getDb().run(
    `UPDATE imported_issues SET forge_synced_at = ? WHERE repo = ? AND forge_number = ?`,
    [updatedAt, repo, refParam(forgeNumber)],
  );
}

/**
 * The forge issue `nativeId` is linked to, imported or shadowed, or undefined.
 *
 * The reverse of the `imported_issues` lookup, and unlike
 * {@link listImportedIssues} it answers for a shadow. `/issues/:id` uses it
 * to redirect a shadow to the forge issue it stands for.
 *
 * The table's primary key is `(repo, forge_number)` and the only index on
 * `native_id` is non-unique, so nothing structural stops two linkage rows
 * naming the same native issue. `ORDER BY` makes the answer deterministic
 * anyway — without it the planner returns whichever row it reached first,
 * which can differ between SQLite and Postgres and between runs, and a
 * redirect would send the same shadow to a different forge issue each time.
 * A unique index would be the stronger fix, but it is not one that can be
 * added here: `CREATE UNIQUE INDEX` on a database that already holds a
 * duplicate fails, and it would fail at boot.
 */
export async function getImportedIssueByNative(nativeId: string): Promise<{ repo: string; forgeNumber: IssueRef } | undefined> {
  const row = await getDb().get(
    `SELECT repo, forge_number FROM imported_issues WHERE native_id = ? ORDER BY repo ASC, forge_number ASC LIMIT 1`,
    [refParam(nativeId)],
  ) as { repo: string; forge_number: unknown } | undefined;
  return row ? { repo: row.repo, forgeNumber: refFromColumn(row.forge_number) } : undefined;
}

/**
 * The open, non-shadow native issue in `repo` (its primary repo) titled
 * exactly `title` — or first filed under it, before a rename — that was
 * itself imported from a `repo` forge issue — the target when a recurring
 * workflow re-files a forge issue Claws already moved, so the importer
 * updates it instead of importing a duplicate. Newest first when several
 * match. A natively filed issue never matches.
 */
export async function findOpenImportedIssueByTitle(repo: string, title: string): Promise<ClawsIssueRecord | undefined> {
  const row = await getDb().get(
    `SELECT id FROM claws_issues
      WHERE state = 'open' AND kind <> 'shadow' AND (title = ? OR filed_title = ?)
        AND ${primaryRepoSql()} = ?
        AND EXISTS (SELECT 1 FROM imported_issues i WHERE i.native_id = claws_issues.id AND i.repo = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [title, title, repo, repo],
  ) as { id: string } | undefined;
  return row ? await getClawsIssue(String(row.id)) : undefined;
}

/**
 * Point `repo#forgeNumber`'s linkage row at `nativeId`, inserting it when
 * missing. A shadow the row previously named is deleted (its sidecar rows
 * cascade), since the forge issue it stood for now belongs to `nativeId`.
 */
export async function relinkImportedIssue(repo: string, forgeNumber: IssueRef, nativeId: string): Promise<void> {
  const id = refParam(nativeId);
  await getDb().transaction(async (tx) => {
    const previous = await tx.get(
      `SELECT native_id FROM imported_issues WHERE repo = ? AND forge_number = ?`,
      [repo, refParam(forgeNumber)],
    ) as { native_id: string } | undefined;
    if (!previous) {
      await tx.run(`INSERT INTO imported_issues (repo, forge_number, native_id) VALUES (?, ?, ?)`, [repo, refParam(forgeNumber), id]);
      return;
    }
    const previousId = String(previous.native_id);
    if (previousId === id) return;
    await tx.run(`UPDATE imported_issues SET native_id = ? WHERE repo = ? AND forge_number = ?`, [id, repo, refParam(forgeNumber)]);
    await tx.run(`DELETE FROM claws_issues WHERE id = ? AND kind = 'shadow'`, [previousId]);
  });
}

export async function hasBlogDraftPortFiled(repo: string, path: string): Promise<boolean> {
  const row = await getDb().get(`SELECT 1 AS n FROM blog_draft_ports WHERE repo = ? AND path = ? LIMIT 1`, [repo, path]) as { n: number } | undefined;
  return row !== undefined;
}

export async function recordBlogDraftPortFiled(repo: string, path: string, issueNumber: IssueRef): Promise<void> {
  await getDb().run(`INSERT OR IGNORE INTO blog_draft_ports (repo, path, issue_number) VALUES (?, ?, ?)`, [repo, path, refParam(issueNumber)]);
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

// Discard a Claws-saved draft. Only the stored row goes; the blog repo is never touched.
export async function deleteBlogDraft(repo: string, path: string): Promise<void> {
  await getDb().run(`DELETE FROM blog_drafts WHERE repo = ? AND path = ?`, [repo, path]);
}

// ── friction notes (claws_note_friction → jobs/friction-retrospective.ts) ──

export interface FrictionNoteRow {
  id: number;
  repo: string;
  category: string;
  text: string;
  reference: string | null;
  task_id: number | null;
  session_id: string | null;
  origin: string | null;
  created_at: string;
  triaged_at: string | null;
  retrospective_issue_id: string | null;
}

export interface FrictionNoteInput {
  repo: string;
  category: string;
  text: string;
  reference?: string | null;
  taskId?: number | null;
  sessionId?: string | null;
  origin?: string | null;
}

/** Stores one untriaged friction note and returns its id. Triggers nothing else. */
export async function insertFrictionNote(note: FrictionNoteInput): Promise<number> {
  const { id } = await getDb().insert(
    `INSERT INTO friction_notes (repo, category, text, reference, task_id, session_id, origin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [note.repo, note.category, note.text, note.reference ?? null, note.taskId ?? null, note.sessionId ?? null, note.origin ?? null, nowSql()],
  );
  return id;
}

function normalizeFrictionNote(row: FrictionNoteRow): FrictionNoteRow {
  return { ...row, id: Number(row.id), task_id: row.task_id === null ? null : Number(row.task_id) };
}

/** Untriaged notes, oldest first; every repo's when `repo` is omitted. */
export async function listUntriagedFrictionNotes(repo?: string): Promise<FrictionNoteRow[]> {
  const rows = repo === undefined
    ? await getDb().all(`SELECT * FROM friction_notes WHERE triaged_at IS NULL ORDER BY created_at ASC, id ASC`)
    : await getDb().all(`SELECT * FROM friction_notes WHERE repo = ? AND triaged_at IS NULL ORDER BY created_at ASC, id ASC`, [repo]);
  return (rows as FrictionNoteRow[]).map(normalizeFrictionNote);
}

/** Untriaged note counts keyed by repo, then category. */
export async function countUntriagedFrictionNotesByRepoAndCategory(): Promise<Map<string, Map<string, number>>> {
  const rows = await getDb().all(
    `SELECT repo, category, COUNT(*) AS n FROM friction_notes WHERE triaged_at IS NULL GROUP BY repo, category`,
  ) as Array<{ repo: string; category: string; n: number | string }>;
  const out = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const byCategory = out.get(row.repo) ?? new Map<string, number>();
    byCategory.set(row.category, Number(row.n));
    out.set(row.repo, byCategory);
  }
  return out;
}

/** Marks notes triaged by retrospective issue `issueId`; a note already triaged keeps its first retrospective. */
export async function markFrictionNotesTriaged(ids: number[], issueId: string): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  await getDb().run(
    `UPDATE friction_notes SET triaged_at = ?, retrospective_issue_id = ? WHERE triaged_at IS NULL AND id IN (${placeholders})`,
    [nowSql(), issueId, ...ids],
  );
}

/** When the fleet's last retrospective triaged notes (`YYYY-MM-DD HH:MM:SS` UTC), or null when it has had none. */
export async function lastFrictionRetrospectiveAt(): Promise<string | null> {
  const row = await getDb().get(`SELECT MAX(triaged_at) AS at FROM friction_notes`) as { at: string | null } | undefined;
  return row?.at ?? null;
}

export interface FrictionRetrospective {
  issueId: string;
  triagedAt: string;
  noteCount: number;
}

/** Past retrospective issues across every repo, newest first. */
export async function listFrictionRetrospectives(): Promise<FrictionRetrospective[]> {
  const rows = await getDb().all(
    `SELECT retrospective_issue_id AS issue_id, MAX(triaged_at) AS triaged_at, COUNT(*) AS n
       FROM friction_notes WHERE retrospective_issue_id IS NOT NULL
       GROUP BY retrospective_issue_id ORDER BY MAX(triaged_at) DESC`,
  ) as Array<{ issue_id: string; triaged_at: string; n: number | string }>;
  return rows.map((r) => ({ issueId: r.issue_id, triagedAt: r.triaged_at, noteCount: Number(r.n) }));
}

/** The task rows among `ids` that still exist; pruned ones are simply absent. */
export async function getTasksByIds(ids: number[]): Promise<Task[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return normalizeItemNumbers(await getDb().all(`SELECT * FROM tasks WHERE id IN (${placeholders}) ORDER BY id ASC`, [...ids]) as Task[]);
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

/** Returns the SHA-256 digest of the generated Related repositories section last synced into `repo`'s docs, or null if never synced. */
export async function getDocFleetLinksDigest(repo: string): Promise<string | null> {
  const row = await getDb().get(`SELECT fleet_links_digest FROM doc_intent_backfill WHERE repo = ?`, [repo]) as { fleet_links_digest: string | null } | undefined;
  return row?.fleet_links_digest ?? null;
}

/** Records the digest of the generated Related repositories section last synced into `repo`'s docs. */
export async function recordDocFleetLinksDigest(repo: string, digest: string): Promise<void> {
  await getDb().run(`
    INSERT INTO doc_intent_backfill (repo, fleet_links_digest)
    VALUES (?, ?)
    ON CONFLICT(repo) DO UPDATE SET
      fleet_links_digest = excluded.fleet_links_digest,
      updated_at = ?
  `, [repo, digest, nowSql()]);
}

// ── Claws-native issue tracker ──

export interface ClawsIssueRow {
  id: string;
  title: string;
  body: string;
  author_login: string;
  state: string;
  state_reason: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /**
   * `issue` — an operator-facing native issue. `shadow` — the native backing
   * record of an issue that is still live on a forge (#3246).
   *
   * A shadow is a `claws_issues` row and not a table of its own precisely so
   * that every column added here covers it too. It is invisible to the
   * dispatchers, the board and `/issues` because {@link listOpenClawsIssues}
   * and {@link listClosedClawsIssuesSince} exclude it; {@link getClawsIssue}
   * still returns one, so the page can redirect to the forge.
   */
  kind: "issue" | "shadow";
  /**
   * When `issue-shadow-sync` last examined this shadow, successfully or not;
   * NULL on every `issue` row and on a shadow no run has reached yet. Separate
   * from `updated_at` because "we looked" and "something changed" are
   * different facts and a checked-but-unchanged shadow deliberately records
   * only the first; {@link listShadowIssues} orders on it (#3246).
   */
  shadow_checked_at: string | null;
  /**
   * The issue's lifecycle state, stored here rather than as `Blocked` /
   * `Backlog` label rows. {@link toClawsRecords} adds the matching
   * label to `labels`, and {@link addClawsIssueLabel} /
   * {@link removeClawsIssueLabel} turn a state-label write into a write here.
   */
  lifecycle: IssueLifecycle;
  /**
   * How far along the Requirements → Plan → Merge track the issue is approved
   * (`issue-approval.ts`); written only by {@link setClawsIssueApprovedThrough}
   * and the promotion writes. Absent on a hand-built row, which reads as `none`.
   */
  approved_through?: ApprovedThrough;
  /** Who last set {@link approved_through}: a login, an agent or `migration`. */
  approved_through_by?: string | null;
  /** When {@link approved_through} was last set. */
  approved_through_at?: string | null;
  /**
   * When {@link approved_through} last rose to `plan` or beyond from below;
   * NULL while it is below `plan`. Unlike {@link approved_through_at}, a
   * Plan ↔ Merge change leaves it as it is.
   */
  plan_approved_at?: string | null;
  /**
   * When the issue entered its current board column: set on every `lifecycle`
   * change and close/reopen. NULL on a row that
   * predates the column — readers fall back to `updated_at`.
   */
  stage_changed_at: string | null;
  /** The approved `claws_issue_requirements` version; NULL until promotion. */
  approved_requirements_version: number | null;
  /** Who approved it — a dashboard login, or `claws` for auto-promotion. */
  requirements_approved_by: string | null;
  requirements_approved_at: string | null;
  /** Where the issue came from; decides whether its requirements auto-promote. */
  source: IssueSource;
  /** Per-issue promotion override: 1 auto-promotes, 0 waits for a human, NULL follows the source default. */
  auto_promote: number | null;
  /**
   * 1 when the issue goes through the requirements stage, 0 when it goes
   * straight to Planning with no record; NULL, or absent on a hand-built row,
   * reads as 1 (`requirementsStageApplies`).
   */
  requirements_stage?: number | null;
  /** The title the issue was filed under, once promotion renamed it; NULL otherwise. */
  filed_title: string | null;
  /** The caller-supplied dedupe key the issue was filed with; NULL otherwise. */
  dedupe_key: string | null;
  /**
   * The repo pinned as the issue's primary ({@link primaryRepoOf}); NULL, or
   * absent on a hand-built row, when the alphabetical rule applies.
   */
  primary_repo?: string | null;
  /**
   * The `YYYY-MM-DD` day an issue parked in the Backlog returns on
   * ({@link setClawsIssueBacklogUntil}); NULL, or absent on a hand-built row,
   * when it has none. Cleared whenever the issue leaves `backlog`.
   */
  backlog_until?: string | null;
  /** When {@link backlog_until} was set. */
  backlog_until_at?: string | null;
  /**
   * 1 while `issue-importer` is still assembling the issue
   * ({@link promoteShadowIssue}'s `importPending`, cleared by
   * {@link finishClawsIssueImport}); 0, or absent on a hand-built row,
   * otherwise. Read as {@link ClawsIssueRecord.importPending}.
   */
  import_pending?: number;
  /**
   * Which alert path filed the issue ({@link setClawsIssueAlertKind}); NULL,
   * or absent on a hand-built row, when it is not an alert.
   */
  alert_kind?: string | null;
  /** When {@link claimAlertAttention} last claimed the issue's stall announcement; NULL while unclaimed. */
  alert_attention_notified_at?: string | null;
}

/**
 * Where an issue came from (docs/refinements/issue-flow.md "Promotion"). A
 * human files a `dashboard`, `whatsapp` or `forge` issue by hand, so it goes
 * through the requirements stage ({@link HUMAN_ISSUE_SOURCES}); a `session`,
 * `agent` or `automation` issue skips it and goes straight to Planning. Of the
 * hand-filed ones, `dashboard` and `whatsapp` records wait for approval and a
 * `forge` one auto-promotes by default.
 */
export const ISSUE_SOURCES = ["dashboard", "session", "agent", "automation", "whatsapp", "forge"] as const;
export type IssueSource = (typeof ISSUE_SOURCES)[number];

/** The sources a human files by hand: only these get a requirements record by default. */
export const HUMAN_ISSUE_SOURCES: readonly IssueSource[] = ["dashboard", "whatsapp", "forge"];

/** An issue row with its repo associations and labels resolved. */
export interface ClawsIssueRecord extends ClawsIssueRow {
  repos: string[];
  labels: string[];
  /** True while `issue-importer` is still assembling the issue: every dispatcher holds it. */
  importPending: boolean;
}

export interface ClawsIssueCommentRow {
  id: string;
  issue_id: string;
  author_login: string;
  body: string;
  created_at: string;
  updated_at: string;
  /** When the comment was soft-deleted; the reads filter such rows out, so this is NULL on what they return. */
  deleted_at: string | null;
  /** Who soft-deleted the comment: `operator:<login>` or `session:<id>`. */
  deleted_by: string | null;
}

export interface ClawsIssueReactionRow {
  comment_id: string;
  login: string;
  content: string;
}

/**
 * Labels and repos for the issues `tail` selects, keyed by issue id.
 *
 * `tail` is the caller's own `WHERE … ORDER BY … LIMIT …` re-used verbatim as
 * a subquery, not a list of ids: scoped exactly the same way, but with no
 * `IN (?, ?, …)` to blow past Postgres' 65535 bind parameters or SQLite's
 * `SQLITE_MAX_VARIABLE_NUMBER` — `listOpenClawsIssues` has no `LIMIT`, so
 * enough open issues would have failed the read outright and taken every
 * dispatcher down with it rather than degrading.
 *
 * Every reader goes through here so the three cannot drift into opposite
 * rules about what a sidecar is scoped to.
 */
async function loadIssueSidecars(tail: string, params: readonly unknown[]): Promise<{ repos: Map<string, string[]>; labels: Map<string, string[]> }> {
  const scope = `issue_id IN (SELECT id FROM claws_issues ${tail})`;
  const [repoRows, labelRows] = await Promise.all([
    getDb().all(`SELECT issue_id, repo FROM claws_issue_repos WHERE ${scope} ORDER BY repo ASC`, [...params]) as Promise<{ issue_id: string; repo: string }[]>,
    getDb().all(`SELECT issue_id, label FROM claws_issue_labels WHERE ${scope} ORDER BY label ASC`, [...params]) as Promise<{ issue_id: string; label: string }[]>,
  ]);
  return { repos: groupBySidecar(repoRows, "repo"), labels: groupBySidecar(labelRows, "label") };
}

function groupBySidecar<K extends string>(rows: Array<{ issue_id: string } & Record<K, string>>, column: K): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const list = out.get(row.issue_id) ?? [];
    list.push(row[column]);
    out.set(row.issue_id, list);
  }
  return out;
}

/**
 * Every reader goes through here, which is what lets the stored `lifecycle`
 * field read as the state label it replaced: the pipeline's "is this issue
 * `Blocked`?" checks see the label without knowing the field exists. Approval
 * is never a label: readers check `approved_through`.
 */
function toClawsRecords(rows: ClawsIssueRow[], sidecars: { repos: Map<string, string[]>; labels: Map<string, string[]> }): ClawsIssueRecord[] {
  return rows.map((row) => {
    const labels = sidecars.labels.get(row.id) ?? [];
    const stateLabel = labelForLifecycle(row.lifecycle);
    return {
      ...row,
      repos: sidecars.repos.get(row.id) ?? [],
      labels: stateLabel === undefined ? labels : [...labels, stateLabel],
      importPending: Boolean(row.import_pending),
    };
  });
}

/**
 * Throws unless `issueId` names a live native issue, inside the caller's
 * transaction.
 *
 * A shadow is not one (#3246), and refusing it here rather than at each call
 * site is what makes "nothing outside `db.ts`'s shadow helpers may write a
 * shadow" an invariant rather than something every new caller has to remember.
 * The three writes that do not go through this guard —
 * {@link updateClawsIssueTitle}, {@link updateClawsIssueBody} and
 * {@link setClawsIssueState} — carry the same `kind <> 'shadow'` clause on
 * their own UPDATE and report the refusal as `false`.
 *
 * **The two not-found contracts below are deliberate, not an oversight.** A
 * write whose `false` already carries a meaning — `addClawsIssueLabel` and
 * `removeClawsIssueLabel` return false for "the label was already (ab)sent" —
 * cannot also spend `false` on "no such issue" without conflating the two, so
 * those writes throw through this guard instead. `updateClawsIssueTitle` and
 * `updateClawsIssueBody` have no second meaning for `false`, so they return it
 * and `claws-issues.ts` turns it into the same error with `requireChanged`.
 * Do not "fix" one half into the other.
 *
 * {@link setClawsIssueState} is the one write with a second meaning for
 * `false` — "already in that state", which `claws-issues.ts` uses to emit
 * `issue-closed` exactly once — that does *not* go through this guard: it is a
 * single guarded UPDATE with no transaction to hang one on. Its existence
 * check lives one layer up, in `claws-issues.ts`'s `closeIssue`/`reopenIssue`,
 * which call `requireIssue` first. Do not drop that call.
 */
async function requireClawsIssue(tx: SqlDriver, issueId: string): Promise<void> {
  const parent = await tx.get(`SELECT kind FROM claws_issues WHERE id = ?`, [issueId]) as { kind: string } | undefined;
  if (!parent) throw new Error(`claws-issues: no native issue ${issueId}`);
  if (parent.kind === "shadow") throw new Error(`claws-issues: ${issueId} is a shadow of a live forge issue, not a native issue`);
}

/** One recorded change to a native issue (docs/issue-tracker.md#history). */
export interface ClawsIssueHistoryRow {
  id: string;
  issue_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  actor_kind: "operator" | "session" | "automation";
  actor: string;
  run_id: string | null;
  created_at: string;
}

/** Longest history value stored; alert issues rewrite their whole body on every occurrence. */
const ISSUE_HISTORY_VALUE_MAX = 10_000;

function capHistoryValue(value: string | null): string | null {
  if (value === null || value.length <= ISSUE_HISTORY_VALUE_MAX) return value;
  return `${value.slice(0, ISSUE_HISTORY_VALUE_MAX)}…(truncated)`;
}

/**
 * Record that `field` of native issue `issueId` went from `oldValue` to
 * `newValue`, attributed to the current issue actor and run. Writes nothing
 * when the two are equal, so a write that changed nothing leaves no entry.
 * Callers run it in the write's own transaction and only for a `kind = 'issue'`
 * row — a shadow has no History.
 */
async function recordIssueHistory(tx: SqlDriver, issueId: string, field: string, oldValue: string | null, newValue: string | null): Promise<void> {
  if (oldValue === newValue) return;
  const actor = currentIssueActor();
  await tx.run(
    `INSERT INTO claws_issue_history (id, issue_id, field, old_value, new_value, actor_kind, actor, run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newUlid(), issueId, field, capHistoryValue(oldValue), capHistoryValue(newValue), actor.kind, actor.name, currentRunId(), nowSql()],
  );
}

/** The stored lifecycle of `id`, read inside `tx`. */
async function readClawsIssueLifecycle(tx: SqlDriver, id: string): Promise<string | null> {
  const row = await tx.get(`SELECT lifecycle FROM claws_issues WHERE id = ?`, [id]) as { lifecycle: string | null } | undefined;
  return row?.lifecycle ?? null;
}

/** Every recorded change to native issue `issueId`, oldest first. */
export async function listClawsIssueHistory(issueId: string): Promise<ClawsIssueHistoryRow[]> {
  return await getDb().all(
    `SELECT * FROM claws_issue_history WHERE issue_id = ? ORDER BY id ASC`,
    [issueId],
  ) as ClawsIssueHistoryRow[];
}

/**
 * Create a native issue and return its id.
 *
 * The id is minted in-process by `issue-id.ts` rather than read back out of
 * the table: a `MAX(id) + 1` allocation is a read-then-write race on Postgres
 * under READ COMMITTED, and there is no mutex to close it with.
 *
 * `kind` is written as `'issue'` explicitly rather than left to the column
 * default: this is the operator-facing create, and a shadow is only ever made
 * by {@link createShadowIssue}.
 */
export async function createClawsIssue(input: {
  title: string;
  body?: string;
  authorLogin: string;
  repos?: readonly string[];
  labels?: readonly string[];
  /** Defaults to `dashboard`. */
  source?: IssueSource;
  /** The per-issue promotion override; omitted follows the policy. */
  autoPromote?: boolean;
  /**
   * Whether the issue goes through the requirements stage; omitted defaults to
   * whether {@link source} is one of {@link HUMAN_ISSUE_SOURCES}.
   */
  requirementsStage?: boolean;
  /** The caller's dedupe key (docs/issue-tracker.md "Dedupe on create"). */
  dedupeKey?: string;
  /** Why the issue is Blocked: required when `labels` makes it Blocked, ignored otherwise. */
  blockedReason?: string;
  /**
   * The approval the issue is filed with — a pre-approval through Plan or
   * Merge, say — recorded as {@link approvedBy}'s; omitted or `none` files it
   * unapproved.
   */
  approvedThrough?: ApprovedThrough;
  /** Who the filing-time approval is recorded as; defaults to {@link authorLogin}. */
  approvedBy?: string;
  /** A repo pinned as the primary however the repos sort; must be one of `repos`. */
  primaryRepo?: string;
  /** Which alert path filed the issue; omitted when it is not an alert. */
  alertKind?: string;
}): Promise<string> {
  if (input.primaryRepo !== undefined && !(input.repos ?? []).includes(input.primaryRepo)) {
    throw new Error(`primary repo ${input.primaryRepo} is not one of the issue's repos`);
  }
  const now = nowSql();
  const id = newClawsIssueId();
  const { lifecycle, rest } = splitStateLabels(input.labels ?? []);
  const blockedReason = lifecycle === "blocked" ? requireBlockedReason(input.blockedReason) : null;
  const approvedThrough = input.approvedThrough ?? "none";
  const approved = approvedThrough !== "none";
  const source = input.source ?? "dashboard";
  const requirementsStage = input.requirementsStage ?? HUMAN_ISSUE_SOURCES.includes(source);
  await getDb().transaction(async (tx) => {
    await tx.run(
      `INSERT INTO claws_issues (id, title, body, author_login, state, state_reason, created_at, updated_at, closed_at, kind, lifecycle, stage_changed_at, source, auto_promote, requirements_stage, dedupe_key, blocked_reason, blocked_reason_at, approved_through, approved_through_by, approved_through_at, plan_approved_at, primary_repo, alert_kind)
       VALUES (?, ?, ?, ?, 'open', NULL, ?, ?, NULL, 'issue', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.title, input.body ?? "", input.authorLogin, now, now, lifecycle, now, source, autoPromoteParam(input.autoPromote), requirementsStage ? 1 : 0, input.dedupeKey ?? null, blockedReason, blockedReason === null ? null : now,
        approvedThrough, approved ? (input.approvedBy ?? input.authorLogin) : null, approved ? now : null, atLeast(approvedThrough, "plan") ? now : null, input.primaryRepo ?? null, input.alertKind ?? null],
    );
    if (approved) await recordIssueHistory(tx, id, "approved_through", "none", approvedThrough);
    for (const repo of new Set(input.repos ?? [])) {
      await tx.run(`INSERT OR IGNORE INTO claws_issue_repos (issue_id, repo) VALUES (?, ?)`, [id, repo]);
    }
    for (const label of rest) {
      await tx.run(`INSERT OR IGNORE INTO claws_issue_labels (issue_id, label) VALUES (?, ?)`, [id, label]);
    }
  });
  return id;
}

function autoPromoteParam(autoPromote: boolean | undefined): number | null {
  return autoPromote === undefined ? null : autoPromote ? 1 : 0;
}

/** A native issue with its repos and labels, or undefined when it does not exist. */
/** Whether a native issue exists — a cheap check that skips loading its sidecars. */
export async function clawsIssueExists(id: string): Promise<boolean> {
  return await getDb().get(`SELECT 1 AS one FROM claws_issues WHERE id = ?`, [id]) !== undefined;
}

export async function getClawsIssue(id: string): Promise<ClawsIssueRecord | undefined> {
  const row = await getDb().get(`SELECT * FROM claws_issues WHERE id = ?`, [id]) as ClawsIssueRow | undefined;
  if (!row) return undefined;
  return toClawsRecords([row], await loadIssueSidecars(`WHERE id = ?`, [id]))[0];
}

/**
 * A native issue's primary repo: its pinned `primary_repo` when that is one of
 * its repos, else the alphabetically first of its repos (by code point), else
 * `""` when it has none. The primary repo owns planning, labels and phase
 * sequencing; {@link primaryRepoSql} is the SQL twin.
 */
export function primaryRepoOf(issue: { readonly repos: readonly string[]; readonly primary_repo?: string | null }): string {
  if (issue.primary_repo && issue.repos.includes(issue.primary_repo)) return issue.primary_repo;
  return [...issue.repos].sort()[0] ?? "";
}

/**
 * A native issue's primary repo in SQL: the pinned `primary_repo` when it is
 * one of the issue's repos, else the alphabetically first of its repos, NULL
 * when it has none. Mirrors {@link primaryRepoOf}, so the fallback comparison
 * has to be by code point in both dialects: SQLite's `MIN` already is,
 * Postgres's follows the database collation unless told otherwise, and a
 * locale collation would pick a different primary for mixed-case names.
 */
function primaryRepoSql(): string {
  const collate = getDb().dialect === "postgres" ? ` COLLATE "C"` : "";
  return `COALESCE((SELECT r.repo FROM claws_issue_repos r WHERE r.issue_id = claws_issues.id AND r.repo = claws_issues.primary_repo), `
    + `(SELECT MIN(r.repo${collate}) FROM claws_issue_repos r WHERE r.issue_id = claws_issues.id))`;
}

/**
 * Open native issues, newest-updated first.
 *
 * `repo` filters to issues whose *primary* repo is that one — the
 * alphabetically first of its repos, which owns planning, labels and phase
 * sequencing. A multi-repo issue is therefore listed under exactly one repo,
 * so exactly one dispatcher acts on it. That primary-only match is the
 * dispatch rule and the default; `repoMatch: "any"` is the discovery rule,
 * matching an issue that names `repo` at all (board, API, repo page). `unassigned` is the issues with no
 * repo at all: visible on the list and the board but never through
 * `listOpenIssues`. Both are decided in SQL, so a tracker with thousands of
 * closed issues still costs one indexed scan.
 *
 * The two are mutually exclusive in the signature. Together they are the
 * unsatisfiable "primary repo is X and there are no repos", which would
 * return an empty list — a mistaken caller would read that as "no issues"
 * rather than as the mistake it is.
 *
 * Shadows are excluded here and in {@link listClosedClawsIssuesSince}, and
 * nowhere else: those two are what the façade unions, so one clause apiece
 * hides them from the dispatchers, `findIssueByExactTitle`, alert-issue dedup,
 * the board and `/issues` at once (#3246).
 */
export async function listOpenClawsIssues(
  filter: { label?: string; repoMatch?: "primary" | "any" } & ({ repo?: string; unassigned?: never } | { repo?: never; unassigned?: boolean }) = {},
): Promise<ClawsIssueRecord[]> {
  const clauses = [`state = 'open'`, `kind <> 'shadow'`];
  const params: unknown[] = [];
  if (filter.repo !== undefined) {
    clauses.push(filter.repoMatch === "any"
      ? `EXISTS (SELECT 1 FROM claws_issue_repos r WHERE r.issue_id = claws_issues.id AND r.repo = ?)`
      : `${primaryRepoSql()} = ?`);
    params.push(filter.repo);
  }
  if (filter.unassigned) clauses.push(`NOT EXISTS (SELECT 1 FROM claws_issue_repos r WHERE r.issue_id = claws_issues.id)`);
  if (filter.label !== undefined) {
    // A state label is the `lifecycle` field, not a label row.
    const lifecycle = lifecycleForLabel(filter.label);
    if (lifecycle !== undefined) {
      clauses.push(`lifecycle = ?`);
      params.push(lifecycle);
    } else {
      clauses.push(`EXISTS (SELECT 1 FROM claws_issue_labels l WHERE l.issue_id = claws_issues.id AND l.label = ?)`);
      params.push(filter.label);
    }
  }
  const tail = `WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC`;
  const rows = await getDb().all(`SELECT * FROM claws_issues ${tail}`, params) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(tail, params));
}

/**
 * Open native issues filed with dedupe key `key`, oldest first. A shadow never
 * carries a key, but is excluded anyway, as in {@link listOpenClawsIssues}.
 */
export async function listOpenClawsIssuesByDedupeKey(key: string): Promise<ClawsIssueRecord[]> {
  const params = [key];
  const tail = `WHERE state = 'open' AND kind <> 'shadow' AND dedupe_key = ? ORDER BY created_at ASC, id ASC`;
  const rows = await getDb().all(`SELECT * FROM claws_issues ${tail}`, params) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(tail, params));
}

/**
 * The newest open `kind = 'issue'` row in `repo`, its primary repo, holding no dedupe key and filed under exactly `title` —
 * `filed_title` when it has been renamed since, else its title. The issue
 * filer adopts it for a key on a lookup miss (docs/issue-tracker.md "Issue
 * filers"), so a report imported from the forge keeps its card.
 */
export async function findOpenUnkeyedIssueByFiledTitle(repo: string, title: string): Promise<ClawsIssueRecord | undefined> {
  const row = await getDb().get(
    `SELECT id FROM claws_issues
      WHERE state = 'open' AND kind = 'issue' AND dedupe_key IS NULL
        AND ${primaryRepoSql()} = ? AND COALESCE(filed_title, title) = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [repo, title],
  ) as { id: string } | undefined;
  return row ? await getClawsIssue(String(row.id)) : undefined;
}

/**
 * Mark native issue `id` as an alert filed by `kind`, leaving an issue already
 * marked as it is. Returns whether the value changed.
 */
export async function setClawsIssueAlertKind(id: string, kind: string): Promise<boolean> {
  const res = await getDb().run(`UPDATE claws_issues SET alert_kind = ? WHERE id = ? AND alert_kind IS NULL AND kind <> 'shadow'`, [kind, id]);
  return res.changes > 0;
}

/**
 * Claim the one Slack line for alert issue `id`'s current Blocked stay:
 * stamps `alert_attention_notified_at` when the issue is an alert, Blocked
 * and not yet claimed. Returns whether this call claimed it, so however many
 * parks land on the same stay, only the first announces. Leaving Blocked
 * clears the stamp ({@link clearBacklogUntilOnExit}'s callers).
 */
export async function claimAlertAttention(id: string): Promise<boolean> {
  const res = await getDb().run(
    `UPDATE claws_issues SET alert_attention_notified_at = ?
      WHERE id = ? AND kind <> 'shadow' AND alert_kind IS NOT NULL AND lifecycle = 'blocked' AND alert_attention_notified_at IS NULL`,
    [nowSql(), id],
  );
  return res.changes > 0;
}

/**
 * Every open alert issue ({@link ClawsIssueRow.alert_kind} set), newest first,
 * for the dashboard's `/alerts` page. Never a shadow.
 */
export async function listOpenClawsAlerts(): Promise<ClawsIssueRecord[]> {
  const tail = `WHERE state = 'open' AND kind <> 'shadow' AND alert_kind IS NOT NULL ORDER BY created_at DESC, id DESC`;
  const rows = await getDb().all(`SELECT * FROM claws_issues ${tail}`, []) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(tail, []));
}

/**
 * Native issues filed with dedupe key `key` whose primary repo is `repo`,
 * closed at or after `since`, newest-closed first. Never a shadow.
 */
export async function listClosedClawsIssuesByDedupeKey(repo: string, key: string, since: Date): Promise<ClawsIssueRecord[]> {
  const cutoff = since.toISOString().slice(0, 19).replace("T", " ");
  const params = [key, cutoff, repo];
  const tail = `WHERE state = 'closed' AND kind <> 'shadow' AND dedupe_key = ? AND closed_at IS NOT NULL AND closed_at >= ?
      AND ${primaryRepoSql()} = ? ORDER BY closed_at DESC, id DESC`;
  const rows = await getDb().all(`SELECT * FROM claws_issues ${tail}`, params) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(tail, params));
}

/**
 * Set a native issue's dedupe key. Returns false, writing nothing, when the
 * issue does not exist, is a shadow, or another open issue with the same
 * primary repo already holds `key` — a key names one open issue per repo.
 */
export async function setClawsIssueDedupeKey(id: string, key: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const issue = await tx.get(
      `SELECT ${primaryRepoSql()} AS repo FROM claws_issues WHERE id = ? AND kind <> 'shadow'`,
      [id],
    ) as { repo: string | null } | undefined;
    if (!issue) return false;
    const holder = await tx.get(
      `SELECT id FROM claws_issues WHERE state = 'open' AND kind <> 'shadow' AND dedupe_key = ? AND id <> ?
         AND ${issue.repo === null ? `NOT EXISTS (SELECT 1 FROM claws_issue_repos r WHERE r.issue_id = claws_issues.id)` : `${primaryRepoSql()} = ?`}`,
      issue.repo === null ? [key, id] : [key, id, issue.repo],
    ) as { id: string } | undefined;
    if (holder) return false;
    const res = await tx.run(`UPDATE claws_issues SET dedupe_key = ?, updated_at = ? WHERE id = ? AND kind <> 'shadow'`, [key, nowSql(), id]);
    return res.changes > 0;
  });
}

/**
 * Native issues in any state, for the session/agent search behind
 * `claws_list_issues`. `state` picks open, closed or both; `repo` matches an
 * issue naming that repo at all (the `repoMatch: "any"` rule); `titleContains`
 * is a case-insensitive substring; `closedSince` / `updatedSince` are
 * inclusive lower bounds. Newest-updated first in every mode so paging is
 * stable across states. Shadows are never returned.
 */
export async function listClawsIssues(filter: {
  state: "open" | "closed" | "all";
  repo?: string;
  titleContains?: string;
  closedSince?: Date;
  updatedSince?: Date;
  limit: number;
  offset?: number;
}): Promise<ClawsIssueRecord[]> {
  const clauses = [`kind <> 'shadow'`];
  const params: unknown[] = [];
  const cutoff = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
  if (filter.state !== "all") {
    clauses.push(`state = ?`);
    params.push(filter.state);
  }
  if (filter.repo !== undefined) {
    clauses.push(`EXISTS (SELECT 1 FROM claws_issue_repos r WHERE r.issue_id = claws_issues.id AND r.repo = ?)`);
    params.push(filter.repo);
  }
  if (filter.titleContains) {
    clauses.push(`LOWER(title) LIKE ? ESCAPE '\\'`);
    params.push(`%${filter.titleContains.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  if (filter.closedSince) {
    clauses.push(`closed_at IS NOT NULL AND closed_at >= ?`);
    params.push(cutoff(filter.closedSince));
  }
  if (filter.updatedSince) {
    clauses.push(`updated_at >= ?`);
    params.push(cutoff(filter.updatedSince));
  }
  const where = `WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC`;
  const rows = await getDb().all(
    `SELECT * FROM claws_issues ${where} LIMIT ? OFFSET ?`,
    [...params, filter.limit, filter.offset ?? 0],
  ) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(`${where} LIMIT ? OFFSET ?`, [...params, filter.limit, filter.offset ?? 0]));
}

/** The subset of `issueIds` that has at least one stored plan, in one query. */
export async function listIssueIdsWithPlans(issueIds: readonly string[]): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();
  const placeholders = issueIds.map(() => "?").join(",");
  const rows = await getDb().all(
    `SELECT DISTINCT issue_id FROM claws_issue_plans WHERE issue_id IN (${placeholders})`,
    [...issueIds],
  ) as { issue_id: string }[];
  return new Set(rows.map((r) => String(r.issue_id)));
}

/**
 * The bodies, from each of `issueIds`' own body and its live (not
 * soft-deleted) comments, that contain a `claws-duplicate-of:` marker. One
 * query for the batch.
 */
export async function listDuplicateMarkerBodies(issueIds: readonly string[]): Promise<{ issue_id: string; body: string }[]> {
  if (issueIds.length === 0) return [];
  const placeholders = issueIds.map(() => "?").join(",");
  const rows = await getDb().all(
    `SELECT id AS issue_id, body FROM claws_issues
      WHERE id IN (${placeholders}) AND body LIKE '%claws-duplicate-of:%'
     UNION ALL
     SELECT issue_id, body FROM claws_issue_comments
      WHERE issue_id IN (${placeholders}) AND deleted_at IS NULL AND body LIKE '%claws-duplicate-of:%'`,
    [...issueIds, ...issueIds],
  ) as { issue_id: string; body: string }[];
  return rows.map((r) => ({ issue_id: String(r.issue_id), body: r.body }));
}

/**
 * Native issues closed at or after `since`, newest-closed first.
 *
 * `repo` and `limit` are pushed into SQL rather than applied by the caller,
 * for the same reason {@link listOpenClawsIssues} does it: the façade asks per
 * repo on every poll cycle, and the closed set only ever grows. `repo` matches
 * the open reader's rule — the issue's *primary* repo is that one — and, like the
 * open reader, this one never returns a shadow.
 */
export async function listClosedClawsIssuesSince(
  since: Date,
  filter: { repo?: string; limit?: number } = {},
): Promise<ClawsIssueRecord[]> {
  const cutoff = since.toISOString().slice(0, 19).replace("T", " ");
  const clauses = [`state = 'closed'`, `kind <> 'shadow'`, `closed_at IS NOT NULL`, `closed_at >= ?`];
  const params: unknown[] = [cutoff];
  if (filter.repo !== undefined) {
    clauses.push(`${primaryRepoSql()} = ?`);
    params.push(filter.repo);
  }
  let tail = `WHERE ${clauses.join(" AND ")} ORDER BY closed_at DESC, id DESC`;
  if (filter.limit !== undefined) {
    tail += ` LIMIT ?`;
    params.push(filter.limit);
  }
  const rows = await getDb().all(`SELECT * FROM claws_issues ${tail}`, params) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(tail, params));
}

/** Replace a native issue's title. Returns false when the issue does not exist or is a shadow. */
export async function updateClawsIssueTitle(id: string, title: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const old = await tx.get(`SELECT title FROM claws_issues WHERE id = ? AND kind <> 'shadow'`, [id]) as { title: string } | undefined;
    const res = await tx.run(`UPDATE claws_issues SET filed_title = COALESCE(filed_title, title), title = ?, updated_at = ? WHERE id = ? AND kind <> 'shadow'`, [title, nowSql(), id]);
    if (res.changes > 0 && old) await recordIssueHistory(tx, id, "title", old.title, title);
    return res.changes > 0;
  });
}

/** Replace a native issue's body. Returns false when the issue does not exist or is a shadow. */
export async function updateClawsIssueBody(id: string, body: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const old = await tx.get(`SELECT body FROM claws_issues WHERE id = ? AND kind <> 'shadow'`, [id]) as { body: string | null } | undefined;
    const res = await tx.run(`UPDATE claws_issues SET body = ?, updated_at = ? WHERE id = ? AND kind <> 'shadow'`, [body, nowSql(), id]);
    if (res.changes > 0 && old) await recordIssueHistory(tx, id, "body", old.body ?? "", body);
    return res.changes > 0;
  });
}

/**
 * Open or close a native issue; `closed_at` is cleared on reopen.
 *
 * Guarded with `AND state <> ?` so a repeat close changes zero rows. Callers
 * use that to emit `issue-closed` exactly once — two jobs racing to close the
 * same issue must not produce two events.
 *
 * The guard is on `state` alone, so re-closing an already-closed issue with a
 * *different* `stateReason` returns false and leaves the original reason in
 * place: the first close wins. Reopen and close again to change it.
 *
 * `kind <> 'shadow'` is the second guard: a shadow's state follows its forge
 * issue through {@link updateShadowIssue} and nothing else may move it.
 */
export async function setClawsIssueState(
  id: string,
  state: "open" | "closed",
  stateReason?: "completed" | "not_planned" | null,
): Promise<boolean> {
  const now = nowSql();
  const reason = state === "closed" ? (stateReason ?? null) : null;
  return await getDb().transaction(async (tx) => {
    const old = await tx.get(`SELECT state, state_reason FROM claws_issues WHERE id = ? AND kind <> 'shadow'`, [id]) as { state: string; state_reason: string | null } | undefined;
    const res = await tx.run(
      `UPDATE claws_issues SET state = ?, state_reason = ?, closed_at = ?, updated_at = ?, stage_changed_at = ? WHERE id = ? AND state <> ? AND kind <> 'shadow'`,
      [state, reason, state === "closed" ? now : null, now, now, id, state],
    );
    if (res.changes > 0 && old) await recordIssueHistory(tx, id, "state", historyStateValue(old.state, old.state_reason), historyStateValue(state, reason));
    return res.changes > 0;
  });
}

/** An issue's state as its History shows it: `open`, or `closed (reason)`. */
function historyStateValue(state: string, reason: string | null): string {
  return state === "closed" && reason ? `closed (${reason})` : state;
}

/**
 * Add a label. Returns false when the issue already carried it.
 *
 * A state label (`Blocked` / `Backlog`) sets the `lifecycle` field
 * instead, replacing whichever state the issue held: the field is
 * single-valued, so adding `Backlog` to a Blocked issue leaves it in
 * `Backlog` alone. A retired gate label (`Refined`, `Automerge`, …) is
 * refused: approval is {@link setClawsIssueApprovedThrough}'s. `Blocked` throws {@link BlockedReasonRequiredError}: a
 * move to Blocked must carry a reason, so it goes through
 * {@link blockClawsIssue}.
 */
export async function addClawsIssueLabel(id: string, label: string): Promise<boolean> {
  if (lifecycleForLabel(label) === "blocked") throw new BlockedReasonRequiredError();
  if ((RETIRED_GATE_LABELS as readonly string[]).includes(label)) {
    throw new Error(`claws-issues: ${label} is not a label any more — set the issue's approval instead`);
  }
  return await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, id);
    const lifecycle = lifecycleForLabel(label);
    if (lifecycle !== undefined) {
      const now = nowSql();
      const before = await readClawsIssueLifecycle(tx, id);
      const set = await tx.run(
        `UPDATE claws_issues SET lifecycle = ?, updated_at = ?, stage_changed_at = ? WHERE id = ? AND lifecycle <> ?`,
        [lifecycle, now, now, id, lifecycle],
      );
      if (set.changes > 0) {
        await recordIssueHistory(tx, id, "lifecycle", before, lifecycle);
        await clearBacklogUntilOnExit(tx, id);
      }
      return set.changes > 0;
    }
    const res = await tx.run(`INSERT OR IGNORE INTO claws_issue_labels (issue_id, label) VALUES (?, ?)`, [id, label]);
    if (res.changes > 0) {
      await touchClawsIssueForLabel(tx, id);
      await recordIssueHistory(tx, id, "label", null, label);
    }
    return res.changes > 0;
  });
}

/** Bump `updated_at` after a plain label row was added or removed. */
async function touchClawsIssueForLabel(tx: SqlDriver, id: string): Promise<void> {
  await tx.run(`UPDATE claws_issues SET updated_at = ? WHERE id = ?`, [nowSql(), id]);
}

/**
 * Remove a label. Returns false when the issue did not carry it.
 *
 * A state label moves the `lifecycle` field back to where the issue enters the
 * board, but only when the field holds that state — removing `Blocked` from a
 * Backlog issue leaves it in the Backlog, as removing an absent label row
 * always did. It goes to `planning` when it has a plan or approved
 * requirements and to `ideas` otherwise, as `clawsIssues.entryLifecycle`
 * decides.
 */
export async function removeClawsIssueLabel(id: string, label: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, id);
    const lifecycle = lifecycleForLabel(label);
    if (lifecycle !== undefined) {
      const now = nowSql();
      const reset = await tx.run(
        `UPDATE claws_issues SET lifecycle = ${ENTRY_LIFECYCLE_SQL}, updated_at = ?, stage_changed_at = ? WHERE id = ? AND lifecycle = ?`,
        [now, now, id, lifecycle],
      );
      if (reset.changes > 0) {
        await recordIssueHistory(tx, id, "lifecycle", lifecycle, await readClawsIssueLifecycle(tx, id));
        await clearBacklogUntilOnExit(tx, id);
      }
      return reset.changes > 0;
    }
    const res = await tx.run(`DELETE FROM claws_issue_labels WHERE issue_id = ? AND label = ?`, [id, label]);
    if (res.changes > 0) {
      await touchClawsIssueForLabel(tx, id);
      await recordIssueHistory(tx, id, "label", label, null);
    }
    return res.changes > 0;
  });
}

/**
 * Where an issue re-enters the board, in SQL over the `claws_issues` row:
 * `planning` once it has a plan or approved requirements, `ideas` otherwise.
 * Mirrors `clawsIssues.entryLifecycle`.
 */
const ENTRY_LIFECYCLE_SQL = `CASE WHEN requirements_approved_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM claws_issue_plans p WHERE p.issue_id = claws_issues.id)
  THEN 'planning' ELSE 'ideas' END`;

/**
 * Promote an issue to `planning`: record that `approvedBy` approved
 * requirements `version` (NULL when there is no record yet), and, when
 * `title` is given and differs, rename the issue to it and keep the title it
 * was filed under in `filed_title` (only the first rename sets it). Unlike the
 * label writes this covers a shadow too — a forge issue is promoted through
 * its shadow, whose `lifecycle` the dispatcher reads — though a shadow is
 * never renamed: the sync job would write the forge title straight back.
 *
 * Guarded by `input.expectedLifecycle`, a compare-and-swap on the lifecycle
 * the caller already read rather than a fixed allow-list: a human move can
 * promote out of Blocked, Approved or Awaiting plan review, not just Ideas,
 * while a promotion racing a concurrent move to some other column still
 * loses. Returns false when there is no such issue or it lost that race.
 */
export async function promoteClawsIssue(id: string, input: { version: number | null; approvedBy: string; title?: string; expectedLifecycle: IssueLifecycle }): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const row = await tx.get(
      `SELECT title, kind, approved_requirements_version, approved_through FROM claws_issues WHERE id = ? AND lifecycle = ?`,
      [id, input.expectedLifecycle],
    ) as { title: string; kind: string; approved_requirements_version: number | null; approved_through: string } | undefined;
    if (!row) return false;
    const now = nowSql();
    const rename = row.kind !== "shadow" && input.title !== undefined && input.title.trim() !== "" && input.title !== row.title;
    // Approving the requirements approves the issue through Requirements; a
    // higher pre-approval (through Plan or Merge) stands.
    const raise = !atLeast(row.approved_through, "requirements");
    const res = await tx.run(
      `UPDATE claws_issues
          SET approved_requirements_version = ?, requirements_approved_by = ?, requirements_approved_at = ?,
              lifecycle = 'planning', updated_at = ?,
              stage_changed_at = CASE WHEN lifecycle = 'planning' THEN stage_changed_at ELSE ? END${rename ? `, filed_title = COALESCE(filed_title, title), title = ?` : ""}${raise ? `, approved_through = 'requirements', approved_through_by = ?, approved_through_at = ?` : ""}
        WHERE id = ? AND lifecycle = ?`,
      [input.version, input.approvedBy, now, now, now, ...(rename ? [input.title] : []), ...(raise ? [input.approvedBy, now] : []), id, input.expectedLifecycle],
    );
    if (res.changes > 0 && row.kind === "issue") {
      await recordIssueHistory(tx, id, "lifecycle", input.expectedLifecycle, "planning");
      if (raise) await recordIssueHistory(tx, id, "approved_through", row.approved_through, "requirements");
      if (rename) await recordIssueHistory(tx, id, "title", row.title, input.title ?? null);
      await recordIssueHistory(tx, id, "requirements approved", requirementsVersionLabel(row.approved_requirements_version), requirementsVersionLabel(input.version));
      await clearBacklogUntilOnExit(tx, id);
    }
    return res.changes > 0;
  });
}

/**
 * Send an issue back to `ideas`: clear the approval fields and leave its
 * requirements versions, and its title, as they are. Also sets `auto_promote`
 * to 0 — a human (or a board drag) sent it back on purpose, so the
 * level-triggered check in the issue dispatcher must not promote it straight
 * back out from under them. Covers a shadow too. Returns false when there is
 * no such issue.
 */
export async function demoteClawsIssue(id: string): Promise<boolean> {
  const now = nowSql();
  return await getDb().transaction(async (tx) => {
    const old = await tx.get(`SELECT lifecycle, kind, approved_through FROM claws_issues WHERE id = ?`, [id]) as { lifecycle: string | null; kind: string; approved_through: string } | undefined;
    // Back in Ideas nothing is approved: the approval goes with the requirements'.
    const result = await tx.run(
      `UPDATE claws_issues
          SET approved_requirements_version = NULL, requirements_approved_by = NULL, requirements_approved_at = NULL,
              auto_promote = 0,
              approved_through = 'none', approved_through_at = CASE WHEN approved_through = 'none' THEN approved_through_at ELSE ? END,
              approved_through_by = CASE WHEN approved_through = 'none' THEN approved_through_by ELSE ? END,
              plan_approved_at = NULL,
              lifecycle = 'ideas', updated_at = ?, stage_changed_at = CASE WHEN lifecycle = 'ideas' THEN stage_changed_at ELSE ? END
        WHERE id = ?`,
      [now, currentIssueActor().name, now, now, id],
    );
    if (Number(result.changes) > 0 && old?.kind === "issue") {
      await recordIssueHistory(tx, id, "lifecycle", old.lifecycle, "ideas");
      await recordIssueHistory(tx, id, "approved_through", old.approved_through, "none");
      await clearBacklogUntilOnExit(tx, id);
    }
    return Number(result.changes) > 0;
  });
}

/**
 * Set a native issue's lifecycle state. Returns false when it already held
 * `lifecycle`; throws for a missing issue or a shadow, like the label writes.
 * Throws {@link BlockedReasonRequiredError} for `blocked` — use
 * {@link blockClawsIssue}, which records the reason in the same write.
 */
export async function setClawsIssueLifecycle(id: string, lifecycle: IssueLifecycle): Promise<boolean> {
  if (lifecycle === "blocked") throw new BlockedReasonRequiredError();
  return await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, id);
    const now = nowSql();
    const before = await readClawsIssueLifecycle(tx, id);
    const res = await tx.run(
      `UPDATE claws_issues SET lifecycle = ?, updated_at = ?, stage_changed_at = ? WHERE id = ? AND lifecycle <> ?`,
      [lifecycle, now, now, id, lifecycle],
    );
    if (res.changes > 0) {
      await recordIssueHistory(tx, id, "lifecycle", before, lifecycle);
      await clearBacklogUntilOnExit(tx, id);
    }
    return res.changes > 0;
  });
}

/**
 * A refused move to Blocked: every issue entering Blocked must carry a
 * non-empty reason (docs/product/dashboard-and-integrations.md).
 */
export class BlockedReasonRequiredError extends Error {
  constructor() {
    super("A reason is required to mark an issue Blocked");
    this.name = "BlockedReasonRequiredError";
  }
}

/** `reason` trimmed, or throws {@link BlockedReasonRequiredError} when it is missing or blank. */
function requireBlockedReason(reason: string | null | undefined): string {
  const trimmed = (reason ?? "").trim();
  if (trimmed === "") throw new BlockedReasonRequiredError();
  return trimmed;
}

/**
 * Move native issue `id` to Blocked and record `reason` in one transaction,
 * with both History rows, so a refused move leaves nothing behind and the
 * reason is never older than the stage. Throws
 * {@link BlockedReasonRequiredError} for a blank reason before any write, and
 * throws for a missing issue or a shadow like the label writes. An issue
 * already Blocked keeps its stage and takes the new reason. Returns whether
 * the lifecycle changed.
 */
export async function blockClawsIssue(id: string, reason: string): Promise<boolean> {
  const trimmed = requireBlockedReason(reason);
  return await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, id);
    const old = await tx.get(`SELECT lifecycle, blocked_reason FROM claws_issues WHERE id = ?`, [id]) as { lifecycle: string; blocked_reason: string | null };
    const changed = old.lifecycle !== "blocked";
    const now = nowSql();
    await tx.run(
      `UPDATE claws_issues SET lifecycle = 'blocked', updated_at = ?, stage_changed_at = CASE WHEN lifecycle = 'blocked' THEN stage_changed_at ELSE ? END, blocked_reason = ?, blocked_reason_at = ? WHERE id = ?`,
      [now, now, trimmed, now, id],
    );
    if (changed) await recordIssueHistory(tx, id, "lifecycle", old.lifecycle, "blocked");
    await recordIssueHistory(tx, id, "blocked_reason", old.blocked_reason, trimmed);
    if (changed) await clearBacklogUntilOnExit(tx, id);
    return changed;
  });
}

/**
 * Clear `id`'s Backlog return date once its lifecycle is no longer
 * `backlog`, recording the cleared date in History. Every native lifecycle
 * write calls it in its own transaction, so an issue moved out of the Backlog
 * before its date leaves nothing for the dispatcher's sweep to act on, and a
 * later plain move back into the Backlog carries no stale date.
 */
async function clearBacklogUntilOnExit(tx: SqlDriver, id: string): Promise<void> {
  // Leaving Blocked also re-arms an alert's stall announcement ({@link claimAlertAttention}).
  await tx.run(`UPDATE claws_issues SET alert_attention_notified_at = NULL WHERE id = ? AND lifecycle <> 'blocked' AND alert_attention_notified_at IS NOT NULL`, [id]);
  const row = await tx.get(
    `SELECT backlog_until, kind FROM claws_issues WHERE id = ? AND lifecycle <> 'backlog' AND backlog_until IS NOT NULL`,
    [id],
  ) as { backlog_until: string; kind: string } | undefined;
  if (!row) return;
  await tx.run(`UPDATE claws_issues SET backlog_until = NULL, backlog_until_at = NULL WHERE id = ?`, [id]);
  if (row.kind === "issue") await recordIssueHistory(tx, id, "backlog_until", row.backlog_until, null);
}

/**
 * Set a shadow's lifecycle state without touching its approval fields — the
 * plain-write counterpart to {@link promoteClawsIssue} for a forge issue
 * moving between columns that carry no requirements approval of their own
 * (Awaiting plan review, Blocked, Backlog) — its plan and merge approval is
 * {@link setClawsIssueApprovedThrough}'s. {@link setClawsIssueLifecycle} throws
 * for a shadow, since every other native-issue write is meant to refuse one;
 * a forge issue's stage has nowhere else to live, so this is the one write
 * that accepts it. Returns false when there is no such shadow or it already
 * held `lifecycle`.
 */
export async function setShadowLifecycle(id: string, lifecycle: IssueLifecycle): Promise<boolean> {
  const now = nowSql();
  const res = await getDb().run(
    `UPDATE claws_issues SET lifecycle = ?, updated_at = ?, stage_changed_at = ? WHERE id = ? AND kind = 'shadow' AND lifecycle <> ?`,
    [lifecycle, now, now, id, lifecycle],
  );
  return res.changes > 0;
}

/**
 * Set how far issue `id` — a native issue or a forge issue's shadow — is
 * approved (`issue-approval.ts`), recording `by` as who set it.
 * Compare-and-set: returns false, writing nothing, when it already held
 * `through` or there is no such row. Records History on a native issue,
 * bumps `updated_at`, and bumps `stage_changed_at` only when the issue sits
 * in `awaiting-plan-review` and the value crosses `plan` — the one change
 * that moves its card between Awaiting plan review and Approved. Sets
 * `plan_approved_at` when the value rises through `plan` and clears it when
 * it drops below.
 *
 * The raw write: the PR rows, comments and promotion that go with a change
 * are `issue-approval-write.ts`'s `applyIssueApproval`, which every other
 * write goes through. The column is also written directly by issue creation
 * (`createClawsIssue`), the requirements-approval raise
 * (`promoteClawsIssue` / `approveClawsIssueRequirements`), the send-back to
 * Ideas (`demoteClawsIssue`), the boot migration
 * (`migrateGateLabelsToApprovedThrough`), and `reapproval.ts`'s settle
 * step, which calls this raw because the approval writer would re-enter it.
 */
export async function setClawsIssueApprovedThrough(id: string, through: ApprovedThrough, by: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const old = await tx.get(
      `SELECT kind, lifecycle, approved_through FROM claws_issues WHERE id = ?`,
      [id],
    ) as { kind: string; lifecycle: string; approved_through: string } | undefined;
    if (!old || old.approved_through === through) return false;
    const now = nowSql();
    const planChanged = atLeast(old.approved_through, "plan") !== atLeast(through, "plan");
    const crossesPlan = old.lifecycle === "awaiting-plan-review" && planChanged;
    const res = await tx.run(
      `UPDATE claws_issues SET approved_through = ?, approved_through_by = ?, approved_through_at = ?, updated_at = ?${crossesPlan ? ", stage_changed_at = ?" : ""}${planChanged ? ", plan_approved_at = ?" : ""}
        WHERE id = ? AND approved_through = ?`,
      [through, by, now, now, ...(crossesPlan ? [now] : []), ...(planChanged ? [atLeast(through, "plan") ? now : null] : []), id, old.approved_through],
    );
    if (res.changes > 0 && old.kind === "issue") await recordIssueHistory(tx, id, "approved_through", old.approved_through, through);
    return res.changes > 0;
  });
}

/** Replace a native issue's repo associations wholesale. */
export async function setClawsIssueRepos(id: string, repos: readonly string[]): Promise<void> {
  await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, id);
    const before = await tx.all(`SELECT repo FROM claws_issue_repos WHERE issue_id = ?`, [id]) as { repo: string }[];
    await tx.run(`DELETE FROM claws_issue_repos WHERE issue_id = ?`, [id]);
    for (const repo of new Set(repos)) {
      await tx.run(`INSERT OR IGNORE INTO claws_issue_repos (issue_id, repo) VALUES (?, ?)`, [id, repo]);
    }
    await tx.run(`UPDATE claws_issues SET updated_at = ? WHERE id = ?`, [nowSql(), id]);
    const list = (names: Iterable<string>) => [...new Set(names)].sort().join(", ");
    await recordIssueHistory(tx, id, "repos", list(before.map((r) => r.repo)), list(repos));
  });
}

/**
 * Pin a native issue's primary repo ({@link primaryRepoOf}), so adding a repo
 * that sorts earlier does not take over planning and labels. `repo` should be
 * one of the issue's repos; an unlisted pin is ignored by the readers.
 */
export async function setClawsIssuePrimaryRepo(id: string, repo: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, id);
    await tx.run(`UPDATE claws_issues SET primary_repo = ?, updated_at = ? WHERE id = ?`, [repo, nowSql(), id]);
  });
}

/** Append a comment and return its id. */
export async function addClawsIssueComment(issueId: string, authorLogin: string, body: string): Promise<string> {
  const now = nowSql();
  const id = newClawsCommentId();
  await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, issueId);
    await tx.run(
      `INSERT INTO claws_issue_comments (id, issue_id, author_login, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, issueId, authorLogin, body, now, now],
    );
    await tx.run(`UPDATE claws_issues SET updated_at = ? WHERE id = ?`, [now, issueId]);
    await recordPlanVersion(tx, issueId, id, body, now);
  });
  return id;
}

/** Replace a comment's body. Returns the owning issue id, or undefined when the comment is gone. */
export async function editClawsIssueComment(commentId: string, body: string): Promise<string | undefined> {
  const now = nowSql();
  return await getDb().transaction(async (tx) => {
    const row = await tx.get(`SELECT issue_id FROM claws_issue_comments WHERE id = ?`, [commentId]) as { issue_id: string } | undefined;
    if (!row) return undefined;
    await tx.run(`UPDATE claws_issue_comments SET body = ?, updated_at = ? WHERE id = ?`, [body, now, commentId]);
    await tx.run(`UPDATE claws_issues SET updated_at = ? WHERE id = ? AND kind <> 'shadow'`, [now, row.issue_id]);
    await recordPlanVersion(tx, row.issue_id, commentId, body, now);
    return row.issue_id;
  });
}

/** One stored version of a native issue's plan: normalised text, see {@link recordPlanVersion}. */
export interface ClawsIssuePlanRow {
  issue_id: string;
  version: number;
  /** The plan comment the version came from; NULL once that comment is deleted. */
  comment_id: string | null;
  body: string;
  created_at: string;
}

/**
 * Record a new plan version when `body` is a Claws plan comment whose
 * normalised text differs from the issue's latest version. A marker-only
 * re-stamp normalises to the same text and records nothing.
 *
 * `latest + 1` is read-then-write, which is safe because plan writes for one
 * issue are serialised by the refiner's per-item lock and Claws runs a single
 * pod; a collision would fail on the primary key rather than corrupt history.
 */
async function recordPlanVersion(tx: SqlDriver, issueId: string, commentId: string, body: string, now: string): Promise<void> {
  if (!isPlanComment(body)) return;
  const text = normalizePlanText(body);
  const latest = await tx.get(
    `SELECT version, body FROM claws_issue_plans WHERE issue_id = ? ORDER BY version DESC LIMIT 1`,
    [issueId],
  ) as { version: number; body: string } | undefined;
  if (latest && latest.body === text) return;
  await tx.run(
    `INSERT INTO claws_issue_plans (issue_id, version, comment_id, body, created_at) VALUES (?, ?, ?, ?, ?)`,
    [issueId, (latest ? Number(latest.version) : 0) + 1, commentId, text, now],
  );
}

/**
 * Seed plan history from the plan comments of issues that have none yet, one
 * version per distinct plan comment in posting order. Idempotent: an issue
 * with any plan row is skipped, so a re-run is a no-op. The history of an
 * edited-in-place plan before this table existed is gone; only each comment's
 * current text is recoverable.
 */
export async function backfillClawsIssuePlans(): Promise<void> {
  const rows = await getDb().all(
    `SELECT c.id, c.issue_id, c.body, c.updated_at FROM claws_issue_comments c
     WHERE c.body LIKE '%## Implementation Plan%'
       AND c.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM claws_issue_plans p WHERE p.issue_id = c.issue_id)
     ORDER BY c.issue_id, c.id`,
  ) as Array<{ id: string; issue_id: string; body: string; updated_at: string }>;
  if (rows.length === 0) return;
  await getDb().transaction(async (tx) => {
    for (const row of rows) await recordPlanVersion(tx, row.issue_id, row.id, row.body, row.updated_at);
  });
}

/** Every stored version of a native issue's plan, oldest first. */
export async function listClawsIssuePlans(issueId: string): Promise<ClawsIssuePlanRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_issue_plans WHERE issue_id = ? ORDER BY version ASC`,
    [issueId],
  ) as ClawsIssuePlanRow[];
  return rows.map((r) => ({ ...r, version: Number(r.version) }));
}

/**
 * The latest plan version of every open native issue, keyed by issue id.
 * Shadows are excluded — they carry no comments. A join rather than an id
 * list, so there is no bind-parameter limit to hit.
 */
export async function listLatestClawsIssuePlansForOpenIssues(): Promise<Map<string, ClawsIssuePlanRow>> {
  const rows = await getDb().all(
    `SELECT p.* FROM claws_issue_plans p
     JOIN claws_issues i ON i.id = p.issue_id
     JOIN (SELECT issue_id, MAX(version) AS version FROM claws_issue_plans GROUP BY issue_id) m
       ON m.issue_id = p.issue_id AND m.version = p.version
     WHERE i.state = 'open' AND i.kind <> 'shadow'`,
  ) as ClawsIssuePlanRow[];
  return new Map(rows.map((r) => [r.issue_id, { ...r, version: Number(r.version) }]));
}

/** One stored version of an issue's requirements record; the list columns parsed. */
export interface ClawsIssueRequirementsRow {
  issue_id: string;
  version: number;
  title: string;
  kind: RequirementsRecord["kind"];
  context: string;
  requirement: string;
  acceptance_criteria: string[];
  out_of_scope: string[];
  /** The `## Requirements` comment the version was rendered into — native or forge. */
  comment_id: string | null;
  created_at: string;
}

function parseStringList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function toRequirementsRow(row: Record<string, unknown>): ClawsIssueRequirementsRow {
  return {
    issue_id: String(row.issue_id),
    version: Number(row.version),
    title: String(row.title),
    kind: row.kind === "bug" ? "bug" : "feature",
    context: String(row.context),
    requirement: String(row.requirement),
    acceptance_criteria: parseStringList(row.acceptance_criteria),
    out_of_scope: parseStringList(row.out_of_scope),
    comment_id: row.comment_id == null ? null : String(row.comment_id),
    created_at: String(row.created_at),
  };
}

/**
 * Record a new version of an issue's requirements record and return its
 * number — the latest stored version + 1. `issueId` is the tracker id: a
 * native issue's own id, or a forge issue's shadow. The same read-then-write
 * as {@link recordPlanVersion}, safe for the same reason: writer runs for one
 * issue are serialised by the work queue's per-item lock, and a collision
 * fails on the primary key rather than corrupting history.
 *
 * Once the version is stored the listener set with
 * {@link setRequirementsVersionListener} runs — `claws-issues.ts`'s
 * auto-promotion. It runs here, where the write lands, so an agent pod's
 * remote call reaches it through the ops API exactly as an in-process
 * writer's direct call does.
 */
export async function addClawsIssueRequirementsVersion(
  issueId: string,
  record: RequirementsRecord,
  commentId: string | null,
  opts?: { notify?: boolean },
): Promise<number> {
  const version = await insertClawsIssueRequirementsVersion(issueId, record, commentId);
  if (opts?.notify === false) return version;
  try {
    await requirementsVersionListener?.(issueId, version);
  } catch (err) {
    // The version is stored either way; a failed promotion is left for a human.
    log.warn(`[db] Requirements v${version} of ${issueId}: listener failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return version;
}

let requirementsVersionListener: ((issueId: string, version: number) => Promise<void>) | undefined;

/**
 * Register what runs after {@link addClawsIssueRequirementsVersion} stores a
 * version. A setter rather than an import: `claws-issues.ts`, which owns
 * promotion, sits above this module.
 */
export function setRequirementsVersionListener(listener: ((issueId: string, version: number) => Promise<void>) | undefined): void {
  requirementsVersionListener = listener;
}

async function insertClawsIssueRequirementsVersion(issueId: string, record: RequirementsRecord, commentId: string | null): Promise<number> {
  const now = nowSql();
  return await getDb().transaction(async (tx) => {
    const latest = await tx.get(
      `SELECT MAX(version) AS version FROM claws_issue_requirements WHERE issue_id = ?`,
      [issueId],
    ) as { version: number | null } | undefined;
    const version = (latest?.version == null ? 0 : Number(latest.version)) + 1;
    await tx.run(
      `INSERT INTO claws_issue_requirements (issue_id, version, title, kind, context, requirement, acceptance_criteria, out_of_scope, comment_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [issueId, version, record.title, record.kind, record.context, record.requirement,
        JSON.stringify(record.acceptanceCriteria), JSON.stringify(record.outOfScope), commentId, now],
    );
    if (await isNativeIssueRow(tx, issueId)) await recordIssueHistory(tx, issueId, "requirements", null, `v${version} stored`);
    return version;
  });
}

/** Every stored version of an issue's requirements record, oldest first. */
export async function listClawsIssueRequirements(issueId: string): Promise<ClawsIssueRequirementsRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_issue_requirements WHERE issue_id = ? ORDER BY version ASC`,
    [issueId],
  ) as Array<Record<string, unknown>>;
  return rows.map(toRequirementsRow);
}

/**
 * The latest requirements version of every open issue, keyed by tracker id —
 * the dispatcher's once-per-tick read. Unlike
 * {@link listLatestClawsIssuePlansForOpenIssues} this includes shadows: the
 * writer records a forge issue's versions against its shadow row.
 */
export async function listLatestClawsIssueRequirementsForOpenIssues(): Promise<Map<string, ClawsIssueRequirementsRow>> {
  const rows = await getDb().all(
    `SELECT r.* FROM claws_issue_requirements r
     JOIN claws_issues i ON i.id = r.issue_id
     JOIN (SELECT issue_id, MAX(version) AS version FROM claws_issue_requirements GROUP BY issue_id) m
       ON m.issue_id = r.issue_id AND m.version = r.version
     WHERE i.state = 'open'`,
  ) as Array<Record<string, unknown>>;
  return new Map(rows.map((r) => {
    const row = toRequirementsRow(r);
    return [row.issue_id, row];
  }));
}

/**
 * The comments that may be feedback on the latest requirements version of an
 * open issue in `ideas` — the board's once-per-render read for telling
 * Drafting from Requirements review (`claws-issues.ts`'s
 * `getRequirementsFeedbackPending`). Already narrowed here to comments posted
 * at or after the latest version, not by `clawsLogin` or a `[bot]` login, and
 * not 👍'd by `clawsLogin` (feedback a refine run already addressed). Bodies
 * ride along so the caller can drop Claws-marked and `## Requirements` ones.
 */
export async function listClawsIssueCommentsForOpenIdeasIssues(clawsLogin: string): Promise<Array<Pick<ClawsIssueCommentRow, "issue_id" | "author_login" | "body" | "created_at">>> {
  return await getDb().all(
    `SELECT c.issue_id, c.author_login, c.body, c.created_at
     FROM claws_issue_comments c
     JOIN claws_issues i ON i.id = c.issue_id
     JOIN (SELECT issue_id, MAX(created_at) AS created_at FROM claws_issue_requirements GROUP BY issue_id) r
       ON r.issue_id = c.issue_id
     WHERE i.state = 'open' AND i.lifecycle = 'ideas'
       AND c.deleted_at IS NULL
       AND c.created_at >= r.created_at
       AND c.author_login <> ? AND c.author_login NOT LIKE '%[bot]'
       AND NOT EXISTS (SELECT 1 FROM claws_issue_comment_reactions x
                       WHERE x.comment_id = c.id AND x.login = ? AND x.content = '+1')
     ORDER BY c.id ASC`,
    [clawsLogin, clawsLogin],
  ) as Array<Pick<ClawsIssueCommentRow, "issue_id" | "author_login" | "body" | "created_at">>;
}

/** A requirements row plus who approved it — {@link listApprovedClawsIssueRequirementsForOpenIssues}'s shape. */
export interface ClawsIssueApprovedRequirementsRow extends ClawsIssueRequirementsRow {
  approved_by: string | null;
  approved_at: string | null;
}

/**
 * The approved requirements version of every open issue that has one, keyed
 * by tracker id — a dispatcher tick's batched read, so it does not run
 * `getClawsIssue` + `listClawsIssueRequirements` once per issue (see
 * `approvedRequirementsFromBatch` in approved-requirements.ts).
 */
export async function listApprovedClawsIssueRequirementsForOpenIssues(): Promise<Map<string, ClawsIssueApprovedRequirementsRow>> {
  const rows = await getDb().all(
    `SELECT r.*, i.requirements_approved_by AS approved_by, i.requirements_approved_at AS approved_at
     FROM claws_issue_requirements r
     JOIN claws_issues i ON i.id = r.issue_id AND i.approved_requirements_version = r.version
     WHERE i.state = 'open'`,
  ) as Array<Record<string, unknown>>;
  return new Map(rows.map((r) => {
    const row = toRequirementsRow(r);
    const approved: ClawsIssueApprovedRequirementsRow = {
      ...row,
      approved_by: r.approved_by == null ? null : String(r.approved_by),
      approved_at: r.approved_at == null ? null : String(r.approved_at),
    };
    return [row.issue_id, approved];
  }));
}

/**
 * Record that `approvedBy` approved requirements `version` of an issue (NULL
 * when it was promoted with no record yet). Returns false when no such issue
 * exists.
 */
export async function approveClawsIssueRequirements(issueId: string, version: number | null, approvedBy: string): Promise<boolean> {
  const now = nowSql();
  return await getDb().transaction(async (tx) => {
    const old = await tx.get(
      `SELECT kind, approved_requirements_version, approved_through FROM claws_issues WHERE id = ?`,
      [issueId],
    ) as { kind: string; approved_requirements_version: number | null; approved_through: string } | undefined;
    // Approved requirements mean approved through Requirements at least, as on promotion.
    const raise = !!old && !atLeast(old.approved_through, "requirements");
    const result = await tx.run(
      `UPDATE claws_issues SET approved_requirements_version = ?, requirements_approved_by = ?, requirements_approved_at = ?, updated_at = ?${raise ? ", approved_through = 'requirements', approved_through_by = ?, approved_through_at = ?" : ""} WHERE id = ?`,
      [version, approvedBy, now, now, ...(raise ? [approvedBy, now] : []), issueId],
    );
    if (result.changes > 0 && old?.kind === "issue") {
      await recordIssueHistory(tx, issueId, "requirements approved", requirementsVersionLabel(old.approved_requirements_version), requirementsVersionLabel(version));
      if (raise) await recordIssueHistory(tx, issueId, "approved_through", old.approved_through, "requirements");
    }
    return result.changes > 0;
  });
}

/** How History shows an approved requirements version: `v<N>`, or `none` for a promotion with no record. */
function requirementsVersionLabel(version: number | null | undefined): string {
  return version == null ? "none" : `v${Number(version)}`;
}

/**
 * A native issue's comments in posting order, soft-deleted ones left out.
 *
 * `ORDER BY id` is exact, not approximate: comment ids are monotonic ULIDs, so
 * their lexical order is their creation order.
 */
export async function listClawsIssueComments(issueId: string): Promise<ClawsIssueCommentRow[]> {
  return await getDb().all(
    `SELECT * FROM claws_issue_comments WHERE issue_id = ? AND deleted_at IS NULL ORDER BY id ASC`,
    [issueId],
  ) as ClawsIssueCommentRow[];
}

/** How much of a deleted comment's body its History entry keeps. */
const DELETED_COMMENT_EXCERPT_MAX = 200;

/**
 * Soft-delete the live comments of `issueId` named in `commentIds`, stamping
 * `deleted_at` and `deleted_by` rather than removing the rows
 * (docs/issue-tracker.md#deleting-comments). Ids that are not live comments
 * of this issue are skipped. A native issue gets one `comment` History entry
 * per deleted comment — `<id> by <author>: <excerpt>` → NULL. Deliberately
 * leaves `claws_issues.updated_at` alone: a deletion is not activity and must
 * not look like feedback. Returns how many comments it deleted.
 */
export async function softDeleteClawsIssueComments(issueId: string, commentIds: readonly string[], deletedBy: string): Promise<number> {
  const ids = [...new Set(commentIds)];
  if (ids.length === 0) return 0;
  const now = nowSql();
  const inList = ids.map(() => "?").join(", ");
  return await getDb().transaction(async (tx) => {
    const rows = await tx.all(
      `SELECT id, author_login, body FROM claws_issue_comments
       WHERE issue_id = ? AND id IN (${inList}) AND deleted_at IS NULL ORDER BY id ASC`,
      [issueId, ...ids],
    ) as Array<Pick<ClawsIssueCommentRow, "id" | "author_login" | "body">>;
    if (rows.length === 0) return 0;
    const result = await tx.run(
      `UPDATE claws_issue_comments SET deleted_at = ?, deleted_by = ?
       WHERE issue_id = ? AND id IN (${rows.map(() => "?").join(", ")}) AND deleted_at IS NULL`,
      [now, deletedBy, issueId, ...rows.map((r) => r.id)],
    );
    if (await isNativeIssueRow(tx, issueId)) {
      for (const row of rows) {
        const text = row.body.trim().replace(/\s+/g, " ");
        const excerpt = text.length > DELETED_COMMENT_EXCERPT_MAX ? `${text.slice(0, DELETED_COMMENT_EXCERPT_MAX)}…` : text;
        await recordIssueHistory(tx, issueId, "comment", `${row.id} by ${row.author_login}: ${excerpt}`, null);
      }
    }
    return Number(result.changes);
  });
}

/**
 * Record a reaction. Re-reacting with the same content is a no-op.
 *
 * Bumps the owning issue's `updated_at` like every other write here: a
 * reaction is how `issue-refiner` marks feedback addressed, so an issue whose
 * only change this cycle was a reaction must not keep a stale timestamp and
 * sort wrongly in {@link listOpenClawsIssues}'s `ORDER BY updated_at DESC`.
 */
export async function addClawsIssueCommentReaction(commentId: string, login: string, content: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const parent = await tx.get(`SELECT issue_id FROM claws_issue_comments WHERE id = ?`, [commentId]) as { issue_id: string } | undefined;
    if (!parent) throw new Error(`claws-issues: no native comment ${commentId}`);
    const res = await tx.run(
      `INSERT OR IGNORE INTO claws_issue_comment_reactions (comment_id, login, content) VALUES (?, ?, ?)`,
      [commentId, login, content],
    );
    if (res.changes > 0) await tx.run(`UPDATE claws_issues SET updated_at = ? WHERE id = ? AND kind <> 'shadow'`, [nowSql(), parent.issue_id]);
  });
}

/** Every reaction on a comment. */
export async function listClawsIssueCommentReactions(commentId: string): Promise<ClawsIssueReactionRow[]> {
  return await getDb().all(
    `SELECT comment_id, login, content FROM claws_issue_comment_reactions WHERE comment_id = ? ORDER BY login ASC, content ASC`,
    [commentId],
  ) as ClawsIssueReactionRow[];
}

// ── Attachments (#3289) ──
//
// Rows only: `issue-attachments.ts` owns the files (on disk or in S3) and is
// the only caller, so a row and its file are always written and removed together.

/** Where an attachment's bytes live: the local store or the attachments S3 bucket. */
export type AttachmentStorage = "fs" | "s3";

export interface ClawsIssueAttachmentRow {
  id: string;
  /** NULL while the upload is pending on an unsaved New Issue form. */
  issue_id: string | null;
  /** The comment whose body links the file, once one does. */
  comment_id: string | null;
  /** The original filename, sanitised. */
  filename: string;
  /** Relative to WORK_DIR when `storage` is `fs`; the object key when it is `s3`. */
  stored_path: string;
  content_type: string;
  size: number;
  uploader_login: string;
  created_at: string;
  /** Absent (a row built by an older writer) means `fs`. */
  storage?: AttachmentStorage;
}

/** Normalise a row read back from either driver — Postgres may widen `size` to a string. */
function toAttachmentRow(row: ClawsIssueAttachmentRow): ClawsIssueAttachmentRow {
  return { ...row, size: Number(row.size) };
}

/** Record a stored file and return its new id. */
export async function insertClawsIssueAttachment(input: {
  /** Pre-minted id, for an S3 object whose key embeds it; minted here when absent. */
  id?: string;
  issueId: string | null;
  filename: string;
  storedPath: string;
  contentType: string;
  size: number;
  uploaderLogin: string;
  storage?: AttachmentStorage;
}): Promise<ClawsIssueAttachmentRow> {
  const row: ClawsIssueAttachmentRow = {
    id: input.id ?? newClawsAttachmentId(),
    issue_id: input.issueId,
    comment_id: null,
    filename: input.filename,
    stored_path: input.storedPath,
    content_type: input.contentType,
    size: input.size,
    uploader_login: input.uploaderLogin,
    created_at: nowSql(),
    storage: input.storage ?? "fs",
  };
  await getDb().run(
    `INSERT INTO claws_issue_attachments (id, issue_id, comment_id, filename, stored_path, content_type, size, uploader_login, created_at, storage)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.issue_id, row.filename, row.stored_path, row.content_type, row.size, row.uploader_login, row.created_at, row.storage],
  );
  return row;
}

export async function getClawsIssueAttachment(id: string): Promise<ClawsIssueAttachmentRow | undefined> {
  const row = await getDb().get(`SELECT * FROM claws_issue_attachments WHERE id = ?`, [id]) as ClawsIssueAttachmentRow | undefined;
  return row ? toAttachmentRow(row) : undefined;
}

/**
 * How to read an attachment's bytes when they are not on this process's disk,
 * or null when they are. The service reads its own store; `db-remote.ts`
 * overrides this in an agent pod, whose HOME has no `issue-attachments/`.
 */
export function remoteAttachmentReader(): ((attachmentId: string, signal?: AbortSignal) => Promise<Response>) | null {
  return null;
}

/** An issue's attachments in upload order — ids are monotonic ULIDs. */
export async function listClawsIssueAttachments(issueId: string): Promise<ClawsIssueAttachmentRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_issue_attachments WHERE issue_id = ? ORDER BY id ASC`,
    [issueId],
  ) as ClawsIssueAttachmentRow[];
  return rows.map(toAttachmentRow);
}

/**
 * Assign pending rows to `issueId` and return the rows claimed. A row that
 * already belongs to an issue is left alone, so a hand-edited form cannot move
 * another issue's file.
 */
export async function claimPendingClawsIssueAttachments(ids: readonly string[], issueId: string): Promise<ClawsIssueAttachmentRow[]> {
  const claimed: ClawsIssueAttachmentRow[] = [];
  await getDb().transaction(async (tx) => {
    for (const id of new Set(ids)) {
      const res = await tx.run(`UPDATE claws_issue_attachments SET issue_id = ? WHERE id = ? AND issue_id IS NULL`, [issueId, id]);
      if (res.changes === 0) continue;
      const row = await tx.get(`SELECT * FROM claws_issue_attachments WHERE id = ?`, [id]) as ClawsIssueAttachmentRow | undefined;
      if (row) claimed.push(toAttachmentRow(row));
    }
  });
  return claimed;
}

/** Point a row at a new file location — the pending-to-issue move. */
export async function setClawsIssueAttachmentStoredPath(id: string, storedPath: string): Promise<void> {
  await getDb().run(`UPDATE claws_issue_attachments SET stored_path = ? WHERE id = ?`, [storedPath, id]);
}

/** Move a row to another store — the filesystem-to-S3 migration. */
export async function setClawsIssueAttachmentStorage(id: string, storage: AttachmentStorage, storedPath: string): Promise<void> {
  await getDb().run(`UPDATE claws_issue_attachments SET storage = ?, stored_path = ? WHERE id = ?`, [storage, storedPath, id]);
}

/** Every row whose bytes live in `storage`, oldest first. */
export async function listAttachmentsByStorage(storage: AttachmentStorage): Promise<ClawsIssueAttachmentRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_issue_attachments WHERE storage = ? ORDER BY id ASC`,
    [storage],
  ) as ClawsIssueAttachmentRow[];
  return rows.map(toAttachmentRow);
}

export async function setClawsIssueAttachmentComment(id: string, commentId: string): Promise<void> {
  await getDb().run(`UPDATE claws_issue_attachments SET comment_id = ? WHERE id = ?`, [commentId, id]);
}

/** Remove a row. Returns false when it was already gone. */
export async function deleteClawsIssueAttachment(id: string): Promise<boolean> {
  return (await getDb().run(`DELETE FROM claws_issue_attachments WHERE id = ?`, [id])).changes > 0;
}

/** Pending rows created before `cutoff` (a stored `YYYY-MM-DD HH:MM:SS` UTC time). */
export async function listPendingClawsIssueAttachmentsOlderThan(cutoff: string): Promise<ClawsIssueAttachmentRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_issue_attachments WHERE issue_id IS NULL AND created_at < ? ORDER BY id ASC`,
    [cutoff],
  ) as ClawsIssueAttachmentRow[];
  return rows.map(toAttachmentRow);
}

// ── Published session files ──
//
// Rows only: `session-files.ts` owns the files on disk and is the only caller,
// so a row and its file are always written and removed together.

export interface SessionFileRow {
  id: string;
  session_id: string;
  /** The published name, sanitised. */
  filename: string;
  /** Relative to WORK_DIR. */
  stored_path: string;
  content_type: string;
  size: number;
  created_at: string;
}

/** Record a published file and return its row. */
export async function insertSessionFile(input: {
  sessionId: string;
  filename: string;
  storedPath: string;
  contentType: string;
  size: number;
}): Promise<SessionFileRow> {
  const row: SessionFileRow = {
    id: newClawsSessionFileId(),
    session_id: input.sessionId,
    filename: input.filename,
    stored_path: input.storedPath,
    content_type: input.contentType,
    size: input.size,
    created_at: nowSql(),
  };
  await getDb().run(
    `INSERT INTO session_files (id, session_id, filename, stored_path, content_type, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.session_id, row.filename, row.stored_path, row.content_type, row.size, row.created_at],
  );
  return row;
}

export async function getSessionFile(id: string): Promise<SessionFileRow | undefined> {
  const row = await getDb().get(`SELECT * FROM session_files WHERE id = ?`, [id]) as SessionFileRow | undefined;
  return row ? { ...row, size: Number(row.size) } : undefined;
}

/** A session's published files in publish order — ids are monotonic ULIDs. */
export async function listSessionFiles(sessionId: string): Promise<SessionFileRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM session_files WHERE session_id = ? ORDER BY id ASC`,
    [sessionId],
  ) as SessionFileRow[];
  return rows.map((row) => ({ ...row, size: Number(row.size) }));
}

/** Remove every row for a session; returns how many went. */
export async function deleteSessionFilesForSession(sessionId: string): Promise<number> {
  return (await getDb().run(`DELETE FROM session_files WHERE session_id = ?`, [sessionId])).changes;
}

// ── Session attachments (files staged for a new session's first message) ──
//
// Rows only: `session-attachments.ts` owns the bytes and is the only caller.

export interface SessionAttachmentRow {
  id: string;
  /** NULL while pending: staged on the form, not yet claimed by a create. */
  session_id: string | null;
  /** The uploaded name, sanitised. */
  filename: string;
  /** The file's name in the pod's uploads directory, fixed when claimed. */
  pod_name: string | null;
  /** Relative to WORK_DIR for `fs`; the bucket key for `s3`. */
  stored_path: string;
  storage: AttachmentStorage;
  content_type: string;
  size: number;
  created_at: string;
}

function toSessionAttachmentRow(row: SessionAttachmentRow): SessionAttachmentRow {
  return { ...row, size: Number(row.size) };
}

/** Record a staged (pending) attachment and return its row. */
export async function insertSessionAttachment(input: {
  id: string;
  filename: string;
  storedPath: string;
  storage: AttachmentStorage;
  contentType: string;
  size: number;
}): Promise<SessionAttachmentRow> {
  const row: SessionAttachmentRow = {
    id: input.id,
    session_id: null,
    filename: input.filename,
    pod_name: null,
    stored_path: input.storedPath,
    storage: input.storage,
    content_type: input.contentType,
    size: input.size,
    created_at: nowSql(),
  };
  await getDb().run(
    `INSERT INTO session_attachments (id, session_id, filename, pod_name, stored_path, storage, content_type, size, created_at)
     VALUES (?, NULL, ?, NULL, ?, ?, ?, ?, ?)`,
    [row.id, row.filename, row.stored_path, row.storage, row.content_type, row.size, row.created_at],
  );
  return row;
}

export async function getSessionAttachment(id: string): Promise<SessionAttachmentRow | undefined> {
  const row = await getDb().get(`SELECT * FROM session_attachments WHERE id = ?`, [id]) as SessionAttachmentRow | undefined;
  return row ? toSessionAttachmentRow(row) : undefined;
}

/** A session's attachments in staging order — ids are monotonic ULIDs. */
export async function listSessionAttachments(sessionId: string): Promise<SessionAttachmentRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM session_attachments WHERE session_id = ? ORDER BY id ASC`,
    [sessionId],
  ) as SessionAttachmentRow[];
  return rows.map(toSessionAttachmentRow);
}

/**
 * Claim pending rows for a session, each with its pod name: a row is claimed
 * only while its `session_id` is still NULL, so one staged file can never go
 * to two sessions. Returns the rows claimed, in the order given.
 */
export async function claimPendingSessionAttachments(
  claims: ReadonlyArray<{ id: string; podName: string }>,
  sessionId: string,
): Promise<SessionAttachmentRow[]> {
  const claimed: SessionAttachmentRow[] = [];
  await getDb().transaction(async (tx) => {
    for (const { id, podName } of claims) {
      const res = await tx.run(
        `UPDATE session_attachments SET session_id = ?, pod_name = ? WHERE id = ? AND session_id IS NULL`,
        [sessionId, podName, id],
      );
      if (res.changes === 0) continue;
      const row = await tx.get(`SELECT * FROM session_attachments WHERE id = ?`, [id]) as SessionAttachmentRow | undefined;
      if (row) claimed.push(toSessionAttachmentRow(row));
    }
  });
  return claimed;
}

/** Hand a session's claimed rows back to pending — a create that failed after claiming. */
export async function releaseSessionAttachments(sessionId: string): Promise<number> {
  return (await getDb().run(
    `UPDATE session_attachments SET session_id = NULL, pod_name = NULL WHERE session_id = ?`,
    [sessionId],
  )).changes;
}

/** Pending rows created before `cutoff` (a stored `YYYY-MM-DD HH:MM:SS` UTC time). */
export async function listPendingSessionAttachmentsOlderThan(cutoff: string): Promise<SessionAttachmentRow[]> {
  const rows = await getDb().all(
    `SELECT * FROM session_attachments WHERE session_id IS NULL AND created_at < ? ORDER BY id ASC`,
    [cutoff],
  ) as SessionAttachmentRow[];
  return rows.map(toSessionAttachmentRow);
}

export async function deleteSessionAttachmentRow(id: string): Promise<void> {
  await getDb().run(`DELETE FROM session_attachments WHERE id = ?`, [id]);
}

/** Remove every row for a session; returns how many went. */
export async function deleteSessionAttachmentsForSession(sessionId: string): Promise<number> {
  return (await getDb().run(`DELETE FROM session_attachments WHERE session_id = ?`, [sessionId])).changes;
}

// ── Links: typed relationships between tracker issues (docs/issue-tracker.md#links) ──

/** A stored link kind. `blocks` is an input spelling only: stored as `depends_on` with the ends swapped. */
export type ClawsIssueLinkKind = "depends_on" | "relates_to";

export interface ClawsIssueLinkRow {
  id: string;
  source_id: string;
  target_id: string;
  kind: ClawsIssueLinkKind;
  created_by: string;
  created_at: string;
  released_at: string | null;
}

/** A link as seen from one of its ends, with the other end's title and state. */
export interface ClawsIssueLinkWithOther extends ClawsIssueLinkRow {
  other_id: string;
  other_title: string;
  other_state: string;
  other_state_reason: string | null;
  other_lifecycle: IssueLifecycle;
  other_kind: string;
}

/**
 * Record a link and return it, or the existing row when the same link is
 * already recorded. Both ends must exist; `actingId` — the issue the link was
 * added from — must also be a live native issue rather than a shadow, the same
 * rule every other by-id write keeps. The other end may be a shadow: that is
 * how a native issue depends on a forge one.
 *
 * `released` stores the link as already released — a dependency
 * on an issue that is closed when the link is made has nothing to unpark.
 */
export async function createClawsIssueLink(input: {
  sourceId: string;
  targetId: string;
  kind: ClawsIssueLinkKind;
  createdBy: string;
  actingId: string;
  released?: boolean;
}): Promise<{ link: ClawsIssueLinkRow; created: boolean }> {
  const now = nowSql();
  return await getDb().transaction(async (tx) => {
    await requireClawsIssue(tx, input.actingId);
    for (const id of [input.sourceId, input.targetId]) {
      if (!(await tx.get(`SELECT 1 AS present FROM claws_issues WHERE id = ?`, [id]))) {
        throw new Error(`claws-issues: no native issue ${id}`);
      }
    }
    const id = newClawsLinkId();
    const res = await tx.run(
      `INSERT OR IGNORE INTO claws_issue_links (id, source_id, target_id, kind, created_by, created_at, released_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.sourceId, input.targetId, input.kind, input.createdBy, now, input.released ? now : null],
    );
    const row = await tx.get(
      `SELECT * FROM claws_issue_links WHERE source_id = ? AND target_id = ? AND kind = ?`,
      [input.sourceId, input.targetId, input.kind],
    ) as ClawsIssueLinkRow;
    if (res.changes > 0 && await isNativeIssueRow(tx, input.sourceId)) {
      await recordIssueHistory(tx, input.sourceId, "link", null, `${input.kind} ${input.targetId}`);
    }
    return { link: row, created: res.changes > 0 };
  });
}

export async function getClawsIssueLink(id: string): Promise<ClawsIssueLinkRow | undefined> {
  return await getDb().get(`SELECT * FROM claws_issue_links WHERE id = ?`, [id]) as ClawsIssueLinkRow | undefined;
}

/** Remove a link. Returns false when it was already gone. */
export async function deleteClawsIssueLink(id: string): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const link = await tx.get(`SELECT source_id, target_id, kind FROM claws_issue_links WHERE id = ?`, [id]) as { source_id: string; target_id: string; kind: string } | undefined;
    const res = await tx.run(`DELETE FROM claws_issue_links WHERE id = ?`, [id]);
    if (res.changes > 0 && link && await isNativeIssueRow(tx, link.source_id)) {
      await recordIssueHistory(tx, link.source_id, "link", `${link.kind} ${link.target_id}`, null);
    }
    return res.changes > 0;
  });
}

/** True when `id` is a native issue rather than a shadow — the rows History is kept for. */
async function isNativeIssueRow(tx: SqlDriver, id: string): Promise<boolean> {
  const row = await tx.get(`SELECT kind FROM claws_issues WHERE id = ?`, [id]) as { kind: string } | undefined;
  return row?.kind === "issue";
}

/** Every link with `issueId` at either end, oldest first, joined with the other end. */
export async function listClawsIssueLinks(issueId: string): Promise<ClawsIssueLinkWithOther[]> {
  return await getDb().all(
    `SELECT l.*, o.id AS other_id, o.title AS other_title, o.state AS other_state,
            o.state_reason AS other_state_reason, o.lifecycle AS other_lifecycle, o.kind AS other_kind
       FROM claws_issue_links l
       JOIN claws_issues o ON o.id = CASE WHEN l.source_id = ? THEN l.target_id ELSE l.source_id END
      WHERE l.source_id = ? OR l.target_id = ?
      ORDER BY l.id ASC`,
    [issueId, issueId, issueId],
  ) as ClawsIssueLinkWithOther[];
}

/**
 * The issues `issueId` depends on that are still open — what the dispatcher's
 * implementer gate reads. A released link still counts: its target has
 * reopened since it fired, and reopened work is still unfinished.
 */
export async function listOpenDependencyTargets(issueId: string): Promise<{ id: string; title: string }[]> {
  return await getDb().all(
    `SELECT t.id, t.title FROM claws_issue_links l JOIN claws_issues t ON t.id = l.target_id
      WHERE l.source_id = ? AND l.kind = 'depends_on' AND t.state = 'open'
      ORDER BY l.id ASC`,
    [issueId],
  ) as { id: string; title: string }[];
}

/**
 * For each of `issueIds`, every issue it depends on through a `depends_on`
 * link the dispatcher's sweep has not released yet, oldest link first, with
 * whether that issue is still open. An id with no such link is absent. One
 * query for the whole batch, for the board's Queued column.
 */
export async function listUnreleasedDependencyTargets(
  issueIds: readonly string[],
): Promise<Map<string, { id: string; title: string; open: boolean }[]>> {
  const result = new Map<string, { id: string; title: string; open: boolean }[]>();
  if (issueIds.length === 0) return result;
  const placeholders = issueIds.map(() => "?").join(",");
  const rows = await getDb().all(
    `SELECT l.source_id, t.id, t.title, t.state FROM claws_issue_links l JOIN claws_issues t ON t.id = l.target_id
      WHERE l.source_id IN (${placeholders}) AND l.kind = 'depends_on' AND l.released_at IS NULL
      ORDER BY l.id ASC`,
    [...issueIds],
  ) as { source_id: string; id: string; title: string; state: string }[];
  for (const row of rows) {
    const source = String(row.source_id);
    const list = result.get(source) ?? [];
    list.push({ id: String(row.id), title: row.title, open: row.state === "open" });
    result.set(source, list);
  }
  return result;
}

/**
 * Open native issues whose primary repo is `repo`, parked as Blocked, with at
 * least one unreleased `depends_on` link and none still pointing at an open
 * issue — the ones the dispatcher's sweep unparks.
 */
export async function listDependencyReleasableIssues(repo: string): Promise<ClawsIssueRecord[]> {
  const tail = `WHERE state = 'open' AND kind = 'issue' AND lifecycle = 'blocked' AND ${primaryRepoSql()} = ?
      AND EXISTS (SELECT 1 FROM claws_issue_links l WHERE l.source_id = claws_issues.id AND l.kind = 'depends_on' AND l.released_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM claws_issue_links l JOIN claws_issues t ON t.id = l.target_id
                       WHERE l.source_id = claws_issues.id AND l.kind = 'depends_on' AND l.released_at IS NULL AND t.state = 'open')
      ORDER BY id ASC`;
  const rows = await getDb().all(`SELECT * FROM claws_issues ${tail}`, [repo]) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(tail, [repo]));
}

/**
 * True when `itemNumber` in `repo` has a queued or running `issue-refiner:*`
 * work_queue row — planner work still in flight for it.
 *
 * The dependency sweep checks this before unparking: releasing while the
 * planner is mid-run would let it later post a blocked verdict and re-park
 * the issue with every dependency link already stamped released, which no
 * later sweep would ever pick up again.
 */
export async function hasPendingIssueRefinerWork(repo: string, itemNumber: IssueRef): Promise<boolean> {
  const row = await getDb().get(
    `SELECT 1 AS present FROM work_queue WHERE repo = ? AND item_number = ? AND kind LIKE 'issue-refiner:%' AND status IN ('queued', 'running') LIMIT 1`,
    [repo, refParam(itemNumber)],
  ) as { present: number } | undefined;
  return row !== undefined;
}

/** Stamp every unreleased `depends_on` link of `issueId` as released; returns the number stamped. */
export async function markClawsIssueLinksReleased(issueId: string): Promise<number> {
  return await getDb().transaction(async (tx) => {
    const targets = await tx.all(
      `SELECT target_id FROM claws_issue_links WHERE source_id = ? AND kind = 'depends_on' AND released_at IS NULL ORDER BY id ASC`,
      [issueId],
    ) as { target_id: string }[];
    const changes = (await tx.run(
      `UPDATE claws_issue_links SET released_at = ? WHERE source_id = ? AND kind = 'depends_on' AND released_at IS NULL`,
      [nowSql(), issueId],
    )).changes;
    if (changes > 0 && await isNativeIssueRow(tx, issueId)) {
      await recordIssueHistory(tx, issueId, "dependency released", null, targets.map((t) => t.target_id).join(", "));
    }
    return changes;
  });
}

// ── Shadows: the native backing record of a live forge issue (#3246) ──
//
// Every issue Claws works has a `claws_issues` row whichever forge it was
// filed on, so a column or table added to the native schema covers all of
// them. A shadow is linked to its forge issue through `imported_issues`, the
// same table an import uses; only `kind` says which of the two a linkage row
// describes. `jobs/issue-shadow-sync.ts` is what mints shadows and keeps them
// in step with the forge; these helpers are the only writers of such a row.
//
// A shadow is not a second operator-facing issue. It carries no comments, is
// hidden from the façade's union, and nothing here ever writes to the forge.
// The writes below go through `db.ts` directly rather than through
// `claws-issues.ts`, so no dashboard event is emitted for a row no page lists.

/** A shadow with its labels, repos and the forge issue it stands for. */
export interface ShadowIssueRecord extends ClawsIssueRecord {
  forgeNumber: IssueRef;
}

/**
 * Every shadow whose linkage row names `repo`, least-recently-checked first.
 *
 * The ordering is the sync job's: it confirms the state of shadows missing
 * from the forge listing under a per-run read cap, and taking the least
 * recently *checked* first is what stops a capped run from re-checking the
 * same few shadows forever. It orders on `shadow_checked_at` and not on
 * `updated_at` because a check that finds nothing changed writes no issue
 * columns at all — order on `updated_at` and a shadow whose state check never
 * changes anything (the forge read errors, say) would sit at the head of the
 * queue on every run and the rows behind it would never be reached.
 * `COALESCE` to `updated_at` for a shadow no run has checked yet, so a
 * just-minted one sorts as just-checked rather than as the most overdue row.
 *
 * The forge number comes from the joined linkage row rather than from a second
 * query keyed by `repo`: that query read the repo's entire import history to
 * decorate a handful of shadows, and the map it built needed a fallback for a
 * miss it could only paper over with a wrong forge number. The join is on
 * `imported_issues`' leading primary key column, so this still reads one
 * repository's linkage rows rather than walking every shadow on the fleet —
 * and the `IN` form of the same predicate is kept for
 * {@link loadIssueSidecars}, whose scope subquery selects from `claws_issues`
 * alone.
 */
export async function listShadowIssues(repo: string): Promise<ShadowIssueRecord[]> {
  const tail = `WHERE kind = 'shadow' AND id IN (SELECT native_id FROM imported_issues WHERE repo = ?)`;
  const params = [repo];
  const rows = await getDb().all(
    `SELECT c.*, i.forge_number FROM claws_issues c
       JOIN imported_issues i ON i.native_id = c.id AND i.repo = ?
      WHERE c.kind = 'shadow'
      ORDER BY COALESCE(c.shadow_checked_at, c.updated_at) ASC, c.id ASC`,
    params,
  ) as (ClawsIssueRow & { forge_number: unknown })[];
  if (rows.length === 0) return [];
  const sidecars = await loadIssueSidecars(tail, params);
  const records = toClawsRecords(rows.map(({ forge_number: _forgeNumber, ...issue }) => issue), sidecars);
  return records.map((record, i) => ({ ...record, forgeNumber: refFromColumn(rows[i]!.forge_number) }));
}

/**
 * Record that the sync job has examined `ids`, without touching `updated_at`.
 *
 * Called for every shadow a run looks at, whether the look changed anything,
 * found nothing to change, or failed — it is {@link listShadowIssues}'
 * fairness marker, and a check that is not recorded is a check that repeats
 * forever under the run's read cap. Rows that are not shadows are ignored
 * rather than reported: a shadow the importer promoted mid-run is no longer
 * this job's to track.
 */
export async function markShadowsChecked(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  await getDb().run(
    `UPDATE claws_issues SET shadow_checked_at = ? WHERE kind = 'shadow' AND id IN (${placeholders})`,
    [nowSql(), ...ids],
  );
}

/**
 * Create the shadow of `repo#forgeNumber`, or resolve the shadow that beat
 * this call to the linkage row. Undefined when that row names an *imported*
 * issue, which can never become a shadow.
 *
 * `issue-shadow-sync` calls this unconditionally for a forge issue with no
 * shadow of its own. `issue-importer` calls it too: for a forge issue with no
 * shadow yet, this *is* the importer's atomic create — the linkage row and the
 * `claws_issues` row commit in the same transaction the sync job uses, so it
 * is the linkage row's primary key, not the order the two jobs happen to run
 * in, that keeps them from ever producing a native issue nothing links to.
 *
 * The linkage row is written *first* inside the transaction, so its primary
 * key is what arbitrates a race between the two callers: when the forge issue
 * has been linked in the meantime the `INSERT OR IGNORE` changes nothing, the
 * transaction returns without inserting an issue row, and the id already
 * linked is resolved instead. Writing the issue row first and the linkage last
 * would leave an orphan `claws_issues` row behind that no reader ever lists
 * and no operator ever sees.
 *
 * But `(repo, forge_number)` is shared by imports and shadows and only `kind`
 * tells them apart, so "already linked" is not only the race — it is also the
 * permanent state of every issue this repo has ever imported. A forge issue a
 * human reopens after its import is back in the forge's open listing with a
 * linkage row naming a `kind = 'issue'` row, and handing that id back as
 * though it were a shadow would have the caller write to a row every
 * `updateShadowIssue` refuses, re-attempting the same pair every cycle with no
 * error and nothing logged. Hence `undefined` rather than an id: an
 * already-imported forge issue is something the caller has to decide about,
 * not something this can paper over. `created` distinguishes the two id cases
 * for the same reason — the shared key erases a distinction the caller needs.
 */
export async function createShadowIssue(
  repo: string,
  forgeNumber: IssueRef,
  input: { title: string; body?: string; authorLogin: string; labels?: readonly string[] },
): Promise<{ id: string; created: boolean } | undefined> {
  const now = nowSql();
  const id = newClawsIssueId();
  const { lifecycle, rest } = splitStateLabels(input.labels ?? []);
  const created = await getDb().transaction(async (tx) => {
    const link = await tx.run(
      `INSERT OR IGNORE INTO imported_issues (repo, forge_number, native_id) VALUES (?, ?, ?)`,
      [repo, refParam(forgeNumber), refParam(id)],
    );
    if (link.changes === 0) return false;
    await tx.run(
      `INSERT INTO claws_issues (id, title, body, author_login, state, state_reason, created_at, updated_at, closed_at, kind, lifecycle, source, requirements_stage)
       VALUES (?, ?, ?, ?, 'open', NULL, ?, ?, NULL, 'shadow', ?, 'forge', 1)`,
      [id, input.title, input.body ?? "", input.authorLogin, now, now, lifecycle],
    );
    await tx.run(`INSERT OR IGNORE INTO claws_issue_repos (issue_id, repo) VALUES (?, ?)`, [id, repo]);
    for (const label of rest) {
      await tx.run(`INSERT OR IGNORE INTO claws_issue_labels (issue_id, label) VALUES (?, ?)`, [id, label]);
    }
    return true;
  });
  if (created) return { id, created: true };
  // A linkage row naming an imported issue resolves to nothing rather than to
  // an id the caller would mistake for a shadow.
  const existing = await getDb().get(
    `SELECT i.native_id, c.kind FROM imported_issues i
       LEFT JOIN claws_issues c ON c.id = i.native_id
      WHERE i.repo = ? AND i.forge_number = ?`,
    [repo, refParam(forgeNumber)],
  ) as { native_id: string; kind: string | null } | undefined;
  // The linkage row that beat this transaction was deleted between the two
  // statements — nothing does that, and returning `id` would hand the caller
  // an id whose `claws_issues` row was never written, so every later
  // `updateShadowIssue` on it would return "not a shadow" forever and the sync
  // job would re-attempt it every cycle without ever noticing.
  if (!existing) throw new Error(`claws-issues: linkage row for ${repo}#${refParam(forgeNumber)} vanished while creating its shadow`);
  if (existing.kind !== "shadow") return undefined;
  return { id: String(existing.native_id), created: false };
}

/**
 * Every open shadow's id and lifecycle, keyed `repo \u0000 forge number` — the
 * board's one read for which forge cards sit in Planning rather than Ideas,
 * neither of which a forge label records, and for the tracker id their
 * requirements versions are keyed by. `hasPlannedPrs` says whether the shadow
 * has a stored PR list (`claws_issue_prs`), one of the board's cheap hints
 * that the forge issue has a plan. `approvedThrough` is the forge issue's
 * stored approval (`issue-approval.ts`), which its card's column and approval
 * track read.
 */
export async function listOpenShadowStages(): Promise<Map<string, { id: string; lifecycle: IssueLifecycle; approvedThrough: ApprovedThrough; hasPlannedPrs: boolean }>> {
  const rows = await getDb().all(
    `SELECT i.repo, i.forge_number, c.id, c.lifecycle, c.approved_through,
            EXISTS (SELECT 1 FROM claws_issue_prs p WHERE p.issue_id = c.id) AS has_prs
       FROM imported_issues i
       JOIN claws_issues c ON c.id = i.native_id
      WHERE c.kind = 'shadow' AND c.state = 'open'`,
  ) as Array<{ repo: string; forge_number: unknown; id: string; lifecycle: IssueLifecycle; approved_through: unknown; has_prs: unknown }>;
  return new Map(rows.map((r) => [`${r.repo}\u0000${String(refFromColumn(r.forge_number))}`, {
    id: String(r.id),
    lifecycle: r.lifecycle,
    approvedThrough: isApprovedThrough(r.approved_through) ? r.approved_through : "none",
    hasPlannedPrs: !!Number(r.has_prs),
  }]));
}

/**
 * Bring a shadow's title, body, labels and state in line with its forge issue.
 *
 * `"unchanged"` when the row already says exactly this: an alert-bridge issue
 * rewrites its body on every occurrence, so the sync job reaches this with an
 * unchanged issue most cycles, and an unconditional UPDATE would bump
 * `updated_at` fleet-wide every five minutes.
 *
 * `"not-a-shadow"` is a separate answer and not a second meaning for
 * `"unchanged"`, because the caller has to do the opposite thing with each:
 * an unchanged shadow stays in the sync job's working set and is checked again
 * next cycle, while a promoted one must be dropped from it immediately — the
 * promotion takes it out of {@link listShadowIssues}, but only on the *next*
 * listing, after this run has already tried to write it.
 *
 * `WHERE kind = 'shadow'` on the write, not just on the read, is what makes
 * this commute with `promoteShadowIssue`: a shadow the importer promoted
 * between the two changes zero rows rather than having the forge issue's text
 * written back over the imported one.
 *
 * `closed_at` is set on the close that first reports it and cleared on reopen;
 * an already-closed shadow whose body changed keeps its original close time.
 */
export async function updateShadowIssue(
  id: string,
  next: {
    title: string;
    body: string;
    labels: readonly string[];
    state: "open" | "closed";
    stateReason?: "completed" | "not_planned" | null;
  },
): Promise<"changed" | "unchanged" | "not-a-shadow"> {
  return await getDb().transaction(async (tx) => {
    const row = await tx.get(
      `SELECT title, body, state, state_reason, closed_at, lifecycle, stage_changed_at, requirements_approved_at FROM claws_issues WHERE id = ? AND kind = 'shadow'`,
      [id],
    ) as { title: string; body: string; state: string; state_reason: string | null; closed_at: string | null; lifecycle: string; stage_changed_at: string | null; requirements_approved_at: string | null } | undefined;
    if (!row) return "not-a-shadow";

    // Compared as sets, not as two sorted lists: `ORDER BY label` is binary in
    // SQLite and collation-dependent in Postgres, so a positional comparison
    // would report a spurious difference on one dialect and not the other.
    const currentLabels = new Set(
      (await tx.all(`SELECT label FROM claws_issue_labels WHERE issue_id = ?`, [id]) as { label: string }[]).map((l) => l.label),
    );
    // The forge's state labels are the `lifecycle` column here, not rows, so
    // they are compared against it rather than against the label rows — or
    // every shadow of a `Blocked` issue would read as changed on every sync.
    const split = splitStateLabels(next.labels);
    const rest = split.rest;
    const lifecycle = resolveStage(split.lifecycle, { lifecycle: row.lifecycle as IssueLifecycle, requirementsApprovedAt: row.requirements_approved_at });
    const wantedLabels = new Set(rest);
    const labelsDiffer = currentLabels.size !== wantedLabels.size || [...wantedLabels].some((l) => !currentLabels.has(l));

    const reason = next.state === "closed" ? (next.stateReason ?? null) : null;
    const same = !labelsDiffer
      && row.lifecycle === lifecycle
      && row.title === next.title
      && row.body === next.body
      && row.state === next.state
      && (row.state_reason ?? null) === reason;
    if (same) return "unchanged";

    const now = nowSql();
    const closedAt = next.state === "closed" ? (row.closed_at ?? now) : null;
    await tx.run(
      `UPDATE claws_issues SET title = ?, body = ?, state = ?, state_reason = ?, closed_at = ?, lifecycle = ?, updated_at = ?, stage_changed_at = ?
        WHERE id = ? AND kind = 'shadow'`,
      [next.title, next.body, next.state, reason, closedAt, lifecycle, now, row.lifecycle !== lifecycle ? now : row.stage_changed_at, id],
    );
    if (labelsDiffer) {
      await tx.run(`DELETE FROM claws_issue_labels WHERE issue_id = ?`, [id]);
      for (const label of wantedLabels) {
        await tx.run(`INSERT OR IGNORE INTO claws_issue_labels (issue_id, label) VALUES (?, ?)`, [id, label]);
      }
    }
    return "changed";
  });
}

/**
 * Promote a shadow into the live native issue `issue-importer` would otherwise
 * have created, in place.
 *
 * The id is kept, which is the whole point: anything already hanging off it —
 * the linkage row, the work-queue rows, a `Closes #clw_…` in a PR body —
 * carries over rather than being stranded on a row the importer abandons.
 *
 * The whole promotion — the columns, the labels and the `kind` flip — commits
 * as one transaction, so no reader ever sees a half-promoted row: the issue
 * becomes visible to the dispatchers already flagged `import_pending` when the
 * caller passes `opts.importPending`, so every dispatcher holds it until
 * {@link finishClawsIssueImport} clears the flag. It is
 * the atomicity that guarantees that and not the order of the statements, so
 * `kind` is set by the same UPDATE as the rest rather than by a later one.
 *
 * Every column `createClawsIssue` would have set is set here too, and for the
 * same reason: a promoted issue must be indistinguishable from a created one,
 * or the same forge issue imports differently depending on whether a shadow
 * happened to exist. Leaving the shadow's own values in place would mean an
 * `issue-refiner` plan re-stamped against `title` going stale the moment the
 * forge title was edited inside the sync job's window, a shadow the sync
 * closed being promoted closed and so invisible to `listOpenClawsIssues`, and
 * the dispatchers' `isAllowedActor` check seeing the forge author where the
 * create path writes `claws`.
 *
 * Returns false when `id` is not a shadow, so a second import of the same
 * forge issue cannot overwrite the issue the first one produced.
 *
 * The lifecycle is resolved through {@link resolveStage}, the same mapping
 * `updateShadowIssue` uses: the forge has no label for Planning, so an issue
 * already past Ideas (an auto-promoted first version, or a plan with no
 * approval yet) must not be imported straight back into it, with the
 * approval this call leaves untouched now pointing nowhere.
 */
export async function promoteShadowIssue(
  id: string,
  next: { title: string; body: string; labels: readonly string[] },
  opts?: { source?: IssueSource; autoPromote?: boolean; importPending?: boolean },
): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const row = await tx.get(
      `SELECT lifecycle, requirements_approved_at FROM claws_issues WHERE id = ? AND kind = 'shadow'`,
      [id],
    ) as { lifecycle: string; requirements_approved_at: string | null } | undefined;
    if (!row) return false;
    // State labels become the `lifecycle` column, never rows, and the
    // retired gate labels become nothing: approval is `approved_through`.
    const split = splitStateLabels(next.labels);
    const lifecycle = resolveStage(split.lifecycle, { lifecycle: row.lifecycle as IssueLifecycle, requirementsApprovedAt: row.requirements_approved_at });
    const rest = split.rest;
    const now = nowSql();
    // `'claws'` is `clawsIssues.CLAWS_NATIVE_LOGIN`, spelled out because
    // `claws-issues.ts` sits above this module and cannot be imported here.
    // `auto_promote` keeps the shadow's existing value when `opts.autoPromote`
    // is not given, so a demotion's "wait for a human" survives the import.
    await tx.run(
      `UPDATE claws_issues
          SET title = ?, body = ?, author_login = 'claws', state = 'open', state_reason = NULL, closed_at = NULL,
              updated_at = ?, kind = 'issue', shadow_checked_at = NULL, lifecycle = ?, stage_changed_at = ?,
              source = ?, auto_promote = COALESCE(?, auto_promote), import_pending = ?
        WHERE id = ? AND kind = 'shadow'`,
      [next.title, next.body, now, lifecycle, now, opts?.source ?? "forge", autoPromoteParam(opts?.autoPromote), opts?.importPending ? 1 : 0, id],
    );
    await tx.run(`DELETE FROM claws_issue_labels WHERE issue_id = ?`, [id]);
    for (const label of rest) {
      await tx.run(`INSERT OR IGNORE INTO claws_issue_labels (issue_id, label) VALUES (?, ?)`, [id, label]);
    }
    return true;
  });
}

/**
 * Clear the `import_pending` flag {@link promoteShadowIssue} set, once
 * `issue-importer` has finished the import (or abandoned an interrupted one).
 * Returns true when the flag was set, so the caller can tell a finished import
 * from a no-op.
 */
export async function finishClawsIssueImport(id: string): Promise<boolean> {
  const res = await getDb().run(`UPDATE claws_issues SET import_pending = 0 WHERE id = ? AND import_pending <> 0`, [id]);
  return res.changes > 0;
}

// ── Per-issue model plan (docs/model-selection.md) ──

export type IssueModelPlanSource = "explicit" | "suggested";

export interface IssueModelPlanRow {
  repo: string;
  issue_ref: string;
  phase: string;
  provider: string | null;
  tier: string | null;
  source: IssueModelPlanSource;
  updated_at: string;
}

/** Every stored model-plan cell for one issue, in no particular order. */
export async function getIssueModelPlanRows(repo: string, ref: IssueRef): Promise<IssueModelPlanRow[]> {
  return await getDb().all(
    `SELECT repo, issue_ref, phase, provider, tier, source, updated_at FROM issue_model_plan WHERE repo = ? AND issue_ref = ?`,
    [repo, refParam(ref)],
  ) as IssueModelPlanRow[];
}

/**
 * Every operator-set cell across every issue, for the board's per-card
 * summary. The table holds at most six rows per planned issue and only the
 * explicit ones are read, so one unscoped read is cheaper than a lookup per card.
 */
export async function listExplicitIssueModelPlanRows(): Promise<IssueModelPlanRow[]> {
  return await getDb().all(
    `SELECT repo, issue_ref, phase, provider, tier, source, updated_at FROM issue_model_plan WHERE source = 'explicit'`,
  ) as IssueModelPlanRow[];
}

/**
 * Write one cell. A `suggested` write never replaces an `explicit` row — the
 * planner refreshes its own suggestions on every plan, but an operator's choice
 * stands until the operator clears it. Returns false when the write was refused
 * for that reason.
 */
export async function upsertIssueModelPlanCell(
  repo: string,
  ref: IssueRef,
  phase: string,
  cell: { provider: string | null; tier: string | null; source: IssueModelPlanSource },
): Promise<boolean> {
  const res = await getDb().run(
    `INSERT INTO issue_model_plan (repo, issue_ref, phase, provider, tier, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo, issue_ref, phase) DO UPDATE SET
       provider = excluded.provider, tier = excluded.tier, source = excluded.source, updated_at = excluded.updated_at
     WHERE issue_model_plan.source <> 'explicit' OR excluded.source = 'explicit'`,
    [repo, refParam(ref), phase, cell.provider, cell.tier, cell.source, nowSql()],
  );
  return res.changes > 0;
}

/**
 * Delete one cell so the phase falls back to its default. With `onlySource`,
 * only a row of that source is removed — how the planner withdraws a suggestion
 * it no longer makes without touching an operator's explicit cell.
 */
export async function deleteIssueModelPlanCell(repo: string, ref: IssueRef, phase: string, onlySource?: IssueModelPlanSource): Promise<void> {
  if (onlySource) {
    await getDb().run(`DELETE FROM issue_model_plan WHERE repo = ? AND issue_ref = ? AND phase = ? AND source = ?`, [repo, refParam(ref), phase, onlySource]);
    return;
  }
  await getDb().run(`DELETE FROM issue_model_plan WHERE repo = ? AND issue_ref = ? AND phase = ?`, [repo, refParam(ref), phase]);
}

/**
 * Drop an issue's model-plan rows keyed to any repo other than `keepRepo`
 * (every row when `keepRepo` is null). A plan is keyed to the issue's primary
 * repo, so once that changes the old repo's rows are orphaned — left in place
 * they would resurface on the board under a repo the card is no longer listed
 * under.
 */
export async function deleteIssueModelPlanRowsExceptRepo(ref: IssueRef, keepRepo: string | null): Promise<void> {
  if (keepRepo === null) {
    await getDb().run(`DELETE FROM issue_model_plan WHERE issue_ref = ?`, [refParam(ref)]);
    return;
  }
  await getDb().run(`DELETE FROM issue_model_plan WHERE issue_ref = ? AND repo <> ?`, [refParam(ref), keepRepo]);
}

// ── Planned PRs: the PR list a plan needs (`claws_issue_prs`) ──

/** One PR a plan needs, 1-based `position` in merge order. */
export interface IssuePlannedPR {
  position: number;
  repo: string;
  title: string;
  /** The PR Claws opened (or pushed onto) for this position, or null. */
  prNumber: number | null;
  /**
   * Earlier positions this PR must land after: `[]` is independent, null is
   * unspecified — the plan header's suffix, else the previous PR.
   */
  dependsOn: number[] | null;
  /** `pr` is implemented by Claws; `manual` is an operator step with no PR. */
  kind: "pr" | "manual";
  /** The operator step that must be done before this PR merges, or null. */
  manualAction: string | null;
  /**
   * The open PR an approved design change reworks into this step, which the
   * implementer pushes onto instead of opening a new PR. Absent reads as null.
   */
  targetPrNumber?: number | null;
}

/** An entry `replaceIssuePlannedPRs` writes; `kind` defaults to `pr`. */
export interface IssuePlannedPRInput {
  repo: string;
  title: string;
  dependsOn?: readonly number[] | null;
  kind?: "pr" | "manual";
  manualAction?: string | null;
}

type IssuePlannedPRRow = {
  position: unknown; repo: string; title: string; pr_number: unknown; depends_on: unknown;
  kind?: unknown; manual_action?: unknown; target_pr_number?: unknown;
};

const PLANNED_PR_COLUMNS = "position, repo, title, pr_number, depends_on, kind, manual_action, target_pr_number";

/** A stored `depends_on` value; anything that is not a JSON array of positive integers reads as null. */
function parseDependsOn(raw: unknown): number[] | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n) && n > 0)) return null;
    return parsed as number[];
  } catch {
    return null;
  }
}

function plannedPRFromRow(r: IssuePlannedPRRow): IssuePlannedPR {
  return {
    position: Number(r.position),
    repo: r.repo,
    title: r.title,
    prNumber: r.pr_number === null || r.pr_number === undefined ? null : Number(r.pr_number),
    dependsOn: parseDependsOn(r.depends_on),
    kind: r.kind === "manual" ? "manual" : "pr",
    manualAction: typeof r.manual_action === "string" && r.manual_action !== "" ? r.manual_action : null,
    ...(r.target_pr_number === null || r.target_pr_number === undefined ? {} : { targetPrNumber: Number(r.target_pr_number) }),
  };
}

/**
 * The native id `repo#forgeNumber` is linked to through `imported_issues`,
 * imported *or* shadowed, or undefined. Unlike the in-process alias index this
 * answers for a shadow too, which is what `planned-prs.ts` keys a forge issue's
 * PR list by.
 */
export async function getLinkedNativeId(repo: string, forgeNumber: IssueRef): Promise<string | undefined> {
  const row = await getDb().get(
    `SELECT native_id FROM imported_issues WHERE repo = ? AND forge_number = ?`,
    [repo, refParam(forgeNumber)],
  ) as { native_id: string } | undefined;
  return row ? String(row.native_id) : undefined;
}

export async function getIssuePlannedPRs(issueId: string): Promise<IssuePlannedPR[]> {
  const rows = await getDb().all(
    `SELECT ${PLANNED_PR_COLUMNS} FROM claws_issue_prs WHERE issue_id = ? ORDER BY position ASC`,
    [issueId],
  ) as IssuePlannedPRRow[];
  return rows.map(plannedPRFromRow);
}

/**
 * Replace an issue's planned-PR list in one transaction. `entries` are taken in
 * order as positions 1..n. An old `pr_number` carries over to the same position
 * when the repo and kind are unchanged, so a re-plan that keeps a shipped step
 * in place keeps its link. `dependsOn` and `manualAction` are written as given
 * (absent is null); `kind` defaults to `pr`.
 *
 * Returns the old entries whose link did NOT carry over — a position that was
 * dropped, or whose repo or kind changed — so the caller can warn that a PR
 * Claws already opened is no longer tracked by the plan.
 */
export async function replaceIssuePlannedPRs(
  issueId: string,
  entries: readonly IssuePlannedPRInput[],
): Promise<IssuePlannedPR[]> {
  return await getDb().transaction(async (tx) => {
    const oldRows = await tx.all(
      `SELECT ${PLANNED_PR_COLUMNS} FROM claws_issue_prs WHERE issue_id = ?`,
      [issueId],
    ) as IssuePlannedPRRow[];
    const old = new Map(oldRows.map((r) => [Number(r.position), plannedPRFromRow(r)]));
    await tx.run(`DELETE FROM claws_issue_prs WHERE issue_id = ?`, [issueId]);
    const carried = new Set<number>();
    for (const [i, entry] of entries.entries()) {
      const position = i + 1;
      const prev = old.get(position);
      const kind = entry.kind ?? "pr";
      const prNumber = prev && prev.prNumber !== null && prev.repo === entry.repo && prev.kind === kind ? prev.prNumber : null;
      if (prNumber !== null) carried.add(position);
      await tx.run(
        `INSERT INTO claws_issue_prs (issue_id, position, repo, title, pr_number, depends_on, kind, manual_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [issueId, position, entry.repo, entry.title, prNumber, entry.dependsOn ? JSON.stringify(entry.dependsOn) : null, kind, entry.manualAction ?? null],
      );
    }
    return [...old.values()]
      .filter((e) => e.prNumber !== null && !carried.has(e.position))
      .sort((a, b) => a.position - b.position);
  });
}

/** Record why Claws parked `trackerId` in Blocked for a human. Covers a shadow too. */
export async function setIssueBlockedReason(trackerId: string, reason: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const old = await tx.get(`SELECT blocked_reason, kind FROM claws_issues WHERE id = ?`, [trackerId]) as { blocked_reason: string | null; kind: string } | undefined;
    const res = await tx.run(
      `UPDATE claws_issues SET blocked_reason = ?, blocked_reason_at = ? WHERE id = ?`,
      [reason, nowSql(), trackerId],
    );
    if (res.changes > 0 && old?.kind === "issue") await recordIssueHistory(tx, trackerId, "blocked_reason", old.blocked_reason, reason);
  });
}

/**
 * Set or clear (`until === null`) the day native issue `id` returns from the
 * Backlog. Refuses — returns false — unless `id` is an open `kind = 'issue'`
 * row in `backlog`: a date on any other issue would sit inert until some
 * later move, or never mean anything at all. `until` is a validated
 * `YYYY-MM-DD` day (`backlog-until.ts`'s `parseBacklogUntil`).
 */
export async function setClawsIssueBacklogUntil(id: string, until: string | null): Promise<boolean> {
  return await getDb().transaction(async (tx) => {
    const old = await tx.get(
      `SELECT backlog_until FROM claws_issues WHERE id = ? AND kind = 'issue' AND lifecycle = 'backlog'`,
      [id],
    ) as { backlog_until: string | null } | undefined;
    if (!old) return false;
    if ((old.backlog_until ?? null) === until) return true;
    const now = nowSql();
    await tx.run(
      `UPDATE claws_issues SET backlog_until = ?, backlog_until_at = ?, updated_at = ? WHERE id = ?`,
      [until, until === null ? null : now, now, id],
    );
    await recordIssueHistory(tx, id, "backlog_until", old.backlog_until ?? null, until);
    return true;
  });
}

/**
 * Open native issues whose primary repo is `repo`, parked in the Backlog
 * with a return day on or before `today` (`YYYY-MM-DD`) — the ones the
 * dispatcher's sweep brings back. `today` is bound as a parameter so the
 * comparison is a plain string compare on both drivers.
 */
export async function listDueBacklogIssues(repo: string, today: string): Promise<ClawsIssueRecord[]> {
  const tail = `WHERE state = 'open' AND kind = 'issue' AND lifecycle = 'backlog' AND backlog_until IS NOT NULL AND backlog_until <= ? AND ${primaryRepoSql()} = ?
      ORDER BY id ASC`;
  const params = [today, repo];
  const rows = await getDb().all(`SELECT * FROM claws_issues ${tail}`, params) as ClawsIssueRow[];
  if (rows.length === 0) return [];
  return toClawsRecords(rows, await loadIssueSidecars(tail, params));
}

/**
 * The return day of each of `issueIds` that is parked in the Backlog with
 * one. One query for the whole batch, for the board and `/backlog`.
 */
export async function getIssueBacklogUntil(issueIds: readonly string[]): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  const placeholders = issueIds.map(() => "?").join(",");
  const rows = await getDb().all(
    `SELECT id, backlog_until FROM claws_issues
      WHERE id IN (${placeholders}) AND lifecycle = 'backlog' AND backlog_until IS NOT NULL`,
    [...issueIds],
  ) as { id: string; backlog_until: string }[];
  return new Map(rows.map((r) => [String(r.id), String(r.backlog_until)]));
}

/**
 * The stored Blocked reason of each of `issueIds` that has a current one: the
 * issue is `blocked` and the reason was recorded no earlier than it entered
 * that stage. One query for the whole batch, for the board.
 */
export async function getIssueBlockedReasons(issueIds: readonly string[]): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  const placeholders = issueIds.map(() => "?").join(",");
  const rows = await getDb().all(
    `SELECT id, blocked_reason FROM claws_issues
      WHERE id IN (${placeholders}) AND lifecycle = 'blocked' AND blocked_reason IS NOT NULL
        AND (stage_changed_at IS NULL OR blocked_reason_at >= stage_changed_at)`,
    [...issueIds],
  ) as { id: string; blocked_reason: string }[];
  return new Map(rows.map((r) => [String(r.id), r.blocked_reason]));
}

/**
 * Open `blocked` issues whose current Blocked reason names a PR (starts
 * ``PR ` ``) — the candidates `pr-stall-park.ts` may release. "Current" is
 * the same check as {@link getIssueBlockedReasons}: a reason recorded before
 * the issue last changed stage is not returned.
 */
export async function listPrStallParkCandidates(): Promise<{ id: string; blocked_reason: string }[]> {
  const rows = await getDb().all(
    `SELECT id, blocked_reason FROM claws_issues
      WHERE state = 'open' AND lifecycle = 'blocked' AND blocked_reason LIKE 'PR \`%'
        AND (stage_changed_at IS NULL OR blocked_reason_at >= stage_changed_at)
      ORDER BY id ASC`,
  ) as { id: string; blocked_reason: string }[];
  return rows.map((r) => ({ id: String(r.id), blocked_reason: r.blocked_reason }));
}

/**
 * Open `blocked` issues whose current Blocked reason says they wait on open
 * PRs to merge (starts ``Waiting on ` ``) — the candidates `pr-wait-park.ts`
 * may release. "Current" is the same check as {@link listPrStallParkCandidates}.
 */
export async function listPrWaitParkCandidates(): Promise<{ id: string; blocked_reason: string }[]> {
  const rows = await getDb().all(
    `SELECT id, blocked_reason FROM claws_issues
      WHERE state = 'open' AND lifecycle = 'blocked' AND blocked_reason LIKE 'Waiting on \`%'
        AND (stage_changed_at IS NULL OR blocked_reason_at >= stage_changed_at)
      ORDER BY id ASC`,
  ) as { id: string; blocked_reason: string }[];
  return rows.map((r) => ({ id: String(r.id), blocked_reason: r.blocked_reason }));
}

/**
 * The subset of `issueIds` awaiting the operator: the stored list has a
 * `manual` entry and every `pr` entry before the lowest-position `manual` step
 * is linked to a `claws_prs` row at stage `merged`, mapped to that step. A step
 * placed mid-plan counts once the PRs ahead of it merge. Batched, for the board.
 */
export async function getIssueIdsAwaitingOperator(issueIds: readonly string[]): Promise<Map<string, { position: number; title: string }>> {
  const out: Map<string, { position: number; title: string }> = new Map();
  if (issueIds.length === 0) return out;
  const placeholders = issueIds.map(() => "?").join(",");
  const rows = await getDb().all(
    `SELECT ip.issue_id AS issue_id
       FROM claws_issue_prs ip
       JOIN (SELECT issue_id, MIN(position) AS manual_position FROM claws_issue_prs
              WHERE kind = 'manual' AND issue_id IN (${placeholders})
              GROUP BY issue_id) m ON m.issue_id = ip.issue_id
       LEFT JOIN claws_prs p ON p.repo = ip.repo AND p.pr_number = ip.pr_number
      WHERE ip.issue_id IN (${placeholders})
      GROUP BY ip.issue_id
     HAVING SUM(CASE WHEN ip.kind <> 'manual' AND ip.position < m.manual_position AND (p.stage IS NULL OR p.stage <> 'merged') THEN 1 ELSE 0 END) = 0`,
    [...issueIds, ...issueIds],
  ) as { issue_id: string }[];
  if (rows.length === 0) return out;
  const ids = rows.map((r) => String(r.issue_id));
  const steps = await getDb().all(
    `SELECT issue_id, position, title FROM claws_issue_prs
      WHERE kind = 'manual' AND issue_id IN (${ids.map(() => "?").join(",")})
      ORDER BY position`,
    ids,
  ) as { issue_id: string; position: number; title: string }[];
  for (const step of steps) {
    const id = String(step.issue_id);
    if (!out.has(id)) out.set(id, { position: Number(step.position), title: String(step.title) });
  }
  return out;
}

/** Record the PR Claws opened for `position`. A no-op when there is no such entry. */
export async function linkIssuePlannedPR(issueId: string, position: number, prNumber: number): Promise<void> {
  await getDb().run(
    `UPDATE claws_issue_prs SET pr_number = ? WHERE issue_id = ? AND position = ?`,
    [prNumber, issueId, position],
  );
}

export async function unlinkIssuePlannedPR(issueId: string, position: number): Promise<void> {
  await getDb().run(
    `UPDATE claws_issue_prs SET pr_number = NULL WHERE issue_id = ? AND position = ?`,
    [issueId, position],
  );
}

/** Set (or clear, with null) the open PR the implementer pushes `position` onto. A no-op when there is no such entry. */
export async function setIssuePlannedPRTarget(issueId: string, position: number, prNumber: number | null): Promise<void> {
  await getDb().run(
    `UPDATE claws_issue_prs SET target_pr_number = ? WHERE issue_id = ? AND position = ?`,
    [prNumber, issueId, position],
  );
}

// ── Design-change re-approval (`claws_issue_reapprovals`) ──

/** What an approved design change does to one open PR of the old plan. */
export interface IssueReapprovalFate {
  repo: string;
  number: number;
  /** `close` closes it; `rework` retargets it at `position`; `keep` links it to `position`. */
  fate: "close" | "rework" | "keep";
  /** The revised plan's 1-based position it covers, for `rework` and `keep`. */
  position: number | null;
}

/** A design change and its re-approval state, keyed by tracker id. */
export interface IssueReapproval {
  issueId: string;
  /** The unapproved requirements version the change stored. */
  requirementsVersion: number;
  /** The plan comment edited in place with the pending plan. */
  planCommentId: string | null;
  /** The revised plan's PR list; replaces `claws_issue_prs` on approval. */
  prs: IssuePlannedPRInput[];
  fates: IssueReapprovalFate[];
  /** The comments the change answered. */
  sourceCommentIds: string[];
  requestedAt: string;
  /** Null while the change waits for the operator. */
  approvedAt: string | null;
  approvedBy: string | null;
}

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function reapprovalFromRow(r: Record<string, unknown>): IssueReapproval {
  return {
    issueId: String(r.issue_id),
    requirementsVersion: Number(r.requirements_version),
    planCommentId: r.plan_comment_id == null ? null : String(r.plan_comment_id),
    prs: parseJsonArray(r.prs) as IssuePlannedPRInput[],
    fates: parseJsonArray(r.fates) as IssueReapprovalFate[],
    sourceCommentIds: parseJsonArray(r.source_comment_ids).map(String),
    requestedAt: String(r.requested_at),
    approvedAt: r.approved_at == null ? null : String(r.approved_at),
    approvedBy: r.approved_by == null ? null : String(r.approved_by),
  };
}

/** The issue's re-approval row, pending or approved, or null when it has none. */
export async function getIssueReapproval(issueId: string): Promise<IssueReapproval | null> {
  const row = await getDb().get(`SELECT * FROM claws_issue_reapprovals WHERE issue_id = ?`, [issueId]) as Record<string, unknown> | undefined;
  return row ? reapprovalFromRow(row) : null;
}

/**
 * Record a design change as pending re-approval, replacing whatever row the
 * issue had — an earlier pending change the new one supersedes, or an
 * approved one now history.
 */
export async function upsertIssueReapproval(
  row: Pick<IssueReapproval, "issueId" | "requirementsVersion" | "planCommentId" | "prs" | "fates" | "sourceCommentIds">,
): Promise<void> {
  await getDb().run(
    `INSERT INTO claws_issue_reapprovals (issue_id, requirements_version, plan_comment_id, prs, fates, source_comment_ids, requested_at, approved_at, approved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(issue_id) DO UPDATE SET
       requirements_version = excluded.requirements_version,
       plan_comment_id = excluded.plan_comment_id,
       prs = excluded.prs,
       fates = excluded.fates,
       source_comment_ids = excluded.source_comment_ids,
       requested_at = excluded.requested_at,
       approved_at = NULL,
       approved_by = NULL`,
    [row.issueId, row.requirementsVersion, row.planCommentId, JSON.stringify(row.prs), JSON.stringify(row.fates),
      JSON.stringify(row.sourceCommentIds), nowSql()],
  );
}

/** Mark the issue's pending re-approval approved. False when there is none pending. */
export async function markIssueReapprovalApproved(issueId: string, approvedBy: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE claws_issue_reapprovals SET approved_at = ?, approved_by = ? WHERE issue_id = ? AND approved_at IS NULL`,
    [nowSql(), approvedBy, issueId],
  );
  return result.changes > 0;
}

/**
 * The subset of `issueIds` with a design change pending re-approval — one
 * query for the whole batch, for the board and the dispatcher. With no
 * `issueIds` at all, every pending issue.
 */
export async function listPendingReapprovalIssueIds(issueIds?: readonly string[]): Promise<Set<string>> {
  if (issueIds && issueIds.length === 0) return new Set();
  const rows = issueIds
    ? await getDb().all(
      `SELECT issue_id FROM claws_issue_reapprovals WHERE approved_at IS NULL AND issue_id IN (${issueIds.map(() => "?").join(",")})`,
      [...issueIds],
    ) as { issue_id: string }[]
    : await getDb().all(`SELECT issue_id FROM claws_issue_reapprovals WHERE approved_at IS NULL`) as { issue_id: string }[];
  return new Set(rows.map((r) => String(r.issue_id)));
}

/**
 * Which of `issueIds` have approved requirements (`requirements_approved_at`
 * set) — the approval track's Reqs gate, for the board. The same predicate
 * `/board/approve-through` and the issue page read off the issue row.
 */
export async function listRequirementsApprovedIssueIds(issueIds: readonly string[]): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();
  const rows = await getDb().all(
    `SELECT id FROM claws_issues WHERE requirements_approved_at IS NOT NULL AND id IN (${issueIds.map(() => "?").join(",")})`,
    [...issueIds],
  ) as { id: string }[];
  return new Set(rows.map((r) => String(r.id)));
}

/**
 * The issue a PR implements and the phase (1-based plan position) it is, looked
 * up in `claws_issue_prs` by `(repo, pr_number)`. Null when no
 * plan links the PR. Used by the PR dispatcher to back-fill `claws_prs.issue_id`.
 */
export async function findIssuePlannedPRByNumber(
  repo: string,
  prNumber: number,
): Promise<{ issueId: string; position: number } | null> {
  const row = await getDb().get(
    `SELECT issue_id, position FROM claws_issue_prs WHERE repo = ? AND pr_number = ? ORDER BY issue_id ASC, position ASC LIMIT 1`,
    [repo, prNumber],
  ) as { issue_id: string; position: unknown } | undefined;
  return row ? { issueId: String(row.issue_id), position: Number(row.position) } : null;
}

// ── PR state store (`claws_prs`) ──

/** `claws_prs.stage` — docs/refinements/issue-flow.md "Pull request state". */
export type ClawsPrStage =
  | "opened"
  | "ci-failing"
  | "awaiting-review"
  | "addressing-review"
  | "awaiting-merge"
  | "problematic"
  | "merged"
  | "closed";

/** One `claws_prs` row. Timestamps are ISO-8601 UTC. */
export interface ClawsPrRecord {
  repo: string;
  prNumber: number;
  issueId: string | null;
  phase: number | null;
  headSha: string | null;
  observedAt: string | null;
  stage: ClawsPrStage;
  /** `passing`, `failing`, `pending`, or `none` for a repo with no CI. */
  ciStatus: string | null;
  mergeableState: string | null;
  reviewVerdict: string | null;
  reviewedSha: string | null;
  mergeApprovedBy: string | null;
  mergeApprovedAt: string | null;
  manualActionReason: string | null;
  needsHumanReview: boolean;
  ciBlockedReason: string | null;
  /** Who approved this infrastructure PR's merge from the board; see `infraMergeApproval` in `pr-state.ts`. */
  infraMergeApprovedBy: string | null;
  /** When the infra merge approval was given. */
  infraMergeApprovedAt: string | null;
  /** The PR head the infra merge approval was given for; it counts only while this is the live head. */
  infraMergeApprovedSha: string | null;
  /** The PR's forge title; null until Claws opens it or the dispatcher refreshes it. */
  title: string | null;
  /** Why the dispatcher or a work handler last left the PR alone; written only by {@link setClawsPrDispatchNote}. */
  dispatchNote: string | null;
  /** When `dispatchNote` was recorded. */
  dispatchNoteAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The writable columns of a `claws_prs` row; every key is optional. */
export type ClawsPrPatch = Partial<Omit<ClawsPrRecord, "repo" | "prNumber" | "createdAt" | "updatedAt" | "dispatchNote" | "dispatchNoteAt">>;

interface ClawsPrRow {
  repo: string;
  pr_number: unknown;
  issue_id: string | null;
  phase: unknown;
  head_sha: string | null;
  observed_at: string | null;
  stage: string;
  ci_status: string | null;
  mergeable_state: string | null;
  review_verdict: string | null;
  reviewed_sha: string | null;
  merge_approved_by: string | null;
  merge_approved_at: string | null;
  manual_action_reason: string | null;
  needs_human_review: unknown;
  ci_blocked_reason: string | null;
  infra_merge_approved_by?: string | null;
  infra_merge_approved_at?: string | null;
  infra_merge_approved_sha?: string | null;
  title: string | null;
  dispatch_note: string | null;
  dispatch_note_at: string | null;
  created_at: string;
  updated_at: string;
}

const CLAWS_PR_COLUMNS: Record<keyof ClawsPrPatch, string> = {
  issueId: "issue_id",
  phase: "phase",
  headSha: "head_sha",
  observedAt: "observed_at",
  stage: "stage",
  ciStatus: "ci_status",
  mergeableState: "mergeable_state",
  reviewVerdict: "review_verdict",
  reviewedSha: "reviewed_sha",
  mergeApprovedBy: "merge_approved_by",
  mergeApprovedAt: "merge_approved_at",
  manualActionReason: "manual_action_reason",
  needsHumanReview: "needs_human_review",
  ciBlockedReason: "ci_blocked_reason",
  infraMergeApprovedBy: "infra_merge_approved_by",
  infraMergeApprovedAt: "infra_merge_approved_at",
  infraMergeApprovedSha: "infra_merge_approved_sha",
  title: "title",
};

function toClawsPrRecord(row: ClawsPrRow): ClawsPrRecord {
  return {
    repo: row.repo,
    prNumber: Number(row.pr_number),
    issueId: row.issue_id ?? null,
    phase: row.phase === null || row.phase === undefined ? null : Number(row.phase),
    headSha: row.head_sha ?? null,
    observedAt: sqlTimeToIso(row.observed_at),
    stage: row.stage as ClawsPrStage,
    ciStatus: row.ci_status ?? null,
    mergeableState: row.mergeable_state ?? null,
    reviewVerdict: row.review_verdict ?? null,
    reviewedSha: row.reviewed_sha ?? null,
    mergeApprovedBy: row.merge_approved_by ?? null,
    mergeApprovedAt: sqlTimeToIso(row.merge_approved_at),
    manualActionReason: row.manual_action_reason ?? null,
    needsHumanReview: Number(row.needs_human_review) === 1,
    ciBlockedReason: row.ci_blocked_reason ?? null,
    infraMergeApprovedBy: row.infra_merge_approved_by ?? null,
    infraMergeApprovedAt: sqlTimeToIso(row.infra_merge_approved_at ?? null),
    infraMergeApprovedSha: row.infra_merge_approved_sha ?? null,
    title: row.title ?? null,
    dispatchNote: row.dispatch_note ?? null,
    dispatchNoteAt: sqlTimeToIso(row.dispatch_note_at ?? null),
    createdAt: sqlTimeToIso(row.created_at),
    updatedAt: sqlTimeToIso(row.updated_at),
  };
}

/**
 * Columns the PR dispatcher re-observes from the forge every tick. An update
 * that writes only these leaves `updated_at` alone, so it keeps marking the
 * last state change — the dispatcher's reconcile relies on that.
 */
const CLAWS_PR_OBSERVED_KEYS: ReadonlySet<keyof ClawsPrPatch> = new Set([
  "headSha", "observedAt", "ciStatus", "mergeableState", "reviewVerdict", "reviewedSha", "title",
]);

/**
 * Insert or update the `claws_prs` row for `(repo, prNumber)`. Only the keys
 * present in `patch` are written — an insert leaves the rest at their column
 * defaults, an update leaves them untouched. `updated_at` moves on an insert
 * and on any update that writes a state column; an update of observed columns
 * only ({@link CLAWS_PR_OBSERVED_KEYS}) leaves it alone.
 * Timestamps in the patch are stored in the `nowSql()` form. Then re-reads the
 * row and evaluates its gate events (`evaluatePrGates`), best-effort.
 */
export async function upsertClawsPr(repo: string, prNumber: number, patch: ClawsPrPatch): Promise<void> {
  const keys = (Object.keys(patch) as (keyof ClawsPrPatch)[])
    .filter((k) => k in CLAWS_PR_COLUMNS && patch[k] !== undefined);
  const columns = keys.map((k) => CLAWS_PR_COLUMNS[k]);
  const values = keys.map((k) => {
    const v = patch[k];
    if (typeof v === "boolean") return v ? 1 : 0;
    if ((k === "observedAt" || k === "mergeApprovedAt" || k === "infraMergeApprovedAt") && typeof v === "string") {
      return v.slice(0, 19).replace("T", " ");
    }
    return v as string | number | null;
  });
  const now = nowSql();
  const updates = columns.map((c) => `${c} = excluded.${c}`);
  const observedOnly = keys.length > 0 && keys.every((k) => CLAWS_PR_OBSERVED_KEYS.has(k));
  if (!observedOnly) updates.push("updated_at = excluded.updated_at");
  await getDb().run(
    `INSERT INTO claws_prs (repo, pr_number${columns.map((c) => `, ${c}`).join("")}, created_at, updated_at)
     VALUES (?, ?${columns.map(() => ", ?").join("")}, ?, ?)
     ON CONFLICT(repo, pr_number) DO UPDATE SET ${updates.join(", ")}`,
    [repo, prNumber, ...values, now, now],
  );
  try {
    const row = await getClawsPr(repo, prNumber);
    if (row) void evaluatePrGates(row);
  } catch (err) {
    log.warn(`upsertClawsPr: could not re-read ${repo}#${prNumber} for its gate events: ${err}`);
  }
}

/**
 * Withdraw the merge approval on each of `rows` that holds one: null
 * `merge_approved_by` / `merge_approved_at` and any board infra merge approval,
 * through {@link upsertClawsPr} so the gate events still fire. Returns how many
 * rows it cleared. The one rule for every write that takes an issue below
 * Merge — `applyIssueApproval`'s lowering and the demotion to Ideas.
 */
export async function clearPrMergeApprovals(rows: readonly ClawsPrRecord[]): Promise<number> {
  let cleared = 0;
  for (const pr of rows) {
    if (!pr.mergeApprovedAt && !pr.infraMergeApprovedAt) continue;
    await upsertClawsPr(pr.repo, pr.prNumber, {
      mergeApprovedBy: null,
      mergeApprovedAt: null,
      infraMergeApprovedBy: null,
      infraMergeApprovedAt: null,
      infraMergeApprovedSha: null,
    });
    cleared++;
  }
  return cleared;
}

/**
 * Record (or clear, with null) why the dispatcher or a work handler left a PR
 * alone. Updates an existing row only — the dispatcher seeds one for every
 * open PR — and leaves `updated_at` alone: a note is not a state change.
 */
export async function setClawsPrDispatchNote(repo: string, prNumber: number, note: string | null): Promise<void> {
  await getDb().run(
    `UPDATE claws_prs SET dispatch_note = ?, dispatch_note_at = ? WHERE repo = ? AND pr_number = ?`,
    [note, note === null ? null : nowSql(), repo, prNumber],
  );
}

export async function getClawsPr(repo: string, prNumber: number): Promise<ClawsPrRecord | null> {
  const row = await getDb().get(
    `SELECT * FROM claws_prs WHERE repo = ? AND pr_number = ?`,
    [repo, prNumber],
  ) as ClawsPrRow | undefined;
  return row ? toClawsPrRecord(row) : null;
}

/** Every `claws_prs` row for `repo`, by PR number; `openOnly` drops `merged`/`closed`. */
export async function listClawsPrs(repo: string, opts?: { openOnly?: boolean }): Promise<ClawsPrRecord[]> {
  const rows = await getDb().all(
    opts?.openOnly
      ? `SELECT * FROM claws_prs WHERE repo = ? AND stage NOT IN ('merged', 'closed') ORDER BY pr_number ASC`
      : `SELECT * FROM claws_prs WHERE repo = ? ORDER BY pr_number ASC`,
    [repo],
  ) as ClawsPrRow[];
  return rows.map(toClawsPrRecord);
}

/** The open (`stage` not `merged`/`closed`) `claws_prs` rows for a tracker issue, in any repo. */
export async function listOpenClawsPrsForIssue(issueId: string): Promise<ClawsPrRecord[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_prs WHERE issue_id = ? AND stage NOT IN ('merged', 'closed') ORDER BY repo ASC, pr_number ASC`,
    [issueId],
  ) as ClawsPrRow[];
  return rows.map(toClawsPrRecord);
}

/** Every `claws_prs` row for a tracker issue, in any repo and any stage. */
export async function listClawsPrsForIssue(issueId: string): Promise<ClawsPrRecord[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_prs WHERE issue_id = ? ORDER BY repo ASC, pr_number ASC`,
    [issueId],
  ) as ClawsPrRow[];
  return rows.map(toClawsPrRecord);
}

/** Every open `claws_prs` row linked to an issue — the board's PR columns in one query. */
export async function listOpenClawsPrsWithIssue(): Promise<ClawsPrRecord[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_prs WHERE issue_id IS NOT NULL AND stage NOT IN ('merged', 'closed') ORDER BY repo ASC, pr_number ASC`,
  ) as ClawsPrRow[];
  return rows.map(toClawsPrRecord);
}

/**
 * Every open `claws_prs` row with each issue it serves: the issue that owns
 * it (`claws_prs.issue_id`) and every issue whose stored step is linked to it
 * (`claws_issue_prs.pr_number`) — a step committed onto another issue's PR
 * through `CLAWS_TARGET_PR` (#clw_01M4XWHG3A2Q5Y06GN2SC7K06X). One entry per
 * distinct issue and row, for the board.
 */
export async function listOpenClawsPrsLinkedToIssues(): Promise<{ issueId: string; row: ClawsPrRecord }[]> {
  const rows = await getDb().all(
    `SELECT p.issue_id AS link_issue_id, p.* FROM claws_prs p
      WHERE p.issue_id IS NOT NULL AND p.stage NOT IN ('merged', 'closed')
     UNION
     SELECT ip.issue_id AS link_issue_id, p.* FROM claws_issue_prs ip
       JOIN claws_prs p ON p.repo = ip.repo AND p.pr_number = ip.pr_number
      WHERE p.stage NOT IN ('merged', 'closed')
     ORDER BY repo ASC, pr_number ASC`,
  ) as (ClawsPrRow & { link_issue_id: string })[];
  return rows.map((r) => ({ issueId: String(r.link_issue_id), row: toClawsPrRecord(r) }));
}

/**
 * The open `claws_prs` rows an issue owns plus those one of its stored steps
 * is linked to (see {@link listOpenClawsPrsLinkedToIssues}), each once.
 * Ownership-only callers keep {@link listOpenClawsPrsForIssue}.
 */
export async function listOpenClawsPrsForIssueOrSteps(issueId: string): Promise<ClawsPrRecord[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_prs
      WHERE stage NOT IN ('merged', 'closed')
        AND (issue_id = ? OR EXISTS (
          SELECT 1 FROM claws_issue_prs ip
           WHERE ip.issue_id = ? AND ip.repo = claws_prs.repo AND ip.pr_number = claws_prs.pr_number))
      ORDER BY repo ASC, pr_number ASC`,
    [issueId, issueId],
  ) as ClawsPrRow[];
  return rows.map(toClawsPrRecord);
}

/** Every open `claws_prs` row in any repo, linked to an issue or not — the nav's PRs count. */
export async function listOpenClawsPrs(): Promise<ClawsPrRecord[]> {
  const rows = await getDb().all(
    `SELECT * FROM claws_prs WHERE stage NOT IN ('merged', 'closed') ORDER BY repo ASC, pr_number ASC`,
  ) as ClawsPrRow[];
  return rows.map(toClawsPrRecord);
}

export async function closeDb(): Promise<void> {
  if (jobLogDrainTimer) {
    clearInterval(jobLogDrainTimer);
    jobLogDrainTimer = null;
  }
  if (driver) {
    await flushJobLogs();
    await flushGitHubEvents();
    const closing = driver;
    driver = null;
    setConfigStoreDriver(null);
    setGitHubEventsDriver(null);
    setGateEventsDriver(null);
    await closing.close();
    log.info("Database closed");
  }
}
