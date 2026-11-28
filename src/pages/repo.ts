import { hasItemRef, shortIssueRef, type IssueRef } from "../issue-id.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, itemLogsUrl, formatRelativeTime, htmlOpenTag, buildPageHeader, THEME_SCRIPT, CATEGORY_DISPLAY, formatDuration, labelChip, refTitleAttr, repoAvatar, repoShortName } from "./layout.js";
import type { NavCounts, Theme } from "./layout.js";
import type { ClawsPrRecord, DisabledWorkflow, Task } from "../db.js";
import { type QueueItem, type PR, type Issue, type ActionRunSummary } from "../github.js";
import { ACTIONS_CONTROL_SCRIPT } from "../resources/actions-control.generated.js";
import { LABELS, issueUrl, prUrl, webUrlForRepo } from "../config.js";
import { atLeast } from "../issue-approval.js";
import { parseOutcome } from "./logs.js";
import { PR_STATUS_CSS, resolvePRStatus, buildChecksCell, buildReviewStatusBadge, buildInfraBadge, buildInfraHoldNote, infraRowWait, buildConflictBadge, buildMergeBlockBadge, buildDispatchNote, type PRRowStatus } from "./pr-status.js";
import { isProblematic, persistedInfraHoldItems } from "../pr-state.js";

function formatOutcomeSummary(task: Task): string {
  const outcome = parseOutcome(task);
  if (!outcome) return "";
  if (outcome.failureCategory) return escapeHtml(outcome.failureCategory);
  const parts: string[] = [];
  if (outcome.prNumber !== undefined) {
    const action = outcome.prAction ?? "updated";
    parts.push(`PR #${outcome.prNumber} ${action}`);
  }
  if (outcome.commits !== undefined && outcome.commits > 0) {
    parts.push(`${outcome.commits} commit${outcome.commits !== 1 ? "s" : ""}`);
  }
  if ((outcome.insertions ?? 0) > 0 || (outcome.deletions ?? 0) > 0) {
    parts.push(`+${outcome.insertions ?? 0}/\u2212${outcome.deletions ?? 0}`);
  }
  return escapeHtml(parts.join(", "));
}

export function repoUrl(owner: string, name: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

// ── Bar chart ──

export function buildBarChart(dailyStats: Array<{ date: string; completed: number; failed: number }>): string {
  if (dailyStats.length === 0) {
    return `<p class="queue-empty">No task data for the last 30 days</p>`;
  }

  const w = 600;
  const h = 120;
  const pad = { top: 10, right: 10, bottom: 20, left: 10 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;

  const maxTotal = dailyStats.reduce((max, d) => Math.max(max, d.completed + d.failed), 0);
  if (maxTotal === 0) {
    return `<p class="queue-empty">No task data for the last 30 days</p>`;
  }

  const barWidth = Math.max(4, Math.floor(chartW / dailyStats.length) - 2);
  const gap = Math.max(1, Math.floor((chartW - barWidth * dailyStats.length) / Math.max(1, dailyStats.length - 1)));

  let bars = "";
  for (let i = 0; i < dailyStats.length; i++) {
    const d = dailyStats[i];
    const total = d.completed + d.failed;
    const x = pad.left + i * (barWidth + gap);
    const totalH = (total / maxTotal) * chartH;
    const completedH = (d.completed / maxTotal) * chartH;
    const failedH = (d.failed / maxTotal) * chartH;

    // Completed (green) on bottom
    if (d.completed > 0) {
      bars += `<rect x="${x}" y="${pad.top + chartH - completedH}" width="${barWidth}" height="${completedH}" fill="var(--success)" rx="1">
        <title>${escapeHtml(d.date)}: ${d.completed} completed, ${d.failed} failed</title></rect>`;
    }
    // Failed (red) on top
    if (d.failed > 0) {
      bars += `<rect x="${x}" y="${pad.top + chartH - totalH}" width="${barWidth}" height="${failedH}" fill="var(--danger)" rx="1">
        <title>${escapeHtml(d.date)}: ${d.completed} completed, ${d.failed} failed</title></rect>`;
    }

    // X-axis label every 7 days or first/last
    const day = parseInt(d.date.split("-")[2], 10);
    if (i === 0 || i === dailyStats.length - 1 || day % 7 === 1) {
      bars += `<text x="${x + barWidth / 2}" y="${h - 2}" text-anchor="middle" fill="var(--text-secondary)" font-size="9">${day}</text>`;
    }
  }

  return `<svg width="100%" viewBox="0 0 ${w} ${h}" style="max-width:${w}px" class="repo-chart">${bars}</svg>`;
}

// ── Needs-your-input panel ──

export interface AttentionItem {
  kind: "issue" | "pr";
  number: IssueRef;
  title: string;
  reason: string;
}

/**
 * #2356: the items on this repo that are waiting on the user, in the order a human
 * should look at them — PRs Claws has given up on first, then finished work
 * awaiting review. PR state comes from `prRows` (the
 * `claws_prs` rows by PR number), never PR labels. Pure so it is trivially testable.
 */
export function computeAttentionItems(openIssues: Issue[], openPRs: PR[], prRows: ReadonlyMap<number, ClawsPrRecord>): AttentionItem[] {
  const has = (item: { labels: { name: string }[] }, label: string) => item.labels.some((l) => l.name === label);
  const items: AttentionItem[] = [];
  for (const pr of openPRs) {
    if (isProblematic(prRows.get(pr.number))) {
      items.push({ kind: "pr", number: pr.number, title: pr.title, reason: "CI fixes exhausted — needs manual intervention" });
    }
  }
  for (const issue of openIssues) {
    if (has(issue, LABELS.blocked)) continue;
    // A posted plan waiting on a human: the plan-review lifecycle, not yet
    // approved through Plan (`columnFor`'s Awaiting plan review).
    if (issue.lifecycle === "awaiting-plan-review" && !atLeast(issue.approvedThrough, "plan")) {
      items.push({ kind: "issue", number: issue.number, title: issue.title, reason: "Claws finished — needs your review" });
    }
  }
  return items;
}

// ── Forgejo Actions controls (#clw_01M7X2XQESHRXWHA4Z59EXWT7Y) ──

/**
 * Styles for the CI queue section, its Workflows list and the
 * disabled-workflow banner. Phone (under 768px): full-width 40px buttons and
 * stacked workflow rows; tablet and desktop: inline 30px buttons.
 */
export const ACTIONS_CONTROL_CSS = `
  .ci-btn { min-height: 30px; padding: 0 0.7rem; background: none; border-radius: 4px; font-family: inherit; font-size: 0.8rem; cursor: pointer; white-space: nowrap; transition: background 0.15s, color 0.15s; }
  .ci-btn-danger { color: var(--danger); border: 1px solid var(--danger); }
  .ci-btn-danger:hover:not(:disabled) { background: var(--danger); color: #fff; }
  .ci-btn-neutral { color: var(--accent); border: 1px solid var(--border-hover); }
  .ci-btn-neutral:hover:not(:disabled) { background: var(--btn-hover); }
  .ci-btn:disabled { cursor: default; opacity: 0.7; }
  .ci-disabled-pill { display: inline-block; font-size: 0.75rem; font-weight: 600; color: var(--warning); border: 1px solid var(--warning); border-radius: 12px; padding: 0.1rem 0.5rem; white-space: nowrap; }
  .ci-workflows { list-style: none; margin: 0.5rem 0 0; padding: 0; }
  .ci-workflow-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; padding: 0.35rem 0; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
  .ci-workflow-row .ci-btn { margin-left: auto; }
  .ci-workflow-meta { color: var(--text-secondary); font-size: 0.85em; }
  .ci-queue-subhead { font-size: 1rem; margin-top: 1rem; }
  .actions-control-status { color: var(--danger); font-size: 0.85rem; overflow-wrap: anywhere; margin: 0.4rem 0 0; }
  .disabled-workflows-banner { overflow-wrap: anywhere; }
  .disabled-workflows-banner ul { list-style: none; margin: 0.4rem 0 0; padding: 0; }
  .disabled-workflows-banner li { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; padding: 0.2rem 0; }
  @media (max-width: 767px) {
    .ci-btn { width: 100%; min-height: 40px; }
    .ci-workflow-row, .disabled-workflows-banner li { flex-direction: column; align-items: stretch; }
    .ci-workflow-row .ci-btn { margin-left: 0; }
  }
`;

/** Who disabled a workflow, for the banner and the Workflows list. */
function disabledByText(row: DisabledWorkflow): string {
  if (row.disabledBy === null) return "seen disabled on Forgejo";
  if (row.disabledBy === "dashboard") return "disabled from the dashboard";
  if (row.disabledBy.startsWith("session:")) return `disabled by session ${row.disabledBy.slice("session:".length)}`;
  return `disabled by ${row.disabledBy}`;
}

function workflowToggleButton(repo: string, workflow: string, enabled: boolean): string {
  return `<button type="button" class="ci-btn ${enabled ? "ci-btn-neutral" : "ci-btn-danger"}" data-actions-control="workflow" data-repo="${escapeHtml(repo)}" data-workflow="${escapeHtml(workflow)}" data-enabled="${enabled}">${enabled ? "Enable" : "Disable"}</button>`;
}

/**
 * The warning banner listing each disabled workflow (repo short name, file,
 * who, age) with an Enable button; empty when none is disabled. A workflow
 * whose file was since deleted still lists, so it can be cleared.
 */
export function buildDisabledWorkflowsBanner(rows: readonly DisabledWorkflow[]): string {
  if (rows.length === 0) return "";
  const items = rows.map((row) => `<li><span><strong>${escapeHtml(repoShortName(row.repo))}</strong> <code>${escapeHtml(row.workflow)}</code> <span class="ci-workflow-meta">${escapeHtml(disabledByText(row))} ${escapeHtml(formatRelativeTime(row.firstSeenAt))}</span></span>${workflowToggleButton(row.repo, row.workflow, true)}</li>`).join("");
  return `<div class="warning-banner disabled-workflows-banner" id="disabled-workflows-banner" role="status" data-actions-control-scope>
    ${rows.length === 1 ? "A Forgejo Actions workflow is disabled" : `${rows.length} Forgejo Actions workflows are disabled`}: its runs will not start until it is enabled again.
    <ul>${items}</ul>
    <p class="actions-control-status" role="alert" hidden></p>
  </div>`;
}

/** The CI queue the repo page shows: unfinished runs and the workflow files. */
export interface CiQueueData {
  /** Waiting, blocked and running runs, newest first. */
  runs: ActionRunSummary[];
  /** Workflow files under `.forgejo/workflows` on the default branch. */
  workflows: string[];
}

/**
 * The repo page's CI queue section: a run table with a Cancel button per row
 * and the Workflows list with Disable / Enable. `queue` null means a Forgejo
 * read failed: the section says so instead of failing the page.
 */
export function buildCiQueueSection(fullName: string, queue: CiQueueData | null, disabled: readonly DisabledWorkflow[]): string {
  if (queue === null) {
    return `<div class="section" id="ci-queue">
    <h2>CI queue</h2>
    <p class="queue-empty">CI queue unavailable: Forgejo did not answer.</p>
  </div>`;
  }
  const runsBase = `${webUrlForRepo(fullName)}/actions/runs`;
  const rows = queue.runs.map((r) => {
    const prMatch = r.ref?.match(/^#(\d+)$/);
    const ref = r.ref === null ? "—"
      : prMatch ? `<a href="${encodeURI(prUrl(fullName, Number(prMatch[1])))}">${escapeHtml(r.ref)}</a>`
      : escapeHtml(r.ref);
    return `<tr>
      <td data-label="Run"><a href="${escapeHtml(r.htmlUrl ?? `${runsBase}/${r.run}`)}">${r.run}</a></td>
      <td data-label="Workflow"><code>${escapeHtml(r.workflow)}</code></td>
      <td data-label="Trigger">${escapeHtml(r.event)}</td>
      <td data-label="Ref">${ref}</td>
      <td data-label="Status">${escapeHtml(r.status)}</td>
      <td data-label="Age">${r.created ? escapeHtml(formatRelativeTime(r.created)) : "—"}</td>
      <td class="cell-actions" data-label=""><button type="button" class="ci-btn ci-btn-danger" data-actions-control="cancel-run" data-repo="${escapeHtml(fullName)}" data-run="${r.run}" aria-label="Cancel run ${r.run}">Cancel</button></td>
    </tr>`;
  }).join("\n");
  const disabledByFile = new Map(disabled.map((d) => [d.workflow, d]));
  const files = [...new Set([...queue.workflows, ...disabled.map((d) => d.workflow)])].sort();
  const workflowRows = files.map((file) => {
    const row = disabledByFile.get(file);
    const missing = !queue.workflows.includes(file) ? ` <span class="ci-workflow-meta">(file no longer on the default branch)</span>` : "";
    return row
      ? `<li class="ci-workflow-row"><code>${escapeHtml(file)}</code><span class="ci-disabled-pill">Disabled</span><span class="ci-workflow-meta">${escapeHtml(disabledByText(row))} ${escapeHtml(formatRelativeTime(row.firstSeenAt))}</span>${missing}${workflowToggleButton(fullName, file, true)}</li>`
      : `<li class="ci-workflow-row"><code>${escapeHtml(file)}</code>${workflowToggleButton(fullName, file, false)}</li>`;
  }).join("");
  return `<div class="section" id="ci-queue" data-actions-control-scope>
    <h2>CI queue</h2>
    ${queue.runs.length > 0 ? `
    <div class="table-scroll"><table class="data-cards">
      <thead><tr><th>Run</th><th>Workflow</th><th>Trigger</th><th>Ref</th><th>Status</th><th>Age</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>` : `<p class="queue-empty">No waiting or running CI runs</p>`}
    <h3 class="ci-queue-subhead">Workflows</h3>
    ${files.length > 0 ? `<ul class="ci-workflows">${workflowRows}</ul>` : `<p class="queue-empty">No workflows under .forgejo/workflows</p>`}
    <p class="actions-control-status" role="alert" hidden></p>
  </div>`;
}

// ── Main page ──

export interface RepoPageData {
  owner: string;
  name: string;
  queueItems: QueueItem[];
  recentTasks: Task[];
  dailyStats: Array<{ date: string; completed: number; failed: number }>;
  worktrees: string[];
  openPRs: PR[];
  /** The repo's `claws_prs` rows — the PR state the attention panel reads. */
  clawsPrs: ClawsPrRecord[];
  alertIssues: Issue[];
  openIssues: Issue[];
  /**
   * Live status per open PR number from the same bulk fetch the All PRs page
   * uses; a PR missing here falls back to its queue item.
   */
  prStatuses: Map<number, PRRowStatus>;
  /**
   * The merge-blocking job kind queued or running per PR (`listActivePrWork`),
   * keyed `repo#number`; the infra hold note then reads in progress.
   */
  activeWork?: ReadonlyMap<string, string>;
  /**
   * The CI queue section's runs and workflow files; null when a Forgejo read
   * failed (the section says "CI queue unavailable"), omitted to hide it.
   */
  ciQueue?: CiQueueData | null;
  /** The repo's `disabled_workflows` rows, for the banner and the Workflows list. */
  disabledWorkflows?: DisabledWorkflow[];
}

export function buildRepoPage(data: RepoPageData, theme: Theme, navCounts?: NavCounts): string {
  const { owner, name, queueItems, recentTasks, dailyStats, worktrees, openPRs, clawsPrs, alertIssues, openIssues, prStatuses, activeWork, ciQueue, disabledWorkflows = [] } = data;
  const fullName = `${owner}/${name}`;

  // Build a lookup map: issue/pr number → queue item
  // Also index by prNumber so PR check-status badges show for issue-stage items with an associated PR.
  const queueByNumber = new Map<IssueRef, QueueItem>();
  for (const qi of queueItems) {
    queueByNumber.set(qi.number, qi);
    if (qi.prNumber !== undefined && !queueByNumber.has(qi.prNumber)) queueByNumber.set(qi.prNumber, qi);
  }

  const alertIssueNumbers = new Set(alertIssues.map(i => i.number));

  const taskRows = recentTasks.map((t) => {
    const displayNumber = hasItemRef(t.item_number) ? `<a href="${itemLogsUrl(t.repo, t.item_number)}"${refTitleAttr(t.item_number)}>#${escapeHtml(shortIssueRef(t.item_number))}</a>` : "\u2014";
    return `<tr>
      <td data-label="Job">${escapeHtml(t.job_name)}</td>
      <td class="cell-title" data-label="Item">${displayNumber}</td>
      <td class="status-${t.status}" data-label="Status">${escapeHtml(t.status)}</td>
      <td class="hide-sm" data-label="Started">${escapeHtml(t.started_at)}</td>
      <td class="hide-sm" data-label="Duration">${formatDuration(t.started_at, t.completed_at)}</td>
      <td data-label="Outcome">${formatOutcomeSummary(t)}</td>
    </tr>`;
  }).join("\n");

  const clawsPrByNumber = new Map(clawsPrs.map((r) => [r.prNumber, r]));
  const prRows = openPRs.map((pr) => {
    const qi = queueByNumber.get(pr.number);
    // Same precedence as All PRs: the live bulk status first, then the queue
    // cache, so the two pages never disagree about the same PR.
    const st = resolvePRStatus({ repo: fullName, pr, status: prStatuses.get(pr.number) }, qi);
    let badges = "";
    if (qi) {
      const display = CATEGORY_DISPLAY[qi.category] ?? { label: qi.category, color: "30363d" };
      badges += ` ${labelChip(display.label, display.color, "pipeline-badge")}`;
    }
    if (st) {
      badges += ` ${buildChecksCell(st)}`;
      const review = buildReviewStatusBadge(st);
      if (review !== "—") badges += ` ${review}`;
    }
    // No approval-exemption verdict here: an eligible bump reads as an
    // unqualified no-op.
    badges += buildInfraBadge(st) + buildInfraHoldNote(st, persistedInfraHoldItems(clawsPrByNumber.get(pr.number), pr.headRefOid), infraRowWait(clawsPrByNumber.get(pr.number), pr.headRefOid, st, activeWork?.get(`${fullName}#${pr.number}`))) + buildConflictBadge(st) + buildMergeBlockBadge(fullName, pr.number) + buildDispatchNote(qi);
    const updatedStr = pr.updatedAt ? formatRelativeTime(pr.updatedAt) : "";
    return `<tr>
      <td data-label="PR"><a href="${encodeURI(prUrl(fullName, pr.number))}">#${pr.number}</a></td>
      <td class="cell-title" data-label="Title">${escapeHtml(pr.title)}${badges}</td>
      <td class="hide-sm" data-label="Author">${escapeHtml(pr.author?.login ?? "")}</td>
      <td data-label="Updated">${escapeHtml(updatedStr)}</td>
      <td class="hide-sm" data-label="Branch">${escapeHtml(pr.headRefName)}</td>
    </tr>`;
  }).join("\n");

  const alertRows = alertIssues.map((issue) => {
    const updatedStr = issue.updatedAt ? formatRelativeTime(issue.updatedAt) : "";
    return `<tr>
      <td data-label="Issue"><a href="${encodeURI(issueUrl(fullName, issue.number))}"${refTitleAttr(issue.number)}>#${escapeHtml(shortIssueRef(issue.number))}</a></td>
      <td class="cell-title" data-label="Title">${escapeHtml(issue.title)}</td>
      <td class="hide-sm" data-label="Author">${escapeHtml(issue.author?.login ?? "")}</td>
      <td data-label="Updated">${escapeHtml(updatedStr)}</td>
    </tr>`;
  }).join("\n");

  const issueRows = openIssues.map((issue) => {
    const qi = queueByNumber.get(issue.number);
    let badges = "";
    if (qi) {
      const display = CATEGORY_DISPLAY[qi.category] ?? { label: qi.category, color: "30363d" };
      badges += ` ${labelChip(display.label, display.color, "pipeline-badge")}`;
    }
    if (alertIssueNumbers.has(issue.number)) {
      badges += ` <span class="alert-badge">\u26a0 scanner alert</span>`;
    }
    // A native issue listed here as a non-primary: say which repo owns it.
    const primary = issue.repos?.[0];
    if (primary && primary !== fullName) {
      badges += ` <span style="color: var(--text-secondary); font-size: 0.8em;" title="Primary repository: owns planning and labels (${escapeHtml(primary)})">primary: ${repoAvatar(primary)}${escapeHtml(repoShortName(primary))}</span>`;
    }
    const updatedStr = issue.updatedAt ? formatRelativeTime(issue.updatedAt) : "";
    return `<tr>
      <td data-label="Issue"><a href="${encodeURI(issueUrl(fullName, issue.number))}"${refTitleAttr(issue.number)}>#${escapeHtml(shortIssueRef(issue.number))}</a></td>
      <td class="cell-title" data-label="Title">${escapeHtml(issue.title)}${badges}</td>
      <td class="hide-sm" data-label="Author">${escapeHtml(issue.author?.login ?? "")}</td>
      <td data-label="Updated">${escapeHtml(updatedStr)}</td>
    </tr>`;
  }).join("\n");

  const attentionItems = computeAttentionItems(openIssues, openPRs, clawsPrByNumber);
  const attentionHtml = attentionItems.length === 0 ? "" : `
  <div class="section attention-panel">
    <h2>Needs your input <span>${attentionItems.length}</span></h2>
    <ul>${attentionItems.map((item) => `<li><a href="${encodeURI(item.kind === "pr" && typeof item.number === "number" ? prUrl(fullName, item.number) : issueUrl(fullName, item.number))}"${refTitleAttr(item.number)}>#${escapeHtml(shortIssueRef(item.number))}</a> ${escapeHtml(item.title)} — <span class="attention-reason">${escapeHtml(item.reason)}</span></li>`).join("")}</ul>
  </div>`;

  const worktreeHtml = worktrees.length > 0
    ? `<ul>${worktrees.map(w => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`
    : `<p class="queue-empty">No active worktrees</p>`;

  return `<!DOCTYPE html>
${htmlOpenTag(theme, "wide")}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HEAD_META}
  <meta http-equiv="refresh" content="60">
  <title>claws \u2014 ${escapeHtml(repoShortName(fullName))}</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${PR_STATUS_CSS}
  .alert-badge {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--warning);
    vertical-align: middle;
    margin-left: 0.3rem;
  }
  .repo-chart { display: block; margin: 0.5rem 0; }
  .section { margin-bottom: 2rem; }
  .attention-panel { border-left: 3px solid var(--warning); padding-left: 0.9rem; }
  .attention-panel h2 span { color: var(--warning); }
  .attention-reason { color: var(--text-secondary); font-size: 0.85em; }
  ${ACTIONS_CONTROL_CSS}
  </style>
</head>
<body>
  ${buildPageHeader(null, theme, { navCounts })}
  ${THEME_SCRIPT}
  <h2>${repoAvatar(fullName)}<a href="${encodeURI(webUrlForRepo(fullName))}" title="${escapeHtml(fullName)}">${escapeHtml(repoShortName(fullName))}</a></h2>
  <p><a href="/jobs">Job Toggles</a></p>
  ${buildDisabledWorkflowsBanner(disabledWorkflows)}
${attentionHtml}

  <div class="section">
    <h2>Open PRs</h2>
    ${openPRs.length > 0 ? `
    <div class="table-scroll"><table class="data-cards">
      <thead><tr><th>PR</th><th>Title</th><th>Author</th><th>Updated</th><th>Branch</th></tr></thead>
      <tbody>${prRows}</tbody>
    </table></div>` : `<p class="queue-empty">No open PRs</p>`}
  </div>

  ${ciQueue === undefined ? "" : buildCiQueueSection(fullName, ciQueue, disabledWorkflows)}

  <div class="section">
    <h2>Scanner Findings</h2>
    ${alertIssues.length > 0 ? `
    <div class="table-scroll"><table class="data-cards">
      <thead><tr><th>Issue</th><th>Title</th><th>Author</th><th>Updated</th></tr></thead>
      <tbody>${alertRows}</tbody>
    </table></div>` : `<p class="queue-empty">No scanner alerts</p>`}
  </div>

  <div class="section">
    <h2>Open Issues</h2>
    ${openIssues.length > 0 ? `
    <div class="table-scroll"><table class="data-cards">
      <thead><tr><th>Issue</th><th>Title</th><th>Author</th><th>Updated</th></tr></thead>
      <tbody>${issueRows}</tbody>
    </table></div>` : `<p class="queue-empty">No open issues</p>`}
  </div>

  <div class="section">
    <h2>Recent Claws Runs</h2>
    ${recentTasks.length > 0 ? `
    <div class="table-scroll"><table class="data-cards">
      <thead><tr><th>Job</th><th>Item</th><th>Status</th><th>Started</th><th>Duration</th><th>Outcome</th></tr></thead>
      <tbody>${taskRows}</tbody>
    </table></div>` : `<p class="queue-empty">No tasks recorded</p>`}
  </div>

  <div class="section">
    <h2>Task Success Rate (30 days)</h2>
    ${buildBarChart(dailyStats)}
  </div>

  <div class="section">
    <h2>Active Worktrees</h2>
    ${worktreeHtml}
  </div>
  ${ACTIONS_CONTROL_SCRIPT}
</body>
</html>`;
}
