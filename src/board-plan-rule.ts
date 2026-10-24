/**
 * The board's plan rule (docs/refinements/issue-flow.md, "The board"):
 * Approved and Awaiting plan review mean a plan exists, so a move into either
 * is refused for an issue that has none. Without it, a drag straight to
 * Approved skips requirements approval, the plan and its review, and a drag to
 * Awaiting plan review parks the issue on a gate with nothing to review.
 *
 * A dependency-free leaf, unlike `issue-board.ts` (which imports `config.ts`
 * and `node:fs` with it): `client/issue-board.ts` imports this module, and
 * esbuild inlines it into the board's bundle, so the client's pre-flight and
 * `applyBoardMove` apply the same rule with the same words and cannot drift
 * apart. `issue-board.ts` re-exports it for server-side callers.
 */

/** Why a move to Approved is refused for an issue with no plan. */
export const APPROVED_NEEDS_PLAN_REJECTION =
  "Approved needs a plan — move the issue to Planning first so Claws writes one.";

/** Why a move to Awaiting plan review is refused for an issue with no plan. */
export const REVIEW_NEEDS_PLAN_REJECTION =
  "Awaiting plan review needs a plan — move the issue to Planning first so Claws writes one.";

/**
 * Why a move to `to` is refused for an issue that has (or has not) a plan, or
 * undefined when the plan rule allows it. Only Approved and Awaiting plan
 * review need a plan; every other destination passes.
 */
export function planRefusal(to: string, hasPlan: boolean): string | undefined {
  if (hasPlan) return undefined;
  if (to === "approved") return APPROVED_NEEDS_PLAN_REJECTION;
  if (to === "awaiting-plan-review") return REVIEW_NEEDS_PLAN_REJECTION;
  return undefined;
}
