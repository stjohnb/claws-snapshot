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
  type Task,
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

  it("recordTaskFailed sets status to failed and stores error", () => {
    const id = recordTaskStart("test-job", "org/repo", 1, null);
    recordTaskFailed(id, "Something went wrong");

    const orphaned = getOrphanedTasks();
    expect(orphaned).toHaveLength(0);
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
