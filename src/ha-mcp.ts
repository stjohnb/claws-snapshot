/**
 * Handler logic for Home Assistant MCP tools, extracted for testability.
 *
 * Common endpoints reachable via ha_api_request:
 *   GET  /api/states                           — all entity states
 *   GET  /api/states/{entity_id}               — single entity with full attributes
 *   GET  /api/services                         — available services by domain
 *   GET  /api/config                           — HA configuration info
 *   GET  /api/error_log                        — plain-text error log
 *   GET  /api/history/period/{ISO8601}?filter_entity_id=...  — history for entity
 *   GET  /api/logbook/{ISO8601}                — logbook events
 *   POST /api/template                         — render Jinja: { "template": "{{ states('sun.sun') }}" }
 *   POST /api/services/{domain}/{service}      — invoke a service (e.g. light.turn_on)
 *
 * IMPORTANT: baseUrl and token are explicit parameters — do NOT import config.js or home-assistant.js.
 */

import { type ToolResult, textResult, errorResult } from "./mcp-result.js";

function rawTextResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

const MAX_RESPONSE_CHARS = 50_000;

async function haFetch(
  target: URL,
  token: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return fetch(target, {
    method,
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export async function handleListEntities(
  baseUrl: string,
  token: string,
  opts: { domain?: string; search?: string },
): Promise<ToolResult> {
  try {
    const res = await haFetch(new URL("/api/states", baseUrl), token, "GET");
    if (!res.ok) {
      return errorResult(`HA API ${res.status}`);
    }
    const raw = (await res.json()) as Array<{ entity_id: string; state: string; attributes?: { friendly_name?: string } }>;

    let entities = raw.map((s) => ({
      entity_id: s.entity_id,
      state: s.state,
      friendly_name: s.attributes?.friendly_name ?? null,
    }));

    if (opts.domain) {
      entities = entities.filter((e) => e.entity_id.startsWith(opts.domain + "."));
    }

    if (opts.search) {
      const needle = opts.search.toLowerCase();
      entities = entities.filter(
        (e) =>
          e.entity_id.toLowerCase().includes(needle) ||
          (e.friendly_name?.toLowerCase().includes(needle) ?? false),
      );
    }

    entities.sort((a, b) => a.entity_id.localeCompare(b.entity_id));

    const totalMatched = entities.length;
    let truncated: boolean | undefined;
    if (entities.length > 500) {
      entities = entities.slice(0, 500);
      truncated = true;
    }

    return textResult({
      count: entities.length,
      ...(truncated ? { truncated: true, totalMatched } : {}),
      entities,
    });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export async function handleApiRequest(
  baseUrl: string,
  token: string,
  opts: { method?: string; path: string; body?: unknown },
): Promise<ToolResult> {
  try {
    let resolved: URL;
    try {
      resolved = new URL(opts.path, baseUrl);
    } catch {
      return errorResult("path must be a relative HA API path beginning with /api/");
    }
    const base = new URL(baseUrl);
    if (resolved.origin !== base.origin) {
      return errorResult("path must resolve to the Home Assistant host");
    }
    if (!resolved.pathname.startsWith("/api/")) {
      return errorResult("path must be a relative HA API path beginning with /api/");
    }

    const method = (opts.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      return errorResult("method must be GET or POST");
    }

    const res = await haFetch(
      resolved,
      token,
      method,
      method === "POST" ? opts.body : undefined,
    );

    if (!res.ok) {
      const errBody = (await res.text().catch(() => "")).slice(0, 500);
      return errorResult(`HA API ${res.status}: ${errBody}`);
    }

    const text = await res.text();
    let out: string;
    try {
      const parsed = JSON.parse(text);
      out = JSON.stringify(parsed, null, 2);
    } catch {
      out = text;
    }

    if (out.length > MAX_RESPONSE_CHARS) {
      const total = out.length;
      out = out.slice(0, MAX_RESPONSE_CHARS) +
        `\n…[truncated, ${total} chars total; use a more specific path or filter]`;
    }

    return rawTextResult(out);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
