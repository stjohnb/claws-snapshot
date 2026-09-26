import { ISSUE_REF_GUARDED, type CommentRef, type IssueRef } from "../issue-id.js";
import os from "node:os";
import { LABELS, HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import type { TaskOutcome } from "../db.js";
import { AGENT_KINDS } from "../worker.js";
import { buildSuccessOutcome, buildSuccessOutcomeSince } from "../outcome.js";
import { getItemTimeoutMs } from "../timeout-handler.js";
import { processTextForImages } from "../images.js";
import * as planParser from "../plan-parser.js";
import type { Provider } from "../plan-parser.js";
import { PLAN_HEADER, isPlanStaleForIssue, parsePlanBodyHash, selectFeedbackCandidates, findUnreactedHumanComments, stripRefinedForPendingFeedback } from "./issue-refiner.js";
import { isRequirementsComment } from "../marker-text.js";
import { KUBECTL_CONTEXT, FAST_CHECKS_GUIDANCE, RUNNER_POLICY_CONTEXT, HOST_EXECUTION_POLICY, REPO_DOCS_CONTEXT, NO_STACKED_PRS_POLICY, SHOPPING_MANIFEST_CONTEXT, frontendContext, loggingContext, forgeContext, homeAssistantContext, formatIssueCommentsForPrompt, loadRepoAgentDoc } from "./agent-context.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { isPhaseClaimOnly, type PhaseCoverage } from "../phase-coverage.js";
import { alignPlanWithEntries, issueHasShippedWork, loadIssuePhaseState, peekTotalPhases } from "../planned-prs.js";
import { isHomeAssistantConfigRepo, homeAssistantMcpAvailable } from "../home-assistant.js";
import { resolveModelPlanCell } from "../model-plan.js";
import { approvedRequirementsOrNull, approvedRequirementsSection, loadApprovedRequirements, type ApprovedRequirements } from "../approved-requirements.js";
import { getRepoConfigState, isRepoMonitored } from "../repo-config.js";

const MAX_NO_COMMIT_RETRIES = 3;

/** Tells the implementer the plan deliberately stops at file/module altitude (#3043). */
const PLAN_ALTITUDE_NOTE = [
  `This implementation plan is written at file/module level. It names the files, functions`,
  `and behaviour changes but deliberately leaves line-level navigation to you. Read the code`,
  `to locate the exact edits, and add or update test files the plan implies even if it does`,
  `not list them. Do not redesign the plan's approach.`,
].join("\n");

/** Keeps the product requirements layer current in the same PR as the change (#3082). */
const PRODUCT_REQUIREMENT_UPDATE_NOTE =
  `If the repo has \`docs/PRODUCT.md\` and the plan says this issue introduces or changes a product requirement, update the matching area doc under \`docs/product/\` (or \`docs/PRODUCT.md\` if the repo keeps requirements inline) in the same PR: one \`###\` heading phrased as a constraint, followed by a \`**Why:**\` line.`;

function addStagingPrMarker(body: string): string {
  return `${body}\n\n${gh.CLAWS_STAGING_PR_MARKER}`;
}

/**
 * Marks the "issue edited after the plan was written" notice. Posted as
 * `CLAWS_STALE_PLAN_NOTICE: <plan hash>` so one notice is posted per stale plan
 * revision — a re-plan edits the plan comment in place, so the previous notice
 * must not suppress the notice for a later, independent staleness event.
 * Must NOT contain PLAN_HEADER — plan lookup takes the LAST comment containing
 * it, so a second such comment would hijack every downstream lookup.
 */
export const STALE_PLAN_MARKER = "CLAWS_STALE_PLAN_NOTICE";

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
  startSha: string | null,
): Promise<void> {
  const marker = `no-commit:${currentPhase}`;
  if (hasMarker(comments, "no-commit", currentPhase)) return;

  const diagnosis = await (startSha ? claude.diagnoseNoCommitsSince(wtPath, startSha) : claude.diagnoseNoCommits(wtPath, defaultBranch)).catch((err) => {
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

/**
 * Explain, once per step, that a plan step is planned in a repo Claws does not
 * manage. Posted both by `processIssue` (stripping `Refined`) and by
 * `checkAndContinue` (holding it back), so a step reached either way is not
 * left without a word on the issue.
 */
async function postUnmanagedStepComment(
  fullName: string,
  issue: gh.Issue,
  comments: gh.IssueComment[],
  phase: number,
  totalPhases: number,
  entry: { repo: string; title: string },
): Promise<void> {
  if (hasMarker(comments, "planned-unmanaged", phase)) return;
  // The planner's title can be steered by issue text. Keep PLAN_HEADER out of
  // it so this comment cannot hijack plan lookup.
  const title = entry.title.replaceAll(PLAN_HEADER, "Implementation plan");
  await gh.commentOnIssue(fullName, issue.number, [
    `PR ${phase} of ${totalPhases} of the plan above ("${title}") is planned in \`${entry.repo}\`, which Claws does not manage, so Claws cannot implement it.`,
    ``,
    `Claws has removed or withheld the \`${LABELS.refined}\` label. Either bring \`${entry.repo}\` under Claws management, or ask for a re-plan that puts this PR in a managed repository, then re-apply \`${LABELS.refined}\`.`,
    ``,
    `planned-unmanaged:${phase}`,
  ].join("\n"), { agentName: "Implementer" });
}

/**
 * Explain, once, why an open issue is not being implemented: every phase of its
 * plan is already covered. Purely operator-facing — the dispatcher decides
 * whether to auto-refine from the same coverage state, not from this comment.
 * The body must NOT contain PLAN_HEADER: plan lookup takes the LAST comment
 * containing it, so a notice carrying it would hijack every downstream lookup.
 */
async function postAllPhasesCoveredComment(
  fullName: string,
  issue: gh.Issue,
  comments: gh.IssueComment[],
  totalPhases: number,
  coverage: PhaseCoverage,
): Promise<void> {
  if (hasMarker(comments, "CLAWS_ALL_PHASES_COVERED", totalPhases)) return;

  const coveredLines = [...coverage.covered].sort((a, b) => a - b).map((n) => {
    const pr = coverage.coveringPRs.get(n);
    return pr ? `- Step ${n} — #${pr.number}` : `- Step ${n} — claimed via \`claws-phase-done:\``;
  });

  const mismatchLines = coverage.markerMismatches.length > 0
    ? [
        ``,
        `**Phase-count mismatch**`,
        ``,
        // A merged PR's title is attacker-controllable (markers are honoured from any
        // PR author), so neutralise PLAN_HEADER in it — otherwise a title carrying
        // that literal turns this notice into the LAST comment containing it, and
        // every downstream plan lookup reads this notice as the plan.
        ...coverage.markerMismatches.map((m) =>
          `merged PR #${m.number} (\`${m.title.replaceAll(PLAN_HEADER, "Implementation plan")}\`) is marked as phase ${m.phase} of ${m.markerTotal}, but the plan above now has only ${totalPhases} step${totalPhases === 1 ? "" : "s"} — a re-plan appears to have dropped the plan's \`### PR N:\` headers, so phases that have already shipped no longer line up with the plan. Restore the \`### PR N:\` headers (original count: ${m.markerTotal}) in the plan comment above, then re-apply \`${LABELS.refined}\`.`),
      ]
    : [];

  const body = [
    `## All plan phases are already covered`,
    ``,
    `Every one of the ${totalPhases} step${totalPhases === 1 ? "" : "s"} in the plan above is already covered by a pull request or an explicit claim, so there is nothing left to implement.`,
    ``,
    ...coveredLines,
    ...mismatchLines,
    ``,
    `Claws has removed \`${LABELS.refined}\` and applied \`${LABELS.ready}\`, and will not re-apply \`${LABELS.refined}\` automatically while the plan above stays fully covered. If work remains, edit or replace the plan comment above so it describes the remaining steps; otherwise close this issue.`,
    ``,
    `CLAWS_ALL_PHASES_COVERED:${totalPhases}`,
  ].join("\n");

  await gh.commentOnIssue(fullName, issue.number, body, { agentName: "Implementer" });
}

/**
 * Comments to show the implementer. With an approved record, the
 * requirements writer's own `## Requirements` comment is dropped — it renders
 * with a literal `### Requirement` heading, and a refine run keeps editing it
 * in place to the latest version whether or not that version is approved, so
 * showing it risks the implementer working from an unapproved draft instead
 * of the approved record already rendered above.
 */
function implementerComments(comments: readonly gh.IssueComment[], requirements: ApprovedRequirements | null): gh.IssueComment[] {
  return requirements ? comments.filter((c) => !isRequirementsComment(c.body)) : [...comments];
}

function buildPrompt(
  repo: Repo,
  issue: gh.Issue,
  plan: planParser.ParsedPlan | null,
  currentPhase: number,
  totalPhases: number,
  selfLogin: string,
  coverage: PhaseCoverage,
  comments: gh.IssueComment[],
  imageContext: string,
  wtPath: string,
  targetPR: gh.PR | null,
  /** The issue's approved requirements record; its acceptance criteria are checked before finishing. */
  requirements: ApprovedRequirements | null = null,
): string {
  const fullName = repo.fullName;
  const guardCtx = makeGuardCtx(fullName, issue.number);
  // Target-PR mode (#2720): the worktree is already checked out on an open PR's
  // head branch, and Claws pushes it afterwards so that PR picks the commits up.
  const targetPRLines = targetPR
    ? [`You are working directly on branch \`${targetPR.headRefName}\`, which is the head of open pull request #${targetPR.number} in this repository (base: \`${repo.defaultBranch}\`). Commit your changes onto this branch. Do NOT create a new branch, do NOT open a new pull request, and do NOT change any PR's base branch — Claws will push this branch so PR #${targetPR.number} picks the commits up.`]
    : [];
  if (totalPhases === 1 || !plan || !plan.phases[currentPhase - 1]) {
    return [
      `You are working on a GitHub issue for the repository ${fullName}.`,
      `Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
      ``,
      guardContent(issue.body, guardCtx("issue-body")),
      ``,
      ...(requirements ? [approvedRequirementsSection(requirements, "implementer", guardCtx), ``] : []),
      ...formatIssueCommentsForPrompt(implementerComments(comments, requirements), selfLogin, guardCtx),
      REPO_DOCS_CONTEXT,
      KUBECTL_CONTEXT,
      FAST_CHECKS_GUIDANCE,
      RUNNER_POLICY_CONTEXT,
      HOST_EXECUTION_POLICY,
      NO_STACKED_PRS_POLICY,
      SHOPPING_MANIFEST_CONTEXT,
      frontendContext(wtPath),
      loggingContext(wtPath),
      forgeContext(repo),
      ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
      ``,
      ...(plan ? [PLAN_ALTITUDE_NOTE, PRODUCT_REQUIREMENT_UPDATE_NOTE, ``] : []),
      `Please implement the changes needed to resolve this issue.`,
      `Make commits with clear messages as you work.`,
      `Do NOT create a pull request or push your branch — that is handled automatically after you finish.`,
      ...targetPRLines,
      imageContext,
    ].join("\n");
  }

  const phase = plan.phases[currentPhase - 1];
  // Phases before the current one are context ("here is what already shipped");
  // phases *after* it may also be covered — by a PR a human or an interactive
  // session opened out-of-band — and must be called out as off-limits (#2594).
  const completedLines = [...coverage.covered]
    .filter((n) => n < currentPhase)
    .sort((a, b) => a - b)
    .map((n) => {
      const pr = coverage.coveringPRs.get(n);
      return pr
        ? `- Phase ${n}: PR #${pr.number} (${pr.state}) — ${guardContent(pr.title, guardCtx("pr-title"))}`
        : `- Phase ${n}: claimed complete`;
    });
  const aheadLines = [...coverage.covered]
    .filter((n) => n > currentPhase)
    .sort((a, b) => a - b)
    .map((n) => {
      const pr = coverage.coveringPRs.get(n);
      return pr
        ? `- Phase ${n}: PR #${pr.number} (${pr.state}) — ${guardContent(pr.title, guardCtx("pr-title"))}`
        : `- Phase ${n}: claimed complete`;
    });
  return [
    `You are working on PR ${currentPhase} of ${totalPhases} for issue #${issue.number} in ${fullName}.`,
    `Issue: ${guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    ...(requirements ? [approvedRequirementsSection(requirements, "implementer", guardCtx), ``] : []),
    REPO_DOCS_CONTEXT,
    KUBECTL_CONTEXT,
    FAST_CHECKS_GUIDANCE,
    RUNNER_POLICY_CONTEXT,
    HOST_EXECUTION_POLICY,
    NO_STACKED_PRS_POLICY,
    SHOPPING_MANIFEST_CONTEXT,
    frontendContext(wtPath),
    loggingContext(wtPath),
    forgeContext(repo),
    ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
    ``,
    `## Full Plan`,
    // Plan content is self-authored by Claws (extracted from Claws' own plan comments) —
    // guarding it produces false positives when plans discuss security topics or patterns.
    plan.preamble,
    ...plan.phases.map((p) => `### PR ${p.phaseNumber}: ${p.title}\n${p.description}`),
    ``,
    `## Already Completed`,
    completedLines.length > 0
      ? completedLines.join("\n")
      : `None yet — this is the first PR.`,
    ``,
    ...(aheadLines.length > 0
      ? [`## Already covered by an existing PR — do NOT implement`, aheadLines.join("\n"), ``]
      : []),
    PLAN_ALTITUDE_NOTE,
    PRODUCT_REQUIREMENT_UPDATE_NOTE,
    ``,
    `## Your Task`,
    `Implement ONLY the changes for PR ${currentPhase}: ${phase.title}`,
    ``,
    phase.description,
    ``,
    `Do NOT implement changes from other phases.`,
    `Make commits with clear messages as you work.`,
    `Do NOT create a pull request or push your branch — that is handled automatically after you finish.`,
    ...targetPRLines,
    imageContext,
  ].join("\n");
}

async function postPhaseProgressComment(
  fullName: string,
  issue: gh.Issue,
  comments: gh.IssueComment[],
  coverage: PhaseCoverage,
  currentPhase: number,
  totalPhases: number,
): Promise<void> {
  try {
    const coveredCount = coverage.covered.size;
    const marker = `phase-progress:${coveredCount}`;

    // Dedup: skip if a comment with this marker already exists
    if (hasMarker(comments, "phase-progress", coveredCount)) {
      log.info(`[issue-worker] Progress comment already posted for ${coveredCount} covered phase(s), skipping`);
      return;
    }

    const gctx = makeGuardCtx(fullName, issue.number);
    const describe = (n: number): string => {
      const pr = coverage.coveringPRs.get(n);
      return pr
        ? `- Phase ${n}: PR #${pr.number} (${pr.state}) — ${guardContent(pr.title, gctx("pr-title"))}`
        : `- Phase ${n}: claimed complete`;
    };
    const doneList = [...coverage.done].sort((a, b) => a - b).map(describe);
    // Phases whose PR is open — a sibling step of a parallel plan, still in review.
    const inFlight = coverage.openPhases.map(describe);

    const body = [
      `## Phase Progress`,
      ``,
      `**Completed (${doneList.length}/${totalPhases}):**`,
      ...doneList,
      ``,
      ...(inFlight.length > 0 ? [`**In flight:**`, ...inFlight, ``] : []),
      `**Next:** PR ${currentPhase}/${totalPhases}`,
      ``,
      "To mark plan steps as already handled outside this pipeline, comment on this issue with `claws-phase-done: <numbers>` (comma list or range). The implementer will skip those steps.",
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
    return `fix: ${subject}`;
  }
  const phase = plan.phases[currentPhase - 1];
  return `fix: ${phase.title} (${currentPhase}/${totalPhases})`;
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
  // since buildPRTitle prepends "fix: " itself.
  const title = m[1].trim().replace(/^(?:fix|feat|chore|refactor|docs|test|perf|build|ci)(?:\([^)]*\))?:\s*/i, "").trim();
  return { body, title: title || null };
}

/** True when a manual-action note is pure verification/observation — "verify the alert fires",
 * "monitor the dashboard after deploy". These are not required steps: nothing is blocked on them
 * and nobody performs them, so they are dropped rather than surfaced (#2644). A note that opens
 * with a verification verb but carries a real follow-on action ("verify X, then rotate the token")
 * is kept. */
export function isVerificationOnlyAction(note: string): boolean {
  const text = note.trim().replace(/^[-*\s]+/, "");
  const opener = /^(?:(?:please|manually|someone (?:should|must)|you (?:should|must|will need to))\s+)*(?:verify|confirm|check|double[-\s]check|sanity[-\s]check|monitor|observe|watch|validate|test|review|keep an eye)\b/i;
  if (!opener.test(text)) return false;
  const tail = text.split(/\b(?:then|afterwards|after that)\b/i).slice(1).join(" ");
  return !/\b(?:set|rotate|create|add|remove|delete|provision|publish|deploy|dispatch|trigger|run|apply|configure|grant|revoke|upload|install|enable|disable|migrate|register|restart|import|generate|scale|invite|renew|approve)\b/i.test(tail);
}

/** Strip a trailing `MANUAL-ACTION(-BEFORE-MERGE|-AFTER-MERGE): …` marker line from a
 * generated PR description. Returns the cleaned body, the captured reason (null if no
 * marker), and the timing — a bare legacy `MANUAL-ACTION:` marker is treated as
 * "before" to preserve today's blocking behaviour. A note that is pure verification/
 * observation (see `isVerificationOnlyAction`) is dropped rather than surfaced (#2644). */
export function extractManualActionMarker(
  description: string,
): { body: string; manualAction: string | null; timing: "before" | "after" } {
  const m = description.match(/^[ \t]*MANUAL-ACTION(-BEFORE-MERGE|-AFTER-MERGE)?:[ \t]*(.+?)[ \t]*$/im);
  if (!m) return { body: description, manualAction: null, timing: "before" };
  const body = description.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim();
  const timing = m[1]?.toUpperCase() === "-AFTER-MERGE" ? "after" : "before";
  const note = m[2].trim();
  if (isVerificationOnlyAction(note)) {
    log.info(`[issue-worker] Dropped verification-only manual action: ${note}`);
    return { body, manualAction: null, timing };
  }
  return { body, manualAction: note, timing };
}

export const MANUAL_ACTION_HEADING = "## ⚠️ Manual action required before merge";
export const POST_MERGE_ACTION_HEADING = "## 📋 Manual action required after merge";

function sliceSection(body: string, heading: string): string | null {
  const idx = body.indexOf(heading);
  if (idx === -1) return null;
  const rest = body.slice(idx);
  const nextHeading = rest.indexOf("\n## ", heading.length);
  const reviewModel = rest.search(/\n\nreview-model:/i);
  const ends = [nextHeading, reviewModel].filter((n) => n !== -1);
  const end = ends.length ? Math.min(...ends) : -1;
  return (end === -1 ? rest : rest.slice(0, end)).trimEnd();
}

/** Extract the pre-merge manual-action section (heading + note) from a PR body, if
 * present. Used to carry the section forward when other jobs (review-addresser,
 * ci-fixer) regenerate the PR body from scratch, which would otherwise silently
 * drop it. */
export function extractManualActionSection(body: string): string | null {
  return sliceSection(body, MANUAL_ACTION_HEADING);
}

/** Extract the post-merge manual-action section (heading + note) from a PR body, if
 * present. Never blocks merge; announced by auto-merger at merge time. */
export function extractPostMergeActionSection(body: string): string | null {
  return sliceSection(body, POST_MERGE_ACTION_HEADING);
}

/**
 * Regenerate a PR's description from the branch diff and write it back, carrying
 * forward the four parts of the old body that the LLM does not reproduce: a
 * "## PR n of m:" phase header, a "Closes/Part of #n" line, the pre-merge
 * manual-action section, and the post-merge manual-action section. Shared by
 * ci-fixer and review-addresser (see #2294) — a change to the regexes or the
 * reassembly order must stay in one place.
 *
 * Never throws: a failed regeneration leaves the existing body untouched and is
 * logged as a warning, because the push it follows has already succeeded.
 * `logPrefix` is the caller's bracketed tag, e.g. "[ci-fixer]".
 */
/**
 * The closing line {@link regenerateAndUpdatePRBody} carries over verbatim.
 *
 * Guarded rather than `#\d+`: a native issue's PR says `Closes #clw_01JBQ…`,
 * and dropping that line on the first CI-fix or review-address round would
 * leave the issue open forever with nothing to close it (#3215).
 */
const CLOSING_SUFFIX_RE = new RegExp(`\\b(Closes|Part of)\\s+#${ISSUE_REF_GUARDED}`, "i");

export async function regenerateAndUpdatePRBody(
  wtPath: string,
  fullName: string,
  pr: gh.PR,
  model: string,
  actualProvider: Provider,
  attributionVerb: string,
  logPrefix: string,
  providerNote = "",
): Promise<void> {
  try {
    const attribution = `*— ${attributionVerb}: ${model} (provider: ${actualProvider}${providerNote}) —*`;
    const [description, currentBody] = await Promise.all([
      claude.regeneratePRDescription(wtPath, pr.baseRefName, pr, fullName, attribution),
      gh.getPRBody(fullName, pr.number),
    ]);
    const closingMatch = currentBody.match(CLOSING_SUFFIX_RE);
    const phaseHeaderMatch = currentBody.match(/^##\s+PR\s+\d+\s+of\s+\d+\s*:.*$/m);
    const manualActionSection = extractManualActionSection(currentBody);
    const postMergeSection = extractPostMergeActionSection(currentBody);
    const prefix = phaseHeaderMatch ? `${phaseHeaderMatch[0]}\n\n` : "";
    const suffix = closingMatch ? `\n\n${closingMatch[0]}` : "";
    const manualActionSuffix = manualActionSection ? `\n\n${manualActionSection}` : "";
    const postMergeSuffix = postMergeSection ? `\n\n${postMergeSection}` : "";
    await gh.updatePR(fullName, pr.number, `${prefix}${description}${suffix}${manualActionSuffix}${postMergeSuffix}`);
  } catch (descErr) {
    log.warn(`${logPrefix} Failed to update PR description for ${fullName}#${pr.number}: ${descErr}`);
  }
}

/** Strip GitHub closing keywords (e.g. "closes #123") from LLM-generated text
 * to prevent GitHub from auto-closing an unrelated issue when the PR merges. */
function stripClosingKeywords(text: string): string {
  return text.replace(
    new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${ISSUE_REF_GUARDED}(?:\\s*\\(PR \\d+ of \\d+\\))?`, "gi"),
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
  duplicateIssueNumbers: IssueRef[] = [],
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

  const preComments = await gh.getIssueComments(fullName, issue.number);

  // Guard: skip if an open PR already exists for a single-PR plan. A multi-PR
  // plan falls through — sibling steps may run in parallel, and readiness below
  // decides whether another step can start while this PR is open.
  const existingPR = await gh.getOpenPRForIssue(fullName, issue.number);
  if (existingPR && (await peekTotalPhases(fullName, issue.number, planParser.findPlanComment(preComments))).totalPhases <= 1) {
    log.info(`[issue-worker] Skipping ${fullName}#${issue.number} — open PR #${existingPR.number} already exists`);
    await gh.removeLabel(fullName, issue.number, LABELS.refined);
    return;
  }

  // The approved requirements record, when the issue has one: read once, for the
  // stale-plan guard below and for the acceptance criteria the prompt carries.
  // A failed read is reported as "error", never silently folded into "no
  // record" — that used to make a database hiccup look like a real change and
  // strip a human-applied Refined for no reason (see the stale-check guard).
  const approvedRequirementsResult = await loadApprovedRequirements(fullName, issue.number);
  const approvedRequirements = approvedRequirementsOrNull(approvedRequirementsResult);

  // Guard: the issue (or its approved requirements) changed after its plan was
  // written, so implementing the plan would contradict the issue. Catches a human
  // applying `Refined` to an already-stale plan, which is how #2524 played out.
  // Skipped entirely when the requirements read errored — a stale-looking hash
  // built from `null` would be a false positive against a plan actually stamped
  // with the record, same as `live` being unreadable already skips the check.
  const planIdx = preComments.findLastIndex((c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body));
  if (planIdx !== -1) {
    const live = approvedRequirementsResult.status === "error" ? null : await gh.getIssueTitleBody(fullName, issue.number).catch(() => null);
    if (live && isPlanStaleForIssue(preComments[planIdx].body, live.title, live.body, approvedRequirements)) {
      // Multi-PR continuations are deliberately not gated: phase 2+ follows a plan
      // that was already agreed and partly shipped, so re-planning mid-way would
      // strand the merged phases. `checkAndContinue` re-applies `Refined` to reach
      // here, so a merged PR — in any of the plan's repos — is the only way to tell
      // the two apart.
      if (await issueHasShippedWork(fullName, issue.number, preComments)) {
        log.info(`[issue-worker] ${fullName}#${issue.number} has a stale plan but merged PR(s) — continuing the agreed plan`);
      } else {
        log.info(`[issue-worker] ${fullName}#${issue.number} or its approved requirements changed after its plan was written — removing ${LABELS.refined} and leaving it for a re-plan`);
        await gh.removeLabel(fullName, issue.number, LABELS.refined);
        // Key the notice to the hash it was posted for: a re-plan edits the plan
        // comment in place, so a positional "any notice after the plan" check would
        // let the first event's notice silently suppress every later one.
        const notice = `${STALE_PLAN_MARKER}: ${parsePlanBodyHash(preComments[planIdx].body) ?? "unknown"}`;
        if (!preComments.some((c) => c.body.includes(notice))) {
          await gh.commentOnIssue(fullName, issue.number, [
            `This issue, or its approved requirements, changed after the implementation plan above was written, so the plan no longer matches the issue.`,
            ``,
            `Claws has removed the \`${LABELS.refined}\` label; the planner will produce an updated plan on the next dispatcher tick. Re-apply \`${LABELS.refined}\` once that plan looks right.`,
            ``,
            notice,
          ].join("\n"), { agentName: "Implementer" });
        }
        return;
      }
    }

    // Unaddressed human feedback after the plan: the dispatcher normally strips
    // `Refined` first, but the comment can land between enqueue and run, and
    // `checkAndContinue` re-applies `Refined` on its own. Stop and let the planner
    // respond (#2772). Deliberately not exempted for multi-PR continuations: an
    // unanswered comment invalidates the remaining phases too, and the dispatcher's
    // Phase 2 re-plans and re-applies `Ready` afterwards.
    const selfLogin = await gh.getSelfLoginForIssue(fullName, issue.number);
    // A `claws-phase-done:` claim is coverage information for the implementer, not
    // feedback on the plan — exclude it so multi-PR continuations aren't blocked
    // by their own progress-tracking comments.
    const pending = (await findUnreactedHumanComments(
      fullName, selectFeedbackCandidates(preComments, planIdx), selfLogin, issue.number,
    )).filter((c) => !isPhaseClaimOnly(c.body));
    if (pending.length > 0) {
      log.info(`[issue-worker] ${fullName}#${issue.number} has ${pending.length} unaddressed human comment(s) after the plan — removing ${LABELS.refined}`);
      await stripRefinedForPendingFeedback(fullName, issue.number, pending, "Implementer");
      return;
    }
  }

  await gh.removeLabel(fullName, issue.number, LABELS.ready);

  await db.withTaskRecording("issue-worker", fullName, issue.number, LABELS.refined, async (taskId) => {
    // 1. Read plan from issue comments (already fetched for the stale-plan guard above)
    const comments = preComments;
    const planText = planParser.findPlanComment(comments);

    // 2. Determine current phase from the covered-phase set, not just Claws'
    // own merged PRs — a step shipped out-of-band by a human or an interactive
    // session counts too, or the pipeline re-implements it (#2594). A stored PR
    // list (claws_issue_prs) is authoritative for the count and titles.
    const mergedPRs = await gh.listMergedPRsForIssue(fullName, issue.number);
    const { totalPhases, coverage, entries, trackerId } = await loadIssuePhaseState(fullName, issue.number, comments, { planText, mergedPRs });
    const plan = alignPlanWithEntries(planText ? planParser.parsePlan(planText) : null, entries);
    // Record the PR Claws opened (or pushed onto) against its stored entry.
    // Best-effort: an unlinked entry still resolves through its markers.
    const linkPlannedPR = async (position: number, prNumber: number): Promise<void> => {
      if (!entries || !trackerId) return;
      try {
        await db.linkIssuePlannedPR(trackerId, position, prNumber);
      } catch (err) {
        log.warn(`[issue-worker] Could not link PR #${prNumber} to step ${position} of ${fullName}#${issue.number}: ${err}`);
      }
    };
    // The lowest step whose dependencies have all landed. Sibling steps' PRs may
    // still be open when the plan declares them independent.
    const currentPhase = coverage.readyPhases[0] ?? null;

    // Guard: every plan phase is already covered by a PR or an explicit claim
    if (coverage.nextPhase === null) {
      const coveredBy = [...coverage.covered].sort((a, b) => a - b)
        .map((n) => `${n}:${coverage.coveringPRs.get(n) ? `#${coverage.coveringPRs.get(n)!.number}` : "claimed"}`)
        .join(", ");
      log.info(`[issue-worker] All ${totalPhases} phases already covered for ${fullName}#${issue.number} (${coveredBy}), removing Refined label`);
      if (coverage.markerMismatches.length > 0) {
        const mismatched = coverage.markerMismatches.map((m) => `#${m.number} (marked ${m.phase}/${m.markerTotal})`).join(", ");
        log.warn(`[issue-worker] ${fullName}#${issue.number}: merged PR(s) ${mismatched} outnumber the plan's ${totalPhases} step(s) — a re-plan likely dropped the plan's \`### PR N:\` headers`);
      }
      try {
        // Say once, on the issue, why nothing is happening — otherwise the only
        // trace of this terminal state is a label vanishing seconds after it
        // was applied (#2821). `Refined` is removed last: if the comment or
        // `Ready` add fails partway, leaving `Refined` in place means the
        // dispatcher re-enqueues this worker to retry, instead of the issue
        // silently ending up with neither label (#2821).
        await postAllPhasesCoveredComment(fullName, issue, comments, totalPhases, coverage);
        await gh.addLabel(fullName, issue.number, LABELS.ready);
        await gh.removeLabel(fullName, issue.number, LABELS.refined);
      } finally {
        await db.recordTaskComplete(taskId, { commits: 0 });
      }
      return;
    }

    // Guard: no uncovered phase is ready — each depends on a phase whose PR has
    // not merged yet. The worktree would branch off `origin/<default>`, which
    // does not contain that phase's changes, so wait for it to land instead of
    // building on a base that is missing a prerequisite (#2594).
    if (currentPhase === null) {
      log.info(`[issue-worker] No phase of ${fullName}#${issue.number} is ready — open: ${coverage.openPhases.join(", ") || "none"}, blocked: ${coverage.blockedPhases.join(", ") || "none"} — removing Refined label until their dependencies land`);
      try {
        await gh.removeLabel(fullName, issue.number, LABELS.refined);
      } finally {
        await db.recordTaskComplete(taskId, { commits: 0 });
      }
      return;
    }

    // `done`, not `covered`: a phase covered only by a still-open PR — a
    // sibling running in parallel, or one ahead of this — is not finished work.
    // Treating it as finished would put `Closes #<issue>` in this PR's body, and
    // merging it would auto-close the issue while that PR is still in flight
    // (#2594). The auto-merger closes the issue when a later merge completes it.
    const isLastPhase = !Array.from({ length: totalPhases }, (_, i) => i + 1)
      .some((n) => n !== currentPhase && !coverage.done.has(n));

    // Two repo roles from here on. The issue repo (`repo`/`fullName`) keeps the
    // issue's comments and labels; the PR repo is where this step's worktree,
    // push and PR live. They differ only for a multi-repo native issue whose
    // current stored entry names another of its repos — the worker stays
    // enqueued under the primary repo either way.
    const entry = entries?.[currentPhase - 1] ?? null;
    // Not caught: `resolvePhaseRepo` throws when the listing can't be trusted,
    // and the work item retries rather than stripping `Refined`.
    const prRepo = await resolvePhaseRepo(repo, entry?.repo);
    if (prRepo === "unmanaged") {
      log.warn(`[issue-worker] Phase ${currentPhase}/${totalPhases} for ${fullName}#${issue.number} is planned in ${entry!.repo}, which Claws does not manage — removing ${LABELS.refined}`);
      try {
        await postUnmanagedStepComment(fullName, issue, comments, currentPhase, totalPhases, entry!);
        await gh.removeLabel(fullName, issue.number, LABELS.refined);
      } finally {
        // No `commits` field: the implementer never ran, so this exit must not
        // count towards the no-commit circuit breaker.
        await db.recordTaskComplete(taskId, {});
      }
      return;
    }
    if (prRepo !== repo) log.info(`[issue-worker] Phase ${currentPhase}/${totalPhases} for ${fullName}#${issue.number} is implemented in ${prRepo.fullName}`);
    const prFullName = prRepo.fullName;

    // Target-PR mode (#2720): the plan may direct this work onto an already-open
    // PR's branch rather than a new PR, for changes that only make sense on top
    // of that PR's diff. Every rejection below deliberately falls through to the
    // normal path — a PR against the default branch is an acceptable outcome.
    let targetPR: gh.PR | null = null;
    const targetPRNumber = planText ? planParser.getTargetPR(planText) : null;
    if (targetPRNumber !== null) {
      const reject = (why: string) =>
        log.warn(`[issue-worker] Ignoring CLAWS_TARGET_PR #${targetPRNumber} for ${fullName}#${issue.number}: ${why} — opening a normal PR against ${prRepo.defaultBranch}`);
      if (totalPhases > 1) reject("plan has multiple phases");
      else {
        const candidate = (await gh.listPRs(prFullName).catch(() => [] as gh.PR[]))
          .find((p) => p.number === targetPRNumber) ?? null;
        if (!candidate) reject("PR is not open");
        else if (gh.isForkPR(candidate)) reject("PR is from a fork");
        else if (!candidate.headRefName.startsWith("claws/")) reject(`head branch ${candidate.headRefName} is not a claws branch`);
        else if (candidate.baseRefName !== prRepo.defaultBranch) reject(`PR base ${candidate.baseRefName} is not ${prRepo.defaultBranch}`);
        // Another agent pushing to the same branch concurrently would race this
        // one's rebase-and-push (the work_queue UNIQUE index does not cover it —
        // that queue entry is keyed by PR number, this one by issue number).
        else if (await db.hasActiveWorkForPR(prFullName, candidate.number, [AGENT_KINDS.CI_FIXER, AGENT_KINDS.CI_FIXER_CONFLICT, AGENT_KINDS.REVIEW_ADDRESSER, AGENT_KINDS.PR_REVIEWER])) reject("another agent is actively pushing to that PR's branch");
        else targetPR = candidate;
      }
    }

    const branchName = targetPR
      ? targetPR.headRefName
      : `claws/issue-${issue.number}-${claude.randomSuffix()}`;

    const runInWorktree = async (wtPath: string): Promise<true> => {
      await db.updateTaskWorktree(taskId, wtPath, branchName);
      // In target-PR mode the branch is already ahead of the default branch, so
      // `hasNewCommits` would report success even when the agent produced nothing.
      const startSha = targetPR ? await claude.getHeadSha(wtPath) : null;

      log.info(`[issue-worker] Phase ${currentPhase}/${totalPhases} for ${fullName}#${issue.number}`);

      // Post a progress comment summarizing completed phases (preserves original plan)
      if (currentPhase > 1 && plan) {
        await postPhaseProgressComment(fullName, issue, comments, coverage, currentPhase, totalPhases);
      }

      const selfLogin = await gh.getSelfLoginForIssue(repo.fullName, issue.number);
      const imageContext = await processTextForImages([issue.body, ...comments.map((c) => c.body)], wtPath, repo, { repo: fullName, issueNumber: issue.number, agentName: "Implementer" });

      // 3. Build phase-aware prompt
      const prompt = buildPrompt(prRepo, issue, plan, currentPhase, totalPhases, selfLogin, coverage, comments, imageContext, wtPath, targetPR, approvedRequirements);

      const timeoutMs = getItemTimeoutMs(fullName, issue.number);
      const recommendedModel = planText ? planParser.getRecommendedModel(planText) : null;
      // The issue's model plan (docs/model-selection.md) outranks the plan prose,
      // which in turn outranks the `sonnet` default.
      const { provider, strictProvider, eligibleProviders, overrideIgnoredReason, tier, model } = await resolveModelPlanCell(fullName, issue.number, "implement", {
        tier: recommendedModel ?? undefined,
        labels: issue.labels,
        requiresMcp: homeAssistantMcpAvailable(prFullName),
      });
      if (overrideIgnoredReason) log.warn(`[issue-worker] ${fullName}#${issue.number}: ${overrideIgnoredReason}`);
      const providerNote = overrideIgnoredReason ? `; ${overrideIgnoredReason}` : "";
      const mcpConfigPath = claude.writeAgentMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(prFullName) });
      const agentDoc = loadRepoAgentDoc(wtPath, prFullName, "issue-implementer");
      if (recommendedModel) {
        log.info(`[issue-worker] Plan recommends model "${recommendedModel}" for ${fullName}#${issue.number}`);
      }

      // Track the actual provider used (may differ if provider reselection occurs)
      let actualProvider: Provider = provider;
      let actualModel = model;
      try {
        await claude.runClaude(prompt, wtPath, {
          mcpConfig: mcpConfigPath,
          timeoutMs,
          model,
          tier,
          provider,
          strictProvider,
          eligibleProviders,
          appendSystemPrompt: agentDoc,
          onProviderUsed: (p) => { actualProvider = p; },
          onAttemptModelUsed: (_p, m) => { actualModel = m ?? "default"; },
          onTokensUsed: db.trackTaskTokens(taskId),
          agent: "build",
          captureLabel: "issue-worker",
          githubTokenOwner: prRepo.owner,
          forgejoAccessRepo: prFullName,
        });
      } finally {
        const results = await Promise.allSettled([
          db.updateTaskProvider(taskId, actualProvider),
          db.updateTaskModel(taskId, actualModel),
        ]);
        for (const r of results) {
          if (r.status === "rejected") log.warn(`[issue-worker] Could not persist provider/model for task ${taskId}: ${r.reason}`);
        }
      }

      let outcome: TaskOutcome = { commits: 0 };

      const producedCommits = targetPR
        ? (await claude.getHeadSha(wtPath)) !== startSha
        : await claude.hasNewCommits(wtPath, prRepo.defaultBranch);

      if (producedCommits) {
        await claude.pushBranch(wtPath, branchName, prRepo.owner);

        if (targetPR) {
          // The commits are already on the target PR's branch; link the issue to
          // that PR instead of opening a stacked one. The target PR keeps its own
          // title, and Automerge is deliberately NOT propagated — the PR belongs to
          // another issue and a human still gates it.
          // A failed fetch skips the body edit entirely rather than falling back to
          // "": appending to an empty body would wipe the target PR's description.
          try {
            const existingBody = await gh.getPRBody(prFullName, targetPR.number);
            if (!new RegExp(`(?:closes?|fixes?|resolves?|part of)\\s*#${issue.number}(?![0-9A-Za-z])`, "i").test(existingBody)) {
              await gh.updatePR(prFullName, targetPR.number, `${existingBody}\n\nCloses #${issue.number}`);
            }
          } catch (bodyErr) {
            log.warn(`[issue-worker] Failed to add "Closes #${issue.number}" to ${prFullName}#${targetPR.number}: ${bodyErr}`);
          }
          await gh.commentOnIssue(prFullName, targetPR.number,
            `Pushed the fix for #${issue.number} onto this PR's branch (\`${branchName}\`) rather than opening a stacked PR against it. This PR still targets \`${prRepo.defaultBranch}\`, and #${issue.number} closes when it merges.`,
            { agentName: "Implementer" });
          await gh.commentOnIssue(fullName, issue.number,
            `The fix was committed directly onto PR #${targetPR.number} (branch \`${branchName}\`) — the files it changes exist only on that branch, so a separate PR against \`${prRepo.defaultBranch}\` would have duplicated that PR's whole diff. Track it there.`,
            { agentName: "Implementer" });
          log.info(`[issue-worker] Pushed ${fullName}#${issue.number} onto existing PR ${prFullName}#${targetPR.number} (${branchName})`);
          await linkPlannedPR(currentPhase, targetPR.number);
          if (gh.hasPriorityLabel(issue.labels)) {
            await gh.addLabel(prFullName, targetPR.number, LABELS.priority);
          }
          if (issue.labels.some((l) => l.name === LABELS.clawsStaging)) {
            await gh.addLabel(prFullName, targetPR.number, LABELS.clawsStaging);
            log.info(`[issue-worker] Propagated ${LABELS.clawsStaging} to PR #${targetPR.number} for ${fullName}#${issue.number}`);
          }
          // startSha is always set here: it's populated whenever targetPR is set (line ~562).
          outcome = await buildSuccessOutcomeSince(wtPath, startSha!, targetPR.number, "updated");
        } else {
          // PR descriptions are always generated by the Claude backend, even for
          // Codex-backed tasks — this is intentional (Codex doesn't support JSON output).
          const prAttribution = actualProvider !== provider
            ? `*— Implemented with: ${actualModel} (provider: ${actualProvider}${providerNote}; provider reselected from ${provider} after provider unavailable) —*`
            : `*— Implemented with: ${actualModel} (provider: ${actualProvider}${providerNote}) —*`;
          // generatePRDescription runs in the auxiliary memory lane (short bookkeeping
          // call), but unlike regeneratePRDescription it sits on the required path to
          // opening the PR at all — by this point the implementation commits are already
          // pushed. Degrade to a minimal body on failure rather than throwing, so an
          // AgentMemoryLimitError here can't strand pushed work with no PR ever opened
          // and no strike-count-driven skip of an issue that already succeeded.
          let rawDescription: string;
          try {
            rawDescription = await claude.generatePRDescription(
              wtPath, prRepo.defaultBranch, issue, prFullName, prAttribution,
            );
          } catch (descErr) {
            log.warn(`[issue-worker] Failed to generate PR description for ${fullName}#${issue.number}, falling back to a minimal body: ${descErr}`);
            rawDescription = `## Summary\n\n${issue.title}\n\n---\n${prAttribution}`;
          }
          const { body: afterTitle, title: generatedTitle } = extractTitleMarker(rawDescription);
          const { body: description, manualAction, timing } = extractManualActionMarker(afterTitle);

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
            ? `${rawPRBody}\n\n${timing === "after" ? POST_MERGE_ACTION_HEADING : MANUAL_ACTION_HEADING}\n\n${stripClosingKeywords(manualAction)}`
            : rawPRBody;
          const reviewModelRec = planText ? planParser.getRecommendedReviewModel(planText) : null;
          const prBodyWithoutStagingMarker = reviewModelRec
            ? `${bodyWithNote}\n\nreview-model: ${reviewModelRec}`
            : bodyWithNote;
          const shouldPropagateStaging = issue.labels.some((l) => l.name === LABELS.clawsStaging);
          const prBody = shouldPropagateStaging
            ? addStagingPrMarker(prBodyWithoutStagingMarker)
            : prBodyWithoutStagingMarker;

          const prNumber = await gh.createPR(prFullName, branchName, prTitle, prBody);
          // Defense-in-depth: if Claude disobeyed and created its own PR (which
          // createPR then returns), the title/body may be wrong. The edit is a
          // no-op in the normal path but corrects the PR in the duplicate case.
          try {
            await gh.updatePR(prFullName, prNumber, prBody, prTitle);
          } catch (err) {
            log.warn(`[issue-worker] Failed to update PR #${prNumber} for ${fullName}#${issue.number}: ${err}`);
          }
          log.info(`[issue-worker] Created PR ${prFullName}#${prNumber} (${currentPhase}/${totalPhases}) for ${fullName}#${issue.number}`);
          await linkPlannedPR(currentPhase, prNumber);
          // The row already exists (gh.createPR inserts it); this links the issue.
          try {
            await db.upsertClawsPr(prFullName, prNumber, { issueId: trackerId ?? null, phase: currentPhase });
          } catch (err) {
            log.warn(`[issue-worker] Could not record the issue link on claws_prs for ${prFullName}#${prNumber}: ${err}`);
          }

          // Propagate Priority label to the new PR
          if (gh.hasPriorityLabel(issue.labels)) {
            await gh.addLabel(prFullName, prNumber, LABELS.priority);
          }

          if (shouldPropagateStaging) {
            await gh.addLabel(prFullName, prNumber, LABELS.clawsStaging);
            await gh.updatePR(prFullName, prNumber, prBodyWithoutStagingMarker, prTitle);
            log.info(`[issue-worker] Propagated ${LABELS.clawsStaging} to PR #${prNumber} for ${fullName}#${issue.number}`);
          }

          // Propagate Automerge so auto-merger has the approval it needs to merge
          if (issue.labels.some((l) => l.name === LABELS.automerge)) {
            await gh.addLabel(prFullName, prNumber, LABELS.automerge);
            log.info(`[issue-worker] Propagated ${LABELS.automerge} to PR #${prNumber} for ${fullName}#${issue.number}`);
          }

          if (issue.labels.some((l) => l.name === LABELS.useCodex)) {
            await gh.addLabel(prFullName, prNumber, LABELS.useCodex);
          }

          if (issue.labels.some((l) => l.name === LABELS.useClaude)) {
            await gh.addLabel(prFullName, prNumber, LABELS.useClaude);
          }

          if (issue.labels.some((l) => l.name === LABELS.useOpenCode)) {
            await gh.addLabel(prFullName, prNumber, LABELS.useOpenCode);
          }

          if (manualAction && timing === "before") {
            await gh.addLabel(prFullName, prNumber, LABELS.manualAction);
            log.info(`[issue-worker] Applied ${LABELS.manualAction} to PR #${prNumber} for ${fullName}#${issue.number}: ${manualAction}`);
          } else if (manualAction) {
            log.info(`[issue-worker] PR #${prNumber} for ${fullName}#${issue.number} carries a post-merge manual action (not blocking merge): ${manualAction}`);
          }

          outcome = await buildSuccessOutcome(wtPath, prRepo.defaultBranch, prNumber, "created");
        }
      } else {
        log.warn(`[issue-worker] No commits produced for ${fullName}#${issue.number}`);
        try {
          await postNoCommitComment(fullName, issue, comments, currentPhase, wtPath, prRepo.defaultBranch, startSha);
        } catch (err) {
          log.warn(`[issue-worker] Failed to post no-commit comment for ${fullName}#${issue.number}: ${err}`);
        }
      }

      await gh.removeLabel(fullName, issue.number, LABELS.refined);
      // The task stays under the issue repo; name the PR's repo when it differs
      // so reviewer and merger telemetry can find this task from the PR.
      await db.recordTaskComplete(taskId, prRepo !== repo && outcome.prNumber !== undefined ? { ...outcome, prRepo: prFullName } : outcome);
      return true;
    };

    const ran = targetPR
      ? await claude.withExistingWorktree(prRepo, branchName, "issue-worker", runInWorktree)
      : await claude.withNewWorktree(prRepo, branchName, "issue-worker", runInWorktree);
    if (ran === null) {
      log.warn(`[issue-worker] Target PR ${prFullName}#${targetPR!.number} branch ${branchName} no longer exists for ${fullName}#${issue.number}`);
      try {
        await gh.removeLabel(fullName, issue.number, LABELS.refined);
      } finally {
        await db.recordTaskComplete(taskId, { commits: 0 });
      }
    }
  });
}

async function validateAndUpdatePlan(
  repo: Repo,
  issue: gh.Issue,
  plan: planParser.ParsedPlan,
  planCommentId: CommentRef,
  planCommentBody: string,
  completedPhase: number,
  lastMergedPR: { number: number },
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
    ...plan.phases.map((p) => `### PR ${p.phaseNumber}: ${p.title}${planParser.formatDependencySuffix(p.dependsOn)}\n${p.description}`),
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
    `4. Keeps each header's dependency suffix, such as "(after PR 1)" or "(parallel)"`,
    ``,
    `Output ONLY the updated plan text starting from the preamble, using the exact`,
    `### PR N: Title format. Do not include the "## Implementation Plan" header or`,
    `any explanatory text outside the plan itself.`,
  ].join("\n");

  // Use tmpdir as CWD — validation is prompt-only (no repo access needed).
  // Always use the Claude backend for plan validation — Codex doesn't produce
  // the structured output needed to parse NO_CHANGES_NEEDED vs updated plan text.
  // Plan validation is text-only — produces either NO_CHANGES_NEEDED or an updated plan string.
  const result = await claude.runClaude(prompt, os.tmpdir(), {
    tier: "sonnet",
    provider: "claude",
    agent: "plan",
    noProviderFallback: true,
  });

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
    .replace(/\s*\*\*Recommended implementation model:\*\*\s*`(?:fable|opus|sonnet|haiku|cheap)`/g, "")
    .replace(/\s*\*\*Recommended provider:\*\*\s*`(?:claude|codex|opencode)`/g, "")
    .replace(planParser.MODEL_PLAN_LINE_STRIP, "")
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

/**
 * The repo a plan entry's PR lives in: the issue repo when the entry names it
 * (or there is no entry), another managed repo for a multi-repo issue's step
 * elsewhere, or `"unmanaged"` on a definitive signal only. Shared by
 * `processIssue` and `checkAndContinue` so both agree on which steps Claws
 * can implement.
 *
 * Throws instead of answering `"unmanaged"` when the listing can't be trusted:
 * it failed, came back empty (the issue's own repo is always managed), or is
 * missing an owner whose discovery failed. Stripping `Refined` on a transient
 * error would need a human to undo.
 */
export async function resolvePhaseRepo(repo: Repo, entryRepo: string | undefined): Promise<Repo | "unmanaged"> {
  if (!entryRepo || entryRepo.toLowerCase() === repo.fullName.toLowerCase()) return repo;
  if (getRepoConfigState(entryRepo) === "absent") return "unmanaged";
  const managed = await gh.listRepos();
  if (managed.length === 0) throw new Error(`repo list is empty — cannot tell whether ${entryRepo} is managed`);
  const resolved = managed.find((r) => r.fullName.toLowerCase() === entryRepo.toLowerCase());
  if (resolved) return isRepoMonitored(resolved.fullName) ? resolved : "unmanaged";
  if (gh.isRepoListDegraded()) throw new Error(`repo list is incomplete — cannot tell whether ${entryRepo} is managed`);
  return "unmanaged";
}

export async function checkAndContinue(repo: Repo, issue: gh.Issue): Promise<void> {
  const fullName = repo.fullName;

  // Sibling steps' PRs may still be open: a plan can declare steps that do not
  // depend on each other, and those proceed in parallel. Readiness below
  // decides whether anything can start.
  const comments = await gh.getIssueComments(fullName, issue.number);
  const planEntry = planParser.findPlanCommentEntry(comments);
  const plan = planEntry ? planParser.parsePlan(planEntry.body) : null;

  const mergedPRs = await gh.listMergedPRsForIssue(fullName, issue.number);
  const { totalPhases, coverage, entries } = await loadIssuePhaseState(fullName, issue.number, comments, { planText: planEntry?.body ?? null, mergedPRs });

  // The brake on re-implementing a step someone else already shipped: without
  // this, `Refined` goes back on and the implementer opens a duplicate (#2594).
  if (coverage.nextPhase === null) {
    log.info(`[issue-worker] All ${totalPhases} phases covered for ${fullName}#${issue.number}`);
    return;
  }

  // A step is ready once every step it depends on has landed. With no declared
  // dependencies that is "the previous step merged", so a plan that says
  // nothing waits as before instead of branching the next step off a default
  // branch that lacks its prerequisite (#2594).
  if (coverage.readyPhases.length === 0) {
    log.info(`[issue-worker] Not advancing ${fullName}#${issue.number}: no phase is ready — open: ${coverage.openPhases.join(", ") || "none"}, blocked: ${coverage.blockedPhases.join(", ") || "none"}`);
    return;
  }
  const nextPhase = coverage.readyPhases[0];

  // Validate and update plan if needed before advancing. Only when the plan's
  // headers line up with the phase count: validation must keep that count.
  if (plan && planEntry && totalPhases > 1 && plan.totalPhases === totalPhases && coverage.lastMergedPhase > 0) {
    const lastMergedPR = coverage.coveringPRs.get(coverage.lastMergedPhase);
    // Validation reads the merged PR's diff from the issue repo, so a step that
    // landed in another of a multi-repo issue's repos is not validated.
    const mergedRepo = entries?.[coverage.lastMergedPhase - 1]?.repo ?? fullName;
    if (!lastMergedPR) {
      log.info(`[issue-worker] Phase ${coverage.lastMergedPhase} for ${fullName}#${issue.number} is covered by a claim, not a PR — skipping plan validation`);
    } else if (mergedRepo.toLowerCase() !== fullName.toLowerCase()) {
      log.info(`[issue-worker] Phase ${coverage.lastMergedPhase} for ${fullName}#${issue.number} landed in ${mergedRepo} — skipping plan validation`);
    } else {
      try {
        await validateAndUpdatePlan(
          repo,
          issue,
          plan,
          planEntry.id,
          planEntry.body,
          coverage.lastMergedPhase,
          lastMergedPR,
        );
      } catch (err) {
        log.warn(`[issue-worker] Plan validation failed for ${fullName}#${issue.number}: ${err}`);
      }
    }
  }

  // A step planned in a repo Claws does not manage: `processIssue` would strip
  // a re-applied `Refined` again, looping every tick, so hold it back and say
  // why here — once, under the same marker `processIssue` uses.
  if (await resolvePhaseRepo(repo, entries?.[nextPhase - 1]?.repo) === "unmanaged") {
    log.info(`[issue-worker] Not advancing ${fullName}#${issue.number} to phase ${nextPhase}/${totalPhases}: it is planned in ${entries![nextPhase - 1].repo}, which Claws does not manage`);
    await postUnmanagedStepComment(fullName, issue, comments, nextPhase, totalPhases, entries![nextPhase - 1]);
    return;
  }

  // Circuit breaker: stop re-labeling if recent attempts produced no commits
  const noCommitCount = await db.countRecentNoCommitCompletions(fullName, issue.number);
  if (noCommitCount >= MAX_NO_COMMIT_RETRIES) {
    await postStuckComment(fullName, issue, comments, nextPhase, totalPhases, noCommitCount);
    log.warn(`[issue-worker] Phase ${nextPhase}/${totalPhases} stuck — ${noCommitCount} no-commit completions, not re-labeling`);
    return;
  }

  // More phases needed — re-label as Refined to trigger next PR
  log.info(`[issue-worker] PR merged, advancing to phase ${nextPhase}/${totalPhases} for ${fullName}#${issue.number}`);
  await gh.addLabel(fullName, issue.number, LABELS.refined);
}
