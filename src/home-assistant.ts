import { WebSocket } from "ws";
import { HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_CONFIG_REPO, HOME_ASSISTANT_TOKEN } from "./config.js";
import { retryWithBackoff } from "./retry.js";

const HA_TRANSIENT_RE = /\bHA API (429|500|502|503|504)\b/;
const HA_MAX_RETRIES = 3;

export const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;

export function isHaTransient(err: Error): boolean {
  return HA_TRANSIENT_RE.test(err.message) || err.name === "TimeoutError";
}

export const UPDATE_BACKUP_FEATURE_BIT = 8;

export interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

async function haFetch(path: string, init?: RequestInit): Promise<Response> {
  return retryWithBackoff(
    async () => {
      const baseUrl = HOME_ASSISTANT_BASE_URL;
      const token = HOME_ASSISTANT_TOKEN;
      const res = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(15_000),
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HA API ${res.status} for ${path}: ${text.slice(0, 200)}`);
      }
      return res;
    },
    HA_MAX_RETRIES,
    isHaTransient,
    `haFetch ${path}`,
  );
}

export function isConfigured(): boolean {
  return !!(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN);
}

export function isHomeAssistantConfigRepo(fullName: string): boolean {
  const target = HOME_ASSISTANT_CONFIG_REPO || "St-John-Software/home-assistant-config";
  return fullName.toLowerCase() === target.toLowerCase();
}

/** True when a prompt for this repo will embed the HA MCP-tool context — i.e.
 *  HA is configured and this is the HA config repo. Callers must route such
 *  prompts to a provider that actually honours `mcpConfig` (Codex/OpenCode
 *  silently drop it), or the agent is told to use tools it doesn't have. */
export function homeAssistantMcpAvailable(fullName: string): boolean {
  return isConfigured() && isHomeAssistantConfigRepo(fullName);
}

export async function listStates(): Promise<HAState[]> {
  const res = await haFetch("/api/states");
  return res.json() as Promise<HAState[]>;
}

export async function callService(
  domain: string,
  service: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  const res = await haFetch(`/api/services/${domain}/${service}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function listUpdateEntities(): Promise<HAState[]> {
  const states = await listStates();
  return states.filter((s) => s.entity_id.startsWith("update."));
}

export async function installUpdate(entityId: string, opts?: { backup?: boolean }): Promise<void> {
  const data: Record<string, unknown> = { entity_id: entityId };
  if (opts?.backup === true) data.backup = true;
  await callService("update", "install", data);
}

// Addon logs return plain text, not JSON — can't reuse haFetch (which expects
// callers to .json() the response). Uses a longer timeout for larger payloads.
export async function getAddonLogs(slug: string): Promise<string> {
  return retryWithBackoff(
    async () => {
      const baseUrl = HOME_ASSISTANT_BASE_URL;
      const token = HOME_ASSISTANT_TOKEN;
      const res = await fetch(`${baseUrl}/api/hassio/addons/${encodeURIComponent(slug)}/logs`, {
        signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HA API ${res.status} for /api/hassio/addons/${encodeURIComponent(slug)}/logs: ${text.slice(0, 200)}`);
      }
      return res.text();
    },
    HA_MAX_RETRIES,
    isHaTransient,
    `getAddonLogs ${slug}`,
  );
}

// ── WebSocket API ──
//
// HA's REST API cannot read or write the area/entity registries — those live
// behind WebSocket-only commands (`config/area_registry/list`,
// `config/entity_registry/list`, `config/entity_registry/update`). The floor
// and device registries are the same story (`config/floor_registry/list`,
// `config/device_registry/list`, `config/device_registry/update`). This is the
// same transport the frontend uses.

const WS_OPEN_TIMEOUT_MS = 15_000;
const WS_REQUEST_TIMEOUT_MS = 15_000;

export interface HaAreaEntry {
  area_id: string;
  name: string;
  floor_id?: string | null;
  icon?: string | null;
}

export interface HaFloorEntry {
  floor_id: string;
  name: string;
  level?: number | null;
  icon?: string | null;
}

export interface HaDeviceRegistryEntry {
  id: string;
  area_id: string | null;
  name?: string | null;
  name_by_user?: string | null;
  identifiers?: [string, string][];
  connections?: [string, string][];
}

export interface HaEntityRegistryEntry {
  entity_id: string;
  area_id: string | null;
  device_id: string | null;
}

export interface HaWsSession {
  request(msg: { type: string } & Record<string, unknown>): Promise<unknown>;
}

export function haWebSocketUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const scheme = trimmed
    .replace(/^https:\/\//i, "wss://")
    .replace(/^http:\/\//i, "ws://");
  return `${scheme}/api/websocket`;
}

interface PendingRequest {
  type: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

// Opens an authenticated WebSocket session, runs `fn`, and always closes the
// socket. The access token is only ever sent in the `auth` frame — never in the
// URL, a log line, or an error message.
export async function withHaWebSocket<T>(fn: (s: HaWsSession) => Promise<T>): Promise<T> {
  if (!isConfigured()) throw new Error("HA not configured");

  const token = HOME_ASSISTANT_TOKEN;
  const ws = new WebSocket(haWebSocketUrl(HOME_ASSISTANT_BASE_URL));

  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let closedReason: Error | null = null;
  // Set while the auth handshake is in flight; lets a socket error/close during
  // the handshake reject the open promise rather than vanish.
  let onAuth: ((err: Error | null) => void) | null = null;

  const failAll = (err: Error): void => {
    closedReason ??= err;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };

  // Attached before the open promise resolves — an unhandled "error" event on a
  // ws socket takes the process down.
  ws.on("error", (err: Error) => {
    const wrapped = new Error(`HA WebSocket error: ${err.message}`);
    if (onAuth) onAuth(wrapped);
    failAll(wrapped);
  });

  ws.on("close", () => {
    const err = new Error("HA WebSocket closed");
    if (onAuth) onAuth(err);
    failAll(err);
  });

  ws.on("message", (data) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg["type"]) {
      case "auth_required":
        ws.send(JSON.stringify({ type: "auth", access_token: token }));
        return;
      case "auth_ok":
        onAuth?.(null);
        return;
      case "auth_invalid":
        onAuth?.(new Error("HA WebSocket auth rejected (auth_invalid)"));
        return;
      case "result":
        break;
      // HA interleaves `event` and `pong` frames on the same connection.
      default:
        return;
    }
    const p = pending.get(Number(msg["id"]));
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(Number(msg["id"]));
    if (msg["success"] === true) p.resolve(msg["result"]);
    else p.reject(new Error(`HA WS ${p.type} failed: ${JSON.stringify(msg["error"])}`));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        onAuth = null;
        reject(new Error(`HA WebSocket handshake timed out after ${WS_OPEN_TIMEOUT_MS}ms`));
      }, WS_OPEN_TIMEOUT_MS);
      onAuth = (err) => {
        clearTimeout(timer);
        onAuth = null;
        if (err) reject(err);
        else resolve();
      };
    });

    const session: HaWsSession = {
      request(msg) {
        if (closedReason) return Promise.reject(closedReason);
        const id = nextId++;
        return new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`HA WS ${msg.type} timed out after ${WS_REQUEST_TIMEOUT_MS}ms`));
          }, WS_REQUEST_TIMEOUT_MS);
          pending.set(id, { type: msg.type, resolve, reject, timer });
          ws.send(JSON.stringify({ ...msg, id }), (err) => {
            if (!err) return;
            const p = pending.get(id);
            if (!p) return;
            clearTimeout(p.timer);
            pending.delete(id);
            reject(new Error(`HA WS ${msg.type} send failed: ${err.message}`));
          });
        });
      },
    };

    return await fn(session);
  } finally {
    ws.close();
  }
}

export async function listAreaRegistry(s: HaWsSession): Promise<HaAreaEntry[]> {
  return (await s.request({ type: "config/area_registry/list" })) as HaAreaEntry[];
}

export async function listFloorRegistry(s: HaWsSession): Promise<HaFloorEntry[]> {
  return (await s.request({ type: "config/floor_registry/list" })) as HaFloorEntry[];
}

export async function listDeviceRegistry(s: HaWsSession): Promise<HaDeviceRegistryEntry[]> {
  return (await s.request({ type: "config/device_registry/list" })) as HaDeviceRegistryEntry[];
}

export async function listEntityRegistry(s: HaWsSession): Promise<HaEntityRegistryEntry[]> {
  return (await s.request({ type: "config/entity_registry/list" })) as HaEntityRegistryEntry[];
}

export async function setEntityArea(s: HaWsSession, entityId: string, areaId: string): Promise<void> {
  await s.request({ type: "config/entity_registry/update", entity_id: entityId, area_id: areaId });
}

export async function setDeviceArea(s: HaWsSession, deviceId: string, areaId: string): Promise<void> {
  await s.request({ type: "config/device_registry/update", device_id: deviceId, area_id: areaId });
}

/** HA's Energy dashboard preferences — `energy_sources`, `device_consumption`,
 * `device_consumption_water`. Kept loose: HA adds keys across versions and
 * ha-energy-reconciler round-trips whatever it is given. */
export type HaEnergyPrefs = Record<string, unknown>;

export async function getEnergyPrefs(s: HaWsSession): Promise<HaEnergyPrefs> {
  return ((await s.request({ type: "energy/get_prefs" })) ?? {}) as HaEnergyPrefs;
}

// `energy/save_prefs` takes the pref keys as top-level command fields, not a
// nested object, and replaces each supplied key wholesale.
export async function saveEnergyPrefs(s: HaWsSession, prefs: HaEnergyPrefs): Promise<void> {
  await s.request({ type: "energy/save_prefs", ...prefs });
}

export interface HaRepairIssue {
  issue_id: string;
  domain: string;
  issue_domain?: string | null;
  created?: string;
  ignored?: boolean;
  is_fixable?: boolean;
  severity?: string;
  learn_more_url?: string | null;
  breaks_in_ha_version?: string | null;
  translation_key?: string | null;
  translation_placeholders?: Record<string, string> | null;
}

export async function listRepairIssues(s: HaWsSession): Promise<HaRepairIssue[]> {
  const res = (await s.request({ type: "repairs/list_issues" })) as { issues?: HaRepairIssue[] } | null;
  return res?.issues ?? [];
}

/** Flat translation resources keyed `component.<domain>.issues.<translation_key>.title`. */
export async function getIssueTranslations(
  s: HaWsSession,
  domains: string[],
): Promise<Record<string, string>> {
  const res = (await s.request({
    type: "frontend/get_translations",
    language: "en",
    category: "issues",
    integration: domains,
  })) as { resources?: Record<string, string> } | null;
  return res?.resources ?? {};
}
