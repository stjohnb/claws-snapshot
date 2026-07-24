import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, htmlOpenTag, buildNav, buildPageHeader, THEME_SCRIPT, ALPINE_SCRIPT, escapeHtml } from "./layout.js";
import { ERROR_HANDLER_SCRIPT } from "../resources/error-handler.generated.js";
import { SESSIONS_LIST_SCRIPT } from "../resources/sessions-list.generated.js";
import { SESSION_TERMINAL_SCRIPT } from "../resources/session-terminal.generated.js";
import { availableCapabilities, reposForCapability } from "../capabilities.js";

export function buildSessionsListPage(
  theme: Theme,
  sessions: Array<{ id: string; repo: string | null; extraRepos: string[]; cwd: string; createdAt: number; alive: boolean; resumable: boolean; wsConnected: boolean; summary: string | null; summaryUpdatedAt: number | null; endedAt: number | null }>,
  repos: Array<{ fullName: string }>,
  defaultRepo: string | null = null,
): string {
  const repoOptions = repos
    .map((r) => {
      const sel = r.fullName === defaultRepo ? " selected" : "";
      return `<option value="${escapeHtml(r.fullName)}"${sel}>${escapeHtml(r.fullName)}</option>`;
    })
    .join("");

  const repoCheckboxes = repos
    .map((r) => `<label style="display:flex; gap:0.4rem; align-items:center; font-size:0.85rem;">
      <input type="checkbox" name="repo" value="${escapeHtml(r.fullName)}"> ${escapeHtml(r.fullName)}
    </label>`)
    .join("");

  const capBoxes = availableCapabilities().map((cap) => {
    const capRepos = JSON.stringify(reposForCapability(cap.id));
    return `<label data-cap="${escapeHtml(cap.id)}" data-cap-repos="${escapeHtml(capRepos)}" style="display:inline-flex;gap:0.3rem;align-items:center;margin-right:0.75rem;font-size:0.85rem;">
       <input type="checkbox" name="capability" value="${escapeHtml(cap.id)}"> ${escapeHtml(cap.label)}
     </label>`;
  }).join("");

  const capFieldsetSingle = capBoxes
    ? `<fieldset id="single-cap-fieldset" style="border:1px solid var(--border);border-radius:4px;padding:0.5rem;margin:0.5rem 0;flex-basis:100%;">
         <legend style="font-size:0.85rem;">Capabilities (none granted by default)</legend>
         <label style="display:inline-flex;gap:0.3rem;align-items:center;margin-right:0.75rem;font-size:0.85rem;font-weight:600;">
           <input type="checkbox" id="cap-show-all" @change="onRepoChange()"> Show all capabilities
         </label>
         <div id="single-cap-list" style="margin-top:0.4rem;">${capBoxes}</div>
         <div id="single-cap-empty" style="display:none;font-size:0.8rem;color:var(--text-secondary);margin-top:0.3rem;">No capabilities are associated with this repo. Tick "Show all capabilities" to grant one anyway.</div>
       </fieldset>`
    : "";

  const capFieldsetMulti = capBoxes
    ? `<fieldset style="border:1px solid var(--border);border-radius:4px;padding:0.5rem;margin:0.5rem 0;flex-basis:100%;">
         <legend style="font-size:0.85rem;">Capabilities (none granted by default)</legend>${capBoxes}
       </fieldset>`
    : "";

  const multiForm = repos.length < 2 ? "" : `
  <form method="POST" action="/sessions/create-multi" x-data="{ n: 0 }" x-init="n = $root.querySelectorAll('input[name=repo]:checked').length" @change="n = $root.querySelectorAll('input[name=repo]:checked').length" style="margin-bottom:1.5rem; padding:0.75rem; border:1px solid var(--border); border-radius:4px;">
    <div style="font-size:0.875rem; color:var(--text-secondary); margin-bottom:0.5rem;">
      Multi-repo Claude session — tick two or more repos to launch Claude with a fresh worktree per repo (wired together via <code>--add-dir</code>).
    </div>
    <div style="display:flex; flex-direction:column; gap:0.3rem; max-height:14rem; overflow:auto; margin-bottom:0.6rem;">
      ${repoCheckboxes}
    </div>
    ${capFieldsetMulti}
    <button type="submit" class="trigger-btn" :disabled="n < 2">Create Multi-repo Session</button>
  </form>`;

  let tableHtml: string;
  if (sessions.length === 0) {
    tableHtml = `<p>No sessions.</p>`;
  } else {
    const rows = sessions
      .map((s) => {
        const shortId = escapeHtml(s.id.slice(0, 8));
        const status = s.alive ? "Running" : "Ended";
        const created = new Date(s.createdAt).toISOString().replace("T", " ").slice(0, 19) + "Z";
        const summaryCell = s.summary
          ? `<td style="max-width: 28ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(s.summary)}">${escapeHtml(s.summary)}</td>`
          : `<td><em>Pending…</em></td>`;
        const idCell = s.alive
          ? `<a href="/sessions/${escapeHtml(s.id)}">${shortId}</a>`
          : shortId;
        return `<tr>
        <td>${idCell}</td>
        <td>${
          s.repo
            ? [s.repo, ...s.extraRepos].map((r) => escapeHtml(r)).join("<br>")
            : `<code>${escapeHtml(s.cwd)}</code>`
        }</td>
        ${summaryCell}
        <td>${created}</td>
        <td>${status}</td>
        <td>${
          s.alive
            ? `<button class="trigger-btn" @click="killSession('${escapeHtml(s.id)}')">End</button>`
            : `${s.resumable ? `<button class="trigger-btn" @click="resumeSession('${escapeHtml(s.id)}')">Resume</button> ` : ""}<button class="trigger-btn" @click="deleteSession('${escapeHtml(s.id)}')">Delete</button>`
        }</td>
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
  ${HEAD_META}
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
    ${capFieldsetSingle}
    <button type="submit" class="trigger-btn">Create Session</button>
  </form>
  ${multiForm}
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
  ${HEAD_META}
  <title>Session ${escapeHtml(session.id.slice(0, 8))} — Claws</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
    body { display: flex; flex-direction: column; height: 100vh; height: 100dvh; margin: 0; padding: 0; max-width: none; }
    #terminal { flex: 1; overflow: hidden; }
    .session-bar { padding: 0.5rem 1rem; font-size: 0.85rem; color: var(--text); border-bottom: 1px solid var(--border); }
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
      .session-dir { display: none; }
      .session-bar { padding: 0.35rem 0.6rem; font-size: 0.8rem; }
      .kb-key { font-size: 0.8rem; min-width: 2.2rem; min-height: 2rem; }
    }
    #copy-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.6); display: none; flex-direction: column; padding: 1rem; box-sizing: border-box; }
    .copy-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .copy-panel-bar { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; color: var(--text); }
    #copy-textarea { flex: 1; min-height: 0; width: 100%; box-sizing: border-box; border: 0; resize: none; padding: 0.5rem 0.75rem; font: 0.85rem/1.3 monospace; background: var(--bg); color: var(--text); white-space: pre-wrap; word-break: break-word; -webkit-user-select: text; user-select: text; overflow: auto; }
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
  ${buildNav(theme)}
  <div class="session-bar">
    Session: <strong>${escapeHtml(session.id.slice(0, 8))}</strong>
    <span class="session-dir"> | Dir: <code>${escapeHtml(session.cwd)}</code></span>
    | <a href="/sessions">← Back</a>
    | <button id="paste-btn" class="trigger-btn" style="font-size:0.85rem;padding:0.2rem 0.5rem;">Paste</button>
    | <button id="copy-btn" class="trigger-btn" style="font-size:0.85rem;padding:0.2rem 0.5rem;">Copy</button>
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
  <div id="copy-overlay">
    <div class="copy-panel">
      <div class="copy-panel-bar">
        <span>Select text to copy</span>
        <span style="display:flex; gap:0.4rem;">
          <button id="copy-all-btn" type="button" class="trigger-btn">Copy all</button>
          <button id="copy-close-btn" type="button" class="trigger-btn">Close</button>
        </span>
      </div>
      <textarea id="copy-textarea" readonly></textarea>
    </div>
  </div>
  ${THEME_SCRIPT}
  ${SESSION_TERMINAL_SCRIPT}
</body>
</html>`;
}
