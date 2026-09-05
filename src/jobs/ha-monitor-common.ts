import { HOME_ASSISTANT_CONFIG_REPO, FLEET_INFRA_REPO } from "../config.js";
import * as ha from "../home-assistant.js";
import * as log from "../log.js";
import type { HAState } from "../home-assistant.js";

export interface HaMonitorContext {
  repo: string;
  states: HAState[];
}

export function resolveHaMonitorRepo(enabled: boolean, logPrefix: string): string | null {
  if (!enabled) {
    log.debug(`[${logPrefix}] Disabled — skipping`);
    return null;
  }
  if (!ha.isConfigured()) {
    log.debug(`[${logPrefix}] HA token/URL not configured — skipping`);
    return null;
  }
  const repo = HOME_ASSISTANT_CONFIG_REPO || FLEET_INFRA_REPO;
  if (!repo) {
    log.warn(`[${logPrefix}] No repo configured (homeAssistantConfigRepo or fleetInfraRepo) — skipping`);
    return null;
  }
  return repo;
}

/**
 * Shared entry guard for Home Assistant monitors. Returns null (and logs the
 * reason) when the monitor should skip this run; otherwise returns the resolved
 * repo and fetched HA states. The `enabled` flag and `logPrefix` are the only
 * per-monitor differences.
 */
export async function resolveHaMonitorContext(
  enabled: boolean,
  logPrefix: string,
): Promise<HaMonitorContext | null> {
  const repo = resolveHaMonitorRepo(enabled, logPrefix);
  if (!repo) return null;

  let states: HAState[];
  try {
    states = await ha.listStates();
  } catch (err) {
    log.warn(`[${logPrefix}] Could not fetch HA states: ${(err as Error).message}`);
    return null;
  }

  return { repo, states };
}
