import { describe, it, expect } from "vitest";
import { buildBoardPage, ideaExcerpt, type BoardCard, type BoardCardPr, type BoardPageView } from "./board.js";
import { LABELS } from "../config.js";

const NATIVE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

const OPEN_PR: BoardCardPr = { stage: "awaiting-review", needsHumanReview: false, mergeApprovedAt: null };
const MERGE_READY_PR: BoardCardPr = { stage: "awaiting-merge", needsHumanReview: false, mergeApprovedAt: null };

function makeCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    repo: "org/repo",
    ref: 42,
    title: "Something broke",
    labels: [],
    url: "https://github.com/org/repo/issues/42",
    ...overrides,
  };
}

function makeView(cards: BoardCard[], overrides: Partial<BoardPageView> = {}): BoardPageView {
  // The default mirrors the handler: the dropdown enumerates what Claws
  // manages, so it holds every repository the cards name unless a test says
  // otherwise.
  const repoOptions = [...new Set(cards.map((c) => c.repo).filter(Boolean))];
  return { cards, repoOptions, repoFilter: "", incompleteSources: 0, backlogCount: 0, ...overrides };
}

/** The cards rendered inside one column, in document order. */
function columnCards(html: string, column: string): string[] {
  const body = html.match(new RegExp(`<div class="board-col-body" data-column="${column}">([\\s\\S]*?)</div>\\s*</details>`));
  if (!body) return [];
  return [...body[1].matchAll(/data-ref="([^"]+)"/g)].map((m) => m[1]);
}

describe("buildBoardPage", () => {
  it("renders the board with no explanatory paragraph under the columns", () => {
    const html = buildBoardPage(makeView([makeCard()]), "dark");
    expect(html).toContain('data-column="done"');
    expect(html).not.toContain("closed in the last 8 hours");
    expect(html).not.toContain('class="refresh-note"');
  });

  // The client hides this and applies a filter on change; it stays in the
  // markup for the no-JS path.
  it("renders the Filter button with the id the client hides it by", () => {
    const html = buildBoardPage(makeView([makeCard()]), "dark");

    expect(html).toContain(`<button class="trigger-btn" type="submit" id="board-filter-submit">Filter</button>`);
  });

  // The client refuses to drag a closed *forge* card back out of Done, and the
  // flag it reads has to be on the card the server rendered.
  it("marks a closed card so the client can refuse to reopen it", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1 }),
      makeCard({ ref: 2, closed: true }),
    ]), "dark");

    expect(html).toContain(`data-ref="2" data-column="done" data-closed="true"`);
    expect(html).not.toContain(`data-ref="1" data-column="drafting" data-closed`);
  });

  // A dropped issue is told apart from a shipped one at a glance; an issue
  // closed before this shipped carries no reason and gets no chip.
  it("shows a closed card's recorded reason as a chip, or none at all", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, closed: true, stateReason: "not_planned" }),
      makeCard({ ref: 2, closed: true, stateReason: "completed" }),
      makeCard({ ref: 3, closed: true }),
    ]), "dark");

    const cardHtml = (ref: number): string => {
      const start = html.indexOf(`data-ref="${ref}"`);
      const end = html.indexOf("</article>", start);
      return html.slice(start, end);
    };
    expect(cardHtml(1)).toContain(`<span class="board-chip-reason">Not planned</span>`);
    expect(cardHtml(2)).toContain(`<span class="board-chip-reason">Completed</span>`);
    expect(cardHtml(3)).not.toContain("board-chip-reason");
  });

  it("puts an issue awaiting its operator step in Awaiting merge with an Awaiting operator chip", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, awaitingOperator: true }),
      makeCard({ ref: 2, flight: { implementing: false, openPrs: [MERGE_READY_PR] } }),
    ]), "dark");

    expect(columnCards(html, "awaiting-merge")).toEqual(["1", "2"]);
    const cardHtml = (ref: number): string => {
      const start = html.indexOf(`data-ref="${ref}"`);
      return html.slice(start, html.indexOf("</article>", start));
    };
    expect(cardHtml(1)).toContain(`<span class="board-chip-operator" title="Comment claws-phase-done on the issue when the operator steps are done">Awaiting operator</span>`);
    expect(cardHtml(2)).not.toContain("board-chip-operator");
  });

  it("puts a design change pending re-approval in Awaiting plan review with a Needs decision chip", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, reapprovalPending: true, flight: { implementing: false, openPrs: [MERGE_READY_PR] } }),
      makeCard({ ref: 2, labels: [LABELS.ready] }),
    ]), "dark");

    expect(columnCards(html, "awaiting-plan-review")).toEqual(["1", "2"]);
    const cardHtml = (ref: number): string => {
      const start = html.indexOf(`data-ref="${ref}"`);
      return html.slice(start, html.indexOf("</article>", start));
    };
    expect(cardHtml(1)).toContain(">Needs decision · design change</span>");
    expect(cardHtml(2)).not.toContain("Needs decision");
  });

  // #clw_01M4EPRM9SYVGFG2BTZTMQEKDJ: a card Claws parked says why.
  it("shows a Blocked card's stored reason under a Needs a human chip", () => {
    const reason = "PR #28 merged without closing this issue — close it if the work is done, or re-plan the remainder.";
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, labels: [LABELS.blocked], blockedReason: reason }),
      makeCard({ ref: 2, labels: [LABELS.blocked] }),
    ]), "dark");

    expect(columnCards(html, "blocked")).toEqual(["1", "2"]);
    const cardHtml = (ref: number): string => {
      const start = html.indexOf(`data-ref="${ref}"`);
      return html.slice(start, html.indexOf("</article>", start));
    };
    expect(cardHtml(1)).toContain(`<span class="board-chip-operator">Needs a human</span>`);
    expect(cardHtml(1)).toContain(`<p class="board-blocked-reason" title="PR #28 merged without closing this issue`);
    expect(cardHtml(2)).not.toContain("Needs a human");
    expect(cardHtml(2)).not.toContain("board-blocked-reason");
  });

  // A parked issue stays in its column but never reads as one the planner is on.
  it("leads a Claws Ignore card with a Parked chip instead of the plain label chip", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, labels: [LABELS.clawsIgnore], lifecycle: "planning" }),
      makeCard({ ref: 2, lifecycle: "planning" }),
    ]), "dark");

    expect(columnCards(html, "planning")).toEqual(["1", "2"]);
    const cardHtml = (ref: number): string => {
      const start = html.indexOf(`data-ref="${ref}"`);
      return html.slice(start, html.indexOf("</article>", start));
    };
    expect(cardHtml(1)).toContain(`<div class="board-chips"><span class="board-chip-operator" title="Claws will not act on this issue until Claws Ignore is removed">Parked · Claws Ignore</span>`);
    expect(cardHtml(1).match(/Claws Ignore/g)).toHaveLength(2);
    expect(cardHtml(2)).not.toContain("Parked");
  });

  // The client's pre-flight has to know the flight even when the card sits
  // outside a derived column (Refined/Blocked outrank an open PR), since it
  // cannot derive it from the column alone.
  it("marks a card in flight so the client can refuse the Backlog tray", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, labels: [LABELS.refined], flight: { implementing: false, openPrs: [OPEN_PR] } }),
      makeCard({ ref: 2, labels: [LABELS.refined] }),
      makeCard({ ref: 3, flight: { implementing: true, openPrs: [OPEN_PR] } }),
    ]), "dark");

    expect(html).toContain(`data-ref="1" data-column="approved" data-in-flight="pr"`);
    expect(html).not.toContain(`data-ref="2" data-column="approved" data-in-flight`);
    expect(html).toContain(`data-ref="3" data-column="implementing" data-in-flight="task"`);
    expect(html).not.toContain("data-in-review");
  });

  // A form control inside a draggable ancestor is unreliable in Firefox, and
  // this select is the whole touch path for the feature.
  it("summarises operator-set model-plan cells on the card, and only then", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, modelPlan: "plan: claude/fable · impl: codex/sonnet" }),
      makeCard({ ref: 2 }),
    ]), "dark");
    expect(html).toContain(`<div class="board-model-plan" title="Model plan set by an operator">plan: claude/fable · impl: codex/sonnet</div>`);
    expect(html.match(/class="board-model-plan"/g)).toHaveLength(1);
  });

  it("keeps the move select out of the card's drag gesture", () => {
    const html = buildBoardPage(makeView([makeCard()]), "dark");

    expect(html).toContain(`<select class="board-move" draggable="false"`);
  });

  // A repo whose issues could not be fetched — or came back at the open-issue
  // cap — renders fewer cards than it has; an unannounced short board reads as
  // an empty backlog.
  it("reports incomplete sources in its own warning line", () => {
    const html = buildBoardPage(makeView([], { incompleteSources: 2 }), "dark");

    expect(html).toContain("some cards are missing");
    expect(html).toContain(`id="board-warning"`);
    expect(buildBoardPage(makeView([]), "dark")).not.toContain("some cards are missing");
  });

  // `#board-status` is the client's: it blanks it at the start of every move,
  // so a warning rendered there would vanish on the first drag and the board
  // would go back to reading as a complete backlog.
  it("keeps the warning out of the element the client clears", () => {
    const html = buildBoardPage(makeView([], { incompleteSources: 2 }), "dark");

    expect(html).toContain(`<div class="board-status" id="board-status" role="status" aria-live="polite"></div>`);
  });

  it("renders all eleven columns, in order", () => {
    const html = buildBoardPage(makeView([]), "dark");
    const order = ["drafting", "requirements-review", "planning", "awaiting-plan-review", "approved", "implementing", "pr-progressing", "pr-stalled", "blocked", "awaiting-merge", "done"];
    const positions = order.map((column) => html.indexOf(`<div class="board-col-body" data-column="${column}">`));
    expect(positions).not.toContain(-1);
    expect(html.match(/<details class="board-col[ "]/g)).toHaveLength(11);
    expect(html).not.toContain(`data-column="ideas"`);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).not.toContain(`data-column="in-progress"`);
  });

  // Shaping, Building and Landing, with Blocked alone between the last two.
  it("groups the columns under three headers with Blocked between Building and Landing", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1 }),
      makeCard({ ref: 2, flight: { implementing: true, openPrs: [] } }),
      makeCard({ ref: 3, flight: { implementing: false, openPrs: [OPEN_PR] } }),
      makeCard({ ref: 4, labels: [LABELS.refined] }),
    ]), "dark");

    const heads = [...html.matchAll(/<h2 class="board-group-head">([A-Za-z]+) /g)].map((m) => m[1]);
    expect(heads).toEqual(["Shaping", "Building", "Blocked", "Landing"]);
    const building = html.match(/<section class="board-group" data-group="building"[\s\S]*?<\/section>/)![0];
    expect(building).toContain(`data-column="approved"`);
    expect(building).toContain(`data-column="implementing"`);
    expect(building).toContain(`data-column="pr-progressing"`);
    expect(building).toContain(`data-column="pr-stalled"`);
    expect(building).toContain(`<span class="board-group-count" data-group-count="building">3</span>`);
    // The phone-only count of cards the collapsed derived columns hold.
    expect(building).toContain(`<span class="board-group-derived">· <span data-group-derived="building">2</span> set by Claws</span>`);
    // Landing's only derived column (Awaiting merge) waits on the operator, so it stays open and uncounted.
    const landing = html.match(/<section class="board-group" data-group="landing"[\s\S]*?<\/section>/)![0];
    expect(landing).not.toContain("board-group-derived");
    // Shaping's one Claws-set column is Drafting, folded on a phone and counted.
    const shaping = html.match(/<section class="board-group" data-group="shaping"[\s\S]*?<\/section>/)![0];
    expect(shaping).toContain(`<span class="board-group-derived">· <span data-group-derived="shaping">1</span> set by Claws</span>`);
    // Blocked sits in a group of its own, between Building and Landing.
    const blocked = html.match(/<section class="board-group board-group-solo" data-group="blocked" aria-label="Blocked">[\s\S]*?<\/section>/)![0];
    expect(blocked).toContain(`<details class="board-col" data-column="blocked"`);
    expect(html.indexOf(`data-group="building"`)).toBeLessThan(html.indexOf(`data-group="blocked"`));
    expect(html.indexOf(`data-group="blocked"`)).toBeLessThan(html.indexOf(`data-group="landing"`));
  });

  it("marks the human gates and the derived columns apart", () => {
    const html = buildBoardPage(makeView([]), "dark");
    for (const column of ["requirements-review", "planning", "awaiting-plan-review", "approved", "done"]) {
      expect(html).toContain(`<details class="board-col board-col-gate" data-column="${column}"`);
    }
    // Drafting is set by Claws, styled like the derived columns though it is a drop target.
    for (const column of ["drafting", "implementing", "pr-progressing", "pr-stalled", "awaiting-merge"]) {
      expect(html).toContain(`<details class="board-col board-col-derived" data-column="${column}"`);
    }
    expect(html).toContain(`<details class="board-col" data-column="blocked"`);
    expect(html).toContain(`.board-col-gate .board-col-title::before { content: "◆"; color: var(--accent);`);
    expect(html).toMatch(/title="[^"]*— set by Claws, not a drop target"><h3 class="board-col-title">PR progressing</);
    expect(html).toMatch(/title="[^"]*— drop a card here"><h3 class="board-col-title">Requirements review</);
    expect(html).toMatch(/title="Filed, or feedback left on the record — Claws writes or revises the requirements — drop a card here to send an issue back to requirements"><h3 class="board-col-title">Drafting</);
    expect(html).not.toContain(">Ideas<");
  });

  it("marks only the columns waiting on the operator with data-waits", () => {
    const html = buildBoardPage(makeView([]), "dark");
    const waiting = [...html.matchAll(/<details class="board-col[^"]*" data-column="([a-z-]+)" data-waits="true"/g)].map((m) => m[1]);
    expect(waiting).toEqual(["requirements-review", "awaiting-plan-review", "pr-stalled", "blocked", "awaiting-merge"]);
  });

  it("places each card in the column its labels and flight imply", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, labels: [] }),
      makeCard({ ref: 2, labels: [LABELS.ready] }),
      makeCard({ ref: 3, labels: [LABELS.refined] }),
      makeCard({ ref: 4, labels: [LABELS.refined], flight: { implementing: true, openPrs: [] } }),
      makeCard({ ref: 5, labels: [LABELS.ready], flight: { implementing: false, openPrs: [MERGE_READY_PR, OPEN_PR] } }),
      makeCard({ ref: 6, labels: [LABELS.blocked], flight: { implementing: false, openPrs: [OPEN_PR] } }),
      makeCard({ ref: 7, flight: { implementing: false, openPrs: [MERGE_READY_PR] } }),
      makeCard({ ref: 8, labels: [], closed: true }),
      makeCard({ ref: 9, flight: { implementing: false, openPrs: [OPEN_PR, { ...OPEN_PR, stage: "manual-action" }] } }),
    ]), "dark");

    expect(columnCards(html, "drafting")).toEqual(["1"]);
    expect(columnCards(html, "awaiting-plan-review")).toEqual(["2"]);
    expect(columnCards(html, "approved")).toEqual(["3"]);
    expect(columnCards(html, "implementing")).toEqual(["4"]);
    expect(columnCards(html, "pr-progressing")).toEqual(["5"]);
    expect(columnCards(html, "pr-stalled")).toEqual(["9"]);
    expect(columnCards(html, "blocked")).toEqual(["6"]);
    expect(columnCards(html, "awaiting-merge")).toEqual(["7"]);
    expect(columnCards(html, "done")).toEqual(["8"]);
  });

  // The requirements columns and Planning carry no label: the stored lifecycle
  // tells them apart, and the requirements state splits the first two.
  it("puts an unlabelled card in Planning when its lifecycle says so, and in Drafting otherwise", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, lifecycle: "ideas" }),
      makeCard({ ref: 2, lifecycle: "planning" }),
      makeCard({ ref: 3 }),
    ]), "dark");
    expect(columnCards(html, "drafting")).toEqual(["1", "3"]);
    expect(columnCards(html, "planning")).toEqual(["2"]);
  });

  it("chips a card in Requirements review with its requirements version, and a Drafting card with none", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, requirementsVersion: null }),
      makeCard({ ref: 2, requirementsVersion: 3, requirementsReview: true }),
      makeCard({ ref: 3, requirementsVersion: 2, requirementsReview: false }),
      makeCard({ ref: 4, lifecycle: "planning", requirementsVersion: 1, requirementsReview: true }),
    ]), "dark");
    expect(columnCards(html, "requirements-review")).toEqual(["2"]);
    expect(columnCards(html, "drafting")).toEqual(["1", "3"]);
    expect(html).toContain(`<span class="board-chip-req">requirements v3</span>`);
    // Drafting says it by its column; nothing says "no requirements yet".
    expect(html).not.toContain("no requirements yet");
    expect(html).not.toContain("requirements v2<");
    // Past promotion the record is not what waits on a human.
    expect(html).not.toContain("requirements v1");
  });

  // The board's four cases (#clw_01M4698S2SM46GKS36G1V5BH57): the route works
  // out `requirementsReview` from the versions and comments; the page places
  // the card and marks only Requirements review as waiting on the operator.
  it("splits `ideas` cards between Drafting and Requirements review by requirements state", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, lifecycle: "ideas", requirementsVersion: null, requirementsReview: false }),
      makeCard({ ref: 2, lifecycle: "ideas", requirementsVersion: 1, requirementsReview: true }),
      makeCard({ ref: 3, lifecycle: "ideas", requirementsVersion: 1, requirementsReview: false }),
      makeCard({ repo: "", ref: NATIVE, url: `/issues/${NATIVE}`, lifecycle: "ideas", requirementsVersion: 1, requirementsReview: true }),
    ]), "dark");
    expect(columnCards(html, "drafting")).toEqual(["1", "3", NATIVE]);
    expect(columnCards(html, "requirements-review")).toEqual(["2"]);
    expect(html).toContain(`data-column="requirements-review" data-waits="true"`);
    expect(html).not.toContain(`data-column="drafting" data-waits`);
  });

  // The PRs that need a person must not hide among the ones mid-review.
  it("puts chips from the rows on a card in either PR column", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, flight: { implementing: false, openPrs: [
        { stage: "manual-action", needsHumanReview: false, mergeApprovedAt: null },
        { stage: "problematic", needsHumanReview: true, mergeApprovedAt: null },
        { stage: "ci-failing", needsHumanReview: true, mergeApprovedAt: null },
      ] } }),
      makeCard({ ref: 2, flight: { implementing: false, openPrs: [OPEN_PR] } }),
      // Not in a PR column: Approved outranks the row, so no chips.
      makeCard({ ref: 3, labels: [LABELS.refined], flight: { implementing: false, openPrs: [{ stage: "ci-failing", needsHumanReview: true, mergeApprovedAt: null }] } }),
      makeCard({ ref: 4, flight: { implementing: false, openPrs: [{ stage: "ci-failing", needsHumanReview: true, mergeApprovedAt: null }] } }),
    ]), "dark");
    expect(columnCards(html, "pr-stalled")).toEqual(["1"]);
    expect(columnCards(html, "pr-progressing")).toEqual(["2", "4"]);
    const cards = html.match(/<article class="board-card"[\s\S]*?<\/article>/g)!;
    const chips = cards.find((c) => c.includes(`data-ref="1"`))!;
    const plain = cards.find((c) => c.includes(`data-ref="2"`))!;
    const approved = cards.find((c) => c.includes(`data-ref="3"`))!;

    for (const label of [LABELS.manualAction, LABELS.problematic, LABELS.needsLgtm]) {
      expect(chips.match(new RegExp(`label-chip[^>]*>${label}<`, "g")), label).toHaveLength(1);
    }
    expect(chips).toContain(`<span class="board-chip-ci">CI failing</span>`);
    const progressing = cards.find((c) => c.includes(`data-ref="4"`))!;
    expect(progressing).toContain(`<span class="board-chip-ci">CI failing</span>`);
    expect(progressing).toContain(`>${LABELS.needsLgtm}<`);
    for (const card of [plain, approved]) {
      expect(card).not.toContain("board-chip-ci");
      expect(card).not.toContain(`>${LABELS.needsLgtm}<`);
    }
  });

  // The chips follow the same live PR status the repo page and All PRs show.
  describe("live PR status chips", () => {
    const chipsOf = (openPrs: BoardCardPr[]) => {
      const html = buildBoardPage(makeView([makeCard({ ref: 1, flight: { implementing: false, openPrs } })]), "dark");
      return html.match(/<article class="board-card"[\s\S]*?<\/article>/)![0];
    };

    it("shows CI failing for a live failing status whatever the stage", () => {
      expect(chipsOf([{ ...OPEN_PR, liveCheckStatus: "failing" }])).toContain(`<span class="board-chip-ci">CI failing</span>`);
    });

    it("drops a stale ci-failing stage when the live checks pass", () => {
      expect(chipsOf([{ stage: "ci-failing", needsHumanReview: false, mergeApprovedAt: null, liveCheckStatus: "passing" }])).not.toContain("CI failing");
    });

    it("shows Conflicts for a conflicting PR", () => {
      expect(chipsOf([{ ...OPEN_PR, mergeableState: "CONFLICTING" }])).toContain(`<span class="board-chip-ci">Conflicts</span>`);
      expect(chipsOf([{ ...OPEN_PR, mergeableState: "UNKNOWN" }])).not.toContain("Conflicts");
    });

    it("shows Merge blocked for a PR the auto-merger declined", () => {
      expect(chipsOf([{ ...OPEN_PR, mergeBlocked: true }])).toContain(`<span class="board-chip-ci">Merge blocked</span>`);
    });

    it("shows each chip once when two PRs carry it", () => {
      const pr: BoardCardPr = { ...OPEN_PR, liveCheckStatus: "failing", mergeableState: "CONFLICTING", mergeBlocked: true };
      const card = chipsOf([pr, pr]);
      for (const chip of ["CI failing", "Conflicts", "Merge blocked"]) {
        expect(card.match(new RegExp(`board-chip-ci">${chip}<`, "g")), chip).toHaveLength(1);
      }
      expect(card.indexOf("CI failing")).toBeLessThan(card.indexOf("Conflicts"));
      expect(card.indexOf("Conflicts")).toBeLessThan(card.indexOf("Merge blocked"));
    });
  });

  it("shows the ref, title, repo chip and labels on a card", () => {
    const html = buildBoardPage(makeView([
      makeCard({ labels: ["bug"], title: "Fix the thing" }),
    ]), "dark");

    expect(html).toContain("#42");
    expect(html).toContain("Fix the thing");
    expect(html).toContain("org/repo");
    expect(html).toContain(">bug<");
  });

  it("shows the repo chip in short form with the full name in a title and data-repo", () => {
    const html = buildBoardPage(makeView([makeCard({ repo: "org/repo" })]), "dark");

    expect(html).toContain(`<span class="board-repo" title="org/repo">repo</span>`);
    expect(html).toContain(`data-repo="org/repo"`);
    expect(html).not.toContain(`>org/repo<`);
  });

  it("marks a Priority card and does not repeat the label as a chip", () => {
    const html = buildBoardPage(makeView([makeCard({ labels: [LABELS.priority, LABELS.ready, "bug"] })]), "dark");
    const card = html.match(/<article class="board-card"[\s\S]*?<\/article>/)![0];

    expect(card).toContain("board-priority");
    expect(card).toContain(`label-chip`);
    expect(card.match(new RegExp(`label-chip[^>]*>${LABELS.priority}<`))).toBeNull();
  });

  it("does not repeat the lifecycle labels the column already shows as chips", () => {
    const html = buildBoardPage(makeView([makeCard({ labels: [LABELS.refined, LABELS.priority] })]), "dark");
    const card = html.match(/<article class="board-card"[\s\S]*?<\/article>/)![0];

    for (const label of [LABELS.refined, LABELS.priority]) {
      expect(card.match(new RegExp(`label-chip[^>]*>${label}<`))).toBeNull();
    }
  });

  it("renders the Automerge toggle with data-on matching whether the card holds the label", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, labels: [LABELS.automerge] }),
      makeCard({ ref: 2, labels: [] }),
    ]), "dark");
    const cards = html.match(/<article class="board-card"[\s\S]*?<\/article>/g)!;
    const on = cards.find((c) => c.includes(`data-ref="1"`))!;
    const off = cards.find((c) => c.includes(`data-ref="2"`))!;

    expect(on).toContain(`class="board-automerge" draggable="false" data-on="true"`);
    expect(off).toContain(`class="board-automerge" draggable="false" data-on="false"`);
  });

  // The row's merge approval is what the toggle turns on, so a row that
  // carries one shows the toggle on whether or not the issue has the label.
  it("shows the Automerge toggle on for an open row with a merge approval", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, flight: { implementing: false, openPrs: [OPEN_PR, { ...MERGE_READY_PR, mergeApprovedAt: "2026-09-24T10:00:00Z" }] } }),
      makeCard({ ref: 2, flight: { implementing: false, openPrs: [OPEN_PR] } }),
    ]), "dark");
    const cards = html.match(/<article class="board-card"[\s\S]*?<\/article>/g)!;

    expect(cards.find((c) => c.includes(`data-ref="1"`))).toContain(`data-on="true"`);
    expect(cards.find((c) => c.includes(`data-ref="2"`))).toContain(`data-on="false"`);
  });

  // With an open PR the toggle approves that PR's merge; with none, labelling
  // the issue decides only the next PR Claws opens.
  it("scopes the Automerge toggle title to having no open PR", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, labels: [LABELS.refined, LABELS.automerge] }),
      makeCard({ ref: 2, labels: [LABELS.refined], flight: { implementing: false, openPrs: [OPEN_PR] } }),
      makeCard({ ref: 3, flight: { implementing: true, openPrs: [] } }),
    ]), "dark");
    const cards = html.match(/<article class="board-card"[\s\S]*?<\/article>/g)!;
    const card = (ref: number) => cards.find((c) => c.includes(`data-ref="${ref}"`))!;

    expect(card(1)).toContain(`title="Automerge on (applies to the next PR Claws opens) — Claws merges the PR on green CI and a clean review; click to turn off"`);
    expect(card(2)).toContain(`title="Automerge off — click to apply"`);
    expect(card(3)).toContain(`title="Automerge off (applies to the next PR Claws opens) — click to apply"`);
  });

  it("renders no Automerge toggle in Done or on an unassigned card", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, closed: true, labels: [LABELS.automerge] }),
      makeCard({ ref: 2, repo: "" }),
    ]), "dark");
    const cards = html.match(/<article class="board-card"[\s\S]*?<\/article>/g)!;

    for (const card of cards) expect(card).not.toContain("board-automerge");
  });

  it("does not repeat Automerge as a label chip once the toggle carries it", () => {
    const html = buildBoardPage(makeView([makeCard({ labels: [LABELS.automerge, "bug"] })]), "dark");
    const card = html.match(/<article class="board-card"[\s\S]*?<\/article>/)![0];

    expect(card).toContain("board-automerge");
    expect(card.match(new RegExp(`label-chip[^>]*>${LABELS.automerge}<`))).toBeNull();
    expect(card).toContain(`label-chip`);
  });

  it("links a native card to its dashboard page", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: NATIVE, url: `/issues/${NATIVE}` }),
    ]), "dark");
    expect(html).toContain(`href="/issues/${NATIVE}"`);
    expect(html).toContain(`data-ref="${NATIVE}"`);
  });

  it("puts an unassigned native issue in Drafting and says so", () => {
    const html = buildBoardPage(makeView([
      makeCard({ repo: "", ref: NATIVE, url: `/issues/${NATIVE}`, labels: [LABELS.refined] }),
    ]), "dark");

    expect(columnCards(html, "drafting")).toEqual([NATIVE]);
    expect(html).toContain("unassigned");
  });

  it("offers no derived column in the per-card move select, hiding the current one", () => {
    const html = buildBoardPage(makeView([makeCard({ labels: [LABELS.ready], hasPlan: true })]), "dark");
    const select = html.match(/<select class="board-move"[\s\S]*?<\/select>/)![0];

    expect(select).toContain(`<option value="drafting">`);
    expect(select).toContain(`<option value="requirements-review">`);
    expect(select).toContain(`<option value="awaiting-plan-review" hidden>`);
    for (const column of ["approved", "blocked", "done"]) expect(select).toContain(`<option value="${column}">`);
    for (const column of ["implementing", "pr-progressing", "pr-stalled", "awaiting-merge"]) expect(select).not.toContain(`value="${column}"`);
  });

  // Every other column is a guaranteed 409 for a card no repository owns, and
  // the select is the whole touch path.
  it("offers an unassigned card only the columns it can reach", () => {
    const html = buildBoardPage(makeView([
      makeCard({ repo: "", ref: NATIVE, url: `/issues/${NATIVE}` }),
    ]), "dark");
    const select = html.match(/<select class="board-move"[\s\S]*?<\/select>/)![0];

    expect(select).toContain(`<option value="drafting" hidden>`);
    expect(select).toContain(`<option value="done">`);
    for (const column of ["requirements-review", "awaiting-plan-review", "approved", "blocked", "pr-progressing", "pr-stalled"]) {
      expect(select).not.toContain(`value="${column}"`);
    }
  });

  // No move touches the task or the PR, so only what outranks the flight in
  // `columnFor` is reachable: Blocked and Done for a running implementer,
  // Approved as well for an open PR. The rest is a guaranteed
  // `DERIVED_COLUMN_REJECTION` 409.
  it("offers a card in flight only the columns that outrank its flight", () => {
    const selectOf = (card: BoardCard): string =>
      buildBoardPage(makeView([card]), "dark").match(/<select class="board-move"[\s\S]*?<\/select>/)![0];
    const task = selectOf(makeCard({ flight: { implementing: true, openPrs: [] } }));
    const pr = selectOf(makeCard({ hasPlan: true, flight: { implementing: false, openPrs: [OPEN_PR] } }));

    for (const column of ["blocked", "done"]) {
      expect(task).toContain(`<option value="${column}">`);
      expect(pr).toContain(`<option value="${column}">`);
    }
    expect(task).not.toContain(`value="approved"`);
    expect(pr).toContain(`<option value="approved">`);
    for (const column of ["drafting", "requirements-review", "awaiting-plan-review", "backlog"]) {
      expect(task).not.toContain(`value="${column}"`);
      expect(pr).not.toContain(`value="${column}"`);
    }
  });

  // Keyed off the card's flight, not its column: the PR stays open across board
  // moves, so a card in Approved still has it and the restriction stays true.
  it("keeps the flight restriction on a card outside the derived columns", () => {
    const html = buildBoardPage(makeView([makeCard({ labels: [LABELS.refined], flight: { implementing: false, openPrs: [OPEN_PR] } })]), "dark");
    const select = html.match(/<select class="board-move"[\s\S]*?<\/select>/)![0];

    // Approved is where this card renders, so its own option is hidden, not gone.
    expect(select).toContain(`<option value="approved" hidden>`);
    expect(select).not.toContain(`value="awaiting-plan-review"`);
  });

  // Approved and Awaiting plan review need a plan: with none, both are a
  // guaranteed 409, so neither is offered — and the card says whether it has
  // one, for the client's drag path.
  it("offers Approved and Awaiting plan review only to a card with a plan", () => {
    const render = (card: BoardCard) => buildBoardPage(makeView([card]), "dark");
    const selectOf = (html: string): string => html.match(/<select class="board-move"[\s\S]*?<\/select>/)![0];

    const planless = render(makeCard());
    expect(selectOf(planless)).not.toContain(`value="approved"`);
    expect(selectOf(planless)).not.toContain(`value="awaiting-plan-review"`);
    expect(selectOf(planless)).toContain(`<option value="planning">`);
    expect(planless).not.toContain(`data-has-plan`);

    const planned = render(makeCard({ hasPlan: true }));
    expect(selectOf(planned)).toContain(`<option value="approved">`);
    expect(selectOf(planned)).toContain(`<option value="awaiting-plan-review">`);
    expect(planned).toContain(`data-has-plan="true"`);
  });

  // Backlog is a destination, not a column (#3293).
  it("offers Backlog in the move select, except to a card in flight or an unassigned one", () => {
    const selectOf = (card: BoardCard): string =>
      buildBoardPage(makeView([card]), "dark").match(/<select class="board-move"[\s\S]*?<\/select>/)![0];

    expect(selectOf(makeCard())).toContain(`<option value="backlog">Backlog</option>`);
    expect(selectOf(makeCard({ flight: { implementing: true, openPrs: [] } }))).not.toContain(`value="backlog"`);
    expect(selectOf(makeCard({ repo: "", ref: NATIVE, url: `/issues/${NATIVE}` }))).not.toContain(`value="backlog"`);
  });

  it("leaves backlog cards off the board", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1 }),
      makeCard({ ref: 2, labels: [LABELS.backlog] }),
    ]), "dark");

    expect(html).toContain(`data-ref="1"`);
    expect(html).not.toContain(`data-ref="2"`);
    expect(html).not.toContain("board-backlog-link");
    for (const col of ["drafting", "requirements-review", "planning", "awaiting-plan-review", "approved", "implementing", "pr-progressing", "pr-stalled", "blocked", "awaiting-merge", "done"]) {
      expect(columnCards(html, col)).not.toContain("2");
    }
  });

  it("renders the Backlog tray as a drop target outside the columns", () => {
    const html = buildBoardPage(makeView([makeCard()]), "dark");

    expect(html).toMatch(/<div class="board-col-body board-tray-body" data-column="backlog"[^>]*>/);
    // A destination, not a column: not a .board-col, but a collapsible tray,
    // folded by default, whose summary counts the backlog under the filter.
    expect(html).not.toContain(`<details class="board-col" data-column="backlog"`);
    expect(html).toContain(`<details class="board-tray" aria-label="Backlog">`);
    expect(html).not.toMatch(/<details class="board-tray"[^>]* open/);
    expect(html).toContain(`<summary class="board-tray-head">Backlog <span class="board-col-count" data-count="backlog">0</span></summary>`);
    expect(buildBoardPage(makeView([makeCard()], { backlogCount: 4 }), "dark")).toContain(`data-count="backlog">4</span>`);
    expect(html).toContain(`id="issue-board-surface"`);
  });

  it("renders no selection checkbox and no bulk send button", () => {
    const html = buildBoardPage(makeView([makeCard({ ref: 1 })]), "dark");

    expect(html).not.toContain("board-select");
    expect(html).not.toContain("board-bulk-backlog");
  });

  it("shows a native card in short form, with the full id in data-ref and title", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: NATIVE, url: `/issues/${NATIVE}` }),
    ]), "dark");

    expect(html).toContain(`data-ref="${NATIVE}"`);
    expect(html).toContain(`title="${NATIVE}">#clw_GZ5PDC</a>`);
    expect(html).not.toContain(`>#${NATIVE}<`);
  });

  it("lists a multi-repo card under every repo it names, marking the primary", () => {
    const cards = [makeCard({ ref: 1, repo: "org/a", repos: ["org/a", "org/b"] }), makeCard({ ref: 2, repo: "org/c" })];
    const html = buildBoardPage(makeView(cards, { repoFilter: "org/b" }), "dark");
    expect(html).toContain(`data-ref="1"`);
    expect(html).not.toContain(`data-ref="2"`);
    expect(html).toContain(`<span class="board-repo" title="Primary repository: owns planning and labels (org/a)">a</span>`);
    expect(html).toContain(`<span class="board-repo board-repo-also" title="Also names org/b">b</span>`);
  });

  it("filters by repo, and offers no Label filter", () => {
    const cards = [
      makeCard({ ref: 1, repo: "org/a", labels: [LABELS.ready] }),
      makeCard({ ref: 2, repo: "org/b", labels: [LABELS.ready] }),
      makeCard({ ref: 3, repo: "org/a", labels: [] }),
    ];

    const byRepo = buildBoardPage(makeView(cards, { repoFilter: "org/a" }), "dark");
    expect(byRepo).toContain(`data-ref="1"`);
    expect(byRepo).not.toContain(`data-ref="2"`);
    expect(byRepo).toContain(`data-ref="3"`);

    expect(byRepo).not.toContain(`name="label"`);
  });

  // No visible caption: the empty option and the aria-label name the select.
  it("names the Repository select through its empty option and aria-label", () => {
    const html = buildBoardPage(makeView([makeCard()]), "dark");

    expect(html).toContain(`<select class="form-select" name="repo" aria-label="Repository">`);
    expect(html).toContain(`<option value="" selected>All repositories</option>`);
    expect(html).not.toContain(`href="/board">Clear</a>`);
  });

  // The selects come from the unfiltered board, so a filter can always be
  // widened again from the page it produced.
  it("offers the filtered-out repo as a filter option", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, repo: "org/a" }),
      makeCard({ ref: 2, repo: "org/b" }),
    ], { repoFilter: "org/a" }), "dark");

    expect(html).toContain(`<option value="org/b">b</option>`);
    expect(html).toContain(`<option value="org/a" selected>a</option>`);
  });

  // The Repository options are what Claws manages, not what the rendered cards
  // name: `?repo=` and the Done column's row cap both cut cards before the page
  // sees them, so a repository derived from the survivors would disappear from
  // the very filter that is hiding it.
  it("offers every managed repository, including ones with no card on the board", () => {
    const html = buildBoardPage(makeView([makeCard({ ref: 1, repo: "org/a" })], {
      repoOptions: ["org/a", "org/quiet"],
      repoFilter: "org/a",
    }), "dark");

    expect(html).toContain(`<option value="org/quiet">quiet</option>`);
  });

  // A managed repo with no open issues has no card to derive an option from,
  // and a select reading "All" over an empty board hides that it is filtered.
  it("shows a filter that matches nothing as the selected option", () => {
    const html = buildBoardPage(makeView([makeCard({ repo: "org/a", labels: [LABELS.ready] })], {
      repoFilter: "org/quiet",
    }), "dark");

    expect(html).toContain(`<option value="org/quiet" selected>quiet</option>`);
    expect(html).toContain("<h2>Board <span>0</span></h2>");
  });

  // The server hands cards over in repo order, so the Priority mark only means
  // something on a tall column if the card is sorted to the top of it, and
  // within each group the most recently updated card leads.
  it("puts Priority cards at the top of their column, newest first within each group", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, labels: [LABELS.ready], updatedAt: "2024-01-01T00:00:00Z" }),
      makeCard({ ref: 2, labels: [LABELS.ready, LABELS.priority], updatedAt: "2024-01-02T00:00:00Z" }),
      makeCard({ ref: 3, labels: [LABELS.ready], updatedAt: "2024-01-03T00:00:00Z" }),
      makeCard({ ref: 4, labels: [LABELS.ready, LABELS.priority], updatedAt: "2024-01-04T00:00:00Z" }),
    ]), "dark");

    expect(columnCards(html, "awaiting-plan-review")).toEqual(["4", "2", "3", "1"]);
  });

  // A card with no `updatedAt` sorts after every card that has one, within its
  // group; two cards with the same `updatedAt` keep arrival order.
  it("sorts a card with no updatedAt after cards that have one, and keeps ties in arrival order", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, labels: [LABELS.ready] }),
      makeCard({ ref: 2, labels: [LABELS.ready], updatedAt: "2024-01-01T00:00:00Z" }),
      makeCard({ ref: 3, labels: [LABELS.ready], updatedAt: "2024-01-01T00:00:00Z" }),
    ]), "dark");

    expect(columnCards(html, "awaiting-plan-review")).toEqual(["2", "3", "1"]);
  });

  // The Done column is re-ordered like every other one, on top of the
  // server's own `closed_at` cut.
  it("orders the Done column by updatedAt descending", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, closed: true, updatedAt: "2024-01-01T00:00:00Z" }),
      makeCard({ ref: 2, closed: true, updatedAt: "2024-01-05T00:00:00Z" }),
    ]), "dark");

    expect(columnCards(html, "done")).toEqual(["2", "1"]);
  });

  it("escapes a hostile title rather than rendering it", () => {
    const html = buildBoardPage(makeView([makeCard({ title: "<script>alert(1)</script>" })]), "dark");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  // The board's eight columns never fit inside the dashboard's default 64rem
  // body width; the `full` tier lets it use whatever the window offers.
  it("takes the full page-width tier and gives desktop columns flexible width", () => {
    const html = buildBoardPage(makeView([]), "dark");

    expect(html).toContain(`data-width="full"`);
    expect(html).toContain(`.board-group-cols > .board-col { flex: 1 1 0; min-width: 13rem; max-width: 22rem; }`);
    expect(html).toContain(`.board-filters .form-select { width: auto;`);
  });

  // Phone: everything stacks. Tablet: the groups stack, but each group's
  // columns sit side by side. Desktop: one horizontally scrolling row.
  it("stacks on a phone, rows each group on a tablet, and rows the whole board on a desktop", () => {
    const html = buildBoardPage(makeView([]), "dark");
    const styleBlock = html.match(/<style>([\s\S]*?)<\/style>/)![1];
    // The board's own blocks, not the shared PAGE_CSS ones at the same widths.
    const boardCss = styleBlock.slice(styleBlock.indexOf(".board-filters"));
    const boardBlock = (width: number): string => boardCss.match(new RegExp(`@media \\(min-width: ${width}px\\) \\{([\\s\\S]*?)\\n {2}\\}`))![1];
    const tablet = boardBlock(768);
    const desktop = boardBlock(1024);

    expect(styleBlock).toContain(`.board { display: flex; flex-direction: column; gap: 0.6rem; }`);
    expect(styleBlock).toContain(`.board-group-cols { display: flex; flex-direction: column; gap: 0.6rem; }`);
    expect(desktop).toContain(`.board-group { flex: 1 1 auto; min-width: min-content; }`);
    expect(tablet).not.toContain(`.board-group {`);
    expect(styleBlock).toContain(`.board-col { width: 100%;`);
    expect(styleBlock).not.toContain(`flex: 0 0 min(80vw, 17rem)`);
    expect(tablet).toContain(`.board-group-cols { flex-direction: row;`);
    expect(tablet).toContain(`.board-group-cols > .board-col { flex: 1 1 0;`);
    expect(tablet).toContain(`min-width: 0; width: auto; }`);
    // The derived count is phone-only: from a tablet up, the columns are open.
    expect(tablet).toContain(`.board-group-derived { display: none; }`);
    expect(styleBlock).toContain(`.board-group-solo > .board-group-head { display: none; }`);
    expect(tablet).toContain(`.board-group-solo > .board-group-head { display: flex; }`);
    expect(tablet).not.toContain(`.board { flex-direction: row`);
    expect(desktop).toContain(`.board { flex-direction: row; overflow-x: auto;`);
    expect(desktop).toContain(`min-width: 13rem; max-width: 22rem; }`);
    // Column heads toggle at every width, and a collapsed column shrinks to its header.
    expect(tablet).not.toContain(`pointer-events: none`);
    expect(tablet).not.toContain(`.board-col-head::after { display: none; }`);
    expect(tablet).toContain(`.board-group-cols > .board-col:not([open]) { flex: 0 1 auto; min-width: 0; }`);
    expect(desktop).toContain(`.board-group-cols > .board-col:not([open]) { flex: 0 0 9rem; width: 9rem; min-width: 9rem; }`);
  });

  // Only the columns waiting on the operator render open, at every width, so a
  // no-JS first paint is already the default; the rest are collapsed but still
  // show their name and count.
  it("renders every column as a collapsible <details>, open only where it waits on the operator", () => {
    const html = buildBoardPage(makeView([makeCard({ ref: 1, labels: [LABELS.ready] })]), "dark");

    expect(html).toContain(`<details class="board-col board-col-derived" data-column="drafting" aria-label="Drafting">`);
    expect(html).toContain(`<details class="board-col board-col-gate" data-column="requirements-review" data-waits="true" open aria-label="Requirements review">`);
    const open = [...html.matchAll(/<details class="board-col[^"]*" data-column="([a-z-]+)"[^>]* open /g)].map((m) => m[1]);
    expect(open).toEqual(["requirements-review", "awaiting-plan-review", "pr-stalled", "blocked", "awaiting-merge"]);
    for (const column of ["drafting", "planning", "approved", "implementing", "pr-progressing", "done"]) {
      expect(html).toMatch(new RegExp(`<details class="board-col[^"]*" data-column="${column}" aria-label="[^"]+">\\s*<summary class="board-col-head"[^>]*><h3 class="board-col-title">[^<]+</h3> <span class="board-col-count" data-count="${column}">\\d+</span></summary>`));
    }
    const summary = html.match(/<summary class="board-col-head"[\s\S]*?<\/summary>/)!;
    expect(summary[0]).toContain(`<h3 class="board-col-title">`);
    expect(summary[0]).toContain(`<span class="board-col-count" data-count="drafting">`);
  });

  it("counts only the visible cards", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, labels: [LABELS.ready] }),
      makeCard({ ref: 2, labels: [LABELS.ready] }),
      makeCard({ ref: 3, labels: [] }),
    ]), "dark");

    expect(html).toContain("<h2>Board <span>3</span></h2>");
    expect(html).toContain(`data-count="awaiting-plan-review">2<`);
    expect(html).toContain(`data-count="approved">0<`);
  });

  // Title, count and filter share one toolbar row: the page
  // header prints no second "Board".
  it("renders one toolbar holding the title and the repo filter", () => {
    const html = buildBoardPage(makeView([makeCard()]), "dark");
    const beforeColumns = html.slice(0, html.indexOf(`id="issue-board"`));

    expect(beforeColumns.match(/<h2[ >]/g)).toHaveLength(1);
    expect(html).toMatch(/<div class="board-toolbar">\s*<h2>Board <span>1<\/span><\/h2>\s*<form class="board-filters"[\s\S]*?<\/form>\s*<\/div>/);
  });
});

describe("buildBoardPage age chip", () => {
  const HOUR = 60 * 60 * 1000;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("shows how long a native card has been in its column, in the card head", () => {
    const since = ago(2 * HOUR + 5 * 60 * 1000);
    const html = buildBoardPage(makeView([makeCard({ ref: 1, labels: [LABELS.ready], stageSince: since, updatedAt: ago(60_000) })]), "dark");

    expect(html).toMatch(/<div class="board-card-head">\s*<a class="board-ref"[^>]*>#1<\/a><span class="board-age" data-stale="false" title="In Awaiting plan review for 2h \(since [^"]+\)">2h<\/span>/);
    expect(html).toContain(`(since ${since})`);
  });

  it("warns on a Drafting or Requirements review card past its threshold but never on a Blocked one", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, stageSince: ago(4 * 24 * HOUR) }),
      makeCard({ ref: 3, requirementsReview: true, stageSince: ago(4 * 24 * HOUR) }),
      makeCard({ ref: 4, requirementsReview: true, stageSince: ago(2 * 24 * HOUR) }),
      makeCard({ ref: 2, labels: [LABELS.blocked], stageSince: ago(4 * 24 * HOUR) }),
    ]), "dark");

    expect(html).toMatch(/data-ref="1"[\s\S]*?<span class="board-age" data-stale="true"[^>]*>4d</);
    expect(html).toMatch(/data-ref="2"[\s\S]*?<span class="board-age" data-stale="false"[^>]*>4d</);
    expect(html).toMatch(/data-ref="3"[\s\S]*?<span class="board-age" data-stale="true"[^>]*>4d</);
    expect(html).toMatch(/data-ref="4"[\s\S]*?<span class="board-age" data-stale="false"[^>]*>2d</);
  });

  it("marks a forge card's age as approximate last activity", () => {
    const html = buildBoardPage(makeView([makeCard({ ref: 1, updatedAt: ago(3 * HOUR) })]), "dark");

    expect(html).toContain(`title="Last activity 3h ago; Claws does not record when a forge issue entered this column">~3h</span>`);
  });

  it("renders no chip when the card has neither timestamp", () => {
    const html = buildBoardPage(makeView([makeCard({ ref: 1 })]), "dark");

    expect(html).not.toContain(`class="board-age"`);
  });
});

describe("buildBoardPage plan block", () => {
  it("renders a collapsed plan block with the Requirement and a link to the full plan", () => {
    const card = makeCard({ plan: { summary: "5 sections", requirementHtml: "<p>Need it.</p>", url: "/issues/clw_X#plan" } });

    const html = buildBoardPage(makeView([card]), "dark");

    expect(html.match(/<dialog class="preview-modal"/g)).toHaveLength(1);
    expect(html).toContain("clawsPreviewModal");
    expect(html).toContain(`<details class="preview-peek board-plan"><summary>Plan · 5 sections</summary><div class="markdown"><p>Need it.</p></div><a href="/issues/clw_X#plan">Full plan</a></details>`);
  });

  it("renders no plan block for a card without a plan", () => {
    expect(buildBoardPage(makeView([makeCard()]), "dark")).not.toContain(`<details class="preview-peek board-plan">`);
  });
});

describe("buildBoardPage idea block", () => {
  const PLAN = { summary: "5 sections", requirementHtml: "<p>PLAN REQ</p>", url: "/issues/clw_X#plan" };
  const RECORD_IDEA = { summary: "Requirements v2 · feature — Add a thing", html: "<p>The thing exists.</p>", url: "/issues/clw_X" };
  const cardHtml = (html: string, ref: string) => html.match(new RegExp(`<article[^>]*data-ref="${ref}"[^>]*>([\\s\\S]*?)</article>`))?.[1] ?? "";

  it("previews the requirements record on a Requirements review card, closed, keeping the chip", () => {
    const html = buildBoardPage(makeView([makeCard({ ref: 1, requirementsVersion: 2, requirementsReview: true, idea: RECORD_IDEA })]), "dark");

    const card = cardHtml(html, "1");
    expect(card).toContain(`<details class="preview-peek board-plan board-idea"><summary>Requirements v2 · feature — Add a thing</summary><div class="markdown"><p>The thing exists.</p></div><a href="/issues/clw_X">Open issue</a></details>`);
    expect(card).toContain("requirements v2");
  });

  it("previews a body excerpt on a Drafting card with no record, with no chip", () => {
    const idea = { summary: "Idea", html: "<p>Make it so…</p>", url: "/issues/clw_X" };
    const html = buildBoardPage(makeView([makeCard({ ref: 1, requirementsVersion: null, idea })]), "dark");

    const card = cardHtml(html, "1");
    expect(card).toContain(`<details class="preview-peek board-plan board-idea"><summary>Idea</summary><div class="markdown"><p>Make it so…</p></div>`);
    expect(card).not.toContain("board-chip-req");
  });

  it("shows the idea in place of the plan in both requirements columns, and only the plan elsewhere", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, idea: RECORD_IDEA, plan: PLAN }),
      makeCard({ ref: 4, requirementsReview: true, idea: RECORD_IDEA, plan: PLAN }),
      makeCard({ ref: 2, lifecycle: "planning", idea: RECORD_IDEA, plan: PLAN }),
      makeCard({ ref: 3, labels: [LABELS.ready], idea: RECORD_IDEA, plan: PLAN }),
    ]), "dark");

    for (const ref of ["1", "4"]) {
      expect(cardHtml(html, ref)).toContain("board-idea");
      expect(cardHtml(html, ref)).not.toContain("PLAN REQ");
    }
    for (const ref of ["2", "3"]) {
      expect(cardHtml(html, ref)).toContain("PLAN REQ");
      expect(cardHtml(html, ref)).not.toContain("board-idea");
    }
  });

  it("shows the operator step in place of the plan on an awaiting-operator card only", () => {
    const operatorStep = { summary: "Operator step 2 · Run the cutover", html: "<p>Flip the DNS record</p>", url: "/issues/1" };
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, awaitingOperator: true, operatorStep, plan: PLAN }),
      makeCard({ ref: 2, flight: { implementing: false, openPrs: [MERGE_READY_PR] }, plan: PLAN }),
      makeCard({ ref: 3, lifecycle: "planning", operatorStep, plan: PLAN }),
    ]), "dark");

    expect(cardHtml(html, "1")).toContain("Operator step 2 · Run the cutover");
    expect(cardHtml(html, "1")).toContain("Flip the DNS record");
    expect(cardHtml(html, "1")).not.toContain("PLAN REQ");
    expect(cardHtml(html, "2")).toContain("PLAN REQ");
    expect(cardHtml(html, "2")).not.toContain("board-operator");
    expect(cardHtml(html, "3")).toContain("PLAN REQ");
    expect(cardHtml(html, "3")).not.toContain("board-operator");
  });

  it("keeps the preview inside the card at phone width", () => {
    const html = buildBoardPage(makeView([makeCard()]), "dark");

    expect(html).toContain(".board-plan .markdown pre { white-space: pre-wrap; }");
    expect(html).toContain(".board-plan .markdown img, .board-plan .markdown table { max-width: 100%; }");
  });
});

describe("ideaExcerpt", () => {
  it("collapses whitespace and returns a short body whole", () => {
    expect(ideaExcerpt("  Make the\n\nthing   happen  ")).toBe("Make the thing happen");
  });

  it("cuts a long body at a word boundary and marks the cut", () => {
    expect(ideaExcerpt("alpha beta gamma delta", 13)).toBe("alpha beta…");
  });

  it("says so when there is no body", () => {
    expect(ideaExcerpt("  \n ")).toBe("(No description provided)");
  });
});
