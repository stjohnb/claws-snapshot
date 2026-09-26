# Database Schema

**Deep dive.** Every table, column and index; open only when adding or
migrating a table. For everything else about a module, see modules.md instead.

Claws runs the schema below on either SQLite or PostgreSQL, selected by
`CLAWS_DATABASE_URL` — see [Database backend](configuration.md#database-backend).
Unset means SQLite at `~/.claws/claws.db`, configured with WAL journal mode and
NORMAL synchronous level for performance. The column types in this document are
the SQLite spelling; see [Two dialects](#two-dialects) for what each becomes on
Postgres.

**Source**: `src/db.ts` (all SQL), `src/db-driver.ts` (the `SqlDriver` interface
and the SQLite implementation), `src/db-driver-pg.ts` (Postgres and PGlite).

## Two dialects

`src/db.ts` is the only module that authors SQL, and it writes SQLite. Two
mechanisms carry that to Postgres.

**DDL tokens.** `SqlDriver.exec()` substitutes the tokens each driver spells
differently, so the `CREATE TABLE` statements stay single-sourced:

| Token | SQLite | Postgres |
|---|---|---|
| `{{PK_AUTOINC}}` | `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGSERIAL PRIMARY KEY` |
| `{{NOW}}` | `(datetime('now'))` | `(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))` |

The Postgres driver also widens every DDL `INTEGER` to `BIGINT`, in `exec()` and
in `addColumn()`. SQLite's INTEGER is 64-bit and Postgres' is 32-bit, and the
schema stores epoch-millisecond timestamps and GitHub run IDs — both past 2³¹.
`addColumn()` is `ALTER TABLE … ADD COLUMN IF NOT EXISTS` on Postgres and a
swallowed duplicate-column error on SQLite.

JSON extractions cast to `::bigint` for the same reason: the JSON fields
`db.ts` reads back as integers are byte counts and epoch milliseconds, both
past 2³¹, so `::int` would overflow at runtime (rule 2 below).

**Query translation.** `translate()` in `src/db-driver-pg.ts` rewrites each
statement on its way to Postgres. It is a closed, enumerated set covering
exactly what `src/db.ts` uses:

1. `INSERT OR IGNORE INTO` → `INSERT INTO … ON CONFLICT DO NOTHING` (unless the
   statement already has an `ON CONFLICT`).
2. `CAST(json_extract(X, '$.k') AS INTEGER)` → `((X::jsonb ->> 'k')::bigint)`, then
   bare `json_extract(X, '$.k')` → `(X::jsonb ->> 'k')`.
3. `strftime('%s', C)` → `EXTRACT(EPOCH FROM C::timestamp)`;
   `strftime('%Y-%m-%d', C)` → `to_char(C::timestamp, 'YYYY-MM-DD')`.
4. `julianday(C)` → `(EXTRACT(EPOCH FROM C::timestamp) / 86400.0)`.
5. `INSTR(A, B)` → `strpos(A, B)`.
6. `LIMIT -1 OFFSET` → `LIMIT ALL OFFSET`.
7. `datetime(C)` → `(C)::timestamp`.
8. `?` placeholders → `$1, $2, …`, in order, skipping string literals and `--`
   comments.

**New SQL must use only constructs this list covers**, or add a rule here plus a
case in `src/db-driver-pg.test.ts`. Three further rules are not translatable and
have to be respected when writing the SQL itself:

- **Timestamps are bound, never computed in SQL.** `datetime('now', …)` is gone
  from `src/db.ts`; the private `nowSql()` / `nowSqlOffsetMs()` helpers produce
  the same `YYYY-MM-DD HH:MM:SS` UTC string and it is bound as a parameter, so
  stored values and every string comparison over them are unchanged.
- **Quote a camelCase output alias** (`AS "transientApiFailed"`). Postgres folds
  an unquoted identifier to lower case; table and column names are all
  lower-case snake_case already and must *not* be quoted.
- **No SQLite-only shorthands**: a derived table needs an alias, every selected
  column must appear in `GROUP BY` or an aggregate (SQLite's bare-column-beside-
  `MAX()` trick is a window function here), and only `claimNextWork()`'s
  Postgres branch may use `FOR UPDATE SKIP LOCKED` — it branches on
  `SqlDriver.dialect`.

`npm run test:pg` re-runs the database suites against PGlite — real Postgres
compiled to wasm, in-process — and is what proves the schema and every one of
these rules. It runs in CI after `npm test`.

## `tasks` table

Tracks every job invocation. Used for crash recovery (orphaned task detection
at startup), timeout escalation (counting recent failures), and operational
visibility.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique task identifier |
| `job_name` | TEXT | NOT NULL | Job that created this task (e.g. `issue-worker`, `ci-fixer`) |
| `repo` | TEXT | NOT NULL | Full repo name (e.g. `St-John-Software/claws`) |
| `item_number` | TEXT | NOT NULL | Issue or PR reference — a forge number, or a Claws-native `clw_…` id (`0` for doc-maintainer). See [Issue-reference columns](#issue-reference-columns) |
| `trigger_label` | TEXT | nullable | Label that triggered this task |
| `worktree_path` | TEXT | nullable | Filesystem path to the task's worktree |
| `branch_name` | TEXT | nullable | Git branch name used by this task |
| `run_id` | TEXT | nullable | UUID of the parent job run (links to `job_runs.run_id`) |
| `model_used` | TEXT | nullable | Claude model used for this task (e.g. `opus`, `sonnet`). Set via `updateTaskModel()` after model selection. |
| `provider_used` | TEXT | nullable | AI provider used for this task (e.g. `claude`, `codex`, `opencode`). Set via `updateTaskProvider()` from token callbacks or agent `onProviderUsed`/fallback tracking; weighted-provider call sites persist the last attempted provider in `finally` so failed tasks remain attributable. |
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
| `prRepo` | string | The repo `prNumber` is in, set only when it differs from the task's `repo` — an `issue-worker` step of a multi-repo issue, recorded under the primary repo, whose PR is in another of the issue's repos |
| `prAction` | `"created"` \| `"updated"` \| `"reviewed"` \| `"skipped"` | Whether a PR was created, updated, reviewed, or skipped |
| `headSha` | string | Full PR head SHA produced or reviewed by the task. Downstream quality attribution requires an exact match to avoid crediting feedback after human pushes or later Claws updates. |
| `reviewResult` | `"clean"` \| `"advisory"` \| `"blocking"` \| `"escalated"` \| `"empty-diff"` | Reviewer terminal result, stored on `pr-reviewer` task outcomes for task history and usage/effectiveness reporting. |
| `failureCategory` | string | For failed tasks, one of `FAILURE_CATEGORIES` in `diagnostic-queries.ts`: `timeout`, `memory-limit`, `external-kill` (killed by a signal from outside Claws — a Kubernetes/kernel OOMKill or a node drain, as distinct from a Claws watchdog kill), `shutdown`, `rate-limit`, `transient-api`, `ref-not-found`, `push-rejection`, `git-conflict`, `usage-limit`, `unsupported-model`, `auth-expired`, `logs-unavailable` (ci-fixer: failed log fetch, counts toward circuit breaker), or `unknown`. That list is also the allowlist `claws_task_history` projects through, so anything else reads as `failure_reason: null`. |
| `memoryLimitBytes` | number | For `memory-limit` failures: the effective agent memory cap, in bytes, that the run breached. `countRecentMemoryLimits()` counts same-cap strikes on this field rather than parsing the rendered error text. |

All fields are optional. The outcome is set via `recordTaskComplete(taskId, outcome)`
or `recordTaskFailed(taskId, error, outcome)`. Old tasks have `outcome = NULL`.

### Timeout Counting

`countRecentTimeouts(repo, itemNumber, windowMs)` counts tasks for a specific
item that failed with a "timed out" error within a sliding window (default:
2 hours). Used by `timeout-handler.ts` to decide whether to escalate the
timeout or auto-skip the item after repeated timeouts.

## `task_effectiveness_events` table

Stores downstream quality signals attributed back to the exact task/model that
produced a PR head. This is observability only: the model selector does not
auto-tune weights from these rows.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique event identifier |
| `task_id` | INTEGER | NOT NULL | Producer task being scored |
| `source` | TEXT | NOT NULL | Signal source, currently `pr-review` or `pr-merge` |
| `source_repo` | TEXT | NOT NULL | Repo where the signal was observed |
| `source_number` | INTEGER | NOT NULL | PR number where the signal was observed |
| `source_sha` | TEXT | NOT NULL, default `''` | Full PR head SHA the signal describes |
| `signal` | TEXT | NOT NULL | Event kind, e.g. `pr-review-clean`, `pr-review-blocking`, or `pr-merged` |
| `score` | REAL | nullable | Numeric review score when applicable: clean `+1`, advisory `+0.5`, blocking/escalated/empty-diff `-1`; merge events leave this null |
| `details` | TEXT | nullable | JSON/text details, such as reviewer task id and iteration |
| `created_at` | TEXT | NOT NULL, default now | UTC observation timestamp |

Indexes:

- `idx_task_effectiveness_unique` on `(task_id, source, source_repo,
  source_number, source_sha)` — re-reviewing the same PR head updates the
  prior signal rather than double-counting it
- `idx_task_effectiveness_task` on `task_id`
- `idx_task_effectiveness_source` on `(source_repo, source_number, source_sha)`

`findLatestCompletedTaskForPrHead(repo, prNumber, headSha)` only matches
completed task outcomes whose `prNumber` and full `headSha` both match exactly,
and whose outcome `prRepo` (falling back to the task's own `repo`) is `repo`.
Historical outcomes without `headSha`, human pushes, and later Claws pushes are
intentionally unattributed rather than guessed. Every pr-reviewer outcome now
records the head it reviewed, so pr-reviewer rows with `commits = 0` are
excluded: only an advisory self-fix (which pushed) can be a producer.

### Usage / Effectiveness Queries

`getUsageStats()`, `getTotalUsage()`, and `getUsageFilterOptions()` include task
rows with token data or provider/model attribution. That means task counts can
rise while token and cost totals stay at zero for providers that do not report
priced usage. The usage page aggregates completed/failed/changed/PR-created
counts, reviewer result counts, merge counts, average review scores using only
non-null review scores, and average terminal task duration. Recent quality
signals are exposed via `getRecentEffectivenessEvents()`.

### Crash Recovery

`getOrphanedTasks()` returns all rows with `status = 'running'`. At startup,
`main.ts` iterates these and:
- Removes the worktree directory if it still exists on disk
- Marks the task as `failed` with error `"process restarted before completion"`

## `pr_reviews` table

One row per completed `pr-reviewer` round — the durable record the reviewer
and the `PR_REVIEWER` work handler read to decide whether a PR needs another
review and whether that review can cover only the delta since the last one.
The `Reviewed commit:` comment marker stays as the human-visible stamp and as
the fallback for PRs this table has no row for. See
[jobs/pr-dispatcher.md](jobs/pr-dispatcher.md#reviewer-pr-reviewer) for the
rules that read it.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Row identifier |
| `repo` | TEXT | NOT NULL | `owner/name` |
| `pr_number` | INTEGER | NOT NULL | PR number |
| `head_sha` | TEXT | NOT NULL | Full head SHA recorded for the round; on the advisory self-fix path, the pushed fix commit (matching the comment marker), not what the model reviewed |
| `reviewed_sha` | TEXT | nullable | The commit the model actually reviewed. Equal to `head_sha` except on an advisory self-fix round, where it is the pre-fix commit — the next incremental round diffs from here, not `head_sha`, so the pushed fix is not silently skipped. NULL for rows that predate this column (backfilled rows; treated as `head_sha`) |
| `base_sha` | TEXT | NOT NULL, default `''` | `git merge-base origin/<base> HEAD` at review time. `''` for backfilled rows and when git could not compute it, which forces the next round to be a full review |
| `verdict` | TEXT | NOT NULL | `clean`, `advisory`, `blocking`, `escalated` or `empty-diff` — the `TaskOutcome.reviewResult` union |
| `mode` | TEXT | NOT NULL, default `'full'` | `full` or `incremental` |
| `iteration` | INTEGER | NOT NULL, default `1` | Review round number (`*Review #N*`) |
| `reviewer_task_id` | INTEGER | nullable | The `pr-reviewer` task that produced the round |
| `provider` | TEXT | nullable | Provider that produced the verdict — the same value as the comment's `*Models used: … (provider: …)*` line, so a mid-round fallback is captured. NULL for `empty-diff` rounds (no model runs) and for backfilled rows whose task has no `provider_used` |
| `model` | TEXT | nullable | Model that produced the verdict; NULL under the same conditions as `provider`. The advisory self-fix records the reviewing model, not the sonnet pass that pushed the fix |
| `findings` | TEXT | nullable | The review text shown in the comment, capped at 20,000 chars (the fixed sentence for `clean` and `empty-diff`). NULL for backfilled rows |
| `created_at` | TEXT | NOT NULL, default now | UTC time of the round; refreshed when the same head is re-reviewed |

Indexes:

- `idx_pr_reviews_head` UNIQUE on `(repo, pr_number, head_sha)` — a rebuttal
  re-review of the same head updates its row instead of adding a second one
- `idx_pr_reviews_pr` on `(repo, pr_number, id)`

Helpers: `recordPRReview(input)` upserts on the unique key, overwriting every
other column; `listPRReviews(repo, prNumber, limit = 5)` returns rows newest
first (`created_at DESC, id DESC`, so an upserted older row and backfilled rows
still sort by time); `getLatestPRReview(repo, prNumber)` is its first row.

**Backfill.** `backfillPRReviews()` is one-shot: it does nothing once
`pr_reviews` holds any row at all, so it only ever runs on the first boot
after this table's introduction. Running it on every boot would race live
writes — an advisory self-fix round's row and its effectiveness event
(recorded on the pre-fix SHA — see `reviewed_sha` above) land with
overlapping `created_at` values, so a later backfill could insert a phantom
row for the pre-fix SHA that outranks the live row in `listPRReviews`'s
`created_at DESC, id DESC` order. On its one run it reads, in order:

1. `task_effectiveness_events` rows with `source = 'pr-review'`: the `signal`
   maps to the verdict (`pr-review-clean` → `clean`, …), `details.iteration`
   and `details.reviewerTaskId` fill `iteration` and `reviewer_task_id`, and a
   `LEFT JOIN tasks` on that task id fills `provider`/`model` from
   `provider_used`/`model_used`. Skips any `reviewer_task_id` a row already
   exists for, so a self-fix round's live row can never gain a second,
   phantom row from its own event.
2. Completed `pr-reviewer` tasks whose outcome has both `headSha` and
   `reviewResult`, taking `provider`/`model` from the same row and `iteration`
   from `outcome.reviewIteration` (default `1` for older tasks recorded before
   that field existed).

Both passes use `INSERT … SELECT … ON CONFLICT(repo, pr_number, head_sha) DO
NOTHING`, so neither can overwrite a row the other (or a live write) already
added. Backfilled rows get `mode = 'full'`, `reviewed_sha = NULL`,
`base_sha = ''` and `findings = NULL`. A PR whose latest review has no
backfilled row keeps working through the comment-marker fallback, so
deploying the table triggers no re-review burst.

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

`message` is capped at write time (`insertJobLog()` in `src/db.ts`) to
`JOB_LOG_MAX_MESSAGE_CHARS` (32,000 UTF-16 units, about 96 KB of UTF-8). A
longer message is cut at the cap and ends with a
`\n… [truncated: N more chars]` marker. Independently, `pruneOldLogs()`
deletes any row whose message exceeds `JOB_LOG_PRUNE_MESSAGE_BYTES` (128,000
bytes), regardless of the row's run age — this catches historical rows
written before the cap existed (#3113: 437 `host-disk-monitor` rows of 7.2 MB
each, from an unbounded debug line later fixed by #3053).

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
Read by `ci-fixer` (via `getActiveWorkflowRuns`) to see which workflow runs are still active, and by `main-build-monitor` (via `getDefaultBranchRuns`).

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
  used by runner-metrics-sync to detect Claws activity and identify reconciliation candidates,
  and by `ci-fixer` (`src/agents/ci-fixer.ts`) to check the runner queue depth
- `hasRecentlyCompletedTasks(minutesAgo)` — lightweight check against the `tasks`
  table for recent completed/failed tasks, used for activity detection

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
| `model` | TEXT | nullable | Model id passed to the agent CLI as `--model`; NULL/empty means the provider default (#2873). Always NULL for `repo-zsh` sessions, which run no agent CLI. Read back by `resumeSession` (and surfaced by `getRecentSessionModels`, which powers the form's "Recently used" optgroup) |
| `backend` | TEXT | nullable | Session backend that owns the row (#3026). NULL means the host `local-tmux` backend — every row `sessions.ts` writes today. `k8s-pod` rows are skipped by `recoverSessions()` (no teardown, no re-attach) and their `tmux_name` still counts as known when reaping orphan tmux sessions |
| `agent_status` | TEXT | nullable | Self-reported agent state (#3083): `working`, `monitoring`, `waiting` or `done`, set by the session's `claws_set_session_status` MCP tool via `POST /api/sessions/:id/status`. `setSessionAgentStatus` only writes live rows (`ended_at IS NULL`); `clearSessionEnded` resets it to NULL so a resumed session starts unreported. Shown in the Active sessions table's Status column |
| `agent_status_updated_at` | INTEGER | nullable | Unix timestamp (ms) when `agent_status` was last set; rendered as its age so a stale status stays visible |
| `launched_at` | INTEGER | nullable | Unix timestamp (ms) when the session's pod was last launched (#3061). `insertSession` sets it to `created_at`; a `k8s-pod` resume that relaunches the pod updates it via `clearSessionEnded(id, launchedAt)` (adopting a still-running pod does not). `k8s-pod` reconcile measures its launch grace from the later of this and `created_at`, so the grace survives a Claws restart. NULL on rows written before it existed |
| `exit_code` | INTEGER | nullable | Exit code of the session's process once it ended on its own (#3311): reported by the session pod (`POST /session-pods/:id/exit`, via `recordSessionExit`) before reconcile ends the row, or the local bridge's code when a `local-tmux` session ends. NULL while live, when unknown, and after `clearSessionEnded` (resume). Shown as `Failed (exit N)` in the sessions list and on the ended-session page |
| `last_output` | TEXT | nullable | Tail (≤ 50,000 chars, VT control sequences stripped) of the session's final terminal output, written alongside `exit_code` so it outlives the pod (#3311); shown on `/sessions/:id` for an ended session. NULL when nothing was captured, and after `clearSessionEnded`. History pruning bounds its total size |

No indexes; row count of *live* sessions is small (max 5 at a time). Both a
normal process exit and the "End" button (`killSession`) set `ended_at` and
retain the row as history rather than deleting it; ended sessions are pruned
to the most recent `MAX_ENDED_SESSIONS` (50) per session backend via
`pruneEndedSessions(keep, backend)` (`local-tmux` covers `backend` NULL). A row
is deleted outright only via the explicit "Delete" action (`deleteSession`,
`POST /sessions/:id/delete`) or when a bridge respawn is abandoned before the
session ever became resumable history.

## `session_capability_defaults` table

The capability set the operator last submitted on the `/sessions` create forms, per
repo combination; the forms pre-tick it next time. Written by `POST /sessions/create`
and `/sessions/create-multi` after a successful create only, via
`rememberSessionCapabilityDefaults`; read by `getAllSessionCapabilityDefaults`.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `repo_key` | TEXT | PRIMARY KEY | `sessionCapabilityDefaultsKey(repos)`: the repo full names, de-duplicated, sorted and joined with `\n`, so a single repo is keyed by its own name |
| `capabilities` | TEXT | NOT NULL | JSON array of the explicitly selected capability ids. Agent logins and the always-forced `cross-repo` baseline are never stored (a disabled checkbox never posts); an explicit `forgejo` tick for a repo selection it isn't forced on IS stored like any other capability. `[]` means "remembered as none", unlike a missing row |
| `updated_at` | INTEGER | NOT NULL | Unix timestamp (ms) of the last submission |

No indexes; one row per repo combination ever used. Home-directory sessions have
no repo and are not remembered.

## `verification_reports` table

Stores connectivity verification results written by `runConnectivityVerification()`.
Each row holds a JSON `payload` with per-check pass/fail results (database,
GitHub App, CLIs — `gh`, `claude`, `codex`, `opencode` — OpenRouter, Slack
webhook DNS, IMAP login/logout, per-runner SSH, Ollama,
WhatsApp auth). Each check is wrapped in a 30 s timeout.
Used by the connectivity checks in the Activation section of `/config` and the `GET /api/activation` endpoint.

This table is instance-local: the staging DB sync (`src/db-import.ts`
`INSTANCE_LOCAL_TABLES`) never copies it, so each instance keeps its own rows.

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
| `item_number` | TEXT | NOT NULL | Issue or PR reference being processed (`0` for repo-level items). See [Issue-reference columns](#issue-reference-columns) |
| `args_json` | TEXT | NOT NULL DEFAULT `'{}'` | Optional JSON payload for the handler |
| `priority` | INTEGER | NOT NULL DEFAULT 0 | Non-zero for `Priority`-labelled items; refreshed while `queued` each time a dispatcher re-discovers the item |
| `status` | TEXT | NOT NULL DEFAULT `'queued'` | `queued` / `running` / `completed` / `failed` |
| `pid` | INTEGER | nullable | PID of the worker that claimed this row — diagnostic only, not a liveness signal (see Design Invariants) |
| `attempts` | INTEGER | NOT NULL DEFAULT 0 | Number of claim attempts |
| `error_message` | TEXT | nullable | Error message on failure; on a `completed` row, `skipped: <reason>` when the worker dropped it before spawning because the item was merged, closed or parked |
| `enqueued_at` | TEXT | NOT NULL | ISO timestamp of insertion |
| `started_at` | TEXT | nullable | ISO timestamp when claimed |
| `completed_at` | TEXT | nullable | ISO timestamp when completed or failed |
| `run_id` | TEXT | nullable | UUID of the parent job run |
| `agent_pod` | TEXT | nullable | Name of the agent pod (`claws-agent-<id>`) running the row under `CLAWS_WORK_BACKEND=k8s-pod`, set once the pod has been created; `NULL` for in-process runs. `recoverWorkOnStartup()`, `reapStaleRunningWork()` and `getOrphanedTasks()` skip pod-backed running rows and their tasks |
| `agent_mcp_token_sha256` | TEXT | nullable | SHA-256 (hex) of the agent pod's `claws-state` bearer token (its Secret's `mcp-token`). The `/api/*` routes accept that token while the row is `running`, and the agent-pod ops API (`POST /agent-pods/<id>/ops/<op>`) for this row alone while it runs and for 10 minutes after it ends, so it survives service restarts; cleared on re-queue; `NULL` for in-process runs |

### Indexes

- `idx_work_queue_dispatch` on `(status, priority DESC, id ASC)` — supports the
  claim, which orders by `priority DESC`, then pipeline stage rank
  (`stageRankSql()` in `src/work-order.ts`), then `id ASC`.
- `idx_work_queue_active` — UNIQUE on `(kind, repo, item_number) WHERE status IN ('queued', 'running')`:
  the idempotency index. `enqueueWork()` uses `INSERT OR IGNORE` so a second
  enqueue for the same in-flight item no-ops silently.

### Key Helpers

- `enqueueWork(kind, repo, itemNumber, opts)` — `INSERT OR IGNORE`; returns
  `{ id, alreadyQueued, priorityChanged }`. Atomicity provided by the UNIQUE
  partial index. On an already-`queued` row it updates `priority` to the
  caller's flag.
- `claimNextWork(runId)` — atomically transitions the next `queued` row
  (Priority first, then stage rank, then oldest) to `running`; returns the row
  or `null` when the queue is empty.
- `markWorkSkipped(id, reason)` — `completed` with `skipped: <reason>`, for a
  row whose item was no longer actionable at pre-spawn re-validation.
- `setWorkPriority(id, priority)` — records the live Priority label read at
  re-validation on a claimed row.
- `markWorkSucceeded(id)` / `markWorkFailed(id, error)` — terminal status updates.
- `recoverWorkOnStartup()` — resets all `running` rows without an `agent_pod` to
  `queued` on startup (crash recovery); returns `{ resetRunning: number }`.
- `reapStaleRunningWork(activeIds)` — between-restart self-heal: resets `running`
  rows without an `agent_pod` older than `STALE_RUNNING_WORK_MS` (6 hours) whose
  `id` is not in the caller's live in-flight set; returns the number of rows reset.
- `getWorkRow(id)` / `setWorkAgentMcpToken(id, mcpTokenSha256)` /
  `setWorkAgentPod(id, podName)` / `listPodBackedRunningWork()` /
  `isRunningAgentPodMcpToken(mcpTokenSha256)` /
  `markWorkFailedIfRunning(id, runId, reason)` /
  `markWorkCancelledIfRunning(id, runId, reason)` — the agent pod backend's
  reads and writes. The token hash is written before the Secret and accepted
  while the row is `running`; `agent_pod` only once the Pod exists, so
  `recoverWorkOnStartup()` re-queues (and clears the hash of) a row whose
  launch crashed first. The `…IfRunning` writes change the row only while it
  is still `running` under `runId` and return whether they did.
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
  `queued` on startup — restarting rather than dropping in-flight work. `pid` is
  not a valid liveness signal for this: in the production container `tini` is
  PID 1 and the Node process is always PID 7 across restarts, so a stale row's
  `pid` is indistinguishable from the live process's own (#3144). Between
  restarts, an hourly sweep (`reapStaleRunningWork()`) provides the same
  self-heal without a PID check: it compares a row's age against
  `STALE_RUNNING_WORK_MS` and the worker's in-flight set (`worker.inFlightWorkIds()`)
  instead. Both mechanisms assume a single live writer per database (enforced today
  by `replicas: 1` and the `claws.pid` lock); a second replica would need a
  per-incarnation owner token on each row instead.
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
| `issue_number` | TEXT | NOT NULL, part of PK | Issue reference that was skipped |
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
| `issue_number` | TEXT | nullable | The filed issue's reference |
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
| `issue_number` | TEXT | NOT NULL, part of PK | The parked target issue's reference |
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

## `imported_issues` table

What `issue-importer` moved into the Claws-native tracker (#3245). Two jobs at once:
it is the importer's idempotency key, and it is what keeps an imported issue's **old
forge number resolving** — to the `claws-duplicate-of:` marker on another issue, the
`docs/upstream-watches/*.yaml` manifest that targets it, the operator's
`skippedItems`/`prioritizedItems`/`itemTimeoutOverrides` entry, the merged PRs on its
`claws/issue-<N>-` branches and the PR bodies saying `Part of #<N>`. Without it each of
those needed a bespoke rewrite in the importer, or a permanent refusal to import at all.

**Source**: `src/db.ts`, `src/imported-refs.ts`, `src/jobs/issue-importer.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `repo` | TEXT | NOT NULL, part of PK | Full repo name the forge issue lived in |
| `forge_number` | TEXT | NOT NULL, part of PK | The forge issue number the import closed |
| `native_id` | TEXT | NOT NULL | The `clw_…` id it became |
| `imported_at` | TEXT | NOT NULL, default `datetime('now')` | ISO timestamp the row was written |

**Primary key**: `(repo, forge_number)` — never the bare number, because forge numbers
collide across repositories. `idx_imported_issues_native` indexes `native_id` for the
reverse direction.

A linkage row also exists for every **shadow** — the native backing record of an issue
that is still live on a forge (#3246) — so one row per forge issue serves both cases and
only `claws_issues.kind` says which it is. `listImportedIssues()` therefore joins
`claws_issues` and excludes `kind = 'shadow'`: the in-process index it feeds is an
*alias* index, and a live forge issue is not an alias of its shadow. Leave shadows in and
every forge ref on the fleet would resolve to a hidden native id, doubling
`listMergedPRsForIssue` and `listDuplicateIssuesOf`'s API calls. See
[issue-tracker.md](issue-tracker.md#shadows).

### Key Helpers

- `recordImportedIssue(repo, forgeNumber, nativeId): boolean` — `INSERT OR IGNORE`, so a re-run that reaches the write again cannot replace the id it already created. Returns whether the stored row names `nativeId` — false means the key was taken by a *different* native issue, which the caller must treat as a failure rather than as idempotency: it has just built an issue nothing links to.
- `listImportedIssues(): {repo, forgeNumber, nativeId}[]` — read once at boot to populate the in-process index. Joins `claws_issues` and omits shadows. `forge_number` is TEXT, so it is normalised back to a number here; miss that and every `sameIssueRef` comparison silently stops matching on Postgres while still passing on SQLite.
- `getImportedIssueByNative(nativeId): {repo, forgeNumber} | undefined` — the reverse direction, and unlike `listImportedIssues()` it answers for a shadow. `/issues/:id` uses it to redirect a shadow to the forge issue it stands for. Ordered `repo, forge_number`, because the only index on `native_id` is non-unique and an unordered `LIMIT 1` would return whichever row the planner reached first — which can differ between SQLite and Postgres and between runs. A unique index would be the stronger fix, but `CREATE UNIQUE INDEX` on a database that already holds a duplicate fails, and it would fail at boot.

### Design Notes

- `src/imported-refs.ts` owns the index and is the only module that reads the table. Lookups are **synchronous** against it: Claws runs a single pod, the table is tiny, and `gh.isItemSkipped` / `isItemPrioritized` / `getItemTimeoutMs` are sync with many callers apiece.
- `db.createShadowIssue` writes this row *first*, in the same transaction as the `claws_issues` row it links to — linkage row first, so its `(repo, forge_number)` primary key arbitrates a race between `issue-importer` and `issue-shadow-sync` rather than the order of two separate writes. `recordImport`'s call to `recordImportedIssue` therefore always finds the row already written and no-ops in the table, existing only to populate the in-process alias index before the comment copy, the `Moved to` comment and the forge close.
- A native issue transferred to another repository keeps its row under the original repo, which is correct: the old forge number belongs to the old repo.
- No pruning defined; volume is bounded by the number of issues ever imported.
- See [issue-tracker.md](issue-tracker.md#routing) and [issue-importer](jobs/issue-importer.md).

## `blog_draft_ports` table

Durable dedup table for `blog-draft-scanner` (#2560). Prevents a draft blog post from
being re-filed as a new port issue in `bstjohn-blog` on every daily tick once it has
fired, even if the draft is edited or its title changes afterwards.

**Source**: `src/db.ts`, `src/jobs/blog-draft-scanner.ts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `repo` | TEXT | NOT NULL, part of PK | Full name of the repo the draft lives in |
| `path` | TEXT | NOT NULL, part of PK | Path of the draft file within that repo |
| `issue_number` | TEXT | nullable | The filed port issue's reference in `bstjohn-blog` |
| `created_at` | TEXT | NOT NULL, default `datetime('now')` | ISO timestamp the row was written |

**Primary key**: `(repo, path)` — deliberately not the blob sha, so editing a draft
after the port issue is filed does not re-file it.

### Key Helpers

- `hasBlogDraftPortFiled(repo, path): boolean` — checked before filing; a hit means this exact `(repo, path)` pair already fired.
- `recordBlogDraftPortFiled(repo, path, issueNumber): void` — `INSERT OR IGNORE`, called immediately after the issue is created (or found via `findIssueByExactTitle`).

### Design Notes

- No pruning defined; volume is bounded by the number of distinct drafts ever ported across all repos.
- See [blog-draft-scanner](jobs/blog-draft-scanner.md) for the full scanning/dedup behavior this table backs.

`promotion_actions` was used by the site-promoter job, removed in #3073; promotion
work now lives in `St-John-Software/growth-engine`. It is no longer created, but may
still exist in older databases.

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

## `claws_issues` table

The Claws-native issue tracker's issue stream — one global stream shared by
every managed repository. See [issue-tracker.md](issue-tracker.md) for the id
format and the routing rules that sit above these tables.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | `clw_` + a 26-character ULID, minted in process by `src/issue-id.ts` |
| `title` | TEXT | NOT NULL | Issue title |
| `body` | TEXT | NOT NULL, default `''` | Markdown body, rendered on read by `src/markdown.ts` |
| `author_login` | TEXT | NOT NULL | Who opened it — the first `allowedActors` entry for a dashboard-created issue, `claws` for a Claws-created one |
| `state` | TEXT | NOT NULL, default `'open'` | `open` or `closed` |
| `state_reason` | TEXT | nullable | `completed` or `not_planned`; cleared on reopen |
| `created_at` | TEXT | NOT NULL | `YYYY-MM-DD HH:MM:SS` UTC, bound from `nowSql()` |
| `updated_at` | TEXT | NOT NULL | Bumped by every write to the issue, its labels, its repos or its comments |
| `closed_at` | TEXT | nullable | Set on close, cleared on reopen; `listClosedClawsIssuesSince()` reads it |
| `kind` | TEXT | NOT NULL, default `'issue'` | `issue` for an operator-facing native issue, `shadow` for the hidden native record of an issue still live on a forge (#3246) |
| `shadow_checked_at` | TEXT | nullable | When `issue-shadow-sync` last examined this shadow, successfully or not; NULL on every `issue` row. `listShadowIssues()` orders on it (#3246) |
| `lifecycle` | TEXT | NOT NULL, default `'ideas'` | The issue's lifecycle state: `ideas` (a new issue, requirements not yet approved), `planning` (promoted; the planner's turn), `awaiting-plan-review`, `approved`, `blocked` or `backlog` (off the board; see [issue-tracker.md#backlog](issue-tracker.md#backlog)). Replaces the `Ready` / `Refined` / `Blocked` / `Backlog` rows in `claws_issue_labels`; readers see it as that label, and a state-label add or remove writes it instead — see [issue-tracker.md#board](issue-tracker.md#board) |
| `stage_changed_at` | TEXT | nullable | When the issue entered its current board column, for the board's age chip: set by `createClawsIssue`, every `lifecycle` change and a close or reopen (`setClawsIssueState`). Not `updated_at`, which comments and edits also bump. NULL on rows that predate the column; the façade reads NULL as `updated_at`, with no backfill — see [issue-tracker.md#board](issue-tracker.md#board) |
| `approved_requirements_version` | INTEGER | nullable | The `claws_issue_requirements` version that was approved; NULL until promotion, and when an issue is promoted with no record yet |
| `requirements_approved_by` | TEXT | nullable | Who approved it — a dashboard login, or `claws` for auto-promotion |
| `requirements_approved_at` | TEXT | nullable | When, `YYYY-MM-DD HH:MM:SS` UTC |
| `source` | TEXT | NOT NULL, default `'dashboard'` | Where the issue came from: `dashboard`, `session`, `agent`, `automation`, `whatsapp` or `forge` (every shadow). Attended sources (`dashboard`, `session`, `whatsapp`) wait for a human to promote; the rest auto-promote on their first requirements version — see [issue-tracker.md#requirements](issue-tracker.md#requirements) |
| `auto_promote` | INTEGER | nullable | Per-issue promotion override: 1 auto-promotes, 0 waits for a human, NULL follows the source and the repo's `claws.json` `autoPromote` |
| `filed_title` | TEXT | nullable | The title the issue was filed under, kept when promotion renamed it to the approved record's title; set by the first rename only |

**`lifecycle` backfill**: `migrateStateLabelsToLifecycle()` runs on every boot.
It sets `lifecycle` from any remaining `Ready`, `Refined`, `Blocked` and `Backlog` label rows
— in that order, so the highest-precedence state an issue carries wins — then
deletes those rows. Once none are left it changes nothing. Shadows are covered
too. An older image would ignore the column and see every native issue in the
inbox; re-inserting label rows from `lifecycle` by hand restores its view.

**Ideas migration**: `migrateInboxToIdeas()` runs on every boot after the plan
backfill. While any row still holds a retired value it moves `awaiting-review`
to `awaiting-plan-review`, and `inbox` to `planning` when the issue has a
`claws_issue_plans` row or an approved requirements version and to `ideas`
otherwise; the same pass backfills `source` (`forge` for a shadow, `automation`
for `author_login = 'claws'`, else the `dashboard` default). With no retired
value left it returns at once, so a rerun changes nothing.

**Indexes**: `idx_claws_issues_state` on `(state, updated_at)` — the open-issue
reads are all `state = 'open' ORDER BY updated_at DESC`;
`idx_claws_issues_closed` on `(state, closed_at)`, because the first index's
second column is the wrong one for `listClosedClawsIssuesSince()`'s
`closed_at >= ? ORDER BY closed_at DESC`; and partial copies of both —
`idx_claws_issues_live_state` and `idx_claws_issues_live_closed`, each
`WHERE kind <> 'shadow'`. The partial pair is what keeps the façade's two reads
from degrading once shadows exist: there is then one `claws_issues` row per
open forge issue fleet-wide, and the unfiltered indexes above would match every
one of them and throw nearly all of them away after the scan, on the path every
dispatcher cycle runs. A plain b-tree on `kind` could not help — `<>` is not a
seekable predicate — while a partial index can, because the planner proves the
index predicate from the query's own literal clause. Nothing indexes `kind`
alone: `listShadowIssues()` reaches a shadow through `imported_issues`' primary
key.

Every child insert and every by-id write refuses a `shadow` (#3246):
`requireClawsIssue` throws on one, and `updateClawsIssueTitle`,
`updateClawsIssueBody` and `setClawsIssueState` carry `kind <> 'shadow'` on
their own UPDATE and return `false`. A shadow's own columns are written only by
`updateShadowIssue`/`promoteShadowIssue`, both guarded `WHERE kind = 'shadow'`
— as is `markShadowsChecked`, which writes `shadow_checked_at` and nothing else.

## `claws_issue_repos` table

Which managed repositories an issue concerns. Automation sees a native issue
through its *primary* repo — the alphabetically first row here (`MIN(repo)`,
compared by code point in both dialects) — so a multi-repo issue is listed
under exactly one repo. No rows make it "unassigned" and visible on the
dashboard only.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `issue_id` | TEXT | NOT NULL, part of PK, FK → `claws_issues(id)` ON DELETE CASCADE | Owning issue |
| `repo` | TEXT | NOT NULL, part of PK | Full repo name |

**Primary key**: `(issue_id, repo)`. **Index**: `idx_claws_issue_repos_repo` on `repo`.

## `claws_issue_labels` table

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `issue_id` | TEXT | NOT NULL, part of PK, FK → `claws_issues(id)` ON DELETE CASCADE | Owning issue |
| `label` | TEXT | NOT NULL, part of PK | Label name, matching `LABEL_SPECS` |

**Primary key**: `(issue_id, label)`. Writes are `INSERT OR IGNORE`, so adding a
label twice is a no-op and emits no `label-added` event.

## `claws_issue_prs` table

The PRs an issue's plan needs, as the planner saved them through the
`claws_save_plan` MCP tool. A forge issue is keyed by its shadow's id, so every
issue Claws plans can carry a list. When a list is stored it is the source of
truth for the plan's PR count, each PR's repo and its title; an issue without
one falls back to parsing `### PR N:` headers (see
[patterns.md](patterns.md#multi-pr-phase-coverage)).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `issue_id` | TEXT | NOT NULL, part of PK, FK → `claws_issues(id)` ON DELETE CASCADE | Owning issue (native or shadow) |
| `position` | INTEGER | NOT NULL, part of PK | 1-based position in merge order |
| `repo` | TEXT | NOT NULL | Repository the PR is opened in |
| `title` | TEXT | NOT NULL | Short PR title from the plan, at most 200 characters |
| `pr_number` | INTEGER | nullable | The PR Claws opened (or pushed onto) for this position |
| `depends_on` | TEXT | nullable | JSON array of the earlier positions this PR must land after; `[]` is independent, NULL is unspecified (the plan header's suffix, else the previous position). Malformed values read as NULL |

**Primary key**: `(issue_id, position)`. `replaceIssuePlannedPRs` deletes and
re-inserts the whole list in one transaction, carrying `pr_number` over to the
same position when its repo is unchanged; `depends_on` is written as the planner
saved it. A linked PR that was closed unmerged is
unlinked the next time coverage is read.

## `claws_prs` table

The PR state store: one row per PR Claws works, native forge PRs and
Dependabot PRs alike — phase 1 of
[refinements/issue-flow.md](refinements/issue-flow.md#pull-request-state).
In this phase the row is written alongside the PR state labels; no merge or
dispatch decision reads it. See `src/pr-state.ts`.

**Readers.** The issue auditor's label comparison, and — since phase 2 — the
board: `/board`'s PR open and Awaiting merge columns and the issue page's Status
section read an issue's open rows through `src/issue-flight.ts`
(`listOpenClawsPrsWithIssue` for the whole board in one query,
`listOpenClawsPrsForIssue` for one issue), and chip PR open cards from their
`stage` and `needs_human_review`
([issue-tracker.md](issue-tracker.md#board)).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `repo` | TEXT | NOT NULL, part of PK | `owner/name` |
| `pr_number` | INTEGER | NOT NULL, part of PK | PR number |
| `issue_id` | TEXT | nullable | The tracker issue the PR implements (`claws_issue_prs`), when it has one |
| `phase` | INTEGER | nullable | The plan position the PR implements |
| `head_sha` | TEXT | nullable | Head SHA the last dispatcher tick saw |
| `observed_at` | TEXT | nullable | When the last dispatcher tick refreshed the row |
| `stage` | TEXT | NOT NULL, default `'opened'` | `opened`, `ci-failing`, `awaiting-review`, `addressing-review`, `awaiting-merge`, `manual-action`, `problematic`, `merged`, `closed` |
| `ci_status` | TEXT | nullable | `passing`, `failing`, `pending`, or `none` for a repo with no CI |
| `mergeable_state` | TEXT | nullable | `MERGEABLE`, `CONFLICTING`, `UNKNOWN` |
| `review_verdict` | TEXT | nullable | Verdict of the latest `pr_reviews` row |
| `reviewed_sha` | TEXT | nullable | Head SHA of the latest `pr_reviews` row |
| `merge_approved_by` | TEXT | nullable | The approving session's OIDC `sub` (the board's Automerge toggle, `/queue/mark-automerge`, `/queue/merge`; `dashboard` without a session), `label` (set through `addLabel(Automerge)` with no approval recorded yet) or `forge-label` (an `Automerge` the dispatcher found on the forge) |
| `merge_approved_at` | TEXT | nullable | When the approval was recorded |
| `manual_action_reason` | TEXT | nullable | Why a human is needed; `manual action` when set from the label |
| `needs_human_review` | INTEGER | NOT NULL, default `0` | Today's `Needs LGTM` |
| `ci_blocked_reason` | TEXT | nullable | Today's `Billing`; `billing` when set from the label |
| `created_at` | TEXT | NOT NULL, default now | Row insert time |
| `updated_at` | TEXT | NOT NULL, default now | Last state change: bumped on insert and on any write of a state column, not by a write of only the observed columns (`head_sha`, `observed_at`, `ci_status`, `mergeable_state`, `review_verdict`, `reviewed_sha`). The dispatcher's reconcile skips a row written after its listing |

**Primary key**: `(repo, pr_number)`. **Index**: `idx_claws_prs_stage` on
`(repo, stage)`.

**Label↔row contract** (shared by the label hook, the façade and the auditor):

| Label | Row |
|---|---|
| `Ready` | `stage = 'awaiting-merge'` |
| `Claws Problematic` | `stage = 'problematic'` |
| `Manual Action` | `manual_action_reason` non-null |
| `Needs LGTM` | `needs_human_review = 1` |
| `Billing` | `ci_blocked_reason` non-null |
| `Automerge` | `merge_approved_at` non-null |

`Manual Action` on a PR at `awaiting-merge` or `problematic` sets only the
reason, so a PR carrying `Ready` plus `Manual Action` keeps a single stage.

**Writers.** Agents never write the row directly. The dashboard writes
`merge_approved_by` / `merge_approved_at` from the session's identity before it
applies `Automerge` or merges, and clears both when the board's toggle turns
Automerge off. `github.ts`'s `addLabel` and
`removeLabel` call `applyPrLabelAdded` / `applyPrLabelRemoved` after the forge
write for the six labels above — the same layer the native issue lifecycle is
written at — and the hook writes only when a row already exists for
`(repo, number)`, which is how an issue is told from a PR. `createPR` inserts
the row (`stage = 'opened'`) and mirrors the labels it was created with; the
implementer then fills `issue_id` and `phase`. The PR dispatcher seeds, refreshes,
reconciles forge-side label edits into, and closes rows each tick ([jobs/pr-dispatcher.md](jobs/pr-dispatcher.md#phase-0a-pr-store-refresh)).
The hook is best-effort: a failed row write is logged with a `[pr-state]`
prefix and never fails the label write; the auditor reports the drift. Agent
pods reach these helpers through the agent-pod ops API.

Helpers: `upsertClawsPr(repo, prNumber, patch)` inserts or updates, touching
only the keys in `patch` and always bumping `updated_at`;
`getClawsPr(repo, prNumber)`; `listClawsPrs(repo, { openOnly })` (open = not
`merged`/`closed`); `listOpenClawsPrsForIssue(issueId)` and
`listOpenClawsPrsWithIssue()` (the open rows for one issue in any repo, and
every open row with an `issue_id`); `findIssuePlannedPRByNumber(repo, prNumber)` reads the
issue link from `claws_issue_prs`.

## `claws_issue_comments` table

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | `clwc_` + a 26-character ULID, so `isClawsCommentId()` can route reaction and edit calls that never see an issue id |
| `issue_id` | TEXT | NOT NULL, FK → `claws_issues(id)` ON DELETE CASCADE | Owning issue |
| `author_login` | TEXT | NOT NULL | Comment author; `claws` for Claws' own |
| `body` | TEXT | NOT NULL | Markdown, including the `*— Automated by Claws —*` marker on agent comments |
| `created_at` | TEXT | NOT NULL | `YYYY-MM-DD HH:MM:SS` UTC |
| `updated_at` | TEXT | NOT NULL | Bumped on edit |

**Index**: `idx_claws_issue_comments_issue` on `issue_id`. Comments are read
`ORDER BY id`, which is exact posting order because the ids are monotonic ULIDs.

## `claws_issue_comment_reactions` table

Reactions on native issue comments — how `issue-refiner` marks feedback as
addressed and `issue-auditor` reads that it has been.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `comment_id` | TEXT | NOT NULL, part of PK, FK → `claws_issue_comments(id)` ON DELETE CASCADE | Owning comment |
| `login` | TEXT | NOT NULL, part of PK | Who reacted |
| `content` | TEXT | NOT NULL, part of PK | Reaction content (`+1`, `rocket`, …) |

**Primary key**: `(comment_id, login, content)` — re-reacting is idempotent.

## `claws_issue_plans` table

Every version of a native issue's plan ([issue-tracker.md#plans](issue-tracker.md#plans)).
The plan comment stays the pipeline's source of truth; a row is written as a
side effect of `addClawsIssueComment` / `editClawsIssueComment`, in the same
transaction, whenever a Claws plan comment's normalised text differs from the
issue's latest version.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `issue_id` | TEXT | NOT NULL, part of PK, FK → `claws_issues(id)` ON DELETE CASCADE | Owning issue |
| `version` | INTEGER | NOT NULL, part of PK | 1, 2, … per issue — the latest stored version + 1 |
| `comment_id` | TEXT | FK → `claws_issue_comments(id)` ON DELETE SET NULL | The plan comment the version came from |
| `body` | TEXT | NOT NULL | Plan text without the Claws header or the trailing `CLAWS_PLAN_*` marker block (`normalizePlanText`) |
| `created_at` | TEXT | NOT NULL | `YYYY-MM-DD HH:MM:SS` UTC |

**Primary key**: `(issue_id, version)`. `initDb` backfills issues that have
plan comments but no rows yet (`backfillClawsIssuePlans`, idempotent).

## `claws_issue_requirements` table

Every version of an issue's requirements record ([issue-tracker.md#requirements](issue-tracker.md#requirements)),
written by the requirements writer through `addClawsIssueRequirementsVersion`
— not as a side effect of the `## Requirements` comment, as plan versions are.
Keyed by the tracker id, so a forge issue's versions hang off its shadow row.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `issue_id` | TEXT | NOT NULL, part of PK, FK → `claws_issues(id)` ON DELETE CASCADE | Owning issue — native or shadow |
| `version` | INTEGER | NOT NULL, part of PK | 1, 2, … per issue — the latest stored version + 1 |
| `title` | TEXT | NOT NULL | Suggested issue title, ≤ 120 characters |
| `kind` | TEXT | NOT NULL | `bug` or `feature` |
| `context` | TEXT | NOT NULL | Markdown |
| `requirement` | TEXT | NOT NULL | Markdown |
| `acceptance_criteria` | TEXT | NOT NULL | JSON array of strings, at least one |
| `out_of_scope` | TEXT | NOT NULL | JSON array of strings, possibly empty |
| `comment_id` | TEXT | nullable, no FK | The `## Requirements` comment the version was rendered into — a native `clwc_…` id or a forge comment id, which is why there is no foreign key |
| `created_at` | TEXT | NOT NULL | `YYYY-MM-DD HH:MM:SS` UTC |

**Primary key**: `(issue_id, version)`.

## `claws_issue_attachments` table

Files attached to native issues (#3289). The bytes live on disk under
`~/.claws/issue-attachments/`; `src/issue-attachments.ts` is the only writer and
keeps a row and its file together. See [issue-tracker.md](issue-tracker.md#attachments).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | `cla_` + a 26-character ULID |
| `issue_id` | TEXT | FK → `claws_issues(id)` ON DELETE CASCADE | Owning issue; NULL while the upload is pending on an unsaved New Issue form |
| `comment_id` | TEXT | FK → `claws_issue_comments(id)` ON DELETE SET NULL | The comment whose body links the file, stamped when the comment is posted |
| `filename` | TEXT | NOT NULL | Original filename, sanitised to `[A-Za-z0-9._-]` |
| `stored_path` | TEXT | NOT NULL | File location relative to `WORK_DIR` |
| `content_type` | TEXT | NOT NULL | MIME type as uploaded, lower-cased, parameters stripped; the serve route downgrades anything off its allowlist |
| `size` | INTEGER | NOT NULL | Bytes |
| `uploader_login` | TEXT | NOT NULL | Who uploaded it |
| `created_at` | TEXT | NOT NULL | `YYYY-MM-DD HH:MM:SS` UTC |

**Index**: `idx_claws_issue_attachments_issue` on `issue_id`. Pending rows
(`issue_id IS NULL`) older than 24 hours are deleted with their files at the
start of every pending upload.

## `claws_issue_links` table

Typed links between tracker issues, one row per fact, read from both ends.
`src/issue-links.ts` owns the rules; see [issue-tracker.md](issue-tracker.md#links).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | `cll_` + a 26-character ULID |
| `source_id` | TEXT | NOT NULL, FK → `claws_issues(id)` ON DELETE CASCADE | For `depends_on`, the dependent issue; for `relates_to`, the smaller id |
| `target_id` | TEXT | NOT NULL, FK → `claws_issues(id)` ON DELETE CASCADE | For `depends_on`, the issue depended on |
| `kind` | TEXT | NOT NULL | `depends_on` or `relates_to` (`blocks` is stored as the inverse `depends_on`) |
| `created_by` | TEXT | NOT NULL | The operator's login from the dashboard, `claws` from the API |
| `created_at` | TEXT | NOT NULL | `YYYY-MM-DD HH:MM:SS` UTC |
| `released_at` | TEXT | | When the dispatcher's sweep unparked `source_id` on this dependency, or when it was added with the target already closed |

**Unique**: `(source_id, target_id, kind)`. **Indexes**:
`idx_claws_issue_links_source` on `source_id`, `idx_claws_issue_links_target`
on `target_id`.

### Design Notes

- No pruning defined: these tables hold the issue stream itself, which is the
  record of work, not derived state.
- Every child insert runs inside a transaction that first checks the parent row
  exists, throwing `claws-issues: no native issue <id>` if it does not. The
  foreign keys back that up on both backends; SQLite needs
  `PRAGMA foreign_keys = ON`, set beside the `journal_mode` pragma in
  `src/db-driver.ts`.
- The two sidecar reads behind `listOpenClawsIssues()` are scoped by
  `WHERE issue_id IN (SELECT id FROM claws_issues WHERE state = 'open' …)`,
  never a full scan: closed issues outnumber open ones from the first week.
  The subquery is the caller's own `WHERE … ORDER BY … LIMIT …` re-used
  verbatim, not an `IN (?, ?, …)` list of the ids already selected — an
  unbounded list would blow past Postgres' 65535 bind parameters (and SQLite's
  `SQLITE_MAX_VARIABLE_NUMBER`) and fail the read outright.

## `issue_model_plan` table

The per-issue model plan: an optional provider and tier for each pipeline phase
(see [model-selection.md](model-selection.md)). Keyed by `(repo, issue_ref)`
rather than by a foreign key into `claws_issues`, so a forge number and a
native `clw_…` id are both valid refs and forge issues get planner-suggested
cells too. Read and written by `src/model-plan.ts`.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `repo` | TEXT | NOT NULL, part of PK | `owner/name` the cell applies to |
| `issue_ref` | TEXT | NOT NULL, part of PK | Canonical issue ref (forge number or `clw_…` id), written through `refParam()` |
| `phase` | TEXT | NOT NULL, part of PK | `plan`, `plan-refine`, `implement`, `review`, `ci-fix` or `review-address` |
| `provider` | TEXT | | `claude`, `codex` or `opencode`; NULL = default |
| `tier` | TEXT | | `fable`, `opus`, `sonnet` or `haiku`; NULL = default |
| `source` | TEXT | NOT NULL | `explicit` (set by an operator) or `suggested` (written by the planner) |
| `updated_at` | TEXT | NOT NULL | Last write |

**Primary key**: `(repo, issue_ref, phase)`. `upsertIssueModelPlanCell` never
lets a `suggested` write replace an `explicit` row. A cell with neither provider
nor tier is deleted rather than stored. Rows are not moved when a forge issue is
imported under a new native id; the planner rewrites its suggestions on the next
plan.

## Issue-reference columns

Six columns hold an issue *reference* — a forge number, or a Claws-native
`clw_…` id — and are therefore `TEXT` rather than INTEGER (#3215):

| Table | Column |
|---|---|
| `tasks` | `item_number` |
| `work_queue` | `item_number` |
| `notified_untrusted_actors` | `issue_number` |
| `reminder_notifications` | `issue_number` |
| `upstream_watch_fires` | `issue_number` |
| `blog_draft_ports` | `issue_number` |

`ci_fixer_breaker.item_number` is deliberately absent: it is keyed by pull
request, and pull requests are always forge-numbered.

**Writes bind a canonical string.** `db.ts`'s private `refParam()` canonicalises
and stringifies every reference before binding it. better-sqlite3 binds a JS
number as a double, so a TEXT-affinity column would store `42` as `"42.0"` and
no later `= ?` lookup would match; and on Postgres these columns are TEXT with a
case-sensitive `=` and a unique `idx_work_queue_active` over
`(kind, repo, item_number)`, so a ref spelled `clw_01jbq…` would not collide
with the canonical row — it would quietly add a second queue entry for the same
issue that no lookup ever finds. This is the one place every write to these six
columns passes through, which is why the rule is enforced here rather than at
the call sites.

**Reads normalise back.** `refFromColumn()` / `normalizeItemNumbers()` in the
leaf `src/issue-id.ts` turn a digit-only value back into a number in every
accessor that returns one of these columns, because Postgres hands TEXT back as
a string and `123 !== "123"` would silently break every forge comparison in the
pipeline. They live in `issue-id.ts`, not `db.ts`, because the MCP child process
(`src/mcp-server.ts`) opens its own driver and must apply exactly the same rule
to the `tasks` queries it issues directly. `claws_work_queue` is normalised
inside `diagnostic-queries.getMcpWorkQueue()`, where its SQL lives, so both
transports get it and a wrapper one level up cannot be missed.

### The Postgres migration

SQLite needs nothing: `CREATE TABLE` declares TEXT, and its column affinity is
per-value anyway, so an existing database file keeps working. Postgres is
strict, so `initDb()` rewrites the live database in place.

`migrateIssueRefColumnsToText()` runs only when
`SqlDriver.dialect === "postgres"` and only when `information_schema.columns`
still reports a non-`text` type for one of the six, so it is a no-op on every
boot after the first. All six `ALTER TABLE … ALTER COLUMN … TYPE TEXT USING
…::text` statements go out as **one** `exec()` string wrapped in an explicit
`BEGIN`/`COMMIT`: either every column changes or none does, so a partial failure
cannot leave the schema half-widened while the code assumes TEXT. Two timeouts
bound two different things — `SET LOCAL lock_timeout = '30s'` caps the wait to
*acquire* each ACCESS EXCLUSIVE lock, and `SET LOCAL statement_timeout = '120s'`
caps the table rewrite that follows, which is otherwise unbounded. Either one
throws out of `initDb()` and crash-loops the pod with a clear error rather than
hanging until the startup probe kills it mid-`ALTER` with nothing to say why.
The simple protocol discards the rest of the batch on failure, trailing `COMMIT`
included, so the migration issues an explicit `ROLLBACK` before rethrowing to
release the connection. The elapsed milliseconds are logged.

**Rolling back** to a pre-migration image needs the reverse ALTER run by hand,
after deleting any rows that carry a native `clw_…` reference:

```sql
BEGIN;
DELETE FROM tasks WHERE item_number LIKE 'clw\_%';
-- …and the other five tables…
ALTER TABLE tasks ALTER COLUMN item_number TYPE BIGINT USING item_number::bigint;
-- …and the other five columns…
COMMIT;
```
