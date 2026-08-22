import * as log from "../log.js";
import * as gh from "../github.js";
import {
  getWorkflowRunCount, upsertWorkflowRuns, getActiveWorkflowRuns,
  hasRecentlyCompletedTasks, getRunningTasks, deleteWorkflowRun,
} from "../db.js";
import { mapSettledWithConcurrency } from "../util.js";

const STALENESS_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const RECONCILE_CONCURRENCY = 5;
let lastFullSyncAt = 0;
let initialized = false;

export function _resetState(): void {
  lastFullSyncAt = 0;
  initialized = false;
}

export async function run(): Promise<void> {
  // Backfill on first ever run of this process (not on every prune-to-empty)
  if (!initialized) {
    if (getWorkflowRunCount() === 0) {
      log.info("[runner-metrics-sync] Empty table — backfilling last 7 days");
      const repos = await gh.listRepos();
      if (repos.length === 0) {
        log.warn("[runner-metrics-sync] Backfill deferred — listRepos returned 0 repos (likely transient rate limit); retrying next run");
        return;
      }
      const runs = await gh.fetchWorkflowRunsForBackfill(repos, 7);
      upsertWorkflowRuns(runs);
      lastFullSyncAt = Date.now();
      initialized = true;
      log.info(`[runner-metrics-sync] Backfilled ${runs.length} workflow runs`);
      return;
    }
    initialized = true;
  }

  // Activity check: should we sync?
  const isActive =
    getRunningTasks().length > 0 ||
    hasRecentlyCompletedTasks(10) ||
    getActiveWorkflowRuns().length > 0;

  const isStale = Date.now() - lastFullSyncAt >= STALENESS_THRESHOLD_MS;

  if (!isActive && !isStale) {
    log.debug("[runner-metrics-sync] No recent activity — skipping");
    return;
  }

  const repos = await gh.listRepos();
  const [recentRuns, activeRuns] = await Promise.all([
    gh.fetchRecentWorkflowRuns(repos),
    gh.fetchActiveWorkflowRuns(repos),
  ]);
  // Deduplicate by run_id, keeping the last occurrence (activeRuns is the fresher status-filtered fetch)
  const deduped = [...new Map([...recentRuns, ...activeRuns].map(r => [r.run_id, r])).values()];
  upsertWorkflowRuns(deduped);

  // Reconcile stragglers — DB still says active but GH didn't return them this pass
  const seen = new Set(deduped.map(r => r.run_id));
  const stragglers = getActiveWorkflowRuns().filter(r => !seen.has(r.run_id));
  let reconciled = 0;
  let removed = 0;
  const settled = await mapSettledWithConcurrency(
    stragglers,
    RECONCILE_CONCURRENCY,
    (r) => gh.fetchWorkflowRunById(r.repo, r.run_id),
  );
  const toUpsert: typeof deduped = [];
  for (let j = 0; j < settled.length; j++) {
    const res = settled[j];
    const straggler = stragglers[j];
    if (res.status !== "fulfilled") continue;
    const value = res.value;
    if (value === "not_found") {
      deleteWorkflowRun(straggler.run_id);
      removed++;
    } else if (value !== null) {
      toUpsert.push(value);
      reconciled++;
    }
  }
  if (toUpsert.length > 0) upsertWorkflowRuns(toUpsert);

  lastFullSyncAt = Date.now();

  log.info(`[runner-metrics-sync] Synced ${recentRuns.length} recent + ${activeRuns.length} active runs, reconciled ${reconciled} straggler(s), removed ${removed} deleted (active=${isActive}, stale=${isStale})`);
}
