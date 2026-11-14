import { HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_CONFIG_REPO, HOME_ASSISTANT_TOKEN } from "./config.js";
import { retryWithBackoff } from "./retry.js";

const HA_TRANSIENT_RE = /\bHA API (429|500|502|503|504)\b/;
const HA_MAX_RETRIES = 3;

export const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;

export function isHaTransient(err: Error): boolean {
  return HA_TRANSIENT_RE.test(err.message) || err.name === "TimeoutError";
}

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
 *  HA is configured and this is the HA config repo. Callers must pass the
 *  generated MCP config through provider selection and run options so whichever
 *  automated backend is selected receives the same tools. */
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
