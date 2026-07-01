import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import crypto from "node:crypto";

vi.mock("./config.js", () => ({
  SERVER_PORT: 0,
  BIND_HOST: "127.0.0.1",
  ACTIVATION_STATE: "active",
  isActive: () => true,
  WHATSAPP_ENABLED: false,
  INTERNAL_MCP_TOKEN: "test-internal-mcp-token",
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    problematic: "Claws Problematic",
  },
  LABEL_SPECS: {
    "Refined":              { color: "0075ca", description: "Issue is ready for claws to implement" },
    "Ready":                { color: "0e8a16", description: "Claws has finished — needs human attention" },
  },
  VALID_AGENT_NAMES: ["planner", "implementer", "ci-fixer", "review-addresser", "reviewer", "merger"],
  DISABLED_AGENTS: [] as string[],
  loadConfig: vi.fn().mockReturnValue({
    slackWebhook: "https://hooks.slack.com/abcdef",
    githubOwners: ["owner1"],
    selfRepo: "owner1/repo1",
    openaiApiKey: "",
    port: 3000,
    intervals: { issueWorkerMs: 300000, issueRefinerMs: 300000, ciFixerMs: 600000, reviewAddresserMs: 300000, bugInvestigatorMs: 600000, autoMergerMs: 600000 },
    schedules: { repoStandardsHour: 2 },
    logRetentionDays: 14,
    logRetentionPerJob: 20,
    whatsappEnabled: false,
    whatsappAllowedNumbers: [],
    disabledAgents: [],
    notifyDashboardActions: true,
  }),
  getConfigForDisplay: vi.fn().mockReturnValue({
    slackWebhook: "****cdef",
    githubOwners: ["owner1"],
    selfRepo: "owner1/repo1",
    openaiApiKey: "Not configured",
    port: 3000,
    intervals: { issueWorkerMs: 300000, issueRefinerMs: 300000, ciFixerMs: 600000, reviewAddresserMs: 300000, bugInvestigatorMs: 600000, autoMergerMs: 600000 },
    schedules: { repoStandardsHour: 2 },
    logRetentionDays: 14,
    logRetentionPerJob: 20,
    whatsappEnabled: false,
    whatsappAllowedNumbers: [],
    disabledAgents: [],
    notifyDashboardActions: true,
  }),
  writeConfig: vi.fn(),
  getUnknownConfigKeys: vi.fn().mockReturnValue([]),
  removeConfigKeys: vi.fn(),
  SKIPPED_ITEMS: [],
  PRIORITIZED_ITEMS: [],
  EMAIL_ENABLED: false,
  NOTIFY_DASHBOARD_ACTIONS: true,
  SENSITIVE_KEYS: new Set(["slackWebhook", "slackBotToken", "openaiApiKey", "emailAppPassword", "nameyDbUrl"]),
  DEEP_MERGED_KEYS: new Set(["intervals", "schedules"]),
  OPENROUTER_API_KEY: "",
  TOOL_USE_PROVIDER_FALLBACK_ORDER: ["claude"],
  TEXT_ONLY_PROVIDER_FALLBACK_ORDER: ["opencode"],
  OIDC_CLIENT_ID: "",
  OIDC_CLIENT_SECRET: "",
  OIDC_BASE_URL: "",
  OIDC_APPLICATION_SLUG: "",
  OIDC_REDIRECT_URI: "",
  DISABLED_JOBS_BY_REPO: {},
  HOME_ASSISTANT_BASE_URL: "",
  HOME_ASSISTANT_TOKEN: "",
  NAMEY_DB_URL: "",
  FLEET_INFRA_REPO: "St-John-Software/fleet-infra",
  K3S_MONITOR_ENABLED: false,
  PROD_K8S_REPO: "St-John-Software/prod-infra",
  PROD_K8S_MONITOR_ENABLED: false,
  PROD_K8S_KUBECONFIG_PATH: "",
  FLEET_KUBECONFIG_PATH: "",
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./version.js", () => ({
  VERSION: "1.2.3-test",
}));

vi.mock("./claude.js", () => ({
  cancelCurrentTask: vi.fn().mockReturnValue(true),
  cancelTaskByRunId: vi.fn().mockReturnValue(false),
  isProviderRateLimited: vi.fn().mockReturnValue(false),
  getProviderLastUsedAt: vi.fn().mockReturnValue(null),
  isOpenCodeBinaryAvailable: vi.fn().mockReturnValue(false),
}));

vi.mock("./worker.js", () => ({
  workerStatus: vi.fn().mockReturnValue({ workers: 4, running: 1, queued: 2 }),
}));

vi.mock("./slack.js", () => ({
  notify: vi.fn(),
  slackStatus: vi.fn().mockReturnValue({ configured: true, lastResult: "ok" }),
  isSlackBotConfigured: vi.fn().mockReturnValue(false),
}));

vi.mock("./whatsapp.js", () => ({
  whatsappStatus: vi.fn().mockReturnValue({ configured: false, connected: false }),
  unpair: vi.fn().mockResolvedValue(undefined),
  isPairing: vi.fn().mockReturnValue(false),
  startPairing: vi.fn().mockImplementation((listener: (event: { type: string }) => void) => {
    // Simulate immediate successful connection
    listener({ type: "connected" });
    return Promise.resolve();
  }),
  stopPairing: vi.fn(),
  cancelPairing: vi.fn(),
}));

vi.mock("./jobs/email-monitor.js", () => ({
  getEmailStatus: vi.fn().mockReturnValue({ configured: false, lastCheck: null, lastError: null }),
}));

vi.mock("./github.js", () => ({
  getQueueSnapshot: vi.fn().mockReturnValue({ items: [], oldestFetchAt: null }),
  enrichQueueItemsWithPRStatus: vi.fn().mockResolvedValue(undefined),
  mergePR: vi.fn().mockResolvedValue(undefined),
  removeQueueItem: vi.fn(),
  listRepos: vi.fn().mockResolvedValue([]),
  listOpenIssues: vi.fn().mockResolvedValue([]),
  listPRs: vi.fn().mockResolvedValue([]),
  listIssuesByLabel: vi.fn().mockResolvedValue([]),
  addLabel: vi.fn().mockResolvedValue(undefined),
  removeLabel: vi.fn().mockResolvedValue(undefined),
  cancelWorkflow: vi.fn().mockResolvedValue(undefined),
  ALL_QUEUE_CATEGORIES: ["ready", "needs-refinement", "refined", "needs-review-addressing", "auto-mergeable", "needs-triage", "needs-qa", "problematic"],
}));

vi.mock("./db.js", () => ({
  getRecentJobRuns: vi.fn().mockReturnValue([
    { run_id: "abc-123", job_name: "issue-worker", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" },
    { run_id: "def-456", job_name: "ci-fixer", status: "failed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:00:30" },
  ]),
  getDistinctJobNames: vi.fn().mockReturnValue(["ci-fixer", "doc-maintainer", "issue-worker"]),
  getJobRun: vi.fn().mockImplementation((runId: string) => {
    if (runId === "abc-123") {
      return { run_id: "abc-123", job_name: "issue-worker", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" };
    }
    if (runId === "running-456") {
      return { run_id: "running-456", job_name: "ci-fixer", status: "running", started_at: "2025-01-01 00:00:00", completed_at: null };
    }
    return undefined;
  }),
  getJobRunLogs: vi.fn().mockReturnValue([
    { id: 1, run_id: "abc-123", level: "info", message: "Starting", logged_at: "2025-01-01 00:00:00" },
  ]),
  getJobRunLogsSince: vi.fn().mockImplementation((_runId: string, afterId: number) => {
    if (afterId >= 1) return [];
    return [
      { id: 1, run_id: "abc-123", level: "info", message: "Starting", logged_at: "2025-01-01 00:00:00" },
    ];
  }),
  getLatestRunIdsByJob: vi.fn().mockReturnValue(
    new Map([
      ["issue-worker", { runId: "abc-123", status: "completed", startedAt: "2025-01-01 00:00:00", completedAt: "2025-01-01 00:01:00" }],
      ["ci-fixer", { runId: "def-456", status: "failed", startedAt: "2025-01-01 00:00:00", completedAt: "2025-01-01 00:00:30" }],
    ]),
  ),
  getRunningTasks: vi.fn().mockReturnValue([
    { id: 1, job_name: "issue-worker", repo: "org/repo", item_number: 42, trigger_label: "Refined", worktree_path: null, branch_name: null, run_id: null, status: "running", error: null, started_at: "2025-01-01 00:00:00", completed_at: null },
  ]),
  getTasksByRunId: vi.fn().mockReturnValue([]),
  getWorkItemsForRuns: vi.fn().mockReturnValue(new Map()),
  getRecentWorkItems: vi.fn().mockReturnValue([]),
  searchRunsByItem: vi.fn().mockReturnValue([]),
  getRunsForIssue: vi.fn().mockReturnValue([]),
  getLogsForRuns: vi.fn().mockReturnValue(new Map()),
  getAverageTaskDurationMs: vi.fn().mockReturnValue(null),
  getAllAverageTaskDurations: vi.fn().mockReturnValue({}),
  getQueueSnapshots: vi.fn().mockReturnValue([]),
  getLastTaskTimePerRepo: vi.fn().mockReturnValue(new Map()),
  getRecentTasksForRepo: vi.fn().mockReturnValue([]),
  getDailyTaskStats: vi.fn().mockReturnValue([]),
  getLastUsedByProvider: vi.fn().mockReturnValue({ claude: null, codex: null, opencode: null }),
  getActiveWorkflowRuns: vi.fn().mockReturnValue([]),
  getWorkflowRunStats: vi.fn().mockReturnValue({ total: 0, succeeded: 0, failed: 0, avgDurationMs: null }),
  getLastWorkflowRunSync: vi.fn().mockReturnValue(null),
  getRecentWhatsappEvents: vi.fn().mockReturnValue([]),
  cancelJobRunIfRunning: vi.fn().mockReturnValue(false),
  listQueuedWork: vi.fn().mockReturnValue([]),
}));

import { formatUptime, buildLogsListPage, buildLogDetailPage, buildIssueLogsPage, buildQueuePage } from "./server.js";
import type { Theme } from "./server.js";
import { createServer } from "./server.js";
import type { Scheduler } from "./scheduler.js";

function mockScheduler(): Scheduler {
  const _paused = new Set<string>();
  return {
    stop: vi.fn(),
    drain: vi.fn(),
    jobStates: vi.fn().mockReturnValue(
      new Map([
        ["issue-worker", true],
        ["ci-fixer", false],
      ]),
    ),
    triggerJob: vi.fn().mockReturnValue("started"),
    updateInterval: vi.fn(),
    updateScheduledHour: vi.fn(),
    pauseJob: vi.fn().mockImplementation((name: string) => {
      if (name === "issue-worker" || name === "ci-fixer") {
        _paused.add(name);
        return true;
      }
      return false;
    }),
    resumeJob: vi.fn().mockImplementation((name: string) => {
      if (name === "issue-worker" || name === "ci-fixer") {
        _paused.delete(name);
        return true;
      }
      return false;
    }),
    pausedJobs: vi.fn().mockImplementation(() => new Set(_paused)),
    jobScheduleInfo: vi.fn().mockReturnValue(
      new Map([
        ["issue-worker", { intervalMs: 300000 }],
        ["ci-fixer", { intervalMs: 600000 }],
      ]),
    ),
  };
}

// Module-level session cookie injected into every request by the helper below.
// The file-level beforeEach arms it with a valid signed session so the many
// suites that predate fail-closed auth keep exercising protected routes under
// OIDC. Auth-specific suites set it to null to opt out.
let testSessionCookie: string | null = null;

// Mirrors signSession in server.ts so tests can mint valid session cookies.
function signSession(sub: string, expiresAt: number, secret: string): string {
  const payload = `${sub}|${expiresAt}`;
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}|${hmac}`;
}

function request(
  server: http.Server,
  method: string,
  path: string,
  options?: { headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      reject(new Error("Server not listening"));
      return;
    }
    const reqHeaders: Record<string, string> = { ...(options?.headers ?? {}) };
    if (options?.body && !reqHeaders["content-type"]) {
      reqHeaders["content-type"] = "application/x-www-form-urlencoded";
    }
    if (testSessionCookie) {
      const existing = reqHeaders["Cookie"] ?? reqHeaders["cookie"];
      reqHeaders["Cookie"] = existing
        ? `${existing}; claws_session=${encodeURIComponent(testSessionCookie)}`
        : `claws_session=${encodeURIComponent(testSessionCookie)}`;
    }
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method, headers: reqHeaders },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    if (options?.body) req.write(options.body);
    req.end();
  });
}

// Fail-closed auth: with OIDC unconfigured every authenticated route is denied,
// so by default we enable OIDC and arm a valid session cookie for all tests.
// Auth-specific suites override this in their own (later-running) beforeEach.
const TEST_OIDC_SECRET = "test-oidc-client-secret";
beforeEach(async () => {
  const configMod = await import("./config.js");
  (configMod as Record<string, unknown>).OIDC_CLIENT_ID = "test-client-id";
  (configMod as Record<string, unknown>).OIDC_CLIENT_SECRET = TEST_OIDC_SECRET;
  (configMod as Record<string, unknown>).OIDC_BASE_URL = "https://auth.example.com";
  (configMod as Record<string, unknown>).OIDC_APPLICATION_SLUG = "claws";
  testSessionCookie = signSession("test-user", Date.now() + 24 * 60 * 60 * 1000, TEST_OIDC_SECRET);
});
afterEach(async () => {
  const configMod = await import("./config.js");
  for (const k of ["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_BASE_URL", "OIDC_APPLICATION_SLUG"]) {
    (configMod as Record<string, unknown>)[k] = "";
  }
  testSessionCookie = null;
});

describe("formatUptime", () => {
  it("returns '0s' for 0 seconds", () => {
    expect(formatUptime(0)).toBe("0s");
  });

  it("formats seconds only", () => {
    expect(formatUptime(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatUptime(90)).toBe("1m 30s");
  });

  it("formats exactly 1 hour", () => {
    expect(formatUptime(3600)).toBe("1h 0s");
  });

  it("formats days, hours, minutes, seconds", () => {
    expect(formatUptime(90061)).toBe("1d 1h 1m 1s");
  });

  it("formats exactly 1 day", () => {
    expect(formatUptime(86400)).toBe("1d 0s");
  });
});

describe("HTTP server", () => {
  let server: http.Server;
  let scheduler: Scheduler;

  beforeEach(async () => {
    scheduler = mockScheduler();
    server = createServer(scheduler);
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET /health returns 200 with status JSON", async () => {
    const res = await request(server, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.version).toBe("1.2.3-test");
  });

  it("GET /status returns 200 with job states, slack status, and running tasks", async () => {
    const res = await request(server, "GET", "/status");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.jobs).toEqual({ "issue-worker": true, "ci-fixer": false });
    expect(body.claudeQueue).toEqual({ pending: 2, active: 1 });
    expect(typeof body.uptime).toBe("number");
    expect(body.slack).toEqual({ configured: true, lastResult: "ok" });
    expect(body.homeAssistant).toEqual({ configured: false, lastCheck: null, lastError: null });
    expect(body.runningTasks).toEqual([
      { jobName: "issue-worker", repo: "org/repo", itemNumber: 42, startedAt: "2025-01-01 00:00:00" },
    ]);
    expect(body.queueCategoryCounts).toBeUndefined();
    expect(body.latestRunStatuses).toBeUndefined();
  });

  it("GET /status?topology=1 includes topology fields", async () => {
    const res = await request(server, "GET", "/status?topology=1");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.queueCategoryCounts).toBeDefined();
    expect(typeof body.queueCategoryCounts).toBe("object");
    expect(body.latestRunStatuses).toBeDefined();
    expect(typeof body.latestRunStatuses).toBe("object");
  });

  it("GET / returns 200 with HTML and includes Config link", async () => {
    const res = await request(server, "GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain("claws");
    expect(res.body).toContain("issue-worker");
    expect(res.body).toContain("ci-fixer");
    expect(res.body).toContain('href="/logs"');
    expect(res.body).toContain('href="/config"');
    expect(res.body).toContain("Integrations");
    expect(res.body).toContain("Connected");
    expect(res.body).not.toContain('http-equiv="refresh"');
    expect(res.body).toContain("fetch('/status')");
  });

  it("GET /topology returns 200 with SVG topology diagram", async () => {
    const res = await request(server, "GET", "/topology");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain("Pipeline Topology");
    expect(res.body).toContain("<svg");
    expect(res.body).toContain('href="/topology"');
    expect(res.body).toContain("issue-dispatcher");
    expect(res.body).toContain("Planner");
    expect(res.body).toContain("Implementer");
    expect(res.body).toContain("CI Fixer");
    expect(res.body).toContain("Reviewer");
    expect(res.body).toContain("Merger");
    expect(res.body).toContain("30000"); // 30s auto-refresh
  });

  it("POST /health returns 405", async () => {
    const res = await request(server, "POST", "/health");
    expect(res.status).toBe(405);
  });

  it("GET /logs returns 200 with HTML", async () => {
    const res = await request(server, "GET", "/logs");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain("Job Runs");
    expect(res.body).toContain("issue-worker");
  });

  it("GET /logs/:runId returns 200 for existing run", async () => {
    const res = await request(server, "GET", "/logs/abc-123");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain("issue-worker");
    expect(res.body).toContain("Starting");
  });

  it("GET /logs/:runId returns 404 for nonexistent run", async () => {
    const res = await request(server, "GET", "/logs/nonexistent");
    expect(res.status).toBe(404);
  });

  it("GET /unknown returns 404", async () => {
    const res = await request(server, "GET", "/nonexistent");
    expect(res.status).toBe(404);
  });

  it("GET /config returns 200 with HTML form (no auth token set)", async () => {
    const res = await request(server, "GET", "/config");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain("Save Configuration");
    expect(res.body).toContain("githubOwners");
    expect(res.body).toContain("Intervals");
    expect(res.body).toContain("Schedules");
  });

  it("GET /config?saved=1 shows success banner", async () => {
    const res = await request(server, "GET", "/config?saved=1");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Configuration saved and applied");
  });

  it("GET /config/api returns JSON with masked values", async () => {
    const res = await request(server, "GET", "/config/api");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(res.body);
    expect(body.slackWebhook).toBe("****cdef");
    expect(body.githubOwners).toEqual(["owner1"]);
  });

  it("POST /config saves values and redirects", async () => {
    const { writeConfig: wc } = await import("./config.js");
    const res = await request(server, "POST", "/config", {
      body: "selfRepo=new%2Frepo&logRetentionDays=30&interval_issueWorkerMs=10&schedule_repoStandardsHour=3&slackWebhook=&authToken=",
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/config?saved=1");
    expect(wc).toHaveBeenCalled();
  });

  it("POST /config/remove-unknown-keys removes keys and redirects to /config?saved=1 when keys exist", async () => {
    const { getUnknownConfigKeys, removeConfigKeys } = await import("./config.js");
    vi.mocked(getUnknownConfigKeys).mockReturnValue(["oldKey", "legacyKey"]);
    vi.mocked(removeConfigKeys).mockClear();
    const res = await request(server, "POST", "/config/remove-unknown-keys");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/config?saved=1");
    expect(removeConfigKeys).toHaveBeenCalledWith(["oldKey", "legacyKey"]);
    vi.mocked(getUnknownConfigKeys).mockReturnValue([]);
  });

  it("POST /config/remove-unknown-keys redirects to /config without ?saved=1 when no unknown keys", async () => {
    const { getUnknownConfigKeys, removeConfigKeys } = await import("./config.js");
    vi.mocked(getUnknownConfigKeys).mockReturnValue([]);
    vi.mocked(removeConfigKeys).mockClear();
    const res = await request(server, "POST", "/config/remove-unknown-keys");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/config");
    expect(removeConfigKeys).not.toHaveBeenCalled();
  });

  it("POST /config assembles tool-use and text-only fallback orders from per-group params", async () => {
    const { writeConfig: wc } = await import("./config.js");
    vi.mocked(wc).mockClear();
    const res = await request(server, "POST", "/config", {
      body: "toolUse_primaryProvider=codex&toolUse_fallback_claude=true&textOnly_primaryProvider=opencode&textOnly_fallback_claude=true",
    });
    expect(res.status).toBe(303);
    expect(wc).toHaveBeenCalledWith(expect.objectContaining({
      toolUseProviderFallbackOrder: ["codex", "claude"],
      textOnlyProviderFallbackOrder: ["opencode", "claude"],
    }));
  });

  it("GET /sessions returns 200 with HTML", async () => {
    const res = await request(server, "GET", "/sessions");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain('method="POST" action="/sessions/create"');
  });

  it("GET /sessions?notice=session-exited returns 200 with HTML (regression test for issue #1281)", async () => {
    const res = await request(server, "GET", "/sessions?notice=session-exited");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.body).toContain('method="POST" action="/sessions/create"');
  });

  it("GET / includes Last Run and Next Run columns", async () => {
    const res = await request(server, "GET", "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain(">Last Run</th>");
    expect(res.body).toContain(">Next Run</th>");
    expect(res.body).toContain('id="job-lastrun-issue-worker"');
    expect(res.body).toContain('id="job-nextrun-issue-worker"');
  });

  it("GET /status includes jobSchedules", async () => {
    const res = await request(server, "GET", "/status");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("jobSchedules");
    expect(body.jobSchedules).toHaveProperty("issue-worker");
    expect(body.jobSchedules["issue-worker"]).toHaveProperty("lastCompletedAt");
    expect(body.jobSchedules["issue-worker"]).toHaveProperty("nextRunIn");
  });

  it("GET / shows running task details and cancel button", async () => {
    const res = await request(server, "GET", "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Current Task");
    expect(res.body).toContain('href="/logs/issue?repo=org%2Frepo&number=42"');
    expect(res.body).toContain("#42");
    // Display text should show just "repo", not "org/repo"
    expect(res.body).not.toContain("org/repo #42");
    expect(res.body).toContain("Working on");
    expect(res.body).toContain("cancel-btn");
  });

  it("POST /trigger/:job works without auth when no token configured", async () => {
    const res = await request(server, "POST", "/trigger/issue-worker");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("started");
  });

  it("POST /trigger/:job returns 404 for unknown job", async () => {
    scheduler.triggerJob = vi.fn().mockReturnValue("unknown");
    const res = await request(server, "POST", "/trigger/nonexistent-job");
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("unknown");
  });

  it("POST /trigger/:job returns 409 when already running", async () => {
    scheduler.triggerJob = vi.fn().mockReturnValue("already-running");
    const res = await request(server, "POST", "/trigger/issue-worker");
    expect(res.status).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("already-running");
  });

  it("POST /trigger/:job returns 409 when draining", async () => {
    scheduler.triggerJob = vi.fn().mockReturnValue("draining");
    const res = await request(server, "POST", "/trigger/issue-worker");
    expect(res.status).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("draining");
  });

  it("POST /cancel returns 200 with cancelled result", async () => {
    const res = await request(server, "POST", "/cancel");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("cancelled");
  });

  it("POST /pause/:job returns 200 with paused result for known unpaused job", async () => {
    const res = await request(server, "POST", "/pause/ci-fixer");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("paused");
  });

  it("POST /pause/:job returns 200 with resumed result for known paused job", async () => {
    // First pause the job
    await request(server, "POST", "/pause/ci-fixer");
    // Then toggle again to resume
    const res = await request(server, "POST", "/pause/ci-fixer");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("resumed");
  });

  it("POST /pause/:job returns 404 for unknown job", async () => {
    const res = await request(server, "POST", "/pause/nonexistent-job");
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("unknown");
  });

  it("POST /pause/:job calls writeConfig with updated paused jobs list", async () => {
    const { writeConfig: wc } = await import("./config.js");
    await request(server, "POST", "/pause/ci-fixer");
    expect(wc).toHaveBeenCalledWith({ pausedJobs: expect.arrayContaining(["ci-fixer"]) });
  });

  it("GET /status includes pausedJobs array", async () => {
    const res = await request(server, "GET", "/status");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("pausedJobs");
    expect(Array.isArray(body.pausedJobs)).toBe(true);
  });

  it("GET / renders Pause buttons for each job", async () => {
    const res = await request(server, "GET", "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("togglePause(");
    expect(res.body).toContain('id="pause-issue-worker"');
    expect(res.body).toContain('id="pause-ci-fixer"');
  });

  it("GET / includes log links in jobs table", async () => {
    const res = await request(server, "GET", "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain('href="/logs/abc-123"');
    expect(res.body).toContain(">View</a>");
    expect(res.body).toContain(">Logs</th>");
  });

  it("GET /logs/:runId/tail returns JSON with logs", async () => {
    const res = await request(server, "GET", "/logs/abc-123/tail?after=0");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(res.body);
    expect(body.status).toBe("completed");
    expect(body.logs).toBeInstanceOf(Array);
    expect(body.logs[0].message).toBe("Starting");
  });

  it("GET /logs/:runId/tail returns empty logs when after is current", async () => {
    const res = await request(server, "GET", "/logs/abc-123/tail?after=1");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.logs).toHaveLength(0);
  });

  it("GET /logs/:runId/tail returns 404 for nonexistent run", async () => {
    const res = await request(server, "GET", "/logs/nonexistent/tail?after=0");
    expect(res.status).toBe(404);
  });

  it("GET /logs renders search input", async () => {
    const res = await request(server, "GET", "/logs");
    expect(res.status).toBe(200);
    expect(res.body).toContain('name="search"');
    expect(res.body).toContain("Search");
  });

  it("GET /logs renders Items column header", async () => {
    const res = await request(server, "GET", "/logs");
    expect(res.status).toBe(200);
    expect(res.body).toContain(">Items</th>");
  });

  it("GET /logs?search= calls searchRunsByItem", async () => {
    const { searchRunsByItem: searchFn } = await import("./db.js");
    (searchFn as ReturnType<typeof vi.fn>).mockReturnValue([
      { run_id: "found-1", job_name: "issue-worker", status: "completed", started_at: "2025-01-01", completed_at: "2025-01-01" },
    ]);
    const res = await request(server, "GET", "/logs?search=42");
    expect(res.status).toBe(200);
    expect(searchFn).toHaveBeenCalledWith("42");
  });

  it("GET /logs/:runId shows level filter bar", async () => {
    const res = await request(server, "GET", "/logs/abc-123");
    expect(res.status).toBe(200);
    expect(res.body).toContain('id="level-filter"');
    expect(res.body).toContain('data-level="debug"');
    expect(res.body).toContain('data-level="info"');
    expect(res.body).toContain('data-level="warn"');
    expect(res.body).toContain('data-level="error"');
  });
});

describe("Theme support", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET / defaults to system theme (no data-theme on html tag)", async () => {
    const res = await request(server, "GET", "/");
    expect(res.status).toBe(200);
    // System mode: <html lang="en"> with no data-theme attribute
    expect(res.body).toMatch(/<html lang="en">\s*\n<head>/);
  });

  it("GET / with claws_theme=dark cookie sets data-theme=dark on html tag", async () => {
    const res = await request(server, "GET", "/", {
      headers: { Cookie: "claws_theme=dark" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('<html lang="en" data-theme="dark">');
  });

  it("GET / with claws_theme=light cookie sets data-theme=light on html tag", async () => {
    const res = await request(server, "GET", "/", {
      headers: { Cookie: "claws_theme=light" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('<html lang="en" data-theme="light">');
  });

  it("GET / with claws_theme=system cookie omits data-theme on html tag", async () => {
    const res = await request(server, "GET", "/", {
      headers: { Cookie: "claws_theme=system" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/<html lang="en">\s*\n<head>/);
  });

  it("GET / with invalid claws_theme cookie defaults to system", async () => {
    const res = await request(server, "GET", "/", {
      headers: { Cookie: "claws_theme=invalid" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/<html lang="en">\s*\n<head>/);
  });

  it("theme select has correct option pre-selected for dark", async () => {
    const res = await request(server, "GET", "/", {
      headers: { Cookie: "claws_theme=dark" },
    });
    expect(res.body).toContain('<option value="dark" selected>');
    expect(res.body).not.toContain('<option value="light" selected>');
    expect(res.body).not.toContain('<option value="system" selected>');
  });

  it("theme select has system pre-selected by default", async () => {
    const res = await request(server, "GET", "/");
    expect(res.body).toContain('<option value="system" selected>');
    expect(res.body).not.toContain('<option value="dark" selected>');
    expect(res.body).not.toContain('<option value="light" selected>');
  });

  it("all pages include theme toggle and setTheme script", async () => {
    for (const path of ["/", "/logs", "/config", "/queue", "/topology"]) {
      const res = await request(server, "GET", path);
      expect(res.status).toBe(200);
      expect(res.body).toContain("theme-select");
      expect(res.body).toContain("setTheme");
    }
  });

  it("CSS includes theme variable definitions", async () => {
    const res = await request(server, "GET", "/");
    expect(res.body).toContain(":root {");
    expect(res.body).toContain("--bg:");
    expect(res.body).toContain("--accent:");
    expect(res.body).toContain("prefers-color-scheme: light");
    expect(res.body).toContain('[data-theme="light"]');
    expect(res.body).toContain("var(--bg)");
  });

  it("buildLogsListPage renders theme attribute correctly", () => {
    const runs = [
      { run_id: "r1", job_name: "test-job", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" },
    ];
    const html = buildLogsListPage(runs, ["test-job"], null, "light" as Theme);
    expect(html).toContain('data-theme="light"');
    expect(html).toContain('<option value="light" selected>');
  });

  it("buildLogsListPage renders work item badges", () => {
    const runs = [
      { run_id: "r1", job_name: "test-job", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" },
    ];
    const workItems = new Map([
      ["r1", [
        { id: 1, job_name: "test-job", repo: "org/my-repo", item_number: 42, trigger_label: null, worktree_path: null, branch_name: null, run_id: "r1", status: "completed", error: null, started_at: "2025-01-01", completed_at: "2025-01-01" },
      ]],
    ]);
    const html = buildLogsListPage(runs, ["test-job"], null, "system" as Theme, workItems as any);
    expect(html).toContain("my-repo#42");
    expect(html).toContain('class="work-item-badge');
    expect(html).toContain("/logs/issue?repo=org%2Fmy-repo&number=42");
  });

  it("buildLogsListPage renders search input with value", () => {
    const html = buildLogsListPage([], [], null, "system" as Theme, new Map(), "test-query");
    expect(html).toContain('value="test-query"');
    expect(html).toContain('name="search"');
  });

  it("buildLogsListPage renders dash for runs with no work items", () => {
    const runs = [
      { run_id: "r1", job_name: "auto-merger", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" },
    ];
    const html = buildLogsListPage(runs, ["auto-merger"], null, "system" as Theme, new Map());
    // The Items column should show a dash for runs without tasks
    expect(html).toContain(">Items</th>");
    // The row should contain a dash for empty items
    expect(html).toMatch(/<td>\u2014<\/td>/);
  });

  it("buildLogDetailPage renders theme attribute correctly", () => {
    const run = { run_id: "r1", job_name: "test-job", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" };
    const logs = [{ id: 1, run_id: "r1", level: "info", message: "test", logged_at: "2025-01-01 00:00:00" }];
    const html = buildLogDetailPage(run, logs, "dark" as Theme);
    expect(html).toContain('data-theme="dark"');
  });

  it("buildLogDetailPage renders work items section when tasks provided", () => {
    const run = { run_id: "r1", job_name: "test-job", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" };
    const logs = [{ id: 1, run_id: "r1", level: "info", message: "test", logged_at: "2025-01-01 00:00:00" }];
    const tasks = [
      { id: 1, job_name: "test-job", repo: "org/repo", item_number: 99, trigger_label: null, worktree_path: null, branch_name: null, run_id: "r1", status: "completed", error: null, started_at: "2025-01-01", completed_at: "2025-01-01" },
    ];
    const html = buildLogDetailPage(run, logs, "system" as Theme, tasks as any);
    expect(html).toContain("Work Items");
    expect(html).toContain("repo#99");
    expect(html).toContain("(completed)");
    expect(html).toContain("/logs/issue?repo=org%2Frepo&number=99");
  });

  it("buildLogDetailPage omits work items section when no tasks", () => {
    const run = { run_id: "r1", job_name: "test-job", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" };
    const logs = [{ id: 1, run_id: "r1", level: "info", message: "test", logged_at: "2025-01-01 00:00:00" }];
    const html = buildLogDetailPage(run, logs, "system" as Theme, []);
    expect(html).not.toContain("Work Items");
  });

  it("buildQueuePage renders system theme correctly", () => {
    const empty = { items: [], oldestFetchAt: null };
    const html = buildQueuePage(empty, empty, "system" as Theme);
    expect(html).toMatch(/<html lang="en">\s*\n<head>/);
  });

  it("buildQueuePage renders green check for passing PRs", () => {
    const myAttention = {
      items: [
        { repo: "org/repo", number: 10, title: "Fix bug", category: "ready" as const, updatedAt: "2025-01-01T00:00:00Z", type: "issue" as const, checkStatus: "passing" as const, prNumber: 50 },
      ],
      oldestFetchAt: Date.now(),
    };
    const empty = { items: [], oldestFetchAt: Date.now() };
    const html = buildQueuePage(myAttention, empty, "system" as Theme);
    expect(html).toContain("check-pass");
    expect(html).toContain("&#x2714;");
    expect(html).toContain("Squash &amp; Merge");
    expect(html).toContain("mergePR(");
    expect(html).toContain("/logs/issue?repo=org%2Frepo&number=50");
  });

  it("buildQueuePage renders red indicator for failing PRs", () => {
    const myAttention = {
      items: [
        { repo: "org/repo", number: 10, title: "Fix bug", category: "ready" as const, updatedAt: "2025-01-01T00:00:00Z", type: "issue" as const, checkStatus: "failing" as const, prNumber: 50 },
      ],
      oldestFetchAt: Date.now(),
    };
    const empty = { items: [], oldestFetchAt: Date.now() };
    const html = buildQueuePage(myAttention, empty, "system" as Theme);
    expect(html).toContain("check-fail");
    expect(html).toContain("&#x2718;");
    expect(html).toContain("Squash &amp; Merge");
  });

  it("buildQueuePage shows N/N count when checksPassed/checksTotal present", () => {
    const myAttention = {
      items: [
        { repo: "org/repo", number: 10, title: "Fix bug", category: "ready" as const, updatedAt: "2025-01-01T00:00:00Z", type: "pr" as const, checkStatus: "passing" as const, prNumber: 10, checksPassed: 5, checksTotal: 5 },
      ],
      oldestFetchAt: Date.now(),
    };
    const empty = { items: [], oldestFetchAt: Date.now() };
    const html = buildQueuePage(myAttention, empty, "system" as Theme);
    expect(html).toContain("5/5");
    expect(html).toContain("check-count");
  });

  it("buildQueuePage shows type badge for PR items", () => {
    const myAttention = {
      items: [
        { repo: "org/repo", number: 10, title: "Fix bug", category: "ready" as const, updatedAt: "2025-01-01T00:00:00Z", type: "pr" as const },
      ],
      oldestFetchAt: Date.now(),
    };
    const empty = { items: [], oldestFetchAt: Date.now() };
    const html = buildQueuePage(myAttention, empty, "system" as Theme);
    expect(html).toContain(">PR<");
    expect(html).toContain("type-badge");
  });

  it("buildQueuePage shows type badge for Issue items without PR", () => {
    const myAttention = {
      items: [
        { repo: "org/repo", number: 10, title: "Fix bug", category: "needs-refinement" as const, updatedAt: "2025-01-01T00:00:00Z", type: "issue" as const },
      ],
      oldestFetchAt: Date.now(),
    };
    const empty = { items: [], oldestFetchAt: Date.now() };
    const html = buildQueuePage(myAttention, empty, "system" as Theme);
    expect(html).toContain(">Issue<");
    expect(html).toContain("type-badge");
  });

  it("buildQueuePage shows PR badge for issue items with linked PR", () => {
    const myAttention = {
      items: [
        { repo: "org/repo", number: 10, title: "Fix bug", category: "needs-refinement" as const, updatedAt: "2025-01-01T00:00:00Z", type: "issue" as const, prNumber: 50 },
      ],
      oldestFetchAt: Date.now(),
    };
    const empty = { items: [], oldestFetchAt: Date.now() };
    const html = buildQueuePage(myAttention, empty, "system" as Theme);
    expect(html).toContain(">PR<");
    expect(html).toContain("type-badge");
    expect(html).not.toContain(">Issue<");
  });

  it("buildQueuePage shows clean review status", () => {
    const myAttention = {
      items: [
        { repo: "org/repo", number: 10, title: "Fix bug", category: "ready" as const, updatedAt: "2025-01-01T00:00:00Z", type: "pr" as const, prNumber: 10, reviewStatus: "clean" as const },
      ],
      oldestFetchAt: Date.now(),
    };
    const empty = { items: [], oldestFetchAt: Date.now() };
    const html = buildQueuePage(myAttention, empty, "system" as Theme);
    expect(html).toContain("Reviewed — clean");
    expect(html).toContain("review-clean");
  });

  it("buildQueuePage shows N issues found review status", () => {
    const myAttention = {
      items: [
        { repo: "org/repo", number: 10, title: "Fix bug", category: "ready" as const, updatedAt: "2025-01-01T00:00:00Z", type: "pr" as const, prNumber: 10, reviewStatus: "issues" as const, reviewIssueCount: 3 },
      ],
      oldestFetchAt: Date.now(),
    };
    const empty = { items: [], oldestFetchAt: Date.now() };
    const html = buildQueuePage(myAttention, empty, "system" as Theme);
    expect(html).toContain("3 issues found");
    expect(html).toContain("review-issues");
  });

  it("buildQueuePage shows Needs Review Addressing group before Needs Refinement", () => {
    const clawsAttention = {
      items: [
        { repo: "org/repo", number: 1, title: "Refine item", category: "needs-refinement" as const, updatedAt: "2025-01-01T00:00:00Z", type: "issue" as const },
        { repo: "org/repo", number: 2, title: "Review item", category: "needs-review-addressing" as const, updatedAt: "2025-01-01T00:00:00Z", type: "issue" as const, checkStatus: "passing" as const, prNumber: 99 },
      ],
      oldestFetchAt: Date.now(),
    };
    const empty = { items: [], oldestFetchAt: Date.now() };
    const html = buildQueuePage(empty, clawsAttention, "system" as Theme);
    const reviewPos = html.indexOf("Needs Review Addressing");
    const refinementPos = html.indexOf("Needs Refinement");
    expect(reviewPos).toBeLessThan(refinementPos);
  });
});

describe("POST /queue/refresh", () => {
  it("calls triggerJob for issue-dispatcher and pr-dispatcher and returns 200 with results", async () => {
    const sched = mockScheduler();
    const triggerSpy = vi.fn().mockReturnValue("started");
    sched.triggerJob = triggerSpy;
    const s = createServer(sched);
    await new Promise<void>((resolve) => {
      if (s.listening) resolve();
      else s.on("listening", resolve);
    });
    try {
      const res = await request(s, "POST", "/queue/refresh");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results).toMatchObject({
        "issue-dispatcher": "started",
        "pr-dispatcher": "started",
      });
      expect(triggerSpy).toHaveBeenCalledWith("issue-dispatcher");
      expect(triggerSpy).toHaveBeenCalledWith("pr-dispatcher");
    } finally {
      await new Promise<void>((resolve, reject) => {
        s.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("returns 200 even when triggerJob returns already-running", async () => {
    const sched = mockScheduler();
    sched.triggerJob = vi.fn().mockReturnValue("already-running");
    const s = createServer(sched);
    await new Promise<void>((resolve) => {
      if (s.listening) resolve();
      else s.on("listening", resolve);
    });
    try {
      const res = await request(s, "POST", "/queue/refresh");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results["issue-dispatcher"]).toBe("already-running");
      expect(body.results["pr-dispatcher"]).toBe("already-running");
    } finally {
      await new Promise<void>((resolve, reject) => {
        s.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("POST /queue/merge", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 200 with merged result", async () => {
    const res = await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42 }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("merged");
  });

  it("returns 500 when mergePR fails", async () => {
    const { mergePR: mergeFn } = await import("./github.js");
    (mergeFn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("merge conflict"));
    const res = await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42 }),
    });
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("merge conflict");
  });
});

describe("POST /queue/skip", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 200 and calls writeConfig", async () => {
    const res = await request(server, "POST", "/queue/skip", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 42 }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("ok");
  });
});

describe("POST /queue/unskip", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 200 and calls writeConfig", async () => {
    const res = await request(server, "POST", "/queue/unskip", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 42 }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("ok");
  });
});

describe("POST /queue/prioritize", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 200 and calls writeConfig", async () => {
    const res = await request(server, "POST", "/queue/prioritize", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 7 }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("ok");
  });
});

describe("POST /queue/deprioritize", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 200 and calls writeConfig", async () => {
    const res = await request(server, "POST", "/queue/deprioritize", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 7 }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("ok");
  });
});

describe("Queue page UI features", () => {
  it("buildQueuePage renders skip and prioritize buttons for claws attention items", () => {
    const clawsAttention = {
      items: [
        { repo: "org/repo", number: 1, title: "Test item", category: "refined" as const, updatedAt: "2025-01-01T00:00:00Z", type: "issue" as const },
      ],
      oldestFetchAt: Date.now(),
    };
    const empty = { items: [], oldestFetchAt: Date.now() };
    const html = buildQueuePage(empty, clawsAttention, "system" as Theme);
    expect(html).toContain("Prioritise");
    expect(html).toContain("Skip");
    expect(html).toContain("skipItem");
    expect(html).toContain("togglePriority");
  });

  it("buildQueuePage does not render skip/prioritize buttons for my attention items", () => {
    const myAttention = {
      items: [
        { repo: "org/repo", number: 1, title: "Test item", category: "ready" as const, updatedAt: "2025-01-01T00:00:00Z", type: "issue" as const, checkStatus: "passing" as const, prNumber: 10 },
      ],
      oldestFetchAt: Date.now(),
    };
    const empty = { items: [], oldestFetchAt: Date.now() };
    const html = buildQueuePage(myAttention, empty, "system" as Theme);
    // The script block defines the functions, but the "Needs My Attention" section
    // should not contain skip/prioritize button onclick attributes
    const mySection = html.split("Needs Claws Attention")[0];
    expect(mySection).not.toContain('onclick="skipItem');
    expect(mySection).not.toContain('onclick="prioritizeItem');
  });

  it("buildQueuePage renders skipped items section", () => {
    const empty = { items: [], oldestFetchAt: Date.now() };
    const skipped = [{ repo: "org/repo", number: 5 }];
    const html = buildQueuePage(empty, empty, "system" as Theme, skipped);
    expect(html).toContain("Skipped Items");
    expect(html).toContain("Restore");
    expect(html).toContain("unskipItem");
  });

  it("buildQueuePage shows priority star for prioritized items", () => {
    const clawsAttention = {
      items: [
        { repo: "org/repo", number: 1, title: "Priority item", category: "refined" as const, updatedAt: "2025-01-01T00:00:00Z", type: "issue" as const, prioritized: true },
      ],
      oldestFetchAt: Date.now(),
    };
    const empty = { items: [], oldestFetchAt: Date.now() };
    const html = buildQueuePage(empty, clawsAttention, "system" as Theme);
    expect(html).toContain("priority-star");
    expect(html).toContain("Deprioritise");
  });
});

describe("Issue logs page", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET /logs/issue returns 400 when repo is missing", async () => {
    const res = await request(server, "GET", "/logs/issue?number=1");
    expect(res.status).toBe(400);
  });

  it("GET /logs/issue returns 400 when number is missing", async () => {
    const res = await request(server, "GET", "/logs/issue?repo=org/repo");
    expect(res.status).toBe(400);
  });

  it("GET /logs/issue returns 400 when number is invalid", async () => {
    const res = await request(server, "GET", "/logs/issue?repo=org/repo&number=abc");
    expect(res.status).toBe(400);
  });

  it("GET /logs/issue returns 200 with empty state when no runs", async () => {
    const { listRepos: listReposFn } = await import("./github.js");
    (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { owner: "org", name: "repo", fullName: "org/repo" },
    ]);
    const res = await request(server, "GET", "/logs/issue?repo=org/repo&number=42");
    expect(res.status).toBe(200);
    expect(res.body).toContain("No logs found for this issue");
    expect(res.body).toContain("repo#42");
  });

  it("GET /logs/issue returns 404 for an unknown repo", async () => {
    const { listRepos: listReposFn } = await import("./github.js");
    (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { owner: "org", name: "repo", fullName: "org/repo" },
    ]);
    const res = await request(server, "GET", "/logs/issue?repo=unknown/repo&number=42");
    expect(res.status).toBe(404);
  });

  it("GET /logs/issue renders runs when present", async () => {
    const { listRepos: listReposFn } = await import("./github.js");
    (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { owner: "org", name: "repo", fullName: "org/repo" },
    ]);
    const { getRunsForIssue: fn, getLogsForRuns: logsFn, getWorkItemsForRuns: workFn } = await import("./db.js");
    (fn as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      { run_id: "run-1", job_name: "issue-worker", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" },
      { run_id: "run-2", job_name: "ci-fixer", status: "failed", started_at: "2025-01-01 00:02:00", completed_at: "2025-01-01 00:03:00" },
    ]);
    (logsFn as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Map([
      ["run-1", [{ id: 1, run_id: "run-1", level: "info", message: "Working on issue", logged_at: "2025-01-01 00:00:01" }]],
    ]));
    (workFn as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Map());

    const res = await request(server, "GET", "/logs/issue?repo=org/repo&number=42");
    expect(res.status).toBe(200);
    expect(res.body).toContain("repo#42");
    expect(res.body).toContain("2 runs");
    expect(res.body).toContain("issue-worker");
    expect(res.body).toContain("ci-fixer");
    expect(res.body).toContain("Working on issue");
    expect(res.body).toContain("View on GitHub");
    expect(res.body).toContain('data-level="all"');
  });

  it("buildIssueLogsPage renders correctly with multiple runs", () => {
    const runs = [
      { run_id: "r1", job_name: "issue-worker", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" },
      { run_id: "r2", job_name: "ci-fixer", status: "failed", started_at: "2025-01-01 00:02:00", completed_at: "2025-01-01 00:03:00" },
    ];
    const logsByRun = new Map([
      ["r1", [{ id: 1, run_id: "r1", level: "info", message: "Hello", logged_at: "2025-01-01 00:00:01" }]],
      ["r2", [{ id: 2, run_id: "r2", level: "error", message: "Failed", logged_at: "2025-01-01 00:02:01" }]],
    ]);
    const html = buildIssueLogsPage("org/repo", 42, runs, logsByRun, new Map(), "system" as Theme);
    // First run is expanded
    expect(html).toContain("<details open>");
    // Both runs present
    expect(html).toContain("issue-worker");
    expect(html).toContain("ci-fixer");
    expect(html).toContain("Hello");
    expect(html).toContain("Failed");
    expect(html).toContain("repo#42");
    expect(html).toContain("github.com/org/repo/issues/42");
  });

  it("buildIssueLogsPage renders empty state when no runs", () => {
    const html = buildIssueLogsPage("org/repo", 42, [], new Map(), new Map(), "system" as Theme);
    expect(html).toContain("No logs found for this issue");
    expect(html).toContain("/logs");
  });

  it("buildIssueLogsPage shows live indicator for running runs", () => {
    const runs = [
      { run_id: "r1", job_name: "issue-worker", status: "running", started_at: "2025-01-01 00:00:00", completed_at: null },
    ];
    const html = buildIssueLogsPage("org/repo", 10, runs, new Map(), new Map(), "system" as Theme);
    expect(html).toContain("live — click to view");
    expect(html).toContain("/logs/r1");
  });

  it("badge links in buildLogsListPage point to /logs/issue", () => {
    const runs = [
      { run_id: "r1", job_name: "test-job", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" },
    ];
    const workItems = new Map([
      ["r1", [
        { id: 1, job_name: "test-job", repo: "org/my-repo", item_number: 42, trigger_label: null, worktree_path: null, branch_name: null, run_id: "r1", status: "completed", error: null, started_at: "2025-01-01", completed_at: "2025-01-01" },
      ]],
    ]);
    const html = buildLogsListPage(runs, ["test-job"], null, "system" as Theme, workItems as any);
    expect(html).toContain("/logs/issue?repo=org%2Fmy-repo&number=42");
    expect(html).not.toContain("github.com/org/my-repo/issues/42");
  });

  it("badge links in buildLogDetailPage point to /logs/issue", () => {
    const run = { run_id: "r1", job_name: "test-job", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" };
    const logs = [{ id: 1, run_id: "r1", level: "info", message: "test", logged_at: "2025-01-01 00:00:00" }];
    const tasks = [
      { id: 1, job_name: "test-job", repo: "org/repo", item_number: 99, trigger_label: null, worktree_path: null, branch_name: null, run_id: "r1", status: "completed", error: null, started_at: "2025-01-01", completed_at: "2025-01-01" },
    ];
    const html = buildLogDetailPage(run, logs, "system" as Theme, tasks as any);
    expect(html).toContain("/logs/issue?repo=org%2Frepo&number=99");
    expect(html).not.toContain("github.com/org/repo/issues/99");
  });
});

describe("Dashboard action Slack notifications", () => {
  let server: http.Server;
  let notifyFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).NOTIFY_DASHBOARD_ACTIONS = true;
    const slackMod = await import("./slack.js");
    notifyFn = slackMod.notify as ReturnType<typeof vi.fn>;
    notifyFn.mockClear();
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("sends notification on pause", async () => {
    await request(server, "POST", "/pause/ci-fixer");
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining('[dashboard] Job "ci-fixer" paused'));
  });

  it("sends notification on resume", async () => {
    await request(server, "POST", "/pause/ci-fixer");
    notifyFn.mockClear();
    await request(server, "POST", "/pause/ci-fixer");
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining('[dashboard] Job "ci-fixer" resumed'));
  });

  it("does not send notification for unknown job (404)", async () => {
    await request(server, "POST", "/pause/nonexistent-job");
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("sends notification on cancel", async () => {
    await request(server, "POST", "/cancel");
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("[dashboard] Task cancelled"));
  });

  it("does not send notification when no active task to cancel", async () => {
    const { cancelCurrentTask: cancelFn } = await import("./claude.js");
    (cancelFn as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    await request(server, "POST", "/cancel");
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("sends notification on queue merge", async () => {
    await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42 }),
    });
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("[dashboard] PR org/repo#42 merged"));
  });

  it("does not send notification when merge fails", async () => {
    const { mergePR: mergeFn } = await import("./github.js");
    (mergeFn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("merge conflict"));
    await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42 }),
    });
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("sends notification on queue skip", async () => {
    await request(server, "POST", "/queue/skip", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 7 }),
    });
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("[dashboard] org/repo#7 skipped"));
  });

  it("sends notification on queue unskip", async () => {
    await request(server, "POST", "/queue/unskip", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 7 }),
    });
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("[dashboard] org/repo#7 unskipped"));
  });

  it("sends notification on queue prioritize", async () => {
    await request(server, "POST", "/queue/prioritize", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 7 }),
    });
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("[dashboard] org/repo#7 prioritized"));
  });

  it("sends notification on queue deprioritize", async () => {
    await request(server, "POST", "/queue/deprioritize", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 7 }),
    });
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("[dashboard] org/repo#7 deprioritized"));
  });

  it("sends notification on WhatsApp pair success", async () => {
    const res = await request(server, "GET", "/whatsapp/pair");
    expect(res.status).toBe(200);
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("[dashboard] WhatsApp paired"));
  });

  it("sends notification on WhatsApp unpair", async () => {
    await request(server, "POST", "/whatsapp/unpair");
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("[dashboard] WhatsApp unpaired"));
  });

  it("sends notification on config save with changed fields", async () => {
    await request(server, "POST", "/config", {
      body: "logRetentionDays=7&logRetentionPerJob=20&githubOwners=owner1&selfRepo=owner1%2Frepo1&authToken=&notifyDashboardActions=true&enabledAgent_planner=true&enabledAgent_implementer=true&enabledAgent_ci-fixer=true&enabledAgent_review-addresser=true&enabledAgent_reviewer=true&enabledAgent_merger=true",
    });
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("[dashboard] Config updated:"));
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("logRetentionDays"));
    // Unchanged fields should not appear in the notification
    expect(notifyFn).not.toHaveBeenCalledWith(expect.stringContaining("selfRepo"));
  });

  it("does not send notification when NOTIFY_DASHBOARD_ACTIONS is false", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).NOTIFY_DASHBOARD_ACTIONS = false;
    await request(server, "POST", "/pause/ci-fixer");
    expect(notifyFn).not.toHaveBeenCalled();
    await request(server, "POST", "/cancel");
    expect(notifyFn).not.toHaveBeenCalled();
    await request(server, "POST", "/queue/skip", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 7 }),
    });
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("includes client IP from X-Forwarded-For header", async () => {
    await request(server, "POST", "/pause/ci-fixer", {
      headers: { "x-forwarded-for": "192.168.1.100" },
    });
    expect(notifyFn).toHaveBeenCalledWith(expect.stringContaining("from 192.168.1.100"));
  });

  it("GET /repos sorts repos by most recent activity first, inactive repos last (alphabetical)", async () => {
    const { listRepos: listReposFn } = await import("./github.js");
    const { getLastTaskTimePerRepo: activityFn } = await import("./db.js");
    (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { owner: "org", name: "repo-b", fullName: "org/repo-b" },
      { owner: "org", name: "repo-a", fullName: "org/repo-a" },
      { owner: "org", name: "repo-c", fullName: "org/repo-c" },
    ]);
    (activityFn as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Map([
      ["org/repo-a", "2026-01-01 10:00:00"],
      ["org/repo-c", "2026-01-03 08:00:00"],
      // repo-b has no recorded activity
    ]));
    const res = await request(server, "GET", "/repos");
    expect(res.status).toBe(200);
    // repo-c is most recent, then repo-a, then repo-b (no activity)
    const cIdx = res.body.indexOf("org/repo-c");
    const aIdx = res.body.indexOf("org/repo-a");
    const bIdx = res.body.indexOf("org/repo-b");
    expect(cIdx).toBeLessThan(aIdx);
    expect(aIdx).toBeLessThan(bIdx);
  });

  describe("Mark Refined Endpoint", () => {
    it("POST /queue/mark-refined marks an issue as refined", async () => {
      const { addLabel, removeQueueItem } = await import("./github.js");
      const res = await request(
        server,
        "POST",
        "/queue/mark-refined",
        { body: JSON.stringify({ repo: "test/repo", number: 123 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('"result":"ok"');
      expect(addLabel).toHaveBeenCalledWith("test/repo", 123, "Refined");
      expect(removeQueueItem).toHaveBeenCalledWith("test/repo", 123);
    });

    it("POST /queue/mark-refined validates required fields", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/mark-refined",
        { body: JSON.stringify({ repo: "test/repo" }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(500);
      expect(res.body).toContain("Missing repo or number");
    });

    it("POST /queue/mark-refined handles invalid JSON", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/mark-refined",
        { body: "invalid json", headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(500);
      expect(res.body).toContain("error");
    });
  });

  describe("Problematic PR Endpoints", () => {
    it("POST /queue/mark-problematic marks a PR as problematic", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/mark-problematic",
        { body: JSON.stringify({ repo: "test/repo", number: 123 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('"result":"ok"');
    });

    it("POST /queue/mark-problematic validates required fields", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/mark-problematic",
        { body: JSON.stringify({ repo: "test/repo" }), headers: { "content-type": "application/json" } }, // Missing number
      );
      expect(res.status).toBe(500);
      expect(res.body).toContain("Missing repo or number");
    });

    it("POST /queue/mark-problematic handles invalid JSON", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/mark-problematic",
        { body: "invalid json", headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(500);
      expect(res.body).toContain("error");
    });

    it("POST /queue/unmark-problematic unmarks a PR", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/unmark-problematic",
        { body: JSON.stringify({ repo: "test/repo", number: 456 }), headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('"result":"ok"');
    });

    it("POST /queue/unmark-problematic validates required fields", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/unmark-problematic",
        { body: JSON.stringify({ repo: "test/repo" }), headers: { "content-type": "application/json" } }, // Missing number
      );
      expect(res.status).toBe(500);
      expect(res.body).toContain("Missing repo or number");
    });

    it("POST /queue/unmark-problematic handles invalid JSON", async () => {
      const res = await request(
        server,
        "POST",
        "/queue/unmark-problematic",
        { body: "invalid json", headers: { "content-type": "application/json" } },
      );
      expect(res.status).toBe(500);
      expect(res.body).toContain("error");
    });
  });
});

describe("/runners/cancel endpoint", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("POST /runners/cancel returns 200 and calls cancelWorkflow for valid configured repo", async () => {
    const { listRepos: listReposFn, cancelWorkflow: cancelFn } = await import("./github.js");
    (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { owner: "org", name: "repo", fullName: "org/repo" },
    ]);
    (cancelFn as ReturnType<typeof vi.fn>).mockClear();
    
    const res = await request(server, "POST", "/runners/cancel", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", runId: "12345" }),
    });
    
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("cancelled");
    expect(cancelFn).toHaveBeenCalledWith("org/repo", "12345");
  });

  it("POST /runners/cancel returns 403 when repo is not configured", async () => {
    const { listRepos: listReposFn, cancelWorkflow: cancelFn } = await import("./github.js");
    (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { owner: "org", name: "allowed", fullName: "org/allowed" },
    ]);
    (cancelFn as ReturnType<typeof vi.fn>).mockClear();
    
    const res = await request(server, "POST", "/runners/cancel", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/unauthorized", runId: "12345" }),
    });
    
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("Repository not configured");
    expect(cancelFn).not.toHaveBeenCalled();
  });

  it("POST /runners/cancel returns 500 when repo is missing", async () => {
    const res = await request(server, "POST", "/runners/cancel", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "12345" }),
    });
    
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("Missing repo or runId");
  });

  it("POST /runners/cancel returns 500 when runId is missing", async () => {
    const res = await request(server, "POST", "/runners/cancel", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo" }),
    });
    
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("Missing repo or runId");
  });

  it("POST /runners/cancel returns 400 when workflow already completed", async () => {
    const { listRepos: listReposFn, cancelWorkflow: cancelFn } = await import("./github.js");
    (listReposFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { owner: "org", name: "repo", fullName: "org/repo" },
    ]);
    (cancelFn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gh run cancel 12345 --repo org/repo failed: Cannot cancel a workflow run that is completed"));
    
    const res = await request(server, "POST", "/runners/cancel", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", runId: "12345" }),
    });
    
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Workflow run has already completed");
  });
});

describe("HTTP server with OIDC auth", () => {
  let server: http.Server;
  const OIDC_SECRET = "test-oidc-client-secret";

  // Mirrors the signSession function in server.ts
  function signSession(sub: string, expiresAt: number, secret: string): string {
    const payload = `${sub}|${expiresAt}`;
    const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    return `${payload}|${hmac}`;
  }

  beforeEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).OIDC_CLIENT_ID = "test-client-id";
    (configMod as Record<string, unknown>).OIDC_CLIENT_SECRET = OIDC_SECRET;
    (configMod as Record<string, unknown>).OIDC_BASE_URL = "https://auth.example.com";
    (configMod as Record<string, unknown>).OIDC_APPLICATION_SLUG = "claws";
    // This suite supplies its own credentials; opt out of the global session injection.
    testSessionCookie = null;
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).OIDC_CLIENT_ID = "";
    (configMod as Record<string, unknown>).OIDC_CLIENT_SECRET = "";
    (configMod as Record<string, unknown>).OIDC_BASE_URL = "";
    (configMod as Record<string, unknown>).OIDC_APPLICATION_SLUG = "";
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET / returns 200 with a valid claws_session cookie", async () => {
    const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour from now
    const sessionValue = signSession("user|with|pipes", expiresAt, OIDC_SECRET);
    const res = await request(server, "GET", "/", {
      headers: { Cookie: `claws_session=${encodeURIComponent(sessionValue)}` },
    });
    expect(res.status).toBe(200);
  });

  it("GET / returns 401 with a tampered claws_session cookie", async () => {
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const sessionValue = signSession("user123", expiresAt, OIDC_SECRET);
    // Flip the last character of the HMAC to tamper with it
    const tampered = sessionValue.slice(0, -1) + (sessionValue.endsWith("a") ? "b" : "a");
    const res = await request(server, "GET", "/", {
      headers: { Cookie: `claws_session=${encodeURIComponent(tampered)}` },
    });
    expect(res.status).toBe(401);
  });

  it("GET / returns 401 with an expired claws_session cookie", async () => {
    const expiresAt = Date.now() - 1000; // already expired
    const sessionValue = signSession("user123", expiresAt, OIDC_SECRET);
    const res = await request(server, "GET", "/", {
      headers: { Cookie: `claws_session=${encodeURIComponent(sessionValue)}` },
    });
    expect(res.status).toBe(401);
  });

  it("GET / returns 401 with no session cookie in OIDC mode", async () => {
    const res = await request(server, "GET", "/");
    expect(res.status).toBe(401);
  });

  // Regression tests for issue #1326: backslash open-redirect via next= parameter.
  // These tests complete the full OAuth round-trip so the assertion actually verifies
  // that the sanitized returnTo value ("/" not "/\evil.example") is used on callback.
  it("backslash in next= is sanitized: final redirect goes to /", async () => {
    const loginRes = await request(server, "GET", "/login?next=%2F%5Cevil.example");
    expect(loginRes.status).toBe(302);
    const authUrl = new URL(loginRes.headers.location!);
    const state = authUrl.searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sub: "u1", email: "u@example.com" }) }),
    );
    const cb = await request(server, "GET", `/auth/callback?state=${state}&code=test`);
    vi.unstubAllGlobals();
    expect(cb.headers.location).toBe("/");
  });

  it("double-slash in next= is sanitized: final redirect goes to /", async () => {
    const loginRes = await request(server, "GET", "/login?next=%2F%2Fevil.example");
    expect(loginRes.status).toBe(302);
    const authUrl = new URL(loginRes.headers.location!);
    const state = authUrl.searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sub: "u1", email: "u@example.com" }) }),
    );
    const cb = await request(server, "GET", `/auth/callback?state=${state}&code=test`);
    vi.unstubAllGlobals();
    expect(cb.headers.location).toBe("/");
  });

  it("GET /login?next=/issues/123 redirects to OIDC (benign path accepted)", async () => {
    const res = await request(server, "GET", "/login?next=%2Fissues%2F123");
    expect(res.status).toBe(302);
    const location = res.headers.location ?? "";
    expect(location).toContain("auth.example.com");
  });

  it("GET /login authorize URL omits the application slug (Authentik slug-less)", async () => {
    const res = await request(server, "GET", "/login");
    expect(res.status).toBe(302);
    const location = res.headers.location ?? "";
    expect(location).toContain("/application/o/authorize/");
    expect(location).not.toContain("/application/o/claws/authorize/");
    expect(location).toContain("client_id=test-client-id");
  });
});

describe("requireApiAuth — MCP token decoupling", () => {
  let server: http.Server;

  beforeEach(async () => {
    // This suite exercises the MCP token path with no session present.
    testSessionCookie = null;
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("accepts INTERNAL_MCP_TOKEN on /api/state when no session is present", async () => {
    const res = await request(server, "GET", "/api/state", {
      headers: { Authorization: "Bearer test-internal-mcp-token" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 on /api/state with wrong token", async () => {
    const res = await request(server, "GET", "/api/state", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });
});

describe("requireApiAuth — OIDC-only mode", () => {
  let server: http.Server;
  const OIDC_SECRET = "test-oidc-client-secret";

  function signSession(sub: string, expiresAt: number, secret: string): string {
    const payload = `${sub}|${expiresAt}`;
    const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    return `${payload}|${hmac}`;
  }

  beforeEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).OIDC_CLIENT_ID = "test-client-id";
    (configMod as Record<string, unknown>).OIDC_CLIENT_SECRET = OIDC_SECRET;
    (configMod as Record<string, unknown>).OIDC_BASE_URL = "https://auth.example.com";
    (configMod as Record<string, unknown>).OIDC_APPLICATION_SLUG = "claws";
    // This suite supplies its own credentials; opt out of the global session injection.
    testSessionCookie = null;
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).OIDC_CLIENT_ID = "";
    (configMod as Record<string, unknown>).OIDC_CLIENT_SECRET = "";
    (configMod as Record<string, unknown>).OIDC_BASE_URL = "";
    (configMod as Record<string, unknown>).OIDC_APPLICATION_SLUG = "";
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 401 on /api/state with no credentials when OIDC is enabled and AUTH_TOKEN is empty", async () => {
    const res = await request(server, "GET", "/api/state");
    expect(res.status).toBe(401);
  });

  it("accepts a valid claws_session cookie on /api/state", async () => {
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const sessionValue = signSession("user123", expiresAt, OIDC_SECRET);
    const res = await request(server, "GET", "/api/state", {
      headers: { Cookie: `claws_session=${encodeURIComponent(sessionValue)}` },
    });
    expect(res.status).toBe(200);
  });

  it("accepts INTERNAL_MCP_TOKEN on /api/state under OIDC", async () => {
    const res = await request(server, "GET", "/api/state", {
      headers: { Authorization: "Bearer test-internal-mcp-token" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 on /api/state with a tampered claws_session cookie", async () => {
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const sessionValue = signSession("user123", expiresAt, OIDC_SECRET);
    const tampered = sessionValue.slice(0, -1) + (sessionValue.endsWith("a") ? "b" : "a");
    const res = await request(server, "GET", "/api/state", {
      headers: { Cookie: `claws_session=${encodeURIComponent(tampered)}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("default-deny — every authenticated route returns 401 without credentials", () => {
  let server: http.Server;

  // Routes that are intentionally public (no auth required).
  const PUBLIC_ROUTES: Array<[string, string]> = [
    ["GET", "/health"],
    ["GET", "/login"],
    ["GET", "/auth/callback"],
    ["GET", "/logout"],
    ["GET", "/static/alpine.js"],
    ["GET", "/static/tailwind.css"],
  ];

  // Sample of authenticated routes spanning every group. If a new route is
  // added without mounting auth middleware, this test will fail.
  const AUTH_ROUTES: Array<[string, string]> = [
    // GET pages
    ["GET", "/"],
    ["GET", "/status"],
    ["GET", "/topology"],
    ["GET", "/ha-upgrader"],
    ["GET", "/k8s"],
    ["GET", "/jobs"],
    ["GET", "/repos"],
    ["GET", "/repos/owner/name"],
    ["GET", "/whatsapp"],
    ["GET", "/whatsapp/events"],
    ["GET", "/whatsapp/pair"],
    ["GET", "/sessions"],
    ["GET", "/sessions/abc"],
    ["GET", "/sessions/abc/ws"],
    ["GET", "/config"],
    ["GET", "/config/api"],
    ["GET", "/logs"],
    ["GET", "/logs/issue?repo=org/repo&number=1"],
    ["GET", "/logs/abc-123"],
    ["GET", "/logs/abc-123/tail"],
    ["GET", "/queue"],
    ["GET", "/runners"],
    ["GET", "/verify"],
    ["GET", "/api/activation"],
    ["GET", "/api/state"],
    // POSTs
    ["POST", "/trigger/x"],
    ["POST", "/pause/x"],
    ["POST", "/cancel"],
    ["POST", "/api/verify/run"],
    ["POST", "/api/client-error"],
    ["POST", "/api/activation"],
    ["POST", "/queue/refresh"],
    ["POST", "/queue/merge"],
    ["POST", "/queue/skip"],
    ["POST", "/queue/unskip"],
    ["POST", "/queue/prioritize"],
    ["POST", "/queue/deprioritize"],
    ["POST", "/queue/mark-refined"],
    ["POST", "/queue/mark-problematic"],
    ["POST", "/queue/unmark-problematic"],
    ["POST", "/runners/cancel"],
    ["POST", "/jobs"],
    ["POST", "/config/remove-unknown-keys"],
    ["POST", "/config"],
    ["POST", "/whatsapp/unpair"],
    ["POST", "/sessions/create"],
    ["POST", "/sessions/abc/kill"],
    ["POST", "/logs/abc-123/cancel"],
  ];

  beforeEach(async () => {
    // OIDC is enabled by the global beforeEach; deny everything by sending no session.
    testSessionCookie = null;
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("public routes do not require auth", async () => {
    for (const [method, path] of PUBLIC_ROUTES) {
      const res = await request(server, method, path);
      expect(res.status, `${method} ${path} should be public but got ${res.status}`).not.toBe(401);
    }
  });

  it("authenticated routes return 401 without credentials", async () => {
    for (const [method, path] of AUTH_ROUTES) {
      const res = await request(server, method, path);
      expect(res.status, `${method} ${path} should be 401 but got ${res.status}`).toBe(401);
    }
  });
});

describe("fail-closed — no auth when OIDC unconfigured", () => {
  let server: http.Server;

  beforeEach(async () => {
    // Clear the OIDC config the global beforeEach armed, and drop the session.
    const configMod = await import("./config.js");
    for (const k of ["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_BASE_URL", "OIDC_APPLICATION_SLUG"]) {
      (configMod as Record<string, unknown>)[k] = "";
    }
    testSessionCookie = null;
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET / returns 503 when OIDC is not configured", async () => {
    const res = await request(server, "GET", "/");
    expect(res.status).toBe(503);
  });
});
