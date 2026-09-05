import { z } from "zod";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, PROMPT_CAPTURE_DIR, CLAUDE_TIMEOUT_MS, CLAUDE_LIVENESS_TIMEOUT_MS, CLAUDE_WORKER_MEMORY_MAX_BYTES, SERVER_PORT, INTERNAL_MCP_TOKEN, HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN, OPENROUTER_API_KEY, PROVIDER_RATE_LIMIT_COOLDOWN_MS, forgejoRepoUrl, type Repo } from "./config.js";
import * as log from "./log.js";
import { runContext } from "./log.js";
import { formatMs } from "./format.js";
import { isShuttingDown, ShutdownError } from "./shutdown.js";
import { guardContent } from "./prompt-guard.js";
import { getModel, getFallbackOrder, getDeepModel, type ModelTier } from "./model-selector.js";
import type { Provider } from "./plan-parser.js";
import { isRateLimitError } from "./ollama-rate-limit-classifier.js";
import { getInstallationTokenForOwner, buildEnvForGh, buildGitEnvForOwner } from "./github-app.js";
import { retryWithBackoff } from "./retry.js";
import { SENSITIVE_ENV_KEYS } from "./sensitive-env.js";
import { noteAgentAuthSuccess } from "./agent-auth-state.js";

export { SENSITIVE_ENV_KEYS };

export function sanitiseEnvForChild(env: NodeJS.ProcessEnv, mode: "strict" | "passthrough"): NodeJS.ProcessEnv {
  const out = { ...env };
  if (mode === "strict") {
    for (const k of SENSITIVE_ENV_KEYS) delete out[k];
  }
  return out;
}

function resolvePromptCaptureDir(): string | null {
  const flag = process.env["CLAWS_PROMPT_CAPTURE"];
  if (flag === "1" || flag === "true") {
    // explicit opt-in
    return process.env["CLAWS_PROMPT_CAPTURE_DIR"] || PROMPT_CAPTURE_DIR;
  }
  return null; // capture is off by default
}

function capturePromptExchange(dir: string, record: {
  prompt: string; cwd: string; options?: RunClaudeOptions;
  output?: string; ok: boolean; errorMessage?: string;
}): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      label: record.options?.captureLabel ?? path.basename(record.cwd) ?? "unlabeled",
      tier: record.options?.tier,
      model: record.options?.model,
      cwd: record.cwd,
      appendSystemPrompt: record.options?.appendSystemPrompt,
      prompt: record.prompt,
      output: record.output,
      ok: record.ok,
      errorMessage: record.errorMessage,
    }) + "\n";
    fs.promises.appendFile(path.join(dir, `prompts-${day}.jsonl`), line).catch((err) => {
      log.warn(`[prompt-capture] failed to write capture: ${err instanceof Error ? err.message : String(err)}`);
    });
  } catch (err) {
    log.warn(`[prompt-capture] failed to write capture: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Generate a short random suffix for branch names (4 hex chars). */
export function randomSuffix(): string {
  return crypto.randomBytes(2).toString("hex");
}

/** Compact date string for branch names (YYYYMMDD). */
export function datestamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// ── Git helpers ──

// Retry eligibility for git subprocesses. The first group of alternatives is
// HTTPS/libcurl and Node-errno phrasing; the trailing group is OpenSSH's own
// wording, which shares no substring with them — a git remote on an `ssh://` or
// `git@github.com:` URL reports a connect timeout as
// `ssh: connect to host github.com port 22: Connection timed out`, which matched
// nothing here and so failed with zero retries (#2471). The final pair is git's ref
// compare-and-swap failure (`cannot lock ref 'refs/remotes/origin/main': is at X but
// expected Y` / `unable to update local ref`). Worktrees share the main clone's `.git`
// ref database, so a `git fetch` an agent runs itself inside a worktree can race
// ensureClone's fetch on the same repo; the loser is stale by milliseconds and
// succeeds on retry (#2824). Permanent SSH failures (`Permission denied (publickey)`,
// `Host key verification failed`, `Repository not found`) deliberately still match nothing.
const GIT_TRANSIENT_RE = /\b(500|502|503|504|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAGAIN|connection reset)\b|TLS handshake timeout|Could not resolve host|The requested URL returned error: 5\d\d|i\/o timeout|failed to create new OS thread|resource temporarily unavailable|Connection timed out|Connection refused|Network is unreachable|Connection closed by remote host|kex_exchange_identification|client_loop: send disconnect|cannot lock ref|unable to update local ref/i;
const GIT_MAX_RETRIES = 2;

// Push rejections that a fetch-rebase-push retry can resolve. `non-fast-forward`
// is the classic concurrent-push race. `cannot lock ref ...: reference already
// exists` is GitHub's server-side ref race on a *create*: receive-pack applied
// (or is concurrently applying) the ref while our client still had the old ref
// advertisement, so it sent a create command for a ref that now exists (#2834).
// Retrying fetches the now-visible ref, rebases onto it (a no-op when it is our
// own commit) and pushes again. Deliberately does NOT match permanent rejections
// (`could not read Username`, `protected branch`, `shallow update not allowed`).
const PUSH_RETRYABLE_RE = /non-fast-forward|cannot lock ref|reference already exists/i;

async function resolveEnvForGit(owner?: string): Promise<NodeJS.ProcessEnv | undefined> {
  if (!owner) return undefined;
  return buildGitEnvForOwner(owner);
}

export function git(args: string[], cwd: string, opts: { maxBuffer?: number; owner?: string } = {}): Promise<string> {
  const maxBuffer = opts.maxBuffer ?? 10 * 1024 * 1024;
  return retryWithBackoff(
    async () => {
      const env = await resolveEnvForGit(opts.owner);
      return new Promise<string>((resolve, reject) => {
        execFile("git", args, { cwd, maxBuffer, env }, (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || err.message}`));
          } else {
            resolve(stdout.trim());
          }
        });
      });
    },
    GIT_MAX_RETRIES,
    (err) => GIT_TRANSIENT_RE.test(err.message),
    `git ${args[0]}`,
  );
}

/** Like git() but returns { code, stdout, stderr } instead of throwing. */
function gitRaw(
  args: string[],
  cwd: string,
  opts: { owner?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    (async () => {
      const env = await resolveEnvForGit(opts.owner);
      execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024, env }, (err, stdout, stderr) => {
        const code = err && "code" in err ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      });
    })().catch(reject);
  });
}

export function repoDir(repo: Repo): string {
  return path.join(WORK_DIR, "repos", repo.owner, repo.name);
}

/** True if the clone at `dir` is shallow (non-empty .git/shallow graft file).
 *  Shallow state lives in the shared .git dir, so a shallow fetch run by an
 *  agent inside any worktree breaks `git diff origin/<base>...HEAD`
 *  ("no merge base") for every later job on that repo. */
function isShallowClone(dir: string): boolean {
  const shallowPath = path.join(dir, ".git", "shallow");
  try {
    if (!fs.existsSync(shallowPath)) return false;
    const content = fs.readFileSync(shallowPath, "utf8");
    return typeof content === "string" && content.trim().length > 0;
  } catch {
    return false;
  }
}

/** Isolated scratch cwd for text-only agents not tied to a repo worktree.
 *  NEVER pass process.cwd() (the systemd WorkingDirectory / prod install) as a
 *  cwd to runClaude — see email-monitor / whatsapp-handler. */
export function ensureScratchDir(namespace: string): string {
  const dir = path.join(WORK_DIR, "scratch", namespace);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Best-effort recursive directory removal using the system `rm -rf`. Handles
 *  very wide trees (e.g. node_modules with ~6,500 files) more reliably than
 *  Node's internal rimraf, which throws ENOTEMPTY on Linux for large directories.
 *  Errors are swallowed — callers use this only as a cleanup fallback. */
function rmrf(p: string): Promise<void> {
  return new Promise((resolve) => {
    execFile("rm", ["-rf", "--", p], { maxBuffer: 1024 * 1024 }, () => resolve());
  });
}

/**
 * In-flight ensureClone promises, keyed by repo directory path.
 * Prevents concurrent git fetch operations on the same clone directory.
 */
const inflightClones = new Map<string, Promise<string>>();

/**
 * Per-repo mutex to serialize git worktree operations (prune, add, remove)
 * on the same .git directory. Prevents races where concurrent worktree
 * commands corrupt each other's admin files.
 */
const worktreeLocks = new Map<string, Promise<void>>();

function withWorktreeLock<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = worktreeLocks.get(repoDir) ?? Promise.resolve();
  let resolve!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });
  worktreeLocks.set(repoDir, gate);
  return prev.then(() => fn()).finally(() => resolve());
}

/** Reset the worktree lock map. Exported for test use. */
export function resetWorktreeLocks(): void {
  worktreeLocks.clear();
}

/** Timestamp (Date.now()) of last successful git fetch per repo directory. */
const lastFetchedAt = new Map<string, number>();

/** Clear the fetch timestamp cache. Exported for test use. */
export function resetFetchCache(): void {
  lastFetchedAt.clear();
}

const FETCH_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface EnsureCloneOptions {
  /** When true, skip git fetch if the repo was fetched within the TTL (30 min).
   *  Only appropriate for batch/scanner paths — event-driven agents should
   *  always fetch to avoid working on stale data. */
  skipFetchIfRecent?: boolean;
}

/** Repair a shallow clone in place. Best-effort: on failure we log and continue,
 *  since the caller may still be able to do useful non-diff work. */
async function unshallowIfNeeded(dir: string, owner: string): Promise<void> {
  if (!isShallowClone(dir)) return;
  log.info(`[ensureClone] ${dir} is a shallow clone — running git fetch --unshallow to repair`);
  try {
    await git(["fetch", "--unshallow"], dir, { owner });
    log.info(`[ensureClone] unshallowed ${dir}`);
  } catch (err) {
    log.warn(`[ensureClone] git fetch --unshallow failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The clone URL for a repo, on whichever forge owns it. */
function cloneUrl(repo: Repo): string {
  return repo.forge === "forgejo"
    ? `${forgejoRepoUrl(repo.fullName)}.git`
    : `https://github.com/${repo.fullName}.git`;
}

/**
 * Point `origin` at the forge that currently owns the repo. A clone taken before
 * a migration still points at the old host, and every later fetch would silently
 * read the stale mirror. Best-effort: a failure here leaves the clone as it was.
 */
async function reconcileOrigin(dir: string, repo: Repo): Promise<void> {
  const expected = cloneUrl(repo);
  let current: string;
  try {
    current = await git(["remote", "get-url", "origin"], dir);
  } catch (err) {
    log.warn(`[ensureClone] could not read origin for ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  // Compare hosts, not full URLs: an existing origin may legitimately carry a
  // `.git`-less path or an embedded credential.
  const host = (u: string): string => { try { return new URL(u).host; } catch { return u; } };
  if (host(current) === host(expected)) return;
  log.info(`[ensureClone] ${repo.fullName}: origin points at ${host(current)}, expected ${host(expected)} — re-pointing`);
  try {
    await git(["remote", "set-url", "origin", expected], dir, { owner: repo.owner });
  } catch (err) {
    log.warn(`[ensureClone] git remote set-url failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Ensure a bare-ish main clone of the repo exists and is up to date. */
export async function ensureClone(repo: Repo, options?: EnsureCloneOptions): Promise<string> {
  const dir = repoDir(repo);

  // If this repo was fetched recently and the caller opts in, skip the fetch
  if (options?.skipFetchIfRecent) {
    const lastFetch = lastFetchedAt.get(dir);
    if (lastFetch && Date.now() - lastFetch < FETCH_TTL_MS
        && fs.existsSync(path.join(dir, ".git"))
        && !isShallowClone(dir)) {
      return dir;
    }
  }

  const inflight = inflightClones.get(dir);
  if (inflight) return inflight;

  const work = (async () => {
    try {
      if (fs.existsSync(path.join(dir, ".git"))) {
        await reconcileOrigin(dir, repo);
        await unshallowIfNeeded(dir, repo.owner);
        await git(["fetch", "--all", "--prune"], dir, { owner: repo.owner });
        await git(["checkout", `origin/${repo.defaultBranch}`, "--force"], dir, { owner: repo.owner });
      } else if (repo.forge === "forgejo") {
        // `gh` cannot talk to Forgejo. Plain git works because buildEnvForGhGit
        // injects a credential helper for the Forgejo host alongside GitHub's.
        fs.mkdirSync(dir, { recursive: true });
        await git(["clone", cloneUrl(repo), dir], path.dirname(dir), { owner: repo.owner });
      } else {
        fs.mkdirSync(dir, { recursive: true });
        let cloneEnv: NodeJS.ProcessEnv | undefined;
        try {
          const token = await getInstallationTokenForOwner(repo.owner);
          cloneEnv = buildEnvForGh(token);
        } catch (err) {
          log.warn(`[github-app] clone token fetch failed for ${repo.owner}: ${err instanceof Error ? err.message : String(err)}`);
        }
        await new Promise<void>((resolve, reject) => {
          execFile(
            "gh",
            ["repo", "clone", repo.fullName, dir],
            { env: cloneEnv },
            (err) => (err ? reject(err) : resolve()),
          );
        });
      }
      lastFetchedAt.set(dir, Date.now());
      return dir;
    } finally {
      inflightClones.delete(dir);
    }
  })();

  inflightClones.set(dir, work);
  return work;
}

/** Pre-fetch all repos sequentially, populating the fetch cache. */
export async function refreshAllRepos(repos: Repo[]): Promise<void> {
  for (const repo of repos) {
    try {
      await ensureClone(repo, { skipFetchIfRecent: true });
    } catch (err) {
      log.warn(`[refreshAllRepos] Failed to fetch ${repo.fullName}: ${err}`);
    }
  }
}

/** Create a worktree on a new branch. Returns the worktree path. */
export async function createWorktree(repo: Repo, branchName: string, namespace: string): Promise<string> {
  const mainDir = await ensureClone(repo);
  const wtPath = path.join(WORK_DIR, "worktrees", repo.owner, repo.name, namespace, branchName);

  return withWorktreeLock(mainDir, async () => {
    // Clean up stale worktree at this path if it exists
    if (fs.existsSync(wtPath)) {
      const nmRoot = path.join(wtPath, "node_modules");
      if (fs.existsSync(nmRoot)) {
        await rmrf(nmRoot);
      }
      try {
        await git(["worktree", "remove", wtPath, "--force"], mainDir);
      } catch {
        await rmrf(wtPath);
      }
    }

    // Delete stale local branch if it exists from a previous run
    try {
      await git(["branch", "-D", branchName], mainDir);
    } catch {
      // Branch doesn't exist, that's fine
    }

    // Prune stale worktree metadata (e.g. from other jobs whose directories were removed)
    await git(["worktree", "prune"], mainDir);

    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    await git(["worktree", "add", wtPath, "-b", branchName, "--no-track", `origin/${repo.defaultBranch}`], mainDir);
    return wtPath;
  });
}

/** Create a worktree for an existing remote branch. Returns the worktree path.
 *  When `options.detach` is true, uses `--detach` to check out the commit at the
 *  branch tip without locking the branch — allowing multiple worktrees to read
 *  the same branch simultaneously. Use for read-only jobs (pr-reviewer).
 */
export async function createWorktreeFromBranch(
  repo: Repo,
  branchName: string,
  namespace: string,
  options?: { detach?: boolean },
): Promise<string> {
  const mainDir = await ensureClone(repo);
  const wtPath = path.join(WORK_DIR, "worktrees", repo.owner, repo.name, namespace, branchName);
  // Use a namespace-scoped local branch to avoid collisions when multiple jobs
  // check out the same remote branch concurrently (git enforces one-worktree-per-branch).
  const localBranch = `claws-wt/${namespace}/${branchName}`;

  return withWorktreeLock(mainDir, async () => {
    if (fs.existsSync(wtPath)) {
      const nmRoot = path.join(wtPath, "node_modules");
      if (fs.existsSync(nmRoot)) {
        await rmrf(nmRoot);
      }
      try {
        await git(["worktree", "remove", wtPath, "--force"], mainDir);
      } catch {
        await rmrf(wtPath);
      }
    }

    // Prune stale worktree metadata (e.g. from other jobs whose directories were removed)
    await git(["worktree", "prune"], mainDir);

    // Verify the remote ref exists before attempting worktree creation.
    // This catches the race where a PR is merged (and its branch deleted) between
    // listPRs() and this call — git fetch --prune in ensureClone removes the ref.
    const refCheck = await gitRaw(["rev-parse", "--verify", `origin/${branchName}`], mainDir);
    if (refCheck.code !== 0) {
      throw new BranchDeletedError(branchName);
    }

    fs.mkdirSync(path.dirname(wtPath), { recursive: true });

    if (options?.detach) {
      // Detached HEAD mode — no local branch created, no branch lock acquired.
      await git(["worktree", "add", "--detach", wtPath, `origin/${branchName}`], mainDir);
      return wtPath;
    }

    // Delete the namespace-scoped local branch if it exists from a previous run
    try {
      await git(["branch", "-D", localBranch], mainDir);
    } catch {
      // Branch may not exist locally yet, that's fine
    }

    try {
      await git(["worktree", "add", "-b", localBranch, wtPath, "--no-track", `origin/${branchName}`], mainDir);
    } catch (err) {
      // Defensive fallback: if the branch is already checked out in another worktree,
      // retry with --detach so the job degrades to read-only rather than crashing.
      if (err instanceof Error && err.message.includes("already used by worktree")) {
        log.warn(`[createWorktreeFromBranch] Branch '${branchName}' locked by another worktree — falling back to detached mode`);
        await git(["worktree", "add", "--detach", wtPath, `origin/${branchName}`], mainDir);
        return wtPath;
      }
      throw err;
    }
    return wtPath;
  });
}

/**
 * Like createWorktreeFromBranch, but returns undefined instead of throwing when
 * the remote branch no longer exists (e.g. deleted after merge). Callers should
 * treat an undefined return as "skip this work item".
 */
export async function createWorktreeFromBranchIfExists(
  repo: Repo,
  branchName: string,
  namespace: string,
  options?: { detach?: boolean },
): Promise<string | undefined> {
  try {
    return await createWorktreeFromBranch(repo, branchName, namespace, options);
  } catch (err) {
    if (err instanceof BranchDeletedError) {
      return undefined;
    }
    throw err;
  }
}

export async function removeWorktree(repo: Repo, wtPath: string): Promise<void> {
  // Drop the agent's MCP config alongside the worktree — it can carry a live
  // Home Assistant token (#2598).
  removeAgentMcpDir(wtPath);

  const mainDir = repoDir(repo);

  // Detect namespace-scoped local branch before removing the worktree
  // (done outside the lock since it reads from the worktree dir, not mainDir)
  let branchToDelete: string | undefined;
  try {
    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], wtPath)).trim();
    if (branch.startsWith("claws-wt/")) branchToDelete = branch;
  } catch {
    // worktree may already be gone
  }

  // Pre-delete node_modules before git's worktree removal. The ci-fixer agent
  // runs `npm install` inside worktrees, and large packages (e.g.
  // @mui/icons-material with ~6,500 files) cause git's recursive removal and
  // Node's rimraf to fail with ENOTEMPTY on Linux. The system `rm -rf` handles
  // these reliably. Best-effort — if it fails, the fallback below still runs.
  try {
    if (fs.existsSync(wtPath)) {
      const nmRoot = path.join(wtPath, "node_modules");
      if (fs.existsSync(nmRoot)) {
        await rmrf(nmRoot);
      }
    }
  } catch {
    // ignore — purely an optimization
  }

  await withWorktreeLock(mainDir, async () => {
    try {
      await git(["worktree", "remove", wtPath, "--force"], mainDir);
    } catch {
      await rmrf(wtPath);
      // Prune stale metadata left behind after manual directory removal
      try {
        await git(["worktree", "prune"], mainDir);
      } catch {
        // best effort
      }
    }

    // Clean up namespace-scoped local branch to prevent accumulation
    if (branchToDelete) {
      try {
        await git(["branch", "-D", branchToDelete], mainDir);
      } catch {
        // may already be gone
      }
    }
  });
}

/**
 * Create a new-branch worktree, run fn, then always remove the worktree.
 */
export async function withNewWorktree<T>(
  repo: Repo,
  branchName: string,
  namespace: string,
  fn: (wtPath: string) => Promise<T>,
): Promise<T> {
  const wtPath = await createWorktree(repo, branchName, namespace);
  try {
    return await fn(wtPath);
  } finally {
    await removeWorktree(repo, wtPath);
  }
}

/**
 * Create a worktree for an existing remote branch, run fn, then always remove.
 * Returns null if the branch no longer exists — callers should treat null as
 * "skip this work item" and record the task as skipped accordingly.
 */
export async function withExistingWorktree<T>(
  repo: Repo,
  branchName: string,
  namespace: string,
  fn: (wtPath: string) => Promise<T>,
  options?: { detach?: boolean },
): Promise<T | null> {
  const wtPath = await createWorktreeFromBranchIfExists(repo, branchName, namespace, options);
  if (wtPath === undefined) return null;
  try {
    return await fn(wtPath);
  } finally {
    await removeWorktree(repo, wtPath);
  }
}

/**
 * Start a merge of origin/<baseBranch> into the current branch.
 * Returns whether the merge was clean and, if not, the list of conflicted files.
 */
export async function attemptMerge(
  wtPath: string,
  baseBranch: string,
): Promise<{ clean: boolean; conflictedFiles: string[] }> {
  const result = await gitRaw(["merge", `origin/${baseBranch}`, "--no-edit"], wtPath);
  if (result.code === 0) {
    return { clean: true, conflictedFiles: [] };
  }
  // Get list of conflicted (unmerged) files
  const unmerged = await gitRaw(["diff", "--name-only", "--diff-filter=U"], wtPath);
  const files = unmerged.stdout.split("\n").filter(Boolean);
  return { clean: false, conflictedFiles: files };
}

/** Abort an in-progress merge. */
export async function abortMerge(wtPath: string): Promise<void> {
  await gitRaw(["merge", "--abort"], wtPath);
}

/** Return the author date of a given commit. */
export async function getCommitDate(wtPath: string, sha: string): Promise<Date> {
  const iso = await git(["log", "-1", "--format=%aI", sha], wtPath);
  return new Date(iso);
}

/** Return the SHA of the most recent [doc-maintainer] commit, or null if none exists. */
export async function getLastDocMaintainerSha(wtPath: string): Promise<string | null> {
  const sha = await git(["log", "--oneline", "--grep=\\[doc-maintainer\\]", "-1", "--format=%H"], wtPath);
  return sha || null;
}

/** Return the current HEAD SHA. */
export async function getHeadSha(wtPath: string): Promise<string> {
  return git(["rev-parse", "HEAD"], wtPath);
}

/** Check if the worktree has new commits compared to origin. */
export async function hasNewCommits(wtPath: string, baseBranch: string): Promise<boolean> {
  const count = await git(["rev-list", "--count", `origin/${baseBranch}..HEAD`], wtPath);
  return parseInt(count, 10) > 0;
}

async function countCommitsInRange(wtPath: string, range: string): Promise<number> {
  const count = await git(["rev-list", "--count", range], wtPath);
  return parseInt(count, 10) || 0;
}

async function diffStatsForRange(wtPath: string, range: string): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
  const output = await git(["diff", "--shortstat", range], wtPath);
  // Example outputs:
  //   "5 files changed, 127 insertions(+), 42 deletions(-)"
  //   "1 file changed, 3 insertions(+)"
  //   "2 files changed, 10 deletions(-)"
  //   "" (no changes)
  const filesMatch = output.match(/(\d+) files? changed/);
  const insMatch = output.match(/(\d+) insertions?\(\+\)/);
  const delMatch = output.match(/(\d+) deletions?\(-\)/);
  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
  };
}

/** Count how many commits are ahead of origin/<baseBranch>. */
export async function getCommitCount(wtPath: string, baseBranch: string): Promise<number> {
  return countCommitsInRange(wtPath, `origin/${baseBranch}..HEAD`);
}

/** Get diff stats (files changed, insertions, deletions) compared to origin/<baseBranch>. */
export async function getDiffStats(wtPath: string, baseBranch: string): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
  return diffStatsForRange(wtPath, `origin/${baseBranch}...HEAD`);
}

/**
 * Count how many commits are ahead of a specific SHA. Used in target-PR mode,
 * where the worktree is already far ahead of origin/<baseBranch> from the
 * existing PR's diff, so getCommitCount would count that whole PR instead of
 * just what this run added.
 */
export async function getCommitCountSince(wtPath: string, sha: string): Promise<number> {
  return countCommitsInRange(wtPath, `${sha}..HEAD`);
}

/** Get diff stats compared to a specific SHA. See getCommitCountSince for why this exists. */
export async function getDiffStatsSince(wtPath: string, sha: string): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
  return diffStatsForRange(wtPath, `${sha}...HEAD`);
}

/** Generate a PR description by asking Claude to summarize the diff and issue. */
export async function generatePRDescription(
  wtPath: string,
  baseBranch: string,
  issue: { number: number; title: string; body: string },
  repo: string,
  attribution?: string,
): Promise<string> {
  const guard = (text: string, source: string) =>
    guardContent(text, { repo, source, itemNumber: issue.number });
  const diff = await git(["diff", `origin/${baseBranch}...HEAD`], wtPath, { maxBuffer: 200 * 1024 * 1024 });
  const truncatedDiff = diff.slice(0, 30_000);

  const prompt = [
    `You are writing a pull request description. Here is the issue that prompted the work (the actual implementation may have diverged from it — describe what the DIFF does, not what the issue asked for):`,
    ``,
    `**Issue #${issue.number}: ${guard(issue.title, "issue-title")}**`,
    guard(issue.body, "issue-body"),
    ``,
    `Here is the diff of all changes made:`,
    "```",
    truncatedDiff,
    "```",
    ``,
    `Write a concise PR description in markdown. Include:`,
    `1. A "## Summary" section explaining what was done and why (2-4 sentences)`,
    `2. A "## Changes" section with a bulleted list of the key changes`,
    ``,
    `Do NOT include the raw diff or diffstat. Focus on the intent and effect of the changes.`,
    `Do NOT include issue references like "Closes #N", "Fixes #N", or "Resolves #N" — those are added separately.`,
    ``,
    `On the VERY FIRST line of your output, emit a concise PR title subject in this exact format:`,
    `TITLE: <imperative-mood subject describing what these changes ACTUALLY do, under 70 characters>`,
    `Base the subject on the diff above, NOT on the issue title — the implementation may have diverged from the issue during refinement. Do NOT include a conventional-commit type prefix (no "fix:", "feat:", etc.) and do NOT include an issue number.`,
    ``,
    `If these changes require a human to perform a manual operational step that the merge itself cannot perform (for example: setting or rotating a production secret/env var, provisioning infrastructure, publishing a DNS record at a registrar, dispatching a bootstrap workflow, running a migration CI does not run, or changing a repository setting), add EXACTLY ONE final line at the very end of your output, choosing the marker by WHEN the step must happen:`,
    `MANUAL-ACTION-AFTER-MERGE: <one concise sentence naming the step>  — use this when the step is performed once the change is merged and deployed (the common case: anything that acts on infrastructure the merge creates or updates).`,
    `MANUAL-ACTION-BEFORE-MERGE: <one concise sentence naming the step>  — use this ONLY when merging first would be unsafe or would break production: the step must already be done for the merged code to work at all (e.g. a secret the deployed code reads on startup, a permission the deploy pipeline needs before it runs).`,
    `Prefer AFTER-MERGE when both readings are plausible — BEFORE-MERGE blocks the PR from merging at all.`,
    `A manual action must be a REQUIRED step that changes state and that no automation can perform. NEVER emit a marker for verification, observation or monitoring — "verify the alert fires", "confirm the probe works against the live deployment", "monitor the dashboard after reconcile", "check that the migration applied", "keep an eye on error rates" are NOT manual actions and must be omitted entirely. If a check is worth doing, encode it as a test, a CI step, or a monitor in this PR instead of asking a human for it.`,
    `Also do NOT emit either line for ordinary code changes, dependency bumps, anything that merges cleanly on its own, or anything CI or this PR could have done itself. When in doubt, omit both.`,
  ].join("\n");

  const description = await runClaude(prompt, wtPath, { tier: "sonnet", provider: "claude" });
  if (!description.trim()) {
    throw new Error(
      `Claude returned empty PR description for issue #${issue.number}`,
    );
  }
  if (attribution) {
    return `${description.trim()}\n\n---\n${attribution}`;
  }
  return description.trim();
}

/** Generate a PR description for documentation updates by asking Claude to summarize the diff. */
export async function generateDocsPRDescription(
  wtPath: string,
  baseBranch: string,
  attribution?: string,
): Promise<string> {
  const diff = await git(["diff", `origin/${baseBranch}...HEAD`], wtPath, { maxBuffer: 200 * 1024 * 1024 });
  const truncatedDiff = diff.slice(0, 30_000);

  const prompt = [
    `You are writing a pull request description for an automated documentation update.`,
    ``,
    `Here is the diff of all documentation changes made:`,
    "```",
    truncatedDiff,
    "```",
    ``,
    `Write a concise PR description in markdown. Include:`,
    `1. A "## Summary" section explaining what documentation was added or updated and why (2-4 sentences)`,
    `2. A "## Changes" section with a bulleted list of key changes (new docs, updated sections, removed content)`,
    ``,
    `Do NOT include the raw diff or diffstat. Focus on the intent and effect of the changes.`,
  ].join("\n");

  const description = await runClaude(prompt, wtPath, { tier: "sonnet", provider: "claude" });
  if (!description.trim()) {
    throw new Error("Claude returned empty PR description for docs update");
  }
  if (attribution) {
    return `${description.trim()}\n\n---\n${attribution}`;
  }
  return description.trim();
}

async function diagnoseNoCommitsForRange(wtPath: string, logRange: string): Promise<string> {
  const [status, log_, diff] = await Promise.all([
    git(["status", "--short"], wtPath),
    git(["log", "--oneline", "-5", logRange], wtPath),
    git(["diff", "--stat", "HEAD"], wtPath),
  ]);

  const prompt = [
    `You are diagnosing why an automated implementer ran on a GitHub issue but produced no git commits.`,
    ``,
    `Here is the state of the worktree:`,
    ``,
    `git status --short:`,
    "```",
    status || "(empty — working tree is clean)",
    "```",
    ``,
    `git log --oneline -5 ${logRange}:`,
    "```",
    log_ || "(no commits ahead of base branch)",
    "```",
    ``,
    `git diff --stat HEAD:`,
    "```",
    diff || "(no diff)",
    "```",
    ``,
    `In 1–3 sentences, diagnose why no commits were produced. Be specific: for example, "The implementation already appears complete — no changes were needed.", "Files were modified but not committed.", or "The task as described is not actionable in this codebase."`,
    `Do NOT suggest retry steps or next actions. Only diagnose.`,
  ].join("\n");

  const diagnosis = await runClaude(prompt, wtPath, { tier: "sonnet", provider: "claude" });
  if (!diagnosis.trim()) {
    throw new Error("Claude returned empty diagnosis for no-commit run");
  }
  return diagnosis.trim();
}

/** Diagnose why an implementer run produced no commits. Returns a 1–3 sentence diagnosis string. */
export async function diagnoseNoCommits(
  wtPath: string,
  baseBranch: string,
): Promise<string> {
  return diagnoseNoCommitsForRange(wtPath, `origin/${baseBranch}..HEAD`);
}

/**
 * Diagnose why a target-PR run produced no commits, diffing against the SHA the
 * worktree was at when the run started rather than origin/<baseBranch> — in
 * target-PR mode the branch is already far ahead of the base branch from the
 * existing PR's commits, so origin/<baseBranch>..HEAD would show that whole
 * history instead of context about this run.
 */
export async function diagnoseNoCommitsSince(wtPath: string, sha: string): Promise<string> {
  return diagnoseNoCommitsForRange(wtPath, `${sha}..HEAD`);
}

/** Regenerate a PR description from the full diff (used after ci-fixer/review-addresser pushes). */
export async function regeneratePRDescription(
  wtPath: string,
  baseBranch: string,
  pr: { number: number; title: string },
  repo: string,
  attribution?: string,
): Promise<string> {
  const diff = await git(["diff", `origin/${baseBranch}...HEAD`], wtPath, { maxBuffer: 200 * 1024 * 1024 });
  const truncatedDiff = diff.slice(0, 30_000);

  const prompt = [
    `You are writing a pull request description for PR #${pr.number}: ${guardContent(pr.title, { repo, source: "pr-title", itemNumber: pr.number })}`,
    ``,
    `Here is the diff of all changes on this branch compared to the base branch:`,
    "```",
    truncatedDiff,
    "```",
    ``,
    `Write a concise PR description in markdown. Include:`,
    `1. A "## Summary" section explaining what was done and why (2-4 sentences)`,
    `2. A "## Changes" section with a bulleted list of the key changes`,
    ``,
    `Do NOT include the raw diff or diffstat. Focus on the intent and effect of the changes.`,
  ].join("\n");

  const description = await runClaude(prompt, wtPath, { tier: "sonnet", provider: "claude" });
  if (!description.trim()) {
    throw new Error(`Claude returned empty PR description for PR #${pr.number}`);
  }
  if (attribution) {
    return `${description.trim()}\n\n---\n${attribution}`;
  }
  return description.trim();
}

export async function pushBranch(wtPath: string, branchName: string, owner?: string): Promise<void> {
  const MAX_ATTEMPTS = 3;
  const gitOpts = { owner };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Fetch latest remote state to incorporate concurrent changes
    const fetch = await gitRaw(
      ["fetch", "origin", `refs/heads/${branchName}:refs/remotes/origin/${branchName}`],
      wtPath,
      gitOpts,
    );
    if (fetch.code === 0) {
      // Rebase local commits on top of any new remote commits
      const rebase = await gitRaw(["rebase", "--rebase-merges", `origin/${branchName}`], wtPath, gitOpts);
      if (rebase.code !== 0) {
        await gitRaw(["rebase", "--abort"], wtPath, gitOpts);
        // Rebase failed — fall back to merge to handle diverged history
        // (e.g. both sides merged main via different paths)
        const merge = await gitRaw(
          ["merge", `origin/${branchName}`, "--no-edit"],
          wtPath,
          gitOpts,
        );
        if (merge.code !== 0) {
          await gitRaw(["merge", "--abort"], wtPath, gitOpts);
          throw new PushConflictError(branchName, rebase.stderr);
        }
        log.warn(
          `pushBranch: rebase onto origin/${branchName} conflicted, fell back to merge`,
        );
      }
    }
    // fetch failure means branch doesn't exist on remote yet — just push

    const push = await gitRaw(["push", "-u", "origin", `HEAD:${branchName}`], wtPath, gitOpts);
    if (push.code === 0) return;

    const retryable = PUSH_RETRYABLE_RE.test(push.stderr);

    // Retryable rejection with attempts left: loop to fetch+rebase again.
    if (retryable && attempt < MAX_ATTEMPTS) {
      log.warn(
        `pushBranch: retryable push rejection on attempt ${attempt}/${MAX_ATTEMPTS} for ${branchName}, retrying: ${push.stderr.split("\n")[0]}`,
      );
      continue;
    }

    // Retries exhausted on a retryable rejection — another actor keeps moving
    // the remote ref while we push. PushConflictError is suppressed by
    // error-reporter.ts; the dispatcher retries next cycle.
    if (retryable) {
      throw new PushConflictError(branchName, push.stderr, "push");
    }

    throw new Error(
      `git push -u origin HEAD:${branchName} failed in ${wtPath}: ${push.stderr}`,
    );
  }
}

// ── MCP config ──

/**
 * Write an MCP config file for Claude CLI that includes the Claws state server.
 * Optionally merges additional MCP servers (e.g. Playwright for shopping-sourcer).
 * Set `includeClawsState: false` for agents that process untrusted third-party
 * content — the state server exposes queue state, cross-repo task history, open
 * PR titles and the operator's config as callable tools, which such an agent
 * must not be able to read (let alone fold into its own output).
 * Returns the path to the written config file.
 */
export function writeClawsMcpConfig(
  cwd: string,
  options?: {
    additionalServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    includeHomeAssistant?: boolean; // default false
    includeClawsState?: boolean; // default true
  },
): string {
  const mcpServerScript = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "mcp-server.js",
  );

  const env: Record<string, string> = {
    CLAWS_MCP_WORK_DIR: WORK_DIR,
    CLAWS_MCP_PORT: String(SERVER_PORT),
  };
  env["CLAWS_MCP_AUTH_TOKEN"] = INTERNAL_MCP_TOKEN;
  if (HOME_ASSISTANT_BASE_URL && options?.includeHomeAssistant === true) {
    env["HOME_ASSISTANT_BASE_URL"] = HOME_ASSISTANT_BASE_URL;
  }
  if (HOME_ASSISTANT_TOKEN && options?.includeHomeAssistant === true) {
    env["HOME_ASSISTANT_TOKEN"] = HOME_ASSISTANT_TOKEN;
  }

  const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {
    ...(options?.includeClawsState === false
      ? {}
      : {
          "claws-state": {
            // Absolute interpreter path, never a bare "node" (#2825). `command` is
            // resolved on the child's PATH: an interactive session started from the
            // operator's login shell puts an nvm node (v22) first, and the
            // better-sqlite3 prebuild in node_modules is built for the node Claws
            // runs on (v24 under systemd) — loading it works but `new Database(...)`
            // segfaults, which the CLI surfaces as an unexplained "Connection closed"
            // on the first claws_* tool call. process.execPath is always the runtime
            // whose node_modules this server will import.
            command: process.execPath,
            args: [mcpServerScript],
            env,
          },
        }),
    ...(options?.additionalServers ?? {}),
  };

  const configPath = path.join(cwd, ".mcp-claws.json");
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  return configPath;
}

/** Per-worktree scratch dir holding an agent run's MCP config, keyed by a hash
 *  of the worktree path so removeWorktree() can find it again without threading
 *  state through the agent. Deterministic: same worktree → same dir. */
export function agentMcpDir(wtPath: string): string {
  const key = crypto.createHash("sha256").update(path.resolve(wtPath)).digest("hex").slice(0, 16);
  return path.join(WORK_DIR, "agent-mcp", key);
}

/**
 * Write an agent run's MCP config OUTSIDE the worktree it will run in (#2598).
 * The config's `env` block carries CLAWS_MCP_AUTH_TOKEN and, for the Home
 * Assistant config repo, a live HA long-lived token. Agents run with
 * --dangerously-skip-permissions and do their own `git add -A`, so a config
 * written into the worktree is one careless commit away from being pushed to
 * GitHub permanently. Every call site whose cwd is a git worktree MUST use this
 * instead of writeClawsMcpConfig(). Returns the absolute config path — pass it
 * to RunClaudeOptions.mcpConfig; the Claude CLI accepts an absolute path.
 */
export function writeAgentMcpConfig(
  wtPath: string,
  options?: Parameters<typeof writeClawsMcpConfig>[1],
): string {
  const dir = agentMcpDir(wtPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);   // load-bearing: `mode` is masked by umask and ignored when the dir already exists
  return writeClawsMcpConfig(dir, options);
}

/** Best-effort removal of a worktree's agent MCP dir. Never throws. */
export function removeAgentMcpDir(wtPath: string): void {
  try {
    fs.rmSync(agentMcpDir(wtPath), { recursive: true, force: true });
  } catch {
    // Best effort — a leftover 0700 dir must not fail a teardown.
  }
}

/** Drop the whole agent-mcp tree. Called once at startup: a crash between the
 *  config write and teardown leaves a credential on disk with nothing left to
 *  consume it, and no agent is running at startup. Never throws. */
export function pruneAgentMcpDirs(): void {
  try {
    fs.rmSync(path.join(WORK_DIR, "agent-mcp"), { recursive: true, force: true });
  } catch {
    // Best effort — startup must not be blocked by a stale MCP dir.
  }
}

/**
 * Read a repo's role document from a worktree, stripping YAML frontmatter.
 * Returns the markdown body for injection via RunClaudeOptions.appendSystemPrompt,
 * or undefined if the file is absent or empty. `role` is the filename stem,
 * e.g. "issue-refiner". Role docs live in the provider-neutral `.agents/` layout.
 */
export function readRepoAgentDoc(wtPath: string, role: string): string | undefined {
  const relPath = path.join(".agents", `${role}.md`);
  try {
    const raw = fs.readFileSync(path.join(wtPath, relPath), "utf8");
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    if (body.length > 0) {
      return body;
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`[claude] readRepoAgentDoc: unexpected error reading ${relPath}: ${e}`);
    }
  }
  return undefined;
}

/** Largest repo-instruction payload inlined into a non-Claude prompt (32 KiB). */
const REPO_INSTRUCTIONS_MAX_BYTES = 32768;

/**
 * Read the repo instructions a non-Claude CLI won't auto-load. The Claude CLI
 * picks up `CLAUDE.md` on its own; codex only auto-loads `AGENTS.md`, and
 * opencode neither — so both backends have to be handed the text explicitly.
 * Prefers `AGENTS.md` (codex's native file) and falls back to `CLAUDE.md`.
 * Returns undefined when neither exists or both are empty; capped at 32 KiB.
 */
export function readRepoInstructions(cwd: string): string | undefined {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    let body: string;
    try {
      body = fs.readFileSync(path.join(cwd, name), "utf8").trim();
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(`[claude] readRepoInstructions: unexpected error reading ${name}: ${e}`);
      }
      continue;
    }
    if (!body) continue;
    if (body.length > REPO_INSTRUCTIONS_MAX_BYTES) {
      log.warn(`[claude] readRepoInstructions: ${name} is ${body.length} chars — truncating to ${REPO_INSTRUCTIONS_MAX_BYTES}`);
      return body.slice(0, REPO_INSTRUCTIONS_MAX_BYTES);
    }
    return body;
  }
  return undefined;
}

/**
 * Prepend the context a non-Claude CLI cannot receive through flags: the repo's
 * own instructions (Claude auto-loads CLAUDE.md; codex/opencode do not for
 * every case) and the agent-role document that the Claude CLI gets via
 * `--append-system-prompt`. The text is repo-controlled, which is the same
 * trust level the Claude CLI already grants `CLAUDE.md` — the XML wrapper is
 * the boundary, so it is deliberately not run through guardContent().
 */
function withRepoContext(prompt: string, cwd: string, options?: RunClaudeOptions): string {
  const instructions = readRepoInstructions(cwd);
  const role = options?.appendSystemPrompt?.trim();
  if (!instructions && !role) return prompt;
  const parts: string[] = [];
  if (instructions) parts.push(`<repository-instructions>\n${instructions}\n</repository-instructions>\n`);
  if (role) parts.push(`<agent-role>\n${role}\n</agent-role>\n`);
  return `${parts.join("\n")}\n${prompt}`;
}

export class BranchDeletedError extends Error {
  constructor(branchName: string) {
    super(`Remote ref origin/${branchName} does not exist (branch may have been deleted after merge)`);
    this.name = "BranchDeletedError";
  }
}

// ── Claude invocation ──

export class PushConflictError extends Error {
  readonly stage: "rebase" | "push";

  constructor(branchName: string, detail: string, stage: "rebase" | "push" = "rebase") {
    super(
      stage === "push"
        ? `Push to origin/${branchName} rejected after retries exhausted (concurrent changes): ${detail}`
        : `Rebase onto origin/${branchName} failed (conflicting concurrent changes): ${detail}`,
    );
    this.name = "PushConflictError";
    this.stage = stage;
  }
}

export class AgentTimeoutError extends Error {
  readonly lastOutput: string;
  readonly lastStderr: string;
  readonly outputBytes: number;
  readonly cwd: string;

  constructor(timeoutMs: number, outputBytes: number, lastOutput: string, lastStderr: string, cwd: string) {
    super(`Agent process timed out after ${formatMs(timeoutMs)}`);
    this.name = "AgentTimeoutError";
    this.outputBytes = outputBytes;
    this.lastOutput = lastOutput;
    this.lastStderr = lastStderr;
    this.cwd = cwd;
  }
}

// Cap the Claude CLI's V8 old-space heap so its startup RSS is deterministic and
// stays under CLAUDE_WORKER_MEMORY_MAX_BYTES (see issue #1529). Without this the
// CLI's heap drifts non-deterministically and grazes the per-worker memory cap,
// OOM-killing trivial tasks at boot.
const CLAUDE_NODE_MAX_OLD_SPACE_MB = 1024;

/**
 * Memory cap for agents that drive a real browser via @playwright/mcp. The
 * watchdog sums per-process RSS across the tree, which double-counts Chromium's
 * shared pages; observed peaks under the 2 GiB global cap were 2060–2579 MiB
 * (issue #2509), so 4 GiB gives real headroom without licensing a leak.
 */
export const BROWSER_AGENT_MEMORY_MAX_BYTES = 4 * 1024 * 1024 * 1024;

export class AgentMemoryLimitError extends Error {
  readonly observedRssBytes: number;
  readonly limitBytes: number;
  readonly outputBytes: number;
  readonly cwd: string;
  constructor(observedRssBytes: number, limitBytes: number, outputBytes: number, cwd: string) {
    super(`Agent process tree exceeded memory limit (${Math.round(observedRssBytes / 1048576)}MiB > ${Math.round(limitBytes / 1048576)}MiB)`);
    this.name = "AgentMemoryLimitError";
    this.observedRssBytes = observedRssBytes;
    this.limitBytes = limitBytes;
    this.outputBytes = outputBytes;
    this.cwd = cwd;
  }
}

const ClaudeCliOutputSchema = z.object({
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  num_turns: z.number().optional(),
  total_cost_usd: z.number().optional(),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();

/** Thrown when every provider in the fallback order is inside its rate-limit
 *  cooldown, so no attempt was made. Expected and transient — `reportError`
 *  downgrades it to a warning rather than filing a `[claws-error]` issue. */
export class AllProvidersRateLimitedError extends Error {
  constructor(message = "All AI providers are rate-limited or unavailable") {
    super(message);
    this.name = "AllProvidersRateLimitedError";
  }
}

export class AgentCliError extends Error {
  public readonly exitCode: number | null;
  public readonly numTurns: number | undefined;
  /**
   * Which agent CLI produced this failure. Every backend throws the same
   * error class, so consumers that act on provider-specific conditions —
   * e.g. the per-provider auth latch in `agent-auth-state.ts`, whose regex
   * deliberately matches broad strings like `authentication_error` — must
   * check this rather than pattern-matching the message alone.
   */
  public readonly provider: Provider | undefined;
  constructor(output: string, exitCode: number | null, numTurns?: number, provider?: Provider) {
    let message = output.trim();

    try {
      const parsed = JSON.parse(message);
      const parts: string[] = [];
      if (parsed.subtype) parts.push(`[${parsed.subtype}]`);
      if (typeof parsed.result === "string" && parsed.result) parts.push(parsed.result);
      if (parts.length > 0) message = parts.join(" ");
    } catch {
      // Not JSON — use raw message as-is
    }

    super(message.slice(0, 500));
    this.name = "AgentCliError";
    this.exitCode = exitCode;
    this.numTurns = numTurns;
    this.provider = provider;
  }
}

const activeChildren = new Set<ChildProcess>();
const cancelledChildren = new WeakSet<ChildProcess>();
const timedOutChildren = new WeakSet<ChildProcess>();
const activeRunChildren = new Map<string, Set<ChildProcess>>();
const childRunId = new WeakMap<ChildProcess, string>();

// ── Provider-level circuit breakers ──

const providerRateLimitedUntil = new Map<Provider, number>();
const providerLastUsedAt = new Map<Provider, number>();

export function isProviderRateLimited(provider: Provider): boolean {
  const until = providerRateLimitedUntil.get(provider);
  if (!until) return false;
  if (Date.now() >= until) {
    providerRateLimitedUntil.delete(provider);
    return false;
  }
  return true;
}

export function markProviderRateLimited(provider: Provider, cooldownMs?: number): void {
  const ms = cooldownMs ?? PROVIDER_RATE_LIMIT_COOLDOWN_MS;
  providerRateLimitedUntil.set(provider, Date.now() + ms);
  log.warn(`[provider-circuit-breaker] Provider "${provider}" rate-limited — cooldown ${ms}ms`);
}

export function clearProviderRateLimitState(provider?: Provider): void {
  if (provider) {
    providerRateLimitedUntil.delete(provider);
  } else {
    providerRateLimitedUntil.clear();
  }
}

export function getProviderLastUsedAt(provider: Provider): number | null {
  return providerLastUsedAt.get(provider) ?? null;
}

export function cancelCurrentTask(): boolean {
  if (activeChildren.size === 0) return false;
  for (const child of activeChildren) {
    cancelledChildren.add(child);
    killProcessTree(child, "SIGTERM");
  }
  return true;
}

export function cancelTaskByRunId(runId: string): boolean {
  const children = activeRunChildren.get(runId);
  if (!children || children.size === 0) return false;
  for (const child of children) {
    cancelledChildren.add(child);
    killProcessTree(child, "SIGTERM");
  }
  return true;
}

/** Tools stripped from pure text-extraction agents (Claude CLI backend).
 *  Denies filesystem, shell, and network access so untrusted email/WhatsApp
 *  content cannot reach Bash/Read/Write/Edit rooted at the cwd. */
export const TEXT_ONLY_DISALLOWED_TOOLS = [
  "Bash", "Edit", "Write", "NotebookEdit", "Read", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task",
];

export interface RunClaudeOptions {
  tier: ModelTier; // original model tier — required so provider fallback can re-derive the correct model ID
  mcpConfig?: string; // path to MCP config JSON file
  timeoutMs?: number; // per-task timeout override
  model?: string; // model to use (e.g. "opus", "sonnet", "gpt-5.1-codex", or a full model ID)
  provider?: Provider; // explicit CLI backend override; otherwise chosen from PROVIDER_FALLBACK_ORDER
  strictProvider?: boolean; // when true, do not fall back to any other provider if the selected one fails
  onProviderUsed?: (provider: Provider) => void; // called when a provider attempt begins
  onTokensUsed?: (tokensUsed: number, costUsd: number, provider: Provider) => void; // called with token/cost data plus the backend that reported it (Claude CLI, OpenCode, and Codex — but Codex reports no cost, so costUsd is 0 there)
  agent?: string; // opencode agent type: "plan" or "build"
  envSanitization?: "strict" | "passthrough"; // default "strict": strip sensitive env vars before spawning child
  appendSystemPrompt?: string; // injected via --append-system-prompt on Claude; inlined into the prompt as <agent-role> on Codex/OpenCode, which have no equivalent flag
  captureLabel?: string; // human label for prompt-capture (agent/job name); falls back to cwd basename
  disallowedTools?: string[]; // Claude CLI only: passed as --disallowedTools; ignored by other backends
  /**
   * Pin the call to `provider` with no fallback: if that backend is
   * rate-limited or fails, the call throws instead of retrying elsewhere.
   * Required whenever the run's safety depends on a Claude-CLI-only option
   * such as `disallowedTools`, which other backends silently ignore — a
   * transparent fallback would re-run the same prompt unsandboxed.
   */
  noProviderFallback?: boolean;
  /** GitHub owner whose App installation token should authenticate the agent's
   *  own `gh` calls. When set, runClaude mints a token and injects it as
   *  GH_TOKEN/GITHUB_TOKEN into the child env, so agent `gh` runs as the App
   *  instead of the host's ambient `gh auth login` credential. */
  githubTokenOwner?: string;
  /** @internal Resolved token. Set by runClaudeInner only — never by call sites,
   *  and never logged or written to a prompt capture. */
  githubToken?: string;
  /**
   * Raise the process-tree RSS cap for this call only. Browser-driving agents
   * (Playwright MCP spawns a full Chromium process tree) cannot fit the global
   * 2 GiB worker cap. Never lowers the effective limit, and never re-enables
   * the watchdog when the global limit is 0 (operator-disabled).
   */
  memoryMaxBytes?: number;
  /** Run on the provider's best model with reasoning at maximum (Claude:
   *  MAX_THINKING_TOKENS; Codex: model_reasoning_effort=xhigh; OpenCode:
   *  best model only). Overrides model/tier derivation on every attempt,
   *  including provider fallback. */
  deepThinking?: boolean;
}

/**
 * Dispatch to the correct backend based on provider option.
 */
function runClaudeOnce(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  if (options?.provider === "codex") {
    return runCodexOnce(prompt, cwd, options);
  }
  if (options?.provider === "opencode") {
    return runOpenCodeOnce(prompt, cwd, options);
  }
  return runClaudeCliOnce(prompt, cwd, options);
}

/**
 * Well-known directories where CLI tools are commonly installed by language-
 * specific installers (cargo, go install, pip/pipx, bun, opencode installer,
 * etc.).  These are often added to PATH via shell profiles (~/.zshrc) which
 * are NOT sourced by systemd services.  We prepend any that exist to the
 * child-process PATH so spawned CLIs are discoverable at runtime even when
 * the systemd unit's baked-in PATH doesn't include them.
 */
const EXTRA_BIN_DIRS: string[] = (() => {
  const home = process.env["HOME"] ?? "/root";
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, ".bun", "bin"),
    "/usr/local/bin",
  ];
})();

/**
 * Returns true if the `opencode` CLI binary is findable in the enriched PATH.
 * Used by dashboard/status code to decide whether the OpenCode provider is
 * "configured" — opencode can authenticate via its own auth file
 * (`opencode auth login`), so checking only CLAWS_OPENROUTER_API_KEY misses
 * that setup. If the binary is present we assume it's usable; runtime
 * failures will still surface through the normal error path.
 */
export function isOpenCodeBinaryAvailable(): boolean {
  const basePath = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  const candidates = [...basePath, ...EXTRA_BIN_DIRS];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, "opencode"))) return true;
    } catch {
      // ignore permission / stat errors on individual dirs
    }
  }
  return false;
}

/**
 * Return a PATH string with well-known bin directories prepended to the
 * base PATH.  Only directories that actually exist on disk are added.
 */
export function enrichedPath(basePath: string | undefined): string {
  const existing = basePath ?? "";
  const parts = existing.split(path.delimiter).filter(Boolean);
  const partsSet = new Set(parts);
  const prepend: string[] = [];
  for (const dir of EXTRA_BIN_DIRS) {
    if (!partsSet.has(dir) && fs.existsSync(dir)) {
      prepend.push(dir);
    }
  }
  if (prepend.length === 0) return existing;
  return [...prepend, ...parts].join(path.delimiter);
}

// rootPid plus all descendant PIDs, leaf-first (SIGKILL hits children before
// parents). Linux-only; elsewhere returns [rootPid].
export function collectProcessTreePids(rootPid: number): number[] {
  if (process.platform !== "linux") return [rootPid];
  let entries: string[];
  try { entries = fs.readdirSync("/proc"); } catch { return [rootPid]; }
  if (!Array.isArray(entries)) return [rootPid];
  const childrenByPpid = new Map<number, number[]>();
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat: string;
    try { stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { continue; }
    const rparen = stat.lastIndexOf(")"); // comm field may contain spaces/parens
    if (rparen < 0) continue;
    const fields = stat.slice(rparen + 2).split(" "); // [state, ppid, ...]
    const ppid = Number(fields[1]);
    if (!Number.isFinite(ppid)) continue;
    const arr = childrenByPpid.get(ppid);
    if (arr) arr.push(pid); else childrenByPpid.set(ppid, [pid]);
  }
  const ordered: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift()!;
    ordered.push(pid);
    for (const c of childrenByPpid.get(pid) ?? []) {
      if (!seen.has(c)) { seen.add(c); queue.push(c); }
    }
  }
  return ordered.reverse();
}

export function sampleProcessTreeRssBytes(rootPid: number): number {
  if (process.platform !== "linux") return 0;
  let totalKb = 0;
  for (const pid of collectProcessTreePids(rootPid)) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
      const kb = m ? Number(m[1]) : 0;
      if (Number.isFinite(kb)) totalKb += kb;
    } catch { /* process exited mid-scan */ }
  }
  return totalKb * 1024;
}

// Reap the child's entire process tree. KillMode=process means a signal to the
// CLI alone leaves runaway grandchildren (e.g. an openscad render) orphaned, so
// descendants are signalled directly by PID (leaf-first), then the root via the
// ChildProcess handle (which the existing spawn bookkeeping relies on).
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const rootPid = child.pid;
  if (rootPid !== undefined) {
    for (const pid of collectProcessTreePids(rootPid)) {
      if (pid === rootPid) continue;
      try { process.kill(pid, signal); } catch { /* ESRCH — already gone */ }
    }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/**
 * Shared CLI process runner. Handles spawn, liveness/timeout timers, heartbeat,
 * signal handling, and cleanup. Backend-specific behaviour is injected via params.
 */
interface CliBackendConfig {
  command: string;
  args: string[];
  label: string; // for log messages (e.g. "Claude", "Codex")
  env?: NodeJS.ProcessEnv; // additional env vars to merge into the child process environment
  /** Process stdout+code into a resolved value or throw to reject. */
  processOutput: (stdout: string, stderr: string, code: number | null) => string;
}

function runCliProcess(
  prompt: string,
  cwd: string,
  backend: CliBackendConfig,
  options?: RunClaudeOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Always enrich PATH with well-known bin dirs so CLIs installed via
    // shell-profile-only installers (opencode, cargo, etc.) are discoverable
    // even when running under systemd with a restricted PATH.
    const mode = options?.envSanitization ?? "strict";
    const cleaned = sanitiseEnvForChild(process.env, mode);
    const ghEnv = options?.githubToken
      ? { GH_TOKEN: options.githubToken, GITHUB_TOKEN: options.githubToken }
      : undefined;
    const baseEnv: NodeJS.ProcessEnv = { ...cleaned, ...ghEnv, ...backend.env };
    baseEnv["PATH"] = enrichedPath(baseEnv["PATH"]);
    const child = spawn(backend.command, backend.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: baseEnv,
    });
    activeChildren.add(child);
    const runCtx = runContext.getStore();
    if (runCtx) {
      const set = activeRunChildren.get(runCtx.runId) ?? new Set();
      set.add(child);
      activeRunChildren.set(runCtx.runId, set);
      childRunId.set(child, runCtx.runId);
    }
    log.info(`Spawned ${backend.label} process (PID ${child.pid}, cwd=${cwd}, model=${options?.model ?? "default"}, timeout=${options?.timeoutMs ?? CLAUDE_TIMEOUT_MS}ms, liveness=${CLAUDE_LIVENESS_TIMEOUT_MS}ms)`);
    const startTime = Date.now();

    let stdout = "";
    let stderr = "";
    let livenessAborted = false;
    let memoryAborted = false;
    let observedRss = 0;

    // Heartbeat — log every 5 min while running
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log.info(`${backend.label} process still running (PID ${child.pid}, elapsed ${elapsed}s, stdout ${stdout.length} bytes)`);
    }, 5 * 60 * 1000);

    // Liveness abort — kill early if 0 bytes produced after CLAUDE_LIVENESS_TIMEOUT_MS
    let livenessTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      log.warn(`${backend.label} process produced no output after ${formatMs(CLAUDE_LIVENESS_TIMEOUT_MS)} — aborting early (likely hung)`);
      livenessAborted = true;
      timedOutChildren.add(child);
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        log.warn(`${backend.label} process did not exit after SIGTERM — sending SIGKILL`);
        killProcessTree(child, "SIGKILL");
      }, 10_000);
    }, CLAUDE_LIVENESS_TIMEOUT_MS);

    // Timeout — kill after effectiveTimeout
    const effectiveTimeout = options?.timeoutMs ?? CLAUDE_TIMEOUT_MS;
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      log.warn(`${backend.label} process timed out after ${formatMs(effectiveTimeout)} — sending SIGTERM`);
      log.warn(`Timeout diagnostics: cwd=${cwd}, stdout=${stdout.length} bytes, stderr=${stderr.length} bytes`);
      if (stdout.length > 0) {
        log.warn(`Last stdout (up to 2000 chars):\n${stdout.slice(-2000)}`);
      } else {
        log.warn("No stdout produced before timeout — process may have been waiting for input or stuck");
      }
      timedOutChildren.add(child);
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        log.warn(`${backend.label} process did not exit after SIGTERM — sending SIGKILL`);
        killProcessTree(child, "SIGKILL");
      }, 10_000);
    }, effectiveTimeout);

    // Memory watchdog — SIGKILL the whole process tree if its RSS exceeds the
    // configured limit. Linux-only; disabled when the limit is 0.
    const memMax = CLAUDE_WORKER_MEMORY_MAX_BYTES === 0
      ? 0
      : Math.max(CLAUDE_WORKER_MEMORY_MAX_BYTES, options?.memoryMaxBytes ?? 0);
    let memTimer: NodeJS.Timeout | undefined =
      (process.platform === "linux" && memMax > 0 && child.pid)
        ? setInterval(() => {
            const rss = sampleProcessTreeRssBytes(child.pid!);
            if (rss > memMax) {
              log.warn(`${backend.label} process tree (PID ${child.pid}) RSS ${Math.round(rss / 1048576)}MiB exceeded limit ${Math.round(memMax / 1048576)}MiB — SIGKILL whole tree`);
              memoryAborted = true;
              observedRss = rss;
              if (memTimer) { clearInterval(memTimer); memTimer = undefined; }
              killProcessTree(child, "SIGKILL");
            }
          }, 15_000)
        : undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      const hadOutput = stdout.length > 0;
      stdout += chunk.toString();
      // Clear liveness timer on first output — process is alive
      if (!hadOutput && stdout.length > 0 && livenessTimer) {
        clearTimeout(livenessTimer);
        livenessTimer = undefined;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) log.debug(trimmed);
      }
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(livenessTimer);
      clearInterval(heartbeat);
      if (memTimer) clearInterval(memTimer);
      activeChildren.delete(child);
      const rid = childRunId.get(child);
      if (rid) {
        const set = activeRunChildren.get(rid);
        if (set) { set.delete(child); if (set.size === 0) activeRunChildren.delete(rid); }
      }
      if (memoryAborted && !isShuttingDown()) {
        reject(new AgentMemoryLimitError(observedRss, memMax, stdout.length, cwd));
        return;
      }
      if (memoryAborted) {
        // Watchdog killed during shutdown — treat as clean shutdown
        reject(new ShutdownError("Task cancelled — shutting down"));
        return;
      }
      if (timedOutChildren.has(child)) {
        reject(new AgentTimeoutError(
          livenessAborted ? CLAUDE_LIVENESS_TIMEOUT_MS : effectiveTimeout,
          stdout.length,
          stdout.slice(-3000),
          stderr.slice(-1000),
          cwd,
        ));
        return;
      }
      if (cancelledChildren.has(child) || (signal === "SIGTERM" && isShuttingDown())) {
        reject(new ShutdownError("Task cancelled — shutting down"));
        return;
      }
      if (signal) {
        log.warn(`${backend.command} was killed by signal ${signal}: ${stderr.slice(0, 500)}`);
        reject(new Error(`${backend.command} was killed by signal ${signal}`));
        return;
      }
      try {
        resolve(backend.processOutput(stdout, stderr, code));
      } catch (err) {
        reject(err);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(livenessTimer);
      clearInterval(heartbeat);
      if (memTimer) clearInterval(memTimer);
      activeChildren.delete(child);
      const rid = childRunId.get(child);
      if (rid) {
        const set = activeRunChildren.get(rid);
        if (set) { set.delete(child); if (set.size === 0) activeRunChildren.delete(rid); }
      }
      if ("code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`${backend.label} CLI not found — is '${backend.command}' installed and on PATH?`));
      } else {
        reject(new Error(`Failed to spawn ${backend.command}: ${err.message}`));
      }
    });

    child.stdin.on("error", (err) => {
      log.warn(`stdin write error: ${err.message}`);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Parse the JSONL output of `codex exec --json`.
 *
 * Event types (codex-cli 0.118):
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *   {"type":"item.completed","item":{"type":"reasoning"|"command_execution",…}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,
 *                                     "output_tokens":N,"reasoning_output_tokens":N}}
 *   {"type":"turn.failed","error":{"message":"..."}}
 *   {"type":"error","message":"..."}
 *
 * Codex reports no cost, so `costUsd` is always 0 when usage is present.
 * Never throws: malformed lines are skipped individually.
 */
export function parseCodexJsonOutput(stdout: string): { text: string; errors: string[]; tokensUsed?: number; costUsd?: number } {
  const messages: string[] = [];
  const errors: string[] = [];
  let tokensUsed: number | undefined;
  let costUsd: number | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: any;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      // Non-JSON line (e.g. a CLI banner written before the JSONL stream) — ignore
      continue;
    }
    if (evt === null || typeof evt !== "object") continue;
    if (evt.type === "item.completed" && evt.item?.type === "agent_message") {
      if (typeof evt.item.text === "string") messages.push(evt.item.text);
    } else if (evt.type === "error") {
      errors.push(String(evt.message));
    } else if (evt.type === "turn.failed") {
      errors.push(String(evt.error?.message ?? "turn failed"));
    } else if (evt.type === "turn.completed") {
      const u = evt.usage ?? {};
      tokensUsed =
        (tokensUsed ?? 0) +
        (u.input_tokens ?? 0) +
        (u.output_tokens ?? 0) +
        (u.cached_input_tokens ?? 0) +
        (u.reasoning_output_tokens ?? 0);
      // Codex does not report cost — record it as zero rather than omitting it,
      // so usage rows still attribute the tokens.
      costUsd = 0;
    }
  }

  // Codex emits one final agent message per turn; earlier ones are intermediate.
  return { text: messages.length > 0 ? messages[messages.length - 1]! : "", errors, tokensUsed, costUsd };
}

/**
 * Turn one codex process' output into the agent's answer, or throw the
 * `AgentCliError` the failure deserves. Exported so tests can drive the real
 * throw (message, exit code, `numTurns`, provider) into consumers such as
 * `error-reporter.reportError` instead of hand-constructing an error that may
 * not match what codex actually produces.
 */
export function processCodexOutput(
  stdout: string,
  stderr: string,
  code: number | null,
  options?: RunClaudeOptions,
): string {
  const { text, errors, tokensUsed, costUsd } = parseCodexJsonOutput(stdout);

  if (errors.length > 0) {
    const errMsg = errors.join("; ");
    log.warn(`Codex reported error(s): ${errMsg.slice(0, 500)}`);
    throw new AgentCliError(errMsg, code, text ? undefined : 0, "codex");
  }

  if (code !== 0) {
    log.warn(`codex exited with code ${code}: ${stderr.slice(0, 500)}`);
    throw new AgentCliError(stderr || text || `codex exited with code ${code}`, code, text ? undefined : 0, "codex");
  }

  if (tokensUsed && tokensUsed > 0) {
    log.info(`Codex usage: ${tokensUsed} tokens`);
    options?.onTokensUsed?.(tokensUsed, costUsd ?? 0, "codex");
  }

  if (!text.trim()) {
    // No agent_message in the stream — either the model only ran tools, or
    // the event schema drifted in a newer codex. Hand back raw stdout so a
    // downstream JSON extractor still has something to work with.
    log.warn("Codex produced no agent_message — returning raw stdout");
    return stdout;
  }

  return text;
}

/**
 * Run a single Codex CLI process via the shared runCliProcess helper.
 *
 * `--json` makes stdout a pure JSONL event stream; without it stdout is the
 * human transcript (header block, `thinking`/`exec` sections) and every
 * text-only consumer downstream gets that noise as the agent's answer.
 */
function runCodexOnce(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  const wrappedPrompt = withRepoContext(prompt, cwd, options);
  if (options?.mcpConfig) {
    log.debug("MCP config is not supported by Codex backend — ignoring mcpConfig");
  }
  const args = ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--json"];
  if (options?.model) {
    args.push("-m", options.model);
  }
  if (options?.deepThinking) {
    // TOML-parsed by codex; the quotes make it an explicit string. xhigh is
    // the top effort level on gpt-5.4 (codex-cli 0.118.0).
    args.push("-c", `model_reasoning_effort="xhigh"`);
  }
  return runCliProcess(wrappedPrompt, cwd, {
    command: "codex",
    args,
    label: "Codex",
    processOutput: (stdout, stderr, code) => processCodexOutput(stdout, stderr, code, options),
  }, options);
}

/**
 * Run a single OpenCode CLI process via the shared runCliProcess helper.
 * OpenCode uses OpenRouter API under the hood; the OPENROUTER_API_KEY is injected
 * into the child environment.
 *
 * Non-interactive invocation uses `opencode run`.
 * The prompt is delivered via stdin (NOT as a positional arg).  When stdin
 * is not a TTY the opencode `run` handler appends stdin to the message:
 *   `if (!process.stdin.isTTY) message += "\n" + (await Bun.stdin.text())`
 * Passing the prompt as a positional arg would break with complex prompts
 * (yargs parses dashes, newlines, etc.) and would also cause double-delivery
 * since runCliProcess always writes the prompt to stdin.
 * See: https://opencode.ai/docs/cli/#run-1
 */
/**
 * Parse the NDJSON (newline-delimited JSON) output from `opencode run --format json`.
 * Extracts text parts, detects errors, and returns the concatenated text output.
 *
 * JSON event types:
 *   {"type":"text",        "part":{"text":"..."}}           — LLM response text
 *   {"type":"error",       "error":{...}}                   — session-level error
 *   {"type":"tool_use",    "part":{"tool":"...","state":{}}} — tool invocation
 *   {"type":"step_finish", "part":{"tokens":{...},"cost":N}} — token/cost data
 */
function parseOpenCodeJsonOutput(stdout: string): { text: string; errors: string[]; tokensUsed?: number; costUsd?: number } {
  const textParts: string[] = [];
  const errors: string[] = [];
  let tokensUsed: number | undefined;
  let costUsd: number | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event.type === "text" && event.part?.text) {
        textParts.push(event.part.text);
      } else if (event.type === "error") {
        const errData = event.error?.data?.message ?? event.error?.name ?? JSON.stringify(event.error);
        errors.push(String(errData));
      } else if (event.type === "step_finish" && event.part?.tokens) {
        const t = event.part.tokens;
        tokensUsed = (tokensUsed ?? 0) + (t.input ?? 0) + (t.output ?? 0) + (t.cache_read ?? 0) + (t.cache_write ?? 0);
        if (typeof event.part.cost === "number") {
          costUsd = (costUsd ?? 0) + event.part.cost;
        }
      }
    } catch {
      // Non-JSON line (e.g. opencode startup messages) — ignore
    }
  }

  return { text: textParts.join("\n"), errors, tokensUsed, costUsd };
}

function runOpenCodeOnce(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  const wrappedPrompt = withRepoContext(prompt, cwd, options);
  if (options?.mcpConfig) {
    log.debug("MCP config is not supported by OpenCode backend — ignoring mcpConfig");
  }
  const args = ["run", "--format", "json"];
  if (options?.model) {
    args.push("--model", options.model);
  }
  if (options?.agent) {
    if (!["plan", "build"].includes(options.agent)) {
      throw new Error(`Invalid agent type: ${options.agent}. Must be "plan" or "build"`);
    }
    args.push("--agent", options.agent);
  }
  // Prompt is written to stdin by runCliProcess — do NOT add it to args.
  // opencode run reads stdin when !isTTY and appends it to the message.
  const env: NodeJS.ProcessEnv = {};
  if (OPENROUTER_API_KEY) {
    env["OPENROUTER_API_KEY"] = OPENROUTER_API_KEY;
  }
  return runCliProcess(wrappedPrompt, cwd, {
    command: "opencode",
    args,
    label: "OpenCode",
    env: Object.keys(env).length > 0 ? env : undefined,
    processOutput(stdout, stderr, code) {
      if (code !== 0) {
        log.warn(`opencode exited with code ${code}: ${stderr.slice(0, 500)}`);
        const noOutput = !stdout.trim();
        throw new AgentCliError(stderr || stdout || `opencode exited with code ${code}`, code, noOutput ? 0 : undefined, "opencode");
      }

      // Parse the NDJSON output to extract text and detect errors
      const { text, errors, tokensUsed, costUsd } = parseOpenCodeJsonOutput(stdout);

      if (errors.length > 0) {
        const errMsg = errors.join("; ");
        log.warn(`OpenCode reported error(s): ${errMsg.slice(0, 500)}`);
        throw new AgentCliError(errMsg, code, 0, "opencode");
      }

      if (!text.trim() && !stdout.trim()) {
        // No JSON events at all — opencode likely hit a fatal error before
        // the session started (e.g. ProviderModelNotFoundError) and printed
        // the error to stderr while exiting 0.
        const msg = stderr.trim() || "opencode exited 0 but produced no output";
        log.warn(`OpenCode exited 0 with no output: ${msg.slice(0, 500)}`);
        throw new AgentCliError(msg, code, 0, "opencode");
      }

      // Report token/cost data if available
      if (tokensUsed !== undefined && costUsd !== undefined) {
        log.info(`OpenCode usage: ${tokensUsed} tokens, $${costUsd.toFixed(6)}`);
        options?.onTokensUsed?.(tokensUsed, costUsd, "opencode");
      }

      if (!text.trim()) {
        // Got JSON events (tool_use, step_start, etc.) but no text output.
        // This can happen when the LLM only used tools without producing
        // a final text response.
        log.debug("OpenCode produced JSON events but no text parts — returning raw stdout for downstream parsing");
        return stdout;
      }

      return text;
    },
  }, options);
}

/**
 * Run a single Claude CLI process via the shared runCliProcess helper.
 */
function runClaudeCliOnce(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  const args = ["-p", "--dangerously-skip-permissions", "--output-format", "json"];
  if (options?.model) {
    args.push("--model", options.model);
  }
  if (options?.mcpConfig) {
    args.push("--mcp-config", options.mcpConfig);
  }
  if (options?.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }
  if (options?.disallowedTools && options.disallowedTools.length > 0) {
    args.push("--disallowedTools", options.disallowedTools.join(","));
  }
  const existingNodeOptions = process.env["NODE_OPTIONS"] ?? "";
  const nodeOptions = /--max-old-space-size/.test(existingNodeOptions)
    ? existingNodeOptions
    : `${existingNodeOptions} --max-old-space-size=${CLAUDE_NODE_MAX_OLD_SPACE_MB}`.trim();
  return runCliProcess(prompt, cwd, {
    command: "claude",
    args,
    label: "Claude",
    env: {
      NODE_OPTIONS: nodeOptions,
      ...(options?.deepThinking ? { MAX_THINKING_TOKENS: "31999" } : {}),
    },
    processOutput(stdout, _stderr, code) {
      if (code !== 0) {
        log.warn(`claude exited with code ${code}: ${_stderr.slice(0, 500)}`);
      }
      // Parse structured JSON output from --output-format json
      let result: string;
      try {
        const parsed = ClaudeCliOutputSchema.parse(JSON.parse(stdout));
        if (parsed.is_error) {
          throw new AgentCliError(
            typeof parsed.result === "string" ? parsed.result : stdout,
            code,
            typeof parsed.num_turns === "number" ? parsed.num_turns : undefined,
            "claude",
          );
        }
        result = typeof parsed.result === "string" ? parsed.result : "";
        const u = parsed.usage;
        if (u && typeof parsed.total_cost_usd === "number") {
          const totalTokens =
            (u.input_tokens ?? 0) +
            (u.output_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0);
          if (totalTokens > 0) {
            log.info(`Claude usage: ${totalTokens} tokens, $${parsed.total_cost_usd.toFixed(6)}`);
            options?.onTokensUsed?.(totalTokens, parsed.total_cost_usd, "claude");
          }
        }
      } catch (err) {
        if (err instanceof AgentCliError) throw err;
        // CLI produced non-JSON output — always treat as a CLI-level failure,
        // regardless of exit code or output length.
        throw new AgentCliError(stdout, code, undefined, "claude");
      }
      return result;
    },
  }, options);
}

/**
 * Matches agent CLI failure messages that represent transient upstream API
 * failures (5xx responses, unexpected socket closures, and mid-response
 * connection failures, across the Anthropic and OpenCode/OpenAI backends).
 *
 * Three consumers share this single definition — keep them in mind when editing:
 * - `runWithRetry` below retries the agent call once when it matches.
 * - `reportError` in `src/error-reporter.ts` downgrades matches to a warning
 *   instead of filing a `[claws-error]` issue.
 * - `categorizeFailure` in `src/outcome.ts` classifies matches as `transient-api`.
 */
export const API_TRANSIENT_RE = /API Error: 5\d\d|API Error: The socket connection was closed|API Error:[^\n]*\bmid-response\b|openai\b.*\berror\b.*\b5\d\d\b/i;

/**
 * Matches agent CLI failure messages that mean the account's usage allowance is
 * exhausted — the CLI prints a bare sentence like `You've hit your weekly limit
 * · resets 2am (Europe/London)`, `You've hit your limit · resets 12pm`, or
 * `You're out of extra usage · resets 5pm`. The qualifier between `your` and
 * `limit` varies (`weekly`, `5-hour`, none at all), so it must not be matched
 * literally — that is what let #2590's weekly-limit errors escalate to Slack.
 *
 * Consumers:
 * - `runWithRetry` below skips its retry (a second call cannot succeed).
 * - `runClaudeInner`'s fallback loop treats a match as a definite rate limit
 *   without an Ollama round-trip.
 * - `reportError` in `src/error-reporter.ts` downgrades matches to a warning.
 * - `categorizeFailure` in `src/outcome.ts` classifies matches as `usage-limit`.
 */
export const USAGE_LIMIT_RE =
  /you['’](?:re out of [^.\n]{0,40}?usage|ve (?:hit|reached) your [^.\n]{0,40}?limit)|\busage limit reached\b/i;

/**
 * A model ID the agent CLI's account cannot use. Permanent until an operator
 * changes config — a retry, a fallback, or a "transient init failure"
 * downgrade all just loop (#2694).
 *
 * Consumers: `runWithRetry` below (skip the retry) and `reportError` in
 * `src/error-reporter.ts` (classified ahead of the numTurns===0 short-circuit).
 */
export const UNSUPPORTED_MODEL_RE =
  /model is not supported when using Codex with a ChatGPT account|\bmodel_not_found\b|The model `[^`]+` does not exist|\bunsupported[_ ]model\b/i;

function backendLabel(provider: Provider): string {
  if (provider === "codex") return "Codex";
  if (provider === "opencode") return "OpenCode";
  return "Claude";
}

/**
  * Run a single attempt with automatic retry on transient failures.
  * Retries once on:
  * - 0-byte timeouts (likely a transient hang)
  * - AgentCliError with 0 turns (transient init failure)
  * - Transient API errors (5xx status codes, unexpected socket closures, and
  *   mid-response connection failures)
 */
async function runWithRetry(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  const provider = options?.provider ?? "claude";
  const backend = backendLabel(provider);
  try {
    return await runClaudeOnce(prompt, cwd, options);
  } catch (err) {
    if (!isShuttingDown()) {
      if (err instanceof AgentTimeoutError && err.outputBytes === 0) {
        log.warn(`${backend} produced 0 bytes before timeout — retrying once with fresh process`);
        return await runClaudeOnce(prompt, cwd, options);
      }
      if (err instanceof AgentCliError && USAGE_LIMIT_RE.test(err.message)) {
        log.warn(`${backend} CLI is out of usage allowance — not retrying`);
        throw err;
      }
      if (err instanceof AgentCliError && UNSUPPORTED_MODEL_RE.test(err.message)) {
        log.warn(`${backend} CLI was given a model its account cannot use — not retrying`);
        throw err;
      }
      if (err instanceof AgentCliError && err.numTurns === 0) {
        log.warn(`${backend} CLI errored with 0 turns (transient init failure) — retrying once with fresh process`);
        return await runClaudeOnce(prompt, cwd, options);
      }
      if (err instanceof AgentCliError && API_TRANSIENT_RE.test(err.message)) {
        log.warn(`${backend} CLI hit transient API error — retrying once with fresh process`);
        return await runClaudeOnce(prompt, cwd, options);
      }
    }
    throw err;
  }
}

/**
 * Run Claude with automatic retry on transient failures and provider fallback on rate limits.
 *
 * Providers are walked in PROVIDER_FALLBACK_ORDER (default `["claude"]`). An
 * explicit `options.provider` pins the first attempt regardless; remaining
 * fallback providers come from that order. Rate-limit detection uses the
 * Ollama-backed classifier (with regex fallback).
 */
export async function runClaude(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  const captureDir = resolvePromptCaptureDir();
  if (!captureDir) return runClaudeInner(prompt, cwd, options);
  try {
    const output = await runClaudeInner(prompt, cwd, options);
    capturePromptExchange(captureDir, { prompt, cwd, options, output, ok: true });
    return output;
  } catch (err) {
    capturePromptExchange(captureDir, { prompt, cwd, options, ok: false, errorMessage: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

async function runClaudeInner(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  const fallbackOrder = getFallbackOrder();
  const configPrimary = fallbackOrder[0] ?? "claude";
  const explicitProvider = options?.provider;
  const firstProvider = explicitProvider ?? configPrimary;

  // Build the attempt order: explicit caller provider (if given) or config primary first,
  // then remaining fallback order entries (deduplicated). `noProviderFallback`
  // callers stay pinned to the single provider they asked for.
  const attemptOrder: Provider[] = [firstProvider];
  if (!options?.strictProvider && !options?.noProviderFallback) {
    for (const p of fallbackOrder) {
      if (!attemptOrder.includes(p)) {
        attemptOrder.push(p);
      }
    }
  }

  let githubToken: string | undefined;
  if (options?.githubTokenOwner) {
    try {
      githubToken = await getInstallationTokenForOwner(options.githubTokenOwner);
    } catch (err) {
      log.error(`[runClaude] could not mint a GitHub installation token for ${options.githubTokenOwner} — the agent's \`gh\` calls will fall back to the host's ambient credentials: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let lastErr: unknown;

  for (const provider of attemptOrder) {
    // Fast-path: skip rate-limited providers without calling Ollama
    if (isProviderRateLimited(provider)) {
      const until = providerRateLimitedUntil.get(provider);
      const remainingMs = until ? until - Date.now() : 0;
      log.info(`[provider-circuit-breaker] Skipping rate-limited provider "${provider}" (${Math.ceil(remainingMs / 1000)}s remaining)`);
      continue;
    }

    const effectiveTier: ModelTier = options?.tier ?? "sonnet";
    // If the caller explicitly pinned both a provider and a model, honour the
    // pin on the first attempt — the explicit model is the one they meant for
    // that provider. Only re-derive via getModel() on fallback attempts, where
    // the pinned model wouldn't be valid for a different provider.
    const isFirstTryWithExplicitModel = provider === explicitProvider && options?.model;
    const providerModel = options?.deepThinking
      ? getDeepModel(provider)
      : isFirstTryWithExplicitModel
        ? options!.model
        : options?.tier
          ? getModel(options.tier, provider)
          : options?.model;
    const providerOptions: RunClaudeOptions = { tier: effectiveTier, ...options, provider, model: providerModel, githubToken };
    const backend = backendLabel(provider);

    // Notify caller which provider is being used
    options?.onProviderUsed?.(provider);
    providerLastUsedAt.set(provider, Date.now());

    if (provider !== firstProvider) {
      log.info(`[provider-fallback] Attempting provider "${provider}" after "${firstProvider}" was unavailable`);
      if (options?.mcpConfig && (provider === "codex" || provider === "opencode")) {
        log.warn(`[provider-fallback] MCP config will be silently ignored for ${backend} backend`);
      }
    }

    try {
      const out = await runWithRetry(prompt, cwd, providerOptions);
      // A successful run proves *that provider's* credentials are alive. The
      // latch is per-provider, so clear only the one that just succeeded (#2538).
      noteAgentAuthSuccess(provider);
      return out;
    } catch (err) {
      lastErr = err;

      if (isShuttingDown()) throw err;

      // A cancelled run (cancelCurrentTask / cancelTaskByRunId) also surfaces as
      // ShutdownError while the service is up — never retry it on another provider.
      if (err instanceof ShutdownError) throw err;

      if (err instanceof AgentMemoryLimitError) {
        throw err;
      }

      // Check if this is a rate-limit error
      const errMsg = err instanceof Error ? err.message : String(err);
      // A usage-limit message is an unambiguous rate limit; don't spend an
      // Ollama round-trip on it (and don't let the regex fallback, which has no
      // "hit your … limit" pattern, mis-classify it as a hard failure — #2590).
      const usageLimit = USAGE_LIMIT_RE.test(errMsg);
      const rateLimitDetected = usageLimit || (await isRateLimitError(errMsg));

      if (rateLimitDetected) {
        // A *weekly* allowance does not come back in 5 minutes; hold the
        // provider down for an hour so the fallback order is actually used.
        const weekly = usageLimit && /\bweekly\b/i.test(errMsg);
        log.warn(`[provider-circuit-breaker] Rate limit detected for provider "${provider}" — marking as rate-limited`);
        markProviderRateLimited(provider, weekly ? 60 * 60 * 1000 : undefined);
        // Try next provider in fallback order
        continue;
      }

      // Non-rate-limit error — rethrow immediately
      throw err;
    }
  }

  // All providers exhausted or rate-limited
  if (lastErr) throw lastErr;
  throw new AllProvidersRateLimitedError();
}
