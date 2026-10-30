import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, formatRelativeTime, htmlOpenTag, buildPageHeader, THEME_SCRIPT, repoAvatar, repoShortName } from "./layout.js";
import type { NavCounts, Theme } from "./layout.js";
import { BOARD_COLUMNS, BACKLOG_DESTINATION } from "../issue-board.js";
import { shortIssueRef } from "../issue-id.js";

/** One open alert issue, as `/alerts` shows it. */
export interface AlertRow {
  id: string;
  title: string;
  /** The issue's primary repo; `""` when it names none. */
  repo: string;
  repos: readonly string[];
  /** When the alert was filed, ISO 8601. */
  createdAt: string;
  /** When the issue last changed (a new occurrence bumps it), ISO 8601. */
  updatedAt: string;
  /** The body's occurrence count; null when the body carries none. */
  occurrences: number | null;
  /** The board column the issue sits in. */
  column: string;
  /** True when that column waits on the operator (`BOARD_COLUMNS` `waits`). */
  needsOperator: boolean;
  /** The stored Blocked reason, while Blocked or Queued. */
  blockedReason: string | null;
}

const ALERTS_CSS = `
  .alerts-intro { color: var(--text-secondary); font-size: 0.875rem; margin-bottom: 1.25rem; }
  .alerts-none { color: var(--text-secondary); font-size: 0.875rem; margin: 0; }
  .alert-ref { color: var(--text-subtle); font-size: 0.8rem; }
  .alert-title { overflow-wrap: anywhere; }
  .alert-repo { display: inline-flex; align-items: center; gap: 0.4rem; overflow-wrap: anywhere; }
  .alert-status { display: inline-block; font-size: 0.7rem; padding: 0.1rem 0.5rem; border: 1px solid var(--border); border-radius: 12px; color: var(--text-subtle); white-space: nowrap; }
  .alert-status.needs-you { border-color: var(--warning); color: var(--warning); }
  .alert-reason { color: var(--text-secondary); font-size: 0.8rem; margin-top: 0.25rem; overflow-wrap: anywhere; }
`;

/** A board column's display title. */
function columnTitle(column: string): string {
  if (column === BACKLOG_DESTINATION) return "Backlog";
  return BOARD_COLUMNS.find((col) => col.id === column)?.title ?? column;
}

/** Alerts needing the operator first, then the newest. */
export function orderAlerts(rows: readonly AlertRow[]): AlertRow[] {
  return [...rows].sort((a, b) =>
    Number(b.needsOperator) - Number(a.needsOperator) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}

function statusCell(row: AlertRow): string {
  const label = `${row.needsOperator ? "Needs you" : "Automatic"} · ${columnTitle(row.column)}`;
  const chip = `<span class="alert-status${row.needsOperator ? " needs-you" : ""}">${escapeHtml(label)}</span>`;
  const reason = (row.column === "blocked" || row.column === "queued") && row.blockedReason
    ? `<div class="alert-reason">${escapeHtml(row.blockedReason.split("\n").find((line) => line.trim() !== "")?.trim() ?? "")}</div>`
    : "";
  return chip + reason;
}

function alertRow(row: AlertRow): string {
  const repo = row.repo
    ? `<span class="alert-repo">${repoAvatar(row.repo)}<span title="${escapeHtml(row.repos.join(", "))}">${escapeHtml(repoShortName(row.repo))}</span></span>`
    : "—";
  return `<tr>
        <td class="cell-title alert-title" data-label="Alert"><a href="/issues/${encodeURIComponent(row.id)}">${escapeHtml(row.title)}</a> <span class="alert-ref">#${escapeHtml(shortIssueRef(row.id))}</span></td>
        <td data-label="Repo">${repo}</td>
        <td data-label="Opened"><span title="${escapeHtml(row.createdAt)}">${escapeHtml(formatRelativeTime(row.createdAt))}</span></td>
        <td data-label="Occurrences">${row.occurrences ?? "—"}</td>
        <td data-label="Last seen"><span title="${escapeHtml(row.updatedAt)}">${escapeHtml(formatRelativeTime(row.updatedAt))}</span></td>
        <td data-label="Status">${statusCell(row)}</td>
      </tr>`;
}

/**
 * `/alerts`: every open alert issue (docs/product/dashboard-and-integrations.md
 * "Show every open alert in one place"), the ones waiting on the operator
 * first. Slack carries only the alerts that need a person; this page is the
 * complete record.
 */
export function buildAlertsPage(rows: readonly AlertRow[], theme: Theme, navCounts?: NavCounts): string {
  const ordered = orderAlerts(rows);
  const waiting = ordered.filter((r) => r.needsOperator).length;
  const intro = `<p class="alerts-intro">Every open alert Claws has filed. Claws fixes most of them by itself; Slack only carries the ones that need you. ${ordered.length} open, ${waiting} waiting on you.</p>`;
  const body = ordered.length === 0
    ? `<p class="alerts-none">No open alerts</p>`
    : `<div class="table-scroll"><table class="data-cards data-cards-wide">
      <thead><tr><th>Alert</th><th>Repo</th><th>Opened</th><th>Occurrences</th><th>Last seen</th><th>Status</th></tr></thead>
      <tbody>${ordered.map(alertRow).join("\n")}</tbody>
    </table></div>`;
  return `<!DOCTYPE html>
${htmlOpenTag(theme, "wide")}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HEAD_META}
  <title>claws — Alerts</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${ALERTS_CSS}</style>
</head>
<body>
  ${buildPageHeader("Alerts", theme, { current: "/alerts", navCounts })}
  ${THEME_SCRIPT}
  ${intro}
  ${body}
</body>
</html>`;
}
