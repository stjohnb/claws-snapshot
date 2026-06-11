import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, escapeHtml, htmlOpenTag, buildPageHeader, THEME_SCRIPT, formatRelativeTime, formatCountdown } from "./layout.js";
import type { HaUpgraderStateRow } from "../db.js";

const HIGH_RISK_PATTERN = /^update\.home_assistant_(core|supervisor|operating_system|os)/;
const HIGH_RISK_MIN_MS = 48 * 60 * 60 * 1000;
const DEVICE_MIN_MS    = 24 * 60 * 60 * 1000;

type Category = "pending-dwell" | "pending-ready" | "applied" | "failing" | "failed-blocked";

interface CategorizedRow {
  row: HaUpgraderStateRow;
  isHighRisk: boolean;
  dwellMs: number;
  category: Category;
}

function categorize(row: HaUpgraderStateRow, now: number): CategorizedRow {
  const isHighRisk = HIGH_RISK_PATTERN.test(row.entity_id);
  const dwellMs = isHighRisk ? HIGH_RISK_MIN_MS : DEVICE_MIN_MS;
  let category: Category;
  if (row.failure_count >= 3) {
    category = "failed-blocked";
  } else if (row.failure_count > 0) {
    category = "failing";
  } else if (row.attempted_at > 0 && row.failure_count === 0) {
    category = "applied";
  } else if (row.attempted_at === 0 && (now - row.first_seen_at) < dwellMs) {
    category = "pending-dwell";
  } else {
    category = "pending-ready";
  }
  return { row, isHighRisk, dwellMs, category };
}

function riskLabel(isHighRisk: boolean): string {
  return isHighRisk ? "High" : "Device";
}

function renderTable(rows: CategorizedRow[], now: number, showEta: boolean): string {
  if (rows.length === 0) return '<p class="idle">No entries.</p>';
  const header = `<table class="ha-table">
    <thead><tr>
      <th>Entity</th><th>Risk</th><th>Version</th><th>First Seen</th>
      <th>${showEta ? "ETA" : "Last Attempt"}</th><th>Failures</th>
    </tr></thead>
    <tbody>`;
  const body = rows.map(({ row, isHighRisk, dwellMs }) => {
    const eta = showEta
      ? formatCountdown(Math.max(0, row.first_seen_at + dwellMs - now))
      : (row.attempted_at > 0 ? formatRelativeTime(new Date(row.attempted_at).toISOString()) : "—");
    return `<tr>
      <td>${escapeHtml(row.entity_id)}</td>
      <td>${riskLabel(isHighRisk)}</td>
      <td>${escapeHtml(row.version)}</td>
      <td>${formatRelativeTime(new Date(row.first_seen_at).toISOString())}</td>
      <td>${eta}</td>
      <td>${row.failure_count}</td>
    </tr>`;
  }).join("\n");
  return header + body + "\n    </tbody></table>";
}

export function buildHaUpgraderPage(rows: HaUpgraderStateRow[], theme: Theme): string {
  const now = Date.now();
  const categorized = rows.map(r => categorize(r, now));

  const pendingDwell = categorized.filter(r => r.category === "pending-dwell");
  const pendingReady = categorized.filter(r => r.category === "pending-ready");
  const pending = [...pendingReady, ...pendingDwell];
  const applied = categorized.filter(r => r.category === "applied");
  const failing = categorized.filter(r => r.category === "failing");
  const blocked = categorized.filter(r => r.category === "failed-blocked");

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>claws — HA Updates</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
  .ha-table { border-collapse: collapse; font-size: 0.85rem; width: 100%; }
  .ha-table th, .ha-table td { padding: 0.4rem 0.6rem; border: 1px solid var(--border); text-align: left; }
  .ha-table th { background: var(--bg); }
  .idle { color: var(--text-subtle); font-style: italic; }
  </style>
</head>
<body>
  ${buildPageHeader("Home Assistant Updates", theme)}
  ${THEME_SCRIPT}
  <p>Live HA state is fetched daily by the <code>ha-upgrader</code> job. This page shows what the upgrader has recorded.</p>
  <h2>Pending</h2>
  ${renderTable(pending, now, true)}
  <h2>Recently Applied</h2>
  ${renderTable(applied, now, false)}
  <h2>Failing</h2>
  ${renderTable(failing, now, false)}
  <h2>Blocked (max retries reached)</h2>
  ${renderTable(blocked, now, false)}
</body>
</html>`;
}
