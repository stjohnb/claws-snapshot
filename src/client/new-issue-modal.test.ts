// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
function stub() {
  proto.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
}

declare global { interface Window { clawsNewIssueModalInit: () => void } }

/** The markup buildNewIssueModal and NEW_ISSUE_BUTTON render, cut to the fields the script touches. */
async function setup(preselect?: string) {
  const repo = (r: string) => `<label><input type="checkbox" name="repo" value="${r}"${r === preselect ? " checked" : ""}> ${r}</label>`;
  document.body.innerHTML = `<div class="board-toolbar"><a class="trigger-btn" href="/issues/new" data-new-issue-open>New issue</a> <span class="new-issue-status" role="status" aria-live="polite"></span></div>
    <dialog class="preview-modal new-issue-modal" id="new-issue-modal" aria-labelledby="new-issue-modal-title">
      <div class="preview-modal-frame">
        <div class="preview-modal-head"><h2 id="new-issue-modal-title">New issue</h2><button type="button" class="preview-modal-close" aria-label="Close">×</button></div>
        <div class="preview-modal-body new-issue-modal-body">
          <div class="new-issue-done" data-new-issue-done hidden>
            <p><span data-new-issue-done-text></span> <a href="#" data-new-issue-link>Open issue</a></p>
            <div class="form-actions"><button class="trigger-btn" type="button" data-new-issue-again>Log another</button></div>
          </div>
          <form class="issue-form" method="POST" action="/issues" data-new-issue-form>
            <p class="new-issue-error" role="alert" hidden></p>
            <input type="text" name="title" required data-new-issue-title>
            <textarea name="body" data-attach-target="new"></textarea>
            <div data-attachment-inputs hidden></div>
            <div class="check-grid">${repo("org/a")}${repo("org/b")}</div>
            <label><input type="radio" name="autoPromote" value="wait" checked> Wait</label>
            <label><input type="radio" name="autoPromote" value="auto"> Auto</label>
            <button class="trigger-btn" type="submit">Create issue</button>
            <button class="trigger-btn" type="button" data-new-issue-cancel>Cancel</button>
          </form>
        </div>
      </div>
    </dialog>`;
  await import("./new-issue-modal.js");
  window.clawsNewIssueModalInit();
}

const dialog = () => document.getElementById("new-issue-modal") as HTMLDialogElement;
const opener = () => document.querySelector<HTMLAnchorElement>("[data-new-issue-open]")!;
const titleInput = () => dialog().querySelector<HTMLInputElement>('input[name="title"]')!;
const bodyInput = () => dialog().querySelector<HTMLTextAreaElement>('textarea[name="body"]')!;
const form = () => dialog().querySelector<HTMLFormElement>("form")!;

function open(): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  opener().dispatchEvent(ev);
  return ev;
}

async function submit(): Promise<void> {
  form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  // Let the fetch promise chain settle.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("new issue modal", () => {
  beforeEach(() => { stub(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("opens on the button instead of following the link, focusing Title", async () => {
    await setup();
    const ev = open();
    expect(ev.defaultPrevented).toBe(true);
    expect(dialog().hasAttribute("open")).toBe(true);
    expect(document.activeElement).toBe(titleInput());
  });

  it("leaves the link alone when the browser has no showModal", async () => {
    await setup();
    proto.showModal = undefined;
    const ev = open();
    expect(ev.defaultPrevented).toBe(false);
    expect(dialog().hasAttribute("open")).toBe(false);
  });

  it("closes on the close and Cancel buttons, returning focus to the button and keeping what was typed", async () => {
    await setup();
    open();
    titleInput().value = "Half typed";
    dialog().querySelector<HTMLElement>(".preview-modal-close")!.click();
    expect(dialog().hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(opener());
    open();
    expect(titleInput().value).toBe("Half typed");
    dialog().querySelector<HTMLElement>("[data-new-issue-cancel]")!.click();
    expect(dialog().hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(opener());
  });

  it("closes on a backdrop click but not a click inside the frame", async () => {
    await setup();
    open();
    dialog().querySelector<HTMLElement>(".preview-modal-frame")!.click();
    expect(dialog().hasAttribute("open")).toBe(true);
    dialog().click();
    expect(dialog().hasAttribute("open")).toBe(false);
  });

  it("posts the form as JSON-accepting urlencoded data", async () => {
    await setup("org/b");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, id: "clw_X", url: "/issues/clw_X" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    open();
    titleInput().value = "A thing";
    await submit();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url, location.href).pathname).toBe("/issues");
    expect((init.headers as Record<string, string>).Accept).toBe("application/json");
    const params = new URLSearchParams(init.body as string);
    expect(params.get("title")).toBe("A thing");
    expect(params.getAll("repo")).toEqual(["org/b"]);
    expect(params.get("autoPromote")).toBe("wait");
  });

  it("shows the error and keeps every field when creation fails", async () => {
    await setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Blocks: org/b#99 is not tracked" }), { status: 400 })));
    open();
    titleInput().value = "Keep me";
    bodyInput().value = "And me";
    dialog().querySelector<HTMLInputElement>('input[name="repo"][value="org/a"]')!.checked = true;
    await submit();
    const error = dialog().querySelector<HTMLElement>(".new-issue-error")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("not tracked");
    expect(titleInput().value).toBe("Keep me");
    expect(bodyInput().value).toBe("And me");
    expect(dialog().querySelector<HTMLInputElement>('input[name="repo"][value="org/a"]')!.checked).toBe(true);
    expect(dialog().hasAttribute("open")).toBe(true);
    for (const b of Array.from(form().querySelectorAll<HTMLButtonElement>('button[type="submit"]'))) expect(b.disabled).toBe(false);
  });

  it("shows the error on a network failure", async () => {
    await setup();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    open();
    titleInput().value = "Keep me";
    await submit();
    expect(dialog().querySelector<HTMLElement>(".new-issue-error")!.textContent).toContain("offline");
    expect(titleInput().value).toBe("Keep me");
  });

  it("on success links to the new issue, resets the form and leaves the message beside the button", async () => {
    await setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, id: "clw_NEW", url: "/issues/clw_NEW" }), { status: 200 })));
    open();
    titleInput().value = "Done soon";
    const pending = dialog().querySelector<HTMLElement>("[data-attachment-inputs]")!;
    pending.innerHTML = `<input type="hidden" name="attachment" value="cla_1">`;
    await submit();
    const done = dialog().querySelector<HTMLElement>("[data-new-issue-done]")!;
    expect(done.hidden).toBe(false);
    expect(form().hidden).toBe(true);
    expect(done.textContent).toContain("Created #clw_NEW");
    const link = dialog().querySelector<HTMLAnchorElement>("[data-new-issue-link]")!;
    expect(link.getAttribute("href")).toBe("/issues/clw_NEW");
    expect(document.activeElement).toBe(link);
    expect(titleInput().value).toBe("");
    expect(pending.innerHTML).toBe("");
    const status = document.querySelector<HTMLElement>(".new-issue-status")!;
    expect(status.textContent).toContain("Created #clw_NEW");
    expect(status.querySelector("a")!.getAttribute("href")).toBe("/issues/clw_NEW");

    dialog().querySelector<HTMLElement>("[data-new-issue-again]")!.click();
    expect(done.hidden).toBe(true);
    expect(form().hidden).toBe(false);
    expect(document.activeElement).toBe(titleInput());
  });
});
