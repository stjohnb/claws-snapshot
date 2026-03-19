import { type Repo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited, RateLimitError } from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { ShutdownError } from "../shutdown.js";

type WorkItem =
  | { kind: "conflict"; repo: Repo; pr: gh.PR }
  | { kind: "rerun"; repo: Repo; pr: gh.PR; runId: string }
  | { kind: "unrelated"; repo: Repo; pr: gh.PR; fingerprint: string; reason: string; failLog: string; changedFiles: string[]; runUrl: string }
  | { kind: "fix"; repo: Repo; pr: gh.PR; failLog: string };

async function resolveConflicts(repo: Repo, pr: gh.PR): Promise<boolean> {
  const fullName = repo.fullName;

  const state = await gh.getPRMergeableState(fullName, pr.number);
  if (state !== "CONFLICTING") return false;

  log.info(`[ci-fixer] Resolving merge conflicts for ${fullName}#${pr.number}`);

  const taskId = db.recordTaskStart("ci-fixer:merge-conflict", fullName, pr.number, null);
  let wtPath: string | undefined;

  try {
    wtPath = await claude.createWorktreeFromBranch(repo, pr.headRefName, "ci-fixer");
    db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

    const { clean, conflictedFiles } = await claude.attemptMerge(wtPath, pr.baseRefName);

    if (clean) {
      // Merge was auto-resolved by git — just push
      await claude.pushBranch(wtPath, pr.headRefName);
      log.info(`[ci-fixer] Clean merge pushed for ${fullName}#${pr.number}`);
      db.recordTaskComplete(taskId);
      return true;
    }

    // Conflicts need Claude to resolve
    const prompt = [
      `You are resolving merge conflicts on a pull request in the repository ${fullName}.`,
      `PR #${pr.number}: ${pr.title}`,
      `Branch: ${pr.headRefName} (merging ${pr.baseRefName} into it)`,
      ``,
      `A merge of the base branch (origin/${pr.baseRefName}) has been started but has`,
      `conflicts in the following files:`,
      conflictedFiles.map((f) => `- ${f}`).join("\n"),
      ``,
      `The conflicted files contain standard git conflict markers`,
      `(<<<<<<< HEAD, =======, >>>>>>>).`,
      ``,
      `Please resolve each conflict by:`,
      `1. Reading each conflicted file`,
      `2. Understanding the intent of both sides of the conflict`,
      `3. Editing the file to remove all conflict markers and produce the correct merged result`,
      `4. Staging the resolved files with \`git add <file>\``,
      `5. Completing the merge with \`git commit --no-edit\``,
    ].join("\n");

    await claude.enqueue(() => claude.runClaude(prompt, wtPath!), gh.hasPriorityLabel(pr.labels));

    if (await claude.hasNewCommits(wtPath, pr.headRefName)) {
      await claude.pushBranch(wtPath, pr.headRefName);
      try {
        const description = await claude.regeneratePRDescription(wtPath, pr.baseRefName, pr);
        await gh.updatePRBody(fullName, pr.number, description);
      } catch (descErr) {
        log.warn(`[ci-fixer] Failed to update PR description for ${fullName}#${pr.number}: ${descErr}`);
      }
      log.info(`[ci-fixer] Conflict resolution pushed for ${fullName}#${pr.number}`);
    } else {
      log.warn(`[ci-fixer] No commits from conflict resolution for ${fullName}#${pr.number}`);
      await claude.abortMerge(wtPath);
    }

    db.recordTaskComplete(taskId);
    return true;
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    if (wtPath) {
      try {
        await claude.abortMerge(wtPath);
      } catch {
        // Merge may not be in progress
      }
    }
    throw err;
  } finally {
    if (wtPath) {
      await claude.removeWorktree(repo, wtPath);
    }
  }
}

const CANCELLED_STATES = new Set(["CANCELLED", "STARTUP_FAILURE"]);

interface Classification {
  related: boolean;
  fingerprint: string;
  reason: string;
}

async function classifyCIFailure(
  _repo: Repo,
  pr: gh.PR,
  failLog: string,
  changedFiles: string[],
): Promise<Classification> {
  const prompt = [
    `You are classifying a CI failure to determine whether it was caused by the changes in this pull request.`,
    ``,
    `PR #${pr.number}: ${pr.title}`,
    `Branch: ${pr.headRefName}`,
    ``,
    `Files changed in this PR:`,
    changedFiles.map((f) => `- ${f}`).join("\n"),
    ``,
    `CI failure log:`,
    "```",
    failLog,
    "```",
    ``,
    `Classify this failure. Respond with ONLY a JSON object (no markdown, no explanation):`,
    `{`,
    `  "related": true/false,`,
    `  "fingerprint": "short-stable-id",`,
    `  "reason": "1-2 sentence explanation"`,
    `}`,
    ``,
    `Classification rules:`,
    `- "related": true if the failure is caused by or related to the PR's changes`,
    `  - Failures in files the PR modified → related`,
    `  - Test failures testing code the PR changed → related`,
    `  - Build errors from the PR's changes → related`,
    `- "related": false if the failure is NOT caused by the PR`,
    `  - Flakey tests (timeouts, race conditions, intermittent failures) → unrelated`,
    `  - CI runner issues (disk space, network, docker pull limits) → unrelated`,
    `  - Pre-existing failures that exist on the base branch → unrelated`,
    `- When in doubt, classify as related (safe default)`,
    ``,
    `- "fingerprint": a short, stable, human-readable identifier for this class of failure`,
    `  Examples: "flakey-test:auth-timeout", "runner:disk-space", "preexisting:lint-config"`,
    `  Use category:detail format. Be consistent — the same issue should get the same fingerprint.`,
    ``,
    `- "reason": brief explanation of why you classified it this way`,
  ].join("\n");

  try {
    const response = await claude.enqueue(() => claude.runClaude(prompt, process.cwd()), gh.hasPriorityLabel(pr.labels));

    // Try to parse JSON from response
    const jsonMatch = response.match(/\{[\s\S]*?"related"[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Classification;
      if (typeof parsed.related === "boolean") {
        return {
          related: parsed.related,
          fingerprint: String(parsed.fingerprint || ""),
          reason: String(parsed.reason || ""),
        };
      }
    }

    // Regex fallback: look for "related": false
    if (/"related"\s*:\s*false/.test(response)) {
      const fpMatch = response.match(/"fingerprint"\s*:\s*"([^"]*)"/);
      const reasonMatch = response.match(/"reason"\s*:\s*"([^"]*)"/);
      return {
        related: false,
        fingerprint: fpMatch?.[1] ?? "",
        reason: reasonMatch?.[1] ?? "",
      };
    }

    // Default to related (safe fallback)
    return { related: true, fingerprint: "", reason: "classification parsing fallback" };
  } catch (err) {
    log.warn(`[ci-fixer] Classification failed: ${err}`);
    return { related: true, fingerprint: "", reason: "classification failed" };
  }
}

async function identifyPRWork(repo: Repo, pr: gh.PR): Promise<WorkItem | null> {
  const fullName = repo.fullName;

  const state = await gh.getPRMergeableState(fullName, pr.number);
  if (state === "CONFLICTING") {
    return { kind: "conflict", repo, pr };
  }

  const failedCheck = await gh.getFailingCheck(fullName, pr.number);
  if (!failedCheck) return null;

  if (CANCELLED_STATES.has(failedCheck.state)) {
    const match = failedCheck.link?.match(/\/actions\/runs\/(\d+)/);
    if (match) return { kind: "rerun", repo, pr, runId: match[1] };
    log.warn(`[ci-fixer] Cancelled check for ${fullName}#${pr.number} has no re-runnable link`);
    return null;
  }

  log.info(`[ci-fixer] Fixing CI for ${fullName}#${pr.number}`);
  const failLog = await gh.getFailedRunLog(fullName, pr.number);
  if (!failLog) {
    // No logs available — likely a transient runner issue. Re-run the workflow.
    const match = failedCheck.link?.match(/\/actions\/runs\/(\d+)/);
    if (match) {
      log.info(`[ci-fixer] No failure logs for ${fullName}#${pr.number}, re-running workflow`);
      return { kind: "rerun", repo, pr, runId: match[1] };
    }
    log.warn(`[ci-fixer] No failure logs and no re-runnable link for ${fullName}#${pr.number}`);
    return null;
  }

  if (isCIUnrelatedFixPR(pr)) {
    log.info(`[ci-fixer] ${fullName}#${pr.number} is a ci-unrelated fix PR — skipping classification, treating as related`);
    return { kind: "fix", repo, pr, failLog };
  }

  const changedFiles = await gh.getPRChangedFiles(fullName, pr.number);
  const classification = await classifyCIFailure(repo, pr, failLog, changedFiles);

  if (classification.related) {
    return { kind: "fix", repo, pr, failLog };
  }

  log.info(`[ci-fixer] Failure for ${fullName}#${pr.number} classified as unrelated: ${classification.reason}`);
  return { kind: "unrelated", repo, pr, fingerprint: classification.fingerprint, reason: classification.reason, failLog, changedFiles, runUrl: failedCheck.link };
}

async function fixCI(repo: Repo, pr: gh.PR, failLog: string): Promise<void> {
  const fullName = repo.fullName;
  const taskId = db.recordTaskStart("ci-fixer", fullName, pr.number, null);
  let wtPath: string | undefined;

  try {
    wtPath = await claude.createWorktreeFromBranch(repo, pr.headRefName, "ci-fixer");
    db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

    const prompt = [
      `You are fixing a CI failure on a pull request in the repository ${fullName}.`,
      `PR #${pr.number}: ${pr.title}`,
      `Branch: ${pr.headRefName}`,
      ``,
      `The CI checks have failed. Here are the relevant failure logs:`,
      ``,
      "```",
      failLog,
      "```",
      ``,
      `Please analyze the failure and make the necessary code changes to fix it.`,
      `Make commits with clear messages as you work.`,
    ].join("\n");

    await claude.enqueue(() => claude.runClaude(prompt, wtPath!), gh.hasPriorityLabel(pr.labels));

    if (await claude.hasNewCommits(wtPath, pr.headRefName)) {
      await claude.pushBranch(wtPath, pr.headRefName);
      try {
        const description = await claude.regeneratePRDescription(wtPath, pr.baseRefName, pr);
        await gh.updatePRBody(fullName, pr.number, description);
      } catch (descErr) {
        log.warn(`[ci-fixer] Failed to update PR description for ${fullName}#${pr.number}: ${descErr}`);
      }
      log.info(`[ci-fixer] Pushed fix for ${fullName}#${pr.number}`);
    } else {
      log.warn(`[ci-fixer] No commits produced for ${fullName}#${pr.number}`);
    }

    db.recordTaskComplete(taskId);
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    throw err;
  } finally {
    if (wtPath) await claude.removeWorktree(repo, wtPath);
  }
}

async function fileUnrelatedIssue(
  repoName: string,
  occurrences: Array<{ fingerprint: string; reason: string; failLog: string; pr: gh.PR; runUrl: string }>,
): Promise<void> {
  const title = `[ci-unrelated] CI failures unrelated to PR changes`;

  try {
    const results = await gh.searchIssues(repoName, title);
    const existing = results.find((r) => r.title === title);

    let issueNumber: number;
    if (existing) {
      issueNumber = existing.number;
    } else {
      const body = [
        `**Auto-created by Claws ci-fixer**`,
        "",
        `This issue tracks CI failures that are unrelated to the PRs they occurred on (flakey tests, runner issues, pre-existing failures).`,
        `Each occurrence is logged below.`,
      ].join("\n");
      issueNumber = await gh.createIssue(repoName, title, body, []);
      log.info(`[ci-fixer] Created issue #${issueNumber} for unrelated CI failures`);
    }

    for (const occ of occurrences) {
      const abbreviatedLog = occ.failLog.slice(0, 2000);
      const comment = [
        `### ${occ.fingerprint} — ${new Date().toISOString()}`,
        "",
        `**Observed on:** PR #${occ.pr.number} (${occ.pr.title})`,
        `**Reason:** ${occ.reason}`,
        `**Failing run:** ${occ.runUrl}`,
        "",
        "```",
        abbreviatedLog,
        "```",
      ].join("\n");
      await gh.commentOnIssue(repoName, issueNumber, comment);
      log.info(`[ci-fixer] Updated issue #${issueNumber} for "${occ.fingerprint}"`);
    }
  } catch (err) {
    log.warn(`[ci-fixer] Failed to file unrelated issue: ${err}`);
    reportError("ci-fixer:file-unrelated-issue", repoName, err);
  }
}

async function revertPreviousUnrelatedFixes(
  repo: Repo,
  pr: gh.PR,
  changedFiles: string[],
): Promise<void> {
  const fullName = repo.fullName;

  // Skip if Claws has never run ci-fixer on this PR
  if (!db.hasPreviousCiFixerTasks(fullName, pr.number)) {
    return;
  }

  const taskId = db.recordTaskStart("ci-fixer:revert", fullName, pr.number, null);
  let wtPath: string | undefined;

  try {
    wtPath = await claude.createWorktreeFromBranch(repo, pr.headRefName, "ci-fixer-revert");
    db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

    const gitLog = await claude.git(
      ["log", "--oneline", `origin/${pr.baseRefName}..HEAD`],
      wtPath,
    );

    const prompt = [
      `You are examining commits on a pull request branch to identify and revert automated CI fix attempts that were for issues UNRELATED to the PR's purpose.`,
      ``,
      `PR #${pr.number}: ${pr.title}`,
      `Branch: ${pr.headRefName}`,
      ``,
      `Files originally changed in this PR:`,
      changedFiles.map((f) => `- ${f}`).join("\n"),
      ``,
      `Commit history on this branch (newest first):`,
      "```",
      gitLog,
      "```",
      ``,
      `Identify any commits that appear to be automated CI fix attempts for issues that are NOT related to the PR's original purpose (the files listed above). These are typically commits that:`,
      `- Fix flakey tests unrelated to the PR`,
      `- Work around CI runner issues`,
      `- Fix pre-existing problems not introduced by this PR`,
      ``,
      `For each such commit, run: git revert <sha> --no-edit`,
      ``,
      `If no unrelated fix commits are found, do nothing.`,
      `Be conservative — only revert commits you are confident are unrelated automated fixes.`,
    ].join("\n");

    await claude.enqueue(() => claude.runClaude(prompt, wtPath!), gh.hasPriorityLabel(pr.labels));

    if (await claude.hasNewCommits(wtPath, pr.headRefName)) {
      await claude.pushBranch(wtPath, pr.headRefName);
      log.info(`[ci-fixer] Reverted unrelated fixes for ${fullName}#${pr.number}`);
    }

    db.recordTaskComplete(taskId);
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    log.warn(`[ci-fixer] Revert of unrelated fixes failed for ${fullName}#${pr.number}: ${err}`);
  } finally {
    if (wtPath) {
      await claude.removeWorktree(repo, wtPath);
    }
  }
}

async function mergeBaseIfBehind(repo: Repo, pr: gh.PR): Promise<void> {
  const fullName = repo.fullName;
  const taskId = db.recordTaskStart("ci-fixer:merge-base", fullName, pr.number, null);
  let wtPath: string | undefined;

  try {
    wtPath = await claude.createWorktreeFromBranch(repo, pr.headRefName, "ci-fixer-merge-base");
    db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

    const behindCount = (await claude.git(
      ["rev-list", "--count", `HEAD..origin/${pr.baseRefName}`],
      wtPath,
    )).trim();

    if (behindCount === "0") {
      log.info(`[ci-fixer] Branch for ${fullName}#${pr.number} is already up-to-date with ${pr.baseRefName}`);
      db.recordTaskComplete(taskId);
      return;
    }

    log.info(`[ci-fixer] Branch for ${fullName}#${pr.number} is ${behindCount} commits behind ${pr.baseRefName}, merging`);

    const { clean } = await claude.attemptMerge(wtPath, pr.baseRefName);

    if (clean) {
      await claude.pushBranch(wtPath, pr.headRefName);
      log.info(`[ci-fixer] Merged ${pr.baseRefName} into ${pr.headRefName} for ${fullName}#${pr.number}`);
    } else {
      await claude.abortMerge(wtPath);
      log.info(`[ci-fixer] Merge of ${pr.baseRefName} into ${pr.headRefName} has conflicts for ${fullName}#${pr.number}, skipping`);
    }

    db.recordTaskComplete(taskId);
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    log.warn(`[ci-fixer] Merge-base failed for ${fullName}#${pr.number}: ${err}`);
  } finally {
    if (wtPath) {
      await claude.removeWorktree(repo, wtPath);
    }
  }
}

const CI_FIXER_ERROR_HEADING = "### CI Fixer Error";

function isCIUnrelatedFixPR(pr: gh.PR): boolean {
  return pr.title.includes("[ci-unrelated]");
}

async function postErrorOnPR(repoName: string, pr: gh.PR, err: unknown): Promise<void> {
  try {
    const errMsg = err instanceof Error ? err.stack ?? err.message : String(err);
    const truncated = errMsg.slice(0, 3000);
    const body = [
      CI_FIXER_ERROR_HEADING,
      "",
      "CI fixer encountered an error while processing this PR. It will retry on the next cycle.",
      "",
      "```",
      truncated,
      "```",
    ].join("\n");

    const comments = await gh.getIssueComments(repoName, pr.number);
    const existing = comments.find(
      (c) => gh.isClawsComment(c.body) && c.body.includes(CI_FIXER_ERROR_HEADING),
    );

    if (existing) {
      await gh.editIssueComment(repoName, existing.id, body);
    } else {
      await gh.commentOnIssue(repoName, pr.number, body);
    }
  } catch (commentErr) {
    log.warn(`[ci-fixer] Failed to post error comment on ${repoName}#${pr.number}: ${commentErr}`);
  }
}

export async function run(repos: Repo[]): Promise<void> {
  // Phase 1: Identify all work
  const identifyTasks: Promise<WorkItem | null>[] = [];

  for (const repo of repos) {
    if (isRateLimited()) break;
    try {
      const prs = await gh.listPRs(repo.fullName);
      for (const pr of prs) {
        if (gh.isItemSkipped(repo.fullName, pr.number)) continue;
        identifyTasks.push(
          identifyPRWork(repo, pr).catch((err) => {
            if (err instanceof ShutdownError) {
              log.info(`[ci-fixer] Shutdown during ${repo.fullName}#${pr.number}`);
            } else if (err instanceof RateLimitError) {
              log.warn(`[ci-fixer] Rate limited during ${repo.fullName}#${pr.number}`);
            } else {
              reportError("ci-fixer:identify", `${repo.fullName}#${pr.number}`, err);
            }
            return null;
          }),
        );
      }
    } catch (err) {
      reportError("ci-fixer:list-prs", repo.fullName, err);
    }
  }

  const results = await Promise.allSettled(identifyTasks);
  const items = results
    .filter((r): r is PromiseFulfilledResult<WorkItem | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((item): item is WorkItem => item !== null);

  // Phase 2a: Process unrelated failures (grouped by repo — structural dedup)
  const unrelatedByRepo = new Map<string, { repo: Repo; items: Array<Extract<WorkItem, { kind: "unrelated" }>> }>();
  for (const item of items) {
    if (item.kind !== "unrelated") continue;
    let group = unrelatedByRepo.get(item.repo.fullName);
    if (!group) {
      group = { repo: item.repo, items: [] };
      unrelatedByRepo.set(item.repo.fullName, group);
    }
    group.items.push(item);
  }

  for (const [repoName, group] of unrelatedByRepo) {
    await fileUnrelatedIssue(repoName, group.items);
    for (const item of group.items) {
      await revertPreviousUnrelatedFixes(item.repo, item.pr, item.changedFiles);
      await mergeBaseIfBehind(item.repo, item.pr);
    }
  }

  // Phase 2b: Process remaining items concurrently
  const processTasks: Promise<void>[] = [];
  for (const item of items) {
    if (item.kind === "conflict") {
      processTasks.push(
        resolveConflicts(item.repo, item.pr).then(() => {}).catch((err) => {
          if (err instanceof ShutdownError) log.info(`[ci-fixer] Shutdown during ${item.repo.fullName}#${item.pr.number}`);
          else if (err instanceof RateLimitError) log.warn(`[ci-fixer] Rate limited during ${item.repo.fullName}#${item.pr.number}`);
          else reportError("ci-fixer:process-pr", `${item.repo.fullName}#${item.pr.number}`, err);
        }),
      );
    } else if (item.kind === "rerun") {
      processTasks.push(
        (async () => {
          log.info(`[ci-fixer] Re-running cancelled check for ${item.repo.fullName}#${item.pr.number}`);
          await gh.rerunWorkflow(item.repo.fullName, item.runId);
        })().catch((err) => {
          if (err instanceof Error && /already running/i.test(err.message)) {
            log.info(`[ci-fixer] Workflow ${item.runId} for ${item.repo.fullName}#${item.pr.number} is already running, skipping rerun`);
            return;
          }
          reportError("ci-fixer:rerun", `${item.repo.fullName}#${item.pr.number}`, err);
        }),
      );
    } else if (item.kind === "fix") {
      processTasks.push(
        fixCI(item.repo, item.pr, item.failLog).catch((err) => {
          if (err instanceof ShutdownError) log.info(`[ci-fixer] Shutdown during ${item.repo.fullName}#${item.pr.number}`);
          else if (err instanceof RateLimitError) log.warn(`[ci-fixer] Rate limited during ${item.repo.fullName}#${item.pr.number}`);
          else if (isCIUnrelatedFixPR(item.pr)) {
            log.error(`[ci-fixer] Error on ci-unrelated fix PR ${item.repo.fullName}#${item.pr.number}: ${err}`);
            return postErrorOnPR(item.repo.fullName, item.pr, err);
          } else reportError("ci-fixer:process-pr", `${item.repo.fullName}#${item.pr.number}`, err);
        }),
      );
    }
  }

  await Promise.allSettled(processTasks);
}
