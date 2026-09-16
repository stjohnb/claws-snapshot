import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──

const mockGetWorkflowRunCount = vi.hoisted(() => vi.fn(() => 0));
const mockUpsertWorkflowRuns = vi.hoisted(() => vi.fn());
const mockGetActiveWorkflowRuns = vi.hoisted(() => vi.fn(() => [] as any[]));
const mockHasRecentlyCompletedTasks = vi.hoisted(() => vi.fn(() => false));
const mockGetRunningTasks = vi.hoisted(() => vi.fn(() => [] as any[]));
const mockDeleteWorkflowRun = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  getWorkflowRunCount: mockGetWorkflowRunCount,
  upsertWorkflowRuns: mockUpsertWorkflowRuns,
  getActiveWorkflowRuns: mockGetActiveWorkflowRuns,
  hasRecentlyCompletedTasks: mockHasRecentlyCompletedTasks,
  getRunningTasks: mockGetRunningTasks,
  deleteWorkflowRun: mockDeleteWorkflowRun,
}));

const mockListRepos = vi.hoisted(() => vi.fn(() => Promise.resolve([] as any[])));
const mockFetchWorkflowRunsForBackfill = vi.hoisted(() => vi.fn(() => Promise.resolve([] as any[])));
const mockFetchRecentWorkflowRuns = vi.hoisted(() => vi.fn(() => Promise.resolve([] as any[])));
const mockFetchActiveWorkflowRuns = vi.hoisted(() => vi.fn(() => Promise.resolve([] as any[])));
const mockFetchWorkflowRunById = vi.hoisted(() => vi.fn(() => Promise.resolve(null as any)));

vi.mock("../github.js", () => ({
  listRepos: mockListRepos,
  fetchWorkflowRunsForBackfill: mockFetchWorkflowRunsForBackfill,
  fetchRecentWorkflowRuns: mockFetchRecentWorkflowRuns,
  fetchActiveWorkflowRuns: mockFetchActiveWorkflowRuns,
  fetchWorkflowRunById: mockFetchWorkflowRunById,
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { run, _resetState } from "./runner-metrics-sync.js";
import * as log from "../log.js";

describe("runner-metrics-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetState();
    mockListRepos.mockResolvedValue([]);
    mockFetchWorkflowRunsForBackfill.mockResolvedValue([]);
    mockFetchRecentWorkflowRuns.mockResolvedValue([]);
    mockFetchActiveWorkflowRuns.mockResolvedValue([]);
    mockFetchWorkflowRunById.mockResolvedValue(null);
    mockGetWorkflowRunCount.mockReturnValue(0);
    mockGetActiveWorkflowRuns.mockReturnValue([]);
    mockGetRunningTasks.mockReturnValue([]);
    mockHasRecentlyCompletedTasks.mockReturnValue(false);
  });

  // ── Backfill on first run ──

  it("backfills when table is empty on first run", async () => {
    const backfillRuns = [{ run_id: 1, repo: "org/repo" }];
    mockGetWorkflowRunCount.mockReturnValue(0);
    mockListRepos.mockResolvedValue([{ owner: "org", name: "repo" }]);
    mockFetchWorkflowRunsForBackfill.mockResolvedValue(backfillRuns);

    await run();

    expect(mockFetchWorkflowRunsForBackfill).toHaveBeenCalled();
    expect(mockUpsertWorkflowRuns).toHaveBeenCalledWith(backfillRuns);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("backfilling"));
    // Should return early after backfill
    expect(mockFetchRecentWorkflowRuns).not.toHaveBeenCalled();
  });

  it("defers backfill when listRepos returns 0 repos (transient rate limit) and retries next run", async () => {
    mockGetWorkflowRunCount.mockReturnValue(0);
    mockListRepos.mockResolvedValue([]);

    await run();

    expect(mockFetchWorkflowRunsForBackfill).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Backfill deferred"));

    vi.clearAllMocks();
    mockGetWorkflowRunCount.mockReturnValue(0);
    const backfillRuns = [{ run_id: 1, repo: "org/repo" }];
    mockListRepos.mockResolvedValue([{ owner: "org", name: "repo" }]);
    mockFetchWorkflowRunsForBackfill.mockResolvedValue(backfillRuns);

    await run();

    expect(mockFetchWorkflowRunsForBackfill).toHaveBeenCalled();
    expect(mockUpsertWorkflowRuns).toHaveBeenCalledWith(backfillRuns);
  });

  it("skips backfill when table already has rows on first run", async () => {
    mockGetWorkflowRunCount.mockReturnValue(50);
    // No active or recent tasks, but isStale is true since lastFullSyncAt=0
    mockGetActiveWorkflowRuns.mockReturnValue([]);

    await run();

    expect(mockFetchWorkflowRunsForBackfill).not.toHaveBeenCalled();
    expect(mockFetchRecentWorkflowRuns).toHaveBeenCalled();
    expect(mockFetchActiveWorkflowRuns).toHaveBeenCalled();
  });

  it("does not re-backfill on subsequent runs even if table is empty (initialized=true)", async () => {
    // First run: table is populated, no backfill
    mockGetWorkflowRunCount.mockReturnValue(10);
    await run();
    expect(mockFetchWorkflowRunsForBackfill).not.toHaveBeenCalled();

    vi.clearAllMocks();
    // Second run: table now empty (e.g. if DB was reset externally)
    // Provide activity so the sync runs (not skipped by activity gate)
    mockGetWorkflowRunCount.mockReturnValue(0);
    mockGetRunningTasks.mockReturnValue([{ id: 1 }]); // activity triggers sync
    mockFetchRecentWorkflowRuns.mockResolvedValue([]);
    mockFetchActiveWorkflowRuns.mockResolvedValue([]);

    await run();

    // Should NOT backfill because initialized flag was already set
    expect(mockFetchWorkflowRunsForBackfill).not.toHaveBeenCalled();
    expect(mockFetchRecentWorkflowRuns).toHaveBeenCalled();
  });

  // ── Activity gate ──

  it("skips sync when no activity and not stale", async () => {
    // First run sets initialized=true; table has data so no backfill
    mockGetWorkflowRunCount.mockReturnValue(10);
    await run(); // first run — syncs (isStale=true since lastFullSyncAt=0)
    vi.clearAllMocks();

    // Second run immediately — lastFullSyncAt is recent, no activity
    mockGetActiveWorkflowRuns.mockReturnValue([]);
    mockGetRunningTasks.mockReturnValue([]);
    mockHasRecentlyCompletedTasks.mockReturnValue(false);

    await run();

    expect(mockFetchRecentWorkflowRuns).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("No recent activity"));
  });

  it("syncs when there are active workflow runs", async () => {
    // Skip first-run initialization by running once first
    mockGetWorkflowRunCount.mockReturnValue(10);
    await run();
    vi.clearAllMocks();
    mockFetchRecentWorkflowRuns.mockResolvedValue([]);
    mockFetchActiveWorkflowRuns.mockResolvedValue([]);

    // Now simulate active runs in DB
    mockGetActiveWorkflowRuns.mockReturnValue([{ run_id: 1, status: "in_progress" }]);

    await run();

    expect(mockFetchRecentWorkflowRuns).toHaveBeenCalled();
    expect(mockFetchActiveWorkflowRuns).toHaveBeenCalled();
    expect(mockUpsertWorkflowRuns).toHaveBeenCalled();
  });

  it("syncs when running tasks exist", async () => {
    mockGetWorkflowRunCount.mockReturnValue(10);
    await run();
    vi.clearAllMocks();
    mockFetchRecentWorkflowRuns.mockResolvedValue([]);
    mockFetchActiveWorkflowRuns.mockResolvedValue([]);

    mockGetRunningTasks.mockReturnValue([{ id: 1 }]);

    await run();

    expect(mockFetchRecentWorkflowRuns).toHaveBeenCalled();
  });

  it("fetches both recent and active runs and combines them", async () => {
    const recent = [{ run_id: 1, repo: "org/repo" }];
    const active = [{ run_id: 2, repo: "org/repo" }];
    mockGetWorkflowRunCount.mockReturnValue(10);
    mockFetchRecentWorkflowRuns.mockResolvedValue(recent);
    mockFetchActiveWorkflowRuns.mockResolvedValue(active);

    await run(); // first run (stale)

    expect(mockUpsertWorkflowRuns).toHaveBeenCalledWith([...recent, ...active]);
  });

  it("deduplicates overlapping run_ids, keeping the active run's status", async () => {
    const recentRun = { run_id: 42, repo: "org/repo", status: "queued" };
    const activeRun = { run_id: 42, repo: "org/repo", status: "in_progress" };
    mockGetWorkflowRunCount.mockReturnValue(10);
    mockFetchRecentWorkflowRuns.mockResolvedValue([recentRun]);
    mockFetchActiveWorkflowRuns.mockResolvedValue([activeRun]);

    await run(); // first run (stale)

    expect(mockUpsertWorkflowRuns).toHaveBeenCalledWith([activeRun]);
  });

  it("reconciles straggler active runs not returned by the sync", async () => {
    mockGetWorkflowRunCount.mockReturnValue(10);
    mockFetchRecentWorkflowRuns.mockResolvedValue([]);
    mockFetchActiveWorkflowRuns.mockResolvedValue([]);
    const straggler = { run_id: 99, repo: "org/repo", status: "in_progress" };
    mockGetActiveWorkflowRuns.mockReturnValue([straggler]);
    const reconciled = { run_id: 99, repo: "org/repo", status: "completed", conclusion: "success" };
    mockFetchWorkflowRunById.mockResolvedValue(reconciled);

    await run();

    expect(mockFetchWorkflowRunById).toHaveBeenCalledWith("org/repo", 99);
    expect(mockUpsertWorkflowRuns).toHaveBeenCalledWith([reconciled]);
  });

  it("deletes stragglers whose GH run returns not_found", async () => {
    mockGetWorkflowRunCount.mockReturnValue(10);
    mockFetchRecentWorkflowRuns.mockResolvedValue([]);
    mockFetchActiveWorkflowRuns.mockResolvedValue([]);
    const straggler = { run_id: 77, repo: "org/repo", status: "queued" };
    mockGetActiveWorkflowRuns.mockReturnValue([straggler]);
    mockFetchWorkflowRunById.mockResolvedValue("not_found");

    await run();

    expect(mockDeleteWorkflowRun).toHaveBeenCalledWith(77);
  });

  it("skips reconciliation for runs that were returned by the sync", async () => {
    mockGetWorkflowRunCount.mockReturnValue(10);
    const hit = { run_id: 10, repo: "org/repo", status: "in_progress" };
    mockFetchRecentWorkflowRuns.mockResolvedValue([hit]);
    mockFetchActiveWorkflowRuns.mockResolvedValue([]);
    mockGetActiveWorkflowRuns.mockReturnValue([hit]);

    await run();

    expect(mockFetchWorkflowRunById).not.toHaveBeenCalled();
  });
});
