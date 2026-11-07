/**
 * The only GitHub client in Claws, for repos Claws does not manage.
 *
 * Every managed repo lives on Forgejo and goes through the `github.ts` façade.
 * GitHub is reached for exactly two things: the public snapshot targets that
 * `jobs/public-snapshot-sync.ts` pushes to and mirrors releases onto, and the
 * outside projects (`seerr-team/seerr`, …) whose PRs, issues and releases
 * `jobs/upstream-watcher.ts` reads.
 *
 * Calls run the `gh` CLI with an installation token: the target owner's when
 * the App is installed there, otherwise any installation's, which still gives
 * authenticated read access to public repos. A 5xx or network failure is
 * retried; a rate-limit response throws {@link RateLimitError}.
 */
import { execFile } from "node:child_process";
import { z } from "zod";
import * as log from "./log.js";
import { retryWithBackoff } from "./retry.js";
import { timeForgeCall } from "./metrics.js";
import { RateLimitError } from "./rate-limit.js";
import { buildEnvForGh, getAnyInstallationToken, getInstallationTokenForOwner, githubAppOwners } from "./github-app.js";
import type { IssueState, ReleaseInfo, UpstreamPRStatus } from "./github.js";

const MAX_RETRIES = 3;
const RATE_LIMIT_RE = /rate limit/i;

// `gh` prints `HTTP 502: Bad gateway …` for a GitHub-side 5xx. The literal
// "HTTP" keeps a 502 that appears in an issue title from matching. The
// network phrases cover a connection dropped before any response arrived.
const TRANSIENT_RE =
  /\bHTTP[ :]?(500|502|503|504)\b|\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAGAIN|connection reset)\b|TLS handshake timeout|i\/o timeout|(?:^|[\s:])EOF\b/i;

/** The installation token for `owner`, or any installation's for an owner the App is not on. */
async function tokenFor(owner: string): Promise<string | null> {
  try {
    return githubAppOwners().includes(owner)
      ? await getInstallationTokenForOwner(owner)
      : await getAnyInstallationToken();
  } catch (err) {
    log.warn(`[github-external] No installation token for ${owner}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Run `gh` against `repo` (owner/name), returning stdout. */
async function ghFor(repo: string, args: string[]): Promise<string> {
  const env = buildEnvForGh(await tokenFor(repo.split("/")[0]));
  return timeForgeCall("github", () => retryWithBackoff(
    () => new Promise<string>((resolve, reject) => {
      execFile("gh", args, { maxBuffer: 10 * 1024 * 1024, env }, (err, stdout, stderr) => {
        if (!err) {
          resolve(stdout);
          return;
        }
        const msg = stderr || err.message;
        if (RATE_LIMIT_RE.test(msg)) {
          reject(new RateLimitError(`gh ${args[0]} ${repo} failed: ${msg}`));
          return;
        }
        reject(new Error(`gh ${args.join(" ")} failed: ${msg}`));
      });
    }),
    MAX_RETRIES,
    (err) => !(err instanceof RateLimitError) && TRANSIENT_RE.test(err.message),
    `gh ${args[0]} ${repo}`,
  ));
}

function parseJson<T>(schema: z.ZodType<T>, raw: string, context: string): T {
  try {
    return schema.parse(JSON.parse(raw.trim()));
  } catch (err) {
    throw new Error(`Unexpected response from gh ${context}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isNotFound(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /\b40[34]\b/.test(msg) || /not found/i.test(msg) || /could not resolve/i.test(msg);
}

// ── Public snapshot targets ──

/** Read-only snapshot-target state, used by the public-snapshot-sync job. */
export interface SnapshotTargetState { exists: boolean; archived: boolean; defaultBranch: string; }

/**
 * Inspect a public snapshot target repo. Purely read-only: it reports whether
 * the target exists and whether it is archived, but NEVER un-archives it. A 404
 * (repo not created yet) resolves to `exists: false` so the caller can alert and
 * skip. See `jobs/public-snapshot-sync.ts` (#1826).
 */
export async function ensureSnapshotTarget(target: string): Promise<SnapshotTargetState> {
  try {
    const meta = await ghFor(target, ["api", `repos/${target}`, "--jq",
      "{archived: .archived, default_branch: .default_branch}"]);
    const parsed = JSON.parse(meta) as { archived: boolean; default_branch: string };
    return { exists: true, archived: parsed.archived, defaultBranch: parsed.default_branch || "main" };
  } catch {
    return { exists: false, archived: false, defaultBranch: "main" }; // 404 → caller alerts + skips
  }
}

/** Best-effort disable of Dependabot on a repo; tolerates 404s (feature already off). */
export async function disableDependabot(repo: string): Promise<void> {
  for (const ep of ["automated-security-fixes", "vulnerability-alerts"]) {
    try { await ghFor(repo, ["api", `repos/${repo}/${ep}`, "--method", "DELETE"]); }
    catch (err) { log.warn(`[disableDependabot] ${repo} ${ep}: ${err instanceof Error ? err.message : String(err)}`); }
  }
}

/** All stable (non-draft, non-prerelease) release tags on `repo`, newest-first. (#1941) */
export async function listStableReleaseTags(repo: string): Promise<string[]> {
  try {
    const out = await ghFor(repo, ["api", `repos/${repo}/releases?per_page=100`, "--jq",
      ".[] | select(.prerelease == false and .draft == false) | .tag_name"]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Asset filenames on `repo`'s release `tag`. Returns null when the release does not exist. (#1851) */
export async function getReleaseAssetNames(repo: string, tag: string): Promise<string[] | null> {
  try {
    const out = await ghFor(repo, ["release", "view", tag, "--repo", repo, "--json", "assets",
      "--jq", ".assets[].name"]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return null; // release absent
  }
}

/** Create a release on `repo`@`tag` anchored at `targetCommitish`, attaching `assetPaths`. (#1851) */
export async function createRelease(repo: string, tag: string, assetPaths: string[], targetCommitish: string, title: string, opts?: { latest?: boolean }): Promise<void> {
  await ghFor(repo, ["release", "create", tag, ...assetPaths, "--repo", repo, "--title", title,
    "--target", targetCommitish, "--notes", `Public snapshot release ${tag}.`,
    ...(opts?.latest === false ? ["--latest=false"] : [])]);
}

/** Tag of `repo`'s Latest release, or null when none / on error. */
export async function getLatestReleaseTag(repo: string): Promise<string | null> {
  try {
    const out = (await ghFor(repo, ["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"])).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Mark `repo`'s existing release `tag` as Latest. */
export async function markReleaseLatest(repo: string, tag: string): Promise<void> {
  await ghFor(repo, ["release", "edit", tag, "--repo", repo, "--latest"]);
}

/** Upload (clobbering) `assetPaths` to an existing release on `repo`@`tag`. (#1851) */
export async function uploadReleaseAssets(repo: string, tag: string, assetPaths: string[]): Promise<void> {
  await ghFor(repo, ["release", "upload", tag, ...assetPaths, "--repo", repo, "--clobber"]);
}

// ── Upstream reads ──

const ReleaseInfoSchema = z.object({
  tag: z.string(),
  name: z.string(),
  publishedAt: z.string().nullable(),
  prerelease: z.boolean(),
  draft: z.boolean(),
  url: z.string(),
});

/**
 * Recent releases on `repo`, newest-first, keeping drafts and prereleases so
 * the upstream-watcher can apply its own filter. Returns [] on any failure
 * other than a rate limit. (#2617)
 */
export async function listReleases(repo: string): Promise<ReleaseInfo[]> {
  try {
    const raw = await ghFor(repo, ["api", `repos/${repo}/releases?per_page=50`, "--jq",
      "[.[] | {tag: .tag_name, name: (.name // \"\"), publishedAt: .published_at, prerelease, draft, url: .html_url}]"]);
    return parseJson(z.array(ReleaseInfoSchema), raw, `releases for ${repo}`);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    return [];
  }
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
 * Merge status of a PR in an outside repo. Returns null when the PR does not
 * exist (404/403). (#2617)
 *
 * `title` is third-party text — guard it before embedding it anywhere an agent
 * will later read.
 */
export async function getUpstreamPRStatus(repo: string, prNumber: number): Promise<UpstreamPRStatus | null> {
  let raw: string;
  try {
    raw = await ghFor(repo, ["api", `repos/${repo}/pulls/${prNumber}`, "--jq",
      "{state, merged, mergedAt: .merged_at, title, url: .html_url, updatedAt: .updated_at}"]);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    if (isNotFound(err)) return null;
    throw err;
  }
  const parsed = parseJson(UpstreamPRStatusSchema, raw, `upstream pr ${repo}#${prNumber}`);
  return { ...parsed, state: parsed.state.toLowerCase() === "closed" ? "closed" : "open" };
}

/**
 * Open/closed state of an issue in an outside repo. Throws a not-found error
 * (matching `/not found/i`) when the issue does not exist.
 */
export async function getIssueState(repo: string, issueNumber: number): Promise<{ state: IssueState; stateReason: string | null }> {
  const raw = await ghFor(repo, ["api", `repos/${repo}/issues/${issueNumber}`, "--jq",
    "{state, stateReason: .state_reason}"]);
  const parsed = parseJson(z.object({ state: z.string(), stateReason: z.string().nullable() }), raw, `issue ${repo}#${issueNumber}`);
  return { state: parsed.state.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN", stateReason: parsed.stateReason };
}
