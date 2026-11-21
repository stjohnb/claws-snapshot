// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatDedupe, createChatView, isNearBottom, PENDING_COMMANDS_STORAGE_PREFIX, PENDING_MATCH_SKEW_MS, type ChatEvent, type ChatViewOptions, type TranscriptReply } from "./session-chat-view.js";

const user = (uuid: string, text: string): ChatEvent => ({ key: uuid + ":0", uuid, timestamp: null, kind: "user", text, html: "<p>" + text + "</p>" });
const assistant = (uuid: string, text: string, i = 0): ChatEvent => ({ key: uuid + ":" + i, uuid, timestamp: null, kind: "assistant", text, html: "<p>" + text + "</p>" });

type Route = { status: number; body?: unknown };

function routedFetch(routes: { transcript: Route[]; screen?: Route; input?: Route }): ReturnType<typeof vi.fn> {
  const queue = [...routes.transcript];
  return vi.fn((url: string) => {
    let route: Route;
    if (url.includes("/transcript")) route = queue.length > 1 ? queue.shift()! : queue[0];
    else if (url.includes("/screen")) route = routes.screen ?? { status: 200, body: { data: "" } };
    else route = routes.input ?? { status: 204 };
    return Promise.resolve({
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: () => route.body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(route.body),
    });
  });
}

const reply = (file: string, events: ChatEvent[], extra: Partial<TranscriptReply> = {}): Route =>
  ({ status: 200, body: { file, next: 100, truncatedBefore: false, events, ...extra } });

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function mount(fetchImpl: ReturnType<typeof vi.fn>, overrides: Partial<ChatViewOptions> = {}) {
  Object.assign(globalThis, { fetch: fetchImpl });
  const container = document.createElement("div");
  document.body.append(container);
  const opts: ChatViewOptions = {
    container,
    sessionId: "abc",
    showTerminal: vi.fn(),
    toggleMaximise: vi.fn(() => true),
    notify: vi.fn(),
    sendInput: vi.fn(() => true),
    onAvailability: vi.fn(),
    onEnded: vi.fn(),
    ...overrides,
  };
  const view = createChatView(opts);
  const feed = container.querySelector<HTMLElement>(".chat-feed")!;
  return { view, opts, container, feed };
}

function setScroll(el: HTMLElement, m: { scrollHeight: number; clientHeight: number; scrollTop: number }): void {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => m.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => m.clientHeight });
  el.scrollTop = m.scrollTop;
}

describe("ChatDedupe", () => {
  it("drops keys already drawn and uuids from earlier replies, but keeps several blocks of one entry", () => {
    const d = new ChatDedupe();
    expect(d.take([assistant("a", "one", 0), assistant("a", "two", 1)]).map((e) => e.key)).toEqual(["a:0", "a:1"]);
    expect(d.take([assistant("a", "one", 0)])).toEqual([]);
    // A resumed transcript copying history: same uuid, any block index.
    expect(d.take([assistant("a", "three", 2), user("b", "hi")]).map((e) => e.key)).toEqual(["b:0"]);
  });
});

describe("isNearBottom", () => {
  it("is true within 48px of the bottom", () => {
    expect(isNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 552 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 551 })).toBe(false);
  });
});

describe("createChatView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("reports availability once from the first read and draws its events, with a tail note", async () => {
    const f = routedFetch({ transcript: [reply("s1.jsonl", [user("u1", "hello"), assistant("a1", "hi there")], { truncatedBefore: true })] });
    const { opts, feed } = mount(f);
    await flush();
    expect(opts.onAvailability).toHaveBeenCalledWith(true);
    expect(feed.querySelector(".chat-user .chat-bubble")!.innerHTML).toBe("<p>hello</p>");
    expect(feed.querySelector(".chat-assistant")!.textContent).toBe("hi there");
    expect(feed.firstElementChild!.textContent).toBe("Earlier messages are in the terminal");
  });

  it("opens every link in a message in a new tab with no opener", async () => {
    const html = '<p><a href="https://example.com/x">x</a> <a href="https://device.sso.eu-west-2.amazonaws.com/?user_code=ABCD-EFGH">u</a> <a href="mailto:a@b.c">m</a></p>';
    const f = routedFetch({ transcript: [reply("s1.jsonl", [{ key: "u1:0", uuid: "u1", timestamp: null, kind: "user", text: "x", html }, { key: "a1:0", uuid: "a1", timestamp: null, kind: "assistant", text: "x", html }])] });
    const { feed } = mount(f);
    await flush();
    const links = feed.querySelectorAll(".chat-bubble a");
    expect(links.length).toBe(6);
    for (const a of Array.from(links)) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
  });

  it("reports unavailable on a 404 and stops reading", async () => {
    const f = routedFetch({ transcript: [{ status: 404, body: { code: "unsupported" } }] });
    const { opts, view } = mount(f);
    await flush();
    expect(opts.onAvailability).toHaveBeenCalledWith(false);
    view.setActive(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.mock.calls.filter(([u]) => String(u).includes("/transcript"))).toHaveLength(1);
  });

  it("treats 204 as available, polls only while active, and resumes from file/next", async () => {
    const f = routedFetch({ transcript: [{ status: 204 }, reply("s1.jsonl", [user("u1", "hello")])] });
    const { opts, view } = mount(f);
    await flush();
    expect(opts.onAvailability).toHaveBeenCalledWith(true);
    await vi.advanceTimersByTimeAsync(10_000);
    const reads = () => f.mock.calls.filter(([u]) => String(u).includes("/transcript")).map(([u]) => String(u));
    expect(reads()).toHaveLength(1);
    view.setActive(true);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(reads()[2]).toBe("/sessions/abc/transcript?file=s1.jsonl&offset=100");
    view.setActive(false);
    const n = reads().length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads()).toHaveLength(n);
  });

  it("stops probing availability while the page is hidden, backs off on failures, and resumes when visible", async () => {
    let visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const f = routedFetch({ transcript: [{ status: 503, body: { code: "unavailable" } }] });
    const { opts } = mount(f);
    const reads = () => f.mock.calls.filter(([u]) => String(u).includes("/transcript")).length;
    await flush();
    expect(reads()).toBe(1);
    // Failures back off: after one failed probe the next waits longer than the 2s poll.
    await vi.advanceTimersByTimeAsync(2000);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(reads()).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    const whileVisible = reads();
    expect(whileVisible).toBeLessThan(10);
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(120_000);
    const hidden = reads();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads()).toBe(hidden);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(reads()).toBe(hidden + 1);
    expect(opts.onAvailability).not.toHaveBeenCalled();
  });

  it("adds a New transcript divider on rotation and skips history the new file copies", async () => {
    const f = routedFetch({ transcript: [
      reply("s1.jsonl", [user("u1", "hello"), assistant("a1", "hi")]),
      reply("s2.jsonl", [user("u1", "hello"), assistant("a1", "hi"), user("u2", "again")]),
    ] });
    const { view, feed } = mount(f);
    await flush();
    view.setActive(true);
    await flush();
    const texts = Array.from(feed.children).map((c) => c.textContent);
    expect(texts).toEqual(["hello", "hi", "New transcript", "again"]);
  });

  it("pairs a tool call with its result and folds long output behind Show more", async () => {
    const output = Array.from({ length: 20 }, (_, i) => "line " + i).join("\n");
    const f = routedFetch({ transcript: [reply("s1.jsonl", [
      { key: "t:0", uuid: "t", timestamp: null, kind: "tool_use", id: "tu1", name: "Bash", summary: "npm test", input: "{\n  \"command\": \"npm test\"\n}", inputTruncated: false },
      { key: "r:0", uuid: "r", timestamp: null, kind: "tool_result", toolUseId: "tu1", isError: true, text: output, truncated: false },
    ])] });
    const { feed } = mount(f);
    await flush();
    const row = feed.querySelector<HTMLDetailsElement>("details.chat-tool")!;
    expect(row.querySelector(".chat-tool-mark")!.getAttribute("data-state")).toBe("failed");
    expect(row.querySelector(".chat-tool-desc")!.textContent).toBe("npm test");
    const out = row.querySelector(".chat-tool-output")!;
    expect(out.textContent!.split("\n")).toHaveLength(12);
    row.querySelector<HTMLButtonElement>(".chat-show-more")!.click();
    expect(out.textContent).toBe(output);
  });

  const tu = (id: string, name = "Bash"): ChatEvent => ({ key: id + ":0", uuid: id, timestamp: null, kind: "tool_use", id, name, summary: "s " + id, input: "{}", inputTruncated: false });
  const tr = (id: string, isError = false): ChatEvent => ({ key: "r" + id + ":0", uuid: "r" + id, timestamp: null, kind: "tool_result", toolUseId: id, isError, text: "out " + id, truncated: false });

  it("folds consecutive tool calls into one run and lets later calls join it", async () => {
    const f = routedFetch({ transcript: [
      reply("s1.jsonl", Array.from({ length: 8 }, (_, i) => tu("a" + i))),
      reply("s1.jsonl", [tu("a8")]),
    ] });
    const { view, feed } = mount(f);
    await flush();
    expect(feed.children).toHaveLength(1);
    const group = feed.querySelector<HTMLElement>("details.chat-tool-group")!;
    expect(group.querySelector(".chat-tool-group-count")!.textContent).toBe("8 tool calls");
    view.setActive(true);
    await flush();
    expect(feed.children).toHaveLength(1);
    expect(group.querySelector(".chat-tool-group-count")!.textContent).toBe("9 tool calls");
    expect(group.querySelectorAll(".chat-tool-group-rows > details.chat-tool")).toHaveLength(9);
  });

  it("converts a lone call to a run when a later reply adds one, and keeps messages between runs", async () => {
    const f = routedFetch({ transcript: [
      reply("s1.jsonl", [tu("a"), assistant("m", "hi"), tu("b")]),
      reply("s1.jsonl", [tu("c"), tu("d")]),
    ] });
    const { view, feed } = mount(f);
    await flush();
    expect(Array.from(feed.children).map((c) => c.className)).toEqual(["chat-tool", "chat-msg chat-assistant", "chat-tool"]);
    view.setActive(true);
    await flush();
    expect(Array.from(feed.children).map((c) => c.className)).toEqual(["chat-tool", "chat-msg chat-assistant", "chat-tool-group"]);
    expect(feed.querySelector(".chat-tool-group-count")!.textContent).toBe("3 tool calls");
  });

  it("shows a run's pending, failed and done state as results arrive, and rows still expand", async () => {
    const f = routedFetch({ transcript: [
      reply("s1.jsonl", [tu("a"), tu("b")]),
      reply("s1.jsonl", [tr("a", true)]),
    ] });
    const { view, feed } = mount(f);
    await flush();
    const mark = feed.querySelector<HTMLElement>(".chat-tool-group-summary .chat-tool-mark")!;
    expect(mark.dataset.state).toBe("pending");
    view.setActive(true);
    await flush();
    expect(mark.dataset.state).toBe("pending");
    expect(feed.querySelector(".chat-tool-group-failed")!.textContent).toBe(" · 1 failed");
    expect(feed.querySelector(".chat-tool-group-rows .chat-tool-output")!.textContent).toBe("out a");
  });

  it("auto-scrolls only when the reader was near the bottom, otherwise shows the New messages chip", async () => {
    const f = routedFetch({ transcript: [
      reply("s1.jsonl", [user("u1", "one")]),
      reply("s1.jsonl", [user("u2", "two")]),
      reply("s1.jsonl", [user("u3", "three")]),
    ] });
    const { view, feed, container } = mount(f);
    const chip = container.querySelector<HTMLButtonElement>(".chat-new-chip")!;
    setScroll(feed, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    await flush();
    expect(chip.hidden).toBe(true);
    // Scrolled up: the next batch leaves the position and raises the chip.
    feed.scrollTop = 100;
    view.setActive(true);
    await flush();
    expect(feed.scrollTop).toBe(100);
    expect(chip.hidden).toBe(false);
    chip.click();
    expect(feed.scrollTop).toBe(1000);
    expect(chip.hidden).toBe(true);
  });

  it("shows the waiting banner from the screen and opens the terminal from it", async () => {
    const f = routedFetch({ transcript: [{ status: 204 }], screen: { status: 200, body: { data: "Do you want to proceed?\r\n❯ 1. Yes\r\n" } } });
    const { view, opts, container } = mount(f);
    await flush();
    view.setActive(true);
    await flush();
    const banner = container.querySelector<HTMLElement>(".chat-waiting")!;
    expect(banner.hidden).toBe(false);
    expect(container.querySelector(".chat-status")!.textContent).toBe("Claude is waiting for input");
    banner.querySelector<HTMLButtonElement>(".chat-open-terminal")!.click();
    expect(opts.showTerminal).toHaveBeenCalled();
  });

  const permissionScreen = "Bash command\r\n  npm test\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No, and tell Claude what to do differently (esc)\r\n";

  it("shows a parsed prompt's question and options in the waiting banner and answers with the option's digit", async () => {
    const f = routedFetch({ transcript: [{ status: 204 }], screen: { status: 200, body: { data: permissionScreen } } });
    const { view, opts, container } = mount(f);
    await flush();
    view.setActive(true);
    await flush();
    expect(container.querySelector(".chat-prompt-question")!.textContent).toBe("Do you want to proceed?");
    expect(container.querySelector(".chat-prompt-detail")!.textContent).toBe("Bash command\nnpm test");
    const options = [...container.querySelectorAll<HTMLButtonElement>(".chat-prompt-option")];
    expect(options.map((b) => b.textContent)).toEqual(["1. Yes", "2. No, and tell Claude what to do differently (esc)"]);
    expect(container.querySelector(".chat-open-terminal")).not.toBeNull();
    const screenReads = () => f.mock.calls.filter(([u]) => String(u).endsWith("/screen")).length;
    const before = screenReads();
    options[1].click();
    await flush();
    expect(screenReads()).toBe(before + 1);
    expect(opts.sendInput).toHaveBeenCalledTimes(1);
    expect(opts.sendInput).toHaveBeenCalledWith("2");
    // A second tap before the next read cannot type another digit.
    expect(options[1].disabled).toBe(true);
    // The 500 ms re-read still shows the answered prompt: its buttons stay disabled through the grace period.
    await vi.advanceTimersByTimeAsync(500);
    const redrawn = [...container.querySelectorAll<HTMLButtonElement>(".chat-prompt-option")];
    expect(redrawn.every((b) => b.disabled)).toBe(true);
    redrawn[0].click();
    await flush();
    expect(opts.sendInput).toHaveBeenCalledTimes(1);
    // Once the grace period is over a read that still shows it enables the buttons again.
    await vi.advanceTimersByTimeAsync(3000);
    expect([...container.querySelectorAll<HTMLButtonElement>(".chat-prompt-option")].every((b) => !b.disabled)).toBe(true);
  });

  it("does not answer a different command's prompt that has the same question and options", async () => {
    const prompt = (command: string) => [
      "────────────────────────────────",
      " Bash command",
      "",
      "   " + command,
      "   Remove build output",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
    ].join("\r\n") + "\r\n";
    const routes = { transcript: [{ status: 204 }] as Route[], screen: { status: 200, body: { data: prompt("npm test") } } as Route };
    const f = routedFetch(routes);
    const { view, opts, container } = mount(f);
    await flush();
    view.setActive(true);
    await flush();
    routes.screen = { status: 200, body: { data: prompt("rm -rf dist") } };
    container.querySelector<HTMLButtonElement>(".chat-prompt-option")!.click();
    await flush();
    expect(opts.sendInput).not.toHaveBeenCalled();
    expect(container.querySelector(".chat-prompt-detail")!.textContent).toBe("Bash command\nrm -rf dist\nRemove build output");
  });

  it("reports an answer the closed terminal socket did not send and re-enables the options", async () => {
    const f = routedFetch({ transcript: [{ status: 204 }], screen: { status: 200, body: { data: permissionScreen } } });
    const { view, opts, container } = mount(f, { sendInput: vi.fn(() => false) });
    await flush();
    view.setActive(true);
    await flush();
    container.querySelector<HTMLButtonElement>(".chat-prompt-option")!.click();
    await flush();
    expect(opts.sendInput).toHaveBeenCalledWith("1");
    expect(opts.notify).toHaveBeenCalledWith("Terminal not connected — answer not sent", true);
    expect([...container.querySelectorAll<HTMLButtonElement>(".chat-prompt-option")].every((b) => !b.disabled)).toBe(true);
  });

  it("notifies, sends nothing and re-enables the options when the re-read fails", async () => {
    const routes = { transcript: [{ status: 204 }] as Route[], screen: { status: 200, body: { data: permissionScreen } } as Route };
    const f = routedFetch(routes);
    const { view, opts, container } = mount(f);
    await flush();
    view.setActive(true);
    await flush();
    routes.screen = { status: 503 };
    container.querySelector<HTMLButtonElement>(".chat-prompt-option")!.click();
    await flush();
    expect(opts.notify).toHaveBeenCalledWith(expect.stringContaining("503"), true);
    expect(opts.sendInput).not.toHaveBeenCalled();
    expect([...container.querySelectorAll<HTMLButtonElement>(".chat-prompt-option")].every((b) => !b.disabled)).toBe(true);

    f.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    container.querySelector<HTMLButtonElement>(".chat-prompt-option")!.click();
    await flush();
    expect(opts.notify).toHaveBeenCalledWith(expect.stringContaining("offline"), true);
    expect(opts.sendInput).not.toHaveBeenCalled();
    expect([...container.querySelectorAll<HTMLButtonElement>(".chat-prompt-option")].every((b) => !b.disabled)).toBe(true);
  });

  it("sends nothing and redraws the banner when the screen changed before the tap", async () => {
    const routes = { transcript: [{ status: 204 }] as Route[], screen: { status: 200, body: { data: permissionScreen } } as Route };
    const f = routedFetch(routes);
    const { view, opts, container } = mount(f);
    await flush();
    view.setActive(true);
    await flush();
    routes.screen = { status: 200, body: { data: "Do you want to make this edit to a.ts?\r\n❯ 1. Yes\r\n  2. Yes, allow all edits\r\n  3. No\r\n" } };
    container.querySelector<HTMLButtonElement>(".chat-prompt-option")!.click();
    await flush();
    expect(opts.sendInput).not.toHaveBeenCalled();
    expect(container.querySelector(".chat-prompt-question")!.textContent).toBe("Do you want to make this edit to a.ts?");
    expect(container.querySelectorAll(".chat-prompt-option")).toHaveLength(3);

    routes.screen = { status: 200, body: { data: "● Done.\r\n> \r\n" } };
    container.querySelector<HTMLButtonElement>(".chat-prompt-option")!.click();
    await flush();
    expect(opts.sendInput).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLElement>(".chat-waiting")!.hidden).toBe(true);
  });

  it("sends quick commands through POST /input", async () => {
    const f = routedFetch({ transcript: [{ status: 204 }] });
    const { container } = mount(f);
    await flush();
    container.querySelector<HTMLButtonElement>('[data-command="/compact"]')!.click();
    await flush();
    const post = f.mock.calls.find(([u]) => String(u).endsWith("/input"))!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ text: "/compact" });
  });

  describe("pending quick commands", () => {
    const T0 = Date.parse("2026-11-17T10:00:00.000Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    const cmd = (uuid: string, name: string, timestamp: string | null): ChatEvent => ({ key: uuid + ":0", uuid, timestamp, kind: "command", name, args: "" });
    const userAt = (uuid: string, text: string, timestamp: string | null): ChatEvent => ({ key: uuid + ":0", uuid, timestamp, kind: "user", text, html: "<p>" + text + "</p>" });
    const pendingRows = (feed: HTMLElement) => Array.from(feed.querySelectorAll<HTMLElement>(".chat-pending"));
    const chips = (feed: HTMLElement, text: string) => Array.from(feed.querySelectorAll(".chat-command-chip")).filter((c) => c.textContent === text);
    const inputPosts = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([u]) => String(u).endsWith("/input"));

    /** A fetch whose /input requests stay unresolved until `release` is called. */
    function heldInputFetch(transcript: Route[]) {
      const base = routedFetch({ transcript });
      const held: Array<(r: Route) => void> = [];
      const f = vi.fn((url: string, init?: RequestInit) => {
        if (!String(url).endsWith("/input")) return (base as unknown as (u: string, i?: RequestInit) => Promise<unknown>)(url, init);
        return new Promise((resolve) => {
          held.push((route) => resolve({
            ok: route.status >= 200 && route.status < 300,
            status: route.status,
            json: () => route.body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(route.body),
          }));
        });
      });
      return { f, release: (i: number, r: Route) => held[i]!(r) };
    }

    beforeEach(() => { vi.setSystemTime(T0); });

    for (const command of ["/status", "/signoff", "/compact", "/ship"]) {
      it("draws " + command + " as pending before the send answers, then waiting after a 204", async () => {
        const { f, release } = heldInputFetch([{ status: 204 }]);
        const { container, feed } = mount(f);
        await flush();
        container.querySelector<HTMLButtonElement>('[data-command="' + command + '"]')!.click();
        const rows = pendingRows(feed);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.querySelector(".chat-command-chip")!.textContent).toBe(command);
        expect(rows[0]!.dataset.state).toBe("sending");
        expect(rows[0]!.querySelector(".chat-pending-note")!.textContent).toBe("Sending…");
        expect(rows[0]!.querySelector<HTMLButtonElement>(".chat-pending-dismiss")!.hidden).toBe(true);
        expect(JSON.parse((inputPosts(f)[0]![1] as RequestInit).body as string)).toEqual({ text: command });
        release(0, { status: 204 });
        await flush();
        expect(rows[0]!.dataset.state).toBe("waiting");
        expect(rows[0]!.querySelector(".chat-pending-note")!.textContent).toBe("Waiting for Claude");
        expect(rows[0]!.querySelector<HTMLButtonElement>(".chat-pending-dismiss")!.getAttribute("aria-label")).toBe("Dismiss " + command);
      });
    }

    it("is replaced by the transcript's command entry, leaving one chip", async () => {
      const f = routedFetch({ transcript: [{ status: 204 }, reply("s1.jsonl", [cmd("c1", "/status", iso(T0 + 1000))])] });
      const { view, container, feed } = mount(f);
      await flush();
      container.querySelector<HTMLButtonElement>('[data-command="/status"]')!.click();
      await flush();
      expect(pendingRows(feed)).toHaveLength(1);
      view.setActive(true);
      await flush();
      expect(pendingRows(feed)).toHaveLength(0);
      expect(chips(feed, "/status")).toHaveLength(1);
      expect(sessionStorage.getItem(PENDING_COMMANDS_STORAGE_PREFIX + "abc")).toBeNull();
    });

    it("is resolved by a plain user message that is the command, and by a name without the slash", async () => {
      const f = routedFetch({ transcript: [{ status: 204 }, reply("s1.jsonl", [userAt("u1", "/status", iso(T0)), cmd("c1", "ship", iso(T0))])] });
      const { view, container, feed } = mount(f);
      await flush();
      container.querySelector<HTMLButtonElement>('[data-command="/status"]')!.click();
      container.querySelector<HTMLButtonElement>('[data-command="/ship"]')!.click();
      await flush();
      expect(pendingRows(feed)).toHaveLength(2);
      view.setActive(true);
      await flush();
      expect(pendingRows(feed)).toHaveLength(0);
    });

    it("stays pending for a command stamped over 30s before the tap or with no timestamp", async () => {
      const f = routedFetch({ transcript: [{ status: 204 }, reply("s1.jsonl", [
        cmd("c1", "/status", iso(T0 - PENDING_MATCH_SKEW_MS - 1)),
        cmd("c2", "/status", null),
        cmd("c3", "/status", "not a date"),
      ])] });
      const { view, container, feed } = mount(f);
      await flush();
      container.querySelector<HTMLButtonElement>('[data-command="/status"]')!.click();
      await flush();
      view.setActive(true);
      await flush();
      expect(pendingRows(feed)).toHaveLength(1);
      expect(feed.lastElementChild!.classList.contains("chat-pending")).toBe(true);
    });

    it("draws new entries above a waiting entry and still folds tool rows into one run", async () => {
      const f = routedFetch({ transcript: [reply("s1.jsonl", [tu("a")]), reply("s1.jsonl", [assistant("m", "working"), tu("b")]), reply("s1.jsonl", [tu("c")])] });
      const { view, container, feed } = mount(f);
      await flush();
      container.querySelector<HTMLButtonElement>('[data-command="/status"]')!.click();
      await flush();
      view.setActive(true);
      await flush();
      await vi.advanceTimersByTimeAsync(2000);
      expect(Array.from(feed.children).map((c) => c.className)).toEqual([
        "chat-tool", "chat-msg chat-assistant", "chat-tool-group", "chat-msg chat-command chat-pending",
      ]);
      expect(feed.querySelector(".chat-tool-group-count")!.textContent).toBe("2 tool calls");
    });

    it("shows a failed send in the entry without a notice, and Dismiss removes it", async () => {
      const f = routedFetch({ transcript: [{ status: 204 }], input: { status: 503, body: { error: "agent pane not running" } } });
      const { opts, container, feed } = mount(f);
      await flush();
      container.querySelector<HTMLButtonElement>('[data-command="/status"]')!.click();
      await flush();
      const row = pendingRows(feed)[0]!;
      expect(row.dataset.state).toBe("failed");
      expect(row.querySelector(".chat-pending-note")!.textContent).toBe("Not sent: agent pane not running");
      expect(opts.notify).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(PENDING_COMMANDS_STORAGE_PREFIX + "abc")).toBeNull();
      const dismiss = row.querySelector<HTMLButtonElement>(".chat-pending-dismiss")!;
      expect(dismiss.hidden).toBe(false);
      dismiss.click();
      expect(pendingRows(feed)).toHaveLength(0);
    });

    it("ignores a second tap while the send is in flight, and resolves later entries oldest first", async () => {
      const { f, release } = heldInputFetch([{ status: 204 },
        reply("s1.jsonl", [cmd("c1", "/status", iso(T0 + 5000))]),
        reply("s1.jsonl", [cmd("c2", "/status", iso(T0 + 6000))])]);
      const { view, container, feed } = mount(f);
      await flush();
      const b = container.querySelector<HTMLButtonElement>('[data-command="/status"]')!;
      b.click();
      b.click();
      expect(inputPosts(f)).toHaveLength(1);
      release(0, { status: 204 });
      await flush();
      vi.setSystemTime(T0 + 1000);
      b.click();
      expect(inputPosts(f)).toHaveLength(2);
      release(1, { status: 204 });
      await flush();
      const [first, second] = pendingRows(feed);
      view.setActive(true);
      await flush();
      expect(pendingRows(feed)).toEqual([second]);
      expect(first!.isConnected).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(pendingRows(feed)).toHaveLength(0);
      expect(chips(feed, "/status")).toHaveLength(2);
    });

    it("restores a stored entry in a new view and clears it from the first matching read", async () => {
      sessionStorage.setItem(PENDING_COMMANDS_STORAGE_PREFIX + "abc", JSON.stringify([{ command: "/compact", sentAt: T0 }]));
      const f = routedFetch({ transcript: [{ status: 204 }, reply("s1.jsonl", [cmd("c1", "/compact", iso(T0 + 2000)), { key: "k:0", uuid: "k", timestamp: iso(T0 + 3000), kind: "compact" }])] });
      const { view, feed } = mount(f);
      expect(pendingRows(feed)).toHaveLength(1);
      expect(pendingRows(feed)[0]!.dataset.state).toBe("waiting");
      await flush();
      view.setActive(true);
      await flush();
      expect(pendingRows(feed)).toHaveLength(0);
      expect(chips(feed, "/compact")).toHaveLength(1);
      expect(sessionStorage.getItem(PENDING_COMMANDS_STORAGE_PREFIX + "abc")).toBeNull();
    });

    it("ignores malformed stored entries", async () => {
      for (const raw of ["not json", "{}", JSON.stringify([{ command: "/rm", sentAt: T0 }, { command: "/status", sentAt: "x" }, null])]) {
        sessionStorage.setItem(PENDING_COMMANDS_STORAGE_PREFIX + "abc", raw);
        const { feed } = mount(routedFetch({ transcript: [{ status: 204 }] }));
        expect(pendingRows(feed)).toHaveLength(0);
        document.body.innerHTML = "";
      }
    });

    it("keeps a pending entry across hide and show, and clears it when the session ends", async () => {
      const f = routedFetch({ transcript: [{ status: 204 }] });
      const { view, container, feed } = mount(f);
      await flush();
      view.setActive(true);
      container.querySelector<HTMLButtonElement>('[data-command="/status"]')!.click();
      await flush();
      expect(JSON.parse(sessionStorage.getItem(PENDING_COMMANDS_STORAGE_PREFIX + "abc")!)).toEqual([{ kind: "command", command: "/status", sentAt: T0 }]);
      view.setActive(false);
      view.setActive(true);
      await flush();
      expect(pendingRows(feed)).toHaveLength(1);
      view.setEnded();
      expect(pendingRows(feed)).toHaveLength(0);
      expect(sessionStorage.getItem(PENDING_COMMANDS_STORAGE_PREFIX + "abc")).toBeNull();
    });

    it("sends a quick command while a composer send is in flight", async () => {
      const { f } = heldInputFetch([{ status: 204 }]);
      const { view, container, feed } = mount(f);
      await flush();
      view.appendToComposer("hello");
      container.querySelector<HTMLFormElement>(".chat-composer")!.dispatchEvent(new Event("submit", { cancelable: true }));
      await flush();
      container.querySelector<HTMLButtonElement>('[data-command="/status"]')!.click();
      await flush();
      expect(inputPosts(f).map(([, init]) => JSON.parse((init as RequestInit).body as string).text)).toEqual(["hello", "/status"]);
      expect(pendingRows(feed)).toHaveLength(1);
    });
  });

  it("stops polling and disables the composer once the session ends", async () => {
    const f = routedFetch({ transcript: [{ status: 204 }] });
    const { view, container } = mount(f);
    await flush();
    view.setActive(true);
    await flush();
    view.setEnded();
    const n = f.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.mock.calls.length).toBe(n);
    expect(container.querySelector<HTMLTextAreaElement>(".chat-input")!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".chat-send")!.disabled).toBe(true);
  });

  it("has only the text box and an icon Send in the composer, and Send posts the text", async () => {
    const f = routedFetch({ transcript: [{ status: 204 }] });
    const { view, container } = mount(f);
    await flush();
    expect(container.querySelector(".chat-attach")).toBeNull();
    expect(container.querySelector(".chat-mic")).toBeNull();
    const box = container.querySelector(".chat-input-box")!;
    expect(box.children.length).toBe(2);
    expect(box.children[0]).toBe(container.querySelector(".chat-input"));
    const send = box.querySelector<HTMLButtonElement>('button.chat-send[type="submit"][aria-label="Send"]')!;
    expect(send.querySelector("svg")).not.toBeNull();
    view.appendToComposer("hello");
    const ta = container.querySelector<HTMLTextAreaElement>(".chat-input")!;
    expect(ta.value).toBe("hello");
    container.querySelector<HTMLFormElement>(".chat-composer")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    const post = f.mock.calls.find(([u]) => String(u).endsWith("/input"))!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ text: "hello" });
  });
  const chip = (c: HTMLElement, sel: string) => c.querySelector<HTMLButtonElement>(sel)!;
  const suggestionScreen = "● Done.\r\n────────────\r\n❯ \x1b[7mR\x1b[27m\x1b[2mun the tests\x1b[22m\r\n────────────\r\n";

  it("lays out one toolbar row of chips in order, End session last", async () => {
    const { container } = mount(routedFetch({ transcript: [{ status: 204 }] }));
    await flush();
    const bar = container.querySelector(".chat-actions")!;
    expect(bar.getAttribute("role")).toBe("toolbar");
    expect([...bar.querySelectorAll("button")].map((b) => b.textContent)).toEqual(
      ["⤢", "Yes", "Esc", "Tab", "/status", "/signoff", "/compact", "/ship", "A−", "A+", "End session"]);
    expect(bar.lastElementChild!.classList.contains("chat-end-session")).toBe(true);
  });

  const inputCalls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([u]) => String(u).endsWith("/input"));

  it("Yes posts yes once, leaves the draft alone, and works maximised", async () => {
    const f = routedFetch({ transcript: [{ status: 204 }] });
    const { view, container } = mount(f);
    await flush();
    const ta = container.querySelector<HTMLTextAreaElement>("textarea")!;
    ta.value = "draft";
    view.setMaximised(true);
    chip(container, '[data-chat-action="yes"]').click();
    await flush();
    expect(inputCalls(f)).toHaveLength(1);
    expect(JSON.parse((inputCalls(f)[0][1] as RequestInit).body as string)).toEqual({ text: "yes" });
    expect(ta.value).toBe("draft");
  });

  it("ignores a second Yes tap while the first is in flight", async () => {
    const f = routedFetch({ transcript: [{ status: 204 }] });
    const { container } = mount(f);
    await flush();
    const y = chip(container, '[data-chat-action="yes"]');
    y.click();
    y.click();
    await flush();
    expect(inputCalls(f)).toHaveLength(1);
  });

  it("notifies when Yes fails", async () => {
    const f = routedFetch({ transcript: [{ status: 204 }], input: { status: 500, body: { error: "boom" } } });
    const { opts, container } = mount(f);
    await flush();
    chip(container, '[data-chat-action="yes"]').click();
    await flush();
    expect(opts.notify).toHaveBeenCalledWith("Send failed: boom", true);
  });

  it("disables Yes while a numbered menu shows and after the session ends", async () => {
    const routes = { transcript: [{ status: 204 }] as Route[], screen: { status: 200, body: { data: permissionScreen } } as Route };
    const f = routedFetch(routes);
    const { view, container } = mount(f);
    await flush();
    view.setActive(true);
    await flush();
    const y = chip(container, '[data-chat-action="yes"]');
    expect(y.getAttribute("aria-disabled")).toBe("true");
    y.click();
    await flush();
    expect(inputCalls(f)).toHaveLength(0);
    view.setEnded();
    expect(y.disabled).toBe(true);
  });

  it("keeps the chat chips off the terminal keybar's data-action selectors", () => {
    const { container } = mount(vi.fn());
    expect(container.querySelector('[data-action="font-dec"], [data-action="font-inc"], [data-key]')).toBeNull();
  });

  it("sends a real Escape per Esc press and a Tab for Tab, then re-reads the screen", async () => {
    const f = routedFetch({ transcript: [{ status: 204 }] });
    const { view, opts, container } = mount(f);
    await flush();
    view.setActive(true);
    await flush();
    const screenReads = () => f.mock.calls.filter(([u]) => String(u).endsWith("/screen")).length;
    const before = screenReads();
    chip(container, '[data-chat-key="esc"]').click();
    chip(container, '[data-chat-key="esc"]').click();
    chip(container, '[data-chat-key="tab"]').click();
    expect((opts.sendInput as ReturnType<typeof vi.fn>).mock.calls).toEqual([["\x1b"], ["\x1b"], ["\t"]]);
    await vi.advanceTimersByTimeAsync(500);
    expect(screenReads()).toBe(before + 1);
  });

  it("reports a key the closed terminal socket did not send", async () => {
    const { opts, container } = mount(routedFetch({ transcript: [{ status: 204 }] }), { sendInput: vi.fn(() => false) });
    await flush();
    chip(container, '[data-chat-key="tab"]').click();
    expect(opts.notify).toHaveBeenCalledWith("Terminal not connected — key not sent", true);
  });

  it("steps the chat font within bounds, marks the limits and persists the size", async () => {
    const { container } = mount(routedFetch({ transcript: [{ status: 204 }] }));
    await flush();
    const column = container.querySelector<HTMLElement>(".chat-column")!;
    expect(column.style.getPropertyValue("--chat-font-size")).toBe("");
    const inc = chip(container, '[data-chat-action="font-inc"]');
    const dec = chip(container, '[data-chat-action="font-dec"]');
    inc.click();
    expect(column.style.getPropertyValue("--chat-font-size")).toBe("15px");
    expect(localStorage.getItem("claws.chat.fontSize")).toBe("15");
    for (let i = 0; i < 20; i++) inc.click();
    expect(column.style.getPropertyValue("--chat-font-size")).toBe("24px");
    expect(inc.getAttribute("aria-disabled")).toBe("true");
    expect(inc.disabled).toBe(false);
    for (let i = 0; i < 20; i++) dec.click();
    expect(column.style.getPropertyValue("--chat-font-size")).toBe("10px");
    expect(dec.getAttribute("aria-disabled")).toBe("true");
    expect(inc.hasAttribute("aria-disabled")).toBe(false);
  });

  it("restores a stored chat font size and ignores an out-of-range one", async () => {
    localStorage.setItem("claws.chat.fontSize", "24");
    const a = mount(routedFetch({ transcript: [{ status: 204 }] }));
    expect(a.container.querySelector<HTMLElement>(".chat-column")!.style.getPropertyValue("--chat-font-size")).toBe("24px");
    expect(chip(a.container, '[data-chat-action="font-inc"]').getAttribute("aria-disabled")).toBe("true");
    localStorage.setItem("claws.chat.fontSize", "99");
    const b = mount(routedFetch({ transcript: [{ status: 204 }] }));
    expect(b.container.querySelector<HTMLElement>(".chat-column")!.style.getPropertyValue("--chat-font-size")).toBe("");
  });

  it("keeps working when localStorage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const { container } = mount(routedFetch({ transcript: [{ status: 204 }] }));
    chip(container, '[data-chat-action="font-dec"]').click();
    expect(container.querySelector<HTMLElement>(".chat-column")!.style.getPropertyValue("--chat-font-size")).toBe("13px");
  });

  describe("suggestion chip", () => {
    const T0 = Date.parse("2026-11-18T10:00:00.000Z");
    const emptyScreen = "● Done.\r\n────────────\r\n❯ \r\n────────────\r\n";
    const otherScreen = "● Done.\r\n────────────\r\n❯ \x1b[7mC\x1b[27m\x1b[2mommit the fix\x1b[22m\r\n────────────\r\n";
    const pendingRows = (feed: HTMLElement) => Array.from(feed.querySelectorAll<HTMLElement>(".chat-pending"));

    beforeEach(() => { vi.setSystemTime(T0); });

    async function mountWithSuggestion(routes: { transcript: Route[]; screen: Route; input?: Route }) {
      const f = routedFetch(routes);
      const m = mount(f);
      await flush();
      m.view.setActive(true);
      await flush();
      const sug = chip(m.container, ".chat-suggestion");
      const ta = m.container.querySelector<HTMLTextAreaElement>(".chat-input")!;
      return { f, ...m, sug, ta };
    }

    it("shows Claude's suggestion only while the composer is empty and one is shown", async () => {
      const routes = { transcript: [{ status: 204 }] as Route[], screen: { status: 200, body: { data: suggestionScreen } } as Route };
      const f = routedFetch(routes);
      const { view, container } = mount(f);
      await flush();
      const sug = chip(container, ".chat-suggestion");
      expect(sug.hidden).toBe(true);
      view.setActive(true);
      await flush();
      expect(sug.hidden).toBe(false);
      expect(sug.textContent).toBe("Run the tests");
      expect(sug.getAttribute("aria-label")).toBe("Send suggestion: Run the tests");
      expect(sug.title).toBe("Send suggestion: Run the tests");
      const ta = container.querySelector<HTMLTextAreaElement>(".chat-input")!;
      ta.value = "h";
      ta.dispatchEvent(new Event("input"));
      expect(sug.hidden).toBe(true);
      sug.click();
      await flush();
      expect(inputCalls(f)).toHaveLength(0);
      ta.value = "";
      ta.dispatchEvent(new Event("input"));
      expect(sug.hidden).toBe(false);
      routes.screen = { status: 200, body: { data: emptyScreen } };
      await vi.advanceTimersByTimeAsync(3000);
      expect(sug.hidden).toBe(true);
    });

    it("sends the suggestion on tap without filling or focusing the composer", async () => {
      const { f, opts, sug, ta, feed } = await mountWithSuggestion({ transcript: [{ status: 204 }], screen: { status: 200, body: { data: suggestionScreen } } });
      sug.click();
      expect(sug.hidden).toBe(true);
      const rows = pendingRows(feed);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.classList.contains("chat-user")).toBe(true);
      expect(rows[0]!.querySelector(".chat-bubble")!.textContent).toBe("Run the tests");
      expect(rows[0]!.querySelector(".chat-pending-note")!.textContent).toBe("Sending…");
      await flush();
      expect(inputCalls(f)).toHaveLength(1);
      expect(JSON.parse((inputCalls(f)[0][1] as RequestInit).body as string)).toEqual({ text: "Run the tests" });
      expect(ta.value).toBe("");
      expect(document.activeElement).not.toBe(ta);
      expect(opts.sendInput).not.toHaveBeenCalled();
      expect(rows[0]!.dataset.state).toBe("waiting");
      expect(rows[0]!.querySelector(".chat-pending-note")!.textContent).toBe("Waiting for Claude");
    });

    it("sends once for two quick taps", async () => {
      const { f, sug, feed } = await mountWithSuggestion({ transcript: [{ status: 204 }], screen: { status: 200, body: { data: suggestionScreen } } });
      sug.click();
      sug.click();
      await flush();
      expect(inputCalls(f)).toHaveLength(1);
      expect(pendingRows(feed)).toHaveLength(1);
    });

    it("keeps the chip hidden while the screen still shows the sent suggestion, and shows a different one", async () => {
      const routes = { transcript: [{ status: 204 }] as Route[], screen: { status: 200, body: { data: suggestionScreen } } as Route };
      const { sug } = await mountWithSuggestion(routes);
      sug.click();
      await flush();
      await vi.advanceTimersByTimeAsync(3000);
      expect(sug.hidden).toBe(true);
      routes.screen = { status: 200, body: { data: otherScreen } };
      await vi.advanceTimersByTimeAsync(3000);
      expect(sug.hidden).toBe(false);
      expect(sug.textContent).toBe("Commit the fix");
    });

    it("clears the pending bubble when the transcript shows the message", async () => {
      const msg: ChatEvent = { key: "u1:0", uuid: "u1", timestamp: new Date(T0 + 1000).toISOString(), kind: "user", text: "Run  the\ntests", html: "<p>Run the tests</p>" };
      // The mount and setActive reads answer 204; the next read, after the tap, carries the message.
      const { sug, feed } = await mountWithSuggestion({ transcript: [{ status: 204 }, { status: 204 }, reply("s1.jsonl", [msg])], screen: { status: 200, body: { data: suggestionScreen } } });
      sug.click();
      await flush();
      expect(pendingRows(feed)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(pendingRows(feed)).toHaveLength(0);
      expect(Array.from(feed.querySelectorAll(".chat-user .chat-bubble")).map((b) => b.textContent)).toEqual(["Run the tests"]);
      expect(sessionStorage.getItem(PENDING_COMMANDS_STORAGE_PREFIX + "abc")).toBeNull();
    });

    it("says why a failed send was not sent and shows the chip again", async () => {
      const { sug, feed } = await mountWithSuggestion({ transcript: [{ status: 204 }], screen: { status: 200, body: { data: suggestionScreen } }, input: { status: 409, body: { error: "agent pane not running" } } });
      sug.click();
      await flush();
      const rows = pendingRows(feed);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dataset.state).toBe("failed");
      expect(rows[0]!.querySelector(".chat-pending-note")!.textContent).toBe("Not sent: agent pane not running");
      expect(sug.hidden).toBe(false);
    });

    it("restores a stored pending suggestion as waiting, and still drops a stored entry outside the allow-list", async () => {
      sessionStorage.setItem(PENDING_COMMANDS_STORAGE_PREFIX + "abc", JSON.stringify([
        { kind: "suggestion", command: "Run the tests", sentAt: T0 },
        { command: "Run the tests", sentAt: T0 },
        { kind: "suggestion", command: "x".repeat(2001), sentAt: T0 },
        { kind: "suggestion", command: "  ", sentAt: T0 },
      ]));
      const { feed } = mount(routedFetch({ transcript: [{ status: 204 }] }));
      const rows = pendingRows(feed);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dataset.state).toBe("waiting");
      expect(rows[0]!.querySelector(".chat-bubble")!.textContent).toBe("Run the tests");
    });
  });

  it("ends the session with no confirmation, then calls onEnded", async () => {
    const f = routedFetch({ transcript: [{ status: 204 }] });
    vi.stubGlobal("confirm", vi.fn(() => true));
    const { opts, container } = mount(f);
    await flush();
    chip(container, ".chat-end-session").click();
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledWith("/sessions/abc/kill", { method: "POST" });
    expect(opts.onEnded).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLTextAreaElement>(".chat-input")!.disabled).toBe(true);
    expect(container.querySelector(".chat-status")!.textContent).toBe("Session ended");
    expect(chip(container, ".chat-end-session").disabled).toBe(true);
  });

  it("reports a failed End session and re-enables it", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const f = vi.fn((url: string) => url.endsWith("/kill")
      ? Promise.resolve({ ok: false, status: 409, text: () => Promise.resolve("session is being reconciled") })
      : Promise.resolve({ ok: true, status: 204, json: () => Promise.reject(new Error("no body")) }));
    const { opts, container } = mount(f);
    await flush();
    chip(container, ".chat-end-session").click();
    await flush();
    expect(opts.notify).toHaveBeenCalledWith("Failed to end session: session is being reconciled", true);
    expect(opts.onEnded).not.toHaveBeenCalled();
    expect(chip(container, ".chat-end-session").disabled).toBe(false);
    expect(container.querySelector<HTMLTextAreaElement>(".chat-input")!.disabled).toBe(false);
  });

  it("disables every new chip and hides the suggestion once ended", async () => {
    const f = routedFetch({ transcript: [{ status: 204 }], screen: { status: 200, body: { data: suggestionScreen } } });
    const { view, opts, container } = mount(f);
    await flush();
    view.setActive(true);
    await flush();
    view.setEnded();
    for (const sel of ['[data-chat-key="esc"]', '[data-chat-key="tab"]', '[data-chat-action="font-dec"]', '[data-chat-action="font-inc"]', ".chat-end-session"]) {
      expect(chip(container, sel).disabled).toBe(true);
    }
    expect(chip(container, ".chat-suggestion").hidden).toBe(true);
    chip(container, '[data-chat-key="esc"]').click();
    expect(opts.sendInput).not.toHaveBeenCalled();
  });
});
