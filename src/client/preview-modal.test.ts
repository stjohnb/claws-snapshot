// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";

const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
function stub() {
  proto.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
}

declare global { interface Window { clawsPreviewModalInit: () => void } }

async function setup() {
  document.body.innerHTML = `
    <details class="preview-peek board-plan"><summary>Plan · 2 sections</summary><div class="markdown"><p>Hello</p></div><a href="/issues/x#plan">Full plan</a></details>
    <dialog class="preview-modal" id="preview-modal"><div class="preview-modal-frame">
      <div class="preview-modal-head"><h2 id="preview-modal-title"></h2><button type="button" class="preview-modal-close">×</button></div>
      <div class="preview-modal-body markdown"></div>
      <div class="preview-modal-foot"><a class="preview-modal-link" href="#"></a></div>
    </div></dialog>`;
  await import("./preview-modal.js");
  window.clawsPreviewModalInit();
}

describe("preview modal", () => {
  beforeEach(() => { stub(); });

  it("opens with the preview content, leaving the details closed", async () => {
    await setup();
    const summary = document.querySelector("summary")!;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    summary.dispatchEvent(ev);
    const dialog = document.getElementById("preview-modal") as HTMLDialogElement;
    expect(ev.defaultPrevented).toBe(true);
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(document.querySelector("details")!.open).toBe(false);
    expect(document.getElementById("preview-modal-title")!.textContent).toBe("Plan · 2 sections");
    expect(dialog.querySelector(".preview-modal-body")!.innerHTML).toBe("<p>Hello</p>");
    const link = dialog.querySelector<HTMLAnchorElement>(".preview-modal-link")!;
    expect(link.getAttribute("href")).toBe("/issues/x#plan");
    expect(link.textContent).toBe("Full plan");
  });

  it("closes on the close button and returns focus to the summary", async () => {
    await setup();
    const summary = document.querySelector("summary")!;
    summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    document.querySelector<HTMLElement>(".preview-modal-close")!.click();
    expect(document.getElementById("preview-modal")!.hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it("closes on a backdrop click but not a click inside the frame", async () => {
    await setup();
    const dialog = document.getElementById("preview-modal")!;
    document.querySelector("summary")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    dialog.querySelector<HTMLElement>(".preview-modal-frame")!.click();
    expect(dialog.hasAttribute("open")).toBe(true);
    dialog.click();
    expect(dialog.hasAttribute("open")).toBe(false);
  });

  it("leaves the click alone when showModal is unsupported", async () => {
    await setup();
    delete proto.showModal;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.querySelector("summary")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
