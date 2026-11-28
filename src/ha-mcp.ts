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
 * ha_matter_nodes (handleMatterNodes) lists every Matter node with id, name, vendor, product and
 * entities, read-only: it GETs the Matter config-entry diagnostics and renders one fixed template.
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
  opts: { method?: string; path: string; body?: unknown; select?: string; offset?: number },
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
    if (opts.select !== undefined && opts.select !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return errorResult("select needs a JSON response");
      }
      const picked = selectJsonPath(parsed, opts.select);
      if (!picked.ok) return errorResult(picked.error);
      out = JSON.stringify(picked.value, null, 2) ?? "null";
    } else {
      try {
        out = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        out = text;
      }
    }

    const page = paginate(out, opts.offset ?? 0);
    if (typeof page !== "string") return page;

    return rawTextResult(page);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export type SelectResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Select part of a JSON value. Dot-separated segments; `*` matches every child of an object
 * or array; numeric segments index arrays. Without `*` returns the single value; with `*`
 * a flat array of matches, skipping branches where the rest of the path is missing.
 */
export function selectJsonPath(value: unknown, path: string): SelectResult {
  const segments = path.split(".");
  const hasWildcard = segments.includes("*");
  const children = (v: unknown): unknown[] =>
    Array.isArray(v) ? v : v !== null && typeof v === "object" ? Object.values(v) : [];
  const step = (v: unknown, seg: string): { found: boolean; value?: unknown } => {
    if (v !== null && typeof v === "object") {
      if (Array.isArray(v)) {
        if (/^\d+$/.test(seg) && Number(seg) < v.length) return { found: true, value: v[Number(seg)] };
        return { found: false };
      }
      if (Object.prototype.hasOwnProperty.call(v, seg)) {
        return { found: true, value: (v as Record<string, unknown>)[seg] };
      }
    }
    return { found: false };
  };

  if (!hasWildcard) {
    let cur = value;
    for (const seg of segments) {
      const r = step(cur, seg);
      if (!r.found) return { ok: false, error: `select path not found at "${seg}"` };
      cur = r.value;
    }
    return { ok: true, value: cur };
  }

  const out: unknown[] = [];
  const walk = (v: unknown, idx: number): void => {
    if (idx === segments.length) {
      out.push(v);
      return;
    }
    const seg = segments[idx]!;
    if (seg === "*") {
      for (const c of children(v)) walk(c, idx + 1);
      return;
    }
    const r = step(v, seg);
    if (r.found) walk(r.value, idx + 1);
  };
  walk(value, 0);
  return { ok: true, value: out };
}

/** Apply offset and the per-page cap to serialised output; returns an error result when offset is out of range. */
function paginate(out: string, offset: number): string | ToolResult {
  const total = out.length;
  if (offset > 0 && offset >= total) {
    return errorResult(`offset ${offset} is at or past the end of the response (${total} chars total)`);
  }
  const end = offset + MAX_RESPONSE_CHARS;
  if (offset === 0 && total <= MAX_RESPONSE_CHARS) return out;
  const page = out.slice(offset, end);
  if (end >= total) return page;
  return page +
    `\n…[chars ${offset}–${end} of ${total}; call again with offset=${end} for the next page, or narrow with select]`;
}

type MatterNode = Record<string, unknown> & { node_id: number | string };

const ATTR_FIELDS: Array<[string, string]> = [
  ["node_label", "0/40/5"],
  ["vendor_name", "0/40/1"],
  ["vendor_id", "0/40/2"],
  ["product_name", "0/40/3"],
  ["product_id", "0/40/4"],
  ["serial", "0/40/15"],
];

const MATTER_TEMPLATE = `{%- set ns = namespace(out=[]) -%}
{%- for d in integration_entities('matter') | map('device_id') | reject('none') | unique -%}
{%- set ns.out = ns.out + [{'device_id': d, 'identifiers': device_attr(d,'identifiers') | map('list') | list, 'name': device_attr(d,'name_by_user') or device_attr(d,'name'), 'manufacturer': device_attr(d,'manufacturer'), 'model': device_attr(d,'model'), 'entities': device_entities(d)}] -%}
{%- endfor -%}
{{ ns.out | to_json }}`;

interface TemplateDevice {
  device_id?: string;
  identifiers?: unknown[][];
  name?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  entities?: string[];
}

function nodeIdOf(identifier: string): bigint | null {
  const m = /^deviceid_[0-9A-Fa-f]+-([0-9A-Fa-f]{16})-MatterNodeDevice$/.exec(identifier);
  return m ? BigInt("0x" + m[1]!) : null;
}

function extractNodes(diag: unknown): MatterNode[] {
  const data = (diag as { data?: { server?: { nodes?: unknown }; nodes?: unknown } } | null)?.data;
  const raw = data?.server?.nodes ?? data?.nodes;
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === "object"
      ? Object.entries(raw).map(([k, v]) => ({ node_id: Number(k), ...(v as object) }))
      : [];
  const nodes: MatterNode[] = [];
  for (const n of list) {
    if (n === null || typeof n !== "object") continue;
    const o = n as Record<string, unknown>;
    const attrs = (o["attributes"] ?? {}) as Record<string, unknown>;
    const node: MatterNode = {
      node_id: (o["node_id"] ?? "") as number | string,
      available: o["available"] ?? null,
      is_bridge: o["is_bridge"] ?? null,
      date_commissioned: o["date_commissioned"] ?? null,
    };
    for (const [field, key] of ATTR_FIELDS) node[field] = attrs[key] ?? null;
    nodes.push(node);
  }
  return nodes;
}

export async function handleMatterNodes(
  baseUrl: string,
  token: string,
  opts: { entry_id?: string; search?: string; offset?: number },
): Promise<ToolResult> {
  try {
    const warnings: string[] = [];
    let entryIds: string[];
    if (opts.entry_id) {
      entryIds = [opts.entry_id];
    } else {
      const res = await haFetch(new URL("/api/config/config_entries/entry?domain=matter", baseUrl), token, "GET");
      if (!res.ok) return errorResult(`HA API ${res.status} listing Matter config entries`);
      const entries = (await res.json()) as Array<{ entry_id?: string; domain?: string }>;
      entryIds = entries
        .filter((e) => e.entry_id && (e.domain === undefined || e.domain === "matter"))
        .map((e) => e.entry_id!);
      if (entryIds.length === 0) return errorResult("no Matter config entry found");
    }

    const nodes: MatterNode[] = [];
    for (const id of entryIds) {
      const res = await haFetch(
        new URL(`/api/diagnostics/config_entry/${encodeURIComponent(id)}`, baseUrl),
        token,
        "GET",
      );
      if (!res.ok) return errorResult(`HA API ${res.status} reading Matter diagnostics`);
      for (const n of extractNodes(await res.json())) {
        nodes.push(entryIds.length > 1 ? { entry_id: id, ...n } : n);
      }
    }

    const byNode = new Map<string, TemplateDevice & { identifier: string }>();
    const collisions = new Set<string>();
    try {
      const res = await haFetch(new URL("/api/template", baseUrl), token, "POST", { template: MATTER_TEMPLATE });
      if (!res.ok) throw new Error(`HA API ${res.status}`);
      const devices = JSON.parse(await res.text()) as TemplateDevice[];
      for (const d of devices) {
        for (const ident of d.identifiers ?? []) {
          if (ident[0] !== "matter" || typeof ident[1] !== "string") continue;
          const nid = nodeIdOf(ident[1]);
          if (nid === null) continue;
          const prev = byNode.get(nid.toString());
          if (prev && prev.device_id !== d.device_id) {
            collisions.add(nid.toString());
          }
          byNode.set(nid.toString(), { ...d, identifier: `matter:${ident[1]}` });
        }
      }
    } catch (err) {
      warnings.push(`device/entity lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (collisions.size > 0) {
      warnings.push(
        `node ids shared by several devices (different fabrics or entries); name/entities may be wrong for: ${[...collisions].join(", ")}`,
      );
    }

    let merged: Array<MatterNode & { entities: string[]; name: string | null }> = nodes.map((n) => {
      const d = byNode.get(String(n.node_id));
      return {
        ...n,
        device_id: d?.device_id ?? null,
        device_identifier: d?.identifier ?? null,
        name: d?.name ?? null,
        manufacturer: d?.manufacturer ?? null,
        model: d?.model ?? null,
        entities: d?.entities ?? [],
      };
    });

    if (opts.search) {
      const needle = opts.search.toLowerCase();
      merged = merged.filter((n) =>
        [String(n.node_id), n.node_label, n.name, n.vendor_name, n.product_name, ...n.entities].some(
          (v) => typeof v === "string" && v.toLowerCase().includes(needle),
        ),
      );
    }
    merged.sort((a, b) => Number(a.node_id) - Number(b.node_id));

    const total = merged.length;
    const offset = opts.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || (offset > 0 && offset >= total)) {
      return errorResult(`offset ${offset} out of range (0–${Math.max(total - 1, 0)} nodes)`);
    }
    const render = (nodes: unknown[], next?: number): string =>
      JSON.stringify(
        {
          count: total,
          offset,
          nodes,
          ...(next !== undefined ? { next_offset: next, note: `truncated; call again with offset=${next}` } : {}),
          ...(warnings.length ? { warnings } : {}),
        },
        null,
        2,
      );
    // Page by whole node so the JSON stays valid; always include at least one node.
    let end = offset;
    let out = render([]);
    while (end < total) {
      const withNext = render(merged.slice(offset, end + 1), end + 1 < total ? end + 1 : undefined);
      if (end > offset && withNext.length > MAX_RESPONSE_CHARS) break;
      out = withNext;
      end++;
    }
    if (end < total) out = render(merged.slice(offset, end), end);
    return rawTextResult(out);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
