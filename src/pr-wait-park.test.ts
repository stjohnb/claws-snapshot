import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockGh, mockHandback, mockPrHold, prStates } = vi.hoisted(() => {
  const prStates = new Map<string, string | null>();
  return {
    prStates,
    mockDb: {
      listPrWaitParkCandidates: vi.fn(async () => [] as { id: string; blocked_reason: string }[]),
      getIssuePlannedPRs: vi.fn(async (_id: string) => [] as unknown[]),
      setIssuePlannedPRTarget: vi.fn(async () => undefined),
    },
    mockGh: {
      getPRState: vi.fn(async (repo: string, n: number) => prStates.get(`${repo}#${n}`) ?? null),
      getIssueState: vi.fn(),
      removeLabel: vi.fn(async () => true),
      commentOnIssue: vi.fn(async () => undefined),
    },
    mockHandback: { parkForHuman: vi.fn(async () => undefined) },
    mockPrHold: { issueRefForTracker: vi.fn() },
  };
});

vi.mock("./config.js", () => ({ LABELS: { blocked: "Blocked", refined: "Refined", ready: "Ready" } }));
vi.mock("./db.js", () => mockDb);
vi.mock("./github.js", () => mockGh);
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./issue-handback.js", () => mockHandback);
vi.mock("./pr-hold.js", () => mockPrHold);

import * as log from "./log.js";
import { parsePrWaitReason, prWaitReason, prWaitSlug, releasePrWaitParks } from "./pr-wait-park.js";

const REPO = "St-John-Software/bonkus";
const ISSUE = { repo: REPO, ref: "clw_ISSUE" };
const ONE = [{ repo: REPO, number: 3 }];
const TWO = [{ repo: "org/lib", number: 9 }, { repo: REPO, number: 3 }];

beforeEach(() => {
  vi.clearAllMocks();
  prStates.clear();
  mockPrHold.issueRefForTracker.mockResolvedValue(ISSUE);
  mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Blocked"] });
  mockDb.listPrWaitParkCandidates.mockResolvedValue([]);
  mockDb.getIssuePlannedPRs.mockResolvedValue([]);
});

describe("the PR-wait reason", () => {
  it("names each PR by its full repo", () => {
    expect(prWaitReason(ONE)).toBe("Waiting on `St-John-Software/bonkus#3` to merge");
    expect(prWaitReason(TWO)).toBe("Waiting on `St-John-Software/bonkus#3` and `org/lib#9` to merge");
    expect(prWaitReason([...TWO, { repo: "org/lib", number: 1 }, ...ONE]))
      .toBe("Waiting on `St-John-Software/bonkus#3`, `org/lib#1` and `org/lib#9` to merge");
  });

  it("parses back to its PRs", () => {
    expect(parsePrWaitReason(prWaitReason(ONE))).toEqual(ONE);
    expect(parsePrWaitReason(prWaitReason(TWO))).toEqual([{ repo: REPO, number: 3 }, { repo: "org/lib", number: 9 }]);
    expect(parsePrWaitReason(prWaitReason([...TWO, { repo: "org/lib", number: 1 }]))).toHaveLength(3);
  });

  it("does not match the PR-stall or any other reason", () => {
    expect(parsePrWaitReason("PR `org/app#7` exhausted its CI-fix budget: unmark it problematic.")).toBeNull();
    expect(parsePrWaitReason("Waiting on the vendor")).toBeNull();
    expect(parsePrWaitReason(null)).toBeNull();
  });

  it("has one slug per distinct PR set, whatever the order", () => {
    expect(prWaitSlug(TWO)).toBe("waiting-on-prs-St-John-Software-bonkus-3-org-lib-9");
    expect(prWaitSlug([...TWO].reverse())).toBe(prWaitSlug(TWO));
    expect(prWaitSlug(ONE)).not.toBe(prWaitSlug(TWO));
  });
});

describe("releasePrWaitParks", () => {
  const parkedOn = (reason: string) => mockDb.listPrWaitParkCandidates.mockResolvedValue([{ id: "clw_ISSUE", blocked_reason: reason }]);

  it("leaves the park while any PR is open", async () => {
    parkedOn(prWaitReason(TWO));
    prStates.set(`${REPO}#3`, "MERGED");
    prStates.set("org/lib#9", "OPEN");
    await releasePrWaitParks();
    expect(mockGh.getIssueState).not.toHaveBeenCalled();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
    expect(mockHandback.parkForHuman).not.toHaveBeenCalled();
  });

  it("leaves the park, with a warning, when a PR cannot be read", async () => {
    parkedOn(prWaitReason(ONE));
    await releasePrWaitParks();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Could not read St-John-Software/bonkus#3"));
  });

  it("releases the issue with one comment once every PR has merged", async () => {
    parkedOn(prWaitReason(ONE));
    prStates.set(`${REPO}#3`, "MERGED");
    await releasePrWaitParks();
    expect(mockGh.removeLabel).toHaveBeenCalledWith(REPO, "clw_ISSUE", "Blocked");
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(REPO, "clw_ISSUE",
      "`St-John-Software/bonkus#3` merged, so Claws has moved this issue out of `Blocked` and will continue with its next step.",
      { agentName: "PR Dispatcher" });
    expect(mockHandback.parkForHuman).not.toHaveBeenCalled();
  });

  it("does not release an issue a live read shows already out of Blocked", async () => {
    parkedOn(prWaitReason(ONE));
    prStates.set(`${REPO}#3`, "MERGED");
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
    await releasePrWaitParks();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("hands the issue to a person and clears the step's target when a PR closed unmerged", async () => {
    parkedOn(prWaitReason(ONE));
    prStates.set(`${REPO}#3`, "CLOSED");
    mockDb.getIssuePlannedPRs.mockResolvedValue([
      { position: 1, repo: REPO, title: "Rides", prNumber: 3, dependsOn: null, kind: "pr", manualAction: null, targetPrNumber: 3 },
      { position: 2, repo: REPO, title: "Operator", prNumber: null, dependsOn: [1], kind: "manual", manualAction: "do it" },
    ]);
    await releasePrWaitParks();
    expect(mockDb.setIssuePlannedPRTarget).toHaveBeenCalledWith("clw_ISSUE", 1, null);
    expect(mockHandback.parkForHuman).toHaveBeenCalledWith(REPO, "clw_ISSUE",
      "PR `St-John-Software/bonkus#3` closed without merging, so step 1 of 2 has no PR: re-plan the issue, or move it to Approved to implement the step afresh.",
      "PR Dispatcher", { slug: "waited-pr-closed-St-John-Software-bonkus-3" });
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  // The query returns only current reasons, so an overwritten reason or a
  // stage change after the park never reaches here; any other reason is not ours.
  it("never releases an issue whose current reason is another park's", async () => {
    parkedOn("PR `org/app#7` exhausted its CI-fix budget: …");
    await releasePrWaitParks();
    expect(mockGh.getPRState).not.toHaveBeenCalled();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("logs one issue's failure and carries on", async () => {
    mockDb.listPrWaitParkCandidates.mockResolvedValue([
      { id: "clw_BAD", blocked_reason: prWaitReason(ONE) },
      { id: "clw_ISSUE", blocked_reason: prWaitReason(ONE) },
    ]);
    prStates.set(`${REPO}#3`, "MERGED");
    mockPrHold.issueRefForTracker.mockRejectedValueOnce(new Error("boom"));
    await releasePrWaitParks();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("clw_BAD"));
    expect(mockGh.removeLabel).toHaveBeenCalledTimes(1);
  });
});
