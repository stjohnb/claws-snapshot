import { execFile } from "node:child_process";
import { z } from "zod";
import { GITHUB_OWNERS, LABELS, LABEL_SPECS, SKIPPED_ITEMS, PRIORITIZED_ITEMS, ALLOWED_ACTORS, CI_FIXER_MAX_ATTEMPTS, CI_FIXER_WINDOW_MS, writeConfig, SELF_REPO, type Repo, type ConfigFile } from "./config.js";
import * as log from "./log.js";
import { formatMs } from "./format.js";
import { notify } from "./slack.js";
import { reportError } from "./error-reporter.js";
import { guardContent, makeGuardCtx } from "./prompt-guard.js";
import type { WorkflowRunRow } from "./db.js";
import { getInstallationTokenForOwner, extractOwnerFromGhArgs, buildEnvForGh, getAppBotLogin, listInstallationRepositories, registerOnResetCallback } from "./github-app.js";
import { sleep } from "./util.js";
import { retryWithBackoff } from "./retry.js";

const RATE_LIMIT_RE = /rate limit/i;
const TRANSIENT_RE = /\b(400|401|500|502|503|504|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAGAIN|connection reset)\b|Could not resolve to a|TLS handshake timeout|Something went wrong|i\/o timeout|invalid character|failed to create new OS thread|resource temporarily unavailable|unexpected EOF/i;
const MAX_RETRIES = 3;

// ── Circuit breaker (rate limit protection) ──

let rateLimitedUntil: number | null = null;

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export function isRateLimited(): boolean {
  return rateLimitedUntil !== null && Date.now() < rateLimitedUntil;
}

function setRateLimited(cooldownMs = 60_000): void {
  rateLimitedUntil = Date.now() + cooldownMs;
  log.warn(`[github] Rate limit detected — blocking API calls for ${formatMs(cooldownMs)}`);
  notify(`[WARN] GitHub API rate limit hit — blocking calls for ${formatMs(cooldownMs)}`);
}

export function clearRateLimitState(): void {
  rateLimitedUntil = null;
}

// ── Generic TTL cache with deduplication ──

class TTLCache<T> {
  private cache = new Map<string, { value: T; expiresAt: number }>();
  private inFlight = new Map<string, Promise<T>>();

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (entry && Date.now() < entry.expiresAt) return entry.value;
    if (entry) this.cache.delete(key);
    return undefined;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  async dedupedFetch(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = fetcher().then((result) => {
      this.set(key, result, ttlMs);
      this.inFlight.delete(key);
      return result;
    }).catch((err) => {
      this.inFlight.delete(key);
      throw err;
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}

const apiCache = new TTLCache<unknown>();

export function clearApiCache(): void {
  // Exposed for tests
  apiCache.clear();
}

/** Visible header prepended to every comment Claws posts so conversations read naturally. */
export const CLAWS_VISIBLE_HEADER = "*— Automated by Claws —*";

/** GitHub reaction used by review-addresser to mark comments as addressed. */
export const ADDRESSED_REACTION = "rocket";

/** Pattern to extract reviewed-commit SHA from a Claws PR review comment. */
const REVIEWED_COMMIT_PATTERN = /Reviewed commit: `([0-9a-f]+)`/;

/** Marker appended by review-addresser when review is addressed without code changes. */
export const REVIEW_ADDRESSED_MARKER = "review-addressed";
const REVIEW_ADDRESSED_PATTERN = /(?:<!-- )?review-addressed: ([0-9a-f]+)(?: -->)?/;

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
  | "needs-qa"
  | "problematic";

export const ALL_QUEUE_CATEGORIES: readonly QueueCategory[] = [
  "ready", "needs-refinement", "refined", "needs-review-addressing",
  "auto-mergeable", "needs-triage", "needs-qa", "problematic",
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
  reviewStatus?: "clean" | "issues" | "none";
  reviewIssueCount?: number;
}

const queueCache = new Map<string, { item: QueueItem; fetchedAt: number }>();

/** How long a queue cache entry is considered fresh. Entries older than this
 * are evicted on read. Longer than the slowest dispatcher interval (10 min
 * for qa-phase / ci-fixer / triage) so a single transient scan failure does
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

export function isDispatchSkippable(repoFullName: string, item: { number: number; labels: { name: string }[] }): boolean {
  return isItemSkipped(repoFullName, item.number) || hasIgnoreLabel(item.labels);
}

// gh CLI returns "app/<slug>" for GitHub App authors in `--json author` output,
// while the REST /app endpoint (used by getAppBotLogin) returns `<slug>[bot]`.
// Normalize to the `[bot]` form so comparisons work regardless of which API
// produced the login.
function normalizeBotLogin(login: string): string {
  if (login.startsWith("app/")) return `${login.slice("app/".length)}[bot]`;
  return login;
}

/** Returns true if the login is in the configured allowedActors list or is Claws' own login. */
export async function isAllowedActor(login: string): Promise<boolean> {
  const normalized = normalizeBotLogin(login);
  if (ALLOWED_ACTORS.includes(login) || ALLOWED_ACTORS.includes(normalized)) return true;
  const self = await getSelfLogin(SELF_REPO.split("/")[0]);
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
    `To retry after manual fixes, remove the \`${LABELS.problematic}\` label.`,
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

export async function isRepoPrivate(repo: string): Promise<boolean> {
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

  // Cooldown expired — notify once and clear
  if (rateLimitedUntil !== null) {
    rateLimitedUntil = null;
    log.info("[github] Rate limit cooldown expired — resuming API calls");
    notify("[INFO] GitHub API rate limit passed — resuming operations");
  }

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
      return TRANSIENT_RE.test(err.message) || (ghErr.stderr !== undefined && !ghErr.stderr.trim());
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

const SearchResultSchema = z.object({
  number: z.number(),
  title: z.string(),
});

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
});

const ReactionSchema = z.object({
  id: z.number(),
  user: AuthorSchema,
  content: z.string(),
});

const BranchPrSchema = z.object({
  number: z.number(),
  state: z.string(),
  mergedAt: z.string().optional(),
  closedAt: z.string().optional(),
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

// ── Issue search & creation ──

export async function searchIssues(
  repo: string,
  titleQuery: string,
): Promise<{ number: number; title: string }[]> {
  const raw = await gh([
    "search",
    "issues",
    "--repo",
    repo,
    "--state",
    "open",
    "--match",
    "title",
    "--json",
    "number,title",
    "--",
    titleQuery,
  ]);
  return safeJsonParse(z.array(SearchResultSchema), raw, "search issues");
}

// GitHub issue search is substring-based; narrow to an exact title match to avoid acting on a partially-matching issue.
export async function findIssueByExactTitle(
  repo: string,
  title: string,
): Promise<{ number: number; title: string } | null> {
  const results = await searchIssues(repo, title);
  return results.find((r) => r.title === title) ?? null;
}

export async function searchPRs(
  repo: string,
  titleQuery: string,
): Promise<{ number: number; title: string }[]> {
  const raw = await gh([
    "search",
    "prs",
    "--repo",
    repo,
    "--state",
    "open",
    "--match",
    "title",
    "--json",
    "number,title",
    "--",
    titleQuery,
  ]);
  return safeJsonParse(z.array(SearchResultSchema), raw, "search prs");
}

export async function createIssue(
  repo: string,
  title: string,
  body: string,
  labels: string[],
): Promise<number> {
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

export async function ensureLabel(repo: string, label: string): Promise<void> {
  try {
    const spec = LABEL_SPECS[label];
    const args = ["label", "create", label, "--repo", repo, "--force"];
    if (spec) {
      args.push("--color", spec.color, "--description", spec.description);
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
      try {
        await gh(["label", "create", label, "--repo", repo, "--force", "--color", spec.color, "--description", spec.description]);
      } catch (err) {
        log.warn(`ensureLabel ${label} on ${repo}: ${err}`);
      }
    }
  }
}

export async function listLabels(repo: string): Promise<string[]> {
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

export async function addLabel(repo: string, issueNumber: number, label: string): Promise<void> {
  await ensureLabel(repo, label);
  await gh(["issue", "edit", String(issueNumber), "--repo", repo, "--add-label", label]);
}

export async function removeLabel(repo: string, issueNumber: number, label: string): Promise<void> {
  try {
    await gh(["issue", "edit", String(issueNumber), "--repo", repo, "--remove-label", label]);
  } catch {
    // Label may not be present — ignore
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

export async function getIssueBody(repo: string, issueNumber: number): Promise<string> {
  const raw = await gh([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "body",
  ]);
  const parsed = safeJsonParse(z.object({ body: z.string() }), raw, "issue view");
  return parsed.body;
}

export async function getIssueBodyHtml(repo: string, issueNumber: number): Promise<string> {
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
  const header = opts?.agentName
    ? `*— Automated by Claws · ${opts.agentName} —*`
    : CLAWS_VISIBLE_HEADER;
  const fullBody = header + "\n\n" + body;
  await gh(["issue", "comment", String(issueNumber), "--repo", repo, "--body", fullBody]);
  apiCache.invalidate(`issue-comments:${repo}:${issueNumber}`);
}

export async function editIssue(repo: string, issueNumber: number, body: string): Promise<void> {
  await gh(["issue", "edit", String(issueNumber), "--repo", repo, "--body", body]);
}

export async function closeIssue(
  repo: string,
  issueNumber: number,
  stateReason?: "completed" | "not_planned",
): Promise<void> {
  const args = ["issue", "close", String(issueNumber), "--repo", repo];
  if (stateReason === "not_planned") args.push("--reason", "not planned");
  await gh(args);
}

export interface IssueComment {
  id: number;
  body: string;
  body_html: string;
  login: string;
}

export async function getIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]> {
  return apiCache.dedupedFetch(`issue-comments:${repo}:${issueNumber}`, 60_000, async () => {
    const raw = await gh([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
      "-H", "Accept: application/vnd.github.full+json",
    ]);
    const comments = safeJsonParse(z.array(IssueCommentRawSchema), raw, "issue comments");
    return comments.filter((c) => c.body.trim()).map((c) => ({ id: c.id, body: c.body, body_html: c.body_html ?? "", login: c.user.login }));
  }) as Promise<IssueComment[]>;
}

export async function editIssueComment(repo: string, commentId: number, body: string, opts?: { agentName?: string }): Promise<void> {
  const header = opts?.agentName
    ? `*— Automated by Claws · ${opts.agentName} —*`
    : CLAWS_VISIBLE_HEADER;
  const fullBody = header + "\n\n" + body;
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
  try {
    const url = (
      await gh(["pr", "create", "--repo", repo, "--head", head, "--title", title, "--body", body])
    ).trim();
    const match = url.match(/\/pull\/(\d+)$/);
    if (!match) throw new Error(`Could not parse PR number from: ${url}`);
    apiCache.invalidate(`pr-list:${repo}`);
    return Number(match[1]);
  } catch (err) {
    // Handle retry-induced duplicate: PR was created on a previous attempt
    // that succeeded server-side but returned a transient error to the client
    const existsMatch = String(err).match(
      /already exists:\s*https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/,
    );
    if (existsMatch) {
      log.warn(`createPR: PR already exists (#${existsMatch[1]}), likely from a retried request`);
      return Number(existsMatch[1]);
    }
    throw err;
  }
}

export async function listPRs(repo: string): Promise<PR[]> {
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
      "number,title,headRefName,baseRefName,labels,author,isCrossRepository,updatedAt",
    ]);
    return safeJsonParse(z.array(PrSchema), raw, "pr list");
  }) as Promise<PR[]>;
}

export async function listMergedPRsForIssue(repo: string, issueNumber: number): Promise<PR[]> {
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
  const prs = await listPRs(repo);
  const branchPrefix = `claws/issue-${issueNumber}-`;
  return prs.find((pr) => pr.headRefName.startsWith(branchPrefix)) ?? null;
}

export async function getPRMergeableState(
  repo: string,
  prNumber: number,
  maxAttempts = 5,
  delayMs = 3000,
): Promise<"MERGEABLE" | "CONFLICTING" | "UNKNOWN"> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const raw = await gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "mergeable"]);
    const parsed = safeJsonParse(z.object({ mergeable: z.string() }), raw, "pr view");
    const state = parsed.mergeable as "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
    if (state !== "UNKNOWN") return state;
    if (attempt < maxAttempts - 1) await sleep(delayMs);
  }
  return "UNKNOWN";
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

const PASSING_STATES = new Set(["SUCCESS", "SKIPPED"]);

export async function getPRCheckStatus(
  repo: string,
  prNumber: number,
): Promise<"passing" | "failing" | "pending" | "none"> {
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

export async function getPRReviewStatus(
  repo: string,
  prNumber: number,
): Promise<{ status: "clean" | "issues" | "none"; issueCount: number }> {
  return apiCache.dedupedFetch(`pr-review-status:${repo}:${prNumber}`, 60_000, async () => {
    try {
      const comments = await getIssueComments(repo, prNumber);
      let latest: { body: string } | null = null;
      for (const c of comments) {
        if (isClawsComment(c.body) && c.body.includes(REVIEW_HEADER_TEXT)) latest = { body: c.body };
      }
      if (!latest) return { status: "none" as const, issueCount: 0 };
      if (latest.body.includes(REVIEW_CLEAN_MARKER)) return { status: "clean" as const, issueCount: 0 };

      const stripped = stripClawsMarker(latest.body)
        .replace(/## PR Review\s*/, "")
        .replace(/\*Review #\d+\*\s*/, "")
        .replace(/Reviewed commit: `[0-9a-f]+`/, "")
        .replace(/(?:<!-- )?review-iteration: \d+(?: -->)?/g, "")
        .replace(/<details>[\s\S]*?<\/details>/g, "")
        .trim();
      if (!stripped || /^Reviewed\s*—\s*no issues found\.?$/i.test(stripped)) {
        return { status: "clean" as const, issueCount: 0 };
      }
      const numbered = (stripped.match(/^\s*\d+\.\s/gm) ?? []).length;
      const headings = (stripped.match(/^#{2,4}\s+\S/gm) ?? []).length;
      const issueCount = numbered > 0 ? numbered : headings;
      return { status: "issues" as const, issueCount };
    } catch {
      return { status: "none" as const, issueCount: 0 };
    }
  }) as Promise<{ status: "clean" | "issues" | "none"; issueCount: number }>;
}

export async function updatePR(repo: string, prNumber: number, body: string, title?: string): Promise<void> {
  const args = ["pr", "edit", "--repo", repo, String(prNumber), "--body", body];
  if (title) args.push("--title", title);
  await gh(args);
}

export async function mergePR(repo: string, prNumber: number): Promise<void> {
  await gh(["pr", "merge", String(prNumber), "--repo", repo, "--squash"]);
}

// ── Reactions ──

export async function addReaction(repo: string, commentId: number, reaction: string): Promise<void> {
  try {
    await gh(["api", `repos/${repo}/issues/comments/${commentId}/reactions`, "-f", `content=${reaction}`]);
  } catch (err) {
    log.warn(`addReaction on comment ${commentId} in ${repo}: ${err}`);
  }
}

export async function addReviewCommentReaction(repo: string, commentId: number, reaction: string): Promise<void> {
  try {
    await gh(["api", `repos/${repo}/pulls/comments/${commentId}/reactions`, "-f", `content=${reaction}`]);
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
  return apiCache.dedupedFetch(`comment-reactions:${repo}:${commentId}`, 60_000, async () => {
    const raw = await gh(["api", `repos/${repo}/issues/comments/${commentId}/reactions`]);
    return safeJsonParse(z.array(ReactionSchema), raw, "comment reactions");
  }) as Promise<Reaction[]>;
}

export async function listCompareCommits(
  repo: string,
  base: string,
  head: string,
): Promise<{ sha: string; subject: string }[]> {
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
}

export async function getPRReviewComments(repo: string, prNumber: number): Promise<PRReviewData> {
  const empty: PRReviewData = { formatted: "", commentIds: [], reviewCommentIds: [], htmlBodies: [], prReviewComment: undefined };
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

    // Check which inline comments already have a 🚀 from Claws (addressed)
    for (const comment of comments) {
      let hasClawsAddressed = false;
      try {
        const reactionsRaw = await gh(["api", `repos/${repo}/pulls/comments/${comment.id}/reactions`]);
        const reactions = safeJsonParse(z.array(ReactionSchema), reactionsRaw, "pr review comment reactions");
        hasClawsAddressed = reactions.some((r) => r.user.login === selfLogin && r.content === ADDRESSED_REACTION);
      } catch { /* treat as no reaction */ }
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

          // Skip clean reviews — no work for the addresser
          if (comment.body.includes(REVIEW_CLEAN_MARKER)) continue;

          const stripped = stripClawsMarker(comment.body);
          const cleanedReviewBody = stripped
            .replace(/## PR Review\s*/, "")
            .replace(REVIEWED_COMMIT_PATTERN, "")
            .replace(REVIEW_ADDRESSED_PATTERN, "")
            .replace(/(?:<!-- )?review-iteration: \d+(?: -->)?/g, "")
            .replace(/\*Review #\d+\*\s*/, "")
            .replace(/###?\s+Review of PR\s*#?\s*\d*\s*/g, "")
            .trim();
          const isCleanReview =
            !cleanedReviewBody ||
            /^Reviewed\s*—\s*no issues found\.?$/i.test(cleanedReviewBody) ||
            /^This PR has no net changes/i.test(cleanedReviewBody);

          if (!isCleanReview) {
            clawsReviewParts.push(`Comment by @${comment.user.login} (automated by Claws):\n${stripped}`);
            if (comment.body_html) htmlBodies.push(comment.body_html);
            prReviewComment = {
              id: comment.id,
              body: comment.body,
              reviewedCommit: commitMatch ? commitMatch[1] : "",
            };
          }
          continue;
        }

        // Non-review Claws comments: rocket-based addressing check
        let hasClawsAddressed = false;
        let hasHumanApproval = false;
        try {
          const reactions = await getCommentReactions(repo, comment.id);
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
        const reactions = await getCommentReactions(repo, comment.id);
        hasClawsAddressed = reactions.some((r) => r.user.login === selfLogin && r.content === ADDRESSED_REACTION);
      } catch { /* treat as no reaction */ }
      if (hasClawsAddressed) continue;

      humanParts.push(`Comment by @${comment.user.login}:\n${guardContent(comment.body, guardCtx("review-comments"))}`);
      if (comment.body_html) htmlBodies.push(comment.body_html);
      commentIds.push(comment.id);
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
    };
  } catch (err) {
    log.warn(`getPRReviewComments for PR #${prNumber} in ${repo}: ${err}`);
    return empty;
  }
}

export interface FailedCheck {
  name: string;
  state: string;
  link: string;
}

export async function getFailingCheck(repo: string, prNumber: number): Promise<FailedCheck | undefined> {
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
  await gh(["run", "rerun", runId, "--repo", repo]);
}

/**
 * Cancels a GitHub Actions workflow run.
 * @param repo - The full repository name (e.g., "owner/repo")
 * @param runId - The workflow run ID (numeric string)
 * @throws Error if the run is already completed or if GitHub CLI fails
 */
export async function cancelWorkflow(repo: string, runId: string): Promise<void> {
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

export async function getPRChangedFiles(repo: string, prNumber: number): Promise<string[]> {
  try {
    const raw = await gh(["pr", "diff", String(prNumber), "--repo", repo, "--name-only"]);
    return raw.split("\n").filter(Boolean);
  } catch (err) {
    log.warn(`getPRChangedFiles for PR #${prNumber} in ${repo}: ${err}`);
    return [];
  }
}

export async function getPRDiff(repo: string, prNumber: number): Promise<string> {
  try {
    return await gh(["pr", "diff", String(prNumber), "--repo", repo]);
  } catch (err) {
    log.warn(`getPRDiff for PR #${prNumber} in ${repo}: ${err}`);
    return "";
  }
}

// ── Deployment URL discovery (for QA phase) ──

export async function getPRHeadSHA(repo: string, prNumber: number): Promise<string> {
  const raw = await gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "headRefOid", "--jq", ".headRefOid"]);
  return raw.trim();
}

export async function getPRBody(repo: string, prNumber: number): Promise<string> {
  const raw = await gh(["pr", "view", String(prNumber), "--repo", repo, "--json", "body", "--jq", ".body"]);
  return raw.trim();
}

export async function getDeploymentUrl(repo: string, sha: string, prNumber: number): Promise<string | null> {
  // Primary: GitHub Deployments API
  try {
    const raw = await gh(["api", `repos/${repo}/deployments?sha=${sha}&environment=Preview`]);
    const deployments = safeJsonParse(
      z.array(z.object({ id: z.number(), environment: z.string() })),
      raw,
      "deployments",
    );
    for (const dep of deployments) {
      const statusesRaw = await gh(["api", `repos/${repo}/deployments/${dep.id}/statuses`]);
      const statuses = safeJsonParse(
        z.array(z.object({ state: z.string(), environment_url: z.string().optional() })),
        statusesRaw,
        "deployment statuses",
      );
      const success = statuses.find((s) => s.state === "success" && s.environment_url);
      if (success?.environment_url) return success.environment_url;
    }
  } catch {
    // Fall through to comment scanning
  }

  // Fallback: scan PR comments for Vercel preview URLs
  try {
    const comments = await getIssueComments(repo, prNumber);
    const vercelRe = /https:\/\/[a-z0-9-]+\.vercel\.app/i;
    for (const comment of comments) {
      const match = comment.body.match(vercelRe);
      if (match) return match[0];
    }
  } catch {
    // No URL found
  }

  return null;
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
  since: Date,
): Promise<{ number: number; title: string; body: string; closedAt: string }[]> {
  const raw = await gh([
    "issue", "list",
    "--repo", repo,
    "--state", "closed",
    "--limit", "100",
    "--json", "number,title,body,closedAt",
  ]);
  const issues = safeJsonParse(
    z.array(z.object({
      number: z.number(),
      title: z.string(),
      body: z.string(),
      closedAt: z.string(),
    })),
    raw,
    "issue list closed",
  );
  return issues.filter((i) => new Date(i.closedAt) >= since);
}

// ── Branch cleanup helpers ──

export interface BranchPR {
  number: number;
  state: string;
  mergedAt?: string;
  closedAt?: string;
}

export async function listPRsForBranch(
  repo: string,
  branchName: string,
  state: "open" | "merged" | "closed" | "all",
): Promise<BranchPR[]> {
  const raw = await gh([
    "pr", "list",
    "--repo", repo,
    "--head", branchName,
    "--state", state,
    "--json", "number,state,mergedAt,closedAt",
  ]);
  return safeJsonParse(z.array(BranchPrSchema), raw, "pr list for branch");
}

export async function deleteRemoteBranch(repo: string, branchName: string): Promise<void> {
  await gh(["api", "--method", "DELETE", `repos/${repo}/git/refs/heads/${branchName}`]);
}

async function getPRMetadata(
  repo: string,
  prNumber: number,
): Promise<{ labels: string[]; mergeableState: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" }> {
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
        const [sum, meta, rev] = await Promise.all([
          getPRChecksSummary(item.repo, item.number),
          getPRMetadata(item.repo, item.number),
          getPRReviewStatus(item.repo, item.number),
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
      } else if (item.type === "issue") {
        const pr = await getOpenPRForIssue(item.repo, item.number);
        if (pr) {
          item.prNumber = pr.number;
          const [sum, meta, rev] = await Promise.all([
            getPRChecksSummary(item.repo, pr.number),
            getPRMetadata(item.repo, pr.number),
            getPRReviewStatus(item.repo, pr.number),
          ]);
          if (sum.status !== "none") {
            item.checkStatus = sum.status;
            item.checksPassed = sum.passed;
            item.checksTotal = sum.total;
          }
          item.mergeableState = meta.mergeableState;
          item.reviewStatus = rev.status;
          if (rev.status === "issues") item.reviewIssueCount = rev.issueCount;
        }
      }
    } catch {
      // Graceful degradation — item renders without status
    }
  });
  await Promise.allSettled(tasks);
}

// ── Workflow run fetching (runner metrics) ──

const WORKFLOW_RUN_JQ = '[.workflow_runs[] | {run_id: .id, workflow_name: .name, status: .status, conclusion: .conclusion, event: .event, head_branch: .head_branch, created_at: .created_at, run_started_at: .run_started_at, updated_at: .updated_at}]';
const WORKFLOW_RUN_SINGLE_JQ = '{run_id: .id, workflow_name: .name, status: .status, conclusion: .conclusion, event: .event, head_branch: .head_branch, created_at: .created_at, run_started_at: .run_started_at, updated_at: .updated_at}';

async function fetchWorkflowRuns(repo: string, params: string): Promise<WorkflowRunRow[]> {
  try {
    const raw = await gh(["api", `repos/${repo}/actions/runs?${params}`, "--jq", WORKFLOW_RUN_JQ]);
    const parsed = safeJsonParse(z.array(WorkflowRunSchema), raw, `workflow runs for ${repo}`);
    return parsed.map(r => ({ ...r, repo }));
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
  const allRuns: WorkflowRunRow[] = [];
  for (let i = 0; i < repos.length; i += concurrency) {
    const batch = repos.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map(perRepo));
    for (const result of results) {
      if (result.status === "fulfilled") {
        allRuns.push(...result.value);
      }
    }
  }
  return allRuns;
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
}

export async function listOpenDependabotAlerts(repo: string): Promise<DependabotAlert[]> {
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
  }));
}

export async function dismissDependabotAlert(
  repo: string,
  number: number,
  reason: string,
  comment: string,
): Promise<void> {
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

