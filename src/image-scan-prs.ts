/**
 * Structural gates for the two generated PRs the weekly `image-cve-scan.yml`
 * opens in production-infra and fleet-infra: the advisory-snapshot refresh on
 * `automation/image-scan-advisories` and the unused-exception prune on
 * `automation/image-scan-exceptions-prune`. A passing verdict is what makes
 * either PR approval-exempt for the auto-merger (read through
 * `imageScanGateVerdict` in src/agents/auto-merger.ts); a failing one only
 * withdraws that exemption, so the PR then waits for an ordinary merge
 * approval (#clw_01M61EFZ6ZZM8FWGN2PAH3KNZB). See docs/jobs/auto-merger.md.
 */

import * as gh from "./github.js";
import * as log from "./log.js";

/** The only file a snapshot refresh may change. */
export const IMAGE_SCAN_SNAPSHOT_FILE = "security/image-scan/advisories.json";
/** The only file an exception prune may change. */
export const IMAGE_SCAN_EXCEPTIONS_FILE = "security/image-scan/exceptions.yaml";

/**
 * The prune PR body line recording the commit its source scan ran on — the
 * contract the prune workflow emits (#clw_01M61EGJAB6D6VZTYVCC4VVDKY).
 */
export const SCANNED_COMMIT_MARKER = /^image-scan-scanned-commit:\s*([0-9a-f]{40})\s*$/m;

/**
 * An `image:`/`newTag:` pin line, or an env-var `value:` line that may re-pin an image
 * reference — captures the prefix (indent + optional "- " + key) and value. Shared
 * with the auto-bump gate in src/agents/auto-merger.ts.
 */
export const PIN_LINE = /^(\s*(?:-\s+)?(?:image|newTag|value):\s*)(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/;

/** Top-level directories whose YAML holds the rendered manifests' image pins. */
const MANIFEST_DIRS = ["apps/", "infrastructure/", "clusters/", "data/", "migrations/"];

/** True for a `.yaml`/`.yml` file under one of the rendered-manifest directories. */
export function isManifestPinPath(path: string): boolean {
  return /\.ya?ml$/.test(path) && MANIFEST_DIRS.some((d) => path.startsWith(d));
}

/** More commits touching manifests than this between the scan and main's tip: hold as unverifiable. */
const MAX_MANIFEST_COMMITS = 50;
/** Paths named in a stale-scan hold. */
const MAX_STALE_PATHS = 5;

/** Which generated image-scan PR a verdict is for. */
export type ImageScanKind = "snapshot" | "prune";

/** Why a generated image-scan PR does not clear its gate. */
export type ImageScanFailure =
  | "no-files"
  | "extra-files"
  | "no-scanned-commit"
  | "merge-commit"
  | "extra-commits"
  | "scanned-commit-not-on-main"
  | "unverifiable"
  | "stale-scan";

export type ImageScanVerdict =
  | { ok: true; kind: ImageScanKind }
  | {
    ok: false;
    kind: ImageScanKind;
    reason: ImageScanFailure;
    /** `extra-files`: the changed files other than the allowed one. */
    files?: string[];
    /** `stale-scan`: up to five manifest paths whose image pins moved on main. */
    paths?: string[];
    /** `scanned-commit-not-on-main`: the recorded scanned commit. */
    scannedCommit?: string;
  };

/** True when the failure may be a transient read error: never cached, never reported on the PR. */
export function isTransientImageScanFailure(reason: ImageScanFailure): boolean {
  return reason === "no-files" || reason === "unverifiable";
}

function listFiles(files: readonly string[]): string {
  const shown = files.slice(0, MAX_STALE_PATHS).join(", ");
  return files.length > MAX_STALE_PATHS ? `${shown} (+${files.length - MAX_STALE_PATHS} more)` : shown;
}

/** The operator-facing reason a failing image-scan PR is held for a merge approval. */
export function imageScanHoldText(verdict: Extract<ImageScanVerdict, { ok: false }>): string {
  const { kind } = verdict;
  switch (verdict.reason) {
    case "no-files": return `${kind} PR has no readable changed files`;
    case "extra-files": return `${kind} PR changes files other than ${kind === "snapshot" ? IMAGE_SCAN_SNAPSHOT_FILE : IMAGE_SCAN_EXCEPTIONS_FILE}: ${listFiles(verdict.files ?? [])}`;
    case "no-scanned-commit": return "prune PR records no scanned commit";
    case "merge-commit": return "prune PR carries a conflict-resolution merge";
    case "extra-commits": return "prune PR has commits beyond the generator's";
    case "scanned-commit-not-on-main": return `prune PR's scanned commit ${(verdict.scannedCommit ?? "").slice(0, 7)} is not on main`;
    case "stale-scan": return `prune scan predates image-pin changes on main (${(verdict.paths ?? []).join(", ")})`;
    case "unverifiable": return "could not verify main's image pins since the scanned commit";
  }
}

/** The changed files other than `allowed`; empty when `allowed` is the only one. */
function extraFiles(files: readonly string[], allowed: string): string[] {
  return [...new Set(files)].filter((f) => f !== allowed);
}

/**
 * The snapshot gate: ok only when the PR's changed files are exactly
 * `security/image-scan/advisories.json`. `knownFiles`, when passed, is used
 * instead of a `getPRChangedFiles` read.
 */
export async function checkImageScanSnapshotDiff(
  repoFullName: string,
  prNumber: number,
  knownFiles?: readonly string[],
): Promise<ImageScanVerdict> {
  const files = knownFiles ?? (await gh.getPRChangedFiles(repoFullName, prNumber));
  if (files.length === 0) return { ok: false, kind: "snapshot", reason: "no-files" };
  const extra = extraFiles(files, IMAGE_SCAN_SNAPSHOT_FILE);
  if (extra.length > 0) return { ok: false, kind: "snapshot", reason: "extra-files", files: extra };
  return { ok: true, kind: "snapshot" };
}

/**
 * The manifest paths in a unified diff with a `+`/`-` line that is an image
 * pin (`PIN_LINE`) or carries an `@sha256:` digest.
 */
export function pinChangedPaths(diff: string): string[] {
  const paths = new Set<string>();
  let path = "";
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      path = /^diff --git a\/.* b\/(.*)$/.exec(line)?.[1] ?? "";
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("+++ b/")) path = line.slice(6);
      else if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    if (!isManifestPinPath(path)) continue;
    const content = line.slice(1);
    if (PIN_LINE.test(content) || content.includes("@sha256:")) paths.add(path);
  }
  return [...paths];
}

/**
 * The prune gate, in order: the changed files are exactly
 * `security/image-scan/exceptions.yaml`; the body records the scanned commit
 * (`SCANNED_COMMIT_MARKER`); the PR is one single-parent commit whose parent
 * is that scanned commit; and no image pin under the rendered manifests moved
 * between the scanned commit and the base branch's tip (`baseSha`). Any read
 * failure, a truncated compare or more than 50 manifest-touching commits is
 * `unverifiable`; a 404 compare is `scanned-commit-not-on-main`. `body` and
 * `baseSha` are read live when not passed.
 */
export async function checkImageScanPruneDiff(
  repoFullName: string,
  prNumber: number,
  opts: { knownFiles?: readonly string[]; body?: string; baseSha?: string } = {},
): Promise<ImageScanVerdict> {
  const fail = (reason: ImageScanFailure, extra: Partial<Extract<ImageScanVerdict, { ok: false }>> = {}): ImageScanVerdict =>
    ({ ok: false, kind: "prune", reason, ...extra });
  const files = opts.knownFiles ?? (await gh.getPRChangedFiles(repoFullName, prNumber));
  if (files.length === 0) return fail("no-files");
  const extra = extraFiles(files, IMAGE_SCAN_EXCEPTIONS_FILE);
  if (extra.length > 0) return fail("extra-files", { files: extra });

  const ref = `${repoFullName}#${prNumber}`;
  try {
    const body = opts.body ?? (await gh.getPRBody(repoFullName, prNumber));
    const scanned = SCANNED_COMMIT_MARKER.exec(body ?? "")?.[1];
    if (!scanned) return fail("no-scanned-commit");

    const commits = await gh.listPRCommits(repoFullName, prNumber);
    if (commits.some((c) => c.parents.length > 1)) return fail("merge-commit");
    if (commits.length !== 1 || commits[0]!.parents[0] !== scanned) return fail("extra-commits");

    const baseSha = opts.baseSha || (await gh.getPRMergeGate(repoFullName, prNumber)).baseSha;
    if (!baseSha) return fail("unverifiable");
    if (baseSha === scanned) return { ok: true, kind: "prune" };
    const range = await gh.listCompareChangedFiles(repoFullName, scanned, baseSha);
    if (range === null) return fail("scanned-commit-not-on-main", { scannedCommit: scanned });
    if (range.commits.length < range.totalCommits) {
      log.info(`[auto-merger] ${ref}: compare ${scanned.slice(0, 7)}...${baseSha.slice(0, 7)} listed ${range.commits.length} of ${range.totalCommits} commits; holding the prune as unverifiable`);
      return fail("unverifiable");
    }
    const manifestCommits = range.commits.filter((c) => c.files.some(isManifestPinPath));
    if (manifestCommits.length > MAX_MANIFEST_COMMITS) return fail("unverifiable");
    const stale = new Set<string>();
    for (const commit of manifestCommits) {
      for (const path of pinChangedPaths(await gh.getCommitDiff(repoFullName, commit.sha))) stale.add(path);
    }
    if (stale.size > 0) return fail("stale-scan", { paths: [...stale].slice(0, MAX_STALE_PATHS) });
    return { ok: true, kind: "prune" };
  } catch (err) {
    log.warn(`[auto-merger] Could not verify image-scan prune ${ref}: ${err}`);
    return fail("unverifiable");
  }
}
