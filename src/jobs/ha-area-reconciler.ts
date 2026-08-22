import { parse } from "yaml";
import {
  HOME_ASSISTANT_AREA_RECONCILER_ENABLED,
  HOME_ASSISTANT_CONFIG_REPO,
  LABELS,
} from "../config.js";
import * as gh from "../github.js";
import * as ha from "../home-assistant.js";
import type { HaAreaEntry, HaEntityRegistryEntry } from "../home-assistant.js";
import * as log from "../log.js";
import { closeAlertIssueIfResolved, ensureAlertIssue } from "../occurrence-tracking.js";
import { isShuttingDown } from "../shutdown.js";
import { notify } from "../slack.js";
import { sleep } from "../util.js";

const LOG_PREFIX = "ha-area-reconciler";
const MANIFEST_PATH = "registry/areas.yaml";
const ALERT_TITLE = "[ha-area-reconciler] registry/areas.yaml does not match Home Assistant";
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60_000;

const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const AREA_ID_RE = /^[a-z0-9_]+$/;

export interface AreaChange {
  entityId: string;
  from: string | null;
  to: string;
}

export interface UnknownArea {
  entityId: string;
  areaId: string;
}

export interface AreaDiff {
  changes: AreaChange[];
  okCount: number;
  missingEntities: string[];
  unknownAreas: UnknownArea[];
  deviceBacked: string[];
}

export interface AlertProblems {
  parseErrors: string[];
  missingEntities: string[];
  unknownAreas: UnknownArea[];
  validAreaIds: string[];
}

// Parses the repo manifest. Rather than throwing on the first bad line, every
// problem is collected so a single alert issue can describe them all.
export function parseAreaManifest(text: string): { entities: Map<string, string>; errors: string[] } {
  const entities = new Map<string, string>();
  const errors: string[] = [];

  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    return { entities, errors: [`YAML parse error: ${(err as Error).message}`] };
  }

  if (doc === null || doc === undefined) {
    return { entities, errors: [`Manifest is empty — expected a top-level \`entities\` mapping`] };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { entities, errors: [`Manifest must be a mapping with a top-level \`entities\` key`] };
  }

  const raw = (doc as Record<string, unknown>)["entities"];
  if (raw === null || raw === undefined) return { entities, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { entities, errors: [`\`entities\` must be a mapping of entity_id to area id`] };
  }

  for (const [entityId, areaId] of Object.entries(raw as Record<string, unknown>)) {
    if (!ENTITY_ID_RE.test(entityId)) {
      errors.push(`\`${entityId}\` is not a valid entity_id (expected \`domain.object_id\`)`);
      continue;
    }
    if (typeof areaId !== "string") {
      errors.push(`\`${entityId}\`: area id must be a string, got ${areaId === null ? "null" : typeof areaId}`);
      continue;
    }
    if (!AREA_ID_RE.test(areaId)) {
      errors.push(`\`${entityId}\`: \`${areaId}\` is not a valid area id (expected lowercase letters, digits and underscores)`);
      continue;
    }
    entities.set(entityId, areaId);
  }

  return { entities, errors };
}

export function diffAreas(
  manifest: Map<string, string>,
  registry: HaEntityRegistryEntry[],
  areas: HaAreaEntry[],
): AreaDiff {
  const byEntityId = new Map(registry.map((e) => [e.entity_id, e]));
  const knownAreaIds = new Set(areas.map((a) => a.area_id));

  const changes: AreaChange[] = [];
  const missingEntities: string[] = [];
  const unknownAreas: UnknownArea[] = [];
  const deviceBacked: string[] = [];
  let okCount = 0;

  for (const [entityId, areaId] of manifest) {
    const entry = byEntityId.get(entityId);
    if (!entry) {
      missingEntities.push(entityId);
      continue;
    }
    if (!knownAreaIds.has(areaId)) {
      unknownAreas.push({ entityId, areaId });
      continue;
    }
    if (entry.area_id === areaId) {
      okCount++;
      continue;
    }
    changes.push({ entityId, from: entry.area_id, to: areaId });
    if (entry.device_id !== null) deviceBacked.push(entityId);
  }

  return { changes, okCount, missingEntities, unknownAreas, deviceBacked };
}

export function buildAlertBody(problems: AlertProblems, asOf: string): string {
  const lines: string[] = [
    `Automated Home Assistant area reconciler. \`${MANIFEST_PATH}\` references entities or areas that Home Assistant does not have. This issue auto-closes once the manifest matches.`,
    "",
    `**As of (UTC):** ${asOf}`,
  ];

  if (problems.parseErrors.length > 0) {
    lines.push("", `### Manifest could not be read`, "");
    for (const e of problems.parseErrors) lines.push(`- ${e}`);
  }

  if (problems.missingEntities.length > 0) {
    lines.push(
      "",
      `### Entities not in the Home Assistant registry`,
      "",
      `These are listed in \`${MANIFEST_PATH}\` but no matching registry entry exists — likely a typo, or the entity has not been created yet.`,
      "",
    );
    for (const e of problems.missingEntities) lines.push(`- \`${e}\``);
  }

  if (problems.unknownAreas.length > 0) {
    lines.push("", `### Unknown area ids`, "");
    for (const u of problems.unknownAreas) lines.push(`- \`${u.entityId}\` → \`${u.areaId}\``);
    lines.push(
      "",
      `Valid area ids: ${problems.validAreaIds.length > 0 ? problems.validAreaIds.map((a) => `\`${a}\``).join(", ") : "_(none)_"}`,
    );
  }

  return lines.join("\n");
}

interface AttemptResult {
  diff: AreaDiff;
  areaIds: string[];
  applied: AreaChange[];
  failed: number;
}

async function reconcileOnce(manifest: Map<string, string>): Promise<AttemptResult> {
  return ha.withHaWebSocket(async (session) => {
    const areas = await ha.listAreaRegistry(session);
    const registry = await ha.listEntityRegistry(session);
    const diff = diffAreas(manifest, registry, areas);

    const applied: AreaChange[] = [];
    let failed = 0;
    for (const change of diff.changes) {
      if (diff.deviceBacked.includes(change.entityId)) {
        log.warn(`[${LOG_PREFIX}] ${change.entityId} is device-backed — setting area_id pins a per-entity override`);
      }
      log.info(`[${LOG_PREFIX}] ${change.entityId}: ${change.from ?? "(none)"} -> ${change.to}`);
      try {
        await ha.setEntityArea(session, change.entityId, change.to);
        applied.push(change);
      } catch (err) {
        failed++;
        log.warn(`[${LOG_PREFIX}] Failed to set area for ${change.entityId}: ${(err as Error).message}`);
      }
    }

    return { diff, areaIds: areas.map((a) => a.area_id).sort(), applied, failed };
  });
}

export async function run(): Promise<void> {
  if (!HOME_ASSISTANT_AREA_RECONCILER_ENABLED) {
    log.debug(`[${LOG_PREFIX}] Disabled — skipping`);
    return;
  }
  if (!ha.isConfigured()) {
    log.debug(`[${LOG_PREFIX}] HA token/URL not configured — skipping`);
    return;
  }

  const repo = HOME_ASSISTANT_CONFIG_REPO ?? "St-John-Software/home-assistant-config";

  const text = await gh.fetchRepoFileContent(repo, MANIFEST_PATH);
  if (text === null) {
    log.debug(`[${LOG_PREFIX}] ${repo} has no ${MANIFEST_PATH} — skipping`);
    return;
  }

  const asOf = new Date().toISOString();
  const { entities, errors } = parseAreaManifest(text);
  if (errors.length > 0) {
    await ensureAlertIssue({
      repo,
      title: ALERT_TITLE,
      body: buildAlertBody({ parseErrors: errors, missingEntities: [], unknownAreas: [], validAreaIds: [] }, asOf),
      labels: [LABELS.priority],
      logPrefix: LOG_PREFIX,
      refreshBody: true,
    });
    log.warn(`[${LOG_PREFIX}] ${MANIFEST_PATH} has ${errors.length} problem(s) — alert issue raised`);
    return;
  }

  let result: AttemptResult | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      result = await reconcileOnce(entities);
    } catch (err) {
      // HA unreachable or mid-restart — not a manifest fault, so never alert.
      // ha-upgrader/ha-deploy-watcher already surface HA outages.
      if (attempt < MAX_ATTEMPTS && !isShuttingDown()) {
        log.debug(`[${LOG_PREFIX}] Attempt ${attempt} failed (${(err as Error).message}) — retrying`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      log.warn(`[${LOG_PREFIX}] Could not reach Home Assistant after ${attempt} attempt(s): ${(err as Error).message}`);
      return;
    }

    // A just-merged entity may not exist yet — core_git_pull polls every ≤5 min
    // and a restart follows. Retry before calling it a typo. Re-applying an
    // already-correct area is a no-op, so retrying costs nothing.
    if (result.diff.missingEntities.length > 0 && attempt < MAX_ATTEMPTS && !isShuttingDown()) {
      log.debug(
        `[${LOG_PREFIX}] ${result.diff.missingEntities.length} entity/entities not in the registry — waiting for deploy (attempt ${attempt})`,
      );
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    break;
  }

  if (!result) return;
  const { diff, areaIds, applied, failed } = result;

  try {
    if (diff.missingEntities.length > 0 || diff.unknownAreas.length > 0) {
      await ensureAlertIssue({
        repo,
        title: ALERT_TITLE,
        body: buildAlertBody(
          {
            parseErrors: [],
            missingEntities: diff.missingEntities,
            unknownAreas: diff.unknownAreas,
            validAreaIds: areaIds,
          },
          new Date().toISOString(),
        ),
        labels: [LABELS.priority],
        logPrefix: LOG_PREFIX,
        refreshBody: true,
      });
    } else {
      await closeAlertIssueIfResolved({
        repo,
        title: ALERT_TITLE,
        logPrefix: LOG_PREFIX,
        reason: "manifest matches Home Assistant",
      });
    }
  } catch (err) {
    log.warn(`[${LOG_PREFIX}] GitHub operation failed: ${(err as Error).message}`);
  }

  if (applied.length > 0) {
    const lines = applied.map((c) => `• \`${c.entityId}\`: ${c.from ?? "(none)"} → ${c.to}`);
    await notify(
      `:round_pushpin: Reconciled ${applied.length} Home Assistant entity area(s) to match \`${MANIFEST_PATH}\`:\n${lines.join("\n")}`,
    );
  }

  log.info(
    `[${LOG_PREFIX}] ${entities.size} managed, ${applied.length} updated, ${diff.okCount} already correct` +
      (failed > 0 ? `, ${failed} failed` : ""),
  );
}
