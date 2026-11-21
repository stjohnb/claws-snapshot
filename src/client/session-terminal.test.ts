// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SentFrame = { type: string; data?: string };

class MockTerminal {
  static last: MockTerminal | null = null;
  cols = 80;
  rows = 24;
  options: { theme: unknown; fontSize: number };
  buffer = { active: { length: 0, getLine: () => undefined } };
  parser = { registerOscHandler: () => ({ dispose() { /* noop */ } }) };
  dataHandler: ((data: string) => void) | null = null;
  written: string[] = [];

  constructor(opts: { theme: unknown; fontSize: number }) {
    this.options = opts;
    MockTerminal.last = this;
  }

  loadAddon(): void { /* noop */ }
  open(): void { /* noop */ }
  focus(): void { /* noop */ }
  reset(): void { /* noop */ }
  write(data: string): void { this.written.push(data); }
  onData(cb: (data: string) => void): void { this.dataHandler = cb; }
  getSelection(): string { return ""; }
  hasSelection(): boolean { return false; }
  attachCustomKeyEventHandler(): void { /* noop */ }
}

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState: number = MockWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((ev?: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  static isTypeSupported(type: string): boolean {
    return type === "audio/webm";
  }

  state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor() {
    MockMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voice"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

function installDom(): void {
  document.body.innerHTML = `
    <button id="paste-btn"></button>
    <button id="attach-btn"></button>
    <input id="attach-input" type="file">
    <button id="mic-btn"></button>
    <button id="copy-btn"></button>
    <div id="terminal" data-session-id="sess-1" data-session-alive="true"></div>
    <div id="drop-overlay"></div>
    <div class="session-bar"><div id="session-notices">
      <div id="startup-status" hidden><span id="startup-status-msg"></span><button id="startup-status-close" hidden></button></div>
      <div id="session-move-notice" hidden><span id="session-move-notice-msg"></span><button id="session-move-notice-close"></button></div>
      <div id="session-notice" hidden><span id="session-notice-msg"></span><button id="session-notice-close"></button></div>
    </div></div>
    <div id="copy-overlay"></div>
    <textarea id="copy-textarea"></textarea>
    <button id="copy-all-btn"></button>
    <button id="copy-close-btn"></button>
    <div id="mobile-keybar"><button type="button" class="kb-key kb-maximise" data-action="maximise" aria-pressed="false" aria-label="Maximise terminal" title="Maximise terminal"></button><button type="button" class="kb-key" data-action="font-dec">A-</button><button type="button" class="kb-key" data-action="font-inc">A+</button><button type="button" class="kb-key" data-key="signoff">/signoff</button><button type="button" class="kb-key" data-key="status">/status</button></div>
  `;
}

function installGlobals(fetchImpl: typeof fetch): void {
  Object.assign(globalThis, {
    Terminal: MockTerminal,
    FitAddon: { FitAddon: class { fit(): void { /* noop */ } } },
    WebLinksAddon: { WebLinksAddon: class {} },
    ResizeObserver: class { observe(): void { /* noop */ } },
    WebSocket: MockWebSocket,
    MediaRecorder: MockMediaRecorder,
    fetch: fetchImpl,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() { /* noop */ } }),
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockImplementation(() => Promise.resolve(mockStream())) },
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
}

type MockTrack = { readyState: string; onended: (() => void) | null; stop: () => void };

function mockStream(): MediaStream & { track: MockTrack } {
  const track: MockTrack = { readyState: "live", onended: null, stop: () => undefined };
  track.stop = vi.fn(() => { track.readyState = "ended"; });
  return { getTracks: () => [track], track } as unknown as MediaStream & { track: MockTrack };
}

function fetchJson(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  }) as unknown as typeof fetch;
}

async function loadTerminal(fetchImpl = fetchJson({ path: "/tmp/audio.webm", transcript: "hello world" })): Promise<void> {
  installDom();
  installGlobals(fetchImpl);
  vi.resetModules();
  await import("./session-terminal.js");
}

function inputFrames(): SentFrame[] {
  return MockWebSocket.instances[0].sent.map((raw) => JSON.parse(raw) as SentFrame).filter((frame) => frame.type === "input");
}

function noticeText(): string {
  return document.getElementById("session-notice-msg")?.textContent ?? "";
}

function mic(): HTMLButtonElement {
  return document.getElementById("mic-btn") as HTMLButtonElement;
}

function dispatchPointer(target: HTMLElement, type: string, pointerId = 1): void {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    button: { value: 0 },
    isPrimary: { value: true },
    pointerId: { value: pointerId },
  });
  target.dispatchEvent(event);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("session terminal voice notes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockTerminal.last = null;
    MockWebSocket.instances = [];
    MockMediaRecorder.instances = [];
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("tap start/tap stop sends one submitted transcript", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/audio.webm", transcript: "hello world" }));

    mic().click();
    await flush();
    mic().click();
    await flush();
    await vi.advanceTimersByTimeAsync(250);

    expect(inputFrames().map((frame) => frame.data)).toEqual(["\x15", "hello world", "\r"]);
  });

  it("hold release sends once and suppresses the follow-up click", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/audio.webm", transcript: "held note" }));

    dispatchPointer(mic(), "pointerdown");
    await vi.advanceTimersByTimeAsync(250);
    await flush();
    dispatchPointer(mic(), "pointerup");
    mic().click();
    await flush();
    await vi.advanceTimersByTimeAsync(250);

    expect(inputFrames().map((frame) => frame.data)).toEqual(["\x15", "held note", "\r"]);
  });

  it("pointercancel before microphone permission resolves sends nothing", async () => {
    let resolveStream: (stream: MediaStream) => void = () => undefined;
    const getUserMedia = vi.fn().mockReturnValue(new Promise<MediaStream>((resolve) => { resolveStream = resolve; }));
    await loadTerminal(fetchJson({ path: "/tmp/audio.webm", transcript: "late" }));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    dispatchPointer(mic(), "pointerdown");
    await vi.advanceTimersByTimeAsync(250);
    dispatchPointer(mic(), "pointercancel");
    resolveStream(mockStream());
    await flush();

    expect(inputFrames()).toEqual([]);
  });

  it("hold release before microphone permission resolves submits after permission arrives", async () => {
    let resolveStream: (stream: MediaStream) => void = () => undefined;
    const getUserMedia = vi.fn().mockReturnValue(new Promise<MediaStream>((resolve) => { resolveStream = resolve; }));
    await loadTerminal(fetchJson({ path: "/tmp/audio.webm", transcript: "late" }));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    dispatchPointer(mic(), "pointerdown");
    await vi.advanceTimersByTimeAsync(250);
    dispatchPointer(mic(), "pointerup");
    resolveStream(mockStream());
    await flush();
    await vi.advanceTimersByTimeAsync(250);

    expect(inputFrames().map((frame) => frame.data)).toEqual(["\x15", "late", "\r"]);
  });

  it("submits the saved audio path when transcription returns transcriptError", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/voice.webm", transcriptError: "Whisper unavailable" }));

    mic().click();
    await flush();
    mic().click();
    await flush();
    await vi.advanceTimersByTimeAsync(250);

    expect(inputFrames().map((frame) => frame.data)).toEqual(["\x15", "/tmp/voice.webm", "\r"]);
  });

  it("mentions draft replacement when transcript fallback submits a saved audio path", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/voice.webm", transcriptError: "Whisper unavailable" }));

    MockTerminal.last?.dataHandler?.("typed draft");
    mic().click();
    await flush();
    mic().click();
    await flush();
    await vi.advanceTimersByTimeAsync(250);

    expect(inputFrames().map((frame) => frame.data)).toEqual(["typed draft", "\x15", "/tmp/voice.webm", "\r"]);
    expect(noticeText()).toBe("Whisper unavailable — voice note sent as saved audio path; replaced the typed draft");
  });

  it("sends Enter only after the delay, as a separate frame from the transcript", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/audio.webm", transcript: "hello world" }));

    mic().click();
    await flush();
    mic().click();
    await flush();
    await vi.advanceTimersByTimeAsync(100);

    expect(inputFrames().map((frame) => frame.data)).toEqual(["\x15", "hello world"]);

    await vi.advanceTimersByTimeAsync(150);

    expect(inputFrames().map((frame) => frame.data)).toEqual(["\x15", "hello world", "\r"]);
  });

  it("skips the delayed Enter when the socket closes in the gap", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/audio.webm", transcript: "hello world" }));

    mic().click();
    await flush();
    mic().click();
    await flush();

    MockWebSocket.instances[0].readyState = MockWebSocket.CLOSED;
    await vi.advanceTimersByTimeAsync(250);

    expect(inputFrames().map((frame) => frame.data)).toEqual(["\x15"]);
  });

  it("staggers a flushed submission's leftover frames instead of writing them back-to-back", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/audio.webm", transcript: "hello world" }));

    // First voice note: only its immediate Ctrl-U frame goes out synchronously;
    // "hello world" and "\r" are still pending on delayed timers.
    mic().click();
    await flush();
    mic().click();
    await flush();

    // Second voice note interrupts before those delayed frames fire.
    mic().click();
    await flush();
    mic().click();
    await flush();

    // Nothing beyond the first note's synchronous Ctrl-U has been written yet;
    // the flushed leftovers and the new submission are all on delayed timers.
    expect(inputFrames().map((frame) => frame.data)).toEqual(["\x15"]);

    await vi.advanceTimersByTimeAsync(1000);

    expect(inputFrames().map((frame) => frame.data)).toEqual([
      "\x15", "hello world", "\r", // first note, flushed with a gap between frames
      "\x15", "hello world", "\r", // second note, starting only after the first drained
    ]);
  });

  it("keeps a flushed submission's leftovers cancelable so a third overlapping note never interleaves", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/audio.webm", transcript: "hello world" }));

    const sendNote = async (): Promise<void> => {
      mic().click();
      await flush();
      mic().click();
      await flush();
    };

    await sendNote();
    await sendNote();
    // Part-way through the first note's rescheduled leftovers, a third note arrives.
    await vi.advanceTimersByTimeAsync(100);
    await sendNote();
    await vi.advanceTimersByTimeAsync(2000);

    expect(inputFrames().map((frame) => frame.data)).toEqual([
      "\x15", "hello world", "\r",
      "\x15", "hello world", "\r",
      "\x15", "hello world", "\r",
    ]);
  });

  it("ordinary file upload inserts text without submitting", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/upload.txt" }));
    const input = document.getElementById("attach-input") as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["body"], "upload.txt", { type: "text/plain" })],
    });

    input.dispatchEvent(new Event("change"));
    await flush();

    expect(inputFrames().map((frame) => frame.data)).toEqual(["/tmp/upload.txt "]);
    expect(noticeText()).toBe("");
    expect(document.getElementById("session-notice")?.hidden).toBe(true);
  });

  it("shows no notice for a successful voice note", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/audio.webm", transcript: "hello world" }));
    await sendTapNote();

    expect(inputFrames().map((frame) => frame.data)).toEqual(["\x15", "hello world", "\r"]);
    expect(noticeText()).toBe("");
    expect(document.getElementById("session-notice")?.hidden).toBe(true);
  });

  it("keeps a denied-microphone notice visible until dismissed", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/audio.webm", transcript: "x" }));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    mic().click();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);

    const notice = document.getElementById("session-notice") as HTMLElement;
    expect(noticeText()).toBe("Microphone access denied");
    expect(notice.getAttribute("data-error")).toBe("true");
    expect(notice.hidden).toBe(false);

    document.getElementById("session-notice-close")?.click();
    expect(notice.hidden).toBe(true);
  });

  async function sendTapNote(): Promise<void> {
    mic().click();
    await flush();
    mic().click();
    await flush();
    await vi.advanceTimersByTimeAsync(250);
  }

  it("reuses the microphone stream across consecutive notes instead of re-prompting", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/audio.webm", transcript: "one" }));
    const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;

    await sendTapNote();
    await sendTapNote();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(MockMediaRecorder.instances.length).toBe(2);
    const stream = await getUserMedia.mock.results[0].value as MediaStream & { track: MockTrack };
    expect(stream.track.stop).not.toHaveBeenCalled();
  });

  it("releases the microphone when the page is hidden and re-acquires once visible again", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/audio.webm", transcript: "one" }));
    const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;

    await sendTapNote();
    const stream = await getUserMedia.mock.results[0].value as MediaStream & { track: MockTrack };

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stream.track.stop).toHaveBeenCalled();

    setVisibility("visible");
    await sendTapNote();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("releases the microphone after an idle period and re-acquires on the next note", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/audio.webm", transcript: "one" }));
    const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;

    await sendTapNote();
    const stream = await getUserMedia.mock.results[0].value as MediaStream & { track: MockTrack };

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(stream.track.stop).toHaveBeenCalled();

    await sendTapNote();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("re-acquires after the browser ends the cached track externally", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/audio.webm", transcript: "one" }));
    const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;

    await sendTapNote();
    const stream = await getUserMedia.mock.results[0].value as MediaStream & { track: MockTrack };
    stream.track.readyState = "ended";
    stream.track.onended?.();

    await sendTapNote();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("stops the cached track when the session exits", async () => {
    await loadTerminal(fetchJson({ path: "/tmp/audio.webm", transcript: "one" }));
    const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;

    await sendTapNote();
    const stream = await getUserMedia.mock.results[0].value as MediaStream & { track: MockTrack };

    MockWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: "exit", code: 0 }) } as MessageEvent);

    expect(stream.track.stop).toHaveBeenCalled();
  });
});

type StartupBody = { state: string; step: string; detail: string | null; elapsedMs: number; failureReason?: string | null; move?: unknown };

/** A fetch that answers `/startup` from `startup` (a queue; the last entry repeats) and everything else with {}. */
function startupFetch(startup: Array<StartupBody | Error | Promise<never> | { status: number }>): typeof fetch {
  let i = 0;
  return vi.fn((url: string) => {
    if (!url.endsWith("/startup")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    const next = startup[Math.min(i++, startup.length - 1)];
    if (next instanceof Error) return Promise.reject(next);
    if (next instanceof Promise) return next;
    if ("status" in next) return Promise.resolve({ ok: false, status: next.status, json: () => Promise.resolve({ error: "Not found" }) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(next) });
  }) as unknown as typeof fetch;
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

function startupEl(): HTMLElement {
  return document.getElementById("startup-status") as HTMLElement;
}

function startupCalls(): number {
  return (globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock.calls.filter((c) => c[0].endsWith("/startup")).length;
}

const PENDING: StartupBody = { state: "pending", step: "Waiting for pod to start", detail: null, elapsedMs: 0 };
const READY: StartupBody = { state: "ready", step: "Terminal ready", detail: null, elapsedMs: 4000 };
const FAILED: StartupBody = { state: "failed", step: "Session pod failed", detail: "OOMKilled", elapsedMs: 9000, failureReason: "OOMKilled" };
/** What `/api/sessions/:id/startup` answers for an id it does not recognise. */
const NOT_FOUND = { status: 404 };

function dropFile(): void {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files: [new File(["body"], "dropped.txt", { type: "text/plain" })] },
  });
  window.dispatchEvent(event);
}

/** Every control that would send input to a session that can no longer take it. */
function inputControlsDisabled(): Record<string, boolean> {
  const disabled = (id: string) => (document.getElementById(id) as HTMLButtonElement | HTMLInputElement).disabled;
  return { paste: disabled("paste-btn"), mic: disabled("mic-btn"), attachBtn: disabled("attach-btn"), attachInput: disabled("attach-input") };
}

describe("session move notice (#clw_01M7Q3P5PR480HYED9TNH6VTV9)", () => {
  const moveNotice = () => document.getElementById("session-move-notice") as HTMLElement;
  const moved = (over: Record<string, unknown> = {}) => ({
    ...READY, move: { id: "mv1", state: "done", finishedAt: Date.now() - 60_000, message: "Moved from k3s-nas to k3s: NAS shutdown", failed: false, ...over },
  });

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    setVisibility("visible");
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("shows a finished move until dismissed, and stays dismissed on the next load", async () => {
    await loadTerminal(startupFetch([moved()]));
    await flush();
    expect(moveNotice().hidden).toBe(false);
    expect(document.getElementById("session-move-notice-msg")?.textContent).toBe("Moved from k3s-nas to k3s: NAS shutdown");
    expect(moveNotice().getAttribute("data-error")).toBe("false");
    document.getElementById("session-move-notice-close")?.click();
    expect(moveNotice().hidden).toBe(true);

    await loadTerminal(startupFetch([moved()]));
    await flush();
    expect(moveNotice().hidden).toBe(true);
  });

  it("an open page polls again when a move restarts the pod (1012) and shows the finished move", async () => {
    await loadTerminal(startupFetch([READY, moved()]));
    await flush();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(moveNotice().hidden).toBe(true);
    MockWebSocket.instances[0].readyState = MockWebSocket.CLOSED;
    MockWebSocket.instances[0].onclose?.({ code: 1012 });
    await flush();
    expect(moveNotice().hidden).toBe(false);
    expect(document.getElementById("session-move-notice-msg")?.textContent).toBe("Moved from k3s-nas to k3s: NAS shutdown");
  });

  it("marks a failed move as an error, and stays hidden for a move still under way or long past", async () => {
    await loadTerminal(startupFetch([moved({ state: "failed", failed: true, message: "Could not move from k3s-nas to k3s: copy failed" })]));
    await flush();
    expect(moveNotice().hidden).toBe(false);
    expect(moveNotice().getAttribute("data-error")).toBe("true");

    await loadTerminal(startupFetch([moved({ state: "copying", finishedAt: null })]));
    await flush();
    expect(moveNotice().hidden).toBe(true);

    await loadTerminal(startupFetch([moved({ finishedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 })]));
    await flush();
    expect(moveNotice().hidden).toBe(true);
  });
});

describe("session terminal startup status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockTerminal.last = null;
    MockWebSocket.instances = [];
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("a startup poll that finds the session ready cancels the socket's pending backoff instead of racing it", async () => {
    await loadTerminal(startupFetch([PENDING, READY]));
    await flush();
    expect(MockWebSocket.instances).toHaveLength(1);

    // The first attach attempt fails while the pod is still starting, so the socket backs off.
    MockWebSocket.instances[0].readyState = MockWebSocket.CLOSED;
    MockWebSocket.instances[0].onclose?.();

    // The poll sees "ready" first and connects; the backoff must not then open a second socket.
    await vi.advanceTimersByTimeAsync(1000);
    MockWebSocket.instances[1].onopen?.();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].readyState).toBe(MockWebSocket.OPEN);
  });

  it("a startup that fails while a reconnect is pending never opens a second socket", async () => {
    await loadTerminal(startupFetch([PENDING, FAILED]));
    await flush();
    expect(MockWebSocket.instances).toHaveLength(1);

    // The pod was not Ready yet, so the first attach fails and the socket schedules its backoff.
    MockWebSocket.instances[0].readyState = MockWebSocket.CLOSED;
    MockWebSocket.instances[0].onclose?.();

    // The poll then reports the startup failed. The backoff scheduled before that must not fire
    // a new socket at a session the page has already disabled every input control for.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(inputControlsDisabled()).toEqual({ paste: true, mic: true, attachBtn: true, attachInput: true });
  });

  it("a 404 stops polling and says the session is gone instead of retrying forever", async () => {
    await loadTerminal(startupFetch([NOT_FOUND]));
    await flush();

    expect(startupEl().textContent).toBe("Session not found");
    expect(startupEl().hidden).toBe(false);
    expect(inputControlsDisabled()).toEqual({ paste: true, mic: true, attachBtn: true, attachInput: true });

    const calls = startupCalls();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(startupCalls()).toBe(calls);
  });

  it("an exit reported by the socket stops startup polling instead of waiting for reconcile", async () => {
    // The pod never reaches "ready"/"failed" from the poll's point of view, so without a
    // sessionExited check the poll would keep hitting the endpoint until reconcile ends the row.
    await loadTerminal(startupFetch([PENDING]));
    await flush();
    const calls = startupCalls();

    MockWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: "exit", code: 1 }) } as MessageEvent);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(startupCalls()).toBe(calls);
  });

  it("reconnecting while a socket is already open is a no-op", async () => {
    await loadTerminal(startupFetch([READY]));
    await flush();
    MockWebSocket.instances[0].onopen?.();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("a polling blip leaves an attached terminal's banner hidden", async () => {
    // The poll is still in flight when the socket attaches, so its failure lands on a working terminal.
    let fail: (err: Error) => void = () => undefined;
    const inFlight = new Promise<never>((_, reject) => { fail = reject; });
    await loadTerminal(startupFetch([inFlight]));
    MockWebSocket.instances[0].onopen?.();
    fail(new Error("network"));
    await flush();

    expect(startupEl().hidden).toBe(true);
    expect(startupEl().textContent).not.toBe("Checking startup status…");
  });

  it("a polling blip before the terminal attaches says so", async () => {
    await loadTerminal(startupFetch([new Error("network")]));
    await flush();

    expect(startupEl().hidden).toBe(false);
    expect(startupEl().textContent).toBe("Checking startup status…");
  });

  it("a backgrounded tab spends no startup requests but resumes polling when it comes back", async () => {
    setVisibility("hidden");
    await loadTerminal(startupFetch([PENDING]));
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(startupCalls()).toBe(0);

    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(1000);
    expect(startupCalls()).toBe(1);
  });

  it("renders the step and elapsed time while the pod starts", async () => {
    await loadTerminal(startupFetch([{ state: "pending", step: "Pulling session image", detail: "ImagePullBackOff", elapsedMs: 65_000 }]));
    await flush();

    expect(startupEl().hidden).toBe(false);
    expect(startupEl().textContent).toBe("Pulling session image: ImagePullBackOff · 1m 5s");
    expect(startupEl().getAttribute("data-state")).toBe("pending");
  });

  it("a failed startup disables attach and drag-drop along with the rest of the input controls", async () => {
    await loadTerminal(startupFetch([FAILED]));
    await flush();

    expect(inputControlsDisabled()).toEqual({ paste: true, mic: true, attachBtn: true, attachInput: true });

    // A drop must not attach anything to a terminal that will never take input.
    dropFile();
    await flush();
    expect(inputFrames()).toEqual([]);
    expect(noticeText()).toBe("");
    expect(document.getElementById("drop-overlay")?.getAttribute("data-active")).not.toBe("true");
  });

  it("an exit 0 frame keeps the page on the last output, disables input and shows the banner (#3311)", async () => {
    await loadTerminal(startupFetch([READY]));
    await flush();
    MockWebSocket.instances[0].onopen?.();
    MockWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: "output", data: "bye" }) } as MessageEvent);
    MockWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: "exit", code: 0 }) } as MessageEvent);
    await flush();

    const written = MockTerminal.last!.written.join("");
    expect(written).toContain("[Session exited cleanly (code 0)]");
    expect(written).not.toContain("returning to sessions list");
    expect(inputControlsDisabled()).toEqual({ paste: true, mic: true, attachBtn: true, attachInput: true });
    expect(startupEl().hidden).toBe(false);
    expect(startupEl().getAttribute("data-state")).toBe("ended");
    expect(startupEl().textContent).toBe("Session ended (exit 0) · View saved output (may take a few seconds to appear)");
    expect(startupEl().querySelector("a")?.getAttribute("href")).toBe("/sessions/sess-1");
  });

  it("the ended banner has a dismiss button that hides it without re-enabling input", async () => {
    await loadTerminal(startupFetch([READY]));
    await flush();
    MockWebSocket.instances[0].onopen?.();
    MockWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: "exit", code: 0 }) } as MessageEvent);
    await flush();
    const close = document.getElementById("startup-status-close") as HTMLElement;
    expect(close.hidden).toBe(false);
    close.click();
    expect(startupEl().hidden).toBe(true);
    expect(inputControlsDisabled()).toEqual({ paste: true, mic: true, attachBtn: true, attachInput: true });
  });

  it("a preparing banner has no dismiss button", async () => {
    await loadTerminal(startupFetch([{ state: "preparing", step: "Preparing", detail: null, elapsedMs: 0 }]));
    await flush();
    expect(startupEl().hidden).toBe(false);
    expect((document.getElementById("startup-status-close") as HTMLElement).hidden).toBe(true);
  });

  it("every notice surface lives inside the floating #session-notices layer", async () => {
    await loadTerminal(startupFetch([PENDING]));
    await flush();
    const layer = document.getElementById("session-notices")!;
    expect(layer.parentElement?.classList.contains("session-bar")).toBe(true);
    for (const id of ["startup-status", "session-notice"]) {
      expect(layer.contains(document.getElementById(id))).toBe(true);
    }
  });

  it("a non-zero exit frame says so in red and in the banner (#3311)", async () => {
    await loadTerminal(startupFetch([READY]));
    await flush();
    MockWebSocket.instances[0].onopen?.();
    MockWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: "exit", code: 2 }) } as MessageEvent);
    await flush();

    expect(MockTerminal.last!.written.join("")).toContain("\x1b[31m[Session exited with code 2]");
    expect(startupEl().textContent).toContain("Session ended (exit 2)");
  });

  it("an ended or failed startup links to the saved last output (#3311)", async () => {
    await loadTerminal(startupFetch([{ state: "ended", step: "Session exited (code 1)", detail: null, elapsedMs: 1000 }]));
    await flush();

    const link = startupEl().querySelector("a");
    expect(link?.getAttribute("href")).toBe("/sessions/sess-1");
    expect(link?.textContent).toBe("View last output");
    expect(startupEl().textContent).toBe("Session ended · 1s · View last output");
  });

  it("an exited session disables attach and drag-drop along with the rest of the input controls", async () => {
    await loadTerminal(startupFetch([READY]));
    await flush();
    MockWebSocket.instances[0].onopen?.();
    MockWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: "exit", code: 1 }) } as MessageEvent);
    await flush();

    expect(inputControlsDisabled()).toEqual({ paste: true, mic: true, attachBtn: true, attachInput: true });

    dropFile();
    await flush();
    expect(noticeText()).toBe("");
  });
});

describe("grant-capability option states (#3138, #3322)", () => {
  async function loadTerminalWithGrantSelect(fetchImpl: typeof fetch): Promise<void> {
    installDom();
    document.body.insertAdjacentHTML("beforeend", `
      <span id="grant-cap">
        <select id="grant-cap-select" aria-label="Capability to grant">
          <optgroup label="Infrastructure">
            <option value="home-assistant">Home Assistant</option>
          </optgroup>
          <optgroup label="SSH hosts">
            <option value="ssh:ryzen">SSH: ryzen</option>
            <option value="ssh:nas">SSH: nas</option>
          </optgroup>
        </select>
        <button id="grant-cap-btn" type="button"></button>
        <button id="revoke-cap-btn" type="button" disabled></button>
      </span>
      <span id="grant-cap-status" hidden><span id="grant-cap-status-msg"></span><button id="grant-cap-status-close"></button></span>
    `);
    installGlobals(fetchImpl);
    vi.resetModules();
    await import("./session-terminal.js");
  }

  beforeEach(() => {
    MockTerminal.last = null;
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  function grantSelect(): HTMLSelectElement {
    return document.getElementById("grant-cap-select") as HTMLSelectElement;
  }

  function grantBtn(): HTMLButtonElement {
    return document.getElementById("grant-cap-btn") as HTMLButtonElement;
  }

  function revokeBtn(): HTMLButtonElement {
    return document.getElementById("revoke-cap-btn") as HTMLButtonElement;
  }

  it("disables a granted non-revocable option with \" (granted)\" and selects the next grantable one (#3322)", async () => {
    await loadTerminalWithGrantSelect(fetchJson({}));

    grantSelect().value = "home-assistant";
    grantBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    const ha = grantSelect().querySelector<HTMLOptionElement>('option[value="home-assistant"]')!;
    expect(ha.disabled).toBe(true);
    expect(ha.textContent).toBe("Home Assistant (granted)");
    expect(document.querySelector('optgroup[label="Infrastructure"]')).not.toBeNull();
    expect(grantSelect().value).toBe("ssh:ryzen");
    expect(grantBtn().disabled).toBe(false);
    expect(revokeBtn().disabled).toBe(true);
    expect(document.getElementById("grant-cap-status")!.textContent).toBe("Home Assistant: Granted");
    expect(document.getElementById("grant-cap-status")!.title).toBe("Home Assistant: Granted");
  });

  it("the grant result row can be dismissed and is dismissible", async () => {
    await loadTerminalWithGrantSelect(fetchJson({}));
    grantSelect().value = "home-assistant";
    grantBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    const status = document.getElementById("grant-cap-status")!;
    expect(status.hidden).toBe(false);
    document.getElementById("grant-cap-status-close")!.click();
    expect(status.hidden).toBe(true);
  });

  it("keeps a granted ssh:* option selectable as held, so it can be revoked", async () => {
    await loadTerminalWithGrantSelect(fetchJson({ live: true, loadPath: null, marker: null, delayed: true }));

    grantSelect().value = "ssh:nas";
    grantSelect().dispatchEvent(new Event("change"));
    expect(revokeBtn().disabled).toBe(true);
    grantBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    const nas = grantSelect().querySelector<HTMLOptionElement>('option[value="ssh:nas"]')!;
    expect(nas.disabled).toBe(false);
    expect(nas.dataset.held).toBe("true");
    expect(nas.textContent).toBe("SSH: nas (granted)");
    expect(document.getElementById("grant-cap-status")!.textContent).toBe("SSH: nas: Granted. Still landing in the session — can take up to 2 minutes to appear");

    grantSelect().value = "ssh:nas";
    grantSelect().dispatchEvent(new Event("change"));
    expect(grantBtn().disabled).toBe(true);
    expect(revokeBtn().disabled).toBe(false);
  });

  it.each([
    [{ agentPickedUp: true, agentNotified: false, notifyFailure: null }, "Home Assistant: Granted — the agent picked it up"],
    [{ agentPickedUp: false, agentNotified: true, notifyFailure: null }, "Home Assistant: Granted — Claws told the agent in its terminal"],
    [{ agentPickedUp: false, agentNotified: false, notifyFailure: "unreachable" },
      "Home Assistant: Granted — could not reach the agent's terminal; tell it to call claws_request_capability again"],
  ])("reports how Claws told the agent of a landed grant, never typing into the terminal itself", async (notice, status) => {
    await loadTerminalWithGrantSelect(fetchJson({ live: true, landed: true, loadPath: null, marker: null, delayed: false, ...notice }));

    grantSelect().value = "home-assistant";
    grantBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(document.getElementById("grant-cap-status")!.textContent).toBe(status);
    expect(inputFrames()).toEqual([]);
  });

  it("revokes a held ssh:* option with DELETE and makes it grantable again", async () => {
    const fetchImpl = fetchJson({ live: true, keysRemoved: true });
    await loadTerminalWithGrantSelect(fetchImpl);
    const nas = grantSelect().querySelector<HTMLOptionElement>('option[value="ssh:nas"]')!;
    nas.dataset.held = "true";
    nas.textContent = "SSH: nas (granted)";
    grantSelect().value = "ssh:nas";
    grantSelect().dispatchEvent(new Event("change"));

    revokeBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/\/capabilities\/ssh%3Anas$/), { method: "DELETE" });
    expect(nas.dataset.held).toBeUndefined();
    expect(nas.textContent).toBe("SSH: nas");
    expect(grantBtn().disabled).toBe(false);
    expect(revokeBtn().disabled).toBe(true);
    expect(document.getElementById("grant-cap-status")!.textContent).toBe("SSH: nas: Revoked — the session loses the key within about two minutes");
  });

  it("tells the operator a revoke on an older pod waits for a resume, and shows a failed revoke", async () => {
    const fetchImpl = fetchJson({ live: false, keysRemoved: true });
    await loadTerminalWithGrantSelect(fetchImpl);
    const nas = grantSelect().querySelector<HTMLOptionElement>('option[value="ssh:nas"]')!;
    nas.dataset.held = "true";
    nas.textContent = "SSH: nas (granted)";
    grantSelect().value = "ssh:nas";
    grantSelect().dispatchEvent(new Event("change"));
    revokeBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(document.getElementById("grant-cap-status")!.textContent)
      .toBe("SSH: nas: Revoked — takes effect once the session is ended and resumed from the sessions list");

    vi.mocked(fetchImpl).mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: "Session runtime unavailable" }) } as Response);
    nas.dataset.held = "true";
    grantSelect().dispatchEvent(new Event("change"));
    revokeBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(document.getElementById("grant-cap-status")!.textContent).toBe("Session runtime unavailable");
    expect(nas.dataset.held).toBe("true");
  });

  it.each([
    [{ live: true, keysRemoved: false }, "SSH: nas: Revoked — other granted SSH hosts share the same key, so the host stays reachable until the last SSH host is revoked"],
    [{ live: false, keysRemoved: false }, "SSH: nas: Revoked — other granted SSH hosts share the same key, so the host stays reachable until the last SSH host is revoked"],
  ])("does not claim the key is gone when it stays (%o)", async (body, message) => {
    await loadTerminalWithGrantSelect(fetchJson(body));
    const nas = grantSelect().querySelector<HTMLOptionElement>('option[value="ssh:nas"]')!;
    nas.dataset.held = "true";
    nas.textContent = "SSH: nas (granted)";
    grantSelect().value = "ssh:nas";
    grantSelect().dispatchEvent(new Event("change"));
    revokeBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(document.getElementById("grant-cap-status")!.textContent).toBe(message);
  });

  it.each([
    [{ live: true, keysRemoved: false, restarted: false }, "Fleet observability: Revoked"],
    [{ live: false, keysRemoved: false, restarted: false }, "Fleet observability: Revoked — takes effect once the session is ended and resumed from the sessions list"],
    [{ live: true, keysRemoved: false, restarted: true }, "Fleet observability: Revoked — the agent is restarting with its conversation kept; the terminal reconnects by itself"],
  ])("revokes an automatically granted capability with a plain message (%o) (#clw_01M77K5B15JHY1N6JMGRZDFQ0D)", async (body, message) => {
    await loadTerminalWithGrantSelect(fetchJson(body));
    const opt = document.createElement("option");
    opt.value = "fleet-observability";
    opt.dataset.held = "true";
    opt.textContent = "Fleet observability (granted automatically)";
    grantSelect().append(opt);
    grantSelect().value = "fleet-observability";
    grantSelect().dispatchEvent(new Event("change"));
    expect(revokeBtn().disabled).toBe(false);
    revokeBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(document.getElementById("grant-cap-status")!.textContent).toBe(message);
    expect(opt.textContent).toBe("Fleet observability");
    expect(opt.dataset.held).toBeUndefined();
  });

  describe("automatic grants from the capability-request poll (#clw_01M77K5B15JHY1N6JMGRZDFQ0D)", () => {
    function pollingFetch(autoGranted: () => unknown[]): ReturnType<typeof vi.fn> {
      return vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => (String(url).endsWith("/capability-requests") ? { requests: [], autoGranted: autoGranted() } : {}),
      }));
    }

    async function loadWithRevocableOptions(fetchImpl: ReturnType<typeof vi.fn>): Promise<void> {
      installDom();
      document.body.insertAdjacentHTML("beforeend", `
        <div id="cap-requests" hidden></div>
        <span id="grant-cap">
          <select id="grant-cap-select" aria-label="Capability to grant">
            <option value="home-assistant">Home Assistant</option>
            <option value="fleet-observability" data-revocable="true">Fleet observability</option>
            <option value="browser" data-revocable="true">Browser (Playwright)</option>
          </select>
          <button id="grant-cap-btn" type="button"></button>
          <button id="revoke-cap-btn" type="button" disabled></button>
        </span>
        <span id="grant-cap-status" hidden><span id="grant-cap-status-msg"></span><button id="grant-cap-status-close"></button></span>
      `);
      installGlobals(fetchImpl as unknown as typeof fetch);
      vi.resetModules();
      await import("./session-terminal.js");
      await flush();
    }

    const option = (value: string) => grantSelect().querySelector<HTMLOptionElement>(`option[value="${value}"]`)!;

    it("marks a grant the rendered page missed as held on the first poll, without a message", async () => {
      await loadWithRevocableOptions(pollingFetch(() => [{ capability: "fleet-observability", label: "Fleet observability", reason: "why", decidedAt: 1, restarted: false }]));
      expect(option("fleet-observability").dataset.held).toBe("true");
      expect(option("fleet-observability").textContent).toBe("Fleet observability (granted automatically)");
      expect(document.getElementById("grant-cap-status")!.hidden).toBe(true);
    });

    it("shows a later grant once and follows the agent's relaunch when it restarted", async () => {
      let list: unknown[] = [];
      const fetchImpl = pollingFetch(() => list);
      await loadWithRevocableOptions(fetchImpl);
      list = [{ capability: "browser", label: "Browser (Playwright)", reason: "eBay", decidedAt: 2, restarted: true }];
      fetchImpl.mockClear();
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
      expect(option("browser").dataset.held).toBe("true");
      expect(document.getElementById("grant-cap-status-msg")!.textContent).toBe("Browser (Playwright) granted automatically — eBay");
      expect(fetchImpl.mock.calls.map(([url]) => String(url))).toContain("/api/sessions/sess-1/startup");
    });
  });

  it("keeps a granted data-revocable option selectable as held so it can be revoked", async () => {
    await loadTerminalWithGrantSelect(fetchJson({ live: true, landed: true, loadPath: null, marker: null, delayed: false, agentNotified: true }));
    const opt = document.createElement("option");
    opt.value = "fleet-observability";
    opt.dataset.revocable = "true";
    opt.textContent = "Fleet observability";
    grantSelect().append(opt);
    grantSelect().value = "fleet-observability";
    grantSelect().dispatchEvent(new Event("change"));
    grantBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(opt.disabled).toBe(false);
    expect(opt.dataset.held).toBe("true");
    expect(opt.textContent).toBe("Fleet observability (granted)");
  });

  it("keeps Grant and Revoke disabled while a request is in flight, even when the selection changes", async () => {
    let resolve!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => { resolve = r; })) as unknown as typeof fetch;
    await loadTerminalWithGrantSelect(fetchImpl);
    const nas = grantSelect().querySelector<HTMLOptionElement>('option[value="ssh:nas"]')!;
    nas.dataset.held = "true";
    grantSelect().value = "ssh:ryzen";
    grantSelect().dispatchEvent(new Event("change"));
    grantBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    grantSelect().value = "home-assistant";
    grantSelect().dispatchEvent(new Event("change"));
    expect(grantBtn().disabled).toBe(true);
    grantSelect().value = "ssh:nas";
    grantSelect().dispatchEvent(new Event("change"));
    expect(revokeBtn().disabled).toBe(true);

    resolve({ ok: true, status: 200, json: async () => ({ live: true }) } as Response);
    await flush();
    grantSelect().value = "ssh:nas";
    grantSelect().dispatchEvent(new Event("change"));
    expect(revokeBtn().disabled).toBe(false);
  });

  it("keeps the control visible with the button disabled once every option is granted", async () => {
    await loadTerminalWithGrantSelect(fetchJson({}));

    for (const id of ["home-assistant", "ssh:ryzen", "ssh:nas"]) {
      grantSelect().value = id;
      grantBtn().dispatchEvent(new Event("click", { bubbles: true }));
      await flush();
    }
    expect(grantSelect().options.length).toBe(3);
    expect(Array.from(grantSelect().options).every((o) => o.textContent!.endsWith(" (granted)"))).toBe(true);
    expect(Array.from(grantSelect().options).every((o) => o.disabled || o.dataset.held === "true")).toBe(true);
    expect((document.getElementById("grant-cap") as HTMLElement).style.display).not.toBe("none");
    expect(grantBtn().disabled).toBe(true);
  });

  it("marks an option \" (unavailable)\" with the error as its title on a 400", async () => {
    await loadTerminalWithGrantSelect(fetchJson({ error: "ssh:nas cannot be granted to this session" }, false, 400));

    grantSelect().value = "ssh:nas";
    grantBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    const nas = grantSelect().querySelector<HTMLOptionElement>('option[value="ssh:nas"]')!;
    expect(nas.disabled).toBe(true);
    expect(nas.textContent).toBe("SSH: nas (unavailable)");
    expect(nas.title).toBe("ssh:nas cannot be granted to this session");
    expect(grantBtn().disabled).toBe(false);
  });

  it("says a browser grant restarts the agent with its conversation kept, and polls startup to reattach (#clw_01M4RASNVDKH2YBHZMGR0SM0RA)", async () => {
    const fetchImpl = fetchJson({ live: true, landed: false, loadPath: null, marker: null, delayed: true, restarted: true, agentNoticeQueued: true });
    await loadTerminalWithGrantSelect(fetchImpl);
    vi.mocked(fetchImpl).mockClear();

    grantSelect().value = "home-assistant";
    grantBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(document.getElementById("grant-cap-status")!.textContent)
      .toBe("Home Assistant: Granted — the agent is restarting with its conversation kept; the terminal reconnects by itself and Claws tells the agent once it is back");
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/\/startup$/));
    expect(inputFrames()).toEqual([]);
  });

  it("tells the operator to resume the session when a grant to an older pod is not live", async () => {
    await loadTerminalWithGrantSelect(fetchJson({ live: false, loadPath: null, marker: null, delayed: false }));

    grantSelect().value = "ssh:nas";
    grantBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(document.getElementById("grant-cap-status")!.textContent)
      .toBe("SSH: nas: Granted — takes effect once the session is ended and resumed from the sessions list");
  });
});

describe("session terminal published files", () => {
  const FILES = [
    { id: "csf_1", name: "chart.png", size: 2048, url: "/sessions/sess-1/files/csf_1/chart.png", downloadUrl: "/sessions/sess-1/files/csf_1/chart.png?download=1", isImage: true },
    { id: "csf_2", name: "<img src=x onerror=alert(1)>.sh", size: 10, url: "/sessions/sess-1/files/csf_2/x.sh", downloadUrl: "/sessions/sess-1/files/csf_2/x.sh?download=1", isImage: false },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    MockTerminal.last = null;
    MockWebSocket.instances = [];
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  async function loadWithFiles(files: unknown[], stored: Record<string, string> = {}): Promise<ReturnType<typeof vi.fn>> {
    installDom();
    window.localStorage.clear();
    for (const [k, v] of Object.entries(stored)) window.localStorage.setItem(k, v);
    document.body.insertAdjacentHTML("beforeend", `<div id="session-files" class="session-files" hidden><button type="button" id="session-files-toggle" class="session-files-toggle" aria-expanded="true" aria-controls="session-files">Files (0) ▾</button></div>`);
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url === "/sessions/sess-1/files" ? { files } : {}),
    }));
    installGlobals(fetchImpl as unknown as typeof fetch);
    vi.resetModules();
    await import("./session-terminal.js");
    return fetchImpl;
  }

  it("polls the files list and renders each file with a Download link, names as text only", async () => {
    const fetchImpl = await loadWithFiles(FILES);
    await vi.advanceTimersByTimeAsync(5000);
    await flush();

    expect(fetchImpl).toHaveBeenCalledWith("/sessions/sess-1/files");
    const row = document.getElementById("session-files")!;
    expect(row.hidden).toBe(false);
    const chips = row.querySelectorAll<HTMLElement>(".session-file");
    expect(chips).toHaveLength(2);
    expect(chips[0]!.querySelector("img.session-file-thumb")!.getAttribute("src")).toBe(FILES[0]!.url);
    expect(chips[0]!.querySelector(".session-file-size")!.textContent).toBe("2.0 KB");
    const download = chips[0]!.querySelector<HTMLAnchorElement>(".session-file-download")!;
    expect(download.getAttribute("href")).toBe(FILES[0]!.downloadUrl);
    expect(download.getAttribute("download")).toBe("chart.png");
    expect(chips[1]!.querySelector("img")).toBeNull();
    expect(chips[1]!.querySelector(".session-file-name")!.textContent).toBe(FILES[1]!.name);
    expect(row.querySelectorAll("img")).toHaveLength(1);
  });

  it("deletes a file after a confirm, drops its chip, and does nothing when the confirm is declined", async () => {
    const files = [...FILES];
    const fetchImpl = await loadWithFiles(files);
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    const row = document.getElementById("session-files")!;
    const del = () => row.querySelector<HTMLButtonElement>('.session-file-delete[data-file-id="csf_1"]');
    expect(del()!.getAttribute("aria-label")).toBe("Delete chart.png");

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    del()!.click();
    expect(confirmSpy).toHaveBeenCalledWith("Delete chart.png? This cannot be undone.");
    expect(fetchImpl).not.toHaveBeenCalledWith("/sessions/sess-1/files/csf_1", expect.anything());

    confirmSpy.mockReturnValueOnce(true);
    files.splice(0, 1);
    del()!.click();
    await flush();
    expect(fetchImpl).toHaveBeenCalledWith("/sessions/sess-1/files/csf_1", { method: "DELETE" });
    expect(del()).toBeNull();
    expect(row.querySelectorAll(".session-file")).toHaveLength(1);
    expect(document.getElementById("session-files-toggle")!.textContent).toContain("Files (1)");
  });

  const KEY = "claws.session.filesDismissed.sess-1";

  it("collapses on toggle, stores the dismissal, keeps hrefs, and expands again", async () => {
    await loadWithFiles(FILES);
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    const row = document.getElementById("session-files")!;
    const toggle = document.getElementById("session-files-toggle")!;
    const hrefs = () => Array.from(row.querySelectorAll(".session-file-download")).map((a) => a.getAttribute("href"));
    const before = hrefs();
    toggle.click();
    expect(row.classList.contains("files-collapsed")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem(KEY)).toBe("csf_1,csf_2");
    expect(hrefs()).toEqual(before);
    toggle.click();
    expect(row.classList.contains("files-collapsed")).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("starts collapsed when the session's key is set and flags files published afterwards", async () => {
    await loadWithFiles(FILES, { [KEY]: "csf_1" });
    const row = document.getElementById("session-files")!;
    expect(row.classList.contains("files-collapsed")).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(row.classList.contains("files-collapsed")).toBe(true);
    expect(document.getElementById("session-files-toggle")!.textContent).toContain("1 new");
  });

  it("ignores another session's dismissal", async () => {
    await loadWithFiles(FILES, { "claws.session.filesDismissed.other": "csf_1" });
    expect(document.getElementById("session-files")!.classList.contains("files-collapsed")).toBe(false);
  });

  it("keeps the row hidden while the session has published nothing", async () => {
    await loadWithFiles([]);
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(document.getElementById("session-files")!.hidden).toBe(true);
  });
});

describe("session terminal Copy button flash", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("flashes into the text span, keeps the icon and restores after the timer", async () => {
    vi.useFakeTimers();
    vi.spyOn(MockTerminal.prototype, "hasSelection").mockReturnValue(true);
    vi.spyOn(MockTerminal.prototype, "getSelection").mockReturnValue("abc");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    await loadTerminal();
    const btn = document.getElementById("copy-btn") as HTMLButtonElement;
    btn.innerHTML = '<svg></svg><span class="session-btn-text">Copy</span>';
    document.getElementById("terminal")!.dispatchEvent(new Event("contextmenu", { cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(btn.dataset.copied).toBe("ok");
    expect(btn.querySelector("svg")).not.toBeNull();
    expect(btn.querySelector(".session-btn-text")!.textContent).toBe("Copied ✓");
    await vi.advanceTimersByTimeAsync(1300);
    expect(btn.dataset.copied).toBeUndefined();
    expect(btn.querySelector(".session-btn-text")!.textContent).toBe("Copy");
    expect(btn.querySelector("svg")).not.toBeNull();
  });
});

describe("session terminal keybar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockTerminal.last = null;
    MockWebSocket.instances = [];
    MockMediaRecorder.instances = [];
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("toggles the maximised page from the keybar without sending input", async () => {
    await loadTerminal();
    await flush();
    const btn = document.querySelector<HTMLButtonElement>('[data-action="maximise"]')!;
    const before = inputFrames().length;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.body.classList.contains("session-maximised")).toBe(true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("Restore session page");
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.body.classList.contains("session-maximised")).toBe(false);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("aria-label")).toBe("Maximise terminal");
    expect(inputFrames().length).toBe(before);
  });

  it("steps the font down to 5 and dims A- at the floor, undimming on A+", async () => {
    installDom();
    window.localStorage.clear();
    window.localStorage.setItem("claws.terminal.fontSize", "6");
    installGlobals(fetchJson({}));
    vi.resetModules();
    await import("./session-terminal.js");
    await flush();
    const dec = document.querySelector<HTMLButtonElement>('[data-action="font-dec"]')!;
    const inc = document.querySelector<HTMLButtonElement>('[data-action="font-inc"]')!;
    dec.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    dec.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(MockTerminal.last!.options.fontSize).toBe(5);
    expect(window.localStorage.getItem("claws.terminal.fontSize")).toBe("5");
    expect(dec.getAttribute("aria-disabled")).toBe("true");
    inc.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(MockTerminal.last!.options.fontSize).toBe(6);
    expect(dec.hasAttribute("aria-disabled")).toBe(false);
  });

  it("re-sends a resize frame on font keys, visibility and focus, only on an open socket", async () => {
    installDom();
    window.localStorage.clear();
    installGlobals(fetchJson({}));
    const w = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    const h = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    try {
      vi.resetModules();
      await import("./session-terminal.js");
      await flush();
      const sock = MockWebSocket.instances[0];
      const resizes = () => sock.sent.filter((raw) => (JSON.parse(raw) as SentFrame).type === "resize").length;
      const base = resizes();
      document.querySelector<HTMLButtonElement>('[data-action="font-dec"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(resizes()).toBe(base + 1);
      document.querySelector<HTMLButtonElement>('[data-action="font-inc"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(resizes()).toBe(base + 2);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(resizes()).toBe(base + 3);
      window.dispatchEvent(new Event("focus"));
      expect(resizes()).toBe(base + 4);
      sock.readyState = 3;
      window.dispatchEvent(new Event("focus"));
      expect(resizes()).toBe(base + 4);
    } finally {
      w.mockRestore();
      h.mockRestore();
    }
  });

  it.each([["5", 5], ["4", 14]])("loads stored font size %s as %i", async (stored, expected) => {
    installDom();
    window.localStorage.clear();
    window.localStorage.setItem("claws.terminal.fontSize", stored);
    installGlobals(fetchJson({}));
    vi.resetModules();
    await import("./session-terminal.js");
    await flush();
    expect(MockTerminal.last!.options.fontSize).toBe(expected);
  });

  it("sends /signoff and Enter when the /signoff key is tapped", async () => {
    await loadTerminal();
    await flush();
    document.querySelector<HTMLButtonElement>('[data-key="signoff"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const frames = inputFrames();
    expect(frames[frames.length - 1].data).toBe("/signoff\r");
  });

  it("sends /status and Enter when the /status key is tapped", async () => {
    await loadTerminal();
    await flush();
    document.querySelector<HTMLButtonElement>('[data-key="status"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const frames = inputFrames();
    expect(frames[frames.length - 1].data).toBe("/status\r");
  });
});

describe("session terminal chat view (#clw_01M7DYJ0WVGSM09PFTBS3HXDB3)", () => {
  type Reply = { status: number; body?: unknown };
  let transcript: Reply;
  let input: Reply;
  let fetchMock: ReturnType<typeof vi.fn>;

  function respond(r: Reply): Promise<unknown> {
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => (r.body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(r.body)),
    });
  }

  async function loadChat(opts: { provider?: string; narrow?: boolean; stored?: string } = {}): Promise<void> {
    installDom();
    const term = document.getElementById("terminal")!;
    term.setAttribute("data-session-provider", opts.provider ?? "claude");
    term.insertAdjacentHTML("beforebegin", `<span id="session-view-toggle" hidden><button type="button" data-view="chat">Chat</button><button type="button" data-view="terminal">Terminal</button></span>`);
    term.insertAdjacentHTML("afterend", `<div id="session-chat" hidden></div>`);
    window.localStorage.clear();
    if (opts.stored) window.localStorage.setItem("claws.session.view", opts.stored);
    fetchMock = vi.fn((url: string) => {
      if (url.includes("/transcript")) return respond(transcript);
      if (url.endsWith("/input")) return respond(input);
      if (url.endsWith("/screen")) return respond({ status: 200, body: { data: "" } });
      if (url.includes("/startup")) return respond({ status: 200, body: { state: "ready", step: "Ready", detail: null, elapsedMs: 0 } });
      return respond({ status: 200, body: {} });
    });
    installGlobals(fetchMock as unknown as typeof fetch);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (q: string) => ({ matches: q === "(max-width: 767px)" ? opts.narrow === true : false, addEventListener() { /* noop */ } }),
    });
    vi.resetModules();
    await import("./session-terminal.js");
    await flush();
  }

  const toggle = (): HTMLElement => document.getElementById("session-view-toggle")!;
  const chat = (): HTMLElement => document.getElementById("session-chat")!;
  const chatShown = (): boolean => document.body.getAttribute("data-session-view") === "chat" && !chat().hidden;
  const composer = (): HTMLTextAreaElement => chat().querySelector<HTMLTextAreaElement>(".chat-input")!;
  const sendBtn = (): HTMLButtonElement => chat().querySelector<HTMLButtonElement>(".chat-send")!;

  beforeEach(() => {
    vi.useFakeTimers();
    MockTerminal.last = null;
    MockWebSocket.instances = [];
    MockMediaRecorder.instances = [];
    setVisibility("visible");
    transcript = { status: 200, body: { file: "s.jsonl", next: 10, truncatedBefore: false, events: [] } };
    input = { status: 204 };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    document.body.removeAttribute("data-session-view");
    window.localStorage.clear();
  });

  it("defaults to Chat below 768px and to Terminal otherwise", async () => {
    await loadChat({ narrow: true });
    expect(toggle().hidden).toBe(false);
    expect(chatShown()).toBe(true);
    expect(toggle().querySelector('[data-view="chat"]')!.getAttribute("aria-pressed")).toBe("true");

    await loadChat({ narrow: false });
    expect(toggle().hidden).toBe(false);
    expect(chatShown()).toBe(false);
  });

  it("remembers the chosen view per browser over the width default", async () => {
    await loadChat({ narrow: false, stored: "chat" });
    expect(chatShown()).toBe(true);
    toggle().querySelector<HTMLButtonElement>('[data-view="terminal"]')!.click();
    expect(chatShown()).toBe(false);
    expect(window.localStorage.getItem("claws.session.view")).toBe("terminal");

    await loadChat({ narrow: true, stored: "terminal" });
    expect(chatShown()).toBe(false);
  });

  it("stays terminal-only for a non-Claude session and on a 404 from an older pod", async () => {
    await loadChat({ provider: "codex", narrow: true });
    expect(toggle().hidden).toBe(true);
    expect(chatShown()).toBe(false);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/transcript"))).toBe(false);

    transcript = { status: 404, body: { code: "unsupported" } };
    await loadChat({ narrow: true });
    expect(toggle().hidden).toBe(true);
    expect(chatShown()).toBe(false);
  });

  it("clears the composer only on a 204, and keeps the text and shows the error otherwise", async () => {
    await loadChat({ narrow: true });
    const before = inputFrames().length;
    composer().value = "line one\nline two";
    sendBtn().click();
    await flush();
    const post = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/input"))!;
    expect(post[0]).toBe("/sessions/sess-1/input");
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ text: "line one\nline two" });
    expect(composer().value).toBe("");
    // The composer never types into the pty WebSocket.
    expect(inputFrames().length).toBe(before);

    input = { status: 503, body: { error: "Session runtime is unavailable" } };
    composer().value = "keep me";
    sendBtn().click();
    await flush();
    expect(composer().value).toBe("keep me");
    expect(noticeText()).toBe("Send failed: Session runtime is unavailable");
  });

  it("sends no resize while Chat hides the terminal, and re-fits when Terminal is shown", async () => {
    const w = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    const h = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    try {
      await loadChat({ narrow: true });
      expect(chatShown()).toBe(true);
      const sock = MockWebSocket.instances[0];
      const resizes = () => sock.sent.filter((raw) => (JSON.parse(raw) as SentFrame).type === "resize").length;
      const base = resizes();
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      expect(resizes()).toBe(base);
      toggle().querySelector<HTMLButtonElement>('[data-view="terminal"]')!.click();
      expect(resizes()).toBe(base + 1);
      expect(sock.readyState).toBe(MockWebSocket.OPEN);
    } finally {
      w.mockRestore();
      h.mockRestore();
    }
  });

  it("reports the last fitted size when the socket reconnects while Chat is shown", async () => {
    const w = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    const h = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    try {
      await loadChat({ narrow: true });
      expect(chatShown()).toBe(true);
      MockTerminal.last!.cols = 101;
      MockTerminal.last!.rows = 33;
      const first = MockWebSocket.instances[0];
      first.readyState = MockWebSocket.CLOSED;
      first.onclose?.();
      await vi.advanceTimersByTimeAsync(5000);
      const second = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      expect(second).not.toBe(first);
      second.onopen?.();
      expect(JSON.parse(second.sent[0]) as SentFrame).toEqual({ type: "resize", cols: 101, rows: 33 });
    } finally {
      w.mockRestore();
      h.mockRestore();
    }
  });

  it("focuses the composer, not the hidden terminal, after a drop in Chat", async () => {
    await loadChat({ narrow: true });
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/upload")) return respond({ status: 200, body: { path: "/tmp/drop.png" } });
      return respond({ status: 204 });
    });
    const focus = vi.spyOn(MockTerminal.last!, "focus");
    const drop = new Event("drop", { cancelable: true }) as DragEvent;
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [new File(["x"], "drop.png")] } });
    window.dispatchEvent(drop);
    await flush();
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(composer());
  });

  it("keeps the Chat maximise chip in step with the keybar's maximise key", async () => {
    await loadChat({ narrow: false });
    const chip = chat().querySelector<HTMLButtonElement>(".chat-maximise")!;
    document.querySelector<HTMLButtonElement>('#mobile-keybar [data-action="maximise"]')?.click();
    expect(document.body.classList.contains("session-maximised")).toBe(true);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.getAttribute("aria-label")).toBe("Restore session page");
    chip.click();
    expect(document.body.classList.contains("session-maximised")).toBe(false);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
  });

  it("puts a finished upload's path in the composer rather than the terminal while in Chat", async () => {
    await loadChat({ narrow: true });
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/upload")) return respond({ status: 200, body: { path: "/tmp/shot.png" } });
      return respond({ status: 204 });
    });
    const before = inputFrames().length;
    const attach = document.getElementById("attach-input") as HTMLInputElement;
    Object.defineProperty(attach, "files", { configurable: true, value: [new File(["x"], "shot.png")] });
    attach.dispatchEvent(new Event("change"));
    await flush();
    await flush();
    expect(composer().value).toBe("/tmp/shot.png");
    expect(inputFrames().length).toBe(before);
  });
});

describe("session header panels (#clw_01M7NE3EN3MN4FRZG122TJ2P3C)", () => {
  async function loadWithPanels(fetchImpl: typeof fetch = fetchJson({})): Promise<void> {
    installDom();
    document.body.insertAdjacentHTML("afterbegin", `
      <div class="session-bar-main">
        <button id="session-info-btn" type="button" aria-expanded="false" aria-controls="session-info-panel"><span id="session-desc-text" title="Old">Old</span></button>
        <div id="session-info-panel" class="session-pop" hidden><div id="session-desc-full">Old</div><div class="session-started-by">Started from the board</div></div>
        <button id="grant-cap-toggle" type="button" aria-expanded="false" aria-controls="grant-cap"></button>
        <span id="grant-cap" class="grant-cap session-pop">
          <select id="grant-cap-select"><option value="home-assistant">Home Assistant</option><option value="browser" data-revocable="true">Browser</option></select>
          <button id="grant-cap-btn" type="button"></button>
          <button id="revoke-cap-btn" type="button" disabled></button>
        </span>
      </div>
      <div id="cap-requests" hidden></div>
      <span id="grant-cap-status" hidden><span id="grant-cap-status-msg"></span><button id="grant-cap-status-close"></button></span>
    `);
    installGlobals(fetchImpl);
    vi.resetModules();
    await import("./session-terminal.js");
    await flush();
  }

  beforeEach(() => {
    MockTerminal.last = null;
    MockWebSocket.instances = [];
    setVisibility("visible");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    document.body.className = "";
  });

  const el = (id: string) => document.getElementById(id) as HTMLElement;
  const click = (target: HTMLElement) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const infoOpen = () => el("session-info-panel").getAttribute("data-open") === "true" && !el("session-info-panel").hidden;
  const capsOpen = () => el("grant-cap").getAttribute("data-open") === "true";

  it("opens and closes the details panel from the title, keeping aria-expanded in step", async () => {
    await loadWithPanels();
    expect(infoOpen()).toBe(false);
    click(el("session-info-btn"));
    expect(infoOpen()).toBe(true);
    expect(el("session-info-btn").getAttribute("aria-expanded")).toBe("true");
    click(el("session-info-btn"));
    expect(infoOpen()).toBe(false);
    expect(el("session-info-panel").hidden).toBe(true);
    expect(el("session-info-btn").getAttribute("aria-expanded")).toBe("false");
  });

  it("opens one panel at a time", async () => {
    await loadWithPanels();
    click(el("session-info-btn"));
    click(el("grant-cap-toggle"));
    expect(capsOpen()).toBe(true);
    expect(infoOpen()).toBe(false);
    click(el("session-info-btn"));
    expect(infoOpen()).toBe(true);
    expect(capsOpen()).toBe(false);
  });

  it("closes on Escape and on a click outside, but not on a click inside", async () => {
    await loadWithPanels();
    click(el("grant-cap-toggle"));
    click(el("grant-cap-select"));
    expect(capsOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(capsOpen()).toBe(false);
    expect(el("grant-cap-toggle").getAttribute("aria-expanded")).toBe("false");
    click(el("session-info-btn"));
    click(el("terminal"));
    expect(infoOpen()).toBe(false);
  });

  it("closes the Capabilities panel when Grant is pressed", async () => {
    await loadWithPanels();
    click(el("grant-cap-toggle"));
    (el("grant-cap-select") as HTMLSelectElement).value = "home-assistant";
    click(el("grant-cap-btn"));
    expect(capsOpen()).toBe(false);
  });

  it("closes an open panel when the page is maximised", async () => {
    await loadWithPanels();
    click(el("session-info-btn"));
    click(document.querySelector<HTMLElement>('[data-action="maximise"]')!);
    expect(document.body.classList.contains("session-maximised")).toBe(true);
    expect(infoOpen()).toBe(false);
  });

  it("updates both the row title and the panel's full title when the summary changes", async () => {
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith("/capability-requests") ? { requests: [], autoGranted: [], summary: "New <b>title</b>" } : {}),
    }));
    await loadWithPanels(fetchImpl as unknown as typeof fetch);
    expect(el("session-desc-text").textContent).toBe("New <b>title</b>");
    expect(el("session-desc-text").title).toBe("New <b>title</b>");
    expect(el("session-desc-full").textContent).toBe("New <b>title</b>");
    expect(el("session-desc-full").querySelector("b")).toBeNull();
  });
});
