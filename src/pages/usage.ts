import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, repoShortName, htmlOpenTag, buildPageHeader, THEME_SCRIPT } from "./layout.js";
import type { Theme } from "./layout.js";
import type { UsageStats, UsageTotals, UsageFilters, UsageFilterOptions } from "../db.js";

export interface UsagePageData {
  stats: UsageStats;
  totals: UsageTotals;
  days: number;
  filters: UsageFilters;
  options: UsageFilterOptions;
}

function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
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
  const { stats, totals, days, filters, options } = data;

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
    repoHtml += `<div class="table-scroll"><table><thead><tr><th>Repo</th><th>Tasks</th><th>Tokens</th><th>Cost USD</th></tr></thead><tbody>`;
    for (const r of stats.repoStats) {
      repoHtml += `<tr>
        <td><a href="${usageHref(days, filters, { repo: r.repo })}">${escapeHtml(repoShortName(r.repo))}</a></td>
        <td>${r.taskCount}</td>
        <td>${escapeHtml(formatTokens(r.totalTokens))}</td>
        <td>${escapeHtml(formatCost(r.totalCostUsd))}</td>
      </tr>`;
    }
    repoHtml += `</tbody></table></div>`;
  }

  let jobHtml = `<h2>By Job</h2>`;
  if (stats.jobStats.length === 0) {
    jobHtml += `<p class="queue-empty">No usage data in this window</p>`;
  } else {
    jobHtml += `<div class="table-scroll"><table><thead><tr><th>Job</th><th>Tasks</th><th>Tokens</th><th>Cost USD</th></tr></thead><tbody>`;
    for (const j of stats.jobStats) {
      jobHtml += `<tr>
        <td><a href="${usageHref(days, filters, { job: j.jobName })}">${escapeHtml(j.jobName)}</a></td>
        <td>${j.taskCount}</td>
        <td>${escapeHtml(formatTokens(j.totalTokens))}</td>
        <td>${escapeHtml(formatCost(j.totalCostUsd))}</td>
      </tr>`;
    }
    jobHtml += `</tbody></table></div>`;
  }

  let providerHtml = `<h2>By Provider / Model</h2>`;
  if (stats.providerStats.length === 0) {
    providerHtml += `<p class="queue-empty">No usage data in this window</p>`;
  } else {
    providerHtml += `<div class="table-scroll"><table><thead><tr><th>Provider</th><th>Model</th><th>Tasks</th><th>Tokens</th><th>Cost USD</th></tr></thead><tbody>`;
    for (const p of stats.providerStats) {
      providerHtml += `<tr>
        <td><a href="${usageHref(days, filters, { provider: p.provider })}">${escapeHtml(p.provider)}</a></td>
        <td><a href="${usageHref(days, filters, { model: p.model })}">${escapeHtml(p.model)}</a></td>
        <td>${p.taskCount}</td>
        <td>${escapeHtml(formatTokens(p.totalTokens))}</td>
        <td>${escapeHtml(formatCost(p.totalCostUsd))}</td>
      </tr>`;
    }
    providerHtml += `</tbody></table></div>`;
  }

  const footnote = `<p class="refresh-note">Showing tasks that reported usage data; tasks predating usage tracking are excluded. Codex reports tokens but no price, so its cost shows as $0. Tasks that ran before per-task provider attribution landed are grouped as <code>unknown</code>.</p>`;

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
  ${footnote}
</body>
</html>`;
}
