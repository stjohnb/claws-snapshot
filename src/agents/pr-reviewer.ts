import type { CommentRef, IssueRef } from "../issue-id.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { LABELS, HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN, REVIEW_MODEL_TIER, isAgentDisabled, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { getItemTimeoutMs } from "../timeout-handler.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { getModel, normalizeTier, type ModelTier } from "../model-selector.js";
import { RUNNER_POLICY_CONTEXT, HOST_EXECUTION_POLICY, NO_STACKED_PRS_POLICY, REVIEW_VERIFICATION_CONTEXT, FAST_CHECKS_GUIDANCE, forgeContext, frontendContext, homeAssistantContext, loadRepoAgentDoc } from "./agent-context.js";
import * as planParser from "../plan-parser.js";
import { resolveModelPlanCell } from "../model-plan.js";
import { approvedRequirementsOrNull, approvedRequirementsSection, loadApprovedRequirements } from "../approved-requirements.js";
import type { Provider } from "../plan-parser.js";
import { isHomeAssistantConfigRepo, homeAssistantMcpAvailable } from "../home-assistant.js";

// ── Review context enrichment ────────────────────────────────────────────────
// The reviewer runs on the Claude CLI with full tool access (Bash, Read,
// Grep) in the PR's own worktree — it can run `git` and read files directly.
// Even so, claws pre-loads codebase context into the prompt as a
// convenience/token-saver so the agent doesn't need to re-derive it:
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
    `Below is background material loaded from the repository — the project documentation (maintained by the doc-maintainer job) and the current contents of the files changed in this PR. Use this to understand invariants, surrounding code, and existing patterns BEFORE evaluating the diff. The diff alone does not show enough context to review properly. The file contents shown are the POST-CHANGE state — this PR's diff is already applied, so the change under review will already appear present. You also have git and file-read tools in this worktree; use them to check anything not shown here.`,
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

/** {@link buildIssueContext}'s result: the prompt text, and whether it listed the approved record's criteria. */
export interface IssueContext {
  text: string;
  /** True when the approved record's acceptance criteria are in `text` — drives {@link acceptanceCriteriaReviewLines} directly, instead of that function re-deriving it by searching `text` for a heading the plan or issue body could also contain. */
  hasCriteria: boolean;
}

const EMPTY_ISSUE_CONTEXT: IssueContext = { text: "", hasCriteria: false };

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
): Promise<IssueContext> {
  const issueNumber = gh.getLinkedIssueNumber(pr);
  if (issueNumber === null) return EMPTY_ISSUE_CONTEXT;

  const issueGuardCtx = makeGuardCtx(fullName, issueNumber);

  let issueBody: string;
  try {
    issueBody = await gh.getIssueBody(fullName, issueNumber);
  } catch (err) {
    log.warn(`[pr-reviewer] Could not fetch linked issue #${issueNumber} for PR #${pr.number}: ${err}`);
    return EMPTY_ISSUE_CONTEXT;
  }

  let comments: { body: string }[] = [];
  try {
    comments = await gh.getIssueComments(fullName, issueNumber);
  } catch (err) {
    log.warn(`[pr-reviewer] Could not fetch comments for issue #${issueNumber}: ${err}`);
    // Still emit the issue body section below
  }

  const planText = planParser.findPlanComment(comments);

  // The approved requirements record's acceptance criteria, when the issue has
  // one — the fixed yardstick the review checks the PR against. Loaded before
  // the empty-context check below, so an issue with an approved record but no
  // body or plan yet (e.g. a fresh native issue whose writer run finished but
  // whose planner hasn't) still gets reviewed against its criteria.
  const approved = approvedRequirementsOrNull(await loadApprovedRequirements(fullName, issueNumber));

  const guardedBody = guardContent(issueBody, issueGuardCtx("issue-body"));
  const truncatedBody = guardedBody.length > 5_000
    ? guardedBody.slice(0, 5_000) + "\n\n[... truncated ...]"
    : guardedBody;

  const guardedPlan = planText !== null ? guardContent(planText, issueGuardCtx("issue-plan")) : null;
  const truncatedPlan = guardedPlan !== null
    ? (guardedPlan.length > 8_000 ? guardedPlan.slice(0, 8_000) + "\n\n[... truncated ...]" : guardedPlan)
    : null;

  if (!truncatedBody && truncatedPlan === null && !approved) return EMPTY_ISSUE_CONTEXT;

  const criteriaSection = approved ? approvedRequirementsSection(approved, "reviewer", issueGuardCtx) : null;
  const criteria = criteriaSection !== null
    ? (criteriaSection.length > 8_000 ? criteriaSection.slice(0, 8_000) + "\n\n[... truncated ...]" : criteriaSection)
    : null;
  const criteriaLines = criteria !== null ? [criteria, ``] : [];
  const hasCriteria = criteria !== null;

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
      ...criteriaLines,
      `### Issue #${issueNumber} body (original report — background only)`,
      ``,
      truncatedBody,
    ];

    return { text: parts.join("\n"), hasCriteria };
  }

  const parts: string[] = [
    `## Originating Issue`,
    ``,
    `This PR was created in response to **issue #${issueNumber}** in this repository. Use the issue text below as the source of truth for what the PR is expected to deliver. When reviewing the diff, evaluate not only correctness but whether the change actually addresses what the issue describes. Flag missing requirements, missed acceptance criteria, or scope creep beyond what was asked.`,
    ``,
    `Note: If the PR body indicates this is one of multiple PRs (e.g. "PR 2 of 3"), evaluate delivery only against the phase described in the PR body — items belonging to other phases are out of scope.`,
    ``,
    ...criteriaLines,
    `### Issue #${issueNumber} body`,
    ``,
    truncatedBody,
  ];

  return { text: parts.join("\n"), hasCriteria };
}

/**
 * The review-checklist bullet asking for an `## Acceptance criteria` section,
 * when {@link buildIssueContext} listed the approved record's criteria.
 */
export function acceptanceCriteriaReviewLines(hasCriteria: boolean): string[] {
  if (!hasCriteria) return [];
  return [
    `- Every approved acceptance criterion listed above: your review MUST contain an \`## Acceptance criteria\` section naming each criterion with \`met\`, \`not met\` or \`deferred to PR N\` (a multi-PR plan puts it in another PR's phase). A criterion that is not met is a "severity: blocking" finding with its file and line number(s). This section does not replace the \`${REVIEW_CLEAN_RESULT_MARKER}\` marker — a review with every criterion met or deferred still ends with it.`,
  ];
}

/**
 * Per-file variant of {@link acceptanceCriteriaReviewLines} for a large PR's
 * per-file review pass: that pass sees only one file's diff, so it cannot
 * judge whether the PR as a whole satisfies each criterion — a criterion this
 * file doesn't touch would otherwise be reported as "not met" and land as a
 * false blocking finding. The `## Acceptance criteria` section itself is owned
 * by the normal-files pass ({@link buildStandardReviewPrompt}), or by
 * {@link buildAcceptanceCriteriaAggregatePrompt} when a large PR has no
 * normal-sized files at all.
 */
export function perFileAcceptanceCriteriaReviewLines(hasCriteria: boolean): string[] {
  if (!hasCriteria) return [];
  return [
    `- The approved acceptance criteria listed above: you are reviewing only this one file out of a larger PR and cannot see whether the rest of the PR satisfies the other criteria. Do NOT produce an \`## Acceptance criteria\` section and do NOT mark any criterion \`met\` or \`not met\` here — a separate pass covers the full PR. Flag a criterion only if THIS FILE'S change actively breaks or contradicts it, as a normal "severity: blocking" finding with file and line number(s).`,
  ];
}

/**
 * One-purpose prompt for a large PR that has no normal-sized-file pass to own
 * the `## Acceptance criteria` section (every changed file was large enough to
 * get its own per-file pass, which — per {@link perFileAcceptanceCriteriaReviewLines}
 * — deliberately doesn't judge criteria met/not-met). The model has full tool
 * access to the worktree, so it can inspect the real diff and file contents
 * itself rather than being handed one already truncated to fit a prompt.
 */
function buildAcceptanceCriteriaAggregatePrompt(
  repo: Repo,
  pr: gh.PR,
  guardCtx: (source: string) => { repo: string; source: string; itemNumber: IssueRef },
  issueContext: string,
  changedFiles: readonly string[],
): string {
  const fullName = repo.fullName;
  return [
    `You are checking whether a pull request in ${fullName} satisfies its approved acceptance criteria.`,
    `PR #${pr.number}: ${guardContent(pr.title, guardCtx("pr-title"))}`,
    `Branch: ${guardContent(pr.headRefName, guardCtx("pr-branch"))} → ${pr.baseRefName}`,
    ``,
    issueContext,
    ``,
    `This PR was too large to review in a single pass, so it was split into per-file reviews that each covered only their own diff and could not judge criteria satisfied by other files. This pass exists only to check the criteria against the PR as a whole.`,
    ``,
    `Changed files:`,
    ...changedFiles.map((f) => `- ${guardContent(f, guardCtx("file-path"))}`),
    ``,
    `Use the tools available in this worktree to inspect the actual changes — e.g. run \`git diff origin/${pr.baseRefName}...HEAD\` yourself, or read individual files.`,
    ``,
    RUNNER_POLICY_CONTEXT,
    HOST_EXECUTION_POLICY,
    forgeContext(repo),
    ``,
    `Your ONLY task is to produce the acceptance-criteria section below. Do NOT raise other findings — those are handled by the separate per-file reviews.`,
    ...acceptanceCriteriaReviewLines(true),
    ``,
    `If every criterion is met or deferred, end your response with this marker on its own line: ${REVIEW_CLEAN_RESULT_MARKER}`,
    `Otherwise reply with ONLY the \`## Acceptance criteria\` section — no other text.`,
  ].join("\n");
}

const REVIEW_HEADER = "## PR Review";
const REVIEW_ITERATION_PATTERN = /(?:<!-- )?review-iteration: (\d+)(?: -->)?/g;
const REASSESSMENT_THRESHOLD = 3;
// `cheap` is the old spelling of `haiku` and still appears in markers on PRs
// opened before the tier vocabulary was unified.
const RECOMMENDED_MODEL_PATTERN = /(?:<!-- )?recommended-model: (fable|opus|sonnet|haiku|cheap)(?: -->)?/g;
const PR_REVIEW_MODEL_PATTERN = /(?:<!-- )?review-model: (fable|opus|sonnet|haiku|cheap)(?: -->)?/g;

/** Ranking used to escalate between competing markers: higher wins. */
const TIER_RANK: Readonly<Record<ModelTier, number>> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };

/**
 * Extract the recommended model tier from the review text.
 * Only considers markers after the last "## PR Review" header to avoid
 * spoofed markers from PR body/diff content that may be quoted earlier.
 * Uses escalation: the highest tier any segment recommends wins.
 */
export function extractRecommendedModel(text: string): ModelTier {
  const headerIdx = text.lastIndexOf(REVIEW_HEADER);
  const searchText = headerIdx >= 0 ? text.slice(headerIdx) : text;
  const tiers = [...searchText.matchAll(RECOMMENDED_MODEL_PATTERN)]
    .map((m) => normalizeTier(m[1]))
    .filter((tier): tier is ModelTier => tier !== null);
  if (tiers.length === 0) return "sonnet";
  return tiers.reduce((best, tier) => (TIER_RANK[tier] > TIER_RANK[best] ? tier : best));
}

/** Extract the review model tier from a PR body marker. */
export function extractPRReviewModel(body: string): ModelTier | null {
  const matches = [...body.matchAll(PR_REVIEW_MODEL_PATTERN)];
  return matches.length > 0 ? normalizeTier(matches[matches.length - 1][1]) : null;
}

const REVIEW_PROVIDER_PATTERN = /review-provider: (openrouter|claude)/;
const REVIEW_CLEAN_RESULT_MARKER = "review-result: clean";
const REVIEW_CLEAN_RESULT_PATTERN = /review-result: clean/;
const REVIEW_ADVISORY_RESULT_MARKER = "review-result: advisory";
// Distinct from REVIEW_ADVISORY_RESULT_MARKER: an escalated review was paused for a
// human because the loop never converged, not because the findings were non-blocking.
// It must not be treated as Ready-eligible the way a genuine advisory-only review is.
const REVIEW_ESCALATED_RESULT_MARKER = "review-result: escalated";
const REVIEW_ADDRESSED_PATTERN = /review-addressed:\s*`?[0-9a-f]{7,40}`?/gi;
type ReviewResult = NonNullable<db.TaskOutcome["reviewResult"]>;

/** Escalate to a human after this many review rounds without convergence. */
const MAX_REVIEW_ITERATIONS = 8;
/** Advisory self-fix caps — a fix bigger than this is not a nit; abandon it. */
const AUTOFIX_MAX_FILES = 5;
const AUTOFIX_MAX_LINES = 60;
/** Summary text for the collapsed per-iteration audit log inside the review comment. */
const ARCHIVE_SUMMARY = "Previous review iterations (audit log — do not edit)";
/** Keep at most this many prior iterations in the audit log (bounds comment growth). */
const ARCHIVE_MAX_ENTRIES = 6;
/** Truncate each archived iteration to this many chars (bounds comment growth). */
const ARCHIVE_MAX_ENTRY_CHARS = 2500;
const ARCHIVE_ENTRY_RE = /@@@ ITERATION (\d+) @@@\n([\s\S]*?)(?=\n@@@ ITERATION \d+ @@@|\s*$)/g;
const ARCHIVE_DETAILS_RE = /<details>\s*<summary>Previous review iterations[\s\S]*?<\/summary>([\s\S]*?)<\/details>/;

const REVIEW_EFFECTIVENESS: Record<ReviewResult, { signal: string; score: number }> = {
  clean: { signal: "pr-review-clean", score: 1 },
  advisory: { signal: "pr-review-advisory", score: 0.5 },
  blocking: { signal: "pr-review-blocking", score: -1 },
  escalated: { signal: "pr-review-escalated", score: -1 },
  "empty-diff": { signal: "pr-review-empty-diff", score: -1 },
};

async function recordReviewedHeadSignal(
  fullName: string,
  pr: gh.PR,
  reviewerTaskId: number,
  reviewedHeadSha: string,
  result: ReviewResult,
  iteration: number,
): Promise<void> {
  try {
    const task = await db.findLatestCompletedTaskForPrHead(fullName, pr.number, reviewedHeadSha);
    if (!task) {
      log.info(`[pr-reviewer] No completed producer task found for ${fullName}#${pr.number} head ${reviewedHeadSha.slice(0, 12)}; skipping effectiveness signal`);
      return;
    }
    const mapped = REVIEW_EFFECTIVENESS[result];
    await db.recordTaskEffectivenessEvent({
      taskId: task.id,
      source: "pr-review",
      sourceRepo: fullName,
      sourceNumber: pr.number,
      sourceSha: reviewedHeadSha,
      signal: mapped.signal,
      score: mapped.score,
      details: { reviewerTaskId, iteration },
    });
  } catch (err) {
    log.warn(`[pr-reviewer] Could not record effectiveness signal for ${fullName}#${pr.number}: ${err}`);
  }
}

/**
 * Record a terminal review round in `pr_reviews`, then emit the effectiveness
 * signal. `signalHeadSha` is the head the model actually reviewed; it differs
 * from `headSha` only on the advisory self-fix path, where the record (like the
 * comment marker) carries the pushed fix commit.
 */
async function persistReviewRound(round: {
  fullName: string;
  pr: gh.PR;
  taskId: number;
  headSha: string;
  signalHeadSha?: string;
  baseSha: string;
  verdict: ReviewResult;
  iteration: number;
  findings: string | null;
  mode: ReviewMode;
  provider: string | null;
  model: string | null;
}): Promise<void> {
  try {
    await db.recordPRReview({
      repo: round.fullName,
      prNumber: round.pr.number,
      headSha: round.headSha,
      reviewedSha: round.signalHeadSha ?? round.headSha,
      baseSha: round.baseSha,
      verdict: round.verdict,
      mode: round.mode,
      iteration: round.iteration,
      reviewerTaskId: round.taskId,
      provider: round.provider,
      model: round.model,
      findings: round.findings,
    });
  } catch (err) {
    log.warn(`[pr-reviewer] Could not record review round for ${round.fullName}#${round.pr.number}: ${err}`);
  }
  await recordReviewedHeadSignal(round.fullName, round.pr, round.taskId, round.signalHeadSha ?? round.headSha, round.verdict, round.iteration);
}

// ── Incremental re-review ────────────────────────────────────────────────────
// When the last recorded round's head is an ancestor of the current head and
// the merge-base is unchanged, only `<reviewed>..HEAD` is new material; the
// reviewer gets that delta plus its previous verdict and findings.

type ReviewMode = "full" | "incremental";
export type ReviewModeDecision =
  | { mode: "full"; reason: string }
  | { mode: "incremental"; reviewedSha: string; deltaFiles: number; deltaLines: number };

/** An incremental round is only allowed when the delta touches at most this many files… */
export const INCREMENTAL_MAX_FILES = 10;
/** …and at most this many changed (added + deleted) lines… */
export const INCREMENTAL_MAX_LINES = 400;
/** …and at most this fraction of the full PR diff's changed lines. */
export const INCREMENTAL_MAX_FRACTION = 0.5;
/** Verdicts a later round may build on incrementally. */
const INCREMENTAL_BASE_VERDICTS: ReadonlySet<ReviewResult> = new Set(["clean", "advisory", "blocking"]);

/** Sum a `git diff --numstat` output. Binary files ("-") count as 0 lines. */
function sumNumstat(numstat: string): { files: number; lines: number } {
  let files = 0;
  let lines = 0;
  for (const row of numstat.split("\n")) {
    if (!row.trim()) continue;
    files++;
    const [add, del] = row.split("\t");
    lines += (Number(add) || 0) + (Number(del) || 0);
  }
  return { files, lines };
}

/** Reasons that rule out an incremental round before any git work; null when it is still possible. */
function incrementalPrecheck(prev: db.PRReviewRecord | null, rebuttal: string | null): string | null {
  if (!prev) return "no recorded review";
  if (!INCREMENTAL_BASE_VERDICTS.has(prev.verdict)) return `previous verdict was ${prev.verdict}`;
  if (rebuttal) return "a rebuttal is pending";
  if (!prev.baseSha) return "previous review has no recorded base";
  return null;
}

/**
 * Decide whether this round reviews the whole PR or only the delta since the
 * last recorded review. Pure — callers gather the git facts; any git failure
 * should be passed through as a full review rather than reaching here.
 */
export function decideReviewMode(input: {
  prev: db.PRReviewRecord | null;
  rebuttal: string | null;
  isAncestor: boolean;
  baseSha: string | null;
  deltaNumstat: string;
  fullNumstat: string;
}): ReviewModeDecision {
  const pre = incrementalPrecheck(input.prev, input.rebuttal);
  if (pre) return { mode: "full", reason: pre };
  const prev = input.prev!;
  if (!input.isAncestor) return { mode: "full", reason: `reviewed head ${prev.headSha.slice(0, 7)} is not an ancestor of HEAD (rebase/force-push)` };
  if (!input.baseSha || input.baseSha !== prev.baseSha) return { mode: "full", reason: "base moved since the last review" };
  const delta = sumNumstat(input.deltaNumstat);
  if (delta.files === 0) return { mode: "full", reason: "no delta since the last review" };
  if (delta.files > INCREMENTAL_MAX_FILES || delta.lines > INCREMENTAL_MAX_LINES) {
    return { mode: "full", reason: `delta too large (${delta.files} files / ${delta.lines} lines)` };
  }
  const full = sumNumstat(input.fullNumstat);
  if (delta.lines > full.lines * INCREMENTAL_MAX_FRACTION) {
    return { mode: "full", reason: `delta is ${delta.lines} of ${full.lines} changed lines` };
  }
  return { mode: "incremental", reviewedSha: prev.reviewedSha ?? prev.headSha, deltaFiles: delta.files, deltaLines: delta.lines };
}

/** `git merge-base origin/<base> HEAD` in the worktree, or `''` when it cannot be computed. */
async function computeBaseSha(wtPath: string, pr: gh.PR): Promise<string> {
  try {
    return (await claude.git(["merge-base", `origin/${pr.baseRefName}`, "HEAD"], wtPath)).trim();
  } catch (err) {
    log.warn(`[pr-reviewer] Could not compute merge-base for PR #${pr.number}: ${err}`);
    return "";
  }
}

/** Gather the git facts for {@link decideReviewMode}. Any git error means a full review. */
async function chooseReviewMode(
  wtPath: string,
  pr: gh.PR,
  prev: db.PRReviewRecord | null,
  rebuttal: string | null,
): Promise<{ decision: ReviewModeDecision; baseSha: string | null }> {
  const pre = incrementalPrecheck(prev, rebuttal);
  if (pre) return { decision: { mode: "full", reason: pre }, baseSha: null };
  try {
    const baseSha = await computeBaseSha(wtPath, pr);
    if (!baseSha) return { decision: { mode: "full", reason: "could not compute merge-base" }, baseSha: null };
    let isAncestor = true;
    try {
      await claude.git(["merge-base", "--is-ancestor", prev!.headSha, "HEAD"], wtPath);
    } catch {
      isAncestor = false; // exit 1 (not an ancestor) or 128 (unknown commit)
    }
    const base = { prev, rebuttal, isAncestor, baseSha };
    if (!isAncestor || baseSha !== prev!.baseSha) {
      return { decision: decideReviewMode({ ...base, deltaNumstat: "", fullNumstat: "" }), baseSha };
    }
    // Delta from the commit actually reviewed, not the recorded head — on an
    // advisory self-fix round those differ, and starting from the fix commit
    // would let it silently escape review forever (see reviewedSha's doc comment).
    const deltaBase = prev!.reviewedSha ?? prev!.headSha;
    const deltaNumstat = await claude.git(["diff", "--numstat", `${deltaBase}..HEAD`], wtPath);
    const fullNumstat = await claude.git(["diff", "--numstat", `origin/${pr.baseRefName}...HEAD`], wtPath);
    return { decision: decideReviewMode({ ...base, deltaNumstat, fullNumstat }), baseSha };
  } catch (err) {
    return { decision: { mode: "full", reason: `incremental check failed: ${err}` }, baseSha: null };
  }
}

async function persistProviderModel(taskId: number, provider: Provider, model: string): Promise<void> {
  const results = await Promise.allSettled([
    db.updateTaskProvider(taskId, provider),
    db.updateTaskModel(taskId, model),
  ]);
  for (const r of results) {
    if (r.status === "rejected") log.warn(`[pr-reviewer] Could not persist provider/model for task ${taskId}: ${r.reason}`);
  }
}

function extractReviewedCommit(commentBody: string): string | null {
  const match = commentBody.match(gh.REVIEWED_COMMIT_PATTERN);
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
): Promise<{ id: CommentRef; body: string } | null> {
  const comments = await gh.getIssueComments(repo, prNumber);
  let latest: { id: CommentRef; body: string } | null = null;
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
  prefetched?: { id: CommentRef; body: string } | null,
): Promise<{ count: number; previousFeedback: string[] }> {
  const existing = prefetched !== undefined ? prefetched : await getLatestReviewComment(repo, prNumber);
  if (!existing) return { count: 0, previousFeedback: [] };

  // With single-comment editing, iteration count is tracked via a marker
  const iterationCount = extractIterationCount(existing.body);

  // Recover the full per-round history from the collapsed audit log plus the
  // current (latest) round's visible content, so the reassessment prompt has
  // real multi-round material to step back over.
  const feedback: string[] = [];
  for (const e of parseReviewArchive(existing.body)) if (e.content) feedback.push(e.content);
  const current = extractCurrentReviewContent(existing.body);
  if (current && !/^Reviewed\s*—\s*no issues found\.?$/i.test(current) && !/no net changes/i.test(current)) {
    feedback.push(current);
  }

  return { count: iterationCount, previousFeedback: feedback };
}

/**
 * True when the current round of the Claws review comment is an escalation to a
 * human (a blocking finding the implementer refuted, or a review loop that never
 * converged). Both escalation paths apply `Manual Action` without writing anything
 * into the PR body, so anything deciding whether that label still has a live reason
 * must ask here rather than inspecting the body (#2462).
 *
 * Only the current round counts — the collapsed audit log archives prior rounds
 * verbatim, markers included, so a raw substring check over the whole comment would
 * see a stale escalation from a round that has since been superseded.
 *
 * The `pr_reviews` record is read first so an escalation survives the comment being
 * edited or deleted; the comment is still consulted when the record is not escalated,
 * because rows backfilled from observability data can miss the latest round.
 *
 * Errs toward true on failure: a missed escalation silently un-escalates a PR a human
 * was told to settle, which is far worse than leaving a label on for another sweep.
 */
export async function hasEscalatedReview(repo: string, prNumber: number): Promise<boolean> {
  try {
    const latest = await db.getLatestPRReview(repo, prNumber);
    if (latest?.verdict === "escalated") return true;
    const existing = await getLatestReviewComment(repo, prNumber);
    if (!existing) return false;
    return stripReviewArchive(existing.body).includes(REVIEW_ESCALATED_RESULT_MARKER);
  } catch (err) {
    log.warn(`[pr-reviewer] hasEscalatedReview failed for ${repo}#${prNumber} — assuming escalated: ${err}`);
    return true;
  }
}

/**
 * Determine if the PR has new commits since the last review. The latest
 * `pr_reviews` record decides first (full-SHA match), so a recorded verdict
 * survives the review comment being edited or deleted. The comment's
 * `Reviewed commit:` marker is the fallback — for PRs reviewed before the
 * record existed, and for a head the record missed (a backfill gap or a failed
 * write), so deploying the record never triggers a re-review storm.
 *
 * The head SHA is fetched only when there's something recorded to compare it
 * against — a never-reviewed PR (no record, no comment, or a comment with no
 * marker) returns `true` without the extra GitHub API call.
 */
export async function hasNewCommitsSinceLastReview(
  repo: string,
  prNumber: number,
): Promise<boolean> {
  try {
    const latest = await db.getLatestPRReview(repo, prNumber);
    if (!latest) {
      const existing = await getLatestReviewComment(repo, prNumber);
      if (!existing) return true; // never reviewed → should review
      const reviewedCommit = extractReviewedCommit(existing.body);
      if (!reviewedCommit) return true; // no SHA marker → legacy comment, re-review
      const headSha = await gh.getPRHeadSHA(repo, prNumber);
      return !headSha.startsWith(reviewedCommit);
    }
    const headSha = await gh.getPRHeadSHA(repo, prNumber);
    if (latest.headSha === headSha) return false;
    const existing = await getLatestReviewComment(repo, prNumber);
    if (!existing) return true; // never reviewed → should review
    const reviewedCommit = extractReviewedCommit(existing.body);
    if (!reviewedCommit) return true; // no SHA marker → legacy comment, re-review
    return !headSha.startsWith(reviewedCommit);
  } catch {
    return true; // err on the side of re-reviewing
  }
}

/**
 * Returns the review-addresser's rebuttal text when the latest review comment is
 * marked `review-rebutted: <HEAD sha>` — i.e. the implementer declined to make the
 * requested change at the current HEAD and the reviewer has not yet reconsidered.
 * Returns null on any error (never re-review speculatively).
 */
export async function getPendingRebuttal(repo: string, prNumber: number): Promise<string | null> {
  try {
    const existing = await getLatestReviewComment(repo, prNumber);
    if (!existing) return null;
    const currentBody = stripReviewArchive(existing.body);
    const m = currentBody.match(gh.REVIEW_REBUTTED_PATTERN);
    if (!m || !m[1]) return null;
    // A rewritten review body clears the marker, so its presence means "not yet considered".
    if (REVIEW_CLEAN_RESULT_PATTERN.test(currentBody)) return null;
    const headSha = await gh.getPRHeadSHA(repo, prNumber);
    if (!headSha.startsWith(m[1])) return null;
    const comments = await gh.getIssueComments(repo, prNumber);
    let summary: string | null = null;
    for (const c of comments) {
      if (gh.isClawsComment(c.body) && c.body.includes(gh.ADDRESSER_COMMENT_MARKER)) summary = c.body;
    }
    if (!summary) return null;
    return gh.stripClawsMarker(summary).replaceAll(gh.ADDRESSER_COMMENT_MARKER, "").trim().slice(0, 6000);
  } catch {
    return null;
  }
}

/** Post or edit the single Claws review comment on a PR. */
async function postOrEditReview(
  fullName: string,
  prNumber: number,
  reviewBody: string,
  existingComment: { id: CommentRef; body: string } | null,
): Promise<void> {
  if (existingComment) {
    // Carry forward the one-shot advisory stamp: this function rewrites the whole
    // body every round, so without this a re-review would clear it and allow a
    // second advisory fix round. The archive can't be relied on (entries are
    // truncated to ARCHIVE_MAX_ENTRY_CHARS), so copy the marker explicitly.
    const stamp = existingComment.body.match(gh.ADVISORY_ADDRESSED_PATTERN);
    const body = stamp && !gh.ADVISORY_ADDRESSED_PATTERN.test(reviewBody)
      ? `${reviewBody}\n${stamp[0]}`
      : reviewBody;
    await gh.editIssueComment(fullName, existingComment.id, body, { agentName: "Reviewer" });
  } else {
    await gh.commentOnIssue(fullName, prNumber, reviewBody, { agentName: "Reviewer" });
  }
}

/** Parse the collapsed per-iteration audit log from a review comment body. */
function parseReviewArchive(body: string): { iteration: number; content: string }[] {
  const m = body.match(ARCHIVE_DETAILS_RE);
  if (!m) return [];
  const out: { iteration: number; content: string }[] = [];
  ARCHIVE_ENTRY_RE.lastIndex = 0;
  let em: RegExpExecArray | null;
  while ((em = ARCHIVE_ENTRY_RE.exec(m[1])) !== null) out.push({ iteration: Number(em[1]), content: em[2].trim() });
  return out;
}

/** Render the collapsed per-iteration audit log block. */
function renderReviewArchive(entries: { iteration: number; content: string }[]): string {
  if (entries.length === 0) return "";
  const body = [...entries].sort((a, b) => a.iteration - b.iteration)
    .map((e) => `@@@ ITERATION ${e.iteration} @@@\n${e.content}`).join("\n\n");
  return `<details>\n<summary>${ARCHIVE_SUMMARY}</summary>\n\n${body}\n\n</details>`;
}

/** Build the archive block for the NEXT comment: prior archive + the previous round's visible content. */
function buildReviewArchive(existing: { body: string } | null, prevIteration: number): string {
  if (!existing) return "";
  const entries = parseReviewArchive(existing.body);
  const prev = extractCurrentReviewContent(existing.body);
  const isClean = /^Reviewed\s*—\s*no issues found\.?$/i.test(prev) || /no net changes/i.test(prev);
  if (prev && !isClean && !entries.some((e) => e.iteration === prevIteration)) {
    entries.push({ iteration: prevIteration, content: prev });
  }
  const trimmed = entries.slice(-ARCHIVE_MAX_ENTRIES)
    .map((e) => ({ iteration: e.iteration, content: e.content.slice(0, ARCHIVE_MAX_ENTRY_CHARS) }));
  return renderReviewArchive(trimmed);
}

/** Build a review body with iteration tracking. */
function buildReviewBody(
  content: string,
  headSha: string,
  iteration: number,
  clean = false,
  archiveBlock = "",
  advisory = false,
  escalated = false,
  modelAttribution = "",
  incrementalNote = "",
  ciNote = "",
): string {
  const parts = [
    REVIEW_HEADER,
    "",
    `*Review #${iteration}*`,
    ...(incrementalNote ? [incrementalNote] : []),
    ...(modelAttribution ? ["", modelAttribution] : []),
    ...(ciNote ? ["", ciNote] : []),
    "",
    content,
    "",
    makeCommitMarker(headSha.slice(0, 12)),
    makeIterationMarker(iteration),
  ];
  if (clean) parts.push(REVIEW_CLEAN_RESULT_MARKER);
  else if (escalated) parts.push(REVIEW_ESCALATED_RESULT_MARKER);
  else if (advisory) parts.push(REVIEW_ADVISORY_RESULT_MARKER);
  if (archiveBlock) parts.push("", archiveBlock);
  return parts.join("\n");
}

/**
 * Strip the collapsed per-iteration audit log (`<details>…</details>`) from a
 * review comment body so raw marker checks see only the current round's content.
 * The archive stores prior rounds verbatim, including their review-result markers.
 */
function stripReviewArchive(body: string): string {
  return body.replace(/<details>[\s\S]*?<\/details>/gi, "");
}

/** Extract the main review content (excluding headers, markers, and collapsed blocks) from a review comment body. */
function extractCurrentReviewContent(body: string): string {
  return gh.stripClawsMarker(body)
    .replace(/## PR Review\s*/, "")
    .replace(/\*Review #\d+\*\s*/, "")
    .replace(gh.REVIEWED_COMMIT_PATTERN, "")
    .replace(REVIEW_ITERATION_PATTERN, "")
    .replace(REVIEW_PROVIDER_PATTERN, "")
    .replace(/\*CI at review time:[^\n]*\*\s*/, "")
    .replace(REVIEW_CLEAN_RESULT_PATTERN, "")
    .replace(REVIEW_ADDRESSED_PATTERN, "")
    .replace(/review-rebutted:\s*`?[0-9a-f]{0,40}`?/gi, "")
    .replace(/advisory-addressed:\s*`?[0-9a-f]{0,40}`?/gi, "")
    .replace(/<details>[\s\S]*?<\/details>/g, "")
    .trim();
}

/** CI state of the PR head, read once right before the review runs. */
export interface CiSnapshot {
  status: "passing" | "failing" | "pending" | "none" | "unknown";
  failing: string[];
  pending: string[];
  passed: number;
  total: number;
}

/**
 * Snapshot the PR's checks for the review prompt and comment. Never throws: a
 * read failure degrades to "unknown" so CI state can never block a review.
 * `status` is derived exactly as `gh.getPRCheckStatus` derives it.
 */
export async function ciSnapshot(repo: string, prNumber: number): Promise<CiSnapshot> {
  try {
    const checks = await gh.listPRChecks(repo, prNumber);
    const failing = checks.filter((c) => c.outcome === "failing").map((c) => c.name);
    const pending = checks.filter((c) => c.outcome === "pending").map((c) => c.name);
    const total = checks.length;
    const passed = checks.filter((c) => c.outcome === "passing").length;
    const status = failing.length > 0 ? "failing"
      : total > 0 && passed === total ? "passing"
      : total === 0 ? "none"
      : "pending";
    return { status, failing, pending, passed, total };
  } catch (err) {
    log.warn(`[pr-reviewer] Could not read CI checks for ${repo}#${prNumber} — reporting CI as unknown: ${err}`);
    return { status: "unknown", failing: [], pending: [], passed: 0, total: 0 };
  }
}

const CI_SECTION_MAX_NAMES = 10;

/** Formats a list of check names, capping how many are shown. */
function names(list: string[], guard: (text: string) => string = (t) => t): string {
  const shown = list.slice(0, CI_SECTION_MAX_NAMES).map(guard).join(", ");
  return list.length > CI_SECTION_MAX_NAMES ? `${shown} (+${list.length - CI_SECTION_MAX_NAMES} more)` : shown;
}

/** Prompt lines stating the CI snapshot as a fact the reviewer must not re-check. */
export function ciStatusSection(snapshot: CiSnapshot, guard: (text: string) => string = (t) => t): string[] {
  return [
    `## CI state at review time`,
    ``,
    `- Status: ${snapshot.status}`,
    ...(snapshot.status === "unknown" ? [] : [`- Checks: ${snapshot.passed}/${snapshot.total} passing`]),
    ...(snapshot.failing.length > 0 ? [`- Failing: ${names(snapshot.failing)}`] : []),
    ...(snapshot.pending.length > 0 ? [`- Pending: ${names(snapshot.pending)}`] : []),
    ``,
    `Cite this as a fact. Do not re-check or wait for it.`,
    ``,
  ];
}

/** The harness-written CI line every posted review carries. */
function buildCiNote(snapshot: CiSnapshot): string {
  const detail = snapshot.status === "failing" ? ` — failing: ${names(snapshot.failing)}`
    : snapshot.status === "pending" ? ` — ${snapshot.passed}/${snapshot.total} checks complete`
    : "";
  return `*CI at review time: ${snapshot.status}${detail}*`;
}

const DEFERRED_WAIT_RE = /\b(wait|waiting|pause|pausing|hold off|check back)\b[\s\S]{0,120}\b(ci|checks?|pipeline|workflow|run)\b/i;
const DEFERRED_BACKGROUND_RE = /\bbackground (task|check|job)\b/i;

/**
 * True when the model's output announces it is waiting on CI instead of being a
 * review (e.g. "I'll pause here and wait for the background CI check task…").
 * Posting that as a review would claim a round happened when none did.
 */
export function isDeferredToCiReview(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed || trimmed.length >= 600) return false;
  if (/\bseverity:/i.test(trimmed) || /review-result:/i.test(trimmed)) return false;
  return DEFERRED_WAIT_RE.test(trimmed) || DEFERRED_BACKGROUND_RE.test(trimmed);
}

function isCleanReview(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return true;
  const lastLine = trimmed.split('\n').at(-1)?.trim() ?? '';
  return lastLine === REVIEW_CLEAN_RESULT_MARKER;
}

/** Drop the trailing `${REVIEW_CLEAN_RESULT_MARKER}` line from a clean review, keeping the rest of its body. */
function stripCleanMarker(output: string): string {
  const lines = output.trim().split("\n");
  if (lines.at(-1)?.trim() === REVIEW_CLEAN_RESULT_MARKER) lines.pop();
  return lines.join("\n").trim();
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

/** True iff the review carries findings but every severity tag is advisory (none blocking). Conservative: untagged → false. */
export function isAdvisoryOnlyReview(output: string): boolean {
  const content = output.includes(REVIEW_HEADER) ? extractCurrentReviewContent(output) : output.trim();
  if (!content) return false;
  const hasAdvisory = /severity:\s*advisory/i.test(content);
  const hasBlocking = /severity:\s*blocking/i.test(content);
  return hasAdvisory && !hasBlocking;
}

/** Human-reviewer directives block, shared by the standard and per-large-file
 *  review prompts. Returns [] when there are no human comments. */
function humanCommentsSection(humanComments: Array<{ author: string; body: string }>): string[] {
  if (humanComments.length === 0) return [];
  return [
    `## Human reviewer comments on this PR`,
    ``,
    `These are directives from human reviewers. If a human has explicitly settled an implementation choice, do NOT raise an issue against that choice — re-flagging a settled topic creates a loop where automated reviews keep reverting human-directed changes.`,
    ``,
    ...humanComments.map((c) => `**@${c.author}**:\n${c.body}\n`),
    ``,
  ];
}

/** Prior-review-history / reassessment block, shared by the standard and
 *  per-large-file review prompts. Returns [] unless reassessment is needed. */
function reassessmentSection(
  needsReassessment: boolean,
  history: { count: number; previousFeedback: string[] },
): string[] {
  if (!needsReassessment) return [];
  return [
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
  ];
}

/** Previous-round block for an incremental re-review. Returns the prompt lines placed before the diff. */
function incrementalReviewSection(
  pr: gh.PR,
  incremental: { reviewedSha: string; verdict: ReviewResult; findings: string | null },
): string[] {
  return [
    `## Incremental re-review`,
    ``,
    `You already reviewed this PR at commit \`${incremental.reviewedSha.slice(0, 12)}\` and reached the verdict **${incremental.verdict}**. Only the commits since then are new. Your previous findings were:`,
    ``,
    // Self-authored Claws review output (stored in pr_reviews) — not guarded,
    // matching the treatment of history.previousFeedback.
    incremental.findings?.trim() || "(no findings recorded)",
    ``,
    `For this round:`,
    `- For EACH previous finding, say whether it is now addressed or still open. Re-raise every still-open finding at its original severity.`,
    `- Review the delta below for new problems it introduces.`,
    `- Do NOT re-litigate code the delta leaves untouched that you already judged clean.`,
    `- The full PR diff is still available if you need surrounding context: run \`git diff origin/${pr.baseRefName}...HEAD\` in this worktree.`,
    ``,
  ];
}

function buildStandardReviewPrompt(
  repo: Repo,
  pr: gh.PR,
  truncatedDiff: string,
  guardCtx: (source: string) => { repo: string; source: string; itemNumber: IssueRef },
  needsReassessment: boolean,
  history: { count: number; previousFeedback: string[] },
  contextBlock: string,
  issueContext: string,
  /** Whether `issueContext` lists the approved record's acceptance criteria — see {@link IssueContext}. */
  hasCriteria: boolean,
  frontendCtx: string,
  humanComments: Array<{ author: string; body: string }> = [],
  rebuttal = "",
  incremental?: { reviewedSha: string; headSha: string; verdict: ReviewResult; findings: string | null },
  ciSection: string[] = [],
): string {
  const fullName = repo.fullName;
  return [
    `You are reviewing a pull request in the repository ${fullName}.`,
    `PR #${pr.number}: ${guardContent(pr.title, guardCtx("pr-title"))}`,
    `Branch: ${guardContent(pr.headRefName, guardCtx("pr-branch"))} → ${pr.baseRefName}`,
    ``,
    pr.body ? `PR Description:\n${guardContent(pr.body, guardCtx("pr-body"))}\n` : "",
    contextBlock,
    issueContext,
    ...humanCommentsSection(humanComments),
    ...(rebuttal ? [
      `## The implementer DECLINED your previous review — reconsider it now`,
      ``,
      `You previously blocked this PR. The implementer made NO code change and replied:`,
      ``,
      // Self-authored Claws content (the addresser's own summary comment) — not
      // guarded, matching the treatment of history.previousFeedback below.
      rebuttal,
      ``,
      `This is the last automated round for this disagreement. Decide, do not restate:`,
      `- VERIFY the implementer's claims yourself with the tools in this worktree (read the files, the lockfile, run the check) before deciding. Do not accept or reject the rebuttal on plausibility alone.`,
      `- If the rebuttal is correct, WITHDRAW the finding. Do not re-raise it in any form. If nothing else blocks, end your response with: ${REVIEW_CLEAN_RESULT_MARKER}`,
      `- If the finding was real but not merge-blocking, re-tag it "severity: advisory".`,
      `- Only keep it "severity: blocking" if you have verified the implementer is factually wrong; say exactly which claim is wrong and what evidence disproves it. Doing so escalates the PR to a human.`,
      ``,
    ] : []),
    ...reassessmentSection(needsReassessment, history),
    ...(incremental ? incrementalReviewSection(pr, incremental) : []),
    incremental
      ? `Here is the diff since the last review (\`${incremental.reviewedSha.slice(0, 7)}\`..\`${incremental.headSha.slice(0, 7)}\`):`
      : `Here is the diff for this PR:`,
    "```diff",
    truncatedDiff,
    "```",
    ``,
    ...ciSection,
    `Please review this PR for:`,
    ...(issueContext ? [`- Whether the PR delivers what the refined plan above describes (falling back to the originating issue only when no plan was posted) — treat the refined plan as authoritative and do NOT report intentional divergence from the original issue as a missing requirement or scope drift`] : []),
    ...acceptanceCriteriaReviewLines(hasCriteria),
    `- Bugs and logic errors`,
    `- Security issues`,
    `- Performance problems`,
    `- Missing error handling`,
    `- Style inconsistencies with the codebase`,
    `- Test coverage gaps`,
    `- Responsive behaviour: a UI change must work on phone, tablet and desktop per docs/DESIGN.md`,
    ``,
    REVIEW_VERIFICATION_CONTEXT,
    ``,
    RUNNER_POLICY_CONTEXT,
    HOST_EXECUTION_POLICY,
    NO_STACKED_PRS_POLICY,
    forgeContext(repo),
    frontendCtx,
    ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
    ``,
    `Enumerate EVERY issue you can find in this single pass — do not surface only the most salient one and hold the rest for a later round. Reviews are expensive; a finding you omit now costs another full fix-and-review cycle.`,
    `When a finding exposes a hole in the overall APPROACH or MECHANISM (not just a local slip), critique the mechanism and propose the STRUCTURAL fix, not the nearest patch. Example: if free-text/history scanning is used where a structured marker or data structure would be robust, say so now rather than patching one counterexample at a time.`,
    `Tag EVERY issue with a severity as plain text on its own line directly under the issue: "severity: blocking" (a correctness/security/data-loss bug, or a requirement the PR must meet) or "severity: advisory" (a nit, style preference, or optional improvement that need NOT hold up merge). Reserve advisory for things you would be comfortable merging without.`,
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


/**
 * Advisory self-fix (#2654): apply the reviewer's own non-blocking nits in the
 * worktree it already has, rather than deferring them to a whole extra
 * review-addresser round that the auto-merger usually beats to the punch.
 *
 * Deliberately narrow: one sonnet-tier call, tracked-file edits only, a hard
 * file/line cap with `reset --hard` if the agent overshoots, and a
 * deterministic commit message. Returns the pushed head SHA (read *after* the
 * push, since `pushBranch` may rebase) plus a one-line summary, or `null` when
 * nothing was pushed — in which case the caller posts the review unchanged.
 */
async function applyAdvisoryFixes(
  repo: Repo,
  pr: gh.PR,
  wtPath: string,
  mcpConfigPath: string,
  agentDoc: string | undefined,
  reviewText: string,
  timeoutMs: number | undefined,
  trackTokens: ReturnType<typeof db.trackTaskTokens>,
): Promise<{ sha: string; summary: string } | null> {
  const preSha = (await claude.getHeadSha(wtPath)).trim();

  // reviewText is Claws' own review output, not GitHub-supplied content — it is
  // not passed through guardContent.
  const fixPrompt = [
    `You are the PR reviewer for ${repo.fullName}. You have just reviewed PR #${pr.number} and every finding you raised is ADVISORY (non-blocking polish). You are now going to fix those nits yourself, in this worktree, instead of leaving them for another agent.`,
    ``,
    `Your findings:`,
    "```",
    reviewText,
    "```",
    ``,
    `Hard rules:`,
    `Apply ONLY self-contained, obviously-correct edits that the findings above explicitly name.`,
    `Do NOT refactor, rename, restructure, reformat unrelated code, or change behaviour beyond what a finding names.`,
    `Do NOT create new files and do NOT delete files — edit existing tracked files only. Do NOT run "git add" on any new file you create; only pre-existing tracked files will be committed.`,
    `Keep the total change under ${AUTOFIX_MAX_FILES} files and ${AUTOFIX_MAX_LINES} changed lines. If a finding cannot be fixed inside that budget, SKIP it.`,
    `If a finding is not worth the churn, or needs a design decision, SKIP it and say so.`,
    `Do NOT commit, do NOT run git commit, and do NOT push — leave your edits in the working tree.`,
    ``,
    FAST_CHECKS_GUIDANCE,
    RUNNER_POLICY_CONTEXT,
    HOST_EXECUTION_POLICY,
    NO_STACKED_PRS_POLICY,
    forgeContext(repo),
    ``,
    `Reply with ONE short paragraph (max 3 sentences) listing what you fixed and what you skipped. If you changed nothing, reply exactly: NO CHANGES`,
  ].join("\n");

  // Advisory nits never justify opus. The task's recorded model stays the
  // review's — this pass is an addendum, not a re-review.
  const model = getModel("sonnet", "claude");
  const out = await claude.runClaude(fixPrompt, wtPath, {
    mcpConfig: mcpConfigPath,
    timeoutMs,
    tier: "sonnet",
    model,
    provider: "claude",
    appendSystemPrompt: agentDoc,
    onTokensUsed: trackTokens,
    claudeEnv: claude.NO_BACKGROUND_TASKS_ENV,
    captureLabel: "pr-reviewer:autofix",
    githubTokenOwner: repo.owner,
    forgejoAccessRepo: repo.fullName,
  });

  // Stage tracked modifications only — this keeps agent scratch files,
  // node_modules and `.mcp-claws.json` out of the commit, *unless* the agent
  // explicitly `git add`ed a new file itself despite the prompt telling it not
  // to; `-u` only covers modifications/deletions to already-tracked paths.
  await claude.git(["add", "-u"], wtPath);
  const staged = (await claude.git(["diff", "--cached", "--name-only"], wtPath)).trim();
  if (staged) {
    // --no-verify: the worktree has no node_modules, so a husky-style hook would abort.
    await claude.git(["commit", "--no-verify", "-m", `fix: apply advisory review nits\n\n[pr-reviewer]`], wtPath);
  }

  // Measure against preSha rather than the staged set — this also catches an
  // agent that committed despite being told not to.
  const numstat = await claude.git(["diff", "--numstat", `${preSha}..HEAD`], wtPath);
  let files = 0;
  let lines = 0;
  for (const row of numstat.split("\n")) {
    if (!row.trim()) continue;
    files++;
    const [add, del] = row.split("\t");
    // Binary files report "-" in the numeric columns; count them as 0 lines.
    lines += (Number(add) || 0) + (Number(del) || 0);
  }
  if (files === 0) return null;

  if (files > AUTOFIX_MAX_FILES || lines > AUTOFIX_MAX_LINES) {
    log.warn(`[pr-reviewer] Advisory self-fix for ${repo.fullName}#${pr.number} exceeded caps (${files} files / ${lines} lines) — discarding`);
    await claude.git(["reset", "--hard", preSha], wtPath);
    return null;
  }

  await claude.pushBranch(wtPath, pr.headRefName, repo.owner);
  // Re-read after the push: pushBranch fetches and rebases onto origin/<branch>,
  // so the pre-push SHA can be stale — and a stale marker triggers a full re-review.
  // The push already landed at this point, so a failure here must fall back to
  // the remote HEAD rather than propagate — losing the SHA here must not be
  // treated the same as the fix never having been pushed.
  let sha: string;
  try {
    sha = (await claude.getHeadSha(wtPath)).trim();
  } catch (err) {
    log.warn(`[pr-reviewer] Could not read local HEAD after advisory self-fix push for ${repo.fullName}#${pr.number}, falling back to remote HEAD: ${err}`);
    sha = await gh.getPRHeadSHA(repo.fullName, pr.number);
  }

  // Record it as a Claws push, or the ci-fixer reads our own commit as manual
  // intervention and burns a bounded commit grant.
  try {
    await db.recordCIFixerPush(repo.fullName, pr.number, sha);
  } catch (err) {
    log.warn(`[pr-reviewer] Could not record advisory self-fix push for ${repo.fullName}#${pr.number}: ${err}`);
  }

  const summary = /^NO CHANGES$/im.test(out.trim()) ? "" : out.trim().slice(0, 500);
  return { sha, summary };
}

export async function processPR(repo: Repo, pr: gh.PR): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[pr-reviewer] Reviewing PR #${pr.number} in ${fullName}`);

  await db.withTaskRecording("pr-reviewer", fullName, pr.number, null, async (taskId) => {
    // Fetch existing review comment once for reuse
    const existingComment = await getLatestReviewComment(fullName, pr.number);
    const prevIteration = existingComment ? extractIterationCount(existingComment.body) : 0;
    let prevRecord: db.PRReviewRecord | null = null;
    try {
      prevRecord = await db.getLatestPRReview(fullName, pr.number);
    } catch (err) {
      log.warn(`[pr-reviewer] Could not read review record for ${fullName}#${pr.number}: ${err}`);
    }
    // The record keeps counting when the comment was deleted or edited away.
    const nextIteration = Math.max(prevIteration, prevRecord?.iteration ?? 0) + 1;
    const rebuttal = await getPendingRebuttal(fullName, pr.number);

    const result = await claude.withExistingWorktree(
      repo, pr.headRefName, "pr-reviewer",
      async (wtPath) => {
        await db.updateTaskWorktree(taskId, wtPath, pr.headRefName);
        const mcpConfigPath = claude.writeAgentMcpConfig(wtPath, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName) });
        const agentDoc = loadRepoAgentDoc(wtPath, fullName, "pr-reviewer");

    // Collapsed per-iteration audit log carried into the next comment. Computed
    // once from the previous review comment so every post below can archive the
    // prior round's content and feed real multi-round history to reassessment.
    const archiveBlock = buildReviewArchive(existingComment, prevIteration);

    // Get the diff for the PR — use two-phase strategy for large diffs
    const FULL_DIFF_MAX_BUFFER = 200 * 1024 * 1024;
    const FILE_DIFF_MAX_BUFFER = 50 * 1024 * 1024;
    const LARGE_FILE_THRESHOLD = 20_000; // chars; files above this get individual review

    // Full review, or only the delta since the last recorded round?
    const modeChoice = await chooseReviewMode(wtPath, pr, prevRecord, rebuttal);
    let recordedBaseSha = modeChoice.baseSha;
    const getBaseSha = async (): Promise<string> => (recordedBaseSha ??= await computeBaseSha(wtPath, pr));

    // Captured once, before the diff is taken or the model runs (which can take
    // many minutes), so a push that lands mid-review is correctly left for the
    // next round instead of being silently folded into this round's record.
    const reviewedHeadSha = (await claude.getHeadSha(wtPath)).trim();

    let diff = "";
    let isLargePR = false;
    let incremental: { reviewedSha: string; headSha: string; verdict: ReviewResult; findings: string | null } | undefined;
    if (modeChoice.decision.mode === "incremental") {
      const { reviewedSha, deltaFiles, deltaLines } = modeChoice.decision;
      diff = await claude.git(["diff", `${reviewedSha}..HEAD`], wtPath, { maxBuffer: FULL_DIFF_MAX_BUFFER });
      if (diff.trim()) {
        incremental = { reviewedSha, headSha: reviewedHeadSha, verdict: prevRecord!.verdict, findings: prevRecord!.findings };
        log.info(`[pr-reviewer] PR #${pr.number} in ${fullName}: incremental review of ${reviewedSha.slice(0, 7)}..${reviewedHeadSha.slice(0, 7)} (${deltaFiles} files / ${deltaLines} lines)`);
      } else {
        log.info(`[pr-reviewer] PR #${pr.number} in ${fullName}: falling back to full review — empty delta diff`);
      }
    } else {
      log.info(`[pr-reviewer] PR #${pr.number} in ${fullName}: full review — ${modeChoice.decision.reason}`);
    }
    const reviewMode: ReviewMode = incremental ? "incremental" : "full";

    if (!incremental) {
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
    }

    if (!diff.trim() && !isLargePR) {
      log.info(`[pr-reviewer] No diff for PR #${pr.number} in ${fullName} — posting empty-diff review`);

      const headSha = reviewedHeadSha;
      const content = "This PR has no net changes relative to the base branch — every commit has been reverted or cancelled out.\nIt should likely be closed.";
      const reviewBody = buildReviewBody(
        content,
        headSha,
        nextIteration,
        false,
        archiveBlock,
      );

      await postOrEditReview(fullName, pr.number, reviewBody, existingComment);
      log.info(`[pr-reviewer] Posted empty-diff review for PR #${pr.number} in ${fullName}`);

      await persistReviewRound({ fullName, pr, taskId, headSha, baseSha: await getBaseSha(), verdict: "empty-diff", iteration: nextIteration, findings: content, mode: reviewMode, provider: null, model: null });
      await db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "reviewed", reviewResult: "empty-diff", headSha, reviewIteration: nextIteration });
      return;
    }

    const timeoutMs = getItemTimeoutMs(fullName, pr.number);
    const prTier = pr.body ? extractPRReviewModel(pr.body) : null;
    // PR review runs tool-use on the Claude CLI (git/read access in the PR's
    // worktree) but is read-only by policy — it posts a comment and must not
    // modify files. Route through Claude CLI for review quality.
    // The linked issue's model plan (docs/model-selection.md) outranks the PR
    // marker and `reviewModelTier`. A PR with no linked issue (Dependabot, a
    // hand-rolled branch) has no plan to read and resolves exactly as before.
    const { provider, strictProvider, eligibleProviders, overrideIgnoredReason, tier: reviewTier, model } = await resolveModelPlanCell(fullName, gh.getLinkedIssueNumber(pr), "review", {
      tier: prTier ?? REVIEW_MODEL_TIER,
      labels: pr.labels,
      requiresMcp: homeAssistantMcpAvailable(fullName),
    });
    if (overrideIgnoredReason) log.warn(`[pr-reviewer] ${fullName}#${pr.number}: ${overrideIgnoredReason}`);
    const providerNote = overrideIgnoredReason ? `; ${overrideIgnoredReason}` : "";
    // One CI read, before any model run: the reviewer is told the state as a
    // fact and never waits on it — the Ready gate handles CI outcome separately.
    const ci = await ciSnapshot(fullName, pr.number);

    const history = await getReviewHistory(fullName, pr.number, existingComment);
    const needsReassessment = history.count >= REASSESSMENT_THRESHOLD;
    const guardCtx = makeGuardCtx(fullName, pr.number);
    const ciSection = ciStatusSection(ci, (t) => guardContent(t, guardCtx("ci-check")));

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

    const { text: issueContext, hasCriteria } = await buildIssueContext(fullName, pr);

    // Token usage is summed across multiple runClaude calls in the large-PR path
    // (per-large-file passes + normal-files batch); shared callback accumulates and writes after each call.
    const trackTokens = db.trackTaskTokens(taskId);
    let actualProvider: Provider = provider;
    let actualModel = model;
    const trackAttemptModel = (p: Provider, m: string | undefined) => {
      actualProvider = p;
      actualModel = m ?? "default";
    };

    let claudeOutput: string;

    try {
    // An incremental round's delta is bounded, so it always takes the single-pass prompt.
    if (!incremental && (isLargePR || diff.length > 50_000)) {
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
      // Body of a clean normal-files or aggregate pass, when `hasCriteria` — its only
      // content is the required `## Acceptance criteria` section, which must reach the
      // PR even when every pass is clean (a clean pass is otherwise dropped entirely).
      let criteriaSegment: string | null = null;

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
          ...humanCommentsSection(humanComments),
          ...reassessmentSection(needsReassessment, history),
          `Here is the diff for this file:`,
          "```diff",
          truncatedFileDiff,
          "```",
          ...(fileDiffTruncated ? [`[Note: diff truncated due to file size limit]`, ``] : [``]),
          ...ciSection,
          ...(isDataFile ? [
            `This is a data/config file (${ext}). Review for:`,
            `- Schema validity and structural correctness`,
            `- Format consistency with existing patterns`,
            `- Key/value correctness and field naming conventions`,
            `- Missing required fields or unexpected additions`,
          ] : [
            `Review this file for:`,
            ...(issueContext ? [`- Whether the PR delivers what the refined plan above describes (falling back to the originating issue only when no plan was posted) — treat the refined plan as authoritative and do NOT report intentional divergence from the original issue as a missing requirement or scope drift`] : []),
            ...perFileAcceptanceCriteriaReviewLines(hasCriteria),
            `- Bugs and logic errors`,
            `- Security issues`,
            `- Performance problems`,
            `- Missing error handling`,
          ]),
          ``,
          REVIEW_VERIFICATION_CONTEXT,
          ``,
          RUNNER_POLICY_CONTEXT,
          HOST_EXECUTION_POLICY,
          NO_STACKED_PRS_POLICY,
          forgeContext(repo),
          ...(HOME_ASSISTANT_BASE_URL && HOME_ASSISTANT_TOKEN && isHomeAssistantConfigRepo(fullName) ? [homeAssistantContext()] : []),
          ``,
          `Enumerate EVERY issue you can find in this single pass — do not surface only the most salient one and hold the rest for a later round. Reviews are expensive; a finding you omit now costs another full fix-and-review cycle.`,
          `When a finding exposes a hole in the overall APPROACH or MECHANISM (not just a local slip), critique the mechanism and propose the STRUCTURAL fix, not the nearest patch. Example: if free-text/history scanning is used where a structured marker or data structure would be robust, say so now rather than patching one counterexample at a time.`,
          `Tag EVERY issue with a severity as plain text on its own line directly under the issue: "severity: blocking" (a correctness/security/data-loss bug, or a requirement the PR must meet) or "severity: advisory" (a nit, style preference, or optional improvement that need NOT hold up merge). Reserve advisory for things you would be comfortable merging without.`,
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

        const fileReview = await claude.runClaude(filePrompt, wtPath, { mcpConfig: mcpConfigPath, timeoutMs, tier: reviewTier, model, provider, strictProvider, eligibleProviders, appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onAttemptModelUsed: trackAttemptModel, onTokensUsed: trackTokens, claudeEnv: claude.NO_BACKGROUND_TASKS_ENV, captureLabel: "pr-reviewer", githubTokenOwner: repo.owner, forgejoAccessRepo: repo.fullName, useOutputFile: true });

        if (isDeferredToCiReview(fileReview)) {
          log.warn(`[pr-reviewer] Model deferred the review of PR #${pr.number} in ${fullName} to wait for CI — not posting it: ${fileReview.trim().slice(0, 200)}`);
          throw new Error("pr-reviewer deferred the review to wait for CI; no review posted");
        }
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
          repo, pr, combinedNormalDiff, guardCtx, needsReassessment, history, normalContext, issueContext, hasCriteria, frontendContext(wtPath), humanComments, rebuttal ?? "", undefined, ciSection,
        ) + (truncated ? "\n\n[Note: diff truncated due to combined diff size limit]" : "");

        const normalReview = await claude.runClaude(normalPrompt, wtPath, { mcpConfig: mcpConfigPath, timeoutMs, tier: reviewTier, model, provider, strictProvider, eligibleProviders, appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onAttemptModelUsed: trackAttemptModel, onTokensUsed: trackTokens, claudeEnv: claude.NO_BACKGROUND_TASKS_ENV, captureLabel: "pr-reviewer", githubTokenOwner: repo.owner, forgejoAccessRepo: repo.fullName, useOutputFile: true });

        if (isDeferredToCiReview(normalReview)) {
          log.warn(`[pr-reviewer] Model deferred the review of PR #${pr.number} in ${fullName} to wait for CI — not posting it: ${normalReview.trim().slice(0, 200)}`);
          throw new Error("pr-reviewer deferred the review to wait for CI; no review posted");
        }
        if (!isCleanReview(normalReview)) {
          reviewSegments.push(normalReview.trim());
        } else if (hasCriteria) {
          criteriaSegment = stripCleanMarker(normalReview);
        }
      } else if (hasCriteria) {
        // Every changed file was large enough to get its own per-file pass, so
        // no pass above owns the `## Acceptance criteria` section — run one
        // dedicated aggregate pass so criteria coverage still gets checked.
        const aggregatePrompt = buildAcceptanceCriteriaAggregatePrompt(repo, pr, guardCtx, issueContext, largeDiffs.map((d) => d.file));
        const aggregateReview = await claude.runClaude(aggregatePrompt, wtPath, { mcpConfig: mcpConfigPath, timeoutMs, tier: reviewTier, model, provider, strictProvider, eligibleProviders, appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onAttemptModelUsed: trackAttemptModel, onTokensUsed: trackTokens, claudeEnv: claude.NO_BACKGROUND_TASKS_ENV, captureLabel: "pr-reviewer", githubTokenOwner: repo.owner, forgejoAccessRepo: repo.fullName, useOutputFile: true });

        if (isDeferredToCiReview(aggregateReview)) {
          log.warn(`[pr-reviewer] Model deferred the review of PR #${pr.number} in ${fullName} to wait for CI — not posting it: ${aggregateReview.trim().slice(0, 200)}`);
          throw new Error("pr-reviewer deferred the review to wait for CI; no review posted");
        }
        if (!isCleanReview(aggregateReview)) {
          reviewSegments.push(aggregateReview.trim());
        } else {
          criteriaSegment = stripCleanMarker(aggregateReview);
        }
      }

      // Captured before `criteriaSegment` (if any) is appended below — it must not
      // itself count as a finding when deciding whether the overall review is clean.
      const allClean = reviewSegments.length === 0;
      if (criteriaSegment) reviewSegments.push(criteriaSegment);

      if (reviewSegments.length === 0) {
        // Dispatches ran but found no issues
        claudeOutput = REVIEW_CLEAN_RESULT_MARKER;
      } else if (allClean) {
        claudeOutput = `${reviewSegments.join("\n\n---\n\n")}\n\n${REVIEW_CLEAN_RESULT_MARKER}`;
      } else {
        claudeOutput = reviewSegments.join("\n\n---\n\n");
      }
    } else {
      // Normal-sized PR: standard single-pass review
      const truncatedDiff = diff.slice(0, 50_000);

      // Pre-load codebase context (OVERVIEW.md + full content of changed files)
      // as a convenience; the reviewer also has git/file tools in this worktree.
      const changedFiles = changedFilesFromDiff(diff);
      const contextBlock = buildReviewContext(wtPath, changedFiles, pr.title, issueContext.length);

      const prompt = buildStandardReviewPrompt(
        repo, pr, truncatedDiff, guardCtx, needsReassessment, history, contextBlock, issueContext, hasCriteria, frontendContext(wtPath), humanComments, rebuttal ?? "", incremental, ciSection,
      );

      claudeOutput = await claude.runClaude(prompt, wtPath, { mcpConfig: mcpConfigPath, timeoutMs, tier: reviewTier, model, provider, strictProvider, eligibleProviders, appendSystemPrompt: agentDoc, onProviderUsed: (p) => { actualProvider = p; }, onAttemptModelUsed: trackAttemptModel, onTokensUsed: trackTokens, claudeEnv: claude.NO_BACKGROUND_TASKS_ENV, captureLabel: "pr-reviewer", githubTokenOwner: repo.owner, forgejoAccessRepo: repo.fullName, useOutputFile: true });
    }
    } finally {
      await persistProviderModel(taskId, actualProvider, actualModel);
    }
    if (isDeferredToCiReview(claudeOutput)) {
      log.warn(`[pr-reviewer] Model deferred the review of PR #${pr.number} in ${fullName} to wait for CI — not posting it: ${claudeOutput.trim().slice(0, 200)}`);
      throw new Error("pr-reviewer deferred the review to wait for CI; no review posted");
    }
    const modelAttribution = `*Models used: ${actualModel} (provider: ${actualProvider}${providerNote})*`;
    const ciNote = buildCiNote(ci);
    const incrementalNote = incremental
      ? `*Incremental review of \`${incremental.reviewedSha.slice(0, 7)}\`..\`${incremental.headSha.slice(0, 7)}\`*`
      : "";
    // Computed before any advisory self-fix push moves HEAD.
    const baseSha = await getBaseSha();
    const round = { fullName, pr, taskId, baseSha, iteration: nextIteration, mode: reviewMode, provider: actualProvider as string, model: actualModel };

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

      const headSha = reviewedHeadSha;
      // A clean review that carries a required `## Acceptance criteria` section (the
      // large-PR path's dedicated criteriaSegment, or a normal-sized pass's own section)
      // must not have that section thrown away in favor of the generic clean message.
      const cleanContent = hasCriteria && claudeOutput.trim() !== REVIEW_CLEAN_RESULT_MARKER
        ? `Reviewed — no issues found.\n\n${stripCleanMarker(claudeOutput)}`
        : "Reviewed — no issues found.";
      const reviewBody = buildReviewBody(
        cleanContent,
        headSha,
        nextIteration,
        true,
        archiveBlock,
        false,
        false,
        modelAttribution,
        incrementalNote,
        ciNote,
      );

      await postOrEditReview(fullName, pr.number, reviewBody, existingComment);

      try {
        const [ciStatus, mergeState] = await Promise.all([
          gh.getPRCheckStatus(fullName, pr.number),
          gh.getPRMergeableState(fullName, pr.number),
        ]);
        if (mergeState !== "CONFLICTING" && await ciAllowsReady(fullName, pr.number, ciStatus)) {
          await gh.addLabel(fullName, pr.number, LABELS.ready);
        }
      } catch (err) {
        log.warn(`[pr-reviewer] Could not check CI/merge state for clean review of PR #${pr.number} in ${fullName} — skipping ready label: ${err}`);
      }
      await persistReviewRound({ ...round, headSha, verdict: "clean", findings: "Reviewed — no issues found." });
      await db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "reviewed", reviewResult: "clean", headSha, reviewIteration: nextIteration });
      return;
    }

    // The implementer refuted this review and the reviewer still blocks after
    // reconsidering — a genuine disagreement only a human can settle. Escalate now
    // rather than leaving the PR with a blocking review nobody will act on (#2128).
    if (rebuttal && !isAdvisoryOnlyReview(claudeOutput)) {
      log.warn(`[pr-reviewer] PR #${pr.number} in ${fullName} — reviewer maintained a blocking finding the implementer refuted; escalating to human`);
      const headSha = reviewedHeadSha;
      const banner = `> ⚠️ **Escalated to human review** — the implementer declined to make this change and gave a justification; the reviewer reconsidered and still considers the finding blocking. A maintainer must settle this.\n\n`;
      const content = banner + claudeOutput.trim();
      const reviewBody = buildReviewBody(content, headSha, nextIteration, false, archiveBlock, /* advisory */ false, /* escalated */ true, modelAttribution, incrementalNote, ciNote);
      await postOrEditReview(fullName, pr.number, reviewBody, existingComment);
      try {
        await gh.addLabel(fullName, pr.number, LABELS.manualAction);
      } catch (err) {
        log.warn(`[pr-reviewer] Could not apply ${LABELS.manualAction} for #${pr.number}: ${err}`);
      }
      await persistReviewRound({ ...round, headSha, verdict: "escalated", findings: content });
      await db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "reviewed", reviewResult: "escalated", headSha, reviewIteration: nextIteration });
      return;
    }

    // Round cap: after too many rounds without converging, escalate to a human
    // instead of grinding on. Skipped when the review is advisory-only — that
    // means the PR converged (no blocking findings), not that it's stuck, so
    // it should fall through to the advisory branch below instead of being
    // treated as a non-converging loop.
    if (nextIteration > MAX_REVIEW_ITERATIONS && !isAdvisoryOnlyReview(claudeOutput)) {
      log.warn(`[pr-reviewer] PR #${pr.number} in ${fullName} exceeded ${MAX_REVIEW_ITERATIONS} review rounds — escalating to human`);
      const headSha = reviewedHeadSha;
      const banner = `> ⚠️ **Escalated to human review** — this PR has been through ${nextIteration} review rounds without converging. Automated re-review is paused; a maintainer should decide how to proceed.\n\n`;
      const content = banner + claudeOutput.trim();
      const reviewBody = buildReviewBody(content, headSha, nextIteration, false, archiveBlock, /* advisory */ false, /* escalated */ true, modelAttribution, incrementalNote, ciNote);
      await postOrEditReview(fullName, pr.number, reviewBody, existingComment);
      try {
        await gh.addLabel(fullName, pr.number, LABELS.manualAction);
      } catch (err) {
        log.warn(`[pr-reviewer] Could not apply ${LABELS.manualAction} for #${pr.number}: ${err}`);
      }
      await persistReviewRound({ ...round, headSha, verdict: "escalated", findings: content });
      await db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "reviewed", reviewResult: "escalated", headSha, reviewIteration: nextIteration });
      return;
    }

    // Advisory-only: the review has findings but they are all non-blocking. Record
    // it (audit trail intact) without withholding Ready or triggering another
    // addresser round.
    if (isAdvisoryOnlyReview(claudeOutput)) {
      log.info(`[pr-reviewer] Advisory-only review for PR #${pr.number} in ${fullName} — recording without another fix round`);

      // ── Advisory self-fix (#2654) ──
      // Each gate below means pushing now would be either impossible or harmful.
      let autofix: { sha: string; summary: string } | null = null;
      const alreadyAutofixed = !!existingComment && gh.ADVISORY_ADDRESSED_PATTERN.test(existingComment.body);
      if (
        !isAgentDisabled("reviewer-autofix") &&
        !rebuttal &&                                            // the implementer already declined; don't push it anyway
        !gh.isForkPR(pr) &&                                     // no push access to fork branches
        !pr.labels.some((l) => l.name === LABELS.automerge) &&  // merge imminent
        !alreadyAutofixed                                       // one-shot per PR — prevents fix→review→fix loops
      ) {
        try {
          autofix = await applyAdvisoryFixes(repo, pr, wtPath, mcpConfigPath, agentDoc, claudeOutput.trim(), timeoutMs, trackTokens);
        } catch (err) {
          log.warn(`[pr-reviewer] Advisory self-fix failed for ${fullName}#${pr.number} — posting review unchanged: ${err}`);
          autofix = null;
        }
      }

      const headSha = autofix ? autofix.sha : reviewedHeadSha;
      const banner = autofix
        ? `> ✅ **Advisory fixes applied by the reviewer** in commit \`${autofix.sha.slice(0, 7)}\` — these non-blocking nits were fixed in place rather than deferred to another agent round. The findings below are retained for the audit trail.\n${autofix.summary ? `>\n> ${autofix.summary.replace(/\n+/g, " ")}\n` : ""}\n`
        : "";
      const content = banner + claudeOutput.trim();
      let reviewBody = buildReviewBody(content, headSha, nextIteration, false, archiveBlock, /* advisory */ true, false, modelAttribution, incrementalNote, ciNote);
      // Stamping the pushed SHA here is what stops pr-dispatcher Phase 3 from
      // starting a redundant review-addresser advisory round.
      if (autofix) reviewBody += `\n${gh.ADVISORY_ADDRESSED_MARKER}: ${autofix.sha.slice(0, 12)}`;
      await postOrEditReview(fullName, pr.number, reviewBody, existingComment);
      try {
        const [ciStatus, mergeState] = await Promise.all([
          gh.getPRCheckStatus(fullName, pr.number),
          gh.getPRMergeableState(fullName, pr.number),
        ]);
        if (mergeState !== "CONFLICTING" && await ciAllowsReady(fullName, pr.number, ciStatus)) await gh.addLabel(fullName, pr.number, LABELS.ready);
      } catch (err) {
        log.warn(`[pr-reviewer] advisory-only Ready check failed for #${pr.number}: ${err}`);
      }
      // The record carries the pushed fix commit (as the comment marker does) so the
      // fix itself is not re-reviewed; the effectiveness signal scores the reviewed head.
      await persistReviewRound({ ...round, headSha, signalHeadSha: reviewedHeadSha, verdict: "advisory", findings: content });
      await db.recordTaskComplete(taskId, { commits: autofix ? 1 : 0, prNumber: pr.number, prAction: "reviewed", reviewResult: "advisory", headSha, reviewIteration: nextIteration });
      return;
    }

    // Embed the reviewed commit SHA in the comment for future change detection
    const headSha = reviewedHeadSha;
    const reviewBody = buildReviewBody(
      claudeOutput.trim(),
      headSha,
      nextIteration,
      false,
      archiveBlock,
      false,
      false,
      modelAttribution,
      incrementalNote,
      ciNote,
    );

    await postOrEditReview(fullName, pr.number, reviewBody, existingComment);
    log.info(`[pr-reviewer] Posted review for PR #${pr.number} in ${fullName}`);

    await persistReviewRound({ ...round, headSha, verdict: "blocking", findings: claudeOutput.trim() });
    await db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "reviewed", reviewResult: "blocking", headSha, reviewIteration: nextIteration });
      },
      { detach: true },
    );

    if (result === null) {
      log.info(`[pr-reviewer] Branch ${pr.headRefName} no longer exists for PR #${pr.number} in ${fullName} — skipping (likely merged/closed)`);
      await db.recordTaskComplete(taskId, { commits: 0, prNumber: pr.number, prAction: "skipped" });
    }
  });
}

/** CI gate for the Ready label: checks pass, or the PR has no checks ("none")
 * AND changes only CI-exempt paths, or the head is a docs-only follow-up (e.g.
 * the reviewer's own advisory self-fix) on top of a commit CI already validated
 * — see `gh.carriedForwardCheckStatus`. Without the "none" case, docs-only PRs
 * in repos whose CI path-ignores docs never trigger a workflow, so their status
 * never reaches "passing" and they can never become Ready. */
async function ciAllowsReady(
  repo: string,
  prNumber: number,
  ciStatus: Awaited<ReturnType<typeof gh.getPRCheckStatus>>,
): Promise<boolean> {
  if (ciStatus === "passing") return true;
  if (ciStatus !== "none") return false;
  const files = await gh.getPRChangedFiles(repo, prNumber);
  if (files.length > 0 && files.every(gh.isCiExemptPath)) return true;
  // The head commit may be a docs-only follow-up (e.g. the reviewer's advisory
  // self-fix) on a PR that does change code — CI ran and passed on the last
  // commit that wasn't CI-exempt, and that result still describes this tree.
  return (await gh.carriedForwardCheckStatus(repo, prNumber)) === "passing";
}

/** Check if a PR is ready for the Ready label (clean review + CI passing + no merge conflicts). */
export async function maybeAddReadyLabel(
  repo: string,
  prNumber: number,
): Promise<boolean> {
  try {
    const existing = await getLatestReviewComment(repo, prNumber);
    if (!existing) return false;

    // Inspect only the current round's content. The collapsed per-iteration
    // audit log archives prior rounds' bodies verbatim — including their
    // review-result markers — so a raw substring check on the whole body would
    // false-positive on a stale advisory/escalated marker from an earlier round.
    const currentBody = stripReviewArchive(existing.body);
    const hasCleanMarker = REVIEW_CLEAN_RESULT_PATTERN.test(currentBody);
    const hasCleanRegex = (() => {
      const stripped = extractCurrentReviewContent(existing.body);
      return !!stripped && /^Reviewed\s*—\s*no issues found\.?$/i.test(stripped);
    })();
    const hasNoActionable = isNoActionableReview(existing.body);
    const hasAdvisory = currentBody.includes(REVIEW_ADVISORY_RESULT_MARKER);
    // Escalated reviews are paused for a human to triage — never Ready-eligible,
    // even though they share the "don't re-fire the addresser" behavior with advisory.
    const hasEscalated = currentBody.includes(REVIEW_ESCALATED_RESULT_MARKER);
    if (hasEscalated) return false;

    if (!hasCleanMarker && !hasCleanRegex && !hasNoActionable && !hasAdvisory) return false;

    const [ciStatus, mergeState] = await Promise.all([
      gh.getPRCheckStatus(repo, prNumber),
      gh.getPRMergeableState(repo, prNumber),
    ]);
    if (mergeState !== "CONFLICTING" && await ciAllowsReady(repo, prNumber, ciStatus)) {
      await gh.addLabel(repo, prNumber, LABELS.ready);
      return true;
    }
    return false;
  } catch (err) {
    log.warn(`[pr-reviewer] maybeAddReadyLabel failed for ${repo}#${prNumber}: ${err}`);
    return false;
  }
}
