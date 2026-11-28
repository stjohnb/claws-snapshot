import * as config from "./config.js";

/**
 * Shared cluster browser service (#3102). When `CLAWS_BROWSER_CDP_ENDPOINT` is
 * set, every Playwright MCP server connects to that browserless endpoint
 * instead of launching a local Chromium. The URL carries the browserless token
 * in its query string, so it travels only in env (`PLAYWRIGHT_MCP_CDP_ENDPOINT`,
 * the env twin of `--cdp-endpoint`) — never in argv, a Pod spec or a log line.
 */

export const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp@latest";
export const PLAYWRIGHT_CDP_ENV_KEY = "PLAYWRIGHT_MCP_CDP_ENDPOINT";

const PRESSURE_TIMEOUT_MS = 10_000;

export interface PlaywrightMcpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** True when Playwright MCP servers should use the shared browser service. */
export function usesRemoteBrowser(): boolean {
  return config.BROWSER_CDP_ENDPOINT !== "";
}

/**
 * The `playwright` MCP server entry for an MCP config file. `localArgs` are the
 * flags for a local Chromium (`--headless`, `--user-data-dir …`); a remote
 * browser takes neither, and gets the endpoint in the server's `env` instead.
 */
export function playwrightMcpServer(localArgs: string[]): PlaywrightMcpServer {
  if (!usesRemoteBrowser()) return { command: "npx", args: [PLAYWRIGHT_MCP_PACKAGE, ...localArgs] };
  return {
    command: "npx",
    args: [PLAYWRIGHT_MCP_PACKAGE],
    env: { [PLAYWRIGHT_CDP_ENV_KEY]: config.BROWSER_CDP_ENDPOINT },
  };
}

/** The endpoint with its query string (the token) and credentials removed, for logs and the `/config` connectivity checks. */
export function redactedBrowserEndpoint(): string {
  try {
    const url = new URL(config.BROWSER_CDP_ENDPOINT);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "(unparseable endpoint)";
  }
}

export interface BrowserPressure {
  reachable: boolean;
  status?: number;
  /** Error name (never its message, which can embed the URL) when unreachable. */
  error?: string;
  /** Unset when the response did not carry both queue counts. */
  queueFull?: boolean;
  running?: number;
  maxConcurrent?: number;
  queued?: number;
  maxQueued?: number;
}

/** `ws(s)://host:port/path?token=…` → `http(s)://host:port/pressure?token=…`. */
export function browserPressureUrl(endpoint: string): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/pressure";
  return url.toString();
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Probe browserless v2's `/pressure` endpoint. Never throws, and never returns
 * the URL or a raw error message.
 */
export async function fetchBrowserPressure(timeoutMs = PRESSURE_TIMEOUT_MS): Promise<BrowserPressure> {
  let url: string;
  try {
    url = browserPressureUrl(config.BROWSER_CDP_ENDPOINT);
  } catch {
    return { reachable: false, error: "InvalidURL" };
  }
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.name : "Error" };
  }
  if (!res.ok) return { reachable: false, status: res.status };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { reachable: true, status: res.status };
  }
  const pressure = (body as { pressure?: Record<string, unknown> } | null)?.pressure;
  const running = num(pressure?.["running"]);
  const maxConcurrent = num(pressure?.["maxConcurrent"]);
  const queued = num(pressure?.["queued"]);
  const maxQueued = num(pressure?.["maxQueued"]);
  return {
    reachable: true,
    status: res.status,
    ...(queued !== undefined && maxQueued !== undefined ? { queueFull: queued >= maxQueued } : {}),
    running,
    maxConcurrent,
    queued,
    maxQueued,
  };
}

const CAPACITY_POLL_MS = 5_000;

/**
 * Wait until the shared browser service has room for another session: poll
 * {@link fetchBrowserPressure} until its queue is not full. An unreachable
 * service or a response without queue counts counts as room, so the caller's
 * own connect surfaces the real error. Throws after `maxWaitMs`.
 */
export async function waitForBrowserCapacity(
  label: string,
  maxWaitMs: number,
  pollMs = CAPACITY_POLL_MS,
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const pressure = await fetchBrowserPressure();
    if (pressure.queueFull !== true) return;
    if (Date.now() + pollMs > deadline) {
      throw new Error(`${label}: the shared browser service stayed full for ${Math.round(maxWaitMs / 1000)}s`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Pinned Playwright MCP for the wall explorer's agent browser: with an explicit
 * `--isolated` over CDP this version opens a new browser context that applies
 * the config file's `contextOptions` (viewport, colour scheme, the Grafana
 * Authorization header), so that behaviour cannot drift under `@latest`.
 */
export const PLAYWRIGHT_MCP_PINNED = "@playwright/mcp@0.0.85";

/** The fleet Grafana origin (`https://host[:port]`), or "" when the URL is unparseable. */
export function grafanaOrigin(): string {
  try {
    return new URL(config.FLEET_GRAFANA_URL).origin;
  } catch {
    return "";
  }
}

/**
 * The `playwright` MCP server entry for the wall explorer's headless agent:
 * the pinned package, restricted to the fleet Grafana origin, at the wall's
 * 1920×1080 viewport, reading its context options (which carry the
 * Authorization header) from `configPath`. The browserless endpoint goes in
 * env only, never argv; the credential lives only in the config file.
 */
export function grafanaBrowserMcpServer(configPath: string): PlaywrightMcpServer {
  return {
    command: "npx",
    args: [
      PLAYWRIGHT_MCP_PINNED,
      "--config", configPath,
      "--isolated",
      "--allowed-origins", grafanaOrigin(),
      "--viewport-size", "1920x1080",
    ],
    env: { [PLAYWRIGHT_CDP_ENV_KEY]: config.BROWSER_CDP_ENDPOINT },
  };
}
