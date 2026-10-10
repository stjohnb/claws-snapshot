// Design-change re-approval: start holds the change and its PRs, approval
// (by Refined or by promotion) closes, links, retargets and renumbers them.
// The database is a small in-memory fake; the forge and the refiner's plan
// edit are mocks, so each test pins exactly which writes land.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
  LABELS: { refined: "Refined", ready: "Ready", manualAction: "Manual Action" },
}));
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const { mockDb, mockGh, mockClawsIssues, mockStore, mockRefiner, state } = vi.hoisted(() => {
  const state = {
    reapproval: null as null | Record<string, unknown>,
    issue: {} as Record<string, unknown>,
    prs: new Map<string, { manualActionReason: string | null }>(),
    planned: [] as Array<{ position: number; repo: string; title: string; prNumber: number | null; dependsOn: number[] | null; kind: "pr" | "manual"; manualAction: string | null; targetPrNumber?: number | null }>,
  };
  const mockDb = {
    getIssueReapproval: vi.fn(async () => (state.reapproval ? { ...state.reapproval } : null)),
    upsertIssueReapproval: vi.fn(async (row: Record<string, unknown>) => {
      state.reapproval = { ...row, requestedAt: "2026-10-09 12:00:00", approvedAt: null, approvedBy: null };
    }),
    markIssueReapprovalApproved: vi.fn(async (_id: string, by: string) => {
      if (!state.reapproval || state.reapproval.approvedAt) return false;
      state.reapproval = { ...state.reapproval, approvedAt: "2026-10-09 13:00:00", approvedBy: by };
      return true;
    }),
    getClawsIssue: vi.fn(async () => ({ ...state.issue })),
    getImportedIssueByNative: vi.fn(async () => undefined),
    approveClawsIssueRequirements: vi.fn(async () => true),
    getClawsPr: vi.fn(async (repo: string, n: number) => {
      const row = state.prs.get(`${repo}#${n}`);
      return row ? { ...row } : null;
    }),
    upsertClawsPr: vi.fn(async (repo: string, n: number, patch: { manualActionReason?: string | null }) => {
      state.prs.set(`${repo}#${n}`, { manualActionReason: patch.manualActionReason ?? null });
    }),
    replaceIssuePlannedPRs: vi.fn(async (_id: string, entries: Array<{ repo: string; title: string; kind?: "pr" | "manual" }>) => {
      // Carries an old link over by position, as the real one does.
      const old = state.planned;
      state.planned = entries.map((e, i) => ({
        position: i + 1, repo: e.repo, title: e.title, dependsOn: null, kind: e.kind ?? "pr", manualAction: null,
        prNumber: old[i] && old[i].repo === e.repo ? old[i].prNumber : null,
      }));
      return [];
    }),
    getIssuePlannedPRs: vi.fn(async () => state.planned.map((e) => ({ ...e }))),
    linkIssuePlannedPR: vi.fn(async (_id: string, position: number, n: number) => {
      state.planned[position - 1]!.prNumber = n;
    }),
    unlinkIssuePlannedPR: vi.fn(async (_id: string, position: number) => {
      state.planned[position - 1]!.prNumber = null;
    }),
    setIssuePlannedPRTarget: vi.fn(async (_id: string, position: number, n: number | null) => {
      state.planned[position - 1]!.targetPrNumber = n;
    }),
  };
  const mockGh = {
    removeLabel: vi.fn(async (repo: string, n: number, label: string) => {
      // The Manual Action removal hook clears the recorded reason.
      if (label === "Manual Action") state.prs.set(`${repo}#${n}`, { manualActionReason: null });
      return true;
    }),
    addLabel: vi.fn(async () => undefined),
    getLiveLabels: vi.fn(async () => ["Refined"]),
    getPRState: vi.fn(async (_repo: string, _n: number): Promise<string> => "OPEN"),
    commentOnIssue: vi.fn(async () => undefined),
    closePR: vi.fn(async () => undefined),
    listPRs: vi.fn(async () => [
      { number: 5, title: "Old step one (1/2)" },
      { number: 6, title: "Old step two (2/2)" },
      { number: 7, title: "Old extra (3/3)" },
    ]),
    getPRBody: vi.fn(async () => "## PR 1 of 2: Old\n\nPart of #clw_X"),
    updatePR: vi.fn(async () => undefined),
    getIssueComments: vi.fn(async () => [
      { id: "c1", body: "*— Automated by Claws —*\n\n## Implementation Plan\n\n> **Pending re-approval** — design change; requirements v3 and this plan wait for you to promote or apply Refined.\n\n### PR 1: A\n\nCLAWS_PLAN_BODY_HASH: " + "a".repeat(64) + "\nCLAWS_PLAN_LAST_COMMENT: 0\nCLAWS_PLAN_PENDING_REAPPROVAL: v3", login: "claws", body_html: "" },
    ]),
    getIssueTitleBody: vi.fn(async () => ({ title: "T", body: "B" })),
    editIssueComment: vi.fn(async () => undefined),
    isClawsComment: (body: string) => body.includes("Automated by Claws"),
  };
  const mockClawsIssues = {
    listRequirements: vi.fn(async () => [{ version: 2, commentId: null }, { version: 3, title: "New", kind: "feature", context: "c", requirement: "r", acceptanceCriteria: ["a"], outOfScope: [], commentId: null, createdAt: "x" }]),
    primaryRepo: (repos: readonly string[]) => [...repos].sort()[0] ?? "",
    promoteIssue: vi.fn(async () => true),
  };
  const mockStore = { storeRequirementsVersion: vi.fn(async () => ({ trackerId: "clw_X", version: 3 })) };
  const mockRefiner = {
    editPlanInPlace: vi.fn(async () => undefined),
    renderPlanBody: vi.fn(() => "PLAN BODY"),
    issueContentHash: vi.fn(() => "b".repeat(64)),
    PLAN_BODY_HASH_MARKER: "CLAWS_PLAN_BODY_HASH:",
    PLAN_HEADER: "## Implementation Plan",
  };
  return { mockDb, mockGh, mockClawsIssues, mockStore, mockRefiner, state };
});

vi.mock("./db.js", () => mockDb);
vi.mock("./github.js", () => mockGh);
vi.mock("./claws-issues.js", () => mockClawsIssues);
vi.mock("./agents/requirements-writer.js", () => mockStore);
vi.mock("./agents/issue-refiner.js", () => mockRefiner);
vi.mock("./planned-prs.js", () => ({ resolveTrackerId: vi.fn(async () => "clw_X") }));

import { approveReapproval, promoteReapproval, settlePendingReapproval, startReapproval, REFINED_APPROVER } from "./reapproval.js";
import { releaseReapprovalHold, REAPPROVAL_HOLD_PREFIX } from "./pr-hold.js";
import type { FollowupVerdict, PlanSubmission } from "./planner-runs.js";

const REPO = "org/a";
const REQUIREMENTS = { title: "New", kind: "feature" as const, context: "c", requirement: "r", acceptanceCriteria: ["a"], outOfScope: [] };
const PLAN: PlanSubmission = {
  kind: "plan", plan: "### PR 1: A\n\n### PR 2: B", implementationModel: "sonnet", reviewModel: "sonnet", targetPr: null, response: null,
  prs: [
    { repo: REPO, title: "A", dependsOn: null, kind: "pr", manualAction: null },
    { repo: REPO, title: "B", dependsOn: null, kind: "pr", manualAction: null },
  ],
};
const VERDICT: FollowupVerdict = {
  verdict: "design_change", affectedPrs: [], requirements: REQUIREMENTS,
  prFates: [
    { repo: REPO, number: 5, fate: "keep", position: 1 },
    { repo: REPO, number: 6, fate: "close", position: null },
    { repo: REPO, number: 7, fate: "rework", position: 2 },
  ],
};
const OPEN = [5, 6, 7].map((n) => ({ repo: REPO, number: n, title: `#${n}`, phase: null }));
const ISSUE = { number: "clw_X", title: "T", body: "B", labels: [{ name: "Refined" }], author: { login: "op" } } as never;
const CTX = {
  planComment: { id: "c1", body: "old plan", login: "claws", body_html: "" },
  lastCommentId: "c9",
  attribution: "*Models used: sonnet*",
  requirementsAttribution: "*Models used: sonnet*",
  sourceComments: [{ id: "c9", body: "Move to the new registry", login: "op", body_html: "" }],
};

async function start(): Promise<string> {
  return await startReapproval({ fullName: REPO } as never, ISSUE, VERDICT, PLAN, OPEN, CTX);
}

const reasonOf = (n: number) => state.prs.get(`${REPO}#${n}`)?.manualActionReason ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  state.reapproval = null;
  state.issue = { id: "clw_X", kind: "native", repos: [REPO], lifecycle: "awaiting-plan-review", state: "open", approved_requirements_version: 2, requirements_approved_by: "op" };
  state.prs = new Map();
  state.planned = [
    { position: 1, repo: REPO, title: "Old one", prNumber: 5, dependsOn: null, kind: "pr", manualAction: null },
    { position: 2, repo: REPO, title: "Old two", prNumber: 6, dependsOn: null, kind: "pr", manualAction: null },
  ];
  mockGh.getPRState.mockResolvedValue("OPEN");
});

describe("startReapproval", () => {
  it("stores the requirements unapproved, edits the plan pending, records the row and drops Refined", async () => {
    await start();
    expect(mockStore.storeRequirementsVersion).toHaveBeenCalledWith(REPO, "clw_X", REQUIREMENTS, CTX.requirementsAttribution, expect.anything());
    expect(mockDb.approveClawsIssueRequirements).not.toHaveBeenCalled();
    expect(mockRefiner.editPlanInPlace).toHaveBeenCalledWith(expect.objectContaining({
      planBody: "PLAN BODY",
      prs: null,
      requirements: { version: 3, ...REQUIREMENTS },
      pendingReapproval: { version: 3, banner: expect.stringMatching(/^> \*\*Pending re-approval\*\* — design change; requirements v3 and this plan wait for you to promote or apply Refined\.$/) },
    }));
    expect(state.reapproval).toMatchObject({ issueId: "clw_X", requirementsVersion: 3, planCommentId: "c1", fates: VERDICT.prFates, sourceCommentIds: ["c9"], approvedAt: null });
    expect(mockGh.removeLabel).toHaveBeenCalledWith(REPO, "clw_X", "Refined");
    // The stored list is untouched until approval.
    expect(mockDb.replaceIssuePlannedPRs).not.toHaveBeenCalled();
  });

  it("holds the PRs it would close or rework, not the one it keeps, and names each fate", async () => {
    const summary = await start();
    expect(reasonOf(6)).toMatch(new RegExp(`^${REAPPROVAL_HOLD_PREFIX} .*would close this PR`));
    expect(reasonOf(7)).toMatch(new RegExp(`^${REAPPROVAL_HOLD_PREFIX} .*rework this PR into step 2 of 2`));
    expect(reasonOf(5)).toBeNull();
    expect(mockGh.addLabel).toHaveBeenCalledWith(REPO, 6, "Manual Action");
    expect(mockGh.addLabel).not.toHaveBeenCalledWith(REPO, 5, "Manual Action");
    expect(summary).toContain("Design change — waiting for your re-approval");
    expect(summary).toContain("#5 — kept as step 1 of 2: A");
    expect(summary).toContain("#6 — **held**; closed on approval");
    expect(summary).toContain("#7 — **held**; reworked on approval into step 2 of 2: B");
  });

  it("keeps an operator's own Manual Action instead of overwriting it", async () => {
    state.prs.set(`${REPO}#6`, { manualActionReason: "Rotate the secret first" });
    await start();
    expect(reasonOf(6)).toBe("Rotate the secret first");
    // Approval never lifts it either: only a re-approval hold is released.
    expect(await releaseReapprovalHold(REPO, 6)).toBe(false);
    expect(reasonOf(6)).toBe("Rotate the secret first");
  });

  it("releases what a replaced pending change held that the new one does not", async () => {
    await start();
    expect(reasonOf(6)).not.toBeNull();
    await startReapproval({ fullName: REPO } as never, ISSUE, { ...VERDICT, prFates: [
      { repo: REPO, number: 5, fate: "keep", position: 1 },
      { repo: REPO, number: 6, fate: "keep", position: 2 },
      { repo: REPO, number: 7, fate: "close", position: null },
    ] }, PLAN, OPEN, CTX);
    expect(reasonOf(6)).toBeNull();
    expect(reasonOf(7)).toMatch(/would close this PR/);
  });
});

describe("approveReapproval", () => {
  it("does nothing on Refined-less labels while the approved version is behind", async () => {
    await start();
    expect(await settlePendingReapproval("clw_X", [])).toBe(true);
    expect(mockDb.markIssueReapprovalApproved).not.toHaveBeenCalled();
  });

  it("approves on Refined: closes, links, retargets, renumbers, releases and resumes", async () => {
    await start();
    vi.clearAllMocks();
    expect(await settlePendingReapproval("clw_X", ["Refined"])).toBe(false);

    expect(mockDb.approveClawsIssueRequirements).toHaveBeenCalledWith("clw_X", 3, REFINED_APPROVER);
    expect(mockGh.closePR).toHaveBeenCalledTimes(1);
    expect(mockGh.closePR).toHaveBeenCalledWith(REPO, 6);
    expect(mockDb.replaceIssuePlannedPRs).toHaveBeenCalledWith("clw_X", expect.arrayContaining([expect.objectContaining({ title: "A" }), expect.objectContaining({ title: "B" })]));
    // Kept #5 is linked at step 1; step 2's carried link to closed #6 is gone,
    // and reworked #7 is its target, unlinked until the implementer pushes.
    expect(state.planned.map((e) => [e.prNumber, e.targetPrNumber ?? null])).toEqual([[5, null], [null, 7]]);
    // The reworked PR is renumbered to its new step; kept #5 already reads 1/2.
    expect(mockGh.updatePR).toHaveBeenCalledWith(REPO, 7, "## PR 2 of 2: Old\n\nPart of #clw_X", "Old extra (2/2)");
    expect(mockGh.updatePR).not.toHaveBeenCalledWith(REPO, 5, expect.anything(), expect.anything());
    // The kept PR may merge again; the reworked one stays held until pushed onto.
    expect(reasonOf(5)).toBeNull();
    expect(reasonOf(7)).toMatch(new RegExp(`^${REAPPROVAL_HOLD_PREFIX}`));
    // The plan loses its banner and marker and is re-stamped.
    const [, , edited] = mockGh.editIssueComment.mock.calls[0] as unknown as [string, string, string];
    expect(edited).not.toContain("Pending re-approval");
    expect(edited).not.toContain("CLAWS_PLAN_PENDING_REAPPROVAL");
    expect(edited).toContain(`CLAWS_PLAN_BODY_HASH: ${"b".repeat(64)}`);
    expect(state.reapproval).toMatchObject({ approvedBy: REFINED_APPROVER });
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(REPO, "clw_X", expect.stringContaining("Design change approved"), expect.anything());
    expect(mockGh.addLabel).toHaveBeenCalledWith(REPO, "clw_X", "Refined");
  });

  it("approves on promotion, from the issue's current column", async () => {
    await start();
    expect(await promoteReapproval("clw_X", "operator")).toBe(true);
    expect(mockClawsIssues.promoteIssue).toHaveBeenCalledWith("clw_X", "operator", "awaiting-plan-review");
    expect(state.reapproval).toMatchObject({ approvedBy: "operator" });
    expect(mockGh.closePR).toHaveBeenCalledWith(REPO, 6);
  });

  it("does not close a superseded PR that merged during the hold — it warns instead", async () => {
    await start();
    mockGh.getPRState.mockImplementation(async (_repo: string, n: number) => (n === 6 ? "MERGED" : "OPEN"));
    await approveReapproval("clw_X", "operator");
    expect(mockGh.closePR).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(REPO, "clw_X", expect.stringContaining("#6 — ⚠️ merged before the approval"), expect.anything());
  });

  it("is idempotent: a second approval, or a concurrent one, closes nothing twice", async () => {
    await start();
    const [first, second] = await Promise.all([approveReapproval("clw_X", "operator"), approveReapproval("clw_X", "operator")]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(await approveReapproval("clw_X", "operator")).toBe(false);
    expect(mockGh.closePR).toHaveBeenCalledTimes(1);
    expect(mockDb.markIssueReapprovalApproved).toHaveBeenCalledTimes(1);
  });

  it("skips the requirements approval a promotion already made", async () => {
    await start();
    state.issue = { ...state.issue, approved_requirements_version: 3 };
    expect(await settlePendingReapproval("clw_X", [])).toBe(false);
    expect(mockDb.approveClawsIssueRequirements).not.toHaveBeenCalled();
  });
});
