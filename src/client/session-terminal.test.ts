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
  onclose: (() => void) | null = null;
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
    <button id="session-desc-set-title"></button>
    <button id="attach-btn"></button>
    <input id="attach-input" type="file">
    <button id="mic-btn"></button>
    <button id="copy-btn"></button>
    <div id="terminal" data-session-id="sess-1" data-session-alive="true"></div>
    <div id="drop-overlay"></div>
    <div id="upload-toast"><span id="upload-toast-msg"></span><button id="upload-toast-close"></button></div>
    <div id="copy-overlay"></div>
    <div id="startup-status" hidden></div>
    <textarea id="copy-textarea"></textarea>
    <button id="copy-all-btn"></button>
    <button id="copy-close-btn"></button>
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

function toastText(): string {
  return document.getElementById("upload-toast-msg")?.textContent ?? "";
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
    expect(toastText()).toBe("Whisper unavailable — voice note sent as saved audio path; replaced the typed draft");
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

type StartupBody = { state: string; step: string; detail: string | null; elapsedMs: number; failureReason?: string | null };

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
    expect(toastText()).toBe("");
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
    expect(toastText()).toBe("");
  });
});

describe("grant-capability option states (#3138, #3322)", () => {
  async function loadTerminalWithGrantSelect(fetchImpl: typeof fetch): Promise<void> {
    installDom();
    document.body.insertAdjacentHTML("beforeend", `
      <span id="grant-cap">
        <select id="grant-cap-select" aria-label="Capability to grant">
          <optgroup label="Infrastructure">
            <option value="prod-infra">Prod infra (kubectl)</option>
            <option value="fleet-infra">Fleet infra (kubectl)</option>
          </optgroup>
          <optgroup label="SSH hosts">
            <option value="ssh:nas">SSH: nas</option>
          </optgroup>
        </select>
        <button id="grant-cap-btn" type="button"></button>
      </span>
      <span id="grant-cap-status" hidden></span>
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

  it("disables a granted option with \" (granted)\", keeps its optgroup and selects the next grantable one (#3322)", async () => {
    await loadTerminalWithGrantSelect(fetchJson({}));

    grantSelect().value = "ssh:nas";
    grantBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    const nas = grantSelect().querySelector<HTMLOptionElement>('option[value="ssh:nas"]')!;
    expect(nas.disabled).toBe(true);
    expect(nas.textContent).toBe("SSH: nas (granted)");
    expect(document.querySelector('optgroup[label="SSH hosts"]')).not.toBeNull();
    expect(grantSelect().value).toBe("prod-infra");
    expect(grantBtn().disabled).toBe(false);
    expect(document.getElementById("grant-cap-status")!.textContent).toBe("SSH: nas: Granted");
  });

  it("keeps the control visible with the button disabled once every option is granted", async () => {
    await loadTerminalWithGrantSelect(fetchJson({}));

    for (const id of ["prod-infra", "fleet-infra", "ssh:nas"]) {
      grantSelect().value = id;
      grantBtn().dispatchEvent(new Event("click", { bubbles: true }));
      await flush();
    }
    expect(grantSelect().options.length).toBe(3);
    expect(Array.from(grantSelect().options).every((o) => o.disabled && o.textContent!.endsWith(" (granted)"))).toBe(true);
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

  it("tells the operator to resume the session when a grant is not live yet", async () => {
    await loadTerminalWithGrantSelect(fetchJson({ live: false, loadPath: null, marker: null, delayed: false }));

    grantSelect().value = "ssh:nas";
    grantBtn().dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(document.getElementById("grant-cap-status")!.textContent)
      .toBe("SSH: nas: Granted — takes effect once the session is ended and resumed from the sessions list");
  });
});
