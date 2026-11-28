import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IssuePlannedPR, OverlapPrRow, OverlapUnstartedStep } from "./db.js";

const mockDb = vi.hoisted(() => ({
  listOverlapPrRows: vi.fn(), listOverlapUnstartedSteps: vi.fn(), getClawsIssue: vi.fn(), getIssuePlannedPRs: vi.fn(), getClawsPr: vi.fn(), getClawsPrFiles: vi.fn(),
  listClawsPrsForIssue: vi.fn(), listClawsIssueComments: vi.fn(), setClawsIssueOverlapHoldLifted: vi.fn(),
  listActiveImplementerRefs: vi.fn(), getLinkedNativeId: vi.fn(),
}));
vi.mock("./db.js", () => mockDb);
const mockGetRepoConfig = vi.hoisted(() => vi.fn());
vi.mock("./repo-config.js", () => ({ getRepoConfig: mockGetRepoConfig }));
vi.mock("./github.js", () => ({
  hasPriorityLabel: (labels: { name: string }[]) => labels.some((l) => l.name === "Priority"),
  isClawsComment: (body: string) => body.includes("Automated by Claws"),
  isAllowedActor: async (login: string) => login === "stjohnb",
}));

const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./log.js", () => mockLog);

import { IN_FLIGHT_MEMO_MS, clearInFlightMemo, conflictDeferral, heldSteps, liftOverlapHold, loadInFlight, overlapHoldForIssue, overlapHoldNote, overlapsForIssue, planStepFootprints, storedIssueHolds, storedOverlapHolds } from "./overlap-gate.js";
import type { ClawsIssueRecord } from "./db.js";
import { OVERLAP_GIVE_WAY_MS } from "./overlap.js";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const REPO = "org/a";

function row(overrides: Partial<OverlapPrRow> = {}): OverlapPrRow {
  return {
    prNumber: 1, issueId: "clw_A", phase: 1, stage: "awaiting-review", ciBlockedReason: null, headSha: "h",
    createdAt: new Date(NOW - 1000).toISOString(), files: ["src/a.ts"], lifecycle: "awaiting-plan-review",
    planApprovedAt: "2026-11-19T00:00:00Z", issueLabels: [], declaredPaths: null, ...overrides,
  };
}

function unstarted(overrides: Partial<OverlapUnstartedStep> = {}): OverlapUnstartedStep {
  return {
    issueId: "clw_U", position: 1, paths: ["src/a.ts"], lifecycle: "approved", planApprovedAt: "2026-11-20T00:00:00Z",
    issueLabels: [], totalSteps: 2, claimComments: [], holdLifted: false, ...overrides,
  };
}

function planned(overrides: Partial<IssuePlannedPR> = {}): IssuePlannedPR {
  return { position: 1, repo: REPO, title: "Step", prNumber: null, dependsOn: null, kind: "pr", manualAction: null, ...overrides };
}

/** Issue records and stored plans by id; an unknown issue reads as open and approved, with six independent steps, all ready. */
const issueRecords = new Map<string, ClawsIssueRecord>();
const plans = new Map<string, IssuePlannedPR[]>();

beforeEach(() => {
  vi.resetAllMocks();
  clearInFlightMemo();
  mockGetRepoConfig.mockReturnValue(null);
  mockDb.listOverlapUnstartedSteps.mockResolvedValue([]);
  issueRecords.clear();
  plans.clear();
  mockDb.getClawsIssue.mockImplementation(async (id: string) => issueRecords.get(id) ?? issue(id));
  mockDb.getIssuePlannedPRs.mockImplementation(async (id: string) => plans.get(id) ?? Array.from({ length: 6 }, (_, i) => planned({ position: i + 1, dependsOn: [] })));
  mockDb.listClawsPrsForIssue.mockResolvedValue([]);
  mockDb.listClawsIssueComments.mockResolvedValue([]);
  mockDb.listActiveImplementerRefs.mockResolvedValue([]);
});

describe("loadInFlight", () => {
  it("builds steps with the ignore list applied and Priority from the issue's labels", async () => {
    mockGetRepoConfig.mockReturnValue({ overlap: { enabled: true, ignorePaths: ["package-lock.json"] } });
    mockDb.listOverlapPrRows.mockResolvedValue([row({ files: ["package-lock.json", "src/a.ts"], issueLabels: ["Priority"] })]);
    const [step] = await loadInFlight(REPO, NOW);
    expect(step).toMatchObject({ issueId: "clw_A", position: 1, prNumber: 1, hasOpenPr: true, priority: true, paths: ["src/a.ts"], holds: true });
  });

  it("marks a stalled, Blocked, Backlog or over-48-hour step as giving way", async () => {
    mockDb.listOverlapPrRows.mockResolvedValue([
      row({ prNumber: 1, stage: "problematic" }),
      row({ prNumber: 2, ciBlockedReason: "billing" }),
      row({ prNumber: 3, lifecycle: "blocked" }),
      row({ prNumber: 4, lifecycle: "backlog" }),
      row({ prNumber: 5, createdAt: new Date(NOW - OVERLAP_GIVE_WAY_MS - 1).toISOString() }),
      row({ prNumber: 6 }),
    ]);
    expect((await loadInFlight(REPO, NOW)).map((s) => [s.prNumber, s.holds])).toEqual([[1, false], [2, false], [3, false], [4, false], [5, false], [6, true]]);
  });

  it("is empty when the repo's switch is off, without reading the database", async () => {
    mockGetRepoConfig.mockReturnValue({ overlap: { enabled: false, ignorePaths: [] } });
    expect(await loadInFlight(REPO, NOW)).toEqual([]);
    expect(mockDb.listOverlapPrRows).not.toHaveBeenCalled();
  });

  it("reuses a repo's steps for the memo window", async () => {
    mockDb.listOverlapPrRows.mockResolvedValue([row()]);
    await loadInFlight(REPO, NOW);
    await loadInFlight(REPO, NOW + IN_FLIGHT_MEMO_MS - 1);
    expect(mockDb.listOverlapPrRows).toHaveBeenCalledTimes(1);
    await loadInFlight(REPO, NOW + IN_FLIGHT_MEMO_MS);
    expect(mockDb.listOverlapPrRows).toHaveBeenCalledTimes(2);
  });
});

describe("conflictDeferral", () => {
  it("names the earliest overlapping PR ahead, and nothing for the front PR or an unknown PR", async () => {
    mockDb.listOverlapPrRows.mockResolvedValue([
      row({ prNumber: 9, issueId: "clw_C", planApprovedAt: "2026-11-19T03:00:00Z", files: ["src/a.ts", "src/b.ts"] }),
      row({ prNumber: 7, issueId: "clw_B", planApprovedAt: "2026-11-19T02:00:00Z", files: ["src/b.ts"] }),
      row({ prNumber: 3, issueId: "clw_A", planApprovedAt: "2026-11-19T01:00:00Z", files: ["src"] }),
    ]);
    expect(await conflictDeferral(REPO, 9, NOW)).toEqual({ waitsOn: 3, issueId: "clw_A", files: ["src/a.ts", "src/b.ts"] });
    expect(await conflictDeferral(REPO, 7, NOW)).toEqual({ waitsOn: 3, issueId: "clw_A", files: ["src/b.ts"] });
    expect(await conflictDeferral(REPO, 3, NOW)).toBeNull();
    expect(await conflictDeferral(REPO, 42, NOW)).toBeNull();
  });

  it("does not wait on a PR ahead that gives way", async () => {
    mockDb.listOverlapPrRows.mockResolvedValue([
      row({ prNumber: 3, issueId: "clw_A", planApprovedAt: "2026-11-19T01:00:00Z", stage: "problematic" }),
      row({ prNumber: 9, issueId: "clw_C", planApprovedAt: "2026-11-19T03:00:00Z" }),
    ]);
    expect(await conflictDeferral(REPO, 9, NOW)).toBeNull();
  });

  it("defers a PR with no cached file list by its step's declared paths", async () => {
    mockDb.listOverlapPrRows.mockResolvedValue([
      row({ prNumber: 3, issueId: "clw_A", planApprovedAt: "2026-11-19T01:00:00Z", files: ["src/a.ts"] }),
      row({ prNumber: 9, issueId: "clw_C", planApprovedAt: "2026-11-19T03:00:00Z", files: null, declaredPaths: ["src"] }),
      row({ prNumber: 10, issueId: "clw_D", planApprovedAt: "2026-11-19T04:00:00Z", files: null, declaredPaths: null }),
    ]);
    expect(await conflictDeferral(REPO, 9, NOW)).toEqual({ waitsOn: 3, issueId: "clw_A", files: ["src/a.ts"] });
    expect(await conflictDeferral(REPO, 10, NOW)).toBeNull();
  });
});

describe("loadInFlight with declared paths", () => {
  it("falls back to an open PR's declared paths when no file list is cached for its head", async () => {
    mockDb.listOverlapPrRows.mockResolvedValue([
      row({ prNumber: 1, files: null, declaredPaths: ["src/b"] }),
      row({ prNumber: 2, files: null, declaredPaths: null }),
    ]);
    expect((await loadInFlight(REPO, NOW)).map((st) => [st.prNumber, st.paths])).toEqual([[1, ["src/b"]], [2, []]]);
  });

  it("adds unstarted steps after the open PRs, without the ones a trusted claim covers", async () => {
    mockGetRepoConfig.mockReturnValue({ overlap: { enabled: true, ignorePaths: ["package-lock.json"] } });
    mockDb.listOverlapPrRows.mockResolvedValue([]);
    mockDb.listOverlapUnstartedSteps.mockResolvedValue([
      unstarted({ issueId: "clw_U", position: 1, paths: ["package-lock.json", "src/a.ts"], issueLabels: ["Priority"] }),
      unstarted({ issueId: "clw_V", position: 2, claimComments: [{ body: "claws-phase-done: 2", login: "stjohnb" }] }),
      unstarted({ issueId: "clw_X", position: 2, paths: ["src/x.ts"], claimComments: [{ body: "claws-phase-done: 1-", login: "drive-by" }] }),
      unstarted({ issueId: "clw_W", position: 1, planApprovedAt: new Date(NOW - OVERLAP_GIVE_WAY_MS - 1).toISOString() }),
    ]);
    const steps = await loadInFlight(REPO, NOW);
    expect(steps.map((st) => [st.issueId, st.position, st.prNumber, st.hasOpenPr, st.priority, st.paths, st.holds])).toEqual([
      ["clw_U", 1, null, false, true, ["src/a.ts"], true],
      ["clw_X", 2, null, false, false, ["src/x.ts"], true],
      ["clw_W", 1, null, false, false, ["src/a.ts"], false],
    ]);
  });
});

describe("overlapsForIssue", () => {
  it("lists the steps that hold an issue's step and those it holds", async () => {
    issueRecords.set("clw_B", issue("clw_B", { plan_approved_at: "2026-11-19 02:00:00" }));
    plans.set("clw_B", [planned({ position: 1, paths: ["src"] })]);
    // clw_B's implementer is active, so its step runs and holds even though clw_A's PR holds it.
    mockDb.listActiveImplementerRefs.mockResolvedValue([{ repo: REPO, itemNumber: "clw_B" }]);
    mockDb.listOverlapPrRows.mockResolvedValue([
      row({ prNumber: 3, issueId: "clw_A", planApprovedAt: "2026-11-19T01:00:00Z", files: ["src/a.ts"] }),
    ]);
    mockDb.listOverlapUnstartedSteps.mockResolvedValue([
      unstarted({ issueId: "clw_B", position: 1, paths: ["src"], planApprovedAt: "2026-11-19T02:00:00Z" }),
      unstarted({ issueId: "clw_C", position: 2, paths: ["src/c.ts", "docs"], planApprovedAt: "2026-11-19T03:00:00Z" }),
    ]);
    expect(await overlapsForIssue("clw_B", NOW)).toEqual([{
      repo: REPO,
      position: 1,
      heldBy: [{ issueId: "clw_A", position: 1, prNumber: 3, running: true, shared: ["src/a.ts"] }],
      holds: [{ issueId: "clw_C", position: 2, prNumber: null, running: false, shared: ["src/c.ts"] }],
    }]);
  });

  it("lets a held step that cannot start hold nothing", async () => {
    issueRecords.set("clw_B", issue("clw_B", { plan_approved_at: "2026-11-19 02:00:00" }));
    plans.set("clw_B", [planned({ position: 1, paths: ["src"] })]);
    mockDb.listOverlapPrRows.mockResolvedValue([
      row({ prNumber: 3, issueId: "clw_A", planApprovedAt: "2026-11-19T01:00:00Z", files: ["src/a.ts"] }),
    ]);
    mockDb.listOverlapUnstartedSteps.mockResolvedValue([
      unstarted({ issueId: "clw_B", position: 1, paths: ["src"], planApprovedAt: "2026-11-19T02:00:00Z" }),
      unstarted({ issueId: "clw_C", position: 2, paths: ["src/c.ts"], planApprovedAt: "2026-11-19T03:00:00Z" }),
    ]);
    expect(await overlapsForIssue("clw_B", NOW)).toEqual([{
      repo: REPO,
      position: 1,
      heldBy: [{ issueId: "clw_A", position: 1, prNumber: 3, running: true, shared: ["src/a.ts"] }],
      holds: [],
    }]);
  });

  it("leaves out the issue's own other steps that share its paths", async () => {
    issueRecords.set("clw_B", issue("clw_B", { plan_approved_at: "2026-11-19 02:00:00" }));
    plans.set("clw_B", [
      planned({ position: 1, paths: ["src/modules.ts"], prNumber: 5 }),
      planned({ position: 2, paths: ["src/modules.ts", "src/b.ts"] }),
    ]);
    mockDb.listOverlapPrRows.mockResolvedValue([
      row({ prNumber: 5, issueId: "clw_B", phase: 1, planApprovedAt: "2026-11-19T02:00:00Z", files: ["src/modules.ts"] }),
    ]);
    mockDb.listOverlapUnstartedSteps.mockResolvedValue([
      unstarted({ issueId: "clw_B", position: 2, paths: ["src/modules.ts", "src/b.ts"], planApprovedAt: "2026-11-19T02:00:00Z" }),
    ]);
    expect(await overlapsForIssue("clw_B", NOW)).toEqual([]);
  });

  it("places a step of an unapproved issue as if it started now, so overlaps show at plan time", async () => {
    mockDb.getClawsIssue.mockResolvedValue({ id: "clw_Z", state: "open", labels: [], plan_approved_at: null });
    mockDb.getIssuePlannedPRs.mockResolvedValue([planned({ position: 1, paths: ["src/a.ts"] }), planned({ position: 2, kind: "manual" })]);
    mockDb.listOverlapPrRows.mockResolvedValue([row({ prNumber: 3, issueId: "clw_A", files: ["src/a.ts"] })]);
    expect(await overlapsForIssue("clw_Z", NOW)).toEqual([
      { repo: REPO, position: 1, heldBy: [{ issueId: "clw_A", position: 1, prNumber: 3, running: true, shared: ["src/a.ts"] }], holds: [] },
    ]);
  });

  it("is empty for a closed issue, a repo with the switch off, and a step whose PR is no longer open", async () => {
    mockDb.listOverlapPrRows.mockResolvedValue([row({ prNumber: 3, issueId: "clw_A", files: ["src/a.ts"] })]);
    mockDb.getClawsIssue.mockResolvedValue({ id: "clw_Z", state: "closed", labels: [], plan_approved_at: null });
    mockDb.getIssuePlannedPRs.mockResolvedValue([planned({ paths: ["src/a.ts"] })]);
    expect(await overlapsForIssue("clw_Z", NOW)).toEqual([]);

    mockDb.getClawsIssue.mockResolvedValue({ id: "clw_Z", state: "open", labels: [], plan_approved_at: null });
    mockDb.getIssuePlannedPRs.mockResolvedValue([planned({ paths: ["src/a.ts"], prNumber: 8 })]);
    expect(await overlapsForIssue("clw_Z", NOW)).toEqual([]);

    mockDb.getIssuePlannedPRs.mockResolvedValue([planned({ paths: ["src/a.ts"] })]);
    mockGetRepoConfig.mockReturnValue({ overlap: { enabled: false, ignorePaths: [] } });
    expect(await overlapsForIssue("clw_Z", NOW)).toEqual([]);
  });
});

describe("planStepFootprints", () => {
  it("gives each PR step its declared paths, its PR's cached file count and its overlaps", async () => {
    mockDb.getClawsIssue.mockResolvedValue({ id: "clw_Z", state: "open", labels: [], plan_approved_at: null });
    mockDb.getIssuePlannedPRs.mockResolvedValue([
      planned({ position: 1, title: "One", paths: ["src/a.ts"] }),
      planned({ position: 2, title: "Two", prNumber: 12 }),
      planned({ position: 3, kind: "manual", title: "Manual" }),
    ]);
    mockDb.listOverlapPrRows.mockResolvedValue([row({ prNumber: 3, issueId: "clw_A", files: ["src/a.ts"] })]);
    mockDb.getClawsPr.mockResolvedValue({ headSha: "abc" });
    mockDb.getClawsPrFiles.mockResolvedValue(["x", "y"]);
    expect(await planStepFootprints("clw_Z", NOW)).toEqual([
      { position: 1, repo: REPO, title: "One", paths: ["src/a.ts"], prNumber: null, changedFiles: null,
        heldBy: [{ issueId: "clw_A", position: 1, prNumber: 3, running: true, shared: ["src/a.ts"] }], holds: [], expectedRebase: [] },
      { position: 2, repo: REPO, title: "Two", paths: [], prNumber: 12, changedFiles: 2, heldBy: [], holds: [], expectedRebase: [] },
    ]);
    expect(mockDb.getClawsPrFiles).toHaveBeenCalledWith(REPO, 12, "abc");
  });

  it("lists the shared docs a step shares with other running or ready work as an expected rebase, not a hold", async () => {
    issueRecords.set("clw_Z", issue("clw_Z", { plan_approved_at: "2026-11-20 06:00:00" }));
    plans.set("clw_Z", [planned({ position: 1, title: "One", paths: ["docs/DESIGN.md", "AGENTS.md", "docs/ci-cd.md", "src/z.ts"] })]);
    plans.set("clw_FAR", [planned({ position: 1 }), planned({ position: 2, dependsOn: [1] })]);
    mockDb.listOverlapPrRows.mockResolvedValue([row({ prNumber: 3, issueId: "clw_A", files: ["docs/DESIGN.md", "src/a.ts"] })]);
    mockDb.listOverlapUnstartedSteps.mockResolvedValue([
      unstarted({ issueId: "clw_R", position: 1, paths: ["AGENTS.md"], planApprovedAt: "2026-11-20T01:00:00Z" }),
      // Not ready: its first step has not landed, so its docs are no rebase yet.
      unstarted({ issueId: "clw_FAR", position: 2, paths: ["docs/ci-cd.md"], planApprovedAt: "2026-11-20T00:00:00Z" }),
    ]);
    const [step] = await planStepFootprints("clw_Z", NOW);
    expect(step).toMatchObject({ heldBy: [], holds: [], expectedRebase: ["AGENTS.md", "docs/DESIGN.md"] });
  });
});

/** An open native issue approved through Plan, as `getClawsIssue` returns it. */
function issue(id: string, overrides: Partial<ClawsIssueRecord> = {}): ClawsIssueRecord {
  return {
    id, kind: "issue", state: "open", labels: [], repos: [REPO], lifecycle: "awaiting-plan-review", approved_through: "plan",
    plan_approved_at: "2026-11-19 00:00:00", overlap_hold_lifted_at: null, ...overrides,
  } as ClawsIssueRecord;
}

describe("heldSteps", () => {
  const records = new Map<string, ClawsIssueRecord>();
  beforeEach(() => {
    records.clear();
    mockDb.getClawsIssue.mockImplementation(async (id: string) => records.get(id));
    mockDb.listOverlapPrRows.mockResolvedValue([]);
  });

  it("holds the later of two approved issues that share a file, and never the earlier", async () => {
    records.set("clw_OLD", issue("clw_OLD", { plan_approved_at: "2026-11-19 00:00:00" }));
    records.set("clw_NEW", issue("clw_NEW", { plan_approved_at: "2026-11-20 00:00:00" }));
    mockDb.listOverlapUnstartedSteps.mockResolvedValue([
      unstarted({ issueId: "clw_OLD", position: 1, paths: ["src/a.ts"], planApprovedAt: "2026-11-19T00:00:00Z" }),
      unstarted({ issueId: "clw_NEW", position: 1, paths: ["src/a.ts", "src/b.ts"], planApprovedAt: "2026-11-20T00:00:00Z" }),
    ]);
    const older = await heldSteps({ id: "clw_OLD", priority: false }, [planned({ paths: ["src/a.ts"] })], NOW);
    const newer = await heldSteps({ id: "clw_NEW", priority: false }, [planned({ paths: ["src/a.ts", "src/b.ts"] })], NOW);
    expect(older.get(1)).toBeNull();
    expect(newer.get(1)).toEqual({ repo: REPO, position: 1, holders: [{ issueId: "clw_OLD", position: 1, prNumber: null, running: false, shared: ["src/a.ts"] }] });
  });

  it("keeps holding while the holder's PR is open, and releases once it merges or closes", async () => {
    records.set("clw_NEW", issue("clw_NEW", { plan_approved_at: "2026-11-20 00:00:00" }));
    mockDb.listOverlapPrRows.mockResolvedValue([row({ prNumber: 4, issueId: "clw_OLD", files: ["src/a.ts"] })]);
    mockDb.listOverlapUnstartedSteps.mockResolvedValue([unstarted({ issueId: "clw_NEW", planApprovedAt: "2026-11-20T00:00:00Z" })]);
    expect((await heldSteps({ id: "clw_NEW", priority: false }, [planned({ paths: ["src/a.ts"] })], NOW)).get(1)?.holders[0])
      .toEqual({ issueId: "clw_OLD", position: 1, prNumber: 4, running: true, shared: ["src/a.ts"] });

    clearInFlightMemo();
    // Merged or closed: the row is no longer open, so it is not in flight.
    mockDb.listOverlapPrRows.mockResolvedValue([]);
    expect((await heldSteps({ id: "clw_NEW", priority: false }, [planned({ paths: ["src/a.ts"] })], NOW)).get(1)).toBeNull();
  });

  it("never holds a Priority issue, a lifted issue, a step without paths or a repo with the switch off", async () => {
    mockDb.listOverlapPrRows.mockResolvedValue([row({ prNumber: 4, issueId: "clw_OLD", files: ["src"] })]);
    records.set("clw_P", issue("clw_P", { labels: ["Priority"] }));
    records.set("clw_L", issue("clw_L", { overlap_hold_lifted_at: "2026-11-20 10:00:00" }));
    records.set("clw_N", issue("clw_N"));
    const step = [planned({ paths: ["src/a.ts"] })];
    expect((await heldSteps({ id: "clw_N", priority: true }, step, NOW)).get(1)).toBeNull();
    expect((await heldSteps({ id: "clw_P", priority: false }, step, NOW)).get(1)).toBeNull();
    expect((await heldSteps({ id: "clw_L", priority: false }, step, NOW)).get(1)).toBeNull();
    expect((await heldSteps({ id: "clw_N", priority: false }, [planned({ paths: null })], NOW)).get(1)).toBeNull();
    expect((await heldSteps({ id: null, priority: false }, step, NOW)).get(1)).toBeNull();
    expect((await heldSteps({ id: "clw_N", priority: false }, step, NOW)).get(1)).not.toBeNull();
    clearInFlightMemo();
    mockGetRepoConfig.mockReturnValue({ overlap: { enabled: false, ignorePaths: [] } });
    expect((await heldSteps({ id: "clw_N", priority: false }, step, NOW)).get(1)).toBeNull();
  });

  it("never lets two issues wait on each other", async () => {
    records.set("clw_A1", issue("clw_A1", { plan_approved_at: "2026-11-19 00:00:00" }));
    records.set("clw_B1", issue("clw_B1", { plan_approved_at: "2026-11-19 00:00:00" }));
    mockDb.listOverlapUnstartedSteps.mockResolvedValue([
      unstarted({ issueId: "clw_A1", planApprovedAt: "2026-11-19T00:00:00Z" }),
      unstarted({ issueId: "clw_B1", planApprovedAt: "2026-11-19T00:00:00Z" }),
    ]);
    const a = (await heldSteps({ id: "clw_A1", priority: false }, [planned({ paths: ["src/a.ts"] })], NOW)).get(1);
    const b = (await heldSteps({ id: "clw_B1", priority: false }, [planned({ paths: ["src/a.ts"] })], NOW)).get(1);
    expect([a === null, b === null].sort()).toEqual([false, true]);
  });

  it("sequences two steps of the same issue that share a file by position", async () => {
    records.set("clw_S", issue("clw_S"));
    mockDb.listOverlapUnstartedSteps.mockResolvedValue([
      unstarted({ issueId: "clw_S", position: 1, planApprovedAt: "2026-11-19T00:00:00Z" }),
      unstarted({ issueId: "clw_S", position: 2, planApprovedAt: "2026-11-19T00:00:00Z" }),
    ]);
    const held = await heldSteps({ id: "clw_S", priority: false }, [planned({ position: 1, paths: ["src/a.ts"] }), planned({ position: 2, paths: ["src/a.ts"] })], NOW);
    expect(held.get(1)).toBeNull();
    expect(held.get(2)?.holders[0]).toMatchObject({ issueId: "clw_S", position: 1 });
  });

  it("uses the record the caller passes instead of reading it again", async () => {
    mockDb.listOverlapPrRows.mockResolvedValue([row({ prNumber: 4, issueId: "clw_OLD", files: ["src/a.ts"] })]);
    const held = await heldSteps({ id: "clw_N", priority: false, record: issue("clw_N") }, [planned({ paths: ["src/a.ts"] })], NOW);
    expect(held.get(1)).toMatchObject({ position: 1 });
    expect(mockDb.getClawsIssue).not.toHaveBeenCalled();
  });

  it("overlapHoldForIssue answers a hold only when every ready step is held", async () => {
    records.set("clw_N", issue("clw_N"));
    mockDb.listOverlapPrRows.mockResolvedValue([row({ prNumber: 4, issueId: "clw_OLD", files: ["src/a.ts"] })]);
    expect(await overlapHoldForIssue({ id: "clw_N", priority: false }, [planned({ position: 1, paths: ["src/a.ts"] }), planned({ position: 2, paths: ["docs"] })], NOW)).toBeNull();
    expect(await overlapHoldForIssue({ id: "clw_N", priority: false }, [planned({ position: 1, paths: ["src/a.ts"] })], NOW)).toMatchObject({ position: 1 });
    expect(await overlapHoldForIssue({ id: "clw_N", priority: false }, [], NOW)).toBeNull();
  });
});

describe("overlapHoldNote", () => {
  it("names the front holder's step and PR, and up to three shared paths", () => {
    expect(overlapHoldNote({ repo: REPO, position: 2, holders: [{ issueId: "clw_A", position: 1, prNumber: 7, running: true, shared: ["a", "b", "c", "d", "e"] }] }))
      .toBe("Waiting on #clw_A step 1 (org/a#7): shares a, b, c and 2 more");
    expect(overlapHoldNote({ repo: REPO, position: 2, holders: [{ issueId: "clw_A", position: 3, prNumber: null, running: false, shared: ["a"] }] }))
      .toBe("Waiting on #clw_A step 3 (org/a, not started): shares a");
    expect(overlapHoldNote({ repo: REPO, position: 2, holders: [{ issueId: "clw_A", position: 3, prNumber: null, running: true, shared: ["a"] }] }))
      .toBe("Waiting on #clw_A step 3 (org/a, implementing): shares a");
  });
});

describe("storedOverlapHolds and liftOverlapHold", () => {
  beforeEach(() => {
    mockDb.listOverlapPrRows.mockResolvedValue([row({ prNumber: 4, issueId: "clw_OLD", files: ["src/a.ts"] })]);
    mockDb.listClawsPrsForIssue.mockResolvedValue([]);
    mockDb.listClawsIssueComments.mockResolvedValue([]);
  });

  it("reads readiness from stored rows: a step whose dependency merged is ready, a covered one is not", async () => {
    const rec = issue("clw_N");
    mockDb.getClawsIssue.mockResolvedValue(rec);
    mockDb.getIssuePlannedPRs.mockResolvedValue([
      planned({ position: 1, prNumber: 2, paths: ["docs"] }),
      planned({ position: 2, dependsOn: [1], paths: ["src/a.ts"] }),
    ]);
    mockDb.listClawsPrsForIssue.mockResolvedValue([{ repo: REPO, prNumber: 2, phase: 1, stage: "merged" }]);
    const holds = await storedOverlapHolds([rec], NOW);
    expect(holds.get("clw_N")).toMatchObject({ position: 2, holders: [{ issueId: "clw_OLD", prNumber: 4 }] });

    // Step 1's PR still open: step 2 is not ready, so nothing is held.
    mockDb.listClawsPrsForIssue.mockResolvedValue([{ repo: REPO, prNumber: 2, phase: 1, stage: "awaiting-review" }]);
    expect((await storedOverlapHolds([rec], NOW)).size).toBe(0);
  });

  it("counts a trusted claim as done, and skips issues not approved, lifted or Priority", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue([planned({ position: 1, paths: ["docs"] }), planned({ position: 2, paths: ["src/a.ts"] })]);
    mockDb.listClawsIssueComments.mockResolvedValue([{ body: "claws-phase-done: 1", author_login: "stjohnb" }]);
    mockDb.getClawsIssue.mockImplementation(async (id: string) => issue(id));
    expect((await storedOverlapHolds([issue("clw_N")], NOW)).get("clw_N")).toMatchObject({ position: 2 });
    const skipped = [
      issue("clw_R", { approved_through: "requirements" }),
      issue("clw_L", { overlap_hold_lifted_at: "2026-11-20 10:00:00" }),
      issue("clw_P", { labels: ["Priority"] }),
      issue("clw_B", { lifecycle: "blocked" }),
    ];
    expect((await storedOverlapHolds(skipped, NOW)).size).toBe(0);
  });

  it("Start anyway is refused when the issue is not held, and sets the mark when it is", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue([planned({ position: 1, paths: ["src/a.ts"] })]);
    mockDb.getClawsIssue.mockResolvedValue(issue("clw_N"));
    mockDb.setClawsIssueOverlapHoldLifted.mockResolvedValue(true);
    const ok = await liftOverlapHold("clw_N", { kind: "dashboard", who: "op" }, NOW);
    expect(ok).toMatchObject({ ok: true });
    expect(mockDb.setClawsIssueOverlapHoldLifted).toHaveBeenCalledWith("clw_N", "op");
    expect(mockLog.info).toHaveBeenCalledWith("overlap_hold_lifted", expect.objectContaining({ issue: "clw_N", by: "op" }));

    mockDb.setClawsIssueOverlapHoldLifted.mockClear();
    mockDb.getIssuePlannedPRs.mockResolvedValue([planned({ position: 1, paths: ["docs"] })]);
    expect(await liftOverlapHold("clw_N", { kind: "session", sid: "abc" }, NOW)).toMatchObject({ ok: false, status: 409 });
    mockDb.getClawsIssue.mockResolvedValue(issue("clw_N", { state: "closed" }));
    expect(await liftOverlapHold("clw_N", { kind: "session", sid: "abc" }, NOW)).toMatchObject({ ok: false, status: 409 });
    mockDb.getClawsIssue.mockResolvedValue(undefined);
    expect(await liftOverlapHold("clw_N", { kind: "session", sid: "abc" }, NOW)).toMatchObject({ ok: false, status: 404 });
    expect(mockDb.setClawsIssueOverlapHoldLifted).not.toHaveBeenCalled();
  });
});

describe("storedIssueHolds", () => {
  beforeEach(() => {
    mockDb.listOverlapPrRows.mockResolvedValue([row({ prNumber: 4, issueId: "clw_OLD", files: ["src/a.ts"] })]);
  });

  it("lists each held ready step, even when another may start, and the plan's size from one read", async () => {
    plans.set("clw_N", [planned({ position: 1, paths: ["src/a.ts"] }), planned({ position: 2, paths: ["docs"] })]);
    const out = await storedIssueHolds("clw_N", NOW);
    expect(out.plannedCount).toBe(2);
    expect(out.holds).toEqual([{ repo: REPO, position: 1, holders: [{ issueId: "clw_OLD", position: 1, prNumber: 4, running: true, shared: ["src/a.ts"] }] }]);
    expect(mockDb.getIssuePlannedPRs).toHaveBeenCalledTimes(1);
  });

  it("holds nothing for a step whose PR is already open, though it shares files with a PR ahead", async () => {
    plans.set("clw_N", [planned({ position: 1, paths: ["src/a.ts"] })]);
    mockDb.listClawsPrsForIssue.mockResolvedValue([{ repo: REPO, prNumber: 9, phase: 1, stage: "awaiting-review" }]);
    expect(await storedIssueHolds("clw_N", NOW)).toEqual({ plannedCount: 1, holds: [] });
  });

  it("holds nothing for a step still waiting on its own earlier step", async () => {
    plans.set("clw_N", [planned({ position: 1, paths: ["docs"], prNumber: 9 }), planned({ position: 2, dependsOn: [1], paths: ["src/a.ts"] })]);
    mockDb.listClawsPrsForIssue.mockResolvedValue([{ repo: REPO, prNumber: 9, phase: 1, stage: "awaiting-review" }]);
    expect((await storedIssueHolds("clw_N", NOW)).holds).toEqual([]);
  });

  it("holds nothing for a lifted, Priority, closed or unknown issue, but still counts its plan", async () => {
    plans.set("clw_L", [planned({ paths: ["src/a.ts"] })]);
    plans.set("clw_P", [planned({ paths: ["src/a.ts"] })]);
    plans.set("clw_C", [planned({ paths: ["src/a.ts"] })]);
    issueRecords.set("clw_L", issue("clw_L", { overlap_hold_lifted_at: "2026-11-20 10:00:00" }));
    issueRecords.set("clw_P", issue("clw_P", { labels: ["Priority"] }));
    issueRecords.set("clw_C", issue("clw_C", { state: "closed" }));
    expect(await storedIssueHolds("clw_L", NOW)).toEqual({ plannedCount: 1, holds: [] });
    expect(await storedIssueHolds("clw_P", NOW)).toEqual({ plannedCount: 1, holds: [] });
    expect(await storedIssueHolds("clw_C", NOW)).toEqual({ plannedCount: 1, holds: [] });
    mockDb.getClawsIssue.mockResolvedValue(undefined);
    expect(await storedIssueHolds("clw_X", NOW)).toEqual({ plannedCount: 0, holds: [] });
  });
});

describe("only running or startable steps hold (#clw_01M80QPKHGF99SNVZE66C46TY2)", () => {
  const ready = (id: string, paths: string[]) => heldSteps({ id, priority: false }, [planned({ paths })], NOW);
  beforeEach(() => {
    mockDb.listOverlapPrRows.mockResolvedValue([]);
  });

  it("does not serialise the bonkus chain behind one PR in review", async () => {
    const layout = ["docs/native-apps.md", "android/LayoutGate.kt", "android/DesignScreenshotTest.kt"];
    const drift = ["android/DesignScreenshotTest.kt", "docs/DESIGN.md", "ios/GameTypeOrderTests.swift", ".forgejo/workflows/native-android.yml"];
    const order = ["ios/GameTypeOrderTests.swift"];
    const ci = [".forgejo/workflows/native-android.yml", "docs/ci-cd.md"];
    mockDb.listOverlapPrRows.mockResolvedValue([
      row({ prNumber: 492, issueId: "clw_CHAT", planApprovedAt: "2026-11-19T00:00:00Z", files: ["docs/native-apps.md", "docs/DESIGN.md", "android/Chat.kt"] }),
    ]);
    mockDb.listOverlapUnstartedSteps.mockResolvedValue([
      unstarted({ issueId: "clw_LAYOUT", paths: layout, planApprovedAt: "2026-11-20T01:00:00Z" }),
      unstarted({ issueId: "clw_DRIFT", paths: drift, planApprovedAt: "2026-11-20T02:00:00Z" }),
      unstarted({ issueId: "clw_ORDER", position: 2, paths: order, planApprovedAt: "2026-11-20T03:00:00Z" }),
      unstarted({ issueId: "clw_CI", paths: ci, planApprovedAt: "2026-11-20T04:00:00Z" }),
    ]);
    expect((await ready("clw_LAYOUT", layout)).get(1)).toBeNull();
    expect((await ready("clw_DRIFT", drift)).get(1)?.holders).toEqual([
      { issueId: "clw_LAYOUT", position: 1, prNumber: null, running: false, shared: ["android/DesignScreenshotTest.kt"] },
    ]);
    expect((await heldSteps({ id: "clw_ORDER", priority: false }, [planned({ position: 2, paths: order })], NOW)).get(2)).toBeNull();
    expect((await ready("clw_CI", ci)).get(1)).toBeNull();

    // Once the layout gate cannot start (its first step has not landed), the Drift board is free too.
    clearInFlightMemo();
    plans.set("clw_LAYOUT", [planned({ position: 1, paths: ["src/first.kt"] }), planned({ position: 2, paths: layout })]);
    mockDb.listOverlapUnstartedSteps.mockResolvedValue([
      unstarted({ issueId: "clw_LAYOUT", position: 2, paths: layout, planApprovedAt: "2026-11-20T01:00:00Z" }),
      unstarted({ issueId: "clw_DRIFT", paths: drift, planApprovedAt: "2026-11-20T02:00:00Z" }),
    ]);
    expect((await ready("clw_DRIFT", drift)).get(1)).toBeNull();
  });

  it("lets a step three dependencies from starting hold nothing, so the issue behind it shows no hold", async () => {
    plans.set("clw_FAR", Array.from({ length: 6 }, (_, i) => planned({ position: i + 1, dependsOn: i === 0 ? [] : [i] })));
    plans.set("clw_RL", [planned({ position: 1, paths: ["train/loader.py"] })]);
    mockDb.listOverlapPrRows.mockResolvedValue([row({ prNumber: 30, issueId: "clw_FAR", phase: 3, files: ["src/other.py"] })]);
    mockDb.listClawsPrsForIssue.mockImplementation(async (id: string) => id === "clw_FAR"
      ? [{ repo: REPO, prNumber: 10, phase: 1, stage: "merged" }, { repo: REPO, prNumber: 20, phase: 2, stage: "merged" }, { repo: REPO, prNumber: 30, phase: 3, stage: "awaiting-review" }]
      : []);
    mockDb.listOverlapUnstartedSteps.mockResolvedValue([
      unstarted({ issueId: "clw_FAR", position: 6, paths: ["train/loader.py"], totalSteps: 6, planApprovedAt: "2026-11-19T00:00:00Z" }),
      unstarted({ issueId: "clw_RL", paths: ["train/loader.py"], planApprovedAt: "2026-11-20T00:00:00Z" }),
    ]);
    const steps = await loadInFlight(REPO, NOW);
    expect(steps.find((st) => st.issueId === "clw_FAR" && st.position === 6)).toMatchObject({ ready: false, holds: false });
    expect((await ready("clw_RL", ["train/loader.py"])).get(1)).toBeNull();
    expect((await storedOverlapHolds([issue("clw_RL")], NOW)).get("clw_RL")).toBeUndefined();
  });

  it("counts a ready step of an issue with an active implementer as running, ahead of an earlier approval", async () => {
    mockDb.listActiveImplementerRefs.mockResolvedValue([{ repo: REPO, itemNumber: 42 }]);
    mockDb.getLinkedNativeId.mockImplementation(async (repo: string, n: number) => (repo === REPO && n === 42 ? "clw_IMPL" : undefined));
    mockDb.listOverlapUnstartedSteps.mockResolvedValue([
      unstarted({ issueId: "clw_OLD", planApprovedAt: "2026-11-19T00:00:00Z" }),
      unstarted({ issueId: "clw_IMPL", planApprovedAt: "2026-11-20T00:00:00Z" }),
    ]);
    const steps = await loadInFlight(REPO, NOW);
    expect(steps.map((st) => [st.issueId, st.running, st.holds])).toEqual([["clw_OLD", false, false], ["clw_IMPL", true, true]]);
    const hold = (await ready("clw_OLD", ["src/a.ts"])).get(1);
    expect(hold && overlapHoldNote(hold)).toBe("Waiting on #clw_IMPL step 1 (org/a, implementing): shares src/a.ts");
    expect((await ready("clw_IMPL", ["src/a.ts"])).get(1)).toBeNull();
  });

  it("lets an issue whose hold was lifted hold the steps behind it", async () => {
    mockDb.listOverlapPrRows.mockResolvedValue([row({ prNumber: 4, issueId: "clw_PR", files: ["src/a.ts"] })]);
    mockDb.listOverlapUnstartedSteps.mockResolvedValue([
      unstarted({ issueId: "clw_LIFTED", planApprovedAt: "2026-11-19T00:00:00Z", holdLifted: true }),
      unstarted({ issueId: "clw_LATER", planApprovedAt: "2026-11-20T00:00:00Z" }),
    ]);
    expect((await loadInFlight(REPO, NOW)).map((st) => [st.issueId, st.exempt, st.holds])).toEqual([
      ["clw_PR", false, true], ["clw_LIFTED", true, true], ["clw_LATER", false, false],
    ]);
  });

  it("never holds work on a failed readiness read", async () => {
    mockDb.listOverlapUnstartedSteps.mockResolvedValue([
      unstarted({ issueId: "clw_OLD", planApprovedAt: "2026-11-19T00:00:00Z" }),
      unstarted({ issueId: "clw_NEW", planApprovedAt: "2026-11-20T00:00:00Z" }),
    ]);
    mockDb.listClawsPrsForIssue.mockImplementation(async (id: string) => {
      if (id === "clw_OLD") throw new Error("db down");
      return [];
    });
    expect((await ready("clw_NEW", ["src/a.ts"])).get(1)).toBeNull();
    expect(mockLog.warn).toHaveBeenCalledWith("overlap_readiness_read_failed", expect.objectContaining({ issue: "clw_OLD" }), expect.any(Error));
  });

  it("does not defer a conflicting PR whose only overlap ahead is shared docs", async () => {
    mockDb.listOverlapPrRows.mockResolvedValue([
      row({ prNumber: 3, issueId: "clw_A", planApprovedAt: "2026-11-19T01:00:00Z", files: ["docs/DESIGN.md", "README.md", "src/a.ts"] }),
      row({ prNumber: 9, issueId: "clw_C", planApprovedAt: "2026-11-19T03:00:00Z", files: ["docs/DESIGN.md", "README.md", "src/c.ts"] }),
    ]);
    expect(await conflictDeferral(REPO, 9, NOW)).toBeNull();
  });
});
