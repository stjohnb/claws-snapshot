import { execFile } from "node:child_process";
import { TTLCache } from "./ttl-cache.js";
import * as log from "./log.js";
import { enrichedPath } from "./cli-path.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_BUFFER_BYTES = 20 * 1024 * 1024;

export interface CodexModelCatalogue {
  visible: ReadonlySet<string>;
  upgrades: ReadonlyMap<string, string>;
}

const cache = new TTLCache<CodexModelCatalogue | null>();
let warnedCatalogueUnavailable = false;

function parseCodexModelsJson(stdout: string): CodexModelCatalogue {
  const body = JSON.parse(stdout) as { models?: unknown };
  const rows = Array.isArray(body.models) ? body.models : [];
  if (rows.length === 0) throw new Error("empty model catalogue");

  const visible = new Set<string>();
  const upgrades = new Map<string, string>();
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const entry = row as { slug?: unknown; visibility?: unknown; upgrade?: { model?: unknown } | null };
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    if (!slug) continue;
    if (entry.visibility === "list") visible.add(slug);
    const upgradeModel = entry.upgrade && typeof entry.upgrade.model === "string" ? entry.upgrade.model : "";
    if (upgradeModel) upgrades.set(slug, upgradeModel);
  }

  if (visible.size === 0) throw new Error("no visible models in catalogue");
  return { visible, upgrades };
}

async function fetchCodexModelCatalogue(): Promise<CodexModelCatalogue | null> {
  try {
    const env = { ...process.env, PATH: enrichedPath(process.env["PATH"]) };
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "codex",
        ["debug", "models"],
        { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES, env },
        (err, out, stderr) => {
          if (err) {
            const detail = stderr || err.message;
            reject(new Error(detail.trim() || "codex debug models failed"));
            return;
          }
          resolve(out);
        },
      );
    });
    return parseCodexModelsJson(stdout);
  } catch (err) {
    if (!warnedCatalogueUnavailable) {
      warnedCatalogueUnavailable = true;
      log.warn(`[codex-models] Codex model catalogue unavailable; configured Codex model IDs will be used without live validation: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

export async function getCodexModelCatalogue(): Promise<CodexModelCatalogue | null> {
  return cache.dedupedFetch("models", CACHE_TTL_MS, fetchCodexModelCatalogue);
}

export function __resetCodexModelCatalogueForTests(): void {
  cache.clear();
  warnedCatalogueUnavailable = false;
}
