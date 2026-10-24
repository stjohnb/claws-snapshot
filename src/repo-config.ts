/**
 * Per-repo `claws.json` — the file a repo commits to opt into Claws (#2885).
 *
 * The file is MANDATORY: a repo whose default branch has no `claws.json` is
 * not discovered at all, on either forge. That is what makes onboarding a
 * repo a repo-side action ("commit the file") rather than an edit to
 * `~/.claws/config.json` on the automation host.
 *
 * Failure handling is deliberately asymmetric. Only a definitive 404 — the
 * fetch succeeded and the file is not there — unmonitors a repo. A transport
 * error or a malformed file fails *open*, because one flaky API call must
 * never take the whole fleet dark for a tick.
 *
 * This module must not import `./config.js` or `./github.js`: config.ts
 * imports *this* module for `getLockedJobsForRepo`, so either would close a
 * cycle. The file fetcher is injected by the caller for the same reason.
 */

import { z } from "zod";
import * as log from "./log.js";
import { mapWithConcurrency } from "./util.js";

/** Path of the per-repo config file, at the repo root on the default branch. */
export const REPO_CONFIG_PATH = "claws.json";

/** Unknown keys are tolerated so a repo can adopt a key a newer Claws understands. */
const RepoConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    disabledJobs: z.array(z.string()).optional(),
    runners: z.array(z.string()).optional(),
    prodAlertWorkflows: z.array(z.string()).optional(),
    mainBuildIgnoreWorkflows: z.array(z.string()).optional(),
    dependabotIgnoredAdvisories: z.array(z.string()).optional(),
    incidentLabels: z.array(z.string()).optional(),
    notes: z.string().optional(),
    description: z.string().optional(),
    autoPromote: z.object({ bugsAndAlerts: z.boolean().optional() }).optional(),
    issuePreviewSummaryUrl: z.string().optional(),
    avatar: z.string().optional(),
    // Entries are validated one by one in parseDeploys, so one bad entry drops alone.
    deploys: z.array(z.unknown()).optional(),
    // Validated in parseAlertBridge, so a bad entry drops alone rather than the file.
    alertBridge: z.unknown().optional(),
    // Validated in parseIssueFiler, so a bad entry drops alone rather than the file.
    issueFiler: z.unknown().optional(),
    mergeWithoutChecks: z.boolean().optional(),
    // Validated in parseMaxPushFileBytes, so a bad value falls back to the default alone.
    maxPushFileBytes: z.unknown().optional(),
  })
  .passthrough();

export interface RepoConfig {
  enabled: boolean;
  disabledJobs: readonly string[];
  /** Runner labels this repo's CI needs, e.g. `["macos"]` (#2898). */
  runners: readonly string[];
  /** Workflows whose main-branch failure pages the prod-alerts channel. */
  prodAlertWorkflows: readonly string[];
  /** Workflows the central main-build monitor must ignore. */
  mainBuildIgnoreWorkflows: readonly string[];
  /** GHSA advisory IDs the dependabot monitor must suppress for this repo. */
  dependabotIgnoredAdvisories: readonly string[];
  /** Labels marking an issue as a live incident; such issues jump the work queue. */
  incidentLabels: readonly string[];
  /** One-line "what this repo is", used e.g. by the WhatsApp voice-note router. */
  description: string | null;
  /**
   * `bugsAndAlerts` governs whether a `kind: bug` or an alert issue's
   * requirements promote it to Planning without a human, whatever its source —
   * unset behaves as `true`; `false` makes it follow the source default like
   * any other issue. A per-issue choice overrides it. There is no per-source
   * setting: a session-filed issue's approval and an agent issue's wait are fixed.
   */
  autoPromote: { bugsAndAlerts?: boolean };
  /**
   * Template for a PR-less preview's summary JSON, containing `{issue}` and
   * `{sha8}` placeholders (e.g. 3d-models' `.../issue-preview/{issue}/{sha8}/preview-summary.json`).
   * Enables `issue-preview-sync`'s branch-only preview path.
   */
  issuePreviewSummaryUrl: string | null;
  /**
   * Cross-repo relationships this repo declares: it deploys, configures or
   * provisions `repo`, at `path` in this repo. The highest-authority evidence
   * for the doc-maintainer's generated Related repositories section.
   */
  deploys: readonly RepoDeployEntry[];
  /**
   * Repo-relative path of an image on the default branch that the dashboard
   * shows next to the repo, e.g. `docs/avatar.png`. Null when unset or invalid.
   */
  avatar: string | null;
  /**
   * The repo's consolidated alert issue, written by its alert bridge through
   * `/api/alert-bridge/<repo>/…` (`alert-bridge.ts`). Null when unset or invalid.
   */
  alertBridge: RepoAlertBridge | null;
  /**
   * The external service allowed to file issues into this repo through
   * `/api/issue-filer/<repo>/…` (`issue-filer.ts`). Null when unset or invalid.
   */
  issueFiler: RepoIssueFiler | null;
  /**
   * Let the auto-merger merge an approved PR whose head has no CI result at
   * all. Only for a repo whose workflows never report on PR heads (deploy- or
   * release-only CI); otherwise a missing result holds the merge.
   */
  mergeWithoutChecks: boolean;
  /**
   * Largest file, in bytes, an agent run may push when the file is new to the
   * branch and the default branch (`push-guard.ts`). Null means the 5 MiB default.
   */
  maxPushFileBytes: number | null;
}

/** A repo's alert bridge: the one issue it keeps, and the SHA-256 of its bearer token. */
export interface RepoAlertBridge {
  label: string;
  title: string;
  /** Hex SHA-256 of the bridge's token; the token itself lives only in the bridge repo's SOPS file. */
  tokenSha256: string;
}

const RepoAlertBridgeSchema = z.object({
  label: z.string().trim().min(1),
  title: z.string().trim().min(1),
  tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** A repo's issue filer: the SHA-256 of its bearer token and the prefix every dedupe key it files must carry. */
export interface RepoIssueFiler {
  /** Hex SHA-256 of the filer's token; the token itself lives only in the filing service's secret. */
  tokenSha256: string;
  /** e.g. `site-review-`. Never `alert-…`, which the alert bridge owns. */
  dedupeKeyPrefix: string;
}

const RepoIssueFilerSchema = z.object({
  tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
  dedupeKeyPrefix: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,49}$/).refine((prefix) => !prefix.startsWith("alert-")),
});

export type RepoRelation = "deploys" | "configures" | "provisions";

export interface RepoDeployEntry {
  repo: string;
  path: string;
  relation?: RepoRelation;
}

const RepoDeployEntrySchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  path: z.string().min(1),
  relation: z.enum(["deploys", "configures", "provisions"]).optional(),
});

type RepoConfigState = "present" | "absent" | "unknown";

interface CacheEntry {
  state: "present" | "absent";
  /** The repo's full name in its original casing (the map key is lowercased). */
  fullName: string;
  config: RepoConfig | null;
  fetchedAt: number;
}

/** A present file barely moves; an absent one is re-read every discovery. */
const REPO_CONFIG_TTL = 30 * 60 * 1000;

/** Keyed by lowercased full name. No entry at all means "unknown". */
const cache = new Map<string, CacheEntry>();

/** Fallback used when a file exists but cannot be parsed — never unmonitor. */
const DEFAULT_CONFIG: RepoConfig = {
  enabled: true,
  disabledJobs: [],
  runners: [],
  prodAlertWorkflows: [],
  mainBuildIgnoreWorkflows: [],
  dependabotIgnoredAdvisories: [],
  incidentLabels: [],
  description: null,
  autoPromote: {},
  issuePreviewSummaryUrl: null,
  deploys: [],
  avatar: null,
  alertBridge: null,
  issueFiler: null,
  mergeWithoutChecks: false,
  maxPushFileBytes: null,
};

/** `description` is a one-line prompt hint, not a README — keep it short. */
const DESCRIPTION_MAX_LENGTH = 200;

function parseDescription(description: string | undefined): string | null {
  if (!description) return null;
  const firstLine = description.split("\n", 1)[0].trim();
  return firstLine.slice(0, DESCRIPTION_MAX_LENGTH) || null;
}

/** Rejects anything that isn't an `https://` template naming both placeholders, rather than failing later on a malformed fetch URL. */
function parseIssuePreviewSummaryUrl(fullName: string, url: string | undefined): string | null {
  if (!url) return null;
  if (!url.startsWith("https://") || !url.includes("{issue}") || !url.includes("{sha8}")) {
    log.warn(`repo-config: ${fullName}'s issuePreviewSummaryUrl must start with https:// and contain {issue} and {sha8}; ignoring`);
    return null;
  }
  return url;
}

const AVATAR_EXTENSION_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

/** Accepts only a repo-relative image path — no leading `/`, no `..` segment, no URL — so the dashboard can serve it from the repo itself. */
function parseAvatar(fullName: string, value: string | undefined): string | null {
  if (!value) return null;
  const valid =
    !value.startsWith("/") &&
    !value.includes("://") &&
    !value.split(/[/\\]/).includes("..") &&
    AVATAR_EXTENSION_RE.test(value);
  if (!valid) {
    log.warn(`repo-config: ${fullName}'s avatar must be a repo-relative image path (.png, .jpg, .jpeg, .gif, .webp or .svg); ignoring`);
    return null;
  }
  return value;
}

/** Accepts only a positive safe integer, so a typo can't switch the push guard's size check off. */
function parseMaxPushFileBytes(fullName: string, value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    log.warn(`repo-config: ${fullName}'s maxPushFileBytes must be a positive integer; ignoring`);
    return null;
  }
  return value;
}

/** Keeps each well-formed `deploys` entry and drops a malformed one with a warning, rather than failing the file. */
function parseDeploys(fullName: string, entries: readonly unknown[] | undefined): RepoDeployEntry[] {
  const out: RepoDeployEntry[] = [];
  for (const entry of entries ?? []) {
    const parsed = RepoDeployEntrySchema.safeParse(entry);
    if (parsed.success) {
      out.push(parsed.data);
    } else {
      log.warn(`repo-config: ${fullName} has a malformed deploys entry ${JSON.stringify(entry)}; ignoring it`);
    }
  }
  return out;
}

/** Accepts only a complete entry whose `tokenSha256` is 64 lowercase hex characters; drops anything else with a warning. */
function parseAlertBridge(fullName: string, value: unknown): RepoAlertBridge | null {
  if (value === undefined) return null;
  const parsed = RepoAlertBridgeSchema.safeParse(value);
  if (!parsed.success) {
    log.warn(`repo-config: ${fullName}'s alertBridge needs a label, a title and a 64-character lowercase hex tokenSha256; ignoring it`);
    return null;
  }
  return parsed.data;
}

/** Accepts only a 64-character lowercase hex `tokenSha256` with a well-formed prefix not starting `alert-`; drops anything else with a warning. */
function parseIssueFiler(fullName: string, value: unknown): RepoIssueFiler | null {
  if (value === undefined) return null;
  const parsed = RepoIssueFilerSchema.safeParse(value);
  if (!parsed.success) {
    log.warn(`repo-config: ${fullName}'s issueFiler needs a 64-character lowercase hex tokenSha256 and a dedupeKeyPrefix of 2-50 characters of a-z, 0-9, '.', '_' or '-' that does not start alert-; ignoring it`);
    return null;
  }
  return parsed.data;
}

/**
 * Re-read `claws.json` for each repo. `fetchFile` must resolve to `null` for a
 * definitive 404/403 and throw for anything else (that is exactly
 * `github.fetchRepoFileContent`'s contract, on both forges).
 */
export async function refreshRepoConfigs(
  repos: readonly { fullName: string }[],
  fetchFile: (fullName: string, path: string) => Promise<string | null>,
): Promise<void> {
  await mapWithConcurrency([...repos], 4, (repo) => refreshOne(repo, fetchFile, false));
}

/** Minimum gap between two forced re-reads of the same repo's file. */
export const FORCED_REFRESH_MIN_INTERVAL_MS = 60_000;

/** When each repo (lowercased) was last force-refreshed. */
const lastForcedAt = new Map<string, number>();
/** Forced re-reads currently running, so concurrent callers share one fetch. */
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Re-read one already-known repo's `claws.json` now, ignoring the TTL — for a
 * caller that has evidence the cached copy is stale (a bridge token that no
 * longer matches). Rate-limited to once per minute per repo and single-flight.
 * Returns whether a fetch was made or joined; false for a repo not cached as
 * present or one re-read too recently. A failed fetch keeps the old entry.
 */
export async function forceRefreshRepoConfig(
  fullName: string,
  fetchFile: (fullName: string, path: string) => Promise<string | null>,
): Promise<boolean> {
  const key = fullName.toLowerCase();
  const pending = inFlight.get(key);
  if (pending) return pending;
  const existing = cache.get(key);
  if (existing?.state !== "present") return false;
  const last = lastForcedAt.get(key);
  if (last !== undefined && Date.now() - last < FORCED_REFRESH_MIN_INTERVAL_MS) return false;
  lastForcedAt.set(key, Date.now());
  const run = refreshOne({ fullName: existing.fullName }, fetchFile, true)
    .then(() => true)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function refreshOne(
  repo: { fullName: string },
  fetchFile: (fullName: string, path: string) => Promise<string | null>,
  force: boolean,
): Promise<void> {
  {
    const key = repo.fullName.toLowerCase();
    const existing = cache.get(key);
    // A cached "absent" repo is currently unmonitored and the operator is
    // probably mid-fix, so it is always re-fetched rather than held for 30
    // minutes. Only a present file gets the TTL.
    if (!force && existing?.state === "present" && Date.now() - existing.fetchedAt < REPO_CONFIG_TTL) return;

    let raw: string | null;
    try {
      raw = await fetchFile(repo.fullName, REPO_CONFIG_PATH);
    } catch (err) {
      // Transport failure: leave whatever decision already stands untouched
      // (including its fetchedAt), and leave an unseen repo *unknown* so
      // isRepoMonitored fails open.
      log.warn(`repo-config: could not read ${REPO_CONFIG_PATH} for ${repo.fullName} — ${err}`);
      return;
    }

    if (raw === null) {
      cache.set(key, { state: "absent", config: null, fetchedAt: Date.now(), fullName: repo.fullName });
      return;
    }

    let config: RepoConfig;
    try {
      const parsed = RepoConfigSchema.parse(JSON.parse(raw));
      config = {
        enabled: parsed.enabled !== false,
        disabledJobs: parsed.disabledJobs ?? [],
        runners: parsed.runners ?? [],
        prodAlertWorkflows: parsed.prodAlertWorkflows ?? [],
        mainBuildIgnoreWorkflows: parsed.mainBuildIgnoreWorkflows ?? [],
        dependabotIgnoredAdvisories: parsed.dependabotIgnoredAdvisories ?? [],
        incidentLabels: parsed.incidentLabels ?? [],
        description: parseDescription(parsed.description),
        autoPromote: parsed.autoPromote ?? {},
        issuePreviewSummaryUrl: parseIssuePreviewSummaryUrl(repo.fullName, parsed.issuePreviewSummaryUrl),
        deploys: parseDeploys(repo.fullName, parsed.deploys),
        avatar: parseAvatar(repo.fullName, parsed.avatar),
        alertBridge: parseAlertBridge(repo.fullName, parsed.alertBridge),
        issueFiler: parseIssueFiler(repo.fullName, parsed.issueFiler),
        mergeWithoutChecks: parsed.mergeWithoutChecks === true,
        maxPushFileBytes: parseMaxPushFileBytes(repo.fullName, parsed.maxPushFileBytes),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`repo-config: ${repo.fullName} has an unreadable ${REPO_CONFIG_PATH} — ${message}; treating it as defaults`);
      config = DEFAULT_CONFIG;
    }
    cache.set(key, { state: "present", config, fetchedAt: Date.now(), fullName: repo.fullName });
  }
}

/** The repo's parsed `claws.json`, or null when it is absent or not yet read. */
export function getRepoConfig(fullName: string): RepoConfig | null {
  return cache.get(fullName.toLowerCase())?.config ?? null;
}

/**
 * The mandatory gate. A definitive absence unmonitors the repo; an explicit
 * `"enabled": false` pauses it; anything unknown fails open.
 */
export function isRepoMonitored(fullName: string): boolean {
  const entry = cache.get(fullName.toLowerCase());
  if (!entry) return true; // unknown — never unmonitor on a transport error
  if (entry.state === "absent") return false;
  return entry.config?.enabled !== false;
}

/**
 * Every repo whose `claws.json` was successfully read, with its original
 * casing. Used by `config.ts` to union repo-declared settings across the fleet
 * (#2898); before the first discovery pass this is empty, so callers must not
 * read it at module top level.
 */
export function listRepoConfigs(): Array<{ fullName: string; config: RepoConfig }> {
  return [...cache.values()]
    .filter((e): e is CacheEntry & { config: RepoConfig } => e.state === "present" && e.config !== null)
    .map((e) => ({ fullName: e.fullName, config: e.config }));
}

/** Whether the file was seen, definitively missing, or never successfully read. */
export function getRepoConfigState(fullName: string): RepoConfigState {
  return cache.get(fullName.toLowerCase())?.state ?? "unknown";
}

/** Exposed for tests. */
export function clearRepoConfigCache(): void {
  cache.clear();
  lastForcedAt.clear();
  inFlight.clear();
}
