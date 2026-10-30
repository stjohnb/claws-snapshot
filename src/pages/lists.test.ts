import { describe, it, expect, vi } from "vitest";

// config.js reads CLAWS_FORGEJO_REPOS at module load, so the env has to be set
// before the import below — hoisted, exactly like a vi.mock factory.
vi.hoisted(() => {
  process.env["CLAWS_FORGEJO_REPOS"] = "forge-org/forge-repo";
  process.env["CLAWS_FORGEJO_BASE_URL"] = "https://forge.example.com";
});

import { buildAllPRsPage, buildAllIssuesPage, splitPRRows, type AllPRRow, type AllIssueRow, type PRRowStatus } from "./lists.js";
import { DEFAULT_PRS_QUERY } from "./prs-view.js";
import { setCiFixerGaveUp, setMergeBlockReason, type PR, type Issue, type QueueItem } from "../github.js";
import { LABELS, issueUrl } from "../config.js";
import type { ClawsPrRecord } from "../db.js";

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

/** A `claws_prs` row — the PR state /prs reads, never `pr.labels`. */
function makeRow(prNumber: number, overrides: Partial<ClawsPrRecord> = {}): ClawsPrRecord {
  return {
    repo: "org/repo-a", prNumber, issueId: null, phase: null, headSha: null, observedAt: null,
    stage: "awaiting-review", ciStatus: null, mergeableState: null, reviewVerdict: null, reviewedSha: null,
    mergeApprovedBy: null, mergeApprovedAt: null, manualActionReason: null, needsHumanReview: false,
    ciBlockedReason: null, infraMergeApprovedBy: null, infraMergeApprovedAt: null, infraMergeApprovedSha: null, title: null, dispatchNote: null, dispatchNoteAt: null, createdAt: "", updatedAt: "", ...overrides,
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
    const html = buildAllPRsPage(rows, queueItems, "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("org/repo-a");
    expect(html).toContain("org/repo-b");
    expect(html).toContain('href="https://forge.example.com/org/repo-a/pulls/10"');
    expect(html).toContain('href="https://forge.example.com/org/repo-b/pulls/20"');
    expect(html).toContain("#10");
    expect(html).toContain("#20");
    expect(html).toContain("Open PRs <span>2</span>");
    expect(html).toContain("Refined");
  });

  it("renders the default view as date created, ascending, oldest first", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10, createdAt: "2026-03-01T00:00:00Z" }) },
      { repo: "org/repo-a", pr: makePR({ number: 11, createdAt: "2026-01-01T00:00:00Z" }) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain('<option value="created" selected>Date created</option>');
    expect(html).toContain('<option value="asc" selected>Ascending</option>');
    expect(html).toContain("prs-sort-created");
    expect(html.indexOf("#11")).toBeLessThan(html.indexOf("#10"));
  });

  it("shows the Repo cell in short form, with the full name in a title", () => {
    const rows: AllPRRow[] = [{ repo: "org/repo-a", pr: makePR({ number: 10 }) }];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain(`<a href="/repos/org/repo-a" title="org/repo-a"><span class="repo-avatar" aria-hidden="true">r</span><span class="pr-repo-name">repo-a</span></a>`);
    expect(html).not.toContain(">org/repo-a<");
  });

  it("offers Start session on each row, and Go to session instead while a PR-started session is live", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }) },
      { repo: "forge-org/forge-repo", pr: makePR({ number: 11 }), activeSession: "sess123" },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain(`<button class="refined-btn pr-start-session" @click="startPrSession('org/repo-a',10, $event)" title="Start session for org/repo-a#10" aria-label="Start session for org/repo-a#10"><span class="pr-icon" aria-hidden="true"><span class="pr-icon-terminal">&gt;_</span></span><span class="pr-label">Start session</span></button>`);
    expect(html).toContain(`<a class="refined-btn pr-go-to-session" href="/sessions/sess123" title="Go to session for forge-org/forge-repo#11" aria-label="Go to session for forge-org/forge-repo#11"><span class="pr-icon" aria-hidden="true"><svg`);
    expect(html).toContain(`<span class="pr-label">Go to session</span></a>`);
    expect(html).not.toContain("startPrSession('forge-org/forge-repo'");
    expect(html.match(/class="refined-btn pr-start-session"/g)).toHaveLength(1);
  });

  it("shows empty state for no rows", () => {
    const html = buildAllPRsPage([], [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("No open PRs");
  });

  describe("phone icon controls", () => {
    it("gives every icon button an icon, a label and a tooltip, and keeps text on the rest", () => {
      const rows: AllPRRow[] = [{
        repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ reviewStatus: "clean" }),
        prRow: makeRow(10, { manualActionReason: "do a thing", manualActionStatus: "pending" } as never),
      }];
      const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
      const buttons = html.match(/<button class="(?:merge-btn|refined-btn)[^"]*"[^>]*>[\s\S]*?<\/button>/g) ?? [];
      const iconic = buttons.filter((b) => b.includes('class="pr-icon"') || b.includes('class="pr-icon" '));
      expect(iconic.length).toBeGreaterThanOrEqual(5);
      for (const b of iconic) {
        expect(b).toContain('<span class="pr-label">');
        if (!b.includes("pr-clear-manual-btn") && !b.includes("pr-unmark-btn")) expect(b).toMatch(/ title="[^"]+"/);
      }
      // Every action button pairs an icon with a visible label.
      for (const b of buttons) {
        expect(b).toContain('class="pr-icon"');
        expect(b).toContain('<span class="pr-label">');
      }
      expect(html).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
      expect(html).not.toContain("clip-path: inset(50%)");
    });

    it("keeps the Automerge done state distinct and the base CSS hides the icon", () => {
      const html = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 10 }), prRow: makeRow(10, { mergeApprovedAt: "t", mergeApprovedBy: "dashboard" }) }], [], "system", DEFAULT_PRS_QUERY);
      expect(html).toContain('class="refined-btn pr-automerge-btn refined-done"');
      expect(html).toContain("  .pr-icon { display: none; }");
    });

    it("renders CI chips as labelled icons that keep the count", () => {
      const render = (checkStatus: "passing" | "pending" | "failing") =>
        buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ checkStatus, checksPassed: 2, checksTotal: 2 }) }], [], "system", DEFAULT_PRS_QUERY);
      expect(render("passing")).toContain('role="img" aria-label="CI passing 2/2" title="CI passing 2/2"><span aria-hidden="true">✔ 2/2</span>');
      expect(render("pending")).toContain('aria-label="CI pending 2/2"');
      expect(render("failing")).toContain('aria-label="CI failing 2/2');
    });
  });

  describe("phone card", () => {
    it("marks the table prs-compact and prefixes the PR link with the phone-only repo name", () => {
      const html = buildAllPRsPage([{ repo: "org/fleet-infra", pr: makePR({ number: 239 }) }], [], "system", DEFAULT_PRS_QUERY);
      expect(html).toContain('<table class="data-cards data-cards-wide prs-compact prs-sort-created">');
      expect(html).toContain(`<a href="https://forge.example.com/org/fleet-infra/pulls/239"><span class="pr-phone-only">fleet-infra</span>#239</a>`);
    });

    it("shows a CI-failing, fixer-gave-up PR's failure and attention once each", () => {
      setCiFixerGaveUp("org/repo-a", 27, "493bbc2");
      try {
        const rows: AllPRRow[] = [{
          repo: "org/repo-a", pr: makePR({ number: 27 }),
          prRow: makeRow(27, { headSha: "493bbc2" }),
          status: makeStatus({ checkStatus: "failing", checksPassed: 5, checksTotal: 7 }),
        }];
        const note = "CI fixer: the agent gave up on head 493bbc2 — not dispatching again until the head changes";
        const queueItems: QueueItem[] = [{ repo: "org/repo-a", number: 27, title: "Fix", category: "ci-failing", updatedAt: "", type: "pr", note }];
        const html = buildAllPRsPage(rows, queueItems, "system", DEFAULT_PRS_QUERY);
        expect(html.match(/class="pr-phone-only pr-chip pr-chip-danger" role="img" aria-label="CI failing 5\/7[^"]*" title="CI failing 5\/7[^"]*"><span aria-hidden="true">✘ 5\/7<\/span>/g)).toHaveLength(1);
        expect(html.match(/class="preview-peek pr-phone-only pr-peek"/g)).toHaveLength(1);
        const peek = html.match(/<details class="preview-peek pr-phone-only pr-peek" data-preview-title="Needs you">.*?<\/details>/)?.[0] ?? "";
        expect(peek).toContain('<span class="pr-chip-operator">Needs you</span>');
        expect(peek).toContain("<li>CI fixer gave up</li>");
        expect(peek).toContain(`<p>${note}</p>`);
        expect(peek).not.toContain("<a ");
        expect(html).toMatch(/<span class="pr-hide-phone"><span class="pipeline-badge"[^>]*>CI Failing<\/span><\/span>/);
      } finally {
        setCiFixerGaveUp("org/repo-a", 27, null);
      }
    });

    it("labels a dispatch note without attention reasons as a neutral Waiting peek", () => {
      const queueItems: QueueItem[] = [{ repo: "org/repo-a", number: 10, title: "Fix", category: "refined", updatedAt: "", type: "pr", note: "Waiting for <review>" }];
      const html = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 10 }) }], queueItems, "system", DEFAULT_PRS_QUERY);
      expect(html).toContain(`data-preview-title="Waiting"><summary><span class="pr-chip pr-chip-neutral">Waiting</span></summary><div class="markdown"><p>Waiting for &lt;review&gt;</p></div></details>`);
    });

    it("emits no peek without attention reasons or a note", () => {
      const html = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus() }], [], "system", DEFAULT_PRS_QUERY);
      expect(html).not.toContain("<details class=\"preview-peek");
    });

    it("shows approval-exempt as a chip", () => {
      const html = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 10 }), approvalExempt: true }], [], "system", DEFAULT_PRS_QUERY);
      expect(html).toMatch(/<span class="pr-phone-only pr-chip pr-chip-neutral" title="Approval-exempt:[^"]*">Approval-exempt<\/span>/);
    });

    it("emits a review chip only when there is a review", () => {
      const none = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ reviewStatus: "none" }) }], [], "system", DEFAULT_PRS_QUERY);
      expect(none).not.toContain(">Reviewed<");
      expect(none).not.toMatch(/pr-chip[^"]*">[^<]*issues? found</);
      const clean = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ reviewStatus: "clean" }) }], [], "system", DEFAULT_PRS_QUERY);
      expect(clean).toMatch(/<span class="pr-phone-only pr-chip pr-chip-success" role="img" aria-label="Reviewed — clean" title="Reviewed — clean"><span aria-hidden="true"><svg/);
    });

    it("shows a Conflicts chip for a conflicting PR", () => {
      const html = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ mergeableState: "CONFLICTING" }) }], [], "system", DEFAULT_PRS_QUERY);
      expect(html).toContain('<span class="pr-phone-only pr-chip pr-chip-danger">Conflicts</span>');
    });
  });

  it("renders the CI Failing badge and the escaped dispatch note under the title", () => {
    const rows: AllPRRow[] = [{ repo: "org/repo-a", pr: makePR({ number: 10, title: "Fix A" }) }];
    const queueItems: QueueItem[] = [
      { repo: "org/repo-a", number: 10, title: "Fix A", category: "ci-failing", updatedAt: "", type: "pr", note: "CI fixer: waiting for <build>" },
    ];
    const html = buildAllPRsPage(rows, queueItems, "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("CI Failing");
    expect(html).toContain('<div class="dispatch-note">CI fixer: waiting for &lt;build&gt;</div>');
  });

  it("shows the auto-merger's block reason on the PR row (#2971)", () => {
    setMergeBlockReason("org/repo-a", 10, "CI is failing.");
    try {
      const rows: AllPRRow[] = [
        { repo: "org/repo-a", pr: makePR({ number: 10 }) },
        { repo: "org/repo-b", pr: makePR({ number: 11 }) },
      ];
      const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
      expect(html).toContain('<span class="merge-conflict" title="CI is failing.">&#x26A0; Merge blocked</span>');
      expect(html.match(/class="merge-conflict"/g)).toHaveLength(1);
      expect(html.match(/role="img" aria-label="Merge blocked: CI is failing\."/g)).toHaveLength(1);
      expect(html).toContain(".pr-chips > .merge-conflict { display: none; }");
    } finally {
      setMergeBlockReason("org/repo-a", 10, null);
    }
  });

  describe("Awaiting approval badge", () => {
    const clean = () => makeStatus({ reviewStatus: "clean" });
    const render = (row: Partial<AllPRRow>, queueItems: QueueItem[] = []) =>
      buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 10 }), prRow: makeRow(10), status: clean(), ...row }], queueItems, "system", DEFAULT_PRS_QUERY);

    it("shows on an unapproved, non-exempt row with a clean review and green CI", () => {
      const html = render({});
      expect(html).toContain('title="Approve the merge from the dashboard (Automerge or Merge)">Awaiting approval</span>');
      expect(render({ status: makeStatus({ reviewStatus: "clean", checkStatus: "none" }) })).toContain("Awaiting approval");
    });

    it("uses the hold reason as the badge title when given", () => {
      expect(render({ approvalHoldReason: "update type unknown (body has no Renovate table)" })).toContain('title="update type unknown (body has no Renovate table)">Awaiting approval</span>');
    });

    it("is hidden once the merge is approved", () => {
      expect(render({ prRow: makeRow(10, { mergeApprovedAt: "t", mergeApprovedBy: "oidc-sub-1" }) })).not.toContain("Awaiting approval");
    });

    it("is hidden for an approval-exempt PR", () => {
      expect(render({ approvalExempt: true })).not.toContain("Awaiting approval");
    });

    it("shows with its hold reason on a clean, green, unapproved, non-exempt dependency PR", () => {
      const html = render({
        pr: makePR({ number: 10, headRefName: "renovate/major-dep", author: { login: "renovate[bot]" }, labels: [{ name: "major-update" }] }),
        approvalHoldReason: "major update",
      });
      expect(html).toContain('title="major update">Awaiting approval</span>');
      expect(html).not.toContain("Waiting for window");
    });

    it("offers Automerge and the auto-bump hold reason on an auto-bump PR whose diff is not an image-pin-only bump", () => {
      const html = render({
        pr: makePR({ number: 10, headRefName: "automation/bump-bonkus-v2026-10-12.3", labels: [{ name: "auto-bump" }] }),
        approvalExempt: false,
        approvalHoldReason: "auto-bump diff is not an image-pin-only bump",
      });
      expect(html).toContain("markAutomerge('org/repo-a',10, $event, false)");
      expect(html).toContain('title="auto-bump diff is not an image-pin-only bump">Awaiting approval</span>');
    });

    it("is hidden when CI is failing, the review is not clean, it conflicts or a manual action is recorded", () => {
      expect(render({ status: makeStatus({ reviewStatus: "clean", checkStatus: "failing" }) })).not.toContain("Awaiting approval");
      expect(render({ status: makeStatus({ reviewStatus: "issues" }) })).not.toContain("Awaiting approval");
      expect(render({ status: makeStatus({ reviewStatus: "clean", mergeableState: "CONFLICTING" }) })).not.toContain("Awaiting approval");
      expect(render({ prRow: makeRow(10, { manualActionReason: "set secrets" }) })).not.toContain("Awaiting approval");
    });

    it("notes an escalated PR will not merge, but not for a generic manual action", () => {
      expect(render({ prRow: makeRow(10, { manualActionReason: "review escalated: round cap — x" }) })).toContain("Escalated — won");
      expect(render({ prRow: makeRow(10, { manualActionReason: "manual action" }) })).not.toContain("Escalated — won");
    });
  });

  it("links a Forgejo repo's PR at the Forgejo host, not github.com (#2650)", () => {
    const rows: AllPRRow[] = [{ repo: "forge-org/forge-repo", pr: makePR({ number: 10 }) }];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain('href="https://forge.example.com/forge-org/forge-repo/pulls/10"');
    expect(html).not.toContain("https://github.com/forge-org/forge-repo");
  });

  it("escapes a malicious PR title", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ title: "<script>alert(1)</script>" }) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders a merge button and wires up the queue Alpine component", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ checksPassed: 3, checksTotal: 3, reviewStatus: "clean" }) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
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
    const html = buildAllPRsPage(rows, queueItems, "system", DEFAULT_PRS_QUERY);
    expect(html).not.toContain("mergePR('org/repo-a',10");
  });

  it("renders Conflicts instead of the button for a conflicting bulk status", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ mergeableState: "CONFLICTING" }) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).not.toContain("mergePR('org/repo-a',10");
    expect(html).toContain("Conflicts");
  });

  it("always renders a checks column, including for PRs with no CI", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ checkStatus: "none", checksPassed: 0, checksTotal: 0 }) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain(">Checks</a></th>");
    expect(html).toContain("no checks");
    // No CI configured must not block merging
    expect(html).toContain("mergePR('org/repo-a',10");
  });

  it("renders unknown checks when no status is available", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("unknown");
    expect(html).not.toContain("mergePR('org/repo-a',10");
  });

  it("shows the failing check counts and blocks the button", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ checkStatus: "failing", checksPassed: 3, checksTotal: 5 }) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("&#x2718; 3/5");
    expect(html).toContain("CI failing");
    expect(html).not.toContain("mergePR('org/repo-a',10");
  });

  // A PR already carrying a completed, up-to-date review is waiting only on a
  // human to merge — the wording tells the operator CI-fixer isn't spending a
  // fresh run on it merely because it stays open (issue clw_01M3F9340HHVH185YR16PXVKWK).
  it("shows the not-auto-fixed wording for an idle PR with failing checks", () => {
    const rows: AllPRRow[] = [
      {
        repo: "org/repo-a",
        pr: makePR({ number: 10, headRefOid: "abc123" }),
        status: makeStatus({ checkStatus: "failing" }),
        prRow: makeRow(10, { stage: "awaiting-merge", reviewedSha: "abc123", headSha: "abc123" }),
      },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("CI failing — not auto-fixed while awaiting your merge decision");
  });

  it("shows plain CI failing wording for a merge-approved PR with failing checks", () => {
    const rows: AllPRRow[] = [
      {
        repo: "org/repo-a",
        pr: makePR({ number: 10, headRefOid: "abc123" }),
        status: makeStatus({ checkStatus: "failing" }),
        prRow: makeRow(10, {
          stage: "awaiting-merge", reviewedSha: "abc123", headSha: "abc123",
          mergeApprovedAt: "2026-09-27T00:00:00Z", mergeApprovedBy: "dashboard",
        }),
      },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("CI failing");
    expect(html).not.toContain("not auto-fixed");
  });

  it("shows plain CI failing wording for an approval-exempt PR with failing checks", () => {
    const rows: AllPRRow[] = [
      {
        repo: "org/repo-a",
        pr: makePR({ number: 10, headRefOid: "abc123" }),
        status: makeStatus({ checkStatus: "failing" }),
        prRow: makeRow(10, { stage: "awaiting-merge", reviewedSha: "abc123", headSha: "abc123" }),
        approvalExempt: true,
      },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("CI failing");
    expect(html).not.toContain("not auto-fixed");
  });

  it("blocks the button while checks are pending", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ checkStatus: "pending", checksPassed: 1, checksTotal: 4 }) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("&#x25CB; 1/4");
    expect(html).toContain("CI pending");
    expect(html).not.toContain("mergePR('org/repo-a',10");
  });

  it("shows runs held for approval as held, distinct from CI failing, and blocks the button", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ checkStatus: "held", checksPassed: 0, checksTotal: 3 }) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("&#x23F8; held 0/3");
    expect(html).toContain("Held for approval");
    expect(html).not.toContain("CI failing");
    expect(html).not.toContain("mergePR('org/repo-a',10");
  });

  it("blocks the button when the review reported issues", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ reviewStatus: "issues", reviewIssueCount: 2 }) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("Review: 2 issues");
    expect(html).toContain("2 issues found");
    expect(html).not.toContain("mergePR('org/repo-a',10");
  });

  it("blocks the button when the review escalated", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ reviewStatus: "escalated" }) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("Review escalated");
    expect(html).toContain("Escalated — needs human");
    expect(html).not.toContain("mergePR('org/repo-a',10");
  });

  it("shows the button for a passing PR with no Claws review", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ reviewStatus: "none" }) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
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
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
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
    expect(buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY)).not.toContain('<details class="review-ledger"');
  });

  it("falls back to the queue item status when the bulk fetch produced nothing", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }) },
    ];
    const queueItems: QueueItem[] = [
      { repo: "org/repo-a", number: 10, title: "Fix A", category: "refined", updatedAt: "2026-03-15T00:00:00Z", type: "pr", checkStatus: "failing", checksPassed: 1, checksTotal: 2 },
    ];
    const html = buildAllPRsPage(rows, queueItems, "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("&#x2718; 1/2");
    expect(html).toContain("CI failing");
  });

  it("marks the table for mobile card rendering with per-cell labels", () => {
    const rows: AllPRRow[] = [{ repo: "org/repo-a", pr: makePR({ number: 10 }) }];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain('class="data-cards data-cards-wide prs-compact prs-sort-created"');
    expect(html).toContain('data-label="Repo"');
    expect(html).toContain('class="cell-title"');
    expect(html).not.toContain("var(--text-muted)");
  });

  it("renders the wide width tier", () => {
    const html = buildAllPRsPage([], [], "system", DEFAULT_PRS_QUERY);
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
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("merge-infra");
    expect(html).toContain("infra-destructive");
    expect(html).toContain("2-");
    expect(html).toContain("Merge infra");
  });

  describe("infra hold note", () => {
    const pinFiles = ["tofu/versions.tf", "tofu/.terraform.lock.hcl"];
    function infraRow(status: Partial<PRRowStatus>, approvalExempt = true): AllPRRow {
      return {
        repo: "org/repo-a",
        pr: makePR({ number: 10, author: { login: "dependabot[bot]" } }),
        approvalExempt,
        status: makeStatus({ infraPaths: pinFiles, infraPinOnly: true, ...status }),
      };
    }

    it("says a plan with changes needs a human merge", () => {
      const html = buildAllPRsPage([infraRow({
        tofuPlan: { add: 1, change: 1, replace: 0, destroy: 0 }, tofuPlanState: "changes", tofuPlanDetail: "plan shows 2 changes",
      })], [], "system", DEFAULT_PRS_QUERY);
      expect(html).toContain("Plan shows 2 changes — human merge required");
    });

    it("says the plan is not available for this head, with the reason", () => {
      const html = buildAllPRsPage([infraRow({
        tofuPlanState: "unavailable", tofuPlanDetail: "plan comment predates the run for this head",
      })], [], "system", DEFAULT_PRS_QUERY);
      expect(html).toContain("Plan not available for this head: plan comment predates the run for this head");
    });

    it("says a no-op plan on an eligible PR merges on the next cycle", () => {
      const html = buildAllPRsPage([infraRow({
        tofuPlan: { add: 0, change: 0, replace: 0, destroy: 0 }, tofuPlanState: "noop", tofuPlanDetail: "no-op plan",
      })], [], "system", DEFAULT_PRS_QUERY);
      expect(html).toContain("No-op plan — merging on next cycle");
    });

    it("says a no-op plan on a non-exempt PR still needs a human", () => {
      const html = buildAllPRsPage([infraRow({
        tofuPlan: { add: 0, change: 0, replace: 0, destroy: 0 }, tofuPlanState: "noop", tofuPlanDetail: "no-op plan",
      }, false)], [], "system", DEFAULT_PRS_QUERY);
      expect(html).toContain("No-op plan — human merge required (not a trusted dependency update)");
    });

    it("names why a Forgejo PR is not a provider bump", () => {
      const html = buildAllPRsPage([infraRow({
        tofuPlan: { add: 0, change: 0, replace: 0, destroy: 0 }, tofuPlanState: "noop", tofuPlanDetail: "no-op plan",
        infraBumpEligible: false, infraBumpHoldReason: "non-comment change in tofu/data-server.tf",
      })], [], "system", DEFAULT_PRS_QUERY);
      expect(html).toContain("No-op plan — human merge required (non-comment change in tofu/data-server.tf)");
    });

    it("says a Forgejo provider bump with a no-op plan merges on the next cycle, whatever its author", () => {
      const html = buildAllPRsPage([infraRow({
        tofuPlan: { add: 0, change: 0, replace: 0, destroy: 0 }, tofuPlanState: "noop", tofuPlanDetail: "no-op plan",
        infraPinOnly: false, infraBumpEligible: true,
      }, true)], [], "system", DEFAULT_PRS_QUERY);
      expect(html).toContain("No-op plan — merging on next cycle");
    });

    it("does not say a qualifying Forgejo bump merges on the next cycle without a merge approval", () => {
      const html = buildAllPRsPage([infraRow({
        tofuPlan: { add: 0, change: 0, replace: 0, destroy: 0 }, tofuPlanState: "noop", tofuPlanDetail: "no-op plan",
        infraPinOnly: false, infraBumpEligible: true,
      }, false)], [], "system", DEFAULT_PRS_QUERY);
      expect(html).not.toContain("merging on next cycle");
      expect(html).toContain("No-op plan — awaiting merge approval");
      expect(html).not.toContain("not a trusted dependency update");
    });
  });

  it("renders a plain infra badge when infraPaths are known but no tofu plan was parsed", () => {
    const rows: AllPRRow[] = [
      {
        repo: "org/repo-a",
        pr: makePR({ number: 10 }),
        status: makeStatus({ infraPaths: ["tofu/main.tf"] }),
      },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("Infra (tofu)");
    expect(html).not.toContain('class="infra-badge infra-destructive"');
  });

  it("renders the plain merge button when there are no infra paths", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus() },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("Squash &amp; Merge");
    expect(html).not.toContain("merge-btn merge-infra");
    expect(html).not.toContain('class="infra-badge');
  });

  it("renders an Automerge button for a PR without the label", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("markAutomerge('org/repo-a',10, $event, false)");
    expect(html).not.toContain('class="refined-btn refined-done"');
  });

  it("renders an inert Approval-exempt chip and no Automerge button for an approval-exempt row", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), approvalExempt: true },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("Approval-exempt</span>");
    expect(html).not.toContain("markAutomerge('org/repo-a',10");
  });

  it("still renders the Automerge button for a non-exempt row", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), approvalExempt: false },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("markAutomerge('org/repo-a',10, $event, false)");
    expect(html).not.toContain("Approval-exempt</span>");
  });

  it("renders the done indicator when the row carries a merge approval", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), prRow: makeRow(10, { mergeApprovedAt: "2026-10-26T09:30:00.000Z", mergeApprovedBy: "dashboard" }) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain(`<span class="refined-btn pr-automerge-btn refined-done" title="Merge approved by dashboard at 2026-10-26T09:30:00.000Z">${'<span class="pr-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg></span><span class="pr-label">Automerge</span>'}</span>`);
    expect(html).not.toContain("markAutomerge('org/repo-a',10");
  });

  it("still offers Automerge on a PR carrying only a forge Automerge label", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10, labels: [{ name: "Automerge" }] }), prRow: makeRow(10) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("markAutomerge('org/repo-a',10, $event, false)");
  });

  it("keeps the Automerge button visible while the merge button is blocked", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus({ checkStatus: "failing" }) },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain("CI failing");
    expect(html).not.toContain("Squash &amp; Merge");
    expect(html).toContain("markAutomerge('org/repo-a',10, $event, false)");
  });

  it("wraps the actions cell contents in an action-stack", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 10 }), status: makeStatus() },
    ];
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain('<td class="cell-actions" data-label=""><div class="action-stack">');
  });
});

describe("buildAllPRsPage row actions", () => {
  it("renders Prioritise and Skip on every PR row", () => {
    const html = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 10 }) }], [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain(`data-mode="prio" title="Prioritise" @click="togglePriority('org/repo-a',10, $event)">`);
    expect(html).toContain(`<span class="pr-label">Prioritise</span></button>`);
    expect(html).toContain(`title="Skip" @click="skipItem('org/repo-a',10, $event)">`);
    expect(html).toContain(`<span class="pr-label">Skip</span></button>`);
  });

  it("renders Unmark only on a PR whose row is problematic, so the CI-fixer breaker can be reset", () => {
    const html = buildAllPRsPage([
      { repo: "org/repo-a", pr: makePR({ number: 8 }), prRow: makeRow(8, { stage: "problematic" }) },
      { repo: "org/repo-a", pr: makePR({ number: 9, labels: [{ name: LABELS.problematic }] }), prRow: makeRow(9) },
    ], [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain(`@click="unmarkProblematic('org/repo-a',8, $event)"><span class="pr-icon" aria-hidden="true"><svg`);
expect(html).toContain(`<span class="pr-label">Unmark problematic</span></button>`);
    expect(html).not.toContain("unmarkProblematic('org/repo-a',9");
  });

  it("renders Clear manual action only on a PR whose row records one", () => {
    const html = buildAllPRsPage([
      { repo: "org/repo-a", pr: makePR({ number: 8 }), prRow: makeRow(8, { manualActionReason: "set secrets" }) },
      { repo: "org/repo-a", pr: makePR({ number: 9, labels: [{ name: "Manual Action" }] }), prRow: makeRow(9) },
      { repo: "org/repo-a", pr: makePR({ number: 7 }) },
    ], [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain(`<div class="action-secondary"><button class="refined-btn pr-clear-manual-btn" @click="clearManualAction('org/repo-a',8, $event)"><span class="pr-icon" aria-hidden="true"><svg`);
    expect(html).toContain(`<span class="pr-label">Clear manual action</span></button>`);
    expect(html).not.toContain("clearManualAction('org/repo-a',9");
    expect(html).not.toContain("clearManualAction('org/repo-a',7");
  });

  describe("needs-you line", () => {
    it("lists the attention reasons for a flagged row", () => {
      const html = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 8 }), prRow: makeRow(8, { stage: "problematic" }), manualWarning: "Operator step pending: cutover" }], [], "system", DEFAULT_PRS_QUERY);
      expect(html).toContain(`<span class="needs-you">&#x26A0; Needs you: Manual action pending \u00B7 Claws Problematic</span>`);
    });

    it("shows nothing for an automerge-queued green row", () => {
      const html = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 9 }), prRow: makeRow(9, { stage: "awaiting-merge", mergeApprovedAt: "2026-10-13T00:00:00Z", mergeApprovedBy: "dashboard" }), status: makeStatus({ reviewStatus: "clean" }) }], [], "system", DEFAULT_PRS_QUERY);
      expect(html).not.toContain(`class="needs-you"`);
    });
  });

  describe("manual-action warning", () => {
    const WARNING = `Manual action before merge: add the "DEPLOY_KEY" secret; Operator step pending: actions (operator)`;
    // JSON-quoted, then HTML-escaped for the attribute: the browser decodes it back to a JS string literal.
    const NOTE_ARG = `&quot;Manual action before merge: add the \\&quot;DEPLOY_KEY\\&quot; secret; Operator step pending: actions (operator)&quot;`;

    it("names the unmet action under the title and in the action stack", () => {
      const html = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 8 }), status: makeStatus({ reviewStatus: "clean" }), manualWarning: WARNING }], [], "system", DEFAULT_PRS_QUERY);
      const badge = `<span class="manual-warning">&#x26A0; Manual action before merge: add the &quot;DEPLOY_KEY&quot; secret; Operator step pending: actions (operator)</span>`;
      expect(html.split(badge)).toHaveLength(3);
      expect(html).toMatch(/<td class="cell-title"[^>]*>[^]*?manual-warning[^]*?<\/td>/);
      expect(html).toMatch(/<div class="action-stack">[^<]*<button[^]*?manual-warning[^]*?<\/div>/);
    });

    it("hands the warning to the Merge and Automerge buttons, JSON-quoted", () => {
      const html = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 8 }), status: makeStatus({ reviewStatus: "clean" }), manualWarning: WARNING }], [], "system", DEFAULT_PRS_QUERY);
      expect(html).toContain(`@click="mergePR('org/repo-a',8, $event, '', ${NOTE_ARG})" title="Squash &amp; Merge"><span class="pr-icon"`);
      expect(html).toContain(`@click="markAutomerge('org/repo-a',8, $event, false, ${NOTE_ARG})"><span class="pr-icon"`);
    });

    it("keeps the infra note ahead of the manual note on an infra PR", () => {
      const html = buildAllPRsPage([{
        repo: "org/repo-a", pr: makePR({ number: 8 }), manualWarning: "Operator step pending: cutover",
        status: makeStatus({ infraPaths: ["tofu/main.tf"], tofuPlan: { add: 1, change: 0, replace: 0, destroy: 0 } }),
      }], [], "system", DEFAULT_PRS_QUERY);
      expect(html).toMatch(/mergePR\('org\/repo-a',8, \$event, '[^']+', &quot;Operator step pending: cutover&quot;\)" title="Merge infra"><span class="pr-icon" aria-hidden="true"><span class="pr-icon-infra">&#x26A0;<\/span><\/span><span class="pr-label">Merge infra</);
    });

    it("leaves a PR without a warning unchanged", () => {
      const html = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 8 }), status: makeStatus({ reviewStatus: "clean" }) }], [], "system", DEFAULT_PRS_QUERY);
      expect(html).not.toContain(`class="manual-warning"`);
      expect(html).toContain(`@click="mergePR('org/repo-a',8, $event)" title="Squash &amp; Merge"><span class="pr-icon"`);
      expect(html).toContain(`@click="markAutomerge('org/repo-a',8, $event, false)"><span class="pr-icon"`);
    });
  });

  it("offers an icon Refresh button, driving the queue rescan", () => {
    const html = buildAllPRsPage([], [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain('aria-label="Refresh"');
    expect(html).not.toContain("GitHub</button>");
    expect(html).toContain(`@click="refreshQueue($event)"`);
    expect(html).toContain(`x-text="refreshStatus"`);
  });

  it("shows Restore and a Skipped badge instead of Skip on an already-skipped PR row", async () => {
    const githubMod = await import("../github.js");
    const spy = vi.spyOn(githubMod, "isItemSkipped").mockReturnValue(true);
    try {
      const html = buildAllPRsPage([{ repo: "org/repo-a", pr: makePR({ number: 10 }) }], [], "system", DEFAULT_PRS_QUERY);
      expect(html).toContain(`data-mode="unskip" title="Restore" @click="skipItem('org/repo-a',10, $event)"><span class="pr-icon"`);
      expect(html).not.toContain(">Skip<");
      expect(html).toContain('<span class="skip-badge">Skipped</span>');
    } finally {
      spy.mockRestore();
    }
  });
});

describe("/prs dependency filter", () => {
  const renovate = (n: number, over: Partial<PR> = {}) =>
    makePR({ number: n, title: `Renovate ${n}`, headRefName: `renovate/dep-${n}`, author: { login: "renovate[bot]" }, body: "| Package | Update | Change |\n|---|---|---|\n| a | patch | 1 -> 2 |", ...over });
  const claws = (n: number, over: Partial<PR> = {}) => makePR({ number: n, title: `Claws ${n}`, ...over });
  const titlesInOrder = (html: string, titles: string[]) => titles.map((t) => html.indexOf(t));

  it("classifies dependency and other PRs", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: renovate(1) },
      { repo: "org/repo-a", pr: makePR({ number: 2, headRefName: "renovate/lodash-4.x", author: { login: "renovate" } }) },
      { repo: "org/repo-a", pr: makePR({ number: 3, headRefName: "automation/bump-app", labels: [{ name: "auto-bump" }] }) },
      { repo: "org/repo-a", pr: claws(4) },
      { repo: "org/repo-a", pr: makePR({ number: 5, headRefName: "automation/bump-app", labels: [{ name: "auto-bump" }, { name: "major-update" }] }) },
    ];
    const { deps, other } = splitPRRows(rows);
    expect(deps.map((r) => r.pr.number)).toEqual([1, 2, 3]);
    expect(other.map((r) => r.pr.number)).toEqual([4, 5]);
  });

  it("shows chip counts, one active chip and a matching heading count per view", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: renovate(1) },
      { repo: "org/repo-a", pr: renovate(2) },
      { repo: "org/repo-a", pr: claws(3) },
    ];
    const all = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(all).not.toContain('data-kind="all"');
    expect(all).toContain('>Dependencies<span class="filter-count">2</span>');
    expect(all).toContain('>Other<span class="filter-count">1</span>');
    expect(all).toContain("Open PRs <span>3</span>");

    const deps = buildAllPRsPage(rows, [], "system", { ...DEFAULT_PRS_QUERY, kind: "deps" });
    expect(deps.match(/class="active"/g)).toHaveLength(1);
    expect(deps).toContain('data-kind="deps" class="active"');
    expect(deps).toContain("Open PRs <span>2</span>");
    expect(deps).toContain("Renovate 1");
    expect(deps).not.toContain("Claws 3");

    const other = buildAllPRsPage(rows, [], "system", { ...DEFAULT_PRS_QUERY, kind: "other" });
    expect(other).toContain("Open PRs <span>1</span>");
    expect(other).toContain("Claws 3");
    expect(other).not.toContain("Renovate 1");
  });

  it("Blocked kind lists only rows needing the operator and counts them", () => {
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: makePR({ number: 8, title: "HumanBlocked" }), prRow: makeRow(8), manualWarning: "Operator step pending: cutover" },
      { repo: "org/repo-a", pr: makePR({ number: 9, title: "GreenQueued" }), prRow: makeRow(9, { stage: "awaiting-merge", mergeApprovedAt: "2026-10-13T00:00:00Z", mergeApprovedBy: "dashboard" }), status: makeStatus({ reviewStatus: "clean" }) },
      { repo: "org/repo-a", pr: makePR({ number: 7, title: "NoRow" }) },
    ];
    const blocked = buildAllPRsPage(rows, [], "system", { ...DEFAULT_PRS_QUERY, kind: "blocked" });
    expect(blocked).toContain('data-kind="blocked" class="active">Blocked<span class="filter-count">1</span>');
    expect(blocked).toContain("Open PRs <span>1</span>");
    expect(blocked).toContain("HumanBlocked");
    expect(blocked).not.toContain("GreenQueued");
    expect(blocked).not.toContain("NoRow");
    expect(buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY)).toContain("Open PRs <span>3</span>");
  });

  it("Blocked kind shows its own empty state", () => {
    const html = buildAllPRsPage([{ repo: "org/repo-a", pr: claws(1) }], [], "system", { ...DEFAULT_PRS_QUERY, kind: "blocked" });
    expect(html).toContain("Open PRs <span>0</span>");
    expect(html).toContain("No PRs need you");
  });

  it("shows the empty state with count 0 for an empty view", () => {
    const html = buildAllPRsPage([{ repo: "org/repo-a", pr: claws(1) }], [], "system", { ...DEFAULT_PRS_QUERY, kind: "deps" });
    expect(html).toContain("Open PRs <span>0</span>");
    expect(html).toContain("No open PRs");
  });

  it("lists dependency PRs needing a human before those Claws handles itself", () => {
    const old = "2026-01-01T00:00:00Z";
    const fresh = "2026-03-01T00:00:00Z";
    const rows: AllPRRow[] = [
      { repo: "org/repo-a", pr: renovate(1, { updatedAt: fresh, title: "ReadyOne" }) },
      { repo: "org/repo-a", pr: renovate(2, { updatedAt: fresh, title: "CiPending" }), status: makeStatus({ checkStatus: "pending" }) },
      { repo: "org/repo-a", pr: renovate(3, { updatedAt: old, title: "MajorOne", labels: [{ name: "major-update" }] }) },
      { repo: "org/repo-a", pr: renovate(4, { updatedAt: old, title: "InfraOne" }), status: makeStatus({ infraPaths: ["main.tf"] }) },
      { repo: "org/repo-a", pr: renovate(5, { updatedAt: old, title: "EscalatedOne" }), status: makeStatus({ reviewStatus: "escalated" }) },
      { repo: "org/repo-a", pr: renovate(6, { updatedAt: old, title: "ManualOne" }), prRow: makeRow(6, { manualActionReason: "needs a look" }) },
      { repo: "org/repo-a", pr: renovate(7, { updatedAt: fresh, title: "PatchOne" }) },
    ];
    const queue: QueueItem[] = [
      { repo: "org/repo-a", number: 1, title: "ReadyOne", category: "ready", updatedAt: fresh, type: "pr" },
    ];
    const html = buildAllPRsPage(rows, queue, "system", { ...DEFAULT_PRS_QUERY, kind: "deps" });
    const human = titlesInOrder(html, ["MajorOne", "InfraOne", "EscalatedOne"]);
    // A hold only gates the merge; its own warning shows it (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK).
    const auto = titlesInOrder(html, ["ReadyOne", "CiPending", "PatchOne", "ManualOne"]);
    expect(Math.max(...human)).toBeLessThan(Math.min(...auto));
    expect(Math.min(...human)).toBeGreaterThan(-1);
  });
});

// #clw_01M64CH10AK2PKH1JDGTB3FBMJ: the list agrees with the board on Queued.
describe("buildAllIssuesPage Queued rows", () => {
  it("labels a Blocked row Queued when its tracker id is queued, and Blocked otherwise", () => {
    const QUEUED = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    const BLOCKED = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD";
    const blocked = [{ name: "Blocked", color: "000000" }];
    const html = buildAllIssuesPage([
      { repo: "org/repo", issue: makeIssue({ number: QUEUED, labels: blocked }), trackerId: QUEUED },
      { repo: "org/repo", issue: makeIssue({ number: BLOCKED, labels: blocked }), trackerId: BLOCKED },
    ], [], "system", [], [], [], undefined, [], new Set([QUEUED]));
    expect(html.match(/refined-done">Queued</g)).toHaveLength(1);
    expect(html.match(/refined-done">Blocked</g)).toHaveLength(1);
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
      expect(html).toContain(`data-mode="unskip" title="Restore" @click="skipItem('org/repo',5, $event)"><span class="pr-icon"`);
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
    expect(html).toContain('href="https://forge.example.com/org/repo/issues/7"');
    expect(html).toContain(`@click="unskipItem('org/repo',7, $event)">Restore</button>`);
  });

  it("shows a skipped item's Repo cell in short form, with the full name in a title", () => {
    const html = buildAllIssuesPage([], [], "system", [], [{ repo: "org/repo", number: 7 }]);
    expect(html).toContain(`<a href="/repos/org/repo" title="org/repo"><span class="repo-avatar" aria-hidden="true">r</span>repo</a>`);
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
  it("offers the New issue button and modal, with nothing pre-checked", () => {
    const html = buildAllIssuesPage([], [], "system", [], [], [], undefined, ["org/repo-a", "org/repo-b"]);
    expect(html).toContain(`<a class="trigger-btn" href="/issues/new" data-new-issue-open>New issue</a>`);
    expect(html).toContain(`id="new-issue-modal"`);
    expect(html).toContain(`name="repo" value="org/repo-a"`);
    expect(html).not.toMatch(/name="repo" value="[^"]+" checked/);
    expect(html).toContain("clawsNewIssueModalInit");
  });

  it("hands the Issues page's 60s reload to the modal script, keeping a meta refresh only for no-JS", () => {
    const html = buildAllIssuesPage([], [], "system");
    expect(html).toContain(`data-reload-seconds="60"`);
    expect(html).toContain(`<noscript><meta http-equiv="refresh" content="60"></noscript>`);
    expect(html.match(/http-equiv="refresh"/g)).toHaveLength(1);
  });

  it("leaves the PRs page's meta refresh and lack of a modal alone", () => {
    const html = buildAllPRsPage([], [], "system", DEFAULT_PRS_QUERY);
    expect(html).toContain(`<meta http-equiv="refresh" content="60">`);
    expect(html).not.toContain("<noscript><meta");
    expect(html).not.toContain(`id="new-issue-modal"`);
  });

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
    expect(html).toContain('href="https://forge.example.com/org/repo-a/issues/5"');
    expect(html).toContain('href="https://forge.example.com/org/repo-b/issues/6"');
    expect(html).toContain("#5");
    expect(html).toContain("#6");
    expect(html).toContain("Open Issues <span>2</span>");
    expect(html).toContain("Needs Triage");
  });

  it("shows the Repo cell in short form, with the full name in a title", () => {
    const rows: AllIssueRow[] = [{ repo: "org/repo-a", issue: makeIssue({ number: 5 }) }];
    const html = buildAllIssuesPage(rows, [], "system");
    expect(html).toContain(`<a href="/repos/org/repo-a" title="org/repo-a"><span class="repo-avatar" aria-hidden="true">r</span>repo-a</a>`);
    expect(html).not.toContain(">org/repo-a<");
  });

  it("puts the + marker before the avatar of each also-named repo", () => {
    const rows: AllIssueRow[] = [{ repo: "org/repo-a", issue: makeIssue({ number: 5, repos: ["org/repo-a", "org/repo-b"] }) }];
    const html = buildAllIssuesPage(rows, [], "system");
    expect(html).toMatch(/title="Also names org\/repo-b">\+<span class="repo-avatar"[^>]*>r<\/span>repo-b/);
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

  it("renders an Approve plan button and an Approve to merge button for an issue not approved through Plan", () => {
    for (const approvedThrough of [undefined, "none", "requirements"] as const) {
      const rows: AllIssueRow[] = [
        { repo: "org/repo-a", issue: makeIssue({ number: 5, ...(approvedThrough ? { approvedThrough } : {}) }) },
      ];
      const html = buildAllIssuesPage(rows, [], "system");
      expect(html).toContain("markRefined('org/repo-a',5");
      expect(html).toContain(">Approve plan<");
      expect(html).toContain("markAutomerge('org/repo-a',5, $event, true)");
    }
  });

  it("offers Approve merge once the issue is approved through Plan", () => {
    const rows: AllIssueRow[] = [
      { repo: "org/repo-a", issue: makeIssue({ number: 5, approvedThrough: "plan" }) },
    ];
    const html = buildAllIssuesPage(rows, [], "system");
    expect(html).not.toContain("markRefined('org/repo-a',5");
    expect(html).toContain("markAutomerge('org/repo-a',5, $event, false)");
  });

  it("shows a disabled Merge approved indicator once the issue is approved through Merge", () => {
    const rows: AllIssueRow[] = [
      { repo: "org/repo-a", issue: makeIssue({ number: 5, approvedThrough: "merge" }) },
    ];
    const html = buildAllIssuesPage(rows, [], "system");
    expect(html).not.toContain("markRefined('org/repo-a',5");
    expect(html).not.toContain("markAutomerge('org/repo-a',5");
    expect(html).toContain('<span class="refined-btn refined-done">Merge approved</span>');
  });

  // #clw_01M5VW14RKAAGS6VZ5PCKQXB9F: the labels approve nothing any more.
  it("ignores a retired Refined or Automerge label on the issue", () => {
    const rows: AllIssueRow[] = [
      { repo: "org/repo-a", issue: makeIssue({ number: 5, labels: [{ name: "Refined" }, { name: "Automerge" }] }) },
    ];
    const html = buildAllIssuesPage(rows, [], "system");
    expect(html).toContain("markRefined('org/repo-a',5");
    expect(html).not.toContain('<span class="refined-btn refined-done">');
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

    expect(html.match(/<dialog class="preview-modal"/g)).toHaveLength(1);
    expect(html).toContain("clawsPreviewModal");
    expect(html).toContain(`<details class="preview-peek list-plan"><summary>Plan · 3 sections</summary><div class="markdown"><p>Need it.</p></div><a href="/issues/clw_X#plan">Full plan</a></details>`);
  });

  it("renders the block on an unassigned row too, and none on a row without a plan", () => {
    const unassigned = [{ id: "clw_X", title: "T", authorLogin: "a", updatedAt: "", repos: [], plan }];
    const html = buildAllIssuesPage([{ repo: "org/repo", issue: makeIssue({ number: 5 }) }], [], "system", unassigned);

    expect(html.match(/<details class="preview-peek list-plan">/g)).toHaveLength(1);
  });
});

describe("buildAllPRsPage filters and sort", () => {
  const rows: AllPRRow[] = [
    { repo: "org/repo-a", pr: makePR({ number: 1, title: "Alpha", isDraft: true, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" }), prRow: makeRow(1), manualWarning: "Operator step pending: x" },
    { repo: "org/repo-b", pr: makePR({ number: 2, title: "Beta", createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" }) },
  ];

  it("renders the form with selected values and a Created column", () => {
    const html = buildAllPRsPage(rows, [], "system", { ...DEFAULT_PRS_QUERY, repo: "org/repo-a", sort: "created", dir: "asc" });
    expect(html).toContain(`<form class="list-filters list-filters-compact" method="GET" action="/prs" x-data="{ pending: '' }">`);
    expect(html).toContain(`<option value="org/repo-a" selected>`);
    expect(html).toContain(`<option value="created" selected>`);
    expect(html).toContain(`<option value="asc" selected>`);
    expect(html).toContain(`data-label="Created"`);
    expect(html).toContain("prs-sort-created");
    expect(html).toContain(`<th><a href="/prs?kind=all&amp;repo=org%2Frepo-a&amp;sort=created&amp;dir=desc">Created ▲</a></th>`);
  });

  it("chips carry the form's filters and Blocked stays fleet-wide under a repo filter", () => {
    const html = buildAllPRsPage(rows, [], "system", { ...DEFAULT_PRS_QUERY, repo: "org/repo-b" });
    expect(html).toContain(`href="/prs?kind=blocked&amp;repo=org%2Frepo-b" data-kind="blocked"`);
    expect(html).toContain('>Blocked<span class="filter-count">1</span>');
    expect(html).toContain("Open PRs <span>1</span>");
    expect(html).toContain("Beta");
    expect(html).not.toContain("Alpha");
  });

  it("shows a Draft chip only on draft PRs", () => {
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html.match(/pr-draft-chip pr-chip-neutral/g)).toHaveLength(1);
  });

  it("active chip toggles back to kind=all keeping filters; inactive chips keep the filters", () => {
    const html = buildAllPRsPage(rows, [], "system", { ...DEFAULT_PRS_QUERY, kind: "other", repo: "org/repo-b", sort: "updated", dir: "desc" });
    expect(html).toContain(`href="/prs?kind=all&amp;repo=org%2Frepo-b&amp;sort=updated&amp;dir=desc" data-kind="other" class="active"`);
    expect(html).toContain(`href="/prs?kind=blocked&amp;repo=org%2Frepo-b&amp;sort=updated&amp;dir=desc" data-kind="blocked"`);
  });

  it("renders filters on demand", () => {
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    const toolbar = html.slice(html.indexOf('<div class="prs-toolbar">'), html.indexOf("<h2>Open PRs"));
    expect(toolbar).toContain(`x-data="{ pending: '' }"`);
    expect(toolbar.match(/<select /g)).toHaveLength(9);
    expect(toolbar.match(/@change="\$el\.form\.requestSubmit\(\)"/g)).toHaveLength(8);
    expect(toolbar.match(/class="prs-filter" x-cloak/g)).toHaveLength(6);
    const add = toolbar.slice(toolbar.indexOf('title="Add filter"'));
    expect(add.slice(0, add.indexOf("</select>"))).not.toContain("name=");
    expect(add.slice(0, add.indexOf("</select>")).match(/<option /g)).toHaveLength(7);
    const one = buildAllPRsPage(rows, [], "system", { ...DEFAULT_PRS_QUERY, repo: "org/repo-a" });
    const tb = one.slice(one.indexOf('<div class="prs-toolbar">'), one.indexOf("<h2>Open PRs"));
    expect(tb).toContain('<option value="org/repo-a" selected>');
    expect(tb).toContain('href="/prs?kind=all" aria-label="Remove Repository filter"');
    expect(tb).not.toContain('x-show="pending === \'repo\'"');
    const addSel = tb.slice(tb.indexOf('title="Add filter"'));
    expect(addSel.slice(0, addSel.indexOf("</select>"))).not.toContain('<option value="repo">');
    const all = buildAllPRsPage(rows, [], "system", { ...DEFAULT_PRS_QUERY, repo: "org/repo-a", author: "a", label: "l", ci: "failing", review: "clean", merge: "conflicts" });
    expect(all).not.toContain('title="Add filter"');
    expect(toolbar).toMatch(/aria-label="Clear filters"[^>]*><svg/);
    expect(html).toContain("a.trigger-btn.prs-clear");
  });

  it("has no Author type, Draft or Title contains control, and one refresh button in the toolbar", () => {
    const html = buildAllPRsPage(rows, [], "system", DEFAULT_PRS_QUERY);
    expect(html).not.toContain('name="who"');
    expect(html).not.toContain('name="draft"');
    expect(html).not.toContain('name="q"');
    expect(html).not.toContain('<p class="list-actions">');
    const toolbar = html.slice(html.indexOf('<div class="prs-toolbar">'), html.indexOf("<h2>Open PRs"));
    expect(toolbar.match(/refresh-btn"/g)).toHaveLength(1);
    expect(toolbar).not.toContain("GitHub");
    expect(toolbar).not.toContain('data-kind="all"');
    expect(toolbar.match(/prs-clear/g)).toHaveLength(1);
    expect(toolbar).toContain('href="/prs?kind=all" aria-label="Clear filters"');
    const withSort = buildAllPRsPage(rows, [], "system", { ...DEFAULT_PRS_QUERY, sort: "updated", dir: "desc" });
    expect(withSort).toContain('href="/prs?kind=all&amp;sort=updated&amp;dir=desc" aria-label="Clear filters"');
    expect(toolbar.replace(/<noscript>[\s\S]*?<\/noscript>/, "")).not.toMatch(/>(Filter|Clear)</);
  });

  it("offers a Clear link when filters match nothing", () => {
    const html = buildAllPRsPage(rows, [], "system", { ...DEFAULT_PRS_QUERY, repo: "org/none" });
    expect(html).toContain("No PRs match these filters");
    expect(html).toContain(`<a href="/prs?kind=all">Clear filters</a>`);
  });
});
