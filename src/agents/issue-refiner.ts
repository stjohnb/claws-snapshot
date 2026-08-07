import { LABELS, HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { getItemTimeoutMs } from "../timeout-handler.js";
import { processTextForImages } from "../images.js";
import { RUNNER_POLICY_CONTEXT, frontendContext, homeAssistantContext, formatIssueCommentsForPrompt } from "./agent-context.js";
import { isHomeAssistantConfigRepo } from "../home-assistant.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { getModel, type ModelTier } from "../model-selector.js";
import { extractModelsAttribution, type Provider } from "../plan-parser.js";
import { parseOccurrenceCount } from "../occurrence-tracking.js";
import { parseFirstValidJson } from "../json-extract.js";
import * as slack from "../slack.js";
import { z } from "zod";

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

/** API id for Claude Fable 5 — opt-in per-issue via the "Plan: Fable" label. */
export const FABLE_MODEL = "claude-fable-5";

function planModelForIssue(issue: gh.Issue): string {
  if (issue.labels.some((l) => l.name === LABELS.planFable)) return FABLE_MODEL;
  return getModel("opus", "text-only", "claude");
}

export const MAX_DUPLICATE_CANDIDATES = 20;
export const DUPLICATE_CANDIDATE_BODY_LIMIT = 500;
export const PLAN_LENGTH_WARN_CHARS = 15_000;

function planLengthWarning(len: number): string {
  return `> [!WARNING]\n> This plan is ${len.toLocaleString()} characters, which exceeds the recommended limit (~${PLAN_LENGTH_WARN_CHARS.toLocaleString()} chars). The implementer may run low on context before completing all changes. Consider commenting with feedback to request a more concise re-plan.`;
}

async function warnIfPlanTooLong(
  fullName: string,
  issueNumber: number,
  length: number,
  label: string,
): Promise<void> {
  if (length <= PLAN_LENGTH_WARN_CHARS) return;
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

export type IssueClassification = "auto" | "needs_human" | "out_of_scope" | "duplicate" | "obsolete";
export interface RankedIssue { number: number; classification: IssueClassification; reason: string; duplicateOf?: number; }

const RankingSchema = z.object({
  ranking: z.array(z.object({
    number: z.number(),
    classification: z.enum(["auto", "needs_human", "out_of_scope", "duplicate", "obsolete"]),
    duplicateOf: z.number().optional(),
    reason: z.string(),
  })),
});

// #2103: assess ALL open candidate issues together and return them in priority
// order (most pressing first) with a per-issue autonomy classification. Errs toward
// needs_human / out_of_scope. Returns null on parse failure (caller then waits).
export async function prioritiseIssues(
  repoFullName: string,
  candidates: { issue: gh.Issue; planText: string | null }[],
): Promise<RankedIssue[] | null> {
  const blocks = candidates.map(({ issue, planText }) => {
    const guardCtx = makeGuardCtx(repoFullName, issue.number);
    return [
      `--- ISSUE #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
      guardContent(issue.body ?? "", guardCtx("issue-body")) || "(no description)",
      planText ? `PROPOSED PLAN:\n${planText}` : `PROPOSED PLAN: (none yet)`,
    ].join("\n");
  }).join("\n\n");

  const prompt = [
    `You are sequencing open GitHub issues for repo ${repoFullName} for FULLY AUTONOMOUS`,
    `processing (Claws will implement AND merge without human plan review).`,
    ``,
    `Establish a PRIORITY ORDER across ALL issues below. Do NOT assume the issue number`,
    `reflects priority or the order to work in — issues are filed in arbitrary order.`,
    `Rank by: which issue is most pressing for resolving an active outage/incident, and`,
    `whether fixes have a natural dependency order (e.g. a code fix must land before the`,
    `deployment change that ships it). Put the most pressing issue first.`,
    ``,
    `Classify EACH issue:`,
    `- "auto": an incident / bug / operational failure whose plan is a small,`,
    `  non-controversial, mechanical fix with an obvious correct implementation and low`,
    `  blast radius — no product/design judgement, API-shape decision, or irreversible action.`,
    `- "needs_human": in scope (incident/fix) but controversial, ambiguous, high blast`,
    `  radius, or requiring judgement Claws should not make alone.`,
    `- "out_of_scope": a feature request, refactor, or open-ended "improvement" — Claws`,
    `  must NOT process these autonomously.`,
    `- "duplicate": shares a ROOT CAUSE with another issue listed below. Pick ONE canonical`,
    `  issue per root cause (the one with the best evidence or an existing plan) and classify`,
    `  it normally; classify every other issue in that group "duplicate" and set "duplicateOf"`,
    `  to the canonical issue's number. Superficial textual similarity is NOT a duplicate.`,
    `- "obsolete": no longer applicable — the described failure was already fixed, references`,
    `  code/config that no longer exists, or is a one-off alert whose condition has cleared.`,
    `  Claws will CLOSE these, so only use it when you are confident.`,
    `Answer conservatively: when unsure between auto and needs_human, choose needs_human.`,
    `When unsure whether something is obsolete, do NOT use "obsolete".`,
    ``,
    blocks,
    ``,
    `Respond with ONLY a JSON object: {"ranking":[{"number":N,"classification":"auto|needs_human|out_of_scope|duplicate|obsolete","duplicateOf":N_or_omitted,"reason":"<one sentence>"}, ...]}`,
    `List EVERY issue exactly once, ordered most-pressing first. No other text.`,
  ].join("\n");

  const wt = claude.ensureScratchDir("sequential-issue-processor");
  try {
    const out = await claude.runClaude(prompt, wt, {
      capability: "text-only", tier: "opus", timeoutMs: 180_000, provider: "claude",
      disallowedTools: claude.TEXT_ONLY_DISALLOWED_TOOLS,
    });
    const parsed = parseFirstValidJson(out, RankingSchema, "sequential-prioritise");
    return parsed?.ranking ?? null;
  } catch (err) {
    log.warn(`[sequential] prioritiseIssues failed for ${repoFullName}: ${String(err)}`);
    return null;
  }
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

const FABLE_PLANNING_CONTEXT = [
  `This issue was explicitly labelled for planning with Claude Fable 5, a model tier above the`,
  `default planner. The label signals the issue is unusually hard, ambiguous, or high-stakes.`,
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


function buildDuplicateCandidatesSection(
  fullName: string,
  currentIssueNumber: number,
  candidates: gh.Issue[],
): string {
  if (candidates.length === 0) return "";
  const guardCtx = makeGuardCtx(fullName, currentIssueNumber);
  const lines: string[] = [
    ``,
    `## Possible Duplicate Candidates`,
    ``,
    `The following open issues in this repository have a LOWER issue number than #${currentIssueNumber}. If this issue has the SAME ROOT CAUSE as any of them (for example, multiple alerts caused by one underlying failure), it should be treated as a duplicate of the lowest-numbered matching one.`,
    ``,
  ];
  for (const c of candidates) {
    const guardedTitle = guardContent(c.title, guardCtx("issue-title"));
    const guardedBody = guardContent(c.body ?? "", guardCtx("issue-body"));
    const trunc = guardedBody.length > DUPLICATE_CANDIDATE_BODY_LIMIT
      ? guardedBody.slice(0, DUPLICATE_CANDIDATE_BODY_LIMIT) + "..."
      : guardedBody;
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
  fullName: string,
  issue: gh.Issue,
  existingPlan: string,
  feedback: gh.IssueComment[],
  selfLogin: string,
  isFable: boolean,
  wtPath: string,
): string {
  const guardCtx = makeGuardCtx(fullName, issue.number);
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
    frontendContext(wtPath),
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
    MULTI_PR_INSTRUCTIONS,
    ``,
    IMPLEMENTER_GUIDANCE_INSTRUCTIONS,
    ...(isFable ? [``, FABLE_PLANNING_CONTEXT] : []),
    ``,
    MODEL_SELECTION_INSTRUCTIONS,
    ``,
    REVIEW_MODEL_INSTRUCTIONS,
    ``,
    `After the updated plan, include a \`### Response\` section that:`,
    `- Directly answers any questions asked in the feedback`,
    `- Acknowledges concerns or suggestions`,
    `- Notes any surprises or deviations from the original plan`,
    ``,
    `This section will be posted as a separate follow-up comment on the issue, so write it in a conversational tone addressing the commenter(s). If there is no feedback to respond to, omit this section entirely.`,
    ``,
    NO_HTML_COMMENTS_INSTRUCTION,
    ``,
    `Do NOT make any code changes. Only produce the plan as text output.`,
  ].join("\n");
}

function buildFollowUpPrompt(
  fullName: string,
  issue: gh.Issue,
  existingPlan: string,
  openPRNumber: number,
  followUpComments: gh.IssueComment[],
  selfLogin: string,
  wtPath: string,
): string {
  const guardCtx = makeGuardCtx(fullName, issue.number);
  return [
    `You are responding to follow-up questions on a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    guardContent(issue.body, guardCtx("issue-body")) || "(No description provided)",
    ``,
    `An implementation plan was already produced and a PR #${openPRNumber} is open to implement it.`,
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
    frontendContext(wtPath),
    WORKTREE_ENVIRONMENT_NOTE,
    RESEARCH_INSTRUCTIONS,
    ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
    ``,
    `Please respond to the follow-up comments above. Answer questions, provide clarifications, or address concerns.`,
    `Do NOT produce a new implementation plan — the implementation is already in progress via PR #${openPRNumber}.`,
    `If the comments suggest changes that should be made to the PR, mention that in your response.`,
    ``,
    `Do NOT make any code changes. Only produce your response as text output.`,
  ].join("\n");
}

function buildNewPlanPrompt(
  fullName: string,
  issue: gh.Issue,
  comments: gh.IssueComment[],
  selfLogin: string,
  duplicateCandidates: gh.Issue[],
  transferCandidates: string[],
  isFable: boolean,
  wtPath: string,
): string {
  const guardCtx = makeGuardCtx(fullName, issue.number);
  return [
    `You are analyzing a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    guardContent(issue.body, guardCtx("issue-body")) || "(No description provided)",
    ``,
    ...formatIssueCommentsForPrompt(comments, selfLogin, guardCtx),
    `If \`docs/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant to the issue) for context about the codebase architecture and patterns.`,
    RUNNER_POLICY_CONTEXT,
    frontendContext(wtPath),
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
    IMPLEMENTER_GUIDANCE_INSTRUCTIONS,
    ...(isFable ? [``, FABLE_PLANNING_CONTEXT] : []),
    ``,
    MODEL_SELECTION_INSTRUCTIONS,
    ``,
    REVIEW_MODEL_INSTRUCTIONS,
    ``,
    NO_HTML_COMMENTS_INSTRUCTION,
    ``,
    NO_CODE_CHANGES_INSTRUCTION,
    ``,
    `Do NOT make any code changes. Only produce the plan as text output.`,
    buildTransferCandidatesSection(fullName, transferCandidates),
    buildDuplicateCandidatesSection(fullName, issue.number, duplicateCandidates),
  ].join("\n");
}

function buildStepBackPrompt(fullName: string, issue: gh.Issue, planBody: string, isFable: boolean, wtPath: string): string {
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
    `- Do NOT emit a DUPLICATE_OF line or the ${NO_CODE_CHANGES_MARKER} marker — those`,
    `  verdicts were already decided.`,
    ``,
    `The replacement plan must have the same shape as a normal plan:`,
    RUNNER_POLICY_CONTEXT,
    frontendContext(wtPath),
    WORKTREE_ENVIRONMENT_NOTE,
    ``,
    MULTI_PR_INSTRUCTIONS,
    ``,
    IMPLEMENTER_GUIDANCE_INSTRUCTIONS,
    ...(isFable ? [``, FABLE_PLANNING_CONTEXT] : []),
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
  fullName: string;
  issue: gh.Issue;
  wtPath: string;
  planBody: string;
  model: string;
  tier: ModelTier;
  timeoutMs: number | undefined;
  mcpConfigPath: string;
  agentDoc: string | undefined;
  taskId: number;
}): Promise<{ revisedPlan: string | null; critique: string | null }> {
  const none = { revisedPlan: null, critique: null };
  if (!stepBackEnabled()) return none;
  if (opts.planBody.length < STEP_BACK_MIN_PLAN_CHARS) return none;

  try {
    const prompt = buildStepBackPrompt(opts.fullName, opts.issue, opts.planBody, opts.model === FABLE_MODEL, opts.wtPath);
    const out = await claude.runClaude(prompt, opts.wtPath, {
      capability: "text-only",
      mcpConfig: opts.mcpConfigPath,
      timeoutMs: opts.timeoutMs,
      tier: opts.tier,
      model: opts.model,
      provider: "claude",
      appendSystemPrompt: opts.agentDoc,
      onTokensUsed: db.trackTaskTokens(opts.taskId),
      captureLabel: "issue-refiner-step-back",
    });

    // An absent or unparseable marker deliberately means "sound".
    if (parseStepBackVerdict(out) !== "reconsider") {
      log.info(`[issue-refiner] Step-back pass found the plan sound for ${opts.fullName}#${opts.issue.number}`);
      return none;
    }

    const { critique, revisedPlan } = splitStepBackOutput(out);
    // A stray marker in the replacement text must not leak into the posted comment.
    const cleaned = revisedPlan
      ? stripDuplicateMarker(stripNoCodeChangesMarker(stripLeadingPlanHeader(revisedPlan)))
      : "";
    if (!cleaned.trim()) {
      log.warn(`[issue-refiner] Step-back said "reconsider" for ${opts.fullName}#${opts.issue.number} but produced no usable replacement plan — keeping the original`);
      return { revisedPlan: null, critique: critique || null };
    }
    return { revisedPlan: cleaned, critique: critique || null };
  } catch (err) {
    log.warn(`[issue-refiner] Step-back pass failed for ${opts.fullName}#${opts.issue.number}: ${err}`);
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

export function selectTransferCandidates(currentRepo: Repo, allRepos: Repo[]): string[] {
  return allRepos
    .filter((r) => r.owner === currentRepo.owner && r.fullName !== currentRepo.fullName)
    .map((r) => r.fullName).sort().slice(0, MAX_TRANSFER_CANDIDATES);
}

export async function processIssue(repo: Repo, issue: gh.Issue): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Planning ${fullName}#${issue.number}: ${issue.title}`);

  const branchName = `claws/plan-${issue.number}-${claude.randomSuffix()}`;

  await db.withTaskRecording("issue-refiner", fullName, issue.number, null, async (taskId) => {
    await claude.withNewWorktree(repo, branchName, "issue-refiner", async (wtPath) => {
      db.updateTaskWorktree(taskId, wtPath, branchName);

      const [comments, selfLogin, allOpenIssues, allRepos] = await Promise.all([
        gh.getIssueComments(fullName, issue.number),
        gh.getSelfLogin(repo.owner),
        gh.listOpenIssues(fullName),
        gh.listRepos().catch(() => []),
      ]);
      const duplicateCandidates = selectDuplicateCandidates(fullName, issue, allOpenIssues);
      const transferCandidates = transferEnabled()
        && !alreadyTransferredInto(fullName, [issue.body ?? "", ...comments.map((c) => c.body)])
        ? selectTransferCandidates(repo, allRepos) : [];
      const issueBodyHtml = await gh.getIssueBodyHtml(fullName, issue.number).catch(() => "");
      const htmlBodies = [issueBodyHtml, ...comments.map((c) => c.body_html)];
      const imageContext = await processTextForImages([issue.body, ...comments.map((c) => c.body)], wtPath, repo, { repo: fullName, issueNumber: issue.number, agentName: "Planner" }, htmlBodies);
      const model = planModelForIssue(issue);
      const prompt = buildNewPlanPrompt(fullName, issue, comments, selfLogin, duplicateCandidates, transferCandidates, model === FABLE_MODEL, wtPath) + imageContext;

      const mcpConfigPath = claude.writeClawsMcpConfig(wtPath, { includeNameyDb: false, includeHomeAssistant: isHomeAssistantConfigRepo(fullName) });
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
      let actualProvider: Provider = "claude";
      const planOutput = await claude.runClaude(prompt, wtPath, { capability: "text-only", mcpConfig: mcpConfigPath, timeoutMs, tier, model, provider: "claude", appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onTokensUsed: db.trackTaskTokens(taskId), captureLabel: "issue-refiner" });

      const candidateNumbers = duplicateCandidates.map((c) => c.number);
      const duplicateOf = candidateNumbers.length > 0 ? parseDuplicateOf(planOutput, candidateNumbers) : null;
      const transferTo = duplicateOf === null && transferCandidates.length > 0
        ? parseTransferTarget(planOutput, transferCandidates) : null;
      const noCodeChanges = duplicateOf === null && transferTo === null && parseNoCodeChanges(planOutput);
      const cleanedOutput = stripTransferMarker(stripNoCodeChangesMarker(stripLeadingPlanHeader(stripDuplicateMarker(planOutput))));

      if (cleanedOutput.trim() || duplicateOf !== null || noCodeChanges || transferTo !== null) {
        const attribution = `*Models used: ${model} (provider: ${actualProvider})*`;
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
          const stepBack = await runStepBack({ fullName, issue, wtPath, planBody: cleanedOutput, model, tier, timeoutMs, mcpConfigPath, agentDoc, taskId });
          const finalPlan = stepBack.revisedPlan ?? cleanedOutput;
          await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${finalPlan}\n\n${attribution}${occurrenceMarkerFor(issue.body)}`, { agentName: "Planner" });
          log.info(`[issue-refiner] Posted plan for ${fullName}#${issue.number}${stepBack.revisedPlan ? " (revised after step-back)" : ""}`);
          // Must NOT contain PLAN_HEADER — plan lookup elsewhere finds the LAST comment
          // containing it, so a second such comment would hijack that lookup.
          if (stepBack.critique) {
            await gh.commentOnIssue(fullName, issue.number, `${STEP_BACK_HEADER}\n\n${stepBack.critique}`, { agentName: "Planner" });
          }
          await warnIfPlanTooLong(fullName, issue.number, finalPlan.length, "Plan");
        }
      } else {
        log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
      }

      if (duplicateOf === null && !noCodeChanges && transferTo === null) {
        await gh.addLabel(fullName, issue.number, LABELS.ready);

        if (isCiUnrelatedIssue(issue)) {
          if (await gh.isAllowedActor(issue.author.login)) {
            await gh.addLabel(fullName, issue.number, LABELS.refined);
            log.info(`[issue-refiner] Auto-refined ci-unrelated issue ${fullName}#${issue.number}`);
          } else {
            log.warn(`[issue-refiner] Skipping auto-Refined for ci-unrelated issue ${fullName}#${issue.number} — author @${issue.author.login} is not an allowed actor`);
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

      const [comments, selfLogin] = await Promise.all([
        gh.getIssueComments(fullName, issue.number),
        gh.getSelfLogin(repo.owner),
      ]);
      const lastPlanIdx = comments.findLastIndex((c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body));
      const mcpConfigPath = claude.writeClawsMcpConfig(wtPath, { includeNameyDb: false, includeHomeAssistant: isHomeAssistantConfigRepo(fullName) });
      const agentDoc = claude.readRepoAgentDoc(wtPath, "issue-refiner");

      const timeoutMs = getItemTimeoutMs(fullName, issue.number);
      // Pinned to opus: same reasoning as processIssue — issue descriptions are
      // often too sparse to classify reliably, and a wrong downgrade propagates
      // downstream. Plan refinement stays on Claude for the same reason as fresh
      // planning — the planner is the top of the implementation chain.
      const tier: ModelTier = "opus";
      const model = planModelForIssue(issue);
      db.updateTaskModel(taskId, model);
      log.info(`[issue-refiner] Using model "${model}" for refinement ${fullName}#${issue.number}`);

      if (lastPlanIdx === -1) {
        log.warn(`[issue-refiner] No plan comment found for ${fullName}#${issue.number}, posting fresh plan`);
        const issueBodyHtml = await gh.getIssueBodyHtml(fullName, issue.number).catch(() => "");
        const htmlBodies = [issueBodyHtml, ...comments.map((c) => c.body_html)];
        const imageContext = await processTextForImages([issue.body, ...comments.map((c) => c.body)], wtPath, repo, { repo: fullName, issueNumber: issue.number, agentName: "Planner" }, htmlBodies);
        const prompt = buildNewPlanPrompt(fullName, issue, comments, selfLogin, [], [], model === FABLE_MODEL, wtPath) + imageContext;
        let actualProvider: Provider = "claude";
        const planOutput = await claude.runClaude(prompt, wtPath, { capability: "text-only", mcpConfig: mcpConfigPath, timeoutMs, tier, model, provider: "claude", appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onTokensUsed: db.trackTaskTokens(taskId), captureLabel: "issue-refiner" });

        if (planOutput.trim()) {
          const cleaned = stripLeadingPlanHeader(planOutput);
          const attribution = `*Models used: ${model} (provider: ${actualProvider})*`;
          await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${cleaned}\n\n${attribution}${occurrenceMarkerFor(issue.body)}`, { agentName: "Planner" });
          log.info(`[issue-refiner] Posted fresh plan for ${fullName}#${issue.number}`);
          await warnIfPlanTooLong(fullName, issue.number, cleaned.length, "Fresh plan");
        } else {
          log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
        }
      } else {
        const planComment = comments[lastPlanIdx];
        const feedback = unreactedComments;

        const issueBodyHtml = await gh.getIssueBodyHtml(fullName, issue.number).catch(() => "");
        const imageContext = await processTextForImages([issue.body], wtPath, repo, { repo: fullName, issueNumber: issue.number, agentName: "Planner" }, [issueBodyHtml, ...comments.map((c) => c.body_html)]);
        const prompt = buildRefinementPrompt(fullName, issue, planComment.body, feedback, selfLogin, model === FABLE_MODEL, wtPath) + imageContext;
        let actualProvider: Provider = "claude";
        const planOutput = await claude.runClaude(prompt, wtPath, { capability: "text-only", mcpConfig: mcpConfigPath, timeoutMs, tier, model, provider: "claude", appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onTokensUsed: db.trackTaskTokens(taskId), captureLabel: "issue-refiner" });

        if (planOutput.trim()) {
          // Check for "### Response" section to post as a separate follow-up comment
          const responseMatch = planOutput.match(/### Response\s*\n([\s\S]*)$/);
          const planBody = responseMatch
            ? planOutput.slice(0, responseMatch.index).trim()
            : planOutput;
          const cleanedPlanBody = stripLeadingPlanHeader(planBody);

          // Build attribution, preserving the original model and replacing any prior
          // "Refined with" segment so it doesn't grow unboundedly on each refinement.
          const newAttribution = `*Models used: ${model} (provider: ${actualProvider})*`;
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
            return `*Models used: ${originalPart} | Refined with: ${model} (provider: ${actualProvider})*`;
          })();

          await gh.editIssueComment(fullName, planComment.id, `${PLAN_HEADER}\n\n${cleanedPlanBody}\n\n${attribution}${occurrenceMarkerFor(issue.body)}`, { agentName: "Planner" });
          log.info(`[issue-refiner] Updated plan comment for ${fullName}#${issue.number}`);

          if (responseMatch && responseMatch[1].trim()) {
            await gh.commentOnIssue(fullName, issue.number, responseMatch[1].trim(), { agentName: "Planner" });
            log.info(`[issue-refiner] Posted response comment for ${fullName}#${issue.number}`);
          }

          await warnIfPlanTooLong(fullName, issue.number, cleanedPlanBody.length, "Refined plan");
        } else {
          log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
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
  openPRNumber: number,
  unreactedComments: gh.IssueComment[],
): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Responding to follow-up on ${fullName}#${issue.number}: ${issue.title}`);

  const branchName = `claws/plan-${issue.number}-${claude.randomSuffix()}`;

  await db.withTaskRecording("issue-refiner", fullName, issue.number, null, async (taskId) => {
    await claude.withNewWorktree(repo, branchName, "issue-refiner", async (wtPath) => {
      db.updateTaskWorktree(taskId, wtPath, branchName);

      const [comments, selfLogin] = await Promise.all([
        gh.getIssueComments(fullName, issue.number),
        gh.getSelfLogin(repo.owner),
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
      const prompt = buildFollowUpPrompt(fullName, issue, planComment.body, openPRNumber, unreactedComments, selfLogin, wtPath) + imageContext;

      const mcpConfigPath = claude.writeClawsMcpConfig(wtPath, { includeNameyDb: false, includeHomeAssistant: isHomeAssistantConfigRepo(fullName) });
      const agentDoc = claude.readRepoAgentDoc(wtPath, "issue-refiner");
      const timeoutMs = getItemTimeoutMs(fullName, issue.number);
      // Follow-ups don't need complexity classification — the issue is already planned
      // and we're just responding to questions, so the default tier is sufficient.
      // Stays on Claude for the same reason as the main planner path.
      const model = getModel("sonnet", "text-only", "claude");
      db.updateTaskModel(taskId, model);
      const response = await claude.runClaude(prompt, wtPath, { capability: "text-only", mcpConfig: mcpConfigPath, timeoutMs, tier: "sonnet", model, provider: "claude", appendSystemPrompt: agentDoc, captureLabel: "issue-refiner" });

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
    if (!await gh.isAllowedActor(comment.login)) continue;
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

export async function findUnreactedFeedbackAfterPlan(
  fullName: string,
  issueNumber: number,
  selfLogin: string,
): Promise<{ hasPlan: boolean; unreacted: gh.IssueComment[]; plannedOccurrences: number | null; hasEscalationReview: boolean }> {
  const comments = await gh.getIssueComments(fullName, issueNumber);
  const lastPlanIdx = comments.findLastIndex(
    (c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body),
  );
  if (lastPlanIdx === -1) {
    return { hasPlan: false, unreacted: [], plannedOccurrences: null, hasEscalationReview: false };
  }
  const after = comments.slice(lastPlanIdx + 1);
  const unreacted = await findUnreactedHumanComments(fullName, after, selfLogin);
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
  };
}

