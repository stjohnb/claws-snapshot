import { describe, it, expect, vi } from "vitest";

vi.mock("./layout.js", () => ({
  PAGE_CSS: "",
  TAILWIND_STYLESHEET: "",
  escapeHtml: (s: string) => s,
  repoShortName: (r: string) => r.split("/").pop() ?? r,
  formatRelativeTime: () => "just now",
  htmlOpenTag: () => "<html>",
  buildNav: () => "",
  buildPageHeader: (_title: string | null, _theme: string) => "",
  THEME_SCRIPT: "",
  ALPINE_SCRIPT: "",
}));

import { buildRunnersPage, formatSeconds } from "./runners.js";
import type { RunnersPageData } from "./runners.js";

function emptyStats() {
  return { repoStats: [], workflowStats: [] };
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    run_id: 1,
    repo: "org/repo",
    workflow_name: "CI",
    status: "in_progress",
    conclusion: null,
    event: "push",
    head_branch: "main",
    created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    run_started_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

// ── formatSeconds ──

describe("formatSeconds", () => {
  it("returns — for 0", () => {
    expect(formatSeconds(0)).toBe("—");
  });

  it("returns — for negative values", () => {
    expect(formatSeconds(-5)).toBe("—");
  });

  it("formats sub-minute seconds", () => {
    expect(formatSeconds(1)).toBe("1s");
    expect(formatSeconds(59)).toBe("59s");
  });

  it("formats exactly 60 seconds as 1m", () => {
    expect(formatSeconds(60)).toBe("1m");
  });

  it("formats minutes with remainder seconds", () => {
    expect(formatSeconds(90)).toBe("1m 30s");
    expect(formatSeconds(119)).toBe("1m 59s");
  });

  it("formats whole minutes without seconds", () => {
    expect(formatSeconds(120)).toBe("2m");
    expect(formatSeconds(300)).toBe("5m");
  });

  it("formats exactly 3600 seconds as 1h", () => {
    expect(formatSeconds(3600)).toBe("1h");
  });

  it("formats hours with remainder minutes", () => {
    expect(formatSeconds(3660)).toBe("1h 1m");
    expect(formatSeconds(7200)).toBe("2h");
    expect(formatSeconds(5400)).toBe("1h 30m");
  });
});

// ── buildRunnersPage ──

describe("buildRunnersPage", () => {
  it("renders empty state when no active runs", () => {
    const data: RunnersPageData = { activeRuns: [], stats: emptyStats(), lastSyncedAt: null };
    const html = buildRunnersPage(data, "dark");
    expect(html).toContain("All clear");
    expect(html).toContain("Not yet synced");
  });

  it("renders queued and in_progress run counts in summary cards", () => {
    const data: RunnersPageData = {
      activeRuns: [
        makeRun({ run_id: 1, status: "queued" }),
        makeRun({ run_id: 2, status: "queued" }),
        makeRun({ run_id: 3, status: "in_progress" }),
      ],
      stats: emptyStats(),
      lastSyncedAt: null,
    };
    const html = buildRunnersPage(data, "dark");
    // Queued count card shows 2 (number div immediately followed by label div)
    expect(html).toMatch(/>2<\/div>\s*<div[^>]*>Queued<\/div>/);
    // In Progress count card shows 1
    expect(html).toMatch(/>1<\/div>\s*<div[^>]*>In Progress<\/div>/);
  });

  it("renders active runs table with workflow and branch", () => {
    const data: RunnersPageData = {
      activeRuns: [makeRun({ run_id: 1, workflow_name: "My Workflow", head_branch: "feature-abc" })],
      stats: emptyStats(),
      lastSyncedAt: null,
    };
    const html = buildRunnersPage(data, "light");
    expect(html).toContain("My Workflow");
    expect(html).toContain("feature-abc");
    expect(html).toContain("running");
  });

  it("renders repo stats table when data is present", () => {
    const data: RunnersPageData = {
      activeRuns: [],
      stats: {
        repoStats: [{ repo: "org/myrepo", total: 5, queued: 0, inProgress: 1, avgQueueWaitS: 30, avgRunDurationS: 120, totalDurationS: 600 }],
        workflowStats: [],
      },
      lastSyncedAt: null,
    };
    const html = buildRunnersPage(data, "dark");
    expect(html).toContain("myrepo");
    expect(html).toContain("30s");
    expect(html).toContain("2m");
    expect(html).toContain("10m");
  });

  it("renders workflow stats table when data is present", () => {
    const data: RunnersPageData = {
      activeRuns: [],
      stats: {
        repoStats: [],
        workflowStats: [{ repo: "org/myrepo", workflowName: "Deploy", total: 10, queued: 0, inProgress: 0, avgQueueWaitS: 0, avgRunDurationS: 3600, totalDurationS: 36000 }],
      },
      lastSyncedAt: null,
    };
    const html = buildRunnersPage(data, "dark");
    expect(html).toContain("Deploy");
    expect(html).toContain("myrepo");
    expect(html).toContain("1h");
    expect(html).toContain("10h");
  });

  it("shows last synced time when provided", () => {
    const data: RunnersPageData = {
      activeRuns: [],
      stats: emptyStats(),
      lastSyncedAt: new Date().toISOString(),
    };
    const html = buildRunnersPage(data, "dark");
    expect(html).toContain("Last synced");
  });

  it("handles run with null head_branch gracefully", () => {
    const data: RunnersPageData = {
      activeRuns: [makeRun({ run_id: 1, head_branch: null })],
      stats: emptyStats(),
      lastSyncedAt: null,
    };
    const html = buildRunnersPage(data, "dark");
    // The branch column should show — for null
    expect(html).toContain("—");
  });

  it("renders a GitHub Actions link for each active run", () => {
    const data: RunnersPageData = {
      activeRuns: [makeRun({ run_id: 424242, repo: "org/myrepo" })],
      stats: emptyStats(),
      lastSyncedAt: null,
    };
    const html = buildRunnersPage(data, "dark");
    expect(html).toContain('href="https://github.com/org/myrepo/actions/runs/424242"');
    expect(html).toContain('target="_blank"');
  });
});
