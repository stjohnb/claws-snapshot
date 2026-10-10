import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleListEntities, handleApiRequest } from "./ha-mcp.js";
import { type ToolResult } from "./mcp-result.js";

const BASE_URL = "https://ha.example.com";
const TOKEN = "SECRET-TOKEN";

function makeResponse(opts: {
  ok: boolean;
  status?: number;
  body: unknown;
  isText?: boolean;
}): Response {
  const text = opts.isText ? (opts.body as string) : JSON.stringify(opts.body);
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

function makeEntities(count: number, domain = "light") {
  return Array.from({ length: count }, (_, i) => ({
    entity_id: `${domain}.entity_${i}`,
    state: "on",
    attributes: { friendly_name: `Entity ${i}` },
  }));
}

function extractJson(result: ToolResult): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe("handleListEntities", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  it("returns projected fields and strips attributes", async () => {
    const raw = [
      { entity_id: "light.bedroom", state: "on", attributes: { friendly_name: "Bedroom", brightness: 255 } },
    ];
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: raw }));

    const result = await handleListEntities(BASE_URL, TOKEN, {});
    const data = extractJson(result) as { entities: Array<{ entity_id: string; state: string; friendly_name: string }> };

    expect(data.entities).toHaveLength(1);
    const entity = data.entities[0]!;
    expect(entity.entity_id).toBe("light.bedroom");
    expect(entity.state).toBe("on");
    expect(entity.friendly_name).toBe("Bedroom");
    expect(entity).not.toHaveProperty("attributes");
  });

  it("filters by domain", async () => {
    const raw = [
      { entity_id: "light.bedroom", state: "on", attributes: {} },
      { entity_id: "sensor.temp", state: "21", attributes: {} },
    ];
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: raw }));

    const result = await handleListEntities(BASE_URL, TOKEN, { domain: "light" });
    const data = extractJson(result) as { entities: Array<{ entity_id: string }> };

    expect(data.entities).toHaveLength(1);
    expect(data.entities[0]!.entity_id).toBe("light.bedroom");
  });

  it("filters by search (friendly_name, case-insensitive)", async () => {
    const raw = [
      { entity_id: "light.xyz_abc", state: "on", attributes: { friendly_name: "Bedroom Light" } },
      { entity_id: "light.kitchen", state: "off", attributes: { friendly_name: "Kitchen Light" } },
    ];
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: raw }));

    const result = await handleListEntities(BASE_URL, TOKEN, { search: "bedroom" });
    const data = extractJson(result) as { entities: Array<{ entity_id: string }> };

    expect(data.entities).toHaveLength(1);
    expect(data.entities[0]!.entity_id).toBe("light.xyz_abc");
  });

  it("filters by search (entity_id, case-insensitive)", async () => {
    const raw = [
      { entity_id: "light.bedroom_main", state: "on", attributes: { friendly_name: "Main" } },
      { entity_id: "light.kitchen", state: "off", attributes: { friendly_name: "Kitchen" } },
    ];
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: raw }));

    const result = await handleListEntities(BASE_URL, TOKEN, { search: "bedroom" });
    const data = extractJson(result) as { entities: Array<{ entity_id: string }> };

    expect(data.entities).toHaveLength(1);
    expect(data.entities[0]!.entity_id).toBe("light.bedroom_main");
  });

  it("sets truncated and totalMatched when >500 entities match", async () => {
    const raw = makeEntities(510);
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: raw }));

    const result = await handleListEntities(BASE_URL, TOKEN, {});
    const data = extractJson(result) as { count: number; truncated: boolean; totalMatched: number; entities: unknown[] };

    expect(data.entities).toHaveLength(500);
    expect(data.truncated).toBe(true);
    expect(data.totalMatched).toBe(510);
    expect(data.count).toBe(500);
  });

  it("returns errorResult on non-ok response without leaking token", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: false, status: 401, body: "Unauthorized" }));

    const result = await handleListEntities(BASE_URL, TOKEN, {});
    const text = result.content[0]!.text;

    expect(text).toContain("error");
    expect(text).not.toContain(TOKEN);
  });

  it("returns errorResult on fetch rejection without leaking token", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("Network failure"));

    const result = await handleListEntities(BASE_URL, TOKEN, {});
    const text = result.content[0]!.text;

    expect(text).toContain("error");
    expect(text).not.toContain(TOKEN);
  });
});

describe("handleApiRequest", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  it("GET parses JSON and pretty-prints", async () => {
    const body = { entity_id: "light.bedroom", state: "on" };
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body }));

    const result = await handleApiRequest(BASE_URL, TOKEN, { path: "/api/states/light.bedroom" });

    expect(result.content[0]!.text).toContain("entity_id");
    expect(result.content[0]!.text).toContain('"light.bedroom"');
  });

  it("returns errorResult for path not starting with /api/", async () => {
    const result = await handleApiRequest(BASE_URL, TOKEN, { path: "/hassio/addon/start" });
    const data = extractJson(result) as { error: string };

    expect(data.error).toMatch(/relative HA API path/);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("returns errorResult for absolute URL host swap", async () => {
    const result = await handleApiRequest(BASE_URL, TOKEN, { path: "https://evil.com/api/states" });
    const data = extractJson(result) as { error: string };
    expect(data.error).toMatch(/Home Assistant host/);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("returns errorResult for paths with .. traversal segments", async () => {
    const result = await handleApiRequest(BASE_URL, TOKEN, { path: "/api/../config" });
    const data = extractJson(result) as { error: string };
    expect(data.error).toMatch(/beginning with \/api\//);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("returns errorResult for a bare /api/.. traversal path", async () => {
    const result = await handleApiRequest(BASE_URL, TOKEN, { path: "/api/.." });
    const data = extractJson(result) as { error: string };
    expect(data.error).toMatch(/beginning with \/api\//);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("allows legitimate /api/ paths containing dots that are not traversal", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeResponse({ ok: true, body: { ok: true } }),
    );
    const result = await handleApiRequest(BASE_URL, TOKEN, { path: "/api/states/light.bedroom" });
    const data = extractJson(result) as { error?: string };
    expect(data.error).toBeUndefined();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled();
  });

  it("plain-text body returns raw text, not errorResult", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeResponse({ ok: true, body: "2025-01-01 Error: something went wrong", isText: true }),
    );

    const result = await handleApiRequest(BASE_URL, TOKEN, { path: "/api/error_log" });

    expect(result.content[0]!.text).toBe("2025-01-01 Error: something went wrong");
    expect(result.content[0]!.text).not.toContain('"error"');
  });

  it("POST sends JSON body with method POST", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: {} }));

    await handleApiRequest(BASE_URL, TOKEN, {
      method: "POST",
      path: "/api/services/light/turn_on",
      body: { entity_id: "light.bedroom" },
    });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(JSON.stringify({ entity_id: "light.bedroom" }));
  });

  it("truncates responses exceeding MAX_RESPONSE_CHARS", async () => {
    const longText = "x".repeat(60_000);
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeResponse({ ok: true, body: longText, isText: true }),
    );

    const result = await handleApiRequest(BASE_URL, TOKEN, { path: "/api/error_log" });
    const text = result.content[0]!.text;

    expect(text.length).toBeLessThan(60_000);
    expect(text).toContain("[truncated");
    expect(text).toContain("60000 chars total");
  });

  it("returns errorResult on non-ok status without leaking token", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      makeResponse({ ok: false, status: 403, body: "Forbidden", isText: true }),
    );

    const result = await handleApiRequest(BASE_URL, TOKEN, { path: "/api/states" });
    const text = result.content[0]!.text;

    expect(text).toContain("error");
    expect(text).not.toContain(TOKEN);
  });

  it("returns errorResult on fetch rejection without leaking token", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("Network failure"));

    const result = await handleApiRequest(BASE_URL, TOKEN, { path: "/api/states" });
    const text = result.content[0]!.text;

    expect(text).toContain("error");
    expect(text).not.toContain(TOKEN);
  });

  it("returns errorResult for unsupported method", async () => {
    const result = await handleApiRequest(BASE_URL, TOKEN, { method: "DELETE", path: "/api/states" });
    const data = extractJson(result) as { error: string };

    expect(data.error).toMatch(/GET or POST/);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("blocks percent-encoded dot-segment traversal out of /api/", async () => {
    const result = await handleApiRequest(BASE_URL, TOKEN, { path: "/api/%2e%2e/%2e%2e/admin" });
    const data = extractJson(result) as { error: string };
    expect(data.error).toMatch(/beginning with \/api\//);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("blocks protocol-relative host swap", async () => {
    const result = await handleApiRequest(BASE_URL, TOKEN, { path: "//evil.com/api/states" });
    const data = extractJson(result) as { error: string };
    expect(data.error).toMatch(/Home Assistant host/);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("fetches the resolved URL on the HA origin for valid paths", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: { ok: true } }));
    await handleApiRequest(BASE_URL, TOKEN, { path: "/api/states/light.bedroom" });
    const [url] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toBe("https://ha.example.com/api/states/light.bedroom");
  });
});
