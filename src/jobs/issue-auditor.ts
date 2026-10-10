import { LABELS, SELF_REPO, isClawsIssueId, type Repo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as log from "../log.js";
import * as smartSchedule from "../smart-schedule.js";
import { reportError } from "../error-reporter.js";
import { extractFingerprint, REPORT_HEADER as CLAWS_ERROR_REPORT_HEADER } from "./triage-claws-errors.js";
import { findPlanComment, parsePlan } from "../plan-parser.js";
import { selectFeedbackCandidates } from "../agents/issue-refiner.js";
import { closesIssue } from "../phase-coverage.js";
import { loadIssuePhaseState, loadStoredPlannedPRs, type IssuePhaseState, type StoredPlannedPRs } from "../planned-prs.js";
import { closeAlertIssueIfResolved } from "../occurrence-tracking.js";
import { findClosingPR, hasActiveAgentWork, isDuplicateToSettle, settleDuplicate, settleMergedSingleStep } from "../issue-handback.js";

const PLAN_HEADER = "## Implementation Plan";

/**
 * Identify which plan phase a merged PR implements, using title and body patterns.
 * Title: "fix: Title (phaseNum/total)" → check for "(phaseNum/total)"
 * Body: "## PR phaseNum of total: Title" → check for this header
 * The issue ref lives in the PR body/branch, not the title.
 * Returns the phase number, or null if no match.
 */
function getPRPhaseNumber(pr: gh.PR, totalPhases: number): number | null {
  const titleMatch = pr.title?.match(/\((\d+)\/(\d+)\)/);
  if (titleMatch && parseInt(titleMatch[2], 10) === totalPhases) {
    return parseInt(titleMatch[1], 10);
  }
  const bodyMatch = pr.body?.match(/##\s+PR\s+(\d+)\s+of\s+(\d+)\s*:/);
  if (bodyMatch && parseInt(bodyMatch[2], 10) === totalPhases) {
    return parseInt(bodyMatch[1], 10);
  }
  return null;
}

type IssueState =
  | "refined"
  | "in-progress"
  | "needs-triage"
  | "needs-refinement"
  | "ready"
  | "stuck-multi-phase"
  /**
   * Every PR step of a stored list has landed and only its manual (operator)
   * step is open: the issue waits for a `claws-phase-done:` or a close, so
   * nothing is relabelled.
   */
  | "awaiting-operator"
  | "done"
  /** A Claws-native issue whose single `claws/issue-<id>-` PR merged saying it closes it. */
  | "done-native"
  /** Carries `Duplicate`, or its plan is a `CLAWS_DUPLICATE_OF:` verdict: closed, never implemented. */
  | "duplicate"
  /**
   * A single-step plan whose merged PRs do not close the issue, with no
   * `Ready`: the work may be partial, so a human decides rather than the issue
   * sitting in Planning (#clw_01M4EPRM9SYVGFG2BTZTMQEKDJ).
   */
  | "needs-human";

/**
 * A stored PR list (claws_issue_prs) reads each linked PR in its own repo, so
 * it sees a multi-repo plan's PR in another repo that the branch-prefix
 * lookups — the issue repo's only — miss. Phase state is loaded only for a
 * list naming another repo: coverage reads every linked PR's state, and a
 * same-repo list is covered by those cheaper lookups.
 */
async function loadCrossRepoPhaseState(
  fullName: string,
  issueNumber: gh.Issue["number"],
  comments: { body: string; login: string }[] | (() => Promise<{ body: string; login: string }[]>),
): Promise<{ stored: StoredPlannedPRs | null; storedState: IssuePhaseState | null }> {
  const stored = await loadStoredPlannedPRs(fullName, issueNumber);
  const crossRepo = stored?.entries.some((e) => e.repo.toLowerCase() !== fullName.toLowerCase()) ?? false;
  if (!stored || !crossRepo) return { stored, storedState: null };
  const list = typeof comments === "function" ? await comments() : comments;
  return { stored, storedState: await loadIssuePhaseState(fullName, issueNumber, list, { stored }) };
}

/** True when a stored list's only open steps are uncovered `manual` ones and every `pr` step is done. */
function isAwaitingOperator(state: Pick<IssuePhaseState, "entries" | "coverage">): boolean {
  const entries = state.entries ?? [];
  const manual = entries.filter((e) => e.kind === "manual");
  return manual.some((e) => !state.coverage.covered.has(e.position))
    && entries.filter((e) => e.kind !== "manual").every((e) => state.coverage.done.has(e.position));
}

/**
 * Whether the auditor must leave the issue alone: skipped, parked, or authored
 * by a disallowed actor. `auditIssue` returns `[]` for these.
 */
async function isAuditExempt(repo: Repo, issue: gh.Issue): Promise<boolean> {
  if (gh.isItemSkipped(repo.fullName, issue.number)) return true;
  if (gh.isParked(issue.labels)) return true;
  return !await gh.isAllowedActor(issue.author.login, repo.fullName, issue.number);
}

export async function classifyIssue(
  repo: Repo,
  issue: gh.Issue,
): Promise<IssueState> {
  const fullName = repo.fullName;

  // Has "Refined" label → issue-worker handles
  if (issue.labels.some((l) => l.name === LABELS.refined)) return "refined";
  if (issue.labels.some((l) => l.name === LABELS.duplicate)) return "duplicate";

  // Has open Claws PR → ci-fixer/review-addresser handle
  const openPR = await gh.getOpenPRForIssue(fullName, issue.number);

  // Fetch comments once — reused for the duplicate check, the [claws-error] report check and plan scanning below
  const comments = await gh.getIssueComments(fullName, issue.number);
  if (openPR) return isDuplicateToSettle(issue.labels, comments) ? "duplicate" : "in-progress";

  const { stored, storedState } = await loadCrossRepoPhaseState(fullName, issue.number, comments);
  if (storedState && storedState.coverage.openPhases.length > 0) return "in-progress";

  // [claws-error] without investigation report → triage handles
  if (extractFingerprint(issue.title) !== null) {
    const hasReport = comments.some((c) => c.body.includes(CLAWS_ERROR_REPORT_HEADER));
    if (!hasReport) return "needs-triage";
  }

  // Find the last Claws plan comment (matching refiner's stricter check)
  const lastPlanIdx = comments.findLastIndex(
    (c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body),
  );

  // No plan → needs-refinement (refiner handles)
  if (lastPlanIdx === -1) return "needs-refinement";

  // A duplicate-verdict plan whose issue was never closed.
  if (isDuplicateToSettle(issue.labels, comments)) return "duplicate";

  // Check for unreacted human feedback after the plan
  const selfLogin = await gh.getSelfLoginForIssue(repo.fullName, issue.number);
  const commentsAfterPlan = selectFeedbackCandidates(comments, lastPlanIdx);

  for (const comment of commentsAfterPlan) {
    if (gh.isClawsComment(comment.body)) continue;
    if (comment.login.endsWith("[bot]")) continue;

    try {
      const reactions = await gh.getCommentReactions(fullName, comment.id);
      const hasReaction = reactions.some(
        (r) => r.user.login === selfLogin && r.content === "+1",
      );
      if (!hasReaction) return "needs-refinement";
    } catch {
      // Treat as unreacted to be safe
      return "needs-refinement";
    }
  }

  // A stored multi-PR list, read wherever its steps merged: every step landed
  // is done; some landed with none in flight is stuck between steps. Only
  // after the triage and feedback checks — unanswered feedback on a finished
  // plan still needs the planner. A single-PR plan keeps the `done-native`
  // check below, which also requires the merged PR to say it closes the issue.
  if (storedState && storedState.totalPhases > 1) {
    if (storedState.coverage.done.size >= storedState.totalPhases) return "done";
    if (isAwaitingOperator(storedState)) return "awaiting-operator";
    if (storedState.coverage.done.size > 0) return "stuck-multi-phase";
  }

  // Check for stuck or completed multi-phase issues
  const mergedPRs = await gh.listMergedPRsForIssue(fullName, issue.number);
  if (mergedPRs.length > 0) {
    const planText = findPlanComment(comments.map((c) => ({ body: c.body })));
    const parsedPlan = planText ? parsePlan(planText) : null;
    // A stored PR list is authoritative for the step count.
    const totalPhases = stored ? stored.entries.length : (parsedPlan?.totalPhases ?? 1);

    // Single-PR completion for a native issue. GitHub closes its own issues on
    // `Closes #N`; a `clw_…` id means nothing to either forge, so a merged
    // `claws/issue-<id>-` PR claiming to close this issue is the only signal
    // there is. Multi-phase plans keep their own accounting below.
    if (totalPhases <= 1
        && isClawsIssueId(issue.number)
        && mergedPRs.some((pr) => closesIssue(pr.body ?? "", issue.number))) {
      return "done-native";
    }

    // The same test the dispatcher's Planning backstop makes: a single-step
    // plan whose merged PRs say only `Part of` is not done, and not Planning.
    if (totalPhases <= 1
        && !issue.labels.some((l) => l.name === LABELS.ready)
        && !findClosingPR(fullName, issue.number, mergedPRs)) {
      // A queued re-plan or a running implementer is not stranded; the
      // dispatcher's Planning backstop makes the same exception.
      if (await hasActiveAgentWork(fullName, issue.number)) return "in-progress";
      return "needs-human";
    }

    if (stored && !storedState && totalPhases > 1) {
      const { coverage } = await loadIssuePhaseState(fullName, issue.number, comments, { planText, mergedPRs, stored });
      if (coverage.done.size >= totalPhases) return "done";
      if (isAwaitingOperator({ entries: stored.entries, coverage })) return "awaiting-operator";
      if (!issue.labels.some((l) => l.name === LABELS.refined)) return "stuck-multi-phase";
    } else if (!stored && parsedPlan) {
      const parsed = parsedPlan;
      if (parsed.totalPhases > 1) {
        // Match each merged PR to a plan phase by content (title/body patterns)
        const matchedPhases = new Set(
          mergedPRs
            .map((pr) => getPRPhaseNumber(pr, parsed.totalPhases))
            .filter((n): n is number => n !== null),
        );
        const allPhaseNumbers = Array.from({ length: parsed.totalPhases }, (_, i) => i + 1);

        // Primary: content matching; fallback to counting when no patterns found
        const allDone =
          matchedPhases.size > 0
            ? allPhaseNumbers.every((n) => matchedPhases.has(n))
            : mergedPRs.length >= parsed.totalPhases;

        if (allDone) {
          return "done";
        }

        if (!issue.labels.some((l) => l.name === LABELS.refined)) {
          return "stuck-multi-phase";
        }
      }
    }
  }

  // Plan exists, all feedback addressed → should be ready
  return "ready";
}

/**
 * Classify one open issue and apply the label/close fixes its state calls for.
 * Returns a description of each fix applied; an issue the auditor must not
 * touch (skipped, parked, disallowed author) or one whose classification
 * throws returns `[]`.
 */
export async function auditIssue(repo: Repo, issue: gh.Issue): Promise<string[]> {
  const fixes: string[] = [];
  if (await isAuditExempt(repo, issue)) return fixes;

  try {
    const state = await classifyIssue(repo, issue);

    if (state === "done-native") {
      await gh.closeIssue(repo.fullName, issue.number, "completed");
      fixes.push(`closed native ${repo.fullName}#${issue.number} after its PR merged`);
      return fixes;
    }

    if (state === "duplicate") {
      if (await settleDuplicate(repo.fullName, issue)) fixes.push(`closed duplicate ${repo.fullName}#${issue.number}`);
      return fixes;
    }

    if (state === "needs-human") {
      const merged = await gh.listMergedPRsForIssue(repo.fullName, issue.number);
      const outcome = await settleMergedSingleStep(repo.fullName, issue.number, merged);
      if (outcome !== "none") fixes.push(`${outcome} ${repo.fullName}#${issue.number} after its single-step PR merged without closing it`);
      return fixes;
    }

    if (state === "ready") {
      const hasReady = issue.labels.some((l) => l.name === LABELS.ready);
      if (!hasReady) {
        await gh.addLabel(repo.fullName, issue.number, LABELS.ready);
        fixes.push(`added Ready to ${repo.fullName}#${issue.number}`);
      }
    } else if (state === "stuck-multi-phase") {
      const hasReady = issue.labels.some((l) => l.name === LABELS.ready);
      if (!hasReady) {
        await gh.addLabel(repo.fullName, issue.number, LABELS.ready);
        fixes.push(`added Ready to stuck multi-phase ${repo.fullName}#${issue.number}`);
      }
    } else if (state === "awaiting-operator") {
      // Left open for the operator; the dispatcher closes it once the manual step is claimed.
    } else if (state === "done") {
      await gh.closeIssue(repo.fullName, issue.number, "completed");
      fixes.push(`closed completed multi-phase ${repo.fullName}#${issue.number}`);
    }
  } catch (err) {
    reportError("issue-auditor:classify-issue", `${repo.fullName}#${issue.number}`, err, { repo: repo.fullName });
  }
  return fixes;
}

/**
 * Title of the per-repo alert issue the retired row-versus-label comparison kept
 * in SELF_REPO. Kept only so a leftover issue is closed.
 */
export function prStoreAlertTitle(repoFullName: string): string {
  return `[pr-store] claws_prs disagrees with PR labels in ${repoFullName}`;
}

export async function processRepo(repo: Repo): Promise<string[]> {
  const fixes: string[] = [];
  await smartSchedule.withDailyRepoMarking(
    "issue-auditor",
    repo.fullName,
    async () => {
      if (isRateLimited()) return;

      const issues = await gh.listOpenIssues(repo.fullName);
      let repoFixes = 0;

      for (const issue of issues) {
        if (isRateLimited()) break;
        const issueFixes = await auditIssue(repo, issue);
        fixes.push(...issueFixes);
        repoFixes += issueFixes.length;
      }

      if (repoFixes > 0) {
        log.info(`[issue-auditor] Fixed ${repoFixes} issue(s) in ${repo.fullName}`);
      }

      if (!isRateLimited()) {
        try {
          // Phase 5 retired the claws_prs row-versus-label comparison: labels
          // are a write-only mirror. Close any alert issue it left open.
          await closeAlertIssueIfResolved({
            repo: SELF_REPO,
            title: prStoreAlertTitle(repo.fullName),
            logPrefix: "issue-auditor",
            reason: "row-versus-label comparison retired",
          });
        } catch (err) {
          reportError("issue-auditor:pr-store", repo.fullName, err, { repo: repo.fullName });
        }
      }
    },
    (err) => {
      reportError("issue-auditor:audit-repo", repo.fullName, err, { repo: repo.fullName });
    },
  );

  if (fixes.length > 0) {
    const summary = `Issue auditor (${repo.fullName}): fixed ${fixes.length} issue(s) \u2014 ${fixes.join(", ")}`;
    log.info(`[issue-auditor] ${summary}`);
  }

  return fixes;
}

export async function run(repos: Repo[]): Promise<void> {
  await Promise.allSettled(repos.map((repo) => processRepo(repo)));
}
