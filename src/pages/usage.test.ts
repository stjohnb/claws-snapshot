import { describe, it, expect, vi } from "vitest";

vi.mock("./layout.js", () => ({
  PAGE_CSS: "",
  TAILWIND_STYLESHEET: "",
  HEAD_META: "",
  escapeHtml: (s: string) => s,
  repoAvatar: (r: string) => `<span class="repo-avatar">${r.split("/").pop()?.charAt(0)}</span>`,
  repoShortName: (r: string) => r.split("/").pop() ?? r,
  htmlOpenTag: (_theme: string, width?: string) => width && width !== "default" ? `<html data-width="${width}">` : "<html>",
  buildPageHeader: (_title: string | null, _theme: string) => "",
  THEME_SCRIPT: "",
}));

import { buildUsagePage } from "./usage.js";
import type { UsagePageData } from "./usage.js";
import type { UsageItem } from "../db.js";
import { parsePivotState } from "../usage-pivot.js";

function emptyOptions() {
  return { repos: [], jobs: [], providers: [], models: [], accounts: [] };
}

function item(overrides: Partial<UsageItem> = {}): UsageItem {
  return {
    kind: "task",
    taskId: 7,
    runId: "run-7",
    sessionId: null,
    repo: "org/repo",
    cwd: null,
    job: "issue-worker",
    provider: "claude",
    account: "",
    model: "opus",
    state: "completed",
    tokens: 100,
    costUsd: 1,
    lastContextTokens: null,
    day: "2026-11-01",
    alive: false,
    ...overrides,
  };
}

function session(overrides: Partial<UsageItem> = {}): UsageItem {
  return item({ kind: "session", taskId: null, runId: null, sessionId: "abcdef123456", cwd: "/work/repo", job: "interactive-session", state: "Live", alive: true, costUsd: null, lastContextTokens: 181_000, ...overrides });
}

function pivot(q: Parameters<typeof parsePivotState>[0] = {}) {
  return parsePivotState(q);
}

function baseData(overrides: Partial<UsagePageData> = {}): UsagePageData {
  return {
    items: [],
    pivot: pivot(),
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

  it("shows all-time OpenCode API spend against its warning threshold, in --warning once reached", () => {
    const under = buildUsagePage(baseData({ opencodeSpendUsd: 42.5, opencodeSpendWarnUsd: 150 }), "system");
    const card = under.slice(under.indexOf('id="opencode-spend"'));
    expect(card).toContain("$42.50 of $150.00 warning");
    expect(card).toContain("OpenCode API spend (all time, reported)");
    expect(card.slice(0, card.indexOf("stat-label"))).not.toContain("var(--warning)");

    const over = buildUsagePage(baseData({ opencodeSpendUsd: 150, opencodeSpendWarnUsd: 150 }), "system");
    expect(over).toContain('style="color:var(--warning);">$150.00 of $150.00 warning');

    const disabled = buildUsagePage(baseData({ opencodeSpendUsd: 500, opencodeSpendWarnUsd: 0 }), "system");
    expect(disabled).toContain(">$500.00</div>");
    expect(disabled).not.toContain("var(--warning);\">$500");
  });

  it("omits the OpenCode spend card when no spend was passed", () => {
    expect(buildUsagePage(baseData(), "system")).not.toContain('id="opencode-spend"');
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
        options: { repos: [], jobs: [], providers: ["opencode", "claude"], models: [], accounts: [] },
      }),
      "dark",
    );
    expect(html).toMatch(/<option value="opencode" selected>opencode<\/option>/);
  });

  it("shows a filter value as selected even when absent from its option list", () => {
    const html = buildUsagePage(
      baseData({
        filters: { provider: "opencode" },
        options: { repos: [], jobs: [], providers: [], models: [], accounts: [] },
      }),
      "dark",
    );
    expect(html).toMatch(/<option value="opencode" selected>opencode<\/option>/);
  });

  it("renders an Account filter and shows (none) for an unrecorded account", () => {
    const html = buildUsagePage(
      baseData({
        filters: { account: "second" },
        options: { repos: [], jobs: [], providers: [], models: [], accounts: ["primary", "second"] },
        items: [item({ account: "second" }), item({ taskId: 8, account: "" })],
        pivot: pivot({ rows: ["account"] }),
      }),
      "dark",
    );
    expect(html).toContain('name="account"');
    expect(html).toMatch(/<option value="second" selected>second<\/option>/);
    expect(html).toContain("(none)</td>");
    expect(html).toContain("Filtered by account=second");
  });

  it("window selector links preserve active filters and the pivot view", () => {
    const html = buildUsagePage(
      baseData({ days: 7, filters: { provider: "opencode" }, pivot: pivot({ rows: ["model"], sort: "tokens" }) }),
      "dark",
    );
    expect(html).toContain("?days=30&provider=opencode&rows=model&sort=tokens");
  });

  it("shows one pivot instead of the stacked tables, with an empty state", () => {
    const empty = buildUsagePage(baseData(), "dark");
    expect(empty).toContain("No usage data in this window");
    expect(empty).not.toContain("By Repository");
    expect(empty).not.toContain("By Session");

    const html = buildUsagePage(baseData({ items: [item()] }), "dark");
    expect(html).toContain('<table class="usage-pivot">');
    expect(html).toContain('class="usage-pivot-wrap table-scroll"');
    expect(html).toContain("Repo › Job › Task / session");
    expect(html).toContain('class="pivot-total"');
  });

  it("expand links carry the filters and sort, and an open row shows its children", () => {
    const data = baseData({ filters: { provider: "claude" }, items: [item()], pivot: pivot({ sort: "tokens" }) });
    const closed = buildUsagePage(data, "dark");
    expect(closed).toContain('href="?days=7&provider=claude&sort=tokens&open=org%252Frepo" aria-expanded="false"');
    expect(closed).not.toContain("issue-worker</td>");

    const open = buildUsagePage({ ...data, pivot: pivot({ sort: "tokens", open: ["org%2Frepo"] }) }, "dark");
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("issue-worker</td>");
    expect(open).toContain('href="?days=7&provider=claude&sort=tokens"');
  });

  it("sort headers toggle direction and mark the active column", () => {
    const html = buildUsagePage(baseData({ filters: { job: "ci-fixer" }, items: [item({ job: "ci-fixer" })] }), "dark");
    expect(html).toContain('<th class="num" aria-sort="descending"><a href="?days=7&job=ci-fixer&dir=asc">Cost ▼</a></th>');
    expect(html).toContain('<a href="?days=7&job=ci-fixer&sort=tokens">Tokens</a>');
  });

  it("links a task to its log and a live session to its page, but not an ended session", () => {
    const html = buildUsagePage(
      baseData({
        items: [item(), session(), session({ sessionId: "ended0000000", alive: false, state: "Ended" })],
        pivot: pivot({ rows: ["id"] }),
      }),
      "dark",
    );
    expect(html).toContain('<a href="/logs/run-7">#7</a>');
    expect(html).toContain('<a href="/sessions/abcdef123456">abcdef12</a>');
    expect(html).toContain("ended000</td>");
    expect(html).not.toContain('href="/sessions/ended0000000"');
  });

  it("keeps unknown cost distinct from $0", () => {
    const html = buildUsagePage(
      baseData({
        items: [session(), item({ taskId: 9, repo: "org/other", costUsd: 0 }), item({ taskId: 10, repo: "org/mixed", costUsd: 2 }), session({ sessionId: "s2", repo: "org/mixed" })],
        pivot: pivot({ rows: ["repo"] }),
      }),
      "dark",
    );
    expect(html).toContain('<td class="num">unknown</td>');
    expect(html).toContain('<td class="num">$0.0000</td>');
    expect(html).toContain('<td class="num">$2.00 + 1 unknown</td>');
    expect(html).toContain('<span id="unknown-cost-count">+2 unknown</span>');
  });

  it("colours max context by warning level and shows — for tasks", () => {
    const html = buildUsagePage(baseData({ items: [session(), item({ repo: "org/tasks" })], pivot: pivot({ rows: ["repo"] }) }), "dark");
    expect(html).toContain('<span style="color:var(--danger); font-weight:600;" title="Context critical">181,000</span>');
    expect(html).toContain('<td class="num">—</td>');
  });

  it("renders a column dimension with Total and the chosen measure", () => {
    const html = buildUsagePage(
      baseData({ items: [item(), item({ taskId: 8, provider: "codex", tokens: 40 })], pivot: pivot({ rows: ["repo"], cols: "provider", measure: "tokens" }) }),
      "dark",
    );
    expect(html).toContain(">claude</a></th>");
    expect(html).toContain(">codex</a></th>");
    expect(html).toContain("Total tokens");
    expect(html).toContain('<td class="num">140</td>');
  });

  it("labels a directory-only session by its cwd without an avatar", () => {
    const html = buildUsagePage(baseData({ items: [session({ repo: null, cwd: "/work/scratch" })], pivot: pivot({ rows: ["repo"] }) }), "dark");
    expect(html).toContain("/work/scratch</td>");
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

  it("puts recent quality signals behind a disclosure", () => {
    const html = buildUsagePage(baseData(), "dark");
    expect(html).toContain('<details class="usage-signals"><summary>Recent Quality Signals (0)</summary>');
  });

  it("footnote keeps the unknown, session cost and Codex $0 caveats", () => {
    const html = buildUsagePage(baseData(), "dark");
    expect(html).toContain("running items may be incomplete");
    expect(html).toContain("Session dollar cost is unknown");
    expect(html).toContain("Codex task cost can be $0");
    expect(html).toContain("<code>unknown</code>");
    expect(html).not.toContain("Review score is task-only");
  });
});
