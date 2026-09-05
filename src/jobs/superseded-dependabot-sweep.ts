import { LABELS, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import * as db from "../db.js";
import { AGENT_KINDS } from "../worker.js";

/** Dedup marker embedded in the close comment so a re-run never double-comments. */
export const SUPERSEDED_MARKER = "superseded-dependabot-pr-closed";

export interface Bump {
  pkg: string;
  from: string;
  to: string;
}

/** Package names we are willing to echo into a Claws-authored comment. */
const SAFE_PKG_RE = /^@?[a-z0-9._-]+(\/[a-z0-9._-]+)?$/i;
/** Version strings we are willing to echo into a Claws-authored comment. */
const SAFE_VERSION_RE = /^[0-9][A-Za-z0-9.+-]*$/;

// Markdown table row: `| [pkg](url) | `from` | `to` |` or `| pkg | from | to |`.
const TABLE_ROW_RE =
  /^\|\s*(?:\[([^\]]+)\]\([^)]*\)|`?([^|`\s]+)`?)\s*\|\s*`?([0-9][^|`\s]*)`?\s*\|\s*`?([0-9][^|`\s]*)`?\s*\|/gm;

// Single-package fallback: "Bump astro from 7.1.3 to 7.1.6".
const SINGLE_BUMP_RE =
  /bumps?\s+\[?`?([@\w./-]+)`?\]?(?:\([^)]*\))?\s+from\s+`?v?([0-9][\w.+-]*)`?\s+to\s+`?v?([0-9][\w.+-]*)`?/i;

/**
 * Extracts the packages a dependabot PR bumps, from its body's markdown table
 * (group PRs) or, failing that, from the single-package "Bump X from A to B"
 * phrasing in the title/body. Rows whose package name or versions contain
 * anything outside a conservative charset are dropped — a dropped row makes the
 * PR unverifiable downstream, which is the safe direction.
 */
export function parseDependabotBumps(title: string, body: string): Bump[] {
  const out: Bump[] = [];
  const seen = new Set<string>();
  const push = (pkg: string, from: string, to: string): void => {
    if (!SAFE_PKG_RE.test(pkg)) return;
    if (!SAFE_VERSION_RE.test(from) || !SAFE_VERSION_RE.test(to)) return;
    if (seen.has(pkg)) return;
    seen.add(pkg);
    out.push({ pkg, from, to });
  };

  for (const m of body.matchAll(TABLE_ROW_RE)) {
    push(m[1] ?? m[2] ?? "", m[3], m[4]);
  }
  if (out.length > 0) return out;

  for (const text of [title, body]) {
    const m = SINGLE_BUMP_RE.exec(text);
    if (m) {
      push(m[1], m[2], m[3]);
      if (out.length > 0) return out;
    }
  }
  return out;
}

/** Numeric value of one dotted version segment, ignoring any prerelease/build suffix. */
function segment(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const stripped = raw.split(/[-+]/)[0];
  if (!/^\d+$/.test(stripped)) throw new Error(`unparseable version segment: ${raw}`);
  return Number(stripped);
}

/**
 * Compares two dotted versions numerically over their first three segments.
 * Prerelease/build suffixes are stripped, so `8.0.0-rc.1` compares equal to
 * `8.0.0`. Throws on anything non-numeric — callers treat a throw as
 * "unverifiable, do nothing".
 */
export function compareVersions(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < 3; i++) {
    const av = segment(as[i]);
    const bv = segment(bs[i]);
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/** Major component of a version. Throws on non-numeric input. */
function majorOf(v: string): number {
  return segment(v.split(".")[0]);
}

const BLOCKED_MAJOR_RE = /^-\s+`([^`]+)`:\s*\d+\.x\s*(?:→|->)\s*\d+\.x\s*$/gm;

/**
 * Reads the `- \`pkg\`: 6.x → 7.x` bullets that `fileMajorBumpIssue` writes into
 * a major-bump tracking issue. An empty set is a valid result: nothing is
 * documented as blocked.
 */
export function parseBlockedMajors(issueBody: string): Set<string> {
  const out = new Set<string>();
  for (const m of issueBody.matchAll(BLOCKED_MAJOR_RE)) out.add(m[1]);
  return out;
}

/**
 * Maps top-level package name → installed version from a `package-lock.json`.
 * Nested `.../node_modules/...` keys are transitive duplicates and are skipped
 * so they can't shadow the top-level resolution. Returns an empty map on parse
 * failure or an unrecognised shape (including the empty content the contents
 * API returns for files over 1 MB) — callers treat that as "unverifiable".
 */
export function parseLockVersions(lockJson: string): Map<string, string> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockJson);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  const lock = parsed as {
    packages?: Record<string, { version?: string }>;
    dependencies?: Record<string, { version?: string }>;
  };

  const PREFIX = "node_modules/";
  if (lock.packages && typeof lock.packages === "object") {
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key.startsWith(PREFIX)) continue;
      if (key.indexOf(PREFIX, 1) !== -1) continue; // nested/transitive duplicate
      const version = entry?.version;
      if (typeof version === "string" && version) out.set(key.slice(PREFIX.length), version);
    }
    if (out.size > 0) return out;
  }
  if (lock.dependencies && typeof lock.dependencies === "object") {
    for (const [name, entry] of Object.entries(lock.dependencies)) {
      const version = entry?.version;
      if (typeof version === "string" && version) out.set(name, version);
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds the major-bump tracking issue that names this PR in its `**Source PR:**`
 * line. Title matching is deliberately not attempted — `ensureAlertIssue` dedups
 * on a title naming only the first blocked package, which needn't appear in the
 * PR's own title.
 */
export function findTrackingIssue(
  fullName: string,
  prNumber: number,
  issues: { number: number; body: string }[],
): number | null {
  const re = new RegExp(`\\*\\*Source PR:\\*\\*\\s*${escapeRe(fullName)}#${prNumber}(?!\\d)`);
  let found: number | null = null;
  for (const issue of issues) {
    if (!issue.body || !re.test(issue.body)) continue;
    if (found === null || issue.number < found) found = issue.number;
  }
  return found;
}

/** Branch prefix for the only ecosystem whose lockfile we know how to verify. */
const NPM_BRANCH_PREFIX = "dependabot/npm_and_yarn/";

function isRootNpmDependabotBranch(headRefName: string): boolean {
  if (!headRefName.startsWith(NPM_BRANCH_PREFIX)) return false;
  // A remaining `/` means a nested-directory manifest, so the root lockfile is
  // the wrong verification target.
  return !headRefName.slice(NPM_BRANCH_PREFIX.length).includes("/");
}

/**
 * Closes dependabot PRs that Claws froze with the Problematic label and that have
 * since been superseded: their major-bump tracking issue is closed, and every
 * package the PR bumps is either already at-or-ahead of the requested version on
 * the base branch or is one of the major bumps the tracking issue documented as
 * blocked. Anything unverifiable — unparseable table, missing lockfile, package
 * absent from the lock, non-numeric version, an unsatisfied bump that isn't
 * documented as blocked — leaves the PR alone.
 *
 * Returns the set of PR numbers closed.
 */
export async function sweepSupersededDependabotPRs(repo: Repo, prs: gh.PR[]): Promise<Set<number>> {
  const closed = new Set<number>();

  const candidates = prs.filter(
    (pr) =>
      gh.isDependabotPR(pr) &&
      pr.labels.some((l) => l.name === LABELS.problematic) &&
      !gh.isForkPR(pr) &&
      !pr.isDraft &&
      !gh.isDispatchSkippable(repo.fullName, pr) &&
      isRootNpmDependabotBranch(pr.headRefName) &&
      !db.hasActiveWorkForPR(repo.fullName, pr.number, [
        AGENT_KINDS.CI_FIXER,
        AGENT_KINDS.CI_FIXER_CONFLICT,
        AGENT_KINDS.CI_FIXER_PROBLEMATIC,
        AGENT_KINDS.REVIEW_ADDRESSER,
        AGENT_KINDS.PR_REVIEWER,
      ]),
  );
  // Keep the API cost at zero for the common case — `listRecentlyClosedIssues`
  // is uncached, so it must stay below this check.
  if (candidates.length === 0) return closed;

  let openIssues: { number: number; body: string }[];
  let closedIssues: { number: number; body: string }[];
  try {
    openIssues = await gh.listOpenIssues(repo.fullName);
    closedIssues = await gh.listRecentlyClosedIssues(repo.fullName, null, 100);
  } catch (err) {
    reportError("pr-dispatcher:superseded-pr", repo.fullName, err);
    return closed;
  }

  for (const pr of candidates) {
    try {
      if (findTrackingIssue(repo.fullName, pr.number, openIssues) !== null) continue;
      const trackingNumber = findTrackingIssue(repo.fullName, pr.number, closedIssues);
      if (trackingNumber === null) continue;
      const tracking = closedIssues.find((i) => i.number === trackingNumber);
      if (!tracking) continue;

      const body = await gh.getPRBody(repo.fullName, pr.number);
      const bumps = parseDependabotBumps(pr.title, body ?? "");
      if (bumps.length === 0) {
        log.info(`[pr-dispatcher] No parseable bumps on ${repo.fullName}#${pr.number} — leaving open`);
        continue;
      }

      const lock = await gh.fetchRepoFileWithSha(repo.fullName, "package-lock.json", pr.baseRefName);
      if (!lock) {
        log.info(`[pr-dispatcher] No package-lock.json on ${repo.fullName}@${pr.baseRefName} — leaving #${pr.number} open`);
        continue;
      }
      const versions = parseLockVersions(lock.content);
      if (versions.size === 0) {
        log.info(`[pr-dispatcher] Could not read package-lock.json on ${repo.fullName}@${pr.baseRefName} — leaving #${pr.number} open`);
        continue;
      }

      const blockedMajors = parseBlockedMajors(tracking.body ?? "");
      const landed: { bump: Bump; base: string }[] = [];
      const heldBack: Bump[] = [];
      let unverifiable: string | null = null;
      for (const bump of bumps) {
        const base = versions.get(bump.pkg);
        if (base === undefined) {
          unverifiable = `${bump.pkg} is absent from the base lockfile`;
          break;
        }
        try {
          if (compareVersions(base, bump.to) >= 0) {
            landed.push({ bump, base });
            continue;
          }
          if (blockedMajors.has(bump.pkg) && majorOf(bump.to) > majorOf(bump.from)) {
            heldBack.push(bump);
            continue;
          }
        } catch {
          unverifiable = `${bump.pkg} has a non-numeric version`;
          break;
        }
        unverifiable = `${bump.pkg} is still behind on ${pr.baseRefName} and is not documented as blocked`;
        break;
      }
      if (unverifiable) {
        log.info(`[pr-dispatcher] Not superseded: ${repo.fullName}#${pr.number} — ${unverifiable}`);
        continue;
      }

      const comments = await gh.getIssueComments(repo.fullName, pr.number);
      const alreadyCommented = comments.some((c) => c.body.includes(SUPERSEDED_MARKER));
      if (!alreadyCommented) {
        const msg = [
          `### Closing as superseded`,
          SUPERSEDED_MARKER,
          ``,
          `Tracking issue #${trackingNumber} is closed, and every dependency this PR bumps has been re-checked against \`package-lock.json\` on \`${pr.baseRefName}\`.`,
          ...(landed.length > 0
            ? [
                ``,
                `**Landed on \`${pr.baseRefName}\`:**`,
                landed.map((l) => `- \`${l.bump.pkg}\`: ${l.bump.to} requested → ${l.base} on base`).join("\n"),
              ]
            : []),
          ...(heldBack.length > 0
            ? [
                ``,
                `**Held back (documented as blocked in #${trackingNumber}):**`,
                heldBack.map((b) => `- \`${b.pkg}\`: ${b.from} → ${b.to}`).join("\n"),
              ]
            : []),
          ``,
          `This PR carried Claws CI-fix commits, so Dependabot no longer maintains it and will not close it itself. Closing automatically. Reopen it if this is wrong.`,
        ].join("\n");
        await gh.commentOnIssue(repo.fullName, pr.number, msg, { agentName: "Superseded PR Closer" });
      }

      await gh.closePR(repo.fullName, pr.number);
      log.info(
        `[pr-dispatcher] Closed superseded dependabot PR ${repo.fullName}#${pr.number} (tracking issue #${trackingNumber} closed)`,
      );
      closed.add(pr.number);
    } catch (err) {
      reportError("pr-dispatcher:superseded-pr", `${repo.fullName}#${pr.number}`, err);
    }
  }

  return closed;
}
