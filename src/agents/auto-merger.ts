import { isEscalationManualAction } from "../pr-escalation.js";
import { LABELS, prUrl, issueUrl, isClawsIssueId, type Repo } from "../config.js";
import { AGENT_KINDS } from "../worker.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import * as slack from "../slack.js";
import * as db from "../db.js";
import { guardContent } from "../prompt-guard.js";
import { POST_MERGE_ACTION_HEADING, extractPostMergeActionSection, isVerificationOnlyAction } from "./issue-worker.js";
import { extractClosedIssueRefs } from "../phase-coverage.js";
import * as clawsIssues from "../claws-issues.js";
import { AWAITING_OPERATOR_MARKER } from "../blocked-reason.js";
import { ISSUE_REF_PATTERN, canonicalIssueRef, sameIssueRef, type IssueRef } from "../issue-id.js";
import { closeIssueIfPlanComplete, loadIssuePhaseState, peekTotalPhases, type IssuePhaseState } from "../planned-prs.js";
import * as planParser from "../plan-parser.js";
import { parkForHuman, settleMergedSingleStep } from "../issue-handback.js";
import { linkedIssue } from "../pr-hold.js";
import { isPrHeldForReapproval } from "../reapproval.js";
import { hasManualAction, infraMergeApproval, isMergeApproved, isReviewedHeadAwaitingMerge, needsHumanReview } from "../pr-state.js";
import { setPrNeedsOperatorGate } from "../gate-events.js";
import { mapWithConcurrency } from "../util.js";
import { recordSweep, reconcileStallAlert, type StallEvaluation } from "./auto-bump-stall.js";
import { announceAwaitingOperator } from "../awaiting-operator.js";
import { isAutoBumpPR, isImageScanPR, isImageScanPrunePR, isImageScanSnapshotPR } from "../dependency-prs.js";
import {
  PIN_LINE, checkImageScanPruneDiff, checkImageScanSnapshotDiff, imageScanHoldText, isTransientImageScanFailure,
  type ImageScanVerdict,
} from "../image-scan-prs.js";
import { isRenovateMajorUpdate, isTrustedRenovatePR, renovateApprovalHoldReason } from "../renovate.js";
import { CLAWS_NOOP_MERGE_LABEL, providerBumpDiffVerdict, tofuPlanChangeCount, type ProviderBumpVerdict } from "../tofu-plan.js";

const ISSUE_BRANCH_RE = new RegExp(`^claws/issue-(${ISSUE_REF_PATTERN})-`);

export { isAutoBumpPR, isImageScanPR, isImageScanPrunePR, isImageScanSnapshotPR } from "../dependency-prs.js";

/**
 * True for a non-major update PR from a trusted Renovate identity (see
 * `isTrustedRenovatePR`). Such a PR is approval-exempt but, unlike the other
 * exempt categories, still needs a clean Claws review of its current head.
 * Update type comes from labels, title (`(major)` / `to v<N>`), branch and the Update column of any body table.
 * The forge `Automerge` label plays no part in this — it approves nothing (#3219).
 */
export async function isRenovateExempt(repoFullName: string, pr: gh.PR): Promise<boolean> {
  return !isRenovateMajorUpdate(pr) && await isTrustedRenovatePR(repoFullName, pr);
}

/** Structural-gate verdicts (auto-bump and image-scan), keyed on `${gate}:${repo}#${number}@${headRefOid}`
 * so a force-push naturally invalidates the cached verdict. Capped and evicted oldest-first (insertion order). */
const GATE_VERDICT_CACHE_MAX = 500;
const GATE_VERDICT_CACHE_TTL_MS = 15 * 60 * 1000;
type AutoBumpGateVerdict = Awaited<ReturnType<typeof checkAutoBumpDiff>>;
type GateName = "auto-bump" | "image-scan";
const gateVerdictCache = new Map<string, { verdict: AutoBumpGateVerdict | ImageScanVerdict; at: number }>();

/** Test-only: drop every cached gate verdict (auto-bump and image-scan). */
export function clearAutoBumpGateCache(): void {
  gateVerdictCache.clear();
}

/**
 * The cached verdict for `gate` on this head, or a fresh `compute()` stored
 * under it. A verdict `cacheable` rejects (a possibly transient read failure)
 * is returned but never stored. No head SHA means no caching.
 */
async function cachedGateVerdict<V extends AutoBumpGateVerdict | ImageScanVerdict>(
  gate: GateName,
  repoFullName: string,
  prNumber: number,
  headSha: string | undefined,
  refresh: boolean | undefined,
  compute: () => Promise<V>,
  cacheable: (verdict: V) => boolean,
): Promise<V> {
  if (!headSha) return compute();
  const key = `${gate}:${repoFullName}#${prNumber}@${headSha}`;
  const cached = gateVerdictCache.get(key);
  if (cached && !refresh && Date.now() - cached.at < GATE_VERDICT_CACHE_TTL_MS) return cached.verdict as V;
  const verdict = await compute();
  if (!cacheable(verdict)) return verdict;
  gateVerdictCache.delete(key);
  gateVerdictCache.set(key, { verdict, at: Date.now() });
  if (gateVerdictCache.size > GATE_VERDICT_CACHE_MAX) {
    const oldest = gateVerdictCache.keys().next().value;
    if (oldest !== undefined) gateVerdictCache.delete(oldest);
  }
  return verdict;
}

/**
 * `checkAutoBumpDiff`, cached per head SHA for 15 minutes so `/prs`, the
 * ci-fixer, the PR dispatcher and the auto-merger share one verdict at the
 * cost of two API reads per head. A PR with no `headRefOid` (Forgejo does not
 * always report one) is never cached — checked fresh each time. `refresh`
 * recomputes and overwrites the entry; the merge sweep passes it, with the
 * files it already read as `knownFiles`.
 */
export async function autoBumpGateVerdict(
  repoFullName: string,
  pr: gh.PR,
  opts: { knownFiles?: readonly string[]; refresh?: boolean; headSha?: string } = {},
): Promise<AutoBumpGateVerdict> {
  return cachedGateVerdict(
    "auto-bump", repoFullName, pr.number, opts.headSha || pr.headRefOid, opts.refresh,
    () => checkAutoBumpDiff(repoFullName, pr.number, opts.knownFiles, opts.headSha || pr.headRefOid),
    // An unreadable file list, diff or pin scan may be transient: never cache it.
    (verdict) => verdict.ok || !isTransientAutoBumpFailure(verdict.reason),
  );
}

/**
 * The image-scan gate for a snapshot (`checkImageScanSnapshotDiff`) or prune
 * (`checkImageScanPruneDiff`) PR, cached per head SHA like `autoBumpGateVerdict`.
 * `no-files` and `unverifiable` are never cached. The merge sweep passes
 * `refresh` with the files, head and base it read live; other callers read the
 * cached verdict, the prune check reading the body and base tip itself on a miss.
 */
export async function imageScanGateVerdict(
  repoFullName: string,
  pr: gh.PR,
  opts: { knownFiles?: readonly string[]; refresh?: boolean; headSha?: string; baseSha?: string } = {},
): Promise<ImageScanVerdict> {
  return cachedGateVerdict(
    "image-scan", repoFullName, pr.number, opts.headSha || pr.headRefOid, opts.refresh,
    () => isImageScanSnapshotPR(pr)
      ? checkImageScanSnapshotDiff(repoFullName, pr.number, opts.knownFiles)
      : checkImageScanPruneDiff(repoFullName, pr.number, { knownFiles: opts.knownFiles, body: pr.body, baseSha: opts.baseSha }),
    (verdict) => verdict.ok || !isTransientImageScanFailure(verdict.reason),
  );
}

/** True for an auto-bump gate failure that may be a transient read error: never cached, never posted on the PR. */
function isTransientAutoBumpFailure(reason: AutoBumpDiffFailure): boolean {
  return reason === "no-files" || reason === "no-diff" || reason === "pin-scan-failed";
}

/** Why an auto-bump PR whose diff fails the gate is held for a merge approval, by failure reason. */
export function autoBumpHoldText(reason: AutoBumpDiffFailure): string {
  switch (reason) {
    case "not-image-pin-only": return "auto-bump diff is not an image-pin-only bump";
    case "non-bump-files": return "auto-bump PR touches non-bump files";
    case "no-files": return "auto-bump PR has no readable changed files";
    case "no-diff": return "auto-bump PR diff could not be read";
    case "pin-scan-failed": return "auto-bump allowlist prune could not be checked against the repo's pins";
  }
}

/**
 * Why a non-exempt PR is held for a merge approval, for the `/prs` Awaiting
 * approval badge: the auto-bump gate's failure for an auto-bump PR, the
 * image-scan gate's for a snapshot or prune PR, else
 * `renovateApprovalHoldReason`. Null when there is nothing specific to say.
 */
export async function approvalHoldReason(repoFullName: string, pr: gh.PR): Promise<string | null> {
  if (isAutoBumpPR(pr)) {
    const verdict = await autoBumpGateVerdict(repoFullName, pr);
    if (!verdict.ok) return autoBumpHoldText(verdict.reason);
  }
  if (isImageScanPR(pr)) {
    const verdict = await imageScanGateVerdict(repoFullName, pr);
    if (!verdict.ok) return imageScanHoldText(verdict);
  }
  return renovateApprovalHoldReason(repoFullName, pr);
}

/**
 * True when the PR may be auto-merged without a stored merge approval
 * (docs, ideas-collection, auto-bump, image-scan snapshot and prune, and trusted non-major
 * Renovate — see `isRenovateExempt`). An auto-bump PR is exempt only while its
 * diff passes `checkAutoBumpDiff` (via `autoBumpGateVerdict`); a failing diff
 * withdraws the exemption, so it then needs a stored merge approval like any
 * other PR (#clw_01M4RV5WKJT5XQN89BKMN7X8RH). An image-scan PR is exempt the
 * same way, only while `imageScanGateVerdict` passes (#clw_01M61EFZ6ZZM8FWGN2PAH3KNZB).
 *
 * The row's `needsHumanReview` (mirrored as `Needs LGTM`) outranks every
 * exemption: a job running on a trial provider (currently `doc-maintainer` on
 * Codex) marks the PRs it writes so they wait for a dashboard approval. `row`
 * is the PR's `claws_prs` row; pass it fresh where the answer gates a merge.
 *
 * Exemption wins over approval: a stored merge approval never adds a review
 * gate to an exempt PR, and `approved` on one only governs block reporting.
 */
export async function isApprovalExempt(
  repoFullName: string,
  pr: gh.PR,
  row: db.ClawsPrRecord | null | undefined,
): Promise<boolean> {
  if (needsHumanReview(row)) return false;
  return (
    pr.headRefName.startsWith("claws/docs-") ||
    pr.headRefName.startsWith("claws/ideas-collect-") ||
    (isAutoBumpPR(pr) && (await autoBumpGateVerdict(repoFullName, pr)).ok) ||
    (isImageScanPR(pr) && (await imageScanGateVerdict(repoFullName, pr)).ok) ||
    await isRenovateExempt(repoFullName, pr)
  );
}

/**
 * True when a PR is waiting only on a human: its current head carries a
 * completed, up-to-date review and it has neither a stored merge approval
 * nor an approval exemption. Shared by the CI fixer's `identifyPRWork`
 * (skips a fresh fix run) and `/prs`'s `buildMergeAction` (labels the
 * blocked-merge reason); the PR dispatcher's Phase 4 skips a fresh reviewer
 * run with its own, narrower check — any `awaiting-merge` row with a clean
 * review of the current head, approved or not — so a PR that is reviewed,
 * green at review time, and waiting on the owner does not keep burning agent
 * runs merely by staying open.
 */
export async function isIdleAwaitingHuman(repoFullName: string, pr: gh.PR, row: db.ClawsPrRecord | null | undefined): Promise<boolean> {
  return isReviewedHeadAwaitingMerge(row, pr.headRefOid) && !isMergeApproved(row) && !(await isApprovalExempt(repoFullName, pr, row));
}

// PIN_LINE (src/image-scan-prs.ts): an `image:`/`newTag:` pin line, or an env-var `value:`
// line that may re-pin an image reference (see `ENV_IMAGE_NAME`).

/**
 * The repository-shaped name an env-var `value:` re-pin must have: a host (optional
 * `:port`) followed by at least one `/segment`. Rejects `redis:6379`, URLs and plain strings.
 */
const ENV_IMAGE_NAME = /^[a-z0-9][a-z0-9._-]*(?::\d{1,5})?(?:\/[a-z0-9][a-z0-9._-]*)+$/;

/** Split `registry/name:tag@sha256:…` into its name and its version (tag+digest). */
function splitImageRef(ref: string): { name: string; tag: string; version: string } | null {
  const at = ref.indexOf("@");
  const digest = at >= 0 ? ref.slice(at + 1) : "";
  const head = at >= 0 ? ref.slice(0, at) : ref;
  if (at >= 0 && !/^sha256:[0-9a-f]{64}$/.test(digest)) return null;
  const colon = head.lastIndexOf(":");
  let name = head;
  let tag = "";
  // A colon with a "/" after it is a registry port (registry:5000/app), not a tag.
  if (colon > 0 && !head.slice(colon + 1).includes("/")) {
    name = head.slice(0, colon);
    tag = head.slice(colon + 1);
    if (!/^[\w][\w.-]{0,127}$/.test(tag)) return null;
  }
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._\-/:]*$/.test(name)) return null;
  if (!tag && !digest) return null; // an unpinned image is not a version pin
  return { name, tag, version: `${tag}@${digest}` };
}

/** True when a removed/added line pair is the same image:/newTag: key re-pinned to a new value. */
function pinPairOk(removed: string, added: string): boolean {
  const rm = PIN_LINE.exec(removed);
  const ad = PIN_LINE.exec(added);
  if (!rm || !ad) return false;
  if (rm[1] !== ad[1]) return false;
  const rmValue = rm[2] ?? rm[3] ?? rm[4];
  const adValue = ad[2] ?? ad[3] ?? ad[4];
  if (/newTag:\s*$/.test(rm[1])) {
    return (
      /^[\w][\w.-]{0,127}$/.test(rmValue) &&
      /^[\w][\w.-]{0,127}$/.test(adValue) &&
      rmValue !== adValue
    );
  }
  const rmRef = splitImageRef(rmValue);
  const adRef = splitImageRef(adValue);
  if (!rmRef || !adRef) return false;
  if (/value:\s*$/.test(rm[1]) && !ENV_IMAGE_NAME.test(rmRef.name)) return false;
  return rmRef.name === adRef.name && rmRef.version !== adRef.version;
}

type DiffHunk = { removed: string[]; added: string[] };
type DiffSection = { path: string; headers: string[]; hunks: DiffHunk[] };

/** Header lines that mean a file was created, deleted, renamed, re-moded or is binary. */
const BAD_HEADER_PREFIXES = [
  "new file mode",
  "deleted file mode",
  "rename from",
  "rename to",
  "copy from",
  "copy to",
  "old mode",
  "new mode",
  "Binary files",
  "GIT binary patch",
];

/** Split a unified diff into per-file sections. Null when the diff is malformed or has a bad header. */
function parseDiffSections(diff: string): DiffSection[] | null {
  if (!diff.trim()) return null;
  if (diff.length > 200_000) return null;

  const lines = diff.split("\n");
  if (!lines[0]?.startsWith("diff --git ")) return null;

  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  let currentHunk: DiffHunk | null = null;
  let inHeader = true;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/.* b\/(.*)$/.exec(line);
      current = { path: m?.[1] ?? "", headers: [], hunks: [] };
      sections.push(current);
      currentHunk = null;
      inHeader = true;
      continue;
    }
    if (!current) return null;
    if (inHeader) {
      if (line.startsWith("@@")) {
        inHeader = false;
        currentHunk = { removed: [], added: [] };
        current.hunks.push(currentHunk);
      } else {
        if (BAD_HEADER_PREFIXES.some((p) => line.startsWith(p))) return null;
        if (line.startsWith("+++ b/")) current.path = line.slice(6);
        current.headers.push(line);
      }
      continue;
    }
    if (line.startsWith("@@")) {
      currentHunk = { removed: [], added: [] };
      current.hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) return null;
    if (line.startsWith("+")) {
      currentHunk.added.push(line.slice(1));
    } else if (line.startsWith("-")) {
      currentHunk.removed.push(line.slice(1));
    } else if (line.startsWith(" ") || line === "" || line.startsWith("\\")) {
      // context, blank, or "\ No newline at end of file" — ignore
    } else {
      return null;
    }
  }
  return sections;
}

/** True when every hunk of a manifest section is a same-name image:/newTag: re-pin
 * (or an env-var value: re-pin of the same image). */
function isPinOnlySection(section: DiffSection): boolean {
  if (section.hunks.length === 0) return false;
  for (const hunk of section.hunks) {
    if (hunk.removed.length !== hunk.added.length || hunk.added.length === 0) return false;
    for (let i = 0; i < hunk.removed.length; i++) {
      if (!pinPairOk(hunk.removed[i], hunk.added[i])) return false;
    }
  }
  return true;
}

/**
 * True when a unified diff does nothing but re-pin image versions: every changed
 * line is an image:/newTag: pin (or an env-var value: image reference) whose image name is unchanged and whose tag or
 * digest moved. Layout-independent, so it covers production-infra's
 * apps/<app>/[base|prod|migrate/]deployment.yaml and fleet-infra's
 * apps/<app>/deployment-staging.yaml alike (#2777). Fails closed.
 */
export function isImagePinOnlyDiff(diff: string): boolean {
  const sections = parseDiffSections(diff);
  if (!sections) return false;
  return sections.every(isPinOnlySection);
}

/** The tags of the pin lines in `lines` (`newTag:` values and `image:` ref tags). */
function pinTags(lines: readonly string[]): string[] {
  const tags: string[] = [];
  for (const line of lines) {
    const m = PIN_LINE.exec(line);
    if (!m) continue;
    const value = m[2] ?? m[3] ?? m[4];
    if (/newTag:\s*$/.test(m[1])) tags.push(value);
    else {
      const ref = splitImageRef(value);
      if (ref?.tag) tags.push(ref.tag);
    }
  }
  return tags;
}

/** The tags an accepted manifest section re-pins to (`newTag:` values and `image:` ref tags). */
function bumpedToTags(section: DiffSection): string[] {
  return section.hunks.flatMap((hunk) => pinTags(hunk.added));
}

/** The tags an accepted manifest section re-pins away from (the removed pin lines' tags). */
function bumpedFromTags(section: DiffSection): string[] {
  return section.hunks.flatMap((hunk) => pinTags(hunk.removed));
}

/**
 * The registry tag allowlist files that bump workflows append to or swap the
 * outgoing tag in: fleet-infra's LAN registry and production-infra's prod
 * registry (#clw_01M4TK4C1E6VHMC09T13HDCBHJ).
 */
const REGISTRY_ALLOWLIST_PATHS: readonly string[] = ["apps/registry/config.json", "infrastructure/prod/registry/config.json"];
const isRegistryAllowlistPath = (path: string): boolean => REGISTRY_ALLOWLIST_PATHS.includes(path);

/** `^tag$` with every "." escaped, as a JSON string literal (backslash doubled). */
function allowlistEntry(tag: string): string {
  return `"^${tag.replace(/\./g, "\\\\.")}$"`;
}

/**
 * The tag an anchored allowlist entry admits, or null unless the entry is
 * exactly `allowlistEntry(tag)` for a plain tag — so a regex or wildcard entry
 * never reads as a single tag.
 */
function allowlistEntryTag(entry: string): string | null {
  const m = /^"\^(.*)\$"$/.exec(entry);
  if (!m) return null;
  const tag = m[1].replace(/\\\\\./g, ".");
  if (!/^[\w][\w.-]{0,127}$/.test(tag)) return null;
  return allowlistEntry(tag) === entry ? tag : null;
}

/**
 * The structural verdict on a registry-config diff section, or null when it
 * fails. The change may add at most one anchored entry, for a tag in
 * `newTags`, and remove entries for tags in `oldTags` (the outgoing tag) or
 * plain-tag entries returned as `staleCandidates` — tags the caller must
 * confirm no manifest pins before the change counts as a bump. With no
 * addition (the bumped-to tag is already listed because another app pins it,
 * production-infra #86) at least one entry must be removed. An entry removed
 * and re-added identical apart from its comma is a comma fix, not a change,
 * so a swap may drop an old entry from the middle of the list and fix the
 * last entry's comma (production-infra #36); across the whole change each net
 * removal takes one comma line with it and each net addition adds one. Other
 * keys, other patterns, two net additions or removing the added entry fail.
 */
export function registryAllowlistVerdict(
  section: DiffSection,
  newTags: readonly string[],
  oldTags: readonly string[],
): { staleCandidates: string[] } | null {
  if (!isRegistryAllowlistPath(section.path)) return null;
  if (section.hunks.length === 0) return null;
  const entryLine = /^\s*("\^[^"]*\$")\s*(,?)\s*$/;
  const parse = (lines: readonly string[]) => lines.map((l) => entryLine.exec(l));
  const removed = parse(section.hunks.flatMap((h) => h.removed));
  const added = parse(section.hunks.flatMap((h) => h.added));
  if (![...removed, ...added].every((m) => m !== null)) return null;
  const commas = (ms: (RegExpExecArray | null)[]) => ms.filter((m) => m![2] === ",").length;
  // Pair each removed entry with an identical added one (its comma moved).
  const netAdded = added.map((m) => m![1]);
  const netRemoved: string[] = [];
  for (const m of removed) {
    const idx = netAdded.indexOf(m![1]);
    if (idx >= 0) netAdded.splice(idx, 1);
    else netRemoved.push(m![1]);
  }
  if (netAdded.length > 1) return null;
  if (netAdded.length === 1 && !newTags.map(allowlistEntry).includes(netAdded[0])) return null;
  if (netAdded.length === 0 && netRemoved.length === 0) return null;
  if (netAdded.length === 1 && netRemoved.includes(netAdded[0])) return null;
  if (commas(removed) - commas(added) !== netRemoved.length - netAdded.length) return null;
  const outgoing = oldTags.map(allowlistEntry);
  const staleCandidates: string[] = [];
  for (const entry of netRemoved) {
    if (outgoing.includes(entry)) continue;
    const tag = allowlistEntryTag(entry);
    if (tag === null) return null;
    staleCandidates.push(tag);
  }
  return { staleCandidates };
}

/**
 * True when a registry-config diff section passes `registryAllowlistVerdict`
 * with no stale candidates: an append of a bumped-to tag, a swap of the
 * outgoing tag for it, or a removal of only outgoing tags' entries.
 */
export function isRegistryAllowlistBump(
  section: DiffSection,
  newTags: readonly string[],
  oldTags: readonly string[],
): boolean {
  return registryAllowlistVerdict(section, newTags, oldTags)?.staleCandidates.length === 0;
}

/** Most YAML files `pinnedTagsAtRef` reads before giving up (fleet-infra has ~515). */
const PIN_SCAN_MAX_FILES = 2000;

/**
 * Every tag a pin line (`PIN_LINE`, via `pinTags`) in any YAML file of `repo`
 * at `ref` carries. Throws on any read failure or when the repo has more than
 * `PIN_SCAN_MAX_FILES` YAML files, so the caller can fail closed.
 */
async function pinnedTagsAtRef(repo: string, ref: string): Promise<Set<string>> {
  const paths = (await gh.listRepoTreePaths(repo, ref)).filter((p) => /\.ya?ml$/.test(p));
  if (paths.length > PIN_SCAN_MAX_FILES) throw new Error(`${paths.length} YAML files exceed the ${PIN_SCAN_MAX_FILES}-file pin scan cap`);
  const tags = new Set<string>();
  await mapWithConcurrency(paths, 8, async (path) => {
    const file = await gh.fetchRepoFileWithSha(repo, path, ref);
    if (!file) throw new Error(`${path} unreadable at ${ref}`);
    for (const tag of pinTags(file.content.split("\n"))) tags.add(tag);
  });
  return tags;
}

/** Why an auto-bump PR's diff does not clear the structural gate: `checkAutoBumpDiff`'s failure reasons. */
export type AutoBumpDiffFailure = "no-files" | "no-diff" | "non-bump-files" | "not-image-pin-only" | "pin-scan-failed";

/**
 * The auto-bump structural gate: every changed file must be a YAML manifest
 * outside `.github/` (plus optionally one registry allowlist file); manifest diffs
 * must be image-pin rewrites only (same image name, new tag or digest), and the
 * allowlist file may only gain one anchored entry for a bumped-to tag, swap the
 * outgoing tag's entry for the bumped-to tag's, or remove only outgoing tags'
 * entries (the bumped-to tag already being listed). Any of those may also
 * remove entries for stale tags — tags no YAML pin line in the repo at the PR's
 * head (`headSha`, read when not passed) carries; that needs a repo scan, whose
 * failure is the transient `pin-scan-failed`. Read through `autoBumpGateVerdict`, so a
 * passing verdict is what makes an auto-bump PR approval-exempt for `tryMerge`,
 * the PR dispatcher and `/prs`; a failing one only withdraws that exemption. `knownFiles`, when passed, is used instead
 * of a second `getPRChangedFiles` call — the diff is only fetched once the file
 * check passes.
 */
export async function checkAutoBumpDiff(
  repoFullName: string,
  prNumber: number,
  knownFiles?: readonly string[],
  headSha?: string,
): Promise<{ ok: true } | { ok: false; reason: AutoBumpDiffFailure }> {
  const files = knownFiles ?? (await gh.getPRChangedFiles(repoFullName, prNumber));
  if (files.length === 0) return { ok: false, reason: "no-files" };
  const isManifest = (f: string) => /\.ya?ml$/.test(f) && !f.startsWith(".github/") && !f.includes("/.github/");
  if (!files.every((f) => isManifest(f) || isRegistryAllowlistPath(f))) return { ok: false, reason: "non-bump-files" };
  const diff = await gh.getPRDiff(repoFullName, prNumber);
  if (!diff.trim()) return { ok: false, reason: "no-diff" };
  const sections = parseDiffSections(diff);
  if (!sections) return { ok: false, reason: "not-image-pin-only" };
  const manifests = sections.filter((sec) => !isRegistryAllowlistPath(sec.path));
  const configs = sections.filter((sec) => isRegistryAllowlistPath(sec.path));
  if (manifests.length === 0 || !manifests.every(isPinOnlySection)) return { ok: false, reason: "not-image-pin-only" };
  if (configs.length > 1) return { ok: false, reason: "non-bump-files" };
  if (configs.length === 0) return { ok: true };
  const verdict = registryAllowlistVerdict(configs[0], manifests.flatMap(bumpedToTags), manifests.flatMap(bumpedFromTags));
  if (!verdict) return { ok: false, reason: "non-bump-files" };
  if (verdict.staleCandidates.length === 0) return { ok: true };
  let pinned: Set<string>;
  try {
    pinned = await pinnedTagsAtRef(repoFullName, headSha || (await gh.getPRHeadSHA(repoFullName, prNumber)));
  } catch (err) {
    log.warn(`[auto-merger] ${repoFullName}#${prNumber}: allowlist prune pin scan failed: ${err}`);
    return { ok: false, reason: "pin-scan-failed" };
  }
  if (verdict.staleCandidates.some((tag) => pinned.has(tag))) return { ok: false, reason: "non-bump-files" };
  return { ok: true };
}

/** After a successful merge, surface a "## 📋 Manual action required after merge" note from the
 * PR body as a comment plus a Slack ping — the merged body is not something anyone re-reads. */
async function announcePostMergeAction(repo: Repo, pr: gh.PR): Promise<void> {
  try {
    const body = await gh.getPRBody(repo.fullName, pr.number);
    const section = extractPostMergeActionSection(body);
    if (!section) return;
    const note = section.slice(POST_MERGE_ACTION_HEADING.length).trim();
    if (!note) return;
    if (isVerificationOnlyAction(note)) {
      log.info(`[auto-merger] Skipped verification-only post-merge note for ${repo.fullName}#${pr.number}: ${note}`);
      return;
    }
    const url = prUrl(repo.fullName, pr.number);
    const guarded = await guardContent(note, { repo: repo.fullName, source: "pr-post-merge-action", itemNumber: pr.number });
    await gh.commentOnIssue(
      repo.fullName, pr.number,
      `## 📋 Manual action required now this is merged\n\n${guarded}`,
      { agentName: "Auto Merger" },
    );
    await slack.notify(`:memo: [auto-merger] Merged ${repo.fullName}#${pr.number} — manual action required: ${note}\n${url}`);
    log.info(`[auto-merger] Announced post-merge manual action for ${repo.fullName}#${pr.number}`);
  } catch (err) {
    log.warn(`[auto-merger] Could not announce post-merge manual action for ${repo.fullName}#${pr.number}: ${err}`);
  }
}

/** Marker on the one issue comment saying every PR merged and the operator step remains. */
export { AWAITING_OPERATOR_MARKER };

/**
 * Set the PR's `pr-needs-operator:infra` gate (src/gate-events.ts) beside its
 * merge block: active while the block's code says an infra PR needs a human
 * merge, inactive for any other code or a cleared block. Never throws.
 */
async function setInfraGate(repo: Repo, pr: gh.PR, code: MergeSkipCode | undefined): Promise<void> {
  const active = code === "infra" || code === "infra-plan" || code === "infra-approval-stale";
  let issueId: string | null = null;
  if (active) {
    try {
      issueId = (await db.getClawsPr(repo.fullName, pr.number))?.issueId ?? null;
    } catch (err) {
      log.warn(`[auto-merger] Could not read ${repo.fullName}#${pr.number}'s issue for its infra gate: ${err}`);
    }
  }
  await setPrNeedsOperatorGate(repo.fullName, pr.number, issueId, "infra", active);
}

/** Marker identifying the single, edited-in-place "Merge blocked" comment on a PR. */
export const MERGE_STATUS_MARKER = "claws-merge-status";

/**
 * Tell the humans on an approved PR why it did not merge: one comment carrying
 * MERGE_STATUS_MARKER, edited in place and left alone when the text is
 * unchanged, plus the in-memory reason the dashboard renders (#2971). Never
 * throws — a reporting failure must not abort a sweep.
 */
async function reportMergeBlock(repo: Repo, pr: gh.PR, message: string, code?: MergeSkipCode): Promise<void> {
  try {
    gh.setMergeBlockReason(repo.fullName, pr.number, message, code);
    await setInfraGate(repo, pr, code);
    const body = [
      "### Merge blocked",
      "",
      message,
      "",
      "Claws re-checks this every few minutes; this comment is edited in place.",
      "",
      MERGE_STATUS_MARKER,
    ].join("\n");
    const comments = await gh.getIssueComments(repo.fullName, pr.number);
    const existing = comments.find((c) => gh.isClawsComment(c.body) && c.body.includes(MERGE_STATUS_MARKER));
    if (existing) {
      if (gh.stripClawsMarker(existing.body).trim() === body) return;
      await gh.editIssueComment(repo.fullName, existing.id, body, { agentName: "Auto Merger" });
    } else {
      await gh.commentOnIssue(repo.fullName, pr.number, body, { agentName: "Auto Merger" });
    }
  } catch (err) {
    log.warn(`[auto-merger] Could not report merge block on ${repo.fullName}#${pr.number}: ${err}`);
  }
}

/**
 * Why the auto-merger left an open PR unmerged, logged as the `merge_skipped`
 * diagnostic's `mergeSkip` so `claws_recent_job_logs` shows it
 * (#clw_01M4TK4C1E6VHMC09T13HDCBHJ).
 */
export type MergeSkipCode =
  | "fork" | "no-record" | "manual-action" | "stacked" | "reapproval-hold" | "closed"
  | "dispatch-guard" | "other-work" | "review-not-clean" | "review-stale" | "auto-bump-gate" | "image-scan-gate"
  | "not-approved" | "unreadable-files" | "infra" | "infra-plan" | "infra-approval-stale" | "doc-pr-mixed"
  | "ideas-pr-mixed" | "checks-pending" | "checks-failed" | "checks-held"
  | "checks-missing" | "conflict" | "mergeable-unknown" | "head-moved" | "error";

/** Agent kinds whose active run on a PR blocks merging it. */
const MERGE_BLOCKING_AGENT_KINDS = [
  AGENT_KINDS.CI_FIXER,
  AGENT_KINDS.CI_FIXER_CONFLICT,
  AGENT_KINDS.REVIEW_ADDRESSER,
  AGENT_KINDS.PR_REVIEWER,
];

/** Log a skipped PR with its structured reason; the free-text line is redacted from MCP diagnostics. */
function logMergeSkip(repo: Repo, pr: number, code: MergeSkipCode, line: string, level: "info" | "warn" = "info"): void {
  const context = { repo: repo.fullName, pr, mergeSkip: code };
  if (level === "warn") log.warn(line, "merge_skipped", context);
  else log.info(line, "merge_skipped", context);
}

/** Repos with a sweep in flight — the scheduler job and a chained queue row must not overlap. */
const sweepsInFlight = new Set<string>();

/**
 * Evaluate every open PR in `repo` for merge. A PR merged by hand is closed
 * out by the PR dispatcher's `refreshPrStore`, not here. Run by the
 * `auto-merger` scheduler job and by chained `auto-merger:sweep` queue rows
 * (#2971). Every sweep logs one `merge_sweep_done` line, so a sweep that
 * merged nothing still leaves a trace, and feeds its auto-bump verdicts to
 * the stalled auto-bump alert (`auto-bump-stall.ts`).
 */
export async function sweepRepo(repo: Repo): Promise<void> {
  if (sweepsInFlight.has(repo.fullName)) return;
  sweepsInFlight.add(repo.fullName);
  let openPrCount = 0;
  let mergedCount = 0;
  let skippedCount = 0;
  const bumps: StallEvaluation[] = [];
  try {
    // The sweep is chained off ci-fixer/reviewer completion, so the 60 s PR-list
    // cache may still hold labels captured before that agent mutated the PR (#2354).
    gh.invalidatePRList(repo.fullName);
    const prs = await gh.listPRs(repo.fullName);
    openPrCount = prs.length;
    for (const pr of prs) {
      if (gh.isDispatchSkippable(repo.fullName, pr)) {
        skippedCount++;
        logMergeSkip(repo, pr.number, "dispatch-guard", `[auto-merger] sweep: skipping ${repo.fullName}#${pr.number} — dispatch guard`);
        continue;
      }
      if (await db.hasActiveWorkForPR(repo.fullName, pr.number, MERGE_BLOCKING_AGENT_KINDS)) {
        skippedCount++;
        logMergeSkip(repo, pr.number, "other-work", `[auto-merger] sweep: skipping ${repo.fullName}#${pr.number} — other work running`);
        continue;
      }
      try {
        const result = await attemptMerge(repo, pr);
        if (result.merged) mergedCount++;
        else skippedCount++;
        if (isAutoBumpPR(pr)) bumps.push({ number: pr.number, title: pr.title, refusal: result.merged ? null : result });
      } catch (err) {
        skippedCount++;
        logMergeSkip(repo, pr.number, "error", `[auto-merger] sweep: tryMerge failed for ${repo.fullName}#${pr.number}: ${err}`, "warn");
      }
    }
    // A stalled auto-bump is surfaced as one alert issue per repo, not only a PR comment.
    const now = Date.now();
    recordSweep(repo.fullName, bumps, prs.map((pr) => pr.number), now);
    await reconcileStallAlert(repo.fullName, now);
  } finally {
    sweepsInFlight.delete(repo.fullName);
    log.info(
      `[auto-merger] sweep of ${repo.fullName} done: ${openPrCount} open, ${mergedCount} merged, ${skippedCount} skipped`,
      "merge_sweep_done",
      { repo: repo.fullName, openPrCount, mergedCount, skippedCount },
    );
  }
}

/** Attempt to merge a single PR if it meets all merge criteria. Returns true if merged. */
export async function tryMerge(repo: Repo, pr: gh.PR): Promise<boolean> {
  return (await attemptMerge(repo, pr)).merged;
}

/**
 * Why `attemptMerge` left a PR unmerged: the skip code and a human-readable
 * reason, plus the gate's failure reason on an `auto-bump-gate` refusal.
 */
export type MergeRefusal = { merged: false; code: MergeSkipCode; message: string; autoBumpReason?: AutoBumpDiffFailure };

/**
 * `tryMerge` with the refusal spelled out: every auto-merger gate, then the
 * merge. `mergedBy` names who merged it in the effectiveness event and as
 * `finalizeMergedClawsPR`'s source — `session:<id>` for a session's
 * `claws_merge_pr` (#clw_01M4XFRSGNP87QVW0N1W5KN0V4), else `auto-merger`.
 * `notify: false` never posts a "Merge blocked" comment, for a caller that
 * withdraws the approval on a refusal (`claws_approve_pr_merge`).
 * `infraMergeBy` (a session id) is set only by a session merge route whose
 * session holds the operator-granted `infra-merge` capability: an
 * infrastructure PR then skips the infra gate, its merge counting as the
 * human merge, but still needs a clean Claws review of the head and every
 * later gate (#clw_01M54GYV05ZCZWKEEMAJTE9Q3X). The headless sweep never
 * passes it. A merge under it answers the infra paths it covered.
 * A human's board approval of the infra merge for the PR's live head (the
 * row's `infra_merge_approved_*` columns, see `infraMergeApproval`) counts the
 * same way on every caller, the sweep included; one for an older head blocks
 * as `infra-approval-stale` so the operator is asked again.
 */
export async function attemptMerge(
  repo: Repo,
  pr: gh.PR,
  opts: { mergedBy?: string; notify?: boolean; infraMergeBy?: string } = {},
): Promise<{ merged: true; infraPaths?: string[] } | MergeRefusal> {
  const mergedBy = opts.mergedBy ?? "auto-merger";
  const notifyBlocks = opts.notify !== false;
  // Set once the PR is known to be human-approved (the stored merge approval);
  // from then on a block is reported on the PR, not only logged (#2971).
  let approved = false;
  const block = async (
    code: MergeSkipCode,
    message: string,
    opts: { level?: "info" | "warn"; notify?: boolean; reason?: string; reportUnapproved?: boolean } = {},
  ): Promise<MergeRefusal> => {
    const line = `[auto-merger] ${repo.fullName}#${pr.number} ${message}`;
    logMergeSkip(repo, pr.number, code, line, opts.level);
    if (notifyBlocks && (approved || opts.reportUnapproved) && opts.notify !== false && opts.reason) {
      await reportMergeBlock(repo, pr, opts.reason, code);
    }
    return { merged: false, code, message: opts.reason ?? message };
  };

  if (gh.isForkPR(pr)) {
    return block("fork", "skipped: fork PR");
  }
  if (await db.hasActiveWorkForPR(repo.fullName, pr.number, MERGE_BLOCKING_AGENT_KINDS)) {
    return block("other-work", "skipped: other work running", {
      notify: false,
      reason: "Claws is still working on this PR (review/CI fix in progress); try again when it finishes.",
    });
  }

  // Everything above is a cheap pre-filter off the (60 s cached) PR list. The
  // sweep is chained off ci-fixer/reviewer completion, so the PR is routinely
  // mutated seconds before this runs — re-read the merge-relevant state live
  // and re-check every gate against it (#2354). PR state comes from the
  // `claws_prs` row, Claws' own store, so a DB read is live; forge state
  // labels are a write-only mirror and never read here.
  const row = await db.getClawsPr(repo.fullName, pr.number);
  if (!row) {
    return block("no-record", "skipped: no claws_prs row", { notify: false });
  }
  if (hasManualAction(row)) {
    // Reported on an approved PR: the forge label is only a mirror, so without
    // this the block would be visible nowhere but the job log.
    approved = isMergeApproved(row);
    return block("manual-action", `skipped: manual action recorded (${row.manualActionReason})`, {
      reason: isEscalationManualAction(row)
        ? `A reviewer escalation is recorded (\`${row.manualActionReason}\`), so Claws will not merge this PR even though the merge is approved. It clears automatically when a later Claws review round is clean or advisory-only — push a fix or reply to the review to trigger one.`
        : `A manual action is recorded on this PR (\`${row.manualActionReason}\`), so Claws will not merge it even though the merge is approved. Once the step is done, clear it with the dashboard's **Clear manual action** button or, from an interactive session, the \`claws_clear_pr_manual_action\` MCP tool; moving the linked issue out of **${LABELS.blocked}** does not lift it.`,
    });
  }
  // A PR's hold slot carries one reason, so a stacked or re-approval hold
  // refused because an operator step was already recorded would be lost once
  // that step is lifted. Check both conditions directly, not through the slot.
  if (pr.headRefName.startsWith("claws/") && pr.baseRefName !== repo.defaultBranch) {
    approved = isMergeApproved(row);
    return block("stacked", `skipped: stacked on ${pr.baseRefName} rather than ${repo.defaultBranch}`, {
      reason: `This PR targets \`${pr.baseRefName}\` rather than \`${repo.defaultBranch}\`, and Claws does not stack PRs, so it will not merge it. Retarget it to \`${repo.defaultBranch}\` or fold its commits into the PR it is stacked on.`,
    });
  }
  const issue = await linkedIssue(repo.fullName, row.issueId, pr.headRefName);
  if (issue && await isPrHeldForReapproval(issue.repo, issue.ref, repo.fullName, pr.number)) {
    approved = isMergeApproved(row);
    return block("reapproval-hold", `skipped: held by the design change on ${issue.repo}#${issue.ref}`, {
      reason: `A design change on ${issue.repo}#${issue.ref} closes or reworks this PR, so Claws will not merge it until the operator promotes the new requirements or approves the issue through **Plan** and, for a reworked PR, the implementer has pushed its new step onto it.`,
    });
  }
  const live = await gh.getPRMergeGate(repo.fullName, pr.number);
  if (live.state !== "OPEN") {
    return block("closed", `skipped: state=${live.state}`);
  }
  if (gh.isDispatchSkippable(repo.fullName, { number: pr.number, labels: live.labels.map((name) => ({ name })) })) {
    return block("dispatch-guard", "skipped: dispatch guard rejected live labels");
  }

  const isDocPR = pr.headRefName.startsWith("claws/docs-");
  const isIdeaCollectionPR = pr.headRefName.startsWith("claws/ideas-collect-");
  const isAutoBump = isAutoBumpPR(pr);
  const isImageScan = isImageScanPR(pr);
  const isMergeApprovedRow = isMergeApproved(row);

  let cachedFiles: string[] | null = null;
  const changedFiles = async (): Promise<string[]> => (cachedFiles ??= await gh.getPRChangedFiles(repo.fullName, pr.number));

  // A clean Claws review of the current head — required of an approved
  // non-exempt PR and of a trusted Renovate PR; never of other exempt PRs. Resolves to a block, or null.
  const requireCleanReview = async (subject: string): Promise<MergeRefusal | null> => {
    const review = await gh.getPRReviewStatus(repo.fullName, pr.number);
    if (review.status !== "clean") {
      return block("review-not-clean", `skipped: ${subject} but review status=${review.status}`, {
        // "none" means no review of the current head has run yet — the same
        // transient, nothing-to-act-on state as "no checks registered yet" (#3122).
        notify: review.status !== "none",
        reason: `The merge approval is set but the Claws review status is \`${review.status}\`, not clean.`,
      });
    }
    const headSha = await gh.getPRHeadSHA(repo.fullName, pr.number);
    if (!review.reviewedCommit || !headSha.startsWith(review.reviewedCommit)) {
      return block("review-stale", `skipped: ${subject} but clean review is stale`, {
        reason: `The merge approval is set but the clean Claws review is for an older commit — a fresh review of the current head is required.`,
      });
    }
    return null;
  };

  // Auto-bump PRs are exempt only while the diff itself passes the structural gate:
  // every changed file a YAML manifest outside .github/, and the whole diff image-pin
  // rewrites only (same image name, new tag or digest — #2777). Refresh the cached
  // verdict with the files read here so isApprovalExempt below reads it. A failing
  // verdict withdraws the exemption, not the merge: with a stored approval the PR
  // takes the ordinary approved path (#clw_01M4RV5WKJT5XQN89BKMN7X8RH).
  const autoBumpVerdict = isAutoBump
    ? await autoBumpGateVerdict(repo.fullName, pr, { knownFiles: await changedFiles(), refresh: true, headSha: live.headSha })
    : null;
  // Image-scan snapshot and prune PRs are exempt only while they are still the
  // generator's output (#clw_01M61EFZ6ZZM8FWGN2PAH3KNZB): refreshed here against
  // the live head and base tip, like the auto-bump verdict.
  const imageScanVerdict = isImageScan
    ? await imageScanGateVerdict(repo.fullName, pr, { knownFiles: await changedFiles(), refresh: true, headSha: live.headSha, baseSha: live.baseSha })
    : null;

  // Exemption is evaluated before the approval branch: a merge approval never
  // adds a review gate to an approval-exempt PR (#clw_01M46YW6WPNPH0545G6KJB1AWD).
  const exempt = await isApprovalExempt(repo.fullName, { ...pr, headRefOid: live.headSha }, row);
  // On an exempt PR `approved` only governs whether a later block is reported.
  approved = isMergeApprovedRow;
  if (exempt) {
    if (await isRenovateExempt(repo.fullName, pr)) {
      // Exempt by author and update type, not by review: it still needs a clean
      // review of the current head, approved or not.
      const blocked = await requireCleanReview("trusted Renovate update");
      if (blocked !== null) return blocked;
    }
    if (isImageScan) {
      // Generated, not reviewed: a clean review of the current head is still required.
      const blocked = await requireCleanReview(isImageScanSnapshotPR(pr) ? "image-scan snapshot refresh" : "image-scan exception prune");
      if (blocked !== null) return blocked;
    }
  } else if (isMergeApprovedRow) {
    const blocked = await requireCleanReview("merge approved");
    if (blocked !== null) return blocked;
  } else {
    // Any PR not exempt (doc, idea-collection, auto-bump, image-scan, trusted
    // non-major Renovate) needs a stored merge approval with a named approver —
    // the only approval Claws accepts (#3135); a forge-applied Automerge label
    // is not one and is never read (#3219).
    if (autoBumpVerdict && !autoBumpVerdict.ok) {
      // The one block reported without an approval: an auto-bump PR looks
      // exempt, so without this the hold would be visible only in the job log.
      // `no-files`, `no-diff` and `pin-scan-failed` stay log-only — they may be transient read failures.
      const { reason } = autoBumpVerdict;
      const what = reason === "not-image-pin-only"
        ? "This auto-bump PR's diff is not an image-pin-only bump (the image name or registry changed, or lines other than the image pin changed)"
        : "This auto-bump PR touches files other than YAML manifests and a registry allowlist append, tag swap, outgoing-tag removal or removal of tags no manifest pins";
      const refusal = await block("auto-bump-gate", `skipped: not approved — ${autoBumpHoldText(reason)}; approve the merge from the Claws dashboard`, {
        notify: reason === "not-image-pin-only" || reason === "non-bump-files",
        reportUnapproved: true,
        reason: `${what}, so the auto-bump exemption does not apply. Merging it needs a merge approval from the Claws dashboard (the PR, or its issue approved through **Merge**); with that approval, a clean Claws review of the current head and green checks, Claws merges it like any other approved PR.`,
      });
      return { ...refusal, autoBumpReason: reason };
    }
    if (imageScanVerdict && !imageScanVerdict.ok) {
      // Reported without an approval, like the auto-bump hold; `no-files` and
      // `unverifiable` stay log-only — they may be transient read failures.
      const holdText = imageScanHoldText(imageScanVerdict);
      const what = imageScanVerdict.kind === "snapshot" ? "This image-scan snapshot refresh" : "This image-scan exception prune";
      return block("image-scan-gate", `skipped: not approved — ${holdText}; approve the merge from the Claws dashboard`, {
        notify: !isTransientImageScanFailure(imageScanVerdict.reason),
        reportUnapproved: true,
        reason: `${what} is held: ${holdText}. The image-scan exemption covers only an unmodified generated PR, so it does not apply. Merging it needs a merge approval from the Claws dashboard (the PR, or its issue approved through **Merge**); with that approval, a clean Claws review of the current head and green checks, Claws merges it like any other approved PR.`,
      });
    }
    const holdReason = await renovateApprovalHoldReason(repo.fullName, pr);
    return block("not-approved", `skipped: not approved — ${holdReason ? `${holdReason}; ` : ""}approve the merge from the Claws dashboard`);
  }

  // Infra (OpenTofu/Terraform) PRs are never auto-merged — merging must be a
  // conscious human action (#2275). This gate outranks a merge approval and every exemption,
  // with one narrow exception: a provider bump whose Tofu plan for this exact
  // head verifiably shows no changes: any author's PR whose diff passes
  // providerBumpDiffVerdict. Such a
  // merge is labelled CLAWS_NOOP_MERGE_LABEL first so production-infra's apply
  // refuses a non-zero plan. A session holding `infra-merge` (`infraMergeBy`)
  // is the human merge itself, as is an operator's board approval for this
  // exact head (#clw_01M5WBG6JZ8P3PCYVCQ3PS9BBS).
  const files = await changedFiles();
  if (files.length === 0 && (pr.changedFiles ?? 0) > 0) {
    // getPRChangedFiles swallows errors and returns []; fail closed rather than
    // auto-merge an unreadable diff that may contain tofu changes.
    return block("unreadable-files", "skipped: could not read changed files", {
      level: "warn",
      reason: "Claws could not read this PR's changed files, so it will not merge it.",
    });
  }
  const infra = gh.infraPathsIn(files);
  // Best-effort removal of a stale no-op merge label so a later human merge is
  // not subject to the apply guard's refusal.
  const dropNoopLabel = async (): Promise<void> => {
    if (!noOpInfraPlan && !pr.labels.some((l) => l.name === CLAWS_NOOP_MERGE_LABEL)) return;
    try {
      await gh.removeLabel(repo.fullName, pr.number, CLAWS_NOOP_MERGE_LABEL);
    } catch (err) {
      log.warn(`[auto-merger] Could not remove ${CLAWS_NOOP_MERGE_LABEL} from ${repo.fullName}#${pr.number}: ${err}`);
    }
  };
  // Set when the no-op plan exception admits this PR: the plan run is itself a
  // check, so "no checks" can never stand in for a green run here.
  let noOpInfraPlan = false;
  // Set when a session's `infra-merge` capability stands in for the human merge.
  let infraMergedPaths: string[] | undefined;
  // Set when an operator's board approval for this head stands in for it.
  let infraMergeApprovedBy: string | undefined;
  const infraApproval = infraMergeApproval(row, live.headSha);
  if (infra.length > 0 && opts.infraMergeBy) {
    const paths = infra.slice(0, 5).join(", ");
    // Even an approval-exempt PR needs a clean review of the head here.
    const blocked = await requireCleanReview("infra merge under session capability");
    if (blocked !== null) return blocked;
    log.info(`[auto-merger] ${repo.fullName}#${pr.number}: infra paths (${paths}) counted as the human merge by ${opts.infraMergeBy} under the infra-merge capability; checking the remaining gates`);
    infraMergedPaths = infra;
  } else if (infra.length > 0 && infraApproval.state === "current") {
    const paths = infra.slice(0, 5).join(", ");
    const blocked = await requireCleanReview("infra merge approved from the board");
    if (blocked !== null) return blocked;
    log.info(`[auto-merger] ${repo.fullName}#${pr.number}: infra paths (${paths}) counted as the human merge by the board approval by ${infraApproval.by} for head ${live.headSha.slice(0, 7)}; checking the remaining gates`);
    infraMergeApprovedBy = infraApproval.by;
  } else if (infra.length > 0) {
    const paths = infra.slice(0, 5).join(", ");
    // A board approval for an older head: every infra block becomes "approve again".
    const staleBlock = (): Promise<MergeRefusal> | null => {
      if (infraApproval.state !== "stale") return null;
      const was = infraApproval.sha ? infraApproval.sha.slice(0, 7) : "an unknown head";
      const now = live.headSha.slice(0, 7);
      return block("infra-approval-stale", `skipped: infra merge approval by ${infraApproval.by} was for ${was}, head is now ${now} (${paths})`, {
        reason: `The infra merge was approved by ${infraApproval.by} for ${was}, but the head is now ${now}. New commits need a fresh approval: approve the infra merge again from the board.`,
      });
    };
    const bump: ProviderBumpVerdict = providerBumpDiffVerdict(files, await gh.getPRDiff(repo.fullName, pr.number));
    if (!bump.ok) {
      await dropNoopLabel();
      const stale = staleBlock();
      if (stale) return stale;
      return block("infra", `skipped: infrastructure changes require a human merge (${paths}); no-op plan exception does not apply: ${bump.reason}`, {
        reason: `Infrastructure changes (${paths}) always need a human merge. The no-op plan exception does not apply: ${bump.reason}.`,
      });
    }
    const sha7 = live.headSha.slice(0, 7);
    const evidence = await gh.getTofuPlanEvidence(repo.fullName, pr.number, live.headSha);
    if (evidence.state !== "noop") await dropNoopLabel();
    if (evidence.state !== "noop") {
      const stale = staleBlock();
      if (stale) return stale;
    }
    if (evidence.state === "changes") {
      const n = evidence.plan ? tofuPlanChangeCount(evidence.plan) : 0;
      return block("infra-plan", `skipped: infrastructure plan shows ${n} change${n === 1 ? "" : "s"}, human merge required (${paths})`, {
        reason: `The Tofu plan for this head shows ${n} change${n === 1 ? "" : "s"}, so a human must merge it.`,
      });
    }
    if (evidence.state !== "noop") {
      return block("infra-plan", `skipped: infrastructure plan not available for head ${sha7} (${evidence.detail})`, { notify: false });
    }
    const blocked = await requireCleanReview("no-op infra plan");
    if (blocked !== null) return blocked;
    log.info(`[auto-merger] ${repo.fullName}#${pr.number}: no-op Tofu plan verified for head ${sha7}; allowing a no-op provider bump merge`);
    noOpInfraPlan = true;
  }
  // A diff CI never runs on (docs/**, Markdown, LICENSE): the one case where a
  // repo with PR-reporting CI may still merge on status=none — the #3051 all-docs
  // PR, a doc PR, or an auto-bump PR whose manifests all sit under docs/.
  const ciExemptOnly = files.length > 0 && files.every(gh.isCiExemptPath);

  // Doc PRs must only contain doc files
  if (isDocPR) {
    const files = await changedFiles();
    const allDocs = files.length > 0 && files.every(
      (f) => f.startsWith("docs/") || f.endsWith(".md"),
    );
    if (!allDocs) {
      return block("doc-pr-mixed", "skipped: doc PR contains non-doc changes", {
        level: "warn",
        reason: "This doc PR contains non-doc changes.",
      });
    }
  }

  // Idea-collection PRs must only contain ideas/ files
  if (isIdeaCollectionPR) {
    const files = await changedFiles();
    const allIdeas = files.length > 0 && files.every(
      (f) => f.startsWith("ideas/"),
    );
    if (!allIdeas) {
      return block("ideas-pr-mixed", "skipped: ideas PR contains non-ideas changes", {
        level: "warn",
        reason: "This ideas PR contains non-ideas changes.",
      });
    }
  }

  let status = live.checkStatus;
  // Set when a settled status=none may stand in for a green run: the repo has
  // no CI that reports on PRs, the whole diff is CI-exempt, or it is an ideas PR.
  let exemptOnNone = false;
  if (status === "none") {
    const sha7 = live.headSha.slice(0, 7);
    // A brand-new head SHA has no check runs registered for the first minute or
    // two. Treating that as "this repo has no CI" is how #2354 merged a red PR:
    // the ci-fixer pushed a merge-base commit at 08:32:42 and the sweep merged
    // at 08:32:59, 10 s after the first check run for the new head even started.
    const { settled, age } = await gh.haveChecksSettled(repo.fullName, live.headSha);
    if (!settled) {
      return block("checks-pending", `skipped: no checks yet on head ${sha7} (age ${age}), waiting for CI to register`, {
        notify: false,
        reason: `CI has not reported on head \`${sha7}\` yet — waiting for it to register.`,
      });
    }
    // A settled head is not proof of "no CI": the settle window counts from the
    // committer date, so an agent commit pushed late looks settled at once, and
    // a push-filtered workflow may never start (PR #105 merged that way). Only
    // a repo with no PR-reporting CI, or a diff CI never runs on, accepts none.
    const ciExpected = await gh.repoExpectsCi(repo.fullName);
    exemptOnNone = !ciExpected || ciExemptOnly || isIdeaCollectionPR;
    // Head is docs-only on top of a commit CI already validated (#2929):
    // carry that result forward rather than treating the PR as unchecked.
    // Skip the check entirely when the PR is already exempt on "none" —
    // its result would be thrown away.
    const carried = exemptOnNone ? "none" : await gh.carriedForwardCheckStatus(repo.fullName, pr.number);
    if (carried !== "none") {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number}: head ${sha7} has no checks but every commit since the last CI-validated commit is CI-exempt — carrying its ${carried} status forward`);
      status = carried;
    }
    if (exemptOnNone) {
      const why = !ciExpected ? "this repo has no CI that reports on pull requests" : ciExemptOnly ? "every changed file is CI-exempt" : "it is an ideas-collection PR";
      log.info(`[auto-merger] ${repo.fullName}#${pr.number}: no checks on head ${sha7} but ${why} — accepting status=none`);
    }
  }

  const checksHeld = live.checksHeld;

  // A doc PR is all-docs, so ciExemptOnly covers it; a merge approval gets
  // no bypass of its own — an approval is not a CI result.
  const checksOk = status === "passing" || (!noOpInfraPlan && exemptOnNone && status === "none");
  if (!checksOk) {
    if (status === "none") {
      const sha7 = live.headSha.slice(0, 7);
      if (noOpInfraPlan) {
        return block("checks-missing", `skipped: no CI result on head ${sha7} of an infra plan PR`, {
          reason: `CI has not reported on head \`${sha7}\` — a Tofu plan PR needs a reported CI run before it can merge.`,
        });
      }
      return block("checks-missing", `skipped: no CI result on settled head ${sha7} or any earlier commit it carries, and this repo's CI reports on PRs`, {
        reason: `CI has not reported on head \`${sha7}\` — no commit statuses or check runs exist for it or for any earlier commit in this PR whose code it carries, and this repo's CI normally reports on pull requests. Claws will merge once CI reports green; push a new commit to start a run, or set \`mergeWithoutChecks: true\` in \`claws.json\` if this repo's CI never runs on pull requests.`,
      });
    }
    if (status === "failing") {
      return block("checks-failed", "skipped: checks failed", { level: "warn", reason: "CI is failing." });
    }
    // Reserved: Forgejo has no approval hold, so no reader reports `held` today.
    if (status === "held") {
      const runs = `${checksHeld} workflow run${checksHeld === 1 ? "" : "s"}`;
      return block("checks-held", `skipped: ${runs} held for approval`, {
        reason: `${runs} on the head commit ${checksHeld === 1 ? "is" : "are"} held for approval — not a CI failure. A human has to approve the runs.`,
      });
    }
    return block("checks-pending", `skipped: checks status=${status}`, {
      reason: `CI status is \`${status}\` — waiting for it to finish.`,
    });
  }

  const conflictReason = `This branch has merge conflicts with \`${pr.baseRefName}\` — the ci-fixer will try to resolve them.`;
  let mergeState = live.mergeable;
  if (mergeState === "CONFLICTING") {
    return block("conflict", "has merge conflicts, skipping (ci-fixer will resolve)", { reason: conflictReason });
  }
  if (mergeState === "UNKNOWN") {
    // The forge computes mergeability asynchronously; retry before giving up.
    mergeState = await gh.getPRMergeableState(repo.fullName, pr.number);
    if (mergeState === "CONFLICTING") {
      return block("conflict", "has merge conflicts, skipping (ci-fixer will resolve)", { reason: conflictReason });
    }
    if (mergeState !== "MERGEABLE") {
      return block("mergeable-unknown", "mergeable state still UNKNOWN after retries, skipping", { notify: false });
    }
  }

  gh.populateQueueCache("auto-mergeable", repo.fullName, { number: pr.number, title: pr.title, type: "pr", updatedAt: pr.updatedAt, priority: gh.hasPriorityLabel(pr.labels), labels: pr.labels.map((l) => l.name) });
  if (noOpInfraPlan) {
    // production-infra's merge-time apply refuses any non-zero plan for a PR
    // carrying this label; without it the guard cannot fire, so fail closed.
    try {
      await gh.ensureLabel(repo.fullName, CLAWS_NOOP_MERGE_LABEL, {
        color: "5319e7",
        description: "Auto-merged by Claws on a verified no-op Tofu plan; tofu-apply refuses any non-zero plan",
      });
      await gh.addLabel(repo.fullName, pr.number, CLAWS_NOOP_MERGE_LABEL);
    } catch (err) {
      return block("error", `skipped: could not label the PR for the no-op apply guard (${err})`, { level: "warn", notify: false });
    }
  }
  log.info(`[auto-merger] Merging ${repo.fullName}#${pr.number} (status=${status} mergeState=${mergeState}): ${pr.title}`);
  try {
    await gh.mergePR(repo.fullName, pr.number, live.headSha);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("not mergeable") ||
      msg.includes("Pull Request is not mergeable") ||
      /head branch was modified/i.test(msg) ||
      /match-head-commit|head sha did not match|does not match/i.test(msg)
    ) {
      gh.removeQueueItem(repo.fullName, pr.number);
      if (noOpInfraPlan) await dropNoopLabel();
      return block("head-moved", "head moved or was not mergeable at merge time, skipping", { notify: false });
    }
    if (noOpInfraPlan) await dropNoopLabel();
    throw err;
  }
  gh.setMergeBlockReason(repo.fullName, pr.number, null);
  await setInfraGate(repo, pr, undefined);
  try {
    const task = await db.findLatestCompletedTaskForPrHead(repo.fullName, pr.number, live.headSha);
    if (task) {
      await db.recordTaskEffectivenessEvent({
        taskId: task.id,
        source: "pr-merge",
        sourceRepo: repo.fullName,
        sourceNumber: pr.number,
        sourceSha: live.headSha,
        signal: "pr-merged",
        score: null,
        details: {
          mergedBy,
          ...(infraMergedPaths ? { infraMergeCapability: true } : {}),
          ...(infraMergeApprovedBy ? { infraMergeApprovedBy } : {}),
        },
      });
    } else {
      log.info(`[auto-merger] No completed producer task found for ${repo.fullName}#${pr.number} head ${live.headSha.slice(0, 12)}; skipping merge effectiveness signal`);
    }
  } catch (err) {
    log.warn(`[auto-merger] Could not record merge effectiveness for ${repo.fullName}#${pr.number}: ${err}`);
  }
  gh.removeQueueItem(repo.fullName, pr.number);
  await announcePostMergeAction(repo, pr);

  // The PR is merged; a cleanup failure must not turn that into a thrown error.
  try {
    await finalizeMergedClawsPR(repo, pr, mergedBy);
  } catch (err) {
    log.warn(`[auto-merger] Post-merge finalize failed for ${repo.fullName}#${pr.number}: ${err}`);
  }

  return infraMergedPaths ? { merged: true, infraPaths: infraMergedPaths } : { merged: true };
}

/**
 * Post-merge cleanup for a merged `claws/issue-…` PR, regardless of which route
 * merged it (auto-merger, dashboard, or a human merging directly, which the PR
 * dispatcher's `refreshPrStore` catches): close a multi-PR issue whose every
 * step has now landed, then honour any `Closes #clw_…` line for Claws-native
 * issues. Idempotent — safe to call more than once for the same PR.
 */
export async function finalizeMergedClawsPR(
  repo: Repo,
  pr: Pick<gh.PR, "number" | "headRefName" | "body"> & { title?: string },
  source: string,
): Promise<void> {
  const match = pr.headRefName.match(ISSUE_BRANCH_RE);
  const issueRef = match ? canonicalIssueRef(match[1]!) : null;
  const phases = issueRef !== null ? await loadMergedIssuePhases(repo, pr, issueRef, source) : null;
  if (issueRef !== null && phases?.kind === "multi") {
    // Only a step opened when every other step had already landed carries
    // `Closes`; steps of a parallel plan can merge in any order, so the one that
    // completes the plan may not be that PR. The issue-auditor's `done`
    // classification is the backstop.
    // A plan with a manual-actions section ends on an operator step instead:
    // the issue stays open, and the operator is told once what remains.
    if (await closeIssueIfPlanComplete(phases.issueRepo, issueRef, phases.state, { source, last: `${repo.fullName}#${pr.number}` }) !== "closed") {
      await announceAwaitingOperator(phases, issueRef, source);
    }
  }

  const rereadBody = await closeNativeIssuesClosedBy(repo, pr, source);

  // A single-step plan's PR has merged. If the issue is still open — its PR
  // said `Part of`, or the forge did not act on `Closes` — it must not fall
  // back to Planning: close it when a merged PR closes it, else park it for a
  // human (#clw_01M4EPRM9SYVGFG2BTZTMQEKDJ).
  if (issueRef !== null && phases?.kind === "single") {
    try {
      // The body `closeNativeIssuesClosedBy` just re-read, else a re-read: the
      // sweep's copy may be stale.
      const body = rereadBody ?? await gh.getPRBody(repo.fullName, pr.number);
      // A PR that closes the issue is already handled — by the forge, or above
      // for a native issue.
      if (extractClosedIssueRefs(body).some((ref) => sameIssueRef(ref, issueRef))) return;
      const merged = await gh.listMergedPRsForIssue(phases.issueRepo, issueRef);
      const byNumber = new Map<number, { number: number; body?: string }>(merged.map((m) => [m.number, m]));
      byNumber.set(pr.number, { number: pr.number, body });
      await settleMergedSingleStep(phases.issueRepo, issueRef, [...byNumber.values()]);
    } catch (err) {
      log.warn(`[${source}] Could not settle issue ${issueRef} after merging its single-step PR ${repo.fullName}#${pr.number}: ${err}`);
    }
  }
}

/**
 * The phase state of the issue a merged PR belongs to, read from the issue's
 * own repo: the PR's repo for a forge ref, the primary repo for a native id
 * (whose steps may be in any of its repos). `kind: "single"` when the plan has
 * at most one phase — the ordinary case, with no coverage read: the caller
 * then skips closing a multi-PR issue for this merge and settles the single
 * step instead. Null when the load failed (logged), which the caller must
 * not read as either; this runs on every merge and must never throw out of
 * the merge path.
 *
 * `mergedPRs` seeds in `pr` itself, deduplicated by number against the
 * dedicated read, whenever the caller knows its title: that read is a lagging
 * search index, and without this a phase state read immediately after the
 * merge can still show `pr` as open. A caller with no title on hand (a
 * reconciled row, whose merge this function only learns about on a later
 * tick, well after the search index has caught up) relies on the dedicated
 * read alone.
 *
 * Returns the issue comments and plan text it read too, for the caller's
 * awaiting-operator marker check.
 */
async function loadMergedIssuePhases(
  repo: Repo,
  pr: Pick<gh.PR, "number" | "body"> & { title?: string },
  issueRef: IssueRef,
  source: string,
): Promise<{ kind: "multi"; issueRepo: string; state: IssuePhaseState; comments: gh.IssueComment[]; planText: string | null } | { kind: "single"; issueRepo: string } | null> {
  try {
    let issueRepo = repo.fullName;
    if (isClawsIssueId(issueRef)) {
      const record = await clawsIssues.getIssue(issueRef);
      if (!record || record.repos.length === 0) return null;
      issueRepo = clawsIssues.primaryRepo(record);
    }
    const comments = await gh.getIssueComments(issueRepo, issueRef);
    const planText = planParser.findPlanComment(comments);
    const { totalPhases, stored } = await peekTotalPhases(issueRepo, issueRef, planText);
    if (totalPhases <= 1) return { kind: "single", issueRepo };
    const merged = await gh.listMergedPRsForIssue(issueRepo, issueRef);
    const byNumber = new Map<number, { number: number; title: string; body?: string }>(merged.map((m) => [m.number, m]));
    if (pr.title !== undefined) byNumber.set(pr.number, { number: pr.number, title: pr.title, body: pr.body });
    const state = await loadIssuePhaseState(issueRepo, issueRef, comments, { planText, stored, mergedPRs: [...byNumber.values()] });
    return { kind: "multi", issueRepo, state, comments, planText };
  } catch (err) {
    log.warn(`[${source}] Could not load phase state for issue ${issueRef} after merging ${repo.fullName}#${pr.number}: ${err}`);
    return null;
  }
}

/**
 * Close the Claws-native issues a merged PR says it closes.
 *
 * GitHub does this itself for its own issues, but a `Closes #clw_01JBQ…` in a
 * GitHub or Forgejo PR body points at nothing the forge knows about, so the
 * merger has to honour it. `issue-auditor` covers the same ground for PRs
 * merged by hand.
 *
 * The body is re-read rather than taken from `pr`: the merge sweep's `pr` is a
 * 60 s-cached copy, and a body edited between the sweep's read and the merge
 * would close the wrong issue — or miss the right one. A caller with no cached
 * body at all (`undefined`, e.g. the dashboard or hand-merge paths) always
 * re-reads rather than risk skipping a `Closes #clw_…` it never had a chance to see.
 *
 * Returns the body it re-read, or null when it read none.
 */
async function closeNativeIssuesClosedBy(
  repo: Repo,
  pr: Pick<gh.PR, "number" | "headRefName" | "body">,
  source = "auto-merger",
): Promise<string | null> {
  // Cheap guard before the extra round trip: every merged PR reaches here —
  // Dependabot bumps, image bumps, hand-written PRs — and most never mention a
  // native issue at all. Claws' own `claws/issue-…` PRs always re-read, since
  // those are exactly the bodies an agent rewrites between the sweep and the
  // merge; for anything else, a cached body with no `clw_` in it is enough to
  // decide there is nothing to do.
  if (!pr.headRefName.startsWith("claws/issue-") && typeof pr.body === "string" && !/clw_/i.test(pr.body)) return null;
  let body: string;
  try {
    body = await gh.getPRBody(repo.fullName, pr.number);
  } catch (err) {
    log.warn(`[${source}] Could not re-read ${repo.fullName}#${pr.number} body to close native issues: ${err}`);
    return null;
  }
  for (const ref of extractClosedIssueRefs(body)) {
    if (!isClawsIssueId(ref)) continue;
    try {
      // Ownership check: only a repo the native issue names may close it — a
      // multi-repo plan's last PR carries the `Closes`, whichever of the
      // issue's repos it is in. Anything else — already closed, unassigned, or
      // another repo's — is left alone and logged.
      const issue = await clawsIssues.getIssue(ref);
      if (!issue) {
        log.warn(`[${source}] ${repo.fullName}#${pr.number} names unknown native issue ${ref}`);
        continue;
      }
      if (issue.state !== "open") continue;
      // A shadow is the hidden native record of an issue that is still live on
      // a forge (#3246). Closing it would hide the row without touching the
      // issue the PR actually closes, so a `Closes #clw_…` naming one is
      // ignored — the forge closes its own issue from the same line.
      if (issue.kind !== "issue") {
        log.info(`[${source}] Leaving native issue ${ref} open: it is a shadow of a live forge issue`);
        continue;
      }
      if (!issue.repos.includes(repo.fullName)) {
        log.info(`[${source}] Leaving native issue ${ref} open: ${repo.fullName} is not among its repos ${JSON.stringify(issue.repos)}`);
        continue;
      }
      await gh.closeIssue(repo.fullName, ref, "completed");
      log.info(`[${source}] Closed native issue ${ref} from ${repo.fullName}#${pr.number}`);
    } catch (err) {
      log.warn(`[${source}] Could not close native issue ${ref} from ${repo.fullName}#${pr.number}: ${err}`);
    }
  }
  return body;
}
