import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
  LABELS: {
    blocked: "Blocked",
    duplicate: "Duplicate",
  },
  issueUrl: (repo: string, ref: string | number) => `https://claws.example.invalid/issues/${ref}?repo=${repo}`,
}));

const mockNotify = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./slack.js", () => ({ notify: mockNotify }));

vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const { mockGh, mockDb } = vi.hoisted(() => ({
  mockGh: {
    addLabel: vi.fn(),
    blockIssue: vi.fn(),
    removeLabel: vi.fn(),
    setIssueLifecycle: vi.fn(),
    commentOnIssue: vi.fn(),
    closeIssue: vi.fn(),
    getIssueComments: vi.fn(),
    getIssueState: vi.fn(),
    getLastReopenedAt: vi.fn(),
    isClawsComment: (body: string) => /\*— Automated by Claws/.test(body),
  },
  mockDb: { getClawsIssue: vi.fn(), claimAlertAttention: vi.fn().mockResolvedValue(false) },
}));
vi.mock("./github.js", () => mockGh);
vi.mock("./db.js", () => mockDb);
vi.mock("./imported-refs.js", () => ({ issueRefAliases: (_repo: string, ref: unknown) => [ref] }));

import {
  blockAlertForHuman,
  isDuplicateToSettle,
  parkAmbiguousCoverage,
  parkForHuman,
  parkWaitingOnPRs,
  returnToPlanReview,
  settleDuplicate,
  settleMergedSingleStep,
} from "./issue-handback.js";

const REPO = "org/repo";
const PLAN = (extra = "") => `*— Automated by Claws —*\n\n## Implementation Plan\n\nDo it.${extra}`;

/** Every label call in order, as `+Label` / `-Label`; a `blockIssue` reads as `+Blocked`. */
function labelOps(): string[] {
  const ops: { order: number; op: string }[] = [
    ...mockGh.addLabel.mock.calls.map((c, i) => ({ order: mockGh.addLabel.mock.invocationCallOrder[i], op: `+${c[2]}` })),
    ...mockGh.blockIssue.mock.calls.map((_c, i) => ({ order: mockGh.blockIssue.mock.invocationCallOrder[i], op: "+Blocked" })),
    ...mockGh.removeLabel.mock.calls.map((c, i) => ({ order: mockGh.removeLabel.mock.invocationCallOrder[i], op: `-${c[2]}` })),
  ];
  return ops.sort((a, b) => a.order - b.order).map((o) => o.op);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGh.addLabel.mockResolvedValue(undefined);
  mockGh.blockIssue.mockResolvedValue(undefined);
  mockGh.removeLabel.mockResolvedValue(true);
  mockGh.setIssueLifecycle.mockResolvedValue(undefined);
  mockGh.commentOnIssue.mockResolvedValue(undefined);
  mockGh.closeIssue.mockResolvedValue(undefined);
  mockGh.getIssueComments.mockResolvedValue([]);
  mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
});

describe("returnToPlanReview", () => {
  it("moves the lifecycle to Awaiting plan review and writes no label", async () => {
    await returnToPlanReview(REPO, 1);
    expect(mockGh.setIssueLifecycle).toHaveBeenCalledWith(REPO, 1, "awaiting-plan-review");
    expect(labelOps()).toEqual([]);
  });
});

describe("parkForHuman", () => {
  it("comments once, moves to Blocked with no other label write, and stores the reason", async () => {
    await parkForHuman(REPO, 1, "Something needs you.", "Implementer", { slug: "thing" });

    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(REPO, 1, expect.stringMatching(/## Needs a human[\s\S]*Something needs you\.[\s\S]*claws-needs-human:thing/), { agentName: "Implementer" });
    expect(labelOps()).toEqual(["+Blocked"]);
    expect(mockGh.blockIssue).toHaveBeenCalledWith(REPO, 1, "Something needs you.");
    expect(mockGh.addLabel).not.toHaveBeenCalledWith(REPO, 1, "Blocked");
  });

  it("posts the marker comment only after the move landed", async () => {
    mockGh.blockIssue.mockRejectedValueOnce(new Error("forge 502"));

    await expect(parkForHuman(REPO, 1, "Reason.", "Implementer", { slug: "thing" })).rejects.toThrow("forge 502");
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("skips its own comment when the caller already posted one", async () => {
    await parkForHuman(REPO, 1, "Reason.", "Implementer", { slug: "thing", skipComment: true });

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.blockIssue).toHaveBeenCalledWith(REPO, 1, expect.any(String));
  });

  describe("on an alert issue", () => {
    const ALERT = "clw_01M5YPSK289NXAK8E6K6RNTFS5";

    it("posts one Slack line naming the reason and the issue", async () => {
      mockDb.claimAlertAttention.mockResolvedValueOnce(true);
      await parkForHuman(REPO, ALERT, "\nThe fix failed CI three times.\nMore detail.", "Implementer", { slug: "thing", comments: [] });

      expect(mockDb.claimAlertAttention).toHaveBeenCalledWith(ALERT);
      expect(mockNotify).toHaveBeenCalledTimes(1);
      const text = mockNotify.mock.calls[0][0] as string;
      expect(text).toContain(`${REPO} ${ALERT} needs a human — The fix failed CI three times.`);
      expect(text).not.toContain("More detail");
      expect(text).toContain(`https://claws.example.invalid/issues/${ALERT}`);
    });

    it("announces a park that skips its own comment, like the phase-stuck circuit breaker", async () => {
      mockDb.claimAlertAttention.mockResolvedValueOnce(true);
      await parkForHuman(REPO, ALERT, "Step 2 of 3 has been attempted 3 times without producing any commits.", "Implementer", { slug: "phase-stuck-2", comments: [], skipComment: true });
      expect(mockNotify).toHaveBeenCalledTimes(1);
    });

    it("posts once per Blocked stay, however many parks land on it", async () => {
      mockDb.claimAlertAttention.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await parkForHuman(REPO, ALERT, "First.", "Implementer", { slug: "phase-stuck-2", comments: [], skipComment: true });
      await parkForHuman(REPO, ALERT, "Second.", "Implementer", { slug: "unmanaged-step-2", comments: [], skipComment: true });
      expect(mockNotify).toHaveBeenCalledTimes(1);
    });

    it("claims the stay but posts nothing with announce: false", async () => {
      mockDb.claimAlertAttention.mockResolvedValueOnce(true);
      await parkForHuman(REPO, ALERT, "Operator step.", "Auto Merger", { slug: "thing", comments: [], announce: false });
      expect(mockDb.claimAlertAttention).toHaveBeenCalledWith(ALERT);
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it("posts nothing when the claim fails (not an alert, or already announced)", async () => {
      await parkForHuman(REPO, ALERT, "Reason.", "Implementer", { slug: "thing", comments: [] });
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it("never claims for a forge issue", async () => {
      await parkForHuman(REPO, 1, "Reason.", "Implementer", { slug: "thing", comments: [] });
      expect(mockDb.claimAlertAttention).not.toHaveBeenCalled();
    });
  });

  it("does not post the comment a second time for the same slug", async () => {
    await parkForHuman(REPO, 1, "Again.", "Implementer", { slug: "thing", comments: [{ body: "## Needs a human\n\nclaws-needs-human:thing" }] });

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.blockIssue).toHaveBeenCalledWith(REPO, 1, expect.any(String));
  });

  it("leaves the issue as it was when the move to Blocked is refused", async () => {
    mockGh.blockIssue.mockRejectedValueOnce(new Error("A reason is required to mark an issue Blocked"));

    await expect(parkForHuman(REPO, 1, "Reason.", "Implementer", { slug: "x", comments: [] })).rejects.toThrow("reason is required");
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });
});

describe("parkWaitingOnPRs", () => {
  const PRS = [{ repo: "St-John-Software/bonkus", number: 3 }];

  it("parks in Blocked with the waiting reason and a comment saying Claws resumes by itself", async () => {
    await parkWaitingOnPRs(REPO, 1, PRS, "Step 2 waits on it", []);

    expect(labelOps()).toEqual(["+Blocked"]);
    const body = mockGh.commentOnIssue.mock.calls[0][2] as string;
    expect(body).toContain("## Waiting on an open PR\n\nWaiting on `St-John-Software/bonkus#3` to merge");
    expect(body).toContain("Step 2 waits on it. Claws has moved this issue to `Blocked` — the board shows it in Queued — and will move it out and continue with its next step by itself once that PR merges.");
    expect(body).not.toContain("Needs a human");
    expect(body).toContain("claws-needs-human:waiting-on-prs-St-John-Software-bonkus-3");
    expect(mockGh.blockIssue).toHaveBeenCalledWith(REPO, 1, "Waiting on `St-John-Software/bonkus#3` to merge");
  });

  it("comments once per PR set", async () => {
    await parkWaitingOnPRs(REPO, 1, PRS, "Step 2 waits on it", [{ body: "claws-needs-human:waiting-on-prs-St-John-Software-bonkus-3" }]);
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();

    await parkWaitingOnPRs(REPO, 1, [...PRS, { repo: REPO, number: 9 }], "Step 3 waits on them", [{ body: "claws-needs-human:waiting-on-prs-St-John-Software-bonkus-3" }]);
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.commentOnIssue.mock.calls[0][2]).toContain("once those PRs merge");
  });
});

describe("parkAmbiguousCoverage", () => {
  it("names the PRs and keys the marker to them", async () => {
    await parkAmbiguousCoverage(REPO, 1, [54], []);

    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(REPO, 1, expect.stringMatching(/PR #54 references this issue without a step marker[\s\S]*claws-needs-human:ambiguous-coverage-54/), expect.anything());
    expect(mockGh.blockIssue).toHaveBeenCalledWith(REPO, 1, expect.any(String));
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

    expect(mockGh.blockIssue).toHaveBeenCalledWith(REPO, 9, expect.stringContaining("reopened afterwards"));
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
    expect(mockGh.blockIssue).toHaveBeenCalledWith(REPO, 9, "PR #28 merged without closing this issue — close it if the work is done, or re-plan the remainder.");
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("does nothing for an issue that is already closed", async () => {
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "COMPLETED", labels: [] });

    expect(await settleMergedSingleStep(REPO, 9, [{ number: 28, body: "Part of #9" }])).toBe("none");
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });
});

describe("blockAlertForHuman", () => {
  const ALERT = "clw_01M5YPSK289NXAK8E6K6RNTFS5";

  it("blocks with the reason and announces an alert once per stay", async () => {
    mockGh.blockIssue.mockResolvedValue(undefined);
    mockDb.claimAlertAttention.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await blockAlertForHuman(REPO, ALERT, "The planner says this needs a credential.");
    await blockAlertForHuman(REPO, ALERT, "Still blocked.");

    expect(mockGh.blockIssue).toHaveBeenCalledWith(REPO, ALERT, "The planner says this needs a credential.");
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0]).toContain("needs a human — The planner says this needs a credential.");
  });

  it("does not announce when the move fails", async () => {
    mockGh.blockIssue.mockRejectedValueOnce(new Error("boom"));
    mockDb.claimAlertAttention.mockResolvedValueOnce(true);
    await expect(blockAlertForHuman(REPO, ALERT, "Reason.")).rejects.toThrow("boom");
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
