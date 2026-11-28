/** Public dashboard routes (no auth): health, the Forgejo webhook, node evacuation, static assets, JWKS, pages auth, the Home Assistant, Datasette and mailbox read proxies, icons, login and logout. Moved out of `registerRoutes` (src/server.ts) unchanged. */
import crypto from "node:crypto";
import path from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { canonicalNode } from "../../node-names.js";
import { DEFAULT_IDLE_DEADLINE_SECONDS, endEvacuation, evacuationStatus, homeSessionNode, startEvacuation } from "../../session-move.js";
import { machineActionEnabled, machineMayDo, verifyMachineToken } from "../../machine-auth.js";
import type { WorkerStatus } from "../../controller-client.js";
import * as config from "../../config.js";
import { getCommitCheckStatus } from "../../forgejo.js";
import { verifyForgejoSignature, handleForgejoDelivery, findOpenPrForHead } from "../../forgejo-webhook.js";
import * as log from "../../log.js";
import { VERSION } from "../../version.js";
import { PAGES_LOGIN_PATH, PAGES_READ_COOKIE, pagesHostname, verifyPagesReadToken } from "../../pages-read-token.js";
import { HA_READ_ROUTE_PREFIX, verifyHaReadToken } from "../../ha-read-token.js";
import { isAllowedHaReadPath, proxyHaRead } from "../../ha-read-proxy.js";
import { DATASETTE_ROUTE_PREFIX, verifyDatasetteToken } from "../../datasette-token.js";
import { checkDatasettePath, proxyDatasetteRead } from "../../datasette-proxy.js";
import { MAIL_READ_ROUTE_PREFIX, verifyMailReadToken } from "../../mail-read-token.js";
import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  type MailReadResult,
  getAttachment,
  getMessage,
  isMailReadConfigured,
  isValidMailFolder,
  listFolders,
  listMessages,
  parseMailIndex,
  parseMailUid,
} from "../../mail-read-proxy.js";
import { jwks } from "../../grafana-jwt.js";
import { setSessionNodeCapacitySource } from "../../session-backend-k8s.js";
import { ALPINE_JS_SOURCE } from "../../resources/alpinejs.js";
import { CHARTJS_SOURCE } from "../../resources/chartjs.js";
import { TAILWIND_CSS_SOURCE } from "../../resources/tailwind-css.generated.js";
import { WEB_MANIFEST, getAppIconPng } from "../../pwa.js";
import { isShuttingDown, shutdownElapsedMs } from "../../shutdown.js";
import { type Ctx, type Env, htmlOk, jsonOk, textPlain } from "../http.js";
import { OAUTH_STATE_TTL_MS, authMiddleware, isOidcEnabled, oauthStateCookie, oauthStateCookieName, parseCookies, requestHostname, resolveOidcTarget, signOAuthState, signSession, verifyOAuthState, verifySession } from "../auth.js";
import { COMPLETION_PROXIED_ROUTE, COMPLETION_PROXY_HEADERS, COMPLETION_PROXY_HEADERS_TIMEOUT_MS, CONTROLLER_PROXIED_ROUTES, completionBodyLimit, proxyToController } from "../proxy.js";
import { MAX_FORGEJO_WEBHOOK_BYTES, forgejoSelfLogins, isManagedForgejoRepo } from "../shared.js";
import type { RouteContext } from "./context.js";

const ALPINE_JS_ETAG = `"${crypto.createHash("sha256").update(ALPINE_JS_SOURCE).digest("hex").slice(0, 16)}"`;
const CHARTJS_ETAG = `"${crypto.createHash("sha256").update(CHARTJS_SOURCE).digest("hex").slice(0, 16)}"`;
const TAILWIND_CSS_ETAG = `"${crypto.createHash("sha256").update(TAILWIND_CSS_SOURCE).digest("hex").slice(0, 16)}"`;

/** Longest `GET /health` waits for the controller heartbeat before reporting it as null. */
const HEALTH_HEARTBEAT_TIMEOUT_MS = 1_000;

export function registerPublicRoutes(app: Hono<Env>, ctx: RouteContext): void {
  const { controller, role, controllerUrl, proxyHeadersTimeoutMs } = ctx;
  // ── Public routes (no auth) ──

  // 200 whether or not the controller is alive: the web tier's readiness must
  // never follow the controller's restarts — nor a stalled database read, so
  // the heartbeat read is bounded and falls back to null.
  app.get("/health", async (c) => {
    c.header("Cache-Control", "no-store");
    let timer: NodeJS.Timeout | undefined;
    const heartbeat = await Promise.race([
      controller.heartbeat().catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HEALTH_HEARTBEAT_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    return jsonOk(c, { status: "ok", role, version: VERSION, shuttingDown: isShuttingDown(), shutdownElapsedMs: shutdownElapsedMs(), controller: heartbeat });
  });

  // Signed Forgejo deliveries (src/forgejo-webhook.ts). No session auth: the
  // HMAC signature is the authentication, and with no secret the route is off.
  app.post(
    "/webhooks/forgejo",
    bodyLimit({
      maxSize: MAX_FORGEJO_WEBHOOK_BYTES,
      onError: (c) => jsonOk(c, { error: "Payload too large" }, 413),
    }),
    async (c) => {
      const secret = config.FORGEJO_WEBHOOK_SECRET?.trim();
      if (!secret) return jsonOk(c, { error: "Not found" }, 404);
      const raw = await c.req.text();
      if (!verifyForgejoSignature(raw, c.req.header("x-forgejo-signature"), secret)) {
        return jsonOk(c, { error: "Invalid signature" }, 401);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return jsonOk(c, { error: "Malformed JSON" }, 400);
      }
      const event = c.req.header("x-forgejo-event")?.trim();
      if (!event) return jsonOk(c, { error: "Missing X-Forgejo-Event" }, 400);
      try {
        const { managed, recorded } = await handleForgejoDelivery(event, payload, {
          selfLogins: await forgejoSelfLogins(),
          isManagedRepo: isManagedForgejoRepo,
          findPrForHead: findOpenPrForHead,
          readCombinedStatus: getCommitCheckStatus,
        });
        return jsonOk(c, { ok: true, events: recorded }, managed ? 200 : 202);
      } catch (err) {
        // Answered 200 so Forgejo does not mark the hook failing over a mapping bug.
        log.warn(`[forgejo-webhook] Failed to handle ${event} delivery: ${err}`);
        return jsonOk(c, { ok: true, events: 0 });
      }
    },
  );

  // Node evacuation (#clw_01M7Q3P5PR480HYED9TNH6VTV9): a session node's shutdown
  // hook asks Claws to move every session stored on it to the home node, then
  // polls until `done`. No `authMiddleware`: the caller is a machine signed in to
  // Authentik as a listed service account, sending a short-lived access token
  // whose groups must hold the `node-evacuation` grant (#clw_01M7RC7NY8JM8T76FKNBVK53ND,
  // src/machine-auth.ts). Without the issuer, audience or grant (or for a node
  // outside CLAWS_SESSION_NODES) the route is off. Database only, so either tier
  // answers; the controller's move loop does the work.
  const NODE_EVACUATION_ACTION = "node-evacuation";
  const evacuationNode = async (c: Ctx): Promise<{ node: string; caller: string } | Response> => {
    // By current name, so a hook calling a renamed node by its old name addresses the same node (#clw_01M7RBFFEM2C6DQD1C3Z3EAEZ8).
    const node = canonicalNode(c.req.param("node") ?? "");
    if (!machineActionEnabled(NODE_EVACUATION_ACTION) || !config.SESSION_POD_SETTINGS.nodes.includes(node)) {
      return jsonOk(c, { error: "Not found" }, 404);
    }
    const bearer = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1]?.trim() ?? "";
    const result = await verifyMachineToken(bearer, Date.now());
    if (!result.ok) {
      log.warn("node evacuation refused", { component: "node-evacuation", method: c.req.method, node, reason: result.reason });
      return result.reason === "no-keys"
        ? jsonOk(c, { error: "Signing keys unavailable" }, 503)
        : jsonOk(c, { error: "unauthorized" }, 401);
    }
    const caller = result.caller.preferredUsername || result.caller.sub;
    if (!machineMayDo(NODE_EVACUATION_ACTION, result.caller.groups)) {
      log.warn("node evacuation refused", {
        component: "node-evacuation", method: c.req.method, node, reason: "forbidden", caller, caller_sub: result.caller.sub,
      });
      return jsonOk(c, { error: "forbidden" }, 403);
    }
    return { node, caller };
  };
  app.post("/api/nodes/:node/evacuation", async (c) => {
    const target = await evacuationNode(c);
    if (target instanceof Response) return target;
    if (target.node === homeSessionNode(config.SESSION_POD_SETTINGS.nodes)) {
      return jsonOk(c, { error: "The home session node cannot be evacuated: sessions are moved to it" }, 400);
    }
    let body: { reason?: unknown; idleDeadlineSeconds?: unknown } = {};
    const raw = await c.req.text();
    if (raw.trim()) {
      try { body = JSON.parse(raw) as typeof body; } catch { return jsonOk(c, { error: "Invalid JSON body" }, 400); }
    }
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 200) : "node shutdown";
    const idle = typeof body.idleDeadlineSeconds === "number" && Number.isFinite(body.idleDeadlineSeconds) ? body.idleDeadlineSeconds : DEFAULT_IDLE_DEADLINE_SECONDS;
    await startEvacuation(target.node, reason, idle, Date.now());
    log.info("node evacuation started", { component: "node-evacuation", node: target.node, caller: target.caller, reason, idle_deadline_seconds: idle });
    return jsonOk(c, await evacuationStatus(target.node, config.SESSION_POD_SETTINGS.nodes), 202);
  });
  app.get("/api/nodes/:node/evacuation", async (c) => {
    const target = await evacuationNode(c);
    if (target instanceof Response) return target;
    return jsonOk(c, await evacuationStatus(target.node, config.SESSION_POD_SETTINGS.nodes));
  });
  app.delete("/api/nodes/:node/evacuation", async (c) => {
    const target = await evacuationNode(c);
    if (target instanceof Response) return target;
    const ended = await endEvacuation(target.node);
    log.info("node evacuation cleared", { component: "node-evacuation", node: target.node, caller: target.caller, ended });
    return jsonOk(c, await evacuationStatus(target.node, config.SESSION_POD_SETTINGS.nodes));
  });

  // Registered ahead of the controller's own handlers for these paths, which
  // then never run on the web tier.
  if (role === "web") {
    // The web tier runs no node capacity monitor: its session backend reads node readiness (a
    // session on a NotReady node cannot resume) from the controller's snapshot, memoised for 10s.
    let nodeCapacityCache: { at: number; value: WorkerStatus["capacity"] } | null = null;
    setSessionNodeCapacitySource(async () => {
      const now = Date.now();
      if (nodeCapacityCache && now - nodeCapacityCache.at < 10_000) return nodeCapacityCache.value;
      let value: WorkerStatus["capacity"] = null;
      try {
        value = (await controller.workerStatus()).capacity;
      } catch { /* unreadable: every node counts as Ready */ }
      nodeCapacityCache = { at: now, value };
      return value;
    });
    for (const route of CONTROLLER_PROXIED_ROUTES) {
      app.all(route, authMiddleware, (c) => proxyToController(c, controllerUrl, proxyHeadersTimeoutMs));
    }
    // The completion run needs the controller's provider logins and rate-limit
    // breaker. No `authMiddleware`: the controller checks the caller's token.
    app.post(COMPLETION_PROXIED_ROUTE, (c, next) => {
      // No bearer token: refuse here so unauthenticated traffic never reaches the controller.
      if (!c.req.header("authorization")?.startsWith("Bearer ")) return c.json({ error: "unauthorized" }, 401);
      return next();
    }, completionBodyLimit, (c) =>
      proxyToController(c, controllerUrl, Math.max(proxyHeadersTimeoutMs, COMPLETION_PROXY_HEADERS_TIMEOUT_MS), { headers: COMPLETION_PROXY_HEADERS }));
  }

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

  app.get("/static/chart.js", (c) => {
    if (c.req.header("if-none-match") === CHARTJS_ETAG) {
      c.header("ETag", CHARTJS_ETAG);
      return c.body(null, 304);
    }
    c.header("Content-Type", "application/javascript");
    c.header("Cache-Control", "max-age=31536000, immutable");
    c.header("ETag", CHARTJS_ETAG);
    return c.body(CHARTJS_SOURCE);
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

  // Public by design: content moderation verifiers fetch it unauthenticated to
  // check Claws-signed moderation tokens (docs/jobs/content-moderator.md).
  app.get("/.well-known/claws-jwks.json", (c) => {
    c.header("Cache-Control", "max-age=300");
    return jsonOk(c, jwks());
  });

  // Public by design (#clw_01M619KBVSEV0SNRRXD33YYVQC): Traefik routes token-carrying
  // pages-host requests here instead of Authentik. Both refuse any other host so a
  // pages read token never authenticates the dashboard or another app. Never log
  // the token or the request URL: the login path carries the token.
  app.get(`${PAGES_LOGIN_PATH}/:token`, async (c) => {
    const pagesHost = pagesHostname();
    if (!pagesHost || requestHostname(c.req.header("host")) !== pagesHost) return c.text("Not found", 404);
    const token = c.req.param("token");
    if (await verifyPagesReadToken(token) !== "ok") return c.text("Unauthorized", 401);
    c.header("Set-Cookie", `${PAGES_READ_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`);
    c.header("Cache-Control", "no-store");
    return c.redirect("/", 302);
  });

  app.get("/api/pages/auth", async (c) => {
    const pagesHost = pagesHostname();
    if (!pagesHost || requestHostname(c.req.header("x-forwarded-host")) !== pagesHost) return c.body(null, 404);
    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const token = bearer ?? parseCookies(c.req.header("cookie"))[PAGES_READ_COOKIE];
    if (!token || await verifyPagesReadToken(token) !== "ok") return c.body(null, 401);
    return c.body(null, 204);
  });

  // Read-only Home Assistant proxy (#clw_01M77K5B15JHY1N6JMGRZDFQ0D): no
  // dashboard auth, the per-session Bearer token (src/ha-read-token.ts) is the
  // authentication. Registered for every method so a write is refused with 405
  // rather than falling through. Never log the token, query values or body.
  app.all(`${HA_READ_ROUTE_PREFIX}/*`, async (c) => {
    c.header("Cache-Control", "no-store");
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token || await verifyHaReadToken(token) !== "ok") return jsonOk(c, { error: "Unauthorized" }, 401);
    const url = new URL(c.req.url);
    const haPath = url.pathname.slice(HA_READ_ROUTE_PREFIX.length);
    if (c.req.method !== "GET") {
      log.warn("Home Assistant read proxy refused a request", { component: "ha-read-proxy", reason: "method", http_method: c.req.method });
      c.header("Allow", "GET");
      return jsonOk(c, { error: "Only GET is allowed: this proxy is read-only" }, 405);
    }
    if (!isAllowedHaReadPath(haPath)) {
      log.warn("Home Assistant read proxy refused a request", { component: "ha-read-proxy", reason: "path", path: haPath.slice(0, 200) });
      return jsonOk(c, { error: "Path is not on the read-only allowlist" }, 403);
    }
    const started = Date.now();
    const result = await proxyHaRead(haPath, url.search.replace(/^\?/, ""));
    if (result.kind === "forbidden") return jsonOk(c, { error: "Path is not on the read-only allowlist" }, 403);
    if (result.kind === "unconfigured") return jsonOk(c, { error: "Home Assistant is not configured" }, 503);
    if (result.kind === "upstream-error") {
      log.warn("Home Assistant read proxy upstream failed", { component: "ha-read-proxy", path: haPath, error: result.error, duration_ms: Date.now() - started });
      return jsonOk(c, { error: "Home Assistant did not respond" }, 502);
    }
    log.debug("Home Assistant read proxied", { component: "ha-read-proxy", path: haPath, status: result.status, duration_ms: Date.now() - started });
    if (result.contentType) c.header("Content-Type", result.contentType);
    if (result.status === 204 || result.status === 304) return c.body(null, result.status);
    return c.body(result.body, result.status as 200);
  });

  // Read-only Datasette proxy (#clw_01M89P9YVSQY0S29YP6KBPJAQQ): no dashboard
  // auth, the per-session Bearer token (src/datasette-token.ts) is the
  // authentication and names the databases the session holds right now.
  // Registered for every method so a write is refused with 405 rather than
  // falling through. Never log the token, query string or body.
  app.all(`${DATASETTE_ROUTE_PREFIX}/*`, async (c) => {
    c.header("Cache-Control", "no-store");
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const verified = token ? await verifyDatasetteToken(token) : null;
    if (!verified) return jsonOk(c, { error: "Unauthorized" }, 401);
    const url = new URL(c.req.url);
    const dsPath = url.pathname.slice(DATASETTE_ROUTE_PREFIX.length);
    const logBase = { component: "datasette-proxy", session_id: verified.sessionId };
    if (c.req.method !== "GET") {
      log.warn("Datasette proxy refused a request", { ...logBase, reason: "method", http_method: c.req.method });
      c.header("Allow", "GET");
      return jsonOk(c, { error: "Only GET is allowed: this proxy is read-only" }, 405);
    }
    const check = checkDatasettePath(dsPath, verified.databases);
    if (!check.ok) {
      log.warn("Datasette proxy refused a request", { ...logBase, reason: check.reason, path: dsPath.slice(0, 200), ...(check.db ? { db: check.db.slice(0, 100) } : {}) });
      return jsonOk(c, { error: check.reason === "database" ? "This session does not hold that Datasette database" : "Path is not a Datasette JSON read" }, 403);
    }
    const started = Date.now();
    const result = await proxyDatasetteRead(dsPath, url.search.replace(/^\?/, ""), verified.databases);
    if (result.kind === "forbidden") return jsonOk(c, { error: "Path is not a Datasette JSON read" }, 403);
    if (result.kind === "unconfigured") return jsonOk(c, { error: "Datasette is not configured" }, 503);
    if (result.kind === "upstream-error") {
      log.warn("Datasette proxy upstream failed", { ...logBase, db: check.db, path: dsPath.slice(0, 200), error: result.error, duration_ms: Date.now() - started });
      return jsonOk(c, { error: "Datasette did not respond" }, 502);
    }
    log.debug("Datasette read proxied", { ...logBase, db: check.db, path: dsPath.slice(0, 200), status: result.status, duration_ms: Date.now() - started });
    if (result.contentType) c.header("Content-Type", result.contentType);
    if (result.status === 204 || result.status === 304) return c.body(null, result.status);
    return c.body(result.body, result.status as 200);
  });

  // Read-only prod mailbox proxy (#clw_01M8BM2RWC1T085EEEVZ6X21EH): no
  // dashboard auth, the per-session Bearer token (src/mail-read-token.ts) is
  // the authentication. Registered for every method so a write is refused
  // with 405 rather than falling through. Logs ids only: never the token,
  // subjects, addresses or content.
  app.all(`${MAIL_READ_ROUTE_PREFIX}/*`, async (c) => {
    c.header("Cache-Control", "no-store");
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const sessionId = token ? await verifyMailReadToken(token) : null;
    if (!sessionId) return jsonOk(c, { error: "Unauthorized" }, 401);
    const url = new URL(c.req.url);
    const action = url.pathname.slice(MAIL_READ_ROUTE_PREFIX.length + 1);
    const logBase = { component: "mail-read-proxy", session_id: sessionId };
    const refuse = (reason: string, status: 400 | 404 | 405, error: string) => {
      log.warn("Mail read proxy refused a request", { ...logBase, reason, ...(reason === "method" ? { http_method: c.req.method } : {}) });
      return jsonOk(c, { error }, status);
    };
    if (c.req.method !== "GET") {
      c.header("Allow", "GET");
      return refuse("method", 405, "Only GET is allowed: this proxy is read-only");
    }
    if (!["folders", "messages", "message", "attachment"].includes(action)) return refuse("path", 404, "Unknown mail read route");
    if (!isMailReadConfigured()) return jsonOk(c, { error: "Mail reading is not configured" }, 503);
    const q = url.searchParams;
    let folder: string | undefined;
    let uid: number | undefined;
    if (action !== "folders") {
      folder = q.get("folder") ?? "";
      if (!isValidMailFolder(folder)) return refuse("folder", 400, "folder is missing, longer than 200 characters or has control characters");
    }
    if (action === "message" || action === "attachment") {
      const parsed = parseMailUid(q.get("uid"));
      if (parsed == null) return refuse("uid", 400, "uid must be a positive number");
      uid = parsed;
    }
    const started = Date.now();
    let result: MailReadResult<unknown>;
    if (action === "folders") {
      result = await listFolders();
    } else if (action === "messages") {
      let limit = DEFAULT_MESSAGE_LIMIT;
      if (q.has("limit")) {
        const n = parseMailIndex(q.get("limit"));
        if (n == null || n < 1 || n > MAX_MESSAGE_LIMIT) return refuse("limit", 400, `limit must be 1 to ${MAX_MESSAGE_LIMIT}`);
        limit = n;
      }
      let before: number | undefined;
      if (q.has("before")) {
        const b = parseMailUid(q.get("before"));
        if (b == null) return refuse("uid", 400, "before must be a positive uid");
        before = b;
      }
      result = await listMessages(folder!, limit, before);
    } else if (action === "message") {
      result = await getMessage(folder!, uid!);
    } else {
      const index = parseMailIndex(q.get("index"));
      if (index == null) return refuse("index", 400, "index must be a non-negative number");
      result = await getAttachment(folder!, uid!, index);
    }
    const status =
      result.kind === "ok" ? 200 : result.kind === "not-found" ? 404 : result.kind === "too-large" ? 413 : result.kind === "unconfigured" ? 503 : 502;
    const durationMs = Date.now() - started;
    if (result.kind === "upstream-error") {
      log.warn("Mail read proxy upstream failed", { ...logBase, action, error: result.error, duration_ms: durationMs });
    }
    log.info("Mail read proxied", { ...logBase, action, folder: folder ?? null, uid: uid ?? null, status, duration_ms: durationMs });
    switch (result.kind) {
      case "unconfigured":
        return jsonOk(c, { error: "Mail reading is not configured" }, 503);
      case "not-found":
        return jsonOk(c, { error: "No such folder, message or attachment" }, 404);
      case "too-large":
        return jsonOk(c, { error: "Message is over 25 MB" }, 413);
      case "upstream-error":
        return jsonOk(c, { error: "The mail server did not respond" }, 502);
    }
    if (action === "attachment") {
      const a = result.value as { filename: string | null; contentType: string; content: Buffer };
      c.header("Content-Type", a.contentType || "application/octet-stream");
      c.header("X-Content-Type-Options", "nosniff");
      if (a.filename) c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
      return c.body(new Uint8Array(a.content), 200);
    }
    return jsonOk(c, result.value, 200);
  });

  app.get("/manifest.webmanifest", (c) => {
    c.header("Content-Type", "application/manifest+json");
    c.header("Cache-Control", "max-age=86400");
    return c.body(WEB_MANIFEST);
  });

  const serveIcon = async (c: Ctx, size: number) => {
    try {
      const png = await getAppIconPng(size);
      c.header("Content-Type", "image/png");
      c.header("Cache-Control", "max-age=86400");
      return c.body(new Uint8Array(png));
    } catch (err) {
      log.warn(`[pwa] icon render failed (${size}): ${err}`);
      return c.body(null, 500);
    }
  };

  app.get("/static/icon-180.png", (c) => serveIcon(c, 180));
  app.get("/static/icon-192.png", (c) => serveIcon(c, 192));
  app.get("/static/icon-512.png", (c) => serveIcon(c, 512));
  app.get("/apple-touch-icon.png", (c) => serveIcon(c, 180));
  app.get("/apple-touch-icon-precomposed.png", (c) => serveIcon(c, 180));

  // Public by design: reports only whether the caller's *own* cookie is still
  // valid, so a restored page can detect a lapsed session without having to
  // parse authMiddleware's 401 HTML redirect body. Must never itself 401 —
  // src/client/auth-watch.ts treats a non-200 here as "server trouble", not
  // stale auth (#2479). Wire format is consumed by that module.
  app.get("/api/auth/status", (c) => {
    c.header("Cache-Control", "no-store");
    if (!isOidcEnabled()) {
      return jsonOk(c, { authenticated: false, oidcEnabled: false, expiresAt: null });
    }
    const cookies = parseCookies(c.req.header("cookie"));
    const raw = cookies["claws_session"];
    let session: { sub: string; expiresAt: number } | null = null;
    if (raw) {
      let decoded: string;
      try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
      session = verifySession(decoded, config.OIDC_CLIENT_SECRET);
    }
    return jsonOk(c, {
      authenticated: !!session,
      oidcEnabled: true,
      expiresAt: session ? session.expiresAt : null,
    });
  });

  app.get("/login", (c) => {
    if (isOidcEnabled()) {
      const raw = c.req.query("next") ?? "/";
      const returnTo =
        raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")
          ? raw
          : "/";
      const { baseUrl, redirectUri } = resolveOidcTarget(c);
      const state = crypto.randomBytes(16).toString("hex");
      const signed = signOAuthState(state, { returnTo, baseUrl, redirectUri }, Date.now() + OAUTH_STATE_TTL_MS, config.OIDC_CLIENT_SECRET);
      c.header("Set-Cookie", oauthStateCookie(state, signed, OAUTH_STATE_TTL_MS / 1000));
      const authorizeUrl = new URL(
        `${baseUrl}/application/o/authorize/`,
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

    // /login only mints hex states; anything else would not name a cookie.
    if (!/^[0-9a-f]{1,64}$/.test(state)) {
      return htmlOk(c, "Bad request: invalid or expired OAuth state. Please try logging in again.", 400);
    }
    const stateEntry = verifyOAuthState(parseCookies(c.req.header("cookie"))[oauthStateCookieName(state)], state, config.OIDC_CLIENT_SECRET);
    // Single use: cleared whatever the outcome. Other tabs' logins keep theirs.
    c.header("Set-Cookie", oauthStateCookie(state, "", 0), { append: true });
    if (!stateEntry) {
      return htmlOk(c, "Bad request: invalid or expired OAuth state. Please try logging in again.", 400);
    }
    const { returnTo, baseUrl, redirectUri } = stateEntry;

    try {
      const tokenUrl = `${baseUrl}/application/o/token/`;
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
        signal: AbortSignal.timeout(10_000),
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

      const userinfoUrl = `${baseUrl}/application/o/userinfo/`;
      const userRes = await fetch(userinfoUrl, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(10_000),
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
      c.header("Set-Cookie", `claws_session=${encodeURIComponent(sessionValue)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${24 * 60 * 60}`, { append: true });
      return c.redirect(returnTo, 303);
    } catch (err) {
      log.error(`OIDC callback error: ${err}`);
      return htmlOk(c, "Internal error during authentication. Please try again.", 500);
    }
  });

  app.get("/logout", (c) => {
    c.header("Set-Cookie", `claws_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`, { append: true });

    const { baseUrl, redirectUri } = resolveOidcTarget(c);
    if (isOidcEnabled() && redirectUri) {
      const postLogoutUri = encodeURIComponent(
        redirectUri.replace(/\/auth\/callback$/, "/login"),
      );
      const endSessionUrl = `${baseUrl}/application/o/${config.OIDC_APPLICATION_SLUG}/end-session/?post_logout_redirect_uri=${postLogoutUri}`;
      return c.redirect(endSessionUrl, 303);
    }
    return c.redirect("/", 303);
  });
}
