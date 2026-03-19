import http from "node:http";
import crypto from "node:crypto";
import { queueStatus, cancelCurrentTask } from "./claude.js";
import { SERVER_PORT, WHATSAPP_ENABLED, getConfigForDisplay, writeConfig, type ConfigFile } from "./config.js";
import * as config from "./config.js";
import { getQueueSnapshot, enrichQueueItemsWithPRStatus, mergePR, removeQueueItem, type QueueCategory } from "./github.js";
import { getRecentJobRuns, getRecentWorkItems, getDistinctJobNames, getJobRun, getJobRunLogs, getJobRunLogsSince, getLatestRunIdsByJob, getRunningTasks, getTasksByRunId, getWorkItemsForRuns, searchRunsByItem, getRunsForIssue, getLogsForRuns } from "./db.js";
import * as log from "./log.js";
import type { Scheduler } from "./scheduler.js";
import { msUntilHour } from "./scheduler.js";
import { slackStatus, isSlackBotConfigured } from "./slack.js";
import { whatsappStatus, isPairing, startPairing, stopPairing, cancelPairing, unpair } from "./whatsapp.js";
import * as emailMonitor from "./jobs/email-monitor.js";
import { VERSION } from "./version.js";
import { buildStatusPage } from "./pages/dashboard.js";
import { buildQueuePage } from "./pages/queue.js";
import { buildLogsListPage, buildLogDetailPage, buildIssueLogsPage } from "./pages/logs.js";
import { buildConfigPage } from "./pages/config.js";
import { buildWhatsAppPage } from "./pages/whatsapp.js";
import { buildLoginPage } from "./pages/login.js";

// Re-export for backwards compatibility with tests and other consumers
export { formatUptime, formatRelativeTime } from "./pages/layout.js";
export type { Theme } from "./pages/layout.js";
export { buildQueuePage } from "./pages/queue.js";
export { buildLogsListPage, buildLogDetailPage, buildIssueLogsPage } from "./pages/logs.js";

const startedAt = new Date().toISOString();

// ── Queue page category groups ──

const MY_ATTENTION_CATEGORIES: QueueCategory[] = ["ready"];
const CLAWS_ATTENTION_CATEGORIES: QueueCategory[] = ["needs-refinement", "refined", "needs-review-addressing", "auto-mergeable", "needs-triage"];

// ── Auth helpers ──

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return cookies;
}

function requireAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const token = config.AUTH_TOKEN;
  if (!token) return true; // auth disabled

  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const provided = authHeader.slice(7);
    if (safeCompare(provided, token)) return true;
  }

  // Check cookie
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies["claws_token"];
  if (cookieToken && safeCompare(cookieToken, token)) return true;

  // Auth failed
  res.writeHead(401, { "Content-Type": "text/html" });
  res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/login"></head><body>Redirecting to login...</body></html>`);
  return false;
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function readBody(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
  }
  return params;
}

// ── Server ──

export function createServer(scheduler: Scheduler): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, scheduler);
    } catch (err) {
      log.error(`HTTP handler error: ${err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    }
  });

  server.listen(SERVER_PORT, () => {
    log.info(`HTTP server listening on port ${SERVER_PORT}`);
  });

  return server;
}

function getTheme(req: http.IncomingMessage): "dark" | "light" | "system" {
  const cookies = parseCookies(req.headers.cookie);
  const value = cookies["claws_theme"];
  if (value === "dark" || value === "light") return value;
  return "system";
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, scheduler: Scheduler): Promise<void> {
  const theme = getTheme(req);

  // ── POST routes ──

  if (req.method === "POST" && req.url === "/login") {
    const body = await readBody(req);
    const params = parseFormBody(body);
    const token = params["token"] ?? "";
    const authToken = config.AUTH_TOKEN;

    if (!authToken || !safeCompare(token, authToken)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(buildLoginPage(true, theme));
      return;
    }

    res.writeHead(303, {
      Location: "/",
      "Set-Cookie": `claws_token=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/`,
    });
    res.end();
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/trigger/")) {
    if (!requireAuth(req, res)) return;

    const jobName = decodeURIComponent(req.url.slice("/trigger/".length));
    const result = scheduler.triggerJob(jobName);
    const status = result === "started" ? 200 : result === "already-running" ? 409 : 404;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result }));
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/pause/")) {
    if (!requireAuth(req, res)) return;
    const jobName = decodeURIComponent(req.url.slice("/pause/".length));
    const paused = scheduler.pausedJobs();
    let result: string;
    if (paused.has(jobName)) {
      if (!scheduler.resumeJob(jobName)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: "unknown" }));
        return;
      }
      const updated = [...scheduler.pausedJobs()];
      writeConfig({ pausedJobs: updated });
      result = "resumed";
    } else {
      if (!scheduler.pauseJob(jobName)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: "unknown" }));
        return;
      }
      const updated = [...scheduler.pausedJobs()];
      writeConfig({ pausedJobs: updated });
      result = "paused";
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result }));
    return;
  }

  if (req.method === "POST" && req.url === "/cancel") {
    if (!requireAuth(req, res)) return;
    const cancelled = cancelCurrentTask();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: cancelled ? "cancelled" : "no-active-task" }));
    return;
  }

  if (req.method === "POST" && req.url === "/queue/merge") {
    if (!requireAuth(req, res)) return;
    try {
      const body = await readBody(req);
      const { repo, prNumber } = JSON.parse(body) as { repo: string; prNumber: number };
      if (!repo || !prNumber) throw new Error("Missing repo or prNumber");
      await mergePR(repo, prNumber);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: "merged" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/queue/skip") {
    if (!requireAuth(req, res)) return;
    try {
      const body = await readBody(req);
      const { repo, number } = JSON.parse(body) as { repo: string; number: number };
      if (!repo || !number) throw new Error("Missing repo or number");
      const items = [...(config.SKIPPED_ITEMS as Array<{ repo: string; number: number }>)];
      if (!items.some((i) => i.repo === repo && i.number === number)) {
        items.push({ repo, number });
      }
      writeConfig({ skippedItems: items });
      removeQueueItem(repo, number);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: "ok" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/queue/unskip") {
    if (!requireAuth(req, res)) return;
    try {
      const body = await readBody(req);
      const { repo, number } = JSON.parse(body) as { repo: string; number: number };
      if (!repo || !number) throw new Error("Missing repo or number");
      const items = (config.SKIPPED_ITEMS as Array<{ repo: string; number: number }>).filter(
        (i) => !(i.repo === repo && i.number === number),
      );
      writeConfig({ skippedItems: items });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: "ok" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/queue/prioritize") {
    if (!requireAuth(req, res)) return;
    try {
      const body = await readBody(req);
      const { repo, number } = JSON.parse(body) as { repo: string; number: number };
      if (!repo || !number) throw new Error("Missing repo or number");
      const items = [...(config.PRIORITIZED_ITEMS as Array<{ repo: string; number: number }>)];
      if (!items.some((i) => i.repo === repo && i.number === number)) {
        items.push({ repo, number });
      }
      writeConfig({ prioritizedItems: items });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: "ok" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/queue/deprioritize") {
    if (!requireAuth(req, res)) return;
    try {
      const body = await readBody(req);
      const { repo, number } = JSON.parse(body) as { repo: string; number: number };
      if (!repo || !number) throw new Error("Missing repo or number");
      const items = (config.PRIORITIZED_ITEMS as Array<{ repo: string; number: number }>).filter(
        (i) => !(i.repo === repo && i.number === number),
      );
      writeConfig({ prioritizedItems: items });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: "ok" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/config") {
    if (!requireAuth(req, res)) return;

    const body = await readBody(req);
    const params = parseFormBody(body);
    const updates: Partial<ConfigFile> = {};

    // General
    if (params["githubOwners"] !== undefined) {
      updates.githubOwners = params["githubOwners"].split(",").map(s => s.trim()).filter(Boolean);
    }
    if (params["selfRepo"] !== undefined) updates.selfRepo = params["selfRepo"];
    if (params["logRetentionDays"] !== undefined) {
      const v = parseInt(params["logRetentionDays"], 10);
      if (v > 0) updates.logRetentionDays = v;
    }
    if (params["logRetentionPerJob"] !== undefined) {
      const v = parseInt(params["logRetentionPerJob"], 10);
      if (v >= 0) updates.logRetentionPerJob = v;
    }

    // Integrations
    if (params["slackWebhook"] !== undefined) updates.slackWebhook = params["slackWebhook"];
    if (params["slackBotToken"] !== undefined) updates.slackBotToken = params["slackBotToken"];
    if (params["slackIdeasChannel"] !== undefined) updates.slackIdeasChannel = params["slackIdeasChannel"];
    if (params["kwyjiboBaseUrl"] !== undefined) updates.kwyjiboBaseUrl = params["kwyjiboBaseUrl"];
    if (params["kwyjiboApiKey"] !== undefined) updates.kwyjiboApiKey = params["kwyjiboApiKey"];
    if (params["whatsappAllowedNumbers"] !== undefined) {
      updates.whatsappAllowedNumbers = params["whatsappAllowedNumbers"].split(",").map(s => s.trim()).filter(Boolean);
    }
    if (params["openaiApiKey"] !== undefined) updates.openaiApiKey = params["openaiApiKey"];
    if (params["emailUser"] !== undefined) updates.emailUser = params["emailUser"];
    if (params["emailAppPassword"] !== undefined) updates.emailAppPassword = params["emailAppPassword"];
    if (params["emailRecipient"] !== undefined) updates.emailRecipient = params["emailRecipient"];
    if (params["emailVegBoxSender"] !== undefined) updates.emailVegBoxSender = params["emailVegBoxSender"];

    // Runners
    if (params["runners"] !== undefined) {
      try {
        const parsed = JSON.parse(params["runners"]);
        if (Array.isArray(parsed)) updates.runners = parsed;
      } catch {
        // Invalid JSON — skip silently
      }
    }

    // Intervals
    const intervalUpdates: Record<string, number> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key.startsWith("interval_")) {
        const intKey = key.slice("interval_".length);
        const v = parseInt(value, 10);
        if (v > 0) intervalUpdates[intKey] = v * 60 * 1000; // minutes → ms
      }
    }
    if (Object.keys(intervalUpdates).length > 0) {
      updates.intervals = intervalUpdates as ConfigFile["intervals"];
    }

    // Schedules
    const scheduleUpdates: Record<string, number> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key.startsWith("schedule_")) {
        const schedKey = key.slice("schedule_".length);
        const v = parseInt(value, 10);
        if (v >= 0 && v <= 23) scheduleUpdates[schedKey] = v;
      }
    }
    if (Object.keys(scheduleUpdates).length > 0) {
      updates.schedules = scheduleUpdates as ConfigFile["schedules"];
    }

    // Auth
    if (params["authToken"] !== undefined) updates.authToken = params["authToken"];

    writeConfig(updates);

    // If auth token changed, set new cookie so user isn't locked out
    const newToken = config.AUTH_TOKEN;
    const headers: Record<string, string> = { Location: "/config?saved=1" };
    if (newToken) {
      headers["Set-Cookie"] = `claws_token=${encodeURIComponent(newToken)}; HttpOnly; Secure; SameSite=Strict; Path=/`;
    }

    res.writeHead(303, headers);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/whatsapp/unpair") {
    if (!requireAuth(req, res)) return;
    await unpair();
    res.writeHead(303, { Location: "/whatsapp" });
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }

  // ── GET routes ──

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: VERSION }));
    return;
  }

  if (req.url === "/login") {
    if (!config.AUTH_TOKEN) {
      res.writeHead(303, { Location: "/" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(buildLoginPage(false, theme));
    return;
  }

  if (req.url === "/status") {
    if (!requireAuth(req, res)) return;
    const uptimeMs = Date.now() - new Date(startedAt).getTime();
    const jobs: Record<string, boolean> = {};
    for (const [name, running] of scheduler.jobStates()) {
      jobs[name] = running;
    }
    const cq = queueStatus();
    const runningTasks = getRunningTasks().map(t => ({
      jobName: t.job_name,
      repo: t.repo,
      itemNumber: t.item_number,
      startedAt: t.started_at,
    }));
    const latestRuns = getLatestRunIdsByJob();
    const schedInfo = scheduler.jobScheduleInfo();
    const pausedSet = scheduler.pausedJobs();
    const jobSchedules: Record<string, { intervalMs?: number; scheduledHour?: number; lastCompletedAt: string | null; nextRunIn: number | null }> = {};
    for (const [name] of scheduler.jobStates()) {
      const sched = schedInfo.get(name);
      const latest = latestRuns.get(name);
      const lastCompletedAt = latest?.completedAt ? latest.completedAt + "Z" : null;
      let nextRunIn: number | null = null;
      if (!pausedSet.has(name) && sched) {
        if (sched.scheduledHour !== undefined) {
          nextRunIn = msUntilHour(sched.scheduledHour);
        } else if (latest?.startedAt) {
          nextRunIn = Math.max(0, new Date(latest.startedAt + "Z").getTime() + sched.intervalMs - Date.now());
        } else {
          nextRunIn = sched.intervalMs;
        }
      }
      jobSchedules[name] = {
        ...(sched?.scheduledHour !== undefined ? { scheduledHour: sched.scheduledHour } : { intervalMs: sched?.intervalMs }),
        lastCompletedAt,
        nextRunIn,
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        startedAt,
        uptime: Math.floor(uptimeMs / 1000),
        jobs,
        pausedJobs: [...pausedSet],
        claudeQueue: { pending: cq.pending, active: cq.active },
        runningTasks,
        jobSchedules,
        slack: slackStatus(),
        slackBot: { configured: isSlackBotConfigured() },
        whatsapp: WHATSAPP_ENABLED ? whatsappStatus() : { configured: false, connected: false, pairingRequired: false },
        email: config.EMAIL_ENABLED
          ? emailMonitor.getEmailStatus()
          : { configured: false, lastCheck: null, lastError: null },
      }),
    );
    return;
  }

  if (req.url === "/") {
    if (!requireAuth(req, res)) return;
    const uptimeMs = Date.now() - new Date(startedAt).getTime();
    const jobs: Record<string, boolean> = {};
    for (const [name, running] of scheduler.jobStates()) {
      jobs[name] = running;
    }
    const runningTasks = getRunningTasks().map(t => ({
      jobName: t.job_name,
      repo: t.repo,
      itemNumber: t.item_number,
      startedAt: t.started_at,
    }));
    const latestRuns = getLatestRunIdsByJob();
    const paused = scheduler.pausedJobs();
    const schedInfo = scheduler.jobScheduleInfo();
    const html = buildStatusPage(
      VERSION,
      Math.floor(uptimeMs / 1000),
      jobs,
      queueStatus(),
      slackStatus(),
      { configured: isSlackBotConfigured() },
      WHATSAPP_ENABLED ? whatsappStatus() : { configured: false, connected: false, pairingRequired: false },
      config.EMAIL_ENABLED
        ? emailMonitor.getEmailStatus()
        : { configured: false, lastCheck: null, lastError: null },
      runningTasks,
      latestRuns,
      theme,
      startedAt,
      paused,
      schedInfo,
    );
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  if (req.url === "/whatsapp") {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(buildWhatsAppPage(theme));
    return;
  }

  if (req.url === "/whatsapp/pair") {
    if (!requireAuth(req, res)) return;

    if (isPairing()) {
      cancelPairing();
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const listener = (event: import("./whatsapp.js").PairingEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === "connected" || event.type === "error" || event.type === "timeout") {
        res.end();
      }
    };

    res.on("close", () => {
      stopPairing();
    });

    startPairing(listener).catch((err) => {
      res.write(`data: ${JSON.stringify({ type: "error", message: String(err) })}\n\n`);
      res.end();
    });
    return;
  }

  if (req.url === "/config" || req.url?.startsWith("/config?")) {
    if (!requireAuth(req, res)) return;
    const urlObj = new URL(req.url, "http://localhost");
    const saved = urlObj.searchParams.get("saved") === "1";
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(buildConfigPage(saved, theme));
    return;
  }

  if (req.url === "/config/api") {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getConfigForDisplay()));
    return;
  }

  // GET /logs or GET /logs?job=... or GET /logs?search=...
  if (req.url === "/logs" || req.url?.startsWith("/logs?")) {
    if (!requireAuth(req, res)) return;
    const urlObj = new URL(req.url, `http://localhost`);
    const jobFilter = urlObj.searchParams.get("job");
    const search = urlObj.searchParams.get("search") ?? undefined;
    const runs = search
      ? searchRunsByItem(search)
      : getRecentJobRuns(50, jobFilter ?? undefined);
    const jobNames = getDistinctJobNames();
    const workItems = getWorkItemsForRuns(runs.map((r) => r.run_id));
    const recentItems = search ? [] : getRecentWorkItems();
    const html = buildLogsListPage(runs, jobNames, jobFilter, theme, workItems, search, recentItems);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  // GET /logs/issue?repo=...&number=...
  if (req.url?.startsWith("/logs/issue?") || req.url === "/logs/issue") {
    if (!requireAuth(req, res)) return;
    const urlObj = new URL(req.url, "http://localhost");
    const repoParam = urlObj.searchParams.get("repo");
    const numberParam = urlObj.searchParams.get("number");
    const num = parseInt(numberParam ?? "", 10);
    if (!repoParam || !numberParam || !Number.isFinite(num) || num < 1) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing or invalid repo/number query params");
      return;
    }
    const runs = getRunsForIssue(repoParam, num);
    const runIds = runs.map(r => r.run_id);
    const logsByRun = getLogsForRuns(runIds);
    const workItems = getWorkItemsForRuns(runIds);
    const html = buildIssueLogsPage(repoParam, num, runs, logsByRun, workItems, theme);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  // GET /logs/:runId/tail?after=N
  if (req.url?.startsWith("/logs/") && req.url.includes("/tail")) {
    if (!requireAuth(req, res)) return;
    const urlObj = new URL(req.url, "http://localhost");
    const pathParts = urlObj.pathname.split("/");
    // /logs/:runId/tail → ["", "logs", runId, "tail"]
    const runId = decodeURIComponent(pathParts[2]);
    const afterId = parseInt(urlObj.searchParams.get("after") ?? "0", 10) || 0;
    const run = getJobRun(runId);
    if (!run) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Run not found" }));
      return;
    }
    const logs = getJobRunLogsSince(runId, afterId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: run.status,
      completed_at: run.completed_at,
      logs: logs.map(l => ({ id: l.id, level: l.level, message: l.message, logged_at: l.logged_at })),
    }));
    return;
  }

  // GET /logs/:runId
  if (req.url?.startsWith("/logs/")) {
    if (!requireAuth(req, res)) return;
    const runId = decodeURIComponent(req.url.slice("/logs/".length));
    const run = getJobRun(runId);
    if (!run) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Run not found");
      return;
    }
    const logs = getJobRunLogs(runId);
    const tasks = getTasksByRunId(runId);
    const html = buildLogDetailPage(run, logs, theme, tasks);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  if (req.url === "/queue") {
    if (!requireAuth(req, res)) return;
    const myAttention = getQueueSnapshot(MY_ATTENTION_CATEGORIES);
    const clawsAttention = getQueueSnapshot(CLAWS_ATTENTION_CATEGORIES);
    await enrichQueueItemsWithPRStatus(myAttention.items);
    const html = buildQueuePage(myAttention, clawsAttention, theme, config.SKIPPED_ITEMS as Array<{ repo: string; number: number }>);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  res.writeHead(404).end();
}
