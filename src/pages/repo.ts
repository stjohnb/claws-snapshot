import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, itemLogsUrl, formatRelativeTime, htmlOpenTag, buildPageHeader, THEME_SCRIPT, CATEGORY_DISPLAY, formatDuration } from "./layout.js";
import type { Theme } from "./layout.js";
import type { Task } from "../db.js";
import type { QueueItem, PR, Issue } from "../github.js";
import { LABELS } from "../config.js";
import { parseOutcome } from "./logs.js";

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
  number: number;
  title: string;
  reason: string;
}

/**
 * #2356: the items on this repo that are waiting on the user, in the order a human
 * should look at them — Claws-paused issues first, then PRs Claws has given up on,
 * then finished work awaiting review. Pure so it is trivially testable.
 */
export function computeAttentionItems(openIssues: Issue[], openPRs: PR[]): AttentionItem[] {
  const has = (item: { labels: { name: string }[] }, label: string) => item.labels.some((l) => l.name === label);
  const items: AttentionItem[] = [];
  for (const issue of openIssues) {
    if (has(issue, LABELS.manualAction)) {
      items.push({ kind: "issue", number: issue.number, title: issue.title, reason: "Claws paused — needs your decision" });
    }
  }
  for (const pr of openPRs) {
    if (has(pr, LABELS.problematic)) {
      items.push({ kind: "pr", number: pr.number, title: pr.title, reason: "CI fixes exhausted — needs manual intervention" });
    }
  }
  for (const issue of openIssues) {
    if (has(issue, LABELS.ready)) {
      items.push({ kind: "issue", number: issue.number, title: issue.title, reason: "Claws finished — needs your review" });
    }
  }
  return items;
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
  alertIssues: Issue[];
  openIssues: Issue[];
  autoProcessEnabled: boolean;
  saved: boolean;
}

export function buildRepoPage(data: RepoPageData, theme: Theme): string {
  const { owner, name, queueItems, recentTasks, dailyStats, worktrees, openPRs, alertIssues, openIssues, autoProcessEnabled, saved } = data;
  const fullName = `${owner}/${name}`;

  // Build a lookup map: issue/pr number → queue item
  // Also index by prNumber so PR check-status badges show for issue-stage items with an associated PR.
  const queueByNumber = new Map<number, QueueItem>();
  for (const qi of queueItems) {
    queueByNumber.set(qi.number, qi);
    if (qi.prNumber !== undefined && !queueByNumber.has(qi.prNumber)) queueByNumber.set(qi.prNumber, qi);
  }

  const alertIssueNumbers = new Set(alertIssues.map(i => i.number));

  const taskRows = recentTasks.map((t) => {
    const displayNumber = t.item_number > 0 ? `<a href="${itemLogsUrl(t.repo, t.item_number)}">#${t.item_number}</a>` : "\u2014";
    return `<tr>
      <td>${escapeHtml(t.job_name)}</td>
      <td>${displayNumber}</td>
      <td class="status-${t.status}">${escapeHtml(t.status)}</td>
      <td>${escapeHtml(t.started_at)}</td>
      <td>${formatDuration(t.started_at, t.completed_at)}</td>
      <td>${formatOutcomeSummary(t)}</td>
    </tr>`;
  }).join("\n");

  const prRows = openPRs.map((pr) => {
    const qi = queueByNumber.get(pr.number);
    let badges = "";
    if (qi) {
      const display = CATEGORY_DISPLAY[qi.category] ?? { label: qi.category, color: "30363d" };
      const bgColor = `#${display.color}`;
      const textColor = parseInt(display.color, 16) > 0x7fffff ? "#000" : "#fff";
      badges += ` <span class="pipeline-badge" style="background:${bgColor};color:${textColor}">${escapeHtml(display.label)}</span>`;
      if (qi.checkStatus) {
        const csColor = qi.checkStatus === "passing" ? "var(--success)" : qi.checkStatus === "failing" ? "var(--danger)" : "var(--warning)";
        badges += ` <span class="check-badge" style="color:${csColor}">${escapeHtml(qi.checkStatus)}</span>`;
      }
    }
    const updatedStr = pr.updatedAt ? formatRelativeTime(pr.updatedAt) : "";
    return `<tr>
      <td><a href="https://github.com/${encodeURI(fullName)}/pull/${pr.number}">#${pr.number}</a></td>
      <td>${escapeHtml(pr.title)}${badges}</td>
      <td>${escapeHtml(pr.author?.login ?? "")}</td>
      <td>${escapeHtml(updatedStr)}</td>
      <td>${escapeHtml(pr.headRefName)}</td>
    </tr>`;
  }).join("\n");

  const alertRows = alertIssues.map((issue) => {
    const updatedStr = issue.updatedAt ? formatRelativeTime(issue.updatedAt) : "";
    return `<tr>
      <td><a href="https://github.com/${encodeURI(fullName)}/issues/${issue.number}">#${issue.number}</a></td>
      <td>${escapeHtml(issue.title)}</td>
      <td>${escapeHtml(issue.author?.login ?? "")}</td>
      <td>${escapeHtml(updatedStr)}</td>
    </tr>`;
  }).join("\n");

  const issueRows = openIssues.map((issue) => {
    const qi = queueByNumber.get(issue.number);
    let badges = "";
    if (qi) {
      const display = CATEGORY_DISPLAY[qi.category] ?? { label: qi.category, color: "30363d" };
      const bgColor = `#${display.color}`;
      const textColor = parseInt(display.color, 16) > 0x7fffff ? "#000" : "#fff";
      badges += ` <span class="pipeline-badge" style="background:${bgColor};color:${textColor}">${escapeHtml(display.label)}</span>`;
    }
    if (alertIssueNumbers.has(issue.number)) {
      badges += ` <span class="alert-badge">\u26a0 scanner alert</span>`;
    }
    const updatedStr = issue.updatedAt ? formatRelativeTime(issue.updatedAt) : "";
    return `<tr>
      <td><a href="https://github.com/${encodeURI(fullName)}/issues/${issue.number}">#${issue.number}</a></td>
      <td>${escapeHtml(issue.title)}${badges}</td>
      <td>${escapeHtml(issue.author?.login ?? "")}</td>
      <td>${escapeHtml(updatedStr)}</td>
    </tr>`;
  }).join("\n");

  const attentionItems = computeAttentionItems(openIssues, openPRs);
  const attentionHtml = attentionItems.length === 0 ? "" : `
  <div class="section attention-panel">
    <h2>Needs your input <span>${attentionItems.length}</span></h2>
    <ul>${attentionItems.map((item) => `<li><a href="https://github.com/${encodeURI(fullName)}/${item.kind === "pr" ? "pull" : "issues"}/${item.number}">#${item.number}</a> ${escapeHtml(item.title)} — <span class="attention-reason">${escapeHtml(item.reason)}</span></li>`).join("")}</ul>
  </div>`;

  const worktreeHtml = worktrees.length > 0
    ? `<ul>${worktrees.map(w => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`
    : `<p class="queue-empty">No active worktrees</p>`;

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HEAD_META}
  <meta http-equiv="refresh" content="60">
  <title>claws \u2014 ${escapeHtml(fullName)}</title>
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
  .field-note { font-size: 0.75rem; color: var(--text-subtle); }
  </style>
</head>
<body>
  ${buildPageHeader(null, theme)}
  ${THEME_SCRIPT}
  <h2><a href="https://github.com/${encodeURI(fullName)}">${escapeHtml(fullName)}</a></h2>
  <p><a href="/jobs">Job Toggles</a></p>
  ${saved ? '<div class="banner">Auto-process setting saved.</div>' : ""}
  <form method="POST" action="/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/auto-process" class="section">
    <label><input type="checkbox" name="enabled" value="true"${autoProcessEnabled ? " checked" : ""}> Auto-process mode</label>
    <button type="submit" class="save-btn">Save</button>
    <p class="field-note">When on, Claws ranks this repo's whole open backlog, marks duplicates, closes obsolete issues, and drives one non-controversial issue at a time through plan &rarr; PR &rarr; merge. Issues needing your judgement get the <code>Manual Action</code> label and appear under "Needs your input" below.</p>
  </form>
${attentionHtml}

  <div class="section">
    <h2>Open PRs</h2>
    ${openPRs.length > 0 ? `
    <div class="table-scroll"><table>
      <thead><tr><th>PR</th><th>Title</th><th>Author</th><th>Updated</th><th>Branch</th></tr></thead>
      <tbody>${prRows}</tbody>
    </table></div>` : `<p class="queue-empty">No open PRs</p>`}
  </div>

  <div class="section">
    <h2>Scanner Findings</h2>
    ${alertIssues.length > 0 ? `
    <div class="table-scroll"><table>
      <thead><tr><th>Issue</th><th>Title</th><th>Author</th><th>Updated</th></tr></thead>
      <tbody>${alertRows}</tbody>
    </table></div>` : `<p class="queue-empty">No scanner alerts</p>`}
  </div>

  <div class="section">
    <h2>Open Issues</h2>
    ${openIssues.length > 0 ? `
    <div class="table-scroll"><table>
      <thead><tr><th>Issue</th><th>Title</th><th>Author</th><th>Updated</th></tr></thead>
      <tbody>${issueRows}</tbody>
    </table></div>` : `<p class="queue-empty">No open issues</p>`}
  </div>

  <div class="section">
    <h2>Recent Claws Runs</h2>
    ${recentTasks.length > 0 ? `
    <div class="table-scroll"><table>
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
</body>
</html>`;
}

// ── Repo list page ──

export type RepoListSort = "activity" | "name" | "prs" | "issues";

export interface RepoListRow {
  owner: string;
  name: string;
  fullName: string;
  lastTaskAt?: string;
  openPRs: number | null;
  openIssues: number | null;
}

export function parseRepoListSort(raw: string | undefined): RepoListSort {
  return raw === "name" || raw === "prs" || raw === "issues" ? raw : "activity";
}

export function sortRepoRows(rows: RepoListRow[], sort: RepoListSort): RepoListRow[] {
  const sorted = [...rows];
  if (sort === "name") {
    sorted.sort((a, b) => a.fullName.localeCompare(b.fullName));
  } else if (sort === "prs" || sort === "issues") {
    const key = sort === "prs" ? "openPRs" : "openIssues";
    sorted.sort((a, b) => {
      const ca = a[key] ?? -1;
      const cb = b[key] ?? -1;
      if (cb !== ca) return cb - ca;
      return a.fullName.localeCompare(b.fullName);
    });
  } else {
    sorted.sort((a, b) => {
      const ta = a.lastTaskAt;
      const tb = b.lastTaskAt;
      if (!ta && !tb) return a.fullName.localeCompare(b.fullName);
      if (!ta) return 1;
      if (!tb) return -1;
      return tb.localeCompare(ta);
    });
  }
  return sorted;
}

function formatRepoCount(count: number | null, cap: number): string {
  if (count === null) return "\u2014";
  return count === cap ? `${cap}+` : String(count);
}

export function buildRepoListPage(repos: RepoListRow[], sort: RepoListSort, theme: Theme): string {
  const rows = sortRepoRows(repos, sort);

  const sortLink = (key: RepoListSort, label: string): string =>
    `<th${sort === key ? ' class="sorted"' : ""}><a href="/repos?sort=${key}">${label}${sort === key ? " \u25be" : ""}</a></th>`;

  const repoRows = rows.map(r => {
    const activityStr = r.lastTaskAt ? formatRelativeTime(r.lastTaskAt) : "no recorded activity";
    const prsHref = `https://github.com/${encodeURI(r.fullName)}/pulls`;
    const issuesHref = `https://github.com/${encodeURI(r.fullName)}/issues`;
    return `<tr>
      <td class="cell-title" data-label="Repo"><a href="${repoUrl(r.owner, r.name)}">${escapeHtml(r.fullName)}</a></td>
      <td class="repo-count" data-label="Open PRs"><a href="${prsHref}">${formatRepoCount(r.openPRs, 200)}</a></td>
      <td class="repo-count" data-label="Open Issues"><a href="${issuesHref}">${formatRepoCount(r.openIssues, 100)}</a></td>
      <td data-label="Last activity"><span style="color:var(--text-secondary);font-size:0.85em">${escapeHtml(activityStr)}</span></td>
    </tr>`;
  }).join("\n    ");

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HEAD_META}
  <title>claws \u2014 Repos</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
  th.sorted a { color: var(--accent); }
  th a { color: inherit; text-decoration: none; }
  th a:hover { color: var(--accent); }
  td.repo-count { text-align: right; font-variant-numeric: tabular-nums; }
  @media (max-width: 767px) { .data-cards td.repo-count { text-align: left; } }
  </style>
</head>
<body>
  ${buildPageHeader("Repos", theme)}
  ${THEME_SCRIPT}

  ${repos.length > 0 ? `<div class="table-scroll"><table class="data-cards">
    <thead><tr>${sortLink("name", "Repo")}${sortLink("prs", "Open PRs")}${sortLink("issues", "Open Issues")}${sortLink("activity", "Last activity")}</tr></thead>
    <tbody>${repoRows}</tbody>
  </table></div>` : `<p class="queue-empty">No repos found</p>`}
</body>
</html>`;
}
