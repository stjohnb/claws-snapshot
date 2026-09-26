import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, htmlOpenTag, buildNav, buildPageHeader, THEME_SCRIPT, ALPINE_SCRIPT, escapeHtml, repoShortName, formatRelativeTime } from "./layout.js";
import { ERROR_HANDLER_SCRIPT } from "../resources/error-handler.generated.js";
import { AUTH_WATCH_SCRIPT } from "../resources/auth-watch.generated.js";
import { SESSIONS_LIST_SCRIPT } from "../resources/sessions-list.generated.js";
import { SESSION_TERMINAL_SCRIPT } from "../resources/session-terminal.generated.js";
import { availableCapabilities, reposForCapability, defaultCapabilitiesForRepo, defaultProviderAuthCapabilities, capabilityLabel, GITHUB_AUTH_CAPABILITY_ID, isCapabilityAvailable, CAPABILITY_GROUPS, capabilityGroup, validCapabilityIds, autoGrantedRepos } from "../capabilities.js";
import { sessionModelsFor, defaultSessionModel, CUSTOM_MODEL_SENTINEL } from "../session-models.js";

type StartupStatus = { state: string; step: string; detail: string | null; elapsedMs: number; failureReason?: string | null };
type SessionListItem = { id: string; repo: string | null; extraRepos: string[]; cwd: string; provider?: string; model?: string | null; mode?: string; createdAt: number; alive: boolean; resumable: boolean; wsConnected: boolean; summary: string | null; summaryUpdatedAt: number | null; agentStatus?: string | null; agentStatusUpdatedAt?: number | null; startupStatus?: StartupStatus | null; endedAt: number | null; capabilities?: string[]; tokensUsed?: number | null; costUsd?: number | null; lastContextTokens?: number | null; usageUpdatedAt?: number | null; usageWarningLevel?: "none" | "warn" | "critical" | null; exitCode?: number | null };
type SessionsListDefaultProvider = "claude" | "codex" | "opencode";
type SessionsListDefaultMultiProvider = "claude" | "codex";

const PROVIDER_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };

function providerLabel(provider: string | undefined): string {
  return PROVIDER_LABELS[provider ?? "claude"] ?? (provider ?? "Claude");
}

const AGENT_STATUS_LABELS: Record<string, string> = { working: "Working", monitoring: "Monitoring", waiting: "Waiting", done: "Done" };

/** Mirrors `formatElapsed` in session-terminal.ts so the startup banner and the sessions list agree on how long a session has been starting. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/** Self-reported agent status (#3083) with its age, so a stale status stays visible; "—" until the agent reports. */
function renderAgentStatusCell(s: SessionListItem): string {
  if (s.startupStatus && s.startupStatus.state !== "ready") {
    const detail = s.startupStatus.failureReason ?? s.startupStatus.detail;
    const text = detail ? `${s.startupStatus.step}: ${detail}` : s.startupStatus.step;
    const elapsed = formatElapsed(s.startupStatus.elapsedMs ?? 0);
    const cls = s.startupStatus.state === "failed" ? "session-agent-status-failed" : "session-agent-status-monitoring";
    return `<td data-label="Status"><span class="session-agent-status ${cls}">${escapeHtml(s.startupStatus.state === "failed" ? "Startup failed" : "Starting")}</span> · ${escapeHtml(text)} · ${elapsed}</td>`;
  }
  const label = s.agentStatus ? AGENT_STATUS_LABELS[s.agentStatus] : undefined;
  if (!label || s.agentStatusUpdatedAt == null) return `<td data-label="Status">—</td>`;
  const iso = new Date(s.agentStatusUpdatedAt).toISOString();
  const abs = iso.replace("T", " ").slice(0, 19) + "Z";
  return `<td data-label="Status"><span class="session-agent-status session-agent-status-${escapeHtml(s.agentStatus!)}">${label}</span> · <time datetime="${escapeHtml(iso)}" title="${escapeHtml(abs)}">${escapeHtml(formatRelativeTime(iso))}</time></td>`;
}

/** Lozenges for the capabilities a session holds (#3110); "—" when none. Shows
 *  the stored list as-is, not re-run through `withImplicitCapabilities`, so a
 *  capability the session still holds is not hidden by its token since being
 *  unconfigured. */
function renderCapabilitiesCell(s: SessionListItem): string {
  const caps = s.capabilities ?? [];
  if (caps.length === 0) return `<td data-label="Capabilities">—</td>`;
  const shown = caps.slice(0, 2);
  const hidden = caps.slice(2);
  const lozenges = shown
    .map((id) => `<span class="capability-lozenge" title="${escapeHtml(id)}">${escapeHtml(capabilityLabel(id))}</span>`)
    .join("");
  const moreLozenge =
    hidden.length > 0
      ? `<span class="capability-lozenge capability-lozenge-more" title="${escapeHtml(hidden.map((id) => capabilityLabel(id)).join(", "))}">+${hidden.length}</span>`
      : "";
  return `<td data-label="Capabilities"><span class="session-capabilities">${lozenges}${moreLozenge}</span></td>`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function renderUsageCell(s: SessionListItem, showUsage: boolean): string {
  if (!showUsage) return "";
  if (s.lastContextTokens == null && s.tokensUsed == null) return `<td data-label="Usage">—</td>`;
  const level = s.usageWarningLevel ?? "none";
  const color = level === "critical" ? "var(--danger)" : level === "warn" ? "var(--warning)" : "var(--text)";
  const context = s.lastContextTokens == null ? "unknown" : formatTokens(s.lastContextTokens);
  const total = s.tokensUsed == null ? "unknown" : formatTokens(s.tokensUsed);
  const label = level === "critical" ? "Critical" : level === "warn" ? "Warn" : "Usage";
  return `<td data-label="Usage"><span style="color:${color}; font-weight:${level === "none" ? "400" : "600"};">${escapeHtml(label)}</span><br><span title="Last context tokens">${escapeHtml(context)} ctx</span><br><span style="color:var(--text-secondary);" title="Total tokens">${escapeHtml(total)} total</span></td>`;
}

function renderSessionRow(s: SessionListItem, showStatus: boolean, showUsage: boolean): string {
  const shortId = escapeHtml(s.id.slice(0, 8));
  const status = s.alive ? "Running" : s.exitCode ? `Failed (exit ${s.exitCode})` : "Ended";
  const createdIso = new Date(s.createdAt).toISOString();
  const createdAbs = createdIso.replace("T", " ").slice(0, 19) + "Z";
  const created = `<time datetime="${escapeHtml(createdIso)}" title="${escapeHtml(createdAbs)}">${escapeHtml(formatRelativeTime(createdIso))}</time>`;
  const agent = s.mode === "repo-zsh" ? "zsh" : providerLabel(s.provider) + (s.model ? ` · ${s.model}` : "");
  const haystack = escapeHtml([s.id, s.repo ?? "", ...s.extraRepos, s.cwd, agent, s.summary ?? ""].join(" ").toLowerCase());
  const summaryCell = s.summary
    ? `<td data-label="Summary" class="cell-summary" title="${escapeHtml(s.summary)}">${escapeHtml(s.summary)}</td>`
    : `<td data-label="Summary"><em>Pending…</em></td>`;
  // An ended row links to its saved last output (#3311).
  const idCell = s.alive || s.endedAt !== null
    ? `<a href="/sessions/${escapeHtml(s.id)}"${s.alive ? "" : ` title="View last output"`}>${shortId}</a>`
    : shortId;
  const repoCell = s.repo
    ? [s.repo, ...s.extraRepos].map((r) => `<span title="${escapeHtml(r)}">${escapeHtml(repoShortName(r))}</span>`).join("<br>")
    : `<code>${escapeHtml(s.cwd)}</code>`;
  const statusCell = showStatus ? `<td data-label="Status">${status}</td>` : "";
  const agentStatusCell = showStatus ? "" : renderAgentStatusCell(s);
  const capabilitiesCell = showStatus ? "" : renderCapabilitiesCell(s);
  const usageCell = renderUsageCell(s, showUsage);
  return `<tr data-status="${s.alive ? "running" : "ended"}" data-search="${haystack}">
    <td data-label="ID">${idCell}</td>
    <td class="cell-title">${repoCell}</td>
    <td data-label="Agent">${escapeHtml(agent)}</td>
    ${usageCell}
    ${capabilitiesCell}
    ${summaryCell}
    ${agentStatusCell}
    <td data-label="Created">${created}</td>
    ${statusCell}
    <td class="cell-actions">${
      s.alive
        ? `<button class="trigger-btn" @click="killSession('${escapeHtml(s.id)}')">End</button>`
        : `${s.resumable ? `<button class="trigger-btn" @click="resumeSession('${escapeHtml(s.id)}')">Resume</button> ` : ""}<button class="trigger-btn" @click="deleteSession('${escapeHtml(s.id)}')">Delete</button>`
    }</td>
  </tr>`;
}

function renderSessionsTable(list: SessionListItem[], tableId: string, showStatus: boolean): string {
  const statusHeader = showStatus ? "<th>Status</th>" : "";
  const agentStatusHeader = showStatus ? "" : "<th>Status</th>";
  const capabilitiesHeader = showStatus ? "" : "<th>Capabilities</th>";
  const usageHeader = showStatus ? "" : "<th>Usage</th>";
  return `<div class="table-scroll"><table id="${tableId}" class="data-cards data-cards-wide"><thead><tr><th>ID</th><th>Repo / Dir</th><th>Agent</th>${usageHeader}${capabilitiesHeader}<th>Summary</th>${agentStatusHeader}<th>Created</th>${statusHeader}<th>Actions</th></tr></thead><tbody>${list.map((s) => renderSessionRow(s, showStatus, !showStatus)).join("")}</tbody></table></div>`;
}

export function buildSessionsListPage(
  theme: Theme,
  sessions: SessionListItem[],
  repos: Array<{ fullName: string }>,
  defaultRepo: string | null = null,
  recentModels: { claude: string[]; codex: string[]; opencode: string[] } = { claude: [], codex: [], opencode: [] },
  options: {
    defaultProvider?: SessionsListDefaultProvider;
    defaultMultiProvider?: SessionsListDefaultMultiProvider;
    /** Last submitted capability set per repo combination, keyed by
     *  `sessionCapabilityDefaultsKey` in db.ts: a single repo's key is its own
     *  full name, a multi-repo key joins two or more names with a newline. */
    rememberedCapabilityDefaults?: Map<string, string[]>;
  } = {},
): string {
  const defaultProvider = options.defaultProvider ?? "claude";
  const defaultMultiProvider = options.defaultMultiProvider ?? "claude";
  const remembered = options.rememberedCapabilityDefaults ?? new Map<string, string[]>();
  // The repo's last submitted set when there is one (even an empty one), else
  // the static REPO_CAPABILITY_DEFAULTS seed. Retired or unconfigured ids drop out.
  const effectiveRepoDefaults = (repo: string | null): string[] => {
    if (!repo) return [];
    const ids = remembered.get(repo);
    return ids ? validCapabilityIds(ids) : defaultCapabilitiesForRepo(repo);
  };
  const repoOptions = repos
    .map((r) => {
      const sel = r.fullName === defaultRepo ? " selected" : "";
      return `<option value="${escapeHtml(r.fullName)}"${sel}>${escapeHtml(repoShortName(r.fullName))}</option>`;
    })
    .join("");

  const repoCheckboxes = repos
    .map((r) => `<label style="display:flex; gap:0.4rem; align-items:center; font-size:0.85rem;" title="${escapeHtml(r.fullName)}">
      <input type="checkbox" name="repo" value="${escapeHtml(r.fullName)}" @change="onMultiRepoChange()"> ${escapeHtml(repoShortName(r.fullName))}
    </label>`)
    .join("");

  // Agent-login capabilities (k8s-pod only, #3026) are pre-ticked for the
  // form's default agent; the client script re-syncs them on Agent/Mode change.
  // github-auth follows the repo like any repo-default capability (#3131).
  const checkedForDefaultRepo = new Set([
    ...effectiveRepoDefaults(defaultRepo),
    ...defaultProviderAuthCapabilities(defaultProvider, defaultRepo ? "worktree-claude" : "home-claude"),
  ]);
  // Auto-granted capabilities (cross-repo always, forgejo for a Forgejo-hosted
  // repo, #2871/#3372) are still rendered: forced ones as a checked, disabled
  // box with the reason, so the operator can see every credential a session
  // will hold; a conditionally auto-granted one that isn't forced for the
  // current selection (forgejo on a GitHub-only pick) is an ordinary checkbox.
  const allRepoNames = repos.map((r) => r.fullName);
  // Single-repo form: a repo is listed for a capability when its effective
  // default set holds it, which drives both the pre-tick and the pre-filter.
  const repoDefaults = new Map(allRepoNames.map((name) => [name, effectiveRepoDefaults(name)]));
  const singleCapRepos = (capId: string): string[] =>
    allRepoNames.filter((name) => repoDefaults.get(name)?.includes(capId));
  // Multi-repo form: github-auth's list still marks which repos it covers (#3136).
  const multiCapRepos = (capId: string): string[] => reposForCapability(capId, allRepoNames);
  const renderCapBoxes = (
    checked: Set<string>,
    capReposFor: (capId: string) => string[],
    isForced: (auto: "all" | string[]) => boolean,
  ) => {
    const eligible = availableCapabilities();
    return CAPABILITY_GROUPS.map(({ id: groupId, label: groupLabel }) => {
      const caps = eligible.filter((cap) => capabilityGroup(cap) === groupId);
      if (caps.length === 0) return "";
      const labels = caps.map((cap) => {
        const capRepos = JSON.stringify(capReposFor(cap.id));
        const auto = autoGrantedRepos(cap.id, allRepoNames);
        const forced = auto !== null && isForced(auto);
        const isChecked = forced || checked.has(cap.id) ? " checked" : "";
        const disabledAttr = forced ? " disabled" : "";
        const autoAttr = auto === null ? "" : ` data-cap-auto-repos="${escapeHtml(auto === "all" ? "*" : JSON.stringify(auto))}"`;
        const noteText = forced ? (auto === "all" ? "always granted" : "auto: Forgejo-hosted repo") : "";
        const providerAttr = cap.provider && cap.provider !== "github" ? ` data-cap-provider="${escapeHtml(cap.provider)}"` : "";
        return `<label data-cap="${escapeHtml(cap.id)}" data-cap-repos="${escapeHtml(capRepos)}"${autoAttr}${providerAttr} style="display:inline-flex;gap:0.3rem;align-items:center;margin-right:0.75rem;font-size:0.85rem;">
       <input type="checkbox" name="capability" value="${escapeHtml(cap.id)}"${isChecked}${disabledAttr}> ${escapeHtml(cap.label)}<span class="cap-auto-note">${escapeHtml(noteText)}</span>
     </label>`;
      }).join("");
      return `<div class="cap-group" data-cap-group="${escapeHtml(groupId)}"><span class="cap-group-title">${escapeHtml(groupLabel)}</span>${labels}</div>`;
    }).join("");
  };
  const capBoxesSingle = renderCapBoxes(
    checkedForDefaultRepo,
    singleCapRepos,
    (auto) => auto === "all" || (!!defaultRepo && auto.includes(defaultRepo)),
  );
  const capBoxesMulti = renderCapBoxes(new Set([
    ...defaultProviderAuthCapabilities(defaultMultiProvider, "multi-worktree-claude"),
    ...(isCapabilityAvailable(GITHUB_AUTH_CAPABILITY_ID) ? [GITHUB_AUTH_CAPABILITY_ID] : []),
  ]), multiCapRepos, (auto) => auto === "all");
  // The client re-ticks the multi form from these when the ticked repos match
  // a remembered combination; single-repo keys are left to the single form.
  const multiCapDefaults: Record<string, string[]> = {};
  for (const [key, ids] of remembered) {
    if (key.includes("\n")) multiCapDefaults[key] = validCapabilityIds(ids);
  }
  const multiPreticked = [
    availableCapabilities().some((cap) => cap.provider === "claude") ? "the agent's login" : "",
    isCapabilityAvailable(GITHUB_AUTH_CAPABILITY_ID) ? "GitHub" : "",
  ].filter(Boolean).join(" and ");

  const capFieldsetSingle = capBoxesSingle
    ? `<fieldset id="single-cap-fieldset" style="border:1px solid var(--border);border-radius:4px;padding:0.5rem;margin:0.5rem 0;flex-basis:100%;">
         <legend style="font-size:0.85rem;">Capabilities (pre-ticked from your last session with this repo)</legend>
         <label style="display:inline-flex;gap:0.3rem;align-items:center;margin-right:0.75rem;font-size:0.85rem;font-weight:600;">
           <input type="checkbox" id="cap-show-all" @change="onRepoChange()"> Show all capabilities
         </label>
         <div id="single-cap-list" style="margin-top:0.4rem;">${capBoxesSingle}</div>
         <div id="single-cap-empty" style="display:none;font-size:0.8rem;color:var(--text-secondary);margin-top:0.3rem;">No repo-specific capabilities are associated with this repo. Tick "Show all capabilities" to grant one anyway.</div>
       </fieldset>`
    : "";

  const capFieldsetMulti = capBoxesMulti
    ? `<fieldset style="border:1px solid var(--border);border-radius:4px;padding:0.5rem;margin:0.5rem 0;flex-basis:100%;">
         <legend style="font-size:0.85rem;">Capabilities (pre-ticked from your last session with these repos, else ${multiPreticked ? `only ${multiPreticked} pre-ticked` : "none granted by default"})</legend>
         <div id="multi-cap-list" data-multi-cap-defaults="${escapeHtml(JSON.stringify(multiCapDefaults))}" style="margin-top:0.4rem;">${capBoxesMulti}</div>
       </fieldset>`
    : "";

  // One <select name="model"> per provider. The client script enables/shows
  // exactly one of them (matching the Agent select) and disables the rest, so
  // the browser submits a single `model` value; the server-rendered state
  // follows the default Agent so a no-JS render still posts exactly one value
  // (#2873).
  const renderModelSelect = (provider: "claude" | "codex" | "opencode", selectId: string, active: boolean) => {
    const recents = recentModels[provider] ?? [];
    const recentSet = new Set(recents);
    const available = sessionModelsFor(provider).filter((m) => !recentSet.has(m.id));
    // Every rendered option must name a real model; the operator's configured
    // default is server-rendered `selected`, falling back to the first
    // rendered id if that default isn't among them (#3254).
    const renderedIds = [...recents, ...available.map((m) => m.id)];
    const defaultId = defaultSessionModel(provider);
    const selectedId = renderedIds.includes(defaultId) ? defaultId : renderedIds[0];
    const opt = (id: string, label: string) => `<option value="${escapeHtml(id)}"${id === selectedId ? " selected" : ""}>${escapeHtml(label)}</option>`;
    const recentGroup = recents.length === 0
      ? ""
      : `<optgroup label="Recently used">${recents.map((id) => opt(id, id)).join("")}</optgroup>`;
    const availableGroup = available.length === 0
      ? ""
      : `<optgroup label="Available">${available.map((m) => opt(m.id, m.label)).join("")}</optgroup>`;
    const fallbackOption = renderedIds.length === 0 ? `<option value="" selected>Agent CLI default</option>` : "";
    const attrs = active ? "" : ` disabled style="display:none"`;
    return `<select name="model" id="${escapeHtml(selectId)}" class="form-select" data-model-for="${escapeHtml(provider)}" @change="onModelChange()"${attrs}>
        ${fallbackOption}
        ${recentGroup}
        ${availableGroup}
        <option value="${escapeHtml(CUSTOM_MODEL_SENTINEL)}">Other (type an ID)…</option>
      </select>`;
  };

  const multiForm = repos.length < 2 ? "" : `
  <form method="POST" action="/sessions/create-multi" x-data="{ n: 0 }" x-init="n = $root.querySelectorAll('input[name=repo]:checked').length" @change="n = $root.querySelectorAll('input[name=repo]:checked').length" style="margin-bottom:1.5rem; padding:0.75rem; border:1px solid var(--border); border-radius:4px;">
    <div style="font-size:0.875rem; color:var(--text-secondary); margin-bottom:0.5rem;">
      Multi-repo agent session — tick two or more repos to launch an agent with a fresh worktree per repo (wired together via <code>--add-dir</code>).
    </div>
    <div style="display:flex; flex-direction:column; gap:0.3rem; max-height:14rem; overflow:auto; margin-bottom:0.6rem;">
      ${repoCheckboxes}
    </div>
    <label class="form-field" style="margin-bottom:0.6rem;">
      Agent
      <select name="provider" id="multi-session-provider" class="form-select" @change="onMultiProviderChange()">
        <option value="claude"${defaultMultiProvider === "claude" ? " selected" : ""}>Claude</option>
        <option value="codex"${defaultMultiProvider === "codex" ? " selected" : ""}>Codex</option>
      </select>
    </label>
    <label class="form-field" style="margin-bottom:0.6rem;">
      Model
      ${renderModelSelect("claude", "multi-session-model-claude", defaultMultiProvider === "claude")}
      ${renderModelSelect("codex", "multi-session-model-codex", defaultMultiProvider === "codex")}
      <input type="text" name="modelCustom" id="multi-session-model-custom" class="form-select" placeholder="e.g. openrouter/anthropic/claude-opus-4" style="display:none" disabled>
    </label>
    ${capFieldsetMulti}
    <button type="submit" class="trigger-btn" :disabled="n < 2">Create Multi-repo Session</button>
  </form>`;

  const activeSessions = sessions.filter((s) => s.alive);
  const activeHtml = activeSessions.length === 0
    ? `<p>No active sessions.</p>`
    : renderSessionsTable(activeSessions, "active-sessions-table", false);
  const allSessionsHtml = sessions.length === 0 ? "" : `
  <h2>All Sessions</h2>
  <div class="filter-bar" id="session-status-filter">
    <a href="#" class="active" data-status="all" @click="setSessionFilter('all', $event)">All</a>
    <a href="#" data-status="running" @click="setSessionFilter('running', $event)">Active</a>
    <a href="#" data-status="ended" @click="setSessionFilter('ended', $event)">Ended</a>
  </div>
  <div class="search-bar">
    <input type="search" id="session-search" aria-label="Filter sessions" placeholder="Filter by id, repo, directory or summary" @input="applySessionFilters()">
  </div>
  ${renderSessionsTable(sessions, "all-sessions-table", true)}
  <p id="session-filter-empty" style="display:none; color: var(--text-secondary);">No sessions match this filter.</p>`;

  return `<!DOCTYPE html>
${htmlOpenTag(theme, "wide")}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${HEAD_META}
  <title>Sessions — Claws</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
    .cap-group { margin-bottom: 0.4rem; }
    .cap-group-title { display: block; font-size: 0.75rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 0.2rem; }
  </style>
  ${ALPINE_SCRIPT}
</head>
<body x-data="sessionsListPage()" x-init="onRepoChange()">
  ${buildPageHeader("Sessions", theme)}
  ${THEME_SCRIPT}
  <h2>Active Sessions</h2>
  ${activeHtml}
  <h2>New Session</h2>
  <form method="POST" action="/sessions/create" style="margin-bottom: 1.5rem; padding: 0.75rem; border: 1px solid var(--border); border-radius: 4px; display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-end;">
    <label class="form-field">
      Working directory
      <select name="repo" id="session-repo" class="form-select" @change="onRepoChange()">
        <option value="">Home directory</option>
        ${repoOptions}
      </select>
    </label>
    <label class="form-field">
      Mode
      <select name="mode" id="session-mode" class="form-select" @change="onModeChange()">
        <option value="repo-zsh">zsh in repo</option>
        <option value="repo-claude">Agent in repo (plain)</option>
        <option value="worktree-claude"${defaultRepo ? " selected" : ""}>Agent in new worktree</option>
        <option value="home-claude"${!defaultRepo ? " selected" : ""}>Agent (home directory)</option>
      </select>
    </label>
    <label class="form-field" data-agentless="false">
      Agent
      <select name="provider" id="session-provider" class="form-select" @change="onProviderChange()">
        <option value="claude"${defaultProvider === "claude" ? " selected" : ""}>Claude</option>
        <option value="codex"${defaultProvider === "codex" ? " selected" : ""}>Codex</option>
        <option value="opencode"${defaultProvider === "opencode" ? " selected" : ""}>OpenCode</option>
      </select>
    </label>
    <label class="form-field" data-agentless="false">
      Model
      ${renderModelSelect("claude", "session-model-claude", defaultProvider === "claude")}
      ${renderModelSelect("codex", "session-model-codex", defaultProvider === "codex")}
      ${renderModelSelect("opencode", "session-model-opencode", defaultProvider === "opencode")}
      <input type="text" name="modelCustom" id="session-model-custom" class="form-select" placeholder="e.g. openrouter/anthropic/claude-opus-4" style="display:none" disabled>
      <datalist id="opencode-model-options"></datalist>
    </label>
    ${capFieldsetSingle}
    <button type="submit" class="trigger-btn">Create Session</button>
  </form>
  ${multiForm}
  ${allSessionsHtml}
  ${SESSIONS_LIST_SCRIPT}
</body>
</html>`;
}

export function buildSessionTerminalPage(
  theme: Theme,
  session: {
    id: string; repo: string | null; cwd: string; alive: boolean; provider?: string; summary?: string | null;
    /**
     * Every configured capability with its live-grant state (#3072, #3322): held and
     * fixed entries render disabled with a suffix — "(granted)" for an ordinary held
     * entry, or the carried `reason` when set (e.g. "(always granted)" for the
     * `cross-repo` baseline, #3372); the control is hidden only when empty.
     */
    capabilityOptions?: Array<{ id: string; label: string; group?: string; state: "held" | "grantable" | "fixed"; reason?: string }>;
  },
): string {
  const desc = session.summary ?? "";
  const capOptions = session.capabilityOptions ?? [];
  const grouped = CAPABILITY_GROUPS.map(({ id: groupId, label: groupLabel }) => ({
    groupLabel,
    caps: capOptions.filter((cap) => (cap.group ?? "tools") === groupId),
  }));
  // A disabled first option would otherwise be the select's default value.
  const firstGrantable = grouped.flatMap((g) => g.caps).find((cap) => cap.state === "grantable")?.id;
  const grantOption = (cap: { id: string; label: string; state: "held" | "grantable" | "fixed"; reason?: string }) => {
    if (cap.state === "held") {
      return `<option value="${escapeHtml(cap.id)}" disabled>${escapeHtml(`${cap.label} (${cap.reason ?? "granted"})`)}</option>`;
    }
    if (cap.state === "fixed") {
      const reason = cap.reason ?? "not grantable to a running session";
      return `<option value="${escapeHtml(cap.id)}" disabled title="${escapeHtml(reason)}">${escapeHtml(`${cap.label} (${reason})`)}</option>`;
    }
    return `<option value="${escapeHtml(cap.id)}"${cap.id === firstGrantable ? " selected" : ""}>${escapeHtml(cap.label)}</option>`;
  };
  const grantOptions = grouped.map(({ groupLabel, caps }) =>
    caps.length === 0 ? "" : `<optgroup label="${escapeHtml(groupLabel)}">${caps.map(grantOption).join("")}</optgroup>`,
  ).join("");
  const grantControl = capOptions.length === 0 ? "" : `
      <span id="grant-cap" class="grant-cap">
        <select id="grant-cap-select" class="form-select grant-cap-select" aria-label="Capability to grant">${grantOptions}</select>
        <button id="grant-cap-btn" type="button" class="trigger-btn"${firstGrantable === undefined ? " disabled" : ""}>Grant capability</button>
      </span>`;
  const descHtml = desc ? escapeHtml(desc) : "<em>No description</em>";
  const sessionProvider = session.provider ?? "claude";
  const isCodexSession = sessionProvider === "codex";
  const commonMobileKeys = `
    <button type="button" class="kb-key" data-key="esc">Esc</button>
    <button type="button" class="kb-key" data-key="tab">Tab</button>
    <button type="button" class="kb-key" data-key="enter">Enter</button>
    <button type="button" class="kb-key" data-action="font-dec" aria-label="Decrease terminal font">A&#x2212;</button>
    <button type="button" class="kb-key" data-action="font-inc" aria-label="Increase terminal font">A+</button>`;
  const codexMobileKeys = `
    <button type="button" class="kb-key" data-key="codex-followup" aria-label="Answer Codex follow-up question">Answer</button>`;
  const commandMobileKeys = `
    <button type="button" class="kb-key" data-key="ship" aria-label="Send /ship">/ship</button>`;
  const utilityMobileKeys = `
    <button type="button" class="kb-key" data-action="ctrl-d-double" aria-label="Ctrl+D twice (exit)">^D&#xD7;2</button>
    <button type="button" class="kb-key" data-key="ctrl-d">^D</button>
    <button type="button" class="kb-key" data-key="up">↑</button>
    <button type="button" class="kb-key" data-key="down">↓</button>
    <button type="button" class="kb-key" data-key="left">←</button>
    <button type="button" class="kb-key" data-key="right">→</button>
    <button type="button" class="kb-key" data-action="ctrl">Ctrl</button>
    <button type="button" class="kb-key" data-key="home">Home</button>
    <button type="button" class="kb-key" data-key="end">End</button>
    <button type="button" class="kb-key" data-action="page-up" aria-label="Scroll up one page">PgUp</button>
    <button type="button" class="kb-key" data-action="page-down" aria-label="Scroll down one page">PgDn</button>
    <button type="button" class="kb-key" data-action="scroll-bottom" aria-label="Scroll to bottom">&#x2913;</button>
    <button type="button" class="kb-key" data-key="ctrl-c">^C</button>
    <button type="button" class="kb-key" data-key="ctrl-z">^Z</button>
    <button type="button" class="kb-key" data-key="ctrl-l">^L</button>`;
  return `<!DOCTYPE html>
${htmlOpenTag(theme, "full")}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${HEAD_META}
  <title>Session ${escapeHtml(session.id.slice(0, 8))} — Claws</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
    html, body { overscroll-behavior: none; }
    body { display: flex; flex-direction: column; height: 100vh; height: 100dvh; margin: 0; padding: 0; overflow: hidden; }
    #terminal { flex: 1; overflow: hidden; touch-action: none; overscroll-behavior: none; }
    .xterm-viewport { overscroll-behavior: none; }
    .session-bar { padding: 0.4rem 1rem; font-size: 0.85rem; color: var(--text); border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 0.35rem; }
    .session-bar-row { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
    .session-bar-desc { flex-wrap: nowrap; }
    .session-bar-actions { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
    .session-bar-actions::-webkit-scrollbar { display: none; }
    .session-bar-actions > * { flex: 0 0 auto; white-space: nowrap; }
    #session-desc-view { display: flex; min-width: 0; flex: 1 1 auto; }
    .session-desc-text { color: var(--text-secondary); font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-dir { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; }
    #mobile-keybar { display: none; }
    .kb-key { min-width: 2.5rem; min-height: 2.25rem; padding: 0.3rem 0.55rem; font: 0.9rem/1 monospace; background: var(--bg-elev); color: var(--text); border: 1px solid var(--border); border-radius: 4px; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; flex: 0 0 auto; cursor: pointer; }
    .kb-key[data-active="true"] { background: var(--text); color: var(--bg); }
    .kb-key[data-pressed] { background: var(--btn-hover); }
    @media (hover: none) and (pointer: coarse) {
      #mobile-keybar { display: flex; overflow-x: auto; gap: 0.25rem; padding: 0.25rem 0.4rem; border-top: 1px solid var(--border); flex: 0 0 auto; -webkit-overflow-scrolling: touch; }
    }
    @media (max-width: 900px) {
      #mobile-keybar { display: flex; overflow-x: auto; gap: 0.25rem; padding: 0.25rem 0.4rem; border-top: 1px solid var(--border); flex: 0 0 auto; -webkit-overflow-scrolling: touch; }
    }
    /* Compact terminal chrome: keep tablets and constrained terminal windows focused on xterm. */
    @media (hover: none) and (pointer: coarse), (max-width: 900px), (max-width: 1200px) and (max-height: 900px) {
      nav { display: none; }
      .session-dir { display: none; }
      .session-bar { padding: 0.35rem 0.6rem; font-size: 0.8rem; }
      .session-bar-actions { gap: 0.3rem; }
      .session-bar-actions .trigger-btn { font-size: 0.72rem; padding: 0.3rem 0.45rem; }
    }
    @media (max-width: 768px) {
      .kb-key { font-size: 0.8rem; min-width: 2.2rem; min-height: 2rem; }
    }
    #copy-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.6); display: none; flex-direction: column; padding: 1rem; box-sizing: border-box; }
    .copy-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .copy-panel-bar { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; color: var(--text); }
    #copy-textarea { flex: 1; min-height: 0; width: 100%; box-sizing: border-box; border: 0; resize: none; padding: 0.5rem 0.75rem; font: 0.85rem/1.3 monospace; background: var(--bg); color: var(--text); white-space: pre-wrap; word-break: break-word; -webkit-user-select: text; user-select: text; overflow: auto; }
    #drop-overlay { position: fixed; inset: 0; z-index: 1100; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.55); border: 2px dashed var(--accent); box-sizing: border-box; color: var(--text); font-size: 1rem; text-align: center; padding: 1rem; pointer-events: none; }
    #drop-overlay[data-active="true"] { display: flex; }
    #upload-toast { position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%); z-index: 1200; display: none; align-items: center; gap: 0.5rem; max-width: 90vw; padding: 0.5rem 0.9rem; background: var(--bg-secondary); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 4px; font-size: 0.85rem; color: var(--text); }
    #upload-toast[data-error="true"] { border-left-color: var(--danger); }
    #upload-toast-msg { min-width: 0; overflow-wrap: anywhere; }
    .toast-close { background: none; border: 0; color: var(--text-secondary); min-width: 30px; min-height: 30px; flex: 0 0 auto; cursor: pointer; font-size: 1.1rem; line-height: 1; margin-right: -0.4rem; }
    .toast-close:hover, .toast-close:focus-visible { color: var(--text); }
    #mic-btn { min-width: 5.7rem; }
    #mic-btn[data-recording="true"] { border-color: var(--danger); color: var(--danger); }
    #mic-btn[data-processing="true"] { border-color: var(--warning); color: var(--warning); }
    .grant-cap { display: inline-flex; align-items: center; gap: 0.35rem; }
    .grant-cap-select { width: auto; min-height: 30px; padding: 0.2rem 0.4rem; font-size: 0.8rem; }
    .grant-cap-status { flex-wrap: wrap; overflow-wrap: anywhere; min-width: 0; color: var(--text-secondary); }
    .grant-cap-status[hidden] { display: none; }
    .grant-cap-status[data-error="true"] { color: var(--danger); }
    .startup-status { flex-wrap: wrap; overflow-wrap: anywhere; min-width: 0; padding: 0.3rem 0.55rem; background: var(--bg-secondary); border: 1px solid var(--border); border-left: 3px solid var(--warning); border-radius: 4px; color: var(--text-secondary); }
    .startup-status[data-state="ready"] { border-left-color: var(--success); }
    .startup-status[data-state="failed"], .startup-status[data-state="ended"] { border-left-color: var(--danger); color: var(--text); }
    .startup-status[hidden] { display: none; }
    .cap-requests { display: flex; flex-direction: column; gap: 0.35rem; }
    .cap-requests[hidden] { display: none; }
    .cap-request { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.5rem; padding: 0.35rem 0.6rem; background: var(--warn-banner-bg); border: 1px solid var(--warn-banner-border); border-radius: 6px; font-size: 0.8rem; color: var(--text); }
    .cap-request-text { flex: 1 1 12rem; min-width: 0; overflow-wrap: anywhere; }
    .cap-request-text strong { color: var(--warning); }
    .cap-request-error { flex-basis: 100%; color: var(--danger); }
    .cap-request-error[hidden] { display: none; }
  </style>
  ${ALPINE_SCRIPT}
  ${ERROR_HANDLER_SCRIPT}
  ${AUTH_WATCH_SCRIPT}
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css" integrity="sha384-8Xk9wy/gzEDUKrXtrmCFa2bBuK3BpjpDuL/p0SeKQX19Khl/M+lHOgD/CyYf7efP" crossorigin="anonymous">
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js" integrity="sha384-M169f14mRZOXm3hD/v2Ti0ThIT/RnAQagXA9nlE15yHAtrW19gdePJh/HaTzUOe/" crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.js" integrity="sha384-txoiwu4RR2GD3qySbaj+BbzibkLbSJRcfqGYMu6z1EqHil4A2dyBiBW5dlacG6OR" crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.12.0/lib/addon-web-links.js" integrity="sha384-0IIwkXq0LAkIxEVKxlOxWbje2g/VT+5CzVTZiEukyiZ02pOl/O+M0fkpEKAYqto9" crossorigin="anonymous"></script>
</head>
<!-- Terminal page intentionally omits the *visible* standard page header (subtitle):
     it runs a full-bleed xterm.js view, and the session-bar below provides navigation
     back to /sessions. Head-injected scripts that buildPageHeader would otherwise carry
     (ERROR_HANDLER_SCRIPT, AUTH_WATCH_SCRIPT) are emitted explicitly in <head> above —
     do not drop them. Without auth-watch, an expired claws_session leaves this page with
     a dead WebSocket and no recovery (#2627). The shared nav (hamburger, wordmark and
     profile dropdown, all one bar) is rendered but hidden in compact terminal mode
     (#2771, #3191) for phones, tablets, touch devices, and constrained terminal windows:
     this full-bleed page cannot spare the vertical chrome, and the "← Back" link reaches
     /sessions, which shows the nav and the theme picker at any width. It stays visible on
     larger desktop viewports, so buildNav(theme) and THEME_SCRIPT must both remain. -->
<body>
  ${buildNav(theme)}
  <div class="session-bar">
    <div class="session-bar-row session-bar-desc">
      <span id="session-desc-view"><span id="session-desc-text" class="session-desc-text" title="${escapeHtml(desc)}">${descHtml}</span></span>
      <span class="session-dir"><code>${escapeHtml(session.cwd)}</code></span>
    </div>
    <div class="session-bar-row session-bar-actions">
      <a href="/sessions">← Back</a>
      <button id="session-desc-set-title" type="button" class="trigger-btn">Set Title</button>
      <button id="paste-btn" class="trigger-btn">Paste</button>
      <button id="copy-btn" class="trigger-btn">Copy</button>
      <button id="attach-btn" class="trigger-btn">Attach</button><input id="attach-input" type="file" multiple style="display:none">
      <button id="mic-btn" class="trigger-btn" type="button">Record</button>${grantControl}
    </div>
    ${capOptions.length === 0 ? "" : `<div id="grant-cap-status" class="session-bar-row grant-cap-status" role="status" hidden></div>`}
    <div id="startup-status" class="session-bar-row startup-status" role="status" hidden></div>
    <div id="cap-requests" class="cap-requests" role="status" hidden></div>
  </div>
  <div id="terminal" data-session-id="${escapeHtml(session.id)}" data-session-alive="${session.alive ? "true" : "false"}" data-session-provider="${escapeHtml(sessionProvider)}"></div>
  <div id="drop-overlay"><span>Drop file to attach — audio is transcribed, anything else inserts its path</span></div>
  <div id="upload-toast"><span id="upload-toast-msg" role="status"></span><button id="upload-toast-close" type="button" class="toast-close" aria-label="Dismiss notification">×</button></div>
  <div id="mobile-keybar">
    ${commonMobileKeys}
    ${isCodexSession ? codexMobileKeys : commandMobileKeys}
    ${utilityMobileKeys}
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

export interface EndedSessionPageData {
  id: string;
  repo: string | null;
  extraRepos: string[];
  cwd: string;
  mode: string;
  provider: string;
  createdAt: number;
  endedAt: number;
  summary: string | null;
  exitCode: number | null;
  lastOutput: string | null;
  failureReason: string | null;
}

function formatAbsolute(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

/**
 * Read-only page for an ended session (#3311): what it ran, how it exited, and
 * the final terminal output saved when it ended, so a crash stays diagnosable
 * after its runtime is gone. Revive relaunches it.
 */
export function buildEndedSessionPage(theme: Theme, ended: EndedSessionPageData): string {
  const where = ended.repo
    ? [ended.repo, ...ended.extraRepos].map((r) => `<span title="${escapeHtml(r)}">${escapeHtml(repoShortName(r))}</span>`).join(", ")
    : `<code>${escapeHtml(ended.cwd)}</code>`;
  const agent = ended.mode === "repo-zsh" ? "zsh" : providerLabel(ended.provider);
  const exit = ended.exitCode === null ? "unknown" : String(ended.exitCode);
  const rows: Array<[string, string]> = [
    [ended.repo ? "Repo" : "Directory", where],
    ["Agent", escapeHtml(agent)],
    ["Created", escapeHtml(formatAbsolute(ended.createdAt))],
    ["Ended", escapeHtml(formatAbsolute(ended.endedAt))],
    ["Exit code", `<span${ended.exitCode ? ` class="session-exit-failed"` : ""}>${escapeHtml(exit)}</span>`],
    ...(ended.failureReason ? [["Failure", escapeHtml(ended.failureReason)] as [string, string]] : []),
    ...(ended.summary ? [["Summary", escapeHtml(ended.summary)] as [string, string]] : []),
  ];
  const details = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join("");
  const output = ended.lastOutput
    ? `<pre class="session-last-output">${escapeHtml(ended.lastOutput)}</pre>`
    : `<p class="session-last-output-empty">No output was captured for this session.</p>`;
  const id = escapeHtml(ended.id);
  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${HEAD_META}
  <title>Session ended — Claws</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
    .session-ended-meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.3rem 1rem; margin: 1rem 0; font-size: 0.9rem; }
    .session-ended-meta dt { color: var(--text-secondary); }
    .session-ended-meta dd { margin: 0; overflow-wrap: anywhere; }
    .session-exit-failed { color: var(--danger); font-weight: 600; }
    .session-ended-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1rem 0 1.5rem; }
    .session-last-output { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 0.8rem; line-height: 1.4; white-space: pre-wrap; overflow: auto; max-height: 70vh; padding: 0.75rem; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 4px; margin: 0; }
    .session-last-output-empty { color: var(--text-secondary); }
  </style>
</head>
<body>
  ${buildPageHeader("Session ended", theme)}
  ${THEME_SCRIPT}
  <p>This session is no longer running. Claws keeps it in history; reviving rebuilds its worktree at the same path and reattaches the agent's conversation.</p>
  <dl class="session-ended-meta"><dt>ID</dt><dd><code>${id}</code></dd>${details}</dl>
  <div class="session-ended-actions">
    <form method="post" action="/sessions/${id}/resume" style="display:inline" onsubmit="var b=this.querySelector('button'); if(b) b.textContent='Working…';"><button class="trigger-btn" type="submit">Revive session</button></form>
    <a class="trigger-btn" href="/sessions">← All sessions</a>
  </div>
  <h2>Last output</h2>
  ${output}
</body>
</html>`;
}
