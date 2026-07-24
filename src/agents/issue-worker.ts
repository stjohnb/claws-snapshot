import os from "node:os";
import { LABELS, NAMEY_DB_URL, HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN, TOOL_USE_PROVIDER_FALLBACK_ORDER, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import type { TaskOutcome } from "../db.js";
import { buildSuccessOutcome } from "../outcome.js";
import { getItemTimeoutMs } from "../timeout-handler.js";
import { processTextForImages } from "../images.js";
import * as planParser from "../plan-parser.js";
import type { Provider } from "../plan-parser.js";
import { PLAN_HEADER } from "./issue-refiner.js";
import { KUBECTL_CONTEXT, NAMEY_DB_CONTEXT, FAST_CHECKS_GUIDANCE, RUNNER_POLICY_CONTEXT, homeAssistantContext, formatIssueCommentsForPrompt } from "./agent-context.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { isHomeAssistantConfigRepo } from "../home-assistant.js";
import { getModel, type ModelTier } from "../model-selector.js";

const MAX_NO_COMMIT_RETRIES = 3;

function hasMarker(comments: gh.IssueComment[], markerName: string, num: number): boolean {
  return comments.some((c) => new RegExp(`${markerName}:${num}(?!\\d)`).test(c.body));
}

async function postNoCommitComment(
  fullName: string,
  issue: gh.Issue,
  comments: gh.IssueComment[],
  currentPhase: number,
  wtPath: string,
  defaultBranch: string,
): Promise<void> {
  const marker = `no-commit:${currentPhase}`;
  if (hasMarker(comments, "no-commit", currentPhase)) return;

  const diagnosis = await claude.diagnoseNoCommits(wtPath, defaultBranch).catch((err) => {
    log.warn(`[issue-worker] Failed to diagnose no-commit for ${fullName}#${issue.number}: ${err}`);
    return null;
  });

  const retryInstructions = currentPhase > 1
    ? `Claws will retry this phase automatically. To update the plan, edit or replace the plan comment above.`
    : `To retry, re-add the \`Refined\` label.`;

  const diagnosisLines = diagnosis
    ? [`**Diagnosis:** ${diagnosis}`, ``]
    : [];

  const body = [
    `## No changes produced`,
    ``,
    `The implementer ran but did not produce any commits.`,
    ``,
    ...diagnosisLines,
    `This may mean:`,
    `- The implementation is already complete`,
    `- The task is not actionable as currently described`,
    `- The implementation plan needs updating`,
    ``,
    retryInstructions,
    ``,
    marker,
  ].join("\n");

  await gh.commentOnIssue(fullName, issue.number, body, { agentName: "Implementer" });
}

async function postStuckComment(
  fullName: string,
  issue: gh.Issue,
  comments: gh.IssueComment[],
  nextPhase: number,
  totalPhases: number,
  noCommitCount: number,
): Promise<void> {
  const marker = `phase-stuck:${nextPhase}`;
  if (hasMarker(comments, "phase-stuck", nextPhase)) return;

  const body = [
    `## Phase ${nextPhase}/${totalPhases} stuck`,
    ``,
    `This phase has been attempted ${noCommitCount} times without producing any commits.`,
    `The implementation may already be complete, the plan may need updating, or the task may not be actionable.`,
    ``,
    `To retry, re-add the \`Refined\` label. To update the plan, edit or replace the plan comment above.`,
    ``,
    marker,
  ].join("\n");

  await gh.commentOnIssue(fullName, issue.number, body, { agentName: "Implementer" });
}

function buildPrompt(
  fullName: string,
  issue: gh.Issue,
  plan: planParser.ParsedPlan | null,
  currentPhase: number,
  totalPhases: number,
  selfLogin: string,
  mergedPRs: gh.PR[],
  comments: gh.IssueComment[],
  imageContext: string,
): string {
  const guardCtx = makeGuardCtx(fullName, issue.number);
  if (totalPhases === 1 || !plan || !plan.phases[currentPhase - 1]) {
    return [
      `You are working on a GitHub issue for the repository ${fullName}.`,
      `Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
      ``,
      guardContent(issue.body, guardCtx("issue-body")),
      ``,
      ...formatIssueCommentsForPrompt(comments, selfLogin, guardCtx),
      `If \`docs/OVERVIEW.md\` exists, read it first (and any linked documents that seem relevant to the issue) for context about the codebase.`,
      KUBECTL_CONTEXT,
      ...(NAMEY_DB_URL ? [NAMEY_DB_CONTEXT] : []),
      FAST_CHECKS_GUIDANCE,
      RUNNER_POLICY_CONTEXT,
      ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
      ``,
      `Please implement the changes needed to resolve this issue.`,
      `Make commits with clear messages as you work.`,
      `Do NOT create a pull request or push your branch — that is handled automatically after you finish.`,
      imageContext,
    ].join("\n");
  }

  const phase = plan.phases[currentPhase - 1];
  return [
    `You are working on PR ${currentPhase} of ${totalPhases} for issue #${issue.number} in ${fullName}.`,
    `Issue: ${guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    `If \`docs/OVERVIEW.md\` exists, read it first (and any linked documents that seem relevant to the issue) for context about the codebase.`,
    KUBECTL_CONTEXT,
    ...(NAMEY_DB_URL ? [NAMEY_DB_CONTEXT] : []),
    FAST_CHECKS_GUIDANCE,
    RUNNER_POLICY_CONTEXT,
    ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
    ``,
    `## Full Plan`,
    // Plan content is self-authored by Claws (extracted from Claws' own plan comments) —
    // guarding it produces false positives when plans discuss security topics or patterns.
    plan.preamble,
    ...plan.phases.map((p) => `### PR ${p.phaseNumber}: ${p.title}\n${p.description}`),
    ``,
    `## Already Completed`,
    mergedPRs.length > 0
      ? mergedPRs.map((pr) => `- PR #${pr.number}: ${guardContent(pr.title, guardCtx("pr-title"))}`).join("\n")
      : `None yet — this is the first PR.`,
    ``,
    `## Your Task`,
    `Implement ONLY the changes for PR ${currentPhase}: ${phase.title}`,
    ``,
    phase.description,
    ``,
    `Do NOT implement changes from other phases.`,
    `Make commits with clear messages as you work.`,
    `Do NOT create a pull request or push your branch — that is handled automatically after you finish.`,
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
    const marker = `phase-progress:${mergedPRs.length}`;

    // Dedup: skip if a comment with this marker already exists
    if (hasMarker(comments, "phase-progress", mergedPRs.length)) {
      log.info(`[issue-worker] Progress comment already posted for phase ${mergedPRs.length}, skipping`);
      return;
    }

    const gctx = makeGuardCtx(fullName, issue.number);
    const prList = mergedPRs
      .map((pr) => `- PR #${pr.number}: ${guardContent(pr.title, gctx("pr-title"))}`)
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

    await gh.commentOnIssue(fullName, issue.number, body, { agentName: "Implementer" });
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
  generatedSubject?: string | null,
): string {
  if (totalPhases === 1 || !plan || !plan.phases[currentPhase - 1]) {
    const subject = generatedSubject?.trim() || issue.title;
    return `fix: resolve #${issue.number} — ${subject}`;
  }
  const phase = plan.phases[currentPhase - 1];
  return `fix(#${issue.number}): ${phase.title} (${currentPhase}/${totalPhases})`;
}

/** Strip a leading `TITLE: …` marker line from a generated PR description.
 * Returns the cleaned body plus the captured subject (null if no marker). */
export function extractTitleMarker(
  description: string,
): { body: string; title: string | null } {
  const m = description.match(/^[ \t]*TITLE:[ \t]*(.+?)[ \t]*$/im);
  if (!m) return { body: description, title: null };
  const body = description.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim();
  // Defensively strip a conventional-commit type prefix the model may add,
  // since buildPRTitle prepends "fix: resolve #N — " itself.
  const title = m[1].trim().replace(/^(?:fix|feat|chore|refactor|docs|test|perf|build|ci)(?:\([^)]*\))?:\s*/i, "").trim();
  return { body, title: title || null };
}

/** Strip a trailing `MANUAL-ACTION: …` marker line from a generated PR description.
 * Returns the cleaned body plus the captured reason (null if no marker). */
export function extractManualActionMarker(
  description: string,
): { body: string; manualAction: string | null } {
  const m = description.match(/^[ \t]*MANUAL-ACTION:[ \t]*(.+?)[ \t]*$/im);
  if (!m) return { body: description, manualAction: null };
  const body = description.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim();
  return { body, manualAction: m[1].trim() };
}

export const MANUAL_ACTION_HEADING = "## ⚠️ Manual action required before merge";

/** Extract the manual-action section (heading + note) from a PR body, if present.
 * Used to carry the section forward when other jobs (review-addresser, ci-fixer)
 * regenerate the PR body from scratch, which would otherwise silently drop it. */
export function extractManualActionSection(body: string): string | null {
  const idx = body.indexOf(MANUAL_ACTION_HEADING);
  if (idx === -1) return null;
  const rest = body.slice(idx);
  const end = rest.search(/\n\nreview-model:/i);
  return (end === -1 ? rest : rest.slice(0, end)).trimEnd();
}

/** Strip GitHub closing keywords (e.g. "closes #123") from LLM-generated text
 * to prevent GitHub from auto-closing an unrelated issue when the PR merges. */
function stripClosingKeywords(text: string): string {
  return text.replace(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+(?:\s*\(PR \d+ of \d+\))?/gi,
    "",
  ).replace(/\n{3,}/g, "\n\n").trim();
}

function buildPRBody(
  issue: gh.Issue,
  plan: planParser.ParsedPlan | null,
  currentPhase: number,
  totalPhases: number,
  isLastPhase: boolean,
  description: string,
  duplicateIssueNumbers: number[] = [],
): string {
  const issueRef = isLastPhase
    ? [`Closes #${issue.number}`, ...duplicateIssueNumbers.map((n) => `Closes #${n}`)].join("\n")
    : `Part of #${issue.number}`;

  const cleanDescription = stripClosingKeywords(description);

  if (totalPhases === 1 || !plan || !plan.phases[currentPhase - 1]) {
    return `${cleanDescription}\n\n${issueRef}`;
  }

  const phase = plan.phases[currentPhase - 1];
  return [
    `## PR ${currentPhase} of ${totalPhases}: ${phase.title}`,
    ``,
    phase.description,
    ``,
    cleanDescription,
    ``,
    issueRef,
  ].join("\n");
}

export async function processIssue(repo: Repo, issue: gh.Issue): Promise<void> {
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

  await db.withTaskRecording("issue-worker", fullName, issue.number, LABELS.refined, async (taskId) => {
    // 1. Read plan from issue comments
    const comments = await gh.getIssueComments(fullName, issue.number);
    const planText = planParser.findPlanComment(comments);
    const plan = planText ? planParser.parsePlan(planText) : null;

    // 2. Determine current phase
    const mergedPRs = await gh.listMergedPRsForIssue(fullName, issue.number);
    const totalPhases = plan?.totalPhases ?? 1;
    const currentPhase = mergedPRs.length + 1;
    const isLastPhase = currentPhase >= totalPhases;

    // Guard: all phases already complete (more merged PRs than plan phases)
    if (currentPhase > totalPhases) {
      log.info(`[issue-worker] All ${totalPhases} phases already complete for ${fullName}#${issue.number} (${mergedPRs.length} merged PRs), removing Refined label`);
      try {
        await gh.removeLabel(fullName, issue.number, LABELS.refined);
      } finally {
        db.recordTaskComplete(taskId, { commits: 0 });
      }
      return;
    }

    const branchName = `claws/issue-${issue.number}-${claude.randomSuffix()}`;

    await claude.withNewWorktree(repo, branchName, "issue-worker", async (wtPath) => {
      db.updateTaskWorktree(taskId, wtPath, branchName);

      log.info(`[issue-worker] Phase ${currentPhase}/${totalPhases} for ${fullName}#${issue.number}`);

      // Post a progress comment summarizing completed phases (preserves original plan)
      if (currentPhase > 1 && plan) {
        await postPhaseProgressComment(fullName, issue, comments, mergedPRs, currentPhase, totalPhases);
      }

      const [issueBodyHtml, selfLogin] = await Promise.all([
        gh.getIssueBodyHtml(fullName, issue.number).catch(() => ""),
        gh.getSelfLogin(repo.owner),
      ]);
      const htmlBodies = [issueBodyHtml, ...comments.map((c) => c.body_html)];
      const imageContext = await processTextForImages([issue.body, ...comments.map((c) => c.body)], wtPath, repo.owner, { repo: fullName, issueNumber: issue.number, agentName: "Implementer" }, htmlBodies);

      // 3. Build phase-aware prompt
      const prompt = buildPrompt(fullName, issue, plan, currentPhase, totalPhases, selfLogin, mergedPRs, comments, imageContext);

      const timeoutMs = getItemTimeoutMs(fullName, issue.number);
      const recommendedModel = planText ? planParser.getRecommendedModel(planText) : null;
      const provider = TOOL_USE_PROVIDER_FALLBACK_ORDER[0] ?? "claude";
      const tier = (recommendedModel ?? "sonnet") as ModelTier;
      const model = getModel(tier, "tool-use", provider);
      const mcpConfigPath = claude.writeClawsMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName) });
      const agentDoc = claude.readRepoAgentDoc(wtPath, "issue-implementer");
      if (recommendedModel) {
        log.info(`[issue-worker] Plan recommends model "${recommendedModel}" for ${fullName}#${issue.number}`);
      }
      db.updateTaskModel(taskId, model);

      // Track the actual provider used (may differ from recommended if fallback occurs)
      let actualProvider: Provider = provider;
      await claude.runClaude(prompt, wtPath, {
        capability: "tool-use",
        mcpConfig: mcpConfigPath,
        timeoutMs,
        model,
        tier,
        provider,
        appendSystemPrompt: agentDoc,
        onProviderUsed: (p) => { actualProvider = p; },
        onTokensUsed: db.trackTaskTokens(taskId),
        agent: "build",
        captureLabel: "issue-worker",
      });

      db.updateTaskProvider(taskId, actualProvider);

      let outcome: TaskOutcome = { commits: 0 };

      if (await claude.hasNewCommits(wtPath, repo.defaultBranch)) {
        await claude.pushBranch(wtPath, branchName, repo.owner);

        // PR descriptions are always generated by the Claude backend, even for
        // Codex-backed tasks — this is intentional (Codex doesn't support JSON output).
        const actualModel = getModel(tier, "tool-use", actualProvider);
        const prAttribution = actualProvider !== provider
          ? `*— Implemented with: ${actualModel} (provider: ${actualProvider}) [fallback from ${provider} due to rate limit] —*`
          : `*— Implemented with: ${model} (provider: ${actualProvider}) —*`;
        const rawDescription = await claude.generatePRDescription(
          wtPath, repo.defaultBranch, issue, fullName, prAttribution,
        );
        const { body: afterTitle, title: generatedTitle } = extractTitleMarker(rawDescription);
        const { body: description, manualAction } = extractManualActionMarker(afterTitle);

        // 4. Create PR with appropriate title and body
        const prTitle = buildPRTitle(issue, plan, currentPhase, totalPhases, generatedTitle);
        const duplicateIssueNumbers = isLastPhase
          ? await gh.listDuplicateIssuesOf(fullName, issue.number)
              .then((issues) => issues.map((i) => i.number))
              .catch((err) => {
                log.warn(`[issue-worker] Failed to fetch duplicate issues for ${fullName}#${issue.number}: ${err}`);
                return [] as number[];
              })
          : [];
        const rawPRBody = buildPRBody(issue, plan, currentPhase, totalPhases, isLastPhase, description, duplicateIssueNumbers);
        const bodyWithNote = manualAction
          ? `${rawPRBody}\n\n${MANUAL_ACTION_HEADING}\n\n${stripClosingKeywords(manualAction)}`
          : rawPRBody;
        const reviewModelRec = planText ? planParser.getRecommendedReviewModel(planText) : null;
        const prBody = reviewModelRec
          ? `${bodyWithNote}\n\nreview-model: ${reviewModelRec}`
          : bodyWithNote;

        const prNumber = await gh.createPR(fullName, branchName, prTitle, prBody);
        // Defense-in-depth: if Claude disobeyed and created its own PR (which
        // createPR then returns), the title/body may be wrong. The edit is a
        // no-op in the normal path but corrects the PR in the duplicate case.
        try {
          await gh.updatePR(fullName, prNumber, prBody, prTitle);
        } catch (err) {
          log.warn(`[issue-worker] Failed to update PR #${prNumber} for ${fullName}#${issue.number}: ${err}`);
        }
        log.info(`[issue-worker] Created PR #${prNumber} (${currentPhase}/${totalPhases}) for ${fullName}#${issue.number}`);
        await gh.addLabel(fullName, issue.number, LABELS.inReview);

        // Propagate Priority label to the new PR
        if (gh.hasPriorityLabel(issue.labels)) {
          await gh.addLabel(fullName, prNumber, LABELS.priority);
        }

        // Propagate Automerge so auto-merger can merge without a human LGTM
        if (issue.labels.some((l) => l.name === LABELS.automerge)) {
          await gh.addLabel(fullName, prNumber, LABELS.automerge);
          log.info(`[issue-worker] Propagated ${LABELS.automerge} to PR #${prNumber} for ${fullName}#${issue.number}`);
        }

        if (manualAction) {
          await gh.addLabel(fullName, prNumber, LABELS.manualAction);
          log.info(`[issue-worker] Applied ${LABELS.manualAction} to PR #${prNumber} for ${fullName}#${issue.number}: ${manualAction}`);
        }

        outcome = await buildSuccessOutcome(wtPath, repo.defaultBranch, prNumber, "created");
      } else {
        log.warn(`[issue-worker] No commits produced for ${fullName}#${issue.number}`);
        try {
          await postNoCommitComment(fullName, issue, comments, currentPhase, wtPath, repo.defaultBranch);
        } catch (err) {
          log.warn(`[issue-worker] Failed to post no-commit comment for ${fullName}#${issue.number}: ${err}`);
        }
      }

      await gh.removeLabel(fullName, issue.number, LABELS.refined);
      db.recordTaskComplete(taskId, outcome);
    });
  });
}

async function validateAndUpdatePlan(
  repo: Repo,
  issue: gh.Issue,
  plan: planParser.ParsedPlan,
  planCommentId: number,
  planCommentBody: string,
  completedPhase: number,
  lastMergedPR: gh.PR,
): Promise<void> {
  // Skip if plan was already updated after this phase
  const lastUpdatedPhase = planParser.getPlanUpdatePhase(planCommentBody);
  if (lastUpdatedPhase !== null && lastUpdatedPhase >= completedPhase) {
    log.info(`[issue-worker] Plan already validated after phase ${completedPhase}, skipping`);
    return;
  }

  const fullName = repo.fullName;

  // Get the PR diff, truncated to ~20K chars
  let diff = await gh.getPRDiff(fullName, lastMergedPR.number);
  if (!diff) {
    log.warn(`[issue-worker] Empty diff for PR #${lastMergedPR.number}, skipping plan validation`);
    return;
  }
  if (diff.length > 20_000) {
    diff = diff.slice(0, 20_000);
    const lastNl = diff.lastIndexOf("\n");
    if (lastNl > 0) diff = diff.slice(0, lastNl);
    diff += "\n... (truncated)";
  }

  // Build the full plan text for context
  const fullPlanText = [
    plan.preamble,
    ...plan.phases.map((p) => `### PR ${p.phaseNumber}: ${p.title}\n${p.description}`),
  ].join("\n\n");

  const phase = plan.phases[completedPhase - 1];
  if (!phase) {
    log.warn(`[issue-worker] Phase ${completedPhase} not found in plan, skipping validation`);
    return;
  }

  const prompt = [
    `You are validating whether a multi-phase implementation plan matches what was actually built.`,
    ``,
    `## Full Plan`,
    fullPlanText,
    ``,
    `## Phase ${completedPhase} ("${phase.title}") was just completed. Here is the PR diff:`,
    "```diff",
    diff,
    "```",
    ``,
    `Compare Phase ${completedPhase}'s plan against the diff. If the implementation closely follows the plan`,
    `(same approach, same files, minor deviations are OK), respond with exactly: NO_CHANGES_NEEDED`,
    ``,
    `If there are significant deviations (different approach, different files/classes modified,`,
    `different architecture than planned), produce an updated plan that:`,
    `1. Rewrites Phase ${completedPhase}'s description to reflect what was actually done`,
    `2. Adjusts subsequent phases to account for the reality of Phase ${completedPhase}`,
    `3. Keeps the same number of phases (${plan.totalPhases} total) and the same PR numbering`,
    ``,
    `Output ONLY the updated plan text starting from the preamble, using the exact`,
    `### PR N: Title format. Do not include the "## Implementation Plan" header or`,
    `any explanatory text outside the plan itself.`,
  ].join("\n");

  // Use tmpdir as CWD — validation is prompt-only (no repo access needed).
  // Always use the Claude backend for plan validation — Codex doesn't produce
  // the structured output needed to parse NO_CHANGES_NEEDED vs updated plan text.
  // Plan validation is text-only — produces either NO_CHANGES_NEEDED or an updated plan string.
  const result = await claude.runClaude(prompt, os.tmpdir(), { capability: "text-only", tier: "sonnet", agent: "plan" });

  if (result.trim() === "NO_CHANGES_NEEDED") {
    log.info(`[issue-worker] Plan validation: no changes needed after phase ${completedPhase} for ${fullName}#${issue.number}`);
    // Write the marker so re-invocations skip validation for this phase
    const strippedBody = gh.stripClawsMarker(planCommentBody).trim();
    const markerBody = `${strippedBody}\n\n${planParser.makePlanUpdateFooter(completedPhase)}`;
    await gh.editIssueComment(fullName, planCommentId, markerBody, { agentName: "Planner" });
    return;
  }

  // Validate that the output contains PR headers before replacing
  if (!result.includes("### PR")) {
    log.warn(`[issue-worker] Plan validation produced malformed output for ${fullName}#${issue.number}, skipping update`);
    return;
  }

  // Validate that Claude preserved the expected number of phases
  const prHeaderCount = (result.match(/### (?:PR|Phase) \d+/g) || []).length;
  if (prHeaderCount !== plan.totalPhases) {
    log.warn(`[issue-worker] Plan validation returned ${prHeaderCount} phases, expected ${plan.totalPhases} for ${fullName}#${issue.number}, skipping update`);
    return;
  }

  const cleaned = result.trim()
    .replace(/^##\s+Implementation Plan\s*\n*/m, "")
    .replace(/\s*\*\*Recommended implementation model:\*\*\s*`(?:opus|sonnet|cheap)`/g, "")
    .replace(/\s*\*\*Recommended provider:\*\*\s*`(?:claude|codex|opencode)`/g, "")
    .replace(/\s*\*Models used:[^\n*]+\*/gm, "")
    .trim();
  const originalModel = planParser.getRecommendedModel(planCommentBody);
  const originalAttribution = planParser.extractModelsAttribution(planCommentBody);
  const modelLine = originalModel ? `\n\n**Recommended implementation model:** \`${originalModel}\`` : "";
  const attributionLine = originalAttribution ? `\n\n${originalAttribution}` : "";
  const updatedBody = `${PLAN_HEADER}\n\n${cleaned}${modelLine}${attributionLine}\n\n${planParser.makePlanUpdateFooter(completedPhase)}`;
  await gh.editIssueComment(fullName, planCommentId, updatedBody, { agentName: "Planner" });
  log.info(`[issue-worker] Updated plan after phase ${completedPhase} for ${fullName}#${issue.number}`);
}

export async function checkAndContinue(repo: Repo, issue: gh.Issue): Promise<void> {
  const fullName = repo.fullName;

  // Is there still an open PR? If so, wait.
  const openPR = await gh.getOpenPRForIssue(fullName, issue.number);
  if (openPR) return;

  // No open PR — the latest PR must have been merged (or closed).
  // Check if there are more phases to do.
  const comments = await gh.getIssueComments(fullName, issue.number);
  const planEntry = planParser.findPlanCommentEntry(comments);
  const plan = planEntry ? planParser.parsePlan(planEntry.body) : null;

  const mergedPRs = await gh.listMergedPRsForIssue(fullName, issue.number);
  const totalPhases = plan?.totalPhases ?? 1;

  if (mergedPRs.length >= totalPhases) {
    log.info(`[issue-worker] All ${totalPhases} phases complete for ${fullName}#${issue.number}`);
    return;
  }

  // Validate and update plan if needed before advancing
  if (plan && planEntry && totalPhases > 1 && mergedPRs.length > 0) {
    try {
      const lastMergedPR = mergedPRs[mergedPRs.length - 1];
      await validateAndUpdatePlan(
        repo,
        issue,
        plan,
        planEntry.id,
        planEntry.body,
        mergedPRs.length,
        lastMergedPR,
      );
    } catch (err) {
      log.warn(`[issue-worker] Plan validation failed for ${fullName}#${issue.number}: ${err}`);
    }
  }

  // Circuit breaker: stop re-labeling if recent attempts produced no commits
  const noCommitCount = db.countRecentNoCommitCompletions(fullName, issue.number);
  if (noCommitCount >= MAX_NO_COMMIT_RETRIES) {
    await postStuckComment(fullName, issue, comments, mergedPRs.length + 1, totalPhases, noCommitCount);
    log.warn(`[issue-worker] Phase ${mergedPRs.length + 1}/${totalPhases} stuck — ${noCommitCount} no-commit completions, not re-labeling`);
    return;
  }

  // More phases needed — re-label as Refined to trigger next PR
  log.info(`[issue-worker] PR merged, advancing to phase ${mergedPRs.length + 1}/${totalPhases} for ${fullName}#${issue.number}`);
  await gh.addLabel(fullName, issue.number, LABELS.refined);
}

