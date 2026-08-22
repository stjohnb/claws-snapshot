import { HOME_ASSISTANT_CONFIG_REPO, FLEET_INFRA_REPO } from "../config.js";
import * as ha from "../home-assistant.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import type { HAState } from "../home-assistant.js";

export interface HaMonitorContext {
  repo: string;
  states: HAState[];
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

  let states: HAState[];
  try {
    states = await ha.listStates();
  } catch (err) {
    log.warn(`[${logPrefix}] Could not fetch HA states: ${(err as Error).message}`);
    return null;
  }

  return { repo, states };
}

export interface UpsertAlertIssueOptions {
  repo: string;
  title: string;
  body: string;
  labels: string[];
  logPrefix: string;
  /** Extra context appended to the "Created alert issue" log line, e.g. "3 device(s) low". */
  createdDetail?: string;
}

export type UpsertAlertIssueResult = "created" | "updated" | "unchanged";

/**
 * Find-or-create an alert issue by exact title, editing the body only when it
 * actually changed. Deliberately NOT ensureAlertIssue(): that helper stamps an
 * occurrence timestamp into the body, which forces an editIssue on every tick.
 * HA monitors whose body is a pure function of sensor state want the no-op path
 * instead, so a persistent alert costs one listOpenIssues + one getIssueBody
 * per tick and nothing else.
 */
export async function upsertAlertIssue(
  opts: UpsertAlertIssueOptions,
): Promise<UpsertAlertIssueResult> {
  const { repo, title, body, labels, logPrefix, createdDetail } = opts;
  const existing = await gh.findIssueByExactTitle(repo, title);
  if (!existing) {
    await gh.createIssue(repo, title, body, labels);
    log.info(`[${logPrefix}] Created alert issue in ${repo}: ${title}${createdDetail ? ` — ${createdDetail}` : ""}`);
    return "created";
  }
  const currentBody = (await gh.getIssueBody(repo, existing.number)) ?? "";
  if (body === currentBody) {
    log.debug(`[${logPrefix}] Alert issue #${existing.number} body unchanged — skipping edit`);
    return "unchanged";
  }
  await gh.editIssue(repo, existing.number, body);
  log.info(`[${logPrefix}] Updated alert issue #${existing.number} in ${repo}`);
  return "updated";
}
