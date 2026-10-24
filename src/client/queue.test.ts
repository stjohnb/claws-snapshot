// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./queue.js";

interface Page {
  togglePriority(repo: string, number: number, ev: Event): Promise<void>;
  startPrSession(repo: string, number: number, ev: Event): Promise<void>;
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
