import type { Theme } from "./layout.js";
import { PAGE_CSS, escapeHtml, formatDuration, htmlOpenTag, buildNav, THEME_SCRIPT } from "./layout.js";
import type { JobRun, JobLog, Task } from "../db.js";

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
          <td>${escapeHtml(r.started_at)}</td>
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
  <style>${PAGE_CSS}</style>
</head>
<body>
  <h1>claws</h1>
  ${buildNav(theme)}
  ${THEME_SCRIPT}
  <h2>Job Runs</h2>
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
  <table>
    <thead><tr><th>Job</th><th>Status</th><th>Started</th><th>Duration</th><th>Items</th></tr></thead>
    <tbody>
      ${rows || '<tr><td colspan="5" style="color:#8b949e">No runs recorded yet</td></tr>'}
    </tbody>
  </table>
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
        return `<div class="log-line ${cls}" data-level="${escapeHtml(entry.level)}">[${escapeHtml(entry.logged_at)}] [${escapeHtml(entry.level.toUpperCase())}] ${escapeHtml(entry.message)}</div>`;
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
        <span style="color:var(--text-secondary);margin-left:0.5rem;font-size:0.85rem">${escapeHtml(run.started_at)}</span>
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
  <style>${PAGE_CSS}</style>
</head>
<body>
  <h1>claws</h1>
  ${buildNav(theme)}
  ${THEME_SCRIPT}
  <h2>${escapeHtml(shortRepo)}#${itemNumber}</h2>
  <div style="margin-bottom:1rem;font-size:0.85rem">
    <a href="https://github.com/${encodeURI(repo)}/issues/${itemNumber}">View on GitHub</a>
    | ${runs.length} run${runs.length !== 1 ? "s" : ""}
  </div>
  ${emptyState}
  ${runs.length > 0 ? `
  <div class="filter-bar" id="level-filter">
    <a href="#" class="active" data-level="all">All</a>
    <a href="#" data-level="debug">Debug</a>
    <a href="#" data-level="info">Info</a>
    <a href="#" data-level="warn">Warn</a>
    <a href="#" data-level="error">Error</a>
  </div>` : ""}
  ${runSections}
  <script>
    (function() {
      var activeLevel = 'all';
      var filterBar = document.getElementById('level-filter');
      if (!filterBar) return;

      filterBar.addEventListener('click', function(e) {
        e.preventDefault();
        var target = e.target;
        if (target.tagName !== 'A') return;
        activeLevel = target.getAttribute('data-level');
        var links = filterBar.querySelectorAll('a');
        for (var i = 0; i < links.length; i++) {
          links[i].className = links[i].getAttribute('data-level') === activeLevel ? 'active' : '';
        }
        var lines = document.querySelectorAll('.log-line');
        for (var j = 0; j < lines.length; j++) {
          var level = lines[j].getAttribute('data-level');
          if (activeLevel === 'all' || level === activeLevel) {
            lines[j].classList.remove('log-hidden');
          } else {
            lines[j].classList.add('log-hidden');
          }
        }
      });
    })();
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
      return `<div class="log-line ${cls}" data-level="${escapeHtml(entry.level)}">[${escapeHtml(entry.logged_at)}] [${escapeHtml(entry.level.toUpperCase())}] ${escapeHtml(entry.message)}</div>`;
    })
    .join("\n");

  const isRunning = run.status === "running";

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>claws — ${escapeHtml(run.job_name)} run</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <h1>claws</h1>
  ${buildNav(theme)}
  ${THEME_SCRIPT}
  <h2>${escapeHtml(run.job_name)}</h2>
  <dl class="meta">
    <dt>Run ID</dt>
    <dd>${escapeHtml(run.run_id)}</dd>
    <dt>Status</dt>
    <dd id="run-status" class="status-${run.status}">${escapeHtml(run.status)}</dd>
    <dt>Started</dt>
    <dd>${escapeHtml(run.started_at)}</dd>
    <dt>Completed</dt>
    <dd id="run-completed">${run.completed_at ? escapeHtml(run.completed_at) : "—"}</dd>
    <dt>Duration</dt>
    <dd id="run-duration">${formatDuration(run.started_at, run.completed_at)}</dd>
  </dl>
  ${tasks && tasks.length > 0 ? `
  <h2>Work Items</h2>
  <div class="work-items">
    ${tasks.map((t) => {
      const shortRepo = t.repo.includes("/") ? t.repo.split("/").pop()! : t.repo;
      return `<a href="/logs/issue?repo=${encodeURIComponent(t.repo)}&number=${t.item_number}" class="work-item-badge status-${t.status}">${escapeHtml(shortRepo)}#${t.item_number} <span class="work-item-status">(${escapeHtml(t.status)})</span></a>`;
    }).join("\n    ")}
  </div>` : ""}
  <h2>Log Output</h2>
  <div class="filter-bar" id="level-filter">
    <a href="#" class="active" data-level="all">All</a>
    <a href="#" data-level="debug">Debug</a>
    <a href="#" data-level="info">Info</a>
    <a href="#" data-level="warn">Warn</a>
    <a href="#" data-level="error">Error</a>
  </div>
  <div class="log-output" id="log-output">
    ${logLines || '<div class="log-line log-info">No log entries</div>'}
  </div>
  <script>
    (function() {
      var activeLevel = 'all';
      var filterBar = document.getElementById('level-filter');
      var logOutput = document.getElementById('log-output');

      filterBar.addEventListener('click', function(e) {
        e.preventDefault();
        var target = e.target;
        if (target.tagName !== 'A') return;
        activeLevel = target.getAttribute('data-level');
        var links = filterBar.querySelectorAll('a');
        for (var i = 0; i < links.length; i++) {
          links[i].className = links[i].getAttribute('data-level') === activeLevel ? 'active' : '';
        }
        applyFilter();
      });

      function applyFilter() {
        var lines = logOutput.querySelectorAll('.log-line');
        for (var i = 0; i < lines.length; i++) {
          var level = lines[i].getAttribute('data-level');
          if (activeLevel === 'all' || level === activeLevel) {
            lines[i].classList.remove('log-hidden');
          } else {
            lines[i].classList.add('log-hidden');
          }
        }
      }

      function escapeHtml(s) {
        var d = document.createElement('div');
        d.appendChild(document.createTextNode(s));
        return d.innerHTML;
      }

      function levelClass(level) {
        if (level === 'error') return 'log-error';
        if (level === 'warn') return 'log-warn';
        if (level === 'debug') return 'log-debug';
        return 'log-info';
      }

      ${isRunning ? `
      var lastId = ${lastLogId};
      var runId = '${escapeHtml(run.run_id).replace(/'/g, "\\'")}';
      var polling = true;

      function isAtBottom() {
        return logOutput.scrollTop + logOutput.clientHeight >= logOutput.scrollHeight - 30;
      }

      function poll() {
        if (!polling) return;
        fetch('/logs/' + encodeURIComponent(runId) + '/tail?after=' + lastId)
          .then(function(r) { return r.json(); })
          .then(function(data) {
            var wasAtBottom = isAtBottom();
            for (var i = 0; i < data.logs.length; i++) {
              var entry = data.logs[i];
              var div = document.createElement('div');
              div.className = 'log-line ' + levelClass(entry.level);
              div.setAttribute('data-level', entry.level);
              div.innerHTML = '[' + escapeHtml(entry.logged_at) + '] [' + escapeHtml(entry.level.toUpperCase()) + '] ' + escapeHtml(entry.message);
              if (activeLevel !== 'all' && entry.level !== activeLevel) {
                div.classList.add('log-hidden');
              }
              logOutput.appendChild(div);
              lastId = entry.id;
            }
            if (wasAtBottom && data.logs.length > 0) {
              logOutput.scrollTop = logOutput.scrollHeight;
            }
            if (data.status !== 'running') {
              polling = false;
              var statusEl = document.getElementById('run-status');
              statusEl.textContent = data.status;
              statusEl.className = 'status-' + data.status;
              if (data.completed_at) {
                document.getElementById('run-completed').textContent = data.completed_at;
              }
            }
          })
          .catch(function() {});
      }

      setInterval(poll, 2000);
      ` : ""}
    })();
  </script>
</body>
</html>`;
}
