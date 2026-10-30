/**
 * Claws' own Prometheus metrics (#clw_01M59ZXZ26S1WBJQRSBGJXZVPZ): per-route
 * dashboard latency, forge call timings, Node runtime health, the running
 * version, and the dashboard's unavailable window across a rollout.
 *
 * Served by {@link startMetricsServer} on its own port (`CLAWS_METRICS_PORT`),
 * never the dashboard port, so nothing here is reachable through the Ingress.
 * The rollout window is anchored at SIGTERM: the shutdown path writes a marker
 * file ({@link recordShutdownMarker}) and the next process reads it once it is
 * listening ({@link readRolloutGap}). See docs/metrics.md.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Registry, collectDefaultMetrics, Gauge, Histogram } from "prom-client";
import { WORK_DIR } from "./config.js";
import { emit } from "./log-core.js";
import { VERSION } from "./version.js";

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "claws_" });

const LATENCY_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

const httpDuration = new Histogram({
  name: "claws_http_request_duration_seconds",
  help: "Dashboard and API request duration, by matched route pattern",
  labelNames: ["route", "method", "status_class"] as const,
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

const httpInFlight = new Gauge({
  name: "claws_http_requests_in_flight",
  help: "Dashboard and API requests currently being served",
  registers: [registry],
});

const forgeDuration = new Histogram({
  name: "claws_forge_request_duration_seconds",
  help: "Forge call duration: one Forgejo API request, or one github-external.ts gh call (with its retries)",
  labelNames: ["forge", "outcome"] as const,
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

const buildInfo = new Gauge({
  name: "claws_build_info",
  help: "Always 1; the version label names the running Claws build",
  labelNames: ["version"] as const,
  registers: [registry],
});
buildInfo.set({ version: VERSION }, 1);

const shuttingDownGauge = new Gauge({
  name: "claws_shutting_down",
  help: "1 once this process has received SIGTERM/SIGINT and begun shutting down",
  registers: [registry],
});
shuttingDownGauge.set(0);

const listeningGauge = new Gauge({
  name: "claws_process_listening_timestamp_seconds",
  help: "Unix time this process's dashboard server started listening",
  registers: [registry],
});

const rolloutGapGauge = new Gauge({
  name: "claws_last_rollout_gap_seconds",
  help: "Previous process's SIGTERM to this process listening: the dashboard's unavailable window",
  // Labelled so the series is absent, not a misleading 0, until a marker is read.
  labelNames: ["previous_version"] as const,
  registers: [registry],
});

export const SHUTDOWN_PHASES = ["drain", "cancel", "auth_sync", "memory_flush", "close"] as const;
export type ShutdownPhase = (typeof SHUTDOWN_PHASES)[number];

const shutdownPhaseGauge = new Gauge({
  name: "claws_last_shutdown_phase_seconds",
  help: "Duration of each phase of the previous process's shutdown",
  labelNames: ["phase"] as const,
  registers: [registry],
});

const grafanaAuthOkGauge = new Gauge({
  name: "claws_grafana_auth_ok",
  help: "1 when the cluster's Grafana accepted Claws' last observability JWT probe, else 0",
  labelNames: ["cluster"] as const,
  registers: [registry],
});

// ── HTTP request timing ──

/** One matched route as Hono reports it (`matchedRoutes(c)`). */
export interface MatchedRoute {
  path: string;
}

/**
 * The route label for a request: the last matched route that is not a
 * wildcard middleware (`*`, `/*`), so the value is the bounded route pattern
 * (`/issues/:id`), never the raw path.
 */
export function routeLabel(matched: readonly MatchedRoute[]): string {
  for (let i = matched.length - 1; i >= 0; i--) {
    const p = matched[i]!.path;
    if (p !== "*" && p !== "/*") return p;
  }
  return "unmatched";
}

/** `2xx`…`5xx`; anything outside 100–599 is `unknown`. */
export function statusClass(status: number): string {
  if (!Number.isFinite(status) || status < 100 || status > 599) return "unknown";
  return `${Math.floor(status / 100)}xx`;
}

const RING_SIZE = 1000;

/** The last {@link RING_SIZE} durations (ms) for one route, for `latencySummary()`. */
interface RouteSamples {
  route: string;
  method: string;
  count: number;
  ring: Float64Array;
}

const samples = new Map<string, RouteSamples>();
const bootedAt = new Date().toISOString();

/** Record one finished request in the histogram and the per-route ring buffer. */
export function observeHttpRequest(route: string, method: string, status: number, durationMs: number): void {
  httpDuration.observe({ route, method, status_class: statusClass(status) }, durationMs / 1000);
  const key = `${method} ${route}`;
  let entry = samples.get(key);
  if (!entry) {
    entry = { route, method, count: 0, ring: new Float64Array(RING_SIZE) };
    samples.set(key, entry);
  }
  entry.ring[entry.count % RING_SIZE] = durationMs;
  entry.count++;
}

export function httpRequestStarted(): void {
  httpInFlight.inc();
}

export function httpRequestFinished(): void {
  httpInFlight.dec();
}

// ── Forge call timing ──

export type Forge = "github" | "forgejo";

/** Run one forge call, recording its duration and `ok`/`error` outcome. */
export async function timeForgeCall<T>(forge: Forge, fn: () => Promise<T>): Promise<T> {
  const end = forgeDuration.startTimer({ forge });
  try {
    const result = await fn();
    end({ outcome: "ok" });
    return result;
  } catch (err) {
    end({ outcome: "error" });
    throw err;
  }
}

// ── Grafana observability auth ──

/** Records the latest `probeGrafanaAuth` result for `cluster` (`prod` or `fleet`). */
export function setGrafanaAuthOk(cluster: string, ok: boolean): void {
  grafanaAuthOkGauge.set({ cluster }, ok ? 1 : 0);
}

// ── Process lifecycle ──

export function markShuttingDown(): void {
  shuttingDownGauge.set(1);
}

export function markListening(at: number): void {
  listeningGauge.set(at / 1000);
}

/** Phase durations in seconds; `close` is derived on read (see {@link readRolloutGap}). */
export type ShutdownMarkerPhases = Record<Exclude<ShutdownPhase, "close">, number>;

/** The `WORK_DIR/state/last-shutdown.json` contract (docs/metrics.md). */
export interface ShutdownMarker {
  version: string;
  /** ISO time the signal was received: the start of the dashboard's unavailable window. */
  shutdownStartedAt: string;
  phases: ShutdownMarkerPhases;
  /** ISO time `server.close()` returned. */
  serverClosedAt: string;
}

/**
 * `WORK_DIR/state/last-shutdown.json`, on the data PVC. Resolved on use, not at
 * import: github.ts and forgejo.ts import this module, and their tests mock
 * `config.js` partially.
 */
export function shutdownMarkerPath(): string {
  return path.join(WORK_DIR, "state", "last-shutdown.json");
}

/** A marker older than this was left by a shutdown that is not the one before this boot. */
const STALE_MARKER_MS = 24 * 60 * 60 * 1000;

/** Write the shutdown marker. Never throws: a failed write only loses the gap metric. */
export function recordShutdownMarker(marker: ShutdownMarker, file = shutdownMarkerPath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(marker) + "\n");
  } catch (err) {
    emit("warn", "[metrics] could not write shutdown marker", { err });
  }
}

export interface RolloutGap {
  previousVersion: string;
  rolloutGapMs: number;
  bootGapMs: number;
  phases: Record<ShutdownPhase, number>;
}

let lastRolloutGap: RolloutGap | null = null;

function parseMarker(raw: string): ShutdownMarker | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  const phases = m["phases"] as Record<string, unknown> | undefined;
  if (typeof m["version"] !== "string" || typeof m["shutdownStartedAt"] !== "string" || typeof m["serverClosedAt"] !== "string") return null;
  if (!phases || typeof phases !== "object") return null;
  if (Number.isNaN(Date.parse(m["shutdownStartedAt"])) || Number.isNaN(Date.parse(m["serverClosedAt"]))) return null;
  const parsed: Partial<ShutdownMarkerPhases> = {};
  for (const phase of ["drain", "cancel", "auth_sync", "memory_flush"] as const) {
    const v = phases[phase];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
    parsed[phase] = v;
  }
  return {
    version: m["version"],
    shutdownStartedAt: m["shutdownStartedAt"],
    serverClosedAt: m["serverClosedAt"],
    phases: parsed as ShutdownMarkerPhases,
  };
}

/**
 * Read the previous process's shutdown marker once this one is listening, set
 * `claws_last_rollout_gap_seconds` (listening − `shutdownStartedAt`) and the
 * phase gauges, and log one structured line. The marker is consumed, so a later
 * crash-restart cannot report the same shutdown again. A missing, malformed or
 * stale (> 24 h) marker leaves the gauges unset.
 */
export function readRolloutGap(listeningAt: number, file = shutdownMarkerPath()): RolloutGap | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    fs.unlinkSync(file);
  } catch {
    // best effort
  }
  const marker = parseMarker(raw);
  if (!marker) {
    emit("warn", "[metrics] ignoring malformed shutdown marker");
    return null;
  }
  const startedAt = Date.parse(marker.shutdownStartedAt);
  const closedAt = Date.parse(marker.serverClosedAt);
  const rolloutGapMs = listeningAt - startedAt;
  if (rolloutGapMs < 0 || rolloutGapMs > STALE_MARKER_MS) {
    emit("warn", "[metrics] ignoring stale shutdown marker", {
      context: { shutdownStartedAt: marker.shutdownStartedAt, previousVersion: marker.version },
    });
    return null;
  }
  const marked = marker.phases.drain + marker.phases.cancel + marker.phases.auth_sync + marker.phases.memory_flush;
  // The marker is written right after server.close(), so whatever the four
  // timed phases do not cover is the close step (waiter release + close).
  const close = Math.max(0, (closedAt - startedAt) / 1000 - marked);
  const phases: Record<ShutdownPhase, number> = { ...marker.phases, close };
  const gap: RolloutGap = { previousVersion: marker.version, rolloutGapMs, bootGapMs: listeningAt - closedAt, phases };

  rolloutGapGauge.set({ previous_version: marker.version }, rolloutGapMs / 1000);
  for (const phase of SHUTDOWN_PHASES) shutdownPhaseGauge.set({ phase }, phases[phase]);
  lastRolloutGap = gap;
  emit("info", "[metrics] rollout gap", {
    context: {
      rolloutGapMs,
      bootGapMs: gap.bootGapMs,
      previousVersion: marker.version,
      version: VERSION,
      phases,
    },
  });
  return gap;
}

// ── Summary ──

export interface RouteLatency {
  route: string;
  method: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface LatencySummary {
  /** ISO time this process booted: the start of the sample window. */
  sinceBoot: string;
  version: string;
  lastRolloutGapSeconds: number | null;
  lastShutdownPhases: Record<ShutdownPhase, number> | null;
  /** Sorted by p95, slowest first; percentiles cover each route's last 1000 requests. */
  routes: RouteLatency[];
}

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1]!;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

export function latencySummary(): LatencySummary {
  const routes: RouteLatency[] = [];
  for (const entry of samples.values()) {
    const sorted = entry.ring.slice(0, Math.min(entry.count, RING_SIZE)).sort();
    routes.push({
      route: entry.route,
      method: entry.method,
      count: entry.count,
      p50Ms: round(percentile(sorted, 0.5)),
      p95Ms: round(percentile(sorted, 0.95)),
      maxMs: round(sorted[sorted.length - 1] ?? 0),
    });
  }
  routes.sort((a, b) => b.p95Ms - a.p95Ms);
  return {
    sinceBoot: bootedAt,
    version: VERSION,
    lastRolloutGapSeconds: lastRolloutGap ? lastRolloutGap.rolloutGapMs / 1000 : null,
    lastShutdownPhases: lastRolloutGap?.phases ?? null,
    routes,
  };
}

/** Exposed for tests. */
export function resetMetricsForTests(): void {
  samples.clear();
  lastRolloutGap = null;
  registry.resetMetrics();
  buildInfo.set({ version: VERSION }, 1);
  shuttingDownGauge.set(0);
}

// ── Scrape endpoint ──

export interface MetricsServer {
  /** Resolves with the bound port once listening (useful with port 0). */
  listening: Promise<number>;
  close(): Promise<void>;
}

/** Serve `GET /metrics` (and nothing else) on a plain Node HTTP server. */
export function startMetricsServer(port: number, host: string): MetricsServer {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (url !== "/metrics" || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found\n");
      return;
    }
    registry.metrics().then(
      (body) => res.writeHead(200, { "Content-Type": registry.contentType }).end(req.method === "HEAD" ? undefined : body),
      (err) => {
        emit("warn", "[metrics] scrape failed", { err });
        res.writeHead(500, { "Content-Type": "text/plain" }).end("metrics unavailable\n");
      },
    );
  });
  const listening = new Promise<number>((resolve, reject) => {
    server.once("listening", () => {
      const addr = server.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      emit("info", `[metrics] serving /metrics on ${host}:${bound}`);
      resolve(bound);
    });
    server.once("error", (err) => {
      emit("warn", "[metrics] metrics server failed to listen", { err });
      reject(err);
    });
  });
  // A failed listen is logged above; it must not crash the service.
  listening.catch(() => {});
  server.listen(port, host);
  return {
    listening,
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
