import * as config from "./config.js";
import { writeConfig } from "./config.js";
import { cancelCurrentTask, cancelTaskByRunId, clearProviderRateLimitState, getModelTierRateLimitedUntil, getProviderLastUsedAt, getProviderRateLimitedUntil, isProviderRateLimited } from "./claude.js";
import { getAgentPodLauncher } from "./agent-pod-launcher.js";
import { isAgentAuthExpired } from "./agent-auth-state.js";
import { countWorkByStatus, getControllerCommand, insertControllerCommand, readControllerStatus } from "./db.js";
import { getQueueSnapshot, ALL_QUEUE_CATEGORIES } from "./github.js";
import { getEmailStatus } from "./jobs/email-monitor.js";
import type { ModelTier } from "./model-selector.js";
import type { Provider } from "./plan-parser.js";
import type { Scheduler } from "./scheduler.js";
import { isShuttingDown } from "./shutdown.js";
import { sleep as defaultSleep } from "./util.js";
import { VERSION } from "./version.js";
import { whatsappStatus } from "./whatsapp.js";
import * as worker from "./worker.js";

/**
 * Everything the dashboard reads or changes about background processing
 * (#clw_01M5APX7YF3AGWHV1S1WMHJDR6): the scheduler's jobs, the work queue's
 * workers, provider rate limits, the queue cache, the controller's own
 * liveness and the integrations only it runs (WhatsApp, the email monitor,
 * the agent CLI logins).
 *
 * {@link liveControllerClient} answers in-process, for the process that runs
 * the scheduler. {@link dbControllerClient} answers from what the controller
 * last published to `controller_status` (`controller-publisher.ts`) and files
 * actions as `controller_commands` rows, so a process without the scheduler
 * — or one whose controller is restarting — still answers. Pause and resume
 * ride on `pausedJobs` in the config store, which the controller applies on
 * its next config reload.
 */

export type TriggerResult = ReturnType<Scheduler["triggerJob"]> | "queued";
export type CancelCurrentTaskResult = "cancelled" | "no-active-task" | "queued";
export type CancelRunResult = "cancelled" | "queued";

export interface JobScheduleInfo {
  intervalMs: number;
  scheduledHour?: number;
  nextTickAt?: number;
}

export const STATUS_PROVIDERS = ["claude", "codex", "opencode", "pi"] as const satisfies readonly Provider[];
export type StatusProvider = (typeof STATUS_PROVIDERS)[number];
const MODEL_TIERS: readonly ModelTier[] = ["fable", "opus", "sonnet", "haiku"];

export interface ProviderStatus {
  rateLimited: boolean;
  /** Epoch ms the provider-wide cooldown ends, or null. */
  rateLimitedUntil: number | null;
  /** Epoch ms each held-down model tier's cooldown ends. */
  tierRateLimitedUntil: Partial<Record<ModelTier, number>>;
  /** Epoch ms the controller last ran an agent on the provider, or null since its boot. */
  lastUsedAt: number | null;
}
export type ProviderStatuses = Record<StatusProvider, ProviderStatus>;

export type WorkerStatus = Awaited<ReturnType<typeof worker.workerStatus>>;
export type QueueSnapshot = ReturnType<typeof getQueueSnapshot>;

export interface ControllerHeartbeat {
  /** The controller published a heartbeat within {@link HEARTBEAT_STALE_MS}. */
  alive: boolean;
  /** ISO time of the last heartbeat, or null when none was ever published. */
  lastSeenAt: string | null;
  version: string | null;
  shuttingDown: boolean;
}

export interface ControllerClient {
  jobStates(): Promise<Map<string, boolean>>;
  jobScheduleInfo(): Promise<Map<string, JobScheduleInfo>>;
  pausedJobs(): Promise<Set<string>>;
  manualOnlyJobs(): Promise<Set<string>>;
  triggerJob(name: string): Promise<TriggerResult>;
  /** Pauses the job and stores it in `pausedJobs`; false for an unknown job. */
  pauseJob(name: string): Promise<boolean>;
  /** Resumes the job and drops it from `pausedJobs`; false for an unknown job. */
  resumeJob(name: string): Promise<boolean>;
  /** Kills the run's agent processes or pods; the caller has already marked the run cancelled. */
  cancelRun(runId: string): Promise<CancelRunResult>;
  cancelCurrentTask(): Promise<CancelCurrentTaskResult>;
  /** True when an open breaker was cleared. */
  clearRateLimit(provider: StatusProvider): Promise<boolean | "queued">;
  providerStatus(): Promise<ProviderStatuses>;
  workerStatus(): Promise<WorkerStatus>;
  queueSnapshot(): Promise<QueueSnapshot>;
  heartbeat(): Promise<ControllerHeartbeat>;
  integrations(): Promise<ControllerIntegrations>;
}

/** State only the controller process holds, for `/status`, `/api/status` and `/api/providers`. */
export interface ControllerIntegrations {
  /** ISO time the controller process started; null before it ever published. */
  startedAt: string | null;
  whatsapp: { configured: boolean; connected: boolean; pairingRequired: boolean };
  email: { configured: boolean; lastCheck: string | null; lastError: string | null };
  /** The provider's CLI login was last seen expired. */
  agentAuthExpired: Record<StatusProvider, boolean>;
}

const PROCESS_STARTED_AT = new Date().toISOString();

/** A heartbeat older than this means the controller is down or restarting. */
export const HEARTBEAT_STALE_MS = 20_000;
/** Longest {@link dbControllerClient} waits for the controller to run a command. */
export const COMMAND_WAIT_MS = 3_000;
export const COMMAND_POLL_MS = 250;

/** The `controller_status` keys `controller-publisher.ts` writes. */
export const STATUS_KEYS = {
  heartbeat: "heartbeat",
  scheduler: "scheduler",
  providers: "providers",
  worker: "worker",
  queueSnapshot: "queue-snapshot",
  integrations: "integrations",
} as const;

export interface PublishedHeartbeat {
  /** Epoch ms. */
  at: number;
  version: string;
  shuttingDown: boolean;
}

export interface PublishedJob extends JobScheduleInfo {
  name: string;
  running: boolean;
  paused: boolean;
  manualOnly: boolean;
}

export interface PublishedScheduler {
  jobs: PublishedJob[];
}

/** A `controller_commands` row's kind and arguments. */
export type ControllerCommand =
  | { kind: "trigger-job"; args: { name: string } }
  | { kind: "cancel-run"; args: { runId: string } }
  | { kind: "cancel-current-task"; args: Record<string, never> }
  | { kind: "clear-rate-limit"; args: { provider: StatusProvider } };

function isStatusProvider(value: unknown): value is StatusProvider {
  return typeof value === "string" && (STATUS_PROVIDERS as readonly string[]).includes(value);
}

/** Kills the run's agent processes, and its pod under `k8s-pod`. */
function killRun(runId: string): void {
  cancelTaskByRunId(runId);
  if (config.WORK_BACKEND === "k8s-pod") getAgentPodLauncher().cancelByRunId(runId);
}

async function killCurrentTasks(): Promise<"cancelled" | "no-active-task"> {
  let cancelled = cancelCurrentTask();
  // Headless agents run in their own pods under k8s-pod, not as children of this process.
  if (config.WORK_BACKEND === "k8s-pod" && await getAgentPodLauncher().cancelAll() > 0) cancelled = true;
  return cancelled ? "cancelled" : "no-active-task";
}

/**
 * Runs one command in the controller and returns its JSON-safe result.
 * Unknown kinds or malformed arguments answer `{ error }` rather than throwing,
 * so one bad row never wedges the queue behind it.
 */
export async function executeControllerCommand(scheduler: Scheduler, kind: string, args: unknown): Promise<unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (kind) {
    case "trigger-job":
      if (typeof a["name"] !== "string") return { error: "name must be a string" };
      return scheduler.triggerJob(a["name"]);
    case "cancel-run":
      if (typeof a["runId"] !== "string") return { error: "runId must be a string" };
      killRun(a["runId"]);
      return "cancelled";
    case "cancel-current-task":
      return await killCurrentTasks();
    case "clear-rate-limit":
      if (!isStatusProvider(a["provider"])) return { error: "unknown provider" };
      return clearProviderRateLimitState(a["provider"]);
    default:
      return { error: `unknown command ${kind}` };
  }
}

/** The controller's provider breakers, as `providerStatus` reports them. */
export function liveProviderStatus(): ProviderStatuses {
  const out = {} as ProviderStatuses;
  for (const provider of STATUS_PROVIDERS) {
    const tierRateLimitedUntil: Partial<Record<ModelTier, number>> = {};
    for (const tier of MODEL_TIERS) {
      const until = getModelTierRateLimitedUntil(provider, tier);
      if (until !== null) tierRateLimitedUntil[tier] = until;
    }
    out[provider] = {
      rateLimited: isProviderRateLimited(provider),
      rateLimitedUntil: getProviderRateLimitedUntil(provider),
      tierRateLimitedUntil,
      lastUsedAt: getProviderLastUsedAt(provider),
    };
  }
  return out;
}

/** This process's integrations, as `controller-publisher.ts` publishes them. */
export function liveIntegrations(): ControllerIntegrations {
  const agentAuthExpired = {} as Record<StatusProvider, boolean>;
  for (const provider of STATUS_PROVIDERS) agentAuthExpired[provider] = isAgentAuthExpired(provider);
  return {
    startedAt: PROCESS_STARTED_AT,
    whatsapp: config.WHATSAPP_ENABLED ? whatsappStatus() : { configured: false, connected: false, pairingRequired: false },
    email: config.EMAIL_ENABLED ? getEmailStatus() : { configured: false, lastCheck: null, lastError: null },
    agentAuthExpired,
  };
}

/** The scheduler's state, as `controller-publisher.ts` publishes it. */
export function liveSchedulerStatus(scheduler: Scheduler): PublishedScheduler {
  const info = scheduler.jobScheduleInfo();
  const paused = scheduler.pausedJobs();
  const manual = scheduler.manualOnlyJobs();
  return {
    jobs: [...scheduler.jobStates()].map(([name, running]) => ({
      name,
      running,
      paused: paused.has(name),
      manualOnly: manual.has(name),
      ...(info.get(name) ?? { intervalMs: 0 }),
    })),
  };
}

/** Answers in-process, for the process that runs `scheduler`. */
export function liveControllerClient(scheduler: Scheduler): ControllerClient {
  return {
    jobStates: async () => scheduler.jobStates(),
    jobScheduleInfo: async () => scheduler.jobScheduleInfo(),
    pausedJobs: async () => scheduler.pausedJobs(),
    manualOnlyJobs: async () => scheduler.manualOnlyJobs(),
    triggerJob: async (name) => scheduler.triggerJob(name),
    pauseJob: async (name) => {
      if (!scheduler.pauseJob(name)) return false;
      await writeConfig({ pausedJobs: [...scheduler.pausedJobs()] });
      return true;
    },
    resumeJob: async (name) => {
      if (!scheduler.resumeJob(name)) return false;
      await writeConfig({ pausedJobs: [...scheduler.pausedJobs()] });
      return true;
    },
    cancelRun: async (runId) => {
      killRun(runId);
      return "cancelled";
    },
    cancelCurrentTask: killCurrentTasks,
    clearRateLimit: async (provider) => clearProviderRateLimitState(provider),
    providerStatus: async () => liveProviderStatus(),
    workerStatus: () => worker.workerStatus(),
    queueSnapshot: async () => getQueueSnapshot(ALL_QUEUE_CATEGORIES),
    heartbeat: async () => ({ alive: true, lastSeenAt: new Date().toISOString(), version: VERSION, shuttingDown: isShuttingDown() }),
    integrations: async () => liveIntegrations(),
  };
}

export interface DbControllerClientOptions {
  /** Longest a command waits for the controller's answer before returning `queued`. */
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const EMPTY_AGENT_MEMORY: WorkerStatus["agentMemory"] = {
  active: false,
  budgetBytes: null,
  auxiliaryBudgetBytes: 0,
  reservedBytes: 0,
  admitted: 0,
  waiting: 0,
};

/**
 * Answers from `controller_status` and files actions as `controller_commands`
 * rows. A command waits up to {@link COMMAND_WAIT_MS} for the controller's
 * result and otherwise returns `queued`; the row stays and runs when the
 * controller next polls, including after it restarts.
 */
export function dbControllerClient(opts: DbControllerClientOptions = {}): ControllerClient {
  const waitMs = opts.waitMs ?? COMMAND_WAIT_MS;
  const pollMs = opts.pollMs ?? COMMAND_POLL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  async function command<T>(cmd: ControllerCommand): Promise<T | "queued"> {
    const id = await insertControllerCommand(cmd.kind, cmd.args);
    const deadline = now() + waitMs;
    for (;;) {
      const row = await getControllerCommand(id);
      if (row?.completed_at) return (row.result_json === null ? null : JSON.parse(row.result_json)) as T;
      const left = deadline - now();
      if (left <= 0) return "queued";
      await sleep(Math.min(pollMs, left));
    }
  }

  async function publishedJobs(): Promise<PublishedJob[] | null> {
    return (await readControllerStatus<PublishedScheduler>(STATUS_KEYS.scheduler))?.jobs ?? null;
  }

  /** Unknown only when the controller published its jobs and `name` is not one. */
  async function isKnownJob(name: string): Promise<boolean> {
    const jobs = await publishedJobs();
    return jobs === null || jobs.some((j) => j.name === name);
  }

  async function setPaused(name: string, paused: boolean): Promise<boolean> {
    if (!await isKnownJob(name)) return false;
    const next = new Set(config.PAUSED_JOBS);
    if (paused) next.add(name);
    else next.delete(name);
    await writeConfig({ pausedJobs: [...next] });
    return true;
  }

  return {
    jobStates: async () => new Map((await publishedJobs() ?? []).map((j) => [j.name, j.running])),
    jobScheduleInfo: async () => new Map((await publishedJobs() ?? []).map((j) => [j.name, {
      intervalMs: j.intervalMs,
      ...(j.scheduledHour !== undefined ? { scheduledHour: j.scheduledHour } : {}),
      ...(j.nextTickAt !== undefined ? { nextTickAt: j.nextTickAt } : {}),
    }])),
    // The stored config is what the controller applies, and it is current here
    // the moment it is written, so it beats the controller's last publish.
    pausedJobs: async () => new Set(config.PAUSED_JOBS),
    manualOnlyJobs: async () => new Set((await publishedJobs() ?? []).filter((j) => j.manualOnly).map((j) => j.name)),
    triggerJob: async (name) => {
      if (!await isKnownJob(name)) return "unknown";
      return await command<TriggerResult>({ kind: "trigger-job", args: { name } });
    },
    pauseJob: (name) => setPaused(name, true),
    resumeJob: (name) => setPaused(name, false),
    cancelRun: async (runId) => {
      const result = await command<CancelRunResult>({ kind: "cancel-run", args: { runId } });
      return result === "queued" ? "queued" : "cancelled";
    },
    cancelCurrentTask: () => command<CancelCurrentTaskResult>({ kind: "cancel-current-task", args: {} }),
    clearRateLimit: async (provider) => {
      const result = await command<boolean>({ kind: "clear-rate-limit", args: { provider } });
      return result === "queued" ? "queued" : result === true;
    },
    providerStatus: async () => {
      const published = await readControllerStatus<Partial<ProviderStatuses>>(STATUS_KEYS.providers);
      const at = now();
      const out = {} as ProviderStatuses;
      for (const provider of STATUS_PROVIDERS) {
        const p = published?.[provider];
        // Re-judged against the clock: a cooldown that ended since the last
        // publish no longer counts.
        const until = p?.rateLimitedUntil != null && p.rateLimitedUntil > at ? p.rateLimitedUntil : null;
        const tierRateLimitedUntil: Partial<Record<ModelTier, number>> = {};
        for (const [tier, t] of Object.entries(p?.tierRateLimitedUntil ?? {}) as Array<[ModelTier, number]>) {
          if (t > at) tierRateLimitedUntil[tier] = t;
        }
        out[provider] = { rateLimited: until !== null, rateLimitedUntil: until, tierRateLimitedUntil, lastUsedAt: p?.lastUsedAt ?? null };
      }
      return out;
    },
    workerStatus: async () => {
      // Counts come straight from the shared queue; the worker count and the
      // memory gate only the controller knows.
      const [counts, published] = await Promise.all([countWorkByStatus(), readControllerStatus<WorkerStatus>(STATUS_KEYS.worker)]);
      return {
        workers: published?.workers ?? 0,
        running: counts["running"] ?? 0,
        queued: counts["queued"] ?? 0,
        agentMemory: published?.agentMemory ?? EMPTY_AGENT_MEMORY,
      };
    },
    queueSnapshot: async () => await readControllerStatus<QueueSnapshot>(STATUS_KEYS.queueSnapshot) ?? { items: [], oldestFetchAt: null },
    heartbeat: async () => {
      const hb = await readControllerStatus<PublishedHeartbeat>(STATUS_KEYS.heartbeat);
      if (!hb) return { alive: false, lastSeenAt: null, version: null, shuttingDown: false };
      return {
        alive: now() - hb.at < HEARTBEAT_STALE_MS,
        lastSeenAt: new Date(hb.at).toISOString(),
        version: hb.version,
        shuttingDown: hb.shuttingDown,
      };
    },
    integrations: async () => {
      const published = await readControllerStatus<Partial<ControllerIntegrations>>(STATUS_KEYS.integrations);
      const agentAuthExpired = {} as Record<StatusProvider, boolean>;
      for (const provider of STATUS_PROVIDERS) agentAuthExpired[provider] = published?.agentAuthExpired?.[provider] === true;
      return {
        startedAt: published?.startedAt ?? null,
        whatsapp: published?.whatsapp ?? { configured: false, connected: false, pairingRequired: false },
        email: published?.email ?? { configured: false, lastCheck: null, lastError: null },
        agentAuthExpired,
      };
    },
  };
}
