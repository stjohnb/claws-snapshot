import { describe, it, expect } from "vitest";
import { buildIssuePage, buildNewIssuePage, type IssuePageView } from "./issue.js";
import { NO_REPO_WARNING } from "./layout.js";
import { renderMarkdown } from "../markdown.js";
import { issueUrl } from "../config.js";
import { primaryRepo } from "../claws-issues.js";

const ID = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

function makeView(overrides: Partial<IssuePageView> = {}): IssuePageView {
  const body = overrides.body ?? "Some **bold** context.";
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
    repos: ["St-John-Software/claws"],
    labels: ["Ready", "Priority"],
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
    expect(html).toContain(`<a class="repo-chip" href="/repos/St-John-Software/claws" title="St-John-Software/claws">claws</a>`);
    expect(html).not.toContain(`>St-John-Software/claws<`);
  });

  it("renders the header's inline title editor and copy-URL button", () => {
    const view = makeView();
    const html = buildIssuePage(view, "dark");

    expect(html).toContain('id="issue-title-edit"');
    const permalink = issueUrl(primaryRepo(view.repos), view.id);
    expect(html).toContain(`id="issue-copy-url"`);
    expect(html).toContain(`data-copy-url="${permalink}"`);
    expect(html).toMatch(new RegExp(`<form class="issue-title-form" id="issue-title-form" method="POST" action="/issues/${ID}/edit" hidden>`));
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
    expect(html).toContain(`<p class="issue-meta" id="issue-repo-primary" hidden>`);
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
    expect(multi).toContain(`<p class="issue-meta" id="issue-repo-primary">Planned and tracked from <span id="issue-repo-primary-name" title="org/a">a</span>; its plan may open PRs in any of these repositories.</p>`);
    expect(buildIssuePage(makeView(), "dark")).toContain(`<p class="issue-meta" id="issue-repo-primary" hidden>`);
  });

  it("offers close actions while open and reopen once closed", () => {
    const open = buildIssuePage(makeView(), "dark");
    expect(open).toContain('value="closed"');
    expect(open).toContain("Close issue");
    expect(open).not.toContain("closed-completed");
    expect(open).not.toContain("closed-not_planned");
    expect(open).not.toContain('value="open"');
    expect(open).toContain("<h2>State</h2>");
    expect(open).not.toMatch(/<summary><h2>State/);

    const closed = buildIssuePage(makeView({ state: "closed", stateReason: "not_planned" }), "dark");
    expect(closed).toContain('value="open"');
    expect(closed).toContain("Reopen issue");
    expect(closed).toContain("state-closed");
    expect(closed).toContain("not planned");
  });

  it("does not offer Claws Staging as a label checkbox", () => {
    const html = buildIssuePage(makeView(), "dark");
    expect(html).not.toContain('value="Claws Staging"');
    expect(html).toContain('value="Claws Ignore"');

    const newIssue = buildNewIssuePage(["St-John-Software/claws"], "dark");
    expect(newIssue).not.toContain('value="Claws Staging"');
    expect(newIssue).toContain('value="Claws Ignore"');
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
    expect(html).toContain(`<span class="check-text">claws</span>`);
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

  it("offers no lifecycle label as a checkbox or a header chip", () => {
    const html = buildIssuePage(makeView({ labels: ["Ready", "Refined", "Blocked"] }), "dark");
    for (const label of ["Refined", "Ready", "Blocked"]) {
      expect(html).not.toContain(`name="label" value="${label}"`);
      expect(html).not.toMatch(new RegExp(`label-chip[^>]*>${label}<`));
    }
  });

  it("shows a Ready issue as Awaiting plan review with a Mark refined button", () => {
    const html = buildIssuePage(makeView(), "dark");
    expect(html).toMatch(/state-pill state-column">Awaiting plan review</);
    expect(html).toContain(`action="/issues/${ID}/column"`);
    expect(html).toContain(`name="column" value="approved"`);
    expect(html).toContain("Mark refined");
    expect(html).toContain("Mark blocked");
    expect(html).toContain("Move to Ideas");
    expect(html).toContain("Send back to Planning");
    expect(html).toContain(`name="column" value="backlog"`);
    expect(html).toContain("Send to backlog");
    expect(html).not.toContain(`name="column" value="awaiting-plan-review"`);
  });

  it("offers an issue in Ideas Promote to Planning, and one in Planning Move to Ideas", () => {
    const ideas = buildIssuePage(makeView({ labels: [], lifecycle: "ideas" }), "dark");
    expect(ideas).toMatch(/state-pill state-column">Ideas</);
    expect(ideas).toContain("Promote to Planning");
    expect(ideas).not.toContain(`name="column" value="ideas"`);
    const planning = buildIssuePage(makeView({ labels: [], lifecycle: "planning" }), "dark");
    expect(planning).toMatch(/state-pill state-column">Planning</);
    expect(planning).toContain("Move to Ideas");
    expect(planning).not.toContain(`name="column" value="planning"`);
  });

  it("offers Refine & Automerge beside Mark refined when Automerge is not yet applied", () => {
    const html = buildIssuePage(makeView(), "dark");
    expect(html).toMatch(
      /<form method="POST" action="\/issues\/[^"]+\/column">\s*<input type="hidden" name="column" value="approved">\s*<input type="hidden" name="automerge" value="1">\s*<button class="trigger-btn" type="submit">Refine &amp; Automerge<\/button>/,
    );
  });

  it("offers Mark refined but not Refine & Automerge once the issue already holds Automerge", () => {
    const html = buildIssuePage(makeView({ labels: ["Ready", "Automerge"] }), "dark");
    expect(html).toContain("Mark refined");
    expect(html).not.toContain("Refine &amp; Automerge");
  });

  it("offers neither Mark refined's Automerge partner on a closed or unassigned issue", () => {
    for (const view of [makeView({ state: "closed" }), makeView({ repos: [] })]) {
      expect(buildIssuePage(view, "dark")).not.toContain("Refine &amp; Automerge");
    }
  });

  it("shows a backlog issue as Backlog, with a way back to Ideas", () => {
    const html = buildIssuePage(makeView({ labels: ["Backlog"] }), "dark");
    expect(html).toMatch(/state-pill state-column">Backlog</);
    expect(html).toContain(`name="column" value="ideas"`);
    expect(html).not.toContain(`name="column" value="backlog"`);
  });

  it("offers an issue with an open PR no way back to Ideas, Planning or Awaiting plan review", () => {
    const html = buildIssuePage(makeView({ labels: [], flight: { implementing: false, openPrs: [{ stage: "awaiting-review", needsHumanReview: false }] } }), "dark");
    expect(html).toMatch(/state-pill state-column">PR open</);
    expect(html).toContain(`name="column" value="approved"`);
    expect(html).toContain(`name="column" value="blocked"`);
    // Its PR is open: backlogRefusal turns the move away.
    expect(html).not.toContain(`name="column" value="backlog"`);
    expect(html).not.toContain(`name="column" value="ideas"`);
    expect(html).not.toContain(`name="column" value="planning"`);
    expect(html).not.toContain(`name="column" value="awaiting-plan-review"`);
  });

  it("offers an issue whose implementer is running only Blocked", () => {
    const html = buildIssuePage(makeView({ labels: ["Refined"], flight: { implementing: true, openPrs: [] } }), "dark");
    expect(html).toMatch(/state-pill state-column">Implementing</);
    expect(html).toContain(`name="column" value="blocked"`);
    for (const column of ["ideas", "planning", "awaiting-plan-review", "approved", "backlog"]) {
      expect(html).not.toContain(`name="column" value="${column}"`);
    }
  });

  it("offers no status buttons on a closed or unassigned issue", () => {
    for (const view of [makeView({ state: "closed" }), makeView({ repos: [] })]) {
      expect(buildIssuePage(view, "dark")).not.toContain(`name="column"`);
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
    otherLifecycle: "approved",
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
    expect(html).toContain("Closed · completed");
    expect(html).toContain(">released</span>");
    expect(html).toContain(`action="/issues/${ID}/links/cll_01JBQ7X4M2K8NV3TYRW9GZ5PDC/delete"`);
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

describe("buildNewIssuePage", () => {
  it("offers the Requirements choice, following the repository default unless told otherwise", () => {
    const html = buildNewIssuePage(["org/a"], "dark");
    // The default must stay unchecked-on-wait: a "wait" default would
    // override every repo's claws.json `autoPromote` policy on every
    // dashboard-filed issue (#clw_01M39G3SREWPRP5AH0THJR0P24).
    expect(html).toContain(`<input type="radio" name="autoPromote" value="" checked> Follow the repository default`);
    expect(html).toContain(`<input type="radio" name="autoPromote" value="wait"> Wait for my review before planning`);
    expect(html).toContain(`<input type="radio" name="autoPromote" value="auto"> Promote automatically once written`);
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
    expect(html).toContain(`<input type="checkbox" name="backlog" value="1"> File to backlog`);
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
    expect(html).toContain(`<span class="check-text">claws</span>`);
    expect(html).not.toContain(`<span class="check-text">St-John-Software/claws</span>`);
  });

  it("shows repo checkboxes as short names even when options span several owners, with the full name in a title", () => {
    const html = buildNewIssuePage(["org/zeta", "forgejo/beta", "org/alpha"], "dark");
    expect(html).toContain(`<span class="check-text">zeta</span>`);
    expect(html).toContain(`<span class="check-text">beta</span>`);
    expect(html).toContain(`<span class="check-text">alpha</span>`);
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

  it("says an issue may name several repositories, or none until it is ready to plan", () => {
    const html = buildNewIssuePage([], "dark");
    expect(html).toContain("An issue may name several repositories");
    expect(html).toContain(NO_REPO_WARNING);
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

    it("offers Promote while the issue is in Ideas, and says whether it waits", () => {
      const html = buildIssuePage(makeView({ requirements: req(1, "T"), lifecycle: "ideas", labels: [], source: "dashboard", autoPromotes: false }), "dark");
      expect(html).toContain(`<form method="POST" action="/issues/${ID}/promote"`);
      expect(html).toContain("Filed from dashboard · waits for you");
      const auto = buildIssuePage(makeView({ requirements: req(1, "T"), lifecycle: "ideas", labels: [], source: "automation", autoPromotes: true }), "dark");
      expect(auto).toContain("Filed from automation · auto-promotes");
    });

    it("offers no Promote once the issue has left Ideas", () => {
      const html = buildIssuePage(makeView({ requirements: req(1, "T"), lifecycle: "planning", labels: [] }), "dark");
      expect(html).not.toContain("/promote");
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
});
