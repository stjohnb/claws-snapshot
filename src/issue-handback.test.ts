import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    blocked: "Blocked",
    duplicate: "Duplicate",
  },
}));

vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const { mockGh, mockDb, mockResolveTrackerId } = vi.hoisted(() => ({
  mockGh: {
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    commentOnIssue: vi.fn(),
    closeIssue: vi.fn(),
    getIssueComments: vi.fn(),
    getIssueState: vi.fn(),
    getLastReopenedAt: vi.fn(),
    isClawsComment: (body: string) => /\*— Automated by Claws/.test(body),
  },
  mockDb: {
    setShadowLifecycle: vi.fn(),
    setIssueBlockedReason: vi.fn(),
  },
  mockResolveTrackerId: vi.fn(),
}));
vi.mock("./github.js", () => mockGh);
vi.mock("./db.js", () => mockDb);
vi.mock("./planned-prs.js", () => ({ resolveTrackerId: mockResolveTrackerId }));
vi.mock("./imported-refs.js", () => ({ issueRefAliases: (_repo: string, ref: unknown) => [ref] }));

import {
  isDuplicateToSettle,
  parkAmbiguousCoverage,
  parkForHuman,
  returnToPlanReview,
  settleDuplicate,
  settleMergedSingleStep,
} from "./issue-handback.js";

const REPO = "org/repo";
const PLAN = (extra = "") => `*— Automated by Claws —*\n\n## Implementation Plan\n\nDo it.${extra}`;

/** Every label call in order, as `+Label` / `-Label`. */
function labelOps(): string[] {
  const ops: { order: number; op: string }[] = [
    ...mockGh.addLabel.mock.calls.map((c, i) => ({ order: mockGh.addLabel.mock.invocationCallOrder[i], op: `+${c[2]}` })),
    ...mockGh.removeLabel.mock.calls.map((c, i) => ({ order: mockGh.removeLabel.mock.invocationCallOrder[i], op: `-${c[2]}` })),
  ];
  return ops.sort((a, b) => a.order - b.order).map((o) => o.op);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGh.addLabel.mockResolvedValue(undefined);
  mockGh.removeLabel.mockResolvedValue(true);
  mockGh.commentOnIssue.mockResolvedValue(undefined);
  mockGh.closeIssue.mockResolvedValue(undefined);
  mockGh.getIssueComments.mockResolvedValue([]);
  mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
  mockResolveTrackerId.mockResolvedValue("clw_TRACKED");
});

describe("returnToPlanReview", () => {
  it("adds Ready before removing Refined", async () => {
    await returnToPlanReview(REPO, 1);
    expect(labelOps()).toEqual(["+Ready", "-Refined"]);
  });
});

describe("parkForHuman", () => {
  it("comments once, adds Blocked before removing Refined and Ready, and stores the reason", async () => {
    await parkForHuman(REPO, 1, "Something needs you.", "Implementer", { slug: "thing" });

    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(REPO, 1, expect.stringMatching(/## Needs a human[\s\S]*Something needs you\.[\s\S]*claws-needs-human:thing/), { agentName: "Implementer" });
    expect(labelOps()).toEqual(["+Blocked", "-Refined", "-Ready"]);
    expect(mockDb.setShadowLifecycle).toHaveBeenCalledWith("clw_TRACKED", "blocked");
    expect(mockDb.setIssueBlockedReason).toHaveBeenCalledWith("clw_TRACKED", "Something needs you.");
  });

  it("posts the marker comment only after the labels landed", async () => {
    mockGh.removeLabel.mockRejectedValueOnce(new Error("forge 502"));

    await expect(parkForHuman(REPO, 1, "Reason.", "Implementer", { slug: "thing" })).rejects.toThrow("forge 502");
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("skips its own comment when the caller already posted one", async () => {
    await parkForHuman(REPO, 1, "Reason.", "Implementer", { slug: "thing", skipComment: true });

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.addLabel).toHaveBeenCalledWith(REPO, 1, "Blocked");
  });

  it("does not post the comment a second time for the same slug", async () => {
    await parkForHuman(REPO, 1, "Again.", "Implementer", { slug: "thing", comments: [{ body: "## Needs a human\n\nclaws-needs-human:thing" }] });

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.addLabel).toHaveBeenCalledWith(REPO, 1, "Blocked");
  });

  it("still parks when the reason cannot be stored", async () => {
    mockResolveTrackerId.mockRejectedValue(new Error("db down"));

    await expect(parkForHuman(REPO, 1, "Reason.", "Implementer", { slug: "x", comments: [] })).resolves.toBeUndefined();
    expect(mockGh.addLabel).toHaveBeenCalledWith(REPO, 1, "Blocked");
  });
});

describe("parkAmbiguousCoverage", () => {
  it("names the PRs and keys the marker to them", async () => {
    await parkAmbiguousCoverage(REPO, 1, [54], []);

    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(REPO, 1, expect.stringMatching(/PR #54 references this issue without a step marker[\s\S]*claws-needs-human:ambiguous-coverage-54/), expect.anything());
    expect(mockGh.addLabel).toHaveBeenCalledWith(REPO, 1, "Blocked");
  });
});

describe("isDuplicateToSettle", () => {
  it("is true for the Duplicate label", () => {
    expect(isDuplicateToSettle([{ name: "Duplicate" }], [])).toBe(true);
  });

  it("is true for a duplicate-verdict plan not yet closed", () => {
    expect(isDuplicateToSettle([], [{ body: PLAN("\n\nCLAWS_DUPLICATE_OF: #3") }])).toBe(true);
  });

  it("is false once Claws closed it and a human reopened it and removed the label", () => {
    expect(isDuplicateToSettle([], [
      { body: PLAN("\n\nCLAWS_DUPLICATE_OF: #3") },
      { body: "Closing this issue as a duplicate of #3.\n\nclaws-duplicate-of:3" },
    ])).toBe(false);
  });

  it("is false for an ordinary plan", () => {
    expect(isDuplicateToSettle([], [{ body: PLAN() }])).toBe(false);
  });
});

describe("settleDuplicate", () => {
  it("closes as completed when the canonical issue closed as completed", async () => {
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "COMPLETED", labels: [] });

    await settleDuplicate(REPO, { number: 7, labels: [{ name: "Duplicate" }] }, [{ body: PLAN("\n\nCLAWS_DUPLICATE_OF: #3") }]);

    expect(mockGh.getIssueState).toHaveBeenCalledWith(REPO, 3);
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(REPO, 7, expect.stringContaining("claws-duplicate-of:3"), expect.anything());
    expect(mockGh.closeIssue).toHaveBeenCalledWith(REPO, 7, "completed");
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("closes as not planned while the canonical issue is open, adding Duplicate when missing", async () => {
    await settleDuplicate(REPO, { number: 7, labels: [] }, [{ body: PLAN("\n\nCLAWS_DUPLICATE_OF: #3") }]);

    expect(mockGh.addLabel).toHaveBeenCalledWith(REPO, 7, "Duplicate");
    expect(mockGh.closeIssue).toHaveBeenCalledWith(REPO, 7, "not_planned");
  });

  it("prefers the latest claws-duplicate-of marker over the plan and does not post it twice", async () => {
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "NOT_PLANNED", labels: [] });

    await settleDuplicate(REPO, { number: 7, labels: [{ name: "Duplicate" }] }, [
      { body: PLAN("\n\nCLAWS_DUPLICATE_OF: #3") },
      { body: "Session closed this as a duplicate of #clw_01M48WSA1CKA5K4RZ4MCM1MBC2.\n\nclaws-duplicate-of:clw_01M48WSA1CKA5K4RZ4MCM1MBC2" },
    ]);

    expect(mockGh.getIssueState).toHaveBeenCalledWith(REPO, "clw_01M48WSA1CKA5K4RZ4MCM1MBC2");
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.closeIssue).toHaveBeenCalledWith(REPO, 7, "not_planned");
  });

  it("does not repeat the no-canonical comment once its marker is on the issue", async () => {
    await settleDuplicate(REPO, { number: 7, labels: [{ name: "Duplicate" }] }, [{ body: PLAN() }, { body: "no canonical\n\nclaws-duplicate-of:none" }]);

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.closeIssue).toHaveBeenCalledWith(REPO, 7, "not_planned");
  });

  it("closes as not planned with an explanation when no canonical issue was recorded", async () => {
    await settleDuplicate(REPO, { number: 7, labels: [{ name: "Duplicate" }] }, [{ body: PLAN() }]);

    expect(mockGh.getIssueState).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(REPO, 7, expect.stringContaining("no canonical issue was recorded"), expect.anything());
    expect(mockGh.closeIssue).toHaveBeenCalledWith(REPO, 7, "not_planned");
  });
});

describe("settleMergedSingleStep", () => {
  it("closes the issue when a merged PR closes it", async () => {
    expect(await settleMergedSingleStep(REPO, 9, [{ number: 20, body: "Closes #9" }])).toBe("closed");
    expect(mockGh.closeIssue).toHaveBeenCalledWith(REPO, 9, "completed");
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("parks instead of closing an issue a human reopened after the PR merged", async () => {
    mockGh.getLastReopenedAt.mockResolvedValue("2026-10-02T00:00:00Z");

    expect(await settleMergedSingleStep(REPO, 9, [{ number: 20, body: "Closes #9", mergedAt: "2026-10-01T00:00:00Z" }])).toBe("parked");

    expect(mockGh.closeIssue).not.toHaveBeenCalled();
    expect(mockGh.addLabel).toHaveBeenCalledWith(REPO, 9, "Blocked");
    expect(mockDb.setIssueBlockedReason).toHaveBeenCalledWith("clw_TRACKED", expect.stringContaining("reopened afterwards"));
  });

  it("still closes when the reopen predates the merge or there was none", async () => {
    mockGh.getLastReopenedAt.mockResolvedValueOnce("2026-09-30T00:00:00Z");
    expect(await settleMergedSingleStep(REPO, 9, [{ number: 20, body: "Closes #9", mergedAt: "2026-10-01T00:00:00Z" }])).toBe("closed");
    mockGh.getLastReopenedAt.mockResolvedValueOnce(null);
    expect(await settleMergedSingleStep(REPO, 9, [{ number: 20, body: "Closes #9", mergedAt: "2026-10-01T00:00:00Z" }])).toBe("closed");
    expect(mockGh.closeIssue).toHaveBeenCalledTimes(2);
  });

  it("parks a merged `Part of` PR for a human with its reason, never closing it", async () => {
    expect(await settleMergedSingleStep(REPO, 9, [{ number: 28, body: "Part of #9" }])).toBe("parked");

    expect(mockGh.closeIssue).not.toHaveBeenCalled();
    expect(mockGh.addLabel).toHaveBeenCalledWith(REPO, 9, "Blocked");
    expect(mockDb.setIssueBlockedReason).toHaveBeenCalledWith("clw_TRACKED", "PR #28 merged without closing this issue — close it if the work is done, or re-plan the remainder.");
    expect(mockGh.removeLabel).toHaveBeenCalledWith(REPO, 9, "Refined");
  });

  it("does nothing for an issue that is already closed", async () => {
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "COMPLETED", labels: [] });

    expect(await settleMergedSingleStep(REPO, 9, [{ number: 28, body: "Part of #9" }])).toBe("none");
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });
});
