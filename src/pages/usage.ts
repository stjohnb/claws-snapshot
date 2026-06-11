import { PAGE_CSS, TAILWIND_STYLESHEET, escapeHtml, repoShortName, htmlOpenTag, buildPageHeader, THEME_SCRIPT } from "./layout.js";
import type { Theme } from "./layout.js";
import type { UsageStats, UsageTotals } from "../db.js";

export interface UsagePageData {
  stats: UsageStats;
  totals: UsageTotals;
  days: number;
}

function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function windowSelector(currentDays: number): string {
  const options = [1, 7, 30];
  const links = options.map((d) => {
    const label = d === 1 ? "1 day" : `${d} days`;
    if (d === currentDays) {
      return `<strong>${escapeHtml(label)}</strong>`;
    }
    return `<a href="?days=${d}">${escapeHtml(label)}</a>`;
  });
  return `<p class="refresh-note">Window: ${links.join(" · ")}</p>`;
}

export function buildUsagePage(data: UsagePageData, theme: Theme): string {
  const { stats, totals, days } = data;

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
        <td>${escapeHtml(repoShortName(r.repo))}</td>
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
        <td>${escapeHtml(j.jobName)}</td>
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
        <td>${escapeHtml(p.provider)}</td>
        <td>${escapeHtml(p.model)}</td>
        <td>${p.taskCount}</td>
        <td>${escapeHtml(formatTokens(p.totalTokens))}</td>
        <td>${escapeHtml(formatCost(p.totalCostUsd))}</td>
      </tr>`;
    }
    providerHtml += `</tbody></table></div>`;
  }

  const footnote = `<p class="refresh-note">Showing tasks that reported usage data. Codex tasks and historical tasks predating usage tracking are excluded.</p>`;

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="60">
  <title>Usage — Claws</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}</style>
</head>
<body>
  ${buildPageHeader(`Usage (last ${days} ${days === 1 ? "day" : "days"})`, theme)}
  ${THEME_SCRIPT}
  ${windowSelector(days)}
  ${summaryHtml}
  ${repoHtml}
  ${jobHtml}
  ${providerHtml}
  ${footnote}
</body>
</html>`;
}
