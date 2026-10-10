/**
 * Classifies dependency-update PRs: third-party updates (Renovate, Dependabot)
 * and own-app `automation/bump-*` image PRs. Used by the `/prs` Dependencies
 * filter, held-run approval and the Renovate approval exemption. Claws processes
 * these PRs at any hour; the update tools are scheduled to open them in the
 * evening instead (see `dependabot-config-scanner`).
 */

import { isDependabotPR, normalizeBotLogin, type PR } from "./github.js";

/**
 * A Renovate or Dependabot PR. Branch prefix counts as well as author because
 * fleet-infra's Renovate runs with a PAT, so its PRs are authored by a human
 * login on `renovate/*` branches.
 */
export function isThirdPartyUpdatePR(pr: PR): boolean {
  if (isDependabotPR(pr)) return true;
  if (normalizeBotLogin(pr.author.login) === "renovate[bot]") return true;
  return pr.headRefName.startsWith("renovate/") || pr.headRefName.startsWith("dependabot/");
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

/** A dependency-update PR for the `/prs` filter: third-party update or own-app auto-bump. */
export function isDependencyUpdatePR(pr: PR): boolean {
  return isThirdPartyUpdatePR(pr) || isAutoBumpPR(pr);
}

/** The `/prs` view selected by the `kind` query parameter. */
export type PRViewKind = "all" | "deps" | "other";

/** Parses a raw `kind` value; `undefined` for anything but the three exact strings. */
export function parsePRViewKind(raw: string | undefined): PRViewKind | undefined {
  return raw === "all" || raw === "deps" || raw === "other" ? raw : undefined;
}
