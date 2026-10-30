import type { IssueRef } from "../issue-id.js";
import { z } from "zod";
import { type Repo, forgejoRepoUrl, LABELS, CI_FIXER_MAX_ATTEMPTS, CI_FIXER_WINDOW_MS, CI_FIXER_MAX_CONSECUTIVE_FAILURES, CI_FIXER_MAX_CONFLICT_ATTEMPTS, CI_FIXER_MAX_COMMIT_GRANTS, HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN } from "../config.js";
import * as gh from "../github.js";
import { ForgejoActionNotFoundError, ForgejoRerunEndpointUnavailableError, TransientForgejoError } from "../forgejo.js";
import * as claude from "../claude.js";
import { OversizedPushError } from "../push-guard.js";
import * as log from "../log.js";
import * as db from "../db.js";
import type { TaskOutcome } from "../db.js";
import { buildSuccessOutcome } from "../outcome.js";
import { reportError } from "../error-reporter.js";
import { getItemTimeoutMs } from "../timeout-handler.js";
import { guardContent, makeGuardCtx, formatGuardedTitleList } from "../prompt-guard.js";
import { CI_FIXER_FAST_CHECKS_GUIDANCE, RUNNER_POLICY_CONTEXT, HOST_EXECUTION_POLICY, NO_STACKED_PRS_POLICY, forgeContext, homeAssistantContext, loadRepoAgentDoc } from "./agent-context.js";
import { isHomeAssistantConfigRepo, homeAssistantMcpAvailable } from "../home-assistant.js";
import { resolveModelPlanCell } from "../model-plan.js";
import { classifyComplexity } from "../classify-complexity.js";
import type { Provider } from "../plan-parser.js";
import { parseFirstValidJson } from "../json-extract.js";
import { extractManualActionSection, MANUAL_ACTION_HEADING, regenerateAndUpdatePRBody } from "./issue-worker.js";
import { resolveAlertIssue } from "../occurrence-tracking.js";
import { excerptLog } from "../log-excerpt.js";
import { hasManualAction, isProblematic } from "../pr-state.js";
import { CI_RERUN_REFUSED_PREFIX, blockLinkedIssue, clearPrHold, recordPrHold } from "../pr-hold.js";
import { isIdleAwaitingHuman } from "./auto-merger.js";
import { AUXILIARY_AGENT_ADMISSION_BYTES } from "../agent-memory-budget.js";

async function persistProviderModel(taskId: number, provider: Provider, model: string, account?: string): Promise<void> {
  const results = await Promise.allSettled([
    db.updateTaskProvider(taskId, provider, account),
    db.updateTaskModel(taskId, model),
  ]);
  for (const r of results) {
    if (r.status === "rejected") log.warn(`[ci-fixer] Could not persist provider/model for task ${taskId}: ${r.reason}`);
  }
}

export type WorkItem =
  | { kind: "conflict"; repo: Repo; pr: gh.PR }
  | { kind: "rerun"; repo: Repo; pr: gh.PR; runId: string; infra?: boolean }
  | { kind: "fix"; repo: Repo; pr: gh.PR; failedCheck: gh.FailedCheck };

/**
 * Push the PR branch and remember the resulting head SHA as one Claws pushed
 * itself. The new-commit circuit-breaker grant keys off "the head moved to a
 * commit we didn't push", so every ci-fixer push must go through here — a
 * missed call site lets a failed fix attempt reset its own attempt budget.
 */
async function pushPRBranch(wtPath: string, repo: Repo, pr: gh.PR): Promise<void> {
  try {
    await claude.pushBranch(wtPath, pr.headRefName, repo);
  } catch (err) {
    if (err instanceof OversizedPushError) {
      await gh.commentOnIssue(repo.fullName, pr.number, "## Push refused\n\n" + err.message, { agentName: "CI Fixer" })
        .catch((commentErr) => log.warn(`[ci-fixer] Could not post push refusal on ${repo.fullName}#${pr.number}: ${commentErr}`));
    }
    throw err;
  }
  try {
    await db.recordCIFixerPush(repo.fullName, pr.number, (await claude.getHeadSha(wtPath)).trim());
  } catch (err) {
    log.warn(`[ci-fixer] Could not record pushed head SHA for ${repo.fullName}#${pr.number}: ${err}`);
  }
}

async function pushAndUpdatePR(
  wtPath: string,
  repo: Repo,
  pr: gh.PR,
  model: string,
  actualProvider: Provider,
  attributionVerb: string,
  successLog: string,
  providerNote = "",
): Promise<TaskOutcome> {
  const fullName = repo.fullName;
  await pushPRBranch(wtPath, repo, pr);
  await regenerateAndUpdatePRBody(wtPath, fullName, pr, model, actualProvider, attributionVerb, "[ci-fixer]", providerNote);
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
      repo, pr.headRefName, "ci-fixer-conflict",
      async (wtPath) => {
        await db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

        try {
          const { clean, conflictedFiles } = await claude.attemptMerge(wtPath, pr.baseRefName);

          if (clean) {
            // Merge was auto-resolved by git — just push
            await pushPRBranch(wtPath, repo, pr);
            log.info(`[ci-fixer] Clean merge pushed for ${fullName}#${pr.number}`);
            const diffStats = await claude.getDiffStats(wtPath, pr.baseRefName).catch(() => undefined);
            const headSha = await claude.getHeadSha(wtPath).catch(() => undefined);
            await db.recordTaskComplete(taskId, {
              commits: 1,
              ...diffStats,
              prNumber: pr.number,
              prAction: "updated",
              headSha,
            });
            return true;
          }

          // Conflicts need Claude to resolve
          const guardCtx = makeGuardCtx(fullName, pr.number);
          const prompt = [
            `You are resolving merge conflicts on a pull request in the repository ${fullName}.`,
            `PR #${pr.number}: ${await guardContent(pr.title, guardCtx("pr-title"))}`,
            `Branch: ${await guardContent(pr.headRefName, guardCtx("pr-branch"))} (merging ${pr.baseRefName} into it)`,
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
            `Do NOT push the branch, open a pull request or change any PR's base branch. Claws pushes your commits after you finish.`,
            ``,
            RUNNER_POLICY_CONTEXT,
            HOST_EXECUTION_POLICY,
            NO_STACKED_PRS_POLICY,
            forgeContext(repo),
            ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
          ].join("\n");

          const mcpConfigPath = claude.writeAgentMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName), taskId });
          const agentDoc = loadRepoAgentDoc(wtPath, fullName, "issue-implementer");
          const timeoutMs = getItemTimeoutMs(fullName, pr.number);
          const classifiedTier = await classifyComplexity(
            [
              `Resolving merge conflicts on PR #${pr.number} in ${fullName}.`,
              `PR title: ${pr.title}`,
              ``,
              `Conflicted files:`,
              conflictedFiles.map((f) => `- ${f}`).join("\n"),
            ].join("\n"),
            wtPath,
          );
          const { provider, strictProvider, eligibleProviders, overrideIgnoredReason, tier, model } = await resolveModelPlanCell(fullName, gh.getLinkedIssueNumber(pr), "ci-fix", {
            tier: classifiedTier,
            labels: pr.labels,
            requiresMcp: homeAssistantMcpAvailable(fullName),
          });
          if (overrideIgnoredReason) log.warn(`[ci-fixer] ${fullName}#${pr.number}: ${overrideIgnoredReason}`);
          const providerNote = overrideIgnoredReason ? `; ${overrideIgnoredReason}` : "";
          let tierNote = "";
          log.info(`[ci-fixer] Using model "${model}" for conflict resolution on ${fullName}#${pr.number}`);
          let actualProvider: Provider = provider;
          let actualAccount: string | undefined;
          let actualModel = model;
          const startSha = (await claude.getHeadSha(wtPath)).trim();
          try {
            await claude.runClaude(prompt, wtPath, { mcpConfig: mcpConfigPath, timeoutMs, tier, model, provider, strictProvider, eligibleProviders, appendSystemPrompt: agentDoc, onProviderUsed: (p, a) => { actualProvider = p; actualAccount = a; }, onAttemptModelUsed: (_p, m) => { actualModel = m ?? "default"; }, onTierFallback: (from) => { tierNote = claude.tierFallbackNote(from); }, onTokensUsed: db.trackTaskTokens(taskId), agent: "build", captureLabel: "ci-fixer", forgejoAccessRepo: repo.fullName });
          } finally {
            await persistProviderModel(taskId, actualProvider, actualModel, actualAccount);
          }

          let outcome: TaskOutcome = { commits: 0 };

          if ((await claude.getHeadSha(wtPath)).trim() !== startSha) { // HEAD movement: an agent-issued push would hide commits from hasNewCommits
            outcome = await pushAndUpdatePR(wtPath, repo, pr, actualModel, actualProvider, "Conflict resolved with", "Conflict resolution pushed", providerNote + tierNote);
          } else {
            log.warn(`[ci-fixer] No commits from conflict resolution for ${fullName}#${pr.number}`);
            await claude.abortMerge(wtPath);
          }

          await db.recordTaskComplete(taskId, outcome);
          return true;
        } catch (innerErr) {
          try { await claude.abortMerge(wtPath); } catch { /* merge may not be in progress */ }
          throw innerErr;
        }
      },
    );

    if (result === null) {
      log.info(`[ci-fixer] Branch ${pr.headRefName} no longer exists for PR #${pr.number} in ${fullName} — skipping (likely merged/closed)`);
      await db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "skipped" });
      return false;
    }
    return result;
  });
}

const CANCELLED_STATES = new Set(["CANCELLED", "STARTUP_FAILURE"]);

// Run IDs the forge refused to re-run. Without this, identifyPRWork re-classifies the
// same dead run as rerun work every sweep and the handler retries it every
// cycle forever (3d-models#289 looped for days). In-memory by design: a
// restart costs one extra attempt per run, then it is re-marked.
const deadRerunIds = new Set<string>();

/** Key for the per-run re-run state in this module. Forgejo run ids are per-repo run
 * numbers, so a bare id would share one repo's run 57 budget with every other repo's. */
function rerunKey(fullName: string, runId: string): string {
  return `${fullName}:${runId}`;
}

export function _resetDeadRerunIdsForTests(): void {
  deadRerunIds.clear();
}

// Run IDs already auto-re-run once after an "unrelated" classification. Re-running
// failed jobs keeps the same run number, so a second failure presents the same ID
// here and is skipped — one retry per run, never a loop.
const autoRerunIds = new Set<string>();

export function _resetAutoRerunIdsForTests(): void {
  autoRerunIds.clear();
}

/** After a conflict-resolution attempt that never reached the agent (every provider
 *  rate-limited, session limit hit), wait this long before re-dispatching. The
 *  pr-dispatcher sweeps every 90 s, so without it a 40-minute outage produces dozens
 *  of 1-second task rows (#2977). */
export const CONFLICT_PROVIDER_BACKOFF_MS = 15 * 60 * 1000;

/** Retries allowed per run ID that keeps coming back as a runner outage. Bounds the
 * loop when the whole pool is down — after this the run falls through to the normal
 * fix path and the circuit breaker behaves exactly as it did before. */
const INFRA_MAX_RERUNS = 3;

/** Failed rerun *calls* allowed per run ID, counted separately from INFRA_MAX_RERUNS
 * because a call that threw never re-tested anything. Without this bound a run the forge
 * permanently refuses to re-run (endpoint unavailable, run no longer exists) never
 * increments either counter, so every sweep re-classifies it as an outage and re-calls
 * performRerun forever — the loop deadRerunIds exists to prevent, reintroduced. */
const INFRA_MAX_RERUN_FAILURES = 2;

/** Attempts that read no CI log and only re-ran the workflow (`rerun-only`) allowed in
 * the fix window before the breaker trips with a runner/infra reason. They are excluded
 * from the CI_FIXER_MAX_ATTEMPTS budget, so this is what stops a PR whose logs never
 * become readable from re-running forever (the bonkus#1652 loop). */
const CI_FIXER_MAX_RERUN_ONLY_ATTEMPTS = 3;

// In-memory by design, same trade-off as deadRerunIds: a restart costs one extra retry.
const infraRerunCounts = new Map<string, number>();
const infraRerunFailures = new Map<string, number>();

export function _resetInfraRerunsForTests(): void {
  infraRerunCounts.clear();
  infraRerunFailures.clear();
}

export function noteInfraRerun(fullName: string, runId: string): void {
  const key = rerunKey(fullName, runId);
  infraRerunCounts.set(key, (infraRerunCounts.get(key) ?? 0) + 1);
}

/** Record a rerun call the forge rejected outright, so an un-rerunnable run stops being
 * re-picked as infra work instead of retrying every sweep forever. */
export function noteInfraRerunFailure(fullName: string, runId: string): void {
  const key = rerunKey(fullName, runId);
  infraRerunFailures.set(key, (infraRerunFailures.get(key) ?? 0) + 1);
}

export function isInfraRerunExhausted(fullName: string, runId: string): boolean {
  const key = rerunKey(fullName, runId);
  return (infraRerunCounts.get(key) ?? 0) >= INFRA_MAX_RERUNS
    || (infraRerunFailures.get(key) ?? 0) >= INFRA_MAX_RERUN_FAILURES;
}

/**
 * Executes a "rerun" work item. Returns true if a rerun was triggered.
 * Infra-outage runs re-run only their failed jobs and NEVER get a refused-re-run
 * hold — a runner restart is not a PR defect (fleet-infra#745, 3d-models#350 were
 * both held for manual action + Claws Problematic for hours by the old path, then
 * went 12/12 green on a single manual re-run, unchanged).
 */
export async function performRerun(item: Extract<WorkItem, { kind: "rerun" }>): Promise<boolean> {
  const fullName = item.repo.fullName;

  if (item.infra) {
    // Counted only once a rerun has actually been triggered: a rerun call that fails
    // outright never re-tested anything, so it must not burn one of the retries.
    try {
      await gh.rerunFailedJobs(fullName, item.runId);
      noteInfraRerun(fullName, item.runId);
      log.info(`[ci-fixer] Re-ran failed jobs of ${item.runId} for ${fullName}#${item.pr.number} (runner outage)`);
      return true;
    } catch (err) {
      if (err instanceof Error && /already running/i.test(err.message)) {
        noteInfraRerun(fullName, item.runId);
        log.info(`[ci-fixer] workflow ${item.runId} for ${fullName}#${item.pr.number} already running`);
        return true;
      }
      // No whole-run fallback: Forgejo has no whole-run rerun, and rerunWorkflow
      // calls the same rerun-failed endpoint, so it would only repeat the refused call.
      if (err instanceof TransientForgejoError) {
        log.warn(`[ci-fixer] rerunFailedJobs failed transiently for ${fullName}#${item.pr.number} run ${item.runId}: ${err.message}`);
        return false;
      }
      noteInfraRerunFailure(fullName, item.runId);
      if (err instanceof ForgejoRerunEndpointUnavailableError || err instanceof ForgejoActionNotFoundError) {
        log.warn(`[ci-fixer] Cannot re-run run ${item.runId} for ${fullName}#${item.pr.number}: ${err.message}`);
      } else {
        log.warn(`[ci-fixer] rerunFailedJobs failed for ${fullName}#${item.pr.number} run ${item.runId}: ${err}`);
      }
      return false;
    }
  }

  try {
    await gh.rerunWorkflow(fullName, item.runId);
    return true;
  } catch (err) {
    if (err instanceof Error && /already running/i.test(err.message)) {
      log.info(`[ci-fixer] workflow ${item.runId} for ${fullName}#${item.pr.number} already running`);
      return false;
    }
    if (err instanceof ForgejoRerunEndpointUnavailableError || err instanceof ForgejoActionNotFoundError) {
      log.warn(`[ci-fixer] workflow ${item.runId} for ${fullName}#${item.pr.number} cannot be rerun: ${err.message}`);
      await reportRunNotRerunnable(item.repo, item.pr, item.runId);
      return false;
    }
    throw err;
  }
}

/** Opening delimiter of the note this function writes; carries the run it was written for.
 * A full opener is `${NOT_RERUNNABLE_MARKER} ${runId} -->`. */
export const NOT_RERUNNABLE_MARKER = "<!-- claws:not-rerunnable-run:";
/** Closing delimiter of the note this function writes. */
export const NOT_RERUNNABLE_END = "<!-- /claws:not-rerunnable -->";

/** Drop the manual-action heading if nothing is left under it — otherwise removing our
 * note would leave a bare heading promising an action that is no longer described. */
function dropEmptyManualActionHeading(body: string): string {
  const idx = body.indexOf(MANUAL_ACTION_HEADING);
  if (idx === -1) return body;
  const contentStart = idx + MANUAL_ACTION_HEADING.length;
  const nextHeading = body.indexOf("\n## ", contentStart);
  const end = nextHeading === -1 ? body.length : nextHeading;
  if (body.slice(contentStart, end).trim() !== "") return body;
  return (body.slice(0, idx) + body.slice(end)).replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** Remove a previously-written not-rerunnable note (and only that — a manual-action note
 * written by another agent sits outside our delimiters and is left intact, even when it
 * shares the manual-action heading with ours). */
export function stripNotRerunnableSection(body: string): string {
  const start = body.indexOf(NOT_RERUNNABLE_MARKER);
  if (start === -1) return body;
  const endIdx = body.indexOf(NOT_RERUNNABLE_END, start);
  const end = endIdx === -1 ? body.length : endIdx + NOT_RERUNNABLE_END.length;
  const withoutNote = (body.slice(0, start) + body.slice(end)).replace(/\n{3,}/g, "\n\n").trimEnd();
  return dropEmptyManualActionHeading(withoutNote);
}

/**
 * Record that the forge refused to re-run `runId`: hold the PR with a
 * {@link CI_RERUN_REFUSED_PREFIX} reason, park its issue in Blocked (Claws
 * cannot move on), and write a one-time notice into the PR body's
 * manual-action section so a human knows to trigger a fresh CI run (push a
 * commit or close/reopen the PR). Once marked, identifyPRWork stops
 * classifying the run as rerun work. The hold lifts itself once CI is green
 * ({@link clearNotRerunnableIfResolved}).
 */
export async function reportRunNotRerunnable(repo: Repo, pr: gh.PR, runId: string): Promise<void> {
  const alreadyKnown = deadRerunIds.has(rerunKey(repo.fullName, runId));
  deadRerunIds.add(rerunKey(repo.fullName, runId));
  if (alreadyKnown) {
    log.info(`[ci-fixer] Run ${runId} for ${repo.fullName}#${pr.number} is already marked not-rerunnable — skipping notice`);
    return;
  }
  log.warn(`[ci-fixer] The forge refused to re-run ${runId} for ${repo.fullName}#${pr.number}, retries stopped, holding the PR`);
  try {
    await recordPrHold(repo.fullName, pr.number, `${CI_RERUN_REFUSED_PREFIX} run ${runId}`);
    await blockLinkedIssue(repo.fullName, pr.number,
      `The forge refused to re-run CI run ${runId} on PR \`${repo.fullName}#${pr.number}\`, so automatic CI retries for it have stopped. Trigger a fresh CI run — push a commit to \`${pr.headRefName}\`, or close and reopen the PR — then move this issue out of Blocked.`,
      `ci-rerun-refused-${pr.number}-${runId}`,
      { headRefName: pr.headRefName, agentName: "CI Fixer" });
  } catch (err) {
    log.warn(`[ci-fixer] Could not hold ${repo.fullName}#${pr.number} for its refused re-run: ${err}`);
  }
  try {
    const guardCtx = makeGuardCtx(repo.fullName, pr.number);
    const branch = await guardContent(pr.headRefName, guardCtx("pr-branch"));
    const body = await gh.getPRBody(repo.fullName, pr.number);
    if (body.includes(`${NOT_RERUNNABLE_MARKER} ${runId} -->`)) return;
    const stripped = stripNotRerunnableSection(body);
    const hasForeignSection = extractManualActionSection(stripped) !== null;
    const note = [
      `${NOT_RERUNNABLE_MARKER} ${runId} -->`,
      `Claws tried to re-run CI run [${runId}](${forgejoRepoUrl(repo.fullName)}/actions/runs/${runId}), but the forge refused: its re-run-failed-jobs endpoint is unavailable or the run no longer exists.`,
      ``,
      `Automatic CI retries for this PR have stopped. To unblock it, trigger a fresh CI run: push a new commit to \`${branch}\`, or close and reopen this PR.`,
      NOT_RERUNNABLE_END,
    ].join("\n");
    const section = hasForeignSection ? note : `${MANUAL_ACTION_HEADING}\n\n${note}`;
    await gh.updatePR(repo.fullName, pr.number, `${stripped}\n\n${section}`.trim());
  } catch (err) {
    log.warn(`[ci-fixer] Failed to write not-rerunnable notice for ${repo.fullName}#${pr.number}: ${err}`);
  }
}

/** Visible marker line identifying Claws' conflict-budget notice comment. */
export const CONFLICT_BUDGET_MARKER = "conflict-budget-exhausted";

// PRs already told (once) that the conflict budget is spent. In-memory by design, same
// trade-off as deadRerunIds: a restart costs one extra getIssueComments call, which then
// finds the marker and stays quiet.
const conflictBudgetNoticed = new Set<string>();

export function _resetConflictBudgetNoticesForTests(): void {
  conflictBudgetNoticed.clear();
}

/**
 * Post one comment explaining that automatic conflict resolution has stopped, so the
 * operator can see why a CONFLICTING PR is sitting still — previously this state was
 * only visible in the dispatcher log (#2977). Never posts twice for the same PR.
 */
async function reportConflictBudgetExhausted(repo: Repo, pr: gh.PR, unproductive: number): Promise<void> {
  const key = `${repo.fullName}#${pr.number}`;
  if (conflictBudgetNoticed.has(key)) return;
  try {
    const existing = await gh.getIssueComments(repo.fullName, pr.number);
    if (existing.some((c) => c.body.includes(CONFLICT_BUDGET_MARKER))) {
      conflictBudgetNoticed.add(key);
      return;
    }
    const windowHours = Math.round(CI_FIXER_WINDOW_MS() / (60 * 60 * 1000));
    const body = [
      `### ⚠️ Automatic conflict resolution stopped`,
      CONFLICT_BUDGET_MARKER,
      ``,
      `This PR is \`CONFLICTING\` and ${unproductive} conflict-resolution attempts in the last ${windowHours}h produced no commit, so Claws will not try again in this window.`,
      ``,
      `Nothing else unblocks a conflicting PR — the reviewer, review-addresser and auto-merger all skip \`CONFLICTING\` PRs. Resolve the conflicts manually (or push any commit to \`${pr.headRefName}\`) to hand it back to Claws.`,
    ].join("\n");
    await gh.commentOnIssue(repo.fullName, pr.number, body, { agentName: "CI Fixer" });
    conflictBudgetNoticed.add(key);
    log.info(`[ci-fixer] Posted conflict-budget notice on ${key}`);
  } catch (err) {
    log.warn(`[ci-fixer] Could not post the conflict-budget notice on ${key}: ${err}`);
  }
}

/** Visible marker line identifying the CI fixer's give-up comment. */
export const CI_FIX_GIVE_UP_MARKER = "ci-fixer-gave-up";

/** Line the fix agent ends its final message with when it cannot fix the failure now. */
const CI_FIX_GIVE_UP_RE = /^CI-FIX-GIVE-UP:\s*(.+)$/gm;

/** Silent no-op fix runs (no commit, no give-up reason) allowed on one PR head. */
export const CI_FIXER_MAX_IDLE_RUNS_PER_HEAD = 2;

/** The reason from the last `CI-FIX-GIVE-UP:` line in the agent's output, capped at 500 chars. */
export function parseGiveUpReason(output: string): string | undefined {
  const matches = [...output.matchAll(CI_FIX_GIVE_UP_RE)];
  const reason = matches.at(-1)?.[1]?.trim();
  return reason ? reason.slice(0, 500) : undefined;
}

/**
 * Post (or edit in place) the single comment saying the CI fixer gave up and why, so
 * a counted attempt that pushed nothing is visible on the PR. With `rerunId`, says
 * instead that Claws re-ran the failed jobs of that run itself. Best effort.
 */
async function postGiveUpComment(fullName: string, pr: gh.PR, reason: string, rerunId?: string): Promise<void> {
  const body = [
    `### CI fixer gave up`,
    CI_FIX_GIVE_UP_MARKER,
    ``,
    `**Reason:** ${reason}`,
    ``,
    rerunId
      ? `This looks like a runner or infrastructure failure, so Claws re-ran the failed jobs of run ${rerunId} itself. This run is not counted as a fix attempt.`
      : `This run is counted as a fix attempt. Claws will not try again on this commit: once the blocking dependency is fixed, re-run CI, or push a commit to let Claws try again.`,
  ].join("\n");
  try {
    const existing = (await gh.getIssueComments(fullName, pr.number)).find((c) => c.body.includes(CI_FIX_GIVE_UP_MARKER));
    if (existing) {
      await gh.editIssueComment(fullName, existing.id, body, { agentName: "CI Fixer" });
    } else {
      await gh.commentOnIssue(fullName, pr.number, body, { agentName: "CI Fixer" });
    }
  } catch (err) {
    log.warn(`[ci-fixer] Could not post the give-up comment on ${fullName}#${pr.number}: ${err}`);
  }
}

/** A give-up reason naming a runner or infrastructure cause, which a re-run (not a commit) fixes. */
export const INFRA_GIVE_UP_RE = /\b(runner|infra(structure)?|transient|flak(y|e|iness)|dind|docker daemon|network)\b/i;

/**
 * When the agent gave up with a runner/infra reason, re-run the failed jobs of the
 * failing check's run through performRerun's infra path, so INFRA_MAX_RERUNS, INFRA_MAX_RERUN_FAILURES and deadRerunIds bound it exactly as they
 * bound an outage re-run; CI_FIXER_MAX_RERUN_ONLY_ATTEMPTS caps it per PR window.
 * Returns the run id when a re-run was triggered, else undefined (the caller then
 * posts today's give-up comment asking a human to re-run).
 */
async function rerunAfterInfraGiveUp(
  repo: Repo,
  pr: gh.PR,
  reason: string,
  failedCheck: gh.FailedCheck | undefined,
): Promise<string | undefined> {
  const fullName = repo.fullName;
  if (!INFRA_GIVE_UP_RE.test(reason)) {
    log.info(`[ci-fixer] Give-up on ${fullName}#${pr.number} names no runner/infra cause — not re-running`);
    return undefined;
  }
  const runId = failedCheck?.link?.match(/\/actions\/runs\/(\d+)/)?.[1];
  if (!runId) {
    log.info(`[ci-fixer] Runner/infra give-up on ${fullName}#${pr.number} but the failing check has no run link — asking a human to re-run`);
    return undefined;
  }
  if (deadRerunIds.has(rerunKey(fullName, runId)) || isInfraRerunExhausted(fullName, runId)) {
    log.info(`[ci-fixer] Runner/infra give-up on ${fullName}#${pr.number} but run ${runId} ${deadRerunIds.has(rerunKey(fullName, runId)) ? "cannot be re-run" : "has used its infra re-run budget"} — asking a human to re-run`);
    return undefined;
  }
  try {
    const budgetFloor = (await db.getCIFixerBreakerState(fullName, pr.number))?.budgetFloorAt ?? null;
    const attempts = await db.countCIFixerAttempts(fullName, pr.number, CI_FIXER_WINDOW_MS(), budgetFloor);
    if (attempts.rerunOnly >= CI_FIXER_MAX_RERUN_ONLY_ATTEMPTS) {
      log.info(`[ci-fixer] Runner/infra give-up on ${fullName}#${pr.number} but ${attempts.rerunOnly} re-run-only attempts are already in the window — asking a human to re-run`);
      return undefined;
    }
    if (await performRerun({ kind: "rerun", repo, pr, runId, infra: true })) {
      log.info(`[ci-fixer] Runner/infra give-up on ${fullName}#${pr.number} — re-ran the failed jobs of run ${runId}`);
      return runId;
    }
    log.info(`[ci-fixer] Runner/infra give-up on ${fullName}#${pr.number} — re-run of run ${runId} was deferred or refused, asking a human to re-run`);
  } catch (err) {
    log.warn(`[ci-fixer] Re-run after runner/infra give-up on ${fullName}#${pr.number} failed: ${err}`);
  }
  return undefined;
}

const CI_FIX_GIVE_UP_SUPERSEDED_HEADING = "### CI fixer gave up (superseded)";

/**
 * Edit an earlier give-up comment, if any, to say a later run pushed a fix, so the PR
 * doesn't show a stale reason next to the fix. Keeps the marker so a later give-up
 * reuses the same comment. Best effort.
 */
async function supersedeGiveUpComment(fullName: string, pr: gh.PR, headSha: string | undefined): Promise<void> {
  try {
    const existing = (await gh.getIssueComments(fullName, pr.number)).find((c) => c.body.includes(CI_FIX_GIVE_UP_MARKER));
    if (!existing || existing.body.includes(CI_FIX_GIVE_UP_SUPERSEDED_HEADING)) return;
    const body = [
      CI_FIX_GIVE_UP_SUPERSEDED_HEADING,
      CI_FIX_GIVE_UP_MARKER,
      ``,
      `A later CI-fix run pushed a fix${headSha ? ` (${headSha.slice(0, 7)})` : ""}, so the earlier give-up no longer applies.`,
    ].join("\n");
    await gh.editIssueComment(fullName, existing.id, body, { agentName: "CI Fixer" });
  } catch (err) {
    log.warn(`[ci-fixer] Could not update the give-up comment on ${fullName}#${pr.number}: ${err}`);
  }
}

/**
 * Lift the refused-CI-re-run hold once CI has gone green again.
 *
 * `reportRunNotRerunnable` holds the PR because automatic retries stopped on a run
 * the forge refuses to re-run. That reason evaporates the moment a fresh run passes —
 * whether a human pushed, Claws' own ci-fixer pushed a fix, or the PR was reopened —
 * so without this the hold outlives its cause and auto-merger skips a green,
 * mergeable PR forever (bstjohn-blog#581: green at 02:22, still unmerged hours later).
 *
 * Only a {@link CI_RERUN_REFUSED_PREFIX} hold is lifted; any other kind of hold
 * stays. The not-rerunnable note is stripped from the body either way.
 *
 * Returns true when the hold was lifted. Cheap by design: PRs whose `claws_prs`
 * row records no hold cost zero API calls, so this is safe to call for every PR
 * every sweep.
 */
export async function clearNotRerunnableIfResolved(repo: Repo, pr: gh.PR): Promise<boolean> {
  const fullName = repo.fullName;
  if (!hasManualAction(await db.getClawsPr(fullName, pr.number))) return false;

  let status: gh.CheckStatus;
  try {
    status = await gh.getPRCheckStatus(fullName, pr.number);
  } catch (err) {
    log.warn(`[ci-fixer] getPRCheckStatus failed for ${fullName}#${pr.number}: ${err}`);
    return false;
  }
  // Only "passing" clears. "none"/"pending" mean nothing has re-tested the branch yet,
  // and clearing on those would unblock a merge on unverified code.
  if (status !== "passing") return false;

  let body: string;
  try {
    body = await gh.getPRBody(fullName, pr.number);
  } catch (err) {
    log.warn(`[ci-fixer] getPRBody failed for ${fullName}#${pr.number}: ${err}`);
    return false;
  }
  // The marker is what proves *Claws* held this PR for a dead CI run.
  if (!body.includes(NOT_RERUNNABLE_MARKER)) return false;

  // Hold first, body second. The body marker is this function's own entry condition,
  // so rewriting the body before a hold write that then fails would leave the PR
  // blocked with nothing left for the next sweep to re-detect (same ordering rule as
  // maybeGrantNewCommitAttempt, #2391).
  let cleared: boolean;
  try {
    cleared = await clearPrHold(fullName, pr.number, CI_RERUN_REFUSED_PREFIX);
  } catch (err) {
    log.warn(`[ci-fixer] Could not lift the refused-re-run hold on ${fullName}#${pr.number} — leaving the not-rerunnable note in place so the next sweep retries: ${err}`);
    return false;
  }
  try {
    await gh.updatePR(fullName, pr.number, stripNotRerunnableSection(body));
  } catch (err) {
    // With the hold lifted no later sweep re-enters, so the leftover note is
    // only recoverable by hand: escalate rather than bury it in a warning.
    if (cleared) log.error(`[ci-fixer] Lifted the refused-re-run hold on ${fullName}#${pr.number} but could not strip the not-rerunnable note — it will stay in the PR body until removed manually: ${err}`);
    else log.warn(`[ci-fixer] Could not strip the not-rerunnable note from ${fullName}#${pr.number}: ${err}`);
  }
  if (cleared) log.info(`[ci-fixer] CI is green on ${fullName}#${pr.number} — lifted the stale refused-re-run hold`);
  return cleared;
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
    `PR #${pr.number}: ${await guardContent(pr.title, guardCtx("pr-title"))}`,
    `Branch: ${await guardContent(pr.headRefName, guardCtx("pr-branch"))}`,
    ``,
    `Files changed in this PR:`,
    changedFiles.map((f) => `- ${f}`).join("\n"),
    ``,
    `CI failure log:`,
    "```",
    // CI logs come from Forgejo Actions, not user input — no guard needed.
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
    `- A warning is not a failure. Never classify a failure as unrelated on the strength of a warning`,
    `  (deprecation, missing source map, peer-dep notice) — find the step that actually exited non-zero.`,
    `- When in doubt, classify as related (safe default)`,
    `- The log may be an excerpt with its middle removed (marked "[Claws elided N characters of log]").`,
    `  Absence of a visible failure in an excerpt is NOT evidence the failure is unrelated → classify as related.`,
    ``,
    `- "fingerprint": a short, stable, human-readable identifier for this class of failure`,
    `  Examples: "flakey-test:auth-timeout", "runner:disk-space", "preexisting:lint-config"`,
    `  Use category:detail format. Be consistent — the same issue should get the same fingerprint.`,
    ``,
    `- "reason": brief explanation of why you classified it this way`,
  ].join("\n");

  try {
    const response = await claude.runClaude(prompt, claude.ensureScratchDir("ci-fixer"), { tier: "sonnet", agent: "plan", provider: "claude", admissionBytes: AUXILIARY_AGENT_ADMISSION_BYTES });

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

async function triggerCircuitBreaker(
  fullName: string,
  pr: gh.PR,
  reason: string,
  attempts: { total: number; failed: number; successful: number; pushed: number },
): Promise<void> {
  // Record the head SHA the PR was on when we tripped, so a commit pushed after
  // this point can be recognised as new information (manual intervention) and
  // earn a fresh attempt budget. A null SHA disables future grants for this trip.
  let headSha: string | null = null;
  try {
    headSha = (await gh.getPRHeadSHA(fullName, pr.number)).trim() || null;
  } catch (err) {
    log.warn(`[ci-fixer] Could not read head SHA for ${fullName}#${pr.number}: ${err}`);
  }
  await db.recordCIFixerBreakerTrip(fullName, pr.number, headSha);

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
    const recentErrors = await db.getRecentCIFixerErrors(fullName, pr.number);
    await gh.postProblematicPRComment(fullName, pr.number, reason, attempts.total, recentErrors, attempts.pushed);
    gh.removeQueueItem(fullName, pr.number);
  } catch (err) {
    log.error(`Failed to notify the forge for problematic PR ${fullName}#${pr.number}: ${err}`);
  }
}

/**
 * A commit pushed to a problematic PR after the breaker tripped is new
 * information — usually the manual intervention the problematic comment asks
 * for. Clear the label and grant a fresh (bounded) attempt budget when the head
 * has moved to a commit Claws did not push itself.
 *
 * Returns true when the PR was released back into the normal flow.
 */
async function maybeGrantNewCommitAttempt(fullName: string, pr: gh.PR): Promise<boolean> {
  const state = await db.getCIFixerBreakerState(fullName, pr.number);
  // No recorded trip SHA ⇒ the label was applied by a human (or by a build
  // predating this table). Stay frozen — a human-applied label still means
  // "leave this PR alone".
  if (!state?.trippedSha) return false;
  if (state.grants >= CI_FIXER_MAX_COMMIT_GRANTS()) {
    log.info(`[ci-fixer] ${fullName}#${pr.number} has used all ${CI_FIXER_MAX_COMMIT_GRANTS()} new-commit fix grants — staying problematic`);
    return false;
  }

  let head: string;
  try {
    head = (await gh.getPRHeadSHA(fullName, pr.number)).trim();
  } catch (err) {
    log.warn(`[ci-fixer] getPRHeadSHA failed for ${fullName}#${pr.number}: ${err}`);
    return false;
  }
  // Unchanged head, or a head Claws' own ci-fixer pushed — not new information.
  if (!head || head === state.trippedSha || head === state.lastClawsSha) return false;

  let status: gh.CheckStatus;
  try {
    status = await gh.getPRCheckStatus(fullName, pr.number);
  } catch (err) {
    log.warn(`[ci-fixer] getPRCheckStatus failed for ${fullName}#${pr.number}: ${err}`);
    return false;
  }
  // Checks for the new head are still running, or held for approval and not yet run — re-evaluate next sweep.
  if (status === "pending" || status === "held") return false;
  if (status === "none") {
    // "none" on a just-pushed head means CI has not registered yet, not that the
    // PR recovered — believing it would clear the label and reset the grant count
    // before anything ran (the #2354 race). Wait out the settle window first.
    const { settled, age } = await gh.haveChecksSettled(fullName, head);
    if (!settled) {
      log.info(`[ci-fixer] New head ${head.slice(0, 7)} on problematic ${fullName}#${pr.number} has no checks yet (age ${age}) — waiting for CI to register`);
      return false;
    }
  }

  // Clear the label first and only persist the grant once the forge confirms it is
  // gone. `recordCIFixerBreakerGrant` clears `tripped_sha`, which is this
  // function's own entry condition — committing it against a label that is still
  // on the forge would freeze the PR permanently, with no further grant possible
  // for any future commit (the manual-intervention dependency #2391 removes).
  if (!(await gh.removeLabel(fullName, pr.number, LABELS.problematic))) {
    log.warn(`[ci-fixer] Could not clear ${LABELS.problematic} on ${fullName}#${pr.number} — leaving the breaker tripped so the next sweep retries the grant`);
    return false;
  }
  const recovered = status !== "failing";
  await db.recordCIFixerBreakerGrant(fullName, pr.number, { recovered });
  gh.removeQueueItem(fullName, pr.number);
  log.info(
    recovered
      ? `[ci-fixer] New head ${head.slice(0, 7)} on problematic ${fullName}#${pr.number} is green — cleared ${LABELS.problematic}`
      : `[ci-fixer] New head ${head.slice(0, 7)} on problematic ${fullName}#${pr.number} still failing — granting a fresh fix budget (grant ${state.grants + 1}/${CI_FIXER_MAX_COMMIT_GRANTS()})`,
  );
  return true;
}

/**
 * Why `identifyPRWork` last declined a PR, keyed `repo#pr`, so the dashboard
 * can show a failing-CI PR the fixer is not acting on with the reason rather
 * than dropping it from the queue. Cleared at the start of every call, so a PR
 * that gets a work item (or goes green) carries no stale reason.
 */
const identifySkipReasons = new Map<string, string>();

/** The reason `identifyPRWork` returned null for this PR on its last call, if it recorded one. */
export function getIdentifySkipReason(repo: string, prNumber: number): string | undefined {
  return identifySkipReasons.get(`${repo}#${prNumber}`);
}

/** Drop `repo`'s skip reasons for PRs no longer open, so merged and closed PRs do not accumulate. */
export function pruneIdentifySkipReasons(repo: string, openPRNumbers: ReadonlySet<number>): void {
  const prefix = `${repo}#`;
  for (const key of identifySkipReasons.keys()) {
    if (key.startsWith(prefix) && !openPRNumbers.has(Number(key.slice(prefix.length)))) identifySkipReasons.delete(key);
  }
  gh.pruneCiFixerGaveUp(repo, openPRNumbers);
}

export async function identifyPRWork(repo: Repo, pr: gh.PR): Promise<WorkItem | null> {
  const fullName = repo.fullName;
  const skipKey = `${fullName}#${pr.number}`;
  identifySkipReasons.delete(skipKey);
  gh.setCiFixerGaveUp(fullName, pr.number, null);
  const skip = (reason: string): null => {
    identifySkipReasons.set(skipKey, reason);
    return null;
  };

  // The claws_prs row is the single source of truth for problematic.
  const row = await db.getClawsPr(fullName, pr.number);
  if (isProblematic(row)) {
    const granted = await maybeGrantNewCommitAttempt(fullName, pr);
    if (!granted) {
      log.info(`[ci-fixer] Skipping problematic PR ${fullName}#${pr.number}`);
      return skip("CI fixer: problematic — the fix budget is spent until a new commit lands");
    }
  }

  // Merge conflicts are a different failure mode from CI fixing: a breaker tripped
  // by failed CI-fix attempts must not freeze conflict resolution (#2389). Checked
  // before the CI-fix breaker, and budgeted separately so an unresolvable conflict
  // still can't loop forever.
  //
  // Fetched together with getFailingCheck (independent forge calls, no shared
  // dependency) to keep this loop's wall-clock cost the same as before #2389.
  const [state, failedCheck] = await Promise.all([
    gh.getPRMergeableState(fullName, pr.number),
    gh.getFailingCheck(fullName, pr.number),
  ]);
  if (state === "CONFLICTING") {
    const conflicts = await db.countConflictResolutionAttempts(fullName, pr.number, CI_FIXER_WINDOW_MS(), CONFLICT_PROVIDER_BACKOFF_MS);
    if (conflicts.recentPreWorkFailed > 0) {
      log.info(`[ci-fixer] ${fullName}#${pr.number} is conflicting but the last conflict-resolution attempt failed before the agent ran (provider unavailable) — backing off for up to ${Math.round(CONFLICT_PROVIDER_BACKOFF_MS / 60000)} min`);
      return skip(`CI fixer: the last conflict-resolution attempt failed before the agent ran — backing off for up to ${Math.round(CONFLICT_PROVIDER_BACKOFF_MS / 60000)} min`);
    }
    if (conflicts.unproductive >= CI_FIXER_MAX_CONFLICT_ATTEMPTS()) {
      log.info(`[ci-fixer] ${fullName}#${pr.number} is conflicting but ${conflicts.unproductive} conflict-resolution attempts in the window produced nothing — leaving for manual resolution`);
      await reportConflictBudgetExhausted(repo, pr, conflicts.unproductive);
      return skip(`CI fixer: ${conflicts.unproductive} conflict-resolution attempts produced nothing — leaving for manual resolution`);
    }
    return { kind: "conflict", repo, pr };
  }

  // A PR already carrying a completed, up-to-date review is waiting only on a
  // human to merge or comment; a CI failure here reruns for a reason
  // unrelated to a new commit on this PR (a base-branch change, a scheduled
  // workflow), so dispatching a fresh fix run would spend CI-fixer effort a
  // human hasn't asked for (issue clw_01M3F9340HHVH185YR16PXVKWK).
  if (failedCheck && (await isIdleAwaitingHuman(fullName, pr, row))) {
    log.info(`[ci-fixer] ${fullName}#${pr.number}: CI failed on the reviewed head ${(pr.headRefOid ?? row?.headSha ?? "").slice(0, 7)} while the PR awaits a human merge decision — not dispatching a fix`);
    return skip("CI fixer: CI failed on the reviewed head while the PR awaits a human merge decision — not dispatching a fix");
  }

  // Check circuit breaker before processing. The breaker's job is to stop dispatching
  // more work, so it may only trip while there is work left to dispatch: a failing
  // check (a merge conflict, the other kind of dispatchable work, is handled above and
  // can't reach this point). With no failing check, re-applying `Claws Problematic`
  // just fights the diagnoser, which removes it again as stale on the very next pass
  // (#2390: ~18 add/remove cycles on bstjohn-blog#568).
  //
  // `clearStaleProblematicLabelIfGreen` in problematic-pr-diagnoser.ts is the other
  // half of this rule: it refuses to clear the label while the PR is CONFLICTING, so
  // a conflict-triggered trip sticks instead of flapping.
  //
  // Read the budget floor AFTER a possible grant above — the grant advances it so
  // pre-trip attempts stop counting.
  const budgetFloor = (await db.getCIFixerBreakerState(fullName, pr.number))?.budgetFloorAt ?? null;
  const attempts = await db.countCIFixerAttempts(fullName, pr.number, CI_FIXER_WINDOW_MS(), budgetFloor);
  // Only a run that pushed a commit or gave up with a stated reason is a fix attempt.
  // A run that changed nothing and said nothing — including a re-run-only attempt,
  // bounded separately by CI_FIXER_MAX_RERUN_ONLY_ATTEMPTS (fleet-infra#1699) — does not consume
  // the budget (electronics#12: five 30 s no-op runs tripped the cap).
  const countedAttempts = attempts.pushed + attempts.gaveUp;
  if (failedCheck) {
    if (countedAttempts >= CI_FIXER_MAX_ATTEMPTS()) {
      const windowHours = Math.round(CI_FIXER_WINDOW_MS() / (60 * 60 * 1000));
      const reason = `Exceeded maximum of ${CI_FIXER_MAX_ATTEMPTS()} agent-reached fix attempts in ${windowHours}h window`;
      await triggerCircuitBreaker(fullName, pr, reason, { ...attempts, total: countedAttempts });
      return skip(`CI fixer: ${reason}`);
    }

    // Check consecutive failures — exclude failures that never reached the agent (provider
    // rate/usage limits, transient forge errors, expired agent credentials, shutdown) —
    // they say nothing about the diff. Keyed on pushes, not completed rows: a completed
    // no-op run is not progress and is not capped by maxAttempts, so it must not
    // switch this guard off.
    const nonTransientFailed = attempts.failed - attempts.preWorkFailed - attempts.rerunOnly;
    if (nonTransientFailed >= CI_FIXER_MAX_CONSECUTIVE_FAILURES() && attempts.pushed === 0) {
      const reason = `${nonTransientFailed} consecutive failures without any pushed fixes`;
      await triggerCircuitBreaker(fullName, pr, reason, attempts);
      return skip(`CI fixer: ${reason}`);
    }
  } else if (countedAttempts >= CI_FIXER_MAX_ATTEMPTS()) {
    log.info(`[ci-fixer] ${fullName}#${pr.number} has ${countedAttempts} fix attempts in window but no failing check and no conflict — not tripping the breaker`);
  }

  if (!failedCheck) return null;

  const runId = failedCheck.link?.match(/\/actions\/runs\/(\d+)/)?.[1];

  // A job that recorded zero steps never ran user code — the runner went away
  // mid-job — and a job whose only failures are the runner's own setup/checkout steps
  // (e.g. a codeload 429 while downloading actions/checkout) is the same shape:
  // neither ran the PR's diff. Retry rather than treating it as a defect in the
  // PR. Deliberately does NOT increment the counter: identifyPRWork runs every
  // sweep, so counting here would exhaust the budget without ever issuing a rerun.
  if (runId && !deadRerunIds.has(rerunKey(fullName, runId)) && !isInfraRerunExhausted(fullName, runId)) {
    const jobs = await gh.getRunJobSummaries(fullName, runId);
    if (gh.isInfrastructureOutage(jobs) || gh.isPreRepoStepFailure(jobs)) {
      log.info(`[ci-fixer] Run ${runId} for ${fullName}#${pr.number} failed before any repo step ran — runner/infra outage, retrying rather than fixing`);
      return { kind: "rerun", repo, pr, runId, infra: true };
    }
  }

  if (CANCELLED_STATES.has(failedCheck.state)) {
    if (runId && deadRerunIds.has(rerunKey(fullName, runId))) return skip("CI fixer: the failed run cannot be re-run");
    if (runId) return { kind: "rerun", repo, pr, runId };
    log.warn(`[ci-fixer] Cancelled check for ${fullName}#${pr.number} has no re-runnable link`);
    return skip("CI fixer: the cancelled check has no re-runnable link");
  }

  // Runs that push nothing aren't capped by maxAttempts unless they give a reason, so
  // bound them per head instead: after a give-up, or CI_FIXER_MAX_IDLE_RUNS_PER_HEAD
  // silent no-op runs, re-dispatching on the same head would only repeat the result.
  // A new commit resets this. No label: nothing here is evidence the PR is stuck.
  // Fails open if the head or the counts can't be read.
  try {
    const head = (pr.headRefOid ?? (await gh.getPRHeadSHA(fullName, pr.number))).trim();
    if (head) {
      const idle = await db.countCIFixerIdleRunsOnHead(fullName, pr.number, head, CI_FIXER_WINDOW_MS(), budgetFloor);
      if (idle.gaveUp > 0 || idle.noop >= CI_FIXER_MAX_IDLE_RUNS_PER_HEAD) {
        log.info(`[ci-fixer] ${fullName}#${pr.number}: ${idle.gaveUp > 0 ? "the agent gave up" : `${idle.noop} runs pushed nothing`} on head ${head.slice(0, 7)} — not dispatching again until the head changes`);
        gh.setCiFixerGaveUp(fullName, pr.number, head);
        return skip(`CI fixer: ${idle.gaveUp > 0 ? "the agent gave up" : `${idle.noop} runs pushed nothing`} on head ${head.slice(0, 7)} — not dispatching again until the head changes`);
      }
    }
  } catch (err) {
    log.warn(`[ci-fixer] Could not check idle runs on the head of ${fullName}#${pr.number}: ${err} — dispatching anyway`);
  }

  // A failure whose fix may need another check's output (electronics#12: a sync check
  // needing the fab bundle a still-running job produces) can't be fixed yet, and the
  // fixing push may re-run it anyway. Wait for running checks to finish; returning null
  // writes no task row, so the wait consumes no attempts. `held` checks are not waited
  // on — they never finish on their own. Fails open if the checks can't be read.
  try {
    const pending = (await gh.listPRChecks(fullName, pr.number)).filter((c) => c.outcome === "pending");
    if (pending.length > 0) {
      log.info(`[ci-fixer] ${fullName}#${pr.number}: check "${failedCheck.name}" failed but ${pending.map((c) => `"${c.name}"`).join(", ")} ${pending.length === 1 ? "is" : "are"} still running — waiting for ${pending.length === 1 ? "it" : "them"} before attempting a fix`);
      return skip(`CI fixer: waiting for ${pending.map((c) => `"${c.name}"`).join(", ")} to finish before attempting a fix`);
    }
  } catch (err) {
    log.warn(`[ci-fixer] listPRChecks failed for ${fullName}#${pr.number}: ${err} — not waiting on running checks`);
  }

  log.info(`[ci-fixer] CI failure detected for ${fullName}#${pr.number}`);
  return { kind: "fix", repo, pr, failedCheck };
}

/** Classify and dispatch a CI fix, called from the CI_FIXER work handler. */
export async function runCIFix(repo: Repo, pr: gh.PR, failedCheck: gh.FailedCheck): Promise<void> {
  const fullName = repo.fullName;

  const failLog = await gh.getFailedRunLog(fullName, pr.number);
  if (!failLog) {
    // The log comes from the job-log API patch; an empty one means that API is
    // unavailable or the run has no failed job, not an expired run. Fix from the
    // failing check's name and link instead (#2650).
    log.info(`[ci-fixer] No readable run log for ${fullName}#${pr.number} — fixing from the failing check "${failedCheck.name}"`);
    await fixCI(repo, pr, "", failedCheck);
    return;
  }

  if (isCIUnrelatedFixPR(pr)) {
    log.info(`[ci-fixer] ${fullName}#${pr.number} is a ci-unrelated fix PR — skipping classification, treating as related`);
    await fixCI(repo, pr, failLog, failedCheck);
    return;
  }

  const changedFiles = await gh.getPRChangedFiles(fullName, pr.number);
  const classification = await classifyCIFailure(repo, pr, failLog, changedFiles);

  if (classification.related) {
    await fixCI(repo, pr, failLog, failedCheck);
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

  // "Unrelated" means the classifier decided this failure is not the PR's
  // fault — flaky test, runner issue, pre-existing breakage. For all three the
  // correct response is the same: requeue the run once. That also covers the
  // motivating case (#2278): the NixOS runner `ryzen` matches
  // `[self-hosted, linux]` but cannot build claws' native modules, and a
  // re-run can land the job on a healthy runner. Deliberately NOT gated on a
  // log-content regex — the failure text is whatever the runner or the
  // workflow happens to print, and a pattern list keyed to it silently rots.
  const runId = failedCheck.link?.match(/\/actions\/runs\/(\d+)/)?.[1];
  if (runId && !autoRerunIds.has(rerunKey(fullName, runId)) && !deadRerunIds.has(rerunKey(fullName, runId))) {
    autoRerunIds.add(rerunKey(fullName, runId));
    log.info(`[ci-fixer] Unrelated failure on ${fullName}#${pr.number} (run ${runId}) — re-running once`);
    try {
      await gh.rerunWorkflow(fullName, runId);
    } catch (err) {
      if (err instanceof Error && /already running/i.test(err.message)) {
        log.info(`[ci-fixer] workflow ${runId} for ${fullName}#${pr.number} already running`);
      } else if (err instanceof ForgejoRerunEndpointUnavailableError || err instanceof ForgejoActionNotFoundError) {
        await reportRunNotRerunnable(repo, pr, runId);
      } else {
        log.warn(`[ci-fixer] Auto-rerun of ${runId} for ${fullName}#${pr.number} failed: ${err}`);
      }
    }
  }

  await revertPreviousUnrelatedFixes(repo, pr, changedFiles);
  await mergeBaseIfBehind(repo, pr);
}

/**
 * Run the fixing agent on a PR's branch. `failLog` is empty only when no Forgejo run
 * log could be read, in which case the prompt points the agent at `failedCheck` by
 * name and run link. `failedCheck` also lets a runner/infra give-up re-run the run.
 */
export async function fixCI(repo: Repo, pr: gh.PR, failLog: string, failedCheck?: gh.FailedCheck): Promise<void> {
  const fullName = repo.fullName;
  // 60s-cached, so effectively free. Used to spot a mutually-blocking sibling PR.
  // Fork PRs are excluded: their branches don't exist under `origin` in this clone, so the
  // cherry-pick guidance below is unactionable for them, and fork PRs are skipped elsewhere
  // in the pipeline as a security guard.
  const others = (await gh.listPRs(fullName).catch(() => [])).filter((p) => p.number !== pr.number && !gh.isForkPR(p));
  await db.withTaskRecording("ci-fixer", fullName, pr.number, null, async (taskId) => {
    const result = await claude.withExistingWorktree(
      repo, pr.headRefName, "ci-fixer",
      async (wtPath) => {
        await db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

        const guardCtx = makeGuardCtx(fullName, pr.number);
        // Titles below come from *other* PRs, so an injection alert must not be attributed
        // to this PR — sentinel item 0, same convention as idea-suggester/improvement-identifier.
        const othersGuardCtx = makeGuardCtx(fullName, 0);
        const prompt = [
          `You are fixing a CI failure on a pull request in the repository ${fullName}.`,
          `PR #${pr.number}: ${await guardContent(pr.title, guardCtx("pr-title"))}`,
          `Branch: ${await guardContent(pr.headRefName, guardCtx("pr-branch"))}`,
          ``,
          ...(failLog ? [
            `The CI checks have failed. Here are the relevant failure logs:`,
            ``,
            "```",
            await guardContent(failLog, guardCtx("ci-log")),
            "```",
          ] : [
            `The CI check \`${await guardContent(failedCheck?.name ?? "unknown", guardCtx("check-name"))}\` has failed. No run log could be read for this check, so there is no failure output to read here.`,
            ...(failedCheck?.link ? [`The run is at ${await guardContent(failedCheck.link, guardCtx("check-link"))}.`] : []),
            `Work out what that check runs (read the workflow definition under \`.forgejo/workflows/\` or \`.github/workflows/\`), reproduce it locally in this worktree, and fix whatever it reports.`,
          ]),
          ``,
          `Please analyze the failure and make the necessary code changes to fix it.`,
          `Make commits with clear messages as you work.`,
          `Do NOT push the branch, open a pull request or change any PR's base branch. Claws pushes your commits after you finish.`,
          `If the failure cannot be fixed from this branch right now (for example it needs an artifact another CI job has not produced yet, or a change in another repository), make no commits and end your final message with exactly one line: CI-FIX-GIVE-UP: <one sentence saying why>.`,
          `If the failure was caused by the runner or infrastructure rather than by this branch (the job died mid-step with no error, the log ends abruptly after an image pull, the docker daemon or dind sidecar went away, a network blip, or \`Complete job\` or an \`always()\` cleanup step failing with no output), make no commits and give up with a reason that states "runner or infrastructure flakiness"; Claws then re-runs the failed jobs itself.`,
          ``,
          ...(others.length > 0 ? [
            `Other open PRs on this repository:`,
            await formatGuardedTitleList(others.map((p) => `#${p.number} ${p.title} (branch ${p.headRefName})`), othersGuardCtx, "pr-title"),
            ``,
            `Before writing a fix, consider whether one of those PRs already contains it. Two PRs can be mutually blocking — each fixes half of a shared failure and neither can go green alone. If another open PR's branch already carries the fix for this failure, cherry-pick or merge that commit into this branch (\`git fetch origin <branch>\` then \`git cherry-pick <sha>\`) instead of writing a second, parallel fix.`,
            ``,
          ] : []),
          CI_FIXER_FAST_CHECKS_GUIDANCE,
          RUNNER_POLICY_CONTEXT,
          HOST_EXECUTION_POLICY,
          NO_STACKED_PRS_POLICY,
          forgeContext(repo),
          ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
        ].join("\n");

        const mcpConfigPath = claude.writeAgentMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName), taskId });
        const agentDoc = loadRepoAgentDoc(wtPath, fullName, "issue-implementer");
        const timeoutMs = getItemTimeoutMs(fullName, pr.number);
        const classifiedTier = await classifyComplexity(
          [
            `CI failure on PR #${pr.number} in ${fullName}.`,
            `PR title: ${pr.title}`,
            ``,
            ...(failLog
              ? [`Failure log (excerpt):`, excerptLog(failLog, 2000)]
              : [`Failing check: ${failedCheck?.name ?? "unknown"} (no run log could be read for this check).`]),
          ].join("\n"),
          wtPath,
        );
        const { provider, strictProvider, eligibleProviders, overrideIgnoredReason, tier, model } = await resolveModelPlanCell(fullName, gh.getLinkedIssueNumber(pr), "ci-fix", {
          tier: classifiedTier,
          labels: pr.labels,
          requiresMcp: homeAssistantMcpAvailable(fullName),
        });
        if (overrideIgnoredReason) log.warn(`[ci-fixer] ${fullName}#${pr.number}: ${overrideIgnoredReason}`);
        const providerNote = overrideIgnoredReason ? `; ${overrideIgnoredReason}` : "";
        let tierNote = "";
        log.info(`[ci-fixer] Using model "${model}" for CI fix on ${fullName}#${pr.number}`);
        let actualProvider: Provider = provider;
        let actualAccount: string | undefined;
        let actualModel = model;
        const startSha = (await claude.getHeadSha(wtPath)).trim();
        let agentOutput = "";
        try {
          agentOutput = await claude.runClaude(prompt, wtPath, { mcpConfig: mcpConfigPath, timeoutMs, tier, model, provider, strictProvider, eligibleProviders, appendSystemPrompt: agentDoc, onProviderUsed: (p, a) => { actualProvider = p; actualAccount = a; }, onAttemptModelUsed: (_p, m) => { actualModel = m ?? "default"; }, onTierFallback: (from) => { tierNote = claude.tierFallbackNote(from); }, onTokensUsed: db.trackTaskTokens(taskId), agent: "build", captureLabel: "ci-fixer", forgejoAccessRepo: repo.fullName });
        } finally {
          await persistProviderModel(taskId, actualProvider, actualModel, actualAccount);
        }

        let outcome: TaskOutcome = { commits: 0 };

        if ((await claude.getHeadSha(wtPath)).trim() !== startSha) { // HEAD movement: an agent-issued push would hide commits from hasNewCommits
          outcome = await pushAndUpdatePR(wtPath, repo, pr, actualModel, actualProvider, "CI fixed with", "Pushed fix", providerNote + tierNote);
          await supersedeGiveUpComment(fullName, pr, outcome.headSha);
        } else {
          // headSha scopes countCIFixerIdleRunsOnHead's per-head bound. No prNumber: with
          // one, findLatestCompletedTaskForPrHead would take this run as the head's producer.
          const giveUpReason = parseGiveUpReason(agentOutput);
          if (giveUpReason) {
            log.info(`[ci-fixer] Agent gave up on ${fullName}#${pr.number}: ${giveUpReason}`);
            const rerunId = await rerunAfterInfraGiveUp(repo, pr, giveUpReason, failedCheck);
            if (rerunId) {
              // Recorded as a rerun-only failure: not a fix attempt, not an idle run on
              // the head, bounded by CI_FIXER_MAX_RERUN_ONLY_ATTEMPTS.
              await postGiveUpComment(fullName, pr, giveUpReason, rerunId);
              await db.recordTaskFailed(taskId, `CI fixer gave up with a runner/infra reason; re-ran the failed jobs of run ${rerunId}`, { failureCategory: "rerun-only", headSha: startSha });
              return;
            }
            outcome = { commits: 0, headSha: startSha, giveUpReason };
            await postGiveUpComment(fullName, pr, giveUpReason);
          } else {
            log.warn(`[ci-fixer] No commits produced for ${fullName}#${pr.number}`);
            outcome = { commits: 0, headSha: startSha };
          }
        }

        await db.recordTaskComplete(taskId, outcome);
      },
    );

    if (result === null) {
      log.info(`[ci-fixer] Branch ${pr.headRefName} no longer exists for PR #${pr.number} in ${fullName} — skipping (likely merged/closed)`);
      await db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "skipped" });
    }
  });
}

/** Stable dedup key for one unrelated-CI occurrence: the failing run ID when the run URL
 * carries one, else a PR+fingerprint fallback so a link-less occurrence still dedups. */
export function unrelatedOccurrenceKey(
  repoName: string,
  occ: { pr: gh.PR; fingerprint: string; runUrl: string },
): string {
  const runId = occ.runUrl.match(/\/actions\/runs\/(\d+)/)?.[1];
  return runId ? `${repoName}:run-${runId}` : `${repoName}:pr${occ.pr.number}:${occ.fingerprint}`;
}

// Occurrence keys already commented on the [ci-unrelated] tracker issue. Without this a
// still-failing run gets a fresh comment every ~5-min sweep until it leaves the window
// (bin-scraper#250: 5 comments for one run in 16 minutes). In-memory by design, same
// trade-off as deadRerunIds: a restart costs at most one extra comment per run.
const reportedUnrelatedOccurrences = new Set<string>();

export function _resetReportedUnrelatedOccurrencesForTests(): void {
  reportedUnrelatedOccurrences.clear();
}

/** Title of the per-repo tracker issue for CI failures unrelated to PR changes. */
export const CI_UNRELATED_TITLE = "[ci-unrelated] CI failures unrelated to PR changes";

export async function fileUnrelatedIssue(
  repoName: string,
  occurrences: Array<{ fingerprint: string; reason: string; failLog: string; pr: gh.PR; runUrl: string }>,
): Promise<void> {
  const title = CI_UNRELATED_TITLE;

  try {
    const pending = occurrences.filter((occ) => {
      if (!reportedUnrelatedOccurrences.has(unrelatedOccurrenceKey(repoName, occ))) return true;
      log.info(`[ci-fixer] Occurrence ${unrelatedOccurrenceKey(repoName, occ)} already logged on the [ci-unrelated] issue — skipping duplicate comment`);
      return false;
    });
    if (pending.length === 0) return;

    const existing = await resolveAlertIssue({ repo: repoName, title, logPrefix: "ci-fixer" });

    let issueNumber: IssueRef;
    if (existing) {
      issueNumber = existing.number;
    } else {
      const body = [
        `**Auto-created by Claws ci-fixer**`,
        "",
        `This issue tracks CI failures that are unrelated to the PRs they occurred on (flakey tests, runner issues, pre-existing failures).`,
        `Each occurrence is logged below.`,
      ].join("\n");
      // Filed approved through Plan: the planner's plan runs without stopping for
      // review, as an unattended fix of an unrelated CI failure should.
      issueNumber = await gh.createIssue(repoName, title, body, [], { approveThrough: "plan", approvedBy: "ci-fixer", alertKind: "ci-fixer" });
      log.info(`[ci-fixer] Created issue #${issueNumber} for unrelated CI failures`);
    }

    for (const occ of pending) {
      const guardCtx = makeGuardCtx(repoName, occ.pr.number);
      const abbreviatedLog = await guardContent(excerptLog(occ.failLog, 2000), guardCtx("ci-log"));
      const comment = [
        `### ${occ.fingerprint} — ${new Date().toISOString()}`,
        "",
        `**Observed on:** PR #${occ.pr.number} (${await guardContent(occ.pr.title, guardCtx("pr-title"))})`,
        `**Reason:** ${occ.reason}`,
        `**Failing run:** ${occ.runUrl}`,
        "",
        "```",
        abbreviatedLog,
        "```",
      ].join("\n");
      await gh.commentOnIssue(repoName, issueNumber, comment, { agentName: "CI Fixer" });
      reportedUnrelatedOccurrences.add(unrelatedOccurrenceKey(repoName, occ));
      log.info(`[ci-fixer] Updated issue #${issueNumber} for "${occ.fingerprint}"`);
    }
  } catch (err) {
    log.warn(`[ci-fixer] Failed to file unrelated issue: ${err}`);
    reportError("ci-fixer:file-unrelated-issue", repoName, err, { repo: repoName });
  }
}

export async function revertPreviousUnrelatedFixes(
  repo: Repo,
  pr: gh.PR,
  changedFiles: string[],
): Promise<void> {
  const fullName = repo.fullName;

  // Skip if Claws has never run ci-fixer on this PR
  if (!await db.hasPreviousCiFixerTasks(fullName, pr.number)) {
    return;
  }

  await db.withTaskRecording("ci-fixer:revert", fullName, pr.number, null, async (taskId) => {
    const result = await claude.withExistingWorktree(
      repo, pr.headRefName, "ci-fixer-revert",
      async (wtPath) => {
        await db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

        const gitLog = await claude.git(
          ["log", "--oneline", `origin/${pr.baseRefName}..HEAD`],
          wtPath,
        );

        const guardCtx = makeGuardCtx(fullName, pr.number);
        const prompt = [
          `You are examining commits on a pull request branch to identify and revert automated CI fix attempts that were for issues UNRELATED to the PR's purpose.`,
          ``,
          `PR #${pr.number}: ${await guardContent(pr.title, guardCtx("pr-title"))}`,
          `Branch: ${await guardContent(pr.headRefName, guardCtx("pr-branch"))}`,
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

        const mcpConfigPath = claude.writeAgentMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName), taskId });
        const agentDoc = loadRepoAgentDoc(wtPath, fullName, "issue-implementer");
        const timeoutMs = getItemTimeoutMs(fullName, pr.number);
        const classifiedTier = await classifyComplexity(
          [
            `Reviewing commits on PR #${pr.number} in ${fullName} to identify and revert unrelated automated CI fixes.`,
            `PR title: ${pr.title}`,
          ].join("\n"),
          wtPath,
        );
        const { provider, strictProvider, eligibleProviders, overrideIgnoredReason, tier, model } = await resolveModelPlanCell(fullName, gh.getLinkedIssueNumber(pr), "ci-fix", {
          tier: classifiedTier,
          labels: pr.labels,
          requiresMcp: homeAssistantMcpAvailable(fullName),
        });
        if (overrideIgnoredReason) log.warn(`[ci-fixer] ${fullName}#${pr.number}: ${overrideIgnoredReason}`);
        const providerNote = overrideIgnoredReason ? `; ${overrideIgnoredReason}` : "";
        let tierNote = "";
        log.info(`[ci-fixer] Using model "${model}" for unrelated-fix revert on ${fullName}#${pr.number}`);
        let actualProvider: Provider = provider;
        let actualAccount: string | undefined;
        let actualModel = model;
        const startSha = (await claude.getHeadSha(wtPath)).trim();
        try {
          await claude.runClaude(prompt, wtPath, { mcpConfig: mcpConfigPath, timeoutMs, tier, model, provider, strictProvider, eligibleProviders, appendSystemPrompt: agentDoc, onProviderUsed: (p, a) => { actualProvider = p; actualAccount = a; }, onAttemptModelUsed: (_p, m) => { actualModel = m ?? "default"; }, onTierFallback: (from) => { tierNote = claude.tierFallbackNote(from); }, onTokensUsed: db.trackTaskTokens(taskId), agent: "build", captureLabel: "ci-fixer", forgejoAccessRepo: repo.fullName });
        } finally {
          await persistProviderModel(taskId, actualProvider, actualModel, actualAccount);
        }

        let outcome: TaskOutcome = { commits: 0 };

        if ((await claude.getHeadSha(wtPath)).trim() !== startSha) { // HEAD movement: an agent-issued push would hide commits from hasNewCommits
          await pushPRBranch(wtPath, repo, pr);
          await regenerateAndUpdatePRBody(wtPath, fullName, pr, actualModel, actualProvider, "Unrelated CI fix reverted with", "[ci-fixer]", providerNote + tierNote);
          log.info(`[ci-fixer] Reverted unrelated fixes for ${fullName}#${pr.number}`);
          outcome = await buildSuccessOutcome(wtPath, pr.baseRefName, pr.number, "updated");
        }

        await db.recordTaskComplete(taskId, outcome);
      },
    );

    if (result === null) {
      log.info(`[ci-fixer] Branch ${pr.headRefName} no longer exists for PR #${pr.number} in ${fullName} — skipping revert (likely merged/closed)`);
      await db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "skipped" });
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
        await db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

        const behindCount = (await claude.git(
          ["rev-list", "--count", `HEAD..origin/${pr.baseRefName}`],
          wtPath,
        )).trim();

        if (behindCount === "0") {
          log.info(`[ci-fixer] Branch for ${fullName}#${pr.number} is already up-to-date with ${pr.baseRefName}`);
          await db.recordTaskComplete(taskId, { commits: 0 });
          return;
        }

        log.info(`[ci-fixer] Branch for ${fullName}#${pr.number} is ${behindCount} commits behind ${pr.baseRefName}, merging`);

        const { clean } = await claude.attemptMerge(wtPath, pr.baseRefName);

        if (clean) {
          await pushPRBranch(wtPath, repo, pr);
          log.info(`[ci-fixer] Merged ${pr.baseRefName} into ${pr.headRefName} for ${fullName}#${pr.number}`);
          const diffStats = await claude.getDiffStats(wtPath, pr.baseRefName).catch(() => undefined);
          const headSha = await claude.getHeadSha(wtPath).catch(() => undefined);
          await db.recordTaskComplete(taskId, { commits: 1, ...diffStats, prNumber: pr.number, prAction: "updated", headSha });
        } else {
          await claude.abortMerge(wtPath);
          log.info(`[ci-fixer] Merge of ${pr.baseRefName} into ${pr.headRefName} has conflicts for ${fullName}#${pr.number}, skipping`);
          await db.recordTaskComplete(taskId, { commits: 0 });
        }
      },
    );

    if (result === null) {
      log.info(`[ci-fixer] Branch ${pr.headRefName} no longer exists for PR #${pr.number} in ${fullName} — skipping merge-base (likely merged/closed)`);
      await db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "skipped" });
    }
  }).catch((err) => {
    log.warn(`[ci-fixer] Merge-base failed for ${fullName}#${pr.number}: ${err}`);
  });
}

export function isCIUnrelatedFixPR(pr: gh.PR): boolean {
  return pr.title.includes("[ci-unrelated]");
}
