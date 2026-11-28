import type http from "node:http";
import type { Duplex } from "node:stream";
import * as config from "./config.js";
import * as log from "./log.js";
import { initDb, dbPoolStats, closeDb, readSchemaVersion, setRequirementsVersionListener, stampTasksWithRunContext, SCHEMA_VERSION } from "./db.js";
import { onRequirementsVersionStored } from "./claws-issues.js";
import { materialiseConfig } from "./config-store.js";
import { refreshClaudeAccounts } from "./claude-accounts.js";
import { startConfigWatcher, stopConfigWatcher } from "./config-watch.js";
import { dbControllerClient } from "./controller-client.js";
import { loadImportedRefs } from "./imported-refs.js";
import { resolveAllWaiters } from "./github-events.js";
import { createServer, warmDashboardCaches, webSocketServerFor } from "./server.js";
import { getSessionBackend } from "./session-backend.js";
import { setShuttingDown } from "./shutdown.js";
import { markShuttingDown, setDbPoolStatsProvider, startMetricsServer } from "./metrics.js";
import { sleep as defaultSleep } from "./util.js";

/**
 * The web tier (`CLAWS_ROLE=web`, #clw_01M5APX7YF3AGWHV1S1WMHJDR6), loaded by
 * main.ts. Serves the dashboard, API, agent-pod callbacks and terminal relays
 * and keeps no state of its own: no PID lock, no startup recovery, no
 * scheduler, worker, WhatsApp gateway or memory backup, and no migrations.
 * Everything it reads or changes about background processing goes through the
 * database (`dbControllerClient`), so it keeps serving while the controller
 * restarts, and several replicas can run side by side.
 */

/** How often a web pod re-reads the recorded schema version while it waits for the controller. */
export const SCHEMA_POLL_MS = 5_000;

/** Longest shutdown waits for in-flight requests before cutting their connections. */
export const SHUTDOWN_DRAIN_MS = 10_000;

/**
 * How often {@link drainServer} re-closes idle keep-alive connections while
 * it waits. A connection busy when the drain began (a long-poll being
 * answered) goes idle once that answer is sent; Node would otherwise keep
 * serving new requests on it, so a client retrying on the same socket would
 * keep reaching this dying process (#clw_01M7TVF8T4C9145EFPT5KVPHZM).
 */
export const DRAIN_IDLE_SWEEP_MS = 100;

/**
 * Longest {@link drainServer} waits for `server.close()` after it has cut every
 * connection. Node calls back only once every socket has ended, so a socket it
 * cannot close (an upgraded one no tracker knows about) would otherwise keep
 * the pod from reaching `closeDb()` and "Shutdown complete" until SIGKILL.
 */
export const DRAIN_CLOSE_WAIT_MS = 2_000;

/**
 * Tracks every socket `server` accepts, through its `"connection"` event.
 * `closeAllConnections()` does not reach an upgraded (session terminal
 * WebSocket) socket, and `server.close()` calls back only once it has ended,
 * so a single open terminal kept every web pod drain from finishing. It must
 * not listen on `"upgrade"`: `@hono/node-server` answers a refused upgrade
 * (401, 404, …) only while its own listener is the only one, so a second
 * listener leaves those clients hanging with no response. Returns a function
 * that destroys every tracked socket still open and returns how many it
 * destroyed; called after `closeAllConnections()`, those are the upgraded ones.
 * {@link drainServer} cuts the terminals it knows of at drain start
 * (`opts.webSockets`), so this is the backstop for any socket it missed.
 */
export function trackOpenSockets(server: http.Server): () => number {
  const sockets = new Set<Duplex>();
  server.on("connection", (socket: Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return () => {
    let count = 0;
    for (const socket of sockets) {
      if (socket.destroyed) continue;
      socket.destroy();
      count++;
    }
    sockets.clear();
    return count;
  };
}

/**
 * Stops accepting connections and waits up to `drainMs` for in-flight
 * requests to finish, then cuts whatever is left. Idle keep-alive sockets are
 * closed at once and again every {@link DRAIN_IDLE_SWEEP_MS} while it waits,
 * so a socket whose request finishes during the drain is closed instead of
 * carrying the client's next request to this process. Upgraded (WebSocket)
 * sockets never finish by themselves, so every client of `opts.webSockets`
 * (the dashboard's `ws` server) is terminated at drain start, and once the
 * window is over `opts.destroyRemaining` (from {@link trackOpenSockets}) cuts
 * whatever `closeAllConnections()` left as a backstop. After cutting connections it waits at most
 * `opts.closeWaitMs` for the server to close, then warns and resolves anyway,
 * so shutdown always goes on to close the database.
 */
export async function drainServer(
  server: http.Server,
  drainMs = SHUTDOWN_DRAIN_MS,
  opts: { destroyRemaining?: () => number; closeWaitMs?: number; webSockets?: { clients: Set<{ terminate(): void }> } } = {},
): Promise<void> {
  const closeWaitMs = opts.closeWaitMs ?? DRAIN_CLOSE_WAIT_MS;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // terminate(), not close(): a close handshake could outlast the drain, and
  // the browser terminal reconnects to another pod.
  const clients = opts.webSockets ? [...opts.webSockets.clients] : [];
  for (const ws of clients) ws.terminate();
  if (clients.length > 0) log.info("Closed terminal WebSockets at drain start", { component: "web", count: clients.length });
  server.closeIdleConnections();
  const sweep = setInterval(() => server.closeIdleConnections(), DRAIN_IDLE_SWEEP_MS);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), drainMs); });
  let closeTimer: NodeJS.Timeout | undefined;
  try {
    if (await Promise.race([closed.then(() => false), timedOut])) {
      log.warn(`[web] Requests still running after ${drainMs} ms; closing their connections`);
      server.closeAllConnections();
      const count = opts.destroyRemaining?.() ?? 0;
      if (count > 0) log.info("Closed upgraded connections for shutdown", { component: "web", count });
      const closeTimedOut = new Promise<boolean>((resolve) => { closeTimer = setTimeout(() => resolve(true), closeWaitMs); });
      if (await Promise.race([closed.then(() => false), closeTimedOut])) {
        log.warn("Server still open after cutting connections; continuing shutdown", { component: "web", wait_ms: closeWaitMs });
      }
    }
  } finally {
    clearInterval(sweep);
    clearTimeout(timer);
    clearTimeout(closeTimer);
  }
}

/**
 * Resolves once the controller has recorded a schema version at least
 * {@link SCHEMA_VERSION}, i.e. migrated the database for this build. Until
 * then the web pod does not listen, so it never becomes ready; an older web
 * pod keeps serving meanwhile, because schema changes are additive.
 */
export async function waitForSchemaVersion(opts: {
  read?: () => Promise<number | null>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
} = {}): Promise<number> {
  const read = opts.read ?? readSchemaVersion;
  const sleep = opts.sleep ?? defaultSleep;
  const pollMs = opts.pollMs ?? SCHEMA_POLL_MS;
  for (;;) {
    const recorded = await read();
    if (recorded !== null && recorded >= SCHEMA_VERSION) return recorded;
    log.info(`[web] Waiting for the controller to migrate the database to schema ${SCHEMA_VERSION} (recorded: ${recorded ?? "none"})`);
    await sleep(pollMs);
  }
}

export interface WebHandle {
  server: http.Server;
  shutdown(): Promise<void>;
}

/**
 * Boots the web tier and installs its SIGINT/SIGTERM handlers. `exit` is
 * `process.exit` outside tests.
 */
export async function startWeb(opts: {
  sleep?: (ms: number) => Promise<void>;
  exit?: (code: number) => void;
  installSignalHandlers?: boolean;
  drainMs?: number;
} = {}): Promise<WebHandle> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  await initDb({ migrate: false });
  await waitForSchemaVersion({ sleep: opts.sleep });
  // boot.ts found no stored config when the controller had not stored one yet;
  // it has by now.
  if (await materialiseConfig({ readOnly: true })) config.reloadConfig();
  startConfigWatcher(5000);
  await loadImportedRefs();
  // Claude accounts and tokens (database state) for /reauth and session launches.
  await refreshClaudeAccounts();
  // Requirements versions written through this process's routes still announce
  // and auto-promote (docs/refinements/issue-flow.md "Promotion").
  setRequirementsVersionListener(onRequirementsVersionStored);
  // Agent-pod ops land on this tier, so a task an agent pod starts must carry
  // the row's run id: the task-scoped ops (recordTaskComplete,
  // recordTaskFailed, …) are refused for a task of any other run.
  stampTasksWithRunContext();

  // Web mode: re-reads open sessions and pods for attach and startup status;
  // reconcile, ends, cleanup and the summary and usage timers are the controller's.
  await getSessionBackend().start();

  const server = createServer(dbControllerClient());
  // Terminal WebSockets are cut at drain start (drainServer's webSockets);
  // the socket tracker is the backstop once the drain window is over.
  const destroyRemaining = trackOpenSockets(server);
  const webSockets = webSocketServerFor(server);
  // The first page loads after a web roll render from cache, not the forge.
  void warmDashboardCaches();
  setDbPoolStatsProvider(dbPoolStats);
  const metricsServer = config.METRICS_PORT > 0 ? startMetricsServer(config.METRICS_PORT, config.BIND_HOST) : null;

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    markShuttingDown();
    setShuttingDown();
    log.info("Shutting down web tier...");
    stopConfigWatcher();
    // A pending /api/events long-poll holds its connection open until answered;
    // see the matching note in main-controller.ts.
    resolveAllWaiters();
    // Page requests still running past the preStop window finish before the
    // database they read is closed.
    await drainServer(server, opts.drainMs, { destroyRemaining, webSockets });
    await metricsServer?.close();
    await closeDb();
    log.info("Shutdown complete");
    exit(0);
  }

  if (opts.installSignalHandlers !== false) {
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  }

  log.info("claws web tier is running");
  return { server, shutdown };
}
