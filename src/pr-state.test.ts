import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./config.js", () => ({
  LABELS: {
    ready: "Ready",
    problematic: "Claws Problematic",
    manualAction: "Manual Action",
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
  comparePrRowWithLabels,
  labelsForPrRow,
  overlayPrStateLabelNames,
  overlayPrStateLabels,
  prStoreFacadeEnabled,
  reconcilePatchFromLabels,
  seedPatchFromLabels,
} from "./pr-state.js";

function row(overrides: Partial<ClawsPrRecord> = {}): ClawsPrRecord {
  return {
    repo: "org/a", prNumber: 7, issueId: null, phase: null, headSha: null, observedAt: null,
    stage: "awaiting-review", ciStatus: null, mergeableState: null, reviewVerdict: null, reviewedSha: null,
    mergeApprovedBy: null, mergeApprovedAt: null, manualActionReason: null, needsHumanReview: false,
    ciBlockedReason: null, createdAt: "", updatedAt: "", ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.getClawsPr.mockResolvedValue(null);
  mockDb.upsertClawsPr.mockResolvedValue(undefined);
  mockDb.listClawsPrs.mockResolvedValue([]);
  delete process.env["CLAWS_PR_STORE_FACADE"];
});

afterEach(() => {
  delete process.env["CLAWS_PR_STORE_FACADE"];
});

describe("prStoreFacadeEnabled", () => {
  it("is off by default and on only for 'true', read at call time", () => {
    expect(prStoreFacadeEnabled()).toBe(false);
    process.env["CLAWS_PR_STORE_FACADE"] = "1";
    expect(prStoreFacadeEnabled()).toBe(false);
    process.env["CLAWS_PR_STORE_FACADE"] = "true";
    expect(prStoreFacadeEnabled()).toBe(true);
  });
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

  it("Manual Action sets the reason, and the stage unless the PR is Ready or problematic", async () => {
    expect(await added("Manual Action", { stage: "opened" })).toEqual({ manualActionReason: "manual action", stage: "manual-action" });
    vi.clearAllMocks();
    expect(await added("Manual Action", { stage: "awaiting-merge" })).toEqual({ manualActionReason: "manual action" });
    vi.clearAllMocks();
    expect(await added("Manual Action", { stage: "problematic" })).toEqual({ manualActionReason: "manual action" });
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

  it("never throws when the store fails", async () => {
    mockDb.getClawsPr.mockRejectedValue(new Error("down"));
    await expect(applyPrLabelAdded("org/a", 7, "Ready")).resolves.toBeUndefined();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("[pr-state]"));
  });
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

  it("Manual Action clears the reason and a manual-action stage", async () => {
    expect(await removed("Manual Action", { stage: "manual-action", manualActionReason: "x" }))
      .toEqual({ manualActionReason: null, stage: "awaiting-review" });
    vi.clearAllMocks();
    expect(await removed("Manual Action", { stage: "awaiting-merge", manualActionReason: "x" }))
      .toEqual({ manualActionReason: null });
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
});

describe("seedPatchFromLabels", () => {
  it("picks the stage by precedence", () => {
    expect(seedPatchFromLabels(["Ready", "Claws Problematic"], "passing").stage).toBe("problematic");
    expect(seedPatchFromLabels(["Ready", "Manual Action"], "failing").stage).toBe("awaiting-merge");
    expect(seedPatchFromLabels(["Manual Action"], "failing").stage).toBe("manual-action");
    expect(seedPatchFromLabels([], "failing").stage).toBe("ci-failing");
    expect(seedPatchFromLabels([], "passing").stage).toBe("opened");
  });

  it("imports the flag columns, attributing a forge Automerge", () => {
    expect(seedPatchFromLabels(["Needs LGTM", "Billing", "Automerge", "Manual Action"], null)).toMatchObject({
      needsHumanReview: true,
      ciBlockedReason: "billing",
      manualActionReason: "manual action",
      mergeApprovedBy: "forge-label",
      mergeApprovedAt: expect.any(String),
    });
  });

  it("round-trips: a seeded row agrees with the labels it was seeded from", () => {
    const labels = ["Ready", "Manual Action", "Needs LGTM", "Automerge", "Priority"];
    const seeded = row(seedPatchFromLabels(labels, "passing") as Partial<ClawsPrRecord>);
    expect(comparePrRowWithLabels(seeded, labels)).toEqual([]);
  });
});

describe("reconcilePatchFromLabels", () => {
  it("is empty when the row agrees with the labels", () => {
    expect(reconcilePatchFromLabels(row({ stage: "awaiting-merge" }), ["Ready", "Priority"])).toEqual({ patch: {}, corrected: [] });
  });

  it("applies each forge edit with the hook's own patches", () => {
    const { patch, corrected } = reconcilePatchFromLabels(
      row({ stage: "problematic", needsHumanReview: true }),
      ["Manual Action", "Automerge"],
    );
    expect(patch).toEqual({
      stage: "manual-action",
      needsHumanReview: false,
      manualActionReason: "manual action",
      mergeApprovedAt: expect.any(String),
      mergeApprovedBy: "forge-label",
    });
    expect(corrected.map((d) => d.field)).toEqual(["Claws Problematic", "Manual Action", "Needs LGTM", "Automerge"]);
  });

  it("lands a single-valued stage on the seed's precedence", () => {
    const labels = ["Ready", "Claws Problematic"];
    const { patch } = reconcilePatchFromLabels(row(), labels);
    expect(patch.stage).toBe(seedPatchFromLabels(labels, null).stage);
  });
});

describe("labelsForPrRow / comparePrRowWithLabels", () => {
  it("maps the row to the six state labels", () => {
    expect(labelsForPrRow(row({ stage: "awaiting-merge", needsHumanReview: true, ciBlockedReason: "billing" })))
      .toEqual(["Ready", "Needs LGTM", "Billing"]);
    expect(labelsForPrRow(row())).toEqual([]);
  });

  it("names each disagreeing field", () => {
    expect(comparePrRowWithLabels(row({ stage: "awaiting-merge" }), ["Automerge"])).toEqual([
      { field: "Ready", expected: "present", actual: "absent" },
      { field: "Automerge", expected: "absent", actual: "present" },
    ]);
  });

  it("reports a missing row", () => {
    expect(comparePrRowWithLabels(null, [])).toEqual([{ field: "missing-row", expected: "row", actual: "none" }]);
  });
});

describe("overlayPrStateLabels", () => {
  const prs = [
    { number: 7, labels: [{ name: "Ready" }, { name: "Priority" }] },
    { number: 8, labels: [{ name: "Ready" }] },
  ];

  it("is the identity, with no DB read, while the switch is off", async () => {
    expect(await overlayPrStateLabels("org/a", prs)).toBe(prs);
    expect(await overlayPrStateLabelNames("org/a", 7, ["Ready"])).toEqual(["Ready"]);
    expect(mockDb.listClawsPrs).not.toHaveBeenCalled();
    expect(mockDb.getClawsPr).not.toHaveBeenCalled();
  });

  it("serves state labels from the row when on, leaving row-less PRs alone", async () => {
    process.env["CLAWS_PR_STORE_FACADE"] = "true";
    mockDb.listClawsPrs.mockResolvedValue([row({ prNumber: 7, stage: "problematic" })]);
    const out = await overlayPrStateLabels("org/a", prs);
    expect(out[0].labels).toEqual([{ name: "Priority" }, { name: "Claws Problematic" }]);
    expect(out[1]).toBe(prs[1]);
    expect(prs[0].labels).toEqual([{ name: "Ready" }, { name: "Priority" }]);

    mockDb.getClawsPr.mockResolvedValue(row({ stage: "awaiting-merge", mergeApprovedAt: "t" }));
    expect(await overlayPrStateLabelNames("org/a", 7, ["Priority"])).toEqual(["Priority", "Ready", "Automerge"]);
  });

  it("falls back to forge labels when the store read fails", async () => {
    process.env["CLAWS_PR_STORE_FACADE"] = "true";
    mockDb.listClawsPrs.mockRejectedValue(new Error("down"));
    expect(await overlayPrStateLabels("org/a", prs)).toBe(prs);
  });
});
