/**
 * Classifies dependency-update PRs: third-party updates (Renovate) and own-app
 * `automation/bump-*` image PRs. Used by the `/prs` Dependencies filter and the
 * Renovate approval exemption. Claws processes
 * these PRs at any hour; the update tools are scheduled to open them in the
 * evening instead (Renovate's schedule, set in the central Forgejo Renovate
 * config).
 */

import { normalizeBotLogin, type PR } from "./github.js";

/**
 * A Renovate PR. Branch prefix counts as well as author because fleet-infra's
 * Renovate runs with a PAT, so its PRs are authored by a human login on
 * `renovate/*` branches.
 */
export function isThirdPartyUpdatePR(pr: PR): boolean {
  if (normalizeBotLogin(pr.author.login) === "renovate[bot]") return true;
  return pr.headRefName.startsWith("renovate/");
}

/** Image-bump PRs from prod-infra's bump-app-version.yml for our own ghcr.io apps. */
export function isAutoBumpPR(pr: PR): boolean {
  const labels = pr.labels.map((l) => l.name);
  return (
    pr.headRefName.startsWith("automation/bump-") &&
    labels.includes("auto-bump") &&
    !labels.includes("major-update")
  );
}

/** The weekly image-cve-scan workflow's advisory-snapshot refresh branch (production-infra). */
export const IMAGE_SCAN_SNAPSHOT_BRANCH = "automation/image-scan-advisories";
/** The weekly image-cve-scan workflow's unused-exception prune branch (production-infra, fleet-infra). */
export const IMAGE_SCAN_PRUNE_BRANCH = "automation/image-scan-exceptions-prune";

/** An image-scan advisory-snapshot refresh PR, by exact branch name (labels play no part). */
export function isImageScanSnapshotPR(pr: Pick<PR, "headRefName">): boolean {
  return pr.headRefName === IMAGE_SCAN_SNAPSHOT_BRANCH;
}

/** An image-scan exception-prune PR, by exact branch name (labels play no part). */
export function isImageScanPrunePR(pr: Pick<PR, "headRefName">): boolean {
  return pr.headRefName === IMAGE_SCAN_PRUNE_BRANCH;
}

/** Either generated image-scan PR: a snapshot refresh or an exception prune. */
export function isImageScanPR(pr: Pick<PR, "headRefName">): boolean {
  return isImageScanSnapshotPR(pr) || isImageScanPrunePR(pr);
}

/** A dependency-update PR for the `/prs` filter: third-party update or own-app auto-bump. */
export function isDependencyUpdatePR(pr: PR): boolean {
  return isThirdPartyUpdatePR(pr) || isAutoBumpPR(pr);
}

/** The `/prs` view selected by the `kind` query parameter. */
export type PRViewKind = "all" | "deps" | "other" | "blocked";

/** Parses a raw `kind` value; `undefined` for anything but the four exact strings. */
export function parsePRViewKind(raw: string | undefined): PRViewKind | undefined {
  return raw === "all" || raw === "deps" || raw === "other" || raw === "blocked" ? raw : undefined;
}
