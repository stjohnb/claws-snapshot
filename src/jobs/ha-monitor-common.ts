import { HOME_ASSISTANT_CONFIG_REPO, FLEET_INFRA_REPO } from "../config.js";
import * as ha from "../home-assistant.js";
import * as log from "../log.js";
import { defangPhrase, guardContent } from "../prompt-guard.js";
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

// Home Assistant free text (friendly names, update titles, release notes, sensor
// states) is user-controlled — anyone with HA UI access, or a device announcing a
// crafted name at pairing time — and ends up in a Claws-authored issue body/title
// that formatIssueCommentsForPrompt() later reads back WITHOUT re-guarding, so a
// payload landing here is trusted by every later planning/implementing agent. In
// homeAssistantConfigRepo that agent's MCP config additionally carries the live HA
// token. guardContent() redacts known injection spans and raises the usual Slack
// alert; defangPhrase() then neutralises residual instruction tokens while keeping
// the value legible. itemNumber 0 because the alert issue does not exist yet at
// body-build time — that suppresses the ⚠️ issue comment, not the log/Slack alert.
//
// guardContent() raises its Slack alert on every scan that scores over threshold
// and dedups nothing itself, while these bodies are rebuilt every tick (bin-day and
// deploy-stall every 15 minutes). Re-scanning an unchanged value would therefore
// page Slack indefinitely for as long as the condition stays open, so the guarded
// form is cached per raw input. The cache is keyed on the raw string only, so the
// same value seen under two different `source` labels reports under whichever
// label it was first seen — the output is identical either way.
const GUARD_CACHE_MAX = 500;
const guardCache = new Map<string, string>();

/** Test-only: reset the guard dedup cache between test cases. */
export function __resetHaGuardCacheForTests(): void {
  guardCache.clear();
}

function guardHaValue(raw: string, source: string): string {
  const hit = guardCache.get(raw);
  if (hit !== undefined) return hit;
  const scanned = guardContent(raw, {
    repo: HOME_ASSISTANT_CONFIG_REPO || FLEET_INFRA_REPO || "St-John-Software/home-assistant-config",
    source,
    itemNumber: 0,
  });
  guardCache.set(raw, scanned);
  while (guardCache.size > GUARD_CACHE_MAX) {
    const oldest = guardCache.keys().next().value;
    if (oldest === undefined) break;
    guardCache.delete(oldest);
  }
  return scanned;
}

// Guard the FULL string, then truncate: truncating first would let a crafted value
// push its injection phrase past the cut, out of reach of scanContent()'s regexes.

/** Single-line HA free text for a table cell, code span, or issue title. */
export function sanitiseHaCell(raw: string, source: string, maxLen = 120): string {
  return defangPhrase(guardHaValue(raw, source).slice(0, maxLen)).replace(/[`|\r\n]/g, " ");
}

/** Multi-line HA free text for a fenced block: newlines kept, backticks neutralised. */
export function sanitiseHaBlock(raw: string, source: string, maxLen = 2000): string {
  return defangPhrase(guardHaValue(raw, source).slice(0, maxLen)).replace(/`/g, "'").replace(/\r/g, "");
}
