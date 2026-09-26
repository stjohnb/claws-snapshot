import { describe, it, expect, vi } from "vitest";

// config.js reads CLAWS_FORGEJO_REPOS at module load, so the env has to be set
// before the import below — hoisted, exactly like a vi.mock factory.
vi.hoisted(() => {
  process.env["CLAWS_FORGEJO_REPOS"] = "forge-org/forge-repo";
  process.env["CLAWS_FORGEJO_BASE_URL"] = "https://forge.example.com";
});

import { buildAllPRsPage, buildAllIssuesPage, type AllPRRow, type AllIssueRow, type PRRowStatus } from "./lists.js";
import { setMergeBlockReason, type PR, type Issue, type QueueItem } from "../github.js";
import { LABELS, issueUrl } from "../config.js";

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

  it("shows the Repo cell in short form, with the full name in a title", () => {
    const rows: AllPRRow[] = [{ repo: "org/repo-a", pr: makePR({ number: 10 }) }];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain(`<a href="/repos/org/repo-a" title="org/repo-a">repo-a</a>`);
    expect(html).not.toContain(">org/repo-a<");
  });

  it("shows empty state for no rows", () => {
    const html = buildAllPRsPage([], [], "system");
    expect(html).toContain("No open PRs");
  });

  it("shows the auto-merger's block reason on the PR row (#2971)", () => {
    setMergeBlockReason("org/repo-a", 10, "CI is failing.");
    try {
      const rows: AllPRRow[] = [
        { repo: "org/repo-a", pr: makePR({ number: 10 }) },
        { repo: "org/repo-b", pr: makePR({ number: 11 }) },
      ];
      const html = buildAllPRsPage(rows, [], "system");
      expect(html).toContain('<span class="merge-conflict" title="CI is failing.">&#x26A0; Merge blocked</span>');
      expect(html.match(/Merge blocked/g)).toHaveLength(1);
    } finally {
      setMergeBlockReason("org/repo-a", 10, null);
    }
  });

  it("links a Forgejo repo's PR at the Forgejo host, not github.com (#2650)", () => {
    const rows: AllPRRow[] = [{ repo: "forge-org/forge-repo", pr: makePR({ number: 10 }) }];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain('href="https://forge.example.com/forge-org/forge-repo/pulls/10"');
    expect(html).not.toContain("https://github.com/forge-org/forge-repo");
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

  it("renders the review ledger with model and provider, newest first", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ reviewStatus: "clean", reviewLedger: [
        { headSha: "def4567890", verdict: "clean", mode: "incremental", iteration: 2, provider: "claude", model: "claude-opus-x", createdAt: new Date(Date.now() - 2 * 3600_000).toISOString() },
        { headSha: "abc1234567", verdict: "advisory", mode: "full", iteration: 1, provider: null, model: null, createdAt: new Date(Date.now() - 5 * 3600_000).toISOString() },
      ] }) },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain('<details class="review-ledger"><summary>2 reviews</summary>');
    expect(html).toContain('def4567 · <span class="review-clean">clean</span> · incremental · claude-opus-x (claude) · 2h ago');
    // A null model (backfilled row) drops the model part entirely.
    expect(html).toContain('abc1234 · <span class="review-issues">advisory</span> · full · 5h ago');
    expect(html.indexOf("def4567")).toBeLessThan(html.indexOf("abc1234"));
  });

  it("omits the review ledger when there is none", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ reviewStatus: "clean" }) },
    ];
    expect(buildAllPRsPage(rows, [], "system")).not.toContain('<details class="review-ledger"');
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
    expect(html).toContain('class="data-cards data-cards-wide"');
    expect(html).toContain('data-label="Repo"');
    expect(html).toContain('class="cell-title"');
    expect(html).not.toContain("var(--text-muted)");
  });

  it("renders the wide width tier", () => {
    const html = buildAllPRsPage([], [], "system");
    expect(html).toContain('data-width="wide"');
  });

  it("renders a destructive infra badge and merge-infra button when a tofu plan is present", () => {
    const rows: AllPRRow[] = [
      {
        repo: "org/repo-a",
        pr: makePR({ number: 10 }),
        status: makeStatus({
          infraPaths: ["tofu/main.tf"],
          tofuPlan: { add: 1, change: 0, replace: 0, destroy: 2 },
        }),
      },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain("merge-infra");
    expect(html).toContain("infra-destructive");
    expect(html).toContain("2-");
    expect(html).toContain("Merge infra");
  });

  it("renders a plain infra badge when infraPaths are known but no tofu plan was parsed", () => {
    const rows: AllPRRow[] = [
      {
        repo: "org/repo-a",
        pr: makePR({ number: 10 }),
        status: makeStatus({ infraPaths: ["tofu/main.tf"] }),
      },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain("Infra (tofu)");
    expect(html).not.toContain('class="infra-badge infra-destructive"');
  });

  it("renders the plain merge button when there are no infra paths", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus() },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain("Squash &amp; Merge");
    expect(html).not.toContain("merge-btn merge-infra");
    expect(html).not.toContain('class="infra-badge');
  });

  it("renders an Automerge button for a PR without the label", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }) },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain("markAutomerge('org/repo-a',10, $event, false)");
    expect(html).not.toContain('class="refined-btn refined-done"');
  });

  it("renders the done indicator when the PR already has the Automerge label", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10, labels: [{ name: LABELS.automerge }] }) },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain('<span class="refined-btn refined-done">Automerge</span>');
    expect(html).not.toContain("markAutomerge('org/repo-a',10");
  });

  it("keeps the Automerge button visible while the merge button is blocked", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ checkStatus: "failing" }) },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain("CI failing");
    expect(html).not.toContain("Squash &amp; Merge");
    expect(html).toContain("markAutomerge('org/repo-a',10, $event, false)");
  });

  it("wraps the actions cell contents in an action-stack", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus() },
    ];
    const html = buildAllPRsPage(rows, [], "system");
    expect(html).toContain('<td class="cell-actions" data-label=""><div class="action-stack">');
  });
});

describe("buildAllPRsPage row actions", () => {
  it("renders Prioritise and Skip on every PR row", () => {
    const html = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 10 }) }], [], "system");
    expect(html).toContain(`data-mode="prio" @click="togglePriority('org/repo-a',10, $event)">Prioritise</button>`);
    expect(html).toContain(`@click="skipItem('org/repo-a',10, $event)">Skip</button>`);
  });

  it("renders Unmark only on a PR carrying the Problematic label, so the CI-fixer breaker can be reset", () => {
    const html = buildAllPRsPage([
      { repo: "org/repo-a", pr: makePR({ number: 8, labels: [{ name: LABELS.problematic }] }) },
      { repo: "org/repo-a", pr: makePR({ number: 9 }) },
    ], [], "system");
    expect(html).toContain(`@click="unmarkProblematic('org/repo-a',8, $event)">Unmark problematic</button>`);
    expect(html).not.toContain("unmarkProblematic('org/repo-a',9");
  });

  it("offers Refresh from GitHub, driving the queue rescan", () => {
    const html = buildAllPRsPage([], [], "system");
    expect(html).toContain(`@click="refreshQueue($event)"`);
    expect(html).toContain(`x-text="refreshStatus"`);
  });

  it("shows Restore and a Skipped badge instead of Skip on an already-skipped PR row", async () => {
    const githubMod = await import("../github.js");
    const spy = vi.spyOn(githubMod, "isItemSkipped").mockReturnValue(true);
    try {
      const html = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 10 }) }], [], "system");
      expect(html).toContain(`data-mode="unskip" @click="skipItem('org/repo-a',10, $event)">Restore</button>`);
      expect(html).not.toContain(">Skip<");
      expect(html).toContain('<span class="skip-badge">Skipped</span>');
    } finally {
      spy.mockRestore();
    }
  });
});

describe("buildAllIssuesPage skipped items", () => {
  it("renders Prioritise and Skip on an issue row, quoting a native id", () => {
    const NATIVE_ID = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    const html = buildAllIssuesPage([{ repo: "org/repo", issue: makeIssue({ number: NATIVE_ID }) }], [], "system");
    expect(html).toContain(`togglePriority('org/repo','${NATIVE_ID}', $event)`);
    expect(html).toContain(`skipItem('org/repo','${NATIVE_ID}', $event)`);
  });

  it("shows Restore and a Skipped badge instead of Skip on an already-skipped issue row", async () => {
    const githubMod = await import("../github.js");
    const spy = vi.spyOn(githubMod, "isItemSkipped").mockReturnValue(true);
    try {
      const html = buildAllIssuesPage([{ repo: "org/repo", issue: makeIssue({ number: 5 }) }], [], "system");
      expect(html).toContain(`data-mode="unskip" @click="skipItem('org/repo',5, $event)">Restore</button>`);
      expect(html).not.toContain(">Skip<");
      expect(html).toContain('<span class="skip-badge">Skipped</span>');
    } finally {
      spy.mockRestore();
    }
  });

  it("omits the Skipped section when nothing is skipped", () => {
    const html = buildAllIssuesPage([], [], "system");
    expect(html).not.toContain("Skipped <span>");
    expect(html).not.toContain("@click=\"unskipItem(");
  });

  it("lists skipped items with a Restore button and a link to the item", () => {
    const html = buildAllIssuesPage([], [], "system", [], [{ repo: "org/repo", number: 7 }]);
    expect(html).toContain("Skipped <span>1</span>");
    expect(html).toContain('href="https://github.com/org/repo/issues/7"');
    expect(html).toContain(`@click="unskipItem('org/repo',7, $event)">Restore</button>`);
  });

  it("shows a skipped item's Repo cell in short form, with the full name in a title", () => {
    const html = buildAllIssuesPage([], [], "system", [], [{ repo: "org/repo", number: 7 }]);
    expect(html).toContain(`<a href="/repos/org/repo" title="org/repo">repo</a>`);
    expect(html).not.toContain(">org/repo<");
  });

  it("shows a skipped native issue's short id, with the full id in title", () => {
    const NATIVE_ID = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    const html = buildAllIssuesPage([], [], "system", [], [{ repo: "org/repo", number: NATIVE_ID }]);
    expect(html).toContain(`title="${NATIVE_ID}">#clw_GZ5PDC</a>`);
    expect(html).toContain(`unskipItem('org/repo','${NATIVE_ID}', $event)`);
  });

  it("links a skipped item under an imported forge number to the Claws issue page (clw_01M35GAV079FW4VJ1GN5J19ABM)", async () => {
    const { setImportedRef, resetImportedRefsForTest } = await import("../imported-refs-index.js");
    const NATIVE_ID = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    setImportedRef("org/repo", 7, NATIVE_ID);
    try {
      const html = buildAllIssuesPage([], [], "system", [], [{ repo: "org/repo", number: 7 }]);
      expect(html).toContain(`href="${issueUrl("org/repo", NATIVE_ID)}"`);
      expect(html).not.toContain('href="https://github.com/org/repo/issues/7"');
    } finally {
      resetImportedRefsForTest();
    }
  });

  it("links a skipped Forgejo item at Forgejo, not the GitHub mirror (#2650)", () => {
    const html = buildAllIssuesPage([], [], "system", [], [{ repo: "forge-org/forge-repo", number: 7 }]);
    expect(html).toContain('href="https://forge.example.com/forge-org/forge-repo/issues/7"');
    expect(html).not.toContain("github.com/forge-org/forge-repo");
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

  it("shows the Repo cell in short form, with the full name in a title", () => {
    const rows: AllIssueRow[] = [{ repo: "org/repo-a", issue: makeIssue({ number: 5 }) }];
    const html = buildAllIssuesPage(rows, [], "system");
    expect(html).toContain(`<a href="/repos/org/repo-a" title="org/repo-a">repo-a</a>`);
    expect(html).not.toContain(">org/repo-a<");
  });

  it("shows a native issue's short id as link text, with the full id in the href", () => {
    const NATIVE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    const rows: AllIssueRow[] = [{ repo: "org/repo-a", issue: makeIssue({ number: NATIVE }) }];
    const html = buildAllIssuesPage(rows, [], "system");
    expect(html).toContain(`/issues/${NATIVE}"`);
    expect(html).toContain(">#clw_GZ5PDC</a>");
    expect(html).not.toContain(`>#${NATIVE}<`);
  });

  it("links a Forgejo repo's issue at the Forgejo host, not github.com (#2650)", () => {
    const rows: AllIssueRow[] = [{ repo: "forge-org/forge-repo", issue: makeIssue({ number: 5 }) }];
    const html = buildAllIssuesPage(rows, [], "system");
    expect(html).toContain('href="https://forge.example.com/forge-org/forge-repo/issues/5"');
    expect(html).not.toContain("https://github.com/forge-org/forge-repo");
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
    expect(html).toContain("refined-done");
    expect(html).toContain(">Automerge<");
  });

  it("shows a Refined button when the issue has Automerge but not Refined", () => {
    const rows: AllIssueRow[] = [
      { repo: "org/repo-a", issue: makeIssue({ number: 5, labels: [{ name: LABELS.automerge }] }) },
    ];
    const html = buildAllIssuesPage(rows, [], "system");
    expect(html).toContain("markRefined('org/repo-a',5");
    expect(html).not.toContain('<span class="refined-btn refined-done">Automerge</span>');
  });

  it("marks the table for mobile card rendering with per-cell labels", () => {
    const rows: AllIssueRow[] = [{ repo: "org/repo-a", issue: makeIssue({ number: 5 }) }];
    const html = buildAllIssuesPage(rows, [], "system");
    expect(html).toContain('class="data-cards"');
    expect(html).toContain('data-label="Issue"');
  });

  it("renders the wide width tier", () => {
    const html = buildAllIssuesPage([], [], "system");
    expect(html).toContain('data-width="wide"');
  });

  it("stacks issue action buttons in a fixed-width, non-wrapping column", () => {
    const html = buildAllIssuesPage([{ repo: "org/repo-a", issue: makeIssue({ number: 5 }) }], [], "system");
    expect(html).toContain(`<div class="action-stack">`);
    expect(html).toContain(".refined-btn::after");
    expect(html).toMatch(/\.refined-btn\s*\{[^}]*white-space:\s*nowrap/);
  });
});

describe("buildAllIssuesPage plan block", () => {
  const plan = { summary: "3 sections", requirementHtml: "<p>Need it.</p>", url: "/issues/clw_X#plan" };

  it("renders a collapsed plan block under the title of a row with a plan", () => {
    const html = buildAllIssuesPage([{ repo: "org/repo", issue: makeIssue({ number: 5 }), plan }], [], "system");

    expect(html).toContain(`<details class="list-plan"><summary>Plan · 3 sections</summary><div class="markdown"><p>Need it.</p></div><a href="/issues/clw_X#plan">Full plan</a></details>`);
  });

  it("renders the block on an unassigned row too, and none on a row without a plan", () => {
    const unassigned = [{ id: "clw_X", title: "T", authorLogin: "a", updatedAt: "", repos: [], plan }];
    const html = buildAllIssuesPage([{ repo: "org/repo", issue: makeIssue({ number: 5 }) }], [], "system", unassigned);

    expect(html.match(/<details class="list-plan">/g)).toHaveLength(1);
  });
});
