import { describe, it, expect, vi } from "vitest";

vi.mock("./layout.js", () => ({
  PAGE_CSS: "",
  TAILWIND_STYLESHEET: "",
  HEAD_META: "",
  escapeHtml: (s: string) => s,
  repoShortName: (r: string) => r.split("/").pop() ?? r,
  htmlOpenTag: (_theme: string, width?: string) => width && width !== "default" ? `<html data-width="${width}">` : "<html>",
  buildPageHeader: (_title: string | null, _theme: string) => "",
  THEME_SCRIPT: "",
}));

import { buildUsagePage } from "./usage.js";
import type { UsagePageData } from "./usage.js";

function emptyStats() {
  return { repoStats: [], jobStats: [], providerStats: [], sessionStats: [] };
}

function emptyOptions() {
  return { repos: [], jobs: [], providers: [], models: [] };
}

function row(overrides = {}) {
  return {
    taskCount: 1,
    completedCount: 1,
    failedCount: 0,
    changedCount: 0,
    prCreatedCount: 0,
    reviewClean: 0,
    reviewAdvisory: 0,
    reviewBlocking: 0,
    reviewEscalated: 0,
    reviewEmptyDiff: 0,
    mergedCount: 0,
    reviewScoreTotal: 0,
    reviewScoreCount: 0,
    totalTokens: 100,
    totalCostUsd: 1,
    avgDurationSeconds: 90,
    ...overrides,
  };
}

function baseData(overrides: Partial<UsagePageData> = {}): UsagePageData {
  return {
    stats: emptyStats(),
    totals: { taskCount: 0, totalTokens: 0, totalCostUsd: 0 },
    days: 7,
    filters: {},
    options: emptyOptions(),
    recentEvents: [],
    ...overrides,
  };
}

describe("buildUsagePage", () => {
  it("renders the wide width tier", () => {
    const html = buildUsagePage(baseData(), "dark");
    expect(html).toContain('data-width="wide"');
  });

  it("renders the four filter selects with an All option", () => {
    const html = buildUsagePage(baseData(), "dark");
    expect(html).toContain('name="repo"');
    expect(html).toContain('name="job"');
    expect(html).toContain('name="provider"');
    expect(html).toContain('name="model"');
    expect(html).toMatch(/<option value="">All<\/option>/);
  });

  it("marks the current filter value as selected", () => {
    const html = buildUsagePage(
      baseData({
        filters: { provider: "opencode" },
        options: { repos: [], jobs: [], providers: ["opencode", "claude"], models: [] },
      }),
      "dark",
    );
    expect(html).toMatch(/<option value="opencode" selected>opencode<\/option>/);
  });

  it("shows a filter value as selected even when absent from its option list", () => {
    const html = buildUsagePage(
      baseData({
        filters: { provider: "opencode" },
        options: { repos: [], jobs: [], providers: [], models: [] },
      }),
      "dark",
    );
    expect(html).toMatch(/<option value="opencode" selected>opencode<\/option>/);
  });

  it("window selector links preserve active filters", () => {
    const html = buildUsagePage(
      baseData({ days: 7, filters: { provider: "opencode" } }),
      "dark",
    );
    expect(html).toContain("?days=30&provider=opencode");
  });

  it("provider table row links to a filtered URL", () => {
    const html = buildUsagePage(
      baseData({
        stats: {
          repoStats: [],
          jobStats: [],
          providerStats: [{ provider: "opencode", model: "openrouter/z-ai/glm-5.3", ...row() }],
          sessionStats: [],
        },
      }),
      "dark",
    );
    expect(html).toContain("?days=7&provider=opencode");
  });

  it("renders effectiveness columns with mobile card labels", () => {
    const html = buildUsagePage(
      baseData({
        stats: {
          repoStats: [{ repo: "org/repo", ...row({ changedCount: 2, prCreatedCount: 1, reviewScoreTotal: 1.5, reviewScoreCount: 2 }) }],
          jobStats: [{ jobName: "issue-worker", ...row() }],
          providerStats: [{ provider: "codex", model: "gpt-5", ...row({ mergedCount: 1, reviewClean: 1 }) }],
          sessionStats: [],
        },
      }),
      "dark",
    );
    expect(html).toContain('table class="data-cards data-cards-wide"');
    expect(html).toContain('data-label="Review Score"');
    expect(html).toContain("+0.75 (2)");
    expect(html).toContain("Reviews C/A/B/E/Empty");
  });

  it("renders recent quality signals", () => {
    const html = buildUsagePage(
      baseData({
        recentEvents: [{
          taskId: 12,
          jobName: "issue-worker",
          repo: "org/repo",
          itemNumber: 3,
          provider: "codex",
          model: "gpt-5",
          signal: "pr-review-clean",
          score: 1,
          source: "pr-review",
          sourceRepo: "org/repo",
          sourceNumber: 44,
          sourceSha: "abcdef1234567890",
          details: null,
          createdAt: "2026-09-11 12:00:00",
        }],
      }),
      "dark",
    );
    expect(html).toContain("Recent Quality Signals");
    expect(html).toContain("pr-review-clean");
    expect(html).toContain('data-label="Source PR"');
  });

  it("footnote mentions unknown, Codex $0, and review score", () => {
    const html = buildUsagePage(baseData(), "dark");
    expect(html).toContain("unknown");
    expect(html).toContain("Session dollar cost is unknown");
    expect(html).toContain("Codex task cost can be $0");
    expect(html).toContain("Review score is task-only");
  });

  it("renders session usage rows with unknown cost and warnings", () => {
    const html = buildUsagePage(
      baseData({
        stats: {
          repoStats: [],
          jobStats: [],
          providerStats: [],
          sessionStats: [{
            id: "abcdef123456",
            repo: "org/repo",
            cwd: "/work/repo",
            provider: "claude",
            model: "opus",
            alive: true,
            totalTokens: 1234,
            costUsd: null,
            lastContextTokens: 181000,
            createdAt: Date.UTC(2026, 8, 17),
            endedAt: null,
            warningLevel: "critical",
          }],
        },
      }),
      "dark",
    );
    expect(html).toContain("By Session");
    expect(html).toContain('<a href="/sessions/abcdef123456">abcdef12</a>');
    expect(html).toContain('data-label="Cost">unknown');
    expect(html).toContain("Critical");
  });
});
