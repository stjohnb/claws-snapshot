import { LABELS, type Repo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { processTextForImages } from "../images.js";
import * as planParser from "../plan-parser.js";

function buildPrompt(
  fullName: string,
  issue: gh.Issue,
  plan: planParser.ParsedPlan | null,
  currentPhase: number,
  totalPhases: number,
  mergedPRs: gh.PR[],
  comments: gh.IssueComment[],
  imageContext: string,
): string {
  if (totalPhases === 1 || !plan) {
    return [
      `You are working on a GitHub issue for the repository ${fullName}.`,
      `Issue #${issue.number}: ${issue.title}`,
      ``,
      issue.body,
      ``,
      ...comments.flatMap((c) => {
        const label = gh.isClawsComment(c.body)
          ? `Comment by @${c.login} (automated by Claws):`
          : `Comment by @${c.login}:`;
        return [`---`, label, gh.stripClawsMarker(c.body), ``];
      }),
      `If \`docs/OVERVIEW.md\` exists, read it first (and any linked documents that seem relevant to the issue) for context about the codebase.`,
      ``,
      `Please implement the changes needed to resolve this issue.`,
      `Make commits with clear messages as you work.`,
      imageContext,
    ].join("\n");
  }

  const phase = plan.phases[currentPhase - 1];
  return [
    `You are working on PR ${currentPhase} of ${totalPhases} for issue #${issue.number} in ${fullName}.`,
    `Issue: ${issue.title}`,
    ``,
    `If \`docs/OVERVIEW.md\` exists, read it first (and any linked documents that seem relevant to the issue) for context about the codebase.`,
    ``,
    `## Full Plan`,
    plan.preamble,
    ...plan.phases.map((p) => `### PR ${p.phaseNumber}: ${p.title}\n${p.description}`),
    ``,
    `## Already Completed`,
    mergedPRs.length > 0
      ? mergedPRs.map((pr) => `- PR #${pr.number}: ${pr.title}`).join("\n")
      : `None yet — this is the first PR.`,
    ``,
    `## Your Task`,
    `Implement ONLY the changes for PR ${currentPhase}: ${phase.title}`,
    ``,
    phase.description,
    ``,
    `Do NOT implement changes from other phases.`,
    `Make commits with clear messages as you work.`,
    imageContext,
  ].join("\n");
}

async function postPhaseProgressComment(
  fullName: string,
  issue: gh.Issue,
  comments: gh.IssueComment[],
  mergedPRs: gh.PR[],
  currentPhase: number,
  totalPhases: number,
): Promise<void> {
  try {
    const marker = `<!-- phase-progress:${mergedPRs.length} -->`;

    // Dedup: skip if a comment with this marker already exists
    if (comments.some((c) => c.body.includes(marker))) {
      log.info(`[issue-worker] Progress comment already posted for phase ${mergedPRs.length}, skipping`);
      return;
    }

    const prList = mergedPRs
      .map((pr) => `- PR #${pr.number}: ${pr.title}`)
      .join("\n");

    const body = [
      `## Phase Progress`,
      ``,
      `**Completed (${mergedPRs.length}/${totalPhases}):**`,
      prList,
      ``,
      `**Next:** PR ${currentPhase}/${totalPhases}`,
      ``,
      marker,
    ].join("\n");

    await gh.commentOnIssue(fullName, issue.number, body);
    log.info(`[issue-worker] Posted progress comment for ${fullName}#${issue.number} before phase ${currentPhase}`);
  } catch (err) {
    log.warn(`[issue-worker] Failed to post progress comment for ${fullName}#${issue.number}: ${err}`);
  }
}

function buildPRTitle(
  issue: gh.Issue,
  plan: planParser.ParsedPlan | null,
  currentPhase: number,
  totalPhases: number,
): string {
  if (totalPhases === 1 || !plan) {
    return `fix: resolve #${issue.number} — ${issue.title}`;
  }
  const phase = plan.phases[currentPhase - 1];
  return `fix(#${issue.number}): ${phase.title} (${currentPhase}/${totalPhases})`;
}

function buildPRBody(
  issue: gh.Issue,
  plan: planParser.ParsedPlan | null,
  currentPhase: number,
  totalPhases: number,
  isLastPhase: boolean,
  description: string,
): string {
  const issueRef = isLastPhase
    ? `Closes #${issue.number}`
    : `Part of #${issue.number}`;

  if (totalPhases === 1 || !plan) {
    return `${description}\n\n${issueRef}`;
  }

  const phase = plan.phases[currentPhase - 1];
  return [
    `## PR ${currentPhase} of ${totalPhases}: ${phase.title}`,
    ``,
    phase.description,
    ``,
    description,
    ``,
    issueRef,
  ].join("\n");
}

async function processIssue(repo: Repo, issue: gh.Issue): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-worker] Processing ${fullName}#${issue.number}: ${issue.title}`);

  // Guard: skip if an open PR already exists for this issue
  const existingPR = await gh.getOpenPRForIssue(fullName, issue.number);
  if (existingPR) {
    log.info(`[issue-worker] Skipping ${fullName}#${issue.number} — open PR #${existingPR.number} already exists`);
    await gh.removeLabel(fullName, issue.number, LABELS.refined);
    return;
  }

  await gh.removeLabel(fullName, issue.number, LABELS.ready);

  const branchName = `claws/issue-${issue.number}-${claude.randomSuffix()}`;
  const taskId = db.recordTaskStart("issue-worker", fullName, issue.number, LABELS.refined);
  let wtPath: string | undefined;

  try {
    wtPath = await claude.createWorktree(repo, branchName, "issue-worker");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    // 1. Read plan from issue comments
    const comments = await gh.getIssueComments(fullName, issue.number);
    const planText = planParser.findPlanComment(comments);
    const plan = planText ? planParser.parsePlan(planText) : null;

    // 2. Determine current phase
    const mergedPRs = await gh.listMergedPRsForIssue(fullName, issue.number);
    const totalPhases = plan?.totalPhases ?? 1;
    const currentPhase = mergedPRs.length + 1;
    const isLastPhase = currentPhase >= totalPhases;

    log.info(`[issue-worker] Phase ${currentPhase}/${totalPhases} for ${fullName}#${issue.number}`);

    // Post a progress comment summarizing completed phases (preserves original plan)
    if (currentPhase > 1 && plan) {
      await postPhaseProgressComment(fullName, issue, comments, mergedPRs, currentPhase, totalPhases);
    }

    const imageContext = await processTextForImages([issue.body, ...comments.map((c) => c.body)], wtPath);

    // 3. Build phase-aware prompt
    const prompt = buildPrompt(fullName, issue, plan, currentPhase, totalPhases, mergedPRs, comments, imageContext);

    await claude.enqueue(() => claude.runClaude(prompt, wtPath!), gh.isItemPrioritized(fullName, issue.number) || gh.hasPriorityLabel(issue.labels));

    if (await claude.hasNewCommits(wtPath, repo.defaultBranch)) {
      await claude.pushBranch(wtPath, branchName);
      const description = await claude.generatePRDescription(
        wtPath, repo.defaultBranch, issue,
      );

      // 4. Create PR with appropriate title and body
      const prTitle = buildPRTitle(issue, plan, currentPhase, totalPhases);
      const prBody = buildPRBody(issue, plan, currentPhase, totalPhases, isLastPhase, description);

      const prNumber = await gh.createPR(fullName, branchName, prTitle, prBody);
      log.info(`[issue-worker] Created PR #${prNumber} (${currentPhase}/${totalPhases}) for ${fullName}#${issue.number}`);
      await gh.addLabel(fullName, issue.number, LABELS.inReview);

      // Propagate Priority label to the new PR
      if (gh.hasPriorityLabel(issue.labels)) {
        await gh.addLabel(fullName, prNumber, LABELS.priority);
      }

    } else {
      log.warn(`[issue-worker] No commits produced for ${fullName}#${issue.number}`);
    }

    await gh.removeLabel(fullName, issue.number, LABELS.refined);
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

async function checkAndContinue(repo: Repo, issue: gh.Issue): Promise<void> {
  const fullName = repo.fullName;

  // Is there still an open PR? If so, wait.
  const openPR = await gh.getOpenPRForIssue(fullName, issue.number);
  if (openPR) return;

  // No open PR — the latest PR must have been merged (or closed).
  // Check if there are more phases to do.
  const comments = await gh.getIssueComments(fullName, issue.number);
  const planText = planParser.findPlanComment(comments);
  const plan = planText ? planParser.parsePlan(planText) : null;

  const mergedPRs = await gh.listMergedPRsForIssue(fullName, issue.number);
  const totalPhases = plan?.totalPhases ?? 1;

  if (mergedPRs.length >= totalPhases) {
    log.info(`[issue-worker] All ${totalPhases} phases complete for ${fullName}#${issue.number}`);
    return;
  }

  // More phases needed — re-label as Refined to trigger next PR
  log.info(`[issue-worker] PR merged, advancing to phase ${mergedPRs.length + 1}/${totalPhases} for ${fullName}#${issue.number}`);
  await gh.addLabel(fullName, issue.number, LABELS.refined);
}

export async function run(repos: Repo[]): Promise<void> {
  const tasks: Promise<void>[] = [];

  for (const repo of repos) {
    if (isRateLimited()) break;
    try {
      // Track issues processed this tick to avoid re-processing in checkAndContinue
      const processedIssues = new Set<number>();

      // Handle fresh issues labeled "Refined"
      const refinedIssues = await gh.listIssuesByLabel(repo.fullName, LABELS.refined);
      for (const issue of refinedIssues) {
        if (gh.isItemSkipped(repo.fullName, issue.number)) continue;
        processedIssues.add(issue.number);
        gh.populateQueueCache("refined", repo.fullName, { number: issue.number, title: issue.title, type: "issue", updatedAt: issue.updatedAt, priority: gh.hasPriorityLabel(issue.labels) });
        tasks.push(
          processIssue(repo, issue).catch((err) =>
            reportError("issue-worker:process-issue", `${repo.fullName}#${issue.number}`, err),
          ),
        );
      }

      // Check multi-PR issues: scan open issues for ones with merged claws PRs but more phases remaining
      const allIssues = await gh.listOpenIssues(repo.fullName);
      for (const issue of allIssues) {
        if (processedIssues.has(issue.number)) continue;
        if (gh.isItemSkipped(repo.fullName, issue.number)) continue;

        // Only check issues that have at least one merged PR with claws/ branch
        const mergedPRs = await gh.listMergedPRsForIssue(repo.fullName, issue.number);
        if (mergedPRs.length === 0) continue;

        // Check if multi-phase and not all phases complete
        const comments = await gh.getIssueComments(repo.fullName, issue.number);
        const planText = planParser.findPlanComment(comments);
        const plan = planText ? planParser.parsePlan(planText) : null;
        const totalPhases = plan?.totalPhases ?? 1;
        if (totalPhases <= 1) continue;
        if (mergedPRs.length >= totalPhases) continue;

        tasks.push(
          checkAndContinue(repo, issue).catch((err) =>
            reportError("issue-worker:merge-check", `${repo.fullName}#${issue.number}`, err),
          ),
        );
      }
    } catch (err) {
      reportError("issue-worker:list-issues", repo.fullName, err);
    }
  }

  await Promise.allSettled(tasks);
}
