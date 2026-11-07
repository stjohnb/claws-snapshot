import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
  LABELS: {
    ready: "Ready",
    problematic: "Claws Problematic",
    needsLgtm: "Needs LGTM",
    billing: "Billing",
    automerge: "Automerge",
    priority: "Priority",
  },
}));

vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

const mockDb = vi.hoisted(() => ({
  getClawsPr: vi.fn(),
  upsertClawsPr: vi.fn(),
  listClawsPrs: vi.fn(),
}));
vi.mock("./db.js", () => mockDb);

import * as log from "./log.js";
import type { ClawsPrRecord } from "./db.js";
import {
  applyPrLabelAdded,
  applyPrLabelRemoved,
  hasManualAction,
  infraMergeApproval,
  isAwaitingMerge,
  isMergeApproved,
  isProblematic,
  isReviewedHeadAwaitingMerge,
  markPrAwaitingMerge,
  markPrAwaitingReview,
  needsHumanReview,
} from "./pr-state.js";

function row(overrides: Partial<ClawsPrRecord> = {}): ClawsPrRecord {
  return {
    repo: "org/a", prNumber: 7, issueId: null, phase: null, headSha: null, observedAt: null,
    stage: "awaiting-review", ciStatus: null, mergeableState: null, reviewVerdict: null, reviewedSha: null,
    mergeApprovedBy: null, mergeApprovedAt: null, manualActionReason: null, needsHumanReview: false,
    ciBlockedReason: null, infraMergeApprovedBy: null, infraMergeApprovedAt: null, infraMergeApprovedSha: null, title: null, dispatchNote: null, dispatchNoteAt: null, createdAt: "", updatedAt: "", ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.getClawsPr.mockResolvedValue(null);
  mockDb.upsertClawsPr.mockResolvedValue(undefined);
  mockDb.listClawsPrs.mockResolvedValue([]);
});

describe("applyPrLabelAdded", () => {
  const added = async (label: string, current: Partial<ClawsPrRecord>) => {
    mockDb.getClawsPr.mockResolvedValue(row(current));
    await applyPrLabelAdded("org/a", 7, label);
    return mockDb.upsertClawsPr.mock.calls[0]?.[2];
  };

  it("is a no-op when the ref has no row", async () => {
    await applyPrLabelAdded("org/a", 7, "Billing");
    expect(mockDb.getClawsPr).toHaveBeenCalledWith("org/a", 7);
    expect(mockDb.upsertClawsPr).not.toHaveBeenCalled();
  });

  it("ignores labels that are not PR state", async () => {
    await applyPrLabelAdded("org/a", 7, "Priority");
    expect(mockDb.getClawsPr).not.toHaveBeenCalled();
  });

  it("Ready and Automerge on a PR write nothing: the row is the only record (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F)", async () => {
    await applyPrLabelAdded("org/a", 7, "Ready");
    await applyPrLabelAdded("org/a", 7, "Automerge");
    await applyPrLabelRemoved("org/a", 7, "Ready");
    await applyPrLabelRemoved("org/a", 7, "Automerge");
    expect(mockDb.getClawsPr).not.toHaveBeenCalled();
    expect(mockDb.upsertClawsPr).not.toHaveBeenCalled();
  });

  it("Claws Problematic → problematic", async () => {
    expect(await added("Claws Problematic", { stage: "ci-failing" })).toEqual({ stage: "problematic" });
  });

  it("the retired Manual Action label writes nothing to the row (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK)", async () => {
    expect(await added("Manual Action", { stage: "opened" })).toBeUndefined();
    expect(mockDb.getClawsPr).not.toHaveBeenCalled();
  });

  it("Needs LGTM and Billing set their columns", async () => {
    expect(await added("Needs LGTM", {})).toEqual({ needsHumanReview: true });
    vi.clearAllMocks();
    expect(await added("Billing", {})).toEqual({ ciBlockedReason: "billing" });
  });

  it("never throws for a non-gating label when the store fails", async () => {
    mockDb.getClawsPr.mockRejectedValue(new Error("down"));
    await expect(applyPrLabelAdded("org/a", 7, "Billing")).resolves.toBeUndefined();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("[pr-state]"));
  });

  it.each(["Needs LGTM", "Claws Problematic"])(
    "re-throws for the gating label %s when the store fails",
    async (label) => {
      mockDb.getClawsPr.mockResolvedValue(row({}));
      mockDb.upsertClawsPr.mockRejectedValue(new Error("down"));
      await expect(applyPrLabelAdded("org/a", 7, label)).rejects.toThrow("down");
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("[pr-state]"));
    },
  );
});

describe("applyPrLabelRemoved", () => {
  const removed = async (label: string, current: Partial<ClawsPrRecord>) => {
    mockDb.getClawsPr.mockResolvedValue(row(current));
    await applyPrLabelRemoved("org/a", 7, label);
    return mockDb.upsertClawsPr.mock.calls[0]?.[2];
  };

  it("Claws Problematic steps back to awaiting-review only from its own stage", async () => {
    expect(await removed("Claws Problematic", { stage: "problematic" })).toEqual({ stage: "awaiting-review" });
    vi.clearAllMocks();
    expect(await removed("Claws Problematic", { stage: "awaiting-merge" })).toBeUndefined();
  });

  it("removing a Manual Action label on the forge never clears the row's hold", async () => {
    expect(await removed("Manual Action", { stage: "awaiting-merge", manualActionReason: "x" })).toBeUndefined();
  });

  it("clears the flag columns, and writes nothing when they are already clear", async () => {
    expect(await removed("Needs LGTM", { needsHumanReview: true })).toEqual({ needsHumanReview: false });
    vi.clearAllMocks();
    expect(await removed("Billing", { ciBlockedReason: "billing" })).toEqual({ ciBlockedReason: null });
    vi.clearAllMocks();
    expect(await removed("Billing", {})).toBeUndefined();
  });

  it("re-throws when clearing a gating label fails, but not a non-gating one", async () => {
    mockDb.getClawsPr.mockResolvedValue(row({ needsHumanReview: true }));
    mockDb.upsertClawsPr.mockRejectedValue(new Error("down"));
    await expect(applyPrLabelRemoved("org/a", 7, "Needs LGTM")).rejects.toThrow("down");

    vi.clearAllMocks();
    mockDb.getClawsPr.mockResolvedValue(row({ ciBlockedReason: "billing" }));
    mockDb.upsertClawsPr.mockRejectedValue(new Error("down"));
    await expect(applyPrLabelRemoved("org/a", 7, "Billing")).resolves.toBeUndefined();
  });
});

describe("row readers", () => {
  it("answer false for a missing row", () => {
    for (const read of [isAwaitingMerge, isProblematic, hasManualAction, needsHumanReview, isMergeApproved]) {
      expect(read(null)).toBe(false);
      expect(read(undefined)).toBe(false);
    }
  });

  it("read the stage and flag columns", () => {
    expect(isAwaitingMerge(row({ stage: "awaiting-merge" }))).toBe(true);
    expect(isAwaitingMerge(row())).toBe(false);
    expect(isProblematic(row({ stage: "problematic" }))).toBe(true);
    expect(isProblematic(row())).toBe(false);
    expect(hasManualAction(row({ manualActionReason: "set secrets" }))).toBe(true);
    expect(needsHumanReview(row({ needsHumanReview: true }))).toBe(true);
    expect(needsHumanReview(row())).toBe(false);
  });
});

describe("isMergeApproved", () => {
  it("accepts a timed approval with a named approver", () => {
    for (const by of ["oidc-sub-123", "dashboard", "session:abc", "label", "issue", "forge:alice"]) {
      expect(isMergeApproved(row({ mergeApprovedAt: "2026-09-26T00:00:00Z", mergeApprovedBy: by }))).toBe(true);
    }
  });

  it("rejects the legacy forge-label marker, a null or empty approver, and no time", () => {
    expect(isMergeApproved(row({ mergeApprovedAt: "t", mergeApprovedBy: "forge-label" }))).toBe(false);
    expect(isMergeApproved(row({ mergeApprovedAt: "t", mergeApprovedBy: null }))).toBe(false);
    expect(isMergeApproved(row({ mergeApprovedAt: "t", mergeApprovedBy: "" }))).toBe(false);
    expect(isMergeApproved(row({ mergeApprovedAt: null, mergeApprovedBy: "dashboard" }))).toBe(false);
  });
});

describe("markPrAwaitingMerge", () => {
  it("moves an existing row to awaiting-merge", async () => {
    mockDb.getClawsPr.mockResolvedValue(row({ stage: "addressing-review" }));
    await markPrAwaitingMerge("org/a", 7);
    expect(mockDb.upsertClawsPr).toHaveBeenCalledWith("org/a", 7, { stage: "awaiting-merge" });
  });

  it("writes nothing with no row or when already awaiting merge", async () => {
    await markPrAwaitingMerge("org/a", 7);
    mockDb.getClawsPr.mockResolvedValue(row({ stage: "awaiting-merge" }));
    await markPrAwaitingMerge("org/a", 7);
    expect(mockDb.upsertClawsPr).not.toHaveBeenCalled();
  });

  it("never throws when the store fails", async () => {
    mockDb.getClawsPr.mockRejectedValue(new Error("down"));
    await expect(markPrAwaitingMerge("org/a", 7)).resolves.toBeUndefined();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("[pr-state]"));
  });
});

describe("markPrAwaitingReview", () => {
  it("steps awaiting-merge back to awaiting-review", async () => {
    mockDb.getClawsPr.mockResolvedValue(row({ stage: "awaiting-merge" }));
    await markPrAwaitingReview("org/a", 7);
    expect(mockDb.upsertClawsPr).toHaveBeenCalledWith("org/a", 7, { stage: "awaiting-review" });
  });

  it.each(["problematic", "addressing-review", "merged"] as const)("leaves a %s row alone", async (stage) => {
    mockDb.getClawsPr.mockResolvedValue(row({ stage }));
    await markPrAwaitingReview("org/a", 7);
    expect(mockDb.upsertClawsPr).not.toHaveBeenCalled();
  });
});

describe("isReviewedHeadAwaitingMerge", () => {
  it("answers false for a missing row", () => {
    expect(isReviewedHeadAwaitingMerge(null)).toBe(false);
    expect(isReviewedHeadAwaitingMerge(undefined)).toBe(false);
  });

  it("answers false when the row has no recorded review", () => {
    expect(isReviewedHeadAwaitingMerge(row({ stage: "awaiting-merge", reviewedSha: null }))).toBe(false);
  });

  it("answers false when the row isn't awaiting-merge, even with a matching reviewed head", () => {
    expect(isReviewedHeadAwaitingMerge(row({ stage: "awaiting-review", reviewedSha: "abc123", headSha: "abc123" }))).toBe(false);
  });

  it("answers false when the head does not match the reviewed commit", () => {
    expect(isReviewedHeadAwaitingMerge(row({ stage: "awaiting-merge", reviewedSha: "abc123", headSha: "def456" }))).toBe(false);
  });

  it("answers true when the row's own head matches the reviewed commit", () => {
    expect(isReviewedHeadAwaitingMerge(row({ stage: "awaiting-merge", reviewedSha: "abc123", headSha: "abc123" }))).toBe(true);
  });

  it("prefers an explicit head override over the row's own head", () => {
    const r = row({ stage: "awaiting-merge", reviewedSha: "abc123", headSha: "abc123" });
    expect(isReviewedHeadAwaitingMerge(r, "def456")).toBe(false);
    expect(isReviewedHeadAwaitingMerge(r, "abc123")).toBe(true);
  });

  it("answers false when both the override and the row's head are null", () => {
    expect(isReviewedHeadAwaitingMerge(row({ stage: "awaiting-merge", reviewedSha: "abc123", headSha: null }))).toBe(false);
  });
});

describe("infraMergeApproval", () => {
  const approved = { infraMergeApprovedBy: "op", infraMergeApprovedAt: "2026-10-26T10:00:00Z", infraMergeApprovedSha: "abc123" };

  it("answers none without an approver and time", () => {
    expect(infraMergeApproval(row(), "abc123")).toEqual({ state: "none" });
    expect(infraMergeApproval(row({ ...approved, infraMergeApprovedBy: null }), "abc123")).toEqual({ state: "none" });
    expect(infraMergeApproval(null, "abc123")).toEqual({ state: "none" });
  });

  it("answers current when the approved sha is the live head", () => {
    expect(infraMergeApproval(row(approved), "abc123")).toEqual({ state: "current", by: "op", at: "2026-10-26T10:00:00Z" });
  });

  it("answers stale when the head has moved", () => {
    expect(infraMergeApproval(row(approved), "def456")).toEqual({ state: "stale", by: "op", at: "2026-10-26T10:00:00Z", sha: "abc123" });
  });

  it("answers stale when the live head is unknown", () => {
    expect(infraMergeApproval(row(approved), null).state).toBe("stale");
  });
});
