import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleListEntities, handleApiRequest, handleMatterNodes, selectJsonPath } from "./ha-mcp.js";
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
    expect(text).toContain("chars 0–50000 of 60000");
    expect(text).toContain("offset=50000");
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

describe("select / offset", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  const body = { data: { nodes: [{ id: 1, x: 1 }, { id: 2 }, { id: 3, x: 3 }], name: "n" } };

  it("selects a single value", () => {
    expect(selectJsonPath(body, "data.name")).toEqual({ ok: true, value: "n" });
    expect(selectJsonPath(body, "data.nodes.1.id")).toEqual({ ok: true, value: 2 });
  });
  it("selects with wildcard, skipping missing branches", () => {
    expect(selectJsonPath(body, "data.nodes.*.x")).toEqual({ ok: true, value: [1, 3] });
  });
  it("names the failing segment", () => {
    expect(selectJsonPath(body, "data.nope.id")).toEqual({ ok: false, error: 'select path not found at "nope"' });
    // Pins current behaviour: a wildcard that matches no branch yields an empty list, not an error.
    expect(selectJsonPath(body, "data.nodes.*.nope")).toEqual({ ok: true, value: [] });
  });
  it("applies select in handleApiRequest and rejects non-JSON", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body }));
    const r = await handleApiRequest(BASE_URL, TOKEN, { path: "/api/x", select: "data.nodes.*.id" });
    expect(extractJson(r)).toEqual([1, 2, 3]);
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: "plain", isText: true }));
    const e = await handleApiRequest(BASE_URL, TOKEN, { path: "/api/x", select: "a" });
    expect(extractJson(e)).toHaveProperty("error");
    expect(e.content[0]!.text).toContain("select needs a JSON response");
  });
  it("pages with offset and rejects out-of-range offsets", async () => {
    const long = "a".repeat(120_000);
    vi.mocked(globalThis.fetch).mockResolvedValue(makeResponse({ ok: true, body: long, isText: true }));
    const p2 = await handleApiRequest(BASE_URL, TOKEN, { path: "/api/x", offset: 50_000 });
    expect(p2.content[0]!.text).toContain("chars 50000–100000 of 120000; call again with offset=100000");
    const p3 = await handleApiRequest(BASE_URL, TOKEN, { path: "/api/x", offset: 100_000 });
    expect(p3.content[0]!.text).not.toContain("call again");
    const bad = await handleApiRequest(BASE_URL, TOKEN, { path: "/api/x", offset: 120_000 });
    expect(extractJson(bad)).toHaveProperty("error");
    expect(bad.content[0]!.text).toContain("120000");
  });
});

describe("handleMatterNodes", () => {
  const attrs = (label: string, product: string) => ({
    "0/40/5": label, "0/40/1": "Acme", "0/40/2": 4874, "0/40/3": product, "0/40/4": 1, "0/40/15": "**REDACTED**",
  });
  const objNodes: Record<string, unknown> = {};
  for (let i = 1; i <= 6; i++) {
    objNodes[String(i + 20)] = { available: true, is_bridge: false, date_commissioned: "d", attributes: attrs(`Lamp ${i}`, "Bulb") };
  }
  const diag = { data: { server: { nodes: objNodes } } };
  const arrDiag = { data: { server: { nodes: [{ node_id: 21, available: true, attributes: attrs("Arr", "Plug") }] } } };
  const tpl = [
    {
      device_id: "dev1",
      identifiers: [["matter", "deviceid_E2D7E4EC62F45453-0000000000000015-MatterNodeDevice"]],
      name: "Kitchen lamp", manufacturer: "Acme", model: "Bulb", entities: ["light.kitchen"],
    },
  ];

  function mockFetch(opts: { templateFails?: boolean; diag?: unknown }) {
    globalThis.fetch = vi.fn(async (url: URL | string) => {
      const u = String(url);
      if (u.includes("config_entries/entry")) return makeResponse({ ok: true, body: [{ entry_id: "e1", domain: "matter" }] });
      if (u.includes("diagnostics")) return makeResponse({ ok: true, body: opts.diag ?? diag });
      if (opts.templateFails) return makeResponse({ ok: false, status: 400, body: "bad" });
      return makeResponse({ ok: true, body: tpl, isText: false });
    }) as unknown as typeof fetch;
  }
  type Out = { count: number; nodes: Array<{ node_id: number; device_id: string | null; entities: string[]; name: string | null }>; warnings?: string[] };

  it("joins diagnostics nodes (object form) to template devices", async () => {
    mockFetch({});
    const out = extractJson(await handleMatterNodes(BASE_URL, TOKEN, {})) as Out;
    expect(out.count).toBe(6);
    const n = out.nodes.find((x) => x.node_id === 21)!;
    expect(n.device_id).toBe("dev1");
    expect(n.entities).toEqual(["light.kitchen"]);
    expect(out.nodes.find((x) => x.node_id === 22)!.device_id).toBeNull();
    expect(out.warnings).toBeUndefined();
  });
  it("handles array form", async () => {
    mockFetch({ diag: arrDiag });
    const out = extractJson(await handleMatterNodes(BASE_URL, TOKEN, {})) as Out;
    expect(out.nodes[0]!.name).toBe("Kitchen lamp");
  });
  it("returns nodes plus a warning when the template fails", async () => {
    mockFetch({ templateFails: true });
    const out = extractJson(await handleMatterNodes(BASE_URL, TOKEN, {})) as Out;
    expect(out.count).toBe(6);
    expect(out.warnings).toHaveLength(1);
  });
  it("filters by search", async () => {
    mockFetch({});
    const out = extractJson(await handleMatterNodes(BASE_URL, TOKEN, { search: "light.kitchen" })) as Out;
    expect(out.count).toBe(1);
  });
  it("matches search on node id and skips the entries GET with entry_id", async () => {
    mockFetch({});
    const out = extractJson(await handleMatterNodes(BASE_URL, TOKEN, { entry_id: "e9", search: "22" })) as Out;
    expect(out.count).toBe(1);
    const urls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("config_entries/entry"))).toBe(false);
    expect(urls.some((u) => u.includes("config_entry/e9"))).toBe(true);
  });
  it("pages by node when output exceeds the limit", async () => {
    const nodes: Record<string, unknown> = {};
    for (let i = 1; i <= 60; i++) {
      nodes[String(i)] = { attributes: attrs("L".repeat(2000) + i, "Bulb") };
    }
    mockFetch({ diag: { data: { server: { nodes } } } });
    type Page = Out & { next_offset?: number };
    const p1 = extractJson(await handleMatterNodes(BASE_URL, TOKEN, {})) as Page;
    expect(p1.count).toBe(60);
    expect(p1.nodes.length).toBeLessThan(60);
    expect(p1.next_offset).toBe(p1.nodes.length);
    const p2 = extractJson(await handleMatterNodes(BASE_URL, TOKEN, { offset: p1.next_offset })) as Page;
    expect(p2.nodes[0]!.node_id).toBe(p1.nodes.length + 1);
    const bad = await handleMatterNodes(BASE_URL, TOKEN, { offset: 60 });
    expect(extractJson(bad)).toHaveProperty("error");
  });
  it("warns when two devices share a node id", async () => {
    const dup = [
      { device_id: "a", identifiers: [["matter", "deviceid_AAAA-0000000000000015-MatterNodeDevice"]], entities: [] },
      { device_id: "b", identifiers: [["matter", "deviceid_BBBB-0000000000000015-MatterNodeDevice"]], entities: [] },
    ];
    globalThis.fetch = vi.fn(async (url: URL | string) => {
      const u = String(url);
      if (u.includes("config_entries/entry")) return makeResponse({ ok: true, body: [{ entry_id: "e1", domain: "matter" }] });
      if (u.includes("diagnostics")) return makeResponse({ ok: true, body: diag });
      return makeResponse({ ok: true, body: dup, isText: false });
    }) as unknown as typeof fetch;
    const out = extractJson(await handleMatterNodes(BASE_URL, TOKEN, {})) as Out;
    expect(out.warnings?.[0]).toContain("21");
  });
  it("never leaks the token in errors", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    const r = await handleMatterNodes(BASE_URL, TOKEN, {});
    expect(extractJson(r)).toHaveProperty("error");
    expect(r.content[0]!.text).not.toContain(TOKEN);
  });
});
