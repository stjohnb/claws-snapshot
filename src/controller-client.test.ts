import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const configState = vi.hoisted(() => ({ pausedJobs: [] as string[], workBackend: "in-process" as "in-process" | "k8s-pod" }));
vi.mock("./config.js", () => ({
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
  get WORK_BACKEND() { return configState.workBackend; },
  get PAUSED_JOBS() { return configState.pausedJobs; },
  WHATSAPP_ENABLED: true,
  EMAIL_ENABLED: true,
  writeConfig: vi.fn(async (updates: { pausedJobs?: string[] }) => {
    if (updates.pausedJobs) configState.pausedJobs = [...updates.pausedJobs];
  }),
}));

vi.mock("./log.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const claudeMock = vi.hoisted(() => ({
  cancelCurrentTask: vi.fn(() => false),
  cancelTaskByRunId: vi.fn(() => true),
  clearProviderRateLimitState: vi.fn(() => true),
  isProviderRateLimited: vi.fn((p: string) => p === "codex"),
  getProviderRateLimitedUntil: vi.fn((p: string): number | null => (p === "codex" ? Date.now() + 60_000 : null)),
  getModelTierRateLimitedUntil: vi.fn((p: string, tier: string): number | null => (p === "claude" && tier === "fable" ? Date.now() + 60_000 : null)),
  getProviderLastUsedAt: vi.fn((p: string): number | null => (p === "claude" ? 1_700_000_000_000 : null)),
}));
vi.mock("./claude.js", () => claudeMock);

const podLauncher = vi.hoisted(() => ({ cancelByRunId: vi.fn(() => true), cancelAll: vi.fn(async () => 1) }));
vi.mock("./agent-pod-launcher.js", () => ({ getAgentPodLauncher: () => podLauncher }));

const queueItems = vi.hoisted(() => [{ repo: "org/repo", number: 7, title: "t", category: "ready" }]);
vi.mock("./github.js", () => ({
  ALL_QUEUE_CATEGORIES: ["ready"],
  getQueueSnapshot: vi.fn(() => ({ items: queueItems, oldestFetchAt: 123 })),
}));

vi.mock("./whatsapp.js", () => ({ whatsappStatus: vi.fn(() => ({ configured: true, connected: true, pairingRequired: false })) }));
vi.mock("./jobs/email-monitor.js", () => ({ getEmailStatus: vi.fn(() => ({ configured: true, lastCheck: "2026-10-19T12:00:00.000Z", lastError: null })) }));
vi.mock("./agent-auth-state.js", () => ({ isAgentAuthExpired: vi.fn((p: string) => p === "codex") }));

vi.mock("./worker.js", () => ({
  workerStatus: vi.fn(async () => ({
    workers: 4,
    running: 99,
    queued: 99,
    agentMemory: { active: true, budgetBytes: 1024, auxiliaryBudgetBytes: 0, reservedBytes: 0, admitted: 1, waiting: 2 },
  })),
}));

import { initDb, closeDb, enqueueWork, getControllerCommand, writeControllerStatus } from "./db.js";
import { dbControllerClient, executeControllerCommand, liveControllerClient, HEARTBEAT_STALE_MS, STATUS_KEYS } from "./controller-client.js";
import { publishControllerShuttingDown, publishControllerStatus, runPendingControllerCommands, startControllerPublisher, stopControllerPublisher } from "./controller-publisher.js";
import type { Scheduler } from "./scheduler.js";

function fakeScheduler(): Scheduler {
  const paused = new Set<string>(["ci-fixer"]);
  return {
    stop: vi.fn(),
    drain: vi.fn(async () => {}),
    jobStates: vi.fn(() => new Map([["issue-dispatcher", true], ["ci-fixer", false], ["doc-maintainer", false]])),
    triggerJob: vi.fn((name: string) => (name === "issue-dispatcher" ? "already-running" as const : "started" as const)),
    updateInterval: vi.fn(),
    updateScheduledHour: vi.fn(),
    pauseJob: vi.fn((name: string) => { paused.add(name); return true; }),
    resumeJob: vi.fn((name: string) => { paused.delete(name); return true; }),
    pausedJobs: vi.fn(() => new Set(paused)),
    jobScheduleInfo: vi.fn(() => new Map([
      ["issue-dispatcher", { intervalMs: 60_000, nextTickAt: 5 }],
      ["ci-fixer", { intervalMs: 300_000 }],
      ["doc-maintainer", { intervalMs: 86_400_000, scheduledHour: 3 }],
    ])),
    manualOnlyJobs: vi.fn(() => new Set(["doc-maintainer"])),
  };
}

/** Plays the controller: keeps running filed commands until stopped. */
function runController(scheduler: Scheduler, everyMs = 20): () => void {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      await runPendingControllerCommands(scheduler);
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  })();
  return () => { stopped = true; };
}

describe("controller-client", () => {
  let scheduler: Scheduler;

  beforeEach(async () => {
    await initDb();
    scheduler = fakeScheduler();
    configState.pausedJobs = [];
    configState.workBackend = "in-process";
    vi.clearAllMocks();
  });

  afterEach(async () => {
    stopControllerPublisher();
    await closeDb();
  });

  describe("dbControllerClient commands", () => {
    it("returns the controller's result when it answers within the wait", async () => {
      const stop = runController(scheduler);
      try {
        const client = dbControllerClient({ pollMs: 10 });
        expect(await client.triggerJob("ci-fixer")).toBe("started");
        expect(await client.triggerJob("issue-dispatcher")).toBe("already-running");
        expect(scheduler.triggerJob).toHaveBeenCalledWith("ci-fixer");
      } finally {
        stop();
      }
    });

    it("returns queued when the controller does not answer, and the row runs once it is back", async () => {
      const client = dbControllerClient({ waitMs: 50, pollMs: 10 });
      expect(await client.triggerJob("ci-fixer")).toBe("queued");
      expect(await client.cancelRun("run-1")).toBe("queued");
      expect(await client.cancelCurrentTask()).toBe("queued");
      expect(await client.clearRateLimit("codex")).toBe("queued");
      expect(scheduler.triggerJob).not.toHaveBeenCalled();

      // The controller comes back and runs them in the order they were filed.
      expect(await runPendingControllerCommands(scheduler)).toBe(4);
      expect(scheduler.triggerJob).toHaveBeenCalledWith("ci-fixer");
      expect(claudeMock.cancelTaskByRunId).toHaveBeenCalledWith("run-1");
      expect(claudeMock.cancelCurrentTask).toHaveBeenCalled();
      expect(claudeMock.clearProviderRateLimitState).toHaveBeenCalledWith("codex");
      expect(claudeMock.cancelTaskByRunId.mock.invocationCallOrder[0]!).toBeGreaterThan((scheduler.triggerJob as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
      const first = await getControllerCommand(1);
      expect(first).toMatchObject({ kind: "trigger-job", result_json: JSON.stringify("started") });
      expect(first?.completed_at).not.toBeNull();
      expect(await runPendingControllerCommands(scheduler)).toBe(0);
    });

    it("maps each command's answer onto the client's result", async () => {
      const stop = runController(scheduler);
      try {
        const client = dbControllerClient({ pollMs: 10 });
        expect(await client.cancelRun("run-2")).toBe("cancelled");
        expect(await client.cancelCurrentTask()).toBe("no-active-task");
        expect(await client.clearRateLimit("claude")).toBe(true);
      } finally {
        stop();
      }
    });

    it("answers unknown for a job the controller does not publish, without filing a command", async () => {
      await publishControllerStatus(scheduler);
      const client = dbControllerClient({ waitMs: 0 });
      expect(await client.triggerJob("no-such-job")).toBe("unknown");
      expect(await getControllerCommand(1)).toBeNull();
    });
  });

  describe("dbControllerClient status", () => {
    it("reports alive only while the heartbeat is under 20 s old", async () => {
      let now = 1_000_000;
      const client = dbControllerClient({ now: () => now });
      expect(await client.heartbeat()).toEqual({ alive: false, lastSeenAt: null, version: null, shuttingDown: false });

      await writeControllerStatus(STATUS_KEYS.heartbeat, { at: now, version: "v9", shuttingDown: false });
      expect(await client.heartbeat()).toEqual({ alive: true, lastSeenAt: new Date(now).toISOString(), version: "v9", shuttingDown: false });

      now += HEARTBEAT_STALE_MS + 1;
      expect(await client.heartbeat()).toMatchObject({ alive: false, version: "v9" });
    });

    it("reads the scheduler, providers, worker and queue snapshot the controller published", async () => {
      await enqueueWork("issue-implementer", "org/repo", 1);
      await publishControllerStatus(scheduler);
      const client = dbControllerClient();

      expect(await client.jobStates()).toEqual(new Map([["issue-dispatcher", true], ["ci-fixer", false], ["doc-maintainer", false]]));
      expect(await client.jobScheduleInfo()).toEqual(new Map([
        ["issue-dispatcher", { intervalMs: 60_000, nextTickAt: 5 }],
        ["ci-fixer", { intervalMs: 300_000 }],
        ["doc-maintainer", { intervalMs: 86_400_000, scheduledHour: 3 }],
      ]));
      expect(await client.manualOnlyJobs()).toEqual(new Set(["doc-maintainer"]));
      expect(await client.queueSnapshot()).toEqual({ items: queueItems, oldestFetchAt: 123 });

      // Counts come from the shared queue, the worker count and memory gate from the publish.
      expect(await client.workerStatus()).toMatchObject({ workers: 4, running: 0, queued: 1, agentMemory: { admitted: 1, waiting: 2 } });

      const providers = await client.providerStatus();
      expect(providers.codex).toMatchObject({ rateLimited: true, lastUsedAt: null });
      expect(providers.claude).toMatchObject({ rateLimited: false, rateLimitedUntil: null, lastUsedAt: 1_700_000_000_000 });
      expect(Object.keys(providers.claude.tierRateLimitedUntil)).toEqual(["fable"]);
      expect(await client.heartbeat()).toMatchObject({ alive: true, shuttingDown: false });

      // WhatsApp, email and the CLI logins are the controller's, not the reader's.
      expect(await client.integrations()).toEqual({
        startedAt: expect.any(String),
        whatsapp: { configured: true, connected: true, pairingRequired: false },
        email: { configured: true, lastCheck: "2026-10-19T12:00:00.000Z", lastError: null },
        agentAuthExpired: { claude: false, codex: true, opencode: false, pi: false },
      });
    });

    it("drops a cooldown that ended since the controller published it", async () => {
      await publishControllerStatus(scheduler);
      const client = dbControllerClient({ now: () => Date.now() + 120_000 });
      const providers = await client.providerStatus();
      expect(providers.codex).toMatchObject({ rateLimited: false, rateLimitedUntil: null });
      expect(providers.claude.tierRateLimitedUntil).toEqual({});
    });

    it("answers with empty state before the controller ever published", async () => {
      const client = dbControllerClient();
      expect(await client.jobStates()).toEqual(new Map());
      expect(await client.queueSnapshot()).toEqual({ items: [], oldestFetchAt: null });
      expect(await client.workerStatus()).toMatchObject({ workers: 0, running: 0, queued: 0, agentMemory: { active: false } });
      expect((await client.providerStatus()).claude.rateLimited).toBe(false);
      expect(await client.integrations()).toEqual({
        startedAt: null,
        whatsapp: { configured: false, connected: false, pairingRequired: false },
        email: { configured: false, lastCheck: null, lastError: null },
        agentAuthExpired: { claude: false, codex: false, opencode: false, pi: false },
      });
    });

    it("pauses and resumes through the stored pausedJobs, and refuses a job the controller does not have", async () => {
      await publishControllerStatus(scheduler);
      const client = dbControllerClient();
      expect(await client.pauseJob("issue-dispatcher")).toBe(true);
      expect(configState.pausedJobs).toEqual(["issue-dispatcher"]);
      expect(await client.pausedJobs()).toEqual(new Set(["issue-dispatcher"]));
      expect(await client.resumeJob("issue-dispatcher")).toBe(true);
      expect(configState.pausedJobs).toEqual([]);
      expect(await client.pauseJob("no-such-job")).toBe(false);
      expect(scheduler.pauseJob).not.toHaveBeenCalled();
    });
  });

  describe("liveControllerClient", () => {
    it("answers from the scheduler and stores pauses in config", async () => {
      const client = liveControllerClient(scheduler);
      expect(await client.triggerJob("ci-fixer")).toBe("started");
      expect(await client.pausedJobs()).toEqual(new Set(["ci-fixer"]));
      expect(await client.pauseJob("issue-dispatcher")).toBe(true);
      expect(new Set(configState.pausedJobs)).toEqual(new Set(["ci-fixer", "issue-dispatcher"]));
      expect(await client.heartbeat()).toMatchObject({ alive: true, shuttingDown: false });
      expect((await client.providerStatus()).codex.rateLimited).toBe(true);
    });

    it("kills a run's pod as well under k8s-pod", async () => {
      configState.workBackend = "k8s-pod";
      const client = liveControllerClient(scheduler);
      expect(await client.cancelRun("run-3")).toBe("cancelled");
      expect(podLauncher.cancelByRunId).toHaveBeenCalledWith("run-3");
      expect(await client.cancelCurrentTask()).toBe("cancelled");
    });
  });

  describe("executeControllerCommand", () => {
    it("answers an error for an unknown kind or bad arguments rather than throwing", async () => {
      expect(await executeControllerCommand(scheduler, "explode", {})).toEqual({ error: "unknown command explode" });
      expect(await executeControllerCommand(scheduler, "trigger-job", {})).toEqual({ error: "name must be a string" });
      expect(await executeControllerCommand(scheduler, "clear-rate-limit", { provider: "nope" })).toEqual({ error: "unknown provider" });
    });
  });

  describe("controller-publisher", () => {
    it("publishes at start and a shutting-down heartbeat at shutdown, then stops claiming commands", async () => {
      startControllerPublisher(scheduler);
      const client = dbControllerClient({ waitMs: 50, pollMs: 10 });
      await vi.waitFor(async () => expect((await client.heartbeat()).alive).toBe(true));

      await publishControllerShuttingDown();
      expect(await client.heartbeat()).toMatchObject({ alive: true, shuttingDown: true });
      expect(await client.triggerJob("ci-fixer")).toBe("queued");
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(scheduler.triggerJob).not.toHaveBeenCalled();
    });
  });
});
