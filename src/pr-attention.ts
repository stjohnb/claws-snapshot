/**
 * Why an open PR waits on the operator: the one rule behind `/board`'s PR
 * cards and Needs-you lines, the `/prs` Blocked chip and "Needs you" line, and
 * the nav PRs count (`operator-attention.ts`), so none of them can disagree.
 *
 * Every input is read from the database — the `claws_prs` row (with the
 * auto-merger's persisted last skip), the manual-action warnings and the
 * CI fixer's give-ups in `tasks` — so the web tier, which has none of the
 * controller's in-memory state, sees the same reasons.
 */

import * as db from "./db.js";
import { CI_FIXER_MAX_IDLE_RUNS_PER_HEAD, CI_FIXER_WINDOW_MS } from "./config.js";
import type { ClawsPrRecord } from "./db.js";
import type { MergeSkipCode } from "./agents/auto-merger.js";
import { isReadyToMerge } from "./gate-events.js";
import { isMergeApproved, isProblematic } from "./pr-state.js";
import { loadManualActionWarnings, manualWarningRow } from "./planned-prs.js";

/** Auto-merger block codes only a person can resolve; Claws clears the rest itself. */
export const OPERATOR_MERGE_BLOCK_CODES: ReadonlySet<MergeSkipCode> = new Set<MergeSkipCode>([
  "stacked", "reapproval-hold", "image-scan-gate", "infra", "infra-plan", "infra-approval-stale", "infra-undeclared", "doc-pr-mixed", "ideas-pr-mixed", "checks-held", "checks-missing", "deploy-red",
]);

/** The block codes that mean an infrastructure PR needs a human merge. */
export const INFRA_MERGE_BLOCK_CODES: ReadonlySet<MergeSkipCode> = new Set<MergeSkipCode>(["infra", "infra-plan", "infra-approval-stale", "infra-undeclared"]);

/** How long a persisted skip counts, matching `MERGE_BLOCK_TTL_MS` in `github.ts`. */
export const MERGE_SKIP_TTL_MS = 60 * 60 * 1000;

/** The signals beside the row that `prAttentionReasons` reads; `loadPrAttention` batches them. */
export interface PrAttentionContext {
  /** The row's `loadManualActionWarnings` warning, if any. */
  manualWarning?: string;
  /** Whether the CI fixer has stopped on the row's current head (`listCiFixerGiveUpHeads`). */
  ciFixerGaveUp?: boolean;
}

/** The persisted auto-merger skip code, when it is for the row's current head and under `MERGE_SKIP_TTL_MS` old. */
function freshSkipCode(row: ClawsPrRecord, now: number): MergeSkipCode | null {
  if (!row.mergeSkipCode || !row.mergeSkipAt) return null;
  if (!row.headSha || row.mergeSkipHead !== row.headSha) return null;
  const at = Date.parse(row.mergeSkipAt);
  if (!Number.isFinite(at) || now - at > MERGE_SKIP_TTL_MS) return null;
  return row.mergeSkipCode as MergeSkipCode;
}

/** The attention reason of a ready PR that waits only on the operator's merge approval. */
export const READY_TO_APPROVE_REASON = "Ready — approve the merge";

/** Human labels for each reason the PR needs the operator; empty when it does not. Pure. */
export function prAttentionReasons(row: ClawsPrRecord | undefined, ctx: PrAttentionContext = {}, now = Date.now()): string[] {
  if (!row) return [];
  const reasons: string[] = [];
  if (ctx.ciFixerGaveUp && (row.ciStatus === "failing" || row.stage === "ci-failing")) reasons.push("CI fixer gave up");
  if (ctx.manualWarning) reasons.push("Manual action pending");
  if (isProblematic(row)) reasons.push("Claws Problematic");
  if (row.ciBlockedReason !== null) reasons.push("CI blocked");
  const code = freshSkipCode(row, now);
  if (code && INFRA_MERGE_BLOCK_CODES.has(code)) reasons.push("Needs infra merge");
  else if (code && OPERATOR_MERGE_BLOCK_CODES.has(code)) reasons.push("Merge blocked — needs you");
  else if (code === "not-approved" && isReadyToMerge(row) && !isMergeApproved(row)) reasons.push(READY_TO_APPROVE_REASON);
  return reasons;
}

/** The `loadPrAttention` key for a PR. */
export function prAttentionKey(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

/**
 * `prAttentionReasons` for each of `rows`, keyed `repo#number` (rows with no
 * reason are left out), with the manual-action warnings and CI-fixer give-ups
 * read in one batch each. The only entry point the pages and counts use.
 * `warnings` skips the manual-action read for a caller that already holds it.
 */
export async function loadPrAttention(
  rows: readonly ClawsPrRecord[],
  opts: { warnings?: ReadonlyMap<string, string> } = {},
): Promise<Map<string, string[]>> {
  const [warnings, gaveUp] = await Promise.all([
    opts.warnings ?? loadManualActionWarnings(rows.map(manualWarningRow)),
    db.listCiFixerGiveUpHeads(rows, { windowMs: CI_FIXER_WINDOW_MS(), maxNoopRuns: CI_FIXER_MAX_IDLE_RUNS_PER_HEAD }),
  ]);
  const now = Date.now();
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const key = prAttentionKey(row.repo, row.prNumber);
    const reasons = prAttentionReasons(row, {
      manualWarning: warnings.get(key),
      ciFixerGaveUp: gaveUp.has(`${key}#${row.headSha}`),
    }, now);
    if (reasons.length > 0) out.set(key, reasons);
  }
  return out;
}
