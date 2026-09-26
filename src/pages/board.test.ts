import { describe, it, expect } from "vitest";
import { buildBoardPage, type BoardCard, type BoardCardPr, type BoardPageView } from "./board.js";
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
    expect(html).not.toContain(`data-ref="1" data-column="ideas" data-closed`);
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

  it("renders all nine columns, in order", () => {
    const html = buildBoardPage(makeView([]), "dark");
    const order = ["ideas", "planning", "awaiting-plan-review", "approved", "implementing", "pr-open", "blocked", "awaiting-merge", "done"];
    const positions = order.map((column) => html.indexOf(`<div class="board-col-body" data-column="${column}">`));
    expect(positions).not.toContain(-1);
    expect(html.match(/<details class="board-col[ "]/g)).toHaveLength(9);
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
    expect(heads).toEqual(["Shaping", "Building", "Landing"]);
    const building = html.match(/<section class="board-group" data-group="building"[\s\S]*?<\/section>/)![0];
    expect(building).toContain(`data-column="approved"`);
    expect(building).toContain(`data-column="implementing"`);
    expect(building).toContain(`data-column="pr-open"`);
    expect(building).toContain(`<span class="board-group-count" data-group-count="building">3</span>`);
    // The phone-only count of cards the collapsed derived columns hold.
    expect(building).toContain(`<span class="board-group-derived">· <span data-group-derived="building">2</span> set by Claws</span>`);
    // Shaping has no derived column, so no derived count.
    const shaping = html.match(/<section class="board-group" data-group="shaping"[\s\S]*?<\/section>/)![0];
    expect(shaping).not.toContain("board-group-derived");
    // Blocked is in no group, and sits between Building and Landing.
    expect(html).not.toMatch(/<section class="board-group"[^>]*>(?:(?!<\/section>)[\s\S])*data-column="blocked"/);
    expect(html.indexOf(`data-group="building"`)).toBeLessThan(html.indexOf(`<details class="board-col" data-column="blocked"`));
    expect(html.indexOf(`<details class="board-col" data-column="blocked"`)).toBeLessThan(html.indexOf(`data-group="landing"`));
  });

  it("marks the human gates and the derived columns apart", () => {
    const html = buildBoardPage(makeView([]), "dark");
    for (const column of ["ideas", "planning", "awaiting-plan-review", "approved", "done"]) {
      expect(html).toContain(`<details class="board-col board-col-gate" data-column="${column}"`);
    }
    for (const column of ["implementing", "pr-open", "awaiting-merge"]) {
      expect(html).toContain(`<details class="board-col board-col-derived" data-column="${column}"`);
    }
    expect(html).toContain(`<details class="board-col" data-column="blocked"`);
    expect(html).toContain(`.board-col-gate .board-col-title::before { content: "◆"; color: var(--accent);`);
    expect(html).toMatch(/title="[^"]*— set by Claws, not a drop target"><h3 class="board-col-title">PR open</);
    expect(html).toMatch(/title="[^"]*— drop a card here"><h3 class="board-col-title">Ideas</);
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
    ]), "dark");

    expect(columnCards(html, "ideas")).toEqual(["1"]);
    expect(columnCards(html, "awaiting-plan-review")).toEqual(["2"]);
    expect(columnCards(html, "approved")).toEqual(["3"]);
    expect(columnCards(html, "implementing")).toEqual(["4"]);
    expect(columnCards(html, "pr-open")).toEqual(["5"]);
    expect(columnCards(html, "blocked")).toEqual(["6"]);
    expect(columnCards(html, "awaiting-merge")).toEqual(["7"]);
    expect(columnCards(html, "done")).toEqual(["8"]);
  });

  // Ideas and Planning carry no label: the stored lifecycle tells them apart.
  it("puts an unlabelled card in Planning when its lifecycle says so, and in Ideas otherwise", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, lifecycle: "ideas" }),
      makeCard({ ref: 2, lifecycle: "planning" }),
      makeCard({ ref: 3 }),
    ]), "dark");
    expect(columnCards(html, "ideas")).toEqual(["1", "3"]);
    expect(columnCards(html, "planning")).toEqual(["2"]);
  });

  it("chips a card in Ideas with its requirements version, or says it has none", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, requirementsVersion: null }),
      makeCard({ ref: 2, requirementsVersion: 3 }),
      makeCard({ ref: 4, lifecycle: "planning", requirementsVersion: 1 }),
    ]), "dark");
    expect(html).toContain(`<span class="board-chip-req">no requirements yet</span>`);
    expect(html).toContain(`<span class="board-chip-req">requirements v3</span>`);
    // Only Ideas carries it: past promotion the record is not what waits on a human.
    expect(html).not.toContain("requirements v1");
  });

  // The PRs that need a person must not hide among the ones mid-review.
  it("puts chips from the rows on a PR open card", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, flight: { implementing: false, openPrs: [
        { stage: "manual-action", needsHumanReview: false, mergeApprovedAt: null },
        { stage: "problematic", needsHumanReview: true, mergeApprovedAt: null },
        { stage: "ci-failing", needsHumanReview: true, mergeApprovedAt: null },
      ] } }),
      makeCard({ ref: 2, flight: { implementing: false, openPrs: [OPEN_PR] } }),
      // Not in PR open: Approved outranks the row, so no chips.
      makeCard({ ref: 3, labels: [LABELS.refined], flight: { implementing: false, openPrs: [{ stage: "ci-failing", needsHumanReview: true, mergeApprovedAt: null }] } }),
    ]), "dark");
    const cards = html.match(/<article class="board-card"[\s\S]*?<\/article>/g)!;
    const chips = cards.find((c) => c.includes(`data-ref="1"`))!;
    const plain = cards.find((c) => c.includes(`data-ref="2"`))!;
    const approved = cards.find((c) => c.includes(`data-ref="3"`))!;

    for (const label of [LABELS.manualAction, LABELS.problematic, LABELS.needsLgtm]) {
      expect(chips.match(new RegExp(`label-chip[^>]*>${label}<`, "g")), label).toHaveLength(1);
    }
    expect(chips).toContain(`<span class="board-chip-ci">CI failing</span>`);
    for (const card of [plain, approved]) {
      expect(card).not.toContain("board-chip-ci");
      expect(card).not.toContain(`>${LABELS.needsLgtm}<`);
    }
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

  it("puts an unassigned native issue in Ideas and says so", () => {
    const html = buildBoardPage(makeView([
      makeCard({ repo: "", ref: NATIVE, url: `/issues/${NATIVE}`, labels: [LABELS.refined] }),
    ]), "dark");

    expect(columnCards(html, "ideas")).toEqual([NATIVE]);
    expect(html).toContain("unassigned");
  });

  it("offers no derived column in the per-card move select, hiding the current one", () => {
    const html = buildBoardPage(makeView([makeCard({ labels: [LABELS.ready] })]), "dark");
    const select = html.match(/<select class="board-move"[\s\S]*?<\/select>/)![0];

    expect(select).toContain(`<option value="ideas">`);
    expect(select).toContain(`<option value="awaiting-plan-review" hidden>`);
    for (const column of ["approved", "blocked", "done"]) expect(select).toContain(`<option value="${column}">`);
    for (const column of ["implementing", "pr-open", "awaiting-merge"]) expect(select).not.toContain(`value="${column}"`);
  });

  // Every other column is a guaranteed 409 for a card no repository owns, and
  // the select is the whole touch path.
  it("offers an unassigned card only the columns it can reach", () => {
    const html = buildBoardPage(makeView([
      makeCard({ repo: "", ref: NATIVE, url: `/issues/${NATIVE}` }),
    ]), "dark");
    const select = html.match(/<select class="board-move"[\s\S]*?<\/select>/)![0];

    expect(select).toContain(`<option value="ideas" hidden>`);
    expect(select).toContain(`<option value="done">`);
    for (const column of ["awaiting-plan-review", "approved", "blocked", "pr-open"]) {
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
    const pr = selectOf(makeCard({ flight: { implementing: false, openPrs: [OPEN_PR] } }));

    for (const column of ["blocked", "done"]) {
      expect(task).toContain(`<option value="${column}">`);
      expect(pr).toContain(`<option value="${column}">`);
    }
    expect(task).not.toContain(`value="approved"`);
    expect(pr).toContain(`<option value="approved">`);
    for (const column of ["ideas", "awaiting-plan-review", "backlog"]) {
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

  // Backlog is a destination, not a column (#3293).
  it("offers Backlog in the move select, except to a card in flight or an unassigned one", () => {
    const selectOf = (card: BoardCard): string =>
      buildBoardPage(makeView([card]), "dark").match(/<select class="board-move"[\s\S]*?<\/select>/)![0];

    expect(selectOf(makeCard())).toContain(`<option value="backlog">Backlog</option>`);
    expect(selectOf(makeCard({ flight: { implementing: true, openPrs: [] } }))).not.toContain(`value="backlog"`);
    expect(selectOf(makeCard({ repo: "", ref: NATIVE, url: `/issues/${NATIVE}` }))).not.toContain(`value="backlog"`);
  });

  it("leaves backlog cards off the board and links the backlog with its count", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1 }),
      makeCard({ ref: 2, labels: [LABELS.backlog] }),
    ], { backlogCount: 3 }), "dark");

    expect(html).toContain(`data-ref="1"`);
    expect(html).not.toContain(`data-ref="2"`);
    expect(html).toContain(`<a class="trigger-btn" id="board-backlog-link" href="/backlog">Backlog (<span id="board-backlog-count">3</span>)</a>`);
    for (const col of ["ideas", "planning", "awaiting-plan-review", "approved", "implementing", "pr-open", "blocked", "awaiting-merge", "done"]) {
      expect(columnCards(html, col)).not.toContain("2");
    }
  });

  it("keeps the repo filter on the backlog link", () => {
    const html = buildBoardPage(makeView([makeCard()], { repoFilter: "org/repo" }), "dark");
    expect(html).toContain(`href="/backlog?repo=org%2Frepo"`);
  });

  it("renders the Backlog tray as a drop target outside the columns", () => {
    const html = buildBoardPage(makeView([makeCard()]), "dark");

    expect(html).toMatch(/<div class="board-col-body board-tray-body" data-column="backlog"[^>]*>/);
    // A destination, not a column: no <details>, no count.
    expect(html).not.toContain(`<details class="board-col" data-column="backlog"`);
    expect(html).not.toContain(`data-count="backlog"`);
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
    expect(html).toContain(`.board-col, .board-group-cols > .board-col { flex: 1 1 0; min-width: 13rem; max-width: 22rem; }`);
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
    expect(styleBlock).toContain(`.board-col { width: 100%;`);
    expect(styleBlock).not.toContain(`flex: 0 0 min(80vw, 17rem)`);
    expect(tablet).toContain(`.board-group-cols { flex-direction: row;`);
    expect(tablet).toContain(`.board-group-cols > .board-col { flex: 1 1 0;`);
    // The derived count is phone-only: from a tablet up, the columns are open.
    expect(tablet).toContain(`.board-group-derived { display: none; }`);
    expect(tablet).not.toContain(`.board { flex-direction: row`);
    expect(desktop).toContain(`.board { flex-direction: row; overflow-x: auto;`);
    expect(desktop).toContain(`min-width: 13rem; max-width: 22rem; }`);
  });

  // Every column renders open so a no-JS or desktop first paint shows the
  // whole board; only the client script collapses columns, and only on a phone.
  it("renders every column as an open, collapsible <details> with its count inside the summary", () => {
    const html = buildBoardPage(makeView([makeCard({ ref: 1, labels: [LABELS.ready] })]), "dark");

    expect(html).toContain(`<details class="board-col board-col-gate" data-column="ideas" open aria-label="Ideas">`);
    const summary = html.match(/<summary class="board-col-head"[\s\S]*?<\/summary>/)!;
    expect(summary[0]).toContain(`<h3 class="board-col-title">`);
    expect(summary[0]).toContain(`<span class="board-col-count" data-count="ideas">`);
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

  // Title, count, filter and Backlog link share one toolbar row: the page
  // header prints no second "Board".
  it("renders one toolbar holding the title, the repo filter and the Backlog link", () => {
    const html = buildBoardPage(makeView([makeCard()]), "dark");
    const beforeColumns = html.slice(0, html.indexOf(`id="issue-board"`));

    expect(beforeColumns.match(/<h2[ >]/g)).toHaveLength(1);
    expect(html).toMatch(/<div class="board-toolbar">\s*<h2>Board <span>1<\/span><\/h2>\s*<form class="board-filters"[\s\S]*?<\/form>\s*<a class="trigger-btn" id="board-backlog-link"/);
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

  it("warns on an Ideas card past its threshold but never on a Blocked one", () => {
    const html = buildBoardPage(makeView([
      makeCard({ ref: 1, stageSince: ago(4 * 24 * HOUR) }),
      makeCard({ ref: 2, labels: [LABELS.blocked], stageSince: ago(4 * 24 * HOUR) }),
    ]), "dark");

    expect(html).toMatch(/data-ref="1"[\s\S]*?<span class="board-age" data-stale="true"[^>]*>4d</);
    expect(html).toMatch(/data-ref="2"[\s\S]*?<span class="board-age" data-stale="false"[^>]*>4d</);
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

    expect(html).toContain(`<details class="board-plan"><summary>Plan · 5 sections</summary><div class="markdown"><p>Need it.</p></div><a href="/issues/clw_X#plan">Full plan</a></details>`);
  });

  it("renders no plan block for a card without a plan", () => {
    expect(buildBoardPage(makeView([makeCard()]), "dark")).not.toContain(`<details class="board-plan">`);
  });
});
