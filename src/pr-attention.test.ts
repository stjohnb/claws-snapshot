import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClawsPrRecord } from "./db.js";

const mockDb = vi.hoisted(() => ({ listCiFixerGiveUpHeads: vi.fn() }));
vi.mock("./db.js", () => mockDb);
const mockWarnings = vi.hoisted(() => vi.fn());
vi.mock("./planned-prs.js", () => ({
  loadManualActionWarnings: mockWarnings,
  manualWarningRow: (row: ClawsPrRecord) => row,
}));

import { setCiFixerGaveUp, setMergeBlockReason } from "./github.js";
import { INFRA_MERGE_BLOCK_CODES, MERGE_SKIP_TTL_MS, OPERATOR_MERGE_BLOCK_CODES, infraApprovalStop, loadPrAttention, prAttentionReasons } from "./pr-attention.js";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const recent = new Date(NOW - 5 * 60 * 1000).toISOString();

const row = (fields: Partial<ClawsPrRecord> = {}): ClawsPrRecord => ({
  repo: "org/repo", prNumber: 7, issueId: null, stage: "awaiting-merge", headSha: "abc",
  ciStatus: "passing", reviewVerdict: "clean", reviewedSha: "abc",
  ciBlockedReason: null, manualActionReason: null,
  mergeApprovedAt: "2026-10-13T00:00:00Z", mergeApprovedBy: "dashboard",
  ...fields,
} as ClawsPrRecord);

/** A row carrying a persisted auto-merger skip on its current head. */
const skipped = (code: string, fields: Partial<ClawsPrRecord> = {}): ClawsPrRecord =>
  row({ mergeSkipCode: code, mergeSkipReason: "blocked", mergeSkipHead: "abc", mergeSkipAt: recent, ...fields });

beforeEach(() => {
  mockDb.listCiFixerGiveUpHeads.mockReset().mockResolvedValue(new Set());
  mockWarnings.mockReset().mockResolvedValue(new Map());
});

describe("prAttentionReasons", () => {
  it("is empty for an undefined row", () => {
    expect(prAttentionReasons(undefined, { manualWarning: "warn" })).toEqual([]);
  });

  it("counts a CI fixer give-up on the current head even when Automerge is applied", () => {
    expect(prAttentionReasons(row({ stage: "ci-failing" }), { ciFixerGaveUp: true }, NOW)).toEqual(["CI fixer gave up"]);
    expect(prAttentionReasons(row({ ciStatus: "failing" }), { ciFixerGaveUp: true }, NOW)).toEqual(["CI fixer gave up"]);
  });

  it("drops a CI fixer give-up once CI on the same head is no longer failing", () => {
    expect(prAttentionReasons(row({ ciStatus: "passing" }), { ciFixerGaveUp: true }, NOW)).toEqual([]);
  });

  it("counts a pending manual action", () => {
    expect(prAttentionReasons(row(), { manualWarning: "Operator step pending: x" }, NOW)).toEqual(["Manual action pending"]);
  });

  it("counts Claws Problematic", () => {
    expect(prAttentionReasons(row({ stage: "problematic" }), {}, NOW)).toEqual(["Claws Problematic"]);
  });

  it("counts a CI-blocked PR", () => {
    expect(prAttentionReasons(row({ ciBlockedReason: "billing" }), {}, NOW)).toEqual(["CI blocked"]);
  });

  it.each([...INFRA_MERGE_BLOCK_CODES])("reads an infra block as Needs infra approval (%s)", (code) => {
    expect(prAttentionReasons(skipped(code), {}, NOW)).toEqual(["Needs infra approval"]);
  });

  it("does not count an infra block while the PR still waits on CI", () => {
    expect(prAttentionReasons(skipped("infra-plan", { ciStatus: "pending" }), {}, NOW)).toEqual([]);
  });

  it("does not count an infra block while the head's review is blocking or missing", () => {
    expect(prAttentionReasons(skipped("infra", { reviewVerdict: "blocking" }), {}, NOW)).toEqual([]);
    expect(prAttentionReasons(skipped("infra", { reviewedSha: "old" }), {}, NOW)).toEqual([]);
  });

  it("counts an infra block once CI is green and the head's review is clean", () => {
    expect(prAttentionReasons(skipped("infra-plan", { ciStatus: "passing" }), {}, NOW)).toEqual(["Needs infra approval"]);
  });

  it("lists only Manual action pending for an infra-blocked PR with a recorded manual action (#clw_01M7QWS5TGJF46D318FN3W5HRJ)", () => {
    const held = skipped("infra-plan", { ciStatus: "passing", manualActionReason: "At GoDaddy, change the nameservers" });
    expect(prAttentionReasons(held, { manualWarning: "Operator step pending: x" }, NOW)).toEqual(["Manual action pending"]);
    expect(infraApprovalStop(held, NOW)).toEqual({ wait: "Infra approval comes after the manual action" });
  });

  it.each([...OPERATOR_MERGE_BLOCK_CODES].filter((c) => !INFRA_MERGE_BLOCK_CODES.has(c)))("counts a person-only merge block (%s)", (code) => {
    expect(prAttentionReasons(skipped(code), {}, NOW)).toEqual(["Merge blocked — needs you"]);
  });

  it.each(["checks-failed", "checks-pending", "conflict", "other-work"])("does not count a block Claws resolves itself (%s)", (code) => {
    expect(prAttentionReasons(skipped(code), {}, NOW)).toEqual([]);
  });

  it("does not count an approved, green PR with no block", () => {
    expect(prAttentionReasons(row(), {}, NOW)).toEqual([]);
  });

  it("counts a human-authored infra PR with no issue and no merge approval, with no in-memory state set", () => {
    setMergeBlockReason("org/repo", 7, null);
    setCiFixerGaveUp("org/repo", 7, null);
    const r = skipped("infra", { issueId: null, stage: "opened", mergeApprovedAt: null, mergeApprovedBy: null });
    expect(prAttentionReasons(r, {}, NOW)).toEqual(["Needs infra approval"]);
  });

  it("ignores a skip recorded for an older head", () => {
    expect(prAttentionReasons(skipped("infra", { mergeSkipHead: "old" }), {}, NOW)).toEqual([]);
  });

  it("ignores a skip older than the TTL", () => {
    const at = new Date(NOW - MERGE_SKIP_TTL_MS - 1000).toISOString();
    expect(prAttentionReasons(skipped("infra", { mergeSkipAt: at }), {}, NOW)).toEqual([]);
  });

  it("reads not-approved on a ready PR as Ready — approve the merge", () => {
    const ready = { stage: "awaiting-merge" as const, reviewedSha: "abc", ciStatus: "passing", reviewVerdict: "clean", mergeApprovedAt: null, mergeApprovedBy: null };
    expect(prAttentionReasons(skipped("not-approved", ready), {}, NOW)).toEqual(["Ready — approve the merge"]);
  });

  it("reads not-approved on an advisory-reviewed ready PR as Ready, but not a blocking one", () => {
    const ready = { stage: "awaiting-merge" as const, reviewedSha: "abc", ciStatus: "passing", mergeApprovedAt: null, mergeApprovedBy: null };
    expect(prAttentionReasons(skipped("not-approved", { ...ready, reviewVerdict: "advisory" }), {}, NOW)).toEqual(["Ready — approve the merge"]);
    expect(prAttentionReasons(skipped("not-approved", { ...ready, reviewVerdict: "blocking" }), {}, NOW)).toEqual([]);
  });

  it("does not read not-approved as Ready once the merge is approved", () => {
    const approved = { stage: "awaiting-merge" as const, reviewedSha: "abc", ciStatus: "passing", reviewVerdict: "clean", mergeApprovedAt: new Date(NOW).toISOString(), mergeApprovedBy: "op" };
    expect(prAttentionReasons(skipped("not-approved", approved), {}, NOW)).toEqual([]);
  });

  it("does not count not-approved on a PR that is not ready yet", () => {
    expect(prAttentionReasons(skipped("not-approved", { reviewedSha: null }), {}, NOW)).toEqual([]);
  });
});

describe("infraApprovalStop (#clw_01M7QSR46DJPAP9KVJN2WJ3A3P)", () => {
  it.each([...INFRA_MERGE_BLOCK_CODES])("holds a PR with a fresh infra skip on its head (%s)", (code) => {
    expect(infraApprovalStop(skipped(code), NOW)).toEqual({ wait: null });
  });

  it("carries the in-progress wait while the PR still waits on CI or review", () => {
    expect(infraApprovalStop(skipped("infra-plan", { ciStatus: "pending" }), NOW)).toEqual({ wait: "Waiting for CI" });
    expect(infraApprovalStop(skipped("infra", { reviewedSha: "old" }), NOW)).toEqual({ wait: "Waiting for review" });
  });

  it("is null with no skip, another code, a stale skip or a skip for another head", () => {
    expect(infraApprovalStop(row(), NOW)).toBeNull();
    expect(infraApprovalStop(skipped("checks-held"), NOW)).toBeNull();
    expect(infraApprovalStop(skipped("infra"), NOW + MERGE_SKIP_TTL_MS)).toBeNull();
    expect(infraApprovalStop(skipped("infra", { mergeSkipHead: "old" }), NOW)).toBeNull();
  });
});

describe("loadPrAttention", () => {
  it("keys flagged rows by repo#number and leaves the rest out", async () => {
    mockDb.listCiFixerGiveUpHeads.mockResolvedValue(new Set(["org/repo#7#abc"]));
    mockWarnings.mockResolvedValue(new Map([["org/repo#9", "Manual action before merge: x"]]));
    const out = await loadPrAttention([row({ stage: "ci-failing" }), row({ prNumber: 8 }), row({ prNumber: 9 })]);
    expect(mockDb.listCiFixerGiveUpHeads).toHaveBeenCalledWith(expect.any(Array), { windowMs: expect.any(Number), maxNoopRuns: 2 });
    expect([...out]).toEqual([["org/repo#7", ["CI fixer gave up"]], ["org/repo#9", ["Manual action pending"]]]);
  });

  it("does not count a give-up on an older head", async () => {
    mockDb.listCiFixerGiveUpHeads.mockResolvedValue(new Set(["org/repo#7#old"]));
    expect((await loadPrAttention([row()])).size).toBe(0);
  });

  it("uses warnings the caller already holds", async () => {
    const out = await loadPrAttention([row()], { warnings: new Map([["org/repo#7", "w"]]) });
    expect(mockWarnings).not.toHaveBeenCalled();
    expect(out.get("org/repo#7")).toEqual(["Manual action pending"]);
  });
});
