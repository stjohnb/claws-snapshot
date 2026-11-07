import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockGh, mockIssues, mockFlight, mockPlanned, mockReapproval } = vi.hoisted(() => ({
  mockDb: {
    getClawsIssue: vi.fn(),
    upsertClawsPr: vi.fn(async () => {}),
    // How many rows the real one clears; which ones, and how, is db.test.ts's.
    clearPrMergeApprovals: vi.fn(async (rows: { mergeApprovedAt: string | null; infraMergeApprovedAt: string | null }[]) =>
      rows.filter((r) => r.mergeApprovedAt || r.infraMergeApprovedAt).length),
  },
  mockGh: { commentOnIssue: vi.fn(async () => {}) },
  mockIssues: {
    setApprovedThrough: vi.fn(async () => true),
    promoteIssue: vi.fn(async () => true),
    toIso: vi.fn((stored: string) => `${stored.replace(" ", "T")}Z`),
  },
  mockFlight: { loadIssueFlight: vi.fn() },
  mockPlanned: { resolveTrackerId: vi.fn() },
  mockReapproval: {
    hasPendingReapproval: vi.fn(async () => false),
    promoteReapproval: vi.fn(async () => true),
    approveReapproval: vi.fn(async () => true),
  },
}));
vi.mock("./db.js", () => mockDb);
vi.mock("./github.js", () => mockGh);
vi.mock("./claws-issues.js", () => mockIssues);
vi.mock("./issue-flight.js", () => mockFlight);
vi.mock("./planned-prs.js", () => mockPlanned);
vi.mock("./reapproval.js", () => mockReapproval);
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { applyIssueApproval, readIssueApproval, withdrawPlanApproval, APPROVAL_COMMENT_PREFIX, APPROVAL_WITHDRAWN_PREFIX } from "./issue-approval-write.js";

const TRACKER = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

function record(fields: Record<string, unknown> = {}) {
  return { id: TRACKER, lifecycle: "planning", requirements_approved_at: "2026-01-01 00:00:00", approved_through: "requirements", ...fields };
}

function pr(prNumber: number, fields: Record<string, unknown> = {}) {
  return { repo: "org/a", prNumber, mergeApprovedAt: null, infraMergeApprovedAt: null, ...fields };
}

/** The body of the one comment posted, or undefined when none was. */
function postedComment(): string | undefined {
  expect(mockGh.commentOnIssue.mock.calls.length).toBeLessThanOrEqual(1);
  return (mockGh.commentOnIssue.mock.calls[0] as unknown[] | undefined)?.[2] as string | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPlanned.resolveTrackerId.mockResolvedValue(TRACKER);
  mockDb.getClawsIssue.mockResolvedValue(record());
  mockFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [] });
  mockIssues.setApprovedThrough.mockResolvedValue(true);
  mockIssues.promoteIssue.mockResolvedValue(true);
  mockReapproval.hasPendingReapproval.mockResolvedValue(false);
  mockReapproval.promoteReapproval.mockResolvedValue(true);
});

describe("applyIssueApproval", () => {
  it("refuses lowering to none with a 400 and writes nothing", async () => {
    mockFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [pr(7, { mergeApprovedAt: "2026-01-01T00:00:00Z" })] });
    const result = await applyIssueApproval("org/a", 3, "none", "stjohnb");

    expect(result).toEqual({ ok: false, status: 400, error: expect.stringContaining("send the issue back to Ideas") });
    expect(mockIssues.setApprovedThrough).not.toHaveBeenCalled();
    expect(mockDb.upsertClawsPr).not.toHaveBeenCalled();
  });

  it("refuses none for an issue with no tracker record, creating none", async () => {
    mockPlanned.resolveTrackerId.mockResolvedValueOnce(null);
    const result = await applyIssueApproval("org/a", 3, "none", "stjohnb", { create: { title: "T", authorLogin: "a" } });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(mockPlanned.resolveTrackerId).toHaveBeenCalledWith("org/a", 3, undefined);
  });

  // A partial Merge from single-PR approvals on an issue approved through nothing.
  it("restating none only clears the approved open PR rows", async () => {
    mockDb.getClawsIssue.mockResolvedValue(record({ approved_through: "none" }));
    mockIssues.setApprovedThrough.mockResolvedValue(false);
    mockFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [pr(7, { mergeApprovedAt: "2026-01-01T00:00:00Z" })] });

    const result = await applyIssueApproval("org/a", 3, "none", "stjohnb");

    expect(result).toMatchObject({ ok: true, before: "none", after: "none", changed: true });
    expect(mockDb.clearPrMergeApprovals).toHaveBeenCalledWith([pr(7, { mergeApprovedAt: "2026-01-01T00:00:00Z" })]);
    expect(mockIssues.promoteIssue).not.toHaveBeenCalled();
    expect(postedComment()).toContain("The merge approval is withdrawn.");
  });

  it("returns 404 when the issue has no tracker record, or the record is gone", async () => {
    mockPlanned.resolveTrackerId.mockResolvedValueOnce(null);
    expect(await applyIssueApproval("org/a", 3, "plan", "stjohnb")).toMatchObject({ ok: false, status: 404 });

    mockDb.getClawsIssue.mockResolvedValueOnce(undefined);
    expect(await applyIssueApproval("org/a", 3, "plan", "stjohnb")).toMatchObject({ ok: false, status: 404 });
    expect(mockIssues.setApprovedThrough).not.toHaveBeenCalled();
  });

  it("passes the shadow-creation fields through to the tracker lookup", async () => {
    const create = { title: "Forge", authorLogin: "someone" };
    await applyIssueApproval("org/a", 3, "plan", "stjohnb", { create });
    expect(mockPlanned.resolveTrackerId).toHaveBeenCalledWith("org/a", 3, create);
  });

  it("reports a thrown error as a 500", async () => {
    mockFlight.loadIssueFlight.mockRejectedValue(new Error("db down"));
    await expect(applyIssueApproval("org/a", 3, "merge", "stjohnb")).resolves.toEqual({
      ok: false, status: 500, error: "Error: db down",
    });
  });

  describe("from Ideas", () => {
    beforeEach(() => {
      mockDb.getClawsIssue.mockResolvedValue(record({ lifecycle: "ideas", requirements_approved_at: null, approved_through: "none" }));
    });

    it("promotes the issue by default before writing the approval", async () => {
      const result = await applyIssueApproval("org/a", TRACKER, "plan", "stjohnb");

      expect(mockIssues.promoteIssue).toHaveBeenCalledWith(TRACKER, "stjohnb", "ideas");
      expect(mockIssues.setApprovedThrough).toHaveBeenCalledWith(TRACKER, "plan", "stjohnb");
      expect(mockIssues.promoteIssue.mock.invocationCallOrder[0]).toBeLessThan(mockIssues.setApprovedThrough.mock.invocationCallOrder[0]!);
      expect(result).toEqual({ ok: true, trackerId: TRACKER, before: "none", after: "plan", changed: true, openPrs: 0 });
    });

    it("does not promote when a Plan pre-approval is only restated (a Merge withdrawal that changes nothing)", async () => {
      mockDb.getClawsIssue.mockResolvedValue(record({ lifecycle: "ideas", requirements_approved_at: null, approved_through: "plan" }));

      await applyIssueApproval("org/a", TRACKER, "plan", "stjohnb");

      expect(mockIssues.promoteIssue).not.toHaveBeenCalled();
    });

    it("still promotes when Requirements is approved on an issue already through Requirements", async () => {
      mockDb.getClawsIssue.mockResolvedValue(record({ lifecycle: "ideas", requirements_approved_at: null, approved_through: "requirements" }));

      await applyIssueApproval("org/a", TRACKER, "requirements", "stjohnb");

      expect(mockIssues.promoteIssue).toHaveBeenCalledWith(TRACKER, "stjohnb", "ideas");
    });

    it("approves a pending design change instead of a plain promotion", async () => {
      mockReapproval.hasPendingReapproval.mockResolvedValue(true);

      await applyIssueApproval("org/a", TRACKER, "requirements", "stjohnb");

      expect(mockReapproval.promoteReapproval).toHaveBeenCalledWith(TRACKER, "stjohnb");
      expect(mockIssues.promoteIssue).not.toHaveBeenCalled();
      expect(mockReapproval.approveReapproval).not.toHaveBeenCalled();
    });

    it("returns a lost default promotion as a 409 and writes nothing", async () => {
      mockIssues.promoteIssue.mockResolvedValue(false);

      const result = await applyIssueApproval("org/a", TRACKER, "plan", "stjohnb");

      expect(result).toMatchObject({ ok: false, status: 409 });
      expect(mockIssues.setApprovedThrough).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("uses the caller's promotion when given, and returns its failure", async () => {
      const promote = vi.fn(async () => ({ ok: true as const }));
      await applyIssueApproval("org/a", TRACKER, "plan", "stjohnb", { promote });
      expect(promote).toHaveBeenCalledTimes(1);
      expect(mockIssues.promoteIssue).not.toHaveBeenCalled();

      const failing = vi.fn(async () => ({ ok: false as const, status: 422, error: "No requirements to approve" }));
      vi.clearAllMocks();
      expect(await applyIssueApproval("org/a", TRACKER, "plan", "stjohnb", { promote: failing }))
        .toEqual({ ok: false, status: 422, error: "No requirements to approve" });
      expect(mockIssues.setApprovedThrough).not.toHaveBeenCalled();
    });
  });

  it("approves a pending design change when raising to plan", async () => {
    mockReapproval.hasPendingReapproval.mockResolvedValue(true);

    await applyIssueApproval("org/a", TRACKER, "plan", "stjohnb");

    expect(mockReapproval.approveReapproval).toHaveBeenCalledWith(TRACKER, "stjohnb");
    expect(mockIssues.promoteIssue).not.toHaveBeenCalled();
  });

  it("leaves a pending design change alone when the value stays below plan", async () => {
    mockReapproval.hasPendingReapproval.mockResolvedValue(true);

    await applyIssueApproval("org/a", TRACKER, "requirements", "stjohnb");

    expect(mockReapproval.approveReapproval).not.toHaveBeenCalled();
  });

  it("raising to merge writes each unapproved open PR row", async () => {
    mockDb.getClawsIssue.mockResolvedValue(record({ approved_through: "plan" }));
    mockFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [pr(7), pr(8, { mergeApprovedAt: "2026-01-01T00:00:00Z" }), pr(9)] });

    const result = await applyIssueApproval("org/a", TRACKER, "merge", "dashboard");

    expect(result).toEqual({ ok: true, trackerId: TRACKER, before: "plan", after: "merge", changed: true, openPrs: 3 });
    expect(mockDb.upsertClawsPr).toHaveBeenCalledTimes(2);
    for (const n of [7, 9]) {
      expect(mockDb.upsertClawsPr).toHaveBeenCalledWith("org/a", n, { mergeApprovedBy: "dashboard", mergeApprovedAt: expect.any(String) });
    }
  });

  it("lowering from merge clears every open row, including a board infra approval", async () => {
    mockDb.getClawsIssue.mockResolvedValue(record({ approved_through: "merge" }));
    const openPrs = [pr(7, { mergeApprovedAt: "2026-01-01T00:00:00Z" }), pr(8), pr(9, { infraMergeApprovedAt: "2026-01-01T00:00:00Z" })];
    mockFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs });

    await applyIssueApproval("org/a", TRACKER, "plan", "dashboard");

    expect(mockDb.clearPrMergeApprovals).toHaveBeenCalledWith(openPrs);
    expect(mockDb.upsertClawsPr).not.toHaveBeenCalled();
  });

  it("restating plan while every open row is approved withdraws the rows (the track's Merge withdraw)", async () => {
    mockDb.getClawsIssue.mockResolvedValue(record({ approved_through: "plan" }));
    mockIssues.setApprovedThrough.mockResolvedValue(false);
    mockFlight.loadIssueFlight.mockResolvedValue({
      implementing: false,
      openPrs: [pr(7, { mergeApprovedAt: "2026-01-01T00:00:00Z" }), pr(8, { mergeApprovedAt: "2026-01-01T00:00:00Z" })],
    });

    const result = await applyIssueApproval("org/a", TRACKER, "plan", "dashboard");

    expect(result).toMatchObject({ ok: true, before: "plan", after: "plan", changed: true });
    expect(mockDb.clearPrMergeApprovals).toHaveBeenCalledWith([
      pr(7, { mergeApprovedAt: "2026-01-01T00:00:00Z" }),
      pr(8, { mergeApprovedAt: "2026-01-01T00:00:00Z" }),
    ]);
  });

  // A partial Merge (single-PR approvals) is left alone by a plain restate, so
  // a restate that only re-affirms Plan keeps them; withdrawing it on purpose
  // passes clearMergeRows.
  it("restating plan with only some rows approved clears them only with clearMergeRows", async () => {
    mockDb.getClawsIssue.mockResolvedValue(record({ approved_through: "plan" }));
    mockIssues.setApprovedThrough.mockResolvedValue(false);
    const openPrs = [pr(7, { mergeApprovedAt: "2026-01-01T00:00:00Z" }), pr(8)];
    mockFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs });

    expect(await applyIssueApproval("org/a", TRACKER, "plan", "dashboard")).toMatchObject({ ok: true, changed: false });
    expect(mockDb.clearPrMergeApprovals).not.toHaveBeenCalled();

    const result = await applyIssueApproval("org/a", TRACKER, "plan", "dashboard", { clearMergeRows: true });

    expect(result).toMatchObject({ ok: true, before: "plan", after: "plan", changed: true });
    expect(mockDb.clearPrMergeApprovals).toHaveBeenCalledWith(openPrs);
    expect(postedComment()).toContain("The merge approval is withdrawn.");
  });

  it("raising to plan leaves approved rows alone", async () => {
    mockDb.getClawsIssue.mockResolvedValue(record({ approved_through: "none" }));
    mockFlight.loadIssueFlight.mockResolvedValue({ implementing: false, openPrs: [pr(7, { mergeApprovedAt: "2026-01-01T00:00:00Z" })] });

    await applyIssueApproval("org/a", TRACKER, "plan", "dashboard");

    expect(mockDb.upsertClawsPr).not.toHaveBeenCalled();
    expect(mockDb.clearPrMergeApprovals).not.toHaveBeenCalled();
  });

  describe("the comment", () => {
    it("names the gate and who set it on a raise", async () => {
      await applyIssueApproval("org/a", 3, "plan", "stjohnb");

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith("org/a", 3, expect.any(String), undefined);
      const body = postedComment()!;
      expect(body.startsWith(`${APPROVAL_COMMENT_PREFIX} Plan** by \`stjohnb\``)).toBe(true);
      expect(body).toContain("Claws implements the plan without stopping for review.");
    });

    it("posts in the agent's name and carries the reason when given", async () => {
      mockDb.getClawsIssue.mockResolvedValue(record({ approved_through: "plan" }));

      await applyIssueApproval("org/a", 3, "merge", "ci-fixer", { agentName: "ci-fixer", reason: "Filed pre-approved." });

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith("org/a", 3, expect.any(String), { agentName: "ci-fixer" });
      const body = postedComment()!;
      expect(body.startsWith(`${APPROVAL_COMMENT_PREFIX} Merge**`)).toBe(true);
      expect(body).toContain("Claws merges each PR on green CI and a clean review.");
      expect(body.endsWith(" Filed pre-approved.")).toBe(true);
    });

    it("announces a withdrawal on a lower", async () => {
      mockDb.getClawsIssue.mockResolvedValue(record({ approved_through: "merge" }));

      await applyIssueApproval("org/a", 3, "requirements", "issue-refiner");

      const body = postedComment()!;
      expect(body.startsWith(`${APPROVAL_WITHDRAWN_PREFIX} by \`issue-refiner\``)).toBe(true);
      expect(body).toContain("approved through Requirements only (was Merge).");
      expect(body).toContain("The merge approval is withdrawn.");
      expect(body).toContain("The plan stops for review.");
    });

    it("posts nothing when nothing changed", async () => {
      mockDb.getClawsIssue.mockResolvedValue(record({ approved_through: "plan" }));
      mockIssues.setApprovedThrough.mockResolvedValue(false);

      const result = await applyIssueApproval("org/a", 3, "plan", "stjohnb");

      expect(result).toMatchObject({ ok: true, changed: false });
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("posts nothing with comment: false", async () => {
      await applyIssueApproval("org/a", 3, "plan", "stjohnb", { comment: false });
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("keeps the write when the comment fails", async () => {
      mockGh.commentOnIssue.mockRejectedValueOnce(new Error("forge down"));
      await expect(applyIssueApproval("org/a", 3, "plan", "stjohnb")).resolves.toMatchObject({ ok: true, changed: true });
    });
  });
});

describe("readIssueApproval", () => {
  it("reads a tracker record's value, who set it and when, and when it last rose through Plan", async () => {
    mockDb.getClawsIssue.mockResolvedValue(record({ approved_through: "merge", approved_through_by: "stjohnb", approved_through_at: "2026-02-03 04:05:06", plan_approved_at: "2026-02-01 00:00:00" }));

    expect(await readIssueApproval("org/a", 3)).toEqual({
      trackerId: TRACKER, approvedThrough: "merge", by: "stjohnb", at: "2026-02-03T04:05:06Z", planAt: "2026-02-01T00:00:00Z",
    });
  });

  it("reads none with no tracker record, or a record never approved", async () => {
    mockPlanned.resolveTrackerId.mockResolvedValueOnce(null);
    expect(await readIssueApproval("org/a", 3)).toEqual({ trackerId: null, approvedThrough: "none", by: null, at: null, planAt: null });
    expect(mockDb.getClawsIssue).not.toHaveBeenCalled();

    mockDb.getClawsIssue.mockResolvedValue({ id: TRACKER, lifecycle: "ideas" });
    expect(await readIssueApproval("org/a", 3)).toEqual({ trackerId: TRACKER, approvedThrough: "none", by: null, at: null, planAt: null });
  });
});

describe("withdrawPlanApproval", () => {
  it("lowers an approval through Plan or Merge to Requirements", async () => {
    mockDb.getClawsIssue.mockResolvedValue(record({ approved_through: "merge" }));

    const result = await withdrawPlanApproval("org/a", 3, "issue-worker", { comment: false });

    expect(result).toMatchObject({ ok: true, before: "merge", after: "requirements", changed: true });
    expect(mockIssues.setApprovedThrough).toHaveBeenCalledWith(TRACKER, "requirements", "issue-worker");
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("leaves a lower approval alone rather than raising it, so an issue in Ideas is never promoted", async () => {
    mockDb.getClawsIssue.mockResolvedValue(record({ lifecycle: "ideas", requirements_approved_at: null, approved_through: "none" }));

    const result = await withdrawPlanApproval("org/a", 3, "issue-worker");

    expect(result).toMatchObject({ ok: true, before: "none", after: "none", changed: false });
    expect(mockIssues.promoteIssue).not.toHaveBeenCalled();
    expect(mockIssues.setApprovedThrough).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  // The contract the agent tests' stand-ins for this helper copy
  // (issue-worker.test.ts, issue-refiner.test.ts): a failed read answers 500, writing nothing.
  it("answers a failed approval read with a 500 and writes nothing", async () => {
    mockDb.getClawsIssue.mockRejectedValue(new Error("db down"));

    const result = await withdrawPlanApproval("org/a", 3, "issue-worker");

    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(mockIssues.setApprovedThrough).not.toHaveBeenCalled();
  });
});
