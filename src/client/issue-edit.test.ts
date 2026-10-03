// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./issue-edit.js";

/** The parts of the markup src/pages/issue.ts produces that the script touches. */
function renderIssue(): void {
  document.body.innerHTML = `
    <div class="chip-row" id="issue-repos"><a class="repo-chip" href="/repos/org/a" title="org/a">a</a></div>
    <div class="chip-row" id="issue-labels"></div>
    <p class="issue-meta" id="issue-repo-primary" hidden>Planned and tracked from <span id="issue-repo-primary-name" title="org/a">a</span>; its plan may open PRs in any of these repositories.</p>
    <div class="warning-banner" id="issue-repo-warning" hidden>Rule — assign one to start automation.</div>
    <div class="warning-banner" id="issue-repo-unmanaged">Its primary repository is not managed.</div>
    <form class="issue-form" method="POST" action="/issues/clw_1/labels" data-autosave="labels">
      <div class="check-grid">
        <label><input type="checkbox" name="label" value="Ready"> <span class="label-chip">Ready</span></label>
        <label><input type="checkbox" name="label" value="Refined"> <span class="label-chip">Refined</span></label>
      </div>
      <div class="form-actions"><button type="submit" data-autosave-submit>Save labels</button><span class="autosave-status"></span></div>
    </form>
    <form class="issue-form" method="POST" action="/issues/clw_1/repos" data-autosave="repos">
      <div class="check-grid">
        <label><input type="checkbox" name="repo" value="org/a" checked> org/a</label>
        <label><input type="checkbox" name="repo" value="org/b"> org/b</label>
      </div>
      <div class="form-actions"><button type="submit" data-autosave-submit>Save repositories</button><span class="autosave-status"></span></div>
    </form>
    <div class="issue-title-row" id="issue-title-row">
      <h2 class="issue-title" id="issue-title"><span id="issue-title-text">Original title</span> <span style="color:var(--text-subtle)" title="clw_1">#clw_1</span></h2>
      <button type="button" class="icon-btn" id="issue-title-edit" aria-label="Edit title" title="Edit title">✎</button>
      <button type="button" class="icon-btn" id="issue-copy-url" aria-label="Copy URL" title="Copy URL" data-copy-url="/issues/clw_1"><svg></svg></button>
      <span class="icon-status" id="issue-head-status" role="status" aria-live="polite"></span>
    </div>
    <form class="issue-title-form" id="issue-title-form" method="POST" action="/issues/clw_1/edit" hidden>
      <input type="text" name="title" required maxlength="300" value="Original title">
      <div class="form-actions">
        <button class="trigger-btn" type="submit">Save</button>
        <button class="trigger-btn" type="button" id="issue-title-cancel">Cancel</button>
      </div>
    </form>
    <input type="text" id="issue-edit-title" value="Original title">`;
  (window as unknown as { clawsIssueEditInit: () => void }).clawsIssueEditInit();
}

function form(kind: string): HTMLFormElement {
  return document.querySelector<HTMLFormElement>(`form[data-autosave="${kind}"]`)!;
}

function toggle(kind: string, value: string): void {
  const cb = form(kind).querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
  cb.checked = !cb.checked;
  cb.dispatchEvent(new Event("change", { bubbles: true }));
}

function status(kind: string): string {
  return form(kind).querySelector(".autosave-status")!.textContent ?? "";
}

describe("the issue page's auto-saving forms", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    renderIssue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("hides the Save buttons, which only the no-JS path needs", () => {
    for (const btn of Array.from(document.querySelectorAll<HTMLElement>("[data-autosave-submit]"))) {
      expect(btn.hidden).toBe(true);
    }
  });

  it("posts one urlencoded body after the debounce and adds the chip to the header", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    toggle("labels", "Ready");
    toggle("labels", "Refined");
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/issues\/clw_1\/labels$/);
    expect(init.method).toBe("POST");
    expect(String(init.body)).toBe("label=Ready&label=Refined");
    expect((init.headers as Record<string, string>)["Accept"]).toBe("application/json");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");

    await vi.waitFor(() => expect(status("labels")).toBe("Saved"));
    const chips = Array.from(document.querySelectorAll("#issue-labels .label-chip")).map((c) => c.textContent);
    expect(chips).toEqual(["Ready", "Refined"]);
  });

  it("restores the checkbox and shows an error when the save fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));

    toggle("labels", "Ready");
    await vi.advanceTimersByTimeAsync(400);

    await vi.waitFor(() => expect(status("labels")).toBe("Save failed — reload the page."));
    expect(form("labels").querySelector<HTMLInputElement>('input[value="Ready"]')!.checked).toBe(false);
    expect(form("labels").querySelector(".autosave-status")!.classList.contains("autosave-status-error")).toBe(true);
    expect(document.querySelectorAll("#issue-labels .label-chip")).toHaveLength(0);
  });

  it("restores the checkbox when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));

    toggle("repos", "org/a");
    await vi.advanceTimersByTimeAsync(400);

    await vi.waitFor(() => expect(status("repos")).toBe("Save failed — reload the page."));
    expect(form("repos").querySelector<HTMLInputElement>('input[value="org/a"]')!.checked).toBe(true);
  });

  it("updates the repo chips, no-repo banner and multi-repo note after a repos save", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const banner = document.getElementById("issue-repo-warning")!;
    const note = document.getElementById("issue-repo-primary")!;

    toggle("repos", "org/b");
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(status("repos")).toBe("Saved"));
    expect(banner.hidden).toBe(true);
    expect(document.getElementById("issue-repo-unmanaged")!.hidden).toBe(true);
    expect(note.hidden).toBe(false);
    const primaryName = document.getElementById("issue-repo-primary-name")!;
    expect(primaryName.textContent).toBe("a");
    expect(primaryName.title).toBe("org/a");
    const chips = Array.from(document.querySelectorAll<HTMLAnchorElement>("#issue-repos .repo-chip"));
    expect(chips.map((a) => a.getAttribute("href"))).toEqual(["/repos/org/a", "/repos/org/b"]);
    expect(chips.map((a) => a.textContent)).toEqual(["a", "b"]);
    expect(chips.map((a) => a.title)).toEqual(["org/a", "org/b"]);

    toggle("repos", "org/a");
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(note.hidden).toBe(true));
    expect(banner.hidden).toBe(true);

    toggle("repos", "org/b");
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(banner.hidden).toBe(false));
    expect(note.hidden).toBe(true);
    expect(document.querySelectorAll("#issue-repos .repo-chip")).toHaveLength(0);
  });

  it("re-sends once a change lands while a save is in flight", async () => {
    let release: (() => void) | null = null;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      release = () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }));
    vi.stubGlobal("fetch", fetchMock);

    toggle("labels", "Ready");
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    toggle("labels", "Refined");
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release!();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(String(init.body)).toBe("label=Ready&label=Refined");
    release!();
    await vi.waitFor(() => expect(status("labels")).toBe("Saved"));
  });
});

describe("the issue page's inline title editor and copy-URL button", () => {
  beforeEach(() => {
    renderIssue();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function headStatus(): string {
    return document.getElementById("issue-head-status")!.textContent ?? "";
  }

  it("clicking the pencil shows the form and hides the title text; Cancel restores it", () => {
    const titleText = document.getElementById("issue-title-text") as HTMLElement;
    const form = document.getElementById("issue-title-form") as HTMLFormElement;
    const input = form.querySelector<HTMLInputElement>('input[name="title"]')!;

    document.getElementById("issue-title-edit")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(titleText.hidden).toBe(true);
    expect(form.hidden).toBe(false);
    expect(input.value).toBe("Original title");

    input.value = "Half-typed change";
    document.getElementById("issue-title-cancel")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(form.hidden).toBe(true);
    expect(titleText.hidden).toBe(false);
    expect(input.value).toBe("Original title");
  });

  it("submitting posts the new title with Accept: application/json and updates the header and edit-section input", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, title: "New title" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    document.getElementById("issue-title-edit")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const form = document.getElementById("issue-title-form") as HTMLFormElement;
    const input = form.querySelector<HTMLInputElement>('input[name="title"]')!;
    input.value = "New title";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(headStatus()).toBe("Saved"));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/issues\/clw_1\/edit$/);
    expect(init.method).toBe("POST");
    expect(String(init.body)).toBe("title=New+title");
    expect((init.headers as Record<string, string>)["Accept"]).toBe("application/json");
    expect(document.getElementById("issue-title-text")!.textContent).toBe("New title");
    expect((document.getElementById("issue-edit-title") as HTMLInputElement).value).toBe("New title");
    expect(form.hidden).toBe(true);
  });

  it("Cancel and Escape do nothing while a save is in flight, so a resolving save doesn't override the cancel", async () => {
    let release: (() => void) | null = null;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      release = () => resolve(new Response(JSON.stringify({ ok: true, title: "New title" }), { status: 200 }));
    }));
    vi.stubGlobal("fetch", fetchMock);

    document.getElementById("issue-title-edit")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const form = document.getElementById("issue-title-form") as HTMLFormElement;
    const input = form.querySelector<HTMLInputElement>('input[name="title"]')!;
    const cancelBtn = document.getElementById("issue-title-cancel") as HTMLButtonElement;
    input.value = "New title";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(cancelBtn.disabled).toBe(true);
    cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(form.hidden).toBe(false);

    release!();
    await vi.waitFor(() => expect(headStatus()).toBe("Saved"));
    expect(document.getElementById("issue-title-text")!.textContent).toBe("New title");
    expect(cancelBtn.disabled).toBe(false);
  });

  it("a failed save keeps the form open and shows the error status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));

    document.getElementById("issue-title-edit")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const form = document.getElementById("issue-title-form") as HTMLFormElement;
    const input = form.querySelector<HTMLInputElement>('input[name="title"]')!;
    input.value = "New title";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(headStatus()).toBe("Save failed — reload the page."));
    expect(form.hidden).toBe(false);
    expect(document.getElementById("issue-head-status")!.classList.contains("icon-status-error")).toBe(true);
    expect(document.getElementById("issue-title-text")!.textContent).toBe("Original title");
  });

  it("clicking the copy button copies the absolute permalink and shows Copied", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    document.getElementById("issue-copy-url")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => expect(headStatus()).toBe("Copied"));
    expect(writeText).toHaveBeenCalledWith(new URL("/issues/clw_1", location.href).href);
  });
});
