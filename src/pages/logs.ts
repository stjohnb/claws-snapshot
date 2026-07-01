import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, escapeHtml, formatDuration, htmlOpenTag, buildPageHeader, THEME_SCRIPT, LOCAL_TIME_SCRIPT, ALPINE_SCRIPT, timestampHtml } from "./layout.js";
import type { JobRun, JobLog, Task, TaskOutcome } from "../db.js";

export function renderOutcomeCard(outcome: TaskOutcome, status: string): string {
  const stats: string[] = [];

  if (outcome.failureCategory) {
    stats.push(`<span class="outcome-stat outcome-danger">Failed: ${escapeHtml(outcome.failureCategory)}</span>`);
  }
  if (outcome.commits !== undefined && outcome.commits > 0) {
    stats.push(`<span class="outcome-stat">${outcome.commits} commit${outcome.commits !== 1 ? "s" : ""}</span>`);
  }
  if (outcome.filesChanged !== undefined && outcome.filesChanged > 0) {
    stats.push(`<span class="outcome-stat">${outcome.filesChanged} file${outcome.filesChanged !== 1 ? "s" : ""} changed</span>`);
  }
  if ((outcome.insertions !== undefined && outcome.insertions > 0) || (outcome.deletions !== undefined && outcome.deletions > 0)) {
    stats.push(`<span class="outcome-stat">+${outcome.insertions ?? 0}/\u2212${outcome.deletions ?? 0}</span>`);
  }
  if (outcome.prNumber !== undefined) {
    const action = outcome.prAction ?? "updated";
    stats.push(`<span class="outcome-stat outcome-pr">PR #${escapeHtml(String(outcome.prNumber))} ${escapeHtml(action)}</span>`);
  }
  if (stats.length === 0 && outcome.commits === 0 && !outcome.failureCategory) {
    stats.push(`<span class="outcome-stat">No changes</span>`);
  }

  if (stats.length === 0) return "";

  const failedClass = status === "failed" ? " outcome-failed" : "";
  return `<div class="outcome-card${failedClass}">${stats.join("\n    ")}</div>`;
}

export function parseOutcome(task: Task): TaskOutcome | null {
  if (!task.outcome) return null;
  try {
    return JSON.parse(task.outcome) as TaskOutcome;
  } catch {
    return null;
  }
}

export function buildLogsListPage(runs: JobRun[], jobNames: string[], jobFilter: string | null, theme: Theme, workItemsByRun?: Map<string, Task[]>, search?: string, recentItems?: Array<{ repo: string; item_number: number }>): string {
  const filterLinks = [
    `<a href="/logs"${!jobFilter ? ' class="active"' : ""}>All</a>`,
    ...jobNames.map(
      (name) =>
        `<a href="/logs?job=${encodeURIComponent(name)}"${jobFilter === name ? ' class="active"' : ""}>${escapeHtml(name)}</a>`,
    ),
  ].join("");

  const rows = runs
    .map(
      (r) => {
        const tasks = workItemsByRun?.get(r.run_id) ?? [];
        const itemBadges = tasks.map((t) => {
          const shortRepo = t.repo.includes("/") ? t.repo.split("/").pop()! : t.repo;
          return `<a href="/logs/issue?repo=${encodeURIComponent(t.repo)}&number=${t.item_number}" class="work-item-badge status-${t.status}" title="${escapeHtml(t.repo)}#${t.item_number}">${escapeHtml(shortRepo)}#${t.item_number}</a>`;
        }).join(" ");
        return `<tr>
          <td><a href="/logs/${encodeURIComponent(r.run_id)}">${escapeHtml(r.job_name)}</a></td>
          <td class="status-${r.status}">${escapeHtml(r.status)}</td>
          <td>${timestampHtml(r.started_at)}</td>
          <td>${formatDuration(r.started_at, r.completed_at)}</td>
          <td>${itemBadges || "—"}</td>
        </tr>`;
      },
    )
    .join("\n");

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>claws — logs</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}</style>
</head>
<body>
  ${buildPageHeader("Job Runs", theme)}
  ${THEME_SCRIPT}
  ${LOCAL_TIME_SCRIPT}
  <form method="get" action="/logs" class="search-bar">
    <input type="text" name="search" placeholder="Search by repo or issue number\u2026" value="${escapeHtml(search ?? "")}" />
    <button type="submit">Search</button>
  </form>
  ${recentItems && recentItems.length > 0 ? (() => {
    const seen = new Set<number>();
    const ambiguous = new Set<number>();
    for (const item of recentItems) {
      if (seen.has(item.item_number)) ambiguous.add(item.item_number);
      seen.add(item.item_number);
    }
    const buttons = recentItems.map((item) => {
      const shortRepo = item.repo.includes("/") ? item.repo.split("/").pop()! : item.repo;
      const needsRepo = ambiguous.has(item.item_number);
      const searchVal = needsRepo ? `${shortRepo}#${item.item_number}` : String(item.item_number);
      const label = `${shortRepo}#${item.item_number}`;
      return `<a href="/logs?search=${encodeURIComponent(searchVal)}" class="recent-item-btn" title="${escapeHtml(item.repo)}#${item.item_number}">${escapeHtml(label)}</a>`;
    }).join("\n    ");
    return `<div class="recent-items">
    <span class="recent-label">Recent:</span>
    ${buttons}
  </div>`;
  })() : ""}
  <div class="filter-bar">${filterLinks}</div>
  <div class="table-scroll">
    <table>
      <thead><tr><th>Job</th><th>Status</th><th>Started</th><th>Duration</th><th>Items</th></tr></thead>
      <tbody>
        ${rows || '<tr><td colspan="5" style="color:#8b949e">No runs recorded yet</td></tr>'}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

export function buildIssueLogsPage(
  repo: string,
  itemNumber: number,
  runs: JobRun[],
  logsByRun: Map<string, JobLog[]>,
  workItemsByRun: Map<string, Task[]>,
  theme: Theme,
): string {
  function logLevelClass(level: string): string {
    if (level === "error") return "log-error";
    if (level === "warn") return "log-warn";
    if (level === "debug") return "log-debug";
    return "log-info";
  }

  const shortRepo = repo.includes("/") ? repo.split("/").pop()! : repo;

  const runSections = runs.map((run, i) => {
    const logs = logsByRun.get(run.run_id) ?? [];
    const tasks = workItemsByRun.get(run.run_id) ?? [];
    const isFirst = i === 0;
    const isRunning = run.status === "running";

    const logLines = logs
      .map((entry) => {
        const cls = logLevelClass(entry.level);
        return `<div class="log-line ${cls}" data-level="${escapeHtml(entry.level)}">[<time datetime="${escapeHtml(entry.logged_at)}" class="local-time">${escapeHtml(entry.logged_at)}</time>] [${escapeHtml(entry.level.toUpperCase())}] ${escapeHtml(entry.message)}</div>`;
      })
      .join("\n");

    const otherItems = tasks
      .filter(t => !(t.repo === repo && t.item_number === itemNumber))
      .map(t => {
        const sr = t.repo.includes("/") ? t.repo.split("/").pop()! : t.repo;
        return `<a href="/logs/issue?repo=${encodeURIComponent(t.repo)}&number=${t.item_number}" class="work-item-badge status-${t.status}" title="${escapeHtml(t.repo)}#${t.item_number}">${escapeHtml(sr)}#${t.item_number}</a>`;
      }).join(" ");

    const liveIndicator = isRunning
      ? ` <a href="/logs/${encodeURIComponent(run.run_id)}" class="status-running" style="font-size:0.8rem">(live — click to view)</a>`
      : "";

    return `<details${isFirst ? " open" : ""}>
      <summary style="cursor:pointer;padding:0.5rem 0">
        <strong>${escapeHtml(run.job_name)}</strong>
        <span class="status-${run.status}" style="margin-left:0.5rem">${escapeHtml(run.status)}</span>
        <span style="color:var(--text-secondary);margin-left:0.5rem;font-size:0.85rem">${timestampHtml(run.started_at)}</span>
        <span style="color:var(--text-secondary);margin-left:0.5rem;font-size:0.85rem">${formatDuration(run.started_at, run.completed_at)}</span>
        ${liveIndicator}
      </summary>
      <div style="padding-left:1rem;margin-bottom:1rem">
        <div style="font-size:0.8rem;margin-bottom:0.5rem">
          <a href="/logs/${encodeURIComponent(run.run_id)}">View full run</a>
          ${otherItems ? ` | Also: ${otherItems}` : ""}
        </div>
        <div class="log-output">
          ${logLines || '<div class="log-line log-info">No log entries</div>'}
        </div>
      </div>
    </details>`;
  }).join("\n");

  const emptyState = runs.length === 0
    ? `<p style="color:var(--text-secondary)">No logs found for this issue. <a href="/logs">Back to logs</a></p>`
    : "";

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>claws — ${escapeHtml(shortRepo)}#${itemNumber} logs</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}</style>
  ${ALPINE_SCRIPT}
</head>
<body x-data="logsPage()">
  ${buildPageHeader(null, theme)}
  ${THEME_SCRIPT}
  ${LOCAL_TIME_SCRIPT}
  <h2><a href="/repos/${encodeURIComponent(repo.split("/")[0])}/${encodeURIComponent(repo.split("/")[1] ?? "")}">${escapeHtml(shortRepo)}</a>#${itemNumber}</h2>
  <div style="margin-bottom:1rem;font-size:0.85rem">
    <a href="https://github.com/${escapeHtml(encodeURI(repo))}/issues/${itemNumber}">View on GitHub</a>
    | ${runs.length} run${runs.length !== 1 ? "s" : ""}
  </div>
  ${emptyState}
  ${runs.length > 0 ? `
  <div class="filter-bar" id="level-filter">
    <a href="#" class="active" data-level="all" @click="setLevel('all', $event)">All</a>
    <a href="#" data-level="debug" @click="setLevel('debug', $event)">Debug</a>
    <a href="#" data-level="info" @click="setLevel('info', $event)">Info</a>
    <a href="#" data-level="warn" @click="setLevel('warn', $event)">Warn</a>
    <a href="#" data-level="error" @click="setLevel('error', $event)">Error</a>
  </div>` : ""}
  ${runSections}
  <script>
    function logsPage() {
      return {
        activeLevel: 'all',
        setLevel(level, ev) {
          ev.preventDefault();
          this.activeLevel = level;
          const bar = document.getElementById('level-filter');
          if (!bar) return;
          bar.querySelectorAll('a').forEach(a => {
            a.className = a.getAttribute('data-level') === level ? 'active' : '';
          });
          document.querySelectorAll('.log-line').forEach(line => {
            const l = line.getAttribute('data-level');
            line.classList.toggle('log-hidden', level !== 'all' && l !== level);
          });
        },
      };
    }
  </script>
</body>
</html>`;
}

export function buildLogDetailPage(run: JobRun, logs: JobLog[], theme: Theme, tasks?: Task[]): string {
  function logLevelClass(level: string): string {
    if (level === "error") return "log-error";
    if (level === "warn") return "log-warn";
    if (level === "debug") return "log-debug";
    return "log-info";
  }

  const lastLogId = logs.length > 0 ? logs[logs.length - 1].id : 0;

  const logLines = logs
    .map((entry) => {
      const cls = logLevelClass(entry.level);
      return `<div class="log-line ${cls}" data-level="${escapeHtml(entry.level)}">[<time datetime="${escapeHtml(entry.logged_at)}" class="local-time">${escapeHtml(entry.logged_at)}</time>] [${escapeHtml(entry.level.toUpperCase())}] ${escapeHtml(entry.message)}</div>`;
    })
    .join("\n");

  const isRunning = run.status === "running";

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>claws — ${escapeHtml(run.job_name)} run</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}</style>
  ${ALPINE_SCRIPT}
</head>
<body x-data="logDetail({runId: '${escapeHtml(run.run_id).replace(/'/g, "\\'")}', isRunning: ${isRunning}, initialLastId: ${lastLogId}})" x-init="if (isRunning) startPolling()">
  ${buildPageHeader(null, theme)}
  ${THEME_SCRIPT}
  ${LOCAL_TIME_SCRIPT}
  <h2>${escapeHtml(run.job_name)}</h2>
  <dl class="meta">
    <dt>Run ID</dt>
    <dd>${escapeHtml(run.run_id)}</dd>
    <dt>Status</dt>
    <dd id="run-status" class="status-${run.status}">${escapeHtml(run.status)}</dd>
    <dt>Started</dt>
    <dd>${timestampHtml(run.started_at)}</dd>
    <dt>Completed</dt>
    <dd id="run-completed">${run.completed_at ? timestampHtml(run.completed_at) : "—"}</dd>
    <dt>Duration</dt>
    <dd id="run-duration">${formatDuration(run.started_at, run.completed_at)}</dd>
  </dl>
  ${isRunning ? `
  <div id="cancel-container" style="margin-bottom:1rem">
    <button @click="cancelRun()" :disabled="cancelling" class="btn-danger">
      <span x-text="cancelling ? 'Cancelling…' : 'Cancel Job'"></span>
    </button>
  </div>` : ""}
  <div id="outcome-container">
  ${(() => {
    if (!tasks || tasks.length === 0) return "";
    const outcomeCards = tasks
      .map((t) => {
        const outcome = parseOutcome(t);
        return outcome ? renderOutcomeCard(outcome, t.status) : "";
      })
      .filter(Boolean);
    // If there's exactly one task with outcome, render it as a standalone card
    // If multiple, render them inline with their work item badges below
    if (outcomeCards.length === 1) return outcomeCards[0];
    return "";
  })()}
  </div>
  ${tasks && tasks.length > 0 ? `
  <h2>Work Items</h2>
  <div class="work-items">
    ${tasks.map((t) => {
      const shortRepo = t.repo.includes("/") ? t.repo.split("/").pop()! : t.repo;
      const outcome = parseOutcome(t);
      const outcomeHtml = outcome && tasks.length > 1 ? `\n    ${renderOutcomeCard(outcome, t.status)}` : "";
      return `<a href="/logs/issue?repo=${encodeURIComponent(t.repo)}&number=${t.item_number}" class="work-item-badge status-${t.status}">${escapeHtml(shortRepo)}#${t.item_number} <span class="work-item-status">(${escapeHtml(t.status)})</span></a>${outcomeHtml}`;
    }).join("\n    ")}
  </div>` : ""}
  <h2>Log Output</h2>
  <div class="filter-bar" id="level-filter">
    <a href="#" class="active" data-level="all" @click="setLevel('all', $event)">All</a>
    <a href="#" data-level="debug" @click="setLevel('debug', $event)">Debug</a>
    <a href="#" data-level="info" @click="setLevel('info', $event)">Info</a>
    <a href="#" data-level="warn" @click="setLevel('warn', $event)">Warn</a>
    <a href="#" data-level="error" @click="setLevel('error', $event)">Error</a>
  </div>
  <div class="log-output" id="log-output">
    ${logLines || '<div class="log-line log-info">No log entries</div>'}
  </div>
  <script>
    function logDetail(opts) {
      return {
        runId: opts.runId,
        isRunning: opts.isRunning,
        lastId: opts.initialLastId,
        activeLevel: 'all',
        polling: false,
        cancelling: false,
        setLevel(level, ev) {
          ev.preventDefault();
          this.activeLevel = level;
          const bar = document.getElementById('level-filter');
          if (!bar) return;
          bar.querySelectorAll('a').forEach(a => {
            a.className = a.getAttribute('data-level') === level ? 'active' : '';
          });
          this.applyFilter();
        },
        applyFilter() {
          const logOutput = document.getElementById('log-output');
          if (!logOutput) return;
          logOutput.querySelectorAll('.log-line').forEach(line => {
            const l = line.getAttribute('data-level');
            line.classList.toggle('log-hidden', this.activeLevel !== 'all' && l !== this.activeLevel);
          });
        },
        escapeHtml(s) {
          const d = document.createElement('div');
          d.appendChild(document.createTextNode(s));
          return d.innerHTML;
        },
        levelClass(level) {
          if (level === 'error') return 'log-error';
          if (level === 'warn') return 'log-warn';
          if (level === 'debug') return 'log-debug';
          return 'log-info';
        },
        localizeTs(ts) {
          if (!ts) return ts;
          try {
            const iso = (!ts.endsWith('Z') && !/[+\-]\d{2}:\d{2}$/.test(ts)) ? ts + 'Z' : ts;
            return new Date(iso).toLocaleString();
          } catch(e) { return ts; }
        },
        isAtBottom() {
          const logOutput = document.getElementById('log-output');
          return logOutput.scrollTop + logOutput.clientHeight >= logOutput.scrollHeight - 30;
        },
        startPolling() {
          this.polling = true;
          setInterval(() => this.poll(), 2000);
        },
        async cancelRun() {
          if (this.cancelling) return;
          this.cancelling = true;
          try {
            const r = await fetch('/logs/' + encodeURIComponent(this.runId) + '/cancel', { method: 'POST' });
            if (!r.ok) throw new Error('Server returned ' + r.status);
            const data = await r.json();
            if (data.result === 'cancelled' || data.result === 'not-running') {
              this.polling = false;
              this.isRunning = false;
              const statusEl = document.getElementById('run-status');
              if (statusEl) { statusEl.textContent = 'cancelled'; statusEl.className = 'status-cancelled'; }
              const cancelContainer = document.getElementById('cancel-container');
              if (cancelContainer) cancelContainer.remove();
            }
          } catch(e) {
            alert('Cancel request failed. Please try again.');
          }
          this.cancelling = false;
        },
        async poll() {
          if (!this.polling) return;
          try {
            const r = await fetch('/logs/' + encodeURIComponent(this.runId) + '/tail?after=' + this.lastId);
            const data = await r.json();
            const logOutput = document.getElementById('log-output');
            const wasAtBottom = this.isAtBottom();
            for (let i = 0; i < data.logs.length; i++) {
              const entry = data.logs[i];
              const div = document.createElement('div');
              div.className = 'log-line ' + this.levelClass(entry.level);
              div.setAttribute('data-level', entry.level);
              const rawTs = entry.logged_at || '';
              const localTs = this.localizeTs(rawTs) || rawTs;
              div.innerHTML = '[' + this.escapeHtml(localTs) + '] [' + this.escapeHtml(entry.level.toUpperCase()) + '] ' + this.escapeHtml(entry.message);
              if (this.activeLevel !== 'all' && entry.level !== this.activeLevel) {
                div.classList.add('log-hidden');
              }
              logOutput.appendChild(div);
              this.lastId = entry.id;
            }
            if (wasAtBottom && data.logs.length > 0) {
              logOutput.scrollTop = logOutput.scrollHeight;
            }
            if (data.status !== 'running') {
              this.polling = false;
              const statusEl = document.getElementById('run-status');
              statusEl.textContent = data.status;
              statusEl.className = 'status-' + data.status;
              if (data.completed_at) {
                const completedDisplay = this.localizeTs(data.completed_at) || data.completed_at;
                document.getElementById('run-completed').textContent = completedDisplay;
              }
              if (data.outcomeCards && data.outcomeCards.length > 0) {
                const isMultiTask = (data.taskCount || 0) > 1;
                for (let oi = 0; oi < data.outcomeCards.length; oi++) {
                  const oc = data.outcomeCards[oi];
                  if (isMultiTask && oc.repo && oc.item_number !== null && oc.item_number !== undefined) {
                    const badges = document.querySelectorAll('.work-item-badge');
                    for (let bi = 0; bi < badges.length; bi++) {
                      const href = badges[bi].getAttribute('href') || '';
                      const numberParam = 'number=' + oc.item_number;
                      if (href.indexOf('repo=' + encodeURIComponent(oc.repo)) !== -1 && (href.indexOf(numberParam + '&') !== -1 || href.endsWith(numberParam))) {
                        badges[bi].insertAdjacentHTML('afterend', oc.html);
                        break;
                      }
                    }
                  } else {
                    const container = document.getElementById('outcome-container');
                    if (container) container.insertAdjacentHTML('beforeend', oc.html);
                  }
                }
              }
            }
          } catch(e) {}
        },
      };
    }
  </script>
</body>
</html>`;
}
