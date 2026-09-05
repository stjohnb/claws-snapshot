import { HOME_ASSISTANT_DEPLOY_STALL_MONITOR_ENABLED, LABELS } from "../config.js";
import * as log from "../log.js";
import { resolveHaMonitorContext } from "./ha-monitor-common.js";
import { upsertAlertIssue } from "../occurrence-tracking.js";
import type { HAState } from "../home-assistant.js";
import { closeAlertIssueIfResolved } from "../occurrence-tracking.js";

const LOG_PREFIX = "ha-deploy-stall-monitor";
const STALLED_ENTITY = "binary_sensor.deploy_pipeline_stalled";
const ADDON_STATE_ENTITY = "sensor.git_pull_addon_state";
const ALERT_TITLE = "[ha-deploy-stall-monitor] Home Assistant deploy pipeline stalled — core_git_pull did not self-heal";
const UNUSABLE_STATES = new Set(["unavailable", "unknown", ""]);

export function readStalled(states: HAState[]): "on" | "off" | null {
  const s = states.find((st) => st.entity_id === STALLED_ENTITY);
  if (!s) return null;
  const state = String(s.state).toLowerCase();
  if (state === "on") return "on";
  if (state === "off") return "off";
  return null;
}

export function readAddonState(states: HAState[]): string | null {
  const s = states.find((st) => st.entity_id === ADDON_STATE_ENTITY);
  if (!s) return null;
  if (UNUSABLE_STATES.has(String(s.state).toLowerCase())) return null;
  return String(s.state);
}

// Deliberately no "Last checked (UTC)" timestamp: the body is a pure function of
// the add-on state, so a persistent stall skips the edit every tick instead of
// churning editIssue calls (unlike ha-backup-monitor, which embeds asOf).
export function buildStallBody(addonState: string | null): string {
  return [
    "Automated Home Assistant deploy-pipeline monitor. `binary_sensor.deploy_pipeline_stalled` is `on`: the `core_git_pull` add-on has been unhealthy for over 45 minutes **and the automatic restart (automation `1786723200000`) did not recover it**. Merged changes to `home-assistant-config` are not reaching `/config`.",
    "",
    `**Current \`sensor.git_pull_addon_state\`:** \`${addonState ?? "unknown"}\``,
    "",
    "### Runbook",
    "",
    "1. The add-on has already been restarted automatically. Do **not** start by re-creating the deploy key.",
    "2. Open the `core_git_pull` add-on log in Home Assistant (Settings → Add-ons → Git pull → Log).",
    "3. If the log ends with `git@github.com: Permission denied (publickey)` and that persists *across the automatic restarts*, the deploy key genuinely needs re-creating. A single transient rejection was the root cause of the 2026-08-13 outage (home-assistant-config#332) — the key itself was valid, the add-on simply treats one failed fetch as FATAL and never retries.",
    "4. Any other error (merge conflict in `/config`, disk full, Supervisor API failure) needs fixing at the source; the add-on will not retry on its own.",
    "",
    "This issue is filed automatically and auto-closes when the sensor returns to `off`.",
  ].join("\n");
}

export async function run(): Promise<void> {
  const ctx = await resolveHaMonitorContext(HOME_ASSISTANT_DEPLOY_STALL_MONITOR_ENABLED, LOG_PREFIX);
  if (!ctx) return;
  const { repo, states } = ctx;
  try {
    const stalled = readStalled(states);
    if (stalled === null) {
      log.debug(`[${LOG_PREFIX}] ${STALLED_ENTITY} absent or unavailable — skipping`);
      return;
    }
    if (stalled === "on") {
      await upsertAlertIssue({ repo, title: ALERT_TITLE, body: buildStallBody(readAddonState(states)), labels: [LABELS.priority], logPrefix: LOG_PREFIX });
    } else {
      const closed = await closeAlertIssueIfResolved({
        repo,
        title: ALERT_TITLE,
        logPrefix: LOG_PREFIX,
        reason: "deploy pipeline recovered (binary_sensor.deploy_pipeline_stalled back to off)",
      });
      if (closed === null) {
        log.debug(`[${LOG_PREFIX}] Deploy pipeline healthy and no open issue — nothing to do`);
      }
    }
  } catch (err) {
    log.warn(`[${LOG_PREFIX}] GitHub operation failed: ${(err as Error).message}`);
  }
}
