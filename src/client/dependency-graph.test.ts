// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
function stub() {
  proto.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
}

declare global { interface Window { clawsDependencyGraphInit: () => void } }

const GRAPH = `<section class="dep-chain"><h3>repo</h3><div class="dep-row" data-edges="[{&quot;from&quot;:&quot;c&quot;,&quot;to&quot;:&quot;b&quot;,&quot;label&quot;:&quot;next&quot;},{&quot;from&quot;:&quot;c&quot;,&quot;to&quot;:&quot;a&quot;,&quot;label&quot;:&quot;skips&quot;}]">
  <a class="dep-card" data-node="c" href="/issues/c">C</a><a class="dep-card" data-node="b" href="/issues/b">B</a><a class="dep-card" data-node="a" href="/issues/a">A</a>
</div></section>`;

async function setup() {
  document.body.innerHTML = `<div class="board-toolbar"><button type="button" class="trigger-btn" data-dep-graph-open>Dependency graph</button></div>
    <dialog class="preview-modal dep-graph-modal" id="dep-graph-modal">
      <div class="preview-modal-frame">
        <div class="preview-modal-head"><h2>Dependency graph</h2><button type="button" class="preview-modal-close" aria-label="Close">×</button></div>
        <div class="preview-modal-body dep-graph-body" data-dep-graph-body></div>
      </div>
    </dialog>`;
  await import("./dependency-graph.js");
  window.clawsDependencyGraphInit();
}

const dialog = () => document.getElementById("dep-graph-modal") as HTMLDialogElement;
const body = () => dialog().querySelector<HTMLElement>("[data-dep-graph-body]")!;
const opener = () => document.querySelector<HTMLButtonElement>("[data-dep-graph-open]")!;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("dependency graph modal", () => {
  beforeEach(() => { stub(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("opens on the button, shows Loading… and fills the body from the route", async () => {
    await setup();
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
    vi.stubGlobal("fetch", fetchMock);
    opener().click();
    expect(dialog().hasAttribute("open")).toBe(true);
    expect(body().textContent).toBe("Loading…");
    expect(fetchMock).toHaveBeenCalledWith("/api/board/dependency-graph", expect.objectContaining({ credentials: "same-origin" }));
    resolve(new Response(JSON.stringify({ html: GRAPH, chains: 1 }), { status: 200 }));
    await settle();
    expect(body().querySelectorAll(".dep-card")).toHaveLength(3);
    const svg = body().querySelector(".dep-row > svg")!;
    expect(svg).not.toBeNull();
    const titles = [...svg.querySelectorAll("path.dep-edge title")].map((t) => t.textContent);
    expect(titles).toEqual(["next", "skips"]);
    // One edge runs below the row; the lane padding stays at the base.
    expect(body().querySelector<HTMLElement>(".dep-row")!.style.paddingBottom).toBe("34px");
  });

  it("fetches afresh on every open", async () => {
    await setup();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ html: "<p>No open issues are blocking one another.</p>", chains: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    opener().click();
    await settle();
    expect(body().textContent).toBe("No open issues are blocking one another.");
    dialog().close();
    opener().click();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("says so when the fetch fails", async () => {
    await setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    opener().click();
    await settle();
    expect(body().textContent).toBe("Could not load the dependency graph.");
    dialog().close();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    opener().click();
    await settle();
    expect(body().textContent).toBe("Could not load the dependency graph.");
  });

  it("closes on the close button and a backdrop click, returning focus to the button", async () => {
    await setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ html: "", chains: 0 }), { status: 200 })));
    opener().click();
    dialog().querySelector<HTMLButtonElement>(".preview-modal-close")!.click();
    expect(dialog().hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(opener());
    opener().click();
    dialog().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog().hasAttribute("open")).toBe(false);
  });
});
