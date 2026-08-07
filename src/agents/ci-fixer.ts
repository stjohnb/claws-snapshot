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
import { guardContent, makeGuardCtx, formatGuardedTitleList } from "../prompt-guard.js";
import { CI_FIXER_FAST_CHECKS_GUIDANCE, RUNNER_POLICY_CONTEXT, homeAssistantContext } from "./agent-context.js";
import { isHomeAssistantConfigRepo } from "../home-assistant.js";
import { getModel } from "../model-selector.js";
import { classifyComplexity } from "../classify-complexity.js";
import type { Provider } from "../plan-parser.js";
import { parseFirstValidJson } from "../json-extract.js";
import { extractManualActionSection, MANUAL_ACTION_HEADING, regenerateAndUpdatePRBody } from "./issue-worker.js";
import { ensureAlertIssue } from "../occurrence-tracking.js";

export type WorkItem =
  | { kind: "conflict"; repo: Repo; pr: gh.PR }
  | { kind: "rerun"; repo: Repo; pr: gh.PR; runId: string; infra?: boolean }
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
  await regenerateAndUpdatePRBody(wtPath, fullName, pr, model, actualProvider, attributionVerb, "[ci-fixer]");
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

// Run IDs already auto-re-run once after an "unrelated" classification. `gh run
// rerun` creates a new ATTEMPT on the same run ID, so a second failure presents
// the same ID here and is skipped — one retry per run, never a loop.
const autoRerunIds = new Set<string>();

export function _resetAutoRerunIdsForTests(): void {
  autoRerunIds.clear();
}

/** Retries allowed per run ID that keeps coming back as a runner outage. Bounds the
 * loop when the whole pool is down — after this the run falls through to the normal
 * fix path and the circuit breaker behaves exactly as it did before. */
const INFRA_MAX_RERUNS = 3;

/** Failed rerun *calls* allowed per run ID, counted separately from INFRA_MAX_RERUNS
 * because a call that threw never re-tested anything. Without this bound a run GitHub
 * permanently refuses to re-run (too old, jobs cancelled at the 24h limit) never
 * increments either counter, so every sweep re-classifies it as an outage and re-calls
 * performRerun forever — the loop deadRerunIds exists to prevent, reintroduced. */
const INFRA_MAX_RERUN_FAILURES = 2;

/** Queued runs across all synced repos above which discretionary reruns are deferred.
 * The linux pool is two runners; one 3d-models render can hold one for ~2h. */
export const RERUN_QUEUE_DEPTH_LIMIT = 10;

// In-memory by design, same trade-off as deadRerunIds: a restart costs one extra retry.
const infraRerunCounts = new Map<string, number>();
const infraRerunFailures = new Map<string, number>();

export function _resetInfraRerunsForTests(): void {
  infraRerunCounts.clear();
  infraRerunFailures.clear();
}

export function noteInfraRerun(runId: string): void {
  infraRerunCounts.set(runId, (infraRerunCounts.get(runId) ?? 0) + 1);
}

/** Record a rerun call GitHub rejected outright, so an un-rerunnable run stops being
 * re-picked as infra work instead of retrying every sweep forever. */
export function noteInfraRerunFailure(runId: string): void {
  infraRerunFailures.set(runId, (infraRerunFailures.get(runId) ?? 0) + 1);
}

export function isInfraRerunExhausted(runId: string): boolean {
  return (infraRerunCounts.get(runId) ?? 0) >= INFRA_MAX_RERUNS
    || (infraRerunFailures.get(runId) ?? 0) >= INFRA_MAX_RERUN_FAILURES;
}

/** Org-wide GitHub Actions queue depth, from the runner-metrics-sync snapshot. */
export function isPoolSaturated(): boolean {
  return db.getActiveWorkflowRuns().filter((r) => r.status === "queued").length >= RERUN_QUEUE_DEPTH_LIMIT;
}

/**
 * Executes a "rerun" work item. Returns true if a rerun was triggered.
 * Infra-outage runs re-run only their failed jobs and NEVER get the Manual Action
 * label — a runner restart is not a PR defect (fleet-infra#745, 3d-models#350 were
 * both labelled Manual Action + Claws Problematic for hours by the old path, then
 * went 12/12 green on a single manual re-run, unchanged).
 */
export async function performRerun(item: Extract<WorkItem, { kind: "rerun" }>): Promise<boolean> {
  const fullName = item.repo.fullName;

  if (item.infra) {
    if (!gh.hasPriorityLabel(item.pr.labels) && isPoolSaturated()) {
      log.info(`[ci-fixer] Deferring runner-outage rerun of ${item.runId} for ${fullName}#${item.pr.number}: ${RERUN_QUEUE_DEPTH_LIMIT}+ runs already queued org-wide`);
      return false;
    }
    // Counted only once a rerun has actually been triggered: a rerun call that fails
    // outright never re-tested anything, so it must not burn one of the retries.
    try {
      await gh.rerunFailedJobs(fullName, item.runId);
      noteInfraRerun(item.runId);
      log.info(`[ci-fixer] Re-ran failed jobs of ${item.runId} for ${fullName}#${item.pr.number} (runner outage)`);
      return true;
    } catch (err) {
      if (err instanceof Error && /already running/i.test(err.message)) {
        noteInfraRerun(item.runId);
        log.info(`[ci-fixer] workflow ${item.runId} for ${fullName}#${item.pr.number} already running`);
        return true;
      }
      // The failed-jobs endpoint rejects a run whose jobs are all `cancelled`; fall
      // back once to a full rerun. Never reportRunNotRerunnable here — an outage is
      // not the PR's fault and must not label it for manual action.
      log.warn(`[ci-fixer] rerunFailedJobs failed for ${fullName}#${item.pr.number} run ${item.runId}: ${err} — falling back to a full rerun`);
      try {
        await gh.rerunWorkflow(fullName, item.runId);
        noteInfraRerun(item.runId);
        return true;
      } catch (fallbackErr) {
        if (fallbackErr instanceof Error && /already running/i.test(fallbackErr.message)) {
          noteInfraRerun(item.runId);
          log.info(`[ci-fixer] workflow ${item.runId} for ${fullName}#${item.pr.number} already running`);
          return true;
        }
        if (fallbackErr instanceof Error && /cannot be rerun|Resource not accessible/i.test(fallbackErr.message)) {
          // Both endpoints refused. Still never reportRunNotRerunnable — but count the
          // failure so isInfraRerunExhausted eventually trips and the run falls through
          // to the normal path instead of being re-picked as outage work every sweep.
          noteInfraRerunFailure(item.runId);
          log.warn(`[ci-fixer] Full rerun of ${item.runId} for ${fullName}#${item.pr.number} also failed: ${fallbackErr}`);
          return false;
        }
        // A transient failure (e.g. a rate limit) is not GitHub refusing the rerun —
        // don't burn the infra rerun-failure budget on it, or a genuine outage can get
        // misrouted to the code-fix path over a blip unrelated to re-runnability.
        log.warn(`[ci-fixer] Full rerun of ${item.runId} for ${fullName}#${item.pr.number} failed transiently: ${fallbackErr}`);
        return false;
      }
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
    if (err instanceof Error && /cannot be rerun|Resource not accessible/i.test(err.message)) {
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
 * Record that GitHub refused to re-run `runId`, label the PR for manual
 * attention, and write a one-time notice into the PR body's manual-action
 * section so a human knows to trigger a fresh CI run (push a commit or
 * close/reopen the PR). Once marked, identifyPRWork stops classifying the
 * run as rerun work.
 */
export async function reportRunNotRerunnable(repo: Repo, pr: gh.PR, runId: string): Promise<void> {
  const alreadyKnown = deadRerunIds.has(runId);
  deadRerunIds.add(runId);
  if (alreadyKnown) {
    log.info(`[ci-fixer] Run ${runId} for ${repo.fullName}#${pr.number} is already marked not-rerunnable — skipping notice`);
    return;
  }
  log.warn(`[ci-fixer] GitHub refused to re-run ${runId} for ${repo.fullName}#${pr.number}, retries stopped, labelling ${LABELS.manualAction}`);
  try {
    await gh.addLabel(repo.fullName, pr.number, LABELS.manualAction);
  } catch (err) {
    log.warn(`[ci-fixer] Could not apply ${LABELS.manualAction} to ${repo.fullName}#${pr.number}: ${err}`);
  }
  try {
    const guardCtx = makeGuardCtx(repo.fullName, pr.number);
    const branch = guardContent(pr.headRefName, guardCtx("pr-branch"));
    const body = await gh.getPRBody(repo.fullName, pr.number);
    if (body.includes(`${NOT_RERUNNABLE_MARKER} ${runId} -->`)) return;
    const stripped = stripNotRerunnableSection(body);
    const hasForeignSection = extractManualActionSection(stripped) !== null;
    const note = [
      `${NOT_RERUNNABLE_MARKER} ${runId} -->`,
      `Claws tried to re-run CI run [${runId}](https://github.com/${repo.fullName}/actions/runs/${runId}), but GitHub refused (\`cannot be rerun\` / \`Resource not accessible by integration\`). This happens when a run is too old or its state is not re-runnable — e.g. jobs cancelled at the 24h limit after a runner went away.`,
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

  const runId = failedCheck.link?.match(/\/actions\/runs\/(\d+)/)?.[1];

  // A job that recorded zero steps never ran user code — the runner went away
  // mid-job. Retry it rather than treating it as a defect in the PR. Deliberately
  // does NOT increment the counter: identifyPRWork runs every sweep, so counting
  // here would exhaust the budget without ever issuing a rerun.
  if (runId && !deadRerunIds.has(runId) && !isInfraRerunExhausted(runId)) {
    const jobs = await gh.getRunJobSummaries(fullName, runId);
    if (gh.isInfrastructureOutage(jobs)) {
      log.info(`[ci-fixer] Run ${runId} for ${fullName}#${pr.number} failed with zero recorded steps — runner outage, retrying rather than fixing`);
      return { kind: "rerun", repo, pr, runId, infra: true };
    }
  }

  if (CANCELLED_STATES.has(failedCheck.state)) {
    if (runId && deadRerunIds.has(runId)) return null;
    if (runId) return { kind: "rerun", repo, pr, runId };
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

  // Already known not-rerunnable: GitHub will refuse again. Still record one failed
  // attempt so the circuit breaker trips and the sweep stops re-picking this PR
  // (bonkus#1652 looped 7 times because this path skipped the deadRerunIds check).
  if (deadRerunIds.has(runId)) {
    const taskId = db.recordTaskStart("ci-fixer", fullName, pr.number, null);
    log.info(`[ci-fixer] Run ${runId} for ${fullName}#${pr.number} is already marked not-rerunnable — skipping retry`);
    db.recordTaskFailed(taskId, "CI run logs unavailable and GitHub refuses to re-run the run", { failureCategory: "logs-unavailable" });
    return;
  }

  // A stepless job yields an empty log too, so the outage check belongs here as well.
  // Returning without recordTaskStart/recordTaskFailed is the point: a runner restart
  // must not consume the fix-attempt budget or the consecutive-failure count that
  // trips the circuit breaker into `Claws Problematic`.
  if (!isInfraRerunExhausted(runId)) {
    const jobs = await gh.getRunJobSummaries(fullName, runId);
    if (gh.isInfrastructureOutage(jobs)) {
      log.info(`[ci-fixer] Missing logs for ${fullName}#${pr.number} are a runner outage (zero recorded steps) — re-running, not counting an attempt`);
      await performRerun({ kind: "rerun", repo, pr, runId, infra: true });
      return;
    }
  }

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

  // "Unrelated" means the classifier decided this failure is not the PR's
  // fault — flaky test, runner issue, pre-existing breakage. For all three the
  // correct response is the same: requeue the run once. That also covers the
  // motivating case (#2278): the NixOS runner `ryzen` matches
  // `[self-hosted, linux]` but cannot build claws' native modules, and a
  // re-run can land the job on a healthy runner. Deliberately NOT gated on a
  // log-content regex — the failure text is whatever the runner or the
  // workflow happens to print, and a pattern list keyed to it silently rots.
  const runId = failedCheck.link?.match(/\/actions\/runs\/(\d+)/)?.[1];
  if (runId && !autoRerunIds.has(runId) && !deadRerunIds.has(runId)) {
    if (!gh.hasPriorityLabel(pr.labels) && isPoolSaturated()) {
      log.info(`[ci-fixer] Deferring unrelated-failure rerun of ${runId} for ${fullName}#${pr.number}: ${RERUN_QUEUE_DEPTH_LIMIT}+ runs already queued org-wide`);
    } else {
      autoRerunIds.add(runId);
      log.info(`[ci-fixer] Unrelated failure on ${fullName}#${pr.number} (run ${runId}) — re-running once`);
      try {
        await gh.rerunWorkflow(fullName, runId);
      } catch (err) {
        if (err instanceof Error && /already running/i.test(err.message)) {
          log.info(`[ci-fixer] workflow ${runId} for ${fullName}#${pr.number} already running`);
        } else if (err instanceof Error && /cannot be rerun|Resource not accessible/i.test(err.message)) {
          await reportRunNotRerunnable(repo, pr, runId);
        } else {
          log.warn(`[ci-fixer] Auto-rerun of ${runId} for ${fullName}#${pr.number} failed: ${err}`);
        }
      }
    }
  }

  await revertPreviousUnrelatedFixes(repo, pr, changedFiles);
  await mergeBaseIfBehind(repo, pr);
}

export async function fixCI(repo: Repo, pr: gh.PR, failLog: string): Promise<void> {
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
        db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

        const guardCtx = makeGuardCtx(fullName, pr.number);
        // Titles below come from *other* PRs, so an injection alert must not be attributed
        // to this PR — sentinel item 0, same convention as idea-suggester/improvement-identifier.
        const othersGuardCtx = makeGuardCtx(fullName, 0);
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
          ...(others.length > 0 ? [
            `Other open PRs on this repository:`,
            formatGuardedTitleList(others.map((p) => `#${p.number} ${p.title} (branch ${p.headRefName})`), othersGuardCtx, "pr-title"),
            ``,
            `Before writing a fix, consider whether one of those PRs already contains it. Two PRs can be mutually blocking — each fixes half of a shared failure and neither can go green alone. If another open PR's branch already carries the fix for this failure, cherry-pick or merge that commit into this branch (\`git fetch origin <branch>\` then \`git cherry-pick <sha>\`) instead of writing a second, parallel fix.`,
            ``,
          ] : []),
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

export async function fileUnrelatedIssue(
  repoName: string,
  occurrences: Array<{ fingerprint: string; reason: string; failLog: string; pr: gh.PR; runUrl: string }>,
): Promise<void> {
  const title = `[ci-unrelated] CI failures unrelated to PR changes`;

  try {
    const pending = occurrences.filter((occ) => {
      if (!reportedUnrelatedOccurrences.has(unrelatedOccurrenceKey(repoName, occ))) return true;
      log.info(`[ci-fixer] Occurrence ${unrelatedOccurrenceKey(repoName, occ)} already logged on the [ci-unrelated] issue — skipping duplicate comment`);
      return false;
    });
    if (pending.length === 0) return;

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

    for (const occ of pending) {
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
      reportedUnrelatedOccurrences.add(unrelatedOccurrenceKey(repoName, occ));
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

