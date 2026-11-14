import { hasItemRef, shortIssueRef, type IssueRef } from "../issue-id.js";
import type { NavCounts, Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, repoAvatar, repoShortName, itemLogsUrl, formatRelativeTime, formatCountdown, htmlOpenTag, buildPageHeader, THEME_SCRIPT, ALPINE_SCRIPT, refTitleAttr, staleControllerNote } from "./layout.js";
import { msUntilHour } from "../scheduler.js";
import { isSubScannerName, jobAliases } from "../jobs/scanner-dispatcher.js";

/** A job with a per-repo toggle column on /jobs: its name and the scheduler's `repoToggle` reason. */
export interface RepoToggleJob {
  name: string;
  reason: string;
}

/** True when `list` names `job` or one of its former names (aliases live in scanner-dispatcher.ts). */
export function listsJob(list: readonly string[], job: string): boolean {
  return list.includes(job) || jobAliases(job).some((alias) => list.includes(alias));
}

type Source = "repo" | "host";

function sourceBadge(source: Source): string {
  const title = source === "repo"
    ? "Disabled by claws.json in the repo"
    : "Disabled by the host override (disabledJobsByRepo)";
  return `<span class="src-badge src-${source}" title="${title}">${source}</span>`;
}

/** Sub-scanner names (or aliases) either list names, each with where it came from. */
function subScannerExclusions(host: readonly string[], locked: readonly string[]): Array<{ name: string; source: Source }> {
  const out: Array<{ name: string; source: Source }> = [];
  for (const name of locked) if (isSubScannerName(name)) out.push({ name, source: "repo" });
  for (const name of host) if (isSubScannerName(name) && !locked.includes(name)) out.push({ name, source: "host" });
  return out;
}

function buildToggleCell(repoFullName: string, job: string, host: readonly string[], locked: readonly string[]): string {
  let partial = "";
  if (job === "scanner-dispatcher") {
    const subs = subScannerExclusions(host, locked);
    if (subs.length > 0) {
      const names = subs.map((s) => `${s.name} (${s.source})`).join(", ");
      partial = ` <details class="partial-marker"><summary>◐ ${subs.length} sub-scanner${subs.length === 1 ? "" : "s"}</summary>${escapeHtml(names)}</details>`;
    }
  }
  // A locked cell carries no `name`, so it submits nothing and the POST
  // writer never mirrors claws.json into disabledJobsByRepo.
  if (listsJob(locked, job)) {
    return `<td><input type="checkbox" disabled aria-label="${escapeHtml(job)} disabled by claws.json"> ${sourceBadge("repo")}${partial}</td>`;
  }
  const fieldName = escapeHtml(`${repoFullName}::${job}`);
  if (listsJob(host, job)) {
    return `<td><input type="checkbox" name="${fieldName}" value="true"> ${sourceBadge("host")}${partial}</td>`;
  }
  return `<td><input type="checkbox" name="${fieldName}" value="true" checked>${partial}</td>`;
}

/** Disabled names with no matrix column: neither a toggleable job nor a sub-scanner. */
function buildOtherCell(toggleable: ReadonlySet<string>, host: readonly string[], locked: readonly string[]): string {
  const isOther = (name: string) => !toggleable.has(name) && !isSubScannerName(name);
  const items = [
    ...locked.filter(isOther).map((name) => ({ name, source: "repo" as const })),
    ...host.filter((name) => isOther(name) && !locked.includes(name)).map((name) => ({ name, source: "host" as const })),
  ];
  if (items.length === 0) return `<td class="other-cell">\u2014</td>`;
  return `<td class="other-cell">${items.map((i) => `<span class="other-job"><code>${escapeHtml(i.name)}</code> ${sourceBadge(i.source)}</span>`).join(" ")}</td>`;
}

interface RunningTaskInfo {
  jobName: string;
  repo: string;
  itemNumber: IssueRef;
  startedAt: string;
}

/** Live scheduler state rendered in the "Job status" table on /jobs. */
export interface JobStatusInput {
  jobs: Record<string, boolean>;
  runningTasks: RunningTaskInfo[];
  latestRuns: Map<string, { runId: string; status: string; startedAt: string; completedAt: string | null }>;
  paused?: Set<string>;
  scheduleInfo?: Map<string, { intervalMs: number; scheduledHour?: number }>;
  /** Set while the controller's heartbeat is stale: the job states are its last-known ones. */
  staleController?: { lastSeenAt: string | null };
}

function buildJobRows(status: JobStatusInput): string {
  const taskByJob = new Map<string, RunningTaskInfo>();
  for (const t of status.runningTasks) {
    taskByJob.set(t.jobName, t);
  }
  const pausedSet = status.paused ?? new Set<string>();
  const schedules = status.scheduleInfo ?? new Map<string, { intervalMs: number; scheduledHour?: number }>();

  return Object.entries(status.jobs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, running]) => {
        const task = taskByJob.get(name);
        const detail = task
          ? hasItemRef(task.itemNumber)
            ? `${escapeHtml(repoShortName(task.repo))} <a href="${itemLogsUrl(task.repo, task.itemNumber)}"${refTitleAttr(task.itemNumber)}>#${escapeHtml(shortIssueRef(task.itemNumber))}</a>`
            : escapeHtml(repoShortName(task.repo))
          : "";
        const latest = status.latestRuns.get(name);
        const logsCell = latest
          ? `<a href="/logs/${encodeURIComponent(latest.runId)}"${latest.status === "running" ? ' class="running"' : ""}>${latest.status === "running" ? "Live" : "View"}</a>`
          : "";
        const isPaused = pausedSet.has(name);
        const statusClass = running ? "running" : isPaused ? "paused" : "idle";
        const statusText = running ? "Running" : isPaused ? "Paused" : "Idle";

        // Last Run column
        let lastRunText = "\u2014";
        if (latest?.completedAt) {
          lastRunText = formatRelativeTime(latest.completedAt + "Z");
        } else if (latest?.startedAt) {
          lastRunText = formatRelativeTime(latest.startedAt + "Z");
        }

        // Next Run column
        let nextRunText = "\u2014";
        if (!isPaused) {
          const sched = schedules.get(name);
          if (!sched) {
            // Manual-only job: no timer, so no countdown to show.
            nextRunText = "manual";
          } else if (sched.scheduledHour !== undefined) {
            nextRunText = formatCountdown(msUntilHour(sched.scheduledHour));
          } else if (latest?.startedAt) {
            const nextMs = new Date(latest.startedAt + "Z").getTime() + sched.intervalMs - Date.now();
            nextRunText = formatCountdown(Math.max(0, nextMs));
          } else {
            nextRunText = formatCountdown(sched.intervalMs);
          }
        }

        return `<tr>
          <td class="cell-title" data-label="Job">${escapeHtml(name)}</td>
          <!-- The status class draws its own ::before dot; keep it on this inner span, not the
               td, or it collides with .data-cards-wide td::before's card-label content on
               phone/tablet and produces a stretched gray blob (see docs/DESIGN.md). -->
          <td data-label="Status"><span id="job-${name}" class="${statusClass}">${statusText}</span></td>
          <td data-label="Last Run" id="job-lastrun-${name}">${lastRunText}</td>
          <td data-label="Next Run" id="job-nextrun-${name}" class="hide-sm">${nextRunText}</td>
          <td data-label="Current Task" id="job-detail-${name}">${detail}</td>
          <td data-label="Logs" id="job-logs-${name}" class="hide-sm">${logsCell}</td>
          <td data-label="Actions" class="cell-actions"><button class="trigger-btn" @click="trigger('${name}', $event)">Run</button> <button class="trigger-btn${isPaused ? " paused-btn" : ""}" id="pause-${name}" @click="togglePause('${name}', $event)">${isPaused ? "Resume" : "Pause"}</button></td>
        </tr>`;
      },
    )
    .join("\n");
}

export function buildJobsMatrixPage(
  repos: Array<{ owner: string; name: string; fullName: string }>,
  disabledJobsByRepo: Readonly<Record<string, readonly string[]>>,
  saved: boolean,
  theme: Theme,
  // Jobs a repo disabled in its own claws.json (#2885). Trailing and optional
  // so existing call sites keep compiling.
  lockedJobsByRepo: Readonly<Record<string, readonly string[]>> = {},
  jobStatus: JobStatusInput = { jobs: {}, runningTasks: [], latestRuns: new Map() },
  navCounts?: NavCounts,
  // Jobs that get a per-repo column, from the scheduler's `repoToggle`. Empty
  // until the controller publishes its job list; the matrix is then withheld.
  toggleableJobs: ReadonlyArray<RepoToggleJob> = [],
): string {
  const columns = [...toggleableJobs].sort((a, b) => a.name.localeCompare(b.name));
  const toggleable = new Set(columns.map((j) => j.name));
  return `<!DOCTYPE html>
${htmlOpenTag(theme, "wide")}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${HEAD_META}
  <title>claws — jobs</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
  .field-note { font-size: 0.75rem; color: var(--text-subtle); }
  .matrix-table { border-collapse: collapse; font-size: 0.85rem; }
  .matrix-table th, .matrix-table td { padding: 0.4rem 0.6rem; border: 1px solid var(--border); text-align: center; }
  .matrix-table th { position: sticky; top: 0; background: var(--bg); }
  .matrix-table td:first-child, .matrix-table th:first-child { text-align: left; position: sticky; left: 0; background: var(--bg); z-index: 1; }
  .matrix-table th:first-child { z-index: 2; }
  .matrix-wrap { overflow: auto; max-width: 100%; }
  .matrix-table th.job-col { white-space: nowrap; font-weight: 600; }
  .matrix-table td { height: 44px; }
  @media (min-width: 768px) { .matrix-table td { height: auto; } }
  .matrix-table td.other-cell { text-align: left; white-space: nowrap; }
  .src-badge { font-size: 0.7rem; padding: 0 0.3rem; border: 1px solid var(--border); border-radius: 4px; color: var(--text-secondary); }
  .partial-marker { font-size: 0.75rem; color: var(--text-secondary); }
  details.partial-marker { display: inline-block; vertical-align: top; }
  details.partial-marker summary { cursor: pointer; white-space: nowrap; }
  .other-job { white-space: nowrap; }
  </style>
  ${ALPINE_SCRIPT}
</head>
<body x-data="jobsPage()" x-init="startPolling()">
  ${buildPageHeader("Jobs", theme, { current: "/jobs", navCounts })}
  ${THEME_SCRIPT}
  <h2>Job status</h2>
  ${jobStatus.staleController ? staleControllerNote(jobStatus.staleController.lastSeenAt) : ""}
  <div class="table-scroll${jobStatus.staleController ? " controller-stale" : ""}">
    <table class="data-cards data-cards-wide">
      <thead><tr><th>Job</th><th>Status</th><th>Last Run</th><th class="hide-sm">Next Run</th><th>Current Task</th><th class="hide-sm">Logs</th><th></th></tr></thead>
      <tbody>
        ${buildJobRows(jobStatus)}
      </tbody>
    </table>
  </div>
  <p class="refresh-note">Live-updating every 10s</p>
  <h2>Per-repo toggles</h2>
  ${saved ? '<div class="banner">Job settings saved.</div>' : ""}
  ${columns.length === 0 ? `<p class="field-note">Per-repo toggles are unavailable until the background controller publishes its job list.</p>` : `<p class="field-note">Uncheck a cell to disable a job for that repo. Changes take effect on the next scheduled run.</p>
  <p class="field-note">A disabled cell says where the disable comes from: <span class="src-badge">repo</span> is the repo's own <code>claws.json</code> and cannot be changed here; <span class="src-badge">host</span> is the host override this form saves. <span class="partial-marker">◐</span> on scanner-dispatcher means the repo's config skips only some sub-scanners (expand the marker to see which).</p>
  <p class="field-note">Only jobs a repo can meaningfully opt out of have a column. Pipeline jobs (dispatchers, syncs, CI fixer and the like) have none — a repo leaves the pipeline with <code>enabled: false</code> in its <code>claws.json</code>. Other disables still in force are listed under Other.</p>
  <form method="POST" action="/jobs">
    <div class="matrix-wrap">
      <table class="matrix-table">
        <thead>
          <tr>
            <th>Repo</th>
            ${columns.map(job => `<th class="job-col" title="${escapeHtml(job.reason)}">${escapeHtml(job.name)}</th>`).join("\n            ")}
            <th class="job-col" title="Other disabled jobs with no per-repo column">Other</th>
          </tr>
        </thead>
        <tbody>
          ${repos.map(repo => {
            const host = disabledJobsByRepo[repo.fullName] ?? [];
            const locked = lockedJobsByRepo[repo.fullName] ?? [];
            return `<tr>
              <td><a href="/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}" title="${escapeHtml(repo.fullName)}">${repoAvatar(repo.fullName)}${escapeHtml(repoShortName(repo.fullName))}</a></td>
              ${columns.map(job => buildToggleCell(repo.fullName, job.name, host, locked)).join("\n              ")}
              ${buildOtherCell(toggleable, host, locked)}
            </tr>`;
          }).join("\n          ")}
        </tbody>
      </table>
    </div>
    <button type="submit" class="save-btn" style="margin-top:1rem">Save</button>
  </form>`}
  <script>
    function jobsPage() {
      return {
        trigger(name, ev) {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.textContent = '...';
          fetch('/trigger/' + encodeURIComponent(name), { method: 'POST' })
            .then(r => r.json())
            .then(data => {
              btn.textContent = data.result === 'started' ? 'Triggered!' : data.result === 'queued' ? 'Queued' : 'Already running';
            })
            .catch(() => { btn.textContent = 'Error'; })
            .finally(() => { setTimeout(() => { btn.textContent = 'Run'; btn.disabled = false; }, 2000); });
        },
        togglePause(name, ev) {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.textContent = '...';
          fetch('/pause/' + encodeURIComponent(name), { method: 'POST' })
            .then(r => r.json())
            .then(data => {
              btn.textContent = data.result === 'paused' ? 'Paused!' : 'Resumed!';
            })
            .catch(() => { btn.textContent = 'Error'; })
            .finally(() => { setTimeout(() => { location.reload(); }, 1000); });
        },
        formatRelativeTime(iso) {
          if (!iso) return '';
          const ms = Date.now() - Date.parse(iso);
          if (ms < 0) return 'just now';
          const secs = Math.floor(ms / 1000);
          if (secs < 60) return secs + 's ago';
          const mins = Math.floor(secs / 60);
          if (mins < 60) return mins + 'm ago';
          const hours = Math.floor(mins / 60);
          if (hours < 24) return hours + 'h ago';
          const days = Math.floor(hours / 24);
          return days + 'd ago';
        },
        formatCountdown(ms) {
          if (ms <= 0) return 'soon';
          const secs = Math.floor(ms / 1000);
          const mins = Math.floor(secs / 60);
          const hours = Math.floor(mins / 60);
          if (hours > 0) return 'in ' + hours + 'h ' + (mins % 60) + 'm';
          if (mins > 0) return 'in ' + mins + 'm';
          return 'in ' + secs + 's';
        },
        repoShortName(fullName) {
          const i = fullName.indexOf('/');
          return i >= 0 ? fullName.slice(i + 1) : fullName;
        },
        hasItemRef(n) {
          return typeof n === 'number' ? n > 0 : String(n).length > 0;
        },
        applyStatus(data) {
          const taskByJob = {};
          if (data.runningTasks) {
            data.runningTasks.forEach(t => { taskByJob[t.jobName] = t; });
          }
          const pausedSet = {};
          if (data.pausedJobs) data.pausedJobs.forEach(n => { pausedSet[n] = true; });
          Object.keys(data.jobs).forEach(name => {
            const el = document.getElementById('job-' + name);
            if (el) {
              if (data.jobs[name]) {
                el.textContent = 'Running'; el.className = 'running';
              } else if (pausedSet[name]) {
                el.textContent = 'Paused'; el.className = 'paused';
              } else {
                el.textContent = 'Idle'; el.className = 'idle';
              }
            }
            const det = document.getElementById('job-detail-' + name);
            if (det) {
              const task = taskByJob[name];
              det.innerHTML = task
                ? (this.hasItemRef(task.itemNumber)
                  ? this.repoShortName(task.repo) + ' <a href="/logs/issue?repo=' + encodeURIComponent(task.repo) + '&number=' + encodeURIComponent(task.itemNumber) + '">#' + task.itemShort + '</a>'
                  : this.repoShortName(task.repo))
                : '';
            }
            const pauseBtn = document.getElementById('pause-' + name);
            if (pauseBtn) {
              pauseBtn.textContent = pausedSet[name] ? 'Resume' : 'Pause';
              pauseBtn.className = pausedSet[name] ? 'trigger-btn paused-btn' : 'trigger-btn';
            }
          });
          if (data.jobSchedules) {
            Object.keys(data.jobSchedules).forEach(name => {
              const info = data.jobSchedules[name];
              const lr = document.getElementById('job-lastrun-' + name);
              if (lr) lr.textContent = info.lastCompletedAt ? this.formatRelativeTime(info.lastCompletedAt) : '\u2014';
              const nr = document.getElementById('job-nextrun-' + name);
              if (nr) nr.textContent = info.manualOnly ? 'manual' : (info.nextRunIn !== null ? this.formatCountdown(info.nextRunIn) : '\u2014');
            });
          }
        },
        refresh() {
          fetch('/api/status')
            .then(r => r.json())
            .then(data => this.applyStatus(data))
            .catch(() => {});
        },
        startPolling() {
          setInterval(() => this.refresh(), 10000);
        },
      };
    }
  </script>
</body>
</html>`;
}
