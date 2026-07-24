import * as db from "./db.js";
import { MAX_WORK_WORKERS } from "./config.js";
import * as log from "./log.js";
import { runContext, withRunContext } from "./log.js";
import { isShuttingDown, ShutdownError } from "./shutdown.js";
import { RateLimitError } from "./github.js";
import { reportError } from "./error-reporter.js";
import { handleTimeoutIfApplicable, handleMemoryLimitIfApplicable } from "./timeout-handler.js";
import { randomUUID } from "node:crypto";
import { sleep } from "./util.js";

/** Stable string identifiers persisted in the work_queue.kind column. */
export const AGENT_KINDS = {
  CI_FIXER_CONFLICT: "ci-fixer:conflict",
  CI_FIXER: "ci-fixer",
  CI_FIXER_RERUN: "ci-fixer:rerun",
  CI_FIXER_PROBLEMATIC: "ci-fixer:problematic",
  REVIEW_ADDRESSER: "review-addresser",
  PR_REVIEWER: "pr-reviewer",
  AUTO_MERGER_SWEEP: "auto-merger:sweep",
  ISSUE_WORKER: "issue-worker",
  ISSUE_WORKER_CONTINUE: "issue-worker:continue",
  ISSUE_REFINER_FOLLOWUP: "issue-refiner:followup",
  ISSUE_REFINER_PLAN: "issue-refiner:plan",
  ISSUE_REFINER_REFINE: "issue-refiner:refine",
  ISSUE_REFINER_REPLAN: "issue-refiner:replan",
} as const;

export type WorkRow = db.WorkQueueRow;
export type WorkHandler = (row: WorkRow, args: Record<string, unknown>) => Promise<void>;

const handlers = new Map<string, WorkHandler>();

/** Register a handler for a given kind. Called once at startup by `registerWorkHandlers`. */
export function registerHandler(kind: string, fn: WorkHandler): void {
  handlers.set(kind, fn);
}

export function enqueue(
  kind: string,
  repo: string,
  itemNumber: number,
  opts: { priority?: boolean; args?: Record<string, unknown> } = {},
): db.EnqueueResult | null {
  if (isShuttingDown()) return null;
  const result = db.enqueueWork(kind, repo, itemNumber, opts);
  if (result && !result.alreadyQueued) {
    wakeup();
  }
  return result;
}

export function workerStatus(): { workers: number; running: number; queued: number } {
  const counts = db.countWorkByStatus();
  return {
    workers: MAX_WORK_WORKERS,
    running: counts.running ?? 0,
    queued: counts.queued ?? 0,
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

/** Spawn N worker fibers. Idempotent. */
export function start(workers: number = MAX_WORK_WORKERS): void {
  if (started) return;
  started = true;
  stopForTests = false;
  const n = Math.max(0, workers);
  for (let i = 0; i < n; i++) {
    fiberPromises.push(workerLoop(i));
  }
  log.info(`[worker] Started ${n} worker fiber(s)`);
}

async function workerLoop(workerId: number): Promise<void> {
  while (!isShuttingDown() && !stopForTests) {
    let row: WorkRow | null = null;
    try {
      const runId = runContext.getStore()?.runId ?? null;
      row = db.claimNextWork(runId);
    } catch (err) {
      log.warn(`[worker:${workerId}] claim failed: ${err}`);
      await sleep(ERROR_BACKOFF_MS);
      continue;
    }

    if (!row) {
      await Promise.race([
        wakeupPromise,
        sleep(IDLE_POLL_MS),
      ]);
      continue;
    }

    await runRow(workerId, row);
  }
}

async function runRow(workerId: number, row: WorkRow): Promise<void> {
  const handler = handlers.get(row.kind);
  if (!handler) {
    log.warn(`[worker:${workerId}] No handler registered for kind="${row.kind}" (id=${row.id})`);
    db.markWorkFailed(row.id, `no handler for kind=${row.kind}`);
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
      db.insertJobRun(runId, `work:${row.kind}`);
    } catch {
      // best effort — duplicate or DB hiccup; continue without DB-side run row
    }
  }

  await withRunContext(runId, async () => {
    log.info(`[worker:${workerId}] ${row.kind} ${row.repo}#${row.item_number} (id=${row.id})`);

    try {
      await handler(row, args);
      db.markWorkSucceeded(row.id);
      if (ownsRun) {
        try { db.completeJobRun(runId, "completed"); } catch { /* best effort */ }
      }
    } catch (err) {
      if (err instanceof ShutdownError) {
        // Leave the row in 'running' — recovery on next boot will reset it to 'queued'.
        log.info(`[worker:${workerId}] ${row.kind} ${row.repo}#${row.item_number} interrupted by shutdown`);
        if (ownsRun) {
          try { db.completeJobRun(runId, "cancelled"); } catch { /* best effort */ }
        }
        return;
      }
      if (err instanceof RateLimitError) {
        log.warn(`[worker:${workerId}] ${row.kind} ${row.repo}#${row.item_number} rate limited`);
        db.markWorkFailed(row.id, "rate-limited");
        if (ownsRun) {
          try { db.completeJobRun(runId, "failed"); } catch { /* best effort */ }
        }
        return;
      }
      db.markWorkFailed(row.id, err instanceof Error ? err.message : String(err));
      if (ownsRun) {
        try { db.completeJobRun(runId, "failed"); } catch { /* best effort */ }
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
        await reportError(`${row.kind}:run`, `${row.repo}#${row.item_number}`, err);
      } catch {
        // best effort
      }
    }
  });
}

/** @internal — tests only. */
export function _resetForTests(): void {
  handlers.clear();
  stopForTests = false;
  started = false;
  fiberPromises.length = 0;
}
