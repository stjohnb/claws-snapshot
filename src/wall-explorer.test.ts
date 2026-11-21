import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockConfig, mockFetch, mockGh, mockChromium, mockCapacity } = vi.hoisted(() => ({
  mockConfig: {
    FLEET_GRAFANA_URL: "https://grafana.example.net",
    BROWSER_CDP_ENDPOINT: "ws://browser.svc:3000/?token=s3cret-token",
  },
  mockFetch: vi.fn(),
  mockGh: { fetchRepoFileContent: vi.fn() },
  mockChromium: { connectOverCDP: vi.fn() },
  mockCapacity: vi.fn(async () => undefined),
}));

vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), mockConfig));
vi.mock("./github.js", () => mockGh);
vi.mock("./log.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("playwright-core", () => ({ chromium: mockChromium }));
vi.mock("./browser-endpoint.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser-endpoint.js")>()),
  waitForBrowserCapacity: mockCapacity,
}));
vi.stubGlobal("fetch", mockFetch);

import {
  captureWall,
  emptyDir,
  fetchDashboardInfo,
  flattenPanels,
  grafanaRouteHandler,
  looksLikeSignIn,
  panelIdFromKey,
  parsePlaylistFile,
  playlistItemUids,
  resolveWallPlaylist,
  writeAgentBrowserConfig,
  writeManifest,
} from "./wall-explorer.js";
import { grafanaBrowserMcpServer } from "./browser-endpoint.js";

const AUTH = "Basic Y2xhd3Mtc2VydmljZTpwdw==";

function json(body: unknown, status = 200) {
  return { status, ok: status === 200, json: async () => body, body: { cancel: async () => undefined } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("playlist", () => {
  it("parses the fallback file, skipping blanks and comments", () => {
    expect(parsePlaylistFile("# wall\nwall-overview\n\nfleet-wall-overview  # second\nwall-overview\n")).toEqual([
      "wall-overview", "fleet-wall-overview",
    ]);
  });

  it("keeps only dashboard_by_uid items", () => {
    expect(playlistItemUids([
      { type: "dashboard_by_uid", value: "a" },
      { type: "dashboard_by_tag", value: "wall" },
      { type: "dashboard_by_uid", value: "b" },
    ])).toEqual(["a", "b"]);
    expect(playlistItemUids({})).toEqual([]);
  });

  it("reads the playlist named Wall live, with the service account's header", async () => {
    mockFetch
      .mockResolvedValueOnce(json([{ uid: "other", name: "TV" }, { uid: "eg4h98gvpvu9sc", name: "Wall" }]))
      .mockResolvedValueOnce(json([{ type: "dashboard_by_uid", value: "wall-overview" }]));
    await expect(resolveWallPlaylist(AUTH)).resolves.toEqual({ uids: ["wall-overview"], source: "grafana" });
    expect(mockFetch.mock.calls[1][0]).toBe("https://grafana.example.net/api/playlists/eg4h98gvpvu9sc/items");
    for (const call of mockFetch.mock.calls) expect(call[1].headers.Authorization).toBe(AUTH);
    expect(mockGh.fetchRepoFileContent).not.toHaveBeenCalled();
  });

  it("falls back to the fleet-infra file when Grafana fails", async () => {
    mockFetch.mockResolvedValueOnce(json(null, 302));
    mockGh.fetchRepoFileContent.mockResolvedValueOnce("wall-overview\nwall-app-forgejo\n");
    await expect(resolveWallPlaylist(AUTH)).resolves.toEqual({ uids: ["wall-overview", "wall-app-forgejo"], source: "fallback" });
    expect(mockGh.fetchRepoFileContent).toHaveBeenCalledWith("St-John-Software/fleet-infra", "migrations/grafana-wall-playlist.txt");
  });

  it("throws when both fail", async () => {
    mockFetch.mockRejectedValueOnce(new Error("down"));
    mockGh.fetchRepoFileContent.mockResolvedValueOnce(null);
    await expect(resolveWallPlaylist(AUTH)).rejects.toThrow(/unreadable/);
  });
});

describe("dashboard info", () => {
  it("flattens panels inside rows and skips row panels", () => {
    expect(flattenPanels([
      { id: 1, type: "stat", title: "Up" },
      { id: 2, type: "row", title: "More", panels: [{ id: 3, type: "timeseries", title: "Rate" }] },
    ])).toEqual([{ id: 1, title: "Up" }, { id: 3, title: "Rate" }]);
  });

  it("reads title and folder, and keeps the uid when the read fails", async () => {
    mockFetch.mockResolvedValueOnce(json({ dashboard: { title: "Forgejo", panels: [{ id: 4, type: "stat", title: "p95" }] }, meta: { folderTitle: "Prod" } }));
    await expect(fetchDashboardInfo(AUTH, "wall-app-forgejo")).resolves.toEqual({
      uid: "wall-app-forgejo", title: "Forgejo", folder: "Prod", panels: [{ id: 4, title: "p95" }],
    });
    mockFetch.mockResolvedValueOnce(json(null, 404));
    await expect(fetchDashboardInfo(AUTH, "gone")).resolves.toEqual({ uid: "gone", title: "gone", folder: "", panels: [] });
  });
});

describe("grafanaRouteHandler", () => {
  function route(url: string) {
    return {
      request: () => ({ url: () => url, headers: () => ({ accept: "*/*" }) }),
      continue: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
  }

  it("adds the header only to Grafana-origin requests", async () => {
    const handler = grafanaRouteHandler("https://grafana.example.net", AUTH);
    const own = route("https://grafana.example.net/public/build/app.js");
    await handler(own as never);
    expect(own.continue).toHaveBeenCalledWith({ headers: { accept: "*/*", authorization: AUTH } });
    expect(own.abort).not.toHaveBeenCalled();
  });

  it("aborts every other origin without the header", async () => {
    const handler = grafanaRouteHandler("https://grafana.example.net", AUTH);
    for (const url of ["https://auth.example.net/flows/", "https://grafana.example.net.evil.test/x", "not a url"]) {
      const other = route(url);
      await handler(other as never);
      expect(other.continue).not.toHaveBeenCalled();
      expect(other.abort).toHaveBeenCalled();
    }
  });
});

describe("looksLikeSignIn", () => {
  const origin = "https://grafana.example.net";
  it("flags another host, a login path and a password form", () => {
    expect(looksLikeSignIn("https://auth.example.net/if/flow/default-authentication-flow/", origin, 0)).toBe(true);
    expect(looksLikeSignIn("https://grafana.example.net/login", origin, 0)).toBe(true);
    expect(looksLikeSignIn("https://grafana.example.net/d/wall-overview?kiosk", origin, 1)).toBe(true);
  });
  it("accepts the dashboard", () => {
    expect(looksLikeSignIn("https://grafana.example.net/d/wall-overview?kiosk&theme=dark", origin, 0)).toBe(false);
  });
  it("parses panel keys", () => {
    expect(panelIdFromKey("panel-12")).toBe(12);
    expect(panelIdFromKey("panel-x")).toBeNull();
  });
});

describe("captureWall", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wall-explorer-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fakeBrowser(pageUrl: string, opts: { passwordInputs?: number; height?: number } = {}) {
    const handle = { boundingBox: vi.fn(async () => ({ x: 0, y: 0, width: 400, height: 200 })), screenshot: vi.fn(async () => undefined) };
    const page = {
      goto: vi.fn(async () => undefined),
      waitForLoadState: vi.fn(async () => undefined),
      waitForFunction: vi.fn(async () => undefined),
      waitForTimeout: vi.fn(async () => undefined),
      url: () => pageUrl,
      locator: () => ({ count: async () => opts.passwordInputs ?? 0 }),
      screenshot: vi.fn(async () => undefined),
      evaluate: vi.fn(async (script: string) => script.includes("querySelectorAll")
        ? [{ key: "panel-4", title: "", noData: true, errorText: "" }]
        : opts.height ?? 1080),
      $$: vi.fn(async () => [handle]),
    };
    const context = { route: vi.fn(async () => undefined), newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
    const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => undefined) };
    return { browser, context, page, handle };
  }

  it("renders each dashboard at the wall's size and theme and records its panels", async () => {
    const { browser, context, page } = fakeBrowser("https://grafana.example.net/d/wall-overview?kiosk&theme=dark", { height: 1500 });
    mockChromium.connectOverCDP.mockResolvedValue(browser);
    const result = await captureWall([{ uid: "wall-overview", title: "Overview", folder: "", panels: [{ id: 4, title: "Requests" }] }], dir, AUTH);
    expect(result.authRedirect).toBe(false);
    expect(mockCapacity).toHaveBeenCalled();
    expect(mockChromium.connectOverCDP).toHaveBeenCalledWith("ws://browser.svc:3000/?token=s3cret-token");
    expect(browser.newContext).toHaveBeenCalledWith({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: "dark" });
    expect(context.route).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect((page.goto.mock.calls[0] as unknown as [string])[0]).toBe("https://grafana.example.net/d/wall-overview?kiosk&theme=dark");
    const d = result.dashboards[0];
    expect(d.captureError).toBeNull();
    expect(d.screenshot).toBe(path.join(dir, "wall-overview.png"));
    expect(d.clipped).toBe(true);
    expect(d.fullPageScreenshot).toBe(path.join(dir, "wall-overview-full.png"));
    expect(d.panels).toEqual([{ id: 4, title: "Requests", crop: path.join(dir, "wall-overview-panel-4.png"), box: { x: 0, y: 0, width: 400, height: 200 }, noData: true, errorText: "" }]);
    expect(browser.close).toHaveBeenCalled();
  });

  it("stops after the first dashboard when it lands on a sign-in page", async () => {
    const { browser, page } = fakeBrowser("https://auth.example.net/if/flow/x/");
    mockChromium.connectOverCDP.mockResolvedValue(browser);
    const result = await captureWall([
      { uid: "a", title: "A", folder: "", panels: [] },
      { uid: "b", title: "B", folder: "", panels: [] },
    ], dir, AUTH);
    expect(result.authRedirect).toBe(true);
    expect(result.dashboards).toHaveLength(1);
    expect(result.dashboards[0].captureError).toBe("auth-redirect");
    expect(page.screenshot).not.toHaveBeenCalled();
  });

  it("records a connect failure by error name only", async () => {
    mockChromium.connectOverCDP.mockRejectedValue(new Error("connect ws://browser.svc:3000/?token=s3cret-token failed"));
    const result = await captureWall([{ uid: "a", title: "A", folder: "", panels: [] }], dir, AUTH);
    expect(result.dashboards[0].captureError).toBe("Error");
    expect(JSON.stringify(result)).not.toContain("s3cret");
  });

  it("empties the scratch dir and writes the manifest", () => {
    fs.writeFileSync(path.join(dir, "old.png"), "x");
    emptyDir(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
    const file = writeManifest(dir, { capturedAt: "t", playlistSource: "grafana", dashboards: [] });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).playlistSource).toBe("grafana");
  });
});

describe("agent browser config", () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wall-explorer-mcp-")), "agent-mcp");
  });

  it("writes the header only into a 0600 file the MCP server reads, never argv", () => {
    const file = writeAgentBrowserConfig(dir, AUTH);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      browser: { contextOptions: { viewport: { width: 1920, height: 1080 }, colorScheme: "dark", extraHTTPHeaders: { Authorization: AUTH } } },
    });
    const server = grafanaBrowserMcpServer(file);
    expect(server.args).toContain("@playwright/mcp@0.0.85");
    expect(server.args).toContain("https://grafana.example.net");
    expect(server.args.join(" ")).not.toContain(AUTH);
    expect(server.args.join(" ")).not.toContain("s3cret");
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });
});
