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
  getSelection(): string;
  hasSelection(): boolean;
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void;
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
    // Types the /ship slash command and submits it immediately (#2857, #2858).
    ship: "/ship\r",
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

  const MAX_INLINE_UPLOAD_BYTES = 10 * 1024 * 1024;
  const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
  const uploadToast = document.getElementById("upload-toast");
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function showToast(msg: string, isError = false, sticky = false): void {
    if (!uploadToast) return;
    uploadToast.textContent = msg;
    uploadToast.setAttribute("data-error", isError ? "true" : "false");
    (uploadToast as HTMLElement).style.display = "block";
    if (toastTimer) clearTimeout(toastTimer);
    if (sticky) return;
    toastTimer = setTimeout(() => {
      (uploadToast as HTMLElement).style.display = "none";
    }, 4000);
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

  async function uploadFile(file: File): Promise<void> {
    try {
      if (sessionExited || !ws || ws.readyState !== WebSocket.OPEN) {
        showToast("Not connected — file not attached", true);
        return;
      }
      if (file.size === 0) {
        showToast(file.name + ": empty file or folder — not uploaded", true);
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        showToast(file.name + " is larger than 1 GB", true);
        return;
      }
      let path: string;
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
          showToast(message, true);
          return;
        }
        const json = (await res.json()) as { path: string; transcript?: string; transcriptError?: string };
        if (json.transcript) {
          sendInput(json.transcript + " ");
          showToast("Transcribed " + file.name);
          return;
        }
        if (json.transcriptError) {
          showToast(json.transcriptError + " — attached as " + json.path, true);
          sendInput(json.path + " ");
          return;
        }
        path = json.path;
      } else {
        const result = await uploadLarge(file);
        if (!result.path) {
          showToast(result.error ?? "Upload failed", true);
          return;
        }
        path = result.path;
      }
      sendInput(path + " ");
      showToast("Attached " + path);
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

  window.addEventListener("dragenter", (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlay?.setAttribute("data-active", "true");
  });
  window.addEventListener("dragover", (e: DragEvent) => {
    if (!hasFiles(e)) return;
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
  let recorder: MediaRecorder | null = null;
  let recStream: MediaStream | null = null;
  let recChunks: Blob[] = [];

  function pickRecordingType(): { mime: string; ext: string } {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported) {
      if (MediaRecorder.isTypeSupported("audio/webm")) return { mime: "audio/webm", ext: "webm" };
      if (MediaRecorder.isTypeSupported("audio/mp4")) return { mime: "audio/mp4", ext: "m4a" };
    }
    return { mime: "", ext: "webm" };
  }

  // micBtn stays disabled from the moment a recording is requested until the getUserMedia
  // permission prompt resolves, and again from stop until the transcription upload settles —
  // otherwise a double-tap (or tapping again before the previous upload finishes) can open a
  // second concurrent recording/upload that races the first.
  async function startRecording(): Promise<void> {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
      showToast("Recording needs HTTPS and a supported browser", true);
      return;
    }
    if (micBtn) micBtn.disabled = true;
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      showToast("Microphone access denied", true);
      recStream = null;
      if (micBtn) micBtn.disabled = false;
      return;
    }
    if (sessionExited) {
      recStream.getTracks().forEach((t) => t.stop());
      recStream = null;
      if (micBtn) micBtn.disabled = false;
      return;
    }
    const { mime, ext } = pickRecordingType();
    recChunks = [];
    try {
      recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recChunks.push(e.data);
      };
      recorder.onstop = () => {
        recStream?.getTracks().forEach((t) => t.stop());
        recStream = null;
        const blob = new Blob(recChunks, { type: mime || "audio/webm" });
        recChunks = [];
        const reenable = () => {
          if (micBtn && !sessionExited) micBtn.disabled = false;
        };
        if (blob.size > 0) {
          void uploadFile(new File([blob], "voice-note-" + Date.now() + "." + ext, { type: blob.type })).finally(reenable);
        } else {
          showToast("Empty recording — nothing sent", true);
          reenable();
        }
      };
      recorder.start();
    } catch {
      showToast("Recording could not be started", true);
      recorder = null;
      recStream.getTracks().forEach((t) => t.stop());
      recStream = null;
      if (micBtn) micBtn.disabled = false;
      return;
    }
    if (micBtn) {
      micBtn.textContent = "Stop";
      micBtn.setAttribute("data-recording", "true");
      micBtn.disabled = false;
    }
    showToast("Recording… tap Stop when done", false, true);
  }

  function stopRecording(): void {
    if (recorder && recorder.state !== "inactive") {
      if (micBtn) micBtn.disabled = true;
      recorder.stop();
    }
    recorder = null;
    if (micBtn) {
      micBtn.textContent = "Record";
      micBtn.setAttribute("data-recording", "false");
    }
  }

  if (micBtn) {
    micBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
    });
    micBtn.addEventListener("click", () => {
      if (recorder) stopRecording();
      else void startRecording();
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

  // Copy xterm's own selection (the canvas selection layer is invisible to the
  // browser's native Cmd+C, which is why native copy grabbed only a word).
  const copyBtnLabel = copyBtn ? copyBtn.textContent : null;
  function flashCopied(ok: boolean): void {
    if (!copyBtn) return;
    copyBtn.textContent = ok ? "Copied ✓" : "Copy failed";
    setTimeout(() => { copyBtn.textContent = copyBtnLabel ?? "Copy"; }, 1200);
  }

  function copySelection(): boolean {
    if (!term.hasSelection()) return false;
    const text = term.getSelection();
    if (!text) return false;
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
        flashCopied(ok);
      } catch { flashCopied(false); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => flashCopied(true), fallback);
    } else {
      fallback();
    }
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
        if (micBtn) micBtn.disabled = true;
        stopRecording();
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
      // A stale session makes the /sessions/:id/ws upgrade 401 forever; ask
      // auth-watch to re-login rather than backing off silently (#2479).
      window.clawsAuthCheck?.();
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
