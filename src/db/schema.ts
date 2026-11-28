// The schema DDL: SCHEMA_VERSION and migrateSchema, which creates every table,
// column and index and then runs the data migrations. Reached only through
// the src/db.ts façade.
import { CONFIG_STORE_DDL } from "../config-store.js";
import { CLAWS_EVENTS_DDL, CLAWS_EVENTS_INDEX_DDL } from "../github-events.js";
import { CLAWS_GATE_STATE_DDL } from "../gate-events.js";
import { getDb, refParam, timedDb } from "./core.js";
import {
  dropRetiredSopsKeyTables, migrateAlertKindBackfill, migrateClawsIgnoreLabel, migrateDedupeKeysToTable, migrateGateLabelsToApprovedThrough,
  migrateInboxToIdeas, migrateIssueRefColumnsToText, migrateLegacyMultiWorktreeSessions, migrateRenamedCapabilities,
  migrateRetiredManualAction, migrateStateLabelsToLifecycle,
} from "./migrations.js";
import { backfillPRReviews } from "./pr-reviews.js";
import { backfillClawsPrMilestones } from "./prs.js";
// Not yet split out of the façade (#clw_01M8A3RZ47A1W7E28W43TAFJ3G PR 3–4).
import { backfillClawsIssuePlans } from "../db.js";

/**
 * The schema this build's DDL produces. Bump it with every DDL change in
 * {@link migrateSchema}: the controller records it in `controller_status`
 * after migrating, and a web pod waits until the recorded version is at least
 * its own (src/main-web.ts). Schema changes stay additive within a release —
 * a column or table is dropped only one release after nothing reads it — so
 * `src/schema-version.test.ts` fails when `migrateSchema` changes without a bump.
 * the previous build keeps working against the migrated schema.
 */
export const SCHEMA_VERSION = 35;

/** The `controller_status` key the controller records {@link SCHEMA_VERSION} under. */
export const SCHEMA_VERSION_KEY = "schema_version";

/** Every table, column, index and data migration; run by {@link initDb} in the controller only. */
export async function migrateSchema(): Promise<void> {
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
  // Which Anthropic identity each account's token belongs to
  // (src/claude-account-identity.ts); null until looked up, cleared when a
  // new token is stored.
  await getDb().addColumn("claude_accounts", "email", "TEXT");
  await getDb().addColumn("claude_accounts", "org_uuid", "TEXT");
  await getDb().addColumn("claude_accounts", "org_name", "TEXT");
  await getDb().addColumn("claude_accounts", "plan", "TEXT");
  await getDb().addColumn("claude_accounts", "identity_source", "TEXT");
  await getDb().addColumn("claude_accounts", "identity_checked_at", "TEXT");

  // Usage folded out of deleted or reset `tasks` and `sessions` rows, so the
  // agent usage counters (src/agent-metrics.ts) never fall. Keyed by the
  // metric labels plus the task outcome (`''` for sessions and usage resets).
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS usage_retired_totals (
      repo     TEXT NOT NULL,
      job      TEXT NOT NULL,
      provider TEXT NOT NULL,
      model    TEXT NOT NULL,
      account  TEXT NOT NULL,
      outcome  TEXT NOT NULL,
      tasks    INTEGER NOT NULL DEFAULT 0,
      tokens   INTEGER NOT NULL DEFAULT 0,
      cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      PRIMARY KEY (repo, job, provider, model, account, outcome)
    )
  `);

  // Lifetime counts of agent events the metrics export (src/agent-metrics.ts):
  // failed tasks by reason (`task_failures`) and items removed from the queue
  // (`items_removed`). Bumped when the event is recorded, never recounted from
  // `tasks`, so pruning never lowers them.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS agent_event_totals (
      metric    TEXT NOT NULL,
      job       TEXT NOT NULL,
      reason    TEXT NOT NULL,
      pod_class TEXT NOT NULL,
      n         INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (metric, job, reason, pod_class)
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
  // Addresser hand-off state for the round — the review comment's
  // `review-addressed:` / `review-rebutted:` / `advisory-addressed:` lines are
  // human-only output; these columns are what the review cycle reads.
  await getDb().addColumn("pr_reviews", "addressed_at", "TEXT");
  await getDb().addColumn("pr_reviews", "addressed_sha", "TEXT");
  await getDb().addColumn("pr_reviews", "rebutted", "INTEGER NOT NULL DEFAULT 0");
  await getDb().addColumn("pr_reviews", "rebuttal", "TEXT");
  await getDb().addColumn("pr_reviews", "advisory_addressed_sha", "TEXT");
  // The addresser's posted summary (handed back to the reviewer and the
  // doc-maintainer) and the reviewer's `recommended-model:` tier for the
  // addresser, read from the model's output when the round is recorded.
  await getDb().addColumn("pr_reviews", "addresser_summary", "TEXT");
  await getDb().addColumn("pr_reviews", "recommended_model", "TEXT");
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
  // Size class of that pod (`default` or `large`), resolved at launch; NULL for in-process runs and pods launched before it existed.
  await getDb().addColumn("work_queue", "agent_pod_class", "TEXT");
  // SHA-256 of that pod's claws-state bearer token, so it authenticates across service restarts.
  await getDb().addColumn("work_queue", "agent_mcp_token_sha256", "TEXT");
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_work_queue_dispatch ON work_queue(status, priority DESC, id ASC)`);
  await getDb().exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_queue_active ON work_queue(kind, repo, item_number) WHERE status IN ('queued', 'running')`);
  // recordTaskFailed looks up a failed task's pod class by run_id.
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_work_queue_run_id ON work_queue(run_id)`);

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
  // Node the session's pod was last scheduled on (#clw_01M7Q3P5PR480HYED9TNH6VTV9).
  await getDb().addColumn("sessions", "node", "TEXT");
  // The HOME PVC a session uses when a move gave it a new one; NULL means the claim named after the session.
  await getDb().addColumn("sessions", "home_claim", "TEXT");
  // When reconcile found the session's node NotReady; NULL while it is Ready. The row stays open meanwhile.
  await getDb().addColumn("sessions", "node_lost_at", "INTEGER");
  // JSON list of the times the session was relaunched after an eviction or preemption, for the hourly cap.
  await getDb().addColumn("sessions", "evicted_restarts", "TEXT");

  // Nodes being evacuated (#clw_01M7Q3P5PR480HYED9TNH6VTV9): every session stored on one is moved
  // to the home session node. A row lives from the evacuation request until it is cleared.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS node_evacuations (
      node                  TEXT PRIMARY KEY,
      reason                TEXT NOT NULL,
      requested_at          INTEGER NOT NULL,
      idle_deadline_seconds INTEGER NOT NULL
    )
  `);
  // One move of a session's HOME volume to another node, for a node evacuation (`kind = 'settle'` rows are legacy).
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS session_moves (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      kind         TEXT NOT NULL,
      from_node    TEXT NOT NULL,
      to_node      TEXT NOT NULL,
      reason       TEXT NOT NULL,
      state        TEXT NOT NULL,
      was_running  INTEGER NOT NULL DEFAULT 0,
      from_claim   TEXT NOT NULL,
      new_claim    TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0,
      bytes        INTEGER,
      requested_at INTEGER NOT NULL,
      started_at   INTEGER,
      finished_at  INTEGER,
      error        TEXT
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_session_moves_session ON session_moves(session_id)`);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_session_moves_from_node ON session_moves(from_node)`);

  // Last explicitly submitted capability set per repo combination, keyed by
  // `sessionCapabilityDefaultsKey`; the /sessions create form pre-ticks it.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS session_capability_defaults (
      repo_key     TEXT PRIMARY KEY,
      capabilities TEXT NOT NULL,
      updated_at   INTEGER NOT NULL
    )
  `);
  await migrateLegacyMultiWorktreeSessions();

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
  // Who decided: `auto` or `operator`; null on rows decided before it existed
  // (read as `operator`) and on pending rows (#clw_01M77K5B15JHY1N6JMGRZDFQ0D).
  await getDb().addColumn("session_capability_requests", "decided_by", "TEXT");
  // After session_capability_requests exists: the rename rewrites its rows too.
  await migrateRenamedCapabilities();

  // Operator AWS access grants (#clw_01M8426RTMG1TWE224NXW1V02S): one row per
  // approved aws-* sign-in, kept after the session ends as the audit record.
  // No credential, token or device code is ever stored; the verification URL
  // and user code are cleared once the row leaves `awaiting-signin`.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS session_aws_grants (
      id                    TEXT PRIMARY KEY,
      session_id            TEXT NOT NULL,
      capability            TEXT NOT NULL,
      permission_set        TEXT NOT NULL,
      account_id            TEXT NOT NULL,
      status                TEXT NOT NULL,
      verification_url      TEXT,
      user_code             TEXT,
      device_expires_at     INTEGER,
      granted_by            TEXT NOT NULL,
      created_at            INTEGER NOT NULL,
      granted_at            INTEGER,
      credentials_expire_at INTEGER,
      ended_at              INTEGER,
      end_reason            TEXT
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_session_aws_grants_session ON session_aws_grants(session_id, created_at)`);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_session_aws_grants_status ON session_aws_grants(status)`);

  // The retired sealed SOPS age-key feature's tables (#clw_01M8BRCFTHQQPEGXN1X3W281NH):
  // dropped when both are empty, kept with an error log otherwise.
  await dropRetiredSopsKeyTables();

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

  // Latest agent audit per (contract, repo): the HEAD it read and its findings (JSON
  // array of DriftFinding), replaced on each audit; see src/jobs/contract-audit.ts.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS contract_audits (
      contract    TEXT NOT NULL,
      repo        TEXT NOT NULL,
      head_sha    TEXT NOT NULL,
      audited_at  TEXT NOT NULL,
      findings    TEXT NOT NULL,
      PRIMARY KEY (contract, repo)
    )
  `);

  // Latest daily-scanner snapshot per (contract, repo) for the /contracts page: policy
  // status, Known gaps, drift and audit findings (JSON ContractStatusSnapshot), replaced
  // on each scan; see src/contract-status.ts.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS contract_status (
      contract    TEXT NOT NULL,
      repo        TEXT NOT NULL,
      scanned_at  TEXT NOT NULL,
      snapshot    TEXT NOT NULL,
      PRIMARY KEY (contract, repo)
    )
  `);

  // The fleet-wide accepted-gaps review's reconfirmations, one row per (contract, repo):
  // when a person last reconfirmed the repo's accepted Known gaps for the contract and
  // the keys (src/contract-gap-review.ts gapKey) of the gaps reconfirmed then.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS contract_gap_reconfirmations (
      contract        TEXT NOT NULL,
      repo            TEXT NOT NULL,
      reconfirmed_at  TEXT NOT NULL,
      gap_keys        TEXT NOT NULL,
      PRIMARY KEY (contract, repo)
    )
  `);

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
  // The board column the issue-dispatcher's sweep last saw the issue in —
  // including the columns derived at render time (In progress, Awaiting
  // merge) that no `lifecycle` change marks — and when it entered it
  // (`recordIssueBoardColumns`). NULL until the first sweep records it.
  await getDb().addColumn("claws_issues", "board_column", "TEXT");
  await getDb().addColumn("claws_issues", "board_column_at", "TEXT");
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
  // Retired: an issue's dedupe keys live in `claws_issue_dedupe_keys`, which
  // `migrateDedupeKeysToTable` copies this column into on every boot (so keys
  // a previous-release pod writes mid-rollout are kept). This build never
  // reads it and writes it only to clear it; kept, so no migration drops it.
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
  // When the outage-plan Slack page last went out for the issue
  // (`claimClawsIssueOutageNotice`, #clw_01M7VZZYSAGW87NV1HVZJXEE4F). It
  // first deduplicated the retired stalled-alert line, so old rows may hold
  // weeks-old times, which never block a page.
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
  // The operator's Start anyway on a step held for file overlap
  // (#clw_01M7WDMJ9GCF6MCZ0BPKN3333S): when and by whom the hold was lifted for
  // the whole issue; cleared when the issue closes.
  await getDb().addColumn("claws_issues", "overlap_hold_lifted_at", "TEXT");
  await getDb().addColumn("claws_issues", "overlap_hold_lifted_by", "TEXT");
  // The retired plan-stage acknowledgement of the issue's declared infra
  // changes (#clw_01M7NKT2H402M07VGCAE1TBX8G): kept, no longer read or written.
  await getDb().addColumn("claws_issues", "infra_ack_by", "TEXT");
  await getDb().addColumn("claws_issues", "infra_ack_at", "TEXT");
  await getDb().addColumn("claws_issues", "infra_ack_hash", "TEXT");
  // The tofu destroy consent the operator gave with the Plan approval
  // (src/destroy-consent.ts): a JSON snapshot `[{position, repo, root,
  // address}]` of the planned PRs' declared destroys and replaces, taken when
  // `approved_through` rises to `plan`; cleared by a lowering below `plan`
  // and by a re-plan (`replaceIssuePlannedPRs`).
  await getDb().addColumn("claws_issues", "approved_destroys", "TEXT");
  await getDb().addColumn("claws_issues", "approved_destroys_by", "TEXT");
  await getDb().addColumn("claws_issues", "approved_destroys_at", "TEXT");
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
  // The keys a native issue is deduplicated by (docs/issue-tracker.md "Dedupe
  // on create"): any number per issue, and within one primary repo a key is
  // held by at most one open issue (`addClawsIssueDedupeKey`). A
  // `claws_create_issue` caller names its work by one, and alert routing
  // looks an alert group up by its exact key.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claws_issue_dedupe_keys (
      issue_id   TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (issue_id, dedupe_key),
      FOREIGN KEY (issue_id) REFERENCES claws_issues(id) ON DELETE CASCADE
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_claws_issue_dedupe_keys_key ON claws_issue_dedupe_keys(dedupe_key)`);
  await migrateDedupeKeysToTable();
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
  // The Tofu changes the planner declared this PR is expected to make
  // (`claws_save_plan`'s `infra_changes`, src/infra-declaration.ts), as JSON;
  // NULL for a PR with no declaration.
  await getDb().addColumn("claws_issue_prs", "infra_changes", "TEXT");
  // The files or directory prefixes the planner declared this step is expected
  // to change (`claws_save_plan`'s `prs[].paths`, src/overlap.ts), as a JSON
  // array; NULL for a manual step or a plan saved before paths were declared.
  // The file-overlap gate reads it (src/overlap-gate.ts).
  await getDb().addColumn("claws_issue_prs", "paths", "TEXT");
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
  // The auto-merger's last skip, so the web tier (no in-memory merge-block map) can read it.
  await getDb().addColumn("claws_prs", "merge_skip_code", "TEXT");
  await getDb().addColumn("claws_prs", "merge_skip_reason", "TEXT");
  await getDb().addColumn("claws_prs", "merge_skip_head", "TEXT");
  await getDb().addColumn("claws_prs", "merge_skip_at", "TEXT");
  // A human's board infra approval (a destructive or unverifiable plan, or a tofu
  // workflow edit, #clw_01M7NKT2H402M07VGCAE1TBX8G), bound to the head it was given for.
  await getDb().addColumn("claws_prs", "infra_merge_approved_by", "TEXT");
  await getDb().addColumn("claws_prs", "infra_merge_approved_at", "TEXT");
  await getDb().addColumn("claws_prs", "infra_merge_approved_sha", "TEXT");
  // What the operator approved (plan fingerprint and tofu workflow digest), and
  // the later head that approval was carried over to as plan-neutral.
  await getDb().addColumn("claws_prs", "infra_merge_approved_evidence", "TEXT");
  await getDb().addColumn("claws_prs", "infra_merge_carried_sha", "TEXT");
  await getDb().addColumn("claws_prs", "infra_merge_carried_note", "TEXT");
  // Automatic base-into-branch updates made for a stale infra merge approval
  // whose plan drifted outside the PR's roots, the head the last one made (null
  // when it could not be read) and the head it started from.
  await getDb().addColumn("claws_prs", "infra_branch_updates", "INTEGER");
  await getDb().addColumn("claws_prs", "infra_branch_update_sha", "TEXT");
  await getDb().addColumn("claws_prs", "infra_branch_update_from_sha", "TEXT");
  // The PR's relation to the issue it belongs to, recorded when Claws opens or
  // pushes onto it (src/pr-issue-relation.ts). The row, not the PR body, decides
  // whether merging the PR closes the issue; NULL means unrecorded (body fallback).
  await getDb().addColumn("claws_prs", "issue_relation", "TEXT");
  await getDb().addColumn("claws_prs", "issue_ref", "TEXT");
  await getDb().addColumn("claws_prs", "plan_steps", "INTEGER");
  await getDb().addColumn("claws_prs", "also_closes", "TEXT");
  // When the PR first reached `merged` and first became `problematic`, stamped
  // once by upsertClawsPr and never cleared, for claws_delivery_stats.
  await getDb().addColumn("claws_prs", "merged_at", "TEXT");
  await getDb().addColumn("claws_prs", "problematic_at", "TEXT");
  await timedDb("backfill-claws-pr-milestones", backfillClawsPrMilestones);
  // Each Claws PR head's changed files, read once by the PR dispatcher, for the
  // file-overlap gate (src/overlap-gate.ts). Keyed by head: a push adds a row.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS claws_pr_files (
      repo       TEXT NOT NULL,
      pr_number  INTEGER NOT NULL,
      head_sha   TEXT NOT NULL,
      files      TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (repo, pr_number, head_sha)
    )
  `);
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
  // Forgejo Actions run cancels and workflow toggles a session or the dashboard
  // made (#clw_01M7X2XQESHRXWHA4Z59EXWT7Y): one row per cancelled run or toggle.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS actions_control_log (
      id          {{PK_AUTOINC}},
      repo        TEXT NOT NULL,
      actor       TEXT NOT NULL,
      action      TEXT NOT NULL,
      target      TEXT NOT NULL,
      pr_number   INTEGER,
      detail      TEXT,
      created_at  TEXT NOT NULL DEFAULT {{NOW}}
    )
  `);
  await getDb().exec(`CREATE INDEX IF NOT EXISTS idx_actions_control_log_repo ON actions_control_log(repo, created_at)`);
  // Workflows disabled on each repo (#clw_01M7X2XQESHRXWHA4Z59EXWT7Y): the
  // runner monitor mirrors Forgejo's list every tick and the dashboard's
  // toggles write through, so the disabled-workflow banner stays current.
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS disabled_workflows (
      repo           TEXT NOT NULL,
      workflow       TEXT NOT NULL,
      disabled_by    TEXT,
      first_seen_at  TEXT NOT NULL DEFAULT {{NOW}},
      PRIMARY KEY (repo, workflow)
    )
  `);
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
  // A `depends_on` link scoped to one step (1-based position in the target's
  // stored PR list): satisfied once that step is done or the target closes.
  // NULL waits for the whole target issue.
  await getDb().addColumn("claws_issue_links", "target_step", "INTEGER");
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
