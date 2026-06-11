import { PAGE_CSS, TAILWIND_STYLESHEET, escapeHtml, repoShortName, formatRelativeTime, htmlOpenTag, buildPageHeader, THEME_SCRIPT, ALPINE_SCRIPT } from "./layout.js";
import type { Theme } from "./layout.js";
import type { WorkflowRunRow, WorkflowRunStats } from "../db.js";

export interface RunnersPageData {
  activeRuns: WorkflowRunRow[];
  stats: WorkflowRunStats;
  lastSyncedAt: string | null;
}

export function formatSeconds(s: number): string {
  if (s <= 0) return "—";
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function runUrl(run: WorkflowRunRow): string {
  return `https://github.com/${run.repo}/actions/runs/${run.run_id}`;
}

function statusBadge(status: string): string {
  if (status === "queued") return `<span style="color:var(--warning)">queued</span>`;
  if (status === "in_progress") return `<span class="running">running</span>`;
  return escapeHtml(status);
}

function queueWait(run: WorkflowRunRow): string {
  const created = Date.parse(run.created_at);
  if (isNaN(created)) return "—";
  if (run.run_started_at) {
    const started = Date.parse(run.run_started_at);
    if (!isNaN(started)) return formatSeconds(Math.round((started - created) / 1000));
  }
  // Still queued — show time waiting so far
  return formatSeconds(Math.round((Date.now() - created) / 1000));
}

function runDuration(run: WorkflowRunRow): string {
  if (!run.run_started_at) return "—";
  const started = Date.parse(run.run_started_at);
  if (isNaN(started)) return "—";
  const end = run.status === "in_progress" ? Date.now() : Date.parse(run.updated_at);
  if (isNaN(end)) return "—";
  return formatSeconds(Math.round((end - started) / 1000));
}

export function buildRunnersPage(data: RunnersPageData, theme: Theme): string {
  const { activeRuns, stats, lastSyncedAt } = data;
  const queued = activeRuns.filter(r => r.status === "queued");
  const inProgress = activeRuns.filter(r => r.status === "in_progress");
  const reposWithActive = new Set(activeRuns.map(r => r.repo)).size;

  let summaryHtml = `<div class="stat-grid">`;
  summaryHtml += `<div class="stat-card">
    <div class="stat-number text-warning">${queued.length}</div>
    <div class="stat-label">Queued</div></div>`;
  summaryHtml += `<div class="stat-card">
    <div class="stat-number text-success">${inProgress.length}</div>
    <div class="stat-label">In Progress</div></div>`;
  summaryHtml += `<div class="stat-card">
    <div class="stat-number text-accent">${reposWithActive}</div>
    <div class="stat-label">Active Repos</div></div>`;
  summaryHtml += `</div>`;

  // Active runs table
  let activeHtml = `<h2>Active Runs</h2>`;
  if (activeRuns.length === 0) {
    activeHtml += `<p class="queue-empty">All clear — no queued or in-progress runs</p>`;
  } else {
    activeHtml += `<div class="table-scroll"><table><thead><tr><th>Repo</th><th>Workflow</th><th>Branch</th><th>Status</th><th>Queue Wait</th><th>Duration</th><th>Created</th><th>Actions</th></tr></thead><tbody>`;
    // Sort: longest-waiting first (queued before in_progress, then by created_at ASC)
    const sorted = [...activeRuns].sort((a, b) => {
      if (a.status === "queued" && b.status !== "queued") return -1;
      if (a.status !== "queued" && b.status === "queued") return 1;
      return Date.parse(a.created_at) - Date.parse(b.created_at);
    });
    for (const run of sorted) {
      const cancelBtn = (run.status === "queued" || run.status === "in_progress")
        ? `<button class="cancel-btn" data-repo="${escapeHtml(run.repo)}" data-run-id="${run.run_id}" @click="cancelRun($event)">Cancel</button>`
        : "—";
      activeHtml += `<tr>
        <td>${escapeHtml(repoShortName(run.repo))}</td>
        <td><a href="${runUrl(run)}" target="_blank" rel="noopener">${escapeHtml(run.workflow_name)}</a></td>
        <td>${run.head_branch ? escapeHtml(run.head_branch) : "—"}</td>
        <td>${statusBadge(run.status)}</td>
        <td>${queueWait(run)}</td>
        <td>${runDuration(run)}</td>
        <td style="white-space:nowrap">${formatRelativeTime(run.created_at)}</td>
        <td>${cancelBtn}</td>
      </tr>`;
    }
    activeHtml += `</tbody></table></div>`;
  }

  // Repo breakdown
  let repoHtml = `<h2>By Repository (7 days)</h2>`;
  if (stats.repoStats.length === 0) {
    repoHtml += `<p class="queue-empty">No workflow run data</p>`;
  } else {
    repoHtml += `<div class="table-scroll"><table><thead><tr><th>Repository</th><th>Total</th><th>Queued</th><th>Running</th><th>Avg Wait</th><th>Avg Duration</th><th>Total Duration</th></tr></thead><tbody>`;
    for (const r of stats.repoStats) {
      repoHtml += `<tr>
        <td>${escapeHtml(repoShortName(r.repo))}</td>
        <td>${r.total}</td>
        <td>${r.queued > 0 ? `<span style="color:var(--warning)">${r.queued}</span>` : "0"}</td>
        <td>${r.inProgress > 0 ? `<span style="color:var(--success)">${r.inProgress}</span>` : "0"}</td>
        <td>${formatSeconds(r.avgQueueWaitS)}</td>
        <td>${formatSeconds(r.avgRunDurationS)}</td>
        <td>${formatSeconds(r.totalDurationS)}</td>
      </tr>`;
    }
    repoHtml += `</tbody></table></div>`;
  }

  // Workflow breakdown
  let workflowHtml = `<h2>By Workflow (7 days)</h2>`;
  if (stats.workflowStats.length === 0) {
    workflowHtml += `<p class="queue-empty">No workflow run data</p>`;
  } else {
    workflowHtml += `<div class="table-scroll"><table><thead><tr><th>Repository</th><th>Workflow</th><th>Total</th><th>Queued</th><th>Running</th><th>Avg Wait</th><th>Avg Duration</th><th>Total Duration</th></tr></thead><tbody>`;
    for (const w of stats.workflowStats) {
      workflowHtml += `<tr>
        <td>${escapeHtml(repoShortName(w.repo))}</td>
        <td>${escapeHtml(w.workflowName)}</td>
        <td>${w.total}</td>
        <td>${w.queued > 0 ? `<span style="color:var(--warning)">${w.queued}</span>` : "0"}</td>
        <td>${w.inProgress > 0 ? `<span style="color:var(--success)">${w.inProgress}</span>` : "0"}</td>
        <td>${formatSeconds(w.avgQueueWaitS)}</td>
        <td>${formatSeconds(w.avgRunDurationS)}</td>
        <td>${formatSeconds(w.totalDurationS)}</td>
      </tr>`;
    }
    workflowHtml += `</tbody></table></div>`;
  }

  const syncInfo = lastSyncedAt
    ? `<p class="refresh-note">Last synced ${formatRelativeTime(lastSyncedAt)} · Auto-refreshes every 30s</p>`
    : `<p class="refresh-note">Not yet synced · Auto-refreshes every 30s</p>`;

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>Runners — Claws</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}</style>
  ${ALPINE_SCRIPT}
</head>
<body x-data="runnersPage()" x-init="restoreCancelledState()">
  ${buildPageHeader("Runners", theme)}
  ${THEME_SCRIPT}
  ${summaryHtml}
  ${activeHtml}
  ${repoHtml}
  ${workflowHtml}
  ${syncInfo}
  <script>
  function runnersPage() {
    return {
      restoreCancelledState() {
        const cancelled = JSON.parse(sessionStorage.getItem('cancelledRuns') || '[]');
        const stillCancelled = [];
        cancelled.forEach(runId => {
          const btn = document.querySelector(\`button[data-run-id="\${runId}"]\`);
          if (btn) {
            btn.disabled = true;
            btn.textContent = 'Cancelled';
            btn.style.color = 'var(--text-secondary)';
            stillCancelled.push(runId);
          }
        });
        if (stillCancelled.length !== cancelled.length) {
          sessionStorage.setItem('cancelledRuns', JSON.stringify(stillCancelled));
        }
      },
      async cancelRun(ev) {
        const btn = ev.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Cancelling...';
        const repo = btn.dataset.repo;
        const runId = btn.dataset.runId;

        try {
          const resp = await fetch('/runners/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repo, runId })
          });

          if (resp.status === 400) {
            btn.textContent = 'Completed';
            btn.style.color = 'var(--text-secondary)';
            btn.disabled = true;
            const row = btn.closest('tr');
            if (row) {
              const statusCell = row.children[3];
              if (statusCell) statusCell.innerHTML = '<span style="color:var(--text-secondary)">completed</span>';
            }
            return;
          }

          if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || 'Failed to cancel');
          }

          btn.textContent = 'Cancelled';
          btn.style.color = 'var(--text-secondary)';

          const cancelled = JSON.parse(sessionStorage.getItem('cancelledRuns') || '[]');
          if (!cancelled.includes(runId)) {
            cancelled.push(runId);
            sessionStorage.setItem('cancelledRuns', JSON.stringify(cancelled));
          }
        } catch (err) {
          alert('Failed to cancel: ' + err.message);
          btn.textContent = 'Failed';
          btn.style.color = 'var(--danger)';
          setTimeout(() => {
            btn.disabled = false;
            btn.textContent = 'Cancel';
            btn.style.color = '';
          }, 3000);
        }
      },
    };
  }
  </script>
</body>
</html>`;
}
