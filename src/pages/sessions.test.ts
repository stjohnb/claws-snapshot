import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./layout.js", () => ({
  PAGE_CSS: "",
  TAILWIND_STYLESHEET: "",
  HEAD_META: "",
  escapeHtml: (s: string) => s,
  htmlOpenTag: (_theme: string, width?: string) => width && width !== "default" ? `<html data-width="${width}">` : "<html>",
  buildNav: (_theme: string, current?: string) => `<!--NAV ${current ?? ""}-->`,
  buildPageHeader: (_title: string | null, _theme: string) => "",
  THEME_SCRIPT: "",
  ALPINE_SCRIPT: "",
  repoAvatar: (fullName: string) => `<span class="repo-avatar" aria-hidden="true">${fullName.slice(fullName.indexOf("/") + 1).charAt(0)}</span>`,
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

const { extraCaps, forgejoHostedRepos } = vi.hoisted(() => ({
  extraCaps: [] as Array<{ id: string; label: string; description: string; envKeys: string[]; resolve: () => Record<string, string>; provider?: string; group?: string }>,
  forgejoHostedRepos: [] as string[],
}));

vi.mock("../capabilities.js", () => ({
  availableCapabilities: () => [
    { id: "home-assistant", label: "Home Assistant", description: "d", envKeys: [], resolve: () => ({}), group: "infra" },
    { id: "ssh:proxmox", label: "SSH: proxmox", description: "d", envKeys: [], resolve: () => ({}) },
    ...extraCaps,
  ],
  GITHUB_AUTH_CAPABILITY_ID: "github-auth",
  isLiveRevocable: (id: string) => id.startsWith("ssh:"),
  isCapabilityAvailable: (id: string) => extraCaps.some((c) => c.id === id),
  isAgentLoginCapability: (id: string) => extraCaps.some((c) => c.id === id && !!c.provider && c.provider !== "github"),
  validCapabilityIds: (ids: string[]) => {
    const available = ["home-assistant", "ssh:proxmox", ...extraCaps.map((c) => c.id)];
    return ids.filter((id, i) => available.includes(id) && ids.indexOf(id) === i);
  },
  reposForCapability: (id: string, allRepos: string[] = []) =>
    (id === "home-assistant" ? ["org/ha"] : id === "github-auth" ? allRepos : []),
  suggestedReposForCapability: (id: string) => (id === "ssh:proxmox" ? ["org/sugg"] : []),
  defaultCapabilitiesForRepo: (repo: string | null) => [
    ...(repo === "org/ha" ? ["home-assistant"] : []),
    ...(repo && extraCaps.some((c) => c.id === "github-auth") ? ["github-auth"] : []),
  ],
  defaultProviderAuthCapabilities: (provider: string, mode: string) =>
    mode === "repo-zsh" ? [] : ({ claude: ["claude-auth"], codex: ["codex-auth"], opencode: ["openrouter-auth"] } as Record<string, string[]>)[provider] ?? [],
  capabilityLabel: (id: string) =>
    ({ "home-assistant": "Home Assistant", "ssh:proxmox": "SSH: proxmox" } as Record<string, string>)[id] ?? id,
  CAPABILITY_GROUPS: [
    { id: "agent", label: "Agent logins" },
    { id: "forge", label: "Forge access" },
    { id: "infra", label: "Infrastructure" },
    { id: "ssh", label: "SSH hosts" },
    { id: "tools", label: "Tools" },
  ],
  capabilityGroup: (cap: { group?: string; id: string }) => cap.group ?? (cap.id.startsWith("ssh:") ? "ssh" : "tools"),
  autoGrantedRepos: (capId: string, allRepos: string[]) => {
    if (capId === "cross-repo") return "all";
    if (capId === "forgejo") return allRepos.filter((r) => forgejoHostedRepos.includes(r));
    return null;
  },
}));

vi.mock("../session-models.js", () => ({
  sessionModelsFor: (provider: string) => (provider === "claude"
    ? [{ id: "fable", label: "Fable (best)" }, { id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }]
    : provider === "codex"
      ? [{ id: "gpt-5.6-luna", label: "gpt-5.6-luna" }, { id: "gpt-5.5", label: "gpt-5.5" }]
      : [{ id: "openrouter/x/y", label: "openrouter/x/y" }]),
  defaultSessionModel: (provider: string) => (provider === "claude"
    ? "fable"
    : provider === "codex"
      ? "gpt-5.6-luna"
      : "openrouter/x/y"),
  rememberedSessionModel: (provider: string, remembered: string | undefined) => (
    remembered && (provider === "codex" ? ["gpt-5.6-luna", "gpt-5.5"] : provider === "claude" ? ["fable", "opus", "sonnet"] : ["openrouter/x/y"]).includes(remembered)
      ? remembered
      : provider === "claude" ? "fable" : provider === "codex" ? "gpt-5.6-luna" : "openrouter/x/y"),
  CUSTOM_MODEL_SENTINEL: "__custom__",
}));

import { sessionModelsFor } from "../session-models.js";
import { buildEndedSessionPage, buildSessionsListPage, buildSessionTerminalPage, renderSessionsTables, sessionPageTitle } from "./sessions.js";

const PUBLISHED_PNG = {
  id: "csf_01JBQ7X4M2K8NV3TYRW9GZ5PDC", name: "chart.png", size: 2048, contentType: "image/png",
  url: "/sessions/abcdef1234/files/csf_01JBQ7X4M2K8NV3TYRW9GZ5PDC/chart.png",
  downloadUrl: "/sessions/abcdef1234/files/csf_01JBQ7X4M2K8NV3TYRW9GZ5PDC/chart.png?download=1",
  isImage: true, createdAt: "2026-10-12 10:00:00",
  publishedAt: "2026-10-12T10:00:00.000Z", publishedLabel: "2026-10-12 10:00 UTC", latest: false,
};
const PUBLISHED_SCRIPT = {
  id: "csf_01JBQ7X4M2K8NV3TYRW9GZ5PDD", name: "deploy.sh", size: 10, contentType: "application/octet-stream",
  url: "/sessions/abcdef1234/files/csf_01JBQ7X4M2K8NV3TYRW9GZ5PDD/deploy.sh",
  downloadUrl: "/sessions/abcdef1234/files/csf_01JBQ7X4M2K8NV3TYRW9GZ5PDD/deploy.sh?download=1",
  isImage: false, createdAt: "2026-10-12 10:01:00",
  publishedAt: "2026-10-12T10:01:00.000Z", publishedLabel: "2026-10-12 10:01 UTC", latest: false,
};

describe("buildSessionsListPage", () => {
  it("renders the wide width tier", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }], null);
    expect(html).toContain('data-width="wide"');
  });

  it("renders the multi-repo form with a disabled-by-default submit button when 2+ repos exist", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }, { fullName: "org/b" }], null);
    expect(html).toContain('x-data="{ n: 0 }"');
    expect(html).toContain(':disabled="n < 2"');
  });

  it("renders an optional Initial prompt textarea above Create on both forms, the single-repo one in a data-agentless label", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }, { fullName: "org/b" }], null);
    const singleForm = html.slice(html.indexOf('action="/sessions/create"'), html.indexOf('action="/sessions/create-multi"'));
    const multiForm = html.slice(html.indexOf('action="/sessions/create-multi"'));
    expect(singleForm).toMatch(/<label class="form-field initial-prompt-field" data-agentless="false">\s*Initial prompt \(optional\)\s*<textarea name="initialPrompt" id="session-initial-prompt"[^>]* rows="4" maxlength="16000" placeholder="Sent as your first message once the agent is ready"><\/textarea>/);
    expect(singleForm.indexOf("session-initial-prompt")).toBeLessThan(singleForm.indexOf("Create Session"));
    expect(multiForm).toMatch(/<label class="form-field initial-prompt-field" style="[^"]*">\s*Initial prompt \(optional\)\s*<textarea name="initialPrompt" id="multi-session-initial-prompt"/);
    expect(multiForm.indexOf("multi-session-initial-prompt")).toBeLessThan(multiForm.indexOf("Create Multi-repo Session"));
    expect(html).toContain(".form-field.initial-prompt-field { flex-basis: 100%; max-width: none; }");
  });

  it("wraps the active list in #active-sessions and starts polling it (#clw_01M52FEC8QSM9P57WWSEBYFB7D)", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }], null);
    expect(html).toContain('<div id="active-sessions"><p>No active sessions.</p></div>');
    expect(html).toContain('x-init="onRepoChange(); startSessionsPolling(); bindActiveSessionClicks()"');
  });

  it("omits the multi-repo form entirely when fewer than 2 repos exist", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }], null);
    expect(html).not.toContain("create-multi");
    expect(html).not.toContain(':disabled="n < 2"');
  });

  it("renders Resume and Delete for an ended session and links its id to the saved last output (#3311)", () => {
    const html = buildSessionsListPage(
      "dark",
      [{ id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: false, resumable: true, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: 1000 }],
      [{ fullName: "org/a" }],
      null,
    );
    expect(html).toContain("resumeSession('abcdef12')");
    expect(html).toContain("deleteSession('abcdef12')");
    expect(html).toContain(">Ended<");
    expect(html).toContain('<a href="/sessions/abcdef12" title="View last output">abcdef12</a>');
  });

  it("renders only Delete for an ended host-tmux session, which cannot be resumed", () => {
    const html = buildSessionsListPage(
      "dark",
      [{ id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: false, resumable: false, wsConnected: false, summary: "host work", summaryUpdatedAt: null, endedAt: 1000 }],
      [{ fullName: "org/a" }],
      null,
    );
    expect(html).not.toContain("resumeSession('abcdef12')");
    expect(html).toContain("deleteSession('abcdef12')");
    expect(html).toContain(">Ended<");
    expect(html).toContain("host work");
  });

  it("shows a failed ended session's exit code in its status (#3311)", () => {
    const row = { repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: false, resumable: true, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: 1000 };
    const html = buildSessionsListPage("dark", [
      { ...row, id: "aaaa0001", exitCode: 2 },
      { ...row, id: "aaaa0002", exitCode: 0 },
    ], [{ fullName: "org/a" }], null);
    expect(html).toContain('<td data-label="Status">Failed (exit 2)</td>');
    expect(html).toContain('<td data-label="Status">Ended</td>');
    expect(html.match(/<tr data-session-id="aaaa000\d" data-status="ended"/g)).toHaveLength(2);
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
    expect(html).toContain('title="org/b"');
    expect(html).toContain('title="org/c"');
    expect(html).toContain('<span class="visually-hidden">b</span>');
    expect(html.match(/class="repo-avatar"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).not.toContain("<br>");
  });

  const mkSession = (repo: string | null, extraRepos: string[], alive = true) => ({ id: "abcdef12", repo, extraRepos, cwd: "/tmp", createdAt: 0, alive, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: alive ? null : 1 });

  it("renders an 18-repo session as one wrapping icon row inside one session link", () => {
    const extra = Array.from({ length: 17 }, (_, i) => `org/r${i}`);
    const html = buildSessionsListPage("dark", [mkSession("org/a", extra)], [], null);
    const start = html.indexOf('id="active-sessions-table"');
    const table = html.slice(start, html.indexOf("</table>", start));
    expect(table.match(/class="session-repo"/g)).toHaveLength(18);
    expect(table.match(/class="session-repos"/g)).toHaveLength(1);
    expect(table.match(/class="session-title-link"/g)).toHaveLength(1);
    expect(table).not.toContain("<br>");
    expect(table).not.toContain("session-repo-name");
  });

  it("shows the visible short name for a single-repo session", () => {
    const html = buildSessionsListPage("dark", [mkSession("org/a", [])], [], null);
    expect(html).toContain('<span class="session-repo-name">a</span>');
  });

  it("still shows the directory for a session with no repo", () => {
    const html = buildSessionsListPage("dark", [mkSession(null, [])], [], null);
    expect(html).toContain("<code>/tmp</code>");
  });

  it("renders repo avatars in the History table too", () => {
    const html = buildSessionsListPage("dark", [mkSession("org/a", ["org/b"], false)], [], null);
    const start = html.indexOf('id="all-sessions-table"');
    const table = html.slice(start, html.indexOf("</table>", start));
    expect(table).toContain('class="repo-avatar"');
    expect(table).toContain('title="org/b"');
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

  it("shows the new-session repo select and multi-repo checkboxes in short form, with the value and title kept full", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }, { fullName: "org/b" }], null);
    expect(html).toContain(`<option value="org/a">a</option>`);
    expect(html).toContain(`<option value="org/b">b</option>`);
    expect(html).toContain(`title="org/a">`);
    expect(html).toContain(`<input type="checkbox" name="repo" value="org/a" @change="onMultiRepoChange()"> a`);
    expect(html).not.toContain(`<option value="org/a">org/a</option>`);
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

  it("shows usage and warning styling in the active sessions table only", () => {
    const html = buildSessionsListPage(
      "dark",
      [{
        id: "abcdef1234",
        repo: "org/a",
        extraRepos: [],
        cwd: "/tmp",
        createdAt: 0,
        alive: true,
        resumable: false,
        wsConnected: false,
        summary: null,
        summaryUpdatedAt: null,
        endedAt: null,
        tokensUsed: 250000,
        lastContextTokens: 180000,
        usageWarningLevel: "critical",
      }],
      [{ fullName: "org/a" }],
      null,
    );
    const activePart = html.slice(0, html.indexOf("New Session"));
    expect(activePart).toContain("<th>Usage</th>");
    expect(activePart).toContain("180,000 ctx");
    expect(activePart).toContain("180,000 ctx");
    const allPart = html.slice(html.indexOf("All Sessions"));
    expect(allPart).not.toContain("<th>Usage</th>");
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

  it("groups create-form checkboxes into labelled sections in the fixed order (#3138)", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/ha" }, { fullName: "org/b" }], "org/ha");
    const singleForm = html.slice(html.indexOf('action="/sessions/create"'), html.indexOf('action="/sessions/create-multi"'));
    expect(singleForm).toContain('<div class="cap-group" data-cap-group="infra">');
    expect(singleForm).toContain('<div class="cap-group" data-cap-group="ssh">');
    expect(singleForm).toContain('<span class="cap-group-title">Infrastructure</span>');
    expect(singleForm).toContain('<span class="cap-group-title">SSH hosts</span>');
    // Fixed order: Infrastructure (home-assistant) before SSH hosts (ssh:proxmox).
    expect(singleForm.indexOf('data-cap-group="infra"')).toBeLessThan(singleForm.indexOf('data-cap-group="ssh"'));
    // Empty groups (agent, forge, tools) are skipped entirely.
    expect(singleForm).not.toContain('data-cap-group="agent"');
    expect(singleForm).not.toContain('data-cap-group="forge"');
    expect(singleForm).not.toContain('data-cap-group="tools"');
    // The label markup itself is unchanged — existing client-side selectors on label[data-cap] still match.
    expect(singleForm).toMatch(/data-cap="home-assistant"[^>]*>[\s\S]*?<\/label>/);
  });

  describe("auto-granted capabilities are shown, not hidden (#3372)", () => {
    beforeEach(() => {
      extraCaps.splice(0, extraCaps.length,
        { id: "cross-repo", label: "Cross-repo (read + issues)", description: "d", envKeys: [], resolve: () => ({}), group: "forge" },
        { id: "forgejo", label: "Forgejo (git + API)", description: "d", envKeys: [], resolve: () => ({}), group: "forge" },
      );
    });
    afterEach(() => {
      extraCaps.splice(0, extraCaps.length);
      forgejoHostedRepos.splice(0, forgejoHostedRepos.length);
    });

    it("renders cross-repo checked and disabled with an 'always granted' note under the forge group on both forms", () => {
      const html = buildSessionsListPage("dark", [], [{ fullName: "org/ha" }, { fullName: "org/b" }], "org/ha");
      const singleForm = html.slice(html.indexOf('action="/sessions/create"'), html.indexOf('action="/sessions/create-multi"'));
      const multiForm = html.slice(html.indexOf('action="/sessions/create-multi"'));
      for (const form of [singleForm, multiForm]) {
        expect(form).toContain('data-cap-group="forge"');
        const label = form.slice(form.indexOf('data-cap="cross-repo"'));
        const box = label.slice(0, label.indexOf("</label>"));
        expect(box).toContain('data-cap-auto-repos="*"');
        expect(box).toMatch(/name="capability" value="cross-repo" checked disabled/);
        expect(box).toContain('<span class="cap-auto-note">always granted</span>');
      }
    });

    it("forces forgejo checked+disabled for a Forgejo-hosted default repo, but leaves it an ordinary checkbox for a GitHub one", () => {
      forgejoHostedRepos.push("org/forgejo-repo");
      const forgejoHtml = buildSessionsListPage("dark", [], [{ fullName: "org/forgejo-repo" }, { fullName: "org/b" }], "org/forgejo-repo");
      const forgejoSingle = forgejoHtml.slice(forgejoHtml.indexOf('action="/sessions/create"'), forgejoHtml.indexOf('action="/sessions/create-multi"'));
      const forgejoLabel = forgejoSingle.slice(forgejoSingle.indexOf('data-cap="forgejo"'));
      const forgejoBox = forgejoLabel.slice(0, forgejoLabel.indexOf("</label>"));
      expect(forgejoBox).toMatch(/name="capability" value="forgejo" checked disabled/);
      expect(forgejoBox).toContain('<span class="cap-auto-note">auto: Forgejo-hosted repo</span>');

      const githubHtml = buildSessionsListPage("dark", [], [{ fullName: "org/forgejo-repo" }, { fullName: "org/b" }], "org/b");
      const githubSingle = githubHtml.slice(githubHtml.indexOf('action="/sessions/create"'), githubHtml.indexOf('action="/sessions/create-multi"'));
      const githubLabel = githubSingle.slice(githubSingle.indexOf('data-cap="forgejo"'));
      const githubBox = githubLabel.slice(0, githubLabel.indexOf("</label>"));
      expect(githubBox).not.toMatch(/name="capability" value="forgejo" checked/);
      expect(githubBox).not.toContain("disabled");
      expect(githubBox).toContain('data-cap-repos="[]"');
      expect(githubBox).toContain('<span class="cap-auto-note"></span>');
    });

    it("never forces forgejo on the multi-repo form's initial (no-repos-ticked) render, even for a Forgejo-hosted repo", () => {
      forgejoHostedRepos.push("org/forgejo-repo");
      const html = buildSessionsListPage("dark", [], [{ fullName: "org/forgejo-repo" }, { fullName: "org/b" }], "org/forgejo-repo");
      const multiForm = html.slice(html.indexOf('action="/sessions/create-multi"'));
      const label = multiForm.slice(multiForm.indexOf('data-cap="forgejo"'));
      const box = label.slice(0, label.indexOf("</label>"));
      expect(box).not.toMatch(/name="capability" value="forgejo" checked/);
      expect(box).not.toContain("disabled");
    });
  });

  describe("provider-auth capabilities (k8s-pod, #3026)", () => {
    beforeEach(() => {
      extraCaps.splice(0, extraCaps.length,
        { id: "claude-auth", label: "Claude login", description: "d", envKeys: [], resolve: () => ({}), provider: "claude" },
        { id: "codex-auth", label: "Codex login", description: "d", envKeys: [], resolve: () => ({}), provider: "codex" },
        { id: "github-auth", label: "GitHub (gh + git)", description: "d", envKeys: [], resolve: () => ({}), provider: "github" },
      );
    });
    afterEach(() => {
      extraCaps.splice(0, extraCaps.length);
    });

    it("renders data-cap-provider and pre-ticks only the default agent's login in both forms", () => {
      const html = buildSessionsListPage("dark", [], [{ fullName: "org/ha" }, { fullName: "org/b" }], "org/ha");
      const singleForm = html.slice(html.indexOf('action="/sessions/create"'), html.indexOf('action="/sessions/create-multi"'));
      const multiForm = html.slice(html.indexOf('action="/sessions/create-multi"'));
      for (const form of [singleForm, multiForm]) {
        expect(form).toContain('data-cap="claude-auth" data-cap-repos="[]" data-cap-suggest-repos="[]" data-cap-provider="claude"');
        expect(form).toMatch(/name="capability" value="claude-auth" checked/);
        expect(form).not.toMatch(/name="capability" value="codex-auth" checked/);
      }
      expect(singleForm).not.toMatch(/data-cap="home-assistant"[^>]*data-cap-provider/);
    });

    it("moves provider-auth pre-ticking to Codex when Codex is the rendered default", () => {
      const html = buildSessionsListPage("dark", [], [{ fullName: "org/ha" }, { fullName: "org/b" }], "org/ha", undefined, {
        defaultProvider: "codex",
        defaultMultiProvider: "codex",
      });
      const singleForm = html.slice(html.indexOf('action="/sessions/create"'), html.indexOf('action="/sessions/create-multi"'));
      const multiForm = html.slice(html.indexOf('action="/sessions/create-multi"'));
      for (const form of [singleForm, multiForm]) {
        expect(form).toMatch(/name="capability" value="codex-auth" checked/);
        expect(form).not.toMatch(/name="capability" value="claude-auth" checked/);
      }
      expect(multiForm).toContain('<option value="claude">Claude</option>');
      expect(multiForm).toContain('<option value="codex" selected>Codex</option>');
    });

    it("pre-selects the remembered model of the remembered agent, falling back for an unknown one", () => {
      const ids = sessionModelsFor("codex").map((m) => m.id);
      const html = buildSessionsListPage("dark", [], [{ fullName: "org/ha" }], "org/ha", undefined, {
        defaultProvider: "codex",
        rememberedModels: { codex: ids[1]! },
      });
      const select = html.slice(html.indexOf('id="session-model-codex"'));
      expect(select.slice(0, select.indexOf("</select>"))).toContain(`<option value="${ids[1]}" selected>`);
      expect(html).toMatch(/name="capability" value="codex-auth" checked/);
      const fallback = buildSessionsListPage("dark", [], [{ fullName: "org/ha" }], "org/ha", undefined, {
        defaultProvider: "codex",
        rememberedModels: { codex: "gone-model" },
      });
      const fsel = fallback.slice(fallback.indexOf('id="session-model-codex"'));
      expect(fsel.slice(0, fsel.indexOf("</select>"))).toContain(`<option value="${ids[0]}" selected>`);
    });

    it("treats github-auth as a repo default: pre-ticked for a GitHub repo, following the repo select (#3131)", () => {
      const html = buildSessionsListPage("dark", [], [{ fullName: "org/ha" }, { fullName: "org/b" }], "org/ha");
      const singleForm = html.slice(html.indexOf('action="/sessions/create"'), html.indexOf('action="/sessions/create-multi"'));
      const multiForm = html.slice(html.indexOf('action="/sessions/create-multi"'));
      for (const form of [singleForm, multiForm]) {
        expect(form).toMatch(/data-cap="github-auth" data-cap-repos="\[(&quot;|")org\/ha(&quot;|"),(&quot;|")org\/b(&quot;|")\]" data-cap-suggest-repos="\[\]" style=/);
        expect(form).not.toContain('data-cap-provider="github"');
        expect(form).toMatch(/name="capability" value="github-auth" checked/);
      }
      expect(multiForm).toMatch(/only the agent(&#39;|')s login and GitHub pre-ticked/);

      const noRepo = buildSessionsListPage("dark", [], [{ fullName: "org/ha" }, { fullName: "org/b" }], null);
      const noRepoSingle = noRepo.slice(noRepo.indexOf('action="/sessions/create"'), noRepo.indexOf('action="/sessions/create-multi"'));
      expect(noRepoSingle).not.toMatch(/name="capability" value="github-auth" checked/);
    });
  });

  describe("remembered capability defaults", () => {
    const single = (html: string) => html.slice(html.indexOf('action="/sessions/create"'), html.indexOf('action="/sessions/create-multi"'));
    const multi = (html: string) => html.slice(html.indexOf('action="/sessions/create-multi"'));
    const repos = [{ fullName: "org/ha" }, { fullName: "org/b" }];

    it("emits data-cap-suggest-repos on the single form and an empty list on the multi form", () => {
      const html = buildSessionsListPage("dark", [], [{ fullName: "org/ha" }, { fullName: "org/sugg" }], "org/ha");
      expect(single(html)).toMatch(/data-cap="ssh:proxmox" data-cap-repos="[^"]*" data-cap-suggest-repos="\[(&quot;|")org\/sugg(&quot;|")\]"/);
      expect(multi(html)).toMatch(/data-cap="ssh:proxmox" data-cap-repos="[^"]*" data-cap-suggest-repos="\[\]"/);
      expect(single(html)).not.toMatch(/name="capability" value="ssh:proxmox" checked/);
    });

    it("uses a repo's remembered set over the static fallback for data-cap-repos and the pre-tick", () => {
      const html = buildSessionsListPage("dark", [], repos, "org/b", undefined, {
        rememberedCapabilityDefaults: new Map([["org/b", ["ssh:proxmox", "retired-cap"]]]),
      });
      const form = single(html);
      expect(form).toContain('data-cap="ssh:proxmox" data-cap-repos="["org/b"]"');
      expect(form).toMatch(/name="capability" value="ssh:proxmox" checked/);
      expect(form).not.toContain("retired-cap");
      expect(form).toContain("pre-ticked from your last session with this repo");
    });

    it("pre-ticks nothing for a repo whose remembered set is empty", () => {
      const html = buildSessionsListPage("dark", [], repos, "org/ha", undefined, {
        rememberedCapabilityDefaults: new Map([["org/ha", []]]),
      });
      const form = single(html);
      expect(form).toContain('data-cap="home-assistant" data-cap-repos="[]"');
      expect(form).not.toMatch(/name="capability" value="home-assistant" checked/);
    });

    it("keeps the static fallback for a repo with no remembered row", () => {
      const html = buildSessionsListPage("dark", [], repos, "org/ha", undefined, {
        rememberedCapabilityDefaults: new Map([["org/b", ["ssh:proxmox"]]]),
      });
      const form = single(html);
      expect(form).toContain('data-cap="home-assistant" data-cap-repos="["org/ha"]"');
      expect(form).toMatch(/name="capability" value="home-assistant" checked/);
    });

    it("emits only multi-repo combinations in data-multi-cap-defaults, filtered to available ids", () => {
      const html = buildSessionsListPage("dark", [], repos, "org/ha", undefined, {
        rememberedCapabilityDefaults: new Map([
          ["org/b", ["ssh:proxmox"]],
          ["org/b\norg/ha", ["home-assistant", "retired-cap"]],
        ]),
      });
      const form = multi(html);
      expect(form).toContain(`data-multi-cap-defaults="${JSON.stringify({ "org/b\norg/ha": ["home-assistant"] })}"`);
      expect(form).toContain("pre-ticked from your last session with these repos");
      // The server-rendered multi form still pre-ticks nothing repo-specific.
      expect(form).not.toMatch(/name="capability" value="home-assistant" checked/);
    });
  });

  it("does not auto-tick multi-repo capabilities when repos are toggled, beyond the client-side github-auth resync (#2764, #3136)", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/ha" }, { fullName: "org/b" }], "org/ha");
    const multiForm = html.slice(html.indexOf('action="/sessions/create-multi"'));
    expect(multiForm).toContain('id="multi-cap-list"');
    expect(multiForm).toContain('id="multi-session-provider"');
    expect(multiForm).toContain('<option value="claude" selected>Claude</option>');
    expect(multiForm).toContain('<option value="codex">Codex</option>');
    expect(multiForm).not.toContain('<option value="opencode">');
    expect(multiForm).not.toContain('<option value="pi">');
    expect(multiForm).not.toContain('data-model-for="pi"');
    expect(multiForm).not.toMatch(/name="capability" value="home-assistant" checked/);
  });

  it("wires the multi-repo checkboxes to re-sync github-auth on tick/untick (#3136)", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/ha" }, { fullName: "org/b" }], "org/ha");
    const multiForm = html.slice(html.indexOf('action="/sessions/create-multi"'));
    const repoCheckboxes = multiForm.match(/<input type="checkbox" name="repo"[^>]*>/g) ?? [];
    expect(repoCheckboxes.length).toBeGreaterThan(0);
    for (const cb of repoCheckboxes) expect(cb).toContain('@change="onMultiRepoChange()"');
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
    for (const provider of ["claude", "codex", "opencode", "pi"]) {
      expect(html).toContain(`data-model-for="${provider}"`);
    }
    const singleForm = html.slice(html.indexOf('action="/sessions/create"'), html.indexOf("</form>"));
    expect(singleForm).toContain('<option value="pi">Pi</option>');
    const pi = html.slice(html.indexOf('id="session-model-pi"'));
    expect(pi.slice(0, pi.indexOf(">"))).toContain("disabled");
    const codex = html.slice(html.indexOf('id="session-model-codex"'));
    expect(codex.slice(0, codex.indexOf(">"))).toContain("disabled");
    const opencode = html.slice(html.indexOf('id="session-model-opencode"'));
    expect(opencode.slice(0, opencode.indexOf(">"))).toContain("disabled");
    const claude = html.slice(html.indexOf('id="session-model-claude"'));
    expect(claude.slice(0, claude.indexOf(">"))).not.toContain("disabled");
    expect(html).toContain('<option value="__custom__">');
    expect(html).toContain('id="session-model-custom"');
  });

  it("always pre-selects a concrete default model, with no ambiguous Default option (#3254)", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }], null);
    expect(html).not.toContain('<option value="" selected>Default</option>');

    const selectBlock = (id: string) => {
      const start = html.indexOf(`id="${id}"`);
      const end = html.indexOf("</select>", start);
      return html.slice(start, end);
    };
    const expectedSelected: Record<string, string> = {
      "session-model-claude": "fable",
      "session-model-codex": "gpt-5.6-luna",
      "session-model-opencode": "openrouter/x/y",
    };
    for (const [id, expectedId] of Object.entries(expectedSelected)) {
      const block = selectBlock(id);
      expect(block).not.toContain('<option value="">');
      const selectedMatches = block.match(/ selected/g) ?? [];
      expect(selectedMatches.length).toBe(1);
      expect(block).toContain(`<option value="${expectedId}" selected>`);
    }
  });

  it("uses the configured default provider for the single-session agent and model controls", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }, { fullName: "org/b" }], null, undefined, {
      defaultProvider: "codex",
      defaultMultiProvider: "codex",
    });
    const singleForm = html.slice(html.indexOf('action="/sessions/create"'), html.indexOf('action="/sessions/create-multi"'));
    expect(singleForm).toContain('<option value="claude">Claude</option>');
    expect(singleForm).toContain('<option value="codex" selected>Codex</option>');
    const claude = singleForm.slice(singleForm.indexOf('id="session-model-claude"'));
    expect(claude.slice(0, claude.indexOf(">"))).toContain("disabled");
    const codex = singleForm.slice(singleForm.indexOf('id="session-model-codex"'));
    expect(codex.slice(0, codex.indexOf(">"))).not.toContain("disabled");
  });

  it("renders an empty OpenRouter suggestions datalist without a list= attribute on the custom input (#2878)", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }], null);
    expect(html).toContain('<datalist id="opencode-model-options"></datalist>');
    const custom = html.slice(html.indexOf('id="session-model-custom"'));
    expect(custom.slice(0, custom.indexOf(">"))).not.toContain("list=");
  });

  it("lists recently used models in their own optgroup and omits it when empty (#2873)", () => {
    const withRecents = buildSessionsListPage("dark", [], [{ fullName: "org/a" }], null, {
      claude: ["opus"], codex: [], opencode: [], pi: [],
    });
    const claudeSelect = withRecents.slice(
      withRecents.indexOf('id="session-model-claude"'),
      withRecents.indexOf('id="session-model-codex"'),
    );
    expect(claudeSelect).toContain('<optgroup label="Recently used"><option value="opus">opus</option></optgroup>');
    // Already listed as a recent, so it is not repeated under "Available".
    expect(claudeSelect).toContain('<optgroup label="Available"><option value="fable" selected>Fable (best)</option><option value="sonnet">Sonnet</option></optgroup>');
    // The default model stays selected even when a different model was used recently.
    const selectedMatches = claudeSelect.match(/ selected/g) ?? [];
    expect(selectedMatches.length).toBe(1);

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

  it("gives the multi-repo form provider-aware model selects (#2873)", () => {
    const html = buildSessionsListPage("dark", [], [{ fullName: "org/a" }, { fullName: "org/b" }], null);
    expect(html).toContain('id="multi-session-model-claude"');
    expect(html).toContain('id="multi-session-model-codex"');
    expect(html).toContain('data-model-for="claude"');
    expect(html).toContain('data-model-for="codex"');
    const codex = html.slice(html.indexOf('id="multi-session-model-codex"'));
    expect(codex.slice(0, codex.indexOf(">"))).toContain("disabled");
    const claude = html.slice(html.indexOf('id="multi-session-model-claude"'));
    expect(claude.slice(0, claude.indexOf(">"))).not.toContain("disabled");
    expect(html).not.toContain('id="multi-session-model-opencode"');
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
    expect(activeTable).toContain('class="repo-avatar"');
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

  it("shows no Running/Ended status in the Active Sessions table (#2915)", () => {
    const html = buildSessionsListPage(
      "dark",
      [{ id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null }],
      [{ fullName: "org/a" }],
      null,
    );
    const start = html.indexOf('id="active-sessions-table"');
    const activeTable = html.slice(start, html.indexOf("</table>", start));
    expect(activeTable).not.toContain(">Running<");
    expect(activeTable).not.toContain(">Ended<");
  });

  it("renders the self-reported agent status with its age in the Active Sessions table (#3083)", () => {
    const html = buildSessionsListPage(
      "dark",
      [
        { id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, agentStatus: "monitoring", agentStatusUpdatedAt: Date.now() - 4 * 60_000, endedAt: null },
        { id: "fedcba21", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, agentStatus: null, agentStatusUpdatedAt: null, endedAt: null },
      ],
      [{ fullName: "org/a" }],
      null,
    );
    const start = html.indexOf('id="active-sessions-table"');
    const activeTable = html.slice(start, html.indexOf("</table>", start));
    expect(activeTable).toContain("<th>Summary</th><th>Status</th><th>Created</th>");
    expect(activeTable).toContain('<span class="session-agent-status session-agent-status-monitoring">Monitoring</span> · <time');
    expect(activeTable).toContain(">4m ago</time>");
    expect(activeTable).toContain('<td data-label="Status">—</td>');

    const allStart = html.indexOf('id="all-sessions-table"');
    const allTable = html.slice(allStart, html.indexOf("</table>", allStart));
    expect(allTable).not.toContain("session-agent-status");
    expect(allTable).toContain("<th>Summary</th><th>Created</th><th>Status</th>");
  });

  it("renders startup progress in the Status column until the session is ready, in danger colour when it failed (#3198)", () => {
    const html = buildSessionsListPage(
      "dark",
      [
        {
          id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null,
          agentStatus: "monitoring", agentStatusUpdatedAt: Date.now(), endedAt: null,
          startupStatus: { state: "pending", step: "Pulling session image", detail: "ImagePullBackOff", elapsedMs: 12_000, failureReason: null },
        },
        {
          id: "fedcba21", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null,
          agentStatus: null, agentStatusUpdatedAt: null, endedAt: null,
          startupStatus: { state: "failed", step: "Session pod failed", detail: null, elapsedMs: 30_000, failureReason: "OOMKilled" },
        },
      ],
      [{ fullName: "org/a" }],
      null,
    );
    const start = html.indexOf('id="active-sessions-table"');
    const activeTable = html.slice(start, html.indexOf("</table>", start));
    // The startup status wins over the agent's own status while the pod is still coming up.
    expect(activeTable).toContain('<span class="session-agent-status session-agent-status-monitoring">Starting</span> · Pulling session image: ImagePullBackOff · 12s');
    expect(activeTable).not.toContain(">Monitoring<");
    // A failed startup must not read as a normally finished session.
    expect(activeTable).toContain('<span class="session-agent-status session-agent-status-failed">Startup failed</span> · Session pod failed: OOMKilled · 30s');
  });

  it("truncates a long failure reason in the cell but keeps the full text in the title, and omits title for a pending row", () => {
    const longReason = `<bad> ${"x".repeat(200)}`;
    const fullText = `Session pod failed: ${longReason}`;
    const html = buildSessionsListPage(
      "dark",
      [
        {
          id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null,
          agentStatus: null, agentStatusUpdatedAt: null, endedAt: null,
          startupStatus: { state: "pending", step: "Pulling session image", detail: "ImagePullBackOff", elapsedMs: 12_000, failureReason: null },
        },
        {
          id: "fedcba21", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null,
          agentStatus: null, agentStatusUpdatedAt: null, endedAt: null,
          startupStatus: { state: "failed", step: "Session pod failed", detail: null, elapsedMs: 30_000, failureReason: longReason },
        },
      ],
      [{ fullName: "org/a" }],
      null,
    );
    const start = html.indexOf('id="active-sessions-table"');
    const activeTable = html.slice(start, html.indexOf("</table>", start));
    expect(activeTable).toContain('<td data-label="Status"><span class="session-agent-status session-agent-status-monitoring">Starting</span> · Pulling session image: ImagePullBackOff · 12s</td>');
    expect(activeTable).toContain(`title="${fullText}"`);
    expect(activeTable).toContain(`· ${fullText.slice(0, 120)}… · 30s`);
  });

  it("renders a lozenge per held capability in the Active Sessions table, and a dash when none (#3110)", () => {
    const html = buildSessionsListPage(
      "dark",
      [
        { id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null, capabilities: ["home-assistant", "ssh:proxmox", "unknown-cap"] },
        { id: "fedcba21", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null, capabilities: [] },
      ],
      [{ fullName: "org/a" }],
      null,
    );
    const start = html.indexOf('id="active-sessions-table"');
    const activeTable = html.slice(start, html.indexOf("</table>", start));
    expect(activeTable).toContain("<th>Agent</th><th>Usage</th><th>Capabilities</th><th>Summary</th>");
    expect((activeTable.split("cell-session-details")[0].match(/class="capability-lozenge"/g) ?? []).length).toBe(2);
    expect(activeTable).toContain('<span class="capability-lozenge" title="home-assistant">Home Assistant</span>');
    expect(activeTable).toContain('<span class="capability-lozenge" title="ssh:proxmox">SSH: proxmox</span>');
    expect(activeTable).toContain('<span class="capability-lozenge capability-lozenge-more" title="unknown-cap">+1</span>');
    expect(activeTable).toContain('<td data-label="Capabilities">—</td>');

    const allStart = html.indexOf('id="all-sessions-table"');
    const allTable = html.slice(allStart, html.indexOf("</table>", allStart));
    expect(allTable).not.toContain("Capabilities");
    expect(allTable).not.toContain("capability-lozenge");
  });

  it("caps the Capabilities cell at two lozenges plus a +N overflow pill (#3229)", () => {
    const html = buildSessionsListPage(
      "dark",
      [
        { id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null, capabilities: ["home-assistant", "ssh:proxmox", "cap-a", "cap-b", "cap-c", "cap-d"] },
      ],
      [{ fullName: "org/a" }],
      null,
    );
    const start = html.indexOf('id="active-sessions-table"');
    const activeTable = html.slice(start, html.indexOf("</table>", start));
    expect((activeTable.split("cell-session-details")[0].match(/class="capability-lozenge"/g) ?? []).length).toBe(2);
    expect(activeTable).toContain('<span class="capability-lozenge capability-lozenge-more" title="cap-a, cap-b, cap-c, cap-d">+4</span>');
  });

  it("does not render an overflow pill for exactly two capabilities", () => {
    const html = buildSessionsListPage(
      "dark",
      [
        { id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null, capabilities: ["home-assistant", "ssh:proxmox"] },
      ],
      [{ fullName: "org/a" }],
      null,
    );
    const start = html.indexOf('id="active-sessions-table"');
    const activeTable = html.slice(start, html.indexOf("</table>", start));
    expect((activeTable.split("cell-session-details")[0].match(/class="capability-lozenge"/g) ?? []).length).toBe(2);
    expect(activeTable).not.toContain("capability-lozenge-more");
  });

  it("marks both sessions tables with the data-cards-wide card breakpoint (#3229)", () => {
    const html = buildSessionsListPage(
      "dark",
      [{ id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null }],
      [{ fullName: "org/a" }],
      null,
    );
    expect(html).toContain('<table id="active-sessions-table" class="data-cards data-cards-wide sessions-compact">');
    expect(html).toContain('<table id="all-sessions-table" class="data-cards data-cards-wide">');
  });

  it("renders a phone-only details cell for active sessions only", () => {
    const base = { id: "abcdef12", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null, provider: "claude" as const, model: "opus", capabilities: ["home-assistant", "ssh:proxmox", "cap-a"] };
    const render = (extra = {}) => buildSessionsListPage("dark", [{ ...base, ...extra }], [{ fullName: "org/a" }], null);
    const html = render();
    const start = html.indexOf('id="active-sessions-table"');
    const activeTable = html.slice(start, html.indexOf("</table>", start));
    expect(activeTable).toContain("<summary>Claude · opus · 3 caps</summary>");
    const details = activeTable.slice(activeTable.indexOf("cell-session-details"));
    expect(details).toContain("Home Assistant");
    expect(details).toContain("SSH: proxmox");
    expect(details).toContain("cap-a");
    expect(details).not.toContain("capability-lozenge-more");
    const allStart = html.indexOf('id="all-sessions-table"');
    expect(html.slice(allStart, html.indexOf("</table>", allStart))).not.toContain("cell-session-details");
    expect(render({ usageWarningLevel: "critical" })).toContain('3 caps · <svg role="img" aria-label="Usage critical"');
    expect(render({ usageWarningLevel: "warn" })).toContain('aria-label="Usage warning"');
  });

  it("renders the active card with a title link, no ID and an icon End button, leaving history unchanged", () => {
    const base = { id: "abcdef1234567", repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, alive: true, resumable: false, wsConnected: false, summary: null, summaryUpdatedAt: null, endedAt: null };
    const html = buildSessionsListPage("dark", [base, { ...base, id: "cwdonly99", repo: null }], [{ fullName: "org/a" }], null);
    const start = html.indexOf('id="active-sessions-table"');
    const active = html.slice(start, html.indexOf("</table>", start));
    expect(active).not.toContain("<th>ID</th>");
    expect(active).not.toContain('data-label="ID"');
    expect(active).toContain('<a href="/sessions/abcdef1234567" class="session-title-link">');
    expect(active).toContain('<a href="/sessions/cwdonly99" class="session-title-link"><code>/tmp</code></a>');
    expect(active).toContain('aria-label="End session" title="End session"');
    expect(active).toContain('<svg aria-hidden="true"');
    expect(active).not.toContain(">End</button>");
    const allStart = html.indexOf('id="all-sessions-table"');
    const all = html.slice(allStart, html.indexOf("</table>", allStart));
    expect(all).toContain("<th>ID</th>");
    expect(all).toContain('<a href="/sessions/abcdef1234567">abcdef12</a>');
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

describe("buildEndedSessionPage (#3311)", () => {
  const ended = {
    id: "abcdef1234", repo: "org/a", extraRepos: ["org/b"], cwd: "/w", mode: "worktree-claude", provider: "codex",
    createdAt: 0, endedAt: 1735689600000, summary: null, exitCode: 1, lastOutput: "Error: <EACCES> & more", failureReason: "pod failed: exit code 1",
    resumable: true,
  };

  it("shows the exit code, failure, escaped last output and the Revive and Back actions", () => {
    const html = buildEndedSessionPage("dark", ended);
    expect(html).toContain("Session ended");
    expect(html).toContain('<span class="session-exit-failed">1</span>');
    expect(html).toContain("pod failed: exit code 1");
    expect(html).toContain(`<span title="org/a">a</span>, <span title="org/b">b</span>`);
    expect(html).not.toContain("org/a, org/b");
    expect(html).toContain("Codex");
    // escapeHtml is stubbed in this file; server.test.ts checks the output is escaped.
    expect(html).toContain('<pre class="session-last-output">Error: <EACCES> & more</pre>');
    expect(html).toContain('<form method="post" action="/sessions/abcdef1234/resume"');
    expect(html).toContain('href="/sessions"');
    expect(html).not.toContain("Host sessions can no longer be resumed");
  });

  it("omits Revive for a host-tmux session and says host sessions can no longer be resumed", () => {
    const html = buildEndedSessionPage("dark", { ...ended, resumable: false });
    expect(html).not.toContain("Revive session");
    expect(html).not.toContain("/resume");
    expect(html).toContain("This session ran on the Claws host. Host sessions can no longer be resumed; its details and last output stay here as history.");
    expect(html).toContain('<pre class="session-last-output">Error: <EACCES> & more</pre>');
    expect(html).toContain('href="/sessions"');
  });

  it("says when no output was captured and the exit code is unknown", () => {
    const html = buildEndedSessionPage("dark", { ...ended, exitCode: null, lastOutput: null, failureReason: null });
    expect(html).toContain("No output was captured for this session.");
    expect(html).toContain("<dt>Exit code</dt><dd><span>unknown</span></dd>");
    expect(html).not.toContain("<dt>Failure</dt>");
    expect(html).not.toContain("Started by");
  });

  it("names the session and issue that started it, linking both", () => {
    const html = buildEndedSessionPage("dark", { ...ended, startedBy: { session: "0123456789abcdef", issue: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE" } });
    expect(html).toContain("<dt>Started by</dt>");
    expect(html).toContain(`href="/sessions/0123456789abcdef"`);
    expect(html).toContain("<code>01234567</code>");
    expect(html).toContain(`href="/issues/clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE"`);
  });

  it("lists published files with name, size and Download, and omits the table when there are none", () => {
    const html = buildEndedSessionPage("dark", { ...ended, files: [PUBLISHED_PNG, PUBLISHED_SCRIPT] });
    expect(html).toContain("<h2>Files</h2>");
    expect(html.indexOf("<h2>Files</h2>")).toBeLessThan(html.indexOf("<h2>Last output</h2>"));
    expect(html).toMatch(/<table class="data-cards">\s*<thead><tr><th>File<\/th><th>Published<\/th><th>Size<\/th><th>Type<\/th><th><\/th><\/tr><\/thead>/);
    expect(html).toContain(`<img class="session-file-thumb" src="${PUBLISHED_PNG.url}" alt="">`);
    expect(html).toContain(`<td data-label="Size">2.0 KB</td>`);
    expect(html).toContain(`href="${PUBLISHED_SCRIPT.downloadUrl}" download="deploy.sh">Download</a>`);
    expect(html).toContain(`<td data-label="Published"><time class="session-file-time" datetime="2026-10-12T10:00:00.000Z"`);
    expect(html).not.toContain("session-file-latest\">Latest");
    expect(buildEndedSessionPage("dark", ended)).not.toContain("<h2>Files</h2>");
  });

  it("shows each chip's publish time and a single Latest badge on the newest of a family", () => {
    const newest = { ...PUBLISHED_SCRIPT, id: "csf_01JBQ7X4M2K8NV3TYRW9GZ5PDE", name: "deploy-2.sh", latest: true };
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true, files: [PUBLISHED_SCRIPT, newest] });
    expect(html).toContain(`<time class="session-file-time" datetime="2026-10-12T10:01:00.000Z" title="2026-10-12T10:01:00.000Z">2026-10-12 10:01 UTC</time>`);
    expect(html.match(/<span class="session-file-latest">Latest<\/span>/g)).toHaveLength(1);
    const endedHtml = buildEndedSessionPage("dark", { ...ended, files: [PUBLISHED_SCRIPT, newest] });
    expect(endedHtml.match(/<span class="session-file-latest">Latest<\/span>/g)).toHaveLength(1);
  });
});

describe("buildSessionTerminalPage", () => {
  // The terminal is full-bleed, so it takes the `full` page-width tier through
  // htmlOpenTag rather than its old page-local `body { max-width: none }` override.
  it("takes the full page-width tier instead of overriding body's max-width directly", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(html).toContain(`data-width="full"`);
    expect(html).not.toMatch(/body \{[^}]*max-width: none/);
  });

  it("shows a muted Started by line only for a session another session started", () => {
    const plain = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(plain).not.toContain("session-started-by\">");
    const html = buildSessionTerminalPage("dark", {
      id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true,
      startedBy: { session: "0123456789abcdef", issue: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE" },
    });
    expect(html).toMatch(/<div class="session-bar-row session-started-by">Started by session <a href="\/sessions\/0123456789abcdef"[^>]*><code>01234567<\/code><\/a> for <a href="\/issues\/clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE"/);
  });

  it("says a session started from the issue page was started from the issue page", () => {
    const html = buildSessionTerminalPage("dark", {
      id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true,
      startedBy: { session: null, issue: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE", source: "issue-page" },
    });
    expect(html).toMatch(/<div class="session-bar-row session-started-by">Started from the issue page for <a href="\/issues\/clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE"/);
  });

  it("says a session started from a board card was started from the board", () => {
    const html = buildSessionTerminalPage("dark", {
      id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true,
      startedBy: { session: null, issue: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE" },
    });
    expect(html).toMatch(/<div class="session-bar-row session-started-by">Started from the board for <a href="\/issues\/clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE"/);
  });

  it("says a session started from a PR row was started from the PRs page, with and without its issue", () => {
    const html = buildSessionTerminalPage("dark", {
      id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true,
      startedBy: { session: null, issue: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE", pr: { repo: "org/a", number: 7 } },
    });
    expect(html).toContain(`<div class="session-bar-row session-started-by">Started from the PRs page for <a href="https://github.com/org/a/pull/7" title="org/a#7"><code>org/a#7</code></a> · issue <a href="/issues/clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE"`);
    const bare = buildSessionTerminalPage("dark", {
      id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true,
      startedBy: { session: null, issue: null, pr: { repo: "org/a", number: 7 } },
    });
    expect(bare).toContain("Started from the PRs page for <a href=\"https://github.com/org/a/pull/7\" title=\"org/a#7\"><code>org/a#7</code></a></div>");
    expect(bare).not.toContain("Started from the board");
  });

  it("has no upgrade notice element", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(html).not.toContain("upgrade-notice");
  });

  it("injects AUTH_WATCH_SCRIPT into the head", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(html).toContain("<!--AUTH-WATCH-->");
  });

  it("renders a Record button in the session bar", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(html).toContain('id="mic-btn"');
    expect(html).toContain(">Record</button>");
  });

  it("renders the Grant capability control with held, grantable and fixed entries (#3072, #3322)", () => {
    const none = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true, capabilityOptions: [] });
    expect(none).not.toContain('id="grant-cap-select"');
    expect(none).not.toContain('id="grant-cap-status"');

    const html = buildSessionTerminalPage("dark", {
      id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true,
      capabilityOptions: [
        { id: "cross-repo", label: "Cross-repo", group: "forge", state: "held" },
        { id: "forgejo", label: "Forgejo (git + API)", group: "forge", state: "held" },
        { id: "home-assistant", label: "Home Assistant", group: "infra", state: "grantable" },
        { id: "ssh:nas", label: "SSH: nas", group: "ssh", state: "grantable" },
        { id: "browser", label: "Browser", group: "tools", state: "fixed", reason: "codex cannot use the browser capability" },
      ],
    });
    expect(html).toContain('<option value="forgejo" disabled>Forgejo (git + API) (granted)</option>');
    expect(html).toContain('<option value="browser" disabled title="codex cannot use the browser capability">Browser (codex cannot use the browser capability)</option>');
    // The first grantable option in display order is selected, so a disabled one is never the default.
    expect(html).toContain('<option value="home-assistant" selected>Home Assistant</option>');
    expect(html).toContain('<option value="ssh:nas">SSH: nas</option>');
    expect(html).toContain('<button id="grant-cap-btn" type="button" class="trigger-btn" aria-label="Grant capability" title="Grant capability">');
    expect(html).toContain('id="grant-cap-status"');

    // Nothing grantable: the control still shows the held/fixed entries, with the button disabled.
    const onlyHeld = buildSessionTerminalPage("dark", {
      id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true,
      capabilityOptions: [
        { id: "home-assistant", label: "Home Assistant", group: "infra", state: "held" },
        { id: "browser", label: "Browser", group: "tools", state: "fixed", reason: "codex cannot use the browser capability" },
      ],
    });
    expect(onlyHeld).toContain('id="grant-cap-select"');
    expect(onlyHeld).toContain('<button id="grant-cap-btn" type="button" class="trigger-btn" aria-label="Grant capability" title="Grant capability" disabled>');
    expect(onlyHeld).not.toContain(" selected>");
  });

  it("drops the Back link and renders Paste, Copy and Attach as named icon buttons", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(html).not.toContain("← Back");
    for (const id of ["paste-btn", "copy-btn", "attach-btn"]) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*aria-label="[^"]+"[^>]*>\\s*<svg[^>]*aria-hidden="true"`));
    }
  });

  it("renders a held ssh:* entry selectable with data-held, and a disabled Revoke button after Grant", () => {
    const html = buildSessionTerminalPage("dark", {
      id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true,
      capabilityOptions: [
        { id: "home-assistant", label: "Home Assistant", group: "infra", state: "held" },
        { id: "ssh:nas", label: "SSH: nas", group: "ssh", state: "held" },
        { id: "ssh:ryzen", label: "SSH: ryzen", group: "ssh", state: "grantable" },
      ],
    });
    expect(html).toContain('<option value="ssh:nas" data-held="true">SSH: nas (granted)</option>');
    expect(html).toContain('<option value="home-assistant" disabled>Home Assistant (granted)</option>');
    expect(html).toContain('<option value="ssh:ryzen" selected>SSH: ryzen</option>');
    expect(html).toMatch(/id="grant-cap-btn"[^>]*><span class="session-btn-text">Grant capability<\/span><span class="session-btn-text-short" aria-hidden="true">Grant<\/span><\/button>\s*<button id="revoke-cap-btn" type="button" class="trigger-btn" disabled>Revoke<\/button>/);
  });

  it("renders a held entry's carried reason instead of the generic '(granted)' suffix (#3372)", () => {
    const html = buildSessionTerminalPage("dark", {
      id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true,
      capabilityOptions: [
        { id: "cross-repo", label: "Cross-repo (read + issues)", group: "forge", state: "held", reason: "always granted" },
      ],
    });
    expect(html).toContain('<option value="cross-repo" disabled>Cross-repo (read + issues) (always granted)</option>');
  });

  it("fixes the closed capability select width so long disabled reasons cannot widen it", () => {
    const html = buildSessionTerminalPage("dark", {
      id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true,
      capabilityOptions: [
        { id: "x", label: "Label", group: "tools", state: "fixed", reason: "not grantable to a running session" },
        { id: "y", label: "Other", group: "tools", state: "grantable" },
      ],
    });
    expect(html).toContain(".grant-cap-select { width: 12rem; max-width: 12rem;");
    expect(html).toContain(".session-bar-actions .grant-cap-select { width: 8.5rem; max-width: 8.5rem;");
    expect(html).toContain("Label (not grantable to a running session)");
  });

  it("groups the grant-capability dropdown into <optgroup> sections in the fixed order (#3138)", () => {
    const html = buildSessionTerminalPage("dark", {
      id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true,
      capabilityOptions: [
        { id: "ssh:nas", label: "SSH: nas", group: "ssh", state: "grantable" },
        { id: "home-assistant", label: "Home Assistant", group: "infra", state: "grantable" },
        { id: "forgejo-admin", label: "Forgejo admin (Actions secrets)", group: "forge", state: "grantable" },
        { id: "no-group", label: "No group", state: "grantable" },
      ],
    });
    const selectHtml = html.slice(html.indexOf('id="grant-cap-select"'), html.indexOf("</select>"));
    expect(selectHtml).toContain('<optgroup label="Forge access"><option value="forgejo-admin" selected>Forgejo admin (Actions secrets)</option></optgroup>');
    expect(selectHtml).toContain('<optgroup label="Infrastructure"><option value="home-assistant">Home Assistant</option></optgroup>');
    expect(selectHtml).toContain('<optgroup label="SSH hosts"><option value="ssh:nas">SSH: nas</option></optgroup>');
    // A missing group falls into Tools.
    expect(selectHtml).toContain('<optgroup label="Tools"><option value="no-group">No group</option></optgroup>');
    expect(selectHtml.indexOf("Forge access")).toBeLessThan(selectHtml.indexOf("Infrastructure"));
    expect(selectHtml.indexOf("Infrastructure")).toBeLessThan(selectHtml.indexOf("SSH hosts"));
    expect(selectHtml.indexOf("SSH hosts")).toBeLessThan(selectHtml.indexOf("Tools"));
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
    expect(html).not.toContain('session-desc-set-title');
    expect(html).not.toContain(">Set Title</button>");
    expect(html.indexOf('id="paste-btn"')).toBeGreaterThan(actionsIdx);
    expect(html).not.toContain('id="session-desc-edit"');
    expect(html).not.toContain('id="session-desc-input"');
    expect(html).not.toContain('id="session-desc-form"');
    expect(html).not.toContain(">Resummarise</button>");
  });

  it("still renders the nav markup for larger desktop widths", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(html).toContain("<!--NAV /sessions-->");
  });

  it("keeps the shared centred nav, inset by header.session-nav, with the scrollbar gutter reserved (#clw_01M59WA5T5RT2JYGMXQ6AT1BT1)", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(html).not.toContain("scrollbar-gutter: auto");
    expect(html).not.toMatch(/nav \{[^}]*max-width: none/);
    expect(html).toContain('<header class="session-nav"><!--NAV /sessions-->');
    expect(html).toContain(".session-nav { padding: 2rem 2rem 0; }");
  });

  it("keeps the nav in compact terminal mode, trimming only its margin, and keeps the action buttons on one row (#2771, #3191)", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    const mediaHeader = "@media (hover: none) and (pointer: coarse), (max-width: 900px), (max-width: 1200px) and (max-height: 900px) {";
    const mediaIdx = html.indexOf(mediaHeader);
    expect(mediaIdx).toBeGreaterThan(-1);
    const mq = html.slice(mediaIdx);
    const block = mq.slice(0, mq.indexOf("@media (max-width: 768px) {"));
    expect(html).toContain("Compact terminal chrome");
    expect(block).not.toContain("nav { display: none; }");
    expect(block).toContain("nav { margin-bottom: 0;");
    expect(block).toContain("header.session-nav { padding-block: 0.3rem; border-bottom: 1px solid var(--border); }");
    expect(block).not.toContain("padding: 0.3rem 0.6rem");
    expect(block).toContain(".session-dir { display: none; }");
    expect(block).toContain(".session-bar { padding: 0.35rem 0.6rem; font-size: 0.8rem; }");
    expect(block).toContain(".session-bar-actions { gap: 0.3rem; }");
    expect(block).toContain(".session-bar-actions .trigger-btn { font-size: 0.72rem; padding: 0.3rem 0.45rem; }");
    expect(html).toContain(".session-bar-actions { flex-wrap: nowrap;");
    expect(html).toContain(".session-bar-actions { overflow: hidden; gap: 0.25rem; }");
    expect(html).toContain("#mic-btn { min-width: 0;");
    expect(html).not.toContain(".session-bar-actions { flex-wrap: wrap; }");
  });

  it("shows the mobile keybar for touch or narrow widths while keeping phone-only key sizing at 768px", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(html).toContain("@media (hover: none) and (pointer: coarse) {\n      #mobile-keybar { display: flex;");
    expect(html).toContain("@media (max-width: 900px) {\n      #mobile-keybar { display: flex;");
    const phoneMediaIdx = html.indexOf("@media (max-width: 768px) {");
    expect(phoneMediaIdx).toBeGreaterThan(-1);
    const phoneMq = html.slice(phoneMediaIdx);
    const phoneBlock = phoneMq.slice(0, phoneMq.indexOf("#copy-overlay"));
    expect(phoneBlock).toContain(".kb-key { font-size: 0.8rem; min-width: 2.2rem; min-height: 2rem; }");
    expect(phoneBlock).not.toContain("nav { display: none; }");
  });

  it("orders the mobile keybar commands, ^D, cursor keys, then font keys (#clw_01M5CPVC9SB1WWARXXE08429PC)", () => {
    for (const provider of [undefined, "codex"] as const) {
      const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true, ...(provider ? { provider } : {}) });
      const bar = html.slice(html.indexOf('<div id="mobile-keybar">'), html.indexOf('<div id="copy-overlay">'));
      const keys = [...bar.matchAll(/<button type="button" class="kb-key" data-(?:key|action)="([^"]+)"/g)].map((m) => m[1]);
      expect(keys).toEqual([
        "esc", "tab", "enter", provider === "codex" ? "codex-followup" : "ship", "signoff", "compact", "status",
        "ctrl-d-double", "ctrl-d", "up", "down", "left", "right", "font-dec", "font-inc",
        "ctrl", "home", "end", "page-up", "page-down", "scroll-bottom", "ctrl-c", "ctrl-z", "ctrl-l",
      ]);
      expect(bar).toContain('aria-label="Send /signoff"');
      expect(bar).toContain(">/signoff</button>");
      expect(bar).toContain('aria-label="Send /compact"');
      expect(bar).toContain(">/compact</button>");
      expect(bar).toContain('aria-label="Send /status"');
      expect(bar).toContain(">/status</button>");
      expect(bar).toContain(provider === "codex" ? ">Answer</button>" : ">/ship</button>");
    }
  });

  it("renders the Codex follow-up shortcut with provider-neutral utility keys for Codex sessions (#3028, #3192)", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true, provider: "codex" });
    const bar = html.slice(html.indexOf('<div id="mobile-keybar">'), html.indexOf('<div id="copy-overlay">'));
    expect(html).toContain('data-session-provider="codex"');
    expect(bar).toContain('data-key="codex-followup"');
    expect(bar).toContain('aria-label="Answer Codex follow-up question"');
    expect(bar).toContain(">Answer</button>");
    expect(bar).toContain('data-action="ctrl-d-double"');
    expect(bar).toContain('data-key="ctrl-d"');
    expect(bar).toContain('data-key="up"');
    expect(bar).toContain('data-key="down"');
    expect(bar).toContain('data-key="left"');
    expect(bar).toContain('data-key="right"');
    expect(bar).not.toContain('data-key="ship"');
  });

  it("keeps /ship, the utility keys, and default provider marker for Claude sessions (#3028)", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    const bar = html.slice(html.indexOf('<div id="mobile-keybar">'), html.indexOf('<div id="copy-overlay">'));
    expect(html).toContain('data-session-provider="claude"');
    expect(bar).not.toContain('data-key="codex-followup"');
    expect(bar).toContain('data-key="ship"');
    expect(bar).toContain('data-action="ctrl-d-double"');
    expect(bar).toContain('data-key="ctrl-d"');
    expect(bar).toContain('data-key="up"');
    expect(bar).toContain('data-key="down"');
    expect(bar).toContain('data-key="left"');
    expect(bar).toContain('data-key="right"');
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

  it("shows upload and voice-note failures in a session-bar notice, not a floating toast", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(html).not.toContain('id="upload-toast"');
    const bar = html.slice(html.indexOf('class="session-bar"'), html.indexOf('id="terminal"'));
    expect(bar).toMatch(/<div id="session-notice" class="session-bar-row session-notice" role="alert" hidden>/);
    expect(bar).toMatch(/<button id="session-notice-close" type="button"[^>]*aria-label="Dismiss notice"/);
  });

  it("groups the session bar into a main row and a meta row and scrolls Files from 768px", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp/x", alive: true, files: [PUBLISHED_SCRIPT] });
    const main = html.match(/<div class="session-bar-main">([\s\S]*?)<\/div>\s*<\/div>/)?.[1] ?? "";
    expect(main).toContain("session-bar-desc");
    expect(main).toContain("session-bar-actions");
    expect(html).toContain('class="session-bar-row session-bar-desc" title="/tmp/x"');
    const meta = html.slice(html.indexOf('<div class="session-bar-meta">'));
    expect(meta.indexOf('id="session-files"')).toBeGreaterThan(0);
    expect(meta.indexOf('id="session-files"')).toBeLessThan(meta.indexOf('id="startup-status"'));
    expect(html).toContain(".session-bar-main, .session-bar-meta { flex-direction: row;");
    expect(html).toMatch(/\.session-bar-meta > \.session-files \{[^}]*flex-wrap: nowrap; overflow-x: auto;/);
  });

  it("renders published files as chips with a thumbnail for images and a Download link, hidden when there are none", () => {
    const empty = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true });
    expect(empty).toContain(`<div id="session-files" class="session-bar-row session-files" hidden>`);
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", cwd: "/tmp", alive: true, files: [PUBLISHED_PNG, PUBLISHED_SCRIPT] });
    expect(html).toContain(`<div id="session-files" class="session-bar-row session-files"><button type="button" id="session-files-toggle" class="session-files-toggle" aria-expanded="true" aria-controls="session-files">Files (2) ▾</button>`);
    expect(html).toContain(`<span class="session-file" data-file-id="${PUBLISHED_PNG.id}"><img class="session-file-thumb" src="${PUBLISHED_PNG.url}" alt="">`);
    expect(html).toContain(`<span class="session-file-size">2.0 KB</span><time class="session-file-time" datetime="2026-10-12T10:00:00.000Z" title="2026-10-12T10:00:00.000Z">2026-10-12 10:00 UTC</time><a class="session-file-download" href="${PUBLISHED_PNG.downloadUrl}" download="chart.png">Download</a>`);
    // The script has no thumbnail.
    expect(html).toContain(`<span class="session-file" data-file-id="${PUBLISHED_SCRIPT.id}"><a class="session-file-name"`);
    expect(html).toMatch(/\.session-files-toggle \{[^}]*flex: 1 1 100%;[^}]*min-height: 44px;/);
    expect(html).toContain(".session-files.files-collapsed .session-file { display: none; }");
    expect(html).toContain(".session-files.files-collapsed .session-files-toggle { min-height: 30px;");
    // Phone first: one full-width row per file, chips only from 768px.
    expect(html).toMatch(/\.session-file \{[^}]*flex: 1 1 100%;[^}]*min-height: 44px;/);
    expect(html).toMatch(/@media \(min-width: 768px\) \{\s*\.session-files-toggle \{ flex: 0 0 auto; min-height: 30px; \}\s*\.session-file \{ flex: 0 1 auto;/);
  });
});

describe("sessionPageTitle", () => {
  it("appends the repo short name to the title", () => {
    expect(sessionPageTitle({ id: "abcdef1234", summary: "Fix login", repo: "org/claws" })).toBe("Fix login — claws");
  });
  it("lists every repo in order", () => {
    expect(sessionPageTitle({ id: "abcdef1234", summary: "T", repo: "org/a", extraRepos: ["org/b", "org/c"] })).toBe("T — a, b, c");
  });
  it("shows the title alone with no repos", () => {
    expect(sessionPageTitle({ id: "abcdef1234", summary: "Just title", repo: null })).toBe("Just title");
  });
  it("falls back to the session id for a blank title", () => {
    expect(sessionPageTitle({ id: "abcdef1234", summary: "  ", repo: "org/claws" })).toBe("Session abcdef12 — claws");
    expect(sessionPageTitle({ id: "abcdef1234", summary: null, repo: null })).toBe("Session abcdef12");
  });
  it("renders the title and repos in the page <title>", () => {
    const html = buildSessionTerminalPage("dark", { id: "abcdef1234", repo: "org/a", extraRepos: ["org/b"], cwd: "/tmp", alive: true, summary: "x<y" });
    expect(html).toContain("<title>x<y — a, b</title>");
  });
});

describe("buildEndedSessionPage board start", () => {
  it("reads 'Started by: the board for #…' for a session started from the board", () => {
    const html = buildEndedSessionPage("dark", {
      id: "abcdef1234", repo: "org/a", extraRepos: [], cwd: "/w", mode: "worktree-claude", provider: "claude",
      createdAt: 0, endedAt: 1735689600000, summary: null, exitCode: 0, lastOutput: null, failureReason: null,
      resumable: true, startedBy: { session: null, issue: "clw_ABC" },
    });
    expect(html).toContain("<dt>Started by</dt>");
    expect(html).toContain("the board for");
    expect(html).not.toContain("Started from the board");
  });
});

describe("buildEndedSessionPage PRs-page start", () => {
  it("reads 'Started by: the PRs page for owner/name#n'", () => {
    const html = buildEndedSessionPage("dark", {
      id: "abcdef1234", repo: "org/a", extraRepos: [], cwd: "/w", mode: "worktree-claude", provider: "claude",
      createdAt: 0, endedAt: 1735689600000, summary: null, exitCode: 0, lastOutput: null, failureReason: null,
      resumable: true, startedBy: { session: null, issue: "clw_ABC", pr: { repo: "org/a", number: 7 } },
    });
    expect(html).toContain("<dt>Started by</dt><dd>the PRs page for <a href=\"https://github.com/org/a/pull/7\"");
    expect(html).toContain("· issue <a href=\"/issues/clw_ABC\"");
    expect(html).not.toContain("Started from the PRs page");
  });
});

describe("renderSessionsTables (#clw_01M52FEC8QSM9P57WWSEBYFB7D)", () => {
  const row = { repo: "org/a", extraRepos: [], cwd: "/tmp", createdAt: 0, resumable: true, wsConnected: false, summary: null, summaryUpdatedAt: null };

  it("returns each session's id and status as the signature, and both tables with tagged rows", () => {
    const tables = renderSessionsTables([
      { ...row, id: "aaaa0001", alive: true, endedAt: null },
      { ...row, id: "aaaa0002", alive: false, endedAt: 1000 },
    ]);
    expect(tables.signature).toBe("aaaa0001:running,aaaa0002:ended");
    expect(tables.active).toContain('id="active-sessions-table"');
    expect(tables.active).toContain('<tr data-session-id="aaaa0001" data-status="running"');
    expect(tables.active).not.toContain('data-session-id="aaaa0002"');
    expect(tables.all).toContain('id="all-sessions-table"');
    expect(tables.all).toContain('<tr data-session-id="aaaa0002" data-status="ended"');
  });

  it("renders no active table and no All Sessions table when there are no sessions", () => {
    expect(renderSessionsTables([])).toEqual({ signature: "", active: "<p>No active sessions.</p>", all: "" });
    const ended = renderSessionsTables([{ ...row, id: "aaaa0002", alive: false, endedAt: 1000 }]);
    expect(ended.active).toBe("<p>No active sessions.</p>");
    expect(ended.all).toContain('id="all-sessions-table"');
  });
});

describe("grant dropdown matches the agent's requestable list (#clw_01M5CJ538TE6E1QKZCVPCK0SWY)", () => {
  const granted = ["github-auth", "ssh:ryzen", "claude-auth", "cross-repo", "forgejo"];
  const targets = [
    { provider: "claude", mode: "worktree-claude", cwd: "/work" },
    { provider: "codex", mode: "worktree-claude", cwd: "/work" },
    { provider: "claude", mode: "repo-zsh", cwd: "/work" },
  ] as const;

  for (const t of targets) {
    it(`offers every requestable capability for ${t.provider} / ${t.mode}`, async () => {
      // This file mocks capabilities.js for the page; the drift check needs the real registry.
      const real = await vi.importActual<typeof import("../capabilities.js")>("../capabilities.js");
      const target = { provider: t.provider, mode: t.mode };
      const entries = real.classifyLiveGrants(granted, "k8s-pod", target);
      // Same mapping as the GET /sessions/:id route in server.ts.
      const capabilityOptions = entries.map(({ cap, state, reason }) => ({ id: cap.id, label: cap.label, group: real.capabilityGroup(cap), state, reason }));
      const html = buildSessionTerminalPage("dark", {
        id: "abcdef1234", repo: "St-John-Software/production-infra", cwd: t.cwd, alive: true, provider: t.provider, capabilityOptions,
      });
      const start = html.indexOf('id="grant-cap-select"');
      const select = html.slice(start, html.indexOf("</select>", start));
      const options = [...select.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)]
        .map((m) => ({ id: m[1], attrs: m[2], text: m[3] }));
      const enabled = options.filter((o) => !/\bdisabled\b/.test(o.attrs) && !o.attrs.includes('data-held="true"')).map((o) => o.id).sort();

      const grantable = real.liveGrantableCapabilities(granted, "k8s-pod", target).map((c) => c.id).sort();
      const prompt = real.buildRequestableCapabilityPrompt(granted, "k8s-pod", target);
      const promptIds = [...prompt.split("\n").filter((l) => /^[^`]+: `/.test(l)).join("\n").matchAll(/`([^`]+)` \(/g)].map((m) => m[1]).sort();
      expect(enabled).toEqual(grantable);
      expect(promptIds).toEqual(grantable);
      if (t.provider === "claude" && t.mode === "worktree-claude") expect(enabled).toContain("prod-observability");

      // Everything else is shown with its reason rather than silently dropped.
      expect(options.map((o) => o.id).sort()).toEqual(entries.map((e) => e.cap.id).sort());
      for (const e of entries.filter((x) => x.state !== "grantable")) {
        const opt = options.find((o) => o.id === e.cap.id)!;
        const suffix = e.reason ?? "granted";
        expect(opt.text.endsWith(`(${suffix})`)).toBe(true);
        if (e.state === "held" && real.isLiveRevocable(e.cap.id) && e.reason === undefined) {
          expect(opt.attrs).toContain('data-held="true"');
        } else {
          expect(opt.attrs).toContain("disabled");
        }
      }
      if (t.provider !== "claude" || t.mode !== "worktree-claude") {
        const browser = options.find((o) => o.id === "browser");
        if (browser) expect(browser.attrs).toContain("disabled");
      }
    });
  }
});
