import { describe, it, expect, vi } from "vitest";

vi.mock("../db.js", () => ({
  insertJobRun: vi.fn(),
  completeJobRun: vi.fn(),
}));

vi.mock("../log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withRunContext: vi.fn((fn: () => unknown) => fn),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

import { buildRepoPage, buildRepoListPage, buildBarChart, type RepoPageData } from "./repo.js";
import type { Task } from "../db.js";
import type { QueueItem, PR, Issue } from "../github.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    job_name: "issue-dispatcher",
    repo: "org/repo",
    item_number: 42,
    trigger_label: null,
    worktree_path: null,
    branch_name: null,
    run_id: "run-1",
    status: "completed",
    error: null,
    outcome: null,
    model_used: null,
    provider_used: null,
    tokens_used: null,
    cost_usd: null,
    started_at: "2026-03-15 10:00:00",
    completed_at: "2026-03-15 10:05:00",
    ...overrides,
  };
}

function makePageData(overrides: Partial<RepoPageData> = {}): RepoPageData {
  return {
    owner: "org",
    name: "repo",
    queueItems: [],
    recentTasks: [],
    dailyStats: [],
    worktrees: [],
    openPRs: [],
    alertIssues: [],
    openIssues: [],
    ...overrides,
  };
}

describe("buildRepoPage", () => {
  it("renders all sections with empty data", () => {
    const html = buildRepoPage(makePageData(), "system");
    expect(html).toContain("org/repo");
    expect(html).toContain("No task data for the last 30 days");
    expect(html).toContain("No tasks recorded");
    expect(html).toContain("No active worktrees");
    expect(html).toContain("No open PRs");
    expect(html).toContain("No open issues");
    expect(html).toContain("No scanner alerts");
  });

  it("renders pipeline category badges on open issues", () => {
    const items: QueueItem[] = [
      { repo: "org/repo", number: 1, title: "Issue 1", category: "refined", updatedAt: "2026-03-15", type: "issue" },
      { repo: "org/repo", number: 2, title: "Issue 2", category: "refined", updatedAt: "2026-03-14", type: "issue" },
      { repo: "org/repo", number: 3, title: "Issue 3", category: "needs-refinement", updatedAt: "2026-03-13", type: "issue" },
    ];
    const openIssues: Issue[] = [
      { number: 1, title: "Issue 1", body: "", labels: [], author: { login: "user" } },
      { number: 2, title: "Issue 2", body: "", labels: [], author: { login: "user" } },
      { number: 3, title: "Issue 3", body: "", labels: [], author: { login: "user" } },
    ];
    const html = buildRepoPage(makePageData({ queueItems: items, openIssues }), "system");
    expect(html).toContain("Refined");
    expect(html).toContain("Needs Refinement");
  });

  it("renders recent task history table", () => {
    const tasks = [
      makeTask({ job_name: "issue-dispatcher", item_number: 42, status: "completed" }),
      makeTask({ id: 2, job_name: "pr-dispatcher", item_number: 10, status: "failed", error: "timeout" }),
    ];
    const html = buildRepoPage(makePageData({ recentTasks: tasks }), "system");
    expect(html).toContain("issue-dispatcher");
    expect(html).toContain("pr-dispatcher");
    expect(html).toContain("#42");
    expect(html).toContain("#10");
    expect(html).toContain("status-completed");
    expect(html).toContain("status-failed");
  });

  it("renders task outcome summary", () => {
    const tasks = [
      makeTask({ outcome: JSON.stringify({ prNumber: 55, prAction: "created", commits: 3, insertions: 100, deletions: 20 }) }),
    ];
    const html = buildRepoPage(makePageData({ recentTasks: tasks }), "system");
    expect(html).toContain("PR #55 created");
    expect(html).toContain("3 commits");
  });

  it("renders worktrees", () => {
    const html = buildRepoPage(makePageData({ worktrees: ["issue-worker/claws/issue-42-abc1", "ci-fixer/fix-build"] }), "system");
    expect(html).toContain("issue-worker/claws/issue-42-abc1");
    expect(html).toContain("ci-fixer/fix-build");
    expect(html).not.toContain("No active worktrees");
  });

  it("renders all open PRs including non-claws branches", () => {
    const prs: PR[] = [
      { number: 10, title: "Fix bug", headRefName: "claws/issue-10-abc1", baseRefName: "main", labels: [], author: { login: "claws-bot" }, isCrossRepository: false },
      { number: 11, title: "Manual PR", headRefName: "feature/xyz", baseRefName: "main", labels: [], author: { login: "human" }, isCrossRepository: false },
    ];
    const html = buildRepoPage(makePageData({ openPRs: prs }), "system");
    expect(html).toContain("#10");
    expect(html).toContain("Fix bug");
    expect(html).toContain("#11");
    expect(html).toContain("Manual PR");
  });

  it("renders scanner alert badge on open issues", () => {
    const alerts: Issue[] = [
      { number: 100, title: "[claws-error] pr-reviewer crash", body: "", labels: [{ name: "claws-error" }], author: { login: "claws-bot" } },
    ];
    const openIssues: Issue[] = [
      { number: 100, title: "[claws-error] pr-reviewer crash", body: "", labels: [{ name: "claws-error" }], author: { login: "claws-bot" } },
    ];
    const html = buildRepoPage(makePageData({ alertIssues: alerts, openIssues }), "system");
    expect(html).toContain("#100");
    expect(html).toContain("[claws-error] pr-reviewer crash");
    expect(html).toContain("scanner alert");
  });

  it("shows alert issue in Scanner Findings even when absent from openIssues", () => {
    const alerts: Issue[] = [
      { number: 200, title: "[claws-error] stale scanner alert", body: "", labels: [{ name: "claws-error" }], author: { login: "claws-bot" } },
    ];
    // openIssues does not include issue 200 (e.g. it fell off the 100-item cap)
    const openIssues: Issue[] = [
      { number: 1, title: "Some other issue", body: "", labels: [], author: { login: "user" } },
    ];
    const html = buildRepoPage(makePageData({ alertIssues: alerts, openIssues }), "system");
    expect(html).toContain("#200");
    expect(html).toContain("[claws-error] stale scanner alert");
    expect(html).toContain("Scanner Findings");
    expect(html).not.toContain("No scanner alerts");
  });

  it("includes nav, meta refresh, and GitHub link", () => {
    const html = buildRepoPage(makePageData(), "dark");
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('meta http-equiv="refresh" content="60"');
    expect(html).toContain("https://github.com/org/repo");
    expect(html).toContain('href="/repos"');
  });
});

describe("buildRepoListPage", () => {
  it("renders repo links", () => {
    const repos = [
      { owner: "org", name: "repo-a", fullName: "org/repo-a" },
      { owner: "org", name: "repo-b", fullName: "org/repo-b" },
    ];
    const html = buildRepoListPage(repos, "system");
    expect(html).toContain('href="/repos/org/repo-a"');
    expect(html).toContain('href="/repos/org/repo-b"');
    expect(html).toContain("org/repo-a");
    expect(html).toContain("org/repo-b");
  });

  it("handles empty repos list", () => {
    const html = buildRepoListPage([], "system");
    expect(html).toContain("No repos found");
  });

  it("includes nav and title", () => {
    const html = buildRepoListPage([], "light");
    expect(html).toContain("Repos");
    expect(html).toContain('data-theme="light"');
    expect(html).toContain('href="/repos"');
  });

  it("shows relative time for repos with lastTaskAt", () => {
    const lastTaskAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const repos = [{ owner: "org", name: "repo-a", fullName: "org/repo-a", lastTaskAt }];
    const html = buildRepoListPage(repos, "system");
    expect(html).toContain("ago");
  });

  it("shows 'no recorded activity' for repos without lastTaskAt", () => {
    const repos = [{ owner: "org", name: "repo-a", fullName: "org/repo-a" }];
    const html = buildRepoListPage(repos, "system");
    expect(html).toContain("no recorded activity");
  });
});

describe("buildBarChart", () => {
  it("returns empty message for no data", () => {
    const result = buildBarChart([]);
    expect(result).toContain("No task data");
  });

  it("returns empty message when all counts are zero", () => {
    const result = buildBarChart([{ date: "2026-03-15", completed: 0, failed: 0 }]);
    expect(result).toContain("No task data");
  });

  it("renders SVG for single day", () => {
    const result = buildBarChart([{ date: "2026-03-15", completed: 5, failed: 2 }]);
    expect(result).toContain("<svg");
    expect(result).toContain("<rect");
    expect(result).toContain("var(--success)");
    expect(result).toContain("var(--danger)");
  });

  it("renders SVG with only successes", () => {
    const result = buildBarChart([
      { date: "2026-03-14", completed: 3, failed: 0 },
      { date: "2026-03-15", completed: 5, failed: 0 },
    ]);
    expect(result).toContain("<svg");
    expect(result).toContain("var(--success)");
    expect(result).not.toContain("var(--danger)");
  });

  it("renders SVG with only failures", () => {
    const result = buildBarChart([
      { date: "2026-03-14", completed: 0, failed: 2 },
      { date: "2026-03-15", completed: 0, failed: 4 },
    ]);
    expect(result).toContain("<svg");
    expect(result).not.toContain("var(--success)");
    expect(result).toContain("var(--danger)");
  });

  it("includes tooltips with date and counts", () => {
    const result = buildBarChart([{ date: "2026-03-15", completed: 5, failed: 2 }]);
    expect(result).toContain("2026-03-15: 5 completed, 2 failed");
  });

  it("renders x-axis day labels", () => {
    const stats = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-03-${String(i + 1).padStart(2, "0")}`,
      completed: i + 1,
      failed: 0,
    }));
    const result = buildBarChart(stats);
    expect(result).toContain("<text");
  });
});
