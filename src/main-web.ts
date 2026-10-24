import type http from "node:http";
import * as config from "./config.js";
import * as log from "./log.js";
import { initDb, closeDb, readSchemaVersion, setRequirementsVersionListener, stampTasksWithRunContext, SCHEMA_VERSION } from "./db.js";
import { onRequirementsVersionStored } from "./claws-issues.js";
import { materialiseConfig } from "./config-store.js";
import { startConfigWatcher, stopConfigWatcher } from "./config-watch.js";
import { dbControllerClient } from "./controller-client.js";
import { loadImportedRefs } from "./imported-refs.js";
import { resolveAllWaiters } from "./github-events.js";
import { createServer, warmDashboardCaches } from "./server.js";
import { getSessionBackend } from "./session-backend.js";
import { setShuttingDown } from "./shutdown.js";
import { markShuttingDown, startMetricsServer } from "./metrics.js";
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
 * Stops accepting connections and waits up to `drainMs` for in-flight
 * requests to finish (idle keep-alive sockets are closed at once), then cuts
 * whatever is left. Resolves once the server has closed.
 */
export async function drainServer(server: http.Server, drainMs = SHUTDOWN_DRAIN_MS): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), drainMs); });
  if (await Promise.race([closed.then(() => false), timedOut])) {
    log.warn(`[web] Requests still running after ${drainMs} ms; closing their connections`);
    server.closeAllConnections();
    await closed;
  }
  clearTimeout(timer);
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
  // The first page loads after a web roll render from cache, not the forge.
  void warmDashboardCaches();
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
    await drainServer(server, opts.drainMs);
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
