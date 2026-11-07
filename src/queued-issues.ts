/**
 * Which `Blocked` issues are only waiting on other work in flight, for the
 * board's Queued column, the nav counts and `issue-stage.ts`
 * (#clw_01M64CH10AK2PKH1JDGTB3FBMJ). Queued is derived on every render, not
 * stored: the issue keeps its `Blocked` label and lifecycle, so `gh.isParked`,
 * the implementer gate and both release sweeps are unchanged.
 *
 * An issue is Queued only when its *current* Blocked reason is one Claws
 * writes for a dependency wait, so an operator's re-block with a reason of
 * their own lands it back in Blocked:
 *
 * - a PR-wait park (`pr-wait-park.ts`'s `parsePrWaitReason`), released by the
 *   PR dispatcher once the PRs merge;
 * - an issue-link park (a {@link DEPENDENCY_PARK_PREFIX} reason) on a native,
 *   non-alert issue that still has an unreleased `depends_on` link — the only
 *   ones `issue-links.ts`'s sweep releases.
 */

import * as db from "./db.js";
import * as log from "./log.js";
import { isAlertIssue } from "./alert-issue.js";
import { dependencyParkReason, isDependencyParkReason } from "./blocked-reason.js";
import { parsePrWaitReason } from "./pr-wait-park.js";

/**
 * The subset of `trackerIds` that is Queued, mapped to the reason to show: a
 * PR-wait park's stored reason, or for a link park the open dependencies it
 * still waits on (the stored reason names only the one that parked it), or
 * the stored reason once every one has closed and the sweep has yet to run.
 *
 * Best effort: a read failure is logged and answers an empty map, which shows
 * the issues in Blocked — over-reporting what needs a person, never hiding it.
 */
export async function issuesQueued(trackerIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (trackerIds.length === 0) return out;
  try {
    const reasons = await db.getIssueBlockedReasons(trackerIds);
    const linkParked: string[] = [];
    for (const [id, reason] of reasons) {
      if (parsePrWaitReason(reason)) out.set(id, reason);
      else if (isDependencyParkReason(reason)) linkParked.push(id);
    }
    if (linkParked.length === 0) return out;
    const targets = await db.listUnreleasedDependencyTargets(linkParked);
    for (const id of linkParked) {
      const links = targets.get(id);
      if (!links || links.length === 0) continue;
      const record = await db.getClawsIssue(id);
      if (!record || record.kind !== "issue" || isAlertIssue(record)) continue;
      const open = links.filter((link) => link.open);
      out.set(id, open.length > 0 ? dependencyParkReason(open) : reasons.get(id)!);
    }
    return out;
  } catch (err) {
    log.warn(`[queued-issues] Could not read which Blocked issues are queued: ${err instanceof Error ? err.message : String(err)}`);
    return new Map();
  }
}
