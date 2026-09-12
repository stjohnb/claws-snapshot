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
    notes: z.string().optional(),
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
}

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
};

/**
 * Re-read `claws.json` for each repo. `fetchFile` must resolve to `null` for a
 * definitive 404/403 and throw for anything else (that is exactly
 * `github.fetchRepoFileContent`'s contract, on both forges).
 */
export async function refreshRepoConfigs(
  repos: readonly { fullName: string }[],
  fetchFile: (fullName: string, path: string) => Promise<string | null>,
): Promise<void> {
  await mapWithConcurrency([...repos], 4, async (repo) => {
    const key = repo.fullName.toLowerCase();
    const existing = cache.get(key);
    // A cached "absent" repo is currently unmonitored and the operator is
    // probably mid-fix, so it is always re-fetched rather than held for 30
    // minutes. Only a present file gets the TTL.
    if (existing?.state === "present" && Date.now() - existing.fetchedAt < REPO_CONFIG_TTL) return;

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
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`repo-config: ${repo.fullName} has an unreadable ${REPO_CONFIG_PATH} — ${message}; treating it as defaults`);
      config = DEFAULT_CONFIG;
    }
    cache.set(key, { state: "present", config, fetchedAt: Date.now(), fullName: repo.fullName });
  });
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
}
