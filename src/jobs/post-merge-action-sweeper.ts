/**
 * Clears recorded post-merge manual actions that no longer need an operator:
 * the linked issue is closed, or the issue's plan already tracks the step.
 * Global and DB-only. See docs/jobs/post-merge-action-sweeper.md.
 */
import * as db from "../db.js";
import * as log from "../log.js";
import { POST_MERGE_PREFIX, clearPrHold, postMergeActionResolution } from "../pr-hold.js";
import { mapWithConcurrency } from "../util.js";

const CONCURRENCY = 4;

export async function run(): Promise<void> {
  const start = performance.now();
  const rows = await db.listPostMergeActionPrs();
  log.info("[post-merge-action-sweeper] sweep started", { candidates: rows.length });
  let cleared = 0;
  let failed = 0;
  await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
    try {
      const reason = await postMergeActionResolution(row);
      if (!reason) return;
      if (await clearPrHold(row.repo, row.prNumber, POST_MERGE_PREFIX)) {
        cleared++;
        log.info("[post-merge-action-sweeper] cleared post-merge action", { repo: row.repo, pr: row.prNumber, issue_id: row.issueId, reason });
      }
    } catch (err) {
      failed++;
      log.warn("[post-merge-action-sweeper] could not check post-merge action", { repo: row.repo, pr: row.prNumber }, err);
    }
  });
  log.info("[post-merge-action-sweeper] sweep finished", {
    candidates: rows.length,
    cleared,
    failed,
    duration_ms: Math.round(performance.now() - start),
  });
}
