import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./config.js", () => ({
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import {
  initDb,
  closeDb,
  _rawDb,
  recordTaskStart,
  updateTaskWorktree,
  recordTaskComplete,
  recordTaskFailed,
  getOrphanedTasks,
  getRunningTasks,
  setRunIdProvider,
  getTasksByRunId,
  getWorkItemsForRuns,
  getRecentWorkItems,
  searchRunsByItem,
  countRecentTimeouts,
  countRecentMemoryLimits,
  countRecentNoCommitCompletions,
  insertJobRun,
  completeJobRun,
  insertJobLog,
  flushJobLogs,
  getRecentJobRuns,
  getDistinctJobNames,
  getJobRunLogs,
  getJobRunLogsSince,
  getLatestRunIdsByJob,
  getJobRun,
  pruneOldLogs,
  getAllAverageTaskDurations,
  recordQueueSnapshot,
  getQueueSnapshots,
  pruneQueueSnapshots,
  upsertWorkflowRuns,
  getWorkflowRunStats,
  getActiveWorkflowRuns,
  getWorkflowRunCount,
  pruneWorkflowRuns,
  countCIFixerAttempts,
  countConflictResolutionAttempts,
  getCIFixerBreakerState,
  recordCIFixerBreakerTrip,
  recordCIFixerPush,
  recordCIFixerBreakerGrant,
  resetCIFixerBreakerGrants,
  getRecentCIFixerErrors,
  enqueueWork,
  claimNextWork,
  markWorkSucceeded,
  markWorkFailed,
  markWorkCancelled,
  listQueuedWork,
  countWorkByStatus,
  recoverWorkOnStartup,
  pruneWorkQueue,
  pruneTasks,
  hasActiveWorkForPR,
  clearAllWorkQueueForTests,
  markUntrustedActorNotified,
  getIntentBackfillState,
  recordIntentBackfillChunk,
  getDocMemoryDigest,
  recordDocMemoryDigest,
  trackTaskTokens,
  getUsageStats,
  getTotalUsage,
  getUsageFilterOptions,
  getRecentEffectivenessEvents,
  recordTaskEffectivenessEvent,
  findLatestCompletedTaskForPrHead,
  updateTaskModel,
  updateTaskProvider,
  updateTaskTokenUsage,
  insertSession,
  getAllPersistedSessions,
  getEndedSessions,
  markSessionEnded,
  pruneEndedSessions,
  getRecentSessionModels,
  updateSessionSummary,
  setManualSessionSummary,
  upsertDampReading,
  deleteDampReading,
  getRecentDampReadings,
  insertDmarcReport,
  hasDmarcReport,
  getLatestDmarcReportForDomain,
  getDmarcReportXml,
  getDmarcVerdictCounts,
  getDmarcSourceIps,
  getLatestDmarcReportsPerReporter,
  pruneDmarcReports,
  getDampTrendRows,
  upsertBlogDraft,
  getBlogDraft,
  listBlogDrafts,
  setBlogDraftPushed,
  clearBlogDraftPR,
  recordShoppingSearch,
  getShoppingSearches,
  recordHaEntityUnavailable,
  clearHaEntityUnavailable,
  getDefaultBranchRuns,
  recordMainBuildFailure,
  hasMainBuildFailure,
  getPendingMainBuildRetries,
  getExpiredMainBuildRetries,
  setMainBuildRetryOutcome,
  markMainBuildReported,
  hasUnclosedReportedFailure,
  markMainBuildFailuresClosed,
  getUnreportedMainBuildFailures,
  pruneMainBuildFailures,
  describePostgresTarget,
  type Task,
  type TaskOutcome,
  type WorkflowRunRow,
} from "./db.js";

/** A timestamp in the stored `YYYY-MM-DD HH:MM:SS` UTC form, `ms` in the past.
 *  Test fixtures bind these instead of calling SQLite's `datetime('now', …)`, so
 *  the same SQL runs on both backends. */
function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString().slice(0, 19).replace("T", " ");
}

describe("db", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("initDb creates the tasks table", async () => {
    // If initDb didn't create the table, recordTaskStart would throw
    const id = await recordTaskStart("test-job", "test/repo", 1, "label");
    expect(id).toBeGreaterThan(0);
  });

  it("initDb creates the idx_tasks_repo_item index", async () => {
    const db = _rawDb();
    const idx = db.dialect === "postgres"
      ? await db.get(`SELECT indexname AS name FROM pg_indexes WHERE indexname = 'idx_tasks_repo_item'`)
      : await db.get(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_repo_item'`);
    expect(idx).toBeDefined();
  });

  it("initDb creates task effectiveness events table and unique index", async () => {
    const db = _rawDb();
    const table = db.dialect === "postgres"
      ? await db.get(`SELECT tablename AS name FROM pg_tables WHERE tablename = 'task_effectiveness_events'`)
      : await db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='task_effectiveness_events'`);
    const idx = db.dialect === "postgres"
      ? await db.get(`SELECT indexname AS name FROM pg_indexes WHERE indexname = 'idx_task_effectiveness_unique'`)
      : await db.get(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_task_effectiveness_unique'`);
    expect(table).toBeDefined();
    expect(idx).toBeDefined();
  });

  it("recordTaskStart inserts a running task and returns an ID", async () => {
    const id = await recordTaskStart("issue-worker", "org/repo", 42, "Refined");
    expect(id).toBe(1);

    const tasks = await getOrphanedTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].job_name).toBe("issue-worker");
    expect(tasks[0].repo).toBe("org/repo");
    expect(tasks[0].item_number).toBe(42);
    expect(tasks[0].trigger_label).toBe("Refined");
    expect(tasks[0].status).toBe("running");
  });

  it("updateTaskWorktree sets worktree path and branch name", async () => {
    const id = await recordTaskStart("test-job", "org/repo", 1, null);
    await updateTaskWorktree(id, "/tmp/worktree", "feature-branch");

    const tasks = await getOrphanedTasks();
    expect(tasks[0].worktree_path).toBe("/tmp/worktree");
    expect(tasks[0].branch_name).toBe("feature-branch");
  });

  it("recordTaskComplete sets status to completed", async () => {
    const id = await recordTaskStart("test-job", "org/repo", 1, null);
    await recordTaskComplete(id);

    // Should no longer appear as orphaned (not 'running')
    const orphaned = await getOrphanedTasks();
    expect(orphaned).toHaveLength(0);
  });

  it("recordTaskComplete stores outcome JSON when provided", async () => {
    setRunIdProvider(() => "run-outcome");
    const id = await recordTaskStart("issue-worker", "org/repo", 1, null);
    const outcome: TaskOutcome = {
      commits: 3,
      filesChanged: 5,
      insertions: 127,
      deletions: 42,
      prNumber: 185,
      prAction: "created",
    };
    await recordTaskComplete(id, outcome);
    setRunIdProvider(() => undefined);

    const tasks = await getTasksByRunId("run-outcome");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("completed");
    expect(tasks[0].outcome).not.toBeNull();

    const parsed = JSON.parse(tasks[0].outcome!);
    expect(parsed.commits).toBe(3);
    expect(parsed.filesChanged).toBe(5);
    expect(parsed.insertions).toBe(127);
    expect(parsed.deletions).toBe(42);
    expect(parsed.prNumber).toBe(185);
    expect(parsed.prAction).toBe("created");
  });

  it("recordTaskComplete without outcome leaves outcome null", async () => {
    setRunIdProvider(() => "run-no-outcome");
    const id = await recordTaskStart("test-job", "org/repo", 1, null);
    await recordTaskComplete(id);
    setRunIdProvider(() => undefined);

    const tasks = await getTasksByRunId("run-no-outcome");
    expect(tasks[0].outcome).toBeNull();
  });

  it("recordTaskFailed sets status to failed and stores error", async () => {
    const id = await recordTaskStart("test-job", "org/repo", 1, null);
    await recordTaskFailed(id, "Something went wrong");

    const orphaned = await getOrphanedTasks();
    expect(orphaned).toHaveLength(0);
  });

  it("recordTaskFailed stores outcome JSON when provided", async () => {
    setRunIdProvider(() => "run-fail-outcome");
    const id = await recordTaskStart("test-job", "org/repo", 1, null);
    await recordTaskFailed(id, "timed out", { failureCategory: "timeout" });
    setRunIdProvider(() => undefined);

    const tasks = await getTasksByRunId("run-fail-outcome");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("failed");
    expect(tasks[0].error).toBe("timed out");

    const parsed = JSON.parse(tasks[0].outcome!);
    expect(parsed.failureCategory).toBe("timeout");
  });

  it("getOrphanedTasks returns only running tasks", async () => {
    const id1 = await recordTaskStart("job-a", "org/repo", 1, null);
    const id2 = await recordTaskStart("job-b", "org/repo", 2, null);
    const id3 = await recordTaskStart("job-c", "org/repo", 3, null);

    await recordTaskComplete(id1);
    await recordTaskFailed(id2, "error");

    const orphaned = await getOrphanedTasks();
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].id).toBe(id3);
    expect(orphaned[0].status).toBe("running");
  });

  it("closeDb closes cleanly", async () => {
    await closeDb();
    // After closing, operations should throw
    await expect(recordTaskStart("test", "repo", 1, null)).rejects.toThrow(
      "Database not initialized",
    );
  });

  it("countRecentTimeouts counts failed tasks with timeout errors", async () => {
    const db = _rawDb();
    // Insert a recent timeout failure
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Claude process timed out after 1200000ms', '${ago(1800000)}', '${ago(1740000)}')`, ["issue-worker", "org/repo", 42]);
    // Insert a recent non-timeout failure
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Some other error', '${ago(1200000)}', '${ago(1140000)}')`, ["issue-worker", "org/repo", 42]);
    // Insert an old timeout failure (outside window)
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Claude process timed out after 1200000ms', '${ago(18000000)}', '${ago(18000000)}')`, ["issue-worker", "org/repo", 42]);

    // Default 2-hour window should find 1 timeout
    expect(await countRecentTimeouts("org/repo", 42)).toBe(1);
  });

  it("countRecentTimeouts returns 0 when no timeouts exist", async () => {
    expect(await countRecentTimeouts("org/repo", 99)).toBe(0);
  });

  it("countRecentTimeouts scopes by repo and item number", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Claude process timed out after 1200000ms', '${ago(600000)}', '${ago(540000)}')`, ["issue-worker", "org/repo", 42]);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Claude process timed out after 1200000ms', '${ago(600000)}', '${ago(540000)}')`, ["issue-worker", "other/repo", 42]);

    expect(await countRecentTimeouts("org/repo", 42)).toBe(1);
    expect(await countRecentTimeouts("other/repo", 42)).toBe(1);
    expect(await countRecentTimeouts("org/repo", 99)).toBe(0);
  });

  it("countRecentMemoryLimits counts failed tasks with memory limit errors", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Agent process tree exceeded memory limit (2100MiB > 2048MiB)', '${ago(1800000)}', '${ago(1740000)}')`, ["issue-worker", "org/repo", 42]);
    // Insert a recent non-memory-limit failure
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Some other error', '${ago(1200000)}', '${ago(1140000)}')`, ["issue-worker", "org/repo", 42]);
    // Insert an old memory-limit failure (outside window)
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Agent process tree exceeded memory limit (2100MiB > 2048MiB)', '${ago(18000000)}', '${ago(18000000)}')`, ["issue-worker", "org/repo", 42]);

    expect(await countRecentMemoryLimits("org/repo", 42)).toBe(1);
  });

  it("countRecentMemoryLimits returns 0 when no memory limit errors exist", async () => {
    expect(await countRecentMemoryLimits("org/repo", 99)).toBe(0);
  });

  it("countRecentMemoryLimits scopes by repo and item number", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Agent process tree exceeded memory limit (2100MiB > 2048MiB)', '${ago(600000)}', '${ago(540000)}')`, ["issue-worker", "org/repo", 42]);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Agent process tree exceeded memory limit (2100MiB > 2048MiB)', '${ago(600000)}', '${ago(540000)}')`, ["issue-worker", "other/repo", 42]);

    expect(await countRecentMemoryLimits("org/repo", 42)).toBe(1);
    expect(await countRecentMemoryLimits("other/repo", 42)).toBe(1);
    expect(await countRecentMemoryLimits("org/repo", 99)).toBe(0);
  });

  it("countRecentNoCommitCompletions counts completed tasks with 0 commits and no prNumber", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(1800000)}', '${ago(1740000)}')`, ["issue-worker", "org/repo", 42]);

    expect(await countRecentNoCommitCompletions("org/repo", 42)).toBe(1);
  });

  it("countRecentNoCommitCompletions excludes tasks with commits > 0", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":3}', '${ago(1800000)}', '${ago(1740000)}')`, ["issue-worker", "org/repo", 42]);

    expect(await countRecentNoCommitCompletions("org/repo", 42)).toBe(0);
  });

  it("countRecentNoCommitCompletions excludes tasks with a prNumber", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0,"prNumber":100}', '${ago(1800000)}', '${ago(1740000)}')`, ["issue-worker", "org/repo", 42]);

    expect(await countRecentNoCommitCompletions("org/repo", 42)).toBe(0);
  });

  it("countRecentNoCommitCompletions scopes by repo and item number", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(600000)}', '${ago(540000)}')`, ["issue-worker", "org/repo", 42]);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(600000)}', '${ago(540000)}')`, ["issue-worker", "other/repo", 42]);

    expect(await countRecentNoCommitCompletions("org/repo", 42)).toBe(1);
    expect(await countRecentNoCommitCompletions("other/repo", 42)).toBe(1);
    expect(await countRecentNoCommitCompletions("org/repo", 99)).toBe(0);
  });

  it("countRecentNoCommitCompletions respects time window", async () => {
    const db = _rawDb();
    // Recent — within default 6h window
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(3600000)}', '${ago(3540000)}')`, ["issue-worker", "org/repo", 42]);
    // Old — outside default 6h window
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(28800000)}', '${ago(28800000)}')`, ["issue-worker", "org/repo", 42]);

    expect(await countRecentNoCommitCompletions("org/repo", 42)).toBe(1);
  });

  it("countRecentNoCommitCompletions resets after a merged PR (cross-phase scoping)", async () => {
    const db = _rawDb();
    // Phase 2 had 2 no-commit attempts before succeeding
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(10800000)}', '${ago(10800000)}')`, ["issue-worker", "org/repo", 42]);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(7200000)}', '${ago(7200000)}')`, ["issue-worker", "org/repo", 42]);
    // Phase 2 finally succeeded — PR merged
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":3,"prNumber":101}', '${ago(3600000)}', '${ago(3600000)}')`, ["issue-worker", "org/repo", 42]);
    // Phase 3, attempt 1: no commits
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', '${ago(1800000)}', '${ago(1800000)}')`, ["issue-worker", "org/repo", 42]);

    // Should only count the 1 no-commit attempt after the merged PR, not the 2 from phase 2
    expect(await countRecentNoCommitCompletions("org/repo", 42)).toBe(1);
  });

  it("operations before initDb throw", async () => {
    await closeDb(); // close the one from beforeEach
    await expect(recordTaskStart("test", "repo", 1, null)).rejects.toThrow(
      "Database not initialized",
    );
  });

  it("recordTaskStart with null trigger label", async () => {
    const id = await recordTaskStart("ci-fixer", "org/repo", 5, null);
    const tasks = await getOrphanedTasks();
    expect(tasks[0].trigger_label).toBeNull();
  });

  it("multiple tasks get sequential IDs", async () => {
    const id1 = await recordTaskStart("job-a", "org/repo", 1, null);
    const id2 = await recordTaskStart("job-b", "org/repo", 2, null);
    const id3 = await recordTaskStart("job-c", "org/repo", 3, null);

    expect(id1).toBe(1);
    expect(id2).toBe(2);
    expect(id3).toBe(3);
  });

  it("getRunningTasks returns only running tasks ordered by started_at", async () => {
    const id1 = await recordTaskStart("job-a", "org/repo", 1, null);
    const id2 = await recordTaskStart("job-b", "org/repo", 2, null);
    const id3 = await recordTaskStart("job-c", "org/repo", 3, null);

    await recordTaskComplete(id2);

    const running = await getRunningTasks();
    expect(running).toHaveLength(2);
    expect(running[0].id).toBe(id1);
    expect(running[1].id).toBe(id3);
    expect(running.every(t => t.status === "running")).toBe(true);
  });

  it("setRunIdProvider + recordTaskStart populates run_id", async () => {
    setRunIdProvider(() => "run-abc");
    const id = await recordTaskStart("issue-worker", "org/repo", 42, null);
    const tasks = await getOrphanedTasks();
    expect(tasks[0].run_id).toBe("run-abc");
    // Clean up provider
    setRunIdProvider(() => undefined);
  });

  it("recordTaskStart has null run_id when no provider is set", async () => {
    setRunIdProvider(() => undefined);
    const id = await recordTaskStart("issue-worker", "org/repo", 1, null);
    const tasks = await getOrphanedTasks();
    expect(tasks[0].run_id).toBeNull();
  });

  it("getTasksByRunId returns correct tasks", async () => {
    setRunIdProvider(() => "run-xyz");
    await recordTaskStart("job-a", "org/repo", 1, null);
    await recordTaskStart("job-a", "org/repo", 2, null);
    setRunIdProvider(() => "run-other");
    await recordTaskStart("job-a", "org/repo", 3, null);
    setRunIdProvider(() => undefined);

    const tasks = await getTasksByRunId("run-xyz");
    expect(tasks).toHaveLength(2);
    expect(tasks[0].item_number).toBe(1);
    expect(tasks[1].item_number).toBe(2);

    const otherTasks = await getTasksByRunId("run-other");
    expect(otherTasks).toHaveLength(1);
    expect(otherTasks[0].item_number).toBe(3);
  });

  it("getWorkItemsForRuns batch query", async () => {
    setRunIdProvider(() => "run-1");
    await recordTaskStart("job-a", "org/repo", 10, null);
    setRunIdProvider(() => "run-2");
    await recordTaskStart("job-a", "org/repo", 20, null);
    await recordTaskStart("job-a", "org/repo", 21, null);
    setRunIdProvider(() => undefined);

    const map = await getWorkItemsForRuns(["run-1", "run-2"]);
    expect(map.get("run-1")).toHaveLength(1);
    expect(map.get("run-2")).toHaveLength(2);
  });

  it("getWorkItemsForRuns returns empty map for empty input", async () => {
    const map = await getWorkItemsForRuns([]);
    expect(map.size).toBe(0);
  });

  it("searchRunsByItem finds runs by repo name", async () => {
    await insertJobRun("run-1", "job-a");
    setRunIdProvider(() => "run-1");
    await recordTaskStart("job-a", "org/my-repo", 5, null);
    setRunIdProvider(() => undefined);

    const results = await searchRunsByItem("my-repo");
    expect(results).toHaveLength(1);
    expect(results[0].run_id).toBe("run-1");
  });

  it("searchRunsByItem finds runs by item number", async () => {
    await insertJobRun("run-1", "job-a");
    setRunIdProvider(() => "run-1");
    await recordTaskStart("job-a", "org/repo", 42, null);
    setRunIdProvider(() => undefined);

    const results = await searchRunsByItem("42");
    expect(results).toHaveLength(1);
    expect(results[0].run_id).toBe("run-1");
  });

  it("searchRunsByItem returns empty for no match", async () => {
    await insertJobRun("run-1", "job-a");
    setRunIdProvider(() => "run-1");
    await recordTaskStart("job-a", "org/repo", 1, null);
    setRunIdProvider(() => undefined);

    const results = await searchRunsByItem("nonexistent");
    expect(results).toHaveLength(0);
  });

  it("searchRunsByItem finds runs by repo#number format", async () => {
    await insertJobRun("run-1", "job-a");
    setRunIdProvider(() => "run-1");
    await recordTaskStart("job-a", "org/claws", 195, null);
    setRunIdProvider(() => undefined);

    const results = await searchRunsByItem("claws#195");
    expect(results).toHaveLength(1);
    expect(results[0].run_id).toBe("run-1");
  });

  it("searchRunsByItem finds runs by full owner/repo#number format", async () => {
    await insertJobRun("run-1", "job-a");
    setRunIdProvider(() => "run-1");
    await recordTaskStart("job-a", "org/claws", 195, null);
    setRunIdProvider(() => undefined);

    const results = await searchRunsByItem("org/claws#195");
    expect(results).toHaveLength(1);
    expect(results[0].run_id).toBe("run-1");
  });

  it("searchRunsByItem repo#number does not match wrong number", async () => {
    await insertJobRun("run-1", "job-a");
    setRunIdProvider(() => "run-1");
    await recordTaskStart("job-a", "org/claws", 195, null);
    setRunIdProvider(() => undefined);

    const results = await searchRunsByItem("claws#999");
    expect(results).toHaveLength(0);
  });

  it("searchRunsByItem repo#number does not match wrong repo", async () => {
    await insertJobRun("run-1", "job-a");
    setRunIdProvider(() => "run-1");
    await recordTaskStart("job-a", "org/claws", 195, null);
    setRunIdProvider(() => undefined);

    const results = await searchRunsByItem("other#195");
    expect(results).toHaveLength(0);
  });
});

describe("describePostgresTarget", () => {
  it("names host and database without the credentials", () => {
    expect(describePostgresTarget("postgresql://claws:s3cr3t@postgres.databases.svc:5432/claws_staging"))
      .toBe("PostgreSQL (postgres.databases.svc:5432/claws_staging)");
  });

  it("never echoes the password, even with query parameters", () => {
    const out = describePostgresTarget("postgresql://claws:p%40ss%2Fword@db.internal/claws?sslmode=require");
    expect(out).toBe("PostgreSQL (db.internal/claws)");
    expect(out).not.toContain("pass");
    expect(out).not.toContain("sslmode");
  });

  it("omits the port when the URL has none", () => {
    expect(describePostgresTarget("postgres://db.internal/claws")).toBe("PostgreSQL (db.internal/claws)");
  });

  it("degrades to a bare label on an unparseable value", () => {
    expect(describePostgresTarget("host=db.internal dbname=claws password=s3cr3t")).toBe("PostgreSQL");
  });
});

describe("job run logs", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("insertJobRun creates a run record", async () => {
    await insertJobRun("run-1", "test-job");
    const runs = await getRecentJobRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].run_id).toBe("run-1");
    expect(runs[0].job_name).toBe("test-job");
    expect(runs[0].status).toBe("running");
    expect(runs[0].completed_at).toBeNull();
  });

  it("completeJobRun updates status and completed_at", async () => {
    await insertJobRun("run-1", "test-job");
    await completeJobRun("run-1", "completed");

    const run = await getJobRun("run-1");
    expect(run).toBeDefined();
    expect(run!.status).toBe("completed");
    expect(run!.completed_at).not.toBeNull();
  });

  it("completeJobRun can set status to failed", async () => {
    await insertJobRun("run-1", "test-job");
    await completeJobRun("run-1", "failed");

    const run = await getJobRun("run-1");
    expect(run!.status).toBe("failed");
  });

  it("insertJobLog appends log entries", async () => {
    await insertJobRun("run-1", "test-job");
    insertJobLog("run-1", "info", "Hello");
    insertJobLog("run-1", "warn", "Careful");
    insertJobLog("run-1", "error", "Boom");

    const logs = await getJobRunLogs("run-1");
    expect(logs).toHaveLength(3);
    expect(logs[0].level).toBe("info");
    expect(logs[0].message).toBe("Hello");
    expect(logs[1].level).toBe("warn");
    expect(logs[2].level).toBe("error");
  });

  it("getRecentJobRuns returns runs in descending order and respects limit", async () => {
    await insertJobRun("run-1", "job-a");
    await insertJobRun("run-2", "job-b");
    await insertJobRun("run-3", "job-c");

    const all = await getRecentJobRuns();
    expect(all).toHaveLength(3);
    // All rows share the same started_at (ago(0) at insert time), but ORDER BY DESC should still work
    expect(all.map((r) => r.run_id)).toContain("run-1");

    const limited = await getRecentJobRuns(2);
    expect(limited).toHaveLength(2);
  });

  it("getJobRunLogs returns entries for a specific run only", async () => {
    await insertJobRun("run-1", "job-a");
    await insertJobRun("run-2", "job-b");
    insertJobLog("run-1", "info", "Run 1 log");
    insertJobLog("run-2", "info", "Run 2 log");

    const logs1 = await getJobRunLogs("run-1");
    expect(logs1).toHaveLength(1);
    expect(logs1[0].message).toBe("Run 1 log");

    const logs2 = await getJobRunLogs("run-2");
    expect(logs2).toHaveLength(1);
    expect(logs2[0].message).toBe("Run 2 log");
  });

  it("getJobRun returns undefined for nonexistent run", async () => {
    const run = await getJobRun("nonexistent");
    expect(run).toBeUndefined();
  });

  it("pruneOldLogs deletes old entries and returns count", async () => {
    await insertJobRun("run-1", "job-a");
    insertJobLog("run-1", "info", "Old log");

    // With retention of 0 days, everything before now is pruned
    // Entries timestamped at ago(0) equal the cutoff, so they won't be pruned
    // Use a very large retention to verify nothing is pruned
    const prunedNone = await pruneOldLogs(9999);
    expect(prunedNone).toBe(0);
    expect(await getRecentJobRuns()).toHaveLength(1);
  });

  it("getRecentJobRuns with jobFilter returns only matching runs", async () => {
    await insertJobRun("run-1", "job-a");
    await insertJobRun("run-2", "job-b");
    await insertJobRun("run-3", "job-a");

    const filtered = await getRecentJobRuns(50, "job-a");
    expect(filtered).toHaveLength(2);
    expect(filtered.every((r) => r.job_name === "job-a")).toBe(true);

    const filteredB = await getRecentJobRuns(50, "job-b");
    expect(filteredB).toHaveLength(1);
    expect(filteredB[0].job_name).toBe("job-b");
  });

  it("getDistinctJobNames returns all job names sorted", async () => {
    await insertJobRun("run-1", "ci-fixer");
    await insertJobRun("run-2", "issue-worker");
    await insertJobRun("run-3", "issue-worker");
    await insertJobRun("run-4", "auto-merger");

    const names = await getDistinctJobNames();
    expect(names).toEqual(["auto-merger", "ci-fixer", "issue-worker"]);
  });

  it("getDistinctJobNames returns all job types even when getRecentJobRuns limit would exclude some", async () => {
    // Insert many runs of job-a and one run of job-b
    for (let i = 0; i < 5; i++) {
      await insertJobRun(`run-a-${i}`, "job-a");
    }
    await insertJobRun("run-b-1", "job-b");

    // With limit=3, getRecentJobRuns misses job-b (since job-a fills all slots)
    // but getDistinctJobNames should still return both
    const limited = await getRecentJobRuns(3);
    const namesFromLimited = [...new Set(limited.map((r) => r.job_name))];
    // job-b may or may not appear depending on insertion order

    const allNames = await getDistinctJobNames();
    expect(allNames).toContain("job-a");
    expect(allNames).toContain("job-b");
  });

  it("pruneOldLogs keeps most recent N runs per job type", async () => {
    const db = _rawDb();
    // Insert old runs for job-a (4 runs) and job-b (2 runs)
    for (let i = 1; i <= 4; i++) {
      await db.run(`INSERT INTO job_runs (run_id, job_name, status, started_at) VALUES (?, ?, 'completed', ?)`, [`old-a-${i}`, "job-a", ago(30 * 86_400_000 - i * 3_600_000)]);
    }
    for (let i = 1; i <= 2; i++) {
      await db.run(`INSERT INTO job_runs (run_id, job_name, status, started_at) VALUES (?, ?, 'completed', ?)`, [`old-b-${i}`, "job-b", ago(30 * 86_400_000 - i * 3_600_000)]);
    }
    // Insert logs for all runs
    for (let i = 1; i <= 4; i++) {
      insertJobLog(`old-a-${i}`, "info", `Log for a-${i}`);
    }
    for (let i = 1; i <= 2; i++) {
      insertJobLog(`old-b-${i}`, "info", `Log for b-${i}`);
    }
    await flushJobLogs();

    // Prune with keepPerJob=2 and retention=7 days (all runs are 30 days old)
    const pruned = await pruneOldLogs(7, 2);

    // job-a had 4 old runs, should keep 2 → prune 2
    // job-b had 2 old runs, should keep 2 → prune 0
    expect(pruned).toBe(2);

    const remainingA = await getRecentJobRuns(50, "job-a");
    expect(remainingA).toHaveLength(2);

    const remainingB = await getRecentJobRuns(50, "job-b");
    expect(remainingB).toHaveLength(2);
  });

  it("pruneOldLogs cascades log cleanup for deleted runs", async () => {
    const db = _rawDb();
    // Insert an old run with logs
    await db.run(`INSERT INTO job_runs (run_id, job_name, status, started_at) VALUES ('old-run', 'job-a', 'completed', '${ago(2592000000)}')`);
    insertJobLog("old-run", "info", "Old log entry");

    // Insert a recent run with logs
    await insertJobRun("recent-run", "job-a");
    insertJobLog("recent-run", "info", "Recent log entry");
    await flushJobLogs();

    // Prune with keepPerJob=1 (keep only the most recent run per job)
    await pruneOldLogs(7, 1);

    // Old run's logs should be gone
    const oldLogs = await getJobRunLogs("old-run");
    expect(oldLogs).toHaveLength(0);

    // Recent run's logs should remain
    const recentLogs = await getJobRunLogs("recent-run");
    expect(recentLogs).toHaveLength(1);
  });

  it("pruneOldLogs without keepPerJob arg defaults to 20", async () => {
    const db = _rawDb();
    // Insert 25 old runs for the same job
    for (let i = 1; i <= 25; i++) {
      await db.run(`INSERT INTO job_runs (run_id, job_name, status, started_at) VALUES (?, ?, 'completed', ?)`, [`old-${i}`, "job-a", ago(30 * 86_400_000 - i * 60_000)]);
    }

    // Prune with default keepPerJob (20)
    const pruned = await pruneOldLogs(7);
    expect(pruned).toBe(5); // 25 - 20 = 5

    const remaining = await getRecentJobRuns(50, "job-a");
    expect(remaining).toHaveLength(20);
  });

  it("getJobRunLogsSince returns only logs after the given ID", async () => {
    await insertJobRun("run-1", "test-job");
    insertJobLog("run-1", "info", "First");
    insertJobLog("run-1", "warn", "Second");
    insertJobLog("run-1", "error", "Third");

    const allLogs = await getJobRunLogs("run-1");
    const firstId = allLogs[0].id;

    const since = await getJobRunLogsSince("run-1", firstId);
    expect(since).toHaveLength(2);
    expect(since[0].message).toBe("Second");
    expect(since[1].message).toBe("Third");

    const sinceAll = await getJobRunLogsSince("run-1", 0);
    expect(sinceAll).toHaveLength(3);

    const sinceEnd = await getJobRunLogsSince("run-1", allLogs[2].id);
    expect(sinceEnd).toHaveLength(0);
  });

  it("getLatestRunIdsByJob returns latest run per job", async () => {
    await insertJobRun("run-1", "job-a");
    await insertJobRun("run-2", "job-a");
    await insertJobRun("run-3", "job-b");
    await completeJobRun("run-1", "completed");
    await completeJobRun("run-2", "failed");

    const latest = await getLatestRunIdsByJob();
    expect(latest.get("job-a")).toEqual(expect.objectContaining({ runId: "run-2", status: "failed" }));
    expect(latest.get("job-a")).toHaveProperty("startedAt");
    expect(latest.get("job-a")).toHaveProperty("completedAt");
    expect(latest.get("job-b")).toEqual(expect.objectContaining({ runId: "run-3", status: "running" }));
    expect(latest.get("job-b")!.completedAt).toBeNull();
  });
});

describe("pruneTasks", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("deletes old terminal rows, keeps recent ones", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at) VALUES ('issue-worker','org/repo',1,'completed','${ago(10368000000)}','${ago(10368000000)}')`);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at) VALUES ('issue-worker','org/repo',2,'failed','${ago(0)}','${ago(0)}')`);

    expect(await pruneTasks(90)).toBe(1);

    const { c } = await db.get("SELECT COUNT(*) AS c FROM tasks") as { c: number };
    expect(c).toBe(1);
  });

  it("never deletes running rows", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES ('issue-worker','org/repo',1,'running','${ago(17280000000)}')`);

    expect(await pruneTasks(90)).toBe(0);
    expect(await getOrphanedTasks()).toHaveLength(1);
  });

  it("keeps rows whose run still exists", async () => {
    const db = _rawDb();
    await insertJobRun("run-keep", "job-a");
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at, run_id) VALUES ('issue-worker','org/repo',1,'completed','${ago(17280000000)}','${ago(17280000000)}','run-keep')`);

    expect(await pruneTasks(90)).toBe(0);

    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at, run_id) VALUES ('issue-worker','org/repo',2,'completed','${ago(17280000000)}','${ago(17280000000)}','run-gone')`);

    expect(await pruneTasks(90)).toBe(1);
  });

  it("returns 0 when nothing to prune", async () => {
    const id = await recordTaskStart("issue-worker", "org/repo", 1, null);
    await recordTaskComplete(id);
    expect(await pruneTasks(90)).toBe(0);
  });
});

describe("getRecentWorkItems", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("returns recent items ordered by most recent first", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', '${ago(10800000)}')`, ["issue-worker", "org/repo", 10]);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', '${ago(3600000)}')`, ["issue-worker", "org/repo", 20]);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', '${ago(7200000)}')`, ["issue-worker", "org/repo", 30]);

    const items = await getRecentWorkItems();
    expect(items).toHaveLength(3);
    expect(items[0].item_number).toBe(20);
    expect(items[1].item_number).toBe(30);
    expect(items[2].item_number).toBe(10);
  });

  it("deduplicates same issue worked on multiple times", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', '${ago(7200000)}')`, ["issue-worker", "org/repo", 42]);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', '${ago(3600000)}')`, ["issue-worker", "org/repo", 42]);

    const items = await getRecentWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0].item_number).toBe(42);
  });

  it("excludes item_number = 0", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', '${ago(0)}')`, ["doc-maintainer", "org/repo", 0]);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', '${ago(0)}')`, ["issue-worker", "org/repo", 5]);

    const items = await getRecentWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0].item_number).toBe(5);
  });

  it("respects the limit parameter", async () => {
    const db = _rawDb();
    for (let i = 1; i <= 5; i++) {
      await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', ?)`, ["issue-worker", "org/repo", i, ago(i * 3_600_000)]);
    }

    const items = await getRecentWorkItems(3);
    expect(items).toHaveLength(3);
  });

  it("returns empty array when no tasks exist", async () => {
    const items = await getRecentWorkItems();
    expect(items).toHaveLength(0);
  });
});

describe("getAllAverageTaskDurations", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("returns empty object when no completed tasks exist", async () => {
    expect(await getAllAverageTaskDurations()).toEqual({});
  });

  it("returns averages grouped by job name prefix in a single query", async () => {
    const db = _rawDb();
    // Insert tasks for two different job types
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '${ago(1500000)}', '${ago(900000)}')`, ["issue-worker", "org/repo", 1]);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '${ago(1200000)}', '${ago(600000)}')`, ["ci-fixer:merge-conflict", "org/repo", 2]);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '${ago(1800000)}', '${ago(600000)}')`, ["ci-fixer:revert", "org/repo", 3]);

    const result = await getAllAverageTaskDurations();
    expect(result["issue-worker"]).toBeGreaterThan(500_000);
    expect(result["issue-worker"]).toBeLessThan(700_000);
    // ci-fixer prefix groups both variants: avg of 10min and 20min = 15min
    expect(result["ci-fixer"]).toBeGreaterThan(800_000);
    expect(result["ci-fixer"]).toBeLessThan(1_000_000);
  });

  it("ignores running and failed tasks", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at)
       VALUES (?, ?, ?, 'running', '${ago(600000)}')`, ["issue-worker", "org/repo", 1]);
    await db.run(`INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'err', '${ago(600000)}', '${ago(300000)}')`, ["issue-worker", "org/repo", 2]);

    expect(await getAllAverageTaskDurations()).toEqual({});
  });
});

describe("work_queue helpers", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("enqueueWork inserts a row and returns its id", async () => {
    const r = await enqueueWork("ci-fixer", "org/repo", 42, { priority: true });
    expect(r).not.toBeNull();
    expect(r!.alreadyQueued).toBe(false);
    expect(typeof r!.id).toBe("number");
    expect(await listQueuedWork()).toHaveLength(1);
  });

  it("enqueueWork dedups same (kind, repo, item_number) when row is queued", async () => {
    const first = await enqueueWork("ci-fixer", "org/repo", 42);
    const second = await enqueueWork("ci-fixer", "org/repo", 42);
    expect(first!.id).toBe(second!.id);
    expect(second!.alreadyQueued).toBe(true);
    expect(await listQueuedWork()).toHaveLength(1);
  });

  it("enqueueWork allows different kinds on same repo+item", async () => {
    expect(await enqueueWork("ci-fixer", "org/repo", 42)).not.toBeNull();
    expect(await enqueueWork("review-addresser", "org/repo", 42)).not.toBeNull();
    expect(await listQueuedWork()).toHaveLength(2);
  });

  it("claimNextWork picks priority rows first, then by id", async () => {
    await enqueueWork("ci-fixer", "org/repo", 1);
    await enqueueWork("ci-fixer", "org/repo", 2, { priority: true });
    await enqueueWork("ci-fixer", "org/repo", 3);

    const claimed = await claimNextWork(null);
    expect(claimed).not.toBeNull();
    expect(claimed!.item_number).toBe(2);
    expect(claimed!.status).toBe("running");
    expect(claimed!.pid).toBe(process.pid);
    expect(claimed!.attempts).toBe(1);
  });

  it("claimNextWork returns null when no queued rows", async () => {
    expect(await claimNextWork(null)).toBeNull();
  });

  it("markWorkSucceeded transitions to completed", async () => {
    const r = (await enqueueWork("ci-fixer", "org/repo", 1))!;
    await claimNextWork(null);
    await markWorkSucceeded(r.id);
    expect((await countWorkByStatus())["completed"]).toBe(1);
  });

  it("markWorkFailed transitions to failed with error_message", async () => {
    const r = (await enqueueWork("ci-fixer", "org/repo", 1))!;
    await claimNextWork(null);
    await markWorkFailed(r.id, "boom");
    const counts = await countWorkByStatus();
    expect(counts["failed"]).toBe(1);
  });

  it("markWorkCancelled transitions to cancelled and frees the item for re-enqueue", async () => {
    const r = (await enqueueWork("issue-refiner:plan", "org/repo", 1))!;
    await claimNextWork(null);
    await markWorkCancelled(r.id, "run cancelled");
    expect((await countWorkByStatus())["cancelled"]).toBe(1);
    expect(await listQueuedWork()).toHaveLength(0);

    const again = await enqueueWork("issue-refiner:plan", "org/repo", 1);
    expect(again!.alreadyQueued).toBe(false);
  });

  it("recoverWorkOnStartup resets running rows from other pids", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, pid, started_at) VALUES (?, ?, ?, '{}', 0, 'running', ?, '${ago(0)}')`, ["ci-fixer", "org/repo", 99, 999999]);
    const r = await recoverWorkOnStartup();
    expect(r.resetRunning).toBe(1);
    const rows = await listQueuedWork();
    expect(rows[0].status).toBe("queued");
    expect(rows[0].pid).toBeNull();
  });

  it("pruneWorkQueue removes old completed/failed rows", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, completed_at) VALUES ('ci-fixer', 'org/repo', 1, '{}', 0, 'completed', '${ago(2592000000)}')`);
    await db.run(`INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, completed_at) VALUES ('ci-fixer', 'org/repo', 2, '{}', 0, 'completed', '${ago(0)}')`);
    const removed = await pruneWorkQueue(168);
    expect(removed).toBe(1);
  });

  it("hasActiveWorkForPR returns true only for running rows of given kinds", async () => {
    await enqueueWork("ci-fixer", "org/repo", 42);
    expect(await hasActiveWorkForPR("org/repo", 42, ["ci-fixer"])).toBe(false);
    await claimNextWork(null);
    expect(await hasActiveWorkForPR("org/repo", 42, ["ci-fixer"])).toBe(true);
    expect(await hasActiveWorkForPR("org/repo", 42, ["pr-reviewer"])).toBe(false);
  });

  it("clearAllWorkQueueForTests empties the table", async () => {
    await enqueueWork("ci-fixer", "org/repo", 1);
    await enqueueWork("ci-fixer", "org/repo", 2);
    expect(await listQueuedWork()).toHaveLength(2);
    await clearAllWorkQueueForTests();
    expect(await listQueuedWork()).toHaveLength(0);
  });
});

describe("markUntrustedActorNotified", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("returns true on first call for a repo/issue pair", async () => {
    expect(await markUntrustedActorNotified("o/r", 354)).toBe(true);
  });

  it("returns false on a duplicate call for the same repo/issue pair", async () => {
    await markUntrustedActorNotified("o/r", 354);
    expect(await markUntrustedActorNotified("o/r", 354)).toBe(false);
  });

  it("returns true for a different issue number in the same repo", async () => {
    await markUntrustedActorNotified("o/r", 354);
    expect(await markUntrustedActorNotified("o/r", 355)).toBe(true);
  });

  it("returns true for the same issue number in a different repo", async () => {
    await markUntrustedActorNotified("o/r", 354);
    expect(await markUntrustedActorNotified("o/r2", 354)).toBe(true);
  });
});

describe("doc-maintainer intent backfill watermark", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("returns null before the walk has started", async () => {
    expect(await getIntentBackfillState("o/r")).toBeNull();
  });

  it("round-trips a chunk watermark", async () => {
    await recordIntentBackfillChunk("o/r", "2026-01-15", false, false, 2);
    expect(await getIntentBackfillState("o/r")).toEqual({ oldestScanned: "2026-01-15", complete: false, windowExhausted: false, sourceVersion: 2 });
  });

  it("upserts an existing repo row as the walk advances", async () => {
    await recordIntentBackfillChunk("o/r", "2026-01-15", false, false, 2);
    await recordIntentBackfillChunk("o/r", "2025-08-02", true, false, 2);
    expect(await getIntentBackfillState("o/r")).toEqual({ oldestScanned: "2025-08-02", complete: true, windowExhausted: false, sourceVersion: 2 });
  });

  it("tracks repos independently", async () => {
    await recordIntentBackfillChunk("o/r", "2026-01-15", true, false, 2);
    expect(await getIntentBackfillState("o/r2")).toBeNull();
  });

  it("accepts a null oldestScanned for a repo with no history", async () => {
    await recordIntentBackfillChunk("o/r", null, true, false, 2);
    expect(await getIntentBackfillState("o/r")).toEqual({ oldestScanned: null, complete: true, windowExhausted: false, sourceVersion: 2 });
  });

  it("records windowExhausted as a terminal state distinct from complete", async () => {
    await recordIntentBackfillChunk("o/r", "2025-08-02", false, true, 2);
    expect(await getIntentBackfillState("o/r")).toEqual({ oldestScanned: "2025-08-02", complete: false, windowExhausted: true, sourceVersion: 2 });
  });

  it("reports sourceVersion 0 for a row written before the column existed", async () => {
    // Simulate a pre-migration row: insert without the source_version column so the
    // DEFAULT 0 applies, exactly as an existing row gets it on ALTER TABLE.
    await _rawDb().run(`INSERT INTO doc_intent_backfill (repo, oldest_scanned, complete, window_exhausted) VALUES (?, ?, 0, 0)`, ["o/legacy", "2025-01-01"]);
    expect(await getIntentBackfillState("o/legacy")).toEqual({
      oldestScanned: "2025-01-01", complete: false, windowExhausted: false, sourceVersion: 0,
    });
  });
});

describe("doc-maintainer memory digest", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("returns null before any digest has been recorded", async () => {
    expect(await getDocMemoryDigest("o/r")).toBeNull();
  });

  it("round-trips a digest", async () => {
    await recordDocMemoryDigest("o/r", "abc123");
    expect(await getDocMemoryDigest("o/r")).toBe("abc123");
  });

  it("upserts on repeated writes", async () => {
    await recordDocMemoryDigest("o/r", "abc123");
    await recordDocMemoryDigest("o/r", "def456");
    expect(await getDocMemoryDigest("o/r")).toBe("def456");
  });

  it("writing a digest for a repo with an existing backfill watermark leaves it unchanged", async () => {
    await recordIntentBackfillChunk("o/r", "2026-01-15", true, false, 2);
    await recordDocMemoryDigest("o/r", "abc123");
    expect(await getIntentBackfillState("o/r")).toEqual({ oldestScanned: "2026-01-15", complete: true, windowExhausted: false, sourceVersion: 2 });
    expect(await getDocMemoryDigest("o/r")).toBe("abc123");
  });

  it("recording a backfill chunk for a repo with an existing digest leaves it unchanged", async () => {
    await recordDocMemoryDigest("o/r", "abc123");
    await recordIntentBackfillChunk("o/r", "2026-01-15", true, false, 2);
    expect(await getDocMemoryDigest("o/r")).toBe("abc123");
  });
});

describe("queue snapshots", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("recordQueueSnapshot and getQueueSnapshots round-trip", async () => {
    await recordQueueSnapshot(5);
    await recordQueueSnapshot(10);

    const snapshots = await getQueueSnapshots(24);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].totalItems).toBe(5);
    expect(snapshots[1].totalItems).toBe(10);
  });

  it("getQueueSnapshots returns empty when no snapshots exist", async () => {
    expect(await getQueueSnapshots()).toHaveLength(0);
  });

  it("pruneQueueSnapshots removes old entries", async () => {
    const db = _rawDb();
    // Insert an old snapshot (5 days ago)
    await db.run(`INSERT INTO queue_snapshots (total_items, recorded_at) VALUES (?, '${ago(432000000)}')`, [42]);
    // Insert a recent snapshot
    await recordQueueSnapshot(7);

    // Prune snapshots older than 72 hours
    const pruned = await pruneQueueSnapshots(72);
    expect(pruned).toBe(1);

    const remaining = await getQueueSnapshots(200);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].totalItems).toBe(7);
  });

  it("pruneQueueSnapshots returns 0 when nothing to prune", async () => {
    await recordQueueSnapshot(5);
    expect(await pruneQueueSnapshots(72)).toBe(0);
  });
});

// ── Helper ──

function makeRun(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    run_id: 1,
    repo: "org/repo",
    workflow_name: "CI",
    status: "completed",
    conclusion: "success",
    event: "push",
    head_branch: "main",
    created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    run_started_at: new Date(Date.now() - 59 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 58 * 60 * 1000).toISOString(),
    head_sha: "abc123",
    html_url: "https://example.invalid/run/1",
    run_attempt: 1,
    ...overrides,
  };
}

describe("workflow runs", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("upsertWorkflowRuns inserts rows and getWorkflowRunCount returns correct count", async () => {
    expect(await getWorkflowRunCount()).toBe(0);
    await upsertWorkflowRuns([makeRun({ run_id: 1 }), makeRun({ run_id: 2 })]);
    expect(await getWorkflowRunCount()).toBe(2);
  });

  it("upsertWorkflowRuns is a no-op for empty array", async () => {
    await upsertWorkflowRuns([]);
    expect(await getWorkflowRunCount()).toBe(0);
  });

  it("upsertWorkflowRuns replaces existing row on conflict", async () => {
    await upsertWorkflowRuns([makeRun({ run_id: 1, status: "in_progress" })]);
    await upsertWorkflowRuns([makeRun({ run_id: 1, status: "completed", conclusion: "success" })]);
    expect(await getWorkflowRunCount()).toBe(1);
    const active = await getActiveWorkflowRuns();
    // Should no longer be active after status updated to completed
    expect(active).toHaveLength(0);
  });

  it("getActiveWorkflowRuns returns queued and in_progress runs only", async () => {
    await upsertWorkflowRuns([
      makeRun({ run_id: 1, status: "queued", conclusion: null }),
      makeRun({ run_id: 2, status: "in_progress", conclusion: null }),
      makeRun({ run_id: 3, status: "completed", conclusion: "success" }),
    ]);
    const active = await getActiveWorkflowRuns();
    expect(active).toHaveLength(2);
    expect(active.map(r => r.status)).toEqual(expect.arrayContaining(["queued", "in_progress"]));
  });

  it("getWorkflowRunStats returns repo stats aggregated over given days", async () => {
    const now = Date.now();
    await upsertWorkflowRuns([
      makeRun({
        run_id: 1,
        repo: "org/alpha",
        status: "completed",
        conclusion: "success",
        created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        run_started_at: new Date(now - 2 * 60 * 60 * 1000 + 30_000).toISOString(),
        updated_at: new Date(now - 2 * 60 * 60 * 1000 + 90_000).toISOString(),
      }),
      makeRun({
        run_id: 2,
        repo: "org/alpha",
        status: "in_progress",
        conclusion: null,
        created_at: new Date(now - 60 * 60 * 1000).toISOString(),
        run_started_at: new Date(now - 60 * 60 * 1000 + 10_000).toISOString(),
        updated_at: new Date(now - 60 * 60 * 1000 + 10_000).toISOString(),
      }),
    ]);

    const stats = await getWorkflowRunStats(7);
    expect(stats.repoStats).toHaveLength(1);
    const alpha = stats.repoStats[0];
    expect(alpha.repo).toBe("org/alpha");
    expect(alpha.total).toBe(2);
    expect(alpha.inProgress).toBe(1);
    expect(alpha.queued).toBe(0);
    expect(alpha.avgQueueWaitS).toBeGreaterThanOrEqual(0);
  });

  it("getWorkflowRunStats returns workflow stats aggregated over given days", async () => {
    const now = Date.now();
    await upsertWorkflowRuns([
      makeRun({ run_id: 1, workflow_name: "CI", created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(), updated_at: new Date(now - 1 * 60 * 60 * 1000).toISOString() }),
      makeRun({ run_id: 2, workflow_name: "CI", created_at: new Date(now - 1 * 60 * 60 * 1000).toISOString(), updated_at: new Date(now - 30 * 60 * 1000).toISOString() }),
      makeRun({ run_id: 3, workflow_name: "Deploy", created_at: new Date(now - 3 * 60 * 60 * 1000).toISOString(), updated_at: new Date(now - 2 * 60 * 60 * 1000).toISOString() }),
    ]);

    const stats = await getWorkflowRunStats(7);
    expect(stats.workflowStats.length).toBeGreaterThanOrEqual(2);
    const ci = stats.workflowStats.find(w => w.workflowName === "CI");
    expect(ci).toBeDefined();
    expect(ci!.total).toBe(2);
    const deploy = stats.workflowStats.find(w => w.workflowName === "Deploy");
    expect(deploy).toBeDefined();
    expect(deploy!.total).toBe(1);
  });

  it("getWorkflowRunStats groups workflow stats by (repo, workflow_name) so same-named workflows in different repos are distinct", async () => {
    const now = Date.now();
    await upsertWorkflowRuns([
      makeRun({ run_id: 10, repo: "org/alpha", workflow_name: "CI", created_at: new Date(now - 60 * 60 * 1000).toISOString(), updated_at: new Date(now - 59 * 60 * 1000).toISOString() }),
      makeRun({ run_id: 11, repo: "org/alpha", workflow_name: "CI", created_at: new Date(now - 50 * 60 * 1000).toISOString(), updated_at: new Date(now - 49 * 60 * 1000).toISOString() }),
      makeRun({ run_id: 12, repo: "org/beta",  workflow_name: "CI", created_at: new Date(now - 40 * 60 * 1000).toISOString(), updated_at: new Date(now - 39 * 60 * 1000).toISOString() }),
    ]);

    const stats = await getWorkflowRunStats(7);
    const alphaCI = stats.workflowStats.find(w => w.repo === "org/alpha" && w.workflowName === "CI");
    const betaCI  = stats.workflowStats.find(w => w.repo === "org/beta"  && w.workflowName === "CI");
    expect(alphaCI).toBeDefined();
    expect(betaCI).toBeDefined();
    expect(alphaCI!.total).toBe(2);
    expect(betaCI!.total).toBe(1);
  });

  it("getWorkflowRunStats excludes runs older than the given days", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO workflow_runs (run_id, repo, workflow_name, status, conclusion, event, head_branch, created_at, run_started_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '${ago(864000000)}', NULL, '${ago(864000000)}', '${ago(0)}')`, [99, "org/old", "CI", "completed", "success", "push", "main"]);

    const stats = await getWorkflowRunStats(7);
    const old = stats.repoStats.find(r => r.repo === "org/old");
    expect(old).toBeUndefined();
  });

  it("getWorkflowRunStats excludes ISO 8601 rows inserted via upsertWorkflowRuns older than the given days", async () => {
    await upsertWorkflowRuns([makeRun({ run_id: 99, repo: "org/old-iso", created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() })]);
    const stats = await getWorkflowRunStats(7);
    const old = stats.repoStats.find(r => r.repo === "org/old-iso");
    expect(old).toBeUndefined();
  });

  it("pruneWorkflowRuns removes old entries", async () => {
    const db = _rawDb();
    // Insert an old run (35 days ago)
    await db.run(`INSERT INTO workflow_runs (run_id, repo, workflow_name, status, conclusion, event, head_branch, created_at, run_started_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '${ago(3024000000)}', NULL, '${ago(3024000000)}', '${ago(0)}')`, [100, "org/repo", "CI", "completed", "success", "push", "main"]);
    // Insert a recent run
    await upsertWorkflowRuns([makeRun({ run_id: 101 })]);
    expect(await getWorkflowRunCount()).toBe(2);

    const pruned = await pruneWorkflowRuns(30);
    expect(pruned).toBe(1);
    expect(await getWorkflowRunCount()).toBe(1);
  });

  it("pruneWorkflowRuns prunes ISO 8601 rows inserted via upsertWorkflowRuns", async () => {
    await upsertWorkflowRuns([makeRun({ run_id: 100, created_at: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString() })]);
    await upsertWorkflowRuns([makeRun({ run_id: 101 })]);
    expect(await getWorkflowRunCount()).toBe(2);
    expect(await pruneWorkflowRuns(30)).toBe(1);
    expect(await getWorkflowRunCount()).toBe(1);
  });

  it("pruneWorkflowRuns returns 0 when nothing to prune", async () => {
    await upsertWorkflowRuns([makeRun({ run_id: 1 })]);
    expect(await pruneWorkflowRuns(30)).toBe(0);
  });

  describe("Circuit Breaker Functions", () => {
    beforeEach(async () => {
      // Reset database before each test
      await initDb();
    });

    afterEach(async () => {
      await closeDb();
    });

    describe("ci_fixer_breaker state", () => {
      it("returns undefined for a PR the breaker never tripped on", async () => {
        expect(await getCIFixerBreakerState("test/repo", 1)).toBeUndefined();
      });

      it("round-trips a trip and a Claws push without clobbering each other", async () => {
        await recordCIFixerBreakerTrip("test/repo", 2, "aaa");
        await recordCIFixerPush("test/repo", 2, "bbb");

        const state = await getCIFixerBreakerState("test/repo", 2);
        expect(state?.trippedSha).toBe("aaa");
        expect(state?.trippedAt).toBeTruthy();
        expect(state?.lastClawsSha).toBe("bbb");
        expect(state?.grants).toBe(0);
      });

      it("re-tripping preserves grants and the budget floor", async () => {
        await recordCIFixerBreakerTrip("test/repo", 3, "aaa");
        await recordCIFixerBreakerGrant("test/repo", 3, { recovered: false });
        const floor = (await getCIFixerBreakerState("test/repo", 3))?.budgetFloorAt;

        await recordCIFixerBreakerTrip("test/repo", 3, "ccc");

        const state = await getCIFixerBreakerState("test/repo", 3);
        expect(state?.trippedSha).toBe("ccc");
        expect(state?.grants).toBe(1);
        expect(state?.budgetFloorAt).toBe(floor);
      });

      it("spends a grant on a failing head and resets the count on a green one", async () => {
        await recordCIFixerBreakerTrip("test/repo", 4, "aaa");
        await recordCIFixerBreakerGrant("test/repo", 4, { recovered: false });
        await recordCIFixerBreakerGrant("test/repo", 4, { recovered: false });
        expect((await getCIFixerBreakerState("test/repo", 4))?.grants).toBe(2);

        await recordCIFixerBreakerGrant("test/repo", 4, { recovered: true });
        const state = await getCIFixerBreakerState("test/repo", 4);
        expect(state?.grants).toBe(0);
        expect(state?.trippedSha).toBeNull();
        expect(state?.budgetFloorAt).toBeTruthy();
      });

      it("resetCIFixerBreakerGrants clears the trip and grants, keeping the Claws SHA", async () => {
        await recordCIFixerBreakerTrip("test/repo", 5, "aaa");
        await recordCIFixerPush("test/repo", 5, "bbb");
        await recordCIFixerBreakerGrant("test/repo", 5, { recovered: false });

        await resetCIFixerBreakerGrants("test/repo", 5);

        const state = await getCIFixerBreakerState("test/repo", 5);
        expect(state?.trippedSha).toBeNull();
        expect(state?.trippedAt).toBeNull();
        expect(state?.grants).toBe(0);
        expect(state?.budgetFloorAt).toBeTruthy();
        expect(state?.lastClawsSha).toBe("bbb");
      });

      it("resets cleanly for a PR with no prior row", async () => {
        await resetCIFixerBreakerGrants("test/repo", 6);
        expect((await getCIFixerBreakerState("test/repo", 6))?.grants).toBe(0);
      });
    });

    describe("countCIFixerAttempts", () => {
      it("counts attempts within time window", async () => {
        const repo = "test/repo";
        const prNumber = 123;
        
        // Insert tasks at different times
        const now = Date.now();
        const db = _rawDb();
        
        // Within window (last 24 hours)
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "completed", new Date(now - 2 * 60 * 60 * 1000).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "failed", new Date(now - 5 * 60 * 60 * 1000).toISOString()]);
        
        // Outside window (more than 24 hours ago)
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "completed", new Date(now - 30 * 60 * 60 * 1000).toISOString()]);
        
        const result = await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(2);
        expect(result.successful).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.preWorkFailed).toBe(0);
      });

      it("correctly matches ci-fixer job name patterns", async () => {
        const repo = "test/repo";
        const prNumber = 456;
        const db = _rawDb();
        const now = Date.now();
        
        // Should match
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "completed", new Date(now).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:variant", repo, prNumber, null, null, "failed", new Date(now).toISOString()]);
        
        // Should NOT match
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer-v2", repo, prNumber, null, null, "completed", new Date(now).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["other-job", repo, prNumber, null, null, "completed", new Date(now).toISOString()]);
        
        const result = await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(2);
        expect(result.successful).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.preWorkFailed).toBe(0);
      });

      it("honours a budget floor newer than the window cutoff", async () => {
        const repo = "test/repo";
        const prNumber = 321;
        const db = _rawDb();
        const now = Date.now();

        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "failed", new Date(now - 10 * 60 * 60 * 1000).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "failed", new Date(now - 1 * 60 * 60 * 1000).toISOString()]);

        const floor = new Date(now - 2 * 60 * 60 * 1000).toISOString();
        expect((await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000, floor)).total).toBe(1);

        // A floor older than the window cutoff must not widen the window.
        const oldFloor = new Date(now - 48 * 60 * 60 * 1000).toISOString();
        expect((await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000, oldFloor)).total).toBe(2);
        expect((await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000, null)).total).toBe(2);
      });

      it("returns zero counts for PR with no attempts", async () => {
        const result = await countCIFixerAttempts("test/repo", 999, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(0);
        expect(result.successful).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.preWorkFailed).toBe(0);
      });

      it("counts pre-work failures separately and excludes them from nonTransientFailed", async () => {
        const repo = "test/repo";
        const prNumber = 777;
        const db = _rawDb();
        const now = Date.now();

        // A regular failure (no outcome JSON)
        const id1 = await recordTaskStart("ci-fixer", repo, prNumber, null);
        await db.run(`UPDATE tasks SET started_at = ?, status = 'failed' WHERE id = ?`, [new Date(now - 1 * 60 * 60 * 1000).toISOString(), id1]);

        // A transient-api failure (outcome JSON with failureCategory)
        const id2 = await recordTaskStart("ci-fixer", repo, prNumber, null);
        await db.run(`UPDATE tasks SET started_at = ? WHERE id = ?`, [new Date(now - 2 * 60 * 60 * 1000).toISOString(), id2]);
        await recordTaskFailed(id2, "API Error: 500 Internal server error", { failureCategory: "transient-api" });

        // A rate-limit failure
        const id3 = await recordTaskStart("ci-fixer", repo, prNumber, null);
        await db.run(`UPDATE tasks SET started_at = ? WHERE id = ?`, [new Date(now - 3 * 60 * 60 * 1000).toISOString(), id3]);
        await recordTaskFailed(id3, "AllProvidersRateLimitedError", { failureCategory: "rate-limit" });

        // A usage-limit failure
        const id4 = await recordTaskStart("ci-fixer", repo, prNumber, null);
        await db.run(`UPDATE tasks SET started_at = ? WHERE id = ?`, [new Date(now - 4 * 60 * 60 * 1000).toISOString(), id4]);
        await recordTaskFailed(id4, "You've hit your session limit", { failureCategory: "usage-limit" });

        const result = await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(4);
        expect(result.failed).toBe(4);
        expect(result.successful).toBe(0);
        expect(result.preWorkFailed).toBe(3);
      });

      it("ignores ci-fixer:merge-conflict rows while still counting ci-fixer and ci-fixer:revert rows", async () => {
        const repo = "test/repo";
        const prNumber = 888;
        const db = _rawDb();
        const now = Date.now();

        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "completed", new Date(now).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:revert", repo, prNumber, null, null, "failed", new Date(now).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:merge-conflict", repo, prNumber, null, null, "failed", new Date(now).toISOString()]);

        const result = await countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(2);
        expect(result.successful).toBe(1);
        expect(result.failed).toBe(1);
      });
    });

    describe("countConflictResolutionAttempts", () => {
      it("counts only ci-fixer:merge-conflict rows for that repo/PR", async () => {
        const repo = "test/repo";
        const prNumber = 890;
        const db = _rawDb();
        const now = Date.now();

        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:merge-conflict", repo, prNumber, null, null, "failed", new Date(now).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "failed", new Date(now).toISOString()]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:merge-conflict", "other/repo", prNumber, null, null, "failed", new Date(now).toISOString()]);

        const result = await countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(1);
      });

      it("counts a completed row with commits in total but not unproductive; a no-commit completion and a failure both count as unproductive", async () => {
        const repo = "test/repo";
        const prNumber = 891;
        const db = _rawDb();

        const id1 = await recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        await recordTaskComplete(id1, { commits: 2 });

        const id2 = await recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        await recordTaskComplete(id2, { commits: 0 });

        const id3 = await recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        await recordTaskFailed(id3, "conflict resolution failed");

        const result = await countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(3);
        expect(result.unproductive).toBe(2);
      });

      it("excludes rows outside the window", async () => {
        const repo = "test/repo";
        const prNumber = 892;
        const db = _rawDb();
        const now = Date.now();

        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:merge-conflict", repo, prNumber, null, null, "failed", new Date(now - 30 * 60 * 60 * 1000).toISOString()]);

        const result = await countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(0);
        expect(result.unproductive).toBe(0);
      });

      it("provider-unavailable failures do not consume the budget", async () => {
        const repo = "test/repo";
        const prNumber = 893;

        const id1 = await recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        await recordTaskFailed(id1, "AllProvidersRateLimitedError", { failureCategory: "rate-limit" });

        const id2 = await recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        await recordTaskFailed(id2, "session limit hit", { failureCategory: "usage-limit" });

        const id3 = await recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        await recordTaskFailed(id3, "API Error: 500", { failureCategory: "transient-api" });

        const id4 = await recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        await recordTaskFailed(id4, "could not apply patch", { failureCategory: "git-conflict" });

        const result = await countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(4);
        expect(result.unproductive).toBe(1);
        expect(result.preWorkFailed).toBe(3);
      });

      it("a failed row with no outcome still counts as unproductive", async () => {
        const repo = "test/repo";
        const prNumber = 894;
        const db = _rawDb();
        const now = Date.now();

        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:merge-conflict", repo, prNumber, null, null, "failed", new Date(now).toISOString()]);

        const result = await countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.unproductive).toBe(1);
      });

      it("honours the provider backoff window", async () => {
        const repo = "test/repo";
        const prNumber = 895;
        const db = _rawDb();
        const now = Date.now();

        await db.run(
          `INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ["ci-fixer:merge-conflict", repo, prNumber, null, null, "failed", new Date(now - 2 * 60 * 1000).toISOString(), '{"failureCategory":"rate-limit"}'],
        );
        await db.run(
          `INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ["ci-fixer:merge-conflict", repo, prNumber, null, null, "failed", new Date(now - 60 * 60 * 1000).toISOString(), '{"failureCategory":"rate-limit"}'],
        );

        const withBackoff = await countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000, 15 * 60 * 1000);
        expect(withBackoff.preWorkFailed).toBe(2);
        expect(withBackoff.recentPreWorkFailed).toBe(1);

        const noBackoff = await countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000, 0);
        expect(noBackoff.recentPreWorkFailed).toBe(0);
      });
    });

    describe("getRecentCIFixerErrors", () => {
      it("returns recent errors in descending order", async () => {
        const repo = "test/repo";
        const prNumber = 789;
        const db = _rawDb();
        const now = Date.now();
        
        // Insert failed tasks with errors
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "failed", new Date(now - 3000).toISOString(), new Date(now - 2000).toISOString(), "Error 1"]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "failed", new Date(now - 2000).toISOString(), new Date(now - 1000).toISOString(), "Error 2"]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "failed", new Date(now - 1000).toISOString(), new Date(now).toISOString(), "Error 3"]);
        
        const errors = await getRecentCIFixerErrors(repo, prNumber, 5);
        
        expect(errors).toHaveLength(3);
        expect(errors[0].error).toBe("Error 3"); // Most recent
        expect(errors[1].error).toBe("Error 2");
        expect(errors[2].error).toBe("Error 1"); // Oldest
      });

      it("respects limit parameter", async () => {
        const repo = "test/repo";
        const prNumber = 321;
        const db = _rawDb();
        const now = Date.now();
        
        // Insert 5 errors
        for (let i = 1; i <= 5; i++) {
          await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "failed", new Date(now - i * 1000).toISOString(), new Date(now - i * 1000 + 500).toISOString(), `Error ${i}`]);
        }
        
        const errors = await getRecentCIFixerErrors(repo, prNumber, 3);
        
        expect(errors).toHaveLength(3);
      });

      it("only returns failed tasks with errors", async () => {
        const repo = "test/repo";
        const prNumber = 654;
        const db = _rawDb();
        const now = Date.now();
        
        // Failed with error - should be included
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "failed", new Date(now).toISOString(), new Date(now).toISOString(), "Valid error"]);
        
        // Failed without error - should be excluded
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "failed", new Date(now).toISOString(), new Date(now).toISOString(), null]);
        
        // Completed with error (shouldn't happen but test) - should be excluded
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "completed", new Date(now).toISOString(), new Date(now).toISOString(), "Should not appear"]);
        
        const errors = await getRecentCIFixerErrors(repo, prNumber, 5);
        
        expect(errors).toHaveLength(1);
        expect(errors[0].error).toBe("Valid error");
      });

      it("correctly matches ci-fixer job name patterns", async () => {
        const repo = "test/repo";
        const prNumber = 987;
        const db = _rawDb();
        const now = Date.now();
        
        // Should match
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer", repo, prNumber, null, null, "failed", new Date(now).toISOString(), new Date(now).toISOString(), "Error from ci-fixer"]);
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer:special", repo, prNumber, null, null, "failed", new Date(now).toISOString(), new Date(now).toISOString(), "Error from ci-fixer:special"]);
        
        // Should NOT match
        await db.run(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["ci-fixer-new", repo, prNumber, null, null, "failed", new Date(now).toISOString(), new Date(now).toISOString(), "Should not appear"]);
        
        const errors = await getRecentCIFixerErrors(repo, prNumber, 5);

        expect(errors).toHaveLength(2);
      });
    });
  });

  describe("trackTaskTokens", () => {
    /** The callback is synchronous and issues its writes without awaiting them,
     *  so let the microtask queue drain before reading the row back. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    async function getTokenRow(taskId: number) {
      await settle();
      return await _rawDb()
        .get(`SELECT tokens_used, cost_usd, provider_used FROM tasks WHERE id = ?`, [taskId]) as { tokens_used: number | null; cost_usd: number | null; provider_used: string | null };
    }

    it("single invocation writes tokens and cost to the task row", async () => {
      const taskId = await recordTaskStart("test-job", "org/repo", 1, null);
      const cb = trackTaskTokens(taskId);
      cb(100, 0.5);
      const row = await getTokenRow(taskId);
      expect(row.tokens_used).toBe(100);
      expect(row.cost_usd).toBe(0.5);
    });

    it("two invocations of the same callback accumulate the totals", async () => {
      const taskId = await recordTaskStart("test-job", "org/repo", 2, null);
      const cb = trackTaskTokens(taskId);
      cb(10, 1);
      cb(5, 0.5);
      const row = await getTokenRow(taskId);
      expect(row.tokens_used).toBe(15);
      expect(row.cost_usd).toBeCloseTo(1.5);
    });

    it("never invoking the callback leaves token/cost columns at their initial state", async () => {
      const taskId = await recordTaskStart("test-job", "org/repo", 3, null);
      trackTaskTokens(taskId); // returned callback intentionally not called
      const row = await getTokenRow(taskId);
      expect(row.tokens_used).toBeNull();
      expect(row.cost_usd).toBeNull();
    });

    it("records the reporting provider when supplied", async () => {
      const taskId = await recordTaskStart("test-job", "org/repo", 4, null);
      const cb = trackTaskTokens(taskId);
      cb(100, 0.5, "opencode");
      const row = await getTokenRow(taskId);
      expect(row.provider_used).toBe("opencode");
    });

    it("leaves provider_used null when no provider is supplied", async () => {
      const taskId = await recordTaskStart("test-job", "org/repo", 5, null);
      const cb = trackTaskTokens(taskId);
      cb(100, 0.5);
      const row = await getTokenRow(taskId);
      expect(row.provider_used).toBeNull();
    });

    it("last reporter wins when a task spans two backends", async () => {
      const taskId = await recordTaskStart("test-job", "org/repo", 6, null);
      const cb = trackTaskTokens(taskId);
      cb(10, 1, "claude");
      cb(5, 0.5, "opencode");
      const row = await getTokenRow(taskId);
      expect(row.provider_used).toBe("opencode");
      expect(row.tokens_used).toBe(15);
    });
  });

  describe("getUsageStats", () => {
    beforeEach(async () => {
      const t1 = await recordTaskStart("issue-worker", "org/repo-a", 1, null);
      await updateTaskTokenUsage(t1, 100, 1.0);
      await updateTaskProvider(t1, "opencode");
      await updateTaskModel(t1, "openrouter/z-ai/glm-5.3");
      await recordTaskComplete(t1, { commits: 2, prNumber: 10, prAction: "created", headSha: "sha-a" });
      await recordTaskEffectivenessEvent({ taskId: t1, source: "pr-review", sourceRepo: "org/repo-a", sourceNumber: 10, sourceSha: "sha-a", signal: "pr-review-clean", score: 1, details: { reviewerTaskId: 99 } });
      await recordTaskEffectivenessEvent({ taskId: t1, source: "pr-merge", sourceRepo: "org/repo-a", sourceNumber: 10, sourceSha: "sha-a", signal: "pr-merged", score: null, details: { mergedBy: "auto-merger" } });

      const t2 = await recordTaskStart("issue-worker", "org/repo-b", 2, null);
      await updateTaskTokenUsage(t2, 200, 2.0);
      await updateTaskProvider(t2, "claude");
      await updateTaskModel(t2, "sonnet");
      await recordTaskFailed(t2, "boom");

      const t3 = await recordTaskStart("ci-fixer:revert", "org/repo-a", 3, null);
      await updateTaskTokenUsage(t3, 50, 0.5);
      // no provider/model — historical row

      const t4 = await recordTaskStart("ci-fixer:retry", "org/repo-b", 4, null);
      await updateTaskTokenUsage(t4, 25, 0.25);
      await updateTaskProvider(t4, "codex");
      await updateTaskModel(t4, "gpt-5.1-codex");

      const t5 = await recordTaskStart("issue-worker", "org/repo-c", 5, null);
      await updateTaskProvider(t5, "codex");
      await updateTaskModel(t5, "gpt-5.1-codex");
      await recordTaskComplete(t5, { commits: 0, prNumber: 20, prAction: "updated", headSha: "sha-c" });
      await recordTaskEffectivenessEvent({ taskId: t5, source: "pr-review", sourceRepo: "org/repo-c", sourceNumber: 20, sourceSha: "sha-c", signal: "pr-review-blocking", score: -1, details: null });
    });

    it("unfiltered providerStats includes both attributed and unknown rows", async () => {
      const stats = await getUsageStats(7);
      expect(stats.providerStats).toContainEqual(
        expect.objectContaining({ provider: "opencode", model: "openrouter/z-ai/glm-5.3" }),
      );
      expect(stats.providerStats).toContainEqual(
        expect.objectContaining({ provider: "unknown", model: "unknown" }),
      );
    });

    it("filters by provider and narrows repoStats accordingly", async () => {
      const stats = await getUsageStats(7, { provider: "opencode" });
      expect(stats.providerStats).toHaveLength(1);
      expect(stats.providerStats[0]).toMatchObject({ provider: "opencode", model: "openrouter/z-ai/glm-5.3", changedCount: 1, prCreatedCount: 1, reviewClean: 1, mergedCount: 1, reviewScoreTotal: 1, reviewScoreCount: 1 });
      expect(stats.repoStats.map((r) => r.repo)).toEqual(["org/repo-a"]);
    });

    it("filters by repo and narrows jobStats accordingly", async () => {
      const stats = await getUsageStats(7, { repo: "org/repo-b" });
      const jobNames = stats.jobStats.map((j) => j.jobName).sort();
      expect(jobNames).toEqual(["ci-fixer", "issue-worker"]);
    });

    it("filters by job prefix and matches sub-jobs recorded with a colon suffix", async () => {
      const stats = await getUsageStats(7, { job: "ci-fixer" });
      expect(stats.jobStats).toHaveLength(1);
      expect(stats.jobStats[0]).toMatchObject({ jobName: "ci-fixer", taskCount: 2 });
    });

    it("getTotalUsage filters by unknown provider", async () => {
      const totals = await getTotalUsage(7, { provider: "unknown" });
      expect(totals.taskCount).toBe(1);
      expect(totals.totalTokens).toBe(50);
      expect(totals.totalCostUsd).toBeCloseTo(0.5);
    });

    it("getUsageFilterOptions returns distinct repos/jobs/providers/models including unknown", async () => {
      const options = await getUsageFilterOptions(7);
      expect(options.repos.sort()).toEqual(["org/repo-a", "org/repo-b", "org/repo-c"]);
      expect(options.jobs.sort()).toEqual(["ci-fixer", "issue-worker"]);
      expect(options.providers.sort()).toEqual(["claude", "codex", "opencode", "unknown"]);
      expect(options.models.sort()).toEqual(["gpt-5.1-codex", "openrouter/z-ai/glm-5.3", "sonnet", "unknown"]);
    });

    it("includes provider/model rows without token data", async () => {
      const stats = await getUsageStats(7, { repo: "org/repo-c" });
      expect(stats.providerStats).toHaveLength(1);
      expect(stats.providerStats[0]).toMatchObject({ provider: "codex", totalTokens: 0, reviewBlocking: 1, reviewScoreTotal: -1, reviewScoreCount: 1 });
    });

    it("returns recent effectiveness events with task attribution", async () => {
      const events = await getRecentEffectivenessEvents(7, { provider: "opencode" });
      expect(events).toEqual([
        expect.objectContaining({ jobName: "issue-worker", provider: "opencode", signal: "pr-merged", sourceNumber: 10 }),
        expect.objectContaining({ jobName: "issue-worker", provider: "opencode", signal: "pr-review-clean", sourceNumber: 10 }),
      ]);
    });
  });

  describe("task effectiveness events", () => {
    it("upserts by task, source, repo, number, and head SHA", async () => {
      const taskId = await recordTaskStart("issue-worker", "org/repo", 1, null);
      await recordTaskEffectivenessEvent({ taskId, source: "pr-review", sourceRepo: "org/repo", sourceNumber: 2, sourceSha: "abc", signal: "pr-review-blocking", score: -1, details: { iteration: 1 } });
      await recordTaskEffectivenessEvent({ taskId, source: "pr-review", sourceRepo: "org/repo", sourceNumber: 2, sourceSha: "abc", signal: "pr-review-clean", score: 1, details: { iteration: 2 } });
      const rows = await _rawDb().all(`SELECT * FROM task_effectiveness_events`) as Array<{ signal: string; score: number; details: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ signal: "pr-review-clean", score: 1 });
      expect(JSON.parse(rows[0].details)).toEqual({ iteration: 2 });
    });

    it("findLatestCompletedTaskForPrHead requires exact PR number and head SHA", async () => {
      const oldTask = await recordTaskStart("issue-worker", "org/repo", 1, null);
      await recordTaskComplete(oldTask, { commits: 1, prNumber: 2, prAction: "created", headSha: "old" });
      const newTask = await recordTaskStart("review-addresser", "org/repo", 2, null);
      await recordTaskComplete(newTask, { commits: 1, prNumber: 2, prAction: "updated", headSha: "new" });
      const legacyTask = await recordTaskStart("issue-worker", "org/repo", 3, null);
      await recordTaskComplete(legacyTask, { commits: 1, prNumber: 2, prAction: "updated" });

      await expect(findLatestCompletedTaskForPrHead("org/repo", 2, "new")).resolves.toMatchObject({ id: newTask });
      await expect(findLatestCompletedTaskForPrHead("org/repo", 2, "old")).resolves.toMatchObject({ id: oldTask });
      await expect(findLatestCompletedTaskForPrHead("org/repo", 2, "missing")).resolves.toBeNull();
    });
  });

  describe("dmarc reports", () => {
    const report = {
      orgName: "google.com",
      reportId: "1785249275027635048",
      reportEmail: "noreply-dmarc-support@google.com",
      domain: "bstjohn.net",
      dateBegin: "2026-08-31T00:00:00.000Z",
      dateEnd: "2026-08-31T23:59:59.000Z",
      policyP: "none",
      policySp: "none",
      policyAdkim: "s",
      policyAspf: "s",
      policyPct: 100,
      truncatedRows: 0,
      rows: [
        {
          sourceIp: "209.85.220.69",
          count: 1,
          disposition: "none",
          evalDkim: "pass",
          evalSpf: "pass",
          headerFrom: "bstjohn.net",
          envelopeFrom: "",
          envelopeTo: "",
          dkimResults: [{ domain: "bstjohn.net", selector: "google", result: "pass" }],
          spfResults: [{ domain: "bstjohn.net", scope: "mfrom", result: "pass" }],
          reasons: [],
          verdict: "aligned_pass" as const,
        },
      ],
    };

    async function rowCount(): Promise<number> {
      return ((await _rawDb().get(`SELECT COUNT(*) AS n FROM dmarc_rows`)) as { n: number }).n;
    }

    it("inserts once and ignores a duplicate re-forwarded report", async () => {
      expect(await insertDmarcReport(report, "<feedback/>", "2026-09-01T08:00:00.000Z")).toBe(true);
      expect(await rowCount()).toBe(1);

      expect(await insertDmarcReport(report, "<feedback/>", "2026-09-01T09:00:00.000Z")).toBe(false);
      expect(await rowCount()).toBe(1);
      expect(await hasDmarcReport("google.com", "1785249275027635048")).toBe(true);
    });

    it("keeps raw XML off the row queries but retrievable by report key", async () => {
      await insertDmarcReport(report, "<feedback>raw</feedback>", "2026-09-01T08:00:00.000Z");

      const latest = await getLatestDmarcReportForDomain("bstjohn.net");
      expect(latest?.report_id).toBe("1785249275027635048");
      expect(latest?.row_count).toBe(1);
      expect(latest).not.toHaveProperty("raw_xml");
      expect(await getDmarcReportXml("google.com", "1785249275027635048")).toBe("<feedback>raw</feedback>");
    });

    it("aggregates verdict counts and source IPs over a window", async () => {
      await insertDmarcReport(report, "<feedback/>", "2026-09-01T08:00:00.000Z");

      expect(await getDmarcVerdictCounts("2026-08-01T00:00:00.000Z")).toEqual([
        { domain: "bstjohn.net", verdict: "aligned_pass", n: 1 },
      ]);
      expect(await getDmarcSourceIps("2026-08-01T00:00:00.000Z")).toEqual([
        {
          source_ip: "209.85.220.69",
          verdict: "aligned_pass",
          domain: "bstjohn.net",
          messages: 1,
          last_seen: "2026-08-31T23:59:59.000Z",
        },
      ]);
      expect(await getDmarcVerdictCounts("2026-09-01T00:00:00.000Z")).toEqual([]);
    });

    it("getLatestDmarcReportsPerReporter returns the columns of the latest report per (domain, reporter)", async () => {
      await insertDmarcReport(report, "<feedback/>", "2026-09-01T08:00:00.000Z");
      const laterReport = {
        ...report,
        reportId: "1785249275027635049",
        dateBegin: "2026-09-05T00:00:00.000Z",
        dateEnd: "2026-09-05T23:59:59.000Z",
        rows: [report.rows[0], report.rows[0]],
      };
      await insertDmarcReport(laterReport, "<feedback/>", "2026-09-06T08:00:00.000Z");

      const latest = await getLatestDmarcReportsPerReporter();
      expect(latest).toHaveLength(1);
      expect(latest[0].report_id).toBe("1785249275027635049");
      expect(latest[0].row_count).toBe(2);
      expect(latest[0].date_begin).toBe("2026-09-05T00:00:00.000Z");
    });

    it("pruneDmarcReports removes reports and rows past the retention window", async () => {
      await insertDmarcReport(report, "<feedback/>", "2026-09-01T08:00:00.000Z");
      const oldReport = { ...report, reportId: "old-report-id" };
      await insertDmarcReport(oldReport, "<feedback/>", "2026-09-01T08:00:00.000Z");

      const db = _rawDb();
      await db.run(`UPDATE dmarc_reports SET received_at = '${ago(34560000000)}' WHERE report_id = ?`, ["old-report-id"]);
      await db.run(`UPDATE dmarc_rows SET received_at = '${ago(34560000000)}' WHERE report_id = ?`, ["old-report-id"]);

      expect(await pruneDmarcReports(365)).toBe(1);
      expect(await hasDmarcReport("google.com", "old-report-id")).toBe(false);
      expect(await hasDmarcReport("google.com", "1785249275027635048")).toBe(true);
      expect(await rowCount()).toBe(1);
      expect(await pruneDmarcReports(365)).toBe(0);
    });
  });

  describe("damp readings", () => {
    it("getRecentDampReadings returns rows newest-first", async () => {
      await upsertDampReading("Hall Closet", "Manifold", 12, "2026-06-01", "2026-06-01T09:00:00.000Z");
      await upsertDampReading("Hall Closet", "Manifold", 15, "2026-06-15", "2026-06-15T09:00:00.000Z");

      const rows = (await getRecentDampReadings()).filter((r) => r.point === "Manifold");
      expect(rows).toHaveLength(2);
      expect(rows[0].reading_date).toBe("2026-06-15");
      expect(rows[0].value).toBe(15);
      expect(rows[1].reading_date).toBe("2026-06-01");
      expect(rows[1].value).toBe(12);
    });

    it("getDampTrendRows orders the latest reading first per point", async () => {
      await upsertDampReading("Hall Closet", "Manifold", 12, "2026-06-01", "2026-06-01T09:00:00.000Z");
      await upsertDampReading("Hall Closet", "Manifold", 15, "2026-06-15", "2026-06-15T09:00:00.000Z");

      const rows = (await getDampTrendRows()).filter((r) => r.point === "Manifold");
      expect(rows).toHaveLength(2);
      expect(rows[0].value).toBe(15);
      expect(rows[1].value).toBe(12);
    });

    it("seeds a Hall Closet / utility reading of 0.5 on 2026-07-02 (issue #1824)", async () => {
      const seeded = (await getRecentDampReadings()).filter((r) => r.location === "Hall Closet" && r.point === "utility");
      expect(seeded).toHaveLength(1);
      expect(seeded[0].value).toBe(0.5);
      expect(seeded[0].reading_date).toBe("2026-07-02");
    });

    it("does not duplicate the Hall Closet / utility seed when the backfill guard runs again against a database that already has the row", async () => {
      // beforeEach's await initDb() has already seeded one row on this in-memory db.
      // Re-run the exact guard from db.ts's backfill against that *same*
      // database handle (not a fresh await initDb() call, which would open a brand
      // new isolated in-memory db and never exercise the guard against
      // pre-existing data) to prove COUNT(*) === 0 prevents a duplicate insert.
      const db = _rawDb();
      const countSql = `SELECT COUNT(*) AS n FROM damp_readings WHERE location = ? AND point = ?`;

      const before = await db.get(countSql, ["Hall Closet", "utility"]) as { n: number };
      expect(before.n).toBe(1);

      const dampSeed = await db.get(countSql, ["Hall Closet", "utility"]) as { n: number };
      if (dampSeed.n === 0) {
        await db.run(`INSERT INTO damp_readings (location, point, value, reading_date, recorded_at) VALUES (?, ?, ?, ?, ?)`, ["Hall Closet", "utility", 0.5, "2026-07-02", "2026-07-02T00:00:00.000Z"]);
      }

      const after = await db.get(countSql, ["Hall Closet", "utility"]) as { n: number };
      expect(after.n).toBe(1);
    });

    it("upsertDampReading updates the existing row for the same location/point/date", async () => {
      await upsertDampReading("Utility wall", "left", 1.2, "2026-07-01", "2026-07-01T09:00:00.000Z");
      let rows = (await getRecentDampReadings()).filter((r) => r.location === "Utility wall" && r.point === "left");
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe(1.2);

      await upsertDampReading("Utility wall", "left", 1.8, "2026-07-01", "2026-07-01T10:00:00.000Z");
      rows = (await getRecentDampReadings()).filter((r) => r.location === "Utility wall" && r.point === "left");
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe(1.8);
      expect(rows[0].recorded_at).toBe("2026-07-01T10:00:00.000Z");

      await upsertDampReading("Utility wall", "left", 2.1, "2026-07-02", "2026-07-02T09:00:00.000Z");
      rows = (await getRecentDampReadings()).filter((r) => r.location === "Utility wall" && r.point === "left");
      expect(rows).toHaveLength(2);
    });

    it("deleteDampReading removes only the row matching location/point/date", async () => {
      await upsertDampReading("Utility wall", "left", 1.2, "2026-07-01", "2026-07-01T09:00:00.000Z");
      await upsertDampReading("Utility wall", "left", 2.1, "2026-07-02", "2026-07-02T09:00:00.000Z");
      await upsertDampReading("Utility wall", "right", 1.5, "2026-07-01", "2026-07-01T09:00:00.000Z");

      await deleteDampReading("Utility wall", "left", "2026-07-01");

      const rows = (await getRecentDampReadings()).filter((r) => r.location === "Utility wall");
      expect(rows).toHaveLength(2);
      expect(rows.some((r) => r.point === "left" && r.reading_date === "2026-07-01")).toBe(false);
      expect(rows.some((r) => r.point === "left" && r.reading_date === "2026-07-02")).toBe(true);
      expect(rows.some((r) => r.point === "right" && r.reading_date === "2026-07-01")).toBe(true);
    });

    it("deleteDampReading is a no-op when no matching row exists", async () => {
      await expect(deleteDampReading("Nonexistent", "left", "2026-07-01")).resolves.toBeUndefined();
    });
  });

  describe("blog drafts", () => {
    it("upsertBlogDraft then getBlogDraft round-trips the draft as status 'draft'", async () => {
      await upsertBlogDraft(
        "org/repo",
        "src/content/blog/hello.md",
        "---\ntitle: Hello\n---\nbody",
        "abc123",
        "Hello",
        "2026-07-01T00:00:00.000Z",
      );

      const draft = await getBlogDraft("org/repo", "src/content/blog/hello.md");
      expect(draft).not.toBeNull();
      expect(draft?.content).toBe("---\ntitle: Hello\n---\nbody");
      expect(draft?.base_sha).toBe("abc123");
      expect(draft?.title).toBe("Hello");
      expect(draft?.status).toBe("draft");
      expect(draft?.pr_number).toBeNull();
      expect(draft?.pr_branch).toBeNull();
    });

    it("getBlogDraft returns null when no draft exists for the repo/path", async () => {
      expect(await getBlogDraft("org/repo", "src/content/blog/missing.md")).toBeNull();
    });

    it("re-editing a pushed draft resets its status back to 'draft'", async () => {
      await upsertBlogDraft("org/repo", "src/content/blog/hello.md", "v1", "sha1", "Hello", "2026-07-01T00:00:00.000Z");
      await setBlogDraftPushed("org/repo", "src/content/blog/hello.md", 42, "claws/blog-hello-1");

      let draft = await getBlogDraft("org/repo", "src/content/blog/hello.md");
      expect(draft?.status).toBe("pushed");
      expect(draft?.pr_number).toBe(42);
      expect(draft?.pr_branch).toBe("claws/blog-hello-1");

      await upsertBlogDraft("org/repo", "src/content/blog/hello.md", "v2", "sha2", "Hello", "2026-07-02T00:00:00.000Z");

      draft = await getBlogDraft("org/repo", "src/content/blog/hello.md");
      expect(draft?.status).toBe("draft");
      expect(draft?.content).toBe("v2");
      expect(draft?.base_sha).toBe("sha2");
      // pr_number / pr_branch columns are left untouched by the upsert's ON CONFLICT clause.
      expect(draft?.pr_number).toBe(42);
      expect(draft?.pr_branch).toBe("claws/blog-hello-1");
    });

    it("listBlogDrafts orders drafts newest-updated-first, scoped to the given repo", async () => {
      await upsertBlogDraft("org/repo", "src/content/blog/a.md", "a", null, "A", "2026-07-01T00:00:00.000Z");
      await upsertBlogDraft("org/repo", "src/content/blog/b.md", "b", null, "B", "2026-07-03T00:00:00.000Z");
      await upsertBlogDraft("org/repo", "src/content/blog/c.md", "c", null, "C", "2026-07-02T00:00:00.000Z");
      await upsertBlogDraft("org/other-repo", "src/content/blog/d.md", "d", null, "D", "2026-07-04T00:00:00.000Z");

      const drafts = await listBlogDrafts("org/repo");
      expect(drafts.map((d) => d.path)).toEqual([
        "src/content/blog/b.md",
        "src/content/blog/c.md",
        "src/content/blog/a.md",
      ]);
    });

    it("setBlogDraftPushed marks a draft pushed with its PR number and branch", async () => {
      await upsertBlogDraft("org/repo", "src/content/blog/hello.md", "v1", "sha1", "Hello", "2026-07-01T00:00:00.000Z");
      await setBlogDraftPushed("org/repo", "src/content/blog/hello.md", 99, "claws/blog-hello-2");

      const draft = await getBlogDraft("org/repo", "src/content/blog/hello.md");
      expect(draft?.status).toBe("pushed");
      expect(draft?.pr_number).toBe(99);
      expect(draft?.pr_branch).toBe("claws/blog-hello-2");
    });

    it("clearBlogDraftPR nulls the PR pointer and resets status to 'draft'", async () => {
      await upsertBlogDraft("org/repo", "src/content/blog/hello.md", "v1", "sha1", "Hello", "2026-07-01T00:00:00.000Z");
      await setBlogDraftPushed("org/repo", "src/content/blog/hello.md", 99, "claws/blog-hello-2");

      await clearBlogDraftPR("org/repo", "src/content/blog/hello.md");

      const draft = await getBlogDraft("org/repo", "src/content/blog/hello.md");
      expect(draft?.status).toBe("draft");
      expect(draft?.pr_number).toBeNull();
      expect(draft?.pr_branch).toBeNull();
    });
  });

  describe("shopping searches", () => {
    it("recordShoppingSearch then getShoppingSearches round-trips the stored result", async () => {
      await recordShoppingSearch("org/repo", "nas.yaml", "hba", JSON.stringify({ candidates: [{ title: "A" }] }));

      const rows = await getShoppingSearches("org/repo", "nas.yaml");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.itemId).toBe("hba");
      expect(JSON.parse(rows[0]!.resultJson).candidates[0].title).toBe("A");
      expect(rows[0]!.lastSearchedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it("recordShoppingSearch overwrites the result for an existing item", async () => {
      await recordShoppingSearch("org/repo", "nas.yaml", "hba", JSON.stringify({ candidates: [] }));
      await recordShoppingSearch("org/repo", "nas.yaml", "hba", JSON.stringify({ candidates: [{ title: "B" }] }));

      const rows = await getShoppingSearches("org/repo", "nas.yaml");
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.resultJson).candidates[0].title).toBe("B");
    });

    it("getShoppingSearches scopes results to the repo and manifest", async () => {
      await recordShoppingSearch("org/repo", "nas.yaml", "hba", "{}");
      await recordShoppingSearch("org/repo", "heating.yaml", "valve", "{}");
      await recordShoppingSearch("org/other", "nas.yaml", "hba", "{}");

      expect((await getShoppingSearches("org/repo", "nas.yaml")).map((r) => r.itemId)).toEqual(["hba"]);
      expect((await getShoppingSearches("org/repo", "heating.yaml")).map((r) => r.itemId)).toEqual(["valve"]);
      expect(await getShoppingSearches("org/repo", "missing.yaml")).toEqual([]);
    });
  });

  describe("session pruning", () => {
    it("pruneEndedSessions deletes exactly the selected ended rows when timestamps tie", async () => {
      await insertSession({
        id: "live",
        tmux_name: "claws-live",
        mode: "home-claude",
        repo: null,
        cwd: "/tmp/live",
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: 1,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
      });
      await insertSession({
        id: "keep-b",
        tmux_name: "claws-keep-b",
        mode: "home-claude",
        repo: null,
        cwd: "/tmp/keep-b",
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: 2,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
      });
      await insertSession({
        id: "keep-a",
        tmux_name: "claws-keep-a",
        mode: "home-claude",
        repo: null,
        cwd: "/tmp/keep-a",
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: 3,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
      });
      await insertSession({
        id: "prune-b",
        tmux_name: "claws-prune-b",
        mode: "home-claude",
        repo: null,
        cwd: "/tmp/prune-b",
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: 4,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
      });
      await insertSession({
        id: "prune-a",
        tmux_name: "claws-prune-a",
        mode: "home-claude",
        repo: null,
        cwd: "/tmp/prune-a",
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: 5,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
      });

      for (const id of ["keep-b", "keep-a", "prune-b", "prune-a"]) {
        await markSessionEnded(id, 1_000, JSON.stringify([]));
      }

      expect((await getEndedSessions()).map((row) => row.id)).toEqual([
        "prune-b",
        "prune-a",
        "keep-b",
        "keep-a",
      ]);
      expect(await pruneEndedSessions(2)).toEqual(["keep-b", "keep-a"]);
      expect((await getEndedSessions()).map((row) => row.id)).toEqual(["prune-b", "prune-a"]);
      expect((await getAllPersistedSessions()).map((row) => row.id)).toEqual(["live"]);
    });

    it("pruneEndedSessions deletes large batches without exceeding SQLite bind limits", async () => {
      for (let i = 0; i < 1105; i += 1) {
        await insertSession({
          id: `ended-${i}`,
          tmux_name: `claws-ended-${i}`,
          mode: "home-claude",
          repo: null,
          cwd: `/tmp/ended-${i}`,
          worktree_path: null,
          extra_worktrees: null,
          capabilities: null,
          created_at: i,
          summary: null,
          summary_updated_at: null,
          provider: "claude",
          model: null,
        });
        await markSessionEnded(`ended-${i}`, i, JSON.stringify([]));
      }

      const pruned = await pruneEndedSessions(0);

      expect(pruned).toHaveLength(1105);
      expect(await getEndedSessions()).toEqual([]);
      expect(await getAllPersistedSessions()).toEqual([]);
    });
  });

  describe("getRecentSessionModels", () => {
    async function insertModelSession(id: string, provider: string, model: string | null, createdAt: number): Promise<void> {
      await insertSession({
        id,
        tmux_name: `claws-${id}`,
        mode: "home-claude",
        repo: null,
        cwd: `/tmp/${id}`,
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: createdAt,
        summary: null,
        summary_updated_at: null,
        provider,
        model,
      });
    }

    it("returns distinct models for the provider, most-recently-used first", async () => {
      await insertModelSession("m1", "claude", "opus", 1);
      await insertModelSession("m2", "claude", "sonnet", 2);
      await insertModelSession("m3", "claude", "opus", 3);
      await insertModelSession("m4", "codex", "gpt-5.4-mini", 4);
      await insertModelSession("m5", "claude", null, 5);
      await insertModelSession("m6", "claude", "", 6);

      expect(await getRecentSessionModels("claude")).toEqual(["opus", "sonnet"]);
      expect(await getRecentSessionModels("codex")).toEqual(["gpt-5.4-mini"]);
      expect(await getRecentSessionModels("opencode")).toEqual([]);
    });

    it("honours the limit", async () => {
      await insertModelSession("l1", "claude", "opus", 1);
      await insertModelSession("l2", "claude", "sonnet", 2);
      await insertModelSession("l3", "claude", "haiku", 3);

      expect(await getRecentSessionModels("claude", 2)).toEqual(["haiku", "sonnet"]);
    });
  });

  describe("setManualSessionSummary", () => {
    async function insertPlainSession(id: string): Promise<void> {
      await insertSession({
        id,
        tmux_name: `claws-${id}`,
        mode: "home-claude",
        repo: null,
        cwd: `/tmp/${id}`,
        worktree_path: null,
        extra_worktrees: null,
        capabilities: null,
        created_at: 1,
        summary: null,
        summary_updated_at: null,
        provider: "claude",
        model: null,
      });
    }

    it("sets the summary and pins it against updateSessionSummary", async () => {
      await insertPlainSession("pin-1");

      expect(await setManualSessionSummary("pin-1", "My manual description", 500)).toBe(true);

      let row = (await getAllPersistedSessions()).find((r) => r.id === "pin-1");
      expect(row?.summary).toBe("My manual description");
      expect(row?.summary_manual).toBe(1);

      await updateSessionSummary("pin-1", "Auto summary", 999);

      row = (await getAllPersistedSessions()).find((r) => r.id === "pin-1");
      expect(row?.summary).toBe("My manual description");
      expect(row?.summary_manual).toBe(1);
    });

    it("clears the pin when summary is null, allowing updateSessionSummary to write again", async () => {
      await insertPlainSession("pin-2");
      await setManualSessionSummary("pin-2", "My manual description", 500);

      expect(await setManualSessionSummary("pin-2", null, null)).toBe(true);

      let row = (await getAllPersistedSessions()).find((r) => r.id === "pin-2");
      expect(row?.summary).toBeNull();
      expect(row?.summary_manual).toBe(0);

      await updateSessionSummary("pin-2", "Auto summary", 999);

      row = (await getAllPersistedSessions()).find((r) => r.id === "pin-2");
      expect(row?.summary).toBe("Auto summary");
      expect(row?.summary_manual).toBe(0);
    });
  });

  describe("ha entity unavailable tracking", () => {
    it("first-seen timestamp is sticky across repeated calls, and resets after clearing", async () => {
      expect(await recordHaEntityUnavailable("x", 1000)).toBe(1000);
      expect(await recordHaEntityUnavailable("x", 9000)).toBe(1000);

      await clearHaEntityUnavailable("x");

      expect(await recordHaEntityUnavailable("x", 5000)).toBe(5000);
    });
  });

});

describe("main build failures", () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("records a failure, finds it by run id, and tracks a pending retry to its outcome", async () => {
    expect(await hasMainBuildFailure("1")).toBe(false);

    await recordMainBuildFailure("1", "org/repo", "CI", "https://example.invalid/run/1", true, null);
    expect(await hasMainBuildFailure("1")).toBe(true);

    const pending = await getPendingMainBuildRetries();
    expect(pending).toHaveLength(1);
    expect(pending[0].workflow_name).toBe("CI");
    expect(pending[0].run_url).toBe("https://example.invalid/run/1");

    await setMainBuildRetryOutcome("1", "failure");
    expect(await getPendingMainBuildRetries()).toHaveLength(0);
  });

  it("a failure that was never retried is not pending", async () => {
    await recordMainBuildFailure("2", "org/repo", "CI", "https://example.invalid/run/2", false, "not-retried");
    expect(await getPendingMainBuildRetries()).toHaveLength(0);
  });

  it("getExpiredMainBuildRetries finds retries stuck past 24h, not fresh pending ones", async () => {
    await recordMainBuildFailure("9", "org/repo", "CI", "https://example.invalid/run/9", true, null);
    expect((await getPendingMainBuildRetries()).map((r) => r.run_id)).toEqual(["9"]);
    expect(await getExpiredMainBuildRetries()).toHaveLength(0);

    const db = _rawDb();
    await db.run(`UPDATE main_build_failures SET detected_at = '${ago(90000000)}' WHERE run_id = ?`, ["9"]);

    expect(await getPendingMainBuildRetries()).toHaveLength(0);
    const expired = await getExpiredMainBuildRetries();
    expect(expired).toHaveLength(1);
    expect(expired[0].run_id).toBe("9");

    await setMainBuildRetryOutcome("9", "retry-timed-out");
    expect(await getExpiredMainBuildRetries()).toHaveLength(0);
  });

  it("reported failures stay unclosed until marked closed", async () => {
    await recordMainBuildFailure("3", "org/repo", "CI", "https://example.invalid/run/3", false, "not-retried");
    expect(await hasUnclosedReportedFailure("org/repo", "CI")).toBe(false);

    await markMainBuildReported("3");
    expect(await hasUnclosedReportedFailure("org/repo", "CI")).toBe(true);
    // Scoped to the repo+workflow pair.
    expect(await hasUnclosedReportedFailure("org/repo", "Release")).toBe(false);

    await markMainBuildFailuresClosed("org/repo", "CI");
    expect(await hasUnclosedReportedFailure("org/repo", "CI")).toBe(false);
  });

  it("getUnreportedMainBuildFailures finds terminal rows that never got reported", async () => {
    // Never retried, reported failed: must be retried.
    await recordMainBuildFailure("4", "org/repo", "CI", "https://example.invalid/run/4", false, "not-retried", "push");
    // Retried and failed again, reported failed: must be retried.
    await recordMainBuildFailure("5", "org/repo", "Release", "https://example.invalid/run/5", true, null, "push");
    await setMainBuildRetryOutcome("5", "failure");
    // Reported successfully: excluded.
    await recordMainBuildFailure("6", "org/repo", "Docs", "https://example.invalid/run/6", false, "not-retried", "push");
    await markMainBuildReported("6");
    // Retry still pending (outcome NULL): excluded — handled by getPendingMainBuildRetries.
    await recordMainBuildFailure("7", "org/repo", "Lint", "https://example.invalid/run/7", true, null, "push");
    // Retry succeeded: excluded, no report was ever needed.
    await recordMainBuildFailure("8", "org/repo", "Test", "https://example.invalid/run/8", true, null, "push");
    await setMainBuildRetryOutcome("8", "success");
    // Retry timed out after 24h with no verdict: must be retried, same as a genuine failure.
    await recordMainBuildFailure("9", "org/repo", "Lint2", "https://example.invalid/run/9", true, null, "push");
    await setMainBuildRetryOutcome("9", "retry-timed-out");

    const unreported = (await getUnreportedMainBuildFailures()).map((r) => r.run_id).sort();
    expect(unreported).toEqual(["4", "5", "9"]);
  });

  it("pruneMainBuildFailures removes rows older than retentionDays and returns the count", async () => {
    const db = _rawDb();
    await db.run(`INSERT INTO main_build_failures (run_id, repo, workflow_name, run_url, detected_at, retried, outcome, reported)
       VALUES (?, ?, ?, ?, '${ago(3024000000)}', 0, 'not-retried', 1)`, ["old-1", "org/repo", "CI", "https://example.invalid/run/old-1"]);
    await recordMainBuildFailure("recent-1", "org/repo", "CI", "https://example.invalid/run/recent-1", false, "not-retried");

    const pruned = await pruneMainBuildFailures(30);
    expect(pruned).toBe(1);
    expect(await hasMainBuildFailure("old-1")).toBe(false);
    expect(await hasMainBuildFailure("recent-1")).toBe(true);
  });

  it("pruneMainBuildFailures returns 0 when nothing to prune", async () => {
    await recordMainBuildFailure("recent-2", "org/repo", "CI", "https://example.invalid/run/recent-2", false, "not-retried");
    expect(await pruneMainBuildFailures(30)).toBe(0);
  });

  it("getDefaultBranchRuns excludes pull_request runs and other branches", async () => {
    await upsertWorkflowRuns([
      makeRun({ run_id: 1, workflow_name: "CI", event: "push", head_branch: "main" }),
      makeRun({ run_id: 2, workflow_name: "Nightly", event: "schedule", head_branch: "main" }),
      makeRun({ run_id: 3, workflow_name: "CI", event: "pull_request", head_branch: "main" }),
      makeRun({ run_id: 4, workflow_name: "CI", event: "push", head_branch: "feature" }),
    ]);

    const rows = await getDefaultBranchRuns("org/repo", "main", 7);
    expect(rows.map((r) => r.run_id).sort()).toEqual([1, 2]);
    expect(rows[0].head_sha).toBe("abc123");
    expect(rows[0].run_attempt).toBe(1);
  });
});
