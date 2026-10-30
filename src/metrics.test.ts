import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { matchedRoutes } from "hono/route";

vi.mock("./version.js", () => ({ VERSION: "2026.10.19-test" }));

import {
  latencySummary,
  observeHttpRequest,
  readRolloutGap,
  recordShutdownMarker,
  registry,
  resetMetricsForTests,
  routeLabel,
  startMetricsServer,
  statusClass,
  timeForgeCall,
  type ShutdownMarker,
} from "./metrics.js";

beforeEach(() => resetMetricsForTests());

describe("routeLabel", () => {
  async function labelFor(url: string): Promise<string> {
    const app = new Hono();
    let label = "";
    app.use("*", async (c, next) => {
      await next();
      label = routeLabel(matchedRoutes(c));
    });
    app.use("/*", async (_c, next) => next());
    app.get("/issues/:id", (c) => c.text("ok"));
    app.get("/board", (c) => c.text("ok"));
    await app.request(url);
    return label;
  }

  it("is the matched route pattern, skipping wildcard middleware", async () => {
    expect(await labelFor("/issues/clw_123")).toBe("/issues/:id");
    expect(await labelFor("/board")).toBe("/board");
  });

  it("is `unmatched` when only middleware matched", async () => {
    expect(await labelFor("/nope")).toBe("unmatched");
    expect(routeLabel([])).toBe("unmatched");
  });
});

describe("statusClass", () => {
  it("buckets by hundreds", () => {
    expect(statusClass(200)).toBe("2xx");
    expect(statusClass(302)).toBe("3xx");
    expect(statusClass(404)).toBe("4xx");
    expect(statusClass(503)).toBe("5xx");
    expect(statusClass(0)).toBe("unknown");
  });
});

describe("latencySummary", () => {
  it("reports nearest-rank p50/p95/max per route, slowest p95 first", () => {
    for (let ms = 1; ms <= 100; ms++) observeHttpRequest("/board", "GET", 200, ms);
    for (let i = 0; i < 10; i++) observeHttpRequest("/health", "GET", 200, 2);
    const summary = latencySummary();
    expect(summary.version).toBe("2026.10.19-test");
    expect(summary.lastRolloutGapSeconds).toBeNull();
    expect(summary.routes).toEqual([
      { route: "/board", method: "GET", count: 100, p50Ms: 50, p95Ms: 95, maxMs: 100 },
      { route: "/health", method: "GET", count: 10, p50Ms: 2, p95Ms: 2, maxMs: 2 },
    ]);
  });

  it("keeps only the last 1000 samples per route but counts every request", () => {
    for (let i = 0; i < 1000; i++) observeHttpRequest("/prs", "GET", 200, 5000);
    for (let i = 0; i < 1000; i++) observeHttpRequest("/prs", "GET", 200, 10);
    expect(latencySummary().routes[0]).toMatchObject({ count: 2000, p95Ms: 10, maxMs: 10 });
  });
});

describe("shutdown marker", () => {
  let dir: string;
  let file: string;
  const startedAt = Date.parse("2026-10-19T12:00:00.000Z");
  const marker: ShutdownMarker = {
    version: "2026.10.18-prev",
    shutdownStartedAt: new Date(startedAt).toISOString(),
    phases: { drain: 30, cancel: 5, auth_sync: 1, memory_flush: 20 },
    serverClosedAt: new Date(startedAt + 57_000).toISOString(),
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-metrics-"));
    file = path.join(dir, "state", "last-shutdown.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("round-trips, anchoring the gap at shutdownStartedAt and deriving close", async () => {
    recordShutdownMarker(marker, file);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(marker);

    const gap = readRolloutGap(startedAt + 120_000, file);
    expect(gap).toEqual({
      previousVersion: "2026.10.18-prev",
      rolloutGapMs: 120_000,
      bootGapMs: 63_000,
      phases: { drain: 30, cancel: 5, auth_sync: 1, memory_flush: 20, close: 1 },
    });
    expect(fs.existsSync(file)).toBe(false);
    expect(latencySummary()).toMatchObject({ lastRolloutGapSeconds: 120, lastShutdownPhases: gap!.phases });
    const text = await registry.metrics();
    expect(text).toContain('claws_last_rollout_gap_seconds{previous_version="2026.10.18-prev"} 120');
    expect(text).toContain('claws_last_shutdown_phase_seconds{phase="memory_flush"} 20');
  });

  it("ignores a marker more than 24 h before this boot", async () => {
    recordShutdownMarker(marker, file);
    expect(readRolloutGap(startedAt + 25 * 60 * 60 * 1000, file)).toBeNull();
    expect(latencySummary().lastRolloutGapSeconds).toBeNull();
    expect(await registry.metrics()).not.toMatch(/^claws_last_rollout_gap_seconds\{/m);
  });

  it("tolerates a missing or malformed marker", () => {
    expect(readRolloutGap(startedAt, file)).toBeNull();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(readRolloutGap(startedAt, file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ ...marker, phases: { drain: "slow" } }));
    expect(readRolloutGap(startedAt, file)).toBeNull();
  });
});

describe("timeForgeCall", () => {
  it("records ok and error outcomes and rethrows", async () => {
    expect(await timeForgeCall("github", async () => "x")).toBe("x");
    await expect(timeForgeCall("forgejo", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const text = await registry.metrics();
    expect(text).toContain('claws_forge_request_duration_seconds_count{forge="github",outcome="ok"} 1');
    expect(text).toContain('claws_forge_request_duration_seconds_count{forge="forgejo",outcome="error"} 1');
  });
});

describe("startMetricsServer", () => {
  it("serves GET /metrics and nothing else", async () => {
    observeHttpRequest("/board", "GET", 200, 12);
    const server = startMetricsServer(0, "127.0.0.1");
    try {
      const port = await server.listening;
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("claws_http_request_duration_seconds_bucket");
      expect(body).toContain('claws_build_info{version="2026.10.19-test"} 1');
      expect(body).toContain("claws_nodejs_eventloop_lag_seconds");
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
