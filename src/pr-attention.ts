/**
 * Why an open PR waits on the operator, shared by the nav PRs count
 * (`operator-attention.ts`) and the "Needs you" line on `/prs`
 * (`pages/lists.ts`) so the list and the count cannot drift apart.
 */

import type { ClawsPrRecord } from "./db.js";
import { ciFixerGaveUpOnHead, getMergeBlockCode } from "./github.js";
import type { MergeSkipCode } from "./agents/auto-merger.js";
import { isProblematic } from "./pr-state.js";

/** Auto-merger block codes only a person can resolve; Claws clears the rest itself. */
export const OPERATOR_MERGE_BLOCK_CODES: ReadonlySet<MergeSkipCode> = new Set<MergeSkipCode>([
  "stacked", "reapproval-hold", "auto-bump-gate", "infra", "infra-plan", "doc-pr-mixed", "ideas-pr-mixed", "checks-held", "checks-missing",
]);

/** Human labels for each reason the PR needs the operator; empty when it does not. */
export function prAttentionReasons(row: ClawsPrRecord | undefined, manualWarning?: string): string[] {
  if (!row) return [];
  const reasons: string[] = [];
  if (ciFixerGaveUpOnHead(row.repo, row.prNumber, row.headSha)) reasons.push("CI fixer gave up");
  if (manualWarning) reasons.push("Manual action pending");
  if (isProblematic(row)) reasons.push("Claws Problematic");
  if (row.ciBlockedReason !== null) reasons.push("CI blocked");
  const code = getMergeBlockCode(row.repo, row.prNumber);
  if (code && OPERATOR_MERGE_BLOCK_CODES.has(code as MergeSkipCode)) reasons.push("Merge blocked — needs you");
  return reasons;
}
