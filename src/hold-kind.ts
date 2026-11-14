/**
 * Leaf module: the prefixes a recorded PR hold (`claws_prs.manual_action_reason`)
 * can start with, and the kind they classify into. No imports, so the
 * browser-bundled `issue-board.ts` can use it; `pr-hold.ts` re-exports it.
 */

/** How every re-approval hold's recorded reason starts. */
export const REAPPROVAL_HOLD_PREFIX = "Held for re-approval:";
/** How a reviewer escalation's recorded reason starts. */
export const ESCALATION_REASON_PREFIX = "review escalated: ";
/** How a stacked PR's recorded reason starts. */
export const STACKED_PREFIX = "Stacked PR:";
/** How a refused CI re-run's recorded reason starts. */
export const CI_RERUN_REFUSED_PREFIX = "CI re-run refused:";

/** How a merged PR's post-merge manual action's recorded reason starts. */
export const POST_MERGE_PREFIX = "Manual action after merge:";

const SELF_CLEARING_PREFIXES = [REAPPROVAL_HOLD_PREFIX, ESCALATION_REASON_PREFIX, STACKED_PREFIX, CI_RERUN_REFUSED_PREFIX] as const;

/** A hold's kind: `post-merge`, the self-clearing prefix its reason starts with, or `operator-step`. */
export function holdKind(reason: string): string {
  if (reason.startsWith(POST_MERGE_PREFIX)) return "post-merge";
  return SELF_CLEARING_PREFIXES.find((p) => reason.startsWith(p)) ?? "operator-step";
}

/** Whether `reason` is a merged PR's post-merge manual action ({@link POST_MERGE_PREFIX}). */
export function isPostMergeAction(reason: string | null | undefined): boolean {
  return !!reason && reason.startsWith(POST_MERGE_PREFIX);
}

/** Whether `reason` is an operator step before merge — none of the self-clearing kinds. */
export function isOperatorStepHold(reason: string | null | undefined): boolean {
  return !!reason && holdKind(reason) === "operator-step";
}
