# Database Schema

Claws uses SQLite (via `better-sqlite3`) stored at `~/.claws/claws.db`.
The database is configured with WAL journal mode and NORMAL synchronous
level for performance.

**Source**: `src/db.ts`

## `tasks` table

Tracks every job invocation. Used for crash recovery (orphaned task detection
at startup), timeout escalation (counting recent failures), and operational
visibility.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique task identifier |
| `job_name` | TEXT | NOT NULL | Job that created this task (e.g. `issue-worker`, `ci-fixer`) |
| `repo` | TEXT | NOT NULL | Full repo name (e.g. `St-John-Software/claws`) |
| `item_number` | INTEGER | NOT NULL | Issue or PR number (0 for doc-maintainer) |
| `trigger_label` | TEXT | nullable | Label that triggered this task |
| `worktree_path` | TEXT | nullable | Filesystem path to the task's worktree |
| `branch_name` | TEXT | nullable | Git branch name used by this task |
| `run_id` | TEXT | nullable | UUID of the parent job run (links to `job_runs.run_id`) |
| `model_used` | TEXT | nullable | Claude model used for this task (e.g. `opus`, `sonnet`). Set via `updateTaskModel()` after model selection. |
| `provider_used` | TEXT | nullable | AI provider used for this task (e.g. `claude`, `opencode`). Set via `updateTaskProvider()` from the `onProviderUsed` callback in `runClaude()`. |
| `tokens_used` | INTEGER | nullable | Total tokens consumed. Set via `updateTaskTokenUsage()` when the provider exposes usage data (Claude CLI, OpenCode, OpenRouter direct). Codex CLI never populates this. |
| `cost_usd` | REAL | nullable | Estimated cost in USD. Set alongside `tokens_used` via `updateTaskTokenUsage()`. |
| `status` | TEXT | NOT NULL, default `'running'` | One of: `running`, `completed`, `failed` |
| `error` | TEXT | nullable | Error message if status is `failed` |
| `outcome` | TEXT | nullable | JSON blob with structured outcome metadata (see below) |
| `started_at` | TEXT | NOT NULL | ISO timestamp when task started |
| `completed_at` | TEXT | nullable | ISO timestamp when task finished |

### Indexes

- `idx_tasks_status` on `status` — used by `getOrphanedTasks()` to find
  rows still in `running` state at startup
- `idx_tasks_run_id` on `run_id` — used by `getTasksByRunId()` and
  `getWorkItemsForRuns()` to fetch tasks for a specific job run

### Lifecycle

1. **Start**: `recordTaskStart()` inserts a row with status `running` and
   the current `run_id` (from `AsyncLocalStorage` context, linking the task
   to its parent job run)
2. **Worktree created**: `updateTaskWorktree()` fills in `worktree_path` and
   `branch_name` (these are null initially because they're set after the
   worktree is created)
3. **Complete**: `recordTaskComplete()` sets status to `completed` with
   timestamp
4. **Failed**: `recordTaskFailed()` sets status to `failed` with error
   message and timestamp

### Outcome Metadata

The `outcome` column stores a JSON blob (`TaskOutcome`) with structured
metadata captured at task completion. Fields include:

| Field | Type | Description |
|-------|------|-------------|
| `commits` | number | Number of commits made |
| `filesChanged` | number | Number of files changed |
| `insertions` | number | Lines added |
| `deletions` | number | Lines removed |
| `prNumber` | number | PR number created or updated |
| `prAction` | `"created"` \| `"updated"` \| `"reviewed"` | Whether a PR was created, updated, or reviewed |
| `failureCategory` | string | For failed tasks: `timeout`, `shutdown`, `push-rejection`, `git-conflict`, `rate-limit`, `ref-not-found`, `transient-api`, `logs-unavailable` (ci-fixer: failed log fetch, counts toward circuit breaker), or `unknown` |

All fields are optional. The outcome is set via `recordTaskComplete(taskId, outcome)`
or `recordTaskFailed(taskId, error, outcome)`. Old tasks have `outcome = NULL`.

### Timeout Counting

`countRecentTimeouts(repo, itemNumber, windowMs)` counts tasks for a specific
item that failed with a "timed out" error within a sliding window (default:
2 hours). Used by `timeout-handler.ts` to decide whether to escalate the
timeout or auto-skip the item after repeated timeouts.

### Crash Recovery

`getOrphanedTasks()` returns all rows with `status = 'running'`. At startup,
`main.ts` iterates these and:
- Removes the worktree directory if it still exists on disk
- Marks the task as `failed` with error `"process restarted before completion"`

## `job_runs` table

Tracks each scheduled job execution. Created automatically on DB init.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Auto-increment ID |
| `run_id` | TEXT | NOT NULL UNIQUE | UUID identifying this run |
| `job_name` | TEXT | NOT NULL | Name of the job (e.g. `issue-worker`) |
| `status` | TEXT | NOT NULL, default `'running'` | One of: `running`, `completed`, `failed` |
| `started_at` | TEXT | NOT NULL | ISO timestamp when the run started |
| `completed_at` | TEXT | nullable | ISO timestamp when the run finished |

### Indexes

- `idx_job_runs_job_name` on `job_name`
- `idx_job_runs_started_at` on `started_at` — used by pruning

## `job_logs` table

Stores log output captured during job runs via `AsyncLocalStorage` context.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Auto-increment ID |
| `run_id` | TEXT | NOT NULL | UUID of the parent job run |
| `level` | TEXT | NOT NULL | Log level: `debug`, `info`, `warn`, or `error` |
| `message` | TEXT | NOT NULL | The log message |
| `logged_at` | TEXT | NOT NULL | ISO timestamp when the log was written |

### Indexes

- `idx_job_logs_run_id` on `run_id` — used to fetch logs for a specific run

### Pruning

Old runs and logs are pruned on startup and daily via `pruneOldLogs()`.
Retention is configured via `logRetentionDays` (default: 14 days) and
`logRetentionPerJob` (default: 20) in `~/.claws/config.json`. The pruner
deletes runs older than the retention period but always keeps the most
recent N runs per job type. Orphaned log entries are cascade-deleted.

## `queue_snapshots` table

Stores periodic snapshots of total queue depth for the dashboard sparkline.
Recorded hourly by `main.ts` via `recordQueueSnapshot()`, with a delayed
initial snapshot 30 seconds after startup.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Auto-increment ID |
| `total_items` | INTEGER | NOT NULL | Total number of items across all queue categories |
| `recorded_at` | TEXT | NOT NULL | ISO timestamp when the snapshot was taken |

### Indexes

- `idx_queue_snapshots_recorded_at` on `recorded_at` — used by
  `getQueueSnapshots()` to fetch recent data and by pruning

### Querying

- `getQueueSnapshots(hours)` returns snapshots within the last N hours
  (default: 24) ordered by time ascending, used by the dashboard sparkline
- `getAverageTaskDurationMs(jobName, limit)` queries the `tasks` table
  (not this table) for average duration of the last N completed tasks
  matching a job name prefix, used for ETA calculations on the queue page

### Pruning

`pruneQueueSnapshots(retentionHours)` deletes snapshots older than the
retention period (default: 72 hours). Called on startup and daily alongside
`pruneOldLogs()`.

## `whatsapp_events` table

Append-only log of WhatsApp connection state transitions. Written by `whatsapp.ts`
via `recordWhatsappEvent()` (fire-and-forget, synchronous insert). Readable via
`GET /whatsapp/events` and displayed on the WhatsApp dashboard page.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Auto-increment ID |
| `event_type` | TEXT | NOT NULL | One of: `connected`, `disconnected`, `restart-required`, `connection-replaced`, `logged-out`, `auth-cleared`, `message-received`, `pairing-required` |
| `detail` | TEXT | nullable | Optional context string (e.g. `"Status 515 from Baileys"`) |
| `occurred_at` | TEXT | NOT NULL, default `datetime('now')` | ISO timestamp when the event occurred |

No pruning is defined; the table grows unboundedly but event volume is low (connection
transitions are rare). The `/whatsapp/events` endpoint limits queries to 200 rows.

## `workflow_runs` table

Stores GitHub Actions workflow run data synced by the `runner-metrics-sync` job.
Used for runner utilization analytics and the `/runners` dashboard page.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `run_id` | INTEGER | PRIMARY KEY | GitHub-assigned workflow run ID |
| `repo` | TEXT | NOT NULL | Full repo name (e.g. `St-John-Software/claws`) |
| `workflow_name` | TEXT | NOT NULL | Display name of the workflow |
| `status` | TEXT | NOT NULL | GitHub run status: `queued`, `in_progress`, `completed`, etc. |
| `conclusion` | TEXT | nullable | Terminal conclusion: `success`, `failure`, `cancelled`, etc. |
| `event` | TEXT | NOT NULL | Trigger event: `push`, `pull_request`, `workflow_dispatch`, etc. |
| `head_branch` | TEXT | nullable | Branch the run was triggered on |
| `created_at` | TEXT | NOT NULL | ISO timestamp when the run was created |
| `run_started_at` | TEXT | nullable | ISO timestamp when the run actually started (after queue wait) |
| `updated_at` | TEXT | NOT NULL | ISO timestamp of last status change |
| `synced_at` | TEXT | NOT NULL, default `datetime('now')` | ISO timestamp when this row was last written by Claws |

### Indexes

- `idx_workflow_runs_repo` on `repo`
- `idx_workflow_runs_status` on `status` — used by `getActiveWorkflowRuns()`
- `idx_workflow_runs_created_at` on `created_at` — used by stats queries and pruning
- `idx_workflow_runs_synced_at` on `synced_at` — used for staleness detection

### Key Query Functions

- `upsertWorkflowRuns(runs)` — bulk `INSERT OR REPLACE` in a transaction
- `deleteWorkflowRun(runId)` — removes a single row by `run_id`; used by the
  runner-metrics-sync reconciliation loop to purge runs GitHub no longer reports
- `getWorkflowRunCount()` — row count; used by runner-metrics-sync to detect
  first-run for initial 7-day backfill
- `getActiveWorkflowRuns()` — returns runs with `status IN ('queued', 'in_progress')`,
  used by runner-metrics-sync to detect Claws activity and identify reconciliation candidates
- `hasRecentlyCompletedTasks(minutesAgo)` — lightweight check against the `tasks`
  table for recent completed/failed tasks, used for activity detection
- `getWorkflowRunStats(days)` — aggregated stats for the dashboard: per-repo
  summary (`repoStats`) and per-`(repo, workflow_name)` breakdown (`workflowStats`,
  grouped by both columns so same-named workflows in different repos remain
  distinct rows). Each `workflowStats` entry carries a `repo` field.
- `getLastWorkflowRunSyncTime()` — returns the most recent `synced_at` value, used
  to detect staleness (>15 min → force a sync even when idle)

### WorkflowRunStats fields

`getWorkflowRunStats(days)` returns `repoStats` and `workflowStats` arrays.
Each entry includes `totalDurationS` — the sum of completed run durations
(seconds), computed via `SUM(julianday(updated_at) - julianday(run_started_at)) * 86400`
filtered to rows with a `conclusion` and non-null `run_started_at`. In-progress
runs contribute 0. `workflowStats` is sorted by `total_duration_s DESC` (most
expensive workflows first).

### Pruning

`pruneWorkflowRuns(retentionDays)` deletes runs with `created_at` older than the
retention period (default: 30 days). Called on startup and daily.

### Adaptive Sync Behavior

`runner-metrics-sync` runs every 2 minutes but gates API calls on activity:
- **Active** (running tasks, recently completed tasks, or active workflow runs): syncs all repos
- **Idle + last sync <15 min ago**: skips API calls entirely (zero cost)
- **Idle + last sync ≥15 min ago**: forces one sync to prevent total staleness

After each full sync, a **stale-run reconciliation** pass checks any rows still
marked `queued`/`in_progress` that were absent from the latest fetch. Each
straggler is queried individually via `gh.fetchWorkflowRunById()` in batches of
5. Runs that GitHub no longer knows about are deleted via `deleteWorkflowRun()`;
runs with an updated status are upserted. This prevents the dashboard from
permanently showing phantom active jobs after cancellation or infrastructure
failure.

## `sessions` table

Persists interactive PTY session metadata so that tmux sessions survive Claws
restarts. Written by `sessions.ts`; reconciled with live tmux sessions by
`recoverSessions()` on startup (re-attaches a fresh PTY bridge for each survivor
and deletes rows whose tmux session is gone).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | UUID session identifier |
| `tmux_name` | TEXT | NOT NULL | tmux session name (e.g. `claws-<id>`) |
| `mode` | TEXT | NOT NULL | One of: `repo-zsh`, `repo-claude`, `worktree-claude`, `home-claude` |
| `repo` | TEXT | nullable | Full repo name (present for repo-scoped modes) |
| `cwd` | TEXT | NOT NULL | Working directory path |
| `worktree_path` | TEXT | nullable | Worktree path for `worktree-claude` sessions |
| `extra_worktrees` | TEXT | nullable | JSON array of additional `{ repo, worktreePath }` for `multi-worktree-claude` sessions |
| `capabilities` | TEXT | nullable | JSON array of selected capability IDs (e.g. `["home-assistant","namey-db"]`); used by `resumeSession` to re-apply env gating and the `--append-system-prompt` capability awareness block |
| `created_at` | INTEGER | NOT NULL | Unix timestamp (ms) when the session was created |

No indexes; row count is small (max 5 sessions at a time). No pruning —
rows are deleted explicitly when a session is killed.

## `verification_reports` table

Stores connectivity verification results written by `runConnectivityVerification()`.
Each row holds a JSON `payload` with per-check pass/fail results (database,
GitHub App, CLIs — `gh`, `claude`, `codex`, `opencode` — OpenRouter, Slack
webhook DNS, IMAP login/logout, per-runner SSH, datasette SSH, Ollama, namey
PostgreSQL, WhatsApp auth). Each check is wrapped in a 30 s timeout.
Used by the `/verify` dashboard page and the `GET /api/activation` endpoint.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Auto-increment ID |
| `ts` | INTEGER | NOT NULL | Unix timestamp (ms) when the check ran |
| `payload` | TEXT | NOT NULL | JSON blob with per-check results |

### Indexes

- `idx_verification_reports_ts` on `ts` — used by `getLatestVerificationReport()`

Only the most recent row is queried (`ORDER BY ts DESC LIMIT 1`). No pruning
defined; report volume is low (once per boot in verify-only mode, or on-demand
via `POST /api/verify/run`).

## `work_queue` table

SQLite-backed agent dispatch queue. Dispatcher jobs (`issue-dispatcher`,
`pr-dispatcher`) insert rows here; `worker.ts` fibers claim and execute them.
Replaces the former `agent_dispatches` table.

**Source**: `src/db.ts`, `src/worker.ts`, `src/work-handlers.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique work item identifier |
| `kind` | TEXT | NOT NULL | Agent kind string — see `AGENT_KINDS` in `worker.ts` |
| `repo` | TEXT | NOT NULL | Full repo name (e.g. `St-John-Software/claws`) |
| `item_number` | INTEGER | NOT NULL | Issue or PR number being processed (0 for repo-level items) |
| `args_json` | TEXT | NOT NULL DEFAULT `'{}'` | Optional JSON payload for the handler |
| `priority` | INTEGER | NOT NULL DEFAULT 0 | Non-zero for `Priority`-labelled items |
| `status` | TEXT | NOT NULL DEFAULT `'queued'` | `queued` / `running` / `completed` / `failed` |
| `pid` | INTEGER | nullable | PID of the worker that claimed this row |
| `attempts` | INTEGER | NOT NULL DEFAULT 0 | Number of claim attempts |
| `error_message` | TEXT | nullable | Error message on failure |
| `enqueued_at` | TEXT | NOT NULL | ISO timestamp of insertion |
| `started_at` | TEXT | nullable | ISO timestamp when claimed |
| `completed_at` | TEXT | nullable | ISO timestamp when completed or failed |
| `run_id` | TEXT | nullable | UUID of the parent job run |

### Indexes

- `idx_work_queue_dispatch` on `(status, priority DESC, id ASC)` — the claim
  ordering index: highest-priority, oldest-enqueued rows are claimed first.
- `idx_work_queue_active` — UNIQUE on `(kind, repo, item_number) WHERE status IN ('queued', 'running')`:
  the idempotency index. `enqueueWork()` uses `INSERT OR IGNORE` so a second
  enqueue for the same in-flight item no-ops silently.

### Key Helpers

- `enqueueWork(kind, repo, itemNumber, opts)` — `INSERT OR IGNORE`; returns
  `{ id, alreadyQueued }`. Atomicity provided by the UNIQUE partial index.
- `claimNextWork(runId)` — atomically transitions the highest-priority oldest
  `queued` row to `running`; returns the row or `null` when the queue is empty.
- `markWorkSucceeded(id)` / `markWorkFailed(id, error)` — terminal status updates.
- `recoverWorkOnStartup()` — resets all `running` rows to `queued` on startup
  (crash recovery); returns `{ resetRunning: number }`.
- `pruneWorkQueue()` — deletes `completed`/`failed` rows older than 7 days.
- `countWorkByStatus()` / `countActiveWorkExcludingKinds(excluded)` — observability
  helpers used by `isClawsBusy()` and the dashboard.
- `hasActiveWorkForPR(repo, prNumber, skipKinds)` — returns `true` if any
  `queued`/`running` row for the given PR has a `kind` not in `skipKinds`;
  used by `AUTO_MERGER_SWEEP` to skip PRs with active agent work.
- `clearWorkQueueForTests()` — test-only truncate helper.

### Design Invariants

- **Crash recovery via status reset**: unlike the former `agent_dispatches` which
  used PID-scoped cleanup, `work_queue` recovers by resetting all `running` rows to
  `queued` on startup — restarting rather than dropping in-flight work.
- **Pruning**: completed/failed rows are pruned on a 7-day schedule; the queue does
  not grow unboundedly.
- Row lifetime: `enqueueWork()` → `claimNextWork()` → handler runs →
  `markWorkSucceeded()` / `markWorkFailed()`.

## `processed_repos_daily` table

Daily per-repo processing ledger used by the smart-scheduling system
(`smart-schedule.ts`). Tracks which repos each smart-scheduled job has already
processed on a given calendar day, so the hourly tick selects only repos not yet processed today.

**Source**: `src/db.ts`, `src/smart-schedule.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `job_name` | TEXT | NOT NULL | Smart-scheduled job name (e.g. `doc-maintainer`, `improvement-identifier`) |
| `repo` | TEXT | NOT NULL | Full repo name (e.g. `St-John-Software/claws`) |
| `local_date` | TEXT | NOT NULL | Calendar date string `YYYY-MM-DD` in server local time |
| `processed_at` | TEXT | NOT NULL, default `datetime('now')` | ISO timestamp when the repo was marked processed |

**Primary key**: `(job_name, repo, local_date)` — ensures one entry per job/repo/day.

### Indexes

- `idx_processed_repos_daily_date` on `local_date` — used by pruning.

### Key Helpers

- `markRepoProcessedDaily(jobName, repo, localDate)` — `INSERT OR IGNORE`; silently
  no-ops if the repo was already recorded today (safe to call multiple times).
- `getReposProcessedOn(jobName, localDate): Set<string>` — returns the set of repo
  full names already processed by the given job on the given date; used by
  `selectReposForTick()` in `smart-schedule.ts`.
- `getLastProcessedDatesForJob(jobName): Map<string, string>` — returns a map of
  repo full name → most-recent `local_date` (`YYYY-MM-DD`) for the given job, across
  all dates. Used by `selectReposForTick()` to sort candidate repos by
  least-recently-processed first (fairness — prevents starvation of repos at the end
  of the installation listing when per-night capacity is below the total repo count).
- `pruneProcessedReposDailyOlderThan(daysToKeep)` — deletes rows with
  `local_date < date('now', '-N days')`; called on startup and daily alongside other
  pruning tasks. Returns the count deleted.

### Design Notes

- Only successful repo processing marks a daily slot. Skip statuses (no work needed,
  job disabled for repo, etc.) do not call `markRepoProcessedDaily()`, so those repos
  remain eligible for retry in a later tick if the situation changes.
- `localDateString()` in `smart-schedule.ts` builds the date string from server local
  time (`new Date()`), not UTC. This matches the intent of "off-hours" being relative
  to the operator's timezone.

## `ha_upgrader_state` table

Tracks the lifecycle of each Home Assistant update entity observed by the `ha-upgrader` job.
Used by `getAllHaUpgraderStates()` to populate the `/ha-upgrader` dashboard page.

**Source**: `src/db.ts`, `src/jobs/ha-upgrader.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `entity_id` | TEXT | PRIMARY KEY | HA entity ID (e.g. `update.home_assistant_core`) |
| `version` | TEXT | NOT NULL | Latest available version string at last observation |
| `first_seen_at` | INTEGER | NOT NULL | Unix timestamp (ms) when the pending update was first detected |
| `attempted_at` | INTEGER | NOT NULL, default `0` | Unix timestamp (ms) of the last install attempt (`0` = never attempted) |
| `failure_count` | INTEGER | NOT NULL, default `0` | Number of consecutive install failures |

### Key Helpers

- `getHaUpgraderState(entityId)` — returns the row or `null`.
- `upsertHaUpgraderFirstSeen(entityId, version, now)` — inserts on first observation; updates `version` and `first_seen_at` when a new version is detected for an already-tracked entity.
- `recordHaUpgraderAttempt(entityId, success, now)` — records a completed install attempt: resets `failure_count` to 0 and sets `attempted_at` on success; increments `failure_count` on failure.
- `getAllHaUpgraderStates()` — returns all rows ordered by `entity_id`; used by the `/ha-upgrader` dashboard page to render pending/applied/failing/blocked sections.
- `clearHaUpgraderStateForTests()` — test-only truncate helper.

### Dashboard Categorization

`src/pages/ha-upgrader.ts` categorizes each row into one of:
- `failed-blocked` — `failure_count >= 3`
- `failing` — `failure_count > 0 && < 3`
- `applied` — `attempted_at > 0 && failure_count === 0`
- `pending-dwell` — never attempted and dwell window not yet elapsed (`first_seen_at + dwellMs > now`)
- `pending-ready` — dwell window elapsed; waiting on next run

High-risk entities (`update.home_assistant_{core,supervisor,operating_system,os}`) use a 48-hour dwell window; all others use 24 hours.

## `notified_untrusted_actors` table

Durable deduplication table for untrusted-actor skip notifications in the
issue-dispatcher. Prevents the same blocked issue from triggering repeated
Slack messages and `[disallowed-actor]` alert filings across Claws restarts.
Unlike an in-memory `Set`, rows survive process restarts.

**Source**: `src/db.ts`, `src/jobs/issue-dispatcher.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `repo` | TEXT | NOT NULL, part of PK | Full repo name (e.g. `St-John-Software/claws`) |
| `issue_number` | INTEGER | NOT NULL, part of PK | Issue number that was skipped |
| `notified_at` | TEXT | NOT NULL, default `datetime('now')` | ISO timestamp when the first notification was sent |

**Primary key**: `(repo, issue_number)` — ensures at-most-one record per blocked issue.

### Key Helper

- `markUntrustedActorNotified(repo, issueNumber): boolean` — `INSERT OR IGNORE`; returns `true` if this is the first time (row inserted, caller should send Slack message and file GitHub alert), `false` if already notified (row existed, caller stays silent).

### Design Notes

- No pruning defined; volume is bounded by the number of distinct non-allowed-actor issues ever seen.
- The GitHub alert issue (one per actor login, occurrence-tracked via `ensureAlertIssue`) is separate from this table — the table deduplicates per item, the alert issue tracks per actor.
