import { isEscalationManualAction } from "../pr-escalation.js";
import { LABELS, issueUrl, isClawsIssueId, type Repo } from "../config.js";
import { AGENT_KINDS } from "../worker.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { guardContent } from "../prompt-guard.js";
import { POST_MERGE_ACTION_HEADING, extractPostMergeActionSection, isVerificationOnlyAction, isStandingNote, isNoActionNote } from "./issue-worker.js";
import { extractClosedIssueRefs, parsePhaseClaims } from "../phase-coverage.js";
import * as clawsIssues from "../claws-issues.js";
import { AWAITING_OPERATOR_MARKER } from "../blocked-reason.js";
import { ISSUE_REF_PATTERN, canonicalIssueRef, sameIssueRef, type IssueRef } from "../issue-id.js";
import { closeIssueIfPlanComplete, loadIssuePhaseState, peekTotalPhases, type IssuePhaseState } from "../planned-prs.js";
import * as planParser from "../plan-parser.js";
import { parkForHuman, settleMergedSingleStep } from "../issue-handback.js";
import { linkedIssue } from "../pr-hold.js";
import { recordPostMergeStep } from "../post-merge-step.js";
import { deployGateBlock, noticeDeployHold } from "../deploy-gate.js";
import { isPrHeldForReapproval } from "../reapproval.js";
import { INFRA_APPROVAL_NOT_CARRIED, hasManualAction, infraMergeApproval, isMergeApproved, isReviewedHeadAwaitingMerge, needsHumanReview, parseInfraMergeApprovedEvidence } from "../pr-state.js";
import { recordPrMerged, setPrNeedsOperatorGate } from "../gate-events.js";
import { linkedIssueRefFromPR } from "../issue-link.js";
import { storedClosedRefs, storedRelationFor, trackerIdFor } from "../pr-issue-relation.js";
import { extractRelatedNumbers } from "../github-events.js";
import { closeAlertIssueIfResolved } from "../occurrence-tracking.js";
import { announceAwaitingOperator } from "../awaiting-operator.js";
import { isAutoBumpPR, isImageScanPR, isImageScanPrunePR, isImageScanSnapshotPR } from "../dependency-prs.js";
import {
  checkImageScanPruneDiff, checkImageScanSnapshotDiff, imageScanHoldText, isTransientImageScanFailure,
  type ImageScanVerdict,
} from "../image-scan-prs.js";
import { isRenovateMajorUpdate, isTrustedRenovatePR, renovateApprovalHoldReason } from "../renovate.js";
import { CLAWS_ACK_MERGE_LABEL } from "../infra-declaration.js";
import { syncPrDestroyConsent, type DestroyConsentSync } from "../destroy-consent.js";
import { CLAWS_NOOP_MERGE_LABEL, infraApprovalNeed, infraWorkflowDiffDigest, isDestructivePlanAction, isInfraWorkflowPath, isPlanPublishingPath, noopMergeDiffVerdict, tofuPlanFingerprint, type InfraApprovalNeed } from "../tofu-plan.js";
import { ciQueueHold, ciQueueHoldNote, logCiQueueHold, type CiQueueHold } from "../ci-queue-gate.js";

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

/** Structural-gate verdicts (image-scan), keyed on `${gate}:${repo}#${number}@${headRefOid}`
 * so a force-push naturally invalidates the cached verdict. Capped and evicted oldest-first (insertion order). */
const GATE_VERDICT_CACHE_MAX = 500;
const GATE_VERDICT_CACHE_TTL_MS = 15 * 60 * 1000;
type GateName = "image-scan";
const gateVerdictCache = new Map<string, { verdict: ImageScanVerdict; at: number }>();

/** Test-only: drop every cached gate verdict. */
export function clearGateVerdictCache(): void {
  gateVerdictCache.clear();
}

/**
 * The cached verdict for `gate` on this head, or a fresh `compute()` stored
 * under it. A verdict `cacheable` rejects (a possibly transient read failure)
 * is returned but never stored. No head SHA means no caching.
 */
async function cachedGateVerdict<V extends ImageScanVerdict>(
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
 * The image-scan gate for a snapshot (`checkImageScanSnapshotDiff`) or prune
 * (`checkImageScanPruneDiff`) PR, cached per head SHA for 15 minutes so `/prs`,
 * the ci-fixer, the PR dispatcher and the auto-merger share one verdict; a PR
 * with no `headRefOid` is never cached.
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

/**
 * Why a non-exempt PR is held for a merge approval, for the `/prs` Awaiting
 * approval badge: the image-scan gate's failure for a snapshot or prune PR, else
 * `renovateApprovalHoldReason`. Null when there is nothing specific to say.
 */
export async function approvalHoldReason(repoFullName: string, pr: gh.PR): Promise<string | null> {
  if (isImageScanPR(pr)) {
    const verdict = await imageScanGateVerdict(repoFullName, pr);
    if (!verdict.ok) return imageScanHoldText(verdict);
  }
  return renovateApprovalHoldReason(repoFullName, pr);
}

/**
 * True when the PR may be auto-merged without a stored merge approval
 * (docs, ideas-collection, auto-bump, image-scan snapshot and prune, and trusted non-major
 * Renovate — see `isRenovateExempt`). An auto-bump PR (`isAutoBumpPR`, which
 * excludes `major-update`) is exempt unconditionally — nothing reads its diff —
 * but, like Renovate, still needs a clean Claws review of its current head
 * (#clw_01M6ZYAQ1GZXRMTZSQP1V0XA4D). An image-scan PR is exempt only while
 * `imageScanGateVerdict` passes (#clw_01M61EFZ6ZZM8FWGN2PAH3KNZB).
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
    isAutoBumpPR(pr) ||
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

/** After a successful merge, surface a "## 📋 Manual action required after merge" note from the
 * PR body as a comment — the merged body is not something anyone re-reads — and track it as an
 * operator step on the PR's issue plan (`recordPostMergeStep`), which keeps the issue open until
 * the step is marked done; a note the issue cannot take becomes a Blocked follow-up issue. Runs
 * before `finalizeMergedClawsPR`, so finalize sees the added step and parks the issue awaiting the
 * operator. Dashboard only: no Slack line (docs/slack-messages.md). A verification-only, standing
 * (conditional/recurring) or no-action ("none", "only if …") note is skipped. */
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
    if (isStandingNote(note)) {
      log.info(`[auto-merger] Skipped standing post-merge note for ${repo.fullName}#${pr.number}: ${note}`);
      return;
    }
    if (isNoActionNote(note)) {
      log.info(`[auto-merger] Skipped no-action post-merge note for ${repo.fullName}#${pr.number}: ${note}`);
      return;
    }
    const guarded = await guardContent(note, { repo: repo.fullName, source: "pr-post-merge-action", itemNumber: pr.number });
    await gh.commentOnIssue(
      repo.fullName, pr.number,
      `## 📋 Manual action required now this is merged\n\n${guarded}`,
      { agentName: "Auto Merger" },
    );
    try {
      const outcome = await recordPostMergeStep(repo.fullName, pr.number, guarded);
      log.info(`[auto-merger] Announced post-merge manual action for ${repo.fullName}#${pr.number}: ${outcome}`);
    } catch (err) {
      log.warn(`[auto-merger] Could not track post-merge manual action for ${repo.fullName}#${pr.number} as an operator step: ${err}`);
    }
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
 * Clear what an unmerged PR left behind once it has merged, by whatever route
 * (the auto-merger, a session, or the operator merging in the Forgejo UI,
 * which `refreshPrStore` catches): the in-memory merge-block reason, the
 * row's merge skip, the queue entry, and the "Merge blocked" comment, which is
 * edited in place to say the PR merged so the thread still shows what blocked
 * it. Leaves an already-edited comment alone. Never throws: the PR is merged
 * and a cleanup failure is logged at `warn`.
 */
export async function settleMergedPrState(repo: string, prNumber: number): Promise<void> {
  gh.setMergeBlockReason(repo, prNumber, null);
  gh.removeQueueItem(repo, prNumber);
  try {
    await db.setClawsPrMergeSkip(repo, prNumber, null);
  } catch (err) {
    log.warn(`[auto-merger] Could not clear the merge skip on ${repo}#${prNumber}: ${err}`);
  }
  try {
    const comments = await gh.getIssueComments(repo, prNumber);
    const existing = comments.find((c) => gh.isClawsComment(c.body) && c.body.includes(MERGE_STATUS_MARKER));
    if (!existing) return;
    const body = [
      "### Merged",
      "",
      "This PR has merged; the block above no longer applies.",
      "",
      MERGE_STATUS_MARKER,
    ].join("\n");
    if (gh.stripClawsMarker(existing.body).trim() === body) return;
    await gh.editIssueComment(repo, existing.id, body, { agentName: "Auto Merger" });
  } catch (err) {
    log.warn(`[auto-merger] Could not mark the merge-status comment merged on ${repo}#${prNumber}: ${err}`);
  }
}

/**
 * Why the auto-merger left an open PR unmerged, logged as the `merge_skipped`
 * diagnostic's `mergeSkip` so `claws_recent_job_logs` shows it
 * (#clw_01M4TK4C1E6VHMC09T13HDCBHJ).
 */
export type MergeSkipCode =
  | "fork" | "no-record" | "manual-action" | "stacked" | "reapproval-hold" | "closed"
  | "dispatch-guard" | "other-work" | "review-not-clean" | "review-stale" | "image-scan-gate"
  | "not-approved" | "unreadable-files" | "infra" | "infra-plan" | "infra-approval-stale" | "doc-pr-mixed"
  | "ideas-pr-mixed" | "checks-pending" | "checks-failed" | "checks-held"
  | "checks-missing" | "deploy-red" | "deploy-pending" | "conflict" | "mergeable-unknown" | "head-moved"
  | "empty" | "base-covers-update" | "destroy-consent-sync" | "infra-branch-update" | "ci-queue-deep" | "error";

/**
 * Skips decided before the merge gates are evaluated. `attemptMerge` does not
 * persist them on the `claws_prs` row, so the last gate's skip — an operator
 * block such as `infra` or `stacked` — stays visible while they pass.
 */
const PRE_GATE_SKIP_CODES: ReadonlySet<MergeSkipCode> = new Set<MergeSkipCode>(["fork", "other-work", "dispatch-guard", "destroy-consent-sync"]);

/** Agent kinds whose active run on a PR blocks merging it; the dashboard's infra line reads the same kinds (`listActivePrWork`). */
export const MERGE_BLOCKING_AGENT_KINDS = [
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

/** Title of the retired stalled auto-bump alert issue. */
const RETIRED_STALL_ALERT_TITLE = "Auto-bump PRs held by the structural merge gate";
/** Repos whose retired stall alert has been checked this process. */
const stallAlertRetiredRepos = new Set<string>();

/**
 * Close any still-open "Auto-bump PRs held by the structural merge gate"
 * alert issue, once per repo per process: the structural auto-bump gate and
 * its stall alert were removed (#clw_01M6ZYAQ1GZXRMTZSQP1V0XA4D).
 * Retirement; delete after 2026-12-01.
 */
async function retireStallAlert(repoFullName: string): Promise<void> {
  if (stallAlertRetiredRepos.has(repoFullName)) return;
  stallAlertRetiredRepos.add(repoFullName);
  try {
    await closeAlertIssueIfResolved({
      repo: repoFullName,
      title: RETIRED_STALL_ALERT_TITLE,
      logPrefix: "auto-merger",
      reason: "the structural auto-bump gate was removed (#clw_01M6ZYAQ1GZXRMTZSQP1V0XA4D)",
      // A retired check can never re-fire: close even if a plan or approval would hold it.
      force: true,
    });
  } catch (err) {
    log.warn(`[auto-merger] ${repoFullName}: could not close the retired auto-bump stall alert: ${err}`);
  }
}

/**
 * {@link syncPrDestroyConsent} for listed PR `pr` (its labels and body as the
 * PR list read them), with its `claws_prs` row when already read, logging a
 * failure: the guard then reads the old block, which fails closed on any
 * mismatch. Returns "unchanged" on failure.
 */
async function syncDestroyConsentBestEffort(repo: Repo, pr: gh.PR, row?: db.ClawsPrRecord | null): Promise<DestroyConsentSync> {
  try {
    return await syncPrDestroyConsent(repo.fullName, pr, row);
  } catch (err) {
    log.warn(`[auto-merger] Could not sync the approved destroys on ${repo.fullName}#${pr.number}: ${err}`);
    return "unchanged";
  }
}

/** Repos with a sweep in flight — the scheduler job and a chained queue row must not overlap. */
const sweepsInFlight = new Set<string>();

/**
 * Evaluate every open PR in `repo` for merge. A PR merged by hand is closed
 * out by the PR dispatcher's `refreshPrStore`, not here. Run by the
 * `auto-merger` scheduler job and by chained `auto-merger:sweep` queue rows
 * (#2971). Every sweep logs one `merge_sweep_done` line, so a sweep that
 * merged nothing still leaves a trace.
 */
export async function sweepRepo(repo: Repo): Promise<void> {
  if (sweepsInFlight.has(repo.fullName)) return;
  sweepsInFlight.add(repo.fullName);
  let openPrCount = 0;
  let mergedCount = 0;
  let skippedCount = 0;
  try {
    // The sweep is chained off ci-fixer/reviewer completion, so the 60 s PR-list
    // cache may still hold labels captured before that agent mutated the PR (#2354).
    gh.invalidatePRList(repo.fullName);
    const prs = await gh.listPRs(repo.fullName);
    openPrCount = prs.length;
    for (const pr of prs) {
      const guarded = gh.isDispatchSkippable(repo.fullName, pr);
      const busy = !guarded && await db.hasActiveWorkForPR(repo.fullName, pr.number, MERGE_BLOCKING_AGENT_KINDS);
      // Skipped without attemptMerge, but a withdrawn destroy consent must
      // still leave the PR (the list was just invalidated, so labels are fresh).
      if ((guarded || busy) && !gh.isForkPR(pr)) {
        await syncDestroyConsentBestEffort(repo, pr);
      }
      if (guarded) {
        skippedCount++;
        logMergeSkip(repo, pr.number, "dispatch-guard", `[auto-merger] sweep: skipping ${repo.fullName}#${pr.number} — dispatch guard`);
        continue;
      }
      if (busy) {
        skippedCount++;
        logMergeSkip(repo, pr.number, "other-work", `[auto-merger] sweep: skipping ${repo.fullName}#${pr.number} — other work running`);
        continue;
      }
      try {
        const result = await attemptMerge(repo, pr);
        if (result.merged) mergedCount++;
        else skippedCount++;
      } catch (err) {
        skippedCount++;
        logMergeSkip(repo, pr.number, "error", `[auto-merger] sweep: tryMerge failed for ${repo.fullName}#${pr.number}: ${err}`, "warn");
      }
    }
    await retireStallAlert(repo.fullName);
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
 * reason.
 */
export type MergeRefusal = { merged: false; code: MergeSkipCode; message: string };

/**
 * Whether a board infra merge approval for `approvedSha` carries over to
 * `headSha`: the head's verified plan (`planEvidence`, `noop` or `changes`)
 * lists exactly the resource changes recorded at approval (`tofuPlanFingerprint`
 * against `infraMergeApprovedEvidence`), and the PR's tofu workflow and action
 * edits and its edits to `repo`'s plan-publishing files
 * (`infraWorkflowDiffDigest` of its own diff against its base, so a merge
 * from the base branch alone does not count) are unchanged. On refusal,
 * `reason` names the rule that failed and `kind` classifies it: `plan-differs`
 * (totals or resource changes differ; `drift` lists the fingerprint lines on
 * one side only and `roots` the roots the head's evidence covers),
 * `plan-unavailable` (no verified resource list for the head), or `other`.
 */
export async function infraApprovalCarryOver(
  repo: string,
  approvedSha: string | null,
  headSha: string,
  storedEvidence: string | null | undefined,
  files: string[],
  diff: string,
  planEvidence: () => Promise<gh.TofuPlanEvidence>,
): Promise<{ ok: true; note: string } | InfraCarryOverRefusal> {
  const was = approvedSha ? approvedSha.slice(0, 7) : "an unknown head";
  const now = headSha.slice(0, 7);
  const stored = parseInfraMergeApprovedEvidence(storedEvidence);
  if (!stored || stored.fingerprint === null) return { ok: false, kind: "other", reason: `approved plan for ${was} was not recorded` };
  const evidence = await planEvidence();
  if (evidence.state === "unavailable") return { ok: false, kind: "plan-unavailable", reason: `plan for ${now} not available (${evidence.detail})` };
  if (!evidence.resources) return { ok: false, kind: "plan-unavailable", reason: `plan for ${now} not available (its resource changes are not listed)` };
  const fingerprint = tofuPlanFingerprint(evidence.resources);
  const differs = (reason: string): InfraCarryOverRefusal => ({
    ok: false, kind: "plan-differs", reason, drift: planDrift(stored.fingerprint!, fingerprint), roots: evidence.roots ?? [],
  });
  if (!stored.counts || !evidence.plan || (["add", "change", "replace", "destroy"] as const).some((k) => stored.counts![k] !== evidence.plan![k])) {
    return differs(`plan totals for ${now} differ from the approved plan for ${was}`);
  }
  if (fingerprint !== stored.fingerprint) {
    return differs(`plan for ${now} differs from the approved plan for ${was}: ${firstPlanDifference(stored.fingerprint, fingerprint)}`);
  }
  const digest = infraWorkflowDiffDigest(repo, files, diff);
  if (digest === null || stored.workflowDiff === null) {
    return { ok: false, kind: "other", reason: `tofu workflow diff for ${digest === null ? now : was} could not be read` };
  }
  if (digest !== stored.workflowDiff) {
    const workflows = files.filter((f) => isInfraWorkflowPath(f) || isPlanPublishingPath(repo, f));
    return { ok: false, kind: "other", reason: `${workflows.length > 0 ? workflows.slice(0, 3).join(", ") : "a tofu workflow, action or plan-publishing file"} changed since ${was}` };
  }
  return { ok: true, note: `same plan as ${was}, no tofu workflow change` };
}

/** `requireCleanReview`'s subject for an infra PR merging on its verified non-destructive plan. */
const VERIFIED_INFRA_SUBJECT = "verified non-destructive infra plan";

/**
 * Whether a board infra approval recorded for the live head
 * (`infraMergeApprovedEvidence`) covers the head's live `need`: it was given
 * for that need, or — for a destructive plan — it recorded this very plan
 * (same fingerprint; a destructive approval whose plan listed no resources is
 * taken on its need). An approval given while the plan was unverifiable never
 * covers a destroy that plan later shows. A pre-need approval (no `need`
 * recorded) covers a destructive plan only by fingerprint, any other need as
 * before. Pure.
 */
export function infraApprovalCovers(
  need: InfraApprovalNeed,
  storedEvidence: string | null | undefined,
  evidence: Pick<gh.TofuPlanEvidence, "state" | "resources">,
): boolean {
  const stored = parseInfraMergeApprovedEvidence(storedEvidence);
  if (need === "destructive") {
    // The plan the operator saw must be the one the head has now; a destructive
    // approval with no listed resources is taken on its need.
    if (stored?.fingerprint) {
      const verified = (evidence.state === "noop" || evidence.state === "changes") && evidence.resources;
      return !!verified && stored.fingerprint === tofuPlanFingerprint(evidence.resources!);
    }
    return stored?.need === "destructive";
  }
  return stored?.need === need || stored?.need === undefined;
}

/** One resource line two plan fingerprints disagree on; root null for a single-root plan. */
export interface PlanDriftLine { root: string | null; address: string; action: string }

/** Why {@link infraApprovalCarryOver} refused, classified for the automatic branch update. */
export type InfraCarryOverRefusal =
  | { ok: false; kind: "plan-differs"; reason: string; drift: PlanDriftLine[]; roots: (string | null)[] }
  | { ok: false; kind: "plan-unavailable" | "other"; reason: string };

/** The symmetric difference of two plan fingerprints, line by line. */
function planDrift(approved: string, current: string): PlanDriftLine[] {
  const before = new Set(approved ? approved.split("\n") : []);
  const after = new Set(current ? current.split("\n") : []);
  const lines = [...[...after].filter((l) => !before.has(l)), ...[...before].filter((l) => !after.has(l))];
  return lines.map((line) => {
    const parts = line.split(" ");
    const root = parts[0];
    return { root: root && root !== "-" ? root : null, address: parts.slice(1, -1).join(" "), action: parts[parts.length - 1] ?? "" };
  });
}

/** How a plan drift relates to what the PR changes; only `outside` allows an automatic branch update. */
export type DriftScope = "outside" | "no-drift" | "unnamed-root" | "drift-in-pr-root" | "infra-outside-roots" | "no-infra-code";

/**
 * Whether a plan drift lies outside what the PR changes, judged per tofu root
 * (a diff cannot be mapped to resource addresses): `outside` when every
 * drifting root is named, no changed file sits under its directory, and every
 * changed infra code file (`gh.isInfraPath`, minus tofu workflows) sits under
 * some plan root in `roots`. Otherwise the first reason it does not hold:
 * empty drift, an unnamed root on either side, a changed file under a
 * drifting root, a changed infra code file under no plan root (a shared
 * module), or no changed infra code file at all (a workflow-only PR).
 */
export function driftOutsidePr(drift: readonly PlanDriftLine[], roots: readonly (string | null)[], files: readonly string[]): DriftScope {
  if (drift.length === 0) return "no-drift";
  if (drift.some((d) => d.root === null) || roots.length === 0 || roots.some((r) => r === null)) return "unnamed-root";
  const under = (root: string, f: string): boolean => f.startsWith(`${root}/`);
  const driftRoots = [...new Set(drift.map((d) => d.root as string))];
  if (driftRoots.some((root) => files.some((f) => under(root, f)))) return "drift-in-pr-root";
  const infraCode = files.filter((f) => gh.isInfraPath(f) && !isInfraWorkflowPath(f));
  if (infraCode.length === 0) return "no-infra-code";
  const planRoots = roots as readonly string[];
  return infraCode.every((f) => planRoots.some((root) => under(root, f))) ? "outside" : "infra-outside-roots";
}

/** Why no automatic branch update was made, per {@link DriftScope} other than `outside`. */
const DRIFT_SCOPE_NOTES: Record<Exclude<DriftScope, "outside">, string> = {
  "no-drift": "Claws did not update the branch: the plan totals differ but no resource line does, so there is no drift to attribute to a stale branch.",
  "unnamed-root": "Claws did not update the branch: the plan does not name a root for each change, so the drift cannot be told apart from this PR's own changes.",
  "drift-in-pr-root": "Claws did not update the branch: the drift is in a root this PR changes.",
  "infra-outside-roots": "Claws did not update the branch: this PR changes infra code outside every plan root (such as a shared module), so the drift cannot be told apart from its own changes.",
  "no-infra-code": "Claws did not update the branch: this PR changes no infra code under a plan root, so the drift cannot be told apart from its own changes.",
};

/**
 * Whether the base commits the PR head lacks have changed every file the PR
 * changes — the necessary condition for the PR to be empty against the base
 * tip even though Forgejo's merge-base stats say otherwise (Forgejo then
 * answers the squash merge with HTTP 500). `"covered"` when they have;
 * `"unknown"` when the compare read failed or was truncated short of proving
 * coverage; `"none"` otherwise.
 */
async function baseCoversPrFiles(
  repo: Repo,
  pr: gh.PR,
  headSha: string,
  files: string[],
): Promise<"covered" | "none" | "unknown"> {
  let range: Awaited<ReturnType<typeof gh.listCompareChangedFiles>>;
  try {
    range = await gh.listCompareChangedFiles(repo.fullName, headSha, pr.baseRefName);
  } catch (err) {
    log.warn(`[auto-merger] Could not compare ${repo.fullName}#${pr.number}'s head with ${pr.baseRefName}: ${err}`);
    return "unknown";
  }
  if (!range || range.commits.length === 0) return "none";
  const baseFiles = new Set(range.commits.flatMap((c) => c.files));
  if (files.length > 0 && files.every((f) => baseFiles.has(f))) return "covered";
  if (range.commits.length < range.totalCommits) return "unknown";
  return "none";
}

/**
 * The CI queue gate's hold on a branch update for `pr`, logged, or null; a
 * Priority PR is never held (#clw_01M7T7K12NNP20WJ83PWMAVZB1).
 */
async function branchUpdateHold(repo: Repo, pr: gh.PR): Promise<CiQueueHold | null> {
  if (gh.hasPriorityLabel(pr.labels)) return null;
  const hold = await ciQueueHold(repo.fullName);
  if (hold) logCiQueueHold(repo.fullName, "auto-merger:branch-update", pr.number, hold);
  return hold;
}

/** Automatic branch updates the auto-merger makes per infra merge approval. */
export const INFRA_BRANCH_UPDATE_BUDGET = 2;

/**
 * For a stale board infra approval whose plan differs: when the drift is
 * outside the roots the PR changes (`driftOutsidePr`), the head is a `claws/`
 * branch, it is behind its base and the budget is not spent, merge the base
 * into it on the forge so CI re-plans, recording the count, the head it
 * started from and the new head, and the push for the CI-fixer breaker. A new
 * head that cannot be read (or reads unchanged) is stored as null and no push
 * is recorded; the wait keys on the head moving off the start. Otherwise `note` is the sentence the
 * "approve again" block appends saying why no update was made, or, when the
 * CI queue gate holds the update, `queueHeld` is the reason for a quiet
 * `ci-queue-deep` block. A conflict, failed or held update spends no budget.
 */
async function updateStaleInfraBranch(
  repo: Repo,
  pr: gh.PR,
  row: db.ClawsPrRecord,
  headSha: string,
  carry: Extract<InfraCarryOverRefusal, { kind: "plan-differs" }>,
  files: string[],
): Promise<{ updated: true; newHead: string | null; reason: string } | { updated: false; note: string } | { updated: false; queueHeld: string }> {
  const base = pr.baseRefName;
  const scope = driftOutsidePr(carry.drift, carry.roots, files);
  if (scope !== "outside") return { updated: false, note: DRIFT_SCOPE_NOTES[scope] };
  let behind: number;
  try {
    behind = (await gh.listCompareCommits(repo.fullName, headSha, base)).length;
  } catch (err) {
    log.warn(`[auto-merger] Could not tell how far ${repo.fullName}#${pr.number} is behind ${base}: ${err}`);
    return { updated: false, note: `Claws did not update the branch: it could not tell whether the branch is behind \`${base}\`.` };
  }
  if (behind === 0) return { updated: false, note: `The branch is up to date with \`${base}\`, so the drift is not from a stale branch.` };
  const commits = `${behind} commit${behind === 1 ? "" : "s"}`;
  if (!pr.headRefName.startsWith("claws/")) {
    return { updated: false, note: `The branch is ${commits} behind \`${base}\` but is not a Claws branch, so Claws did not update it.` };
  }
  const used = row.infraBranchUpdates ?? 0;
  if (used >= INFRA_BRANCH_UPDATE_BUDGET) {
    return { updated: false, note: `The branch is ${commits} behind \`${base}\` and ${INFRA_BRANCH_UPDATE_BUDGET} automatic updates were already attempted.` };
  }
  // A branch update pushes, so it waits out a deep CI queue without spending budget.
  // The caller blocks quietly: no re-approval is needed, Claws updates the branch once the queue drains.
  const queueHold = await branchUpdateHold(repo, pr);
  if (queueHold) {
    return { updated: false, queueHeld: `The branch is ${commits} behind \`${base}\`; Claws waits to update it until ${repo.fullName}'s CI queue drains.` };
  }
  let outcome: "updated" | "conflict";
  try {
    outcome = await gh.updatePRBranch(repo.fullName, pr.number);
  } catch (err) {
    log.warn(`[auto-merger] Could not update ${repo.fullName}#${pr.number}'s branch onto ${base}: ${err}`);
    return { updated: false, note: `The branch is ${commits} behind \`${base}\` and Claws could not update it; it tries again on the next check.` };
  }
  if (outcome === "conflict") {
    return { updated: false, note: `The branch is ${commits} behind \`${base}\` and conflicts with it, so Claws could not update it.` };
  }
  const attempt = used + 1;
  let newHead: string | null = null;
  try {
    const read = await gh.getPRHeadSHA(repo.fullName, pr.number);
    if (read && read !== headSha) newHead = read;
    else log.warn(`[auto-merger] ${repo.fullName}#${pr.number}'s head still reads ${headSha.slice(0, 7)} after updating its branch`);
  } catch (err) {
    log.warn(`[auto-merger] Could not read ${repo.fullName}#${pr.number}'s head after updating its branch: ${err}`);
  }
  try {
    await db.upsertClawsPr(repo.fullName, pr.number, { infraBranchUpdates: attempt, infraBranchUpdateSha: newHead, infraBranchUpdateFromSha: headSha });
  } catch (err) {
    log.warn(`[auto-merger] Could not record the infra branch update on ${repo.fullName}#${pr.number}: ${err}`);
  }
  if (newHead !== null) {
    try {
      await db.recordCIFixerPush(repo.fullName, pr.number, newHead);
    } catch (err) {
      log.warn(`[auto-merger] Could not record the infra branch update push on ${repo.fullName}#${pr.number}: ${err}`);
    }
  }
  log.info("[auto-merger] updated infra PR branch onto its base", {
    repo: repo.fullName, pr: pr.number, base, behind, attempt, head: newHead,
  });
  const d = carry.drift[0]!;
  const first = `${d.address} ${d.action} in ${d.root}`;
  return {
    updated: true,
    newHead,
    reason: `Claws merged \`${base}\` into this branch (it was ${commits} behind) because the plan drift (${first}) is outside the files this PR changes; waiting for the Tofu plan of ${newHead ? newHead.slice(0, 7) : "the updated head"}. Automatic update ${attempt} of ${INFRA_BRANCH_UPDATE_BUDGET}.`,
  };
}

/** The first resource line two plan fingerprints disagree on, worded for the operator. */
function firstPlanDifference(approved: string, current: string): string {
  const word = (line: string): string => {
    const parts = line.split(" ");
    const root = parts[0];
    const action = parts[parts.length - 1];
    const address = parts.slice(1, -1).join(" ");
    return `${address} ${action}${root && root !== "-" ? ` in ${root}` : ""}`;
  };
  const before = new Set(approved ? approved.split("\n") : []);
  const after = new Set(current ? current.split("\n") : []);
  const added = [...after].find((l) => !before.has(l));
  if (added) return `now plans ${word(added)}`;
  const removed = [...before].find((l) => !after.has(l));
  if (removed) return `no longer plans ${word(removed)}`;
  return "resource changes differ";
}

/**
 * The block for an infra PR whose need (`infraApprovalNeed`) has no board
 * approval: `infra-plan` for an unverifiable plan (the plan run may still
 * pass), `infra` naming the destroyed or replaced resources one `- ` bullet
 * each (the board lists them, `persistedInfraHoldItems`) and any tofu
 * workflow or plan-publishing edit the same approval covers, or the edited
 * tofu workflow or plan-publishing files (#clw_01M7NR1KKSPCEZ5VKSWGD27V8E).
 * The texts keep the phrase "tofu workflow", which the board's `lineNeed`
 * matches. Pure.
 */
export function infraApprovalHold(
  need: InfraApprovalNeed,
  evidence: Pick<gh.TofuPlanEvidence, "plan" | "detail" | "resources">,
  workflowFiles: readonly string[],
  sha7: string,
): { code: "infra" | "infra-plan"; log: string; reason: string } {
  if (need === "unverified") {
    return {
      code: "infra-plan",
      log: `Tofu plan for head ${sha7} could not be verified (${evidence.detail})`,
      reason: `The Tofu plan for head ${sha7} could not be verified (${evidence.detail}), so Claws will not merge it. It merges once the plan run passes; approve it on the board to merge without a verified plan.`,
    };
  }
  if (need === "destructive") {
    const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
    // A destructive plan outranks a tofu workflow edit, so the one approval
    // covers both: name the edit too, since the plan cannot show what it applies.
    const alsoNamed = workflowFiles.slice(0, 5).join(", ");
    const alsoLog = workflowFiles.length > 0 ? `; also edits tofu workflow or plan-publishing file(s) ${alsoNamed}` : "";
    const alsoReason = workflowFiles.length > 0
      ? ` It also edits the tofu workflow or plan-publishing file${workflowFiles.length === 1 ? "" : "s"} ${alsoNamed}, which the plan cannot show; the same approval covers that edit.`
      : "";
    const listed = evidence.resources?.filter((r) => isDestructivePlanAction(r.action)) ?? [];
    if (listed.length > 0) {
      const bullets = listed.map((r) => `- ${r.root ? `${r.root}: ` : ""}${r.address} — ${r.action}`).join("\n");
      return {
        code: "infra",
        log: `Tofu plan for head ${sha7} destroys or replaces ${plural(listed.length, "resource")}: ${listed.map((r) => r.address).join(", ")}${alsoLog}`,
        reason: `The Tofu plan for head ${sha7} destroys or replaces ${plural(listed.length, "resource")}:\n\n${bullets}\n\n${alsoReason ? `${alsoReason.trim()} ` : ""}Approve resource deletion on the board to merge it.`,
      };
    }
    const destroy = evidence.plan?.destroy ?? 0;
    const replace = evidence.plan?.replace ?? 0;
    const counts = [
      ...(destroy > 0 || replace === 0 ? [`destroys ${plural(destroy, "resource")}`] : []),
      ...(replace > 0 ? [`replaces ${plural(replace, "resource")}`] : []),
    ].join(" and ");
    return {
      code: "infra",
      log: `Tofu plan for head ${sha7} ${counts}; its plan comment lists no addresses${alsoLog}`,
      reason: `The Tofu plan for head ${sha7} ${counts}; its plan comment lists no addresses.${alsoReason} Approve resource deletion on the board to merge it.`,
    };
  }
  const named = workflowFiles.length > 0 ? workflowFiles.slice(0, 5).join(", ") : "a tofu workflow or plan-publishing file";
  return {
    code: "infra",
    log: `head ${sha7} edits tofu workflow or plan-publishing file(s) ${named}`,
    reason: `This PR edits the tofu workflow or plan-publishing file${workflowFiles.length === 1 ? "" : "s"} ${named}, and the Tofu plan for head ${sha7} cannot show what the edit will apply or post. Approve the tofu workflow change on the board to merge it.`,
  };
}

/**
 * `tryMerge` with the refusal spelled out: every auto-merger gate, then the
 * merge. `mergedBy` names who merged it in the effectiveness event and as
 * `finalizeMergedClawsPR`'s source — `session:<id>` for a session's
 * `claws_merge_pr` (#clw_01M4XFRSGNP87QVW0N1W5KN0V4), else `auto-merger`.
 * `notify: false` never posts a "Merge blocked" comment, for a caller that
 * withdraws the approval on a refusal (`claws_approve_pr_merge`).
 * An infrastructure PR whose verified plan for the live head destroys or
 * replaces nothing merges like any other PR (#clw_01M7NKT2H402M07VGCAE1TBX8G).
 * One whose plan is unverifiable or destructive, or that edits a tofu
 * workflow (`infraApprovalNeed`), needs a human's board approval for the
 * PR's live head (the row's `infra_merge_approved_*` columns, see
 * `infraMergeApproval`), which counts the same way on every caller, the
 * sweep included. One for an older head is
 * carried over to the live head when the head's verified plan lists the same
 * resource changes as the approved plan and the PR's tofu workflow edits are
 * unchanged (`infra_merge_carried_*`); otherwise it blocks as
 * `infra-approval-stale`, naming why, so the operator is asked again — unless
 * the plan drift lies in roots the PR does not touch and its `claws/` branch is
 * behind its base: then the base is merged into it (`updateStaleInfraBranch`,
 * at most `INFRA_BRANCH_UPDATE_BUDGET` times per approval) and the PR blocks as
 * `infra-branch-update` until the new head's plan is judged.
 */
export async function attemptMerge(
  repo: Repo,
  pr: gh.PR,
  opts: { mergedBy?: string; notify?: boolean } = {},
): Promise<{ merged: true } | MergeRefusal> {
  const mergedBy = opts.mergedBy ?? "auto-merger";
  const notifyBlocks = opts.notify !== false;
  // Set once the PR is known to be human-approved (the stored merge approval);
  // from then on a block is reported on the PR, not only logged (#2971).
  let approved = false;
  // The best known head for the persisted skip: the live head once read, else the row's.
  let liveHead: string | undefined;
  let rowHead: string | null | undefined;
  // Whether the PR may carry CLAWS_ACK_MERGE_LABEL: it must not outlive a sweep
  // that does not merge it on a verified plan with a readable resource list.
  let ackLabelMaybe = pr.labels.some((l) => l.name === CLAWS_ACK_MERGE_LABEL);
  const dropAckLabel = async (): Promise<void> => {
    if (!ackLabelMaybe) return;
    try {
      await gh.removeLabel(repo.fullName, pr.number, CLAWS_ACK_MERGE_LABEL);
      ackLabelMaybe = false;
    } catch (err) {
      log.warn(`[auto-merger] Could not remove ${CLAWS_ACK_MERGE_LABEL} from ${repo.fullName}#${pr.number}: ${err}`);
    }
  };
  const block = async (
    code: MergeSkipCode,
    message: string,
    opts: { level?: "info" | "warn"; notify?: boolean; reason?: string; reportUnapproved?: boolean } = {},
  ): Promise<MergeRefusal> => {
    const line = `[auto-merger] ${repo.fullName}#${pr.number} ${message}`;
    logMergeSkip(repo, pr.number, code, line, opts.level);
    await dropAckLabel();
    // Every skip, reported or not, so the web tier sees it (`pr-attention.ts`) —
    // except one decided before the merge gates run, which would overwrite an
    // operator block the gates found last sweep with a transient Claws-side code.
    if (!PRE_GATE_SKIP_CODES.has(code)) {
      try {
        await db.setClawsPrMergeSkip(repo.fullName, pr.number, {
          code, reason: opts.reason ?? message, head: liveHead || rowHead || pr.headRefOid || null,
        });
      } catch (err) {
        log.warn(`[auto-merger] Could not record the merge skip on ${repo.fullName}#${pr.number}: ${err}`);
      }
    }
    if (notifyBlocks && (approved || opts.reportUnapproved) && opts.notify !== false && opts.reason) {
      await reportMergeBlock(repo, pr, opts.reason, code);
    }
    return { merged: false, code, message: opts.reason ?? message };
  };

  if (gh.isForkPR(pr)) {
    return block("fork", "skipped: fork PR");
  }
  // PR state comes from the `claws_prs` row, Claws' own store, so a DB read
  // is live; forge state labels are a write-only mirror and never read here.
  const row = await db.getClawsPr(repo.fullName, pr.number);
  // Bring the PR body's approved-destroys block and its label into line with
  // the issue's current destroy consent (src/destroy-consent.ts) before any
  // hold returns, so a withdrawn or re-planned consent leaves a held PR too.
  // The consent writers push the change out themselves; this is the backstop.
  // It works off the listed labels and body, so a PR with no consent, no
  // label and no block costs no forge call.
  const consentSync = await syncDestroyConsentBestEffort(repo, pr, row);
  if (await db.hasActiveWorkForPR(repo.fullName, pr.number, MERGE_BLOCKING_AGENT_KINDS)) {
    return block("other-work", "skipped: other work running", {
      notify: false,
      reason: "Claws is still working on this PR (review/CI fix in progress); try again when it finishes.",
    });
  }

  if (!row) {
    return block("no-record", "skipped: no claws_prs row", { notify: false });
  }
  rowHead = row.headSha;
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
  // Everything above is a cheap pre-filter off the (60 s cached) PR list. The
  // sweep is chained off ci-fixer/reviewer completion, so the PR is routinely
  // mutated seconds before this runs — re-read the merge-relevant state live
  // and re-check every gate against it (#2354).
  const live = await gh.getPRMergeGate(repo.fullName, pr.number);
  liveHead = live.headSha;
  if (live.state !== "OPEN") {
    return block("closed", `skipped: state=${live.state}`);
  }
  if (gh.isDispatchSkippable(repo.fullName, { number: pr.number, labels: live.labels.map((name) => ({ name })) })) {
    return block("dispatch-guard", "skipped: dispatch guard rejected live labels");
  }
  // Forgejo answers a squash merge of a PR with no net changes with HTTP 500
  // ("nothing to commit"); leave it for the Empty PR Closer.
  if (live.changedFiles === 0 && live.additions === 0 && live.deletions === 0) {
    return block("empty", "skipped: no net changes against the base branch (the Empty PR Closer will close it)", {
      notify: false,
      reason: "This PR has no net changes against its base branch, so there is nothing to merge; the Empty PR Closer closes it.",
    });
  }
  // The sync changed the block or label, so `live.checkStatus` predates the
  // Tofu Plan run it triggered: leave the merge to the next sweep.
  if (consentSync !== "unchanged") {
    return block("destroy-consent-sync", `skipped: approved destroys ${consentSync}; waiting for Tofu Plan to re-run`, { notify: false });
  }

  const isDocPR = pr.headRefName.startsWith("claws/docs-");
  const isIdeaCollectionPR = pr.headRefName.startsWith("claws/ideas-collect-");
  const isAutoBump = isAutoBumpPR(pr);
  const isImageScan = isImageScanPR(pr);
  const isMergeApprovedRow = isMergeApproved(row);
  let renovateExempt: boolean | undefined;
  const isRenovateExemptPR = async (): Promise<boolean> => (renovateExempt ??= await isRenovateExempt(repo.fullName, pr));

  let cachedFiles: string[] | null = null;
  const changedFiles = async (): Promise<string[]> => (cachedFiles ??= await gh.getPRChangedFiles(repo.fullName, pr.number));

  // A clean Claws review of the current head — required of an approved
  // non-exempt PR and of a trusted Renovate PR; never of other exempt PRs. Resolves to a block, or null.
  // What lets the PR merge, opening the refusal: an approval-exempt infra PR
  // on a verified non-destructive plan carries no merge approval to name.
  const reviewSubject = (subject: string): string => (
    isMergeApprovedRow || subject !== VERIFIED_INFRA_SUBJECT ? "The merge approval is set" : "The Tofu plan is verified and destroys or replaces nothing"
  );
  // Set once a clean review of the current head has been confirmed this pass,
  // so a later gate (the infra branch) does not read the forge again.
  let cleanReviewConfirmed = false;
  const requireCleanReview = async (subject: string): Promise<MergeRefusal | null> => {
    if (cleanReviewConfirmed) return null;
    const review = await gh.getPRReviewStatus(repo.fullName, pr.number);
    if (review.status !== "clean") {
      return block("review-not-clean", `skipped: ${subject} but review status=${review.status}`, {
        // "none" means no review of the current head has run yet — the same
        // transient, nothing-to-act-on state as "no checks registered yet" (#3122).
        notify: review.status !== "none",
        reason: `${reviewSubject(subject)}, but the Claws review status is \`${review.status}\`, not clean.`,
      });
    }
    const headSha = await gh.getPRHeadSHA(repo.fullName, pr.number);
    if (!review.reviewedCommit || !headSha.startsWith(review.reviewedCommit)) {
      return block("review-stale", `skipped: ${subject} but clean review is stale`, {
        reason: `${reviewSubject(subject)}, but the clean Claws review is for an older commit — a fresh review of the current head is required.`,
      });
    }
    cleanReviewConfirmed = true;
    return null;
  };

  // Image-scan snapshot and prune PRs are exempt only while they are still the
  // generator's output (#clw_01M61EFZ6ZZM8FWGN2PAH3KNZB): refreshed here against
  // the live head and base tip.
  const imageScanVerdict = isImageScan
    ? await imageScanGateVerdict(repo.fullName, pr, { knownFiles: await changedFiles(), refresh: true, headSha: live.headSha, baseSha: live.baseSha })
    : null;

  // Exemption is evaluated before the approval branch: a merge approval never
  // adds a review gate to an approval-exempt PR (#clw_01M46YW6WPNPH0545G6KJB1AWD).
  const exempt = await isApprovalExempt(repo.fullName, { ...pr, headRefOid: live.headSha }, row);
  // On an exempt PR `approved` only governs whether a later block is reported.
  approved = isMergeApprovedRow;
  if (exempt) {
    if (await isRenovateExemptPR()) {
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
    if (isAutoBump) {
      // Exempt by branch and label, whatever its diff (#clw_01M6ZYAQ1GZXRMTZSQP1V0XA4D):
      // a clean review of the current head is still required.
      const blocked = await requireCleanReview("auto-bump image bump");
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
    if (imageScanVerdict && !imageScanVerdict.ok) {
      // The one block reported without an approval: an image-scan PR looks
      // exempt, so without this the hold would be visible only in the job log. `no-files` and
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

  // Infra (OpenTofu/Terraform) PRs merge like any other once the Tofu plan
  // for this exact head is verified and destroys or replaces nothing
  // (#clw_01M7NKT2H402M07VGCAE1TBX8G). One human gate stays, the operator's
  // per-head board approval (`infraApprovalNeed`): a plan that cannot be
  // verified, a destructive plan, or an edit to a tofu workflow or action file
  // (#841) — save a trusted Renovate tool version bump with a zero-change plan —
  // or to the repo's plan-publishing scripts (#clw_01M7NR1KKSPCEZ5VKSWGD27V8E).
  // An approval for an older head carries over when the plan and tofu
  // workflow edits did not change.
  const files = await changedFiles();
  if (files.length === 0 && (pr.changedFiles ?? 0) > 0) {
    // getPRChangedFiles swallows errors and returns []; fail closed rather than
    // auto-merge an unreadable diff that may contain tofu changes.
    return block("unreadable-files", "skipped: could not read changed files", {
      level: "warn",
      reason: "Claws could not read this PR's changed files, so it will not merge it.",
    });
  }
  const infra = await gh.infraPathsIn(files, repo.fullName);
  // Best-effort removal of a stale no-op merge label so a later human merge is
  // not subject to the apply guard's refusal.
  // Resolves false only when the label may be present and its removal failed.
  let noopLabelMaybe = pr.labels.some((l) => l.name === CLAWS_NOOP_MERGE_LABEL);
  const dropNoopLabel = async (): Promise<boolean> => {
    if (!noopLabelMaybe) return true;
    try {
      await gh.removeLabel(repo.fullName, pr.number, CLAWS_NOOP_MERGE_LABEL);
      noopLabelMaybe = false;
      return true;
    } catch (err) {
      log.warn(`[auto-merger] Could not remove ${CLAWS_NOOP_MERGE_LABEL} from ${repo.fullName}#${pr.number}: ${err}`);
      return false;
    }
  };
  // The head's verified plan evidence (`noop` or `changes`) when the merge
  // relies on it: the plan run is itself a check, so "no checks" can never
  // stand in for a green run, and the apply-guard labels follow its state.
  let verifiedInfraPlan: gh.TofuPlanEvidence | undefined;
  // Set when the operator's board infra approval for this head lets it merge.
  let infraMergeApprovedBy: string | undefined;
  const infraApproval = infraMergeApproval(row, live.headSha);
  if (infra.length > 0) {
    const paths = infra.slice(0, 5).join(", ");
    const sha7 = live.headSha.slice(0, 7);
    const evidence = await gh.getTofuPlanEvidence(repo.fullName, pr.number, live.headSha);
    const verified = evidence.state === "noop" || evidence.state === "changes";
    const tofuWorkflowFiles = files.filter(isInfraWorkflowPath);
    // The files the workflow need names: tofu workflows plus plan-publishing scripts.
    const workflowFiles = files.filter((f) => isInfraWorkflowPath(f) || isPlanPublishingPath(repo.fullName, f));
    let diffRead: Promise<string> | undefined;
    const prDiff = (): Promise<string> => (diffRead ??= gh.getPRDiff(repo.fullName, pr.number));
    // A tofu tool version bump is exempt from the workflow need only from a
    // trusted Renovate update with a zero-change plan.
    let trustedToolBump = false;
    if (tofuWorkflowFiles.length > 0 && evidence.state === "noop") {
      const verdict = noopMergeDiffVerdict(files, await prDiff());
      trustedToolBump = verdict.ok && verdict.kind === "tool-version-bump" && await isRenovateExemptPR();
    }
    const need = infraApprovalNeed({ repo: repo.fullName, files, planState: evidence.state, plan: evidence.plan, trustedToolBump });
    if (need === null) {
      const blocked = await requireCleanReview(VERIFIED_INFRA_SUBJECT);
      if (blocked !== null) return blocked;
      log.info(`[auto-merger] ${repo.fullName}#${pr.number}: head ${sha7} has a verified non-destructive plan (${evidence.detail}${trustedToolBump ? ", trusted Renovate tool version bump" : ""}); checking the remaining gates`);
      verifiedInfraPlan = evidence;
    } else if (
      // A carried approval is re-checked too: a re-plan of the same head can
      // show a destroy the carried-over approval never saw.
      (infraApproval.state === "current" || infraApproval.state === "carried")
      && infraApprovalCovers(need, row.infraMergeApprovedEvidence, evidence)
    ) {
      const blocked = await requireCleanReview("infra approval from the board");
      if (blocked !== null) return blocked;
      const carried = infraApproval.state === "carried" && infraApproval.sha ? ` (carried over from ${infraApproval.sha.slice(0, 7)})` : "";
      log.info(`[auto-merger] ${repo.fullName}#${pr.number}: ${need} infra plan (${paths}) approved on the board by ${infraApproval.by} for head ${sha7}${carried}; checking the remaining gates`);
      infraMergeApprovedBy = infraApproval.by;
      if (verified) verifiedInfraPlan = evidence;
    } else {
      // A board approval for an older head: carried over when the head is
      // plan-neutral, else the block below becomes "approve again".
      let staleReason: string | null = null;
      // Why no automatic branch update was made, appended to the stale block.
      let staleUpdateNote = "";
      if (infraApproval.state === "stale") {
        const carry = await infraApprovalCarryOver(repo.fullName, infraApproval.sha, live.headSha, row.infraMergeApprovedEvidence, files, await prDiff(), () => Promise.resolve(evidence));
        if (carry.ok) {
          try {
            await db.upsertClawsPr(repo.fullName, pr.number, { infraMergeCarriedSha: live.headSha, infraMergeCarriedNote: carry.note });
          } catch (err) {
            log.warn(`[auto-merger] Could not record the carried-over infra approval on ${repo.fullName}#${pr.number}: ${err}`);
          }
          const was = infraApproval.sha ? infraApproval.sha.slice(0, 7) : "an unknown head";
          log.info(`[auto-merger] ${repo.fullName}#${pr.number}: infra approval by ${infraApproval.by} for ${was} carried over to ${sha7} (${carry.note})`);
          const blocked = await requireCleanReview("infra approval carried over");
          if (blocked !== null) return blocked;
          infraMergeApprovedBy = infraApproval.by;
          if (verified) verifiedInfraPlan = evidence;
        } else {
          staleReason = carry.reason;
          if (carry.kind === "plan-differs") {
            const update = await updateStaleInfraBranch(repo, pr, row, live.headSha, carry, files);
            if (update.updated) {
              if (update.newHead) liveHead = update.newHead;
              return block("infra-branch-update", `skipped: ${update.reason}`, { reason: update.reason });
            }
            if ("queueHeld" in update) {
              return block("ci-queue-deep", `skipped: infra approval for ${sha7} is stale and its branch update is held for ${repo.fullName}'s deep CI queue`, {
                notify: false,
                reason: update.queueHeld,
              });
            }
            staleUpdateNote = ` ${update.note}`;
          } else if (
            carry.kind === "plan-unavailable" && (row.infraBranchUpdates ?? 0) > 0
            && row.infraBranchUpdateFromSha && row.infraBranchUpdateFromSha !== live.headSha
          ) {
            // The head moved off the one the automatic update started from (the
            // update's merge commit, or a later push onto it): wait for its plan
            // rather than ask again — unless its checks failed, so the re-plan
            // will not report and the operator must see the PR.
            if (live.checkStatus === "failing") {
              staleUpdateNote = ` The re-plan after the automatic branch update did not report: checks on ${sha7} are failing.`;
            } else {
              const k = row.infraBranchUpdates ?? 0;
              // Keep the update sweep's wording (behind count and drift) while the head is the one it named.
              const reason = row.mergeSkipCode === "infra-branch-update" && row.mergeSkipReason && row.mergeSkipHead === live.headSha
                ? row.mergeSkipReason
                : `Claws updated this branch onto \`${pr.baseRefName}\` (automatic update ${k} of ${INFRA_BRANCH_UPDATE_BUDGET}); waiting for the Tofu plan of ${sha7}.`;
              return block("infra-branch-update", `skipped: waiting for the Tofu plan of ${sha7} after an automatic branch update`, { reason });
            }
          }
        }
      }
      if (infraMergeApprovedBy === undefined) {
        await dropNoopLabel();
        if (infraApproval.state === "current" || infraApproval.state === "carried") {
          // Approved for (or carried over to) this head, but for a different
          // need or plan than the head now shows.
          const approvedAs = parseInfraMergeApprovedEvidence(row.infraMergeApprovedEvidence)?.need;
          const hold = infraApprovalHold(need, evidence, workflowFiles, sha7);
          const was = approvedAs ? `approved as ${approvedAs}` : "approved before its plan was recorded";
          return block(hold.code, `skipped: infra approval by ${infraApproval.by} for ${sha7} was ${was}; the head now needs ${need} approval: ${hold.log} (${paths})`, {
            reason: `The infra approval by ${infraApproval.by} for ${sha7} does not cover what the head now needs. ${hold.reason}`,
            ...(hold.code === "infra-plan" ? { notify: false } : {}),
          });
        }
        if (infraApproval.state === "stale" && staleReason !== null) {
          const was = infraApproval.sha ? infraApproval.sha.slice(0, 7) : "an unknown head";
          return block("infra-approval-stale", `skipped: infra approval by ${infraApproval.by} for ${was} not carried over to ${sha7}: ${staleReason} (${paths})`, {
            reason: `${INFRA_APPROVAL_NOT_CARRIED}${staleReason}; approve it again on the board.${staleUpdateNote}`,
          });
        }
        const hold = infraApprovalHold(need, evidence, workflowFiles, sha7);
        return block(hold.code, `skipped: ${hold.log} (${paths})`, { reason: hold.reason, ...(hold.code === "infra-plan" ? { notify: false } : {}) });
      }
    }
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
  const checksOk = status === "passing" || (!verifiedInfraPlan && exemptOnNone && status === "none");
  if (!checksOk) {
    if (status === "none") {
      const sha7 = live.headSha.slice(0, 7);
      if (verifiedInfraPlan) {
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

  // An earlier plan step's deploy that is red, or still running, on its
  // default branch since that step merged holds this merge — checked only now,
  // so the run reads cost nothing for a PR some other gate holds. Nothing is
  // persisted as a manual action: the next sweep re-checks and the hold lifts
  // once a later run passes (#clw_01M6RPD77S4VCG7068KVFN4GEF).
  const deployHold = await deployGateBlock(repo, row, issue);
  if (deployHold?.code === "deploy-red") {
    if (notifyBlocks) await noticeDeployHold(issue, repo.fullName, pr.number, deployHold);
    return block("deploy-red", `skipped: an earlier step's deploy is red (${deployHold.slug})`, {
      reportUnapproved: true,
      reason: deployHold.reason,
    });
  }
  if (deployHold?.code === "deploy-pending") {
    return block("deploy-pending", `skipped: ${deployHold.reason}`, { notify: false, reason: deployHold.reason });
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

  // Forgejo's diff stats are against the merge base, so a PR whose changes
  // already reached the base looks non-empty and its squash merge fails with
  // HTTP 500. When the base has since changed every file the PR changes,
  // merge the base into the branch first; a PR left empty is then skipped as
  // `empty` and closed by the Empty PR Closer (#clw_01M7R0YDX4K0E1JN3WW00EDM4C).
  // An image-scan prune PR is left alone: a merge commit on its branch costs
  // it the approval exemption, and the weekly scan regenerates it anyway.
  if (!gh.isForkPR(pr) && !isImageScanPrunePR(pr)) {
    const base = pr.baseRefName;
    const coverage = await baseCoversPrFiles(repo, pr, live.headSha, await changedFiles());
    if (coverage === "covered") {
      const queueHold = await branchUpdateHold(repo, pr);
      if (queueHold) {
        return block("ci-queue-deep", `skipped: ${base} covers every changed file, but ${queueHold.waiting} CI jobs are waiting in ${repo.fullName}; holding the branch update`, {
          notify: false,
          reason: `${ciQueueHoldNote(repo.fullName, queueHold)}; Claws merges \`${base}\` into this branch once the queue drains.`,
        });
      }
      let outcome: "updated" | "conflict" | null = null;
      try {
        outcome = await gh.updatePRBranch(repo.fullName, pr.number);
      } catch (err) {
        log.warn(`[auto-merger] Could not merge ${base} into ${repo.fullName}#${pr.number}'s branch before merging: ${err}`);
      }
      if (outcome === "updated") {
        return block("base-covers-update", `skipped: merged ${base} into the branch because ${base} has since changed every file this PR changes; waiting for checks on the new head`, {
          notify: false,
          reason: `\`${base}\` has changed every file this PR changes since the branch point, so Claws merged \`${base}\` into the branch and waits for checks on the new head; a PR left with no changes is closed by the Empty PR Closer.`,
        });
      }
      if (outcome === "conflict") {
        return block("head-moved", "head moved or was not mergeable at merge time, skipping", { notify: false });
      }
    } else if (coverage === "unknown") {
      log.warn(`[auto-merger] Could not tell whether ${base} already carries ${repo.fullName}#${pr.number}'s changes; merging as usual`);
    }
  }

  gh.populateQueueCache("auto-mergeable", repo.fullName, { number: pr.number, title: pr.title, type: "pr", updatedAt: pr.updatedAt, priority: gh.hasPriorityLabel(pr.labels), labels: pr.labels.map((l) => l.name) });
  // The apply guard labels follow the verified plan: production-infra's
  // merge-time apply refuses any non-zero plan for a PR carrying
  // CLAWS_NOOP_MERGE_LABEL, and any change the PR's plan comment did not list
  // for one carrying CLAWS_ACK_MERGE_LABEL. A label that must be added and
  // cannot be fails closed; one that must go (a zero-change label left on a
  // PR whose plan now changes something) must go first.
  let ackMergeLabelled = false;
  if (verifiedInfraPlan?.state === "noop") {
    try {
      await gh.ensureLabel(repo.fullName, CLAWS_NOOP_MERGE_LABEL, {
        color: "5319e7",
        description: "Merged by Claws on a verified zero-change Tofu plan; tofu-apply refuses any non-zero plan",
      });
      await gh.addLabel(repo.fullName, pr.number, CLAWS_NOOP_MERGE_LABEL);
      noopLabelMaybe = true;
    } catch (err) {
      return block("error", `skipped: could not label the PR for the no-op apply guard (${err})`, { level: "warn", notify: false });
    }
    await dropAckLabel();
  } else if (infra.length > 0) {
    if (!(await dropNoopLabel())) {
      return block("error", `skipped: could not remove ${CLAWS_NOOP_MERGE_LABEL} before an infra merge with plan changes`, { level: "warn", notify: false });
    }
    const resourceEvidence = verifiedInfraPlan?.state === "changes"
      ? await gh.getTofuPlanResourceEvidence(repo.fullName, pr.number, live.headSha)
      : null;
    if (resourceEvidence?.state === "available") {
      try {
        await gh.ensureLabel(repo.fullName, CLAWS_ACK_MERGE_LABEL, {
          color: "5319e7",
          description: "Merged by Claws on a verified Tofu plan; tofu-apply refuses any change the PR's plan did not show",
        });
        await gh.addLabel(repo.fullName, pr.number, CLAWS_ACK_MERGE_LABEL);
        ackLabelMaybe = true;
        ackMergeLabelled = true;
        log.info(`[auto-merger] ${repo.fullName}#${pr.number}: labelled ${CLAWS_ACK_MERGE_LABEL} for the verified plan of head ${live.headSha.slice(0, 7)}`);
      } catch (err) {
        return block("error", `skipped: could not label the PR for the verified-plan apply guard (${err})`, { level: "warn", notify: false });
      }
    } else {
      await dropAckLabel();
    }
  } else {
    await dropAckLabel();
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
      if (verifiedInfraPlan?.state === "noop") await dropNoopLabel();
      await dropAckLabel();
      return block("head-moved", "head moved or was not mergeable at merge time, skipping", { notify: false });
    }
    if (verifiedInfraPlan?.state === "noop") await dropNoopLabel();
    await dropAckLabel();
    throw err;
  }
  if (ackMergeLabelled) {
    try {
      await gh.commentOnIssue(
        repo.fullName, pr.number,
        `Merged on the verified Tofu plan for head \`${live.headSha.slice(0, 7)}\`. Labelled \`${CLAWS_ACK_MERGE_LABEL}\`, so the apply refuses any change this plan did not show.`,
        { agentName: "Auto Merger" },
      );
    } catch (err) {
      log.warn(`[auto-merger] Could not comment on the verified-plan infra merge of ${repo.fullName}#${pr.number}: ${err}`);
    }
  }
  await settleMergedPrState(repo.fullName, pr.number);
  try {
    // The row's recorded issue first (#clw_01M7FC1ARKV7AYR9C0EGC26S8F), then
    // the branch / body convention for a PR with no recorded relation.
    const related: IssueRef[] = [];
    const row = await db.getClawsPr(repo.fullName, pr.number);
    for (const raw of [row?.issueRef, row?.issueId]) {
      const ref = raw ? canonicalIssueRef(raw) : null;
      if (ref !== null && ref !== 0) related.push(ref);
    }
    const linked = linkedIssueRefFromPR(pr);
    if (linked !== null && linked !== 0) related.push(linked);
    related.push(...extractRelatedNumbers(`${pr.title}\n${pr.body ?? ""}`));
    await recordPrMerged(repo.fullName, pr.number, related);
  } catch (err) {
    log.warn(`[auto-merger] Could not record pr-merged for ${repo.fullName}#${pr.number}: ${err}`);
  }
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
          ...(infraMergeApprovedBy ? { infraMergeApprovedBy } : {}),
          ...(verifiedInfraPlan ? { infraPlan: verifiedInfraPlan.state } : {}),
        },
      });
    } else {
      log.info(`[auto-merger] No completed producer task found for ${repo.fullName}#${pr.number} head ${live.headSha.slice(0, 12)}; skipping merge effectiveness signal`);
    }
  } catch (err) {
    log.warn(`[auto-merger] Could not record merge effectiveness for ${repo.fullName}#${pr.number}: ${err}`);
  }
  await announcePostMergeAction(repo, pr);

  // The PR is merged; a cleanup failure must not turn that into a thrown error.
  try {
    await finalizeMergedClawsPR(repo, pr, mergedBy);
  } catch (err) {
    log.warn(`[auto-merger] Post-merge finalize failed for ${repo.fullName}#${pr.number}: ${err}`);
  }

  return { merged: true };
}

/**
 * Post-merge cleanup for a merged `claws/issue-…` PR, regardless of which route
 * merged it (auto-merger, dashboard, or a human merging directly, which the PR
 * dispatcher's `refreshPrStore` catches): close a multi-PR issue whose every
 * step has now landed, then honour any `Closes #clw_…` line for Claws-native
 * issues. The issue comes from the PR's branch name, else from `pr.issueId`.
 * Idempotent — safe to call more than once for the same PR.
 */
export async function finalizeMergedClawsPR(
  repo: Repo,
  pr: Pick<gh.PR, "number" | "headRefName" | "body"> & { title?: string; issueId?: string | null },
  source: string,
): Promise<void> {
  // The branch names the issue; a caller with no branch on hand (a hand merge
  // `refreshPrStore` caught) passes the row's `issueId` instead.
  const match = pr.headRefName.match(ISSUE_BRANCH_RE);
  const issueRef = match ? canonicalIssueRef(match[1]!) : pr.issueId ? canonicalIssueRef(pr.issueId) : null;
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

  const row = await db.getClawsPr(repo.fullName, pr.number).catch((err) => {
    log.warn(`[${source}] Could not read the claws_prs row of ${repo.fullName}#${pr.number}: ${err}`);
    return null;
  });
  const rereadBody = await closeNativeIssuesClosedBy(repo, pr, source, row);

  // A single-step plan's PR has merged. If the issue is still open — its PR
  // said `Part of`, or the forge did not act on `Closes` — it must not fall
  // back to Planning: close it when a merged PR closes it, else park it for a
  // human (#clw_01M4EPRM9SYVGFG2BTZTMQEKDJ).
  if (issueRef !== null && phases?.kind === "single") {
    try {
      // The row's recorded relation decides for its own issue; the body only
      // for a PR with none (#clw_01M7FC1ARKV7AYR9C0EGC26S8F).
      const stored = row?.issueRelation || row?.alsoCloses?.length
        ? storedRelationFor(row, phases.issueRepo, issueRef, await trackerIdFor(phases.issueRepo, issueRef))
        : null;
      // The body `closeNativeIssuesClosedBy` just re-read, else a re-read: the
      // sweep's copy may be stale.
      const body = rereadBody ?? await gh.getPRBody(repo.fullName, pr.number);
      // A PR whose body closes the issue is already handled — by the forge, or
      // above for a native issue. A recorded relation skips this: the forge
      // may not have acted on a body that lost its line, and
      // `settleMergedSingleStep` is a no-op once the issue is closed.
      if (stored === null && extractClosedIssueRefs(body).some((ref) => sameIssueRef(ref, issueRef))) return;
      const merged = await gh.listMergedPRsForIssue(phases.issueRepo, issueRef);
      const byNumber = new Map<number, { number: number; body?: string; repo?: string; closes?: boolean }>(merged.map((m) => [m.number, m]));
      byNumber.set(pr.number, {
        number: pr.number,
        body,
        ...(repo.fullName !== phases.issueRepo ? { repo: repo.fullName } : {}),
        ...(stored !== null ? { closes: stored === "closes" } : {}),
      });
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
  row: db.ClawsPrRecord | null = null,
): Promise<string | null> {
  const recorded = !!row?.issueRelation || (row?.alsoCloses?.length ?? 0) > 0;
  // Cheap guard before the extra round trip: every merged PR reaches here —
  // Dependabot bumps, image bumps, hand-written PRs — and most never mention a
  // native issue at all. Claws' own `claws/issue-…` PRs always re-read, since
  // those are exactly the bodies an agent rewrites between the sweep and the
  // merge; for anything else, a cached body with no `clw_` in it is enough to
  // decide there is nothing to do — unless the row records a relation, which
  // decides without the body.
  if (!recorded && !pr.headRefName.startsWith("claws/issue-") && typeof pr.body === "string" && !/clw_/i.test(pr.body)) return null;
  let body: string | null;
  try {
    body = await gh.getPRBody(repo.fullName, pr.number);
  } catch (err) {
    log.warn(`[${source}] Could not re-read ${repo.fullName}#${pr.number} body to close native issues: ${err}`);
    if (!recorded) return null;
    body = null;
  }
  // The row's recorded closes, then the body's: a body line naming the row's
  // own issue is display only (the row decides it), while a body `Closes`
  // naming any other issue is still honoured.
  const ownRefs = [row?.issueRelation ? row.issueRef : null, row?.issueRelation ? row.issueId : null]
    .filter((r): r is string => !!r);
  const refs: IssueRef[] = [...storedClosedRefs(row)];
  for (const ref of body === null ? [] : extractClosedIssueRefs(body)) {
    if (ownRefs.some((own) => sameIssueRef(own, ref))) continue;
    if (!refs.some((r) => sameIssueRef(r, ref))) refs.push(ref);
  }
  for (const ref of refs) {
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
      // A plan step the operator has not marked done keeps the issue open
      // whatever the PR says; the plan closes it once the step is claimed.
      const pendingStep = await pendingOperatorStep(issue);
      if (pendingStep !== null) {
        log.info(`[${source}] Leaving native issue ${ref} open: operator step ${pendingStep} is not marked done`, { repo: repo.fullName, pr: pr.number, issue: ref });
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

/**
 * The position of a native issue's first `manual` (operator) step with no
 * `claws-phase-done:` claim, or null when every such step is claimed or the
 * stored list has none. Database reads only.
 */
async function pendingOperatorStep(issue: { id: string; repos: string[]; primary_repo?: string | null }): Promise<number | null> {
  const planned = await db.getIssuePlannedPRs(issue.id);
  const manual = planned.filter((e) => e.kind === "manual");
  if (manual.length === 0) return null;
  const repo = clawsIssues.primaryRepo(issue);
  const comments = (await clawsIssues.getIssueComments(issue.id)).map((c) => ({ body: c.body, login: c.login }));
  const claims = await parsePhaseClaims(comments, (login) => gh.isAllowedActor(login, repo, issue.id), planned.length);
  return manual.find((e) => !claims.has(e.position))?.position ?? null;
}
