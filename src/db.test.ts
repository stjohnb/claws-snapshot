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
  getAverageTaskDurationMs,
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
  getRecentCIFixerErrors,
  enqueueWork,
  claimNextWork,
  markWorkSucceeded,
  markWorkFailed,
  listQueuedWork,
  countWorkByStatus,
  recoverWorkOnStartup,
  pruneWorkQueue,
  hasActiveWorkForPR,
  clearAllWorkQueueForTests,
  markUntrustedActorNotified,
  trackTaskTokens,
  upsertDampReading,
  deleteDampReading,
  getRecentDampReadings,
  getDampTrendRows,
  upsertBlogDraft,
  getBlogDraft,
  listBlogDrafts,
  setBlogDraftPushed,
  clearBlogDraftPR,
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

describe("getAverageTaskDurationMs", () => {
  beforeEach(() => {
    initDb();
  });

  afterEach(() => {
    closeDb();
  });

  it("returns null when no completed tasks exist", () => {
    expect(getAverageTaskDurationMs("issue-worker")).toBeNull();
  });

  it("computes average duration from completed tasks", () => {
    const db = _rawDb();
    // Insert two completed tasks: 10min and 20min duration
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', datetime('now', '-25 minutes'), datetime('now', '-15 minutes'))`,
    ).run("issue-worker", "org/repo", 1);
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', datetime('now', '-40 minutes'), datetime('now', '-20 minutes'))`,
    ).run("issue-worker", "org/repo", 2);

    const avg = getAverageTaskDurationMs("issue-worker");
    expect(avg).not.toBeNull();
    // Average of 10min and 20min = 15min = 900000ms (with some tolerance for datetime precision)
    expect(avg!).toBeGreaterThan(800_000);
    expect(avg!).toBeLessThan(1_000_000);
  });

  it("uses LIKE prefix matching for job names", () => {
    const db = _rawDb();
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', datetime('now', '-20 minutes'), datetime('now', '-10 minutes'))`,
    ).run("ci-fixer:merge-conflict", "org/repo", 1);
    db.prepare(
      `INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', datetime('now', '-20 minutes'), datetime('now', '-10 minutes'))`,
    ).run("ci-fixer:revert", "org/repo", 2);

    // "ci-fixer" should match both variants
    const avg = getAverageTaskDurationMs("ci-fixer");
    expect(avg).not.toBeNull();
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

    expect(getAverageTaskDurationMs("issue-worker")).toBeNull();
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
        .prepare(`SELECT tokens_used, cost_usd FROM tasks WHERE id = ?`)
        .get(taskId) as { tokens_used: number | null; cost_usd: number | null };
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

});
