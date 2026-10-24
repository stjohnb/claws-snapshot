import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./log.js", () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));

const db = vi.hoisted(() => ({
  getIssueIdsAwaitingOperator: vi.fn(async (_ids: readonly string[]) => new Map<string, { position: number; title: string }>()),
  listPendingReapprovalIssueIds: vi.fn(async (_ids?: readonly string[]) => new Set<string>()),
  listOpenClawsPrs: vi.fn(async () => [] as any[]),
}));
vi.mock("./db.js", () => db);

const github = vi.hoisted(() => ({
  listRepos: vi.fn(async () => [{ owner: "org", name: "repo", fullName: "org/repo" }]),
  listOpenIssues: vi.fn(async (_repo: string) => [] as any[]),
  isNativeIssue: (ref: unknown) => typeof ref === "string",
  awaitingImportReason: vi.fn((_repo: string, _item: { number: unknown }) => null as string | null),
  ciFixerGaveUpOnHead: vi.fn((_repo: string, _n: number, _head: string | null | undefined) => false),
  getMergeBlockCode: vi.fn((_repo: string, _n: number) => undefined as string | undefined),
}));
vi.mock("./github.js", () => github);

const clawsIssues = vi.hoisted(() => ({
  getOpenShadowStages: vi.fn(async () => new Map<string, { id: string; lifecycle: string; hasPlannedPrs: boolean }>()),
  getLatestRequirementsForOpenIssues: vi.fn(async () => new Map<string, any>()),
  getRequirementsFeedbackPending: vi.fn(async (_latest: Map<string, any>) => new Set<string>()),
  listUnassignedOpenIssues: vi.fn(async () => [] as any[]),
}));
vi.mock("./claws-issues.js", () => clawsIssues);

const flight = vi.hoisted(() => ({
  flightKey: (repo: string, ref: unknown) => `${repo}\u0000${ref}`,
  loadBoardFlights: vi.fn(async (_cards: unknown[]) => new Map<string, { implementing: boolean; openPrs: any[] }>()),
}));
vi.mock("./issue-flight.js", () => flight);

const planned = vi.hoisted(() => ({
  manualWarningRow: (row: any) => row,
  loadManualActionWarnings: vi.fn(async (rows: readonly any[]) => new Map(rows.filter((r) => r.manualActionReason || r.issueId === "clw_OPSTEP").map((r) => [`${r.repo}#${r.prNumber}`, "Manual action before merge"]))),
}));
vi.mock("./planned-prs.js", () => planned);
// The claims filter is covered in awaiting-operator.test.ts; here it passes the SQL candidates through.
const sessionBackend = vi.hoisted(() => ({ listLive: vi.fn(async () => [] as Array<{ alive: boolean }>) }));
vi.mock("./session-backend.js", () => ({ getSessionBackend: () => sessionBackend }));
vi.mock("./awaiting-operator.js", () => ({ issuesAwaitingOperator: (ids: readonly string[]) => db.getIssueIdsAwaitingOperator(ids) }));

import { clearNavCountsCache, loadOperatorAttentionCounts, NAV_COUNTS_TTL_MS } from "./operator-attention.js";
import * as log from "./log.js";
import { getSessionBackend } from "./session-backend.js";

const issue = (number: number, labels: string[] = []) => ({ number, title: `#${number}`, labels: labels.map((name) => ({ name })) });
const pr = (prNumber: number, fields: Record<string, unknown> = {}) => ({
  repo: "org/repo", prNumber, issueId: null, stage: "awaiting-review", needsHumanReview: false,
  manualActionReason: null, ciBlockedReason: null, mergeApprovedAt: null, mergeApprovedBy: null, ...fields,
});

beforeEach(() => {
  vi.clearAllMocks();
  github.listRepos.mockResolvedValue([{ owner: "org", name: "repo", fullName: "org/repo" }]);
  github.listOpenIssues.mockResolvedValue([]);
  clawsIssues.getOpenShadowStages.mockResolvedValue(new Map());
  clawsIssues.getLatestRequirementsForOpenIssues.mockResolvedValue(new Map());
  clawsIssues.getRequirementsFeedbackPending.mockResolvedValue(new Set());
  clawsIssues.listUnassignedOpenIssues.mockResolvedValue([]);
  flight.loadBoardFlights.mockResolvedValue(new Map());
  db.getIssueIdsAwaitingOperator.mockResolvedValue(new Map());
  db.listPendingReapprovalIssueIds.mockResolvedValue(new Set());
  github.ciFixerGaveUpOnHead.mockReturnValue(false);
  github.getMergeBlockCode.mockReturnValue(undefined);
  db.listOpenClawsPrs.mockResolvedValue([]);
  sessionBackend.listLive.mockResolvedValue([]);
  github.awaitingImportReason.mockReturnValue(null);
  clearNavCountsCache();
});

describe("loadOperatorAttentionCounts", () => {
  // #clw_01M52GPG0E9DP8RQKW6ABH0X7R: the nav agrees with the board, which
  // keeps an un-imported forge card out of every gate column.
  it("does not count a forge issue awaiting import in a gate column", async () => {
    github.listOpenIssues.mockResolvedValue([issue(4, ["Ready"]), issue(5, ["Refined"])]);
    github.awaitingImportReason.mockReturnValue("awaiting import into the native tracker");

    const counts = await loadOperatorAttentionCounts();

    expect(counts?.issues).toEqual({ attention: 0, total: 2 });
  });

  it("counts the issues in the board's operator-waiting columns only", async () => {
    github.listOpenIssues.mockResolvedValue([
      issue(1), // Requirements review: a requirements version with no feedback since
      issue(2), // Drafting: no requirements yet
      issue(3), // Planning
      issue(4, ["Ready"]), // Awaiting plan review
      issue(5, ["Refined"]), // Approved
      issue(6), // In progress
      issue(7), // In progress
      issue(8, ["Blocked"]), // Blocked: parked for its problematic PR
      issue(9, ["Blocked"]), // Blocked
      issue(10), // Awaiting merge
      issue(11), // Awaiting merge: the plan's operator step is open
      issue(12), // Awaiting plan review: a design change waits for re-approval
      issue(13, ["Backlog", "Ready"]), // Backlog: off the board
      issue(14), // Drafting: feedback left on the requirements
      issue(15), // In progress: its PR only carries a hold
    ]);
    clawsIssues.getOpenShadowStages.mockResolvedValue(new Map([
      ["org/repo\u00001", { id: "clw_R1", lifecycle: "ideas", hasPlannedPrs: false }],
      ["org/repo\u00002", { id: "clw_D2", lifecycle: "ideas", hasPlannedPrs: false }],
      ["org/repo\u00003", { id: "clw_P3", lifecycle: "planning", hasPlannedPrs: false }],
      ["org/repo\u000011", { id: "clw_OP", lifecycle: "planning", hasPlannedPrs: true }],
      ["org/repo\u000012", { id: "clw_RE", lifecycle: "planning", hasPlannedPrs: true }],
      ["org/repo\u000014", { id: "clw_FB", lifecycle: "ideas", hasPlannedPrs: false }],
    ]));
    clawsIssues.getLatestRequirementsForOpenIssues.mockResolvedValue(new Map([["clw_R1", { version: 1 }], ["clw_FB", { version: 2 }]]));
    clawsIssues.getRequirementsFeedbackPending.mockResolvedValue(new Set(["clw_FB"]));
    clawsIssues.listUnassignedOpenIssues.mockResolvedValue([{ id: "clw_UNASSIGNED", labels: ["Ready"], lifecycle: "ideas" }]);
    flight.loadBoardFlights.mockResolvedValue(new Map([
      ["org/repo\u00006", { implementing: true, openPrs: [] }],
      ["org/repo\u00007", { implementing: false, openPrs: [pr(70)] }],
      ["org/repo\u00008", { implementing: false, openPrs: [pr(80, { stage: "problematic" })] }],
      // A hold alone is not stalled (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK).
      ["org/repo\u000015", { implementing: false, openPrs: [pr(150, { manualActionReason: "rotate the secret" })] }],
      ["org/repo\u000010", { implementing: false, openPrs: [pr(100, { stage: "awaiting-merge" })] }],
      ["org/repo\u000012", { implementing: false, openPrs: [pr(120)] }],
    ]));
    db.getIssueIdsAwaitingOperator.mockResolvedValue(new Map([["clw_OP", { position: 3, title: "Deploy" }]]));
    db.listPendingReapprovalIssueIds.mockResolvedValue(new Set(["clw_RE"]));

    const counts = await loadOperatorAttentionCounts();

    // 1 (Requirements review), 4 and 12 (Awaiting plan review), 8 and 9
    // (Blocked), 10 and 11 (Awaiting merge).
    expect(counts?.issues).toEqual({ attention: 7, total: 15 }); // the Backlog card is not on the board
    // The Backlog card is dropped before the flight read, as on the board.
    const flightCards = flight.loadBoardFlights.mock.calls[0][0] as Array<{ ref: unknown }>;
    expect(flightCards.map((c) => c.ref)).not.toContain(13);
  });

  it("reads a repository whose issue list fails as empty", async () => {
    github.listRepos.mockResolvedValue([
      { owner: "org", name: "down", fullName: "org/down" },
      { owner: "org", name: "repo", fullName: "org/repo" },
    ]);
    github.listOpenIssues.mockImplementation(async (repo: string) => {
      if (repo === "org/down") throw new Error("502");
      return [issue(9, ["Blocked"])];
    });

    expect(await loadOperatorAttentionCounts()).toEqual({ issues: { attention: 1, total: 1 }, prs: { attention: 0, total: 0 }, sessions: 0 });
  });

  // A problematic PR parks its issue in Blocked: the issue counts once in
  // issues, through Blocked, and the PR once in PRs (#clw_01M4TJEHAP19S2N3SE6EHE6VNA).
  it("counts a Blocked issue parked for its problematic PR once in each count", async () => {
    const stalled = pr(80, { issueId: "clw_S8", stage: "problematic" });
    github.listOpenIssues.mockResolvedValue([issue(8, ["Blocked"])]);
    flight.loadBoardFlights.mockResolvedValue(new Map([["org/repo\u00008", { implementing: false, openPrs: [stalled] }]]));
    db.listOpenClawsPrs.mockResolvedValue([stalled]);

    expect(await loadOperatorAttentionCounts()).toEqual({ issues: { attention: 1, total: 1 }, prs: { attention: 1, total: 1 }, sessions: 0 });
  });

  it("counts open PRs the PR list flags as needing the operator", async () => {
    github.ciFixerGaveUpOnHead.mockImplementation((_r, n, head) => n === 58 && head === "h58" || n === 3 && head === "h3");
    github.getMergeBlockCode.mockImplementation((_r, n) => (n === 13 ? "stacked" : n === 20 ? "checks-failed" : undefined));
    const approved = { mergeApprovedAt: "2026-10-13T00:00:00Z", mergeApprovedBy: "dashboard" };
    db.listOpenClawsPrs.mockResolvedValue([
      pr(58, { stage: "ci-failing", headSha: "h58", ...approved }), // CI fixer gave up, Automerge applied
      pr(3, { stage: "ci-failing", headSha: "h3", manualActionReason: "run the script", ...approved }),
      pr(143, { stage: "awaiting-merge", issueId: "clw_OPSTEP", ...approved }), // operator step pending
      pr(13, { stage: "awaiting-merge", headSha: "h13", ...approved }), // human-authored, stacked block
      pr(17, { stage: "awaiting-merge", headSha: "h17", ...approved }), // queued, green
      pr(20, { stage: "awaiting-merge", ...approved }), // blocked on checks: Claws resolves it
      pr(2, { stage: "problematic" }),
      pr(4, { ciBlockedReason: "runner offline" }),
      pr(5, { stage: "awaiting-merge" }), // awaiting approval alone no longer counts
      pr(9, { stage: "merged" }),
    ]);

    expect((await loadOperatorAttentionCounts())?.prs).toEqual({ attention: 6, total: 10 });
  });

  it("counts only the alive sessions", async () => {
    sessionBackend.listLive.mockResolvedValue([{ alive: true }, { alive: false }, { alive: true }]);

    expect((await loadOperatorAttentionCounts())?.sessions).toBe(2);
    expect(getSessionBackend()).toBe(sessionBackend);
  });

  it("omits the sessions count, keeping the others, when the session read fails", async () => {
    sessionBackend.listLive.mockRejectedValue(new Error("pod list failed"));

    expect(await loadOperatorAttentionCounts()).toEqual({ issues: { attention: 0, total: 0 }, prs: { attention: 0, total: 0 } });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("[nav-counts]"));
  });

  it("keeps the sessions count when the issues and PRs read fails", async () => {
    db.listOpenClawsPrs.mockRejectedValue(new Error("db down"));
    sessionBackend.listLive.mockResolvedValue([{ alive: true }]);

    expect(await loadOperatorAttentionCounts()).toEqual({ sessions: 1 });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("[nav-counts]"));
  });

  it("yields no counts when every read fails, rather than a wrong number", async () => {
    db.listOpenClawsPrs.mockRejectedValue(new Error("db down"));
    sessionBackend.listLive.mockRejectedValue(new Error("pod list failed"));

    expect(await loadOperatorAttentionCounts()).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("[nav-counts]"));
  });
});

describe("loadOperatorAttentionCounts caching", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the forge issue lists stale-ok", async () => {
    await loadOperatorAttentionCounts();
    expect(github.listOpenIssues).toHaveBeenCalledWith("org/repo", { staleOk: true });
  });

  it("does not re-list repositories for a second call within the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await loadOperatorAttentionCounts();
    vi.advanceTimersByTime(NAV_COUNTS_TTL_MS - 1000);
    await loadOperatorAttentionCounts();
    expect(github.listRepos).toHaveBeenCalledTimes(1);
  });

  it("reads the sessions count live while serving issues and PRs from the cache after expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    sessionBackend.listLive.mockResolvedValue([{ alive: true }]);
    expect((await loadOperatorAttentionCounts())?.sessions).toBe(1);

    vi.advanceTimersByTime(NAV_COUNTS_TTL_MS + 1000);
    sessionBackend.listLive.mockResolvedValue([{ alive: true }, { alive: true }]);
    expect((await loadOperatorAttentionCounts())?.sessions).toBe(2);
    expect(github.listRepos).toHaveBeenCalledTimes(2);

    await vi.waitFor(() => expect(github.listRepos).toHaveBeenCalledTimes(2));
  });

  it("reflects a changed sessions list within the TTL without re-reading the issues", async () => {
    sessionBackend.listLive.mockResolvedValue([{ alive: true }, { alive: true }, { alive: true }]);
    expect((await loadOperatorAttentionCounts())?.sessions).toBe(3);
    sessionBackend.listLive.mockResolvedValue([{ alive: true }, { alive: true }, { alive: false }]);
    expect((await loadOperatorAttentionCounts())?.sessions).toBe(2);
    expect(github.listRepos).toHaveBeenCalledTimes(1);
  });
});
