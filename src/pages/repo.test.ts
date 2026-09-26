import { describe, it, expect, vi } from "vitest";

// config.js reads CLAWS_FORGEJO_REPOS at module load, so the env has to be set
// before the imports below — hoisted, exactly like a vi.mock factory.
vi.hoisted(() => {
  process.env["CLAWS_FORGEJO_REPOS"] = "forge-org/forge-repo";
  process.env["CLAWS_FORGEJO_BASE_URL"] = "https://forge.example.com";
});

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

import { buildRepoPage, buildBarChart, computeAttentionItems, type RepoPageData } from "./repo.js";
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
  it("renders the wide width tier", () => {
    const html = buildRepoPage(makePageData(), "system");
    expect(html).toContain('data-width="wide"');
  });

  it("shows the repo name in short form in the title and heading, with the full name in a title attribute", () => {
    const html = buildRepoPage(makePageData(), "system");
    expect(html).toContain("<title>claws — repo</title>");
    expect(html).toContain(`<h2><a href="https://github.com/org/repo" title="org/repo">repo</a></h2>`);
    expect(html).not.toContain(">org/repo<");
  });

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

  it("renders the tables as data-cards with a data-label on the first data cell", () => {
    const tasks = [makeTask({ job_name: "issue-dispatcher", item_number: 42, status: "completed" })];
    const prs: PR[] = [
      { number: 10, title: "Fix bug", headRefName: "claws/issue-10-abc1", baseRefName: "main", labels: [], author: { login: "claws-bot" }, isCrossRepository: false },
    ];
    const openIssues: Issue[] = [
      { number: 1, title: "Issue 1", body: "", labels: [], author: { login: "user" } },
    ];
    const html = buildRepoPage(makePageData({ recentTasks: tasks, openPRs: prs, openIssues }), "system");
    expect(html).toContain('class="data-cards"');
    expect(html).toContain('data-label="Job"');
    expect(html).toContain('data-label="PR"');
    expect(html).toContain('data-label="Issue"');
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

  it("points the repo heading, PR and issue links at Forgejo for a Forgejo repo (#2650)", () => {
    const prs: PR[] = [
      { number: 10, title: "Fix bug", headRefName: "claws/issue-10-abc1", baseRefName: "main", labels: [], author: { login: "claws-bot" }, isCrossRepository: false },
    ];
    const openIssues: Issue[] = [
      { number: 7, title: "Bug", body: "", labels: [], author: { login: "human" } },
    ];
    const html = buildRepoPage(
      makePageData({ owner: "forge-org", name: "forge-repo", openPRs: prs, openIssues }),
      "system",
    );
    expect(html).toContain('href="https://forge.example.com/forge-org/forge-repo"');
    expect(html).toContain('href="https://forge.example.com/forge-org/forge-repo/pulls/10"');
    expect(html).toContain('href="https://forge.example.com/forge-org/forge-repo/issues/7"');
    expect(html).not.toContain("https://github.com/forge-org/forge-repo");
  });

  it("keeps a GitHub repo's links on github.com", () => {
    const prs: PR[] = [
      { number: 10, title: "Fix bug", headRefName: "claws/issue-10-abc1", baseRefName: "main", labels: [], author: { login: "claws-bot" }, isCrossRepository: false },
    ];
    const html = buildRepoPage(makePageData({ openPRs: prs }), "system");
    expect(html).toContain('href="https://github.com/org/repo/pull/10"');
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
    expect(html).toContain('href="/jobs"');
  });

  it("omits the attention panel when nothing needs input", () => {
    const openIssues: Issue[] = [
      { number: 1, title: "Ordinary issue", body: "", labels: [{ name: "Refined" }], author: { login: "user" } },
    ];
    const html = buildRepoPage(makePageData({ openIssues }), "system");
    expect(html).not.toContain('<div class="section attention-panel">');
    expect(html).not.toContain("<h2>Needs your input");
  });

  it("renders the attention panel for Manual Action issues, Problematic PRs and Ready issues", () => {
    const openIssues: Issue[] = [
      { number: 1, title: "Paused issue", body: "", labels: [{ name: "Manual Action" }], author: { login: "user" } },
      { number: 2, title: "Finished issue", body: "", labels: [{ name: "Ready" }], author: { login: "user" } },
    ];
    const openPRs: PR[] = [
      { number: 30, title: "Stuck PR", headRefName: "claws/x", baseRefName: "main", labels: [{ name: "Claws Problematic" }], author: { login: "claws-bot" }, isCrossRepository: false },
    ];
    const html = buildRepoPage(makePageData({ openIssues, openPRs }), "system");
    expect(html).toContain("Needs your input");
    expect(html).toContain('<a href="https://github.com/org/repo/issues/1">#1</a> Paused issue');
    expect(html).toContain("Claws paused — needs your decision");
    expect(html).toContain('<a href="https://github.com/org/repo/pull/30">#30</a> Stuck PR');
    expect(html).toContain("CI fixes exhausted — needs manual intervention");
    expect(html).toContain('<a href="https://github.com/org/repo/issues/2">#2</a> Finished issue');
    expect(html).toContain("Claws finished — needs your review");
  });

  it("escapes issue titles in the attention panel", () => {
    const openIssues: Issue[] = [
      { number: 9, title: "<script>alert(1)</script>", body: "", labels: [{ name: "Manual Action" }], author: { login: "user" } },
    ];
    const html = buildRepoPage(makePageData({ openIssues }), "system");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

});

describe("computeAttentionItems", () => {
  it("orders Manual Action issues, then Problematic PRs, then Ready issues", () => {
    const openIssues: Issue[] = [
      { number: 2, title: "Ready", body: "", labels: [{ name: "Ready" }], author: { login: "u" } },
      { number: 1, title: "Paused", body: "", labels: [{ name: "Manual Action" }], author: { login: "u" } },
      { number: 3, title: "Plain", body: "", labels: [], author: { login: "u" } },
    ];
    const openPRs: PR[] = [
      { number: 30, title: "Stuck", headRefName: "b", baseRefName: "main", labels: [{ name: "Claws Problematic" }], author: { login: "u" }, isCrossRepository: false },
      { number: 31, title: "Fine", headRefName: "b2", baseRefName: "main", labels: [], author: { login: "u" }, isCrossRepository: false },
    ];
    expect(computeAttentionItems(openIssues, openPRs)).toEqual([
      { kind: "issue", number: 1, title: "Paused", reason: "Claws paused — needs your decision" },
      { kind: "pr", number: 30, title: "Stuck", reason: "CI fixes exhausted — needs manual intervention" },
      { kind: "issue", number: 2, title: "Ready", reason: "Claws finished — needs your review" },
    ]);
  });

  it("returns an empty list when nothing is labelled", () => {
    expect(computeAttentionItems([], [])).toEqual([]);
  });

  it("excludes a Blocked issue even when it also carries Ready or Manual Action", () => {
    const openIssues: Issue[] = [
      { number: 4, title: "Parked", body: "", labels: [{ name: "Ready" }, { name: "Blocked" }], author: { login: "u" } },
      { number: 5, title: "Also parked", body: "", labels: [{ name: "Manual Action" }, { name: "Blocked" }], author: { login: "u" } },
    ];
    expect(computeAttentionItems(openIssues, [])).toEqual([]);
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
