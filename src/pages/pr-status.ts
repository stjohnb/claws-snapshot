import { escapeHtml } from "./layout.js";
import { getMergeBlockReason, type CheckStatus, type PR, type QueueItem, type ReviewLedgerEntry } from "../github.js";
import { heldRunCount } from "../workflow-hold.js";
import { tofuPlanChangeCount } from "../tofu-plan.js";

/**
 * Shared renderers for an open PR's live status, so the repository page and
 * the All PRs page draw the same PR the same way from the same data.
 */
export interface PRRowStatus {
  checkStatus: CheckStatus;
  checksPassed: number;
  checksTotal: number;
  mergeableState: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewStatus?: "clean" | "issues" | "escalated" | "none";
  reviewIssueCount?: number;
  infraPaths?: string[];
  tofuPlan?: { add: number; change: number; replace: number; destroy: number };
  /** Whether the plan is verified against this head's own Tofu Plan run (see `getTofuPlanEvidence`). */
  tofuPlanState?: "noop" | "changes" | "unavailable";
  tofuPlanDetail?: string;
  /** Every changed file is a provider pin (`versions.tf` / `.terraform.lock.hcl`). */
  infraPinOnly?: boolean;
  reviewLedger?: ReviewLedgerEntry[];
}

/**
 * A held workflow run starts no jobs, so it can be entirely missing from the
 * check rollup that `st` was built from — the rollup then reads `passing`,
 * `none` or `pending` on a head that still has a run stuck in
 * `action_required`. The dispatcher's per-tick `observeHeldRuns` (every open
 * GitHub PR) and `tryMerge`'s own live listing
 * (`src/workflow-hold.ts`) record the held count they observe against the
 * head SHA; when one is on file for `pr`'s current head, it overrides one of
 * those three rollup-derived statuses to `held` so `/prs` never shows a hold
 * as passing.
 */
function applyRecordedHold(st: PRRowStatus, repo: string, pr: PR): PRRowStatus {
  if (st.checkStatus !== "passing" && st.checkStatus !== "none" && st.checkStatus !== "pending") return st;
  if (!pr.headRefOid) return st;
  const held = heldRunCount(repo, pr.headRefOid);
  if (!held) return st;
  return { ...st, checkStatus: "held", checksTotal: st.checksTotal + held };
}

/**
 * Status for a PR row comes from the bulk fetch when available, and otherwise
 * falls back to whatever the in-memory queue cache knows — so the page degrades
 * gracefully rather than blanking out if the bulk fetch failed. Either way, a
 * held workflow run recorded against the current head overrides the result
 * (see {@link applyRecordedHold}).
 */
export function resolvePRStatus(row: { repo: string; pr: PR; status?: PRRowStatus }, qi: QueueItem | undefined): PRRowStatus | undefined {
  if (row.status) {
    const st = row.status.reviewStatus === undefined && qi
      ? { ...row.status, reviewStatus: qi.reviewStatus, reviewIssueCount: qi.reviewIssueCount }
      : row.status;
    return applyRecordedHold(st, row.repo, row.pr);
  }
  if (qi && qi.checkStatus) {
    return applyRecordedHold({
      checkStatus: qi.checkStatus,
      checksPassed: qi.checksPassed ?? 0,
      checksTotal: qi.checksTotal ?? 0,
      mergeableState: qi.mergeableState ?? "UNKNOWN",
      reviewStatus: qi.reviewStatus,
      reviewIssueCount: qi.reviewIssueCount,
      infraPaths: qi.infraPaths,
      tofuPlan: qi.tofuPlan,
      tofuPlanState: qi.tofuPlanState,
      tofuPlanDetail: qi.tofuPlanDetail,
      infraPinOnly: qi.infraPinOnly,
      reviewLedger: qi.reviewLedger,
    }, row.repo, row.pr);
  }
  return undefined;
}

export function buildChecksCell(st: PRRowStatus | undefined): string {
  if (!st) return `<span class="check-badge" style="color:var(--text-subtle)">unknown</span>`;
  if (st.checkStatus === "none") return `<span class="check-badge" style="color:var(--text-subtle)">no checks</span>`;
  const color = st.checkStatus === "passing" ? "var(--success)" : st.checkStatus === "failing" ? "var(--danger)" : "var(--warning)";
  const icon = st.checkStatus === "passing" ? "&#x2714;" : st.checkStatus === "failing" ? "&#x2718;" : st.checkStatus === "held" ? "&#x23F8;" : "&#x25CB;";
  // A run held for approval on GitHub is not red: name it so it reads apart from a failure.
  const label = st.checkStatus === "held" ? " held" : "";
  const counts = st.checksTotal > 0 ? ` ${st.checksPassed}/${st.checksTotal}` : "";
  return `<span class="check-badge" style="color:${color}">${icon}${label}${escapeHtml(counts)}</span>`;
}

export function buildReviewStatusBadge(st: PRRowStatus | undefined): string {
  if (!st || !st.reviewStatus || st.reviewStatus === "none") return "—";
  if (st.reviewStatus === "clean") return `<span class="check-badge" style="color:var(--success)">Reviewed — clean</span>`;
  if (st.reviewStatus === "escalated") return `<span class="check-badge" style="color:var(--danger)">Escalated — needs human</span>`;
  const n = st.reviewIssueCount ?? 0;
  return `<span class="check-badge" style="color:var(--danger)">${escapeHtml(`${n} issue${n === 1 ? "" : "s"} found`)}</span>`;
}

/** Plain-ASCII, quote-free summary — safe to inline in an Alpine @click string. */
export function infraNote(st: PRRowStatus | undefined): string {
  if (!st?.infraPaths?.length) return "";
  const p = st.tofuPlan;
  return p ? `${p.add} to add, ${p.change} to change, ${p.replace} to replace, ${p.destroy} to destroy`
           : "tofu/terraform files changed";
}

export function buildInfraBadge(st: PRRowStatus | undefined): string {
  if (!st?.infraPaths?.length) return "";
  const p = st.tofuPlan;
  const destructive = p ? p.replace + p.destroy > 0 : false;
  const label = p ? `Infra &middot; ${p.add}+ ${p.change}~ ${p.replace}↻ ${p.destroy}-` : "Infra (tofu)";
  const tip = escapeHtml(st.infraPaths.slice(0, 5).join(", "));
  return ` <span class="infra-badge${destructive ? " infra-destructive" : ""}" title="${tip}">&#x26A0; ${label}</span>`;
}

/**
 * One line saying why an infra PR is held, or that it will merge: the
 * auto-merger's no-op plan exception admits only a trusted dependency PR with
 * a pin-only diff (`eligible`; undefined when the page cannot tell) whose plan
 * for the current head is a verified no-op.
 */
export function buildInfraHoldNote(st: PRRowStatus | undefined, eligible: boolean | undefined): string {
  if (!st?.infraPaths?.length || !st.tofuPlanState) return "";
  let text: string;
  if (st.tofuPlanState === "changes" && st.tofuPlan) {
    const n = tofuPlanChangeCount(st.tofuPlan);
    text = `Plan shows ${n} change${n === 1 ? "" : "s"} — human merge required`;
  } else if (st.tofuPlanState === "noop") {
    text = eligible === undefined ? "No-op plan for this head"
      : eligible ? "No-op plan — merging on next cycle"
      : "No-op plan — human merge required (not a trusted dependency update)";
  } else {
    text = `Plan not available for this head: ${st.tofuPlanDetail ?? "unknown"}`;
  }
  return ` <span class="merge-blocked">${escapeHtml(text)}</span>`;
}

/** A badge for a PR the forge reports as in conflict with its base branch. */
export function buildConflictBadge(st: PRRowStatus | undefined): string {
  return st?.mergeableState === "CONFLICTING" ? ` <span class="merge-conflict">&#x26A0; Conflicts</span>` : "";
}

/** Why the auto-merger last declined this approved PR, if it has (#2971). */
export function buildMergeBlockBadge(repo: string, prNumber: number): string {
  const reason = getMergeBlockReason(repo, prNumber);
  if (!reason) return "";
  return ` <span class="merge-conflict" title="${escapeHtml(reason)}">&#x26A0; Merge blocked</span>`;
}

/** Why no agent will act on this PR this cycle, from its queue item's note. */
export function buildDispatchNote(qi: QueueItem | undefined): string {
  if (!qi?.note) return "";
  return `<div class="dispatch-note">${escapeHtml(qi.note)}</div>`;
}

/**
 * An otherwise-mergeable PR whose merge only lacks a dashboard approval, so
 * an operator can tell it apart from one blocked on review, CI or conflicts.
 * The caller decides when it applies.
 */
export function buildAwaitingApprovalBadge(reason?: string): string {
  const title = reason ? escapeHtml(reason) : "Approve the merge from the dashboard (Automerge or Merge)";
  return ` <span class="check-badge" style="color:var(--warning)" title="${title}">Awaiting approval</span>`;
}

/** Styles for the badges above; `.merge-conflict` lives in `PAGE_CSS`. */
export const PR_STATUS_CSS = `
  .pipeline-badge {
    display: inline-block;
    padding: 0.2rem 0.6rem;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
    vertical-align: middle;
    margin-left: 0.3rem;
  }
  .check-badge {
    font-size: 0.75rem;
    font-weight: 600;
    vertical-align: middle;
    margin-left: 0.3rem;
  }
  .infra-badge { display:inline-block; font-size:0.75rem; font-weight:600; color:var(--warning); border:1px solid var(--warning); border-radius:12px; padding:0.1rem 0.5rem; margin-left:0.3rem; white-space:nowrap; vertical-align:middle; }
  .infra-badge.infra-destructive { color:var(--danger); border-color:var(--danger); }
  .dispatch-note { color: var(--text-secondary); font-size: 0.85em; margin-top: 0.25rem; }
  @media (max-width: 767px) {
    .pipeline-badge { margin-left: 0; margin-top: 0.25rem; }
    .check-badge { margin-left: 0; }
    .infra-badge { margin-left: 0; margin-top: 0.25rem; }
  }
`;
