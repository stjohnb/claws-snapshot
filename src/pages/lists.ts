import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, formatRelativeTime, htmlOpenTag, buildPageHeader, THEME_SCRIPT, CATEGORY_DISPLAY, ALPINE_SCRIPT, labelChip, refArg, NO_REPO_WARNING, buildReviewLedger, repoShortName } from "./layout.js";
import type { Theme } from "./layout.js";
import { getMergeBlockReason, isItemPrioritized, isItemSkipped, type PR, type Issue, type QueueItem, type ReviewLedgerEntry } from "../github.js";
import { repoUrl } from "./repo.js";
import { QUEUE_SCRIPT } from "../resources/queue.generated.js";
import { LABELS, issueUrl, prUrl, shortIssueRef, type IssueRef } from "../config.js";
import { planPreviewBlock, type PlanPreview } from "./issue.js";

export interface PRRowStatus {
  checkStatus: "passing" | "failing" | "pending" | "none";
  checksPassed: number;
  checksTotal: number;
  mergeableState: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewStatus?: "clean" | "issues" | "escalated" | "none";
  reviewIssueCount?: number;
  infraPaths?: string[];
  tofuPlan?: { add: number; change: number; replace: number; destroy: number };
  reviewLedger?: ReviewLedgerEntry[];
}
export interface AllPRRow { repo: string; pr: PR; status?: PRRowStatus }
/** `plan` is the issue's latest plan, set for native issues only. */
export interface AllIssueRow { repo: string; issue: Issue; plan?: PlanPreview }

function buildCategoryBadge(qi: QueueItem | undefined): string {
  if (!qi) return "";
  const display = CATEGORY_DISPLAY[qi.category] ?? { label: qi.category, color: "30363d" };
  return ` ${labelChip(display.label, display.color, "pipeline-badge")}`;
}

/**
 * Status for a PR row comes from the bulk fetch when available, and otherwise
 * falls back to whatever the in-memory queue cache knows — so the page degrades
 * gracefully rather than blanking out if the bulk fetch failed.
 */
function resolveStatus(row: AllPRRow, qi: QueueItem | undefined): PRRowStatus | undefined {
  if (row.status) {
    if (row.status.reviewStatus === undefined && qi) {
      return { ...row.status, reviewStatus: qi.reviewStatus, reviewIssueCount: qi.reviewIssueCount };
    }
    return row.status;
  }
  if (qi && qi.checkStatus) {
    return {
      checkStatus: qi.checkStatus,
      checksPassed: qi.checksPassed ?? 0,
      checksTotal: qi.checksTotal ?? 0,
      mergeableState: qi.mergeableState ?? "UNKNOWN",
      reviewStatus: qi.reviewStatus,
      reviewIssueCount: qi.reviewIssueCount,
      infraPaths: qi.infraPaths,
      tofuPlan: qi.tofuPlan,
      reviewLedger: qi.reviewLedger,
    };
  }
  return undefined;
}

function buildChecksCell(st: PRRowStatus | undefined): string {
  if (!st) return `<span class="check-badge" style="color:var(--text-subtle)">unknown</span>`;
  if (st.checkStatus === "none") return `<span class="check-badge" style="color:var(--text-subtle)">no checks</span>`;
  const color = st.checkStatus === "passing" ? "var(--success)" : st.checkStatus === "failing" ? "var(--danger)" : "var(--warning)";
  const icon = st.checkStatus === "passing" ? "&#x2714;" : st.checkStatus === "failing" ? "&#x2718;" : "&#x25CB;";
  const counts = st.checksTotal > 0 ? ` ${st.checksPassed}/${st.checksTotal}` : "";
  return `<span class="check-badge" style="color:${color}">${icon}${escapeHtml(counts)}</span>`;
}

function buildReviewCell(st: PRRowStatus | undefined): string {
  return buildReviewStatusBadge(st) + buildReviewLedger(st?.reviewLedger);
}

function buildReviewStatusBadge(st: PRRowStatus | undefined): string {
  if (!st || !st.reviewStatus || st.reviewStatus === "none") return "—";
  if (st.reviewStatus === "clean") return `<span class="check-badge" style="color:var(--success)">Reviewed — clean</span>`;
  if (st.reviewStatus === "escalated") return `<span class="check-badge" style="color:var(--danger)">Escalated — needs human</span>`;
  const n = st.reviewIssueCount ?? 0;
  return `<span class="check-badge" style="color:var(--danger)">${escapeHtml(`${n} issue${n === 1 ? "" : "s"} found`)}</span>`;
}

/** Plain-ASCII, quote-free summary — safe to inline in an Alpine @click string. */
function infraNote(st: PRRowStatus | undefined): string {
  if (!st?.infraPaths?.length) return "";
  const p = st.tofuPlan;
  return p ? `${p.add} to add, ${p.change} to change, ${p.replace} to replace, ${p.destroy} to destroy`
           : "tofu/terraform files changed";
}

function buildInfraBadge(st: PRRowStatus | undefined): string {
  if (!st?.infraPaths?.length) return "";
  const p = st.tofuPlan;
  const destructive = p ? p.replace + p.destroy > 0 : false;
  const label = p ? `Infra &middot; ${p.add}+ ${p.change}~ ${p.replace}↻ ${p.destroy}-` : "Infra (tofu)";
  const tip = escapeHtml(st.infraPaths.slice(0, 5).join(", "));
  return ` <span class="infra-badge${destructive ? " infra-destructive" : ""}" title="${tip}">&#x26A0; ${label}</span>`;
}

/** Why the auto-merger last declined this approved PR, if it has (#2971). */
function buildMergeBlockBadge(repo: string, prNumber: number): string {
  const reason = getMergeBlockReason(repo, prNumber);
  if (!reason) return "";
  return ` <span class="merge-conflict" title="${escapeHtml(reason)}">&#x26A0; Merge blocked</span>`;
}

function buildMergeAction(st: PRRowStatus | undefined, escapedRepo: string, prNumber: number): string {
  if (!st) return `<span class="merge-blocked">status unknown</span>`;
  if (st.mergeableState === "CONFLICTING") return `<span class="merge-blocked">Conflicts</span>`;
  if (st.checkStatus === "failing") return `<span class="merge-blocked">CI failing</span>`;
  if (st.checkStatus === "pending") return `<span class="merge-blocked">CI pending</span>`;
  if (st.reviewStatus === "issues") return `<span class="merge-blocked">${escapeHtml(`Review: ${st.reviewIssueCount ?? 0} issues`)}</span>`;
  if (st.reviewStatus === "escalated") return `<span class="merge-blocked">Review escalated</span>`;
  const note = infraNote(st);
  if (note) return `<button class="merge-btn merge-infra" @click="mergePR('${escapedRepo}',${prNumber}, $event, '${escapeHtml(note)}')">&#x26A0; Merge infra</button>`;
  return `<button class="merge-btn" @click="mergePR('${escapedRepo}',${prNumber}, $event)">Squash &amp; Merge</button>`;
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

function pageShell(title: string, headerTitle: string, theme: Theme, body: string): string {
  return `<!DOCTYPE html>
${htmlOpenTag(theme, "wide")}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HEAD_META}
  <meta http-equiv="refresh" content="60">
  <title>claws — ${escapeHtml(title)}</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
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
  .list-plan { font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.3rem; }
  .list-plan > summary { cursor: pointer; font-family: var(--font-display); }
  .list-plan[open] > .markdown { color: var(--text); overflow-wrap: anywhere; }
  .merge-error { font-size: 0.8em; color: var(--danger, #d73a49); margin-left: 8px; word-break: break-word; }
  .merge-blocked { font-size: 0.85em; color: var(--text-subtle); }
  .list-refresh-note { font-size: 0.85em; color: var(--text-subtle); }
  .skip-btn:hover:not(:disabled) { background: var(--danger); color: #fff; }
  .skip-btn.unskip:hover:not(:disabled) { background: var(--success); color: #fff; }
  .infra-badge { display:inline-block; font-size:0.75rem; font-weight:600; color:var(--warning); border:1px solid var(--warning); border-radius:12px; padding:0.1rem 0.5rem; margin-left:0.3rem; white-space:nowrap; vertical-align:middle; }
  .infra-badge.infra-destructive { color:var(--danger); border-color:var(--danger); }
  .merge-btn.merge-infra { border-color:var(--danger); color:var(--danger); }
  .skip-badge { display:inline-block; font-size:0.75rem; font-weight:600; color:var(--warning); border:1px solid var(--warning); border-radius:12px; padding:0.1rem 0.5rem; margin-left:0.3rem; white-space:nowrap; vertical-align:middle; }
  .action-secondary { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; margin-top: 4px; }
  .action-secondary > .refined-btn { margin-left: 0; }
  @media (max-width: 767px) {
    .pipeline-badge { margin-left: 0; margin-top: 0.25rem; }
    .check-badge { margin-left: 0; }
    .merge-btn, .refined-btn { width: 100%; min-height: 38px; }
    .cell-actions .action-stack { align-items: stretch; flex: 1 1 auto; min-width: 0; }
    .infra-badge { margin-left: 0; margin-top: 0.25rem; }
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
  ${buildPageHeader(headerTitle, theme)}
  ${THEME_SCRIPT}
  <p class="list-actions"><button class="trigger-btn" @click="refreshQueue($event)" title="Trigger issue-dispatcher and pr-dispatcher to rescan the forges">Refresh from GitHub</button> <span class="list-refresh-note" x-text="refreshStatus"></span></p>
  ${body}
  ${QUEUE_SCRIPT}
</body>
</html>`;
}

export function buildAllPRsPage(rows: AllPRRow[], queueItems: QueueItem[], theme: Theme): string {
  const queueByKey = new Map<string, QueueItem>();
  for (const qi of queueItems) {
    queueByKey.set(`${qi.repo}#${qi.number}`, qi);
  }

  const sorted = [...rows].sort((a, b) => (b.pr.updatedAt || "").localeCompare(a.pr.updatedAt || ""));

  const prRows = sorted.map((row) => {
    const { repo, pr } = row;
    const qi = queueByKey.get(`${repo}#${pr.number}`);
    const st = resolveStatus(row, qi);
    const badges = buildCategoryBadge(qi);
    const updatedStr = pr.updatedAt ? formatRelativeTime(pr.updatedAt) : "";
    const [owner, name] = repo.split("/");
    const escapedRepo = escapeHtml(repo);
    const mergeBtn = buildMergeAction(st, escapedRepo, pr.number);
    const alreadyAutomerge = pr.labels.some((l) => l.name === LABELS.automerge);
    // Unmark also resets the CI-fixer breaker; removing the label on the forge
    // alone lets the old attempts re-trip it on the next sweep.
    const unmarkBtn = pr.labels.some((l) => l.name === LABELS.problematic)
      ? `<button class="refined-btn" @click="unmarkProblematic('${escapedRepo}',${pr.number}, $event)">Unmark problematic</button>`
      : "";
    const automergeBtn = alreadyAutomerge
      ? `<span class="refined-btn refined-done">Automerge</span>`
      : `<button class="refined-btn" @click="markAutomerge('${escapedRepo}',${pr.number}, $event, false)">Automerge</button>`;
    return `<tr>
      <td data-label="Repo"><a href="${repoUrl(owner, name)}" title="${escapeHtml(repo)}">${escapeHtml(repoShortName(repo))}</a></td>
      <td data-label="PR"><a href="${encodeURI(prUrl(repo, pr.number))}">#${pr.number}</a></td>
      <td class="cell-title" data-label="Title">${escapeHtml(pr.title)}${badges}${buildSkipBadge(repo, pr.number)}${buildInfraBadge(st)}${buildMergeBlockBadge(repo, pr.number)}</td>
      <td class="hide-sm" data-label="Author">${escapeHtml(pr.author?.login ?? "")}</td>
      <td data-label="Updated">${escapeHtml(updatedStr)}</td>
      <td class="hide-sm" data-label="Branch">${escapeHtml(pr.headRefName)}</td>
      <td data-label="Checks">${buildChecksCell(st)}</td>
      <td data-label="Review">${buildReviewCell(st)}</td>
      <td class="cell-actions" data-label=""><div class="action-stack">${mergeBtn}${automergeBtn}</div><div class="action-secondary">${unmarkBtn}${buildQueueControls(repo, escapedRepo, pr.number)}</div></td>
    </tr>`;
  }).join("\n");

  const body = `
  <div class="section">
    <h2>Open PRs <span>${sorted.length}</span></h2>
    ${sorted.length > 0 ? `
    <div class="table-scroll"><table class="data-cards data-cards-wide">
      <thead><tr><th>Repo</th><th>PR</th><th>Title</th><th>Author</th><th>Updated</th><th>Branch</th><th>Checks</th><th>Review</th><th>Actions</th></tr></thead>
      <tbody>${prRows}</tbody>
    </table></div>` : `<p class="queue-empty">No open PRs</p>`}
  </div>`;

  return pageShell("All PRs", "All PRs", theme, body);
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
      <td data-label="Repo"><a href="${repoUrl(owner, name)}" title="${escapedRepo}">${escapeHtml(repoShortName(repo))}</a></td>
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

  return pageShell("All Issues", "All Issues", theme, body);
}
