import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, htmlOpenTag, buildNav, buildPageHeader, THEME_SCRIPT, ALPINE_SCRIPT, escapeHtml } from "./layout.js";
import { ERROR_HANDLER_SCRIPT } from "../resources/error-handler.generated.js";
import { SESSIONS_LIST_SCRIPT } from "../resources/sessions-list.generated.js";
import { SESSION_TERMINAL_SCRIPT } from "../resources/session-terminal.generated.js";

export function buildSessionsListPage(
  theme: Theme,
  sessions: Array<{ id: string; repo: string | null; cwd: string; createdAt: number; alive: boolean; wsConnected: boolean; summary: string | null; summaryUpdatedAt: number | null }>,
  repos: Array<{ fullName: string }>,
  defaultRepo: string | null = null,
): string {
  const repoOptions = repos
    .map((r) => {
      const sel = r.fullName === defaultRepo ? " selected" : "";
      return `<option value="${escapeHtml(r.fullName)}"${sel}>${escapeHtml(r.fullName)}</option>`;
    })
    .join("");

  let tableHtml: string;
  if (sessions.length === 0) {
    tableHtml = `<p>No active sessions.</p>`;
  } else {
    const rows = sessions
      .map((s) => {
        const shortId = escapeHtml(s.id.slice(0, 8));
        const status = s.alive ? "Running" : "Exited";
        const created = new Date(s.createdAt).toISOString().replace("T", " ").slice(0, 19) + "Z";
        const summaryCell = s.summary
          ? `<td style="max-width: 28ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(s.summary)}">${escapeHtml(s.summary)}</td>`
          : `<td><em>Pending…</em></td>`;
        return `<tr>
        <td><a href="/sessions/${escapeHtml(s.id)}">${shortId}</a></td>
        <td>${s.repo ? escapeHtml(s.repo) : `<code>${escapeHtml(s.cwd)}</code>`}</td>
        ${summaryCell}
        <td>${created}</td>
        <td>${status}</td>
        <td><button class="trigger-btn" @click="killSession('${escapeHtml(s.id)}')">Kill</button></td>
      </tr>`;
      })
      .join("");
    tableHtml = `<div class="table-scroll"><table><thead><tr><th>ID</th><th>Repo / Dir</th><th>Summary</th><th>Created</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sessions — Claws</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}</style>
  ${ALPINE_SCRIPT}
</head>
<body x-data="sessionsListPage()" x-init="onRepoChange()">
  ${buildPageHeader("Sessions", theme)}
  ${THEME_SCRIPT}
  <div id="session-flash" role="status" style="display:none; margin-bottom: 1rem; padding: 0.6rem 0.9rem; background: var(--bg-elev); border: 1px solid var(--border); border-left: 3px solid #3fb950; border-radius: 4px; font-size: 0.9rem;"></div>
  <form method="POST" action="/sessions/create" style="margin-bottom: 1.5rem; display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-end;">
    <label style="display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.875rem; color: var(--text-secondary);">
      Working directory
      <select name="repo" id="session-repo" @change="onRepoChange()">
        <option value="">Home directory</option>
        ${repoOptions}
      </select>
    </label>
    <label style="display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.875rem; color: var(--text-secondary);">
      Mode
      <select name="mode" id="session-mode">
        <option value="repo-zsh">zsh in repo</option>
        <option value="repo-claude">Claude in repo (plain)</option>
        <option value="worktree-claude"${defaultRepo ? " selected" : ""}>Claude in new worktree</option>
        <option value="home-claude"${!defaultRepo ? " selected" : ""}>Claude (home directory)</option>
      </select>
    </label>
    <button type="submit" class="trigger-btn">Create Session</button>
  </form>
  ${tableHtml}
  ${SESSIONS_LIST_SCRIPT}
</body>
</html>`;
}

export function buildSessionTerminalPage(
  theme: Theme,
  session: { id: string; repo: string | null; cwd: string; alive: boolean },
): string {
  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Session ${escapeHtml(session.id.slice(0, 8))} — Claws</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
    body { display: flex; flex-direction: column; height: 100vh; height: 100dvh; margin: 0; padding: 0; max-width: none; }
    #terminal { flex: 1; overflow: hidden; }
    .session-bar { padding: 0.5rem 1rem; font-size: 0.85rem; color: var(--text); border-bottom: 1px solid var(--border); }
    .nav-toggle-btn { display: none; font-size: 1rem; padding: 0.15rem 0.5rem; line-height: 1; }
    #mobile-keybar { display: none; }
    .kb-key { min-width: 2.5rem; min-height: 2.25rem; padding: 0.3rem 0.55rem; font: 0.9rem/1 monospace; background: var(--bg-elev); color: var(--text); border: 1px solid var(--border); border-radius: 4px; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; flex: 0 0 auto; cursor: pointer; }
    .kb-key[data-active="true"] { background: var(--text); color: var(--bg); }
    @media (hover: none) and (pointer: coarse) {
      #mobile-keybar { display: flex; overflow-x: auto; gap: 0.25rem; padding: 0.25rem 0.4rem; border-top: 1px solid var(--border); flex: 0 0 auto; -webkit-overflow-scrolling: touch; }
    }
    @media (max-width: 900px) {
      #mobile-keybar { display: flex; overflow-x: auto; gap: 0.25rem; padding: 0.25rem 0.4rem; border-top: 1px solid var(--border); flex: 0 0 auto; -webkit-overflow-scrolling: touch; }
    }
    @media (max-width: 768px) {
      .nav-toggle-btn { display: inline-block; }
      #nav-wrap > nav { display: none; }
      #nav-wrap[data-open="true"] > nav { display: flex; }
      .session-dir { display: none; }
      .session-bar { padding: 0.35rem 0.6rem; font-size: 0.8rem; }
      .kb-key { font-size: 0.8rem; min-width: 2.2rem; min-height: 2rem; }
    }
  </style>
  ${ALPINE_SCRIPT}
  ${ERROR_HANDLER_SCRIPT}
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css" integrity="sha384-8Xk9wy/gzEDUKrXtrmCFa2bBuK3BpjpDuL/p0SeKQX19Khl/M+lHOgD/CyYf7efP" crossorigin="anonymous">
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js" integrity="sha384-M169f14mRZOXm3hD/v2Ti0ThIT/RnAQagXA9nlE15yHAtrW19gdePJh/HaTzUOe/" crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.js" integrity="sha384-txoiwu4RR2GD3qySbaj+BbzibkLbSJRcfqGYMu6z1EqHil4A2dyBiBW5dlacG6OR" crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.12.0/lib/addon-web-links.js" integrity="sha384-0IIwkXq0LAkIxEVKxlOxWbje2g/VT+5CzVTZiEukyiZ02pOl/O+M0fkpEKAYqto9" crossorigin="anonymous"></script>
</head>
<!-- Terminal page intentionally omits the standard page header: it runs a full-bleed
     xterm.js view. The session-bar below provides navigation back to /sessions. -->
<body>
  <div id="nav-wrap" data-open="false">${buildNav(theme)}</div>
  <div class="session-bar">
    <button id="nav-toggle" type="button" class="trigger-btn nav-toggle-btn" aria-label="Menu" aria-expanded="false">☰</button>
    Session: <strong>${escapeHtml(session.id.slice(0, 8))}</strong>
    <span class="session-dir"> | Dir: <code>${escapeHtml(session.cwd)}</code></span>
    | <a href="/sessions">← Back</a>
    | <button id="paste-btn" class="trigger-btn" style="font-size:0.85rem;padding:0.2rem 0.5rem;">Paste</button>
  </div>
  <div id="terminal" data-session-id="${escapeHtml(session.id)}" data-session-alive="${session.alive ? "true" : "false"}"></div>
  <div id="mobile-keybar">
    <button type="button" class="kb-key" data-key="esc">Esc</button>
    <button type="button" class="kb-key" data-key="tab">Tab</button>
    <button type="button" class="kb-key" data-key="enter">Enter</button>
    <button type="button" class="kb-key" data-action="font-dec" aria-label="Decrease terminal font">A&#x2212;</button>
    <button type="button" class="kb-key" data-action="font-inc" aria-label="Increase terminal font">A+</button>
    <button type="button" class="kb-key" data-key="ctrl-d">^D</button>
    <button type="button" class="kb-key" data-action="ctrl-d-double" aria-label="Ctrl+D twice (exit)">^D&#xD7;2</button>
    <button type="button" class="kb-key" data-key="up">↑</button>
    <button type="button" class="kb-key" data-key="down">↓</button>
    <button type="button" class="kb-key" data-key="left">←</button>
    <button type="button" class="kb-key" data-key="right">→</button>
    <button type="button" class="kb-key" data-action="ctrl">Ctrl</button>
    <button type="button" class="kb-key" data-key="home">Home</button>
    <button type="button" class="kb-key" data-key="end">End</button>
    <button type="button" class="kb-key" data-key="pgup">PgUp</button>
    <button type="button" class="kb-key" data-key="pgdn">PgDn</button>
    <button type="button" class="kb-key" data-key="ctrl-c">^C</button>
    <button type="button" class="kb-key" data-key="ctrl-z">^Z</button>
    <button type="button" class="kb-key" data-key="ctrl-l">^L</button>
  </div>
  <script>
(function(){
  var btn = document.getElementById('nav-toggle');
  var wrap = document.getElementById('nav-wrap');
  if (!btn || !wrap) return;
  btn.addEventListener('click', function(){
    var open = wrap.getAttribute('data-open') === 'true';
    wrap.setAttribute('data-open', open ? 'false' : 'true');
    btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    window.dispatchEvent(new Event('resize'));
  });
})();
  </script>
  ${THEME_SCRIPT}
  ${SESSION_TERMINAL_SCRIPT}
</body>
</html>`;
}
