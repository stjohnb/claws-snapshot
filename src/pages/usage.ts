import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, repoShortName, htmlOpenTag, buildPageHeader, THEME_SCRIPT } from "./layout.js";
import type { Theme } from "./layout.js";
import type { UsageStats, UsageTotals, UsageFilters, UsageFilterOptions, RecentEffectivenessEvent, UsageStatRow } from "../db.js";

export interface UsagePageData {
  stats: UsageStats;
  totals: UsageTotals;
  days: number;
  filters: UsageFilters;
  options: UsageFilterOptions;
  recentEvents: RecentEffectivenessEvent[];
}

function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function formatReviewScore(row: Pick<UsageStatRow, "reviewScoreTotal" | "reviewScoreCount">): string {
  if (row.reviewScoreCount === 0) return "n/a";
  const avg = row.reviewScoreTotal / row.reviewScoreCount;
  return `${avg >= 0 ? "+" : ""}${avg.toFixed(2)} (${row.reviewScoreCount})`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "n/a";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function formatScore(score: number | null): string {
  if (score === null) return "n/a";
  return `${score >= 0 ? "+" : ""}${score}`;
}

function reviewCounts(row: UsageStatRow): string {
  return `${row.reviewClean}/${row.reviewAdvisory}/${row.reviewBlocking}/${row.reviewEscalated}/${row.reviewEmptyDiff}`;
}

function usageHref(days: number, filters: UsageFilters, override?: Partial<UsageFilters> & { days?: number }): string {
  const merged = { days, ...filters, ...override };
  const parts: string[] = [`days=${merged.days}`];
  for (const key of ["repo", "job", "provider", "model"] as const) {
    const v = merged[key];
    if (v) parts.push(`${key}=${encodeURIComponent(v)}`);
  }
  return `?${parts.join("&")}`;
}

function windowSelector(currentDays: number, filters: UsageFilters): string {
  const options = [1, 7, 30];
  const links = options.map((d) => {
    const label = d === 1 ? "1 day" : `${d} days`;
    if (d === currentDays) {
      return `<strong>${escapeHtml(label)}</strong>`;
    }
    return `<a href="${usageHref(d, filters)}">${escapeHtml(label)}</a>`;
  });
  return `<p class="refresh-note">Window: ${links.join(" · ")}</p>`;
}

function optionsHtml(values: string[], current: string | undefined, label: (v: string) => string): string {
  const withCurrent = current && !values.includes(current) ? [current, ...values] : values;
  let html = `<option value="">All</option>`;
  for (const v of withCurrent) {
    const selected = v === current ? " selected" : "";
    html += `<option value="${escapeHtml(v)}"${selected}>${escapeHtml(label(v))}</option>`;
  }
  return html;
}

function filterForm(days: number, filters: UsageFilters, options: UsageFilterOptions): string {
  return `<form method="get" action="/usage" style="margin-bottom: 1rem; display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-end;">
    <input type="hidden" name="days" value="${days}">
    <label class="form-field">Repo
      <select name="repo" class="form-select">${optionsHtml(options.repos, filters.repo, repoShortName)}</select>
    </label>
    <label class="form-field">Job
      <select name="job" class="form-select">${optionsHtml(options.jobs, filters.job, (v) => v)}</select>
    </label>
    <label class="form-field">Provider
      <select name="provider" class="form-select">${optionsHtml(options.providers, filters.provider, (v) => v)}</select>
    </label>
    <label class="form-field">Model
      <select name="model" class="form-select">${optionsHtml(options.models, filters.model, (v) => v)}</select>
    </label>
    <button type="submit" class="trigger-btn">Apply</button>
    <a href="?days=${days}" class="trigger-btn">Clear</a>
  </form>`;
}

export function buildUsagePage(data: UsagePageData, theme: Theme): string {
  const { stats, totals, days, filters, options, recentEvents } = data;

  const activeFilters = (["repo", "job", "provider", "model"] as const)
    .filter((k) => filters[k])
    .map((k) => `${k}=${filters[k]}`);
  const activeFiltersNote = activeFilters.length > 0
    ? `<p class="refresh-note">Filtered by ${escapeHtml(activeFilters.join(", "))} — totals below reflect this filter, not the full window.</p>`
    : "";

  let summaryHtml = `<div class="stat-grid">`;
  summaryHtml += `<div class="stat-card">
    <div class="stat-number text-accent">${escapeHtml(formatCost(totals.totalCostUsd))}</div>
    <div class="stat-label">Total Cost</div></div>`;
  summaryHtml += `<div class="stat-card">
    <div class="stat-number">${escapeHtml(formatTokens(totals.totalTokens))}</div>
    <div class="stat-label">Total Tokens</div></div>`;
  summaryHtml += `<div class="stat-card">
    <div class="stat-number">${totals.taskCount}</div>
    <div class="stat-label">Total Tasks</div></div>`;
  summaryHtml += `</div>`;

  let repoHtml = `<h2>By Repository</h2>`;
  if (stats.repoStats.length === 0) {
    repoHtml += `<p class="queue-empty">No usage data in this window</p>`;
  } else {
    repoHtml += `<div class="table-scroll"><table class="data-cards"><thead><tr><th>Repo</th><th>Tasks</th><th>Failed</th><th>Changed</th><th>PRs</th><th>Review Score</th><th>Reviews</th><th>Tokens</th><th>Cost</th><th>Avg Duration</th></tr></thead><tbody>`;
    for (const r of stats.repoStats) {
      repoHtml += `<tr>
        <td data-label="Repo" class="cell-title"><a href="${usageHref(days, filters, { repo: r.repo })}">${escapeHtml(repoShortName(r.repo))}</a></td>
        <td data-label="Tasks">${r.taskCount}</td>
        <td data-label="Failed">${r.failedCount}</td>
        <td data-label="Changed">${r.changedCount}</td>
        <td data-label="PRs">${r.prCreatedCount}</td>
        <td data-label="Review Score">${escapeHtml(formatReviewScore(r))}</td>
        <td data-label="Reviews">${escapeHtml(reviewCounts(r))}</td>
        <td data-label="Tokens">${escapeHtml(formatTokens(r.totalTokens))}</td>
        <td data-label="Cost">${escapeHtml(formatCost(r.totalCostUsd))}</td>
        <td data-label="Avg Duration">${escapeHtml(formatDuration(r.avgDurationSeconds))}</td>
      </tr>`;
    }
    repoHtml += `</tbody></table></div>`;
  }

  let jobHtml = `<h2>By Job</h2>`;
  if (stats.jobStats.length === 0) {
    jobHtml += `<p class="queue-empty">No usage data in this window</p>`;
  } else {
    jobHtml += `<div class="table-scroll"><table class="data-cards"><thead><tr><th>Job</th><th>Tasks</th><th>Failed</th><th>Changed</th><th>PRs</th><th>Review Score</th><th>Reviews</th><th>Tokens</th><th>Cost</th><th>Avg Duration</th></tr></thead><tbody>`;
    for (const j of stats.jobStats) {
      jobHtml += `<tr>
        <td data-label="Job" class="cell-title"><a href="${usageHref(days, filters, { job: j.jobName })}">${escapeHtml(j.jobName)}</a></td>
        <td data-label="Tasks">${j.taskCount}</td>
        <td data-label="Failed">${j.failedCount}</td>
        <td data-label="Changed">${j.changedCount}</td>
        <td data-label="PRs">${j.prCreatedCount}</td>
        <td data-label="Review Score">${escapeHtml(formatReviewScore(j))}</td>
        <td data-label="Reviews">${escapeHtml(reviewCounts(j))}</td>
        <td data-label="Tokens">${escapeHtml(formatTokens(j.totalTokens))}</td>
        <td data-label="Cost">${escapeHtml(formatCost(j.totalCostUsd))}</td>
        <td data-label="Avg Duration">${escapeHtml(formatDuration(j.avgDurationSeconds))}</td>
      </tr>`;
    }
    jobHtml += `</tbody></table></div>`;
  }

  let providerHtml = `<h2>By Provider / Model</h2>`;
  if (stats.providerStats.length === 0) {
    providerHtml += `<p class="queue-empty">No usage data in this window</p>`;
  } else {
    providerHtml += `<div class="table-scroll"><table class="data-cards"><thead><tr><th>Provider</th><th>Model</th><th>Tasks</th><th>Failed</th><th>Changed</th><th>Merged</th><th>Reviews C/A/B/E/Empty</th><th>Review Score</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>`;
    for (const p of stats.providerStats) {
      providerHtml += `<tr>
        <td data-label="Provider" class="cell-title"><a href="${usageHref(days, filters, { provider: p.provider })}">${escapeHtml(p.provider)}</a></td>
        <td data-label="Model"><a href="${usageHref(days, filters, { model: p.model })}">${escapeHtml(p.model)}</a></td>
        <td data-label="Tasks">${p.taskCount}</td>
        <td data-label="Failed">${p.failedCount}</td>
        <td data-label="Changed">${p.changedCount}</td>
        <td data-label="Merged">${p.mergedCount}</td>
        <td data-label="Reviews">${escapeHtml(reviewCounts(p))}</td>
        <td data-label="Review Score">${escapeHtml(formatReviewScore(p))}</td>
        <td data-label="Tokens">${escapeHtml(formatTokens(p.totalTokens))}</td>
        <td data-label="Cost">${escapeHtml(formatCost(p.totalCostUsd))}</td>
      </tr>`;
    }
    providerHtml += `</tbody></table></div>`;
  }

  let signalsHtml = `<h2>Recent Quality Signals</h2>`;
  if (recentEvents.length === 0) {
    signalsHtml += `<p class="queue-empty">No quality signals in this window</p>`;
  } else {
    signalsHtml += `<div class="table-scroll"><table class="data-cards"><thead><tr><th>Task / Job</th><th>Provider / Model</th><th>Source PR</th><th>Signal</th><th>Score</th><th>Observed</th></tr></thead><tbody>`;
    for (const e of recentEvents) {
      signalsHtml += `<tr>
        <td data-label="Task / Job" class="cell-title">#${e.taskId} ${escapeHtml(e.jobName)}</td>
        <td data-label="Provider / Model">${escapeHtml(`${e.provider} / ${e.model}`)}</td>
        <td data-label="Source PR">${escapeHtml(`${repoShortName(e.sourceRepo)}#${e.sourceNumber} @ ${e.sourceSha.slice(0, 12) || "n/a"}`)}</td>
        <td data-label="Signal">${escapeHtml(e.signal)}</td>
        <td data-label="Score">${escapeHtml(formatScore(e.score))}</td>
        <td data-label="Observed">${escapeHtml(e.createdAt)}</td>
      </tr>`;
    }
    signalsHtml += `</tbody></table></div>`;
  }

  const footnote = `<p class="refresh-note">Rows include agent tasks with provider/model or usage data; running tasks may be incomplete. Codex cost can be $0. Tasks that ran before per-task provider attribution landed are grouped as <code>unknown</code>. Review score is clean +1, advisory +0.5, blocking/escalated/empty-diff -1.</p>`;

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${HEAD_META}
  <meta http-equiv="refresh" content="60">
  <title>Usage — Claws</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}</style>
</head>
<body>
  ${buildPageHeader(`Usage (last ${days} ${days === 1 ? "day" : "days"})`, theme)}
  ${THEME_SCRIPT}
  ${windowSelector(days, filters)}
  ${filterForm(days, filters, options)}
  ${activeFiltersNote}
  ${summaryHtml}
  ${repoHtml}
  ${jobHtml}
  ${providerHtml}
  ${signalsHtml}
  ${footnote}
</body>
</html>`;
}
