import { z } from "zod";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, CLAUDE_TIMEOUT_MS, CLAUDE_LIVENESS_TIMEOUT_MS, CLAUDE_WORKER_MEMORY_MAX_BYTES, SERVER_PORT, INTERNAL_MCP_TOKEN, NAMEY_DB_URL, HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN, OPENROUTER_API_KEY, PROVIDER_RATE_LIMIT_COOLDOWN_MS, type Repo } from "./config.js";
import * as log from "./log.js";
import { runContext } from "./log.js";
import { formatMs } from "./format.js";
import { isShuttingDown, ShutdownError } from "./shutdown.js";
import { guardContent } from "./prompt-guard.js";
import { getModel, getFallbackOrder, type ModelTier, type Capability } from "./model-selector.js";
import type { Provider } from "./plan-parser.js";
import { isRateLimitError } from "./ollama-rate-limit-classifier.js";
import { getInstallationTokenForOwner, buildEnvForGh, buildEnvForGhGit } from "./github-app.js";
import { retryWithBackoff } from "./retry.js";

export const SENSITIVE_ENV_KEYS = [
  "CLAWS_HOME_ASSISTANT_TOKEN", "HOME_ASSISTANT_TOKEN",
  "NAMEY_DB_URL", "CLAWS_NAMEY_DB_URL",
  "OPENAI_API_KEY",
  "CLAWS_OPENROUTER_API_KEY", "OPENROUTER_API_KEY",
  "CLAWS_AUTH_TOKEN",
  "CLAWS_SLACK_BOT_TOKEN", "CLAWS_SLACK_WEBHOOK_URL",
  "KWYJIBO_AUTOMATION_API_KEY",
  "BRENDAN_SERVER_GMAIL_APP_PASSWORD",
] as const;

export function sanitiseEnvForChild(env: NodeJS.ProcessEnv, mode: "strict" | "passthrough"): NodeJS.ProcessEnv {
  const out = { ...env };
  if (mode === "strict") {
    for (const k of SENSITIVE_ENV_KEYS) delete out[k];
  }
  return out;
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

const GIT_TRANSIENT_RE = /\b(500|502|503|504|ETIMEDOUT|ECONNRESET|ECONNREFUSED|connection reset)\b|TLS handshake timeout|Could not resolve host|The requested URL returned error: 5\d\d|i\/o timeout/i;
const GIT_MAX_RETRIES = 2;

async function resolveEnvForGit(owner?: string): Promise<NodeJS.ProcessEnv | undefined> {
  if (!owner) return undefined;
  try {
    const token = await getInstallationTokenForOwner(owner);
    return buildEnvForGhGit(token);
  } catch (err) {
    log.warn(`[github-app] git token fetch failed for ${owner}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
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

function repoDir(repo: Repo): string {
  return path.join(WORK_DIR, "repos", repo.owner, repo.name);
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

/** Ensure a bare-ish main clone of the repo exists and is up to date. */
export async function ensureClone(repo: Repo, options?: EnsureCloneOptions): Promise<string> {
  const dir = repoDir(repo);

  // If this repo was fetched recently and the caller opts in, skip the fetch
  if (options?.skipFetchIfRecent) {
    const lastFetch = lastFetchedAt.get(dir);
    if (lastFetch && Date.now() - lastFetch < FETCH_TTL_MS && fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
  }

  const inflight = inflightClones.get(dir);
  if (inflight) return inflight;

  const work = (async () => {
    try {
      if (fs.existsSync(path.join(dir, ".git"))) {
        await git(["fetch", "--all", "--prune"], dir, { owner: repo.owner });
        await git(["checkout", `origin/${repo.defaultBranch}`, "--force"], dir, { owner: repo.owner });
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
 *  the same branch simultaneously. Use for read-only jobs (pr-reviewer, qa-phase).
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

/** Count how many commits are ahead of origin/<baseBranch>. */
export async function getCommitCount(wtPath: string, baseBranch: string): Promise<number> {
  const count = await git(["rev-list", "--count", `origin/${baseBranch}..HEAD`], wtPath);
  return parseInt(count, 10) || 0;
}

/** Get diff stats (files changed, insertions, deletions) compared to origin/<baseBranch>. */
export async function getDiffStats(wtPath: string, baseBranch: string): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
  const output = await git(["diff", "--shortstat", `origin/${baseBranch}...HEAD`], wtPath);
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
    `You are writing a pull request description. Here is the issue that was resolved:`,
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
  ].join("\n");

  const description = await runClaude(prompt, wtPath, { capability: "text-only", tier: "sonnet", provider: "claude" });
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

  const description = await runClaude(prompt, wtPath, { capability: "text-only", tier: "sonnet", provider: "claude" });
  if (!description.trim()) {
    throw new Error("Claude returned empty PR description for docs update");
  }
  if (attribution) {
    return `${description.trim()}\n\n---\n${attribution}`;
  }
  return description.trim();
}

/** Diagnose why an implementer run produced no commits. Returns a 1–3 sentence diagnosis string. */
export async function diagnoseNoCommits(
  wtPath: string,
  baseBranch: string,
): Promise<string> {
  const [status, log_, diff] = await Promise.all([
    git(["status", "--short"], wtPath),
    git(["log", "--oneline", "-5", `origin/${baseBranch}..HEAD`], wtPath),
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
    `git log --oneline -5 origin/${baseBranch}..HEAD:`,
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

  const diagnosis = await runClaude(prompt, wtPath, { capability: "text-only", tier: "sonnet", provider: "claude" });
  if (!diagnosis.trim()) {
    throw new Error("Claude returned empty diagnosis for no-commit run");
  }
  return diagnosis.trim();
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

  const description = await runClaude(prompt, wtPath, { capability: "text-only", tier: "sonnet", provider: "claude" });
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
    const fetch = await gitRaw(["fetch", "origin", branchName], wtPath, gitOpts);
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

    // If non-fast-forward and we have retries left, loop to fetch+rebase again
    if (push.stderr.includes("non-fast-forward") && attempt < MAX_ATTEMPTS) {
      log.warn(
        `pushBranch: non-fast-forward on attempt ${attempt}/${MAX_ATTEMPTS} for ${branchName}, retrying`,
      );
      continue;
    }

    throw new Error(
      `git push -u origin HEAD:${branchName} failed in ${wtPath}: ${push.stderr}`,
    );
  }
}

// ── MCP config ──

/**
 * Write an MCP config file for Claude CLI that includes the Claws state server.
 * Optionally merges additional MCP servers (e.g. Playwright for QA).
 * Returns the path to the written config file.
 */
export function writeClawsMcpConfig(
  cwd: string,
  options?: {
    additionalServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    includeNameyDb?: boolean;       // default true
    includeHomeAssistant?: boolean; // default true
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
  if (NAMEY_DB_URL && options?.includeNameyDb !== false) {
    env["NAMEY_DB_URL"] = NAMEY_DB_URL;
  }
  if (HOME_ASSISTANT_BASE_URL && options?.includeHomeAssistant !== false) {
    env["HOME_ASSISTANT_BASE_URL"] = HOME_ASSISTANT_BASE_URL;
  }
  if (HOME_ASSISTANT_TOKEN && options?.includeHomeAssistant !== false) {
    env["HOME_ASSISTANT_TOKEN"] = HOME_ASSISTANT_TOKEN;
  }

  const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {
    "claws-state": {
      command: "node",
      args: [mcpServerScript],
      env,
    },
    ...(options?.additionalServers ?? {}),
  };

  const configPath = path.join(cwd, ".mcp-claws.json");
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));
  return configPath;
}

/**
 * Read a repo's Claude subagent document from a worktree, stripping YAML
 * frontmatter. Returns the markdown body for injection via
 * RunClaudeOptions.appendSystemPrompt, or undefined if the file is absent
 * or empty. `role` is the filename stem, e.g. "issue-refiner".
 */
export function readRepoAgentDoc(wtPath: string, role: string): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(wtPath, ".claude", "agents", `${role}.md`), "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`[claude] readRepoAgentDoc: unexpected error reading ${role}.md: ${e}`);
    }
    return undefined;
  }
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  return body.length > 0 ? body : undefined;
}

export class BranchDeletedError extends Error {
  constructor(branchName: string) {
    super(`Remote ref origin/${branchName} does not exist (branch may have been deleted after merge)`);
    this.name = "BranchDeletedError";
  }
}

// ── Claude invocation ──

export class PushConflictError extends Error {
  constructor(branchName: string, detail: string) {
    super(`Rebase onto origin/${branchName} failed (conflicting concurrent changes): ${detail}`);
    this.name = "PushConflictError";
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

export class AgentCliError extends Error {
  public readonly exitCode: number | null;
  public readonly numTurns: number | undefined;
  constructor(output: string, exitCode: number | null, numTurns?: number) {
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
  }
}

/**
 * Thrown by runOpenRouterDirectOnce for HTTP 4xx responses (excluding 429).
 * These are client errors — retry and rate-limit machinery must NOT fire.
 */
export class OpenRouterClientError extends AgentCliError {
  constructor(output: string, exitCode: number | null) {
    super(output, exitCode);
    this.name = "OpenRouterClientError";
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

export interface RunClaudeOptions {
  /**
   * Whether this workflow needs tool calling (file edits, git, gh) or is
   * pure text generation. Required — every call site must declare this
   * explicitly so text-only workflows can be routed to cheaper providers
   * without burning Claude Opus/Sonnet quota.
   */
  capability: Capability;
  tier: ModelTier; // original model tier — required so provider fallback can re-derive the correct model ID
  mcpConfig?: string; // path to MCP config JSON file
  timeoutMs?: number; // per-task timeout override
  model?: string; // model to use (e.g. "opus", "sonnet", "o3", or a full model ID)
  provider?: Provider; // explicit CLI backend override; otherwise chosen from the capability-specific fallback order
  onProviderUsed?: (provider: Provider) => void; // called when a provider attempt begins
  onTokensUsed?: (tokensUsed: number, costUsd: number) => void; // called with token/cost data when the provider reports it (Claude CLI, OpenCode, OpenRouter direct); Codex CLI does not expose usage data
  agent?: string; // opencode agent type: "plan" or "build"
  envSanitization?: "strict" | "passthrough"; // default "strict": strip sensitive env vars before spawning child
  appendSystemPrompt?: string; // injected via --append-system-prompt (Claude CLI only)
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
  if (options?.provider === "openrouter") {
    return runOpenRouterDirectOnce(prompt, cwd, options);
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
function enrichedPath(basePath: string | undefined): string {
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
    const baseEnv = backend.env ? { ...cleaned, ...backend.env } : cleaned;
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
    const memMax = CLAUDE_WORKER_MEMORY_MAX_BYTES;
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
 * Run a single Codex CLI process via the shared runCliProcess helper.
 */
function runCodexOnce(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  if (options?.mcpConfig) {
    log.debug("MCP config is not supported by Codex backend — ignoring mcpConfig");
  }
  // Codex CLI does not expose usage data — onTokensUsed is not invoked.
  const args = ["exec", "--dangerously-bypass-approvals-and-sandbox"];
  if (options?.model) {
    args.push("-m", options.model);
  }
  return runCliProcess(prompt, cwd, {
    command: "codex",
    args,
    label: "Codex",
    processOutput(stdout, stderr, code) {
      if (code !== 0) {
        log.warn(`codex exited with code ${code}: ${stderr.slice(0, 500)}`);
        const noOutput = !stdout.trim();
        throw new AgentCliError(stderr || stdout || `codex exited with code ${code}`, code, noOutput ? 0 : undefined);
      }
      if (!stdout.trim()) {
        log.warn("Codex exited 0 but produced empty stdout — downstream consumers may receive an empty response");
      }
      return stdout;
    },
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
  return runCliProcess(prompt, cwd, {
    command: "opencode",
    args,
    label: "OpenCode",
    env: Object.keys(env).length > 0 ? env : undefined,
    processOutput(stdout, stderr, code) {
      if (code !== 0) {
        log.warn(`opencode exited with code ${code}: ${stderr.slice(0, 500)}`);
        const noOutput = !stdout.trim();
        throw new AgentCliError(stderr || stdout || `opencode exited with code ${code}`, code, noOutput ? 0 : undefined);
      }

      // Parse the NDJSON output to extract text and detect errors
      const { text, errors, tokensUsed, costUsd } = parseOpenCodeJsonOutput(stdout);

      if (errors.length > 0) {
        const errMsg = errors.join("; ");
        log.warn(`OpenCode reported error(s): ${errMsg.slice(0, 500)}`);
        throw new AgentCliError(errMsg, code, 0);
      }

      if (!text.trim() && !stdout.trim()) {
        // No JSON events at all — opencode likely hit a fatal error before
        // the session started (e.g. ProviderModelNotFoundError) and printed
        // the error to stderr while exiting 0.
        const msg = stderr.trim() || "opencode exited 0 but produced no output";
        log.warn(`OpenCode exited 0 with no output: ${msg.slice(0, 500)}`);
        throw new AgentCliError(msg, code, 0);
      }

      // Report token/cost data if available
      if (tokensUsed !== undefined && costUsd !== undefined) {
        log.info(`OpenCode usage: ${tokensUsed} tokens, $${costUsd.toFixed(6)}`);
        options?.onTokensUsed?.(tokensUsed, costUsd);
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
 * Run a single OpenRouter chat completion via direct HTTPS fetch.
 *
 * Unlike `runOpenCodeOnce`, this path does NOT spawn a subprocess and does
 * NOT send tool schemas in the request — it's a plain single-turn chat
 * completion. That unlocks models whose OpenRouter endpoints don't support
 * function calling (Qwen 2.5 Coder 32B, etc.), and sidesteps all of
 * opencode's session management overhead for workflows that only need a
 * prompt-in / text-out round trip (PR reviews, plans, triage reports).
 *
 * Rate-limit handling: HTTP 429 is mapped to an AgentCliError whose message
 * includes "rate limit" so the existing ollama rate-limit classifier (and
 * regex fallback) triggers the provider-fallback path. 5xx responses are
 * mapped to an AgentCliError with a "5xx" marker so `runWithRetry` retries
 * once. Malformed JSON / empty output are surfaced as AgentCliError too.
 *
 * Aborts use AbortController, bound to the per-call timeout. The `cwd`
 * argument is ignored — there's no filesystem context for a pure text-gen
 * call — but accepted for signature parity with other backends.
 */
async function runOpenRouterDirectOnce(
  prompt: string,
  _cwd: string,
  options?: RunClaudeOptions,
): Promise<string> {
  if (!OPENROUTER_API_KEY) {
    throw new AgentCliError(
      "OpenRouter provider selected but CLAWS_OPENROUTER_API_KEY is not set",
      null,
      0,
    );
  }
  if (options?.mcpConfig) {
    log.debug("MCP config is not supported by OpenRouter direct backend — ignoring mcpConfig");
  }
  if (options?.agent) {
    log.debug("`agent` option is not supported by OpenRouter direct backend — ignoring");
  }

  const model = options?.model ?? "";
  if (!model) {
    throw new AgentCliError("OpenRouter direct backend requires an explicit model", null, 0);
  }

  const effectiveTimeout = options?.timeoutMs ?? CLAUDE_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), effectiveTimeout);
  const startTime = Date.now();

  log.info(`OpenRouter direct request (model=${model}, timeout=${effectiveTimeout}ms)`);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        // Optional analytics headers — OpenRouter uses these for routing
        // statistics and ranking; safe to omit but nice to populate.
        "HTTP-Referer": "https://github.com/St-John-Software/claws",
        "X-Title": "claws",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    if (res.status === 429) {
      // Map to a rate-limit-tagged error so the provider-fallback loop fires.
      const bodyText = await res.text().catch(() => "");
      throw new AgentCliError(`OpenRouter rate limit (HTTP 429): ${bodyText.slice(0, 500)}`, 429);
    }
    if (res.status >= 500 && res.status < 600) {
      const bodyText = await res.text().catch(() => "");
      // Matches API_TRANSIENT_RE so runWithRetry retries once.
      throw new AgentCliError(`OpenRouter API Error: ${res.status} ${bodyText.slice(0, 500)}`, res.status, 0);
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      // 4xx = permanent client error; skip rate-limit and retry machinery.
      // (429 is already handled above; 5xx is already handled above.)
      if (res.status >= 400 && res.status < 500) {
        throw new OpenRouterClientError(`OpenRouter HTTP ${res.status}: ${bodyText.slice(0, 500)}`, res.status);
      }
      throw new AgentCliError(`OpenRouter HTTP ${res.status}: ${bodyText.slice(0, 500)}`, res.status);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new AgentCliError(`OpenRouter returned non-JSON response: ${err instanceof Error ? err.message : String(err)}`, res.status);
    }

    // Terminal content errors — don't tag with numTurns=0 because runWithRetry
    // interprets that as a transient init failure and retries. A malformed
    // response body is not transient; retrying won't help.
    const choices = (parsed as { choices?: unknown[] }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new AgentCliError(`OpenRouter response missing choices: ${JSON.stringify(parsed).slice(0, 500)}`, res.status);
    }
    const text = (choices[0] as { message?: { content?: unknown } })?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      throw new AgentCliError(`OpenRouter response missing message content: ${JSON.stringify(parsed).slice(0, 500)}`, res.status);
    }

    const usage = (parsed as { usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }).usage;
    // OpenRouter includes cost data when available in non-streaming responses
    // via the `usage.cost` field (undocumented but present in practice).
    const costUsd = (usage as { cost?: number } | undefined)?.cost;
    const totalTokens = usage?.total_tokens;
    if (totalTokens !== undefined) {
      log.info(`OpenRouter usage: ${totalTokens} tokens${costUsd !== undefined ? `, $${costUsd.toFixed(6)}` : ""} (${Date.now() - startTime}ms)`);
      if (costUsd !== undefined) {
        options?.onTokensUsed?.(totalTokens, costUsd);
      }
    }

    return text;
  } catch (err) {
    if (err instanceof AgentCliError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new AgentTimeoutError(effectiveTimeout, 0, "", "OpenRouter request aborted", _cwd);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new AgentCliError(`OpenRouter request failed: ${msg}`, null);
  } finally {
    clearTimeout(timeoutTimer);
  }
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
  const existingNodeOptions = process.env["NODE_OPTIONS"] ?? "";
  const nodeOptions = /--max-old-space-size/.test(existingNodeOptions)
    ? existingNodeOptions
    : `${existingNodeOptions} --max-old-space-size=${CLAUDE_NODE_MAX_OLD_SPACE_MB}`.trim();
  return runCliProcess(prompt, cwd, {
    command: "claude",
    args,
    label: "Claude",
    env: { NODE_OPTIONS: nodeOptions },
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
            options?.onTokensUsed?.(totalTokens, parsed.total_cost_usd);
          }
        }
      } catch (err) {
        if (err instanceof AgentCliError) throw err;
        // CLI produced non-JSON output — always treat as a CLI-level failure,
        // regardless of exit code or output length.
        throw new AgentCliError(stdout, code);
      }
      return result;
    },
  }, options);
}

const API_TRANSIENT_RE = /API Error: 5\d\d|API Error: The socket connection was closed|openai\b.*\berror\b.*\b5\d\d\b/i;

function backendLabel(provider: Provider): string {
  if (provider === "codex") return "Codex";
  if (provider === "opencode") return "OpenCode";
  if (provider === "openrouter") return "OpenRouter";
  return "Claude";
}

/**
  * Run a single attempt with automatic retry on transient failures.
  * Retries once on:
  * - 0-byte timeouts (likely a transient hang)
  * - AgentCliError with 0 turns (transient init failure)
  * - Transient API errors (5xx status codes and unexpected socket closures)
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
 * The fallback order is capability-specific: tool-use workflows walk
 * TOOL_USE_PROVIDER_FALLBACK_ORDER (default `["claude"]`), text-only workflows
 * walk TEXT_ONLY_PROVIDER_FALLBACK_ORDER (default `["opencode"]`). An explicit
 * `options.provider` pins the first attempt regardless; remaining fallback
 * providers come from the capability's order. Rate-limit detection uses the
 * Ollama-backed classifier (with regex fallback).
 */
export async function runClaude(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  // Defensive runtime fallback for bare test calls that omit options entirely.
  // Production call sites are compiler-checked to supply `capability` whenever
  // they pass an options object.
  const capability: Capability = options?.capability ?? "tool-use";
  if (options && !options.capability) {
    log.warn("[runClaude] options passed without 'capability' — defaulting to 'tool-use'. This should be set explicitly.");
  }

  const fallbackOrder = getFallbackOrder(capability);
  const configPrimary = fallbackOrder[0] ?? "claude";
  const explicitProvider = options?.provider;
  const firstProvider = explicitProvider ?? configPrimary;

  // Build the attempt order: explicit caller provider (if given) or config primary first,
  // then remaining fallback order entries (deduplicated)
  const attemptOrder: Provider[] = [firstProvider];
  for (const p of fallbackOrder) {
    if (!attemptOrder.includes(p)) {
      attemptOrder.push(p);
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
    const providerModel = isFirstTryWithExplicitModel
      ? options!.model
      : options?.tier
        ? getModel(options.tier, capability, provider)
        : options?.model;
    const providerOptions: RunClaudeOptions = { capability, tier: effectiveTier, ...options, provider, model: providerModel };
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
      return await runWithRetry(prompt, cwd, providerOptions);
    } catch (err) {
      lastErr = err;

      if (isShuttingDown()) throw err;

      // Client errors (4xx) are permanent for this payload — don't mark provider
      // rate-limited and don't call Ollama classifier.
      if (err instanceof OpenRouterClientError) {
        throw err;
      }
      if (err instanceof AgentMemoryLimitError) {
        throw err;
      }

      // Check if this is a rate-limit error
      const errMsg = err instanceof Error ? err.message : String(err);
      const rateLimitDetected = await isRateLimitError(errMsg);

      if (rateLimitDetected) {
        log.warn(`[provider-circuit-breaker] Rate limit detected for provider "${provider}" — marking as rate-limited`);
        markProviderRateLimited(provider);
        // Try next provider in fallback order
        continue;
      }

      // Non-rate-limit error — rethrow immediately
      throw err;
    }
  }

  // All providers exhausted or rate-limited
  if (lastErr) throw lastErr;
  throw new Error("All AI providers are rate-limited or unavailable");
}
