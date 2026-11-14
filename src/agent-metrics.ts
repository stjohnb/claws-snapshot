/**
 * Agent usage and pipeline state as Prometheus metrics
 * (#clw_01M663VPZ4ES5PZTY4JQ9VJ5CT): token and cost totals, task outcomes,
 * provider holds, running and queued work, board columns, open Claws PRs and
 * each scheduled job's last run. See docs/metrics.md "Agent and pipeline metrics".
 *
 * Controller-only: `main-controller.ts` imports this module and starts the
 * sampler, `main-web.ts` never does, so each series comes from one process and
 * dashboards never sum two copies. The collectors only read the snapshots the
 * sampler caches (every 60 s; the board every 5 min), so a scrape costs no DB
 * or forge reads. The totals are recounted from the database on each sample —
 * live rows plus the `usage_retired_totals` ledger — so a restart or rollout
 * neither loses nor double-counts usage.
 */

import { Counter, Gauge } from "prom-client";
import * as db from "./db.js";
import * as gh from "./github.js";
import * as log from "./log.js";
import { registry } from "./metrics.js";
import { boardColumnCounts } from "./operator-attention.js";
import { describeHoldKey, type HoldDescription } from "./provider-holds.js";

/** How often the DB-backed and in-memory queue snapshots are refreshed. */
export const AGENT_METRICS_SAMPLE_MS = 60_000;
/** How often the board columns are recounted: each count lists every repo's open issues. */
export const BOARD_METRICS_SAMPLE_MS = 5 * 60_000;

/** Every `ClawsPrStage` a PR can be in while open, so a stage with no PRs still exports 0. */
export const OPEN_PR_STAGES = ["opened", "ci-failing", "awaiting-review", "addressing-review", "awaiting-merge", "problematic"] as const satisfies readonly db.ClawsPrStage[];

interface AgentSnapshot {
  usage: db.AgentUsageTotal[];
  outcomes: db.AgentTaskOutcomeTotal[];
  running: Array<{ job: string; count: number }>;
  workQueue: Array<{ kind: string; status: string; count: number }>;
  prs: Array<{ stage: string; count: number }>;
  holds: Array<HoldDescription & { untilMs: number }>;
  jobLastRuns: Array<{ job: string; completedAtMs: number; success: boolean }>;
  queue: Map<string, number>;
}

interface BoardSnapshot {
  columns: Record<string, number>;
  waiting: number;
}

const snapshot: Partial<AgentSnapshot> = {};
let board: BoardSnapshot | null = null;
let lastSampleAt: number | null = null;

// ── Collectors ──

const LABELS = ["provider", "model", "account", "repo", "job"] as const;

new Counter({
  name: "claws_agent_tokens_total",
  help: "Agent tokens used, by provider, model, Claude account, repo and job prefix; tasks and interactive sessions, counted from the database",
  labelNames: LABELS,
  registers: [registry],
  collect() {
    this.reset();
    for (const u of snapshot.usage ?? []) this.inc({ provider: u.provider, model: u.model, account: u.account, repo: u.repo, job: u.job }, u.tokens);
  },
});

new Counter({
  name: "claws_agent_cost_usd_total",
  help: "Agent cost in US dollars, by provider, model, Claude account, repo and job prefix; tasks and interactive sessions, counted from the database",
  labelNames: LABELS,
  registers: [registry],
  collect() {
    this.reset();
    for (const u of snapshot.usage ?? []) this.inc({ provider: u.provider, model: u.model, account: u.account, repo: u.repo, job: u.job }, u.costUsd);
  },
});

new Counter({
  name: "claws_agent_tasks_total",
  help: "Finished agent tasks by job prefix and outcome (completed, failed)",
  labelNames: ["job", "outcome"] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const o of snapshot.outcomes ?? []) this.inc({ job: o.job, outcome: o.outcome }, o.tasks);
  },
});

new Gauge({
  name: "claws_provider_hold_expiry_timestamp_seconds",
  help: "Unix time each active provider hold lapses, by provider, Claude account, model tier and reason",
  labelNames: ["provider", "account", "tier", "reason"] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const h of snapshot.holds ?? []) this.set({ provider: h.provider, account: h.account, tier: h.tier, reason: h.reason }, h.untilMs / 1000);
  },
});

new Gauge({
  name: "claws_agents_running",
  help: "Agent tasks running now, by job prefix",
  labelNames: ["job"] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const r of snapshot.running ?? []) this.set({ job: r.job }, r.count);
  },
});

new Gauge({
  name: "claws_queue_items",
  help: "Items in the controller's work queue snapshot, by category",
  labelNames: ["category"] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const [category, count] of snapshot.queue ?? []) this.set({ category }, count);
  },
});

new Gauge({
  name: "claws_work_queue_items",
  help: "Queued and running work_queue rows, by kind and status",
  labelNames: ["kind", "status"] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const w of snapshot.workQueue ?? []) this.set({ kind: w.kind, status: w.status }, w.count);
  },
});

new Gauge({
  name: "claws_board_issues",
  help: "Open issues on the board, by column (the nav's issues count, split by column)",
  labelNames: ["column"] as const,
  registers: [registry],
  collect() {
    this.reset();
    if (!board) return;
    for (const [column, count] of Object.entries(board.columns)) this.set({ column }, count);
  },
});

new Gauge({
  name: "claws_board_issues_waiting_on_operator",
  help: "Open board issues in a column that waits on the operator (the nav's issues attention count)",
  registers: [registry],
  collect() {
    this.reset();
    if (board) this.set(board.waiting);
  },
});

new Gauge({
  name: "claws_open_prs",
  help: "Open Claws PRs (claws_prs rows not merged or closed), by stage",
  labelNames: ["stage"] as const,
  registers: [registry],
  collect() {
    this.reset();
    if (!snapshot.prs) return;
    const counts = new Map<string, number>(OPEN_PR_STAGES.map((stage) => [stage, 0]));
    for (const p of snapshot.prs) counts.set(p.stage, (counts.get(p.stage) ?? 0) + p.count);
    for (const [stage, count] of counts) this.set({ stage }, count);
  },
});

new Gauge({
  name: "claws_job_last_run_timestamp_seconds",
  help: "Unix time each job's latest finished run completed, by job prefix",
  labelNames: ["job"] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const r of snapshot.jobLastRuns ?? []) this.set({ job: r.job }, r.completedAtMs / 1000);
  },
});

new Gauge({
  name: "claws_job_last_run_success",
  help: "1 when each job's latest finished run completed, 0 when it failed, by job prefix",
  labelNames: ["job"] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const r of snapshot.jobLastRuns ?? []) this.set({ job: r.job }, r.success ? 1 : 0);
  },
});

new Gauge({
  name: "claws_agent_metrics_last_sample_timestamp_seconds",
  help: "Unix time the agent and pipeline metrics last sampled without a failure",
  registers: [registry],
  collect() {
    this.reset();
    if (lastSampleAt !== null) this.set(lastSampleAt / 1000);
  },
});

// ── Sampling ──

/** A stored `YYYY-MM-DD HH:MM:SS` UTC timestamp as epoch ms. */
function sqlTimeMs(value: string): number {
  return Date.parse(`${value.replace(" ", "T")}Z`);
}

function queueCategoryCounts(): Map<string, number> {
  const counts = new Map<string, number>(gh.ALL_QUEUE_CATEGORIES.map((category) => [category, 0]));
  for (const item of gh.getQueueSnapshot(gh.ALL_QUEUE_CATEGORIES).items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  return counts;
}

async function readHolds(now: number): Promise<AgentSnapshot["holds"]> {
  const byLabels = new Map<string, AgentSnapshot["holds"][number]>();
  for (const row of await db.getActiveProviderHolds(now)) {
    const hold = { ...describeHoldKey(row.key, row.reason), untilMs: row.until_ms };
    const key = `${hold.provider}\u0000${hold.account}\u0000${hold.tier}\u0000${hold.reason}`;
    if (hold.untilMs > (byLabels.get(key)?.untilMs ?? 0)) byLabels.set(key, hold);
  }
  return [...byLabels.values()];
}

async function readJobLastRuns(): Promise<AgentSnapshot["jobLastRuns"]> {
  return (await db.getJobLastRuns())
    .map((r) => ({ job: r.job, completedAtMs: sqlTimeMs(r.completedAt), success: r.status === "completed" }))
    .filter((r) => Number.isFinite(r.completedAtMs));
}

/**
 * Refresh every snapshot but the board's. Each part is read on its own: one
 * that fails keeps its last good value and logs a warning, and the
 * last-sample timestamp only advances when every part succeeded.
 */
export async function sampleAgentMetrics(now = Date.now()): Promise<void> {
  const started = performance.now();
  const parts: { [K in keyof AgentSnapshot]: () => Promise<AgentSnapshot[K]> } = {
    usage: () => db.getAgentUsageTotals(),
    outcomes: () => db.getAgentTaskOutcomeTotals(),
    running: () => db.getRunningTaskCountsByJob(),
    workQueue: () => db.getWorkQueueCounts(),
    prs: () => db.getOpenClawsPrCountsByStage(),
    holds: () => readHolds(now),
    jobLastRuns: () => readJobLastRuns(),
    queue: async () => queueCategoryCounts(),
  };
  const names = Object.keys(parts) as Array<keyof AgentSnapshot>;
  const results = await Promise.allSettled(names.map((name) => parts[name]()));
  let failed = 0;
  results.forEach((result, i) => {
    const part = names[i]!;
    if (result.status === "fulfilled") {
      (snapshot as Record<string, unknown>)[part] = result.value;
    } else {
      failed++;
      log.warn("[agent-metrics] sample failed; keeping the last values", { part }, result.reason);
    }
  });
  if (failed === 0) lastSampleAt = now;
  log.debug("[agent-metrics] sampled", { duration_ms: Math.round(performance.now() - started), failed });
}

/** Recount the board columns. A failure keeps the last counts and logs a warning. */
export async function sampleBoardMetrics(): Promise<void> {
  const started = performance.now();
  try {
    board = await boardColumnCounts();
    log.debug("[agent-metrics] sampled board", { duration_ms: Math.round(performance.now() - started) });
  } catch (err) {
    log.warn("[agent-metrics] board sample failed; keeping the last values", { part: "board" }, err);
  }
}

let fastTimer: NodeJS.Timeout | null = null;
let fastRun: Promise<void> | null = null;
let boardRun: Promise<void> | null = null;
let boardTimer: NodeJS.Timeout | null = null;

/** Sample now, then every {@link AGENT_METRICS_SAMPLE_MS} (the board every {@link BOARD_METRICS_SAMPLE_MS}). Timers are `unref`ed. */
export function startAgentMetricsSampler(): void {
  if (fastTimer) return;
  // A tick is skipped while the previous sample is still running.
  const tickFast = () => {
    if (fastRun) return;
    fastRun = sampleAgentMetrics().finally(() => { fastRun = null; });
  };
  const tickBoard = () => {
    if (boardRun) return;
    boardRun = sampleBoardMetrics().finally(() => { boardRun = null; });
  };
  tickFast();
  tickBoard();
  fastTimer = setInterval(tickFast, AGENT_METRICS_SAMPLE_MS);
  fastTimer.unref();
  boardTimer = setInterval(tickBoard, BOARD_METRICS_SAMPLE_MS);
  boardTimer.unref();
}

/** Stop the timers; resolves once any sample already running has finished. */
export async function stopAgentMetricsSampler(): Promise<void> {
  if (fastTimer) clearInterval(fastTimer);
  if (boardTimer) clearInterval(boardTimer);
  fastTimer = null;
  boardTimer = null;
  await Promise.allSettled([fastRun, boardRun]);
}

/** Exposed for tests: forget every cached snapshot. */
export function resetAgentMetricsForTests(): void {
  for (const key of Object.keys(snapshot)) delete (snapshot as Record<string, unknown>)[key];
  board = null;
  lastSampleAt = null;
}
