/**
 * The kanban board's column model (#3215, docs/issue-tracker.md#board).
 *
 * A leaf module: it maps between the board's columns and the lifecycle state
 * Claws already acts on, and nothing else. A column is derived every time it
 * is rendered from the issue's stored lifecycle state — the
 * `claws_issues.lifecycle` field for a native issue, which `db.ts` presents as
 * the state label it replaced (see `issue-lifecycle.ts`), or the labels
 * themselves for a forge issue — plus `closed` and the issue's *flight*: a
 * running `issue-worker` task and its open `claws_prs` rows, which
 * `issue-flight.ts` loads and hands in (docs/refinements/issue-flow.md, "The
 * board"). So a state an agent sets shows up on the board with no extra
 * bookkeeping, and a board that disagrees with the pipeline is impossible by
 * construction.
 *
 * Kept out of `pages/board.ts` because both the page builder (grouping the
 * cards) and `server.ts` (`POST /board/move`) need the same mapping, and out of
 * `config.ts` because it is board vocabulary rather than configuration. It
 * declares its own minimal {@link BoardPr} rather than importing `db.ts`, so it
 * stays a leaf.
 */

import { LABELS } from "./config.js";
import { STATE_LABELS } from "./issue-lifecycle.js";

/**
 * The board's three headed groups, left to right. Blocked belongs to none: it
 * stands alone between Building and Landing.
 */
export const BOARD_GROUPS = [
  { id: "shaping", title: "Shaping" },
  { id: "building", title: "Building" },
  { id: "landing", title: "Landing" },
] as const;

export type BoardGroup = (typeof BOARD_GROUPS)[number]["id"];

/**
 * The columns, left to right. A `gate` column is where a human acts — a drop
 * target the board marks as such. A `derived` column is set by Claws from the
 * issue's flight and is never a drop target — see {@link transitionFor}.
 * Blocked is neither: a drop target, but a parking spot rather than a gate.
 */
export const BOARD_COLUMNS = [
  { id: "ideas", title: "Ideas", hint: "Filed — Claws writes the requirements; promote when they read right — drop a card here", group: "shaping", gate: true, derived: false },
  { id: "planning", title: "Planning", hint: "Requirements approved — the planner is queued or running — drop here to promote or re-plan", group: "shaping", gate: true, derived: false },
  { id: "awaiting-plan-review", title: "Awaiting plan review", hint: "Planned — waiting for a human to approve — drop a card here", group: "shaping", gate: true, derived: false },
  { id: "approved", title: "Approved", hint: "Plan approved — Claws implements it — drop a card here", group: "building", gate: true, derived: false },
  { id: "implementing", title: "Implementing", hint: "Claws' implementer is running — set by Claws, not a drop target", group: "building", gate: false, derived: true },
  { id: "pr-open", title: "PR open", hint: "The issue's PR is cycling through CI, review and fixes — set by Claws, not a drop target", group: "building", gate: false, derived: true },
  { id: "blocked", title: "Blocked", hint: "Parked on something external", group: null, gate: false, derived: false },
  { id: "awaiting-merge", title: "Awaiting merge", hint: "Clean review and green CI — approve the merge with the card's Automerge control — set by Claws, not a drop target", group: "landing", gate: false, derived: true },
  { id: "done", title: "Done", hint: "Closed — drop a card here", group: "landing", gate: true, derived: false },
] as const;

export type BoardColumn = (typeof BOARD_COLUMNS)[number]["id"];

/** The columns Claws sets from the issue's flight; none is a drop target. */
export const DERIVED_COLUMNS: readonly BoardColumn[] = BOARD_COLUMNS.filter((col) => col.derived).map((col) => col.id);

/**
 * The one destination that is not a column (#3293): a backlog issue is off the
 * board and parked, listed on `/backlog` instead, and only a human promotes it
 * back to Ideas or Planning. It is deliberately absent from {@link BOARD_COLUMNS}.
 */
export const BACKLOG_DESTINATION = "backlog";

/** Everywhere a card can be, or be sent: a column, or the backlog. */
export type BoardDestination = BoardColumn | typeof BACKLOG_DESTINATION;

/** How far back the `done` column reaches. A board of every issue ever closed is not a board. */
export const DONE_WINDOW_DAYS = 14;

/**
 * How many closed issues the `done` column holds — the other half of the same
 * bound, kept here so both are declared together.
 *
 * `GET /board` asks each repository for at most this many (the query is
 * per-repo, and the cap pushes into SQL) and then cuts the merged, newest-first
 * list to it again, so the column is bounded globally like the window is rather
 * than at this many *per repository*. The `?repo=` filter goes on before that
 * second cut, or a filtered board would show only the few of that repository's
 * cards that survived a top 50 spread over every other one.
 */
export const DONE_COLUMN_LIMIT = 50;

/**
 * The labels the board owns — the ones a move may add and remove — in ladder
 * order: `Backlog`, `Blocked`, `Refined`, `Ready`. The four state labels and
 * nothing else.
 *
 * The derived columns read no label at all: Implementing, PR open and Awaiting
 * merge follow the issue's running implementer and open PR rows, which no move
 * changes, so an issue in flight keeps its flight through every move — see
 * {@link transitionFor}.
 */
export const LIFECYCLE_LABELS = STATE_LABELS;

/**
 * The moves the board refuses, and what the operator is told.
 *
 * `client/issue-board.ts` repeats all three verbatim rather than importing
 * them, and applies them in its own `canReach` so a guaranteed refusal is never
 * offered by a select or accepted by a drag. Not because the bundle cannot
 * follow an import — `scripts/build-client.mjs` runs esbuild with
 * `bundle: true`, so it would be inlined — but because *this* module imports
 * `./config.js` for `LABELS`, which reads `node:fs`, `node:os` and the
 * environment; importing it from the client would drag the whole config module
 * into the browser. `issue-board.test.ts` pins each copy against the generated
 * bundle, since each suite otherwise asserts only its own.
 *
 * The client's copies are a pre-flight; `POST /board/move` is the real check,
 * and it sees state a card left open cannot.
 */

/**
 * Why a drop into a derived column — or a move an issue's flight overrides — is
 * refused, shown to the operator verbatim.
 */
export const DERIVED_COLUMN_REJECTION =
  "Implementing, PR open and Awaiting merge follow the issue's running implementer and open PR — open, merge or close the PR instead.";

/** Why a drop out of Ideas is refused for an issue no repository owns. */
export const UNASSIGNED_REJECTION =
  "Assign this issue to a repository before moving it out of Ideas.";

/**
 * Why a drop out of Done is refused for a closed *forge* issue: `github.ts` has
 * no forge reopen, so the labels would go on an issue that stays closed — and
 * `columnFor` puts a closed issue in Done whatever they say.
 */
export const FORGE_REOPEN_REJECTION =
  "The board cannot reopen a forge issue — reopen it on the forge.";

/**
 * The part of an open `claws_prs` row the board reads. Declared here rather
 * than imported from `db.ts` so this module stays a leaf; a `ClawsPrRecord`
 * satisfies it.
 */
export interface BoardPr {
  stage: string;
  needsHumanReview: boolean;
}

/** The part of an issue the board reads. */
export interface BoardIssue {
  labels: readonly string[];
  closed?: boolean;
  /**
   * A native issue with no repository yet. Automation cannot act on it, so its
   * lifecycle labels do not mean what they say yet — it belongs in Ideas
   * until it names a repository. A multi-repo issue is assigned: its primary
   * repository owns it.
   */
  unassigned?: boolean;
  /**
   * The issue's stored lifecycle — a native issue's field, or a forge issue's
   * shadow. Only `planning` matters here: Ideas and Planning carry no label,
   * so an issue with no state label is in Planning when it says so and in
   * Ideas otherwise.
   */
  lifecycle?: string;
  /** An `issue-worker` task is running for the issue right now. */
  implementing?: boolean;
  /** The issue's open `claws_prs` rows, in any repository. */
  openPrs?: readonly BoardPr[];
}

/** The flight fields of a {@link BoardIssue}: what no board move changes. */
export type BoardFlight = Pick<BoardIssue, "implementing" | "openPrs">;

export function isBoardColumn(value: string): value is BoardColumn {
  return BOARD_COLUMNS.some((col) => col.id === value);
}

export function isBoardDestination(value: string): value is BoardDestination {
  return value === BACKLOG_DESTINATION || isBoardColumn(value);
}

/** Whether `column` is set by Claws rather than by a move. */
export function isDerivedColumn(column: string): boolean {
  return (DERIVED_COLUMNS as readonly string[]).includes(column);
}

/** Whether the issue has a running implementer or an open PR. */
function inFlight(issue: BoardFlight): boolean {
  return !!issue.implementing || (issue.openPrs?.length ?? 0) > 0;
}

/**
 * Why a send to the backlog is refused, or undefined when it is allowed.
 *
 * `Backlog` outranks the derived columns in {@link columnFor}'s ladder, so the
 * landing check alone would let an issue with a running implementer or an open
 * PR leave the board. That work is in flight, so every send-to-backlog path
 * checks this first and refuses with {@link DERIVED_COLUMN_REJECTION} — the
 * same copy the client already pins.
 */
export function backlogRefusal(issue: BoardFlight): string | undefined {
  return inFlight(issue) ? DERIVED_COLUMN_REJECTION : undefined;
}

/**
 * The column an issue belongs in.
 *
 * The ladder follows the pipeline's own precedence: closed, then unassigned,
 * then `Backlog` — a human's "not now" outranks every automated state, and a
 * backlog issue is on no column at all, only on `/backlog` — then `Blocked`
 * because `gh.isParked` drops a blocked issue in `jobs/issue-auditor.ts`'s loop
 * before anything classifies it. Then a running implementer, which outranks
 * `Refined` because `issue-worker` keeps `Refined` until the PR opens. Then
 * `Refined` over an open PR, because `classifyIssue` returns `refined` before it
 * looks for one — a multi-PR issue with its next phase approved is still Claws'
 * to implement. Open PR rows put the issue in Awaiting merge when every one of
 * them is at `awaiting-merge`, and in PR open otherwise; they outrank `Ready`.
 * A board that ordered these the other way would disagree with the pipeline it
 * draws.
 *
 * The Blocked column reads the `Blocked` label **alone**, not the whole of
 * `gh.isParked`, which also parks on `Claws Ignore` and — while the active
 * instance runs — `Claws Staging`. Those two park an issue without moving its
 * card, so an issue carrying `Claws Ignore` and `Refined` renders in Approved
 * under a hint that says Claws implements it, which it never will; the card's
 * own label chips are the only signal. The narrow reading is deliberate: the
 * board owns {@link LIFECYCLE_LABELS} and nothing else, so a move out of
 * Blocked removes exactly the `Blocked` label and cannot silently un-ignore an
 * issue. Read a card's column as "these are its lifecycle labels and its
 * flight", never as "the pipeline will act on it".
 */
export function columnFor(issue: BoardIssue): BoardDestination {
  if (issue.closed) return "done";
  if (issue.unassigned) return "ideas";
  if (issue.labels.includes(LABELS.backlog)) return BACKLOG_DESTINATION;
  if (issue.labels.includes(LABELS.blocked)) return "blocked";
  if (issue.implementing) return "implementing";
  if (issue.labels.includes(LABELS.refined)) return "approved";
  const prs = issue.openPrs ?? [];
  if (prs.length > 0) return prs.every((pr) => pr.stage === "awaiting-merge") ? "awaiting-merge" : "pr-open";
  if (issue.labels.includes(LABELS.ready)) return "awaiting-plan-review";
  return issue.lifecycle === "planning" ? "planning" : "ideas";
}

/** The label and state changes a move into `to` applies. */
export interface BoardMove {
  add: readonly string[];
  remove: readonly string[];
  /** Close the issue instead of relabelling it. */
  close: boolean;
  /**
   * The unlabelled lifecycle the move sets: Ideas and Planning share the same
   * (empty) labels, so this is what tells the two moves apart.
   */
  lifecycle?: "ideas" | "planning";
}

/**
 * A move that leaves the issue holding exactly `add` of {@link LIFECYCLE_LABELS}.
 *
 * Declaring the complete state of the labels the board **owns**, rather than an
 * ad-hoc add/remove pair, is what stops a move reporting a column it did not
 * reach for a reason of its own making: "add `Refined`, remove `Ready`" leaves a
 * `Blocked` card in Blocked. It is not the whole of `columnFor`, because the
 * issue's flight is outside it — so the landing column is computed from the
 * issue's real labels and flight in {@link columnAfterMove} rather than assumed
 * from the move's shape.
 */
function lifecycleMove(add: readonly string[]): BoardMove {
  return { add, remove: LIFECYCLE_LABELS.filter((label) => !add.includes(label)), close: false };
}

/**
 * What a drop into `to` should do, or `null` when the column is not a
 * destination.
 *
 * The {@link DERIVED_COLUMNS} are refused: they follow a running implementer or
 * an open PR, which no label change can bring about. The caller turns the
 * `null` into a 409 rather than silently doing nothing, so the card snaps back
 * and the operator is told why.
 *
 * Dragging *out of* a derived column keeps the flight — the move does not touch
 * the task or the PR — so only the destinations that outrank it in `columnFor`
 * are reachable:
 *
 * - A card with a **running implementer** reaches **Blocked** (the label
 *   outranks it) and **Done** (closing outranks everything). Approved does not
 *   land: `Refined` sits below a running implementer.
 * - A card with **open PR rows** reaches **Approved** and **Blocked** as well as
 *   **Done**: `Refined` outranks an open PR.
 * - **Ideas**, **Planning** and **Awaiting plan review** never land for a card in flight, which
 *   `POST /board/move`'s `landing !== to` check turns into a 409 carrying
 *   {@link DERIVED_COLUMN_REJECTION}.
 * - **Backlog** would land (it outranks the flight), but is refused for an
 *   issue in flight by {@link backlogRefusal} before the move is applied.
 */
export function transitionFor(to: BoardDestination): BoardMove | null {
  switch (to) {
    case "ideas":
      return { ...lifecycleMove([]), lifecycle: "ideas" };
    case "planning":
      return { ...lifecycleMove([]), lifecycle: "planning" };
    case "awaiting-plan-review":
      return lifecycleMove([LABELS.ready]);
    case "approved":
      return lifecycleMove([LABELS.refined]);
    case "blocked":
      return lifecycleMove([LABELS.blocked]);
    case "backlog":
      return lifecycleMove([LABELS.backlog]);
    case "done":
      return { add: [], remove: [], close: true };
    case "implementing":
    case "pr-open":
    case "awaiting-merge":
      return null;
  }
}

/**
 * The column `move` actually reaches, for an issue currently in `state`.
 *
 * `transitionFor` cannot promise this on its own, for two reasons. `columnFor`
 * reads `closed` and `unassigned`, which no label change touches — an unassigned
 * native issue dropped into Approved really does get `Refined`, and stays in
 * Ideas regardless. And it reads the issue's flight, which no move changes, so
 * the flight is carried through: an issue with an open PR keeps it through
 * every move, and a drop into Ideas, Planning or Awaiting plan review therefore lands back in
 * PR open or Awaiting merge.
 *
 * So `POST /board/move` computes the landing column here, from the issue's
 * **real** labels and flight, and answers `ok` only when it is the column that
 * was asked for; anything else is a 409 with a reason.
 */
export function columnAfterMove(
  move: BoardMove,
  state: Pick<BoardIssue, "closed" | "unassigned" | "lifecycle"> & BoardFlight & { labels: readonly string[] },
): BoardDestination {
  const after = [...state.labels.filter((label) => !move.remove.includes(label)), ...move.add];
  return columnFor({
    labels: after,
    closed: move.close || state.closed,
    unassigned: state.unassigned,
    lifecycle: move.lifecycle ?? state.lifecycle,
    implementing: state.implementing,
    openPrs: state.openPrs,
  });
}
