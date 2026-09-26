import { describe, it, expect } from "vitest";
import { BACKLOG_DESTINATION, BOARD_COLUMNS, BOARD_GROUPS, DERIVED_COLUMNS, DERIVED_COLUMN_REJECTION, FORGE_REOPEN_REJECTION, LIFECYCLE_LABELS, UNASSIGNED_REJECTION, backlogRefusal, columnAfterMove, columnFor, isBoardColumn, isBoardDestination, transitionFor, type BoardPr } from "./issue-board.js";
import { ISSUE_BOARD_SCRIPT } from "./resources/issue-board.generated.js";
import { LABELS } from "./config.js";

// `client/issue-board.ts` cannot import this module (it would pull `config.ts`,
// and `node:fs` with it, into the browser bundle), so it holds a second copy of
// every refusal its `canReach` can raise before a move is sent. The two suites
// that cover them assert *different* substrings of their own copy, which leaves
// editing one alone green in both — this is what stops the operator being told
// two different things by the pre-flight and the route. esbuild emits the em
// dash as a `—` escape, so the bundle is un-escaped before comparing rather
// than only the clause before the dash: with half the string compared,
// rewording the other half stayed green in both.
describe("the refusal strings the client copies", () => {
  const bundle = ISSUE_BOARD_SCRIPT.replace(/\\u2014/g, "—");

  it.each([
    ["FORGE_REOPEN_REJECTION", FORGE_REOPEN_REJECTION],
    ["DERIVED_COLUMN_REJECTION", DERIVED_COLUMN_REJECTION],
    ["UNASSIGNED_REJECTION", UNASSIGNED_REJECTION],
  ])("%s reads the same in the client bundle as it does here", (_name, refusal) => {
    expect(bundle).toContain(refusal);
  });

  // Only a zero-repo issue is unassigned; a multi-repo one is owned by its
  // primary repo, so the refusal no longer asks for exactly one.
  it("UNASSIGNED_REJECTION asks for a repository, not exactly one", () => {
    expect(UNASSIGNED_REJECTION).toBe("Assign this issue to a repository before moving it out of Ideas.");
  });
});

const OPEN_PR: BoardPr = { stage: "awaiting-review", needsHumanReview: false };
const MERGE_READY_PR: BoardPr = { stage: "awaiting-merge", needsHumanReview: false };

describe("the board's groups", () => {
  // Shaping, Building, Landing, with Blocked between Building and Landing
  // (docs/refinements/issue-flow.md, "The board").
  it("orders nine columns into three groups with Blocked standing alone", () => {
    expect(BOARD_GROUPS.map((g) => g.id)).toEqual(["shaping", "building", "landing"]);
    expect(BOARD_COLUMNS.map((col) => `${col.group ?? "-"}:${col.id}`)).toEqual([
      "shaping:ideas",
      "shaping:planning",
      "shaping:awaiting-plan-review",
      "building:approved",
      "building:implementing",
      "building:pr-open",
      "-:blocked",
      "landing:awaiting-merge",
      "landing:done",
    ]);
  });

  it("marks the three flight columns derived and the human gates as gates", () => {
    expect(DERIVED_COLUMNS).toEqual(["implementing", "pr-open", "awaiting-merge"]);
    expect(BOARD_COLUMNS.filter((col) => col.gate).map((col) => col.id)).toEqual(["ideas", "planning", "awaiting-plan-review", "approved", "done"]);
    for (const col of BOARD_COLUMNS) {
      if (col.derived) expect(col.hint, col.id).toMatch(/— set by Claws, not a drop target$/);
      if (col.gate) expect(col.hint, col.id).toMatch(/— drop (a card )?here( to promote or re-plan)?$/);
    }
  });
});

describe("columnFor", () => {
  it("puts an unlabelled issue in Ideas, or in Planning when its lifecycle says so", () => {
    expect(columnFor({ labels: [] })).toBe("ideas");
    expect(columnFor({ labels: [LABELS.priority] })).toBe("ideas");
    expect(columnFor({ labels: [], lifecycle: "ideas" })).toBe("ideas");
    expect(columnFor({ labels: [], lifecycle: "planning" })).toBe("planning");
    // A state label outranks the stored stage.
    expect(columnFor({ labels: [LABELS.ready], lifecycle: "planning" })).toBe("awaiting-plan-review");
  });

  it("maps each lifecycle label to its column", () => {
    expect(columnFor({ labels: [LABELS.ready] })).toBe("awaiting-plan-review");
    expect(columnFor({ labels: [LABELS.refined] })).toBe("approved");
    expect(columnFor({ labels: [LABELS.blocked] })).toBe("blocked");
  });

  it("puts an issue with a running implementer in Implementing", () => {
    expect(columnFor({ labels: [], implementing: true })).toBe("implementing");
    expect(columnFor({ labels: [LABELS.ready], implementing: true })).toBe("implementing");
  });

  it("puts an issue with open PR rows in PR open, or Awaiting merge when every row is there", () => {
    expect(columnFor({ labels: [], openPrs: [OPEN_PR] })).toBe("pr-open");
    expect(columnFor({ labels: [], openPrs: [MERGE_READY_PR] })).toBe("awaiting-merge");
    expect(columnFor({ labels: [], openPrs: [MERGE_READY_PR, MERGE_READY_PR] })).toBe("awaiting-merge");
    expect(columnFor({ labels: [], openPrs: [MERGE_READY_PR, OPEN_PR] })).toBe("pr-open");
    expect(columnFor({ labels: [], openPrs: [] })).toBe("ideas");
  });

  // The Blocked column is the `Blocked` label alone, not the whole of
  // `gh.isParked`. `Claws Ignore` and `Claws Staging` park an issue without
  // moving its card, because the board owns LIFECYCLE_LABELS and nothing else —
  // a move out of Blocked must not silently un-ignore an issue.
  it("leaves an issue parked by another label in its lifecycle column", () => {
    expect(columnFor({ labels: [LABELS.clawsIgnore, LABELS.refined] })).toBe("approved");
    expect(columnFor({ labels: [LABELS.clawsStaging, LABELS.ready] })).toBe("awaiting-plan-review");
    expect(columnFor({ labels: [LABELS.clawsIgnore] })).toBe("ideas");
  });

  it("sends a closed issue to done whatever its labels or flight say", () => {
    expect(columnFor({ labels: [LABELS.refined], closed: true })).toBe("done");
    expect(columnFor({ labels: [LABELS.blocked], closed: true })).toBe("done");
    expect(columnFor({ labels: [], closed: true, implementing: true, openPrs: [OPEN_PR] })).toBe("done");
  });

  // The pipeline's own precedence: gh.isParked drops a Blocked issue before it
  // is classified; issue-worker keeps Refined until the PR opens, so a running
  // implementer outranks it; classifyIssue returns `refined` before it looks for
  // an open PR; and an open PR outranks Ready.
  it("ranks Blocked over Implementing over Refined over an open PR over Ready", () => {
    const all = { labels: [LABELS.blocked, LABELS.refined, LABELS.ready], implementing: true, openPrs: [OPEN_PR] };
    expect(columnFor(all)).toBe("blocked");
    expect(columnFor({ ...all, labels: [LABELS.refined, LABELS.ready] })).toBe("implementing");
    expect(columnFor({ ...all, labels: [LABELS.refined, LABELS.ready], implementing: false })).toBe("approved");
    expect(columnFor({ ...all, labels: [LABELS.ready], implementing: false })).toBe("pr-open");
  });

  // Backlog is a destination, not a column (#3293): it outranks every other
  // label and the flight, but closed and unassigned still win.
  it("takes a Backlog issue off the board, over every other label", () => {
    expect(columnFor({ labels: [LABELS.backlog] })).toBe("backlog");
    expect(columnFor({ labels: [LABELS.backlog, LABELS.blocked, LABELS.refined, LABELS.ready], implementing: true, openPrs: [OPEN_PR] })).toBe("backlog");
    expect(columnFor({ labels: [LABELS.backlog], closed: true })).toBe("done");
    expect(columnFor({ labels: [LABELS.backlog], unassigned: true })).toBe("ideas");
  });

  it("parks an unassigned native issue in Ideas, labels and lifecycle notwithstanding", () => {
    expect(columnFor({ labels: [LABELS.refined], unassigned: true })).toBe("ideas");
    expect(columnFor({ labels: [], unassigned: true, lifecycle: "planning" })).toBe("ideas");
    // Still Done if it is closed: the issue is finished either way.
    expect(columnFor({ labels: [LABELS.refined], unassigned: true, closed: true })).toBe("done");
  });
});

describe("transitionFor", () => {
  it("clears every lifecycle label on a move to Ideas or Planning, and says which", () => {
    expect(transitionFor("ideas")).toEqual({ add: [], remove: [...LIFECYCLE_LABELS], close: false, lifecycle: "ideas" });
    expect(transitionFor("planning")).toEqual({ add: [], remove: [...LIFECYCLE_LABELS], close: false, lifecycle: "planning" });
  });

  it("declares the target column's label and removes every other lifecycle one", () => {
    expect(transitionFor("awaiting-plan-review")).toEqual({
      add: [LABELS.ready],
      remove: [LABELS.backlog, LABELS.blocked, LABELS.refined],
      close: false,
    });
    expect(transitionFor("approved")).toEqual({
      add: [LABELS.refined],
      remove: [LABELS.backlog, LABELS.blocked, LABELS.ready],
      close: false,
    });
    expect(transitionFor("blocked")).toEqual({
      add: [LABELS.blocked],
      remove: [LABELS.backlog, LABELS.refined, LABELS.ready],
      close: false,
    });
    expect(transitionFor("backlog")).toEqual({
      add: [LABELS.backlog],
      remove: [LABELS.blocked, LABELS.refined, LABELS.ready],
      close: false,
    });
  });

  it("closes rather than relabels for done", () => {
    expect(transitionFor("done")).toEqual({ add: [], remove: [], close: true });
  });

  // A running implementer or an open PR puts an issue there; no label change
  // an operator can make does.
  it("refuses every derived column", () => {
    for (const column of DERIVED_COLUMNS) expect(transitionFor(column), column).toBeNull();
  });

  it("reaches the backlog from any combination of owned labels", () => {
    const move = transitionFor(BACKLOG_DESTINATION)!;
    for (const labels of ownedLabelSubsets()) {
      expect(columnFor({ labels: labelsAfter(move, labels) }), `[${labels.join(", ")}] → backlog`).toBe("backlog");
    }
  });

  it("has a transition for every column but the derived ones", () => {
    for (const col of BOARD_COLUMNS) {
      expect(transitionFor(col.id) === null).toBe(col.derived);
    }
  });

  // Every subset of the labels the board owns, built rather than hand-picked: a
  // sample leaves the combination that breaks a new precedence rule to chance,
  // and the powerset of four labels is sixteen rows. `Priority` rides along on
  // each of them — the board must not treat it as a lifecycle label.
  function ownedLabelSubsets(): string[][] {
    const sets: string[][] = [];
    for (let mask = 0; mask < 1 << LIFECYCLE_LABELS.length; mask++) {
      const labels = LIFECYCLE_LABELS.filter((_, i) => mask & (1 << i));
      sets.push(labels, [...labels, LABELS.priority]);
    }
    return sets;
  }

  const labelsAfter = (move: { add: readonly string[]; remove: readonly string[] }, labels: string[]): string[] =>
    [...labels.filter((l) => !move.remove.includes(l)), ...move.add];

  // The invariant the board rests on for an issue not in flight: the route
  // reports the column the card was dropped into, so the move has to actually
  // produce it — from *any* starting column, including the ones whose labels
  // outrank the target's.
  it("lands in the requested column from every other column", () => {
    for (const col of BOARD_COLUMNS) {
      const move = transitionFor(col.id);
      if (!move || move.close) continue;
      for (const labels of ownedLabelSubsets()) {
        for (const lifecycle of ["ideas", "planning"]) {
          expect(columnAfterMove(move, { labels, lifecycle }), `[${labels.join(", ")}] (${lifecycle}) → ${col.id}`).toBe(col.id);
        }
      }
    }
  });

  // With the issue in flight the invariant is weaker, and deliberately so: no
  // move touches the task or the PR, so only the destinations that outrank the
  // flight in `columnFor` are reachable. The rest land back in a derived
  // column, which the route turns into a 409.
  it.each([
    ["a running implementer", { implementing: true }, { ideas: "implementing", planning: "implementing", "awaiting-plan-review": "implementing", approved: "implementing", blocked: "blocked" }],
    ["an open PR", { openPrs: [OPEN_PR] }, { ideas: "pr-open", planning: "pr-open", "awaiting-plan-review": "pr-open", approved: "approved", blocked: "blocked" }],
    ["a merge-ready PR", { openPrs: [MERGE_READY_PR] }, { ideas: "awaiting-merge", planning: "awaiting-merge", "awaiting-plan-review": "awaiting-merge", approved: "approved", blocked: "blocked" }],
  ] as const)("reaches only what outranks %s", (_name, flight, reachable: Record<string, string>) => {
    for (const col of BOARD_COLUMNS) {
      const move = transitionFor(col.id);
      if (!move) continue;
      for (const labels of ownedLabelSubsets()) {
        const landing = columnAfterMove(move, { labels, ...flight });
        expect(landing, `[${labels.join(", ")}] → ${col.id}`).toBe(move.close ? "done" : reachable[col.id]);
      }
    }
  });

  it("leaves labels the board does not own alone", () => {
    for (const col of BOARD_COLUMNS) {
      const move = transitionFor(col.id);
      if (!move) continue;
      const owned: readonly string[] = LIFECYCLE_LABELS;
      expect(move.remove.filter((label) => !owned.includes(label))).toEqual([]);
    }
  });
});

describe("columnAfterMove", () => {
  function moveTo(column: "ideas" | "planning" | "awaiting-plan-review" | "approved" | "blocked" | "done" | "backlog") {
    return transitionFor(column)!;
  }

  it("reaches the column that was asked for, for an ordinary issue", () => {
    for (const col of BOARD_COLUMNS) {
      const move = transitionFor(col.id);
      if (!move) continue;
      expect(columnAfterMove(move, { labels: [] })).toBe(col.id);
    }
  });

  // The labels the issue is really holding, not the ones the move adds: a label
  // the board does not own survives the move and can outrank what it adds.
  it("computes the landing column from the issue's own labels", () => {
    // The old label the move removes is gone, so the new one decides.
    expect(columnAfterMove(moveTo("awaiting-plan-review"), { labels: [LABELS.blocked] })).toBe("awaiting-plan-review");
    // Ideas and Planning share their (empty) labels: the move's stage decides.
    expect(columnAfterMove(moveTo("planning"), { labels: [LABELS.ready], lifecycle: "ideas" })).toBe("planning");
    expect(columnAfterMove(moveTo("ideas"), { labels: [], lifecycle: "planning" })).toBe("ideas");
    // A labelled move keeps the stored stage, which its label outranks.
    expect(columnAfterMove(moveTo("approved"), { labels: [], lifecycle: "planning" })).toBe("approved");
    // A label the board leaves alone rides along without changing the outcome.
    expect(columnAfterMove(moveTo("approved"), { labels: [LABELS.clawsIgnore] })).toBe("approved");
  });

  // The flight rides through the move, so it decides what lands.
  it("carries the issue's flight through the move", () => {
    expect(columnAfterMove(moveTo("approved"), { labels: [], openPrs: [OPEN_PR] })).toBe("approved");
    expect(columnAfterMove(moveTo("approved"), { labels: [], implementing: true })).toBe("implementing");
    expect(columnAfterMove(moveTo("blocked"), { labels: [], implementing: true })).toBe("blocked");
    expect(columnAfterMove(moveTo("ideas"), { labels: [LABELS.refined], openPrs: [MERGE_READY_PR] })).toBe("awaiting-merge");
    expect(columnAfterMove(moveTo("done"), { labels: [], implementing: true })).toBe("done");
  });

  // The half transitionFor cannot promise: columnFor parks an unassigned issue
  // in Ideas whatever labels the move applies, so the route has to compute
  // the landing column rather than trust the transition's shape.
  it("keeps an unassigned issue in Ideas whatever the move adds", () => {
    expect(columnAfterMove(moveTo("approved"), { labels: [], unassigned: true })).toBe("ideas");
    expect(columnAfterMove(moveTo("blocked"), { labels: [], unassigned: true })).toBe("ideas");
    expect(columnAfterMove(moveTo("ideas"), { labels: [], unassigned: true })).toBe("ideas");
    expect(columnAfterMove(moveTo("planning"), { labels: [], unassigned: true })).toBe("ideas");
    expect(columnAfterMove(moveTo("backlog"), { labels: [], unassigned: true })).toBe("ideas");
    // Done is the one destination it can still reach: closed outranks the rest.
    expect(columnAfterMove(moveTo("done"), { labels: [], unassigned: true })).toBe("done");
  });

  // No label change reopens an issue, so a relabelling move on a closed one
  // lands in Done — which is why dragging a card out of Done has to reopen it.
  it("leaves a still-closed issue in done", () => {
    expect(columnAfterMove(moveTo("approved"), { labels: [], closed: true })).toBe("done");
  });
});

describe("isBoardColumn", () => {
  it("accepts the declared columns and nothing else", () => {
    expect(isBoardColumn("approved")).toBe(true);
    expect(isBoardColumn("Approved")).toBe(false);
    expect(isBoardColumn("backlog")).toBe(false);
    expect(isBoardColumn("in-progress")).toBe(false);
  });

  it("keeps the backlog out of the board's columns", () => {
    expect(BOARD_COLUMNS.map((col) => col.id)).not.toContain("backlog");
  });
});

describe("isBoardDestination", () => {
  it("accepts every column plus the backlog", () => {
    for (const col of BOARD_COLUMNS) expect(isBoardDestination(col.id)).toBe(true);
    expect(isBoardDestination("backlog")).toBe(true);
    expect(isBoardDestination("nowhere")).toBe(false);
  });
});

describe("backlogRefusal", () => {
  // Backlog outranks the flight, so the landing check alone would let an issue
  // in flight off the board.
  it("refuses an issue with a running implementer or an open PR, and nothing else", () => {
    expect(columnAfterMove(transitionFor("backlog")!, { labels: [], openPrs: [OPEN_PR] })).toBe("backlog");
    expect(backlogRefusal({ implementing: true })).toBe(DERIVED_COLUMN_REJECTION);
    expect(backlogRefusal({ openPrs: [OPEN_PR] })).toBe(DERIVED_COLUMN_REJECTION);
    expect(backlogRefusal({})).toBeUndefined();
    expect(backlogRefusal({ implementing: false, openPrs: [] })).toBeUndefined();
  });
});
