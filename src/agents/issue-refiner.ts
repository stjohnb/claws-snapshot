import { LABELS, HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { getItemTimeoutMs } from "../timeout-handler.js";
import { processTextForImages } from "../images.js";
import { RUNNER_POLICY_CONTEXT, homeAssistantContext } from "./agent-context.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { getModel, type ModelTier } from "../model-selector.js";
import { extractModelsAttribution, type Provider } from "../plan-parser.js";

export const PLAN_HEADER = "## Implementation Plan";

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

export function isCiUnrelatedIssue(issue: gh.Issue): boolean {
  return issue.title.startsWith("[ci-unrelated]");
}

const MULTI_PR_INSTRUCTIONS = [
  `Prefer a single PR. Do not split work into multiple PRs just because the change`,
  `touches several files or is moderately large. A single PR is easier to review,`,
  `test, and deploy. Only use multiple PRs when the work is genuinely too large or`,
  `risky to ship atomically — for example, a schema migration that must be deployed`,
  `before the code that depends on it, or a change that exceeds ~800 lines across`,
  `more than 15 files.`,
  ``,
  `If you do need multiple PRs, use this exact format:`,
  ``,
  `### PR 1: [short title]`,
  `[description, files, changes for this PR]`,
  ``,
  `### PR 2: [short title]`,
  `[description, files, changes for this PR]`,
  ``,
  `Each PR must be independently deployable and functional.`,
  `If the change is small enough for a single PR, you do not need to use this format.`,
].join("\n");

const IMPLEMENTER_GUIDANCE_INSTRUCTIONS = [
  `IMPORTANT: The implementation will be performed by a smaller, less-capable model`,
  `than the one producing this plan. Your plan is the primary mechanism keeping the`,
  `implementer on track — treat it as a specification, not a sketch.`,
  ``,
  `Because of that, your plan must:`,
  `- Name exact file paths (not "the auth module" — write \`src/auth/session.ts\`).`,
  `- Spell out concrete edits per file: which functions, which line ranges, what logic to add/remove.`,
  `- Quote or paraphrase any existing code that the implementer must preserve unchanged.`,
  `- Explicitly call out invariants, subtle constraints, and gotchas the implementer would otherwise miss`,
  `  (e.g. "do NOT change the return type", "this function is called from X and Y — signature must stay stable").`,
  `- List the order of operations clearly so the implementer does not get lost mid-change.`,
  `- Avoid hand-waving phrases like "handle edge cases appropriately" — if an edge case matters, spell it out.`,
  `- Anticipate common failure modes and tell the implementer how to avoid them.`,
  ``,
  `If any part of the plan depends on judgment the implementer is unlikely to have,`,
  `make that judgment yourself here rather than deferring it.`,
].join("\n");

const MODEL_SELECTION_INSTRUCTIONS = [
  `After your plan, include a model recommendation for implementation on its own line,`,
  `in this exact format:`,
  ``,
  `**Recommended implementation model:** \`cheap\``,
  ``,
  `or`,
  ``,
  `**Recommended implementation model:** \`sonnet\``,
  ``,
  `or`,
  ``,
  `**Recommended implementation model:** \`opus\``,
  ``,
  `Choose \`cheap\` for trivial tasks: single-line fixes, typo corrections, comment-only changes,`,
  `documentation-only updates, or anything requiring no logic changes.`,
  `Choose \`sonnet\` for straightforward tasks: well-defined changes with clear patterns, simple bug fixes,`,
  `configuration changes, single-file edits, or tasks where the plan leaves little ambiguity.`,
  `Choose \`opus\` for complex tasks: architectural changes, multi-file refactors involving novel logic,`,
  `tasks requiring deep understanding of existing patterns, or anything where the implementation`,
  `requires significant judgment beyond what the plan specifies.`,
  `When in doubt, choose \`opus\`.`,
].join("\n");

const NO_HTML_COMMENTS_INSTRUCTION = `Do not use HTML comments (<!-- ... -->) anywhere in your output. All content must be human-readable plain text or standard markdown.`;

const LINKED_REFERENCES_INSTRUCTION = [
  `If the issue body or any comment references other GitHub issues or PRs — either by URL`,
  `(e.g. \`https://github.com/owner/repo/issues/123\` or \`https://github.com/owner/repo/pull/456\`)`,
  `or by short reference (\`#123\`, \`owner/repo#123\`) — you MUST fetch their content yourself BEFORE writing the plan.`,
  ``,
  `Use \`gh issue view <number> --repo <owner>/<repo> --comments\` for issues and`,
  `\`gh pr view <number> --repo <owner>/<repo>\` for PRs. The same number can be either`,
  `an issue or a PR — if one form returns "not found", try the other.`,
  ``,
  `Do NOT write a plan that tells the implementer to 'look at the linked issue', 'see #N for details',`,
  `'fetch the linked context', or otherwise defers cross-reference lookup. The implementer runs on a smaller`,
  `model with a smaller context window and weaker reasoning than you — if you don't quote or paraphrase the`,
  `relevant content of every linked reference in your plan, the implementer will produce wrong code. Pull out`,
  `the concrete facts (filenames, error messages, IDs, code snippets, dates, prior decisions) and embed them`,
  `directly in your plan.`,
  ``,
  `This applies to cross-repo links, including links to repositories other than the one containing the current issue.`,
  `The \`gh\` CLI has credentials to read any repository the Claws GitHub App is installed in across the org —`,
  `do not assume a cross-repo link is unreachable without trying.`,
  ``,
  `If a linked issue/PR is genuinely unreachable (both \`gh issue view\` and \`gh pr view\` return 404 or permission`,
  `denied), state that explicitly in the plan and proceed with what is in the current issue itself. Do NOT silently skip the fetch.`,
].join("\n");

const EXTERNAL_REFERENCES_INSTRUCTION = [
  `If the issue body or any comment references EXTERNAL URLs (non-GitHub web pages, blog posts,`,
  `documentation, RFCs, vendor docs, datasheets, etc.), use the WebFetch tool to retrieve their`,
  `content before planning. Linked external content frequently contains the spec, design, or`,
  `examples the user wants the plan to follow — a plan that ignores them is low-quality.`,
  ``,
  `Use the WebSearch tool when you need to research a referenced library, framework, error`,
  `message, or concept that is not directly linked but is required to produce a correct plan`,
  `(e.g. checking current API surface of a library mentioned by name). Do not WebSearch`,
  `speculatively — only when the issue specifically demands external lookup.`,
  ``,
  `If WebFetch returns truncated or empty content, note that in your plan rather than fabricating`,
  `details. If a URL is unreachable, proceed with what is in the issue itself.`,
].join("\n");

const DIAGNOSTIC_REFERENCES_INSTRUCTION = [
  `If the issue body or any comment references diagnostic artifacts — GitHub Actions`,
  `workflow runs (e.g. https://github.com/owner/repo/actions/runs/<run-id>), uploaded`,
  `artifacts, test screenshots/videos, or any other pointer to logs that contain the`,
  `actual failure — you MUST fetch and inspect them BEFORE writing the plan. For`,
  `Actions runs use \`gh run view <run-id> --repo <owner>/<repo> --log-failed\` to read`,
  `the failed step output; if that returns empty, fall back to \`gh run view <run-id>`,
  `--repo <owner>/<repo> --log\` for the full log. For uploaded artifacts use`,
  `\`gh run download <run-id> --repo <owner>/<repo> --dir <tmpdir>\` then \`ls\`/\`cat\``,
  `the extracted files. For build logs hosted elsewhere (CircleCI, Buildkite, etc.),`,
  `use WebFetch. Auto-filed alert issues (titles starting with [claws-error],`,
  `[ci-failure], or bot-authored bodies that say "check the logs") frequently contain`,
  `no diagnostic content in the issue body itself — the diagnostic content is in the`,
  `linked artifact, and you must retrieve it.`,
  ``,
  `The plan must commit to ONE diagnosed root cause and ONE concrete fix. Do NOT`,
  `produce a plan that branches into speculative alternatives ("if the failure is X,`,
  `do A; if it's Y, do B; if it's Z, do C") — that defers diagnosis to the`,
  `implementer, who has a smaller context window and weaker reasoning than you. If`,
  `after investigation you genuinely cannot identify the root cause from the available`,
  `evidence (logs truncated, artifacts purged, run unreachable), say so explicitly,`,
  `recommend a single best-guess action (e.g. "re-run the workflow once to confirm`,
  `this is not a transient infra blip"), and stop — do not pad with hypothetical`,
  `branches.`,
].join("\n");

const CONCISENESS_INSTRUCTIONS = [
  `Be direct and concise. Start immediately with the "## Implementation Plan" header and the actual plan content.`,
  `Do not include any introductory paragraphs or explanations about what you're about to do.`,
  `Avoid verbose phrases like "I'll analyze", "Let me examine", "Based on my review", "I'll help", "After analyzing", "Upon review", "Looking at", etc.`,
  `Get straight to the point with the implementation plan itself.`,
  `Keep the total plan output under 3,000 words. The implementer that will execute this plan has a limited context window — an overly long plan leaves less room for reading files and running tools during implementation. Omit obvious implementation details a competent developer would infer from the file paths and function names; focus budget on non-obvious constraints, gotchas, and invariants.`,
  `If the change spans many files, describe the approach for each file in 2–4 sentences rather than quoting large blocks of existing code. The implementer can read the files directly.`,
].join("\n");

const REVIEW_MODEL_INSTRUCTIONS = [
  `Also include a review model recommendation for the PR reviewer on its own line,`,
  `in this exact format:`,
  ``,
  `**Recommended review model:** \`sonnet\``,
  ``,
  `or`,
  ``,
  `**Recommended review model:** \`opus\``,
  ``,
  `Choose \`sonnet\` for PRs that will be straightforward to review: config changes,`,
  `simple bug fixes, well-scoped single-concern changes, or changes following established patterns.`,
  `Choose \`opus\` for PRs requiring deep review: security-sensitive changes,`,
  `architectural changes, complex multi-file refactors, or novel algorithms.`,
  `When in doubt, choose \`opus\`.`,
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

function buildRefinementPrompt(
  fullName: string,
  issue: gh.Issue,
  existingPlan: string,
  feedback: gh.IssueComment[],
  selfLogin: string,
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
          ...feedback.flatMap((f) => {
            const isClaws = f.login === selfLogin && gh.isClawsComment(f.body);
            const label = isClaws
              ? `Comment by @${f.login} (automated by Claws):`
              : `Comment by @${f.login}:`;
            const stripped = gh.stripClawsMarker(f.body);
            // Self-authored Claws comments are not an injection risk; guarding produces false positives.
            const body = isClaws ? stripped : guardContent(stripped, guardCtx("issue-comment"));
            return [`---`, label, body, ``];
          }),
        ]
      : [`No specific feedback comments were provided. Re-evaluate the plan for completeness and correctness.`, ``]),
    ``,
    `If \`docs/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant to the issue) for context about the codebase architecture and patterns.`,
    RUNNER_POLICY_CONTEXT,
    LINKED_REFERENCES_INSTRUCTION,
    EXTERNAL_REFERENCES_INSTRUCTION,
    DIAGNOSTIC_REFERENCES_INSTRUCTION,
    ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN ? [homeAssistantContext()] : []),
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
    CONCISENESS_INSTRUCTIONS,
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
    ...followUpComments.flatMap((f) => {
      const isClaws = f.login === selfLogin && gh.isClawsComment(f.body);
      const label = isClaws
        ? `Comment by @${f.login} (automated by Claws):`
        : `Comment by @${f.login}:`;
      const stripped = gh.stripClawsMarker(f.body);
      // Self-authored Claws comments are not an injection risk; guarding produces false positives.
      const body = isClaws ? stripped : guardContent(stripped, guardCtx("issue-comment"));
      return [`---`, label, body, ``];
    }),
    ``,
    `If \`docs/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant) for context about the codebase architecture and patterns.`,
    RUNNER_POLICY_CONTEXT,
    LINKED_REFERENCES_INSTRUCTION,
    EXTERNAL_REFERENCES_INSTRUCTION,
    DIAGNOSTIC_REFERENCES_INSTRUCTION,
    ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN ? [homeAssistantContext()] : []),
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
  duplicateCandidates: gh.Issue[] = [],
): string {
  const guardCtx = makeGuardCtx(fullName, issue.number);
  return [
    `You are analyzing a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title"))}`,
    ``,
    guardContent(issue.body, guardCtx("issue-body")) || "(No description provided)",
    ``,
    ...comments.flatMap((c) => {
      const isClaws = c.login === selfLogin && gh.isClawsComment(c.body);
      const label = isClaws
        ? `Comment by @${c.login} (automated by Claws):`
        : `Comment by @${c.login}:`;
      const stripped = gh.stripClawsMarker(c.body);
      // Self-authored Claws comments are not an injection risk; guarding produces false positives.
      const body = isClaws ? stripped : guardContent(stripped, guardCtx("issue-comment"));
      return [`---`, label, body, ``];
    }),
    `If \`docs/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant to the issue) for context about the codebase architecture and patterns.`,
    RUNNER_POLICY_CONTEXT,
    LINKED_REFERENCES_INSTRUCTION,
    EXTERNAL_REFERENCES_INSTRUCTION,
    DIAGNOSTIC_REFERENCES_INSTRUCTION,
    ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN ? [homeAssistantContext()] : []),
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
    ``,
    MODEL_SELECTION_INSTRUCTIONS,
    ``,
    REVIEW_MODEL_INSTRUCTIONS,
    ``,
    NO_HTML_COMMENTS_INSTRUCTION,
    ``,
    CONCISENESS_INSTRUCTIONS,
    ``,
    `Do NOT make any code changes. Only produce the plan as text output.`,
    buildDuplicateCandidatesSection(fullName, issue.number, duplicateCandidates),
  ].join("\n");
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

export async function processIssue(repo: Repo, issue: gh.Issue): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Planning ${fullName}#${issue.number}: ${issue.title}`);

  const branchName = `claws/plan-${issue.number}-${claude.randomSuffix()}`;

  await db.withTaskRecording("issue-refiner", fullName, issue.number, null, async (taskId) => {
    await claude.withNewWorktree(repo, branchName, "issue-refiner", async (wtPath) => {
      db.updateTaskWorktree(taskId, wtPath, branchName);

      const [comments, selfLogin, allOpenIssues] = await Promise.all([
        gh.getIssueComments(fullName, issue.number),
        gh.getSelfLogin(repo.owner),
        gh.listOpenIssues(fullName),
      ]);
      const duplicateCandidates = selectDuplicateCandidates(fullName, issue, allOpenIssues);
      const issueBodyHtml = await gh.getIssueBodyHtml(fullName, issue.number).catch(() => "");
      const htmlBodies = [issueBodyHtml, ...comments.map((c) => c.body_html)];
      const imageContext = await processTextForImages([issue.body, ...comments.map((c) => c.body)], wtPath, repo.owner, { repo: fullName, issueNumber: issue.number, agentName: "Planner" }, htmlBodies);
      const prompt = buildNewPlanPrompt(fullName, issue, comments, selfLogin, duplicateCandidates) + imageContext;

      const mcpConfigPath = claude.writeClawsMcpConfig(wtPath, { includeNameyDb: false });
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
      const model = planModelForIssue(issue);
      db.updateTaskModel(taskId, model);
      log.info(`[issue-refiner] Using model "${model}" for planning ${fullName}#${issue.number}`);
      let actualProvider: Provider = "claude";
      let taskTokensUsed: number | undefined;
      let taskCostUsd: number | undefined;
      const planOutput = await claude.runClaude(prompt, wtPath, { capability: "text-only", mcpConfig: mcpConfigPath, timeoutMs, tier, model, provider: "claude", appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onTokensUsed: (t, c) => { taskTokensUsed = t; taskCostUsd = c; } });
      if (taskTokensUsed !== undefined && taskCostUsd !== undefined) {
        db.updateTaskTokenUsage(taskId, taskTokensUsed, taskCostUsd);
      }

      const candidateNumbers = duplicateCandidates.map((c) => c.number);
      const duplicateOf = candidateNumbers.length > 0 ? parseDuplicateOf(planOutput, candidateNumbers) : null;
      const cleanedOutput = stripDuplicateMarker(planOutput);

      if (cleanedOutput.trim() || duplicateOf !== null) {
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
        } else {
          await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${cleanedOutput}\n\n${attribution}`, { agentName: "Planner" });
          log.info(`[issue-refiner] Posted plan for ${fullName}#${issue.number}`);
          await warnIfPlanTooLong(fullName, issue.number, cleanedOutput.length, "Plan");
        }
      } else {
        log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
      }

      if (duplicateOf === null) {
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
      const mcpConfigPath = claude.writeClawsMcpConfig(wtPath, { includeNameyDb: false });
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
        const imageContext = await processTextForImages([issue.body, ...comments.map((c) => c.body)], wtPath, repo.owner, { repo: fullName, issueNumber: issue.number, agentName: "Planner" }, htmlBodies);
        const prompt = buildNewPlanPrompt(fullName, issue, comments, selfLogin) + imageContext;
        let actualProvider: Provider = "claude";
        let taskTokensUsed: number | undefined;
        let taskCostUsd: number | undefined;
        const planOutput = await claude.runClaude(prompt, wtPath, { capability: "text-only", mcpConfig: mcpConfigPath, timeoutMs, tier, model, provider: "claude", appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onTokensUsed: (t, c) => { taskTokensUsed = t; taskCostUsd = c; } });
        if (taskTokensUsed !== undefined && taskCostUsd !== undefined) {
          db.updateTaskTokenUsage(taskId, taskTokensUsed, taskCostUsd);
        }

        if (planOutput.trim()) {
          const attribution = `*Models used: ${model} (provider: ${actualProvider})*`;
          await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${planOutput}\n\n${attribution}`, { agentName: "Planner" });
          log.info(`[issue-refiner] Posted fresh plan for ${fullName}#${issue.number}`);
          await warnIfPlanTooLong(fullName, issue.number, planOutput.length, "Fresh plan");
        } else {
          log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
        }
      } else {
        const planComment = comments[lastPlanIdx];
        const feedback = unreactedComments;

        const issueBodyHtml = await gh.getIssueBodyHtml(fullName, issue.number).catch(() => "");
        const imageContext = await processTextForImages([issue.body], wtPath, repo.owner, { repo: fullName, issueNumber: issue.number, agentName: "Planner" }, [issueBodyHtml, ...comments.map((c) => c.body_html)]);
        const prompt = buildRefinementPrompt(fullName, issue, planComment.body, feedback, selfLogin) + imageContext;
        let actualProvider: Provider = "claude";
        let taskTokensUsed: number | undefined;
        let taskCostUsd: number | undefined;
        const planOutput = await claude.runClaude(prompt, wtPath, { capability: "text-only", mcpConfig: mcpConfigPath, timeoutMs, tier, model, provider: "claude", appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onTokensUsed: (t, c) => { taskTokensUsed = t; taskCostUsd = c; } });
        if (taskTokensUsed !== undefined && taskCostUsd !== undefined) {
          db.updateTaskTokenUsage(taskId, taskTokensUsed, taskCostUsd);
        }

        if (planOutput.trim()) {
          // Check for "### Response" section to post as a separate follow-up comment
          const responseMatch = planOutput.match(/### Response\s*\n([\s\S]*)$/);
          const planBody = responseMatch
            ? planOutput.slice(0, responseMatch.index).trim()
            : planOutput;

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

          await gh.editIssueComment(fullName, planComment.id, `${PLAN_HEADER}\n\n${planBody}\n\n${attribution}`, { agentName: "Planner" });
          log.info(`[issue-refiner] Updated plan comment for ${fullName}#${issue.number}`);

          if (responseMatch && responseMatch[1].trim()) {
            await gh.commentOnIssue(fullName, issue.number, responseMatch[1].trim(), { agentName: "Planner" });
            log.info(`[issue-refiner] Posted response comment for ${fullName}#${issue.number}`);
          }

          await warnIfPlanTooLong(fullName, issue.number, planBody.length, "Refined plan");
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
      const imageContext = await processTextForImages([issue.body], wtPath, repo.owner, { repo: fullName, issueNumber: issue.number, agentName: "Planner" }, [issueBodyHtml, ...comments.map((c) => c.body_html)]);
      const prompt = buildFollowUpPrompt(fullName, issue, planComment.body, openPRNumber, unreactedComments, selfLogin) + imageContext;

      const mcpConfigPath = claude.writeClawsMcpConfig(wtPath, { includeNameyDb: false });
      const agentDoc = claude.readRepoAgentDoc(wtPath, "issue-refiner");
      const timeoutMs = getItemTimeoutMs(fullName, issue.number);
      // Follow-ups don't need complexity classification — the issue is already planned
      // and we're just responding to questions, so the default tier is sufficient.
      // Stays on Claude for the same reason as the main planner path.
      const model = getModel("sonnet", "text-only", "claude");
      db.updateTaskModel(taskId, model);
      const response = await claude.runClaude(prompt, wtPath, { capability: "text-only", mcpConfig: mcpConfigPath, timeoutMs, tier: "sonnet", model, provider: "claude", appendSystemPrompt: agentDoc });

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
  const unreacted: gh.IssueComment[] = [];
  for (const comment of commentsAfterPlan) {
    if (gh.isClawsComment(comment.body)) continue;
    if (comment.login.endsWith("[bot]")) continue;
    if (!await gh.isAllowedActor(comment.login)) continue;
    try {
      const reactions = await gh.getCommentReactions(fullName, comment.id);
      const hasReaction = reactions.some(
        (r) => r.user.login === selfLogin && r.content === "+1",
      );
      if (!hasReaction) {
        unreacted.push(comment);
      }
    } catch {
      unreacted.push(comment);
    }
  }
  return unreacted;
}

export async function findUnreactedFeedbackAfterPlan(
  fullName: string,
  issueNumber: number,
  selfLogin: string,
): Promise<{ hasPlan: boolean; unreacted: gh.IssueComment[] }> {
  const comments = await gh.getIssueComments(fullName, issueNumber);
  const lastPlanIdx = comments.findLastIndex(
    (c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body),
  );
  if (lastPlanIdx === -1) {
    return { hasPlan: false, unreacted: [] };
  }
  const unreacted = await findUnreactedHumanComments(fullName, comments.slice(lastPlanIdx + 1), selfLogin);
  return { hasPlan: true, unreacted };
}

