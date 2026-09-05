import { HOME_ASSISTANT_BACKUP_MONITOR_ENABLED, LABELS } from "../config.js";
import * as log from "../log.js";
import { resolveHaMonitorContext } from "./ha-monitor-common.js";
import { upsertAlertIssue } from "../occurrence-tracking.js";
import type { HAState } from "../home-assistant.js";
import { closeAlertIssueIfResolved } from "../occurrence-tracking.js";
import { recordHaEntityUnavailable, clearHaEntityUnavailable } from "../db.js";

const LOG_PREFIX = "ha-backup-monitor";
const BACKUP_EVENT_ENTITY = "event.backup_automatic_backup";
const OVERDUE_ENTITY = "binary_sensor.backup_overdue";
const LAST_SUCCESS_ENTITY = "sensor.backup_last_successful_automatic_backup";
const FAILED_TITLE = "[ha-backup-monitor] Home Assistant automatic backup failed";
const OVERDUE_TITLE = "[ha-backup-monitor] Home Assistant backups are overdue";
const BLIND_TITLE = "[ha-backup-monitor] Home Assistant backup monitor is blind — binary_sensor.backup_overdue unavailable";
export const BLIND_THRESHOLD_MS = 48 * 60 * 60 * 1000;
const UNUSABLE_STATES = new Set(["unavailable", "unknown", ""]);

export interface BackupEventInfo {
  eventType: string;
  timestamp: string;
  failedReason: string | null;
}

export function readBackupEvent(states: HAState[]): BackupEventInfo | null {
  const s = states.find((st) => st.entity_id === BACKUP_EVENT_ENTITY);
  if (!s) return null;
  if (UNUSABLE_STATES.has(String(s.state).toLowerCase())) return null;

  const rawEventType = s.attributes?.["event_type"];
  const eventType = rawEventType === undefined || rawEventType === null
    ? ""
    : String(rawEventType).trim().toLowerCase();

  const rawFailedReason = s.attributes?.["failed_reason"];
  const failedReason = rawFailedReason === undefined || rawFailedReason === null || String(rawFailedReason).trim() === ""
    ? null
    : String(rawFailedReason);

  return { eventType, timestamp: String(s.state), failedReason };
}

export function readOverdue(states: HAState[]): "on" | "off" | null {
  const s = states.find((st) => st.entity_id === OVERDUE_ENTITY);
  if (!s) return null;
  const state = String(s.state).toLowerCase();
  if (state === "on") return "on";
  if (state === "off") return "off";
  return null;
}

export function readRawState(states: HAState[], entityId: string): string | null {
  const s = states.find((st) => st.entity_id === entityId);
  return s ? String(s.state) : null;
}

export function buildFailedBody(info: BackupEventInfo, asOf: string): string {
  return [
    "Automated Home Assistant backup monitor. The nightly automatic backup reported a failure.",
    "",
    `**Last checked (UTC):** ${asOf}`,
    `**Backup event timestamp:** ${info.timestamp}`,
    `**Reason:** ${info.failedReason ?? "no reason reported"}`,
    "",
    "This issue is filed automatically and auto-closes when a later automatic backup completes.",
  ].join("\n");
}

export function buildOverdueBody(asOf: string): string {
  return [
    "Automated Home Assistant backup monitor. `binary_sensor.backup_overdue` is `on` — no successful automatic backup within the threshold configured in Home Assistant (36 hours).",
    "",
    `**Last checked (UTC):** ${asOf}`,
    "",
    "This issue is filed automatically and auto-closes when the sensor returns to `off`.",
  ].join("\n");
}

// Deliberately no "Last checked (UTC)" timestamp: the body is a pure function
// of sensor state, so a persistent blind spot skips the edit every tick
// instead of churning editIssue calls.
export function buildBlindBody(firstUnavailableIso: string, overdueRaw: string | null, lastSuccessRaw: string | null): string {
  return [
    "Automated Home Assistant backup monitor. `binary_sensor.backup_overdue` has been unreadable for more than 48 hours, so the overdue alert cannot fire. This usually means no automatic backup has ever completed: the sensor's `availability:` template is `has_value('sensor.backup_last_successful_automatic_backup')`, and that sensor is `unknown` until the first successful automatic backup completes (home-assistant-config#341).",
    "",
    `**First seen unavailable (UTC):** ${firstUnavailableIso}`,
    `**\`binary_sensor.backup_overdue\`:** \`${overdueRaw ?? "entity absent"}\``,
    `**\`sensor.backup_last_successful_automatic_backup\`:** \`${lastSuccessRaw ?? "entity absent"}\``,
    "",
    "### Runbook",
    "",
    "1. Check that the Home Assistant backup integration is configured and that `.storage/backup` has a `last_completed_automatic_backup` recorded.",
    "2. Run `backup.create_automatic` manually once to seed it.",
    "3. If the entity is absent rather than `unavailable`, the template in `configuration.yaml` failed to load or was renamed.",
    "",
    "This issue is filed automatically and auto-closes when the sensor reads `on` or `off` again.",
  ].join("\n");
}

async function reconcileFailed(repo: string, states: HAState[], asOf: string): Promise<void> {
  try {
    const info = readBackupEvent(states);
    if (!info) {
      log.debug(`[${LOG_PREFIX}] ${BACKUP_EVENT_ENTITY} absent or unusable — skipping`);
      return;
    }

    if (info.eventType === "failed") {
      await upsertAlertIssue({ repo, title: FAILED_TITLE, body: buildFailedBody(info, asOf), labels: [LABELS.priority], logPrefix: LOG_PREFIX });
    } else if (info.eventType === "completed") {
      const closed = await closeAlertIssueIfResolved({
        repo,
        title: FAILED_TITLE,
        logPrefix: LOG_PREFIX,
        reason: "a later automatic backup completed",
      });
      if (closed === null) {
        log.debug(`[${LOG_PREFIX}] Backup completed and no open failure issue — nothing to do`);
      }
    } else {
      log.debug(`[${LOG_PREFIX}] Backup event_type "${info.eventType}" — no action`);
    }
  } catch (err) {
    log.warn(`[${LOG_PREFIX}] GitHub operation failed: ${(err as Error).message}`);
  }
}

async function reconcileOverdue(repo: string, states: HAState[], asOf: string, nowMs: number): Promise<void> {
  try {
    const overdue = readOverdue(states);
    if (overdue === null) {
      const firstSeen = recordHaEntityUnavailable(OVERDUE_ENTITY, nowMs);
      const elapsed = nowMs - firstSeen;
      if (elapsed >= BLIND_THRESHOLD_MS) {
        await upsertAlertIssue({
          repo,
          title: BLIND_TITLE,
          body: buildBlindBody(new Date(firstSeen).toISOString(), readRawState(states, OVERDUE_ENTITY), readRawState(states, LAST_SUCCESS_ENTITY)),
          labels: [LABELS.priority],
          logPrefix: LOG_PREFIX,
        });
      } else {
        log.debug(`[${LOG_PREFIX}] ${OVERDUE_ENTITY} unreadable for ${Math.round(elapsed / 3_600_000)}h — below 48h threshold, no alert`);
      }
      return;
    }

    clearHaEntityUnavailable(OVERDUE_ENTITY);
    const blindClosed = await closeAlertIssueIfResolved({
      repo,
      title: BLIND_TITLE,
      logPrefix: LOG_PREFIX,
      reason: `${OVERDUE_ENTITY} is readable again`,
    });
    if (blindClosed === null) {
      log.debug(`[${LOG_PREFIX}] ${OVERDUE_ENTITY} readable and no open blind-monitor issue`);
    }

    if (overdue === "on") {
      await upsertAlertIssue({ repo, title: OVERDUE_TITLE, body: buildOverdueBody(asOf), labels: [LABELS.priority], logPrefix: LOG_PREFIX });
    } else {
      const closed = await closeAlertIssueIfResolved({
        repo,
        title: OVERDUE_TITLE,
        logPrefix: LOG_PREFIX,
        reason: "backups no longer overdue",
      });
      if (closed === null) {
        log.debug(`[${LOG_PREFIX}] Backups not overdue and no open issue — nothing to do`);
      }
    }
  } catch (err) {
    log.warn(`[${LOG_PREFIX}] GitHub operation failed: ${(err as Error).message}`);
  }
}

export async function run(): Promise<void> {
  const ctx = await resolveHaMonitorContext(HOME_ASSISTANT_BACKUP_MONITOR_ENABLED, LOG_PREFIX);
  if (!ctx) return;
  const { repo, states } = ctx;
  const nowMs = Date.now();
  const asOf = new Date(nowMs).toISOString();
  await reconcileFailed(repo, states, asOf);
  await reconcileOverdue(repo, states, asOf, nowMs);
}
