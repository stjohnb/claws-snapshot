import { isEscalationManualAction } from "../pr-escalation.js";
import { PREVIEW_MODAL_HTML, PREVIEW_MODAL_SCRIPT, NEW_ISSUE_MODAL_CSS, PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, formatRelativeTime, htmlOpenTag, buildPageHeader, THEME_SCRIPT, CATEGORY_DISPLAY, ALPINE_SCRIPT, labelChip, refArg, NO_REPO_WARNING, buildReviewLedger, repoAvatar, repoShortName } from "./layout.js";
import type { NavCounts, Theme } from "./layout.js";
import { getMergeBlockReason, isItemPrioritized, isItemSkipped, type PR, type Issue, type QueueItem } from "../github.js";
import { PR_STATUS_CSS, resolvePRStatus, buildChecksCell, buildReviewStatusBadge, buildInfraBadge, buildInfraHoldNote, infraNote, buildMergeBlockBadge, buildAwaitingApprovalBadge, buildDispatchNote, type PRRowStatus } from "./pr-status.js";
import { repoUrl } from "./repo.js";
import { QUEUE_SCRIPT } from "../resources/queue.generated.js";
import { NEW_ISSUE_MODAL_SCRIPT } from "../resources/new-issue-modal.generated.js";
import { ISSUE_ATTACHMENTS_SCRIPT } from "../resources/issue-attachments.generated.js";
import { LABELS, issueUrl, prUrl, shortIssueRef, type IssueRef } from "../config.js";
import { NEW_ISSUE_BUTTON, NEW_ISSUE_FORM_CSS, buildNewIssueModal, planPreviewBlock, type PlanPreview } from "./issue.js";
import type { ClawsPrRecord } from "../db.js";
import { isDependencyUpdatePR, type PRViewKind } from "../dependency-prs.js";
import { isRenovateMajorUpdate } from "../renovate.js";
import { prAttentionReasons } from "../pr-attention.js";
import { hasManualAction, isMergeApproved, isProblematic, isReviewedHeadAwaitingMerge } from "../pr-state.js";
import { LIST_FILTERS_CSS, filterOptions, filterSelect } from "./list-filters.js";
import { DEFAULT_PRS_QUERY, PRS_CI, PRS_MERGE, PRS_REVIEW, PRS_SORTS, applyPrsQuery, hasPrsFilters, isAwaitingApproval, prFacets, prsHref, PRS_FILTER_KEYS, type PrsFilterKey, type PrsQuery, type PrsSort } from "./prs-view.js";

export type { PRRowStatus };
/**
 * `prRow` is the PR's `claws_prs` row — the PR state the actions read, never `pr.labels`.
 * `approvalExempt` is the auto-merger's `isApprovalExempt` verdict for the PR.
 */
export interface AllPRRow {
  repo: string; pr: PR; status?: PRRowStatus; prRow?: ClawsPrRecord; approvalExempt?: boolean; approvalHoldReason?: string;
  /** The unmet manual action naming why this PR should not merge yet (`loadManualActionWarnings`). */
  manualWarning?: string;
  /** Id of the live session started from this row's Start session button (`listLivePrStartedSessions`); the row links it instead of offering the button. */
  activeSession?: string;
}
/** `plan` is the issue's latest plan, set for native issues only. */
export interface AllIssueRow { repo: string; issue: Issue; plan?: PlanPreview }

/** Splits PR rows into dependency updates (third-party or own-app auto-bump) and the rest. */
export function splitPRRows(rows: AllPRRow[]): { deps: AllPRRow[]; other: AllPRRow[] } {
  const deps: AllPRRow[] = [];
  const other: AllPRRow[] = [];
  for (const row of rows) (isDependencyUpdatePR(row.pr) ? deps : other).push(row);
  return { deps, other };
}

/**
 * True when a dependency PR needs a human decision (major update, infra,
 * escalated review) rather than something Claws handles itself. A recorded
 * hold only gates the merge, and its own warning badge shows it.
 */
export function dependencyNeedsHuman(row: AllPRRow, status: PRRowStatus | undefined = row.status): boolean {
  const { pr } = row;
  if (pr.labels.some((l) => l.name === "major-update")) return true;
  const isRenovate = pr.headRefName.startsWith("renovate/") || pr.author?.login === "renovate[bot]";
  if (isRenovate && isRenovateMajorUpdate(pr)) return true;
  if ((status?.infraPaths?.length ?? 0) > 0) return true;
  return status?.reviewStatus === "escalated";
}

function buildCategoryBadge(qi: QueueItem | undefined): string {
  if (!qi) return "";
  const display = CATEGORY_DISPLAY[qi.category] ?? { label: qi.category, color: "30363d" };
  const chip = labelChip(display.label, display.color, "pipeline-badge");
  // The phone card's checks chip already says CI is failing.
  return qi.category === "ci-failing" ? ` <span class="pr-hide-phone">${chip}</span>` : ` ${chip}`;
}

const svgIcon = (paths: string): string =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** Icons for the /prs action buttons. Shown instead of the text on a phone card only; same glyphs as the board where it has one. */
const PR_ICONS = {
  terminal: `<span class="pr-icon-terminal">&gt;_</span>`,
  goto: svgIcon(`<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>`),
  automerge: svgIcon(`<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>`),
  infra: `<span class="pr-icon-infra">&#x26A0;</span>`,
  clear: svgIcon(`<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`),
  flag: svgIcon(`<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>`),
  merge: svgIcon(`<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>`),
  up: svgIcon(`<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>`),
  down: svgIcon(`<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>`),
  skip: svgIcon(`<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>`),
  restore: svgIcon(`<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>`),
  eye: svgIcon(`<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>`),
  ban: svgIcon(`<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>`),
  cross: svgIcon(`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`),
  refresh: svgIcon(`<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>`),
};

/** Button body: a phone-only icon above the always-visible text label. */
const iconBody = (icon: string, label: string): string =>
  `<span class="pr-icon" aria-hidden="true">${icon}</span><span class="pr-label">${label}</span>`;

const APPROVAL_EXEMPT_TITLE = "Approval-exempt: merges on green, settled CI without a dashboard approval — Dependabot, docs, ideas-collection, auto-bump and trusted non-major Renovate PRs. Approving it changes nothing.";

/**
 * The phone card's chip row, after the title (`pr-phone-only`, hidden from
 * 768px): one chip per piece of PR state, emitted only when it has a value.
 * The attention reasons, manual warning and dispatch note fold into one
 * "Needs you" (or neutral "Waiting") peek that opens the preview modal.
 */
function buildPhoneChips(row: AllPRRow, st: PRRowStatus | undefined, qi: QueueItem | undefined): string {
  const chips: string[] = [];
  const chip = (text: string, tone: string, title?: string) =>
    `<span class="pr-phone-only pr-chip pr-chip-${tone}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(text)}</span>`;
  /** An icon chip: the glyph (with any count) is decoration, the state is the accessible name and tooltip. */
  const iconChip = (glyph: string, tone: string, name: string, count = "") =>
    `<span class="pr-phone-only pr-chip pr-chip-${tone}" role="img" aria-label="${escapeHtml(name)}" title="${escapeHtml(name)}"><span aria-hidden="true">${glyph}${count ? ` ${escapeHtml(count)}` : ""}</span></span>`;
  const checks = st && st.checksTotal > 0 ? `${st.checksPassed}/${st.checksTotal}` : "";
  const withChecks = checks ? ` ${checks}` : "";
  if (st?.checkStatus === "failing") {
    const awaitingDecision = isReviewedHeadAwaitingMerge(row.prRow, row.pr.headRefOid) && !isMergeApproved(row.prRow) && !row.approvalExempt;
    chips.push(iconChip("✘", "danger", `CI failing${withChecks}${awaitingDecision ? " — not auto-fixed while awaiting your merge decision" : ""}`, checks));
  } else if (st?.checkStatus === "pending") {
    chips.push(iconChip("○", "warning", `CI pending${withChecks}`, checks));
  } else if (st?.checkStatus === "held") {
    chips.push(iconChip("⏸", "warning", "CI held for approval"));
  } else if (st?.checkStatus === "passing") {
    chips.push(iconChip("✔", "success", `CI passing${withChecks}`, checks));
  }
  const blockReason = getMergeBlockReason(row.repo, row.pr.number);
  if (blockReason) chips.push(iconChip(PR_ICONS.ban, "danger", `Merge blocked: ${blockReason}`));
  if (st?.reviewStatus === "clean") chips.push(iconChip(PR_ICONS.eye, "success", "Reviewed — clean"));
  else if (st?.reviewStatus === "issues") {
    const n = st.reviewIssueCount ?? 0;
    chips.push(chip(`${n} issue${n === 1 ? "" : "s"} found`, "danger"));
  } else if (st?.reviewStatus === "escalated") chips.push(chip("Escalated — needs human", "danger"));
  if (st?.mergeableState === "CONFLICTING") chips.push(chip("Conflicts", "danger"));
  if (isEscalationManualAction(row.prRow)) chips.push(chip("Escalated", "warning", row.prRow?.manualActionReason ?? undefined));
  if (row.approvalExempt) chips.push(chip("Approval-exempt", "neutral", APPROVAL_EXEMPT_TITLE));
  const reasons = prAttentionReasons(row.prRow, row.manualWarning);
  if (reasons.length || qi?.note) {
    const label = reasons.length ? "Needs you" : "Waiting";
    const list = reasons.length ? `<ul>${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>` : "";
    const paras = [row.manualWarning, qi?.note].filter((t): t is string => Boolean(t)).map((t) => `<p>${escapeHtml(t)}</p>`).join("");
    chips.push(`<details class="preview-peek pr-phone-only pr-peek" data-preview-title="${label}"><summary><span class="${reasons.length ? "pr-chip-operator" : "pr-chip pr-chip-neutral"}">${label}</span></summary><div class="markdown">${list}${paras}</div></details>`);
  }
  return chips.join("");
}

function buildReviewCell(st: PRRowStatus | undefined): string {
  return buildReviewStatusBadge(st) + buildReviewLedger(st?.reviewLedger);
}

/**
 * The trailing `mergePR`/`markAutomerge` argument carrying a manual-action
 * warning, or "" without one. JSON-quoted then HTML-escaped, so a quote in the
 * planner's text cannot break out of the `@click` expression.
 */
function manualNoteArg(manualWarning: string | undefined): string {
  return manualWarning ? `, ${escapeHtml(JSON.stringify(manualWarning))}` : "";
}

/** The unmet-manual-action warning badge, or "" without one. */
export function buildManualWarning(manualWarning: string | undefined): string {
  return manualWarning ? `<span class="manual-warning">&#x26A0; ${escapeHtml(manualWarning)}</span>` : "";
}

function buildMergeAction(st: PRRowStatus | undefined, escapedRepo: string, prNumber: number, pr: PR, prRow: ClawsPrRecord | undefined, approvalExempt: boolean | undefined, manualWarning?: string): string {
  if (!st) return `<span class="merge-blocked">status unknown</span>`;
  if (st.mergeableState === "CONFLICTING") return `<span class="merge-blocked">Conflicts</span>`;
  if (st.checkStatus === "failing") {
    // Not auto-fixed while awaiting your merge decision: the reviewed head hasn't
    // moved, so a failure here reruns for a reason unrelated to a new commit on
    // this PR (issue clw_01M3F9340HHVH185YR16PXVKWK) — CI-fixer is intentionally
    // not spending a fresh fix run on it.
    if (isReviewedHeadAwaitingMerge(prRow, pr.headRefOid) && !isMergeApproved(prRow) && !approvalExempt) {
      return `<span class="merge-blocked">CI failing — not auto-fixed while awaiting your merge decision</span>`;
    }
    return `<span class="merge-blocked">CI failing</span>`;
  }
  if (st.checkStatus === "held") return `<span class="merge-blocked">Held for approval</span>`;
  if (st.checkStatus === "pending") return `<span class="merge-blocked">CI pending</span>`;
  if (st.reviewStatus === "issues") return `<span class="merge-blocked">${escapeHtml(`Review: ${st.reviewIssueCount ?? 0} issues`)}</span>`;
  if (st.reviewStatus === "escalated") return `<span class="merge-blocked">Review escalated</span>`;
  const note = infraNote(st);
  const manual = manualWarning ? `, '${note ? escapeHtml(note) : ""}'${manualNoteArg(manualWarning)}` : note ? `, '${escapeHtml(note)}'` : "";
  if (note) return `<button class="merge-btn merge-infra" @click="mergePR('${escapedRepo}',${prNumber}, $event${manual})" title="Merge infra">${iconBody(PR_ICONS.infra, "Merge infra")}</button>`;
  return `<button class="merge-btn" @click="mergePR('${escapedRepo}',${prNumber}, $event${manual})" title="Squash &amp; Merge">${iconBody(PR_ICONS.merge, "Squash &amp; Merge")}</button>`;
}

/**
 * Prioritise/Deprioritise and Skip/Restore for a row. Both `togglePriority`
 * and `skipItem` flip the button in place via `data-mode`, so a row stays in
 * the table after either action instead of disappearing until the next 60s
 * reload re-renders it from scratch.
 */
function buildQueueControls(repo: string, escapedRepo: string, number: IssueRef): string {
  // Both icons render and phone CSS shows one by the deprio/unskip class, so the
  // client's in-place class flip needs no icon swap.
  const prioIcons = `<span class="pr-icon-prio">${PR_ICONS.up}</span><span class="pr-icon-deprio">${PR_ICONS.down}</span>`;
  const skipIcons = `<span class="pr-icon-skip">${PR_ICONS.skip}</span><span class="pr-icon-unskip">${PR_ICONS.restore}</span>`;
  const prio = isItemPrioritized(repo, number)
    ? `<button class="refined-btn prio-btn deprio" data-mode="deprio" title="Deprioritise" @click="togglePriority('${escapedRepo}',${refArg(number)}, $event)">${iconBody(prioIcons, "Deprioritise")}</button>`
    : `<button class="refined-btn prio-btn" data-mode="prio" title="Prioritise" @click="togglePriority('${escapedRepo}',${refArg(number)}, $event)">${iconBody(prioIcons, "Prioritise")}</button>`;
  const skip = isItemSkipped(repo, number)
    ? `<button class="refined-btn skip-btn unskip" data-mode="unskip" title="Restore" @click="skipItem('${escapedRepo}',${refArg(number)}, $event)">${iconBody(skipIcons, "Restore")}</button>`
    : `<button class="refined-btn skip-btn" data-mode="skip" title="Skip" @click="skipItem('${escapedRepo}',${refArg(number)}, $event)">${iconBody(skipIcons, "Skip")}</button>`;
  return `${prio}${skip}`;
}

/** A badge next to the title of a skipped row, so it reads as skipped at a
 *  glance rather than only through its Restore button. */
function buildSkipBadge(repo: string, number: IssueRef): string {
  return isItemSkipped(repo, number) ? ` <span class="skip-badge">Skipped</span>` : "";
}

/**
 * `newIssueRepos` puts the New issue modal on the page. The modal's script
 * then owns the 60s reload, putting it off while the dialog is open or holds a
 * typed title or body; the meta refresh is kept only for a no-JS browser.
 */
/** The icon-only "Refresh" button (rescans the forges) and its status note. */
function refreshButton(): string {
  return `<button class="trigger-btn refresh-btn" aria-label="Refresh" title="Refresh: rescan the forges for new issues and PRs" @click="refreshQueue($event)">${PR_ICONS.refresh}</button> <span class="list-refresh-note" x-text="refreshStatus"></span>`;
}

function pageShell(title: string, headerTitle: string, theme: Theme, body: string, current: "/prs" | "/issues", navCounts?: NavCounts, newIssueRepos?: string[], opts: { toolbar?: boolean } = {}): string {
  return `<!DOCTYPE html>
${htmlOpenTag(theme, "wide")}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HEAD_META}
  ${newIssueRepos ? `<noscript><meta http-equiv="refresh" content="60"></noscript>` : `<meta http-equiv="refresh" content="60">`}
  <title>claws — ${escapeHtml(title)}</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${PR_STATUS_CSS}${LIST_FILTERS_CSS}
  .list-plan { font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.3rem; }
  .list-plan > summary { cursor: pointer; font-family: var(--font-display); }
  .list-plan[open] > .markdown { color: var(--text); overflow-wrap: anywhere; }
  .merge-error { font-size: 0.8em; color: var(--danger, #d73a49); margin-left: 8px; word-break: break-word; }
  .session-started { font-size: 0.8em; color: var(--success); margin-left: 8px; }
  .merge-blocked { font-size: 0.85em; color: var(--text-subtle); }
  .filter-count { color: var(--text-subtle); margin-left: 0.3rem; }
  .list-refresh-note { font-size: 0.85em; color: var(--text-subtle); }
  .list-refresh-note:empty { display: none; }
  .list-actions { display: inline-flex; align-items: center; gap: 0.5rem; }
  .refresh-btn, .prs-clear, .prs-filter-remove { display: inline-flex; align-items: center; justify-content: center; padding: 0; width: 36px; min-height: 36px; flex: 0 0 auto; }
  .prs-toolbar a.trigger-btn.prs-clear, .prs-toolbar a.trigger-btn.prs-filter-remove { display: inline-flex; text-decoration: none; }
  .prs-clear { margin-left: auto; }
  .prs-toolbar .filter-bar a { white-space: nowrap; }
  @media (min-width: 768px) {
    .refresh-btn, .prs-clear, .prs-filter-remove { width: 30px; min-height: 30px; }
    .prs-toolbar .form-field-compact { flex: 0 1 auto; min-width: 0; }
    .prs-toolbar .form-field-compact .form-select { width: 100%; max-width: 9rem; min-width: 0; }
  }
  .prs-toolbar { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
  .prs-toolbar .filter-bar, .prs-toolbar .list-filters { margin-bottom: 0; }
  .prs-toolbar .list-filters { display: contents; }
  .prs-toolbar + h2 { margin-top: 0.5rem; }
  .skip-btn:hover:not(:disabled) { background: var(--danger); color: #fff; }
  .skip-btn.unskip:hover:not(:disabled) { background: var(--success); color: #fff; }
  .merge-btn.merge-infra { border-color:var(--danger); color:var(--danger); }
  .refined-btn.refined-exempt { cursor: default; color: var(--text-subtle); background: transparent; }
  .refined-btn.refined-exempt:hover { background: transparent; color: var(--text-subtle); }
  .skip-badge { display:inline-block; font-size:0.75rem; font-weight:600; color:var(--warning); border:1px solid var(--warning); border-radius:12px; padding:0.1rem 0.5rem; margin-left:0.3rem; white-space:nowrap; vertical-align:middle; }
  .manual-warning { display: block; color: var(--warning); font-size: 0.8rem; font-weight: 600; overflow-wrap: anywhere; }
  .pr-draft-chip { display: inline-block; font-size: 0.75rem; color: var(--text-secondary); border: 1px solid var(--border); border-radius: 12px; padding: 0.1rem 0.5rem; margin-left: 0.3rem; white-space: nowrap; }
  .needs-you { display: block; color: var(--warning); font-size: 0.8rem; font-weight: 600; overflow-wrap: anywhere; }
  .action-secondary { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; margin-top: 4px; }
  .action-secondary > .refined-btn { margin-left: 0; }
  .action-secondary > a.refined-btn { text-align: center; }
  .action-secondary > a.refined-btn:hover { text-decoration: none; }
  .pr-phone-only { display: none; }
  .pr-icon { display: none; }
  table.prs-compact .action-stack, table.prs-compact .action-secondary { align-items: stretch; }
  table.prs-compact .action-stack > .merge-btn, table.prs-compact .action-stack > .refined-btn, table.prs-compact .action-secondary > .refined-btn { text-align: center; }${newIssueRepos ? NEW_ISSUE_FORM_CSS + NEW_ISSUE_MODAL_CSS : ""}
  @media (max-width: 767px) {
    .merge-btn, .refined-btn { width: 100%; min-height: 38px; }
    .cell-actions .action-stack { align-items: stretch; flex: 1 1 auto; min-width: 0; }
    .skip-badge { margin-left: 0; margin-top: 0.25rem; }
    /* /prs phone card, a sibling of the /board card: head line (avatar,
       repo#N, age), title, one chip row, one compact action row. Each state
       shows once, so the duplicates below are hidden and the pr-phone-only
       chips stand in for them. Every rule is scoped to table.prs-compact so
       it beats .data-cards-wide and leaves 768px and up untouched. */
    table.prs-compact .pr-phone-only { display: inline-block; }
    table.prs-compact .pr-peek.pr-phone-only { display: inline; }
    table.prs-compact .pr-hide-phone,
    table.prs-compact .pr-repo-name,
    table.prs-compact td[data-label="Checks"],
    table.prs-compact td[data-label="Review"],
    table.prs-compact td.cell-title .needs-you,
    table.prs-compact td.cell-title .manual-warning,
    table.prs-compact td.cell-title .dispatch-note,
    table.prs-compact .cell-actions .merge-blocked,
    table.prs-compact .cell-actions .manual-warning,
    table.prs-compact .cell-actions .skip-badge,
    table.prs-compact .cell-actions .refined-exempt { display: none; }
    table.prs-compact td::before { content: none; }
    table.prs-compact tr { flex-direction: row; flex-wrap: wrap; align-items: center; column-gap: 0.4rem; row-gap: 0; }
    table.prs-compact td { padding: 0; font-size: 0.75rem; }
    table.prs-compact td.cell-title { order: 1; flex-basis: 100%; margin: 0.35rem 0 0; }
    table.prs-compact td.cell-actions { order: 2; flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.5rem; }
    table.prs-compact td[data-label="Repo"] .repo-avatar { margin-right: 0; }
    table.prs-compact td[data-label="PR"] a { font-family: var(--font-display); }
    table.prs-compact td[data-label="Created"] { display: none; }
    table.prs-compact.prs-sort-created td[data-label="Created"] { display: block; }
    table.prs-compact.prs-sort-created td[data-label="Updated"] { display: none; }
    table.prs-compact td[data-label="Updated"], table.prs-compact td[data-label="Created"] { font-family: var(--font-display); font-size: 0.65rem; line-height: 1.3; padding: 0 0.35rem; border: 1px solid var(--border); border-radius: 10px; color: var(--text-subtle); white-space: nowrap; }
    table.prs-compact .pr-chips { display: flex; flex-wrap: wrap; gap: 0.25rem; margin-top: 0.3rem; font-weight: 400; }
    table.prs-compact .pr-chips > :where(:not(.label-chip, .pipeline-badge, .pr-peek)) { font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 12px; margin: 0; border: 1px solid currentColor; }
    table.prs-compact .pr-chips > .pipeline-badge { font-size: 0.7rem; padding: 0.1rem 0.45rem; margin: 0; }
    table.prs-compact .pr-chip-danger { color: var(--danger); }
    table.prs-compact .pr-chip-warning { color: var(--warning); }
    table.prs-compact .pr-chip-success { color: var(--success); }
    table.prs-compact .pr-chips > .pr-chip-neutral { color: var(--text-secondary); border-color: var(--border); }
    table.prs-compact .pr-peek > summary { display: inline; list-style: none; cursor: pointer; }
    table.prs-compact .pr-peek > summary::-webkit-details-marker { display: none; }
    table.prs-compact .pr-peek .pr-chip-operator,
    table.prs-compact .pr-peek .pr-chip-neutral { font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 12px; display: inline-block; border: 1px solid var(--warning); color: var(--warning); }
    table.prs-compact .pr-peek .pr-chip-neutral { border-color: var(--border); color: var(--text-secondary); }
    table.prs-compact .pr-peek[open] > .markdown { font-size: 0.8rem; color: var(--text); }
    table.prs-compact .cell-actions .action-stack,
    table.prs-compact .cell-actions .action-secondary { display: contents; }
    table.prs-compact td.cell-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-auto-rows: 1fr; gap: 0.35rem; align-items: stretch; }
    /* Fixed slots: the same action sits in the same cell on every card; empty slots stay empty. */
    table.prs-compact .cell-actions .merge-btn { grid-area: 1 / 1; }
    table.prs-compact .cell-actions .pr-automerge-btn { grid-area: 1 / 2; }
    table.prs-compact .cell-actions .pr-start-session, table.prs-compact .cell-actions .pr-go-to-session { grid-area: 1 / 3; }
    table.prs-compact .cell-actions .prio-btn { grid-area: 2 / 1; }
    table.prs-compact .cell-actions .skip-btn { grid-area: 2 / 2; }
    table.prs-compact .cell-actions .pr-clear-manual-btn { grid-area: 2 / 3; }
    table.prs-compact .cell-actions .pr-unmark-btn { grid-column: 1 / -1; grid-row: 3; }
    /* Icon over an always-visible label, so no button depends on hover or an accessible name. */
    table.prs-compact .cell-actions .merge-btn,
    table.prs-compact .cell-actions .refined-btn { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; width: auto; min-width: 0; min-height: 44px; padding: 0.3rem 0.25rem; margin: 0; font-size: 0.65rem; line-height: 1.15; white-space: normal; text-align: center; }
    table.prs-compact .pr-label { position: static; overflow-wrap: anywhere; text-align: center; }
    table.prs-compact .pr-icon { display: inline-flex; align-items: center; justify-content: center; }
    table.prs-compact .pr-icon svg { width: 16px; height: 16px; }
    table.prs-compact .pr-icon-terminal, table.prs-compact .pr-icon-infra { font-family: var(--font-display); font-weight: 700; font-size: 0.85rem; line-height: 1; }
    table.prs-compact .pr-icon-deprio, table.prs-compact .pr-icon-unskip { display: none; }
    table.prs-compact .prio-btn.deprio .pr-icon-prio, table.prs-compact .skip-btn.unskip .pr-icon-skip { display: none; }
    table.prs-compact .prio-btn.deprio .pr-icon-deprio, table.prs-compact .skip-btn.unskip .pr-icon-unskip { display: inline-flex; }
    /* The set Automerge tick follows the label text rather than the column-flex button. */
    table.prs-compact .cell-actions .refined-btn::after { display: none; }
    table.prs-compact .cell-actions .refined-done .pr-label::after { content: " ✓"; }
    table.prs-compact .pr-chips > .merge-conflict { display: none; }
    table.prs-compact .pr-chip > [aria-hidden="true"] svg { width: 14px; height: 14px; vertical-align: -2px; }
    table.prs-compact .cell-actions .merge-error,
    table.prs-compact .cell-actions .session-started { grid-column: 1 / -1; margin-left: 0; }
    table.prs-compact .cell-actions .refined-btn.refined-done,
    table.prs-compact .cell-actions .refined-btn.refined-done:hover { background: transparent; color: var(--success); border: 1px solid var(--success); opacity: 1; }
  }
  @media (max-width: 767px) and (hover: none) {
    table.prs-compact .cell-actions .refined-btn:hover:not(:disabled):not(.refined-done), table.prs-compact .cell-actions .skip-btn:hover:not(:disabled) { background: var(--bg-secondary); color: var(--text); }
  }
  </style>
  ${ALPINE_SCRIPT}
</head>
<body x-data="queuePage()">
  ${buildPageHeader(headerTitle, theme, { current, navCounts })}
  ${THEME_SCRIPT}
  ${opts.toolbar ? "" : `<p class="list-actions">${refreshButton()}</p>`}
  ${body}
  ${PREVIEW_MODAL_HTML}
  ${newIssueRepos ? buildNewIssueModal(newIssueRepos, undefined, { reloadSeconds: 60 }) : ""}
  ${QUEUE_SCRIPT}
  ${PREVIEW_MODAL_SCRIPT}
  ${newIssueRepos ? NEW_ISSUE_MODAL_SCRIPT + ISSUE_ATTACHMENTS_SCRIPT : ""}
</body>
</html>`;
}

const PRS_SORT_LABELS: Record<PrsSort, string> = {
  updated: "Date updated", created: "Date created", repo: "Repository", title: "Title", author: "Author", ci: "CI status",
};
const PRS_CI_LABELS: Record<string, string> = { passing: "Passing", failing: "Failing", pending: "Pending", held: "Held", none: "None" };
const PRS_FILTER_LABELS: Record<PrsFilterKey, string> = { repo: "Repository", author: "Author", label: "Label", ci: "CI", review: "Review", merge: "Merge" };
const PRS_REVIEW_LABELS: Record<string, string> = { clean: "Clean", issues: "Issues", escalated: "Escalated", none: "None" };
const PRS_MERGE_LABELS: Record<string, string> = { conflicts: "Conflicts", blocked: "Merge blocked", automerge: "Automerge set", awaiting: "Ready, needs automerge" };

function prsSortHeader(query: PrsQuery, field: PrsSort, label: string): string {
  const active = query.sort === field;
  const dir = active ? (query.dir === "asc" ? "desc" : "asc") : "asc";
  const arrow = active ? (query.dir === "asc" ? " ▲" : " ▼") : "";
  return `<th><a href="${escapeHtml(prsHref({ ...query, sort: field, dir }))}">${escapeHtml(label)}${arrow}</a></th>`;
}

function prsFilterForm(query: PrsQuery, rows: AllPRRow[]): string {
  const sortOptions = PRS_SORTS.map((s) => `<option value="${s}"${s === query.sort ? " selected" : ""}>${escapeHtml(PRS_SORT_LABELS[s])}</option>`).join("");
  const dirOptions = `<option value="desc"${query.dir === "desc" ? " selected" : ""}>Descending</option><option value="asc"${query.dir === "asc" ? " selected" : ""}>Ascending</option>`;
  const compact = { compact: true, autoSubmit: true, emptyText: "Any" };
  const submitOnChange = ` @change="$el.form.requestSubmit()"`;
  const selects: Record<PrsFilterKey, string> = {
    repo: filterSelect("repo", "Repository", filterOptions(rows.map((r) => r.repo), query.repo), query.repo, repoShortName, compact),
    author: filterSelect("author", "Author", filterOptions(rows.map((r) => r.pr.author?.login ?? ""), query.author), query.author, undefined, compact),
    label: filterSelect("label", "Label", filterOptions(rows.flatMap((r) => r.pr.labels.map((l) => l.name)), query.label), query.label, undefined, compact),
    ci: filterSelect("ci", "CI", [...PRS_CI], query.ci, (v) => PRS_CI_LABELS[v], compact),
    review: filterSelect("review", "Review", [...PRS_REVIEW], query.review, (v) => PRS_REVIEW_LABELS[v], compact),
    merge: filterSelect("merge", "Merge", [...PRS_MERGE], query.merge, (v) => PRS_MERGE_LABELS[v], compact),
  };
  const filterRows = PRS_FILTER_KEYS.map((key) => {
    const label = PRS_FILTER_LABELS[key];
    const head = `<span class="prs-filter-key">${label}</span>${selects[key]}`;
    if (query[key]) {
      const href = escapeHtml(prsHref({ ...query, [key]: "" }));
      return `<div class="prs-filter">${head}<a class="trigger-btn prs-filter-remove" href="${href}" aria-label="Remove ${label} filter" title="Remove ${label} filter">${PR_ICONS.cross}</a></div>`;
    }
    return `<div class="prs-filter" x-cloak x-show="pending === '${key}'">${head}<button type="button" class="trigger-btn prs-filter-remove" @click="pending = ''" aria-label="Remove ${label} filter" title="Remove ${label} filter">${PR_ICONS.cross}</button></div>`;
  }).join("\n      ");
  const emptyKeys = PRS_FILTER_KEYS.filter((key) => !query[key]);
  const addFilter = emptyKeys.length === 0 ? "" : `<label class="form-field form-field-compact"><span class="visually-hidden">Add filter</span>
        <select class="form-select" title="Add filter" @change="pending = $el.value; $el.value = ''"><option value="" selected>Add filter</option>${emptyKeys.map((key) => `<option value="${key}">${PRS_FILTER_LABELS[key]}</option>`).join("")}</select>
      </label>`;
  return `<form class="list-filters list-filters-compact" method="GET" action="/prs" x-data="{ pending: '' }">
      <input type="hidden" name="kind" value="${escapeHtml(query.kind)}">
      ${filterRows}
      ${addFilter}
      <label class="form-field form-field-compact"><span class="visually-hidden">Sort</span>
        <select class="form-select" name="sort" title="Sort"${submitOnChange}>${sortOptions}</select>
      </label>
      <label class="form-field form-field-compact"><span class="visually-hidden">Direction</span>
        <select class="form-select" name="dir" title="Direction"${submitOnChange}>${dirOptions}</select>
      </label>
      <noscript><style>.prs-filter[x-cloak] { display: flex !important; }</style><button class="trigger-btn" type="submit">Filter</button></noscript>
    </form>`;
}

export function buildAllPRsPage(rows: AllPRRow[], queueItems: QueueItem[], theme: Theme, query: PrsQuery, navCounts?: NavCounts): string {
  const kind = query.kind;
  const queueByKey = new Map<string, QueueItem>();
  for (const qi of queueItems) {
    queueByKey.set(`${qi.repo}#${qi.number}`, qi);
  }
  const statusOf = (row: AllPRRow) => resolvePRStatus(row, queueByKey.get(`${row.repo}#${row.pr.number}`));

  const { deps, other } = splitPRRows(rows);
  const blocked = rows.filter((row) => prAttentionReasons(row.prRow, row.manualWarning).length > 0);
  const viewRows = kind === "deps" ? deps : kind === "other" ? other : kind === "blocked" ? blocked : rows;
  const sorted = applyPrsQuery(viewRows, query, (row) => prFacets(row, statusOf(row)), (row) => dependencyNeedsHuman(row, statusOf(row)));
  const chips: Array<[PRViewKind, string, number]> = [["deps", "Dependencies", deps.length], ["other", "Other", other.length], ["blocked", "Blocked", blocked.length]];
  const filterBar = `<div class="filter-bar" id="pr-kind-filter">${chips.map(([k, label, n]) =>
    `<a href="${escapeHtml(prsHref({ ...query, kind: k === kind ? "all" : k }))}" data-kind="${k}"${k === kind ? ` class="active"` : ""}>${label}<span class="filter-count">${n}</span></a>`).join("")}</div>`;

  const prRows = sorted.map((row) => {
    const { repo, pr } = row;
    const qi = queueByKey.get(`${repo}#${pr.number}`);
    const st = resolvePRStatus(row, qi);
    const badges = buildCategoryBadge(qi);
    const updatedStr = pr.updatedAt ? formatRelativeTime(pr.updatedAt) : "";
    const createdStr = pr.createdAt ? formatRelativeTime(pr.createdAt) : "";
    const draftChip = pr.isDraft ? `<span class="pr-draft-chip pr-chip-neutral" title="Draft pull request">Draft</span>` : "";
    const [owner, name] = repo.split("/");
    const escapedRepo = escapeHtml(repo);
    const mergeBtn = buildMergeAction(st, escapedRepo, pr.number, pr, row.prRow, row.approvalExempt, row.manualWarning);
    const alreadyAutomerge = isMergeApproved(row.prRow);
    // Unmark also resets the CI-fixer breaker. Forge labels are a write-only
    // mirror, so these buttons are the only way to clear either state.
    const unmarkBtn = isProblematic(row.prRow)
      ? `<button class="refined-btn pr-unmark-btn" @click="unmarkProblematic('${escapedRepo}',${pr.number}, $event)">${iconBody(PR_ICONS.flag, "Unmark problematic")}</button>`
      : "";
    const clearManualBtn = hasManualAction(row.prRow)
      ? `<button class="refined-btn pr-clear-manual-btn" @click="clearManualAction('${escapedRepo}',${pr.number}, $event)">${iconBody(PR_ICONS.clear, "Clear manual action")}</button>`
      : "";
    const automergeBtn = row.approvalExempt
      ? `<span class="refined-btn pr-automerge-btn refined-exempt" title="${APPROVAL_EXEMPT_TITLE}">Approval-exempt</span>`
      : alreadyAutomerge
      ? `<span class="refined-btn pr-automerge-btn refined-done" title="Automerge set for ${escapeHtml(`${repo}#${pr.number}`)}">${iconBody(PR_ICONS.automerge, "Automerge")}</span>`
      : `<button class="refined-btn pr-automerge-btn" title="Automerge" @click="markAutomerge('${escapedRepo}',${pr.number}, $event, false${manualNoteArg(row.manualWarning)})">${iconBody(PR_ICONS.automerge, "Automerge")}</button>`;
    const sessionLabel = escapeHtml(`${repo}#${pr.number}`);
    // Text buttons in the secondary group: Go to session while a PR-started
    // session is live, so the operator does not start a duplicate.
    const sessionCtl = row.activeSession
      ? `<a class="refined-btn pr-go-to-session" href="/sessions/${encodeURIComponent(row.activeSession)}" title="Go to session for ${sessionLabel}" aria-label="Go to session for ${sessionLabel}">${iconBody(PR_ICONS.goto, "Go to session")}</a>`
      : `<button class="refined-btn pr-start-session" @click="startPrSession('${escapedRepo}',${pr.number}, $event)" title="Start session for ${sessionLabel}" aria-label="Start session for ${sessionLabel}">${iconBody(PR_ICONS.terminal, "Start session")}</button>`;
    const manualWarning = buildManualWarning(row.manualWarning);
    const attention = prAttentionReasons(row.prRow, row.manualWarning);
    const needsYou = attention.length ? `<span class="needs-you">&#x26A0; Needs you: ${escapeHtml(attention.join(" \u00B7 "))}</span>` : "";
    const escalationNote = isEscalationManualAction(row.prRow)
      ? `<span class="skip-badge" title="${escapeHtml(row.prRow?.manualActionReason ?? "")}">Escalated — won't merge until a clean review round</span>`
      : "";
    const approvalBadge = isAwaitingApproval(row, st) ? buildAwaitingApprovalBadge(row.approvalHoldReason) : "";
    return `<tr>
      <td data-label="Repo"><a href="${repoUrl(owner, name)}" title="${escapeHtml(repo)}">${repoAvatar(repo)}<span class="pr-repo-name">${escapeHtml(repoShortName(repo))}</span></a></td>
      <td data-label="PR"><a href="${encodeURI(prUrl(repo, pr.number))}"><span class="pr-phone-only">${escapeHtml(repoShortName(repo))}</span>#${pr.number}</a></td>
      <td class="cell-title" data-label="Title">${escapeHtml(pr.title)}<span class="pr-chips">${draftChip}${badges}${buildSkipBadge(repo, pr.number)}${buildInfraBadge(st)}${buildMergeBlockBadge(repo, pr.number)}${approvalBadge}${buildPhoneChips(row, st, qi)}</span>${buildInfraHoldNote(st, st?.infraBumpEligible === undefined ? Boolean(st?.infraPinOnly && row.approvalExempt) : st.infraBumpEligible && (alreadyAutomerge || Boolean(row.approvalExempt)), st?.infraBumpHoldReason)}${needsYou}${manualWarning}${buildDispatchNote(qi)}</td>
      <td class="hide-sm" data-label="Author">${escapeHtml(pr.author?.login ?? "")}</td>
      <td data-label="Updated" title="${escapeHtml(pr.updatedAt ?? "")}">${escapeHtml(updatedStr)}</td>
      <td class="hide-sm" data-label="Created" title="${escapeHtml(pr.createdAt ?? "")}">${escapeHtml(createdStr)}</td>
      <td class="hide-sm" data-label="Branch">${escapeHtml(pr.headRefName)}</td>
      <td data-label="Checks">${buildChecksCell(st)}</td>
      <td data-label="Review">${buildReviewCell(st)}</td>
      <td class="cell-actions" data-label=""><div class="action-stack">${mergeBtn}${automergeBtn}${escalationNote}${manualWarning}</div><div class="action-secondary">${unmarkBtn}${clearManualBtn}${buildQueueControls(repo, escapedRepo, pr.number)}${sessionCtl}</div></td>
    </tr>`;
  }).join("\n");

  const body = `
  <div class="section">
    <div class="prs-toolbar">
      ${refreshButton()}
      ${filterBar}
      ${prsFilterForm(query, rows)}
      <a class="trigger-btn prs-clear" href="${escapeHtml(prsHref({ ...DEFAULT_PRS_QUERY, sort: query.sort, dir: query.dir }))}" aria-label="Clear filters" title="Clear filters">${PR_ICONS.cross}</a>
    </div>
    <h2>Open PRs <span>${sorted.length}</span></h2>
    ${sorted.length > 0 ? `
    <div class="table-scroll"><table class="data-cards data-cards-wide prs-compact${query.sort === "created" ? " prs-sort-created" : ""}">
      <thead><tr>${prsSortHeader(query, "repo", "Repo")}<th>PR</th>${prsSortHeader(query, "title", "Title")}${prsSortHeader(query, "author", "Author")}${prsSortHeader(query, "updated", "Updated")}${prsSortHeader(query, "created", "Created")}<th>Branch</th>${prsSortHeader(query, "ci", "Checks")}<th>Review</th><th>Actions</th></tr></thead>
      <tbody>${prRows}</tbody>
    </table></div>` : `<p class="queue-empty">${hasPrsFilters(query) ? `No PRs match these filters. <a href="/prs?kind=all">Clear filters</a>` : kind === "blocked" ? "No PRs need you" : "No open PRs"}</p>`}
  </div>`;

  return pageShell("All PRs", "All PRs", theme, body, "/prs", navCounts, undefined, { toolbar: true });
}

/**
 * A Claws-native issue with no repository yet. These never come through
 * `listOpenIssues`, which lists an issue under its primary repo, so the list
 * page has to fetch and render them separately or they would be invisible.
 */
export interface UnassignedIssueRow {
  id: string;
  title: string;
  authorLogin: string;
  updatedAt: string;
  repos: string[];
  plan?: PlanPreview;
}

function listPlan(plan: PlanPreview | undefined): string {
  return plan ? planPreviewBlock(plan, "list-plan") : "";
}

function buildUnassignedSection(rows: UnassignedIssueRow[], opts?: { title: string; note: string }): string {
  if (rows.length === 0) return "";
  const title = opts?.title ?? "Unassigned";
  const note = opts?.note ?? `${NO_REPO_WARNING} — these are waiting for one.`;
  const issueRows = rows.map((row) => `<tr>
      <td data-label="Issue"><a href="/issues/${escapeHtml(row.id)}" title="${escapeHtml(row.id)}">#${escapeHtml(shortIssueRef(row.id))}</a></td>
      <td class="cell-title" data-label="Title"><a href="/issues/${escapeHtml(row.id)}">${escapeHtml(row.title)}</a>${listPlan(row.plan)}</td>
      <td class="hide-sm" data-label="Author">${escapeHtml(row.authorLogin)}</td>
      <td data-label="Repos">${row.repos.length === 0 ? "none" : escapeHtml(row.repos.join(", "))}</td>
      <td data-label="Updated">${escapeHtml(row.updatedAt ? formatRelativeTime(row.updatedAt) : "")}</td>
    </tr>`).join("\n");
  return `
  <div class="section">
    <h2>${escapeHtml(title)} <span>${rows.length}</span></h2>
    <p class="queue-empty">${escapeHtml(note)}</p>
    <div class="table-scroll"><table class="data-cards">
      <thead><tr><th>Issue</th><th>Title</th><th>Author</th><th>Repos</th><th>Updated</th></tr></thead>
      <tbody>${issueRows}</tbody>
    </table></div>
  </div>`;
}

/**
 * Items skipped by hand or auto-skipped by the timeout / memory-limit handlers,
 * whose comment tells the operator to re-queue them from the dashboard.
 */
function buildSkippedSection(skipped: ReadonlyArray<{ repo: string; number: IssueRef }>): string {
  if (skipped.length === 0) return "";
  const skippedRows = skipped.map(({ repo, number }) => {
    const escapedRepo = escapeHtml(repo);
    const full = String(number);
    const short = shortIssueRef(number);
    const title = short !== full ? ` title="${escapeHtml(full)}"` : "";
    const [owner, name] = repo.split("/");
    return `<tr>
      <td data-label="Repo"><a href="${repoUrl(owner, name)}" title="${escapedRepo}">${repoAvatar(repo)}${escapeHtml(repoShortName(repo))}</a></td>
      <td class="cell-title" data-label="Item"><a href="${encodeURI(issueUrl(repo, number))}"${title}>#${escapeHtml(short)}</a></td>
      <td class="cell-actions" data-label=""><div class="action-stack"><button class="refined-btn" @click="unskipItem('${escapedRepo}',${refArg(number)}, $event)">Restore</button></div></td>
    </tr>`;
  }).join("\n");
  return `
  <div class="section">
    <h2>Skipped <span>${skipped.length}</span></h2>
    <p class="queue-empty">Claws will not work on these until they are restored.</p>
    <div class="table-scroll"><table class="data-cards">
      <thead><tr><th>Repo</th><th>Item</th><th>Actions</th></tr></thead>
      <tbody>${skippedRows}</tbody>
    </table></div>
  </div>`;
}

export function buildAllIssuesPage(
  rows: AllIssueRow[],
  queueItems: QueueItem[],
  theme: Theme,
  unassigned: UnassignedIssueRow[] = [],
  skipped: ReadonlyArray<{ repo: string; number: IssueRef }> = [],
  orphaned: UnassignedIssueRow[] = [],
  navCounts?: NavCounts,
  allRepos: string[] = [],
): string {
  const queueByKey = new Map<string, QueueItem>();
  for (const qi of queueItems) {
    queueByKey.set(`${qi.repo}#${qi.number}`, qi);
  }

  const sorted = [...rows].sort((a, b) => (b.issue.updatedAt || "").localeCompare(a.issue.updatedAt || ""));

  const issueRows = sorted.map(({ repo, issue, plan }) => {
    const qi = queueByKey.get(`${repo}#${issue.number}`);
    const badges = buildCategoryBadge(qi);
    const updatedStr = issue.updatedAt ? formatRelativeTime(issue.updatedAt) : "";
    const [owner, name] = repo.split("/");
    // The row sits under the primary repo (the dispatch rule) but shows every repo the issue names.
    const primaryTitle = (issue.repos?.length ?? 0) > 1 ? ` title="Primary repository: owns planning and labels (${escapeHtml(repo)})"` : ` title="${escapeHtml(repo)}"`;
    const alsoNames = (issue.repos ?? []).filter((r) => r !== repo)
      .map((r) => ` <span style="color: var(--text-secondary); font-size: 0.8em;" title="Also names ${escapeHtml(r)}">+${escapeHtml(repoShortName(r))}</span>`).join("");
    const escapedRepo = escapeHtml(repo);
    const fullIssueRef = String(issue.number);
    const shortIssueRefStr = shortIssueRef(issue.number);
    const issueRefTitle = shortIssueRefStr !== fullIssueRef ? ` title="${escapeHtml(fullIssueRef)}"` : "";
    const alreadyRefined = issue.labels.some((l) => l.name === LABELS.refined);
    const alreadyAutomerge = issue.labels.some((l) => l.name === LABELS.automerge);
    const isBlocked = issue.labels.some((l) => l.name === LABELS.blocked);
    const isBacklog = issue.labels.some((l) => l.name === LABELS.backlog);
    const refinedBtn = isBacklog
      ? `<span class="refined-btn refined-done">Backlog</span>`
      : isBlocked
      ? `<span class="refined-btn refined-done">Blocked</span>`
      : alreadyAutomerge && alreadyRefined
      ? `<span class="refined-btn refined-done">Automerge</span>`
      : alreadyRefined
        ? `<button class="refined-btn" @click="markAutomerge('${escapedRepo}',${refArg(issue.number)}, $event, false)">Automerge</button>`
        : `<button class="refined-btn" @click="markRefined('${escapedRepo}',${refArg(issue.number)}, $event)">Refined</button>` +
          `<button class="refined-btn" @click="markAutomerge('${escapedRepo}',${refArg(issue.number)}, $event, true)">Refine &amp; Merge</button>`;
    return `<tr>
      <td data-label="Repo"><a href="${repoUrl(owner, name)}"${primaryTitle}>${repoAvatar(repo)}${escapeHtml(repoShortName(repo))}</a>${alsoNames}</td>
      <td data-label="Issue"><a href="${encodeURI(issueUrl(repo, issue.number))}"${issueRefTitle}>#${escapeHtml(shortIssueRefStr)}</a></td>
      <td class="cell-title" data-label="Title">${escapeHtml(issue.title)}${badges}${buildSkipBadge(repo, issue.number)}${listPlan(plan)}</td>
      <td class="hide-sm" data-label="Author">${escapeHtml(issue.author?.login ?? "")}</td>
      <td data-label="Updated">${escapeHtml(updatedStr)}</td>
      <td class="cell-actions" data-label=""><div class="action-stack">${refinedBtn}${buildQueueControls(repo, escapedRepo, issue.number)}</div></td>
    </tr>`;
  }).join("\n");

  const body = `
  <div class="section">
    <h2>Open Issues <span>${sorted.length}</span></h2>
    <p>${NEW_ISSUE_BUTTON("/issues/new")}</p>
    ${sorted.length > 0 ? `
    <div class="table-scroll"><table class="data-cards">
      <thead><tr><th>Repo</th><th>Issue</th><th>Title</th><th>Author</th><th>Updated</th><th>Actions</th></tr></thead>
      <tbody>${issueRows}</tbody>
    </table></div>` : `<p class="queue-empty">No open issues</p>`}
  </div>
  ${buildUnassignedSection(unassigned)}
  ${buildUnassignedSection(orphaned, { title: "Repository no longer configured", note: "None of these issues' repositories is configured in Claws any more — close them, or give them a configured repository." })}
  ${buildSkippedSection(skipped)}`;

  return pageShell("All Issues", "All Issues", theme, body, "/issues", navCounts, allRepos);
}
