import { LABELS, type Repo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { processTextForImages } from "../images.js";

async function processPR(repo: Repo, pr: gh.PR, reviewData: gh.PRReviewData): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[review-addresser] Processing PR #${pr.number} in ${fullName}`);

  const taskId = db.recordTaskStart("review-addresser", fullName, pr.number, null);
  let wtPath: string | undefined;

  try {
    wtPath = await claude.createWorktreeFromBranch(repo, pr.headRefName, "review-addresser");
    db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

    const imageContext = await processTextForImages([reviewData.formatted], wtPath);

    const prompt = [
      `You are addressing PR review comments on a pull request in the repository ${fullName}.`,
      `PR #${pr.number}: ${pr.title}`,
      `Branch: ${pr.headRefName}`,
      ``,
      `The following review comments have been left on this PR:`,
      ``,
      reviewData.formatted,
      ``,
      `Please address each review comment by making the necessary code changes.`,
      `If a review comment is a question or requires no code changes, respond with a text explanation.`,
      `Always include a brief summary of what you did (or why no changes were needed) in your text output.`,
      `Make commits with clear messages as you work.`,
      imageContext,
    ].join("\n");

    const claudeOutput = await claude.enqueue(() => claude.runClaude(prompt, wtPath!), gh.hasPriorityLabel(pr.labels));

    if (await claude.hasNewCommits(wtPath, pr.headRefName)) {
      await claude.pushBranch(wtPath, pr.headRefName);
      try {
        const description = await claude.regeneratePRDescription(wtPath, pr.baseRefName, pr);
        await gh.updatePRBody(fullName, pr.number, description);
      } catch (descErr) {
        log.warn(`[review-addresser] Failed to update PR description for ${fullName}#${pr.number}: ${descErr}`);
      }
      log.info(`[review-addresser] Pushed changes for ${fullName}#${pr.number}`);
    }

    if (claudeOutput.trim()) {
      await gh.commentOnIssue(fullName, pr.number, claudeOutput.trim());
      log.info(`[review-addresser] Posted comment for ${fullName}#${pr.number}`);
    } else {
      log.warn(`[review-addresser] No response produced for ${fullName}#${pr.number}`);
    }

    // React 👍 to each addressed comment
    for (const id of reviewData.commentIds) {
      await gh.addReaction(fullName, id, "+1");
    }
    for (const id of reviewData.reviewCommentIds) {
      await gh.addReviewCommentReaction(fullName, id, "+1");
    }

    await gh.addLabel(fullName, pr.number, LABELS.ready);
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

export async function run(repos: Repo[]): Promise<void> {
  const tasks: Promise<void>[] = [];

  for (const repo of repos) {
    if (isRateLimited()) break;
    try {
      const prs = await gh.listPRs(repo.fullName);
      for (const pr of prs) {
        if (gh.isItemSkipped(repo.fullName, pr.number)) continue;
        // Only process Claws PRs
        if (!pr.headRefName.startsWith("claws/")) continue;

        const reviewData = await gh.getPRReviewComments(repo.fullName, pr.number);
        if (!reviewData.formatted || (reviewData.commentIds.length === 0 && reviewData.reviewCommentIds.length === 0)) {
          continue;
        }

        gh.populateQueueCache("needs-review-addressing", repo.fullName, { number: pr.number, title: pr.title, type: "pr", updatedAt: pr.updatedAt, priority: gh.hasPriorityLabel(pr.labels) });
        await gh.removeLabel(repo.fullName, pr.number, LABELS.ready);
        tasks.push(
          processPR(repo, pr, reviewData).catch((err) =>
            reportError("review-addresser:process-pr", `${repo.fullName}#${pr.number}`, err),
          ),
        );
      }
    } catch (err) {
      reportError("review-addresser:list-prs", repo.fullName, err);
    }
  }

  await Promise.allSettled(tasks);
}
