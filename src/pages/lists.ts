import { isEscalationManualAction } from "../pr-escalation.js";
import { PREVIEW_MODAL_HTML, PREVIEW_MODAL_SCRIPT, PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, formatRelativeTime, htmlOpenTag, buildPageHeader, THEME_SCRIPT, CATEGORY_DISPLAY, ALPINE_SCRIPT, labelChip, refArg, NO_REPO_WARNING, buildReviewLedger, repoShortName } from "./layout.js";
import type { Theme } from "./layout.js";
import { isItemPrioritized, isItemSkipped, type PR, type Issue, type QueueItem } from "../github.js";
import { PR_STATUS_CSS, resolvePRStatus, buildChecksCell, buildReviewStatusBadge, buildInfraBadge, buildInfraHoldNote, infraNote, buildMergeBlockBadge, buildAwaitingApprovalBadge, buildDispatchNote, type PRRowStatus } from "./pr-status.js";
import { repoUrl } from "./repo.js";
import { QUEUE_SCRIPT } from "../resources/queue.generated.js";
import { LABELS, issueUrl, prUrl, shortIssueRef, type IssueRef } from "../config.js";
import { planPreviewBlock, type PlanPreview } from "./issue.js";
import type { ClawsPrRecord } from "../db.js";
import { isDependencyUpdatePR, type PRViewKind } from "../dependency-prs.js";
import { isRenovateMajorUpdate } from "../renovate.js";
import { hasManualAction, isMergeApproved, isProblematic, isReviewedHeadAwaitingMerge } from "../pr-state.js";

export type { PRRowStatus };
/**
 * `prRow` is the PR's `claws_prs` row — the PR state the actions read, never `pr.labels`.
 * `approvalExempt` is the auto-merger's `isApprovalExempt` verdict for the PR.
 */
export interface AllPRRow {
  repo: string; pr: PR; status?: PRRowStatus; prRow?: ClawsPrRecord; approvalExempt?: boolean; approvalHoldReason?: string;
  /** The unmet manual action naming why this PR should not merge yet (`loadManualActionWarnings`). */
  manualWarning?: string;
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
 * escalated review, Manual Action) rather than something Claws handles itself.
 */
export function dependencyNeedsHuman(row: AllPRRow, status: PRRowStatus | undefined = row.status): boolean {
  const { pr } = row;
  if (pr.labels.some((l) => l.name === "major-update")) return true;
  const isRenovate = pr.headRefName.startsWith("renovate/") || pr.author?.login === "renovate[bot]";
  if (isRenovate && isRenovateMajorUpdate(pr)) return true;
  if ((status?.infraPaths?.length ?? 0) > 0) return true;
  if (status?.reviewStatus === "escalated") return true;
  return hasManualAction(row.prRow);
}

function buildCategoryBadge(qi: QueueItem | undefined): string {
  if (!qi) return "";
  const display = CATEGORY_DISPLAY[qi.category] ?? { label: qi.category, color: "30363d" };
  return ` ${labelChip(display.label, display.color, "pipeline-badge")}`;
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
  if (note) return `<button class="merge-btn merge-infra" @click="mergePR('${escapedRepo}',${prNumber}, $event${manual})">&#x26A0; Merge infra</button>`;
  return `<button class="merge-btn" @click="mergePR('${escapedRepo}',${prNumber}, $event${manual})">Squash &amp; Merge</button>`;
}

/**
 * Prioritise/Deprioritise and Skip/Restore for a row. Both `togglePriority`
 * and `skipItem` flip the button in place via `data-mode`, so a row stays in
 * the table after either action instead of disappearing until the next 60s
 * reload re-renders it from scratch.
 */
function buildQueueControls(repo: string, escapedRepo: string, number: IssueRef): string {
  const prio = isItemPrioritized(repo, number)
    ? `<button class="refined-btn prio-btn deprio" data-mode="deprio" @click="togglePriority('${escapedRepo}',${refArg(number)}, $event)">Deprioritise</button>`
    : `<button class="refined-btn prio-btn" data-mode="prio" @click="togglePriority('${escapedRepo}',${refArg(number)}, $event)">Prioritise</button>`;
  const skip = isItemSkipped(repo, number)
    ? `<button class="refined-btn skip-btn unskip" data-mode="unskip" @click="skipItem('${escapedRepo}',${refArg(number)}, $event)">Restore</button>`
    : `<button class="refined-btn skip-btn" data-mode="skip" @click="skipItem('${escapedRepo}',${refArg(number)}, $event)">Skip</button>`;
  return `${prio}${skip}`;
}

/** A badge next to the title of a skipped row, so it reads as skipped at a
 *  glance rather than only through its Restore button. */
function buildSkipBadge(repo: string, number: IssueRef): string {
  return isItemSkipped(repo, number) ? ` <span class="skip-badge">Skipped</span>` : "";
}

function pageShell(title: string, headerTitle: string, theme: Theme, body: string, current: "/prs" | "/issues"): string {
  return `<!DOCTYPE html>
${htmlOpenTag(theme, "wide")}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HEAD_META}
  <meta http-equiv="refresh" content="60">
  <title>claws — ${escapeHtml(title)}</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${PR_STATUS_CSS}
  .list-plan { font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.3rem; }
  .list-plan > summary { cursor: pointer; font-family: var(--font-display); }
  .list-plan[open] > .markdown { color: var(--text); overflow-wrap: anywhere; }
  .merge-error { font-size: 0.8em; color: var(--danger, #d73a49); margin-left: 8px; word-break: break-word; }
  .merge-blocked { font-size: 0.85em; color: var(--text-subtle); }
  .filter-count { color: var(--text-subtle); margin-left: 0.3rem; }
  .list-refresh-note { font-size: 0.85em; color: var(--text-subtle); }
  .skip-btn:hover:not(:disabled) { background: var(--danger); color: #fff; }
  .skip-btn.unskip:hover:not(:disabled) { background: var(--success); color: #fff; }
  .merge-btn.merge-infra { border-color:var(--danger); color:var(--danger); }
  .refined-btn.refined-exempt { cursor: default; color: var(--text-subtle); background: transparent; }
  .refined-btn.refined-exempt:hover { background: transparent; color: var(--text-subtle); }
  .skip-badge { display:inline-block; font-size:0.75rem; font-weight:600; color:var(--warning); border:1px solid var(--warning); border-radius:12px; padding:0.1rem 0.5rem; margin-left:0.3rem; white-space:nowrap; vertical-align:middle; }
  .manual-warning { display: block; color: var(--warning); font-size: 0.8rem; font-weight: 600; overflow-wrap: anywhere; }
  .action-secondary { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; margin-top: 4px; }
  .action-secondary > .refined-btn { margin-left: 0; }
  @media (max-width: 767px) {
    .merge-btn, .refined-btn { width: 100%; min-height: 38px; }
    .cell-actions .action-stack { align-items: stretch; flex: 1 1 auto; min-width: 0; }
    .skip-badge { margin-left: 0; margin-top: 0.25rem; }
    /* Only the PR table stacks up to five buttons (Merge, Automerge, Unmark,
       Prioritise, Skip); a two-column grid keeps a full row from running to
       ~200px of buttons on a phone card. */
    .action-secondary { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
  }
  </style>
  ${ALPINE_SCRIPT}
</head>
<body x-data="queuePage()">
  ${buildPageHeader(headerTitle, theme, { current })}
  ${THEME_SCRIPT}
  <p class="list-actions"><button class="trigger-btn" @click="refreshQueue($event)" title="Trigger issue-dispatcher and pr-dispatcher to rescan the forges">Refresh from GitHub</button> <span class="list-refresh-note" x-text="refreshStatus"></span></p>
  ${body}
  ${PREVIEW_MODAL_HTML}
  ${QUEUE_SCRIPT}
  ${PREVIEW_MODAL_SCRIPT}
</body>
</html>`;
}

export function buildAllPRsPage(rows: AllPRRow[], queueItems: QueueItem[], theme: Theme, kind: PRViewKind = "all"): string {
  const queueByKey = new Map<string, QueueItem>();
  for (const qi of queueItems) {
    queueByKey.set(`${qi.repo}#${qi.number}`, qi);
  }

  const { deps, other } = splitPRRows(rows);
  const viewRows = kind === "deps" ? deps : kind === "other" ? other : rows;
  const byUpdated = (a: AllPRRow, b: AllPRRow) => (b.pr.updatedAt || "").localeCompare(a.pr.updatedAt || "");
  const sorted = [...viewRows].sort(byUpdated);
  if (kind === "deps") {
    const flags = new Map(sorted.map((row) => [row, dependencyNeedsHuman(row, resolvePRStatus(row, queueByKey.get(`${row.repo}#${row.pr.number}`)))]));
    sorted.sort((a, b) => Number(flags.get(b)) - Number(flags.get(a)) || byUpdated(a, b));
  }
  const chips: Array<[PRViewKind, string, number]> = [["all", "All", rows.length], ["deps", "Dependencies", deps.length], ["other", "Other", other.length]];
  const filterBar = `<div class="filter-bar" id="pr-kind-filter">${chips.map(([k, label, n]) =>
    `<a href="/prs?kind=${k}" data-kind="${k}"${k === kind ? ` class="active"` : ""}>${label}<span class="filter-count">${n}</span></a>`).join("")}</div>`;

  const prRows = sorted.map((row) => {
    const { repo, pr } = row;
    const qi = queueByKey.get(`${repo}#${pr.number}`);
    const st = resolvePRStatus(row, qi);
    const badges = buildCategoryBadge(qi);
    const updatedStr = pr.updatedAt ? formatRelativeTime(pr.updatedAt) : "";
    const [owner, name] = repo.split("/");
    const escapedRepo = escapeHtml(repo);
    const mergeBtn = buildMergeAction(st, escapedRepo, pr.number, pr, row.prRow, row.approvalExempt, row.manualWarning);
    const alreadyAutomerge = isMergeApproved(row.prRow);
    // Unmark also resets the CI-fixer breaker. Forge labels are a write-only
    // mirror, so these buttons are the only way to clear either state.
    const unmarkBtn = isProblematic(row.prRow)
      ? `<button class="refined-btn" @click="unmarkProblematic('${escapedRepo}',${pr.number}, $event)">Unmark problematic</button>`
      : "";
    const clearManualBtn = hasManualAction(row.prRow)
      ? `<button class="refined-btn" @click="clearManualAction('${escapedRepo}',${pr.number}, $event)">Clear manual action</button>`
      : "";
    const automergeBtn = row.approvalExempt
      ? `<span class="refined-btn refined-exempt" title="Approval-exempt: merges on green, settled CI without a dashboard approval — Dependabot, docs, ideas-collection, auto-bump and trusted non-major Renovate PRs. Approving it changes nothing.">Approval-exempt</span>`
      : alreadyAutomerge
      ? `<span class="refined-btn refined-done">Automerge</span>`
      : `<button class="refined-btn" @click="markAutomerge('${escapedRepo}',${pr.number}, $event, false${manualNoteArg(row.manualWarning)})">Automerge</button>`;
    const manualWarning = buildManualWarning(row.manualWarning);
    const escalationNote = isEscalationManualAction(row.prRow)
      ? `<span class="skip-badge" title="${escapeHtml(row.prRow?.manualActionReason ?? "")}">Escalated — won't merge until a clean review round</span>`
      : "";
    const awaitingApproval =
      !alreadyAutomerge && !hasManualAction(row.prRow) && !row.approvalExempt &&
      st?.reviewStatus === "clean" &&
      (st.checkStatus === "passing" || st.checkStatus === "none") &&
      st.mergeableState !== "CONFLICTING";
    const approvalBadge = awaitingApproval ? buildAwaitingApprovalBadge(row.approvalHoldReason) : "";
    return `<tr>
      <td data-label="Repo"><a href="${repoUrl(owner, name)}" title="${escapeHtml(repo)}">${escapeHtml(repoShortName(repo))}</a></td>
      <td data-label="PR"><a href="${encodeURI(prUrl(repo, pr.number))}">#${pr.number}</a></td>
      <td class="cell-title" data-label="Title">${escapeHtml(pr.title)}${badges}${buildSkipBadge(repo, pr.number)}${buildInfraBadge(st)}${buildInfraHoldNote(st, Boolean(st?.infraPinOnly && row.approvalExempt))}${buildMergeBlockBadge(repo, pr.number)}${approvalBadge}${manualWarning}${buildDispatchNote(qi)}</td>
      <td class="hide-sm" data-label="Author">${escapeHtml(pr.author?.login ?? "")}</td>
      <td data-label="Updated">${escapeHtml(updatedStr)}</td>
      <td class="hide-sm" data-label="Branch">${escapeHtml(pr.headRefName)}</td>
      <td data-label="Checks">${buildChecksCell(st)}</td>
      <td data-label="Review">${buildReviewCell(st)}</td>
      <td class="cell-actions" data-label=""><div class="action-stack">${mergeBtn}${automergeBtn}${escalationNote}${manualWarning}</div><div class="action-secondary">${unmarkBtn}${clearManualBtn}${buildQueueControls(repo, escapedRepo, pr.number)}</div></td>
    </tr>`;
  }).join("\n");

  const body = `
  <div class="section">
    ${filterBar}
    <h2>Open PRs <span>${sorted.length}</span></h2>
    ${sorted.length > 0 ? `
    <div class="table-scroll"><table class="data-cards data-cards-wide">
      <thead><tr><th>Repo</th><th>PR</th><th>Title</th><th>Author</th><th>Updated</th><th>Branch</th><th>Checks</th><th>Review</th><th>Actions</th></tr></thead>
      <tbody>${prRows}</tbody>
    </table></div>` : `<p class="queue-empty">No open PRs</p>`}
  </div>`;

  return pageShell("All PRs", "All PRs", theme, body, "/prs");
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

function buildUnassignedSection(rows: UnassignedIssueRow[]): string {
  if (rows.length === 0) return "";
  const issueRows = rows.map((row) => `<tr>
      <td data-label="Issue"><a href="/issues/${escapeHtml(row.id)}" title="${escapeHtml(row.id)}">#${escapeHtml(shortIssueRef(row.id))}</a></td>
      <td class="cell-title" data-label="Title"><a href="/issues/${escapeHtml(row.id)}">${escapeHtml(row.title)}</a>${listPlan(row.plan)}</td>
      <td class="hide-sm" data-label="Author">${escapeHtml(row.authorLogin)}</td>
      <td data-label="Repos">${row.repos.length === 0 ? "none" : escapeHtml(row.repos.join(", "))}</td>
      <td data-label="Updated">${escapeHtml(row.updatedAt ? formatRelativeTime(row.updatedAt) : "")}</td>
    </tr>`).join("\n");
  return `
  <div class="section">
    <h2>Unassigned <span>${rows.length}</span></h2>
    <p class="queue-empty">${escapeHtml(NO_REPO_WARNING)} — these are waiting for one.</p>
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
      <td data-label="Repo"><a href="${repoUrl(owner, name)}" title="${escapedRepo}">${escapeHtml(repoShortName(repo))}</a></td>
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
      <td data-label="Repo"><a href="${repoUrl(owner, name)}"${primaryTitle}>${escapeHtml(repoShortName(repo))}</a>${alsoNames}</td>
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
    <p><a class="trigger-btn" href="/issues/new">New issue</a></p>
    ${sorted.length > 0 ? `
    <div class="table-scroll"><table class="data-cards">
      <thead><tr><th>Repo</th><th>Issue</th><th>Title</th><th>Author</th><th>Updated</th><th>Actions</th></tr></thead>
      <tbody>${issueRows}</tbody>
    </table></div>` : `<p class="queue-empty">No open issues</p>`}
  </div>
  ${buildUnassignedSection(unassigned)}
  ${buildSkippedSection(skipped)}`;

  return pageShell("All Issues", "All Issues", theme, body, "/issues");
}
