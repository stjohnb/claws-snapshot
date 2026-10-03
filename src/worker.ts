import type { IssueRef } from "./issue-id.js";
import * as db from "./db.js";
import { MAX_WORK_WORKERS, WORK_BACKEND, shouldRunWorkPipeline } from "./config.js";
import * as log from "./log.js";
import { runContext, withRunContext, type RunContextFields } from "./log.js";
import { isShuttingDown, ShutdownError } from "./shutdown.js";
import * as gh from "./github.js";
import { RateLimitError } from "./github.js";
import { reportError } from "./error-reporter.js";
import { handleTimeoutIfApplicable, handleMemoryLimitIfApplicable } from "./timeout-handler.js";
import { randomUUID } from "node:crypto";
import { sleep } from "./util.js";
import { agentMemoryAdmissionStatus } from "./claude.js";
import { AGENT_KINDS } from "./work-order.js";
import { getAgentPodLauncher } from "./agent-pod-launcher.js";

export { AGENT_KINDS };

/**
 * What a kind's `work_queue.item_number` actually names. Every kind in
 * `AGENT_KINDS` belongs to exactly one of these three sets, and `worker.test.ts`
 * asserts that — a new kind in none of them would silently read as "not an
 * issue" to callers that partition the queue, notably the issue-importer's
 * mid-flight guard, which would then close a forge issue an agent is working.
 */
export const ISSUE_SCOPED_KINDS: ReadonlySet<string> = new Set<string>([
  AGENT_KINDS.ISSUE_WORKER,
  AGENT_KINDS.ISSUE_WORKER_CONTINUE,
  AGENT_KINDS.ISSUE_REFINER_FOLLOWUP,
  AGENT_KINDS.ISSUE_REFINER_PLAN,
  AGENT_KINDS.ISSUE_REFINER_REFINE,
  AGENT_KINDS.ISSUE_REFINER_REPLAN,
  AGENT_KINDS.ESCALATION_REVIEW,
  AGENT_KINDS.REQUIREMENTS_WRITE,
  AGENT_KINDS.REQUIREMENTS_REFINE,
]);

/** Kinds whose `item_number` is a pull request number. */
export const PR_SCOPED_KINDS: ReadonlySet<string> = new Set<string>([
  AGENT_KINDS.CI_FIXER_CONFLICT,
  AGENT_KINDS.CI_FIXER,
  AGENT_KINDS.CI_FIXER_PROBLEMATIC,
  AGENT_KINDS.REVIEW_ADDRESSER,
  AGENT_KINDS.PR_REVIEWER,
]);

/** Kinds scoped to the repository alone; they enqueue with `item_number` 0. */
export const REPO_SCOPED_KINDS: ReadonlySet<string> = new Set<string>([
  AGENT_KINDS.AUTO_MERGER_SWEEP,
  AGENT_KINDS.CI_FIXER_RERUN,
]);

export type WorkRow = db.WorkQueueRow;
export type WorkHandler = (row: WorkRow, args: Record<string, unknown>) => Promise<void>;

const handlers = new Map<string, WorkHandler>();

/** Register a handler for a given kind. Called once at startup by `registerWorkHandlers`. */
export function registerHandler(kind: string, fn: WorkHandler): void {
  handlers.set(kind, fn);
}

export async function enqueue(
  kind: string,
  repo: string,
  itemNumber: IssueRef,
  opts: { priority?: boolean; args?: Record<string, unknown> } = {},
): Promise<db.EnqueueResult | null> {
  if (isShuttingDown()) return null;
  const result = await db.enqueueWork(kind, repo, itemNumber, opts);
  if (result && !result.alreadyQueued) {
    wakeup();
  }
  if (result?.priorityChanged) {
    log.info(`[worker] priority refreshed ${kind} ${repo}#${itemNumber} -> ${opts.priority ? 1 : 0}`);
  }
  return result;
}

export async function workerStatus(): Promise<{
  workers: number;
  running: number;
  queued: number;
  agentMemory: ReturnType<typeof agentMemoryAdmissionStatus>;
}> {
  const counts = await db.countWorkByStatus();
  return {
    workers: MAX_WORK_WORKERS,
    running: counts.running ?? 0,
    queued: counts.queued ?? 0,
    // A fiber parked in the memory-admission gate still holds its claimed row
    // and still counts as `running`, so surface the gate depth alongside it —
    // otherwise "running but making no progress" is indistinguishable from work.
    agentMemory: agentMemoryAdmissionStatus(),
  };
}

const IDLE_POLL_MS = 5000;
const ERROR_BACKOFF_MS = 1000;

let wakeupResolve: (() => void) | null = null;
let wakeupPromise: Promise<void> = new Promise((r) => {
  wakeupResolve = r;
});

function wakeup(): void {
  const r = wakeupResolve;
  // Re-create the promise *before* resolving so a wakeup that arrives during
  // resolution is captured by the next loop iteration's await.
  wakeupPromise = new Promise((res) => {
    wakeupResolve = res;
  });
  if (r) r();
}

let started = false;
let stopForTests = false;
const fiberPromises: Promise<void>[] = [];

/**
 * `k8s-pod` only: pod-backed rows a previous boot left running, which fibers
 * re-attach to before claiming anything new. Filled by `start()` and topped up
 * by `adoptPodBackedRows()`.
 */
const adoptQueue: WorkRow[] = [];
let adoptSeeded: Promise<void> = Promise.resolve();

/**
 * What each fiber is doing right now. `"claiming"` is recorded before the claim
 * query so `inFlightWorkIds()` (used by startup stale-row reaping) never
 * misses a row mid-claim.
 */
const inFlight = new Map<number, WorkRow | "claiming">();

/** IDs of work_queue rows a fiber is currently claiming or executing, for
 *  reapStaleRunningWork()'s no-restart sweep (#3144): a 'running' row not in
 *  this set has no worker behind it and is safe to re-queue. */
export function inFlightWorkIds(): number[] {
  const ids: number[] = [];
  for (const entry of inFlight.values()) {
    if (entry === "claiming") continue;
    ids.push(entry.id);
  }
  return ids;
}

/** Spawn N worker fibers. Idempotent. */
export function start(workers: number = MAX_WORK_WORKERS): void {
  if (started) return;
  started = true;
  stopForTests = false;
  const n = Math.max(0, workers);
  if (WORK_BACKEND === "k8s-pod") {
    adoptSeeded = adoptPodBackedRows().then(
      () => undefined,
      (err) => { log.warn(`[worker] Could not list pod-backed running work to adopt: ${err}`); },
    );
  }
  for (let i = 0; i < n; i++) {
    fiberPromises.push(workerLoop(i));
  }
  // One reserved express fiber claims only priority rows, so an incident-labelled
  // issue starts at once even while every regular fiber is mid-run.
  fiberPromises.push(workerLoop(n, { priorityOnly: true }));
  log.info(`[worker] Started ${n} worker fiber(s) + 1 priority express fiber`);
}

/**
 * `k8s-pod`: queue every pod-backed running row no fiber is watching, and wake
 * the fibers; returns how many were queued. `start()` seeds the adopt queue
 * with it, and the hourly orphan sweep re-runs it so a row a failed seed (or
 * anything else) left unwatched is still supervised.
 */
export async function adoptPodBackedRows(): Promise<number> {
  const rows = await db.listPodBackedRunningWork();
  // Checked after the await, so a concurrent call sees this one's pushes.
  const watched = new Set([...inFlightWorkIds(), ...adoptQueue.map((r) => r.id)]);
  const unwatched = rows.filter((r) => !watched.has(r.id));
  if (unwatched.length === 0) return 0;
  adoptQueue.push(...unwatched);
  wakeup();
  return unwatched.length;
}

async function workerLoop(workerId: number, opts?: { priorityOnly?: boolean }): Promise<void> {
  const podBackend = WORK_BACKEND === "k8s-pod";
  if (podBackend) await adoptSeeded;
  while (!isShuttingDown() && !stopForTests) {
    // Adopted pods are already running, so they are watched even while the
    // work pipeline is paused. The express fiber only adopts a priority row —
    // otherwise it could tie itself up for hours watching an ordinary pod a
    // deploy left running, leaving nothing reserved for the next incident.
    let adopted: WorkRow | undefined;
    if (podBackend) {
      if (opts?.priorityOnly) {
        const i = adoptQueue.findIndex((r) => r.priority === 1);
        if (i !== -1) adopted = adoptQueue.splice(i, 1)[0];
      } else {
        adopted = adoptQueue.shift();
      }
    }
    if (adopted) {
      inFlight.set(workerId, adopted);
      try {
        await runInPod(workerId, adopted, true);
      } finally {
        inFlight.delete(workerId);
      }
      continue;
    }

    if (!shouldRunWorkPipeline()) {
      await Promise.race([
        wakeupPromise,
        sleep(IDLE_POLL_MS),
      ]);
      continue;
    }

    let row: WorkRow | null = null;
    inFlight.set(workerId, "claiming");
    try {
      // An agent pod completes a run the service opened, so its claim carries a fresh one.
      const runId = podBackend ? randomUUID() : runContext.getStore()?.runId ?? null;
      row = await db.claimNextWork(runId, opts);
    } catch (err) {
      inFlight.delete(workerId);
      log.warn(`[worker:${workerId}] claim failed: ${err}`);
      await sleep(ERROR_BACKOFF_MS);
      continue;
    }

    if (!row) {
      inFlight.delete(workerId);
      await Promise.race([
        wakeupPromise,
        sleep(IDLE_POLL_MS),
      ]);
      continue;
    }

    inFlight.set(workerId, row);
    try {
      if (podBackend) {
        try {
          await db.insertJobRun(row.run_id!, `work:${row.kind}`);
        } catch (err) {
          // The job run is a pod-backed run's only dashboard and cancel handle:
          // never launch without one — hand the row back and back off.
          log.warn(`[worker:${workerId}] Could not open the job run for ${row.kind} ${row.repo}#${row.item_number} (id=${row.id}) — re-queueing it: ${err}`);
          try {
            await db.releaseClaimedWork(row.id, row.run_id!);
          } catch (releaseErr) {
            log.warn(`[worker:${workerId}] Could not re-queue work row ${row.id}: ${releaseErr}`);
          }
          await sleep(ERROR_BACKOFF_MS);
          continue;
        }
        await runInPod(workerId, row, false);
      } else {
        await runRow(workerId, row, opts);
      }
    } finally {
      inFlight.delete(workerId);
    }
  }
}

/** `k8s-pod`: launch (or adopt) `row`'s agent pod and watch it until the row ends. */
async function runInPod(workerId: number, row: WorkRow, adopt: boolean): Promise<void> {
  const run = () => getAgentPodLauncher().runRowInPod(workerId, row, { adopt });
  try {
    await (row.run_id ? withRunContext(row.run_id, run, workRunContextFields(row)) : run());
  } catch (err) {
    log.warn(`[worker:${workerId}] agent pod for ${row.kind} ${row.repo}#${row.item_number} (id=${row.id}) failed: ${err}`);
    await sleep(ERROR_BACKOFF_MS);
  }
}

/** Correlation fields stamped on every log line a work row's run emits. */
export function workRunContextFields(row: WorkRow): RunContextFields {
  const fields: RunContextFields = { job: `work:${row.kind}`, repo: row.repo };
  if (PR_SCOPED_KINDS.has(row.kind)) fields.pr = row.item_number;
  else if (!REPO_SCOPED_KINDS.has(row.kind)) fields.issue = row.item_number;
  return fields;
}

export type RevalidationResult =
  | { ok: true; priority: boolean | null }
  | { ok: false; reason: string };

/**
 * One uncached forge read of a claimed row's item, immediately before its
 * agent spawns: a row is a candidate discovered minutes earlier, and the item
 * may since have merged, closed or been parked. `priority` is the live
 * Priority label (`null` for repo-scoped kinds, which are not re-read).
 * Throws what the forge read throws; `runRow` decides how to treat that.
 */
export async function revalidateRow(row: WorkRow): Promise<RevalidationResult> {
  if (REPO_SCOPED_KINDS.has(row.kind)) return { ok: true, priority: null };
  if (PR_SCOPED_KINDS.has(row.kind)) {
    if (typeof row.item_number !== "number") {
      // Let the handler's own PR-number guard fail the row loudly.
      return { ok: true, priority: null };
    }
    const pr = await gh.getPRMergeGate(row.repo, row.item_number);
    if (pr.state !== "OPEN") return { ok: false, reason: pr.state === "MERGED" ? "merged" : "closed" };
    const labels = pr.labels.map((name) => ({ name }));
    if (gh.isParked(labels)) return { ok: false, reason: "parked" };
    if (gh.isItemSkipped(row.repo, row.item_number)) return { ok: false, reason: "skipped-by-config" };
    log.info(`[worker] ${row.kind} ${row.repo}#${row.item_number} still actionable at head=${pr.headSha}`);
    return { ok: true, priority: gh.hasPriorityLabel(labels) };
  }
  const issue = await gh.getIssueState(row.repo, row.item_number);
  if (issue.state === "CLOSED") return { ok: false, reason: "closed" };
  const labels = issue.labels.map((name) => ({ name }));
  if (gh.isParked(labels)) return { ok: false, reason: "parked" };
  if (gh.isItemSkipped(row.repo, row.item_number)) return { ok: false, reason: "skipped-by-config" };
  return { ok: true, priority: gh.hasPriorityLabel(labels) };
}

/** @internal — exported for tests. */
export async function runRow(workerId: number, row: WorkRow, opts?: { priorityOnly?: boolean }): Promise<void> {
  const handler = handlers.get(row.kind);
  if (!handler) {
    log.warn(`[worker:${workerId}] No handler registered for kind="${row.kind}" (id=${row.id})`);
    await db.markWorkFailed(row.id, `no handler for kind=${row.kind}`);
    return;
  }

  let args: Record<string, unknown> = {};
  try {
    args = row.args_json ? JSON.parse(row.args_json) : {};
  } catch {
    args = {};
  }

  const runId = row.run_id ?? randomUUID();
  const ownsRun = !row.run_id;
  if (ownsRun) {
    try {
      await db.insertJobRun(runId, `work:${row.kind}`);
    } catch {
      // best effort — duplicate or DB hiccup; continue without DB-side run row
    }
  }

  await withRunContext(runId, async () => {
    log.info(`[worker:${workerId}] ${row.kind} ${row.repo}#${row.item_number} (id=${row.id})`);

    try {
      let check: RevalidationResult | null = null;
      try {
        check = await revalidateRow(row);
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        // Fail open: the handler's own open-check still guards the spawn.
        log.warn(`[worker:${workerId}] ${row.kind} ${row.repo}#${row.item_number} re-validation failed, running anyway: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (check && !check.ok) {
        log.info(`[worker:${workerId}] ${row.kind} ${row.repo}#${row.item_number} no longer actionable (${check.reason}) — skipping without spawning an agent`);
        await db.markWorkSkipped(row.id, check.reason);
        if (ownsRun) {
          try { await db.completeJobRun(runId, "completed"); } catch { /* best effort */ }
        }
        return;
      }
      if (check?.ok && check.priority !== null && check.priority !== (row.priority === 1)) {
        log.info(`[worker:${workerId}] ${row.kind} ${row.repo}#${row.item_number} live Priority label is ${check.priority ? "set" : "unset"}; updating row`);
        try { await db.setWorkPriority(row.id, check.priority); } catch { /* best effort — display only */ }
      }
      if (opts?.priorityOnly && check?.ok && check.priority === false) {
        // The express fiber's whole reason to exist is to keep a lane free for
        // priority rows. One whose label was removed between claim and spawn
        // is now ordinary work — release it back to the queue for a regular
        // fiber instead of spending the reserved lane on it.
        log.info(`[worker:${workerId}] ${row.kind} ${row.repo}#${row.item_number} lost its priority label before the express fiber spawned it — releasing it back to the queue`);
        try {
          await db.releaseClaimedWorkById(row.id);
        } catch (err) {
          log.warn(`[worker:${workerId}] Could not release ${row.kind} ${row.repo}#${row.item_number} back to the queue: ${err}`);
        }
        if (ownsRun) {
          try { await db.completeJobRun(runId, "completed"); } catch { /* best effort */ }
        }
        return;
      }

      await handler(row, args);
      await db.markWorkSucceeded(row.id);
      if (ownsRun) {
        try { await db.completeJobRun(runId, "completed"); } catch { /* best effort */ }
      }
    } catch (err) {
      if (err instanceof ShutdownError) {
        if (isShuttingDown()) {
          // Real process shutdown: leave the row in 'running'. The next boot's
          // recoverWorkOnStartup() resets every 'running' row to 'queued'.
          log.info(`[worker:${workerId}] ${row.kind} ${row.repo}#${row.item_number} interrupted by shutdown`);
        } else {
          // A per-run cancellation (POST /cancel, POST /logs/:runId/cancel) while the
          // service stays up. Startup recovery only fires at the next boot and
          // reapStaleRunningWork() only after STALE_RUNNING_WORK_MS, so the row must
          // reach a terminal state now or it blocks redispatch for up to that long
          // (#2685, #3144).
          await db.markWorkCancelled(row.id, "run cancelled");
          log.info(`[worker:${workerId}] ${row.kind} ${row.repo}#${row.item_number} cancelled`);
        }
        if (ownsRun) {
          try { await db.completeJobRun(runId, "cancelled"); } catch { /* best effort */ }
        }
        return;
      }
      if (err instanceof RateLimitError) {
        log.warn(`[worker:${workerId}] ${row.kind} ${row.repo}#${row.item_number} rate limited`);
        await db.markWorkFailed(row.id, "rate-limited");
        if (ownsRun) {
          try { await db.completeJobRun(runId, "failed"); } catch { /* best effort */ }
        }
        return;
      }
      await db.markWorkFailed(row.id, err instanceof Error ? err.message : String(err));
      if (ownsRun) {
        try { await db.completeJobRun(runId, "failed"); } catch { /* best effort */ }
      }
      try {
        await handleTimeoutIfApplicable(row.kind.split(":")[0], row.repo, row.item_number, err);
      } catch {
        // best effort
      }
      try {
        await handleMemoryLimitIfApplicable(row.kind.split(":")[0], row.repo, row.item_number, err);
      } catch {
        // best effort
      }
      try {
        await reportError(`${row.kind}:run`, `${row.repo}#${row.item_number}`, err, { repo: row.repo });
      } catch {
        // best effort
      }
    }
  }, workRunContextFields(row));
}

/** @internal — tests only. Stops every fiber and waits for them to exit, so none outlives its test. */
export async function _stopForTests(): Promise<void> {
  stopForTests = true;
  wakeup();
  await Promise.all(fiberPromises);
}

/** @internal — tests only. */
export function _resetForTests(): void {
  handlers.clear();
  stopForTests = false;
  started = false;
  fiberPromises.length = 0;
  inFlight.clear();
  adoptQueue.length = 0;
  adoptSeeded = Promise.resolve();
}
