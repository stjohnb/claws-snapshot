import { describe, it, expect } from "vitest";
import { APPROVED_NEEDS_PLAN_REJECTION, BACKLOG_DESTINATION, BOARD_COLUMNS, BOARD_GROUPS, DERIVED_COLUMNS, DERIVED_COLUMN_REJECTION, FORGE_REOPEN_REJECTION, LIFECYCLE_LABELS, REVIEW_NEEDS_PLAN_REJECTION, UNASSIGNED_REJECTION, backlogRefusal, closeReasonLabel, columnAfterMove, columnFor, destinationForLifecycle, isBoardColumn, isBoardDestination, isRequirementsColumn, isStalledPr, landsIn, planRefusal, REQUIREMENTS_COLUMNS, transitionFor, type BoardDestination, type BoardPr } from "./issue-board.js";
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
  it("orders eleven columns into three groups with Blocked standing alone", () => {
    expect(BOARD_GROUPS.map((g) => g.id)).toEqual(["shaping", "building", "landing"]);
    expect(BOARD_COLUMNS.map((col) => `${col.group ?? "-"}:${col.id}`)).toEqual([
      "shaping:drafting",
      "shaping:requirements-review",
      "shaping:planning",
      "shaping:awaiting-plan-review",
      "building:approved",
      "building:implementing",
      "building:pr-progressing",
      "building:pr-stalled",
      "-:blocked",
      "landing:awaiting-merge",
      "landing:done",
    ]);
  });

  it("marks the columns waiting on the operator, which are the ones that start open", () => {
    expect(BOARD_COLUMNS.filter((col) => col.waits).map((col) => col.id)).toEqual(["requirements-review", "awaiting-plan-review", "pr-stalled", "blocked", "awaiting-merge"]);
  });

  it("marks the four flight columns derived and the human gates as gates", () => {
    expect(DERIVED_COLUMNS).toEqual(["implementing", "pr-progressing", "pr-stalled", "awaiting-merge"]);
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
    expect(columnFor({ labels: [], requirementsReview: true, openPrs: [OPEN_PR] })).toBe("pr-progressing");
  });

  it("marks Drafting as set by Claws, with the derived columns, and not as a gate", () => {
    expect(REQUIREMENTS_COLUMNS).toEqual(["drafting", "requirements-review"]);
    expect(BOARD_COLUMNS.filter((col) => col.claws).map((col) => col.id)).toEqual(["drafting", "implementing", "pr-progressing", "pr-stalled", "awaiting-merge"]);
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
    expect(landsIn("pr-progressing", "drafting")).toBe(false);
    expect(landsIn("planning", "requirements-review")).toBe(false);
  });

  it("names `ideas` by Requirements review and every other lifecycle by itself", () => {
    expect(destinationForLifecycle("ideas")).toBe("requirements-review");
    expect(destinationForLifecycle("planning")).toBe("planning");
    expect(destinationForLifecycle("backlog")).toBe("backlog");
  });
});

describe("columnFor", () => {
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

  it("puts an issue with a running implementer in Implementing", () => {
    expect(columnFor({ labels: [], implementing: true })).toBe("implementing");
    expect(columnFor({ labels: [LABELS.ready], implementing: true })).toBe("implementing");
  });

  it("puts an issue with open PR rows in PR progressing, or Awaiting merge when every row is there", () => {
    expect(columnFor({ labels: [], openPrs: [OPEN_PR] })).toBe("pr-progressing");
    expect(columnFor({ labels: [], openPrs: [MERGE_READY_PR] })).toBe("awaiting-merge");
    expect(columnFor({ labels: [], openPrs: [MERGE_READY_PR, MERGE_READY_PR] })).toBe("awaiting-merge");
    expect(columnFor({ labels: [], openPrs: [MERGE_READY_PR, OPEN_PR] })).toBe("pr-progressing");
    expect(columnFor({ labels: [], openPrs: [] })).toBe("drafting");
  });

  // A PR that cannot move on until a person acts puts the card in PR stalled;
  // anything automation is still moving keeps it in PR progressing.
  it.each([
    ["at manual-action", { stage: "manual-action", needsHumanReview: false }],
    ["at problematic", { stage: "problematic", needsHumanReview: false }],
    ["with a Manual Action reason", { stage: "awaiting-review", needsHumanReview: false, manualActionReason: "reviewer escalation" }],
    ["with CI blocked", { stage: "ci-failing", needsHumanReview: false, ciBlockedReason: "billing" }],
  ] as const)("puts an issue with a PR %s in PR stalled", (_name, pr: BoardPr) => {
    expect(isStalledPr(pr)).toBe(true);
    expect(columnFor({ labels: [], openPrs: [pr] })).toBe("pr-stalled");
  });

  it.each(["opened", "ci-failing", "awaiting-review", "addressing-review"])("keeps a PR at %s in PR progressing", (stage) => {
    expect(columnFor({ labels: [], openPrs: [{ stage, needsHumanReview: false, manualActionReason: null, ciBlockedReason: null }] })).toBe("pr-progressing");
  });

  it("keeps a PR that only needs a human review in PR progressing", () => {
    const lgtm: BoardPr = { stage: "awaiting-review", needsHumanReview: true };
    expect(isStalledPr(lgtm)).toBe(false);
    expect(columnFor({ labels: [], openPrs: [lgtm] })).toBe("pr-progressing");
  });

  it("puts an issue in PR stalled when any of its PRs is, even beside a merge-ready one", () => {
    const stalled: BoardPr = { stage: "manual-action", needsHumanReview: false };
    expect(columnFor({ labels: [], openPrs: [MERGE_READY_PR, stalled] })).toBe("pr-stalled");
    expect(columnFor({ labels: [], openPrs: [OPEN_PR, stalled] })).toBe("pr-stalled");
    // The card follows the PR's state with no move: clear the reason and it is progressing again.
    expect(columnFor({ labels: [], openPrs: [OPEN_PR, { ...stalled, stage: "addressing-review" }] })).toBe("pr-progressing");
  });

  it("refuses a move into either PR column", () => {
    expect(transitionFor("pr-progressing")).toBeNull();
    expect(transitionFor("pr-stalled")).toBeNull();
  });

  it("puts a design change pending re-approval in Awaiting plan review, below Refined and above its open PRs", () => {
    expect(columnFor({ labels: [], reapprovalPending: true })).toBe("awaiting-plan-review");
    expect(columnFor({ labels: [], openPrs: [OPEN_PR], reapprovalPending: true })).toBe("awaiting-plan-review");
    expect(columnFor({ labels: [], openPrs: [MERGE_READY_PR], reapprovalPending: true })).toBe("awaiting-plan-review");
    expect(columnFor({ labels: [], lifecycle: "planning", awaitingOperator: true, reapprovalPending: true })).toBe("awaiting-plan-review");
    // Refined is the approval, so it outranks the pending flag; so do the
    // states above it in the ladder.
    expect(columnFor({ labels: [LABELS.refined], openPrs: [OPEN_PR], reapprovalPending: true })).toBe("approved");
    expect(columnFor({ labels: [], implementing: true, reapprovalPending: true })).toBe("implementing");
    expect(columnFor({ labels: [LABELS.blocked], reapprovalPending: true })).toBe("blocked");
    expect(columnFor({ labels: [], closed: true, reapprovalPending: true })).toBe("done");
  });

  it("puts an issue awaiting its operator step in Awaiting merge, below an open PR and Refined", () => {
    expect(columnFor({ labels: [], awaitingOperator: true })).toBe("awaiting-merge");
    expect(columnFor({ labels: [], lifecycle: "planning", awaitingOperator: true })).toBe("awaiting-merge");
    expect(columnFor({ labels: [], openPrs: [OPEN_PR], awaitingOperator: true })).toBe("pr-progressing");
    expect(columnFor({ labels: [LABELS.refined], awaitingOperator: true })).toBe("approved");
    expect(columnFor({ labels: [], closed: true, awaitingOperator: true })).toBe("done");
  });

  // The Blocked column is the `Blocked` label alone, not the whole of
  // `gh.isParked`. `Claws Ignore` and `Claws Staging` park an issue without
  // moving its card, because the board owns LIFECYCLE_LABELS and nothing else —
  // a move out of Blocked must not silently un-ignore an issue.
  it("leaves an issue parked by another label in its lifecycle column", () => {
    expect(columnFor({ labels: [LABELS.clawsIgnore, LABELS.refined] })).toBe("approved");
    expect(columnFor({ labels: [LABELS.clawsStaging, LABELS.ready] })).toBe("awaiting-plan-review");
    expect(columnFor({ labels: [LABELS.clawsIgnore] })).toBe("drafting");
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
    expect(columnFor({ ...all, labels: [LABELS.ready], implementing: false })).toBe("pr-progressing");
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
    ["a running implementer", { implementing: true }, { drafting: "implementing", "requirements-review": "implementing", planning: "implementing", "awaiting-plan-review": "implementing", approved: "implementing", blocked: "blocked" }],
    ["an open PR", { openPrs: [OPEN_PR] }, { drafting: "pr-progressing", "requirements-review": "pr-progressing", planning: "pr-progressing", "awaiting-plan-review": "pr-progressing", approved: "approved", blocked: "blocked" }],
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
    expect(columnAfterMove(moveTo("approved"), { labels: [LABELS.clawsIgnore] })).toBe("approved");
  });

  // The flight rides through the move, so it decides what lands.
  it("carries the issue's flight through the move", () => {
    expect(columnAfterMove(moveTo("approved"), { labels: [], openPrs: [OPEN_PR] })).toBe("approved");
    expect(columnAfterMove(moveTo("approved"), { labels: [], implementing: true })).toBe("implementing");
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
