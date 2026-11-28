/**
 * Merge a native issue closed as a duplicate into the issue it duplicates
 * (#clw_01M7554EZ4SGZQHDHWTAEQW2QV): its dedupe keys move to the survivor, so
 * a later firing of one of those keys bumps the survivor instead of filing a
 * new issue, and its occurrence block (`**Alerts:**`, First seen, Last seen,
 * Occurrences) is folded into the survivor's body. See docs/issue-tracker.md
 * "Duplicate detection".
 *
 * Both duplicate paths call it before closing: the planner's `duplicate`
 * outcome through `issue-handback.ts` `settleDuplicate`, and a session's
 * `claws_close_as_duplicate` through `server.ts`.
 */

import * as gh from "./github.js";
import * as db from "./db.js";
import * as log from "./log.js";
import { recordDedupeKeyMoves } from "./metrics.js";
import { mergeOccurrenceTracking } from "./occurrence-tracking.js";
import { listOpenPhasePRs } from "./planned-prs.js";

/** The marker the merge comment on the surviving issue carries, once per merged source. */
export function mergedDuplicateMarker(sourceId: string): string {
  return `claws-merged-duplicate:${sourceId}`;
}

export type MergeDuplicateResult =
  | { ok: true; repo: string; keys: string[]; bodyMerged: boolean }
  | { ok: false; reason: string; sourceHoldsKeys: boolean };

/**
 * Why `sourceId` cannot be merged into `targetId`, or null when it can:
 * both must be live native issues (not shadows), differ, share a primary
 * repo, the target must be open, and the source must have no open phase PR
 * of its own. `source` and `target` are the loaded records (undefined when
 * unknown).
 */
export async function mergeRefusal(
  sourceId: string,
  targetId: string,
  source: db.ClawsIssueRecord | undefined,
  target: db.ClawsIssueRecord | undefined,
): Promise<string | null> {
  if (sourceId === targetId) return "An issue cannot be merged into itself.";
  if (!source || source.kind === "shadow") return `Issue ${sourceId} is not a Claws-native issue.`;
  if (!target || target.kind === "shadow") return `Issue ${targetId} is not a Claws-native issue.`;
  if (target.state !== "open") return `The surviving issue ${targetId} is closed.`;
  const sourceRepo = db.primaryRepoOf(source);
  const targetRepo = db.primaryRepoOf(target);
  if (sourceRepo !== targetRepo) {
    return `${sourceId} (primary repo ${sourceRepo || "none"}) and ${targetId} (primary repo ${targetRepo || "none"}) have different primary repos, so its dedupe keys cannot move.`;
  }
  if (sourceRepo) {
    const open = await listOpenPhasePRs(sourceRepo, sourceId);
    if (open.length > 0) {
      return `${sourceId} has an open PR of its own (${open.map((pr) => `${pr.repo}#${pr.number}`).join(", ")}), so it is not merged into ${targetId}.`;
    }
  }
  return null;
}

/**
 * Merge native issue `sourceId` into `targetId`: check {@link mergeRefusal},
 * then move every dedupe key `sourceId` holds onto `targetId`, fold its
 * occurrence block into `targetId`'s body, and post one Claws-authored comment
 * on `targetId` naming the source and the moved keys. Does not close
 * `sourceId` — the caller does. Safe to repeat: keys already moved are not
 * there to move again, and the comment's {@link mergedDuplicateMarker} stops
 * a second fold of the occurrence block. A refusal is returned, never thrown, with
 * whether the source holds keys (which then stay on it). A merge with nothing
 * to move or fold writes nothing.
 */
export async function mergeDuplicateInto(sourceId: string, targetId: string, agentName = "Claws"): Promise<MergeDuplicateResult> {
  const [source, target] = await Promise.all([db.getClawsIssue(sourceId), db.getClawsIssue(targetId)]);
  const sourceHoldsKeys = (source?.dedupe_keys.length ?? 0) > 0;
  const reason = await mergeRefusal(sourceId, targetId, source, target);
  if (reason !== null) return { ok: false, reason, sourceHoldsKeys };
  const repo = db.primaryRepoOf(source!);

  const keys = await db.moveClawsIssueDedupeKeys(sourceId, targetId);
  // A retry after the caller's close failed must not add the source's
  // occurrences a second time: the marker on the comment says it was folded.
  const marker = mergedDuplicateMarker(sourceId);
  const alreadyMerged = (await gh.getIssueComments(repo, targetId)).some((c) => c.body.includes(marker));
  let bodyMerged = false;
  if (!alreadyMerged) {
    const targetBody = await gh.getIssueBody(repo, targetId);
    const merged = mergeOccurrenceTracking(targetBody, source!.body ?? "");
    bodyMerged = merged !== targetBody;
    if (bodyMerged) await gh.editIssue(repo, targetId, merged);
  }

  if (keys.length > 0 || bodyMerged) {
    const parts = [`Merged duplicate #${sourceId} into this issue.`];
    if (keys.length > 0) {
      parts.push(`Its dedupe keys moved here, so a later report or alert firing under them updates this issue: ${keys.map((k) => `\`${k}\``).join(", ")}.`);
    }
    if (bodyMerged) parts.push("Its occurrence counts and alert names were added to this issue's occurrence block.");
    await gh.commentOnIssue(repo, targetId, `${parts.join(" ")}\n\n${marker}`, { agentName });
  }
  if (keys.length > 0) {
    recordDedupeKeyMoves("merge", keys.length);
    const store = log.runContext.getStore();
    log.runContext.run({ ...store, runId: store?.runId ?? "", repo }, () =>
      log.info("[issue-merge] dedupe keys moved", { from: sourceId, to: targetId, keys }));
  }
  return { ok: true, repo, keys, bodyMerged };
}
