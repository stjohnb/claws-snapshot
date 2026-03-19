import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, MAX_CLAUDE_WORKERS, CLAUDE_TIMEOUT_MS, type Repo } from "./config.js";
import * as log from "./log.js";
import { isShuttingDown, ShutdownError } from "./shutdown.js";

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

// ── Bounded concurrent queue ──
// Runs up to MAX_CLAUDE_WORKERS claude processes in parallel.

type QueuedTask = {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  priority: boolean;
};

const queue: QueuedTask[] = [];
let activeCount = 0;

function drain(): void {
  while (queue.length > 0 && activeCount < MAX_CLAUDE_WORKERS) {
    const idx = queue.findIndex((t) => t.priority);
    const task = idx >= 0 ? queue.splice(idx, 1)[0] : queue.shift()!;
    activeCount++;
    (async () => {
      try {
        const result = await task.fn();
        task.resolve(result);
      } catch (err) {
        task.reject(err);
      } finally {
        activeCount--;
        drain();
      }
    })();
  }
}

export function queueStatus(): { pending: number; active: number } {
  return { pending: queue.length, active: activeCount };
}

export function enqueue<T>(fn: () => Promise<T>, priority = false): Promise<T> {
  if (isShuttingDown()) {
    return Promise.reject(new ShutdownError("Shutting down — task not started"));
  }
  return new Promise<T>((resolve, reject) => {
    queue.push({ fn, resolve: resolve as (v: unknown) => void, reject, priority });
    drain();
  });
}

export function cancelQueuedTasks(): void {
  let count = 0;
  while (queue.length > 0) {
    const task = queue.shift()!;
    task.reject(new ShutdownError("Shutting down — task cancelled"));
    count++;
  }
  if (count > 0) log.info(`Cancelled ${count} queued task(s)`);
}

// ── Git helpers ──

export function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || err.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Like git() but returns { code, stdout, stderr } instead of throwing. */
function gitRaw(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && "code" in err ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function repoDir(repo: Repo): string {
  return path.join(WORK_DIR, "repos", repo.owner, repo.name);
}

/**
 * In-flight ensureClone promises, keyed by repo directory path.
 * Prevents concurrent git fetch operations on the same clone directory.
 */
const inflightClones = new Map<string, Promise<string>>();

/** Ensure a bare-ish main clone of the repo exists and is up to date. */
export async function ensureClone(repo: Repo): Promise<string> {
  const dir = repoDir(repo);
  const inflight = inflightClones.get(dir);
  if (inflight) return inflight;

  const work = (async () => {
    try {
      if (fs.existsSync(path.join(dir, ".git"))) {
        await git(["fetch", "--all", "--prune"], dir);
        await git(["checkout", `origin/${repo.defaultBranch}`, "--force"], dir);
      } else {
        fs.mkdirSync(dir, { recursive: true });
        await new Promise<void>((resolve, reject) => {
          execFile(
            "gh",
            ["repo", "clone", repo.fullName, dir],
            (err) => (err ? reject(err) : resolve()),
          );
        });
      }
      return dir;
    } finally {
      inflightClones.delete(dir);
    }
  })();

  inflightClones.set(dir, work);
  return work;
}

/** Create a worktree on a new branch. Returns the worktree path. */
export async function createWorktree(repo: Repo, branchName: string, namespace: string): Promise<string> {
  const mainDir = await ensureClone(repo);
  const wtPath = path.join(WORK_DIR, "worktrees", repo.owner, repo.name, namespace, branchName);

  // Clean up stale worktree at this path if it exists
  if (fs.existsSync(wtPath)) {
    try {
      await git(["worktree", "remove", wtPath, "--force"], mainDir);
    } catch {
      fs.rmSync(wtPath, { recursive: true, force: true });
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
}

/** Create a worktree for an existing remote branch. Returns the worktree path. */
export async function createWorktreeFromBranch(repo: Repo, branchName: string, namespace: string): Promise<string> {
  const mainDir = await ensureClone(repo);
  const wtPath = path.join(WORK_DIR, "worktrees", repo.owner, repo.name, namespace, branchName);

  if (fs.existsSync(wtPath)) {
    try {
      await git(["worktree", "remove", wtPath, "--force"], mainDir);
    } catch {
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
  }

  // Reset local branch to match remote (handles force-pushes like Dependabot rebases)
  try {
    await git(["branch", "-f", branchName, `origin/${branchName}`], mainDir);
  } catch {
    // Branch may not exist locally yet, that's fine
  }

  // Prune stale worktree metadata (e.g. from other jobs whose directories were removed)
  await git(["worktree", "prune"], mainDir);

  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  await git(["worktree", "add", wtPath, branchName], mainDir);
  return wtPath;
}

export async function removeWorktree(repo: Repo, wtPath: string): Promise<void> {
  const mainDir = repoDir(repo);
  try {
    await git(["worktree", "remove", wtPath, "--force"], mainDir);
  } catch {
    fs.rmSync(wtPath, { recursive: true, force: true });
    // Prune stale metadata left behind after manual directory removal
    try {
      await git(["worktree", "prune"], mainDir);
    } catch {
      // best effort
    }
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

/** Generate a PR description by asking Claude to summarize the diff and issue. */
export async function generatePRDescription(
  wtPath: string,
  baseBranch: string,
  issue: { number: number; title: string; body: string },
): Promise<string> {
  const diff = await git(["diff", `origin/${baseBranch}...HEAD`], wtPath);
  const truncatedDiff = diff.slice(0, 30_000);

  const prompt = [
    `You are writing a pull request description. Here is the issue that was resolved:`,
    ``,
    `**Issue #${issue.number}: ${issue.title}**`,
    issue.body,
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
  ].join("\n");

  const description = await enqueue(() => runClaude(prompt, wtPath));
  if (!description.trim()) {
    throw new Error(
      `Claude returned empty PR description for issue #${issue.number}`,
    );
  }
  return description.trim();
}

/** Generate a PR description for documentation updates by asking Claude to summarize the diff. */
export async function generateDocsPRDescription(
  wtPath: string,
  baseBranch: string,
): Promise<string> {
  const diff = await git(["diff", `origin/${baseBranch}...HEAD`], wtPath);
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

  const description = await enqueue(() => runClaude(prompt, wtPath));
  if (!description.trim()) {
    throw new Error("Claude returned empty PR description for docs update");
  }
  return description.trim();
}

/** Regenerate a PR description from the full diff (used after ci-fixer/review-addresser pushes). */
export async function regeneratePRDescription(
  wtPath: string,
  baseBranch: string,
  pr: { number: number; title: string },
): Promise<string> {
  const diff = await git(["diff", `origin/${baseBranch}...HEAD`], wtPath);
  const truncatedDiff = diff.slice(0, 30_000);

  const prompt = [
    `You are writing a pull request description for PR #${pr.number}: ${pr.title}`,
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

  const description = await enqueue(() => runClaude(prompt, wtPath));
  if (!description.trim()) {
    throw new Error(`Claude returned empty PR description for PR #${pr.number}`);
  }
  return description.trim();
}

export async function pushBranch(wtPath: string, branchName: string): Promise<void> {
  await git(["push", "-u", "origin", branchName], wtPath);
}

// ── Claude invocation ──

export class ClaudeTimeoutError extends Error {
  readonly lastOutput: string;
  readonly lastStderr: string;
  readonly outputBytes: number;
  readonly cwd: string;

  constructor(timeoutMs: number, outputBytes: number, lastOutput: string, lastStderr: string, cwd: string) {
    super(`Claude process timed out after ${timeoutMs}ms`);
    this.name = "ClaudeTimeoutError";
    this.outputBytes = outputBytes;
    this.lastOutput = lastOutput;
    this.lastStderr = lastStderr;
    this.cwd = cwd;
  }
}

const activeChildren = new Set<ChildProcess>();
const cancelledChildren = new WeakSet<ChildProcess>();
const timedOutChildren = new WeakSet<ChildProcess>();

export function cancelCurrentTask(): boolean {
  if (activeChildren.size === 0) return false;
  for (const child of activeChildren) {
    cancelledChildren.add(child);
    child.kill("SIGTERM");
  }
  return true;
}

export function runClaude(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--dangerously-skip-permissions"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeChildren.add(child);
    const startTime = Date.now();

    let stdout = "";
    let stderr = "";

    // Heartbeat — log every 5 min while running
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log.info(`Claude process still running (PID ${child.pid}, elapsed ${elapsed}s, stdout ${stdout.length} bytes)`);
    }, 5 * 60 * 1000);

    // Timeout — kill after CLAUDE_TIMEOUT_MS
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      log.warn(`Claude process timed out after ${CLAUDE_TIMEOUT_MS}ms — sending SIGTERM`);
      log.warn(`Timeout diagnostics: cwd=${cwd}, stdout=${stdout.length} bytes, stderr=${stderr.length} bytes`);
      if (stdout.length > 0) {
        log.warn(`Last stdout (up to 2000 chars):\n${stdout.slice(-2000)}`);
      } else {
        log.warn("No stdout produced before timeout — process may have been waiting for input or stuck");
      }
      timedOutChildren.add(child);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        log.warn("Claude process did not exit after SIGTERM — sending SIGKILL");
        child.kill("SIGKILL");
      }, 10_000);
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
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
      clearInterval(heartbeat);
      activeChildren.delete(child);
      if (timedOutChildren.has(child)) {
        reject(new ClaudeTimeoutError(
          CLAUDE_TIMEOUT_MS,
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
        log.warn(`claude was killed by signal ${signal}: ${stderr.slice(0, 500)}`);
        reject(new Error(`claude was killed by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        log.warn(`claude exited with code ${code}: ${stderr.slice(0, 500)}`);
      }
      resolve(stdout);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearInterval(heartbeat);
      activeChildren.delete(child);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
