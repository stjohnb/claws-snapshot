import http from "node:http";
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  initDb: vi.fn(async () => {}),
  closeDb: vi.fn(async () => {}),
  readSchemaVersion: vi.fn(async (): Promise<number | null> => null),
  setRequirementsVersionListener: vi.fn(),
  stampTasksWithRunContext: vi.fn(),
  createServer: vi.fn(() => ({
    close: vi.fn((cb?: () => void) => cb?.()),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
    on: vi.fn(),
  })),
  warmDashboardCaches: vi.fn(async () => {}),
  webSocketServerFor: vi.fn(() => undefined),
  sessionStart: vi.fn(async () => {}),
  startConfigWatcher: vi.fn(),
  stopConfigWatcher: vi.fn(),
  materialiseConfig: vi.fn(async () => false),
  dbControllerClient: vi.fn(() => ({ kind: "db" })),
  startJobs: vi.fn(),
  workerStart: vi.fn(),
  whatsappStart: vi.fn(),
  writeFileSync: vi.fn(),
  resolveAllWaiters: vi.fn(),
}));

vi.mock("./db.js", () => ({
  SCHEMA_VERSION: 3,
  initDb: m.initDb,
  dbPoolStats: vi.fn(() => null),
  closeDb: m.closeDb,
  readSchemaVersion: m.readSchemaVersion,
  setRequirementsVersionListener: m.setRequirementsVersionListener,
  stampTasksWithRunContext: m.stampTasksWithRunContext,
}));
vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), { METRICS_PORT: 0, BIND_HOST: "127.0.0.1", reloadConfig: vi.fn() }));
vi.mock("./log.js", async () => {
  const { runContext, withRunContext } = await vi.importActual<typeof import("./log-core.js")>("./log-core.js");
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), runContext, withRunContext };
});
vi.mock("./claws-issues.js", () => ({ onRequirementsVersionStored: vi.fn() }));
vi.mock("./config-store.js", () => ({ materialiseConfig: m.materialiseConfig }));
vi.mock("./config-watch.js", () => ({ startConfigWatcher: m.startConfigWatcher, stopConfigWatcher: m.stopConfigWatcher }));
vi.mock("./controller-client.js", () => ({ dbControllerClient: m.dbControllerClient }));
vi.mock("./imported-refs.js", () => ({ loadImportedRefs: vi.fn(async () => {}) }));
vi.mock("./claude-accounts.js", () => ({ refreshClaudeAccounts: vi.fn(async () => {}) }));
vi.mock("./github-events.js", () => ({ resolveAllWaiters: m.resolveAllWaiters }));
vi.mock("./server.js", () => ({ createServer: m.createServer, warmDashboardCaches: m.warmDashboardCaches, webSocketServerFor: m.webSocketServerFor }));
vi.mock("./session-backend.js", () => ({ getSessionBackend: () => ({ start: m.sessionStart }) }));
vi.mock("./metrics.js", () => ({ markShuttingDown: vi.fn(), setDbPoolStatsProvider: vi.fn(), startMetricsServer: vi.fn() }));
// Guards: the web tier must never reach any of these.
vi.mock("./scheduler.js", () => ({ startJobs: m.startJobs }));
vi.mock("./worker.js", () => ({ start: m.workerStart }));
vi.mock("./whatsapp.js", () => ({ start: m.whatsappStart }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, default: { ...real, writeFileSync: m.writeFileSync }, writeFileSync: m.writeFileSync };
});

import { DRAIN_IDLE_SWEEP_MS, drainServer, startWeb, trackOpenSockets, waitForSchemaVersion } from "./main-web.js";
import * as log from "./log.js";
import net from "node:net";
import { Hono } from "hono";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";

describe("waitForSchemaVersion", () => {
  it("polls until the recorded version reaches this build's", async () => {
    const read = vi.fn<() => Promise<number | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(4);
    const sleep = vi.fn(async () => {});
    expect(await waitForSchemaVersion({ read, sleep, pollMs: 5000 })).toBe(4);
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5000);
  });
});

describe("startWeb", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the database without migrating and serves only after the schema version is recorded", async () => {
    m.readSchemaVersion.mockResolvedValueOnce(null).mockResolvedValueOnce(3);
    const sleep = vi.fn(async () => {
      expect(m.createServer).not.toHaveBeenCalled();
    });
    const exit = vi.fn();
    const web = await startWeb({ sleep, exit, installSignalHandlers: false });

    expect(m.initDb).toHaveBeenCalledWith({ migrate: false });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(m.materialiseConfig).toHaveBeenCalledWith({ readOnly: true });
    expect(m.startConfigWatcher).toHaveBeenCalled();
    expect(m.setRequirementsVersionListener).toHaveBeenCalled();
    expect(m.sessionStart).toHaveBeenCalled();
    expect(m.createServer).toHaveBeenCalledWith({ kind: "db" });
    expect(m.warmDashboardCaches).toHaveBeenCalled();

    expect(m.startJobs).not.toHaveBeenCalled();
    expect(m.workerStart).not.toHaveBeenCalled();
    expect(m.whatsappStart).not.toHaveBeenCalled();
    expect(m.writeFileSync).not.toHaveBeenCalledWith(expect.stringContaining("claws.pid"), expect.anything());

    await web.shutdown();
    expect(m.resolveAllWaiters).toHaveBeenCalled();
    expect(m.closeDb).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("stamps tasks with the current run id, since agent-pod ops call recordTaskStart on this tier", async () => {
    m.readSchemaVersion.mockResolvedValueOnce(3);
    await startWeb({ exit: vi.fn(), installSignalHandlers: false });

    expect(m.stampTasksWithRunContext).toHaveBeenCalledTimes(1);
  });

  it("tracks sockets through \"connection\" and adds no \"upgrade\" listener, which would stop hono rejecting refused upgrades", async () => {
    m.readSchemaVersion.mockResolvedValueOnce(3);
    const web = await startWeb({ exit: vi.fn(), installSignalHandlers: false });

    const on = vi.mocked(web.server.on);
    expect(on).toHaveBeenCalledWith("connection", expect.any(Function));
    expect(on).not.toHaveBeenCalledWith("upgrade", expect.anything());
    expect(m.webSocketServerFor).toHaveBeenCalledWith(web.server);

    await web.shutdown();
    expect(on).not.toHaveBeenCalledWith("upgrade", expect.anything());
  });
});

describe("drainServer", () => {
  async function serverWithSlowRoute(delayMs: number) {
    let markReceived!: () => void;
    const received = new Promise<void>((resolve) => (markReceived = resolve));
    const server = http.createServer((req, res) => {
      markReceived();
      setTimeout(() => res.end("done"), delayMs);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return { server, port, received };
  }

  function get(port: number): Promise<{ status: number | undefined; body: string } | Error> {
    return new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }).on("error", resolve);
    });
  }

  it("lets an in-flight request finish before resolving", async () => {
    const { server, port, received } = await serverWithSlowRoute(100);
    const pending = get(port);
    await received;
    await drainServer(server, 5_000);
    expect(await pending).toEqual({ status: 200, body: "done" });
    expect(server.listening).toBe(false);
  });

  it("cuts a request that outlasts the drain window", async () => {
    const { server, port, received } = await serverWithSlowRoute(10_000);
    const pending = get(port);
    await received;
    await drainServer(server, 50);
    expect(await pending).toBeInstanceOf(Error);
    expect(server.listening).toBe(false);
  });

  it("closes a kept-alive connection once its in-flight request finishes, so a retry never reaches the draining server (#clw_01M7TVF8T4C9145EFPT5KVPHZM)", async () => {
    // The session's MCP client reuses one keep-alive socket: the wait being
    // answered when the drain begins must not leave that socket serving the
    // retry from this dying process.
    const paths: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let markReceived!: () => void;
    const received = new Promise<void>((resolve) => (markReceived = resolve));
    const server = http.createServer((req, res) => {
      paths.push(req.url ?? "");
      if (req.url === "/wait") {
        markReceived();
        void released.then(() => res.end("interrupted"));
      } else {
        res.end("served by the draining server");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const request = (path: string) => new Promise<{ status: number | undefined; body: string } | Error>((resolve) => {
      http.get({ host: "127.0.0.1", port, path, agent }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }).on("error", resolve);
    });
    try {
      const wait = request("/wait");
      await received;
      const drained = drainServer(server, 5_000);
      release();
      expect(await wait).toEqual({ status: 200, body: "interrupted" });
      await new Promise((resolve) => setTimeout(resolve, DRAIN_IDLE_SWEEP_MS * 3));
      const retry = await request("/retry");
      expect(retry).toBeInstanceOf(Error);
      expect(paths).toEqual(["/wait"]);
      await drained;
      expect(server.listening).toBe(false);
    } finally {
      agent.destroy();
    }
  });

  /**
   * Serves the way `createServer` does: `@hono/node-server`'s `serve` with a
   * `ws` server, a WebSocket route held open as a terminal is, and a route
   * that refuses its upgrade as the auth middleware does.
   */
  async function serverHoldingUpgrade() {
    const app = new Hono();
    app.get("/denied", (c) => c.body(null, 401));
    app.get("/terminal", upgradeWebSocket(() => ({})));
    const wss = new WebSocketServer({ noServer: true });
    const server = await new Promise<http.Server>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1", websocket: { server: wss } }, () => resolve(s as http.Server));
    });
    const port = (server.address() as { port: number }).port;
    return { server, port, wss };
  }

  function openUpgraded(port: number, path = "/terminal"): Promise<{ socket: net.Socket; response: string; closed: Promise<void> }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
      });
      const closed = new Promise<void>((r) => socket.once("close", () => r()));
      socket.once("data", (data) => resolve({ socket, response: data.toString(), closed }));
      socket.once("error", reject);
    });
  }

  it("cuts an upgraded (terminal) socket once the window is over, so the drain finishes", async () => {
    const { server, port } = await serverHoldingUpgrade();
    const destroyRemaining = trackOpenSockets(server);
    const client = await openUpgraded(port);
    expect(client.response).toMatch(/^HTTP\/1\.1 101/);
    const started = Date.now();
    await drainServer(server, 100, { destroyRemaining, closeWaitMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(2_000);
    await client.closed;
    expect(server.listening).toBe(false);
    expect(log.info).toHaveBeenCalledWith("Closed upgraded connections for shutdown", { component: "web", count: 1 });
  });

  it("leaves hono answering a refused upgrade while sockets are tracked", async () => {
    const { server, port } = await serverHoldingUpgrade();
    trackOpenSockets(server);
    const client = await openUpgraded(port, "/denied");
    try {
      expect(client.response).toMatch(/^HTTP\/1\.1 401/);
    } finally {
      client.socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("terminates terminal WebSockets at drain start, so a drain with only an open terminal finishes well inside the window", async () => {
    vi.mocked(log.info).mockClear();
    const { server, port, wss } = await serverHoldingUpgrade();
    const client = await openUpgraded(port);
    expect(client.response).toMatch(/^HTTP\/1\.1 101/);
    const started = Date.now();
    await drainServer(server, 5_000, { webSockets: wss });
    expect(Date.now() - started).toBeLessThan(1_000);
    await client.closed;
    expect(server.listening).toBe(false);
    expect(log.info).toHaveBeenCalledWith("Closed terminal WebSockets at drain start", { component: "web", count: 1 });
  });

  it("leaves hono answering a refused upgrade with the ws server wired for the drain", async () => {
    const { server, port } = await serverHoldingUpgrade();
    const client = await openUpgraded(port, "/denied");
    try {
      expect(client.response).toMatch(/^HTTP\/1\.1 401/);
      expect(server.listenerCount("upgrade")).toBe(1);
    } finally {
      client.socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("still lets an in-flight request finish when terminal WebSockets are cut at drain start", async () => {
    const { server, port, received } = await serverWithSlowRoute(100);
    const pending = get(port);
    await received;
    await drainServer(server, 5_000, { webSockets: new WebSocketServer({ noServer: true }) });
    expect(await pending).toEqual({ status: 200, body: "done" });
    expect(server.listening).toBe(false);
  });

  it("stops waiting for the server to close once the bound expires, and warns", async () => {
    vi.mocked(log.warn).mockClear();
    const { server, port } = await serverHoldingUpgrade();
    const client = await openUpgraded(port);
    try {
      await drainServer(server, 50, { closeWaitMs: 50 });
      expect(log.warn).toHaveBeenCalledWith("Server still open after cutting connections; continuing shutdown", { component: "web", wait_ms: 50 });
    } finally {
      client.socket.destroy();
    }
  });
});
