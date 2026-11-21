// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./queue.js";

interface Page {
  togglePriority(repo: string, number: number, ev: Event): Promise<void>;
  startPrSession(repo: string, number: number, ev: Event): Promise<void>;
  toggleAutomerge(repo: string, number: number, ev: Event, manualNote?: string): Promise<void>;
  cancelPrRuns(repo: string, number: number, ev: Event): Promise<void>;
}

const page = (): Page => (window as unknown as { queuePage: () => Page }).queuePage();

function btnEvent(html: string): { btn: HTMLButtonElement; ev: Event } {
  document.body.innerHTML = `<div>${html}</div>`;
  const btn = document.querySelector("button") as HTMLButtonElement;
  return { btn, ev: { currentTarget: btn } as unknown as Event };
}

const PRIO = `<button class="refined-btn prio-btn" data-mode="prio" title="Prioritise"><span class="pr-icon" aria-hidden="true"><svg></svg></span><span class="pr-label">Prioritise</span></button>`;
const START = `<button class="refined-btn pr-start-session" title="Start session for o/r#1"><span class="pr-icon" aria-hidden="true">&gt;_</span><span class="pr-label">Start session</span></button>`;

const reply = (body: unknown, ok = true) => vi.fn().mockResolvedValue({ ok, json: async () => body });

describe("/prs icon buttons", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("togglePriority writes the label span and leaves the icon alone", async () => {
    vi.stubGlobal("fetch", reply({ ok: true }));
    const { btn, ev } = btnEvent(PRIO);
    const icon = btn.querySelector(".pr-icon");
    await page().togglePriority("o/r", 1, ev);
    expect(btn.querySelector(".pr-label")?.textContent).toBe("Deprioritise");
    expect(btn.querySelector(".pr-icon")).toBe(icon);
    expect(btn.dataset.mode).toBe("deprio");
  });

  it("shows an error reply as a visible label, then clears it after the timeout", async () => {
    vi.stubGlobal("fetch", reply({ error: "nope" }));
    const { btn, ev } = btnEvent(PRIO);
    await page().togglePriority("o/r", 1, ev);
    expect(btn.querySelector(".pr-label")?.textContent).toBe("Error");
    expect(btn.classList.contains("pr-label-visible")).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(btn.classList.contains("pr-label-visible")).toBe(false);
    expect(btn.querySelector(".pr-label")?.textContent).toBe("Prioritise");
    expect(btn.disabled).toBe(false);
  });

  it("startPrSession is busy with a Starting title and reports a refusal after the button", async () => {
    let resolve!: (v: unknown) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise((r) => { resolve = r; })));
    const { btn, ev } = btnEvent(START);
    const run = page().startPrSession("o/r", 1, ev);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.title).toBe("Starting…");
    expect(btn.disabled).toBe(true);
    resolve({ ok: false, json: async () => ({ error: "busy" }) });
    await run;
    expect(btn.title).toBe("Start session for o/r#1");
    expect(btn.disabled).toBe(false);
    expect(btn.querySelector(".pr-label")?.textContent).toBe("Start session");
    expect(btn.nextElementSibling?.className).toBe("merge-error");
    expect(btn.nextElementSibling?.textContent).toContain("busy");
  });

  it("startPrSession swaps the button for a Go to session link and does not navigate", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign });
    vi.stubGlobal("fetch", reply({ ok: true, id: "abc", url: "/sessions/abc" }));
    const { btn, ev } = btnEvent(START);
    await page().startPrSession("o/r", 1, ev);
    const link = document.querySelector("a.refined-btn.pr-go-to-session") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/sessions/abc");
    expect(link.querySelector(".pr-label")?.textContent).toBe("Go to session");
    expect(link.title).toBe("Go to session for o/r#1");
    expect(btn.isConnected).toBe(false);
    expect(link.nextElementSibling?.className).toBe("session-started");
    expect(link.nextElementSibling?.textContent).toBe("Session started");
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("toggleAutomerge", () => {
  const AM = (pressed: boolean) => `<button class="refined-btn pr-automerge-btn${pressed ? " refined-done" : ""}" aria-pressed="${pressed}" title="Automerge"><span class="pr-icon"></span><span class="pr-label">Automerge</span></button>`;
  afterEach(() => vi.unstubAllGlobals());

  it("withdraws a pressed approval", async () => {
    const f = reply({ result: "ok" });
    vi.stubGlobal("fetch", f);
    const { btn, ev } = btnEvent(AM(true));
    await page().toggleAutomerge("o/r", 1, ev);
    expect(f.mock.calls[0][0]).toBe("/queue/unmark-automerge");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.classList.contains("refined-done")).toBe(false);
    expect(btn.disabled).toBe(false);
  });

  it("records an approval on an unpressed button", async () => {
    const f = reply({ result: "ok" });
    vi.stubGlobal("fetch", f);
    const { btn, ev } = btnEvent(AM(false));
    await page().toggleAutomerge("o/r", 1, ev);
    expect(f.mock.calls[0][0]).toBe("/queue/mark-automerge");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.classList.contains("refined-done")).toBe(true);
    expect(btn.disabled).toBe(false);
  });

  it("restores the prior state on an error reply", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", reply({ error: "nope" }));
    const { btn, ev } = btnEvent(AM(true));
    await page().toggleAutomerge("o/r", 1, ev);
    vi.advanceTimersByTime(3000);
    vi.useRealTimers();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.classList.contains("refined-done")).toBe(true);
    expect(btn.disabled).toBe(false);
  });
});

describe("cancelPrRuns (#clw_01M7X2XQESHRXWHA4Z59EXWT7Y)", () => {
  const CANCEL = `<button class="refined-btn pr-cancel-runs-btn"><span class="pr-icon" aria-hidden="true"><svg></svg></span><span class="pr-label">Cancel waiting runs</span></button>`;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does nothing when the operator declines the confirm", async () => {
    const fetchMock = reply({ ok: true, cancelled: [] });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", () => false);
    const { ev } = btnEvent(CANCEL);
    await page().cancelPrRuns("o/r", 7, ev);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the PR and shows the cancelled count inline", async () => {
    const fetchMock = reply({ ok: true, cancelled: [{}, {}], already_finished: [], failed: [] });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", () => true);
    const { btn, ev } = btnEvent(CANCEL);
    await page().cancelPrRuns("o/r", 7, ev);
    expect(fetchMock).toHaveBeenCalledWith("/queue/cancel-pr-runs", expect.objectContaining({ body: JSON.stringify({ repo: "o/r", number: 7 }) }));
    expect(btn.querySelector(".pr-label")?.textContent).toBe("Cancelled 2");
    vi.advanceTimersByTime(3000);
    expect(btn.querySelector(".pr-label")?.textContent).toBe("Cancel waiting runs");
    expect(btn.disabled).toBe(false);
  });

  it("shows an error reply with its message in the title", async () => {
    vi.stubGlobal("fetch", reply({ error: "endpoint unavailable" }));
    vi.stubGlobal("confirm", () => true);
    const { btn, ev } = btnEvent(CANCEL);
    await page().cancelPrRuns("o/r", 7, ev);
    expect(btn.querySelector(".pr-label")?.textContent).toBe("Error");
    expect(btn.title).toBe("endpoint unavailable");
  });
});
