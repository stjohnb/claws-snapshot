import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockGh, mockHandback, mockPrHold, mockPlannedPrs, rows } = vi.hoisted(() => {
  const rows = new Map<string, unknown>();
  return {
    rows,
    mockDb: {
      getClawsPr: vi.fn(async (repo: string, n: number) => rows.get(`${repo}#${n}`) ?? null),
      listPrStallParkCandidates: vi.fn(async () => [] as { id: string; blocked_reason: string }[]),
      listOpenClawsPrsForIssue: vi.fn(async (_id: string) => [] as unknown[]),
      hasCiFixerGiveUpOnHead: vi.fn(async (_repo: string, _n: number, _sha: string) => false),
    },
    mockGh: {
      getIssueState: vi.fn(),
      removeLabel: vi.fn(async () => true),
      commentOnIssue: vi.fn(async (_repo: string, _ref: string, _body: string, _opts?: unknown) => undefined),
      getIssueComments: vi.fn(async () => [] as { body: string; login: string }[]),
    },
    mockHandback: {
      parkForHuman: vi.fn(async () => undefined),
      hasActiveAgentWork: vi.fn(async () => false),
      needsHumanMarker: (slug: string) => `claws-needs-human:${slug}`,
      hasNeedsHumanMarker: (comments: { body: string }[], slug: string) =>
        comments.some((c) => c.body.split("\n").some((line) => line.trim() === `claws-needs-human:${slug}`)),
    },
    mockPrHold: {
      linkedIssue: vi.fn(),
      issueRefForTracker: vi.fn(),
      isOperatorStepHold: (reason: string | null | undefined) => !!reason && !reason.startsWith("Stacked PR:"),
    },
    mockPlannedPrs: { loadIssuePhaseState: vi.fn() },
  };
});

vi.mock("./config.js", () => ({
  LABELS: { blocked: "Blocked", billing: "Billing", refined: "Refined", ready: "Ready", backlog: "Backlog", problematic: "Claws Problematic" },
}));
vi.mock("./db.js", () => mockDb);
vi.mock("./github.js", () => mockGh);
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./issue-handback.js", () => mockHandback);
vi.mock("./pr-hold.js", () => mockPrHold);
vi.mock("./planned-prs.js", () => mockPlannedPrs);

import type { ClawsPrRecord } from "./db.js";
import * as log from "./log.js";
import { operatorStepCiSlug, parsePrStallReason, prStallReason, prStallSlug, releasePrStallParks, settlePrStallPark } from "./pr-stall-park.js";

const REPO = "org/app";
const ISSUE = { repo: REPO, ref: "clw_ISSUE" };
const pr = { number: 7, headRefName: "claws/issue-clw_ISSUE-abcd" };

function prRow(fields: Partial<ClawsPrRecord> = {}): ClawsPrRecord {
  return {
    repo: REPO, prNumber: 7, issueId: "clw_ISSUE", phase: 1, headSha: "abc", observedAt: null,
    stage: "awaiting-review", ciStatus: "failing", mergeableState: null, reviewVerdict: null, reviewedSha: null,
    mergeApprovedBy: null, mergeApprovedAt: null, manualActionReason: null, needsHumanReview: false,
    ciBlockedReason: null, infraMergeApprovedBy: null, infraMergeApprovedAt: null, infraMergeApprovedSha: null, title: null, dispatchNote: null, dispatchNoteAt: null, createdAt: "", updatedAt: "",
    ...fields,
  };
}

const PROBLEMATIC_REASON = prStallReason(REPO, 7, "problematic");
const BILLING_REASON = prStallReason(REPO, 7, "ci-blocked", "billing");
const HOLD = "Run the one-time bootstrap tofu apply,\n then set the AWS_*_ROLE_ARN secrets so the plan job can pass.";
const OPERATOR_STEP_REASON = prStallReason(REPO, 7, "operator-step", HOLD);

/** Phase state of a seven-step plan whose step 2 (PR #7) is open and steps 3–7 depend on it. */
function phaseState(fields: { readyPhases?: readonly number[]; openPhases?: readonly number[]; coveringPRs?: Map<number, { number: number }> } = {}) {
  return {
    totalPhases: 7, entries: null, trackerId: "clw_ISSUE",
    coverage: {
      readyPhases: fields.readyPhases ?? [],
      openPhases: fields.openPhases ?? [2],
      blockedPhases: [3, 4, 5, 6, 7],
      coveringPRs: fields.coveringPRs ?? new Map([[1, { number: 6 }], [2, { number: 7 }]]),
    },
  };
}

/** A PR holding an operator step, CI red, reviewed clean on its head — namey#111. */
function heldRow(fields: Partial<ClawsPrRecord> = {}): ClawsPrRecord {
  return prRow({
    phase: 2, headSha: "dd5fadc0", stage: "ci-failing", ciStatus: "failing", manualActionReason: HOLD,
    reviewVerdict: "approve", reviewedSha: "dd5fadc0", ...fields,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  mockPrHold.linkedIssue.mockResolvedValue(ISSUE);
  mockPrHold.issueRefForTracker.mockResolvedValue(ISSUE);
  mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Blocked"] });
  mockDb.listPrStallParkCandidates.mockResolvedValue([]);
  mockDb.listOpenClawsPrsForIssue.mockResolvedValue([]);
  mockDb.hasCiFixerGiveUpOnHead.mockResolvedValue(false);
  mockGh.getIssueComments.mockResolvedValue([]);
  mockHandback.hasActiveAgentWork.mockResolvedValue(false);
  mockPlannedPrs.loadIssuePhaseState.mockResolvedValue(phaseState());
});

describe("the PR-stall reason", () => {
  it("names the PR, why it is stuck and how to resume", () => {
    expect(PROBLEMATIC_REASON).toBe("PR `org/app#7` exhausted its CI-fix budget: unmark it problematic (PRs page or claws_unmark_problematic) or fix CI by hand. Claws moves this issue out of Blocked on its own once the PR is back in the normal flow.");
    expect(BILLING_REASON).toBe("PR `org/app#7`: CI is blocked: CI spending limit. Clear the cause; removing the Billing label on the forge does nothing. Claws moves this issue out of Blocked on its own once the PR's recorded CI block is cleared.");
    expect(prStallReason(REPO, 7, "ci-blocked", "runner pool gone")).toContain("CI is blocked: runner pool gone.");
  });

  it("parses back to its PR and cause", () => {
    expect(parsePrStallReason(PROBLEMATIC_REASON)).toEqual({ repo: REPO, prNumber: 7, cause: "problematic" });
    expect(parsePrStallReason(BILLING_REASON)).toEqual({ repo: REPO, prNumber: 7, cause: "ci-blocked" });
    expect(parsePrStallReason(OPERATOR_STEP_REASON)).toEqual({ repo: REPO, prNumber: 7, cause: "operator-step" });
  });

  it("names the PR and the hold text on one line for an operator step CI waits on", () => {
    expect(OPERATOR_STEP_REASON).toMatch(/^PR `org\/app#7` cannot pass CI until its operator step is done: Run the one-time bootstrap tofu apply, then set the AWS_\*_ROLE_ARN secrets so the plan job can pass\. Do the step/);
    expect(OPERATOR_STEP_REASON).toContain("claws_clear_pr_manual_action");
    expect(OPERATOR_STEP_REASON).toContain("does not lift the hold");
    expect(OPERATOR_STEP_REASON).not.toContain("\n");
  });

  it("does not match the operator-step reason or any other", () => {
    expect(parsePrStallReason("PR `org/app#7` is ready to merge but waits on an operator step: set the secret.")).toBeNull();
    expect(parsePrStallReason("PR `org/app#7` targets `dev` rather than `main`, and Claws does not stack PRs.")).toBeNull();
    expect(parsePrStallReason("Waiting on the vendor")).toBeNull();
    expect(parsePrStallReason("Waiting on `org/app#7` to merge")).toBeNull();
    expect(parsePrStallReason(null)).toBeNull();
  });

  it("slugs one park per cause and PR", () => {
    expect(prStallSlug(REPO, 7, "problematic")).toBe("pr-stall-problematic-org-app-7");
    expect(prStallSlug(REPO, 7, "ci-blocked")).toBe("pr-stall-ci-blocked-org-app-7");
    expect(prStallSlug(REPO, 7, "operator-step")).toBe("pr-stall-operator-step-org-app-7");
  });
});

describe("settlePrStallPark", () => {
  beforeEach(() => {
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Refined"] });
  });

  it("parks the linked issue when the PR is problematic", async () => {
    await settlePrStallPark(REPO, pr, prRow({ stage: "problematic" }));
    expect(mockHandback.parkForHuman).toHaveBeenCalledWith(REPO, "clw_ISSUE", PROBLEMATIC_REASON, "PR Dispatcher", { slug: "pr-stall-problematic-org-app-7" });
  });

  it("parks the linked issue when the PR is CI-blocked on billing", async () => {
    await settlePrStallPark(REPO, pr, prRow({ ciBlockedReason: "billing" }));
    expect(mockHandback.parkForHuman).toHaveBeenCalledWith(REPO, "clw_ISSUE", BILLING_REASON, "PR Dispatcher", { slug: "pr-stall-ci-blocked-org-app-7" });
  });

  it("lets problematic outrank CI-blocked", async () => {
    await settlePrStallPark(REPO, pr, prRow({ stage: "problematic", ciBlockedReason: "billing" }));
    expect(mockHandback.parkForHuman).toHaveBeenCalledWith(REPO, "clw_ISSUE", PROBLEMATIC_REASON, "PR Dispatcher", expect.anything());
  });

  it("does nothing for a PR that is not stalled", async () => {
    await settlePrStallPark(REPO, pr, prRow({ stage: "awaiting-review", manualActionReason: "set the secret" }));
    expect(mockPrHold.linkedIssue).not.toHaveBeenCalled();
    expect(mockHandback.parkForHuman).not.toHaveBeenCalled();
  });

  it("parks nothing for a PR with no linked issue", async () => {
    mockPrHold.linkedIssue.mockResolvedValue(null);
    await settlePrStallPark(REPO, { number: 9, headRefName: "renovate/foo" }, prRow({ prNumber: 9, issueId: null, stage: "problematic" }));
    expect(mockGh.getIssueState).not.toHaveBeenCalled();
    expect(mockHandback.parkForHuman).not.toHaveBeenCalled();
  });

  // Never overwrites another reason, nor re-parks one already parked.
  it("skips an issue already Blocked, or closed", async () => {
    mockGh.getIssueState.mockResolvedValueOnce({ state: "OPEN", stateReason: null, labels: ["Blocked"] });
    await settlePrStallPark(REPO, pr, prRow({ stage: "problematic" }));
    mockGh.getIssueState.mockResolvedValueOnce({ state: "CLOSED", stateReason: "completed", labels: [] });
    await settlePrStallPark(REPO, pr, prRow({ stage: "problematic" }));
    expect(mockHandback.parkForHuman).not.toHaveBeenCalled();
  });

  // AC7: a person moved the issue out of Blocked while the PR is still
  // problematic — it is re-parked with the same reason and slug, so the
  // `## Needs a human` comment is not posted again.
  it("re-parks an issue moved out of Blocked by hand with the same reason and slug", async () => {
    await settlePrStallPark(REPO, pr, prRow({ stage: "problematic" }));
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
    await settlePrStallPark(REPO, pr, prRow({ stage: "problematic" }));
    expect(mockHandback.parkForHuman).toHaveBeenCalledTimes(2);
    expect(mockHandback.parkForHuman.mock.calls[1]).toEqual(mockHandback.parkForHuman.mock.calls[0]);
  });
});

describe("settlePrStallPark for an operator step CI cannot pass without", () => {
  beforeEach(() => {
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Refined"] });
    mockDb.hasCiFixerGiveUpOnHead.mockResolvedValue(true);
  });

  // The namey#111 shape: seven steps, step 2 held with red CI, steps 3–7
  // all depend on it, the CI fixer gave up on the head and the review passed it.
  it("parks the issue when every remaining step depends on the held PR", async () => {
    await settlePrStallPark(REPO, pr, heldRow());
    expect(mockDb.hasCiFixerGiveUpOnHead).toHaveBeenCalledWith(REPO, 7, "dd5fadc0");
    expect(mockHandback.parkForHuman).toHaveBeenCalledWith(REPO, "clw_ISSUE", OPERATOR_STEP_REASON, "PR Dispatcher",
      { slug: "pr-stall-operator-step-org-app-7", comments: [] });
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it.each([
    ["a step is ready", { readyPhases: [3] }, false],
    ["another step's PR is open", { openPhases: [2, 3], coveringPRs: new Map([[2, { number: 7 }], [3, { number: 8 }]]) }, false],
    ["an implementer is running", {}, true],
  ] as const)("comments once instead of parking when %s", async (_why, state, active) => {
    mockPlannedPrs.loadIssuePhaseState.mockResolvedValue(phaseState(state));
    mockHandback.hasActiveAgentWork.mockResolvedValue(active);
    await settlePrStallPark(REPO, pr, heldRow());
    expect(mockHandback.parkForHuman).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(body).toContain("## Waiting on an operator step");
    expect(body).toContain("PR `org/app#7` (step 2) cannot pass CI until its operator step is done");
    expect(body).toContain(`claws-needs-human:${operatorStepCiSlug(7, HOLD)}`);

    mockGh.getIssueComments.mockResolvedValue([{ body, login: "claws" }]);
    await settlePrStallPark(REPO, pr, heldRow());
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockHandback.parkForHuman).not.toHaveBeenCalled();
  });

  it.each([
    ["the CI fixer has not given up on the head", {}, false],
    ["CI is passing", { ciStatus: "passing" }, true],
    ["CI is pending", { ciStatus: "pending" }, true],
    ["the hold is not an operator step", { manualActionReason: "Stacked PR: base is org/app#6" }, true],
    ["there is no hold", { manualActionReason: null }, true],
  ] as const)("does nothing when %s", async (_why, fields, gaveUp) => {
    mockDb.hasCiFixerGiveUpOnHead.mockResolvedValue(gaveUp);
    await settlePrStallPark(REPO, pr, heldRow(fields as Partial<ClawsPrRecord>));
    expect(mockPrHold.linkedIssue).not.toHaveBeenCalled();
    expect(mockHandback.parkForHuman).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("leaves an issue already Blocked for anything else alone", async () => {
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Blocked"] });
    await settlePrStallPark(REPO, pr, heldRow());
    expect(mockPlannedPrs.loadIssuePhaseState).not.toHaveBeenCalled();
    expect(mockHandback.parkForHuman).not.toHaveBeenCalled();
  });

  // AC5: a person removed Blocked; the hold is untouched and the issue is re-parked with the same slug.
  it("re-parks an issue moved out of Blocked by hand without touching the hold", async () => {
    const row = heldRow();
    await settlePrStallPark(REPO, pr, row);
    await settlePrStallPark(REPO, pr, row);
    expect(mockHandback.parkForHuman).toHaveBeenCalledTimes(2);
    expect(mockHandback.parkForHuman.mock.calls[1]).toEqual(mockHandback.parkForHuman.mock.calls[0]);
    expect(row.manualActionReason).toBe(HOLD);
  });
});

describe("releasePrStallParks", () => {
  const parkedOn = (reason: string) => mockDb.listPrStallParkCandidates.mockResolvedValue([{ id: "clw_ISSUE", blocked_reason: reason }]);

  it("leaves the park while the PR is still stalled", async () => {
    parkedOn(PROBLEMATIC_REASON);
    rows.set(`${REPO}#7`, prRow({ stage: "problematic" }));
    await releasePrStallParks();
    expect(mockGh.getIssueState).not.toHaveBeenCalled();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it.each([
    ["unmarked problematic", PROBLEMATIC_REASON, { stage: "awaiting-review" }],
    ["CI unblocked", BILLING_REASON, { stage: "ci-failing", ciBlockedReason: null }],
    ["merged", PROBLEMATIC_REASON, { stage: "merged" }],
    ["closed", BILLING_REASON, { stage: "closed", ciBlockedReason: "billing" }],
  ] as const)("releases the issue once the PR is %s", async (why, reason, fields) => {
    parkedOn(reason);
    rows.set(`${REPO}#7`, prRow(fields as Partial<ClawsPrRecord>));
    await releasePrStallParks();
    expect(mockGh.removeLabel).toHaveBeenCalledWith(REPO, "clw_ISSUE", "Blocked");
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(REPO, "clw_ISSUE",
      `PR \`org/app#7\` is back in the normal flow (${why}), so Claws has moved this issue out of \`Blocked\`.`,
      { agentName: "PR Dispatcher" });
    expect(mockHandback.parkForHuman).not.toHaveBeenCalled();
  });

  it("leaves an operator-step park while the PR's CI still cannot pass", async () => {
    parkedOn(OPERATOR_STEP_REASON);
    rows.set(`${REPO}#7`, heldRow());
    mockDb.hasCiFixerGiveUpOnHead.mockResolvedValue(true);
    await releasePrStallParks();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  // AC3: released on the next tick, the PR's hold left as it was.
  it.each([
    ["its manual action cleared", { manualActionReason: null }],
    ["CI passing", { ciStatus: "passing", stage: "awaiting-review" }],
    ["merged", { stage: "merged" }],
    ["closed", { stage: "closed" }],
  ] as const)("releases an operator-step park once %s", async (why, fields) => {
    parkedOn(OPERATOR_STEP_REASON);
    const row = heldRow(fields as Partial<ClawsPrRecord>);
    rows.set(`${REPO}#7`, row);
    mockDb.hasCiFixerGiveUpOnHead.mockResolvedValue(true);
    await releasePrStallParks();
    expect(mockGh.removeLabel).toHaveBeenCalledWith(REPO, "clw_ISSUE", "Blocked");
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(REPO, "clw_ISSUE",
      `PR \`org/app#7\` is back in the normal flow (${why}), so Claws has moved this issue out of \`Blocked\`.`,
      { agentName: "PR Dispatcher" });
    expect(row.manualActionReason).toBe("manualActionReason" in fields ? null : HOLD);
  });

  it("re-points a cleared park at another PR whose CI waits on an operator step", async () => {
    parkedOn(PROBLEMATIC_REASON);
    rows.set(`${REPO}#7`, prRow({ stage: "merged" }));
    mockDb.listOpenClawsPrsForIssue.mockResolvedValue([heldRow({ prNumber: 8 })]);
    mockDb.hasCiFixerGiveUpOnHead.mockResolvedValue(true);
    await releasePrStallParks();
    expect(mockHandback.parkForHuman).toHaveBeenCalledWith(REPO, "clw_ISSUE", prStallReason(REPO, 8, "operator-step", HOLD),
      "PR Dispatcher", { slug: "pr-stall-operator-step-org-app-8" });
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("re-points the park at another of the issue's stalled PRs", async () => {
    parkedOn(PROBLEMATIC_REASON);
    rows.set(`${REPO}#7`, prRow({ stage: "merged" }));
    const second = prRow({ repo: "org/lib", prNumber: 3, ciBlockedReason: "billing" });
    mockDb.listOpenClawsPrsForIssue.mockResolvedValue([prRow({ prNumber: 8 }), second]);
    await releasePrStallParks();
    expect(mockHandback.parkForHuman).toHaveBeenCalledWith(REPO, "clw_ISSUE", prStallReason("org/lib", 3, "ci-blocked", "billing"),
      "PR Dispatcher", { slug: "pr-stall-ci-blocked-org-lib-3" });
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  // AC6: the query returns only current reasons; any other current reason is never ours.
  it("never releases an issue whose current reason is another park's", async () => {
    parkedOn("PR `org/app#7` is ready to merge but waits on an operator step: set the secret.");
    rows.set(`${REPO}#7`, prRow({ stage: "awaiting-review" }));
    await releasePrStallParks();
    expect(mockDb.getClawsPr).not.toHaveBeenCalled();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  // A shadow lags its forge issue until the next sync: no second comment.
  it("posts nothing when the live issue is no longer Blocked, or closed", async () => {
    parkedOn(PROBLEMATIC_REASON);
    rows.set(`${REPO}#7`, prRow({ stage: "awaiting-review" }));
    mockGh.getIssueState.mockResolvedValueOnce({ state: "OPEN", stateReason: null, labels: [] });
    await releasePrStallParks();
    mockGh.getIssueState.mockResolvedValueOnce({ state: "CLOSED", stateReason: "completed", labels: ["Blocked"] });
    await releasePrStallParks();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("logs one issue's failure and carries on with the rest", async () => {
    mockDb.listPrStallParkCandidates.mockResolvedValue([
      { id: "clw_A", blocked_reason: PROBLEMATIC_REASON },
      { id: "clw_B", blocked_reason: PROBLEMATIC_REASON },
    ]);
    rows.set(`${REPO}#7`, prRow({ stage: "awaiting-review" }));
    mockPrHold.issueRefForTracker.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce({ repo: REPO, ref: "clw_B" });
    await releasePrStallParks();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("clw_A"));
    expect(mockGh.removeLabel).toHaveBeenCalledWith(REPO, "clw_B", "Blocked");
  });
});
