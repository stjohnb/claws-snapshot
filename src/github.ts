import { execFile } from "node:child_process";
import { GITHUB_OWNERS, LABELS, LABEL_SPECS, SKIPPED_ITEMS, PRIORITIZED_ITEMS, type Repo } from "./config.js";
import * as log from "./log.js";
import { notify } from "./slack.js";
import { reportError } from "./error-reporter.js";

const RATE_LIMIT_RE = /rate limit/i;
const TRANSIENT_RE = /\b(400|500|502|503|504|ETIMEDOUT|ECONNRESET|ECONNREFUSED|connection reset)\b|Could not resolve to a|TLS handshake timeout|Something went wrong/i;
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
  log.warn(`[github] Rate limit detected — blocking API calls for ${cooldownMs / 1000}s`);
  notify(`[WARN] GitHub API rate limit hit — blocking calls for ${cooldownMs / 1000}s`);
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
}

const apiCache = new TTLCache<unknown>();

export function clearApiCache(): void {
  // Exposed for tests
  (apiCache as any).cache.clear();
  (apiCache as any).inFlight.clear();
}

/** Hidden HTML comment appended to every comment Claws posts, used to filter out its own comments. */
export const CLAWS_COMMENT_MARKER = "<!-- claws-automated -->";

/** Visible header prepended to every comment Claws posts so conversations read naturally. */
export const CLAWS_VISIBLE_HEADER = "*— Automated by Claws —*";

/** Previous visible header — kept for backward compatibility with old comments. */
const LEGACY_VISIBLE_HEADER = "*— Automated by CLAWS —*";

/** Check whether a comment body was posted by Claws. */
export function isClawsComment(body: string): boolean {
  return body.includes(CLAWS_COMMENT_MARKER);
}

/** Strip the hidden Claws marker and visible header from a comment body. */
export function stripClawsMarker(body: string): string {
  return body.replace(CLAWS_COMMENT_MARKER, "").replace(CLAWS_VISIBLE_HEADER, "").replace(LEGACY_VISIBLE_HEADER, "").trim();
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
  | "needs-triage";

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
}

const queueCache = new Map<string, { item: QueueItem; fetchedAt: number }>();

export function isItemSkipped(repo: string, number: number): boolean {
  return SKIPPED_ITEMS.some((i) => i.repo === repo && i.number === number);
}

export function isItemPrioritized(repo: string, number: number): boolean {
  return PRIORITIZED_ITEMS.some((i) => i.repo === repo && i.number === number);
}

export function hasPriorityLabel(labels: { name: string }[]): boolean {
  return labels.some((l) => l.name === LABELS.priority);
}

export function removeQueueItem(repo: string, number: number): void {
  for (const key of queueCache.keys()) {
    if (key.endsWith(`:${repo}:${number}`)) queueCache.delete(key);
  }
}

export function populateQueueCache(category: QueueCategory, repo: string, item: { number: number; title: string; type: "issue" | "pr"; updatedAt?: string; priority?: boolean }): void {
  if (isItemSkipped(repo, item.number)) return;
  const key = `${category}:${repo}:${item.number}`;
  queueCache.set(key, {
    item: {
      repo,
      number: item.number,
      title: item.title,
      category,
      updatedAt: item.updatedAt ?? "",
      type: item.type,
      prioritized: isItemPrioritized(repo, item.number) || item.priority === true,
    },
    fetchedAt: Date.now(),
  });
}

export function getQueueSnapshot(categories: QueueCategory[]): { items: QueueItem[]; oldestFetchAt: number | null } {
  const seen = new Set<string>();
  const items: QueueItem[] = [];
  let oldestFetchAt: number | null = null;
  const catSet = new Set(categories);

  for (const [, entry] of queueCache) {
    if (!catSet.has(entry.item.category)) continue;
    if (oldestFetchAt === null || entry.fetchedAt < oldestFetchAt) {
      oldestFetchAt = entry.fetchedAt;
    }
    const dedup = `${entry.item.repo}:${entry.item.number}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    items.push({ ...entry.item });
  }

  items.sort((a, b) => {
    // Prioritized items first
    if (a.prioritized && !b.prioritized) return -1;
    if (!a.prioritized && b.prioritized) return 1;
    return (b.updatedAt || "").localeCompare(a.updatedAt || "");
  });
  return { items, oldestFetchAt };
}

export function clearQueueCache(): void {
  queueCache.clear();
}

let _selfLogin: string | null = null;

export function clearSelfLoginCache(): void {
  _selfLogin = null;
}

export async function getSelfLogin(): Promise<string> {
  if (!_selfLogin) {
    const raw = await gh(["api", "user", "--jq", ".login"]);
    _selfLogin = raw.trim();
  }
  return _selfLogin;
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

  return new Promise((resolve, reject) => {
    let attempt = 0;

    function run() {
      execFile("gh", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const msg = stderr || err.message;

          // Rate limit — trip circuit breaker, reject immediately (no retry)
          if (RATE_LIMIT_RE.test(msg)) {
            setRateLimited();
            reject(new RateLimitError(`gh ${args.join(" ")} failed: ${msg}`));
            return;
          }

          // Transient errors — retry with exponential backoff
          const isTransient = TRANSIENT_RE.test(msg) || !stderr.trim();
          if (attempt < MAX_RETRIES && isTransient) {
            attempt++;
            const delay = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s
            log.warn(`gh ${args[0]} transient error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms`);
            setTimeout(run, delay);
            return;
          }
          reject(new Error(`gh ${args.join(" ")} failed: ${msg}`));
        } else {
          resolve(stdout);
        }
      });
    }

    run();
  });
}

function safeJsonParse<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Failed to parse JSON from gh ${context}: ${raw.slice(0, 200)}`);
  }
}

function ghJson<T>(args: string[]): Promise<T> {
  return gh([...args, "--json"]).then((out) => safeJsonParse<T>(out, args[0]));
}

// ── Repo discovery ──

interface GhRepoEntry {
  nameWithOwner: string;
  name: string;
  owner: { login: string };
  defaultBranchRef: { name: string } | null;
  isArchived: boolean;
}

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
      const raw = await gh([
        "repo",
        "list",
        owner,
        "--no-archived",
        "--source",
        "--limit",
        "200",
        "--json",
        "nameWithOwner,name,owner,defaultBranchRef,isArchived",
      ]);
      const entries: GhRepoEntry[] = safeJsonParse(raw, "repo list");
      for (const e of entries) {
        repos.push({
          owner: e.owner.login,
          name: e.name,
          fullName: e.nameWithOwner,
          defaultBranch: e.defaultBranchRef?.name ?? "main",
        });
      }
    } catch (err) {
      reportError("github:list-repos", owner, err);
    }
  }

  return repos;
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
  return safeJsonParse(raw, "search issues") as { number: number; title: string }[];
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
  return safeJsonParse(raw, "search prs") as { number: number; title: string }[];
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
      "--json", "number,title,body,labels,updatedAt",
    ]);
    return safeJsonParse(raw, "issue list") as Issue[];
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
  const labels = safeJsonParse(raw, "label list") as { name: string }[];
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
      "number,title,body,labels,updatedAt",
    ]);
    return safeJsonParse(raw, "issue list by label") as Issue[];
  }) as Promise<Issue[]>;
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
  const parsed = safeJsonParse(raw, "issue view") as { body: string };
  return parsed.body;
}

export async function commentOnIssue(repo: string, issueNumber: number, body: string): Promise<void> {
  const fullBody = CLAWS_VISIBLE_HEADER + "\n\n" + body + "\n" + CLAWS_COMMENT_MARKER;
  await gh(["issue", "comment", String(issueNumber), "--repo", repo, "--body", fullBody]);
  apiCache.invalidate(`issue-comments:${repo}:${issueNumber}`);
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
  login: string;
}

export async function getIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]> {
  return apiCache.dedupedFetch(`issue-comments:${repo}:${issueNumber}`, 60_000, async () => {
    const raw = await gh([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
    ]);
    const comments = safeJsonParse(raw, "issue comments") as { id: number; body: string; user: { login: string } }[];
    return comments.filter((c) => c.body.trim()).map((c) => ({ id: c.id, body: c.body, login: c.user.login }));
  }) as Promise<IssueComment[]>;
}

export async function editIssueComment(repo: string, commentId: number, body: string): Promise<void> {
  const fullBody = CLAWS_VISIBLE_HEADER + "\n\n" + body + "\n" + CLAWS_COMMENT_MARKER;
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
      "number,title,headRefName,baseRefName,labels,author",
    ]);
    return safeJsonParse(raw, "pr list") as PR[];
  }) as Promise<PR[]>;
}

export async function listMergedPRsForIssue(repo: string, issueNumber: number): Promise<PR[]> {
  const raw = await gh([
    "pr", "list",
    "--repo", repo,
    "--state", "merged",
    "--search", String(issueNumber),
    "--limit", "100",
    "--json", "number,title,headRefName,baseRefName,labels,author,body",
  ]);
  const prs = safeJsonParse(raw, "pr list merged") as PR[];
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
): Promise<"MERGEABLE" | "CONFLICTING" | "UNKNOWN"> {
  const raw = await gh([
    "pr", "view", String(prNumber),
    "--repo", repo,
    "--json", "mergeable",
  ]);
  const parsed = safeJsonParse(raw, "pr view") as { mergeable: string };
  return parsed.mergeable as "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
}

// ── Checks ──

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string;
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
      if (err instanceof Error && /no checks reported/i.test(err.message)) {
        return "none";
      }
      throw err;
    }
    const checks = JSON.parse(raw) as { name: string; state: string }[];
    if (checks.some((c) => FAILED_STATES.has(c.state))) return "failing";
    if (checks.length > 0 && checks.every((c) => PASSING_STATES.has(c.state))) return "passing";
    if (checks.length === 0) return "none";
    return "pending";
  }) as Promise<"passing" | "failing" | "pending" | "none">;
}

export async function prChecksFailing(repo: string, prNumber: number): Promise<boolean> {
  try {
    return (await getPRCheckStatus(repo, prNumber)) === "failing";
  } catch {
    return false;
  }
}

export async function prChecksPassing(repo: string, prNumber: number): Promise<boolean> {
  try {
    return (await getPRCheckStatus(repo, prNumber)) === "passing";
  } catch {
    return false;
  }
}

export async function updatePRBody(repo: string, prNumber: number, body: string): Promise<void> {
  await gh(["pr", "edit", "--repo", repo, String(prNumber), "--body", body]);
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
  user: { login: string };
  content: string;
}

export async function getCommentReactions(repo: string, commentId: number): Promise<Reaction[]> {
  return apiCache.dedupedFetch(`comment-reactions:${repo}:${commentId}`, 60_000, async () => {
    const raw = await gh(["api", `repos/${repo}/issues/comments/${commentId}/reactions`]);
    return safeJsonParse(raw, "comment reactions") as Reaction[];
  }) as Promise<Reaction[]>;
}

export async function getPRReviewDecision(repo: string, prNumber: number): Promise<string> {
  const raw = await gh(["pr", "view", "--repo", repo, String(prNumber), "--json", "reviewDecision"]);
  const parsed = safeJsonParse(raw, "pr review decision") as { reviewDecision: string };
  return parsed.reviewDecision ?? "";
}

export async function getPRLatestCommitDate(repo: string, prNumber: number): Promise<string> {
  const raw = await gh([
    "api",
    `repos/${repo}/pulls/${prNumber}/commits`,
    "--jq", ".[-1].commit.committer.date",
  ]);
  return raw.trim();
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
  const commitsRaw = await gh([
    "api",
    `repos/${repo}/pulls/${prNumber}/commits`,
    "--paginate",
  ]);

  const commits = safeJsonParse(commitsRaw, "pr commits for LGTM") as {
    commit: { message: string; committer: { date: string } };
    parents: { sha: string }[];
  }[];

  const nonMergeCommits = commits.filter(
    (c) => !isMergeFromBase({ message: c.commit.message, parents: c.parents }, baseBranch),
  );

  const raw = await gh([
    "api",
    `repos/${repo}/issues/${prNumber}/comments`,
    "--paginate",
  ]);
  const comments = safeJsonParse(raw, "issue comments for LGTM") as {
    body: string;
    user: { login: string };
    created_at: string;
  }[];

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
    const data = JSON.parse(raw);
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
}

export async function getPRReviewComments(repo: string, prNumber: number): Promise<PRReviewData> {
  const empty: PRReviewData = { formatted: "", commentIds: [], reviewCommentIds: [] };
  try {
    const selfLogin = await getSelfLogin();

    // Fetch reviews (top-level review bodies with their status)
    const reviewsRaw = await gh([
      "api",
      `repos/${repo}/pulls/${prNumber}/reviews`,
      "--paginate",
    ]);
    const reviews = JSON.parse(reviewsRaw) as {
      user: { login: string };
      state: string;
      body: string;
    }[];

    // Fetch inline review comments (comments on specific code lines)
    const commentsRaw = await gh([
      "api",
      `repos/${repo}/pulls/${prNumber}/comments`,
      "--paginate",
    ]);
    const allComments = JSON.parse(commentsRaw) as {
      id: number;
      user: { login: string };
      path: string;
      line: number | null;
      body: string;
      diff_hunk: string;
    }[];

    // Filter out comments that belong to resolved review threads.
    const resolvedIds = await getResolvedCommentIds(repo, prNumber);
    const comments = allComments.filter((c) => !resolvedIds.has(c.id));

    // Fetch general PR comments (issue comments on the conversation tab)
    const issueCommentsRaw = await gh([
      "api",
      `repos/${repo}/issues/${prNumber}/comments`,
      "--paginate",
    ]);
    const issueComments = JSON.parse(issueCommentsRaw) as {
      id: number;
      user: { login: string };
      body: string;
    }[];

    const parts: string[] = [];
    const commentIds: number[] = [];
    const reviewCommentIds: number[] = [];

    // Add review bodies that have content
    for (const review of reviews) {
      if (review.body?.trim()) {
        parts.push(`Review by @${review.user.login} (${review.state}):\n${review.body}`);
      }
    }

    // Check which inline comments already have a 👍 from Claws
    for (const comment of comments) {
      // Check for existing 👍 reaction from Claws
      let hasClawsReaction = false;
      try {
        const reactionsRaw = await gh(["api", `repos/${repo}/pulls/comments/${comment.id}/reactions`]);
        const reactions = JSON.parse(reactionsRaw) as Reaction[];
        hasClawsReaction = reactions.some((r) => r.user.login === selfLogin && r.content === "+1");
      } catch { /* treat as no reaction */ }
      if (hasClawsReaction) continue;

      const location = comment.line ? `${comment.path}:${comment.line}` : comment.path;
      parts.push(
        `Inline comment by @${comment.user.login} on ${location}:\n` +
          `\`\`\`\n${comment.diff_hunk}\n\`\`\`\n${comment.body}`,
      );
      reviewCommentIds.push(comment.id);
    }

    // Add non-Claws, non-bot issue-tab comments without 👍 from Claws
    for (const comment of issueComments) {
      if (!comment.body?.trim()) continue;
      if (comment.body.trim().toUpperCase() === "LGTM") continue;
      if (isClawsComment(comment.body)) {
        parts.push(`Comment by @${comment.user.login} (automated by Claws):\n${stripClawsMarker(comment.body)}`);
        continue;
      }
      if (comment.user.login.endsWith("[bot]")) continue;

      // Check for existing 👍 reaction from Claws
      let hasClawsReaction = false;
      try {
        const reactions = await getCommentReactions(repo, comment.id);
        hasClawsReaction = reactions.some((r) => r.user.login === selfLogin && r.content === "+1");
      } catch { /* treat as no reaction */ }
      if (hasClawsReaction) continue;

      parts.push(`Comment by @${comment.user.login}:\n${comment.body}`);
      commentIds.push(comment.id);
    }

    return {
      formatted: parts.join("\n\n---\n\n"),
      commentIds,
      reviewCommentIds,
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
    const checks = JSON.parse(raw) as FailedCheck[];
    return checks.find((c) => FAILED_STATES.has(c.state));
  } catch {
    return undefined;
  }
}

export async function rerunWorkflow(repo: string, runId: string): Promise<void> {
  await gh(["run", "rerun", runId, "--repo", repo]);
}

async function getFailedJobLog(repo: string, runId: string): Promise<string> {
  const raw = await gh(["api", `repos/${repo}/actions/runs/${runId}/jobs`]);
  const { jobs } = JSON.parse(raw) as {
    jobs: { id: number; conclusion: string | null; name: string }[];
  };
  const failedJob = jobs.find((j) => j.conclusion === "failure");
  if (!failedJob) return "";

  const logOutput = await gh([
    "api", `repos/${repo}/actions/jobs/${failedJob.id}/logs`,
  ]);
  return logOutput.slice(0, 20_000);
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
    const checks = JSON.parse(raw) as { name: string; state: string; link: string }[];
    const failed = checks.find((c) => FAILED_STATES.has(c.state));
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
  const issues = safeJsonParse(raw, "issue list closed") as {
    number: number; title: string; body: string; closedAt: string;
  }[];
  return issues.filter((i) => new Date(i.closedAt) >= since);
}

export async function enrichQueueItemsWithPRStatus(items: QueueItem[]): Promise<void> {
  const tasks = items.map(async (item) => {
    try {
      if (item.type === "pr") {
        item.prNumber = item.number;
        const s = await getPRCheckStatus(item.repo, item.number);
        if (s !== "none") item.checkStatus = s;
      } else if (item.type === "issue") {
        const pr = await getOpenPRForIssue(item.repo, item.number);
        if (pr) {
          item.prNumber = pr.number;
          const s = await getPRCheckStatus(item.repo, pr.number);
          if (s !== "none") item.checkStatus = s;
        }
      }
    } catch {
      // Graceful degradation — item renders without status
    }
  });
  await Promise.allSettled(tasks);
}
