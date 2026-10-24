import { describe, it, expect } from "vitest";
import { APPROVED_NEEDS_PLAN_REJECTION, BACKLOG_DESTINATION, BLOCKED_REASON_REQUIRED, BOARD_COLUMNS, BOARD_GROUPS, DERIVED_COLUMNS, DERIVED_COLUMN_REJECTION, FORGE_REOPEN_REJECTION, LIFECYCLE_LABELS, REVIEW_NEEDS_PLAN_REJECTION, UNASSIGNED_REJECTION, backlogRefusal, closeReasonLabel, columnAfterMove, columnFor, destinationForLifecycle, isBoardColumn, isBoardDestination, isRequirementsColumn, isStalledPr, landsIn, planRefusal, REQUIREMENTS_COLUMNS, transitionFor, type BoardDestination, type BoardPr } from "./issue-board.js";
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
    ["BLOCKED_REASON_REQUIRED", BLOCKED_REASON_REQUIRED],
    // The plan rule is imported from the leaf `board-plan-rule.ts` rather than
    // copied, so these pin that the bundle carries it — a stale bundle, or a
    // client that stopped importing it, fails here.
    ["APPROVED_NEEDS_PLAN_REJECTION", APPROVED_NEEDS_PLAN_REJECTION],
    ["REVIEW_NEEDS_PLAN_REJECTION", REVIEW_NEEDS_PLAN_REJECTION],
  ])("%s reads the same in the client bundle as it does here", (_name, refusal) => {
    expect(bundle).toContain(refusal);
  });

  // Only a zero-repo issue is unassigned; a multi-repo one is owned by its
  // primary repo, so the refusal no longer asks for exactly one.
  it("UNASSIGNED_REJECTION asks for a repository, not exactly one", () => {
    expect(UNASSIGNED_REJECTION).toBe("Assign this issue to a repository before moving it out of Drafting.");
  });
});

describe("planRefusal", () => {
  const destinations: BoardDestination[] = [...BOARD_COLUMNS.map((col) => col.id), BACKLOG_DESTINATION];

  it("refuses Approved and Awaiting plan review to an issue with no plan", () => {
    expect(planRefusal("approved", false)).toBe(APPROVED_NEEDS_PLAN_REJECTION);
    expect(planRefusal("awaiting-plan-review", false)).toBe(REVIEW_NEEDS_PLAN_REJECTION);
  });

  it("says a plan is needed and how to get one", () => {
    for (const reason of [APPROVED_NEEDS_PLAN_REJECTION, REVIEW_NEEDS_PLAN_REJECTION]) {
      expect(reason).toMatch(/needs a plan/);
      expect(reason).toMatch(/Planning/);
    }
  });

  it.each(destinations)("allows %s to an issue with a plan", (to) => {
    expect(planRefusal(to, true)).toBeUndefined();
  });

  it.each(destinations.filter((to) => to !== "approved" && to !== "awaiting-plan-review"))(
    "leaves %s to the other rules for an issue with no plan",
    (to) => {
      expect(planRefusal(to, false)).toBeUndefined();
    },
  );
});

const OPEN_PR: BoardPr = { stage: "awaiting-review", needsHumanReview: false };
const MERGE_READY_PR: BoardPr = { stage: "awaiting-merge", needsHumanReview: false };

describe("the board's groups", () => {
  // Shaping, Building, Landing, with Blocked between Building and Landing
  // (docs/refinements/issue-flow.md, "The board").
  it("orders nine columns into three groups with Blocked standing alone", () => {
    expect(BOARD_GROUPS.map((g) => g.id)).toEqual(["shaping", "building", "landing"]);
    expect(BOARD_COLUMNS.map((col) => `${col.group ?? "-"}:${col.id}`)).toEqual([
      "shaping:drafting",
      "shaping:requirements-review",
      "shaping:planning",
      "shaping:awaiting-plan-review",
      "building:approved",
      "building:in-progress",
      "-:blocked",
      "landing:awaiting-merge",
      "landing:done",
    ]);
  });

  it("marks the columns waiting on the operator, which are the ones that start open", () => {
    expect(BOARD_COLUMNS.filter((col) => col.waits).map((col) => col.id)).toEqual(["requirements-review", "awaiting-plan-review", "blocked", "awaiting-merge"]);
  });

  it("marks the two flight columns derived and the human gates as gates", () => {
    expect(DERIVED_COLUMNS).toEqual(["in-progress", "awaiting-merge"]);
    expect(BOARD_COLUMNS.filter((col) => col.gate).map((col) => col.id)).toEqual(["requirements-review", "planning", "awaiting-plan-review", "approved", "done"]);
    for (const col of BOARD_COLUMNS) {
      if (col.derived) expect(col.hint, col.id).toMatch(/— set by Claws, not a drop target$/);
      if (col.gate) expect(col.hint, col.id).toMatch(/— drop (a card )?here( to promote or re-plan| to close it as not planned)?$/);
    }
  });
});

describe("the requirements columns", () => {
  // Derived from the requirements state, never stored: both stand for the
  // `ideas` lifecycle (#clw_01M4698S2SM46GKS36G1V5BH57).
  it("puts an `ideas` issue in Requirements review once its latest version waits on a person", () => {
    expect(columnFor({ labels: [], lifecycle: "ideas", requirementsReview: true })).toBe("requirements-review");
    expect(columnFor({ labels: [], lifecycle: "ideas", requirementsReview: false })).toBe("drafting");
  });

  it("lets a state label or the flight outrank Requirements review", () => {
    expect(columnFor({ labels: [LABELS.blocked], requirementsReview: true })).toBe("blocked");
    expect(columnFor({ labels: [], requirementsReview: true, openPrs: [OPEN_PR] })).toBe("in-progress");
  });

  it("marks Drafting as set by Claws, with the derived columns, and not as a gate", () => {
    expect(REQUIREMENTS_COLUMNS).toEqual(["drafting", "requirements-review"]);
    expect(BOARD_COLUMNS.filter((col) => col.claws).map((col) => col.id)).toEqual(["drafting", "in-progress", "awaiting-merge"]);
    const drafting = BOARD_COLUMNS.find((col) => col.id === "drafting")!;
    expect(drafting.gate).toBe(false);
    expect(drafting.derived).toBe(false);
  });

  it("counts a landing in either requirements column as landed for the other", () => {
    expect(isRequirementsColumn("drafting")).toBe(true);
    expect(isRequirementsColumn("requirements-review")).toBe(true);
    expect(isRequirementsColumn("ideas")).toBe(false);
    expect(landsIn("drafting", "requirements-review")).toBe(true);
    expect(landsIn("requirements-review", "drafting")).toBe(true);
    expect(landsIn("planning", "planning")).toBe(true);
    expect(landsIn("in-progress", "drafting")).toBe(false);
    expect(landsIn("planning", "requirements-review")).toBe(false);
  });

  it("names `ideas` by Requirements review and every other lifecycle by itself", () => {
    expect(destinationForLifecycle("ideas")).toBe("requirements-review");
    expect(destinationForLifecycle("planning")).toBe("planning");
    expect(destinationForLifecycle("backlog")).toBe("backlog");
  });
});

describe("columnFor", () => {
  // #clw_01M52GPG0E9DP8RQKW6ABH0X7R
  it("keeps a forge issue awaiting import out of every gate column", () => {
    expect(columnFor({ labels: [LABELS.ready], awaitingImport: true })).toBe("drafting");
    expect(columnFor({ labels: [LABELS.refined], awaitingImport: true })).toBe("drafting");
    expect(columnFor({ labels: [], lifecycle: "planning", awaitingImport: true })).toBe("drafting");
    expect(columnFor({ labels: [], requirementsReview: true, awaitingImport: true })).toBe("drafting");
    expect(columnFor({ labels: [LABELS.blocked], awaitingImport: true })).toBe("blocked");
    expect(columnFor({ labels: [], implementing: true, awaitingImport: true })).toBe("in-progress");
    expect(columnFor({ labels: [], openPrs: [{ stage: "awaiting-merge", needsHumanReview: false }], awaitingImport: true })).toBe("awaiting-merge");
  });

  it("puts an unlabelled issue in Drafting, or in Planning when its lifecycle says so", () => {
    expect(columnFor({ labels: [] })).toBe("drafting");
    expect(columnFor({ labels: [LABELS.priority] })).toBe("drafting");
    expect(columnFor({ labels: [], lifecycle: "ideas" })).toBe("drafting");
    expect(columnFor({ labels: [], lifecycle: "planning" })).toBe("planning");
    expect(columnFor({ labels: [], lifecycle: "planning", requirementsReview: true })).toBe("planning");
    // A state label outranks the stored stage.
    expect(columnFor({ labels: [LABELS.ready], lifecycle: "planning" })).toBe("awaiting-plan-review");
  });

  it("maps each lifecycle label to its column", () => {
    expect(columnFor({ labels: [LABELS.ready] })).toBe("awaiting-plan-review");
    expect(columnFor({ labels: [LABELS.refined] })).toBe("approved");
    expect(columnFor({ labels: [LABELS.blocked] })).toBe("blocked");
  });

  it("has one In progress column in place of Implementing and PR progressing", () => {
    const ids: string[] = BOARD_COLUMNS.map((col) => col.id);
    expect(ids).toContain("in-progress");
    expect(ids).not.toContain("implementing");
    expect(ids).not.toContain("pr-progressing");
    expect(columnFor({ labels: [], implementing: true })).toBe("in-progress");
    expect(columnFor({ labels: [], openPrs: [OPEN_PR] })).toBe("in-progress");
    expect(columnFor({ labels: [], implementing: true, openPrs: [OPEN_PR] })).toBe("in-progress");
    expect(columnFor({ labels: [LABELS.blocked], openPrs: [OPEN_PR] })).toBe("blocked");
  });

  it("puts an issue with a running implementer in In progress", () => {
    expect(columnFor({ labels: [], implementing: true })).toBe("in-progress");
    expect(columnFor({ labels: [LABELS.ready], implementing: true })).toBe("in-progress");
  });

  it("puts an issue with open PR rows in In progress, or Awaiting merge when every row is there", () => {
    expect(columnFor({ labels: [], openPrs: [OPEN_PR] })).toBe("in-progress");
    expect(columnFor({ labels: [], openPrs: [MERGE_READY_PR] })).toBe("awaiting-merge");
    expect(columnFor({ labels: [], openPrs: [MERGE_READY_PR, MERGE_READY_PR] })).toBe("awaiting-merge");
    expect(columnFor({ labels: [], openPrs: [MERGE_READY_PR, OPEN_PR] })).toBe("in-progress");
    expect(columnFor({ labels: [], openPrs: [] })).toBe("drafting");
  });

  // A PR that cannot move on until a person acts has no column of its own:
  // its issue is parked in Blocked (pr-stall-park.ts), which outranks it, and
  // until then the card stays in In progress (#clw_01M4TJEHAP19S2N3SE6EHE6VNA).
  it.each([
    ["at problematic", { stage: "problematic", needsHumanReview: false }],
    ["with CI blocked", { stage: "ci-failing", needsHumanReview: false, ciBlockedReason: "billing" }],
  ] as const)("puts an issue with a PR %s in In progress, or Blocked once parked", (_name, pr: BoardPr) => {
    expect(isStalledPr(pr)).toBe(true);
    expect(columnFor({ labels: [], openPrs: [pr] })).toBe("in-progress");
    expect(columnFor({ labels: [LABELS.blocked], openPrs: [pr] })).toBe("blocked");
  });

  it.each(["opened", "ci-failing", "awaiting-review", "addressing-review"])("keeps a PR at %s in In progress", (stage) => {
    expect(columnFor({ labels: [], openPrs: [{ stage, needsHumanReview: false, manualActionReason: null, ciBlockedReason: null }] })).toBe("in-progress");
  });

  // A hold only gates the merge; when Claws cannot move on past it, the issue
  // itself is parked in Blocked (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK).
  it("does not stall a PR that only carries a hold", () => {
    const held: BoardPr = { stage: "awaiting-review", needsHumanReview: false, manualActionReason: "Set the prod secret" };
    expect(isStalledPr(held)).toBe(false);
    expect(columnFor({ labels: [], openPrs: [held] })).toBe("in-progress");
    expect(columnFor({ labels: [], openPrs: [{ ...MERGE_READY_PR, manualActionReason: "Set the prod secret" }] })).toBe("awaiting-merge");
  });

  it("keeps a PR that only needs a human review in In progress", () => {
    const lgtm: BoardPr = { stage: "awaiting-review", needsHumanReview: true };
    expect(isStalledPr(lgtm)).toBe(false);
    expect(columnFor({ labels: [], openPrs: [lgtm] })).toBe("in-progress");
  });

  it("keeps an issue with a stalled PR beside a merge-ready one out of Awaiting merge", () => {
    const stalled: BoardPr = { stage: "problematic", needsHumanReview: false };
    expect(columnFor({ labels: [], openPrs: [MERGE_READY_PR, stalled] })).toBe("in-progress");
    expect(columnFor({ labels: [], openPrs: [OPEN_PR, stalled] })).toBe("in-progress");
  });

  it("refuses a move into either PR column", () => {
    expect(transitionFor("in-progress")).toBeNull();
  });

  it("puts a design change pending re-approval in Awaiting plan review, below Refined and above its open PRs", () => {
    expect(columnFor({ labels: [], reapprovalPending: true })).toBe("awaiting-plan-review");
    expect(columnFor({ labels: [], openPrs: [OPEN_PR], reapprovalPending: true })).toBe("awaiting-plan-review");
    expect(columnFor({ labels: [], openPrs: [MERGE_READY_PR], reapprovalPending: true })).toBe("awaiting-plan-review");
    expect(columnFor({ labels: [], lifecycle: "planning", awaitingOperator: true, reapprovalPending: true })).toBe("awaiting-plan-review");
    // Refined is the approval, so it outranks the pending flag; so do the
    // states above it in the ladder.
    expect(columnFor({ labels: [LABELS.refined], openPrs: [OPEN_PR], reapprovalPending: true })).toBe("approved");
    expect(columnFor({ labels: [], implementing: true, reapprovalPending: true })).toBe("in-progress");
    expect(columnFor({ labels: [LABELS.blocked], reapprovalPending: true })).toBe("blocked");
    expect(columnFor({ labels: [], closed: true, reapprovalPending: true })).toBe("done");
  });

  it("puts an issue awaiting its operator step in Awaiting merge, below an open PR and Refined", () => {
    expect(columnFor({ labels: [], awaitingOperator: true })).toBe("awaiting-merge");
    expect(columnFor({ labels: [], lifecycle: "planning", awaitingOperator: true })).toBe("awaiting-merge");
    expect(columnFor({ labels: [], openPrs: [OPEN_PR], awaitingOperator: true })).toBe("in-progress");
    expect(columnFor({ labels: [LABELS.refined], awaitingOperator: true })).toBe("approved");
    expect(columnFor({ labels: [], closed: true, awaitingOperator: true })).toBe("done");
  });

  // The Blocked column is the `Blocked` label alone, not the whole of
  // `gh.isParked`. `Claws Staging` parks an issue without moving its card,
  // because the board owns LIFECYCLE_LABELS and nothing else — a move out of
  // Blocked must not silently clear another hold.
  it("leaves an issue parked by another label in its lifecycle column", () => {
    expect(columnFor({ labels: [LABELS.clawsStaging, LABELS.refined] })).toBe("approved");
    expect(columnFor({ labels: [LABELS.clawsStaging, LABELS.ready] })).toBe("awaiting-plan-review");
    expect(columnFor({ labels: [LABELS.clawsStaging] })).toBe("drafting");
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
  it("ranks Blocked over In progress over Refined over an open PR over Ready", () => {
    const all = { labels: [LABELS.blocked, LABELS.refined, LABELS.ready], implementing: true, openPrs: [OPEN_PR] };
    expect(columnFor(all)).toBe("blocked");
    expect(columnFor({ ...all, labels: [LABELS.refined, LABELS.ready] })).toBe("in-progress");
    expect(columnFor({ ...all, labels: [LABELS.refined, LABELS.ready], implementing: false })).toBe("approved");
    expect(columnFor({ ...all, labels: [LABELS.ready], implementing: false })).toBe("in-progress");
  });

  // Backlog is a destination, not a column (#3293): it outranks every other
  // label and the flight, but closed and unassigned still win.
  it("takes a Backlog issue off the board, over every other label", () => {
    expect(columnFor({ labels: [LABELS.backlog] })).toBe("backlog");
    expect(columnFor({ labels: [LABELS.backlog, LABELS.blocked, LABELS.refined, LABELS.ready], implementing: true, openPrs: [OPEN_PR] })).toBe("backlog");
    expect(columnFor({ labels: [LABELS.backlog], closed: true })).toBe("done");
    expect(columnFor({ labels: [LABELS.backlog], unassigned: true })).toBe("drafting");
  });

  it("parks an unassigned native issue in Drafting, labels, lifecycle and requirements notwithstanding", () => {
    expect(columnFor({ labels: [LABELS.refined], unassigned: true })).toBe("drafting");
    expect(columnFor({ labels: [], unassigned: true, lifecycle: "planning" })).toBe("drafting");
    expect(columnFor({ labels: [], unassigned: true, requirementsReview: true })).toBe("drafting");
    // Still Done if it is closed: the issue is finished either way.
    expect(columnFor({ labels: [LABELS.refined], unassigned: true, closed: true })).toBe("done");
  });
});

describe("transitionFor", () => {
  it("clears every lifecycle label on a move to either requirements column or Planning, and says which", () => {
    expect(transitionFor("drafting")).toEqual({ add: [], remove: [...LIFECYCLE_LABELS], close: false, lifecycle: "ideas" });
    expect(transitionFor("requirements-review")).toEqual({ add: [], remove: [...LIFECYCLE_LABELS], close: false, lifecycle: "ideas" });
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
          const requirementsReview = col.id === "requirements-review";
          expect(columnAfterMove(move, { labels, lifecycle, requirementsReview }), `[${labels.join(", ")}] (${lifecycle}) → ${col.id}`).toBe(col.id);
        }
      }
    }
  });

  // With the issue in flight the invariant is weaker, and deliberately so: no
  // move touches the task or the PR, so only the destinations that outrank the
  // flight in `columnFor` are reachable. The rest land back in a derived
  // column, which the route turns into a 409.
  it.each([
    ["a running implementer", { implementing: true }, { drafting: "in-progress", "requirements-review": "in-progress", planning: "in-progress", "awaiting-plan-review": "in-progress", approved: "in-progress", blocked: "blocked" }],
    ["an open PR", { openPrs: [OPEN_PR] }, { drafting: "in-progress", "requirements-review": "in-progress", planning: "in-progress", "awaiting-plan-review": "in-progress", approved: "approved", blocked: "blocked" }],
    ["a merge-ready PR", { openPrs: [MERGE_READY_PR] }, { drafting: "awaiting-merge", "requirements-review": "awaiting-merge", planning: "awaiting-merge", "awaiting-plan-review": "awaiting-merge", approved: "approved", blocked: "blocked" }],
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
  function moveTo(column: "drafting" | "requirements-review" | "planning" | "awaiting-plan-review" | "approved" | "blocked" | "done" | "backlog") {
    return transitionFor(column)!;
  }

  it("reaches the column that was asked for, for an ordinary issue", () => {
    for (const col of BOARD_COLUMNS) {
      const move = transitionFor(col.id);
      if (!move) continue;
      expect(columnAfterMove(move, { labels: [], requirementsReview: col.id === "requirements-review" })).toBe(col.id);
    }
  });

  // The labels the issue is really holding, not the ones the move adds: a label
  // the board does not own survives the move and can outrank what it adds.
  it("computes the landing column from the issue's own labels", () => {
    // The old label the move removes is gone, so the new one decides.
    expect(columnAfterMove(moveTo("awaiting-plan-review"), { labels: [LABELS.blocked] })).toBe("awaiting-plan-review");
    // The requirements columns and Planning share their (empty) labels: the
    // move's stage decides, and the requirements state picks between the two.
    expect(columnAfterMove(moveTo("planning"), { labels: [LABELS.ready], lifecycle: "ideas" })).toBe("planning");
    expect(columnAfterMove(moveTo("drafting"), { labels: [], lifecycle: "planning" })).toBe("drafting");
    expect(columnAfterMove(moveTo("drafting"), { labels: [], lifecycle: "planning", requirementsReview: true })).toBe("requirements-review");
    expect(columnAfterMove(moveTo("requirements-review"), { labels: [], lifecycle: "planning" })).toBe("drafting");
    // A labelled move keeps the stored stage, which its label outranks.
    expect(columnAfterMove(moveTo("approved"), { labels: [], lifecycle: "planning" })).toBe("approved");
    // A label the board leaves alone rides along without changing the outcome.
    expect(columnAfterMove(moveTo("approved"), { labels: [LABELS.planDeep] })).toBe("approved");
  });

  // The flight rides through the move, so it decides what lands.
  it("carries the issue's flight through the move", () => {
    expect(columnAfterMove(moveTo("approved"), { labels: [], openPrs: [OPEN_PR] })).toBe("approved");
    expect(columnAfterMove(moveTo("approved"), { labels: [], implementing: true })).toBe("in-progress");
    expect(columnAfterMove(moveTo("blocked"), { labels: [], implementing: true })).toBe("blocked");
    expect(columnAfterMove(moveTo("drafting"), { labels: [LABELS.refined], openPrs: [MERGE_READY_PR] })).toBe("awaiting-merge");
    expect(columnAfterMove(moveTo("done"), { labels: [], implementing: true })).toBe("done");
  });

  // The half transitionFor cannot promise: columnFor parks an unassigned issue
  // in Ideas whatever labels the move applies, so the route has to compute
  // the landing column rather than trust the transition's shape.
  it("keeps an unassigned issue in Drafting whatever the move adds", () => {
    expect(columnAfterMove(moveTo("approved"), { labels: [], unassigned: true })).toBe("drafting");
    expect(columnAfterMove(moveTo("blocked"), { labels: [], unassigned: true })).toBe("drafting");
    expect(columnAfterMove(moveTo("requirements-review"), { labels: [], unassigned: true, requirementsReview: true })).toBe("drafting");
    expect(columnAfterMove(moveTo("planning"), { labels: [], unassigned: true })).toBe("drafting");
    expect(columnAfterMove(moveTo("backlog"), { labels: [], unassigned: true })).toBe("drafting");
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
    expect(isBoardColumn("implementing")).toBe(false);
    expect(isBoardColumn("pr-progressing")).toBe(false);
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

describe("closeReasonLabel", () => {
  it("reads completed and not_planned back as operator-facing text, and anything else as none", () => {
    expect(closeReasonLabel("completed")).toBe("Completed");
    expect(closeReasonLabel("not_planned")).toBe("Not planned");
    expect(closeReasonLabel(null)).toBe("");
    expect(closeReasonLabel(undefined)).toBe("");
    expect(closeReasonLabel("")).toBe("");
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
