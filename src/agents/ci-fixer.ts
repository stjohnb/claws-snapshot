import { z } from "zod";
import { type Repo, LABELS, CI_FIXER_MAX_ATTEMPTS, CI_FIXER_WINDOW_MS, CI_FIXER_MAX_CONSECUTIVE_FAILURES, HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import type { TaskOutcome } from "../db.js";
import { buildSuccessOutcome } from "../outcome.js";
import { reportError } from "../error-reporter.js";
import { getItemTimeoutMs } from "../timeout-handler.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { CI_FIXER_FAST_CHECKS_GUIDANCE, RUNNER_POLICY_CONTEXT, homeAssistantContext } from "./agent-context.js";
import { isHomeAssistantConfigRepo } from "../home-assistant.js";
import { getModel } from "../model-selector.js";
import { classifyComplexity } from "../classify-complexity.js";
import type { Provider } from "../plan-parser.js";
import { parseFirstValidJson } from "../json-extract.js";
import { extractManualActionSection } from "./issue-worker.js";
import { ensureAlertIssue } from "../occurrence-tracking.js";

export type WorkItem =
  | { kind: "conflict"; repo: Repo; pr: gh.PR }
  | { kind: "rerun"; repo: Repo; pr: gh.PR; runId: string }
  | { kind: "fix"; repo: Repo; pr: gh.PR; failedCheck: gh.FailedCheck };

async function pushAndUpdatePR(
  wtPath: string,
  repo: Repo,
  pr: gh.PR,
  model: string,
  actualProvider: Provider,
  attributionVerb: string,
  successLog: string,
): Promise<TaskOutcome> {
  const fullName = repo.fullName;
  await claude.pushBranch(wtPath, pr.headRefName, repo.owner);
  try {
    const attribution = `*— ${attributionVerb}: ${model} (provider: ${actualProvider}) —*`;
    const [description, currentBody] = await Promise.all([
      claude.regeneratePRDescription(wtPath, pr.baseRefName, pr, fullName, attribution),
      gh.getPRBody(fullName, pr.number),
    ]);
    const closingMatch = currentBody.match(/\b(Closes|Part of)\s+#\d+/i);
    const phaseHeaderMatch = currentBody.match(/^##\s+PR\s+\d+\s+of\s+\d+\s*:.*$/m);
    const manualActionSection = extractManualActionSection(currentBody);
    const prefix = phaseHeaderMatch ? `${phaseHeaderMatch[0]}\n\n` : "";
    const suffix = closingMatch ? `\n\n${closingMatch[0]}` : "";
    const manualActionSuffix = manualActionSection ? `\n\n${manualActionSection}` : "";
    await gh.updatePR(fullName, pr.number, `${prefix}${description}${suffix}${manualActionSuffix}`);
  } catch (descErr) {
    log.warn(`[ci-fixer] Failed to update PR description for ${fullName}#${pr.number}: ${descErr}`);
  }
  log.info(`[ci-fixer] ${successLog} for ${fullName}#${pr.number}`);
  return await buildSuccessOutcome(wtPath, pr.baseRefName, pr.number, "updated");
}

export async function resolveConflicts(repo: Repo, pr: gh.PR): Promise<boolean> {
  const fullName = repo.fullName;

  const state = await gh.getPRMergeableState(fullName, pr.number);
  if (state !== "CONFLICTING") return false;

  log.info(`[ci-fixer] Resolving merge conflicts for ${fullName}#${pr.number}`);

  return await db.withTaskRecording("ci-fixer:merge-conflict", fullName, pr.number, null, async (taskId) => {
    const result = await claude.withExistingWorktree(
      repo, pr.headRefName, "ci-fixer",
      async (wtPath) => {
        db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

        try {
          const { clean, conflictedFiles } = await claude.attemptMerge(wtPath, pr.baseRefName);

          if (clean) {
            // Merge was auto-resolved by git — just push
            await claude.pushBranch(wtPath, pr.headRefName, repo.owner);
            log.info(`[ci-fixer] Clean merge pushed for ${fullName}#${pr.number}`);
            const diffStats = await claude.getDiffStats(wtPath, pr.baseRefName).catch(() => undefined);
            db.recordTaskComplete(taskId, {
              commits: 1,
              ...diffStats,
              prNumber: pr.number,
              prAction: "updated",
            });
            return true;
          }

          // Conflicts need Claude to resolve
          const guardCtx = makeGuardCtx(fullName, pr.number);
          const prompt = [
            `You are resolving merge conflicts on a pull request in the repository ${fullName}.`,
            `PR #${pr.number}: ${guardContent(pr.title, guardCtx("pr-title"))}`,
            `Branch: ${guardContent(pr.headRefName, guardCtx("pr-branch"))} (merging ${pr.baseRefName} into it)`,
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
            ``,
            RUNNER_POLICY_CONTEXT,
            ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
          ].join("\n");

          const mcpConfigPath = claude.writeClawsMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName) });
          const agentDoc = claude.readRepoAgentDoc(wtPath, "issue-implementer");
          const timeoutMs = getItemTimeoutMs(fullName, pr.number);
          const tier = await classifyComplexity(
            [
              `Resolving merge conflicts on PR #${pr.number} in ${fullName}.`,
              `PR title: ${pr.title}`,
              ``,
              `Conflicted files:`,
              conflictedFiles.map((f) => `- ${f}`).join("\n"),
            ].join("\n"),
            wtPath,
          );
          const model = getModel(tier, "tool-use", "claude");
          db.updateTaskModel(taskId, model);
          log.info(`[ci-fixer] Using model "${model}" for conflict resolution on ${fullName}#${pr.number}`);
          let actualProvider: Provider = "claude";
          await claude.runClaude(prompt, wtPath, { capability: "tool-use", mcpConfig: mcpConfigPath, timeoutMs, tier, model, appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onTokensUsed: db.trackTaskTokens(taskId), agent: "build", captureLabel: "ci-fixer" });

          let outcome: TaskOutcome = { commits: 0 };

          if (await claude.hasNewCommits(wtPath, pr.headRefName)) {
            outcome = await pushAndUpdatePR(wtPath, repo, pr, model, actualProvider, "Conflict resolved with", "Conflict resolution pushed");
          } else {
            log.warn(`[ci-fixer] No commits from conflict resolution for ${fullName}#${pr.number}`);
            await claude.abortMerge(wtPath);
          }

          db.recordTaskComplete(taskId, outcome);
          return true;
        } catch (innerErr) {
          try { await claude.abortMerge(wtPath); } catch { /* merge may not be in progress */ }
          throw innerErr;
        }
      },
    );

    if (result === null) {
      log.info(`[ci-fixer] Branch ${pr.headRefName} no longer exists for PR #${pr.number} in ${fullName} — skipping (likely merged/closed)`);
      db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "skipped" });
      return false;
    }
    return result;
  });
}

const CANCELLED_STATES = new Set(["CANCELLED", "STARTUP_FAILURE"]);

// Run IDs GitHub refused to re-run ("cannot be rerun" / "Resource not
// accessible by integration"). Without this, identifyPRWork re-classifies the
// same dead run as rerun work every sweep and the handler retries it every
// cycle forever (3d-models#289 looped for days). In-memory by design: a
// restart costs one extra attempt per run, then it is re-marked.
const deadRerunIds = new Set<string>();

export function _resetDeadRerunIdsForTests(): void {
  deadRerunIds.clear();
}

/**
 * Record that GitHub refused to re-run `runId` and raise an alert issue on the
 * repo so a human can trigger a fresh CI run (push a commit or close/reopen
 * the PR). Once marked, identifyPRWork stops classifying the run as rerun work.
 */
export async function reportRunNotRerunnable(repo: Repo, pr: gh.PR, runId: string): Promise<void> {
  deadRerunIds.add(runId);
  const guardCtx = makeGuardCtx(repo.fullName, pr.number);
  const body = [
    `Claws tried to re-run CI run [${runId}](https://github.com/${repo.fullName}/actions/runs/${runId}) for PR #${pr.number}, but GitHub refused (\`cannot be rerun\` / \`Resource not accessible by integration\`). This happens when a run is too old or its state is not re-runnable — e.g. jobs cancelled at the 24h limit after a runner went away.`,
    "",
    `Automatic retries for this run have stopped. To unblock PR #${pr.number}, trigger a fresh CI run manually: push a new commit to \`${guardContent(pr.headRefName, guardCtx("pr-branch"))}\`, or close and reopen the PR.`,
  ].join("\n");
  try {
    await ensureAlertIssue({
      repo: repo.fullName,
      title: `CI for PR #${pr.number} cannot be re-run automatically`,
      body,
      labels: [LABELS.manualAction, LABELS.clawsIgnore],
      logPrefix: "ci-fixer",
    });
  } catch (err) {
    log.warn(`[ci-fixer] Failed to file not-rerunnable alert for ${repo.fullName}#${pr.number}: ${err}`);
  }
  try {
    await gh.addLabel(repo.fullName, pr.number, LABELS.manualAction);
  } catch (err) {
    log.warn(`[ci-fixer] Could not apply ${LABELS.manualAction} to ${repo.fullName}#${pr.number}: ${err}`);
  }
}

const ClassificationSchema = z.object({
  related: z.boolean(),
  fingerprint: z.string().optional(),
  reason: z.string().optional(),
});

interface Classification {
  related: boolean;
  fingerprint: string;
  reason: string;
}

export async function classifyCIFailure(
  repo: Repo,
  pr: gh.PR,
  failLog: string,
  changedFiles: string[],
): Promise<Classification> {
  const guardCtx = makeGuardCtx(repo.fullName, pr.number);
  const prompt = [
    `You are classifying a CI failure to determine whether it was caused by the changes in this pull request.`,
    ``,
    `PR #${pr.number}: ${guardContent(pr.title, guardCtx("pr-title"))}`,
    `Branch: ${guardContent(pr.headRefName, guardCtx("pr-branch"))}`,
    ``,
    `Files changed in this PR:`,
    changedFiles.map((f) => `- ${f}`).join("\n"),
    ``,
    `CI failure log:`,
    "```",
    // CI logs come from GitHub Actions, not user input — no guard needed.
    // Guarding would redact test fixture strings (e.g. from prompt-guard.test.ts),
    // making the log useless for diagnosing failures in security-related tests.
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
    const response = await claude.runClaude(prompt, process.cwd(), { capability: "text-only", tier: "sonnet", agent: "plan", provider: "claude" });

    // Multi-strategy JSON extraction (fenced blocks, brace-balanced) via shared helper
    const result = parseFirstValidJson(response, ClassificationSchema, "ci-fixer");
    if (result) {
      return {
        related: result.related,
        fingerprint: String(result.fingerprint ?? ""),
        reason: String(result.reason ?? ""),
      };
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

const PROBLEMATIC_PR_MARKER = "problematic-pr-marked";

export interface MajorBump { pkg: string; from: string; to: string }

const MAJOR_BUMP_RE =
  /(?:bump|update|updates)\s+`?([@\w./-]+)`?\s+from\s+`?v?(\d+)[^\s`]*`?\s+to\s+`?v?(\d+)[^\s`]*`?/gi;

export function parseMajorBumps(text: string): MajorBump[] {
  const out: MajorBump[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MAJOR_BUMP_RE)) {
    const [, pkg, fromMajor, toMajor] = m;
    if (Number(toMajor) > Number(fromMajor) && !seen.has(pkg)) {
      seen.add(pkg);
      out.push({ pkg, from: fromMajor, to: toMajor });
    }
  }
  return out;
}

export async function fileMajorBumpIssue(fullName: string, pr: gh.PR): Promise<void> {
  // Detect from title first (cheap); fall back to body for grouped PRs.
  let bumps = parseMajorBumps(pr.title);
  if (bumps.length === 0) {
    try {
      const body = await gh.getPRBody(fullName, pr.number);
      bumps = parseMajorBumps(body ?? "");
    } catch (err) {
      log.warn(`[ci-fixer] Could not fetch PR body for major-bump check on ${fullName}#${pr.number}: ${err}`);
    }
  }
  if (bumps.length === 0) return; // Not a major-version bump — nothing to file.

  const primary = bumps[0].pkg;
  const extra = bumps.length > 1 ? ` (and ${bumps.length - 1} other${bumps.length > 2 ? "s" : ""})` : "";
  const title = `[dependabot] Major-version bump of \`${primary}\`${extra} breaks CI`;
  const bumpList = bumps.map((b) => `- \`${b.pkg}\`: ${b.from}.x → ${b.to}.x`).join("\n");
  const body = [
    `A Dependabot pull request that bumps one or more dependencies across a major version has repeatedly failed CI and could not be auto-fixed by Claws.`,
    ``,
    `Per policy, major-version bumps are **not** blocklisted in \`dependabot.yml\`. Instead, resolve the underlying incompatibility so the bump can land (upgrade peers, apply the library's migration/codemod, adjust config, or wait for a compatible peer release and note that here).`,
    ``,
    `**Source PR:** ${fullName}#${pr.number} — ${pr.title}`,
    `**Branch:** \`${pr.headRefName}\``,
    ``,
    `**Major bump(s):**`,
    bumpList,
    ``,
    `See the failing CI checks on the PR for the specific error.`,
  ].join("\n");

  await ensureAlertIssue({ repo: fullName, title, body, labels: [], logPrefix: "ci-fixer" });
}

async function triggerCircuitBreaker(
  fullName: string,
  pr: gh.PR,
  reason: string,
  attempts: { total: number; failed: number; successful: number },
): Promise<void> {
  // Add label as single source of truth (idempotent)
  try {
    await gh.addLabel(fullName, pr.number, LABELS.problematic);
  } catch (err) {
    log.error(`Failed to add problematic label for ${fullName}#${pr.number}: ${err}`);
  }

  // Deduplication: check if we already posted a comment
  try {
    const comments = await gh.getIssueComments(fullName, pr.number);
    const alreadyNotified = comments.some((c) => c.body.includes(PROBLEMATIC_PR_MARKER));
    if (alreadyNotified) {
      log.info(`[ci-fixer] Skipping duplicate problematic comment for ${fullName}#${pr.number}`);
      return;
    }
  } catch (err) {
    log.warn(`[ci-fixer] Failed to check comments for deduplication on ${fullName}#${pr.number}: ${err}`);
  }

  // Post comment (best-effort)
  try {
    const recentErrors = db.getRecentCIFixerErrors(fullName, pr.number);
    await gh.postProblematicPRComment(fullName, pr.number, reason, attempts.total, recentErrors);
    gh.removeQueueItem(fullName, pr.number);
  } catch (err) {
    log.error(`Failed to notify GitHub for problematic PR ${fullName}#${pr.number}: ${err}`);
  }

  if (gh.isDependabotPR(pr)) {
    try {
      await fileMajorBumpIssue(fullName, pr);
    } catch (err) {
      log.warn(`[ci-fixer] Failed to file major-bump issue for ${fullName}#${pr.number}: ${err}`);
    }
  }
}

export async function identifyPRWork(repo: Repo, pr: gh.PR): Promise<WorkItem | null> {
  const fullName = repo.fullName;

  // Check if PR has the problematic label (single source of truth)
  if (pr.labels.some((l) => l.name === LABELS.problematic)) {
    log.info(`[ci-fixer] Skipping problematic PR ${fullName}#${pr.number}`);
    return null;
  }

  // Check circuit breaker before processing
  const attempts = db.countCIFixerAttempts(fullName, pr.number, CI_FIXER_WINDOW_MS());
  if (attempts.total >= CI_FIXER_MAX_ATTEMPTS()) {
    const windowHours = Math.round(CI_FIXER_WINDOW_MS() / (60 * 60 * 1000));
    const reason = `Exceeded maximum of ${CI_FIXER_MAX_ATTEMPTS()} fix attempts in ${windowHours}h window`;
    await triggerCircuitBreaker(fullName, pr, reason, attempts);
    return null;
  }

  // Check consecutive failures — exclude transient infrastructure failures from the count
  const nonTransientFailed = attempts.failed - attempts.transientApiFailed;
  if (nonTransientFailed >= CI_FIXER_MAX_CONSECUTIVE_FAILURES() && attempts.successful === 0) {
    const reason = `${nonTransientFailed} consecutive failures without any successful fixes`;
    await triggerCircuitBreaker(fullName, pr, reason, attempts);
    return null;
  }

  const state = await gh.getPRMergeableState(fullName, pr.number);
  if (state === "CONFLICTING") {
    return { kind: "conflict", repo, pr };
  }

  const failedCheck = await gh.getFailingCheck(fullName, pr.number);
  if (!failedCheck) return null;

  if (CANCELLED_STATES.has(failedCheck.state)) {
    const match = failedCheck.link?.match(/\/actions\/runs\/(\d+)/);
    if (match && deadRerunIds.has(match[1])) return null;
    if (match) return { kind: "rerun", repo, pr, runId: match[1] };
    log.warn(`[ci-fixer] Cancelled check for ${fullName}#${pr.number} has no re-runnable link`);
    return null;
  }

  log.info(`[ci-fixer] CI failure detected for ${fullName}#${pr.number}`);
  return { kind: "fix", repo, pr, failedCheck };
}

async function handleMissingFailLog(repo: Repo, pr: gh.PR, failedCheck: gh.FailedCheck): Promise<void> {
  const fullName = repo.fullName;
  const match = failedCheck.link?.match(/\/actions\/runs\/(\d+)/);

  // Terminal: no fetchable log AND no re-runnable link. Count it so the breaker trips.
  if (!match) {
    const taskId = db.recordTaskStart("ci-fixer", fullName, pr.number, null);
    log.warn(`[ci-fixer] No failure logs and no re-runnable link for ${fullName}#${pr.number}`);
    db.recordTaskFailed(taskId, "No failure logs and no re-runnable link (run logs expired or job deleted)", { failureCategory: "logs-unavailable" });
    return;
  }
  const runId = match[1];

  // Billing block has its own label-based handling — do NOT count toward the breaker.
  const annotations = await gh.getRunAnnotations(fullName, runId);
  if (gh.isBillingBlocked(annotations)) {
    log.warn(`[ci-fixer] Skipping rerun for ${fullName}#${pr.number}: GitHub Actions billing/spending-limit issue on the repo (run ${runId}). Resolve in repo "Billing & plans" settings.`);
    await gh.addLabel(fullName, pr.number, LABELS.billing);
    return;
  }

  // No fetchable logs but the run may be re-runnable: attempt a rerun to regenerate logs,
  // but record this as a non-transient attempt so a PR whose logs are permanently
  // unfetchable trips the circuit breaker instead of looping forever.
  const taskId = db.recordTaskStart("ci-fixer", fullName, pr.number, null);
  log.info(`[ci-fixer] No failure logs for ${fullName}#${pr.number}, re-running workflow`);
  try {
    await gh.rerunWorkflow(fullName, runId);
  } catch (err) {
    if (err instanceof Error && /already running/i.test(err.message)) {
      log.info(`[ci-fixer] workflow ${runId} for ${fullName}#${pr.number} already running`);
    } else if (err instanceof Error && /cannot be rerun|Resource not accessible/i.test(err.message)) {
      log.warn(`[ci-fixer] Cannot rerun workflow ${runId} for ${fullName}#${pr.number}: ${err.message}`);
      await reportRunNotRerunnable(repo, pr, runId);
    } else {
      db.recordTaskFailed(taskId, String(err), { failureCategory: "logs-unavailable" });
      throw err;
    }
  }
  db.recordTaskFailed(taskId, "CI run logs were not fetchable (expired/deleted); re-ran workflow", { failureCategory: "logs-unavailable" });
}

/** Classify and dispatch a CI fix, called from the CI_FIXER work handler. */
export async function runCIFix(repo: Repo, pr: gh.PR, failedCheck: gh.FailedCheck): Promise<void> {
  const fullName = repo.fullName;

  const failLog = await gh.getFailedRunLog(fullName, pr.number);
  if (!failLog) {
    await handleMissingFailLog(repo, pr, failedCheck);
    return;
  }

  if (isCIUnrelatedFixPR(pr)) {
    log.info(`[ci-fixer] ${fullName}#${pr.number} is a ci-unrelated fix PR — skipping classification, treating as related`);
    await fixCI(repo, pr, failLog);
    return;
  }

  const changedFiles = await gh.getPRChangedFiles(fullName, pr.number);
  const classification = await classifyCIFailure(repo, pr, failLog, changedFiles);

  if (classification.related) {
    await fixCI(repo, pr, failLog);
    return;
  }

  log.info(`[ci-fixer] Failure for ${fullName}#${pr.number} classified as unrelated: ${classification.reason}`);
  await fileUnrelatedIssue(fullName, [{
    fingerprint: classification.fingerprint,
    reason: classification.reason,
    failLog,
    pr,
    runUrl: failedCheck.link ?? "",
  }]);
  await revertPreviousUnrelatedFixes(repo, pr, changedFiles);
  await mergeBaseIfBehind(repo, pr);
}

export async function fixCI(repo: Repo, pr: gh.PR, failLog: string): Promise<void> {
  const fullName = repo.fullName;
  await db.withTaskRecording("ci-fixer", fullName, pr.number, null, async (taskId) => {
    const result = await claude.withExistingWorktree(
      repo, pr.headRefName, "ci-fixer",
      async (wtPath) => {
        db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

        const guardCtx = makeGuardCtx(fullName, pr.number);
        const prompt = [
          `You are fixing a CI failure on a pull request in the repository ${fullName}.`,
          `PR #${pr.number}: ${guardContent(pr.title, guardCtx("pr-title"))}`,
          `Branch: ${guardContent(pr.headRefName, guardCtx("pr-branch"))}`,
          ``,
          `The CI checks have failed. Here are the relevant failure logs:`,
          ``,
          "```",
          guardContent(failLog, guardCtx("ci-log")),
          "```",
          ``,
          `Please analyze the failure and make the necessary code changes to fix it.`,
          `Make commits with clear messages as you work.`,
          ``,
          CI_FIXER_FAST_CHECKS_GUIDANCE,
          RUNNER_POLICY_CONTEXT,
          ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
        ].join("\n");

        const mcpConfigPath = claude.writeClawsMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName) });
        const agentDoc = claude.readRepoAgentDoc(wtPath, "issue-implementer");
        const timeoutMs = getItemTimeoutMs(fullName, pr.number);
        const tier = await classifyComplexity(
          [
            `CI failure on PR #${pr.number} in ${fullName}.`,
            `PR title: ${pr.title}`,
            ``,
            `Failure log (first 2000 chars):`,
            failLog.slice(0, 2000),
          ].join("\n"),
          wtPath,
        );
        const model = getModel(tier, "tool-use", "claude");
        db.updateTaskModel(taskId, model);
        log.info(`[ci-fixer] Using model "${model}" for CI fix on ${fullName}#${pr.number}`);
        let actualProvider: Provider = "claude";
        await claude.runClaude(prompt, wtPath, { capability: "tool-use", mcpConfig: mcpConfigPath, timeoutMs, tier, model, appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onTokensUsed: db.trackTaskTokens(taskId), agent: "build", captureLabel: "ci-fixer" });

        let outcome: TaskOutcome = { commits: 0 };

        if (await claude.hasNewCommits(wtPath, pr.headRefName)) {
          outcome = await pushAndUpdatePR(wtPath, repo, pr, model, actualProvider, "CI fixed with", "Pushed fix");
        } else {
          log.warn(`[ci-fixer] No commits produced for ${fullName}#${pr.number}`);
        }

        db.recordTaskComplete(taskId, outcome);
      },
    );

    if (result === null) {
      log.info(`[ci-fixer] Branch ${pr.headRefName} no longer exists for PR #${pr.number} in ${fullName} — skipping (likely merged/closed)`);
      db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "skipped" });
    }
  });
}

export async function fileUnrelatedIssue(
  repoName: string,
  occurrences: Array<{ fingerprint: string; reason: string; failLog: string; pr: gh.PR; runUrl: string }>,
): Promise<void> {
  const title = `[ci-unrelated] CI failures unrelated to PR changes`;

  try {
    const existing = await gh.findIssueByExactTitle(repoName, title);

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
      const guardCtx = makeGuardCtx(repoName, occ.pr.number);
      const abbreviatedLog = guardContent(occ.failLog.slice(0, 2000), guardCtx("ci-log"));
      const comment = [
        `### ${occ.fingerprint} — ${new Date().toISOString()}`,
        "",
        `**Observed on:** PR #${occ.pr.number} (${guardContent(occ.pr.title, guardCtx("pr-title"))})`,
        `**Reason:** ${occ.reason}`,
        `**Failing run:** ${occ.runUrl}`,
        "",
        "```",
        abbreviatedLog,
        "```",
      ].join("\n");
      await gh.commentOnIssue(repoName, issueNumber, comment, { agentName: "CI Fixer" });
      log.info(`[ci-fixer] Updated issue #${issueNumber} for "${occ.fingerprint}"`);
    }
  } catch (err) {
    log.warn(`[ci-fixer] Failed to file unrelated issue: ${err}`);
    reportError("ci-fixer:file-unrelated-issue", repoName, err);
  }
}

export async function revertPreviousUnrelatedFixes(
  repo: Repo,
  pr: gh.PR,
  changedFiles: string[],
): Promise<void> {
  const fullName = repo.fullName;

  // Skip if Claws has never run ci-fixer on this PR
  if (!db.hasPreviousCiFixerTasks(fullName, pr.number)) {
    return;
  }

  await db.withTaskRecording("ci-fixer:revert", fullName, pr.number, null, async (taskId) => {
    const result = await claude.withExistingWorktree(
      repo, pr.headRefName, "ci-fixer-revert",
      async (wtPath) => {
        db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

        const gitLog = await claude.git(
          ["log", "--oneline", `origin/${pr.baseRefName}..HEAD`],
          wtPath,
        );

        const guardCtx = makeGuardCtx(fullName, pr.number);
        const prompt = [
          `You are examining commits on a pull request branch to identify and revert automated CI fix attempts that were for issues UNRELATED to the PR's purpose.`,
          ``,
          `PR #${pr.number}: ${guardContent(pr.title, guardCtx("pr-title"))}`,
          `Branch: ${guardContent(pr.headRefName, guardCtx("pr-branch"))}`,
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

        const mcpConfigPath = claude.writeClawsMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName) });
        const agentDoc = claude.readRepoAgentDoc(wtPath, "issue-implementer");
        const timeoutMs = getItemTimeoutMs(fullName, pr.number);
        const tier = await classifyComplexity(
          [
            `Reviewing commits on PR #${pr.number} in ${fullName} to identify and revert unrelated automated CI fixes.`,
            `PR title: ${pr.title}`,
          ].join("\n"),
          wtPath,
        );
        const model = getModel(tier, "tool-use", "claude");
        db.updateTaskModel(taskId, model);
        log.info(`[ci-fixer] Using model "${model}" for unrelated-fix revert on ${fullName}#${pr.number}`);
        await claude.runClaude(prompt, wtPath, { capability: "tool-use", mcpConfig: mcpConfigPath, timeoutMs, tier, model, appendSystemPrompt: agentDoc, onTokensUsed: db.trackTaskTokens(taskId), agent: "build", captureLabel: "ci-fixer" });

        let outcome: TaskOutcome = { commits: 0 };

        if (await claude.hasNewCommits(wtPath, pr.headRefName)) {
          await claude.pushBranch(wtPath, pr.headRefName, repo.owner);
          log.info(`[ci-fixer] Reverted unrelated fixes for ${fullName}#${pr.number}`);
          outcome = await buildSuccessOutcome(wtPath, pr.baseRefName, pr.number, "updated");
        }

        db.recordTaskComplete(taskId, outcome);
      },
    );

    if (result === null) {
      log.info(`[ci-fixer] Branch ${pr.headRefName} no longer exists for PR #${pr.number} in ${fullName} — skipping revert (likely merged/closed)`);
      db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "skipped" });
    }
  }).catch((err) => {
    log.warn(`[ci-fixer] Revert of unrelated fixes failed for ${fullName}#${pr.number}: ${err}`);
  });
}

export async function mergeBaseIfBehind(repo: Repo, pr: gh.PR): Promise<void> {
  const fullName = repo.fullName;
  await db.withTaskRecording("ci-fixer:merge-base", fullName, pr.number, null, async (taskId) => {
    const result = await claude.withExistingWorktree(
      repo, pr.headRefName, "ci-fixer-merge-base",
      async (wtPath) => {
        db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

        const behindCount = (await claude.git(
          ["rev-list", "--count", `HEAD..origin/${pr.baseRefName}`],
          wtPath,
        )).trim();

        if (behindCount === "0") {
          log.info(`[ci-fixer] Branch for ${fullName}#${pr.number} is already up-to-date with ${pr.baseRefName}`);
          db.recordTaskComplete(taskId, { commits: 0 });
          return;
        }

        log.info(`[ci-fixer] Branch for ${fullName}#${pr.number} is ${behindCount} commits behind ${pr.baseRefName}, merging`);

        const { clean } = await claude.attemptMerge(wtPath, pr.baseRefName);

        if (clean) {
          await claude.pushBranch(wtPath, pr.headRefName, repo.owner);
          log.info(`[ci-fixer] Merged ${pr.baseRefName} into ${pr.headRefName} for ${fullName}#${pr.number}`);
          const diffStats = await claude.getDiffStats(wtPath, pr.baseRefName).catch(() => undefined);
          db.recordTaskComplete(taskId, { commits: 1, ...diffStats, prNumber: pr.number, prAction: "updated" });
        } else {
          await claude.abortMerge(wtPath);
          log.info(`[ci-fixer] Merge of ${pr.baseRefName} into ${pr.headRefName} has conflicts for ${fullName}#${pr.number}, skipping`);
          db.recordTaskComplete(taskId, { commits: 0 });
        }
      },
    );

    if (result === null) {
      log.info(`[ci-fixer] Branch ${pr.headRefName} no longer exists for PR #${pr.number} in ${fullName} — skipping merge-base (likely merged/closed)`);
      db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "skipped" });
    }
  }).catch((err) => {
    log.warn(`[ci-fixer] Merge-base failed for ${fullName}#${pr.number}: ${err}`);
  });
}

export function isCIUnrelatedFixPR(pr: gh.PR): boolean {
  return pr.title.includes("[ci-unrelated]");
}

