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

function repoCheckbox(value: string): HTMLInputElement {
  return document.querySelector(`input[name="repo"][value="${value}"]`) as HTMLInputElement;
}

function githubAuthCheckbox(): HTMLInputElement {
  return document.querySelector('#multi-cap-list label[data-cap="github-auth"] input[type="checkbox"]') as HTMLInputElement;
}

describe("onMultiRepoChange (#3136)", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form>
        <input type="checkbox" name="repo" value="org/gh">
        <input type="checkbox" name="repo" value="org/gh2">
        <input type="checkbox" name="repo" value="org/forgejo-repo">
        <fieldset id="multi-cap-list">
          <label data-cap="github-auth" data-cap-repos='["org/gh","org/gh2"]'>
            <input type="checkbox">
          </label>
          <label data-cap="home-assistant" data-cap-repos='["org/gh"]'>
            <input type="checkbox">
          </label>
        </fieldset>
      </form>
    `;
  });

  it("ticks github-auth once a GitHub-hosted repo is checked", () => {
    repoCheckbox("org/gh").checked = true;
    page().onMultiRepoChange();
    expect(githubAuthCheckbox().checked).toBe(true);
  });

  it("unticks github-auth once the selection becomes Forgejo-only", () => {
    const p = page();
    repoCheckbox("org/gh").checked = true;
    p.onMultiRepoChange();
    expect(githubAuthCheckbox().checked).toBe(true);

    repoCheckbox("org/gh").checked = false;
    repoCheckbox("org/forgejo-repo").checked = true;
    p.onMultiRepoChange();
    expect(githubAuthCheckbox().checked).toBe(false);
  });

  it("does not re-tick a deliberately unticked github-auth when another already-covered repo toggles", () => {
    const p = page();
    repoCheckbox("org/gh").checked = true;
    p.onMultiRepoChange();
    expect(githubAuthCheckbox().checked).toBe(true);

    // Operator deliberately unticks github-auth themselves.
    githubAuthCheckbox().checked = false;

    // A second GitHub-hosted repo is ticked; the computed value (still "some
    // GitHub-hosted repo is checked") hasn't changed, so the deliberate untick
    // must survive.
    repoCheckbox("org/gh2").checked = true;
    p.onMultiRepoChange();
    expect(githubAuthCheckbox().checked).toBe(false);
  });

  it("never ticks a non-github-auth capability", () => {
    const homeAssistant = document.querySelector(
      '#multi-cap-list label[data-cap="home-assistant"] input[type="checkbox"]',
    ) as HTMLInputElement;
    repoCheckbox("org/gh").checked = true;
    page().onMultiRepoChange();
    expect(homeAssistant.checked).toBe(false);
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
      <select id="session-repo">
        <option value="">Home directory</option>
        <option value="org/a">org/a</option>
        <option value="org/b">org/b</option>
        <option value="org/s">org/s</option>
      </select>
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
    (document.getElementById("session-repo") as HTMLSelectElement).value = "org/a";
    page().onRepoChange();
    expect(group("infra").style.display).not.toBe("none");
    expect(group("ssh").style.display).toBe("none");
  });

  it("shows a suggested capability unticked for its repo and hides it elsewhere", () => {
    const label = () => document.querySelector('#single-cap-list label[data-cap="ssh:prod-data"]') as HTMLElement;
    (document.getElementById("session-repo") as HTMLSelectElement).value = "org/s";
    page().onRepoChange();
    expect(label().style.display).toBe("inline-flex");
    expect(autoCheckbox("ssh:prod-data").checked).toBe(false);
    (document.getElementById("session-repo") as HTMLSelectElement).value = "org/a";
    page().onRepoChange();
    expect(label().style.display).toBe("none");
    (document.getElementById("cap-show-all") as HTMLInputElement).checked = true;
    page().onRepoChange();
    expect(label().style.display).toBe("inline-flex");
  });

  it("shows a group again once its capability becomes relevant", () => {
    (document.getElementById("session-repo") as HTMLSelectElement).value = "org/b";
    page().onRepoChange();
    expect(group("infra").style.display).toBe("none");
    expect(group("ssh").style.display).not.toBe("none");
  });

  it("shows every group when Show all capabilities is ticked", () => {
    (document.getElementById("cap-show-all") as HTMLInputElement).checked = true;
    (document.getElementById("session-repo") as HTMLSelectElement).value = "org/a";
    page().onRepoChange();
    expect(group("infra").style.display).not.toBe("none");
    expect(group("ssh").style.display).not.toBe("none");
  });

  describe("auto-grant boxes (#3372)", () => {
    it("keeps a * box (cross-repo) checked and disabled regardless of the selected repo", () => {
      (document.getElementById("session-repo") as HTMLSelectElement).value = "org/a";
      page().onRepoChange();
      expect(autoCheckbox("cross-repo").checked).toBe(true);
      expect(autoCheckbox("cross-repo").disabled).toBe(true);
      expect(autoNote("cross-repo")).toBe("always granted");
    });

    it("forces forgejo when switching to its Forgejo-hosted repo, and releases it when switching to a GitHub one", () => {
      const p = page();
      (document.getElementById("session-repo") as HTMLSelectElement).value = "org/b";
      p.onRepoChange();
      expect(autoCheckbox("forgejo").checked).toBe(true);
      expect(autoCheckbox("forgejo").disabled).toBe(true);
      expect(autoNote("forgejo")).toBe("auto: Forgejo-hosted repo");

      (document.getElementById("session-repo") as HTMLSelectElement).value = "org/a";
      p.onRepoChange();
      expect(autoCheckbox("forgejo").checked).toBe(false);
      expect(autoCheckbox("forgejo").disabled).toBe(false);
      expect(autoNote("forgejo")).toBe("");
    });

    it("does not untick a forced box in the defaults-reset pass that runs on every repo change", () => {
      const p = page();
      (document.getElementById("session-repo") as HTMLSelectElement).value = "org/b";
      p.onRepoChange();
      expect(autoCheckbox("cross-repo").checked).toBe(true);
      // A second onRepoChange call for the same repo re-runs the whole
      // function, including the defaults-reset branch keyed on capDefaultsRepo.
      p.onRepoChange();
      expect(autoCheckbox("cross-repo").checked).toBe(true);
      expect(autoCheckbox("forgejo").checked).toBe(true);
    });

    it("still shows the no-repo-specific-capabilities message when only forced auto-grant boxes are visible", () => {
      const repoEl = document.getElementById("session-repo") as HTMLSelectElement;
      const opt = document.createElement("option");
      opt.value = "org/c";
      repoEl.appendChild(opt);
      repoEl.value = "org/c";
      page().onRepoChange();
      // cross-repo is always forced, but org/c has no repo-specific capability.
      expect(autoCheckbox("cross-repo").checked).toBe(true);
      expect((document.getElementById("single-cap-empty") as HTMLElement).style.display).toBe("block");
    });

    it("hides the no-repo-specific-capabilities message when forgejo is the only repo-specific grant", () => {
      const repoEl = document.getElementById("session-repo") as HTMLSelectElement;
      const opt = document.createElement("option");
      opt.value = "org/d";
      repoEl.appendChild(opt);
      repoEl.value = "org/d";
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
