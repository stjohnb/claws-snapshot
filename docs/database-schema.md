# Database Schema

**Deep dive.** Every table, column and index; open only when adding or
migrating a table. For everything else about a module, see modules.md instead.

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
| `provider_used` | TEXT | nullable | AI provider used for this task (e.g. `claude`, `opencode`). Set via `updateTaskProvider()` — from `trackTaskTokens`' third callback argument at every agent call site, or from `onProviderUsed` in issue-worker. |
| `tokens_used` | INTEGER | nullable | Total tokens consumed. Set via `updateTaskTokenUsage()` when the provider exposes usage data. Claude and OpenCode report both tokens and cost; Codex reports token counts via its `turn.completed` event but no price. |
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
- `idx_tasks_repo_item` on `(repo, item_number)` — used by the per-item
  hot-path queries (`countCIFixerAttempts`, `countRecentTimeouts`,
  `getRunsForIssue`, `getRecentTasksForRepo`, …)

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

### Retention

`pruneTasks(retentionDays)` deletes `completed`/`failed` rows older than the
retention period (default: 90 days) on startup and daily alongside
`pruneOldLogs()`. `running` rows and rows belonging to a still-retained
`job_runs` row are never deleted.

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
- `getAllAverageTaskDurations(limit)` queries the `tasks` table (not this
  table) for the average duration of the last N completed tasks per job-name
  prefix, returned as a `Record<jobPrefix, avgMs>` and used for ETA
  calculations on the queue page

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
| `head_sha` | TEXT | nullable | Commit the run was triggered on; `main-build-monitor` compares it to the branch tip before re-running |
| `html_url` | TEXT | nullable | Link to the run on GitHub |
| `run_attempt` | INTEGER | nullable | GitHub's attempt counter; `main-build-monitor` re-runs only attempt 1 |
| `synced_at` | TEXT | NOT NULL, default `datetime('now')` | ISO timestamp when this row was last written by Claws |

### Indexes

- `idx_workflow_runs_repo` on `repo`
- `idx_workflow_runs_status` on `status` — used by `getActiveWorkflowRuns()`
- `idx_workflow_runs_created_at` on `created_at` — used by stats queries and pruning
- `idx_workflow_runs_synced_at` on `synced_at` — used for staleness detection

### Key Query Functions

- `upsertWorkflowRuns(runs)` — bulk `INSERT OR REPLACE` in a transaction
- `getDefaultBranchRuns(repo, branch, sinceDays)` — completed `push`/`schedule` runs on a
  branch, newest first; backs `main-build-monitor`. `workflow_dispatch` is excluded on
  purpose — a human pressing "Run workflow" should see their own failure
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
`recoverSessions()` on startup (re-attaches a fresh PTY bridge for each survivor).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | UUID session identifier |
| `tmux_name` | TEXT | NOT NULL | tmux session name (e.g. `claws-<id>`) |
| `mode` | TEXT | NOT NULL | One of: `repo-zsh`, `repo-claude`, `worktree-claude`, `home-claude`, `multi-worktree-claude` |
| `repo` | TEXT | nullable | Full repo name (present for repo-scoped modes) |
| `cwd` | TEXT | NOT NULL | Working directory path |
| `worktree_path` | TEXT | nullable | Worktree path for `worktree-claude` sessions |
| `extra_worktrees` | TEXT | nullable | JSON array of additional `{ repo, worktreePath }` for `multi-worktree-claude` sessions |
| `capabilities` | TEXT | nullable | JSON array of selected capability IDs (e.g. `["home-assistant","prod-infra"]`); used by `resumeSession` to re-apply env gating and the `--append-system-prompt` capability awareness block |
| `created_at` | INTEGER | NOT NULL | Unix timestamp (ms) when the session was created |
| `summary` | TEXT | nullable | One-line description of session activity — either model-generated and refreshed while idle (see below), or user-authored via `POST /sessions/:id/description` |
| `summary_updated_at` | INTEGER | nullable | Unix timestamp (ms) of the last summary refresh |
| `ended_at` | INTEGER | nullable | Unix timestamp (ms) when the session's tmux process exited; `NULL` means the session is still live. Setting this (rather than deleting the row) retains the session as browsable/resumable history |
| `resume_repos` | TEXT | nullable | JSON array of repo full names needed to reconstruct worktrees for an ended session on resume |
| `summary_manual` | INTEGER | NOT NULL DEFAULT 0 | `1` when the description was set by hand via `POST /sessions/:id/description` (API-only since #2826); pinned — the auto-summariser skips the session and `updateSessionSummary` is a no-op. Cleared back to `0` by saving an empty description or by `POST /sessions/:id/resummarize` |

No indexes; row count of *live* sessions is small (max 5 at a time). Both a
normal process exit and the "End" button (`killSession`) set `ended_at` and
retain the row as history rather than deleting it; ended sessions are pruned
to the most recent `MAX_ENDED_SESSIONS` (50) via `pruneEndedSessions()`. A row
is deleted outright only via the explicit "Delete" action (`deleteSession`,
`POST /sessions/:id/delete`) or when a bridge respawn is abandoned before the
session ever became resumable history.

## `verification_reports` table

Stores connectivity verification results written by `runConnectivityVerification()`.
Each row holds a JSON `payload` with per-check pass/fail results (database,
GitHub App, CLIs — `gh`, `claude`, `codex`, `opencode` — OpenRouter, Slack
webhook DNS, IMAP login/logout, per-runner SSH, Ollama,
WhatsApp auth). Each check is wrapped in a 30 s timeout.
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

## `ha_deploy_watcher_state` table

Tracks the last-notified `git-pull` addon commit SHA per addon, so `ha-deploy-watcher`
posts a Slack notification only once per new deploy rather than on every 5-minute poll.

**Source**: `src/db.ts`, `src/jobs/ha-deploy-watcher.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `addon_slug` | TEXT | PRIMARY KEY | HA Supervisor addon slug being watched |
| `last_notified_sha` | TEXT | NOT NULL | Short commit SHA last reported in a Slack notification |
| `last_seen_at` | INTEGER | NOT NULL | Unix timestamp (ms) of the last observation |

### Key Helpers

- `getHaDeployWatcherState(addonSlug)` — returns the row or `null`; a `null` result means this is the first observation for the addon, which baselines silently (no notification).
- `upsertHaDeployWatcherState(addonSlug, sha, now)` — upserts the notified SHA and observation timestamp after posting (or baselining).

## `ha_entity_unavailable` table

Tracks how long a Home Assistant entity has been continuously absent or
`unavailable`/`unknown`, so `ha-backup-monitor` can measure its 48h
"monitor is blind" window from first-seen-unavailable rather than from
`HAState.last_changed` — HA Core restarts (including ones `ha-upgrader`
performs) reset a template entity's `last_changed`, so a window measured
from it could never elapse.

**Source**: `src/db.ts`, `src/jobs/ha-backup-monitor.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `entity_id` | TEXT | PRIMARY KEY | Home Assistant entity id being tracked (e.g. `binary_sensor.backup_overdue`) |
| `first_seen_at` | INTEGER | NOT NULL | Unix timestamp (ms) the entity was first observed unavailable, continuously |

### Key Helpers

- `recordHaEntityUnavailable(entityId, now)` — inserts a row on first observation (`ON CONFLICT DO NOTHING`), then returns the recorded `first_seen_at` so callers can measure elapsed time without a second query.
- `clearHaEntityUnavailable(entityId)` — deletes the row once the entity is observed available again, resetting the clock for the next outage.
- `clearHaEntityUnavailableForTests()` — test-only truncate helper.

## `doc_intent_backfill` table

Watermark for `doc-maintainer`'s human-intent history walk (#2227). The intent pass
walks each repo's closed issues and merged PRs **backwards** in dated chunks across
successive nightly runs — a single unbounded pass would need thousands of per-item
comment fetches — so it needs durable state for how far back it has reached.

**Source**: `src/db.ts`, `src/jobs/doc-maintainer.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `repo` | TEXT | PRIMARY KEY | Full repo name (e.g. `St-John-Software/claws`) |
| `oldest_scanned` | TEXT | | Oldest `YYYY-MM-DD` the walk has reached; `NULL` when the repo had no items to scan |
| `complete` | INTEGER | NOT NULL, default `0` | `1` once a chunk exhausted the remaining history |
| `window_exhausted` | INTEGER | NOT NULL, default `0` | `1` once the walk consumed everything the fixed `gh list` window can reach while older history remains beyond it |
| `memory_digest` | TEXT | | SHA-256 of the provider memory files last folded into docs; a change re-triggers the repo even when HEAD hasn't moved (#2666) |
| `updated_at` | TEXT | NOT NULL, default `datetime('now')` | ISO timestamp of the last chunk |

### Key Helpers

- `getIntentBackfillState(repo)` — returns `{ oldestScanned, complete, windowExhausted }` or `null`; a `null` result means the walk has never started for that repo, so the next run takes its first chunk.
- `recordIntentBackfillChunk(repo, oldestScanned, complete, windowExhausted)` — upsert called **after** the agent pass returns, so a crash or timeout re-does the chunk rather than skipping it.
- `getDocMemoryDigest(repo)` / `recordDocMemoryDigest(repo, digest)` — round-trip the last-folded memory digest, touching only that column so it never disturbs the intent-backfill watermark on the same row.

### Design Notes

- The next chunk filters to items dated strictly `< oldest_scanned`. A chunk never stops mid-date — it is extended past the 250-item cap to swallow every item sharing its oldest date — so the strict filter can't strand the remainder of a busy day's items on the far side of the watermark forever.
- `complete` and `window_exhausted` are two distinct terminal states. `complete` means all history was walked; `window_exhausted` means the walk ran out of items only because `gh list` returns a fixed top-N window (3,000 per category), so history older than that window was never seen. Both stop the walk (re-fetching the same window can never reach further back), but the second is a warning-level outcome — raise the fetch limit or add pagination, then clear `window_exhausted` to resume.
- While both flags are `0`, `doc-maintainer` also bypasses its "HEAD unchanged → skip" fast path, so a dormant repo's history still gets covered.
- If the unbounded `gh` list fails, the row is left untouched and the chunk is retried on the next run.

## `ci_fixer_breaker` table

Per-PR circuit-breaker bookkeeping for the ci-fixer. Backs the "new commit
pushed after the PR was marked problematic earns a fresh attempt budget" rule,
and the budget floor that stops pre-trip attempts from immediately re-tripping
the breaker after a label removal.

**Source**: `src/db.ts`, `src/agents/ci-fixer.ts`, `src/agents/problematic-pr-diagnoser.ts`, `src/server.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `repo` | TEXT | NOT NULL, part of PK | Full repo name (e.g. `St-John-Software/claws`) |
| `item_number` | INTEGER | NOT NULL, part of PK | PR number |
| `tripped_sha` | TEXT | nullable | Head SHA when the breaker tripped; `NULL` once a grant or reset clears the trip. No value ⇒ no automatic grant (fail-closed) |
| `tripped_at` | TEXT | nullable | ISO timestamp of the trip |
| `last_claws_sha` | TEXT | nullable | Head SHA of the most recent push Claws made to the branch — guards against Claws granting itself a fresh budget off its own fix commits |
| `budget_floor_at` | TEXT | nullable | ISO timestamp floor for `countCIFixerAttempts` — attempts started before it don't count toward `maxAttempts` |
| `grants` | INTEGER | NOT NULL, default `0` | Lifetime new-commit grants used, capped by `ciFixerCircuitBreaker.maxCommitGrants` |

**Primary key**: `(repo, item_number)` — one row per PR.

### Key Helpers

- `getCIFixerBreakerState(repo, prNumber)` — returns the row (camelCased) or `undefined` when the breaker never tripped for this PR.
- `recordCIFixerBreakerTrip(repo, prNumber, headSha)` — upserts `tripped_sha`/`tripped_at` only; deliberately preserves `grants`, `budget_floor_at` and `last_claws_sha` so a re-trip can't wipe the lifetime grant count.
- `recordCIFixerPush(repo, prNumber, headSha)` — upserts `last_claws_sha` only.
- `recordCIFixerBreakerGrant(repo, prNumber, { recovered })` — clears the trip, advances `budget_floor_at`, and either resets `grants` to 0 (`recovered: true`, the new head is green) or spends one grant.
- `resetCIFixerBreakerGrants(repo, prNumber)` — full reset used when a human or the diagnoser clears the `Claws Problematic` label.

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

## `reminder_notifications` table

Durable dedup table for `reminder-monitor` (#2355). Prevents a reminder from being
re-filed as a new GitHub issue on every daily tick once it has fired, while still
allowing a re-armed reminder (a later commit bumping `notify_on`) to fire again.

**Source**: `src/db.ts`, `src/jobs/reminder-monitor.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `repo` | TEXT | NOT NULL, part of PK | Full repo name the reminder file lives in |
| `reminder_id` | TEXT | NOT NULL, part of PK | Reminder `id` from frontmatter (defaults to the filename) |
| `notify_on` | TEXT | NOT NULL, part of PK | `YYYY-MM-DD` from frontmatter — included in the key so bumping this date arms the next cycle |
| `issue_number` | INTEGER | nullable | The filed issue's number |
| `created_at` | TEXT | NOT NULL, default `datetime('now')` | ISO timestamp the row was written |

**Primary key**: `(repo, reminder_id, notify_on)`.

### Key Helpers

- `hasReminderFired(repo, reminderId, notifyOn): boolean` — checked before filing; a hit means this exact `(repo, reminder, notify_on)` triple already fired.
- `recordReminderFired(repo, reminderId, notifyOn, issueNumber): void` — `INSERT OR IGNORE`, called immediately after the issue is created.

### Design Notes

- No pruning defined; volume is bounded by the number of distinct reminders ever fired across all repos.
- See [reminder-monitor](jobs/reminder-monitor.md) for the full firing/dedup behavior this table backs.

## `main_build_failures` table

Durable state for the `main-build-monitor` job (#2778). One row per failing default-branch
run, recording whether Claws re-ran it, how that retry ended, and whether a tracking issue
was filed — so a restart neither re-runs a run twice nor re-files an issue.

**Source**: `src/db.ts`, `src/jobs/main-build-monitor.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `run_id` | TEXT | PRIMARY KEY | Run ID of the failing run; GitHub run ID, or `forgejo:<id>` for Forgejo repos |
| `repo` | TEXT | NOT NULL | Full repo name |
| `workflow_name` | TEXT | NOT NULL | Display name of the workflow that failed |
| `run_url` | TEXT | NOT NULL | Link to the failing run |
| `detected_at` | TEXT | NOT NULL, default `datetime('now')` | ISO timestamp the monitor first saw the failure |
| `retried` | INTEGER | NOT NULL, default `0` | 1 when Claws re-ran the failed jobs |
| `outcome` | TEXT | nullable | `NULL` only while a retry is in flight; otherwise `success`, `failure`, `abandoned`, `not-retried`, `rerun-errored` or `retry-timed-out` |
| `reported` | INTEGER | NOT NULL, default `0` | 1 once a `Build failure: <workflow>` issue was filed or bumped |
| `closed_at` | TEXT | nullable | Set when a later green run of the same workflow closed the tracking issue |
| `event` | TEXT | NOT NULL, default `''` | The triggering event (`push`/`schedule`) of the failing run, quoted verbatim in the issue body |

### Indexes

- `idx_main_build_failures_wf` on `(repo, workflow_name)` — used by the reported/closed lookups

### Key Helpers

- `recordMainBuildFailure(runId, repo, workflowName, runUrl, retried, outcome, event)` — `INSERT OR IGNORE`
- `hasMainBuildFailure(runId)` — the "already handled this run" guard
- `getPendingMainBuildRetries()` — retries in flight from the last 24 h, oldest first
- `getExpiredMainBuildRetries()` — retries that fell out of that 24h window without ever
  resolving; `run()` forces these to `retry-timed-out` so they still get reported
- `setMainBuildRetryOutcome(runId, outcome)` / `markMainBuildReported(runId)`
- `getUnreportedMainBuildFailures()` — terminal-outcome rows that never got `reported = 1`
  (an earlier `ensureAlertIssue` call threw), retried every pass
- `hasUnclosedReportedFailure(repo, workflowName)` / `markMainBuildFailuresClosed(repo, workflowName)`
- `pruneMainBuildFailures(retentionDays = 30)` — called from the daily prune loop in `main.ts`

## `upstream_watch_fires` table

Durable dedup table for `upstream-watcher` (#2617). Records that a watch has already
unparked its target issue, so a human re-applying `Claws Ignore` later does not cause a
re-comment loop on the next daily tick.

**Source**: `src/db.ts`, `src/jobs/upstream-watcher.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `watch_id` | TEXT | NOT NULL, part of PK | Watch `id` from the YAML file (defaults to the filename stem) |
| `repo` | TEXT | NOT NULL, part of PK | Full repo name of the parked target issue |
| `issue_number` | INTEGER | NOT NULL, part of PK | The parked target issue's number |
| `fired_at` | TEXT | NOT NULL, default `datetime('now')` | ISO timestamp the watch fired |

**Primary key**: `(watch_id, repo, issue_number)`.

### Key Helpers

- `hasUpstreamWatchFired(watchId, repo, issueNumber): boolean` — checked first thing per watch; a hit skips the watch entirely, making zero GitHub calls.
- `recordUpstreamWatchFired(watchId, repo, issueNumber): void` — `INSERT OR IGNORE`, written *last* in the fire sequence so a mid-way failure simply retries the (idempotent) label writes next run.

### Design Notes

- Unlike `reminder_notifications`, the key carries no date component — a watch fires exactly once per target issue, and re-arming is done by editing or deleting the watch file (or by renaming it, which changes the default `id`).
- A closed target issue is skipped *without* writing a row, so reopening the issue re-arms the watch.
- No pruning defined; volume is bounded by the number of watches ever fired.
- See [upstream-watcher](jobs/upstream-watcher.md) for the full firing/dedup behavior this table backs.

## `blog_draft_ports` table

Durable dedup table for `blog-draft-scanner` (#2560). Prevents a draft blog post from
being re-filed as a new port issue in `bstjohn-blog` on every daily tick once it has
fired, even if the draft is edited or its title changes afterwards.

**Source**: `src/db.ts`, `src/jobs/blog-draft-scanner.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `repo` | TEXT | NOT NULL, part of PK | Full name of the repo the draft lives in |
| `path` | TEXT | NOT NULL, part of PK | Path of the draft file within that repo |
| `issue_number` | INTEGER | nullable | The filed port issue's number in `bstjohn-blog` |
| `created_at` | TEXT | NOT NULL, default `datetime('now')` | ISO timestamp the row was written |

**Primary key**: `(repo, path)` — deliberately not the blob sha, so editing a draft
after the port issue is filed does not re-file it.

### Key Helpers

- `hasBlogDraftPortFiled(repo, path): boolean` — checked before filing; a hit means this exact `(repo, path)` pair already fired.
- `recordBlogDraftPortFiled(repo, path, issueNumber): void` — `INSERT OR IGNORE`, called immediately after the issue is created (or found via `findIssueByExactTitle`).

### Design Notes

- No pruning defined; volume is bounded by the number of distinct drafts ever ported across all repos.
- See [blog-draft-scanner](jobs/blog-draft-scanner.md) for the full scanning/dedup behavior this table backs.

## `promotion_actions` table

Append-only history of the promotion issues `site-promoter` has filed (#2854). It is the
job's cadence gate: a channel is not due again until `cadence_days` have passed since its
newest row.

**Source**: `src/db.ts`, `src/jobs/site-promoter.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `repo` | TEXT | NOT NULL | Full name of the repo whose manifest declared the site |
| `site_id` | TEXT | NOT NULL | The site's `id` within that manifest |
| `channel_id` | TEXT | NOT NULL | Channel the action was filed for, e.g. `reddit` |
| `target_repo` | TEXT | NOT NULL | Repo the issue was actually filed into — `repo` unless the channel sets `target_repo` |
| `issue_number` | INTEGER | nullable | The filed issue's number in `target_repo` |
| `title` | TEXT | NOT NULL | The filed issue's title |
| `filed_at` | TEXT | NOT NULL, default `datetime('now')` | UTC timestamp the row was written |

**No primary key** — deliberately. Every filing appends a row, so the table doubles as an
audit trail of what has been promoted where.

### Key Helpers

- `recordPromotionActionFiled(repo, siteId, channelId, targetRepo, issueNumber, title): void` — appends one row, called immediately after `createIssue` succeeds.
- `getPromotionActionTimestamps(repo, siteId): Map<string, string>` — `MAX(filed_at)` per `channel_id` for one site; what `dueChannels` reads. Values are UTC without a zone suffix, so callers normalize with `ts.replace(" ", "T") + "Z"` before `Date.parse`.

### Design Notes

- This, not title search, is what stops a closed or rejected action being re-filed —
  `findIssueByExactTitle` only sees open issues.
- Renaming a site's `id` or a channel's id resets that cadence, since the id is the key.
- No pruning defined; volume is bounded by the per-site caps (≤2 actions per site per run,
  cadences of 14–180 days).
- See [site-promoter](jobs/site-promoter.md) for the full selection and filing behavior.

## `damp_readings` table

Logged damp-meter readings for a fixed set of measurement points around the house (#1819),
rendered on the `/damp` dashboard page. Storage was deliberately kept in Claws' own SQLite DB
rather than Home Assistant — self-contained, testable, and matches the existing
`db.ts` + `pages/*` + `server.ts` route pattern used by `ha-upgrader` and `k8s`; an HA export
would require ephemeral `POST /api/states` entities plus committed template sensors and was
judged more fragile for no real benefit.

**Source**: `src/db.ts`, `src/pages/damp.ts`, `src/jobs/damp-reminder.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Row ID |
| `location` | TEXT | NOT NULL | Measurement location (e.g. `"Downstairs toilet"`, `"Hall Closet"`) — one of the `location` values in `DAMP_POINTS` (`src/pages/damp.ts`) |
| `point` | TEXT | NOT NULL | Measurement point within the location (e.g. `"N"`, `"Manifold"`, `"utility"`) |
| `value` | REAL | NOT NULL | Meter reading |
| `reading_date` | TEXT | NOT NULL | `YYYY-MM-DD` — the date the reading is *for*, as entered on the form |
| `recorded_at` | TEXT | NOT NULL | Full ISO timestamp the row was written |

### Indexes

- `idx_damp_readings_point` on `(location, point)` — used by trend queries that group by measurement point.
- `idx_damp_readings_date` on `reading_date DESC` — used by the recent-history query.

### Key Helpers

- `upsertDampReading(location, point, value, readingDate, recordedAt)` — updates the existing row for a `(location, point, reading_date)` key, inserting one if absent; called once per non-empty form field by the `POST /damp/log` handler.
- `getRecentDampReadings(limit = 200)` — returns the most recent rows across all points (`ORDER BY reading_date DESC, recorded_at DESC, location, point`), used for the `/damp` recent-history table.
- `getDampTrendRows()` — returns every row ordered by `(location, point, reading_date DESC, recorded_at DESC)`; `pages/damp.ts` walks this per point and takes the first two rows to compute a latest-value / previous-value / delta trend row. Not windowed with SQL — fine for a home logging volume, intentionally not over-engineered with window functions.

### Design Notes

- Readings are keyed by the `(location, point)` string pair, not by array index into `DAMP_POINTS` — inserting a new point anywhere in that array (as #1824 did for `("Hall Closet", "utility")`) cannot corrupt or relabel existing rows.
- `initDb()` seeds a one-time idempotent backfill row for `("Hall Closet", "utility")` — value `0.5`, dated `2026-07-02` — guarded by a `COUNT(*) = 0` check, since that point was added to `DAMP_POINTS` after the other 14 points' first readings had already been logged through the UI (#1824).

## `dmarc_reports` table

One row per ingested DMARC aggregate report (#2741). Written by
[`dmarc-monitor`](jobs/dmarc-monitor.md), which runs as a handler inside `email-monitor`
when a report lands in the Claws mailbox.

**Source**: `src/db.ts`, `src/dmarc.ts`, `src/jobs/dmarc-monitor.ts`, `src/pages/dmarc.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `org_name` | TEXT | PRIMARY KEY (with `report_id`) | Reporting organisation from `report_metadata/org_name`, e.g. `google.com` |
| `report_id` | TEXT | PRIMARY KEY (with `org_name`) | The reporter's own report ID — unique only within that reporter, hence the composite key |
| `report_email` | TEXT | NOT NULL DEFAULT `''` | Reporter contact address from `report_metadata/email` |
| `domain` | TEXT | NOT NULL | The domain the policy applies to, from `policy_published/domain` — lowercased. Everything is keyed on this, never on a hard-coded domain |
| `date_begin` | TEXT | NOT NULL | Report window start, ISO-8601 UTC (converted from epoch seconds at parse time) |
| `date_end` | TEXT | NOT NULL | Report window end, ISO-8601 UTC |
| `policy_p` | TEXT | NOT NULL DEFAULT `''` | Published `p=` (`none`/`quarantine`/`reject`) |
| `policy_sp` | TEXT | NOT NULL DEFAULT `''` | Published subdomain policy `sp=` |
| `policy_adkim` | TEXT | NOT NULL DEFAULT `''` | DKIM alignment mode — `s` (strict) or `r` (relaxed) |
| `policy_aspf` | TEXT | NOT NULL DEFAULT `''` | SPF alignment mode |
| `policy_pct` | INTEGER | nullable | Published `pct=`; **NULL** when the reporter omits it, so a missing value is not mistaken for a policy change |
| `row_count` | INTEGER | NOT NULL DEFAULT 0 | Number of `<record>` elements — zero is valid |
| `received_at` | TEXT | NOT NULL | ISO timestamp Claws ingested the report |
| `raw_xml` | TEXT | NOT NULL | The decompressed report, kept so the original is retrievable; truncated to 256 KB (with a trailing marker comment) if larger |

### Indexes

- `idx_dmarc_reports_domain` on `(domain, date_begin DESC)` — backs the "latest report for this domain" lookup that detects published-policy drift.

### Key Helpers

- `hasDmarcReport(orgName, reportId)` — idempotency check; `insertDmarcReport` short-circuits on it so a re-forwarded report neither duplicates rows nor re-alerts.
- `insertDmarcReport(report, rawXml, receivedAt)` — writes the report row plus one `dmarc_rows` row per record in a single transaction. Returns `false` without writing when the report is already present.
- `getLatestDmarcReportForDomain(domain)` — most recent report for a domain (`ORDER BY date_begin DESC, received_at DESC LIMIT 1`); captured *before* an insert so the policy-drift comparison never sees the report being ingested.
- `getLatestDmarcReportsPerReporter()` — one row per `(domain, org_name)` pair for the `/dmarc` "is anything still arriving?" table.
- `getDmarcReportXml(orgName, reportId)` — the **only** read path that selects `raw_xml`.
- `pruneDmarcReports(retentionDays = 365)` — deletes reports (and their `dmarc_rows`) with `received_at` older than the window, mirroring `pruneWorkflowRuns`. Run from `main.ts` daily and at startup.

### Design Notes

- `raw_xml` lives here and deliberately **not** on `dmarc_rows`: every other read path selects an explicit column list that excludes it, so `SELECT *` on the hot row table never drags a full report body along.
- Epoch seconds are converted to ISO-8601 UTC at parse time rather than stored raw, so `date_begin` sorts and range-filters lexicographically in plain SQL.

## `dmarc_rows` table

One row per `<record>` in a report, with the report's domain and window denormalised so
the dashboard and alerting queries never need a join (#2741).

**Source**: `src/db.ts`, `src/dmarc.ts`, `src/pages/dmarc.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Row ID |
| `org_name` | TEXT | NOT NULL, UNIQUE (with `report_id`, `row_index`) | Reporting organisation — links back to `dmarc_reports` |
| `report_id` | TEXT | NOT NULL, UNIQUE (with `org_name`, `row_index`) | Reporter's report ID |
| `row_index` | INTEGER | NOT NULL, UNIQUE (with `org_name`, `report_id`) | Position of the `<record>` within the report; makes re-insertion of the same report a constraint violation rather than a silent duplicate |
| `domain` | TEXT | NOT NULL | Denormalised from the report's `policy_published/domain` |
| `date_begin` | TEXT | NOT NULL | Denormalised report window start, ISO-8601 UTC |
| `date_end` | TEXT | NOT NULL | Denormalised report window end, ISO-8601 UTC |
| `source_ip` | TEXT | NOT NULL | Sending IP the reporter observed |
| `count` | INTEGER | NOT NULL | Number of messages this row aggregates |
| `disposition` | TEXT | NOT NULL DEFAULT `''` | Policy applied by the receiver — `none`/`quarantine`/`reject` |
| `eval_dkim` | TEXT | NOT NULL DEFAULT `''` | DMARC-evaluated DKIM result (`policy_evaluated/dkim`) |
| `eval_spf` | TEXT | NOT NULL DEFAULT `''` | DMARC-evaluated SPF result |
| `header_from` | TEXT | NOT NULL DEFAULT `''` | RFC 5322 From domain — the identity alignment is measured against |
| `envelope_from` | TEXT | NOT NULL DEFAULT `''` | RFC 5321 MAIL FROM domain |
| `envelope_to` | TEXT | NOT NULL DEFAULT `''` | RFC 5321 RCPT TO domain, when the reporter supplies it |
| `dkim_results` | TEXT | NOT NULL DEFAULT `'[]'` | JSON array of `{domain, selector?, result}` |
| `spf_results` | TEXT | NOT NULL DEFAULT `'[]'` | JSON array of `{domain, scope?, result}` |
| `reasons` | TEXT | NOT NULL DEFAULT `'[]'` | JSON array of `<reason>` policy overrides — `{type, comment}` |
| `verdict` | TEXT | NOT NULL | `aligned_pass` / `spoof` / `unaligned_pass` / `forwarded` / `unknown` — see the [verdict rules](jobs/dmarc-monitor.md#verdicts) |
| `received_at` | TEXT | NOT NULL | ISO timestamp the parent report was ingested |

### Indexes

- `idx_dmarc_rows_domain_date` on `(domain, date_begin)` — backs the 7/30-day verdict-count and source-IP aggregates.
- `idx_dmarc_rows_source_ip` on `(source_ip)` — backs "what else has this IP sent?" lookups.

### Key Helpers

- `getDmarcVerdictCounts(sinceIso)` — `domain` × `verdict` counts over a window, for `/dmarc` and `/status`.
- `getDmarcSourceIps(sinceIso, limit = 200)` — distinct `(source_ip, verdict, domain)` with summed message counts and the latest window end.
- `getRecentDmarcRows(limit = 100)` — most recent rows for the `/dmarc` history table.
- `pruneDmarcReports(retentionDays = 365)` — see the `dmarc_reports` Key Helpers above; deletes from this table too, in the same transaction.

### Design Notes

- The verdict is computed once, at ingest, by `classifyRow()` in `src/dmarc.ts` — alerting and the dashboard must never have to re-parse XML to answer "was this window clean?".
- `domain`, `date_begin` and `date_end` are denormalised from the report deliberately: every dashboard query filters or groups on them, and a report's window never changes after ingest.
- `raw_xml` is intentionally absent here — see the `dmarc_reports` design notes.

## `blog_drafts` table

In-progress edits for the `/blog` dashboard editor (#1849), which authors posts for the
separate `St-John-Software/bstjohn-blog` repo. Storage is plain CRUD — no Claude/agent
invocation — so drafts persist server-side in SQLite and survive across browsers/sessions
rather than living only in a form field.

**Source**: `src/db.ts`, `src/pages/blog.ts`, `src/server.ts` (`/blog`, `/blog/edit`, `/blog/save` routes)

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `repo` | TEXT | PRIMARY KEY (with `path`) | Always `BLOG_REPO` (`St-John-Software/bstjohn-blog` by default, overridable via `CLAWS_BLOG_REPO`) |
| `path` | TEXT | PRIMARY KEY (with `repo`) | Repo-relative file path, e.g. `src/content/blog/2026-07-04-my-slug.md` |
| `content` | TEXT | NOT NULL | Full raw file text (frontmatter + body) — edited as one textarea, never parsed |
| `base_sha` | TEXT | nullable | The GitHub content SHA the draft was based on; passed back to `putRepoFile()` on push so an update targets the right blob |
| `title` | TEXT | nullable | Parsed from the frontmatter `title:` field via regex when the draft is saved; display-only |
| `status` | TEXT | NOT NULL DEFAULT `'draft'` | `'draft'` or `'pushed'` |
| `pr_number` | INTEGER | nullable | Set once the draft has been pushed to a PR |
| `pr_branch` | TEXT | nullable | The `claws/blog-<slug>-<timestamp>` branch created for the push |
| `updated_at` | TEXT | NOT NULL | ISO timestamp of the last save |

### Key Helpers

- `upsertBlogDraft(repo, path, content, baseSha, title, updatedAt)` — `INSERT ... ON CONFLICT(repo, path) DO UPDATE`; **always resets `status` to `'draft'`**, even when overwriting a previously-`'pushed'` row — editing after a push starts a fresh draft rather than silently amending the merged/open PR.
- `getBlogDraft(repo, path)` — used by `GET /blog/edit` to prefer a stored draft over live GitHub content, so cross-browser edits aren't clobbered by the last-fetched upstream version.
- `listBlogDrafts(repo)` — ordered `updated_at DESC`; merged with the live GitHub directory listing on `/blog` to render draft-only rows (new, unpushed posts) alongside existing posts.
- `setBlogDraftPushed(repo, path, prNumber, branch)` — called after a successful `POST /blog/save?action=push`.

### Design Notes

- No pruning defined; volume is bounded by the number of distinct blog post paths ever edited through the dashboard.
- The only write-path guard is `isValidBlogPath()` (`src/pages/blog.ts`) — the path must fall under `BLOG_CONTENT_DIR`, end in `.md`, and contain no `..` segment. There is no server-side frontmatter validation; the editor is single-operator (the repo owner) and trusted.

## `shopping_searches` table

Per-item search-throttling and result cache for `shopping-sourcer` (#2463). Records the
outcome of every sourcing search — including empty results — so a hard-to-find item isn't
re-searched on every daily run; each item's `recheck_days` is checked against `last_searched_at`
to decide whether it's due again. Also backs the `[shopping]` tracking issue body, which is
rebuilt from the latest stored row per item without invoking an agent when nothing is due.

**Source**: `src/db.ts`, `src/jobs/shopping-sourcer.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `repo` | TEXT | NOT NULL, part of PK | Full repo name the manifest lives in |
| `manifest` | TEXT | NOT NULL, part of PK | Manifest file stem (e.g. `nas-expansion`) |
| `item_id` | TEXT | NOT NULL, part of PK | The manifest item's stable `id`; renaming an id resets its search history |
| `last_searched_at` | TEXT | NOT NULL, default `datetime('now')` | ISO timestamp of the last search, UTC without a zone suffix |
| `result_json` | TEXT | NOT NULL | JSON blob of the last search's candidates (Zod-validated before storage) |

**Primary key**: `(repo, manifest, item_id)`.

### Key Helpers

- `recordShoppingSearch(repo, manifest, itemId, resultJson)` — `INSERT ... ON CONFLICT(repo, manifest, item_id) DO UPDATE`, bumping `last_searched_at` to now and overwriting `result_json`; called once per due item after the sourcing agent returns, including for items with no candidates found.
- `getShoppingSearches(repo, manifest)` — returns every stored row for a manifest, used both to pick which items are due (`last_searched_at` vs. `recheck_days`) and to render the tracking issue body.

### Design Notes

- No pruning defined; volume is bounded by the number of distinct `(repo, manifest, item_id)` triples ever searched, which shrinks naturally as manifests are edited or items marked non-`sourcing`.
- See [shopping-sourcer](jobs/shopping-sourcer.md) for the full due-item selection and tracking-issue lifecycle this table backs.
- No pruning defined; this is a small, human-entered home log, not a high-volume table.
