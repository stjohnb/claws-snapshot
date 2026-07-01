import {
  HOME_ASSISTANT_BIN_DAY_MONITOR_ENABLED,
  HOME_ASSISTANT_BIN_DAY_SENSOR_PREFIX,
  LABELS,
} from "../config.js";
import * as log from "../log.js";
import * as gh from "../github.js";
import { resolveHaMonitorContext } from "./ha-monitor-common.js";
import type { HAState } from "../home-assistant.js";

const LOG_PREFIX = "bin-day-monitor";
const ALERT_TITLE = "[bin-day-monitor] Bin day sensors missing values";
const MISSING_STATES = new Set(["unavailable", "unknown", ""]);
// STATUS_RE and buildBody must stay in sync — parsePrevStatus round-trips against what buildBody writes.
const STATUS_RE = /\*\*Current status:\*\* (HEALTHY|MISSING)/;
const HISTORY_HEADER = "### Status history";

export type Status = "HEALTHY" | "MISSING";

export function pickBinSensors(states: HAState[], prefix: string): HAState[] {
  return states.filter((s) => s.entity_id.startsWith(prefix));
}

export function findMissing(sensors: HAState[]): HAState[] {
  return sensors.filter((s) => MISSING_STATES.has(String(s.state).trim().toLowerCase()));
}

export function parsePrevStatus(body: string): Status | null {
  const m = STATUS_RE.exec(body);
  return m ? (m[1] as Status) : null;
}

export function extractHistoryRows(body: string): string[] {
  const headerIdx = body.indexOf(HISTORY_HEADER);
  if (headerIdx === -1) return [];
  const afterHeader = body.slice(headerIdx + HISTORY_HEADER.length);
  const separatorIdx = afterHeader.indexOf("| --- | --- | --- |");
  if (separatorIdx === -1) return [];
  const afterSeparator = afterHeader.slice(separatorIdx + "| --- | --- | --- |".length);
  return afterSeparator
    .split("\n")
    .filter((line) => line.startsWith("| "));
}

export function buildBody(
  status: Status,
  asOf: string,
  missing: HAState[],
  noneFound: boolean,
  prefix: string,
  historyRows: string[],
): string {
  const lines: string[] = [];

  lines.push(
    `Automated monitor of Home Assistant bin-day sensors (prefix \`${prefix}\`). Updated every 15 minutes — this issue is intentionally kept open as a running availability log.`,
    "",
    `**Current status:** ${status}`,
    `**Last checked (UTC):** ${asOf}`,
    "",
  );

  if (status === "MISSING") {
    if (noneFound) {
      lines.push(`No entities matched prefix \`${prefix}\` — the integration may have been removed or renamed.`);
    } else {
      lines.push("Currently missing:");
      for (const s of missing) {
        const friendlyName = String(s.attributes?.["friendly_name"] ?? s.entity_id);
        lines.push(`- \`${s.entity_id}\` (${friendlyName}) — state: \`${String(s.state)}\``);
      }
    }
  } else {
    lines.push("All sensors reporting values.");
  }

  lines.push(
    "",
    HISTORY_HEADER,
    "",
    "| Time (UTC) | Status | Detail |",
    "| --- | --- | --- |",
    ...historyRows,
  );

  return lines.join("\n");
}

export async function run(): Promise<void> {
  const ctx = await resolveHaMonitorContext(HOME_ASSISTANT_BIN_DAY_MONITOR_ENABLED, LOG_PREFIX);
  if (!ctx) return;
  const { repo, states } = ctx;

  const prefix = HOME_ASSISTANT_BIN_DAY_SENSOR_PREFIX;
  const sensors = pickBinSensors(states, prefix);
  const missing = findMissing(sensors);
  const noneFound = sensors.length === 0;
  const status: Status = noneFound || missing.length > 0 ? "MISSING" : "HEALTHY";
  const asOf = new Date().toISOString();

  let detail: string;
  if (status === "MISSING") {
    if (noneFound) {
      detail = `no entities matched prefix \`${prefix}\``;
    } else {
      const ids = missing.map((s) => s.entity_id);
      const capped = ids.length > 5 ? [...ids.slice(0, 5), "…"] : ids;
      detail = `${missing.length} sensor(s) missing: ${capped.join(", ")}`;
    }
  } else {
    detail = `all ${sensors.length} sensors reporting`;
  }

  try {
    const existing = await gh.findIssueByExactTitle(repo, ALERT_TITLE);

    if (!existing) {
      if (status === "HEALTHY") {
        log.debug(`[${LOG_PREFIX}] All sensors healthy and no existing issue — nothing to track`);
        return;
      }
      const firstRow = `| ${asOf} | MISSING | ${detail} |`;
      const body = buildBody(status, asOf, missing, noneFound, prefix, [firstRow]);
      await gh.createIssue(repo, ALERT_TITLE, body, [LABELS.priority]);
      log.info(`[${LOG_PREFIX}] Created alert issue in ${repo}`);
    } else {
      const currentBody = (await gh.getIssueBody(repo, existing.number)) ?? "";
      const prev = parsePrevStatus(currentBody);
      const rows = extractHistoryRows(currentBody);
      const changed = prev !== status;

      if (changed) {
        rows.push(`| ${asOf} | ${status} | ${detail} |`);
        log.info(`[${LOG_PREFIX}] Status transition: ${prev ?? "unknown"} → ${status}`);
      }

      // Always rebuild to keep "Last checked" fresh so the monitor is visibly alive.
      await gh.editIssue(repo, existing.number, buildBody(status, asOf, missing, noneFound, prefix, rows));
    }
  } catch (err) {
    log.warn(`[${LOG_PREFIX}] GitHub operation failed: ${(err as Error).message}`);
  }
}
