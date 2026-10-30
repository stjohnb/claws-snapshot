import { describe, it, expect } from "vitest";
import { buildIssuePage, buildNewIssueModal, buildNewIssuePage, type IssuePageView } from "./issue.js";
import { NO_REPO_WARNING } from "./layout.js";
import { renderMarkdown } from "../markdown.js";
import { issueUrl } from "../config.js";
import { primaryRepo } from "../claws-issues.js";

const ID = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

/** A posted plan: Approved and Awaiting plan review are offered only with one. */
/** The identity part of an open PR row the approval track reads. */
const PR_ROW = { repo: "St-John-Software/claws", prNumber: 5, mergeApprovedAt: null };

const PLAN = { version: 1, createdAt: "2026-09-21T09:30:00.000Z", attribution: null, sections: [{ title: "Implementation", html: "<p>Do it.</p>" }] };

function makeView(overrides: Partial<IssuePageView> = {}): IssuePageView {
  const body = overrides.body ?? "Some **bold** context.";
  const repos = overrides.repos ?? ["St-John-Software/claws"];
  return {
    id: ID,
    title: "Move issue tracking to claws",
    body,
    bodyHtml: renderMarkdown(body),
    authorLogin: "stjohnb",
    state: "open",
    stateReason: null,
    createdAt: "2026-09-21T09:00:00.000Z",
    updatedAt: "2026-09-21T10:00:00.000Z",
    repos,
    primaryRepo: primaryRepo({ repos, primary_repo: overrides.pinnedPrimaryRepo }),
    labels: ["Priority"],
    // Awaiting plan review: a posted plan, approved through Requirements only.
    lifecycle: "awaiting-plan-review",
    approvedThrough: "requirements",
    comments: [],
    allRepos: ["St-John-Software/claws", "St-John-Software/namey"],
    attachments: [],
    links: [],
    plan: null,
    previousPlans: [],
    modelPlan: [
      { phase: "requirements", cellProvider: null, cellTier: null, suggestedProvider: null, suggestedTier: null, provider: "claude", tier: "sonnet", resolvedModel: "sonnet", source: "default" },
      { phase: "plan", cellProvider: null, cellTier: null, suggestedProvider: null, suggestedTier: null, provider: "claude", tier: "fable", resolvedModel: "fable", source: "default" },
      { phase: "plan-refine", cellProvider: null, cellTier: null, suggestedProvider: null, suggestedTier: null, provider: "claude", tier: "opus", resolvedModel: "opus", source: "default" },
      { phase: "implement", cellProvider: "codex", cellTier: "haiku", suggestedProvider: null, suggestedTier: null, provider: "codex", tier: "haiku", resolvedModel: "gpt-5.6-luna", source: "explicit" },
      { phase: "review", cellProvider: null, cellTier: null, suggestedProvider: null, suggestedTier: "opus", provider: null, tier: "opus", resolvedModel: null, source: "suggested" },
      { phase: "ci-fix", cellProvider: null, cellTier: null, suggestedProvider: null, suggestedTier: null, provider: null, tier: null, resolvedModel: null, source: "default" },
      { phase: "review-address", cellProvider: null, cellTier: null, suggestedProvider: null, suggestedTier: null, provider: null, tier: null, resolvedModel: null, source: "default" },
    ],
    ...overrides,
  };
}

function makeComment(login: string, body: string, id = "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC") {
  return { id, login, body, bodyHtml: renderMarkdown(body), createdAt: "2026-09-21T09:30:00.000Z" };
}

describe("buildIssuePage", () => {
  it("shows the title, id, state, repo chip and labels", () => {
    const html = buildIssuePage(makeView(), "dark");

    expect(html).toContain("Move issue tracking to claws");
    expect(html).toContain("#clw_GZ5PDC");
    expect(html).toContain(`action="/issues/${ID}/comments"`);
    expect(html).toContain("state-open");
    expect(html).toContain("St-John-Software/claws");
    expect(html).toContain("Priority");
  });

  it("shows the repo chip in short form with the full name in a title", () => {
    const html = buildIssuePage(makeView(), "dark");
    expect(html).toContain(`<a class="repo-chip" href="/repos/St-John-Software/claws" title="St-John-Software/claws"><span class="repo-avatar" aria-hidden="true">c</span>claws</a>`);
    expect(html).not.toContain(`>St-John-Software/claws<`);
  });

  it("renders the header's inline title editor and copy-URL button", () => {
    const view = makeView();
    const html = buildIssuePage(view, "dark");

    expect(html).toContain('id="issue-title-edit"');
    const permalink = issueUrl(view.primaryRepo, view.id);
    expect(html).toContain(`id="issue-copy-url"`);
    expect(html).toContain(`data-copy-url="${permalink}"`);
    expect(html).toMatch(new RegExp(`<form class="issue-title-form" id="issue-title-form" method="POST" action="/issues/${ID}/edit" hidden>`));
    expect(html).toMatch(new RegExp(`<form class="form-actions issue-start-session" id="issue-start-session" method="POST" action="/issues/${ID}/start-session">\\s*<button class="trigger-btn" type="submit">Create Session</button>`));
    expect(html.indexOf('id="issue-start-session"')).toBeGreaterThan(html.indexOf('id="issue-title-form"'));
  });

  it("renders the body HTML the store handed it, once", () => {
    const html = buildIssuePage(makeView(), "dark");
    expect(html).toContain("<strong>bold</strong>");
    expect(html.match(/<strong>bold<\/strong>/g)).toHaveLength(1);
  });

  it("escapes a hostile title rather than rendering it", () => {
    const html = buildIssuePage(makeView({ title: "<script>alert(1)</script>" }), "dark");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes raw HTML in the body", () => {
    const html = buildIssuePage(makeView({ body: "<img src=x onerror=alert(1)>" }), "dark");
    expect(html).not.toContain("<img src=x");
  });

  it("marks Claws comments and leaves human ones unmarked", () => {
    const html = buildIssuePage(makeView({
      comments: [
        makeComment("stjohnb", "please tweak the plan", "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC"),
        makeComment("claws", "*— Automated by Claws —*\n\n## Implementation Plan\nDo it", "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDD"),
      ],
    }), "dark");

    expect(html).toContain("claws-comment");
    expect(html).toContain("please tweak the plan");
    expect(html).toContain("Implementation Plan");
  });

  it("warns when the issue has no repository", () => {
    const html = buildIssuePage(makeView({ repos: [] }), "dark");
    expect(html).toContain(`<div class="warning-banner" id="issue-repo-warning">${NO_REPO_WARNING} — assign one to start automation.</div>`);
    expect(html).toContain(`<p class="issue-meta" id="issue-repo-primary" data-pinned-primary="" hidden>`);
  });

  // The banner and the multi-repo note are always rendered so the auto-saving
  // Repositories form can toggle them without a reload.
  it("hides the warning once the issue has a repository", () => {
    for (const repos of [["org/repo"], ["org/a", "org/b"]]) {
      expect(buildIssuePage(makeView({ repos }), "dark")).toContain(`<div class="warning-banner" id="issue-repo-warning" hidden>`);
    }
  });

  it("warns when the primary repository is not managed", () => {
    const html = buildIssuePage(makeView({ repos: ["Other/unmanaged", "St-John-Software/claws"] }), "dark");
    expect(html).toContain(`<div class="warning-banner" id="issue-repo-unmanaged">Its primary repository, Other/unmanaged, is not managed by Claws`);
    expect(buildIssuePage(makeView({ repos: ["St-John-Software/claws", "zz/unmanaged"] }), "dark")).not.toContain(`id="issue-repo-unmanaged"`);
    expect(buildIssuePage(makeView({ repos: [] }), "dark")).not.toContain(`id="issue-repo-unmanaged"`);
  });

  it("notes the primary repository only when the issue has several", () => {
    const multi = buildIssuePage(makeView({ repos: ["org/b", "org/a"] }), "dark");
    expect(multi).toContain(`<p class="issue-meta" id="issue-repo-primary" data-pinned-primary="">Planned and tracked from <span id="issue-repo-primary-name" title="org/a">a</span>; its plan may open PRs in any of these repositories.</p>`);
    expect(buildIssuePage(makeView(), "dark")).toContain(`<p class="issue-meta" id="issue-repo-primary" data-pinned-primary="" hidden>`);
  });

  it("names a pinned primary repository even when another sorts first", () => {
    const html = buildIssuePage(makeView({ repos: ["org/a", "org/b"], pinnedPrimaryRepo: "org/b" }), "dark");
    expect(html).toContain(`<p class="issue-meta" id="issue-repo-primary" data-pinned-primary="org/b">Planned and tracked from <span id="issue-repo-primary-name" title="org/b">b</span>`);
  });

  it("offers close actions while open and reopen once closed", () => {
    const open = buildIssuePage(makeView(), "dark");
    expect(open).toContain('value="closed"');
    expect(open).toContain("Close issue");
    // The second close button records completed by hand, for work finished
    // outside Claws — a plain close defaults to not planned.
    expect(open).toContain('name="reason" value="completed"');
    expect(open).toContain("Close as completed");
    expect(open).not.toContain("closed-completed");
    expect(open).not.toContain("closed-not_planned");
    expect(open).not.toContain('value="open"');
    expect(open).toContain("<h2>State</h2>");
    expect(open).not.toMatch(/<summary><h2>State/);

    const closed = buildIssuePage(makeView({ state: "closed", stateReason: "not_planned" }), "dark");
    expect(closed).toContain('value="open"');
    expect(closed).toContain("Reopen issue");
    expect(closed).toContain("state-closed");
    expect(closed).toContain("Not planned");

    const completed = buildIssuePage(makeView({ state: "closed", stateReason: "completed" }), "dark");
    expect(completed).toContain("Closed · Completed");
  });

  it("does not offer Claws Staging or the retired Claws Ignore as a label checkbox", () => {
    const html = buildIssuePage(makeView(), "dark");
    expect(html).not.toContain('value="Claws Staging"');
    expect(html).not.toContain('value="Claws Ignore"');
    expect(html).toContain('value="Plan: Deep"');

    const newIssue = buildNewIssuePage(["St-John-Software/claws"], "dark");
    expect(newIssue).not.toContain('value="Claws Staging"');
    expect(newIssue).not.toContain('value="Claws Ignore"');
    expect(newIssue).toContain('value="Plan: Deep"');
  });

  it("posts each mutation to its own route", () => {
    const html = buildIssuePage(makeView(), "dark");
    for (const path of ["/comments", "/labels", "/edit", "/state", "/repos", "/model-plan"]) {
      expect(html).toContain(`action="/issues/${ID}${path}"`);
    }
  });

  it("pre-checks the issue's current labels and repos in the edit forms", () => {
    const html = buildIssuePage(makeView(), "dark");
    expect(html).toContain(`<input type="checkbox" name="label" value="Priority" checked>`);
    expect(html).toContain(`<input type="checkbox" name="repo" value="St-John-Software/claws" checked>`);
    expect(html).toContain(`<input type="checkbox" name="repo" value="St-John-Software/namey">`);
  });

  it("auto-saves the Labels and Repositories forms, keeping their buttons for no-JS", () => {
    const html = buildIssuePage(makeView(), "dark");
    expect(html).toContain(`action="/issues/${ID}/labels" data-autosave="labels"`);
    expect(html).toContain(`action="/issues/${ID}/repos" data-autosave="repos"`);
    expect(html).toContain(`data-autosave-submit>Save labels`);
    expect(html).toContain(`data-autosave-submit>Save repositories`);
    expect(html.match(/class="autosave-status"/g)).toHaveLength(2);
    expect(html).toContain(`id="issue-labels"`);
    expect(html).toContain(`id="issue-repos"`);
    expect(html).toContain("clawsIssueEditInit");
  });

  it("lists the repositories alphabetically", () => {
    const html = buildIssuePage(makeView({ allRepos: ["org/zeta", "Forgejo/beta", "org/alpha"] }), "dark");
    expect(html.indexOf(`value="Forgejo/beta"`)).toBeLessThan(html.indexOf(`value="org/alpha"`));
    expect(html.indexOf(`value="org/alpha"`)).toBeLessThan(html.indexOf(`value="org/zeta"`));
  });

  it("shows repo checkboxes as short names when every option shares one owner", () => {
    const html = buildIssuePage(makeView({ allRepos: ["St-John-Software/claws", "St-John-Software/namey"] }), "dark");
    expect(html).toContain(`value="St-John-Software/claws"`);
    expect(html).toMatch(/<span class="check-text"><span class="repo-avatar" aria-hidden="true">[^<]+(<img[^>]*>)?<\/span>claws<\/span>/);
    expect(html).not.toContain(`<span class="check-text">St-John-Software/claws</span>`);
  });

  it("renders the model plan grid with the stored cell, resolved model and source", () => {
    const html = buildIssuePage(makeView(), "dark");
    expect(html).toContain("Model plan");
    expect(html).toMatch(/<select name="provider_implement"[^>]*>.*<option value="codex" selected>/s);
    expect(html).toMatch(/<select name="tier_implement"[^>]*>.*<option value="haiku" selected>/s);
    expect(html).toContain("gpt-5.6-luna");
    expect(html).toContain(`source-badge source-explicit">explicit`);
    expect(html).toContain("suggested by planner");
    // An undecided half reads as such rather than as a guess.
    expect(html).toContain("weighted draw / opus");
    expect(html).toContain("Save model plan");
  });

  it("names a planner suggestion in the blank option instead of selecting it", () => {
    const html = buildIssuePage(makeView(), "dark");
    const reviewTier = html.match(/<select name="tier_review"[^>]*>.*?<\/select>/s)?.[0] ?? "";
    expect(reviewTier).toContain(`<option value="" selected>default (suggested: opus)</option>`);
    expect(reviewTier).not.toMatch(/value="opus" selected/);
  });

  it("renders the model plan read-only only when the issue has no repository", () => {
    const html = buildIssuePage(makeView({ repos: [] }), "dark");
    expect(html).toMatch(/<select name="provider_plan"[^>]* disabled>/);
    expect(html).not.toContain("Save model plan");
  });

  it("lets a multi-repo issue edit its model plan", () => {
    const html = buildIssuePage(makeView({ repos: ["org/a", "org/b"] }), "dark");
    expect(html).not.toMatch(/<select name="provider_plan"[^>]* disabled>/);
    expect(html).toContain("Save model plan");
  });

  it("offers no lifecycle or retired gate label as a checkbox or a header chip", () => {
    const html = buildIssuePage(makeView({ labels: ["Ready", "Refined", "Ship", "Automerge", "Claws Auto-Refine", "Blocked"] }), "dark");
    for (const label of ["Refined", "Ready", "Ship", "Automerge", "Claws Auto-Refine", "Blocked"]) {
      expect(html).not.toContain(`name="label" value="${label}"`);
      expect(html).not.toMatch(new RegExp(`label-chip[^>]*>${label}<`));
    }
  });

  it("shows an issue awaiting plan review with an Approve plan button", () => {
    const html = buildIssuePage(makeView({ plan: PLAN }), "dark");
    expect(html).toMatch(/state-pill state-column">Awaiting plan review</);
    expect(html).toContain(`action="/issues/${ID}/comments" data-comment-status`);
    expect(html).not.toContain(`/column"`);
    expect(html).toMatch(/name="status" value="approved" formnovalidate>Approve plan</);
    expect(html).toMatch(/name="status" value="backlog" formnovalidate>Send to backlog</);
    expect(html).toMatch(/name="status" value="blocked" data-needs-comment>Comment and mark blocked</);
    expect(html).toContain("Comment and send back to requirements");
    expect(html).toContain("Comment and send back to Planning");
    const status = html.slice(html.indexOf("Status <"), html.indexOf("Labels <"));
    expect(status).not.toContain("<form");
    expect(status).not.toContain("<button");
    expect(html).toContain(`name="status" value="approved"`);
    expect(html).toContain("Approve plan and Send to backlog need no comment");
    expect(html).toContain("Comment and mark blocked");
    expect(html).toContain("Comment and send back to requirements");
    expect(html).toContain("Comment and send back to Planning");
    expect(html).toContain(`name="status" value="backlog"`);
    expect(html).toContain("Send to backlog");
    expect(html).not.toContain(`name="status" value="awaiting-plan-review"`);
  });

  it("offers an optional return date beside Send to backlog", () => {
    const html = buildIssuePage(makeView({ plan: PLAN }), "dark");
    const box = html.slice(html.indexOf("data-comment-status"));
    expect(box).toMatch(/<label class="backlog-until-field">Until \(optional\) <input type="date" name="backlog_until" min="\d{4}-\d{2}-\d{2}"><\/label>/);
  });

  it("shows a parked issue's return date on the Status line with change and clear controls", () => {
    const html = buildIssuePage(makeView({ labels: ["Backlog"], lifecycle: "backlog", backlogUntil: "2026-10-23" }), "dark");
    expect(html).toMatch(/state-pill state-column">Backlog · returns 2026-10-23</);
    const status = html.slice(html.indexOf("<h2>Status</h2>"), html.indexOf("<h2>Labels</h2>"));
    expect(status).toContain(`action="/issues/${ID}/backlog-until" id="backlog-until-form"`);
    expect(status).toContain(`name="until" value="2026-10-23"`);
    expect(status).toContain("Clear return date");
    expect(html).not.toContain(`name="backlog_until"`);

    const undated = buildIssuePage(makeView({ labels: ["Backlog"], lifecycle: "backlog" }), "dark");
    expect(undated).toMatch(/state-pill state-column">Backlog</);
    expect(undated).toContain(`id="backlog-until-form"`);
    expect(undated).not.toContain("Clear return date");
  });

  it("offers an issue in either requirements column Promote to Planning, and one in Planning Send back to requirements", () => {
    const drafting = buildIssuePage(makeView({ labels: [], lifecycle: "ideas" }), "dark");
    expect(drafting).toMatch(/state-pill state-column">Drafting</);
    expect(drafting).toContain("Comment and promote to Planning");
    expect(drafting).not.toContain(`name="status" value="ideas"`);
    const review = buildIssuePage(makeView({ labels: [], lifecycle: "ideas", requirementsReview: true }), "dark");
    expect(review).toMatch(/state-pill state-column">Requirements review</);
    expect(review).toContain("Comment and promote to Planning");
    expect(review).not.toContain(`name="status" value="ideas"`);
    const planning = buildIssuePage(makeView({ labels: [], lifecycle: "planning" }), "dark");
    expect(planning).toMatch(/state-pill state-column">Planning</);
    expect(planning).toContain("Comment and send back to requirements");
    expect(planning).toContain(`name="status" value="ideas"`);
    expect(planning).not.toContain("Ideas");
    expect(planning).not.toContain(`name="status" value="planning"`);
  });

  it("shows the approval track under the column pill and no Refine & Automerge button (#clw_01M5VRB6Q607S256SQ8NDC5AHT)", () => {
    const html = buildIssuePage(makeView({ plan: PLAN, lifecycle: "awaiting-plan-review" }), "dark");
    expect(html).toMatch(/state-pill state-column">Awaiting plan review<\/span><\/p>\s*<div class="issue-approval"><div class="approval-track"/);
    expect(html).toContain(`data-track-repo="St-John-Software/claws" data-track-ref="${ID}"`);
    expect(html).toMatch(/<li class="approval-step" data-gate="plan" data-state="next"/);
    expect(html).toContain(`<p class="approval-stops">Stops at <b>plan review</b></p>`);
    // #clw_01M61A4P3N7D76P1JR2HW5WNN5: a read-only dot strip, a filled primary and its attached further approval.
    const strip = html.match(/<ol class="approval-steps">[\s\S]*?<\/ol>/)![0];
    expect(strip).not.toContain("<button");
    expect(strip).not.toContain("data-action");
    expect(html.match(/class="approval-primary approval-act"/g)).toHaveLength(1);
    expect(html).toMatch(/data-gate="plan" data-action="approve" class="approval-primary approval-act"[^>]*>Approve plan<\/button>/);
    expect(html).toContain(`data-gate="merge" data-action="approve" class="approval-further approval-act" title="Approve plan and merge — no further stop" aria-label="Approve plan and merge — no further stop">&amp; merge</button>`);
    expect(html).toContain(`class="approval-dot"`);
    expect(html).not.toContain("approval-more");
    expect(html).toContain(".issue-approval { max-width: 24rem; }");
    expect(html).toContain("min-height: 40px");
    expect(html).not.toContain("approved-automerge");
    expect(html).not.toContain("Refine &amp; Automerge");
    expect(html).toContain("Approve plan");
  });

  // #clw_01M5VW14RKAAGS6VZ5PCKQXB9F: Approved is the plan-review lifecycle approved through Plan.
  it("shows an issue approved through Plan as Approved, with the Plan gate filled and no Approve plan button", () => {
    const html = buildIssuePage(makeView({ plan: PLAN, approvedThrough: "plan" }), "dark");
    expect(html).toMatch(/state-pill state-column">Approved</);
    expect(html).toMatch(/data-gate="plan" data-state="approved"/);
    expect(html).toMatch(/data-gate="merge" data-state="next"/);
    expect(html).toMatch(/data-gate="merge" data-action="approve" class="approval-primary approval-act"[^>]*>Approve merge<\/button>/);
    expect(html).not.toContain(`name="status" value="approved"`);
    expect(html).toContain(`name="status" value="awaiting-plan-review"`);
    const merge = buildIssuePage(makeView({ plan: PLAN, approvedThrough: "merge" }), "dark");
    expect(merge).toMatch(/data-gate="merge" data-state="preapproved"/);
    expect(merge).not.toContain(`class="approval-primary approval-act"`);
    expect(merge).toContain(`data-gate="merge" data-action="withdraw" class="approval-plain approval-act" title="The PR then waits for your merge approval">Withdraw merge approval</button>`);
    expect(merge).not.toContain("approval-more");
    expect(merge).toContain("<b>Runs to merge</b> — no further stop");
  });

  it("reads the column as the board and the route do: an awaited operator step is Awaiting merge, where an unapproved Plan can still be approved", () => {
    const html = buildIssuePage(makeView({ labels: [], plan: PLAN, lifecycle: "awaiting-plan-review", operatorStep: { title: "cutover", pending: true } }), "dark");
    expect(html).toMatch(/state-pill state-column">Awaiting merge</);
    expect(html).toMatch(/data-gate="plan"[^>]*class="approval-primary/);
  });

  it("shows no approval action in Drafting, Blocked and Backlog (#clw_01M5X4HY4YC56Y6VEMK12P2QR7)", () => {
    for (const view of [
      makeView({ labels: [], lifecycle: "ideas" }),
      makeView({ labels: ["Blocked"], lifecycle: "blocked", blockedReason: "needs a key", plan: PLAN, approvedThrough: "merge" }),
      makeView({ labels: [], lifecycle: "backlog", approvedThrough: "plan" }),
    ]) {
      const html = buildIssuePage(view, "dark");
      expect(html).toContain(`class="approval-steps"`);
      expect(html).not.toContain(`class="approval-actions"`);
    }
  });

  it("offers Approve requirements and the further approvals in Requirements review", () => {
    const html = buildIssuePage(makeView({ labels: [], lifecycle: "ideas", requirementsReview: true }), "dark");
    expect(html).toMatch(/data-gate="requirements" data-action="approve" class="approval-primary approval-act"[^>]*>Approve requirements<\/button>/);
    expect(html).toContain(`aria-label="Approve requirements and pre-approve plan">&amp; plan</button>`);
    expect(html).toContain(`aria-label="Approve requirements, plan and merge — no further stop">&amp; merge</button>`);
  });

  it("fills Reqs from requirementsApproved alone, as the board and the route read it", () => {
    const approved = buildIssuePage(makeView({ labels: [], lifecycle: "ideas", requirementsReview: true, requirementsApproved: true, requirementsApproval: null }), "dark");
    expect(approved).toMatch(/data-gate="requirements" data-state="approved"/);
    const unapproved = buildIssuePage(makeView({ labels: [], lifecycle: "ideas", requirementsReview: true, requirementsApproval: { version: 1, by: "op", at: "2026-09-21T09:00:00.000Z" } }), "dark");
    expect(unapproved).not.toMatch(/data-gate="requirements" data-state="approved"/);
  });

  it("names the unplanned stop over the gates while one applies", () => {
    const blocked = buildIssuePage(makeView({ labels: ["Blocked"], lifecycle: "blocked", blockedReason: "needs a key", plan: PLAN }), "dark");
    expect(blocked).toContain("Stops at <b>Blocked</b></p>");
    expect(blocked).toContain("needs a key");
    const lgtm = buildIssuePage(makeView({ labels: [], approvedThrough: "plan", plan: PLAN, flight: { implementing: false, openPrs: [{ ...PR_ROW, stage: "awaiting-merge", needsHumanReview: true }] } }), "dark");
    expect(lgtm).toContain("Stops at <b>Needs LGTM</b> on claws#5");
  });

  it("renders no approval track on a closed or unassigned issue", () => {
    for (const view of [makeView({ state: "closed" }), makeView({ repos: [] })]) {
      expect(buildIssuePage(view, "dark")).not.toContain(`class="approval-track"`);
    }
  });

  // Approved and Awaiting plan review need a plan (planRefusal): the route
  // refuses both for an issue with none, so neither is offered.
  it.each(["ideas", "planning"] as const)("offers a planless issue in %s neither Approve plan nor Awaiting plan review", (lifecycle) => {
    const html = buildIssuePage(makeView({ labels: [], lifecycle, plan: null }), "dark");
    expect(html).not.toContain(`name="status" value="approved"`);
    expect(html).not.toContain(`name="status" value="awaiting-plan-review"`);
    expect(html).not.toContain("Refine &amp; Automerge");
    expect(html).toContain(`name="status" value="blocked"`);
  });

  it("offers Awaiting plan review to an issue in Planning that has a plan", () => {
    const html = buildIssuePage(makeView({ labels: [], lifecycle: "planning", plan: PLAN }), "dark");
    expect(html).toContain(`name="status" value="awaiting-plan-review"`);
    expect(html).toContain(`name="status" value="approved"`);
  });

  it("offers no Refine & Automerge partner on a closed or unassigned issue", () => {
    for (const view of [makeView({ state: "closed" }), makeView({ repos: [] })]) {
      expect(buildIssuePage(view, "dark")).not.toContain("Refine &amp; Automerge");
    }
  });

  it("shows a backlog issue as Backlog, with a way back to requirements", () => {
    const html = buildIssuePage(makeView({ labels: ["Backlog"] }), "dark");
    expect(html).toMatch(/state-pill state-column">Backlog</);
    expect(html).toContain(`name="status" value="ideas"`);
    expect(html).not.toContain(`name="status" value="backlog"`);
  });

  // A stalled PR has no column of its own: Claws parks the issue in Blocked (#clw_01M4TJEHAP19S2N3SE6EHE6VNA).
  it("names Blocked for an issue parked for its stalled PR, and In progress before the park", () => {
    const openPrs = [{ ...PR_ROW, stage: "problematic", needsHumanReview: false }];
    expect(buildIssuePage(makeView({ labels: ["Blocked"], plan: PLAN, flight: { implementing: false, openPrs } }), "dark")).toMatch(/state-pill state-column">Blocked</);
    expect(buildIssuePage(makeView({ labels: [], plan: PLAN, flight: { implementing: false, openPrs } }), "dark")).toMatch(/state-pill state-column">In progress</);
  });

  it("keeps an issue whose PR only carries a hold in In progress (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK)", () => {
    const html = buildIssuePage(makeView({ labels: [], plan: PLAN, flight: { implementing: false, openPrs: [{ ...PR_ROW, stage: "awaiting-review", needsHumanReview: false, manualActionReason: "needs a secret" }] } }), "dark");
    expect(html).toMatch(/state-pill state-column">In progress</);
  });

  it("offers an issue with an open PR no way back to requirements, Planning, Awaiting plan review or Approved", () => {
    const html = buildIssuePage(makeView({ labels: [], plan: PLAN, flight: { implementing: false, openPrs: [{ ...PR_ROW, stage: "awaiting-review", needsHumanReview: false }] } }), "dark");
    expect(html).toMatch(/state-pill state-column">In progress</);
    // The approval behind Approved sits below the PR, so Approve plan lands nowhere.
    expect(html).not.toContain(`name="status" value="approved"`);
    expect(html).toContain(`name="status" value="blocked"`);
    // Its PR is open: backlogRefusal turns the move away.
    expect(html).not.toContain(`name="status" value="backlog"`);
    expect(html).not.toContain(`name="status" value="ideas"`);
    expect(html).not.toContain(`name="status" value="planning"`);
    expect(html).not.toContain(`name="status" value="awaiting-plan-review"`);
  });

  it("offers Unblock only for a Blocked issue that is in flight", () => {
    const openPrs = [{ ...PR_ROW, stage: "awaiting-merge", needsHumanReview: false }];
    const action = `value="unblock" data-needs-comment>Comment and unblock<`;
    expect(buildIssuePage(makeView({ lifecycle: "blocked", labels: ["Blocked"], plan: PLAN, flight: { implementing: false, openPrs } }), "dark")).toContain(action);
    expect(buildIssuePage(makeView({ lifecycle: "blocked", labels: ["Blocked"], plan: PLAN, flight: { implementing: false, openPrs: [] } }), "dark")).not.toContain(action);
    expect(buildIssuePage(makeView({ approvedThrough: "plan", labels: [], plan: PLAN, flight: { implementing: false, openPrs } }), "dark")).not.toContain(action);
  });

  it("offers an issue whose implementer is running only Blocked", () => {
    const html = buildIssuePage(makeView({ labels: [], approvedThrough: "plan", flight: { implementing: true, openPrs: [] } }), "dark");
    expect(html).toMatch(/state-pill state-column">In progress</);
    expect(html).toContain(`name="status" value="blocked"`);
    for (const column of ["ideas", "planning", "awaiting-plan-review", "approved", "backlog"]) {
      expect(html).not.toContain(`name="status" value="${column}"`);
    }
  });

  it("offers no status buttons on a closed or unassigned issue", () => {
    for (const view of [makeView({ state: "closed" }), makeView({ repos: [] })]) {
      expect(buildIssuePage(view, "dark")).not.toContain(`name="status"`);
    }
  });

  it("links the permalink at the dashboard, not the forge", () => {
    const html = buildIssuePage(makeView(), "dark");
    expect(html).toContain(`/issues/${ID}">Permalink`);
  });
});

describe("buildIssuePage attachments", () => {
  const ATT = "cla_01JBQ7X4M2K8NV3TYRW9GZ5PD1";
  const url = `/issues/${ID}/attachments/${ATT}/shot.png`;

  it("lists each attachment with a download link, size, type and delete form", () => {
    const html = buildIssuePage(makeView({
      attachments: [{ id: ATT, name: "shot.png", url, size: 2048, contentType: "image/png", isImage: true }],
    }), "dark");
    expect(html).toContain("Attachments <span>1</span>");
    expect(html).toContain(`<a href="${url}">shot.png</a>`);
    expect(html).toContain(`<img class="attach-thumb" src="${url}"`);
    expect(html).toContain("2.0 KB");
    expect(html).toContain(`action="/issues/${ID}/attachments/${ATT}/delete"`);
  });

  it("offers a no-JS multipart upload form and marks the textareas as attach targets", () => {
    const html = buildIssuePage(makeView(), "dark");
    expect(html).toContain("No attachments");
    // `?feedback=1` marks this as the Attachments-section form, so an upload
    // through it counts as plan feedback (#clw_01M39J5AT1SKCFV6CHMWPVHD6M).
    expect(html).toContain(`action="/issues/${ID}/attachments?feedback=1" enctype="multipart/form-data"`);
    expect(html).toContain(`<input type="file" name="file" multiple required>`);
    expect(html.match(new RegExp(`data-attach-target="${ID}"`, "g"))).toHaveLength(2);
  });

  it("starts expanded and marks the drop zone and no-JS submit button", () => {
    const html = buildIssuePage(makeView(), "dark");
    expect(html).toContain(`<details class="issue-section" open>\n      <summary><h2>Attachments`);
    expect(html).toContain(`data-attach-dropzone`);
    expect(html).toContain(`data-attach-submit`);
  });

  it("escapes an attachment name", () => {
    const html = buildIssuePage(makeView({
      attachments: [{ id: ATT, name: "<b>x</b>", url, size: 1, contentType: "text/plain", isImage: false }],
    }), "dark");
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain(`<img class="attach-thumb"`);
  });
});

describe("buildIssuePage links", () => {
  const OTHER = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD";
  const THIRD = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE";
  const link = (over: Partial<IssuePageView["links"][number]>): IssuePageView["links"][number] => ({
    id: "cll_01JBQ7X4M2K8NV3TYRW9GZ5PDC",
    kind: "depends_on",
    otherId: OTHER,
    otherTitle: "Other work",
    otherState: "open",
    otherStateReason: null,
    otherStage: "approved",
    otherStageTitle: "Approved",
    releasedAt: null,
    ...over,
  });

  it("groups links by relationship, linking each to the other issue with its state and column", () => {
    const html = buildIssuePage(makeView({
      links: [
        link({}),
        link({ id: "cll_01JBQ7X4M2K8NV3TYRW9GZ5PDD", kind: "blocks", otherId: THIRD, otherTitle: "<Later>", otherState: "closed", otherStateReason: "completed", releasedAt: "2026-09-22 10:00:00" }),
      ],
    }), "dark");
    expect(html).toContain(`id="links" open`);
    expect(html.indexOf("<h3>Depends on</h3>")).toBeLessThan(html.indexOf("<h3>Blocks</h3>"));
    expect(html).not.toContain("<h3>Relates to</h3>");
    expect(html).toContain(`<a href="/issues/${OTHER}">Other work</a>`);
    expect(html).toContain(`<span class="source-badge">Approved</span>`);
    expect(html).toContain("&lt;Later&gt;");
    expect(html).toContain("Closed · Completed");
    expect(html).toContain(">released</span>");
    expect(html).toContain(`action="/issues/${ID}/links/cll_01JBQ7X4M2K8NV3TYRW9GZ5PDC/delete"`);
  });

  it("shows the board column title for an open linked issue", () => {
    const html = buildIssuePage(makeView({ links: [link({ otherStage: "awaiting-merge", otherStageTitle: "Awaiting merge" })] }), "dark");
    expect(html).toContain(`<span class="source-badge">Awaiting merge</span>`);
  });

  it("offers the add form with every kind, and says so when there are no links", () => {
    const html = buildIssuePage(makeView(), "dark");
    expect(html).toContain("No links");
    expect(html).toContain(`action="/issues/${ID}/links"`);
    for (const kind of ["depends_on", "blocks", "relates_to"]) expect(html).toContain(`<option value="${kind}">`);
    expect(html).toContain(`name="issue"`);
    expect(html.indexOf(`id="links"`)).toBeGreaterThan(html.indexOf("<h2>Attachments"));
    expect(html.indexOf(`id="links"`)).toBeLessThan(html.indexOf("<h2>Edit"));
  });
});

describe("buildIssuePage history", () => {
  const entry = (over: Partial<NonNullable<IssuePageView["history"]>[number]>): NonNullable<IssuePageView["history"]>[number] => ({
    field: "lifecycle",
    oldValue: "planning",
    newValue: "blocked",
    actorKind: "automation",
    actor: "work:issue-refiner",
    runId: "run-<1>",
    createdAt: "2026-09-21T09:30:00.000Z",
    ...over,
  });

  it("renders a collapsed History block after the State controls", () => {
    const html = buildIssuePage(makeView(), "dark");
    expect(html).toMatch(/<details class="issue-section" id="history">/);
    expect(html).toContain("<h2>History <span>0</span></h2>");
    expect(html).toContain("No changes recorded yet.");
    expect(html.indexOf(`id="history"`)).toBeGreaterThan(html.indexOf("<h2>State</h2>"));
    expect(html.indexOf(`id="history"`)).toBeLessThan(html.indexOf(">Permalink</a>"));
  });

  it("renders each entry's change and actor, escaped, oldest first", () => {
    const html = buildIssuePage(makeView({
      history: [
        entry({}),
        entry({ field: "title", oldValue: "<Old>", newValue: "New", actorKind: "operator", actor: "stjohnb", runId: null }),
        entry({ field: "label", oldValue: null, newValue: "bug", actorKind: "session", actor: "abcdef0123456789", runId: null }),
        entry({ field: "body", oldValue: "<b>before</b>", newValue: "after", actorKind: "automation", actor: "agent via MCP", runId: null }),
      ],
    }), "dark");
    expect(html).toContain(`<details class="issue-section" id="history">`);
    expect(html).toContain("<h2>History <span>4</span></h2>");
    expect(html).not.toContain("No changes recorded yet.");
    expect(html).toContain("Lifecycle: Planning → Blocked");
    expect(html).toContain("Claws · work:issue-refiner");
    expect(html).toContain(`<a href="/logs/run-%3C1%3E">run log</a>`);
    expect(html).toContain("Title: &lt;Old&gt; → New");
    expect(html).toContain("Operator · stjohnb");
    expect(html).toContain("Label added: bug");
    expect(html).toContain(`Session · <a href="/sessions/abcdef0123456789" title="abcdef0123456789">abcdef01</a>`);
    expect(html).toContain("Body edited");
    expect(html).toContain("<pre>&lt;b&gt;before&lt;/b&gt;</pre>");
    expect(html).not.toContain("<b>before</b>");
    expect(html.indexOf("Lifecycle: Planning")).toBeLessThan(html.indexOf("Title: &lt;Old&gt;"));
  });

  it("renders comment deletions and requirements versions and approvals", () => {
    const html = buildIssuePage(makeView({
      history: [
        entry({ field: "comment", oldValue: "clwc_1 by stjohnb: <stale> idea", newValue: null, actorKind: "operator", actor: "stjohnb", runId: null }),
        entry({ field: "requirements", oldValue: null, newValue: "v2 stored" }),
        entry({ field: "requirements approved", oldValue: "v1", newValue: "v2" }),
      ],
    }), "dark");
    expect(html).toContain("Comment deleted: clwc_1 by stjohnb: &lt;stale&gt; idea");
    expect(html).toContain("Requirements: v2 stored");
    expect(html).toContain("Requirements approved: v2");
  });
});

describe("buildIssuePage comment delete", () => {
  it("renders a confirm-guarded Delete form on each comment", () => {
    const html = buildIssuePage(makeView({
      comments: [{ id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC", login: "stjohnb", body: "noise", bodyHtml: "<p>noise</p>", createdAt: "2026-09-21T09:00:00.000Z" }],
    }), "dark");
    const view = makeView();
    expect(html).toContain(`action="/issues/${view.id}/comments/clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC/delete"`);
    expect(html).toContain(`onsubmit="return confirm('Delete this comment? It will be hidden from the issue and from Claws agents.')"`);
    expect(html).toContain(`aria-label="Delete comment"`);
  });
});

describe("buildIssuePage pull requests", () => {
  const pr = (over: Partial<NonNullable<IssuePageView["pullRequests"]>[number]>) => ({
    repo: "org/repo", number: 1, title: "A PR", url: "https://github.com/org/repo/pull/1",
    state: "open" as const, stage: "awaiting-review", needsHumanReview: false, ...over,
  });

  it("lists PRs across repos and states, each linked to the forge", () => {
    const html = buildIssuePage(makeView({
      pullRequests: [
        pr({}),
        pr({ number: 2, title: "<Merged>", url: "https://github.com/org/repo/pull/2", state: "merged", stage: "merged" }),
        pr({ repo: "forge/other", number: 3, title: "Closed one", url: "https://git.example/forge/other/pulls/3", state: "closed", stage: "closed" }),
      ],
    }), "dark");
    expect(html).toContain(`id="pull-requests" open`);
    expect(html).toContain("<h2>Pull requests <span>3</span></h2>");
    expect(html).toContain(`<a href="https://github.com/org/repo/pull/1">#1</a>`);
    expect(html).toContain(`<a href="https://github.com/org/repo/pull/2">&lt;Merged&gt;</a>`);
    expect(html).toContain(`<a href="https://git.example/forge/other/pulls/3">#3</a>`);
    expect(html).toContain(`state-open">Open`);
    expect(html).toContain(`state-merged">Merged`);
    expect(html).toContain(`state-closed">Closed`);
  });

  it("badges the open stage and Needs LGTM, but not on a merged row", () => {
    const html = buildIssuePage(makeView({
      pullRequests: [
        pr({ stage: "ci-failing", needsHumanReview: true }),
        pr({ number: 2, state: "merged", stage: "merged" }),
      ],
    }), "dark");
    const start = html.indexOf(`id="pull-requests"`);
    const section = html.slice(start, html.indexOf("</details>", start));
    expect(section).toContain("CI failing");
    expect(section.match(/Needs LGTM/g)).toHaveLength(1);
  });

  it("names an open PR's unmet manual action in its State cell", () => {
    const html = buildIssuePage(makeView({
      pullRequests: [pr({ manualWarning: "Operator step pending: <cutover>" }), pr({ number: 2 })],
    }), "dark");
    const start = html.indexOf(`id="pull-requests"`);
    const section = html.slice(start, html.indexOf("</details>", start));
    expect(section).toMatch(/<td data-label="State">[^\n]*<span class="manual-warning">&#x26A0; Operator step pending: &lt;cutover&gt;<\/span><\/td>/);
    expect(section.match(/manual-warning/g)).toHaveLength(1);
  });

  it("lists the plan's operator step after the PRs, awaiting the operator while pending", () => {
    const html = buildIssuePage(makeView({
      pullRequests: [pr({ state: "merged", stage: "merged" })],
      operatorStep: { title: "actions (operator)", pending: true },
    }), "dark");
    const start = html.indexOf(`id="pull-requests"`);
    const section = html.slice(start, html.indexOf("</details>", start));
    expect(section).toContain("<h2>Pull requests <span>2</span></h2>");
    expect(section).toContain("Operator step");
    expect(section).toContain("actions (operator)");
    expect(section).toContain(`state-operator" title="Comment claws-phase-done on the issue when the operator steps are done">Awaiting operator</span>`);
    expect(section.indexOf("operator-step")).toBeGreaterThan(section.indexOf("pull/1"));
  });

  it("shows a done operator step, even with no PRs", () => {
    const html = buildIssuePage(makeView({ operatorStep: { title: "cutover", pending: false } }), "dark");
    const start = html.indexOf(`id="pull-requests"`);
    const section = html.slice(start, html.indexOf("</details>", start));
    expect(section).not.toContain("No pull requests yet");
    expect(section).toContain(`<span class="state-pill state-merged">Done</span>`);
    expect(section).not.toContain("Awaiting operator");
  });

  it("says there are none, with no links, when the issue has no PRs", () => {
    for (const view of [makeView(), makeView({ pullRequests: [] })]) {
      const html = buildIssuePage(view, "dark");
      const start = html.indexOf(`id="pull-requests"`);
      const section = html.slice(start, html.indexOf("</details>", start));
      expect(section).toContain("No pull requests yet");
      expect(section).not.toContain("<a href");
      expect(section).not.toContain(" open");
    }
  });
});

describe("buildNewIssuePage", () => {
  it("offers an explicit per-issue Requirements choice, waiting by default", () => {
    const html = buildNewIssuePage(["org/a"], "dark");
    expect(html).toContain(`<input type="radio" name="autoPromote" value="wait" checked> Wait for my review before planning`);
    expect(html).toContain(`<input type="radio" name="autoPromote" value="auto"> Promote automatically once written`);
    expect(html).toContain(`<input type="radio" name="autoPromote" value="skip"> Skip requirements — plan from this text`);
    expect(html).not.toContain("Follow the repository default");
    expect(html).not.toContain(`name="autoPromote" value=""`);
  });

  it("accepts links at creation", () => {
    const html = buildNewIssuePage(["org/a"], "dark");
    for (const kind of ["depends_on", "blocks", "relates_to"]) expect(html).toContain(`<input type="text" name="${kind}"`);
  });

  it("offers a repo checkbox per managed repo and a label checkbox per declared label", () => {
    const html = buildNewIssuePage(["org/a", "org/b"], "dark");
    expect(html).toContain(`data-attach-target="new"`);
    expect(html).toContain("data-attachment-inputs");

    expect(html).toContain(`value="org/a"`);
    expect(html).toContain(`value="org/b"`);
    expect(html).toContain(`value="Priority"`);
    for (const label of ["Refined", "Ready", "Blocked", "Backlog"]) expect(html).not.toContain(`value="${label}"`);
    expect(html).not.toContain(`name="backlog"`);
    expect(html).toContain(`action="/issues"`);
    expect(html).toContain("Title");
    expect(html).toContain("textarea");
  });

  it("lists the repositories alphabetically", () => {
    const html = buildNewIssuePage(["org/zeta", "forgejo/beta", "org/alpha"], "dark");
    expect(html.indexOf(`value="forgejo/beta"`)).toBeLessThan(html.indexOf(`value="org/alpha"`));
    expect(html.indexOf(`value="org/alpha"`)).toBeLessThan(html.indexOf(`value="org/zeta"`));
    expect(html).not.toContain("clawsIssueEditInit");
  });

  it("shows repo checkboxes as short names when every option shares one owner", () => {
    const html = buildNewIssuePage(["St-John-Software/claws", "St-John-Software/namey"], "dark");
    expect(html).toContain(`value="St-John-Software/claws"`);
    expect(html).toMatch(/<span class="check-text"><span class="repo-avatar" aria-hidden="true">[^<]+(<img[^>]*>)?<\/span>claws<\/span>/);
    expect(html).not.toContain(`<span class="check-text">St-John-Software/claws</span>`);
  });

  it("shows repo checkboxes as short names even when options span several owners, with the full name in a title", () => {
    const html = buildNewIssuePage(["org/zeta", "forgejo/beta", "org/alpha"], "dark");
    expect(html).toMatch(/<span class="check-text"><span class="repo-avatar" aria-hidden="true">[^<]+(<img[^>]*>)?<\/span>zeta<\/span>/);
    expect(html).toMatch(/<span class="check-text"><span class="repo-avatar" aria-hidden="true">[^<]+(<img[^>]*>)?<\/span>beta<\/span>/);
    expect(html).toMatch(/<span class="check-text"><span class="repo-avatar" aria-hidden="true">[^<]+(<img[^>]*>)?<\/span>alpha<\/span>/);
    expect(html).toContain(`title="forgejo/beta"`);
    expect(html).not.toContain(`<span class="check-text">org/zeta</span>`);
  });

  it("offers a Create issue button after Repositories, in addition to the bottom one", () => {
    const html = buildNewIssuePage(["org/a"], "dark");
    const matches = html.match(/Create issue/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(html.indexOf("Create issue")).toBeLessThan(html.indexOf("<h3>Labels</h3>"));
  });

  it("offers an empty model plan grid for every phase", () => {
    const html = buildNewIssuePage(["org/a"], "dark");
    for (const phase of ["requirements", "plan", "plan-refine", "implement", "review", "ci-fix", "review-address"]) {
      expect(html).toContain(`name="provider_${phase}"`);
      expect(html).toContain(`name="tier_${phase}"`);
    }
    expect(html).not.toContain(" selected>claude");
  });

  it("pre-checks a preselected repo only when Claws manages it", () => {
    const html = buildNewIssuePage(["org/a", "org/b"], "dark", undefined, "org/b");
    expect(html).toContain(`name="repo" value="org/b" checked`);
    expect(html).not.toContain(`name="repo" value="org/a" checked`);
    const stale = buildNewIssuePage(["org/a"], "dark", undefined, "org/gone");
    expect(stale).not.toMatch(/name="repo" value="[^"]+" checked/);
    expect(stale).not.toContain("org/gone");
  });

  it("keeps the Cancel link to /issues and has a hidden error region", () => {
    const html = buildNewIssuePage(["org/a"], "dark");
    expect(html).toContain(`<a class="trigger-btn" href="/issues">Cancel</a>`);
    expect(html).toContain(`<p class="new-issue-error" role="alert" hidden></p>`);
    expect(html).not.toContain("data-new-issue-cancel");
  });

  it("says an issue may name several repositories, or none until it is ready to plan", () => {
    const html = buildNewIssuePage([], "dark");
    expect(html).toContain("An issue may name several repositories");
    expect(html).toContain(NO_REPO_WARNING);
  });
});

describe("buildNewIssueModal", () => {
  /** Every `name="…"` the form submits, in document order without repeats. */
  const fieldNames = (html: string) => [...new Set([...html.matchAll(/<(?:input|textarea|select)[^>]*\bname="([^"]+)"/g)].map((m) => m[1]))];

  it("carries every field the New issue page offers", () => {
    const page = buildNewIssuePage(["org/a", "org/b"], "dark");
    const modal = buildNewIssueModal(["org/a", "org/b"]);
    const names = fieldNames(page);
    for (const name of ["title", "body", "repo", "autoPromote", "label", "depends_on", "blocks", "relates_to", "provider_implement", "tier_implement"]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain("backlog");
    expect(fieldNames(modal)).toEqual(names);
    expect(modal).not.toContain('name="backlog"');
    expect(modal).toContain(`<input type="radio" name="autoPromote" value="wait" checked>`);
    expect(modal).toContain(`maxlength="300"`);
  });

  it("is a labelled dialog with its own ids, a Cancel button and a hidden confirmation", () => {
    const modal = buildNewIssueModal(["org/a"]);
    expect(modal).toContain(`<dialog class="preview-modal new-issue-modal" id="new-issue-modal" aria-labelledby="new-issue-modal-title">`);
    expect(modal).toContain(`<h2 id="new-issue-modal-title">New issue</h2>`);
    expect(modal).not.toContain(`id="preview-modal"`);
    expect(modal).toContain(`data-new-issue-form`);
    expect(modal).toContain(`<button class="trigger-btn" type="button" data-new-issue-cancel>Cancel</button>`);
    expect(modal).not.toContain(`href="/issues">Cancel`);
    expect(modal).toMatch(/<div class="new-issue-done" data-new-issue-done hidden>/);
    expect(modal).toContain(`data-attach-target="new"`);
  });

  it("pre-checks the preselected repo, and asks for a reload hand-off only when told", () => {
    const modal = buildNewIssueModal(["org/a", "org/b"], "org/a");
    expect(modal).toContain(`name="repo" value="org/a" checked`);
    expect(modal).not.toContain("data-reload-seconds");
    expect(buildNewIssueModal([], undefined, { reloadSeconds: 60 })).toContain(`data-reload-seconds="60"`);
  });
});

describe("buildIssuePage structure", () => {
  const planView = (version: number, requirement: string) => ({
    version,
    createdAt: "2026-09-21T09:40:00.000Z",
    attribution: "*Models used: fable (provider: claude)*",
    sections: [
      { title: "Requirement", html: `<p>${requirement}</p>` },
      { title: "Decisions", html: "<p>Decided.</p>" },
      { title: "Implementation", html: "<p>Edit files.</p>" },
    ],
  });

  it("renders Request, Current plan and Comments as open collapsible blocks", () => {
    const html = buildIssuePage(makeView({ plan: planView(1, "Need it.") }), "dark");

    expect(html).toMatch(/<details class="issue-section" open>\s*<summary><h2>Request<\/h2><\/summary>/);
    expect(html).toMatch(/<details class="issue-section" id="plan" open>\s*<summary><h2>Current plan<\/h2><\/summary>/);
    expect(html).toMatch(/<details class="issue-section" open>\s*<summary><h2>Comments <span>0<\/span><\/h2><\/summary>/);
    expect(html).toMatch(/<details class="issue-section">\s*<summary><h2>Edit<\/h2><\/summary>/);
  });

  describe("Requirements block", () => {
    const req = (version: number, title: string) => ({
      version,
      createdAt: "2026-09-21T09:00:00.000Z",
      title,
      kind: "bug" as const,
      sections: [
        { title: "Context", html: "<p>Why.</p>" },
        { title: "Requirement", html: "<p>What.</p>" },
        { title: "Acceptance criteria", html: "<ul><li>Check</li></ul>" },
        { title: "Out of scope", html: "<p>None</p>" },
      ],
    });

    it("is omitted before the requirements writer has run", () => {
      const html = buildIssuePage(makeView(), "dark");
      expect(html).not.toContain("<h2>Requirements</h2>");
      expect(html).not.toContain("Previous requirements");
    });

    it("renders the latest version between Request and Current plan, not yet approved", () => {
      const html = buildIssuePage(makeView({ requirements: req(2, "Fix the thing"), previousRequirements: [req(1, "Old title")], plan: planView(1, "Need it.") }), "dark");
      const at = html.indexOf("<h2>Requirements</h2>");
      expect(at).toBeGreaterThan(html.indexOf("<h2>Request</h2>"));
      expect(at).toBeLessThan(html.indexOf("<h2>Current plan</h2>"));
      expect(html).toContain(`<strong>Fix the thing</strong> <span class="repo-chip">bug</span>`);
      expect(html).toContain("<li>Check</li>");
      expect(html).toMatch(/v2 · [^<]* · Not yet approved/);
      expect(html).toMatch(/<details class="issue-section">\s*<summary><h2>Previous requirements <span>1<\/span><\/h2>/);
      expect(html).toContain("Old title");
    });

    it("names the approved version and who approved it", () => {
      const html = buildIssuePage(makeView({
        requirements: req(3, "T"),
        requirementsApproval: { version: 3, by: "stjohnb", at: "2026-09-21T09:00:00.000Z" },
      }), "dark");
      expect(html).toMatch(/Approved v3 by stjohnb, /);
    });

    it("shows a session approval as given on the operator's behalf", () => {
      const html = buildIssuePage(makeView({
        requirements: req(1, "T"),
        requirementsApproval: { version: 1, by: "session:abc", at: "2026-09-21T09:00:00.000Z" },
      }), "dark");
      expect(html).toMatch(/Approved v1 on your behalf by session abc, /);
      expect(html).not.toContain("by session:abc");
    });

    it("offers Promote while the issue is in Drafting or Requirements review, and says whether it waits", () => {
      const html = buildIssuePage(makeView({ requirements: req(1, "T"), lifecycle: "ideas", labels: [], source: "dashboard", autoPromotes: false }), "dark");
      expect(html).toContain(`<form method="POST" action="/issues/${ID}/promote"`);
      expect(html).toContain("Filed from dashboard · waits for you");
      const auto = buildIssuePage(makeView({ requirements: req(1, "T"), lifecycle: "ideas", labels: [], source: "automation", autoPromotes: true }), "dark");
      expect(auto).toContain("Filed from automation · auto-promotes");
      const stageOff = buildIssuePage(makeView({ requirements: req(1, "T"), lifecycle: "ideas", labels: [], source: "agent", requirementsStage: false, autoPromotes: false }), "dark");
      expect(stageOff).toContain("Filed from agent · plans from the issue text");
    });

    it("suffixes auto-promotes with (bug) or (alert) when that rule decided it", () => {
      const bug = buildIssuePage(makeView({
        requirements: req(1, "T"), lifecycle: "ideas", labels: [], source: "dashboard", autoPromotes: true, autoPromoteReason: "bug",
      }), "dark");
      expect(bug).toContain("Filed from dashboard · auto-promotes (bug)");

      const alert = buildIssuePage(makeView({
        requirements: req(1, "T"), lifecycle: "ideas", labels: [], source: "dashboard", autoPromotes: true, autoPromoteReason: "alert",
      }), "dark");
      expect(alert).toContain("Filed from dashboard · auto-promotes (alert)");
    });

    it("offers no Promote once the issue has left the requirements columns", () => {
      const html = buildIssuePage(makeView({ requirements: req(1, "T"), lifecycle: "planning", labels: [] }), "dark");
      expect(html).not.toContain("/promote");
    });

    it("offers Promote and says what is pending while a design change waits for re-approval", () => {
      const html = buildIssuePage(makeView({
        requirements: req(3, "T"), lifecycle: "planning", labels: [], reapprovalPending: { version: 3 },
        flight: { implementing: false, openPrs: [{ ...PR_ROW, stage: "awaiting-review", needsHumanReview: false, manualActionReason: "Held for re-approval: x" }] },
      }), "dark");
      expect(html).toContain(`<form method="POST" action="/issues/${ID}/promote"`);
      expect(html).toContain("Design change pending re-approval — promote requirements v3 or approve the Plan gate.");
      // It reads as waiting on the operator, not as a stalled PR.
      expect(html).toContain(`<span class="state-pill state-column">Awaiting plan review</span>`);
    });

    it("shows the title the issue was filed under once promotion renamed it", () => {
      const html = buildIssuePage(makeView({ filedTitle: "make it faster" }), "dark");
      expect(html).toContain("Filed as “make it faster”");
    });
  });

  it("opens Requirement and Decisions inside the current plan and closes the rest", () => {
    const html = buildIssuePage(makeView({ plan: planView(2, "Need it.") }), "dark");

    expect(html).toContain(`<details class="plan-section" open>\n        <summary><span>Requirement</span></summary>`);
    expect(html).toContain(`<details class="plan-section" open>\n        <summary><span>Decisions</span></summary>`);
    expect(html).toContain(`<details class="plan-section">\n        <summary><span>Implementation</span></summary>`);
    expect(html).toContain("v2 · ");
    expect(html).toContain("Models used: fable (provider: claude)");
  });

  it("opens a What changes section first in the current plan", () => {
    const plan = planView(2, "Need it.");
    plan.sections.unshift({ title: "What changes", html: "<p>A PR lands in org/repo.</p>" });
    const html = buildIssuePage(makeView({ plan }), "dark");

    const open = `<details class="plan-section" open>\n        <summary><span>What changes</span></summary>`;
    expect(html).toContain(open);
    expect(html.indexOf(open)).toBeLessThan(html.indexOf("<span>Requirement</span>"));
  });

  it("says there is no plan yet and omits Previous plans without older versions", () => {
    const html = buildIssuePage(makeView(), "dark");

    expect(html).toContain("No plan yet");
    expect(html).not.toContain("Previous plans");
  });

  it("lists previous plans newest first, closed", () => {
    const html = buildIssuePage(makeView({ plan: planView(3, "Now."), previousPlans: [planView(1, "First."), planView(2, "Second.")] }), "dark");

    expect(html).toMatch(/<details class="issue-section">\s*<summary><h2>Previous plans <span>2<\/span><\/h2><\/summary>/);
    const previous = html.slice(html.indexOf("Previous plans"));
    expect(previous.indexOf("Second.")).toBeLessThan(previous.indexOf("First."));
  });

  it("keeps the autosave forms and attachment controls", () => {
    const html = buildIssuePage(makeView(), "dark");

    expect(html).toContain(`data-autosave="labels"`);
    expect(html).toContain(`data-autosave="repos"`);
    expect(html).toContain("data-attach-form");
    expect(html).toContain("data-attach-row");
  });

  describe("Blocked callout", () => {
    const blocked = (o: Partial<IssuePageView> = {}) => makeView({ lifecycle: "blocked", labels: ["Blocked"], ...o });

    it("leads with a short reason before the Request section", () => {
      const html = buildIssuePage(blocked({ blockedReason: "Waiting on a manual step" }), "dark");
      expect(html).toContain('id="issue-blocked"');
      expect(html).toContain("Waiting on a manual step");
      expect(html.indexOf('id="issue-blocked"')).toBeLessThan(html.indexOf("Request"));
    });

    it("shows a reason naming a PR verbatim and escapes HTML", () => {
      const html = buildIssuePage(blocked({ blockedReason: "PR `owner/repo#12` CI <b>blocked</b>" }), "dark");
      expect(html).toContain("PR owner/repo#12 CI &lt;b&gt;blocked&lt;/b&gt;");
      expect(html).not.toContain("<b>blocked</b>");
    });

    it("hides the awaiting-operator marker in the callout", () => {
      const html = buildIssuePage(blocked({ blockedReason: "**Do** the step\nclaws-awaiting-operator" }), "dark");
      expect(html).toContain("Do the step");
      expect(html).not.toContain("claws-awaiting-operator");
    });

    it("puts a long reason in an expandable details", () => {
      const reason = "x".repeat(80);
      const html = buildIssuePage(blocked({ blockedReason: reason }), "dark");
      expect(html).toContain('<details class="blocked-callout-peek">');
      expect(html).toContain(reason);
    });

    it("states that no reason was recorded", () => {
      const html = buildIssuePage(blocked({ blockedReason: null }), "dark");
      expect(html).toContain("No reason was recorded for this block.");
    });

    it("renders nothing for a non-Blocked issue", () => {
      const html = buildIssuePage(makeView({ approvedThrough: "plan", blockedReason: "stale" }), "dark");
      expect(html).not.toContain('id="issue-blocked"');
    });

    it("renders nothing for a closed issue", () => {
      const html = buildIssuePage(blocked({ state: "closed", blockedReason: "stale" }), "dark");
      expect(html).not.toContain('id="issue-blocked"');
    });
  });

  // #clw_01M64CH10AK2PKH1JDGTB3FBMJ: waiting on other work is not "needs a human".
  describe("Queued callout", () => {
    const queued = (o: Partial<IssuePageView> = {}) => makeView({ lifecycle: "blocked", labels: ["Blocked"], ...o });

    it("names what the issue waits on in a neutral callout instead of the Blocked banner", () => {
      const html = buildIssuePage(queued({ blockedReason: "Waiting on `o/r#4` to merge", queuedReason: "Waiting on `o/r#4` to merge" }), "dark");
      expect(html).toContain('<div class="banner blocked-callout" id="issue-queued" role="status">');
      expect(html).toContain("Queued — waiting on other work");
      expect(html).toContain("Waiting on o/r#4 to merge");
      expect(html).not.toContain('id="issue-blocked"');
      expect(html).not.toContain("Blocked — needs a human");
      expect(html).toContain('<span class="state-pill state-column">Queued</span>');
    });

    it("keeps the Blocked banner when the issue is not queued", () => {
      const html = buildIssuePage(queued({ blockedReason: "Rotate the key", queuedReason: null }), "dark");
      expect(html).toContain('id="issue-blocked"');
      expect(html).not.toContain('id="issue-queued"');
    });
  });
});

describe("buildIssuePage request image gallery", () => {
  it("collapses 50 request images and leaves Attachments alone", () => {
    const body = Array.from({ length: 50 }, (_, i) => `![p${i}](/a/${i}.png)`).join("\n");
    const html = buildIssuePage(makeView({ bodyHtml: renderMarkdown(body, { collapseImages: true }) }), "dark");
    expect(html.split('<details class="image-gallery">').length - 1).toBe(1);
    expect(html).toContain("50 images");
    expect(html).toContain(`<details class="issue-section" open>\n      <summary><h2>Attachments`);
  });
});
