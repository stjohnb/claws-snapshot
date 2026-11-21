import * as config from "./config.js";
import { TTLCache } from "./ttl-cache.js";
import { isValidSessionModel } from "./session-models.js";

/**
 * OpenRouter's live model catalogue, for the /sessions OpenCode free-text
 * model box's autosuggest (#2878). Leaf-ish module: only config, ttl-cache,
 * and session-models, so it can be imported from server.ts without pulling
 * in sessions.ts.
 */

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const cache = new TTLCache<string[]>();

interface OpenRouterModelsResponse {
  data?: unknown;
}

/**
 * Some catalogue ids are prefixed with `~` (e.g. `~anthropic/claude-fable-latest`).
 * `isValidSessionModel` rejects `~` (it is not in the allowed character set),
 * and `POST /sessions/create` would 400 on such a value, so those ids are
 * filtered out here rather than surfaced as a suggestion. Every surviving id
 * is prefixed with `openrouter/` so the value is directly usable as
 * `opencode --model <id>`.
 */
async function fetchModelIds(): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (config.OPENROUTER_API_KEY) headers["Authorization"] = `Bearer ${config.OPENROUTER_API_KEY}`;

  const res = await fetch(MODELS_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`);

  const body = await res.json() as OpenRouterModelsResponse;
  const rows = Array.isArray(body?.data) ? body.data : [];
  if (rows.length === 0) throw new Error("OpenRouter models: empty catalogue");

  const seen = new Set<string>();
  for (const row of rows) {
    const id = (row as { id?: unknown } | null)?.id;
    if (typeof id !== "string") continue;
    const prefixed = `openrouter/${id}`;
    if (!isValidSessionModel(prefixed)) continue;
    seen.add(prefixed);
  }
  return Array.from(seen).sort();
}

export async function listOpenRouterSessionModels(): Promise<string[]> {
  return cache.dedupedFetch("models", CACHE_TTL_MS, fetchModelIds);
}
