// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { confirmStepDone } from "./lib/step-done-dialog.js";

const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
let realShowModal: (() => void) | undefined;
function stub() {
  proto.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
}

declare global { interface Window { clawsStepDoneInit: () => void } }

// Mirrors STEP_DONE_DIALOG_HTML in src/pages/layout.ts, which pulls in server
// modules a jsdom test cannot load; src/pages/*.test.ts check the real markup.
const STEP_DONE_DIALOG_HTML = `<dialog class="preview-modal step-done-dialog" id="step-done-dialog"><div class="preview-modal-frame">
  <div class="preview-modal-head"><h2 id="step-done-dialog-title">Mark operator step done?</h2></div>
  <div class="preview-modal-body"><p class="step-done-dialog-step"></p><p class="step-done-dialog-text"></p></div>
  <div class="preview-modal-foot"><button type="button" class="trigger-btn step-done-dialog-cancel">Cancel</button><button type="button" class="trigger-btn step-done-dialog-confirm">Mark done</button></div>
</div></dialog>`;

const FORM = `<form class="step-done-form" method="post" action="/issues/clw_x/steps/2/done" data-step-title="Flip &quot;DNS&quot; &lt;b&gt;" data-step-text="Point the record at the new host"><button type="submit" class="step-done-btn">Mark step 2 done</button></form>`;

const dialog = () => document.getElementById("step-done-dialog") as HTMLDialogElement;
const click = (sel: string) => dialog().querySelector<HTMLButtonElement>(sel)!.click();

describe("confirmStepDone", () => {
  beforeEach(() => {
    realShowModal = proto.showModal;
    stub();
    document.body.innerHTML = `<button id="opener">Mark</button>${STEP_DONE_DIALOG_HTML}`;
  });
  afterEach(() => { vi.unstubAllGlobals(); proto.showModal = realShowModal; });

  it("shows the step as text and resolves true on Mark done, refocusing the opener", async () => {
    const opener = document.getElementById("opener") as HTMLButtonElement;
    opener.focus();
    const answer = confirmStepDone(`Flip <b>DNS</b>`, "Point it");
    expect(dialog().hasAttribute("open")).toBe(true);
    expect(dialog().querySelector(".step-done-dialog-step")!.textContent).toBe("Flip <b>DNS</b>");
    expect(dialog().querySelector(".step-done-dialog-step")!.querySelector("b")).toBeNull();
    expect(dialog().querySelector(".step-done-dialog-text")!.textContent).toBe("Point it");
    click(".step-done-dialog-confirm");
    await expect(answer).resolves.toBe(true);
    expect(dialog().hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("resolves false on Cancel, on Escape (close) and on a backdrop click", async () => {
    const cancelled = confirmStepDone("Step", "");
    click(".step-done-dialog-cancel");
    await expect(cancelled).resolves.toBe(false);

    const escaped = confirmStepDone("Step", "");
    dialog().close();
    await expect(escaped).resolves.toBe(false);

    const backdrop = confirmStepDone("Step", "");
    dialog().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect(backdrop).resolves.toBe(false);
  });

  it("falls back to window.confirm when the page has no dialog or no showModal", async () => {
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    proto.showModal = undefined;
    await expect(confirmStepDone("Step", "Do it")).resolves.toBe(true);
    expect(confirmMock).toHaveBeenCalledWith(`Mark "Step" done? Do it`);
    stub();
    document.body.innerHTML = "";
    confirmMock.mockReturnValue(false);
    await expect(confirmStepDone("Step", "")).resolves.toBe(false);
    expect(confirmMock).toHaveBeenCalledTimes(2);
  });
});

describe("issue page Mark step done form", () => {
  beforeEach(async () => {
    realShowModal = proto.showModal;
    stub();
    document.body.innerHTML = `${FORM}${STEP_DONE_DIALOG_HTML}`;
    await import("./step-done.js");
    window.clawsStepDoneInit();
  });
  afterEach(() => { proto.showModal = realShowModal; });

  function submitForm(): { form: HTMLFormElement; submit: ReturnType<typeof vi.fn>; ev: Event } {
    const form = document.querySelector<HTMLFormElement>("form.step-done-form")!;
    const submit = vi.fn();
    form.submit = submit;
    const ev = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(ev);
    return { form, submit, ev };
  }

  it("holds the submit for the dialog and posts the form on Mark done", async () => {
    const { submit, ev } = submitForm();
    expect(ev.defaultPrevented).toBe(true);
    expect(dialog().querySelector(".step-done-dialog-step")!.textContent).toBe(`Flip "DNS" <b>`);
    expect(submit).not.toHaveBeenCalled();
    click(".step-done-dialog-confirm");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  });

  it("does not post the form on Cancel", async () => {
    const { submit } = submitForm();
    click(".step-done-dialog-cancel");
    await new Promise((r) => setTimeout(r, 0));
    expect(submit).not.toHaveBeenCalled();
  });
});
