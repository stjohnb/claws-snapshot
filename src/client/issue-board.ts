// Drag-and-drop for the /board kanban page (#3215). Plain DOM, no Alpine: the
// page has no other interactive state, and a drag needs the raw HTML5 events
// anyway. The endpoints (`POST /board/move` `{repo, ref, to}`, `POST
// /board/automerge` `{repo, ref, on}`) and the card's data attributes are
// produced by src/pages/board.ts and parsed by src/server.ts — keep the wire
// format in sync.
//
// Every move is optimistic: the card is put in the target column immediately
// and put *back exactly where it was* if the server *refused* it without
// writing anything (a drop into a derived column is a 409 by design). An answer
// carrying `partial: true` is different — it follows a half-applied move whose
// true column nobody knows, so the card stays put and the message says the
// board may be stale.
// Nothing is re-rendered by a poller here, so the DOM is the only copy of the
// board state.
//
// The Backlog tray under the columns (#3293) is a drop target but not a column:
// a card that lands there is removed from the page.
//
// Each card's `.board-age` chip (how long it has been in its column) is
// rendered by the server and only reset here, to "just moved", on a move the
// server accepted.

// The plan rule is imported rather than copied like the refusals below:
// board-plan-rule.ts imports nothing, so esbuild inlines it into the bundle and
// the pre-flight and the route share one definition.
import { planRefusal } from "../board-plan-rule.js";

// Everything below is scoped to this IIFE: the client tsconfig compiles
// src/client/*.ts as one program of plain scripts, so a top-level `init` here
// would collide with another bundle's.
(function clawsIssueBoard() {
  interface MoveResponse {
    error?: string;
    /** The column the issue is in after the move, as the server computed it. */
    column?: string;
    /** Set by `POST /board/move` alone, on the answers that follow a write. */
    partial?: boolean;
    /** Set only for a move into Closed: why it closed, always `not_planned` from the board. */
    stateReason?: string;
  }

  /**
   * Mirrors `closeReasonLabel` in src/issue-board.ts — duplicated for the same
   * reason as the rejection strings above: a browser bundle imports no server
   * code. issue-board.test.ts pins this copy against the generated bundle.
   */
  function closeReasonLabel(reason: string | undefined): string {
    if (reason === "completed") return "Completed";
    if (reason === "not_planned") return "Not planned";
    return "";
  }

  /** Add or replace the closed card's `.board-chip-reason` span, or remove it when `label` is empty. */
  function setReasonChip(card: HTMLElement, label: string): void {
    const chips = card.querySelector(".board-chips");
    const existing = card.querySelector(".board-chip-reason");
    if (!label) {
      existing?.remove();
      return;
    }
    if (existing) {
      existing.textContent = label;
      return;
    }
    if (!chips) return;
    const span = document.createElement("span");
    span.className = "board-chip-reason";
    span.textContent = label;
    chips.appendChild(span);
  }

  /** Whether the server wrote nothing, so the card can go back exactly where
   *  it was.
   *
   *  Read off the body rather than the status, because the status has more
   *  than one producer and the client cannot tell them apart: Hono's
   *  `app.onError` answers a bare 500 for anything that throws around the
   *  handler — an expired session's middleware first among them — and a proxy
   *  can answer one of its own. Nothing was written in either case, but a
   *  `status === 500` test calls them half-applied moves and strands the card
   *  in a column nothing wrote, which is the direction the whole mechanism
   *  exists to prevent. Only the route writes `partial`, and a body it did not
   *  write parses to `{}` here. */
  function changedNothing(data: MoveResponse): boolean {
    return !data.partial;
  }

  function isNativeRef(ref: string): boolean {
    return ref.toLowerCase().indexOf("clw_") === 0;
  }

  function statusEl(): HTMLElement | null {
    return document.getElementById("board-status");
  }

  function showError(message: string): void {
    const el = statusEl();
    if (el) el.textContent = message;
  }

  function clearError(): void {
    const el = statusEl();
    if (el) el.textContent = "";
  }

  /**
   * A card sent to the backlog leaves the board, and the Backlog tray's count —
   * rendered by the server, since backlog cards are not on the page — gains it.
   */
  function removeToBacklog(card: HTMLElement): void {
    card.remove();
    const count = document.querySelector('[data-count="backlog"]');
    if (count) count.textContent = String((parseInt(count.textContent ?? "", 10) || 0) + 1);
  }

  /** Re-count every column header from the DOM — cheap, and always right. */
  function refreshCounts(root: HTMLElement): void {
    const bodies = root.querySelectorAll<HTMLElement>(".board-col-body");
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i];
      const column = body.dataset["column"];
      // The Backlog tray's count is the server's, not the cards in the DOM.
      if (!column || column === "backlog") continue;
      const count = root.querySelector(`[data-count="${column}"]`);
      if (count) count.textContent = String(body.querySelectorAll(".board-card").length);
    }
    // A group header counts its cards, and how many sit in its derived columns.
    const groups = root.querySelectorAll<HTMLElement>(".board-group");
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const id = group.dataset["group"];
      if (!id) continue;
      const total = root.querySelector(`[data-group-count="${id}"]`);
      if (total) total.textContent = String(group.querySelectorAll(".board-card").length);
      const derived = root.querySelector(`[data-group-derived="${id}"]`);
      if (derived) derived.textContent = String(group.querySelectorAll(`.board-col-derived:not([data-waits="true"]) .board-card`).length);
    }
  }

  /**
   * Put `card` at the top of its group in `target`, mirroring buildBoardPage's
   * (src/pages/board.ts) ordering: a moved card is the freshest update in its
   * column, so it leads its group — the very top for a Priority card, or just
   * below the last Priority card for an ordinary one.
   */
  function placeCard(card: HTMLElement, target: HTMLElement): void {
    if (card.querySelector(".board-priority")) {
      const first = target.firstElementChild;
      if (first && first !== card) target.insertBefore(card, first);
      else if (!first) target.appendChild(card);
    } else {
      const cards = target.querySelectorAll<HTMLElement>(".board-card");
      let placed = false;
      for (let i = 0; i < cards.length; i++) {
        if (cards[i] !== card && !cards[i].querySelector(".board-priority")) {
          target.insertBefore(card, cards[i]);
          placed = true;
          break;
        }
      }
      if (!placed) target.appendChild(card);
    }
    // A card never silently disappears into a collapsed column on a phone.
    const col = target.closest(".board-col");
    if (col instanceof HTMLDetailsElement && !col.open) col.open = true;
  }

  // The three refusals the client can see coming, copied verbatim from
  // issue-board.ts rather than imported — that module pulls in `config.ts`, and
  // `node:fs` with it, which has no place in a browser bundle. issue-board.test.ts
  // pins each copy against the generated bundle, since each suite otherwise
  // asserts only its own and the operator would be told two different things by
  // the pre-flight and the route.
  const DERIVED_COLUMN_REJECTION =
    "Implementing, PR progressing, PR stalled and Awaiting merge follow the issue's running implementer and open PR — open, merge or close the PR instead.";
  // The columns Claws sets from the issue's flight; none is a drop target.
  const DERIVED_COLUMNS = ["implementing", "pr-progressing", "pr-stalled", "awaiting-merge"];
  const UNASSIGNED_REJECTION =
    "Assign this issue to a repository before moving it out of Drafting.";
  const FORGE_REOPEN_REJECTION =
    "The board cannot reopen a forge issue — reopen it on the forge.";

  /**
   * Why a card in `from` cannot reach `to`, or `""` if it can.
   *
   * The one place the board's refusals are enumerated on the client. Every path
   * that can start a move consults it — the select's options, the drag's drop
   * targets, and `moveCard` itself — because a rule applied by only some of
   * them is a rule the operator learns by picking a destination and watching
   * the card snap back. The drag path used to do exactly that: every column was
   * a drop target, so a card could be dropped into a derived column, or an
   * unassigned one into Approved, for a guaranteed 409.
   *
   * Everything it reads is on the card already: `data-repo` (empty for an
   * issue no repository owns), `data-closed`, `data-ref`, `data-in-flight`
   * (`task` for a running implementer, `pr` for an open PR) and
   * `data-has-plan` (Approved and Awaiting plan review need a plan).
   * `POST /board/move` is still the real check — the server's `columnAfterMove`
   * sees state this page cannot, and a card left open goes stale.
   */
  function canReach(card: HTMLElement, from: string, to: string): string {
    // No label change produces a derived column; the running implementer or
    // the open PR does.
    if (DERIVED_COLUMNS.indexOf(to) >= 0) return DERIVED_COLUMN_REJECTION;
    // The flight survives every move, so only what outranks it in `columnFor`
    // lands: Blocked and Done for a running implementer, and Approved as well
    // for an open PR. Backlog outranks both but is refused for work in flight.
    // Read off the card rather than its column: an open PR can sit in Approved
    // or Blocked, and a card dragged there keeps it.
    const flight = card.dataset["inFlight"];
    if (flight && to !== "blocked" && to !== "done" && !(flight === "pr" && to === "approved")) {
      return DERIVED_COLUMN_REJECTION;
    }
    // An unassigned issue takes a move's labels and stays in Drafting, so
    // Drafting and Done are the only columns it can ever be in.
    if (!card.dataset["repo"] && to !== "drafting" && to !== "done") return UNASSIGNED_REJECTION;
    // A forge card this page just closed is still sitting in Done with every
    // other column on offer, but `github.ts` has no forge reopen: the server
    // would apply the labels and leave the issue closed. Only the client knows
    // the card was closed here — a server render never puts one in Done.
    if (from === "done" && to !== "done"
      && card.dataset["closed"] === "true" && !isNativeRef(card.dataset["ref"] ?? "")) {
      return FORGE_REOPEN_REJECTION;
    }
    return planRefusal(to, card.dataset["hasPlan"] === "true") ?? "";
  }

  /**
   * The options a card may still be moved to, once it sits in `column`.
   *
   * Driven by {@link canReach} rather than its own test, so the select offers
   * exactly the destinations the drag path accepts. The card's current column
   * stays rendered but `hidden` — the card has to have something to come back
   * to once the script has moved it.
   */
  function syncMoveSelect(card: HTMLElement, column: string): void {
    const select = card.querySelector<HTMLSelectElement>(".board-move");
    if (!select) return;
    select.value = "";
    for (let i = 0; i < select.options.length; i++) {
      const opt = select.options[i];
      opt.hidden = opt.value !== "" && (opt.value === column || !!canReach(card, column, opt.value));
    }
  }

  /**
   * A drop into Done closes the issue, and for a forge issue that is the one
   * move with no way back from this page: the server render puts no forge card
   * in Done, so it vanishes on the next load. Drag-and-drop misfires, so ask
   * first.
   */
  function confirmClose(card: HTMLElement, to: string): boolean {
    const ref = card.dataset["ref"] ?? "";
    if (to !== "done" || isNativeRef(ref)) return true;
    return window.confirm(`Close #${ref}? Dropping a forge issue into Closed closes it as not planned, and the board cannot reopen it.`);
  }

  /**
   * Restart a moved card's age chip. `<1m` mirrors what `formatCompactAge` in
   * src/pages/layout.ts renders for a fresh timestamp — duplicated for the same
   * reason as the rejection strings above.
   */
  function resetAge(card: HTMLElement): void {
    const age = card.querySelector<HTMLElement>(".board-age");
    if (!age) return;
    age.textContent = "<1m";
    age.dataset["stale"] = "false";
    age.title = "Just moved";
  }

  async function moveCard(card: HTMLElement, target: HTMLElement): Promise<void> {
    const root = document.getElementById("issue-board");
    const to = target.dataset["column"];
    const from = card.dataset["column"];
    // `busy` also guards against a second move while the first is in flight:
    // two overlapping moves out of one column invalidate each other's
    // remembered position.
    if (!root || !to || !from || to === from || card.dataset["busy"]) return;
    const refusal = canReach(card, from, to);
    if (refusal) {
      showError(refusal);
      syncMoveSelect(card, from);
      return;
    }
    if (!confirmClose(card, to)) return;

    // Where to put the card back if the server says no.
    const originParent = card.parentElement;
    const originNext = card.nextElementSibling;

    clearError();
    placeCard(card, target);
    card.dataset["column"] = to;
    card.dataset["busy"] = "true";
    refreshCounts(root);

    let reverted = false;
    const revert = (message: string): void => {
      // Only ever once: a revert that threw must not be retried from the catch
      // below, or the failure escapes as an unhandled rejection with the card
      // left in the wrong column and no reason on screen.
      if (reverted) return;
      reverted = true;
      // The remembered sibling may itself have been moved or removed since —
      // `insertBefore` throws when it is no longer a child of `originParent`.
      if (originParent) {
        if (originNext && originNext.parentElement === originParent) originParent.insertBefore(card, originNext);
        else originParent.appendChild(card);
      }
      card.dataset["column"] = from;
      syncMoveSelect(card, from);
      refreshCounts(root);
      showError(message);
    };

    try {
      const res = await fetch("/board/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: card.dataset["repo"] ?? "", ref: card.dataset["ref"] ?? "", to }),
      });
      const data = (await res.json().catch(() => ({}))) as MoveResponse;
      if (!res.ok || data.error) {
        const message = data.error ?? `Move failed (HTTP ${res.status})`;
        if (changedNothing(data)) revert(message);
        // A half-applied move: reverting would be as wrong as leaving the card
        // where it was dropped, and only a reload can say which column it is in.
        else {
          syncMoveSelect(card, to);
          showError(`${message}. Reload the board to see where the issue is.`);
        }
      } else {
        // The route 409s any move that would land somewhere other than the
        // drop target, with one exception: Drafting and Requirements review
        // are the same move, and the issue's requirements state picks which
        // of the two it lands in. So follow the reported column — the DOM
        // then tracks the server for any column it reached.
        const landed = data.column && data.column !== to
          ? root.querySelector<HTMLElement>(`.board-col-body[data-column="${data.column}"]`)
          : null;
        if (landed) {
          placeCard(card, landed);
          card.dataset["column"] = data.column!;
          refreshCounts(root);
        }
        const column = card.dataset["column"] ?? to;
        if (column === "backlog") {
          removeToBacklog(card);
          refreshCounts(root);
          return;
        }
        resetAge(card);
        // Done means closed, and dragging back out of it reopens — so the flag
        // the forge guard reads has to follow the card, not the render. The
        // reason chip follows the same way: a native reopen leaves the card
        // holding a stale "Not planned" otherwise.
        if (column === "done") {
          card.dataset["closed"] = "true";
          setReasonChip(card, closeReasonLabel(data.stateReason));
        } else {
          delete card.dataset["closed"];
          setReasonChip(card, "");
        }
        syncMoveSelect(card, column);
      }
    } catch (err) {
      revert(err instanceof Error ? err.message : String(err));
    } finally {
      delete card.dataset["busy"];
    }
  }

  /**
   * Mirrors `automergeToggle`'s title text in src/pages/board.ts — duplicated
   * for the same reason as the rejection strings above: a browser bundle pulls
   * in no server code, so the wording is kept here rather than imported.
   */
  function automergeTitle(on: boolean, hasOpenPr: boolean): string {
    const scope = hasOpenPr ? "" : " (applies to the next PR Claws opens)";
    return on
      ? `Automerge on${scope} — Claws merges the PR on green CI and a clean review; click to turn off`
      : `Automerge off${scope} — click to apply`;
  }

  interface AutomergeResponse {
    error?: string;
    on?: boolean;
  }

  /**
   * The board's `M` toggle (`POST /board/automerge`, `{repo, ref, on}`).
   * Optimistic like a move, but it never touches the card's column: it flips
   * in place and reverts in place on a refusal or a failed request.
   */
  async function toggleAutomerge(button: HTMLButtonElement): Promise<void> {
    if (button.disabled) return;
    const card = button.closest<HTMLElement>(".board-card");
    if (!card) return;
    const repo = card.dataset["repo"] ?? "";
    const ref = card.dataset["ref"] ?? "";
    const hasOpenPr = card.dataset["inFlight"] === "pr";
    const next = button.dataset["on"] !== "true";

    const setState = (on: boolean): void => {
      button.dataset["on"] = String(on);
      button.setAttribute("aria-pressed", String(on));
      button.title = automergeTitle(on, hasOpenPr);
    };

    clearError();
    setState(next);
    button.disabled = true;
    try {
      const res = await fetch("/board/automerge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, ref, on: next }),
      });
      const data = (await res.json().catch(() => ({}))) as AutomergeResponse;
      if (!res.ok || data.error) {
        setState(!next);
        showError(data.error ?? `Automerge update failed (HTTP ${res.status})`);
      }
    } catch (err) {
      setState(!next);
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      button.disabled = false;
    }
  }

  // The dragged card is held here rather than in dataTransfer: Safari exposes
  // nothing but the type list during dragover, so a drop target cannot read an id
  // back out of it, and the board only ever drags one card at a time.
  let dragged: HTMLElement | null = null;

  /** Apply a filter as soon as a select changes. The server owns the cut (the
   *  Done cap and the incomplete-sources warning depend on it), so this
   *  re-submits the GET form rather than hiding cards; the Filter button is
   *  rendered for the no-JS path and hidden here. */
  function initFilters(): void {
    const form = document.querySelector<HTMLFormElement>("form.board-filters");
    if (!form) return;
    const submit = document.getElementById("board-filter-submit");
    if (submit) submit.hidden = true;
    form.addEventListener("change", () => form.requestSubmit());
  }

  /**
   * The column body a drag event is over: the body itself, or — for a collapsed
   * column or the Backlog tray, whose body is hidden — the body inside the
   * `<details>` whose summary the pointer is on. Which columns start open is
   * the server's call (`data-waits`), at every width; the script never folds.
   */
  function dropBody(target: EventTarget | null): HTMLElement | null {
    const el = target as HTMLElement | null;
    if (!el || typeof el.closest !== "function") return null;
    return el.closest<HTMLElement>(".board-col-body")
      ?? el.closest("details.board-col, details.board-tray")?.querySelector<HTMLElement>(".board-col-body")
      ?? null;
  }

  function init(): void {
    initFilters();
    const root = document.getElementById("issue-board");
    if (!root) return;
    // Drag and select events are taken on the wrapper that also holds the
    // Backlog tray, so the tray is a drop target like any column body.
    const surface = document.getElementById("issue-board-surface") ?? root;

    surface.addEventListener("dragstart", (ev: Event) => {
      const card = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".board-card");
      if (!card) return;
      dragged = card;
      card.classList.add("dragging");
      // Firefox starts no drag at all unless some data is set.
      (ev as DragEvent).dataTransfer?.setData("text/plain", card.dataset["ref"] ?? "");
      const dt = (ev as DragEvent).dataTransfer;
      if (dt) dt.effectAllowed = "move";
    });

    surface.addEventListener("dragend", () => {
      // By query, not through `dragged`: `drop` fires first and nulls it, so a
      // dropped card would keep the .dragging styling for good.
      const dragging = surface.querySelectorAll(".dragging");
      for (let i = 0; i < dragging.length; i++) dragging[i].classList.remove("dragging");
      dragged = null;
      const over = surface.querySelectorAll(".drag-over");
      for (let i = 0; i < over.length; i++) over[i].classList.remove("drag-over");
    });

    surface.addEventListener("dragover", (ev: Event) => {
      const body = dropBody(ev.target);
      if (!body || !dragged) return;
      // Without `preventDefault` the column is not a drop target at all: the
      // cursor shows "no drop" and `drop` never fires. That is the same lesson
      // the select teaches by hiding the option, taught with the same rule.
      if (canReach(dragged, dragged.dataset["column"] ?? "", body.dataset["column"] ?? "")) return;
      ev.preventDefault();
      const dt = (ev as DragEvent).dataTransfer;
      if (dt) dt.dropEffect = "move";
      body.classList.add("drag-over");
    });

    surface.addEventListener("dragleave", (ev: Event) => {
      const body = dropBody(ev.target);
      if (body && !body.contains((ev as DragEvent).relatedTarget as Node | null)) body.classList.remove("drag-over");
    });

    surface.addEventListener("drop", (ev: Event) => {
      const body = dropBody(ev.target);
      if (!body) return;
      ev.preventDefault();
      body.classList.remove("drag-over");
      const card = dragged;
      dragged = null;
      if (card) void moveCard(card, body);
    });

    // The Automerge toggle is a plain click, not a drag or a select change —
    // stopped from bubbling so it neither starts a drag (the card around it is
    // `draggable="true"`) nor is read by anything else listening on `surface`.
    surface.addEventListener("click", (ev: Event) => {
      const button = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>(".board-automerge");
      if (!button) return;
      ev.preventDefault();
      ev.stopPropagation();
      void toggleAutomerge(button);
    });

    // The touch path: dragging is a mouse gesture, so every card also carries a
    // plain <select> (see docs/DESIGN.md on not shipping hover-only actions).
    surface.addEventListener("change", (ev: Event) => {
      const target = ev.target as HTMLElement | null;
      const select = target as HTMLSelectElement | null;
      if (!select || !select.classList.contains("board-move") || !select.value) return;
      const card = select.closest<HTMLElement>(".board-card");
      const body = surface.querySelector<HTMLElement>(`.board-col-body[data-column="${select.value}"]`);
      select.value = "";
      if (card && body) void moveCard(card, body);
    });

    for (const card of Array.from(root.querySelectorAll<HTMLElement>(".board-card"))) {
      syncMoveSelect(card, card.dataset["column"] ?? "");
    }

    // A long-press that starts a drag which goes nowhere is worse than no drag
    // at all on a touch device — the select is the whole touch path already.
    if (typeof window.matchMedia === "function" && window.matchMedia("(hover: none) and (pointer: coarse)").matches) {
      for (const card of Array.from(root.querySelectorAll<HTMLElement>(".board-card"))) {
        card.draggable = false;
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Exposed for the jsdom unit test, which drives a move without a real drag.
  (window as unknown as { clawsBoardInit: () => void }).clawsBoardInit = init;
})();
