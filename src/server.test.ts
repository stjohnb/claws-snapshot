import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";

vi.mock("./config.js", () => ({
  SERVER_PORT: 0,
  WHATSAPP_ENABLED: false,
  AUTH_TOKEN: "",
  LABELS: {
    refined: "Refined",
    ready: "Ready",
  },
  LABEL_SPECS: {
    "Refined":              { color: "0075ca", description: "Issue is ready for claws to implement" },
    "Ready":                { color: "0e8a16", description: "Claws has finished — needs human attention" },
  },
  getConfigForDisplay: vi.fn().mockReturnValue({
    slackWebhook: "****cdef",
    githubOwners: ["owner1"],
    selfRepo: "owner1/repo1",
    kwyjiboBaseUrl: "https://kwyjibo.vercel.app",
    kwyjiboApiKey: "Not configured",
    openaiApiKey: "Not configured",
    authToken: "Not configured",
    port: 3000,
    intervals: { issueWorkerMs: 300000, issueRefinerMs: 300000, ciFixerMs: 600000, reviewAddresserMs: 300000, bugInvestigatorMs: 600000, autoMergerMs: 600000 },
    schedules: { docMaintainerHour: 1, repoStandardsHour: 2, improvementIdentifierHour: 3 },
    logRetentionDays: 14,
    logRetentionPerJob: 20,
    whatsappEnabled: false,
    whatsappAllowedNumbers: [],
  }),
  writeConfig: vi.fn(),
  SKIPPED_ITEMS: [],
  PRIORITIZED_ITEMS: [],
  EMAIL_ENABLED: false,
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
  queueStatus: vi.fn().mockReturnValue({ pending: 2, active: 1 }),
  cancelCurrentTask: vi.fn().mockReturnValue(true),
}));

vi.mock("./slack.js", () => ({
  slackStatus: vi.fn().mockReturnValue({ configured: true, lastResult: "ok" }),
  isSlackBotConfigured: vi.fn().mockReturnValue(false),
}));

vi.mock("./whatsapp.js", () => ({
  whatsappStatus: vi.fn().mockReturnValue({ configured: false, connected: false }),
}));

vi.mock("./jobs/email-monitor.js", () => ({
  getEmailStatus: vi.fn().mockReturnValue({ configured: false, lastCheck: null, lastError: null }),
}));

vi.mock("./github.js", () => ({
  getQueueSnapshot: vi.fn().mockReturnValue({ items: [], oldestFetchAt: null }),
  enrichQueueItemsWithPRStatus: vi.fn().mockResolvedValue(undefined),
  mergePR: vi.fn().mockResolvedValue(undefined),
  removeQueueItem: vi.fn(),
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
    expect(body.runningTasks).toEqual([
      { jobName: "issue-worker", repo: "org/repo", itemNumber: 42, startedAt: "2025-01-01 00:00:00" },
    ]);
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
    expect(res.body).toContain("Authentication is disabled");
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
      body: "selfRepo=new%2Frepo&logRetentionDays=30&interval_issueWorkerMs=10&schedule_docMaintainerHour=3&slackWebhook=&authToken=",
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/config?saved=1");
    expect(wc).toHaveBeenCalled();
  });

  it("GET /login redirects to / when auth disabled", async () => {
    const res = await request(server, "GET", "/login");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/");
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

describe("HTTP server with auth", () => {
  let server: http.Server;

  beforeEach(async () => {
    // Enable auth by changing the mocked AUTH_TOKEN
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).AUTH_TOKEN = "test-secret-token";
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).AUTH_TOKEN = "";
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET /config returns 401 when no credentials provided", async () => {
    const res = await request(server, "GET", "/config");
    expect(res.status).toBe(401);
  });

  it("GET /config returns 200 with valid Bearer token", async () => {
    const res = await request(server, "GET", "/config", {
      headers: { Authorization: "Bearer test-secret-token" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("Save Configuration");
  });

  it("GET /config returns 200 with valid cookie", async () => {
    const res = await request(server, "GET", "/config", {
      headers: { Cookie: "claws_token=test-secret-token" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("Save Configuration");
  });

  it("GET /config/api returns 401 when no credentials", async () => {
    const res = await request(server, "GET", "/config/api");
    expect(res.status).toBe(401);
  });

  it("POST /trigger/:job requires auth when token configured", async () => {
    const res = await request(server, "POST", "/trigger/issue-worker");
    expect(res.status).toBe(401);
  });

  it("POST /trigger/:job works with valid Bearer token", async () => {
    const res = await request(server, "POST", "/trigger/issue-worker", {
      headers: { Authorization: "Bearer test-secret-token" },
    });
    expect(res.status).toBe(200);
  });

  it("POST /pause/:job requires auth when token configured", async () => {
    const res = await request(server, "POST", "/pause/issue-worker");
    expect(res.status).toBe(401);
  });

  it("POST /pause/:job works with valid Bearer token", async () => {
    const res = await request(server, "POST", "/pause/issue-worker", {
      headers: { Authorization: "Bearer test-secret-token" },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("paused");
  });

  it("POST /cancel requires auth when token configured", async () => {
    const res = await request(server, "POST", "/cancel");
    expect(res.status).toBe(401);
  });

  it("POST /cancel works with valid Bearer token", async () => {
    const res = await request(server, "POST", "/cancel", {
      headers: { Authorization: "Bearer test-secret-token" },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("cancelled");
  });

  it("GET /login shows login form when auth enabled", async () => {
    const res = await request(server, "GET", "/login");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Login");
    expect(res.body).toContain("Auth Token");
  });

  it("POST /login sets cookie on valid token", async () => {
    const res = await request(server, "POST", "/login", {
      body: "token=test-secret-token",
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/");
    const cookies = res.headers["set-cookie"];
    expect(cookies).toBeDefined();
    expect(cookies!.some(c => c.includes("claws_token="))).toBe(true);
  });

  it("POST /login shows error on invalid token", async () => {
    const res = await request(server, "POST", "/login", {
      body: "token=wrong-token",
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("Invalid token");
  });

  it("GET / returns 401 when no credentials provided", async () => {
    const res = await request(server, "GET", "/");
    expect(res.status).toBe(401);
  });

  it("GET /status returns 401 when no credentials provided", async () => {
    const res = await request(server, "GET", "/status");
    expect(res.status).toBe(401);
  });

  it("GET /queue returns 401 when no credentials provided", async () => {
    const res = await request(server, "GET", "/queue");
    expect(res.status).toBe(401);
  });

  it("GET /logs returns 401 when no credentials provided", async () => {
    const res = await request(server, "GET", "/logs");
    expect(res.status).toBe(401);
  });

  it("GET /logs/:runId returns 401 when no credentials provided", async () => {
    const res = await request(server, "GET", "/logs/abc-123");
    expect(res.status).toBe(401);
  });

  it("GET /logs/:runId/tail returns 401 when no credentials provided", async () => {
    const res = await request(server, "GET", "/logs/abc-123/tail");
    expect(res.status).toBe(401);
  });

  it("GET /logs/issue returns 401 when no credentials provided", async () => {
    const res = await request(server, "GET", "/logs/issue?repo=org/repo&number=1");
    expect(res.status).toBe(401);
  });

  it("GET /health returns 200 without credentials (public)", async () => {
    const res = await request(server, "GET", "/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
  });

  it("GET / returns 200 with valid Bearer token", async () => {
    const res = await request(server, "GET", "/", {
      headers: { Authorization: "Bearer test-secret-token" },
    });
    expect(res.status).toBe(200);
  });

  it("GET /logs returns 200 with valid Bearer token", async () => {
    const res = await request(server, "GET", "/logs", {
      headers: { Authorization: "Bearer test-secret-token" },
    });
    expect(res.status).toBe(200);
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
    for (const path of ["/", "/logs", "/config", "/queue"]) {
      const res = await request(server, "GET", path);
      expect(res.status).toBe(200);
      expect(res.body).toContain("theme-select");
      expect(res.body).toContain("setTheme");
    }
  });

  it("login page respects theme cookie but has no toggle", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).AUTH_TOKEN = "test-token";
    const authServer = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (authServer.listening) resolve();
      else authServer.on("listening", resolve);
    });
    try {
      const res = await request(authServer, "GET", "/login", {
        headers: { Cookie: "claws_theme=light" },
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('<html lang="en" data-theme="light">');
      expect(res.body).not.toContain('<select id="theme-select"');
    } finally {
      (configMod as Record<string, unknown>).AUTH_TOKEN = "";
      await new Promise<void>((resolve, reject) => {
        authServer.close((err) => (err ? reject(err) : resolve()));
      });
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
    expect(html).not.toContain("Squash &amp; Merge");
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

describe("POST /queue/merge with auth", () => {
  let server: http.Server;

  beforeEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).AUTH_TOKEN = "test-secret-token";
    server = createServer(mockScheduler());
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).AUTH_TOKEN = "";
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns 401 when no credentials provided", async () => {
    const res = await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42 }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with valid Bearer token", async () => {
    const res = await request(server, "POST", "/queue/merge", {
      headers: { "content-type": "application/json", Authorization: "Bearer test-secret-token" },
      body: JSON.stringify({ repo: "org/repo", prNumber: 42 }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result).toBe("merged");
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
    expect(html).toContain("prioritizeItem");
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
    const res = await request(server, "GET", "/logs/issue?repo=org/repo&number=42");
    expect(res.status).toBe(200);
    expect(res.body).toContain("No logs found for this issue");
    expect(res.body).toContain("repo#42");
  });

  it("GET /logs/issue renders runs when present", async () => {
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
