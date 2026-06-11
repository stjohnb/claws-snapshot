import { LABELS, type Repo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { handleTimeoutIfApplicable, getItemTimeoutMs } from "../timeout-handler.js";
import { guardContent } from "../prompt-guard.js";
import { getModel } from "../model-selector.js";

const QA_TRIGGER_RE = /^\s*qa\s+this\s*$/i;

async function processPR(
  repo: Repo,
  pr: gh.PR,
  triggerCommentId: number,
  deploymentUrl: string,
): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[qa-phase] Processing PR #${pr.number} in ${fullName}`);

  await db.withTaskRecording("qa-phase", fullName, pr.number, null, async (taskId) => {
    // React 👀 immediately to prevent duplicate runs
    await gh.addReaction(fullName, triggerCommentId, "eyes");

    const result = await claude.withExistingWorktree(
      repo, pr.headRefName, "qa-phase",
      async (wtPath) => {
        db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

    // Gather context
    const prBody = await gh.getPRBody(fullName, pr.number);
    const prWithBody: gh.PR = { ...pr, body: prBody };
    const linkedIssueNumber = gh.getLinkedIssueNumber(prWithBody);

    let issueContext = "";
    if (linkedIssueNumber) {
      try {
        const issueBody = await gh.getIssueBody(fullName, linkedIssueNumber);
        const guardedIssueBody = guardContent(issueBody, { repo: fullName, source: "issue-body", itemNumber: linkedIssueNumber });
        const truncatedIssueBody = guardedIssueBody.slice(0, 5_000);
        issueContext = [
          `## Original Issue`,
          ``,
          `The PR was created to address this issue:`,
          ``,
          `**Issue #${linkedIssueNumber}**:`,
          truncatedIssueBody,
          ``,
        ].join("\n");
      } catch (err) {
        log.warn(`[qa-phase] Could not fetch linked issue #${linkedIssueNumber}: ${err}`);
      }
    }

    // Get diff
    let diff = "";
    try {
      diff = await claude.git(["diff", `origin/${pr.baseRefName}...HEAD`], wtPath);
    } catch {
      // May fail if base branch is not fetched
    }
    const truncatedDiff = diff.slice(0, 15_000);

    // Get changed files
    const changedFiles = await gh.getPRChangedFiles(fullName, pr.number);
    const changedFilesList = changedFiles.join("\n");

    // Write MCP config with Claws state + Playwright
    const mcpConfigPath = claude.writeClawsMcpConfig(wtPath, {
      additionalServers: {
        playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
      },
    });

    // Build context-aware prompt
    const guard = (text: string, source: string) =>
      guardContent(text, { repo: fullName, source, itemNumber: pr.number });
    const guardedPrBody = guard(prBody || "", "pr-body");
    const truncatedPrBody = guardedPrBody.slice(0, 3_000);

    const prompt = [
      `You are performing exploratory QA on a deployed web application using a real browser.`,
      ``,
      `**Repository**: ${fullName}`,
      `**PR #${pr.number}**: ${guard(pr.title, "pr-title")}`,
      `**Preview URL**: ${deploymentUrl}`,
      ``,
      issueContext,
      `## PR Description`,
      ``,
      truncatedPrBody,
      ``,
      `## What Changed`,
      ``,
      `Files changed:`,
      changedFilesList,
      ``,
      `Diff (truncated):`,
      "```",
      truncatedDiff,
      "```",
      ``,
      `## Instructions`,
      ``,
      `1. If \`docs/OVERVIEW.md\` exists in this repository, read it for context about the application architecture.`,
      `2. Read any other documentation files that seem relevant to understanding the feature being tested.`,
      `3. Based on the issue and PR above, identify the specific feature or bug fix being delivered.`,
      `4. Use the Playwright browser tools to navigate to the preview URL.`,
      `5. Test the specific feature/fix described in the issue and PR:`,
      `   - Verify the expected behavior works correctly`,
      `   - Try edge cases related to the specific change`,
      `   - Test error scenarios relevant to this feature`,
      `   - Check that the feature integrates well with surrounding UI`,
      `6. Take screenshots of any issues you find.`,
      `7. Report your findings in this format:`,
      ``,
      `## QA Report for PR #${pr.number}`,
      ``,
      `### What Was Tested`,
      `[Describe the specific feature/fix you tested, based on the issue and PR]`,
      ``,
      `### Working as Expected`,
      `- [list what works correctly]`,
      ``,
      `### Issues Found`,
      `- [list any bugs, broken flows, or unexpected behavior -- or "None"]`,
      ``,
      `### Edge Cases Tested`,
      `- [list edge cases you tried and their results]`,
      ``,
      `### Summary`,
      `[overall assessment: pass / pass with notes / issues found]`,
    ].join("\n");

    const timeoutMs = getItemTimeoutMs(fullName, pr.number);
    const model = getModel("sonnet", "text-only", "opencode");
    db.updateTaskModel(taskId, model);
    let taskTokensUsed: number | undefined;
    let taskCostUsd: number | undefined;
    const claudeOutput = await claude.runClaude(prompt, wtPath!, { capability: "text-only", mcpConfig: mcpConfigPath, timeoutMs, tier: "sonnet", model, agent: "plan", envSanitization: "passthrough", onTokensUsed: (t, c) => { taskTokensUsed = t; taskCostUsd = c; } });
    if (taskTokensUsed !== undefined && taskCostUsd !== undefined) {
      db.updateTaskTokenUsage(taskId, taskTokensUsed, taskCostUsd);
    }

    if (claudeOutput.trim()) {
      await gh.commentOnIssue(fullName, pr.number, claudeOutput.trim());
      log.info(`[qa-phase] Posted QA report for ${fullName}#${pr.number}`);
    } else {
      log.warn(`[qa-phase] No QA report produced for ${fullName}#${pr.number}`);
    }

    await gh.addLabel(fullName, pr.number, LABELS.ready);
    db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "updated" });
      },
      { detach: true },
    );

    if (result === null) {
      log.info(`[qa-phase] Branch ${pr.headRefName} no longer exists for PR #${pr.number} in ${fullName} — skipping (likely merged/closed)`);
      db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "skipped" });
    }
  });
}

export async function run(repos: Repo[]): Promise<void> {
  const tasks: Promise<void>[] = [];

  for (const repo of repos) {
    if (isRateLimited()) break;
    try {
      const selfLogin = await gh.getSelfLogin(repo.owner);
      const prs = await gh.listPRs(repo.fullName);
      for (const pr of prs) {
        if (gh.isItemSkipped(repo.fullName, pr.number)) continue;
        if (gh.hasIgnoreLabel(pr.labels)) continue;
        if (gh.isForkPR(pr)) continue;
        if (!await gh.isAllowedActor(pr.author.login)) continue;

        // Look for "QA this" trigger comment
        const comments = await gh.getIssueComments(repo.fullName, pr.number);
        let triggerComment: gh.IssueComment | null = null;

        for (const comment of comments) {
          if (comment.login === selfLogin) continue;
          if (!QA_TRIGGER_RE.test(comment.body)) continue;

          // Check if Claws already reacted 👀
          const reactions = await gh.getCommentReactions(repo.fullName, comment.id);
          const alreadyProcessed = reactions.some(
            (r) => r.user.login === selfLogin && r.content === "eyes",
          );
          if (alreadyProcessed) continue;

          triggerComment = comment;
          break;
        }

        if (!triggerComment) continue;

        // Discover deployment URL
        const headSHA = await gh.getPRHeadSHA(repo.fullName, pr.number);
        const deploymentUrl = await gh.getDeploymentUrl(repo.fullName, headSHA, pr.number);
        if (!deploymentUrl) {
          log.warn(`[qa-phase] No deployment URL found for ${repo.fullName}#${pr.number} — will retry next cycle`);
          continue;
        }

        gh.populateQueueCache("needs-qa", repo.fullName, {
          number: pr.number,
          title: pr.title,
          type: "pr",
          updatedAt: pr.updatedAt,
          priority: gh.hasPriorityLabel(pr.labels),
          labels: pr.labels.map((l) => l.name),
        });

        tasks.push(
          processPR(repo, pr, triggerComment.id, deploymentUrl).catch(async (err) => {
            await handleTimeoutIfApplicable("qa-phase", repo.fullName, pr.number, err);
            reportError("qa-phase:process-pr", `${repo.fullName}#${pr.number}`, err);
          }),
        );
      }
    } catch (err) {
      reportError("qa-phase:list-prs", repo.fullName, err);
    }
  }

  await Promise.allSettled(tasks);
}
