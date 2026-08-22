import { describe, it, expect, vi } from "vitest";

vi.mock("./layout.js", () => ({
  PAGE_CSS: "",
  TAILWIND_STYLESHEET: "",
  HEAD_META: "",
  escapeHtml: (s: string) => s,
  htmlOpenTag: () => "<html>",
  buildNav: () => "",
  buildPageHeader: (_title: string | null, _theme: string) => "",
  THEME_SCRIPT: "",
  ALPINE_SCRIPT: "",
}));

vi.mock("../resources/error-handler.generated.js", () => ({
  ERROR_HANDLER_SCRIPT: "",
}));

vi.mock("../resources/sessions-list.generated.js", () => ({
  SESSIONS_LIST_SCRIPT: "",
}));

vi.mock("../resources/session-terminal.generated.js", () => ({
  SESSION_TERMINAL_SCRIPT: "",
}));

vi.mock("../capabilities.js", () => ({
  availableCapabilities: () => [],
}));

import { buildSessionsListPage } from "./sessions.js";

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
});
