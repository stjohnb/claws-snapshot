/**
 * The kanban board's column model (#3215, docs/issue-tracker.md#board).
 *
 * A leaf module: it maps between the board's columns and the lifecycle state
 * Claws already acts on, and nothing else. A column is derived every time it
 * is rendered from the issue's stored lifecycle state — the
 * `claws_issues.lifecycle` field for a native issue, which `db.ts` presents as
 * the state label it replaced (see `issue-lifecycle.ts`), or the labels
 * themselves for a forge issue — its stored approval (`approved_through`,
 * `issue-approval.ts`), plus `closed` and the issue's *flight*: a
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
import { STATE_LABELS, type IssueLifecycle } from "./issue-lifecycle.js";
import { atLeast, type ApprovedThrough } from "./issue-approval.js";

import { BOARD_COLUMNS } from "./board-columns.js";
export { BOARD_COLUMNS } from "./board-columns.js";
export { APPROVED_NEEDS_PLAN_REJECTION, REVIEW_NEEDS_PLAN_REJECTION, planRefusal } from "./board-plan-rule.js";

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

export type BoardColumn = (typeof BOARD_COLUMNS)[number]["id"];

/** The columns Claws sets from the issue's flight; none is a drop target. */
export const DERIVED_COLUMNS: readonly BoardColumn[] = BOARD_COLUMNS.filter((col) => col.derived).map((col) => col.id);

/**
 * The two columns the stored `ideas` lifecycle splits into, derived on every
 * render from the issue's requirements state rather than stored: Drafting
 * while Claws owes a requirements version (none yet, or feedback left on the
 * latest one), Requirements review once the latest version is waiting on a
 * person. Both mean the same move — lifecycle `ideas` — and the card lands in
 * whichever one its requirements state says.
 */
export const REQUIREMENTS_COLUMNS = ["drafting", "requirements-review"] as const satisfies readonly BoardColumn[];

/** Whether `value` is Drafting or Requirements review. */
export function isRequirementsColumn(value: string): value is (typeof REQUIREMENTS_COLUMNS)[number] {
  return (REQUIREMENTS_COLUMNS as readonly string[]).includes(value);
}

/**
 * Whether a move asked to go to `target` and reached `landing` landed: the
 * same column, or either requirements column for the other — the issue's
 * requirements state, not the drop, picks between those two.
 */
export function landsIn(landing: string, target: string): boolean {
  return landing === target || (isRequirementsColumn(landing) && isRequirementsColumn(target));
}

/**
 * The board destination that stands for a stored lifecycle: `ideas` is
 * {@link REQUIREMENTS_COLUMNS}' shared move, named by Requirements review;
 * every other lifecycle is its own column or the backlog.
 */
export function destinationForLifecycle(lifecycle: IssueLifecycle): BoardDestination {
  return lifecycle === "ideas" ? "requirements-review" : lifecycle;
}

/**
 * The one destination that is not a column (#3293): a backlog issue is off the
 * board and parked, listed on `/backlog` instead, and only a human promotes it
 * back to Drafting, Requirements review or Planning. It is deliberately absent
 * from {@link BOARD_COLUMNS}.
 */
export const BACKLOG_DESTINATION = "backlog";

/** Everywhere a card can be, or be sent: a column, or the backlog. */
export type BoardDestination = BoardColumn | typeof BACKLOG_DESTINATION;

/** How far back the `done` column reaches. A board of every issue ever closed is not a board. */
export const DONE_WINDOW_HOURS = 8;

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
 * order: `Backlog`, `Blocked`. The two state labels and nothing else; every
 * other column is a stored lifecycle or approval, which a move sets directly.
 *
 * The derived columns read no label at all: In progress and Awaiting
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
 *
 * The plan rule — Approved and Awaiting plan review need a plan — is the one
 * refusal the client imports rather than copies: it lives in the leaf
 * `board-plan-rule.ts`, re-exported here, which pulls in nothing.
 */

/**
 * Why a drop into a derived column — or a move an issue's flight overrides — is
 * refused, shown to the operator verbatim.
 */
export const DERIVED_COLUMN_REJECTION =
  "In progress, Queued and Awaiting merge follow the issue's running implementer, open PRs and dependencies — open, merge or close the PR, or resolve the dependency, instead.";

/** Why a move to Blocked with no reason, or a blank one, is refused. */
export const BLOCKED_REASON_REQUIRED = "A reason is required to mark an issue Blocked.";

/** Why a drop out of Drafting is refused for an issue no repository owns. */
export const UNASSIGNED_REJECTION =
  "Assign this issue to a repository before moving it out of Drafting.";

/**
 * Why a drop out of Done is refused for a closed *forge* issue: `github.ts` has
 * no forge reopen, so the labels would go on an issue that stays closed — and
 * `columnFor` puts a closed issue in Done whatever they say.
 */
export const FORGE_REOPEN_REJECTION =
  "The board cannot reopen a forge issue — reopen it on the forge.";

/**
 * How a recorded close reason reads to an operator, or `""` for none — an
 * issue closed before this shipped (AC12) or one no path here has set a
 * reason for. `client/issue-board.ts` keeps its own copy for the same reason
 * the rejection strings above do: a browser bundle imports no server code.
 */
export function closeReasonLabel(reason?: string | null): string {
  if (reason === "completed") return "Completed";
  if (reason === "not_planned") return "Not planned";
  return "";
}

/**
 * The part of an open `claws_prs` row the board reads. Declared here rather
 * than imported from `db.ts` so this module stays a leaf; a `ClawsPrRecord`
 * satisfies it.
 */
export interface BoardPr {
  stage: string;
  needsHumanReview: boolean;
  /** The PR's recorded hold reason, if any; it does not make the PR stalled. */
  manualActionReason?: string | null;
  /** Why CI cannot run for the PR (Billing), if anything. */
  ciBlockedReason?: string | null;
}

/**
 * Whether an open PR cannot move on until a person acts: it is at
 * `problematic` (CI fixes exhausted), or carries a CI-blocked reason.
 * `needsHumanReview` alone does not count — it gates only the merge, which
 * Awaiting merge already waits on — and nor do conflicts or a declined merge,
 * which automation retries. Nor does a recorded hold (`manualActionReason`):
 * it gates only that PR's merge, its issue stays in Awaiting merge, and the
 * board card shows the hold and a "Needs you" chip (`pages/board.ts`); a hold
 * never applies `Blocked` (#115).
 *
 * A stalled PR drives no column: it parks its linked issue in Blocked
 * (`pr-stall-park.ts`, #clw_01M4TJEHAP19S2N3SE6EHE6VNA) and counts toward the
 * nav PRs count only through `prAttentionReasons` (`pr-attention.ts`).
 */
export function isStalledPr(pr: BoardPr): boolean {
  return pr.stage === "problematic" || !!pr.ciBlockedReason;
}

/** The part of an issue the board reads. */
export interface BoardIssue {
  labels: readonly string[];
  closed?: boolean;
  /**
   * A native issue with no repository yet. Automation cannot act on it, so its
   * lifecycle labels do not mean what they say yet — it belongs in Drafting
   * until it names a repository (the requirements writer cannot run without
   * one). A multi-repo issue is assigned: its primary repository owns it.
   */
  unassigned?: boolean;
  /**
   * The issue's stored lifecycle — a native issue's field, or a forge issue's
   * shadow. `ideas`, `planning` and `awaiting-plan-review` carry no label,
   * so an issue with no state label is in Planning or a plan-review column
   * when it says so and in Drafting or Requirements review otherwise.
   */
  lifecycle?: string;
  /**
   * The issue's stored approval — a native issue's field, or a forge issue's
   * shadow. An issue in `awaiting-plan-review` approved through Plan is in
   * Approved; absent reads as `none`.
   */
  approvedThrough?: ApprovedThrough;
  /**
   * The issue's latest requirements version exists and no human feedback has
   * been left on it since — it waits on a person in Requirements review rather
   * than on Claws in Drafting. Read from the requirements versions and
   * comments on every render (`claws-issues.ts`'s
   * `getRequirementsFeedbackPending`), never stored, so a comment moves the
   * card back with no edit to the issue.
   */
  requirementsReview?: boolean;
  /** An `issue-worker` task is running for the issue right now. */
  implementing?: boolean;
  /** The issue's open `claws_prs` rows, in any repository. */
  openPrs?: readonly BoardPr[];
  /**
   * Every PR step of the issue's plan has merged and its operator step (the
   * plan's `manual` entry) is still open — it waits on a person in Awaiting
   * merge (`db.getIssueIdsAwaitingOperator`).
   */
  awaitingOperator?: boolean;
  /**
   * A design change on the issue waits for the operator's re-approval
   * (`reapproval.ts`): its open PRs are held, and the decision is the
   * operator's, so it sits in Awaiting plan review rather than a PR column.
   */
  reapprovalPending?: boolean;
  /**
   * A forge issue in a repo with `issue-importer` enabled that has not been
   * imported yet (`gh.awaitingImportReason`). No agent acts on it until it is
   * native, so a gate column would offer a gate with nothing behind it: those
   * columns collapse to Drafting (#clw_01M52GPG0E9DP8RQKW6ABH0X7R).
   */
  awaitingImport?: boolean;
  /**
   * The issue carries `Blocked` only to wait on other issues or PRs in flight —
   * its current reason is a dependency park Claws wrote, which Claws releases
   * by itself (`queued-issues.ts`'s `issuesQueued`). It shows in Queued rather
   * than Blocked; meaningless without the `Blocked` label.
   */
  queued?: boolean;
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
 * before anything classifies it. Then a running implementer. Then a design
 * change pending re-approval: its PRs are held for the operator's decision, so
 * it shows in Awaiting plan review — approving the Plan gate is that decision.
 * Open PR rows put the issue in Awaiting merge when every one of them is at
 * `awaiting-merge`, and in In progress otherwise; an operator step left after
 * every PR merged is Awaiting merge too. A PR that waits on a person
 * ({@link isStalledPr}) has no column of its own: Claws parks its issue in
 * Blocked (`pr-stall-park.ts`), which outranks it. Only then the stored
 * lifecycle: `awaiting-plan-review` is Approved once the issue is approved
 * through Plan and Awaiting plan review otherwise, then Planning. A multi-PR
 * issue approved through Plan with no PR open between steps is therefore in
 * Approved, which is what it is: Claws' to implement.
 * A board that ordered these the other way would disagree with the pipeline it
 * draws.
 *
 * A `Blocked` issue that is only waiting on other work in flight
 * ({@link BoardIssue.queued}) is in Queued instead: same label, same place in
 * the ladder, a column of its own so Blocked holds only what needs a person.
 *
 * The Blocked column reads the `Blocked` label **alone**, not the whole of
 * `gh.isParked`, which also parks on `Claws Staging` while the active
 * instance runs. That parks an issue without moving its card, so a staging
 * issue in Planning stays in Planning. The narrow reading is deliberate: the
 * board owns {@link LIFECYCLE_LABELS} and nothing else, so a move out of
 * Blocked removes exactly the `Blocked` label and cannot silently clear any
 * other hold. Read a card's column as "these are its lifecycle labels and its
 * flight", never as "the pipeline will act on it".
 *
 * An issue {@link BoardIssue.awaitingImport awaiting import} keeps its column
 * except that the gate columns — Requirements review, Planning, Awaiting plan
 * review and Approved — collapse to Drafting: none of them means anything
 * until the native copy exists.
 */
export function columnFor(issue: BoardIssue): BoardDestination {
  const column = lifecycleColumnFor(issue);
  if (issue.awaitingImport && (IMPORT_GATE_COLUMNS as readonly string[]).includes(column)) return "drafting";
  return column;
}

/** The gate columns an issue awaiting import never sits in. */
const IMPORT_GATE_COLUMNS = ["requirements-review", "planning", "awaiting-plan-review", "approved"] as const;

function lifecycleColumnFor(issue: BoardIssue): BoardDestination {
  if (issue.closed) return "done";
  if (issue.unassigned) return "drafting";
  if (issue.labels.includes(LABELS.backlog)) return BACKLOG_DESTINATION;
  if (issue.labels.includes(LABELS.blocked)) return issue.queued ? "queued" : "blocked";
  if (issue.implementing) return "in-progress";
  // A pending design change needs the operator's decision, whatever its held PRs say.
  if (issue.reapprovalPending) return "awaiting-plan-review";
  const prs = issue.openPrs ?? [];
  if (prs.length > 0) {
    if (prs.every((pr) => pr.stage === "awaiting-merge")) return "awaiting-merge";
    return "in-progress";
  }
  if (issue.awaitingOperator) return "awaiting-merge";
  if (issue.lifecycle === "awaiting-plan-review") return atLeast(issue.approvedThrough, "plan") ? "approved" : "awaiting-plan-review";
  // Planning means "the planner is queued or running". Every implementer exit
  // names its destination (`issue-handback.ts`), and the dispatcher re-plans or
  // returns to plan review any planned issue left here without a planner.
  if (issue.lifecycle === "planning") return "planning";
  return issue.requirementsReview ? "requirements-review" : "drafting";
}

/** The label, lifecycle and approval changes a move into `to` applies. */
export interface BoardMove {
  add: readonly string[];
  remove: readonly string[];
  /** Close the issue instead of relabelling it. */
  close: boolean;
  /**
   * The unlabelled lifecycle the move sets: the requirements columns,
   * Planning and the plan-review columns share the same (empty) labels, so
   * this is what tells the moves apart.
   */
  lifecycle?: "ideas" | "planning" | "awaiting-plan-review";
  /**
   * The approval the move sets (`issue-approval-write.ts`): Approved is
   * approval through Plan (never lowering a Merge approval), and Planning and
   * Awaiting plan review take a plan approval back to Requirements — a
   * re-plan or a second look must not run on the old approval. `requirements`
   * only ever lowers: see {@link approvalForMove}.
   */
  approval?: Extract<ApprovedThrough, "requirements" | "plan">;
}

/**
 * The approval a move writes for an issue currently approved through
 * `current`, or undefined when it writes none: Approved raises to at least
 * Plan, and Planning and Awaiting plan review lower a Plan or Merge approval
 * to Requirements but never raise a lower one.
 */
export function approvalForMove(move: Pick<BoardMove, "approval">, current: ApprovedThrough): ApprovedThrough | undefined {
  if (move.approval === "plan") return atLeast(current, "plan") ? current : "plan";
  if (move.approval === "requirements") return atLeast(current, "plan") ? "requirements" : undefined;
  return undefined;
}

/**
 * A move that leaves the issue holding exactly `add` of {@link LIFECYCLE_LABELS}.
 *
 * Declaring the complete state of the labels the board **owns**, rather than an
 * ad-hoc add/remove pair, is what stops a move reporting a column it did not
 * reach for a reason of its own making: a move to Approved that left
 * `Blocked` on would leave the card in Blocked. It is not the whole of `columnFor`, because the
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
 * - A card with a **running implementer** or **open PR rows** reaches
 *   **Blocked** (the label outranks it) and **Done** (closing outranks
 *   everything). Approved does not land: the approval sits below the flight.
 * - **Drafting**, **Requirements review**, **Planning**, **Awaiting plan review** and **Approved** never land
 *   for a card in flight, which `POST /board/move`'s `landsIn` check turns into a 409 carrying
 *   {@link DERIVED_COLUMN_REJECTION}.
 * - **Backlog** would land (it outranks the flight), but is refused for an
 *   issue in flight by {@link backlogRefusal} before the move is applied.
 *
 * **Approved** and **Awaiting plan review** also need a plan, whatever column
 * the move starts from — `planRefusal` in `board-plan-rule.ts`, which every
 * move path checks beside this one. A move into **Planning** for an issue that
 * already has a plan is a re-plan: the route enqueues the planner as well.
 */
export function transitionFor(to: BoardDestination): BoardMove | null {
  switch (to) {
    case "drafting":
    case "requirements-review":
      return { ...lifecycleMove([]), lifecycle: "ideas" };
    case "planning":
      return { ...lifecycleMove([]), lifecycle: "planning", approval: "requirements" };
    case "awaiting-plan-review":
      return { ...lifecycleMove([]), lifecycle: "awaiting-plan-review", approval: "requirements" };
    case "approved":
      return { ...lifecycleMove([]), lifecycle: "awaiting-plan-review", approval: "plan" };
    case "blocked":
      return lifecycleMove([LABELS.blocked]);
    case "backlog":
      return lifecycleMove([LABELS.backlog]);
    case "done":
      return { add: [], remove: [], close: true };
    case "in-progress":
    case "queued":
    case "awaiting-merge":
      return null;
  }
}

/**
 * The column `move` actually reaches, for an issue currently in `state`.
 *
 * `transitionFor` cannot promise this on its own, for two reasons. `columnFor`
 * reads `closed` and `unassigned`, which no move touches — an unassigned
 * native issue dropped into Approved really is approved through Plan, and stays
 * in Drafting regardless. And it reads the issue's flight, which no move changes, so
 * the flight is carried through: an issue with an open PR keeps it through
 * every move, and a drop into Drafting, Requirements review, Planning or Awaiting plan review
 * therefore lands back in a PR column or Awaiting merge. It reads the issue's
 * requirements state too, which no move changes either, so a drop into one
 * requirements column may land in the other — {@link landsIn} counts that as
 * landed.
 *
 * So `POST /board/move` computes the landing column here, from the issue's
 * **real** labels and flight, and answers `ok` only when it is the column that
 * was asked for (by {@link landsIn}); anything else is a 409 with a reason.
 */
export function columnAfterMove(
  move: BoardMove,
  state: Pick<BoardIssue, "closed" | "unassigned" | "lifecycle" | "approvedThrough" | "requirementsReview"> & BoardFlight & { labels: readonly string[] },
): BoardDestination {
  const after = [...state.labels.filter((label) => !move.remove.includes(label)), ...move.add];
  return columnFor({
    labels: after,
    closed: move.close || state.closed,
    unassigned: state.unassigned,
    lifecycle: move.lifecycle ?? state.lifecycle,
    approvedThrough: approvalForMove(move, state.approvedThrough ?? "none") ?? state.approvedThrough,
    requirementsReview: state.requirementsReview,
    implementing: state.implementing,
    openPrs: state.openPrs,
  });
}
