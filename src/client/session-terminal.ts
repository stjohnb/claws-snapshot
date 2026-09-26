// xterm.js setup, paste button, theme observer, and reconnecting WebSocket
// for the /sessions/:id terminal page. xterm and its addons are loaded from
// CDN <script> tags in the page <head>; we only declare the global shapes we
// touch here.
//
// The session id is read from `data-session-id` on `#terminal` so this
// bundle can stay request-independent (the JS is built at npm-build-time).
type XtermTheme = {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

interface XtermBufferLine {
  translateToString(trimRight?: boolean): string;
}
interface XtermBuffer {
  length: number;
  getLine(y: number): XtermBufferLine | undefined;
}

interface XtermParser {
  registerOscHandler(ident: number, cb: (data: string) => boolean): { dispose(): void };
}

interface XtermInstance {
  cols: number;
  rows: number;
  options: { theme: XtermTheme; fontSize: number };
  loadAddon(addon: unknown): void;
  open(el: HTMLElement): void;
  focus(): void;
  reset(): void;
  write(data: string): void;
  onData(cb: (data: string) => void): void;
  buffer: { active: XtermBuffer };
  getSelection(): string;
  hasSelection(): boolean;
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void;
  parser?: XtermParser;
}

interface XtermCtor {
  new (opts: { cursorBlink: boolean; fontSize: number; theme: XtermTheme }): XtermInstance;
}

interface FitAddonInstance {
  fit(): void;
}

declare const Terminal: XtermCtor;
declare const FitAddon: { FitAddon: new () => FitAddonInstance };
declare const WebLinksAddon: { WebLinksAddon: new () => unknown };

export {};

(() => {
  const XTERM_DARK: XtermTheme = {
    background: "#0b0c0e",
    foreground: "#e8e3da",
    cursor: "#ff8a3d",
    selectionBackground: "#484f58",
    black: "#0b0c0e",
    red: "#ff5f56",
    green: "#5fd38d",
    yellow: "#e0a44a",
    blue: "#ff8a3d",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#8b949e",
    brightRed: "#ff7b72",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#ff8a3d",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#ffffff",
  };
  const XTERM_LIGHT: XtermTheme = {
    background: "#faf7f2",
    foreground: "#1c1a17",
    cursor: "#c1521a",
    selectionBackground: "#afb8c1",
    black: "#24292f",
    red: "#cf222e",
    green: "#1a7f37",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#116329",
    brightYellow: "#7d4e00",
    brightBlue: "#0550ae",
    brightMagenta: "#6e40c9",
    brightCyan: "#0e6fa5",
    brightWhite: "#ffffff",
  };

  const FONT_SIZE_MIN = 8;
  const FONT_SIZE_MAX = 24;
  const FONT_SIZE_DEFAULT_DESKTOP = 14;
  const FONT_SIZE_DEFAULT_MOBILE = 11;
  const FONT_SIZE_STORAGE_KEY = "claws.terminal.fontSize";

  function getInitialFontSize(): number {
    try {
      const raw = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);
      if (raw !== null) {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n >= FONT_SIZE_MIN && n <= FONT_SIZE_MAX) return n;
      }
    } catch { /* localStorage may throw in private mode */ }
    const coarse = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    const narrow = window.matchMedia("(max-width: 900px)").matches;
    return (coarse || narrow) ? FONT_SIZE_DEFAULT_MOBILE : FONT_SIZE_DEFAULT_DESKTOP;
  }

  function getXtermTheme(): XtermTheme {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark") return XTERM_DARK;
    if (attr === "light") return XTERM_LIGHT;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? XTERM_LIGHT : XTERM_DARK;
  }

  const termEl = document.getElementById("terminal");
  if (!termEl) return;
  // The CDN-loaded xterm script may have failed; surface a readable error.
  if (typeof Terminal === "undefined") {
    termEl.textContent = "[Terminal library failed to load — check browser console]";
    return;
  }

  const sessionId = termEl.getAttribute("data-session-id");
  if (!sessionId) {
    termEl.textContent = "[Missing data-session-id on #terminal]";
    return;
  }
  const sessionWasAliveAtLoad = termEl.getAttribute("data-session-alive") === "true";

  let currentFontSize = getInitialFontSize();
  const term = new Terminal({
    cursorBlink: true,
    fontSize: currentFontSize,
    theme: getXtermTheme(),
  });
  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);
  term.open(termEl);
  term.focus();

  function getTerminalText(): string {
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }
    return lines.join("\n").replace(/\s+$/, "") + "\n";
  }

  function setFontSize(next: number): void {
    const clamped = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(next)));
    if (clamped === currentFontSize) return;
    currentFontSize = clamped;
    term.options.fontSize = clamped;
    if (termEl!.offsetWidth > 0 && termEl!.offsetHeight > 0) {
      fitAddon.fit();
      sendResize();
    }
    try { window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(clamped)); } catch { /* ignore */ }
  }

  function sendResize(): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  }

  const ro = new ResizeObserver(() => {
    if (termEl.offsetWidth === 0 || termEl.offsetHeight === 0) return;
    fitAddon.fit();
    sendResize();
  });
  ro.observe(termEl);

  // tmux owns the alternate screen, so xterm's viewport has no scrollback to
  // scroll and the browser used to take the gesture (pull-to-refresh, #2895).
  // Translate vertical drags into the same tmux wheel scroll the desktop uses.
  const TOUCH_STEP_PX = 40;
  let touchLastY = 0;
  let touchAccum = 0;
  let touchTracking = false;

  termEl.addEventListener("touchstart", (e) => {
    touchTracking = e.touches.length === 1;
    if (touchTracking) { touchLastY = e.touches[0].clientY; touchAccum = 0; }
  }, { passive: true });

  termEl.addEventListener("touchmove", (e) => {
    // Unconditional, including the first move of the gesture: iOS only
    // suppresses pull-to-refresh/rubber-band if the first touchmove is cancelled.
    e.preventDefault();
    if (!touchTracking || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    touchAccum += y - touchLastY;
    touchLastY = y;
    const notches = Math.trunc(touchAccum / TOUCH_STEP_PX);
    if (notches === 0) return;
    touchAccum -= notches * TOUCH_STEP_PX;
    // Dragging down (positive delta) reveals older output — scroll back.
    if (notches > 0) scrollUp(notches); else scrollDown(-notches);
  }, { passive: false });

  const endTouch = (): void => { touchTracking = false; touchAccum = 0; };
  termEl.addEventListener("touchend", endTouch, { passive: true });
  termEl.addEventListener("touchcancel", endTouch, { passive: true });

  let ws: WebSocket | null = null;
  let sessionExited = false;
  let reconnectDelay = 1000;
  let reconnectTimer: number | null = null;
  let isFirstConnection = true;
  let ctrlSticky = false;
  let startupReady = false;
  let startupFailed = false;
  let startupTimer: number | null = null;
  const startupEl = document.getElementById("startup-status");

  type StartupStatus = {
    state: "preparing" | "creating" | "pending" | "running" | "ready" | "failed" | "ended" | "unknown";
    step: string;
    detail: string | null;
    elapsedMs: number;
    failureReason?: string | null;
  };

  function formatElapsed(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const min = Math.floor(total / 60);
    const sec = total % 60;
    return min > 0 ? min + "m " + sec + "s" : sec + "s";
  }

  function renderStartup(status: StartupStatus): void {
    startupReady = status.state === "ready";
    startupFailed = status.state === "failed" || status.state === "ended";
    if (!startupEl) return;
    const reason = status.failureReason || status.detail || "";
    const prefix = status.state === "failed" ? "Startup failed" : status.state === "ended" ? "Session ended" : status.step;
    startupEl.textContent = prefix + (reason ? ": " + reason : "") + " · " + formatElapsed(status.elapsedMs);
    if (startupFailed) {
      // The ended-session page keeps the final output after the runtime is gone (#3311).
      const link = document.createElement("a");
      link.href = "/sessions/" + encodeURIComponent(sessionId!);
      link.textContent = "View last output";
      startupEl.append(" · ", link);
    }
    startupEl.setAttribute("data-state", status.state);
    startupEl.hidden = status.state === "ready";
  }

  function scheduleStartupPoll(): void {
    if (sessionUnavailable()) return;
    if (startupTimer !== null) window.clearTimeout(startupTimer);
    startupTimer = window.setTimeout(() => { void pollStartup(); }, startupReady ? 5000 : 1000);
  }

  /** Single source of truth for "this session can no longer take input" — recompute .disabled from this, not from `sessionExited` alone, wherever a control's state is set after an async step. */
  function sessionUnavailable(): boolean {
    return sessionExited || startupFailed;
  }

  /**
   * Grey out everything that would send input to a session that can no longer take it —
   * whether it exited or never finished starting. Attach and drag-drop belong here too:
   * without them a user can still open the file picker over a dead terminal and get a
   * generic "Not connected" toast instead of the failure already on screen.
   */
  function disableInputControls(): void {
    if (pasteBtn) pasteBtn.disabled = true;
    if (micBtn) micBtn.disabled = true;
    if (grantBtn) grantBtn.disabled = true;
    if (attachBtn) attachBtn.disabled = true;
    if (attachInput) attachInput.disabled = true;
    releaseMicStream();
  }

  async function pollStartup(): Promise<void> {
    if (sessionUnavailable()) return;
    // Like the capability-request poller, a hidden tab spends no requests; the chain keeps
    // ticking so the banner is at most one interval stale when the tab comes back.
    if (document.visibilityState !== "visible") { scheduleStartupPoll(); return; }
    try {
      const res = await fetch("/api/sessions/" + encodeURIComponent(sessionId!) + "/startup");
      if (res.status === 404) {
        // A stale or deleted id never becomes ready. Treating its 404 as a blip would leave
        // "Checking startup status…" polling once a second forever with nothing else to say.
        startupFailed = true;
        if (startupEl) {
          startupEl.textContent = "Session not found";
          startupEl.setAttribute("data-state", "ended");
          startupEl.hidden = false;
        }
        disableInputControls();
        if (startupTimer !== null) { window.clearTimeout(startupTimer); startupTimer = null; }
        return;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      renderStartup(await res.json() as StartupStatus);
      if (startupReady) {
        if (startupTimer !== null) { window.clearTimeout(startupTimer); startupTimer = null; }
        // connect() owns the backoff timer and every reason not to attach, so this can never
        // race a pending reconnect into a second live socket.
        connect();
        return;
      }
      if (startupFailed) {
        disableInputControls();
        if (startupTimer !== null) { window.clearTimeout(startupTimer); startupTimer = null; }
        return;
      }
    } catch {
      // A blip in polling must not resurrect the banner over a terminal that is already attached.
      if (startupEl && !startupReady) {
        startupEl.textContent = "Checking startup status…";
        startupEl.setAttribute("data-state", "unknown");
        startupEl.hidden = false;
      }
    }
    scheduleStartupPoll();
  }

  // Wheel notches we have sent to tmux since it was last at the bottom. Non-zero
  // means tmux is in copy-mode, where typed keys are copy-mode commands and never
  // reach the app — so any real input must return to the bottom first.
  let scrolledNotches = 0;
  // 500 notches = 2500 lines, comfortably past tmux's 2000-line default
  // history-limit, so this always reaches the bottom and copy-mode -e exits.
  const SCROLL_BOTTOM_NOTCHES = 500;

  function sendRaw(data: string): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    }
  }

  function wheelSeq(code: number): string {
    const col = Math.max(1, Math.floor(term.cols / 2));
    const row = Math.max(1, Math.floor(term.rows / 2));
    return "\x1b[<" + code + ";" + col + ";" + row + "M";
  }

  function scrollToBottom(): void {
    if (scrolledNotches === 0) return;
    scrolledNotches = 0;
    sendRaw(wheelSeq(65).repeat(SCROLL_BOTTOM_NOTCHES));
  }

  function scrollUp(notches: number): void {
    if (notches <= 0) return;
    // The first notch on a normal pane only enters copy-mode; it scrolls nothing.
    const enter = scrolledNotches === 0 ? 1 : 0;
    scrolledNotches += notches;
    sendRaw(wheelSeq(64).repeat(notches + enter));
  }

  function scrollDown(notches: number): void {
    if (notches <= 0 || scrolledNotches === 0) return;
    // Returning to the bottom always uses the burst: output that arrived while
    // scrolled means exact notch accounting would stop short and strand copy-mode.
    if (notches >= scrolledNotches) { scrollToBottom(); return; }
    scrolledNotches -= notches;
    sendRaw(wheelSeq(65).repeat(notches));
  }

  function pageNotches(): number {
    return Math.max(1, Math.ceil(term.rows / 5)); // tmux scrolls 5 lines per notch
  }

  let localDraftDirty = false;

  function trackLocalDraft(data: string): void {
    if (data.indexOf("\r") !== -1 || data.indexOf("\x03") !== -1 || data.indexOf("\x04") !== -1) {
      localDraftDirty = false;
      return;
    }
    if (data.length > 0 && data.indexOf("\x1b[<") !== 0) localDraftDirty = true;
  }

  function sendInput(data: string, opts: { trackDraft?: boolean } = {}): void {
    // Mouse reports from xterm's own wheel handling must not trigger the flush.
    if (scrolledNotches > 0 && data.indexOf("\x1b[<") !== 0) scrollToBottom();
    if (opts.trackDraft !== false) trackLocalDraft(data);
    sendRaw(data);
  }

  const KEY_MAP: Record<string, string> = {
    esc: "\x1b",
    enter: "\r",
    tab: "\t",
    up: "\x1b[A",
    down: "\x1b[B",
    left: "\x1b[D",
    right: "\x1b[C",
    home: "\x1bOH",
    end: "\x1bOF",
    "ctrl-c": "\x03",
    "ctrl-d": "\x04",
    "ctrl-z": "\x1a",
    "ctrl-l": "\x0c",
    // Types the /ship slash command and submits it immediately (#2857, #2858).
    ship: "/ship\r",
    // Codex uses Shift+Left to jump into queued follow-up inputs (#3028).
    "codex-followup": "\x1b[1;2D",
  };

  term.onData((data: string) => {
    let outgoing = data;
    if (ctrlSticky && data.length === 1) {
      const c = data.charCodeAt(0);
      if (c >= 0x40 && c <= 0x7e) {
        outgoing = String.fromCharCode(c & 0x1f);
      }
      ctrlSticky = false;
      const ctrlBtn = document.querySelector<HTMLButtonElement>('.kb-key[data-action="ctrl"]');
      if (ctrlBtn) ctrlBtn.setAttribute("data-active", "false");
    }
    sendInput(outgoing);
  });

  const pasteBtn = document.getElementById("paste-btn") as HTMLButtonElement | null;
  if (pasteBtn) {
    pasteBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
    });
    pasteBtn.addEventListener("click", () => {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        term.write("\r\n\x1b[33m[Clipboard API unavailable — requires HTTPS and a supported browser]\x1b[0m\r\n");
        return;
      }
      navigator.clipboard
        .readText()
        .then((text) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            sendInput(text);
          } else {
            term.write("\r\n\x1b[33m[Not connected — paste discarded]\x1b[0m\r\n");
          }
        })
        .catch(() => {
          term.write("\r\n\x1b[33m[Clipboard access denied]\x1b[0m\r\n");
        });
    });
  }

  const descText = document.getElementById("session-desc-text");
  const setTitleBtn = document.getElementById("session-desc-set-title") as HTMLButtonElement | null;

  function renderDesc(value: string): void {
    if (descText) {
      if (value) descText.textContent = value;         // never innerHTML — user-supplied
      else descText.innerHTML = "<em>No description</em>";
      descText.setAttribute("title", value);
    }
  }
  async function postDesc(url: string): Promise<{ description?: string | null; error?: string } | null> {
    const res = await fetch(url, { method: "POST" });
    const json = (await res.json()) as { description?: string | null; error?: string };
    if (!res.ok) { showToast(json.error ?? ("Request failed (" + res.status + ")"), true); return null; }
    return json;
  }
  async function setTitle(): Promise<void> {
    if (setTitleBtn) { setTitleBtn.disabled = true; setTitleBtn.textContent = "Setting…"; }
    showToast("Summarising session…", false, true);
    try {
      const json = await postDesc("/sessions/" + encodeURIComponent(sessionId!) + "/resummarize");
      if (!json) return;
      renderDesc(json.description ?? "");
      showToast(json.description ? "Title updated" : "Not enough terminal output to summarise yet", !json.description);
    } catch (err) {
      showToast("Failed to set title: " + String(err), true);
    } finally {
      if (setTitleBtn) { setTitleBtn.disabled = false; setTitleBtn.textContent = "Set Title"; }
    }
  }
  setTitleBtn?.addEventListener("click", () => { void setTitle(); });

  // ── Grant a capability to the running session (#3072) ──
  const grantSelect = document.getElementById("grant-cap-select") as HTMLSelectElement | null;
  const grantBtn = document.getElementById("grant-cap-btn") as HTMLButtonElement | null;
  const grantStatus = document.getElementById("grant-cap-status");

  function hasGrantableOption(): boolean {
    return !!grantSelect && Array.from(grantSelect.options).some((o) => !o.disabled);
  }

  /** Select the first enabled option, or disable the Grant button when none is left (#3322). */
  function selectNextGrantable(): void {
    if (!grantSelect) return;
    const next = Array.from(grantSelect.options).find((o) => !o.disabled);
    if (next) next.selected = true;
    if (grantBtn && !next) grantBtn.disabled = true;
  }

  /** Disable a granted/approved capability's `<option>` rather than removing it, so the
   *  control keeps showing the whole registry (#3322). `suffix` is appended once. */
  function markGrantOption(option: HTMLOptionElement | null | undefined, suffix: string, title?: string): void {
    if (!option) return;
    option.disabled = true;
    const text = option.textContent ?? option.value;
    if (!text.endsWith(suffix)) option.textContent = text + suffix;
    if (title) option.title = title;
    selectNextGrantable();
  }

  /** A granted option is disabled with " (granted)". */
  function markGrantOptionGranted(option: HTMLOptionElement | null | undefined): void {
    markGrantOption(option, " (granted)");
  }

  function showGrantStatus(msg: string, isError: boolean): void {
    if (!grantStatus) return;
    grantStatus.textContent = msg;
    grantStatus.setAttribute("data-error", isError ? "true" : "false");
    grantStatus.hidden = false;
  }

  type GrantOutcome = {
    live?: boolean;
    loadPath?: string | null;
    marker?: string | null;
    delayed?: boolean;
    // Set when the grant resolved an agent's request (#3106): whether a waiting agent collected it, and the notice to type if not.
    agentPickedUp?: boolean;
    agentNotice?: string | null;
  };

  type PendingSubmit = { timers: ReturnType<typeof setTimeout>[]; remaining: string[] };
  let pendingSubmit: PendingSubmit | null = null;

  // The gap enforced between any two flushed leftover frames: the text→Enter
  // gap a fresh sequence uses (see typeAndSubmit), reused for every hop so
  // Claude Code's paste detection never coalesces them. Not the smaller 50 ms
  // Ctrl-U→text gap — don't tune this down to that.
  const FLUSH_FRAME_GAP_MS = 150;

  /**
   * Cancel any outstanding delayed frames from a previous call and hand back
   * what's left of them, in order, so the caller can reschedule them at the
   * front of its own record. Keeping them in the one pending record (rather
   * than on detached timers) means a later overlapping call can still cancel
   * and reschedule them, so frames from three or more overlapping calls never
   * interleave.
   */
  function flushPendingSubmit(): string[] {
    if (!pendingSubmit) return [];
    const record = pendingSubmit;
    pendingSubmit = null;
    for (const timer of record.timers) clearTimeout(timer);
    return record.remaining;
  }

  /**
   * Type a line into the agent's terminal and submit it. Enter (and, when
   * `clearLine` is set, a leading Ctrl-U to clear the line first) goes as its
   * own frame after a short delay, because Claude Code's paste detection
   * treats a single chunk containing a newline as a paste and inserts it as a
   * literal line break instead of submitting. False when the terminal cannot
   * take input. A call that arrives while a previous call's delayed frames
   * are still pending takes them over: they go first, staggered by
   * FLUSH_FRAME_GAP_MS, so the earlier line is never lost, and its own frames
   * start only once those leftovers have drained.
   */
  function typeAndSubmit(text: string, opts: { clearLine?: boolean } = {}): boolean {
    if (sessionExited || !ws || ws.readyState !== WebSocket.OPEN) return false;
    const leftovers = flushPendingSubmit();
    localDraftDirty = false;

    const startDelay = leftovers.length * FLUSH_FRAME_GAP_MS;
    const ownFrames = opts.clearLine
      ? [{ data: "\x15", delay: 0 }, { data: text, delay: 50 }, { data: "\r", delay: 200 }]
      : [{ data: text, delay: 0 }, { data: "\r", delay: 150 }];
    const frames = [
      ...leftovers.map((data, i) => ({ data, delay: i * FLUSH_FRAME_GAP_MS })),
      ...ownFrames.map((frame) => ({ data: frame.data, delay: startDelay + frame.delay })),
    ];

    const record: PendingSubmit = { timers: [], remaining: frames.map((frame) => frame.data) };
    pendingSubmit = record;

    const sendFrame = (data: string): void => {
      if (record.remaining[0] === data) record.remaining.shift();
      if (record.remaining.length === 0 && pendingSubmit === record) pendingSubmit = null;
      if (sessionExited || !ws || ws.readyState !== WebSocket.OPEN) return;
      sendInput(data, { trackDraft: false });
    };

    // Only a fresh sequence's first frame goes out synchronously; leftovers
    // are always rescheduled onto timers so they stay cancelable.
    for (const frame of frames) {
      if (frame.delay === 0 && leftovers.length === 0) sendFrame(frame.data);
      else record.timers.push(setTimeout(() => sendFrame(frame.data), frame.delay));
    }

    return true;
  }

  function notifyAgent(text: string): boolean {
    return typeAndSubmit(text);
  }

  // The only capability delivered via a mounted file with no env vars to source
  // (delayed && !loadPath); mirrors capabilities.ts's GITHUB_AUTH_CAPABILITY_ID,
  // which this standalone browser bundle (no module imports) cannot reach.
  const GITHUB_AUTH_CAPABILITY_ID = "github-auth";

  /** The status line for a grant that resolved an agent's request: tell the agent in its terminal if it stopped waiting. */
  function requestGrantMessage(label: string, json: GrantOutcome, capability: string): string {
    if (json.live !== false) {
      if (json.agentNotice && notifyAgent(json.agentNotice)) return label + ": Granted — Claws told the agent in its terminal";
      if (json.agentPickedUp) return label + ": Granted — the agent picked it up";
    }
    return grantOutcomeMessage(label, json, true, capability);
  }
  /**
   * The status line for a successful grant. `fromRequest` is an approved agent
   * request: the agent may have stopped waiting for the decision, so it is only
   * told if it asks again.
   */
  function grantOutcomeMessage(label: string, json: GrantOutcome, fromRequest: boolean, capability: string): string {
    if (json.live === false) return label + ": Granted — takes effect once the session is ended and resumed from the sessions list";
    if (fromRequest) {
      let suffix = "";
      if (json.loadPath && json.delayed && json.marker) {
        suffix = " (or, once `grep -qxF '" + json.marker + "' " + json.loadPath + "` succeeds, run `. " + json.loadPath + "`)";
      } else if (json.loadPath) {
        suffix = " (or run `. " + json.loadPath + "`)";
      }
      return label + ": Granted — if the agent is no longer waiting, tell it to call claws_request_capability again" + suffix;
    }
    if (json.loadPath && json.delayed && json.marker) {
      return label + ": Granted. The file can take a minute or two to update — once `grep -qxF '" + json.marker + "' " + json.loadPath
        + "` succeeds, tell the agent to run `. " + json.loadPath + "` before commands that need it";
    }
    if (json.loadPath) return label + ": Granted. Tell the agent to run `. " + json.loadPath + "` before commands that need it";
    if (json.delayed && capability === GITHUB_AUTH_CAPABILITY_ID) {
      return label + ": Granted — gh and git are wired up; the mounted credential can take up to 2 minutes, so an early gh/git call may need a retry";
    }
    if (json.delayed) return label + ": Granted — can take up to 2 minutes to appear";
    return label + ": Granted";
  }

  async function grantCapability(): Promise<void> {
    if (!grantSelect || !grantBtn) return;
    const option = grantSelect.selectedOptions[0];
    if (!option || option.disabled) return;
    grantBtn.disabled = true;
    const label = option.textContent ?? option.value;
    // Grant may resolve a pending agent request and wait a few seconds for it to
    // be collected; the server skips that wait silently when there's nothing pending.
    const approvingMsg = label + ": Approving…";
    showGrantStatus(approvingMsg, false);
    const clearApproving = (): void => {
      if (grantStatus && grantStatus.textContent === approvingMsg) grantStatus.hidden = true;
    };
    try {
      const res = await fetch("/sessions/" + encodeURIComponent(sessionId!) + "/capabilities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: option.value }),
      });
      let json: GrantOutcome & { error?: string } = {};
      try { json = await res.json(); } catch { /* non-JSON error page */ }
      if (!res.ok) {
        // 400: no longer grantable (e.g. granted from another tab), so stop offering it.
        if (res.status === 400) markGrantOption(option, " (unavailable)", json.error);
        clearApproving();
        showGrantStatus(json.error ?? ("Grant failed (" + res.status + ")"), true);
        return;
      }
      markGrantOptionGranted(option);
      // `agentPickedUp` is only present when the grant resolved an agent's pending request.
      showGrantStatus(json.agentPickedUp !== undefined ? requestGrantMessage(label, json, option.value) : grantOutcomeMessage(label, json, false, option.value), false);
    } catch (err) {
      clearApproving();
      showGrantStatus("Grant failed: " + String(err), true);
    } finally {
      grantBtn.disabled = sessionUnavailable() || !hasGrantableOption();
    }
  }
  // The page marks a grantable option selected; re-check in case the browser restored a disabled one.
  if (grantSelect?.selectedOptions[0]?.disabled) selectNextGrantable();
  grantBtn?.addEventListener("pointerdown", (e) => { e.preventDefault(); });
  grantBtn?.addEventListener("click", () => { void grantCapability(); });

  // ── Capability requests from the agent, awaiting the operator (#3072) ──
  // `reason` is agent-controlled text: it only ever reaches the DOM via textContent.
  const capRequestsEl = document.getElementById("cap-requests");
  type PendingCapRequest = { capability: string; label: string; reason: string };
  const capBanners = new Map<string, HTMLElement>();
  // Bumped by every poll and around every decision, so a poll response that
  // started before a newer poll or a decision cannot re-add a decided banner.
  let capRequestsGen = 0;
  let capRequestsTimer: ReturnType<typeof setInterval> | null = null;

  function buildCapRequestBanner(req: PendingCapRequest): HTMLElement {
    const row = document.createElement("div");
    row.className = "cap-request";
    const text = document.createElement("span");
    text.className = "cap-request-text";
    const title = document.createElement("strong");
    title.textContent = "Agent requests " + req.label;
    const reason = document.createElement("span");
    reason.textContent = req.reason ? " — " + req.reason : "";
    text.append(title, reason);
    const approveBtn = document.createElement("button");
    approveBtn.type = "button";
    approveBtn.className = "trigger-btn";
    approveBtn.textContent = "Approve";
    const denyBtn = document.createElement("button");
    denyBtn.type = "button";
    denyBtn.className = "trigger-btn";
    denyBtn.textContent = "Deny";
    const error = document.createElement("span");
    error.className = "cap-request-error";
    error.hidden = true;

    async function decide(approve: boolean): Promise<void> {
      approveBtn.disabled = true;
      denyBtn.disabled = true;
      error.hidden = true;
      capRequestsGen++;
      // Approval can wait a few seconds for a polling agent to collect the grant.
      const approvingMsg = req.label + ": Approving…";
      if (approve) showGrantStatus(approvingMsg, false);
      const clearApproving = (): void => {
        if (grantStatus && grantStatus.textContent === approvingMsg) grantStatus.hidden = true;
      };
      try {
        const res = await fetch("/sessions/" + encodeURIComponent(sessionId!) + "/capability-requests/"
          + encodeURIComponent(req.capability) + (approve ? "/approve" : "/deny"), { method: "POST" });
        let json: GrantOutcome & { error?: string; code?: string } = {};
        try { json = await res.json(); } catch { /* non-JSON error page */ }
        // 409 or no-request: already decided (another tab) or gone (Claws restarted) — drop the banner.
        // Any other failure, including a grant to a session that is no longer live, is shown.
        const gone = res.status === 409 || (res.status === 404 && json.code === "no-request");
        if (!res.ok && !gone) {
          error.textContent = json.error ?? ((approve ? "Approve" : "Deny") + " failed (" + res.status + ")");
          error.hidden = false;
          clearApproving();
          return;
        }
        row.remove();
        capBanners.delete(req.capability);
        if (capRequestsEl) capRequestsEl.hidden = capBanners.size === 0;
        if (res.ok && approve) {
          markGrantOptionGranted(grantSelect?.querySelector<HTMLOptionElement>("option[value=\"" + CSS.escape(req.capability) + "\"]"));
          showGrantStatus(requestGrantMessage(req.label, json, req.capability), false);
        } else {
          clearApproving();
        }
      } catch (err) {
        error.textContent = (approve ? "Approve" : "Deny") + " failed: " + String(err);
        error.hidden = false;
        clearApproving();
      } finally {
        capRequestsGen++;
        approveBtn.disabled = sessionUnavailable();
        denyBtn.disabled = sessionUnavailable();
      }
    }
    approveBtn.addEventListener("click", () => { void decide(true); });
    denyBtn.addEventListener("click", () => { void decide(false); });
    row.append(text, approveBtn, denyBtn, error);
    return row;
  }

  /** Add banners for new pending requests and drop decided ones, leaving the rest (and any error they show) untouched. */
  function syncCapRequests(list: PendingCapRequest[]): void {
    if (!capRequestsEl) return;
    const pending = new Set(list.map((r) => r.capability));
    for (const [cap, el] of capBanners) {
      if (!pending.has(cap)) { el.remove(); capBanners.delete(cap); }
    }
    for (const req of list) {
      if (capBanners.has(req.capability)) continue;
      const el = buildCapRequestBanner(req);
      capBanners.set(req.capability, el);
      capRequestsEl.append(el);
    }
    capRequestsEl.hidden = capBanners.size === 0;
  }

  async function pollCapRequests(): Promise<void> {
    if (!capRequestsEl || sessionExited || document.visibilityState !== "visible") return;
    const gen = ++capRequestsGen;
    try {
      const res = await fetch("/sessions/" + encodeURIComponent(sessionId!) + "/capability-requests");
      if (!res.ok) return;
      const json = await res.json() as { requests?: PendingCapRequest[] };
      if (!sessionExited && gen === capRequestsGen) syncCapRequests(json.requests ?? []);
    } catch { /* transient — the next tick retries */ }
  }
  if (capRequestsEl && sessionWasAliveAtLoad) {
    void pollCapRequests();
    capRequestsTimer = setInterval(() => { void pollCapRequests(); }, 5000);
    document.addEventListener("visibilitychange", () => { void pollCapRequests(); });
  }

  const MAX_INLINE_UPLOAD_BYTES = 10 * 1024 * 1024;
  const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
  const uploadToast = document.getElementById("upload-toast");
  const uploadToastMsg = document.getElementById("upload-toast-msg");
  const uploadToastClose = document.getElementById("upload-toast-close");
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function hideToast(): void {
    if (!uploadToast) return;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    (uploadToast as HTMLElement).style.display = "none";
  }

  function showToast(msg: string, isError = false, sticky = false): void {
    if (!uploadToast || !uploadToastMsg) return;
    uploadToastMsg.textContent = msg;
    uploadToast.setAttribute("data-error", isError ? "true" : "false");
    (uploadToast as HTMLElement).style.display = "flex";
    if (toastTimer) clearTimeout(toastTimer);
    if (sticky) return;
    toastTimer = setTimeout(hideToast, 4000);
  }

  if (uploadToastClose) {
    uploadToastClose.addEventListener("pointerdown", (e) => {
      e.preventDefault();
    });
    uploadToastClose.addEventListener("click", () => {
      hideToast();
    });
  }

  function uploadLarge(file: File): Promise<{ path?: string; error?: string }> {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/sessions/" + encodeURIComponent(sessionId!) +
        "/upload-stream?name=" + encodeURIComponent(file.name));
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      let lastPct = -1;
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.floor((e.loaded / e.total) * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        showToast("Uploading " + file.name + "… " + pct + "%", false, true);
      };
      xhr.onload = () => {
        try {
          const json = JSON.parse(xhr.responseText) as { path?: string; error?: string };
          resolve(xhr.status >= 200 && xhr.status < 300 ? json : { error: json.error ?? "Upload failed (" + xhr.status + ")" });
        } catch { resolve({ error: "Upload failed (" + xhr.status + ")" }); }
      };
      xhr.onerror = () => resolve({ error: "Upload failed — connection lost" });
      xhr.onabort = () => resolve({ error: "Upload cancelled" });
      xhr.send(file);
    });
  }

  type UploadTerminalResult =
    | { ok: true; text: string; kind: "transcript" | "path"; warning?: string }
    | { ok: false; error: string };

  async function uploadFileForTerminal(file: File): Promise<UploadTerminalResult> {
    if (sessionExited || startupFailed || !ws || ws.readyState !== WebSocket.OPEN) {
      return { ok: false, error: "Not connected — file not attached" };
    }
    if (file.size === 0) {
      return { ok: false, error: file.name + ": empty file or folder — not uploaded" };
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return { ok: false, error: file.name + " is larger than 1 GB" };
    }
    if (file.size <= MAX_INLINE_UPLOAD_BYTES) {
      const isAudio = file.type.indexOf("audio/") === 0;
      if (isAudio) showToast("Transcribing " + file.name + "…", false, true);
      const fd = new FormData();
      fd.append("file", file, file.name);
      const res = await fetch("/sessions/" + encodeURIComponent(sessionId!) + "/upload", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        let message = "Upload failed (" + res.status + ")";
        try {
          const json = (await res.json()) as { error?: string };
          if (json.error) message = json.error;
        } catch { /* ignore malformed error body */ }
        return { ok: false, error: message };
      }
      const json = (await res.json()) as { path: string; transcript?: string; transcriptError?: string };
      if (json.transcript) return { ok: true, text: json.transcript, kind: "transcript" };
      if (json.transcriptError) {
        return { ok: true, text: json.path, kind: "path", warning: json.transcriptError };
      }
      return { ok: true, text: json.path, kind: "path" };
    }
    const result = await uploadLarge(file);
    if (!result.path) return { ok: false, error: result.error ?? "Upload failed" };
    return { ok: true, text: result.path, kind: "path" };
  }

  async function uploadFile(file: File): Promise<void> {
    try {
      const result = await uploadFileForTerminal(file);
      if (!result.ok) {
        showToast(result.error, true);
        return;
      }
      sendInput(result.text + " ");
      if (result.warning) showToast(result.warning + " — attached as " + result.text, true);
      else if (result.kind === "transcript") showToast("Transcribed " + file.name);
      else showToast("Attached " + result.text);
    } catch (err) {
      showToast("Upload failed: " + String(err), true);
    }
  }

  async function uploadFiles(files: FileList | File[]): Promise<void> {
    for (const file of Array.from(files)) {
      await uploadFile(file);
    }
  }

  let dragDepth = 0;
  const overlay = document.getElementById("drop-overlay");

  function hasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer && Array.from(e.dataTransfer.types).indexOf("Files") !== -1;
  }

  /** A terminal that exited or never started has nothing to attach a file to. */
  function uploadsDisabled(): boolean {
    return sessionUnavailable();
  }

  window.addEventListener("dragenter", (e: DragEvent) => {
    if (!hasFiles(e) || uploadsDisabled()) return;
    e.preventDefault();
    dragDepth++;
    overlay?.setAttribute("data-active", "true");
  });
  window.addEventListener("dragover", (e: DragEvent) => {
    if (!hasFiles(e) || uploadsDisabled()) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (e: DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay?.setAttribute("data-active", "false");
  });
  window.addEventListener("drop", (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay?.setAttribute("data-active", "false");
    // Still preventDefault above, or the browser navigates away from the terminal to the
    // dropped file; just don't pretend the upload can go anywhere.
    if (uploadsDisabled()) return;
    void uploadFiles(e.dataTransfer!.files);
    term.focus();
  });

  const attachBtn = document.getElementById("attach-btn") as HTMLButtonElement | null;
  const attachInput = document.getElementById("attach-input") as HTMLInputElement | null;
  if (attachBtn && attachInput) {
    attachBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
    });
    attachBtn.addEventListener("click", () => {
      attachInput.click();
    });
    attachInput.addEventListener("change", () => {
      void uploadFiles(attachInput.files ?? []);
      attachInput.value = "";
    });
  }

  const micBtn = document.getElementById("mic-btn") as HTMLButtonElement | null;
  type MicState = "idle" | "requesting" | "recording" | "stopping" | "processing";
  type RecordingMode = "tap" | "hold";
  let recorder: MediaRecorder | null = null;
  let micStream: MediaStream | null = null;
  let micIdleTimer: number | null = null;
  let recChunks: Blob[] = [];
  let micState: MicState = "idle";
  let recordingMode: RecordingMode = "tap";
  let recordingId = 0;
  let activeRecordingId = 0;
  let shouldSubmitRecording = false;
  let stopWhenReady: { id: number; submit: boolean } | null = null;
  const HOLD_TO_TALK_MS = 250;
  // WebKit (every iPadOS browser, Chrome included) forgets a getUserMedia grant shortly
  // after the last track on the stream stops, so a fresh call re-prompts. Keeping the
  // stream alive between notes gets one grant per page load; it is released on hide,
  // session end, a dead track, or this much idle time so the mic indicator doesn't stay
  // lit forever (#clw_01M381G1CNYTSFFPY4CEAP4YST).
  const MIC_IDLE_RELEASE_MS = 3 * 60 * 1000;

  function pickRecordingType(): { mime: string; ext: string } {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported) {
      if (MediaRecorder.isTypeSupported("audio/webm")) return { mime: "audio/webm", ext: "webm" };
      if (MediaRecorder.isTypeSupported("audio/mp4")) return { mime: "audio/mp4", ext: "m4a" };
    }
    return { mime: "", ext: "webm" };
  }

  function renderMicState(): void {
    if (!micBtn) return;
    const isRecording = micState === "recording";
    const isBusy = micState === "requesting" || micState === "stopping" || micState === "processing";
    micBtn.textContent = isRecording ? "Recording" : isBusy ? "Processing" : "Record";
    micBtn.disabled = sessionUnavailable() || micState === "requesting" || micState === "stopping" || micState === "processing";
    micBtn.setAttribute("data-recording", isRecording ? "true" : "false");
    micBtn.setAttribute("data-processing", isBusy ? "true" : "false");
    micBtn.setAttribute("aria-pressed", isRecording ? "true" : "false");
    micBtn.setAttribute("aria-busy", isBusy ? "true" : "false");
  }

  function submitVoiceText(text: string): { sent: boolean; replacedDraft: boolean } {
    const trimmed = text.trim();
    if (!trimmed) return { sent: false, replacedDraft: false };
    const replacedDraft = localDraftDirty;
    if (!typeAndSubmit(trimmed, { clearLine: true })) return { sent: false, replacedDraft: false };
    showToast(replacedDraft ? "Voice note sent; replaced the typed draft" : "Voice note sent");
    return { sent: true, replacedDraft };
  }

  function micStreamHealthy(): boolean {
    return micStream !== null && micStream.getTracks().every((t) => t.readyState === "live");
  }

  /** Safe to call with nothing cached. */
  function releaseMicStream(): void {
    if (micIdleTimer !== null) { window.clearTimeout(micIdleTimer); micIdleTimer = null; }
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
  }

  async function acquireMicStream(): Promise<MediaStream> {
    if (micIdleTimer !== null) { window.clearTimeout(micIdleTimer); micIdleTimer = null; }
    if (micStreamHealthy()) return micStream as MediaStream;
    releaseMicStream();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStream = stream;
    stream.getTracks().forEach((t) => {
      t.onended = () => {
        // A note in flight is caught by settleMicStream() instead; releasing here too
        // could drop a stream a recorder is still using.
        if (micState === "idle" || micState === "processing") releaseMicStream();
      };
    });
    return stream;
  }

  /** Called wherever a note finishes or aborts, in place of unconditionally stopping tracks. */
  function settleMicStream(): void {
    if (document.visibilityState !== "visible" || sessionUnavailable() || !micStreamHealthy()) {
      releaseMicStream();
      return;
    }
    if (micIdleTimer !== null) window.clearTimeout(micIdleTimer);
    micIdleTimer = window.setTimeout(() => {
      micIdleTimer = null;
      if (micState === "idle" || micState === "processing") releaseMicStream();
    }, MIC_IDLE_RELEASE_MS);
  }

  async function startRecording(mode: RecordingMode): Promise<number | null> {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
      showToast("Recording needs HTTPS and a supported browser", true);
      return null;
    }
    if (micState !== "idle") return null;
    const id = ++recordingId;
    activeRecordingId = id;
    recordingMode = mode;
    shouldSubmitRecording = true;
    stopWhenReady = null;
    micState = "requesting";
    renderMicState();
    let stream: MediaStream;
    try {
      stream = await acquireMicStream();
    } catch {
      showToast("Microphone access denied", true);
      if (activeRecordingId === id) {
        micState = "idle";
        activeRecordingId = 0;
        stopWhenReady = null;
        renderMicState();
      }
      return null;
    }
    const permissionStop = stopWhenReady as { id: number; submit: boolean } | null;
    if (
      document.visibilityState !== "visible" ||
      sessionUnavailable() ||
      activeRecordingId !== id ||
      (permissionStop?.id === id && !permissionStop.submit)
    ) {
      settleMicStream();
      if (activeRecordingId === id) {
        micState = "idle";
        activeRecordingId = 0;
        stopWhenReady = null;
        renderMicState();
      }
      return null;
    }
    const { mime, ext } = pickRecordingType();
    recChunks = [];
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => {
        if (activeRecordingId === id && e.data.size > 0) recChunks.push(e.data);
      };
      recorder.onstop = () => {
        if (activeRecordingId !== id) return;
        micState = "processing";
        renderMicState();
        settleMicStream();
        const blob = new Blob(recChunks, { type: mime || "audio/webm" });
        recChunks = [];
        const submit = shouldSubmitRecording;
        shouldSubmitRecording = false;
        recorder = null;
        activeRecordingId = 0;
        stopWhenReady = null;
        if (!submit) {
          micState = "idle";
          renderMicState();
          return;
        }
        if (blob.size === 0) {
          showToast("Empty recording — nothing sent", true);
          micState = "idle";
          renderMicState();
          return;
        }
        showToast("Processing voice note…", false, true);
        void uploadFileForTerminal(new File([blob], "voice-note-" + Date.now() + "." + ext, { type: blob.type }))
          .then((result) => {
            if (!result.ok) {
              showToast(result.error, true);
              return;
            }
            const submitted = submitVoiceText(result.text);
            if (!submitted.sent) {
              showToast("Voice note could not be sent", true);
              return;
            }
            if (result.warning) {
              showToast(
                result.warning + " — voice note sent as saved audio path" +
                  (submitted.replacedDraft ? "; replaced the typed draft" : ""),
                true,
              );
            }
          })
          .catch((err) => {
            showToast("Upload failed: " + String(err), true);
          })
          .finally(() => {
            micState = "idle";
            renderMicState();
          });
      };
      recorder.start();
    } catch {
      showToast("Recording could not be started", true);
      recorder = null;
      releaseMicStream();
      if (activeRecordingId === id) {
        micState = "idle";
        activeRecordingId = 0;
        stopWhenReady = null;
        renderMicState();
      }
      return null;
    }
    if (activeRecordingId !== id) return null;
    micState = "recording";
    renderMicState();
    showToast(mode === "hold" ? "Recording… release to send" : "Recording… tap again to send", false, true);
    const readyStop = stopWhenReady as { id: number; submit: boolean } | null;
    const pendingStop = readyStop?.id === id ? readyStop : null;
    if (pendingStop) stopRecording({ submit: pendingStop.submit, id });
    return id;
  }

  function stopRecording(opts: { submit: boolean; id?: number } = { submit: true }): void {
    const id = opts.id ?? activeRecordingId;
    if (!id) return;
    if (micState === "requesting") {
      stopWhenReady = { id, submit: opts.submit };
      shouldSubmitRecording = opts.submit;
      if (!opts.submit) showToast("Recording cancelled", false);
      return;
    }
    if (activeRecordingId !== id || micState !== "recording") return;
    shouldSubmitRecording = opts.submit;
    micState = "stopping";
    renderMicState();
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      return;
    }
    recorder = null;
    settleMicStream();
    recChunks = [];
    activeRecordingId = 0;
    shouldSubmitRecording = false;
    micState = "idle";
    renderMicState();
  }

  if (micBtn) {
    renderMicState();
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let holdPointerId: number | null = null;
    let holdRecordingId: number | null = null;
    let holdActive = false;
    let suppressNextClick = false;

    function clearHoldTimer(): void {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    }

    micBtn.addEventListener("pointerdown", (e) => {
      if (!e.isPrimary || e.button !== 0 || micState !== "idle") {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      holdPointerId = e.pointerId;
      holdActive = false;
      holdRecordingId = null;
      try { micBtn.setPointerCapture(e.pointerId); } catch { /* unsupported capture */ }
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (holdPointerId !== e.pointerId || micState !== "idle") return;
        holdActive = true;
        suppressNextClick = true;
        const promise = startRecording("hold");
        holdRecordingId = activeRecordingId || null;
        void promise.then((id) => {
          if (id !== null) holdRecordingId = id;
        });
      }, HOLD_TO_TALK_MS);
    });

    micBtn.addEventListener("pointerup", (e) => {
      if (holdPointerId !== e.pointerId) return;
      clearHoldTimer();
      try { micBtn.releasePointerCapture(e.pointerId); } catch { /* unsupported capture */ }
      holdPointerId = null;
      if (holdActive) {
        e.preventDefault();
        suppressNextClick = true;
        const id = holdRecordingId ?? activeRecordingId;
        stopRecording({ submit: true, id });
        holdActive = false;
        holdRecordingId = null;
      }
    });

    micBtn.addEventListener("pointercancel", (e) => {
      if (holdPointerId !== e.pointerId) return;
      clearHoldTimer();
      try { micBtn.releasePointerCapture(e.pointerId); } catch { /* unsupported capture */ }
      holdPointerId = null;
      suppressNextClick = true;
      if (holdActive || micState === "requesting") {
        stopRecording({ submit: false, id: holdRecordingId ?? activeRecordingId });
      }
      holdActive = false;
      holdRecordingId = null;
    });

    micBtn.addEventListener("click", () => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      if (micState === "recording" && recordingMode === "tap") stopRecording({ submit: true });
      else if (micState === "idle") void startRecording("tap");
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") return;
      if (micState === "recording") {
        // onstop settles the stream once it sees the page is hidden.
        stopRecording({ submit: true });
      } else if (micState === "idle" || micState === "processing") {
        releaseMicStream();
      }
    });
    window.addEventListener("pagehide", releaseMicStream);
  }

  const copyBtn = document.getElementById("copy-btn") as HTMLButtonElement | null;
  const copyOverlay = document.getElementById("copy-overlay");
  const copyTextarea = document.getElementById("copy-textarea") as HTMLTextAreaElement | null;
  const copyAllBtn = document.getElementById("copy-all-btn") as HTMLButtonElement | null;
  const copyCloseBtn = document.getElementById("copy-close-btn") as HTMLButtonElement | null;

  function closeCopyOverlay(): void {
    if (copyOverlay) copyOverlay.style.display = "none";
    term.focus();
  }

  if (copyBtn && copyOverlay && copyTextarea) {
    copyBtn.addEventListener("click", () => {
      copyTextarea.value = getTerminalText();
      copyOverlay.style.display = "flex";
      copyTextarea.scrollTop = copyTextarea.scrollHeight;
    });
  }
  if (copyCloseBtn) copyCloseBtn.addEventListener("click", closeCopyOverlay);
  if (copyOverlay) {
    copyOverlay.addEventListener("click", (e) => {
      if (e.target === copyOverlay) closeCopyOverlay();
    });
  }
  if (copyAllBtn && copyTextarea) {
    copyAllBtn.addEventListener("click", () => {
      const text = copyTextarea.value;
      const done = (ok: boolean): void => {
        copyAllBtn.textContent = ok ? "Copied ✓" : "Copy failed";
        setTimeout(() => { copyAllBtn.textContent = "Copy all"; }, 1500);
      };
      const fallback = (): void => {
        try {
          copyTextarea.focus();
          copyTextarea.select();
          done(document.execCommand("copy"));
        } catch { done(false); }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => done(true), fallback);
      } else {
        fallback();
      }
    });
  }

  // Copy xterm's own selection (the canvas selection layer is invisible to the
  // browser's native Cmd+C, which is why native copy grabbed only a word).
  const copyBtnLabel = copyBtn ? copyBtn.textContent : null;
  function flashCopied(ok: boolean): void {
    if (!copyBtn) return;
    copyBtn.textContent = ok ? "Copied ✓" : "Copy failed";
    setTimeout(() => { copyBtn.textContent = copyBtnLabel ?? "Copy"; }, 1200);
  }

  function writeClipboard(text: string): void {
    if (!text) return;
    const fallback = (): void => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        // The fallback stole keyboard focus from xterm's helper textarea; give it
        // back, or the next keystroke goes nowhere (matters now that copies can
        // happen without the user asking for one).
        term.focus();
        flashCopied(ok);
      } catch { term.focus(); flashCopied(false); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => flashCopied(true), fallback);
    } else {
      fallback();
    }
  }

  function copySelection(): boolean {
    if (!term.hasSelection()) return false;
    const text = term.getSelection();
    if (!text) return false;
    writeClipboard(text);
    return true;
  }

  // Cmd+C (mac) or Ctrl+Shift+C (linux/windows) copies the xterm selection.
  // Returning false stops xterm from also sending the key to the shell.
  // IMPORTANT: never hijack a plain Ctrl+C — that must stay SIGINT.
  term.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
    if (e.type !== "keydown") return true;
    const isCopyKey = (e.key === "c" || e.key === "C");
    if (!isCopyKey) return true;
    const cmdC = e.metaKey && !e.ctrlKey && !e.altKey;
    const ctrlShiftC = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
    if (cmdC || ctrlShiftC) {
      if (term.hasSelection()) {
        e.preventDefault();
        copySelection();
        return false;
      }
      // No selection: on mac let the browser do nothing; on ctrl+shift+c
      // there is no shell meaning, so swallow it to avoid stray input.
      if (ctrlShiftC) return false;
    }
    return true;
  });

  // Right-click a selection copies it directly, so the selection is not lost
  // to the context menu (the previous UX complaint).
  termEl.addEventListener("contextmenu", (e) => {
    if (term.hasSelection()) {
      e.preventDefault();
      copySelection();
    }
  });

  // Auto-copy: releasing a drag that started inside the terminal copies xterm's
  // own selection (Shift-drag on linux/windows, Option-drag on mac — a plain drag
  // goes to tmux, handled by the OSC 52 relay below). The mouseup is on `document`
  // so a drag ending outside the terminal still copies; the mousedown gate stops a
  // click elsewhere on the page from re-copying a stale selection.
  let dragStartedInTerminal = false;
  termEl.addEventListener("mousedown", (e) => {
    // Left button only: a right-click mousedown would double-copy alongside the
    // contextmenu handler.
    if ((e as MouseEvent).button === 0) dragStartedInTerminal = true;
  });
  document.addEventListener("mouseup", () => {
    if (!dragStartedInTerminal) return;
    dragStartedInTerminal = false;
    copySelection();
  });

  // tmux (mouse mode + set-clipboard on) emits OSC 52 when copy-mode copies.
  // xterm.js core ignores OSC 52 — the clipboard addon is not loaded — so decode
  // it here, which makes a plain drag-select inside tmux copy-on-select too.
  // The server strips these out of the reconnect scrollback buffer, so this only
  // ever fires on live output, never on a replay.
  const OSC52_MAX_B64 = 2_000_000;
  function decodeBase64Utf8(b64: string): string | null {
    try {
      const bin = atob(b64.replace(/\s+/g, ""));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch { return null; }
  }

  // An OSC 52 write has no user gesture behind it. tmux's copy-mode copy and a
  // raw escape sequence printed by anything running in the session — a `cat` of
  // a repo file, a build step, Claude echoing untrusted issue text — arrive as
  // the identical bytes, so the client cannot tell them apart. That makes this a
  // clipboard-poisoning channel: attacker-chosen text could land in the
  // operator's clipboard with nothing on screen to show for it. We cannot
  // authenticate the source, so make the write *visible* instead — every
  // OSC-52-driven copy raises a transient toast naming what was copied, so an
  // unexpected overwrite is noticed now rather than at the next paste. The
  // deliberate paths (mouseup, Cmd+C, right-click) stay silent apart from the
  // existing Copy-button flash.
  const OSC52_TOAST_PREVIEW = 60;
  function clipboardPreview(text: string): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    if (oneLine.length <= OSC52_TOAST_PREVIEW) return oneLine;
    return oneLine.slice(0, OSC52_TOAST_PREVIEW) + "…";
  }
  term.parser?.registerOscHandler(52, (data: string): boolean => {
    const semi = data.indexOf(";");
    if (semi === -1) return true;
    const payload = data.slice(semi + 1);
    // "?" is a clipboard *read* request. Never answer it — that would let anything
    // running in the session exfiltrate the browser clipboard. Swallow it.
    if (payload === "?" || payload.length === 0) return true;
    if (payload.length > OSC52_MAX_B64) return true;
    const text = decodeBase64Utf8(payload);
    if (text) {
      writeClipboard(text);
      showToast("Terminal output set your clipboard: " + clipboardPreview(text));
    }
    return true; // handled — never let the escape sequence reach the screen
  });

  function connect(): void {
    if (reconnectTimer !== null) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
    // The one place that decides whether attaching is worth trying at all, so no caller — the
    // startup poller, a socket's own backoff, a timer scheduled before the session died — has to
    // cancel work it does not own. Nobody may attach to a session the page has already declared
    // dead and disabled every input control for, and whoever is second must not open a duplicate
    // socket, which the server would happily attach and echo twice.
    if (sessionExited || startupFailed) return;
    if (ws !== null && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(protocol + "//" + location.host + "/sessions/" + encodeURIComponent(sessionId!) + "/ws");
    ws = socket;

    ws.onopen = () => {
      startupReady = true;
      if (startupEl) startupEl.hidden = true;
      reconnectDelay = 1000;
      if (!isFirstConnection) {
        term.reset();
      }
      isFirstConnection = false;
      fitAddon.fit();
      sendResize();
    };

    ws.onmessage = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as { type: string; data?: string; code?: number };
      if (msg.type === "output") {
        term.write(msg.data ?? "");
      } else if (msg.type === "exit") {
        sessionExited = true;
        disableInputControls();
        if (capRequestsEl) capRequestsEl.hidden = true;
        if (capRequestsTimer !== null) { clearInterval(capRequestsTimer); capRequestsTimer = null; }
        stopRecording({ submit: false });
        const code = msg.code ?? 0;
        // Stay on the last output whatever the code (#3311): a crash must stay readable,
        // and "← Back" is the way out.
        term.write(code === 0
          ? "\r\n\x1b[32m[Session exited cleanly (code 0)]\x1b[0m\r\n"
          : "\r\n\x1b[31m[Session exited with code " + code + "]\x1b[0m\r\n");
        if (startupEl) {
          // The saved copy appears once the backend ends the row, which on k8s waits for reconcile.
          startupEl.textContent = "Session ended (exit " + code + ") · ";
          const link = document.createElement("a");
          link.href = "/sessions/" + encodeURIComponent(sessionId!);
          link.textContent = "View saved output";
          startupEl.append(link, " (may take a few seconds to appear)");
          startupEl.setAttribute("data-state", "ended");
          startupEl.hidden = false;
        }
      } else if (msg.type === "scrollback") {
        term.write(msg.data ?? "");
      }
    };

    ws.onclose = () => {
      // A socket superseded by a newer connect() is nobody's business but its own.
      if (ws !== socket) return;
      scrolledNotches = 0;
      if (sessionExited || startupFailed) return;
      // A stale session makes the /sessions/:id/ws upgrade 401 forever; ask
      // auth-watch to re-login rather than backing off silently (#2479).
      window.clawsAuthCheck?.();
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      if (startupReady) term.write("\r\n\x1b[33m[Reconnecting in " + Math.round(delay / 1000) + "s…]\x1b[0m\r\n");
      reconnectTimer = window.setTimeout(connect, delay);
    };

    ws.onerror = () => {
      if (ws !== socket) return;
      if (startupReady) term.write("\r\n\x1b[31m[WebSocket error — will attempt to reconnect]\x1b[0m\r\n");
    };
  }

  const mq = window.matchMedia("(prefers-color-scheme: light)");
  mq.addEventListener("change", () => {
    if (!document.documentElement.getAttribute("data-theme")) {
      term.options.theme = getXtermTheme();
    }
  });
  new MutationObserver(() => {
    term.options.theme = getXtermTheme();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  void pollStartup();
  connect();

  const keybar = document.getElementById("mobile-keybar");
  if (keybar) {
    // Keys fire on click, not pointerdown, so dragging the bar sideways to
    // scroll it does not send a keypress (#2870). pointerdown only cancels the
    // compat mouse events, which keeps focus (and the iOS on-screen keyboard)
    // on the terminal; click is still dispatched. Same pattern as the Paste,
    // Attach and Record buttons above.
    keybar.addEventListener("pointerdown", (e) => {
      const target = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(".kb-key");
      if (!target) return;
      e.preventDefault();
      target.setAttribute("data-pressed", "true");
    });

    // data-pressed is cosmetic only — it never gates key delivery. A stale
    // highlight (pointer released off the bar) is cleared by the next press.
    const clearPressed = (): void => {
      for (const el of keybar.querySelectorAll(".kb-key[data-pressed]")) {
        el.removeAttribute("data-pressed");
      }
    };
    keybar.addEventListener("pointerup", clearPressed);
    keybar.addEventListener("pointercancel", clearPressed);
    keybar.addEventListener("pointerleave", clearPressed);

    keybar.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(".kb-key");
      if (!target) return;
      clearPressed();
      const action = target.getAttribute("data-action");
      if (action === "ctrl") {
        ctrlSticky = !ctrlSticky;
        target.setAttribute("data-active", ctrlSticky ? "true" : "false");
        return;
      }
      if (action === "font-dec") { setFontSize(currentFontSize - 1); return; }
      if (action === "font-inc") { setFontSize(currentFontSize + 1); return; }
      if (action === "page-up") { scrollUp(pageNotches()); return; }
      if (action === "page-down") { scrollDown(pageNotches()); return; }
      if (action === "scroll-bottom") { scrollToBottom(); return; }
      if (action === "ctrl-d-double") {
        const eot = KEY_MAP["ctrl-d"];
        sendInput(eot);
        setTimeout(() => sendInput(eot), 50);
        return;
      }
      const key = target.getAttribute("data-key");
      if (!key) return;
      const seq = KEY_MAP[key];
      if (seq !== undefined) sendInput(seq);
    });
  }
})();
