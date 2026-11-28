import http from "node:http";
import crypto from "node:crypto";
import { Hono } from "hono";
import { matchedRoutes } from "hono/route";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import type { ControllerClient } from "./controller-client.js";
import { SERVER_PORT, BIND_HOST } from "./config.js";
import * as config from "./config.js";
import * as log from "./log.js";
import { withRequestId } from "./log-core.js";
import { httpRequestFinished, httpRequestStarted, markListening, observeHttpRequest, readRolloutGap, routeLabel } from "./metrics.js";
import { grafanaAuthMode } from "./grafana-auth.js";
import { ensureSigningKey } from "./grafana-jwt.js";
import { getSessionBackend } from "./session-backend.js";
import { setPageControllerHeartbeat } from "./pages/layout.js";
import { UPLOAD_REQUEST_TIMEOUT_MS } from "./session-uploads-core.js";
import { isShuttingDown } from "./shutdown.js";
import { type Env, htmlError, jsonOk } from "./server/http.js";
import { PROXY_HEADERS_TIMEOUT_MS } from "./server/proxy.js";
import { pingHomeAssistant, probeGrafanaClusters } from "./server/shared.js";
import type { RouteContext } from "./server/routes/context.js";
import { registerPublicRoutes } from "./server/routes/public.js";
import { registerApiRoutes } from "./server/routes/api.js";
import { registerSessionIssueRoutes } from "./server/routes/session-issues.js";
import { registerSessionPrRoutes } from "./server/routes/session-prs.js";
import { registerAgentApiRoutes } from "./server/routes/agent-api.js";
import { registerAccountRoutes } from "./server/routes/accounts.js";
import { registerQueueRoutes } from "./server/routes/queue.js";
import { registerSessionWriteRoutes } from "./server/routes/session-writes.js";
import { registerPageRoutes } from "./server/routes/pages.js";
import { registerBoardRoutes } from "./server/routes/board.js";
import { registerIssueRoutes } from "./server/routes/issues.js";
import { registerSessionRoutes } from "./server/routes/sessions.js";

// Re-export for backwards compatibility with tests and other consumers
export { formatUptime } from "./pages/layout.js";
export type { Theme } from "./pages/layout.js";
export { buildLogDetailPage, buildIssueLogsPage } from "./pages/logs.js";
export { OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_MS, SESSION_SSH_SIGN_MIN_INTERVAL_MS, oauthStateCookieName, resetSessionSshSignRateLimitForTests, signOAuthState, verifyOAuthState } from "./server/auth.js";
export type { OAuthStateEntry } from "./server/auth.js";
export { COMPLETION_PROXIED_ROUTE, COMPLETION_PROXY_HEADERS_TIMEOUT_MS, CONTROLLER_PROXIED_ROUTES, CONTROLLER_RESTARTING_MESSAGE, PROXY_HEADERS_TIMEOUT_MS } from "./server/proxy.js";
export { loadPRRowStatuses, warmDashboardCaches } from "./server/shared.js";

// ── Server ──

/** How long a page render reuses the controller heartbeat it last read. */
const PAGE_HEARTBEAT_TTL_MS = 5_000;

export interface CreateServerOptions {
  /** Defaults to `CLAWS_ROLE`. */
  role?: config.ClawsRole;
  /** Defaults to `CLAWS_CONTROLLER_URL`; used only when `role` is `web`. */
  controllerUrl?: string;
  /** Defaults to {@link PROXY_HEADERS_TIMEOUT_MS}; tests shorten it. */
  proxyHeadersTimeoutMs?: number;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** The `ws` server behind each {@link createServer} result, for {@link webSocketServerFor}. */
const webSocketServers = new WeakMap<http.Server, WebSocketServer>();

/**
 * The `WebSocketServer` that `createServer` built for `server`, whose
 * `clients` are exactly its open (session terminal) WebSockets, so a drain
 * can cut them at once without adding an `"upgrade"` listener.
 */
export function webSocketServerFor(server: http.Server): WebSocketServer | undefined {
  return webSocketServers.get(server);
}

export function createServer(controller: ControllerClient, opts: CreateServerOptions = {}): http.Server {
  const app = new Hono<Env>();
  const role = opts.role ?? config.CLAWS_ROLE;
  const controllerUrl = (opts.controllerUrl ?? config.CLAWS_CONTROLLER_URL).replace(/\/+$/, "");
  const proxyHeadersTimeoutMs = opts.proxyHeadersTimeoutMs ?? PROXY_HEADERS_TIMEOUT_MS;

  // Request id for log correlation (docs/observability.md): a well-formed
  // incoming X-Request-Id is kept, anything else gets a fresh UUID. Every log
  // line under this request carries it as `request_id`, and it is echoed back.
  app.use("*", async (c, next) => {
    const incoming = c.req.header("X-Request-Id");
    const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
    c.header("X-Request-Id", requestId);
    await withRequestId(requestId, () => next());
  });

  // Once this process is shutting down, every response tells the client to
  // drop the connection, so its next request (a retried claws_wait_for_change
  // after `interrupted`) opens a new one that reaches a live process instead
  // of this one (#clw_01M7TVF8T4C9145EFPT5KVPHZM).
  app.use("*", async (c, next) => {
    await next();
    if (isShuttingDown()) c.header("Connection", "close");
  });

  // Per-route latency for docs/metrics.md. Registered before every route so it
  // wraps them all; the label is the matched route pattern, never the raw path.
  app.use("*", async (c, next) => {
    const start = performance.now();
    httpRequestStarted();
    try {
      await next();
    } finally {
      httpRequestFinished();
      observeHttpRequest(routeLabel(matchedRoutes(c)), c.req.method, c.res.status, performance.now() - start);
    }
  });

  // Every page renders the "background processing is restarting" banner from
  // the controller's heartbeat (pages/layout.ts), re-read at most every 5 s.
  let heartbeatReadAt = 0;
  let heartbeatRead: Promise<void> | null = null;
  const refreshPageHeartbeat = (): Promise<void> => {
    if (Date.now() - heartbeatReadAt < PAGE_HEARTBEAT_TTL_MS) return Promise.resolve();
    heartbeatRead ??= controller.heartbeat()
      .then((hb) => setPageControllerHeartbeat(hb), () => { /* keep the last one */ })
      .finally(() => {
        heartbeatReadAt = Date.now();
        heartbeatRead = null;
      });
    return heartbeatRead;
  };
  app.use("*", async (c, next) => {
    const p = c.req.path;
    if (c.req.method === "GET" && p !== "/health" && !p.startsWith("/api/") && !p.startsWith("/static/")) await refreshPageHeartbeat();
    await next();
  });

  registerRoutes(app, controller, { role, controllerUrl, proxyHeadersTimeoutMs });

  // ── Default 404 / 405 ──
  // Preserve legacy behavior: the original handleRequest returned 405 for any
  // non-GET that didn't match a POST handler, and 404 for unmatched GETs.
  app.notFound((c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    if (c.req.path.startsWith("/api/")) return jsonOk(c, { error: "Not found" }, 404);
    return htmlError(c, 404, "Page not found", "That URL doesn't match anything on this dashboard.", {
      detail: c.req.path,
      actions: [{ href: "/", label: "← Dashboard" }],
    });
  });

  app.onError((err, c) => {
    log.error("HTTP handler error", err, { component: "http", http_method: c.req.method, http_path: c.req.path });
    c.header("Content-Type", "text/plain");
    return c.body("Internal Server Error", 500);
  });

  const wss = new WebSocketServer({ noServer: true });
  const server = serve(
    { fetch: app.fetch, port: SERVER_PORT, hostname: BIND_HOST, websocket: { server: wss } },
    (info) => {
      log.info(`HTTP server listening on ${info.address}:${info.port}`);
      const listeningAt = Date.now();
      markListening(listeningAt);
      readRolloutGap(listeningAt);
    },
  ) as http.Server;
  webSocketServers.set(server, wss);

  // A 1 GB session upload can legitimately take far longer than Node's 300 s
  // default request timeout; headersTimeout stays at its default.
  server.requestTimeout = UPLOAD_REQUEST_TIMEOUT_MS;

  pingHomeAssistant().catch(() => {});
  const haInterval = setInterval(() => { pingHomeAssistant().catch(() => {}); }, 5 * 60 * 1000);
  haInterval.unref();
  server.on("close", () => { clearInterval(haInterval); });

  log.info("Grafana sign-in mode chosen", { component: "grafana-auth", authMode: grafanaAuthMode() });
  ensureSigningKey()
    .catch((err) => log.warn(`[grafana-auth] could not store the JWT signing key: ${err instanceof Error ? err.message : String(err)}`))
    .then(() => probeGrafanaClusters())
    .catch(() => {});
  const grafanaAuthInterval = setInterval(() => { probeGrafanaClusters().catch(() => {}); }, 15 * 60 * 1000);
  grafanaAuthInterval.unref();
  server.on("close", () => { clearInterval(grafanaAuthInterval); });

  server.on("close", () => {
    getSessionBackend().shutdown().catch((err) => log.error(`Session backend shutdown on close: ${err}`));
  });

  return server;
}

function registerRoutes(
  app: Hono<Env>,
  controller: ControllerClient,
  { role, controllerUrl, proxyHeadersTimeoutMs }: { role: config.ClawsRole; controllerUrl: string; proxyHeadersTimeoutMs: number },
): void {
  const ctx: RouteContext = { controller, role, controllerUrl, proxyHeadersTimeoutMs };
  registerPublicRoutes(app, ctx);

  registerApiRoutes(app, ctx);

  registerSessionIssueRoutes(app, ctx);

  registerSessionPrRoutes(app, ctx);

  registerAgentApiRoutes(app, ctx);

  registerAccountRoutes(app, ctx);

  registerQueueRoutes(app, ctx);

  registerSessionWriteRoutes(app, ctx);

  registerPageRoutes(app, ctx);

  registerBoardRoutes(app, ctx);

  registerIssueRoutes(app, ctx);

  registerSessionRoutes(app, ctx);
}
