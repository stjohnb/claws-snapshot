import { type Repo, LABELS, HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import type { TaskOutcome } from "../db.js";
import { buildSuccessOutcome } from "../outcome.js";
import { reportError } from "../error-reporter.js";
import { getItemTimeoutMs } from "../timeout-handler.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { CI_FIXER_FAST_CHECKS_GUIDANCE, RUNNER_POLICY_CONTEXT, HOST_EXECUTION_POLICY, homeAssistantContext, gitHubIncidentContext } from "./agent-context.js";
import { isHomeAssistantConfigRepo } from "../home-assistant.js";
import { getModel } from "../model-selector.js";
import { classifyComplexity } from "../classify-complexity.js";
import { isCIUnrelatedFixPR } from "./ci-fixer.js";
import { sleep } from "../util.js";

export const DIAGNOSIS_COMMENT_MARKER = "problematic-pr-diagnosis-report";

export const MAX_ROUNDS = 3;

let ciWatchBudgetMs = 30 * 60 * 1000;
let ciPollIntervalMs = 60 * 1000;

/** @internal — tests only. */
export function _setTimingsForTests(budgetMs: number, pollIntervalMs: number): void {
  ciWatchBudgetMs = budgetMs;
  ciPollIntervalMs = pollIntervalMs;
}

type WatchResult =
  | { state: "passing" }
  | { state: "failing"; failedCheck: gh.FailedCheck }
  | { state: "timeout" }
  | { state: "superseded" };

type Outcome =
  | { kind: "success"; roundsRun: number }
  | { kind: "no-fix-possible"; roundsRun: number; reason: string }
  | { kind: "max-rounds-exhausted"; roundsRun: number }
  | { kind: "budget-exhausted"; roundsRun: number }
  | { kind: "skipped"; reason: string };

export async function runDiagnosis(repo: Repo, pr: gh.PR): Promise<void> {
  const fullName = repo.fullName;

  if (gh.isForkPR(pr)) {
    log.info(`[problematic-diagnoser] Skipping fork PR ${fullName}#${pr.number}`);
    return;
  }

  if (isCIUnrelatedFixPR(pr)) {
    log.info(`[problematic-diagnoser] Skipping ci-unrelated fix PR ${fullName}#${pr.number}`);
    return;
  }

  // Dedup guard — once we've posted a final report for this label-application,
  // don't replay the diagnosis. But CI may have recovered since (flaky check
  // passed on retry, transient infra cleared, or a manual/external fix landed)
  // while the stale problematic label lingers. Before short-circuiting, clear
  // the label if the PR is now green — otherwise a recovered PR stays labelled
  // problematic forever, since the marker blocks every future diagnosis pass.
  try {
    const comments = await gh.getIssueComments(fullName, pr.number);
    if (comments.some((c) => c.body.includes(DIAGNOSIS_COMMENT_MARKER))) {
      await clearStaleProblematicLabelIfGreen(fullName, pr.number);
      log.info(`[problematic-diagnoser] Skipping ${fullName}#${pr.number} — already diagnosed`);
      return;
    }
  } catch (err) {
    log.warn(`[problematic-diagnoser] Failed to check comments for ${fullName}#${pr.number}: ${err}`);
  }

  log.info(`[problematic-diagnoser] Starting diagnosis for ${fullName}#${pr.number}`);

  let currentPR = pr;
  let outcome: Outcome | null = null;
  let roundsRun = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const refreshed = await refetchPR(fullName, currentPR.number);
    if (!refreshed) {
      log.info(`[problematic-diagnoser] PR ${fullName}#${currentPR.number} no longer open — stopping`);
      outcome = { kind: "skipped", reason: "PR closed or merged mid-diagnosis" };
      break;
    }
    currentPR = refreshed;
    if (!currentPR.labels.some((l) => l.name === LABELS.problematic)) {
      log.info(`[problematic-diagnoser] Problematic label removed from ${fullName}#${currentPR.number} — stopping`);
      outcome = { kind: "skipped", reason: "Problematic label removed during diagnosis" };
      break;
    }

    const failLog = await gh.getFailedRunLog(fullName, currentPR.number);
    if (!failLog) {
      // The problematic label is applied after failed CI-fix attempts, but CI may
      // have recovered before this diagnosis pass runs (flaky check passed on retry,
      // transient infra failure cleared, or a manual fix landed). Verify the PR is
      // genuinely still failing before reporting "no fix attempted" — otherwise we
      // leave a stale problematic label and a misleading report on a green PR.
      const failing = await gh.getFailingCheck(fullName, currentPR.number);
      let conflicting = false;
      if (!failing) {
        const status = await gh.getPRCheckStatus(fullName, currentPR.number);
        if (status === "passing" || status === "none") {
          // Green CI on its own is not recovery. The breaker also trips on a PR whose
          // merge conflicts the resolver can't clear, and calling that a success would
          // drop the label the breaker just applied, handing the PR back to the resolver
          // for another futile round (see hasBlockingConflict).
          conflicting = await hasBlockingConflict(fullName, currentPR.number);
          if (!conflicting) {
            log.info(`[problematic-diagnoser] No failing checks for ${fullName}#${currentPR.number} — CI is green, clearing stale problematic label`);
            outcome = { kind: "success", roundsRun };
            break;
          }
        }
      }
      if (round === 1) {
        const reason = conflicting
          ? "CI is green but the PR has merge conflicts the conflict resolver could not clear — needs a manual rebase"
          : "No CI failure log available to diagnose";
        log.info(`[problematic-diagnoser] No failure log for ${fullName}#${currentPR.number} on round 1 — ${reason}`);
        outcome = { kind: "no-fix-possible", roundsRun, reason };
        break;
      }
      // After our first push, an empty log with no failing check means CI cleanly succeeded.
      if (!failing) {
        outcome = { kind: "success", roundsRun };
        break;
      }
      // Fall through with an empty log — Claude will still see the round context.
    }

    roundsRun = round;
    const recentErrors = db.getRecentCIFixerErrors(fullName, currentPR.number);
    const roundResult = await runDiagnosisRound(repo, currentPR, round, failLog, recentErrors);

    if (roundResult.action === "no-commits") {
      log.info(`[problematic-diagnoser] No commits produced on round ${round} for ${fullName}#${currentPR.number}`);
      outcome = { kind: "no-fix-possible", roundsRun, reason: `Claude produced no commits on round ${round}` };
      break;
    }

    // Commits were pushed — watch CI
    const watch = await waitForCheck(fullName, currentPR, roundResult.headSha, ciWatchBudgetMs);
    if (watch.state === "passing") {
      outcome = { kind: "success", roundsRun };
      break;
    }
    if (watch.state === "superseded") {
      log.info(`[problematic-diagnoser] PR ${fullName}#${currentPR.number} superseded by external push — stopping`);
      outcome = { kind: "skipped", reason: "PR received external commits during CI watch" };
      break;
    }
    if (watch.state === "timeout") {
      log.info(`[problematic-diagnoser] CI watch budget exhausted on round ${round} for ${fullName}#${currentPR.number}`);
      outcome = { kind: "budget-exhausted", roundsRun };
      break;
    }
    // failing — continue to next round
    log.info(`[problematic-diagnoser] CI still failing after round ${round} (check: ${watch.failedCheck.name}) for ${fullName}#${currentPR.number}, continuing`);
  }

  if (!outcome) {
    outcome = { kind: "max-rounds-exhausted", roundsRun };
  }

  // Don't post a noisy report when we never actually ran a round.
  // The user removing the label or closing the PR mid-flight is not something
  // they need to be notified about.
  if (outcome.kind !== "skipped") {
    await postFinalReport(repo, currentPR, outcome);
  }

  if (outcome.kind === "success") {
    // Only advance the breaker's budget floor once the label is confirmed
    // gone — resetting it against a label GitHub still shows would leave the
    // PR frozen with a clean-looking breaker state.
    if (await gh.removeLabel(fullName, currentPR.number, LABELS.problematic)) {
      db.resetCIFixerBreakerGrants(fullName, currentPR.number);
      log.info(`[problematic-diagnoser] Removed ${LABELS.problematic} label from ${fullName}#${currentPR.number}`);
    } else {
      log.warn(`[problematic-diagnoser] Could not remove ${LABELS.problematic} from ${fullName}#${currentPR.number} — leaving the breaker state untouched for the next sweep`);
    }
  }
}

interface RoundResult {
  action: "pushed" | "no-commits";
  headSha: string;
}

async function runDiagnosisRound(
  repo: Repo,
  pr: gh.PR,
  round: number,
  failLog: string,
  recentErrors: Array<{ error: string; timestamp: string }>,
): Promise<RoundResult> {
  const fullName = repo.fullName;
  let result: RoundResult = { action: "no-commits", headSha: "" };

  await db.withTaskRecording("ci-fixer:problematic", fullName, pr.number, null, async (taskId) => {
    const wtResult = await claude.withExistingWorktree(
      repo, pr.headRefName, "ci-fixer-problematic",
      async (wtPath) => {
        db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

        const guardCtx = makeGuardCtx(fullName, pr.number);
        const errorsBlock = recentErrors.length > 0
          ? recentErrors.map((e) => `- (${e.timestamp}) ${e.error.slice(0, 500)}${e.error.length > 500 ? "…" : ""}`).join("\n")
          : "(none recorded)";
        const incidentCtx = gitHubIncidentContext(guardCtx);

        const prompt = [
          `You are running a deeper-diagnosis pass on a pull request in ${fullName} that has tripped the CI fixer circuit breaker.`,
          `PR #${pr.number}: ${guardContent(pr.title, guardCtx("pr-title"))}`,
          `Branch: ${guardContent(pr.headRefName, guardCtx("pr-branch"))} (base: ${pr.baseRefName})`,
          ``,
          `This is **diagnosis round ${round} of ${MAX_ROUNDS}**. Earlier automated CI fix attempts have not resolved the failures.`,
          ``,
          `**Take a more thorough approach than a normal CI fix:**`,
          `- Read OVERVIEW.md or other top-level docs if they help.`,
          `- Inspect the failing tests and the production code they cover.`,
          `- Consider whether earlier ci-fixer commits made the situation worse and should be reverted (\`git log\`, \`git revert <sha>\`).`,
          `- Consider whether the PR branch needs a fresh merge from origin/${pr.baseRefName}.`,
          `- Don't just paper over a symptom — find a root cause if you can.`,
          ``,
          `Then make commits that fix CI. Use clear commit messages.`,
          ``,
          `Latest failing-check log (may be stale or empty — see fetch-fresh instructions below):`,
          "```",
          failLog || "(empty — no failed-job log was available when this prompt was built)",
          "```",
          ``,
          `**Fetch fresh CI logs yourself before diagnosing.** The log block above was captured`,
          `when this round started and may be empty, truncated, or out-of-date. Run:`,
          `  \`gh pr checks ${pr.number} --repo ${fullName} --json name,state,link\``,
          `to find the failing check's run URL, extract the run ID (the number after`,
          `\`/actions/runs/\`), then run:`,
          `  \`gh run view <run-id> --repo ${fullName} --log-failed\``,
          `If \`--log-failed\` returns nothing (e.g. the only failed step was a timeout with no`,
          `captured output, or logs were purged), fall back to:`,
          `  \`gh run view <run-id> --repo ${fullName} --log\``,
          `and search for the failing job by name. Also check uploaded artifacts:`,
          `  \`gh run download <run-id> --repo ${fullName} --dir /tmp/run-<run-id>\``,
          `then \`ls\`/\`cat\` the extracted files. If every retrieval mechanism returns empty,`,
          `say so explicitly in your final reasoning rather than guessing at the failure cause.`,
          ``,
          `Most recent CI fixer errors recorded for this PR:`,
          errorsBlock,
          ``,
          ...(incidentCtx ? [incidentCtx, ``] : []),
          CI_FIXER_FAST_CHECKS_GUIDANCE,
          RUNNER_POLICY_CONTEXT,
          HOST_EXECUTION_POLICY,
          ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
        ].join("\n");

        const mcpConfigPath = claude.writeAgentMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName) });
        const timeoutMs = getItemTimeoutMs(fullName, pr.number);
        const tier = await classifyComplexity(
          [
            `Problematic PR deeper-diagnosis pass for #${pr.number} in ${fullName}.`,
            `Round ${round} of ${MAX_ROUNDS}.`,
            ``,
            `Failure log (first 2000 chars):`,
            failLog.slice(0, 2000),
          ].join("\n"),
          wtPath,
        );
        const model = getModel(tier, "claude");
        db.updateTaskModel(taskId, model);
        log.info(`[problematic-diagnoser] Using model "${model}" for round ${round} on ${fullName}#${pr.number}`);

        await claude.runClaude(prompt, wtPath, {
          mcpConfig: mcpConfigPath,
          timeoutMs,
          tier,
          model,
          agent: "build",
          onTokensUsed: db.trackTaskTokens(taskId),
        });

        let outcomeRow: TaskOutcome = { commits: 0 };

        if (await claude.hasNewCommits(wtPath, pr.headRefName)) {
          await claude.pushBranch(wtPath, pr.headRefName, repo.owner);
          const headSha = await claude.getHeadSha(wtPath);
          // Record it as a Claws push so the ci-fixer's new-commit grant doesn't
          // treat the diagnoser's own fix rounds as manual intervention.
          db.recordCIFixerPush(fullName, pr.number, headSha.trim());
          log.info(`[problematic-diagnoser] Pushed round-${round} fix for ${fullName}#${pr.number} (HEAD=${headSha.slice(0, 7)})`);
          outcomeRow = await buildSuccessOutcome(wtPath, pr.baseRefName, pr.number, "updated");
          result = { action: "pushed", headSha };
        } else {
          log.warn(`[problematic-diagnoser] Round ${round}: no commits produced for ${fullName}#${pr.number}`);
        }

        db.recordTaskComplete(taskId, outcomeRow);
      },
    );

    if (wtResult === null) {
      log.info(`[problematic-diagnoser] Branch ${pr.headRefName} no longer exists for ${fullName}#${pr.number} — skipping`);
      db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "skipped" });
    }
  });

  return result;
}

async function waitForCheck(
  repo: string,
  pr: gh.PR,
  sinceCommitSha: string,
  budgetMs: number,
): Promise<WatchResult> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(ciPollIntervalMs);
    let headSha: string;
    try {
      headSha = await gh.getPRHeadSHA(repo, pr.number);
    } catch (err) {
      log.warn(`[problematic-diagnoser] getPRHeadSHA poll failed for ${repo}#${pr.number}: ${err}`);
      continue;
    }
    if (headSha && sinceCommitSha && headSha !== sinceCommitSha) {
      return { state: "superseded" };
    }
    let failing: gh.FailedCheck | undefined;
    try {
      failing = await gh.getFailingCheck(repo, pr.number);
    } catch (err) {
      log.warn(`[problematic-diagnoser] getFailingCheck poll failed for ${repo}#${pr.number}: ${err}`);
      continue;
    }
    if (failing) {
      return { state: "failing", failedCheck: failing };
    }
    let status: "passing" | "failing" | "pending" | "none";
    try {
      status = await gh.getPRCheckStatus(repo, pr.number);
    } catch (err) {
      log.warn(`[problematic-diagnoser] getPRCheckStatus poll failed for ${repo}#${pr.number}: ${err}`);
      continue;
    }
    if (status === "passing" || status === "none") {
      return { state: "passing" };
    }
    // pending — keep polling
  }
  return { state: "timeout" };
}

async function refetchPR(fullName: string, prNumber: number): Promise<gh.PR | null> {
  try {
    const prs = await gh.listPRs(fullName);
    return prs.find((p) => p.number === prNumber) ?? null;
  } catch (err) {
    log.warn(`[problematic-diagnoser] refetchPR failed for ${fullName}#${prNumber}: ${err}`);
    return null;
  }
}

/**
 * True when a merge conflict still blocks the PR — i.e. the CI-fixer circuit breaker
 * still counts it as dispatchable work and may have applied `Claws Problematic` for it.
 *
 * The breaker (`identifyPRWork`, src/agents/ci-fixer.ts) trips on a failing check *or* a
 * CONFLICTING PR, so "the label is stale" has to mean neither is true. Judging staleness
 * on green CI alone strips a conflict-triggered label on the next pass, the breaker
 * re-applies it, and the PR flaps forever with no escalation.
 *
 * Fails closed (`true`) so a transient API error never strips a label we can't prove stale.
 */
async function hasBlockingConflict(fullName: string, prNumber: number): Promise<boolean> {
  try {
    return (await gh.getPRMergeableState(fullName, prNumber)) === "CONFLICTING";
  } catch (err) {
    log.warn(`[problematic-diagnoser] getPRMergeableState failed for ${fullName}#${prNumber}: ${err}`);
    return true;
  }
}

async function clearStaleProblematicLabelIfGreen(fullName: string, prNumber: number): Promise<boolean> {
  let failing: gh.FailedCheck | undefined;
  try {
    failing = await gh.getFailingCheck(fullName, prNumber);
  } catch (err) {
    log.warn(`[problematic-diagnoser] getFailingCheck failed for ${fullName}#${prNumber}: ${err}`);
    return false;
  }
  if (failing) return false;

  let status: "passing" | "failing" | "pending" | "none";
  try {
    status = await gh.getPRCheckStatus(fullName, prNumber);
  } catch (err) {
    log.warn(`[problematic-diagnoser] getPRCheckStatus failed for ${fullName}#${prNumber}: ${err}`);
    return false;
  }
  if (status !== "passing" && status !== "none") return false;

  if (await hasBlockingConflict(fullName, prNumber)) {
    log.info(`[problematic-diagnoser] CI green for ${fullName}#${prNumber} but the PR still has merge conflicts — keeping ${LABELS.problematic}`);
    return false;
  }

  if (!(await gh.removeLabel(fullName, prNumber, LABELS.problematic))) {
    log.warn(`[problematic-diagnoser] Could not remove stale ${LABELS.problematic} from ${fullName}#${prNumber} — leaving the breaker state untouched for the next sweep`);
    return false;
  }
  db.resetCIFixerBreakerGrants(fullName, prNumber);
  log.info(`[problematic-diagnoser] CI green for already-diagnosed ${fullName}#${prNumber} — removed stale ${LABELS.problematic} label`);
  return true;
}

async function postFinalReport(repo: Repo, pr: gh.PR, outcome: Outcome): Promise<void> {
  const fullName = repo.fullName;
  const logsPath = `/logs/issue?repo=${encodeURIComponent(fullName)}&number=${pr.number}`;

  const headline =
    outcome.kind === "success" ? "Diagnosis succeeded — CI is now passing" :
    outcome.kind === "no-fix-possible" ? "Diagnosis stopped — no fix attempted" :
    outcome.kind === "max-rounds-exhausted" ? `Diagnosis stopped after ${MAX_ROUNDS} rounds — CI still failing` :
    outcome.kind === "budget-exhausted" ? `Diagnosis stopped — CI watch budget exhausted on round ${outcome.roundsRun}` :
    `Diagnosis stopped — ${outcome.reason}`;

  const details: string[] = [];
  if (outcome.kind === "no-fix-possible") {
    details.push(`Reason: ${outcome.reason}`);
  }
  if ("roundsRun" in outcome) {
    details.push(`Rounds run: ${outcome.roundsRun} / ${MAX_ROUNDS}`);
  }

  const nextSteps = outcome.kind === "success"
    ? `The \`${LABELS.problematic}\` label has been removed; this PR will re-enter the normal flow.`
    : `Manual intervention required. To allow Claws to retry diagnosis on this PR after manual fixes, delete this comment **and** ensure the \`${LABELS.problematic}\` label is present.`;

  const body = [
    `### 🩺 Problematic PR Diagnosis Report`,
    DIAGNOSIS_COMMENT_MARKER,
    "",
    `**${headline}**`,
    "",
    ...(details.length > 0 ? [details.map((d) => `- ${d}`).join("\n"), ""] : []),
    `View round-by-round logs in the Claws dashboard: \`${logsPath}\``,
    "",
    nextSteps,
  ].join("\n");

  try {
    await gh.commentOnIssue(fullName, pr.number, body, { agentName: "Problematic PR Diagnoser" });
  } catch (err) {
    log.warn(`[problematic-diagnoser] Failed to post final report for ${fullName}#${pr.number}: ${err}`);
    reportError("ci-fixer:problematic:report", `${fullName}#${pr.number}`, err);
  }
}

