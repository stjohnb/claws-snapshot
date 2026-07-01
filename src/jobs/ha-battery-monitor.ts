import {
  HOME_ASSISTANT_BATTERY_MONITOR_ENABLED,
  HOME_ASSISTANT_BATTERY_THRESHOLD_PERCENT,
  LABELS,
} from "../config.js";
import * as log from "../log.js";
import * as gh from "../github.js";
import { resolveHaMonitorContext } from "./ha-monitor-common.js";
import type { HAState } from "../home-assistant.js";

const LOG_PREFIX = "ha-battery-monitor";
const ALERT_TITLE = "[ha-battery-monitor] Devices with low battery";

export interface LowDevice {
  entityId: string;
  name: string;
  level: number;
}

export function isBatterySensor(s: HAState): boolean {
  return (
    s.attributes?.["device_class"] === "battery" &&
    s.attributes?.["unit_of_measurement"] === "%"
  );
}

export function findLowBatteries(states: HAState[], threshold: number): LowDevice[] {
  return states
    .filter(isBatterySensor)
    .flatMap((s) => {
      const level = parseFloat(String(s.state));
      if (Number.isNaN(level)) return [];
      // <= threshold: a device at exactly 10% is the canonical low-battery case
      if (level > threshold) return [];
      return [{
        entityId: s.entity_id,
        name: String(s.attributes?.["friendly_name"] ?? s.entity_id),
        level,
      }];
    })
    .sort((a, b) => a.level - b.level);
}

export function buildBody(low: LowDevice[], asOf: string, threshold: number): string {
  const lines: string[] = [];

  lines.push(
    `Automated Home Assistant battery monitor. Devices at or below ${threshold}% battery. This issue auto-closes when all devices recover.`,
    "",
    `**Last checked (UTC):** ${asOf}`,
    "",
    "| Device | Entity | Battery |",
    "| --- | --- | --- |",
  );

  for (const d of low) {
    lines.push(`| ${d.name} | \`${d.entityId}\` | ${d.level}% |`);
  }

  return lines.join("\n");
}

export async function run(): Promise<void> {
  const ctx = await resolveHaMonitorContext(HOME_ASSISTANT_BATTERY_MONITOR_ENABLED, LOG_PREFIX);
  if (!ctx) return;
  const { repo, states } = ctx;

  const threshold = HOME_ASSISTANT_BATTERY_THRESHOLD_PERCENT;
  const low = findLowBatteries(states, threshold);
  const asOf = new Date().toISOString();

  try {
    const existing = await gh.findIssueByExactTitle(repo, ALERT_TITLE);

    if (low.length > 0) {
      const newBody = buildBody(low, asOf, threshold);
      if (!existing) {
        await gh.createIssue(repo, ALERT_TITLE, newBody, [LABELS.priority]);
        log.info(`[${LOG_PREFIX}] Created alert issue in ${repo} — ${low.length} device(s) low`);
      } else {
        const currentBody = (await gh.getIssueBody(repo, existing.number)) ?? "";
        if (newBody !== currentBody) {
          await gh.editIssue(repo, existing.number, newBody);
          log.info(`[${LOG_PREFIX}] Updated alert issue #${existing.number} in ${repo}`);
        } else {
          log.debug(`[${LOG_PREFIX}] Alert issue #${existing.number} body unchanged — skipping edit`);
        }
      }
    } else {
      if (existing) {
        await gh.closeIssue(repo, existing.number, "completed");
        log.info(`[${LOG_PREFIX}] All devices recovered — closed issue #${existing.number} in ${repo}`);
      } else {
        log.debug(`[${LOG_PREFIX}] No low batteries and no open issue — nothing to do`);
      }
    }
  } catch (err) {
    log.warn(`[${LOG_PREFIX}] GitHub operation failed: ${(err as Error).message}`);
  }
}
