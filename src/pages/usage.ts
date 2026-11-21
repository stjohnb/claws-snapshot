import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, repoAvatar, repoShortName, htmlOpenTag, buildPageHeader, THEME_SCRIPT } from "./layout.js";
import type { NavCounts, Theme } from "./layout.js";
import { usageWarningLevel } from "../db.js";
import type { UsageItem, UsageTotals, UsageFilters, UsageFilterOptions, RecentEffectivenessEvent } from "../db.js";
import {
  PIVOT_DIMS, PIVOT_DIM_LABELS, PIVOT_MEASURES, PIVOT_MEASURE_LABELS, MAX_ROW_DIMS, OTHER_COL, OPEN_ALL,
  buildPivot, isOpen, pivotHref, sortToggle, toggleOpen,
  type PivotDim, type PivotGroup, type PivotMeasure, type PivotMeasures, type PivotState,
} from "../usage-pivot.js";

export interface UsagePageData {
  /** Every task and interactive session in the window and filters, one row each. */
  items: UsageItem[];
  /** The pivot view parsed from the query string. */
  pivot: PivotState;
  totals: UsageTotals;
  days: number;
  filters: UsageFilters;
  options: UsageFilterOptions;
  recentEvents: RecentEffectivenessEvent[];
  /** All-time reported OpenCode-on-Anthropic spend (USD), unaffected by the window and filters. */
  opencodeSpendUsd?: number;
  /** The configured OpenCode spend warning threshold (USD); 0 disables the warning. */
  opencodeSpendWarnUsd?: number;
}

/** The summary card for all-time OpenCode Anthropic API spend, in `--warning` once it reaches the threshold. */
function opencodeSpendCard(spendUsd: number, warnUsd: number): string {
  const over = warnUsd > 0 && spendUsd >= warnUsd;
  const style = over ? ' style="color:var(--warning);"' : "";
  const ofWarning = warnUsd > 0 ? ` of ${formatCost(warnUsd)} warning` : "";
  return `<div class="stat-card" id="opencode-spend">
    <div class="stat-number"${style}>${escapeHtml(formatCost(spendUsd) + ofWarning)}</div>
    <div class="stat-label">OpenCode API spend (all time, reported)</div></div>`;
}

function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function formatScore(score: number | null): string {
  if (score === null) return "n/a";
  return `${score >= 0 ? "+" : ""}${score}`;
}

/** A pivot cost cell: the known sum, "+ N unknown" when some costs are unknown, "unknown" when all are. */
function formatPivotCost(m: PivotMeasures): string {
  if (m.items > 0 && m.unknownCost === m.items) return "unknown";
  const known = formatCost(m.cost);
  return m.unknownCost > 0 ? `${known} + ${m.unknownCost} unknown` : known;
}

function contextCell(m: PivotMeasures | undefined): string {
  if (!m || m.context == null) return "—";
  const level = usageWarningLevel(m.context);
  const text = escapeHtml(formatTokens(m.context));
  if (level === "none") return text;
  const color = level === "critical" ? "var(--danger)" : "var(--warning)";
  const label = level === "critical" ? "critical" : "warning";
  return `<span style="color:${color}; font-weight:600;" title="Context ${label}">${text}</span>`;
}

function measureCell(m: PivotMeasures | undefined, measure: PivotMeasure): string {
  if (!m || m.items === 0) return "—";
  switch (measure) {
    case "items": return String(m.items);
    case "tokens": return escapeHtml(formatTokens(m.tokens));
    case "cost": return escapeHtml(formatPivotCost(m));
    case "context": return contextCell(m);
  }
}

/** Plain-text label for a dimension value, used in titles and column headers. */
function dimText(dim: PivotDim, value: string, sample: UsageItem | undefined): string {
  switch (dim) {
    case "repo": return sample && sample.repo == null ? value : repoShortName(value);
    case "account": return value === "" ? "(none)" : value;
    case "kind": return value === "session" ? "Session" : "Task";
    case "id":
      if (sample?.kind === "session") return (sample.sessionId ?? "").slice(0, 8);
      return `#${sample?.taskId ?? value.replace(/^task:/, "")}`;
    default: return value === "" ? "(none)" : value;
  }
}

/** The rendered label of a row group: repo avatar, task log and live-session links. */
function groupLabel(g: PivotGroup): string {
  const text = escapeHtml(dimText(g.dim, g.value, g.sample));
  if (g.dim === "repo") return g.sample.repo == null ? text : `${repoAvatar(g.value)}${text}`;
  if (g.dim === "id") {
    if (g.sample.kind === "session") {
      return g.sample.alive && g.sample.sessionId ? `<a href="/sessions/${escapeHtml(g.sample.sessionId)}">${text}</a>` : text;
    }
    return g.sample.runId ? `<a href="/logs/${escapeHtml(g.sample.runId)}">${text}</a>` : text;
  }
  return text;
}

function windowSelector(data: UsagePageData): string {
  const options = [1, 7, 30];
  const links = options.map((d) => {
    const label = d === 1 ? "1 day" : `${d} days`;
    if (d === data.days) {
      return `<strong>${escapeHtml(label)}</strong>`;
    }
    return `<a href="${escapeHtml(pivotHref(data, data.pivot, { days: d }))}">${escapeHtml(label)}</a>`;
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

function dimOptions(current: PivotDim | null, emptyLabel: string | null): string {
  let html = emptyLabel === null ? "" : `<option value=""${current === null ? " selected" : ""}>${escapeHtml(emptyLabel)}</option>`;
  for (const d of PIVOT_DIMS) {
    html += `<option value="${d}"${d === current ? " selected" : ""}>${escapeHtml(PIVOT_DIM_LABELS[d])}</option>`;
  }
  return html;
}

function controlsForm(data: UsagePageData): string {
  const { days, filters, options, pivot } = data;
  let rowSelects = "";
  for (let i = 0; i < MAX_ROW_DIMS; i++) {
    rowSelects += `<label class="form-field">Rows ${i + 1}
      <select name="rows" class="form-select">${dimOptions(pivot.rows[i] ?? null, i === 0 ? null : "—")}</select>
    </label>`;
  }
  const measureOptions = PIVOT_MEASURES.map((m) => `<option value="${m}"${m === pivot.measure ? " selected" : ""}>${escapeHtml(PIVOT_MEASURE_LABELS[m])}</option>`).join("");
  const clearHref = pivotHref(data, pivot, { filters: {}, open: [] });
  return `<form method="get" action="/usage" class="usage-controls">
    <input type="hidden" name="days" value="${days}">
    ${pivot.sort.startsWith("col:") ? "" : `<input type="hidden" name="sort" value="${escapeHtml(pivot.sort)}">
    <input type="hidden" name="dir" value="${pivot.dir}">`}
    ${rowSelects}
    <label class="form-field">Columns
      <select name="cols" class="form-select">${dimOptions(pivot.cols, "None")}</select>
    </label>
    <label class="form-field">Measure
      <select name="measure" class="form-select" title="Shown per column when Columns is set">${measureOptions}</select>
    </label>
    <label class="form-field">Repo
      <select name="repo" class="form-select">${optionsHtml(options.repos, filters.repo, repoShortName)}</select>
    </label>
    <label class="form-field">Job
      <select name="job" class="form-select">${optionsHtml(options.jobs, filters.job, (v) => v)}</select>
    </label>
    <label class="form-field">Provider
      <select name="provider" class="form-select">${optionsHtml(options.providers, filters.provider, (v) => v)}</select>
    </label>
    <label class="form-field">Account
      <select name="account" class="form-select">${optionsHtml(options.accounts, filters.account, (v) => v)}</select>
    </label>
    <label class="form-field">Model
      <select name="model" class="form-select">${optionsHtml(options.models, filters.model, (v) => v)}</select>
    </label>
    <div class="usage-controls-actions">
      <button type="submit" class="trigger-btn">Apply</button>
      <a href="${escapeHtml(clearHref)}" class="trigger-btn">Clear</a>
    </div>
  </form>`;
}

const USAGE_PIVOT_CSS = `
    .usage-controls { margin-bottom: 1rem; display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: flex-end; }
    .usage-controls .form-field { flex: 1 1 calc(50% - 0.75rem); }
    .usage-controls-actions { display: flex; gap: 0.5rem; }
    .usage-pivot-wrap { max-height: 75vh; overflow: auto; border: 1px solid var(--border); border-radius: 4px; }
    .usage-pivot { width: 100%; font-variant-numeric: tabular-nums; }
    .usage-pivot th, .usage-pivot td { padding: 0.35rem 0.6rem; white-space: nowrap; }
    .usage-pivot thead th { position: sticky; top: 0; background: var(--bg); z-index: 1; }
    .usage-pivot .num { text-align: right; }
    .usage-pivot th.num a, .usage-pivot th a { color: inherit; text-decoration: none; }
    .usage-pivot th[aria-sort] a { color: var(--accent); }
    .usage-pivot .pivot-label { position: sticky; left: 0; background: var(--bg); z-index: 1; max-width: 16rem; overflow: hidden; text-overflow: ellipsis; }
    .usage-pivot thead th.pivot-label { z-index: 2; }
    .usage-pivot .pivot-dim { color: var(--text-subtle); font-size: 0.75rem; margin-right: 0.35rem; }
    .usage-pivot .pivot-toggle { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; margin: -0.35rem 0; color: var(--text-secondary); text-decoration: none; vertical-align: middle; }
    .usage-pivot .pivot-toggle-spacer { display: inline-block; width: 44px; }
    .usage-pivot tr.pivot-total td { font-weight: 600; border-top: 2px solid var(--border-hover); }
    .usage-pivot tr.pivot-more td { color: var(--text-subtle); font-style: italic; }
    .usage-signals summary { cursor: pointer; font-family: var(--font-display); color: var(--text-secondary); margin: 1rem 0 0.5rem; }
    @media (min-width: 768px) {
      .usage-controls .form-field { flex: 0 1 10rem; max-width: 12rem; }
      .usage-pivot .pivot-label { max-width: 24rem; }
      .usage-pivot .pivot-toggle { min-width: 30px; min-height: 30px; }
      .usage-pivot .pivot-toggle-spacer { width: 30px; }
    }
`;

/** A sortable header cell. */
function sortHeader(data: UsagePageData, label: string, sortKey: string): string {
  const { pivot } = data;
  const active = pivot.sort === sortKey;
  const next = sortToggle(pivot, sortKey);
  const arrow = active ? (pivot.dir === "desc" ? " ▼" : " ▲") : "";
  const ariaSort = active ? ` aria-sort="${pivot.dir === "desc" ? "descending" : "ascending"}"` : "";
  return `<th class="num"${ariaSort}><a href="${escapeHtml(pivotHref(data, pivot, next))}">${escapeHtml(label)}${arrow}</a></th>`;
}

function rowCells(data: UsagePageData, m: PivotMeasures, byCol: Map<string, PivotMeasures>, colKeys: string[]): string {
  const { pivot } = data;
  if (!pivot.cols) {
    return `<td class="num">${m.items}</td><td class="num">${escapeHtml(formatTokens(m.tokens))}</td><td class="num">${escapeHtml(formatPivotCost(m))}</td><td class="num">${contextCell(m)}</td>`;
  }
  let html = "";
  for (const key of colKeys) html += `<td class="num">${measureCell(byCol.get(key), pivot.measure)}</td>`;
  html += `<td class="num">${measureCell(m, pivot.measure)}</td>`;
  return html;
}

function pivotRows(data: UsagePageData, groups: PivotGroup[], hidden: number, colKeys: string[], depth: number): string {
  const { pivot } = data;
  let html = "";
  const indent = `padding-left:${(depth + 0.6).toFixed(1)}rem;`;
  for (const g of groups) {
    const expandable = g.depth + 1 < pivot.rows.length;
    const open = expandable && isOpen(pivot, g.path);
    const toggle = expandable
      ? `<a class="pivot-toggle" href="${escapeHtml(pivotHref(data, pivot, { open: toggleOpen(pivot, g.path) }))}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${escapeHtml(dimText(g.dim, g.value, g.sample))}">${open ? "▾" : "▸"}</a>`
      : `<span class="pivot-toggle-spacer"></span>`;
    const title = escapeHtml(`${PIVOT_DIM_LABELS[g.dim]}: ${g.dim === "id" ? (g.sample.sessionId ?? `#${g.sample.taskId}`) : dimText(g.dim, g.value, g.sample)}`);
    html += `<tr data-depth="${g.depth}"><td class="pivot-label" style="${indent}" title="${title}">${toggle}${groupLabel(g)}</td>${rowCells(data, g.measures, g.byCol, colKeys)}</tr>`;
    if (open) html += pivotRows(data, g.children, g.hiddenChildren, colKeys, depth + 1);
  }
  if (hidden > 0) {
    const span = pivot.cols ? colKeys.length + 2 : 5;
    html += `<tr class="pivot-more"><td class="pivot-label" style="${indent}" colspan="${span}">${hidden} more not shown — narrow the filters</td></tr>`;
  }
  return html;
}

function pivotSection(data: UsagePageData): string {
  const { items, pivot } = data;
  if (items.length === 0) return `<p class="queue-empty">No usage data in this window</p>`;
  const result = buildPivot(items, pivot);
  const rowsLabel = pivot.rows.map((d) => PIVOT_DIM_LABELS[d]).join(" › ");
  let head = `<th class="pivot-label">${escapeHtml(rowsLabel)}</th>`;
  if (!pivot.cols) {
    for (const m of PIVOT_MEASURES) head += sortHeader(data, PIVOT_MEASURE_LABELS[m], m);
  } else {
    for (const key of result.colKeys) {
      const label = key === OTHER_COL ? "Other" : dimText(pivot.cols, key, result.colSamples.get(key));
      head += sortHeader(data, label, `col:${key}`);
    }
    head += sortHeader(data, `Total ${PIVOT_MEASURE_LABELS[pivot.measure].toLowerCase()}`, "total");
  }
  const expandAll = pivot.rows.length > 1
    ? `<p class="refresh-note" style="margin-top:0.5rem;">${pivot.open.includes(OPEN_ALL)
      ? `<a href="${escapeHtml(pivotHref(data, pivot, { open: [] }))}">Collapse all</a>`
      : `<a href="${escapeHtml(pivotHref(data, pivot, { open: [OPEN_ALL] }))}">Expand all</a>`}</p>`
    : "";
  const body = pivotRows(data, result.groups, result.hiddenGroups, result.colKeys, 0);
  const totalRow = `<tr class="pivot-total"><td class="pivot-label" style="padding-left:0.6rem;">Total</td>${rowCells(data, result.total, result.totalByCol, result.colKeys)}</tr>`;
  return `<div class="usage-pivot-wrap table-scroll"><table class="usage-pivot"><thead><tr>${head}</tr></thead><tbody>${body}${totalRow}</tbody></table></div>${expandAll}`;
}

export function buildUsagePage(data: UsagePageData, theme: Theme, navCounts?: NavCounts): string {
  const { items, totals, days, filters, recentEvents } = data;

  const activeFilters = (["repo", "job", "provider", "account", "model"] as const)
    .filter((k) => filters[k])
    .map((k) => `${k}=${filters[k]}`);
  const activeFiltersNote = activeFilters.length > 0
    ? `<p class="refresh-note">Filtered by ${escapeHtml(activeFilters.join(", "))} — totals below reflect this filter, not the full window.</p>`
    : "";

  const unknownCostCount = items.filter((i) => i.costUsd == null).length;
  let summaryHtml = `<div class="stat-grid">`;
  summaryHtml += `<div class="stat-card">
    <div class="stat-number text-accent">${escapeHtml(formatCost(totals.totalCostUsd))}</div>
    <div class="stat-label">Total Cost${unknownCostCount > 0 ? ` <span id="unknown-cost-count">+${unknownCostCount} unknown</span>` : ""}</div></div>`;
  summaryHtml += `<div class="stat-card">
    <div class="stat-number">${escapeHtml(formatTokens(totals.totalTokens))}</div>
    <div class="stat-label">Total Tokens</div></div>`;
  summaryHtml += `<div class="stat-card">
    <div class="stat-number">${totals.taskCount}</div>
    <div class="stat-label">Total Runs</div></div>`;
  if (data.opencodeSpendUsd !== undefined) {
    summaryHtml += opencodeSpendCard(data.opencodeSpendUsd, data.opencodeSpendWarnUsd ?? 0);
  }
  summaryHtml += `</div>`;

  const pivotHtml = `<h2>Explore</h2>${controlsForm(data)}${pivotSection(data)}`;

  let signalsHtml = `<details class="usage-signals"><summary>Recent Quality Signals (${recentEvents.length})</summary>`;
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
  signalsHtml += `</details>`;

  const footnote = `<p class="refresh-note">Rows include headless agent tasks and interactive sessions with provider/model or usage data; running items may be incomplete. Session dollar cost is unknown when the provider transcript does not expose it; cost sums show unknown items separately ("+ N unknown") rather than as $0. Codex task cost can be $0. Items that ran before provider attribution landed are grouped as <code>unknown</code>. Account is the Claude account that served a task, (none) for other providers and for sessions. Max context is the largest last-context size among a group's sessions, in warning or danger colour as it nears the limit.</p>`;

  return `<!DOCTYPE html>
${htmlOpenTag(theme, "wide")}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${HEAD_META}
  <meta http-equiv="refresh" content="60">
  <title>Usage — Claws</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${USAGE_PIVOT_CSS}</style>
</head>
<body>
  ${buildPageHeader(`Usage (last ${days} ${days === 1 ? "day" : "days"})`, theme, { current: "/usage", navCounts })}
  ${THEME_SCRIPT}
  ${windowSelector(data)}
  ${activeFiltersNote}
  ${summaryHtml}
  ${pivotHtml}
  ${signalsHtml}
  ${footnote}
</body>
</html>`;
}
