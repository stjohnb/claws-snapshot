import { describe, it, expect, vi } from "vitest";
import { buildBoardPage, ideaExcerpt, renderBoardRefresh, renderBoardSurface, type BoardCard, type BoardCardPr, type BoardPageView } from "./board.js";
import { LABELS } from "../config.js";
import { BOARD_COLUMNS } from "../issue-board.js";
import { shortIssueRef } from "../issue-id.js";

const NATIVE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

const OPEN_PR: BoardCardPr = { repo: "org/repo", prNumber: 1, stage: "awaiting-review", needsHumanReview: false, mergeApprovedAt: null };
const MERGE_READY_PR: BoardCardPr = { repo: "org/repo", prNumber: 1, stage: "awaiting-merge", needsHumanReview: false, mergeApprovedAt: null };

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
  it("puts a New issue button in the toolbar and the New issue modal on the page", () => {
    const html = buildBoardPage(makeView([makeCard()]), "dark");
    expect(html).toMatch(/<div class="board-toolbar">[\s\S]*<a class="trigger-btn" href="\/issues\/new" data-new-issue-open>New issue<\/a>/);
    expect(html).toContain(`id="new-issue-modal"`);
    expect(html).toContain("clawsNewIssueModalInit");
    expect(html).toContain("clawsIssueAttachmentsInit");
    expect(html).not.toMatch(/name="repo" value="[^"]+" checked/);
  });

  it("carries a repo filter into the button's fallback link and pre-checks it in the modal", () => {
    const html = buildBoardPage(makeView([makeCard({ repo: "org/a" }), makeCard({ ref: 2, repo: "org/b" })], { repoFilter: "org/b" }), "dark");
    expect(html).toContain(`href="/issues/new?repo=org%2Fb" data-new-issue-open`);
    expect(html).toContain(`name="repo" value="org/b" checked`);
    expect(html).not.toContain(`name="repo" value="org/a" checked`);
  });

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
    expect(cardHtml(1)).toContain(`<details class="preview-peek board-plan board-blocked-peek" data-preview-title="Blocked reason">`);
    expect(cardHtml(1)).toContain(`<div class="markdown"><p>PR #28 merged without closing this issue`);
    expect(cardHtml(1)).toContain(`>Open issue</a>`);
    expect(cardHtml(2)).not.toContain("Needs a human");
    expect(cardHtml(2)).not.toContain("board-blocked-reason");
  });

  it("keeps a short Blocked reason as a plain line and shows no reason outside Blocked", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, labels: [LABELS.blocked], blockedReason: "Waiting on operator" }),
      makeCard({ ref: 2, lifecycle: "planning", blockedReason: "Waiting on operator" }),
    ]), "dark");
    const cardHtml = (ref: number): string => {
      const start = html.indexOf(`data-ref="${ref}"`);
      return html.slice(start, html.indexOf("</article>", start));
    };
    expect(cardHtml(1)).toContain(`<p class="board-blocked-reason"`);
    expect(cardHtml(1)).not.toContain("<details class=\"preview-peek");
    expect(cardHtml(2)).not.toContain("board-blocked-reason");
  });

  // The retired Claws Ignore label had its own "Parked" chip (#clw_01M55F0ACDZP8ND1BNRZ8TNGPD).
  it("renders no Parked chip", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, labels: [LABELS.planDeep], lifecycle: "planning" }),
      makeCard({ ref: 2, lifecycle: "planning" }),
    ]), "dark");

    expect(columnCards(html, "planning")).toEqual(["1", "2"]);
    expect(html).not.toContain("Parked ·");
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
    expect(html).toContain(`data-ref="3" data-column="in-progress" data-in-flight="task"`);
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

  it("puts the approve button, Start session and the move select in one board-actions row", () => {
    const rows = (card: BoardCard) =>
      buildBoardPage(makeView([card]), "dark").match(/<div class="board-actions">[\s\S]*?<\/select><\/div>/g) ?? [];
    const nativeRef = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PD1";
    for (const card of [
      makeCard({ ref: nativeRef, url: `/issues/${nativeRef}`, requirementsReview: true }),
      makeCard({ ref: nativeRef, url: `/issues/${nativeRef}`, labels: [LABELS.ready], hasPlan: true }),
    ]) {
      const html = buildBoardPage(makeView([card]), "dark");
      expect(html.match(/<div class="board-actions">/g)).toHaveLength(1);
      expect(rows(card)[0]).toMatch(/^<div class="board-actions"><button[^>]*board-approve[\s\S]*<\/button><button[^>]*board-start-session[\s\S]*<\/button>\s*<select class="board-move"/);
    }
    const nativePlain = rows(makeCard({ ref: nativeRef, url: `/issues/${nativeRef}` }))[0];
    expect(nativePlain).toMatch(/^<div class="board-actions"><button[^>]*board-start-session[\s\S]*<\/button>\s*<select class="board-move"/);
    expect(nativePlain).not.toContain("board-approve");
    const plain = rows(makeCard())[0];
    expect(plain).toMatch(/^<div class="board-actions"><select class="board-move"/);
    expect(plain).not.toContain("board-approve");
    const closed = buildBoardPage(makeView([makeCard({ repo: "", ref: nativeRef, closed: true })]), "dark");
    expect(closed).toMatch(/<div class="board-actions"><button[^>]*board-start-session[^>]*>[\s\S]*?<\/button><\/div>/);
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

  it("renders all nine columns, in order", () => {
    const html = buildBoardPage(makeView([]), "dark");
    const order = ["drafting", "requirements-review", "planning", "awaiting-plan-review", "approved", "in-progress", "blocked", "awaiting-merge", "done"];
    const positions = order.map((column) => html.indexOf(`<div class="board-col-body" data-column="${column}">`));
    expect(positions).not.toContain(-1);
    expect(html.match(/<details class="board-col[ "]/g)).toHaveLength(9);
    expect(html).not.toContain(`data-column="ideas"`);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).not.toContain(`data-column="implementing"`);
    expect(html).not.toContain(`data-column="pr-progressing"`);
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
    expect(building).toContain(`data-column="in-progress"`);
    expect(building).toContain(`data-column="in-progress"`);
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
    for (const column of ["drafting", "in-progress", "awaiting-merge"]) {
      expect(html).toContain(`<details class="board-col board-col-derived" data-column="${column}"`);
    }
    expect(html).toContain(`<details class="board-col" data-column="blocked"`);
    expect(html).toContain(`.board-col-gate .board-col-title::before { content: "◆"; color: var(--accent);`);
    expect(html).toMatch(/title="[^"]*— set by Claws, not a drop target"><h3 class="board-col-title">In progress</);
    expect(html).toMatch(/title="[^"]*— drop a card here"><h3 class="board-col-title">Requirements review</);
    expect(html).toMatch(/title="Filed, or feedback left on the record — Claws writes or revises the requirements — drop a card here to send an issue back to requirements"><h3 class="board-col-title">Drafting</);
    expect(html).not.toContain(">Ideas<");
  });

  it("marks only the columns waiting on the operator with data-waits", () => {
    const html = buildBoardPage(makeView([]), "dark");
    const waiting = [...html.matchAll(/<details class="board-col[^"]*" data-column="([a-z-]+)" data-waits="true"/g)].map((m) => m[1]);
    expect(waiting).toEqual(["requirements-review", "awaiting-plan-review", "blocked", "awaiting-merge"]);
  });

  describe("repo filter expands every column", () => {
    const openIds = (html: string) =>
      [...html.matchAll(/<details class="board-col[^"]*" data-column="([a-z-]+)"[^>]*? open/g)].map((m) => m[1]);
    const waitIds = BOARD_COLUMNS.filter((c) => c.waits).map((c) => c.id);

    it("opens only the waiting columns, and not the tray, without a filter", () => {
      const html = buildBoardPage(makeView([]), "dark");
      expect(openIds(html)).toEqual(waitIds);
      expect(html).not.toMatch(/<details class="board-tray" open/);
    });

    it("opens every column and the tray under a repo filter", () => {
      const html = buildBoardPage({ ...makeView([]), repoFilter: "St-John-Software/claws" }, "dark");
      expect(openIds(html)).toEqual(BOARD_COLUMNS.map((c) => c.id));
      expect(html).toMatch(/<details class="board-tray" open/);
    });

    it("keeps data-waits on the waiting columns only and drops the group-derived count", () => {
      const html = buildBoardPage({ ...makeView([]), repoFilter: "St-John-Software/claws" }, "dark");
      const waiting = [...html.matchAll(/data-column="([a-z-]+)" data-waits="true"/g)].map((m) => m[1]);
      expect(waiting).toEqual(waitIds);
      expect(html).not.toContain('<span class="board-group-derived"');
    });
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
      makeCard({ ref: 9, flight: { implementing: false, openPrs: [OPEN_PR, { ...OPEN_PR, stage: "problematic" }] } }),
    ]), "dark");

    expect(columnCards(html, "drafting")).toEqual(["1"]);
    expect(columnCards(html, "awaiting-plan-review")).toEqual(["2"]);
    expect(columnCards(html, "approved")).toEqual(["3"]);
    expect(columnCards(html, "in-progress")).toEqual(["4", "5", "9"]);
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
  it("puts chips from the rows on a In progress card, and on a Blocked one parked for its PR", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, flight: { implementing: false, openPrs: [
        { repo: "org/repo", prNumber: 1, stage: "problematic", needsHumanReview: true, mergeApprovedAt: null },
        { repo: "org/repo", prNumber: 1, stage: "ci-failing", needsHumanReview: true, mergeApprovedAt: null },
      ] } }),
      makeCard({ ref: 2, flight: { implementing: false, openPrs: [OPEN_PR] } }),
      // Not in a PR column: Approved outranks the row, so no chips.
      makeCard({ ref: 3, labels: [LABELS.refined], flight: { implementing: false, openPrs: [{ repo: "org/repo", prNumber: 1, stage: "ci-failing", needsHumanReview: true, mergeApprovedAt: null }] } }),
      makeCard({ ref: 4, flight: { implementing: false, openPrs: [{ repo: "org/repo", prNumber: 1, stage: "ci-failing", needsHumanReview: true, mergeApprovedAt: null }] } }),
      makeCard({ ref: 5, labels: [LABELS.blocked], flight: { implementing: false, openPrs: [{ repo: "org/repo", prNumber: 1, stage: "problematic", needsHumanReview: false, mergeApprovedAt: null }] } }),
    ]), "dark");
    expect(columnCards(html, "in-progress")).toEqual(["1", "2", "4"]);
    expect(columnCards(html, "blocked")).toEqual(["5"]);
    const cards = html.match(/<article class="board-card"[\s\S]*?<\/article>/g)!;
    const chips = cards.find((c) => c.includes(`data-ref="1"`))!;
    const plain = cards.find((c) => c.includes(`data-ref="2"`))!;
    const approved = cards.find((c) => c.includes(`data-ref="3"`))!;

    expect(chips).not.toContain(">Manual Action<");
    for (const label of [LABELS.problematic, LABELS.needsLgtm]) {
      expect(chips.match(new RegExp(`label-chip[^>]*>${label}<`, "g")), label).toHaveLength(1);
    }
    expect(chips).toContain(`<span class="board-chip-ci">CI failing</span>`);
    const parked = cards.find((c) => c.includes(`data-ref="5"`))!;
    expect(parked).toMatch(new RegExp(`label-chip[^>]*>${LABELS.problematic}<`));
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
      expect(chipsOf([{ repo: "org/repo", prNumber: 1, stage: "ci-failing", needsHumanReview: false, mergeApprovedAt: null, liveCheckStatus: "passing" }])).not.toContain("CI failing");
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

    expect(html).toContain(`<details class="board-repo"><summary title="org/repo" aria-label="Repository org/repo"><span class="repo-avatar" aria-hidden="true">r</span><span class="board-repo-name">repo</span></summary></details>`);
    expect(html).toContain(`data-repo="org/repo"`);
    expect(html).not.toContain(`>org/repo<`);
  });

  // #clw_01M52GPG0E9DP8RQKW6ABH0X7R
  it("shows a forge card awaiting import in Drafting with its chip and no plan gate", () => {
    const html = buildBoardPage(makeView([makeCard({ labels: [LABELS.ready], awaitingImport: true, importHold: "open PR #9 still references it" })]), "dark");
    const card = html.match(/<article class="board-card"[\s\S]*?<\/article>/)![0];

    expect(columnCards(html, "drafting")).toEqual(["42"]);
    expect(columnCards(html, "awaiting-plan-review")).toEqual([]);
    expect(card).toContain(`data-awaiting-import="true"`);
    expect(card).toContain(`<span class="board-chip-operator" title="open PR #9 still references it">Waiting for import</span>`);
    expect(card).not.toContain("board-approve");
    expect(card).not.toContain("data-has-plan");
  });

  it("explains the wait on an awaiting-import chip with no hold reason", () => {
    const html = buildBoardPage(makeView([makeCard({ awaitingImport: true })]), "dark");

    expect(html).toContain("the next issue-dispatcher tick imports this one\">Waiting for import</span>");
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

  // The rows' merge approvals are what the toggle turns on, so a card whose
  // every open row carries one shows the toggle on whether or not the issue
  // has the label — but one single-PR approval (`claws_approve_pr_merge`)
  // beside an unapproved PR does not (#clw_01M5022YK7Z2V63775Y92B59P3).
  it("shows the Automerge toggle on only when every open row has a merge approval or the label is set", () => {
    const approved = { ...MERGE_READY_PR, mergeApprovedAt: "2026-09-24T10:00:00Z" };
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, flight: { implementing: false, openPrs: [approved, { ...OPEN_PR, mergeApprovedAt: "2026-09-24T10:00:00Z" }] } }),
      makeCard({ ref: 2, flight: { implementing: false, openPrs: [OPEN_PR] } }),
      makeCard({ ref: 3, flight: { implementing: false, openPrs: [OPEN_PR, approved] } }),
      makeCard({ ref: 4, labels: [LABELS.automerge], flight: { implementing: false, openPrs: [OPEN_PR, approved] } }),
    ]), "dark");
    const cards = html.match(/<article class="board-card"[\s\S]*?<\/article>/g)!;

    expect(cards.find((c) => c.includes(`data-ref="1"`))).toContain(`data-on="true"`);
    expect(cards.find((c) => c.includes(`data-ref="2"`))).toContain(`data-on="false"`);
    expect(cards.find((c) => c.includes(`data-ref="3"`))).toContain(`data-on="false"`);
    expect(cards.find((c) => c.includes(`data-ref="4"`))).toContain(`data-on="true"`);
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

  it("shows a Go to session link instead of Start session when the card has a live board-started session", () => {
    const ref = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDA";
    const html = buildBoardPage(makeView([
      makeCard({ ref, url: `/issues/${ref}`, activeSession: "abc123" }),
      makeCard({ ref: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDB", url: "/issues/x", activeSession: "def456", closed: true }),
      makeCard({ ref: 42, activeSession: "zzz" }),
    ]), "dark");
    const label = `Go to session for #${shortIssueRef(ref)}`;
    expect(html).toContain(`<a class="trigger-btn board-icon-btn board-go-to-session" href="/sessions/abc123" draggable="false" aria-label="${label}" title="${label}">`);
    expect(html).toContain(`href="/sessions/def456"`);
    expect(html).not.toContain("/sessions/zzz");
    expect(html.match(/<a class="trigger-btn board-icon-btn board-go-to-session"/g)).toHaveLength(2);
    expect(html).not.toContain("board-icon-btn board-start-session");
  });

  it("puts a Start session button on a native card in every column, and none on a forge card", () => {
    // One native card per column; the ULID's last character tells them apart.
    const ref = (i: number) => `clw_01JBQ7X4M2K8NV3TYRW9GZ5PD${i}`;
    const native = (i: number, overrides: Partial<BoardCard>) => makeCard({ ref: ref(i), url: `/issues/${ref(i)}`, ...overrides });
    const html = buildBoardPage(makeView([
      native(1, {}),
      native(2, { requirementsVersion: 1, requirementsReview: true }),
      native(3, { lifecycle: "planning" }),
      native(4, { labels: [LABELS.ready], hasPlan: true }),
      native(5, { labels: [LABELS.refined] }),
      native(6, { labels: [LABELS.refined], flight: { implementing: true, openPrs: [] } }),
      native(7, { labels: [LABELS.blocked], flight: { implementing: false, openPrs: [OPEN_PR] } }),
      native(8, { flight: { implementing: false, openPrs: [MERGE_READY_PR] } }),
      native(9, { closed: true }),
      makeCard({ ref: 42 }),
    ]), "dark");

    const columns = ["drafting", "requirements-review", "planning", "awaiting-plan-review", "approved", "in-progress", "blocked", "awaiting-merge", "done"];
    columns.forEach((column, i) => expect(columnCards(html, column)).toContain(ref(i + 1)));
    const buttons = html.match(/<button type="button" class="trigger-btn board-icon-btn board-start-session"[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(9);
    for (const button of buttons) {
      expect(button).toContain(`draggable="false"`);
      expect(button).toContain("title=");
      expect(button).not.toMatch(/>\s*Start session\s*</);
    }
    expect(html).not.toContain("Start session</button>");
    expect(html).toContain(`aria-label="Start session for #${shortIssueRef(ref(1))}"`);
    expect(buildBoardPage(makeView([makeCard({ ref: 42 })]), "dark")).not.toContain(`class="trigger-btn board-start-session"`);
  });

  it("puts an unassigned native issue in Drafting and says so", () => {
    const html = buildBoardPage(makeView([
      makeCard({ repo: "", ref: NATIVE, url: `/issues/${NATIVE}`, labels: [LABELS.refined] }),
    ]), "dark");

    expect(columnCards(html, "drafting")).toEqual([NATIVE]);
    expect(html).toContain("unassigned");
  });

  const selectOf = (card: BoardCard): string =>
    buildBoardPage(makeView([card]), "dark").match(/<select class="board-move"[\s\S]*?<\/select>/)?.[0] ?? "";

  it("offers only Closed and Backlog in the per-card move select", () => {
    const select = selectOf(makeCard({ labels: [LABELS.ready], hasPlan: true }));

    expect(select).toContain(`<option value="done">Closed</option>`);
    expect(select).toContain(`<option value="backlog">Backlog</option>`);
    for (const column of ["drafting", "requirements-review", "planning", "awaiting-plan-review", "approved", "blocked", "in-progress", "awaiting-merge"]) {
      expect(select).not.toContain(`value="${column}"`);
    }
  });

  it("offers an unassigned card or one in flight Closed but not Backlog", () => {
    for (const card of [
      makeCard({ repo: "", ref: NATIVE, url: `/issues/${NATIVE}` }),
      makeCard({ flight: { implementing: true, openPrs: [] } }),
      makeCard({ hasPlan: true, flight: { implementing: false, openPrs: [OPEN_PR] } }),
    ]) {
      const select = selectOf(card);
      expect(select).toContain(`<option value="done">`);
      expect(select).not.toContain(`value="backlog"`);
    }
  });

  it("omits the select for a Closed card with no Backlog option, hides Closed otherwise", () => {
    const closed = makeCard({ repo: "", ref: NATIVE, url: `/issues/${NATIVE}`, closed: true });
    expect(selectOf(closed)).toBe("");
    expect(selectOf(makeCard({ closed: true }))).toContain(`<option value="done" hidden>`);
  });

  it("renders an approve button only in Requirements review and Awaiting plan review", () => {
    const render = (card: BoardCard) => buildBoardPage(makeView([card]), "dark");
    const buttons = (html: string) => [...html.matchAll(/<button[^>]*class="trigger-btn board-icon-btn board-approve"[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);

    const requirements = buttons(render(makeCard({ ref: 7, requirementsVersion: 3, requirementsReview: true })));
    expect(requirements).toHaveLength(1);
    expect(requirements[0]).toContain('data-approve-to="planning"');
    expect(requirements[0]).toContain('aria-label="Approve requirements for #7"');
    expect(requirements[0]).toContain('title="Approve requirements for #7"');
    expect(requirements[0]).toContain('<svg class="board-icon-tick"');
    expect(requirements[0].replace(/<[^>]*>/g, "")).toBe("");
    expect(render(makeCard({ ref: 7, requirementsVersion: 3, requirementsReview: true }))).not.toContain("Approve requirements</button>");
    expect(buttons(render(makeCard({ requirementsVersion: 2, requirementsReview: false })))).toEqual([]);

    const plan = buttons(render(makeCard({ ref: 7, labels: [LABELS.ready], hasPlan: true })));
    expect(plan).toHaveLength(1);
    expect(plan[0]).toContain('data-approve-to="approved"');
    expect(plan[0]).toContain('aria-label="Approve plan for #7"');
    expect(plan[0]).toContain('title="Approve plan for #7"');
    expect(render(makeCard({ ref: 7, labels: [LABELS.ready], hasPlan: true }))).not.toContain("Approve plan</button>");

    expect(buttons(render(makeCard({ labels: [LABELS.ready] })))).toEqual([]);
    expect(buttons(render(makeCard()))).toEqual([]);
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
    for (const col of ["drafting", "requirements-review", "planning", "awaiting-plan-review", "approved", "in-progress", "blocked", "awaiting-merge", "done"]) {
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
    expect(buildBoardPage(makeView([makeCard()], { backlogCount: 4, backlogNextReturn: "2026-10-23" }), "dark"))
      .toContain(`data-count="backlog">4</span> <span class="board-tray-next">· next returns 2026-10-23</span></summary>`);
    expect(html).toContain(`id="issue-board-surface"`);
  });

  it("renders no selection checkbox and no bulk send button", () => {
    const html = buildBoardPage(makeView([makeCard({ ref: 1 })]), "dark");

    expect(html).not.toContain("board-select");
    expect(html).not.toContain("board-bulk-backlog");
  });

  it("puts the automerge toggle first in the head row and the repo avatars grouped after the ref, not in the chips row", () => {
    const html = buildBoardPage(makeView([makeCard({ repo: "org/a", repos: ["org/a", "org/b", "org/c"] })]), "dark");
    const head = html.slice(html.indexOf('<div class="board-card-head">'), html.indexOf('<div class="board-chips">'));
    expect((head.match(/<details class="board-repo/g) ?? []).length).toBe(3);
    expect(head.indexOf('class="board-automerge"')).toBeLessThan(head.indexOf('class="board-ref"'));
    expect(head.indexOf('class="board-ref"')).toBeLessThan(head.indexOf("<details"));
    expect(head.indexOf('class="board-repos"')).toBeLessThan(head.indexOf("<details"));
    expect(head.lastIndexOf("</details>")).toBeLessThan(head.lastIndexOf("</span>"));
    const chips = html.slice(html.indexOf('<div class="board-chips">'), html.indexOf("</div>", html.indexOf('<div class="board-chips">')));
    expect(chips).not.toContain("board-repo");
  });

  it("keeps the toggle apart from several fallback-initial avatars", () => {
    const html = buildBoardPage(makeView([makeCard({ repo: "org/a", repos: ["org/a", "org/b", "org/c"] })]), "dark");
    const head = html.slice(html.indexOf('<div class="board-card-head">'), html.indexOf('<div class="board-chips">'));
    expect(head.match(/class="repo-avatar"[^>]*>[abc]</g)?.length).toBe(3);
    expect(head.indexOf('class="board-automerge"')).toBeLessThan(head.indexOf('class="board-ref"'));
    expect(head.indexOf('class="board-ref"')).toBeLessThan(head.indexOf('class="board-repos"'));
  });

  it("keeps the unassigned warning chip for a card with no repo", () => {
    const html = buildBoardPage(makeView([makeCard({ repo: "" })]), "dark");
    expect(html).toContain(">unassigned</span>");
    expect(html).not.toContain('<details class="board-repo');
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
    expect(html).toContain(`<details class="board-repo"><summary title="Primary repository: owns planning and labels (org/a)" aria-label="Repository org/a">`);
    expect(html).toContain(`<details class="board-repo board-repo-also"><summary title="Also names org/b" aria-label="Repository org/b">`);
    expect((html.match(/<details class="board-repo/g) ?? []).length).toBe(2);
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

    // The New issue modal's form has label checkboxes; the filter form has none.
    const filters = byRepo.match(/<form class="board-filters"[\s\S]*?<\/form>/)![0];
    expect(filters).not.toContain(`name="label"`);
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
    expect(html).toContain('<h2>Board <span id="board-total">0</span></h2>');
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
    // A long column scrolls inside itself from a tablet up, never on a phone.
    expect(tablet).toMatch(/\.board-group-cols > \.board-col > \.board-col-body \{[^}]*calc\(100dvh - 6rem\); overflow-y: auto;/);
    expect(desktop).toContain(`var(--board-body-top`);
    expect(styleBlock.replace(tablet, "").replace(desktop, "")).not.toMatch(/\.board-col-body[^}]*overflow-y: auto/);
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
    expect(open).toEqual(["requirements-review", "awaiting-plan-review", "blocked", "awaiting-merge"]);
    for (const column of ["drafting", "planning", "approved", "in-progress", "done"]) {
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

    expect(html).toContain('<h2>Board <span id="board-total">3</span></h2>');
    expect(html).toContain(`data-count="awaiting-plan-review">2<`);
    expect(html).toContain(`data-count="approved">0<`);
  });

  // Title, count and filter share one toolbar row: the page
  // header prints no second "Board".
  it("renders one toolbar holding the title and the repo filter", () => {
    const html = buildBoardPage(makeView([makeCard()]), "dark");
    const beforeColumns = html.slice(0, html.indexOf(`id="issue-board"`));

    expect(beforeColumns.match(/<h2[ >]/g)).toHaveLength(1);
    expect(html).toMatch(/<div class="board-toolbar">\s*<h2>Board <span id="board-total">1<\/span><\/h2>\s*<form class="board-filters"[\s\S]*?<\/form>\s*<\/div>/);
  });
});

describe("buildBoardPage age chip", () => {
  const HOUR = 60 * 60 * 1000;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("shows how long a native card has been in its column, in the card head", () => {
    const since = ago(2 * HOUR + 5 * 60 * 1000);
    const html = buildBoardPage(makeView([makeCard({ ref: 1, labels: [LABELS.ready], stageSince: since, updatedAt: ago(60_000) })]), "dark");

    expect(html).toMatch(/<div class="board-card-head">\s*(?:<button[^>]*class="board-automerge"[^>]*>M<\/button>)?<a class="board-ref"[^>]*>#1<\/a><span class="board-age" data-stale="false" title="In Awaiting plan review for 2h \(since [^"]+\)">2h<\/span>/);
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
    expect(cardHtml(html, "2")).not.toContain("PLAN REQ");
    expect(cardHtml(html, "2")).toContain("board-prs");
    expect(cardHtml(html, "2")).not.toContain("board-operator");
    expect(cardHtml(html, "3")).toContain("PLAN REQ");
    expect(cardHtml(html, "3")).not.toContain("board-operator");
  });

  describe("Awaiting merge PR links", () => {
    const pr = (over: Partial<BoardCardPr> = {}): BoardCardPr => ({ ...MERGE_READY_PR, ...over });
    const cardWith = (openPrs: BoardCardPr[], over: Partial<BoardCard> = {}) =>
      cardHtml(buildBoardPage(makeView([makeCard({ ref: 1, plan: PLAN, flight: { implementing: false, openPrs }, ...over })]), "dark"), "1");

    it("links one PR in place of the plan", () => {
      const html = cardWith([pr({ prNumber: 7 })]);
      expect(html).toContain(`<a href="https://github.com/org/repo/pull/7">repo#7</a>`);
      expect(html).not.toContain("PLAN REQ");
      expect(html).not.toContain("Needs you");
    });

    it("lists PRs across repos in repo order with titles", () => {
      const html = cardWith([
        pr({ repo: "org/repo", prNumber: 9, title: "Second" }),
        pr({ repo: "St-John-Software/nixos-config", prNumber: 30, title: "First" }),
      ]);
      expect(html).toContain("nixos-config#30</a> <span class=\"board-pr-title\">First</span>");
      expect(html).toMatch(/repo#9[\s\S]*nixos-config#30/);
      expect(html).toContain("St-John-Software/nixos-config/pull");
    });

    it("shows the hold on one held PR and the Needs you chip", () => {
      const html = cardWith([pr({ manualActionReason: "Bump flake.lock" })]);
      expect(html).toContain(`title="Bump flake.lock">Waiting on operator: Bump flake.lock`);
      expect(html).toContain("Needs you");
    });

    it("shows Needs you when every PR is held, with a long hold as a peek", () => {
      const html = cardWith([
        pr({ prNumber: 1, manualActionReason: "Short" }),
        pr({ prNumber: 2, manualActionReason: "x".repeat(80) }),
      ]);
      expect(html).toContain("Needs you");
      expect(html).toContain(`data-preview-title="Operator step"`);
    });

    it("shows no chip when only some PRs are held", () => {
      const html = cardWith([pr({ prNumber: 1, manualActionReason: "Short" }), pr({ prNumber: 2 })]);
      expect(html).not.toContain("Needs you");
      expect(html.match(/Waiting on operator/g)).toHaveLength(1);
    });

    it("shows the operator block alone, or above the PR list", () => {
      const operatorStep = { summary: "Operator step 1", html: "<p>Do it</p>", url: "/issues/1" };
      const alone = cardWith([], { awaitingOperator: true, operatorStep });
      expect(alone).toContain("board-operator");
      expect(alone).not.toContain("board-prs");
      const both = cardWith([pr()], { awaitingOperator: true, operatorStep });
      expect(both.indexOf("board-operator")).toBeLessThan(both.indexOf("board-prs"));
    });

    it("leaves other columns on the plan", () => {
      const html = cardWith([pr({ stage: "awaiting-review", manualActionReason: "Hold" })]);
      expect(html).toContain("PLAN REQ");
      expect(html).not.toContain("board-prs\"");
      expect(html).not.toContain("Needs you");
    });
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

// The Board page's poller swaps these in (#clw_01M59YYPDF6SQS5RR4JSFDZGJQ).
describe("renderBoardSurface", () => {
  it("holds every column and the Backlog tray, and is what the page renders inside the surface", () => {
    const view = makeView([makeCard(), makeCard({ ref: 43, repo: "org/other" })], { backlogCount: 4 });
    const { surface, total, warning } = renderBoardSurface(view);

    expect(surface.match(/<details class="board-col[ "]/g)).toHaveLength(BOARD_COLUMNS.length);
    expect(surface).toContain(`<details class="board-tray"`);
    expect(surface).toContain(`data-count="backlog">4</span>`);
    expect(surface).not.toContain(`id="issue-board-surface"`);
    expect(total).toBe(2);
    expect(warning).toBe("");
    expect(buildBoardPage(view, "dark")).toContain(surface);
  });

  it("stamps the page's surface with the digest the poller compares against", () => {
    const view = makeView([makeCard()]);
    const { hash } = renderBoardSurface(view);

    expect(hash).toMatch(/^[\w-]{22}$/);
    expect(renderBoardSurface(makeView([makeCard()])).hash).toBe(hash);
    expect(renderBoardSurface(makeView([makeCard(), makeCard({ ref: 43 })])).hash).not.toBe(hash);
    expect(buildBoardPage(view, "dark")).toContain(`<div id="issue-board-surface" data-surface-hash="${hash}">`);
  });

  it("keeps the digest stable as the clock moves the age chips", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const first = renderBoardSurface(makeView([makeCard({ stageSince: "2025-12-31T23:59:30.000Z" })]));
      vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
      const second = renderBoardSurface(makeView([makeCard({ stageSince: "2025-12-31T23:59:30.000Z" })]));
      expect(second.surface).not.toBe(first.surface);
      expect(second.hash).toBe(first.hash);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts only the cards under the repo filter and words the incomplete-sources warning", () => {
    const view = makeView([makeCard(), makeCard({ ref: 43, repo: "org/other" })], { repoFilter: "org/other", incompleteSources: 1 });
    const { total, warning } = renderBoardSurface(view);

    expect(total).toBe(1);
    expect(warning).toBe("1 of the board's sources loaded incompletely — some cards are missing.");
  });
});

describe("renderBoardRefresh", () => {
  it("carries every pinned nav link's count and accessible name", () => {
    const refresh = renderBoardRefresh(makeView([makeCard()]), { issues: { attention: 2, total: 5 }, prs: { attention: 0, total: 0 }, sessions: 1 });

    expect(refresh.surface).toBe(renderBoardSurface(makeView([makeCard()])).surface);
    expect(refresh.nav).toEqual([
      { href: "/board", text: "2/5", name: "Board, 2 of 5 issues need attention" },
      { href: "/prs", text: "", name: "PRs" },
      { href: "/sessions", text: "1", name: "Sessions, 1 active" },
    ]);
  });

  it("reports zero counts when there are none", () => {
    expect(renderBoardRefresh(makeView([])).nav.map((n) => n.text)).toEqual(["", "", ""]);
  });
});

describe("buildBoardPage's poller targets", () => {
  it("renders the toolbar count and a hidden warning line for the poller to fill", () => {
    const html = buildBoardPage(makeView([makeCard()]), "dark");

    expect(html).toContain(`<span id="board-total">1</span>`);
    expect(html).toContain(`<div class="board-status board-warning" id="board-warning" role="status" hidden></div>`);
    expect(buildBoardPage(makeView([], { incompleteSources: 1 }), "dark")).toMatch(/id="board-warning" role="status">1 of the board/);
  });
});
