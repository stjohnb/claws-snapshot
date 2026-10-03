// Alpine.js component factory for the /sessions page. Exposed on `window` so
// Alpine's `x-data="sessionsListPage()"` directive can find it. Alpine itself
// is loaded separately via ALPINE_SCRIPT.
interface SessionsListPage {
  killSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  resumeSession(id: string): Promise<void>;
  onRepoChange(): void;
  onModeChange(): void;
  onProviderChange(): void;
  onMultiProviderChange(): void;
  onMultiRepoChange(): void;
  onModelChange(): void;
  capDefaultsRepo: string | null;
  multiGithubHosted: boolean | null;
  multiDefaultsKey: string | null;
  multiDefaultsRemembered: boolean;
  sessionStatusFilter: string;
  setSessionFilter(status: string, ev: Event): void;
  applySessionFilters(): void;
}

// OpenRouter's catalogue is ~430 models; fetch it once per page load, lazily,
// the first time the OpenCode free-text model box is revealed (#2878).
let opencodeModelsState: "idle" | "loading" | "loaded" = "idle";

function loadOpencodeModelSuggestions(): void {
  if (opencodeModelsState !== "idle") return;
  opencodeModelsState = "loading";
  fetch("/api/opencode/models")
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status))))
    .then((body: { models?: string[] }) => {
      const list = document.getElementById("opencode-model-options") as HTMLDataListElement | null;
      const models = Array.isArray(body.models) ? body.models : [];
      if (!list || models.length === 0) { opencodeModelsState = "idle"; return; }
      const frag = document.createDocumentFragment();
      for (let i = 0; i < models.length; i++) {
        const opt = document.createElement("option");
        opt.value = models[i];          // never innerHTML: ids come from a third-party API
        frag.appendChild(opt);
      }
      list.innerHTML = "";
      list.appendChild(frag);
      opencodeModelsState = "loaded";
    })
    .catch(() => { opencodeModelsState = "idle"; });  // allow a later retry; suggestions are optional
}

// A `repo-zsh` session spawns a plain shell and never launches an agent CLI, so
// the Agent select has no effect on it — grey the whole field out rather than
// letting the form imply the choice matters (#2786).
function syncAgentAvailability(): void {
  const mode = document.getElementById("session-mode") as HTMLSelectElement | null;
  const provider = document.getElementById("session-provider") as HTMLSelectElement | null;
  if (!mode || !provider) return;
  const agentless = mode.value === "repo-zsh";
  provider.disabled = agentless;
  provider.title = agentless ? "zsh sessions do not run an agent" : "";
  const field = provider.closest("label");
  if (field) field.setAttribute("data-agentless", agentless ? "true" : "false");
  syncModelChoice();
}

// Show exactly one model <select> — the one matching the chosen Agent — and
// disable the rest so the browser submits a single `model` value. The free-text
// box only appears for the "Other (type an ID)…" sentinel (#2873).
function syncModelChoice(): void {
  const mode = document.getElementById("session-mode") as HTMLSelectElement | null;
  const provider = document.getElementById("session-provider") as HTMLSelectElement | null;
  const custom = document.getElementById("session-model-custom") as HTMLInputElement | null;
  if (!mode || !provider) return;
  const agentless = mode.value === "repo-zsh";
  const form = provider.closest("form");
  const selects = (form || document).querySelectorAll("select[data-model-for]");
  let activeEl: HTMLSelectElement | null = null;
  for (let i = 0; i < selects.length; i++) {
    const el = selects[i] as HTMLSelectElement;
    const active = !agentless && el.getAttribute("data-model-for") === provider.value;
    el.disabled = !active;
    el.style.display = active ? "" : "none";
    if (active) activeEl = el;
  }
  const field = selects.length > 0 ? (selects[0] as HTMLElement).closest("label") : null;
  if (field) field.setAttribute("data-agentless", agentless ? "true" : "false");
  if (custom) {
    const show = !!activeEl && activeEl.value === "__custom__";
    custom.style.display = show ? "" : "none";
    custom.disabled = !show;
    if (!show) custom.value = "";
    const isOpencode = show && !!activeEl && activeEl.getAttribute("data-model-for") === "opencode";
    if (isOpencode) {
      custom.setAttribute("list", "opencode-model-options");
      custom.placeholder = "openrouter/anthropic/claude-opus-5 — type to search OpenRouter";
      loadOpencodeModelSuggestions();
    } else {
      custom.removeAttribute("list");
      custom.placeholder = "e.g. openrouter/anthropic/claude-opus-4";
    }
  }
}

// The multi-repo form supports Claude and Codex. Show/enable only the model
// select matching its Agent select so exactly one `model` value submits.
function syncMultiModelChoice(): void {
  const provider = document.getElementById("multi-session-provider") as HTMLSelectElement | null;
  const custom = document.getElementById("multi-session-model-custom") as HTMLInputElement | null;
  if (!provider) return;
  const form = provider.closest("form");
  const selects = (form || document).querySelectorAll("select[data-model-for]");
  let activeEl: HTMLSelectElement | null = null;
  for (let i = 0; i < selects.length; i++) {
    const el = selects[i] as HTMLSelectElement;
    const active = el.getAttribute("data-model-for") === provider.value;
    el.disabled = !active;
    el.style.display = active ? "" : "none";
    if (active) activeEl = el;
  }
  if (custom) {
    const show = !!activeEl && activeEl.value === "__custom__";
    custom.style.display = show ? "" : "none";
    custom.disabled = !show;
    if (!show) custom.value = "";
  }
}

// True when `attr` (a label's data-cap-auto-repos value: "*" or a JSON repo
// array) forces the grant given the repo(s) currently in play — the single
// form's selected repo, or the multi form's ticked repos.
function isForcedByAutoRepos(attr: string | null, selectedRepos: string[]): boolean {
  if (attr === null) return false;
  if (attr === "*") return true;
  let list: string[] = [];
  try { list = JSON.parse(attr); } catch { list = []; }
  return selectedRepos.some((r) => list.indexOf(r) !== -1);
}

// Sync a single auto-grant checkbox (cross-repo, or forgejo for a
// Forgejo-hosted repo, #3372) to `forced`: checked and disabled when forced —
// a disabled checkbox is never submitted, so the server union is what
// actually grants it. Releasing a forced box (still disabled from the last
// call, now no longer forced) unticks it back to an ordinary checkbox rather
// than leaving the tick that was never the operator's own; an operator's
// manual tick on a box that was never forced is left alone.
function applyAutoGrant(label: HTMLElement, forced: boolean): void {
  const cb = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  if (cb) {
    if (forced) cb.checked = true;
    else if (cb.disabled) cb.checked = false;
    cb.disabled = forced;
  }
  const note = label.querySelector(".cap-auto-note");
  if (note) {
    const attr = label.getAttribute("data-cap-auto-repos");
    note.textContent = forced ? (attr === "*" ? "always granted" : "auto: Forgejo-hosted repo") : "";
  }
}

// When the ticked repos form a combination the operator has launched before,
// tick exactly that session's capabilities (agent logins aside, which follow
// the Agent select). The key mirrors sessionCapabilityDefaultsKey in db.ts —
// keep the plain code-unit sort in sync with that one, since localeCompare's
// collation order varies by locale on both ends.
// Only a change of combination re-applies, so manual unticks survive toggles
// that land back on the same set. An unknown combination leaves boxes alone,
// UNLESS the combination it replaced was itself remembered — moving out of a
// remembered combination resets every non-provider box to the server-rendered
// fallback (only github-auth, and only for a checked GitHub-hosted repo) so a
// grant carried over from the old combination can't leak into a fresh one.
function syncMultiRememberedCaps(page: SessionsListPage, list: HTMLElement, checkedRepos: NodeListOf<Element>): void {
  const names: string[] = [];
  for (let i = 0; i < checkedRepos.length; i++) {
    const name = (checkedRepos[i] as HTMLInputElement).value;
    if (names.indexOf(name) === -1) names.push(name);
  }
  const key = names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n");
  if (page.multiDefaultsKey === key) return;
  page.multiDefaultsKey = key;
  let defaults: Record<string, string[]> = {};
  try { defaults = JSON.parse(list.getAttribute("data-multi-cap-defaults") || "{}"); } catch { defaults = {}; }
  const remembered = Object.prototype.hasOwnProperty.call(defaults, key) ? defaults[key] : undefined;
  const wasRemembered = page.multiDefaultsRemembered;
  page.multiDefaultsRemembered = Array.isArray(remembered);
  if (!Array.isArray(remembered) && !wasRemembered) return;
  const labels = list.querySelectorAll("label[data-cap]");
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i] as HTMLElement;
    if (label.hasAttribute("data-cap-provider")) continue;
    const cb = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (!cb) continue;
    // A forced auto-grant box (#3372) is managed by applyAutoGrant, not the
    // remembered set — it's disabled, so it was never in a remembered
    // selection to begin with, and untangling it here would just fight
    // onMultiRepoChange's own auto-grant pass.
    if (cb.disabled) continue;
    const capId = label.getAttribute("data-cap") || "";
    let checked: boolean;
    if (Array.isArray(remembered)) {
      checked = remembered.indexOf(capId) !== -1;
    } else if (capId === "github-auth") {
      let repos: string[] = [];
      try { repos = JSON.parse(label.getAttribute("data-cap-repos") || "[]"); } catch { repos = []; }
      checked = names.some((name) => repos.indexOf(name) !== -1);
    } else {
      checked = false;
    }
    cb.checked = checked;
    if (capId === "github-auth") page.multiGithubHosted = checked;
  }
}

// Provider-auth capability boxes (k8s-pod sessions, #3026) carry
// data-cap-provider. Tick the one matching the chosen agent and untick the
// other agents' logins; `null` (a zsh session) unticks them all. Every other
// capability box, including github-auth (#3131), follows the repo instead.
const AGENT_PROVIDERS = ["claude", "codex", "opencode"];

function syncProviderAuthCaps(listId: string, provider: string | null): void {
  const list = document.getElementById(listId);
  if (!list) return;
  const labels = list.querySelectorAll("label[data-cap-provider]");
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i] as HTMLElement;
    const capProvider = label.getAttribute("data-cap-provider") || "";
    if (AGENT_PROVIDERS.indexOf(capProvider) === -1) continue;
    const cb = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (cb) cb.checked = provider !== null && capProvider === provider;
  }
}

function syncSingleProviderAuthCaps(): void {
  const mode = document.getElementById("session-mode") as HTMLSelectElement | null;
  const provider = document.getElementById("session-provider") as HTMLSelectElement | null;
  if (!mode || !provider) return;
  syncProviderAuthCaps("single-cap-list", mode.value === "repo-zsh" ? null : provider.value);
}

function sessionsListPage(): SessionsListPage {
  return {
    async killSession(id: string): Promise<void> {
      if (!confirm("End this session? It will be kept in history.")) return;
      await fetch("/sessions/" + encodeURIComponent(id) + "/kill", { method: "POST" });
      location.reload();
    },
    async deleteSession(id: string): Promise<void> {
      if (!confirm("Permanently delete this session from history?")) return;
      await fetch("/sessions/" + encodeURIComponent(id) + "/delete", { method: "POST" });
      location.reload();
    },
    async resumeSession(id: string): Promise<void> {
      const res = await fetch("/sessions/" + encodeURIComponent(id) + "/resume", { method: "POST" });
      if (res.redirected) { location.href = res.url; return; }
      if (!res.ok) { alert("Failed to resume session: " + (await res.text())); return; }
      location.href = "/sessions/" + encodeURIComponent(id);
    },
    onRepoChange(): void {
      const repoEl = document.getElementById("session-repo") as HTMLSelectElement | null;
      const mode = document.getElementById("session-mode") as HTMLSelectElement | null;
      if (!repoEl || !mode) return;
      const repo = repoEl.value;
      const opts = mode.querySelectorAll("option");
      for (let i = 0; i < opts.length; i++) {
        const opt = opts[i] as HTMLOptionElement;
        const v = opt.value;
        if (repo) {
          opt.disabled = v === "home-claude";
          if (v === "repo-zsh") opt.text = "zsh in repo";
        } else {
          opt.disabled = v === "worktree-claude" || v === "repo-claude";
          if (v === "repo-zsh") opt.text = "zsh (home directory)";
        }
      }
      const current = mode.options[mode.selectedIndex] as HTMLOptionElement | undefined;
      if (current && current.disabled) mode.value = repo ? "worktree-claude" : "home-claude";
      syncAgentAvailability();

      const capList = document.getElementById("single-cap-list");
      if (capList) {
        const showAllEl = document.getElementById("cap-show-all") as HTMLInputElement | null;
        const showAll = !!showAllEl && showAllEl.checked;
        const labels = capList.querySelectorAll("label[data-cap]");
        // Counts only genuinely repo-specific boxes, so the "No repo-specific
        // capabilities" message still reflects that set and not forced auto-grants.
        let visible = 0;
        for (let i = 0; i < labels.length; i++) {
          const label = labels[i] as HTMLElement;
          // Provider-auth boxes follow the Agent select, not the repo.
          if (label.hasAttribute("data-cap-provider")) {
            label.style.display = "inline-flex";
            continue;
          }
          // A forced auto-grant box is always shown, regardless of the repo
          // pre-filter or "Show all". A repo-independent force ("*", e.g.
          // cross-repo) doesn't count as repo-specific, but a repo-list force
          // (e.g. forgejo for a Forgejo-hosted repo) is itself the
          // repo-specific grant and must count so "No repo-specific
          // capabilities" doesn't render alongside it (#3372).
          const autoAttr = label.getAttribute("data-cap-auto-repos");
          if (isForcedByAutoRepos(autoAttr, repo ? [repo] : [])) {
            label.style.display = "inline-flex";
            if (autoAttr !== "*") visible++;
            continue;
          }
          let show = showAll;
          if (!show && repo) {
            let list: string[] = [];
            try { list = JSON.parse(label.getAttribute("data-cap-repos") || "[]"); } catch { list = []; }
            show = list.indexOf(repo) !== -1;
          }
          label.style.display = show ? "inline-flex" : "none";
          if (show) {
            visible++;
          } else {
            const cb = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
            if (cb) cb.checked = false;
          }
        }

        // A group heading must not float above a section with nothing visible in it.
        const groups = capList.querySelectorAll("div[data-cap-group]");
        for (let i = 0; i < groups.length; i++) {
          const group = groups[i] as HTMLElement;
          const groupLabels = group.querySelectorAll("label[data-cap]");
          let anyVisible = false;
          for (let j = 0; j < groupLabels.length; j++) {
            if ((groupLabels[j] as HTMLElement).style.display !== "none") { anyVisible = true; break; }
          }
          group.style.display = anyVisible ? "" : "none";
        }

        const empty = document.getElementById("single-cap-empty");
        if (empty) empty.style.display = visible === 0 && !showAll ? "block" : "none";

        if (this.capDefaultsRepo !== repo) {
          for (let i = 0; i < labels.length; i++) {
            const label = labels[i] as HTMLElement;
            if (label.hasAttribute("data-cap-provider")) continue;
            let list: string[] = [];
            try { list = JSON.parse(label.getAttribute("data-cap-repos") || "[]"); } catch { list = []; }
            const cb = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
            if (cb) cb.checked = !!repo && list.indexOf(repo) !== -1;
          }
          this.capDefaultsRepo = repo;
        }

        // Apply/release forced auto-grants last, so neither the repo-relevance
        // filter above nor the defaults reset can untick a forced box (#3372).
        const autoLabels = capList.querySelectorAll("label[data-cap-auto-repos]");
        for (let i = 0; i < autoLabels.length; i++) {
          const label = autoLabels[i] as HTMLElement;
          applyAutoGrant(label, isForcedByAutoRepos(label.getAttribute("data-cap-auto-repos"), repo ? [repo] : []));
        }
      }
    },
    onModeChange(): void {
      syncAgentAvailability();
      syncSingleProviderAuthCaps();
    },
    onProviderChange(): void {
      syncModelChoice();
      syncSingleProviderAuthCaps();
    },
    onMultiProviderChange(): void {
      syncMultiModelChoice();
      const provider = document.getElementById("multi-session-provider") as HTMLSelectElement | null;
      if (provider) syncProviderAuthCaps("multi-cap-list", provider.value);
    },
    // A Forgejo-only selection has no GitHub-hosted repo for github-auth's token
    // to cover, so a repo tick/untick re-syncs it rather than leaving the
    // server-rendered pre-tick in place regardless of selection (#3136).
    onMultiRepoChange(): void {
      const capList = document.getElementById("multi-cap-list");
      if (!capList) return;
      const form = capList.closest("form");
      const checkedRepos = (form || document).querySelectorAll('input[name="repo"]:checked');
      const label = capList.querySelector('label[data-cap="github-auth"]') as HTMLElement | null;
      if (label) {
        let list: string[] = [];
        try { list = JSON.parse(label.getAttribute("data-cap-repos") || "[]"); } catch { list = []; }
        let anyGithubHosted = false;
        for (let i = 0; i < checkedRepos.length; i++) {
          if (list.indexOf((checkedRepos[i] as HTMLInputElement).value) !== -1) { anyGithubHosted = true; break; }
        }
        // Only write the checkbox when the computed value actually changes, so an
        // operator's deliberate untick survives a later repo toggle that doesn't
        // change which side of the Forgejo/GitHub line the selection falls on.
        if (this.multiGithubHosted !== anyGithubHosted) {
          const cb = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
          if (cb) cb.checked = anyGithubHosted;
          this.multiGithubHosted = anyGithubHosted;
        }
      }

      const checkedRepoNames: string[] = [];
      for (let i = 0; i < checkedRepos.length; i++) checkedRepoNames.push((checkedRepos[i] as HTMLInputElement).value);
      const autoLabels = capList.querySelectorAll("label[data-cap-auto-repos]");
      for (let i = 0; i < autoLabels.length; i++) {
        const autoLabel = autoLabels[i] as HTMLElement;
        applyAutoGrant(autoLabel, isForcedByAutoRepos(autoLabel.getAttribute("data-cap-auto-repos"), checkedRepoNames));
      }

      syncMultiRememberedCaps(this, capList, checkedRepos);
    },
    onModelChange(): void {
      syncModelChoice();
      syncMultiModelChoice();
    },
    capDefaultsRepo: null,
    multiGithubHosted: null,
    multiDefaultsKey: null,
    multiDefaultsRemembered: false,
    sessionStatusFilter: "all",
    setSessionFilter(status: string, ev: Event): void {
      ev.preventDefault();
      this.sessionStatusFilter = status;
      const bar = document.getElementById("session-status-filter");
      if (bar) {
        const links = bar.querySelectorAll("a");
        for (let i = 0; i < links.length; i++) {
          const a = links[i] as HTMLAnchorElement;
          a.className = a.getAttribute("data-status") === status ? "active" : "";
        }
      }
      this.applySessionFilters();
    },
    applySessionFilters(): void {
      const table = document.getElementById("all-sessions-table");
      if (!table) return;
      const searchEl = document.getElementById("session-search") as HTMLInputElement | null;
      const q = (searchEl ? searchEl.value : "").trim().toLowerCase();
      const rows = table.querySelectorAll("tbody tr");
      let visible = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as HTMLElement;
        const rowStatus = row.getAttribute("data-status") || "";
        const hay = row.getAttribute("data-search") || "";
        const show = (this.sessionStatusFilter === "all" || rowStatus === this.sessionStatusFilter)
          && (q === "" || hay.indexOf(q) !== -1);
        row.style.display = show ? "" : "none";
        if (show) visible++;
      }
      const empty = document.getElementById("session-filter-empty");
      if (empty) empty.style.display = visible === 0 ? "block" : "none";
    },
  };
}

(window as unknown as { sessionsListPage: () => SessionsListPage }).sessionsListPage = sessionsListPage;

