import { LABELS, prUrl } from "../config.js";
import * as log from "../log.js";
import { closeAlertIssueIfResolved, upsertAlertIssue } from "../occurrence-tracking.js";
import type { AutoBumpDiffFailure, MergeRefusal } from "./auto-merger.js";

/**
 * Stalled auto-bump alert (#clw_01M64CQ46A14535D86H148D6C2): an auto-bump PR
 * the structural merge gate has held for `STALL_THRESHOLD_MS` raises one
 * Blocked alert issue in its repository, edited in place while any PR stays
 * held and closed once no auto-bump PR there is gate-blocked. Blocked-since
 * times live in memory, so a restart restarts the clock.
 */

/** How long the gate must hold an auto-bump PR before it is alerted on: ten 3-minute sweeps. */
export const STALL_THRESHOLD_MS = 30 * 60 * 1000;

export const STALL_ALERT_TITLE = "Auto-bump PRs held by the structural merge gate";

const LOG_PREFIX = "auto-merger";

/** One auto-bump PR `attemptMerge` judged this sweep: its refusal, or null when it merged. */
export interface StallEvaluation {
  number: number;
  title: string;
  refusal: MergeRefusal | null;
}

interface HeldPr {
  since: number;
  title: string;
  reason: string;
}

/** repo → PR number → when the gate first held it. */
const held = new Map<string, Map<number, HeldPr>>();
/** repo → the over-threshold PR numbers last logged, so `auto_bump_stall` logs only on change. */
const lastOverKey = new Map<string, string>();
/** Repos whose alert was already checked for closing since they last had a held PR. */
const closeChecked = new Set<string>();

/** Test-only: forget every held PR and logged state. */
export function clearAutoBumpStallState(): void {
  held.clear();
  lastOverKey.clear();
  closeChecked.clear();
}

/** The gate failures that count as a stall; transient read failures do not. */
const STALL_REASONS: Partial<Record<AutoBumpDiffFailure, string>> = {
  "non-bump-files": "touches files beyond YAML image pins and an allowed registry allowlist change",
  "not-image-pin-only": "diff is not an image-pin-only bump",
};

/** The hold text when `refusal` is a structural-gate block that counts as a stall, else null. */
function stallReason(refusal: MergeRefusal | null): string | null {
  if (!refusal || refusal.code !== "auto-bump-gate" || !refusal.autoBumpReason) return null;
  return STALL_REASONS[refusal.autoBumpReason] ?? null;
}

/**
 * Fold one sweep's verdicts into the held set: a gate-blocked PR keeps the
 * time it was first held, a PR no longer gate-blocked or no longer open is
 * dropped, and an open PR the sweep skipped (dispatch guard, other work) keeps
 * its entry unchanged.
 */
export function recordSweep(
  repoFullName: string,
  evaluated: readonly StallEvaluation[],
  openPrNumbers: readonly number[],
  now: number,
): void {
  const entries = held.get(repoFullName) ?? new Map<number, HeldPr>();
  for (const pr of evaluated) {
    const reason = stallReason(pr.refusal);
    if (reason === null) {
      entries.delete(pr.number);
      continue;
    }
    const prior = entries.get(pr.number);
    entries.set(pr.number, { since: prior?.since ?? now, title: pr.title, reason });
  }
  const open = new Set(openPrNumbers);
  for (const number of [...entries.keys()]) if (!open.has(number)) entries.delete(number);
  if (entries.size > 0) {
    held.set(repoFullName, entries);
    closeChecked.delete(repoFullName);
  } else {
    held.delete(repoFullName);
  }
}

/** The alert body: a pure function of the held set, so an unchanged set costs no edit. */
function alertBody(repoFullName: string, entries: Map<number, HeldPr>): string {
  const rows = [...entries.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, e]) => `- ${prUrl(repoFullName, number)} — ${e.title}: ${e.reason} (held since ${new Date(e.since).toISOString()})`);
  return [
    `The auto-merger's structural gate is holding these auto-bump PRs in ${repoFullName}, so the image bump is not deploying:`,
    "",
    ...rows,
    "",
    "Approving a PR's merge from the Claws dashboard unblocks it; this issue closes once no auto-bump PR here is held by the gate.",
  ].join("\n");
}

/**
 * Raise, update or close the repo's stalled auto-bump alert from the held set:
 * upsert it when any PR has been held for `STALL_THRESHOLD_MS`, close it when
 * none is held. Errors are logged, never thrown.
 */
export async function reconcileStallAlert(repoFullName: string, now: number): Promise<void> {
  const entries = held.get(repoFullName);
  const over = entries ? [...entries.entries()].filter(([, e]) => now - e.since >= STALL_THRESHOLD_MS).map(([n]) => n).sort((a, b) => a - b) : [];
  const key = over.join(",");
  if ((lastOverKey.get(repoFullName) ?? "") !== key) {
    lastOverKey.set(repoFullName, key);
    log.info(
      `[auto-merger] ${repoFullName}: ${entries?.size ?? 0} auto-bump PR(s) held by the gate, ${over.length} past the threshold`,
      "auto_bump_stall",
      { repo: repoFullName, heldCount: entries?.size ?? 0, overThreshold: over.length },
    );
  }
  try {
    if (entries && over.length > 0) {
      await upsertAlertIssue({
        repo: repoFullName,
        title: STALL_ALERT_TITLE,
        body: alertBody(repoFullName, entries),
        labels: [LABELS.blocked],
        blockedReason: "Auto-bump PRs are held by the merge gate — approve the merge or fix the gate",
        logPrefix: LOG_PREFIX,
        createdDetail: `${over.length} PR(s) held past ${STALL_THRESHOLD_MS / 60_000} min`,
      });
    } else if (!entries && !closeChecked.has(repoFullName)) {
      // Checked once per process and once each time the held set empties —
      // not every sweep — so an idle repo costs no issue reads.
      await closeAlertIssueIfResolved({ repo: repoFullName, title: STALL_ALERT_TITLE, logPrefix: LOG_PREFIX, reason: "no auto-bump PR is held by the gate" });
      closeChecked.add(repoFullName);
    }
  } catch (err) {
    log.warn(`[auto-merger] ${repoFullName}: stalled auto-bump alert failed: ${err}`);
  }
}
