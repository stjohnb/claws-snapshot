# runner-metrics-sync

Adaptive sync of GitHub Actions workflow runs to the SQLite database for runner
utilization analytics and dashboard display.

**Source**: `src/jobs/runner-metrics-sync.ts`

## Behavior

Runs every 2 minutes (configurable via `intervals.runnerMetricsSyncMs`). Syncs
workflow run data to the `workflow_runs` table.

### Initial backfill

On the very first run (when the `workflow_runs` table is empty), performs a
7-day backfill across all repos via `gh.fetchWorkflowRunsForBackfill()`. This
populates historical data for the dashboard sparkline and stats.

### Adaptive sync

After the initial backfill, each tick checks whether to sync:

1. **Active** (running Claude tasks, recently completed tasks within 10 min, or
   active workflow runs in `queued`/`in_progress` state): Sync all repos
2. **Idle + last sync < 15 min ago**: Skip API calls entirely (zero cost)
3. **Idle + last sync ≥ 15 min ago**: Force one sync to prevent total staleness

This means the job backs off to zero API cost when Claws is idle and the data
is reasonably fresh.

### Sync process

1. Fetch recent workflow runs (last 24 hours) across all repos
2. Fetch currently active workflow runs (`queued` + `in_progress`)
3. Deduplicate by `run_id` (active runs are fresher, so they take precedence)
4. Bulk upsert into `workflow_runs` via `upsertWorkflowRuns()` in a transaction

### Dashboard integration

The synced data powers:
- `/runners` page: active workflow runs with cancel buttons
- Per-repo/per-workflow stats: queue wait time, run duration
- Runner utilization analytics

## Configuration

No dedicated config options. Interval configurable via
`intervals.runnerMetricsSyncMs` (default: 120000 = 2 minutes).
