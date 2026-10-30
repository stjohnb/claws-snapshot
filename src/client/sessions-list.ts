import { applyNav, type NavEntry } from "./lib/nav-count.js";

// Alpine.js component factory for the /sessions page. Exposed on `window` so
// Alpine's `x-data="sessionsListPage()"` directive can find it. Alpine itself
// is loaded separately via ALPINE_SCRIPT.
interface SessionsListPage {
  killSession(id: string): Promise<void>;
  switchAccount(id: string, ev: Event): Promise<void>;
  deleteSession(id: string): Promise<void>;
  resumeSession(id: string): Promise<void>;
  refreshSessions(): Promise<void>;
  startSessionsPolling(): void;
  bindActiveSessionClicks(): void;
  onRepoChange(): void;
  onModeChange(): void;
  onProviderChange(): void;
  onMultiProviderChange(): void;
  onMultiRepoChange(): void;
  onModelChange(): void;
  capDefaultsRepo: string | null;
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

// The multi-repo form's Create is Alpine-bound (`n < 2 || attachBlocked`), so it hears an
// event; the single-repo form's has no binding and is set directly.
function syncAttachSubmit(form: HTMLFormElement): void {
  const blocked = attachBlocked(attachState(form));
  form.dispatchEvent(new CustomEvent("attach-state", { detail: { blocked } }));
  const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  if (submit && !submit.hasAttribute(":disabled")) submit.disabled = blocked;
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
// remembered combination unticks every non-provider box (the server-rendered
// fallback ticks none) so a grant carried over from the old combination can't
// leak into a fresh one.
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
    cb.checked = Array.isArray(remembered) && remembered.indexOf(capId) !== -1;
  }
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

// The "id:status[@account]" list of the rows on the page, in the form
// `renderSessionsTables` returns as `signature`.
function currentSessionsSignature(): string {
  const table = document.getElementById("all-sessions-table") || document.getElementById("active-sessions-table");
  if (!table) return "";
  const rows = table.querySelectorAll("tbody tr");
  const parts: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as HTMLElement;
    const account = row.getAttribute("data-account");
    parts.push((row.getAttribute("data-session-id") || "") + ":" + (row.getAttribute("data-status") || "") + (account ? "@" + account : "") + (row.getAttribute("data-account-switchable") === "false" ? "!" : ""));
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
        if (active) active.innerHTML = body.active;
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
        if (!target || target.closest("a, button, summary, details, input, select, textarea, label")) return;
        const sel = window.getSelection();
        if (sel && sel.toString() !== "") return;
        const row = target.closest("tr[data-session-id]");
        const link = row ? (row.querySelector("a.session-title-link") as HTMLAnchorElement | null) : null;
        if (link) link.click();
      });
    },
    onRepoChange(): void {
      const repoEl = document.getElementById("session-repo");
      const mode = document.getElementById("session-mode") as HTMLSelectElement | null;
      if (!repoEl || !mode) return;
      const checkedRepo = repoEl.querySelector('input[name="repo"]:checked') as HTMLInputElement | null;
      const repo = checkedRepo ? checkedRepo.value : "";
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
            if (!show) {
              let suggested: string[] = [];
              try { suggested = JSON.parse(label.getAttribute("data-cap-suggest-repos") || "[]"); } catch { suggested = []; }
              show = suggested.indexOf(repo) !== -1;
            }
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
    onMultiRepoChange(): void {
      const capList = document.getElementById("multi-cap-list");
      if (!capList) return;
      const form = capList.closest("form");
      const checkedRepos = (form || document).querySelectorAll('input[name="repo"]:checked');
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

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initAttachForms);
else initAttachForms();

