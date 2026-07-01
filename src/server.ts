import { z } from "zod";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocket } from "ws";
import { cancelCurrentTask, cancelTaskByRunId, isProviderRateLimited, getProviderLastUsedAt, isOpenCodeBinaryAvailable } from "./claude.js";
import * as worker from "./worker.js";
import { SERVER_PORT, BIND_HOST, WORK_DIR, WHATSAPP_ENABLED, VALID_AGENT_NAMES, SENSITIVE_KEYS, DEEP_MERGED_KEYS, getConfigForDisplay, loadConfig, writeConfig, getUnknownConfigKeys, removeConfigKeys, type ConfigFile } from "./config.js";
import * as config from "./config.js";
import { getQueueSnapshot, enrichQueueItemsWithPRStatus, mergePR, removeQueueItem, ALL_QUEUE_CATEGORIES, type QueueCategory, listRepos, listPRs, listIssuesByLabel, listOpenIssues, cancelWorkflow, addLabel, removeLabel } from "./github.js";
import { LABELS } from "./config.js";
import { getRecentJobRuns, getRecentWorkItems, getDistinctJobNames, getJobRun, getJobRunLogs, getJobRunLogsSince, getLatestRunIdsByJob, getRunningTasks, getTasksByRunId, getWorkItemsForRuns, searchRunsByItem, getRunsForIssue, getLogsForRuns, getAllAverageTaskDurations, getQueueSnapshots, getRecentTasksForRepo, getDailyTaskStats, getLastTaskTimePerRepo, getLastUsedByProvider, getActiveWorkflowRuns, getWorkflowRunStats, getLastWorkflowRunSync, getRecentWhatsappEvents, cancelJobRunIfRunning, listQueuedWork, getAllHaUpgraderStates, getUsageStats, getTotalUsage, type WorkQueueRow } from "./db.js";
import * as log from "./log.js";
import type { Scheduler } from "./scheduler.js";
import { msUntilHour } from "./scheduler.js";
import { notify, slackStatus, isSlackBotConfigured } from "./slack.js";
import { whatsappStatus, isPairing, startPairing, stopPairing, cancelPairing, unpair } from "./whatsapp.js";
import * as emailMonitor from "./jobs/email-monitor.js";
import { VERSION } from "./version.js";
import { buildStatusPage } from "./pages/dashboard.js";
import { buildQueuePage } from "./pages/queue.js";
import { buildLogsListPage, buildLogDetailPage, buildIssueLogsPage, renderOutcomeCard, parseOutcome } from "./pages/logs.js";
import { buildConfigPage } from "./pages/config.js";
import { buildWhatsAppPage } from "./pages/whatsapp.js";
import { buildTopologyPage } from "./pages/topology.js";
import { buildRepoPage, buildRepoListPage } from "./pages/repo.js";
import { buildRunnersPage } from "./pages/runners.js";
import { buildUsagePage } from "./pages/usage.js";
import { buildJobsMatrixPage, REPO_JOB_NAMES, OPT_IN_JOB_NAMES } from "./pages/jobs-matrix.js";
import { buildVerifyPage } from "./pages/verify.js";
import { runConnectivityVerification, loadLatestReport } from "./jobs/connectivity-verifier.js";
import { createSession, createMultiWorktreeSession, getSession, listSessions, killSession, resumeSession, disconnectAllSessions, describeCreateSessionError, SESSION_MODES, type Session, type SessionMode } from "./sessions.js";
import { validCapabilityIds } from "./capabilities.js";
import { buildSessionsListPage, buildSessionTerminalPage } from "./pages/sessions.js";
import { buildHaUpgraderPage } from "./pages/ha-upgrader.js";
import { buildK8sPage, type K8sClusterView } from "./pages/k8s.js";
import { getK8sMonitorStatus, type K8sMonitorStatus } from "./jobs/k3s-monitor.js";
import { k8sIntegrationLabel } from "./pages/layout.js";
import { ALPINE_JS_SOURCE } from "./resources/alpinejs.js";
import { reportError } from "./error-reporter.js";
import { TAILWIND_CSS_SOURCE } from "./resources/tailwind-css.generated.js";

const ALPINE_JS_ETAG = `"${crypto.createHash("sha256").update(ALPINE_JS_SOURCE).digest("hex").slice(0, 16)}"`;
const TAILWIND_CSS_ETAG = `"${crypto.createHash("sha256").update(TAILWIND_CSS_SOURCE).digest("hex").slice(0, 16)}"`;

// Re-export for backwards compatibility with tests and other consumers
export { formatUptime } from "./pages/layout.js";
export type { Theme } from "./pages/layout.js";
export { buildQueuePage } from "./pages/queue.js";
export { buildLogsListPage, buildLogDetailPage, buildIssueLogsPage } from "./pages/logs.js";

const startedAt = new Date().toISOString();

type Env = { Bindings: HttpBindings };
type Ctx = Context<Env>;

let homeAssistantStatus: { lastCheck: string | null; lastError: string | null } = { lastCheck: null, lastError: null };

function isHomeAssistantConfigured(): boolean {
  return !!(config.HOME_ASSISTANT_BASE_URL && config.HOME_ASSISTANT_TOKEN);
}

async function pingHomeAssistant(): Promise<void> {
  if (!isHomeAssistantConfigured()) {
    homeAssistantStatus = { lastCheck: null, lastError: null };
    return;
  }
  try {
    const url = config.HOME_ASSISTANT_BASE_URL.replace(/\/$/, "") + "/api/";
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.HOME_ASSISTANT_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      homeAssistantStatus = { lastCheck: new Date().toISOString(), lastError: `HTTP ${res.status}` };
      return;
    }
    homeAssistantStatus = { lastCheck: new Date().toISOString(), lastError: null };
  } catch (err) {
    homeAssistantStatus = {
      lastCheck: new Date().toISOString(),
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

function getHomeAssistantStatus() {
  return { configured: isHomeAssistantConfigured(), lastCheck: homeAssistantStatus.lastCheck, lastError: homeAssistantStatus.lastError };
}

function getK3sIntegrationStatus(): K8sMonitorStatus {
  return getK8sMonitorStatus("k3s-monitor") ?? {
    logPrefix: "k3s-monitor", repo: config.FLEET_INFRA_REPO,
    enabled: config.K3S_MONITOR_ENABLED, lastRunAt: null, lastError: null,
    podCount: 0, nodeCount: 0, nodesNotReady: 0,
    podAlertCount: 0, nodeAlertCount: 0, fluxAlertCount: 0, newIssuesRaised: 0,
  };
}

function getProdK8sIntegrationStatus(): K8sMonitorStatus {
  return getK8sMonitorStatus("prod-k8s-monitor") ?? {
    logPrefix: "prod-k8s-monitor", repo: config.PROD_K8S_REPO,
    enabled: config.PROD_K8S_MONITOR_ENABLED,
    kubeconfigPath: config.PROD_K8S_KUBECONFIG_PATH || undefined,
    lastRunAt: null, lastError: null,
    podCount: 0, nodeCount: 0, nodesNotReady: 0,
    podAlertCount: 0, nodeAlertCount: 0, fluxAlertCount: 0, newIssuesRaised: 0,
  };
}

const RepoNumberSchema = z.object({ repo: z.string().min(1), number: z.number().int().positive() });
const RepoItemSchema = z.object({ repo: z.string().min(1), prNumber: z.number().int().positive() });
const RepoRunIdSchema = z.object({ repo: z.string().min(1), runId: z.string().regex(/^\d+$/) });
const WsMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({ type: z.literal("resize"), cols: z.number(), rows: z.number() }),
]);

// ── Queue page category groups ──

const MY_ATTENTION_CATEGORIES: QueueCategory[] = ["ready"];
const CLAWS_ATTENTION_CATEGORIES: QueueCategory[] = ["needs-refinement", "refined", "needs-review-addressing", "auto-mergeable", "needs-triage", "needs-qa"];
// "needs-triage" is intentionally excluded — triage is a manual attention step, not part of the automated pipeline shown on the topology page.
const TOPOLOGY_CATEGORIES: QueueCategory[] = ["needs-refinement", "refined", "needs-review-addressing", "auto-mergeable", "needs-qa"];

// ── Auth helpers ──

function parseCookies(header: string | undefined | null): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return cookies;
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Returns true when all four required OIDC fields are non-empty. */
function isOidcEnabled(): boolean {
  return !!(
    config.OIDC_CLIENT_ID &&
    config.OIDC_CLIENT_SECRET &&
    config.OIDC_BASE_URL &&
    config.OIDC_APPLICATION_SLUG
  );
}

const pendingOAuthStates = new Map<string, { expiresAt: number; returnTo: string }>();

function generateOAuthState(returnTo = "/"): string {
  const now = Date.now();
  for (const [k, v] of pendingOAuthStates) {
    if (v.expiresAt < now) pendingOAuthStates.delete(k);
  }
  const state = crypto.randomBytes(16).toString("hex");
  pendingOAuthStates.set(state, { expiresAt: now + 5 * 60 * 1000, returnTo });
  return state;
}

function consumeOAuthState(state: string): string | null {
  const entry = pendingOAuthStates.get(state);
  pendingOAuthStates.delete(state);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.returnTo;
}

function signSession(sub: string, expiresAt: number, secret: string): string {
  const payload = `${sub}|${expiresAt}`;
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}|${hmac}`;
}

function verifySession(value: string, secret: string): { sub: string } | null {
  const lastPipe = value.lastIndexOf("|");
  if (lastPipe < 0) return null;
  const hmac = value.slice(lastPipe + 1);
  const rest = value.slice(0, lastPipe);
  const secondLastPipe = rest.lastIndexOf("|");
  if (secondLastPipe < 0) return null;
  const expiryStr = rest.slice(secondLastPipe + 1);
  const sub = rest.slice(0, secondLastPipe);
  if (!sub || !expiryStr || !hmac) return null;
  const payload = `${sub}|${expiryStr}`;
  let expectedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(
      crypto.createHmac("sha256", secret).update(payload).digest("hex"),
    );
  } catch {
    return null;
  }
  const providedBuf = Buffer.from(hmac);
  if (
    expectedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, providedBuf)
  )
    return null;
  if (Date.now() > parseInt(expiryStr, 10)) return null;
  return { sub };
}

function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    try {
      const key = decodeURIComponent(pair.slice(0, eq));
      const value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
      params[key] = value;
    } catch {
      continue;
    }
  }
  return params;
}

/** Parse all values for a repeated form key (parseFormBody keeps only the last). */
function parseFormBodyMulti(body: string, key: string): string[] {
  const out: string[] = [];
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    try {
      const k = decodeURIComponent(pair.slice(0, eq));
      if (k !== key) continue;
      out.push(decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " ")));
    } catch {
      continue;
    }
  }
  return out;
}

/** Strip control characters and truncate to prevent confusing audit messages from crafted URL paths. */
function sanitizeForNotification(value: string, maxLength = 100): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, "");
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) + "…" : cleaned;
}

function getClientIP(c: Ctx): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  const incoming = c.env.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

function getTheme(c: Ctx): "dark" | "light" | "system" {
  const cookies = parseCookies(c.req.header("cookie"));
  const value = cookies["claws_theme"];
  if (value === "dark" || value === "light") return value;
  return "system";
}

async function readTextBody(c: Ctx, maxBytes = 1024 * 1024): Promise<string> {
  const contentLength = c.req.header("content-length");
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new Error("Request body too large");
  }
  const rawBody = c.req.raw.body;
  if (!rawBody) return "";
  const reader = rawBody.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      throw new Error("Request body too large");
    }
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

// ── Response helpers (exact Content-Type without charset suffix to match legacy) ──

function htmlOk(c: Ctx, body: string, status = 200) {
  c.header("Content-Type", "text/html");
  return c.body(body, status as ContentfulStatusCode);
}

function jsonOk(c: Ctx, obj: unknown, status = 200) {
  c.header("Content-Type", "application/json");
  return c.body(JSON.stringify(obj), status as ContentfulStatusCode);
}

function textPlain(c: Ctx, body: string, status = 200) {
  c.header("Content-Type", "text/plain");
  return c.body(body, status as ContentfulStatusCode);
}

// ── Auth middlewares ──

const authMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  if (isOidcEnabled()) {
    const cookies = parseCookies(c.req.header("cookie"));
    const sessionCookie = cookies["claws_session"];
    if (sessionCookie) {
      let decoded: string;
      try { decoded = decodeURIComponent(sessionCookie); } catch { decoded = sessionCookie; }
      if (verifySession(decoded, config.OIDC_CLIENT_SECRET)) return next();
    }
    const reqPath = c.req.path + (c.req.url.includes("?") ? "?" + c.req.url.split("?").slice(1).join("?") : "");
    const loginUrl = `/login?next=${encodeURIComponent(reqPath)}`;
    c.header("Content-Type", "text/html");
    return c.body(
      `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${loginUrl}"></head><body>Redirecting to login...</body></html>`,
      401,
    );
  }
  // OIDC not configured: fail closed. Nothing runs open.
  return textPlain(
    c,
    "Authentication is not configured. Set OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_BASE_URL, and OIDC_APPLICATION_SLUG in ~/.claws/env to enable login.",
    503,
  );
};

const apiAuthMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  const authHeader = c.req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    if (safeCompare(authHeader.slice(7), config.INTERNAL_MCP_TOKEN)) return next();
  }
  if (isOidcEnabled()) {
    const cookies = parseCookies(c.req.header("cookie"));
    const sessionCookie = cookies["claws_session"];
    if (sessionCookie) {
      let decoded: string;
      try { decoded = decodeURIComponent(sessionCookie); } catch { decoded = sessionCookie; }
      if (verifySession(decoded, config.OIDC_CLIENT_SECRET)) return next();
    }
  }
  return jsonOk(c, { error: "unauthorized" }, 401);
};

// ── Server ──

export function createServer(scheduler: Scheduler): http.Server {
  const app = new Hono<Env>();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  registerRoutes(app, scheduler, upgradeWebSocket);

  // ── Default 404 / 405 ──
  // Preserve legacy behavior: the original handleRequest returned 405 for any
  // non-GET that didn't match a POST handler, and 404 for unmatched GETs.
  app.notFound((c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    return c.body(null, 404);
  });

  app.onError((err, c) => {
    log.error(`HTTP handler error: ${err}`);
    c.header("Content-Type", "text/plain");
    return c.body("Internal Server Error", 500);
  });

  const server = serve(
    { fetch: app.fetch, port: SERVER_PORT, hostname: BIND_HOST },
    (info) => {
      log.info(`HTTP server listening on ${info.address}:${info.port}`);
    },
  ) as http.Server;

  injectWebSocket(server);

  pingHomeAssistant().catch(() => {});
  const haInterval = setInterval(() => { pingHomeAssistant().catch(() => {}); }, 5 * 60 * 1000);
  haInterval.unref();
  server.on("close", () => { clearInterval(haInterval); });

  server.on("close", () => {
    disconnectAllSessions().catch((err) => log.error(`disconnectAllSessions on close: ${err}`));
  });

  return server;
}

function handleSessionWs(ws: WebSocket, session: Session): void {
  session.wsConnected = true;
  session.lastActivity = Date.now();

  if (session.scrollback) {
    ws.send(JSON.stringify({ type: "scrollback", data: session.scrollback }));
  }

  if (!session.alive) {
    ws.send(JSON.stringify({ type: "exit", code: session.exitCode }));
  }

  const dataHandler = session.pty.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  const exitHandler = session.pty.onExit(({ exitCode }: { exitCode: number }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "exit", code: exitCode }));
    }
  });

  ws.on("message", (raw: Buffer | string) => {
    session.lastActivity = Date.now();
    try {
      const parseResult = WsMessageSchema.safeParse(JSON.parse(typeof raw === "string" ? raw : raw.toString()));
      if (!parseResult.success) return;
      const msg = parseResult.data;
      if (msg.type === "input" && session.alive) {
        session.pty.write(msg.data);
      } else if (msg.type === "resize") {
        session.pty.resize(
          Math.max(1, Math.min(500, Math.floor(msg.cols))),
          Math.max(1, Math.min(200, Math.floor(msg.rows))),
        );
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on("close", () => {
    session.wsConnected = false;
    dataHandler.dispose();
    exitHandler.dispose();
  });
}

function registerRoutes(
  app: Hono<Env>,
  scheduler: Scheduler,
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"],
): void {
  // ── Public routes (no auth) ──

  app.get("/health", (c) => {
    return jsonOk(c, { status: "ok", version: VERSION });
  });

  app.get("/static/alpine.js", (c) => {
    if (c.req.header("if-none-match") === ALPINE_JS_ETAG) {
      c.header("ETag", ALPINE_JS_ETAG);
      return c.body(null, 304);
    }
    c.header("Content-Type", "application/javascript");
    c.header("Cache-Control", "max-age=31536000, immutable");
    c.header("ETag", ALPINE_JS_ETAG);
    return c.body(ALPINE_JS_SOURCE);
  });

  app.get("/static/tailwind.css", (c) => {
    if (c.req.header("if-none-match") === TAILWIND_CSS_ETAG) {
      c.header("ETag", TAILWIND_CSS_ETAG);
      return c.body(null, 304);
    }
    c.header("Content-Type", "text/css");
    c.header("Cache-Control", "no-cache");
    c.header("ETag", TAILWIND_CSS_ETAG);
    return c.body(TAILWIND_CSS_SOURCE);
  });

  app.get("/login", (c) => {
    if (isOidcEnabled()) {
      const raw = c.req.query("next") ?? "/";
      const returnTo =
        raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")
          ? raw
          : "/";
      const state = generateOAuthState(returnTo);
      const redirectUri =
        config.OIDC_REDIRECT_URI || `http://localhost:${SERVER_PORT}/auth/callback`;
      const authorizeUrl = new URL(
        `${config.OIDC_BASE_URL}/application/o/authorize/`,
      );
      authorizeUrl.searchParams.set("client_id", config.OIDC_CLIENT_ID);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("scope", "openid profile email");
      authorizeUrl.searchParams.set("state", state);
      return c.redirect(authorizeUrl.toString(), 302);
    }

    return textPlain(
      c,
      "Authentication is not configured. Set the OIDC_* variables in ~/.claws/env to enable login.",
      503,
    );
  });

  app.get("/auth/callback", async (c) => {
    if (!isOidcEnabled()) {
      return c.body(null, 404);
    }

    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!code || !state) {
      return htmlOk(c, "Bad request: missing code or state parameter", 400);
    }

    const returnTo = consumeOAuthState(state);
    if (!returnTo) {
      return htmlOk(c, "Bad request: invalid or expired OAuth state. Please try logging in again.", 400);
    }

    const redirectUri =
      config.OIDC_REDIRECT_URI ||
      `http://localhost:${SERVER_PORT}/auth/callback`;

    try {
      const tokenUrl = `${config.OIDC_BASE_URL}/application/o/token/`;
      const tokenRes = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: config.OIDC_CLIENT_ID,
          client_secret: config.OIDC_CLIENT_SECRET,
        }).toString(),
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        log.error(`OIDC token exchange failed: ${tokenRes.status} ${text}`);
        return htmlOk(c, "Authentication failed: could not exchange code. Please try again.", 502);
      }

      const tokens = (await tokenRes.json()) as { access_token: string };

      if (!tokens.access_token || typeof tokens.access_token !== "string") {
        log.error("OIDC token exchange: missing access_token in response");
        return htmlOk(c, "Authentication failed: unexpected token response.", 502);
      }

      const userinfoUrl = `${config.OIDC_BASE_URL}/application/o/userinfo/`;
      const userRes = await fetch(userinfoUrl, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });

      if (!userRes.ok) {
        log.error(`OIDC userinfo fetch failed: ${userRes.status}`);
        return htmlOk(c, "Authentication failed: could not fetch user info. Please try again.", 502);
      }

      const userinfo = (await userRes.json()) as { sub: string };

      if (!userinfo.sub || typeof userinfo.sub !== "string") {
        log.error("OIDC userinfo: missing sub claim");
        return htmlOk(c, "Authentication failed: user identity missing.", 502);
      }

      // No in-app identity allowlist by design. Dashboard authorization is
      // enforced upstream by the Authentik group policy bindings for the
      // claws-app application (fleet-infra:
      // apps/authentik/configmap-blueprints.yaml, "Claws bindings"), which
      // restrict completion of OIDC authorization to members of group-infra
      // or group-all-apps (policy_engine_mode: any). A user who can merely
      // authenticate to the IdP but is not in those groups is rejected at the
      // application-authorization step and never reaches this callback with a
      // valid code, so any sub/email arriving here is already authorized.
      // Adding a second allowlist here would duplicate that version-controlled
      // authorization across two systems (drift hazard) for a single-tenant
      // deployment. See issue #1792.

      const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
      const sessionValue = signSession(userinfo.sub, expiresAt, config.OIDC_CLIENT_SECRET);

      log.info(`OIDC login: sub=${userinfo.sub}`);
      c.header("Set-Cookie", `claws_session=${encodeURIComponent(sessionValue)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${24 * 60 * 60}`);
      return c.redirect(returnTo, 303);
    } catch (err) {
      log.error(`OIDC callback error: ${err}`);
      return htmlOk(c, "Internal error during authentication. Please try again.", 500);
    }
  });

  app.get("/logout", (c) => {
    c.header("Set-Cookie", `claws_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`, { append: true });

    if (isOidcEnabled() && config.OIDC_REDIRECT_URI) {
      const postLogoutUri = encodeURIComponent(
        config.OIDC_REDIRECT_URI.replace(/\/auth\/callback$/, "/login"),
      );
      const endSessionUrl = `${config.OIDC_BASE_URL}/application/o/${config.OIDC_APPLICATION_SLUG}/end-session/?post_logout_redirect_uri=${postLogoutUri}`;
      return c.redirect(endSessionUrl, 303);
    }
    return c.redirect("/", 303);
  });

  // ── /api/state uses apiAuth (JSON 401) ──

  app.get("/api/state", apiAuthMiddleware, (c) => {
    const snapshot = getQueueSnapshot(ALL_QUEUE_CATEGORIES);
    const ws = worker.workerStatus();
    const queuedRows = listQueuedWork();
    return jsonOk(c, {
      queue: snapshot.items,
      claudeQueue: { pending: ws.queued, active: ws.running },
      claudeQueueEntries: queuedRows.map((r, i) => ({
        position: i + 1,
        priority: r.priority === 1,
        meta: { repo: r.repo, itemNumber: r.item_number, jobName: r.kind },
      })),
      updatedAt: new Date().toISOString(),
    });
  });

  // ── Authenticated routes ──

  app.post("/trigger/:job", authMiddleware, (c) => {
    const jobName = c.req.param("job");
    const result = scheduler.triggerJob(jobName);
    const status = result === "started" ? 200 : result === "unknown" ? 404 : 409;
    return jsonOk(c, { result }, status);
  });

  app.post("/pause/:job", authMiddleware, (c) => {
    const jobName = c.req.param("job");
    const paused = scheduler.pausedJobs();
    let result: string;
    if (paused.has(jobName)) {
      if (!scheduler.resumeJob(jobName)) {
        return jsonOk(c, { result: "unknown" }, 404);
      }
      const updated = [...scheduler.pausedJobs()];
      writeConfig({ pausedJobs: updated });
      result = "resumed";
    } else {
      if (!scheduler.pauseJob(jobName)) {
        return jsonOk(c, { result: "unknown" }, 404);
      }
      const updated = [...scheduler.pausedJobs()];
      writeConfig({ pausedJobs: updated });
      result = "paused";
    }
    if (config.NOTIFY_DASHBOARD_ACTIONS) {
      notify(`[dashboard] Job "${sanitizeForNotification(jobName)}" ${result} (from ${sanitizeForNotification(getClientIP(c))})`);
    }
    return jsonOk(c, { result });
  });

  app.post("/cancel", authMiddleware, (c) => {
    const cancelled = cancelCurrentTask();
    if (cancelled && config.NOTIFY_DASHBOARD_ACTIONS) {
      notify(`[dashboard] Task cancelled (from ${sanitizeForNotification(getClientIP(c))})`);
    }
    return jsonOk(c, { result: cancelled ? "cancelled" : "no-active-task" });
  });

  app.post("/api/verify/run", authMiddleware, async (c) => {
    try {
      const report = await runConnectivityVerification();
      if (config.NOTIFY_DASHBOARD_ACTIONS) {
        const failed = report.checks.filter((ck) => !ck.ok).length;
        notify(`[dashboard] Connectivity verification re-run (${failed} failures, from ${sanitizeForNotification(getClientIP(c))})`);
      }
      const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
      if (wantsJson) {
        return jsonOk(c, report);
      }
      return c.redirect("/verify", 303);
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/api/client-error", authMiddleware, async (c) => {
    try {
      const raw = await readTextBody(c, 8192);
      const parsed = JSON.parse(raw);
      const fingerprint = typeof parsed.fingerprint === "string" && parsed.fingerprint
        ? `client-error: ${parsed.fingerprint.slice(0, 200)}`
        : "client-error: unknown";
      const message = typeof parsed.message === "string" ? parsed.message.slice(0, 500) : "unknown";
      const stack = typeof parsed.stack === "string" ? parsed.stack.slice(0, 2000) : "";
      const context = typeof parsed.context === "string" ? parsed.context.slice(0, 200) : "client";
      const err = new Error(message);
      err.stack = stack || `Error: ${message}`;
      void reportError(fingerprint, `client-side JS error on ${context}`, err);
    } catch {
      // ignore malformed payloads
    }
    return c.body(null, 204);
  });

  app.get("/api/activation", authMiddleware, (c) => {
    const report = loadLatestReport();
    return jsonOk(c, {
      state: config.ACTIVATION_STATE,
      lastVerification: report ? { generatedAt: report.generatedAt, failures: report.checks.filter((ck) => !ck.ok).length } : null,
    });
  });

  app.post("/api/activation", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const parsed = JSON.parse(body) as { state?: string; confirm?: boolean };
      if (!parsed.confirm) {
        return jsonOk(c, { error: "confirm:true required" }, 400);
      }
      if (parsed.state !== "active" && parsed.state !== "verify-only") {
        return jsonOk(c, { error: "state must be 'active' or 'verify-only'" }, 400);
      }
      if (parsed.state === config.ACTIVATION_STATE) {
        return jsonOk(c, { result: "unchanged", state: parsed.state });
      }
      writeConfig({ activationState: parsed.state });
      const actor = sanitizeForNotification(getClientIP(c));
      log.warn(`[activation] Flipped to ${parsed.state} by ${actor}`);
      if (config.NOTIFY_DASHBOARD_ACTIONS) {
        notify(`[dashboard] Activation flipped to ${parsed.state} (from ${actor})`);
      }
      return jsonOk(c, { result: "flipped", state: parsed.state, restartRequired: true });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/refresh", authMiddleware, (c) => {
    const jobs = ["issue-dispatcher", "pr-dispatcher"];
    const results: Record<string, string> = {};
    for (const name of jobs) {
      results[name] = scheduler.triggerJob(name);
    }
    return jsonOk(c, { results });
  });

  app.post("/queue/merge", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const { repo, prNumber } = RepoItemSchema.parse(JSON.parse(body));
      await mergePR(repo, prNumber);
      removeQueueItem(repo, prNumber);
      if (config.NOTIFY_DASHBOARD_ACTIONS) {
        notify(`[dashboard] PR ${sanitizeForNotification(repo)}#${prNumber} merged (from ${sanitizeForNotification(getClientIP(c))})`);
      }
      return jsonOk(c, { result: "merged" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/skip", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const { repo, number } = RepoNumberSchema.parse(JSON.parse(body));
      const items = [...(config.SKIPPED_ITEMS as Array<{ repo: string; number: number }>)];
      if (!items.some((i) => i.repo === repo && i.number === number)) {
        items.push({ repo, number });
      }
      writeConfig({ skippedItems: items });
      removeQueueItem(repo, number);
      if (config.NOTIFY_DASHBOARD_ACTIONS) {
        notify(`[dashboard] ${sanitizeForNotification(repo)}#${number} skipped (from ${sanitizeForNotification(getClientIP(c))})`);
      }
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/unskip", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const { repo, number } = RepoNumberSchema.parse(JSON.parse(body));
      const items = (config.SKIPPED_ITEMS as Array<{ repo: string; number: number }>).filter(
        (i) => !(i.repo === repo && i.number === number),
      );
      writeConfig({ skippedItems: items });
      if (config.NOTIFY_DASHBOARD_ACTIONS) {
        notify(`[dashboard] ${sanitizeForNotification(repo)}#${number} unskipped (from ${sanitizeForNotification(getClientIP(c))})`);
      }
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/prioritize", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const { repo, number } = RepoNumberSchema.parse(JSON.parse(body));
      const items = [...(config.PRIORITIZED_ITEMS as Array<{ repo: string; number: number }>)];
      if (!items.some((i) => i.repo === repo && i.number === number)) {
        items.push({ repo, number });
      }
      writeConfig({ prioritizedItems: items });
      if (config.NOTIFY_DASHBOARD_ACTIONS) {
        notify(`[dashboard] ${sanitizeForNotification(repo)}#${number} prioritized (from ${sanitizeForNotification(getClientIP(c))})`);
      }
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/deprioritize", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const { repo, number } = RepoNumberSchema.parse(JSON.parse(body));
      const items = (config.PRIORITIZED_ITEMS as Array<{ repo: string; number: number }>).filter(
        (i) => !(i.repo === repo && i.number === number),
      );
      writeConfig({ prioritizedItems: items });
      if (config.NOTIFY_DASHBOARD_ACTIONS) {
        notify(`[dashboard] ${sanitizeForNotification(repo)}#${number} deprioritized (from ${sanitizeForNotification(getClientIP(c))})`);
      }
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/mark-refined", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const parsed = RepoNumberSchema.safeParse(JSON.parse(body));
      if (!parsed.success) throw new Error("Missing repo or number");
      const { repo, number } = parsed.data;
      await addLabel(repo, number, LABELS.refined);
      removeQueueItem(repo, number);
      if (config.NOTIFY_DASHBOARD_ACTIONS) {
        notify(`[dashboard] ${sanitizeForNotification(repo)}#${number} marked as refined (from ${sanitizeForNotification(getClientIP(c))})`);
      }
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/mark-problematic", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const parsed = RepoNumberSchema.safeParse(JSON.parse(body));
      if (!parsed.success) throw new Error("Missing repo or number");
      const { repo, number } = parsed.data;
      await addLabel(repo, number, LABELS.problematic);
      removeQueueItem(repo, number);
      if (config.NOTIFY_DASHBOARD_ACTIONS) {
        notify(`[dashboard] ${sanitizeForNotification(repo)}#${number} marked as problematic (from ${sanitizeForNotification(getClientIP(c))})`);
      }
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/queue/unmark-problematic", authMiddleware, async (c) => {
    try {
      const body = await readTextBody(c);
      const parsed = RepoNumberSchema.safeParse(JSON.parse(body));
      if (!parsed.success) throw new Error("Missing repo or number");
      const { repo, number } = parsed.data;
      await removeLabel(repo, number, LABELS.problematic);
      if (config.NOTIFY_DASHBOARD_ACTIONS) {
        notify(`[dashboard] ${sanitizeForNotification(repo)}#${number} unmarked as problematic (from ${sanitizeForNotification(getClientIP(c))})`);
      }
      return jsonOk(c, { result: "ok" });
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/runners/cancel", authMiddleware, async (c) => {
    let repo: string | undefined;
    let runId: string | undefined;
    try {
      const body = await readTextBody(c);
      const parsedRunId = RepoRunIdSchema.safeParse(JSON.parse(body));
      if (!parsedRunId.success) throw new Error("Missing repo or runId");
      ({ repo, runId } = parsedRunId.data);

      const repos = await listRepos();
      if (!repos.some((r) => r.fullName === repo)) {
        throw new Error("Repository not configured");
      }

      await cancelWorkflow(repo, runId);
      if (config.NOTIFY_DASHBOARD_ACTIONS) {
        notify(`[dashboard] Workflow run ${sanitizeForNotification(repo)}#${runId} cancelled (from ${sanitizeForNotification(getClientIP(c))})`);
      }
      return jsonOk(c, { result: "cancelled" });
    } catch (err) {
      if (repo && runId) {
        log.error(`Failed to cancel workflow run ${repo}#${runId}: ${err}`);
      } else {
        log.error(`Failed to cancel workflow run: ${err}`);
      }
      const msg = String(err);
      if (/cannot cancel|already completed|that is completed/i.test(msg)) {
        return jsonOk(c, { error: "Workflow run has already completed" }, 400);
      }
      if (msg.includes("Repository not configured")) {
        return jsonOk(c, { error: msg }, 403);
      }
      return jsonOk(c, { error: msg }, 500);
    }
  });

  app.post("/jobs", authMiddleware, async (c) => {
    const body = await readTextBody(c);
    const params = parseFormBody(body);

    try {
      const repos = await listRepos();
      const newDisabled: Record<string, string[]> = {};
      const newEnabled: Record<string, string[]> = {};

      for (const repo of repos) {
        const disabledJobs: string[] = [];
        const enabledOptInJobs: string[] = [];
        for (const job of REPO_JOB_NAMES) {
          const fieldName = `${repo.fullName}::${job}`;
          const checked = params[fieldName] === "true";
          if (OPT_IN_JOB_NAMES.has(job)) {
            if (checked) enabledOptInJobs.push(job);
          } else {
            if (!checked) disabledJobs.push(job);
          }
        }
        if (disabledJobs.length > 0) {
          newDisabled[repo.fullName] = disabledJobs;
        }
        if (enabledOptInJobs.length > 0) {
          newEnabled[repo.fullName] = enabledOptInJobs;
        }
      }

      const existingDisabled = config.DISABLED_JOBS_BY_REPO;
      for (const [repoFullName, jobs] of Object.entries(existingDisabled)) {
        if (!repos.some((r) => r.fullName === repoFullName) && jobs.length > 0) {
          newDisabled[repoFullName] = [...jobs];
        }
      }
      const existingEnabled = config.ENABLED_JOBS_BY_REPO;
      for (const [repoFullName, jobs] of Object.entries(existingEnabled)) {
        if (!repos.some((r) => r.fullName === repoFullName) && jobs.length > 0) {
          newEnabled[repoFullName] = [...jobs];
        }
      }

      writeConfig({ disabledJobsByRepo: newDisabled, enabledJobsByRepo: newEnabled });

      if (config.NOTIFY_DASHBOARD_ACTIONS) {
        const ip = getClientIP(c);
        const totalDisabled = Object.values(newDisabled).reduce((sum, arr) => sum + arr.length, 0);
        const totalEnabled = Object.values(newEnabled).reduce((sum, arr) => sum + arr.length, 0);
        notify(`[dashboard] Job toggles updated: ${totalDisabled} disabled, ${totalEnabled} opt-in enabled (by ${sanitizeForNotification(ip)})`);
      }

      return c.redirect("/jobs?saved=1", 303);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to save job toggles: ${message}`);
      return c.redirect("/jobs", 303);
    }
  });

  app.post("/config/remove-unknown-keys", authMiddleware, (c) => {
    const unknownKeys = Array.from(getUnknownConfigKeys());
    if (unknownKeys.length > 0) {
      try {
        removeConfigKeys(unknownKeys);
        if (config.NOTIFY_DASHBOARD_ACTIONS) {
          notify(`[dashboard] Removed unknown config keys: ${unknownKeys.join(", ")} (from ${sanitizeForNotification(getClientIP(c))})`);
        }
        return c.redirect("/config?saved=1", 303);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to remove unknown keys: ${message}`);
        return c.redirect("/config", 303);
      }
    }
    return c.redirect("/config", 303);
  });

  app.post("/config", authMiddleware, async (c) => {
    const body = await readTextBody(c);
    const params = parseFormBody(body);
    const updates: Partial<ConfigFile> = {};

    if (params["githubOwners"] !== undefined) {
      updates.githubOwners = params["githubOwners"].split(",").map((s) => s.trim()).filter(Boolean);
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

    if (params["slackWebhook"] !== undefined) updates.slackWebhook = params["slackWebhook"];
    if (params["slackBotToken"] !== undefined) updates.slackBotToken = params["slackBotToken"];
    if (params["slackIdeasChannel"] !== undefined) updates.slackIdeasChannel = params["slackIdeasChannel"];
    if (params["whatsappAllowedNumbers"] !== undefined) {
      updates.whatsappAllowedNumbers = params["whatsappAllowedNumbers"].split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (params["openaiApiKey"] !== undefined) updates.openaiApiKey = params["openaiApiKey"];
    if (params["emailUser"] !== undefined) updates.emailUser = params["emailUser"];
    if (params["emailAppPassword"] !== undefined) updates.emailAppPassword = params["emailAppPassword"];
    if (params["emailRecipient"] !== undefined) updates.emailRecipient = params["emailRecipient"];

    if (params["runners"] !== undefined) {
      try {
        const parsed = JSON.parse(params["runners"]);
        if (Array.isArray(parsed)) updates.runners = parsed;
      } catch {
        // Invalid JSON — skip silently
      }
    }

    const intervalUpdates: Record<string, number> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key.startsWith("interval_")) {
        const intKey = key.slice("interval_".length);
        const v = parseInt(value, 10);
        if (v > 0) intervalUpdates[intKey] = v * 60 * 1000;
      }
    }
    if (Object.keys(intervalUpdates).length > 0) {
      updates.intervals = intervalUpdates as ConfigFile["intervals"];
    }

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

    const disabledAgents: string[] = [];
    for (const name of VALID_AGENT_NAMES) {
      if (params[`enabledAgent_${name}`] !== "true") {
        disabledAgents.push(name);
      }
    }
    updates.disabledAgents = disabledAgents;

    if (params["notifyDashboardActions"] !== undefined) {
      updates.notifyDashboardActions = params["notifyDashboardActions"] === "true";
    } else {
      updates.notifyDashboardActions = false;
    }

    const k3sEnvSet = process.env["CLAWS_K3S_MONITOR_ENABLED"] !== undefined &&
                      process.env["CLAWS_K3S_MONITOR_ENABLED"] !== "";
    if (!k3sEnvSet) {
      if (params["k3sMonitorEnabled"] !== undefined) {
        updates.k3sMonitorEnabled = params["k3sMonitorEnabled"] === "true";
      } else {
        updates.k3sMonitorEnabled = false;
      }
    }

    if (params["openrouterApiKey"] !== undefined) updates.openrouterApiKey = params["openrouterApiKey"];
    if (params["ollamaBaseUrl"] !== undefined) updates.ollamaBaseUrl = params["ollamaBaseUrl"];
    if (params["ollamaTimeoutMs"] !== undefined) {
      const v = parseInt(params["ollamaTimeoutMs"], 10);
      if (v > 0) updates.ollamaTimeoutMs = v * 1000;
    }
    if (params["ollamaConsecutiveFailuresBeforeDisable"] !== undefined) {
      const v = parseInt(params["ollamaConsecutiveFailuresBeforeDisable"], 10);
      if (v > 0) updates.ollamaConsecutiveFailuresBeforeDisable = v;
    }
    const ALL_PROVIDERS = ["claude", "codex", "opencode", "openrouter"] as const;
    type ProviderName = (typeof ALL_PROVIDERS)[number];
    for (const group of ["toolUse", "textOnly"] as const) {
      const primary = params[`${group}_primaryProvider`];
      if ((ALL_PROVIDERS as readonly string[]).includes(primary)) {
        const order: Array<ProviderName> = [primary as ProviderName];
        for (const p of ALL_PROVIDERS) {
          if (p !== primary && params[`${group}_fallback_${p}`] === "true") {
            order.push(p);
          }
        }
        if (group === "toolUse") updates.toolUseProviderFallbackOrder = order;
        else updates.textOnlyProviderFallbackOrder = order;
      }
    }
    if (params["providerRateLimitCooldownMs"] !== undefined) {
      const v = parseInt(params["providerRateLimitCooldownMs"], 10);
      if (v > 0) updates.providerRateLimitCooldownMs = v * 60 * 1000;
    }
    if (params["opencodeBestModel"] !== undefined) updates.opencodeBestModel = params["opencodeBestModel"];
    if (params["opencodeAdequateModel"] !== undefined) updates.opencodeAdequateModel = params["opencodeAdequateModel"];
    if (params["opencodeCheapModel"] !== undefined) updates.opencodeCheapModel = params["opencodeCheapModel"];
    if (params["opencodeTextBestModel"] !== undefined) updates.opencodeTextBestModel = params["opencodeTextBestModel"];
    if (params["opencodeTextAdequateModel"] !== undefined) updates.opencodeTextAdequateModel = params["opencodeTextAdequateModel"];
    if (params["opencodeTextCheapModel"] !== undefined) updates.opencodeTextCheapModel = params["opencodeTextCheapModel"];
    if (params["openrouterBestModel"] !== undefined) updates.openrouterBestModel = params["openrouterBestModel"];
    if (params["openrouterAdequateModel"] !== undefined) updates.openrouterAdequateModel = params["openrouterAdequateModel"];
    if (params["openrouterCheapModel"] !== undefined) updates.openrouterCheapModel = params["openrouterCheapModel"];
    if (params["claudeCheapModel"] !== undefined) updates.claudeCheapModel = params["claudeCheapModel"];
    if (params["codexCheapModel"] !== undefined) updates.codexCheapModel = params["codexCheapModel"];

    const oldConfig = loadConfig();

    writeConfig(updates);

    if (config.NOTIFY_DASHBOARD_ACTIONS) {
      const changedParts: string[] = [];
      for (const key of Object.keys(updates)) {
        const newVal = (updates as Record<string, unknown>)[key];
        if (SENSITIVE_KEYS.has(key) && newVal === "") continue;
        const oldVal = (oldConfig as Record<string, unknown>)[key];
        if (DEEP_MERGED_KEYS.has(key) && typeof newVal === "object" && newVal !== null && typeof oldVal === "object" && oldVal !== null) {
          const oldObj = oldVal as Record<string, unknown>;
          const newObj = newVal as Record<string, unknown>;
          for (const subKey of Object.keys(newObj)) {
            if (!isDeepStrictEqual(oldObj[subKey], newObj[subKey])) {
              changedParts.push(`${key}.${subKey} (${JSON.stringify(oldObj[subKey])} → ${JSON.stringify(newObj[subKey])})`);
            }
          }
        } else if (!isDeepStrictEqual(oldVal, newVal)) {
          if (SENSITIVE_KEYS.has(key)) {
            changedParts.push(key);
          } else {
            changedParts.push(`${key} (${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)})`);
          }
        }
      }
      if (changedParts.length > 0) {
        notify(`[dashboard] Config updated: ${changedParts.join(", ")} (from ${sanitizeForNotification(getClientIP(c))})`);
      }
    }

    return c.redirect("/config?saved=1", 303);
  });

  app.post("/whatsapp/unpair", authMiddleware, async (c) => {
    await unpair();
    if (config.NOTIFY_DASHBOARD_ACTIONS) {
      notify(`[dashboard] WhatsApp unpaired (from ${sanitizeForNotification(getClientIP(c))})`);
    }
    return c.redirect("/whatsapp", 303);
  });

  app.get("/whatsapp/events", authMiddleware, (c) => {
    try {
      const limitRaw = c.req.query("limit");
      const limit = Math.min(parseInt(limitRaw ?? "50", 10) || 50, 200);
      const events = getRecentWhatsappEvents(limit);
      return jsonOk(c, events);
    } catch (err) {
      return jsonOk(c, { error: String(err) }, 500);
    }
  });

  app.post("/sessions/create", authMiddleware, async (c) => {
    const body = await readTextBody(c);
    const params = parseFormBody(body);
    const repo = params["repo"] || null;
    const rawMode = params["mode"] || "repo-zsh";
    if (!SESSION_MODES.includes(rawMode as SessionMode)) {
      return textPlain(c, "Invalid mode", 400);
    }
    const mode = rawMode as SessionMode;
    const capabilities = validCapabilityIds(parseFormBodyMulti(body, "capability"));
    const result = await createSession(repo, mode, capabilities);
    if (!result.ok) {
      const status = result.reason === "shutting-down" ? 503
        : result.reason === "repo-required-for-mode" ? 400
        : result.reason === "repo-not-found" || result.reason === "repo-not-listed" ? 404
        : 500;
      return textPlain(c, `Cannot create session: ${describeCreateSessionError(result)}`, status);
    }
    const session = result.session;
    if (config.NOTIFY_DASHBOARD_ACTIONS) {
      notify(`[dashboard] Session created: ${session.id.slice(0, 8)} (${session.cwd}, mode=${mode}, caps=${capabilities.join(",") || "none"}) (from ${sanitizeForNotification(getClientIP(c))})`);
    }
    return c.redirect(`/sessions/${session.id}`, 303);
  });

  app.post("/sessions/create-multi", authMiddleware, async (c) => {
    const body = await readTextBody(c);
    const repos = parseFormBodyMulti(body, "repo").filter(Boolean);
    const capabilities = validCapabilityIds(parseFormBodyMulti(body, "capability"));
    const result = await createMultiWorktreeSession(repos, capabilities);
    if (!result.ok) {
      const status = result.reason === "shutting-down" ? 503
        : result.reason === "too-few-repos" ? 400
        : result.reason === "repo-not-found" || result.reason === "repo-not-listed" ? 404
        : 500;
      return textPlain(c, `Cannot create session: ${describeCreateSessionError(result)}`, status);
    }
    const session = result.session;
    if (config.NOTIFY_DASHBOARD_ACTIONS) {
      const notifyRepos = [session.repo, ...session.extraWorktrees.map(w => w.repo)].filter(Boolean).join(", ");
      notify(`[dashboard] Multi-repo session created: ${session.id.slice(0, 8)} (${notifyRepos}, caps=${capabilities.join(",") || "none"}) (from ${sanitizeForNotification(getClientIP(c))})`);
    }
    return c.redirect(`/sessions/${session.id}`, 303);
  });

  app.post("/sessions/:id/kill", authMiddleware, (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) {
      return textPlain(c, "Not found", 404);
    }
    const killed = killSession(id);
    if (!killed) {
      return textPlain(c, "Session not found", 404);
    }
    if (config.NOTIFY_DASHBOARD_ACTIONS) {
      notify(`[dashboard] Session killed: ${id.slice(0, 8)} (from ${sanitizeForNotification(getClientIP(c))})`);
    }
    return c.redirect("/sessions", 303);
  });

  app.post("/sessions/:id/resume", authMiddleware, async (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) {
      return textPlain(c, "Not found", 404);
    }
    const result = await resumeSession(id);
    if (!result.ok) {
      const status = result.reason === "shutting-down" ? 503
        : result.reason === "repo-not-found" || result.reason === "repo-not-listed" ? 404
        : 500;
      return textPlain(c, `Cannot resume session: ${describeCreateSessionError(result)}`, status);
    }
    if (config.NOTIFY_DASHBOARD_ACTIONS) {
      notify(`[dashboard] Session resumed: ${id.slice(0, 8)} (from ${sanitizeForNotification(getClientIP(c))})`);
    }
    return c.redirect(`/sessions/${id}`, 303);
  });

  app.post("/logs/:runId/cancel", authMiddleware, (c) => {
    const runId = c.req.param("runId");
    if (!getJobRun(runId)) {
      return jsonOk(c, { error: "Run not found" }, 404);
    }
    const cancelled = cancelJobRunIfRunning(runId);
    if (!cancelled) {
      return jsonOk(c, { result: "not-running" });
    }
    cancelTaskByRunId(runId);
    if (config.NOTIFY_DASHBOARD_ACTIONS) {
      notify(`[dashboard] Job run ${sanitizeForNotification(runId)} cancelled (from ${sanitizeForNotification(getClientIP(c))})`);
    }
    return jsonOk(c, { result: "cancelled" });
  });

  // ── GET routes ──

  app.get("/verify", authMiddleware, (c) => {
    const theme = getTheme(c);
    const report = loadLatestReport();
    return htmlOk(c, buildVerifyPage(report, config.ACTIVATION_STATE, theme));
  });

  app.get("/status", authMiddleware, (c) => {
    const uptimeMs = Date.now() - new Date(startedAt).getTime();
    const jobs: Record<string, boolean> = {};
    for (const [name, running] of scheduler.jobStates()) {
      jobs[name] = running;
    }
    const ws = worker.workerStatus();
    const cq = { pending: ws.queued, active: ws.running };
    const runningTasks = getRunningTasks().map((t) => ({
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
    const totalQueueItems = getQueueSnapshot(ALL_QUEUE_CATEGORIES).items.length;
    let queueCategoryCounts: Record<string, number> | undefined;
    let latestRunStatuses: Record<string, string> | undefined;
    if (c.req.query("topology") !== undefined) {
      const topoSnapshot = getQueueSnapshot(TOPOLOGY_CATEGORIES);
      queueCategoryCounts = {};
      for (const item of topoSnapshot.items) {
        queueCategoryCounts[item.category] = (queueCategoryCounts[item.category] ?? 0) + 1;
      }
      latestRunStatuses = {};
      for (const [name, info] of latestRuns) {
        latestRunStatuses[name] = info.status;
      }
    }

    return jsonOk(c, {
      status: "ok",
      startedAt,
      uptime: Math.floor(uptimeMs / 1000),
      jobs,
      pausedJobs: [...pausedSet],
      claudeQueue: { pending: cq.pending, active: cq.active },
      runningTasks,
      jobSchedules,
      queueDepth: totalQueueItems,
      ...(latestRunStatuses ? { latestRunStatuses } : {}),
      ...(queueCategoryCounts ? { queueCategoryCounts } : {}),
      slack: slackStatus(),
      slackBot: { configured: isSlackBotConfigured() },
      whatsapp: WHATSAPP_ENABLED ? whatsappStatus() : { configured: false, connected: false, pairingRequired: false },
      email: config.EMAIL_ENABLED
        ? emailMonitor.getEmailStatus()
        : { configured: false, lastCheck: null, lastError: null },
      homeAssistant: getHomeAssistantStatus(),
      k3s: (() => { const s = getK3sIntegrationStatus(); return { ...s, label: k8sIntegrationLabel(s) }; })(),
      prodK8s: (() => { const s = getProdK8sIntegrationStatus(); return { ...s, label: k8sIntegrationLabel(s) }; })(),
    });
  });

  app.get("/", authMiddleware, (c) => {
    const theme = getTheme(c);
    const uptimeMs = Date.now() - new Date(startedAt).getTime();
    const jobs: Record<string, boolean> = {};
    for (const [name, running] of scheduler.jobStates()) {
      jobs[name] = running;
    }
    const runningTasks = getRunningTasks().map((t) => ({
      jobName: t.job_name,
      repo: t.repo,
      itemNumber: t.item_number,
      startedAt: t.started_at,
    }));
    const latestRuns = getLatestRunIdsByJob();
    const paused = scheduler.pausedJobs();
    const schedInfo = scheduler.jobScheduleInfo();
    const dashQueueDepth = getQueueSnapshot(ALL_QUEUE_CATEGORIES).items.length;
    const dashSnapshots = getQueueSnapshots(24);
    const dbLastUsed = getLastUsedByProvider();
    function aiProviderStatus(provider: "claude" | "codex" | "opencode" | "openrouter", configured: boolean) {
      const isToolUsePrimary = config.TOOL_USE_PROVIDER_FALLBACK_ORDER[0] === provider;
      const isTextOnlyPrimary = config.TEXT_ONLY_PROVIDER_FALLBACK_ORDER[0] === provider;
      const rl = isProviderRateLimited(provider);
      const memLastUsed = getProviderLastUsedAt(provider);
      const dbLast = dbLastUsed[provider] ?? null;
      const lastUsedAt = memLastUsed
        ? new Date(memLastUsed).toISOString()
        : dbLast;
      return { configured, rateLimited: rl, lastUsedAt, isPrimary: isToolUsePrimary || isTextOnlyPrimary, isToolUsePrimary, isTextOnlyPrimary };
    }
    const clawsKeyConfigured = !!config.OPENROUTER_API_KEY;
    const opencodeCliAvailable = isOpenCodeBinaryAvailable();
    const opencodeStatus = {
      ...aiProviderStatus("opencode", clawsKeyConfigured || opencodeCliAvailable),
      clawsKeyConfigured,
      opencodeCliAvailable,
    };
    const openrouterStatus = aiProviderStatus("openrouter", clawsKeyConfigured);
    const aiProviders = {
      anthropic: aiProviderStatus("claude", true),
      openai: aiProviderStatus("codex", true),
      opencode: opencodeStatus,
      openrouter: openrouterStatus,
    };

    const ws = worker.workerStatus();
    const html = buildStatusPage(
      VERSION,
      Math.floor(uptimeMs / 1000),
      jobs,
      { pending: ws.queued, active: ws.running },
      slackStatus(),
      { configured: isSlackBotConfigured() },
      WHATSAPP_ENABLED ? whatsappStatus() : { configured: false, connected: false, pairingRequired: false },
      config.EMAIL_ENABLED
        ? emailMonitor.getEmailStatus()
        : { configured: false, lastCheck: null, lastError: null },
      getHomeAssistantStatus(),
      runningTasks,
      latestRuns,
      theme,
      startedAt,
      paused,
      schedInfo,
      dashQueueDepth,
      dashSnapshots,
      aiProviders,
      getK3sIntegrationStatus(),
      getProdK8sIntegrationStatus(),
    );
    return htmlOk(c, html);
  });

  app.get("/topology", authMiddleware, (c) => {
    const theme = getTheme(c);
    const jobs: Record<string, boolean> = {};
    for (const [name, running] of scheduler.jobStates()) {
      jobs[name] = running;
    }
    const runningTasks = getRunningTasks().map((t) => ({
      jobName: t.job_name,
      repo: t.repo,
      itemNumber: t.item_number,
      startedAt: t.started_at,
    }));
    const latestRuns = getLatestRunIdsByJob();
    const pausedSet = scheduler.pausedJobs();
    const ws = worker.workerStatus();
    const cq = { pending: ws.queued, active: ws.running };
    const snapshot = getQueueSnapshot(TOPOLOGY_CATEGORIES);
    const categoryCounts: Record<string, number> = {};
    for (const item of snapshot.items) {
      categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;
    }
    const html = buildTopologyPage(jobs, runningTasks, latestRuns, pausedSet, cq, categoryCounts, theme);
    return htmlOk(c, html);
  });

  app.get("/ha-upgrader", authMiddleware, (c) => {
    const theme = getTheme(c);
    const rows = getAllHaUpgraderStates();
    const html = buildHaUpgraderPage(rows, theme);
    return htmlOk(c, html);
  });

  app.get("/k8s", authMiddleware, (c) => {
    const theme = getTheme(c);
    const clusters: K8sClusterView[] = [];
    for (const status of [getK3sIntegrationStatus(), getProdK8sIntegrationStatus()]) {
      const label = status.logPrefix === "k3s-monitor" ? "k3s" : "Prod k8s";
      const recentRuns = getRecentJobRuns(10, status.logPrefix).map((r) => ({
        runId: r.run_id, status: r.status, startedAt: r.started_at, completedAt: r.completed_at,
      }));
      const alertsUrl = `https://github.com/${status.repo}/issues?q=is%3Aissue+is%3Aopen+label%3A%22${encodeURIComponent(LABELS.priority)}%22`;
      clusters.push({ label, status, recentRuns, alertsUrl });
    }
    const html = buildK8sPage(clusters, theme);
    return htmlOk(c, html);
  });

  app.get("/jobs", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const repos = await listRepos();
    repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
    const saved = c.req.query("saved") === "1";
    const html = buildJobsMatrixPage(repos, config.DISABLED_JOBS_BY_REPO, config.ENABLED_JOBS_BY_REPO, saved, theme);
    return htmlOk(c, html);
  });

  app.get("/repos", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const activityMap = getLastTaskTimePerRepo();
    const repos = await listRepos();
    repos.sort((a, b) => {
      const ta = activityMap.get(a.fullName);
      const tb = activityMap.get(b.fullName);
      if (!ta && !tb) return a.fullName.localeCompare(b.fullName);
      if (!ta) return 1;
      if (!tb) return -1;
      return tb.localeCompare(ta);
    });
    const reposWithActivity = repos.map((r) => ({ ...r, lastTaskAt: activityMap.get(r.fullName) }));
    const html = buildRepoListPage(reposWithActivity, theme);
    return htmlOk(c, html);
  });

  app.get("/repos/:owner/:name", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    if (!owner || !name) {
      return c.body(null, 404);
    }

    const repoWtDir = path.resolve(WORK_DIR, "worktrees", owner, name);
    if (!repoWtDir.startsWith(path.join(WORK_DIR, "worktrees") + path.sep)) {
      return c.body(null, 400);
    }

    const fullName = `${owner}/${name}`;

    const repos = await listRepos();
    if (!repos.some((r) => r.fullName === fullName)) {
      return c.body(null, 404);
    }

    const snapshot = getQueueSnapshot(ALL_QUEUE_CATEGORIES);
    const repoQueueItems = snapshot.items.filter((item) => item.repo === fullName);

    const [recentTasks, dailyStats, prs, alerts, openIssues] = await Promise.all([
      Promise.resolve(getRecentTasksForRepo(fullName, 20)),
      Promise.resolve(getDailyTaskStats(fullName, 30)),
      listPRs(fullName).catch(() => []),
      listIssuesByLabel(fullName, "claws-error").catch(() => []),
      listOpenIssues(fullName).catch(() => []),
      enrichQueueItemsWithPRStatus(repoQueueItems),
    ]);

    let worktrees: string[] = [];
    try {
      const namespaces = await fs.promises.readdir(repoWtDir, { withFileTypes: true });
      for (const ns of namespaces) {
        if (!ns.isDirectory()) continue;
        const branches = await fs.promises.readdir(path.join(repoWtDir, ns.name));
        for (const branch of branches) {
          worktrees.push(`${ns.name}/${branch}`);
        }
      }
    } catch {
      // ENOENT or permission error — no worktrees for this repo
    }

    const html = buildRepoPage({
      owner,
      name,
      queueItems: repoQueueItems,
      recentTasks,
      dailyStats,
      worktrees,
      openPRs: prs,
      alertIssues: alerts,
      openIssues,
    }, theme);
    return htmlOk(c, html);
  });

  app.get("/whatsapp", authMiddleware, (c) => {
    const theme = getTheme(c);
    return htmlOk(c, buildWhatsAppPage(theme));
  });

  app.get("/whatsapp/pair", authMiddleware, (c) => {
    if (isPairing()) {
      cancelPairing();
    }
    return streamSSE(c, async (stream) => {
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => { resolveDone = r; });
      const listener = (event: import("./whatsapp.js").PairingEvent) => {
        void stream.writeSSE({ data: JSON.stringify(event) });
        if (event.type === "connected") {
          if (config.NOTIFY_DASHBOARD_ACTIONS) {
            notify(`[dashboard] WhatsApp paired (from ${sanitizeForNotification(getClientIP(c))})`);
          }
          resolveDone();
        } else if (event.type === "error" || event.type === "timeout") {
          resolveDone();
        }
      };
      stream.onAbort(() => {
        stopPairing();
        resolveDone();
      });
      startPairing(listener).catch((err) => {
        void stream.writeSSE({ data: JSON.stringify({ type: "error", message: String(err) }) });
        resolveDone();
      });
      await done;
    });
  });

  // ── Session routes (GET) ──
  // Register specific routes first so they don't collide with /sessions/:id.

  app.get("/sessions", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const repos = await listRepos().catch(() => []);
    const activityMap = getLastTaskTimePerRepo();
    repos.sort((a, b) => {
      const ta = activityMap.get(a.fullName);
      const tb = activityMap.get(b.fullName);
      if (!ta && !tb) return a.fullName.localeCompare(b.fullName);
      if (!ta) return 1;
      if (!tb) return -1;
      return tb.localeCompare(ta);
    });
    const defaultRepo = repos[0]?.fullName ?? null;
    const html = buildSessionsListPage(theme, listSessions(), repos, defaultRepo);
    return htmlOk(c, html);
  });

  // WebSocket route for /sessions/:id/ws — register BEFORE /sessions/:id to win match order.
  // Auth note: the WS upgrade runs through `authMiddleware`. Under OIDC it requires a valid
  // `claws_session` cookie; with OIDC unconfigured the upgrade is denied (503), consistent with
  // all other authenticated routes.
  app.get(
    "/sessions/:id/ws",
    authMiddleware,
    // Validate session before the WebSocket handshake so the client gets HTTP 404 (not a
    // post-handshake close(1008)) when the session ID is unknown.
    (c, next) => {
      const id = c.req.param("id") ?? "";
      if (!/^[a-f0-9]+$/.test(id) || !getSession(id)) return c.body(null, 404);
      return next();
    },
    upgradeWebSocket((c) => {
      const session = getSession(c.req.param("id") ?? "")!;
      return {
        onOpen(_evt, ws) {
          if (ws.raw) handleSessionWs(ws.raw, session);
        },
      };
    }),
  );

  app.get("/sessions/:id", authMiddleware, (c) => {
    const theme = getTheme(c);
    const id = c.req.param("id");
    if (!/^[a-f0-9]+$/.test(id)) {
      return c.body(null, 404);
    }
    const session = getSession(id);
    if (!session) {
      return textPlain(c, "Session not found", 404);
    }
    const html = buildSessionTerminalPage(theme, {
      id: session.id,
      repo: session.repo,
      cwd: session.cwd,
      alive: session.alive,
    });
    return htmlOk(c, html);
  });

  app.get("/config", authMiddleware, (c) => {
    const theme = getTheme(c);
    const saved = c.req.query("saved") === "1";
    return htmlOk(c, buildConfigPage(saved, theme));
  });

  app.get("/config/api", authMiddleware, (c) => {
    return jsonOk(c, getConfigForDisplay());
  });

  // /logs/issue must come BEFORE /logs/:runId so it isn't captured as a runId.
  app.get("/logs/issue", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const repoParam = c.req.query("repo");
    const numberParam = c.req.query("number");
    const num = parseInt(numberParam ?? "", 10);
    if (!repoParam || !numberParam || !Number.isFinite(num) || num < 1) {
      return textPlain(c, "Missing or invalid repo/number query params", 400);
    }
    const repos = await listRepos();
    if (!repos.some((r) => r.fullName === repoParam)) {
      return c.body(null, 404);
    }
    const runs = getRunsForIssue(repoParam, num);
    const runIds = runs.map((r) => r.run_id);
    const logsByRun = getLogsForRuns(runIds);
    const workItems = getWorkItemsForRuns(runIds);
    const html = buildIssueLogsPage(repoParam, num, runs, logsByRun, workItems, theme);
    return htmlOk(c, html);
  });

  app.get("/logs/:runId/tail", authMiddleware, (c) => {
    const runId = c.req.param("runId");
    const afterId = parseInt(c.req.query("after") ?? "0", 10) || 0;
    const run = getJobRun(runId);
    if (!run) {
      return jsonOk(c, { error: "Run not found" }, 404);
    }
    const logs = getJobRunLogsSince(runId, afterId);
    const tasks = run.status !== "running" ? getTasksByRunId(runId) : undefined;
    const outcomeCards = tasks?.map((t) => {
      const outcome = parseOutcome(t);
      const html = outcome ? renderOutcomeCard(outcome, t.status) : "";
      return { repo: t.repo, item_number: t.item_number, html };
    }).filter((cd) => cd.html);
    return jsonOk(c, {
      status: run.status,
      completed_at: run.completed_at,
      logs: logs.map((l) => ({ id: l.id, level: l.level, message: l.message, logged_at: l.logged_at })),
      taskCount: tasks?.length,
      outcomeCards,
    });
  });

  app.get("/logs", authMiddleware, (c) => {
    const theme = getTheme(c);
    const jobFilter = c.req.query("job") ?? null;
    const search = c.req.query("search") ?? undefined;
    const runs = search
      ? searchRunsByItem(search)
      : getRecentJobRuns(50, jobFilter ?? undefined);
    const jobNames = getDistinctJobNames();
    const workItems = getWorkItemsForRuns(runs.map((r) => r.run_id));
    const recentItems = search ? [] : getRecentWorkItems();
    const html = buildLogsListPage(runs, jobNames, jobFilter, theme, workItems, search, recentItems);
    return htmlOk(c, html);
  });

  app.get("/logs/:runId", authMiddleware, (c) => {
    const theme = getTheme(c);
    const runId = c.req.param("runId");
    const run = getJobRun(runId);
    if (!run) {
      return textPlain(c, "Run not found", 404);
    }
    const logs = getJobRunLogs(runId);
    const tasks = getTasksByRunId(runId);
    const html = buildLogDetailPage(run, logs, theme, tasks);
    return htmlOk(c, html);
  });

  app.get("/queue", authMiddleware, async (c) => {
    const theme = getTheme(c);
    const myAttention = getQueueSnapshot(MY_ATTENTION_CATEGORIES);
    const clawsAttention = getQueueSnapshot(CLAWS_ATTENTION_CATEGORIES);
    await Promise.all([
      enrichQueueItemsWithPRStatus(myAttention.items),
      enrichQueueItemsWithPRStatus(clawsAttention.items),
    ]);

    const queueRunningTasks = getRunningTasks();
    const queuedRows: WorkQueueRow[] = listQueuedWork();
    const claudeEntries = queuedRows
      .filter((r) => r.status === "queued")
      .map((r, i) => ({
        position: i + 1,
        priority: r.priority === 1,
        meta: { repo: r.repo, itemNumber: r.item_number, jobName: r.kind },
      }));
    const queueSchedInfo = scheduler.jobScheduleInfo();
    const queuePaused = scheduler.pausedJobs();
    const queueLatestRuns = getLatestRunIdsByJob();
    const jobNextRun: Record<string, number | null> = {};
    for (const [name] of scheduler.jobStates()) {
      const sched = queueSchedInfo.get(name);
      if (!sched || queuePaused.has(name)) { jobNextRun[name] = null; continue; }
      if (sched.scheduledHour !== undefined) {
        jobNextRun[name] = msUntilHour(sched.scheduledHour);
      } else {
        const latest = queueLatestRuns.get(name);
        jobNextRun[name] = latest?.startedAt
          ? Math.max(0, new Date(latest.startedAt + "Z").getTime() + sched.intervalMs - Date.now())
          : sched.intervalMs;
      }
    }
    const avgDurations = getAllAverageTaskDurations();

    const allQueueItems = [...myAttention.items, ...clawsAttention.items];
    const problematicItems = allQueueItems.filter((i) => i.category === "problematic");

    const html = buildQueuePage(
      myAttention,
      clawsAttention,
      theme,
      config.SKIPPED_ITEMS as Array<{ repo: string; number: number }>,
      problematicItems.map((i) => ({ repo: i.repo, number: i.number, markedAt: "", reason: "", attemptCount: 0 })),
      {
        runningTasks: queueRunningTasks,
        claudeEntries,
        jobNextRun,
        avgDurations,
      },
    );
    return htmlOk(c, html);
  });

  app.get("/runners", authMiddleware, (c) => {
    const theme = getTheme(c);
    const activeRuns = getActiveWorkflowRuns();
    const stats = getWorkflowRunStats(7);
    const lastSyncedAt = getLastWorkflowRunSync();
    const html = buildRunnersPage({ activeRuns, stats, lastSyncedAt }, theme);
    return htmlOk(c, html);
  });

  app.get("/usage", authMiddleware, (c) => {
    const theme = getTheme(c);
    const daysParam = parseInt(c.req.query("days") ?? "7", 10);
    const days = [1, 7, 30].includes(daysParam) ? daysParam : 7;
    const stats = getUsageStats(days);
    const totals = getTotalUsage(days);
    const html = buildUsagePage({ stats, totals, days }, theme);
    return htmlOk(c, html);
  });
}
