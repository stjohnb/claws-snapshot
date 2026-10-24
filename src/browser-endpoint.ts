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
