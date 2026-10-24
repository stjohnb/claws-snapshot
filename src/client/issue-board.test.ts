// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./issue-board.js";

/**
 * The board markup src/pages/board.ts produces, cut down to five columns.
 * Approved, In progress and Closed start collapsed, as the server renders
 * them; Drafting is open, as an operator who expanded it to drag from it left it.
 *
 * `repo: ""` renders the card as an unassigned native issue, which `columnFor`
 * keeps in Drafting whatever labels it is given. The `pr-progressing` option is
 * one the server never renders — `moveSelect` filters out every derived column —
 * but the client applies the rule itself rather than depending on that, so the
 * fixture carries it.
 *
 * The card has a plan unless `hasPlan: false`, so Approved is reachable by
 * default; the plan rule has tests of its own.
 */
function renderBoard(opts: { repo?: string; inFlight?: "task" | "pr"; hasPlan?: boolean } = {}): void {
  const repo = opts.repo ?? "org/repo";
  const flight = (opts.inFlight ? ` data-in-flight="${opts.inFlight}"` : "") + (opts.hasPlan === false ? "" : ` data-has-plan="true"`);
  document.body.innerHTML = `
    <div class="board-status" id="board-status"></div>
    <div class="board" id="issue-board">
      <details class="board-col" data-column="drafting" open>
        <summary class="board-col-head">Drafting <span data-count="drafting">1</span></summary>
        <div class="board-col-body" data-column="drafting">
          <article class="board-card" draggable="true" data-repo="${repo}" data-ref="42" data-column="drafting"${flight}>
            <div class="board-chips"></div>
            <select class="board-move">
              <option value="" selected>Move to…</option>
              <option value="drafting" hidden>Drafting</option>
              <option value="approved">Approved</option>
              <option value="in-progress">In progress</option>
              <option value="done">Closed</option>
            </select>
          </article>
        </div>
      </details>
      <details class="board-col" data-column="requirements-review" data-waits="true" open>
        <summary class="board-col-head">Requirements review <span data-count="requirements-review">0</span></summary>
        <div class="board-col-body" data-column="requirements-review"></div>
      </details>
      <details class="board-col" data-column="approved">
        <summary class="board-col-head">Approved <span data-count="approved">0</span></summary>
        <div class="board-col-body" data-column="approved"></div>
      </details>
      <details class="board-col board-col-derived" data-column="in-progress">
        <summary class="board-col-head">In progress <span data-count="in-progress">0</span></summary>
        <div class="board-col-body" data-column="in-progress"></div>
      </details>
      <details class="board-col" data-column="done">
        <summary class="board-col-head">Closed <span data-count="done">0</span></summary>
        <div class="board-col-body" data-column="done"></div>
      </details>
    </div>`;
  (window as unknown as { clawsBoardInit: () => void }).clawsBoardInit();
}

function card(): HTMLElement {
  return document.querySelector<HTMLElement>(".board-card")!;
}

function moveTo(column: string): void {
  const select = document.querySelector<HTMLSelectElement>(".board-move")!;
  select.value = column;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function countOf(column: string): string {
  return document.querySelector(`[data-count="${column}"]`)!.textContent ?? "";
}

function columnBody(column: string): HTMLElement {
  return document.querySelector<HTMLElement>(`.board-col-body[data-column="${column}"]`)!;
}

/** Another card in `column`, so ordering and placement have something to sit against. */
function addCard(column: string, ref: string, opts: { priority?: boolean } = {}): HTMLElement {
  const card = document.createElement("article");
  card.className = "board-card";
  card.dataset["ref"] = ref;
  card.dataset["repo"] = "org/repo";
  card.dataset["column"] = column;
  if (opts.priority) card.innerHTML = `<span class="board-priority">Priority</span>`;
  columnBody(column).appendChild(card);
  return card;
}

function refsIn(column: string): string[] {
  return [...columnBody(column).querySelectorAll<HTMLElement>(".board-card")].map((c) => c.dataset["ref"] ?? "");
}

describe("the board's move select", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    renderBoard();
  });

  it("posts the move and leaves the card in its new column", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    moveTo("approved");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/board/move");
    expect(JSON.parse(String(init.body))).toEqual({ repo: "org/repo", ref: "42", to: "approved" });
    await vi.waitFor(() => expect(card().dataset["column"]).toBe("approved"));
    expect(card().parentElement?.dataset["column"]).toBe("approved");
    expect(countOf("drafting")).toBe("0");
    expect(countOf("approved")).toBe("1");
  });

  // The age chip is server-rendered; a move the server accepted restarts it.
  it("resets the card's age chip on a successful move", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 })));
    card().insertAdjacentHTML("afterbegin", `<span class="board-age" data-stale="true" title="In Drafting for 5d">5d</span>`);

    moveTo("approved");

    await vi.waitFor(() => expect(card().querySelector(".board-age")!.textContent).toBe("<1m"));
    const age = card().querySelector<HTMLElement>(".board-age")!;
    expect(age.dataset["stale"]).toBe("false");
    expect(age.title).toBe("Just moved");
  });

  it("leaves the age chip alone when the server refuses the move", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 409 })));
    card().insertAdjacentHTML("afterbegin", `<span class="board-age" data-stale="true" title="In Drafting for 5d">5d</span>`);

    moveTo("approved");

    await vi.waitFor(() => expect(document.getElementById("board-status")!.textContent).toBe("nope"));
    expect(card().querySelector(".board-age")!.textContent).toBe("5d");
  });

  // A card must never silently disappear into a column collapsed on a phone.
  it("opens the destination column's <details> on a move into it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 })));
    const approved = document.querySelector<HTMLDetailsElement>(`details.board-col[data-column="approved"]`)!;
    approved.open = false;

    moveTo("approved");

    await vi.waitFor(() => expect(card().parentElement?.dataset["column"]).toBe("approved"));
    expect(approved.open).toBe(true);
  });

  // The 409 the server returns for a drop into In progress, and every other
  // refusal, has to put the card back exactly where it was.
  it("reverts the card and shows the error when the server refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "In progress and Awaiting merge follow the issue's running implementer and open PR" }), { status: 409 })));

    moveTo("approved");

    await vi.waitFor(() => expect(document.getElementById("board-status")?.textContent).toContain("open PR"));
    expect(card().dataset["column"]).toBe("drafting");
    expect(card().parentElement?.dataset["column"]).toBe("drafting");
    expect(countOf("drafting")).toBe("1");
    expect(countOf("approved")).toBe("0");
  });

  it("reverts when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));

    moveTo("approved");

    await vi.waitFor(() => expect(document.getElementById("board-status")?.textContent).toBe("offline"));
    expect(card().parentElement?.dataset["column"]).toBe("drafting");
  });

  // The remembered sibling can be gone by the time the server answers, and an
  // insertBefore against a detached node throws: the revert has to fall back to
  // appending rather than escape as an unhandled rejection.
  it("reverts to the end of the origin column when its remembered neighbour has moved", async () => {
    const drafting = document.querySelector<HTMLElement>(`.board-col-body[data-column="drafting"]`)!;
    const neighbour = document.createElement("article");
    neighbour.className = "board-card";
    drafting.appendChild(neighbour);
    // The card being moved now remembers `neighbour` as its next sibling.
    drafting.insertBefore(card(), neighbour);

    let release: (() => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response(JSON.stringify({ error: "nope" }), { status: 409 });
    }));

    moveTo("approved");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    neighbour.remove();
    release!();

    await vi.waitFor(() => expect(document.getElementById("board-status")?.textContent).toBe("nope"));
    expect(card().parentElement?.dataset["column"]).toBe("drafting");
    expect(countOf("drafting")).toBe("1");
    expect(countOf("approved")).toBe("0");
  });

  it("ignores a second move while the first is still in flight", async () => {
    const fetchMock = vi.fn(async () => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    moveTo("approved");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    moveTo("drafting");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Closing a forge issue from the board is the one move with no way back:
  // only native issues reach the Done column.
  it("asks before dropping a forge card into Done, and does nothing when refused", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmMock);

    moveTo("done");

    expect(confirmMock).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(card().parentElement?.dataset["column"]).toBe("drafting");
  });

  it("does not ask before moving a native card into Done", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);

    card().dataset["ref"] = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    moveTo("done");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(confirmMock).not.toHaveBeenCalled();
  });

  // A move into Closed always records not_planned from the board; the chip
  // tells a dropped issue apart from a shipped one without a reload.
  it("adds the reason chip after a successful move into done", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ result: "ok", column: "done", stateReason: "not_planned" }), { status: 200 })));
    vi.stubGlobal("confirm", vi.fn(() => true));

    moveTo("done");

    await vi.waitFor(() => expect(card().querySelector(".board-chip-reason")?.textContent).toBe("Not planned"));
  });

  // A native reopen leaves Done, so a stale reason chip must not follow the
  // card back into a column that has nothing to do with why it was closed.
  it("removes the reason chip when a card leaves done", async () => {
    card().dataset["ref"] = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    card().dataset["column"] = "done";
    columnBody("done").appendChild(card());
    card().insertAdjacentHTML("beforeend", `<span class="board-chip-reason">Not planned</span>`);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 })));

    moveTo("approved");

    // Both in one `waitFor`: the placement is optimistic and settles before the
    // fetch resolves, so checking it alone would race the chip removal, which
    // only happens once the mocked response comes back.
    await vi.waitFor(() => {
      expect(card().parentElement?.dataset["column"]).toBe("approved");
      expect(card().querySelector(".board-chip-reason")).toBeNull();
    });
  });

  // Defence in depth, not a live case: the route 409s any move that would land
  // somewhere other than the drop target, so a real 200 always reports `to`.
  // The branch exists so the DOM would follow the server rather than the drop
  // if the route ever reported a column it reached instead of refusing.
  it("places the card in the column the server reports", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ result: "ok", column: "drafting" }), { status: 200 })));

    moveTo("approved");

    await vi.waitFor(() => expect(card().parentElement?.dataset["column"]).toBe("drafting"));
    expect(card().dataset["column"]).toBe("drafting");
    expect(countOf("drafting")).toBe("1");
    expect(countOf("approved")).toBe("0");
  });

  // A 503 is the route's "I could not read the issue's state": it comes before
  // any label is written, so the card belongs back where it came from.
  it("puts the card back when the server could not read the issue's state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "Could not read the issue's current state — try again." }), { status: 503 })));

    moveTo("approved");

    await vi.waitFor(() => expect(card().parentElement?.dataset["column"]).toBe("drafting"));
    expect(document.getElementById("board-status")?.textContent).toContain("current state");
  });

  // An expired session makes authMiddleware answer 401 with an HTML
  // meta-refresh body — the status this fetch sees most often, and one the old
  // allowlist of refusals did not name, so every move rendered as applied.
  // Nothing was written, so the card belongs back where it came from.
  it("puts the card back when the session has expired", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("<html><meta http-equiv=\"refresh\"></html>", {
        status: 401,
        headers: { "Content-Type": "text/html" },
      })));

    moveTo("approved");

    await vi.waitFor(() => expect(card().parentElement?.dataset["column"]).toBe("drafting"));
    expect(card().dataset["column"]).toBe("drafting");
    expect(countOf("drafting")).toBe("1");
    expect(countOf("approved")).toBe("0");
    expect(document.getElementById("board-status")?.textContent).toContain("401");
    expect(document.getElementById("board-status")?.textContent).not.toContain("Reload");
  });

  // A 404 is the route's "no such issue" for a native ref the store does not
  // know: nothing was written, so the card belongs back where it came from.
  it("puts the card back when the server does not know the issue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "No such issue" }), { status: 404 })));

    moveTo("approved");

    await vi.waitFor(() => expect(card().parentElement?.dataset["column"]).toBe("drafting"));
    expect(document.getElementById("board-status")?.textContent).toContain("No such issue");
  });

  // `partial` follows a half-applied move: the labels the server did write are
  // unknown to the page, so putting the card back would be as wrong as leaving
  // it where it was dropped.
  it("leaves the card where it was dropped and says the board may be stale on a partial move", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "Failed to remove the Blocked label", partial: true }), { status: 500 })));

    moveTo("approved");

    await vi.waitFor(() => expect(document.getElementById("board-status")?.textContent).toContain("Reload"));
    expect(card().parentElement?.dataset["column"]).toBe("approved");
    expect(card().dataset["column"]).toBe("approved");
  });

  // `/board/move` is not the only producer of a 500 on its URL: Hono's
  // `app.onError` answers a bare one, with a plain-text body, for anything that
  // throws around the handler. Nothing was written, so the card belongs back
  // where it came from — reading the status alone would strand it instead.
  it("puts the card back on a framework 500 that carries no partial marker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("Internal Server Error", { status: 500, headers: { "Content-Type": "text/plain" } })));

    moveTo("approved");

    await vi.waitFor(() => expect(card().parentElement?.dataset["column"]).toBe("drafting"));
    expect(card().dataset["column"]).toBe("drafting");
    expect(countOf("drafting")).toBe("1");
    expect(countOf("approved")).toBe("0");
    expect(document.getElementById("board-status")?.textContent).not.toContain("Reload");
  });

  // `github.ts` has no forge reopen: the server would apply the labels and leave
  // the issue closed, so the card would sit in a column the issue is not in.
  it("refuses to drag a forge card this page closed back out of Done", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));

    moveTo("done");
    await vi.waitFor(() => expect(card().dataset["closed"]).toBe("true"));

    moveTo("approved");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.getElementById("board-status")?.textContent).toContain("cannot reopen a forge issue");
    expect(card().parentElement?.dataset["column"]).toBe("done");
  });

  // The select is the whole touch and keyboard path, so a destination it offers
  // has to be one the card can reach — pages/board.ts applies the same rule to
  // an unassigned card at render time.
  function offeredColumns(): string[] {
    const select = document.querySelector<HTMLSelectElement>(".board-move")!;
    return [...select.options].filter((o) => o.value && !o.hidden).map((o) => o.value);
  }

  it("offers a forge card this page closed no destination but Done", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 })));
    vi.stubGlobal("confirm", vi.fn(() => true));
    expect(offeredColumns()).toEqual(["approved", "done"]);

    moveTo("done");
    await vi.waitFor(() => expect(card().dataset["closed"]).toBe("true"));

    expect(offeredColumns()).toEqual([]);
  });

  // A native issue in Done can be reopened, so it keeps every column on offer.
  it("still offers every column to a closed native card in Done", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 })));
    card().dataset["ref"] = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

    moveTo("done");
    await vi.waitFor(() => expect(card().dataset["closed"]).toBe("true"));

    expect(offeredColumns()).toEqual(["drafting", "approved"]);
  });

  // No label change produces a derived column, so none is ever on offer —
  // the server omits them from the render and the client hides them either way.
  it("never offers a derived column", () => {
    expect(offeredColumns()).not.toContain("in-progress");
  });

  // An unassigned issue takes a move's labels and stays in Drafting, so every
  // other destination is a guaranteed 409.
  it("offers an unassigned card only Drafting and Done", () => {
    renderBoard({ repo: "" });

    expect(offeredColumns()).toEqual(["done"]);
  });

  // No move touches the task or the PR, so only what outranks the flight in
  // `columnFor` is on offer: Approved lands over an open PR but not over a
  // running implementer.
  it("offers a card with a running implementer only what outranks it", () => {
    renderBoard({ inFlight: "task" });

    expect(offeredColumns()).toEqual(["done"]);
  });

  it("offers a card with an open PR Approved as well", () => {
    renderBoard({ inFlight: "pr" });

    expect(offeredColumns()).toEqual(["approved", "done"]);
  });

  it("refuses a move a card's flight overrides without asking the server", () => {
    renderBoard({ inFlight: "task" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    moveTo("approved");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(card().parentElement?.dataset["column"]).toBe("drafting");
    expect(document.getElementById("board-status")!.textContent).toBe(
      "In progress and Awaiting merge follow the issue's running implementer and open PR — open, merge or close the PR instead.");
  });

  // buildBoardPage sorts Priority to the top of every column and the moved
  // card is the freshest update in it, so a moved Priority card leads even a
  // column that already holds one.
  it("puts a moved Priority card above the column's ordinary cards", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 })));
    addCard("approved", "priority-already", { priority: true });
    addCard("approved", "ordinary");
    card().innerHTML += `<span class="board-priority">Priority</span>`;

    moveTo("approved");

    await vi.waitFor(() => expect(refsIn("approved")).toEqual(["42", "priority-already", "ordinary"]));
  });

  // A moved ordinary card is still the freshest update in its group, so it
  // leads the ordinary cards while staying below every Priority card.
  it("puts a moved ordinary card below Priority cards and above other ordinary cards", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 })));
    addCard("approved", "priority-already", { priority: true });
    addCard("approved", "ordinary");

    moveTo("approved");

    await vi.waitFor(() => expect(refsIn("approved")).toEqual(["priority-already", "42", "ordinary"]));
  });
});

// Every issue entering Blocked carries a reason, asked for before anything moves.
describe("a move into Blocked", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    renderBoard();
    document.getElementById("issue-board")!.insertAdjacentHTML("beforeend", `
      <details class="board-col" data-column="blocked" open>
        <summary class="board-col-head">Blocked <span data-count="blocked">0</span></summary>
        <div class="board-col-body" data-column="blocked"></div>
      </details>`);
    card().querySelector("select")!.insertAdjacentHTML("beforeend", `<option value="blocked">Blocked</option>`);
  });

  it.each([
    ["cancelled", null],
    ["left blank", "   "],
  ])("does nothing but say a reason is required when the prompt is %s", (_name, answer) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const promptMock = vi.fn(() => answer);
    vi.stubGlobal("prompt", promptMock);

    moveTo("blocked");

    expect(promptMock).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(card().parentElement?.dataset["column"]).toBe("drafting");
    expect(card().dataset["column"]).toBe("drafting");
    expect(document.getElementById("board-status")!.textContent).toBe("A reason is required to mark an issue Blocked.");
  });

  it("sends the trimmed reason with the move", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "ok", column: "blocked" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("prompt", vi.fn(() => "  Waiting on the vendor "));

    moveTo("blocked");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ repo: "org/repo", ref: "42", to: "blocked", reason: "Waiting on the vendor" });
    await vi.waitFor(() => expect(card().parentElement?.dataset["column"]).toBe("blocked"));
  });

  it("asks for no reason on a move anywhere else", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const promptMock = vi.fn(() => "x");
    vi.stubGlobal("prompt", promptMock);

    moveTo("approved");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(promptMock).not.toHaveBeenCalled();
  });
});

// jsdom carries the HTML5 drag events well enough to drive the handlers: they
// reach for `dataTransfer` only behind a guard.
describe("the board's drag handlers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    renderBoard();
  });

  function fire(el: EventTarget, type: string): void {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  // `drop` nulls the module's dragged-card variable before `dragend` fires, so a
  // cleanup that went through it left every dropped card highlighted for good.
  it("clears the dragging class after a drop", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    fire(card(), "dragstart");
    expect(card().classList.contains("dragging")).toBe(true);

    fire(columnBody("approved"), "drop");
    fire(card(), "dragend");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(card().classList.contains("dragging")).toBe(false);
    expect(card().parentElement?.dataset["column"]).toBe("approved");
  });

  // `confirmClose` is raised from inside the `drop` handler, while the drag is
  // still live — the path where a browser is most likely to treat the dialog
  // differently from the select's, and the one the select-path test above
  // cannot cover.
  it("asks before a forge card is dropped into Done, and does nothing when refused", () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmMock);

    fire(card(), "dragstart");
    fire(columnBody("done"), "drop");

    expect(confirmMock).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(card().parentElement?.dataset["column"]).toBe("drafting");
  });

  it("clears the dragging class when the drag is abandoned", () => {
    fire(card(), "dragstart");
    fire(card(), "dragend");

    expect(card().classList.contains("dragging")).toBe(false);
  });

  /** A column is a drop target only if `dragover` calls `preventDefault`. */
  function dragOver(column: string): boolean {
    const ev = new Event("dragover", { bubbles: true, cancelable: true });
    columnBody(column).dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  // Every column used to be a drop target for every card, so a drop the select
  // refused to offer could still be made by dragging — and answered with a
  // guaranteed 409 and a card snapping back. The drag path reads the same rule
  // the select does.
  it("is not a drop target for a column the card cannot reach", () => {
    fire(card(), "dragstart");

    expect(dragOver("in-progress")).toBe(false);
    expect(columnBody("in-progress").classList.contains("drag-over")).toBe(false);

    expect(dragOver("approved")).toBe(true);
    expect(columnBody("approved").classList.contains("drag-over")).toBe(true);
  });

  /** The summary of `column`'s `<details>` — what the pointer is over on a collapsed column. */
  function summaryOf(column: string): HTMLElement {
    return document.querySelector<HTMLElement>(`details.board-col[data-column="${column}"] > summary`)!;
  }

  // A collapsed column's body is hidden, so the drop lands on its summary.
  it("takes a drop on a collapsed column's summary as a move into it, and opens it", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const approved = document.querySelector<HTMLDetailsElement>(`details.board-col[data-column="approved"]`)!;
    expect(approved.open).toBe(false);

    fire(card(), "dragstart");
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    summaryOf("approved").dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    fire(summaryOf("approved"), "drop");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ to: "approved" });
    expect(card().parentElement?.dataset["column"]).toBe("approved");
    expect(approved.open).toBe(true);
  });

  it("still refuses a drop on a collapsed derived column's summary", () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    fire(card(), "dragstart");
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    summaryOf("in-progress").dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
    fire(summaryOf("in-progress"), "drop");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(card().parentElement?.dataset["column"]).toBe("drafting");
    expect(document.getElementById("board-status")!.textContent).toContain("In progress and Awaiting merge");
  });

  it("is not a drop target for an unassigned card outside Drafting and Done", () => {
    renderBoard({ repo: "" });
    fire(card(), "dragstart");

    expect(dragOver("approved")).toBe(false);
    expect(dragOver("done")).toBe(true);
  });

  // Requirements review needs the writer, which needs a repository: an
  // unassigned card stays in Drafting, so the other requirements column is a
  // guaranteed 409 too.
  it("is not a drop target for an unassigned card in Requirements review", () => {
    renderBoard({ repo: "" });
    document.getElementById("issue-board")!.insertAdjacentHTML("afterbegin", `
      <details class="board-col" data-column="requirements-review" data-waits="true" open>
        <summary class="board-col-head">Requirements review <span data-count="requirements-review">0</span></summary>
        <div class="board-col-body" data-column="requirements-review"></div>
      </details>`);
    (window as unknown as { clawsBoardInit: () => void }).clawsBoardInit();
    fire(card(), "dragstart");

    expect(dragOver("requirements-review")).toBe(false);
  });

  // The forge-reopen rule is the client's alone — a server render never puts a
  // forge card in Done — so the drag path has to apply it too.
  it("is not a drop target once this page has closed a forge card", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 })));
    vi.stubGlobal("confirm", vi.fn(() => true));

    const select = document.querySelector<HTMLSelectElement>(".board-move")!;
    select.value = "done";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(card().dataset["closed"]).toBe("true"));

    fire(card(), "dragstart");
    expect(dragOver("approved")).toBe(false);
  });
});

/**
 * A card in `from` with the plan gates on offer, plus the three columns they
 * sit among, so the plan rule can be read off both the select and the drag.
 */
function renderPlanBoard(from: string, hasPlan: boolean, extraAttrs = ""): void {
  const columns = ["drafting", "planning", "awaiting-plan-review", "approved", "done"];
  const options = columns.map((col) => `<option value="${col}"${col === from ? " hidden" : ""}>${col}</option>`).join("");
  const body = (col: string) => col === from
    ? `<article class="board-card" draggable="true" data-repo="org/repo" data-ref="7" data-column="${col}"${hasPlan ? ` data-has-plan="true"` : ""}${extraAttrs}>
        <select class="board-move"><option value="" selected>Move to…</option>${options}</select>
      </article>`
    : "";
  document.body.innerHTML = `
    <div class="board-status" id="board-status"></div>
    <div class="board" id="issue-board">${columns.map((col) => `
      <details class="board-col" data-column="${col}" open>
        <summary class="board-col-head">${col} <span data-count="${col}">0</span></summary>
        <div class="board-col-body" data-column="${col}">${body(col)}</div>
      </details>`).join("")}
    </div>`;
  (window as unknown as { clawsBoardInit: () => void }).clawsBoardInit();
}

describe("the board's plan rule", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function offered(): string[] {
    const select = document.querySelector<HTMLSelectElement>(".board-move")!;
    return [...select.options].filter((o) => o.value && !o.hidden).map((o) => o.value);
  }

  function dragOver(column: string): boolean {
    card().dispatchEvent(new Event("dragstart", { bubbles: true }));
    const ev = new Event("dragover", { bubbles: true, cancelable: true });
    columnBody(column).dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  it.each(["drafting", "planning"])("offers a planless card in %s neither Approved nor Awaiting plan review", (from) => {
    renderPlanBoard(from, false);

    expect(offered()).not.toContain("approved");
    expect(offered()).not.toContain("awaiting-plan-review");
    expect(offered()).toContain("done");
    expect(dragOver("approved")).toBe(false);
    expect(dragOver("awaiting-plan-review")).toBe(false);
  });

  it("refuses a planless card's move to Approved with the copy, without asking the server", () => {
    renderPlanBoard("drafting", false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    moveTo("approved");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(card().parentElement?.dataset["column"]).toBe("drafting");
    expect(document.getElementById("board-status")!.textContent).toBe(
      "Approved needs a plan — move the issue to Planning first so Claws writes one.");
  });

  it("refuses a planless card's move to Awaiting plan review with the copy", () => {
    renderPlanBoard("planning", false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    moveTo("awaiting-plan-review");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.getElementById("board-status")!.textContent).toBe(
      "Awaiting plan review needs a plan — move the issue to Planning first so Claws writes one.");
  });

  it("lets a card with a plan in Awaiting plan review reach Approved, and Planning to re-plan", () => {
    renderPlanBoard("awaiting-plan-review", true);

    expect(offered()).toEqual(["drafting", "planning", "approved", "done"]);
    expect(dragOver("approved")).toBe(true);
    expect(dragOver("planning")).toBe(true);
  });

  // #clw_01M52GPG0E9DP8RQKW6ABH0X7R: a forge card waiting for import reaches
  // no gate column, whatever its forge labels claim about a plan.
  it("refuses every gate column to a card awaiting import, before the plan rule", () => {
    renderPlanBoard("drafting", true, ` data-awaiting-import="true"`);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(offered()).toEqual(["done"]);
    expect(dragOver("approved")).toBe(false);
    expect(dragOver("awaiting-plan-review")).toBe(false);
    expect(dragOver("planning")).toBe(false);

    moveTo("approved");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.getElementById("board-status")!.textContent).toBe("Waiting for import into the Claws tracker");
  });
});

describe("the board's filters", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = `
      <form class="board-filters" method="GET" action="/board">
        <select name="repo"><option value="" selected>All</option><option value="org/a">org/a</option></select>
        <button type="submit" id="board-filter-submit">Filter</button>
      </form>`;
    (window as unknown as { clawsBoardInit: () => void }).clawsBoardInit();
  });

  it("hides the Filter button, which only the no-JS path needs", () => {
    expect(document.getElementById("board-filter-submit")!.hidden).toBe(true);
  });

  it("applies a filter as soon as a select changes", () => {
    const form = document.querySelector<HTMLFormElement>("form.board-filters")!;
    const submitted = vi.fn((ev: Event) => ev.preventDefault());
    form.addEventListener("submit", submitted);

    const select = form.querySelector<HTMLSelectElement>('select[name="repo"]')!;
    select.value = "org/a";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(submitted).toHaveBeenCalledTimes(1);
  });
});

/**
 * The board with the parts #3293 added: the wrapper that holds the Backlog
 * tray and the header's backlog count.
 */
function renderBoardWithTray(): void {
  const cardHtml = (ref: string) => `
          <article class="board-card" draggable="true" data-repo="org/repo" data-ref="${ref}" data-column="drafting">
            <select class="board-move">
              <option value="" selected>Move to…</option>
              <option value="drafting" hidden>Drafting</option>
              <option value="approved">Approved</option>
              <option value="backlog">Backlog</option>
            </select>
          </article>`;
  document.body.innerHTML = `
    <div class="board-status" id="board-status"></div>
    <div id="issue-board-surface">
      <div class="board" id="issue-board">
        <details class="board-col" data-column="drafting" open>
          <summary class="board-col-head">Drafting <span data-count="drafting">3</span></summary>
          <div class="board-col-body" data-column="drafting">${cardHtml("1")}${cardHtml("2")}${cardHtml("3")}</div>
        </details>
        <details class="board-col" data-column="approved" open>
          <summary class="board-col-head">Approved <span data-count="approved">0</span></summary>
          <div class="board-col-body" data-column="approved"></div>
        </details>
      </div>
      <details class="board-tray">
        <summary class="board-tray-head">Backlog <span class="board-col-count" data-count="backlog">2</span></summary>
        <div class="board-col-body board-tray-body" data-column="backlog">Drop a card here to send it to the backlog.</div>
      </details>
    </div>`;
  (window as unknown as { clawsBoardInit: () => void }).clawsBoardInit();
}

describe("the Backlog tray (#3293)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    renderBoardWithTray();
  });

  /** A drop into `column` is a valid target only if `dragover` calls `preventDefault`. */
  function dragOverTray(source: HTMLElement): boolean {
    source.dispatchEvent(new Event("dragstart", { bubbles: true }));
    const ev = new Event("dragover", { bubbles: true, cancelable: true });
    document.querySelector(".board-tray-body")!.dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  // Refined/Blocked outrank an open PR in `columnFor`, so a card with one can
  // sit in Approved rather than a PR column — the tray's guard has to key off the
  // flight the server put on the card, not the column.
  it("refuses the tray and the select for a card in flight outside the derived columns", () => {
    document.querySelector(`.board-col-body[data-column="approved"]`)!.innerHTML = `
      <article class="board-card" draggable="true" data-repo="org/repo" data-ref="9" data-column="approved" data-in-flight="pr">

        <select class="board-move">
          <option value="" selected>Move to…</option>
          <option value="approved" hidden>Approved</option>
          <option value="backlog">Backlog</option>
        </select>
      </article>`;
    (window as unknown as { clawsBoardInit: () => void }).clawsBoardInit();
    const flightCard = document.querySelector<HTMLElement>(`.board-card[data-ref="9"]`)!;

    expect(dragOverTray(flightCard)).toBe(false);
    const backlogOption = flightCard.querySelector<HTMLSelectElement>(".board-move")!
      .querySelector<HTMLOptionElement>(`option[value="backlog"]`)!;
    expect(backlogOption.hidden).toBe(true);
  });

  const cardRef = (ref: string) => document.querySelector<HTMLElement>(`.board-card[data-ref="${ref}"]`);

  it("posts a drop on the tray as a move to backlog and takes the card off the board", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "ok", column: "backlog" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    cardRef("1")!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    document.querySelector(".board-tray-body")!.dispatchEvent(new Event("drop", { bubbles: true }));

    await vi.waitFor(() => expect(cardRef("1")).toBeNull());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/board/move");
    expect(JSON.parse(String(init.body))).toEqual({ repo: "org/repo", ref: "1", to: "backlog" });
    expect(document.querySelector(`[data-count="drafting"]`)!.textContent).toBe("2");
    // The collapsed tray's server-rendered count gains the card.
    expect(document.querySelector(`[data-count="backlog"]`)!.textContent).toBe("3");
  });

  it("takes a drop on the collapsed tray's summary as a send to backlog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "ok", column: "backlog" }), { status: 200 })));

    cardRef("1")!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    document.querySelector(".board-tray-head")!.dispatchEvent(new Event("drop", { bubbles: true }));

    await vi.waitFor(() => expect(cardRef("1")).toBeNull());
    expect(document.querySelector(`[data-count="backlog"]`)!.textContent).toBe("3");
  });

  it("sends to the backlog from the move select too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "ok", column: "backlog" }), { status: 200 })));
    const select = cardRef("2")!.querySelector<HTMLSelectElement>(".board-move")!;
    select.value = "backlog";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(cardRef("2")).toBeNull());
  });

  it("puts the card back when the server refuses the send", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "In progress and Awaiting merge follow the issue's running implementer and open PR — open, merge or close the PR instead." }), { status: 409 })));

    cardRef("1")!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    document.querySelector(".board-tray-body")!.dispatchEvent(new Event("drop", { bubbles: true }));

    await vi.waitFor(() => expect(cardRef("1")!.parentElement?.dataset["column"]).toBe("drafting"));
    expect(document.getElementById("board-status")!.textContent).toContain("open PR");
  });
});

describe("the board's Automerge toggle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    renderBoard();
    card().insertAdjacentHTML("afterbegin", `<button type="button" class="board-automerge" draggable="false" data-on="false" aria-pressed="false" title="Automerge off — click to apply">M</button>`);
  });

  function toggle(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>(".board-automerge")!;
  }

  it("posts {repo, ref, on: true} and leaves data-on=true on success", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "ok", on: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    toggle().click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/board/automerge");
    expect(JSON.parse(String(init.body))).toEqual({ repo: "org/repo", ref: "42", on: true });
    await vi.waitFor(() => expect(toggle().dataset["on"]).toBe("true"));
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    // The card's own column is untouched — the toggle never moves a card.
    expect(card().dataset["column"]).toBe("drafting");
  });

  it("reverts to data-on=false and writes the message to #board-status on a server refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 })));

    toggle().click();

    await vi.waitFor(() => expect(document.getElementById("board-status")?.textContent).toBe("nope"));
    expect(toggle().dataset["on"]).toBe("false");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  it("reverts when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));

    toggle().click();

    await vi.waitFor(() => expect(document.getElementById("board-status")?.textContent).toBe("offline"));
    expect(toggle().dataset["on"]).toBe("false");
  });

  it("sends nothing on a second click while the first is still in flight", async () => {
    const fetchMock = vi.fn(async () => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    toggle().click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    toggle().click();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // An open PR can sit outside the derived columns (Refined/Blocked outrank
  // it in `columnFor`), so the caveat has to come from `data-in-flight`, which
  // the server sets independently of the column, not from the column itself.
  it("keys the title's caveat off data-in-flight rather than the column", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "ok", on: true }), { status: 200 })));

    toggle().click();
    await vi.waitFor(() => expect(toggle().disabled).toBe(false));
    expect(toggle().dataset["on"]).toBe("true");
    expect(toggle().title).toBe("Automerge on (applies to the next PR Claws opens) — Claws merges the PR on green CI and a clean review; click to turn off");

    card().dataset["column"] = "approved";
    card().dataset["inFlight"] = "pr";
    toggle().click();
    await vi.waitFor(() => expect(toggle().dataset["on"]).toBe("false"));
    expect(toggle().title).toBe("Automerge off — click to apply");
  });
});

describe("the board's Start session button", () => {
  const assign = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    assign.mockReset();
    Object.defineProperty(window, "location", { value: { assign }, configurable: true });
    renderBoard({ repo: "org/repo" });
    card().dataset["ref"] = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    card().insertAdjacentHTML("beforeend", `<button type="button" class="trigger-btn board-start-session" draggable="false" aria-label="Start session for #1JBQ7X4M" title="Start session for #1JBQ7X4M"><span class="board-icon-terminal" aria-hidden="true">&gt;_</span></button>`);
  });

  function button(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>(".board-start-session")!;
  }

  it("posts the card's repo and ref and swaps in a Go to session link without navigating", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: "abc123", url: "/sessions/abc123" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    button().click();
    await vi.waitFor(() => expect(document.querySelector(".board-go-to-session")).not.toBeNull());
    expect(assign).not.toHaveBeenCalled();
    expect(card().querySelector(".board-start-session")).toBeNull();
    expect(card().querySelector("a.board-go-to-session")?.getAttribute("href")).toBe("/sessions/abc123");
    const status = document.getElementById("board-status")!;
    expect(status.classList.contains("board-ok")).toBe(true);
    expect(status.querySelector("a")?.getAttribute("href")).toBe("/sessions/abc123");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/board/start-session");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ repo: "org/repo", ref: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC" });
    // The card stays where it was: starting a session moves nothing.
    expect(card().dataset["column"]).toBe("drafting");
  });

  it("shows the refusal in #board-status and restores the button", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Cannot create session: repos span owners" }), { status: 400 })));

    button().click();

    await vi.waitFor(() => expect(document.getElementById("board-status")?.textContent).toBe("Cannot create session: repos span owners"));
    expect(button().disabled).toBe(false);
    expect(button().title).toBe("Start session for #1JBQ7X4M");
    expect(button().hasAttribute("aria-busy")).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("sends nothing on a second click while the first is still in flight", async () => {
    const fetchMock = vi.fn(async () => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    button().click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(button().title).toBe("Starting…");
    button().click();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the board on a phone", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Every query matches: the phone width, and a coarse pointer.
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn() })));
  });

  // Which columns start open is the server's call, at every width: the script
  // neither forces columns open nor folds them by media query.
  it.each([true, false])("leaves the server's open set alone whether or not the phone query matches (%s)", (matches) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches, addEventListener: vi.fn() })));
    renderBoard();
    const open = (column: string) => document.querySelector<HTMLDetailsElement>(`details.board-col[data-column="${column}"]`)!.open;

    expect(open("requirements-review")).toBe(true);
    expect(open("drafting")).toBe(true);
    expect(open("approved")).toBe(false);
    expect(open("in-progress")).toBe(false);
    expect(open("done")).toBe(false);
  });

  it("keeps a group header's counts in step with a move", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 })));
    renderBoard();
    const approved = document.querySelector<HTMLElement>(`details.board-col[data-column="approved"]`)!;
    approved.insertAdjacentHTML("beforebegin", `<h2><span data-group-count="building">0</span><span data-group-derived="building">5</span></h2>`);
    const group = document.createElement("section");
    group.className = "board-group";
    group.dataset["group"] = "building";
    approved.before(group);
    group.append(approved, document.querySelector(`details.board-col[data-column="in-progress"]`)!);

    moveTo("approved");

    await vi.waitFor(() => expect(document.querySelector(`[data-group-count="building"]`)!.textContent).toBe("1"));
    expect(document.querySelector(`[data-group-derived="building"]`)!.textContent).toBe("0");
  });
});

describe("the board's approve buttons", () => {
  function renderApprove(column: "requirements-review" | "awaiting-plan-review", to: "planning" | "approved"): void {
    const cols = ["requirements-review", "planning", "awaiting-plan-review", "approved", "done"];
    document.body.innerHTML = `
      <div class="board-status" id="board-status"></div>
      <div class="board" id="issue-board">${cols.map((c) => `
        <details class="board-col" data-column="${c}" open>
          <summary class="board-col-head">${c} <span data-count="${c}">${c === column ? 1 : 0}</span></summary>
          <div class="board-col-body" data-column="${c}">${c !== column ? "" : `
            <article class="board-card" draggable="true" data-repo="org/repo" data-ref="42" data-column="${c}" data-has-plan="true">
              <div class="board-chips"></div>
              <button type="button" class="trigger-btn board-approve" data-approve-from="${c}" data-approve-to="${to}">Approve</button>
              <select class="board-move"><option value="" selected>Move to…</option><option value="done">Closed</option></select>
            </article>`}</div>
        </details>`).join("")}
      </div>`;
    (window as unknown as { clawsBoardInit: () => void }).clawsBoardInit();
  }
  const button = () => document.querySelector<HTMLButtonElement>(".board-approve")!;

  beforeEach(() => vi.restoreAllMocks());

  it("approve requirements posts a move to planning and hides the button", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderApprove("requirements-review", "planning");

    button().click();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/board/move");
    expect(JSON.parse(String(init.body))).toEqual({ repo: "org/repo", ref: "42", to: "planning" });
    await vi.waitFor(() => expect(card().dataset["column"]).toBe("planning"));
    await vi.waitFor(() => expect(button().hidden).toBe(true));
  });

  it("approve plan posts a move to approved", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderApprove("awaiting-plan-review", "approved");

    button().click();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ repo: "org/repo", ref: "42", to: "approved" });
    await vi.waitFor(() => expect(card().dataset["column"]).toBe("approved"));
  });

  it("reverts, keeps the button and shows the refusal on a 409", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "requirements changed since you loaded the page" }), { status: 409 })));
    renderApprove("requirements-review", "planning");

    button().click();

    await vi.waitFor(() => expect(document.getElementById("board-status")?.textContent).toContain("requirements changed"));
    expect(card().dataset["column"]).toBe("requirements-review");
    expect(button().hidden).toBe(false);
  });
});

describe("the board's refresh", () => {
  type Placed = { ref: string; column: "drafting" | "approved" };
  type Nav = Array<{ href: string; text: string; name: string }>;

  /** The surface's inner HTML as `renderBoardSurface` shapes it: Drafting open, Approved folded, and the Backlog tray. */
  function surfaceHtml(cards: Placed[], ageOf = "3m"): string {
    const body = (column: string) => cards.filter((c) => c.column === column).map((c) => `
      <article class="board-card" draggable="true" data-repo="org/repo" data-ref="${c.ref}" data-column="${c.column}" data-has-plan="true">
        <span class="board-age">${ageOf}</span>
        <button type="button" class="board-automerge" data-on="false" aria-pressed="false">M</button>
        <select class="board-move">
          <option value="" selected>Move to…</option>
          <option value="drafting">Drafting</option>
          <option value="approved">Approved</option>
        </select>
      </article>`).join("");
    return `<div class="board" id="issue-board">
      <details class="board-col" data-column="drafting" open>
        <summary class="board-col-head">Drafting <span data-count="drafting">0</span></summary>
        <div class="board-col-body" data-column="drafting">${body("drafting")}</div>
      </details>
      <details class="board-col" data-column="approved">
        <summary class="board-col-head">Approved <span data-count="approved">0</span></summary>
        <div class="board-col-body" data-column="approved">${body("approved")}</div>
      </details>
    </div>
    <details class="board-tray" aria-label="Backlog">
      <summary class="board-tray-head">Backlog <span class="board-col-count" data-count="backlog">0</span></summary>
      <div class="board-col-body board-tray-body" data-column="backlog"></div>
    </details>`;
  }

  const NO_COUNTS: Nav = [
    { href: "/board", text: "", name: "Board" }, { href: "/prs", text: "", name: "PRs" }, { href: "/sessions", text: "", name: "Sessions" },
  ];

  /**
   * A JSON answer the poller can read with microtasks alone — no real body
   * stream to wait on. The surface stands in for its own `hash`: any string
   * that changes with the render will do.
   */
  function answer(surface: string, extra: { total?: number; warning?: string; nav?: Nav; ok?: boolean } = {}) {
    return {
      ok: extra.ok ?? true,
      status: extra.ok === false ? 503 : 200,
      json: async () => ({ surface, hash: surface, total: extra.total ?? 1, warning: extra.warning ?? "", nav: extra.nav ?? NO_COUNTS }),
    };
  }

  let visibility: DocumentVisibilityState = "visible";

  function renderSurfaceBoard(cards: Placed[], hash?: string): void {
    document.body.innerHTML = `
      <nav><div class="nav-pinned"><a href="/board">Board</a><a href="/prs">PRs</a><a href="/sessions">Sessions</a></div></nav>
      <h2>Board <span id="board-total">${cards.length}</span></h2>
      <div class="board-status board-warning" id="board-warning" role="status" hidden></div>
      <div class="board-status" id="board-status"></div>
      <div id="issue-board-surface"${hash === undefined ? "" : ` data-surface-hash="${hash}"`}>${surfaceHtml(cards)}</div>`;
    (window as unknown as { clawsBoardInit: () => void }).clawsBoardInit();
  }

  /** Fire one poll and let its fetch chain settle. */
  async function tick(): Promise<void> {
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  const refs = (column: string) => Array.from(document.querySelectorAll<HTMLElement>(`.board-col-body[data-column="${column}"] .board-card`)).map((c) => c.dataset["ref"]);

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    renderSurfaceBoard([{ ref: "1", column: "drafting" }]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("puts a new card on the board and moves an existing one after a tick", async () => {
    const fetchMock = vi.fn(async () => answer(surfaceHtml([{ ref: "1", column: "approved" }, { ref: "2", column: "drafting" }]), { total: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    await tick();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/api/board");
    expect(refs("drafting")).toEqual(["2"]);
    expect(refs("approved")).toEqual(["1"]);
    expect(document.getElementById("board-total")?.textContent).toBe("2");
    // The swapped-in cards are set up like the first render's: their current column is hidden in the select.
    const option = document.querySelector<HTMLOptionElement>('.board-card[data-ref="2"] option[value="drafting"]')!;
    expect(option.hidden).toBe(true);
  });

  it("asks for the page's ?repo= filter", async () => {
    // An earlier suite replaces `window.location` outright, so this one does too.
    const location = Object.getOwnPropertyDescriptor(window, "location");
    Object.defineProperty(window, "location", { value: { search: "?repo=org%2Frepo" }, configurable: true });
    try {
      const fetchMock = vi.fn(async () => answer(surfaceHtml([])));
      vi.stubGlobal("fetch", fetchMock);

      await tick();

      expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/api/board?repo=org%2Frepo");
    } finally {
      if (location) Object.defineProperty(window, "location", location);
    }
  });

  it("leaves the DOM untouched when the render has not changed", async () => {
    const html = surfaceHtml([{ ref: "1", column: "drafting" }, { ref: "2", column: "drafting" }]);
    vi.stubGlobal("fetch", vi.fn(async () => answer(html)));

    await tick();
    const before = document.querySelector('.board-card[data-ref="2"]');
    await tick();

    expect(document.querySelector('.board-card[data-ref="2"]')).toBe(before);
  });

  it("restores each column's scroll across a swap", async () => {
    const stored = new WeakMap<HTMLElement, number>();
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get(this: HTMLElement) { return stored.get(this) ?? 0; },
      set(this: HTMLElement, v: number) { stored.set(this, v); },
    });
    try {
      (document.querySelector('.board-col-body[data-column="drafting"]') as HTMLElement).scrollTop = 80;
      vi.stubGlobal("fetch", vi.fn(async () => answer(surfaceHtml([{ ref: "2", column: "drafting" }]))));

      await tick();

      expect(refs("drafting")).toEqual(["2"]);
      expect((document.querySelector('.board-col-body[data-column="drafting"]') as HTMLElement).scrollTop).toBe(80);
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, "scrollTop", desc);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)["scrollTop"];
    }
  });

  it("sets --board-body-top at desktop width and clears it below", async () => {
    const root = document.getElementById("issue-board")!;
    let wide = true;
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(min-width: 1024px)" && wide, media: q, addEventListener() {}, removeEventListener() {} }));
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 150 } as DOMRect);
    (document.querySelector("details.board-col") as HTMLDetailsElement).open = true;
    (window as unknown as { clawsBoardInit: () => void }).clawsBoardInit();
    expect(root.style.getPropertyValue("--board-body-top")).toBe("150px");
    wide = false;
    (window as unknown as { clawsBoardInit: () => void }).clawsBoardInit();
    expect(root.style.getPropertyValue("--board-body-top")).toBe("");
    rect.mockRestore();
  });

  it("re-sizes the columns when a column is toggled after a swap", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(min-width: 1024px)", media: q, addEventListener() {}, removeEventListener() {} }));
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 200 } as DOMRect);
    vi.stubGlobal("fetch", vi.fn(async () => answer(surfaceHtml([{ ref: "2", column: "drafting" }]))));
    await tick();

    const col = document.querySelector('details.board-col[data-column="drafting"]') as HTMLDetailsElement;
    col.open = true;
    col.dispatchEvent(new Event("toggle"));

    expect(document.getElementById("issue-board")!.style.getPropertyValue("--board-body-top")).toBe("200px");
    rect.mockRestore();
  });

  it("keeps the operator's folds and the board's horizontal scroll across a swap", async () => {
    const scrollLeft = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollLeft");
    const stored = new WeakMap<HTMLElement, number>();
    Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
      configurable: true,
      get(this: HTMLElement) { return stored.get(this) ?? 0; },
      set(this: HTMLElement, v: number) { stored.set(this, v); },
    });
    try {
      (document.querySelector('details.board-col[data-column="drafting"]') as HTMLDetailsElement).open = false;
      (document.querySelector('details.board-col[data-column="approved"]') as HTMLDetailsElement).open = true;
      (document.querySelector("details.board-tray") as HTMLDetailsElement).open = true;
      document.getElementById("issue-board")!.scrollLeft = 120;
      vi.stubGlobal("fetch", vi.fn(async () => answer(surfaceHtml([{ ref: "2", column: "drafting" }]))));

      await tick();

      expect(refs("drafting")).toEqual(["2"]);
      expect((document.querySelector('details.board-col[data-column="drafting"]') as HTMLDetailsElement).open).toBe(false);
      expect((document.querySelector('details.board-col[data-column="approved"]') as HTMLDetailsElement).open).toBe(true);
      expect((document.querySelector("details.board-tray") as HTMLDetailsElement).open).toBe(true);
      expect(document.getElementById("issue-board")!.scrollLeft).toBe(120);
    } finally {
      if (scrollLeft) Object.defineProperty(HTMLElement.prototype, "scrollLeft", scrollLeft);
      else delete (HTMLElement.prototype as { scrollLeft?: number }).scrollLeft;
    }
  });

  it("skips a tick while a move is in flight", async () => {
    const fetchMock = vi.fn(async () => answer(surfaceHtml([])));
    vi.stubGlobal("fetch", fetchMock);
    document.querySelector<HTMLElement>(".board-card")!.dataset["busy"] = "true";

    await tick();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(refs("drafting")).toEqual(["1"]);
  });

  it("skips a tick while a dialog is open", async () => {
    const fetchMock = vi.fn(async () => answer(surfaceHtml([])));
    vi.stubGlobal("fetch", fetchMock);
    document.body.insertAdjacentHTML("beforeend", "<dialog open><input></dialog>");

    await tick();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips a tick while a card's Move to… select has focus", async () => {
    const fetchMock = vi.fn(async () => answer(surfaceHtml([])));
    vi.stubGlobal("fetch", fetchMock);
    document.querySelector<HTMLSelectElement>(".board-move")!.focus();

    await tick();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(refs("drafting")).toEqual(["1"]);
  });

  it("leaves the server-rendered surface untouched on the first tick when the render matches it", async () => {
    const html = surfaceHtml([{ ref: "1", column: "drafting" }]);
    renderSurfaceBoard([{ ref: "1", column: "drafting" }], "h1");
    const before = document.querySelector('.board-card[data-ref="1"]');
    vi.stubGlobal("fetch", vi.fn(async () => ({ ...answer(html), json: async () => ({ surface: html, hash: "h1", total: 1, warning: "", nav: NO_COUNTS }) })));

    await tick();

    expect(document.querySelector('.board-card[data-ref="1"]')).toBe(before);
  });

  it("applies an unchanged server render after a client-side move", async () => {
    const html = surfaceHtml([{ ref: "1", column: "drafting" }, { ref: "2", column: "drafting" }]);
    renderSurfaceBoard([{ ref: "1", column: "drafting" }, { ref: "2", column: "drafting" }], "h1");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/board") return { ...answer(html), json: async () => ({ surface: html, hash: "h1", total: 2, warning: "", nav: NO_COUNTS }) };
      return new Response(JSON.stringify({ error: "half applied", partial: true }), { status: 500 });
    }));
    const select = document.querySelector<HTMLSelectElement>('.board-card[data-ref="1"] .board-move')!;
    select.value = "approved";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector(".board-card[data-busy]")).toBeNull());
    expect(refs("approved")).toEqual(["1"]);

    await tick();

    expect(refs("approved")).toEqual([]);
    expect(refs("drafting")).toEqual(["1", "2"]);
  });

  it("skips a tick while an automerge toggle is in flight", async () => {
    let settle: (v: Response) => void = () => {};
    const fetchMock = vi.fn((url: string) => url === "/board/automerge"
      ? new Promise<Response>((resolve) => { settle = resolve; })
      : Promise.resolve(answer(surfaceHtml([]))));
    vi.stubGlobal("fetch", fetchMock);
    document.querySelector<HTMLButtonElement>(".board-automerge")!.click();

    await tick();

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/board/automerge"]);
    expect(refs("drafting")).toEqual(["1"]);
    settle(new Response(JSON.stringify({ result: "ok" }), { status: 200 }));
  });

  it("drops a refresh that was fetching while a move ran to completion", async () => {
    let release: (v: unknown) => void = () => {};
    const stale = surfaceHtml([{ ref: "1", column: "drafting" }, { ref: "2", column: "drafting" }]);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/board") return new Promise((resolve) => { release = resolve; });
      return Promise.resolve(new Response(JSON.stringify({ result: "ok" }), { status: 200 }));
    }));

    // The tick's request is held open while the operator moves card 1.
    await tick();
    const select = document.querySelector<HTMLSelectElement>('.board-card[data-ref="1"] .board-move')!;
    select.value = "approved";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector(".board-card[data-busy]")).toBeNull());
    expect(refs("approved")).toEqual(["1"]);

    // The render predates the move: card 1 must stay where the operator put it.
    release(answer(stale));
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(refs("approved")).toEqual(["1"]);
    expect(refs("drafting")).toEqual([]);
  });

  it("keeps keyboard focus on the same card's control across a swap", async () => {
    document.querySelector<HTMLButtonElement>('.board-card[data-ref="1"] .board-automerge')!.focus();
    vi.stubGlobal("fetch", vi.fn(async () => answer(surfaceHtml([{ ref: "1", column: "drafting" }, { ref: "2", column: "drafting" }]))));

    await tick();

    expect(refs("drafting")).toEqual(["1", "2"]);
    const active = document.activeElement as HTMLElement;
    expect(active.classList.contains("board-automerge")).toBe(true);
    expect(active.closest<HTMLElement>(".board-card")?.dataset["ref"]).toBe("1");
  });

  it("keeps the last content when a refresh fails, and recovers on the next tick", async () => {
    const statusText = document.getElementById("board-status")!.textContent;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await tick();
    expect(refs("drafting")).toEqual(["1"]);

    vi.stubGlobal("fetch", vi.fn(async () => answer("", { ok: false })));
    await tick();
    expect(refs("drafting")).toEqual(["1"]);
    expect(document.getElementById("board-status")!.textContent).toBe(statusText);

    vi.stubGlobal("fetch", vi.fn(async () => answer(surfaceHtml([{ ref: "3", column: "approved" }]))));
    await tick();
    expect(refs("drafting")).toEqual([]);
    expect(refs("approved")).toEqual(["3"]);
  });

  it("does not poll a hidden tab, and refreshes as soon as it is visible again", async () => {
    const fetchMock = vi.fn(async () => answer(surfaceHtml([{ ref: "4", column: "drafting" }])));
    vi.stubGlobal("fetch", fetchMock);
    visibility = "hidden";

    await tick();
    expect(fetchMock).not.toHaveBeenCalled();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refs("drafting")).toEqual(["4"]);
  });

  it("updates the nav badges and accessible names, and the incomplete-sources warning", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(surfaceHtml([]), {
      warning: "1 of the board's sources loaded incompletely — some cards are missing.",
      nav: [
        { href: "/board", text: "3/7", name: "Board, 3 of 7 issues need attention" },
        { href: "/prs", text: "99+/99+", name: "PRs, 120 of 130 need attention" },
        { href: "/sessions", text: "", name: "Sessions" },
      ],
    })));

    await tick();

    const board = document.querySelector<HTMLAnchorElement>('nav a[href="/board"]')!;
    expect(board.getAttribute("aria-label")).toBe("Board, 3 of 7 issues need attention");
    expect(board.querySelector(".nav-count")?.textContent).toBe("3/7");
    expect(document.querySelector('nav a[href="/prs"] .nav-count')?.textContent).toBe("99+/99+");
    expect(document.querySelector('nav a[href="/sessions"] .nav-count')).toBeNull();
    const warning = document.getElementById("board-warning")!;
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toContain("loaded incompletely");

    vi.stubGlobal("fetch", vi.fn(async () => answer(surfaceHtml([]))));
    await tick();

    expect(board.hasAttribute("aria-label")).toBe(false);
    expect(board.querySelector(".nav-count")).toBeNull();
    expect(warning.hidden).toBe(true);
  });
});
