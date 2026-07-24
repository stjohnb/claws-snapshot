import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, htmlOpenTag, buildPageHeader, THEME_SCRIPT, formatRelativeTime } from "./layout.js";
import type { K8sMonitorStatus } from "../jobs/k3s-monitor.js";

export interface K8sClusterView {
  label: string;
  status: K8sMonitorStatus | null;
  recentRuns: Array<{ runId: string; status: string; startedAt: string; completedAt: string | null }>;
  alertsUrl: string;
}

function renderStatusCard(s: K8sMonitorStatus | null): string {
  if (!s) {
    return `<dl class="meta"><dt>Status</dt><dd class="idle">No data</dd></dl>`;
  }
  const rows: string[] = [
    `<dt>Repo</dt><dd><a href="https://github.com/${escapeHtml(s.repo)}">${escapeHtml(s.repo)}</a></dd>`,
    `<dt>Enabled</dt><dd class="${s.enabled ? "running" : "idle"}">${s.enabled ? "Yes" : "No"}</dd>`,
  ];
  if (s.lastRunAt) {
    rows.push(`<dt>Last run</dt><dd>${formatRelativeTime(s.lastRunAt)}</dd>`);
  }
  if (s.lastError) {
    rows.push(`<dt>Last error</dt><dd class="slack-error">${escapeHtml(s.lastError)}</dd>`);
  }
  if (s.enabled) {
    rows.push(
      `<dt>Pods</dt><dd>${s.podCount}</dd>`,
      `<dt>Nodes</dt><dd>${s.nodeCount}</dd>`,
      `<dt>Pod alerts</dt><dd${s.podAlertCount > 0 ? ' class="slack-error"' : ""}>${s.podAlertCount}</dd>`,
      `<dt>Node alerts</dt><dd${s.nodeAlertCount > 0 ? ' class="slack-error"' : ""}>${s.nodeAlertCount}</dd>`,
      `<dt>Flux alerts</dt><dd${s.fluxAlertCount > 0 ? ' class="slack-error"' : ""}>${s.fluxAlertCount}</dd>`,
      `<dt>New issues raised</dt><dd>${s.newIssuesRaised}</dd>`,
    );
  }
  return `<dl class="meta">${rows.join("\n")}</dl>`;
}


function renderRecentRuns(runs: K8sClusterView["recentRuns"]): string {
  if (runs.length === 0) return `<p class="queue-empty">No recent runs</p>`;
  const toIso = (s: string) => s.replace(' ', 'T') + 'Z';
  const rows = runs.map(r => {
    const statusCls = r.status === "success" ? "running" : r.status === "running" ? "running" : r.status === "failed" ? "slack-error" : "idle";
    const completed = r.completedAt ? formatRelativeTime(toIso(r.completedAt)) : "—";
    return `<tr>
      <td><a href="/logs/${encodeURIComponent(r.runId)}">${escapeHtml(r.runId.slice(0, 8))}</a></td>
      <td class="${statusCls}">${escapeHtml(r.status)}</td>
      <td>${formatRelativeTime(toIso(r.startedAt))}</td>
      <td>${completed}</td>
    </tr>`;
  }).join("\n");
  return `<table class="k8s-table">
    <thead><tr><th>Run ID</th><th>Status</th><th>Started</th><th>Completed</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}


function renderCluster(cluster: K8sClusterView): string {
  return `<h2>${escapeHtml(cluster.label)}</h2>
  <h3>Status</h3>
  ${renderStatusCard(cluster.status)}
  <h3>Recent Monitor Runs</h3>
  ${renderRecentRuns(cluster.recentRuns)}
  <h3>Open Alert Issues</h3>
  <p><a href="${escapeHtml(cluster.alertsUrl)}">View on GitHub</a></p>`;
}

export function buildK8sPage(clusters: K8sClusterView[], theme: Theme): string {
  const content = clusters.length === 0
    ? `<p class="idle">No k8s integrations configured.</p>`
    : clusters.map(renderCluster).join("\n<hr>\n");

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${HEAD_META}
  <title>claws — K8s</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
  .k8s-table { border-collapse: collapse; font-size: 0.85rem; width: 100%; }
  .k8s-table th, .k8s-table td { padding: 0.4rem 0.6rem; border: 1px solid var(--border); text-align: left; }
  .k8s-table th { background: var(--bg); }
  </style>
</head>
<body>
  ${buildPageHeader("Kubernetes Integrations", theme)}
  ${THEME_SCRIPT}
  ${content}
</body>
</html>`;
}
