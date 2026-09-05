import { describe, it, expect, vi } from "vitest";

vi.mock("./layout.js", () => ({
  PAGE_CSS: "",
  TAILWIND_STYLESHEET: "",
  HEAD_META: "",
  escapeHtml: (s: string) => s,
  repoShortName: (r: string) => r.split("/").pop() ?? r,
  htmlOpenTag: () => "<html>",
  buildPageHeader: (_title: string | null, _theme: string) => "",
  THEME_SCRIPT: "",
}));

import { buildUsagePage } from "./usage.js";
import type { UsagePageData } from "./usage.js";

function emptyStats() {
  return { repoStats: [], jobStats: [], providerStats: [] };
}

function emptyOptions() {
  return { repos: [], jobs: [], providers: [], models: [] };
}

function baseData(overrides: Partial<UsagePageData> = {}): UsagePageData {
  return {
    stats: emptyStats(),
    totals: { taskCount: 0, totalTokens: 0, totalCostUsd: 0 },
    days: 7,
    filters: {},
    options: emptyOptions(),
    ...overrides,
  };
}

describe("buildUsagePage", () => {
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
          providerStats: [{ provider: "opencode", model: "openrouter/z-ai/glm-5.3", taskCount: 1, totalTokens: 100, totalCostUsd: 1 }],
        },
      }),
      "dark",
    );
    expect(html).toContain("?days=7&provider=opencode");
  });

  it("footnote mentions unknown and Codex $0", () => {
    const html = buildUsagePage(baseData(), "dark");
    expect(html).toContain("unknown");
    expect(html).toContain("Codex reports tokens but no price");
  });
});
