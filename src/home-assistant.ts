import { HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN } from "./config.js";
import { retryWithBackoff } from "./retry.js";

const HA_TRANSIENT_RE = /\bHA API (429|500|502|503|504)\b/;
const HA_MAX_RETRIES = 3;

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
