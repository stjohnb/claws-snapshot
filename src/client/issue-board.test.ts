// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import "./issue-board.js";

/**
 * The board markup src/pages/board.ts produces, cut down to four columns.
 *
 * `repo: ""` renders the card as an unassigned native issue, which `columnFor`
 * keeps in Ideas whatever labels it is given. The `pr-open` option is
 * one the server never renders — `moveSelect` filters out every derived column —
 * but the client applies the rule itself rather than depending on that, so the
 * fixture carries it.
 */
function renderBoard(opts: { repo?: string; inFlight?: "task" | "pr" } = {}): void {
  const repo = opts.repo ?? "org/repo";
  const flight = opts.inFlight ? ` data-in-flight="${opts.inFlight}"` : "";
  document.body.innerHTML = `
    <div class="board-status" id="board-status"></div>
    <div class="board" id="issue-board">
      <details class="board-col" data-column="ideas" open>
        <summary class="board-col-head">Ideas <span data-count="ideas">1</span></summary>
        <div class="board-col-body" data-column="ideas">
          <article class="board-card" draggable="true" data-repo="${repo}" data-ref="42" data-column="ideas"${flight}>
            <select class="board-move">
              <option value="" selected>Move to…</option>
              <option value="ideas" hidden>Ideas</option>
              <option value="approved">Approved</option>
              <option value="pr-open">PR open</option>
              <option value="done">Done</option>
            </select>
          </article>
        </div>
      </details>
      <details class="board-col" data-column="approved" open>
        <summary class="board-col-head">Approved <span data-count="approved">0</span></summary>
        <div class="board-col-body" data-column="approved"></div>
      </details>
      <details class="board-col board-col-derived" data-column="pr-open" open>
        <summary class="board-col-head">PR open <span data-count="pr-open">0</span></summary>
        <div class="board-col-body" data-column="pr-open"></div>
      </details>
      <details class="board-col" data-column="done" open>
        <summary class="board-col-head">Done <span data-count="done">0</span></summary>
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
    expect(countOf("ideas")).toBe("0");
    expect(countOf("approved")).toBe("1");
  });

  // The age chip is server-rendered; a move the server accepted restarts it.
  it("resets the card's age chip on a successful move", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "ok" }), { status: 200 })));
    card().insertAdjacentHTML("afterbegin", `<span class="board-age" data-stale="true" title="In Ideas for 5d">5d</span>`);

    moveTo("approved");

    await vi.waitFor(() => expect(card().querySelector(".board-age")!.textContent).toBe("<1m"));
    const age = card().querySelector<HTMLElement>(".board-age")!;
    expect(age.dataset["stale"]).toBe("false");
    expect(age.title).toBe("Just moved");
  });

  it("leaves the age chip alone when the server refuses the move", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 409 })));
    card().insertAdjacentHTML("afterbegin", `<span class="board-age" data-stale="true" title="In Ideas for 5d">5d</span>`);

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
      new Response(JSON.stringify({ error: "Implementing, PR open and Awaiting merge follow the issue's running implementer and open PR" }), { status: 409 })));

    moveTo("approved");

    await vi.waitFor(() => expect(document.getElementById("board-status")?.textContent).toContain("open PR"));
    expect(card().dataset["column"]).toBe("ideas");
    expect(card().parentElement?.dataset["column"]).toBe("ideas");
    expect(countOf("ideas")).toBe("1");
    expect(countOf("approved")).toBe("0");
  });

  it("reverts when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));

    moveTo("approved");

    await vi.waitFor(() => expect(document.getElementById("board-status")?.textContent).toBe("offline"));
    expect(card().parentElement?.dataset["column"]).toBe("ideas");
  });

  // The remembered sibling can be gone by the time the server answers, and an
  // insertBefore against a detached node throws: the revert has to fall back to
  // appending rather than escape as an unhandled rejection.
  it("reverts to the end of the origin column when its remembered neighbour has moved", async () => {
    const ideas = document.querySelector<HTMLElement>(`.board-col-body[data-column="ideas"]`)!;
    const neighbour = document.createElement("article");
    neighbour.className = "board-card";
    ideas.appendChild(neighbour);
    // The card being moved now remembers `neighbour` as its next sibling.
    ideas.insertBefore(card(), neighbour);

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
    expect(card().parentElement?.dataset["column"]).toBe("ideas");
    expect(countOf("ideas")).toBe("1");
    expect(countOf("approved")).toBe("0");
  });

  it("ignores a second move while the first is still in flight", async () => {
    const fetchMock = vi.fn(async () => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    moveTo("approved");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    moveTo("ideas");

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
    expect(card().parentElement?.dataset["column"]).toBe("ideas");
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

  // Defence in depth, not a live case: the route 409s any move that would land
  // somewhere other than the drop target, so a real 200 always reports `to`.
  // The branch exists so the DOM would follow the server rather than the drop
  // if the route ever reported a column it reached instead of refusing.
  it("places the card in the column the server reports", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ result: "ok", column: "ideas" }), { status: 200 })));

    moveTo("approved");

    await vi.waitFor(() => expect(card().parentElement?.dataset["column"]).toBe("ideas"));
    expect(card().dataset["column"]).toBe("ideas");
    expect(countOf("ideas")).toBe("1");
    expect(countOf("approved")).toBe("0");
  });

  // A 503 is the route's "I could not read the issue's state": it comes before
  // any label is written, so the card belongs back where it came from.
  it("puts the card back when the server could not read the issue's state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "Could not read the issue's current state — try again." }), { status: 503 })));

    moveTo("approved");

    await vi.waitFor(() => expect(card().parentElement?.dataset["column"]).toBe("ideas"));
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

    await vi.waitFor(() => expect(card().parentElement?.dataset["column"]).toBe("ideas"));
    expect(card().dataset["column"]).toBe("ideas");
    expect(countOf("ideas")).toBe("1");
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

    await vi.waitFor(() => expect(card().parentElement?.dataset["column"]).toBe("ideas"));
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

    await vi.waitFor(() => expect(card().parentElement?.dataset["column"]).toBe("ideas"));
    expect(card().dataset["column"]).toBe("ideas");
    expect(countOf("ideas")).toBe("1");
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

    expect(offeredColumns()).toEqual(["ideas", "approved"]);
  });

  // No label change produces a derived column, so none is ever on offer —
  // the server omits them from the render and the client hides them either way.
  it("never offers a derived column", () => {
    expect(offeredColumns()).not.toContain("pr-open");
  });

  // An unassigned issue takes a move's labels and stays in Ideas, so every
  // other destination is a guaranteed 409.
  it("offers an unassigned card only Ideas and Done", () => {
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
    expect(card().parentElement?.dataset["column"]).toBe("ideas");
    expect(document.getElementById("board-status")!.textContent).toBe(
      "Implementing, PR open and Awaiting merge follow the issue's running implementer and open PR — open, merge or close the PR instead.");
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
    expect(card().parentElement?.dataset["column"]).toBe("ideas");
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

    expect(dragOver("pr-open")).toBe(false);
    expect(columnBody("pr-open").classList.contains("drag-over")).toBe(false);

    expect(dragOver("approved")).toBe(true);
    expect(columnBody("approved").classList.contains("drag-over")).toBe(true);
  });

  it("is not a drop target for an unassigned card outside Ideas and Done", () => {
    renderBoard({ repo: "" });
    fire(card(), "dragstart");

    expect(dragOver("approved")).toBe(false);
    expect(dragOver("done")).toBe(true);
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
          <article class="board-card" draggable="true" data-repo="org/repo" data-ref="${ref}" data-column="ideas">
            <select class="board-move">
              <option value="" selected>Move to…</option>
              <option value="ideas" hidden>Ideas</option>
              <option value="approved">Approved</option>
              <option value="backlog">Backlog</option>
            </select>
          </article>`;
  document.body.innerHTML = `
    <a id="board-backlog-link" href="/backlog">Backlog (<span id="board-backlog-count">2</span>)</a>
    <div class="board-status" id="board-status"></div>
    <div id="issue-board-surface">
      <div class="board" id="issue-board">
        <details class="board-col" data-column="ideas" open>
          <summary class="board-col-head">Ideas <span data-count="ideas">3</span></summary>
          <div class="board-col-body" data-column="ideas">${cardHtml("1")}${cardHtml("2")}${cardHtml("3")}</div>
        </details>
        <details class="board-col" data-column="approved" open>
          <summary class="board-col-head">Approved <span data-count="approved">0</span></summary>
          <div class="board-col-body" data-column="approved"></div>
        </details>
      </div>
      <section class="board-tray">
        <div class="board-col-body board-tray-body" data-column="backlog">Drop a card here to send it to the backlog.</div>
      </section>
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
  // sit in Approved rather than PR open — the tray's guard has to key off the
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
  const backlogCount = () => document.getElementById("board-backlog-count")!.textContent;

  it("posts a drop on the tray as a move to backlog and takes the card off the board", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "ok", column: "backlog" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    cardRef("1")!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    document.querySelector(".board-tray-body")!.dispatchEvent(new Event("drop", { bubbles: true }));

    await vi.waitFor(() => expect(cardRef("1")).toBeNull());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/board/move");
    expect(JSON.parse(String(init.body))).toEqual({ repo: "org/repo", ref: "1", to: "backlog" });
    expect(document.querySelector(`[data-count="ideas"]`)!.textContent).toBe("2");
    expect(backlogCount()).toBe("3");
  });

  it("sends to the backlog from the move select too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: "ok", column: "backlog" }), { status: 200 })));
    const select = cardRef("2")!.querySelector<HTMLSelectElement>(".board-move")!;
    select.value = "backlog";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(cardRef("2")).toBeNull());
    expect(backlogCount()).toBe("3");
  });

  it("puts the card back when the server refuses the send", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "Implementing, PR open and Awaiting merge follow the issue's running implementer and open PR — open, merge or close the PR instead." }), { status: 409 })));

    cardRef("1")!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    document.querySelector(".board-tray-body")!.dispatchEvent(new Event("drop", { bubbles: true }));

    await vi.waitFor(() => expect(cardRef("1")!.parentElement?.dataset["column"]).toBe("ideas"));
    expect(backlogCount()).toBe("2");
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
    expect(card().dataset["column"]).toBe("ideas");
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

describe("the board on a phone", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Every query matches: the phone width, and a coarse pointer.
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn() })));
  });

  // The derived columns fold into their group header's count, and Blocked and
  // Done are not acted on from the board; the gate columns stay open.
  it("collapses the derived columns, Blocked and Done, and leaves the gates open", () => {
    renderBoard();
    const open = (column: string) => document.querySelector<HTMLDetailsElement>(`details.board-col[data-column="${column}"]`)!.open;

    expect(open("ideas")).toBe(true);
    expect(open("approved")).toBe(true);
    expect(open("pr-open")).toBe(false);
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
    group.append(approved, document.querySelector(`details.board-col[data-column="pr-open"]`)!);

    moveTo("approved");

    await vi.waitFor(() => expect(document.querySelector(`[data-group-count="building"]`)!.textContent).toBe("1"));
    expect(document.querySelector(`[data-group-derived="building"]`)!.textContent).toBe("0");
  });
});
