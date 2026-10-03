import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig, mockLog, mockFetch } = vi.hoisted(() => ({
  mockConfig: { BROWSER_CDP_ENDPOINT: "" },
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockFetch: vi.fn(),
}));

vi.mock("./config.js", () => mockConfig);
vi.mock("./log.js", () => mockLog);
vi.stubGlobal("fetch", mockFetch);

import {
  BROWSER_CAPACITY_RETRY_DELAYS_MS,
  browserPressureUrl,
  fetchBrowserPressure,
  playwrightMcpServer,
  redactedBrowserEndpoint,
  usesRemoteBrowser,
  waitForBrowserCapacity,
} from "./browser-endpoint.js";

const ENDPOINT = "ws://browser.default.svc.cluster.local:3000/?token=s3cret-token";

function pressureResponse(pressure: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => ({ pressure }) };
}

function loggedText(): string {
  return JSON.stringify([mockLog.info.mock.calls, mockLog.warn.mock.calls, mockLog.error.mock.calls]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.BROWSER_CDP_ENDPOINT = "";
});

describe("playwrightMcpServer", () => {
  it("launches local Chromium with the given flags when no endpoint is set", () => {
    expect(usesRemoteBrowser()).toBe(false);
    expect(playwrightMcpServer(["--headless", "--user-data-dir", "/p"])).toEqual({
      command: "npx",
      args: ["@playwright/mcp@latest", "--headless", "--user-data-dir", "/p"],
    });
  });

  it("connects to the shared service through env, not argv, when the endpoint is set", () => {
    mockConfig.BROWSER_CDP_ENDPOINT = ENDPOINT;
    expect(usesRemoteBrowser()).toBe(true);
    const server = playwrightMcpServer(["--headless", "--user-data-dir", "/p"]);
    expect(server).toEqual({
      command: "npx",
      args: ["@playwright/mcp@latest"],
      env: { PLAYWRIGHT_MCP_CDP_ENDPOINT: ENDPOINT },
    });
    expect(server.args.join(" ")).not.toContain("token");
  });
});

describe("redactedBrowserEndpoint", () => {
  it("drops the query string and credentials", () => {
    mockConfig.BROWSER_CDP_ENDPOINT = "wss://user:pw@browser.example:3000/chromium?token=s3cret-token";
    expect(redactedBrowserEndpoint()).toBe("wss://browser.example:3000/chromium");
  });
});

describe("browserPressureUrl", () => {
  it("maps ws to http, keeps the token query and targets /pressure", () => {
    expect(browserPressureUrl(ENDPOINT)).toBe("http://browser.default.svc.cluster.local:3000/pressure?token=s3cret-token");
    expect(browserPressureUrl("wss://b.example/chromium?token=t")).toBe("https://b.example/pressure?token=t");
  });
});

describe("fetchBrowserPressure", () => {
  beforeEach(() => {
    mockConfig.BROWSER_CDP_ENDPOINT = ENDPOINT;
  });

  it("parses browserless v2 pressure and flags a full queue", async () => {
    mockFetch.mockResolvedValue(pressureResponse({ isAvailable: false, running: 2, maxConcurrent: 2, queued: 10, maxQueued: 10 }));
    await expect(fetchBrowserPressure()).resolves.toEqual({
      reachable: true, status: 200, queueFull: true, running: 2, maxConcurrent: 2, queued: 10, maxQueued: 10,
    });
    expect(mockFetch.mock.calls[0]![0]).toBe("http://browser.default.svc.cluster.local:3000/pressure?token=s3cret-token");
  });

  it("reports a non-full queue", async () => {
    mockFetch.mockResolvedValue(pressureResponse({ running: 1, maxConcurrent: 2, queued: 0, maxQueued: 10 }));
    expect((await fetchBrowserPressure()).queueFull).toBe(false);
  });

  it("reports only the error name when the fetch throws", async () => {
    const err = new TypeError(`fetch failed for ${ENDPOINT}`);
    mockFetch.mockRejectedValue(err);
    const result = await fetchBrowserPressure();
    expect(result).toEqual({ reachable: false, error: "TypeError" });
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("reports the status of a non-2xx response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(fetchBrowserPressure()).resolves.toEqual({ reachable: false, status: 401 });
  });
});

describe("waitForBrowserCapacity", () => {
  it("does nothing when no endpoint is set", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    await waitForBrowserCapacity("test", sleep);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns at once when the queue has room", async () => {
    mockConfig.BROWSER_CDP_ENDPOINT = ENDPOINT;
    mockFetch.mockResolvedValue(pressureResponse({ running: 2, maxConcurrent: 2, queued: 3, maxQueued: 10 }));
    const sleep = vi.fn(async (_ms: number) => {});
    await waitForBrowserCapacity("test", sleep);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits out a full queue that frees up", async () => {
    mockConfig.BROWSER_CDP_ENDPOINT = ENDPOINT;
    mockFetch
      .mockResolvedValueOnce(pressureResponse({ queued: 10, maxQueued: 10 }))
      .mockResolvedValueOnce(pressureResponse({ queued: 4, maxQueued: 10 }));
    const sleep = vi.fn(async (_ms: number) => {});
    await waitForBrowserCapacity("test", sleep);
    expect(sleep.mock.calls).toEqual([[30_000]]);
  });

  it("retries three times with bounded backoff, then throws without the token", async () => {
    mockConfig.BROWSER_CDP_ENDPOINT = ENDPOINT;
    mockFetch.mockResolvedValue(pressureResponse({ queued: 10, maxQueued: 10 }));
    const sleep = vi.fn(async (_ms: number) => {});
    const err = await waitForBrowserCapacity("test", sleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("shared browser service queue is full (ws://browser.default.svc.cluster.local:3000/)");
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([...BROWSER_CAPACITY_RETRY_DELAYS_MS]);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(loggedText()).not.toContain("token=");
  });

  it("proceeds without waiting when the service is unreachable or the response is unexpected", async () => {
    mockConfig.BROWSER_CDP_ENDPOINT = ENDPOINT;
    const sleep = vi.fn(async (_ms: number) => {});

    mockFetch.mockRejectedValueOnce(new TypeError(`connect ECONNREFUSED ${ENDPOINT}`));
    await waitForBrowserCapacity("test", sleep);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await waitForBrowserCapacity("test", sleep);
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ unexpected: true }) });
    await waitForBrowserCapacity("test", sleep);

    expect(sleep).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledTimes(3);
    expect(loggedText()).not.toContain("token=");
  });
});
