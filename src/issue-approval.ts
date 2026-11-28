/**
 * An issue's approval as one stored value (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F):
 * `claws_issues.approved_through` says how far along the Requirements → Plan
 * → Merge track a human (or an automation acting for one) has approved the
 * issue. `plan` is what makes the implementer run; `merge` is what lets its
 * PRs merge. It replaced the `Refined`, `Ready`, `Ship`, `Claws Auto-Refine`
 * and `Automerge` labels.
 *
 * A leaf module, for the same reason as `issue-lifecycle.ts`: `db.ts` and the
 * board's leaf modules import it, and test suites mock `./config.js`, so it
 * imports nothing.
 */

/** Every value `approved_through` may hold, lowest first. */
export const APPROVAL_GATES = ["none", "requirements", "plan", "merge"] as const;

export type ApprovedThrough = (typeof APPROVAL_GATES)[number];

/** The gates a track shows, in order; `none` is no gate. */
export type ApprovalGateName = Exclude<ApprovedThrough, "none">;

export function isApprovedThrough(value: unknown): value is ApprovedThrough {
  return typeof value === "string" && (APPROVAL_GATES as readonly string[]).includes(value);
}

/** The value's position on the track: 0 for `none` up to 3 for `merge`. An unknown value reads as `none`. */
export function approvalRank(value: string | null | undefined): number {
  const rank = (APPROVAL_GATES as readonly string[]).indexOf(value ?? "none");
  return rank < 0 ? 0 : rank;
}

/** Whether `value` is approved through `gate` or beyond. */
export function atLeast(value: string | null | undefined, gate: ApprovedThrough): boolean {
  return approvalRank(value) >= approvalRank(gate);
}

/** The higher of two approvals. */
export function maxApproval(a: ApprovedThrough, b: ApprovedThrough): ApprovedThrough {
  return approvalRank(a) >= approvalRank(b) ? a : b;
}

/**
 * The value that withdraws a Merge approval from `current`: Plan from Merge,
 * otherwise `current` restated — which clears a partial Merge (every open PR
 * row approved one by one) without raising the issue to Plan.
 */
export function withdrawMergeTarget(current: ApprovedThrough): ApprovedThrough {
  return atLeast(current, "merge") ? "plan" : current;
}

/**
 * The "Stops at" sentence for the first gate not yet approved, or the
 * run-to-merge sentence when every gate is. Shared by the approval track and
 * the MCP tools, so a session reads the same words as the card.
 */
export function stopsAtFor(firstOpenGate: ApprovalGateName | null | undefined): string {
  switch (firstOpenGate) {
    case "requirements": return "Stops at: requirements review";
    case "plan": return "Stops at: plan review";
    case "merge": return "Stops at: merge approval";
    default: return "Runs to merge — no further stop";
  }
}
