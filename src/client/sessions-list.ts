import { applyNav, type NavEntry } from "./lib/nav-count.js";
import { currentXtermTheme, type XtermTheme } from "./lib/xterm-theme.js";

// Alpine.js component factory for the /sessions page. Exposed on `window` so
// Alpine's `x-data="sessionsListPage()"` directive can find it. Alpine itself
// is loaded separately via ALPINE_SCRIPT.
interface SessionsListPage {
  killSession(id: string): Promise<void>;
  switchAccount(id: string, ev: Event): Promise<void>;
  decideCapRequest(id: string, cap: string, approve: boolean, ev: Event): Promise<void>;
  togglePreview(id: string, ev: Event): Promise<void>;
  deleteSession(id: string): Promise<void>;
  resumeSession(id: string): Promise<void>;
  refreshSessions(): Promise<void>;
  startSessionsPolling(): void;
  bindActiveSessionClicks(): void;
  onRepoChange(): void;
  onModeChange(): void;
  onProviderChange(): void;
  onModelChange(): void;
  capDefaultsKey: string | null;
  capUserTicked: string[];
  onCapChange(ev: Event): void;
  capDefaultsApplied: boolean;
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
  // No agent means nobody to send an Initial prompt to; a disabled textarea is not submitted.
  const initialPrompt = document.getElementById("session-initial-prompt") as HTMLTextAreaElement | null;
  if (initialPrompt) {
    initialPrompt.disabled = agentless;
    initialPrompt.title = agentless ? "zsh sessions do not run an agent" : "";
    const promptField = initialPrompt.closest("label");
    if (promptField) promptField.setAttribute("data-agentless", agentless ? "true" : "false");
    // Nor anyone to read attached files: the attach control greys out with it, and the
    // staged ids are not submitted (the server drops them for zsh anyway).
    const form = initialPrompt.closest("form");
    if (form) setAttachDisabled(form, agentless);
  }
  syncModelChoice();
}

// ── Attachments for the Initial prompt ──
// Picked or dropped files upload at once to a staging store (/sessions/attachments);
// each success adds a chip and a hidden `attachment` input, and the server names the
// files' pod paths after the prompt when the session is created. Create stays
// disabled while an upload runs or a rejection is still on screen, so a session is
// never created with a silently dropped file. Same limits and wording as the
// session page's terminal attachments.

const MAX_INLINE_ATTACH_BYTES = 10 * 1024 * 1024;
const MAX_ATTACH_BYTES = 1024 * 1024 * 1024;

interface AttachState {
  busy: number;
  errors: string[];
  disabled: boolean;
  dragDepth: number;
}

const attachStates = new WeakMap<HTMLFormElement, AttachState>();

function attachState(form: HTMLFormElement): AttachState {
  let state = attachStates.get(form);
  if (!state) {
    state = { busy: 0, errors: [], disabled: false, dragDepth: 0 };
    attachStates.set(form, state);
  }
  return state;
}

function formatAttachSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function attachBlocked(state: AttachState): boolean {
  return state.busy > 0 || state.errors.length > 0;
}

function syncAttachSubmit(form: HTMLFormElement): void {
  const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  if (submit) submit.disabled = attachBlocked(attachState(form));
}

function renderAttachStatus(form: HTMLFormElement): void {
  const status = form.querySelector("[data-attach-status]") as HTMLElement | null;
  if (!status) return;
  const state = attachState(form);
  status.textContent = "";
  if (state.errors.length > 0) {
    status.setAttribute("data-error", "true");
    status.appendChild(document.createTextNode(state.errors.join(" · ")));
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "trigger-btn";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", (ev) => {
      ev.preventDefault();
      state.errors = [];
      renderAttachStatus(form);
      syncAttachSubmit(form);
    });
    status.appendChild(dismiss);
  } else {
    status.setAttribute("data-error", "false");
    if (state.busy > 0) status.textContent = "Uploading " + state.busy + (state.busy === 1 ? " file…" : " files…");
  }
}

function setAttachDisabled(form: HTMLFormElement, disabled: boolean): void {
  const state = attachState(form);
  state.disabled = disabled;
  const btn = form.querySelector("[data-attach-btn]") as HTMLButtonElement | null;
  const input = form.querySelector("[data-attach-input]") as HTMLInputElement | null;
  const title = disabled ? "zsh sessions do not run an agent" : "";
  if (btn) { btn.disabled = disabled; btn.title = title; }
  if (input) input.disabled = disabled;
  const hidden = form.querySelectorAll('[data-attach-inputs] input[name="attachment"]');
  for (let i = 0; i < hidden.length; i++) (hidden[i] as HTMLInputElement).disabled = disabled;
  const chips = form.querySelectorAll(".session-attachment button");
  for (let i = 0; i < chips.length; i++) (chips[i] as HTMLButtonElement).disabled = disabled;
}

interface StagedAttachment { id: string; name: string; size: number }

function stageLarge(file: File): Promise<{ attachment?: StagedAttachment; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/sessions/attachments/stream?name=" + encodeURIComponent(file.name));
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.onload = () => {
      try {
        const json = JSON.parse(xhr.responseText) as { attachment?: StagedAttachment; error?: string };
        resolve(xhr.status >= 200 && xhr.status < 300 ? json : { error: json.error ?? "Upload failed (" + xhr.status + ")" });
      } catch { resolve({ error: "Upload failed (" + xhr.status + ")" }); }
    };
    xhr.onerror = () => resolve({ error: "Upload failed — connection lost" });
    xhr.onabort = () => resolve({ error: "Upload cancelled" });
    xhr.send(file);
  });
}

async function stageFile(file: File): Promise<{ attachment?: StagedAttachment; error?: string }> {
  if (file.size === 0) return { error: file.name + ": empty file or folder — not uploaded" };
  if (file.size > MAX_ATTACH_BYTES) return { error: file.name + " is larger than 1 GB" };
  if (file.size > MAX_INLINE_ATTACH_BYTES) {
    const result = await stageLarge(file);
    return result.error ? { error: file.name + ": " + result.error } : result;
  }
  const fd = new FormData();
  fd.append("file", file, file.name);
  const res = await fetch("/sessions/attachments", { method: "POST", body: fd });
  let json: { attachment?: StagedAttachment; error?: string } = {};
  try { json = (await res.json()) as typeof json; } catch { /* malformed body */ }
  if (!res.ok || !json.attachment) return { error: file.name + ": " + (json.error ?? "Upload failed (" + res.status + ")") };
  return json;
}

function addAttachmentChip(form: HTMLFormElement, staged: StagedAttachment): void {
  const list = form.querySelector("[data-attach-list]");
  const inputs = form.querySelector("[data-attach-inputs]");
  if (!list || !inputs) return;
  const hidden = document.createElement("input");
  hidden.type = "hidden";
  hidden.name = "attachment";
  hidden.value = staged.id;
  inputs.appendChild(hidden);
  const chip = document.createElement("span");
  chip.className = "session-attachment";
  chip.setAttribute("role", "listitem");
  const name = document.createElement("span");
  name.className = "session-attachment-name";
  name.textContent = staged.name;         // never innerHTML: a filename is user input
  name.title = staged.name;
  const size = document.createElement("span");
  size.className = "session-attachment-size";
  size.textContent = formatAttachSize(staged.size);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "×";
  remove.setAttribute("aria-label", "Remove " + staged.name);
  remove.addEventListener("click", (ev) => {
    ev.preventDefault();
    chip.remove();
    hidden.remove();
    void fetch("/sessions/attachments/" + encodeURIComponent(staged.id) + "/delete", { method: "POST" }).catch(() => {});
  });
  chip.appendChild(name);
  chip.appendChild(size);
  chip.appendChild(remove);
  list.appendChild(chip);
}

async function attachFiles(form: HTMLFormElement, files: FileList | File[]): Promise<void> {
  const state = attachState(form);
  if (state.disabled) return;
  const list = Array.from(files);
  if (list.length === 0) return;
  state.busy += list.length;
  renderAttachStatus(form);
  syncAttachSubmit(form);
  for (const file of list) {
    let result: { attachment?: StagedAttachment; error?: string };
    try {
      result = await stageFile(file);
    } catch (err) {
      result = { error: file.name + ": upload failed — " + String(err) };
    }
    state.busy--;
    if (result.attachment) addAttachmentChip(form, result.attachment);
    else state.errors.push(result.error ?? file.name + ": upload failed");
    renderAttachStatus(form);
    syncAttachSubmit(form);
  }
}

function hasDraggedFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).indexOf("Files") !== -1;
}

function initAttachForm(form: HTMLFormElement): void {
  const row = form.querySelector("[data-attach-row]") as HTMLElement | null;
  const btn = form.querySelector("[data-attach-btn]") as HTMLButtonElement | null;
  const input = form.querySelector("[data-attach-input]") as HTMLInputElement | null;
  if (!row || !btn || !input) return;
  row.hidden = false;
  const state = attachState(form);
  btn.addEventListener("click", (ev) => {
    // Inside the prompt's <label>: keep the click from also focusing the textarea.
    ev.preventDefault();
    if (!state.disabled) input.click();
  });
  input.addEventListener("change", () => {
    void attachFiles(form, input.files ?? []);
    input.value = "";
  });
  const overlay = form.querySelector("[data-attach-overlay]");
  form.addEventListener("dragenter", (e: DragEvent) => {
    if (!hasDraggedFiles(e) || state.disabled) return;
    e.preventDefault();
    state.dragDepth++;
    overlay?.setAttribute("data-active", "true");
  });
  form.addEventListener("dragover", (e: DragEvent) => {
    if (!hasDraggedFiles(e) || state.disabled) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  form.addEventListener("dragleave", (e: DragEvent) => {
    if (!hasDraggedFiles(e)) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) overlay?.setAttribute("data-active", "false");
  });
  form.addEventListener("drop", (e: DragEvent) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    state.dragDepth = 0;
    overlay?.setAttribute("data-active", "false");
    if (state.disabled) return;
    void attachFiles(form, e.dataTransfer!.files);
  });
  form.addEventListener("submit", (e) => {
    if (attachBlocked(state)) e.preventDefault();
  });
}

function initAttachForms(): void {
  const forms = document.querySelectorAll("form[data-attach-dropzone]");
  for (let i = 0; i < forms.length; i++) initAttachForm(forms[i] as HTMLFormElement);
  // The mode select may already read "zsh in repo" (a restored form).
  syncAgentAvailability();
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
      custom.placeholder = "e.g. anthropic/claude-sonnet-5-5, or type to search OpenRouter";
      loadOpencodeModelSuggestions();
    } else {
      custom.removeAttribute("list");
      const modelFor = activeEl ? activeEl.getAttribute("data-model-for") : null;
      custom.placeholder = modelFor === "pi"
        ? "e.g. anthropic/claude-opus-5-5"
        : modelFor === "codex"
          ? "e.g. gpt-5-codex"
          : "e.g. claude-sonnet-5-5";
    }
  }
}

// True when `attr` (a label's data-cap-auto-repos value: "*" or a JSON repo
// array) forces the grant given the repos currently ticked.
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

// The ticked repos, in picker order, deduplicated.
function checkedRepoNames(): string[] {
  const repoEl = document.getElementById("session-repo");
  if (!repoEl) return [];
  const boxes = repoEl.querySelectorAll('input[name="repo"]:checked');
  const names: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const name = (boxes[i] as HTMLInputElement).value;
    if (name && names.indexOf(name) === -1) names.push(name);
  }
  return names;
}

// Mirrors sessionCapabilityDefaultsKey in db.ts — keep the plain code-unit
// sort in sync with that one, since localeCompare's collation order varies by
// locale on both ends.
function capDefaultsKey(repos: string[]): string {
  return repos.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n");
}

// The repo grants to pre-tick for the ticked repos, or null to leave the
// boxes alone. One repo: its effective defaults (`data-cap-repos`, remembered
// else static). Several: the set last launched with exactly that combination
// (`data-cap-defaults`); a combination never used before starts without repo
// grants when it replaces a set that was pre-ticked (one repo, or a
// remembered combination), and otherwise keeps the operator's own ticks.
// No repo: none.
function repoCapDefaults(page: SessionsListPage, list: HTMLElement, repos: string[]): Set<string> | null {
  const wasApplied = page.capDefaultsApplied;
  if (repos.length === 0) {
    page.capDefaultsApplied = false;
    return new Set();
  }
  if (repos.length === 1) {
    page.capDefaultsApplied = true;
    const ids = new Set<string>();
    const labels = list.querySelectorAll("label[data-cap]");
    for (let i = 0; i < labels.length; i++) {
      let capRepos: string[] = [];
      try { capRepos = JSON.parse(labels[i].getAttribute("data-cap-repos") || "[]"); } catch { capRepos = []; }
      if (capRepos.indexOf(repos[0]) !== -1) ids.add(labels[i].getAttribute("data-cap") || "");
    }
    return ids;
  }
  let defaults: Record<string, string[]> = {};
  try { defaults = JSON.parse(list.getAttribute("data-cap-defaults") || "{}"); } catch { defaults = {}; }
  const key = capDefaultsKey(repos);
  const remembered = Object.prototype.hasOwnProperty.call(defaults, key) ? defaults[key] : undefined;
  page.capDefaultsApplied = Array.isArray(remembered);
  if (Array.isArray(remembered)) return new Set(remembered);
  return wasApplied ? new Set() : null;
}

// With several repos only "Agent in new worktree" can attach a worktree per
// repo, and only agents that take --add-dir are offered; the server refuses
// the rest. True when it had to switch the Agent.
function syncMultiRepoChoices(multi: boolean): boolean {
  const provider = document.getElementById("session-provider") as HTMLSelectElement | null;
  if (!provider) return false;
  const opts = provider.querySelectorAll("option");
  for (let i = 0; i < opts.length; i++) {
    const opt = opts[i] as HTMLOptionElement;
    opt.disabled = multi && (opt.value === "opencode" || opt.value === "pi");
  }
  const current = provider.options[provider.selectedIndex] as HTMLOptionElement | undefined;
  if (current && current.disabled) {
    provider.value = provider.getAttribute("data-multi-default-provider") || "claude";
    return true;
  }
  return false;
}

// Provider-auth capability boxes (k8s-pod sessions, #3026) carry
// data-cap-provider. Tick the one matching the chosen agent and untick the
// other agents' logins; `null` (a zsh session) unticks them all. Every other
// capability box follows the repo instead.
const AGENT_PROVIDERS = ["claude", "codex", "opencode", "pi"];

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

// How often an open /sessions tab re-fetches its tables, so a session ended
// elsewhere leaves the active list within a few seconds (#clw_01M52FEC8QSM9P57WWSEBYFB7D).
const SESSIONS_POLL_MS = 5000;

// The "id:status[@account][!][?caps]" list of the rows on the page, in the
// form `renderSessionsTables` returns as `signature`.
function currentSessionsSignature(): string {
  const table = document.getElementById("all-sessions-table") || document.getElementById("active-sessions-table");
  if (!table) return "";
  const rows = table.querySelectorAll("tbody tr[data-session-id]");
  const parts: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as HTMLElement;
    const account = row.getAttribute("data-account");
    const pendingCaps = row.getAttribute("data-pending-caps");
    parts.push((row.getAttribute("data-session-id") || "") + ":" + (row.getAttribute("data-status") || "") + (account ? "@" + account : "") + (row.getAttribute("data-account-switchable") === "false" ? "!" : "") + (pendingCaps ? "?" + pendingCaps : ""));
  }
  return parts.join(",");
}

// A failed Switch account's message per session id, put back on its row after
// refreshSessions swaps the tables (#clw_01M623AMK66JB6TBB4PP55Q2V6).
const switchErrors = new Map<string, string>();
// Session ids with a switch request in flight; refreshes rebuild the buttons, so applySwitchErrors re-disables them.
const switchingIds = new Set<string>();

function applySwitchErrors(): void {
  const wrap = document.getElementById("active-sessions");
  if (!wrap) return;
  const rows = wrap.querySelectorAll("tr[data-session-id]");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as HTMLElement;
    const slot = row.querySelector(".session-switch-error");
    const rowId = row.getAttribute("data-session-id") || "";
    if (slot) slot.textContent = switchErrors.get(rowId) || "";
    const btn = row.querySelector(".session-switch-account-btn") as HTMLButtonElement | null;
    if (btn && switchingIds.has(rowId)) {
      btn.setAttribute("aria-busy", "true");
      btn.disabled = true;
    } else if (btn && row.getAttribute("data-account-switchable") !== "false") {
      btn.style.minWidth = "";
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
    }
  }
}

// ── Inline terminal preview (#clw_01M6K7717TJFWCHGQC7MAC4SXS) ──
// A desktop-only, read-only peek at an active session: the pod's visible screen
// polled from /sessions/:id/screen every 2 s and drawn into a small xterm. It is a
// snapshot, never a terminal attach, so the operator's own session is never
// resized or typed into. xterm core is lazy-loaded from the same CDN URL and SRI
// hash the session page uses, read from #active-sessions' data attributes.

interface PreviewTerminal {
  element?: HTMLElement;
  options: { theme: XtermTheme };
  open(el: HTMLElement): void;
  reset(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

type PreviewTerminalCtor = new (opts: {
  cols: number;
  rows: number;
  fontSize: number;
  disableStdin: boolean;
  cursorBlink: boolean;
  scrollback: number;
  theme: XtermTheme;
}) => PreviewTerminal;

interface PreviewState {
  /** The client-built `<tr class="session-preview-row">`, moved across table swaps. */
  rowEl: HTMLTableRowElement;
  wrapEl: HTMLElement;
  termEl: HTMLElement;
  statusEl: HTMLElement;
  term: PreviewTerminal | null;
  timer: number | null;
  /** The last frame drawn (`cols x rows : data`), so an unchanged screen is not redrawn. */
  lastFrame: string;
  stopped: boolean;
}

const PREVIEW_POLL_MS = 2000;
const PREVIEW_MAX_ROWS = 24;
const PREVIEW_UNSUPPORTED = "Preview unavailable for sessions started before this update";
const PREVIEW_UNAVAILABLE = "Session runtime unavailable, retrying";
const PREVIEW_LIBRARY_FAILED = "Terminal library failed to load";

const expandedPreviews = new Map<string, PreviewState>();
let xtermLoad: Promise<boolean> | null = null;
let previewListenersBound = false;

function previewTerminalCtor(): PreviewTerminalCtor | null {
  const ctor = (window as unknown as { Terminal?: unknown }).Terminal;
  return typeof ctor === "function" ? ctor as PreviewTerminalCtor : null;
}

/** Inject xterm's stylesheet and script once; resolves false when the script fails to load. */
function loadXterm(): Promise<boolean> {
  if (previewTerminalCtor()) return Promise.resolve(true);
  if (xtermLoad) return xtermLoad;
  const host = document.getElementById("active-sessions");
  const jsSrc = host?.getAttribute("data-xterm-js") || "";
  if (!jsSrc) return Promise.resolve(false);
  xtermLoad = new Promise<boolean>((resolve) => {
    const cssHref = host?.getAttribute("data-xterm-css") || "";
    if (cssHref) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = cssHref;
      link.integrity = host?.getAttribute("data-xterm-css-integrity") || "";
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = jsSrc;
    script.integrity = host?.getAttribute("data-xterm-js-integrity") || "";
    script.crossOrigin = "anonymous";
    script.onload = () => resolve(previewTerminalCtor() !== null);
    script.onerror = () => {
      // Let a later expand try again.
      script.remove();
      xtermLoad = null;
      resolve(false);
    };
    document.head.appendChild(script);
  });
  return xtermLoad;
}

function activeSessionRow(id: string): HTMLTableRowElement | null {
  const wrap = document.getElementById("active-sessions");
  if (!wrap) return null;
  const rows = wrap.querySelectorAll("tr[data-session-id]");
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].getAttribute("data-session-id") === id) return rows[i] as HTMLTableRowElement;
  }
  return null;
}

function setPreviewToggle(row: Element | null, expanded: boolean): void {
  const btn = row ? row.querySelector(".session-preview-toggle") : null;
  if (!btn) return;
  btn.setAttribute("aria-expanded", expanded ? "true" : "false");
  const label = expanded ? "Hide terminal preview" : "Show terminal preview";
  btn.setAttribute("aria-label", label);
  btn.setAttribute("title", label);
}

function setPreviewStatus(state: PreviewState, text: string): void {
  state.statusEl.textContent = text;
}

/** Place the preview row directly under its session row, spanning every column. */
function placePreviewRow(state: PreviewState, row: HTMLTableRowElement): void {
  const cell = state.rowEl.firstElementChild as HTMLTableCellElement | null;
  const headCols = row.closest("table")?.tHead?.rows[0]?.cells.length;
  if (cell) cell.colSpan = Math.max(1, headCols || row.cells.length);
  row.after(state.rowEl);
  setPreviewToggle(row, true);
}

function buildPreviewState(id: string): PreviewState {
  const rowEl = document.createElement("tr");
  rowEl.className = "session-preview-row";
  rowEl.id = "preview-" + id;
  rowEl.setAttribute("data-preview-for", id);
  const cell = document.createElement("td");
  const statusEl = document.createElement("div");
  statusEl.className = "session-preview-status";
  statusEl.setAttribute("role", "status");
  const wrapEl = document.createElement("div");
  wrapEl.className = "session-preview-wrap";
  // Shown with the first frame, so a status-only preview has no empty box.
  wrapEl.hidden = true;
  const termEl = document.createElement("div");
  termEl.className = "session-preview-term";
  termEl.setAttribute("aria-hidden", "true");
  wrapEl.appendChild(termEl);
  cell.appendChild(statusEl);
  cell.appendChild(wrapEl);
  rowEl.appendChild(cell);
  return { rowEl, wrapEl, termEl, statusEl, term: null, timer: null, lastFrame: "", stopped: false };
}

/** Scale the terminal down to the row's width (never up) and size the box to the scaled screen. */
function fitPreview(state: PreviewState): void {
  const el = state.term?.element;
  if (!el) return;
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const available = state.wrapEl.clientWidth;
  if (!width || !available) return;
  const scale = Math.min(1, available / width);
  state.termEl.style.transformOrigin = "top left";
  state.termEl.style.transform = "scale(" + scale + ")";
  state.wrapEl.style.height = Math.ceil(height * scale) + "px";
}

function bindPreviewListeners(): void {
  if (previewListenersBound) return;
  previewListenersBound = true;
  window.addEventListener("resize", () => {
    expandedPreviews.forEach((state) => fitPreview(state));
  });
  const retheme = (): void => {
    const theme = currentXtermTheme();
    expandedPreviews.forEach((state) => { if (state.term) state.term.options.theme = theme; });
  };
  window.matchMedia?.("(prefers-color-scheme: light)")?.addEventListener?.("change", retheme);
  window.matchMedia?.("(min-width: 1024px)")?.addEventListener?.("change", (ev) => {
    if (!ev.matches) Array.from(expandedPreviews.keys()).forEach((id) => collapsePreview(id));
  });
  new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

function stopPreview(state: PreviewState): void {
  state.stopped = true;
  if (state.timer !== null) window.clearTimeout(state.timer);
  state.timer = null;
}

/** Stop polling, dispose the xterm and remove the preview row. */
function collapsePreview(id: string): void {
  const state = expandedPreviews.get(id);
  if (!state) return;
  expandedPreviews.delete(id);
  stopPreview(state);
  try { state.term?.dispose(); } catch { /* already torn down */ }
  state.rowEl.remove();
  setPreviewToggle(activeSessionRow(id), false);
}

function drawPreviewFrame(state: PreviewState, screen: { cols: number; rows: number; data: string }): void {
  const ctor = previewTerminalCtor();
  if (!ctor) return;
  const cols = Math.max(1, Math.floor(screen.cols));
  const rows = Math.max(1, Math.min(Math.floor(screen.rows), PREVIEW_MAX_ROWS));
  if (!state.term) {
    state.wrapEl.hidden = false;
    state.term = new ctor({ cols, rows, fontSize: 11, disableStdin: true, cursorBlink: false, scrollback: 200, theme: currentXtermTheme() });
    state.term.open(state.termEl);
  }
  const frame = cols + "x" + rows + ":" + screen.data;
  if (frame !== state.lastFrame) {
    const prev = state.lastFrame;
    if (prev && !prev.startsWith(cols + "x" + rows + ":")) state.term.resize(cols, rows);
    // The pane's trailing line end would scroll its first line off; reset and
    // write share one tick, so a pane taller than the preview leaves its latest
    // lines in view. `?25l` hides the cursor: a snapshot has none to show.
    state.term.reset();
    state.term.write(screen.data.replace(/\r\n$/, "") + "\x1b[?25l");
    state.lastFrame = frame;
  }
  fitPreview(state);
}

/** One poll of the screen; schedules the next unless the preview stopped. */
async function pollPreview(id: string, state: PreviewState): Promise<void> {
  state.timer = null;
  if (state.stopped || expandedPreviews.get(id) !== state) return;
  const wide = !window.matchMedia || window.matchMedia("(min-width: 1024px)").matches;
  if (document.visibilityState === "visible" && wide) {
    let res: Response | null = null;
    try {
      res = await fetch("/sessions/" + encodeURIComponent(id) + "/screen");
    } catch {
      res = null;
    }
    if (state.stopped || expandedPreviews.get(id) !== state) return;
    if (res && res.status === 404) {
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      if (body?.code === "unsupported") {
        setPreviewStatus(state, PREVIEW_UNSUPPORTED);
        stopPreview(state);
      } else {
        // The session is gone; the next table refresh drops its row too.
        collapsePreview(id);
      }
      return;
    }
    if (res && res.ok) {
      const body = (await res.json().catch(() => null)) as { cols?: unknown; rows?: unknown; data?: unknown } | null;
      if (state.stopped || expandedPreviews.get(id) !== state) return;
      if (body && typeof body.cols === "number" && typeof body.rows === "number" && typeof body.data === "string") {
        setPreviewStatus(state, "");
        drawPreviewFrame(state, { cols: body.cols, rows: body.rows, data: body.data });
      } else {
        setPreviewStatus(state, PREVIEW_UNAVAILABLE);
      }
    } else {
      setPreviewStatus(state, res && res.status !== 503 ? "Preview failed (HTTP " + res.status + "), retrying" : PREVIEW_UNAVAILABLE);
    }
  }
  if (!state.stopped && expandedPreviews.get(id) === state) {
    state.timer = window.setTimeout(() => { void pollPreview(id, state); }, PREVIEW_POLL_MS);
  }
}

/**
 * After refreshSessions swaps #active-sessions, put each open preview back under
 * its session's new row (keeping its xterm), and drop those whose session left.
 */
function restorePreviews(): void {
  const ids = Array.from(expandedPreviews.keys());
  for (const id of ids) {
    const state = expandedPreviews.get(id)!;
    const row = activeSessionRow(id);
    if (row) {
      placePreviewRow(state, row);
      fitPreview(state);
    } else {
      collapsePreview(id);
    }
  }
}

function sessionsListPage(): SessionsListPage {
  return {
    async killSession(id: string): Promise<void> {
      if (!confirm("End this session? It will be kept in history.")) return;
      const res = await fetch("/sessions/" + encodeURIComponent(id) + "/kill", { method: "POST" });
      if (!res.ok) { alert("Failed to end session: " + (await res.text())); return; }
      await this.refreshSessions();
    },
    async switchAccount(id: string, ev: Event): Promise<void> {
      const btn = (ev.currentTarget || ev.target) as HTMLButtonElement | null;
      if (!btn || switchingIds.has(id)) return;
      if (!confirm("Restart this session's agent on another Claude account? The conversation is kept.")) return;
      switchErrors.delete(id);
      switchingIds.add(id);
      applySwitchErrors();
      btn.style.minWidth = `${btn.getBoundingClientRect().width}px`;
      btn.setAttribute("aria-busy", "true");
      btn.disabled = true;
      let error: string | null = null;
      try {
        const res = await fetch("/sessions/" + encodeURIComponent(id) + "/switch-account", { method: "POST" });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          error = "Switch failed: " + (body?.error || "HTTP " + res.status);
        }
      } catch (err) {
        error = "Switch failed: " + (err instanceof Error ? err.message : String(err));
      }
      switchingIds.delete(id);
      btn.style.minWidth = "";
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
      if (error) switchErrors.set(id, error);
      await this.refreshSessions();
      applySwitchErrors();
      if (error) {
        // A stopped pod leaves the Active list, whose rows alone carry the error slot.
        const sel = '#active-sessions tr[data-session-id="' + id.replace(/["\\]/g, "\\$&") + '"] .session-switch-error';
        if (!document.querySelector(sel)) { switchErrors.delete(id); alert(error); }
      }
    },
    // Grant or Dismiss (deny) a pending capability request from its row
    // (#clw_01M6K7717TJFWCHGQC7MAC4SXS), through the session page's routes.
    async decideCapRequest(id: string, cap: string, approve: boolean, ev: Event): Promise<void> {
      const btn = (ev.currentTarget || ev.target) as HTMLButtonElement | null;
      const block = btn ? (btn.closest(".session-cap-request") as HTMLElement | null) : null;
      if (!btn || !block) return;
      const buttons = Array.prototype.slice.call(block.querySelectorAll("button")) as HTMLButtonElement[];
      if (buttons.some((b) => b.disabled)) return;
      const errorSlot = block.querySelector(".session-cap-request-error");
      if (errorSlot) errorSlot.textContent = "";
      btn.style.minWidth = `${btn.getBoundingClientRect().width}px`;
      for (const b of buttons) b.disabled = true;
      btn.setAttribute("aria-busy", "true");
      let error: string | null = null;
      try {
        const res = await fetch(
          "/sessions/" + encodeURIComponent(id) + "/capability-requests/" + encodeURIComponent(cap) + "/" + (approve ? "approve" : "deny"),
          { method: "POST" },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
          // Already decided elsewhere, or gone: the refresh shows the current state.
          const settled = res.status === 409 || (res.status === 404 && body?.code === "no-request");
          if (!settled) error = body?.error || (approve ? "Grant" : "Dismiss") + " failed (HTTP " + res.status + ")";
        }
      } catch (err) {
        error = (approve ? "Grant" : "Dismiss") + " failed: " + (err instanceof Error ? err.message : String(err));
      }
      if (error) {
        if (errorSlot) errorSlot.textContent = error;
        btn.style.minWidth = "";
        btn.removeAttribute("aria-busy");
        for (const b of buttons) b.disabled = false;
        return;
      }
      await this.refreshSessions();
    },
    // Expand or collapse a row's read-only terminal preview; rows are independent.
    async togglePreview(id: string, _ev: Event): Promise<void> {
      if (expandedPreviews.has(id)) { collapsePreview(id); return; }
      const row = activeSessionRow(id);
      if (!row) return;
      bindPreviewListeners();
      const state = buildPreviewState(id);
      expandedPreviews.set(id, state);
      placePreviewRow(state, row);
      setPreviewStatus(state, "Loading terminal preview…");
      const loaded = await loadXterm();
      if (state.stopped || expandedPreviews.get(id) !== state) return;
      if (!loaded) {
        setPreviewStatus(state, PREVIEW_LIBRARY_FAILED);
        stopPreview(state);
        return;
      }
      await pollPreview(id, state);
    },
    async deleteSession(id: string): Promise<void> {
      if (!confirm("Permanently delete this session from history?")) return;
      const res = await fetch("/sessions/" + encodeURIComponent(id) + "/delete", { method: "POST" });
      if (!res.ok) { alert("Failed to delete session: " + (await res.text())); return; }
      await this.refreshSessions();
    },
    async resumeSession(id: string): Promise<void> {
      const res = await fetch("/sessions/" + encodeURIComponent(id) + "/resume", { method: "POST" });
      if (res.redirected) { location.href = res.url; return; }
      if (!res.ok) { alert("Failed to resume session: " + (await res.text())); return; }
      location.href = "/sessions/" + encodeURIComponent(id);
    },
    // Swap in fresh tables only when a session was added, removed or changed
    // status, so an expanded row is not collapsed by every poll. Alpine binds
    // the inserted rows' @click handlers itself.
    async refreshSessions(): Promise<void> {
      try {
        const res = await fetch("/api/sessions/table");
        if (!res.ok) return;
        const body = (await res.json()) as { signature: string; active: string; all: string; nav?: NavEntry[] };
        // Before the unchanged-signature return: the badge must track the list even when the tables do not change.
        if (body.nav) applyNav(body.nav);
        if (body.signature === currentSessionsSignature()) return;
        const active = document.getElementById("active-sessions");
        if (active) {
          active.innerHTML = body.active;
          restorePreviews();
        }
        const all = document.getElementById("all-sessions-table");
        if (all) {
          const wrap = all.closest(".table-scroll") || all;
          wrap.outerHTML = body.all;
        }
        this.applySessionFilters();
        applySwitchErrors();
      } catch {
        // A missed refresh is retried by the next poll.
      }
    },
    startSessionsPolling(): void {
      setInterval(() => {
        if (document.visibilityState === "visible") void this.refreshSessions();
      }, SESSIONS_POLL_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void this.refreshSessions();
      });
    },
    // One delegated listener on the persistent wrapper so rows swapped in by
    // refreshSessions stay clickable; the title link is the single source of the URL.
    bindActiveSessionClicks(): void {
      const wrap = document.getElementById("active-sessions");
      if (!wrap) return;
      wrap.addEventListener("click", (ev: Event) => {
        const e = ev as MouseEvent;
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        const target = e.target as Element | null;
        if (!target || target.closest("a, button, summary, details, input, select, textarea, label, .session-preview-row")) return;
        const sel = window.getSelection();
        if (sel && sel.toString() !== "") return;
        const row = target.closest("tr[data-session-id]");
        const link = row ? (row.querySelector("a.session-title-link") as HTMLAnchorElement | null) : null;
        if (link) link.click();
      });
    },
    onRepoChange(): void {
      const mode = document.getElementById("session-mode") as HTMLSelectElement | null;
      if (!document.getElementById("session-repo") || !mode) return;
      const repos = checkedRepoNames();
      const repo = repos.length === 1 ? repos[0] : "";
      const multi = repos.length > 1;
      const opts = mode.querySelectorAll("option");
      for (let i = 0; i < opts.length; i++) {
        const opt = opts[i] as HTMLOptionElement;
        const v = opt.value;
        if (multi) {
          opt.disabled = v !== "worktree-claude";
          if (v === "repo-zsh") opt.text = "zsh in repo";
        } else if (repo) {
          opt.disabled = v === "home-claude";
          if (v === "repo-zsh") opt.text = "zsh in repo";
        } else {
          opt.disabled = v === "worktree-claude" || v === "repo-claude";
          if (v === "repo-zsh") opt.text = "zsh (home directory)";
        }
      }
      const current = mode.options[mode.selectedIndex] as HTMLOptionElement | undefined;
      const modeChanged = !!current && current.disabled;
      if (modeChanged) mode.value = repos.length > 0 ? "worktree-claude" : "home-claude";
      const providerChanged = syncMultiRepoChoices(multi);
      syncAgentAvailability();
      if (modeChanged || providerChanged) syncSingleProviderAuthCaps();

      const capList = document.getElementById("single-cap-list");
      if (capList) {
        const labels = capList.querySelectorAll("label[data-cap]");

        // Only a change of repo set re-applies, so manual ticks survive
        // toggles that land back on the same set.
        const key = capDefaultsKey(repos);
        if (this.capDefaultsKey !== key) {
          this.capDefaultsKey = key;
          const defaults = repoCapDefaults(this, capList, repos);
          if (defaults) {
            for (let i = 0; i < labels.length; i++) {
              const label = labels[i] as HTMLElement;
              // Agent logins follow the Agent select, not the repo.
              if (label.hasAttribute("data-cap-provider")) continue;
              const cb = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
              if (cb) {
                const capId = label.getAttribute("data-cap") || "";
                cb.checked = defaults.has(capId) || this.capUserTicked.indexOf(capId) !== -1;
              }
            }
          }
        }

        // Apply/release forced auto-grants last, so neither the repo-relevance
        // filter above nor the defaults reset can untick a forced box (#3372).
        const autoLabels = capList.querySelectorAll("label[data-cap-auto-repos]");
        for (let i = 0; i < autoLabels.length; i++) {
          const label = autoLabels[i] as HTMLElement;
          applyAutoGrant(label, isForcedByAutoRepos(label.getAttribute("data-cap-auto-repos"), repos));
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
    onModelChange(): void {
      syncModelChoice();
    },
    capDefaultsKey: null,
    capDefaultsApplied: false,
    capUserTicked: [],
    // Records operator ticks so a later repo change keeps them ticked.
    onCapChange(ev: Event): void {
      const input = ev.target as HTMLInputElement | null;
      if (!input || input.name !== "capability" || input.disabled) return;
      const label = input.closest("label[data-cap]");
      if (!label || label.hasAttribute("data-cap-provider")) return;
      const id = label.getAttribute("data-cap") || "";
      const idx = this.capUserTicked.indexOf(id);
      if (input.checked && idx === -1) this.capUserTicked.push(id);
      else if (!input.checked && idx !== -1) this.capUserTicked.splice(idx, 1);
    },
    // All Sessions opens on Ended, so resumable sessions are first in reach.
    sessionStatusFilter: "ended",
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

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initAttachForms);
else initAttachForms();

