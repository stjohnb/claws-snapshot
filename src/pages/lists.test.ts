import { describe, it, expect } from "vitest";
import { buildAllPRsPage, buildAllIssuesPage, type AllPRRow, type AllIssueRow, type PRRowStatus } from "./lists.js";
import type { PR, Issue, QueueItem } from "../github.js";
import { LABELS } from "../config.js";

function makePR(overrides: Partial<PR> = {}): PR {
  return {
    number: 1,
    title: "Fix bug",
    headRefName: "claws/issue-1-abc1",
    baseRefName: "main",
    labels: [],
    author: { login: "claws-bot" },
    ...overrides,
  };
}

function makeStatus(overrides: Partial<PRRowStatus> = {}): PRRowStatus {
  return {
    checkStatus: "passing",
    checksPassed: 1,
    checksTotal: 1,
    mergeableState: "MERGEABLE",
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: "Something broke",
    body: "",
    labels: [],
    author: { login: "user" },
    ...overrides,
  };
}

describe("buildAllPRsPage", () => {
  it("renders rows from multiple repos with count and category badge", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10, title: "Fix A", updatedAt: "2026-03-15T00:00:00Z" }) },
      { repo: "org/repo-b", pr: makePR({ number: 20, title: "Fix B", updatedAt: "2026-03-14T00:00:00Z" }) },
    ];
    const queueItems: QueueItem[] = [
      { repo: "org/repo-a", number: 10, title: "Fix A", category: "refined", updatedAt: "2026-03-15T00:00:00Z", type: "pr" },
    ];
    const html = buildAllPRsPage(rows, queueItems, "system");
    expect(html).toContain("org/repo-a");
    expect(html).toContain("org/repo-b");
    expect(html).toContain('href="https://github.com/org/repo-a/pull/10"');
    expect(html).toContain('href="https://github.com/org/repo-b/pull/20"');
    expect(html).toContain("#10");
    expect(html).toContain("#20");
    expect(html).toContain("Open PRs <span>2</span>");
    expect(html).toContain("Refined");
  });

  it("shows empty state for no rows", () => {
    const html = buildAllPRsPage([], [], "system");
    expect(html).toContain("No open PRs");
  });

  it("escapes a malicious PR title", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ title: "<script>alert(1)</script>" }) },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders a merge button and wires up the queue Alpine component", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ checksPassed: 3, checksTotal: 3, reviewStatus: "clean" }) },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain("Squash &amp; Merge");
    expect(html).toContain("mergePR(");
    expect(html).toContain('x-data="queuePage()"');
  });

  it("hides the merge button when the PR is conflicting", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }) },
    ];
    const queueItems: QueueItem[] = [
      { repo: "org/repo-a", number: 10, title: "Fix A", category: "refined", updatedAt: "2026-03-15T00:00:00Z", mergeableState: "CONFLICTING", type: "pr" },
    ];
    const html = buildAllPRsPage(rows, queueItems, "system");
    expect(html).not.toContain("mergePR('org/repo-a',10");
  });

  it("renders Conflicts instead of the button for a conflicting bulk status", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ mergeableState: "CONFLICTING" }) },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).not.toContain("mergePR('org/repo-a',10");
    expect(html).toContain("Conflicts");
  });

  it("always renders a checks column, including for PRs with no CI", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ checkStatus: "none", checksPassed: 0, checksTotal: 0 }) },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain("<th>Checks</th>");
    expect(html).toContain("no checks");
    // No CI configured must not block merging
    expect(html).toContain("mergePR('org/repo-a',10");
  });

  it("renders unknown checks when no status is available", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }) },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain("unknown");
    expect(html).not.toContain("mergePR('org/repo-a',10");
  });

  it("shows the failing check counts and blocks the button", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ checkStatus: "failing", checksPassed: 3, checksTotal: 5 }) },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain("&#x2718; 3/5");
    expect(html).toContain("CI failing");
    expect(html).not.toContain("mergePR('org/repo-a',10");
  });

  it("blocks the button while checks are pending", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ checkStatus: "pending", checksPassed: 1, checksTotal: 4 }) },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain("&#x25CB; 1/4");
    expect(html).toContain("CI pending");
    expect(html).not.toContain("mergePR('org/repo-a',10");
  });

  it("blocks the button when the review reported issues", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ reviewStatus: "issues", reviewIssueCount: 2 }) },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain("Review: 2 issues");
    expect(html).toContain("2 issues found");
    expect(html).not.toContain("mergePR('org/repo-a',10");
  });

  it("blocks the button when the review escalated", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ reviewStatus: "escalated" }) },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain("Review escalated");
    expect(html).toContain("Escalated — needs human");
    expect(html).not.toContain("mergePR('org/repo-a',10");
  });

  it("shows the button for a passing PR with no Claws review", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ reviewStatus: "none" }) },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain("mergePR('org/repo-a',10");
    expect(html).toContain("<th>Review</th>");
  });

  it("falls back to the queue item status when the bulk fetch produced nothing", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }) },
    ];
    const queueItems: QueueItem[] = [
      { repo: "org/repo-a", number: 10, title: "Fix A", category: "refined", updatedAt: "2026-03-15T00:00:00Z", type: "pr", checkStatus: "failing", checksPassed: 1, checksTotal: 2 },
    ];
    const html = buildAllPRsPage(rows, queueItems, "system");
    expect(html).toContain("&#x2718; 1/2");
    expect(html).toContain("CI failing");
  });

  it("marks the table for mobile card rendering with per-cell labels", () => {
    const rows: AllPRRow[] = [{ repo: "org/repo-a", pr: makePR({ number: 10 }) }];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain('class="data-cards"');
    expect(html).toContain('data-label="Repo"');
    expect(html).toContain('class="cell-title"');
    expect(html).not.toContain("var(--text-muted)");
  });
});

describe("buildAllIssuesPage", () => {
  it("renders rows from multiple repos with count and category badge", () => {
    const rows: AllIssueRow[] = [
      { repo: "org/repo-a", issue: makeIssue({ number: 5, title: "Bug A", updatedAt: "2026-03-15T00:00:00Z" }) },
      { repo: "org/repo-b", issue: makeIssue({ number: 6, title: "Bug B", updatedAt: "2026-03-14T00:00:00Z" }) },
    ];
    const queueItems: QueueItem[] = [
      { repo: "org/repo-a", number: 5, title: "Bug A", category: "needs-triage", updatedAt: "2026-03-15T00:00:00Z", type: "issue" },
    ];
    const html = buildAllIssuesPage(rows, queueItems, "system");
    expect(html).toContain("org/repo-a");
    expect(html).toContain("org/repo-b");
    expect(html).toContain('href="https://github.com/org/repo-a/issues/5"');
    expect(html).toContain('href="https://github.com/org/repo-b/issues/6"');
    expect(html).toContain("#5");
    expect(html).toContain("#6");
    expect(html).toContain("Open Issues <span>2</span>");
    expect(html).toContain("Needs Triage");
  });

  it("shows empty state for no rows", () => {
    const html = buildAllIssuesPage([], [], "system");
    expect(html).toContain("No open issues");
  });

  it("escapes a malicious issue title", () => {
    const rows: AllIssueRow[] = [
      { repo: "org/repo-a", issue: makeIssue({ title: "<script>alert(1)</script>" }) },
    ];
    const html = buildAllIssuesPage(rows, [], "system");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders a refined button and a Refine & Merge button for an unrefined issue", () => {
    const rows: AllIssueRow[] = [
      { repo: "org/repo-a", issue: makeIssue({ number: 5 }) },
    ];
    const html = buildAllIssuesPage(rows, [], "system");
    expect(html).toContain("markRefined(");
    expect(html).toContain(">Refined<");
    expect(html).toContain("markAutomerge('org/repo-a',5, $event, true)");
  });

  it("hides the refined button and shows an Automerge button when the issue already has the Refined label", () => {
    const rows: AllIssueRow[] = [
      { repo: "org/repo-a", issue: makeIssue({ number: 5, labels: [{ name: LABELS.refined }] }) },
    ];
    const html = buildAllIssuesPage(rows, [], "system");
    expect(html).not.toContain("markRefined('org/repo-a',5");
    expect(html).toContain("markAutomerge('org/repo-a',5, $event, false)");
  });

  it("shows a disabled Automerge indicator when the issue already has the Automerge label", () => {
    const rows: AllIssueRow[] = [
      { repo: "org/repo-a", issue: makeIssue({ number: 5, labels: [{ name: LABELS.refined }, { name: LABELS.automerge }] }) },
    ];
    const html = buildAllIssuesPage(rows, [], "system");
    expect(html).not.toContain("markRefined('org/repo-a',5");
    expect(html).not.toContain("markAutomerge('org/repo-a',5");
    expect(html).toContain("Automerge ✓");
  });

  it("marks the table for mobile card rendering with per-cell labels", () => {
    const rows: AllIssueRow[] = [{ repo: "org/repo-a", issue: makeIssue({ number: 5 }) }];
    const html = buildAllIssuesPage(rows, [], "system");
    expect(html).toContain('class="data-cards"');
    expect(html).toContain('data-label="Issue"');
  });
});
