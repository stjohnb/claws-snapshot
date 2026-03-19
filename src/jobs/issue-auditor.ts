import { LABELS, type Repo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../slack.js";
import { extractGameId, REPORT_HEADER as KWYJIBO_REPORT_HEADER } from "./triage-kwyjibo-errors.js";
import { extractFingerprint, REPORT_HEADER as CLAWS_ERROR_REPORT_HEADER } from "./triage-claws-errors.js";
import { findPlanComment, parsePlan } from "../plan-parser.js";

const PLAN_HEADER = "## Implementation Plan";

type IssueState =
  | "refined"
  | "in-progress"
  | "needs-triage"
  | "needs-refinement"
  | "ready"
  | "stuck-multi-phase";

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

  // [claws-error] without investigation report → triage handles
  if (extractFingerprint(issue.title) !== null) {
    const comments = await gh.getIssueComments(fullName, issue.number);
    const hasReport = comments.some((c) => c.body.includes(CLAWS_ERROR_REPORT_HEADER));
    if (!hasReport) return "needs-triage";
  }

  // Game-ID without investigation report → triage handles
  if (issue.body && extractGameId(issue.body) !== null) {
    const comments = await gh.getIssueComments(fullName, issue.number);
    const hasReport = comments.some((c) => c.body.includes(KWYJIBO_REPORT_HEADER));
    if (!hasReport) return "needs-triage";
  }

  // Fetch comments to check plan state
  const comments = await gh.getIssueComments(fullName, issue.number);

  // Find the last Claws plan comment (matching refiner's stricter check)
  const lastPlanIdx = comments.findLastIndex(
    (c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body),
  );

  // No plan → needs-refinement (refiner handles)
  if (lastPlanIdx === -1) return "needs-refinement";

  // Check for unreacted human feedback after the plan
  const selfLogin = await gh.getSelfLogin();
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

  // Check for stuck multi-phase issues
  const mergedPRs = await gh.listMergedPRsForIssue(fullName, issue.number);
  if (mergedPRs.length > 0) {
    const planText = findPlanComment(comments.map((c) => ({ body: c.body })));
    if (planText) {
      const parsed = parsePlan(planText);
      if (
        parsed.totalPhases > 1 &&
        mergedPRs.length < parsed.totalPhases &&
        !issue.labels.some((l) => l.name === LABELS.refined)
      ) {
        return "stuck-multi-phase";
      }
    }
  }

  // Plan exists, all feedback addressed → should be ready
  return "ready";
}

export async function run(repos: Repo[]): Promise<void> {
  const fixes: string[] = [];

  for (const repo of repos) {
    if (isRateLimited()) break;

    try {
      const issues = await gh.listOpenIssues(repo.fullName);
      let repoFixes = 0;

      for (const issue of issues) {
        if (isRateLimited()) break;

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
          }
        } catch (err) {
          reportError("issue-auditor:classify-issue", `${repo.fullName}#${issue.number}`, err);
        }
      }

      if (repoFixes > 0) {
        log.info(`[issue-auditor] Fixed ${repoFixes} issue(s) in ${repo.fullName}`);
      }
    } catch (err) {
      reportError("issue-auditor:audit-repo", repo.fullName, err);
    }
  }

  if (fixes.length > 0) {
    const summary = `Issue auditor: fixed ${fixes.length} issue(s) \u2014 ${fixes.join(", ")}`;
    log.info(`[issue-auditor] ${summary}`);
    notify(summary);
  }
}
