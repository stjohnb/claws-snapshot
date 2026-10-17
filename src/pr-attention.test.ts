import { describe, it, expect, beforeEach } from "vitest";
import { setCiFixerGaveUp, setMergeBlockReason } from "./github.js";
import { OPERATOR_MERGE_BLOCK_CODES, prAttentionReasons } from "./pr-attention.js";
import type { ClawsPrRecord } from "./db.js";

const row = (fields: Partial<ClawsPrRecord> = {}): ClawsPrRecord => ({
  repo: "org/repo", prNumber: 7, issueId: null, stage: "awaiting-merge", headSha: "abc",
  ciBlockedReason: null, manualActionReason: null,
  mergeApprovedAt: "2026-10-13T00:00:00Z", mergeApprovedBy: "dashboard",
  ...fields,
} as ClawsPrRecord);

beforeEach(() => {
  setCiFixerGaveUp("org/repo", 7, null);
  setMergeBlockReason("org/repo", 7, null);
});

describe("prAttentionReasons", () => {
  it("is empty for an undefined row", () => {
    expect(prAttentionReasons(undefined, "warn")).toEqual([]);
  });

  it("counts a CI fixer give-up on the current head even when Automerge is applied", () => {
    setCiFixerGaveUp("org/repo", 7, "abc");
    expect(prAttentionReasons(row())).toEqual(["CI fixer gave up"]);
  });

  it("ignores a give-up recorded for a different head", () => {
    setCiFixerGaveUp("org/repo", 7, "old");
    expect(prAttentionReasons(row())).toEqual([]);
  });

  it("counts a pending manual action", () => {
    expect(prAttentionReasons(row(), "Operator step pending: x")).toEqual(["Manual action pending"]);
  });

  it("counts Claws Problematic", () => {
    expect(prAttentionReasons(row({ stage: "problematic" }))).toEqual(["Claws Problematic"]);
  });

  it("counts a CI-blocked PR", () => {
    expect(prAttentionReasons(row({ ciBlockedReason: "billing" }))).toEqual(["CI blocked"]);
  });

  it.each([...OPERATOR_MERGE_BLOCK_CODES])("counts a person-only merge block (%s)", (code) => {
    setMergeBlockReason("org/repo", 7, "blocked", code);
    expect(prAttentionReasons(row())).toEqual(["Merge blocked — needs you"]);
  });

  it.each(["checks-failed", "checks-pending", "conflict"])("does not count a block Claws resolves itself (%s)", (code) => {
    setMergeBlockReason("org/repo", 7, "blocked", code);
    expect(prAttentionReasons(row())).toEqual([]);
  });

  it("does not count an approved, green PR with no block", () => {
    expect(prAttentionReasons(row())).toEqual([]);
  });

  it("counts a human-authored PR with an infra block", () => {
    setMergeBlockReason("org/repo", 7, "blocked", "infra");
    expect(prAttentionReasons(row({ issueId: null, stage: "opened" }))).toEqual(["Merge blocked — needs you"]);
  });
});
