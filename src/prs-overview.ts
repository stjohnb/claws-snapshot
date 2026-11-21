/**
 * The `/prs` page's PR state as one read-only answer for `claws_prs_overview`:
 * open PRs with hold and "Needs you" reasons, and the counts. Built from `loadPrAttentionState`, the
 * code the nav PRs count uses, so it cannot drift from the dashboard.
 */
import type { ClawsPrRecord } from "./db.js";
import { holdKindSlug } from "./hold-kind.js";
import { loadOperatorAttentionCounts, loadPrAttentionState, type NavCounts } from "./operator-attention.js";
import { listRepos } from "./github.js";
import { prAttentionKey } from "./pr-attention.js";

export interface PrsOverview {
  counts: {
    nav?: NavCounts;
    open_prs: number;
    needs_you: number;
  };
  open_prs: Array<Record<string, unknown>>;
}

/** The overview for `repo` (case-insensitive) or every repo; `null` when `repo` has no PR rows and is not configured. */
export async function loadPrsOverview(repo?: string): Promise<PrsOverview | null> {
  const [state, nav] = await Promise.all([loadPrAttentionState(), loadOperatorAttentionCounts()]);
  const wanted = repo?.toLowerCase();
  const match = (r: ClawsPrRecord): boolean => !wanted || r.repo.toLowerCase() === wanted;
  if (wanted) {
    const known = (await listRepos()).some((r) => r.fullName.toLowerCase() === wanted);
    if (!known) return null;
  }
  const open = state.rows.filter(match).map((row) => {
    const key = prAttentionKey(row.repo, row.prNumber);
    const reason = row.manualActionReason || null;
    const skipCurrent = !!row.mergeSkipCode && !!row.headSha && row.mergeSkipHead === row.headSha;
    return {
      repo: row.repo,
      number: row.prNumber,
      title: row.title,
      issue_id: row.issueId,
      stage: row.stage,
      ci_status: row.ciStatus,
      review_verdict: row.reviewVerdict,
      merge_approved_by: row.mergeApprovedBy,
      merge_approved_at: row.mergeApprovedAt,
      manual_action_reason: reason,
      hold_kind: reason ? holdKindSlug(reason) : null,
      manual_warning: state.warnings.get(key) ?? null,
      needs_you: state.attention.get(key) ?? [],
      merge_skip_code: skipCurrent ? row.mergeSkipCode ?? null : null,
      merge_skip_reason: skipCurrent ? row.mergeSkipReason ?? null : null,
      updated_at: row.updatedAt,
    };
  });
  return {
    counts: {
      ...(nav ? { nav } : {}),
      open_prs: open.length,
      needs_you: open.filter((p) => (p.needs_you as string[]).length > 0).length,
    },
    open_prs: open,
  };
}
