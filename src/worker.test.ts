import type { IssueRef } from "./issue-id.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const backendState = vi.hoisted(() => ({ workBackend: "in-process" as "in-process" | "k8s-pod" }));
vi.mock("./config.js", () => ({
  get WORK_BACKEND() { return backendState.workBackend; },
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
  MAX_WORK_WORKERS: 2,
  // workerStatus() reads the live admission gate, which materialises the gate
  // from these settings rather than reporting "inactive" before the first spawn.
  AGENT_WORKER_MEMORY_MAX_BYTES: 2 * 1024 * 1024 * 1024,
  AGENT_WORKER_MEMORY_HEADROOM_BYTES: 1280 * 1024 * 1024,
  AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES: undefined,
  shouldRunWorkPipeline: () => true,
}));

vi.mock("./log.js", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    runContext: new AsyncLocalStorage(),
    withRunContext: async (_runId: string, fn: () => Promise<unknown>) => fn(),
  };
});

const shutdownState = vi.hoisted(() => ({ shuttingDown: false }));
vi.mock("./shutdown.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shutdown.js")>();
  return { ...actual, isShuttingDown: () => shutdownState.shuttingDown };
});

vi.mock("./error-reporter.js", () => ({
  reportError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./timeout-handler.js", () => ({
  handleTimeoutIfApplicable: vi.fn().mockResolvedValue(undefined),
  handleMemoryLimitIfApplicable: vi.fn().mockResolvedValue(undefined),
}));

const ghMock = vi.hoisted(() => ({
  getPRMergeGate: vi.fn(),
  getIssueState: vi.fn(),
}));
vi.mock("./github.js", () => ({
  RateLimitError: class RateLimitError extends Error {},
  getPRMergeGate: ghMock.getPRMergeGate,
  getIssueState: ghMock.getIssueState,
  isParked: (labels: { name: string }[]) => labels.some((l) => ["Claws Ignore", "Blocked", "Backlog"].includes(l.name)),
  isItemSkipped: () => false,
  hasPriorityLabel: (labels: { name: string }[]) => labels.some((l) => l.name === "Priority"),
}));

const launcherMock = vi.hoisted(() => ({ runRowInPod: vi.fn() }));
vi.mock("./agent-pod-launcher.js", () => ({ getAgentPodLauncher: () => launcherMock }));

import {
  initDb,
  closeDb,
  clearAllWorkQueueForTests,
  listQueuedWork,
  countWorkByStatus,
  claimNextWork,
  markWorkSucceeded,
  getLatestRunIdsByJob,
  getJobRun,
  getWorkRow,
  setWorkAgentPod,
  _rawDb,
  type WorkQueueRow,
} from "./db.js";
import { ShutdownError } from "./shutdown.js";
import { RateLimitError } from "./github.js";
import * as log from "./log.js";
import { enqueue, _resetForTests, _stopForTests, AGENT_KINDS, ISSUE_SCOPED_KINDS, PR_SCOPED_KINDS, REPO_SCOPED_KINDS, workerStatus, registerHandler, runRow, start, inFlightWorkIds, workRunContextFields, adoptPodBackedRows } from "./worker.js";

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function openPR(labels: string[] = []) {
  return { state: "OPEN", headSha: "abc123", labels, mergeable: "MERGEABLE", checkStatus: "passing", checksTotal: 1 };
}

describe("worker", () => {
  beforeEach(async () => {
    ghMock.getPRMergeGate.mockReset().mockResolvedValue(openPR());
    ghMock.getIssueState.mockReset().mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
    await initDb();
    _resetForTests();
    shutdownState.shuttingDown = false;
  });

  afterEach(async () => {
    await _stopForTests();
    await clearAllWorkQueueForTests();
    await closeDb();
  });

  it("enqueue inserts a queued row", async () => {
    const r = await enqueue(AGENT_KINDS.CI_FIXER, "org/repo", 42);
    expect(r).not.toBeNull();
    expect(r!.alreadyQueued).toBe(false);
    expect(await listQueuedWork()).toHaveLength(1);
  });

  it("enqueue dedupes — same (kind, repo, item) only inserts once", async () => {
    const r1 = await enqueue(AGENT_KINDS.CI_FIXER, "org/repo", 7);
    const r2 = await enqueue(AGENT_KINDS.CI_FIXER, "org/repo", 7);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r2!.alreadyQueued).toBe(true);
    expect(await listQueuedWork()).toHaveLength(1);
  });

  it("workerStatus reflects queued and running counts", async () => {
    await enqueue(AGENT_KINDS.CI_FIXER, "org/repo", 1);
    await enqueue(AGENT_KINDS.CI_FIXER, "org/repo", 2);
    expect(await workerStatus()).toMatchObject({ queued: 2, running: 0 });

    await claimNextWork(null);
    expect(await workerStatus()).toMatchObject({ queued: 1, running: 1 });

    const row = await claimNextWork(null);
    await markWorkSucceeded(row!.id);
    const counts = await countWorkByStatus();
    expect(counts.completed).toBe(1);
    expect(counts.running).toBe(1);
  });

  it("cancellation without shutdown marks the row cancelled and frees redispatch", async () => {
    registerHandler(AGENT_KINDS.ISSUE_REFINER_PLAN, async () => {
      throw new ShutdownError("Task cancelled — shutting down");
    });
    await enqueue(AGENT_KINDS.ISSUE_REFINER_PLAN, "St-John-Software/claws", 2683);
    const row = (await claimNextWork(null))!;
    await runRow(0, row);

    const counts = await countWorkByStatus();
    expect(counts.cancelled).toBe(1);
    expect(counts.running ?? 0).toBe(0);

    // The item is dispatchable again — no stuck 'running' row blocking the unique index.
    const again = await enqueue(AGENT_KINDS.ISSUE_REFINER_PLAN, "St-John-Software/claws", 2683);
    expect(again!.alreadyQueued).toBe(false);
  });

  it("real shutdown leaves the row running for startup recovery", async () => {
    registerHandler(AGENT_KINDS.ISSUE_REFINER_PLAN, async () => {
      throw new ShutdownError("Task cancelled — shutting down");
    });
    await enqueue(AGENT_KINDS.ISSUE_REFINER_PLAN, "St-John-Software/claws", 2684);
    const row = (await claimNextWork(null))!;

    shutdownState.shuttingDown = true;
    await runRow(0, row);

    const counts = await countWorkByStatus();
    expect(counts.running).toBe(1);
    expect(counts.cancelled).toBeUndefined();
  });

  it("tracks a started row in inFlightWorkIds() while running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started: IssueRef[] = [];
    registerHandler(AGENT_KINDS.PR_REVIEWER, async (row) => {
      started.push(row.item_number);
      await gate;
    });

    start(1);
    const enqueued = await enqueue(AGENT_KINDS.PR_REVIEWER, "St-John-Software/claws", 3053);
    await waitFor(() => started.length === 1);

    expect(inFlightWorkIds()).toContain(enqueued!.id);

    // Stop the fiber after this row so it does not outlive the test.
    shutdownState.shuttingDown = true;
    release();
    await waitFor(() => !inFlightWorkIds().includes(enqueued!.id));
    expect((await countWorkByStatus()).completed).toBe(1);
  });

  it("the express fiber runs a priority row and leaves non-priority rows queued", async () => {
    const started: IssueRef[] = [];
    registerHandler(AGENT_KINDS.ISSUE_REFINER_PLAN, async (row) => {
      started.push(row.item_number);
    });

    await enqueue(AGENT_KINDS.ISSUE_REFINER_PLAN, "St-John-Software/claws", 1);
    ghMock.getIssueState.mockImplementation(async (_repo: string, item: IssueRef) =>
      item === 1596
        ? { state: "OPEN", stateReason: null, labels: ["Priority"] }
        : { state: "OPEN", stateReason: null, labels: [] });
    const alert = await enqueue(AGENT_KINDS.ISSUE_REFINER_PLAN, "St-John-Software/fleet-infra", 1596, { priority: true });
    start(0);
    await waitFor(() => started.length === 1);
    await waitFor(() => !inFlightWorkIds().includes(alert!.id));

    expect(started).toEqual([1596]);
    const counts = await countWorkByStatus();
    expect(counts.completed).toBe(1);
    expect(counts.queued).toBe(1);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith("[worker] Started 0 worker fiber(s) + 1 priority express fiber");
  });
});

describe("pre-spawn re-validation", () => {
  beforeEach(async () => {
    ghMock.getPRMergeGate.mockReset().mockResolvedValue(openPR());
    ghMock.getIssueState.mockReset().mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
    vi.mocked(log.info).mockClear();
    vi.mocked(log.warn).mockClear();
    await initDb();
    _resetForTests();
    shutdownState.shuttingDown = false;
  });

  afterEach(async () => {
    await _stopForTests();
    await clearAllWorkQueueForTests();
    await closeDb();
  });

  async function claimOnly(kind: string, item: IssueRef) {
    await enqueue(kind, "org/repo", item);
    return (await claimNextWork(null))!;
  }

  async function statusOf(id: number) {
    return (await _rawDb().get<WorkQueueRow>(`SELECT * FROM work_queue WHERE id = ?`, [id]))!;
  }

  it("skips a PR that merged after discovery without calling the handler", async () => {
    const handler = vi.fn();
    registerHandler(AGENT_KINDS.PR_REVIEWER, handler);
    ghMock.getPRMergeGate.mockResolvedValue({ ...openPR(), state: "MERGED" });
    const row = await claimOnly(AGENT_KINDS.PR_REVIEWER, 11);
    await runRow(0, row);

    expect(handler).not.toHaveBeenCalled();
    const after = await statusOf(row.id);
    expect(after.status).toBe("completed");
    expect(after.error_message).toBe("skipped: merged");
    expect(vi.mocked(log.info).mock.calls.some(([m]) => String(m).includes("no longer actionable (merged)"))).toBe(true);
  });

  it("records the skipped run as completed", async () => {
    registerHandler(AGENT_KINDS.PR_REVIEWER, vi.fn());
    ghMock.getPRMergeGate.mockResolvedValue({ ...openPR(), state: "CLOSED" });
    const row = await claimOnly(AGENT_KINDS.PR_REVIEWER, 12);
    await runRow(0, row);
    expect((await statusOf(row.id)).error_message).toBe("skipped: closed");
    const run = (await getLatestRunIdsByJob()).get("work:pr-reviewer");
    expect(run?.status).toBe("completed");
  });

  it("runs the handler when the live read throws a plain error (fail open)", async () => {
    const handler = vi.fn();
    registerHandler(AGENT_KINDS.CI_FIXER, handler);
    ghMock.getPRMergeGate.mockRejectedValue(new Error("gh: 502"));
    const row = await claimOnly(AGENT_KINDS.CI_FIXER, 13);
    await runRow(0, row);
    expect(handler).toHaveBeenCalledOnce();
    expect((await statusOf(row.id)).status).toBe("completed");
    expect((await statusOf(row.id)).error_message).toBeNull();
    expect(vi.mocked(log.warn).mock.calls.some(([m]) => String(m).includes("re-validation failed"))).toBe(true);
  });

  it("keeps the rate-limited failure path when the live read is rate limited", async () => {
    const handler = vi.fn();
    registerHandler(AGENT_KINDS.PR_REVIEWER, handler);
    ghMock.getPRMergeGate.mockRejectedValue(new RateLimitError("limited"));
    const row = await claimOnly(AGENT_KINDS.PR_REVIEWER, 14);
    await runRow(0, row);
    expect(handler).not.toHaveBeenCalled();
    const after = await statusOf(row.id);
    expect(after.status).toBe("failed");
    expect(after.error_message).toBe("rate-limited");
  });

  it("skips a parked issue", async () => {
    const handler = vi.fn();
    registerHandler(AGENT_KINDS.ISSUE_WORKER, handler);
    ghMock.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Blocked"] });
    const row = await claimOnly(AGENT_KINDS.ISSUE_WORKER, 15);
    await runRow(0, row);
    expect(handler).not.toHaveBeenCalled();
    expect((await statusOf(row.id)).error_message).toBe("skipped: parked");
  });

  it("skips a closed issue", async () => {
    const handler = vi.fn();
    registerHandler(AGENT_KINDS.ISSUE_REFINER_PLAN, handler);
    ghMock.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "completed", labels: [] });
    const row = await claimOnly(AGENT_KINDS.ISSUE_REFINER_PLAN, 16);
    await runRow(0, row);
    expect(handler).not.toHaveBeenCalled();
    expect((await statusOf(row.id)).error_message).toBe("skipped: closed");
  });

  it("does not re-validate repo-scoped rows", async () => {
    const handler = vi.fn();
    registerHandler(AGENT_KINDS.AUTO_MERGER_SWEEP, handler);
    const row = await claimOnly(AGENT_KINDS.AUTO_MERGER_SWEEP, 0);
    await runRow(0, row);
    expect(handler).toHaveBeenCalledOnce();
    expect(ghMock.getPRMergeGate).not.toHaveBeenCalled();
    expect(ghMock.getIssueState).not.toHaveBeenCalled();
  });

  it("does not re-validate ci-fixer:rerun, a repo-level kind enqueued at item 0", async () => {
    const handler = vi.fn();
    registerHandler(AGENT_KINDS.CI_FIXER_RERUN, handler);
    const row = await claimOnly(AGENT_KINDS.CI_FIXER_RERUN, 0);
    await runRow(0, row);
    expect(handler).toHaveBeenCalledOnce();
    expect(ghMock.getPRMergeGate).not.toHaveBeenCalled();
    expect(ghMock.getIssueState).not.toHaveBeenCalled();
  });

  it("updates the row's priority from the live Priority label", async () => {
    let seen: number | undefined;
    registerHandler(AGENT_KINDS.PR_REVIEWER, async (r) => {
      seen = (await statusOf(r.id)).priority;
    });
    ghMock.getPRMergeGate.mockResolvedValue(openPR(["Priority"]));
    const row = await claimOnly(AGENT_KINDS.PR_REVIEWER, 17);
    expect(row.priority).toBe(0);
    await runRow(0, row);
    expect(seen).toBe(1);
  });

  it("the express fiber releases a row back to the queue instead of running it once its priority label is gone", async () => {
    const handler = vi.fn();
    registerHandler(AGENT_KINDS.PR_REVIEWER, handler);
    ghMock.getPRMergeGate.mockResolvedValue(openPR()); // no Priority label anymore
    await enqueue(AGENT_KINDS.PR_REVIEWER, "org/repo", 18, { priority: true });
    const row = (await claimNextWork(null, { priorityOnly: true }))!;
    expect(row.priority).toBe(1);

    await runRow(0, row, { priorityOnly: true });

    expect(handler).not.toHaveBeenCalled();
    const after = await statusOf(row.id);
    expect(after.status).toBe("queued");
    expect(after.priority).toBe(0);
    expect(after.error_message).toBeNull();
  });
});

describe("item_number scoping", () => {
  const sets = [ISSUE_SCOPED_KINDS, PR_SCOPED_KINDS, REPO_SCOPED_KINDS];

  it("partitions every AGENT_KINDS entry", () => {
    // A kind in none of the sets reads as "not issue-scoped" to the
    // issue-importer's mid-flight guard, which would then close a forge issue
    // an agent is working on. Fail here instead.
    for (const kind of Object.values(AGENT_KINDS)) {
      expect(sets.filter((s) => s.has(kind)), `${kind} must be in exactly one scope set`).toHaveLength(1);
    }
    expect(ISSUE_SCOPED_KINDS.size + PR_SCOPED_KINDS.size + REPO_SCOPED_KINDS.size)
      .toBe(Object.keys(AGENT_KINDS).length);
  });

  it("names only real kinds", () => {
    const known = new Set<string>(Object.values(AGENT_KINDS));
    for (const set of sets) for (const kind of set) expect(known.has(kind)).toBe(true);
  });

  it("logs item_number as issue or pr by kind, and not at all for repo-scoped kinds", () => {
    const row = (kind: string, item_number: IssueRef) => ({ kind, repo: "org/r", item_number }) as Parameters<typeof workRunContextFields>[0];
    expect(workRunContextFields(row(AGENT_KINDS.ISSUE_WORKER, 7))).toEqual({ job: "work:issue-worker", repo: "org/r", issue: 7 });
    expect(workRunContextFields(row(AGENT_KINDS.PR_REVIEWER, 8))).toEqual({ job: "work:pr-reviewer", repo: "org/r", pr: 8 });
    expect(workRunContextFields(row(AGENT_KINDS.AUTO_MERGER_SWEEP, 0))).toEqual({ job: "work:auto-merger:sweep", repo: "org/r" });
  });
});

describe("k8s-pod work backend", () => {
  beforeEach(async () => {
    await initDb();
    _resetForTests();
    shutdownState.shuttingDown = false;
    backendState.workBackend = "k8s-pod";
    launcherMock.runRowInPod.mockReset();
  });

  afterEach(async () => {
    shutdownState.shuttingDown = true;
    await _stopForTests();
    backendState.workBackend = "in-process";
    await clearAllWorkQueueForTests();
    await closeDb();
  });

  it("claims with a fresh run id, opens the job run itself and runs the row in a pod", async () => {
    const handler = vi.fn();
    registerHandler(AGENT_KINDS.PR_REVIEWER, handler);
    const calls: Array<{ row: WorkQueueRow; adopt: boolean }> = [];
    launcherMock.runRowInPod.mockImplementation(async (_w: number, row: WorkQueueRow, opts: { adopt: boolean }) => {
      calls.push({ row, adopt: opts.adopt });
      shutdownState.shuttingDown = true;
    });

    const enqueued = await enqueue(AGENT_KINDS.PR_REVIEWER, "St-John-Software/claws", 3351);
    start(1);
    await waitFor(() => calls.length === 1);

    const { row, adopt } = calls[0]!;
    expect(adopt).toBe(false);
    expect(row.id).toBe(enqueued!.id);
    expect(row.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await getJobRun(row.run_id!))?.job_name).toBe(`work:${AGENT_KINDS.PR_REVIEWER}`);
    // The handler runs in the pod, never in the service.
    expect(handler).not.toHaveBeenCalled();
  });

  it("adopts pod-backed running rows before claiming new work", async () => {
    const old = await enqueue(AGENT_KINDS.PR_REVIEWER, "St-John-Software/claws", 1);
    const claimed = (await claimNextWork("old-run"))!;
    await setWorkAgentPod(claimed.id, `claws-agent-${claimed.id}`);
    await enqueue(AGENT_KINDS.PR_REVIEWER, "St-John-Software/claws", 2);

    const calls: Array<{ id: number; adopt: boolean }> = [];
    launcherMock.runRowInPod.mockImplementation(async (_w: number, row: WorkQueueRow, opts: { adopt: boolean }) => {
      calls.push({ id: row.id, adopt: opts.adopt });
      if (calls.length === 2) shutdownState.shuttingDown = true;
    });
    start(1);
    await waitFor(() => calls.length === 2);

    expect(calls[0]).toEqual({ id: old!.id, adopt: true });
    expect(calls[1]!.adopt).toBe(false);
    expect(calls[1]!.id).not.toBe(old!.id);
    expect((await getWorkRow(old!.id))?.run_id).toBe("old-run");
  });

  it("the express fiber launches a priority row instead of adopting a non-priority pod a deploy left running", async () => {
    const old = await enqueue(AGENT_KINDS.PR_REVIEWER, "St-John-Software/claws", 1);
    const claimed = (await claimNextWork("old-run"))!;
    await setWorkAgentPod(claimed.id, `claws-agent-${claimed.id}`);

    const calls: Array<{ id: number; adopt: boolean }> = [];
    launcherMock.runRowInPod.mockImplementation(async (_w: number, row: WorkQueueRow, opts: { adopt: boolean }) => {
      calls.push({ id: row.id, adopt: opts.adopt });
      shutdownState.shuttingDown = true;
    });

    start(0);
    const alert = await enqueue(AGENT_KINDS.PR_REVIEWER, "St-John-Software/fleet-infra", 1596, { priority: true });
    await waitFor(() => calls.length === 1);

    // The express fiber (the only fiber here) must claim the priority row, not
    // the adopted non-priority pod, which would otherwise tie it up for hours.
    expect(calls[0]).toEqual({ id: alert!.id, adopt: false });
    expect((await getWorkRow(old!.id))?.status).toBe("running");
    expect((await getWorkRow(old!.id))?.run_id).toBe("old-run");
  });

  it("adoptPodBackedRows queues each unwatched pod-backed row once, and never a watched one", async () => {
    await enqueue(AGENT_KINDS.PR_REVIEWER, "St-John-Software/claws", 1);
    const claimed = (await claimNextWork("old-run"))!;
    await setWorkAgentPod(claimed.id, `claws-agent-${claimed.id}`);
    // A failed boot seed leaves the row unwatched; the hourly re-run queues it, even when two overlap.
    expect((await Promise.all([adoptPodBackedRows(), adoptPodBackedRows()])).sort()).toEqual([0, 1]);

    const calls: Array<{ id: number; adopt: boolean; readopted: number }> = [];
    launcherMock.runRowInPod.mockImplementation(async (_w: number, row: WorkQueueRow, opts: { adopt: boolean }) => {
      calls.push({ id: row.id, adopt: opts.adopt, readopted: await adoptPodBackedRows() });
      shutdownState.shuttingDown = true;
    });
    start(1);
    await waitFor(() => calls.length === 1);
    expect(calls).toEqual([{ id: claimed.id, adopt: true, readopted: 0 }]);
  });
});
