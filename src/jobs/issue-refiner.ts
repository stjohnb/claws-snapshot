import { LABELS, type Repo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { processTextForImages } from "../images.js";
import { extractGameId, REPORT_HEADER as KWYJIBO_REPORT_HEADER } from "./triage-kwyjibo-errors.js";
import { extractFingerprint, REPORT_HEADER as CLAWS_ERROR_REPORT_HEADER } from "./triage-claws-errors.js";

const PLAN_HEADER = "## Implementation Plan";

function isCiUnrelatedIssue(issue: gh.Issue): boolean {
  return issue.title.startsWith("[ci-unrelated]");
}

const MULTI_PR_INSTRUCTIONS = [
  `Prefer a single PR. Do not split work into multiple PRs just because the change`,
  `touches several files or is moderately large. A single PR is easier to review,`,
  `test, and deploy. Only use multiple PRs when the work is genuinely too large or`,
  `risky to ship atomically — for example, a schema migration that must be deployed`,
  `before the code that depends on it, or a change that exceeds ~800 lines across`,
  `more than 15 files.`,
  ``,
  `If you do need multiple PRs, use this exact format:`,
  ``,
  `### PR 1: [short title]`,
  `[description, files, changes for this PR]`,
  ``,
  `### PR 2: [short title]`,
  `[description, files, changes for this PR]`,
  ``,
  `Each PR must be independently deployable and functional.`,
  `If the change is small enough for a single PR, you do not need to use this format.`,
].join("\n");

function buildRefinementPrompt(
  fullName: string,
  issue: gh.Issue,
  existingPlan: string,
  feedback: gh.IssueComment[],
): string {
  return [
    `You are analyzing a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${issue.title}`,
    ``,
    issue.body || "(No description provided)",
    ``,
    `A previous implementation plan was produced:`,
    ``,
    existingPlan,
    ``,
    ...(feedback.length > 0
      ? [
          `The following feedback was provided on the plan:`,
          ``,
          ...feedback.flatMap((f) => {
            const label = gh.isClawsComment(f.body)
              ? `Comment by @${f.login} (automated by Claws):`
              : `Comment by @${f.login}:`;
            return [`---`, label, gh.stripClawsMarker(f.body), ``];
          }),
        ]
      : [`No specific feedback comments were provided. Re-evaluate the plan for completeness and correctness.`, ``]),
    ``,
    `If \`docs/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant to the issue) for context about the codebase architecture and patterns.`,
    ``,
    `Please produce an updated implementation plan that addresses the feedback.`,
    `Include:`,
    `- Which files need to be changed`,
    `- What the changes should be`,
    `- Any potential risks or edge cases`,
    `- A suggested order of implementation`,
    ``,
    MULTI_PR_INSTRUCTIONS,
    ``,
    `If there were any surprises or deviations while addressing the feedback, explain them briefly in a separate section at the end of your response, prefixed with \`### Note\``,
    ``,
    `Do NOT make any code changes. Only produce the plan as text output.`,
  ].join("\n");
}

function buildFollowUpPrompt(
  fullName: string,
  issue: gh.Issue,
  existingPlan: string,
  openPRNumber: number,
  followUpComments: gh.IssueComment[],
): string {
  return [
    `You are responding to follow-up questions on a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${issue.title}`,
    ``,
    issue.body || "(No description provided)",
    ``,
    `An implementation plan was already produced and a PR #${openPRNumber} is open to implement it.`,
    ``,
    `Here is the existing plan:`,
    ``,
    existingPlan,
    ``,
    `The following follow-up comments were posted after the plan:`,
    ``,
    ...followUpComments.flatMap((f) => {
      const label = gh.isClawsComment(f.body)
        ? `Comment by @${f.login} (automated by Claws):`
        : `Comment by @${f.login}:`;
      return [`---`, label, gh.stripClawsMarker(f.body), ``];
    }),
    ``,
    `If \`docs/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant) for context about the codebase architecture and patterns.`,
    ``,
    `Please respond to the follow-up comments above. Answer questions, provide clarifications, or address concerns.`,
    `Do NOT produce a new implementation plan — the implementation is already in progress via PR #${openPRNumber}.`,
    `If the comments suggest changes that should be made to the PR, mention that in your response.`,
    ``,
    `Do NOT make any code changes. Only produce your response as text output.`,
  ].join("\n");
}

function buildNewPlanPrompt(fullName: string, issue: gh.Issue, comments: gh.IssueComment[]): string {
  return [
    `You are analyzing a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${issue.title}`,
    ``,
    issue.body || "(No description provided)",
    ``,
    ...comments.flatMap((c) => {
      const label = gh.isClawsComment(c.body)
        ? `Comment by @${c.login} (automated by Claws):`
        : `Comment by @${c.login}:`;
      return [`---`, label, gh.stripClawsMarker(c.body), ``];
    }),
    `If \`docs/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant to the issue) for context about the codebase architecture and patterns.`,
    ``,
    `Please produce a detailed implementation plan for this issue.`,
    `Include:`,
    `- Which files need to be changed`,
    `- What the changes should be`,
    `- Any potential risks or edge cases`,
    `- A suggested order of implementation`,
    ``,
    MULTI_PR_INSTRUCTIONS,
    ``,
    `Do NOT make any code changes. Only produce the plan as text output.`,
  ].join("\n");
}

async function processIssue(repo: Repo, issue: gh.Issue): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Planning ${fullName}#${issue.number}: ${issue.title}`);

  const taskId = db.recordTaskStart("issue-refiner", fullName, issue.number, null);
  let wtPath: string | undefined;

  try {
    const branchName = `claws/plan-${issue.number}-${claude.randomSuffix()}`;
    wtPath = await claude.createWorktree(repo, branchName, "issue-refiner");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    const comments = await gh.getIssueComments(fullName, issue.number);
    const imageContext = await processTextForImages([issue.body, ...comments.map((c) => c.body)], wtPath);
    const prompt = buildNewPlanPrompt(fullName, issue, comments) + imageContext;

    const planOutput = await claude.enqueue(() => claude.runClaude(prompt, wtPath!), gh.hasPriorityLabel(issue.labels));

    if (planOutput.trim()) {
      await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${planOutput}`);
      log.info(`[issue-refiner] Posted plan for ${fullName}#${issue.number}`);
    } else {
      log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
    }

    await gh.addLabel(fullName, issue.number, LABELS.ready);

    if (isCiUnrelatedIssue(issue)) {
      await gh.addLabel(fullName, issue.number, LABELS.refined);
      log.info(`[issue-refiner] Auto-refined ci-unrelated issue ${fullName}#${issue.number}`);
    }

    db.recordTaskComplete(taskId);
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    throw err;
  } finally {
    if (wtPath) {
      await claude.removeWorktree(repo, wtPath);
    }
  }
}

async function processRefinement(
  repo: Repo,
  issue: gh.Issue,
  unreactedComments: gh.IssueComment[],
): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Refining plan for ${fullName}#${issue.number}: ${issue.title}`);

  const taskId = db.recordTaskStart("issue-refiner", fullName, issue.number, null);
  let wtPath: string | undefined;

  try {
    const branchName = `claws/plan-${issue.number}-${claude.randomSuffix()}`;
    wtPath = await claude.createWorktree(repo, branchName, "issue-refiner");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    const comments = await gh.getIssueComments(fullName, issue.number);
    const lastPlanIdx = comments.findLastIndex((c) => c.body.includes(PLAN_HEADER));

    if (lastPlanIdx === -1) {
      log.warn(`[issue-refiner] No plan comment found for ${fullName}#${issue.number}, posting fresh plan`);
      const imageContext = await processTextForImages([issue.body, ...comments.map((c) => c.body)], wtPath);
      const prompt = buildNewPlanPrompt(fullName, issue, comments) + imageContext;
      const planOutput = await claude.enqueue(() => claude.runClaude(prompt, wtPath!), gh.hasPriorityLabel(issue.labels));

      if (planOutput.trim()) {
        await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${planOutput}`);
        log.info(`[issue-refiner] Posted fresh plan for ${fullName}#${issue.number}`);
      } else {
        log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
      }
    } else {
      const planComment = comments[lastPlanIdx];
      const feedback = unreactedComments;

      const imageContext = await processTextForImages([issue.body], wtPath);
      const prompt = buildRefinementPrompt(fullName, issue, planComment.body, feedback) + imageContext;
      const planOutput = await claude.enqueue(() => claude.runClaude(prompt, wtPath!), gh.hasPriorityLabel(issue.labels));

      if (planOutput.trim()) {
        // Check for "### Note" section to post separately
        const noteMatch = planOutput.match(/### Note\s*\n([\s\S]*)$/);
        const planBody = noteMatch
          ? planOutput.slice(0, noteMatch.index).trim()
          : planOutput;

        await gh.editIssueComment(fullName, planComment.id, `${PLAN_HEADER}\n\n${planBody}`);
        log.info(`[issue-refiner] Updated plan comment for ${fullName}#${issue.number}`);

        if (noteMatch) {
          await gh.commentOnIssue(fullName, issue.number, `### Note\n${noteMatch[1].trim()}`);
          log.info(`[issue-refiner] Posted note comment for ${fullName}#${issue.number}`);
        }
      } else {
        log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
      }
    }

    // React 👍 to each addressed comment
    for (const comment of unreactedComments) {
      await gh.addReaction(fullName, comment.id, "+1");
    }

    await gh.addLabel(fullName, issue.number, LABELS.ready);
    db.recordTaskComplete(taskId);
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    throw err;
  } finally {
    if (wtPath) {
      await claude.removeWorktree(repo, wtPath);
    }
  }
}

async function processFollowUp(
  repo: Repo,
  issue: gh.Issue,
  openPRNumber: number,
  unreactedComments: gh.IssueComment[],
): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Responding to follow-up on ${fullName}#${issue.number}: ${issue.title}`);

  const taskId = db.recordTaskStart("issue-refiner", fullName, issue.number, null);
  let wtPath: string | undefined;

  try {
    const branchName = `claws/plan-${issue.number}-${claude.randomSuffix()}`;
    wtPath = await claude.createWorktree(repo, branchName, "issue-refiner");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    const comments = await gh.getIssueComments(fullName, issue.number);
    const lastPlanIdx = comments.findLastIndex(
      (c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body),
    );

    if (lastPlanIdx === -1) {
      log.warn(`[issue-refiner] No plan comment found for follow-up on ${fullName}#${issue.number}, skipping`);
      db.recordTaskComplete(taskId);
      return;
    }

    const planComment = comments[lastPlanIdx];
    const imageContext = await processTextForImages([issue.body], wtPath);
    const prompt = buildFollowUpPrompt(fullName, issue, planComment.body, openPRNumber, unreactedComments) + imageContext;

    const response = await claude.enqueue(() => claude.runClaude(prompt, wtPath!), gh.hasPriorityLabel(issue.labels));

    if (response.trim()) {
      await gh.commentOnIssue(fullName, issue.number, response);
      log.info(`[issue-refiner] Posted follow-up response for ${fullName}#${issue.number}`);
    } else {
      log.warn(`[issue-refiner] Empty follow-up response for ${fullName}#${issue.number}`);
    }

    for (const comment of unreactedComments) {
      await gh.addReaction(fullName, comment.id, "+1");
    }

    db.recordTaskComplete(taskId);
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    throw err;
  } finally {
    if (wtPath) {
      await claude.removeWorktree(repo, wtPath);
    }
  }
}

async function findUnreactedHumanComments(
  fullName: string,
  commentsAfterPlan: gh.IssueComment[],
  selfLogin: string,
): Promise<gh.IssueComment[]> {
  const unreacted: gh.IssueComment[] = [];
  for (const comment of commentsAfterPlan) {
    if (gh.isClawsComment(comment.body)) continue;
    if (comment.login.endsWith("[bot]")) continue;
    try {
      const reactions = await gh.getCommentReactions(fullName, comment.id);
      const hasReaction = reactions.some(
        (r) => r.user.login === selfLogin && r.content === "+1",
      );
      if (!hasReaction) {
        unreacted.push(comment);
      }
    } catch {
      unreacted.push(comment);
    }
  }
  return unreacted;
}

export async function run(repos: Repo[]): Promise<void> {
  const tasks: Promise<void>[] = [];

  for (const repo of repos) {
    if (isRateLimited()) break;
    try {
      const issues = await gh.listOpenIssues(repo.fullName);
      const selfLogin = await gh.getSelfLogin();

      for (const issue of issues) {
        if (isRateLimited()) break;
        if (gh.isItemSkipped(repo.fullName, issue.number)) continue;

        // Skip issues with "Refined" label (being implemented)
        if (issue.labels.some((l) => l.name === LABELS.refined)) continue;

        // Check for follow-up comments on issues with an open PR
        const openPR = await gh.getOpenPRForIssue(repo.fullName, issue.number);
        if (openPR) {
          const comments = await gh.getIssueComments(repo.fullName, issue.number);
          const lastPlanIdx = comments.findLastIndex(
            (c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body),
          );
          if (lastPlanIdx !== -1) {
            const commentsAfterPlan = comments.slice(lastPlanIdx + 1);
            const unreactedComments = await findUnreactedHumanComments(repo.fullName, commentsAfterPlan, selfLogin);
            if (unreactedComments.length > 0) {
              gh.populateQueueCache("needs-refinement", repo.fullName, { number: issue.number, title: issue.title, type: "issue", updatedAt: issue.updatedAt, priority: gh.hasPriorityLabel(issue.labels) });
              tasks.push(
                processFollowUp(repo, issue, openPR.number, unreactedComments).catch((err) =>
                  reportError("issue-refiner:process-follow-up", `${repo.fullName}#${issue.number}`, err),
                ),
              );
            }
          }
          continue;
        }

        // Triage-before-refinement: skip [claws-error] issues without triage report
        if (extractFingerprint(issue.title) !== null) {
          const comments = await gh.getIssueComments(repo.fullName, issue.number);
          const hasReport = comments.some((c) => c.body.includes(CLAWS_ERROR_REPORT_HEADER));
          if (!hasReport) continue;
        }

        // Triage-before-refinement: skip game-ID issues without triage report
        if (issue.body && extractGameId(issue.body) !== null) {
          const comments = await gh.getIssueComments(repo.fullName, issue.number);
          const hasReport = comments.some((c) => c.body.includes(KWYJIBO_REPORT_HEADER));
          if (!hasReport) continue;
        }

        // Fetch comments to determine state
        const comments = await gh.getIssueComments(repo.fullName, issue.number);
        const lastPlanIdx = comments.findLastIndex(
          (c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body),
        );

        if (lastPlanIdx === -1) {
          // No plan comment exists — produce a new plan
          gh.populateQueueCache("needs-refinement", repo.fullName, { number: issue.number, title: issue.title, type: "issue", updatedAt: issue.updatedAt, priority: gh.hasPriorityLabel(issue.labels) });
          tasks.push(
            processIssue(repo, issue).catch((err) =>
              reportError("issue-refiner:process-issue", `${repo.fullName}#${issue.number}`, err),
            ),
          );
        } else {
          // Plan exists — check for unreacted human comments after the plan
          const commentsAfterPlan = comments.slice(lastPlanIdx + 1);
          const unreactedComments = await findUnreactedHumanComments(repo.fullName, commentsAfterPlan, selfLogin);

          if (unreactedComments.length > 0) {
            // Human feedback needs addressing
            gh.populateQueueCache("needs-refinement", repo.fullName, { number: issue.number, title: issue.title, type: "issue", updatedAt: issue.updatedAt, priority: gh.hasPriorityLabel(issue.labels) });
            await gh.removeLabel(repo.fullName, issue.number, LABELS.ready);
            tasks.push(
              processRefinement(repo, issue, unreactedComments).catch((err) =>
                reportError("issue-refiner:process-refinement", `${repo.fullName}#${issue.number}`, err),
              ),
            );
          } else {
            // All feedback addressed — waiting for "Refined" or more feedback
            gh.populateQueueCache("ready", repo.fullName, { number: issue.number, title: issue.title, type: "issue", updatedAt: issue.updatedAt, priority: gh.hasPriorityLabel(issue.labels) });
            if (isCiUnrelatedIssue(issue) && !issue.labels.some((l) => l.name === LABELS.refined)) {
              await gh.addLabel(repo.fullName, issue.number, LABELS.refined);
              log.info(`[issue-refiner] Auto-refined ci-unrelated issue ${repo.fullName}#${issue.number}`);
            }
          }
        }
      }
    } catch (err) {
      reportError("issue-refiner:list-issues", repo.fullName, err);
    }
  }

  await Promise.allSettled(tasks);
}
