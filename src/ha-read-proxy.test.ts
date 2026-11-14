import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig = vi.hoisted(() => ({
  HOME_ASSISTANT_BASE_URL: "http://ha.example.test:8123/",
  HOME_ASSISTANT_TOKEN: "ha-server-token",
  HOME_ASSISTANT_CONFIG_REPO: "",
}));
vi.mock("./config.js", () => mockConfig);

import { isAllowedHaReadPath, proxyHaRead } from "./ha-read-proxy.js";

describe("Home Assistant read proxy (#clw_01M77K5B15JHY1N6JMGRZDFQ0D)", () => {
  beforeEach(() => {
    mockConfig.HOME_ASSISTANT_BASE_URL = "http://ha.example.test:8123/";
    mockConfig.HOME_ASSISTANT_TOKEN = "ha-server-token";
  });

  it("allows exactly the read-only GET endpoints", () => {
    for (const p of [
      "/api/", "/api/config", "/api/components", "/api/services", "/api/events", "/api/error_log", "/api/states",
      "/api/states/light.kitchen", "/api/history/period", "/api/history/period/2026-11-12T00:00:00+00:00",
      "/api/history/period/2026-11-12T00%3A00%3A00Z", "/api/logbook", "/api/logbook/2026-11-12", "/api/calendars",
      "/api/calendars/calendar.family", "/api/config/config_entries/entry",
    ]) expect(isAllowedHaReadPath(p), p).toBe(true);
  });

  it("refuses paths off the allowlist, traversal and encoded slashes", () => {
    for (const p of [
      "", "/api", "/api/services/light/turn_on", "/api/events/x", "/api/template", "/api/websocket", "/api/states/Light.X",
      "/api/states/light.kitchen/extra", "/api/config/core/check_config", "/api/history/period/yesterday", "/auth/token",
      "/api/states/../services", "/api/states/%2e%2e/services", "//api/states", "/api//states", "/api/states\\x",
      "/api/states%2Flight.x", "/api/states/light.x%2f", "/api/states%5clight.x", "/api/%zz",
    ]) expect(isAllowedHaReadPath(p), p).toBe(false);
  });

  it("forwards an allowed GET with only the server token and passes back status, type and body", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"state":"on"}', { status: 200, headers: { "content-type": "application/json" } }));
    const result = await proxyHaRead("/api/states/light.kitchen", "", fetchImpl as unknown as typeof fetch);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("application/json");
    expect(new TextDecoder().decode(result.body)).toBe('{"state":"on"}');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://ha.example.test:8123/api/states/light.kitchen");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ Authorization: "Bearer ha-server-token" });
    expect(init.body).toBeUndefined();
  });

  it("passes the query string through", async () => {
    const fetchImpl = vi.fn(async () => new Response("[]", { status: 200 }));
    await proxyHaRead("/api/history/period/2026-11-12", "filter_entity_id=sensor.a&minimal_response", fetchImpl as unknown as typeof fetch);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("http://ha.example.test:8123/api/history/period/2026-11-12?filter_entity_id=sensor.a&minimal_response");
  });

  it("refuses an off-allowlist path without calling fetch", async () => {
    const fetchImpl = vi.fn();
    expect(await proxyHaRead("/api/services/light/turn_on", "", fetchImpl as unknown as typeof fetch)).toEqual({ kind: "forbidden" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports unconfigured HA and upstream failures", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await proxyHaRead("/api/states", "", fetchImpl as unknown as typeof fetch)).toEqual({ kind: "upstream-error", error: "TypeError" });
    mockConfig.HOME_ASSISTANT_TOKEN = "";
    expect(await proxyHaRead("/api/states", "", fetchImpl as unknown as typeof fetch)).toEqual({ kind: "unconfigured" });
  });
});
