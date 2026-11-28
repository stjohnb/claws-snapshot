// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import "./repo-picker.js";

function render(): HTMLFormElement {
  document.body.innerHTML = `
    <form>
      <div class="check-grid">
        <label><input type="checkbox" name="repo" value="o/a" checked> <span class="check-text"><span class="repo-avatar" aria-hidden="true">a<img alt=""></span>a</span></label>
        <label><input type="checkbox" name="repo" value="o/b"> <span class="check-text"><span class="repo-avatar" aria-hidden="true">b</span>b</span></label>
        <label><input type="checkbox" name="repo" value="o/claws"> <span class="check-text"><span class="repo-avatar" aria-hidden="true">c</span>claws</span></label>
      </div>
      <p class="repo-picker-count"></p>
      <div class="repo-picker-selected" data-repo-selected hidden></div>
    </form>`;
  (window as unknown as { clawsRepoPickerInit: () => void }).clawsRepoPickerInit();
  return document.querySelector("form")!;
}
const chips = () => Array.from(document.querySelectorAll<HTMLElement>(".repo-selected-chip")).map((c) => c.textContent);
const box = (v: string) => document.querySelector<HTMLInputElement>(`input[value="${v}"]`)!;

describe("repo picker selected list", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("lists preselected repos, unhides the list and hides the count", () => {
    render();
    expect(chips()).toEqual(["a ×"]);
    expect(document.querySelector<HTMLElement>("[data-repo-selected]")!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>(".repo-picker-count")!.hidden).toBe(true);
  });

  it("adds a chip on check and removes on uncheck", () => {
    render();
    box("o/b").checked = true;
    box("o/b").dispatchEvent(new Event("change", { bubbles: true }));
    expect(chips()).toEqual(["a ×", "b ×"]);
    box("o/a").checked = false;
    box("o/a").dispatchEvent(new Event("change", { bubbles: true }));
    expect(chips()).toEqual(["b ×"]);
  });

  it("names a repo without the avatar initial", () => {
    render();
    box("o/claws").checked = true;
    box("o/claws").dispatchEvent(new Event("change", { bubbles: true }));
    expect(chips()).toContain("claws ×");
    expect(chips()).not.toContain("cclaws ×");
  });

  it("a chip click unchecks its input and shows the empty text", () => {
    render();
    document.querySelector<HTMLElement>(".repo-selected-chip")!.click();
    expect(box("o/a").checked).toBe(false);
    expect(document.querySelector("[data-repo-selected]")!.textContent).toBe("No repository selected");
  });

  it("restores the default after form.reset()", () => {
    vi.useFakeTimers();
    const form = render();
    box("o/a").checked = false;
    box("o/a").dispatchEvent(new Event("change", { bubbles: true }));
    form.reset();
    vi.runAllTimers();
    expect(chips()).toEqual(["a ×"]);
    vi.useRealTimers();
  });
});
