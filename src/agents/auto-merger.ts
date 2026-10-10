import { isEscalationManualAction } from "../pr-escalation.js";
import { LABELS, prUrl, isClawsIssueId, isForgejoRepo, type Repo } from "../config.js";
import { AGENT_KINDS } from "../worker.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import * as slack from "../slack.js";
import * as db from "../db.js";
import { guardContent } from "../prompt-guard.js";
import { POST_MERGE_ACTION_HEADING, extractPostMergeActionSection, isVerificationOnlyAction } from "./issue-worker.js";
import { extractClosedIssueRefs } from "../phase-coverage.js";
import * as clawsIssues from "../claws-issues.js";
import { ISSUE_REF_PATTERN, canonicalIssueRef, sameIssueRef, type IssueRef } from "../issue-id.js";
import { closeIssueIfPlanComplete, loadIssuePhaseState, peekTotalPhases, type IssuePhaseState } from "../planned-prs.js";
import * as planParser from "../plan-parser.js";
import { settleMergedSingleStep } from "../issue-handback.js";
import { hasManualAction, isMergeApproved, isReviewedHeadAwaitingMerge, needsHumanReview } from "../pr-state.js";
import { isAutoBumpPR } from "../dependency-prs.js";
import { isRenovateMajorUpdate, isTrustedRenovatePR, renovateApprovalHoldReason } from "../renovate.js";
import { recordHeldRuns } from "../workflow-hold.js";
import { isInfraPinOnly, tofuPlanChangeCount } from "../tofu-plan.js";

const ISSUE_BRANCH_RE = new RegExp(`^claws/issue-(${ISSUE_REF_PATTERN})-`);

export { isAutoBumpPR } from "../dependency-prs.js";

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

/**
 * True when the PR may be auto-merged without a stored merge approval
 * (dependabot, docs, ideas-collection, auto-bump, and trusted non-major
 * Renovate — see `isRenovateExempt`).
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
    gh.isDependabotPR(pr) ||
    pr.headRefName.startsWith("claws/docs-") ||
    pr.headRefName.startsWith("claws/ideas-collect-") ||
    isAutoBumpPR(pr) ||
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

/** An `image:`/`newTag:` pin line — captures the prefix (indent + optional "- " + key) and value. */
const PIN_LINE = /^(\s*(?:-\s+)?(?:image|newTag):\s*)(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/;

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

/** True when every hunk of a manifest section is a same-name image:/newTag: re-pin. */
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
 * line is an image:/newTag: pin whose image name is unchanged and whose tag or
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

/** The LAN registry's tag allowlist file that fleet-infra's bump workflows append to or swap the outgoing tag in. */
const REGISTRY_ALLOWLIST_PATH = "apps/registry/config.json";

/** `^tag$` with every "." escaped, as a JSON string literal (backslash doubled). */
function allowlistEntry(tag: string): string {
  return `"^${tag.replace(/\./g, "\\\\.")}$"`;
}

/**
 * True when a registry-config diff section either appends one anchored allowlist
 * entry for a tag in `newTags` — optionally with the trailing-comma fix on the
 * previous last entry — or swaps the entry for a tag in `oldTags` for the entry of
 * a tag in `newTags` (same trailing-comma state). Anything else (other removals,
 * other keys, other patterns) fails.
 */
export function isRegistryAllowlistBump(
  section: DiffSection,
  newTags: readonly string[],
  oldTags: readonly string[],
): boolean {
  if (section.path !== REGISTRY_ALLOWLIST_PATH) return false;
  if (section.hunks.length === 0) return false;
  const expected = new Set(newTags.map(allowlistEntry));
  const entryLine = /^\s*("\^[^"]*\$")\s*,?\s*$/;
  const bareEntry = /^\s*"\^[^"]*\$"\s*$/;
  const removed = section.hunks.flatMap((h) => h.removed);
  const added = section.hunks.flatMap((h) => h.added);
  if (removed.length > 1) return false;
  if (removed.length === 1 && added.length === 1) {
    const r = entryLine.exec(removed[0]);
    const a = entryLine.exec(added[0]);
    if (
      r &&
      a &&
      removed[0].trim().endsWith(",") === added[0].trim().endsWith(",") &&
      r[1] !== a[1] &&
      oldTags.map(allowlistEntry).includes(r[1]) &&
      expected.has(a[1])
    ) {
      return true;
    }
  }
  if (removed.length === 1) {
    // Comma-fix: removed `X`, added `X,`.
    if (!bareEntry.test(removed[0])) return false;
    const idx = added.findIndex((l) => l.trim() === `${removed[0].trim()},`);
    if (idx < 0) return false;
    added.splice(idx, 1);
  }
  if (added.length !== 1) return false;
  const m = entryLine.exec(added[0]);
  return !!m && expected.has(m[1]);
}

/** Why an auto-bump PR's diff does not clear the structural gate: `checkAutoBumpDiff`'s failure reasons. */
export type AutoBumpDiffFailure = "no-files" | "non-bump-files" | "not-image-pin-only";

/**
 * The auto-bump structural gate: every changed file must be a YAML manifest
 * outside `.github/` (plus optionally the registry allowlist file); manifest diffs
 * must be image-pin rewrites only (same image name, new tag or digest), and the
 * allowlist file may only gain one anchored entry for a bumped-to tag or swap the
 * outgoing tag's entry for the bumped-to tag's. Shared by `tryMerge` (the merge gate itself)
 * and the PR dispatcher (which skips the model review for a PR this gate would
 * already accept without approval). `knownFiles`, when passed, is used instead
 * of a second `getPRChangedFiles` call — the diff is only fetched once the file
 * check passes.
 */
export async function checkAutoBumpDiff(
  repoFullName: string,
  prNumber: number,
  knownFiles?: readonly string[],
): Promise<{ ok: true } | { ok: false; reason: AutoBumpDiffFailure }> {
  const files = knownFiles ?? (await gh.getPRChangedFiles(repoFullName, prNumber));
  if (files.length === 0) return { ok: false, reason: "no-files" };
  const isManifest = (f: string) => /\.ya?ml$/.test(f) && !f.startsWith(".github/") && !f.includes("/.github/");
  if (!files.every((f) => isManifest(f) || f === REGISTRY_ALLOWLIST_PATH)) return { ok: false, reason: "non-bump-files" };
  const diff = await gh.getPRDiff(repoFullName, prNumber);
  const sections = parseDiffSections(diff);
  if (!sections) return { ok: false, reason: "not-image-pin-only" };
  const manifests = sections.filter((sec) => sec.path !== REGISTRY_ALLOWLIST_PATH);
  const configs = sections.filter((sec) => sec.path === REGISTRY_ALLOWLIST_PATH);
  if (manifests.length === 0 || !manifests.every(isPinOnlySection)) return { ok: false, reason: "not-image-pin-only" };
  if (configs.length > 1) return { ok: false, reason: "non-bump-files" };
  if (
    configs.length === 1 &&
    !isRegistryAllowlistBump(configs[0], manifests.flatMap(bumpedToTags), manifests.flatMap(bumpedFromTags))
  ) {
    return { ok: false, reason: "non-bump-files" };
  }
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
    const guarded = guardContent(note, { repo: repo.fullName, source: "pr-post-merge-action", itemNumber: pr.number });
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
export const AWAITING_OPERATOR_MARKER = "claws-awaiting-operator";

/**
 * Every PR step of the issue's plan has merged but its manual (operator) step
 * is still open: say so once on the issue, with the plan's manual-actions
 * section and how to finish, and ping Slack. Skipped when a Claws comment
 * already carries {@link AWAITING_OPERATOR_MARKER}. Never throws.
 */
async function announceAwaitingOperator(
  phases: { issueRepo: string; state: IssuePhaseState; comments: gh.IssueComment[]; planText: string | null },
  issueRef: IssueRef,
  source: string,
): Promise<void> {
  const { issueRepo, state, comments, planText } = phases;
  const step = state.coverage.awaitingOperator[0];
  if (step === undefined || !state.entries) return;
  const prSteps = state.entries.filter((e) => e.kind !== "manual");
  if (!prSteps.every((e) => state.coverage.done.has(e.position))) return;
  if (comments.some((c) => gh.isClawsComment(c.body) && c.body.includes(AWAITING_OPERATOR_MARKER))) return;
  try {
    const entry = state.entries.find((e) => e.position === step);
    const section = planText ? planParser.findManualActionsSection(planText) : null;
    const body = [
      `Every PR of the plan has merged. Operator step ${step} remains${entry ? ` (${entry.title})` : ""}:`,
      "",
      section?.body || "_See the plan's manual-actions section._",
      "",
      `Comment \`claws-phase-done: ${step}\` when done, or close the issue.`,
      "",
      AWAITING_OPERATOR_MARKER,
    ].join("\n");
    await gh.commentOnIssue(issueRepo, issueRef, body, { agentName: "Auto Merger" });
    await slack.notify(`:construction_worker: [${source}] ${issueRepo}#${issueRef}: every PR has merged — operator step ${step}${entry ? ` (${entry.title})` : ""} remains before the issue can close`);
    log.info(`[${source}] ${issueRepo}#${issueRef}: every PR merged, awaiting operator step ${step}`);
  } catch (err) {
    log.warn(`[${source}] Could not announce the operator step for ${issueRepo}#${issueRef}: ${err}`);
  }
}

/** Marker identifying the single, edited-in-place "Merge blocked" comment on a PR. */
export const MERGE_STATUS_MARKER = "claws-merge-status";

/**
 * Tell the humans on an approved PR why it did not merge: one comment carrying
 * MERGE_STATUS_MARKER, edited in place and left alone when the text is
 * unchanged, plus the in-memory reason the dashboard renders (#2971). Never
 * throws — a reporting failure must not abort a sweep.
 */
async function reportMergeBlock(repo: Repo, pr: gh.PR, message: string): Promise<void> {
  try {
    gh.setMergeBlockReason(repo.fullName, pr.number, message);
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

/** Repos with a sweep in flight — the scheduler job and a chained queue row must not overlap. */
const sweepsInFlight = new Set<string>();

/**
 * Evaluate every open PR in `repo` for merge. A PR merged by hand is closed
 * out by the PR dispatcher's `refreshPrStore`, not here. Run by the
 * `auto-merger` scheduler job and by chained `auto-merger:sweep` queue rows
 * (#2971).
 */
export async function sweepRepo(repo: Repo): Promise<void> {
  if (sweepsInFlight.has(repo.fullName)) return;
  sweepsInFlight.add(repo.fullName);
  try {
    // The sweep is chained off ci-fixer/reviewer completion, so the 60 s PR-list
    // cache may still hold labels captured before that agent mutated the PR (#2354).
    gh.invalidatePRList(repo.fullName);
    const prs = await gh.listPRs(repo.fullName);
    const skipKinds = [
      AGENT_KINDS.CI_FIXER,
      AGENT_KINDS.CI_FIXER_CONFLICT,
      AGENT_KINDS.REVIEW_ADDRESSER,
      AGENT_KINDS.PR_REVIEWER,
    ];
    for (const pr of prs) {
      if (gh.isDispatchSkippable(repo.fullName, pr)) continue;
      if (await db.hasActiveWorkForPR(repo.fullName, pr.number, skipKinds)) {
        log.info(`[auto-merger] sweep: skipping ${repo.fullName}#${pr.number} — other work running`);
        continue;
      }
      try {
        await tryMerge(repo, pr);
      } catch (err) {
        log.warn(`[auto-merger] sweep: tryMerge failed for ${repo.fullName}#${pr.number}: ${err}`);
      }
    }
  } finally {
    sweepsInFlight.delete(repo.fullName);
  }
}

/** Attempt to merge a single PR if it meets all merge criteria. Returns true if merged. */
export async function tryMerge(repo: Repo, pr: gh.PR): Promise<boolean> {
  // Set once the PR is known to be human-approved (the stored merge approval);
  // from then on a block is reported on the PR, not only logged (#2971).
  let approved = false;
  const block = async (
    message: string,
    opts: { level?: "info" | "warn"; notify?: boolean; reason?: string } = {},
  ): Promise<false> => {
    const line = `[auto-merger] ${repo.fullName}#${pr.number} ${message}`;
    if (opts.level === "warn") log.warn(line);
    else log.info(line);
    if (approved && opts.notify !== false && opts.reason) {
      await reportMergeBlock(repo, pr, opts.reason);
    }
    return false;
  };

  if (gh.isForkPR(pr)) {
    return block("skipped: fork PR");
  }

  // Everything above is a cheap pre-filter off the (60 s cached) PR list. The
  // sweep is chained off ci-fixer/reviewer completion, so the PR is routinely
  // mutated seconds before this runs — re-read the merge-relevant state live
  // and re-check every gate against it (#2354). PR state comes from the
  // `claws_prs` row, Claws' own store, so a DB read is live; forge state
  // labels are a write-only mirror and never read here.
  const row = await db.getClawsPr(repo.fullName, pr.number);
  if (!row) {
    return block("skipped: no claws_prs row", { notify: false });
  }
  if (hasManualAction(row)) {
    // Reported on an approved PR: the forge label is only a mirror, so without
    // this the block would be visible nowhere but the job log.
    approved = isMergeApproved(row);
    return block(`skipped: manual action recorded (${row.manualActionReason})`, {
      reason: isEscalationManualAction(row)
        ? `A reviewer escalation is recorded (\`${row.manualActionReason}\`), so Claws will not merge this PR even though the merge is approved. It clears automatically when a later Claws review round is clean or advisory-only — push a fix or reply to the review to trigger one.`
        : `A manual action is recorded on this PR (\`${row.manualActionReason}\`), so Claws will not merge it even though the merge is approved. Once the step is done, clear it with the dashboard's **Clear manual action** button or, from an interactive session, the \`claws_clear_pr_manual_action\` MCP tool. Removing the **${LABELS.manualAction}** label on the forge does not clear it — Claws restores the label.`,
    });
  }
  const live = await gh.getPRMergeGate(repo.fullName, pr.number);
  if (live.state !== "OPEN") {
    return block(`skipped: state=${live.state}`);
  }
  if (gh.isDispatchSkippable(repo.fullName, { number: pr.number, labels: live.labels.map((name) => ({ name })) })) {
    return block("skipped: dispatch guard rejected live labels");
  }

  const isDependabot = gh.isDependabotPR(pr);
  const isDocPR = pr.headRefName.startsWith("claws/docs-");
  const isIdeaCollectionPR = pr.headRefName.startsWith("claws/ideas-collect-");
  const isAutoBump = isAutoBumpPR(pr);
  const isAutomerge = isMergeApproved(row);

  let cachedFiles: string[] | null = null;
  const changedFiles = async (): Promise<string[]> => (cachedFiles ??= await gh.getPRChangedFiles(repo.fullName, pr.number));

  // A clean Claws review of the current head — required of an approved
  // non-exempt PR and of a trusted Renovate PR; never of other exempt PRs. Resolves to a block, or null.
  const requireCleanReview = async (subject: string): Promise<false | null> => {
    const review = await gh.getPRReviewStatus(repo.fullName, pr.number);
    if (review.status !== "clean") {
      return block(`skipped: ${subject} but review status=${review.status}`, {
        // "none" means no review of the current head has run yet — the same
        // transient, nothing-to-act-on state as "no checks registered yet" (#3122).
        notify: review.status !== "none",
        reason: `The merge approval is set but the Claws review status is \`${review.status}\`, not clean.`,
      });
    }
    const headSha = await gh.getPRHeadSHA(repo.fullName, pr.number);
    if (!review.reviewedCommit || !headSha.startsWith(review.reviewedCommit)) {
      return block(`skipped: ${subject} but clean review is stale`, {
        reason: `The merge approval is set but the clean Claws review is for an older commit — a fresh review of the current head is required.`,
      });
    }
    return null;
  };

  // Exemption is evaluated before the approval branch: a merge approval never
  // adds a review gate to an approval-exempt PR (#clw_01M46YW6WPNPH0545G6KJB1AWD).
  const exempt = await isApprovalExempt(repo.fullName, pr, row);
  // On an exempt PR `approved` only governs whether a later block is reported.
  approved = isAutomerge;
  if (exempt) {
    if (await isRenovateExempt(repo.fullName, pr)) {
      // Exempt by author and update type, not by review: it still needs a clean
      // review of the current head, approved or not.
      const blocked = await requireCleanReview("trusted Renovate update");
      if (blocked !== null) return blocked;
    }
  } else if (isAutomerge) {
    const blocked = await requireCleanReview("merge approved");
    if (blocked !== null) return blocked;
  } else {
    // Any PR not exempt (dependabot, doc, idea-collection, auto-bump, trusted
    // non-major Renovate) needs a stored merge approval with a named approver —
    // the only approval Claws accepts (#3135); a forge-applied Automerge label
    // is not one and is never read (#3219).
    const holdReason = await renovateApprovalHoldReason(repo.fullName, pr);
    return block(`skipped: not approved — ${holdReason ? `${holdReason}; ` : ""}approve the merge from the Claws dashboard`);
  }

  // Infra (OpenTofu/Terraform) PRs are never auto-merged — merging must be a
  // conscious human action (#2275). This gate outranks Automerge and every exemption,
  // with one narrow exception: a trusted dependency PR (Dependabot or trusted
  // non-major Renovate) whose every file is a provider pin, and whose Tofu Plan
  // run for this exact head succeeded and verifiably shows no changes.
  const files = await changedFiles();
  if (files.length === 0 && (pr.changedFiles ?? 0) > 0) {
    // getPRChangedFiles swallows errors and returns []; fail closed rather than
    // auto-merge an unreadable diff that may contain tofu changes.
    return block("skipped: could not read changed files", {
      level: "warn",
      reason: "Claws could not read this PR's changed files, so it will not merge it.",
    });
  }
  const infra = gh.infraPathsIn(files);
  // Set when the no-op plan exception admits this PR: the plan run is itself a
  // check, so "no checks" can never stand in for a green run here.
  let noOpInfraPlan = false;
  if (infra.length > 0) {
    const paths = infra.slice(0, 5).join(", ");
    const pinOnlyDependencyPR = !isForgejoRepo(repo.fullName)
      && isInfraPinOnly(files)
      && (isDependabot || await isRenovateExempt(repo.fullName, pr));
    if (!pinOnlyDependencyPR) {
      return block(`skipped: infrastructure changes require a human merge (${paths})`, {
        reason: `Infrastructure changes (${paths}) always need a human merge.`,
      });
    }
    const sha7 = live.headSha.slice(0, 7);
    const evidence = await gh.getTofuPlanEvidence(repo.fullName, pr.number, live.headSha);
    if (evidence.state === "changes") {
      const n = evidence.plan ? tofuPlanChangeCount(evidence.plan) : 0;
      return block(`skipped: infrastructure plan shows ${n} change${n === 1 ? "" : "s"}, human merge required (${paths})`, {
        reason: `The Tofu plan for this head shows ${n} change${n === 1 ? "" : "s"}, so a human must merge it.`,
      });
    }
    if (evidence.state !== "noop") {
      return block(`skipped: infrastructure plan not available for head ${sha7} (${evidence.detail})`, { notify: false });
    }
    const blocked = await requireCleanReview("no-op infra plan");
    if (blocked !== null) return blocked;
    log.info(`[auto-merger] ${repo.fullName}#${pr.number}: no-op Tofu plan verified for head ${sha7}; allowing a trusted dependency merge`);
    noOpInfraPlan = true;
  }
  // Since #3135 the #3051 case — a human accepting "no checks" on an all-docs diff —
  // arrives as **Automerge**, which is already allowlisted on status=none below. What
  // is left for this flag is the one approval-exempt category that is not: an auto-bump
  // PR whose manifests all sit under docs/ (a `.yaml` that is also a CI-exempt path).
  const ciExemptOnly = files.length > 0 && files.every(gh.isCiExemptPath);

  // Doc PRs must only contain doc files
  if (isDocPR) {
    const files = await changedFiles();
    const allDocs = files.length > 0 && files.every(
      (f) => f.startsWith("docs/") || f.endsWith(".md"),
    );
    if (!allDocs) {
      return block("skipped: doc PR contains non-doc changes", {
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
      return block("skipped: ideas PR contains non-ideas changes", {
        level: "warn",
        reason: "This ideas PR contains non-ideas changes.",
      });
    }
  }

  // Auto-bump PRs merge with no human approval, so the diff itself is the gate: every
  // changed file must be a YAML manifest outside .github/, and the whole diff must
  // be image-pin rewrites only (same image name, new tag or digest). This replaces
  // the apps/<app>/deployment.yaml path allowlist, which encoded production-infra's
  // layout and rejected fleet-infra's apps/claws/deployment-staging.yaml (#2777).
  if (isAutoBump) {
    const files = await changedFiles();
    const verdict = await checkAutoBumpDiff(repo.fullName, pr.number, files);
    if (!verdict.ok) {
      if (verdict.reason === "not-image-pin-only") {
        return block("skipped: auto-bump PR diff is not an image-pin-only bump", {
          level: "warn",
          reason: "This auto-bump PR's diff is not an image-pin-only bump.",
        });
      }
      return block("skipped: auto-bump PR touches non-bump files", {
        level: "warn",
        reason: "This auto-bump PR touches files other than YAML manifests and a registry allowlist append or tag swap.",
      });
    }
  }

  let status = live.checkStatus;
  if (status === "none") {
    // A brand-new head SHA has no check runs registered for the first minute or
    // two. Treating that as "this repo has no CI" is how #2354 merged a red PR:
    // the ci-fixer pushed a merge-base commit at 08:32:42 and the sweep merged
    // at 08:32:59, 10 s after the first check run for the new head even started.
    const { settled, age } = await gh.haveChecksSettled(repo.fullName, live.headSha);
    if (!settled) {
      return block(`skipped: no checks yet on head ${live.headSha.slice(0, 7)} (age ${age}), waiting for CI to register`, { notify: false });
    }
    // Head is docs-only on top of a commit CI already validated (#2929):
    // carry that result forward rather than treating the PR as unchecked.
    // Skip the check entirely when the PR is already exempt on "none" below —
    // its result would be thrown away.
    const alreadyExemptOnNone = isDependabot || isDocPR || isIdeaCollectionPR || isAutomerge || ciExemptOnly;
    if (!alreadyExemptOnNone && await gh.carriedForwardCheckStatus(repo.fullName, pr.number) === "passing") {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number}: head ${live.headSha.slice(0, 7)} has no checks but every commit since the last CI-validated commit is CI-exempt — carrying its passing status forward`);
      status = "passing";
    }
    if (ciExemptOnly && !(isDependabot || isDocPR || isIdeaCollectionPR || isAutomerge)) {
      log.info(`[auto-merger] ${repo.fullName}#${pr.number}: no checks on head ${live.headSha.slice(0, 7)} but every changed file is CI-exempt — accepting status=none`);
    }
  }
  // isAutomerge/ciExemptOnly reaching here with status === "none" has already passed
  // haveChecksSettled above, which proves the head commit is old enough that "no checks"
  // means the repo/path genuinely registers none — not that CI hasn't started yet. An
  // all-CI-exempt diff is the case where the reviewer applies Ready on "none" (#3051);
  // post-#3135 that arrives via isAutomerge, leaving ciExemptOnly to cover only the
  // approval-exempt auto-bump PR whose manifests are all under docs/.

  // A held run starts no jobs, so it may be missing from statusCheckRollup entirely —
  // the rollup can read "passing" or "none" while a run on the same head is still
  // waiting on GitHub's action_required approval. The rollup is not the source of
  // truth for a hold; re-check the Actions API directly before trusting either status
  // enough to merge on it. A listing error fails closed rather than merging blind.
  let checksHeld = live.checksHeld;
  if ((status === "passing" || status === "none") && !isForgejoRepo(repo.fullName)) {
    let heldRuns: Awaited<ReturnType<typeof gh.listHeldWorkflowRuns>>;
    try {
      heldRuns = await gh.listHeldWorkflowRuns(repo.fullName, live.headSha);
    } catch (err) {
      // Transient (a 5xx or rate-limit blip on the Actions API) — the same as the
      // other not-reported states below, not a lasting "Merge blocked" comment.
      return block(`skipped: could not verify held workflow runs (${err})`, { level: "warn", notify: false });
    }
    recordHeldRuns(repo.fullName, live.headSha, heldRuns.length);
    if (heldRuns.length > 0) {
      status = "held";
      checksHeld = heldRuns.length;
    }
  }

  const checksOk = status === "passing" || (!noOpInfraPlan && (isDependabot || isDocPR || isIdeaCollectionPR || isAutomerge || ciExemptOnly) && status === "none");
  if (!checksOk) {
    if (status === "failing") {
      return block("skipped: checks failed", { level: "warn", reason: "CI is failing." });
    }
    if (status === "held") {
      const runs = `${checksHeld} workflow run${checksHeld === 1 ? "" : "s"}`;
      return block(`skipped: ${runs} held for approval`, {
        reason: `${runs} on the head commit ${checksHeld === 1 ? "is" : "are"} held for approval on GitHub — not a CI failure. Claws clears the hold itself for trusted dependency-update PRs from a branch in this repository; anything else waits for a human to approve the runs.`,
      });
    }
    return block(`skipped: checks status=${status}`, {
      reason: `CI status is \`${status}\` — waiting for it to finish.`,
    });
  }

  const conflictReason = `This branch has merge conflicts with \`${pr.baseRefName}\` — the ci-fixer will try to resolve them.`;
  let mergeState = live.mergeable;
  if (mergeState === "CONFLICTING") {
    return block("has merge conflicts, skipping (ci-fixer will resolve)", { reason: conflictReason });
  }
  if (mergeState === "UNKNOWN") {
    // GitHub computes mergeability asynchronously; retry before giving up.
    mergeState = await gh.getPRMergeableState(repo.fullName, pr.number);
    if (mergeState === "CONFLICTING") {
      return block("has merge conflicts, skipping (ci-fixer will resolve)", { reason: conflictReason });
    }
    if (mergeState !== "MERGEABLE") {
      return block("mergeable state still UNKNOWN after retries, skipping", { notify: false });
    }
  }

  gh.populateQueueCache("auto-mergeable", repo.fullName, { number: pr.number, title: pr.title, type: "pr", updatedAt: pr.updatedAt, priority: gh.hasPriorityLabel(pr.labels), labels: pr.labels.map((l) => l.name) });
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
      return block("head moved or was not mergeable at merge time, skipping", { notify: false });
    }
    throw err;
  }
  gh.setMergeBlockReason(repo.fullName, pr.number, null);
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
        details: { mergedBy: "auto-merger" },
      });
    } else {
      log.info(`[auto-merger] No completed producer task found for ${repo.fullName}#${pr.number} head ${live.headSha.slice(0, 12)}; skipping merge effectiveness signal`);
    }
  } catch (err) {
    log.warn(`[auto-merger] Could not record merge effectiveness for ${repo.fullName}#${pr.number}: ${err}`);
  }
  gh.removeQueueItem(repo.fullName, pr.number);
  await announcePostMergeAction(repo, pr);

  await finalizeMergedClawsPR(repo, pr, "auto-merger");

  return true;
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
    if (!await closeIssueIfPlanComplete(phases.issueRepo, issueRef, phases.state, { source, last: `${repo.fullName}#${pr.number}` })) {
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
      issueRepo = clawsIssues.primaryRepo(record.repos);
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
