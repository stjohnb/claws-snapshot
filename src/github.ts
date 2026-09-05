import { execFile } from "node:child_process";
import { z } from "zod";
import { GITHUB_OWNERS, isForgejoRepo, FORGEJO_REPOS, LABELS, LABEL_SPECS, SKIPPED_ITEMS, PRIORITIZED_ITEMS, ALLOWED_ACTORS, CI_FIXER_MAX_ATTEMPTS, CI_FIXER_WINDOW_MS, writeConfig, SELF_REPO, type Repo, type ConfigFile } from "./config.js";
import * as log from "./log.js";
import { reportError } from "./error-reporter.js";
import { guardContent, makeGuardCtx } from "./prompt-guard.js";
import type { WorkflowRunRow } from "./db.js";
import { getInstallationTokenForOwner, getAnyInstallationToken, extractOwnerFromGhArgs, buildEnvForGh, getAppBotLogin, listInstallationRepositories, registerOnResetCallback } from "./github-app.js";
import { sleep, mapWithConcurrency, mapSettledWithConcurrency } from "./util.js";
import { retryWithBackoff } from "./retry.js";
import { TTLCache } from "./ttl-cache.js";
import * as forgejo from "./forgejo.js";
import { RateLimitError, isRateLimited, setRateLimited, clearRateLimitState, checkAndResumeAfterCooldown } from "./rate-limit.js";
import { recordGitHubEvent, extractRelatedNumbers } from "./github-events.js";

export { RateLimitError, isRateLimited, clearRateLimitState } from "./rate-limit.js";

const RATE_LIMIT_RE = /rate limit/i;

// Phrases that unambiguously identify a GitHub-side or network-side failure,
// independent of any HTTP status text. Shared by TRANSIENT_RE (retry
// eligibility) and GH_SERVER_ERROR_RE (TransientGitHubError wrapping) so a
// failure that was retried as server-side is also suppressed as server-side
// once retries are exhausted (#2147).
// `(?:^|[\s:])EOF\b` covers both Go EOF variants: `unexpected EOF`
// (io.ErrUnexpectedEOF — a sized read cut short) and gh's wrapping of a bare
// io.EOF, e.g. `failed to update https://github.com/o/r/issues/1: EOF`
// (connection closed before the HTTP response completed) (#2417). The
// leading `^|[\s:]` guard keeps it from matching `<<EOF` or an "EOF" token
// echoed out of issue/PR content in a gh error body.
const SERVER_SIDE_PHRASE_RE =
  /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAGAIN|connection reset)\b|TLS handshake timeout|Something went wrong|i\/o timeout|failed to create new OS thread|resource temporarily unavailable|(?:^|[\s:])EOF\b/i;

// Retry eligibility. Broader than SERVER_SIDE_PHRASE_RE: bare status codes and
// "Could not resolve to a" are worth *retrying* but are NOT safe to treat as
// server-side for reporting purposes (a bare 502 can appear in an echoed issue
// body; "Could not resolve to a" is usually a genuine bad ref).
// "invalid character" and "unexpected end of JSON input" are Go/gojq JSON-decode
// errors raised when GitHub returns a truncated or garbled response body to a
// `gh --jq` / `gh --json` call — a one-off network hiccup, so worth retrying (#2240).
const TRANSIENT_RE = new RegExp(
  `\\b(400|401|500|502|503|504)\\b|Could not resolve to a|invalid character|unexpected end of JSON input|${SERVER_SIDE_PHRASE_RE.source}`,
  "i",
);
const MAX_RETRIES = 3;

// gh prints `gh: HTTP 503` (or `HTTP 502: Bad gateway ...`) for GitHub-side 5xx.
// Requires the literal "HTTP" so a 502 appearing in an issue body/number can't
// match. Also matches the GraphQL-level phrases above, which carry no HTTP code.
const GH_SERVER_ERROR_RE = new RegExp(
  `\\bHTTP[ :]?(500|502|503|504)\\b|${SERVER_SIDE_PHRASE_RE.source}`,
  "i",
);

/**
 * A GitHub-side 5xx that survived gh()'s retry window. Self-healing: the
 * dispatcher re-queues the item next cycle, so error-reporter downgrades this
 * to a warning instead of opening a [claws-error] issue.
 */
export class TransientGitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientGitHubError";
  }
}

const apiCache = new TTLCache<unknown>();

export function clearApiCache(): void {
  // Exposed for tests
  apiCache.clear();
}

/** Visible header prepended to every comment Claws posts so conversations read naturally. */
export const CLAWS_VISIBLE_HEADER = "*— Automated by Claws —*";

/**
 * Build the full body of a comment Claws posts: the visible header (optionally
 * naming the agent) followed by a blank line and the caller's body. Shared by
 * commentOnIssue and editIssueComment so the two formats cannot drift.
 */
function buildClawsComment(body: string, agentName?: string): string {
  const header = agentName
    ? `*— Automated by Claws · ${agentName} —*`
    : CLAWS_VISIBLE_HEADER;
  return header + "\n\n" + body;
}

/** GitHub reaction used by review-addresser to mark comments as addressed. */
export const ADDRESSED_REACTION = "rocket";

/** Pattern to extract reviewed-commit SHA from a Claws PR review comment. */
export const REVIEWED_COMMIT_PATTERN = /Reviewed commit: `([0-9a-f]+)`/;

/** Marker appended by review-addresser when review is addressed without code changes. */
export const REVIEW_ADDRESSED_MARKER = "review-addressed";
const REVIEW_ADDRESSED_PATTERN = /(?:<!-- )?review-addressed: ([0-9a-f]+)(?: -->)?/;

/** Written by review-addresser when it declined/failed to make the reviewed change (no commits pushed). */
export const REVIEW_REBUTTED_MARKER = "review-rebutted";
export const REVIEW_REBUTTED_PATTERN = /(?:<!-- )?review-rebutted: ([0-9a-f]+)(?: -->)?/;

/** Stamped by review-addresser after its single advisory-only fix round; one-shot loop guard. */
export const ADVISORY_ADDRESSED_MARKER = "advisory-addressed";
export const ADVISORY_ADDRESSED_PATTERN = /(?:<!-- )?advisory-addressed: ([0-9a-f]+)(?: -->)?/;

/** Previous visible header — kept for backward compatibility with old comments. */
const LEGACY_VISIBLE_HEADER = "*— Automated by CLAWS —*";

/** Check whether a comment body was posted by Claws. */
export function isClawsComment(body: string): boolean {
  // Detect via visible header (new comments) or legacy HTML marker (old comments)
  return (
    /\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/.test(body) ||
    body.includes("<!-- claws-automated -->")
  );
}

/** Strip the Claws marker and visible header (with optional agent name) from a comment body. */
export function stripClawsMarker(body: string): string {
  return body
    .replace("<!-- claws-automated -->", "") // backward compat
    .replace(/\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/g, "")
    .replace(LEGACY_VISIBLE_HEADER, "")
    .trim();
}

// ── Repo cache (shared across all jobs) ──

const REPO_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

let repoCache: { repos: Repo[]; fetchedAt: number } | null = null;
let repoCachePromise: Promise<Repo[]> | null = null;

export function clearRepoCache(): void {
  repoCache = null;
  repoCachePromise = null;
}

// ── Category-based queue cache (populated by jobs as they classify items) ──

export type QueueCategory =
  | "ready"
  | "needs-refinement"
  | "refined"
  | "needs-review-addressing"
  | "auto-mergeable"
  | "needs-triage"
  | "problematic";

export const ALL_QUEUE_CATEGORIES: readonly QueueCategory[] = [
  "ready", "needs-refinement", "refined", "needs-review-addressing",
  "auto-mergeable", "needs-triage", "problematic",
];

export interface QueueItem {
  repo: string;
  number: number;
  title: string;
  category: QueueCategory;
  updatedAt: string;
  type: "issue" | "pr";
  checkStatus?: "passing" | "failing" | "pending";
  prNumber?: number;
  prioritized?: boolean;
  labels?: string[];
  mergeableState?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checksPassed?: number;
  checksTotal?: number;
  reviewStatus?: "clean" | "issues" | "escalated" | "none";
  reviewIssueCount?: number;
  infraPaths?: string[];
  tofuPlan?: TofuPlanSummary;
}

const queueCache = new Map<string, { item: QueueItem; fetchedAt: number }>();

/** How long a queue cache entry is considered fresh. Entries older than this
 * are evicted on read. Longer than the slowest dispatcher interval (10 min
 * for ci-fixer / triage) so a single transient scan failure does
 * not wipe the cache. */
export const QUEUE_ENTRY_TTL_MS = 20 * 60 * 1000;

export function isItemSkipped(repo: string, number: number): boolean {
  return SKIPPED_ITEMS.some((i) => i.repo === repo && i.number === number);
}

export function isItemPrioritized(repo: string, number: number): boolean {
  return PRIORITIZED_ITEMS.some((i) => i.repo === repo && i.number === number);
}

export function hasPriorityLabel(labels: { name: string }[]): boolean {
  return labels.some((l) => l.name === LABELS.priority);
}

export function hasIgnoreLabel(labels: { name: string }[]): boolean {
  return labels.some((l) => l.name === LABELS.clawsIgnore);
}

export function hasBlockedLabel(labels: { name: string }[]): boolean {
  return labels.some((l) => l.name === LABELS.blocked);
}

/** True when a label tells Claws to leave the item alone — the permanent
 *  `Claws Ignore` hand-off or the temporary `Blocked` park. */
export function isParked(labels: { name: string }[]): boolean {
  return hasIgnoreLabel(labels) || hasBlockedLabel(labels);
}

export function isDispatchSkippable(repoFullName: string, item: { number: number; labels: { name: string }[] }): boolean {
  return isItemSkipped(repoFullName, item.number) || isParked(item.labels);
}

// gh CLI returns "app/<slug>" for GitHub App authors in `--json author` output,
// while the REST /app endpoint (used by getAppBotLogin) returns `<slug>[bot]`.
// Normalize to the `[bot]` form so comparisons work regardless of which API
// produced the login.
export function normalizeBotLogin(login: string): string {
  if (login.startsWith("app/")) return `${login.slice("app/".length)}[bot]`;
  return login;
}

/**
 * Returns true if the login is in the configured allowedActors list or is
 * Claws' own login.
 *
 * Pass `repo` whenever a repo full name is in hand: Claws posts on a Forgejo
 * repo as the Forgejo token's own account, not as the GitHub App bot, so
 * without it Claws' own Forgejo comments are read as untrusted (#2650). The
 * parameter is optional only for the handful of call sites with no repo
 * context, which fall back to Claws' own repo owner.
 */
export async function isAllowedActor(login: string, repo?: string): Promise<boolean> {
  const normalized = normalizeBotLogin(login);
  if (ALLOWED_ACTORS.includes(login) || ALLOWED_ACTORS.includes(normalized)) return true;
  const self = repo ? await getSelfLoginForRepo(repo) : await getSelfLogin(SELF_REPO.split("/")[0]);
  return normalized === normalizeBotLogin(self);
}

const CI_FAILURE_ALERT_BOT_LOGINS = ["github-actions[bot]", "app/github-actions"];

/**
 * True if the issue's author is the GitHub Actions runner bot — in either the
 * gh-CLI `app/github-actions` form or the REST `github-actions[bot]` form.
 * Issues filed by this bot are CI/automation alerts (build failures, migration
 * failures, Lighthouse/Cypress regressions, etc.), not human work items, so the
 * issue-dispatcher's actor gate dispatches them into the refine-and-fix pipeline
 * even though the bot is not in `allowedActors`. This replaces the former
 * title-allowlist approach: any runner-authored issue is opted in, regardless of
 * title. Other bots (dependabot, etc.) are NOT covered — only the github-actions
 * runner logins in `CI_FAILURE_ALERT_BOT_LOGINS`.
 */
export function isCiAlertBotAuthor(issue: { author: { login: string }; title?: string }): boolean {
  return CI_FAILURE_ALERT_BOT_LOGINS.includes(issue.author.login);
}

export function skipItem(repo: string, number: number): void {
  const items = [...(SKIPPED_ITEMS as Array<{ repo: string; number: number }>)];
  if (!items.some((i) => i.repo === repo && i.number === number)) {
    items.push({ repo, number });
    writeConfig({ skippedItems: items });
  }
  removeQueueItem(repo, number);
}

export async function postProblematicPRComment(
  repo: string,
  prNumber: number,
  reason: string,
  attemptCount: number,
  recentErrors: Array<{ error: string; timestamp: string }>,
): Promise<void> {
  const body = [
    `### 🚫 PR Marked as Problematic`,
    `problematic-pr-marked`,
    "",
    `This PR has been automatically marked as problematic after **${attemptCount} failed CI fix attempts**.`,
    "",
    `**Reason:** ${reason}`,
    "",
    `Manual intervention is required to resolve the CI failures. The CI fixer will not make further automatic attempts.`,
    "",
    recentErrors.length > 0 ? "**Recent errors:**" : "",
    ...recentErrors.map((e, i) => {
      const timestamp = e.timestamp.includes("T") ? e.timestamp : e.timestamp.replace(" ", "T") + "Z";
      const formattedDate = new Date(timestamp).toLocaleString();
      const truncatedError = e.error.length > 1000 ? e.error.slice(0, 1000) + "\n... (truncated)" : e.error;
      const lines = [
        `<details>`,
        `<summary>Attempt ${recentErrors.length - i} (${formattedDate})</summary>`,
        "",
        "```",
        truncatedError,
        "```",
        "</details>",
      ];
      return lines.join("\n");
    }),
    "",
    `Push a commit to this PR and Claws will automatically make a fresh set of CI-fix attempts (a limited number of times). To retry immediately, remove the \`${LABELS.problematic}\` label.`,
  ].filter(Boolean).join("\n");

  await commentOnIssue(repo, prNumber, body, { agentName: "CI Fixer" });
}

export function removeQueueItem(repo: string, number: number): void {
  for (const key of queueCache.keys()) {
    if (key.endsWith(`:${repo}:${number}`)) queueCache.delete(key);
  }
}

/**
 * Evict queue-cache entries for `repo` in `categories` (optionally restricted
 * to one item `type`) whose item number is NOT in `keep`. Dispatchers call this
 * at the end of a full repo scan with the set of numbers they (re)populated this
 * cycle, so items that dropped out — closed, merged, relabelled, feedback
 * addressed — are removed immediately instead of lingering until
 * QUEUE_ENTRY_TTL_MS. `type` keeps issue-dispatcher and pr-dispatcher from
 * clobbering each other's entries in the shared "ready" category.
 */
export function reconcileQueueCache(
  repo: string,
  categories: readonly QueueCategory[],
  keep: ReadonlySet<number>,
  type?: "issue" | "pr",
): void {
  const catSet = new Set(categories);
  for (const [key, entry] of queueCache) {
    if (entry.item.repo !== repo) continue;
    if (!catSet.has(entry.item.category)) continue;
    if (type && entry.item.type !== type) continue;
    if (!keep.has(entry.item.number)) queueCache.delete(key);
  }
}

export function populateQueueCache(category: QueueCategory, repo: string, item: { number: number; title: string; type: "issue" | "pr"; updatedAt?: string; priority?: boolean; labels?: string[] }): void {
  if (isItemSkipped(repo, item.number)) return;
  const newKey = `${category}:${repo}:${item.number}`;
  // Evict any entry for the same (repo, number) under a different category
  // so category transitions (e.g. needs-refinement → refined) cleanly replace
  // rather than accumulate.
  const suffix = `:${repo}:${item.number}`;
  for (const key of queueCache.keys()) {
    if (key !== newKey && key.endsWith(suffix)) queueCache.delete(key);
  }
  queueCache.set(newKey, {
    item: {
      repo,
      number: item.number,
      title: item.title,
      category,
      updatedAt: item.updatedAt ?? "",
      type: item.type,
      prioritized: isItemPrioritized(repo, item.number) || item.priority === true,
      labels: item.labels,
    },
    fetchedAt: Date.now(),
  });
}

export function populateQueueCacheFor(
  category: QueueCategory,
  repo: string,
  item: { number: number; title: string; updatedAt?: string; labels: { name: string }[] },
  type: "issue" | "pr",
): void {
  populateQueueCache(category, repo, {
    number: item.number,
    title: item.title,
    type,
    updatedAt: item.updatedAt,
    priority: hasPriorityLabel(item.labels),
    labels: item.labels.map((l) => l.name),
  });
}

export function getQueueSnapshot(categories: readonly QueueCategory[]): { items: QueueItem[]; oldestFetchAt: number | null } {
  const catSet = new Set(categories);
  const now = Date.now();

  // Pass 1: evict TTL-expired entries across all categories.
  for (const [key, entry] of queueCache) {
    if (now - entry.fetchedAt > QUEUE_ENTRY_TTL_MS) queueCache.delete(key);
  }

  // Pass 2: for each (repo, number), keep only the freshest entry in the
  // requested categories. Prior implementation deduped by insertion order,
  // which preferred the OLDER entry — the root cause of stale categories
  // appearing after a transition.
  const best = new Map<string, { item: QueueItem; fetchedAt: number }>();
  for (const [, entry] of queueCache) {
    if (!catSet.has(entry.item.category)) continue;
    const dedup = `${entry.item.repo}:${entry.item.number}`;
    const existing = best.get(dedup);
    if (!existing || entry.fetchedAt > existing.fetchedAt) {
      best.set(dedup, entry);
    }
  }

  const items: QueueItem[] = [];
  let oldestFetchAt: number | null = null;
  for (const entry of best.values()) {
    if (oldestFetchAt === null || entry.fetchedAt < oldestFetchAt) {
      oldestFetchAt = entry.fetchedAt;
    }
    items.push({ ...entry.item });
  }

  items.sort((a, b) => {
    if (a.prioritized && !b.prioritized) return -1;
    if (!a.prioritized && b.prioritized) return 1;
    return (b.updatedAt || "").localeCompare(a.updatedAt || "");
  });
  return { items, oldestFetchAt };
}

export function clearQueueCache(): void {
  queueCache.clear();
}

const _selfLoginByOwner = new Map<string, string>();

export function clearSelfLoginCache(): void {
  _selfLoginByOwner.clear();
}

registerOnResetCallback(clearSelfLoginCache);

export async function getSelfLogin(owner?: string): Promise<string> {
  const key = owner ?? "";
  const cached = _selfLoginByOwner.get(key);
  if (cached) return cached;
  const login = await getAppBotLogin(owner);
  _selfLoginByOwner.set(key, login);
  return login;
}

/**
 * The bot login Claws posts as *in a specific repo*. Prefer this over
 * {@link getSelfLogin} anywhere a repo full name is in hand: a Forgejo repo has
 * no GitHub App installation, so its self-login comes from the Forgejo token's
 * own account instead of the App bot (#2650).
 */
export async function getSelfLoginForRepo(repo: string): Promise<string> {
  if (isForgejoRepo(repo)) return forgejo.forgejoSelfLogin();
  return getSelfLogin(repo.split("/")[0]);
}

/**
 * Hard stop on the GitHub-only surfaces — Actions billing/runner registries,
 * Dependabot, public-snapshot release mirroring. A Forgejo repo's GitHub copy
 * is an abandoned push mirror, so answering these from it would be silently
 * stale rather than wrong-looking. Job call sites already filter Forgejo repos
 * out; this turns a missed filter into a loud error instead (#2650).
 */
function assertGitHubOnly(repo: string, feature: string): void {
  if (isForgejoRepo(repo)) {
    throw new Error(`${feature} is GitHub-only — ${repo} lives on Forgejo, whose GitHub copy is a read-only push mirror`);
  }
}

export async function isRepoPrivate(repo: string): Promise<boolean> {
  if (isForgejoRepo(repo)) return forgejo.isRepoPrivate(repo);
  try {
    const raw = await gh(["api", `repos/${repo}`, "--jq", ".private"]);
    return raw.trim() === "true";
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    log.warn(`isRepoPrivate(${repo}): defaulting to false — ${err}`);
    return false;
  }
}

async function resolveEnvForGhArgs(args: string[]): Promise<NodeJS.ProcessEnv | undefined> {
  const owner = extractOwnerFromGhArgs(args);
  if (!owner) return undefined;
  // Owners outside GITHUB_OWNERS have no installation of our App. Any
  // installation token still grants authenticated read access to their PUBLIC
  // repos, which lifts the call off the 60 req/hr unauthenticated bucket that
  // the process-env fallback would otherwise land on (upstream-watcher).
  if (!GITHUB_OWNERS.includes(owner)) {
    try {
      return buildEnvForGh(await getAnyInstallationToken());
    } catch {
      return undefined;
    }
  }
  try {
    const token = await getInstallationTokenForOwner(owner);
    return buildEnvForGh(token);
  } catch (err) {
    log.warn(`[github-app] gh token fetch failed for ${owner}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function gh(args: string[]): Promise<string> {
  if (isRateLimited()) {
    return Promise.reject(new RateLimitError("Rate limited — skipping API call"));
  }
  checkAndResumeAfterCooldown();

  return retryWithBackoff(
    async () => {
      const env = await resolveEnvForGhArgs(args);
      return new Promise<string>((resolve, reject) => {
        execFile("gh", args, { maxBuffer: 10 * 1024 * 1024, env }, (err, stdout, stderr) => {
          if (err) {
            const msg = stderr || err.message;
            if (RATE_LIMIT_RE.test(msg)) {
              setRateLimited();
              reject(Object.assign(new RateLimitError(`gh ${args.join(" ")} failed: ${msg}`), { stderr }));
              return;
            }
            if (GH_SERVER_ERROR_RE.test(msg)) {
              reject(Object.assign(new TransientGitHubError(`gh ${args.join(" ")} failed: ${msg}`), { stderr }));
              return;
            }
            reject(Object.assign(new Error(`gh ${args.join(" ")} failed: ${msg}`), { stderr }));
          } else {
            resolve(stdout);
          }
        });
      });
    },
    MAX_RETRIES,
    (err: Error) => {
      const ghErr = err as Error & { stderr?: string };
      return TRANSIENT_RE.test(ghErr.stderr || err.message) || (ghErr.stderr !== undefined && !ghErr.stderr.trim());
    },
    `gh ${args[0]}`,
  );
}

// `gh --json` returns "" when there are no results for a list query — so the
// empty-string fallback to [] is correct. For object-returning calls, an empty
// stdout would fail Zod validation (an array doesn't match an object schema),
// surfacing the unexpected gh behaviour instead of crashing on JSON.parse("").
function safeJsonParse<T>(schema: z.ZodType<T>, raw: string, context: string): T {
  const trimmed = raw.trim();
  let parsed: unknown;
  try {
    parsed = trimmed === "" ? [] : JSON.parse(trimmed);
  } catch {
    throw new Error(`Failed to parse JSON from gh ${context}: ${raw.slice(0, 200)}`);
  }
  try {
    return schema.parse(parsed);
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new Error(`Unexpected shape from gh ${context}: ${e.message}`);
    }
    throw e;
  }
}

// ── gh JSON schemas ──

const LabelNameSchema = z.object({ name: z.string() });
const AuthorSchema = z.object({ login: z.string() });

const IssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  labels: z.array(LabelNameSchema),
  author: AuthorSchema,
  updatedAt: z.string().optional(),
});

const PrSchema = z.object({
  number: z.number(),
  title: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  labels: z.array(LabelNameSchema),
  author: AuthorSchema,
  updatedAt: z.string().optional(),
  body: z.string().optional(),
  // Not requested by every `pr list --json` call site (e.g. listMergedPRsForIssue
  // omits it), so the schema permits its absence.
  isCrossRepository: z.boolean().optional(),
  createdAt: z.string().optional(),
  isDraft: z.boolean().optional(),
  changedFiles: z.number().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
});

const ReactionSchema = z.object({
  id: z.number(),
  user: AuthorSchema,
  content: z.string(),
});

const WorkflowRunSchema = z.object({
  run_id: z.number(),
  workflow_name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  event: z.string(),
  head_branch: z.string().nullable(),
  created_at: z.string(),
  run_started_at: z.string().nullable(),
  updated_at: z.string(),
  head_sha: z.string().nullable(),
  html_url: z.string().nullable(),
  run_attempt: z.number().nullable(),
});

const IssueCommentRawSchema = z.object({
  id: z.number(),
  body: z.string(),
  body_html: z.string().optional(),
  user: AuthorSchema,
});

const PrCheckSchema = z.object({
  name: z.string(),
  state: z.string(),
});

const FailedCheckSchema = z.object({
  name: z.string(),
  state: z.string(),
  link: z.string(),
});

// `statusCheckRollup` entries are a union: CheckRun objects carry `status` +
// `conclusion`, StatusContext objects carry `state`.
const RollupEntrySchema = z.object({
  status: z.string().optional(),
  conclusion: z.string().optional(),
  state: z.string().optional(),
  name: z.string().optional(),          // CheckRun
  workflowName: z.string().optional(),  // CheckRun
  context: z.string().optional(),       // StatusContext
  startedAt: z.string().optional(),     // CheckRun
  completedAt: z.string().optional(),   // CheckRun
}).passthrough();

const PrStatusRowSchema = z.object({
  number: z.number(),
  mergeable: z.string().optional(),
  statusCheckRollup: z.array(RollupEntrySchema).nullish(),
  files: z.array(z.object({ path: z.string() })).nullish(),
});

const PrMergeGateSchema = z.object({
  state: z.string(),
  headRefOid: z.string(),
  labels: z.array(LabelNameSchema),
  mergeable: z.string().optional(),
  statusCheckRollup: z.array(RollupEntrySchema).nullish(),
});

const GitCommitSchema = z.object({
  sha: z.string(),
  message: z.string(),
  tree: z.object({ sha: z.string() }),
});

// ── Repo discovery ──

export async function listRepos(): Promise<Repo[]> {
  // Return cached result if still fresh
  if (repoCache && Date.now() - repoCache.fetchedAt < REPO_CACHE_TTL) {
    return repoCache.repos;
  }

  // Deduplicate concurrent calls: if a fetch is already in flight, reuse it
  if (repoCachePromise) {
    return repoCachePromise;
  }

  repoCachePromise = fetchRepos();
  try {
    const repos = await repoCachePromise;

    // If the fetch returned empty but we had repos before, a transient error
    // (e.g. rate limit) likely caused all owners to fail. Return stale cache.
    if (repos.length === 0 && repoCache && repoCache.repos.length > 0) {
      log.warn(`listRepos: fetch returned 0 repos, returning stale cache (${repoCache.repos.length} repos)`);
      return repoCache.repos;
    }

    repoCache = { repos, fetchedAt: Date.now() };
    return repos;
  } finally {
    repoCachePromise = null;
  }
}

async function fetchRepos(): Promise<Repo[]> {
  const repos: Repo[] = [];

  for (const owner of GITHUB_OWNERS) {
    try {
      const entries = await listInstallationRepositories(owner);
      for (const e of entries) {
        if (e.isArchived) continue;
        if (!e.isPrivate) continue; // Claws automation runs on private repos only (#1826)
        // Repos that migrated to Forgejo keep a GitHub push mirror in the App
        // installation; it is read-only, so never automate it (#2650).
        if (isForgejoRepo(e.fullName)) continue;
        repos.push({
          owner: e.owner,
          name: e.name,
          fullName: e.fullName,
          defaultBranch: e.defaultBranch,
        });
      }
    } catch (err) {
      reportError("github:list-repos", owner, err);
    }
  }

  // Repos that live on Forgejo are not in any GitHub App installation, so they
  // are appended from config rather than discovered (#2650). A repo whose
  // metadata fetch fails falls back to its previous cache entry and is
  // otherwise skipped — never automated against a guessed default branch.
  // Skipped entirely when no forgejoToken is configured: every call would throw
  // from requireToken() and file a recurring [claws-error] alert on each cache
  // refresh for a static misconfiguration (#2670). config.ts warns at load.
  if (forgejo.isConfigured()) {
    for (const fullName of FORGEJO_REPOS) {
      try {
        const info = await forgejo.getRepo(fullName);
        repos.push({
          owner: info.owner,
          name: info.name,
          fullName: info.fullName,
          defaultBranch: info.defaultBranch,
          forge: "forgejo",
        });
      } catch (err) {
        reportError("github:list-repos-forgejo", fullName, err);
        const stale = repoCache?.repos.find((r) => r.fullName === fullName);
        if (stale) repos.push(stale);
      }
    }
  }

  return repos;
}

/** A public repo discovered for scanning. Carries archived state so callers can
 * route alerts appropriately (archived repos reject issue creation). */
export interface PublicRepoEntry extends Repo {
  isArchived: boolean;
}

/**
 * Enumerate every PUBLIC repo (archived and active) across all configured
 * owners. Unlike {@link listRepos}/`fetchRepos`, this does NOT filter out
 * archived repos — covering archived repos is the whole point of this path.
 *
 * Limitation: enumeration uses the installation-repositories endpoint, so it
 * only returns repos the GitHub App is actually installed on. Public repos
 * where the App is not installed cannot be discovered or scanned here. This is
 * the same reach as `fetchRepos()`.
 */
export async function listPublicReposIncludingArchived(): Promise<PublicRepoEntry[]> {
  const out: PublicRepoEntry[] = [];
  for (const owner of GITHUB_OWNERS) {
    try {
      const entries = await listInstallationRepositories(owner);
      for (const e of entries) {
        if (e.isPrivate) continue; // public repos only
        out.push({
          owner: e.owner,
          name: e.name,
          fullName: e.fullName,
          defaultBranch: e.defaultBranch,
          isArchived: e.isArchived,
        });
      }
    } catch (err) {
      reportError("github:list-public-repos", owner, err);
    }
  }
  return out;
}

/** Read-only snapshot-target state, used by the public-snapshot-sync job. */
export interface SnapshotTargetState { exists: boolean; archived: boolean; defaultBranch: string; }

/**
 * Inspect a public snapshot target repo. Purely read-only: it reports whether
 * the target exists and whether it is archived, but NEVER un-archives it. A 404
 * (repo not created yet) resolves to `exists: false` so the caller can alert and
 * skip. See `jobs/public-snapshot-sync.ts` (#1826).
 */
export async function ensureSnapshotTarget(target: string): Promise<SnapshotTargetState> {
  assertGitHubOnly(target, "public snapshot mirroring");
  try {
    const meta = await gh(["api", `repos/${target}`, "--jq",
      "{archived: .archived, default_branch: .default_branch}"]);
    const parsed = JSON.parse(meta) as { archived: boolean; default_branch: string };
    return { exists: true, archived: parsed.archived, defaultBranch: parsed.default_branch || "main" };
  } catch {
    return { exists: false, archived: false, defaultBranch: "main" }; // 404 → caller alerts + skips
  }
}

/** Best-effort disable of Dependabot on a repo; tolerates 404s (feature already off). */
export async function disableDependabot(repo: string): Promise<void> {
  assertGitHubOnly(repo, "Dependabot");
  for (const ep of ["automated-security-fixes", "vulnerability-alerts"]) {
    try { await gh(["api", `repos/${repo}/${ep}`, "--method", "DELETE"]); }
    catch (err) { log.warn(`[disableDependabot] ${repo} ${ep}: ${err instanceof Error ? err.message : String(err)}`); }
  }
}

/**
 * Tag of the most-recent STABLE release on `repo`, or null if none. Filters out
 * prereleases (RC/beta) and drafts. The releases API returns newest-first by
 * created_at, so `.[0]` after the filter is the latest stable. (#1851)
 */
export async function getLatestStableReleaseTag(repo: string): Promise<string | null> {
  if (isForgejoRepo(repo)) {
    const stable = (await forgejo.listReleases(repo)).filter((r) => !r.prerelease && !r.draft);
    return stable[0]?.tag ?? null;
  }
  try {
    const out = await gh(["api", `repos/${repo}/releases?per_page=100`, "--jq",
      "[.[] | select(.prerelease == false and .draft == false)] | .[0].tag_name // empty"]);
    const tag = out.trim();
    return tag === "" ? null : tag;
  } catch {
    return null; // no releases / 404 → nothing to mirror
  }
}

/** All stable (non-draft, non-prerelease) release tags on `repo`, newest-first. (#1941) */
export async function listStableReleaseTags(repo: string): Promise<string[]> {
  if (isForgejoRepo(repo)) {
    return (await forgejo.listReleases(repo)).filter((r) => !r.prerelease && !r.draft).map((r) => r.tag);
  }
  try {
    const out = await gh(["api", `repos/${repo}/releases?per_page=100`, "--jq",
      ".[] | select(.prerelease == false and .draft == false) | .tag_name"]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  publishedAt: string | null;
  prerelease: boolean;
  draft: boolean;
  url: string;
}

const ReleaseInfoSchema = z.object({
  tag: z.string(),
  name: z.string(),
  publishedAt: z.string().nullable(),
  prerelease: z.boolean(),
  draft: z.boolean(),
  url: z.string(),
});

/**
 * Recent releases on `repo`, newest-first, with the fields the upstream-watcher
 * needs to decide whether a release satisfies a watch. Unlike
 * `listStableReleaseTags` this keeps drafts and prereleases so the caller can
 * apply its own filter. Returns [] on any failure, matching the other release
 * helpers. (#2617)
 */
export async function listReleases(repo: string): Promise<ReleaseInfo[]> {
  if (isForgejoRepo(repo)) return forgejo.listReleases(repo);
  try {
    const raw = await gh(["api", `repos/${repo}/releases?per_page=50`, "--jq",
      "[.[] | {tag: .tag_name, name: (.name // \"\"), publishedAt: .published_at, prerelease, draft, url: .html_url}]"]);
    return safeJsonParse(z.array(ReleaseInfoSchema), raw, `releases for ${repo}`);
  } catch {
    return [];
  }
}

/** Asset filenames on `repo`'s release `tag`. Returns null when the release does not exist. (#1851) */
export async function getReleaseAssetNames(repo: string, tag: string): Promise<string[] | null> {
  assertGitHubOnly(repo, "release asset mirroring");
  try {
    const out = await gh(["release", "view", tag, "--repo", repo, "--json", "assets",
      "--jq", ".assets[].name"]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return null; // release absent
  }
}

/** Download release assets matching `pattern` from `repo`@`tag` into `destDir`. (#1851) */
export async function downloadReleaseAssets(repo: string, tag: string, pattern: string, destDir: string): Promise<void> {
  assertGitHubOnly(repo, "release asset mirroring");
  await gh(["release", "download", tag, "--repo", repo, "--pattern", pattern, "--dir", destDir, "--clobber"]);
}

/** Create a release on `repo`@`tag` anchored at `targetCommitish`, attaching `assetPaths`. (#1851) */
export async function createRelease(repo: string, tag: string, assetPaths: string[], targetCommitish: string, title: string): Promise<void> {
  assertGitHubOnly(repo, "release creation");
  await gh(["release", "create", tag, ...assetPaths, "--repo", repo, "--title", title,
    "--target", targetCommitish, "--notes", `Public snapshot release ${tag}.`]);
}

/** Upload (clobbering) `assetPaths` to an existing release on `repo`@`tag`. (#1851) */
export async function uploadReleaseAssets(repo: string, tag: string, assetPaths: string[]): Promise<void> {
  assertGitHubOnly(repo, "release asset upload");
  await gh(["release", "upload", tag, ...assetPaths, "--repo", repo, "--clobber"]);
}

// ── Issue search & creation ──

// Exact-title lookup over the cached open-issue list. Deliberately NOT `gh search`:
// that parses its query as GitHub advanced-search syntax, so a title containing a bare
// `key:value` token (an inline-code `h:null`, a `16:9` ratio, a Go struct tag) is misread
// as a qualifier and the whole query is rejected (#2289). The list API is also strongly
// consistent, where the search index lags creation by minutes.
export async function findIssueByExactTitle(
  repo: string,
  title: string,
): Promise<{ number: number; title: string; labels: string[] } | null> {
  const open = await listOpenIssues(repo);
  const match = open.find((i) => i.title === title);
  if (!match) {
    // listOpenIssues caps at --limit 100; past that a real duplicate could be invisible.
    if (open.length >= 100) log.warn(`findIssueByExactTitle(${repo}): open-issue list at the 100 cap — dedup for "${title}" may be incomplete`);
    return null;
  }
  return { number: match.number, title: match.title, labels: match.labels.map((l) => l.name) };
}

/** Open PRs whose title contains `needle`. Replaces the old `gh search prs` path (#2289). */
export async function findOpenPRsByTitle(
  repo: string,
  needle: string,
): Promise<{ number: number; title: string }[]> {
  const open = await listPRs(repo);
  return open.filter((p) => p.title.includes(needle)).map((p) => ({ number: p.number, title: p.title }));
}

export async function createIssue(
  repo: string,
  title: string,
  body: string,
  labels: string[],
): Promise<number> {
  if (isForgejoRepo(repo)) return forgejo.createIssue(repo, title, body, labels);
  for (const label of labels) {
    await ensureLabel(repo, label);
  }
  const labelArgs = labels.flatMap((l) => ["--label", l]);
  try {
    const url = (
      await gh(["issue", "create", "--repo", repo, "--title", title, "--body", body, ...labelArgs])
    ).trim();
    const match = url.match(/\/issues\/(\d+)$/);
    if (!match) throw new Error(`Could not parse issue number from: ${url}`);
    apiCache.invalidate(`open-issues:${repo}`);
    return Number(match[1]);
  } catch (err) {
    // Handle retry-induced duplicate: issue was created on a previous attempt
    // that succeeded server-side but returned a transient error to the client
    const existsMatch = String(err).match(
      /already exists:\s*https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/,
    );
    if (existsMatch) {
      log.warn(`createIssue: issue already exists (#${existsMatch[1]}), likely from a retried request`);
      return Number(existsMatch[1]);
    }
    throw err;
  }
}

export async function listOpenIssues(
  repo: string,
): Promise<Issue[]> {
  if (isForgejoRepo(repo)) return forgejo.listOpenIssues(repo);
  return apiCache.dedupedFetch(`open-issues:${repo}`, 60_000, async () => {
    const raw = await gh([
      "issue", "list",
      "--repo", repo,
      "--state", "open",
      "--limit", "100",
      "--json", "number,title,body,labels,author,updatedAt",
    ]);
    return safeJsonParse(z.array(IssueSchema), raw, "issue list");
  }) as Promise<Issue[]>;
}

// ── Labels ──

/** GitHub rejects `label create` when the description exceeds 100 characters,
 *  and `ensureLabel` swallows the error — leaving callers to fail later with
 *  "'X' not found" (#2760). Truncate rather than lose the label entirely. */
const MAX_LABEL_DESCRIPTION = 100;

export async function ensureLabel(
  repo: string,
  label: string,
  overrideSpec?: { color: string; description: string },
): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.ensureLabel(repo, label, overrideSpec);
  try {
    const spec = overrideSpec ?? LABEL_SPECS[label];
    if (!spec) {
      log.warn(`ensureLabel: creating undeclared label "${label}" on ${repo} — add it to LABEL_SPECS (see docs/label-audit.md)`);
    }
    const args = ["label", "create", label, "--repo", repo, "--force"];
    if (spec) {
      let description = spec.description;
      if (description.length > MAX_LABEL_DESCRIPTION) {
        log.warn(`ensureLabel: description for "${label}" is ${description.length} chars (max ${MAX_LABEL_DESCRIPTION}) — truncating`);
        description = description.slice(0, MAX_LABEL_DESCRIPTION);
      }
      args.push("--color", spec.color, "--description", description);
    }
    await gh(args);
  } catch (err) {
    log.warn(`ensureLabel ${label} on ${repo}: ${err}`);
  }
}

export async function ensureAllLabels(
  repo: string,
  extraSpecs?: Record<string, { color: string; description: string }>,
): Promise<void> {
  for (const label of Object.keys(LABEL_SPECS)) {
    await ensureLabel(repo, label);
  }
  if (extraSpecs) {
    for (const [label, spec] of Object.entries(extraSpecs)) {
      await ensureLabel(repo, label, spec);
    }
  }
}

export async function listLabels(repo: string): Promise<string[]> {
  if (isForgejoRepo(repo)) return forgejo.listLabels(repo);
  const raw = await gh([
    "label", "list",
    "--repo", repo,
    "--limit", "100",
    "--json", "name",
  ]);
  const labels = safeJsonParse(z.array(LabelNameSchema), raw, "label list");
  return labels.map((l) => l.name);
}

export async function deleteLabel(repo: string, label: string): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.deleteLabel(repo, label);
  try {
    await gh(["label", "delete", label, "--repo", repo, "--yes"]);
  } catch (err) {
    log.warn(`deleteLabel ${label} on ${repo}: ${err}`);
  }
}

export async function deleteStaleLabels(
  repo: string,
  legacyLabels: Set<string>,
): Promise<void> {
  const current = await listLabels(repo);
  // Only delete labels that were previously managed by Claws but are no longer needed
  const stale = current.filter((name) => legacyLabels.has(name));

  for (const label of stale) {
    log.info(`[repo-standards] Deleting stale label "${label}" from ${repo}`);
    await deleteLabel(repo, label);
  }
}

/** Apply one-off label case/name corrections. Skips a rename when the target
 *  name already exists exactly, so it is a no-op after the first successful run. */
export async function applyLabelRenames(
  repo: string,
  renames: Record<string, string>,
): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.applyLabelRenames(repo, renames);
  const entries = Object.entries(renames);
  if (entries.length === 0) return;
  const current = await listLabels(repo);
  for (const [from, to] of entries) {
    if (!current.includes(from) || current.includes(to)) continue;
    log.info(`[repo-standards] Renaming label "${from}" → "${to}" in ${repo}`);
    try {
      await gh(["label", "edit", from, "--repo", repo, "--name", to]);
    } catch (err) {
      log.warn(`applyLabelRenames ${from}→${to} on ${repo}: ${err}`);
    }
  }
}

export async function addLabel(repo: string, issueNumber: number, label: string): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.addLabel(repo, issueNumber, label);
  await ensureLabel(repo, label);
  await gh(["issue", "edit", String(issueNumber), "--repo", repo, "--add-label", label]);
  recordGitHubEvent({ kind: "label-added", repo, number: issueNumber, related: [], detail: label });
}

/** Live labels on an issue or PR, bypassing every cache. PRs are issues to the
 *  REST API, so the same endpoint serves both. */
async function fetchLiveLabels(repo: string, issueNumber: number): Promise<string[]> {
  const raw = await gh(["api", `repos/${repo}/issues/${issueNumber}/labels`]);
  return safeJsonParse(z.array(LabelNameSchema), raw, "issue labels").map((l) => l.name);
}

/**
 * Remove a label, returning true only when the label is confirmed absent
 * afterwards.
 *
 * `gh issue edit --remove-label` errors both when the label was never applied
 * (benign — most callers remove labels unconditionally) and on a transient API
 * failure (not benign). Callers that persist "this label is gone" state must be
 * able to tell the two apart, so on error we re-read the live labels rather than
 * assuming either way; callers that don't care can keep ignoring the result.
 */
export async function removeLabel(repo: string, issueNumber: number, label: string): Promise<boolean> {
  if (isForgejoRepo(repo)) return forgejo.removeLabel(repo, issueNumber, label);
  try {
    await gh(["issue", "edit", String(issueNumber), "--repo", repo, "--remove-label", label]);
    recordGitHubEvent({ kind: "label-removed", repo, number: issueNumber, related: [], detail: label });
    return true;
  } catch (err) {
    try {
      return !(await fetchLiveLabels(repo, issueNumber)).includes(label);
    } catch (verifyErr) {
      log.warn(`removeLabel ${label} on ${repo}#${issueNumber} failed (${err}) and could not be verified: ${verifyErr}`);
      return false;
    }
  }
}

// ── Issues ──

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  author: { login: string };
  updatedAt?: string;
}

export async function listIssuesByLabel(repo: string, label: string): Promise<Issue[]> {
  if (isForgejoRepo(repo)) return forgejo.listIssuesByLabel(repo, label);
  return apiCache.dedupedFetch(`issues-by-label:${repo}:${label}`, 60_000, async () => {
    const raw = await gh([
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      label,
      "--state",
      "open",
      "--json",
      "number,title,body,labels,author,updatedAt",
    ]);
    return safeJsonParse(z.array(IssueSchema), raw, "issue list by label");
  }) as Promise<Issue[]>;
}

export async function listDuplicateIssuesOf(repo: string, canonicalNumber: number): Promise<Issue[]> {
  if (isForgejoRepo(repo)) return forgejo.listDuplicateIssuesOf(repo, canonicalNumber);
  const raw = await gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    LABELS.duplicate,
    "--state",
    "open",
    "--search",
    `"claws-duplicate-of:${canonicalNumber}" in:comments`,
    "--json",
    "number,title,body,labels,author,updatedAt",
  ]);
  return safeJsonParse(z.array(IssueSchema), raw, "listDuplicateIssuesOf");
}

/**
 * Read an issue's live title and body. Deliberately NOT cached: every caller
 * (the planner's snapshot stamp, the stale-plan gates) needs the current value,
 * not the 60 s-cached `listOpenIssues` copy.
 */
export async function getIssueTitleBody(
  repo: string,
  issueNumber: number,
): Promise<{ title: string; body: string }> {
  if (isForgejoRepo(repo)) return forgejo.getIssueTitleBody(repo, issueNumber);
  const raw = await gh([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "title,body",
  ]);
  return safeJsonParse(
    z.object({ title: z.string(), body: z.string() }),
    raw,
    "issue view title/body",
  );
}

export async function getIssueBody(repo: string, issueNumber: number): Promise<string> {
  if (isForgejoRepo(repo)) return forgejo.getIssueBody(repo, issueNumber);
  const { body } = await getIssueTitleBody(repo, issueNumber);
  return body;
}

export async function getIssueBodyHtml(repo: string, issueNumber: number): Promise<string> {
  if (isForgejoRepo(repo)) return forgejo.getIssueBodyHtml(repo, issueNumber);
  const raw = await gh([
    "api",
    `repos/${repo}/issues/${issueNumber}`,
    "-H", "Accept: application/vnd.github.full+json",
  ]);
  const parsed = safeJsonParse(z.object({ body_html: z.string().nullish() }), raw, "issue body_html");
  return parsed.body_html ?? "";
}

export async function getIssueState(
  repo: string,
  issueNumber: number,
): Promise<{ state: string; stateReason: string | null }> {
  if (isForgejoRepo(repo)) return forgejo.getIssueState(repo, issueNumber);
  const raw = await gh([
    "issue", "view", String(issueNumber),
    "--repo", repo,
    "--json", "state,stateReason",
  ]);
  return safeJsonParse(
    z.object({ state: z.string(), stateReason: z.string().nullable() }),
    raw,
    "issue view state",
  );
}

export async function commentOnIssue(repo: string, issueNumber: number, body: string, opts?: { agentName?: string }): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.commentOnIssue(repo, issueNumber, body, opts);
  const fullBody = buildClawsComment(body, opts?.agentName);
  await gh(["issue", "comment", String(issueNumber), "--repo", repo, "--body", fullBody]);
  apiCache.invalidate(`issue-comments:${repo}:${issueNumber}`);
  recordGitHubEvent({
    kind: "issue-comment",
    repo,
    number: issueNumber,
    related: extractRelatedNumbers(body),
    detail: body.includes("## Implementation Plan") ? "plan" : undefined,
  });
}

export async function editIssue(repo: string, issueNumber: number, body: string): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.editIssue(repo, issueNumber, body);
  await gh(["issue", "edit", String(issueNumber), "--repo", repo, "--body", body]);
}

/**
 * Rename an issue. Invalidates the `open-issues` cache because callers that
 * rename (e.g. ensureAlertIssue's legacy-title migration) then re-read the
 * open-issue list and must not see the stale pre-rename title.
 */
export async function editIssueTitle(repo: string, issueNumber: number, title: string): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.editIssueTitle(repo, issueNumber, title);
  await gh(["issue", "edit", String(issueNumber), "--repo", repo, "--title", title]);
  apiCache.invalidate(`open-issues:${repo}`);
}

export async function closeIssue(
  repo: string,
  issueNumber: number,
  stateReason?: "completed" | "not_planned",
): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.closeIssue(repo, issueNumber, stateReason);
  const args = ["issue", "close", String(issueNumber), "--repo", repo];
  if (stateReason === "not_planned") args.push("--reason", "not planned");
  await gh(args);
  apiCache.invalidate(`open-issues:${repo}`);
  recordGitHubEvent({ kind: "issue-closed", repo, number: issueNumber, related: [], detail: stateReason });
}

/**
 * Transfer an issue to another repository. GitHub only permits transfers between
 * repos owned by the SAME user/org — callers MUST validate that first. Returns the
 * trimmed new-issue URL that gh prints on success.
 */
export async function transferIssue(repo: string, issueNumber: number, destinationRepo: string): Promise<string> {
  if (isForgejoRepo(repo)) return forgejo.transferIssue(repo, issueNumber, destinationRepo);
  const out = await gh(["issue", "transfer", String(issueNumber), destinationRepo, "--repo", repo]);
  apiCache.invalidate(`open-issues:${repo}`);
  apiCache.invalidate(`open-issues:${destinationRepo}`);
  apiCache.invalidate(`issue-comments:${repo}:${issueNumber}`);
  removeQueueItem(repo, issueNumber);
  return out.trim();
}

export interface IssueComment {
  id: number;
  body: string;
  body_html: string;
  login: string;
}

/**
 * GET a paginated REST array endpoint in bounded pages, returning every item in
 * API order. `--paginate` is unbounded and a 1,000-comment thread would blow
 * gh()'s 10 MB maxBuffer, so page explicitly and cap the page count.
 */
async function fetchPagedArray<T>(
  endpointPath: string,
  schema: z.ZodType<T[]>,
  label: string,
  opts: { maxPages?: number; accept?: string } = {},
): Promise<T[]> {
  const maxPages = opts.maxPages ?? 5;
  const out: T[] = [];
  let filledEveryPage = false;
  for (let page = 1; page <= maxPages; page++) {
    const raw = await gh([
      "api",
      `${endpointPath}?per_page=100&page=${page}`,
      ...(opts.accept ? ["-H", `Accept: ${opts.accept}`] : []),
    ]);
    const items = safeJsonParse(schema, raw, label);
    out.push(...items);
    if (items.length < 100) {
      filledEveryPage = false;
      break;
    }
    filledEveryPage = page === maxPages;
  }
  if (filledEveryPage) {
    log.warn(`fetchPagedArray: ${endpointPath} filled all ${maxPages} pages (${out.length} items) — later items were not fetched.`);
  }
  return out;
}

export async function getIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]> {
  if (isForgejoRepo(repo)) return forgejo.getIssueComments(repo, issueNumber);
  return apiCache.dedupedFetch(`issue-comments:${repo}:${issueNumber}`, 60_000, async () => {
    const comments = await fetchPagedArray(
      `repos/${repo}/issues/${issueNumber}/comments`,
      z.array(IssueCommentRawSchema),
      "issue comments",
      { accept: "application/vnd.github.full+json" },
    );
    return comments.filter((c) => c.body.trim()).map((c) => ({ id: c.id, body: c.body, body_html: c.body_html ?? "", login: c.user.login }));
  }) as Promise<IssueComment[]>;
}

export async function editIssueComment(repo: string, commentId: number, body: string, opts?: { agentName?: string }): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.editIssueComment(repo, commentId, body, opts);
  const fullBody = buildClawsComment(body, opts?.agentName);
  await gh([
    "api", "--method", "PATCH",
    `repos/${repo}/issues/comments/${commentId}`,
    "-f", `body=${fullBody}`,
  ]);
  apiCache.invalidatePrefix(`issue-comments:${repo}:`);
}

// ── Pull Requests ──

export interface PR {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  labels: { name: string }[];
  author: { login: string };
  updatedAt?: string;
  body?: string;
  isCrossRepository?: boolean;
  createdAt?: string;
  isDraft?: boolean;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
}

// Wrapper to allow future expansion (e.g. checking headRepositoryOwner)
export function isForkPR(pr: PR): boolean {
  return pr.isCrossRepository === true;
}

export function isDependabotPR(pr: PR): boolean {
  return pr.author.login === "dependabot[bot]" || pr.author.login === "app/dependabot";
}

export async function createPR(
  repo: string,
  head: string,
  title: string,
  body: string,
): Promise<number> {
  if (isForgejoRepo(repo)) return forgejo.createPR(repo, head, title, body);
  try {
    const url = (
      await gh(["pr", "create", "--repo", repo, "--head", head, "--title", title, "--body", body])
    ).trim();
    const match = url.match(/\/pull\/(\d+)$/);
    if (!match) throw new Error(`Could not parse PR number from: ${url}`);
    apiCache.invalidate(`pr-list:${repo}`);
    recordGitHubEvent({
      kind: "pr-opened",
      repo,
      number: Number(match[1]),
      related: extractRelatedNumbers(title + "\n" + body),
    });
    return Number(match[1]);
  } catch (err) {
    // Handle retry-induced duplicate: PR was created on a previous attempt
    // that succeeded server-side but returned a transient error to the client
    const existsMatch = String(err).match(
      /already exists:\s*https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/,
    );
    if (existsMatch) {
      log.warn(`createPR: PR already exists (#${existsMatch[1]}), likely from a retried request`);
      recordGitHubEvent({
        kind: "pr-opened",
        repo,
        number: Number(existsMatch[1]),
        related: extractRelatedNumbers(title + "\n" + body),
      });
      return Number(existsMatch[1]);
    }
    throw err;
  }
}

export async function listPRs(repo: string): Promise<PR[]> {
  if (isForgejoRepo(repo)) return forgejo.listPRs(repo);
  return apiCache.dedupedFetch(`pr-list:${repo}`, 60_000, async () => {
    const raw = await gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,headRefName,baseRefName,labels,author,isCrossRepository,updatedAt,createdAt,isDraft,changedFiles,additions,deletions",
    ]);
    return safeJsonParse(z.array(PrSchema), raw, "pr list");
  }) as Promise<PR[]>;
}

export interface PRRepoStatus {
  checkStatus: "passing" | "failing" | "pending" | "none";
  checksPassed: number;
  checksTotal: number;
  mergeableState: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  infraPaths?: string[];
  tofuPlan?: TofuPlanSummary;
}

function rollupEntryState(e: { status?: string; conclusion?: string; state?: string }): string {
  if (e.state) return e.state.toUpperCase();
  if (e.conclusion) return e.conclusion.toUpperCase();
  return "PENDING"; // in-flight CheckRun: status set, conclusion still empty
}

export type RollupEntry = {
  status?: string;
  conclusion?: string;
  state?: string;
  name?: string;
  workflowName?: string;
  context?: string;
  startedAt?: string;
  completedAt?: string;
};

/**
 * Collapse superseded check runs so only the latest run per check identity
 * survives, reproducing `gh pr checks`' "latest run per name" semantics over
 * the raw, undeduplicated `statusCheckRollup` (which retains every run for
 * the head SHA, including ones cancelled by `concurrency: cancel-in-progress`
 * and superseded by a rerun — see #2374).
 */
function dedupeRollupEntries(entries: RollupEntry[]): RollupEntry[] {
  const winners = new Map<string, RollupEntry>();
  entries.forEach((entry, index) => {
    const key = entry.name
      ? `run:${entry.workflowName ?? ""}/${entry.name}`
      : entry.context
        ? `ctx:${entry.context}`
        : `anon:${index}`;
    const incumbent = winners.get(key);
    if (!incumbent) {
      winners.set(key, entry);
      return;
    }
    const incumbentState = rollupEntryState(incumbent);
    const challengerState = rollupEntryState(entry);
    const incumbentPending = incumbentState === "PENDING";
    const challengerPending = challengerState === "PENDING";
    if (challengerPending && !incumbentPending) {
      winners.set(key, entry);
      return;
    }
    if (incumbentPending && !challengerPending) {
      return;
    }
    const incumbentStarted = incumbent.startedAt ?? "";
    const challengerStarted = entry.startedAt ?? "";
    if (challengerStarted !== incumbentStarted) {
      if (challengerStarted > incumbentStarted) winners.set(key, entry);
      return;
    }
    const incumbentCompleted = incumbent.completedAt ?? "";
    const challengerCompleted = entry.completedAt ?? "";
    if (challengerCompleted !== incumbentCompleted) {
      if (challengerCompleted > incumbentCompleted) winners.set(key, entry);
      return;
    }
    if (PASSING_STATES.has(incumbentState) && !PASSING_STATES.has(challengerState)) {
      winners.set(key, entry);
    }
  });
  return [...winners.values()];
}

/**
 * Reduce a `statusCheckRollup` array to an aggregate check status.
 *
 * `gh pr view --json statusCheckRollup` returns every check run recorded
 * against the head SHA, including runs cancelled by
 * `concurrency: cancel-in-progress` and superseded by a rerun, whereas
 * `gh pr checks` returns only the latest run per name. This dedupes
 * superseded runs (same workflow + name, earlier start) before reducing, so
 * a stale `CANCELLED` entry from a superseded run doesn't permanently block
 * a merge (#2374).
 */
export function rollupCheckStatus(
  rawEntries: RollupEntry[],
): { status: "passing" | "failing" | "pending" | "none"; passed: number; total: number } {
  const entries = dedupeRollupEntries(rawEntries);
  const states = entries.map(rollupEntryState);
  const total = states.length;
  const passed = states.filter((s) => PASSING_STATES.has(s)).length;
  const failed = states.filter((s) => FAILED_STATES.has(s)).length;
  if (total === 0) return { status: "none", passed, total };
  if (failed > 0) return { status: "failing", passed, total };
  if (passed === total) return { status: "passing", passed, total };
  return { status: "pending", passed, total };
}

/**
 * Forgejo half of {@link listPRStatuses}. Gitea has no bulk equivalent of
 * `gh pr list --json statusCheckRollup`, so the same map is assembled from the
 * per-PR Forgejo calls with bounded concurrency. It lives here rather than in
 * forgejo.ts because it needs `infraPathsIn`/`getTofuPlanSummary`, and forgejo.ts
 * must never value-import this module.
 *
 * `mergeable` is read with a single attempt: this is 60 s-cached dashboard data,
 * and the merge gate reads getPRMergeGate live anyway, so the multi-attempt
 * retry sleep would only stall the page render.
 */
async function listForgejoPRStatuses(repo: string): Promise<Map<number, PRRepoStatus>> {
  const prs = await forgejo.listPRs(repo);
  const out = new Map<number, PRRepoStatus>();
  const settled = await mapSettledWithConcurrency(prs, 4, async (pr) => {
    const [checks, mergeableState, files] = await Promise.all([
      forgejo.getPRChecksSummary(repo, pr.number),
      forgejo.getPRMergeableState(repo, pr.number, 1, 0),
      forgejo.getPRChangedFiles(repo, pr.number),
    ]);
    const infraPaths = infraPathsIn(files);
    const status: PRRepoStatus = {
      checkStatus: checks.status,
      checksPassed: checks.passed,
      checksTotal: checks.total,
      mergeableState,
      ...(infraPaths.length > 0 ? { infraPaths } : {}),
    };
    if (infraPaths.length > 0) status.tofuPlan = (await getTofuPlanSummary(repo, pr.number)) ?? undefined;
    out.set(pr.number, status);
  });
  for (const [i, result] of settled.entries()) {
    if (result.status === "rejected") {
      log.warn(`listPRStatuses ${repo}#${prs[i]!.number}: ${result.reason}`);
    }
  }
  return out;
}

/**
 * Bulk-fetch check + mergeability status for every open PR in a repo with a
 * single `gh pr list` call, avoiding N per-PR `gh pr checks`/`gh pr view`
 * subprocesses (rate-limit sensitive).
 */
export async function listPRStatuses(repo: string): Promise<Map<number, PRRepoStatus>> {
  return apiCache.dedupedFetch(`pr-list-status:${repo}`, 60_000, async () => {
    if (isForgejoRepo(repo)) return listForgejoPRStatuses(repo);
    const raw = await gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,mergeable,statusCheckRollup,files",
    ]);
    const parsed = safeJsonParse(z.array(PrStatusRowSchema), raw, "pr list statuses");
    const out = new Map<number, PRRepoStatus>();
    for (const row of parsed) {
      const { status: checkStatus, passed, total } = rollupCheckStatus(row.statusCheckRollup ?? []);
      const infraPaths = infraPathsIn((row.files ?? []).map((f) => f.path));
      out.set(row.number, {
        checkStatus,
        checksPassed: passed,
        checksTotal: total,
        mergeableState: (row.mergeable ?? "UNKNOWN") as "MERGEABLE" | "CONFLICTING" | "UNKNOWN",
        ...(infraPaths.length > 0 ? { infraPaths } : {}),
      });
    }
    // `pr list --json files` caps at GitHub's ~100-file GraphQL page, so this is
    // best-effort display data; the merge gate reads the complete
    // `gh pr diff --name-only` list (getPRChangedFiles) instead.
    const infraRows = [...out.entries()].filter(([, v]) => v.infraPaths?.length);
    await mapSettledWithConcurrency(infraRows, 4, async ([num, v]) => {
      v.tofuPlan = (await getTofuPlanSummary(repo, num)) ?? undefined;
    });
    return out;
  }) as Promise<Map<number, PRRepoStatus>>;
}

export async function listMergedPRsForIssue(repo: string, issueNumber: number): Promise<PR[]> {
  if (isForgejoRepo(repo)) return forgejo.listMergedPRsForIssue(repo, issueNumber);
  const raw = await gh([
    "pr", "list",
    "--repo", repo,
    "--state", "merged",
    "--search", `head:claws/issue-${issueNumber}-`,
    "--limit", "100",
    "--json", "number,title,headRefName,baseRefName,labels,author,body",
  ]);
  const prs = safeJsonParse(z.array(PrSchema), raw, "pr list merged");
  const branchPrefix = `claws/issue-${issueNumber}-`;
  return prs.filter((pr) => pr.headRefName.startsWith(branchPrefix));
}

export async function getOpenPRForIssue(repo: string, issueNumber: number): Promise<PR | null> {
  if (isForgejoRepo(repo)) return forgejo.getOpenPRForIssue(repo, issueNumber);
  const prs = await listPRs(repo);
  const branchPrefix = `claws/issue-${issueNumber}-`;
  return prs.find((pr) => pr.headRefName.startsWith(branchPrefix)) ?? null;
}

const TimelineCrossRefSchema = z.array(z.object({
  event: z.string(),
  source: z.object({
    issue: z.object({
      number: z.number(),
      title: z.string(),
      body: z.string().nullable(),
      state: z.string(),
      user: AuthorSchema,
      repository: z.object({ full_name: z.string() }).optional(),
      pull_request: z.object({ merged_at: z.string().nullable() }).nullish(),
    }),
  }).optional(),
}).passthrough());

export interface CrossRefPR {
  number: number;
  title: string;
  body: string;
  state: "open" | "merged" | "closed";
  login: string;
}

/**
 * Every PR that cross-references an issue — any author, any branch, in this
 * repo — via the issue timeline. Unlike `listMergedPRsForIssue` /
 * `getOpenPRForIssue`, which only see `claws/issue-<N>-` branches, this is what
 * makes hand-rolled PRs for a multi-PR plan visible to phase accounting (#2594).
 *
 * Never throws: any failure returns `[]` so callers degrade to branch-prefix
 * accounting rather than stalling the pipeline.
 */
export async function listPRsCrossReferencingIssue(repo: string, issueNumber: number): Promise<CrossRefPR[]> {
  if (isForgejoRepo(repo)) return forgejo.listPRsCrossReferencingIssue(repo, issueNumber);
  return apiCache.dedupedFetch(`issue-xrefs:${repo}:${issueNumber}`, 60_000, async () => {
    try {
      // `--paginate` is required: a busy issue's timeline runs past one page and
      // the newest cross-references (the very ones that matter) are on the last.
      const raw = await gh(["api", `repos/${repo}/issues/${issueNumber}/timeline`, "--paginate"]);
      const entries = safeJsonParse(TimelineCrossRefSchema, raw, "issue timeline");
      const byNumber = new Map<number, CrossRefPR>();
      for (const entry of entries) {
        if (entry.event !== "cross-referenced") continue;
        const src = entry.source?.issue;
        if (!src?.pull_request) continue;
        // The timeline carries cross-repo references; those PR numbers belong to
        // another repo's namespace and must not be matched against this issue.
        if (src.repository?.full_name !== repo) continue;
        const state: CrossRefPR["state"] = src.pull_request.merged_at != null
          ? "merged"
          : src.state === "open" ? "open" : "closed";
        byNumber.set(src.number, {
          number: src.number,
          title: src.title,
          body: src.body ?? "",
          state,
          login: src.user.login,
        });
      }
      return [...byNumber.values()];
    } catch (err) {
      log.warn(`[github] Failed to list PRs cross-referencing ${repo}#${issueNumber}: ${err}`);
      return [];
    }
  }) as Promise<CrossRefPR[]>;
}

export async function getPRMergeableState(
  repo: string,
  prNumber: number,
  maxAttempts = 5,
  delayMs = 3000,
): Promise<"MERGEABLE" | "CONFLICTING" | "UNKNOWN"> {
  if (isForgejoRepo(repo)) return forgejo.getPRMergeableState(repo, prNumber, maxAttempts, delayMs);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const raw = await gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "mergeable"]);
    const parsed = safeJsonParse(z.object({ mergeable: z.string() }), raw, "pr view");
    const state = parsed.mergeable as "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
    if (state !== "UNKNOWN") return state;
    if (attempt < maxAttempts - 1) await sleep(delayMs);
  }
  return "UNKNOWN";
}

/** Live PR state used as the final gate immediately before an auto-merge. */
export interface PRMergeGate {
  state: string;                    // "OPEN" | "CLOSED" | "MERGED"
  headSha: string;
  labels: string[];
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checkStatus: "passing" | "failing" | "pending" | "none";
  checksTotal: number;
}

/**
 * Read the merge-relevant PR state (labels, head SHA, check rollup, mergeability)
 * in one uncached call. Deliberately bypasses `apiCache` — the auto-merger runs
 * seconds after other agents mutate the PR, and a stale snapshot is what merged a
 * red PR in #2354.
 */
export async function getPRMergeGate(repo: string, prNumber: number): Promise<PRMergeGate> {
  if (isForgejoRepo(repo)) return forgejo.getPRMergeGate(repo, prNumber);
  const raw = await gh([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "state,headRefOid,labels,mergeable,statusCheckRollup",
  ]);
  const row = safeJsonParse(PrMergeGateSchema, raw, "pr merge gate");
  const rollup = rollupCheckStatus(row.statusCheckRollup ?? []);
  return {
    state: row.state,
    headSha: row.headRefOid,
    labels: row.labels.map((l) => l.name),
    mergeable: (row.mergeable ?? "UNKNOWN") as "MERGEABLE" | "CONFLICTING" | "UNKNOWN",
    checkStatus: rollup.status,
    checksTotal: rollup.total,
  };
}

/** ISO commit-date of `sha`, or null when unreadable. Used to tell "this repo has
 *  no CI" from "CI for a just-pushed head has not registered yet". */
export async function getCommitCommittedAt(repo: string, sha: string): Promise<string | null> {
  if (isForgejoRepo(repo)) return forgejo.getCommitCommittedAt(repo, sha);
  try {
    const raw = await gh(["api", `repos/${repo}/commits/${sha}`, "--jq", ".commit.committer.date"]);
    return raw.trim() || null;
  } catch (err) {
    log.warn(`getCommitCommittedAt ${repo}@${sha}: ${err}`);
    return null;
  }
}

/** How long a freshly-pushed head SHA is given to register its first check run. */
const NO_CHECKS_SETTLE_MS = 5 * 60 * 1000;

/**
 * Decide whether a check status of `"none"` can be believed. A brand-new head
 * SHA has no check runs registered for the first minute or two, so reading
 * `"none"` as "this repo has no CI" races the workflow trigger — that is how
 * #2354 merged a red PR. Returns `settled: false` while the head commit is
 * still inside the settle window, or when its age can't be determined at all
 * (fail closed); `age` is a human-readable string for the caller's log line.
 */
export async function haveChecksSettled(repo: string, sha: string): Promise<{ settled: boolean; age: string }> {
  if (isForgejoRepo(repo)) return forgejo.haveChecksSettled(repo, sha);
  const committedAt = await getCommitCommittedAt(repo, sha);
  const ageMs = committedAt ? Date.now() - Date.parse(committedAt) : NaN;
  if (!Number.isFinite(ageMs)) return { settled: false, age: "unknown" };
  return { settled: ageMs >= NO_CHECKS_SETTLE_MS, age: `${Math.round(ageMs / 1000)}s` };
}

// ── Checks ──

function normalizeCheckState(s: string): string {
  return s.toUpperCase();
}

const FAILED_STATES = new Set([
  "FAILURE",
  "CANCELLED",
  "ERROR",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);

const PASSING_STATES = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

export async function getPRCheckStatus(
  repo: string,
  prNumber: number,
): Promise<"passing" | "failing" | "pending" | "none"> {
  if (isForgejoRepo(repo)) return forgejo.getPRCheckStatus(repo, prNumber);
  return apiCache.dedupedFetch(`pr-checks:${repo}:${prNumber}`, 30_000, async () => {
    let raw: string;
    try {
      raw = await gh([
        "pr",
        "checks",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "name,state",
      ]);
    } catch (err) {
      if (err instanceof Error && /no checks reported|invalid character/i.test(err.message)) {
        return "none";
      }
      throw err;
    }
    const checks = safeJsonParse(z.array(PrCheckSchema), raw, "pr checks");
    if (checks.some((c) => FAILED_STATES.has(normalizeCheckState(c.state)))) return "failing";
    if (checks.length > 0 && checks.every((c) => PASSING_STATES.has(normalizeCheckState(c.state)))) return "passing";
    if (checks.length === 0) return "none";
    return "pending";
  }) as Promise<"passing" | "failing" | "pending" | "none">;
}

export async function getPRChecksSummary(
  repo: string,
  prNumber: number,
): Promise<{ status: "passing" | "failing" | "pending" | "none"; passed: number; total: number }> {
  if (isForgejoRepo(repo)) return forgejo.getPRChecksSummary(repo, prNumber);
  return apiCache.dedupedFetch(`pr-checks-sum:${repo}:${prNumber}`, 30_000, async () => {
    let raw: string;
    try {
      raw = await gh(["pr", "checks", String(prNumber), "--repo", repo, "--json", "name,state"]);
    } catch (err) {
      if (err instanceof Error && /no checks reported|invalid character/i.test(err.message)) {
        return { status: "none" as const, passed: 0, total: 0 };
      }
      throw err;
    }
    const checks = safeJsonParse(z.array(PrCheckSchema), raw, "pr checks");
    const total = checks.length;
    const passed = checks.filter((c) => PASSING_STATES.has(normalizeCheckState(c.state))).length;
    const failedCount = checks.filter((c) => FAILED_STATES.has(normalizeCheckState(c.state))).length;
    let status: "passing" | "failing" | "pending" | "none";
    if (total === 0) status = "none";
    else if (failedCount > 0) status = "failing";
    else if (passed === total) status = "passing";
    else status = "pending";
    return { status, passed, total };
  }) as Promise<{ status: "passing" | "failing" | "pending" | "none"; passed: number; total: number }>;
}

const REVIEW_HEADER_TEXT = "## PR Review";
const REVIEW_CLEAN_MARKER = "review-result: clean";
// Advisory / escalated reviews carry only non-blocking findings (or are paused for
// a human). They must NOT trigger the addresser, so the review loop can terminate.
// Kept as self-contained literals to avoid a circular import from pr-reviewer.ts.
const REVIEW_ADVISORY_MARKER = "review-result: advisory";
const REVIEW_ESCALATED_MARKER = "review-result: escalated";

export async function getPRReviewStatus(
  repo: string,
  prNumber: number,
): Promise<{ status: "clean" | "issues" | "escalated" | "none"; issueCount: number; reviewedCommit: string | null }> {
  if (isForgejoRepo(repo)) return forgejo.getPRReviewStatus(repo, prNumber);
  return apiCache.dedupedFetch(`pr-review-status:${repo}:${prNumber}`, 60_000, async () => {
    try {
      const comments = await getIssueComments(repo, prNumber);
      let latest: { body: string } | null = null;
      for (const c of comments) {
        if (isClawsComment(c.body) && c.body.includes(REVIEW_HEADER_TEXT)) latest = { body: c.body };
      }
      if (!latest) return { status: "none" as const, issueCount: 0, reviewedCommit: null };
      const reviewedCommit = latest.body.match(REVIEWED_COMMIT_PATTERN)?.[1] ?? null;
      // Check markers against the current round's content only — the collapsed
      // per-iteration audit log archives prior rounds' bodies (including their
      // review-result markers), so a check on the whole body would false-positive.
      const currentBody = latest.body.replace(/<details>[\s\S]*?<\/details>/gi, "");
      if (currentBody.includes(REVIEW_CLEAN_MARKER)) return { status: "clean" as const, issueCount: 0, reviewedCommit };
      if (currentBody.includes(REVIEW_ADVISORY_MARKER)) return { status: "clean" as const, issueCount: 0, reviewedCommit };
      // Escalated is the opposite of clean — the PR is stuck and needs a human
      // to look at it, so it must not share the "clean" bucket on the dashboard.
      if (currentBody.includes(REVIEW_ESCALATED_MARKER)) return { status: "escalated" as const, issueCount: 0, reviewedCommit };

      const stripped = stripClawsMarker(latest.body)
        .replace(/## PR Review\s*/, "")
        .replace(/\*Review #\d+\*\s*/, "")
        .replace(REVIEWED_COMMIT_PATTERN, "")
        .replace(/(?:<!-- )?review-iteration: \d+(?: -->)?/g, "")
        .replace(/<details>[\s\S]*?<\/details>/g, "")
        .trim();
      if (!stripped || /^Reviewed\s*—\s*no issues found\.?$/i.test(stripped)) {
        return { status: "clean" as const, issueCount: 0, reviewedCommit };
      }
      const numbered = (stripped.match(/^\s*\d+\.\s/gm) ?? []).length;
      const headings = (stripped.match(/^#{2,4}\s+\S/gm) ?? []).length;
      const issueCount = numbered > 0 ? numbered : headings;
      return { status: "issues" as const, issueCount, reviewedCommit };
    } catch {
      return { status: "none" as const, issueCount: 0, reviewedCommit: null };
    }
  }) as Promise<{ status: "clean" | "issues" | "escalated" | "none"; issueCount: number; reviewedCommit: string | null }>;
}

export async function updatePR(repo: string, prNumber: number, body: string, title?: string): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.updatePR(repo, prNumber, body, title);
  const args = ["pr", "edit", "--repo", repo, String(prNumber), "--body", body];
  if (title) args.push("--title", title);
  await gh(args);
}

/**
 * Squash-merge a PR. When `expectedHeadSha` is supplied the merge is pinned to
 * that commit via `--match-head-commit`, so GitHub rejects it if the head moved
 * between evaluation and merge (#2354).
 */
export async function mergePR(repo: string, prNumber: number, expectedHeadSha?: string): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.mergePR(repo, prNumber, expectedHeadSha);
  const args = ["pr", "merge", String(prNumber), "--repo", repo, "--squash"];
  if (expectedHeadSha) args.push("--match-head-commit", expectedHeadSha);
  await gh(args);
  recordGitHubEvent({ kind: "pr-merged", repo, number: prNumber, related: [] });
}

/** Drop the cached open-PR list for `repo` so the next `listPRs` re-reads it. */
export function invalidatePRList(repo: string): void {
  if (isForgejoRepo(repo)) {
    forgejo.invalidatePRList(repo);
    return;
  }
  apiCache.invalidate(`pr-list:${repo}`);
}

export async function closePR(repo: string, prNumber: number): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.closePR(repo, prNumber);
  await gh(["pr", "close", String(prNumber), "--repo", repo]);
  apiCache.invalidate(`pr-list:${repo}`);
  removeQueueItem(repo, prNumber);
  recordGitHubEvent({ kind: "pr-closed", repo, number: prNumber, related: [] });
}

// ── Reactions ──

export async function addReaction(repo: string, commentId: number, reaction: string): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.addReaction(repo, commentId, reaction);
  try {
    await gh(["api", `repos/${repo}/issues/comments/${commentId}/reactions`, "-f", `content=${reaction}`]);
    apiCache.invalidate(`comment-reactions:${repo}:${commentId}`);
  } catch (err) {
    log.warn(`addReaction on comment ${commentId} in ${repo}: ${err}`);
  }
}

export async function addReviewCommentReaction(repo: string, commentId: number, reaction: string): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.addReviewCommentReaction(repo, commentId, reaction);
  try {
    await gh(["api", `repos/${repo}/pulls/comments/${commentId}/reactions`, "-f", `content=${reaction}`]);
    apiCache.invalidate(`review-comment-reactions:${repo}:${commentId}`);
  } catch (err) {
    log.warn(`addReviewCommentReaction on comment ${commentId} in ${repo}: ${err}`);
  }
}

export interface Reaction {
  id: number;
  user: { login: string };
  content: string;
}

export async function getCommentReactions(repo: string, commentId: number): Promise<Reaction[]> {
  if (isForgejoRepo(repo)) return forgejo.getCommentReactions(repo, commentId);
  return apiCache.dedupedFetch(`comment-reactions:${repo}:${commentId}`, 60_000, async () => {
    const raw = await gh(["api", `repos/${repo}/issues/comments/${commentId}/reactions`]);
    return safeJsonParse(z.array(ReactionSchema), raw, "comment reactions");
  }) as Promise<Reaction[]>;
}

/**
 * Reactions on a pull-request *review* comment. Review-comment IDs live in a
 * different namespace from issue-comment IDs, so this cannot share
 * getCommentReactions' `issues/comments/...` endpoint or its cache key (#2265).
 */
export async function getReviewCommentReactions(repo: string, commentId: number): Promise<Reaction[]> {
  if (isForgejoRepo(repo)) return forgejo.getReviewCommentReactions(repo, commentId);
  return apiCache.dedupedFetch(`review-comment-reactions:${repo}:${commentId}`, 60_000, async () => {
    const raw = await gh(["api", `repos/${repo}/pulls/comments/${commentId}/reactions`]);
    return safeJsonParse(z.array(ReactionSchema), raw, "pr review comment reactions");
  }) as Promise<Reaction[]>;
}

/** Concurrent `gh api` reaction lookups. Each is a subprocess, so keep this small. */
const REACTION_FETCH_CONCURRENCY = 5;

/**
 * Fetch reactions for many comments with bounded concurrency. Failed lookups are
 * simply absent from the map — callers treat "absent" the same as the old
 * per-comment `catch { /* treat as no reaction *\/ }`.
 */
async function prefetchReactions(
  repo: string,
  commentIds: number[],
  fetcher: (repo: string, commentId: number) => Promise<Reaction[]>,
): Promise<Map<number, Reaction[]>> {
  const map = new Map<number, Reaction[]>();
  const settled = await mapSettledWithConcurrency(commentIds, REACTION_FETCH_CONCURRENCY, (id) => fetcher(repo, id));
  for (let i = 0; i < commentIds.length; i++) {
    const r = settled[i];
    if (r?.status === "fulfilled") map.set(commentIds[i]!, r.value);
  }
  return map;
}

export async function listCompareCommits(
  repo: string,
  base: string,
  head: string,
): Promise<{ sha: string; subject: string }[]> {
  if (isForgejoRepo(repo)) return forgejo.listCompareCommits(repo, base, head);
  const raw = await gh([
    "api",
    `repos/${repo}/compare/${base}...${head}`,
    "--jq", '{ commits: [.commits[] | { sha: .sha, message: .commit.message }] }',
  ]);
  const parsed = safeJsonParse(
    z.object({
      commits: z.array(z.object({ sha: z.string(), message: z.string() })),
    }),
    raw,
    "compare commits",
  );
  return parsed.commits.map((c) => ({
    sha: c.sha,
    subject: c.message.split("\n", 1)[0]!.trim(),
  }));
}

function isMergeFromBase(
  commit: { message: string; parents: unknown[] },
  baseBranch: string,
): boolean {
  if (commit.parents.length < 2) return false;
  const escaped = baseBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^Merge (remote-tracking )?branch '(origin\\/)?${escaped}'`,
    "i",
  );
  return pattern.test(commit.message);
}

export async function hasValidLGTM(repo: string, prNumber: number, baseBranch: string): Promise<boolean> {
  if (isForgejoRepo(repo)) return forgejo.hasValidLGTM(repo, prNumber, baseBranch);
  try {
    const commitsRaw = await gh([
      "api",
      `repos/${repo}/pulls/${prNumber}/commits`,
      "--paginate",
    ]);

    const commits = safeJsonParse(
      z.array(z.object({
        commit: z.object({
          message: z.string(),
          committer: z.object({ date: z.string() }),
        }),
        parents: z.array(z.object({ sha: z.string() })),
      })),
      commitsRaw,
      "pr commits for LGTM",
    );

    const nonMergeCommits = commits.filter(
      (c) => !isMergeFromBase({ message: c.commit.message, parents: c.parents }, baseBranch),
    );

    const raw = await gh([
      "api",
      `repos/${repo}/issues/${prNumber}/comments`,
      "--paginate",
    ]);
    const comments = safeJsonParse(
      z.array(z.object({
        body: z.string(),
        user: AuthorSchema,
        created_at: z.string(),
      })),
      raw,
      "issue comments for LGTM",
    );

    // Find the latest valid LGTM comment (exact match, case-insensitive)
    let latestLGTM: { created_at: string } | null = null;
    for (const comment of comments) {
      if (comment.body.trim().toUpperCase() !== "LGTM") continue;
      if (isClawsComment(comment.body)) continue;
      if (!latestLGTM || comment.created_at > latestLGTM.created_at) {
        latestLGTM = comment;
      }
    }

    if (!latestLGTM) return false;

    // If all commits are merge-from-base, LGTM is still valid
    if (nonMergeCommits.length === 0) return true;

    // LGTM is only valid if posted after the latest non-merge commit
    const commitDate = nonMergeCommits.at(-1)!.commit.committer.date;
    return latestLGTM.created_at > commitDate;
  } catch (err) {
    log.warn(`hasValidLGTM for PR #${prNumber} in ${repo}: ${err}`);
    return false;
  }
}

/**
 * Returns the REST API database IDs of all comments that belong to resolved
 * review threads on a PR. Uses the GraphQL API since resolution status is not
 * available through the REST API.
 */
async function getResolvedCommentIds(
  repo: string,
  prNumber: number,
): Promise<Set<number>> {
  const [owner, name] = repo.split("/");
  const ids = new Set<number>();

  let cursor: string | null = null;
  let hasNext = true;

  while (hasNext) {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const query = `query {
      repository(owner: "${owner}", name: "${name}") {
        pullRequest(number: ${prNumber}) {
          reviewThreads(first: 100${afterClause}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              isResolved
              comments(first: 100) {
                nodes { databaseId }
              }
            }
          }
        }
      }
    }`;

    const raw = await gh(["api", "graphql", "-f", `query=${query}`]);
    const data = safeJsonParse(
      z.object({
        data: z.object({
          repository: z.object({
            pullRequest: z.object({
              reviewThreads: z.object({
                pageInfo: z.object({
                  hasNextPage: z.boolean(),
                  endCursor: z.string().nullable(),
                }),
                nodes: z.array(z.object({
                  isResolved: z.boolean(),
                  comments: z.object({
                    nodes: z.array(z.object({ databaseId: z.number() })),
                  }),
                })),
              }),
            }),
          }),
        }),
      }),
      raw,
      "graphql review threads",
    );
    const threads = data.data.repository.pullRequest.reviewThreads;

    for (const thread of threads.nodes) {
      if (thread.isResolved) {
        for (const comment of thread.comments.nodes) {
          ids.add(comment.databaseId);
        }
      }
    }

    hasNext = threads.pageInfo.hasNextPage;
    cursor = threads.pageInfo.endCursor;
  }

  return ids;
}

export interface PRReviewData {
  formatted: string;
  commentIds: number[];
  reviewCommentIds: number[];
  /** HTML bodies for all comments in formatted — used for image-URL extraction only; not passed to the model. */
  htmlBodies: string[];
  /** The Claws PR review comment needing addressing, if any. */
  prReviewComment?: { id: number; body: string; reviewedCommit: string };
  /** True when the ONLY work in `formatted` is an advisory-only Claws review. */
  advisoryOnly?: boolean;
}

/**
 * Collect the outstanding review work for a PR.
 *
 * Advisory-only Claws reviews are skipped by default — they exist to break nit
 * ping-pong. Pass `includeAdvisory` to surface one anyway (see pr-dispatcher
 * Phase 3, which does this only while the PR is Ready-idle); the result then
 * carries `advisoryOnly: true` and any review already stamped
 * `advisory-addressed: <sha>` stays skipped, so advisory nits get at most one
 * fix round per PR.
 */
export async function getPRReviewComments(
  repo: string,
  prNumber: number,
  opts: { includeAdvisory?: boolean } = {},
): Promise<PRReviewData> {
  if (isForgejoRepo(repo)) return forgejo.getPRReviewComments(repo, prNumber, opts);
  const empty: PRReviewData = { formatted: "", commentIds: [], reviewCommentIds: [], htmlBodies: [], prReviewComment: undefined, advisoryOnly: false };
  try {
    const owner = repo.split("/")[0];
    const selfLogin = await getSelfLogin(owner);

    // Fetch PR body HTML for image-URL extraction (pre-signed URLs are in body_html, not body).
    let prBodyHtml = "";
    try {
      const prRaw = await gh([
        "api", `repos/${repo}/pulls/${prNumber}`,
        "-H", "Accept: application/vnd.github.full+json",
      ]);
      const prParsed = safeJsonParse(z.object({ body_html: z.string().nullish() }), prRaw, "pr body_html");
      prBodyHtml = prParsed.body_html ?? "";
    } catch (prHtmlErr) {
      log.warn(`getPRReviewComments: failed to fetch PR body HTML for ${repo}#${prNumber}: ${prHtmlErr}`);
    }

    // Fetch reviews (top-level review bodies with their status)
    const reviewsRaw = await gh([
      "api",
      `repos/${repo}/pulls/${prNumber}/reviews`,
      "--paginate",
      "-H", "Accept: application/vnd.github.full+json",
    ]);
    const reviews = safeJsonParse(
      z.array(z.object({
        user: AuthorSchema,
        state: z.string(),
        body: z.string(),
        body_html: z.string().nullish(),
      })),
      reviewsRaw,
      "pr reviews",
    );

    // Fetch inline review comments (comments on specific code lines)
    const commentsRaw = await gh([
      "api",
      `repos/${repo}/pulls/${prNumber}/comments`,
      "--paginate",
      "-H", "Accept: application/vnd.github.full+json",
    ]);
    const allComments = safeJsonParse(
      z.array(z.object({
        id: z.number(),
        user: AuthorSchema,
        path: z.string(),
        line: z.number().nullable(),
        body: z.string(),
        body_html: z.string().nullish(),
        diff_hunk: z.string(),
      })),
      commentsRaw,
      "pr review comments",
    );

    // Filter out comments that belong to resolved review threads.
    const resolvedIds = await getResolvedCommentIds(repo, prNumber);
    const comments = allComments.filter((c) => !resolvedIds.has(c.id));

    // Fetch general PR comments (issue comments on the conversation tab)
    const issueCommentsRaw = await gh([
      "api",
      `repos/${repo}/issues/${prNumber}/comments`,
      "--paginate",
      "-H", "Accept: application/vnd.github.full+json",
    ]);
    const issueComments = safeJsonParse(
      z.array(z.object({
        id: z.number(),
        user: AuthorSchema,
        body: z.string(),
        body_html: z.string().nullish(),
      })),
      issueCommentsRaw,
      "pr issue comments",
    );

    const humanParts: string[] = [];
    const clawsReviewParts: string[] = [];
    const clawsOtherParts: string[] = [];
    // HTML bodies for image-URL extraction only; not passed to the model.
    const htmlBodies: string[] = [];
    if (prBodyHtml) htmlBodies.push(prBodyHtml);
    const commentIds: number[] = [];
    const reviewCommentIds: number[] = [];
    let headSha: string | undefined;
    let prReviewComment: PRReviewData["prReviewComment"];

    // Add review bodies that have content
    const guardCtx = makeGuardCtx(repo, prNumber);
    for (const review of reviews) {
      if (review.body?.trim()) {
        // Claws doesn't write top-level review bodies via the reviews API, so all are human-authored.
        const body = guardContent(review.body, guardCtx("review-body"));
        humanParts.push(`Review by @${review.user.login} (${review.state}):\n${body}`);
        if (review.body_html) htmlBodies.push(review.body_html);
      }
    }

    // Bulk-fetch 🚀 state for every unresolved inline comment. One sequential
    // `gh api` per comment cost 20-30 subprocesses per pr-dispatcher cycle on a
    // busy PR (#2265) — the same anti-pattern listPRStatuses documents avoiding.
    const reviewReactions = await prefetchReactions(repo, comments.map((c) => c.id), getReviewCommentReactions);

    // Check which inline comments already have a 🚀 from Claws (addressed)
    for (const comment of comments) {
      const reactions = reviewReactions.get(comment.id) ?? [];
      const hasClawsAddressed = reactions.some((r) => r.user.login === selfLogin && r.content === ADDRESSED_REACTION);
      if (hasClawsAddressed) continue;

      const location = comment.line ? `${comment.path}:${comment.line}` : comment.path;
      // Inline review comments are always human-authored (Claws doesn't write inline review comments).
      const commentBody = guardContent(comment.body, guardCtx("review-comments"));
      humanParts.push(
        `Inline comment by @${comment.user.login} on ${location}:\n` +
          `\`\`\`\n${comment.diff_hunk}\n\`\`\`\n${commentBody}`,
      );
      if (comment.body_html) htmlBodies.push(comment.body_html);
      reviewCommentIds.push(comment.id);
    }

    // An advisory-only review is held aside until the loop finishes: it is only
    // real work when nothing else is pending (see the `nothingElse` check below).
    let advisoryCandidate:
      | { part: string; html?: string; comment: NonNullable<PRReviewData["prReviewComment"]> }
      | null = null;

    // Only a subset of issue-tab comments ever has its reactions read (see the skip
    // conditions in the loop below); prefetching the rest would waste rate limit.
    // A false negative here is harmless — the loop falls back to a live (cached) fetch.
    const needsReactions = (c: { user: { login: string }; body: string }): boolean => {
      if (!c.body?.trim()) return false;
      if (c.body.trim().toUpperCase() === "LGTM") return false;
      if (c.user.login === selfLogin && isClawsComment(c.body)) {
        return !c.body.includes("## PR Review") && !c.body.includes("review-addresser-summary");
      }
      return !c.user.login.endsWith("[bot]");
    };
    const issueReactions = await prefetchReactions(
      repo,
      issueComments.filter(needsReactions).map((c) => c.id),
      getCommentReactions,
    );

    // Add non-Claws, non-bot issue-tab comments without 🚀 from Claws
    // Human comments don't need 👍 — posting is the instruction
    for (const comment of issueComments) {
      if (!comment.body?.trim()) continue;
      if (comment.body.trim().toUpperCase() === "LGTM") continue;
      if (comment.user.login === selfLogin && isClawsComment(comment.body)) {
        const isReviewComment = comment.body.includes("## PR Review");

        if (isReviewComment) {
          // SHA-based filtering — no rocket reaction needed for PR review comments
          const commitMatch = comment.body.match(REVIEWED_COMMIT_PATTERN);
          if (commitMatch) {
            // Lazy-fetch HEAD SHA only when we encounter a PR review comment
            if (!headSha) headSha = await getPRHeadSHA(repo, prNumber);
            const reviewedCommit = commitMatch[1];

            // Skip stale reviews (reviewed a different commit than current HEAD)
            if (!headSha.startsWith(reviewedCommit)) continue;

            // Skip reviews already addressed without code changes
            const addressedMatch = comment.body.match(REVIEW_ADDRESSED_PATTERN);
            if (addressedMatch && addressedMatch[1] === reviewedCommit) continue;
          }

          // Check markers against the current round's content only — the
          // collapsed per-iteration audit log archives prior rounds' bodies
          // (including their review-result markers), so a check on the whole
          // body would false-positive on a stale marker and wrongly skip a real
          // blocking review.
          const currentBody = comment.body.replace(/<details>[\s\S]*?<\/details>/gi, "");
          // Skip clean reviews — no work for the addresser
          if (currentBody.includes(REVIEW_CLEAN_MARKER)) continue;
          // Escalated reviews are always skipped — a human owns them. Checked
          // before the advisory branch so an escalated review is never picked up.
          if (currentBody.includes(REVIEW_ESCALATED_MARKER)) continue;
          // Advisory-only reviews are recorded for audit; the addresser only fires
          // on them when the caller opts in (this is what breaks the review loop).
          const isAdvisory = currentBody.includes(REVIEW_ADVISORY_MARKER);
          if (isAdvisory && !opts.includeAdvisory) continue;
          // One-shot guard: check the RAW body (not currentBody) so a stamp that has
          // since been archived into the collapsed audit log still counts.
          if (isAdvisory && ADVISORY_ADDRESSED_PATTERN.test(comment.body)) continue;

          const stripped = stripClawsMarker(comment.body);
          const cleanedReviewBody = stripped
            .replace(/## PR Review\s*/, "")
            .replace(REVIEWED_COMMIT_PATTERN, "")
            .replace(REVIEW_ADDRESSED_PATTERN, "")
            .replace(REVIEW_REBUTTED_PATTERN, "")
            .replace(ADVISORY_ADDRESSED_PATTERN, "")
            .replace(/(?:<!-- )?review-iteration: \d+(?: -->)?/g, "")
            .replace(/\*Review #\d+\*\s*/, "")
            .replace(/###?\s+Review of PR\s*#?\s*\d*\s*/g, "")
            .trim();
          const isCleanReview =
            !cleanedReviewBody ||
            /^Reviewed\s*—\s*no issues found\.?$/i.test(cleanedReviewBody) ||
            /^This PR has no net changes/i.test(cleanedReviewBody);

          if (!isCleanReview) {
            // Strip the collapsed per-iteration audit log so the addresser only
            // sees the current round's findings, not old rounds to re-address.
            const strippedForAddresser = stripped.replace(/<details>[\s\S]*?<\/details>/gi, "").trim();
            const reviewComment = {
              id: comment.id,
              body: comment.body,
              reviewedCommit: commitMatch ? commitMatch[1] : "",
            };
            if (isAdvisory) {
              advisoryCandidate = {
                part: `Comment by @${comment.user.login} (automated by Claws):\n${strippedForAddresser}`,
                html: comment.body_html ?? undefined,
                comment: reviewComment,
              };
              continue;
            }
            clawsReviewParts.push(`Comment by @${comment.user.login} (automated by Claws):\n${strippedForAddresser}`);
            if (comment.body_html) htmlBodies.push(comment.body_html);
            prReviewComment = reviewComment;
          }
          continue;
        }

        // Skip the addresser's own rolling summary comment — feeding it back to
        // the addresser would have it try to "address" its own prior output.
        if (comment.body.includes("review-addresser-summary")) continue;

        // Non-review Claws comments: rocket-based addressing check
        let hasClawsAddressed = false;
        let hasHumanApproval = false;
        try {
          const reactions = issueReactions.get(comment.id) ?? await getCommentReactions(repo, comment.id);
          hasClawsAddressed = reactions.some((r) => r.user.login === selfLogin && r.content === ADDRESSED_REACTION);
          hasHumanApproval = reactions.some((r) => r.content === "+1" && !r.user.login.endsWith("[bot]"));
        } catch { /* treat as no reaction */ }
        if (hasClawsAddressed) continue;

        const stripped = stripClawsMarker(comment.body);
        clawsOtherParts.push(`Comment by @${comment.user.login} (automated by Claws):\n${stripped}`);
        if (comment.body_html) htmlBodies.push(comment.body_html);

        if (hasHumanApproval) {
          commentIds.push(comment.id);
        }
        continue;
      }
      if (comment.user.login.endsWith("[bot]")) continue;

      // Check for existing 🚀 reaction from Claws (addressed)
      let hasClawsAddressed = false;
      try {
        const reactions = issueReactions.get(comment.id) ?? await getCommentReactions(repo, comment.id);
        hasClawsAddressed = reactions.some((r) => r.user.login === selfLogin && r.content === ADDRESSED_REACTION);
      } catch { /* treat as no reaction */ }
      if (hasClawsAddressed) continue;

      humanParts.push(`Comment by @${comment.user.login}:\n${guardContent(comment.body, guardCtx("review-comments"))}`);
      if (comment.body_html) htmlBodies.push(comment.body_html);
      commentIds.push(comment.id);
    }

    // Advisory nits are only worth a round when they are the *only* outstanding
    // work. If anything else is pending (a human comment, a blocking review), the
    // normal Ready-removing path runs and the advisory content is dropped as today.
    let advisoryOnly = false;
    const nothingElse =
      humanParts.length === 0 &&
      clawsReviewParts.length === 0 &&
      clawsOtherParts.length === 0 &&
      commentIds.length === 0 &&
      reviewCommentIds.length === 0;
    if (advisoryCandidate && nothingElse) {
      clawsReviewParts.push(advisoryCandidate.part);
      if (advisoryCandidate.html) htmlBodies.push(advisoryCandidate.html);
      prReviewComment = advisoryCandidate.comment;
      advisoryOnly = true;
    }

    const sections: string[] = [];
    if (humanParts.length > 0) {
      sections.push(
        `=== HUMAN REVIEWER COMMENTS (AUTHORITATIVE — must be followed) ===\n\n` +
        humanParts.join("\n\n---\n\n"),
      );
    }
    if (clawsReviewParts.length > 0) {
      sections.push(
        `=== AUTOMATED CLAWS REVIEW (advisory — defer to human directives above when they conflict) ===\n\n` +
        clawsReviewParts.join("\n\n---\n\n"),
      );
    }
    if (clawsOtherParts.length > 0) {
      sections.push(
        `=== OTHER CLAWS AUTOMATED COMMENTS ===\n\n` +
        clawsOtherParts.join("\n\n---\n\n"),
      );
    }

    return {
      formatted: sections.join("\n\n---\n\n"),
      commentIds,
      reviewCommentIds,
      htmlBodies,
      prReviewComment,
      advisoryOnly,
    };
  } catch (err) {
    log.warn(`getPRReviewComments for PR #${prNumber} in ${repo}: ${err}`);
    return empty;
  }
}

export interface PRReviewNote {
  login: string;
  body: string;
  path?: string;
  line?: number | null;
}

/**
 * Raw human-readable review bodies and inline review comments for intent capture.
 * Resolved threads are deliberately NOT filtered — a resolved thread's owner comment
 * is still a statement of intent. Caller does author filtering.
 * Rejects on fetch failure; callers are expected to isolate/log that themselves.
 */
export async function getPRReviewNotes(repo: string, prNumber: number): Promise<PRReviewNote[]> {
  if (isForgejoRepo(repo)) return forgejo.getPRReviewNotes(repo, prNumber);
  const [reviews, comments] = await Promise.all([
    fetchPagedArray(
      `repos/${repo}/pulls/${prNumber}/reviews`,
      z.array(z.object({ user: AuthorSchema, body: z.string() })),
      "pr review notes (reviews)",
    ),
    fetchPagedArray(
      `repos/${repo}/pulls/${prNumber}/comments`,
      z.array(z.object({
        user: AuthorSchema,
        body: z.string(),
        path: z.string(),
        line: z.number().nullable(),
      })),
      "pr review notes (comments)",
    ),
  ]);
  const notes: PRReviewNote[] = [];
  for (const r of reviews) {
    if (r.body.trim()) notes.push({ login: r.user.login, body: r.body });
  }
  for (const c of comments) {
    if (c.body.trim()) notes.push({ login: c.user.login, body: c.body, path: c.path, line: c.line });
  }
  return notes;
}

export interface FailedCheck {
  name: string;
  state: string;
  link: string;
}

export async function getFailingCheck(repo: string, prNumber: number): Promise<FailedCheck | undefined> {
  if (isForgejoRepo(repo)) return forgejo.getFailingCheck(repo, prNumber);
  try {
    const raw = await gh([
      "pr",
      "checks",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "name,state,link",
    ]);
    const checks = safeJsonParse(z.array(FailedCheckSchema), raw, "pr checks failing");
    return checks.find((c) => FAILED_STATES.has(normalizeCheckState(c.state)));
  } catch {
    return undefined;
  }
}

export async function rerunWorkflow(repo: string, runId: string): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.rerunWorkflow(repo, runId);
  await gh(["run", "rerun", runId, "--repo", repo]);
}

const RunJobSummarySchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  stepCount: z.number(),
  failedSteps: z.array(z.string()).default([]),
});

export interface RunJobSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  stepCount: number;
  failedSteps: string[];
}

const RUN_JOBS_JQ =
  '[.jobs[] | {id: .id, name: .name, status: .status, conclusion: .conclusion, stepCount: (.steps // [] | length), failedSteps: [(.steps // [])[] | select(.conclusion == "failure" or .conclusion == "cancelled") | .name]}]';

/**
 * Jobs of a run with their recorded step counts. Returns [] on any failure so
 * callers fall back to normal failure handling rather than mis-classifying.
 * Cached briefly: identifyPRWork asks for the same run from the classification
 * phase, the CI_FIXER handler and the CI_FIXER_RERUN sweep within one cycle.
 */
export async function getRunJobSummaries(repo: string, runId: string): Promise<RunJobSummary[]> {
  if (isForgejoRepo(repo)) return forgejo.getRunJobSummaries(repo, runId);
  return apiCache.dedupedFetch(`run-jobs:${repo}:${runId}`, 30_000, async () => {
    try {
      const raw = await gh([
        "api",
        `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
        "--jq",
        RUN_JOBS_JQ,
      ]);
      return safeJsonParse(z.array(RunJobSummarySchema), raw, `run jobs for ${repo} run ${runId}`);
    } catch (err) {
      log.warn(`getRunJobSummaries for ${repo} run ${runId}: ${err}`);
      return [];
    }
  }) as Promise<RunJobSummary[]>;
}

/**
 * A job that failed or was cancelled without recording a single step never ran user
 * code — the runner went away mid-job (registration purge, nixos-rebuild, host reboot).
 * This is an infrastructure outcome, not a PR failure.
 */
export function isInfrastructureOutage(jobs: RunJobSummary[]): boolean {
  const bad = jobs.filter((j) => j.conclusion === "failure" || j.conclusion === "cancelled");
  return bad.length > 0 && bad.every((j) => j.stepCount === 0);
}

/**
 * Steps GitHub runs before the workflow's own code, plus the source fetch. A failure
 * confined to these never exercised the PR's diff. Also consulted on the normal
 * (non-degraded) path — there a mis-match costs at most INFRA_MAX_RERUNS (3) wasted
 * re-runs before isInfraRerunExhausted sends the run down the normal fix path.
 */
const PRE_REPO_STEP_RE =
  /^(set up job|set up runner|complete job|checkout|post checkout|run actions\/checkout|post run actions\/checkout)\b/i;

/**
 * True when every failed/cancelled job died before any repo-owned step ran — either
 * with no recorded steps at all, or with failures confined to GitHub's own setup and
 * checkout steps. A bad job with steps but no recorded failed step returns false
 * (conservative: we can't prove the diff wasn't exercised).
 */
export function isPreRepoStepFailure(jobs: RunJobSummary[]): boolean {
  const bad = jobs.filter((j) => j.conclusion === "failure" || j.conclusion === "cancelled");
  if (bad.length === 0) return false;
  return bad.every(
    (j) =>
      j.stepCount === 0 ||
      (j.failedSteps.length > 0 && j.failedSteps.every((s) => PRE_REPO_STEP_RE.test(s.trim()))),
  );
}

/**
 * Re-runs only the failed jobs of a run (`gh run rerun --failed`) — much cheaper than a
 * full rerun on a two-runner pool.
 */
export async function rerunFailedJobs(repo: string, runId: string): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.rerunFailedJobs(repo, runId);
  await gh(["run", "rerun", runId, "--repo", repo, "--failed"]);
}

/**
 * Cancels a GitHub Actions workflow run.
 * @param repo - The full repository name (e.g., "owner/repo")
 * @param runId - The workflow run ID (numeric string)
 * @throws Error if the run is already completed or if GitHub CLI fails
 */
export async function cancelWorkflow(repo: string, runId: string): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.cancelWorkflow(repo, runId);
  await gh(["run", "cancel", runId, "--repo", repo]);
}

async function getFailedJobLog(repo: string, runId: string): Promise<string> {
  const raw = await gh(["api", `repos/${repo}/actions/runs/${runId}/jobs`]);
  const { jobs } = safeJsonParse(
    z.object({
      jobs: z.array(z.object({
        id: z.number(),
        conclusion: z.string().nullable(),
        name: z.string(),
      })),
    }),
    raw,
    "actions runs jobs",
  );
  const failedJob = jobs.find((j) => j.conclusion === "failure");
  if (!failedJob) return "";

  const logOutput = await gh([
    "api", `repos/${repo}/actions/jobs/${failedJob.id}/logs`,
  ]);
  return logOutput.slice(0, 20_000);
}

export const BILLING_ANNOTATION_PATTERN = /account payments have failed|spending limit/i;

export function isBillingBlocked(annotations: string[]): boolean {
  return annotations.some((m) => BILLING_ANNOTATION_PATTERN.test(m));
}

export async function getRunAnnotations(repo: string, runId: string): Promise<string[]> {
  if (isForgejoRepo(repo)) return forgejo.getRunAnnotations(repo, runId);
  try {
    const raw = await gh(["api", `repos/${repo}/actions/runs/${runId}/jobs`]);
    const { jobs } = safeJsonParse(
      z.object({
        jobs: z.array(z.object({
          id: z.number(),
          conclusion: z.string().nullable().optional(),
          name: z.string(),
        })),
      }),
      raw,
      "actions runs jobs for annotations",
    );

    const messages: string[] = [];
    for (const job of jobs) {
      const annotationRaw = await gh(["api", `repos/${repo}/check-runs/${job.id}/annotations`]);
      const annotations = safeJsonParse(
        z.array(z.object({ message: z.string(), annotation_level: z.string().nullable().optional() })),
        annotationRaw,
        "check-run annotations",
      );
      messages.push(...annotations.map((a) => a.message));
    }
    return messages;
  } catch (err) {
    log.warn(`getRunAnnotations for run ${runId} in ${repo}: ${err}`);
    return [];
  }
}

export async function getFailedRunLog(repo: string, prNumber: number): Promise<string> {
  if (isForgejoRepo(repo)) return forgejo.getFailedRunLog(repo, prNumber);
  try {
    const raw = await gh([
      "pr",
      "checks",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "name,state,link",
    ]);
    const checks = safeJsonParse(z.array(FailedCheckSchema), raw, "pr checks for run log");
    const failed = checks.find((c) => FAILED_STATES.has(normalizeCheckState(c.state)));
    if (!failed?.link) return "";

    // Extract run ID from the link URL
    const match = failed.link.match(/\/actions\/runs\/(\d+)/);
    if (!match) return "";
    const runId = match[1];

    // Primary: gh run view --log-failed (requires run to be complete)
    try {
      const logOutput = await gh(["run", "view", runId, "--repo", repo, "--log-failed"]);
      if (logOutput.trim()) return logOutput.slice(0, 20_000);
      // CLI returned empty (e.g. runner cancellation) — try REST API
      return await getFailedJobLog(repo, runId);
    } catch {
      // Fallback: fetch individual failed job log via REST API
      // Works even when the run is still in progress or --log-failed can't find logs
      return await getFailedJobLog(repo, runId);
    }
  } catch (err) {
    log.warn(`getFailedRunLog for PR #${prNumber} in ${repo}: ${err}`);
    return "";
  }
}

// ── PR changed files ──

/** Infrastructure-as-code paths: an OpenTofu/Terraform change must never auto-merge. */
export function isInfraPath(p: string): boolean {
  return /(?:^|\/)(?:tofu|terraform)\//.test(p)
    || /\.(?:tf|tfvars)(?:\.json)?$/.test(p)
    || /(?:^|\/)\.terraform\.lock\.hcl$/.test(p)
    // A workflow/action that runs tofu can apply infra with no .tf file changing (#841).
    || /(?:^|\/)\.github\/(?:workflows|actions)\/.*(?:tofu|terraform)/i.test(p);
}

/** Infra-relevant subset of a changed-file list (empty when the PR touches no infra). */
export function infraPathsIn(files: string[]): string[] {
  return files.filter(isInfraPath);
}

export interface TofuPlanSummary { add: number; change: number; replace: number; destroy: number }

const TOFU_PLAN_MARKER = "<!-- tofu-plan -->";
const TOFU_PLAN_COUNTS = /\*\*(\d+) to add, (\d+) to change, (\d+) to replace, (\d+) to destroy\.\*\*/;

/**
 * Parse the redacted plan summary that production-infra's tofu-plan-on-pr.yml
 * posts. DISPLAY ONLY — an issue comment is spoofable and absent whenever the
 * plan job failed, so the auto-merge gate uses isInfraPath() instead (#2275).
 */
export async function getTofuPlanSummary(repo: string, prNumber: number): Promise<TofuPlanSummary | null> {
  try {
    const comments = await getIssueComments(repo, prNumber);
    const c = [...comments].reverse().find(
      (x) => x.login === "github-actions[bot]" && x.body.trimStart().startsWith(TOFU_PLAN_MARKER),
    );
    const m = c ? TOFU_PLAN_COUNTS.exec(c.body) : null;
    if (!m) return null;
    return { add: Number(m[1]), change: Number(m[2]), replace: Number(m[3]), destroy: Number(m[4]) };
  } catch { return null; }
}

export async function getPRChangedFiles(repo: string, prNumber: number): Promise<string[]> {
  if (isForgejoRepo(repo)) return forgejo.getPRChangedFiles(repo, prNumber);
  try {
    const raw = await gh(["pr", "diff", String(prNumber), "--repo", repo, "--name-only"]);
    return raw.split("\n").filter(Boolean);
  } catch (err) {
    log.warn(`getPRChangedFiles for PR #${prNumber} in ${repo}: ${err}`);
    return [];
  }
}

export async function getPRDiff(repo: string, prNumber: number): Promise<string> {
  if (isForgejoRepo(repo)) return forgejo.getPRDiff(repo, prNumber);
  try {
    return await gh(["pr", "diff", String(prNumber), "--repo", repo]);
  } catch (err) {
    log.warn(`getPRDiff for PR #${prNumber} in ${repo}: ${err}`);
    return "";
  }
}

export async function getPRHeadSHA(repo: string, prNumber: number): Promise<string> {
  if (isForgejoRepo(repo)) return forgejo.getPRHeadSHA(repo, prNumber);
  const raw = await gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "headRefOid", "--jq", ".headRefOid"]);
  return raw.trim();
}

// Fetch a PR's state ("OPEN" | "CLOSED" | "MERGED"). Returns null when the PR
// does not exist (404), so callers can treat it as "no PR".
export async function getPRState(repo: string, prNumber: number): Promise<string | null> {
  if (isForgejoRepo(repo)) return forgejo.getPRState(repo, prNumber);
  try {
    const raw = await gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "state", "--jq", ".state"]);
    return raw.trim() || null;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/\b404\b/.test(msg) || /not found/i.test(msg) || /could not resolve/i.test(msg)) return null;
    throw err;
  }
}

export interface UpstreamPRStatus {
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  title: string;
  url: string;
  updatedAt: string;
}

const UpstreamPRStatusSchema = z.object({
  state: z.string(),
  merged: z.boolean(),
  mergedAt: z.string().nullable(),
  title: z.string(),
  url: z.string(),
  updatedAt: z.string(),
});

/**
 * Merge status of a PR in an arbitrary (possibly externally-owned) repo, read
 * through the REST API so it works for repos with no App installation. Returns
 * null when the PR does not exist (404/403). (#2617)
 *
 * `title` is third-party text — guard it before embedding it anywhere an agent
 * will later read.
 */
export async function getUpstreamPRStatus(repo: string, prNumber: number): Promise<UpstreamPRStatus | null> {
  if (isForgejoRepo(repo)) return forgejo.getUpstreamPRStatus(repo, prNumber);
  let raw: string;
  try {
    raw = await gh(["api", `repos/${repo}/pulls/${prNumber}`, "--jq",
      "{state, merged, mergedAt: .merged_at, title, url: .html_url, updatedAt: .updated_at}"]);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    const msg = String((err as Error)?.message ?? err);
    if (/\b40[34]\b/.test(msg) || /not found/i.test(msg)) return null;
    throw err;
  }
  const parsed = safeJsonParse(UpstreamPRStatusSchema, raw, `upstream pr ${repo}#${prNumber}`);
  return {
    ...parsed,
    state: parsed.state.toLowerCase() === "closed" ? "closed" : "open",
  };
}

// Live re-verification of a PR's diff stats, bypassing the 60s `pr-list` cache.
// Returns null when the PR does not exist (404).
export async function getPRDiffStats(
  repo: string,
  prNumber: number,
): Promise<{ changedFiles: number; additions: number; deletions: number; state: string } | null> {
  if (isForgejoRepo(repo)) return forgejo.getPRDiffStats(repo, prNumber);
  try {
    const raw = await gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "changedFiles,additions,deletions,state"]);
    return safeJsonParse(
      z.object({
        changedFiles: z.number(),
        additions: z.number(),
        deletions: z.number(),
        state: z.string(),
      }),
      raw,
      "pr view diff stats",
    );
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/\b404\b/.test(msg) || /not found/i.test(msg) || /could not resolve/i.test(msg)) return null;
    throw err;
  }
}

export async function getPRBody(repo: string, prNumber: number): Promise<string> {
  if (isForgejoRepo(repo)) return forgejo.getPRBody(repo, prNumber);
  const raw = await gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "body", "--jq", ".body"]);
  return raw.trim();
}

export function getLinkedIssueNumber(pr: PR): number | null {
  // Try branch name: claws/issue-{N}-...
  const branchMatch = pr.headRefName.match(/^claws\/issue-(\d+)-/);
  if (branchMatch) return parseInt(branchMatch[1], 10);

  // Try PR body: Closes #N, Fixes #N, Resolves #N, Part of #N
  if (pr.body) {
    const bodyMatch = pr.body.match(/(?:closes?|fixes?|resolves?|part of)\s*#(\d+)/i);
    if (bodyMatch) return parseInt(bodyMatch[1], 10);
  }

  return null;
}

// ── Recently closed issues ──

export async function listRecentlyClosedIssues(
  repo: string,
  since: Date | null,
  limit = 100,
): Promise<{ number: number; title: string; body: string; closedAt: string; updatedAt: string; author: string }[]> {
  if (isForgejoRepo(repo)) return forgejo.listRecentlyClosedIssues(repo, since, limit);
  const raw = await gh([
    "issue", "list",
    "--repo", repo,
    "--state", "closed",
    "--limit", String(limit),
    "--json", "number,title,body,closedAt,updatedAt,author",
  ]);
  const issues = safeJsonParse(
    z.array(z.object({
      number: z.number(),
      title: z.string(),
      body: z.string(),
      closedAt: z.string(),
      updatedAt: z.string(),
      author: AuthorSchema,
    })),
    raw,
    "issue list closed",
  );
  const mapped = issues.map((i) => ({
    number: i.number, title: i.title, body: i.body, closedAt: i.closedAt, updatedAt: i.updatedAt,
    author: i.author.login,
  }));
  return since ? mapped.filter((i) => new Date(i.closedAt) >= since) : mapped;
}

export async function listRecentlyMergedPRs(
  repo: string,
  since: Date | null,
  limit = 50,
): Promise<{ number: number; title: string; body: string; mergedAt: string; updatedAt: string; author: string; headRefName: string }[]> {
  if (isForgejoRepo(repo)) return forgejo.listRecentlyMergedPRs(repo, since, limit);
  const raw = await gh([
    "pr", "list", "--repo", repo, "--state", "merged", "--limit", String(limit),
    "--json", "number,title,body,mergedAt,updatedAt,author,headRefName",
  ]);
  const prs = safeJsonParse(
    z.array(z.object({
      number: z.number(), title: z.string(), body: z.string(),
      mergedAt: z.string(), updatedAt: z.string(), author: AuthorSchema, headRefName: z.string(),
    })), raw, "pr list merged",
  );
  const mapped = prs.map((p) => ({
    number: p.number, title: p.title, body: p.body, mergedAt: p.mergedAt, updatedAt: p.updatedAt,
    author: p.author.login, headRefName: p.headRefName,
  }));
  return since ? mapped.filter((p) => new Date(p.mergedAt) >= since) : mapped;
}

/**
 * PRs the owner closed WITHOUT merging — the highest-signal record of rejected
 * direction. `gh pr list --state closed` includes merged PRs, so rows with a
 * non-null `mergedAt` are filtered out here rather than trusted to gh.
 */
export async function listRecentlyClosedUnmergedPRs(
  repo: string,
  since: Date | null,
  limit = 50,
): Promise<{ number: number; title: string; body: string; closedAt: string; updatedAt: string; author: string; headRefName: string }[]> {
  if (isForgejoRepo(repo)) return forgejo.listRecentlyClosedUnmergedPRs(repo, since, limit);
  const raw = await gh([
    "pr", "list", "--repo", repo, "--state", "closed", "--limit", String(limit),
    "--json", "number,title,body,closedAt,mergedAt,updatedAt,author,headRefName",
  ]);
  const prs = safeJsonParse(
    z.array(z.object({
      number: z.number(), title: z.string(), body: z.string(),
      closedAt: z.string(), mergedAt: z.string().nullable(), updatedAt: z.string(),
      author: AuthorSchema, headRefName: z.string(),
    })), raw, "pr list closed unmerged",
  );
  const mapped = prs
    .filter((p) => p.mergedAt === null)
    .map((p) => ({
      number: p.number, title: p.title, body: p.body, closedAt: p.closedAt, updatedAt: p.updatedAt,
      author: p.author.login, headRefName: p.headRefName,
    }));
  return since ? mapped.filter((p) => new Date(p.closedAt) >= since) : mapped;
}

// ── Branch cleanup helpers ──

export interface BranchPR {
  number: number;
  state: string;
  mergedAt?: string;
  closedAt?: string;
}

const BranchPrNodeSchema = z.object({
  number: z.number(),
  state: z.string(),
  mergedAt: z.string().nullable().optional(),
  closedAt: z.string().nullable().optional(),
});

const BranchPrGraphQLSchema = z.object({
  data: z.object({
    repository: z.record(z.string(), z.object({ nodes: z.array(BranchPrNodeSchema) })),
  }),
});

const BRANCH_PR_CHUNK = 50;
// Git refs cannot contain spaces, `~^:?*[\` or control chars; anything outside
// this set is not a name we produced, so skip it rather than risk GraphQL
// string injection.
const SAFE_BRANCH_RE = /^[A-Za-z0-9._\/-]+$/;

/**
 * Fetch all PRs (open, closed and merged) for many head branches of one repo in
 * a single `gh api graphql` call per 50 branches. Returns a Map keyed by branch
 * name; a queried branch with no PRs maps to []. Branches whose names fail
 * SAFE_BRANCH_RE are omitted from the map entirely.
 * Throws if any chunk fails — callers MUST NOT treat a rejection as "no PRs".
 */
export async function listPRsForBranches(
  repo: string,
  branchNames: string[],
): Promise<Map<string, BranchPR[]>> {
  if (isForgejoRepo(repo)) return forgejo.listPRsForBranches(repo, branchNames);
  const [owner, name] = repo.split("/");
  const safe = branchNames.filter((b) => SAFE_BRANCH_RE.test(b));
  const chunks: string[][] = [];
  for (let i = 0; i < safe.length; i += BRANCH_PR_CHUNK) {
    chunks.push(safe.slice(i, i + BRANCH_PR_CHUNK));
  }

  const result = new Map<string, BranchPR[]>();
  const perChunk = await mapWithConcurrency(chunks, 3, async (chunk) => {
    const fields = chunk
      .map(
        (b, i) =>
          `b${i}: pullRequests(headRefName: ${JSON.stringify(b)}, first: 10, ` +
          `states: [OPEN, CLOSED, MERGED], ` +
          `orderBy: {field: CREATED_AT, direction: DESC}) ` +
          `{ nodes { number state mergedAt closedAt } }`,
      )
      .join("\n");
    const query =
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {\n${fields}\n} }`;
    const raw = await gh([
      "api", "graphql",
      "-f", `owner=${owner}`,
      "-f", `name=${name}`,
      "-f", `query=${query}`,
    ]);
    const parsed = safeJsonParse(BranchPrGraphQLSchema, raw, "graphql prs for branches");
    return chunk.map((b, i) => {
      const nodes = parsed.data.repository[`b${i}`]?.nodes ?? [];
      return [b, nodes.map((n) => ({
        number: n.number,
        state: n.state,
        mergedAt: n.mergedAt ?? undefined,
        closedAt: n.closedAt ?? undefined,
      }))] as const;
    });
  });

  for (const pairs of perChunk) for (const [b, prs] of pairs) result.set(b, prs);
  return result;
}

export async function deleteRemoteBranch(repo: string, branchName: string): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.deleteRemoteBranch(repo, branchName);
  await gh(["api", "--method", "DELETE", `repos/${repo}/git/refs/heads/${branchName}`]);
}

async function getPRMetadata(
  repo: string,
  prNumber: number,
): Promise<{ labels: string[]; mergeableState: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" }> {
  if (isForgejoRepo(repo)) {
    const gate = await forgejo.getPRMergeGate(repo, prNumber);
    return { labels: gate.labels, mergeableState: gate.mergeable };
  }
  return apiCache.dedupedFetch(`pr-meta:${repo}:${prNumber}`, 30_000, async () => {
    const raw = await gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "labels,mergeable"]);
    const parsed = safeJsonParse(
      z.object({ labels: z.array(z.object({ name: z.string() })), mergeable: z.string() }),
      raw,
      "pr view metadata",
    );
    return {
      labels: parsed.labels.map((l) => l.name),
      mergeableState: parsed.mergeable as "MERGEABLE" | "CONFLICTING" | "UNKNOWN",
    };
  }) as Promise<{ labels: string[]; mergeableState: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" }>;
}

export async function enrichQueueItemsWithPRStatus(items: QueueItem[]): Promise<void> {
  const tasks = items.map(async (item) => {
    try {
      if (item.type === "pr") {
        item.prNumber = item.number;
        const [sum, meta, rev, files] = await Promise.all([
          getPRChecksSummary(item.repo, item.number),
          getPRMetadata(item.repo, item.number),
          getPRReviewStatus(item.repo, item.number),
          getPRChangedFiles(item.repo, item.number),
        ]);
        if (sum.status !== "none") {
          item.checkStatus = sum.status;
          item.checksPassed = sum.passed;
          item.checksTotal = sum.total;
        }
        item.labels = meta.labels;
        item.mergeableState = meta.mergeableState;
        item.reviewStatus = rev.status;
        if (rev.status === "issues") item.reviewIssueCount = rev.issueCount;
        const infra = infraPathsIn(files);
        if (infra.length > 0) {
          item.infraPaths = infra;
          item.tofuPlan = (await getTofuPlanSummary(item.repo, item.number)) ?? undefined;
        }
      } else if (item.type === "issue") {
        const pr = await getOpenPRForIssue(item.repo, item.number);
        if (pr) {
          item.prNumber = pr.number;
          const [sum, meta, rev, files] = await Promise.all([
            getPRChecksSummary(item.repo, pr.number),
            getPRMetadata(item.repo, pr.number),
            getPRReviewStatus(item.repo, pr.number),
            getPRChangedFiles(item.repo, pr.number),
          ]);
          if (sum.status !== "none") {
            item.checkStatus = sum.status;
            item.checksPassed = sum.passed;
            item.checksTotal = sum.total;
          }
          item.mergeableState = meta.mergeableState;
          item.reviewStatus = rev.status;
          if (rev.status === "issues") item.reviewIssueCount = rev.issueCount;
          const infra = infraPathsIn(files);
          if (infra.length > 0) {
            item.infraPaths = infra;
            item.tofuPlan = (await getTofuPlanSummary(item.repo, pr.number)) ?? undefined;
          }
        }
      }
    } catch {
      // Graceful degradation — item renders without status
    }
  });
  await Promise.allSettled(tasks);
}

// ── Workflow run fetching (runner metrics) ──

const WORKFLOW_RUN_JQ = '[.workflow_runs[] | {run_id: .id, workflow_name: .name, status: .status, conclusion: .conclusion, event: .event, head_branch: .head_branch, created_at: .created_at, run_started_at: .run_started_at, updated_at: .updated_at, head_sha: .head_sha, html_url: .html_url, run_attempt: .run_attempt}]';
const WORKFLOW_RUN_SINGLE_JQ = '{run_id: .id, workflow_name: .name, status: .status, conclusion: .conclusion, event: .event, head_branch: .head_branch, created_at: .created_at, run_started_at: .run_started_at, updated_at: .updated_at, head_sha: .head_sha, html_url: .html_url, run_attempt: .run_attempt}';

async function fetchWorkflowRunsRaw(repo: string, params: string): Promise<WorkflowRunRow[]> {
  assertGitHubOnly(repo, "GitHub Actions run history");
  const raw = await gh(["api", `repos/${repo}/actions/runs?${params}`, "--jq", WORKFLOW_RUN_JQ]);
  const parsed = safeJsonParse(z.array(WorkflowRunSchema), raw, `workflow runs for ${repo}`);
  return parsed.map(r => ({ ...r, repo }));
}

async function fetchWorkflowRuns(repo: string, params: string): Promise<WorkflowRunRow[]> {
  try {
    return await fetchWorkflowRunsRaw(repo, params);
  } catch (err) {
    log.warn(`[github] Failed to fetch workflow runs for ${repo}: ${err}`);
    return [];
  }
}

async function fetchWorkflowRunsBatched(
  repos: Repo[],
  concurrency: number,
  perRepo: (repo: Repo) => Promise<WorkflowRunRow[]>,
): Promise<WorkflowRunRow[]> {
  const results = await mapSettledWithConcurrency(repos, concurrency, perRepo);
  return results.flatMap(r => (r.status === "fulfilled" ? r.value : []));
}

export async function fetchRecentWorkflowRuns(repos: Repo[]): Promise<WorkflowRunRow[]> {
  return fetchWorkflowRunsBatched(repos, 10, repo =>
    fetchWorkflowRuns(repo.fullName, "per_page=30"),
  );
}

export async function fetchActiveWorkflowRuns(repos: Repo[]): Promise<WorkflowRunRow[]> {
  // Fetch in_progress and queued runs by status to avoid missing runs that fell outside
  // the recent per_page=30 window due to high repo activity.
  // Process repos in batches to cap concurrent API calls at 10 (2 statuses × 5 repos).
  return fetchWorkflowRunsBatched(repos, 5, async repo => {
    const results = await Promise.allSettled([
      fetchWorkflowRuns(repo.fullName, "status=in_progress&per_page=100"),
      fetchWorkflowRuns(repo.fullName, "status=queued&per_page=100"),
    ]);
    return results.flatMap(r => r.status === "fulfilled" ? r.value : []);
  });
}

export async function fetchWorkflowRunsForBackfill(repos: Repo[], sinceDaysAgo: number): Promise<WorkflowRunRow[]> {
  const since = new Date(Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  return fetchWorkflowRunsBatched(repos, 5, async repo => {
    const runs: WorkflowRunRow[] = [];
    for (let page = 1; page <= 3; page++) {
      const pageRuns = await fetchWorkflowRuns(
        repo.fullName,
        `per_page=100&page=${page}&created=%3E%3D${since}`,
      );
      runs.push(...pageRuns);
      if (pageRuns.length < 100) break;
    }
    return runs;
  });
}

export async function fetchWorkflowRunById(repo: string, runId: number): Promise<WorkflowRunRow | "not_found" | null> {
  assertGitHubOnly(repo, "GitHub Actions run history");
  try {
    const raw = await gh(["api", `repos/${repo}/actions/runs/${runId}`, "--jq", WORKFLOW_RUN_SINGLE_JQ]);
    const parsed = safeJsonParse(WorkflowRunSchema, raw, `workflow run ${runId} for ${repo}`);
    return { ...parsed, repo };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\b404\b/.test(msg) || /HTTP 404/i.test(msg) || /not found/i.test(msg)) {
      return "not_found";
    }
    log.warn(`[github] Failed to fetch workflow run ${runId} for ${repo}: ${err}`);
    return null;
  }
}

/** Unlike {@link fetchRecentWorkflowRuns}/{@link fetchActiveWorkflowRuns}, this does NOT
 * swallow fetch failures — callers that need to escalate persistent failures (e.g.
 * mac-runner-waker) rely on errors propagating rather than a silent empty array. */
export async function fetchQueuedWorkflowRuns(repo: string): Promise<WorkflowRunRow[]> {
  return fetchWorkflowRunsRaw(repo, "status=queued&per_page=20");
}

export interface QueuedJobInfo {
  name: string;
  labels: string[];
}

const QueuedJobSchema = z.object({ name: z.string(), labels: z.array(z.string()) });

/** Does not swallow fetch failures — see {@link fetchQueuedWorkflowRuns}. */
export async function fetchQueuedJobsForRun(repo: string, runId: number): Promise<QueuedJobInfo[]> {
  assertGitHubOnly(repo, "GitHub Actions job queue");
  const raw = await gh([
    "api",
    `repos/${repo}/actions/runs/${runId}/jobs`,
    "--jq",
    '[.jobs[] | select(.status == "queued") | {name: .name, labels: .labels}]',
  ]);
  return safeJsonParse(z.array(QueuedJobSchema), raw, `queued jobs for ${repo} run ${runId}`);
}

export interface SelfHostedRunner {
  name: string;
  status: string;
  labels: string[];
}

const SelfHostedRunnerSchema = z.object({
  name: z.string(),
  status: z.string(),
  labels: z.array(z.string()),
});

const RUNNERS_JQ = "[.runners[] | {name: .name, status: .status, labels: [.labels[].name]}]";

function is403(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b403\b/.test(msg) || /HTTP 403/i.test(msg);
}

/** Self-hosted runners visible to a repo with their online/offline status —
 * the repo-level registry merged with the owning org's (the Macs are
 * registered at the org level; the repo-level list is empty for them).
 * The two lookups need different permissions (repo Administration: read vs
 * org Self-hosted runners: read), so a 403 on one just drops that registry;
 * only when BOTH are invisible does this return null, telling callers to
 * skip status checks instead of treating every runner as unregistered.
 * Other fetch failures propagate — see {@link fetchQueuedWorkflowRuns}. */
export async function fetchSelfHostedRunners(repo: string): Promise<SelfHostedRunner[] | null> {
  assertGitHubOnly(repo, "the self-hosted runner registry");
  const org = repo.split("/")[0];
  const results: SelfHostedRunner[] = [];
  let visible = false;
  try {
    const raw = await gh(["api", `repos/${repo}/actions/runners?per_page=100`, "--jq", RUNNERS_JQ]);
    results.push(...safeJsonParse(z.array(SelfHostedRunnerSchema), raw, `self-hosted runners for ${repo}`));
    visible = true;
  } catch (err) {
    if (!is403(err)) throw err;
  }
  try {
    const raw = await gh(["api", `orgs/${org}/actions/runners?per_page=100`, "--jq", RUNNERS_JQ]);
    results.push(...safeJsonParse(z.array(SelfHostedRunnerSchema), raw, `self-hosted runners for org ${org}`));
    visible = true;
  } catch (err) {
    if (!is403(err)) throw err;
  }
  if (!visible) {
    log.warn(`[github] Runner registry for ${repo} not visible (403 on repo and org endpoints) — skipping runner status check`);
    return null;
  }
  return results;
}

// ── Dynamic workflow runs (Dependabot's updater, CodeQL default setup, etc.) ──
// These are generated by GitHub from a repository/org setting rather than a file in the
// tree, so `repos/{repo}/actions/runs?event=dynamic` is the only way to see where one
// actually executed.

interface DynamicRun {
  repo: string;
  runId: number;
  /** e.g. "dynamic/dependabot/dependabot-updates" or "dynamic/github-code-scanning/codeql" */
  path: string;
  /** e.g. "npm_and_yarn in /. - Update #1469069355" */
  name: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  htmlUrl: string;
}

const DynamicRunSchema = z.object({
  runId: z.number(),
  path: z.string(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  createdAt: z.string(),
  htmlUrl: z.string(),
});

const DYNAMIC_RUN_JQ =
  '[.workflow_runs[] | {runId: .id, path: .path, name: .name, status: .status, conclusion: .conclusion, createdAt: .created_at, htmlUrl: .html_url}]';

/**
 * Raw `event=dynamic` run fetch shared by `listDependabotUpdateRuns` and
 * `listDynamicWorkflowRuns` — both scanners poll every managed repo on their own cadence, so
 * this dedupes/caches the identical request instead of each maintaining its own near-identical
 * `gh()` call. Returns `[]` (never throws) for repos with Actions disabled or no dynamic-run
 * history.
 */
async function listDynamicRuns(repo: string): Promise<DynamicRun[]> {
  return apiCache.dedupedFetch(`dynamic-runs:${repo}`, 60_000, async () => {
    try {
      const raw = await gh([
        "api",
        `repos/${repo}/actions/runs?event=dynamic&per_page=50`,
        "--jq",
        DYNAMIC_RUN_JQ,
      ]);
      const parsed = safeJsonParse(z.array(DynamicRunSchema), raw, `dynamic runs for ${repo}`);
      return parsed.map(r => ({ ...r, repo }));
    } catch (err) {
      if (isNotFoundError(err)) return [];
      log.warn(`[github] Failed to fetch dynamic runs for ${repo}: ${err}`);
      return [];
    }
  }) as Promise<DynamicRun[]>;
}

export interface DependabotUpdateRun {
  repo: string;
  runId: number;
  /** e.g. "npm_and_yarn in /. - Update #1469069355" */
  name: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  htmlUrl: string;
}

/** Dependabot's updater is a *dynamic* workflow with no file in the repo, so it cannot be
 *  targeted by `on.workflow_run`. Returns `[]` (never throws) for repos with Actions
 *  disabled or no updater history. */
export async function listDependabotUpdateRuns(repo: string): Promise<DependabotUpdateRun[]> {
  assertGitHubOnly(repo, "Dependabot");
  const runs = await listDynamicRuns(repo);
  // CodeQL default setup also produces `event: dynamic` runs
  // (`dynamic/github-code-scanning/codeql`), so the `.path` filter is load-bearing.
  return runs
    .filter((r) => r.path === "dynamic/dependabot/dependabot-updates")
    .map(({ repo, runId, name, status, conclusion, createdAt, htmlUrl }) =>
      ({ repo, runId, name, status, conclusion, createdAt, htmlUrl }));
}

/** Returns the **tail** of the first failed job's log for a run (the Dependabot updater
 *  reports its error near the end of a ~700-line log, so head-truncation loses it).
 *  Returns `""` on any failure. */
export async function fetchFailedJobLog(
  repo: string,
  runId: number,
  maxChars = 300_000,
): Promise<string> {
  assertGitHubOnly(repo, "GitHub Actions run history");
  try {
    const raw = await gh(["api", `repos/${repo}/actions/runs/${runId}/jobs`]);
    const { jobs } = safeJsonParse(
      z.object({
        jobs: z.array(z.object({
          id: z.number(),
          name: z.string(),
          conclusion: z.string().nullable(),
        })),
      }),
      raw,
      `jobs for ${repo} run ${runId}`,
    );
    const failedJob = jobs.find(j => j.conclusion === "failure");
    if (!failedJob) return "";
    // This endpoint returns plain text (302 → log blob), not JSON.
    const logOutput = await gh(["api", `repos/${repo}/actions/jobs/${failedJob.id}/logs`]);
    return logOutput.slice(-maxChars);
  } catch (err) {
    log.warn(`[github] Failed to fetch failed-job log for ${repo} run ${runId}: ${err}`);
    return "";
  }
}

export interface DynamicWorkflowRun {
  repo: string;
  runId: number;
  /** e.g. "dynamic/dependabot/dependabot-updates" or "dynamic/github-code-scanning/codeql" */
  path: string;
  name: string;
  createdAt: string;
  htmlUrl: string;
}

/**
 * Every dynamic workflow run (Dependabot's updater, CodeQL default setup, etc.) — this is the
 * only way to see where one actually executed. Returns `[]` (never throws) for repos with
 * Actions disabled or no dynamic-run history.
 */
export async function listDynamicWorkflowRuns(repo: string): Promise<DynamicWorkflowRun[]> {
  assertGitHubOnly(repo, "GitHub Actions run history");
  const runs = await listDynamicRuns(repo);
  return runs.map(({ repo, runId, path, name, createdAt, htmlUrl }) =>
    ({ repo, runId, path, name, createdAt, htmlUrl }));
}

export interface RunJobRunnerInfo {
  name: string;
  labels: string[];
  runnerGroupName: string | null;
}

const RunJobRunnerInfoSchema = z.object({
  name: z.string(),
  labels: z.array(z.string()),
  runnerGroupName: z.string().nullable(),
});

const RUN_JOB_RUNNER_INFO_JQ =
  "[.jobs[] | {name: .name, labels: (.labels // []), runnerGroupName: .runner_group_name}]";

/**
 * The runner identity (labels + runner group) of each job in a run — the tell for whether a
 * job actually executed on a billed GitHub-hosted runner vs. self-hosted. Returns `[]` only for
 * a deleted run (404) — that's a genuinely empty result. Any other failure (network blip, 5xx,
 * rate limit) is rethrown so callers don't mistake an inconclusive fetch for "no violations"
 * and wrongly auto-resolve an alert.
 */
export async function getRunJobRunnerInfo(repo: string, runId: number): Promise<RunJobRunnerInfo[]> {
  assertGitHubOnly(repo, "GitHub Actions run history");
  try {
    const raw = await gh([
      "api",
      `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
      "--jq",
      RUN_JOB_RUNNER_INFO_JQ,
    ]);
    return safeJsonParse(z.array(RunJobRunnerInfoSchema), raw, `run job runner info for ${repo} run ${runId}`);
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
}

// ── Actions storage usage (caches + artifacts) ──

const CacheUsageSchema = z.object({
  active_caches_count: z.number(),
  active_caches_size_in_bytes: z.number(),
});

export interface RepoStorageUsage {
  repo: string;
  cacheBytes: number;
  cacheCount: number;
  artifactBytes: number;
  artifactCount: number;
  oldestArtifactAt: string | null;
}

function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b/.test(msg) || /HTTP 404/i.test(msg) || /not found/i.test(msg);
}

// GET /repos/{repo}/actions/cache/usage — repos with Actions disabled 404; treat as zero.
export async function fetchRepoCacheUsage(repo: string): Promise<{ bytes: number; count: number }> {
  assertGitHubOnly(repo, "Actions cache storage");
  try {
    const raw = await gh(["api", `repos/${repo}/actions/cache/usage`]);
    const parsed = safeJsonParse(CacheUsageSchema, raw, `cache usage for ${repo}`);
    return { bytes: parsed.active_caches_size_in_bytes, count: parsed.active_caches_count };
  } catch (err) {
    if (isNotFoundError(err)) {
      log.warn(`[github] Actions cache usage unavailable for ${repo} (treating as zero): ${err}`);
      return { bytes: 0, count: 0 };
    }
    throw err;
  }
}

// `gh api --paginate --jq` emits one JSON object per line (NOT a single array).
export function parseArtifactLines(raw: string): { bytes: number; count: number; oldestAt: string | null } {
  const lines = raw.trim().split("\n").filter(Boolean);
  let bytes = 0;
  let count = 0;
  let oldestAt: string | null = null;
  for (const line of lines) {
    const obj = JSON.parse(line) as { size: number; created: string; expired: boolean };
    if (obj.expired === true) continue;
    bytes += obj.size;
    count++;
    // ISO-8601 timestamps sort correctly as strings.
    if (oldestAt === null || obj.created < oldestAt) oldestAt = obj.created;
  }
  return { bytes, count, oldestAt };
}

// GET /repos/{repo}/actions/artifacts — paginated; repos with Actions disabled 404.
export async function fetchRepoArtifactUsage(
  repo: string,
): Promise<{ bytes: number; count: number; oldestAt: string | null }> {
  assertGitHubOnly(repo, "Actions artifact storage");
  try {
    const raw = await gh([
      "api",
      `repos/${repo}/actions/artifacts`,
      "--paginate",
      "--jq",
      ".artifacts[] | {size: .size_in_bytes, created: .created_at, expired: .expired}",
    ]);
    return parseArtifactLines(raw);
  } catch (err) {
    if (isNotFoundError(err)) {
      log.warn(`[github] Actions artifacts unavailable for ${repo} (treating as zero): ${err}`);
      return { bytes: 0, count: 0, oldestAt: null };
    }
    throw err;
  }
}

// ── Dependabot alerts ──

export class DependabotAlertsPermissionError extends Error {
  constructor(public readonly repo: string, message: string) {
    super(message);
    this.name = "DependabotAlertsPermissionError";
  }
}

export interface DependabotAlert {
  number: number;
  severity: string;
  packageName: string;
  ecosystem: string;
  summary: string;
  ghsaId: string;
  htmlUrl: string;
  manifestPath?: string;
  patchedVersion?: string;
  /** "runtime" | "development" | undefined. */
  scope?: string;
  /** "direct" | "transitive" | "unknown" | undefined. */
  relationship?: string;
  /** Advisory range, e.g. "< 3.1.6" or ">= 3.0.0, < 3.1.6". */
  vulnerableVersionRange?: string;
}

export async function listOpenDependabotAlerts(repo: string): Promise<DependabotAlert[]> {
  assertGitHubOnly(repo, "Dependabot alerts");
  let raw: string;
  try {
    raw = await gh(["api", `repos/${repo}/dependabot/alerts?state=open&per_page=100`]);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/resource not accessible by integration/i.test(msg)) {
      throw new DependabotAlertsPermissionError(repo, msg);
    }
    // 404 / "disabled" / other 403 → Dependabot alerts not enabled on this repo
    if (/\b40[34]\b/.test(msg) || /HTTP 40[34]/i.test(msg) || /not found/i.test(msg) || /disabled/i.test(msg)) {
      return [];
    }
    throw err;
  }
  const arr = JSON.parse(raw) as any[];
  return arr.map((a) => ({
    number: a.number,
    severity: a.security_advisory?.severity ?? a.security_vulnerability?.severity ?? "unknown",
    packageName: a.dependency?.package?.name ?? "unknown",
    ecosystem: a.dependency?.package?.ecosystem ?? "",
    summary: a.security_advisory?.summary ?? "",
    ghsaId: a.security_advisory?.ghsa_id ?? "",
    htmlUrl: a.html_url ?? "",
    manifestPath: a.dependency?.manifest_path,
    patchedVersion: a.security_vulnerability?.first_patched_version?.identifier,
    scope: a.dependency?.scope,
    relationship: a.dependency?.relationship,
    vulnerableVersionRange: a.security_vulnerability?.vulnerable_version_range,
  }));
}

export async function dismissDependabotAlert(
  repo: string,
  number: number,
  reason: string,
  comment: string,
): Promise<void> {
  assertGitHubOnly(repo, "Dependabot alerts");
  await gh([
    "api",
    "--method", "PATCH",
    `repos/${repo}/dependabot/alerts/${number}`,
    "-f", "state=dismissed",
    "-f", `dismissed_reason=${reason}`,
    "-f", `dismissed_comment=${comment}`,
  ]);
}

export interface SbomPackage { name: string; version: string }

export async function fetchRepoSbomPackages(repo: string): Promise<SbomPackage[]> {
  assertGitHubOnly(repo, "the dependency-graph SBOM");
  let raw: string;
  try {
    raw = await gh(["api", `repos/${repo}/dependency-graph/sbom`]);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/\b40[34]\b/.test(msg) || /HTTP 40[34]/i.test(msg) || /not found/i.test(msg) || /disabled/i.test(msg)) {
      return [];
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as { sbom?: { packages?: Array<{ name?: string; versionInfo?: string }> } };
  const pkgs = parsed.sbom?.packages ?? [];
  return pkgs
    .filter((p) => p.name && p.versionInfo)
    .map((p) => {
      const colon = p.name!.indexOf(":");
      const name = (colon >= 0 ? p.name!.slice(colon + 1) : p.name!).toLowerCase();
      return { name, version: p.versionInfo! };
    });
}

export async function fetchRepoFileContent(repo: string, path: string): Promise<string | null> {
  if (isForgejoRepo(repo)) return forgejo.fetchRepoFileContent(repo, path);
  let raw: string;
  try {
    raw = await gh(["api", `repos/${repo}/contents/${path}`, "--jq", ".content"]);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/\b40[34]\b/.test(msg) || /HTTP 40[34]/i.test(msg) || /not found/i.test(msg)) return null;
    throw err;
  }
  const b64 = raw.trim();
  if (!b64) return null;
  return Buffer.from(b64, "base64").toString("utf8");
}

export interface RepoDirEntry {
  name: string;
  path: string;
  sha: string;
  type: string;
}

// List a directory's entries via the contents API. A missing/renamed directory
// (404) yields [] so callers can still render.
export async function listRepoDirectory(repo: string, dirPath: string): Promise<RepoDirEntry[]> {
  if (isForgejoRepo(repo)) return forgejo.listRepoDirectory(repo, dirPath);
  let raw: string;
  try {
    raw = await gh(["api", `repos/${repo}/contents/${dirPath}`]);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/\b40[34]\b/.test(msg) || /HTTP 40[34]/i.test(msg) || /not found/i.test(msg)) return [];
    throw err;
  }
  const parsed = JSON.parse(raw) as Array<{ name?: string; path?: string; sha?: string; type?: string }>;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((e) => e.name && e.path && e.sha && e.type)
    .map((e) => ({ name: e.name!, path: e.path!, sha: e.sha!, type: e.type! }));
}

// Fetch a single file's decoded content plus its git blob sha (needed for
// updates). 404/403 → null, mirroring fetchRepoFileContent.
export async function fetchRepoFileWithSha(
  repo: string,
  path: string,
  ref?: string,
): Promise<{ content: string; sha: string } | null> {
  if (isForgejoRepo(repo)) return forgejo.fetchRepoFileWithSha(repo, path, ref);
  const endpoint = ref
    ? `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`
    : `repos/${repo}/contents/${path}`;
  let raw: string;
  try {
    raw = await gh(["api", endpoint]);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/\b40[34]\b/.test(msg) || /HTTP 40[34]/i.test(msg) || /not found/i.test(msg)) return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as { content?: string; sha?: string };
  if (!parsed.content || !parsed.sha) return null;
  return {
    content: Buffer.from(parsed.content, "base64").toString("utf8"),
    sha: parsed.sha,
  };
}

export async function getDefaultBranch(repo: string): Promise<string> {
  if (isForgejoRepo(repo)) return forgejo.getDefaultBranch(repo);
  const raw = await gh(["api", `repos/${repo}`, "--jq", ".default_branch"]);
  return raw.trim();
}

// Create a new branch ref pointing at baseBranch's tip. Swallows the 422
// "Reference already exists" so retries are idempotent.
export async function createBranchRef(repo: string, newBranch: string, baseBranch: string): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.createBranchRef(repo, newBranch, baseBranch);
  const sha = (
    await gh(["api", `repos/${repo}/git/ref/heads/${baseBranch}`, "--jq", ".object.sha"])
  ).trim();
  try {
    await gh([
      "api",
      `repos/${repo}/git/refs`,
      "-f",
      `ref=refs/heads/${newBranch}`,
      "-f",
      `sha=${sha}`,
    ]);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/Reference already exists/i.test(msg)) return;
    throw err;
  }
}

export interface BranchTipCommit {
  sha: string;
  treeSha: string;
  message: string;
}

// Tip commit of a branch, read straight from the ref (not the cached PR list).
// Returns null when the ref is gone (404) — the branch was deleted mid-cycle.
export async function getBranchTipCommit(repo: string, branch: string): Promise<BranchTipCommit | null> {
  assertGitHubOnly(repo, "the git-data commit API");
  let sha: string;
  try {
    sha = (await gh(["api", `repos/${repo}/git/ref/heads/${branch}`, "--jq", ".object.sha"])).trim();
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/\b404\b/.test(msg) || /not found/i.test(msg)) return null;
    throw err;
  }
  let raw: string;
  try {
    raw = await gh(["api", `repos/${repo}/git/commits/${sha}`]);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/\b404\b/.test(msg) || /not found/i.test(msg)) return null;
    throw err;
  }
  const parsed = safeJsonParse(GitCommitSchema, raw, "git commit");
  return { sha: parsed.sha, treeSha: parsed.tree.sha, message: parsed.message };
}

// Create a commit with the same tree as `tip` and `tip` as sole parent, then
// fast-forward refs/heads/<branch> onto it. Returns "not-fast-forward" when the
// ref moved between read and write (force is never used).
export async function pushEmptyCommit(
  repo: string,
  branch: string,
  message: string,
  tip: BranchTipCommit,
): Promise<"pushed" | "not-fast-forward"> {
  assertGitHubOnly(repo, "the git-data commit API");
  const createRaw = await gh([
    "api",
    `repos/${repo}/git/commits`,
    "--method",
    "POST",
    "-f",
    `message=${message}`,
    "-f",
    `tree=${tip.treeSha}`,
    "-f",
    `parents[]=${tip.sha}`,
  ]);
  const { sha: newSha } = safeJsonParse(z.object({ sha: z.string() }), createRaw, "git commit create");

  try {
    await gh([
      "api",
      `repos/${repo}/git/refs/heads/${branch}`,
      "--method",
      "PATCH",
      "-f",
      `sha=${newSha}`,
      "-F",
      "force=false",
    ]);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/not a fast forward/i.test(msg) || /\b422\b/.test(msg)) return "not-fast-forward";
    throw err;
  }
  return "pushed";
}

// Create or update a file on a branch via the contents API. Pass sha only when
// updating an existing file (omit to create a new one).
export async function putRepoFile(
  repo: string,
  branch: string,
  path: string,
  contentBase64: string,
  message: string,
  sha?: string,
): Promise<void> {
  if (isForgejoRepo(repo)) return forgejo.putRepoFile(repo, branch, path, contentBase64, message, sha);
  const args = [
    "api",
    "--method",
    "PUT",
    `repos/${repo}/contents/${path}`,
    "-f",
    `message=${message}`,
    "-f",
    `content=${contentBase64}`,
    "-f",
    `branch=${branch}`,
  ];
  if (sha) {
    args.push("-f", `sha=${sha}`);
  }
  await gh(args);
}

// Combine cache + artifact usage. Each sub-call is fault-tolerant for 404s.
export async function fetchRepoStorageUsage(repo: string): Promise<RepoStorageUsage> {
  const [cache, artifacts] = await Promise.all([
    fetchRepoCacheUsage(repo),
    fetchRepoArtifactUsage(repo),
  ]);
  return {
    repo,
    cacheBytes: cache.bytes,
    cacheCount: cache.count,
    artifactBytes: artifacts.bytes,
    artifactCount: artifacts.count,
    oldestArtifactAt: artifacts.oldestAt,
  };
}

