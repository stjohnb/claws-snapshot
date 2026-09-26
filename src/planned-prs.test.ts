import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const { mockGh, mockDb } = vi.hoisted(() => ({
  mockGh: {
    isClawsComment: (body: string) => /\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/.test(body),
    isAllowedActor: vi.fn(async () => true),
    getPRState: vi.fn(),
    listPRsCrossReferencingIssue: vi.fn(async (_repo: string, _issue: unknown): Promise<unknown[]> => []),
    listMergedPRsForIssue: vi.fn(async (): Promise<unknown[]> => []),
    getIssueComments: vi.fn(async (): Promise<unknown[]> => []),
    listOpenPRsForIssue: vi.fn(async (_repo: string, _issue: unknown): Promise<unknown[]> => []),
    listPRs: vi.fn(async (): Promise<unknown[]> => []),
  },
  mockDb: {
    getLinkedNativeId: vi.fn(),
    getIssuePlannedPRs: vi.fn(),
    unlinkIssuePlannedPR: vi.fn(),
    createShadowIssue: vi.fn(),
    recordImportedIssue: vi.fn(async () => true),
    listImportedIssues: vi.fn(async () => []),
  },
}));
vi.mock("./github.js", () => mockGh);
vi.mock("./db.js", () => mockDb);

import { alignPlanWithEntries, issueHasShippedWork, listOpenPhasePRs, loadIssuePhaseState, peekTotalPhases, resolveTrackerId } from "./planned-prs.js";
import { parsePlan } from "./plan-parser.js";

const REPO = "test-org/test-repo";
const PLAN = "*— Automated by Claws —*\n\n## Implementation Plan\n\n### PR 1: Schema\nAdd it.\n\n### PR 2: Readers\nUse it.";

function entries(...prNumbers: (number | null)[]) {
  return prNumbers.map((prNumber, i) => ({ position: i + 1, repo: REPO, title: `Step ${i + 1}`, prNumber, dependsOn: null as number[] | null }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.getLinkedNativeId.mockResolvedValue("clw_TRACKED");
  mockDb.getIssuePlannedPRs.mockResolvedValue([]);
  mockGh.listPRsCrossReferencingIssue.mockResolvedValue([]);
  mockGh.listMergedPRsForIssue.mockResolvedValue([]);
  mockGh.listOpenPRsForIssue.mockResolvedValue([]);
  mockGh.listPRs.mockResolvedValue([]);
  mockGh.getIssueComments.mockResolvedValue([]);
});

describe("resolveTrackerId", () => {
  it("resolves a native id to itself without touching the database", async () => {
    expect(await resolveTrackerId(REPO, "clw_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe("clw_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(mockDb.getLinkedNativeId).not.toHaveBeenCalled();
  });

  it("resolves a forge ref through its linkage row", async () => {
    expect(await resolveTrackerId(REPO, 12)).toBe("clw_TRACKED");
  });

  it("reads never mint a shadow; a writer does", async () => {
    mockDb.getLinkedNativeId.mockResolvedValue(undefined);
    expect(await resolveTrackerId(REPO, 12)).toBeNull();
    expect(mockDb.createShadowIssue).not.toHaveBeenCalled();

    mockDb.createShadowIssue.mockResolvedValue({ id: "clw_NEW", created: true });
    expect(await resolveTrackerId(REPO, 12, { title: "t", authorLogin: "a" })).toBe("clw_NEW");
  });

  it("uses the imported issue's id when the linkage row names an import", async () => {
    mockDb.getLinkedNativeId.mockResolvedValueOnce(undefined).mockResolvedValueOnce("clw_IMPORTED");
    mockDb.createShadowIssue.mockResolvedValue(undefined);
    expect(await resolveTrackerId(REPO, 12, { title: "t", authorLogin: "a" })).toBe("clw_IMPORTED");
  });
});

describe("loadIssuePhaseState", () => {
  it("counts a linked merged entry as done, from its PR state", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue(entries(40, null, null));
    mockGh.getPRState.mockResolvedValue("MERGED");

    const state = await loadIssuePhaseState(REPO, 12, [], { planText: PLAN });

    expect(state.totalPhases).toBe(3); // the stored list wins over the plan's two headers
    expect(state.entries).toHaveLength(3);
    expect(state.trackerId).toBe("clw_TRACKED");
    expect(mockGh.getPRState).toHaveBeenCalledWith(REPO, 40);
    expect([...state.coverage.done]).toEqual([1]);
    expect(state.coverage.coveringPRs.get(1)).toEqual({ number: 40, title: "Step 1", state: "merged" });
    expect(state.coverage.nextPhase).toBe(2);
    expect(state.coverage.lastMergedPhase).toBe(1);
    expect(state.coverage.openPhases).toEqual([]);
  });

  it("treats a linked open entry as covered but open", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue(entries(40, null));
    mockGh.getPRState.mockResolvedValue("OPEN");

    const { coverage } = await loadIssuePhaseState(REPO, 12, []);

    expect(coverage.covered.has(1)).toBe(true);
    expect(coverage.done.has(1)).toBe(false);
    expect(coverage.nextPhase).toBe(2);
    expect(coverage.openPhases).toEqual([1]);
  });

  it("unlinks a linked entry whose PR was closed unmerged, leaving it uncovered", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue(entries(40, null));
    mockGh.getPRState.mockResolvedValue("CLOSED");

    const { coverage } = await loadIssuePhaseState(REPO, 12, []);

    expect(mockDb.unlinkIssuePlannedPR).toHaveBeenCalledWith("clw_TRACKED", 1);
    expect(coverage.covered.size).toBe(0);
    expect(coverage.nextPhase).toBe(1);
  });

  it("keeps the link and counts the entry as open when the forge answers null", async () => {
    // A 403 or a DNS failure also reads as null — never proof the PR is gone.
    mockDb.getIssuePlannedPRs.mockResolvedValue(entries(40, null));
    mockGh.getPRState.mockResolvedValue(null);

    const { coverage } = await loadIssuePhaseState(REPO, 12, []);

    expect(mockDb.unlinkIssuePlannedPR).not.toHaveBeenCalled();
    expect(coverage.covered.has(1)).toBe(true);
    expect(coverage.done.has(1)).toBe(false);
    expect(coverage.nextPhase).toBe(2);
  });

  it("uses a stored list the caller already loaded instead of reading it again", async () => {
    mockGh.getPRState.mockResolvedValue("MERGED");

    const state = await loadIssuePhaseState(REPO, 12, [], { stored: { trackerId: "clw_PASSED", entries: entries(40, 41) } });

    expect(mockDb.getLinkedNativeId).not.toHaveBeenCalled();
    expect(mockDb.getIssuePlannedPRs).not.toHaveBeenCalled();
    expect(state.trackerId).toBe("clw_PASSED");
    expect(state.coverage.nextPhase).toBeNull();
  });

  it("covers an unlinked entry through a claim comment", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue(entries(40, null));
    mockGh.getPRState.mockResolvedValue("MERGED");
    const comments = [{ body: "claws-phase-done: 2", login: "stjohnb" }];

    const { coverage } = await loadIssuePhaseState(REPO, 12, comments);

    expect([...coverage.done].sort()).toEqual([1, 2]);
    expect(coverage.nextPhase).toBeNull();
  });

  it("does not let a linked PR also fill an unlinked position", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue(entries(40, null));
    mockGh.getPRState.mockResolvedValue("MERGED");
    // Claws' own merged PR for step 1, unmarked: the positional legacy fill must
    // not reuse it for step 2.
    mockGh.listMergedPRsForIssue.mockResolvedValue([{ number: 40, title: "fix: resolve #12", body: "Closes #12" }]);

    const { coverage } = await loadIssuePhaseState(REPO, 12, []);

    expect(coverage.covered.has(2)).toBe(false);
    expect(coverage.nextPhase).toBe(2);
  });

  // A multi-repo plan's step opens its PR in its own repo, so that is where
  // the fallback looks for it.
  it("looks for an unlinked entry's PR in that entry's own repo", async () => {
    const OTHER = "test-org/other-repo";
    mockDb.getIssuePlannedPRs.mockResolvedValue([
      { position: 1, repo: REPO, title: "Schema", prNumber: null },
      { position: 2, repo: OTHER, title: "Readers", prNumber: null },
    ]);
    mockGh.listPRsCrossReferencingIssue.mockImplementation(async (repo: string) => repo === OTHER
      ? [{ number: 7, title: "fix(#12): Readers (2/2)", body: "Part of #12", state: "open", login: "someone" }]
      : []);

    const { coverage } = await loadIssuePhaseState(REPO, 12, []);

    expect(mockGh.listPRsCrossReferencingIssue).toHaveBeenCalledWith(OTHER, 12);
    expect(coverage.covered.has(1)).toBe(false);
    expect(coverage.coveringPRs.get(2)).toMatchObject({ number: 7, state: "open" });
    expect(coverage.nextPhase).toBe(1);
  });

  it("falls back to the plan text when no list is stored", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue([]);
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
      { number: 50, title: "fix(#12): Schema (1/2)", body: "Part of #12", state: "merged", login: "someone" },
    ]);

    const state = await loadIssuePhaseState(REPO, 12, [{ body: PLAN, login: "claws" }]);

    expect(state.entries).toBeNull();
    expect(state.totalPhases).toBe(2);
    expect(state.coverage.coveringPRs.get(1)).toMatchObject({ number: 50, state: "merged" });
    expect(state.coverage.nextPhase).toBe(2);
    expect(mockGh.getPRState).not.toHaveBeenCalled();
  });

  it("falls back to the plan text when the stored list cannot be read", async () => {
    mockDb.getIssuePlannedPRs.mockRejectedValue(new Error("db down"));
    const state = await loadIssuePhaseState(REPO, 12, [], { planText: PLAN });
    expect(state.entries).toBeNull();
    expect(state.totalPhases).toBe(2);
  });

  // Forgejo's `listPRsCrossReferencingIssue` always returns `[]`, and on GitHub
  // it is 60 s-cached with no invalidation — either way an open branch PR can
  // still be invisible to it moments after Claws opens it. Falling back to
  // `listOpenPRsForIssue` closes that gap directly (#clw_01M39HFBMGFGXRYKWSDZRF9YDV).
  it("sees an open branch PR the cross-reference scan misses, on the legacy path", async () => {
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([]);
    mockGh.listOpenPRsForIssue.mockResolvedValue([
      { number: 60, title: "fix: Schema (1/2)", body: "Part of #12", headRefName: "claws/issue-12-a" },
    ]);

    const state = await loadIssuePhaseState(REPO, 12, [], { planText: PLAN });

    expect(state.coverage.covered.has(1)).toBe(true);
    expect(state.coverage.done.has(1)).toBe(false);
    expect(state.coverage.openPhases).toEqual([1]);
    expect(state.coverage.readyPhases).toEqual([]);
  });

  // Parallel dispatch opens several phase PRs at once; `listOpenPRsForIssue`
  // (fixed on Forgejo in src/github.ts) must surface every one of them, not
  // just the first, or the uncovered phase reads as ready and gets a duplicate PR.
  it("with two open branch PRs, (1/2) and (2/2), leaves readyPhases empty, on the legacy path", async () => {
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([]);
    mockGh.listOpenPRsForIssue.mockResolvedValue([
      { number: 60, title: "fix: Schema (1/2)", body: "", headRefName: "claws/issue-12-a" },
      { number: 61, title: "fix: Readers (2/2)", body: "", headRefName: "claws/issue-12-b" },
    ]);

    const state = await loadIssuePhaseState(REPO, 12, [], { planText: PLAN });

    expect(state.coverage.covered.size).toBe(2);
    expect(state.coverage.readyPhases).toEqual([]);
  });

  // `linkPlannedPR` is best-effort, so an entry for another repo can stay
  // unlinked while its PR is open there; the branch fold must check every
  // distinct repo among the unlinked entries, not just the issue's own.
  it("counts an unlinked entry's open branch PR in another repo as covered, via the branch fold", async () => {
    const OTHER = "test-org/other-repo";
    mockDb.getIssuePlannedPRs.mockResolvedValue([
      { position: 1, repo: REPO, title: "Schema", prNumber: null, dependsOn: null },
      { position: 2, repo: OTHER, title: "Readers", prNumber: null, dependsOn: null },
    ]);
    mockGh.listOpenPRsForIssue.mockImplementation(async (repo: string) => repo === OTHER
      ? [{ number: 70, title: "fix: Readers (2/2)", body: "", headRefName: "claws/issue-12-b" }]
      : []);

    const { coverage } = await loadIssuePhaseState(REPO, 12, []);

    expect(mockGh.listOpenPRsForIssue).toHaveBeenCalledWith(REPO, 12);
    expect(mockGh.listOpenPRsForIssue).toHaveBeenCalledWith(OTHER, 12);
    expect(coverage.covered.has(2)).toBe(true);
    expect(coverage.coveringPRs.get(2)).toMatchObject({ number: 70, state: "open" });
  });

  it("sees an open branch PR the cross-reference scan misses, for an unlinked stored entry", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue(entries(null, null));
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([]);
    mockGh.listOpenPRsForIssue.mockResolvedValue([
      { number: 60, title: "fix: Step 1 (1/2)", body: "", headRefName: "claws/issue-12-a" },
    ]);

    const { coverage } = await loadIssuePhaseState(REPO, 12, []);

    expect(coverage.covered.has(1)).toBe(true);
    expect(coverage.openPhases).toEqual([1]);
    expect(coverage.readyPhases).toEqual([]);
  });

  it("leaves nothing ready when an open branch PR's phase cannot be determined", async () => {
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([]);
    // No `(n/m)` marker at all — a hand-rolled or pre-refine branch PR.
    mockGh.listOpenPRsForIssue.mockResolvedValue([
      { number: 60, title: "wip", body: "", headRefName: "claws/issue-12-a" },
    ]);

    const state = await loadIssuePhaseState(REPO, 12, [], { planText: PLAN });

    expect(state.coverage.readyPhases).toEqual([]);
  });
});

describe("issueHasShippedWork", () => {
  it("is true on a merged PR in the issue repo, without reading the stored list", async () => {
    mockGh.listMergedPRsForIssue.mockResolvedValue([{ number: 40, title: "x", body: "" }]);
    expect(await issueHasShippedWork(REPO, 12)).toBe(true);
    expect(mockDb.getIssuePlannedPRs).not.toHaveBeenCalled();
  });

  it("is true when a stored step merged in another repo", async () => {
    const OTHER = "test-org/other-repo";
    mockDb.getIssuePlannedPRs.mockResolvedValue([
      { position: 1, repo: OTHER, title: "Readers", prNumber: 7 },
      { position: 2, repo: REPO, title: "Schema", prNumber: null },
    ]);
    mockGh.getPRState.mockResolvedValue("MERGED");
    expect(await issueHasShippedWork(REPO, 12)).toBe(true);
    expect(mockGh.getPRState).toHaveBeenCalledWith(OTHER, 7);
  });

  it("is false when no stored step has merged", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue(entries(40, null));
    mockGh.getPRState.mockResolvedValue("OPEN");
    expect(await issueHasShippedWork(REPO, 12, [])).toBe(false);
    expect(mockGh.getIssueComments).not.toHaveBeenCalled();
  });

  it("is false with neither merged PRs nor a stored list", async () => {
    expect(await issueHasShippedWork(REPO, 12)).toBe(false);
    expect(mockGh.getIssueComments).not.toHaveBeenCalled();
  });
});

describe("listOpenPhasePRs", () => {
  const OTHER = "test-org/other-repo";

  it("unions the issue repo's branch PRs with open linked entries in other repos, without a forge read for the same-repo entry", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue([
      { position: 1, repo: REPO, title: "Step 1", prNumber: 40, dependsOn: null },
      { position: 2, repo: OTHER, title: "Step 2", prNumber: 9, dependsOn: [] },
      { position: 3, repo: OTHER, title: "Step 3", prNumber: 11, dependsOn: null },
    ]);
    mockGh.listOpenPRsForIssue.mockResolvedValue([{ number: 40, title: "fix: Step 1 (1/3)", body: "", headRefName: "claws/issue-12-a" }]);
    // The same-repo entry (position 1) is answered from this cached list, not
    // an uncached `getPRState` read — it is open here regardless of `getPRState`,
    // which only ever says "MERGED" or "OPEN" for the other two, never for #40.
    mockGh.listPRs.mockResolvedValue([{ number: 40, title: "fix: Step 1 (1/3)", body: "", headRefName: "claws/issue-12-a", baseRefName: "main", labels: [], author: { login: "claws" } }]);
    mockGh.getPRState.mockImplementation(async (_repo: string, n: number) => (n === 11 ? "MERGED" : "OPEN"));

    expect(await listOpenPhasePRs(REPO, 12)).toEqual([
      { repo: REPO, number: 40, title: "fix: Step 1 (1/3)", phase: 1 },
      { repo: OTHER, number: 9, title: "Step 2", phase: 2 },
    ]);
    expect(mockGh.getPRState).not.toHaveBeenCalledWith(REPO, 40);
  });

  it("treats a same-repo entry absent from the cached open-PR list as not open", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue([
      { position: 1, repo: REPO, title: "Step 1", prNumber: 40, dependsOn: null },
    ]);
    mockGh.listOpenPRsForIssue.mockResolvedValue([]);
    mockGh.listPRs.mockResolvedValue([]);

    expect(await listOpenPhasePRs(REPO, 12)).toEqual([]);
    expect(mockGh.getPRState).not.toHaveBeenCalled();
  });

  it("numbers branch PRs by marker against the plan text when there is no stored list", async () => {
    mockDb.getLinkedNativeId.mockResolvedValue(undefined);
    mockGh.getIssueComments.mockResolvedValue([{ body: PLAN, login: "claws" }]);
    mockGh.listOpenPRsForIssue.mockResolvedValue([
      { number: 50, title: "fix: Readers (2/2)", body: "", headRefName: "claws/issue-12-a" },
      { number: 51, title: "fix: something", body: "", headRefName: "claws/issue-12-b" },
    ]);

    expect(await listOpenPhasePRs(REPO, 12)).toEqual([
      { repo: REPO, number: 50, title: "fix: Readers (2/2)", phase: 2 },
      { repo: REPO, number: 51, title: "fix: something", phase: null },
    ]);
  });

  it("is empty with no open PR anywhere, without reading comments", async () => {
    expect(await listOpenPhasePRs(REPO, 12)).toEqual([]);
    expect(mockGh.getIssueComments).not.toHaveBeenCalled();
  });
});

describe("peekTotalPhases", () => {
  it("prefers the stored list's length over the plan's headers", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue(entries(null, null, null));
    expect(await peekTotalPhases(REPO, 12, PLAN)).toEqual({ totalPhases: 3, stored: { trackerId: "clw_TRACKED", entries: entries(null, null, null) } });
    mockDb.getIssuePlannedPRs.mockResolvedValue([]);
    expect(await peekTotalPhases(REPO, 12, PLAN)).toEqual({ totalPhases: 2, stored: null });
    expect(await peekTotalPhases(REPO, 12, null)).toEqual({ totalPhases: 1, stored: null });
  });
});

describe("loadIssuePhaseState dependencies", () => {
  const PARALLEL = "*— Automated by Claws —*\n\n## Implementation Plan\n\n### PR 1: Schema\nAdd it.\n\n### PR 2: Readers (parallel)\nUse it.";

  it("uses the header suffix when the stored entry has none", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue(entries(40, null));
    mockGh.getPRState.mockResolvedValue("OPEN");

    const { coverage } = await loadIssuePhaseState(REPO, 12, [], { planText: PARALLEL });

    expect(coverage.dependencies.get(2)).toEqual([]);
    expect(coverage.openPhases).toEqual([1]);
    expect(coverage.readyPhases).toEqual([2]);
  });

  it("lets the stored depends_on win over the header", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue([...entries(40), { position: 2, repo: REPO, title: "Step 2", prNumber: null, dependsOn: [1] }]);
    mockGh.getPRState.mockResolvedValue("OPEN");

    const { coverage } = await loadIssuePhaseState(REPO, 12, [], { planText: PARALLEL });

    expect(coverage.dependencies.get(2)).toEqual([1]);
    expect(coverage.readyPhases).toEqual([]);
    expect(coverage.blockedPhases).toEqual([2]);
  });

  it("ignores the headers when they do not line up with the stored list", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue(entries(40, null, null));
    mockGh.getPRState.mockResolvedValue("OPEN");

    const { coverage } = await loadIssuePhaseState(REPO, 12, [], { planText: PARALLEL });

    expect(coverage.dependencies.get(2)).toEqual([1]);
    expect(coverage.readyPhases).toEqual([]);
  });

  it("reads the header suffix on the legacy path", async () => {
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([{ number: 40, title: "fix(#12): Schema (1/2)", body: "Part of #12", state: "open" }]);

    const { coverage, entries: stored } = await loadIssuePhaseState(REPO, 12, [], { planText: PARALLEL });

    expect(stored).toBeNull();
    expect(coverage.openPhases).toEqual([1]);
    expect(coverage.readyPhases).toEqual([2]);
  });
});

describe("alignPlanWithEntries", () => {
  it("carries the stored dependencies onto the aligned phases, the header's otherwise", () => {
    const plan = parsePlan("### PR 1: A\na\n\n### PR 2: B (parallel)\nb\n\n### PR 3: C\nc");
    const list = [...entries(null, null), { position: 3, repo: REPO, title: "Step 3", prNumber: null, dependsOn: [1] }];
    expect(alignPlanWithEntries(plan, list)!.phases.map((p) => p.dependsOn)).toEqual([null, [], [1]]);
  });

  it("keeps the plan's sections and takes the list's titles when they line up", () => {
    const aligned = alignPlanWithEntries(parsePlan(PLAN), entries(null, null));
    expect(aligned!.phases.map((p) => [p.title, p.description])).toEqual([["Step 1", "Add it."], ["Step 2", "Use it."]]);
  });

  it("describes each PR against the whole plan when the headers do not line up", () => {
    const aligned = alignPlanWithEntries(parsePlan(PLAN), entries(null, null, null));
    expect(aligned!.totalPhases).toBe(3);
    expect(aligned!.preamble).toContain("### PR 2: Readers");
    expect(aligned!.phases[2]).toEqual({ phaseNumber: 3, title: "Step 3", description: "You are implementing PR 3 of 3: Step 3", dependsOn: null });
  });

  it("returns the plan unchanged with no list", () => {
    const plan = parsePlan(PLAN);
    expect(alignPlanWithEntries(plan, null)).toBe(plan);
  });
});
