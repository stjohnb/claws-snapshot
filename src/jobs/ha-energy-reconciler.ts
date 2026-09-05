import { parse } from "yaml";
import {
  HOME_ASSISTANT_CONFIG_REPO,
  HOME_ASSISTANT_ENERGY_RECONCILER_ENABLED,
  LABELS,
} from "../config.js";
import * as gh from "../github.js";
import * as ha from "../home-assistant.js";
import type { HaEnergyPrefs } from "../home-assistant.js";
import * as log from "../log.js";
import { closeAlertIssueIfResolved, upsertAlertIssue } from "../occurrence-tracking.js";
import { notify } from "../slack.js";

const LOG_PREFIX = "ha-energy-reconciler";
const MANIFEST_PATH = "registry/energy.yaml";
const GUARD_TITLE = "[ha-energy-reconciler] registry/energy.yaml would wipe the Energy dashboard";
const PREF_KEYS = ["energy_sources", "device_consumption", "device_consumption_water"] as const;

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function configRepo(): string {
  return HOME_ASSISTANT_CONFIG_REPO ?? "St-John-Software/home-assistant-config";
}

export interface ParsedEnergyManifest {
  prefs: Record<string, Record<string, unknown>[]> | null;
  errors: string[];
}

// Parses registry/energy.yaml. Its shape mirrors HA's energy/get_prefs result
// 1:1, so unlike parseAreaManifest this only validates the three top-level
// keys HA's energy/save_prefs schema accepts — an unknown key must never
// reach the wire, since HA rejects the whole save command for it.
export function parseEnergyManifest(text: string): ParsedEnergyManifest {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    return { prefs: null, errors: [`YAML parse error: ${(err as Error).message}`] };
  }

  if (!isMapping(doc)) {
    return {
      prefs: null,
      errors: [`Manifest must be a mapping with energy_sources/device_consumption/device_consumption_water keys`],
    };
  }

  const errors: string[] = [];
  for (const key of Object.keys(doc)) {
    if (!(PREF_KEYS as readonly string[]).includes(key)) {
      errors.push(`unknown top-level key \`${key}\``);
    }
  }

  const prefs: Record<string, Record<string, unknown>[]> = {};
  for (const key of PREF_KEYS) {
    const raw = doc[key];
    if (raw === undefined) continue; // not declared — leave absent, not materialised as []
    if (raw === null) {
      prefs[key] = [];
      continue;
    }
    if (!Array.isArray(raw)) {
      errors.push(`\`${key}\` must be an array`);
      continue;
    }
    const entries: Record<string, unknown>[] = [];
    let bad = false;
    raw.forEach((el, i) => {
      if (!isMapping(el)) {
        errors.push(`\`${key}[${i}]\` must be a mapping`);
        bad = true;
        return;
      }
      entries.push(el);
    });
    if (!bad) prefs[key] = entries;
  }

  if (errors.length > 0) return { prefs: null, errors };
  return { prefs, errors: [] };
}

// Recursive canonicalisation for order-sensitive, null-insensitive comparison:
// arrays keep their order (the dashboard renders in list order, so a reorder
// is a real change), objects drop null/undefined keys and sort the rest so a
// file that spells out `stat_cost: null` compares equal to live prefs that
// omit it.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => canonical(v));
  if (isMapping(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === null || v === undefined) continue;
      result[key] = canonical(v);
    }
    return result;
  }
  return value;
}

export function prefsEqual(live: HaEnergyPrefs, want: Record<string, unknown[]>): boolean {
  for (const key of PREF_KEYS) {
    const liveVal = JSON.stringify(canonical(live[key] ?? []));
    const wantVal = JSON.stringify(canonical(want[key] ?? []));
    if (liveVal !== wantVal) return false;
  }
  return true;
}

// Every interpolated name/entity id goes through this before landing in a log
// line or Slack message — live prefs are user-editable in the HA UI.
function sanitise(v: unknown): string {
  return String(v).replace(/[`|\r\n]/g, " ").slice(0, 60);
}

interface GroupDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

function diffGroup(
  live: Record<string, unknown>[],
  want: Record<string, unknown>[],
  keyFn: (e: Record<string, unknown>) => string,
  labelFn: (e: Record<string, unknown>) => string,
): GroupDiff {
  const liveByKey = new Map(live.map((e) => [keyFn(e), e]));
  const wantByKey = new Map(want.map((e) => [keyFn(e), e]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [key, entry] of wantByKey) {
    if (!liveByKey.has(key)) added.push(sanitise(labelFn(entry)));
  }
  for (const [key, entry] of liveByKey) {
    if (!wantByKey.has(key)) removed.push(sanitise(labelFn(entry)));
  }
  for (const [key, wantEntry] of wantByKey) {
    const liveEntry = liveByKey.get(key);
    if (liveEntry && JSON.stringify(canonical(liveEntry)) !== JSON.stringify(canonical(wantEntry))) {
      changed.push(sanitise(labelFn(wantEntry)));
    }
  }

  return { added, removed, changed };
}

const sourceKey = (e: Record<string, unknown>): string => String(e["stat_energy_from"] ?? e["type"] ?? "");

const deviceKey = (e: Record<string, unknown>): string => String(e["stat_consumption"] ?? "");
const deviceLabel = (e: Record<string, unknown>): string => {
  const name = e["name"];
  return typeof name === "string" && name.length > 0 ? name : String(e["stat_consumption"] ?? "");
};

function asEntries(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

// One line, safe for a log line and a Slack message. Renders as
// `sources +a.b, -c.d, ~e.f; devices +Washing machine, ~Tumble Dryer`,
// omitting empty groups.
export function summariseDiff(live: HaEnergyPrefs, want: Record<string, unknown[]>): string {
  const sourcesDiff = diffGroup(asEntries(live["energy_sources"]), asEntries(want["energy_sources"]), sourceKey, sourceKey);
  const liveDevices = [...asEntries(live["device_consumption"]), ...asEntries(live["device_consumption_water"])];
  const wantDevices = [...asEntries(want["device_consumption"]), ...asEntries(want["device_consumption_water"])];
  const devicesDiff = diffGroup(liveDevices, wantDevices, deviceKey, deviceLabel);

  const groups: string[] = [];
  const render = (label: string, d: GroupDiff): void => {
    const parts = [
      ...d.added.map((a) => `+${a}`),
      ...d.removed.map((r) => `-${r}`),
      ...d.changed.map((c) => `~${c}`),
    ];
    if (parts.length > 0) groups.push(`${label} ${parts.join(", ")}`);
  };
  render("sources", sourcesDiff);
  render("devices", devicesDiff);

  return groups.length > 0 ? groups.join("; ") : "entries reordered";
}

// The empty-sources guard alert. Only entity-id-shaped live source ids are
// listed — that filter is the injection guard, since free-text names never
// reach this body, unlike buildDriftBody's guardContent() path.
export function buildGuardBody(liveSourceIds: string[]): string {
  const n = liveSourceIds.length;
  const lines: string[] = [
    `Automated Home Assistant Energy reconciler. \`${MANIFEST_PATH}\`'s \`energy_sources\` is empty while Home Assistant has ${n} configured source(s). Saving it would wipe the Energy dashboard's grid configuration and cost-history view, so Claws refused and made no change. Fix this by restoring the sources in \`${MANIFEST_PATH}\`. This issue auto-closes once the file has sources.`,
    "",
  ];
  for (const id of liveSourceIds) {
    lines.push(`- ${ha.ENTITY_ID_RE.test(id) ? `\`${id}\`` : "(non-entity source)"}`);
  }
  return lines.join("\n");
}

export async function run(): Promise<void> {
  if (!HOME_ASSISTANT_ENERGY_RECONCILER_ENABLED) {
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

  const { prefs, errors } = parseEnergyManifest(text);
  if (prefs === null) {
    // The config repo's own CI (tools/validate_energy.py) blocks a malformed
    // file from reaching main, so this can only be a transient bad state —
    // no alert issue, just a warn and skip.
    log.warn(`[${LOG_PREFIX}] ${MANIFEST_PATH}: ${errors.join("; ")} — skipping`);
    return;
  }

  let live: HaEnergyPrefs;
  try {
    live = await ha.withHaWebSocket(async (s) => ha.getEnergyPrefs(s));
  } catch (err) {
    // HA outage/restart, not a manifest fault. ha-upgrader/ha-deploy-watcher
    // already surface HA being unreachable.
    log.warn(`[${LOG_PREFIX}] Could not reach Home Assistant: ${(err as Error).message}`);
    return;
  }

  const liveSources = asEntries(live["energy_sources"]);
  const wantSources = prefs["energy_sources"] ?? [];

  if (wantSources.length === 0 && liveSources.length > 0) {
    log.warn(
      `[${LOG_PREFIX}] ${MANIFEST_PATH} has an empty energy_sources while Home Assistant has ${liveSources.length} — refusing to save`,
    );
    try {
      await upsertAlertIssue({
        repo,
        title: GUARD_TITLE,
        body: buildGuardBody(liveSources.map(sourceKey)),
        labels: [LABELS.priority],
        logPrefix: LOG_PREFIX,
        createdDetail: `${liveSources.length} live source(s)`,
      });
    } catch (err) {
      log.warn(`[${LOG_PREFIX}] GitHub operation failed: ${(err as Error).message}`);
    }
    return;
  }

  try {
    await closeAlertIssueIfResolved({
      repo,
      title: GUARD_TITLE,
      logPrefix: LOG_PREFIX,
      reason: "the manifest declares energy sources",
    });
  } catch (err) {
    log.warn(`[${LOG_PREFIX}] GitHub operation failed: ${(err as Error).message}`);
  }

  if (prefsEqual(live, prefs)) {
    log.debug(`[${LOG_PREFIX}] Energy prefs match ${MANIFEST_PATH} — nothing to do`);
    return;
  }

  const summary = summariseDiff(live, prefs);
  try {
    await ha.withHaWebSocket(async (s) => ha.saveEnergyPrefs(s, prefs));
  } catch (err) {
    log.warn(`[${LOG_PREFIX}] Failed to save Energy prefs: ${(err as Error).message}`);
    return;
  }

  log.info(`[${LOG_PREFIX}] Applied ${MANIFEST_PATH}: ${summary}`);
  await notify(`:zap: Reconciled the Home Assistant Energy dashboard to match \`${MANIFEST_PATH}\`: ${summary}`);
}
