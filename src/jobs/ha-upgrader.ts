import {
  HOME_ASSISTANT_UPGRADER_ENABLED,
  HOME_ASSISTANT_UPGRADER_EXCLUDE_PATTERNS,
  HOME_ASSISTANT_CONFIG_REPO,
  FLEET_INFRA_REPO,
  LABELS,
} from "../config.js";
import * as ha from "../home-assistant.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { notify } from "../slack.js";
import { reportError } from "../error-reporter.js";
import {
  getHaUpgraderState,
  upsertHaUpgraderFirstSeen,
  recordHaUpgraderAttempt,
} from "../db.js";

const MAX_INSTALLS_PER_RUN = 5;
const MAX_HIGH_RISK_INSTALLS_PER_RUN = 1;
const COOLDOWN_MS = 6 * 60 * 60 * 1000;
const HIGH_RISK_MIN_AVAILABILITY_MS = 48 * 60 * 60 * 1000;
const DEVICE_MIN_AVAILABILITY_MS = 24 * 60 * 60 * 1000;

const HIGH_RISK_PATTERN = /^update\.home_assistant_(core|supervisor|operating_system|os)/;
const HIGH_RISK_PRIORITY = ["supervisor", "core", "operating_system", "os"];

export { clearHaUpgraderStateForTests as _resetCooldownForTests } from "../db.js";

function isCoreSupervisorOs(entityId: string): boolean { return HIGH_RISK_PATTERN.test(entityId); }
function isUserExcluded(entityId: string, regexes: RegExp[]): boolean { return regexes.some((r) => r.test(entityId)); }

async function raiseHaUpgradeAlert(
  entityId: string,
  attributes: Record<string, unknown>,
  titleOverride?: string,
): Promise<boolean> {
  const title = titleOverride ?? `[HA] Upgrade available: ${String(attributes.title ?? entityId)} → ${String(attributes.latest_version)}`;

  const repo = HOME_ASSISTANT_CONFIG_REPO || FLEET_INFRA_REPO;

  const existing = await gh.findIssueByExactTitle(repo, title);
  if (existing) return false;

  const releaseSummary = attributes.release_summary
    ? String(attributes.release_summary).slice(0, 2000)
    : null;

  const bodyLines = [
    `- **Installed version:** ${String(attributes.installed_version ?? "unknown")}`,
    `- **Latest version:** ${String(attributes.latest_version ?? "unknown")}`,
    attributes.release_url ? `- **Release notes:** ${String(attributes.release_url)}` : null,
    releaseSummary
      ? `- **Release summary:**\n\`\`\`\n${releaseSummary}\n\`\`\``
      : null,
    "",
    `_To install, run: \`curl -X POST -H "Authorization: Bearer $CLAWS_HOME_ASSISTANT_TOKEN" -H "Content-Type: application/json" -d '{"entity_id":"${entityId}"}' $CLAWS_HOME_ASSISTANT_BASE_URL/api/services/update/install\`_`,
  ].filter((l): l is string => l !== null).join("\n");

  await gh.createIssue(repo, title, bodyLines, [LABELS.priority]);
  return true;
}

async function escalateInstallFailure(
  entity_id: string,
  attributes: Record<string, unknown>,
  latestVersion: string,
  nextFailures: number,
  installFailureTitles: string[],
): Promise<void> {
  if (nextFailures < 3) return;
  try {
    const failureTitle = `[HA] Install failed (${nextFailures}x): ${String(attributes.title ?? entity_id)} → ${latestVersion}`;
    const raised = await raiseHaUpgradeAlert(entity_id, attributes, failureTitle);
    if (raised) installFailureTitles.push(`${entity_id} (install failure)`);
  } catch (alertErr) {
    log.warn(`[ha-upgrader] Failed to raise issue for ${entity_id}: ${alertErr}`);
  }
}

export async function run(): Promise<void> {
  try {
    if (!HOME_ASSISTANT_UPGRADER_ENABLED) {
      log.info("[ha-upgrader] Disabled — skipping");
      return;
    }

    if (!ha.isConfigured()) {
      log.info("[ha-upgrader] HA token/URL not configured — skipping");
      return;
    }

    const allUpdates = await ha.listUpdateEntities();

    const candidates = allUpdates.filter((s) => {
      if (s.state !== "on") return false;
      if (s.attributes.auto_update === true) return false;
      if (s.attributes.in_progress) return false;
      const latest = s.attributes.latest_version;
      if (!latest || typeof latest !== "string") return false;
      if (latest === s.attributes.skipped_version) return false;
      return true;
    });

    const excludeRegexes = HOME_ASSISTANT_UPGRADER_EXCLUDE_PATTERNS.flatMap((p) => {
      try { return [new RegExp(p)]; }
      catch { log.warn(`[ha-upgrader] Invalid exclude pattern ignored: ${p}`); return []; }
    });

    const userExcluded: typeof candidates = [];
    const highRiskAutoInstall: typeof candidates = [];
    const autoInstall: typeof candidates = [];
    for (const s of candidates) {
      if (isUserExcluded(s.entity_id, excludeRegexes)) userExcluded.push(s);
      else if (isCoreSupervisorOs(s.entity_id)) highRiskAutoInstall.push(s);
      else autoInstall.push(s);
    }

    const rank = (id: string) => {
      const idx = HIGH_RISK_PRIORITY.findIndex((p) => id.includes(`_${p}`));
      return idx === -1 ? HIGH_RISK_PRIORITY.length : idx;
    };
    highRiskAutoInstall.sort((a, b) => rank(a.entity_id) - rank(b.entity_id));

    const now = Date.now();
    for (const s of [...highRiskAutoInstall, ...autoInstall, ...userExcluded]) {
      upsertHaUpgraderFirstSeen(s.entity_id, String(s.attributes.latest_version), now);
    }

    const installedEntities: Array<{ entityId: string; installedVersion: string; latestVersion: string }> = [];
    const installFailureTitles: string[] = [];
    const userExcludedAlertTitles: string[] = [];

    // Device firmware installs (serial — HA supervisor can wedge under concurrent installs)
    let dwellDeferredDevice = 0;
    const capped = autoInstall.slice(0, MAX_INSTALLS_PER_RUN);

    for (const entity of capped) {
      const { entity_id, attributes } = entity;
      const latestVersion = String(attributes.latest_version);
      const installedVersion = String(attributes.installed_version ?? "unknown");

      const state = getHaUpgraderState(entity_id);
      if (!state) continue;
      if (state.attempted_at > 0 && state.failure_count === 0 && Date.now() - state.attempted_at < COOLDOWN_MS) continue;
      if (state.failure_count >= 3) continue;
      if (Date.now() - state.first_seen_at < DEVICE_MIN_AVAILABILITY_MS) { dwellDeferredDevice++; continue; }

      try {
        await ha.installUpdate(entity_id, { backup: false });
        log.info(`[ha-upgrader] Installed ${entity_id} → ${latestVersion}`);
        recordHaUpgraderAttempt(entity_id, latestVersion, Date.now(), 0);
        installedEntities.push({ entityId: entity_id, installedVersion, latestVersion });
      } catch (err) {
        log.warn(`[ha-upgrader] Failed to install ${entity_id}: ${err}`);
        const nextFailures = state.failure_count + 1;
        recordHaUpgraderAttempt(entity_id, latestVersion, Date.now(), nextFailures);
        await escalateInstallFailure(entity_id, attributes, latestVersion, nextFailures, installFailureTitles);
      }
    }

    // High-risk (Core/Supervisor/OS) auto-installs with optional pre-install backup
    const highRiskInstalled: typeof installedEntities = [];
    let dwellDeferredHighRisk = 0;
    let highRiskInstalledWithBackup = 0;
    let highRiskInstalledWithoutBackup = 0;
    const cappedHighRisk = highRiskAutoInstall.slice(0, MAX_HIGH_RISK_INSTALLS_PER_RUN);

    for (const entity of cappedHighRisk) {
      const { entity_id, attributes } = entity;
      const latestVersion = String(attributes.latest_version);
      const installedVersion = String(attributes.installed_version ?? "unknown");
      const state = getHaUpgraderState(entity_id);
      if (!state) continue;
      if (state.attempted_at > 0 && state.failure_count === 0 && Date.now() - state.attempted_at < COOLDOWN_MS) continue;
      if (state.failure_count >= 3) continue;
      if (Date.now() - state.first_seen_at < HIGH_RISK_MIN_AVAILABILITY_MS) { dwellDeferredHighRisk++; continue; }

      const supportedFeatures = (attributes.supported_features as number | undefined) ?? 0;
      const wantBackup = (supportedFeatures & ha.UPDATE_BACKUP_FEATURE_BIT) !== 0;

      try {
        await notify(`[ha-upgrader] Installing high-risk update with${wantBackup ? "" : "out"} pre-install backup: ${entity_id} ${installedVersion} → ${latestVersion}`);
      } catch (notifyErr) {
        log.warn(`[ha-upgrader] Pre-install Slack notify failed for ${entity_id}: ${notifyErr}`);
      }

      try {
        await ha.installUpdate(entity_id, { backup: wantBackup });
        log.info(`[ha-upgrader] Installed high-risk ${entity_id} → ${latestVersion} (backup=${wantBackup})`);
        recordHaUpgraderAttempt(entity_id, latestVersion, Date.now(), 0);
        highRiskInstalled.push({ entityId: entity_id, installedVersion, latestVersion });
        if (wantBackup) highRiskInstalledWithBackup++; else highRiskInstalledWithoutBackup++;
      } catch (err) {
        log.warn(`[ha-upgrader] Failed to install high-risk ${entity_id}: ${err}`);
        const nextFailures = state.failure_count + 1;
        recordHaUpgraderAttempt(entity_id, latestVersion, Date.now(), nextFailures);
        await escalateInstallFailure(entity_id, attributes, latestVersion, nextFailures, installFailureTitles);
      }
    }

    // User-excluded entities — raise issues instead of installing
    for (const entity of userExcluded) {
      const { entity_id, attributes } = entity;
      try {
        const raised = await raiseHaUpgradeAlert(entity_id, attributes);
        if (raised) {
          userExcludedAlertTitles.push(String(attributes.title ?? entity_id));
        }
      } catch (err) {
        log.warn(`[ha-upgrader] Failed to raise issue for ${entity_id}: ${err}`);
      }
    }

    const totalInstalled = installedEntities.length + highRiskInstalled.length;

    if (
      totalInstalled > 0 ||
      userExcludedAlertTitles.length > 0 ||
      installFailureTitles.length > 0
    ) {
      const allInstalled = [...installedEntities, ...highRiskInstalled];
      const bulletLines = allInstalled.map(
        ({ entityId, installedVersion, latestVersion }) =>
          `- ${entityId}: ${installedVersion} → ${latestVersion}`,
      );
      const displayedBullets = bulletLines.slice(0, 10);
      if (bulletLines.length > 10) {
        displayedBullets.push(`… and ${bulletLines.length - 10} more`);
      }

      const clauses: string[] = [];
      if (installedEntities.length > 0) clauses.push(`Installed ${installedEntities.length} device update(s)`);
      if (highRiskInstalled.length > 0) {
        let clause = `Installed ${highRiskInstalled.length} high-risk update(s) (Core/Supervisor/OS)`;
        if (highRiskInstalledWithBackup > 0 && highRiskInstalledWithoutBackup === 0) {
          clause += " with pre-install backup";
        } else if (highRiskInstalledWithBackup > 0 && highRiskInstalledWithoutBackup > 0) {
          clause += ` (${highRiskInstalledWithBackup} with backup, ${highRiskInstalledWithoutBackup} without)`;
        } else if (highRiskInstalledWithoutBackup > 0) {
          clause += " without pre-install backup";
        }
        clauses.push(clause);
      }
      if (userExcludedAlertTitles.length > 0) clauses.push(`${userExcludedAlertTitles.length} update(s) excluded by user pattern need manual review`);
      if (installFailureTitles.length > 0) clauses.push(`${installFailureTitles.length} install failure(s) escalated as issues`);

      let summary = [
        `[ha-upgrader] ${clauses.join("; ")}`,
        ...displayedBullets,
      ].join("\n");

      const deferred = autoInstall.length - capped.length;
      if (deferred > 0) summary += `\n(${deferred} additional update(s) deferred to next run — cap of ${MAX_INSTALLS_PER_RUN} reached)`;

      const highRiskDeferred = highRiskAutoInstall.length - cappedHighRisk.length;
      if (highRiskDeferred > 0) summary += `\n(${highRiskDeferred} high-risk update(s) deferred to next run — cap of ${MAX_HIGH_RISK_INSTALLS_PER_RUN} reached)`;

      notify(summary);
    }
  } catch (err) {
    log.error(`[ha-upgrader] Uncaught error: ${err}`);
    await reportError("ha-upgrader:run", "Uncaught error in ha-upgrader", err);
  }
}
