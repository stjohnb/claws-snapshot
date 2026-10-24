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
  })),
  warmDashboardCaches: vi.fn(async () => {}),
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
  closeDb: m.closeDb,
  readSchemaVersion: m.readSchemaVersion,
  setRequirementsVersionListener: m.setRequirementsVersionListener,
  stampTasksWithRunContext: m.stampTasksWithRunContext,
}));
vi.mock("./config.js", () => ({ METRICS_PORT: 0, BIND_HOST: "127.0.0.1", reloadConfig: vi.fn() }));
vi.mock("./log.js", async () => {
  const { runContext, withRunContext } = await vi.importActual<typeof import("./log-core.js")>("./log-core.js");
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), runContext, withRunContext };
});
vi.mock("./claws-issues.js", () => ({ onRequirementsVersionStored: vi.fn() }));
vi.mock("./config-store.js", () => ({ materialiseConfig: m.materialiseConfig }));
vi.mock("./config-watch.js", () => ({ startConfigWatcher: m.startConfigWatcher, stopConfigWatcher: m.stopConfigWatcher }));
vi.mock("./controller-client.js", () => ({ dbControllerClient: m.dbControllerClient }));
vi.mock("./imported-refs.js", () => ({ loadImportedRefs: vi.fn(async () => {}) }));
vi.mock("./github-events.js", () => ({ resolveAllWaiters: m.resolveAllWaiters }));
vi.mock("./server.js", () => ({ createServer: m.createServer, warmDashboardCaches: m.warmDashboardCaches }));
vi.mock("./session-backend.js", () => ({ getSessionBackend: () => ({ start: m.sessionStart }) }));
vi.mock("./metrics.js", () => ({ markShuttingDown: vi.fn(), startMetricsServer: vi.fn() }));
// Guards: the web tier must never reach any of these.
vi.mock("./scheduler.js", () => ({ startJobs: m.startJobs }));
vi.mock("./worker.js", () => ({ start: m.workerStart }));
vi.mock("./whatsapp.js", () => ({ start: m.whatsappStart }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, default: { ...real, writeFileSync: m.writeFileSync }, writeFileSync: m.writeFileSync };
});

import { drainServer, startWeb, waitForSchemaVersion } from "./main-web.js";

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
});

describe("drainServer", () => {
  async function serverWithSlowRoute(delayMs: number) {
    const server = http.createServer((req, res) => {
      setTimeout(() => res.end("done"), delayMs);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    return { server, port };
  }

  function get(port: number): Promise<{ status: number | undefined; body: string } | Error> {
    return new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }).on("error", resolve);
    });
  }

  it("lets an in-flight request finish before resolving", async () => {
    const { server, port } = await serverWithSlowRoute(100);
    const pending = get(port);
    await new Promise((r) => setTimeout(r, 20));
    await drainServer(server, 5_000);
    expect(await pending).toEqual({ status: 200, body: "done" });
    expect(server.listening).toBe(false);
  });

  it("cuts a request that outlasts the drain window", async () => {
    const { server, port } = await serverWithSlowRoute(10_000);
    const pending = get(port);
    await new Promise((r) => setTimeout(r, 20));
    await drainServer(server, 50);
    expect(await pending).toBeInstanceOf(Error);
    expect(server.listening).toBe(false);
  });
});
