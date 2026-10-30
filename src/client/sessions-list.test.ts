// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./sessions-list.js";

interface OnMultiRepoChangePage {
  onMultiRepoChange(): void;
}

interface OnRepoChangePage {
  onRepoChange(): void;
}

function page(): OnMultiRepoChangePage & OnRepoChangePage {
  return (window as unknown as { sessionsListPage: () => OnMultiRepoChangePage & OnRepoChangePage }).sessionsListPage();
}

function selectRepo(value: string): void {
  const radio = document.querySelector(`#session-repo input[name="repo"][value="${value}"]`) as HTMLInputElement;
  radio.checked = true;
}

function repoCheckbox(value: string): HTMLInputElement {
  return document.querySelector(`form input[name="repo"][value="${value}"]`) as HTMLInputElement;
}

describe("onMultiRepoChange repo relevance", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form>
        <input type="checkbox" name="repo" value="org/a">
        <input type="checkbox" name="repo" value="org/b">
        <fieldset id="multi-cap-list">
          <label data-cap="home-assistant" data-cap-repos='["org/a"]'>
            <input type="checkbox">
          </label>
          <label data-cap="ssh:nas" data-cap-repos='["org/a","org/b"]'>
            <input type="checkbox">
          </label>
        </fieldset>
      </form>
    `;
  });

  it("never ticks a capability just because a repo it is relevant to is checked", () => {
    repoCheckbox("org/a").checked = true;
    repoCheckbox("org/b").checked = true;
    page().onMultiRepoChange();
    for (const box of Array.from(document.querySelectorAll('#multi-cap-list input[type="checkbox"]'))) {
      expect((box as HTMLInputElement).checked).toBe(false);
    }
  });
});

describe("onMultiRepoChange remembered defaults", () => {
  function capCheckbox(id: string): HTMLInputElement {
    return document.querySelector(`#multi-cap-list label[data-cap="${id}"] input[type="checkbox"]`) as HTMLInputElement;
  }

  beforeEach(() => {
    const defaults = JSON.stringify({ "org/a\norg/b": ["home-assistant"] }).replace(/"/g, "&quot;");
    document.body.innerHTML = `
      <form>
        <input type="checkbox" name="repo" value="org/a">
        <input type="checkbox" name="repo" value="org/b">
        <input type="checkbox" name="repo" value="org/c">
        <div id="multi-cap-list" data-multi-cap-defaults="${defaults}">
          <label data-cap="claude-auth" data-cap-repos="[]" data-cap-provider="claude"><input type="checkbox" checked></label>
          <label data-cap="home-assistant" data-cap-repos="[]"><input type="checkbox"></label>
          <label data-cap="ssh:nas" data-cap-repos="[]"><input type="checkbox" checked></label>
          <label data-cap="cross-repo" data-cap-repos="[]" data-cap-auto-repos="*"><input type="checkbox"><span class="cap-auto-note"></span></label>
        </div>
      </form>
    `;
  });

  it("ticks exactly the remembered set for a known combination, leaving agent logins alone", () => {
    const p = page();
    repoCheckbox("org/b").checked = true;
    p.onMultiRepoChange();
    repoCheckbox("org/a").checked = true;
    p.onMultiRepoChange();
    expect(capCheckbox("home-assistant").checked).toBe(true);
    expect(capCheckbox("ssh:nas").checked).toBe(false);
    expect(capCheckbox("claude-auth").checked).toBe(true);
  });

  it("never unticks the forced cross-repo box, remembered combination or not (#3372)", () => {
    const p = page();
    repoCheckbox("org/a").checked = true;
    repoCheckbox("org/b").checked = true;
    p.onMultiRepoChange();
    expect(capCheckbox("cross-repo").checked).toBe(true);
    expect(capCheckbox("cross-repo").disabled).toBe(true);

    repoCheckbox("org/c").checked = true;
    p.onMultiRepoChange();
    expect(capCheckbox("cross-repo").checked).toBe(true);
    expect(capCheckbox("cross-repo").disabled).toBe(true);
  });

  it("does not re-apply when a toggle leaves the combination unchanged", () => {
    const p = page();
    repoCheckbox("org/a").checked = true;
    repoCheckbox("org/b").checked = true;
    p.onMultiRepoChange();
    capCheckbox("home-assistant").checked = false;
    p.onMultiRepoChange();
    expect(capCheckbox("home-assistant").checked).toBe(false);
  });

  it("leaves the boxes alone for a combination with no remembered entry", () => {
    const p = page();
    repoCheckbox("org/a").checked = true;
    repoCheckbox("org/c").checked = true;
    p.onMultiRepoChange();
    expect(capCheckbox("home-assistant").checked).toBe(false);
    expect(capCheckbox("ssh:nas").checked).toBe(true);
  });

  it("resets to the fallback when leaving a remembered combination for one with no entry", () => {
    const p = page();
    repoCheckbox("org/a").checked = true;
    repoCheckbox("org/b").checked = true;
    p.onMultiRepoChange();
    expect(capCheckbox("home-assistant").checked).toBe(true);

    // org/a+org/b+org/c has never been launched before; the grant remembered
    // for org/a+org/b must not carry over onto it (#3339 review comment 1).
    repoCheckbox("org/c").checked = true;
    p.onMultiRepoChange();
    expect(capCheckbox("home-assistant").checked).toBe(false);
    expect(capCheckbox("ssh:nas").checked).toBe(false);
    expect(capCheckbox("claude-auth").checked).toBe(true);
  });
});

describe("onMultiRepoChange auto-grant boxes (#3372)", () => {
  function autoCheckbox(id: string): HTMLInputElement {
    return document.querySelector(`#multi-cap-list label[data-cap="${id}"] input[type="checkbox"]`) as HTMLInputElement;
  }
  function autoNote(id: string): string {
    return (document.querySelector(`#multi-cap-list label[data-cap="${id}"] .cap-auto-note`) as HTMLElement).textContent || "";
  }

  beforeEach(() => {
    document.body.innerHTML = `
      <form>
        <input type="checkbox" name="repo" value="org/gh">
        <input type="checkbox" name="repo" value="org/forgejo-repo">
        <fieldset id="multi-cap-list">
          <label data-cap="cross-repo" data-cap-auto-repos="*">
            <input type="checkbox"><span class="cap-auto-note"></span>
          </label>
          <label data-cap="forgejo" data-cap-auto-repos='["org/forgejo-repo"]'>
            <input type="checkbox"><span class="cap-auto-note"></span>
          </label>
        </fieldset>
      </form>
    `;
  });

  it("forces cross-repo checked and disabled from the start, unconditionally", () => {
    page().onMultiRepoChange();
    expect(autoCheckbox("cross-repo").checked).toBe(true);
    expect(autoCheckbox("cross-repo").disabled).toBe(true);
    expect(autoNote("cross-repo")).toBe("always granted");
  });

  it("forces forgejo once a Forgejo-hosted repo is ticked, and releases it once unticked", () => {
    const p = page();
    repoCheckbox("org/gh").checked = true;
    p.onMultiRepoChange();
    expect(autoCheckbox("forgejo").checked).toBe(false);
    expect(autoCheckbox("forgejo").disabled).toBe(false);
    expect(autoNote("forgejo")).toBe("");

    repoCheckbox("org/forgejo-repo").checked = true;
    p.onMultiRepoChange();
    expect(autoCheckbox("forgejo").checked).toBe(true);
    expect(autoCheckbox("forgejo").disabled).toBe(true);
    expect(autoNote("forgejo")).toBe("auto: Forgejo-hosted repo");

    repoCheckbox("org/forgejo-repo").checked = false;
    p.onMultiRepoChange();
    expect(autoCheckbox("forgejo").checked).toBe(false);
    expect(autoCheckbox("forgejo").disabled).toBe(false);
    expect(autoNote("forgejo")).toBe("");
  });
});

describe("onRepoChange cap-group visibility (#3138)", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <fieldset id="session-repo">
        <input type="radio" name="repo" value="" checked>
        <input type="radio" name="repo" value="org/a">
        <input type="radio" name="repo" value="org/b">
        <input type="radio" name="repo" value="org/s">
      </fieldset>
      <select id="session-mode">
        <option value="repo-zsh">zsh in repo</option>
        <option value="repo-claude">Agent in repo (plain)</option>
        <option value="worktree-claude">Agent in new worktree</option>
        <option value="home-claude">Agent (home directory)</option>
      </select>
      <div id="single-cap-list">
        <div data-cap-group="infra">
          <span class="cap-group-title">Infrastructure</span>
          <label data-cap="home-assistant" data-cap-repos='["org/a"]'><input type="checkbox"></label>
        </div>
        <div data-cap-group="ssh">
          <span class="cap-group-title">SSH hosts</span>
          <label data-cap="ssh:nas" data-cap-repos='["org/b"]'><input type="checkbox"></label>
          <label data-cap="ssh:prod-data" data-cap-repos="[]" data-cap-suggest-repos='["org/s"]'><input type="checkbox"></label>
        </div>
        <div data-cap-group="forge">
          <span class="cap-group-title">Forge access</span>
          <label data-cap="cross-repo" data-cap-repos="[]" data-cap-auto-repos="*"><input type="checkbox"><span class="cap-auto-note"></span></label>
          <label data-cap="forgejo" data-cap-repos="[]" data-cap-auto-repos='["org/b","org/d"]'><input type="checkbox"><span class="cap-auto-note"></span></label>
        </div>
      </div>
      <div id="single-cap-empty" style="display:none;"></div>
      <input type="checkbox" id="cap-show-all">
    `;
  });

  function group(groupId: string): HTMLElement {
    return document.querySelector(`div[data-cap-group="${groupId}"]`) as HTMLElement;
  }

  function autoCheckbox(id: string): HTMLInputElement {
    return document.querySelector(`#single-cap-list label[data-cap="${id}"] input[type="checkbox"]`) as HTMLInputElement;
  }
  function autoNote(id: string): string {
    return (document.querySelector(`#single-cap-list label[data-cap="${id}"] .cap-auto-note`) as HTMLElement).textContent || "";
  }

  it("hides a group whose only capability is not relevant to the selected repo", () => {
    selectRepo("org/a");
    page().onRepoChange();
    expect(group("infra").style.display).not.toBe("none");
    expect(group("ssh").style.display).toBe("none");
  });

  it("shows a suggested capability unticked for its repo and hides it elsewhere", () => {
    const label = () => document.querySelector('#single-cap-list label[data-cap="ssh:prod-data"]') as HTMLElement;
    selectRepo("org/s");
    page().onRepoChange();
    expect(label().style.display).toBe("inline-flex");
    expect(autoCheckbox("ssh:prod-data").checked).toBe(false);
    selectRepo("org/a");
    page().onRepoChange();
    expect(label().style.display).toBe("none");
    (document.getElementById("cap-show-all") as HTMLInputElement).checked = true;
    page().onRepoChange();
    expect(label().style.display).toBe("inline-flex");
  });

  it("shows a group again once its capability becomes relevant", () => {
    selectRepo("org/b");
    page().onRepoChange();
    expect(group("infra").style.display).toBe("none");
    expect(group("ssh").style.display).not.toBe("none");
  });

  it("shows every group when Show all capabilities is ticked", () => {
    (document.getElementById("cap-show-all") as HTMLInputElement).checked = true;
    selectRepo("org/a");
    page().onRepoChange();
    expect(group("infra").style.display).not.toBe("none");
    expect(group("ssh").style.display).not.toBe("none");
  });

  describe("auto-grant boxes (#3372)", () => {
    it("keeps a * box (cross-repo) checked and disabled regardless of the selected repo", () => {
      selectRepo("org/a");
      page().onRepoChange();
      expect(autoCheckbox("cross-repo").checked).toBe(true);
      expect(autoCheckbox("cross-repo").disabled).toBe(true);
      expect(autoNote("cross-repo")).toBe("always granted");
    });

    it("forces forgejo when switching to its Forgejo-hosted repo, and releases it when switching to a GitHub one", () => {
      const p = page();
      selectRepo("org/b");
      p.onRepoChange();
      expect(autoCheckbox("forgejo").checked).toBe(true);
      expect(autoCheckbox("forgejo").disabled).toBe(true);
      expect(autoNote("forgejo")).toBe("auto: Forgejo-hosted repo");

      selectRepo("org/a");
      p.onRepoChange();
      expect(autoCheckbox("forgejo").checked).toBe(false);
      expect(autoCheckbox("forgejo").disabled).toBe(false);
      expect(autoNote("forgejo")).toBe("");
    });

    it("does not untick a forced box in the defaults-reset pass that runs on every repo change", () => {
      const p = page();
      selectRepo("org/b");
      p.onRepoChange();
      expect(autoCheckbox("cross-repo").checked).toBe(true);
      // A second onRepoChange call for the same repo re-runs the whole
      // function, including the defaults-reset branch keyed on capDefaultsRepo.
      p.onRepoChange();
      expect(autoCheckbox("cross-repo").checked).toBe(true);
      expect(autoCheckbox("forgejo").checked).toBe(true);
    });

    it("still shows the no-repo-specific-capabilities message when only forced auto-grant boxes are visible", () => {
      const opt = document.createElement("input");
      opt.type = "radio";
      opt.name = "repo";
      opt.value = "org/c";
      document.getElementById("session-repo")!.appendChild(opt);
      selectRepo("org/c");
      page().onRepoChange();
      // cross-repo is always forced, but org/c has no repo-specific capability.
      expect(autoCheckbox("cross-repo").checked).toBe(true);
      expect((document.getElementById("single-cap-empty") as HTMLElement).style.display).toBe("block");
    });

    it("hides the no-repo-specific-capabilities message when forgejo is the only repo-specific grant", () => {
      const opt = document.createElement("input");
      opt.type = "radio";
      opt.name = "repo";
      opt.value = "org/d";
      document.getElementById("session-repo")!.appendChild(opt);
      selectRepo("org/d");
      page().onRepoChange();
      // org/d is Forgejo-hosted (forces forgejo) but has no other repo-specific
      // capability configured; forgejo itself must count as repo-specific.
      expect(autoCheckbox("forgejo").checked).toBe(true);
      expect((document.getElementById("single-cap-empty") as HTMLElement).style.display).toBe("none");
    });
  });
});

describe("Initial prompt in zsh mode (#clw_01M4ZBH4EE9PMG9MXP3KY904SP)", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form>
        <select id="session-mode"><option value="repo-zsh">zsh</option><option value="repo-claude" selected>agent</option></select>
        <label data-agentless="false"><select id="session-provider"><option value="claude">Claude</option></select></label>
        <label data-agentless="false"><textarea id="session-initial-prompt"></textarea></label>
      </form>
    `;
  });

  function onModeChange(): void {
    (window as unknown as { sessionsListPage: () => { onModeChange(): void } }).sessionsListPage().onModeChange();
  }

  it("disables and greys out the field for zsh, and restores it for an agent mode", () => {
    const mode = document.getElementById("session-mode") as HTMLSelectElement;
    const prompt = document.getElementById("session-initial-prompt") as HTMLTextAreaElement;
    mode.value = "repo-zsh";
    onModeChange();
    expect(prompt.disabled).toBe(true);
    expect(prompt.closest("label")!.getAttribute("data-agentless")).toBe("true");
    mode.value = "repo-claude";
    onModeChange();
    expect(prompt.disabled).toBe(false);
    expect(prompt.closest("label")!.getAttribute("data-agentless")).toBe("false");
  });
});

describe("sessions list refresh (#clw_01M52FEC8QSM9P57WWSEBYFB7D)", () => {
  interface RefreshPage {
    refreshSessions(): Promise<void>;
    killSession(id: string): Promise<void>;
    deleteSession(id: string): Promise<void>;
  }
  const refreshPage = () => (window as unknown as { sessionsListPage: () => RefreshPage }).sessionsListPage();
  const row = (id: string, status: string) => `<tr data-session-id="${id}" data-status="${status}"><td>${id}</td></tr>`;
  const table = (id: string, rows: string) => `<div class="table-scroll"><table id="${id}"><tbody>${rows}</tbody></table></div>`;
  const fetchMock = vi.fn();

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="active-sessions">${table("active-sessions-table", row("aa11", "running"))}</div>
      <h2>All Sessions</h2>
      ${table("all-sessions-table", row("aa11", "running") + row("bb22", "ended"))}
      <p id="session-filter-empty" style="display:none"></p>`;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("alert", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const tablesReply = (body: { signature: string; active: string; all: string }) =>
    ({ ok: true, json: async () => body }) as unknown as Response;
  const endedReply = () => tablesReply({
    signature: "aa11:ended,bb22:ended",
    active: "<p>No active sessions.</p>",
    all: table("all-sessions-table", row("aa11", "ended") + row("bb22", "ended")),
  });

  it("swaps in the new tables when a session's status changed", async () => {
    fetchMock.mockResolvedValueOnce(endedReply());
    await refreshPage().refreshSessions();
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/table");
    expect(document.getElementById("active-sessions")!.innerHTML).toBe("<p>No active sessions.</p>");
    const rows = document.querySelectorAll("#all-sessions-table tbody tr");
    expect(Array.from(rows).map((r) => r.getAttribute("data-status"))).toEqual(["ended", "ended"]);
    // The wrapper is replaced, not nested.
    expect(document.querySelectorAll(".table-scroll .table-scroll")).toHaveLength(0);
  });

  it("leaves the DOM alone when nothing changed", async () => {
    const activeBefore = document.getElementById("active-sessions-table");
    const allBefore = document.getElementById("all-sessions-table");
    fetchMock.mockResolvedValueOnce(tablesReply({ signature: "aa11:running,bb22:ended", active: "x", all: "y" }));
    await refreshPage().refreshSessions();
    expect(document.getElementById("active-sessions-table")).toBe(activeBefore);
    expect(document.getElementById("all-sessions-table")).toBe(allBefore);
  });

  it("updates the Sessions nav badge, even when the tables are unchanged", async () => {
    document.body.insertAdjacentHTML("afterbegin", '<nav><a href="/sessions">Sessions<span class="nav-count">3</span></a></nav>');
    const reply = (text: string) => tablesReply({
      signature: "aa11:running,bb22:ended", active: "x", all: "y", nav: [{ href: "/sessions", text, name: "Sessions, " + text + " active" }],
    } as never);
    fetchMock.mockResolvedValueOnce(reply("1"));
    await refreshPage().refreshSessions();
    const link = document.querySelector('nav a[href="/sessions"]')!;
    expect(link.querySelector(".nav-count")!.textContent).toBe("1");
    expect(link.getAttribute("aria-label")).toBe("Sessions, 1 active");
    fetchMock.mockResolvedValueOnce(reply(""));
    await refreshPage().refreshSessions();
    expect(link.querySelector(".nav-count")).toBeNull();
    expect(link.hasAttribute("aria-label")).toBe(false);
  });

  it("refreshes the tables in place after a successful End", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => "" } as Response);
    fetchMock.mockResolvedValueOnce(endedReply());
    await refreshPage().killSession("aa11");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/sessions/aa11/kill", { method: "POST" });
    expect(document.getElementById("active-sessions-table")).toBeNull();
    expect(alert).not.toHaveBeenCalled();
  });

  it("keeps the row and reports the error when End fails", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => "session is being reconciled" } as Response);
    await refreshPage().killSession("aa11");
    expect(alert).toHaveBeenCalledWith("Failed to end session: session is being reconciled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#active-sessions-table tr[data-session-id="aa11"]')).not.toBeNull();
  });

  it("reports a failed Delete", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => "nope" } as Response);
    await refreshPage().deleteSession("bb22");
    expect(alert).toHaveBeenCalledWith("Failed to delete session: nope");
  });
});

describe("bindActiveSessionClicks", () => {
  const page = () => (window as unknown as { sessionsListPage: () => { bindActiveSessionClicks(): void } }).sessionsListPage();
  const rowHtml = (id: string) => `<tr data-session-id="${id}"><td class="cell-title"><a class="session-title-link" href="/sessions/${id}">repo</a></td><td class="cell-summary">sum</td><td><details><summary>more</summary></details><button>End</button></td></tr>`;
  let linkClicks: string[];

  const wire = () => {
    linkClicks = [];
    document.body.innerHTML = `<div id="active-sessions"><table><tbody>${rowHtml("aa11")}</tbody></table></div>`;
    page().bindActiveSessionClicks();
    watchLinks();
  };
  const watchLinks = () => {
    document.querySelectorAll("a.session-title-link").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); linkClicks.push((a as HTMLAnchorElement).getAttribute("href")!); }));
  };

  it("opens the session when the card body is clicked", () => {
    wire();
    (document.querySelector(".cell-summary") as HTMLElement).click();
    expect(linkClicks).toEqual(["/sessions/aa11"]);
  });

  it("ignores buttons, summaries and modified clicks", () => {
    wire();
    (document.querySelector("button") as HTMLElement).click();
    (document.querySelector("summary") as HTMLElement).click();
    document.querySelector(".cell-summary")!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    expect(linkClicks).toEqual([]);
  });

  it("handles rows inserted after a refresh", () => {
    wire();
    document.getElementById("active-sessions")!.innerHTML = `<table><tbody>${rowHtml("bb22")}</tbody></table>`;
    watchLinks();
    (document.querySelector(".cell-summary") as HTMLElement).click();
    expect(linkClicks).toEqual(["/sessions/bb22"]);
  });
});

describe("Initial prompt attachments", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    document.body.innerHTML = `
      <form method="POST" action="/sessions/create" data-attach-dropzone>
        <select id="session-mode"><option value="repo-zsh">zsh</option><option value="repo-claude" selected>agent</option></select>
        <label data-agentless="false"><select id="session-provider"><option value="claude">Claude</option></select></label>
        <label class="form-field initial-prompt-field" data-agentless="false">
          <textarea id="session-initial-prompt" name="initialPrompt"></textarea>
          <span class="session-attach" data-attach-row hidden>
            <span class="session-attach-controls">
              <button type="button" data-attach-btn>Attach files</button>
              <input type="file" multiple hidden data-attach-input>
              <span role="status" data-attach-status></span>
            </span>
            <span role="list" data-attach-list></span>
            <span data-attach-inputs></span>
          </span>
        </label>
        <button type="submit">Create Session</button>
        <div data-attach-overlay></div>
      </form>
    `;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // Re-run the module so its load-time setup binds this form.
    vi.resetModules();
    await import("./sessions-list.js");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const form = () => document.querySelector("form") as HTMLFormElement;
  const submit = () => document.querySelector('button[type="submit"]') as HTMLButtonElement;
  const status = () => document.querySelector("[data-attach-status]") as HTMLElement;
  const ids = () => Array.from(document.querySelectorAll('input[name="attachment"]')).map((i) => (i as HTMLInputElement).value);

  function pick(files: File[]): void {
    const input = document.querySelector("[data-attach-input]") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change"));
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("reveals the control, stages a picked file and adds a chip and a hidden attachment input", async () => {
    expect((document.querySelector("[data-attach-row]") as HTMLElement).hidden).toBe(false);
    let finish!: (res: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    pick([new File(["PIXELS"], "board.png", { type: "image/png" })]);
    // Create waits for the upload.
    expect(submit().disabled).toBe(true);
    expect(status().textContent).toContain("Uploading 1 file");
    finish(new Response(JSON.stringify({ attachment: { id: "sat_1", name: "board.png", size: 6 } })));
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/sessions/attachments", expect.objectContaining({ method: "POST" }));
    expect(ids()).toEqual(["sat_1"]);
    expect(document.querySelector(".session-attachment-name")!.textContent).toBe("board.png");
    expect(submit().disabled).toBe(false);
  });

  it("shows a rejected file on the form and blocks Create until it is dismissed", async () => {
    pick([new File([], "empty.txt")]);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(status().textContent).toContain("empty.txt: empty file or folder — not uploaded");
    expect(submit().disabled).toBe(true);
    const ev = new Event("submit", { cancelable: true });
    form().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "File too large (max 10 MB)" }), { status: 413 }));
    pick([new File(["x"], "big.bin")]);
    await settle();
    expect(status().textContent).toContain("big.bin: File too large (max 10 MB)");

    (status().querySelector("button") as HTMLButtonElement).click();
    expect(status().textContent).toBe("");
    expect(submit().disabled).toBe(false);
    expect(ids()).toEqual([]);
  });

  it("removes a chip, its input and the staged file", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ attachment: { id: "sat_2", name: "a.log", size: 1 } })));
    pick([new File(["x"], "a.log")]);
    await settle();
    fetchMock.mockResolvedValueOnce(new Response("{}"));
    (document.querySelector(".session-attachment button") as HTMLButtonElement).click();
    expect(ids()).toEqual([]);
    expect(document.querySelector(".session-attachment")).toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith("/sessions/attachments/sat_2/delete", { method: "POST" });
  });

  it("disables the control and the staged ids in zsh mode, and ignores drops", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ attachment: { id: "sat_3", name: "a.log", size: 1 } })));
    pick([new File(["x"], "a.log")]);
    await settle();
    const mode = document.getElementById("session-mode") as HTMLSelectElement;
    mode.value = "repo-zsh";
    (window as unknown as { sessionsListPage: () => { onModeChange(): void } }).sessionsListPage().onModeChange();
    expect((document.querySelector("[data-attach-btn]") as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('input[name="attachment"]') as HTMLInputElement).disabled).toBe(true);
    fetchMock.mockClear();
    pick([new File(["y"], "b.log")]);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    mode.value = "repo-claude";
    (window as unknown as { sessionsListPage: () => { onModeChange(): void } }).sessionsListPage().onModeChange();
    expect((document.querySelector('input[name="attachment"]') as HTMLInputElement).disabled).toBe(false);
  });
});
