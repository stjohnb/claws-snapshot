/**
 * Forgejo API client — the non-GitHub half of Claws' forge access.
 *
 * Forgejo speaks the Gitea 1.22 REST API at `${FORGEJO_BASE_URL}/api/v1`, so
 * every call here is a plain `fetch` with an `Authorization: token …` header.
 * That is NOT a violation of the "all GitHub API access goes through
 * src/github.ts" rule — this host is not GitHub and `gh` cannot talk to it.
 *
 * Every exported function mirrors the return shape of its `src/github.ts`
 * namesake exactly (gh-CLI camelCase, not Gitea snake_case), so github.ts can
 * route a Forgejo repo with a two-line guard at the top of each function and
 * every caller — dispatchers, agents, scanners, dashboard — stays unchanged.
 *
 * Two hard rules:
 *  - This module must never value-import `./github.js`. github.ts value-imports
 *    *this* module to route, so the cycle would race module initialisation.
 *    Type-only imports are erased and therefore fine; the handful of pure
 *    helpers and marker literals needed here are duplicated below, exactly as
 *    github.ts already duplicates pr-reviewer's markers for the same reason.
 *  - This module must never touch the rate-limit breaker in `./rate-limit.js`.
 *    That breaker is process-global and GitHub's; a GitHub rate limit must not
 *    stop Claws working on a Forgejo repo.
 */

import { z } from "zod";
import { ALLOWED_ACTORS, FORGEJO_BASE_URL, FORGEJO_TOKEN, LABELS, LABEL_SPECS } from "./config.js";
import * as log from "./log.js";
import { guardContent, makeGuardCtx } from "./prompt-guard.js";
import { retryWithBackoff } from "./retry.js";
import { TTLCache } from "./ttl-cache.js";
import { mapSettledWithConcurrency, sleep } from "./util.js";
import type {
  BranchPR,
  CrossRefPR,
  FailedCheck,
  Issue,
  IssueComment,
  PR,
  PRMergeGate,
  PRReviewData,
  PRReviewNote,
  Reaction,
  ReleaseInfo,
  RepoDirEntry,
  RunJobSummary,
  UpstreamPRStatus,
} from "./github.js";

// ── HTTP plumbing ──

const FORGEJO_MAX_RETRIES = 3;
/** Gitea caps `limit` server-side; 50 is well inside every deployment's cap. */
const PAGE_LIMIT = 50;
/** Bound on forgejoGetAll so a runaway list can't spin forever. */
const MAX_PAGES = 20;

function apiBase(): string {
  // Read the live config binding inside the call so reloadConfig takes effect.
  return `${FORGEJO_BASE_URL.replace(/\/+$/, "")}/api/v1`;
}

function requireToken(): string {
  const token = FORGEJO_TOKEN;
  if (!token || !token.trim()) {
    throw new Error("forgejo: no access token configured — set forgejoToken in config.json or CLAWS_FORGEJO_TOKEN");
  }
  return token;
}

/**
 * True when a Forgejo access token is configured. Forgejo is an optional
 * integration: with no token every call throws from requireToken(), so callers
 * that enumerate Forgejo repos on a timer must skip rather than fail and file a
 * recurring alert issue for a static misconfiguration (#2670).
 */
export function isConfigured(): boolean {
  return !!(FORGEJO_TOKEN && FORGEJO_TOKEN.trim());
}

/** HTTP status carried on a forgejo error, or undefined for a network-level failure. */
function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

/** True when the error is a 404/403 — "this thing does not exist / is not visible". */
function isMissing(err: unknown): boolean {
  const status = statusOf(err);
  return status === 404 || status === 403;
}

/**
 * Retry eligibility. A network-level failure carries no status at all; a 5xx is
 * the server having a bad moment. Everything else (4xx) is a real answer.
 */
function isTransientForgejoError(err: Error): boolean {
  const status = statusOf(err);
  if (status === undefined) return true;
  return status >= 500;
}

/**
 * Issue one authenticated request, returning the raw response text. The thrown
 * message is prefixed `forgejo ` so error-reporter classifies it alongside the
 * `gh …`/`git …` subprocess failures.
 */
async function forgejoRequest(
  method: string,
  path: string,
  body?: unknown,
  opts: { accept?: string } = {},
): Promise<string> {
  const token = requireToken();
  return retryWithBackoff(
    async () => {
      let res: Response;
      try {
        res = await fetch(`${apiBase()}${path}`, {
          method,
          headers: {
            Authorization: `token ${token}`,
            Accept: opts.accept ?? "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (err) {
        // No status: DNS, TLS, connection reset. Transient by definition.
        throw new Error(`forgejo ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw Object.assign(
          new Error(`forgejo ${method} ${path} failed: HTTP ${res.status}: ${text.slice(0, 300)}`),
          { status: res.status },
        );
      }
      return res.text();
    },
    FORGEJO_MAX_RETRIES,
    isTransientForgejoError,
    `forgejo ${method} ${path}`,
  );
}

function parseForgejo<T>(schema: z.ZodType<T>, raw: string, context: string): T {
  const trimmed = raw.trim();
  let parsed: unknown;
  try {
    parsed = trimmed === "" ? null : JSON.parse(trimmed);
  } catch {
    throw new Error(`forgejo: failed to parse JSON from ${context}: ${raw.slice(0, 200)}`);
  }
  try {
    return schema.parse(parsed);
  } catch (e) {
    if (e instanceof z.ZodError) throw new Error(`forgejo: unexpected shape from ${context}: ${e.message}`);
    throw e;
  }
}

/** GET/POST/PATCH/DELETE a JSON endpoint and validate the response. */
async function forgejoFetch<T>(
  schema: z.ZodType<T>,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return parseForgejo(schema, await forgejoRequest(method, path, body), `${method} ${path}`);
}

/** Fire a mutation whose response body we do not care about. */
async function forgejoSend(method: string, path: string, body?: unknown): Promise<void> {
  await forgejoRequest(method, path, body);
}

/**
 * Page through a list endpoint until a short page arrives. Gitea's default page
 * size is small and silently truncates — perudo alone has 200+ issues, so an
 * unpaginated read would quietly lose most of them.
 */
async function forgejoGetAll<T>(schema: z.ZodType<T[]>, path: string, context: string): Promise<T[]> {
  const sep = path.includes("?") ? "&" : "?";
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const chunk = await forgejoFetch(schema, "GET", `${path}${sep}limit=${PAGE_LIMIT}&page=${page}`);
    out.push(...chunk);
    if (chunk.length < PAGE_LIMIT) return out;
  }
  log.warn(`forgejoGetAll: ${context} filled all ${MAX_PAGES} pages (${out.length} items) — later items were not fetched.`);
  return out;
}

// ── Caches ──

/** Mirrors github.ts's `apiCache` TTLs for the same data, but strictly Forgejo-side. */
const cache = new TTLCache<unknown>();

/** Exposed for tests. */
export function clearForgejoCache(): void {
  cache.clear();
  labelIdsByRepo.clear();
  selfLogin = null;
}

/** Drop the cached open-PR list for `repo` so the next `listPRs` re-reads it. */
export function invalidatePRList(repo: string): void {
  cache.invalidate(`pr-list:${repo}`);
}

// ── Pure helpers duplicated from github.ts ──
//
// Kept as self-contained literals to avoid a value-level circular import (see
// the module header). They must stay byte-compatible with github.ts's copies.

const CLAWS_VISIBLE_HEADER = "*— Automated by Claws —*";
const LEGACY_VISIBLE_HEADER = "*— Automated by CLAWS —*";
const ADDRESSED_REACTION = "rocket";
const REVIEWED_COMMIT_PATTERN = /Reviewed commit: `([0-9a-f]+)`/;
const REVIEW_ADDRESSED_PATTERN = /(?:<!-- )?review-addressed: ([0-9a-f]+)(?: -->)?/;
const REVIEW_REBUTTED_PATTERN = /(?:<!-- )?review-rebutted: ([0-9a-f]+)(?: -->)?/;
const ADVISORY_ADDRESSED_PATTERN = /(?:<!-- )?advisory-addressed: ([0-9a-f]+)(?: -->)?/;
const REVIEW_HEADER_TEXT = "## PR Review";
const REVIEW_CLEAN_MARKER = "review-result: clean";
const REVIEW_ADVISORY_MARKER = "review-result: advisory";
const REVIEW_ESCALATED_MARKER = "review-result: escalated";

function buildClawsComment(body: string, agentName?: string): string {
  const header = agentName ? `*— Automated by Claws · ${agentName} —*` : CLAWS_VISIBLE_HEADER;
  return header + "\n\n" + body;
}

function isClawsComment(body: string): boolean {
  return (
    /\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/.test(body) ||
    body.includes("<!-- claws-automated -->")
  );
}

function stripClawsMarker(body: string): string {
  return body
    .replace("<!-- claws-automated -->", "")
    .replace(/\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/g, "")
    .replace(LEGACY_VISIBLE_HEADER, "")
    .trim();
}

/** Copy of github.ts's `getLinkedIssueNumber`. Same convention Claws writes. */
function linkedIssueNumber(pr: PR): number | null {
  const branchMatch = pr.headRefName.match(/^claws\/issue-(\d+)-/);
  if (branchMatch) return parseInt(branchMatch[1]!, 10);
  if (pr.body) {
    const bodyMatch = pr.body.match(/(?:closes?|fixes?|resolves?|part of)\s*#(\d+)/i);
    if (bodyMatch) return parseInt(bodyMatch[1]!, 10);
  }
  return null;
}

/** Git refs cannot contain spaces or `~^:?*[\`; anything else is not ours. */
const SAFE_BRANCH_RE = /^[A-Za-z0-9._\/-]+$/;

// ── Gitea response schemas + mappers ──

const GiteaUserSchema = z.object({ login: z.string() });
const GiteaLabelSchema = z.object({ id: z.number(), name: z.string() });

const GiteaIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullish(),
  labels: z.array(GiteaLabelSchema).nullish(),
  user: GiteaUserSchema.nullish(),
  state: z.string().nullish(),
  updated_at: z.string().nullish(),
  closed_at: z.string().nullish(),
});
type GiteaIssue = z.infer<typeof GiteaIssueSchema>;

const GiteaBranchRefSchema = z.object({
  ref: z.string(),
  sha: z.string().nullish(),
  repo: z.object({ full_name: z.string() }).nullish(),
});

const GiteaPullSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullish(),
  labels: z.array(GiteaLabelSchema).nullish(),
  user: GiteaUserSchema.nullish(),
  state: z.string().nullish(),
  draft: z.boolean().nullish(),
  merged: z.boolean().nullish(),
  mergeable: z.boolean().nullish(),
  merged_at: z.string().nullish(),
  closed_at: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
  changed_files: z.number().nullish(),
  head: GiteaBranchRefSchema.nullish(),
  base: GiteaBranchRefSchema.nullish(),
});
type GiteaPull = z.infer<typeof GiteaPullSchema>;

const GiteaCommentSchema = z.object({
  id: z.number(),
  body: z.string().nullish(),
  user: GiteaUserSchema.nullish(),
  created_at: z.string().nullish(),
});

const GiteaReactionSchema = z.object({
  content: z.string(),
  user: GiteaUserSchema.nullish(),
});

/** Gitea's CommitStatus. The state field is `status`; older payloads use `state`. */
const GiteaCommitStatusSchema = z.object({
  context: z.string().nullish(),
  status: z.string().nullish(),
  state: z.string().nullish(),
  target_url: z.string().nullish(),
  description: z.string().nullish(),
});

const GiteaCombinedStatusSchema = z.object({
  state: z.string().nullish(),
  statuses: z.array(GiteaCommitStatusSchema).nullish(),
});

const GiteaContentsSchema = z.object({
  name: z.string().nullish(),
  path: z.string().nullish(),
  sha: z.string().nullish(),
  type: z.string().nullish(),
  content: z.string().nullish(),
});

const GiteaRepoSchema = z.object({
  full_name: z.string(),
  default_branch: z.string().nullish(),
  private: z.boolean().nullish(),
});

function mapIssue(raw: GiteaIssue): Issue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    labels: (raw.labels ?? []).map((l) => ({ name: l.name })),
    author: { login: raw.user?.login ?? "" },
    ...(raw.updated_at ? { updatedAt: raw.updated_at } : {}),
  };
}

/** gh reports a merged PR as state MERGED; Gitea reports state=closed + merged=true. */
function prState(raw: { state?: string | null; merged?: boolean | null }): string {
  if (raw.merged) return "MERGED";
  return (raw.state ?? "open").toUpperCase();
}

function mapPR(raw: GiteaPull): PR {
  const headRepo = raw.head?.repo?.full_name;
  const baseRepo = raw.base?.repo?.full_name;
  return {
    number: raw.number,
    title: raw.title,
    headRefName: raw.head?.ref ?? "",
    baseRefName: raw.base?.ref ?? "",
    labels: (raw.labels ?? []).map((l) => ({ name: l.name })),
    author: { login: raw.user?.login ?? "" },
    ...(raw.updated_at ? { updatedAt: raw.updated_at } : {}),
    ...(raw.body != null ? { body: raw.body } : {}),
    // Both sides are always present on a Gitea PR; if either is missing we
    // cannot prove a fork, and treating an unknown as same-repo matches gh.
    isCrossRepository: Boolean(headRepo && baseRepo && headRepo !== baseRepo),
    ...(raw.created_at ? { createdAt: raw.created_at } : {}),
    isDraft: raw.draft === true,
    ...(raw.changed_files != null ? { changedFiles: raw.changed_files } : {}),
    ...(raw.additions != null ? { additions: raw.additions } : {}),
    ...(raw.deletions != null ? { deletions: raw.deletions } : {}),
  };
}

// ── Identity ──

let selfLogin: string | null = null;

/** Claws' own login on Forgejo. Cached for the process lifetime, like getSelfLogin. */
export async function forgejoSelfLogin(): Promise<string> {
  if (selfLogin) return selfLogin;
  const user = await forgejoFetch(z.object({ login: z.string() }), "GET", "/user");
  selfLogin = user.login;
  return selfLogin;
}

// ── Repository ──

export interface ForgejoRepoInfo {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
}

/** Mirrors github.ts's REPO_CACHE_TTL — repo metadata barely moves. */
const REPO_CACHE_TTL = 5 * 60 * 1000;

/** Repo metadata. PR 3's discovery uses this for `defaultBranch`. */
export async function getRepo(fullName: string): Promise<ForgejoRepoInfo> {
  return cache.dedupedFetch(`repo:${fullName}`, REPO_CACHE_TTL, async () => {
    const raw = await forgejoFetch(GiteaRepoSchema, "GET", `/repos/${fullName}`);
    const [owner = "", name = ""] = raw.full_name.split("/");
    return {
      fullName: raw.full_name,
      owner,
      name,
      defaultBranch: raw.default_branch ?? "main",
      isPrivate: raw.private === true,
    };
  }) as Promise<ForgejoRepoInfo>;
}

export async function getDefaultBranch(repo: string): Promise<string> {
  return (await getRepo(repo)).defaultBranch;
}

export async function isRepoPrivate(repo: string): Promise<boolean> {
  try {
    return (await getRepo(repo)).isPrivate;
  } catch (err) {
    log.warn(`isRepoPrivate(${repo}): defaulting to false — ${err}`);
    return false;
  }
}

// ── Labels ──

/** name → label id, per repo. Gitea label mutations take IDs, never names. */
const labelIdsByRepo = new Map<string, Map<string, number>>();

async function refreshLabelIds(repo: string): Promise<Map<string, number>> {
  const raw = await forgejoGetAll(z.array(GiteaLabelSchema), `/repos/${repo}/labels`, `labels for ${repo}`);
  const map = new Map<string, number>();
  for (const l of raw) map.set(l.name, l.id);
  labelIdsByRepo.set(repo, map);
  return map;
}

async function labelIds(repo: string): Promise<Map<string, number>> {
  return labelIdsByRepo.get(repo) ?? (await refreshLabelIds(repo));
}

/** Gitea wants `#rrggbb`; LABEL_SPECS stores bare hex. */
function toHexColor(color: string): string {
  return color.startsWith("#") ? color : `#${color}`;
}

/** GitHub rejects `label create` when the description exceeds 100 characters,
 *  and `ensureLabel` swallows the error — leaving callers to fail later with
 *  "'X' not found" (#2760). Truncate rather than lose the label entirely. */
const MAX_LABEL_DESCRIPTION = 100;

function truncateDescription(label: string, description: string): string {
  if (description.length <= MAX_LABEL_DESCRIPTION) return description;
  log.warn(`ensureLabel: description for "${label}" is ${description.length} chars (max ${MAX_LABEL_DESCRIPTION}) — truncating`);
  return description.slice(0, MAX_LABEL_DESCRIPTION);
}

export async function listLabels(repo: string): Promise<string[]> {
  return [...(await refreshLabelIds(repo)).keys()];
}

export async function ensureLabel(
  repo: string,
  label: string,
  overrideSpec?: { color: string; description: string },
): Promise<void> {
  try {
    const ids = await labelIds(repo);
    if (ids.has(label)) return;
    const spec = overrideSpec ?? LABEL_SPECS[label];
    if (!spec) {
      log.warn(`ensureLabel: creating undeclared label "${label}" on ${repo} — add it to LABEL_SPECS (see docs/label-audit.md)`);
    }
    const created = await forgejoFetch(GiteaLabelSchema, "POST", `/repos/${repo}/labels`, {
      name: label,
      color: toHexColor(spec?.color ?? "ededed"),
      description: truncateDescription(label, spec?.description ?? ""),
    });
    ids.set(created.name, created.id);
  } catch (err) {
    log.warn(`ensureLabel ${label} on ${repo}: ${err}`);
  }
}

/** Ensure the label exists and return its id, or null when it could not be resolved. */
async function ensureLabelId(repo: string, label: string): Promise<number | null> {
  await ensureLabel(repo, label);
  return (await labelIds(repo)).get(label) ?? null;
}

export async function deleteLabel(repo: string, label: string): Promise<void> {
  try {
    const ids = await labelIds(repo);
    const id = ids.get(label);
    if (id === undefined) return;
    await forgejoSend("DELETE", `/repos/${repo}/labels/${id}`);
    ids.delete(label);
  } catch (err) {
    log.warn(`deleteLabel ${label} on ${repo}: ${err}`);
  }
}

export async function applyLabelRenames(repo: string, renames: Record<string, string>): Promise<void> {
  const entries = Object.entries(renames);
  if (entries.length === 0) return;
  const ids = await refreshLabelIds(repo);
  // Snapshot the names before the loop, like github.ts: a rename must be judged
  // against the pre-run state, so renaming A→B does not then unblock C→A.
  const current = new Set(ids.keys());
  for (const [from, to] of entries) {
    const id = ids.get(from);
    if (id === undefined || current.has(to)) continue;
    log.info(`[repo-standards] Renaming label "${from}" → "${to}" in ${repo}`);
    try {
      await forgejoSend("PATCH", `/repos/${repo}/labels/${id}`, { name: to });
      ids.delete(from);
      ids.set(to, id);
    } catch (err) {
      log.warn(`applyLabelRenames ${from}→${to} on ${repo}: ${err}`);
    }
  }
}

export async function addLabel(repo: string, issueNumber: number, label: string): Promise<void> {
  const id = await ensureLabelId(repo, label);
  if (id === null) throw new Error(`forgejo: label "${label}" could not be resolved on ${repo}`);
  await forgejoSend("POST", `/repos/${repo}/issues/${issueNumber}/labels`, { labels: [id] });
}

async function fetchLiveLabels(repo: string, issueNumber: number): Promise<string[]> {
  const raw = await forgejoFetch(z.array(GiteaLabelSchema), "GET", `/repos/${repo}/issues/${issueNumber}/labels`);
  return raw.map((l) => l.name);
}

/**
 * Remove a label, returning true only when the label is confirmed absent
 * afterwards — same contract as github.ts's removeLabel.
 */
export async function removeLabel(repo: string, issueNumber: number, label: string): Promise<boolean> {
  try {
    const id = (await labelIds(repo)).get(label);
    // A label that does not exist on the repo cannot be on the issue.
    if (id === undefined) return true;
    await forgejoSend("DELETE", `/repos/${repo}/issues/${issueNumber}/labels/${id}`);
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

export async function listOpenIssues(repo: string): Promise<Issue[]> {
  return cache.dedupedFetch(`open-issues:${repo}`, 60_000, async () => {
    // `type=issues` is mandatory: without it Gitea returns pull requests from
    // the issues endpoint too, and every PR would double-appear as an issue.
    const raw = await forgejoGetAll(
      z.array(GiteaIssueSchema),
      `/repos/${repo}/issues?state=open&type=issues`,
      `open issues for ${repo}`,
    );
    return raw.map(mapIssue);
  }) as Promise<Issue[]>;
}

export async function listIssuesByLabel(repo: string, label: string): Promise<Issue[]> {
  return cache.dedupedFetch(`issues-by-label:${repo}:${label}`, 60_000, async () => {
    const raw = await forgejoGetAll(
      z.array(GiteaIssueSchema),
      `/repos/${repo}/issues?state=open&type=issues&labels=${encodeURIComponent(label)}`,
      `issues by label for ${repo}`,
    );
    return raw.map(mapIssue);
  }) as Promise<Issue[]>;
}

export async function createIssue(repo: string, title: string, body: string, labels: string[]): Promise<number> {
  const ids: number[] = [];
  for (const label of labels) {
    const id = await ensureLabelId(repo, label);
    if (id !== null) ids.push(id);
  }
  const created = await forgejoFetch(z.object({ number: z.number() }), "POST", `/repos/${repo}/issues`, {
    title,
    body,
    ...(ids.length > 0 ? { labels: ids } : {}),
  });
  cache.invalidate(`open-issues:${repo}`);
  return created.number;
}

/**
 * Read an issue's live title and body. Deliberately NOT cached, mirroring
 * github.ts: every caller needs the current value, not the 60 s-cached copy.
 */
export async function getIssueTitleBody(repo: string, issueNumber: number): Promise<{ title: string; body: string }> {
  const raw = await forgejoFetch(GiteaIssueSchema, "GET", `/repos/${repo}/issues/${issueNumber}`);
  return { title: raw.title, body: raw.body ?? "" };
}

export async function getIssueBody(repo: string, issueNumber: number): Promise<string> {
  return (await getIssueTitleBody(repo, issueNumber)).body;
}

/**
 * Rendered issue HTML, used only for extracting pre-signed image URLs. Gitea has
 * no `body_html` representation, so Forgejo issue images are not extracted —
 * a known, documented limitation rather than a failure.
 */
export async function getIssueBodyHtml(repo: string, issueNumber: number): Promise<string> {
  log.debug(`[forgejo] getIssueBodyHtml(${repo}#${issueNumber}): Gitea has no body_html — returning ""`);
  return "";
}

/** `stateReason` has no Gitea equivalent; callers already tolerate null. */
export async function getIssueState(
  repo: string,
  issueNumber: number,
): Promise<{ state: string; stateReason: string | null }> {
  const raw = await forgejoFetch(GiteaIssueSchema, "GET", `/repos/${repo}/issues/${issueNumber}`);
  return { state: (raw.state ?? "open").toUpperCase(), stateReason: null };
}

export async function editIssue(repo: string, issueNumber: number, body: string): Promise<void> {
  await forgejoSend("PATCH", `/repos/${repo}/issues/${issueNumber}`, { body });
}

export async function editIssueTitle(repo: string, issueNumber: number, title: string): Promise<void> {
  await forgejoSend("PATCH", `/repos/${repo}/issues/${issueNumber}`, { title });
  cache.invalidate(`open-issues:${repo}`);
}

/** `stateReason` is GitHub-only; a Forgejo close is just a close. */
export async function closeIssue(
  repo: string,
  issueNumber: number,
  _stateReason?: "completed" | "not_planned",
): Promise<void> {
  await forgejoSend("PATCH", `/repos/${repo}/issues/${issueNumber}`, { state: "closed" });
  cache.invalidate(`open-issues:${repo}`);
}

export async function listRecentlyClosedIssues(
  repo: string,
  since: Date | null,
  limit = 100,
): Promise<{ number: number; title: string; body: string; closedAt: string; updatedAt: string; author: string }[]> {
  const sinceParam = since ? `&since=${encodeURIComponent(since.toISOString())}` : "";
  const raw = await forgejoGetAll(
    z.array(GiteaIssueSchema),
    `/repos/${repo}/issues?state=closed&type=issues${sinceParam}`,
    `closed issues for ${repo}`,
  );
  const mapped = raw
    .filter((i) => i.closed_at)
    .map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      closedAt: i.closed_at!,
      updatedAt: i.updated_at ?? i.closed_at!,
      author: i.user?.login ?? "",
    }));
  const filtered = since ? mapped.filter((i) => new Date(i.closedAt) >= since) : mapped;
  return filtered.slice(0, limit);
}

/**
 * Open issues marked as duplicates of `canonicalNumber`.
 *
 * github.ts finds these with `gh issue list --search '"claws-duplicate-of:N" in:comments'`;
 * Gitea's issue search has no comment-body index, so the label-filtered candidate
 * set (small by construction) is scanned comment-by-comment instead.
 */
export async function listDuplicateIssuesOf(repo: string, canonicalNumber: number): Promise<Issue[]> {
  const marker = `claws-duplicate-of:${canonicalNumber}`;
  const candidates = await listIssuesByLabel(repo, LABELS.duplicate);
  const settled = await mapSettledWithConcurrency(candidates, 4, async (issue) => {
    const comments = await getIssueComments(repo, issue.number);
    return comments.some((c) => c.body.includes(marker)) ? issue : null;
  });
  const matches: Issue[] = [];
  for (const [i, result] of settled.entries()) {
    if (result.status === "rejected") {
      log.warn(`listDuplicateIssuesOf ${repo}#${candidates[i]!.number}: ${result.reason}`);
      continue;
    }
    if (result.value) matches.push(result.value);
  }
  return matches;
}

/** Gitea has no issue-transfer API, and a cross-forge transfer is impossible anyway. */
export async function transferIssue(repo: string, issueNumber: number, destinationRepo: string): Promise<string> {
  throw new Error(`forgejo: cannot transfer ${repo}#${issueNumber} to ${destinationRepo} — Gitea has no issue-transfer API`);
}

// ── Issue comments ──

export async function getIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]> {
  return cache.dedupedFetch(`issue-comments:${repo}:${issueNumber}`, 60_000, async () => {
    const raw = await forgejoGetAll(
      z.array(GiteaCommentSchema),
      `/repos/${repo}/issues/${issueNumber}/comments`,
      `issue comments for ${repo}#${issueNumber}`,
    );
    return raw
      .filter((c) => (c.body ?? "").trim())
      .map((c) => ({ id: c.id, body: c.body!, body_html: "", login: c.user?.login ?? "" }));
  }) as Promise<IssueComment[]>;
}

export async function commentOnIssue(
  repo: string,
  issueNumber: number,
  body: string,
  opts?: { agentName?: string },
): Promise<void> {
  await forgejoSend("POST", `/repos/${repo}/issues/${issueNumber}/comments`, {
    body: buildClawsComment(body, opts?.agentName),
  });
  cache.invalidate(`issue-comments:${repo}:${issueNumber}`);
}

/** List/create use the issue index; edit uses the comment id — different routes. */
export async function editIssueComment(
  repo: string,
  commentId: number,
  body: string,
  opts?: { agentName?: string },
): Promise<void> {
  await forgejoSend("PATCH", `/repos/${repo}/issues/comments/${commentId}`, {
    body: buildClawsComment(body, opts?.agentName),
  });
  cache.invalidatePrefix(`issue-comments:${repo}:`);
}

// ── Reactions ──
//
// Gitea keeps issue comments and pull-review comments in one table, so both id
// namespaces resolve through `issues/comments/{id}/reactions`. Some Forgejo
// builds 404 on review-comment ids; every path here fails soft, because a lost
// reaction only degrades a comment to "unaddressed", which is safe, whereas a
// throw would crash the review-addresser.

export async function addReaction(repo: string, commentId: number, reaction: string): Promise<void> {
  try {
    await forgejoSend("POST", `/repos/${repo}/issues/comments/${commentId}/reactions`, { content: reaction });
    cache.invalidate(`comment-reactions:${repo}:${commentId}`);
  } catch (err) {
    log.warn(`addReaction on comment ${commentId} in ${repo}: ${err}`);
  }
}

export async function addReviewCommentReaction(repo: string, commentId: number, reaction: string): Promise<void> {
  try {
    await forgejoSend("POST", `/repos/${repo}/issues/comments/${commentId}/reactions`, { content: reaction });
    cache.invalidate(`review-comment-reactions:${repo}:${commentId}`);
  } catch (err) {
    log.warn(`addReviewCommentReaction on comment ${commentId} in ${repo}: ${err}`);
  }
}

/** Gitea reactions carry no id of their own; no caller reads `Reaction.id`. */
async function fetchReactions(repo: string, commentId: number, label: string): Promise<Reaction[]> {
  try {
    const raw = await forgejoFetch(
      z.array(GiteaReactionSchema),
      "GET",
      `/repos/${repo}/issues/comments/${commentId}/reactions`,
    );
    return raw.map((r) => ({ id: 0, user: { login: r.user?.login ?? "" }, content: r.content }));
  } catch (err) {
    log.warn(`${label} on comment ${commentId} in ${repo}: ${err}`);
    return [];
  }
}

export async function getCommentReactions(repo: string, commentId: number): Promise<Reaction[]> {
  return cache.dedupedFetch(`comment-reactions:${repo}:${commentId}`, 60_000, () =>
    fetchReactions(repo, commentId, "getCommentReactions"),
  ) as Promise<Reaction[]>;
}

export async function getReviewCommentReactions(repo: string, commentId: number): Promise<Reaction[]> {
  return cache.dedupedFetch(`review-comment-reactions:${repo}:${commentId}`, 60_000, () =>
    fetchReactions(repo, commentId, "getReviewCommentReactions"),
  ) as Promise<Reaction[]>;
}

const REACTION_FETCH_CONCURRENCY = 5;

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

// ── Pull requests ──

export async function listPRs(repo: string): Promise<PR[]> {
  return cache.dedupedFetch(`pr-list:${repo}`, 60_000, async () => {
    const raw = await forgejoGetAll(
      z.array(GiteaPullSchema),
      `/repos/${repo}/pulls?state=open`,
      `open PRs for ${repo}`,
    );
    return raw.map(mapPR);
  }) as Promise<PR[]>;
}

async function fetchPull(repo: string, prNumber: number): Promise<GiteaPull> {
  return forgejoFetch(GiteaPullSchema, "GET", `/repos/${repo}/pulls/${prNumber}`);
}

export async function createPR(repo: string, head: string, title: string, body: string): Promise<number> {
  const base = await getDefaultBranch(repo);
  const created = await forgejoFetch(z.object({ number: z.number() }), "POST", `/repos/${repo}/pulls`, {
    head,
    base,
    title,
    body,
  });
  cache.invalidate(`pr-list:${repo}`);
  return created.number;
}

export async function updatePR(repo: string, prNumber: number, body: string, title?: string): Promise<void> {
  await forgejoSend("PATCH", `/repos/${repo}/pulls/${prNumber}`, { body, ...(title ? { title } : {}) });
}

/**
 * Close a PR. Unlike github.ts's closePR this does NOT drop the queue-cache
 * entry — `removeQueueItem` lives in github.ts, which this module must not
 * value-import; the routing wrapper there does it after delegating.
 */
export async function closePR(repo: string, prNumber: number): Promise<void> {
  await forgejoSend("PATCH", `/repos/${repo}/pulls/${prNumber}`, { state: "closed" });
  cache.invalidate(`pr-list:${repo}`);
}

/**
 * Squash-merge a PR. `head_commit_id` is Gitea's equivalent of gh's
 * `--match-head-commit`: the merge is rejected if the head moved between
 * evaluation and merge (#2354). `Do` really is capital-D in the Gitea API.
 */
export async function mergePR(repo: string, prNumber: number, expectedHeadSha?: string): Promise<void> {
  await forgejoSend("POST", `/repos/${repo}/pulls/${prNumber}/merge`, {
    Do: "squash",
    ...(expectedHeadSha ? { head_commit_id: expectedHeadSha } : {}),
    delete_branch_after_merge: true,
  });
  cache.invalidate(`pr-list:${repo}`);
}

export async function getPRBody(repo: string, prNumber: number): Promise<string> {
  return ((await fetchPull(repo, prNumber)).body ?? "").trim();
}

export async function getPRState(repo: string, prNumber: number): Promise<string | null> {
  try {
    return prState(await fetchPull(repo, prNumber));
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** Gitea's pull payload with the extra fields `getUpstreamPRStatus` needs. */
const GiteaUpstreamPullSchema = z.object({
  state: z.string().nullish(),
  merged: z.boolean().nullish(),
  merged_at: z.string().nullish(),
  title: z.string(),
  html_url: z.string().nullish(),
  updated_at: z.string().nullish(),
});

/** Merge status of a PR on this Forgejo host. Returns null when it is gone (404/403). */
export async function getUpstreamPRStatus(repo: string, prNumber: number): Promise<UpstreamPRStatus | null> {
  let raw;
  try {
    raw = await forgejoFetch(GiteaUpstreamPullSchema, "GET", `/repos/${repo}/pulls/${prNumber}`);
  } catch (err) {
    if (isMissing(err) || statusOf(err) === 403) return null;
    throw err;
  }
  return {
    state: (raw.state ?? "open").toLowerCase() === "closed" ? "closed" : "open",
    merged: raw.merged === true,
    mergedAt: raw.merged_at ?? null,
    title: raw.title,
    url: raw.html_url ?? `${FORGEJO_BASE_URL.replace(/\/+$/, "")}/${repo}/pulls/${prNumber}`,
    updatedAt: raw.updated_at ?? "",
  };
}

export async function getPRHeadSHA(repo: string, prNumber: number): Promise<string> {
  const sha = (await fetchPull(repo, prNumber)).head?.sha;
  if (!sha) throw new Error(`forgejo: PR ${repo}#${prNumber} has no head SHA`);
  return sha;
}

export async function getPRDiffStats(
  repo: string,
  prNumber: number,
): Promise<{ changedFiles: number; additions: number; deletions: number; state: string } | null> {
  let raw: GiteaPull;
  try {
    raw = await fetchPull(repo, prNumber);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  return {
    changedFiles: raw.changed_files ?? 0,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    state: prState(raw),
  };
}

export async function getPRMergeableState(
  repo: string,
  prNumber: number,
  maxAttempts = 5,
  delayMs = 3000,
): Promise<"MERGEABLE" | "CONFLICTING" | "UNKNOWN"> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const raw = await fetchPull(repo, prNumber);
    // Gitea omits `mergeable` until it has computed the merge base; treat that
    // as UNKNOWN and retry, exactly as the gh path does.
    if (raw.mergeable === true) return "MERGEABLE";
    if (raw.mergeable === false) return "CONFLICTING";
    if (attempt < maxAttempts - 1) await sleep(delayMs);
  }
  return "UNKNOWN";
}

/**
 * Live merge-relevant PR state in two uncached calls. Deliberately bypasses the
 * TTL cache — the auto-merger runs seconds after other agents mutate the PR, and
 * a stale snapshot is what merged a red PR in #2354.
 */
export async function getPRMergeGate(repo: string, prNumber: number): Promise<PRMergeGate> {
  const raw = await fetchPull(repo, prNumber);
  const headSha = raw.head?.sha ?? "";
  const checks = headSha ? await fetchCommitChecks(repo, headSha) : [];
  const summary = summariseChecks(checks);
  return {
    state: prState(raw),
    headSha,
    labels: (raw.labels ?? []).map((l) => l.name),
    mergeable: raw.mergeable === true ? "MERGEABLE" : raw.mergeable === false ? "CONFLICTING" : "UNKNOWN",
    checkStatus: summary.status,
    checksTotal: summary.total,
  };
}

export async function getPRDiff(repo: string, prNumber: number): Promise<string> {
  try {
    return await forgejoRequest("GET", `/repos/${repo}/pulls/${prNumber}.diff`, undefined, { accept: "text/plain" });
  } catch (err) {
    log.warn(`getPRDiff for PR #${prNumber} in ${repo}: ${err}`);
    return "";
  }
}

export async function getPRChangedFiles(repo: string, prNumber: number): Promise<string[]> {
  try {
    const files = await forgejoGetAll(
      z.array(z.object({ filename: z.string() })),
      `/repos/${repo}/pulls/${prNumber}/files`,
      `changed files for ${repo}#${prNumber}`,
    );
    return files.map((f) => f.filename).filter(Boolean);
  } catch (err) {
    log.warn(`getPRChangedFiles for PR #${prNumber} in ${repo}: ${err}`);
    return [];
  }
}

/** Gitea has no cross-reference timeline; the linked-issue convention Claws
 *  writes into its own branch names and PR bodies is the only signal. */
export async function getOpenPRForIssue(repo: string, issueNumber: number): Promise<PR | null> {
  const prs = await listPRs(repo);
  return prs.find((pr) => linkedIssueNumber(pr) === issueNumber) ?? null;
}

export async function listMergedPRsForIssue(repo: string, issueNumber: number): Promise<PR[]> {
  const raw = await forgejoGetAll(
    z.array(GiteaPullSchema),
    `/repos/${repo}/pulls?state=closed`,
    `closed PRs for ${repo}`,
  );
  return raw
    .filter((p) => p.merged)
    .map(mapPR)
    .filter((pr) => linkedIssueNumber(pr) === issueNumber);
}

/** Closed PRs (merged and not), newest-close-first, read once and reused by the
 *  two `listRecently*` helpers below. */
async function closedPulls(repo: string): Promise<GiteaPull[]> {
  return forgejoGetAll(z.array(GiteaPullSchema), `/repos/${repo}/pulls?state=closed`, `closed PRs for ${repo}`);
}

export async function listRecentlyMergedPRs(
  repo: string,
  since: Date | null,
  limit = 50,
): Promise<{ number: number; title: string; body: string; mergedAt: string; updatedAt: string; author: string; headRefName: string }[]> {
  const mapped = (await closedPulls(repo))
    .filter((p) => p.merged && p.merged_at)
    .map((p) => ({
      number: p.number,
      title: p.title,
      body: p.body ?? "",
      mergedAt: p.merged_at!,
      updatedAt: p.updated_at ?? p.merged_at!,
      author: p.user?.login ?? "",
      headRefName: p.head?.ref ?? "",
    }))
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
  const filtered = since ? mapped.filter((p) => new Date(p.mergedAt) >= since) : mapped;
  return filtered.slice(0, limit);
}

/** PRs closed WITHOUT merging — Gitea's `state=closed` includes merged PRs, so
 *  rows carrying `merged` are dropped here rather than trusted to the query. */
export async function listRecentlyClosedUnmergedPRs(
  repo: string,
  since: Date | null,
  limit = 50,
): Promise<{ number: number; title: string; body: string; closedAt: string; updatedAt: string; author: string; headRefName: string }[]> {
  const mapped = (await closedPulls(repo))
    .filter((p) => !p.merged && p.closed_at)
    .map((p) => ({
      number: p.number,
      title: p.title,
      body: p.body ?? "",
      closedAt: p.closed_at!,
      updatedAt: p.updated_at ?? p.closed_at!,
      author: p.user?.login ?? "",
      headRefName: p.head?.ref ?? "",
    }))
    .sort((a, b) => b.closedAt.localeCompare(a.closedAt));
  const filtered = since ? mapped.filter((p) => new Date(p.closedAt) >= since) : mapped;
  return filtered.slice(0, limit);
}

/**
 * PRs (open, closed and merged) for many head branches of one repo. Gitea has no
 * per-branch PR query, so this reads the full PR list once and buckets it.
 * Branches whose names fail SAFE_BRANCH_RE are omitted, matching github.ts.
 * Throws on failure — callers MUST NOT treat a rejection as "no PRs".
 */
export async function listPRsForBranches(repo: string, branchNames: string[]): Promise<Map<string, BranchPR[]>> {
  const wanted = new Set(branchNames.filter((b) => SAFE_BRANCH_RE.test(b)));
  const result = new Map<string, BranchPR[]>();
  for (const b of wanted) result.set(b, []);
  if (wanted.size === 0) return result;

  const raw = await forgejoGetAll(z.array(GiteaPullSchema), `/repos/${repo}/pulls?state=all`, `all PRs for ${repo}`);
  for (const p of raw) {
    const ref = p.head?.ref;
    if (!ref || !wanted.has(ref)) continue;
    result.get(ref)!.push({
      number: p.number,
      state: prState(p),
      ...(p.merged_at ? { mergedAt: p.merged_at } : {}),
      ...(p.closed_at ? { closedAt: p.closed_at } : {}),
    });
  }
  return result;
}

/** Gitea binds `/branches/*` as a wildcard, so a `claws/issue-N-x` branch name
 *  must arrive with its slashes raw — percent-encoding them misses the route. */
export async function deleteRemoteBranch(repo: string, branchName: string): Promise<void> {
  await forgejoSend("DELETE", `/repos/${repo}/branches/${branchName}`);
}

export async function listCompareCommits(
  repo: string,
  base: string,
  head: string,
): Promise<{ sha: string; subject: string }[]> {
  const parsed = await forgejoFetch(
    z.object({ commits: z.array(z.object({ sha: z.string(), commit: z.object({ message: z.string() }) })).nullish() }),
    "GET",
    // `/compare/*` is a wildcard route too — pass refs raw, as github.ts does.
    `/repos/${repo}/compare/${base}...${head}`,
  );
  return (parsed.commits ?? []).map((c) => ({
    sha: c.sha,
    subject: c.commit.message.split("\n", 1)[0]!.trim(),
  }));
}

// ── Checks ──
//
// Forgejo Actions reports each workflow job as a *commit status*, not a check
// run. The combined-status endpoint already collapses each context to its
// latest status, which is what rollupCheckStatus does by hand on the gh side.

const CHECK_PASSING = new Set(["SUCCESS", "SKIPPED", "WARNING"]);
const CHECK_FAILING = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"]);

interface ForgejoCheck {
  name: string;
  state: string;
  link: string;
}

async function fetchCommitChecks(repo: string, sha: string): Promise<ForgejoCheck[]> {
  const combined = await forgejoFetch(GiteaCombinedStatusSchema, "GET", `/repos/${repo}/commits/${sha}/status`);
  return (combined.statuses ?? []).map((s, i) => ({
    name: s.context || `status-${i + 1}`,
    state: (s.status ?? s.state ?? "pending").toUpperCase(),
    link: s.target_url ?? "",
  }));
}

function summariseChecks(checks: ForgejoCheck[]): {
  status: "passing" | "failing" | "pending" | "none";
  passed: number;
  total: number;
} {
  const total = checks.length;
  const passed = checks.filter((c) => CHECK_PASSING.has(c.state)).length;
  const failed = checks.filter((c) => CHECK_FAILING.has(c.state)).length;
  if (total === 0) return { status: "none", passed, total };
  if (failed > 0) return { status: "failing", passed, total };
  if (passed === total) return { status: "passing", passed, total };
  return { status: "pending", passed, total };
}

async function checksForPR(repo: string, prNumber: number): Promise<ForgejoCheck[]> {
  const sha = (await fetchPull(repo, prNumber)).head?.sha;
  if (!sha) return [];
  return fetchCommitChecks(repo, sha);
}

export async function getPRCheckStatus(
  repo: string,
  prNumber: number,
): Promise<"passing" | "failing" | "pending" | "none"> {
  return cache.dedupedFetch(`pr-checks:${repo}:${prNumber}`, 30_000, async () =>
    summariseChecks(await checksForPR(repo, prNumber)).status,
  ) as Promise<"passing" | "failing" | "pending" | "none">;
}

export async function getPRChecksSummary(
  repo: string,
  prNumber: number,
): Promise<{ status: "passing" | "failing" | "pending" | "none"; passed: number; total: number }> {
  return cache.dedupedFetch(`pr-checks-sum:${repo}:${prNumber}`, 30_000, async () =>
    summariseChecks(await checksForPR(repo, prNumber)),
  ) as Promise<{ status: "passing" | "failing" | "pending" | "none"; passed: number; total: number }>;
}

export async function getFailingCheck(repo: string, prNumber: number): Promise<FailedCheck | undefined> {
  try {
    return (await checksForPR(repo, prNumber)).find((c) => CHECK_FAILING.has(c.state));
  } catch {
    return undefined;
  }
}

/** ISO commit-date of `sha`, or null when unreadable. */
export async function getCommitCommittedAt(repo: string, sha: string): Promise<string | null> {
  try {
    const raw = await forgejoFetch(
      z.object({ commit: z.object({ committer: z.object({ date: z.string().nullish() }).nullish() }).nullish() }),
      "GET",
      `/repos/${repo}/git/commits/${sha}`,
    );
    return raw.commit?.committer?.date ?? null;
  } catch (err) {
    log.warn(`getCommitCommittedAt ${repo}@${sha}: ${err}`);
    return null;
  }
}

/** How long a freshly-pushed head SHA is given to register its first status. */
const NO_CHECKS_SETTLE_MS = 5 * 60 * 1000;

/**
 * Decide whether a check status of `"none"` can be believed. Forgejo registers a
 * commit status as soon as a workflow starts, so a settled non-pending result is
 * conclusive immediately. Zero statuses is ambiguous — the repo may simply have
 * no `.forgejo/workflows/` — so that case falls back to github.ts's age window,
 * and an unreadable commit date fails closed (#2354).
 */
export async function haveChecksSettled(repo: string, sha: string): Promise<{ settled: boolean; age: string }> {
  const committedAt = await getCommitCommittedAt(repo, sha);
  const ageMs = committedAt ? Date.now() - Date.parse(committedAt) : NaN;
  const age = Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s` : "unknown";
  try {
    const summary = summariseChecks(await fetchCommitChecks(repo, sha));
    if (summary.total > 0 && summary.status !== "pending") return { settled: true, age };
  } catch (err) {
    log.warn(`haveChecksSettled ${repo}@${sha}: ${err}`);
    return { settled: false, age };
  }
  if (!Number.isFinite(ageMs)) return { settled: false, age: "unknown" };
  return { settled: ageMs >= NO_CHECKS_SETTLE_MS, age };
}

// ── Reviews ──

const GiteaReviewSchema = z.object({
  id: z.number(),
  user: GiteaUserSchema.nullish(),
  state: z.string().nullish(),
  body: z.string().nullish(),
  commit_id: z.string().nullish(),
  submitted_at: z.string().nullish(),
});

const GiteaReviewCommentSchema = z.object({
  id: z.number(),
  user: GiteaUserSchema.nullish(),
  path: z.string().nullish(),
  body: z.string().nullish(),
  diff_hunk: z.string().nullish(),
  original_position: z.number().nullish(),
  position: z.number().nullish(),
  resolver: GiteaUserSchema.nullish(),
});

type GiteaReview = z.infer<typeof GiteaReviewSchema>;
type GiteaReviewComment = z.infer<typeof GiteaReviewCommentSchema>;

async function fetchReviews(repo: string, prNumber: number): Promise<GiteaReview[]> {
  return forgejoGetAll(
    z.array(GiteaReviewSchema),
    `/repos/${repo}/pulls/${prNumber}/reviews`,
    `reviews for ${repo}#${prNumber}`,
  );
}

/** Gitea has no flat inline-comment endpoint — they hang off each review. */
async function fetchReviewComments(repo: string, prNumber: number, reviews: GiteaReview[]): Promise<GiteaReviewComment[]> {
  const out: GiteaReviewComment[] = [];
  for (const review of reviews) {
    try {
      const comments = await forgejoFetch(
        z.array(GiteaReviewCommentSchema),
        "GET",
        `/repos/${repo}/pulls/${prNumber}/reviews/${review.id}/comments`,
      );
      out.push(...comments);
    } catch (err) {
      log.warn(`forgejo: review ${review.id} comments for ${repo}#${prNumber}: ${err}`);
    }
  }
  return out;
}

export async function getPRReviewNotes(repo: string, prNumber: number): Promise<PRReviewNote[]> {
  const reviews = await fetchReviews(repo, prNumber);
  const comments = await fetchReviewComments(repo, prNumber, reviews);
  const notes: PRReviewNote[] = [];
  for (const r of reviews) {
    if ((r.body ?? "").trim()) notes.push({ login: r.user?.login ?? "", body: r.body! });
  }
  for (const c of comments) {
    if ((c.body ?? "").trim()) {
      notes.push({
        login: c.user?.login ?? "",
        body: c.body!,
        ...(c.path ? { path: c.path } : {}),
        line: c.position ?? c.original_position ?? null,
      });
    }
  }
  return notes;
}

export async function getPRReviewStatus(
  repo: string,
  prNumber: number,
): Promise<{ status: "clean" | "issues" | "escalated" | "none"; issueCount: number; reviewedCommit: string | null }> {
  return cache.dedupedFetch(`pr-review-status:${repo}:${prNumber}`, 60_000, async () => {
    try {
      const comments = await getIssueComments(repo, prNumber);
      let latest: { body: string } | null = null;
      for (const c of comments) {
        if (isClawsComment(c.body) && c.body.includes(REVIEW_HEADER_TEXT)) latest = { body: c.body };
      }
      if (!latest) return { status: "none" as const, issueCount: 0, reviewedCommit: null };
      const reviewedCommit = latest.body.match(REVIEWED_COMMIT_PATTERN)?.[1] ?? null;
      // Markers are checked against the current round only — the collapsed
      // per-iteration audit log archives prior rounds' bodies.
      const currentBody = latest.body.replace(/<details>[\s\S]*?<\/details>/gi, "");
      if (currentBody.includes(REVIEW_CLEAN_MARKER)) return { status: "clean" as const, issueCount: 0, reviewedCommit };
      if (currentBody.includes(REVIEW_ADVISORY_MARKER)) return { status: "clean" as const, issueCount: 0, reviewedCommit };
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
      return { status: "issues" as const, issueCount: numbered > 0 ? numbered : headings, reviewedCommit };
    } catch {
      return { status: "none" as const, issueCount: 0, reviewedCommit: null };
    }
  }) as Promise<{ status: "clean" | "issues" | "escalated" | "none"; issueCount: number; reviewedCommit: string | null }>;
}

/**
 * Collect the outstanding review work for a PR — the Forgejo mirror of
 * github.ts's getPRReviewComments, field for field.
 *
 * Two deliberate differences: `htmlBodies` is always empty (Gitea renders no
 * `body_html`, so Forgejo review images are never extracted), and thread
 * resolution is read from Gitea's per-comment `resolver` rather than GitHub's
 * GraphQL `isResolved`.
 */
export async function getPRReviewComments(
  repo: string,
  prNumber: number,
  opts: { includeAdvisory?: boolean } = {},
): Promise<PRReviewData> {
  const empty: PRReviewData = { formatted: "", commentIds: [], reviewCommentIds: [], htmlBodies: [], prReviewComment: undefined, advisoryOnly: false };
  try {
    const self = await forgejoSelfLogin();

    const reviews = await fetchReviews(repo, prNumber);
    const allInline = await fetchReviewComments(repo, prNumber, reviews);
    // Gitea marks a resolved thread by stamping `resolver` on its comments.
    const inline = allInline.filter((c) => !c.resolver?.login);
    const issueComments = await forgejoGetAll(
      z.array(GiteaCommentSchema),
      `/repos/${repo}/issues/${prNumber}/comments`,
      `PR issue comments for ${repo}#${prNumber}`,
    );

    const humanParts: string[] = [];
    const clawsReviewParts: string[] = [];
    const clawsOtherParts: string[] = [];
    const commentIds: number[] = [];
    const reviewCommentIds: number[] = [];
    let headSha: string | undefined;
    let prReviewComment: PRReviewData["prReviewComment"];

    const guardCtx = makeGuardCtx(repo, prNumber);
    for (const review of reviews) {
      if ((review.body ?? "").trim()) {
        // Claws doesn't write top-level review bodies, so all are human-authored.
        const body = guardContent(review.body!, guardCtx("review-body"));
        humanParts.push(`Review by @${review.user?.login ?? ""} (${review.state ?? ""}):\n${body}`);
      }
    }

    const reviewReactions = await prefetchReactions(repo, inline.map((c) => c.id), getReviewCommentReactions);

    for (const comment of inline) {
      const reactions = reviewReactions.get(comment.id) ?? [];
      if (reactions.some((r) => r.user.login === self && r.content === ADDRESSED_REACTION)) continue;

      const line = comment.position ?? comment.original_position ?? null;
      const location = line ? `${comment.path ?? ""}:${line}` : (comment.path ?? "");
      const commentBody = guardContent(comment.body ?? "", guardCtx("review-comments"));
      humanParts.push(
        `Inline comment by @${comment.user?.login ?? ""} on ${location}:\n` +
          `\`\`\`\n${comment.diff_hunk ?? ""}\n\`\`\`\n${commentBody}`,
      );
      reviewCommentIds.push(comment.id);
    }

    // An advisory-only review is held aside until the loop finishes: it is only
    // real work when nothing else is pending.
    let advisoryCandidate:
      | { part: string; comment: NonNullable<PRReviewData["prReviewComment"]> }
      | null = null;

    const needsReactions = (c: { user?: { login: string } | null; body?: string | null }): boolean => {
      const body = c.body ?? "";
      if (!body.trim()) return false;
      if (body.trim().toUpperCase() === "LGTM") return false;
      const login = c.user?.login ?? "";
      if (login === self && isClawsComment(body)) {
        return !body.includes("## PR Review") && !body.includes("review-addresser-summary");
      }
      return !login.endsWith("[bot]");
    };
    const issueReactions = await prefetchReactions(
      repo,
      issueComments.filter(needsReactions).map((c) => c.id),
      getCommentReactions,
    );

    for (const raw of issueComments) {
      const body = raw.body ?? "";
      const login = raw.user?.login ?? "";
      if (!body.trim()) continue;
      if (body.trim().toUpperCase() === "LGTM") continue;
      if (login === self && isClawsComment(body)) {
        if (body.includes("## PR Review")) {
          const commitMatch = body.match(REVIEWED_COMMIT_PATTERN);
          if (commitMatch) {
            if (!headSha) headSha = await getPRHeadSHA(repo, prNumber);
            const reviewedCommit = commitMatch[1]!;
            // Skip stale reviews (reviewed a different commit than current HEAD)
            if (!headSha.startsWith(reviewedCommit)) continue;
            const addressedMatch = body.match(REVIEW_ADDRESSED_PATTERN);
            if (addressedMatch && addressedMatch[1] === reviewedCommit) continue;
          }

          const currentBody = body.replace(/<details>[\s\S]*?<\/details>/gi, "");
          if (currentBody.includes(REVIEW_CLEAN_MARKER)) continue;
          // Escalated reviews are always skipped — a human owns them. Checked
          // before the advisory branch so an escalated review is never picked up.
          if (currentBody.includes(REVIEW_ESCALATED_MARKER)) continue;
          const isAdvisory = currentBody.includes(REVIEW_ADVISORY_MARKER);
          if (isAdvisory && !opts.includeAdvisory) continue;
          // One-shot guard: check the RAW body so a stamp that has since been
          // archived into the collapsed audit log still counts.
          if (isAdvisory && ADVISORY_ADDRESSED_PATTERN.test(body)) continue;

          const stripped = stripClawsMarker(body);
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
            const strippedForAddresser = stripped.replace(/<details>[\s\S]*?<\/details>/gi, "").trim();
            const reviewComment = {
              id: raw.id,
              body,
              reviewedCommit: commitMatch ? commitMatch[1]! : "",
            };
            const part = `Comment by @${login} (automated by Claws):\n${strippedForAddresser}`;
            if (isAdvisory) {
              advisoryCandidate = { part, comment: reviewComment };
              continue;
            }
            clawsReviewParts.push(part);
            prReviewComment = reviewComment;
          }
          continue;
        }

        // Skip the addresser's own rolling summary comment.
        if (body.includes("review-addresser-summary")) continue;

        const reactions = issueReactions.get(raw.id) ?? await getCommentReactions(repo, raw.id);
        if (reactions.some((r) => r.user.login === self && r.content === ADDRESSED_REACTION)) continue;
        const hasHumanApproval = reactions.some((r) => r.content === "+1" && !r.user.login.endsWith("[bot]"));

        clawsOtherParts.push(`Comment by @${login} (automated by Claws):\n${stripClawsMarker(body)}`);
        if (hasHumanApproval) commentIds.push(raw.id);
        continue;
      }
      if (login.endsWith("[bot]")) continue;

      const reactions = issueReactions.get(raw.id) ?? await getCommentReactions(repo, raw.id);
      if (reactions.some((r) => r.user.login === self && r.content === ADDRESSED_REACTION)) continue;

      humanParts.push(`Comment by @${login}:\n${guardContent(body, guardCtx("review-comments"))}`);
      commentIds.push(raw.id);
    }

    let advisoryOnly = false;
    const nothingElse =
      humanParts.length === 0 &&
      clawsReviewParts.length === 0 &&
      clawsOtherParts.length === 0 &&
      commentIds.length === 0 &&
      reviewCommentIds.length === 0;
    if (advisoryCandidate && nothingElse) {
      clawsReviewParts.push(advisoryCandidate.part);
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
      htmlBodies: [],
      prReviewComment,
      advisoryOnly,
    };
  } catch (err) {
    log.warn(`getPRReviewComments for PR #${prNumber} in ${repo}: ${err}`);
    return empty;
  }
}

/**
 * Human sign-off on a PR.
 *
 * Forgejo has no GraphQL review-thread API, so the GitHub path's
 * "all threads resolved" requirement cannot be reproduced and is deliberately
 * skipped. Sign-off is instead either a native APPROVED review on the current
 * head SHA, or the same bare-`LGTM` comment the GitHub path accepts — in both
 * cases from an allowed human actor, and in both cases only counted when it
 * lands after the head commit was pushed.
 */
export async function hasValidLGTM(repo: string, prNumber: number, baseBranch: string): Promise<boolean> {
  void baseBranch; // Gitea exposes no per-PR commit list to detect merge-from-base commits.
  try {
    const pull = await fetchPull(repo, prNumber);
    const headSha = pull.head?.sha ?? "";
    const self = await forgejoSelfLogin().catch(() => "");

    const isHumanApprover = (login: string): boolean =>
      Boolean(login) && login !== self && !login.endsWith("[bot]") && ALLOWED_ACTORS.includes(login);

    // 1. A native APPROVED review pinned to the current head SHA.
    const reviews = await fetchReviews(repo, prNumber);
    for (const review of reviews) {
      if ((review.state ?? "").toUpperCase() !== "APPROVED") continue;
      if (!isHumanApprover(review.user?.login ?? "")) continue;
      if (headSha && review.commit_id && review.commit_id !== headSha) continue;
      return true;
    }

    // 2. A bare `LGTM` comment posted after the head commit landed.
    const headCommittedAt = headSha ? await getCommitCommittedAt(repo, headSha) : null;
    const comments = await forgejoGetAll(
      z.array(GiteaCommentSchema),
      `/repos/${repo}/issues/${prNumber}/comments`,
      `comments for LGTM on ${repo}#${prNumber}`,
    );
    for (const c of comments) {
      const body = c.body ?? "";
      if (body.trim().toUpperCase() !== "LGTM") continue;
      if (isClawsComment(body)) continue;
      if (!isHumanApprover(c.user?.login ?? "")) continue;
      if (!headCommittedAt) return true;
      if (c.created_at && c.created_at > headCommittedAt) return true;
    }
    return false;
  } catch (err) {
    log.warn(`hasValidLGTM for PR #${prNumber} in ${repo}: ${err}`);
    return false;
  }
}

// ── Repository contents ──

const GiteaReleaseSchema = z.object({
  tag_name: z.string(),
  name: z.string().nullish(),
  published_at: z.string().nullish(),
  prerelease: z.boolean().nullish(),
  draft: z.boolean().nullish(),
  html_url: z.string().nullish(),
});

/** Releases on `repo`, newest-first. Returns [] on any failure, matching github.ts. */
export async function listReleases(repo: string): Promise<ReleaseInfo[]> {
  try {
    const raw = await forgejoGetAll(z.array(GiteaReleaseSchema), `/repos/${repo}/releases`, `releases for ${repo}`);
    return raw.map((r) => ({
      tag: r.tag_name,
      name: r.name ?? "",
      publishedAt: r.published_at ?? null,
      prerelease: r.prerelease === true,
      draft: r.draft === true,
      url: r.html_url ?? `${FORGEJO_BASE_URL.replace(/\/+$/, "")}/${repo}/releases/tag/${r.tag_name}`,
    }));
  } catch (err) {
    log.warn(`[forgejo] listReleases(${repo}): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Create `newBranch` off `baseBranch`. Gitea has no git-refs write API, but its
 * branch endpoint takes the two names directly. A 409 (branch already exists) is
 * swallowed so retries stay idempotent, matching github.ts's 422 handling.
 */
export async function createBranchRef(repo: string, newBranch: string, baseBranch: string): Promise<void> {
  try {
    await forgejoSend("POST", `/repos/${repo}/branches`, {
      new_branch_name: newBranch,
      old_branch_name: baseBranch,
    });
  } catch (err) {
    if (statusOf(err) === 409) return;
    throw err;
  }
}

export async function fetchRepoFileContent(repo: string, path: string): Promise<string | null> {
  let raw: z.infer<typeof GiteaContentsSchema>;
  try {
    raw = await forgejoFetch(GiteaContentsSchema, "GET", `/repos/${repo}/contents/${path}`);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  if (!raw.content) return null;
  return Buffer.from(raw.content, "base64").toString("utf8");
}

export async function fetchRepoFileWithSha(
  repo: string,
  path: string,
  ref?: string,
): Promise<{ content: string; sha: string } | null> {
  const endpoint = ref
    ? `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`
    : `/repos/${repo}/contents/${path}`;
  let raw: z.infer<typeof GiteaContentsSchema>;
  try {
    raw = await forgejoFetch(GiteaContentsSchema, "GET", endpoint);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  if (!raw.content || !raw.sha) return null;
  return { content: Buffer.from(raw.content, "base64").toString("utf8"), sha: raw.sha };
}

/** A missing/renamed directory (404) yields [] so callers can still render. */
export async function listRepoDirectory(repo: string, dirPath: string): Promise<RepoDirEntry[]> {
  let raw: z.infer<typeof GiteaContentsSchema>[];
  try {
    raw = await forgejoFetch(z.array(GiteaContentsSchema), "GET", `/repos/${repo}/contents/${dirPath}`);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  return raw
    .filter((e) => e.name && e.path && e.sha && e.type)
    .map((e) => ({ name: e.name!, path: e.path!, sha: e.sha!, type: e.type! }));
}

/** Create or update a file on a branch. Pass `sha` only when updating. */
export async function putRepoFile(
  repo: string,
  branch: string,
  path: string,
  contentBase64: string,
  message: string,
  sha?: string,
): Promise<void> {
  await forgejoSend("PUT", `/repos/${repo}/contents/${path}`, {
    message,
    content: contentBase64,
    branch,
    ...(sha ? { sha } : {}),
  });
}

// ── Forgejo Actions run history ──

/** Structurally identical to db.MainBuildRunRow so main-build-monitor can share one code path. */
export interface ForgejoActionRunRow {
  run_id: number;
  workflow_name: string;
  conclusion: string | null;
  event: string;
  created_at: string;
  head_sha: string | null;
  html_url: string | null;
  run_attempt: number | null;
}

/**
 * Forgejo's run record carries no `conclusion` — `status` holds the outcome. These are
 * the terminal values; `unknown`/`waiting`/`running`/`blocked` mean the run has not
 * finished and must be dropped, mirroring github.ts's `status = 'completed'` filter.
 */
const FORGEJO_TERMINAL_STATUSES = new Set(["success", "failure", "cancelled", "skipped"]);

const ForgejoActionRunSchema = z.object({
  id: z.number(),
  workflow_id: z.string(),
  status: z.string(),
  event: z.string(),
  created: z.string(),
  commit_sha: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  prettyref: z.string().nullable().optional(),
});

const ForgejoActionRunsSchema = z.object({
  workflow_runs: z.array(ForgejoActionRunSchema).nullable().optional(),
});

/**
 * Completed default-branch `push`/`schedule` runs, newest first — the Forgejo
 * equivalent of db.getDefaultBranchRuns(). Two server-side filtered calls rather than
 * one unfiltered page: perudo's run list is dominated by pull_request runs, so an
 * unfiltered limit=50 window could push the last main run off the end.
 *
 * An expired/missing token surfaces as a 404 here, not a 401 — indistinguishable from
 * "endpoint does not exist" at this layer.
 */
export async function listDefaultBranchActionRuns(
  repo: string,
  defaultBranch: string,
): Promise<ForgejoActionRunRow[]> {
  const out: ForgejoActionRunRow[] = [];
  for (const event of ["push", "schedule"]) {
    const res = await forgejoFetch(
      ForgejoActionRunsSchema,
      "GET",
      `/repos/${repo}/actions/runs?limit=30&event=${event}`,
    );
    for (const r of res.workflow_runs ?? []) {
      if (!FORGEJO_TERMINAL_STATUSES.has(r.status)) continue;
      // `prettyref` is Gitea's PrettyRef(): a branch push gives the bare branch name,
      // a PR run gives "#287". The event filter should already exclude PRs; this is
      // the branch guard the API offers no parameter for.
      if (r.prettyref !== defaultBranch) continue;
      out.push({
        run_id: r.id,
        // The run record carries no display name, only the workflow file name
        // (e.g. "deploy.yml") — the tracking issue title uses that file name.
        workflow_name: r.workflow_id,
        conclusion: r.status,
        event: r.event,
        created_at: r.created,
        head_sha: r.commit_sha ?? null,
        html_url: r.html_url ?? null,
        run_attempt: null,
      });
    }
  }
  out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return out;
}

// ── Surfaces Forgejo does not provide ──
//
// Each degrades to the value github.ts already returns on its own failure path,
// so callers need no Forgejo-specific branch.

/**
 * Gitea's issue timeline carries no `cross-referenced` event, so phase accounting
 * on a Forgejo repo sees only the `claws/issue-<N>-` branch PRs that
 * listMergedPRsForIssue/getOpenPRForIssue already report — the same degradation
 * github.ts falls back to when the timeline call fails. Returning `[]` is what
 * keeps a hand-rolled Forgejo PR from being *missed*; it must never return the
 * GitHub mirror's timeline, which would mark a phase covered that isn't (#2650).
 */
export async function listPRsCrossReferencingIssue(repo: string, issueNumber: number): Promise<CrossRefPR[]> {
  log.debug(`[forgejo] listPRsCrossReferencingIssue(${repo}#${issueNumber}): no cross-reference timeline on Forgejo — returning []`);
  return [];
}

/** Forgejo Actions exposes no per-job step breakdown; callers fall back to normal failure handling. */
export async function getRunJobSummaries(repo: string, runId: string): Promise<RunJobSummary[]> {
  log.debug(`[forgejo] getRunJobSummaries(${repo}, ${runId}): unsupported on Forgejo — returning []`);
  return [];
}

/** Forgejo Actions exposes no check-run annotations, so billing/outage detection is GitHub-only. */
export async function getRunAnnotations(repo: string, runId: string): Promise<string[]> {
  log.debug(`[forgejo] getRunAnnotations(${repo}, ${runId}): unsupported on Forgejo — returning []`);
  return [];
}

/**
 * Forgejo Actions has no log-download API. ci-fixer already handles an empty log:
 * the fix prompt carries the failing check's name and `target_url` link instead.
 */
export async function getFailedRunLog(repo: string, prNumber: number): Promise<string> {
  log.debug(`[forgejo] getFailedRunLog(${repo}#${prNumber}): no log API on Forgejo — returning ""`);
  return "";
}

/** No-op: pushing a fix commit triggers a fresh Forgejo Actions run anyway. */
export async function rerunWorkflow(repo: string, runId: string): Promise<void> {
  log.info(`[forgejo] rerunWorkflow(${repo}, ${runId}): not supported on Forgejo — a new commit re-triggers CI`);
}

/** No-op, for the same reason as rerunWorkflow. */
export async function rerunFailedJobs(repo: string, runId: string): Promise<void> {
  log.info(`[forgejo] rerunFailedJobs(${repo}, ${runId}): not supported on Forgejo — a new commit re-triggers CI`);
}

/**
 * Forgejo Actions exposes no run-cancel API. Unlike the rerun helpers this must
 * NOT be a silent no-op: its only caller is the dashboard's Cancel button, and
 * reporting success for a run that keeps going is worse than a visible error.
 */
export async function cancelWorkflow(repo: string, runId: string): Promise<void> {
  throw new Error(`forgejo: cannot cancel run ${runId} on ${repo} — Forgejo Actions has no run-cancel API`);
}
