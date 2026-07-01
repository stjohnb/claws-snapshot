import * as fs from "node:fs";
import * as path from "node:path";
import { LABELS, HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { getItemTimeoutMs } from "../timeout-handler.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { getReviewModel, type ModelTier } from "../model-selector.js";
import { RUNNER_POLICY_CONTEXT, homeAssistantContext } from "./agent-context.js";
import * as planParser from "../plan-parser.js";

// ── Review context enrichment ────────────────────────────────────────────────
// Since the reviewer runs on the direct-HTTP OpenRouter path with no
// filesystem tools, claws pre-loads codebase context into the prompt on the
// agent's behalf:
//
//   1. `docs/OVERVIEW.md` (always, if present) — the main entry point for
//      project docs produced by the doc-maintainer job.
//   2. Any *topic* docs under `docs/` whose filename tokens overlap with the
//      changed file paths or the PR title. For example, a PR that touches
//      `src/db/schema.ts` will pull in `docs/database-schema.md`; a PR
//      titled "Add /api/search endpoint" will pull in `docs/api-design.md`.
//      Irrelevant topic docs are skipped entirely — cheap models on
//      OpenRouter are often served via providers with tight (32k) context
//      windows, so loading every doc blindly can blow the limit on big PRs.
//   3. The post-change full content of each code file touched by the PR,
//      so the reviewer can see what surrounds the diff hunks.
//
// Without this the reviewer only sees the diff hunks (~3 lines of context
// per change) and misses issues that depend on surrounding code, imports,
// or invariants established elsewhere in the file or codebase.
//
// Budgets are sized to fit the smallest common OpenRouter endpoint for our
// text-only tier, which is ~32k tokens for Qwen 2.5 Coder 32B via some
// providers. At ~4 chars/token that's ~128k chars total context window. We
// reserve roughly half for the diff + prompt scaffolding + model response,
// leaving ~60k chars for the enrichment block.

/** Max bytes per individual doc file. Truncated with a marker if exceeded. */
const MAX_DOC_BYTES = 12_000;
/** Max bytes for the docs section combined. Sized to fit a typical
 *  OVERVIEW.md plus 1-2 small topic docs. */
const MAX_DOCS_SECTION_BYTES = 20_000;
/** Max bytes per changed-file full content. Truncated with a marker if exceeded. */
const MAX_FILE_CONTENT_BYTES = 15_000;
/** Max bytes for the entire enrichment block. */
const MAX_CONTEXT_BYTES = 60_000;

/** File extensions for which pre-loading the full content is useful review context. */
const CONTEXT_INCLUDE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "cc", "cpp", "h", "hpp",
  "cs", "php", "scala", "clj", "ex", "exs", "erl",
  "sh", "bash", "zsh", "fish",
  "md", "sql",
]);

/**
 * Extract lower-case word tokens (≥3 chars) from a set of strings, splitting
 * on common delimiters found in paths, filenames, and PR titles.
 *
 * Used to match changed file paths + PR titles against doc filenames for
 * smart doc selection. Exported for testability.
 */
export function extractKeywordTokens(sources: readonly string[]): Set<string> {
  const tokens = new Set<string>();
  // Split on path separators, punctuation, whitespace, dashes, underscores, dots.
  const splitRe = /[\s/\\\-_.,;:()[\]{}'"`<>]+/;
  for (const source of sources) {
    for (const raw of source.toLowerCase().split(splitRe)) {
      if (raw.length >= 3) tokens.add(raw);
    }
  }
  return tokens;
}

/**
 * Choose which docs under `docs/` to load for this review. Always includes
 * `OVERVIEW.md` if present. For topic docs, includes a doc iff any of its
 * filename tokens (minus the `.md` suffix, split on `-`/`_`/`.`) overlap with
 * tokens from the changed file paths or the PR title. Exported for testing.
 */
export function selectRelevantDocs(
  wtPath: string,
  changedFiles: readonly string[],
  prTitle: string,
): string[] {
  const docsDir = path.join(wtPath, "docs");
  let entries: string[];
  try {
    entries = fs.readdirSync(docsDir).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  if (entries.length === 0) return [];

  const hasOverview = entries.includes("OVERVIEW.md");
  const topicDocs = entries.filter((e) => e !== "OVERVIEW.md");

  const signalTokens = extractKeywordTokens([...changedFiles, prTitle]);

  const selectedTopic: string[] = [];
  for (const docFile of topicDocs) {
    const docName = docFile.replace(/\.md$/i, "");
    const docTokens = extractKeywordTokens([docName]);
    let matched = false;
    for (const dt of docTokens) {
      if (signalTokens.has(dt)) {
        matched = true;
        break;
      }
    }
    if (matched) selectedTopic.push(docFile);
  }
  selectedTopic.sort((a, b) => a.localeCompare(b));

  const result: string[] = [];
  if (hasOverview) result.push("OVERVIEW.md");
  result.push(...selectedTopic);
  return result;
}

/**
 * Load the selected docs from `docs/` (always OVERVIEW + topic docs whose
 * filenames relate to the PR). Returns the rendered section and total bytes,
 * or `null` if nothing was selected. Exported for testability.
 */
function loadRepoDocs(
  wtPath: string,
  changedFiles: readonly string[],
  prTitle: string,
): { section: string; bytes: number } | null {
  const selected = selectRelevantDocs(wtPath, changedFiles, prTitle);
  if (selected.length === 0) return null;

  const docsDir = path.join(wtPath, "docs");
  const parts: string[] = [];
  let totalBytes = 0;
  let omitted = 0;

  for (const name of selected) {
    if (totalBytes >= MAX_DOCS_SECTION_BYTES) {
      omitted++;
      continue;
    }
    const absPath = path.join(docsDir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(absPath, "utf-8");
    } catch (err) {
      log.debug(`[pr-reviewer] Failed to read docs/${name}: ${err}`);
      continue;
    }
    const remaining = MAX_DOCS_SECTION_BYTES - totalBytes;
    const perFileBudget = Math.min(MAX_DOC_BYTES, remaining);
    const truncated = raw.length > perFileBudget;
    const content = truncated ? raw.slice(0, perFileBudget) + "\n\n[... truncated ...]" : raw;
    parts.push(`#### docs/${name}\n\n${content}`);
    totalBytes += content.length;
  }

  if (parts.length === 0) return null;

  if (omitted > 0) {
    parts.push(`_[${omitted} more doc file(s) omitted — docs section budget exhausted]_`);
  }

  return {
    section: `### Project documentation (from docs/)\n\n${parts.join("\n\n")}`,
    bytes: totalBytes,
  };
}

/**
 * Build a context-enrichment block for the reviewer prompt.
 *
 * Loads `docs/OVERVIEW.md` plus any topic docs relevant to the PR (matched by
 * filename-token overlap with changed file paths + PR title), and the
 * post-change full content of each code file in `changedFiles`. Capped
 * per-file and in aggregate. Silently skips deleted files, binary/data/lock
 * files, and anything too large.
 *
 * Exported so callers and tests can exercise it directly.
 */
export function buildReviewContext(
  wtPath: string,
  changedFiles: readonly string[],
  prTitle = "",
  reservedBytes = 0,
): string {
  const effectiveBudget = MAX_CONTEXT_BYTES - reservedBytes;
  const sections: string[] = [];
  let usedBytes = 0;

  const docs = loadRepoDocs(wtPath, changedFiles, prTitle);
  if (docs) {
    sections.push(docs.section);
    usedBytes += docs.bytes;
  }

  const fileSections: string[] = [];
  for (let i = 0; i < changedFiles.length; i++) {
    const file = changedFiles[i];
    if (usedBytes >= effectiveBudget) {
      fileSections.push(`_[${changedFiles.length - i} more file(s) omitted — context budget exhausted]_`);
      break;
    }
    const ext = file.split(".").pop()?.toLowerCase() ?? "";
    if (!CONTEXT_INCLUDE_EXTS.has(ext)) continue;

    const absPath = path.join(wtPath, file);
    if (!fs.existsSync(absPath)) continue; // deleted file — diff speaks for itself

    let raw: string;
    try {
      raw = fs.readFileSync(absPath, "utf-8");
    } catch (err) {
      log.debug(`[pr-reviewer] Failed to read ${file} for context: ${err}`);
      continue;
    }

    const remaining = effectiveBudget - usedBytes;
    const perFileBudget = Math.min(MAX_FILE_CONTENT_BYTES, remaining);
    const truncated = raw.length > perFileBudget;
    const content = truncated ? raw.slice(0, perFileBudget) + "\n\n[... truncated ...]" : raw;

    // Use a fence that won't collide with code inside the file.
    const fence = "~~~";
    fileSections.push(`#### ${file}\n${fence}${ext}\n${content}\n${fence}`);
    usedBytes += content.length;
  }

  if (fileSections.length > 0) {
    sections.push(`### Full contents of changed files (post-change, for context)\n\n${fileSections.join("\n\n")}`);
  }

  if (sections.length === 0) return "";

  return [
    `## Codebase Context`,
    ``,
    `Below is background material loaded from the repository — the project documentation (maintained by the doc-maintainer job) and the current contents of the files changed in this PR. Use this to understand invariants, surrounding code, and existing patterns BEFORE evaluating the diff. The diff alone does not show enough context to review properly.`,
    ``,
    sections.join("\n\n"),
    ``,
  ].join("\n");
}

/** Extract the list of changed file paths from a unified diff string. */
export function changedFilesFromDiff(diff: string): string[] {
  const files: string[] = [];
  const re = /^diff --git a\/.* b\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(diff)) !== null) {
    files.push(match[1]);
  }
  return files;
}

/**
 * Load context from the issue that originated this PR, if any.
 *
 * Returns a markdown section with the issue body and Claws implementation plan
 * (if present), or an empty string if there is no linked issue or fetching fails.
 * Never throws — a fetch failure degrades gracefully to no issue context.
 */
export async function buildIssueContext(
  fullName: string,
  pr: gh.PR,
): Promise<string> {
  const issueNumber = gh.getLinkedIssueNumber(pr);
  if (issueNumber === null) return "";

  const issueGuardCtx = makeGuardCtx(fullName, issueNumber);

  let issueBody: string;
  try {
    issueBody = await gh.getIssueBody(fullName, issueNumber);
  } catch (err) {
    log.warn(`[pr-reviewer] Could not fetch linked issue #${issueNumber} for PR #${pr.number}: ${err}`);
    return "";
  }

  let comments: { body: string }[] = [];
  try {
    comments = await gh.getIssueComments(fullName, issueNumber);
  } catch (err) {
    log.warn(`[pr-reviewer] Could not fetch comments for issue #${issueNumber}: ${err}`);
    // Still emit the issue body section below
  }

  const planText = planParser.findPlanComment(comments);

  const guardedBody = guardContent(issueBody, issueGuardCtx("issue-body"));
  const truncatedBody = guardedBody.length > 5_000
    ? guardedBody.slice(0, 5_000) + "\n\n[... truncated ...]"
    : guardedBody;

  const guardedPlan = planText !== null ? guardContent(planText, issueGuardCtx("issue-plan")) : null;
  const truncatedPlan = guardedPlan !== null
    ? (guardedPlan.length > 8_000 ? guardedPlan.slice(0, 8_000) + "\n\n[... truncated ...]" : guardedPlan)
    : null;

  if (!truncatedBody && truncatedPlan === null) return "";

  if (truncatedPlan !== null) {
    const parts: string[] = [
      `## Originating Issue & Refined Plan`,
      ``,
      `This PR was created in response to **issue #${issueNumber}**, which was then REFINED into the`,
      `implementation plan below. The **refined plan is the authoritative source of truth**`,
      `for what this PR must deliver — after investigation the planner may have deliberately`,
      `narrowed, expanded, or changed the original request. Where the refined plan and the`,
      `original issue text conflict, the refined plan WINS. Do NOT flag the PR for failing to`,
      `match the original issue when it matches the refined plan; in particular do not raise`,
      `"missing requirement" or "scope drift" findings that are really just the plan`,
      `intentionally diverging from the initial report.`,
      ``,
      `Evaluate whether the diff delivers what the **refined plan** describes. The original`,
      `issue body follows only as background on the user's initial intent.`,
      ``,
      `Note: If the PR body indicates this is one of multiple PRs (e.g. "PR 2 of 3"), evaluate delivery only against the phase described in the PR body — items belonging to other phases are out of scope.`,
      ``,
      `### Refined plan (Claws implementation plan comment — AUTHORITATIVE)`,
      ``,
      truncatedPlan,
      ``,
      `### Issue #${issueNumber} body (original report — background only)`,
      ``,
      truncatedBody,
    ];

    return parts.join("\n");
  }

  const parts: string[] = [
    `## Originating Issue`,
    ``,
    `This PR was created in response to **issue #${issueNumber}** in this repository. Use the issue text below as the source of truth for what the PR is expected to deliver. When reviewing the diff, evaluate not only correctness but whether the change actually addresses what the issue describes. Flag missing requirements, missed acceptance criteria, or scope creep beyond what was asked.`,
    ``,
    `Note: If the PR body indicates this is one of multiple PRs (e.g. "PR 2 of 3"), evaluate delivery only against the phase described in the PR body — items belonging to other phases are out of scope.`,
    ``,
    `### Issue #${issueNumber} body`,
    ``,
    truncatedBody,
  ];

  return parts.join("\n");
}

const REVIEW_HEADER = "## PR Review";
const REVIEWED_COMMIT_PATTERN = /Reviewed commit: `([0-9a-f]+)`/;
const REVIEW_ITERATION_PATTERN = /(?:<!-- )?review-iteration: (\d+)(?: -->)?/g;
const REASSESSMENT_THRESHOLD = 3;
const RECOMMENDED_MODEL_PATTERN = /(?:<!-- )?recommended-model: (sonnet|opus)(?: -->)?/g;
const PR_REVIEW_MODEL_PATTERN = /(?:<!-- )?review-model: (sonnet|opus)(?: -->)?/g;

/**
 * Extract the recommended model tier from the review text.
 * Only considers markers after the last "## PR Review" header to avoid
 * spoofed markers from PR body/diff content that may be quoted earlier.
 * Uses escalation: if any segment recommends opus, opus wins.
 */
export function extractRecommendedModel(text: string): ModelTier {
  const headerIdx = text.lastIndexOf(REVIEW_HEADER);
  const searchText = headerIdx >= 0 ? text.slice(headerIdx) : text;
  const matches = [...searchText.matchAll(RECOMMENDED_MODEL_PATTERN)];
  if (matches.length === 0) return "sonnet";
  return matches.some((m) => m[1] === "opus") ? "opus" : "sonnet";
}

/** Extract the review model tier from a PR body marker. */
export function extractPRReviewModel(body: string): ModelTier | null {
  const matches = [...body.matchAll(PR_REVIEW_MODEL_PATTERN)];
  return matches.length > 0 ? (matches[matches.length - 1][1] as ModelTier) : null;
}

const REVIEW_PROVIDER_PATTERN = /review-provider: (openrouter|claude)/;
const REVIEW_CLEAN_RESULT_MARKER = "review-result: clean";
const REVIEW_CLEAN_RESULT_PATTERN = /review-result: clean/;
const REVIEW_ADDRESSED_PATTERN = /review-addressed:\s*`?[0-9a-f]{7,40}`?/gi;


function extractReviewedCommit(commentBody: string): string | null {
  const match = commentBody.match(REVIEWED_COMMIT_PATTERN);
  return match ? match[1] : null;
}

function makeCommitMarker(sha: string): string {
  return `Reviewed commit: \`${sha}\``;
}

function makeIterationMarker(n: number): string {
  return `review-iteration: ${n}`;
}

function extractIterationCount(body: string): number {
  const matches = [...body.matchAll(REVIEW_ITERATION_PATTERN)];
  return matches.length > 0 ? Number(matches[matches.length - 1][1]) : 1;
}

/** Find the latest Claws review comment on this PR. */
async function getLatestReviewComment(
  repo: string,
  prNumber: number,
): Promise<{ id: number; body: string } | null> {
  const comments = await gh.getIssueComments(repo, prNumber);
  let latest: { id: number; body: string } | null = null;
  for (const comment of comments) {
    if (gh.isClawsComment(comment.body) && comment.body.includes(REVIEW_HEADER)) {
      latest = { id: comment.id, body: comment.body };
    }
  }
  return latest;
}

/** Count previous Claws review iterations that raised substantive issues. Returns the count and previous feedback. */
export async function getReviewHistory(
  repo: string,
  prNumber: number,
  prefetched?: { id: number; body: string } | null,
): Promise<{ count: number; previousFeedback: string[] }> {
  const existing = prefetched !== undefined ? prefetched : await getLatestReviewComment(repo, prNumber);
  if (!existing) return { count: 0, previousFeedback: [] };

  // With single-comment editing, iteration count is tracked via a marker
  const iterationCount = extractIterationCount(existing.body);

  // Extract current review content (strip legacy <details> blocks if present)
  const feedback: string[] = [];
  const stripped = gh.stripClawsMarker(existing.body)
    .replace(/## PR Review\s*/, "")
    .replace(REVIEWED_COMMIT_PATTERN, "")
    .replace(REVIEW_ITERATION_PATTERN, "")
    .replace(REVIEW_PROVIDER_PATTERN, "")
    .replace(/<details>[\s\S]*?<\/details>/g, "")
    .replace(/\*Review #\d+\*\s*/g, "")
    .trim();
  if (stripped && !/^Reviewed\s*—\s*no issues found\.?$/i.test(stripped) && !/no net changes/i.test(stripped)) {
    feedback.push(stripped);
  }

  return { count: iterationCount, previousFeedback: feedback };
}

/** Determine if the PR has new commits since the last Claws review comment by comparing embedded commit SHA. */
export async function hasNewCommitsSinceLastReview(
  repo: string,
  prNumber: number,
): Promise<boolean> {
  try {
    const existing = await getLatestReviewComment(repo, prNumber);
    if (!existing) return true; // never reviewed → should review
    const reviewedCommit = extractReviewedCommit(existing.body);
    if (!reviewedCommit) return true; // no SHA marker → legacy comment, re-review
    const headSha = await gh.getPRHeadSHA(repo, prNumber);
    return !headSha.startsWith(reviewedCommit);
  } catch {
    return true; // err on the side of re-reviewing
  }
}

/** Post or edit the single Claws review comment on a PR. */
async function postOrEditReview(
  fullName: string,
  prNumber: number,
  reviewBody: string,
  existingComment: { id: number; body: string } | null,
): Promise<void> {
  if (existingComment) {
    await gh.editIssueComment(fullName, existingComment.id, reviewBody, { agentName: "Reviewer" });
  } else {
    await gh.commentOnIssue(fullName, prNumber, reviewBody, { agentName: "Reviewer" });
  }
}

/** Build a review body with iteration tracking. */
function buildReviewBody(
  content: string,
  headSha: string,
  iteration: number,
  clean = false,
): string {
  const parts = [
    REVIEW_HEADER,
    "",
    `*Review #${iteration}*`,
    "",
    content,
    "",
    makeCommitMarker(headSha.slice(0, 12)),
    makeIterationMarker(iteration),
  ];
  if (clean) parts.push(REVIEW_CLEAN_RESULT_MARKER);
  return parts.join("\n");
}

/** Extract the main review content (excluding headers, markers, and collapsed blocks) from a review comment body. */
function extractCurrentReviewContent(body: string): string {
  return gh.stripClawsMarker(body)
    .replace(/## PR Review\s*/, "")
    .replace(/\*Review #\d+\*\s*/, "")
    .replace(REVIEWED_COMMIT_PATTERN, "")
    .replace(REVIEW_ITERATION_PATTERN, "")
    .replace(REVIEW_PROVIDER_PATTERN, "")
    .replace(REVIEW_CLEAN_RESULT_PATTERN, "")
    .replace(REVIEW_ADDRESSED_PATTERN, "")
    .replace(/<details>[\s\S]*?<\/details>/g, "")
    .trim();
}

function isCleanReview(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return true;
  const lastLine = trimmed.split('\n').at(-1)?.trim() ?? '';
  return lastLine === REVIEW_CLEAN_RESULT_MARKER;
}

/**
 * Detect review output that mentions issues but lacks actionable details.
 * Returns true if the review appears vague/incomplete and should be suppressed.
 */
function isVagueReview(output: string): boolean {
  // Split into sections by markdown headers (####, ###, ##)
  const sections = output.split(/^#{2,4}\s+/m).filter(Boolean);

  for (const section of sections) {
    const lines = section.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    // Look for patterns like "- **Lines:**" or "- **Lines:** " followed by nothing
    // This catches the exact pattern from the bug report
    for (const line of lines) {
      if (/^\*\*Lines?:\*\*\s*$/i.test(line.replace(/^-\s*/, ""))) {
        return true;
      }
    }
  }

  // Check if any "File:" reference lacks a corresponding description
  const fileRefs = output.match(/\*\*File:\*\*\s*`.+?`/g) ?? [];
  if (fileRefs.length > 0) {
    // If there are file references but the total non-boilerplate content is very short,
    // the review is likely vague
    const stripped = output
      .replace(/^#{2,4}\s+.*/gm, "")           // remove headers
      .replace(/\*\*File:\*\*\s*`.+?`/g, "")   // remove file refs
      .replace(/\*\*Lines?:\*\*\s*/g, "")       // remove line refs
      .replace(/[-*]\s*/g, "")                  // remove list markers
      .replace(/recommended-model:\s*\w+/g, "") // remove model marker
      .replace(/\s+/g, " ")
      .trim();
    if (stripped.length < 20) {
      return true;
    }
  }

  return false;
}

/**
 * Detect a re-review whose verdict is "no actionable changes" but which omits the
 * exact `review-result: clean` marker (e.g. "no changes needed", "looks good",
 * "the review I already posted is accurate"). Such output otherwise never maps to
 * the clean state and the PR never receives the Ready label (see #1494).
 * Conservative: returns false if the review carries ANY actionable signal.
 */
export function isNoActionableReview(output: string): boolean {
  const content = output.includes("## PR Review")
    ? extractCurrentReviewContent(output)
    : output.trim();
  if (!content) return false; // empty is handled by isCleanReview

  // Exclude the bot's own standardized clean phrase — avoids echoed content bypassing the marker requirement.
  if (/^Reviewed\s*[—-]\s*no issues found\.?$/i.test(content)) return false;

  // Actionable signals → NOT a no-op review.
  if (/recommended-model:\s*\w+/i.test(content)) return false;
  if (/##+\s*Suggested Approach Change/i.test(content)) return false;
  if (/\*\*\s*(file|lines?)\s*:\*\*/i.test(content)) return false;
  if (/\bline\s+\d+\b/i.test(content)) return false;
  if (/`[^`]+\.\w+`/.test(content)) return false; // backticked path/filename refs

  // Positive confirmatory phrasing required.
  return /\b(no (issues|problems|concerns|changes|action)\b|looks good|lgtm|nothing to (change|address|fix)|no further (changes|action)|already (accurate|correct)|review .*\baccurate\b|confirmed .*(findings|review)|approv(e|ed))\b/i
    .test(content);
}

function buildStandardReviewPrompt(
  fullName: string,
  pr: gh.PR,
  truncatedDiff: string,
  guardCtx: (source: string) => { repo: string; source: string; itemNumber: number },
  needsReassessment: boolean,
  history: { count: number; previousFeedback: string[] },
  contextBlock: string,
  issueContext: string,
  humanComments: Array<{ author: string; body: string }> = [],
): string {
  return [
    `You are reviewing a pull request in the repository ${fullName}.`,
    `PR #${pr.number}: ${guardContent(pr.title, guardCtx("pr-title"))}`,
    `Branch: ${guardContent(pr.headRefName, guardCtx("pr-branch"))} → ${pr.baseRefName}`,
    ``,
    pr.body ? `PR Description:\n${guardContent(pr.body, guardCtx("pr-body"))}\n` : "",
    contextBlock,
    issueContext,
    ...(humanComments.length > 0 ? [
      `## Human reviewer comments on this PR`,
      ``,
      `These are directives from human reviewers. If a human has explicitly settled an implementation choice, do NOT raise an issue against that choice — re-flagging a settled topic creates a loop where automated reviews keep reverting human-directed changes.`,
      ``,
      ...humanComments.map((c) => `**@${c.author}**:\n${c.body}\n`),
      ``,
    ] : []),
    ...(needsReassessment ? [
      `**Important — Reassessment needed**: This PR has been reviewed ${history.count} times previously with issues found each time that have not been fully resolved.`,
      ``,
      `Previous review feedback:`,
      ...history.previousFeedback.slice(-5).map((fb, i) => [
        `--- Review ${i + 1} ---`,
        // Previous review feedback is self-authored (verified via isClawsComment in
        // getReviewHistory) — guarding it produces false positives when reviews
        // discuss prompt injection patterns or contain example attack strings.
        fb.slice(0, 3000),
        ``,
      ]).flat(),
      `Given that similar issues keep recurring despite fixes being attempted, take a step back and consider:`,
      `- Are there recurring themes across these reviews?`,
      `- Is the current implementation approach fundamentally sound, or would a different approach avoid these issues entirely?`,
      `- Rather than listing the same problems again, suggest an alternative approach if one exists.`,
      ``,
      `If you believe a different approach would be more effective, lead your review with a "## Suggested Approach Change" section explaining the recommended alternative.`,
      ``,
    ] : []),
    `Here is the diff for this PR:`,
    "```diff",
    truncatedDiff,
    "```",
    ``,
    `Please review this PR for:`,
    ...(issueContext ? [`- Whether the PR delivers what the refined plan above describes (falling back to the originating issue only when no plan was posted) — treat the refined plan as authoritative and do NOT report intentional divergence from the original issue as a missing requirement or scope drift`] : []),
    `- Bugs and logic errors`,
    `- Security issues`,
    `- Performance problems`,
    `- Missing error handling`,
    `- Style inconsistencies with the codebase`,
    `- Test coverage gaps`,
    ``,
    RUNNER_POLICY_CONTEXT,
    ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN ? [homeAssistantContext()] : []),
    ``,
    `Be constructive and concise. Every issue you raise MUST include:`,
    `1. The exact filename`,
    `2. The specific line number(s) from the diff`,
    `3. A clear description of what is wrong and how to fix it`,
    ``,
    `Do NOT raise an issue if you cannot provide all three. A vague issue with no line numbers or no description is worse than no comment at all.`,
    ``,
    `If the PR looks good and you have no significant issues to raise, end your response with this marker on its own line: ${REVIEW_CLEAN_RESULT_MARKER}`,
    `Otherwise, provide your review as markdown. Each issue must reference a specific file, line, and fix.`,
    `Do not include generic praise or filler — only actionable feedback.`,
    ``,
    `If you find issues, end your review with a model recommendation for the review-addresser.`,
    `Include this marker as plain text on its own line: recommended-model: sonnet or recommended-model: opus`,
    `Do not use HTML comments (<!-- ... -->) for this or any other marker — all output must be human-readable.`,
    `Choose sonnet for straightforward fixes (style issues, simple bugs, obvious error handling, test additions following existing patterns).`,
    `Choose opus for complex changes (architectural issues, security fixes, multi-file refactors, novel logic).`,
  ].join("\n");
}


export async function processPR(repo: Repo, pr: gh.PR): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[pr-reviewer] Reviewing PR #${pr.number} in ${fullName}`);

  await db.withTaskRecording("pr-reviewer", fullName, pr.number, null, async (taskId) => {
    // Fetch existing review comment once for reuse
    const existingComment = await getLatestReviewComment(fullName, pr.number);
    const prevIteration = existingComment ? extractIterationCount(existingComment.body) : 0;
    const nextIteration = prevIteration + 1;

    const result = await claude.withExistingWorktree(
      repo, pr.headRefName, "pr-reviewer",
      async (wtPath) => {
        db.updateTaskWorktree(taskId, wtPath, pr.headRefName);
        const mcpConfigPath = claude.writeClawsMcpConfig(wtPath);
        const agentDoc = claude.readRepoAgentDoc(wtPath, "pr-reviewer");

    // Get the diff for the PR — use two-phase strategy for large diffs
    const FULL_DIFF_MAX_BUFFER = 200 * 1024 * 1024;
    const FILE_DIFF_MAX_BUFFER = 50 * 1024 * 1024;
    const LARGE_FILE_THRESHOLD = 20_000; // chars; files above this get individual review

    let diff: string;
    let isLargePR = false;
    try {
      diff = await claude.git(
        ["diff", `origin/${pr.baseRefName}...HEAD`],
        wtPath,
        { maxBuffer: FULL_DIFF_MAX_BUFFER },
      );
    } catch (err) {
      if (!/maxBuffer/.test(String(err))) throw err;
      log.info(`[pr-reviewer] Full diff exceeded buffer for PR #${pr.number} in ${fullName} — switching to per-file review`);
      isLargePR = true;
      diff = "";
    }

    if (!diff.trim() && !isLargePR) {
      log.info(`[pr-reviewer] No diff for PR #${pr.number} in ${fullName} — posting empty-diff review`);

      const headSha = await gh.getPRHeadSHA(fullName, pr.number);
      const reviewBody = buildReviewBody(
        "This PR has no net changes relative to the base branch — every commit has been reverted or cancelled out.\nIt should likely be closed.",
        headSha,
        nextIteration,
      );

      await postOrEditReview(fullName, pr.number, reviewBody, existingComment);
      log.info(`[pr-reviewer] Posted empty-diff review for PR #${pr.number} in ${fullName}`);

      db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "reviewed" });
      return;
    }

    const timeoutMs = getItemTimeoutMs(fullName, pr.number);
    const prTier = pr.body ? extractPRReviewModel(pr.body) : null;
    // PR review is text-only — the agent reads the diff and produces a markdown
    // comment; it never edits files. Route through Claude CLI for review quality.
    const model = getReviewModel(prTier ?? undefined, "claude");
    db.updateTaskModel(taskId, model);

    const history = await getReviewHistory(fullName, pr.number, existingComment);
    const needsReassessment = history.count >= REASSESSMENT_THRESHOLD;
    const guardCtx = makeGuardCtx(fullName, pr.number);

    // Fetch human PR comments so the reviewer knows what humans have already settled.
    // Claws comments and bot comments are excluded; capped at 20 most recent.
    let humanComments: Array<{ author: string; body: string }> = [];
    try {
      const allIssueComments = await gh.getIssueComments(fullName, pr.number);
      humanComments = allIssueComments
        .filter((c) => !c.login.endsWith("[bot]") && !gh.isClawsComment(c.body))
        .slice(-20)
        .map((c) => ({
          author: c.login,
          body: guardContent(c.body.slice(0, 2000), guardCtx("human-comment")),
        }));
    } catch { /* non-critical — reviewer works without this context */ }

    const issueContext = await buildIssueContext(fullName, pr);

    // Token usage is summed across multiple runClaude calls in the large-PR path
    // (per-large-file passes + normal-files batch); shared callback accumulates and writes after each call.
    const trackTokens = db.trackTaskTokens(taskId);

    let claudeOutput: string;

    if (isLargePR || diff.length > 50_000) {
      // Phase 2: Per-file review for large PRs
      const largeDiffs: Array<{ file: string; diff: string }> = [];
      const normalDiffs: string[] = [];

      if (isLargePR) {
        // Full diff wasn't fetched (maxBuffer error) — need a separate name-only call.
        // --name-only output is just filenames, so FILE_DIFF_MAX_BUFFER (50 MB) is more than enough.
        const fileList = await claude.git(
          ["diff", "--name-only", `origin/${pr.baseRefName}...HEAD`],
          wtPath,
          { maxBuffer: FILE_DIFF_MAX_BUFFER },
        );
        const files = fileList.split("\n").filter(Boolean);

        for (const file of files) {
          try {
            const fileDiff = await claude.git(
              ["diff", `origin/${pr.baseRefName}...HEAD`, "--", file],
              wtPath,
              { maxBuffer: FILE_DIFF_MAX_BUFFER },
            );
            if (fileDiff.length > LARGE_FILE_THRESHOLD) {
              largeDiffs.push({ file, diff: fileDiff });
            } else {
              normalDiffs.push(fileDiff);
            }
          } catch (fileErr) {
            if (/maxBuffer/.test(String(fileErr))) {
              largeDiffs.push({ file, diff: `[Diff too large to review — ${file} should be reviewed manually]` });
            } else {
              throw fileErr;
            }
          }
        }
      } else {
        // Full diff is already in memory — extract per-file segments directly to avoid N extra git calls.
        const segments = diff.split(/(?=^diff --git )/m).filter((s) => s.startsWith("diff --git "));
        for (const segment of segments) {
          const fileMatch = segment.match(/^diff --git a\/.* b\/(.+)$/m);
          if (!fileMatch) continue;
          if (segment.length > LARGE_FILE_THRESHOLD) {
            largeDiffs.push({ file: fileMatch[1], diff: segment });
          } else {
            normalDiffs.push(segment);
          }
        }
      }

      log.info(`[pr-reviewer] Large PR #${pr.number} in ${fullName}: ${largeDiffs.length} large file(s), ${normalDiffs.length} normal file(s)`);

      const reviewSegments: string[] = [];

      // Review large files individually with structure-appropriate prompts
      for (const { file, diff: fileDiff } of largeDiffs) {
        if (fileDiff.startsWith("[Diff too large")) {
          reviewSegments.push(`### ${file}\n${fileDiff}`);
          continue;
        }

        const ext = file.split(".").pop()?.toLowerCase() ?? "";
        const isDataFile = ["json", "yaml", "yml", "csv", "xml", "toml", "lock"].includes(ext);
        const fileDiffTruncated = fileDiff.length > 50_000;
        const truncatedFileDiff = fileDiff.slice(0, 50_000);

        // Per-file context: OVERVIEW.md + this single file's full content.
        // A large file that's being reviewed benefits most from seeing its
        // own post-change content (the diff hides everything outside the
        // hunks) and from the project overview.
        const perFileContext = buildReviewContext(wtPath, [file], pr.title, issueContext.length);

        const filePrompt = [
          `You are reviewing a single large file change from a pull request in ${fullName}.`,
          `PR #${pr.number}: ${guardContent(pr.title, guardCtx("pr-title"))}`,
          `File: ${guardContent(file, guardCtx("file-path"))}`,
          ``,
          perFileContext,
          issueContext,
          ...(humanComments.length > 0 ? [
            `## Human reviewer comments on this PR`,
            ``,
            `These are directives from human reviewers. If a human has explicitly settled an implementation choice, do NOT raise an issue against that choice — re-flagging a settled topic creates a loop where automated reviews keep reverting human-directed changes.`,
            ``,
            ...humanComments.map((c) => `**@${c.author}**:\n${c.body}\n`),
            ``,
          ] : []),
          ...(needsReassessment ? [
            `**Important — Reassessment needed**: This PR has been reviewed ${history.count} times previously with issues found each time that have not been fully resolved.`,
            ``,
            `Previous review feedback:`,
            ...history.previousFeedback.slice(-5).map((fb, i) => [
              `--- Review ${i + 1} ---`,
              fb.slice(0, 3000),
              ``,
            ]).flat(),
            `Given that similar issues keep recurring despite fixes being attempted, take a step back and consider:`,
            `- Are there recurring themes across these reviews?`,
            `- Is the current implementation approach fundamentally sound, or would a different approach avoid these issues entirely?`,
            `- Rather than listing the same problems again, suggest an alternative approach if one exists.`,
            ``,
            `If you believe a different approach would be more effective, lead your review with a "## Suggested Approach Change" section explaining the recommended alternative.`,
            ``,
          ] : []),
          `Here is the diff for this file:`,
          "```diff",
          truncatedFileDiff,
          "```",
          ...(fileDiffTruncated ? [`[Note: diff truncated due to file size limit]`, ``] : [``]),
          ...(isDataFile ? [
            `This is a data/config file (${ext}). Review for:`,
            `- Schema validity and structural correctness`,
            `- Format consistency with existing patterns`,
            `- Key/value correctness and field naming conventions`,
            `- Missing required fields or unexpected additions`,
          ] : [
            `Review this file for:`,
            ...(issueContext ? [`- Whether the PR delivers what the refined plan above describes (falling back to the originating issue only when no plan was posted) — treat the refined plan as authoritative and do NOT report intentional divergence from the original issue as a missing requirement or scope drift`] : []),
            `- Bugs and logic errors`,
            `- Security issues`,
            `- Performance problems`,
            `- Missing error handling`,
          ]),
          ``,
          RUNNER_POLICY_CONTEXT,
          ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN ? [homeAssistantContext()] : []),
          ``,
          `Be concise and specific. Every issue you raise MUST include the specific line number(s) and a clear description of what is wrong and how to fix it. Do NOT raise an issue if you cannot provide these details.`,
          `If no issues, end your response with this marker on its own line: ${REVIEW_CLEAN_RESULT_MARKER}`,
          `Do not include generic praise or filler — only actionable feedback.`,
          ``,
          `If you find issues, end your review with a model recommendation for the review-addresser.`,
          `Include this marker as plain text on its own line: recommended-model: sonnet or recommended-model: opus`,
          `Do not use HTML comments (<!-- ... -->) for this or any other marker — all output must be human-readable.`,
          `Choose sonnet for straightforward fixes (style issues, simple bugs, obvious error handling, test additions following existing patterns).`,
          `Choose opus for complex changes (architectural issues, security fixes, multi-file refactors, novel logic).`,
        ].join("\n");

        const fileReview = await claude.runClaude(filePrompt, wtPath, { capability: "text-only", mcpConfig: mcpConfigPath, timeoutMs, tier: prTier ?? "sonnet", model, provider: "claude", appendSystemPrompt: agentDoc, onTokensUsed: trackTokens, envSanitization: "passthrough" });

        if (!isCleanReview(fileReview)) {
          reviewSegments.push(`### ${file}\n${fileReview.trim()}`);
        }
      }

      // Review normal-sized files together with the standard prompt
      if (normalDiffs.length > 0) {
        const joined = normalDiffs.join("\n");
        const truncated = joined.length > 50_000;
        const combinedNormalDiff = truncated ? joined.slice(0, 50_000) : joined;

        // Context for the combined normal-file pass: include only the
        // normal-sized files (the large files get their own per-file calls
        // above with their own context blocks).
        const normalFiles = changedFilesFromDiff(joined);
        const normalContext = buildReviewContext(wtPath, normalFiles, pr.title, issueContext.length);

        const normalPrompt = buildStandardReviewPrompt(
          fullName, pr, combinedNormalDiff, guardCtx, needsReassessment, history, normalContext, issueContext, humanComments,
        ) + (truncated ? "\n\n[Note: diff truncated due to combined diff size limit]" : "");

        const normalReview = await claude.runClaude(normalPrompt, wtPath, { capability: "text-only", mcpConfig: mcpConfigPath, timeoutMs, tier: prTier ?? "sonnet", model, provider: "claude", appendSystemPrompt: agentDoc, onTokensUsed: trackTokens, envSanitization: "passthrough" });

        if (!isCleanReview(normalReview)) {
          reviewSegments.push(normalReview.trim());
        }
      }

      if (reviewSegments.length === 0) {
        // Dispatches ran but found no issues
        claudeOutput = REVIEW_CLEAN_RESULT_MARKER;
      } else {
        claudeOutput = reviewSegments.join("\n\n---\n\n");
      }
    } else {
      // Normal-sized PR: standard single-pass review
      const truncatedDiff = diff.slice(0, 50_000);

      // Pre-load codebase context (OVERVIEW.md + full content of changed files)
      // since the reviewer runs on the direct-HTTP OpenRouter path with no
      // filesystem tools.
      const changedFiles = changedFilesFromDiff(diff);
      const contextBlock = buildReviewContext(wtPath, changedFiles, pr.title, issueContext.length);

      const prompt = buildStandardReviewPrompt(
        fullName, pr, truncatedDiff, guardCtx, needsReassessment, history, contextBlock, issueContext, humanComments,
      );

      claudeOutput = await claude.runClaude(prompt, wtPath, { capability: "text-only", mcpConfig: mcpConfigPath, timeoutMs, tier: prTier ?? "sonnet", model, provider: "claude", appendSystemPrompt: agentDoc, onTokensUsed: trackTokens });
    }

    // Suppress vague/incomplete reviews — treat them as "no issues found" rather
    // than posting unactionable feedback (see issue #953).
    if (isVagueReview(claudeOutput)) {
      log.warn(`[pr-reviewer] Suppressing vague review for PR #${pr.number} in ${fullName}`);
      claudeOutput = REVIEW_CLEAN_RESULT_MARKER;
    } else if (!isCleanReview(claudeOutput) && isNoActionableReview(claudeOutput)) {
      log.info(`[pr-reviewer] Re-review raised no actionable issues for PR #${pr.number} in ${fullName} — treating as clean`);
      claudeOutput = REVIEW_CLEAN_RESULT_MARKER;
    }

    if (isCleanReview(claudeOutput)) {
      log.info(`[pr-reviewer] No issues found for PR #${pr.number} in ${fullName}`);

      const headSha = await gh.getPRHeadSHA(fullName, pr.number);
      const reviewBody = buildReviewBody(
        "Reviewed — no issues found.",
        headSha,
        nextIteration,
        true,
      );

      await postOrEditReview(fullName, pr.number, reviewBody, existingComment);

      try {
        const [ciStatus, mergeState] = await Promise.all([
          gh.getPRCheckStatus(fullName, pr.number),
          gh.getPRMergeableState(fullName, pr.number),
        ]);
        if (ciStatus === "passing" && mergeState !== "CONFLICTING") {
          await gh.addLabel(fullName, pr.number, LABELS.ready);
        }
      } catch (err) {
        log.warn(`[pr-reviewer] Could not check CI/merge state for clean review of PR #${pr.number} in ${fullName} — skipping ready label: ${err}`);
      }
      db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "reviewed" });
      return;
    }

    // Embed the reviewed commit SHA in the comment for future change detection
    const headSha = await gh.getPRHeadSHA(fullName, pr.number);
    const reviewBody = buildReviewBody(
      claudeOutput.trim(),
      headSha,
      nextIteration,
    );

    await postOrEditReview(fullName, pr.number, reviewBody, existingComment);
    log.info(`[pr-reviewer] Posted review for PR #${pr.number} in ${fullName}`);

    db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "reviewed" });
      },
      { detach: true },
    );

    if (result === null) {
      log.info(`[pr-reviewer] Branch ${pr.headRefName} no longer exists for PR #${pr.number} in ${fullName} — skipping (likely merged/closed)`);
      db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "skipped" });
    }
  });
}

/** Check if a PR is ready for the Ready label (clean review + CI passing + no merge conflicts). */
export async function maybeAddReadyLabel(
  repo: string,
  prNumber: number,
): Promise<boolean> {
  try {
    const existing = await getLatestReviewComment(repo, prNumber);
    if (!existing) return false;

    const hasCleanMarker = REVIEW_CLEAN_RESULT_PATTERN.test(existing.body);
    const hasCleanRegex = (() => {
      const stripped = extractCurrentReviewContent(existing.body);
      return !!stripped && /^Reviewed\s*—\s*no issues found\.?$/i.test(stripped);
    })();
    const hasNoActionable = isNoActionableReview(existing.body);

    if (!hasCleanMarker && !hasCleanRegex && !hasNoActionable) return false;

    const [ciStatus, mergeState] = await Promise.all([
      gh.getPRCheckStatus(repo, prNumber),
      gh.getPRMergeableState(repo, prNumber),
    ]);
    if (ciStatus === "passing" && mergeState !== "CONFLICTING") {
      await gh.addLabel(repo, prNumber, LABELS.ready);
      return true;
    }
    return false;
  } catch (err) {
    log.warn(`[pr-reviewer] maybeAddReadyLabel failed for ${repo}#${prNumber}: ${err}`);
    return false;
  }
}
