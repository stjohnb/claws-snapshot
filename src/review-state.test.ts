import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PRReviewRecord } from "./db.js";

const latest = vi.hoisted(() => ({ row: null as PRReviewRecord | null }));
vi.mock("./db.js", () => ({ getLatestPRReview: vi.fn(async () => latest.row) }));
vi.mock("./log.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { deriveReviewStatus, pendingClawsReview } from "./review-state.js";

const HEAD = "3d161e04aaaabbbbccccddddeeeeffff00001111";

function row(over: Partial<PRReviewRecord> = {}): PRReviewRecord {
  return {
    id: 1, repo: "o/r", prNumber: 416, headSha: HEAD, reviewedSha: HEAD, baseSha: "base", verdict: "blocking",
    mode: "full", iteration: 2, reviewerTaskId: 7, provider: "claude", model: "opus", findings: "1. fix it",
    createdAt: "2026-11-01T00:00:00Z", addressedAt: null, addressedSha: null, rebutted: false, rebuttal: null,
    advisoryAddressedSha: null, recommendedModel: null, addresserSummary: null, ...over,
  };
}

/** Findings that would have fooled the old comment-text parser. */
const DECOYS = [
  "1. the <details> block is unclosed",
  "1. the reviewer quoted `review-result: escalated` here",
  "1. a comment saying review-result: clean is not a verdict",
  "1. stamp-looking line\nreview-addressed: abc123",
];

describe("deriveReviewStatus", () => {
  it("reads none with no recorded round", () => {
    expect(deriveReviewStatus(null)).toEqual({ status: "none", issueCount: 0, reviewedCommit: null });
  });

  it.each(DECOYS)("a blocking round derives issues whatever its findings say: %s", (findings) => {
    expect(deriveReviewStatus(row({ verdict: "blocking", findings })).status).toBe("issues");
  });

  it.each(DECOYS)("a clean round derives clean whatever its findings say: %s", (findings) => {
    expect(deriveReviewStatus(row({ verdict: "clean", findings }))).toEqual({ status: "clean", issueCount: 0, reviewedCommit: HEAD });
  });

  it("maps advisory and empty-diff to clean, escalated to escalated", () => {
    expect(deriveReviewStatus(row({ verdict: "advisory", findings: "1. nit" })).status).toBe("clean");
    expect(deriveReviewStatus(row({ verdict: "empty-diff", findings: "no net changes" })).status).toBe("clean");
    expect(deriveReviewStatus(row({ verdict: "escalated", findings: "review-result: clean" })).status).toBe("escalated");
  });

  it("reports the full head SHA as reviewedCommit", () => {
    expect(deriveReviewStatus(row({ verdict: "clean" })).reviewedCommit).toBe(HEAD);
  });

  it("counts numbered findings on a blocking round for display", () => {
    expect(deriveReviewStatus(row({ findings: "intro\n1. one\n2. two\n  3. three" })).issueCount).toBe(3);
  });

  it("reads a blocking or advisory round with null findings (backfilled) as none", () => {
    expect(deriveReviewStatus(row({ verdict: "blocking", findings: null }))).toEqual({ status: "none", issueCount: 0, reviewedCommit: null });
    expect(deriveReviewStatus(row({ verdict: "advisory", findings: null })).status).toBe("none");
    // A backfilled clean round still reads clean.
    expect(deriveReviewStatus(row({ verdict: "clean", findings: null })).status).toBe("clean");
  });
});

describe("pendingClawsReview", () => {
  beforeEach(() => {
    latest.row = null;
  });

  it("returns an unaddressed blocking round at the head", async () => {
    latest.row = row();
    expect(await pendingClawsReview("o/r", 416, HEAD)).toBe(latest.row);
  });

  it.each([
    ["no round", null],
    ["clean", row({ verdict: "clean" })],
    ["escalated", row({ verdict: "escalated" })],
    ["addressed", row({ addressedAt: "2026-11-02T00:00:00Z" })],
    ["stale head", row({ headSha: "0000" })],
    ["null findings", row({ findings: null })],
  ])("returns null for %s", async (_label, r) => {
    latest.row = r;
    expect(await pendingClawsReview("o/r", 416, HEAD, { includeAdvisory: true })).toBeNull();
  });

  it("returns an advisory round only with includeAdvisory and no recorded advisory fix", async () => {
    latest.row = row({ verdict: "advisory" });
    expect(await pendingClawsReview("o/r", 416, HEAD)).toBeNull();
    expect(await pendingClawsReview("o/r", 416, HEAD, { includeAdvisory: true })).toBe(latest.row);
    latest.row = row({ verdict: "advisory", advisoryAddressedSha: "feed" });
    expect(await pendingClawsReview("o/r", 416, HEAD, { includeAdvisory: true })).toBeNull();
  });

  it("calls a head getter only for a candidate round", async () => {
    const getHead = vi.fn(async () => HEAD);
    latest.row = row({ verdict: "clean" });
    expect(await pendingClawsReview("o/r", 416, getHead)).toBeNull();
    expect(getHead).not.toHaveBeenCalled();
    latest.row = row();
    expect(await pendingClawsReview("o/r", 416, getHead)).toBe(latest.row);
    expect(getHead).toHaveBeenCalledTimes(1);
  });
});
