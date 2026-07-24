import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, formatRelativeTime, htmlOpenTag, buildPageHeader, THEME_SCRIPT, CATEGORY_DISPLAY, ALPINE_SCRIPT } from "./layout.js";
import type { Theme } from "./layout.js";
import type { PR, Issue, QueueItem } from "../github.js";
import { repoUrl } from "./repo.js";
import { QUEUE_SCRIPT } from "../resources/queue.generated.js";
import { LABELS } from "../config.js";

export interface PRRowStatus {
  checkStatus: "passing" | "failing" | "pending" | "none";
  checksPassed: number;
  checksTotal: number;
  mergeableState: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewStatus?: "clean" | "issues" | "escalated" | "none";
  reviewIssueCount?: number;
}
export interface AllPRRow { repo: string; pr: PR; status?: PRRowStatus }
export interface AllIssueRow { repo: string; issue: Issue }

function buildCategoryBadge(qi: QueueItem | undefined): string {
  if (!qi) return "";
  const display = CATEGORY_DISPLAY[qi.category] ?? { label: qi.category, color: "30363d" };
  const bgColor = `#${display.color}`;
  const textColor = parseInt(display.color, 16) > 0x7fffff ? "#000" : "#fff";
  return ` <span class="pipeline-badge" style="background:${bgColor};color:${textColor}">${escapeHtml(display.label)}</span>`;
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
  if (!st || !st.reviewStatus || st.reviewStatus === "none") return "—";
  if (st.reviewStatus === "clean") return `<span class="check-badge" style="color:var(--success)">Reviewed — clean</span>`;
  if (st.reviewStatus === "escalated") return `<span class="check-badge" style="color:var(--danger)">Escalated — needs human</span>`;
  const n = st.reviewIssueCount ?? 0;
  return `<span class="check-badge" style="color:var(--danger)">${escapeHtml(`${n} issue${n === 1 ? "" : "s"} found`)}</span>`;
}

function buildMergeAction(st: PRRowStatus | undefined, escapedRepo: string, prNumber: number): string {
  if (!st) return `<span class="merge-blocked">status unknown</span>`;
  if (st.mergeableState === "CONFLICTING") return `<span class="merge-blocked">Conflicts</span>`;
  if (st.checkStatus === "failing") return `<span class="merge-blocked">CI failing</span>`;
  if (st.checkStatus === "pending") return `<span class="merge-blocked">CI pending</span>`;
  if (st.reviewStatus === "issues") return `<span class="merge-blocked">${escapeHtml(`Review: ${st.reviewIssueCount ?? 0} issues`)}</span>`;
  if (st.reviewStatus === "escalated") return `<span class="merge-blocked">Review escalated</span>`;
  return `<button class="merge-btn" @click="mergePR('${escapedRepo}',${prNumber}, $event)">Squash &amp; Merge</button>`;
}

function pageShell(title: string, headerTitle: string, theme: Theme, body: string): string {
  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
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
  .refined-btn { padding: 2px 8px; margin-left: 4px; border: 1px solid var(--border); border-radius: 4px; cursor: pointer; font-size: 0.85em; background: var(--bg-secondary); color: var(--text); }
  .refined-btn:hover { background: #0e8a16; color: #fff; }
  .refined-btn.refined-done { background: #0e8a16; color: #fff; cursor: default; opacity: 0.85; }
  .refined-btn.refined-done:hover { background: #0e8a16; color: #fff; }
  .merge-error { font-size: 0.8em; color: var(--danger, #d73a49); margin-left: 8px; word-break: break-word; }
  .merge-blocked { font-size: 0.85em; color: var(--text-subtle); }
  @media (max-width: 767px) {
    .pipeline-badge { margin-left: 0; margin-top: 0.25rem; }
    .check-badge { margin-left: 0; }
    .merge-btn, .refined-btn { width: 100%; min-height: 38px; }
  }
  </style>
  ${ALPINE_SCRIPT}
</head>
<body x-data="queuePage()">
  ${buildPageHeader(headerTitle, theme)}
  ${THEME_SCRIPT}
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
    return `<tr>
      <td data-label="Repo"><a href="${repoUrl(owner, name)}">${escapeHtml(repo)}</a></td>
      <td data-label="PR"><a href="https://github.com/${encodeURI(repo)}/pull/${pr.number}">#${pr.number}</a></td>
      <td class="cell-title" data-label="Title">${escapeHtml(pr.title)}${badges}</td>
      <td class="hide-sm" data-label="Author">${escapeHtml(pr.author?.login ?? "")}</td>
      <td data-label="Updated">${escapeHtml(updatedStr)}</td>
      <td class="hide-sm" data-label="Branch">${escapeHtml(pr.headRefName)}</td>
      <td data-label="Checks">${buildChecksCell(st)}</td>
      <td data-label="Review">${buildReviewCell(st)}</td>
      <td class="cell-actions" data-label="">${mergeBtn}</td>
    </tr>`;
  }).join("\n");

  const body = `
  <div class="section">
    <h2>Open PRs <span>${sorted.length}</span></h2>
    ${sorted.length > 0 ? `
    <div class="table-scroll"><table class="data-cards">
      <thead><tr><th>Repo</th><th>PR</th><th>Title</th><th>Author</th><th>Updated</th><th>Branch</th><th>Checks</th><th>Review</th><th>Actions</th></tr></thead>
      <tbody>${prRows}</tbody>
    </table></div>` : `<p class="queue-empty">No open PRs</p>`}
  </div>`;

  return pageShell("All PRs", "All PRs", theme, body);
}

export function buildAllIssuesPage(rows: AllIssueRow[], queueItems: QueueItem[], theme: Theme): string {
  const queueByKey = new Map<string, QueueItem>();
  for (const qi of queueItems) {
    queueByKey.set(`${qi.repo}#${qi.number}`, qi);
  }

  const sorted = [...rows].sort((a, b) => (b.issue.updatedAt || "").localeCompare(a.issue.updatedAt || ""));

  const issueRows = sorted.map(({ repo, issue }) => {
    const qi = queueByKey.get(`${repo}#${issue.number}`);
    const badges = buildCategoryBadge(qi);
    const updatedStr = issue.updatedAt ? formatRelativeTime(issue.updatedAt) : "";
    const [owner, name] = repo.split("/");
    const escapedRepo = escapeHtml(repo);
    const alreadyRefined = issue.labels.some((l) => l.name === LABELS.refined);
    const alreadyAutomerge = issue.labels.some((l) => l.name === LABELS.automerge);
    const refinedBtn = alreadyAutomerge
      ? `<span class="refined-btn refined-done">Automerge ✓</span>`
      : alreadyRefined
        ? `<button class="refined-btn" @click="markAutomerge('${escapedRepo}',${issue.number}, $event, false)">Automerge</button>`
        : `<button class="refined-btn" @click="markRefined('${escapedRepo}',${issue.number}, $event)">Refined</button>` +
          `<button class="refined-btn" @click="markAutomerge('${escapedRepo}',${issue.number}, $event, true)">Refine &amp; Merge</button>`;
    return `<tr>
      <td data-label="Repo"><a href="${repoUrl(owner, name)}">${escapeHtml(repo)}</a></td>
      <td data-label="Issue"><a href="https://github.com/${encodeURI(repo)}/issues/${issue.number}">#${issue.number}</a></td>
      <td class="cell-title" data-label="Title">${escapeHtml(issue.title)}${badges}</td>
      <td class="hide-sm" data-label="Author">${escapeHtml(issue.author?.login ?? "")}</td>
      <td data-label="Updated">${escapeHtml(updatedStr)}</td>
      <td class="cell-actions" data-label="">${refinedBtn}</td>
    </tr>`;
  }).join("\n");

  const body = `
  <div class="section">
    <h2>Open Issues <span>${sorted.length}</span></h2>
    ${sorted.length > 0 ? `
    <div class="table-scroll"><table class="data-cards">
      <thead><tr><th>Repo</th><th>Issue</th><th>Title</th><th>Author</th><th>Updated</th><th>Actions</th></tr></thead>
      <tbody>${issueRows}</tbody>
    </table></div>` : `<p class="queue-empty">No open issues</p>`}
  </div>`;

  return pageShell("All Issues", "All Issues", theme, body);
}
