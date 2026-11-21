import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), {
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
  infraApprovalWait,
  INFRA_WAIT_ESCALATION,
  INFRA_WAIT_MANUAL_ACTION,
  infraMergeApproval,
  parseInfraMergeApprovedEvidence,
  persistedInfraHoldItems,
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

  it("answers carried when the approval was carried over to the live head", () => {
    const carried = { ...approved, infraMergeCarriedSha: "def456", infraMergeCarriedNote: "same plan as abc123, no tofu workflow change" };
    expect(infraMergeApproval(row(carried), "def456")).toEqual({
      state: "carried", by: "op", at: "2026-10-26T10:00:00Z", sha: "abc123", carriedTo: "def456", note: "same plan as abc123, no tofu workflow change",
    });
    expect(infraMergeApproval(row(carried), "0123456").state).toBe("stale");
  });
});

describe("parseInfraMergeApprovedEvidence", () => {
  it("reads the stored JSON and refuses anything malformed", () => {
    expect(parseInfraMergeApprovedEvidence(JSON.stringify({ fingerprint: "- a update", counts: null, workflowDiff: "" })))
      .toEqual({ fingerprint: "- a update", counts: null, workflowDiff: "" });
    expect(parseInfraMergeApprovedEvidence(JSON.stringify({ fingerprint: null, workflowDiff: "x" }))).toEqual({ fingerprint: null, counts: null, workflowDiff: "x" });
    expect(parseInfraMergeApprovedEvidence(null)).toBeNull();
    expect(parseInfraMergeApprovedEvidence("{")).toBeNull();
    expect(parseInfraMergeApprovedEvidence("{}")).toBeNull();
  });
});

describe("persistedInfraHoldItems", () => {
  const reason = "The Tofu plan for head abc1234 destroys or replaces 2 resources:\n\n- tofu: hcloud_network.main — delete\n- tofu: hcloud_server.web — delete+create\n\nApprove resource deletion on the board to merge it.";

  it("lists the resources of an infra refusal for the given head", () => {
    expect(persistedInfraHoldItems(row({ mergeSkipCode: "infra", mergeSkipReason: reason, mergeSkipHead: "abc" }), "abc")).toEqual([
      "tofu: hcloud_network.main — delete",
      "tofu: hcloud_server.web — delete+create",
    ]);
  });

  it("is empty for another head, another code or no row", () => {
    expect(persistedInfraHoldItems(row({ mergeSkipCode: "infra", mergeSkipReason: reason, mergeSkipHead: "abc" }), "def")).toEqual([]);
    expect(persistedInfraHoldItems(row({ mergeSkipCode: "infra-undeclared", mergeSkipReason: reason, mergeSkipHead: "abc" }), "abc")).toEqual([]);
    expect(persistedInfraHoldItems(undefined, "abc")).toEqual([]);
  });
});

describe("infraApprovalWait (#clw_01M7QNXX7VNQXA1A92P1WCT6S9)", () => {
  const READY = { stage: "awaiting-merge", headSha: "h1", ciStatus: "passing", reviewVerdict: "clean", reviewedSha: "h1", mergeableState: "MERGEABLE", ciBlockedReason: null };

  it("is null once the approval is the next step", () => {
    expect(infraApprovalWait(READY)).toBeNull();
    expect(infraApprovalWait({ ...READY, reviewVerdict: "advisory" })).toBeNull();
    expect(infraApprovalWait({ ...READY, reviewVerdict: "empty-diff" })).toBeNull();
    expect(infraApprovalWait({ ...READY, ciStatus: "none" })).toBeNull();
    expect(infraApprovalWait(null)).toBeNull();
  });

  it.each([
    ["pr-reviewer", "Waiting for review"],
    ["review-addresser", "Addressing review"],
    ["ci-fixer", "Fixing CI"],
    ["ci-fixer:conflict", "Resolving conflicts"],
  ])("names a queued or running %s job", (kind, text) => {
    expect(infraApprovalWait(READY, { activeWork: kind })).toBe(text);
  });

  it("names what the row still waits on", () => {
    expect(infraApprovalWait({ ...READY, ciStatus: "pending" })).toBe("Waiting for CI");
    expect(infraApprovalWait({ ...READY, ciStatus: "failing" })).toBe("CI failing");
    expect(infraApprovalWait({ ...READY, reviewedSha: "h0" })).toBe("Waiting for review");
    expect(infraApprovalWait({ ...READY, reviewVerdict: null })).toBe("Waiting for review");
    expect(infraApprovalWait({ ...READY, headSha: null })).toBe("Waiting for review");
    expect(infraApprovalWait({ ...READY, reviewVerdict: "blocking" })).toBe("Addressing review");
    expect(infraApprovalWait({ ...READY, mergeableState: "CONFLICTING" })).toBe("Resolving conflicts");
  });

  it("prefers the live check status over the row's", () => {
    expect(infraApprovalWait({ ...READY, ciStatus: "pending" }, { liveCheckStatus: "passing" })).toBeNull();
    expect(infraApprovalWait(READY, { liveCheckStatus: "pending" })).toBe("Waiting for CI");
  });

  it("applies the precedence: job, then CI, then review, then conflicts", () => {
    const busy = { ...READY, ciStatus: "pending", reviewVerdict: "blocking", mergeableState: "CONFLICTING" };
    expect(infraApprovalWait(busy, { activeWork: "review-addresser" })).toBe("Addressing review");
    expect(infraApprovalWait(busy)).toBe("Waiting for CI");
    expect(infraApprovalWait({ ...busy, ciStatus: "passing" })).toBe("Addressing review");
  });

  it("is null for a stalled or human-held PR", () => {
    expect(infraApprovalWait({ ...READY, stage: "problematic", ciStatus: "failing" })).toBeNull();
    expect(infraApprovalWait({ ...READY, ciBlockedReason: "billing", ciStatus: "pending" })).toBeNull();
    expect(infraApprovalWait({ ...READY, ciStatus: "held" })).toBeNull();
    expect(infraApprovalWait({ ...READY, reviewVerdict: "escalated" }, { activeWork: "pr-reviewer" })).toBeNull();
  });
});

describe("infraApprovalWait with a recorded manual action (#clw_01M7QWS5TGJF46D318FN3W5HRJ)", () => {
  const READY = { stage: "awaiting-merge", headSha: "h1", ciStatus: "passing", reviewVerdict: "clean", reviewedSha: "h1", mergeableState: "MERGEABLE", ciBlockedReason: null };
  const HELD = { ...READY, manualActionReason: "At GoDaddy, change the nameservers" };

  it("names the manual action on an otherwise ready PR", () => {
    expect(infraApprovalWait(HELD)).toBe(INFRA_WAIT_MANUAL_ACTION);
    expect(INFRA_WAIT_MANUAL_ACTION).toBe("Infra approval comes after the manual action");
  });

  it("names a reviewer escalation hold", () => {
    expect(infraApprovalWait({ ...READY, manualActionReason: "review escalated: h1 — needs a human" })).toBe(INFRA_WAIT_ESCALATION);
    expect(INFRA_WAIT_ESCALATION).toBe("Infra approval comes after the reviewer escalation is settled");
  });

  it("wins over a stalled PR, held checks, pending CI and active work", () => {
    expect(infraApprovalWait({ ...HELD, stage: "problematic" })).toBe(INFRA_WAIT_MANUAL_ACTION);
    expect(infraApprovalWait({ ...HELD, ciBlockedReason: "billing" })).toBe(INFRA_WAIT_MANUAL_ACTION);
    expect(infraApprovalWait(HELD, { liveCheckStatus: "held" })).toBe(INFRA_WAIT_MANUAL_ACTION);
    expect(infraApprovalWait({ ...HELD, ciStatus: "pending" })).toBe(INFRA_WAIT_MANUAL_ACTION);
    expect(infraApprovalWait(HELD, { activeWork: "ci-fixer" })).toBe(INFRA_WAIT_MANUAL_ACTION);
  });

  it("changes nothing for an empty, whitespace-only or null reason", () => {
    expect(infraApprovalWait({ ...READY, manualActionReason: "   " })).toBeNull();
    expect(infraApprovalWait({ ...READY, manualActionReason: "" })).toBeNull();
    expect(infraApprovalWait({ ...READY, manualActionReason: null })).toBeNull();
    expect(infraApprovalWait({ ...READY, manualActionReason: " ", ciStatus: "pending" })).toBe("Waiting for CI");
  });
});
