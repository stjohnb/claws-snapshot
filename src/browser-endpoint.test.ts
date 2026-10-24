import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig, mockFetch } = vi.hoisted(() => ({
  mockConfig: { BROWSER_CDP_ENDPOINT: "" },
  mockFetch: vi.fn(),
}));

vi.mock("./config.js", () => mockConfig);
vi.stubGlobal("fetch", mockFetch);

import {
  browserPressureUrl,
  fetchBrowserPressure,
  playwrightMcpServer,
  redactedBrowserEndpoint,
  usesRemoteBrowser,
} from "./browser-endpoint.js";

const ENDPOINT = "ws://browser.default.svc.cluster.local:3000/?token=s3cret-token";

function pressureResponse(pressure: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => ({ pressure }) };
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
