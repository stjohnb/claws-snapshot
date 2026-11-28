/**
 * The office wall's dashboards, read and rendered the way dashpi shows them
 * (#clw_01M7Q9Q20W7AQ7XT6C8RJBWWF4). The daily `wall-explorer` job
 * (src/jobs/wall-explorer.ts, docs/jobs/wall-explorer.md) uses this module to:
 *
 * - resolve the home-Grafana playlist `Wall` live, falling back to fleet-infra
 *   `migrations/grafana-wall-playlist.txt`;
 * - render each dashboard in a real browser on the shared browserless service
 *   (1920×1080, device pixel ratio 1, kiosk, dark theme, the dashboard's own
 *   time range) and screenshot the whole wall and every panel;
 * - write the agent's Playwright MCP browser config, which holds the Grafana
 *   Authorization header.
 *
 * Every Grafana request is signed in as the `claws-service` Authentik account
 * through {@link grafanaAuthorization}'s Basic header; there is no other
 * credential. The header is never logged.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page, type Route } from "playwright-core";
import * as config from "./config.js";
import * as gh from "./github.js";
import * as log from "./log.js";
import { grafanaOrigin, waitForBrowserCapacity } from "./browser-endpoint.js";

const COMPONENT = "wall-explorer";

export const WALL_PLAYLIST_NAME = "Wall";
export const WALL_PLAYLIST_FALLBACK_REPO = "St-John-Software/fleet-infra";
export const WALL_PLAYLIST_FALLBACK_PATH = "migrations/grafana-wall-playlist.txt";

/** The dashpi kiosk's viewport (nixos-config docs/dashpi.md). */
export const WALL_VIEWPORT = { width: 1920, height: 1080 } as const;

const API_TIMEOUT_MS = 20_000;
/** Cap on waiting for a dashboard's network and panels to settle. */
const RENDER_SETTLE_MS = 60_000;
/** Extra pause after settling, for panel animations and late paints. */
const RENDER_GRACE_MS = 2_000;
/** How long to wait for a free browserless session before giving up on a dashboard. */
const BROWSER_CAPACITY_WAIT_MS = 5 * 60_000;

// ── Grafana API ──

/** GET a Grafana API path as JSON with the service account's header; throws on a non-200. */
async function grafanaGet(authorization: string, apiPath: string): Promise<unknown> {
  const started = Date.now();
  const res = await fetch(`${config.FLEET_GRAFANA_URL.replace(/\/+$/, "")}${apiPath}`, {
    headers: { Authorization: authorization, Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  log.debug("wall grafana read", { component: COMPONENT, target: apiPath, status: res.status, duration_ms: Date.now() - started });
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Grafana ${apiPath} returned HTTP ${res.status}`);
  }
  return await res.json();
}

/** The fallback file's dashboard uids: one per line, blank lines and `#` comments skipped. */
export function parsePlaylistFile(text: string): string[] {
  const uids: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (line && !uids.includes(line)) uids.push(line);
  }
  return uids;
}

/** The `dashboard_by_uid` values of a playlist's items, in order. */
export function playlistItemUids(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const uids: string[] = [];
  for (const item of items) {
    const it = item as { type?: unknown; value?: unknown } | null;
    if (it?.type === "dashboard_by_uid" && typeof it.value === "string" && it.value && !uids.includes(it.value)) uids.push(it.value);
  }
  return uids;
}

/** The Wall playlist's dashboard uids, read live from Grafana. Throws when Grafana has no `Wall` playlist or it is empty. */
export async function fetchLivePlaylist(authorization: string): Promise<string[]> {
  const playlists = await grafanaGet(authorization, "/api/playlists");
  const wall = Array.isArray(playlists)
    ? (playlists as { uid?: unknown; name?: unknown }[]).find((p) => p?.name === WALL_PLAYLIST_NAME)
    : undefined;
  if (!wall || typeof wall.uid !== "string") throw new Error(`no Grafana playlist named ${WALL_PLAYLIST_NAME}`);
  const uids = playlistItemUids(await grafanaGet(authorization, `/api/playlists/${encodeURIComponent(wall.uid)}/items`));
  if (uids.length === 0) throw new Error(`Grafana playlist ${WALL_PLAYLIST_NAME} lists no dashboards by uid`);
  return uids;
}

export interface WallPlaylist {
  uids: string[];
  source: "grafana" | "fallback";
}

/**
 * The Wall playlist's dashboard uids: live from Grafana, else from the
 * fleet-infra fallback file. Throws when both fail.
 */
export async function resolveWallPlaylist(authorization: string): Promise<WallPlaylist> {
  try {
    return { uids: await fetchLivePlaylist(authorization), source: "grafana" };
  } catch (err) {
    log.warn("wall playlist unreadable from Grafana, using the fallback file", { component: COMPONENT }, err);
  }
  const text = await gh.fetchRepoFileContent(WALL_PLAYLIST_FALLBACK_REPO, WALL_PLAYLIST_FALLBACK_PATH);
  const uids = text ? parsePlaylistFile(text) : [];
  if (uids.length === 0) throw new Error(`the Wall playlist is unreadable from Grafana and ${WALL_PLAYLIST_FALLBACK_PATH} lists no dashboards`);
  return { uids, source: "fallback" };
}

export interface WallPanelInfo {
  id: number;
  title: string;
}

export interface WallDashboardInfo {
  uid: string;
  title: string;
  /** The folder title; "" for the General folder or when unknown. */
  folder: string;
  panels: WallPanelInfo[];
}

/** Every panel in a dashboard model, including those nested in collapsed rows. */
export function flattenPanels(panels: unknown): WallPanelInfo[] {
  const out: WallPanelInfo[] = [];
  const visit = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const p of list as { id?: unknown; title?: unknown; type?: unknown; panels?: unknown }[]) {
      if (!p || typeof p !== "object") continue;
      if (p.type !== "row" && typeof p.id === "number") out.push({ id: p.id, title: typeof p.title === "string" ? p.title : "" });
      visit(p.panels);
    }
  };
  visit(panels);
  return out;
}

/** A dashboard's title, folder and panels; a failed read keeps the uid with no panels, so the capture still runs. */
export async function fetchDashboardInfo(authorization: string, uid: string): Promise<WallDashboardInfo> {
  try {
    const body = await grafanaGet(authorization, `/api/dashboards/uid/${encodeURIComponent(uid)}`) as {
      dashboard?: { title?: unknown; panels?: unknown };
      meta?: { folderTitle?: unknown };
    };
    return {
      uid,
      title: typeof body.dashboard?.title === "string" ? body.dashboard.title : uid,
      folder: typeof body.meta?.folderTitle === "string" ? body.meta.folderTitle : "",
      panels: flattenPanels(body.dashboard?.panels),
    };
  } catch (err) {
    log.warn("wall dashboard model unreadable", { component: COMPONENT, dashboard: uid }, err);
    return { uid, title: uid, folder: "", panels: [] };
  }
}

// ── Capture ──

/**
 * The capture context's request handler: Grafana-origin requests carry the
 * Authorization header (every asset needs it, or Authentik redirects it);
 * every other origin is aborted so the credential and the browser stay inside
 * Grafana.
 */
export function grafanaRouteHandler(origin: string, authorization: string): (route: Route) => Promise<void> {
  return async (route) => {
    const request = route.request();
    let requestOrigin = "";
    try {
      requestOrigin = new URL(request.url()).origin;
    } catch {
      // unparseable: aborted below
    }
    if (origin && requestOrigin === origin) {
      await route.continue({ headers: { ...request.headers(), authorization } });
      return;
    }
    await route.abort("blockedbyclient");
  };
}

/** True when the browser was refused: it left Grafana's origin, or landed on a login page or a password form. */
export function looksLikeSignIn(pageUrl: string, origin: string, passwordInputs: number): boolean {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return true;
  }
  if (url.origin !== origin) return true;
  if (/^\/login(\/|$)/.test(url.pathname)) return true;
  return passwordInputs > 0;
}

export interface PanelCapture {
  id: number;
  title: string;
  /** The panel's own screenshot, or null when it could not be taken. */
  crop: string | null;
  box: { x: number; y: number; width: number; height: number } | null;
  noData: boolean;
  errorText: string;
}

export interface DashboardCapture {
  uid: string;
  title: string;
  folder: string;
  url: string;
  /** The 1920×1080 wall view. */
  screenshot: string | null;
  /** Set only when the page is taller than the wall shows. */
  fullPageScreenshot: string | null;
  clipped: boolean;
  panels: PanelCapture[];
  captureError: string | null;
  durationMs: number;
}

export interface WallManifest {
  capturedAt: string;
  playlistSource: WallPlaylist["source"];
  dashboards: DashboardCapture[];
}

interface RenderedPanel {
  key: string;
  title: string;
  noData: boolean;
  errorText: string;
}

/** `panel-<id>` → id, or null. */
export function panelIdFromKey(key: string): number | null {
  const m = /^panel-(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

export function dashboardUrl(uid: string): string {
  return `${config.FLEET_GRAFANA_URL.replace(/\/+$/, "")}/d/${encodeURIComponent(uid)}?kiosk&theme=dark`;
}

function safeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "dashboard";
}

// In-page expressions, as strings: the service's tsconfig has no DOM lib.
const PANELS_SETTLED_SCRIPT =
  `!document.querySelector('[aria-label="Panel loading bar"], [data-testid*="loading-bar"], [data-testid="Spinner"]')`;
/** Every `[data-viz-panel-key]` panel's key, visible title, "No data" and status error, in document order. */
const PANEL_SCAN_SCRIPT = `Array.from(document.querySelectorAll("[data-viz-panel-key]")).map((el) => {
  const titleEl = el.querySelector('[data-testid*="Panel header"] h2, h2');
  const statusEl = el.querySelector('[data-testid*="Panel status"]');
  const text = el.innerText || "";
  return {
    key: el.getAttribute("data-viz-panel-key") || "",
    title: ((titleEl && titleEl.textContent) || "").trim(),
    noData: /\\bNo data\\b/.test(text),
    errorText: ((statusEl && (statusEl.getAttribute("aria-label") || statusEl.textContent)) || "").trim(),
  };
})`;
const PAGE_HEIGHT_SCRIPT = `Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)`;

async function settle(page: Page): Promise<void> {
  const deadline = Date.now() + RENDER_SETTLE_MS;
  try {
    await page.waitForLoadState("networkidle", { timeout: RENDER_SETTLE_MS });
  } catch {
    // capped: capture what is on screen
  }
  try {
    await page.waitForFunction(
      PANELS_SETTLED_SCRIPT,
      undefined,
      { timeout: Math.max(1_000, deadline - Date.now()) },
    );
  } catch {
    // capped
  }
  await page.waitForTimeout(RENDER_GRACE_MS);
}

/** Render one dashboard in a fresh context and screenshot it into `outDir`. Never throws. */
export async function captureDashboard(
  browser: Browser,
  dashboard: WallDashboardInfo,
  outDir: string,
  authorization: string,
): Promise<DashboardCapture> {
  const started = Date.now();
  const origin = grafanaOrigin();
  const url = dashboardUrl(dashboard.uid);
  const stem = safeFileStem(dashboard.uid);
  const result: DashboardCapture = {
    uid: dashboard.uid,
    title: dashboard.title,
    folder: dashboard.folder,
    url,
    screenshot: null,
    fullPageScreenshot: null,
    clipped: false,
    panels: [],
    captureError: null,
    durationMs: 0,
  };
  const context = await browser.newContext({
    viewport: { ...WALL_VIEWPORT },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  try {
    await context.route("**/*", grafanaRouteHandler(origin, authorization));
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: RENDER_SETTLE_MS });
    await settle(page);
    if (looksLikeSignIn(page.url(), origin, await page.locator('input[type="password"]').count())) {
      result.captureError = "auth-redirect";
      return result;
    }

    result.screenshot = path.join(outDir, `${stem}.png`);
    await page.screenshot({ path: result.screenshot });

    const rendered = await page.evaluate(PANEL_SCAN_SCRIPT) as RenderedPanel[];

    const handles = await page.$$("[data-viz-panel-key]");
    for (let i = 0; i < handles.length; i++) {
      const info = rendered[i];
      const id = info ? panelIdFromKey(info.key) : null;
      if (!info || id === null) continue;
      const panel: PanelCapture = { id, title: info.title, crop: null, box: null, noData: info.noData, errorText: info.errorText };
      try {
        panel.box = await handles[i].boundingBox();
        const crop = path.join(outDir, `${stem}-panel-${id}.png`);
        await handles[i].screenshot({ path: crop });
        panel.crop = crop;
      } catch (err) {
        log.debug("wall panel crop failed", { component: COMPONENT, dashboard: dashboard.uid, panel: id, error: err instanceof Error ? err.name : "Error" });
      }
      result.panels.push(panel);
    }

    const height = Number(await page.evaluate(PAGE_HEIGHT_SCRIPT));
    if (height > WALL_VIEWPORT.height) {
      result.clipped = true;
      result.fullPageScreenshot = path.join(outDir, `${stem}-full.png`);
      await page.screenshot({ path: result.fullPageScreenshot, fullPage: true });
    }
  } catch (err) {
    result.captureError = err instanceof Error ? `${err.name}: ${err.message.split("\n")[0].slice(0, 200)}` : "capture failed";
  } finally {
    await context.close().catch(() => undefined);
    result.durationMs = Date.now() - started;
  }
  return result;
}

export interface WallCaptureResult {
  dashboards: DashboardCapture[];
  /** The first dashboard landed on a sign-in page, so the run stopped there. */
  authRedirect: boolean;
}

/**
 * Render every dashboard, one browserless session at a time: browserless runs
 * at most two sessions and kills one after five minutes, so each dashboard
 * waits for capacity and opens its own short session. Stops after the first
 * dashboard when it is refused sign-in.
 */
export async function captureWall(
  dashboards: readonly WallDashboardInfo[],
  outDir: string,
  authorization: string,
): Promise<WallCaptureResult> {
  const out: DashboardCapture[] = [];
  for (const [index, dashboard] of dashboards.entries()) {
    let capture: DashboardCapture;
    let browser: Browser | undefined;
    try {
      await waitForBrowserCapacity(COMPONENT, BROWSER_CAPACITY_WAIT_MS);
      browser = await chromium.connectOverCDP(config.BROWSER_CDP_ENDPOINT);
      capture = await captureDashboard(browser, dashboard, outDir, authorization);
    } catch (err) {
      capture = {
        uid: dashboard.uid, title: dashboard.title, folder: dashboard.folder, url: dashboardUrl(dashboard.uid),
        screenshot: null, fullPageScreenshot: null, clipped: false, panels: [],
        // Never the raw message: a connect error can embed the endpoint's token.
        captureError: err instanceof Error ? err.name : "Error",
        durationMs: 0,
      };
    } finally {
      await browser?.close().catch(() => undefined);
    }
    // Fill panel titles the page did not show from the dashboard model.
    for (const panel of capture.panels) {
      if (!panel.title) panel.title = dashboard.panels.find((p) => p.id === panel.id)?.title ?? "";
    }
    out.push(capture);
    log.debug("wall dashboard captured", {
      component: COMPONENT, dashboard: dashboard.uid, panels: capture.panels.length,
      capture_error: capture.captureError ?? "", duration_ms: capture.durationMs,
    });
    if (index === 0 && capture.captureError === "auth-redirect") return { dashboards: out, authRedirect: true };
  }
  return { dashboards: out, authRedirect: false };
}

/** Empty the scratch dir: screenshots are kept only until the next run. */
export function emptyDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
}

export function writeManifest(dir: string, manifest: WallManifest): string {
  const file = path.join(dir, "manifest.json");
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}

// ── Agent browser ──

/** The agent's Playwright MCP `contextOptions`: the wall's viewport and theme, signed in to Grafana. */
export function agentBrowserContextOptions(authorization: string): Record<string, unknown> {
  return {
    viewport: { ...WALL_VIEWPORT },
    colorScheme: "dark",
    extraHTTPHeaders: { Authorization: authorization },
  };
}

/**
 * Write the agent's Playwright MCP config to `dir` (the job's agent MCP dir,
 * never a worktree) with mode 0600: it holds the long-lived app password, so
 * the caller deletes it in a `finally`.
 */
export function writeAgentBrowserConfig(dir: string, authorization: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, "wall-explorer-browser.json");
  fs.writeFileSync(file, JSON.stringify({ browser: { contextOptions: agentBrowserContextOptions(authorization) } }, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}
