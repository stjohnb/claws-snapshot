import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, htmlOpenTag, buildPageHeader, THEME_SCRIPT, formatRelativeTime } from "./layout.js";
import type { DmarcReportRow, DmarcRowRow, DmarcSourceIpRow } from "../db.js";

const VERDICT_CLASS: Record<string, string> = {
  spoof: "slack-error",
  unaligned_pass: "slack-untested",
  unknown: "slack-untested",
  aligned_pass: "running",
  forwarded: "idle",
};

/** Order verdict columns worst-first so a problem is the first thing read. */
const VERDICTS = ["spoof", "unaligned_pass", "unknown", "forwarded", "aligned_pass"] as const;

function verdictCell(verdict: string, label: string): string {
  return `<td class="${VERDICT_CLASS[verdict] ?? "idle"}" data-label="${label}">${escapeHtml(verdict)}</td>`;
}

function policyText(r: {
  policy_p: string;
  policy_sp: string;
  policy_adkim: string;
  policy_aspf: string;
  policy_pct: number | null;
}): string {
  return `p=${r.policy_p || "—"}; sp=${r.policy_sp || "—"}; adkim=${r.policy_adkim || "—"}; aspf=${r.policy_aspf || "—"}; pct=${r.policy_pct ?? "—"}`;
}

function renderLatestReports(reports: DmarcReportRow[]): string {
  if (reports.length === 0) return `<p class="queue-empty">No DMARC reports ingested yet</p>`;
  const rows = reports
    .map(
      (r) => `<tr>
      <td class="cell-title" data-label="Domain">${escapeHtml(r.domain)}</td>
      <td data-label="Reporter">${escapeHtml(r.org_name)}</td>
      <td data-label="Window">${escapeHtml(r.date_begin)} → ${escapeHtml(r.date_end)}</td>
      <td class="hide-sm" data-label="Published policy"><code>${escapeHtml(policyText(r))}</code></td>
      <td class="hide-sm" data-label="Rows">${r.row_count}</td>
      <td data-label="Received">${formatRelativeTime(r.received_at)}</td>
    </tr>`,
    )
    .join("\n");
  return `<div class="table-scroll"><table class="data-cards">
    <thead><tr><th>Domain</th><th>Reporter</th><th>Window</th><th>Published policy</th><th>Rows</th><th>Received</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderVerdictCounts(counts: Array<{ domain: string; verdict: string; n: number }>): string {
  if (counts.length === 0) return `<p class="queue-empty">No rows in this window</p>`;
  const byDomain = new Map<string, Map<string, number>>();
  for (const c of counts) {
    const domain = byDomain.get(c.domain) ?? new Map<string, number>();
    domain.set(c.verdict, (domain.get(c.verdict) ?? 0) + c.n);
    byDomain.set(c.domain, domain);
  }
  const rows = [...byDomain.entries()]
    .map(([domain, verdicts]) => {
      const cells = VERDICTS.map((v) => {
        const n = verdicts.get(v) ?? 0;
        return `<td${n > 0 ? ` class="${VERDICT_CLASS[v]}"` : ""} data-label="${escapeHtml(v)}">${n}</td>`;
      }).join("");
      return `<tr><td class="cell-title" data-label="Domain">${escapeHtml(domain)}</td>${cells}</tr>`;
    })
    .join("\n");
  const headers = VERDICTS.map((v) => `<th>${escapeHtml(v)}</th>`).join("");
  return `<div class="table-scroll"><table class="data-cards">
    <thead><tr><th>Domain</th>${headers}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderSourceIps(ips: DmarcSourceIpRow[]): string {
  if (ips.length === 0) return `<p class="queue-empty">No source IPs in the last 30 days</p>`;
  const rows = ips
    .map(
      (r) => `<tr>
      <td class="cell-title" data-label="Source IP">${escapeHtml(r.source_ip)}</td>
      <td data-label="Domain">${escapeHtml(r.domain)}</td>
      ${verdictCell(r.verdict, "Verdict")}
      <td data-label="Messages">${r.messages}</td>
      <td class="hide-sm" data-label="Last seen">${escapeHtml(r.last_seen)}</td>
    </tr>`,
    )
    .join("\n");
  return `<div class="table-scroll"><table class="data-cards">
    <thead><tr><th>Source IP</th><th>Domain</th><th>Verdict</th><th>Messages</th><th>Last seen</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

/** Summarise an auth_results JSON column without trusting its contents to be well-formed. */
function authSummary(json: string): string {
  let parsed: Array<{ domain?: string; result?: string }>;
  try {
    parsed = JSON.parse(json) as Array<{ domain?: string; result?: string }>;
  } catch {
    return "—";
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return "—";
  return parsed.map((r) => `${r.result ?? "?"} (${r.domain || "?"})`).join(", ");
}

function renderRecentRows(rows: DmarcRowRow[]): string {
  if (rows.length === 0) return `<p class="queue-empty">No rows recorded yet</p>`;
  const body = rows
    .map(
      (r) => `<tr>
      <td class="hide-sm" data-label="Window start">${escapeHtml(r.date_begin)}</td>
      <td data-label="Domain">${escapeHtml(r.domain)}</td>
      <td class="cell-title" data-label="Source IP">${escapeHtml(r.source_ip)}</td>
      <td data-label="Count">${r.count}</td>
      ${verdictCell(r.verdict, "Verdict")}
      <td class="hide-sm" data-label="Header from">${escapeHtml(r.header_from) || "—"}</td>
      <td data-label="SPF">${escapeHtml(authSummary(r.spf_results))}</td>
      <td data-label="DKIM">${escapeHtml(authSummary(r.dkim_results))}</td>
      <td class="hide-sm" data-label="Disposition">${escapeHtml(r.disposition) || "—"}</td>
      <td class="hide-sm" data-label="Reporter">${escapeHtml(r.org_name)}</td>
    </tr>`,
    )
    .join("\n");
  return `<div class="table-scroll"><table class="data-cards data-cards-wide">
    <thead><tr><th>Window start</th><th>Domain</th><th>Source IP</th><th>Count</th><th>Verdict</th><th>Header from</th><th>SPF</th><th>DKIM</th><th>Disposition</th><th>Reporter</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

export function buildDmarcPage(
  latestReports: DmarcReportRow[],
  counts7: Array<{ domain: string; verdict: string; n: number }>,
  counts30: Array<{ domain: string; verdict: string; n: number }>,
  sourceIps: DmarcSourceIpRow[],
  recentRows: DmarcRowRow[],
  theme: Theme,
): string {
  return `<!DOCTYPE html>
${htmlOpenTag(theme, "wide")}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${HEAD_META}
  <title>claws — DMARC</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}</style>
</head>
<body>
  ${buildPageHeader("DMARC Aggregate Reports", theme)}
  ${THEME_SCRIPT}
  <h2>Latest report per domain and reporter</h2>
  ${renderLatestReports(latestReports)}
  <h2>Verdicts — last 7 days</h2>
  ${renderVerdictCounts(counts7)}
  <h2>Verdicts — last 30 days</h2>
  ${renderVerdictCounts(counts30)}
  <p class="hint">A window is clean when every row is <code>aligned_pass</code> or <code>forwarded</code>. Any <code>spoof</code>, <code>unaligned_pass</code> or <code>unknown</code> row must be explained before tightening a domain to <code>p=reject</code>.</p>
  <h2>Source IPs — last 30 days</h2>
  ${renderSourceIps(sourceIps)}
  <h2>Recent rows</h2>
  ${renderRecentRows(recentRows)}
</body>
</html>`;
}
