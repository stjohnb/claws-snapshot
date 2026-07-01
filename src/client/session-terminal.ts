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

(() => {
  const XTERM_DARK: XtermTheme = {
    background: "#0d1117",
    foreground: "#c9d1d9",
    cursor: "#58a6ff",
    selectionBackground: "#484f58",
    black: "#0d1117",
    red: "#f85149",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#8b949e",
    brightRed: "#ff7b72",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#ffffff",
  };
  const XTERM_LIGHT: XtermTheme = {
    background: "#ffffff",
    foreground: "#1f2328",
    cursor: "#0969da",
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

  let ws: WebSocket | null = null;
  let sessionExited = false;
  let reconnectDelay = 1000;
  let isFirstConnection = true;
  let ctrlSticky = false;

  function sendInput(data: string): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    }
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
    pgup: "\x1b[5~",
    pgdn: "\x1b[6~",
    "ctrl-c": "\x03",
    "ctrl-d": "\x04",
    "ctrl-z": "\x1a",
    "ctrl-l": "\x0c",
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

  function connect(): void {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(protocol + "//" + location.host + "/sessions/" + encodeURIComponent(sessionId!) + "/ws");

    ws.onopen = () => {
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
        if (pasteBtn) pasteBtn.disabled = true;
        const code = msg.code ?? 0;
        if (code === 0 && sessionWasAliveAtLoad) {
          try {
            window.sessionStorage.setItem("claws.sessionFlash", "Session exited cleanly.");
          } catch { /* private mode / quota — fall back to query string */ }
          term.write("\r\n\x1b[32m[Session exited cleanly — returning to sessions list…]\x1b[0m\r\n");
          if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
          window.location.assign("/sessions?notice=session-exited");
          return;
        }
        term.write("\r\n\x1b[31m[Session exited with code " + code + "]\x1b[0m\r\n");
      } else if (msg.type === "scrollback") {
        term.write(msg.data ?? "");
      }
    };

    ws.onclose = () => {
      if (sessionExited) return;
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      term.write("\r\n\x1b[33m[Reconnecting in " + Math.round(delay / 1000) + "s…]\x1b[0m\r\n");
      setTimeout(connect, delay);
    };

    ws.onerror = () => {
      term.write("\r\n\x1b[31m[WebSocket error — will attempt to reconnect]\x1b[0m\r\n");
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

  connect();

  const keybar = document.getElementById("mobile-keybar");
  if (keybar) {
    keybar.addEventListener("pointerdown", (e) => {
      const target = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(".kb-key");
      if (!target) return;
      // Prevent focus loss so the iOS on-screen keyboard does not dismiss.
      e.preventDefault();
      const action = target.getAttribute("data-action");
      if (action === "ctrl") {
        ctrlSticky = !ctrlSticky;
        target.setAttribute("data-active", ctrlSticky ? "true" : "false");
        return;
      }
      if (action === "font-dec") { setFontSize(currentFontSize - 1); return; }
      if (action === "font-inc") { setFontSize(currentFontSize + 1); return; }
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
