// The session page's Chat view of a Claude Code session (#clw_01M7DYJ0WVGSM09PFTBS3HXDB3).
// It draws the live transcript (`GET /sessions/:id/transcript`, normalised into
// chat events by the web tier) as message bubbles and compact tool rows, and
// sends the composer's text through `POST /sessions/:id/input`. The session
// keeps running the same Claude Code terminal: this view never touches the
// pty WebSocket, so switching views never restarts or resizes anything.
//
// `html` on user and assistant events comes from the server's `renderMarkdown`
// (src/markdown.ts), which is safe without a DOM sanitiser. Every other
// transcript-derived string reaches the DOM through textContent only.
import { classifyClaudeScreen, parseClaudePrompt, parseClaudeSuggestion, samePrompt, type ClaudePrompt, type ClaudeScreenState } from "./claude-screen-state.js";
import { endSession as endSessionRequest } from "./end-session.js";

interface ChatEventBase { key: string; uuid: string; timestamp: string | null }

/** Mirrors `ChatEvent` in src/session-chat.ts (the client bundle cannot import server modules). */
export type ChatEvent =
  | (ChatEventBase & { kind: "user"; text: string; html: string })
  | (ChatEventBase & { kind: "command"; name: string; args: string })
  | (ChatEventBase & { kind: "assistant"; text: string; html: string })
  | (ChatEventBase & { kind: "tool_use"; id: string; name: string; summary: string; input: string; inputTruncated: boolean })
  | (ChatEventBase & { kind: "tool_result"; toolUseId: string; isError: boolean; text: string; truncated: boolean })
  | (ChatEventBase & { kind: "compact" })
  | (ChatEventBase & { kind: "oversize"; bytes: number });

/** The body of a 200 from `GET /sessions/:id/transcript`. */
export interface TranscriptReply {
  file: string;
  next: number;
  truncatedBefore: boolean;
  events: ChatEvent[];
}

/** The feed auto-scrolls only when it was this close to the bottom. */
export const AUTO_SCROLL_THRESHOLD_PX = 48;
/** Tool output longer than this folds behind "Show more". */
export const TOOL_OUTPUT_FOLD_LINES = 12;
export const TRANSCRIPT_POLL_MS = 2000;
/** Longest gap between availability probes after repeated failed reads (502/503, network errors). */
export const PROBE_MAX_MS = 30_000;
export const SCREEN_POLL_MS = 3000;
/** How long a just-answered prompt's buttons stay disabled while the screen still shows it. */
export const ANSWER_GRACE_MS = 2000;
/** localStorage key for the chat text size; separate from the terminal's `claws.terminal.fontSize`. */
export const CHAT_FONT_SIZE_STORAGE_KEY = "claws.chat.fontSize";
export const CHAT_FONT_SIZE_MIN = 10;
export const CHAT_FONT_SIZE_MAX = 24;
/** Where the first A−/A+ press steps from when no size is stored (the CSS default is used until then). */
export const CHAT_FONT_SIZE_DEFAULT = 14;
/** A transcript command stamped up to this long before a tap still resolves its waiting entry (browser vs pod clock skew). */
export const PENDING_MATCH_SKEW_MS = 30_000;
/** sessionStorage key prefix (plus the session id) for tapped quick commands Claude has not yet taken. */
export const PENDING_COMMANDS_STORAGE_PREFIX = "claws.chat.pendingCommands.";

/** True when a scroll box is within `threshold` px of its bottom. */
export function isNearBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }, threshold = AUTO_SCROLL_THRESHOLD_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/**
 * Remembers what the feed has drawn. An event is new unless its key was
 * drawn before, or its `uuid` came in an earlier reply: a resumed session's
 * new transcript copies the old history with the same uuids, so after a
 * rotation those entries are skipped rather than drawn twice. Several blocks
 * of one entry share a uuid within a single reply, so the uuid check only
 * looks at earlier replies.
 */
export class ChatDedupe {
  private readonly keys = new Set<string>();
  private readonly uuids = new Set<string>();

  take(events: readonly ChatEvent[]): ChatEvent[] {
    const fresh: ChatEvent[] = [];
    const batch = new Set<string>();
    for (const ev of events) {
      if (this.keys.has(ev.key)) continue;
      if (ev.uuid && this.uuids.has(ev.uuid)) continue;
      this.keys.add(ev.key);
      if (ev.uuid) batch.add(ev.uuid);
      fresh.push(ev);
    }
    for (const uuid of batch) this.uuids.add(uuid);
    return fresh;
  }
}

export interface ChatViewOptions {
  /** Empty element the view builds itself inside. */
  container: HTMLElement;
  sessionId: string;
  /** Switch the page to the Terminal view. */
  showTerminal(): void;
  /** Toggle the maximised page; returns whether it is now maximised. */
  toggleMaximise(): boolean;
  /** Show a message in the page's notices layer. */
  notify(message: string, isError: boolean): void;
  /** Send raw keys over the page's pty WebSocket (a menu option's digit); false when the socket is not open and nothing was sent. */
  sendInput(data: string): boolean;
  /** Called once: true when the first transcript read succeeds (200 or 204), false when the pod predates it (404). */
  onAvailability(available: boolean): void;
  /** Called after the view's End session control has ended the session (the view has already called its own `setEnded`). */
  onEnded(): void;
}

export interface ChatView {
  /** Show (true) or hide the view; polling runs only while it is shown. */
  setActive(active: boolean): void;
  /** Append text (an uploaded path or a voice transcript, started from the session header's buttons) to the composer draft. */
  appendToComposer(text: string): void;
  /** The session can no longer take input: stop polling and disable the composer. */
  setEnded(): void;
  /** Mirror the page's maximised state onto the view's Maximise chip. */
  setMaximised(on: boolean): void;
  /** Move keyboard focus to the composer. */
  focusComposer(): void;
}

const QUICK_COMMANDS = ["/status", "/signoff", "/compact", "/claws-ship"] as const;

/** The longest tapped suggestion restored from session storage. */
const MAX_STORED_SUGGESTION = 2000;

type PendingState = "sending" | "waiting" | "failed";
type PendingKind = "command" | "suggestion";
/**
 * A tapped quick command or suggested prompt drawn at the end of the feed until the transcript
 * shows Claude took it. A command draws as a chip; a suggestion draws as a user bubble.
 */
interface PendingCommand {
  kind: PendingKind;
  /** The text sent: a quick command, or the suggestion's text. */
  command: string;
  /** Browser clock (ms) when the tap was made. */
  sentAt: number;
  state: PendingState;
  node: HTMLElement;
  note: HTMLElement;
  dismiss: HTMLButtonElement;
}

function collapseSpace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function bareCommand(name: string): string {
  return name.trim().replace(/^\/+/, "");
}

const STATUS_TEXT: Record<ClaudeScreenState, string> = {
  busy: "Claude is working…",
  idle: "Claude is idle",
  waiting: "Claude is waiting for input",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, label?: string): HTMLButtonElement {
  const b = el("button", className, text);
  b.type = "button";
  if (label) { b.setAttribute("aria-label", label); b.title = label; }
  return b;
}

/** A `pre` showing the first `TOOL_OUTPUT_FOLD_LINES` lines, with "Show more" for the rest. */
function foldedPre(text: string, className: string): HTMLElement {
  const wrap = el("div", "chat-tool-block");
  const pre = el("pre", className);
  const lines = text.split("\n");
  if (lines.length <= TOOL_OUTPUT_FOLD_LINES) {
    pre.textContent = text;
    wrap.append(pre);
    return wrap;
  }
  pre.textContent = lines.slice(0, TOOL_OUTPUT_FOLD_LINES).join("\n");
  const more = button("chat-show-more", "Show more");
  more.addEventListener("click", () => {
    pre.textContent = text;
    more.remove();
  });
  wrap.append(pre, more);
  return wrap;
}

/** Build the chat view inside `opts.container` and start its first transcript read. */
export function createChatView(opts: ChatViewOptions): ChatView {
  const base = "/sessions/" + encodeURIComponent(opts.sessionId);
  const root = opts.container;
  root.replaceChildren();

  const column = el("div", "chat-column");
  const feedWrap = el("div", "chat-feed-wrap");
  const feed = el("div", "chat-feed");
  feed.setAttribute("role", "log");
  feed.setAttribute("aria-live", "polite");
  feed.setAttribute("aria-label", "Conversation");
  const newChip = button("chat-new-chip", "New messages ↓");
  newChip.hidden = true;
  feedWrap.append(feed, newChip);

  const waiting = el("div", "warning-banner chat-waiting");
  waiting.setAttribute("role", "status");
  waiting.hidden = true;
  const openTerminal = button("trigger-btn chat-open-terminal", "Open terminal");
  const waitingText = el("span", "chat-waiting-text", "Claude is waiting for input — ");
  const promptBox = el("div", "chat-prompt");
  promptBox.hidden = true;
  const promptDetail = el("div", "chat-prompt-detail");
  const promptQuestion = el("div", "chat-prompt-question");
  const promptOptions = el("div", "chat-prompt-options");
  promptOptions.setAttribute("role", "group");
  promptOptions.setAttribute("aria-label", "Answer the prompt");
  promptBox.append(promptDetail, promptQuestion, promptOptions);
  waiting.append(waitingText, promptBox, openTerminal);

  const status = el("div", "chat-status");
  status.setAttribute("aria-live", "polite");

  const actions = el("div", "chat-actions");
  actions.setAttribute("role", "toolbar");
  actions.setAttribute("aria-label", "Quick actions");
  const maximise = button("chat-chip-btn chat-maximise", "⤢", "Maximise chat");
  maximise.setAttribute("aria-pressed", "false");
  const yesKey = button("chat-chip-btn", "Yes", "Send yes");
  yesKey.dataset.chatAction = "yes";
  actions.append(maximise, yesKey);
  const commandButtons = QUICK_COMMANDS.map((cmd) => {
    const b = button("chat-chip-btn", cmd, "Send " + cmd);
    b.dataset.command = cmd;
    return b;
  });
  const escKey = button("chat-chip-btn chat-key", "Esc", "Send Escape");
  escKey.dataset.chatKey = "esc";
  const tabKey = button("chat-chip-btn chat-key", "Tab", "Send Tab");
  tabKey.dataset.chatKey = "tab";
  const fontDec = button("chat-chip-btn chat-font", "A−", "Decrease chat font");
  fontDec.dataset.chatAction = "font-dec";
  const fontInc = button("chat-chip-btn chat-font", "A+", "Increase chat font");
  fontInc.dataset.chatAction = "font-inc";
  const endSession = button("chat-chip-btn chat-end-session", "End session", "End session");
  actions.append(escKey, tabKey, ...commandButtons, fontDec, fontInc, endSession);

  // Claude's dimmed suggested next prompt, read from the screen poll; tapping it sends it like a quick command.
  const suggestionChip = button("chat-suggestion", "");
  suggestionChip.hidden = true;

  const composer = el("form", "chat-composer");
  const textarea = el("textarea", "chat-input");
  textarea.rows = 1;
  textarea.placeholder = "Message Claude…";
  textarea.setAttribute("aria-label", "Message Claude");
  textarea.setAttribute("enterkeyhint", "send");
  const send = el("button", "trigger-btn chat-send");
  send.type = "submit";
  send.setAttribute("aria-label", "Send");
  send.title = "Send";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(SVG_NS, "svg");
  icon.setAttribute("class", "chat-send-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  const iconPath = document.createElementNS(SVG_NS, "path");
  iconPath.setAttribute("d", "M12 19V5M5 12l7-7 7 7");
  icon.append(iconPath);
  send.append(icon);
  const inputBox = el("div", "chat-input-box");
  inputBox.append(textarea, send);
  composer.append(inputBox);

  column.append(feedWrap, waiting, status, actions, suggestionChip, composer);
  root.append(column);

  const dedupe = new ChatDedupe();
  const toolRows = new Map<string, HTMLElement>();
  let file: string | null = null;
  let next: number | null = null;
  let availability: boolean | null = null;
  /** Failed availability probes in a row (anything but 200/204/404), for backoff. */
  let probeFailures = 0;
  let active = false;
  let ended = false;
  let sending = false;
  /** Tapped quick commands and suggestions, oldest first; their nodes always sit after the transcript's last entry. */
  const pendingCommands: PendingCommand[] = [];
  const pendingKey = PENDING_COMMANDS_STORAGE_PREFIX + opts.sessionId;
  let transcriptTimer: ReturnType<typeof setTimeout> | null = null;
  let transcriptInFlight = false;
  let screenTimer: ReturnType<typeof setTimeout> | null = null;
  let screenInFlight = false;
  /** The prompt the waiting banner's buttons currently answer. */
  let shownPrompt: ClaudePrompt | null = null;
  let answering = false;
  // The prompt an answer was just sent to, and when; its buttons stay disabled for ANSWER_GRACE_MS.
  let lastAnswered: ClaudePrompt | null = null;
  let lastAnsweredAt = 0;
  /** The suggestion the last screen read showed, or null. */
  let suggestion: string | null = null;
  /** A tapped suggestion's text; the chip stays hidden while the screen still shows it. */
  let sentSuggestion: string | null = null;
  let ending = false;
  /** The chosen chat text size in px, or null to keep the CSS default. */
  let fontSize: number | null = readFontSize();

  function pageVisible(): boolean {
    return document.visibilityState === "visible";
  }

  function scrollFeedToBottom(): void {
    feed.scrollTop = feed.scrollHeight;
    newChip.hidden = true;
  }

  function note(text: string, className = "chat-note"): HTMLElement {
    return el("div", className, text);
  }

  /** Recompute a run's collapsed row (mark, counts, latest call) from its child rows. */
  function refreshGroup(group: HTMLElement): void {
    const rows = Array.from(group.querySelectorAll<HTMLElement>(".chat-tool-group-rows > .chat-tool"));
    const states = rows.map((r) => r.querySelector<HTMLElement>(".chat-tool-mark")?.dataset.state ?? "pending");
    const failed = states.filter((st) => st === "failed").length;
    const state = states.includes("pending") ? "pending" : failed > 0 ? "failed" : "ok";
    const mark = group.querySelector<HTMLElement>(".chat-tool-group-summary .chat-tool-mark");
    if (mark) {
      mark.dataset.state = state;
      mark.textContent = state === "pending" ? "…" : state === "failed" ? "✗" : "✓";
      mark.setAttribute("aria-label", state === "pending" ? "Running" : state === "failed" ? "Failed" : "Done");
    }
    const count = group.querySelector<HTMLElement>(".chat-tool-group-count");
    if (count) count.textContent = rows.length + " tool calls";
    const failedEl = group.querySelector<HTMLElement>(".chat-tool-group-failed");
    if (failedEl) failedEl.textContent = failed > 0 ? " · " + failed + " failed" : "";
    const last = rows[rows.length - 1];
    const desc = group.querySelector<HTMLElement>(".chat-tool-group-summary .chat-tool-desc");
    if (desc && last) {
      const name = last.querySelector(".chat-tool-name")?.textContent ?? "";
      const sum = last.querySelector(".chat-tool-desc")?.textContent ?? "";
      desc.textContent = sum ? name + " " + sum : name;
    }
  }

  /** Fold a new tool row into the run before it (or start one); returns the node to append, or null. */
  function joinRun(details: HTMLElement, pending: HTMLElement[]): HTMLElement | null {
    const inPending = pending.length > 0;
    const prev = inPending ? pending[pending.length - 1] : feed.lastElementChild as HTMLElement | null;
    if (prev && prev.classList.contains("chat-tool-group")) {
      prev.querySelector(".chat-tool-group-rows")?.append(details);
      refreshGroup(prev);
      return null;
    }
    if (prev && prev.classList.contains("chat-tool")) {
      const group = el("details", "chat-tool-group");
      const summary = el("summary", "chat-tool-summary chat-tool-group-summary");
      const mark = el("span", "chat-tool-mark", "…");
      mark.setAttribute("aria-label", "Running");
      summary.append(mark, el("span", "chat-tool-group-count"), el("span", "chat-tool-group-failed"), el("span", "chat-tool-desc"));
      const rows = el("div", "chat-tool-group-rows");
      group.append(summary, rows);
      if (inPending) pending[pending.length - 1] = group;
      else prev.replaceWith(group);
      rows.append(prev, details);
      refreshGroup(group);
      return null;
    }
    return details;
  }

  function renderEvent(ev: ChatEvent, pending: HTMLElement[] = []): HTMLElement | null {
    switch (ev.kind) {
      case "user":
      case "assistant": {
        const row = el("div", "chat-msg chat-" + ev.kind);
        const bubble = el("div", "chat-bubble");
        bubble.innerHTML = ev.html;
        for (const a of Array.from(bubble.querySelectorAll("a[href]"))) {
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener noreferrer nofollow");
        }
        row.append(bubble);
        return row;
      }
      case "command": {
        const row = el("div", "chat-msg chat-command");
        row.append(el("span", "chat-command-chip", ev.args ? ev.name + " " + ev.args : ev.name));
        return row;
      }
      case "tool_use": {
        const details = el("details", "chat-tool");
        const summary = el("summary", "chat-tool-summary");
        const mark = el("span", "chat-tool-mark", "…");
        mark.dataset.state = "pending";
        mark.setAttribute("aria-label", "Running");
        summary.append(mark, el("span", "chat-tool-name", ev.name), el("span", "chat-tool-desc", ev.summary));
        details.append(summary);
        if (ev.input && ev.input !== "{}") {
          details.append(foldedPre(ev.input + (ev.inputTruncated ? "\n…" : ""), "chat-tool-input"));
        }
        if (ev.id) toolRows.set(ev.id, details);
        return joinRun(details, pending);
      }
      case "tool_result": {
        const row = toolRows.get(ev.toolUseId);
        // A result whose call is above the read's start has nothing to attach to.
        if (!row) return null;
        const mark = row.querySelector<HTMLElement>(".chat-tool-mark");
        if (mark) {
          mark.dataset.state = ev.isError ? "failed" : "ok";
          mark.textContent = ev.isError ? "✗" : "✓";
          mark.setAttribute("aria-label", ev.isError ? "Failed" : "Done");
        }
        if (ev.text) row.append(foldedPre(ev.text, "chat-tool-output"));
        if (ev.truncated) row.append(note("Output truncated — the full output is in the terminal"));
        const group = row.closest<HTMLElement>(".chat-tool-group");
        if (group) refreshGroup(group);
        return null;
      }
      case "compact":
        return note("Conversation compacted", "chat-divider");
      case "oversize":
        return note("An entry too large to show (" + Math.round(ev.bytes / 1024) + " KB) — see the terminal");
    }
  }

  function savePending(): void {
    const stored = pendingCommands
      .filter((p) => p.state !== "failed")
      .map((p) => ({ kind: p.kind, command: p.command, sentAt: p.sentAt }));
    try {
      if (stored.length === 0) sessionStorage.removeItem(pendingKey);
      else sessionStorage.setItem(pendingKey, JSON.stringify(stored));
    } catch { /* storage blocked: entries live in this page only */ }
  }

  function setPendingState(p: PendingCommand, state: PendingState, error?: string): void {
    p.state = state;
    p.node.dataset.state = state;
    p.note.textContent = state === "sending" ? "Sending…" : state === "waiting" ? "Waiting for Claude" : "Not sent: " + (error ?? "unknown error");
    p.dismiss.hidden = state === "sending";
  }

  function removePending(p: PendingCommand): void {
    const i = pendingCommands.indexOf(p);
    if (i >= 0) pendingCommands.splice(i, 1);
    p.node.remove();
  }

  function addPending(kind: PendingKind, command: string, sentAt: number, state: PendingState): PendingCommand {
    const node = kind === "suggestion"
      ? el("div", "chat-msg chat-user chat-pending")
      : el("div", "chat-msg chat-command chat-pending");
    // el() sets textContent, so a suggestion's text is never parsed as HTML.
    const body = kind === "suggestion" ? el("div", "chat-bubble", command) : el("span", "chat-command-chip", command);
    const noteEl = el("span", "chat-pending-note");
    const dismiss = button("chat-pending-dismiss", "×", kind === "suggestion" ? "Dismiss suggestion" : "Dismiss " + command);
    node.append(body, noteEl, dismiss);
    const p: PendingCommand = { kind, command, sentAt, state, node, note: noteEl, dismiss };
    dismiss.addEventListener("click", () => {
      removePending(p);
      savePending();
    });
    setPendingState(p, state);
    pendingCommands.push(p);
    feed.append(node);
    return p;
  }

  /** Clear the oldest sending/waiting entry this transcript event shows Claude took; true when one was cleared. */
  function resolvePending(ev: ChatEvent): boolean {
    // A command chip compares names with any leading "/" dropped; a plain user message must be the command itself.
    let same: (command: string, kind: PendingKind) => boolean;
    if (ev.kind === "command") { const name = bareCommand(ev.name); same = (c) => bareCommand(c) === name; }
    else if (ev.kind === "user") {
      const text = ev.text.trim();
      const loose = collapseSpace(ev.text);
      // A suggestion was read off the terminal, so its whitespace may differ from the transcript's.
      same = (c, kind) => kind === "suggestion" ? collapseSpace(c) === loose : c === text;
    }
    else return false;
    if (ev.timestamp === null) return false;
    const at = Date.parse(ev.timestamp);
    if (!Number.isFinite(at)) return false;
    const match = pendingCommands.find((p) =>
      p.state !== "failed" && same(p.command, p.kind) && at >= p.sentAt - PENDING_MATCH_SKEW_MS);
    if (!match) return false;
    removePending(match);
    if (match.kind === "suggestion") {
      sentSuggestion = null;
      renderSuggestion();
    }
    return true;
  }

  function restorePending(): void {
    let raw: string | null = null;
    try { raw = sessionStorage.getItem(pendingKey); } catch { return; }
    if (!raw) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const { kind, command, sentAt } = item as { kind?: unknown; command?: unknown; sentAt?: unknown };
      if (typeof command !== "string") continue;
      if (kind === "suggestion") {
        if (command.trim() === "" || command.length > MAX_STORED_SUGGESTION) continue;
      } else if (!(QUICK_COMMANDS as readonly string[]).includes(command)) continue;
      if (typeof sentAt !== "number" || !Number.isFinite(sentAt)) continue;
      addPending(kind === "suggestion" ? "suggestion" : "command", command, sentAt, "waiting");
    }
    savePending();
  }

  /** Draw a transcript reply. Exported behaviour: dedupe, rotation divider, tail note, auto-scroll. */
  function applyReply(reply: TranscriptReply): void {
    const stick = isNearBottom(feed);
    // Lift the waiting entries out so tool runs still join the transcript's real last entry.
    for (const p of pendingCommands) p.node.remove();
    try {
      drawReply(reply, stick);
    } finally {
      for (const p of pendingCommands) feed.append(p.node);
    }
  }

  function drawReply(reply: TranscriptReply, stick: boolean): void {
    const nodes: HTMLElement[] = [];
    const rotated = file !== null && reply.file !== file;
    if (rotated && feed.childElementCount > 0) nodes.push(note("New transcript", "chat-divider"));
    // A fresh read (first, or after a rotation) that started partway through the file.
    if ((file === null || rotated) && reply.truncatedBefore) nodes.push(note("Earlier messages are in the terminal"));
    file = reply.file;
    next = reply.next;
    let drewMessage = false;
    let resolved = false;
    for (const ev of dedupe.take(reply.events)) {
      if (resolvePending(ev)) resolved = true;
      const node = renderEvent(ev, nodes);
      if (node) nodes.push(node);
      drewMessage = true;
    }
    if (resolved) savePending();
    if (nodes.length === 0 && !drewMessage) return;
    feed.append(...nodes);
    if (stick) scrollFeedToBottom();
    else newChip.hidden = false;
  }

  function scheduleTranscript(delay = TRANSCRIPT_POLL_MS): void {
    if (transcriptTimer !== null) { clearTimeout(transcriptTimer); transcriptTimer = null; }
    if (ended || availability === false || !pageVisible()) return;
    // Until the first read answers, keep probing (while the page is visible) so the toggle can
    // appear, backing off after repeated failures; after that only while shown.
    if (availability === true && !active) return;
    if (availability === null && probeFailures > 0) {
      delay = Math.min(PROBE_MAX_MS, delay * 2 ** Math.min(probeFailures, 4));
    }
    transcriptTimer = setTimeout(() => { transcriptTimer = null; void pollTranscript(); }, delay);
  }

  async function pollTranscript(): Promise<void> {
    if (ended || availability === false || transcriptInFlight || !pageVisible()) return;
    if (availability === true && !active) return;
    transcriptInFlight = true;
    try {
      const params = file !== null && next !== null
        ? "?file=" + encodeURIComponent(file) + "&offset=" + String(next)
        : "";
      const res = await fetch(base + "/transcript" + params);
      if (res.status === 404) {
        availability = false;
        opts.onAvailability(false);
        return;
      }
      if (res.status === 204 || res.ok) {
        if (res.status !== 204) applyReply(await res.json() as TranscriptReply);
        if (availability === null) {
          availability = true;
          opts.onAvailability(true);
        }
      } else if (availability === null) {
        probeFailures++;
      }
    } catch {
      // Transient — the next tick retries.
      if (availability === null) probeFailures++;
    } finally {
      transcriptInFlight = false;
    }
    scheduleTranscript();
  }

  function renderPrompt(prompt: ClaudePrompt | null): void {
    // Leave the buttons alone while the same prompt stays up, so focus and a press in progress survive a poll.
    if (prompt && samePrompt(prompt, shownPrompt)) return;
    shownPrompt = prompt;
    promptOptions.replaceChildren();
    if (!prompt) {
      promptBox.hidden = true;
      promptDetail.textContent = "";
      promptQuestion.textContent = "";
      return;
    }
    // The tool header and the command or path being approved, above the question.
    const detail = prompt.context.slice(0, -1).join("\n");
    promptDetail.textContent = detail;
    promptDetail.hidden = detail === "";
    promptQuestion.textContent = prompt.question;
    promptQuestion.hidden = prompt.question === "";
    // Until the TUI redraws, a just-answered prompt is still on screen: a second tap must not type another digit.
    const justAnswered = samePrompt(prompt, lastAnswered) && Date.now() - lastAnsweredAt < ANSWER_GRACE_MS;
    for (const option of prompt.options) {
      const b = button("trigger-btn chat-prompt-option", option.n + ". " + option.label, "Answer " + option.n + ": " + option.label);
      b.dataset.option = String(option.n);
      b.disabled = justAnswered;
      b.addEventListener("click", () => { void answerPrompt(option.n); });
      promptOptions.append(b);
    }
    promptBox.hidden = false;
    // Redraw on the next read, which re-enables the buttons once the grace period is over.
    if (justAnswered) shownPrompt = null;
  }

  function renderScreen(text: string): void {
    const state = classifyClaudeScreen(text);
    status.textContent = STATUS_TEXT[state];
    status.dataset.state = state;
    waiting.hidden = state !== "waiting";
    renderPrompt(state === "waiting" ? parseClaudePrompt(text) : null);
    // "yes" plus Enter in a numbered menu would pick the highlighted option.
    if (state === "waiting") yesKey.setAttribute("aria-disabled", "true");
    else yesKey.removeAttribute("aria-disabled");
    suggestion = state === "idle" ? parseClaudeSuggestion(text) : null;
    if (sentSuggestion !== null && suggestion !== sentSuggestion) sentSuggestion = null;
    renderSuggestion();
  }

  /**
   * Show the suggestion chip only while Claude shows a suggestion not already tapped, the composer
   * is empty and the session is live.
   */
  function renderSuggestion(): void {
    const show = suggestion !== null && suggestion !== sentSuggestion && textarea.value === "" && !ended;
    if (show && suggestionChip.textContent !== suggestion) {
      suggestionChip.textContent = suggestion;
      suggestionChip.setAttribute("aria-label", "Send suggestion: " + suggestion);
      suggestionChip.title = "Send suggestion: " + suggestion;
    }
    suggestionChip.hidden = !show;
  }

  function readFontSize(): number | null {
    try {
      const raw = localStorage.getItem(CHAT_FONT_SIZE_STORAGE_KEY);
      if (raw === null) return null;
      const n = Number(raw);
      return Number.isInteger(n) && n >= CHAT_FONT_SIZE_MIN && n <= CHAT_FONT_SIZE_MAX ? n : null;
    } catch {
      return null;
    }
  }

  function applyFontSize(): void {
    if (fontSize !== null) column.style.setProperty("--chat-font-size", fontSize + "px");
    const mark = (b: HTMLButtonElement, atLimit: boolean): void => {
      if (atLimit) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
    };
    mark(fontDec, fontSize !== null && fontSize <= CHAT_FONT_SIZE_MIN);
    mark(fontInc, fontSize !== null && fontSize >= CHAT_FONT_SIZE_MAX);
  }

  function stepFontSize(delta: number): void {
    const from = fontSize ?? CHAT_FONT_SIZE_DEFAULT;
    const to = Math.min(CHAT_FONT_SIZE_MAX, Math.max(CHAT_FONT_SIZE_MIN, from + delta));
    if (to === fontSize) return;
    fontSize = to;
    try { localStorage.setItem(CHAT_FONT_SIZE_STORAGE_KEY, String(to)); } catch { /* storage blocked: keep it for this page only */ }
    applyFontSize();
    autoGrow();
  }

  /** Send one raw key (Esc, Tab) to the pty, then re-read the screen soon. */
  function sendKey(data: string): void {
    if (ended) return;
    if (!opts.sendInput(data)) {
      opts.notify("Terminal not connected — key not sent", true);
      return;
    }
    scheduleScreen(500);
  }

  async function endThisSession(): Promise<void> {
    if (ended || ending) return;
    ending = true;
    endSession.disabled = true;
    try {
      const result = await endSessionRequest(opts.sessionId);
      if (result === "ended") {
        view.setEnded();
        opts.onEnded();
        return;
      }
      opts.notify("Failed to end session: " + result.error, true);
    } catch (err) {
      opts.notify("Failed to end session: " + String(err), true);
    } finally {
      ending = false;
      endSession.disabled = ended;
    }
  }

  /**
   * Answer the shown prompt with option `n`, but only after a fresh read of
   * the screen still shows the same question and options; otherwise redraw
   * the banner from that read and send nothing, so a stale prompt is never answered.
   */
  async function answerPrompt(n: number): Promise<void> {
    if (ended || answering || !shownPrompt) return;
    const expected = shownPrompt;
    answering = true;
    for (const b of promptOptions.querySelectorAll("button")) b.disabled = true;
    let sent = false;
    try {
      const res = await fetch(base + "/screen");
      if (!res.ok) {
        opts.notify("Could not check the prompt (" + res.status + ")", true);
        return;
      }
      const json = await res.json() as { data?: string };
      const text = json.data ?? "";
      if (!ended && classifyClaudeScreen(text) === "waiting" && samePrompt(parseClaudePrompt(text), expected)) {
        if (!opts.sendInput(String(n))) {
          opts.notify("Terminal not connected — answer not sent", true);
          return;
        }
        sent = true;
        lastAnswered = expected;
        lastAnsweredAt = Date.now();
        return;
      }
      if (!ended) renderScreen(text);
    } catch (err) {
      opts.notify("Could not check the prompt: " + String(err), true);
    } finally {
      answering = false;
      if (sent) {
        // Keep the buttons disabled until the next read redraws the banner, so a second
        // tap before the TUI redraws cannot type another digit into Claude's input box.
        shownPrompt = null;
        scheduleScreen(500);
      } else {
        for (const b of promptOptions.querySelectorAll("button")) b.disabled = ended;
      }
    }
  }

  function scheduleScreen(delay = SCREEN_POLL_MS): void {
    if (screenTimer !== null) { clearTimeout(screenTimer); screenTimer = null; }
    if (ended || !active || !pageVisible()) return;
    screenTimer = setTimeout(() => { screenTimer = null; void pollScreen(); }, delay);
  }

  async function pollScreen(): Promise<void> {
    if (ended || !active || !pageVisible() || screenInFlight) return;
    screenInFlight = true;
    try {
      const res = await fetch(base + "/screen");
      if (res.ok) {
        const json = await res.json() as { data?: string };
        if (!ended && active) renderScreen(json.data ?? "");
      }
    } catch { /* transient — the next tick retries */ } finally {
      screenInFlight = false;
    }
    scheduleScreen();
  }

  function autoGrow(): void {
    textarea.style.height = "auto";
    // CSS caps the height at 6 rows; past that the textarea scrolls.
    textarea.style.height = textarea.scrollHeight + "px";
  }

  /** POST `text` to the session's input route; returns null on success or the failure message. */
  async function postInput(text: string): Promise<string | null> {
    try {
      const res = await fetch(base + "/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.status === 204) {
        // Pick up the reply soon rather than a whole interval later.
        scheduleTranscript(500);
        return null;
      }
      let message = "Send failed (" + res.status + ")";
      try {
        const json = await res.json() as { error?: string };
        if (json.error) message = "Send failed: " + json.error;
      } catch { /* non-JSON error page */ }
      return message;
    } catch (err) {
      return "Send failed: " + String(err);
    }
  }

  async function sendText(text: string): Promise<boolean> {
    if (ended || sending || text.trim() === "") return false;
    sending = true;
    send.disabled = true;
    try {
      const error = await postInput(text);
      if (error === null) return true;
      opts.notify(error, true);
      return false;
    } finally {
      sending = false;
      send.disabled = ended;
    }
  }

  let yesSending = false;
  /** Send "yes" as a message, leaving the composer and its send guard alone. */
  async function sendYes(): Promise<void> {
    if (ended || yesSending || yesKey.getAttribute("aria-disabled") === "true") return;
    yesSending = true;
    try {
      const error = await postInput("yes");
      if (error !== null) opts.notify(error, true);
    } finally {
      yesSending = false;
    }
  }

  /** Send a quick command or a tapped suggestion, drawing it in the feed at once as waiting for Claude. */
  async function sendCommand(command: string, kind: PendingKind = "command"): Promise<void> {
    if (ended || command === "") return;
    // A second tap while the first request is still in flight is ignored.
    if (pendingCommands.some((p) => p.command === command && p.state === "sending")) return;
    const p = addPending(kind, command, Date.now(), "sending");
    scrollFeedToBottom();
    savePending();
    let error: string;
    try {
      const res = await fetch(base + "/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: command }),
      });
      if (res.status === 204) {
        if (pendingCommands.includes(p)) setPendingState(p, "waiting");
        scheduleTranscript(500);
        return;
      }
      // The reason, without sendText's "Send failed" prefix: the entry already reads "Not sent: …".
      error = "HTTP " + res.status;
      try {
        const json = await res.json() as { error?: string };
        if (json.error) error = json.error;
      } catch { /* non-JSON error page */ }
    } catch (err) {
      error = String(err);
    }
    if (kind === "suggestion" && sentSuggestion === command) {
      // Show the chip again so the operator can retry while Claude still offers it.
      sentSuggestion = null;
      renderSuggestion();
    }
    if (!pendingCommands.includes(p)) return;
    setPendingState(p, "failed", error);
    savePending();
  }

  async function submitComposer(): Promise<void> {
    const text = textarea.value;
    if (!(await sendText(text))) return;
    // Clear only what was sent; anything typed while the request ran stays.
    textarea.value = textarea.value.startsWith(text) ? textarea.value.slice(text.length).replace(/^\s+/, "") : textarea.value;
    autoGrow();
    renderSuggestion();
  }

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    void submitComposer();
  });
  // Enter sends on every tier; Shift+Enter adds a newline; Enter confirming an IME choice does not send.
  let shiftEnter = false;
  textarea.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") {
      shiftEnter = false;
      return;
    }
    if (e.isComposing || e.keyCode === 229) return;
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
      shiftEnter = true;
      return;
    }
    shiftEnter = false;
    e.preventDefault();
    void submitComposer();
  });
  textarea.addEventListener("keyup", () => {
    shiftEnter = false;
  });
  // Some on-screen keyboards deliver no usable Enter keydown, only a line-break insertion.
  textarea.addEventListener("beforeinput", (e) => {
    const ie = e as InputEvent;
    if (ie.inputType !== "insertLineBreak" || ie.isComposing || shiftEnter) return;
    e.preventDefault();
    void submitComposer();
  });
  textarea.addEventListener("input", () => {
    autoGrow();
    renderSuggestion();
  });
  yesKey.addEventListener("click", () => { void sendYes(); });
  escKey.addEventListener("click", () => sendKey("\x1b"));
  tabKey.addEventListener("click", () => sendKey("\t"));
  fontDec.addEventListener("click", () => { if (fontDec.getAttribute("aria-disabled") !== "true") stepFontSize(-1); });
  fontInc.addEventListener("click", () => { if (fontInc.getAttribute("aria-disabled") !== "true") stepFontSize(1); });
  endSession.addEventListener("click", () => { void endThisSession(); });
  suggestionChip.addEventListener("click", () => {
    if (ended || suggestion === null || textarea.value !== "") return;
    // Send at once, like a quick command: never fill or focus the composer, which opens a phone's keyboard.
    if (suggestion === sentSuggestion) return;
    const text = suggestion;
    sentSuggestion = text;
    suggestionChip.hidden = true;
    void sendCommand(text, "suggestion");
  });
  for (const b of commandButtons) {
    b.addEventListener("click", () => { void sendCommand(b.dataset.command ?? ""); });
  }
  function setMaximised(on: boolean): void {
    maximise.setAttribute("aria-pressed", on ? "true" : "false");
    const label = on ? "Restore session page" : "Maximise chat";
    maximise.setAttribute("aria-label", label);
    maximise.title = label;
  }
  maximise.addEventListener("click", () => setMaximised(opts.toggleMaximise()));
  openTerminal.addEventListener("click", () => opts.showTerminal());
  newChip.addEventListener("click", scrollFeedToBottom);
  feed.addEventListener("scroll", () => { if (isNearBottom(feed)) newChip.hidden = true; });
  document.addEventListener("visibilitychange", () => {
    if (!pageVisible()) return;
    if (active) { void pollTranscript(); void pollScreen(); }
    else if (availability === null) void pollTranscript();
  });

  applyFontSize();
  restorePending();
  void pollTranscript();

  const view: ChatView = {
    setMaximised,
    focusComposer(): void { textarea.focus(); },
    setActive(on: boolean): void {
      if (active === on) return;
      active = on;
      if (!on) {
        if (availability === true && transcriptTimer !== null) { clearTimeout(transcriptTimer); transcriptTimer = null; }
        if (screenTimer !== null) { clearTimeout(screenTimer); screenTimer = null; }
        return;
      }
      void pollTranscript();
      void pollScreen();
    },
    appendToComposer(text: string): void {
      const trimmed = text.trim();
      if (!trimmed) return;
      const draft = textarea.value.replace(/\s+$/, "");
      textarea.value = draft ? draft + " " + trimmed : trimmed;
      autoGrow();
      renderSuggestion();
    },
    setEnded(): void {
      ended = true;
      if (transcriptTimer !== null) { clearTimeout(transcriptTimer); transcriptTimer = null; }
      if (screenTimer !== null) { clearTimeout(screenTimer); screenTimer = null; }
      for (const b of [send, ...commandButtons, yesKey, escKey, tabKey, fontDec, fontInc, endSession]) b.disabled = true;
      textarea.disabled = true;
      waiting.hidden = true;
      renderPrompt(null);
      suggestion = null;
      sentSuggestion = null;
      renderSuggestion();
      for (const p of pendingCommands.filter((c) => c.state !== "failed")) removePending(p);
      try { sessionStorage.removeItem(pendingKey); } catch { /* storage blocked */ }
      status.textContent = "Session ended";
      status.dataset.state = "ended";
    },
  };
  return view;
}
