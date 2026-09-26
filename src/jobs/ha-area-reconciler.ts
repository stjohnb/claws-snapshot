import { parse } from "yaml";
import {
  HOME_ASSISTANT_AREA_RECONCILER_ENABLED,
  HOME_ASSISTANT_CONFIG_REPO,
  LABELS,
} from "../config.js";
import * as gh from "../github.js";
import * as ha from "../home-assistant.js";
import type {
  HaAreaEntry,
  HaDeviceRegistryEntry,
  HaEntityRegistryEntry,
  HaFloorEntry,
} from "../home-assistant.js";
import * as log from "../log.js";
import { closeAlertIssueIfResolved, ensureAlertIssue, upsertAlertIssue } from "../occurrence-tracking.js";
import { defangPhrase, guardContent } from "../prompt-guard.js";
import { isShuttingDown } from "../shutdown.js";
import { notify } from "../slack.js";
import { sleep } from "../util.js";

const LOG_PREFIX = "ha-area-reconciler";
const MANIFEST_PATH = "registry/areas.yaml";
const ALERT_TITLE = "[ha-area-reconciler] registry/areas.yaml does not match Home Assistant";
const DRIFT_TITLE =
  "[ha-area-reconciler] Home Assistant floors, areas or device areas have drifted from registry/areas.yaml";
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60_000;

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

export interface ManifestFloor {
  name: string;
  level?: number;
  icon?: string;
}

export interface ManifestArea {
  name: string;
  floor: string;
  icon?: string;
}

export interface ParsedManifest {
  entities: Map<string, string>;
  floors: Map<string, ManifestFloor>;
  areas: Map<string, ManifestArea>;
  devices: Map<string, string>;
  errors: string[];
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Parses the repo manifest. Rather than throwing on the first bad line, every
// problem is collected so a single alert issue can describe them all.
//
// `floors:`, `areas:` and `devices:` are all optional — a manifest carrying only
// `entities:` (as `home-assistant-config@main` did before those blocks landed)
// parses cleanly to empty maps and zero errors.
export function parseAreaManifest(text: string): ParsedManifest {
  const entities = new Map<string, string>();
  const floors = new Map<string, ManifestFloor>();
  const areas = new Map<string, ManifestArea>();
  const devices = new Map<string, string>();
  const errors: string[] = [];
  const empty = { entities, floors, areas, devices };

  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    return { ...empty, errors: [`YAML parse error: ${(err as Error).message}`] };
  }

  if (doc === null || doc === undefined) {
    return { ...empty, errors: [`Manifest is empty — expected a top-level \`entities\` mapping`] };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { ...empty, errors: [`Manifest must be a mapping with a top-level \`entities\` key`] };
  }

  const rawFloors = (doc as Record<string, unknown>)["floors"];
  if (rawFloors !== null && rawFloors !== undefined) {
    if (!isMapping(rawFloors)) {
      errors.push(`\`floors\` must be a mapping of floor id to definition`);
    } else {
      for (const [floorId, def] of Object.entries(rawFloors)) {
        if (!AREA_ID_RE.test(floorId)) {
          errors.push(`\`floors.${floorId}\` is not a valid floor id (expected lowercase letters, digits and underscores)`);
          continue;
        }
        if (!isMapping(def)) {
          errors.push(`\`floors.${floorId}\` must be a mapping with at least a \`name\``);
          continue;
        }
        const { name, level, icon } = def;
        if (typeof name !== "string" || name.length === 0) {
          errors.push(`\`floors.${floorId}.name\` must be a non-empty string`);
          continue;
        }
        if (level !== null && level !== undefined && !Number.isInteger(level)) {
          errors.push(`\`floors.${floorId}.level\` must be an integer`);
          continue;
        }
        if (icon !== null && icon !== undefined && typeof icon !== "string") {
          errors.push(`\`floors.${floorId}.icon\` must be a string`);
          continue;
        }
        const floor: ManifestFloor = { name };
        if (typeof level === "number") floor.level = level;
        if (typeof icon === "string") floor.icon = icon;
        floors.set(floorId, floor);
      }
    }
  }

  const rawAreas = (doc as Record<string, unknown>)["areas"];
  if (rawAreas !== null && rawAreas !== undefined) {
    if (!isMapping(rawAreas)) {
      errors.push(`\`areas\` must be a mapping of area id to definition`);
    } else {
      for (const [areaId, def] of Object.entries(rawAreas)) {
        if (!AREA_ID_RE.test(areaId)) {
          errors.push(`\`areas.${areaId}\` is not a valid area id (expected lowercase letters, digits and underscores)`);
          continue;
        }
        if (!isMapping(def)) {
          errors.push(`\`areas.${areaId}\` must be a mapping with a \`name\` and a \`floor\``);
          continue;
        }
        const { name, floor, icon } = def;
        if (typeof name !== "string" || name.length === 0) {
          errors.push(`\`areas.${areaId}.name\` must be a non-empty string`);
          continue;
        }
        if (typeof floor !== "string" || !AREA_ID_RE.test(floor)) {
          errors.push(`\`areas.${areaId}.floor\` must be a valid floor id (expected lowercase letters, digits and underscores)`);
          continue;
        }
        if (icon !== null && icon !== undefined && typeof icon !== "string") {
          errors.push(`\`areas.${areaId}.icon\` must be a string`);
          continue;
        }
        const area: ManifestArea = { name, floor };
        if (typeof icon === "string") area.icon = icon;
        areas.set(areaId, area);
      }
    }
  }

  const rawDevices = (doc as Record<string, unknown>)["devices"];
  if (rawDevices !== null && rawDevices !== undefined) {
    if (!isMapping(rawDevices)) {
      errors.push(`\`devices\` must be a mapping of device key to area id`);
    } else {
      for (const [key, areaId] of Object.entries(rawDevices)) {
        // The key is an opaque canonical identifier, so there is no format to
        // check beyond it being present.
        if (key.length === 0) {
          errors.push(`\`devices\` contains an empty device key`);
          continue;
        }
        if (typeof areaId !== "string") {
          errors.push(`\`devices.${key}\`: area id must be a string, got ${areaId === null ? "null" : typeof areaId}`);
          continue;
        }
        if (!AREA_ID_RE.test(areaId)) {
          errors.push(`\`devices.${key}\`: \`${areaId}\` is not a valid area id (expected lowercase letters, digits and underscores)`);
          continue;
        }
        devices.set(key, areaId);
      }
    }
  }

  const raw = (doc as Record<string, unknown>)["entities"];
  if (raw === null || raw === undefined) return { entities, floors, areas, devices, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`\`entities\` must be a mapping of entity_id to area id`);
    return { entities, floors, areas, devices, errors };
  }

  for (const [entityId, areaId] of Object.entries(raw as Record<string, unknown>)) {
    if (!ha.ENTITY_ID_RE.test(entityId)) {
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

  return { entities, floors, areas, devices, errors };
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

export interface FieldDrift {
  id: string;
  field: string;
  expected: string;
  actual: string;
}

export interface DeviceAreaDrift {
  key: string;
  deviceId: string;
  deviceName: string;
  expected: string;
  actual: string;
}

export interface RegistryDrift {
  missingFloors: string[];
  missingAreas: string[];
  missingDevices: string[];
  floorFields: FieldDrift[];
  areaFields: FieldDrift[];
  deviceAreas: DeviceAreaDrift[];
  okFloors: number;
  okAreas: number;
  okDeviceRows: number;
}

// The manifest's canonical device key: `domain:value` for each identifier pair,
// sorted and comma-joined. Devices with no identifiers (UniFi clients, mostly)
// key off their connections instead, behind a `connections=` prefix so the two
// namespaces can never collide.
export function deviceKey(d: HaDeviceRegistryEntry): string {
  const render = (pairs: [string, string][] | undefined): string =>
    (pairs ?? []).map((p) => `${String(p?.[0] ?? "")}:${String(p?.[1] ?? "")}`).sort().join(",");

  const identifiers = d.identifiers ?? [];
  if (identifiers.length > 0) return render(identifiers);
  return `connections=${render(d.connections)}`;
}

function haValue(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "(none)";
  return String(v);
}

// Pure drift detection for the `floors:`, `areas:` and `devices:` blocks.
// `floors:` and `areas:` stay report-only: HA mints floor and area ids from
// names, so a create could never honour the manifest's ids, and requirement
// (5) forbids deletes. A manifest key HA does not have is drift to report,
// never a write, for any block.
//
// `devices:` area drift on a row that already exists is different: it is
// applied by reconcileOnce() via `config/device_registry/update`, which takes
// `{ device_id, area_id }` and honours both ids verbatim — the same shape as
// `config/entity_registry/update` for `entities:`. diffRegistries() itself
// stays pure; it only computes the drift, and does not care whether the
// caller reports it or writes it back.
//
// Only fields the manifest actually declares are compared — omitting `icon:` is
// silence, not an assertion of null, so setting an icon in the UI does not
// alert forever. Registry rows the manifest never mentions are ignored
// entirely; the manifest is partial authority, exactly as it is for entities.
export function diffRegistries(
  parsed: Pick<ParsedManifest, "floors" | "areas" | "devices">,
  floors: HaFloorEntry[],
  areas: HaAreaEntry[],
  devices: HaDeviceRegistryEntry[],
): RegistryDrift {
  const missingFloors: string[] = [];
  const missingAreas: string[] = [];
  const missingDevices: string[] = [];
  const floorFields: FieldDrift[] = [];
  const areaFields: FieldDrift[] = [];
  const deviceAreas: DeviceAreaDrift[] = [];
  let okFloors = 0;
  let okAreas = 0;
  let okDeviceRows = 0;

  const haFloors = new Map(floors.map((f) => [f.floor_id, f]));
  for (const [floorId, want] of parsed.floors) {
    const got = haFloors.get(floorId);
    if (!got) {
      missingFloors.push(floorId);
      continue;
    }
    const before = floorFields.length;
    if (got.name !== want.name) {
      floorFields.push({ id: floorId, field: "name", expected: want.name, actual: haValue(got.name) });
    }
    if (want.level !== undefined && got.level !== want.level) {
      floorFields.push({ id: floorId, field: "level", expected: String(want.level), actual: haValue(got.level) });
    }
    if (want.icon !== undefined && got.icon !== want.icon) {
      floorFields.push({ id: floorId, field: "icon", expected: want.icon, actual: haValue(got.icon) });
    }
    if (floorFields.length === before) okFloors++;
  }

  const haAreas = new Map(areas.map((a) => [a.area_id, a]));
  for (const [areaId, want] of parsed.areas) {
    const got = haAreas.get(areaId);
    if (!got) {
      missingAreas.push(areaId);
      continue;
    }
    const before = areaFields.length;
    if (got.name !== want.name) {
      areaFields.push({ id: areaId, field: "name", expected: want.name, actual: haValue(got.name) });
    }
    if (got.floor_id !== want.floor) {
      areaFields.push({ id: areaId, field: "floor", expected: want.floor, actual: haValue(got.floor_id) });
    }
    if (want.icon !== undefined && got.icon !== want.icon) {
      areaFields.push({ id: areaId, field: "icon", expected: want.icon, actual: haValue(got.icon) });
    }
    if (areaFields.length === before) okAreas++;
  }

  // Grouped, not 1:1 — HA 2026.8 splits some devices into composite sub-devices
  // that share one identifier set, so a manifest key can match several rows.
  const byKey = new Map<string, HaDeviceRegistryEntry[]>();
  for (const d of devices) {
    const key = deviceKey(d);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(d);
    else byKey.set(key, [d]);
  }

  for (const [key, want] of parsed.devices) {
    const rows = byKey.get(key);
    if (!rows || rows.length === 0) {
      missingDevices.push(key);
      continue;
    }
    for (const row of rows) {
      if (row.area_id === want) {
        okDeviceRows++;
        continue;
      }
      deviceAreas.push({
        key,
        deviceId: row.id,
        deviceName: row.name_by_user ?? row.name ?? row.id,
        expected: want,
        actual: haValue(row.area_id),
      });
    }
  }

  return {
    missingFloors,
    missingAreas,
    missingDevices,
    floorFields,
    areaFields,
    deviceAreas,
    okFloors,
    okAreas,
    okDeviceRows,
  };
}

function driftCount(drift: RegistryDrift): number {
  return (
    drift.missingFloors.length +
    drift.missingAreas.length +
    drift.missingDevices.length +
    drift.floorFields.length +
    drift.areaFields.length +
    drift.deviceAreas.length
  );
}

function configRepo(): string {
  return HOME_ASSISTANT_CONFIG_REPO ?? "St-John-Software/home-assistant-config";
}

// Home Assistant names are user-controlled (anyone with HA UI access, or a device
// announcing a crafted name at pairing time) and end up in a Claws-authored issue
// body — which formatIssueCommentsForPrompt() reads back WITHOUT re-guarding, so a
// payload that lands here is trusted by every later planning/implementing agent.
// guardContent() redacts known injection spans and raises the usual Slack alert;
// defangPhrase() then neutralises residual instruction tokens while keeping the
// name legible, since a redacted-to-nothing name is useless to the human fixing the
// drift. itemNumber 0 because the alert issue does not exist yet at body-build time
// — that suppresses the ⚠️ comment, not the log/Slack alert. Backticks and pipes are
// stripped last so they cannot break the Markdown tables.
//
// Order matters: guardContent() sees the FULL name, never a truncated one, or a
// crafted name could push its injection phrase past the cut and out of reach of
// scanContent()'s regexes. Truncation to table width happens after redaction, where
// it can only drop text, never re-expose it.
//
// guardContent() raises its Slack alert on every scan that scores over the
// threshold and dedups nothing itself (the POSTED_COMMENTS dedup only gates the
// ⚠️ issue comment, which itemNumber 0 suppresses anyway), while buildDriftBody
// re-runs on every tick the drift persists. Re-scanning an unchanged name would
// therefore page Slack every 30 minutes for as long as the drift stays open, so
// the guarded form is cached per raw input: a value is scanned — and alerted on —
// the first time it is seen and stays quiet until it actually changes.
// buildDriftBody rotates the cache on each call and only the previous generation
// is consulted, so the cache holds the strings the current drift references plus
// at most one tick of history, never the whole registry's history.
let guardCache = new Map<string, string>();
let guardCachePrev = new Map<string, string>();

/** Test-only: reset the guard dedup cache between test cases. */
export function __resetGuardCacheForTests(): void {
  guardCache = new Map();
  guardCachePrev = new Map();
}

function guarded(s: string): string {
  const hit = guardCache.get(s) ?? guardCachePrev.get(s);
  if (hit !== undefined) {
    guardCache.set(s, hit);
    return hit;
  }
  const scanned = guardContent(s, {
    repo: configRepo(),
    source: "home-assistant-registry",
    itemNumber: 0,
  });
  guardCache.set(s, scanned);
  return scanned;
}

// Free-text Home Assistant names: truncated to table width, since a name long
// enough to wreck the table's readability is not worth rendering in full.
function sanitise(s: string): string {
  return defangPhrase(guarded(s).slice(0, 80)).replace(/[`|\r\n]/g, " ");
}

// Exact identifiers — canonical device keys — are NOT truncated: a human has to
// paste one back into the manifest verbatim to fix the drift, and the multi-
// identifier Matter keys in the live manifest run past 100 characters, so a cut
// at 80 would emit a value that cannot be used. Redaction and defanging still
// apply; only the width cut is dropped.
function sanitiseId(s: string): string {
  return defangPhrase(guarded(s)).replace(/[`|\r\n]/g, " ");
}

// Deliberately no "As of (UTC)" timestamp: the body is a pure function of the
// registry drift, so upsertAlertIssue() skips the edit every tick that the drift
// is unchanged instead of churning editIssue calls.
export function buildDriftBody(drift: RegistryDrift): string {
  guardCachePrev = guardCache;
  guardCache = new Map();

  const lines: string[] = [
    `Automated Home Assistant area reconciler. Home Assistant's floor, area or device-area registries no longer match \`${MANIFEST_PATH}\`. Git is the source of truth for these blocks. Device areas are **enforced** — a device moved in the Home Assistant UI is moved back within 30 minutes, so to move a device, change the manifest. Floors and areas are report-only: Home Assistant mints floor and area ids from names, so a create could not honour the ids in the manifest, and a manifest id that Home Assistant lacks is reported rather than deleted. Fix the items below either in the Home Assistant UI or with a PR to \`${MANIFEST_PATH}\`. This issue auto-closes once the two match.`,
  ];

  if (drift.missingFloors.length > 0) {
    lines.push("", `### Floors in the manifest that Home Assistant does not have`, "");
    for (const f of drift.missingFloors) lines.push(`- \`${f}\``);
  }

  if (drift.missingAreas.length > 0) {
    lines.push("", `### Areas in the manifest that Home Assistant does not have`, "");
    for (const a of drift.missingAreas) lines.push(`- \`${a}\``);
  }

  if (drift.missingDevices.length > 0) {
    lines.push(
      "",
      `### Device keys that match no Home Assistant device`,
      "",
      `A device that has left the network (a UniFi client, say) shows up here. Nothing is deleted.`,
      "",
    );
    for (const d of drift.missingDevices) lines.push(`- \`${sanitiseId(d)}\``);
  }

  const table = (heading: string, rows: FieldDrift[]): void => {
    if (rows.length === 0) return;
    lines.push("", `### ${heading}`, "", `| id | field | manifest | Home Assistant |`, `|---|---|---|---|`);
    for (const r of rows) {
      lines.push(`| \`${r.id}\` | ${r.field} | ${sanitise(r.expected)} | ${sanitise(r.actual)} |`);
    }
  };

  table("Floor definitions that differ", drift.floorFields);
  table("Area definitions that differ", drift.areaFields);

  if (drift.deviceAreas.length > 0) {
    lines.push(
      "",
      `### Device areas that could not be applied`,
      "",
      `These rows were not written back: either the manifest's area id does not exist in Home Assistant (see the areas section above), or \`config/device_registry/update\` failed. Every other device-area difference was applied automatically.`,
      "",
      `| device | field | manifest | Home Assistant |`,
      `|---|---|---|---|`,
    );
    for (const d of drift.deviceAreas) {
      lines.push(`| ${sanitise(d.deviceName)} (\`${sanitiseId(d.key)}\`) | area | ${sanitise(d.expected)} | ${sanitise(d.actual)} |`);
    }
  }

  return lines.join("\n");
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
  /** null when the floor/device registry read failed — no drift data this tick. */
  drift: RegistryDrift | null;
  areaIds: string[];
  applied: AreaChange[];
  failed: number;
  /** Device rows whose area_id was written this tick — reported to Slack, not to the drift issue. */
  appliedDevices: DeviceAreaDrift[];
  deviceFailed: number;
}

async function reconcileOnce(parsed: ParsedManifest): Promise<AttemptResult> {
  return ha.withHaWebSocket(async (session) => {
    // Four independent reads over one already-open session, which multiplexes by
    // request id — no reason to pay for them serially. allSettled rather than all:
    // the area and entity registries feed the live, enforcing entity path and must
    // still abort the attempt, but the floor and device registries feed only the
    // report-only drift issue, so a failure there (an HA version without the
    // command, a malformed row) degrades to "no drift data this tick" instead of
    // taking entity reconciliation down with it.
    const [areasR, floorsR, devicesR, registryR] = await Promise.allSettled([
      ha.listAreaRegistry(session),
      ha.listFloorRegistry(session),
      ha.listDeviceRegistry(session),
      ha.listEntityRegistry(session),
    ]);
    if (areasR.status === "rejected") throw areasR.reason;
    if (registryR.status === "rejected") throw registryR.reason;
    const areas = areasR.value;
    const registry = registryR.value;

    const diff = diffAreas(parsed.entities, registry, areas);
    let drift: RegistryDrift | null = null;
    if (floorsR.status === "fulfilled" && devicesR.status === "fulfilled") {
      drift = diffRegistries(parsed, floorsR.value, areas, devicesR.value);
    } else {
      const reason = (floorsR.status === "rejected" ? floorsR.reason : (devicesR as PromiseRejectedResult).reason) as Error;
      log.warn(`[${LOG_PREFIX}] Floor/device registry read failed (${reason.message}) — skipping the drift check this tick`);
    }

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

    const appliedDevices: DeviceAreaDrift[] = [];
    let deviceFailed = 0;
    if (drift !== null && drift.deviceAreas.length > 0) {
      const knownAreaIds = new Set(areas.map((a) => a.area_id));
      const remaining: DeviceAreaDrift[] = [];
      for (const d of drift.deviceAreas) {
        // Never send an area_id HA does not have: the write would fail, and the
        // manifest-side problem (a `devices:` target absent from HA's area
        // registry, which also shows up in missingAreas when the manifest
        // declares it) belongs in the drift issue, not in a retry loop.
        if (!knownAreaIds.has(d.expected)) {
          remaining.push(d);
          continue;
        }
        // Device names are user-controlled and unguarded here, so the log line
        // carries ids only; the guarded name goes in the issue body / Slack.
        log.info(`[${LOG_PREFIX}] device ${d.deviceId}: ${d.actual} -> ${d.expected}`);
        try {
          await ha.setDeviceArea(session, d.deviceId, d.expected);
          appliedDevices.push(d);
        } catch (err) {
          deviceFailed++;
          remaining.push(d);
          log.warn(`[${LOG_PREFIX}] Failed to set area for device ${d.deviceId}: ${(err as Error).message}`);
        }
      }
      drift = { ...drift, deviceAreas: remaining };
    }

    return {
      diff,
      drift,
      areaIds: areas.map((a) => a.area_id).sort(),
      applied,
      failed,
      appliedDevices,
      deviceFailed,
    };
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

  const repo = configRepo();

  const text = await gh.fetchRepoFileContent(repo, MANIFEST_PATH);
  if (text === null) {
    log.debug(`[${LOG_PREFIX}] ${repo} has no ${MANIFEST_PATH} — skipping`);
    return;
  }

  const asOf = new Date().toISOString();
  const parsed = parseAreaManifest(text);
  const { entities, floors, areas, errors } = parsed;
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
      result = await reconcileOnce(parsed);
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
  const { diff, drift, areaIds, applied, failed, appliedDevices, deviceFailed } = result;

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

  // Registry drift gets its own issue. ALERT_TITLE auto-closes on "manifest
  // matches Home Assistant" and is about manifest/entity problems; sharing one
  // issue would make each condition close the other's alert.
  //
  // upsertAlertIssue rather than ensureAlertIssue: buildDriftBody is a pure
  // function of current registry state, so an unchanged drift no-ops instead of
  // editing the issue every 30 minutes for as long as the drift persists.
  const drifted = drift ? driftCount(drift) : 0;
  try {
    if (drift === null) {
      // No drift data this tick — leave any existing issue exactly as it is.
    } else if (drifted > 0) {
      await upsertAlertIssue({
        repo,
        title: DRIFT_TITLE,
        body: buildDriftBody(drift),
        labels: [LABELS.priority],
        logPrefix: LOG_PREFIX,
        createdDetail: `${drifted} drift item(s)`,
      });
    } else {
      await closeAlertIssueIfResolved({
        repo,
        title: DRIFT_TITLE,
        logPrefix: LOG_PREFIX,
        reason: "floors, areas and device areas match the manifest",
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

  if (appliedDevices.length > 0) {
    const lines = appliedDevices.map(
      (d) => `• ${sanitise(d.deviceName)} (\`${sanitiseId(d.key)}\`): ${d.actual} → ${d.expected}`,
    );
    await notify(
      `:round_pushpin: Reconciled ${appliedDevices.length} Home Assistant device area(s) to match \`${MANIFEST_PATH}\`:\n${lines.join("\n")}`,
    );
  }

  log.info(
    `[${LOG_PREFIX}] ${entities.size} managed, ${applied.length} updated, ${diff.okCount} already correct` +
      (failed > 0 ? `, ${failed} failed` : "") +
      `, ${floors.size} floors / ${areas.size} areas / ${parsed.devices.size} device keys checked, ` +
      (drift === null ? "drift check skipped" : `${drifted} drift item(s)`) +
      `, ${appliedDevices.length} device area(s) updated` +
      (deviceFailed > 0 ? `, ${deviceFailed} device write(s) failed` : ""),
  );
}
