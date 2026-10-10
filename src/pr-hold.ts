/**
 * PR holds — keeping a PR from merging until a person acts, through its
 * `Manual Action` label and the reason recorded on its `claws_prs` row.
 *
 * The implementer holds a PR on the operator step its plan orders before the
 * merge; a design change (`reapproval.ts`) holds each open PR it would close
 * or rework until the operator re-approves. A re-approval hold's reason starts
 * with {@link REAPPROVAL_HOLD_PREFIX}, so {@link releaseReapprovalHold} lifts
 * only those and never an operator's own Manual Action.
 */

import { LABELS } from "./config.js";
import * as gh from "./github.js";
import * as db from "./db.js";
import * as log from "./log.js";

/** How every re-approval hold's recorded reason starts. */
export const REAPPROVAL_HOLD_PREFIX = "Held for re-approval:";

/**
 * Hold a PR on a manual action: record `reason` on its `claws_prs` row first,
 * so the label hook keeps it instead of the generic "manual action", then
 * apply `Manual Action`. The auto-merger refuses a PR whose row carries a
 * reason even when the issue has Automerge.
 */
export async function recordManualAction(prFullName: string, prNumber: number, reason: string, issueLabel: string): Promise<void> {
  try {
    await db.upsertClawsPr(prFullName, prNumber, { manualActionReason: reason, stage: "manual-action" });
  } catch (err) {
    log.warn(`[pr-hold] Could not record the manual action on claws_prs for ${prFullName}#${prNumber}: ${err}`);
  }
  await gh.addLabel(prFullName, prNumber, LABELS.manualAction);
  log.info(`[pr-hold] Applied ${LABELS.manualAction} to PR #${prNumber} for ${issueLabel}: ${reason}`);
}

/**
 * Hold a PR a pending design change would close or rework, with a reason
 * starting {@link REAPPROVAL_HOLD_PREFIX}. A PR already holding some other
 * manual action — an operator's, or the plan's own operator step — is left as
 * it is: it cannot merge either way, and that reason must survive the
 * re-approval. Returns whether this call recorded the hold.
 */
export async function holdForReapproval(prFullName: string, prNumber: number, detail: string, issueLabel: string): Promise<boolean> {
  const existing = (await db.getClawsPr(prFullName, prNumber))?.manualActionReason ?? null;
  if (existing !== null && !existing.startsWith(REAPPROVAL_HOLD_PREFIX)) {
    log.info(`[pr-hold] ${prFullName}#${prNumber} already holds a manual action (${existing}) — leaving it for the re-approval of ${issueLabel}`);
    return false;
  }
  await recordManualAction(prFullName, prNumber, `${REAPPROVAL_HOLD_PREFIX} ${detail}`, issueLabel);
  return true;
}

/**
 * Lift a re-approval hold: remove `Manual Action` — whose removal hook clears
 * the recorded reason — only when that reason starts with
 * {@link REAPPROVAL_HOLD_PREFIX}. A PR with no reason, or one an operator or
 * the plan recorded, is left alone. Returns whether a hold was lifted.
 */
export async function releaseReapprovalHold(prFullName: string, prNumber: number): Promise<boolean> {
  const row = await db.getClawsPr(prFullName, prNumber);
  if (!row?.manualActionReason?.startsWith(REAPPROVAL_HOLD_PREFIX)) return false;
  if (!(await gh.removeLabel(prFullName, prNumber, LABELS.manualAction))) {
    log.warn(`[pr-hold] Could not remove ${LABELS.manualAction} from ${prFullName}#${prNumber} to release its re-approval hold`);
    return false;
  }
  log.info(`[pr-hold] Released the re-approval hold on ${prFullName}#${prNumber}`);
  return true;
}
