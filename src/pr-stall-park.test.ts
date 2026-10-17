import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockGh, mockHandback, mockPrHold, rows } = vi.hoisted(() => {
  const rows = new Map<string, unknown>();
  return {
    rows,
    mockDb: {
      getClawsPr: vi.fn(async (repo: string, n: number) => rows.get(`${repo}#${n}`) ?? null),
      listPrStallParkCandidates: vi.fn(async () => [] as { id: string; blocked_reason: string }[]),
      listOpenClawsPrsForIssue: vi.fn(async (_id: string) => [] as unknown[]),
    },
    mockGh: {
      getIssueState: vi.fn(),
      removeLabel: vi.fn(async () => true),
      commentOnIssue: vi.fn(async () => undefined),
    },
    mockHandback: { parkForHuman: vi.fn(async () => undefined) },
    mockPrHold: {
      linkedIssue: vi.fn(),
      issueRefForTracker: vi.fn(),
    },
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

import type { ClawsPrRecord } from "./db.js";
import * as log from "./log.js";
import { parsePrStallReason, prStallReason, prStallSlug, releasePrStallParks, settlePrStallPark } from "./pr-stall-park.js";

const REPO = "org/app";
const ISSUE = { repo: REPO, ref: "clw_ISSUE" };
const pr = { number: 7, headRefName: "claws/issue-clw_ISSUE-abcd" };

function prRow(fields: Partial<ClawsPrRecord> = {}): ClawsPrRecord {
  return {
    repo: REPO, prNumber: 7, issueId: "clw_ISSUE", phase: 1, headSha: "abc", observedAt: null,
    stage: "awaiting-review", ciStatus: "failing", mergeableState: null, reviewVerdict: null, reviewedSha: null,
    mergeApprovedBy: null, mergeApprovedAt: null, manualActionReason: null, needsHumanReview: false,
    ciBlockedReason: null, title: null, dispatchNote: null, dispatchNoteAt: null, createdAt: "", updatedAt: "",
    ...fields,
  };
}

const PROBLEMATIC_REASON = prStallReason(REPO, 7, "problematic");
const BILLING_REASON = prStallReason(REPO, 7, "ci-blocked", "billing");

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  mockPrHold.linkedIssue.mockResolvedValue(ISSUE);
  mockPrHold.issueRefForTracker.mockResolvedValue(ISSUE);
  mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Blocked"] });
  mockDb.listPrStallParkCandidates.mockResolvedValue([]);
  mockDb.listOpenClawsPrsForIssue.mockResolvedValue([]);
});

describe("the PR-stall reason", () => {
  it("names the PR, why it is stuck and how to resume", () => {
    expect(PROBLEMATIC_REASON).toBe("PR `org/app#7` exhausted its CI-fix budget: unmark it problematic (PRs page or claws_unmark_problematic) or fix CI by hand. Claws moves this issue out of Blocked on its own once the PR is back in the normal flow.");
    expect(BILLING_REASON).toBe("PR `org/app#7`: CI is blocked: GitHub Actions billing/spending limit. Clear the cause, then remove the Billing label from the PR. Claws moves this issue out of Blocked on its own once CI is unblocked.");
    expect(prStallReason(REPO, 7, "ci-blocked", "runner pool gone")).toContain("CI is blocked: runner pool gone.");
  });

  it("parses back to its PR and cause", () => {
    expect(parsePrStallReason(PROBLEMATIC_REASON)).toEqual({ repo: REPO, prNumber: 7, cause: "problematic" });
    expect(parsePrStallReason(BILLING_REASON)).toEqual({ repo: REPO, prNumber: 7, cause: "ci-blocked" });
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
