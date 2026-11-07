// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./sessions-list.js";

interface OnRepoChangePage {
  onRepoChange(): void;
  onCapChange(ev: Event): void;
}

function page(): OnRepoChangePage {
  return (window as unknown as { sessionsListPage: () => OnRepoChangePage }).sessionsListPage();
}

/** Tick exactly `values` in the repo picker (none: a home-directory session). */
function tickRepos(...values: string[]): void {
  for (const box of Array.from(document.querySelectorAll('#session-repo input[name="repo"]'))) {
    (box as HTMLInputElement).checked = values.includes((box as HTMLInputElement).value);
  }
}

function selectRepo(value: string): void {
  tickRepos(value);
}

describe("onRepoChange with zero, one or several repos (#clw_01M666M9EQFJWAKHSFFYE5MR8W)", () => {
  function capCheckbox(id: string): HTMLInputElement {
    return document.querySelector(`#single-cap-list label[data-cap="${id}"] input[type="checkbox"]`) as HTMLInputElement;
  }
  function capLabel(id: string): HTMLElement {
    return document.querySelector(`#single-cap-list label[data-cap="${id}"]`) as HTMLElement;
  }
  function option(selectId: string, value: string): HTMLOptionElement {
    return document.querySelector(`#${selectId} option[value="${value}"]`) as HTMLOptionElement;
  }
  const mode = () => document.getElementById("session-mode") as HTMLSelectElement;
  const provider = () => document.getElementById("session-provider") as HTMLSelectElement;

  beforeEach(() => {
    const defaults = JSON.stringify({ "org/a\norg/b": ["home-assistant"] }).replace(/"/g, "&quot;");
    document.body.innerHTML = `
      <form>
        <fieldset id="session-repo">
          <input type="checkbox" name="repo" value="org/a">
          <input type="checkbox" name="repo" value="org/b">
          <input type="checkbox" name="repo" value="org/c">
        </fieldset>
        <select id="session-mode">
          <option value="repo-zsh">zsh in repo</option>
          <option value="repo-claude">Agent in repo (plain)</option>
          <option value="worktree-claude">Agent in new worktree</option>
          <option value="home-claude" selected>Agent (home directory)</option>
        </select>
        <label data-agentless="false"><select id="session-provider" data-multi-default-provider="codex">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
          <option value="pi">Pi</option>
        </select></label>
        <div id="single-cap-list" data-cap-defaults="${defaults}">
          <label data-cap="claude-auth" data-cap-repos="[]" data-cap-provider="claude"><input type="checkbox"></label>
          <label data-cap="codex-auth" data-cap-repos="[]" data-cap-provider="codex"><input type="checkbox"></label>
          <label data-cap="home-assistant" data-cap-repos='["org/a"]'><input type="checkbox" name="capability"></label>
          <label data-cap="ssh:nas" data-cap-repos='["org/c"]'><input type="checkbox"></label>
          <label data-cap="cross-repo" data-cap-repos="[]" data-cap-auto-repos="*"><input type="checkbox"><span class="cap-auto-note"></span></label>
          <label data-cap="forgejo" data-cap-repos="[]" data-cap-auto-repos='["org/b"]'><input type="checkbox"><span class="cap-auto-note"></span></label>
        </div>
      </form>
    `;
  });

  it("with no repo ticked offers only home-directory modes and pre-ticks no repo grant", () => {
    page().onRepoChange();
    expect(option("session-mode", "worktree-claude").disabled).toBe(true);
    expect(option("session-mode", "repo-claude").disabled).toBe(true);
    expect(option("session-mode", "home-claude").disabled).toBe(false);
    expect(option("session-mode", "repo-zsh").text).toBe("zsh (home directory)");
    expect(mode().value).toBe("home-claude");
    expect(capCheckbox("home-assistant").checked).toBe(false);
    expect(capCheckbox("cross-repo").checked).toBe(true);
    expect(capCheckbox("forgejo").disabled).toBe(false);
  });

  it("with one repo ticked switches to a worktree session and pre-ticks that repo's defaults", () => {
    tickRepos("org/a");
    page().onRepoChange();
    expect(mode().value).toBe("worktree-claude");
    expect(option("session-mode", "home-claude").disabled).toBe(true);
    expect(option("session-mode", "repo-zsh").disabled).toBe(false);
    expect(option("session-mode", "repo-claude").disabled).toBe(false);
    expect(capCheckbox("home-assistant").checked).toBe(true);
    expect(capLabel("ssh:nas").style.display).not.toBe("none");
  });

  it("with several repos ticked offers only Agent in new worktree and only agents that attach extra directories", () => {
    const p = page();
    tickRepos("org/a");
    p.onRepoChange();
    mode().value = "repo-zsh";
    provider().value = "pi";
    tickRepos("org/a", "org/c");
    p.onRepoChange();
    for (const v of ["repo-zsh", "repo-claude", "home-claude"]) expect(option("session-mode", v).disabled).toBe(true);
    expect(option("session-mode", "worktree-claude").disabled).toBe(false);
    expect(mode().value).toBe("worktree-claude");
    expect(option("session-provider", "opencode").disabled).toBe(true);
    expect(option("session-provider", "pi").disabled).toBe(true);
    expect(option("session-provider", "codex").disabled).toBe(false);
    // A refused agent falls back to the several-repo default, and its login follows.
    expect(provider().value).toBe("codex");
    expect(capCheckbox("codex-auth").checked).toBe(true);
    expect(capCheckbox("claude-auth").checked).toBe(false);
    // Every capability is listed, with no repo to filter by.
    expect(capLabel("ssh:nas").style.display).not.toBe("none");

    tickRepos("org/a");
    p.onRepoChange();
    expect(option("session-provider", "pi").disabled).toBe(false);
    expect(option("session-mode", "repo-zsh").disabled).toBe(false);
  });

  it("ticks exactly the remembered set for a known combination, leaving agent logins alone", () => {
    const p = page();
    capCheckbox("claude-auth").checked = true;
    tickRepos("org/b");
    p.onRepoChange();
    tickRepos("org/a", "org/b");
    p.onRepoChange();
    expect(capCheckbox("home-assistant").checked).toBe(true);
    expect(capCheckbox("ssh:nas").checked).toBe(false);
    expect(capCheckbox("claude-auth").checked).toBe(true);
  });

  it("starts a combination never used before without the repo grants of the set it replaced", () => {
    const p = page();
    tickRepos("org/a");
    p.onRepoChange();
    expect(capCheckbox("home-assistant").checked).toBe(true);
    tickRepos("org/a", "org/c");
    p.onRepoChange();
    expect(capCheckbox("home-assistant").checked).toBe(false);
    expect(capCheckbox("ssh:nas").checked).toBe(false);
  });

  it("resets to no repo grants when leaving a remembered combination for one with no entry", () => {
    const p = page();
    tickRepos("org/a", "org/b");
    p.onRepoChange();
    expect(capCheckbox("home-assistant").checked).toBe(true);
    // org/a+org/b+org/c has never been launched before; the grant remembered
    // for org/a+org/b must not carry over onto it (#3339 review comment 1).
    tickRepos("org/a", "org/b", "org/c");
    p.onRepoChange();
    expect(capCheckbox("home-assistant").checked).toBe(false);
  });

  it("keeps the operator's ticks moving between combinations with no remembered entry", () => {
    const p = page();
    tickRepos("org/a", "org/c");
    p.onRepoChange();
    capCheckbox("ssh:nas").checked = true;
    tickRepos("org/a", "org/b", "org/c");
    p.onRepoChange();
    expect(capCheckbox("ssh:nas").checked).toBe(true);
  });

  it("does not re-apply when a toggle leaves the repo set unchanged", () => {
    const p = page();
    tickRepos("org/a", "org/b");
    p.onRepoChange();
    capCheckbox("home-assistant").checked = false;
    p.onRepoChange();
    expect(capCheckbox("home-assistant").checked).toBe(false);
  });

  it("forces the auto-grants of every ticked repo and never unticks cross-repo (#3372)", () => {
    const p = page();
    tickRepos("org/a", "org/c");
    p.onRepoChange();
    expect(capCheckbox("forgejo").checked).toBe(false);
    expect(capCheckbox("forgejo").disabled).toBe(false);
    tickRepos("org/a", "org/b", "org/c");
    p.onRepoChange();
    expect(capCheckbox("forgejo").checked).toBe(true);
    expect(capCheckbox("forgejo").disabled).toBe(true);
    expect(capCheckbox("cross-repo").checked).toBe(true);
    expect(capCheckbox("cross-repo").disabled).toBe(true);
    tickRepos("org/a", "org/c");
    p.onRepoChange();
    expect(capCheckbox("forgejo").checked).toBe(false);
    expect(capCheckbox("forgejo").disabled).toBe(false);
  });
});

describe("onRepoChange cap-group visibility (#3138)", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <fieldset id="session-repo">
        <input type="checkbox" name="repo" value="org/a">
        <input type="checkbox" name="repo" value="org/b">
        <input type="checkbox" name="repo" value="org/s">
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
          <label data-cap="home-assistant" data-cap-repos='["org/a"]'><input type="checkbox" name="capability"></label>
        </div>
        <div data-cap-group="ssh">
          <span class="cap-group-title">SSH hosts</span>
          <label data-cap="ssh:nas" data-cap-repos='["org/b"]'><input type="checkbox"></label>
          <label data-cap="ssh:prod-data" data-cap-repos="[]"><input type="checkbox"></label>
        </div>
        <div data-cap-group="forge">
          <span class="cap-group-title">Forge access</span>
          <label data-cap="cross-repo" data-cap-repos="[]" data-cap-auto-repos="*"><input type="checkbox"><span class="cap-auto-note"></span></label>
          <label data-cap="forgejo" data-cap-repos="[]" data-cap-auto-repos='["org/b","org/d"]'><input type="checkbox"><span class="cap-auto-note"></span></label>
        </div>
      </div>
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

  it("never hides a capability or group, whatever the repo selection", () => {
    const anyHidden = () => Array.from(document.querySelectorAll<HTMLElement>("#single-cap-list label, #single-cap-list div[data-cap-group]")).some((el) => el.style.display === "none");
    page().onRepoChange();
    expect(anyHidden()).toBe(false);
    selectRepo("org/a");
    page().onRepoChange();
    expect(anyHidden()).toBe(false);
    selectRepo("org/b");
    page().onRepoChange();
    expect(anyHidden()).toBe(false);
  });

  it("keeps an operator-ticked capability ticked across a repo change, but resets a programmatic tick", () => {
    const p = page();
    p.onRepoChange();
    const ha = autoCheckbox("home-assistant");
    ha.checked = true;
    ha.dispatchEvent(new Event("change", { bubbles: true }));
    p.onCapChange({ target: ha } as unknown as Event);
    selectRepo("org/b");
    p.onRepoChange();
    expect(ha.checked).toBe(true);
    // A programmatic tick (no onCapChange) is reset by the next defaults pass.
    const nas = autoCheckbox("ssh:nas");
    nas.checked = true;
    selectRepo("org/a");
    p.onRepoChange();
    expect(nas.checked).toBe(false);
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
      // function, including the defaults-reset branch keyed on capDefaultsKey.
      p.onRepoChange();
      expect(autoCheckbox("cross-repo").checked).toBe(true);
      expect(autoCheckbox("forgejo").checked).toBe(true);
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

describe("pending capability requests (#clw_01M6K7717TJFWCHGQC7MAC4SXS)", () => {
  interface CapPage {
    refreshSessions(): Promise<void>;
    decideCapRequest(id: string, cap: string, approve: boolean, ev: Event): Promise<void>;
  }
  const capPage = () => (window as unknown as { sessionsListPage: () => CapPage }).sessionsListPage();
  const block = `<div class="session-cap-request"><strong>Requests Forgejo</strong><span class="session-cap-request-actions"><button id="grant">Grant</button><button id="dismiss">Dismiss</button></span><span class="session-cap-request-error" role="alert"></span></div>`;
  const row = (caps: string | null) => `<tr data-session-id="aa11" data-status="running" data-account="work"${caps ? ` data-pending-caps="${caps}"` : ""}><td>${caps ? block : ""}</td></tr>`;
  const table = (id: string, rows: string) => `<div class="table-scroll"><table id="${id}"><tbody>${rows}</tbody></table></div>`;
  const fetchMock = vi.fn();

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="active-sessions">${table("active-sessions-table", row("forgejo+ssh:ryzen"))}</div>
      ${table("all-sessions-table", row("forgejo+ssh:ryzen"))}`;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const clickEvent = (id: string) => ({ currentTarget: document.getElementById(id) }) as unknown as Event;
  const decidedReply = () => ({
    ok: true,
    json: async () => ({ signature: "aa11:running@work", active: table("active-sessions-table", row(null)), all: table("all-sessions-table", row(null)) }),
  }) as unknown as Response;

  it("reads data-pending-caps into the signature, so an unchanged request leaves the DOM alone", async () => {
    const before = document.getElementById("active-sessions-table");
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ signature: "aa11:running@work?forgejo+ssh:ryzen", active: "x", all: "y" }) } as unknown as Response);
    await capPage().refreshSessions();
    expect(document.getElementById("active-sessions-table")).toBe(before);
  });

  it.each([
    ["approve", true, "grant"],
    ["deny", false, "dismiss"],
  ] as const)("posts to %s and refreshes the tables, removing the block", async (route, approve, button) => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) } as unknown as Response);
    fetchMock.mockResolvedValueOnce(decidedReply());
    await capPage().decideCapRequest("aa11", "forgejo", approve, clickEvent(button));
    expect(fetchMock).toHaveBeenNthCalledWith(1, `/sessions/aa11/capability-requests/forgejo/${route}`, { method: "POST" });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/sessions/table");
    expect(document.querySelector(".session-cap-request")).toBeNull();
  });

  it.each([
    [409, { error: "This request has already been decided" }],
    [404, { error: "No such capability request", code: "no-request" }],
  ])("treats HTTP %i as already decided and refreshes", async (status, body) => {
    fetchMock.mockResolvedValueOnce({ ok: false, status, json: async () => body } as unknown as Response);
    fetchMock.mockResolvedValueOnce(decidedReply());
    await capPage().decideCapRequest("aa11", "forgejo", true, clickEvent("grant"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".session-cap-request")).toBeNull();
  });

  it("shows the error in the row and re-enables the buttons on any other failure", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: "Session not found — it may have ended", code: "session-not-found" }) } as unknown as Response);
    await capPage().decideCapRequest("aa11", "forgejo", true, clickEvent("grant"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector("#active-sessions .session-cap-request-error")!.textContent).toBe("Session not found — it may have ended");
    const grant = document.getElementById("grant") as HTMLButtonElement;
    expect(grant.disabled).toBe(false);
    expect(grant.hasAttribute("aria-busy")).toBe(false);
    expect((document.getElementById("dismiss") as HTMLButtonElement).disabled).toBe(false);
  });

  it("falls back to the HTTP status when the failure has no JSON error", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => { throw new Error("not json"); } } as unknown as Response);
    await capPage().decideCapRequest("aa11", "forgejo", true, clickEvent("grant"));
    expect(document.querySelector("#active-sessions .session-cap-request-error")!.textContent).toBe("Grant failed (HTTP 502)");
  });

  it("disables both buttons while the decision is in flight", async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r; }));
    fetchMock.mockResolvedValueOnce(decidedReply());
    const pending = capPage().decideCapRequest("aa11", "forgejo", true, clickEvent("grant"));
    const grant = document.getElementById("grant") as HTMLButtonElement;
    expect(grant.disabled).toBe(true);
    expect(grant.getAttribute("aria-busy")).toBe("true");
    expect((document.getElementById("dismiss") as HTMLButtonElement).disabled).toBe(true);
    resolve({ ok: true, json: async () => ({}) } as unknown as Response);
    await pending;
  });
});

describe("All Sessions status filter default (#clw_01M6K7717TJFWCHGQC7MAC4SXS)", () => {
  it("starts on Ended and can switch to All", () => {
    document.body.innerHTML = `<div id="session-status-filter"><a data-status="all">All</a><a class="active" data-status="ended">Ended</a></div>
      <table id="all-sessions-table"><tbody><tr data-status="running" data-search="a"></tr><tr data-status="ended" data-search="b"></tr></tbody></table>
      <p id="session-filter-empty"></p>`;
    const p = (window as unknown as { sessionsListPage: () => { sessionStatusFilter: string; applySessionFilters(): void; setSessionFilter(s: string, ev: Event): void } }).sessionsListPage();
    expect(p.sessionStatusFilter).toBe("ended");
    p.applySessionFilters();
    const rows = Array.from(document.querySelectorAll("#all-sessions-table tr")) as HTMLElement[];
    expect(rows.map((r) => r.style.display)).toEqual(["none", ""]);
    p.setSessionFilter("all", { preventDefault() {} } as Event);
    expect(rows.map((r) => r.style.display)).toEqual(["", ""]);
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

describe("inline terminal preview (#clw_01M6K7717TJFWCHGQC7MAC4SXS)", () => {
  interface PreviewPage {
    togglePreview(id: string, ev: Event): Promise<void>;
    refreshSessions(): Promise<void>;
    bindActiveSessionClicks(): void;
  }
  const previewPage = () => (window as unknown as { sessionsListPage: () => PreviewPage }).sessionsListPage();
  const row = (id: string) => `<tr data-session-id="${id}" data-status="running"><td class="cell-expand"><button class="session-preview-toggle" aria-expanded="false">&gt;</button></td><td class="cell-title"><a class="session-title-link" href="/sessions/${id}">repo</a></td><td>agent</td></tr>`;
  const activeTable = (rows: string) => `<div class="table-scroll"><table id="active-sessions-table"><tbody>${rows}</tbody></table></div>`;
  const fetchMock = vi.fn();
  const terminals: Array<{ opts: Record<string, unknown>; writes: string[]; resets: number; disposed: boolean; options: { theme: unknown }; element: HTMLElement }> = [];

  class FakeTerminal {
    options: { theme: unknown };
    element: HTMLElement;
    record: (typeof terminals)[number];
    constructor(opts: Record<string, unknown>) {
      this.options = { theme: opts.theme };
      this.element = document.createElement("div");
      this.record = { opts, writes: [], resets: 0, disposed: false, options: this.options, element: this.element };
      terminals.push(this.record);
    }
    open(el: HTMLElement) { el.appendChild(this.element); }
    reset() { this.record.resets++; }
    write(data: string) { this.record.writes.push(data); }
    resize() {}
    dispose() { this.record.disposed = true; }
  }

  const screenReply = (data: string, cols = 100, rows = 40) =>
    ({ ok: true, status: 200, json: async () => ({ cols, rows, data }) }) as unknown as Response;
  const toggle = (id: string) => previewPage().togglePreview(id, new Event("click"));
  const toggleBtn = (id: string) => document.querySelector(`tr[data-session-id="${id}"] .session-preview-toggle`)!;

  beforeEach(() => {
    vi.useFakeTimers();
    terminals.length = 0;
    document.documentElement.setAttribute("data-theme", "dark");
    vi.stubGlobal("matchMedia", vi.fn((q: string) => ({ matches: q === "(min-width: 1024px)", addEventListener: vi.fn() })));
    document.body.innerHTML = `<div id="active-sessions" data-xterm-js="https://cdn.example/xterm.js" data-xterm-js-integrity="sha384-x">${activeTable(row("aa11") + row("bb22"))}</div>`;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Terminal", FakeTerminal);
  });

  afterEach(async () => {
    // Collapse anything a test left open, so module state does not leak.
    for (const id of ["aa11", "bb22"]) {
      if (document.getElementById("preview-" + id)) await toggle(id);
    }
    document.documentElement.removeAttribute("data-theme");
    // Let the theme observer see the change while matchMedia is still stubbed.
    await Promise.resolve();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("expands a row into a preview row under it, draws the screen read-only, and collapses again", async () => {
    fetchMock.mockResolvedValueOnce(screenReply("hello\r\nworld\r\n"));
    await toggle("aa11");
    const preview = document.getElementById("preview-aa11")!;
    expect(preview).not.toBeNull();
    expect(preview.classList.contains("session-preview-row")).toBe(true);
    expect(document.querySelector('tr[data-session-id="aa11"]')!.nextElementSibling).toBe(preview);
    expect((preview.firstElementChild as HTMLTableCellElement).colSpan).toBe(3);
    expect(toggleBtn("aa11").getAttribute("aria-expanded")).toBe("true");
    expect(fetchMock).toHaveBeenCalledWith("/sessions/aa11/screen");
    expect(terminals).toHaveLength(1);
    expect(terminals[0].opts).toMatchObject({ cols: 100, rows: 24, fontSize: 11, disableStdin: true, cursorBlink: false, scrollback: 200 });
    expect(terminals[0].resets).toBe(1);
    expect(terminals[0].writes).toEqual(["hello\r\nworld\x1b[?25l"]);

    // The next poll redraws only a changed screen.
    fetchMock.mockResolvedValueOnce(screenReply("hello\r\nworld\r\n"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(terminals[0].writes).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(screenReply("next\r\n"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(terminals[0].writes[terminals[0].writes.length - 1]).toBe("next\x1b[?25l");

    await toggle("aa11");
    expect(document.getElementById("preview-aa11")).toBeNull();
    expect(terminals[0].disposed).toBe(true);
    expect(toggleBtn("aa11").getAttribute("aria-expanded")).toBe("false");
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("keeps two rows' previews independent", async () => {
    fetchMock.mockImplementation(async (url: string) => screenReply(url.includes("aa11") ? "A" : "B"));
    await toggle("aa11");
    await toggle("bb22");
    expect(document.getElementById("preview-aa11")).not.toBeNull();
    expect(document.getElementById("preview-bb22")).not.toBeNull();
    await toggle("aa11");
    expect(document.getElementById("preview-aa11")).toBeNull();
    expect(document.getElementById("preview-bb22")).not.toBeNull();
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/sessions/bb22/screen"]);
  });

  it("explains an unsupported (older) session and stops polling", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: "x", code: "unsupported" }) } as unknown as Response);
    await toggle("aa11");
    const preview = document.getElementById("preview-aa11")!;
    expect(preview.querySelector(".session-preview-status")!.textContent).toBe("Preview unavailable for sessions started before this update");
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through a 503 and collapses once the session is gone", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: "x" }) } as unknown as Response);
    await toggle("aa11");
    expect(document.querySelector("#preview-aa11 .session-preview-status")!.textContent).toBe("Session runtime unavailable, retrying");
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: "Session not found" }) } as unknown as Response);
    await vi.advanceTimersByTimeAsync(2000);
    expect(document.getElementById("preview-aa11")).toBeNull();
  });

  it("says when the terminal library cannot load", async () => {
    vi.stubGlobal("Terminal", undefined);
    const pending = toggle("aa11");
    const script = document.head.querySelector('script[src="https://cdn.example/xterm.js"]') as HTMLScriptElement;
    expect(script.integrity).toBe("sha384-x");
    expect(script.crossOrigin).toBe("anonymous");
    script.dispatchEvent(new Event("error"));
    await pending;
    expect(document.querySelector("#preview-aa11 .session-preview-status")!.textContent).toBe("Terminal library failed to load");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps an open preview, and its terminal, across a table swap and drops it when the session leaves", async () => {
    fetchMock.mockResolvedValueOnce(screenReply("A"));
    await toggle("aa11");
    const termElement = terminals[0].element;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ signature: "aa11:running,cc33:running", active: activeTable(row("cc33") + row("aa11")), all: "" }) } as unknown as Response);
    await previewPage().refreshSessions();
    const preview = document.getElementById("preview-aa11")!;
    expect(preview).not.toBeNull();
    expect(document.querySelector('tr[data-session-id="aa11"]')!.nextElementSibling).toBe(preview);
    expect(preview.contains(termElement)).toBe(true);
    expect(toggleBtn("aa11").getAttribute("aria-expanded")).toBe("true");
    expect(terminals).toHaveLength(1);

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ signature: "cc33:running", active: activeTable(row("cc33")), all: "" }) } as unknown as Response);
    await previewPage().refreshSessions();
    expect(document.getElementById("preview-aa11")).toBeNull();
    expect(terminals[0].disposed).toBe(true);
  });

  it("follows a theme change in every open preview", async () => {
    fetchMock.mockResolvedValueOnce(screenReply("A"));
    await toggle("aa11");
    const dark = terminals[0].options.theme;
    document.documentElement.setAttribute("data-theme", "light");
    await Promise.resolve();
    expect(terminals[0].options.theme).not.toBe(dark);
    expect((terminals[0].options.theme as { background: string }).background).toBe("#faf7f2");
  });

  it("never opens the session from a click on the preview row", async () => {
    fetchMock.mockResolvedValueOnce(screenReply("A"));
    previewPage().bindActiveSessionClicks();
    const clicks: string[] = [];
    document.querySelectorAll("a.session-title-link").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); clicks.push("open"); }));
    await toggle("aa11");
    (document.querySelector("#preview-aa11 .session-preview-wrap") as HTMLElement).click();
    expect(clicks).toEqual([]);
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
