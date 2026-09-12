import { describe, it, expect, vi } from "vitest";

vi.mock("./layout.js", () => ({
  PAGE_CSS: "",
  TAILWIND_STYLESHEET: "",
  HEAD_META: "",
  escapeHtml: (s: string) => s,
  htmlOpenTag: () => "<html>",
  buildNav: () => "<!--NAV-->",
  buildPageHeader: (_title: string | null, _theme: string) => "",
  THEME_SCRIPT: "",
  ALPINE_SCRIPT: "",
  repoShortName: (fullName: string) => {
    const slash = fullName.indexOf("/");
    return slash >= 0 ? fullName.slice(slash + 1) : fullName;
  },
  formatRelativeTime: (isoDate: string) => {
    const ms = Date.now() - Date.parse(isoDate);
    if (ms < 0) return "just now";
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  },
}));

vi.mock("../resources/error-handler.generated.js", () => ({
  ERROR_HANDLER_SCRIPT: "",
}));

vi.mock("../resources/auth-watch.generated.js", () => ({
  AUTH_WATCH_SCRIPT: "<!--AUTH-WATCH-->",
}));

vi.mock("../resources/sessions-list.generated.js", () => ({
  SESSIONS_LIST_SCRIPT: "",
}));

vi.mock("../resources/session-terminal.generated.js", () => ({
  SESSION_TERMINAL_SCRIPT: "",
}));

vi.mock("../capabilities.js", () => ({
  availableCapabilities: () => [
    { id: "home-assistant", label: "Home Assistant", description: "d", envKeys: [], resolve: () => ({}) },
    { id: "ssh:proxmox", label: "SSH: proxmox", description: "d", envKeys: [], resolve: () => ({}) },
  ],
  reposForCapability: (id: string) => (id === "home-assistant" ? ["org/ha"] : []),
  defaultCapabilitiesForRepo: (repo: string | null) => (repo === "org/ha" ? ["home-assistant"] : []),
}));

vi.mock("../session-models.js", () => ({
  sessionModelsFor: (provider: string) => (provider === "claude"
    ? [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }]
    : provider === "codex"
      ? [{ id: "gpt-5.6-luna", label: "gpt-5.6-luna" }]
      : [{ id: "openrouter/x/y", label: "openrouter/x/y" }]),
  CUSTOM_MODEL_SENTINEL: "__custom__",
}));

import { buildSessionsListPage, buildSessionTerminalPage } from "./sessions.js";

describe("buildSessionsListPage", () => {
  it("renders the multi-repo form with a disabled-by-default submit button when 2+ repos exist", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }, { fullName: "org/b" }], null);
    expect(html).toContain('x-data="{ n: 0 }"');
    expect(html).toContain(':disabled="n < 2"');
  });

  it("omits the multi-repo form entirely when fewer than 2 repos exist", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }], null);
    expect(html).not.toContain("create-multi");
    expect(html).not.toContain(':disabled="n < 2"');
  });

  it("renders Resume and Delete for an ended session and does not link its id to a terminal", () => {
    const html = buildSessionsListPage(
      "dark",
      [{ id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: false, resumable: true, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: 1000 }],
      [{ fullName: "org/a" }],
      null,
    );
    expect(html).toContain("resumeSession('abcdef12')");
    expect(html).toContain("deleteSession('abcdef12')");
    expect(html).toContain(">Ended<");
    // Ended sessions have no live terminal, so the id must not be an <a href="/sessions/…"> link.
    expect(html).not.toContain('<a href="/sessions/abcdef12"');
  });

  it("lists all repos of a multi-repo session in the Repo / Dir column", () => {
    const html = buildSessionsListPage(
      "dark",
      [{
        id: "abcdef1234",
        repo: "org/a",
        extraRepos: ["org/b", "org/c"],
        cwd: "/x",
        createdAt: 0,
        alive: true,
        resumable: false,
        wsConnected: false,
        summary: null,
        summaryUpdatedAt: null,
        endedAt: null,
      }],
      [],
      null,
    );
    expect(html).toContain("org/b");
    expect(html).toContain("org/c");
    expect(html).toContain('title="org/b"');
  });

  it("renders the sessions table above the create-session form", () => {
    const html = buildSessionsListPage(
      "dark",
      [{ id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null }],
      [{ fullName: "org/a" }, { fullName: "org/b" }],
      null,
    );
    const table = html.indexOf('<div class="table-scroll">');
    const form = html.indexOf('action="/sessions/create"');
    const multi = html.indexOf('action="/sessions/create-multi"');
    expect(table).toBeGreaterThan(-1);
    expect(table).toBeLessThan(form);
    expect(table).toBeLessThan(multi);
  });

  it("renders the empty-state message above the create-session form", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }], null);
    expect(html.indexOf("<p>No active sessions.</p>")).toBeLessThan(html.indexOf('action="/sessions/create"'));
    expect(html).not.toContain("All Sessions");
  });

  it("gives the new-session dropdowns a visible control class", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }], null);
    expect(html).toContain('id="session-repo" class="form-select"');
    expect(html).toContain('id="session-mode" class="form-select"');
    expect(html).toContain('<label class="form-field">');
  });

  it("shows only live sessions in the active table, and both in the All Sessions table", () => {
    const html = buildSessionsListPage(
      "dark",
      [
        { id: "alive1", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null },
        { id: "ended1", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: false, resumable: true, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: 1000 },
      ],
      [{ fullName: "org/a" }],
      null,
    );
    const activePart = html.slice(0, html.indexOf("New Session"));
    expect(activePart).toContain("alive1");
    expect(activePart).not.toContain("ended1");

    const allPart = html.slice(html.indexOf("All Sessions"));
    expect(allPart).toContain("alive1");
    expect(allPart).toContain("ended1");
  });

  it("renders filter controls when sessions exist", () => {
    const html = buildSessionsListPage(
      "dark",
      [{ id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null }],
      [{ fullName: "org/a" }, { fullName: "org/b" }],
      null,
    );
    expect(html).toContain('id="session-status-filter"');
    expect(html).toContain('id="session-search"');
    expect(html).toContain('data-status="running"');
    expect(html).toContain('data-status="ended"');
    expect(html.indexOf('id="all-sessions-table"')).toBeGreaterThan(html.indexOf('action="/sessions/create-multi"'));
  });

  it("rows carry filter metadata for status and search", () => {
    const html = buildSessionsListPage(
      "dark",
      [{ id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: "Fixing Login", summaryUpdatedAt: null, endedAt: null }],
      [{ fullName: "org/a" }],
      null,
    );
    expect(html).toContain('data-status="running"');
    const searchMatch = html.match(/data-search="([^"]*)"/);
    expect(searchMatch).not.toBeNull();
    expect(searchMatch![1]).toContain("org/a");
    expect(searchMatch![1]).toContain("fixing login");
  });

  it("summary cells use the cell-summary class for responsive truncation", () => {
    const html = buildSessionsListPage(
      "dark",
      [{ id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: "Discussing switching is important", summaryUpdatedAt: null, endedAt: null }],
      [{ fullName: "org/a" }],
      null,
    );
    expect(html).toContain('class="cell-summary"');
    expect(html).not.toContain("28ch");
    expect(html).toContain('title="Discussing switching is important"');
  });

  it("shows the Agent column with the provider label, falling back to Claude when unset", () => {
    const html = buildSessionsListPage(
      "dark",
      [
        { id: "codexid1", repo: "org/a", extraRepos: [], cwd: "/tmp", provider: "codex", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null },
        { id: "claudeid", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null },
      ],
      [{ fullName: "org/a" }],
      null,
    );
    expect(html).toContain(">Codex<");
    expect(html).toContain(">Claude<");
  });

  it("pre-ticks the single-repo form's capabilities for the default repo, but not others", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/ha" }, { fullName: "org/b" }], "org/ha");
    const singleForm = html.slice(html.indexOf('action="/sessions/create"'), html.indexOf('action="/sessions/create-multi"'));
    expect(singleForm).toMatch(/name="capability" value="home-assistant" checked/);
    expect(singleForm).not.toMatch(/name="capability" value="ssh:proxmox" checked/);
  });

  it("does not pre-tick any capability in the multi-repo form", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/ha" }, { fullName: "org/b" }], "org/ha");
    const multiIdx = html.indexOf('id="multi-cap-list"');
    expect(multiIdx).toBeGreaterThan(-1);
    const multiCapList = html.slice(multiIdx, html.indexOf("</fieldset>", multiIdx));
    expect(multiCapList).not.toContain("checked");
  });

  it("does not auto-tick multi-repo capabilities when repos are toggled (#2764)", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/ha" }, { fullName: "org/b" }], "org/ha");
    const multiForm = html.slice(html.indexOf('action="/sessions/create-multi"'));
    expect(multiForm).toContain('id="multi-cap-list"');
    expect(html).not.toContain("onMultiRepoChange");
  });

  it("wires the mode select to the agent-availability sync and marks the Agent field", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }], null);
    expect(html).toContain('id="session-mode" class="form-select" @change="onModeChange()"');
    expect(html).toContain('data-agentless="false"');
  });

  it("labels the Agent cell zsh for a repo-zsh session instead of naming an agent", () => {
    const html = buildSessionsListPage(
      "dark",
      [{ id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", mode: "repo-zsh", provider: "claude", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null }],
      [{ fullName: "org/a" }],
      null,
    );
    expect(html).toContain('<td data-label="Agent">zsh</td>');
  });

  it("renders one model select per provider, with only the claude one enabled (#2873)", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }], null);
    for (const provider of ["claude", "codex", "opencode"]) {
      expect(html).toContain(`data-model-for="${provider}"`);
    }
    const codex = html.slice(html.indexOf('id="session-model-codex"'));
    expect(codex.slice(0, codex.indexOf(">"))).toContain("disabled");
    const opencode = html.slice(html.indexOf('id="session-model-opencode"'));
    expect(opencode.slice(0, opencode.indexOf(">"))).toContain("disabled");
    const claude = html.slice(html.indexOf('id="session-model-claude"'));
    expect(claude.slice(0, claude.indexOf(">"))).not.toContain("disabled");
    expect(html).toContain('<option value="__custom__">');
    expect(html).toContain('id="session-model-custom"');
  });

  it("renders an empty OpenRouter suggestions datalist without a list= attribute on the custom input (#2878)", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }], null);
    expect(html).toContain('<datalist id="opencode-model-options"></datalist>');
    const custom = html.slice(html.indexOf('id="session-model-custom"'));
    expect(custom.slice(0, custom.indexOf(">"))).not.toContain("list=");
  });

  it("lists recently used models in their own optgroup and omits it when empty (#2873)", () => {
    const withRecents = buildSessionsListPage("dark", [], [{ fullName: "org/a" }], null, {
      claude: ["opus"], codex: [], opencode: [],
    });
    const claudeSelect = withRecents.slice(
      withRecents.indexOf('id="session-model-claude"'),
      withRecents.indexOf('id="session-model-codex"'),
    );
    expect(claudeSelect).toContain('<optgroup label="Recently used"><option value="opus">opus</option></optgroup>');
    // Already listed as a recent, so it is not repeated under "Available".
    expect(claudeSelect).toContain('<optgroup label="Available"><option value="sonnet">Sonnet</option></optgroup>');

    const noRecents = buildSessionsListPage("dark", [], [{ fullName: "org/a" }], null);
    expect(noRecents).not.toContain('<optgroup label="Recently used">');
  });

  it("shows the chosen model beside the agent name in the sessions table (#2873)", () => {
    const html = buildSessionsListPage(
      "dark",
      [{ id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", mode: "repo-claude", provider: "claude", model: "opus", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null }],
      [{ fullName: "org/a" }],
      null,
    );
    expect(html).toContain('<td data-label="Agent">Claude · opus</td>');
  });

  it("gives the multi-repo form its own claude model select (#2873)", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }, { fullName: "org/b" }], null);
    expect(html).toContain('id="multi-session-model"');
    expect(html).toContain('id="multi-session-model-custom"');
  });

  it("strips the repo owner from the Repo / Dir cell but keeps it as a tooltip (#2915)", () => {
    const html = buildSessionsListPage(
      "dark",
      [{ id: "abcdef12", repo: "St-John-Software/nixos-config", extraRepos: ["St-John-Software/fleet-infra"], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null }],
      [{ fullName: "St-John-Software/nixos-config" }],
      null,
    );
    const start = html.indexOf('id="active-sessions-table"');
    const activeTable = html.slice(start, html.indexOf("</table>", start));
    expect(activeTable).toContain(">nixos-config<");
    expect(activeTable).toContain(">fleet-infra<");
    expect(activeTable).toContain('title="St-John-Software/nixos-config"');
    expect(activeTable).not.toContain(">St-John-Software/nixos-config<");
  });

  it("renders the created timestamp relative to now, with the absolute stamp as a tooltip (#2915)", () => {
    const html = buildSessionsListPage(
      "dark",
      [{ id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: Date.now() - 5 * 60_000, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null }],
      [{ fullName: "org/a" }],
      null,
    );
    expect(html).toContain(">5m ago<");
    expect(html).toMatch(/title="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z"/);
  });

  it("omits the Status column from the Active Sessions table (#2915)", () => {
    const html = buildSessionsListPage(
      "dark",
      [{ id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null }],
      [{ fullName: "org/a" }],
      null,
    );
    const start = html.indexOf('id="active-sessions-table"');
    const activeTable = html.slice(start, html.indexOf("</table>", start));
    expect(activeTable).not.toContain("<th>Status</th>");
    expect(activeTable).not.toContain('data-label="Status"');
  });

  it("keeps the Status column in the All Sessions table (#2915)", () => {
    const html = buildSessionsListPage(
      "dark",
      [
        { id: "alive1", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null },
        { id: "ended1", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: false, resumable: true, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: 1000 },
      ],
      [{ fullName: "org/a" }],
      null,
    );
    const start = html.indexOf('id="all-sessions-table"');
    const allTable = html.slice(start, html.indexOf("</table>", start));
    expect(allTable).toContain("<th>Status</th>");
    expect(allTable).toContain(">Running<");
    expect(allTable).toContain(">Ended<");
  });

  it("does not render a Last output column (#2973)", () => {
    const html = buildSessionsListPage(
      "dark",
      [{ id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null }],
      [{ fullName: "org/a" }],
      null,
    );
    expect(html).not.toContain("<th>Last output</th>");
    expect(html).not.toContain("data-session-lastout");
  });
});

describe("buildSessionTerminalPage", () => {
  it("injects AUTH_WATCH_SCRIPT into the head", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(html).toContain("<!--AUTH-WATCH-->");
  });

  it("renders a Record button in the session bar", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(html).toContain('id="mic-btn"');
    expect(html).toContain(">Record</button>");
  });

  it("emits AUTH_WATCH_SCRIPT before the <body> tag so window.clawsAuthCheck is defined early", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    const authWatchIdx = html.indexOf("<!--AUTH-WATCH-->");
    const bodyIdx = html.indexOf("<body>");
    expect(authWatchIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(authWatchIdx).toBeLessThan(bodyIdx);
  });

  it("omits the session id and agent from the session bar", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true, provider: "codex" });
    const bar = html.slice(html.indexOf('<div class="session-bar">'), html.indexOf('<div id="terminal"'));
    expect(bar).not.toContain("Agent:");
    expect(bar).not.toContain("Session:");
    expect(bar).not.toContain("Codex");
    expect(bar).not.toContain("abcdef12");
  });

  it("puts the description and the action buttons on separate rows", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true, summary: "a long summary" });
    expect(html).toContain('class="session-bar-row session-bar-desc"');
    expect(html).toContain('class="session-bar-row session-bar-actions"');
    const descIdx = html.indexOf("session-bar-desc");
    const actionsIdx = html.indexOf("session-bar-actions");
    expect(descIdx).toBeLessThan(actionsIdx);
    expect(html.indexOf('id="session-desc-set-title"')).toBeGreaterThan(actionsIdx);
    expect(html.indexOf('id="paste-btn"')).toBeGreaterThan(actionsIdx);
    expect(html).not.toContain('id="session-desc-edit"');
    expect(html).not.toContain('id="session-desc-input"');
    expect(html).not.toContain('id="session-desc-form"');
    expect(html).not.toContain(">Resummarise</button>");
  });

  it("still renders the nav for desktop widths", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(html).toContain("<!--NAV-->");
  });

  it("hides the nav and keeps the action buttons on one row below 768px (#2771)", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    const mq = html.slice(html.indexOf("@media (max-width: 768px) {"));
    const block = mq.slice(0, mq.indexOf("}\n") + 1);
    expect(block).toContain("nav { display: none; }");
    expect(html).toContain(".session-bar-actions { flex-wrap: nowrap;");
    expect(html).not.toContain(".session-bar-actions { flex-wrap: wrap; }");
  });

  it("puts /ship before ^D×2 and ^D last on the mobile keybar (#2857)", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    const bar = html.slice(html.indexOf('<div id="mobile-keybar">'), html.indexOf('<div id="copy-overlay">'));
    const ship = bar.indexOf('data-key="ship"');
    const dbl = bar.indexOf('data-action="ctrl-d-double"');
    const ctrlD = bar.indexOf('data-key="ctrl-d"');
    expect(ship).toBeGreaterThan(-1);
    expect(ship).toBeLessThan(dbl);
    expect(dbl).toBeLessThan(ctrlD);
    expect(bar).toContain(">/ship</button>");
  });

  it("styles the keybar pressed state for the fire-on-release keys (#2870)", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(html).toContain('.kb-key[data-pressed]');
  });

  it("prevents the page from taking the terminal's touch gesture (#2895)", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(html).toContain("html, body { overscroll-behavior: none; }");
    expect(html).toContain("touch-action: none");
  });

  it("makes PgUp/PgDn scroll the pane rather than send raw keys (#2895)", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    const bar = html.slice(html.indexOf('<div id="mobile-keybar">'), html.indexOf('<div id="copy-overlay">'));
    expect(bar).toContain('data-action="page-up"');
    expect(bar).toContain('data-action="page-down"');
    expect(bar).toContain('data-action="scroll-bottom"');
    expect(bar).not.toContain('data-key="pgup"');
    expect(bar).not.toContain('data-key="pgdn"');
  });
});
