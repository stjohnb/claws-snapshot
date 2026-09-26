import { hasItemRef, shortIssueRef, type IssueRef } from "../issue-id.js";
import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, repoShortName, itemLogsUrl, formatUptime, formatRelativeTime, htmlOpenTag, buildPageHeader, THEME_SCRIPT, LOCAL_TIME_SCRIPT, ALPINE_SCRIPT, timestampHtml, slackLabel, slackBotLabel, whatsappLabel, emailLabel, anthropicLabel, openaiLabel, opencodeLabel, homeAssistantLabel, githubStatusLabel, refTitleAttr, refArg } from "./layout.js";
import type { AiProviderStatus } from "./layout.js";
import type { GitHubStatusSnapshot } from "../github-status.js";

interface RunningTaskInfo {
  jobName: string;
  repo: string;
  itemNumber: IssueRef;
  startedAt: string;
}

/** One row of the agent queue table on /status — a `work_queue` row joined
 *  against its issue/PR title and current Priority-label state. */
export interface QueueEntryView {
  id: number;
  position: number;
  kind: string;
  repo: string;
  itemNumber: IssueRef;
  itemShort: string;
  status: string;
  priority: boolean;
  title: string;
  hasPriorityLabel: boolean;
}

function buildQueueEntryRow(e: QueueEntryView): string {
  const jobCell = e.status === "running" ? `<span class="running">${escapeHtml(e.kind)}</span>` : escapeHtml(e.kind);
  const priorityBadge = e.hasPriorityLabel ? `<span class="queue-priority-badge" title="Priority">Priority</span> ` : "";
  const actionBtn = e.hasPriorityLabel
    ? `<button class="refined-btn prio-btn deprio" data-mode="deprio" @click="togglePriorityLabel('${escapeHtml(e.repo)}',${refArg(e.itemNumber)}, $event)">Deprioritise</button>`
    : `<button class="refined-btn prio-btn" data-mode="prio" @click="togglePriorityLabel('${escapeHtml(e.repo)}',${refArg(e.itemNumber)}, $event)">Prioritise</button>`;
  return `<tr>
      <td data-label="Position">${e.position}</td>
      <td data-label="Job">${jobCell}</td>
      <td data-label="Repo">${escapeHtml(repoShortName(e.repo))}</td>
      <td class="cell-title" data-label="Issue"><a href="${itemLogsUrl(e.repo, e.itemNumber)}"${refTitleAttr(e.itemNumber)}>#${escapeHtml(e.itemShort)}</a></td>
      <td class="cell-title" data-label="Title">${priorityBadge}${escapeHtml(e.title)}</td>
      <td class="cell-actions" data-label="Action">${actionBtn}</td>
    </tr>`;
}

function buildQueueEntriesRows(entries: QueueEntryView[]): string {
  if (entries.length === 0) {
    return `<tr><td colspan="6" class="queue-empty">Queue is empty</td></tr>`;
  }
  return entries.map(buildQueueEntryRow).join("\n");
}

export function buildSparkline(snapshots: Array<{ totalItems: number; recordedAt: string }>): string {
  if (snapshots.length === 0) return `<span class="idle">No data</span>`;

  const values = snapshots.map((s) => s.totalItems);
  // Use reduce instead of Math.max(...values) to avoid stack overflow on very large arrays.
  const max = values.reduce((a, b) => (b > a ? b : a), values[0]);
  const min = values.reduce((a, b) => (b < a ? b : a), values[0]);
  const w = 150;
  const h = 24;
  const pad = 2;
  const labelW = 32;

  function fmtNum(n: number): string {
    if (n >= 10000) return Math.round(n / 1000) + "k";
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(n);
  }

  if (values.length === 1 || max === min) {
    const y = h / 2;
    return `<svg width="${w}" height="${h}" style="vertical-align:middle"><polyline points="${labelW},${y} ${w},${y}" fill="none" stroke="var(--accent, #58a6ff)" stroke-width="1.5"/><text x="${labelW - 2}" y="${h / 2 + 4}" font-size="9" fill="var(--muted, #8b949e)" text-anchor="end">${fmtNum(max)}</text></svg>`;
  }

  const range = max - min;
  const points = values.map((v, i) => {
    const x = labelW + (i / (values.length - 1)) * (w - labelW - pad * 2) + pad;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  return `<svg width="${w}" height="${h}" style="vertical-align:middle"><polyline points="${points}" fill="none" stroke="var(--accent, #58a6ff)" stroke-width="1.5"/><text x="${labelW - 2}" y="${pad + 3}" font-size="9" fill="var(--muted, #8b949e)" text-anchor="end" dominant-baseline="hanging">${fmtNum(max)}</text><text x="${labelW - 2}" y="${h - 1}" font-size="9" fill="var(--muted, #8b949e)" text-anchor="end">${fmtNum(min)}</text></svg>`;
}

export function buildStatusPage(
  version: string,
  uptime: number,
  queue: { pending: number; active: number },
  slack: { configured: boolean; lastResult: "ok" | "error" | null },
  slackBot: { configured: boolean },
  wa: { configured: boolean; connected: boolean; pairingRequired: boolean },
  email: { configured: boolean; lastCheck: string | null; lastError: string | null },
  ha: { configured: boolean; lastCheck: string | null; lastError: string | null },
  runningTasks: RunningTaskInfo[],
  theme: Theme,
  startedAt: string,
  queueDepth?: number,
  queueSnapshots?: Array<{ totalItems: number; recordedAt: string }>,
  aiProviders?: { anthropic: AiProviderStatus; openai: AiProviderStatus; opencode: AiProviderStatus },
  github?: GitHubStatusSnapshot | null,
  queueEntries?: QueueEntryView[],
): string {
  const sl = slackLabel(slack);
  const sbl = slackBotLabel(slackBot);
  const wl = whatsappLabel(wa);
  const el = emailLabel(email);
  const hal = homeAssistantLabel(ha);
  const al = aiProviders ? anthropicLabel(aiProviders.anthropic) : { text: "Idle", cls: "idle", link: false };
  const ol = aiProviders ? openaiLabel(aiProviders.openai) : { text: "Idle", cls: "idle", link: false };
  const ocl = aiProviders ? opencodeLabel(aiProviders.opencode) : { text: "Not configured", cls: "idle" };
  const ghl = githubStatusLabel(github ?? null);

  const workingOnTasks = queue.active > 0 ? runningTasks : [];
  const workingOnHtml = workingOnTasks.length > 0
    ? `<dt>Working on</dt>
    <dd id="queue-working-on">${workingOnTasks.map(t =>
      `${escapeHtml(t.jobName)} &mdash; ${hasItemRef(t.itemNumber)
        ? `${escapeHtml(repoShortName(t.repo))} <a href="${itemLogsUrl(t.repo, t.itemNumber)}"${refTitleAttr(t.itemNumber)}>#${escapeHtml(shortIssueRef(t.itemNumber))}</a>`
        : escapeHtml(repoShortName(t.repo))}`
    ).join("<br>")}</dd>`
    : `<dt>Working on</dt>
    <dd id="queue-working-on" class="idle">&mdash;</dd>`;

  const cancelBtnHtml = queue.active > 0
    ? `<dt></dt><dd><button class="trigger-btn" @click="cancel($event)" id="cancel-btn">Cancel</button></dd>`
    : `<dt></dt><dd><button class="trigger-btn" @click="cancel($event)" id="cancel-btn" style="display:none">Cancel</button></dd>`;

  return `<!DOCTYPE html>
${htmlOpenTag(theme, "wide")}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${HEAD_META}
  <title>claws — status</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
  .queue-priority-badge { color: var(--accent); font-weight: 600; }
  </style>
  ${ALPINE_SCRIPT}
</head>
<body x-data="dashboardPage()" x-init="startPolling()">
  ${buildPageHeader(null, theme)}
  ${THEME_SCRIPT}
  ${LOCAL_TIME_SCRIPT}
  <dl class="meta">
    <dt>Version</dt>
    <dd>${version}</dd>
    <dt>Uptime</dt>
    <dd id="uptime">${formatUptime(uptime)}</dd>
    <dt>Started</dt>
    <dd>${timestampHtml(startedAt)}</dd>
  </dl>
  <h2>Agent Queue</h2>
  <dl class="meta">
    <dt>Status</dt>
    <dd id="queue-status" class="${queue.active > 0 ? "running" : "idle"}">${queue.active > 0 ? `Active (${queue.active})` : "Idle"}</dd>
    <dt>Pending</dt>
    <dd id="queue-pending">${queue.pending}</dd>
    ${workingOnHtml}
    ${cancelBtnHtml}
  </dl>
  <div class="table-scroll">
    <table class="data-cards" id="queue-entries">
      <thead><tr><th>Position</th><th>Job</th><th>Repo</th><th>Issue</th><th>Title</th><th>Action</th></tr></thead>
      <tbody>
        ${buildQueueEntriesRows(queueEntries ?? [])}
      </tbody>
    </table>
  </div>
  <h2>Queue Depth</h2>
  <dl class="meta">
    <dt>Total Items</dt>
    <dd id="queue-depth">${queueDepth ?? 0}</dd>
    <dt>Last 24h</dt>
    <dd>${buildSparkline(queueSnapshots ?? [])}</dd>
  </dl>
  <h2>Integrations</h2>
  <dl class="meta">
    <dt>GitHub</dt>
    <dd id="github-status" class="${ghl.cls}"><a href="https://www.githubstatus.com/" target="_blank" rel="noopener">${escapeHtml(ghl.text)}</a>${github?.incident ? `<span class="field-note"> · ${escapeHtml(github.incident.name)}</span>` : ""}${github?.checkedAt ? `<span class="field-note"> · checked ${formatRelativeTime(github.checkedAt)}</span>` : ""}</dd>
    <dt>Slack</dt>
    <dd id="slack-status" class="${sl.cls}">${sl.text}</dd>
    <dt>Slack Bot (Ideas)</dt>
    <dd id="slackbot-status" class="${sbl.cls}">${sbl.text}</dd>
    <dt>WhatsApp</dt>
    <dd id="wa-status" class="${wl.cls}">${wl.link ? `<a href="/whatsapp">${wl.text}</a>` : wl.text}</dd>
    <dt>Email</dt>
    <dd id="email-status" class="${el.cls}">${el.text}</dd>
    <dt>Home Assistant</dt>
    <dd id="ha-status" class="${hal.cls}"><a href="/ha-upgrader">${hal.text}</a>${ha.lastCheck ? `<span class="field-note"> · last checked ${formatRelativeTime(ha.lastCheck)}</span>` : ""}</dd>
    <dt>Anthropic</dt>
    <dd id="anthropic-status" class="${al.cls}">${al.link ? `<a href="/reauth">${al.text}</a>` : al.text}${aiProviders?.anthropic.lastUsedAt ? `<span class="field-note"> · last used ${formatRelativeTime(aiProviders.anthropic.lastUsedAt)}</span>` : ""}</dd>
    <dt>OpenAI (Codex)</dt>
    <dd id="openai-status" class="${ol.cls}">${ol.link ? `<a href="/reauth">${ol.text}</a>` : ol.text}${aiProviders?.openai.lastUsedAt ? `<span class="field-note"> · last used ${formatRelativeTime(aiProviders.openai.lastUsedAt)}</span>` : ""}</dd>
    <dt>OpenCode</dt>
    <dd id="opencode-status" class="${ocl.cls}">${ocl.text}${aiProviders?.opencode.lastUsedAt ? `<span class="field-note"> · last used ${formatRelativeTime(aiProviders.opencode.lastUsedAt)}</span>` : ""}</dd>
  </dl>
  <script>
    function dashboardPage() {
      return {
        cancel(ev) {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.textContent = '...';
          fetch('/cancel', { method: 'POST' })
            .then(r => r.json())
            .then(data => {
              btn.textContent = data.result === 'cancelled' ? 'Cancelled!' : 'Nothing to cancel';
            })
            .catch(() => { btn.textContent = 'Error'; })
            .finally(() => { setTimeout(() => { btn.textContent = 'Cancel'; btn.disabled = false; }, 2000); });
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
        repoShortName(fullName) {
          const i = fullName.indexOf('/');
          return i >= 0 ? fullName.slice(i + 1) : fullName;
        },
        hasItemRef(n) {
          return typeof n === 'number' ? n > 0 : String(n).length > 0;
        },
        togglePriorityLabel(repo, ref, ev) {
          const btn = ev.currentTarget;
          const isPrio = btn.dataset.mode === 'prio';
          const pending = isPrio ? 'Prioritising...' : 'Deprioritising...';
          const labelOnFail = isPrio ? 'Prioritise' : 'Deprioritise';
          btn.style.minWidth = btn.getBoundingClientRect().width + 'px';
          btn.disabled = true;
          btn.textContent = pending;
          fetch('/queue/priority-label', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repo: repo, number: ref, add: isPrio }),
          })
            .then(r => r.json())
            .then(data => {
              if (data.error) {
                btn.textContent = 'Error';
                setTimeout(() => { btn.textContent = labelOnFail; btn.disabled = false; btn.style.minWidth = ''; }, 3000);
              } else {
                if (isPrio) {
                  btn.textContent = 'Deprioritise';
                  btn.classList.add('deprio');
                  btn.dataset.mode = 'deprio';
                } else {
                  btn.textContent = 'Prioritise';
                  btn.classList.remove('deprio');
                  btn.dataset.mode = 'prio';
                }
                btn.disabled = false;
                btn.style.minWidth = '';
              }
            })
            .catch(() => {
              btn.textContent = 'Error';
              setTimeout(() => { btn.textContent = labelOnFail; btn.disabled = false; btn.style.minWidth = ''; }, 3000);
            });
        },
        applyQueueEntries(entries) {
          const table = document.getElementById('queue-entries');
          const tbody = table && table.querySelector('tbody');
          if (!tbody) return;
          // A button mid-request holds a transient label ("Prioritising...") —
          // a rebuild here would stomp it before the fetch resolves.
          if (tbody.querySelector('button:disabled')) return;
          while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
          if (!entries || entries.length === 0) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 6;
            td.className = 'queue-empty';
            td.textContent = 'Queue is empty';
            tr.appendChild(td);
            tbody.appendChild(tr);
            return;
          }
          entries.forEach(e => {
            const tr = document.createElement('tr');
            const addCell = (label, cls) => {
              const td = document.createElement('td');
              td.dataset.label = label;
              if (cls) td.className = cls;
              tr.appendChild(td);
              return td;
            };
            addCell('Position').textContent = e.position;
            const jobTd = addCell('Job');
            if (e.status === 'running') {
              const span = document.createElement('span');
              span.className = 'running';
              span.textContent = e.kind;
              jobTd.appendChild(span);
            } else {
              jobTd.textContent = e.kind;
            }
            addCell('Repo').textContent = this.repoShortName(e.repo);
            const issueTd = addCell('Issue', 'cell-title');
            const a = document.createElement('a');
            a.href = '/logs/issue?repo=' + encodeURIComponent(e.repo) + '&number=' + encodeURIComponent(e.itemNumber);
            a.textContent = '#' + e.itemShort;
            issueTd.appendChild(a);
            const titleTd = addCell('Title', 'cell-title');
            if (e.hasPriorityLabel) {
              const badge = document.createElement('span');
              badge.className = 'queue-priority-badge';
              badge.title = 'Priority';
              badge.textContent = 'Priority';
              titleTd.appendChild(badge);
              titleTd.appendChild(document.createTextNode(' '));
            }
            titleTd.appendChild(document.createTextNode(e.title));
            const actionTd = addCell('Action', 'cell-actions');
            const btn = document.createElement('button');
            btn.className = e.hasPriorityLabel ? 'refined-btn prio-btn deprio' : 'refined-btn prio-btn';
            btn.dataset.mode = e.hasPriorityLabel ? 'deprio' : 'prio';
            btn.textContent = e.hasPriorityLabel ? 'Deprioritise' : 'Prioritise';
            btn.addEventListener('click', (ev) => this.togglePriorityLabel(e.repo, e.itemNumber, ev));
            actionTd.appendChild(btn);
            tbody.appendChild(tr);
          });
        },
        formatUptime(seconds) {
          const d = Math.floor(seconds / 86400);
          const h = Math.floor((seconds % 86400) / 3600);
          const m = Math.floor((seconds % 3600) / 60);
          const s = seconds % 60;
          const parts = [];
          if (d > 0) parts.push(d + 'd');
          if (h > 0) parts.push(h + 'h');
          if (m > 0) parts.push(m + 'm');
          parts.push(s + 's');
          return parts.join(' ');
        },
        applyStatus(data) {
          document.getElementById('uptime').textContent = this.formatUptime(data.uptime);
          const qs = document.getElementById('queue-status');
          qs.textContent = data.claudeQueue.active > 0 ? 'Active (' + data.claudeQueue.active + ')' : 'Idle';
          qs.className = data.claudeQueue.active > 0 ? 'running' : 'idle';
          document.getElementById('queue-pending').textContent = data.claudeQueue.pending;
          const qd = document.getElementById('queue-depth');
          if (qd && data.queueDepth !== undefined) qd.textContent = data.queueDepth;
          const wo = document.getElementById('queue-working-on');
          if (data.claudeQueue.active > 0 && data.runningTasks && data.runningTasks.length > 0) {
            wo.innerHTML = data.runningTasks.map(t =>
              t.jobName + ' \u2014 ' + (this.hasItemRef(t.itemNumber)
                ? this.repoShortName(t.repo) + ' <a href="/logs/issue?repo=' + encodeURIComponent(t.repo) + '&number=' + encodeURIComponent(t.itemNumber) + '">#' + t.itemShort + '</a>'
                : this.repoShortName(t.repo))
            ).join('<br>');
            wo.className = '';
          } else {
            wo.innerHTML = '\u2014';
            wo.className = 'idle';
          }
          const cb = document.getElementById('cancel-btn');
          if (cb) cb.style.display = data.claudeQueue.active > 0 ? '' : 'none';
          const sl = document.getElementById('slack-status');
          if (!data.slack.configured) { sl.textContent = 'Not configured'; sl.className = 'idle'; }
          else if (data.slack.lastResult === null) { sl.textContent = 'Configured (untested)'; sl.className = 'slack-untested'; }
          else if (data.slack.lastResult === 'ok') { sl.textContent = 'Connected'; sl.className = 'running'; }
          else { sl.textContent = 'Error'; sl.className = 'slack-error'; }
          const sbl = document.getElementById('slackbot-status');
          if (data.slackBot) {
            if (!data.slackBot.configured) { sbl.textContent = 'Not configured'; sbl.className = 'idle'; }
            else { sbl.textContent = 'Configured'; sbl.className = 'running'; }
          }
          const wa = document.getElementById('wa-status');
          if (!data.whatsapp.configured) { wa.innerHTML = 'Not configured'; wa.className = 'idle'; }
          else if (data.whatsapp.connected) { wa.innerHTML = '<a href="/whatsapp">Connected</a>'; wa.className = 'running'; }
          else if (data.whatsapp.pairingRequired) { wa.innerHTML = '<a href="/whatsapp">Pairing required</a>'; wa.className = 'slack-error'; }
          else { wa.innerHTML = '<a href="/whatsapp">Disconnected</a>'; wa.className = 'slack-error'; }
          const em = document.getElementById('email-status');
          if (data.email) {
            if (!data.email.configured) { em.textContent = 'Not configured'; em.className = 'idle'; }
            else if (data.email.lastError) { em.textContent = 'Error'; em.className = 'slack-error'; }
            else if (data.email.lastCheck) { em.textContent = 'Connected'; em.className = 'running'; }
            else { em.textContent = 'Configured (untested)'; em.className = 'slack-untested'; }
          }
          const ha = document.getElementById('ha-status');
          if (data.homeAssistant) {
            const haWrap = (t) => '<a href="/ha-upgrader">' + t + '</a>';
            if (!data.homeAssistant.configured) { ha.innerHTML = haWrap('Not configured'); ha.className = 'idle'; }
            else if (data.homeAssistant.lastError) { ha.innerHTML = haWrap('Error'); ha.className = 'slack-error'; }
            else if (data.homeAssistant.lastCheck) { ha.innerHTML = haWrap('Connected'); ha.className = 'running'; }
            else { ha.innerHTML = haWrap('Configured (untested)'); ha.className = 'slack-untested'; }
          }
          const ghEl = document.getElementById('github-status');
          if (ghEl && data.github) {
            const lbl = data.github.label || { text: 'Checking…', cls: 'idle' };
            const note = data.github.checkedAt ? '<span class="field-note"> · checked ' + this.formatRelativeTime(data.github.checkedAt) + '</span>' : '';
            const a = document.createElement('a');
            a.href = 'https://www.githubstatus.com/';
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = lbl.text;
            ghEl.innerHTML = '';
            ghEl.appendChild(a);
            ghEl.insertAdjacentHTML('beforeend', note);
            ghEl.className = lbl.cls;
          }
          if (data.queueEntries) this.applyQueueEntries(data.queueEntries);
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
