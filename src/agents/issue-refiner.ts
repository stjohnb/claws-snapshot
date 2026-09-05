import { createHash } from "node:crypto";
import { LABELS, HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN, isForgejoRepo, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { getItemTimeoutMs } from "../timeout-handler.js";
import { processTextForImages } from "../images.js";
import { RUNNER_POLICY_CONTEXT, HOST_EXECUTION_POLICY, SHOPPING_MANIFEST_CONTEXT, PROMOTION_MANIFEST_CONTEXT, frontendContext, forgeContext, homeAssistantContext, formatIssueCommentsForPrompt, gitHubIncidentContext } from "./agent-context.js";
import { isHomeAssistantConfigRepo, homeAssistantMcpAvailable } from "../home-assistant.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { getModel, getDeepModel, getProviderSelectionForItem, type ModelTier, type ProviderSelection } from "../model-selector.js";
import { extractModelsAttribution, parsePlan, type ParsedPlan, type Provider } from "../plan-parser.js";
import { loadPhaseCoverage } from "../phase-coverage.js";
import { parseOccurrenceCount } from "../occurrence-tracking.js";
import { parseFirstValidJson } from "../json-extract.js";
import * as slack from "../slack.js";

export const PLAN_HEADER = "## Implementation Plan";

export const PLAN_OCCURRENCES_MARKER = "CLAWS_PLAN_OCCURRENCES:";

function occurrenceMarkerFor(issueBody: string): string {
  const n = parseOccurrenceCount(issueBody ?? "");
  return n === null ? "" : `\n\n${PLAN_OCCURRENCES_MARKER} ${n}`;
}

export function parsePlannedOccurrences(planBody: string): number | null {
  const m = planBody.match(/CLAWS_PLAN_OCCURRENCES:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Hash of the issue title+body the plan was written against (#2524). */
export const PLAN_BODY_HASH_MARKER = "CLAWS_PLAN_BODY_HASH:";
/** Highest issue-comment id the plan run had seen when it started (#2524). */
export const PLAN_LAST_COMMENT_MARKER = "CLAWS_PLAN_LAST_COMMENT:";

/**
 * Stamped on the notice posted when `Refined` is stripped because human feedback
 * after the plan has not been addressed yet. Keyed to the newest unaddressed
 * comment id so a later round of feedback posts a fresh notice rather than being
 * suppressed by the previous one (same reasoning as issue-worker's
 * STALE_PLAN_MARKER, which keys on the plan body hash).
 */
export const PENDING_FEEDBACK_MARKER = "CLAWS_REFINED_PENDING_FEEDBACK";

function stripOccurrenceBlock(body: string): string {
  return body.replace(/\n*(?:---\n)?\*\*First seen:\*\* .*\n\*\*Last seen:\*\* .*\n\*\*Occurrences:\*\* \d+\s*$/, "");
}

export function issueContentHash(title: string, body: string | null | undefined): string {
  const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
  return createHash("sha256")
    .update(`${norm(title ?? "")}\n\n${norm(stripOccurrenceBlock(body ?? ""))}`)
    .digest("hex");
}

/** Last match wins — a plan whose prose quotes the marker must not beat our trailing one. */
export function parsePlanBodyHash(planBody: string): string | null {
  const ms = [...planBody.matchAll(/CLAWS_PLAN_BODY_HASH:\s*([0-9a-f]{64})/g)];
  return ms.length ? ms[ms.length - 1][1] : null;
}

export function parsePlanLastCommentId(planBody: string): number | null {
  const ms = [...planBody.matchAll(/CLAWS_PLAN_LAST_COMMENT:\s*(\d+)/g)];
  return ms.length ? parseInt(ms[ms.length - 1][1], 10) : null;
}

/**
 * Single source of truth for "the issue moved on since this plan was written".
 * False for legacy plans (no marker) and for Claws-maintained alert issues, whose
 * bodies ensureAlertIssue rewrites every tick — see REPLAN_OCCURRENCE_FACTOR.
 */
export function isPlanStaleForIssue(planBody: string, title: string, body: string): boolean {
  if (parseOccurrenceCount(body ?? "") !== null) return false;
  const stamped = parsePlanBodyHash(planBody);
  if (stamped === null) return false;
  return stamped !== issueContentHash(title, body);
}

/** Trailing markers for every posted/edited plan comment. */
export function planMarkersFor(content: { title: string; body: string }, lastCommentId: number): string {
  const parts = [
    occurrenceMarkerFor(content.body).trim(),
    `${PLAN_BODY_HASH_MARKER} ${issueContentHash(content.title, content.body)}`,
    `${PLAN_LAST_COMMENT_MARKER} ${lastCommentId}`,
  ];
  return `\n\n${parts.filter(Boolean).join("\n")}`;
}

/**
 * Re-stamp markers onto an existing plan body (drops any prior marker block first).
 * Strips only the trailing block, iterating from the end — a global content-wide
 * strip would also delete marker-shaped text quoted in the plan's own prose.
 */
export function stripPlanMarkers(planBody: string): string {
  const trailingMarker = /\n*(?:CLAWS_PLAN_OCCURRENCES:\s*\d+|CLAWS_PLAN_BODY_HASH:\s*[0-9a-f]{64}|CLAWS_PLAN_LAST_COMMENT:\s*\d+)\s*$/;
  let body = planBody;
  for (let stripped = body.replace(trailingMarker, ""); stripped !== body; stripped = body.replace(trailingMarker, "")) {
    body = stripped;
  }
  return body.trimEnd();
}

/**
 * Highest comment id in a run's snapshot, or 0 when the snapshot was empty.
 *
 * 0 (not null) is load-bearing. It is below every real GitHub comment id, so a
 * plan stamped `CLAWS_PLAN_LAST_COMMENT: 0` makes selectFeedbackCandidates()
 * treat EVERY comment on the issue as post-snapshot feedback — correct, because
 * the run saw none. Omitting the marker instead (the pre-#2623 behaviour) made
 * selectFeedbackCandidates fall back to its legacy "after the plan comment only"
 * slice, so a comment posted while the planner ran on a brand-new issue was
 * permanently invisible (home-assistant-config#416: the owner had to repost the
 * same instruction after the plan landed to get it honoured).
 */
function maxCommentId(comments: gh.IssueComment[]): number {
  return comments.length ? Math.max(...comments.map((c) => c.id)) : 0;
}

function isDeepPlan(issue: gh.Issue): boolean {
  return issue.labels.some((l) => l.name === LABELS.planDeep);
}

function planProviderForIssue(issue: gh.Issue, fullName: string): ProviderSelection {
  return getProviderSelectionForItem(issue.labels, { requiresMcp: homeAssistantMcpAvailable(fullName) });
}

function planModelForIssue(issue: gh.Issue, fullName: string): string {
  const { provider } = planProviderForIssue(issue, fullName);
  return isDeepPlan(issue) ? getDeepModel(provider) : getModel("opus", provider);
}

export const MAX_DUPLICATE_CANDIDATES = 20;
export const DUPLICATE_CANDIDATE_BODY_LIMIT = 500;

/**
 * Soft ceiling for a posted plan body, in characters. Deliberately far above the
 * planner's own 3,000-word budget (see IMPLEMENTER_GUIDANCE_INSTRUCTIONS): a
 * 3,000-word technical plan full of backticked paths and code fences lands around
 * 16–19k chars, so a threshold near that fires on ordinary plans and becomes noise.
 * This value flags only plans that have roughly doubled the budget — the case where
 * a re-plan is genuinely worth asking for. Implementer models have 200k-token
 * contexts, so 30k chars (~7.5k tokens) is not itself a context problem.
 */
export const PLAN_LENGTH_WARN_CHARS = 30_000;

export const PLAN_LENGTH_WARN_SENTINEL = "roughly double the ~3,000-word budget";

function planLengthWarning(len: number): string {
  return `> [!WARNING]\n> This plan is ${len.toLocaleString()} characters — ${PLAN_LENGTH_WARN_SENTINEL} the planner is given (soft limit ${PLAN_LENGTH_WARN_CHARS.toLocaleString()} chars). A plan this long usually means detail that belongs in the code, not the plan. Consider commenting with feedback to request a more concise re-plan.`;
}

async function warnIfPlanTooLong(
  fullName: string,
  issueNumber: number,
  length: number,
  label: string,
  existingComments: gh.IssueComment[] = [],
): Promise<void> {
  if (length <= PLAN_LENGTH_WARN_CHARS) return;
  if (existingComments.some((c) => gh.isClawsComment(c.body) && c.body.includes(PLAN_LENGTH_WARN_SENTINEL))) {
    log.info(`[issue-refiner] ${label} for ${fullName}#${issueNumber} is over the soft limit but a warning comment already exists — not reposting`);
    return;
  }
  log.warn(`[issue-refiner] ${label} for ${fullName}#${issueNumber} is ${length} chars — exceeds ${PLAN_LENGTH_WARN_CHARS} char soft limit`);
  await gh.commentOnIssue(fullName, issueNumber, planLengthWarning(length), { agentName: "Planner" });
}

export const NO_CODE_CHANGES_MARKER = "CLAWS_NO_CODE_CHANGES";

/** True when the planner concluded the issue needs no code change to the repo. */
export function parseNoCodeChanges(output: string): boolean {
  return /^\s*CLAWS_NO_CODE_CHANGES\s*$/m.test(output);
}

export function stripNoCodeChangesMarker(output: string): string {
  return output.replace(/\n?^\s*CLAWS_NO_CODE_CHANGES\s*$/gm, "").trim();
}

export const BLOCKED_MARKER = "CLAWS_BLOCKED";

/** True when the planner concluded the issue is gated on an external precondition. */
export function parseBlocked(output: string): boolean {
  return /^\s*CLAWS_BLOCKED\s*$/m.test(output);
}

export function stripBlockedMarker(output: string): string {
  return output.replace(/\n?^\s*CLAWS_BLOCKED\s*$/gm, "").trim();
}

export const TRANSFER_MARKER = "CLAWS_TRANSFER_TO:";
export const TRANSFERRED_FROM_MARKER = "CLAWS_TRANSFERRED_FROM:";
/**
 * Header for the routing comment. MUST NOT contain PLAN_HEADER: comments travel with a
 * transferred issue, and every "has this issue been planned?" check in the pipeline
 * (findUnreactedFeedbackAfterPlan, work-handlers.ts, plan-parser.findPlanComment) tests
 * for PLAN_HEADER. A PLAN_HEADER here would make the destination treat the issue as
 * already planned and never re-plan it.
 */
export const TRANSFER_HEADER = "## Repository Transfer";
export const MAX_TRANSFER_CANDIDATES = 30;

/** Kill switch — read at call time, mirroring stepBackEnabled(). */
export function transferEnabled(): boolean {
  return process.env["CLAWS_PLANNER_TRANSFER"] !== "false";
}

/** Canonical allowed slug, or null. Case-insensitive; never trusts the model's casing. */
export function parseTransferTarget(output: string, allowedRepos: string[]): string | null {
  const matches = [...output.matchAll(/^\s*CLAWS_TRANSFER_TO:\s*(.+?)\s*$/gm)];
  if (!matches.length) return null;
  const value = matches[matches.length - 1][1].trim().replace(/^`|`$/g, "");
  if (!value || value.toLowerCase() === "none") return null;
  return allowedRepos.find((r) => r.toLowerCase() === value.toLowerCase()) ?? null;
}

export function stripTransferMarker(output: string): string {
  return output.replace(/\n?^\s*CLAWS_TRANSFER_TO:.*$/gm, "").trim();
}

/** Source repo recorded by a `CLAWS_TRANSFERRED_FROM: owner/repo#123` stamp, or null. */
export function parseTransferredFrom(text: string): string | null {
  const m = text.match(/CLAWS_TRANSFERRED_FROM:\s*([\w.-]+\/[\w.-]+)#\d+/);
  return m ? m[1] : null;
}

/**
 * True when this issue has ALREADY been transferred INTO the current repo — one hop max.
 * The repo comparison matters: if `gh issue transfer` failed after the stamp was posted,
 * the stamp names the CURRENT repo, and routing must stay available so a retry is possible.
 */
export function alreadyTransferredInto(fullName: string, texts: string[]): boolean {
  return texts.some((t) => {
    const from = parseTransferredFrom(t);
    return from !== null && from.toLowerCase() !== fullName.toLowerCase();
  });
}

export function parseDuplicateOf(output: string, allowedNumbers: number[]): number | null {
  const matches = [...output.matchAll(/DUPLICATE_OF:\s*(.+?)(?:\n|$)/g)];
  if (!matches.length) return null;
  const match = matches[matches.length - 1];
  const value = match[1].trim();
  if (!value || value.toLowerCase() === "none") return null;
  const numMatch = value.match(/#?(\d+)/);
  if (!numMatch) return null;
  const n = parseInt(numMatch[1], 10);
  if (isNaN(n)) return null;
  if (!allowedNumbers.includes(n)) return null;
  return n;
}

export function stripDuplicateMarker(output: string): string {
  return output.replace(/\n?DUPLICATE_OF:.*$/gm, "").trim();
}

export function stripLeadingPlanHeader(output: string): string {
  const trimmed = output.trim();
  if (!trimmed.startsWith(PLAN_HEADER)) return trimmed;
  const rest = trimmed.slice(PLAN_HEADER.length);
  // Only strip a standalone header line — "## Implementation Plan for X" must survive.
  if (rest !== "" && !rest.startsWith("\n")) return trimmed;
  return rest.trim();
}

export const STEP_BACK_HEADER = "## Step Back";

/**
 * Header for the escalation-reviewer's verdict comment. Declared here rather than
 * in `escalation-reviewer.ts` so the dependency stays one-way: `escalation-reviewer`
 * imports from `issue-refiner`, never the reverse.
 */
export const ESCALATION_REVIEW_HEADER = "## Escalation Review";

export const STEP_BACK_MIN_PLAN_CHARS = 1_200;
export const STEP_BACK_REVISED_MARKER = "STEP_BACK_REVISED_PLAN";

/** Kill switch — read at call time, not module load, so tests can stub it. */
export function stepBackEnabled(): boolean {
  return process.env["CLAWS_PLANNER_STEP_BACK"] !== "false";
}

export function parseStepBackVerdict(output: string): "sound" | "reconsider" | null {
  const m = output.match(/^\s*STEP_BACK_VERDICT:\s*(sound|reconsider)\b/im);
  return m ? (m[1].toLowerCase() as "sound" | "reconsider") : null;
}

/** Splits a `reconsider` output into critique and replacement plan. */
export function splitStepBackOutput(output: string): { critique: string; revisedPlan: string | null } {
  const parts = output.split(/^\s*STEP_BACK_REVISED_PLAN\s*$/m);
  const head = parts[0].replace(/^\s*STEP_BACK_VERDICT:.*$/im, "").trim();
  if (parts.length < 2) return { critique: head, revisedPlan: null };
  return { critique: head, revisedPlan: parts.slice(1).join("\n").trim() || null };
}

export function isCiUnrelatedIssue(issue: gh.Issue): boolean {
  return issue.title.startsWith("[ci-unrelated]");
}

/** Issues Claws may apply `Refined` to itself once a plan exists: `[ci-unrelated]`
 *  alerts, and issues already carrying `Automerge` — that label declares "merge this
 *  PR without a human LGTM", so also demanding a human `Refined` is contradictory (#2730). */
export function isAutoRefineIssue(issue: gh.Issue): boolean {
  return isCiUnrelatedIssue(issue) || issue.labels.some((l) => l.name === LABELS.automerge);
}

const NO_CODE_CHANGES_INSTRUCTION = [
  `If, after investigating the codebase, you conclude that this issue requires`,
  `NO changes to any file tracked in this repository — because it describes a`,
  `purely operational/manual task (deleting artifacts, changing repo settings,`,
  `rotating a secret, running a one-off command), because the underlying code fix`,
  `has already been shipped, or because it is not actionable as a code change —`,
  `then do NOT write an implementation plan. Instead output a SHORT paragraph (2-4`,
  `sentences) explaining why no code change is warranted, followed by EXACTLY this`,
  `line on its own:`,
  ``,
  NO_CODE_CHANGES_MARKER,
  ``,
  `Only use this when you are confident a code change is genuinely unnecessary. If`,
  `there is any concrete file edit that would resolve or mitigate the issue`,
  `(including editing a GitHub Actions workflow), produce the normal plan instead.`,
  `Do NOT emit ${NO_CODE_CHANGES_MARKER} together with a plan body or with a`,
  `DUPLICATE_OF verdict — choose exactly one outcome.`,
  `If the issue belongs in a different repository, use the Repository Routing section below instead of ${NO_CODE_CHANGES_MARKER}.`,
].join("\n");

const BLOCKED_INSTRUCTION = [
  `If the issue cannot be worked on yet because it is gated on a VERIFIABLE precondition`,
  `outside this repository's control — an upstream PR/release that has not landed, another`,
  `repository's PR that must merge first, hardware that has not arrived — then do NOT write`,
  `an implementation plan. Instead output a SHORT paragraph (2-4 sentences) naming the exact`,
  `blocker (repo, PR/issue number or release, and its state as you verified it today),`,
  `followed by EXACTLY this line on its own:`,
  ``,
  BLOCKED_MARKER,
  ``,
  `Use this ONLY when you checked the blocker and confirmed it is still unmet. A task that is`,
  `merely large, unclear, or awaiting a human decision is NOT blocked — plan it normally.`,
  `Do NOT emit ${BLOCKED_MARKER} together with a plan body, ${NO_CODE_CHANGES_MARKER}, a`,
  `DUPLICATE_OF verdict, or ${TRANSFER_MARKER} — choose exactly one outcome.`,
].join("\n");

const MULTI_PR_INSTRUCTIONS = [
  `Prefer a single PR — split only when the work is genuinely too large or risky to ship atomically`,
  `(a migration that must land before the code depending on it, or ~800+ lines across 15+ files).`,
  ``,
  `If you do need multiple PRs, use this exact format:`,
  ``,
  `### PR 1: [short title]`,
  `[description, files, changes for this PR]`,
  ``,
  `### PR 2: [short title]`,
  `[description, files, changes for this PR]`,
  ``,
  `Each PR must be independently deployable.`,
].join("\n");

/**
 * Replaces MULTI_PR_INSTRUCTIONS when refining a plan that already has
 * `### PR N:` headers. Those headers are load-bearing: Claws numbers every PR
 * it opens `(N/M)` against the header count, so a refinement that flattens them
 * orphans PRs that already merged under the old numbering (#2821).
 */
function multiPrPreservationInstructions(plan: ParsedPlan): string {
  return [
    `The existing plan above is a multi-PR plan with exactly ${plan.totalPhases} steps:`,
    ...plan.phases.map((p) => `- ### PR ${p.phaseNumber}: ${p.title}`),
    ``,
    `You MUST keep this structure. Output exactly ${plan.totalPhases} \`### PR N:\` headers, numbered 1..${plan.totalPhases},`,
    `in the same order and covering the same scope as above. Claws numbers every PR it opens`,
    `\`(N/${plan.totalPhases})\` against this exact step count, so dropping a header or changing the count`,
    `silently orphans PRs that already merged against the old numbering.`,
    `Steps that have already shipped MUST keep their header and a short description of what shipped —`,
    `do NOT rewrite the plan as only the remaining work, and do NOT flatten it into a single list.`,
    `Apply the feedback inside the affected step(s). Only change the step count if the feedback`,
    `explicitly asks you to, and if you do, say so in one sentence at the top of the plan.`,
  ].join("\n");
}

const PR_BASE_POLICY_INSTRUCTIONS = [
  `Never plan a stacked PR. A PR you plan targets the repository's default branch, full stop —`,
  `do not instruct the implementer to change any PR's base branch, and do not tell it to branch`,
  `from another PR's branch and open a separate PR.`,
  ``,
  `If the fix genuinely must land on an already-open pull request's branch — for example the`,
  `files it edits exist only on that branch, or that PR's CI cannot go green until this lands —`,
  `then say so and put this line on its own line at the very end of your output, after the model`,
  `recommendation lines:`,
  ``,
  `CLAWS_TARGET_PR: #<pr-number>`,
  ``,
  `Claws will then check that PR out, commit your plan's changes onto its branch and push, so the`,
  `existing PR picks them up. Requirements for this to work: the PR must be open, not from a fork,`,
  `its head branch must be a \`claws/\` branch, and its base must be the default branch. Write the`,
  `plan as a single phase (no \`### PR N:\` split) — the marker is ignored on a multi-phase plan.`,
  `Do not also ask for a new PR. If none of that holds, plan against the default branch instead.`,
].join("\n");

const IMPLEMENTER_GUIDANCE_INSTRUCTIONS = [
  `The implementer runs on a smaller model with a smaller context window; your plan is its`,
  `specification. Name exact file paths, functions, and line ranges; quote signatures and`,
  `behaviour it must preserve; call out invariants and gotchas it would otherwise miss; give`,
  `the order of operations; resolve every judgement call yourself instead of deferring it.`,
  `"Handle edge cases appropriately" is not a specification — name the edge case.`,
  ``,
  `Start immediately with the "${PLAN_HEADER}" header and the plan itself — no preamble, no`,
  `"I'll analyze" / "Looking at" narration. Stay under 3,000 words: context you spend on detail`,
  `a competent developer would infer is context the implementer no longer has for reading files.`,
  `For a change spanning many files, describe each in 2-4 sentences rather than quoting large blocks.`,
].join("\n");

const DEEP_PLANNING_CONTEXT = [
  `This issue was explicitly labelled for deep planning: you are running on the best model`,
  `available, with reasoning effort turned to maximum. The label signals the issue is unusually`,
  `hard, ambiguous, or high-stakes.`,
  `Invest the extra capability in deeper investigation — read more of the codebase, trace the`,
  `actual code paths, verify assumptions against the real files — not in writing a longer plan.`,
  `The implementer is unchanged (a much smaller model), so the capability gap between planner`,
  `and implementer is wider than usual: resolve every judgment call yourself and make the plan`,
  `fully self-contained. The plan length limits below still apply.`,
].join("\n");

const MODEL_SELECTION_INSTRUCTIONS = [
  `After your plan, recommend an implementation model on its own line, in this exact format:`,
  ``,
  `**Recommended implementation model:** \`cheap\``,
  ``,
  `Valid tiers are \`cheap\`, \`sonnet\`, and \`opus\`. Choose \`cheap\` for trivial tasks with no logic`,
  `change (typos, comments, docs, one-line fixes); \`sonnet\` for well-defined changes following an`,
  `established pattern where the plan leaves little ambiguity; \`opus\` for architectural changes,`,
  `multi-file refactors with novel logic, or anything needing judgement beyond what the plan spells`,
  `out. When in doubt, choose \`opus\`.`,
].join("\n");

const WORKTREE_ENVIRONMENT_NOTE = [
  `You are running inside a fresh git worktree checked out from the default branch.`,
  `It contains the repository's tracked files only — dependencies are NOT installed`,
  `(\`node_modules\` is absent, as are any other gitignored build/vendor artifacts).`,
  `This is by design, not a restriction: you have full shell access and MAY run`,
  `\`npm install\`/\`npm ci\` (or the project's package manager) yourself if you`,
  `genuinely need installed dependencies to investigate. For dependency or version`,
  `analysis, prefer reading the lockfile (\`package-lock.json\`) directly — it lists`,
  `every resolved version and avoids a slow, costly install. Do not describe reading`,
  `the lockfile as a workaround; it is the preferred approach.`,
].join("\n");

const NO_HTML_COMMENTS_INSTRUCTION = `Do not use HTML comments (<!-- ... -->) anywhere in your output. All content must be human-readable plain text or standard markdown.`;

const RESEARCH_INSTRUCTIONS = [
  `Before writing the plan, gather the context the implementer cannot gather for itself:`,
  `- If the issue or a comment references other GitHub issues or PRs (by URL or \`#123\` / \`owner/repo#123\`), fetch them: \`gh issue view <n> --repo <owner>/<repo> --comments\` or \`gh pr view <n> --repo <owner>/<repo>\` — the same number may be either, so try the other form on a 404. The \`gh\` CLI can read any repo the Claws GitHub App is installed in, including other repos in the org. If both forms fail, say so in the plan and continue with what the issue holds.`,
  `- If it references external URLs, use the WebFetch tool to retrieve their content. Use the WebSearch tool when you need to research a named library or API you must get right and that is not directly linked. Note truncated or unreachable content rather than inventing it.`,
  `- If it references diagnostic artefacts — an Actions run, an uploaded artifact, a build log — read them before diagnosing: \`gh run view <run-id> --repo <owner>/<repo> --log-failed\`, falling back to \`--log\`; \`gh run download <run-id>\` for artifacts. Auto-filed alert issues ([claws-error], [ci-failure]) usually carry no diagnosis in the body itself.`,
  `- An occurrence-tracking block ("**Occurrences:** N") is load-bearing: N greater than 1 means a recurring failure the plan must actually address, not a transient blip.`,
  ``,
  `Never write "see #N" or "fetch the linked context" in the plan — the implementer runs on a smaller model and cannot look anything up. Embed the concrete facts (paths, error messages, IDs, snippets, prior decisions) directly. Commit to ONE diagnosed root cause and ONE fix; if the evidence genuinely will not support a diagnosis, say so and recommend a single next action rather than branching into alternatives.`,
].join("\n");

const REVIEW_MODEL_INSTRUCTIONS = [
  `Also recommend a review model for the PR reviewer on its own line, in this exact format:`,
  ``,
  `**Recommended review model:** \`sonnet\``,
  ``,
  `Valid tiers are \`sonnet\` and \`opus\`. Choose \`sonnet\` for PRs that will be straightforward to`,
  `review — config changes, simple bug fixes, well-scoped single-concern changes. Choose \`opus\``,
  `for security-sensitive or architectural changes, complex multi-file refactors, or novel`,
  `algorithms. When in doubt, choose \`opus\`.`,
].join("\n");


export function buildDuplicateCandidatesSection(
  fullName: string,
  currentIssueNumber: number,
  candidates: gh.Issue[],
): string {
  if (candidates.length === 0) return "";
  const lines: string[] = [
    ``,
    `## Possible Duplicate Candidates`,
    ``,
    `The following open issues in this repository have a LOWER issue number than #${currentIssueNumber}. If this issue has the SAME ROOT CAUSE as any of them (for example, multiple alerts caused by one underlying failure), it should be treated as a duplicate of the lowest-numbered matching one.`,
    ``,
  ];
  for (const c of candidates) {
    // #2526: bind the guard context to the CANDIDATE, not the issue being refined.
    // guardContent() posts its warning comment to context.itemNumber and dedups on
    // repo#itemNumber, so the shared context put "please edit the source" on the
    // wrong issue and re-posted it for every subsequent refine in the repo.
    const candidateCtx = makeGuardCtx(fullName, c.number);
    const guardedTitle = guardContent(c.title, candidateCtx("duplicate-candidate-title"));
    // Truncate BEFORE guarding: only the prefix reaches the model, so only the
    // prefix should be scanned or alerted on. (Redaction markers are 47 chars,
    // so a guarded prefix may end up slightly longer than the limit — fine.)
    const rawBody = c.body ?? "";
    const truncRaw = rawBody.length > DUPLICATE_CANDIDATE_BODY_LIMIT
      ? rawBody.slice(0, DUPLICATE_CANDIDATE_BODY_LIMIT) + "..."
      : rawBody;
    const trunc = guardContent(truncRaw, candidateCtx("duplicate-candidate-body"));
    lines.push(`### #${c.number}: ${guardedTitle}`);
    lines.push(trunc || "(No description provided)");
    lines.push(``);
  }
  lines.push(
    `## Duplicate Determination`,
    ``,
    `At the very END of your output (after the implementation model and review model recommendation lines), include EXACTLY ONE line in this form:`,
    ``,
    `DUPLICATE_OF: #<issue-number>`,
    ``,
    `or`,
    ``,
    `DUPLICATE_OF: none`,
    ``,
    `Rules:`,
    `- Output \`DUPLICATE_OF: #N\` ONLY if the current issue (#${currentIssueNumber}) shares a root cause with issue #N from the list above. Different symptoms of the same underlying failure count as a duplicate. Superficial textual similarity without a shared root cause does NOT.`,
    `- If multiple candidates share the root cause, pick the LOWEST-NUMBERED one.`,
    `- Otherwise output \`DUPLICATE_OF: none\`.`,
    `- The number MUST be one of: ${candidates.map((c) => `#${c.number}`).join(", ")}. Do not invent a number.`,
    `- When the answer is \`DUPLICATE_OF: #N\`, do NOT write a plan body — output only the \`DUPLICATE_OF: #N\` line. A standard message will be posted automatically.`,
    ``,
  );
  return lines.join("\n");
}

function buildTransferCandidatesSection(fullName: string, candidates: string[]): string {
  if (candidates.length === 0) return "";
  return [
    ``,
    `## Repository Routing`,
    ``,
    `This issue was filed against ${fullName}, but it may belong to a different repository.`,
    `These repositories are managed by Claws and can receive this issue:`,
    ``,
    ...candidates.map((slug) => `- ${slug}`),
    ``,
    `If — after reading THIS repository's code — the issue is clearly about a DIFFERENT`,
    `repository's code or configuration (the subject matter has no presence here at all),`,
    `do NOT write a plan. Instead output a SHORT paragraph (2-4 sentences) naming the`,
    `evidence (e.g. "no file in this repository mentions X; that integration lives in Y"),`,
    `followed by EXACTLY this line on its own:`,
    ``,
    `${TRANSFER_MARKER} <owner>/<repo>`,
    ``,
    `Rules:`,
    `- Copy the destination EXACTLY from the list above. Do not invent a name.`,
    `- Only transfer when the issue is UNAMBIGUOUSLY about another repository. If the work`,
    `  could plausibly be done here, or spans both, write a normal plan instead.`,
    `- A vague or general issue is NOT a transfer candidate.`,
    `- Do NOT emit ${TRANSFER_MARKER} together with a plan body, a DUPLICATE_OF verdict, or`,
    `  ${NO_CODE_CHANGES_MARKER} — choose exactly one outcome.`,
  ].join("\n");
}

function buildRefinementPrompt(
  repo: Repo,
  issue: gh.Issue,
  existingPlan: string,
  parsed: ParsedPlan,
  feedback: gh.IssueComment[],
  selfLogin: string,
  isDeep: boolean,
  wtPath: string,
): string {
  const fullName = repo.fullName;
  const guardCtx = makeGuardCtx(fullName, issue.number);
  const incidentCtx = gitHubIncidentContext(guardCtx);
  return [
    `You are analyzing a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    guardContent(issue.body, guardCtx("issue-body")) || "(No description provided)",
    ``,
    `A previous implementation plan was produced:`,
    ``,
    // Existing plan is self-authored by Claws — guarding it produces false positives
    // when plans discuss security topics or contain example injection strings.
    existingPlan,
    ``,
    ...(feedback.length > 0
      ? [
          `The following feedback was provided on the plan:`,
          ``,
          ...formatIssueCommentsForPrompt(feedback, selfLogin, guardCtx),
        ]
      : [`No specific feedback comments were provided. Re-evaluate the plan for completeness and correctness.`, ``]),
    ``,
    `If \`docs/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant to the issue) for context about the codebase architecture and patterns.`,
    RUNNER_POLICY_CONTEXT,
    HOST_EXECUTION_POLICY,
    ...(incidentCtx ? [incidentCtx] : []),
    SHOPPING_MANIFEST_CONTEXT,
    PROMOTION_MANIFEST_CONTEXT,
    frontendContext(wtPath),
    forgeContext(repo),
    WORKTREE_ENVIRONMENT_NOTE,
    RESEARCH_INSTRUCTIONS,
    ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
    ``,
    `Please produce an updated implementation plan that addresses the feedback.`,
    `Include:`,
    `- Which files need to be changed`,
    `- What the changes should be`,
    `- Any potential risks or edge cases`,
    `- A suggested order of implementation`,
    ``,
    parsed.totalPhases > 1 ? multiPrPreservationInstructions(parsed) : MULTI_PR_INSTRUCTIONS,
    ``,
    PR_BASE_POLICY_INSTRUCTIONS,
    ``,
    IMPLEMENTER_GUIDANCE_INSTRUCTIONS,
    ...(isDeep ? [``, DEEP_PLANNING_CONTEXT] : []),
    ``,
    MODEL_SELECTION_INSTRUCTIONS,
    ``,
    REVIEW_MODEL_INSTRUCTIONS,
    ``,
    ...(feedback.length > 0
      ? [
          `After the updated plan, include a \`### Response\` section that:`,
          `- Directly answers any questions asked in the feedback`,
          `- Acknowledges concerns or suggestions`,
          `- Notes any surprises or deviations from the original plan`,
          ``,
          `This section will be posted as a separate follow-up comment on the issue, so write it in a conversational tone addressing the commenter(s). If there is no feedback to respond to, omit this section entirely.`,
          ``,
        ]
      : [
          `This is an automatic re-verification pass: nobody left feedback and nobody is waiting on a reply.`,
          `Output ONLY the updated plan. Do NOT add a \`### Response\` section, a "what changed since the last plan" summary, or any conversational narration — that text is discarded, and previously it was posted as a separate comment on the issue on every re-verification pass, which is unwanted noise. If re-verification changed the diagnosis, say so inside the plan body itself.`,
          ``,
        ]),
    NO_HTML_COMMENTS_INSTRUCTION,
    ``,
    `Do NOT make any code changes. Only produce the plan as text output.`,
  ].join("\n");
}

function buildFollowUpPrompt(
  repo: Repo,
  issue: gh.Issue,
  existingPlan: string,
  openPRNumber: number,
  followUpComments: gh.IssueComment[],
  selfLogin: string,
  wtPath: string,
  prSummary: string,
): string {
  const fullName = repo.fullName;
  const guardCtx = makeGuardCtx(fullName, issue.number);
  return [
    `You are responding to follow-up questions on a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    guardContent(issue.body, guardCtx("issue-body")) || "(No description provided)",
    ``,
    `An implementation plan was already produced, and PR #${openPRNumber} is open referencing this issue. Do NOT assume the PR implements the plan — it may have diverged, or been opened against a newer comment. Check what it actually changes before describing it.`,
    ``,
    prSummary,
    ``,
    `Here is the existing plan:`,
    ``,
    // Existing plan is self-authored by Claws — guarding it produces false positives
    // when plans discuss security topics or contain example injection strings.
    existingPlan,
    ``,
    `The following follow-up comments were posted after the plan:`,
    ``,
    ...formatIssueCommentsForPrompt(followUpComments, selfLogin, guardCtx),
    ``,
    `If \`docs/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant) for context about the codebase architecture and patterns.`,
    RUNNER_POLICY_CONTEXT,
    HOST_EXECUTION_POLICY,
    frontendContext(wtPath),
    forgeContext(repo),
    WORKTREE_ENVIRONMENT_NOTE,
    RESEARCH_INSTRUCTIONS,
    ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
    ``,
    `Please respond to the follow-up comments above. Answer questions, provide clarifications, or address concerns.`,
    `Do NOT produce a new implementation plan — implementation is already in progress via PR #${openPRNumber}.`,
    `If the comments suggest changes that should be made to the PR, mention that in your response.`,
    ``,
    `Do NOT make any code changes. Only produce your response as text output.`,
  ].join("\n");
}

function buildNewPlanPrompt(
  repo: Repo,
  issue: gh.Issue,
  comments: gh.IssueComment[],
  selfLogin: string,
  duplicateCandidates: gh.Issue[],
  transferCandidates: string[],
  isDeep: boolean,
  wtPath: string,
): string {
  const fullName = repo.fullName;
  const guardCtx = makeGuardCtx(fullName, issue.number);
  const incidentCtx = gitHubIncidentContext(guardCtx);
  return [
    `You are analyzing a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    guardContent(issue.body, guardCtx("issue-body")) || "(No description provided)",
    ``,
    ...formatIssueCommentsForPrompt(comments, selfLogin, guardCtx),
    `If \`docs/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant to the issue) for context about the codebase architecture and patterns.`,
    RUNNER_POLICY_CONTEXT,
    HOST_EXECUTION_POLICY,
    ...(incidentCtx ? [incidentCtx] : []),
    SHOPPING_MANIFEST_CONTEXT,
    PROMOTION_MANIFEST_CONTEXT,
    frontendContext(wtPath),
    forgeContext(repo),
    WORKTREE_ENVIRONMENT_NOTE,
    RESEARCH_INSTRUCTIONS,
    ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
    ``,
    `Please produce a detailed implementation plan for this issue.`,
    `Include:`,
    `- Which files need to be changed`,
    `- What the changes should be`,
    `- Any potential risks or edge cases`,
    `- A suggested order of implementation`,
    ``,
    MULTI_PR_INSTRUCTIONS,
    ``,
    PR_BASE_POLICY_INSTRUCTIONS,
    ``,
    IMPLEMENTER_GUIDANCE_INSTRUCTIONS,
    ...(isDeep ? [``, DEEP_PLANNING_CONTEXT] : []),
    ``,
    MODEL_SELECTION_INSTRUCTIONS,
    ``,
    REVIEW_MODEL_INSTRUCTIONS,
    ``,
    NO_HTML_COMMENTS_INSTRUCTION,
    ``,
    NO_CODE_CHANGES_INSTRUCTION,
    ``,
    BLOCKED_INSTRUCTION,
    ``,
    `Do NOT make any code changes. Only produce the plan as text output.`,
    buildTransferCandidatesSection(fullName, transferCandidates),
    buildDuplicateCandidatesSection(fullName, issue.number, duplicateCandidates),
  ].join("\n");
}

function buildStepBackPrompt(repo: Repo, issue: gh.Issue, planBody: string, isDeep: boolean, wtPath: string): string {
  const fullName = repo.fullName;
  const guardCtx = makeGuardCtx(fullName, issue.number);
  return [
    `You are analyzing a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    guardContent(issue.body, guardCtx("issue-body")) || "(No description provided)",
    ``,
    `A plan has already been produced for this issue:`,
    ``,
    // Plan is self-authored by Claws — guarding it produces false positives
    // when plans discuss security topics or contain example injection strings.
    planBody,
    ``,
    `This pass is NOT for polishing the plan or checking its details. Another pass already`,
    `does that. Your single question is: does this plan solve the right problem in the right`,
    `way, or is it a well-executed version of a suboptimal approach?`,
    ``,
    `Probe specifically:`,
    `- Does it attack the root cause, or work around a symptom?`,
    `- Is there a simpler approach that would make most of the plan unnecessary?`,
    `- Does it add machinery (a new module, a config key, an abstraction) where an existing`,
    `  helper, a deletion, or a changed default would do?`,
    `- Does it treat an existing bad design as fixed, when replacing it is cheaper than`,
    `  working around it?`,
    `- Does it carry forward a constraint from the issue text that is not actually a constraint?`,
    `- Does it look complete while leaving the original motivation only partly addressed?`,
    ``,
    `You have the whole repository available — read the real files before concluding. A step`,
    `back not grounded in the actual code is worse than none.`,
    ``,
    `Default to "sound". Most plans are fine and a spurious pivot costs more than it saves.`,
    `Emit "reconsider" only when you can name a concrete, materially better approach — not a`,
    `vague preference, and not a list of small improvements to the existing plan.`,
    ``,
    `Output format:`,
    `- Your FIRST line must be exactly \`STEP_BACK_VERDICT: sound\` or \`STEP_BACK_VERDICT: reconsider\`.`,
    `- If \`sound\`: output that single line and nothing else.`,
    `- If \`reconsider\`: after the verdict line, write at most 400 words explaining what the`,
    `  original plan gets wrong and why the new approach is better, addressed to a human`,
    `  reviewer. Then write \`${STEP_BACK_REVISED_MARKER}\` alone on a line. Then write the`,
    `  COMPLETE replacement plan — the original is discarded, not merged, so the replacement`,
    `  must stand alone.`,
    `- Do NOT emit a DUPLICATE_OF line, the ${NO_CODE_CHANGES_MARKER} marker, or the ${BLOCKED_MARKER} marker — those verdicts were already decided.`,
    ``,
    `The replacement plan must have the same shape as a normal plan:`,
    RUNNER_POLICY_CONTEXT,
    HOST_EXECUTION_POLICY,
    SHOPPING_MANIFEST_CONTEXT,
    PROMOTION_MANIFEST_CONTEXT,
    frontendContext(wtPath),
    forgeContext(repo),
    WORKTREE_ENVIRONMENT_NOTE,
    ``,
    MULTI_PR_INSTRUCTIONS,
    ``,
    PR_BASE_POLICY_INSTRUCTIONS,
    ``,
    IMPLEMENTER_GUIDANCE_INSTRUCTIONS,
    ...(isDeep ? [``, DEEP_PLANNING_CONTEXT] : []),
    ``,
    MODEL_SELECTION_INSTRUCTIONS,
    ``,
    REVIEW_MODEL_INSTRUCTIONS,
    ``,
    NO_HTML_COMMENTS_INSTRUCTION,
    ``,
    `Do NOT make any code changes. Only produce text output.`,
  ].join("\n");
}

async function runStepBack(opts: {
  repo: Repo;
  issue: gh.Issue;
  wtPath: string;
  planBody: string;
  model: string;
  tier: ModelTier;
  provider: Provider;
  strictProvider: boolean;
  deepPlan: boolean;
  timeoutMs: number | undefined;
  mcpConfigPath: string;
  agentDoc: string | undefined;
  taskId: number;
}): Promise<{ revisedPlan: string | null; critique: string | null }> {
  const none = { revisedPlan: null, critique: null };
  if (!stepBackEnabled()) return none;
  if (opts.planBody.length < STEP_BACK_MIN_PLAN_CHARS) return none;

  try {
    const prompt = buildStepBackPrompt(opts.repo, opts.issue, opts.planBody, opts.deepPlan, opts.wtPath);
    const out = await claude.runClaude(prompt, opts.wtPath, {
      mcpConfig: opts.mcpConfigPath,
      timeoutMs: opts.timeoutMs,
      tier: opts.tier,
      model: opts.model,
      provider: opts.provider,
      strictProvider: opts.strictProvider,
      deepThinking: opts.deepPlan,
      appendSystemPrompt: opts.agentDoc,
      onTokensUsed: db.trackTaskTokens(opts.taskId),
      captureLabel: "issue-refiner-step-back",
    });

    // An absent or unparseable marker deliberately means "sound".
    if (parseStepBackVerdict(out) !== "reconsider") {
      log.info(`[issue-refiner] Step-back pass found the plan sound for ${opts.repo.fullName}#${opts.issue.number}`);
      return none;
    }

    const { critique, revisedPlan } = splitStepBackOutput(out);
    // A stray marker in the replacement text must not leak into the posted comment.
    const cleaned = revisedPlan
      ? stripDuplicateMarker(stripNoCodeChangesMarker(stripLeadingPlanHeader(revisedPlan)))
      : "";
    if (!cleaned.trim()) {
      log.warn(`[issue-refiner] Step-back said "reconsider" for ${opts.repo.fullName}#${opts.issue.number} but produced no usable replacement plan — keeping the original`);
      return { revisedPlan: null, critique: critique || null };
    }
    return { revisedPlan: cleaned, critique: critique || null };
  } catch (err) {
    log.warn(`[issue-refiner] Step-back pass failed for ${opts.repo.fullName}#${opts.issue.number}: ${err}`);
    return none;
  }
}

function selectDuplicateCandidates(
  fullName: string,
  currentIssue: gh.Issue,
  allOpenIssues: gh.Issue[],
): gh.Issue[] {
  const clawsIgnore = LABELS.clawsIgnore;
  return allOpenIssues
    .filter((i) => i.number < currentIssue.number)
    .filter((i) => !i.labels.some((l) => l.name === clawsIgnore))
    .filter((i) => !gh.isItemSkipped(fullName, i.number))
    .sort((a, b) => b.number - a.number) // take newest-relevant first
    .slice(0, MAX_DUPLICATE_CANDIDATES)
    .sort((a, b) => a.number - b.number); // render ascending for prompt stability
}

/**
 * Transfer is same-forge only: GitHub's transfer API cannot move an issue to a
 * Forgejo repo, and Forgejo/Gitea has no issue-transfer API at all. A Forgejo
 * repo is therefore neither a transfer source nor a transfer target (#2650).
 */
export function selectTransferCandidates(currentRepo: Repo, allRepos: Repo[]): string[] {
  if (isForgejoRepo(currentRepo.fullName)) return [];
  return allRepos
    .filter((r) => r.owner === currentRepo.owner && r.fullName !== currentRepo.fullName)
    .filter((r) => !isForgejoRepo(r.fullName))
    .map((r) => r.fullName).sort().slice(0, MAX_TRANSFER_CANDIDATES);
}

export async function processIssue(repo: Repo, issue: gh.Issue): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Planning ${fullName}#${issue.number}: ${issue.title}`);

  const branchName = `claws/plan-${issue.number}-${claude.randomSuffix()}`;

  await db.withTaskRecording("issue-refiner", fullName, issue.number, null, async (taskId) => {
    await claude.withNewWorktree(repo, branchName, "issue-refiner", async (wtPath) => {
      db.updateTaskWorktree(taskId, wtPath, branchName);

      const [comments, selfLogin, allOpenIssues, allRepos, live] = await Promise.all([
        gh.getIssueComments(fullName, issue.number),
        gh.getSelfLoginForRepo(repo.fullName),
        gh.listOpenIssues(fullName),
        gh.listRepos().catch(() => []),
        gh.getIssueTitleBody(fullName, issue.number).catch(() => null),
      ]);
      // `issue` comes from the 60 s-cached open-issue list; the plan must be written
      // against — and stamped with — the live content, or the stamped hash lags and
      // the dispatcher re-plans forever (#2524).
      const issueForPlan: gh.Issue = live ? { ...issue, title: live.title, body: live.body } : issue;
      const plannedLastCommentId = maxCommentId(comments);
      const duplicateCandidates = selectDuplicateCandidates(fullName, issueForPlan, allOpenIssues);
      const transferCandidates = transferEnabled()
        && !alreadyTransferredInto(fullName, [issueForPlan.body ?? "", ...comments.map((c) => c.body)])
        ? selectTransferCandidates(repo, allRepos) : [];
      const issueBodyHtml = await gh.getIssueBodyHtml(fullName, issue.number).catch(() => "");
      const htmlBodies = [issueBodyHtml, ...comments.map((c) => c.body_html)];
      const imageContext = await processTextForImages([issueForPlan.body, ...comments.map((c) => c.body)], wtPath, repo, { repo: fullName, issueNumber: issue.number, agentName: "Planner" }, htmlBodies);
      const model = planModelForIssue(issue, fullName);
      const deep = isDeepPlan(issue);
      const prompt = buildNewPlanPrompt(repo, issueForPlan, comments, selfLogin, duplicateCandidates, transferCandidates, deep, wtPath) + imageContext;

      const mcpConfigPath = claude.writeAgentMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName) });
      const agentDoc = claude.readRepoAgentDoc(wtPath, "issue-refiner");
      const timeoutMs = getItemTimeoutMs(fullName, issue.number);
      // Pinned to opus: issue descriptions are often too sparse to classify
      // reliably, and a wrong downgrade — especially to haiku — produces
      // low-quality plans that propagate through every downstream implementation.
      // Plan generation is text-only (no file edits), but stays pinned to
      // Claude because the planner is the highest-leverage model call in the
      // whole pipeline — it produces the specification that a smaller
      // implementer model then has to follow. Degrading the planner to a
      // cheaper model degrades every downstream implementation.
      const tier: ModelTier = "opus";
      db.updateTaskModel(taskId, model);
      log.info(`[issue-refiner] Using model "${model}" for planning ${fullName}#${issue.number}`);
      const { provider, strictProvider, overrideIgnoredReason } = planProviderForIssue(issue, fullName);
      if (overrideIgnoredReason) log.warn(`[issue-refiner] ${fullName}#${issue.number}: ${overrideIgnoredReason}`);
      const providerNote = overrideIgnoredReason ? `; ${overrideIgnoredReason}` : "";
      let actualProvider: Provider = provider;
      const planOutput = await claude.runClaude(prompt, wtPath, { mcpConfig: mcpConfigPath, timeoutMs, tier, model, provider, strictProvider, deepThinking: deep, appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onTokensUsed: db.trackTaskTokens(taskId), captureLabel: "issue-refiner", githubTokenOwner: repo.owner });

      const candidateNumbers = duplicateCandidates.map((c) => c.number);
      const duplicateOf = candidateNumbers.length > 0 ? parseDuplicateOf(planOutput, candidateNumbers) : null;
      const transferTo = duplicateOf === null && transferCandidates.length > 0
        ? parseTransferTarget(planOutput, transferCandidates) : null;
      const blocked = duplicateOf === null && transferTo === null && parseBlocked(planOutput);
      const noCodeChanges = duplicateOf === null && transferTo === null && !blocked && parseNoCodeChanges(planOutput);
      const cleanedOutput = stripBlockedMarker(stripTransferMarker(stripNoCodeChangesMarker(stripLeadingPlanHeader(stripDuplicateMarker(planOutput)))));

      // Retained for the auto-Refined coverage gate below: the plan body actually
      // posted, which is what its phase count must be read from.
      let postedPlan: string | null = null;

      if (cleanedOutput.trim() || duplicateOf !== null || noCodeChanges || blocked || transferTo !== null) {
        const attribution = `*Models used: ${model} (provider: ${actualProvider}${providerNote})*`;
        if (duplicateOf !== null) {
          // Use plain text marker (CLAWS_DUPLICATE_OF:) not hidden HTML comment — aligns with NO_HTML_COMMENTS_INSTRUCTION
          const dupBody = [
            `This issue appears to share a root cause with #${duplicateOf}. See that issue for the full implementation plan.`,
            `CLAWS_DUPLICATE_OF: #${duplicateOf}`,
            ``,
            `If you believe this is NOT a duplicate, remove the \`Duplicate\` label and re-add \`Ready\` — Claws will re-plan with your comment as context.`,
          ].join("\n");
          await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${dupBody}\n\n${attribution}`, { agentName: "Planner" });
          await gh.addLabel(fullName, issue.number, LABELS.duplicate);
          log.info(`[issue-refiner] Marked ${fullName}#${issue.number} as duplicate of #${duplicateOf}`);
          try {
            await gh.commentOnIssue(
              fullName,
              duplicateOf,
              `Claws planner identified #${issue.number} as a likely duplicate of this issue (same root cause). Leaving both open; this plan covers both.`,
              { agentName: "Planner" },
            );
          } catch (err) {
            log.warn(`[issue-refiner] Failed to post back-reference on canonical #${duplicateOf}: ${err}`);
          }
        } else if (transferTo !== null) {
          // Neutralise any stray plan header in model output — see TRANSFER_HEADER's doc comment.
          const rationale = (cleanedOutput || "(no further detail provided)").replaceAll(PLAN_HEADER, "Implementation plan");
          await gh.commentOnIssue(fullName, issue.number, [
            TRANSFER_HEADER, ``,
            `The planner determined this issue belongs to **${transferTo}**, not ${fullName}.`, ``,
            rationale, ``,
            `${TRANSFERRED_FROM_MARKER} ${fullName}#${issue.number}`, ``,
            `Claws is transferring this issue now. The destination repository will plan it from`,
            `scratch on the next dispatcher tick. Claws will not transfer it a second time — if the`,
            `destination is wrong, move it back manually.`, ``,
            attribution,
          ].join("\n"), { agentName: "Planner" });

          // A stale `Ready` ("Claws has finished") must not travel to the destination.
          if (issue.labels.some((l) => l.name === LABELS.ready)) {
            await gh.removeLabel(fullName, issue.number, LABELS.ready).catch(() => {});
          }

          try {
            const newUrl = await gh.transferIssue(fullName, issue.number, transferTo);
            log.info(`[issue-refiner] Transferred ${fullName}#${issue.number} to ${transferTo}: ${newUrl}`);
            slack.notify(`:arrow_right: Claws transferred ${fullName}#${issue.number} to ${transferTo} — ${newUrl}`);
          } catch (err) {
            log.warn(`[issue-refiner] Transfer of ${fullName}#${issue.number} to ${transferTo} failed: ${String(err)}`);
            await gh.commentOnIssue(fullName, issue.number,
              `Automatic transfer to \`${transferTo}\` failed — please move this issue manually (Issue → Transfer issue). Applying \`${LABELS.clawsIgnore}\` so Claws stops re-planning it here.`,
              { agentName: "Planner" },
            );
            await gh.addLabel(fullName, issue.number, LABELS.clawsIgnore);
          }
        } else if (blocked) {
          const blockedBody = [
            `The planner determined this issue is blocked on an external precondition and cannot be implemented yet.`,
            ``,
            cleanedOutput || "(no further detail provided)",
            ``,
            `Claws is applying the \`${LABELS.blocked}\` label so it stops re-planning and implementing`,
            `this issue, and is removing \`${LABELS.ready}\` so it no longer sits in the awaiting-review`,
            `pile. The issue stays open as a record. Remove \`${LABELS.blocked}\` (and add \`${LABELS.ready}\`)`,
            `once the blocker clears, or add a watch file under \`docs/upstream-watches/\` in the claws repo`,
            `so Claws unparks it automatically.`,
          ].join("\n");
          await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${blockedBody}\n\n${attribution}`, { agentName: "Planner" });
          await gh.addLabel(fullName, issue.number, LABELS.blocked);
          if (issue.labels.some((l) => l.name === LABELS.ready)) {
            await gh.removeLabel(fullName, issue.number, LABELS.ready).catch(() => {});
          }
          log.info(`[issue-refiner] ${fullName}#${issue.number} is blocked — applied ${LABELS.blocked}`);
        } else if (noCodeChanges) {
          const ncBody = [
            `The planner determined this issue does **not** require any code change to this repository.`,
            ``,
            cleanedOutput || "(no further detail provided)",
            ``,
            `Claws is applying the \`${LABELS.clawsIgnore}\` label so it stops re-planning and`,
            `implementing this issue. The issue stays open as a record. If you believe a code`,
            `change IS needed, remove the \`${LABELS.clawsIgnore}\` label and add the \`${LABELS.ready}\``,
            `label — Claws will re-plan with your comment as context.`,
          ].join("\n");
          await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${ncBody}\n\n${attribution}`, { agentName: "Planner" });
          await gh.addLabel(fullName, issue.number, LABELS.clawsIgnore);
          log.info(`[issue-refiner] ${fullName}#${issue.number} needs no code changes — applied ${LABELS.clawsIgnore}`);
        } else {
          const stepBack = await runStepBack({ repo, issue, wtPath, planBody: cleanedOutput, model, tier, provider, strictProvider, deepPlan: deep, timeoutMs, mcpConfigPath, agentDoc, taskId });
          const finalPlan = stepBack.revisedPlan ?? cleanedOutput;
          await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${finalPlan}\n\n${attribution}${planMarkersFor(issueForPlan, plannedLastCommentId)}`, { agentName: "Planner" });
          log.info(`[issue-refiner] Posted plan for ${fullName}#${issue.number}${stepBack.revisedPlan ? " (revised after step-back)" : ""}`);
          // Must NOT contain PLAN_HEADER — plan lookup elsewhere finds the LAST comment
          // containing it, so a second such comment would hijack that lookup.
          if (stepBack.critique) {
            await gh.commentOnIssue(fullName, issue.number, `${STEP_BACK_HEADER}\n\n${stepBack.critique}`, { agentName: "Planner" });
          }
          await warnIfPlanTooLong(fullName, issue.number, finalPlan.length, "Plan");
          postedPlan = finalPlan;
        }
      } else {
        log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
      }

      if (duplicateOf === null && !noCodeChanges && !blocked && transferTo === null) {
        await gh.addLabel(fullName, issue.number, LABELS.ready);

        if (isAutoRefineIssue(issue)) {
          if (await gh.isAllowedActor(issue.author.login, fullName)) {
            // A fresh plan can land on an issue whose phase-covering PRs have already
            // merged — the old plan comment was deleted, or the steps shipped
            // out-of-band. Handing that to the implementer just makes its all-covered
            // guard strip `Refined` again, so gate on coverage the same way the
            // dispatcher does (#2821).
            const totalPhases = postedPlan ? parsePlan(postedPlan).totalPhases : 1;
            const mergedPRs = await gh.listMergedPRsForIssue(fullName, issue.number).catch(() => []);
            const coverage = await loadPhaseCoverage(fullName, issue.number, totalPhases, comments, mergedPRs);
            if (coverage.nextPhase === null) {
              log.info(`[issue-refiner] Not auto-refining ${fullName}#${issue.number}: all ${totalPhases} plan phase(s) already covered`);
            } else {
              await gh.addLabel(fullName, issue.number, LABELS.refined);
              log.info(`[issue-refiner] Auto-refined issue ${fullName}#${issue.number}`);
            }
          } else {
            log.warn(`[issue-refiner] Skipping auto-Refined for issue ${fullName}#${issue.number} — author @${issue.author.login} is not an allowed actor`);
          }
        }
      }

      db.recordTaskComplete(taskId, { commits: 0 });
    });
  });
}

export async function processRefinement(
  repo: Repo,
  issue: gh.Issue,
  unreactedComments: gh.IssueComment[],
): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Refining plan for ${fullName}#${issue.number}: ${issue.title}`);

  const branchName = `claws/plan-${issue.number}-${claude.randomSuffix()}`;

  await db.withTaskRecording("issue-refiner", fullName, issue.number, null, async (taskId) => {
    await claude.withNewWorktree(repo, branchName, "issue-refiner", async (wtPath) => {
      db.updateTaskWorktree(taskId, wtPath, branchName);

      const [comments, selfLogin, live] = await Promise.all([
        gh.getIssueComments(fullName, issue.number),
        gh.getSelfLoginForRepo(repo.fullName),
        gh.getIssueTitleBody(fullName, issue.number).catch(() => null),
      ]);
      const issueForPlan: gh.Issue = live ? { ...issue, title: live.title, body: live.body } : issue;
      const plannedLastCommentId = maxCommentId(comments);
      const lastPlanIdx = comments.findLastIndex((c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body));
      const mcpConfigPath = claude.writeAgentMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName) });
      const agentDoc = claude.readRepoAgentDoc(wtPath, "issue-refiner");

      const timeoutMs = getItemTimeoutMs(fullName, issue.number);
      // Pinned to opus: same reasoning as processIssue — issue descriptions are
      // often too sparse to classify reliably, and a wrong downgrade propagates
      // downstream. Plan refinement stays on Claude for the same reason as fresh
      // planning — the planner is the top of the implementation chain.
      const tier: ModelTier = "opus";
      const model = planModelForIssue(issue, fullName);
      const deep = isDeepPlan(issue);
      const { provider, strictProvider, overrideIgnoredReason } = planProviderForIssue(issue, fullName);
      if (overrideIgnoredReason) log.warn(`[issue-refiner] ${fullName}#${issue.number}: ${overrideIgnoredReason}`);
      const providerNote = overrideIgnoredReason ? `; ${overrideIgnoredReason}` : "";
      db.updateTaskModel(taskId, model);
      log.info(`[issue-refiner] Using model "${model}" for refinement ${fullName}#${issue.number}`);

      if (lastPlanIdx === -1) {
        log.warn(`[issue-refiner] No plan comment found for ${fullName}#${issue.number}, posting fresh plan`);
        const issueBodyHtml = await gh.getIssueBodyHtml(fullName, issue.number).catch(() => "");
        const htmlBodies = [issueBodyHtml, ...comments.map((c) => c.body_html)];
        const imageContext = await processTextForImages([issueForPlan.body, ...comments.map((c) => c.body)], wtPath, repo, { repo: fullName, issueNumber: issue.number, agentName: "Planner" }, htmlBodies);
        const prompt = buildNewPlanPrompt(repo, issueForPlan, comments, selfLogin, [], [], deep, wtPath) + imageContext;
        let actualProvider: Provider = provider;
        const planOutput = await claude.runClaude(prompt, wtPath, { mcpConfig: mcpConfigPath, timeoutMs, tier, model, provider, strictProvider, deepThinking: deep, appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onTokensUsed: db.trackTaskTokens(taskId), captureLabel: "issue-refiner", githubTokenOwner: repo.owner });

        if (planOutput.trim()) {
          const cleaned = stripLeadingPlanHeader(planOutput);
          const attribution = `*Models used: ${model} (provider: ${actualProvider}${providerNote})*`;
          await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${cleaned}\n\n${attribution}${planMarkersFor(issueForPlan, plannedLastCommentId)}`, { agentName: "Planner" });
          log.info(`[issue-refiner] Posted fresh plan for ${fullName}#${issue.number}`);
          await warnIfPlanTooLong(fullName, issue.number, cleaned.length, "Fresh plan", comments);
        } else {
          log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
        }
      } else {
        const planComment = comments[lastPlanIdx];
        const feedback = unreactedComments;

        // Name the steps that have already shipped. Without this the model sees
        // only the plan and the feedback, and rewrites a partly-shipped multi-PR
        // plan as "the work that is left" — dropping the `### PR N:` headers the
        // merged PRs were numbered against (#2821).
        const parsedExisting = parsePlan(planComment.body);
        let coverageNote = "";
        if (parsedExisting.totalPhases > 1) {
          const mergedPRs = await gh.listMergedPRsForIssue(fullName, issue.number).catch(() => []);
          const coverage = await loadPhaseCoverage(fullName, issue.number, parsedExisting.totalPhases, comments, mergedPRs);
          const shipped = [...coverage.done].sort((a, b) => a - b).map((n) => {
            const pr = coverage.coveringPRs.get(n);
            return `step ${n}${pr ? ` (PR #${pr.number}, merged)` : " (claimed)"}`;
          });
          if (shipped.length > 0) {
            coverageNote = `\n\nAlready shipped and NOT to be re-planned or renumbered: ${shipped.join(", ")}. Keep their \`### PR N:\` headers in place.`;
          }
        }

        const issueBodyHtml = await gh.getIssueBodyHtml(fullName, issue.number).catch(() => "");
        const imageContext = await processTextForImages([issueForPlan.body], wtPath, repo, { repo: fullName, issueNumber: issue.number, agentName: "Planner" }, [issueBodyHtml, ...comments.map((c) => c.body_html)]);
        const prompt = buildRefinementPrompt(repo, issueForPlan, planComment.body, parsedExisting, feedback, selfLogin, deep, wtPath) + imageContext + coverageNote;
        let actualProvider: Provider = provider;
        const planOutput = await claude.runClaude(prompt, wtPath, { mcpConfig: mcpConfigPath, timeoutMs, tier, model, provider, strictProvider, deepThinking: deep, appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onTokensUsed: db.trackTaskTokens(taskId), captureLabel: "issue-refiner", githubTokenOwner: repo.owner });

        // Parse before the emptiness check: a model that returns only a `### Response`
        // section would otherwise pass `planOutput.trim()` and then overwrite the plan
        // comment with an empty body.
        const responseMatch = planOutput.match(/### Response\s*\n([\s\S]*)$/);
        const planBody = responseMatch
          ? planOutput.slice(0, responseMatch.index).trim()
          : planOutput;
        const cleanedPlanBody = stripLeadingPlanHeader(planBody);

        if (cleanedPlanBody.trim()) {
          // Build attribution, preserving the original model and replacing any prior
          // "Refined with" segment so it doesn't grow unboundedly on each refinement.
          const newAttribution = `*Models used: ${model} (provider: ${actualProvider}${providerNote})*`;
          const existingAttrib = extractModelsAttribution(planComment.body);
          const attribution = (() => {
            if (!existingAttrib) return newAttribution;
            // Extract the original model (first segment before any | Refined with: ...)
            const originalPart = existingAttrib
              .replace(/^\*Models used:\s*/, "")
              .replace(/\*$/, "")
              .split(/\s*\|\s*/)[0]
              .trim();
            const originalAttrib = `*Models used: ${originalPart}*`;
            if (originalAttrib === newAttribution) return newAttribution;
            return `*Models used: ${originalPart} | Refined with: ${model} (provider: ${actualProvider}${providerNote})*`;
          })();

          // A refinement that changes the step count re-bases phase accounting for
          // PRs that already merged under the old numbering (#2821). The plan body
          // is written through regardless — rejecting it would silently discard the
          // operator's feedback — but the change is recorded so the downstream
          // all-covered state can be traced back to it.
          const refinedTotal = parsePlan(cleanedPlanBody).totalPhases;
          if (parsedExisting.totalPhases > 1 && refinedTotal !== parsedExisting.totalPhases) {
            log.warn(`[issue-refiner] Refinement changed the phase count for ${fullName}#${issue.number}: ${parsedExisting.totalPhases} -> ${refinedTotal}`);
          }

          await gh.editIssueComment(fullName, planComment.id, `${PLAN_HEADER}\n\n${cleanedPlanBody}\n\n${attribution}${planMarkersFor(issueForPlan, plannedLastCommentId)}`, { agentName: "Planner" });
          log.info(`[issue-refiner] Updated plan comment for ${fullName}#${issue.number}`);

          // Only human feedback earns a reply comment. Occurrence-triggered re-plans
          // (ISSUE_REFINER_REPLAN passes an empty feedback list) posted a "no feedback
          // was left, so I re-verified…" comment on every pass — four on
          // fleet-infra#878 alone (#2558). The section is still sliced out of the plan
          // body above, so a disobedient model can't leak it into the plan either.
          if (feedback.length > 0 && responseMatch && responseMatch[1].trim()) {
            await gh.commentOnIssue(fullName, issue.number, responseMatch[1].trim(), { agentName: "Planner" });
            log.info(`[issue-refiner] Posted response comment for ${fullName}#${issue.number}`);
          }

          await warnIfPlanTooLong(fullName, issue.number, cleanedPlanBody.length, "Refined plan", comments);
        } else {
          // Re-stamp anyway: a model returning nothing would otherwise leave the plan's
          // hash pinned to the pre-edit body, and the dispatcher would re-plan forever.
          // stripClawsMarker first — editIssueComment re-prepends the header, so
          // echoing the raw comment body back would duplicate it on every empty run.
          await gh.editIssueComment(
            fullName,
            planComment.id,
            `${stripPlanMarkers(gh.stripClawsMarker(planComment.body))}${planMarkersFor(issueForPlan, plannedLastCommentId)}`,
            { agentName: "Planner" },
          );
          if (feedback.length > 0 && responseMatch && responseMatch[1].trim()) {
            await gh.commentOnIssue(fullName, issue.number, responseMatch[1].trim(), { agentName: "Planner" });
          }
          log.warn(`[issue-refiner] Empty or response-only refinement output for ${fullName}#${issue.number} — re-stamped plan markers to avoid a re-plan loop`);
        }
      }

      // React 👍 to each addressed comment
      for (const comment of unreactedComments) {
        await gh.addReaction(fullName, comment.id, "+1");
      }

      await gh.addLabel(fullName, issue.number, LABELS.ready);
      db.recordTaskComplete(taskId, { commits: 0 });
    });
  });
}

export async function processFollowUp(
  repo: Repo,
  issue: gh.Issue,
  openPR: gh.PR,
  unreactedComments: gh.IssueComment[],
): Promise<void> {
  const openPRNumber = openPR.number;
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Responding to follow-up on ${fullName}#${issue.number}: ${issue.title}`);

  const branchName = `claws/plan-${issue.number}-${claude.randomSuffix()}`;

  await db.withTaskRecording("issue-refiner", fullName, issue.number, null, async (taskId) => {
    await claude.withNewWorktree(repo, branchName, "issue-refiner", async (wtPath) => {
      db.updateTaskWorktree(taskId, wtPath, branchName);

      const [comments, selfLogin] = await Promise.all([
        gh.getIssueComments(fullName, issue.number),
        gh.getSelfLoginForRepo(repo.fullName),
      ]);
      const lastPlanIdx = comments.findLastIndex(
        (c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body),
      );

      if (lastPlanIdx === -1) {
        log.warn(`[issue-refiner] No plan comment found for follow-up on ${fullName}#${issue.number}, skipping`);
        db.recordTaskComplete(taskId, { commits: 0 });
        return;
      }

      const planComment = comments[lastPlanIdx];
      const issueBodyHtml = await gh.getIssueBodyHtml(fullName, issue.number).catch(() => "");
      const imageContext = await processTextForImages([issue.body], wtPath, repo, { repo: fullName, issueNumber: issue.number, agentName: "Planner" }, [issueBodyHtml, ...comments.map((c) => c.body_html)]);

      const guardCtx = makeGuardCtx(fullName, issue.number);
      const [prBody, prFiles] = await Promise.all([
        gh.getPRBody(fullName, openPRNumber).catch(() => ""),
        gh.getPRChangedFiles(fullName, openPRNumber).catch(() => [] as string[]),
      ]);
      const prSummary = [
        `Here is what PR #${openPRNumber} actually contains:`,
        ``,
        `Title: ${guardContent(openPR.title, guardCtx("pr-title"))}`,
        ``,
        `Body:`,
        guardContent(prBody.slice(0, 4000), guardCtx("pr-body")) || "(no body)",
        ``,
        `Changed files (${prFiles.length}):`,
        ...prFiles.slice(0, 50).map((f) => `- ${f}`),
        ...(prFiles.length > 50 ? [`- …and ${prFiles.length - 50} more`] : []),
      ].join("\n");

      const prompt = buildFollowUpPrompt(repo, issue, planComment.body, openPRNumber, unreactedComments, selfLogin, wtPath, prSummary) + imageContext;

      const mcpConfigPath = claude.writeAgentMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName) });
      const agentDoc = claude.readRepoAgentDoc(wtPath, "issue-refiner");
      const timeoutMs = getItemTimeoutMs(fullName, issue.number);
      // Follow-ups don't need complexity classification — the issue is already planned
      // and we're just responding to questions, so the default tier is sufficient.
      // Stays on Claude for the same reason as the main planner path.
      const { provider, strictProvider } = planProviderForIssue(issue, fullName);
      const model = getModel("sonnet", provider);
      db.updateTaskModel(taskId, model);
      const response = await claude.runClaude(prompt, wtPath, { mcpConfig: mcpConfigPath, timeoutMs, tier: "sonnet", model, provider, strictProvider, appendSystemPrompt: agentDoc, captureLabel: "issue-refiner", githubTokenOwner: repo.owner });

      if (response.trim()) {
        await gh.commentOnIssue(fullName, issue.number, response, { agentName: "Planner" });
        log.info(`[issue-refiner] Posted follow-up response for ${fullName}#${issue.number}`);
      } else {
        log.warn(`[issue-refiner] Empty follow-up response for ${fullName}#${issue.number}`);
      }

      for (const comment of unreactedComments) {
        await gh.addReaction(fullName, comment.id, "+1");
      }

      db.recordTaskComplete(taskId, { commits: 0 });
    });
  });
}

export async function findUnreactedHumanComments(
  fullName: string,
  commentsAfterPlan: gh.IssueComment[],
  selfLogin: string,
): Promise<gh.IssueComment[]> {
  // Phase A: synchronous filters + sequential isAllowedActor (async).
  const candidates: gh.IssueComment[] = [];
  for (const comment of commentsAfterPlan) {
    if (gh.isClawsComment(comment.body)) continue;
    if (comment.login.endsWith("[bot]")) continue;
    if (!await gh.isAllowedActor(comment.login, fullName)) continue;
    candidates.push(comment);
  }

  // Phase B: independent reaction fetches in parallel; per-item catch
  // defaults a failed fetch to "unreacted" (preserves old behavior).
  const results = await Promise.all(
    candidates.map(async (comment) => {
      try {
        const reactions = await gh.getCommentReactions(fullName, comment.id);
        const hasReaction = reactions.some(
          (r) => r.user.login === selfLogin && r.content === "+1",
        );
        return hasReaction ? null : comment;
      } catch {
        return comment;
      }
    }),
  );
  return results.filter((c): c is gh.IssueComment => c !== null);
}

/**
 * Comments the plan did not see: those after the plan comment, plus any created
 * during the run (id greater than the id stamped at run start). Comment ids are
 * monotonically increasing, so this is a reliable "arrived after we snapshotted"
 * test.
 *
 * The fence has three states: `fence === null` means a legacy plan predating the
 * marker, where only the after-the-plan-only fallback applies; `fence === 0` means
 * the run's snapshot held no comments at all (a brand-new issue), so every comment
 * on the issue counts as feedback, including ones that landed before the plan
 * comment in thread order; any other value is the highest comment id the run had
 * actually seen (#2524, #2623).
 */
export function selectFeedbackCandidates(
  comments: gh.IssueComment[],
  lastPlanIdx: number,
): gh.IssueComment[] {
  const fence = parsePlanLastCommentId(comments[lastPlanIdx].body);
  const planId = comments[lastPlanIdx].id;
  return comments.filter(
    (c, i) => i > lastPlanIdx || (fence !== null && c.id > fence && c.id !== planId),
  );
}

export async function findUnreactedFeedbackAfterPlan(
  fullName: string,
  issueNumber: number,
  selfLogin: string,
): Promise<{ hasPlan: boolean; unreacted: gh.IssueComment[]; plannedOccurrences: number | null; hasEscalationReview: boolean; plannedBodyHash: string | null }> {
  const comments = await gh.getIssueComments(fullName, issueNumber);
  const lastPlanIdx = comments.findLastIndex(
    (c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body),
  );
  if (lastPlanIdx === -1) {
    return { hasPlan: false, unreacted: [], plannedOccurrences: null, hasEscalationReview: false, plannedBodyHash: null };
  }
  const after = comments.slice(lastPlanIdx + 1);
  const unreacted = await findUnreactedHumanComments(
    fullName,
    selectFeedbackCandidates(comments, lastPlanIdx),
    selfLogin,
  );
  // Scanned only AFTER the last plan on purpose: a re-plan invalidates the old
  // verdict, so a fresh escalation review runs against the new plan.
  const hasEscalationReview = after.some(
    (c) => gh.isClawsComment(c.body) && c.body.includes(ESCALATION_REVIEW_HEADER),
  );
  return {
    hasPlan: true,
    unreacted,
    plannedOccurrences: parsePlannedOccurrences(comments[lastPlanIdx].body),
    hasEscalationReview,
    plannedBodyHash: parsePlanBodyHash(comments[lastPlanIdx].body),
  };
}

export async function stripRefinedForPendingFeedback(
  fullName: string,
  issueNumber: number,
  unreacted: gh.IssueComment[],
  agentName: string,
): Promise<void> {
  try {
    const newestId = Math.max(...unreacted.map((c) => c.id));
    const notice = `${PENDING_FEEDBACK_MARKER}: ${newestId}`;
    await gh.removeLabel(fullName, issueNumber, LABELS.refined);
    log.info(`[issue-refiner] Removed ${LABELS.refined} from ${fullName}#${issueNumber}: ${unreacted.length} unaddressed human comment(s) after the plan`);
    const comments = await gh.getIssueComments(fullName, issueNumber);
    if (comments.some((c) => c.body.includes(notice))) return;
    await gh.commentOnIssue(fullName, issueNumber, [
      `There is human feedback on this issue that the plan above has not addressed yet, so implementing now would build the wrong thing.`,
      ``,
      `Claws has removed the \`${LABELS.refined}\` label. The planner will address the comment(s), update the plan in place and reply, then re-apply \`${LABELS.ready}\`. Re-apply \`${LABELS.refined}\` once the updated plan looks right.`,
      ``,
      notice,
    ].join("\n"), { agentName });
  } catch (err) {
    // Never let this break the dispatcher/worker loop — a transient GitHub failure
    // here must not abort the rest of a repo's Phase 1/2/3 pass or a worker run.
    log.warn(`[issue-refiner] Failed to strip ${LABELS.refined} for pending feedback on ${fullName}#${issueNumber}: ${String(err)}`);
  }
}
