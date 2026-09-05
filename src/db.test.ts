import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./config.js", () => ({
  DB_PATH: ":memory:",
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
  updateTaskModel,
  updateTaskProvider,
  updateTaskTokenUsage,
  insertSession,
  getAllPersistedSessions,
  getEndedSessions,
  markSessionEnded,
  pruneEndedSessions,
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
  type Task,
  type TaskOutcome,
  type WorkflowRunRow,
} from "./db.js";

describe("db", () => {
  beforeEach(() => {
    initDb();
  });

  afterEach(() => {
    closeDb();
  });

  it("initDb creates the tasks table", () => {
    // If initDb didn't create the table, recordTaskStart would throw
    const id = recordTaskStart("test-job", "test/repo", 1, "label");
    expect(id).toBeGreaterThan(0);
  });

  it("initDb creates the idx_tasks_repo_item index", () => {
    const idx = _rawDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_repo_item'`)
      .get();
    expect(idx).toBeDefined();
  });

  it("recordTaskStart inserts a running task and returns an ID", () => {
    const id = recordTaskStart("issue-worker", "org/repo", 42, "Refined");
    expect(id).toBe(1);

    const tasks = getOrphanedTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].job_name).toBe("issue-worker");
    expect(tasks[0].repo).toBe("org/repo");
    expect(tasks[0].item_number).toBe(42);
    expect(tasks[0].trigger_label).toBe("Refined");
    expect(tasks[0].status).toBe("running");
  });

  it("updateTaskWorktree sets worktree path and branch name", () => {
    const id = recordTaskStart("test-job", "org/repo", 1, null);
    updateTaskWorktree(id, "/tmp/worktree", "feature-branch");

    const tasks = getOrphanedTasks();
    expect(tasks[0].worktree_path).toBe("/tmp/worktree");
    expect(tasks[0].branch_name).toBe("feature-branch");
  });

  it("recordTaskComplete sets status to completed", () => {
    const id = recordTaskStart("test-job", "org/repo", 1, null);
    recordTaskComplete(id);

    // Should no longer appear as orphaned (not 'running')
    const orphaned = getOrphanedTasks();
    expect(orphaned).toHaveLength(0);
  });

  it("recordTaskComplete stores outcome JSON when provided", () => {
    setRunIdProvider(() => "run-outcome");
    const id = recordTaskStart("issue-worker", "org/repo", 1, null);
    const outcome: TaskOutcome = {
      commits: 3,
      filesChanged: 5,
      insertions: 127,
      deletions: 42,
      prNumber: 185,
      prAction: "created",
    };
    recordTaskComplete(id, outcome);
    setRunIdProvider(() => undefined);

    const tasks = getTasksByRunId("run-outcome");
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

  it("recordTaskComplete without outcome leaves outcome null", () => {
    setRunIdProvider(() => "run-no-outcome");
    const id = recordTaskStart("test-job", "org/repo", 1, null);
    recordTaskComplete(id);
    setRunIdProvider(() => undefined);

    const tasks = getTasksByRunId("run-no-outcome");
    expect(tasks[0].outcome).toBeNull();
  });

  it("recordTaskFailed sets status to failed and stores error", () => {
    const id = recordTaskStart("test-job", "org/repo", 1, null);
    recordTaskFailed(id, "Something went wrong");

    const orphaned = getOrphanedTasks();
    expect(orphaned).toHaveLength(0);
  });

  it("recordTaskFailed stores outcome JSON when provided", () => {
    setRunIdProvider(() => "run-fail-outcome");
    const id = recordTaskStart("test-job", "org/repo", 1, null);
    recordTaskFailed(id, "timed out", { failureCategory: "timeout" });
    setRunIdProvider(() => undefined);

    const tasks = getTasksByRunId("run-fail-outcome");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("failed");
    expect(tasks[0].error).toBe("timed out");

    const parsed = JSON.parse(tasks[0].outcome!);
    expect(parsed.failureCategory).toBe("timeout");
  });

  it("getOrphanedTasks returns only running tasks", () => {
    const id1 = recordTaskStart("job-a", "org/repo", 1, null);
    const id2 = recordTaskStart("job-b", "org/repo", 2, null);
    const id3 = recordTaskStart("job-c", "org/repo", 3, null);

    recordTaskComplete(id1);
    recordTaskFailed(id2, "error");

    const orphaned = getOrphanedTasks();
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].id).toBe(id3);
    expect(orphaned[0].status).toBe("running");
  });

  it("closeDb closes cleanly", () => {
    closeDb();
    // After closing, operations should throw
    expect(() => recordTaskStart("test", "repo", 1, null)).toThrow(
      "Database not initialized",
    );
  });

  it("countRecentTimeouts counts failed tasks with timeout errors", () => {
    const db = _rawDb();
    // Insert a recent timeout failure
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Claude process timed out after 1200000ms', datetime('now', '-30 minutes'), datetime('now', '-29 minutes'))`,
    ).run("issue-worker", "org/repo", 42);
    // Insert a recent non-timeout failure
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Some other error', datetime('now', '-20 minutes'), datetime('now', '-19 minutes'))`,
    ).run("issue-worker", "org/repo", 42);
    // Insert an old timeout failure (outside window)
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Claude process timed out after 1200000ms', datetime('now', '-5 hours'), datetime('now', '-5 hours'))`,
    ).run("issue-worker", "org/repo", 42);

    // Default 2-hour window should find 1 timeout
    expect(countRecentTimeouts("org/repo", 42)).toBe(1);
  });

  it("countRecentTimeouts returns 0 when no timeouts exist", () => {
    expect(countRecentTimeouts("org/repo", 99)).toBe(0);
  });

  it("countRecentTimeouts scopes by repo and item number", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Claude process timed out after 1200000ms', datetime('now', '-10 minutes'), datetime('now', '-9 minutes'))`,
    ).run("issue-worker", "org/repo", 42);
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Claude process timed out after 1200000ms', datetime('now', '-10 minutes'), datetime('now', '-9 minutes'))`,
    ).run("issue-worker", "other/repo", 42);

    expect(countRecentTimeouts("org/repo", 42)).toBe(1);
    expect(countRecentTimeouts("other/repo", 42)).toBe(1);
    expect(countRecentTimeouts("org/repo", 99)).toBe(0);
  });

  it("countRecentMemoryLimits counts failed tasks with memory limit errors", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Agent process tree exceeded memory limit (2100MiB > 2048MiB)', datetime('now', '-30 minutes'), datetime('now', '-29 minutes'))`,
    ).run("issue-worker", "org/repo", 42);
    // Insert a recent non-memory-limit failure
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Some other error', datetime('now', '-20 minutes'), datetime('now', '-19 minutes'))`,
    ).run("issue-worker", "org/repo", 42);
    // Insert an old memory-limit failure (outside window)
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Agent process tree exceeded memory limit (2100MiB > 2048MiB)', datetime('now', '-5 hours'), datetime('now', '-5 hours'))`,
    ).run("issue-worker", "org/repo", 42);

    expect(countRecentMemoryLimits("org/repo", 42)).toBe(1);
  });

  it("countRecentMemoryLimits returns 0 when no memory limit errors exist", () => {
    expect(countRecentMemoryLimits("org/repo", 99)).toBe(0);
  });

  it("countRecentMemoryLimits scopes by repo and item number", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Agent process tree exceeded memory limit (2100MiB > 2048MiB)', datetime('now', '-10 minutes'), datetime('now', '-9 minutes'))`,
    ).run("issue-worker", "org/repo", 42);
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'Agent process tree exceeded memory limit (2100MiB > 2048MiB)', datetime('now', '-10 minutes'), datetime('now', '-9 minutes'))`,
    ).run("issue-worker", "other/repo", 42);

    expect(countRecentMemoryLimits("org/repo", 42)).toBe(1);
    expect(countRecentMemoryLimits("other/repo", 42)).toBe(1);
    expect(countRecentMemoryLimits("org/repo", 99)).toBe(0);
  });

  it("countRecentNoCommitCompletions counts completed tasks with 0 commits and no prNumber", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', datetime('now', '-30 minutes'), datetime('now', '-29 minutes'))`,
    ).run("issue-worker", "org/repo", 42);

    expect(countRecentNoCommitCompletions("org/repo", 42)).toBe(1);
  });

  it("countRecentNoCommitCompletions excludes tasks with commits > 0", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":3}', datetime('now', '-30 minutes'), datetime('now', '-29 minutes'))`,
    ).run("issue-worker", "org/repo", 42);

    expect(countRecentNoCommitCompletions("org/repo", 42)).toBe(0);
  });

  it("countRecentNoCommitCompletions excludes tasks with a prNumber", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0,"prNumber":100}', datetime('now', '-30 minutes'), datetime('now', '-29 minutes'))`,
    ).run("issue-worker", "org/repo", 42);

    expect(countRecentNoCommitCompletions("org/repo", 42)).toBe(0);
  });

  it("countRecentNoCommitCompletions scopes by repo and item number", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', datetime('now', '-10 minutes'), datetime('now', '-9 minutes'))`,
    ).run("issue-worker", "org/repo", 42);
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', datetime('now', '-10 minutes'), datetime('now', '-9 minutes'))`,
    ).run("issue-worker", "other/repo", 42);

    expect(countRecentNoCommitCompletions("org/repo", 42)).toBe(1);
    expect(countRecentNoCommitCompletions("other/repo", 42)).toBe(1);
    expect(countRecentNoCommitCompletions("org/repo", 99)).toBe(0);
  });

  it("countRecentNoCommitCompletions respects time window", () => {
    const db = _rawDb();
    // Recent — within default 6h window
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', datetime('now', '-1 hour'), datetime('now', '-59 minutes'))`,
    ).run("issue-worker", "org/repo", 42);
    // Old — outside default 6h window
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', datetime('now', '-8 hours'), datetime('now', '-8 hours'))`,
    ).run("issue-worker", "org/repo", 42);

    expect(countRecentNoCommitCompletions("org/repo", 42)).toBe(1);
  });

  it("countRecentNoCommitCompletions resets after a merged PR (cross-phase scoping)", () => {
    const db = _rawDb();
    // Phase 2 had 2 no-commit attempts before succeeding
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', datetime('now', '-3 hours'), datetime('now', '-3 hours'))`,
    ).run("issue-worker", "org/repo", 42);
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', datetime('now', '-2 hours'), datetime('now', '-2 hours'))`,
    ).run("issue-worker", "org/repo", 42);
    // Phase 2 finally succeeded — PR merged
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":3,"prNumber":101}', datetime('now', '-1 hour'), datetime('now', '-1 hour'))`,
    ).run("issue-worker", "org/repo", 42);
    // Phase 3, attempt 1: no commits
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, outcome, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', '{"commits":0}', datetime('now', '-30 minutes'), datetime('now', '-30 minutes'))`,
    ).run("issue-worker", "org/repo", 42);

    // Should only count the 1 no-commit attempt after the merged PR, not the 2 from phase 2
    expect(countRecentNoCommitCompletions("org/repo", 42)).toBe(1);
  });

  it("operations before initDb throw", () => {
    closeDb(); // close the one from beforeEach
    expect(() => recordTaskStart("test", "repo", 1, null)).toThrow(
      "Database not initialized",
    );
  });

  it("recordTaskStart with null trigger label", () => {
    const id = recordTaskStart("ci-fixer", "org/repo", 5, null);
    const tasks = getOrphanedTasks();
    expect(tasks[0].trigger_label).toBeNull();
  });

  it("multiple tasks get sequential IDs", () => {
    const id1 = recordTaskStart("job-a", "org/repo", 1, null);
    const id2 = recordTaskStart("job-b", "org/repo", 2, null);
    const id3 = recordTaskStart("job-c", "org/repo", 3, null);

    expect(id1).toBe(1);
    expect(id2).toBe(2);
    expect(id3).toBe(3);
  });

  it("getRunningTasks returns only running tasks ordered by started_at", () => {
    const id1 = recordTaskStart("job-a", "org/repo", 1, null);
    const id2 = recordTaskStart("job-b", "org/repo", 2, null);
    const id3 = recordTaskStart("job-c", "org/repo", 3, null);

    recordTaskComplete(id2);

    const running = getRunningTasks();
    expect(running).toHaveLength(2);
    expect(running[0].id).toBe(id1);
    expect(running[1].id).toBe(id3);
    expect(running.every(t => t.status === "running")).toBe(true);
  });

  it("setRunIdProvider + recordTaskStart populates run_id", () => {
    setRunIdProvider(() => "run-abc");
    const id = recordTaskStart("issue-worker", "org/repo", 42, null);
    const tasks = getOrphanedTasks();
    expect(tasks[0].run_id).toBe("run-abc");
    // Clean up provider
    setRunIdProvider(() => undefined);
  });

  it("recordTaskStart has null run_id when no provider is set", () => {
    setRunIdProvider(() => undefined);
    const id = recordTaskStart("issue-worker", "org/repo", 1, null);
    const tasks = getOrphanedTasks();
    expect(tasks[0].run_id).toBeNull();
  });

  it("getTasksByRunId returns correct tasks", () => {
    setRunIdProvider(() => "run-xyz");
    recordTaskStart("job-a", "org/repo", 1, null);
    recordTaskStart("job-a", "org/repo", 2, null);
    setRunIdProvider(() => "run-other");
    recordTaskStart("job-a", "org/repo", 3, null);
    setRunIdProvider(() => undefined);

    const tasks = getTasksByRunId("run-xyz");
    expect(tasks).toHaveLength(2);
    expect(tasks[0].item_number).toBe(1);
    expect(tasks[1].item_number).toBe(2);

    const otherTasks = getTasksByRunId("run-other");
    expect(otherTasks).toHaveLength(1);
    expect(otherTasks[0].item_number).toBe(3);
  });

  it("getWorkItemsForRuns batch query", () => {
    setRunIdProvider(() => "run-1");
    recordTaskStart("job-a", "org/repo", 10, null);
    setRunIdProvider(() => "run-2");
    recordTaskStart("job-a", "org/repo", 20, null);
    recordTaskStart("job-a", "org/repo", 21, null);
    setRunIdProvider(() => undefined);

    const map = getWorkItemsForRuns(["run-1", "run-2"]);
    expect(map.get("run-1")).toHaveLength(1);
    expect(map.get("run-2")).toHaveLength(2);
  });

  it("getWorkItemsForRuns returns empty map for empty input", () => {
    const map = getWorkItemsForRuns([]);
    expect(map.size).toBe(0);
  });

  it("searchRunsByItem finds runs by repo name", () => {
    insertJobRun("run-1", "job-a");
    setRunIdProvider(() => "run-1");
    recordTaskStart("job-a", "org/my-repo", 5, null);
    setRunIdProvider(() => undefined);

    const results = searchRunsByItem("my-repo");
    expect(results).toHaveLength(1);
    expect(results[0].run_id).toBe("run-1");
  });

  it("searchRunsByItem finds runs by item number", () => {
    insertJobRun("run-1", "job-a");
    setRunIdProvider(() => "run-1");
    recordTaskStart("job-a", "org/repo", 42, null);
    setRunIdProvider(() => undefined);

    const results = searchRunsByItem("42");
    expect(results).toHaveLength(1);
    expect(results[0].run_id).toBe("run-1");
  });

  it("searchRunsByItem returns empty for no match", () => {
    insertJobRun("run-1", "job-a");
    setRunIdProvider(() => "run-1");
    recordTaskStart("job-a", "org/repo", 1, null);
    setRunIdProvider(() => undefined);

    const results = searchRunsByItem("nonexistent");
    expect(results).toHaveLength(0);
  });

  it("searchRunsByItem finds runs by repo#number format", () => {
    insertJobRun("run-1", "job-a");
    setRunIdProvider(() => "run-1");
    recordTaskStart("job-a", "org/claws", 195, null);
    setRunIdProvider(() => undefined);

    const results = searchRunsByItem("claws#195");
    expect(results).toHaveLength(1);
    expect(results[0].run_id).toBe("run-1");
  });

  it("searchRunsByItem finds runs by full owner/repo#number format", () => {
    insertJobRun("run-1", "job-a");
    setRunIdProvider(() => "run-1");
    recordTaskStart("job-a", "org/claws", 195, null);
    setRunIdProvider(() => undefined);

    const results = searchRunsByItem("org/claws#195");
    expect(results).toHaveLength(1);
    expect(results[0].run_id).toBe("run-1");
  });

  it("searchRunsByItem repo#number does not match wrong number", () => {
    insertJobRun("run-1", "job-a");
    setRunIdProvider(() => "run-1");
    recordTaskStart("job-a", "org/claws", 195, null);
    setRunIdProvider(() => undefined);

    const results = searchRunsByItem("claws#999");
    expect(results).toHaveLength(0);
  });

  it("searchRunsByItem repo#number does not match wrong repo", () => {
    insertJobRun("run-1", "job-a");
    setRunIdProvider(() => "run-1");
    recordTaskStart("job-a", "org/claws", 195, null);
    setRunIdProvider(() => undefined);

    const results = searchRunsByItem("other#195");
    expect(results).toHaveLength(0);
  });
});

describe("job run logs", () => {
  beforeEach(() => {
    initDb();
  });

  afterEach(() => {
    closeDb();
  });

  it("insertJobRun creates a run record", () => {
    insertJobRun("run-1", "test-job");
    const runs = getRecentJobRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].run_id).toBe("run-1");
    expect(runs[0].job_name).toBe("test-job");
    expect(runs[0].status).toBe("running");
    expect(runs[0].completed_at).toBeNull();
  });

  it("completeJobRun updates status and completed_at", () => {
    insertJobRun("run-1", "test-job");
    completeJobRun("run-1", "completed");

    const run = getJobRun("run-1");
    expect(run).toBeDefined();
    expect(run!.status).toBe("completed");
    expect(run!.completed_at).not.toBeNull();
  });

  it("completeJobRun can set status to failed", () => {
    insertJobRun("run-1", "test-job");
    completeJobRun("run-1", "failed");

    const run = getJobRun("run-1");
    expect(run!.status).toBe("failed");
  });

  it("insertJobLog appends log entries", () => {
    insertJobRun("run-1", "test-job");
    insertJobLog("run-1", "info", "Hello");
    insertJobLog("run-1", "warn", "Careful");
    insertJobLog("run-1", "error", "Boom");

    const logs = getJobRunLogs("run-1");
    expect(logs).toHaveLength(3);
    expect(logs[0].level).toBe("info");
    expect(logs[0].message).toBe("Hello");
    expect(logs[1].level).toBe("warn");
    expect(logs[2].level).toBe("error");
  });

  it("getRecentJobRuns returns runs in descending order and respects limit", () => {
    insertJobRun("run-1", "job-a");
    insertJobRun("run-2", "job-b");
    insertJobRun("run-3", "job-c");

    const all = getRecentJobRuns();
    expect(all).toHaveLength(3);
    // All have the same started_at (datetime('now')), but order by DESC should still work
    expect(all.map((r) => r.run_id)).toContain("run-1");

    const limited = getRecentJobRuns(2);
    expect(limited).toHaveLength(2);
  });

  it("getJobRunLogs returns entries for a specific run only", () => {
    insertJobRun("run-1", "job-a");
    insertJobRun("run-2", "job-b");
    insertJobLog("run-1", "info", "Run 1 log");
    insertJobLog("run-2", "info", "Run 2 log");

    const logs1 = getJobRunLogs("run-1");
    expect(logs1).toHaveLength(1);
    expect(logs1[0].message).toBe("Run 1 log");

    const logs2 = getJobRunLogs("run-2");
    expect(logs2).toHaveLength(1);
    expect(logs2[0].message).toBe("Run 2 log");
  });

  it("getJobRun returns undefined for nonexistent run", () => {
    const run = getJobRun("nonexistent");
    expect(run).toBeUndefined();
  });

  it("pruneOldLogs deletes old entries and returns count", () => {
    insertJobRun("run-1", "job-a");
    insertJobLog("run-1", "info", "Old log");

    // With retention of 0 days, everything before now is pruned
    // Since datetime('now') entries equal the cutoff, they won't be pruned
    // Use a very large retention to verify nothing is pruned
    const prunedNone = pruneOldLogs(9999);
    expect(prunedNone).toBe(0);
    expect(getRecentJobRuns()).toHaveLength(1);
  });

  it("getRecentJobRuns with jobFilter returns only matching runs", () => {
    insertJobRun("run-1", "job-a");
    insertJobRun("run-2", "job-b");
    insertJobRun("run-3", "job-a");

    const filtered = getRecentJobRuns(50, "job-a");
    expect(filtered).toHaveLength(2);
    expect(filtered.every((r) => r.job_name === "job-a")).toBe(true);

    const filteredB = getRecentJobRuns(50, "job-b");
    expect(filteredB).toHaveLength(1);
    expect(filteredB[0].job_name).toBe("job-b");
  });

  it("getDistinctJobNames returns all job names sorted", () => {
    insertJobRun("run-1", "ci-fixer");
    insertJobRun("run-2", "issue-worker");
    insertJobRun("run-3", "issue-worker");
    insertJobRun("run-4", "auto-merger");

    const names = getDistinctJobNames();
    expect(names).toEqual(["auto-merger", "ci-fixer", "issue-worker"]);
  });

  it("getDistinctJobNames returns all job types even when getRecentJobRuns limit would exclude some", () => {
    // Insert many runs of job-a and one run of job-b
    for (let i = 0; i < 5; i++) {
      insertJobRun(`run-a-${i}`, "job-a");
    }
    insertJobRun("run-b-1", "job-b");

    // With limit=3, getRecentJobRuns misses job-b (since job-a fills all slots)
    // but getDistinctJobNames should still return both
    const limited = getRecentJobRuns(3);
    const namesFromLimited = [...new Set(limited.map((r) => r.job_name))];
    // job-b may or may not appear depending on insertion order

    const allNames = getDistinctJobNames();
    expect(allNames).toContain("job-a");
    expect(allNames).toContain("job-b");
  });

  it("pruneOldLogs keeps most recent N runs per job type", () => {
    const db = _rawDb();
    // Insert old runs for job-a (4 runs) and job-b (2 runs)
    for (let i = 1; i <= 4; i++) {
      db.prepare(
        `INSERT INTO job_runs (run_id, job_name, status, started_at) VALUES (?, ?, 'completed', datetime('now', '-30 days', '+' || ? || ' hours'))`,
      ).run(`old-a-${i}`, "job-a", i);
    }
    for (let i = 1; i <= 2; i++) {
      db.prepare(
        `INSERT INTO job_runs (run_id, job_name, status, started_at) VALUES (?, ?, 'completed', datetime('now', '-30 days', '+' || ? || ' hours'))`,
      ).run(`old-b-${i}`, "job-b", i);
    }
    // Insert logs for all runs
    for (let i = 1; i <= 4; i++) {
      insertJobLog(`old-a-${i}`, "info", `Log for a-${i}`);
    }
    for (let i = 1; i <= 2; i++) {
      insertJobLog(`old-b-${i}`, "info", `Log for b-${i}`);
    }

    // Prune with keepPerJob=2 and retention=7 days (all runs are 30 days old)
    const pruned = pruneOldLogs(7, 2);

    // job-a had 4 old runs, should keep 2 → prune 2
    // job-b had 2 old runs, should keep 2 → prune 0
    expect(pruned).toBe(2);

    const remainingA = getRecentJobRuns(50, "job-a");
    expect(remainingA).toHaveLength(2);

    const remainingB = getRecentJobRuns(50, "job-b");
    expect(remainingB).toHaveLength(2);
  });

  it("pruneOldLogs cascades log cleanup for deleted runs", () => {
    const db = _rawDb();
    // Insert an old run with logs
    db.prepare(
      `INSERT INTO job_runs (run_id, job_name, status, started_at) VALUES ('old-run', 'job-a', 'completed', datetime('now', '-30 days'))`,
    ).run();
    insertJobLog("old-run", "info", "Old log entry");

    // Insert a recent run with logs
    insertJobRun("recent-run", "job-a");
    insertJobLog("recent-run", "info", "Recent log entry");

    // Prune with keepPerJob=1 (keep only the most recent run per job)
    pruneOldLogs(7, 1);

    // Old run's logs should be gone
    const oldLogs = getJobRunLogs("old-run");
    expect(oldLogs).toHaveLength(0);

    // Recent run's logs should remain
    const recentLogs = getJobRunLogs("recent-run");
    expect(recentLogs).toHaveLength(1);
  });

  it("pruneOldLogs without keepPerJob arg defaults to 20", () => {
    const db = _rawDb();
    // Insert 25 old runs for the same job
    for (let i = 1; i <= 25; i++) {
      db.prepare(
        `INSERT INTO job_runs (run_id, job_name, status, started_at) VALUES (?, ?, 'completed', datetime('now', '-30 days', '+' || ? || ' minutes'))`,
      ).run(`old-${i}`, "job-a", i);
    }

    // Prune with default keepPerJob (20)
    const pruned = pruneOldLogs(7);
    expect(pruned).toBe(5); // 25 - 20 = 5

    const remaining = getRecentJobRuns(50, "job-a");
    expect(remaining).toHaveLength(20);
  });

  it("getJobRunLogsSince returns only logs after the given ID", () => {
    insertJobRun("run-1", "test-job");
    insertJobLog("run-1", "info", "First");
    insertJobLog("run-1", "warn", "Second");
    insertJobLog("run-1", "error", "Third");

    const allLogs = getJobRunLogs("run-1");
    const firstId = allLogs[0].id;

    const since = getJobRunLogsSince("run-1", firstId);
    expect(since).toHaveLength(2);
    expect(since[0].message).toBe("Second");
    expect(since[1].message).toBe("Third");

    const sinceAll = getJobRunLogsSince("run-1", 0);
    expect(sinceAll).toHaveLength(3);

    const sinceEnd = getJobRunLogsSince("run-1", allLogs[2].id);
    expect(sinceEnd).toHaveLength(0);
  });

  it("getLatestRunIdsByJob returns latest run per job", () => {
    insertJobRun("run-1", "job-a");
    insertJobRun("run-2", "job-a");
    insertJobRun("run-3", "job-b");
    completeJobRun("run-1", "completed");
    completeJobRun("run-2", "failed");

    const latest = getLatestRunIdsByJob();
    expect(latest.get("job-a")).toEqual(expect.objectContaining({ runId: "run-2", status: "failed" }));
    expect(latest.get("job-a")).toHaveProperty("startedAt");
    expect(latest.get("job-a")).toHaveProperty("completedAt");
    expect(latest.get("job-b")).toEqual(expect.objectContaining({ runId: "run-3", status: "running" }));
    expect(latest.get("job-b")!.completedAt).toBeNull();
  });
});

describe("pruneTasks", () => {
  beforeEach(() => {
    initDb();
  });

  afterEach(() => {
    closeDb();
  });

  it("deletes old terminal rows, keeps recent ones", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at) VALUES ('issue-worker','org/repo',1,'completed',datetime('now','-120 days'),datetime('now','-120 days'))`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at) VALUES ('issue-worker','org/repo',2,'failed',datetime('now'),datetime('now'))`,
    ).run();

    expect(pruneTasks(90)).toBe(1);

    const { c } = db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number };
    expect(c).toBe(1);
  });

  it("never deletes running rows", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES ('issue-worker','org/repo',1,'running',datetime('now','-200 days'))`,
    ).run();

    expect(pruneTasks(90)).toBe(0);
    expect(getOrphanedTasks()).toHaveLength(1);
  });

  it("keeps rows whose run still exists", () => {
    const db = _rawDb();
    insertJobRun("run-keep", "job-a");
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at, run_id) VALUES ('issue-worker','org/repo',1,'completed',datetime('now','-200 days'),datetime('now','-200 days'),'run-keep')`,
    ).run();

    expect(pruneTasks(90)).toBe(0);

    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at, run_id) VALUES ('issue-worker','org/repo',2,'completed',datetime('now','-200 days'),datetime('now','-200 days'),'run-gone')`,
    ).run();

    expect(pruneTasks(90)).toBe(1);
  });

  it("returns 0 when nothing to prune", () => {
    const id = recordTaskStart("issue-worker", "org/repo", 1, null);
    recordTaskComplete(id);
    expect(pruneTasks(90)).toBe(0);
  });
});

describe("getRecentWorkItems", () => {
  beforeEach(() => {
    initDb();
  });

  afterEach(() => {
    closeDb();
  });

  it("returns recent items ordered by most recent first", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', datetime('now', '-3 hours'))`,
    ).run("issue-worker", "org/repo", 10);
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', datetime('now', '-1 hour'))`,
    ).run("issue-worker", "org/repo", 20);
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', datetime('now', '-2 hours'))`,
    ).run("issue-worker", "org/repo", 30);

    const items = getRecentWorkItems();
    expect(items).toHaveLength(3);
    expect(items[0].item_number).toBe(20);
    expect(items[1].item_number).toBe(30);
    expect(items[2].item_number).toBe(10);
  });

  it("deduplicates same issue worked on multiple times", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', datetime('now', '-2 hours'))`,
    ).run("issue-worker", "org/repo", 42);
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', datetime('now', '-1 hour'))`,
    ).run("issue-worker", "org/repo", 42);

    const items = getRecentWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0].item_number).toBe(42);
  });

  it("excludes item_number = 0", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', datetime('now'))`,
    ).run("doc-maintainer", "org/repo", 0);
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', datetime('now'))`,
    ).run("issue-worker", "org/repo", 5);

    const items = getRecentWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0].item_number).toBe(5);
  });

  it("respects the limit parameter", () => {
    const db = _rawDb();
    for (let i = 1; i <= 5; i++) {
      db.prepare(
        `INSERT INTO tasks (job_name, repo, item_number, status, started_at) VALUES (?, ?, ?, 'completed', datetime('now', '-' || ? || ' hours'))`,
      ).run("issue-worker", "org/repo", i, i);
    }

    const items = getRecentWorkItems(3);
    expect(items).toHaveLength(3);
  });

  it("returns empty array when no tasks exist", () => {
    const items = getRecentWorkItems();
    expect(items).toHaveLength(0);
  });
});

describe("getAllAverageTaskDurations", () => {
  beforeEach(() => {
    initDb();
  });

  afterEach(() => {
    closeDb();
  });

  it("returns empty object when no completed tasks exist", () => {
    expect(getAllAverageTaskDurations()).toEqual({});
  });

  it("returns averages grouped by job name prefix in a single query", () => {
    const db = _rawDb();
    // Insert tasks for two different job types
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', datetime('now', '-25 minutes'), datetime('now', '-15 minutes'))`,
    ).run("issue-worker", "org/repo", 1);
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', datetime('now', '-20 minutes'), datetime('now', '-10 minutes'))`,
    ).run("ci-fixer:merge-conflict", "org/repo", 2);
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', datetime('now', '-30 minutes'), datetime('now', '-10 minutes'))`,
    ).run("ci-fixer:revert", "org/repo", 3);

    const result = getAllAverageTaskDurations();
    expect(result["issue-worker"]).toBeGreaterThan(500_000);
    expect(result["issue-worker"]).toBeLessThan(700_000);
    // ci-fixer prefix groups both variants: avg of 10min and 20min = 15min
    expect(result["ci-fixer"]).toBeGreaterThan(800_000);
    expect(result["ci-fixer"]).toBeLessThan(1_000_000);
  });

  it("ignores running and failed tasks", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at)
       VALUES (?, ?, ?, 'running', datetime('now', '-10 minutes'))`,
    ).run("issue-worker", "org/repo", 1);
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, error, started_at, completed_at)
       VALUES (?, ?, ?, 'failed', 'err', datetime('now', '-10 minutes'), datetime('now', '-5 minutes'))`,
    ).run("issue-worker", "org/repo", 2);

    expect(getAllAverageTaskDurations()).toEqual({});
  });
});

describe("work_queue helpers", () => {
  beforeEach(() => {
    initDb();
  });

  afterEach(() => {
    closeDb();
  });

  it("enqueueWork inserts a row and returns its id", () => {
    const r = enqueueWork("ci-fixer", "org/repo", 42, { priority: true });
    expect(r).not.toBeNull();
    expect(r!.alreadyQueued).toBe(false);
    expect(typeof r!.id).toBe("number");
    expect(listQueuedWork()).toHaveLength(1);
  });

  it("enqueueWork dedups same (kind, repo, item_number) when row is queued", () => {
    const first = enqueueWork("ci-fixer", "org/repo", 42);
    const second = enqueueWork("ci-fixer", "org/repo", 42);
    expect(first!.id).toBe(second!.id);
    expect(second!.alreadyQueued).toBe(true);
    expect(listQueuedWork()).toHaveLength(1);
  });

  it("enqueueWork allows different kinds on same repo+item", () => {
    expect(enqueueWork("ci-fixer", "org/repo", 42)).not.toBeNull();
    expect(enqueueWork("review-addresser", "org/repo", 42)).not.toBeNull();
    expect(listQueuedWork()).toHaveLength(2);
  });

  it("claimNextWork picks priority rows first, then by id", () => {
    enqueueWork("ci-fixer", "org/repo", 1);
    enqueueWork("ci-fixer", "org/repo", 2, { priority: true });
    enqueueWork("ci-fixer", "org/repo", 3);

    const claimed = claimNextWork(null);
    expect(claimed).not.toBeNull();
    expect(claimed!.item_number).toBe(2);
    expect(claimed!.status).toBe("running");
    expect(claimed!.pid).toBe(process.pid);
    expect(claimed!.attempts).toBe(1);
  });

  it("claimNextWork returns null when no queued rows", () => {
    expect(claimNextWork(null)).toBeNull();
  });

  it("markWorkSucceeded transitions to completed", () => {
    const r = enqueueWork("ci-fixer", "org/repo", 1)!;
    claimNextWork(null);
    markWorkSucceeded(r.id);
    expect(countWorkByStatus()["completed"]).toBe(1);
  });

  it("markWorkFailed transitions to failed with error_message", () => {
    const r = enqueueWork("ci-fixer", "org/repo", 1)!;
    claimNextWork(null);
    markWorkFailed(r.id, "boom");
    const counts = countWorkByStatus();
    expect(counts["failed"]).toBe(1);
  });

  it("markWorkCancelled transitions to cancelled and frees the item for re-enqueue", () => {
    const r = enqueueWork("issue-refiner:plan", "org/repo", 1)!;
    claimNextWork(null);
    markWorkCancelled(r.id, "run cancelled");
    expect(countWorkByStatus()["cancelled"]).toBe(1);
    expect(listQueuedWork()).toHaveLength(0);

    const again = enqueueWork("issue-refiner:plan", "org/repo", 1);
    expect(again!.alreadyQueued).toBe(false);
  });

  it("recoverWorkOnStartup resets running rows from other pids", () => {
    const db = _rawDb();
    db.prepare(`INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, pid, started_at) VALUES (?, ?, ?, '{}', 0, 'running', ?, datetime('now'))`)
      .run("ci-fixer", "org/repo", 99, 999999);
    const r = recoverWorkOnStartup();
    expect(r.resetRunning).toBe(1);
    const rows = listQueuedWork();
    expect(rows[0].status).toBe("queued");
    expect(rows[0].pid).toBeNull();
  });

  it("pruneWorkQueue removes old completed/failed rows", () => {
    const db = _rawDb();
    db.prepare(`INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, completed_at) VALUES ('ci-fixer', 'org/repo', 1, '{}', 0, 'completed', datetime('now', '-30 days'))`).run();
    db.prepare(`INSERT INTO work_queue (kind, repo, item_number, args_json, priority, status, completed_at) VALUES ('ci-fixer', 'org/repo', 2, '{}', 0, 'completed', datetime('now'))`).run();
    const removed = pruneWorkQueue(168);
    expect(removed).toBe(1);
  });

  it("hasActiveWorkForPR returns true only for running rows of given kinds", () => {
    enqueueWork("ci-fixer", "org/repo", 42);
    expect(hasActiveWorkForPR("org/repo", 42, ["ci-fixer"])).toBe(false);
    claimNextWork(null);
    expect(hasActiveWorkForPR("org/repo", 42, ["ci-fixer"])).toBe(true);
    expect(hasActiveWorkForPR("org/repo", 42, ["pr-reviewer"])).toBe(false);
  });

  it("clearAllWorkQueueForTests empties the table", () => {
    enqueueWork("ci-fixer", "org/repo", 1);
    enqueueWork("ci-fixer", "org/repo", 2);
    expect(listQueuedWork()).toHaveLength(2);
    clearAllWorkQueueForTests();
    expect(listQueuedWork()).toHaveLength(0);
  });
});

describe("markUntrustedActorNotified", () => {
  beforeEach(() => {
    initDb();
  });

  afterEach(() => {
    closeDb();
  });

  it("returns true on first call for a repo/issue pair", () => {
    expect(markUntrustedActorNotified("o/r", 354)).toBe(true);
  });

  it("returns false on a duplicate call for the same repo/issue pair", () => {
    markUntrustedActorNotified("o/r", 354);
    expect(markUntrustedActorNotified("o/r", 354)).toBe(false);
  });

  it("returns true for a different issue number in the same repo", () => {
    markUntrustedActorNotified("o/r", 354);
    expect(markUntrustedActorNotified("o/r", 355)).toBe(true);
  });

  it("returns true for the same issue number in a different repo", () => {
    markUntrustedActorNotified("o/r", 354);
    expect(markUntrustedActorNotified("o/r2", 354)).toBe(true);
  });
});

describe("doc-maintainer intent backfill watermark", () => {
  beforeEach(() => {
    initDb();
  });

  afterEach(() => {
    closeDb();
  });

  it("returns null before the walk has started", () => {
    expect(getIntentBackfillState("o/r")).toBeNull();
  });

  it("round-trips a chunk watermark", () => {
    recordIntentBackfillChunk("o/r", "2026-01-15", false, false, 2);
    expect(getIntentBackfillState("o/r")).toEqual({ oldestScanned: "2026-01-15", complete: false, windowExhausted: false, sourceVersion: 2 });
  });

  it("upserts an existing repo row as the walk advances", () => {
    recordIntentBackfillChunk("o/r", "2026-01-15", false, false, 2);
    recordIntentBackfillChunk("o/r", "2025-08-02", true, false, 2);
    expect(getIntentBackfillState("o/r")).toEqual({ oldestScanned: "2025-08-02", complete: true, windowExhausted: false, sourceVersion: 2 });
  });

  it("tracks repos independently", () => {
    recordIntentBackfillChunk("o/r", "2026-01-15", true, false, 2);
    expect(getIntentBackfillState("o/r2")).toBeNull();
  });

  it("accepts a null oldestScanned for a repo with no history", () => {
    recordIntentBackfillChunk("o/r", null, true, false, 2);
    expect(getIntentBackfillState("o/r")).toEqual({ oldestScanned: null, complete: true, windowExhausted: false, sourceVersion: 2 });
  });

  it("records windowExhausted as a terminal state distinct from complete", () => {
    recordIntentBackfillChunk("o/r", "2025-08-02", false, true, 2);
    expect(getIntentBackfillState("o/r")).toEqual({ oldestScanned: "2025-08-02", complete: false, windowExhausted: true, sourceVersion: 2 });
  });

  it("reports sourceVersion 0 for a row written before the column existed", () => {
    // Simulate a pre-migration row: insert without the source_version column so the
    // DEFAULT 0 applies, exactly as an existing row gets it on ALTER TABLE.
    _rawDb().prepare(
      `INSERT INTO doc_intent_backfill (repo, oldest_scanned, complete, window_exhausted) VALUES (?, ?, 0, 0)`,
    ).run("o/legacy", "2025-01-01");
    expect(getIntentBackfillState("o/legacy")).toEqual({
      oldestScanned: "2025-01-01", complete: false, windowExhausted: false, sourceVersion: 0,
    });
  });
});

describe("doc-maintainer memory digest", () => {
  beforeEach(() => {
    initDb();
  });

  afterEach(() => {
    closeDb();
  });

  it("returns null before any digest has been recorded", () => {
    expect(getDocMemoryDigest("o/r")).toBeNull();
  });

  it("round-trips a digest", () => {
    recordDocMemoryDigest("o/r", "abc123");
    expect(getDocMemoryDigest("o/r")).toBe("abc123");
  });

  it("upserts on repeated writes", () => {
    recordDocMemoryDigest("o/r", "abc123");
    recordDocMemoryDigest("o/r", "def456");
    expect(getDocMemoryDigest("o/r")).toBe("def456");
  });

  it("writing a digest for a repo with an existing backfill watermark leaves it unchanged", () => {
    recordIntentBackfillChunk("o/r", "2026-01-15", true, false, 2);
    recordDocMemoryDigest("o/r", "abc123");
    expect(getIntentBackfillState("o/r")).toEqual({ oldestScanned: "2026-01-15", complete: true, windowExhausted: false, sourceVersion: 2 });
    expect(getDocMemoryDigest("o/r")).toBe("abc123");
  });

  it("recording a backfill chunk for a repo with an existing digest leaves it unchanged", () => {
    recordDocMemoryDigest("o/r", "abc123");
    recordIntentBackfillChunk("o/r", "2026-01-15", true, false, 2);
    expect(getDocMemoryDigest("o/r")).toBe("abc123");
  });
});

describe("queue snapshots", () => {
  beforeEach(() => {
    initDb();
  });

  afterEach(() => {
    closeDb();
  });

  it("recordQueueSnapshot and getQueueSnapshots round-trip", () => {
    recordQueueSnapshot(5);
    recordQueueSnapshot(10);

    const snapshots = getQueueSnapshots(24);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].totalItems).toBe(5);
    expect(snapshots[1].totalItems).toBe(10);
  });

  it("getQueueSnapshots returns empty when no snapshots exist", () => {
    expect(getQueueSnapshots()).toHaveLength(0);
  });

  it("pruneQueueSnapshots removes old entries", () => {
    const db = _rawDb();
    // Insert an old snapshot (5 days ago)
    db.prepare(
      `INSERT INTO queue_snapshots (total_items, recorded_at) VALUES (?, datetime('now', '-5 days'))`,
    ).run(42);
    // Insert a recent snapshot
    recordQueueSnapshot(7);

    // Prune snapshots older than 72 hours
    const pruned = pruneQueueSnapshots(72);
    expect(pruned).toBe(1);

    const remaining = getQueueSnapshots(200);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].totalItems).toBe(7);
  });

  it("pruneQueueSnapshots returns 0 when nothing to prune", () => {
    recordQueueSnapshot(5);
    expect(pruneQueueSnapshots(72)).toBe(0);
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
  beforeEach(() => {
    initDb();
  });

  afterEach(() => {
    closeDb();
  });

  it("upsertWorkflowRuns inserts rows and getWorkflowRunCount returns correct count", () => {
    expect(getWorkflowRunCount()).toBe(0);
    upsertWorkflowRuns([makeRun({ run_id: 1 }), makeRun({ run_id: 2 })]);
    expect(getWorkflowRunCount()).toBe(2);
  });

  it("upsertWorkflowRuns is a no-op for empty array", () => {
    upsertWorkflowRuns([]);
    expect(getWorkflowRunCount()).toBe(0);
  });

  it("upsertWorkflowRuns replaces existing row on conflict", () => {
    upsertWorkflowRuns([makeRun({ run_id: 1, status: "in_progress" })]);
    upsertWorkflowRuns([makeRun({ run_id: 1, status: "completed", conclusion: "success" })]);
    expect(getWorkflowRunCount()).toBe(1);
    const active = getActiveWorkflowRuns();
    // Should no longer be active after status updated to completed
    expect(active).toHaveLength(0);
  });

  it("getActiveWorkflowRuns returns queued and in_progress runs only", () => {
    upsertWorkflowRuns([
      makeRun({ run_id: 1, status: "queued", conclusion: null }),
      makeRun({ run_id: 2, status: "in_progress", conclusion: null }),
      makeRun({ run_id: 3, status: "completed", conclusion: "success" }),
    ]);
    const active = getActiveWorkflowRuns();
    expect(active).toHaveLength(2);
    expect(active.map(r => r.status)).toEqual(expect.arrayContaining(["queued", "in_progress"]));
  });

  it("getWorkflowRunStats returns repo stats aggregated over given days", () => {
    const now = Date.now();
    upsertWorkflowRuns([
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

    const stats = getWorkflowRunStats(7);
    expect(stats.repoStats).toHaveLength(1);
    const alpha = stats.repoStats[0];
    expect(alpha.repo).toBe("org/alpha");
    expect(alpha.total).toBe(2);
    expect(alpha.inProgress).toBe(1);
    expect(alpha.queued).toBe(0);
    expect(alpha.avgQueueWaitS).toBeGreaterThanOrEqual(0);
  });

  it("getWorkflowRunStats returns workflow stats aggregated over given days", () => {
    const now = Date.now();
    upsertWorkflowRuns([
      makeRun({ run_id: 1, workflow_name: "CI", created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(), updated_at: new Date(now - 1 * 60 * 60 * 1000).toISOString() }),
      makeRun({ run_id: 2, workflow_name: "CI", created_at: new Date(now - 1 * 60 * 60 * 1000).toISOString(), updated_at: new Date(now - 30 * 60 * 1000).toISOString() }),
      makeRun({ run_id: 3, workflow_name: "Deploy", created_at: new Date(now - 3 * 60 * 60 * 1000).toISOString(), updated_at: new Date(now - 2 * 60 * 60 * 1000).toISOString() }),
    ]);

    const stats = getWorkflowRunStats(7);
    expect(stats.workflowStats.length).toBeGreaterThanOrEqual(2);
    const ci = stats.workflowStats.find(w => w.workflowName === "CI");
    expect(ci).toBeDefined();
    expect(ci!.total).toBe(2);
    const deploy = stats.workflowStats.find(w => w.workflowName === "Deploy");
    expect(deploy).toBeDefined();
    expect(deploy!.total).toBe(1);
  });

  it("getWorkflowRunStats groups workflow stats by (repo, workflow_name) so same-named workflows in different repos are distinct", () => {
    const now = Date.now();
    upsertWorkflowRuns([
      makeRun({ run_id: 10, repo: "org/alpha", workflow_name: "CI", created_at: new Date(now - 60 * 60 * 1000).toISOString(), updated_at: new Date(now - 59 * 60 * 1000).toISOString() }),
      makeRun({ run_id: 11, repo: "org/alpha", workflow_name: "CI", created_at: new Date(now - 50 * 60 * 1000).toISOString(), updated_at: new Date(now - 49 * 60 * 1000).toISOString() }),
      makeRun({ run_id: 12, repo: "org/beta",  workflow_name: "CI", created_at: new Date(now - 40 * 60 * 1000).toISOString(), updated_at: new Date(now - 39 * 60 * 1000).toISOString() }),
    ]);

    const stats = getWorkflowRunStats(7);
    const alphaCI = stats.workflowStats.find(w => w.repo === "org/alpha" && w.workflowName === "CI");
    const betaCI  = stats.workflowStats.find(w => w.repo === "org/beta"  && w.workflowName === "CI");
    expect(alphaCI).toBeDefined();
    expect(betaCI).toBeDefined();
    expect(alphaCI!.total).toBe(2);
    expect(betaCI!.total).toBe(1);
  });

  it("getWorkflowRunStats excludes runs older than the given days", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO workflow_runs (run_id, repo, workflow_name, status, conclusion, event, head_branch, created_at, run_started_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-10 days'), NULL, datetime('now', '-10 days'), datetime('now'))`,
    ).run(99, "org/old", "CI", "completed", "success", "push", "main");

    const stats = getWorkflowRunStats(7);
    const old = stats.repoStats.find(r => r.repo === "org/old");
    expect(old).toBeUndefined();
  });

  it("getWorkflowRunStats excludes ISO 8601 rows inserted via upsertWorkflowRuns older than the given days", () => {
    upsertWorkflowRuns([makeRun({ run_id: 99, repo: "org/old-iso", created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() })]);
    const stats = getWorkflowRunStats(7);
    const old = stats.repoStats.find(r => r.repo === "org/old-iso");
    expect(old).toBeUndefined();
  });

  it("pruneWorkflowRuns removes old entries", () => {
    const db = _rawDb();
    // Insert an old run (35 days ago)
    db.prepare(
      `INSERT INTO workflow_runs (run_id, repo, workflow_name, status, conclusion, event, head_branch, created_at, run_started_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-35 days'), NULL, datetime('now', '-35 days'), datetime('now'))`,
    ).run(100, "org/repo", "CI", "completed", "success", "push", "main");
    // Insert a recent run
    upsertWorkflowRuns([makeRun({ run_id: 101 })]);
    expect(getWorkflowRunCount()).toBe(2);

    const pruned = pruneWorkflowRuns(30);
    expect(pruned).toBe(1);
    expect(getWorkflowRunCount()).toBe(1);
  });

  it("pruneWorkflowRuns prunes ISO 8601 rows inserted via upsertWorkflowRuns", () => {
    upsertWorkflowRuns([makeRun({ run_id: 100, created_at: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString() })]);
    upsertWorkflowRuns([makeRun({ run_id: 101 })]);
    expect(getWorkflowRunCount()).toBe(2);
    expect(pruneWorkflowRuns(30)).toBe(1);
    expect(getWorkflowRunCount()).toBe(1);
  });

  it("pruneWorkflowRuns returns 0 when nothing to prune", () => {
    upsertWorkflowRuns([makeRun({ run_id: 1 })]);
    expect(pruneWorkflowRuns(30)).toBe(0);
  });

  describe("Circuit Breaker Functions", () => {
    beforeEach(() => {
      // Reset database before each test
      initDb();
    });

    afterEach(() => {
      closeDb();
    });

    describe("ci_fixer_breaker state", () => {
      it("returns undefined for a PR the breaker never tripped on", () => {
        expect(getCIFixerBreakerState("test/repo", 1)).toBeUndefined();
      });

      it("round-trips a trip and a Claws push without clobbering each other", () => {
        recordCIFixerBreakerTrip("test/repo", 2, "aaa");
        recordCIFixerPush("test/repo", 2, "bbb");

        const state = getCIFixerBreakerState("test/repo", 2);
        expect(state?.trippedSha).toBe("aaa");
        expect(state?.trippedAt).toBeTruthy();
        expect(state?.lastClawsSha).toBe("bbb");
        expect(state?.grants).toBe(0);
      });

      it("re-tripping preserves grants and the budget floor", () => {
        recordCIFixerBreakerTrip("test/repo", 3, "aaa");
        recordCIFixerBreakerGrant("test/repo", 3, { recovered: false });
        const floor = getCIFixerBreakerState("test/repo", 3)?.budgetFloorAt;

        recordCIFixerBreakerTrip("test/repo", 3, "ccc");

        const state = getCIFixerBreakerState("test/repo", 3);
        expect(state?.trippedSha).toBe("ccc");
        expect(state?.grants).toBe(1);
        expect(state?.budgetFloorAt).toBe(floor);
      });

      it("spends a grant on a failing head and resets the count on a green one", () => {
        recordCIFixerBreakerTrip("test/repo", 4, "aaa");
        recordCIFixerBreakerGrant("test/repo", 4, { recovered: false });
        recordCIFixerBreakerGrant("test/repo", 4, { recovered: false });
        expect(getCIFixerBreakerState("test/repo", 4)?.grants).toBe(2);

        recordCIFixerBreakerGrant("test/repo", 4, { recovered: true });
        const state = getCIFixerBreakerState("test/repo", 4);
        expect(state?.grants).toBe(0);
        expect(state?.trippedSha).toBeNull();
        expect(state?.budgetFloorAt).toBeTruthy();
      });

      it("resetCIFixerBreakerGrants clears the trip and grants, keeping the Claws SHA", () => {
        recordCIFixerBreakerTrip("test/repo", 5, "aaa");
        recordCIFixerPush("test/repo", 5, "bbb");
        recordCIFixerBreakerGrant("test/repo", 5, { recovered: false });

        resetCIFixerBreakerGrants("test/repo", 5);

        const state = getCIFixerBreakerState("test/repo", 5);
        expect(state?.trippedSha).toBeNull();
        expect(state?.trippedAt).toBeNull();
        expect(state?.grants).toBe(0);
        expect(state?.budgetFloorAt).toBeTruthy();
        expect(state?.lastClawsSha).toBe("bbb");
      });

      it("resets cleanly for a PR with no prior row", () => {
        resetCIFixerBreakerGrants("test/repo", 6);
        expect(getCIFixerBreakerState("test/repo", 6)?.grants).toBe(0);
      });
    });

    describe("countCIFixerAttempts", () => {
      it("counts attempts within time window", () => {
        const repo = "test/repo";
        const prNumber = 123;
        
        // Insert tasks at different times
        const now = Date.now();
        const db = _rawDb();
        
        // Within window (last 24 hours)
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer", repo, prNumber, null, null, "completed", new Date(now - 2 * 60 * 60 * 1000).toISOString()
        );
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer", repo, prNumber, null, null, "failed", new Date(now - 5 * 60 * 60 * 1000).toISOString()
        );
        
        // Outside window (more than 24 hours ago)
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer", repo, prNumber, null, null, "completed", new Date(now - 30 * 60 * 60 * 1000).toISOString()
        );
        
        const result = countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(2);
        expect(result.successful).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.transientApiFailed).toBe(0);
      });

      it("correctly matches ci-fixer job name patterns", () => {
        const repo = "test/repo";
        const prNumber = 456;
        const db = _rawDb();
        const now = Date.now();
        
        // Should match
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer", repo, prNumber, null, null, "completed", new Date(now).toISOString()
        );
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer:variant", repo, prNumber, null, null, "failed", new Date(now).toISOString()
        );
        
        // Should NOT match
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer-v2", repo, prNumber, null, null, "completed", new Date(now).toISOString()
        );
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "other-job", repo, prNumber, null, null, "completed", new Date(now).toISOString()
        );
        
        const result = countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(2);
        expect(result.successful).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.transientApiFailed).toBe(0);
      });

      it("honours a budget floor newer than the window cutoff", () => {
        const repo = "test/repo";
        const prNumber = 321;
        const db = _rawDb();
        const now = Date.now();

        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer", repo, prNumber, null, null, "failed", new Date(now - 10 * 60 * 60 * 1000).toISOString(),
        );
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer", repo, prNumber, null, null, "failed", new Date(now - 1 * 60 * 60 * 1000).toISOString(),
        );

        const floor = new Date(now - 2 * 60 * 60 * 1000).toISOString();
        expect(countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000, floor).total).toBe(1);

        // A floor older than the window cutoff must not widen the window.
        const oldFloor = new Date(now - 48 * 60 * 60 * 1000).toISOString();
        expect(countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000, oldFloor).total).toBe(2);
        expect(countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000, null).total).toBe(2);
      });

      it("returns zero counts for PR with no attempts", () => {
        const result = countCIFixerAttempts("test/repo", 999, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(0);
        expect(result.successful).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.transientApiFailed).toBe(0);
      });

      it("counts transient-api failures separately and excludes them from nonTransientFailed", () => {
        const repo = "test/repo";
        const prNumber = 777;
        const db = _rawDb();
        const now = Date.now();

        // A regular failure (no outcome JSON)
        const id1 = recordTaskStart("ci-fixer", repo, prNumber, null);
        db.prepare(`UPDATE tasks SET started_at = ?, status = 'failed' WHERE id = ?`).run(
          new Date(now - 1 * 60 * 60 * 1000).toISOString(), id1,
        );

        // A transient-api failure (outcome JSON with failureCategory)
        const id2 = recordTaskStart("ci-fixer", repo, prNumber, null);
        db.prepare(`UPDATE tasks SET started_at = ? WHERE id = ?`).run(
          new Date(now - 2 * 60 * 60 * 1000).toISOString(), id2,
        );
        recordTaskFailed(id2, "API Error: 500 Internal server error", { failureCategory: "transient-api" });

        const result = countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(2);
        expect(result.failed).toBe(2);
        expect(result.successful).toBe(0);
        expect(result.transientApiFailed).toBe(1);
      });

      it("ignores ci-fixer:merge-conflict rows while still counting ci-fixer and ci-fixer:revert rows", () => {
        const repo = "test/repo";
        const prNumber = 888;
        const db = _rawDb();
        const now = Date.now();

        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer", repo, prNumber, null, null, "completed", new Date(now).toISOString()
        );
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer:revert", repo, prNumber, null, null, "failed", new Date(now).toISOString()
        );
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer:merge-conflict", repo, prNumber, null, null, "failed", new Date(now).toISOString()
        );

        const result = countCIFixerAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(2);
        expect(result.successful).toBe(1);
        expect(result.failed).toBe(1);
      });
    });

    describe("countConflictResolutionAttempts", () => {
      it("counts only ci-fixer:merge-conflict rows for that repo/PR", () => {
        const repo = "test/repo";
        const prNumber = 890;
        const db = _rawDb();
        const now = Date.now();

        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer:merge-conflict", repo, prNumber, null, null, "failed", new Date(now).toISOString()
        );
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer", repo, prNumber, null, null, "failed", new Date(now).toISOString()
        );
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer:merge-conflict", "other/repo", prNumber, null, null, "failed", new Date(now).toISOString()
        );

        const result = countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(1);
      });

      it("counts a completed row with commits in total but not unproductive; a no-commit completion and a failure both count as unproductive", () => {
        const repo = "test/repo";
        const prNumber = 891;
        const db = _rawDb();

        const id1 = recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        recordTaskComplete(id1, { commits: 2 });

        const id2 = recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        recordTaskComplete(id2, { commits: 0 });

        const id3 = recordTaskStart("ci-fixer:merge-conflict", repo, prNumber, null);
        recordTaskFailed(id3, "conflict resolution failed");

        const result = countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(3);
        expect(result.unproductive).toBe(2);
      });

      it("excludes rows outside the window", () => {
        const repo = "test/repo";
        const prNumber = 892;
        const db = _rawDb();
        const now = Date.now();

        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer:merge-conflict", repo, prNumber, null, null, "failed", new Date(now - 30 * 60 * 60 * 1000).toISOString()
        );

        const result = countConflictResolutionAttempts(repo, prNumber, 24 * 60 * 60 * 1000);

        expect(result.total).toBe(0);
        expect(result.unproductive).toBe(0);
      });
    });

    describe("getRecentCIFixerErrors", () => {
      it("returns recent errors in descending order", () => {
        const repo = "test/repo";
        const prNumber = 789;
        const db = _rawDb();
        const now = Date.now();
        
        // Insert failed tasks with errors
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer", repo, prNumber, null, null, "failed", new Date(now - 3000).toISOString(), new Date(now - 2000).toISOString(), "Error 1"
        );
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer", repo, prNumber, null, null, "failed", new Date(now - 2000).toISOString(), new Date(now - 1000).toISOString(), "Error 2"
        );
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer", repo, prNumber, null, null, "failed", new Date(now - 1000).toISOString(), new Date(now).toISOString(), "Error 3"
        );
        
        const errors = getRecentCIFixerErrors(repo, prNumber, 5);
        
        expect(errors).toHaveLength(3);
        expect(errors[0].error).toBe("Error 3"); // Most recent
        expect(errors[1].error).toBe("Error 2");
        expect(errors[2].error).toBe("Error 1"); // Oldest
      });

      it("respects limit parameter", () => {
        const repo = "test/repo";
        const prNumber = 321;
        const db = _rawDb();
        const now = Date.now();
        
        // Insert 5 errors
        for (let i = 1; i <= 5; i++) {
          db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            "ci-fixer", repo, prNumber, null, null, "failed", new Date(now - i * 1000).toISOString(), new Date(now - i * 1000 + 500).toISOString(), `Error ${i}`
          );
        }
        
        const errors = getRecentCIFixerErrors(repo, prNumber, 3);
        
        expect(errors).toHaveLength(3);
      });

      it("only returns failed tasks with errors", () => {
        const repo = "test/repo";
        const prNumber = 654;
        const db = _rawDb();
        const now = Date.now();
        
        // Failed with error - should be included
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer", repo, prNumber, null, null, "failed", new Date(now).toISOString(), new Date(now).toISOString(), "Valid error"
        );
        
        // Failed without error - should be excluded
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer", repo, prNumber, null, null, "failed", new Date(now).toISOString(), new Date(now).toISOString(), null
        );
        
        // Completed with error (shouldn't happen but test) - should be excluded
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer", repo, prNumber, null, null, "completed", new Date(now).toISOString(), new Date(now).toISOString(), "Should not appear"
        );
        
        const errors = getRecentCIFixerErrors(repo, prNumber, 5);
        
        expect(errors).toHaveLength(1);
        expect(errors[0].error).toBe("Valid error");
      });

      it("correctly matches ci-fixer job name patterns", () => {
        const repo = "test/repo";
        const prNumber = 987;
        const db = _rawDb();
        const now = Date.now();
        
        // Should match
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer", repo, prNumber, null, null, "failed", new Date(now).toISOString(), new Date(now).toISOString(), "Error from ci-fixer"
        );
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer:special", repo, prNumber, null, null, "failed", new Date(now).toISOString(), new Date(now).toISOString(), "Error from ci-fixer:special"
        );
        
        // Should NOT match
        db.prepare(`INSERT INTO tasks (job_name, repo, item_number, trigger_label, run_id, status, started_at, completed_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          "ci-fixer-new", repo, prNumber, null, null, "failed", new Date(now).toISOString(), new Date(now).toISOString(), "Should not appear"
        );
        
        const errors = getRecentCIFixerErrors(repo, prNumber, 5);

        expect(errors).toHaveLength(2);
      });
    });
  });

  describe("trackTaskTokens", () => {
    function getTokenRow(taskId: number) {
      return _rawDb()
        .prepare(`SELECT tokens_used, cost_usd, provider_used FROM tasks WHERE id = ?`)
        .get(taskId) as { tokens_used: number | null; cost_usd: number | null; provider_used: string | null };
    }

    it("single invocation writes tokens and cost to the task row", () => {
      const taskId = recordTaskStart("test-job", "org/repo", 1, null);
      const cb = trackTaskTokens(taskId);
      cb(100, 0.5);
      const row = getTokenRow(taskId);
      expect(row.tokens_used).toBe(100);
      expect(row.cost_usd).toBe(0.5);
    });

    it("two invocations of the same callback accumulate the totals", () => {
      const taskId = recordTaskStart("test-job", "org/repo", 2, null);
      const cb = trackTaskTokens(taskId);
      cb(10, 1);
      cb(5, 0.5);
      const row = getTokenRow(taskId);
      expect(row.tokens_used).toBe(15);
      expect(row.cost_usd).toBeCloseTo(1.5);
    });

    it("never invoking the callback leaves token/cost columns at their initial state", () => {
      const taskId = recordTaskStart("test-job", "org/repo", 3, null);
      trackTaskTokens(taskId); // returned callback intentionally not called
      const row = getTokenRow(taskId);
      expect(row.tokens_used).toBeNull();
      expect(row.cost_usd).toBeNull();
    });

    it("records the reporting provider when supplied", () => {
      const taskId = recordTaskStart("test-job", "org/repo", 4, null);
      const cb = trackTaskTokens(taskId);
      cb(100, 0.5, "opencode");
      const row = getTokenRow(taskId);
      expect(row.provider_used).toBe("opencode");
    });

    it("leaves provider_used null when no provider is supplied", () => {
      const taskId = recordTaskStart("test-job", "org/repo", 5, null);
      const cb = trackTaskTokens(taskId);
      cb(100, 0.5);
      const row = getTokenRow(taskId);
      expect(row.provider_used).toBeNull();
    });

    it("last reporter wins when a task spans two backends", () => {
      const taskId = recordTaskStart("test-job", "org/repo", 6, null);
      const cb = trackTaskTokens(taskId);
      cb(10, 1, "claude");
      cb(5, 0.5, "opencode");
      const row = getTokenRow(taskId);
      expect(row.provider_used).toBe("opencode");
      expect(row.tokens_used).toBe(15);
    });
  });

  describe("getUsageStats", () => {
    beforeEach(() => {
      const t1 = recordTaskStart("issue-worker", "org/repo-a", 1, null);
      updateTaskTokenUsage(t1, 100, 1.0);
      updateTaskProvider(t1, "opencode");
      updateTaskModel(t1, "openrouter/z-ai/glm-5.3");

      const t2 = recordTaskStart("issue-worker", "org/repo-b", 2, null);
      updateTaskTokenUsage(t2, 200, 2.0);
      updateTaskProvider(t2, "claude");
      updateTaskModel(t2, "sonnet");

      const t3 = recordTaskStart("ci-fixer:revert", "org/repo-a", 3, null);
      updateTaskTokenUsage(t3, 50, 0.5);
      // no provider/model — historical row

      const t4 = recordTaskStart("ci-fixer:retry", "org/repo-b", 4, null);
      updateTaskTokenUsage(t4, 25, 0.25);
      updateTaskProvider(t4, "codex");
      updateTaskModel(t4, "gpt-5.1-codex");
    });

    it("unfiltered providerStats includes both attributed and unknown rows", () => {
      const stats = getUsageStats(7);
      expect(stats.providerStats).toContainEqual(
        expect.objectContaining({ provider: "opencode", model: "openrouter/z-ai/glm-5.3" }),
      );
      expect(stats.providerStats).toContainEqual(
        expect.objectContaining({ provider: "unknown", model: "unknown" }),
      );
    });

    it("filters by provider and narrows repoStats accordingly", () => {
      const stats = getUsageStats(7, { provider: "opencode" });
      expect(stats.providerStats).toHaveLength(1);
      expect(stats.providerStats[0]).toMatchObject({ provider: "opencode", model: "openrouter/z-ai/glm-5.3" });
      expect(stats.repoStats.map((r) => r.repo)).toEqual(["org/repo-a"]);
    });

    it("filters by repo and narrows jobStats accordingly", () => {
      const stats = getUsageStats(7, { repo: "org/repo-b" });
      const jobNames = stats.jobStats.map((j) => j.jobName).sort();
      expect(jobNames).toEqual(["ci-fixer", "issue-worker"]);
    });

    it("filters by job prefix and matches sub-jobs recorded with a colon suffix", () => {
      const stats = getUsageStats(7, { job: "ci-fixer" });
      expect(stats.jobStats).toHaveLength(1);
      expect(stats.jobStats[0]).toMatchObject({ jobName: "ci-fixer", taskCount: 2 });
    });

    it("getTotalUsage filters by unknown provider", () => {
      const totals = getTotalUsage(7, { provider: "unknown" });
      expect(totals.taskCount).toBe(1);
      expect(totals.totalTokens).toBe(50);
      expect(totals.totalCostUsd).toBeCloseTo(0.5);
    });

    it("getUsageFilterOptions returns distinct repos/jobs/providers/models including unknown", () => {
      const options = getUsageFilterOptions(7);
      expect(options.repos.sort()).toEqual(["org/repo-a", "org/repo-b"]);
      expect(options.jobs.sort()).toEqual(["ci-fixer", "issue-worker"]);
      expect(options.providers.sort()).toEqual(["claude", "codex", "opencode", "unknown"]);
      expect(options.models.sort()).toEqual(["gpt-5.1-codex", "openrouter/z-ai/glm-5.3", "sonnet", "unknown"]);
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

    function rowCount(): number {
      return (_rawDb()!.prepare(`SELECT COUNT(*) AS n FROM dmarc_rows`).get() as { n: number }).n;
    }

    it("inserts once and ignores a duplicate re-forwarded report", () => {
      expect(insertDmarcReport(report, "<feedback/>", "2026-09-01T08:00:00.000Z")).toBe(true);
      expect(rowCount()).toBe(1);

      expect(insertDmarcReport(report, "<feedback/>", "2026-09-01T09:00:00.000Z")).toBe(false);
      expect(rowCount()).toBe(1);
      expect(hasDmarcReport("google.com", "1785249275027635048")).toBe(true);
    });

    it("keeps raw XML off the row queries but retrievable by report key", () => {
      insertDmarcReport(report, "<feedback>raw</feedback>", "2026-09-01T08:00:00.000Z");

      const latest = getLatestDmarcReportForDomain("bstjohn.net");
      expect(latest?.report_id).toBe("1785249275027635048");
      expect(latest?.row_count).toBe(1);
      expect(latest).not.toHaveProperty("raw_xml");
      expect(getDmarcReportXml("google.com", "1785249275027635048")).toBe("<feedback>raw</feedback>");
    });

    it("aggregates verdict counts and source IPs over a window", () => {
      insertDmarcReport(report, "<feedback/>", "2026-09-01T08:00:00.000Z");

      expect(getDmarcVerdictCounts("2026-08-01T00:00:00.000Z")).toEqual([
        { domain: "bstjohn.net", verdict: "aligned_pass", n: 1 },
      ]);
      expect(getDmarcSourceIps("2026-08-01T00:00:00.000Z")).toEqual([
        {
          source_ip: "209.85.220.69",
          verdict: "aligned_pass",
          domain: "bstjohn.net",
          messages: 1,
          last_seen: "2026-08-31T23:59:59.000Z",
        },
      ]);
      expect(getDmarcVerdictCounts("2026-09-01T00:00:00.000Z")).toEqual([]);
    });

    it("getLatestDmarcReportsPerReporter returns the columns of the latest report per (domain, reporter)", () => {
      insertDmarcReport(report, "<feedback/>", "2026-09-01T08:00:00.000Z");
      const laterReport = {
        ...report,
        reportId: "1785249275027635049",
        dateBegin: "2026-09-05T00:00:00.000Z",
        dateEnd: "2026-09-05T23:59:59.000Z",
        rows: [report.rows[0], report.rows[0]],
      };
      insertDmarcReport(laterReport, "<feedback/>", "2026-09-06T08:00:00.000Z");

      const latest = getLatestDmarcReportsPerReporter();
      expect(latest).toHaveLength(1);
      expect(latest[0].report_id).toBe("1785249275027635049");
      expect(latest[0].row_count).toBe(2);
      expect(latest[0].date_begin).toBe("2026-09-05T00:00:00.000Z");
    });

    it("pruneDmarcReports removes reports and rows past the retention window", () => {
      insertDmarcReport(report, "<feedback/>", "2026-09-01T08:00:00.000Z");
      const oldReport = { ...report, reportId: "old-report-id" };
      insertDmarcReport(oldReport, "<feedback/>", "2026-09-01T08:00:00.000Z");

      const db = _rawDb();
      db.prepare(`UPDATE dmarc_reports SET received_at = datetime('now', '-400 days') WHERE report_id = ?`).run("old-report-id");
      db.prepare(`UPDATE dmarc_rows SET received_at = datetime('now', '-400 days') WHERE report_id = ?`).run("old-report-id");

      expect(pruneDmarcReports(365)).toBe(1);
      expect(hasDmarcReport("google.com", "old-report-id")).toBe(false);
      expect(hasDmarcReport("google.com", "1785249275027635048")).toBe(true);
      expect(rowCount()).toBe(1);
      expect(pruneDmarcReports(365)).toBe(0);
    });
  });

  describe("damp readings", () => {
    it("getRecentDampReadings returns rows newest-first", () => {
      upsertDampReading("Hall Closet", "Manifold", 12, "2026-06-01", "2026-06-01T09:00:00.000Z");
      upsertDampReading("Hall Closet", "Manifold", 15, "2026-06-15", "2026-06-15T09:00:00.000Z");

      const rows = getRecentDampReadings().filter((r) => r.point === "Manifold");
      expect(rows).toHaveLength(2);
      expect(rows[0].reading_date).toBe("2026-06-15");
      expect(rows[0].value).toBe(15);
      expect(rows[1].reading_date).toBe("2026-06-01");
      expect(rows[1].value).toBe(12);
    });

    it("getDampTrendRows orders the latest reading first per point", () => {
      upsertDampReading("Hall Closet", "Manifold", 12, "2026-06-01", "2026-06-01T09:00:00.000Z");
      upsertDampReading("Hall Closet", "Manifold", 15, "2026-06-15", "2026-06-15T09:00:00.000Z");

      const rows = getDampTrendRows().filter((r) => r.point === "Manifold");
      expect(rows).toHaveLength(2);
      expect(rows[0].value).toBe(15);
      expect(rows[1].value).toBe(12);
    });

    it("seeds a Hall Closet / utility reading of 0.5 on 2026-07-02 (issue #1824)", () => {
      const seeded = getRecentDampReadings().filter((r) => r.location === "Hall Closet" && r.point === "utility");
      expect(seeded).toHaveLength(1);
      expect(seeded[0].value).toBe(0.5);
      expect(seeded[0].reading_date).toBe("2026-07-02");
    });

    it("does not duplicate the Hall Closet / utility seed when the backfill guard runs again against a database that already has the row", () => {
      // beforeEach's initDb() has already seeded one row on this in-memory db.
      // Re-run the exact guard from db.ts's backfill against that *same*
      // database handle (not a fresh initDb() call, which would open a brand
      // new isolated in-memory db and never exercise the guard against
      // pre-existing data) to prove COUNT(*) === 0 prevents a duplicate insert.
      const db = _rawDb();
      const countStmt = db.prepare(
        `SELECT COUNT(*) AS n FROM damp_readings WHERE location = ? AND point = ?`,
      );

      const before = countStmt.get("Hall Closet", "utility") as { n: number };
      expect(before.n).toBe(1);

      const dampSeed = countStmt.get("Hall Closet", "utility") as { n: number };
      if (dampSeed.n === 0) {
        db.prepare(
          `INSERT INTO damp_readings (location, point, value, reading_date, recorded_at) VALUES (?, ?, ?, ?, ?)`,
        ).run("Hall Closet", "utility", 0.5, "2026-07-02", "2026-07-02T00:00:00.000Z");
      }

      const after = countStmt.get("Hall Closet", "utility") as { n: number };
      expect(after.n).toBe(1);
    });

    it("upsertDampReading updates the existing row for the same location/point/date", () => {
      upsertDampReading("Utility wall", "left", 1.2, "2026-07-01", "2026-07-01T09:00:00.000Z");
      let rows = getRecentDampReadings().filter((r) => r.location === "Utility wall" && r.point === "left");
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe(1.2);

      upsertDampReading("Utility wall", "left", 1.8, "2026-07-01", "2026-07-01T10:00:00.000Z");
      rows = getRecentDampReadings().filter((r) => r.location === "Utility wall" && r.point === "left");
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe(1.8);
      expect(rows[0].recorded_at).toBe("2026-07-01T10:00:00.000Z");

      upsertDampReading("Utility wall", "left", 2.1, "2026-07-02", "2026-07-02T09:00:00.000Z");
      rows = getRecentDampReadings().filter((r) => r.location === "Utility wall" && r.point === "left");
      expect(rows).toHaveLength(2);
    });

    it("deleteDampReading removes only the row matching location/point/date", () => {
      upsertDampReading("Utility wall", "left", 1.2, "2026-07-01", "2026-07-01T09:00:00.000Z");
      upsertDampReading("Utility wall", "left", 2.1, "2026-07-02", "2026-07-02T09:00:00.000Z");
      upsertDampReading("Utility wall", "right", 1.5, "2026-07-01", "2026-07-01T09:00:00.000Z");

      deleteDampReading("Utility wall", "left", "2026-07-01");

      const rows = getRecentDampReadings().filter((r) => r.location === "Utility wall");
      expect(rows).toHaveLength(2);
      expect(rows.some((r) => r.point === "left" && r.reading_date === "2026-07-01")).toBe(false);
      expect(rows.some((r) => r.point === "left" && r.reading_date === "2026-07-02")).toBe(true);
      expect(rows.some((r) => r.point === "right" && r.reading_date === "2026-07-01")).toBe(true);
    });

    it("deleteDampReading is a no-op when no matching row exists", () => {
      expect(() => deleteDampReading("Nonexistent", "left", "2026-07-01")).not.toThrow();
    });
  });

  describe("blog drafts", () => {
    it("upsertBlogDraft then getBlogDraft round-trips the draft as status 'draft'", () => {
      upsertBlogDraft(
        "org/repo",
        "src/content/blog/hello.md",
        "---\ntitle: Hello\n---\nbody",
        "abc123",
        "Hello",
        "2026-07-01T00:00:00.000Z",
      );

      const draft = getBlogDraft("org/repo", "src/content/blog/hello.md");
      expect(draft).not.toBeNull();
      expect(draft?.content).toBe("---\ntitle: Hello\n---\nbody");
      expect(draft?.base_sha).toBe("abc123");
      expect(draft?.title).toBe("Hello");
      expect(draft?.status).toBe("draft");
      expect(draft?.pr_number).toBeNull();
      expect(draft?.pr_branch).toBeNull();
    });

    it("getBlogDraft returns null when no draft exists for the repo/path", () => {
      expect(getBlogDraft("org/repo", "src/content/blog/missing.md")).toBeNull();
    });

    it("re-editing a pushed draft resets its status back to 'draft'", () => {
      upsertBlogDraft("org/repo", "src/content/blog/hello.md", "v1", "sha1", "Hello", "2026-07-01T00:00:00.000Z");
      setBlogDraftPushed("org/repo", "src/content/blog/hello.md", 42, "claws/blog-hello-1");

      let draft = getBlogDraft("org/repo", "src/content/blog/hello.md");
      expect(draft?.status).toBe("pushed");
      expect(draft?.pr_number).toBe(42);
      expect(draft?.pr_branch).toBe("claws/blog-hello-1");

      upsertBlogDraft("org/repo", "src/content/blog/hello.md", "v2", "sha2", "Hello", "2026-07-02T00:00:00.000Z");

      draft = getBlogDraft("org/repo", "src/content/blog/hello.md");
      expect(draft?.status).toBe("draft");
      expect(draft?.content).toBe("v2");
      expect(draft?.base_sha).toBe("sha2");
      // pr_number / pr_branch columns are left untouched by the upsert's ON CONFLICT clause.
      expect(draft?.pr_number).toBe(42);
      expect(draft?.pr_branch).toBe("claws/blog-hello-1");
    });

    it("listBlogDrafts orders drafts newest-updated-first, scoped to the given repo", () => {
      upsertBlogDraft("org/repo", "src/content/blog/a.md", "a", null, "A", "2026-07-01T00:00:00.000Z");
      upsertBlogDraft("org/repo", "src/content/blog/b.md", "b", null, "B", "2026-07-03T00:00:00.000Z");
      upsertBlogDraft("org/repo", "src/content/blog/c.md", "c", null, "C", "2026-07-02T00:00:00.000Z");
      upsertBlogDraft("org/other-repo", "src/content/blog/d.md", "d", null, "D", "2026-07-04T00:00:00.000Z");

      const drafts = listBlogDrafts("org/repo");
      expect(drafts.map((d) => d.path)).toEqual([
        "src/content/blog/b.md",
        "src/content/blog/c.md",
        "src/content/blog/a.md",
      ]);
    });

    it("setBlogDraftPushed marks a draft pushed with its PR number and branch", () => {
      upsertBlogDraft("org/repo", "src/content/blog/hello.md", "v1", "sha1", "Hello", "2026-07-01T00:00:00.000Z");
      setBlogDraftPushed("org/repo", "src/content/blog/hello.md", 99, "claws/blog-hello-2");

      const draft = getBlogDraft("org/repo", "src/content/blog/hello.md");
      expect(draft?.status).toBe("pushed");
      expect(draft?.pr_number).toBe(99);
      expect(draft?.pr_branch).toBe("claws/blog-hello-2");
    });

    it("clearBlogDraftPR nulls the PR pointer and resets status to 'draft'", () => {
      upsertBlogDraft("org/repo", "src/content/blog/hello.md", "v1", "sha1", "Hello", "2026-07-01T00:00:00.000Z");
      setBlogDraftPushed("org/repo", "src/content/blog/hello.md", 99, "claws/blog-hello-2");

      clearBlogDraftPR("org/repo", "src/content/blog/hello.md");

      const draft = getBlogDraft("org/repo", "src/content/blog/hello.md");
      expect(draft?.status).toBe("draft");
      expect(draft?.pr_number).toBeNull();
      expect(draft?.pr_branch).toBeNull();
    });
  });

  describe("shopping searches", () => {
    it("recordShoppingSearch then getShoppingSearches round-trips the stored result", () => {
      recordShoppingSearch("org/repo", "nas.yaml", "hba", JSON.stringify({ candidates: [{ title: "A" }] }));

      const rows = getShoppingSearches("org/repo", "nas.yaml");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.itemId).toBe("hba");
      expect(JSON.parse(rows[0]!.resultJson).candidates[0].title).toBe("A");
      expect(rows[0]!.lastSearchedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it("recordShoppingSearch overwrites the result for an existing item", () => {
      recordShoppingSearch("org/repo", "nas.yaml", "hba", JSON.stringify({ candidates: [] }));
      recordShoppingSearch("org/repo", "nas.yaml", "hba", JSON.stringify({ candidates: [{ title: "B" }] }));

      const rows = getShoppingSearches("org/repo", "nas.yaml");
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.resultJson).candidates[0].title).toBe("B");
    });

    it("getShoppingSearches scopes results to the repo and manifest", () => {
      recordShoppingSearch("org/repo", "nas.yaml", "hba", "{}");
      recordShoppingSearch("org/repo", "heating.yaml", "valve", "{}");
      recordShoppingSearch("org/other", "nas.yaml", "hba", "{}");

      expect(getShoppingSearches("org/repo", "nas.yaml").map((r) => r.itemId)).toEqual(["hba"]);
      expect(getShoppingSearches("org/repo", "heating.yaml").map((r) => r.itemId)).toEqual(["valve"]);
      expect(getShoppingSearches("org/repo", "missing.yaml")).toEqual([]);
    });
  });

  describe("session pruning", () => {
    it("pruneEndedSessions deletes exactly the selected ended rows when timestamps tie", () => {
      insertSession({
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
      });
      insertSession({
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
      });
      insertSession({
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
      });
      insertSession({
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
      });
      insertSession({
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
      });

      for (const id of ["keep-b", "keep-a", "prune-b", "prune-a"]) {
        markSessionEnded(id, 1_000, JSON.stringify([]));
      }

      expect(getEndedSessions().map((row) => row.id)).toEqual([
        "prune-b",
        "prune-a",
        "keep-b",
        "keep-a",
      ]);
      expect(pruneEndedSessions(2)).toEqual(["keep-b", "keep-a"]);
      expect(getEndedSessions().map((row) => row.id)).toEqual(["prune-b", "prune-a"]);
      expect(getAllPersistedSessions().map((row) => row.id)).toEqual(["live"]);
    });

    it("pruneEndedSessions deletes large batches without exceeding SQLite bind limits", () => {
      for (let i = 0; i < 1105; i += 1) {
        insertSession({
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
        });
        markSessionEnded(`ended-${i}`, i, JSON.stringify([]));
      }

      const pruned = pruneEndedSessions(0);

      expect(pruned).toHaveLength(1105);
      expect(getEndedSessions()).toEqual([]);
      expect(getAllPersistedSessions()).toEqual([]);
    });
  });

  describe("setManualSessionSummary", () => {
    function insertPlainSession(id: string): void {
      insertSession({
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
      });
    }

    it("sets the summary and pins it against updateSessionSummary", () => {
      insertPlainSession("pin-1");

      expect(setManualSessionSummary("pin-1", "My manual description", 500)).toBe(true);

      let row = getAllPersistedSessions().find((r) => r.id === "pin-1");
      expect(row?.summary).toBe("My manual description");
      expect(row?.summary_manual).toBe(1);

      updateSessionSummary("pin-1", "Auto summary", 999);

      row = getAllPersistedSessions().find((r) => r.id === "pin-1");
      expect(row?.summary).toBe("My manual description");
      expect(row?.summary_manual).toBe(1);
    });

    it("clears the pin when summary is null, allowing updateSessionSummary to write again", () => {
      insertPlainSession("pin-2");
      setManualSessionSummary("pin-2", "My manual description", 500);

      expect(setManualSessionSummary("pin-2", null, null)).toBe(true);

      let row = getAllPersistedSessions().find((r) => r.id === "pin-2");
      expect(row?.summary).toBeNull();
      expect(row?.summary_manual).toBe(0);

      updateSessionSummary("pin-2", "Auto summary", 999);

      row = getAllPersistedSessions().find((r) => r.id === "pin-2");
      expect(row?.summary).toBe("Auto summary");
      expect(row?.summary_manual).toBe(0);
    });
  });

  describe("ha entity unavailable tracking", () => {
    it("first-seen timestamp is sticky across repeated calls, and resets after clearing", () => {
      expect(recordHaEntityUnavailable("x", 1000)).toBe(1000);
      expect(recordHaEntityUnavailable("x", 9000)).toBe(1000);

      clearHaEntityUnavailable("x");

      expect(recordHaEntityUnavailable("x", 5000)).toBe(5000);
    });
  });

});

describe("main build failures", () => {
  beforeEach(() => {
    initDb();
  });

  afterEach(() => {
    closeDb();
  });

  it("records a failure, finds it by run id, and tracks a pending retry to its outcome", () => {
    expect(hasMainBuildFailure("1")).toBe(false);

    recordMainBuildFailure("1", "org/repo", "CI", "https://example.invalid/run/1", true, null);
    expect(hasMainBuildFailure("1")).toBe(true);

    const pending = getPendingMainBuildRetries();
    expect(pending).toHaveLength(1);
    expect(pending[0].workflow_name).toBe("CI");
    expect(pending[0].run_url).toBe("https://example.invalid/run/1");

    setMainBuildRetryOutcome("1", "failure");
    expect(getPendingMainBuildRetries()).toHaveLength(0);
  });

  it("a failure that was never retried is not pending", () => {
    recordMainBuildFailure("2", "org/repo", "CI", "https://example.invalid/run/2", false, "not-retried");
    expect(getPendingMainBuildRetries()).toHaveLength(0);
  });

  it("getExpiredMainBuildRetries finds retries stuck past 24h, not fresh pending ones", () => {
    recordMainBuildFailure("9", "org/repo", "CI", "https://example.invalid/run/9", true, null);
    expect(getPendingMainBuildRetries().map((r) => r.run_id)).toEqual(["9"]);
    expect(getExpiredMainBuildRetries()).toHaveLength(0);

    const db = _rawDb();
    db.prepare(
      `UPDATE main_build_failures SET detected_at = datetime('now', '-25 hours') WHERE run_id = ?`,
    ).run("9");

    expect(getPendingMainBuildRetries()).toHaveLength(0);
    const expired = getExpiredMainBuildRetries();
    expect(expired).toHaveLength(1);
    expect(expired[0].run_id).toBe("9");

    setMainBuildRetryOutcome("9", "retry-timed-out");
    expect(getExpiredMainBuildRetries()).toHaveLength(0);
  });

  it("reported failures stay unclosed until marked closed", () => {
    recordMainBuildFailure("3", "org/repo", "CI", "https://example.invalid/run/3", false, "not-retried");
    expect(hasUnclosedReportedFailure("org/repo", "CI")).toBe(false);

    markMainBuildReported("3");
    expect(hasUnclosedReportedFailure("org/repo", "CI")).toBe(true);
    // Scoped to the repo+workflow pair.
    expect(hasUnclosedReportedFailure("org/repo", "Release")).toBe(false);

    markMainBuildFailuresClosed("org/repo", "CI");
    expect(hasUnclosedReportedFailure("org/repo", "CI")).toBe(false);
  });

  it("getUnreportedMainBuildFailures finds terminal rows that never got reported", () => {
    // Never retried, reported failed: must be retried.
    recordMainBuildFailure("4", "org/repo", "CI", "https://example.invalid/run/4", false, "not-retried", "push");
    // Retried and failed again, reported failed: must be retried.
    recordMainBuildFailure("5", "org/repo", "Release", "https://example.invalid/run/5", true, null, "push");
    setMainBuildRetryOutcome("5", "failure");
    // Reported successfully: excluded.
    recordMainBuildFailure("6", "org/repo", "Docs", "https://example.invalid/run/6", false, "not-retried", "push");
    markMainBuildReported("6");
    // Retry still pending (outcome NULL): excluded — handled by getPendingMainBuildRetries.
    recordMainBuildFailure("7", "org/repo", "Lint", "https://example.invalid/run/7", true, null, "push");
    // Retry succeeded: excluded, no report was ever needed.
    recordMainBuildFailure("8", "org/repo", "Test", "https://example.invalid/run/8", true, null, "push");
    setMainBuildRetryOutcome("8", "success");
    // Retry timed out after 24h with no verdict: must be retried, same as a genuine failure.
    recordMainBuildFailure("9", "org/repo", "Lint2", "https://example.invalid/run/9", true, null, "push");
    setMainBuildRetryOutcome("9", "retry-timed-out");

    const unreported = getUnreportedMainBuildFailures().map((r) => r.run_id).sort();
    expect(unreported).toEqual(["4", "5", "9"]);
  });

  it("pruneMainBuildFailures removes rows older than retentionDays and returns the count", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO main_build_failures (run_id, repo, workflow_name, run_url, detected_at, retried, outcome, reported)
       VALUES (?, ?, ?, ?, datetime('now', '-35 days'), 0, 'not-retried', 1)`,
    ).run("old-1", "org/repo", "CI", "https://example.invalid/run/old-1");
    recordMainBuildFailure("recent-1", "org/repo", "CI", "https://example.invalid/run/recent-1", false, "not-retried");

    const pruned = pruneMainBuildFailures(30);
    expect(pruned).toBe(1);
    expect(hasMainBuildFailure("old-1")).toBe(false);
    expect(hasMainBuildFailure("recent-1")).toBe(true);
  });

  it("pruneMainBuildFailures returns 0 when nothing to prune", () => {
    recordMainBuildFailure("recent-2", "org/repo", "CI", "https://example.invalid/run/recent-2", false, "not-retried");
    expect(pruneMainBuildFailures(30)).toBe(0);
  });

  it("getDefaultBranchRuns excludes pull_request runs and other branches", () => {
    upsertWorkflowRuns([
      makeRun({ run_id: 1, workflow_name: "CI", event: "push", head_branch: "main" }),
      makeRun({ run_id: 2, workflow_name: "Nightly", event: "schedule", head_branch: "main" }),
      makeRun({ run_id: 3, workflow_name: "CI", event: "pull_request", head_branch: "main" }),
      makeRun({ run_id: 4, workflow_name: "CI", event: "push", head_branch: "feature" }),
    ]);

    const rows = getDefaultBranchRuns("org/repo", "main", 7);
    expect(rows.map((r) => r.run_id).sort()).toEqual([1, 2]);
    expect(rows[0].head_sha).toBe("abc123");
    expect(rows[0].run_attempt).toBe(1);
  });
});
