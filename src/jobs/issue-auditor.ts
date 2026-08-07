import { LABELS, type Repo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as log from "../log.js";
import * as smartSchedule from "../smart-schedule.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../slack.js";
import { extractFingerprint, REPORT_HEADER as CLAWS_ERROR_REPORT_HEADER } from "./triage-claws-errors.js";
import { findPlanComment, parsePlan } from "../plan-parser.js";

const PLAN_HEADER = "## Implementation Plan";

/**
 * Identify which plan phase a merged PR implements, using title and body patterns.
 * Title: "fix(#N): Title (phaseNum/total)" → check for "(phaseNum/total)"
 * Body: "## PR phaseNum of total: Title" → check for this header
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
  | "done";

export async function classifyIssue(
  repo: Repo,
  issue: gh.Issue,
): Promise<IssueState> {
  const fullName = repo.fullName;

  // Has "Refined" label → issue-worker handles
  if (issue.labels.some((l) => l.name === LABELS.refined)) return "refined";

  // Has open Claws PR → ci-fixer/review-addresser handle
  const openPR = await gh.getOpenPRForIssue(fullName, issue.number);
  if (openPR) return "in-progress";

  // Fetch comments once — reused for the [claws-error] report check and plan scanning below
  const comments = await gh.getIssueComments(fullName, issue.number);

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

  // Check for unreacted human feedback after the plan
  const selfLogin = await gh.getSelfLogin(repo.owner);
  const commentsAfterPlan = comments.slice(lastPlanIdx + 1);

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

  // Check for stuck or completed multi-phase issues
  const mergedPRs = await gh.listMergedPRsForIssue(fullName, issue.number);
  if (mergedPRs.length > 0) {
    const planText = findPlanComment(comments.map((c) => ({ body: c.body })));
    if (planText) {
      const parsed = parsePlan(planText);
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
        if (gh.isItemSkipped(repo.fullName, issue.number)) continue;
        if (gh.hasIgnoreLabel(issue.labels)) continue;
        if (!await gh.isAllowedActor(issue.author.login)) continue;

        try {
          const state = await classifyIssue(repo, issue);

          const hasInReview = issue.labels.some((l) => l.name === LABELS.inReview);

          if (state === "in-progress") {
            if (!hasInReview) {
              await gh.addLabel(repo.fullName, issue.number, LABELS.inReview);
              fixes.push(`added In Review to ${repo.fullName}#${issue.number}`);
              repoFixes++;
            }
          } else {
            if (hasInReview) {
              await gh.removeLabel(repo.fullName, issue.number, LABELS.inReview);
              fixes.push(`removed stale In Review from ${repo.fullName}#${issue.number}`);
              repoFixes++;
            }
          }

          if (state === "ready") {
            const hasReady = issue.labels.some((l) => l.name === LABELS.ready);
            if (!hasReady) {
              await gh.addLabel(repo.fullName, issue.number, LABELS.ready);
              fixes.push(`added Ready to ${repo.fullName}#${issue.number}`);
              repoFixes++;
            }
          } else if (state === "stuck-multi-phase") {
            const hasReady = issue.labels.some((l) => l.name === LABELS.ready);
            if (!hasReady) {
              await gh.addLabel(repo.fullName, issue.number, LABELS.ready);
              fixes.push(`added Ready to stuck multi-phase ${repo.fullName}#${issue.number}`);
              repoFixes++;
            }
          } else if (state === "done") {
            await gh.closeIssue(repo.fullName, issue.number, "completed");
            fixes.push(`closed completed multi-phase ${repo.fullName}#${issue.number}`);
            repoFixes++;
          }
        } catch (err) {
          reportError("issue-auditor:classify-issue", `${repo.fullName}#${issue.number}`, err);
        }
      }

      if (repoFixes > 0) {
        log.info(`[issue-auditor] Fixed ${repoFixes} issue(s) in ${repo.fullName}`);
      }
    },
    (err) => {
      reportError("issue-auditor:audit-repo", repo.fullName, err);
    },
  );

  if (fixes.length > 0) {
    const summary = `Issue auditor (${repo.fullName}): fixed ${fixes.length} issue(s) \u2014 ${fixes.join(", ")}`;
    log.info(`[issue-auditor] ${summary}`);
    notify(summary);
  }

  return fixes;
}

export async function run(repos: Repo[]): Promise<void> {
  await Promise.allSettled(repos.map((repo) => processRepo(repo)));
}
