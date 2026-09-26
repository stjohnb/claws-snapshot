import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, htmlOpenTag, buildPageHeader, THEME_SCRIPT, specLabelChip, NO_REPO_WARNING, repoShortName, formatCompactAge, formatRelativeTime } from "./layout.js";
import type { Theme } from "./layout.js";
import { BACKLOG_DESTINATION, BOARD_COLUMNS, BOARD_GROUPS, DERIVED_COLUMN_REJECTION, DONE_COLUMN_LIMIT, DONE_WINDOW_DAYS, columnFor, type BoardColumn, type BoardPr } from "../issue-board.js";
import { LABELS } from "../config.js";
import { isStateLabel } from "../issue-lifecycle.js";
import { ISSUE_BOARD_SCRIPT } from "../resources/issue-board.generated.js";
import { shortIssueRef, type IssueRef } from "../issue-id.js";
import { planPreviewBlock, type PlanPreview } from "./issue.js";

/** One issue on the board. The column is derived here, never stored (#3215). */
export interface BoardCard {
  /** The issue's repository — its primary one for a multi-repo native issue — or `""` for an unassigned one. */
  repo: string;
  ref: IssueRef;
  title: string;
  labels: string[];
  /** Native issues closed inside the `done` window; forge issues are open-only. */
  closed?: boolean;
  /**
   * The stored lifecycle — a native issue's field, or a forge issue's shadow —
   * which tells Ideas from Planning; absent reads as Ideas.
   */
  lifecycle?: string;
  /**
   * The latest requirements version, or null when the writer has produced
   * none yet; a card in Ideas shows it as a chip. Absent when unknown.
   */
  requirementsVersion?: number | null;
  /** Where the ref links to — the forge for a forge issue, `/issues/<id>` for a native one. */
  url: string;
  /**
   * One line summarising the issue's operator-set model-plan cells
   * (`plan: claude/fable · impl: codex/sonnet`), or absent when it has none.
   */
  modelPlan?: string;
  /**
   * The issue's latest plan, shown as a collapsed block on the card. Native
   * issues only: a forge issue's plan lives in forge comments.
   */
  plan?: PlanPreview;
  /** ISO 8601; absent when the source did not report one. */
  updatedAt?: string;
  /**
   * The issue's running implementer and open PR rows (`issue-flight.ts`),
   * which the derived columns read. Absent for a card not in flight, and for
   * every closed card.
   */
  flight?: BoardCardFlight;
  /**
   * ISO 8601: when the issue entered its current column — the moment it closed
   * for a Done card. Native issues only; a forge card leaves it absent and its
   * age chip falls back to `updatedAt` as an approximation.
   */
  stageSince?: string;
}

/** The part of an open `claws_prs` row a card reads; a `ClawsPrRecord` satisfies it. */
export interface BoardCardPr extends BoardPr {
  mergeApprovedAt: string | null;
}

export interface BoardCardFlight {
  implementing: boolean;
  openPrs: readonly BoardCardPr[];
}

export interface BoardPageView {
  cards: BoardCard[];
  /**
   * Every repository Claws manages, for the Repository filter. Passed in rather
   * than derived from `cards`, which are cut by `?repo=` and by the Done
   * column's row cap before they get here: a repository whose only board cards
   * were dropped by either would vanish from its own dropdown and could not be
   * widened back out of without "All repositories".
   */
  repoOptions: string[];
  /** `?repo=` — `""` means every repository. */
  repoFilter: string;
  /**
   * How many distinct *sources* came back incomplete: each repository counts
   * once however many of its fetches failed or hit the open-issue cap, plus the
   * unassigned list. The board is best-effort — a failed fetch drops only the
   * cards it would have produced — so the count is rendered in its own
   * `#board-warning`, which the client never touches, rather than letting a
   * short board read as an empty backlog.
   */
  incompleteSources: number;
  /**
   * How many open issues sit in the backlog (#3293) — off the board, listed on
   * `/backlog`. Counted by the route from the same fetch, under `?repo=` for
   * that repository only.
   */
  backlogCount: number;
}

const BOARD_CSS = `
  .board-filters { display: flex; gap: 0.5rem; flex: 1 1 12rem; margin: 0; }
  .board-filters .form-select { flex: 1 1 auto; min-width: 0; }
  .board-status { min-height: 1.2rem; font-size: 0.8rem; color: var(--danger); margin-bottom: 0.5rem; overflow-wrap: anywhere; }
  /* Not the same kind of message as a failed move: the board is incomplete,
     which is a warning about the render rather than about what the operator
     just did — and the client never writes into this one. */
  .board-warning { color: var(--warning); }
  .board { display: flex; flex-direction: column; gap: 0.6rem; }
  .board-group { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; }
  .board-group-head { font-family: var(--font-display); font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text); margin: 0; display: flex; gap: 0.4rem; align-items: baseline; }
  .board-group-count, .board-group-derived { color: var(--text-subtle); font-weight: 400; }
  .board-group-cols { display: flex; flex-direction: column; gap: 0.6rem; }
  .board-col { width: 100%; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-secondary); }
  .board-col-head { font-family: var(--font-display); font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-secondary); margin: 0; padding: 0.55rem 0.6rem; border-bottom: 1px solid var(--border); display: flex; gap: 0.4rem; align-items: baseline; cursor: pointer; list-style: none; position: sticky; top: 0; z-index: 1; background: var(--bg-secondary); }
  .board-col-head::-webkit-details-marker { display: none; }
  .board-col-head::after { content: "▾"; transition: none; }
  .board-col[open] > .board-col-head::after { content: "▴"; }
  .board-col-title { font-family: var(--font-display); font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; margin: 0 auto 0 0; }
  .board-col-count { color: var(--text-subtle); font-weight: 400; }
  .board-col-derived .board-col-head { color: var(--text-subtle); }
  /* A human gate: where the operator acts, marked apart from the derived
     columns Claws sets. */
  .board-col-gate .board-col-title::before { content: "◆"; color: var(--accent); margin-right: 0.35rem; }
  .board-col-body { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.5rem; min-height: 4rem; }
  .board-col-body.drag-over { outline: 2px dashed var(--accent); outline-offset: -4px; }
  .board-card { border: 1px solid var(--border); border-radius: 4px; background: var(--bg); padding: 0.5rem; display: flex; flex-direction: column; gap: 0.35rem; cursor: grab; user-select: none; -webkit-user-select: none; }
  .board-card[data-busy="true"] { opacity: 0.6; }
  .board-card.dragging { border-color: var(--accent); cursor: grabbing; }
  /* The card is the drag source, so the whole of it reads as grabbable — but a
     link inside it is still a link, and its text still selectable. */
  .board-card a, .board-plan { cursor: pointer; user-select: text; -webkit-user-select: text; }
  .board-plan { font-size: 0.75rem; color: var(--text-secondary); overflow-wrap: anywhere; }
  .board-plan > summary { font-family: var(--font-display); }
  .board-plan[open] > .markdown { color: var(--text); margin: 0.35rem 0; cursor: auto; }
  .board-plan .markdown p, .board-plan .markdown ul { margin: 0.25rem 0; }
  .board-card-head { display: flex; gap: 0.4rem; align-items: baseline; font-size: 0.75rem; }
  .board-ref { font-family: var(--font-display); overflow-wrap: anywhere; }
  /* Inline in the head row, so the card gains no height for it. */
  .board-age { font-family: var(--font-display); font-size: 0.65rem; line-height: 1.3; padding: 0 0.35rem; border: 1px solid var(--border); border-radius: 10px; color: var(--text-subtle); white-space: nowrap; }
  .board-age[data-stale="true"] { color: var(--warning); border-color: var(--warning); }
  .board-priority { color: var(--accent); font-weight: 600; }
  .board-automerge { display: inline-flex; align-items: center; justify-content: center; min-width: 36px; min-height: 36px; box-sizing: border-box; border-radius: 4px; border: 1px solid var(--border-hover); background: var(--btn-bg); color: var(--text-subtle); font-family: var(--font-display); font-weight: 600; font-size: 0.75rem; cursor: pointer; }
  .board-automerge[data-on="true"] { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  .board-automerge:disabled { opacity: 0.6; }
  .board-title { color: var(--text); font-size: 0.85rem; overflow-wrap: anywhere; }
  .board-title:hover { color: var(--accent); }
  .board-chips { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .board-model-plan { font-family: var(--font-display); font-size: 0.7rem; color: var(--text-secondary); overflow-wrap: anywhere; }
  .board-repo { display: inline-block; padding: 0.1rem 0.45rem; border: 1px solid var(--border); border-radius: 12px; font-size: 0.7rem; color: var(--text-secondary); white-space: nowrap; }
  .board-repo-unassigned { border-color: var(--warning); color: var(--warning); }
  .board-card .label-chip { font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 12px; display: inline-block; }
  .board-move { width: 100%; box-sizing: border-box; background: var(--btn-bg); color: var(--text); border: 1px solid var(--border-hover); border-radius: 4px; padding: 0.25rem 0.4rem; font-family: inherit; font-size: 0.75rem; min-height: 36px; cursor: pointer; }
  .board-move option { background: var(--bg-secondary); color: var(--text); }
  .board-toolbar { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
  .board-toolbar h2 { margin: 0; }
  .board-toolbar .trigger-btn { min-height: 36px; }
  .board-tray { margin-top: 0.6rem; border: 1px dashed var(--border-hover); border-radius: 6px; background: var(--bg-secondary); }
  .board-tray-head { font-family: var(--font-display); font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-secondary); margin: 0; padding: 0.55rem 0.6rem; border-bottom: 1px dashed var(--border); }
  .board-tray-body { color: var(--text-subtle); font-size: 0.8rem; }
  .board-chip-ci { font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 12px; display: inline-block; border: 1px solid var(--danger); color: var(--danger); }
  .board-chip-req { font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 12px; display: inline-block; border: 1px solid var(--border); color: var(--text-secondary); }
  /* Tablet: the groups still stack, but each group's columns (three at most)
     sit side by side, so nothing side-scrolls. */
  @media (min-width: 768px) {
    .board-group-cols { flex-direction: row; align-items: flex-start; }
    .board-group-cols > .board-col { flex: 1 1 0; min-width: 0; }
    .board-group-derived { display: none; }
    .board-col-head { pointer-events: none; }
    .board-col-head::after { display: none; }
    .board-move { min-height: 30px; }
    .board-automerge { min-width: 30px; min-height: 30px; }
  }
  /* Desktop: the groups, and Blocked between them, sit in one horizontally
     scrolling row. */
  @media (min-width: 1024px) {
    .board { flex-direction: row; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 0.5rem; align-items: flex-start; }
    .board-group { flex: 1 1 auto; }
    .board-col, .board-group-cols > .board-col { flex: 1 1 0; min-width: 13rem; max-width: 22rem; }
  }
`;

/**
 * The labels rendered as chips: Priority and Automerge already have their own
 * mark on the card, and the lifecycle labels are what the column already shows.
 */
function chipLabels(card: BoardCard): string[] {
  return card.labels.filter((l) => l !== LABELS.priority && l !== LABELS.automerge && !isStateLabel(l));
}

/**
 * The chips a PR open card carries from its open rows, so the PRs that need a
 * person do not hide among the ones mid-review: `Manual Action`, `Claws
 * Problematic` and `Needs LGTM` as the label chips they mirror, and a plain
 * "CI failing" chip. Each at most once, however many rows carry it.
 */
function prChips(card: BoardCard): string {
  const prs = card.flight?.openPrs ?? [];
  const chips: string[] = [];
  if (prs.some((pr) => pr.stage === "manual-action")) chips.push(specLabelChip(LABELS.manualAction));
  if (prs.some((pr) => pr.stage === "problematic")) chips.push(specLabelChip(LABELS.problematic));
  if (prs.some((pr) => pr.stage === "ci-failing")) chips.push(`<span class="board-chip-ci">CI failing</span>`);
  if (prs.some((pr) => pr.needsHumanReview)) chips.push(specLabelChip(LABELS.needsLgtm));
  return chips.join("");
}

/**
 * What the card's flight allows, as the client reads it off `data-in-flight`:
 * `task` for a running implementer, `pr` for open PR rows and no running
 * implementer, or absent. The implementer wins because it outranks `Refined`
 * in `columnFor`, which leaves such a card fewer reachable columns.
 */
function inFlight(card: BoardCard): "task" | "pr" | undefined {
  if (card.flight?.implementing) return "task";
  if ((card.flight?.openPrs.length ?? 0) > 0) return "pr";
  return undefined;
}

/**
 * The board's compact Automerge toggle — `M` for "merge"; `A` would read as
 * the Approved column the card may sit in. Omitted for an unassigned card (no
 * repository to label) and in Done (nothing left to merge). Optimistic on the
 * client (`src/client/issue-board.ts`): `data-on` flips immediately and reverts
 * only if the server refuses.
 */
function automergeToggle(card: BoardCard, column: BoardColumn): string {
  if (!card.repo || column === "done") return "";
  const openPrs = card.flight?.openPrs ?? [];
  const on = card.labels.includes(LABELS.automerge) || openPrs.some((pr) => !!pr.mergeApprovedAt);
  const shortRef = shortIssueRef(card.ref);
  // With an open PR, `POST /board/automerge` approves that PR's merge; with
  // none, labelling the issue only decides the *next* PR Claws opens for it.
  const scope = openPrs.length === 0 ? " (applies to the next PR Claws opens)" : "";
  const title = on
    ? `Automerge on${scope} — Claws merges the PR on green CI and a clean review; click to turn off`
    : `Automerge off${scope} — click to apply`;
  return `<button type="button" class="board-automerge" draggable="false" data-on="${on}" aria-pressed="${on}" aria-label="Automerge for #${escapeHtml(shortRef)}" title="${escapeHtml(title)}">M</button>`;
}

/**
 * How long a card may sit in a column before its age chip turns to the warning
 * colour. Blocked and Done never go stale: waiting is what they are for.
 */
const HOUR_MS = 60 * 60 * 1000;
const STALE_AFTER_MS: Partial<Record<BoardColumn, number>> = {
  "ideas": 3 * 24 * HOUR_MS,
  "planning": 24 * HOUR_MS,
  "awaiting-plan-review": 24 * HOUR_MS,
  "approved": 24 * HOUR_MS,
  "implementing": 3 * 24 * HOUR_MS,
  "pr-open": 3 * 24 * HOUR_MS,
  "awaiting-merge": 3 * 24 * HOUR_MS,
};

/**
 * How long the card has been in its column, as a small chip in the head row.
 * A forge card has no stored column timestamp, so it shows the age of its last
 * activity instead, prefixed `~` and titled to say so. Nothing when the card
 * has neither timestamp.
 */
function ageChip(card: BoardCard, column: BoardColumn): string {
  const approx = !card.stageSince;
  const since = card.stageSince ?? card.updatedAt;
  const text = since ? formatCompactAge(since) : "";
  if (!since || !text) return "";
  const threshold = STALE_AFTER_MS[column];
  const stale = threshold !== undefined && Date.now() - Date.parse(since) > threshold;
  const relative = formatRelativeTime(since);
  const columnTitle = BOARD_COLUMNS.find((col) => col.id === column)!.title;
  const title = approx
    ? `Last activity ${relative}; Claws does not record when a forge issue entered this column`
    : `In ${columnTitle} for ${relative.replace(/ ago$/, "")} (since ${since})`;
  return `<span class="board-age" data-stale="${stale}" title="${escapeHtml(title)}">${approx ? "~" : ""}${escapeHtml(text)}</span>`;
}

function repoChip(card: BoardCard): string {
  if (!card.repo) {
    return `<span class="board-repo board-repo-unassigned" title="${escapeHtml(NO_REPO_WARNING)}">unassigned</span>`;
  }
  return `<span class="board-repo" title="${escapeHtml(card.repo)}">${escapeHtml(repoShortName(card.repo))}</span>`;
}

/**
 * The columns a card may be moved to: never a derived column (Implementing,
 * PR open, Awaiting merge), which no label change can produce — the server
 * refuses them with a 409 either way, and not offering them keeps the touch
 * control honest.
 *
 * An *unassigned* card (no repository) is offered only Ideas and Done, the two
 * columns `columnFor` can ever put it in: it takes a move's labels and stays in
 * Ideas, so every other destination is a guaranteed `UNASSIGNED_REJECTION`
 * 409. This select is the whole touch and keyboard path, so offering them would
 * make picking one and watching the card snap back the only way to find out.
 *
 * A card in flight is offered only what outranks its flight in `columnFor`, for
 * the same reason — no move touches the task or the PR: Blocked and Done for a
 * running implementer (`task`), and Approved as well for open PR rows (`pr`).
 * Keyed off the card's flight rather than its column because the flight is
 * sticky across board moves: a card the client has since dragged to Approved
 * still has its PR open.
 *
 * Backlog (#3293) is offered after the columns — a destination, not a column —
 * under the same two filters: an unassigned card takes the label and stays in
 * Ideas, and a card in flight is refused by `backlogRefusal`.
 *
 * The card's current column is rendered but `hidden`, rather than omitted, so
 * that a card the client script has since moved still has an option to come
 * back to (the script re-hides whichever column the card now sits in). The
 * filters above *omit*, which is what makes them stick: `syncMoveSelect` walks
 * the options that exist and could un-hide one, but cannot bring back one that
 * was never rendered.
 */
function moveSelect(card: BoardCard, column: BoardColumn, flight: "task" | "pr" | undefined): string {
  const options = BOARD_COLUMNS
    .filter((col) => !col.derived)
    .filter((col) => !!card.repo || col.id === "ideas" || col.id === "done")
    .filter((col) => !flight || !card.repo || col.id === "blocked" || col.id === "done" || (flight === "pr" && col.id === "approved"))
    .map((col) => `<option value="${col.id}"${col.id === column ? " hidden" : ""}>${escapeHtml(col.title)}</option>`)
    .join("")
    + (card.repo && !flight ? `<option value="${BACKLOG_DESTINATION}">Backlog</option>` : "");
  // `draggable="false"`: the card around it is the drag source, and a form
  // control inside a draggable ancestor is historically unreliable in Firefox —
  // the drag gesture pre-empts the control's own pointer handling, and this
  // select is the whole touch/accessible path for the feature.
  return `<select class="board-move" draggable="false" aria-label="Move #${escapeHtml(shortIssueRef(card.ref))} to another column">
        <option value="" selected>Move to…</option>${options}
      </select>`;
}

function boardCard(card: BoardCard, column: BoardColumn): string {
  const priority = card.labels.includes(LABELS.priority)
    ? `<span class="board-priority" title="${escapeHtml(LABELS.priority)}">${escapeHtml(LABELS.priority)}</span>`
    : "";
  const flight = inFlight(card);
  // `data-closed` outlives the render: the client refuses to drag a closed
  // *forge* card back out of Done, since the façade has no forge reopen.
  // `data-in-flight` likewise carries server state onto the card for the
  // client's pre-flight: an open PR can sit outside the derived columns
  // (Refined/Blocked outrank it), so the client can't derive it from `column`.
  const shortRef = shortIssueRef(card.ref);
  const fullRef = String(card.ref);
  const refTitle = shortRef !== fullRef ? ` title="${escapeHtml(fullRef)}"` : "";
  return `<article class="board-card" draggable="true" data-repo="${escapeHtml(card.repo)}" data-ref="${escapeHtml(fullRef)}" data-column="${column}"${card.closed ? ` data-closed="true"` : ""}${flight ? ` data-in-flight="${flight}"` : ""}>
      <div class="board-card-head">
        <a class="board-ref" href="${escapeHtml(card.url)}"${refTitle}>#${escapeHtml(shortRef)}</a>${ageChip(card, column)}
        ${priority}${automergeToggle(card, column)}
      </div>
      <a class="board-title" href="${escapeHtml(card.url)}">${escapeHtml(card.title)}</a>
      <div class="board-chips">${repoChip(card)}${requirementsChip(card, column)}${column === "pr-open" ? prChips(card) : ""}${chipLabels(card).map(specLabelChip).join("")}</div>${card.plan ? `
      ${planPreviewBlock(card.plan, "board-plan")}` : ""}${card.modelPlan ? `
      <div class="board-model-plan" title="Model plan set by an operator">${escapeHtml(card.modelPlan)}</div>` : ""}
      ${moveSelect(card, column, flight)}
    </article>`;
}

/**
 * A card in Ideas says whether the requirements writer has produced a record
 * yet, and which version — what the operator reads before promoting it.
 */
function requirementsChip(card: BoardCard, column: BoardColumn): string {
  if (column !== "ideas" || card.requirementsVersion === undefined) return "";
  const text = card.requirementsVersion === null ? "no requirements yet" : `requirements v${card.requirementsVersion}`;
  return `<span class="board-chip-req">${escapeHtml(text)}</span>`;
}

/** The Repository filter: no visible caption, so "All repositories" names it. */
function repoSelect(options: string[], selected: string): string {
  const opts = options
    .map((v) => `<option value="${escapeHtml(v)}"${v === selected ? " selected" : ""}>${escapeHtml(repoShortName(v))}</option>`)
    .join("");
  return `<select class="form-select" name="repo" aria-label="Repository">
        <option value=""${selected === "" ? " selected" : ""}>All repositories</option>${opts}
      </select>`;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/**
 * The options the Repository select offers: every managed repository, so the
 * filter can always be widened again from the page it produced — plus the
 * active value even when nothing matches it, or a `?repo=` naming a quiet
 * repository would render as "All repositories" and hide that the board is
 * filtered at all.
 */
function filterOptions(values: string[], active: string): string[] {
  const options = sortedUnique(values);
  if (active && !options.includes(active)) options.push(active);
  return options;
}

/** `GET /board` — every open issue across every managed repository, by column. */
export function buildBoardPage(view: BoardPageView, theme: Theme): string {
  const repoOptions = filterOptions(view.repoOptions, view.repoFilter);

  const visible = view.cards.filter((c) => !view.repoFilter || c.repo === view.repoFilter);

  // Priority to the top of every column: the server hands cards over in repo
  // order, so without this the mark on the card means nothing on a column
  // taller than the viewport. Within each group — Priority, then ordinary —
  // the most recently updated card leads; a card with no `updatedAt` sorts to
  // the bottom of its group. The sort is stable, so ties keep arrival order.
  const ordered = [...visible].sort((a, b) =>
    Number(b.labels.includes(LABELS.priority)) - Number(a.labels.includes(LABELS.priority))
    || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

  const byColumn = new Map<BoardColumn, string[]>(BOARD_COLUMNS.map((col) => [col.id, []]));
  for (const card of ordered) {
    const column = columnFor({
      labels: card.labels,
      closed: card.closed,
      unassigned: !card.repo,
      lifecycle: card.lifecycle,
      implementing: card.flight?.implementing,
      openPrs: card.flight?.openPrs,
    });
    // The route leaves backlog cards out already; this is defensive.
    if (column === BACKLOG_DESTINATION) continue;
    byColumn.get(column)!.push(boardCard(card, column));
  }

  type Column = (typeof BOARD_COLUMNS)[number];
  const columnHtml = (col: Column): string => {
    const cards = byColumn.get(col.id)!;
    const kind = col.derived ? " board-col-derived" : col.gate ? " board-col-gate" : "";
    return `<details class="board-col${kind}" data-column="${col.id}" open aria-label="${escapeHtml(col.title)}">
      <summary class="board-col-head" title="${escapeHtml(col.hint)}"><h3 class="board-col-title">${escapeHtml(col.title)}</h3> <span class="board-col-count" data-count="${col.id}">${cards.length}</span></summary>
      <div class="board-col-body" data-column="${col.id}">${cards.join("\n")}</div>
    </details>`;
  };
  // A group's header counts its cards, and — on a phone, where the client
  // collapses the derived columns — how many of them sit in those.
  const groupHtml = (group: (typeof BOARD_GROUPS)[number], members: Column[]): string => {
    const count = members.reduce((n, col) => n + byColumn.get(col.id)!.length, 0);
    const derived = members.filter((col) => col.derived);
    const derivedCount = derived.reduce((n, col) => n + byColumn.get(col.id)!.length, 0);
    return `<section class="board-group" data-group="${group.id}" aria-label="${escapeHtml(group.title)}">
    <h2 class="board-group-head">${escapeHtml(group.title)} <span class="board-group-count" data-group-count="${group.id}">${count}</span>${derived.length > 0
      ? ` <span class="board-group-derived">· <span data-group-derived="${group.id}">${derivedCount}</span> set by Claws</span>`
      : ""}</h2>
    <div class="board-group-cols">
    ${members.map(columnHtml).join("\n")}
    </div>
    </section>`;
  };
  // Consecutive columns of one group share a section; a column in no group —
  // Blocked, between Building and Landing — stands alone.
  const sections: string[] = [];
  for (let i = 0; i < BOARD_COLUMNS.length;) {
    const groupId = BOARD_COLUMNS[i].group;
    const group = BOARD_GROUPS.find((g) => g.id === groupId);
    if (!group) {
      sections.push(columnHtml(BOARD_COLUMNS[i++]));
      continue;
    }
    const members: Column[] = [];
    while (i < BOARD_COLUMNS.length && BOARD_COLUMNS[i].group === groupId) members.push(BOARD_COLUMNS[i++]);
    sections.push(groupHtml(group, members));
  }
  const columns = sections.join("\n");

  const body = `
  <div class="section">
    <div class="board-toolbar">
      <h2>Board <span>${visible.length}</span></h2>
      <form class="board-filters" method="GET" action="/board">
        ${repoSelect(repoOptions, view.repoFilter)}
        <button class="trigger-btn" type="submit" id="board-filter-submit">Filter</button>
      </form>
      <a class="trigger-btn" id="board-backlog-link" href="/backlog${view.repoFilter ? `?repo=${encodeURIComponent(view.repoFilter)}` : ""}">Backlog (<span id="board-backlog-count">${view.backlogCount}</span>)</a>
    </div>
    ${view.incompleteSources
      ? `<div class="board-status board-warning" id="board-warning" role="status">${escapeHtml(
        `${view.incompleteSources} of the board's sources loaded incompletely — some cards are missing.`)}</div>`
      : ""}
    <div class="board-status" id="board-status" role="status" aria-live="polite"></div>
    <div id="issue-board-surface">
      <div class="board" id="issue-board">${columns}</div>
      <section class="board-tray" aria-label="Backlog">
        <h3 class="board-tray-head">Backlog</h3>
        <div class="board-col-body board-tray-body" data-column="${BACKLOG_DESTINATION}" aria-label="Send to backlog">Drop a card here to send it to the backlog.</div>
      </section>
    </div>
    <p class="refresh-note">Cards are ordered most recently updated first, with Priority cards pinned to the top. Dropping a card applies that column's labels; dropping a card from Ideas into Planning promotes it, approving its latest requirements; dropping it on the Backlog tray takes it off the board until it is promoted from the backlog. The small age on each card is how long it has been in its column; an age marked ~ on a forge issue is its last activity instead. ${escapeHtml(DERIVED_COLUMN_REJECTION)} PR columns are as fresh as the last PR dispatcher tick. Done shows the ${DONE_COLUMN_LIMIT} most recent issues closed in the last ${DONE_WINDOW_DAYS} days.</p>
  </div>`;

  return `<!DOCTYPE html>
${htmlOpenTag(theme, "full")}
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${HEAD_META}
  <title>claws — Board</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}${BOARD_CSS}</style>
</head>
<body>
  ${buildPageHeader(null, theme)}
  ${THEME_SCRIPT}
  ${body}
  ${ISSUE_BOARD_SCRIPT}
</body>
</html>`;
}
