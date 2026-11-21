// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./actions-control.js";

const reply = (body: unknown) => vi.fn().mockResolvedValue({ ok: true, json: async () => body });
const flush = () => new Promise((r) => setTimeout(r, 0));

function mount(button: string): HTMLButtonElement {
  document.body.innerHTML = `<div data-actions-control-scope>${button}<p class="actions-control-status" hidden></p></div>`;
  return document.querySelector("button") as HTMLButtonElement;
}

describe("actions-control buttons (#clw_01M7X2XQESHRXWHA4Z59EXWT7Y)", () => {
  beforeEach(() => vi.stubGlobal("confirm", () => true));
  afterEach(() => vi.unstubAllGlobals());

  it("cancels a run after confirm and marks the button Cancelled", async () => {
    const fetchMock = reply({ ok: true, cancelled: [{ run: 12 }], already_finished: [], failed: [] });
    vi.stubGlobal("fetch", fetchMock);
    const btn = mount(`<button data-actions-control="cancel-run" data-repo="o/r" data-run="12">Cancel</button>`);
    btn.click();
    await flush();
    expect(fetchMock).toHaveBeenCalledWith("/queue/cancel-run", expect.objectContaining({ body: JSON.stringify({ repo: "o/r", run: 12 }) }));
    expect(btn.textContent).toBe("Cancelled");
    expect(btn.disabled).toBe(true);
  });

  it("reports a run that had already finished", async () => {
    vi.stubGlobal("fetch", reply({ ok: true, cancelled: [], already_finished: [{ run: 12 }], failed: [] }));
    const btn = mount(`<button data-actions-control="cancel-run" data-repo="o/r" data-run="12">Cancel</button>`);
    btn.click();
    await flush();
    expect(btn.textContent).toBe("Already finished");
  });

  it("does nothing when the operator declines", async () => {
    vi.stubGlobal("confirm", () => false);
    const fetchMock = reply({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    mount(`<button data-actions-control="workflow" data-repo="o/r" data-workflow="ci.yml" data-enabled="false">Disable</button>`).click();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows an error in the section's status line", async () => {
    vi.stubGlobal("fetch", reply({ error: "endpoint unavailable (#clw_01M7X2XQESHRXWHA4Z59EXWT7Y)" }));
    const btn = mount(`<button data-actions-control="workflow" data-repo="o/r" data-workflow="ci.yml" data-enabled="true">Enable</button>`);
    btn.click();
    await flush();
    const status = document.querySelector(".actions-control-status") as HTMLElement;
    expect(btn.textContent).toBe("Error");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain("endpoint unavailable");
  });
});
