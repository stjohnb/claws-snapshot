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
  forgeApprover,
  hasManualAction,
  isAwaitingMerge,
  isMergeApproved,
  isProblematic,
  isReviewedHeadAwaitingMerge,
  needsHumanReview,
} from "./pr-state.js";

function row(overrides: Partial<ClawsPrRecord> = {}): ClawsPrRecord {
  return {
    repo: "org/a", prNumber: 7, issueId: null, phase: null, headSha: null, observedAt: null,
    stage: "awaiting-review", ciStatus: null, mergeableState: null, reviewVerdict: null, reviewedSha: null,
    mergeApprovedBy: null, mergeApprovedAt: null, manualActionReason: null, needsHumanReview: false,
    ciBlockedReason: null, title: null, dispatchNote: null, dispatchNoteAt: null, createdAt: "", updatedAt: "", ...overrides,
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
    await applyPrLabelAdded("org/a", 7, "Ready");
    expect(mockDb.getClawsPr).toHaveBeenCalledWith("org/a", 7);
    expect(mockDb.upsertClawsPr).not.toHaveBeenCalled();
  });

  it("ignores labels that are not PR state", async () => {
    await applyPrLabelAdded("org/a", 7, "Priority");
    expect(mockDb.getClawsPr).not.toHaveBeenCalled();
  });

  it("Ready → awaiting-merge; Claws Problematic → problematic", async () => {
    expect(await added("Ready", {})).toEqual({ stage: "awaiting-merge" });
    vi.clearAllMocks();
    expect(await added("Claws Problematic", { stage: "ci-failing" })).toEqual({ stage: "problematic" });
  });

  it("the retired Manual Action label writes nothing to the row (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK)", async () => {
    expect(await added("Manual Action", { stage: "opened" })).toBeUndefined();
    expect(mockDb.getClawsPr).not.toHaveBeenCalled();
  });

  it("Needs LGTM, Billing and Automerge set their columns", async () => {
    expect(await added("Needs LGTM", {})).toEqual({ needsHumanReview: true });
    vi.clearAllMocks();
    expect(await added("Billing", {})).toEqual({ ciBlockedReason: "billing" });
    vi.clearAllMocks();
    expect(await added("Automerge", {})).toMatchObject({ mergeApprovedBy: "label", mergeApprovedAt: expect.any(String) });
  });

  it("keeps an existing approval", async () => {
    expect(await added("Automerge", { mergeApprovedAt: "2026-09-01T00:00:00Z", mergeApprovedBy: "forge-label" })).toBeUndefined();
  });

  it("never throws for a non-gating label when the store fails", async () => {
    mockDb.getClawsPr.mockRejectedValue(new Error("down"));
    await expect(applyPrLabelAdded("org/a", 7, "Ready")).resolves.toBeUndefined();
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

  it("Ready and Claws Problematic step back to awaiting-review only from their own stage", async () => {
    expect(await removed("Ready", { stage: "awaiting-merge" })).toEqual({ stage: "awaiting-review" });
    vi.clearAllMocks();
    expect(await removed("Ready", { stage: "addressing-review" })).toBeUndefined();
    vi.clearAllMocks();
    expect(await removed("Claws Problematic", { stage: "problematic" })).toEqual({ stage: "awaiting-review" });
  });

  it("removing a Manual Action label on the forge never clears the row's hold", async () => {
    expect(await removed("Manual Action", { stage: "awaiting-merge", manualActionReason: "x" })).toBeUndefined();
  });

  it("clears the flag columns, and writes nothing when they are already clear", async () => {
    expect(await removed("Needs LGTM", { needsHumanReview: true })).toEqual({ needsHumanReview: false });
    vi.clearAllMocks();
    expect(await removed("Billing", { ciBlockedReason: "billing" })).toEqual({ ciBlockedReason: null });
    vi.clearAllMocks();
    expect(await removed("Automerge", { mergeApprovedAt: "t", mergeApprovedBy: "label" }))
      .toEqual({ mergeApprovedAt: null, mergeApprovedBy: null });
    vi.clearAllMocks();
    expect(await removed("Automerge", {})).toBeUndefined();
  });

  it("re-throws when clearing a gating label fails, but not a non-gating one", async () => {
    mockDb.getClawsPr.mockResolvedValue(row({ needsHumanReview: true }));
    mockDb.upsertClawsPr.mockRejectedValue(new Error("down"));
    await expect(applyPrLabelRemoved("org/a", 7, "Needs LGTM")).rejects.toThrow("down");

    vi.clearAllMocks();
    mockDb.getClawsPr.mockResolvedValue(row({ stage: "awaiting-merge" }));
    mockDb.upsertClawsPr.mockRejectedValue(new Error("down"));
    await expect(applyPrLabelRemoved("org/a", 7, "Ready")).resolves.toBeUndefined();
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
    for (const by of ["oidc-sub-123", "dashboard", "session:abc", "label", forgeApprover("alice")]) {
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

describe("forgeApprover", () => {
  it("names the forge login", () => {
    expect(forgeApprover("alice")).toBe("forge:alice");
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
