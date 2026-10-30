import type { IssueRef } from "./issue-id.js";
import { z } from "zod";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORK_DIR, PROMPT_CAPTURE_DIR, CLAUDE_TIMEOUT_MS, CLAUDE_LIVENESS_TIMEOUT_MS, AGENT_WORKER_MEMORY_MAX_BYTES, AGENT_WORKER_MEMORY_HEADROOM_BYTES, AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES, SERVER_PORT, INTERNAL_MCP_TOKEN, SESSION_POD_SETTINGS, DATABASE_URL, DATABASE_PASSWORD, HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, PI_BEST_MODEL, PROVIDER_RATE_LIMIT_COOLDOWN_MS, GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, forgejoRepoUrl, type Repo } from "./config.js";
import * as log from "./log.js";
import { runContext } from "./log.js";
import * as slack from "./slack.js";
import { MCP_TOKEN_KEY, WORKLOAD_SECRET_DIR } from "./k8s/workload.js";
import { readMcpTokenFile } from "./internal-mcp-token.js";
import { formatMs } from "./format.js";
import { isShuttingDown, ShutdownError } from "./shutdown.js";
import { guardContent } from "./prompt-guard.js";
import { getModel, getDeepModel, getEnabledProviderWeights, selectWeightedProvider, withoutProviders, NoEligibleProviderError, resolveCodexModelForAttempt, type ModelTier, type ProviderWeight } from "./model-selector.js";
import type { Provider } from "./plan-parser.js";
import { isRateLimitError } from "./ollama-rate-limit-classifier.js";
import { buildEnvForForgejoGit } from "./github-app.js";
import { retryWithBackoff } from "./retry.js";
import { SENSITIVE_ENV_KEYS } from "./sensitive-env.js";
import { FRICTION_NOTE_GUIDANCE } from "./claws-state-tools.js";
import { capabilityEnvKeys, resolveHeadlessCrossRepoAccess, resolveHeadlessForgejoAccess, resolveHeadlessPlannerCapabilityAccess } from "./capabilities.js";
import { agentAuthFingerprint, isAgentAuthExpired, isAgentAuthFailure, noteAgentAuthFailure, noteAgentAuthSuccess, reauthInstruction } from "./agent-auth-state.js";
import { enrichedPath, isCliBinaryAvailable, resolveHeadlessShell } from "./cli-path.js";
import { piCredentialEnv, splitPiModel, writePiAuthJson } from "./pi-auth.js";
import { accountToken, findClaudeAccount, isClaudeTokenEnvKey, type ClaudeAccount } from "./claude-accounts.js";
import {
  claudeProviderHeldUntil,
  getProviderRateLimitedUntil,
  isProviderRateLimited,
  markAccountRateLimited,
  markModelTierRateLimited,
  markProviderRateLimited,
  MODEL_TIER_RATE_LIMIT_COOLDOWN_MS,
  noteProviderUsed,
  pickableClaudeAccounts,
  pickClaudeAccount,
  providerHoldsStale,
  refreshProviderHolds,
} from "./provider-holds.js";
import { localTimeZone, usageLimitHoldUntil } from "./usage-limit-reset.js";
import { AgentMemoryReservationGate, AUXILIARY_AGENT_ADMISSION_BYTES, AUXILIARY_NODE_MAX_OLD_SPACE_MB, computeAdmissionReservationBytes, computeAgentMemoryPolicy, computeRunCapBytes, DEFAULT_AGENT_WORKER_MEMORY_HEADROOM_BYTES, laneBudgetBytes, MIN_PLAUSIBLE_AGENT_MEMORY_BYTES, type AgentMemoryDiagnostics, type AgentMemoryLane, type AgentMemoryReservation } from "./agent-memory-budget.js";
import { CODEX_DISABLE_UPDATE_CHECK_TOML } from "./session-env-file.js";
import { getRepoConfig } from "./repo-config.js";
import { auditOutgoingFiles, DEFAULT_MAX_PUSH_FILE_BYTES, ensureCoreDumpExclude, OversizedPushError } from "./push-guard.js";

export { SENSITIVE_ENV_KEYS };
export { enrichedPath };
let warnedNoHeadlessShell = false;
export { OversizedPushError };

export function sanitiseEnvForChild(env: NodeJS.ProcessEnv, mode: "strict" | "passthrough"): NodeJS.ProcessEnv {
  const out = { ...env };
  // The service runs with NODE_ENV=production; an agent inheriting it gets an
  // `npm ci` that silently skips dev dependencies.
  delete out["NODE_ENV"];
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
// libcurl's curl error 7 (`Failed to connect to HOST port 443 after 1 ms: Couldn't connect to
// server`) from a brief forge or proxy restart failed the CI fixer's push with zero retries
// (#clw_01M5TAH9YQMT53BMBZBBFQCCY3); `could not read Username` and `Repository not found` still match nothing.
const GIT_TRANSIENT_RE = /\b(500|502|503|504|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAGAIN|connection reset)\b|TLS handshake timeout|Could not resolve host|The requested URL returned error: 5\d\d|i\/o timeout|failed to create new OS thread|resource temporarily unavailable|Connection timed out|Connection refused|Network is unreachable|Connection closed by remote host|Failed to connect to|Couldn't connect to server|kex_exchange_identification|client_loop: send disconnect|cannot lock ref|unable to update local ref/i;
const GIT_MAX_RETRIES = 2;
// Pack-transfer failures that abort a clone mid-download, e.g. claws#3456:
// `curl 92 HTTP/2 stream 7 ... CANCEL`, `early EOF`, `fetch-pack: invalid index-pack output`.
const CLONE_TRANSIENT_RE = new RegExp(
  `${GIT_TRANSIENT_RE.source}|RPC failed|early EOF|unexpected disconnect|HTTP/2 stream|curl \\d+|invalid index-pack output|The remote end hung up unexpectedly|fetch-pack`,
  "i",
);
// Backoff 1+2+4+8+16 s: rides out a brief forge or proxy restart.
const CLONE_MAX_RETRIES = 5;

/** Fixed message prefix of {@link TransientGitError}; the worker matches failed rows on it. */
export const TRANSIENT_GIT_PREFIX = "transient git failure";

/** A git network operation (clone, refresh fetch or push) that kept failing with a transient forge/network error after every retry. The error reporter does not file an issue for it. */
export class TransientGitError extends Error {
  readonly op: "clone" | "fetch" | "push";
  readonly subject: string;
  readonly attempts: number;
  constructor(op: "clone" | "fetch" | "push", subject: string, attempts: number, elapsedMs: number, cause: Error) {
    super(`${TRANSIENT_GIT_PREFIX}: ${op} ${subject} after ${attempts} attempts over ${formatMs(elapsedMs)}: ${stripCredentialHelperNoise(cause.message)}`, { cause });
    this.name = "TransientGitError";
    this.op = op;
    this.subject = subject;
    this.attempts = attempts;
  }
}

/**
 * Shared give-up for the long retry window: rethrows a non-transient error unchanged,
 * otherwise logs and returns a {@link TransientGitError} for the caller to throw.
 */
function transientGiveUp(op: "clone" | "fetch" | "push", subject: string, startedAt: number, err: unknown): TransientGitError {
  const error = err instanceof Error ? err : new Error(String(err));
  if (!CLONE_TRANSIENT_RE.test(error.message)) throw err;
  const elapsed = Date.now() - startedAt;
  const fatal = error.message.split("\n").find((l) => l.startsWith("fatal:")) ?? error.message.split("\n")[0];
  log.warn(`${op} ${subject} giving up after ${CLONE_MAX_RETRIES + 1} attempts over ${formatMs(elapsed)}; transient error persisted: ${fatal}`);
  return new TransientGitError(op, subject, CLONE_MAX_RETRIES + 1, elapsed, error);
}

/** Drop the libsecret credential-helper "Secret Service" CRITICAL line from git stderr. */
export function stripCredentialHelperNoise(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !/\(process:\d+\): CRITICAL \*\*:.*Secret Service/.test(line))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// Push rejections that a fetch-rebase-push retry can resolve. `non-fast-forward`
// is the classic concurrent-push race. `cannot lock ref ...: reference already
// exists` is GitHub's server-side ref race on a *create*: receive-pack applied
// (or is concurrently applying) the ref while our client still had the old ref
// advertisement, so it sent a create command for a ref that now exists (#2834).
// Retrying fetches the now-visible ref, rebases onto it (a no-op when it is our
// own commit) and pushes again. Deliberately does NOT match permanent rejections
// (`could not read Username`, `protected branch`, `shallow update not allowed`).
const PUSH_RETRYABLE_RE = /non-fast-forward|cannot lock ref|reference already exists/i;

/** Author/committer env vars every git subprocess needs: the service host has
 *  no global git identity, so git must be told who it is (#3206). */
export function gitIdentityEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: GIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: GIT_AUTHOR_EMAIL,
  };
}

/**
 * Git/GitHub auth an ambient shell (or an agent pod launched by an older
 * Claws) may export; strict-mode children never inherit it, so `forgejoEnv`
 * is their only source of git credentials.
 */
function isAmbientGitAuthEnvKey(key: string): boolean {
  return key === "GH_TOKEN" || key === "GITHUB_TOKEN" || key === "CLAWS_GIT_CREDENTIAL_TOKEN"
    || key === "GIT_CONFIG_COUNT" || key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_");
}

async function resolveEnvForGit(owner?: string): Promise<NodeJS.ProcessEnv> {
  if (!owner) return { ...process.env, ...gitIdentityEnv() };
  return { ...buildEnvForForgejoGit(), ...gitIdentityEnv() };
}

/** `opts.env` replaces the owner-derived Forgejo env, e.g. for a GitHub
 *  snapshot target's `buildEnvForGitHubGit`; the git identity is still added. */
export function git(args: string[], cwd: string, opts: { maxBuffer?: number; owner?: string; env?: NodeJS.ProcessEnv; maxRetries?: number; transientRe?: RegExp } = {}): Promise<string> {
  const maxBuffer = opts.maxBuffer ?? 10 * 1024 * 1024;
  return retryWithBackoff(
    async () => {
      const env = opts.env ? { ...opts.env, ...gitIdentityEnv() } : await resolveEnvForGit(opts.owner);
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
    opts.maxRetries ?? GIT_MAX_RETRIES,
    (err) => (opts.transientRe ?? GIT_TRANSIENT_RE).test(err.message),
    `git ${args[0]}`,
  );
}

/** Like git() but returns { code, stdout, stderr } instead of throwing. */
function gitRaw(
  args: string[],
  cwd: string,
  opts: { owner?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
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

/** The clone URL for a repo on Forgejo. */
function cloneUrl(repo: Repo): string {
  return `${forgejoRepoUrl(repo.fullName)}.git`;
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

/**
 * Clone `repo` into `dir`, retrying transient network failures from a clean target.
 * Removes `dir` unconditionally, so call it only when `dir/.git` is missing.
 * Uses a single-shot `git clone` for Forgejo (not `git()`, which retries itself).
 */
async function cloneWithRetry(repo: Repo, dir: string): Promise<void> {
  const attempt = async (): Promise<void> => {
    await rmrf(dir);
    fs.mkdirSync(dir, { recursive: true });
    // Plain git: buildEnvForForgejoGit injects the Forgejo host's credential helper.
    const cwd = path.dirname(dir);
    const env = await resolveEnvForGit(repo.owner);
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["clone", cloneUrl(repo), dir], { cwd, maxBuffer: 10 * 1024 * 1024, env }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`git clone ${cloneUrl(repo)} ${dir} failed in ${cwd}: ${stripCredentialHelperNoise(stderr) || err.message}`));
        else resolve();
      });
    });
  };
  const startedAt = Date.now();
  try {
    await retryWithBackoff(attempt, CLONE_MAX_RETRIES, (err) => CLONE_TRANSIENT_RE.test(err.message), `clone ${repo.fullName}`);
  } catch (err) {
    throw transientGiveUp("clone", repo.fullName, startedAt, err);
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
        const fetchStartedAt = Date.now();
        try {
          await git(["fetch", "--all", "--prune"], dir, { owner: repo.owner, maxRetries: CLONE_MAX_RETRIES, transientRe: CLONE_TRANSIENT_RE });
        } catch (err) {
          throw transientGiveUp("fetch", repo.fullName, fetchStartedAt, err);
        }
        await git(["checkout", `origin/${repo.defaultBranch}`, "--force"], dir, { owner: repo.owner });
      } else {
        await cloneWithRetry(repo, dir);
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

/** Keep core dumps out of every worktree's `git add` (push-guard.ts); never blocks the run. */
function excludeCoreDumps(mainDir: string): void {
  try {
    ensureCoreDumpExclude(path.join(mainDir, ".git"));
  } catch (err) {
    log.warn(`[push-guard] could not write core-dump excludes in ${mainDir}: ${err}`);
  }
}

/** Create a worktree on a new branch. Returns the worktree path. */
export async function createWorktree(repo: Repo, branchName: string, namespace: string): Promise<string> {
  const mainDir = await ensureClone(repo);
  excludeCoreDumps(mainDir);
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
  excludeCoreDumps(mainDir);
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
  issue: { number: IssueRef; title: string; body: string },
  repo: string,
  attribution?: string,
): Promise<string> {
  const guard = async (text: string, source: string) =>
    await guardContent(text, { repo, source, itemNumber: issue.number });
  const diff = await git(["diff", `origin/${baseBranch}...HEAD`], wtPath, { maxBuffer: 200 * 1024 * 1024 });
  const truncatedDiff = diff.slice(0, 30_000);

  const prompt = [
    `You are writing a pull request description. Here is the issue that prompted the work (the actual implementation may have diverged from it — describe what the DIFF does, not what the issue asked for):`,
    ``,
    `**Issue #${issue.number}: ${await guard(issue.title, "issue-title")}**`,
    await guard(issue.body, "issue-body"),
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
    `Prefer AFTER-MERGE when both readings are plausible — BEFORE-MERGE holds the PR from merging, and parks its issue in Blocked once the PR is otherwise ready, until the operator does the step.`,
    `A manual action must be a REQUIRED step that changes state and that no automation can perform. NEVER emit a marker for verification, observation or monitoring — "verify the alert fires", "confirm the probe works against the live deployment", "monitor the dashboard after reconcile", "check that the migration applied", "keep an eye on error rates" are NOT manual actions and must be omitted entirely. If a check is worth doing, encode it as a test, a CI step, or a monitor in this PR instead of asking a human for it.`,
    `Also do NOT emit either line for ordinary code changes, dependency bumps, anything that merges cleanly on its own, or anything CI or this PR could have done itself. When in doubt, omit both.`,
  ].join("\n");

  const description = await runClaude(prompt, wtPath, { tier: "sonnet", provider: "claude", admissionBytes: AUXILIARY_AGENT_ADMISSION_BYTES });
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

  const description = await runClaude(prompt, wtPath, {
    tier: "sonnet",
    provider: "claude",
    strictProvider: true,
    admissionBytes: AUXILIARY_AGENT_ADMISSION_BYTES,
  });
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

  const diagnosis = await runClaude(prompt, wtPath, { tier: "sonnet", provider: "claude", admissionBytes: AUXILIARY_AGENT_ADMISSION_BYTES });
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
    `You are writing a pull request description for PR #${pr.number}: ${await guardContent(pr.title, { repo, source: "pr-title", itemNumber: pr.number })}`,
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

  const description = await runClaude(prompt, wtPath, { tier: "sonnet", provider: "claude", admissionBytes: AUXILIARY_AGENT_ADMISSION_BYTES });
  if (!description.trim()) {
    throw new Error(`Claude returned empty PR description for PR #${pr.number}`);
  }
  if (attribution) {
    return `${description.trim()}\n\n---\n${attribution}`;
  }
  return description.trim();
}

/**
 * Fetch, rebase onto and push `HEAD` to `origin/<branchName>`. Before any
 * network call it audits the outgoing commits (push-guard.ts) and throws
 * `OversizedPushError` if they add a core dump or a new file over the repo's
 * `maxPushFileBytes`, so such a blob never reaches the forge.
 */
export async function pushBranch(
  wtPath: string,
  branchName: string,
  repo: Pick<Repo, "owner" | "fullName" | "defaultBranch">,
): Promise<void> {
  const MAX_ATTEMPTS = 3;
  const gitOpts = { owner: repo.owner };

  const maxFileBytes = getRepoConfig(repo.fullName)?.maxPushFileBytes ?? DEFAULT_MAX_PUSH_FILE_BYTES;
  const offenders = await auditOutgoingFiles(
    wtPath,
    { branchName, defaultBranch: repo.defaultBranch, maxFileBytes },
    (args) => gitRaw(args, wtPath, gitOpts),
  );
  if (offenders.length > 0) {
    const refused = new OversizedPushError(branchName, offenders, maxFileBytes);
    const detail = offenders.map((o) => `${o.path} ${o.reason} ${o.bytes}B in ${o.commit.slice(0, 12)}`).join(", ");
    log.error(`[pushBranch] ${repo.fullName}: ${refused.message} (offenders: ${detail})`);
    throw refused;
  }

  // Ride out a short forge outage within one attempt of a network step.
  // `passThrough` exempts rejections the fetch-rebase loop handles itself.
  const networkStep = async (op: "fetch" | "push", args: string[], passThrough?: RegExp): Promise<{ code: number; stderr: string }> => {
    const startedAt = Date.now();
    try {
      return await retryWithBackoff(
        async () => {
          const result = await gitRaw(args, wtPath, gitOpts);
          if (result.code !== 0 && !passThrough?.test(result.stderr) && CLONE_TRANSIENT_RE.test(result.stderr)) {
            throw new Error(`git ${args.join(" ")} failed in ${wtPath}: ${result.stderr}`);
          }
          return result;
        },
        CLONE_MAX_RETRIES,
        (err) => CLONE_TRANSIENT_RE.test(err.message),
        `${op} ${branchName}`,
      );
    } catch (err) {
      throw transientGiveUp(op, `origin/${branchName} from ${wtPath}`, startedAt, err);
    }
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Fetch latest remote state to incorporate concurrent changes
    const fetch = await networkStep(
      "fetch",
      ["fetch", "origin", `refs/heads/${branchName}:refs/remotes/origin/${branchName}`],
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

    const push = await networkStep("push", ["push", "-u", "origin", `HEAD:${branchName}`], PUSH_RETRYABLE_RE);
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
 * Write a Claude-style MCP config file that includes the Claws state server.
 * Set `includeClawsState: false` for agents that process untrusted third-party
 * content — the state server exposes queue state, cross-repo task history, open
 * PR titles and the operator's config as callable tools, which such an agent
 * must not be able to read (let alone fold into its own output).
 * `sessionId` is set only for interactive sessions and enables the
 * `claws_set_session_title` tool, which retitles *that* session and no other.
 * `plannerRun` is set only for one planner invocation (issue-refiner) and
 * enables the planner tools for *that* run and no other (src/planner-tools.ts);
 * `requirementsRun` is set only for one requirements-writer invocation and
 * enables `claws_save_requirements`, which writes the record to `outFile`
 * (src/requirements-tools.ts);
 * `origin` is the headless agent's working issue as `owner/name#ref`, which
 * `claws_create_issue` forwards so a deduplicated call can name it;
 * `fileSuffix` names the file `.mcp-claws-<suffix>.json` so the plan and
 * step-back configs of one worktree do not overwrite each other.
 * Returns the path to the written config file.
 */
export function writeClawsMcpConfig(
  cwd: string,
  options?: {
    includeHomeAssistant?: boolean; // default false
    includeClawsState?: boolean; // default true
    sessionId?: string;
    origin?: string;
    /** The headless run's `tasks` row id, recorded on its friction notes. */
    taskId?: number;
    plannerRun?: { id: string; stage: "plan" | "refine" | "step_back" | "followup" | "verify"; offers?: readonly ("duplicate" | "alert-triage")[]; allowOutcomes?: boolean };
    requirementsRun?: { outFile: string };
    fileSuffix?: string;
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
  // In an agent pod the service is not on localhost; its HTTP-backed tools go to
  // the service's in-cluster URL. They authenticate with the pod's own token from
  // its Secret, which the service accepts across its restarts while the row runs —
  // this process's INTERNAL_MCP_TOKEN is random and known to no service.
  if (process.env["CLAWS_AGENT_POD_ROW"]) {
    const tokenFile = path.join(WORKLOAD_SECRET_DIR, MCP_TOKEN_KEY);
    env["CLAWS_MCP_BASE_URL"] = SESSION_POD_SETTINGS.mcpUrl;
    env["CLAWS_MCP_AUTH_TOKEN_FILE"] = tokenFile;
    env["CLAWS_MCP_AUTH_TOKEN"] = readMcpTokenFile(tokenFile, "");
    if (!env["CLAWS_MCP_AUTH_TOKEN"]) {
      log.warn(`[writeClawsMcpConfig] pod's MCP token file ${tokenFile} is missing or empty — claws-state HTTP tool calls will fail with 401`);
    }
    // A planner run's registry lives in this pod, not in the service, so the
    // planner tools post to the pod's own loopback listener, which
    // agent-pod/run.ts publishes here (#clw_01M3A42ZTGECAB11S0BZA6NG1A).
    const plannerBaseUrl = process.env["CLAWS_PLANNER_RUN_BASE_URL"] ?? "";
    if (plannerBaseUrl) {
      env["CLAWS_MCP_PLANNER_BASE_URL"] = plannerBaseUrl;
    } else if (options?.plannerRun) {
      log.warn(`[writeClawsMcpConfig] CLAWS_PLANNER_RUN_BASE_URL is unset in this agent pod — planner tool calls for run ${options.plannerRun.id} will reach the service and fail with 404`);
    }
  }
  if (options?.sessionId) env["CLAWS_MCP_SESSION_ID"] = options.sessionId;
  if (options?.origin) env["CLAWS_MCP_ORIGIN"] = options.origin;
  if (options?.taskId) env["CLAWS_MCP_TASK_ID"] = String(options.taskId);
  if (options?.plannerRun) {
    env["CLAWS_MCP_PLANNER_RUN_ID"] = options.plannerRun.id;
    env["CLAWS_MCP_PLANNER_STAGE"] = options.plannerRun.stage;
    env["CLAWS_MCP_PLANNER_OFFERS"] = (options.plannerRun.offers ?? []).join(",");
    env["CLAWS_MCP_PLANNER_ALLOW_OUTCOMES"] = String(options.plannerRun.allowOutcomes ?? true);
  }
  if (options?.requirementsRun) env["CLAWS_MCP_REQUIREMENTS_OUT"] = options.requirementsRun.outFile;
  // The MCP server runs out-of-process and reads the database directly; when
  // Claws is on Postgres there is no claws.db for it to fall back to.
  if (DATABASE_URL) env["CLAWS_DATABASE_URL"] = DATABASE_URL;
  if (DATABASE_PASSWORD) env["CLAWS_DATABASE_PASSWORD"] = DATABASE_PASSWORD;
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
  };

  const suffix = options?.fileSuffix?.replace(/[^A-Za-z0-9_-]/g, "");
  const configPath = path.join(cwd, suffix ? `.mcp-claws-${suffix}.json` : ".mcp-claws.json");
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
 * to RunClaudeOptions.mcpConfig; each automated backend converts it as needed.
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

type ClaudeMcpServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

function isStringRecord(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every((v) => typeof v === "string");
}

export function readClaudeMcpServers(configPath: string): Record<string, ClaudeMcpServer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`Could not read MCP config ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`MCP config ${configPath} must be a JSON object`);
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`MCP config ${configPath} must contain an mcpServers object`);
  }

  const out: Record<string, ClaudeMcpServer> = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`MCP server ${name} in ${configPath} must be an object`);
    }
    const server = raw as { command?: unknown; args?: unknown; env?: unknown };
    if (typeof server.command !== "string" || server.command.trim() === "") {
      throw new Error(`MCP server ${name} in ${configPath} must have a command string`);
    }
    if (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === "string"))) {
      throw new Error(`MCP server ${name} in ${configPath} has invalid args`);
    }
    if (server.env !== undefined && !isStringRecord(server.env)) {
      throw new Error(`MCP server ${name} in ${configPath} has invalid env`);
    }
    out[name] = {
      command: server.command,
      ...(server.args !== undefined ? { args: server.args } : {}),
      ...(server.env !== undefined ? { env: server.env } : {}),
    };
  }
  return out;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

export function codexMcpServersToml(mcpConfigPath: string): string {
  const servers = readClaudeMcpServers(mcpConfigPath);
  const lines: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${tomlKey(name)}]`);
    lines.push(`command = ${tomlString(server.command)}`);
    if (server.args !== undefined) {
      lines.push(`args = [${server.args.map(tomlString).join(", ")}]`);
    }
    if (server.env !== undefined && Object.keys(server.env).length > 0) {
      lines.push(`[mcp_servers.${tomlKey(name)}.env]`);
      for (const [key, value] of Object.entries(server.env)) {
        lines.push(`${tomlKey(key)} = ${tomlString(value)}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function writeCodexMcpHomeForRun(mcpConfigPath: string): string {
  const parent = path.dirname(mcpConfigPath);
  const codexHome = path.join(parent, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(codexHome, 0o700);

  const configPath = path.join(codexHome, "config.toml");
  fs.writeFileSync(configPath, `${CODEX_DISABLE_UPDATE_CHECK_TOML}\n${codexMcpServersToml(mcpConfigPath)}`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);

  const sourceAuthPath = path.join(process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex"), "auth.json");
  if (fs.existsSync(sourceAuthPath)) {
    const authJson = fs.readFileSync(sourceAuthPath);
    const destAuthPath = path.join(codexHome, "auth.json");
    fs.writeFileSync(destAuthPath, authJson, { mode: 0o600 });
    fs.chmodSync(destAuthPath, 0o600);
  }

  return codexHome;
}

export function opencodeConfigContent(mcpConfigPath?: string): string {
  const config: Record<string, unknown> = { permission: "allow" };
  if (mcpConfigPath) {
    const servers = readClaudeMcpServers(mcpConfigPath);
    config["mcp"] = Object.fromEntries(Object.entries(servers).map(([name, server]) => [
      name,
      {
        type: "local",
        command: [server.command, ...(server.args ?? [])],
        ...(server.env !== undefined ? { environment: server.env } : {}),
        enabled: true,
        // Both claws-state long-poll tools allow 270 seconds; leave HTTP overhead.
        timeout: name === "claws-state" ? 300_000 : 30_000,
      },
    ]));
  }
  return JSON.stringify(config);
}

/** pi's `mcp.json`: the run's Claude MCP config, in pi's `mcpServers` shape. */
export function piMcpJsonContent(mcpConfigPath: string): string {
  const servers = readClaudeMcpServers(mcpConfigPath);
  return JSON.stringify({
    mcpServers: Object.fromEntries(Object.entries(servers).map(([name, server]) => [
      name,
      {
        command: server.command,
        ...(server.args !== undefined ? { args: server.args } : {}),
        ...(server.env !== undefined ? { env: server.env } : {}),
        // Seconds. Both claws-state long-poll tools allow 270 seconds; leave HTTP overhead.
        timeout: name === "claws-state" ? 300 : 30,
      },
    ])),
  });
}

/**
 * Create a throwaway 0700 `PI_CODING_AGENT_DIR` for one pi run, under the
 * worktree's {@link agentMcpDir} so `removeAgentMcpDir` and the startup sweep
 * clean it up. pi reads user-level settings, extensions and `mcp.json` from
 * this dir, so a fresh one keeps the host's `~/.pi/agent` out of the run; the
 * run's MCP servers, when any, are written to its `mcp.json`, and the Codex
 * login, when there is one, to its `auth.json` as pi's `openai-codex` entry.
 */
export function writePiAgentDirForRun(cwd: string, mcpConfigPath?: string): string {
  const parent = agentMcpDir(cwd);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o700);
  const piDir = path.join(parent, `pi-agent-${randomSuffix()}`);
  fs.mkdirSync(piDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(piDir, 0o700);
  if (mcpConfigPath) {
    const mcpPath = path.join(piDir, "mcp.json");
    fs.writeFileSync(mcpPath, piMcpJsonContent(mcpConfigPath), { mode: 0o600 });
    fs.chmodSync(mcpPath, 0o600);
  }
  writePiAuthJson(piDir);
  return piDir;
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

/** Drop the whole agent-output tree. Called once at startup: a crash between
 *  the file write and the `finally` cleanup in `runClaude` leaves a stray
 *  output file on disk with nothing left to consume it, and no agent is
 *  running at startup. Never throws. */
export function pruneAgentOutputDir(): void {
  try {
    fs.rmSync(path.join(WORK_DIR, "agent-output"), { recursive: true, force: true });
  } catch {
    // Best effort — startup must not be blocked by a stale output dir.
  }
}

/** Unique path for one agent run's output file. Unique per call so concurrent
 *  agents (and per-file pr-reviewer passes) never collide. */
export function agentOutputFilePath(label?: string): string {
  const dir = path.join(WORK_DIR, "agent-output");
  fs.mkdirSync(dir, { recursive: true });
  const safe = (label ?? "agent").replace(/[^a-zA-Z0-9_-]/g, "-");
  return path.join(dir, `${safe}-${Date.now()}-${randomSuffix()}.md`);
}

export function buildOutputFileInstruction(filePath: string): string {
  return [
    ``,
    `HOW YOUR OUTPUT IS COLLECTED — read this last and follow it exactly:`,
    `Write your COMPLETE final response to the file \`${filePath}\` (absolute path, outside the repository — use the Write tool to create it; do not append, and do not write it anywhere else).`,
    `The full contents of that file are what Claws posts onwards. Your chat/assistant message is IGNORED whenever that file is non-empty, so the file must hold the entire response the instructions above ask for — every section and every trailing marker line — with no preamble, no wrapping code fence, and no commentary about having written it.`,
    `Write the file as the LAST action you take, after all investigation is finished, and do not leave any command running in the background that could finish after it.`,
    `If the file cannot be written for any reason, put the complete response in your final assistant message instead — that is the fallback Claws uses when the file is missing or empty.`,
  ].join("\n");
}

/** File contents when the agent wrote them, else `fallback` (the CLI's final
 *  assistant message — today's behaviour). */
export function readAgentOutputFile(filePath: string, fallback: string): string {
  let content = "";
  try { content = fs.readFileSync(filePath, "utf8"); } catch { /* agent didn't write it */ }
  if (!content.trim()) {
    log.warn(`[runClaude] agent wrote no output file (${filePath}) — falling back to the CLI's final assistant message (${fallback.trim().length} chars)`);
    return fallback;
  }
  log.info(`[runClaude] using agent output file ${filePath} (${content.length} chars; assistant message was ${fallback.trim().length} chars)`);
  return content;
}

/** Unique path for one agent run's VERDICT file — the structured channel an agent
 *  uses to report an outcome (duplicate, blocked, …) as data rather than
 *  as a line of prose Claws has to recover by regex (#3155). Lives in the same
 *  `agent-output` dir as `agentOutputFilePath`, so `pruneAgentOutputDir` already
 *  sweeps strays at startup. */
export function agentVerdictFilePath(label?: string): string {
  const dir = path.join(WORK_DIR, "agent-output");
  fs.mkdirSync(dir, { recursive: true });
  const safe = (label ?? "agent").replace(/[^a-zA-Z0-9_-]/g, "-");
  return path.join(dir, `${safe}-verdict-${Date.now()}-${randomSuffix()}.json`);
}

/** Schema-agnostic preamble plus the caller's `docs` (the allowed JSON objects).
 *  The rules here are what make the channel safe: silence is never a verdict, and
 *  naming a verdict in the prose response does nothing. */
export function buildVerdictFileInstruction(filePath: string, docs: string): string {
  return [
    ``,
    `HOW YOU REPORT AN OUTCOME — this is a SEPARATE channel from your written response:`,
    `Some runs end in a specific outcome that Claws must act on. You report such an outcome by writing the file \`${filePath}\` (absolute path, outside the repository — use the Write tool).`,
    ``,
    docs,
    ``,
    `Rules for that file:`,
    `- Write it ONLY when one of the outcomes listed above genuinely applies. If none applies, do NOT create the file at all.`,
    `- It must contain EXACTLY ONE JSON object and nothing else — no prose, no second object, no commentary.`,
    `- A missing, empty or unparseable file means "no outcome to report". That is the normal case and is never read as an outcome.`,
    `- Write this file BEFORE your final response file; it is not part of your output, and the response file stays the last thing you write.`,
    `- Never name this file or its path in your written response. The response is posted to the issue verbatim, and naming an outcome there has NO effect — only this file does.`,
    `- Nothing is stripped from your written response, so you may quote, name and discuss any marker or verdict freely in it without triggering anything.`,
  ].join("\n");
}

/** Raw verdict-file contents, or null when the agent wrote nothing usable.
 *  Never throws — a missing, unreadable or blank file is "no verdict". */
export function readAgentVerdictFile(filePath: string): string | null {
  let content = "";
  try { content = fs.readFileSync(filePath, "utf8"); } catch { /* agent didn't write one — the normal case */ }
  if (!content.trim()) return null;
  log.info(`[runClaude] agent wrote a verdict file ${filePath} (${content.length} chars)`);
  return content;
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
 * Read the repo's root instructions file for inlining into a prompt. Every
 * provider is handed the text explicitly: codex only auto-loads `AGENTS.md`,
 * opencode neither, and the Claude path no longer relies on the CLI's own
 * auto-discovery either, so a run sees the same instructions whatever CLI
 * version is installed. `AGENTS.md` is the only root instructions file a
 * managed repo carries — there is no `CLAUDE.md` fallback.
 * Returns undefined when it does not exist or is empty; capped at 32 KiB.
 */
export function readRepoInstructions(cwd: string): string | undefined {
  const name = "AGENTS.md";
  let body: string;
  try {
    body = fs.readFileSync(path.join(cwd, name), "utf8").trim();
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`[claude] readRepoInstructions: unexpected error reading ${name}: ${e}`);
    }
    return undefined;
  }
  if (!body) return undefined;
  if (body.length > REPO_INSTRUCTIONS_MAX_BYTES) {
    log.warn(`[claude] readRepoInstructions: ${name} is ${body.length} chars — truncating to ${REPO_INSTRUCTIONS_MAX_BYTES}`);
    return body.slice(0, REPO_INSTRUCTIONS_MAX_BYTES);
  }
  return body;
}

/**
 * Prepend the repo's own root instructions, and optionally the agent-role
 * document, to a prompt. All three providers inline the root file: codex and
 * opencode have no other way to see it, and the Claude path stopped depending
 * on CLI auto-discovery, so the root file reaches the agent regardless of CLI
 * version. A caller that already hands the role document to its CLI through a
 * flag — the Claude path's `--append-system-prompt` — omits `options` so the
 * role document is not repeated inside the prompt. The text is repo-controlled,
 * which is the same trust level a CLI already grants the root instructions file
 * — the XML wrapper is the boundary, so it is deliberately not run through
 * guardContent().
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

/** Thrown when a run queued for memory admission longer than its
 *  `admissionWaitMs`. The waiter is dropped before it spawns, so no CLI ran. */
export class AdmissionTimeoutError extends Error {
  readonly waitedMs: number;
  readonly lane: AgentMemoryLane;
  constructor(waitedMs: number, lane: AgentMemoryLane) {
    super(`Gave up after ${formatMs(waitedMs)} waiting for agent memory admission (lane=${lane})`);
    this.name = "AdmissionTimeoutError";
    this.waitedMs = waitedMs;
    this.lane = lane;
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
  readonly sharedBudgetBytes: number | null;
  readonly containerLimitBytes: number | null;
  readonly headroomBytes: number;
  readonly source = "watchdog" as const;
  constructor(
    observedRssBytes: number,
    limitBytes: number,
    outputBytes: number,
    cwd: string,
    diagnostics?: Partial<AgentMemoryDiagnostics>,
  ) {
    super(`Agent process tree exceeded memory limit (${Math.round(observedRssBytes / 1048576)}MiB > ${Math.round(limitBytes / 1048576)}MiB)`);
    this.name = "AgentMemoryLimitError";
    this.observedRssBytes = observedRssBytes;
    this.limitBytes = limitBytes;
    this.outputBytes = outputBytes;
    this.cwd = cwd;
    this.sharedBudgetBytes = diagnostics?.sharedBudgetBytes ?? null;
    this.containerLimitBytes = diagnostics?.containerLimitBytes ?? null;
    this.headroomBytes = diagnostics?.headroomBytes ?? DEFAULT_AGENT_WORKER_MEMORY_HEADROOM_BYTES;
  }
}

/** How long a child closed by SIGTERM waits for Claws' own shutdown flag to
 *  catch up before it is classified as an unexplained external kill. See the
 *  `signal === "SIGTERM"` branch in `runCliProcess`'s close handler. */
export const EXTERNAL_SIGTERM_SHUTDOWN_GRACE_MS = 5_000;

/** How often the memory watchdog samples the process tree's RSS. Short enough
 *  that a tree cannot outgrow an agent pod's 2 GiB margin between samples. */
export const AGENT_MEMORY_WATCHDOG_INTERVAL_MS = 5_000;

export class AgentExternalKillError extends Error {
  readonly signal: NodeJS.Signals;
  readonly outputBytes: number;
  readonly cwd: string;
  readonly source = "external" as const;
  /** The memory policy this run was admitted under. A SIGKILL from outside
   *  Claws is what a container OOMKill looks like from inside the pod, so the
   *  container limit, shared budget and headroom are the first things an
   *  operator needs — even though Claws' own watchdog did not fire. */
  readonly sharedBudgetBytes: number | null;
  readonly containerLimitBytes: number | null;
  readonly headroomBytes: number | null;
  /** Bytes this run held against the shared budget, or null when admission was
   *  inactive. */
  readonly reservedBytes: number | null;
  constructor(
    command: string,
    signal: NodeJS.Signals,
    outputBytes: number,
    cwd: string,
    diagnostics?: Partial<AgentMemoryDiagnostics>,
    reservedBytes?: number,
  ) {
    super(`${command} was killed externally by signal ${signal}`);
    this.name = "AgentExternalKillError";
    this.signal = signal;
    this.outputBytes = outputBytes;
    this.cwd = cwd;
    this.sharedBudgetBytes = diagnostics?.sharedBudgetBytes ?? null;
    this.containerLimitBytes = diagnostics?.containerLimitBytes ?? null;
    this.headroomBytes = diagnostics?.headroomBytes ?? null;
    this.reservedBytes = diagnostics?.admissionActive ? (reservedBytes ?? null) : null;
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

/** Thrown when every eligible provider is inside its rate-limit
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
  /** The Claude account the failing attempt ran on, when the Claude backend produced it. */
  public account: string | undefined;
  constructor(output: string, exitCode: number | null, numTurns?: number, provider?: Provider, account?: string) {
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
    this.account = account;
  }
}

const activeChildren = new Set<ChildProcess>();
const cancelledChildren = new WeakSet<ChildProcess>();
const timedOutChildren = new WeakSet<ChildProcess>();
const activeRunChildren = new Map<string, Set<ChildProcess>>();
const childRunId = new WeakMap<ChildProcess, string>();

/** A run queued in the shared memory gate, before any process exists.
 *  Cancellation has to reach these too, or `/logs/:runId/cancel` marks the run
 *  cancelled while the work item keeps waiting and later spawns the CLI anyway. */
interface PendingAdmission {
  cancel: (reason: Error) => boolean;
}
const pendingAdmissions = new Set<PendingAdmission>();
const pendingRunAdmissions = new Map<string, Set<PendingAdmission>>();

function cancelPendingAdmissions(entries: Iterable<PendingAdmission> | undefined): boolean {
  if (!entries) return false;
  let cancelled = false;
  for (const entry of [...entries]) {
    if (entry.cancel(new ShutdownError("Task cancelled — shutting down"))) cancelled = true;
  }
  return cancelled;
}

// ── Provider usage-limit holds ──
//
// The holds live in `provider-holds.ts`, shared with agent pods through the
// `provider_holds` table; re-exported here so existing imports keep working.

export {
  clearProviderRateLimitState,
  getModelTierRateLimitedUntil,
  getProviderLastUsedAt,
  getProviderRateLimitedUntil,
  isModelTierRateLimited,
  isProviderRateLimited,
  markModelTierRateLimited,
  markProviderRateLimited,
} from "./provider-holds.js";

/** Attribution suffix for a run that fell back one tier on a model-specific
 *  usage limit. Contains no `*`: it sits inside `*Models used: …*` lines. */
export function tierFallbackNote(from: ModelTier): string {
  return `; fell back from ${from} (${from} usage limit)`;
}

export function cancelCurrentTask(): boolean {
  const cancelledPending = cancelPendingAdmissions(pendingAdmissions);
  if (activeChildren.size === 0) return cancelledPending;
  for (const child of activeChildren) {
    cancelledChildren.add(child);
    killProcessTree(child, "SIGTERM");
  }
  return true;
}

export function cancelTaskByRunId(runId: string): boolean {
  const cancelledPending = cancelPendingAdmissions(pendingRunAdmissions.get(runId));
  const children = activeRunChildren.get(runId);
  if (!children || children.size === 0) return cancelledPending;
  for (const child of children) {
    cancelledChildren.add(child);
    killProcessTree(child, "SIGTERM");
  }
  return true;
}

/** Tools denied to a reviewer that may read (Bash, Read, Glob, Grep stay allowed)
 *  but must never write files or reach the network beyond Bash. */
export const READ_ONLY_DISALLOWED_TOOLS = [
  "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task",
];

/** Tools stripped from pure text-extraction agents (Claude CLI backend).
 *  Denies filesystem, shell, and network access so untrusted email/WhatsApp
 *  content cannot reach Bash/Read/Write/Edit rooted at the cwd. */
export const TEXT_ONLY_DISALLOWED_TOOLS = [
  "Bash", "Edit", "Write", "NotebookEdit", "Read", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task",
];

/**
 * `claudeEnv` that stops the Claude CLI from starting background tasks, so a
 * `-p` run cannot park itself waiting on a background watcher.
 */
export const NO_BACKGROUND_TASKS_ENV: Record<string, string> = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" };

export interface RunClaudeOptions {
  tier: ModelTier; // original model tier — required so provider reselection can re-derive the correct model ID
  mcpConfig?: string; // path to MCP config JSON file
  timeoutMs?: number; // per-task timeout override
  model?: string; // model to use (e.g. "opus", "sonnet", "gpt-5.1-codex", or a full model ID)
  provider?: Provider; // explicit CLI backend override; otherwise chosen from weighted enabled providers
  strictProvider?: boolean; // when true, do not reselect any other provider if the selected one fails
  eligibleProviders?: ReadonlyArray<ProviderWeight>; // @internal weighted provider pool from item selection
  providerRandom?: () => number; // @internal deterministic weighted-selection hook for tests
  claudeAccount?: string; // @internal the Claude account runClaudeInner chose for this attempt; its token is the child's CLAUDE_CODE_OAUTH_TOKEN
  onProviderUsed?: (provider: Provider, account?: string) => void; // called when a provider attempt begins, with the Claude account it runs on (Claude, and pi on an Anthropic model)
  onAttemptModelUsed?: (provider: Provider, model: string | undefined) => void; // called with the provider-specific model after runtime validation; undefined means provider default
  onTierFallback?: (from: ModelTier, to: ModelTier) => void; // called when a model-specific usage limit (or an open tier breaker) moves the run one tier down on the same provider
  onTokensUsed?: (tokensUsed: number, costUsd: number, provider: Provider, account?: string) => void; // account: the Claude account that served the attempt, when there is one; called with token/cost data plus the backend that reported it (Claude CLI, OpenCode, and Codex — but Codex reports no cost, so costUsd is 0 there)
  agent?: string; // opencode agent type: "plan" or "build"
  envSanitization?: "strict" | "passthrough"; // default "strict": strip sensitive env vars before spawning child
  appendSystemPrompt?: string; // injected via --append-system-prompt on Claude and pi; inlined into the prompt as <agent-role> on Codex/OpenCode, which have no equivalent flag
  captureLabel?: string; // human label for prompt-capture (agent/job name); falls back to cwd basename
  disallowedTools?: string[]; // Claude CLI only: passed as --disallowedTools; ignored by other backends. A non-empty list also implicitly disables provider reselection (see `runClaudeInner`).
  /**
   * Extra environment variables for the Claude CLI child only; ignored by the
   * Codex/OpenCode backends. Unlike `disallowedTools` this is NOT a
   * provider-pinning signal: a reselected backend simply runs without it.
   */
  claudeEnv?: Record<string, string>;
  /**
   * Pin the call to `provider` with no fallback: if that backend is
   * rate-limited or fails, the call throws instead of retrying elsewhere.
   * Required whenever the run's safety depends on a Claude-CLI-only option
   * such as `disallowedTools`, which other backends silently ignore — a
   * transparent reselection would re-run the same prompt unsandboxed. Still set
   * it explicitly at tool-restricted call sites so the intent is visible
   * locally.
   */
  noProviderFallback?: boolean;
  /** Working repo full name ("owner/name") for Forgejo access (#3067). When a
   *  Forgejo token is configured, runClaude injects the `forgejo` capability's
   *  env into the child and appends its guidance to the system prompt. */
  forgejoAccessRepo?: string;
  /** @internal Resolved Forgejo env. Set by runClaudeInner only — never by call
   *  sites, and never logged or written to a prompt capture. */
  forgejoEnv?: Record<string, string>;
  /** Claws-owned capability IDs granted only to issue planner runs for read-only diagnosis. */
  plannerCapabilities?: readonly string[];
  /** @internal Resolved planner capability env. Set by runClaudeInner only —
   *  never by call sites, and never logged or written to a prompt capture. */
  plannerCapabilityEnv?: Record<string, string>;
  /**
   * Declare this call's workload class explicitly, overriding the derivation in
   * `isAuxiliaryRun()`. A positive value puts the run in the auxiliary lane of
   * the admission gate — short bookkeeping calls (PR descriptions, no-commit
   * diagnoses) that must never queue behind a multi-hour implementer; `0` forces
   * agent scale for a run that otherwise looks short.
   *
   * This is an *enforced* ceiling, not a hint: it sets the run's watchdog cap as
   * well as its reservation, so exceeding it is an `AgentMemoryLimitError`
   * rather than a silent over-commit of the container. It only ever lowers the
   * cap, and it is ignored entirely when the watchdog is disabled
   * (`agentWorkerMemoryMaxBytes=0`) — with nothing enforcing the slice there is
   * no basis for reserving less than a full run.
   */
  admissionBytes?: number;
  /**
   * Upper bound on time spent queued for memory admission. Past it the queued
   * waiter is dropped and the call rejects with `AdmissionTimeoutError` without
   * spawning. The run's own timers (`timeoutMs`, liveness) start only after
   * admission, so queued time never counts against them. Unset: wait forever.
   */
  admissionWaitMs?: number;
  /** Run on the provider's best model with reasoning at maximum (Claude:
   *  MAX_THINKING_TOKENS; Codex: model_reasoning_effort=xhigh; OpenCode:
   *  best model only). Overrides model/tier derivation on every attempt,
   *  including provider reselection. */
  deepThinking?: boolean;
  /** Collect this call's output from a file the agent writes, instead of the CLI's
   *  final assistant message (#2950). `runClaude` picks the path, appends an
   *  instruction naming it to the prompt, and returns the file's contents when it is
   *  non-empty — otherwise it falls back to the assistant message, so this is always
   *  safe to enable. Only for call sites that post model prose onwards (planner,
   *  pr-reviewer); it is ignored when `disallowedTools` denies `Write`. */
  useOutputFile?: boolean;
  /** @internal Resolved output-file path. Set by `runClaude` only — never by call sites. */
  outputFilePath?: string;
  /** Give this call a structured verdict channel (#3155). `runClaude` picks a path,
   *  appends `buildVerdictFileInstruction(path, docs)` to the prompt, and invokes
   *  `onVerdict` exactly once after a successful run with the file's raw contents —
   *  or `null` when the agent wrote nothing. Silence is always "no verdict", so a
   *  caller must never infer a destructive outcome from it. Ignored when
   *  `disallowedTools` denies `Write`. */
  verdictFile?: { docs: string; onVerdict: (raw: string | null) => void };
  /** @internal Resolved verdict-file path. Set by `runClaude` only — never by call sites. */
  verdictFilePath?: string;
  /**
   * Run as a one-shot completion for an external caller (`completion-api.ts`):
   * no tools, no MCP servers, no repo context, no GitHub/Forgejo/capability
   * credentials, and a child env built from an allow-list holding only the
   * running backend's own login. Prompt capture, the output and verdict files,
   * and a timeout retry are all skipped, and stdout/stderr content is never
   * logged. Claude, Codex and OpenCode honour it; `pi` does not, so
   * `runClaudeInner` refuses `pi` for an isolated run.
   * `systemPrompt` replaces the CLI's own: Claude reads it from
   * `systemPromptFile`; Codex and OpenCode get it as a `<system-instructions>`
   * block ahead of the prompt on stdin.
   */
  isolatedCompletion?: { systemPrompt?: string; systemPromptFile?: string };
}

/**
 * Dispatch to the correct backend based on provider option.
 */
function runClaudeOnce(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  const dispatch = (): Promise<string> => {
    if (options?.provider === "codex") return runCodexOnce(prompt, cwd, options);
    if (options?.provider === "opencode") return runOpenCodeOnce(prompt, cwd, options);
    if (options?.provider === "pi") return runPiOnce(prompt, cwd, options);
    return runClaudeCliOnce(prompt, cwd, options);
  };
  // Clear any file left by a previous attempt so a stale/partial write can never be
  // attributed to this attempt. Load-bearing for the verdict file: a verdict written
  // by a failed attempt would otherwise be acted on after a clean retry.
  const verdictPath = options?.verdictFilePath;
  if (verdictPath) { try { fs.rmSync(verdictPath, { force: true }); } catch { /* ignore */ } }
  const outPath = options?.outputFilePath;
  if (!outPath) return dispatch();
  try { fs.rmSync(outPath, { force: true }); } catch { /* ignore */ }
  return dispatch().then((result) => readAgentOutputFile(outPath, result));
}

/**
 * Returns true if the `opencode` CLI binary is findable in the enriched PATH.
 * Used by dashboard/status code to decide whether the OpenCode provider is
 * "configured" — opencode can authenticate via its own auth file
 * (`opencode auth login`), so checking only CLAWS_OPENROUTER_API_KEY misses
 * that setup. If the binary is present we assume it's usable; runtime
 * failures will still surface through the normal error path.
 */
export function isOpenCodeBinaryAvailable(): boolean {
  return isCliBinaryAvailable("opencode");
}

/** Returns true if the `pi` CLI binary is findable in the enriched PATH. */
export function isPiBinaryAvailable(): boolean {
  return isCliBinaryAvailable("pi");
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

let agentMemoryGate: AgentMemoryReservationGate | null = null;

/**
 * A run whose own timeout is measured in minutes is a single prompt→text call,
 * not an agent-scale build: nothing that reads a repo, edits files and pushes
 * finishes inside this.
 */
export const AUXILIARY_AGENT_MAX_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Whether this call belongs to the auxiliary workload class — short,
 * latency-sensitive bookkeeping rather than agent-scale work.
 *
 * Derived rather than enumerated: opt-in annotation at hand-picked call sites
 * drifts the moment a job adds another short `runClaude` call, and every such
 * call would silently reserve (and be capped at) the full agent cap. An
 * explicit `admissionBytes` still wins in both directions — a positive value
 * declares the class, `0` opts a run that looks short back into agent scale.
 *
 * The class is *enforced* (it sets the watchdog cap, not just the queue lane),
 * so the derivation demands positive evidence on every axis rather than any
 * one of them:
 *
 * - an `mcpConfig` means the run drives an external tool tree (a session pod)
 *   whose footprint cannot be read off the prompt, so
 *   it disqualifies immediately;
 * - and then either a short own timeout, or a deny-list that leaves the run no
 *   way to pull anything in at all.
 *
 * A *partial* deny-list is deliberately not evidence. Denying only
 * Bash/Edit/Write is a sandboxing signal, not a footprint one — it still
 * leaves Read, Glob, Grep, WebFetch, Task and every MCP server available, and
 * deriving the class from it once capped a 20-minute browser agent at the
 * auxiliary slice (#3168 review). The full
 * {@link TEXT_ONLY_DISALLOWED_TOOLS} set is different in kind: with the
 * filesystem, the shell, the network and sub-agents all denied, the run can
 * only turn its prompt into text, whatever its timeout says.
 */
function isAuxiliaryRun(options?: RunClaudeOptions): boolean {
  if (options?.admissionBytes !== undefined) return options.admissionBytes > 0;
  // An MCP server is an external process tree this run's prompt cannot size.
  if (options?.mcpConfig) return false;
  if (options?.timeoutMs !== undefined && options.timeoutMs <= AUXILIARY_AGENT_MAX_TIMEOUT_MS) return true;
  const disallowed = options?.disallowedTools;
  return disallowed !== undefined && TEXT_ONLY_DISALLOWED_TOOLS.every((tool) => disallowed.includes(tool));
}

/**
 * Declared footprint of an auxiliary call, or `0` for an agent-scale run.
 *
 * Floored at {@link MIN_PLAUSIBLE_AGENT_MEMORY_BYTES} for the same reason
 * `config.ts` rejects operator byte settings below it: this number is an
 * enforced watchdog cap, so a MiB-vs-bytes slip at a call site
 * (`admissionBytes: 64`) would SIGKILL every run of that job on the first
 * sample.
 */
function declaredAdmissionBytes(options?: RunClaudeOptions): number {
  if (!isAuxiliaryRun(options)) return 0;
  const declared = Math.max(0, Math.floor(options?.admissionBytes ?? AUXILIARY_AGENT_ADMISSION_BYTES));
  if (declared >= MIN_PLAUSIBLE_AGENT_MEMORY_BYTES) return declared;
  warnOnce(
    `admission-floor:${declared}`,
    `runClaude admissionBytes=${declared} is below the ${Math.round(MIN_PLAUSIBLE_AGENT_MEMORY_BYTES / 1048576)}MiB plausibility floor (bytes, not MiB?) — using the floor instead so the run is not killed on its first watchdog sample.`,
  );
  return MIN_PLAUSIBLE_AGENT_MEMORY_BYTES;
}

function resolveAgentMemoryDiagnostics(options?: RunClaudeOptions): AgentMemoryDiagnostics {
  const policy = computeAgentMemoryPolicy({
    defaultCapBytes: AGENT_WORKER_MEMORY_MAX_BYTES,
    headroomBytes: AGENT_WORKER_MEMORY_HEADROOM_BYTES,
    explicitSharedBudgetBytes: AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES,
  });
  const globalCapBytes = AGENT_WORKER_MEMORY_MAX_BYTES;
  // One number for both the watchdog and the reservation, so the sum of live
  // reservations is an upper bound on the RSS the watchdogs tolerate. With the
  // watchdog globally disabled there is nothing to enforce a slice, so the run
  // is agent-scale and reserves conservatively — and with *admission* inactive
  // (no cgroup limit, no explicit budget: dev boxes, the systemd automation
  // host) nothing is being protected either, so the smaller cap would be a
  // pure regression with no matching benefit.
  //
  // The slice is also clamped to the auxiliary lane: a declared 768 MiB
  // against a 1 GiB explicit budget (lane 512 MiB) would otherwise exceed its
  // own lane and take the solo escape hatch on every bookkeeping call — the
  // exact head-of-line blocking the lane exists to remove.
  const laneCapBytes = policy.auxiliaryBudgetBytes > 0 ? policy.auxiliaryBudgetBytes : Infinity;
  const declaredBytes = globalCapBytes > 0 && policy.admissionActive
    ? Math.min(declaredAdmissionBytes(options), laneCapBytes)
    : 0;
  return {
    effectiveLimitBytes: computeRunCapBytes(globalCapBytes, declaredBytes),
    sharedBudgetBytes: policy.sharedBudgetBytes,
    containerLimitBytes: policy.containerLimitBytes,
    headroomBytes: policy.headroomBytes,
    admissionActive: policy.admissionActive,
    auxiliaryBudgetBytes: policy.auxiliaryBudgetBytes,
    lane: declaredBytes > 0 ? "auxiliary" : "agent",
    headroomClamped: policy.headroomClamped,
  };
}

/** Warn once per distinct condition, not once per run: these conditions persist
 *  for the life of a setting and the log would otherwise carry one line per
 *  agent spawn. Keyed by fingerprint rather than by "the last thing warned
 *  about", so two conditions that alternate cannot evict each other and
 *  re-warn forever. */
const warnedMemoryConditions = new Set<string>();

function warnOnce(fingerprint: string, message: string): void {
  if (warnedMemoryConditions.has(fingerprint)) return;
  warnedMemoryConditions.add(fingerprint);
  log.warn(message);
}

function warnOnMemoryPolicyOnce(diagnostics: AgentMemoryDiagnostics): void {
  const budget = diagnostics.sharedBudgetBytes;
  if (!diagnostics.admissionActive || budget === null) return;
  if (diagnostics.headroomClamped) {
    // Depends on nothing the run supplied, so it is fingerprinted on the policy
    // inputs alone — an alternating agent/auxiliary workload must not re-emit it.
    warnOnce(
      `headroom-clamp:${budget}:${diagnostics.containerLimitBytes}:${diagnostics.headroomBytes}`,
      `agentWorkerMemoryHeadroomBytes (${Math.round(diagnostics.headroomBytes / 1048576)}MiB) leaves nothing of the ${Math.round((diagnostics.containerLimitBytes ?? 0) / 1048576)}MiB container limit — clamping the shared admission budget to ${Math.round(budget / 1048576)}MiB rather than disabling admission. Lower the headroom or set agentWorkerMemorySharedBudgetBytes explicitly.`,
    );
  }
  // Admission is decided per lane, so the cap that matters is the one measured
  // against the *lane* budget: a cap between the agent lane and the whole
  // shared budget serializes every agent run through the solo escape hatch, and
  // comparing against the shared budget would stay silent for that whole band.
  const laneBudget = laneBudgetBytes(budget, diagnostics.auxiliaryBudgetBytes, diagnostics.lane);
  if (diagnostics.effectiveLimitBytes > laneBudget) {
    warnOnce(
      `cap-over-lane:${budget}:${diagnostics.auxiliaryBudgetBytes}:${diagnostics.lane}:${diagnostics.effectiveLimitBytes}`,
      `Agent memory cap ${Math.round(diagnostics.effectiveLimitBytes / 1048576)}MiB exceeds the ${diagnostics.lane} lane's admission budget ${Math.round(laneBudget / 1048576)}MiB (shared budget ${Math.round(budget / 1048576)}MiB) — such runs are admitted only with the whole gate empty, so nothing else runs alongside them. Raise agentWorkerMemorySharedBudgetBytes (or lower agentWorkerMemoryMaxBytes / agentWorkerMemoryHeadroomBytes) to allow overlap.`,
    );
  }
}

/**
 * One process-wide gate, retuned in place when the operator changes the memory
 * settings. Constructing a replacement would orphan the reservations the
 * in-flight runs hold and hand the whole budget out a second time.
 */
function getAgentMemoryGate(sharedBudgetBytes: number | null, auxiliaryBudgetBytes: number): AgentMemoryReservationGate {
  if (!agentMemoryGate) {
    agentMemoryGate = new AgentMemoryReservationGate(sharedBudgetBytes, auxiliaryBudgetBytes);
  } else {
    agentMemoryGate.setBudget(sharedBudgetBytes, auxiliaryBudgetBytes);
  }
  return agentMemoryGate;
}

/**
 * Re-read the memory settings into the live gate.
 *
 * `getAgentMemoryGate()` otherwise only runs inside `runCliProcess`, so an
 * operator raising `agentWorkerMemorySharedBudgetBytes` to unblock a stuck
 * queue would see no effect until some *other* run happened to start — and if
 * every fiber is parked in the gate, none ever will. Registered on the config
 * reload path below.
 */
export function retuneAgentMemoryGate(): void {
  const diagnostics = resolveAgentMemoryDiagnostics();
  getAgentMemoryGate(diagnostics.sharedBudgetBytes, diagnostics.auxiliaryBudgetBytes);
}

/** Drops the process-wide gate so one test's leaked reservation cannot change
 *  the meaning of the next test's admission. Waiters still parked in the
 *  discarded gate are rejected rather than abandoned: a permanently-pending
 *  promise and a swallowed `runClaude` call would otherwise vanish silently
 *  into the next test. */
export function resetAgentMemoryGateForTests(): void {
  agentMemoryGate?.rejectAllWaiters(new ShutdownError("agent memory gate reset"));
  agentMemoryGate = null;
  warnedMemoryConditions.clear();
}

/**
 * How long a still-queued run goes between "still waiting" log lines. The
 * enqueue line alone is invisible once a wait runs into hours, and a
 * gate-blocked run is otherwise indistinguishable from one doing work.
 */
export const AGENT_MEMORY_WAIT_LOG_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Live admission-gate depth, so `workerStatus()` (and through it the dashboard
 * and `/api/runtime/status`) can tell "waiting for memory" apart from
 * "running": a work-queue fiber blocked in the gate still holds its claimed
 * row and still reports as in-flight.
 */
export function agentMemoryAdmissionStatus(): {
  active: boolean;
  budgetBytes: number | null;
  auxiliaryBudgetBytes: number;
  reservedBytes: number;
  admitted: number;
  waiting: number;
} {
  // A read-only status handler must never construct or retune the gate — that
  // would make polling `/api/runtime/status` able to admit queued runs. The
  // gate is materialised at boot by `retuneAgentMemoryGate()` instead; before
  // that (and in tests that reset it) report the configured policy with an
  // empty gate rather than claiming admission is inactive.
  const gate = agentMemoryGate;
  if (!gate) {
    const diagnostics = resolveAgentMemoryDiagnostics();
    return {
      active: diagnostics.admissionActive,
      budgetBytes: diagnostics.sharedBudgetBytes,
      auxiliaryBudgetBytes: diagnostics.auxiliaryBudgetBytes,
      reservedBytes: 0,
      admitted: 0,
      waiting: 0,
    };
  }
  return {
    active: gate.active,
    budgetBytes: gate.budget,
    auxiliaryBudgetBytes: gate.auxiliaryBudget,
    reservedBytes: gate.reserved,
    admitted: gate.admitted,
    waiting: gate.waiting,
  };
}

/** Anthropic API key env names no child inherits; OpenCode's backend env sets ANTHROPIC_API_KEY itself. */
const ANTHROPIC_API_KEY_ENV_KEYS = ["ANTHROPIC_API_KEY", "CLAWS_ANTHROPIC_API_KEY"] as const;

/** Env keys an isolated completion's child inherits from Claws' own environment, whatever the backend. */
export const ISOLATED_COMPLETION_BASE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR"] as const;

/** The one login env key each backend may inherit in an isolated completion. */
const ISOLATED_COMPLETION_LOGIN_ENV_KEYS: Partial<Record<Provider, string>> = {
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
  codex: "CODEX_HOME",
  opencode: "OPENROUTER_API_KEY",
};

/**
 * The allow-listed env for an isolated completion's child, before the backend's
 * own `env` is merged. Claude's login is the chosen account's token, not the
 * inherited one.
 */
function isolatedCompletionEnv(provider: Provider, claudeAccount?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const loginKey = ISOLATED_COMPLETION_LOGIN_ENV_KEYS[provider];
  for (const key of [...ISOLATED_COMPLETION_BASE_ENV_KEYS, ...(loginKey ? [loginKey] : [])]) {
    const value = key === loginKey && provider === "claude" && claudeAccount ? accountToken(claudeAccount) : process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The prompt an isolated Codex/OpenCode run reads on stdin, with the caller's system prompt inlined ahead of it. */
function withIsolatedSystemPrompt(prompt: string, options: RunClaudeOptions): string {
  const system = options.isolatedCompletion?.systemPrompt?.trim();
  return system ? `<system-instructions>\n${system}\n</system-instructions>\n\n${prompt}` : prompt;
}

/** CLI output fit for a log line: its first 500 characters, or only its length in an isolated completion. */
function cliOutputForLog(text: string, options?: RunClaudeOptions): string {
  return options?.isolatedCompletion ? `${text.length} bytes` : text.slice(0, 500);
}

function runCliProcess(
  prompt: string,
  cwd: string,
  backend: CliBackendConfig,
  options?: RunClaudeOptions,
  /** Resolved once by the caller when it also needs the lane (the Claude
   *  backend sizes `--max-old-space-size` from it). Re-deriving the class at
   *  two call sites is how the heap ceiling and the watchdog cap came to
   *  disagree; passing the same object makes divergence impossible. */
  memoryDiagnostics: AgentMemoryDiagnostics = resolveAgentMemoryDiagnostics(options),
): Promise<string> {
  // An external caller's prompt and output must never reach the log.
  const isolated = !!options?.isolatedCompletion;
  warnOnMemoryPolicyOnce(memoryDiagnostics);
  const reservationBytes = computeAdmissionReservationBytes({
    admissionActive: memoryDiagnostics.admissionActive,
    sharedBudgetBytes: memoryDiagnostics.sharedBudgetBytes,
    effectiveLimitBytes: memoryDiagnostics.effectiveLimitBytes,
  });
  const gate = getAgentMemoryGate(memoryDiagnostics.sharedBudgetBytes, memoryDiagnostics.auxiliaryBudgetBytes);
  const admissionRequired = memoryDiagnostics.admissionActive && reservationBytes > 0;
  const admissionStartedAt = Date.now();
  const startCliProcess = (reservation: AgentMemoryReservation, waited: boolean): Promise<string> => {
    let released = false;
    const releaseReservation = () => {
      if (released) return;
      released = true;
      reservation.release();
    };
    // Only worth a line once the run actually queued — the uncontended case is
    // every spawn, and an operator only needs the observed wait.
    if (waited) {
      log.info(`${backend.label} acquired agent memory budget after ${Math.round((Date.now() - admissionStartedAt) / 1000)}s (cwd=${cwd}, reserved=${Math.round(reservation.requestedBytes / 1048576)}MiB, sharedBudget=${Math.round((memoryDiagnostics.sharedBudgetBytes ?? 0) / 1048576)}MiB, currentlyReserved=${Math.round(gate.reserved / 1048576)}MiB)`);
    }
    return new Promise<string>((resolve, reject) => {
    // Always enrich PATH with well-known bin dirs so CLIs installed via
    // shell-profile-only installers (opencode, cargo, etc.) are discoverable
    // even when running under systemd with a restricted PATH.
    let baseEnv: NodeJS.ProcessEnv;
    if (isolated) {
      // An allow-list, not a strip list: a new Claws secret can never reach an
      // external caller's prompt by being missing from SENSITIVE_ENV_KEYS.
      baseEnv = { ...isolatedCompletionEnv(options?.provider ?? "claude", options?.claudeAccount), ...backend.env };
    } else {
      const mode = options?.envSanitization ?? "strict";
      const cleaned = sanitiseEnvForChild(process.env, mode);
      for (const key of capabilityEnvKeys()) delete cleaned[key];
      // In both modes: an inherited Anthropic API key would make the Claude CLI
      // (and pi) bill API credit instead of the subscription. Only the OpenCode
      // backend's own env adds it back.
      for (const key of ANTHROPIC_API_KEY_ENV_KEYS) delete cleaned[key];
      // No child inherits any Claude account's token: the Claude backend's env
      // adds back only the chosen account's, as the bare CLAUDE_CODE_OAUTH_TOKEN.
      if (mode === "strict") {
        for (const key of Object.keys(cleaned)) if (isClaudeTokenEnvKey(key) || isAmbientGitAuthEnvKey(key)) delete cleaned[key];
      }
      // Git credentials (the Forgejo push one included) come solely from the
      // repo-gated forgejoEnv.
      baseEnv = { ...cleaned, ...gitIdentityEnv(), ...options?.forgejoEnv, ...options?.plannerCapabilityEnv, ...backend.env };
    }
    baseEnv["PATH"] = enrichedPath(baseEnv["PATH"]);
    // Agent pods set no SHELL, so Claude Code prefers the image's zsh (NOMATCH/EQUALS
    // break bash one-liners). Pin bash for every headless CLI child.
    const headlessShell = resolveHeadlessShell();
    if (headlessShell) {
      baseEnv["SHELL"] = headlessShell;
      baseEnv["CLAUDE_CODE_SHELL"] = headlessShell;
    } else if (!warnedNoHeadlessShell) {
      warnedNoHeadlessShell = true;
      log.warn("[claude] no bash found; agent shells will be auto-detected by the CLI");
    }
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
    log.info(`Spawned ${backend.label} process (PID ${child.pid}, cwd=${cwd}, model=${options?.model ?? "default"}, timeout=${options?.timeoutMs ?? CLAUDE_TIMEOUT_MS}ms, liveness=${CLAUDE_LIVENESS_TIMEOUT_MS}ms, memoryCap=${memoryDiagnostics.effectiveLimitBytes > 0 ? `${Math.round(memoryDiagnostics.effectiveLimitBytes / 1048576)}MiB` : "disabled"})`);
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
      if (isolated) {
        // Byte counts above only.
      } else if (stdout.length > 0) {
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
    const memMax = memoryDiagnostics.effectiveLimitBytes;
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
          }, AGENT_MEMORY_WATCHDOG_INTERVAL_MS)
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
      if (isolated) return;
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
      releaseReservation();
      activeChildren.delete(child);
      const rid = childRunId.get(child);
      if (rid) {
        const set = activeRunChildren.get(rid);
        if (set) { set.delete(child); if (set.size === 0) activeRunChildren.delete(rid); }
      }
      if (memoryAborted && !isShuttingDown()) {
        reject(new AgentMemoryLimitError(observedRss, memMax, stdout.length, cwd, memoryDiagnostics));
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
      // Any signalled close during shutdown is shutdown-adjacent: every
      // Claws-initiated signal (watchdog, timeout, liveness, cancellation) is
      // already classified above. kubelet's sequence is SIGTERM, then SIGKILL to
      // the whole cgroup once terminationGracePeriodSeconds expires, so an agent
      // still alive at the end of a 420s drain closes with SIGKILL while the
      // flag is set — classifying that as `external-kill` files an OOMKill-themed
      // [claws-error] issue after a routine rollout.
      if (cancelledChildren.has(child) || (signal !== null && isShuttingDown())) {
        reject(new ShutdownError("Task cancelled — shutting down"));
        return;
      }
      const rejectExternalKill = (sig: NodeJS.Signals) => {
        log.warn(`${backend.command} was killed externally by signal ${sig}: ${isolated ? `stderr ${stderr.length} bytes` : stderr.slice(0, 500)}`);
        // A SIGKILL here is what a container OOMKill looks like from inside the
        // pod, so the container limit, shared budget, headroom and this run's
        // own reservation are exactly the facts an operator needs.
        reject(new AgentExternalKillError(backend.command, sig, stdout.length, cwd, memoryDiagnostics, reservation.requestedBytes));
      };
      if (signal === "SIGTERM") {
        // systemd and kubelet SIGTERM the whole cgroup at once, so the child can
        // close before setShuttingDown() has run and the guard above loses the
        // race. Let the flag catch up before classifying — the grace belongs
        // here, at classification, not at alert time: reporting alone would
        // suppress the [claws-error] issue while still recording a spurious
        // `external-kill` outcome and burning a work-queue attempt, instead of
        // leaving the row `running` for recoverWorkOnStartup() the way a
        // ShutdownError does.
        // Deliberately *not* unref'd: an unref'd timer lets the process exit
        // with this promise unsettled, so the caller's `finally` (worktree
        // removal, recordTaskFailed) would never run — the exact guarantee the
        // comment above is defending. At most 5s of extra shutdown.
        setTimeout(() => {
          if (isShuttingDown()) reject(new ShutdownError("Task cancelled — shutting down"));
          else rejectExternalKill("SIGTERM");
        }, EXTERNAL_SIGTERM_SHUTDOWN_GRACE_MS);
        return;
      }
      if (signal) {
        rejectExternalKill(signal);
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
      releaseReservation();
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
    }).catch((err) => {
      releaseReservation();
      throw err;
    });
  };
  if (!admissionRequired) {
    return startCliProcess({ requestedBytes: reservationBytes, lane: memoryDiagnostics.lane, release: () => {} }, false);
  }
  // Register the waiter before awaiting admission so cancelCurrentTask() /
  // cancelTaskByRunId() can drop a queued run instead of letting it spawn
  // minutes later.
  const acquisition = gate.acquireCancellable(reservationBytes, memoryDiagnostics.lane);
  const waited = acquisition.queued;
  let waitLogTimer: NodeJS.Timeout | undefined;
  if (waited) {
    const budget = memoryDiagnostics.sharedBudgetBytes!;
    const laneBudget = gate.laneBudget(memoryDiagnostics.lane);
    const overBudget = reservationBytes > laneBudget ? " (single run exceeds its lane budget; admitted only with the whole gate empty)" : "";
    const uncapped = memoryDiagnostics.effectiveLimitBytes === 0 ? " (watchdog disabled; reserving an uncapped slot)" : "";
    log.info(`${backend.label} waiting for agent memory budget (cwd=${cwd}, lane=${memoryDiagnostics.lane}, reserve=${Math.round(reservationBytes / 1048576)}MiB, effectiveCap=${memoryDiagnostics.effectiveLimitBytes > 0 ? `${Math.round(memoryDiagnostics.effectiveLimitBytes / 1048576)}MiB` : "disabled"}, laneBudget=${Math.round(laneBudget / 1048576)}MiB, sharedBudget=${Math.round(budget / 1048576)}MiB, containerLimit=${memoryDiagnostics.containerLimitBytes === null ? "unknown" : `${Math.round(memoryDiagnostics.containerLimitBytes / 1048576)}MiB`}, headroom=${Math.round(memoryDiagnostics.headroomBytes / 1048576)}MiB)${overBudget}${uncapped}`);
    // The wait is unbounded and the run's own timers only start after
    // admission, so without a heartbeat a multi-hour queue looks identical in
    // the log to a single line followed by silence.
    waitLogTimer = setInterval(() => {
      log.info(`${backend.label} still waiting for agent memory budget after ${Math.round((Date.now() - admissionStartedAt) / 60000)}min (cwd=${cwd}, lane=${memoryDiagnostics.lane}, reserve=${Math.round(reservationBytes / 1048576)}MiB, sharedBudget=${Math.round(budget / 1048576)}MiB, currentlyReserved=${Math.round(gate.reserved / 1048576)}MiB, queueDepth=${gate.waiting})`);
    }, AGENT_MEMORY_WAIT_LOG_INTERVAL_MS);
    waitLogTimer.unref?.();
  }
  let admissionWaitTimer: NodeJS.Timeout | undefined;
  const admissionWaitMs = options?.admissionWaitMs;
  if (waited && admissionWaitMs !== undefined && admissionWaitMs > 0) {
    admissionWaitTimer = setTimeout(() => {
      const waitedMs = Date.now() - admissionStartedAt;
      log.warn(`${backend.label} gave up waiting for agent memory budget after ${Math.round(waitedMs / 1000)}s (cwd=${cwd}, lane=${memoryDiagnostics.lane}, queueDepth=${gate.waiting})`);
      acquisition.cancel(new AdmissionTimeoutError(waitedMs, memoryDiagnostics.lane));
    }, admissionWaitMs);
    admissionWaitTimer.unref?.();
  }
  const pending: PendingAdmission = { cancel: (reason) => acquisition.cancel(reason) };
  const runId = runContext.getStore()?.runId;
  pendingAdmissions.add(pending);
  if (runId) {
    const set = pendingRunAdmissions.get(runId) ?? new Set<PendingAdmission>();
    set.add(pending);
    pendingRunAdmissions.set(runId, set);
  }
  const unregisterPending = () => {
    if (waitLogTimer) clearInterval(waitLogTimer);
    if (admissionWaitTimer) clearTimeout(admissionWaitTimer);
    pendingAdmissions.delete(pending);
    if (!runId) return;
    const set = pendingRunAdmissions.get(runId);
    if (!set) return;
    set.delete(pending);
    if (set.size === 0) pendingRunAdmissions.delete(runId);
  };
  return acquisition.promise.then(
    (reservation) => {
      unregisterPending();
      // A run that queued was admitted by somebody else's release, minutes or
      // hours after its caller last checked. shutdown() sets the flag, then
      // drains the scheduler for up to 300s before cancelCurrentTask() runs —
      // inside that window a queued waiter would otherwise spawn a brand-new
      // multi-hour CLI on a pod that is terminating.
      if (waited && isShuttingDown()) {
        reservation.release();
        throw new ShutdownError("Task cancelled — shutting down");
      }
      return startCliProcess(reservation, waited);
    },
    (err) => { unregisterPending(); throw err; },
  );
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
    log.warn(`Codex reported error(s): ${cliOutputForLog(errMsg, options)}`);
    throw new AgentCliError(errMsg, code, text ? undefined : 0, "codex");
  }

  if (code !== 0) {
    log.warn(`codex exited with code ${code}: ${cliOutputForLog(stderr, options)}`);
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
  if (options?.isolatedCompletion) return runIsolatedCodexOnce(prompt, cwd, options);
  const wrappedPrompt = withRepoContext(prompt, cwd, options);
  const env: NodeJS.ProcessEnv = {};
  if (options?.mcpConfig) {
    env["CODEX_HOME"] = writeCodexMcpHomeForRun(options.mcpConfig);
    log.debug("Injected MCP config into Codex backend via CODEX_HOME");
  }
  const args = ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--json"];
  if (options?.model) {
    args.push("-m", options.model);
  }
  if (options?.deepThinking) {
    // TOML-parsed by codex; the quotes make it an explicit string. xhigh is
    // the top effort level used for Codex deep-planning runs.
    args.push("-c", `model_reasoning_effort="xhigh"`);
  }
  return runCliProcess(wrappedPrompt, cwd, {
    command: "codex",
    args,
    label: "Codex",
    env,
    processOutput: (stdout, stderr, code) => processCodexOutput(stdout, stderr, code, options),
  }, options);
}

/** Codex features an isolated completion turns off, so the run has no shell, browser, app or image tool. */
export const ISOLATED_CODEX_DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "in_app_browser", "image_generation",
] as const;

/**
 * `codex exec` for an isolated completion: an ephemeral, read-only-sandboxed
 * session that ignores the user's config and rules, has every tool feature and
 * web search disabled, and gets no MCP `CODEX_HOME`.
 */
function runIsolatedCodexOnce(prompt: string, cwd: string, options: RunClaudeOptions): Promise<string> {
  const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only"];
  for (const feature of ISOLATED_CODEX_DISABLED_FEATURES) args.push("--disable", feature);
  args.push("-c", `web_search="disabled"`);
  if (options.model) args.push("-m", options.model);
  return runCliProcess(withIsolatedSystemPrompt(prompt, options), cwd, {
    command: "codex",
    args,
    label: "Codex",
    env: {},
    processOutput: (stdout, stderr, code) => processCodexOutput(stdout, stderr, code, options),
  }, options);
}

/** OpenCode config for an isolated completion: every permission denied, every tool off, no MCP servers. */
export const OPENCODE_ISOLATED_COMPLETION_CONFIG = JSON.stringify({ permission: "deny", tools: { "*": false }, mcp: {} });

/**
 * Run a single OpenCode CLI process via the shared runCliProcess helper.
 * OpenCode talks to the provider its `--model` prefix names: `anthropic/…`
 * runs on Anthropic directly with ANTHROPIC_API_KEY, `openrouter/…` on
 * OpenRouter with OPENROUTER_API_KEY. Both configured keys are injected into
 * the child environment (and only this one), and a model whose key is missing
 * fails before spawning.
 *
 * Non-interactive invocation uses `opencode run`.
 * The prompt is delivered via stdin (NOT as a positional arg).  When stdin
 * is not a TTY the opencode `run` handler appends stdin to the message:
 *   `if (!process.stdin.isTTY) message += "\n" + (await Bun.stdin.text())`
 * Passing the prompt as a positional arg would break with complex prompts
 * (yargs parses dashes, newlines, etc.) and would also cause double-delivery
 * since runCliProcess always writes the prompt to stdin.
 * See: https://opencode.ai/docs/cli/#run-1
 * Permissions are granted via `OPENCODE_CONFIG_CONTENT` (see
 * `OPENCODE_FULL_PERMISSIONS_CONFIG`), not a CLI flag, since the flag name
 * is not stable across opencode versions.
 */
/**
 * Full-permission OpenCode config, delivered via `OPENCODE_CONFIG_CONTENT`
 * (inline config, highest precedence — it also overrides a worked-on repo's
 * own `opencode.json`). Claws' agents are unattended, so an `ask` permission
 * — `external_directory` and `doom_loop` default to `ask`, and reads of
 * `*.env` are denied by default — has nobody to answer it. This is the
 * equivalent of the Claude CLI's `--dangerously-skip-permissions` (#2875).
 * Deliberately NOT the CLI flag: opencode 1.4.6 spells it
 * `--dangerously-skip-permissions` while current opencode spells it `--auto`,
 * and its yargs parser is strict — an unknown flag prints help and exits 1,
 * so a hard-coded flag name would break every run on the next auto-update.
 * The TUI has no such flag at all. The `permission` config key is stable.
 */
export const OPENCODE_FULL_PERMISSIONS_CONFIG = opencodeConfigContent();

/**
 * Parse the NDJSON (newline-delimited JSON) output from `opencode run --format json`.
 * Extracts text parts, detects errors, and returns the concatenated text output.
 *
 * JSON event types:
 *   {"type":"text",        "part":{"text":"..."}}           — LLM response text
 *   {"type":"error",       "error":{...}}                   — session-level error
 *   {"type":"tool_use",    "part":{"tool":"...","state":{}}} — tool invocation
 *   {"type":"step_finish", "part":{"reason":"...","tokens":{...},"cost":N}} — token/cost data
 *
 * `step_finish.part.tokens` is `{ total, input, output, reasoning, cache: { read, write } }`;
 * `total` is sometimes absent on older rows, in which case the five components are summed.
 */
function parseOpenCodeJsonOutput(stdout: string): {
  text: string;
  errors: string[];
  tokensUsed?: number;
  costUsd?: number;
  sessionID?: string;
  steps: number;
  finishReasons: string[];
  errorDetails: Array<{ statusCode?: number; generationId?: string }>;
  breakdown: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
} {
  const textParts: string[] = [];
  const errors: string[] = [];
  const finishReasons: string[] = [];
  const errorDetails: Array<{ statusCode?: number; generationId?: string }> = [];
  const breakdown = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let tokensUsed: number | undefined;
  let costUsd: number | undefined;
  let sessionID: string | undefined;
  let steps = 0;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (sessionID === undefined && typeof event.sessionID === "string") {
        sessionID = event.sessionID;
      }
      if (event.type === "text" && event.part?.text) {
        textParts.push(event.part.text);
      } else if (event.type === "error") {
        const errData = event.error?.data?.message ?? event.error?.name ?? JSON.stringify(event.error);
        errors.push(String(errData));
        const statusCode = event.error?.data?.statusCode;
        const headers = event.error?.data?.responseHeaders as Record<string, string> | undefined;
        const generationHeaderKey = headers && Object.keys(headers).find((k) => k.toLowerCase() === "x-generation-id");
        const generationId = generationHeaderKey ? headers![generationHeaderKey] : undefined;
        errorDetails.push({ statusCode: typeof statusCode === "number" ? statusCode : undefined, generationId });
      } else if (event.type === "step_finish") {
        steps++;
        if (typeof event.part.reason === "string") {
          finishReasons.push(event.part.reason);
        }
        if (event.part?.tokens) {
          const t = event.part.tokens;
          const input = t.input ?? 0;
          const output = t.output ?? 0;
          const reasoning = t.reasoning ?? 0;
          const cacheRead = t.cache?.read ?? 0;
          const cacheWrite = t.cache?.write ?? 0;
          breakdown.input += input;
          breakdown.output += output;
          breakdown.reasoning += reasoning;
          breakdown.cacheRead += cacheRead;
          breakdown.cacheWrite += cacheWrite;
          const stepTotal = typeof t.total === "number" ? t.total : input + output + reasoning + cacheRead + cacheWrite;
          tokensUsed = (tokensUsed ?? 0) + stepTotal;
          if (typeof event.part.cost === "number") {
            costUsd = (costUsd ?? 0) + event.part.cost;
          }
        }
      }
    } catch {
      // Non-JSON line (e.g. opencode startup messages) — ignore
    }
  }

  return { text: textParts.join("\n"), errors, tokensUsed, costUsd, sessionID, steps, finishReasons, errorDetails, breakdown };
}

/**
 * The missing-key error for an OpenCode `model` whose provider prefix needs a
 * key Claws does not have, or null. Without a key opencode fails with an
 * opaque UnknownError; this message matches AGENT_AUTH_FAILURE_RE instead.
 */
export function openCodeMissingKeyError(model: string | undefined): string | null {
  if (model?.startsWith("anthropic/") && !ANTHROPIC_API_KEY) {
    return "No API key found for anthropic — set the Anthropic API key";
  }
  if (model?.startsWith("openrouter/") && !OPENROUTER_API_KEY) {
    return "No API key found for openrouter — set the OpenRouter API key";
  }
  return null;
}

function runOpenCodeOnce(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  const missingKey = openCodeMissingKeyError(options?.model);
  if (missingKey) {
    return Promise.reject(new AgentCliError(missingKey, 1, 0, "opencode"));
  }
  const isolated = !!options?.isolatedCompletion;
  const wrappedPrompt = isolated ? withIsolatedSystemPrompt(prompt, options!) : withRepoContext(prompt, cwd, options);
  const args = ["run", "--format", "json"];
  if (options?.model) {
    args.push("--model", options.model);
  }
  if (options?.agent && !isolated) {
    if (!["plan", "build"].includes(options.agent)) {
      throw new Error(`Invalid agent type: ${options.agent}. Must be "plan" or "build"`);
    }
    args.push("--agent", options.agent);
  }
  // Prompt is written to stdin by runCliProcess — do NOT add it to args.
  // opencode run reads stdin when !isTTY and appends it to the message.
  const env: NodeJS.ProcessEnv = {};
  env["OPENCODE_CONFIG_CONTENT"] = isolated ? OPENCODE_ISOLATED_COMPLETION_CONFIG : opencodeConfigContent(options?.mcpConfig);
  if (options?.mcpConfig && !isolated) {
    log.debug("Injected MCP config into OpenCode backend via OPENCODE_CONFIG_CONTENT");
  }
  if (OPENROUTER_API_KEY) {
    env["OPENROUTER_API_KEY"] = OPENROUTER_API_KEY;
  }
  if (ANTHROPIC_API_KEY) {
    env["ANTHROPIC_API_KEY"] = ANTHROPIC_API_KEY;
  }
  return runCliProcess(wrappedPrompt, cwd, {
    command: "opencode",
    args,
    label: "OpenCode",
    env,
    processOutput(stdout, stderr, code) {
      if (code !== 0) {
        log.warn(`opencode exited with code ${code}: ${cliOutputForLog(stderr, options)}`);
        const noOutput = !stdout.trim();
        throw new AgentCliError(stderr || stdout || `opencode exited with code ${code}`, code, noOutput ? 0 : undefined, "opencode");
      }

      // Parse the NDJSON output to extract text and detect errors
      const { text, errors, tokensUsed, costUsd, sessionID, steps, finishReasons, errorDetails, breakdown } = parseOpenCodeJsonOutput(stdout);

      if (errors.length > 0) {
        const errMsg = errors.join("; ");
        const detailsSuffix = errorDetails
          .map((d) => {
            const parts: string[] = [];
            if (d.statusCode !== undefined) parts.push(`status=${d.statusCode}`);
            if (d.generationId !== undefined) parts.push(`generation=${d.generationId}`);
            return parts.join(" ");
          })
          .filter(Boolean)
          .join(", ");
        log.warn(`OpenCode reported error(s): ${cliOutputForLog(errMsg, options)} session=${sessionID ?? "unknown"}${detailsSuffix ? ` ${detailsSuffix}` : ""}`);
        throw new AgentCliError(errMsg, code, 0, "opencode");
      }

      if (!text.trim() && !stdout.trim()) {
        // No JSON events at all — opencode likely hit a fatal error before
        // the session started (e.g. ProviderModelNotFoundError) and printed
        // the error to stderr while exiting 0.
        const msg = stderr.trim() || "opencode exited 0 but produced no output";
        log.warn(`OpenCode exited 0 with no output: ${cliOutputForLog(msg, options)}`);
        throw new AgentCliError(msg, code, 0, "opencode");
      }

      // Report token/cost data if available
      if (tokensUsed !== undefined && costUsd !== undefined) {
        log.info(
          `OpenCode usage: session=${sessionID ?? "unknown"} steps=${steps} finish=${finishReasons.join(",")} ` +
          `tokens=${tokensUsed} (input ${breakdown.input}, output ${breakdown.output}, reasoning ${breakdown.reasoning}, ` +
          `cache read ${breakdown.cacheRead}, cache write ${breakdown.cacheWrite}), $${costUsd.toFixed(6)}`,
        );
        options?.onTokensUsed?.(tokensUsed, costUsd, "opencode");
      }

      if (!text.trim()) {
        // Got JSON events (tool_use, step_start, etc.) but no text output.
        // This can happen when the LLM only used tools without producing
        // a final text response. Raw NDJSON is never a valid answer, so
        // treat it as a transient OpenRouter failure rather than returning it.
        log.warn(`OpenCode produced JSON events but no text parts: session=${sessionID ?? "unknown"} steps=${steps} finish=${finishReasons.join(",")}`);
        throw new AgentCliError("OpenRouter API Error: empty response from provider (no text parts in opencode JSON stream)", code, undefined, "opencode");
      }

      return text;
    },
  }, options);
}

/**
 * Parse the JSONL event stream from `pi --mode json`
 * (https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md).
 *
 * Text is the text blocks of the last assistant `message_end`. Usage is
 * counted once per completed assistant message — `message_end.message.usage`,
 * else the last `message_update.usage` before it — because `message_update`
 * usage is cumulative within a message and summing every update would
 * overcount. A provider error (`assistantMessageEvent.type === "error"`, or an
 * assistant message ending with `stopReason` `error`) counts only when no
 * later assistant message completed successfully, since pi retries on its own.
 */
export function parsePiJsonOutput(stdout: string): {
  text: string;
  errors: string[];
  events: number;
  tokensUsed?: number;
  costUsd?: number;
  sessionId?: string;
  messages: number;
} {
  let events = 0;
  let text = "";
  let errors: string[] = [];
  let tokensUsed: number | undefined;
  let costUsd: number | undefined;
  let sessionId: string | undefined;
  let messages = 0;
  type PiUsage = { totalTokens?: unknown; cost?: { total?: unknown } };
  let pendingUsage: PiUsage | undefined;

  const addUsage = (usage: PiUsage | undefined) => {
    if (!usage) return;
    if (typeof usage.totalTokens === "number") tokensUsed = (tokensUsed ?? 0) + usage.totalTokens;
    if (typeof usage.cost?.total === "number") costUsd = (costUsd ?? 0) + usage.cost.total;
  };

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, any>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // stdout is JSONL-only, but tolerate a stray line rather than failing the run
    }
    if (!event || typeof event !== "object") continue;
    events++;
    if (event.type === "session" && typeof event.id === "string") {
      sessionId = event.id;
    } else if (event.type === "message_start" && event.message?.role === "assistant") {
      pendingUsage = undefined;
    } else if (event.type === "message_update") {
      if (event.usage) pendingUsage = event.usage;
      const inner = event.assistantMessageEvent;
      if (inner?.type === "error") {
        const msg = inner.error?.errorMessage ?? inner.error?.message ?? inner.reason ?? "pi provider error";
        errors.push(String(msg));
      }
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      messages++;
      addUsage(message.usage ?? pendingUsage);
      pendingUsage = undefined;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        errors.push(String(message.errorMessage ?? `pi assistant message ended with stopReason ${message.stopReason}`));
        continue;
      }
      // A later successful message supersedes any earlier provider error.
      errors = [];
      const content = Array.isArray(message.content) ? message.content : [];
      text = content
        .filter((block: { type?: unknown; text?: unknown }) => block?.type === "text" && typeof block.text === "string")
        .map((block: { text: string }) => block.text)
        .join("");
    }
  }

  return { text, errors, events, tokensUsed, costUsd, sessionId, messages };
}

/**
 * Run a single pi CLI process (`pi --mode json`) via the shared runCliProcess
 * helper. Tier models are `provider/id`: the prefix picks pi's `--provider`
 * (`anthropic` on the Claude token, `openai-codex` on the Codex login,
 * `openai` or `openrouter` on their API keys) and the rest is `--model`;
 * a model with no prefix passes `--model` only. Credentials come from
 * {@link piCredentialEnv} and the agent dir's `auth.json`, never argv.
 *
 * Every run is locked down against repo-controlled config: `--no-approve`
 * ignores a managed repo's trust-gated `.pi/` files, `--no-extensions` loads
 * no extensions, `--no-session` writes no session file (pi reads the project
 * `sessionDir` setting before its trust check), and a throwaway
 * `PI_CODING_AGENT_DIR` keeps the host's `~/.pi/agent` out. The prompt is
 * piped on stdin, which pi prepends to the (empty) first prompt.
 */
function runPiOnce(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  // `options` is deliberately omitted: the role document travels via
  // --append-system-prompt below, so only <repository-instructions> is inlined.
  const wrappedPrompt = withRepoContext(prompt, cwd);
  const args = ["--mode", "json", "--no-session", "--no-approve", "--no-extensions"];
  const { provider, id } = splitPiModel(options?.model ?? PI_BEST_MODEL);
  if (provider) {
    args.push("--provider", provider);
  }
  args.push("--model", id);
  if (options?.deepThinking) {
    args.push("--thinking", "high");
  }
  const role = options?.appendSystemPrompt?.trim();
  if (role) {
    args.push("--append-system-prompt", role);
  }
  const piDir = writePiAgentDirForRun(cwd, options?.mcpConfig);
  if (options?.mcpConfig) {
    log.debug("Injected MCP config into pi backend via PI_CODING_AGENT_DIR/mcp.json");
  }
  const env: NodeJS.ProcessEnv = {
    ...piCredentialEnv(options?.claudeAccount),
    PI_CODING_AGENT_DIR: piDir,
  };
  return runCliProcess(wrappedPrompt, cwd, {
    command: "pi",
    args,
    label: "Pi",
    env,
    processOutput(stdout, stderr, code) {
      if (code !== 0) {
        log.warn(`pi exited with code ${code}: ${stderr.slice(0, 500)}`);
        const noOutput = !stdout.trim();
        throw new AgentCliError(stderr || stdout || `pi exited with code ${code}`, code, noOutput ? 0 : undefined, "pi");
      }

      const { text, errors, events, tokensUsed, costUsd, sessionId, messages } = parsePiJsonOutput(stdout);

      if (tokensUsed !== undefined || costUsd !== undefined) {
        log.info(`Pi usage: session=${sessionId ?? "unknown"} messages=${messages} tokens=${tokensUsed ?? 0}, $${(costUsd ?? 0).toFixed(6)}`);
        options?.onTokensUsed?.(tokensUsed ?? 0, costUsd ?? 0, "pi", options.claudeAccount);
      }

      if (errors.length > 0) {
        const errMsg = errors.join("; ");
        log.warn(`Pi reported error(s): ${errMsg.slice(0, 500)} session=${sessionId ?? "unknown"}`);
        throw new AgentCliError(errMsg, code, 0, "pi");
      }

      if (events === 0) {
        const msg = stderr.trim() || "pi exited 0 but produced no output";
        log.warn(`Pi exited 0 with no output: ${msg.slice(0, 500)}`);
        throw new AgentCliError(msg, code, 0, "pi");
      }

      if (!text.trim()) {
        log.warn(`Pi produced JSON events but no text: session=${sessionId ?? "unknown"} messages=${messages}`);
        throw new AgentCliError("pi produced JSON events but no text", code, undefined, "pi");
      }

      return text;
    },
  }, options).finally(() => {
    try { fs.rmSync(piDir, { recursive: true, force: true }); } catch { /* best effort; the startup sweep catches leftovers */ }
  });
}

/**
 * Run a single Claude CLI process via the shared runCliProcess helper.
 */
function runClaudeCliOnce(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  const isolated = options?.isolatedCompletion;
  // `options` is deliberately omitted: the role document travels via
  // --append-system-prompt below, so only <repository-instructions> is inlined.
  const wrappedPrompt = isolated ? prompt : withRepoContext(prompt, cwd);
  // Resolve the workload class once and thread it through: the heap ceiling
  // below and the watchdog cap inside runCliProcess must come from the same
  // decision, and that decision also consults whether admission is active at
  // all — re-deriving it here let the two diverge.
  const memoryDiagnostics = resolveAgentMemoryDiagnostics(options);
  // An isolated completion gets no tools, no MCP servers (not even the user's),
  // no skills and no saved session — and no permission bypass, since nothing is left to approve.
  const args = isolated
    ? ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--setting-sources", ""]
    : ["-p", "--dangerously-skip-permissions", "--output-format", "json"];
  if (options?.model) {
    args.push("--model", options.model);
  }
  if (isolated) {
    if (isolated.systemPromptFile && isolated.systemPrompt?.trim()) args.push("--system-prompt-file", isolated.systemPromptFile);
  } else {
    if (options?.mcpConfig) {
      args.push("--mcp-config", options.mcpConfig);
    }
    if (options?.appendSystemPrompt) {
      args.push("--append-system-prompt", options.appendSystemPrompt);
    }
    if (options?.disallowedTools && options.disallowedTools.length > 0) {
      args.push("--disallowedTools", options.disallowedTools.join(","));
    }
  }
  const existingNodeOptions = process.env["NODE_OPTIONS"] ?? "";
  // An auxiliary run's watchdog cap is the auxiliary slice, which is smaller
  // than the ordinary V8 ceiling — leave the heap ceiling above the cap and a
  // CLI that used its heap would be killed at the slice instead of bounded by
  // V8.
  const maxOldSpaceMb = memoryDiagnostics.lane === "auxiliary" ? AUXILIARY_NODE_MAX_OLD_SPACE_MB : CLAUDE_NODE_MAX_OLD_SPACE_MB;
  const nodeOptions = /--max-old-space-size/.test(existingNodeOptions)
    ? existingNodeOptions
    : `${existingNodeOptions} --max-old-space-size=${maxOldSpaceMb}`.trim();
  // The chosen account's token overrides the inherited CLAUDE_CODE_OAUTH_TOKEN:
  // backend env is merged last in runCliProcess.
  const accountTokenValue = options?.claudeAccount ? accountToken(options.claudeAccount) : undefined;
  const accountEnv: Record<string, string> = accountTokenValue ? { CLAUDE_CODE_OAUTH_TOKEN: accountTokenValue } : {};
  return runCliProcess(wrappedPrompt, cwd, {
    command: "claude",
    args,
    label: "Claude",
    env: isolated
      ? { NODE_OPTIONS: nodeOptions, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ...accountEnv }
      : {
        NODE_OPTIONS: nodeOptions,
        ...accountEnv,
        ...(options?.deepThinking ? { MAX_THINKING_TOKENS: "31999" } : {}),
        ...options?.claudeEnv,
      },
    processOutput(stdout, _stderr, code) {
      if (code !== 0) {
        log.warn(`claude exited with code ${code}: ${cliOutputForLog(_stderr, options)}`);
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
            options?.claudeAccount,
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
            options?.onTokensUsed?.(totalTokens, parsed.total_cost_usd, "claude", options.claudeAccount);
          }
        }
      } catch (err) {
        if (err instanceof AgentCliError) throw err;
        // CLI produced non-JSON output — always treat as a CLI-level failure,
        // regardless of exit code or output length.
        throw new AgentCliError(stdout, code, undefined, "claude", options?.claudeAccount);
      }
      return result;
    },
  }, options, memoryDiagnostics);
}

/**
 * Matches agent CLI failure messages that represent transient upstream API
 * failures (5xx responses, unexpected socket closures, mid-response
 * connection failures, and OpenCode/OpenRouter hollow completions, across the
 * Anthropic and OpenCode/OpenAI backends).
 *
 * Three consumers share this single definition — keep them in mind when editing:
 * - `runWithRetry` below retries the agent call once when it matches.
 * - `reportError` in `src/error-reporter.ts` downgrades matches to a warning
 *   instead of filing a `[claws-error]` issue.
 * - `categorizeFailure` in `src/outcome.ts` classifies matches as `transient-api`.
 */
export const API_TRANSIENT_RE = /API Error: 5\d\d|API Error: The socket connection was closed|API Error:[^\n]*\bmid-response\b|openai\b.*\berror\b.*\b5\d\d\b|OpenRouter API Error: empty response from provider/i;

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
 * - `classifyUsageLimit` below splits model-specific limits off to the
 *   per-tier breaker.
 */
export const USAGE_LIMIT_RE =
  /you['’](?:re out of [^.\n]{0,40}?usage|ve (?:hit|reached) your [^.\n]{0,40}?limit)|\busage limit reached\b/i;

/**
 * The model-specific shape of a usage limit: one tier's allowance is spent but
 * the account can still serve other models — `You've reached your Fable limit.
 * Switch to another model to continue.`
 */
const MODEL_USAGE_LIMIT_RE =
  /\bswitch to (?:another|a different) model\b|\b(?:hit|reached) your (?:fable|opus|sonnet|haiku) limit\b/i;

/**
 * Classifies a usage-limit message: `"model"` when only the current model's
 * allowance is exhausted, `"account"` for every other `USAGE_LIMIT_RE` match
 * (weekly, 5-hour, extra usage), and `null` when it is not a usage limit.
 */
export function classifyUsageLimit(msg: string): "model" | "account" | null {
  if (!USAGE_LIMIT_RE.test(msg)) return null;
  return MODEL_USAGE_LIMIT_RE.test(msg) ? "model" : "account";
}

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
  if (provider === "pi") return "Pi";
  return "Claude";
}

/**
  * Run a single attempt with automatic retry on transient failures.
  * Retries once on:
  * - 0-byte timeouts (likely a transient hang)
  * - AgentCliError with 0 turns (transient init failure)
  * - Transient API errors (5xx status codes, unexpected socket closures,
  *   mid-response connection failures, and OpenCode/OpenRouter hollow completions)
 */
async function runWithRetry(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  const provider = options?.provider ?? "claude";
  const backend = backendLabel(provider);
  try {
    return await runClaudeOnce(prompt, cwd, options);
  } catch (err) {
    if (!isShuttingDown()) {
      // An isolated completion's caller is waiting on a bounded request, so a
      // second full timeout would double it.
      if (err instanceof AgentTimeoutError && err.outputBytes === 0 && !options?.isolatedCompletion) {
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
 * Run an agent CLI with automatic retry on transient failures and weighted
 * provider reselection for provider-unavailable failures.
 */
export async function runClaude(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  // An external caller's completion: never captured to disk, and no file channels.
  if (options?.isolatedCompletion) return await runClaudeInner(prompt, cwd, options);
  // `Write` denied means the agent cannot write either file at all; keep the plain path.
  const writeDenied = options?.disallowedTools?.includes("Write") ?? false;
  if (options?.useOutputFile && writeDenied) {
    log.warn(`[runClaude] useOutputFile ignored: disallowedTools denies Write`);
  }
  if (options?.verdictFile && writeDenied) {
    log.warn(`[runClaude] verdictFile ignored: disallowedTools denies Write`);
  }
  const outputFilePath = options?.useOutputFile && !writeDenied
    ? agentOutputFilePath(options.captureLabel) : undefined;
  const verdictFilePath = options?.verdictFile && !writeDenied
    ? agentVerdictFilePath(options.captureLabel) : undefined;
  let effPrompt = prompt;
  if (outputFilePath) effPrompt = `${effPrompt}\n\n${buildOutputFileInstruction(outputFilePath)}`;
  if (verdictFilePath) effPrompt = `${effPrompt}\n\n${buildVerdictFileInstruction(verdictFilePath, options!.verdictFile!.docs)}`;
  const effOptions = (outputFilePath || verdictFilePath)
    ? { ...options!, ...(outputFilePath ? { outputFilePath } : {}), ...(verdictFilePath ? { verdictFilePath } : {}) }
    : options;
  // One run path, so the verdict file is read exactly once however the call is
  // instrumented — the prompt-capture branch included.
  const run = async (): Promise<string> => {
    const captureDir = resolvePromptCaptureDir();
    if (!captureDir) return await runClaudeInner(effPrompt, cwd, effOptions);
    try {
      const output = await runClaudeInner(effPrompt, cwd, effOptions);
      capturePromptExchange(captureDir, { prompt: effPrompt, cwd, options: effOptions, output, ok: true });
      return output;
    } catch (err) {
      capturePromptExchange(captureDir, { prompt: effPrompt, cwd, options: effOptions, ok: false, errorMessage: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };
  try {
    const output = await run();
    if (verdictFilePath) options!.verdictFile!.onVerdict(readAgentVerdictFile(verdictFilePath));
    return output;
  } finally {
    if (outputFilePath) { try { fs.rmSync(outputFilePath, { force: true }); } catch { /* ignore */ } }
    if (verdictFilePath) { try { fs.rmSync(verdictFilePath, { force: true }); } catch { /* ignore */ } }
  }
}

async function runClaudeInner(prompt: string, cwd: string, options?: RunClaudeOptions): Promise<string> {
  const explicitProvider = options?.provider;
  const toolRestricted = (options?.disallowedTools?.length ?? 0) > 0;
  const pinned = !!options?.strictProvider || !!options?.noProviderFallback || toolRestricted;
  const configuredPool = options?.eligibleProviders ?? getEnabledProviderWeights();
  const initialProvider = explicitProvider ?? selectWeightedProvider(configuredPool, options?.providerRandom);
  const firstProvider = initialProvider;

  // A non-empty `disallowedTools` pins the call structurally: the flag is
  // Claude-CLI-only, so codex (`--dangerously-bypass-approvals-and-sandbox`) or
  // opencode (`permission: "allow"`) would re-run the identical prompt with full
  // shell/file/network access. Enforced here rather than left to per-call-site
  // discipline (#2882).
  if (toolRestricted && !options?.strictProvider && !options?.noProviderFallback) {
    log.warn(`[provider-selection] Pinning to "${firstProvider}" with no reselection: disallowedTools is Claude-CLI-only and reselection would re-run this prompt unsandboxed`);
  }
  if (toolRestricted && firstProvider !== "claude") {
    log.warn(`[provider-selection] disallowedTools has no effect on the ${backendLabel(firstProvider)} backend — this run is not tool-restricted`);
  }

  const unfilteredPool = pinned
    ? [{ provider: firstProvider, weight: 1 }]
    : configuredPool;
  // `pi` ignores isolatedCompletion (tools, raw logging), so it never runs one.
  if (options?.isolatedCompletion && explicitProvider === "pi") throw new NoEligibleProviderError();
  const basePool = options?.isolatedCompletion ? unfilteredPool.filter(({ provider }) => provider !== "pi") : unfilteredPool;
  if (basePool.length === 0) throw new NoEligibleProviderError();

  // An isolated completion carries none of Claws' credentials or capability guidance.
  const isolated = !!options?.isolatedCompletion;
  // Resolved once, before the provider loop, so reselection never appends the
  // guidance twice.
  let extraEnv: Record<string, string> | undefined;
  let appendSystemPrompt = isolated ? undefined : options?.appendSystemPrompt;
  const bashDenied = options?.disallowedTools?.includes("Bash") ?? false;
  if (!bashDenied && !isolated) {
    const access = resolveHeadlessCrossRepoAccess();
    if (access) {
      extraEnv = { ...(extraEnv ?? {}), ...access.env };
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${access.prompt}` : access.prompt;
    }
  }
  if (options?.forgejoAccessRepo && !isolated) {
    const access = resolveHeadlessForgejoAccess();
    if (access) {
      extraEnv = { ...(extraEnv ?? {}), ...access.env };
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${access.prompt}` : access.prompt;
    }
  }
  let plannerCapabilityEnv: Record<string, string> | undefined;
  if (!bashDenied && !isolated && options?.plannerCapabilities?.length) {
    const access = resolveHeadlessPlannerCapabilityAccess([...options.plannerCapabilities]);
    if (access) {
      plannerCapabilityEnv = access.env;
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${access.prompt}` : access.prompt;
    }
  }
  // Every agent MCP config carries claws-state, so claws_note_friction exists
  // wherever there is an mcpConfig; tell the agent about it whatever its capabilities.
  if (options?.mcpConfig && !isolated) {
    appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${FRICTION_NOTE_GUIDANCE}` : FRICTION_NOTE_GUIDANCE;
  }

  // Holds recorded by other processes (the controller, other agent pods) since
  // this process last looked; at most once per PROVIDER_HOLDS_REFRESH_MS.
  if (providerHoldsStale()) await refreshProviderHolds();

  let lastErr: unknown;
  const triedProviders = new Set<Provider>();
  // Claude accounts this run already tried and lost to a usage limit or an
  // auth failure; the next Claude attempt picks another one.
  const triedAccounts = new Set<string>();
  // The account a fable run that dropped to opus must stay on.
  let sameAccount: string | undefined;
  let nextProvider: Provider | undefined = firstProvider;
  let attemptedAny = false;
  // Set once a Claude fable run drops to opus on a model-specific usage limit
  // (or an already-open fable breaker); every later attempt uses this tier.
  let tierOverride: ModelTier | undefined;

  /** Pick the next provider from the untried, unheld pool; false when pinned or none is left. */
  const reselect = (): boolean => {
    const remainingPool = withoutProviders(basePool, triedProviders).filter(({ provider }) => !isProviderRateLimited(provider));
    if (remainingPool.length === 0 || pinned) return false;
    nextProvider = selectWeightedProvider(remainingPool, options?.providerRandom);
    return true;
  };

  while (nextProvider) {
    const provider: Provider = nextProvider;
    nextProvider = undefined;
    triedProviders.add(provider);

    // Fast-path: skip rate-limited providers without calling Ollama. Claude
    // counts as rate-limited only when every account is held or auth-expired.
    if (isProviderRateLimited(provider)) {
      const until = getProviderRateLimitedUntil(provider);
      const remainingMs = until ? until - Date.now() : 0;
      log.info(`[provider-circuit-breaker] Skipping rate-limited provider "${provider}" (${Math.ceil(remainingMs / 1000)}s remaining)`);
      if (reselect()) continue;
      break;
    }

    let fableAttempt = provider === "claude" && !tierOverride && (options?.tier === "fable" || !!options?.deepThinking);
    // Switch on whether an account can actually serve each tier: with one
    // account tier-held on fable and another held account-wide, fable has no
    // account but opus does.
    if (
      fableAttempt &&
      pickableClaudeAccounts({ tier: "fable", exclude: triedAccounts }).length === 0 &&
      pickableClaudeAccounts({ tier: "opus", exclude: triedAccounts }).length > 0
    ) {
      log.info(`[model-tier-circuit-breaker] Tier "fable" on provider "claude" has no free account — running on "opus"`);
      tierOverride = "opus";
      fableAttempt = false;
      options?.onTierFallback?.("fable", "opus");
    }
    const effectiveTier: ModelTier = tierOverride ?? options?.tier ?? "sonnet";

    // Fast-path: every account with a token is blocked for this Claude tier —
    // tier-held, held account-wide or auth-expired, in any mix (by a previous
    // attempt, possibly for a different run) — so skip provider "claude" the
    // same way the provider-wide breaker fast path above skips a rate-limited
    // provider, rather than spending a doomed attempt on it. Also catches a
    // pinned fable run whose opus fallback is itself held down: the check
    // above declines to switch tiers, so `effectiveTier` is still "fable" here.
    if (provider === "claude" && claudeProviderHeldUntil(effectiveTier) !== null) {
      log.info(`[model-tier-circuit-breaker] Tier "${effectiveTier}" on provider "claude" is held down — skipping provider "claude"`);
      if (reselect()) continue;
      break;
    }

    // A Claude attempt runs on one of the configured accounts: one with a
    // token that is not held, not held for this tier, not auth-expired and not
    // already tried by this run. With none, skip the provider the way a
    // rate-limited one is skipped (a pinned run then throws the last error).
    let claudeAccount: ClaudeAccount | null = null;
    if (provider === "claude") {
      const kept = sameAccount ? findClaudeAccount(sameAccount) : undefined;
      sameAccount = undefined;
      claudeAccount = kept && pickableClaudeAccounts({ tier: effectiveTier }).some((a) => a.id === kept.id)
        ? kept
        : pickClaudeAccount({ tier: effectiveTier, exclude: triedAccounts });
      if (!claudeAccount) {
        if (triedAccounts.size > 0) log.warn(`[claude-accounts] Every Claude account is held, auth-expired or already tried — leaving provider "claude"`);
        else log.warn(`[claude-accounts] No Claude account has a usable token — skipping provider "claude"`);
        if (reselect()) continue;
        break;
      }
    }

    attemptedAny = true;
    // If the caller explicitly pinned both a provider and a model, honour the
    // pin on the first attempt — the explicit model is the one they meant for
    // that provider. Only re-derive via getModel() on fallback attempts, where
    // the pinned model wouldn't be valid for a different provider.
    const isFirstTryWithExplicitModel = provider === explicitProvider && options?.model;
    const configuredProviderModel = tierOverride
      ? getModel(tierOverride, provider)
      : options?.deepThinking
      ? getDeepModel(provider)
      : isFirstTryWithExplicitModel
        ? options!.model
        : options?.tier
          ? getModel(options.tier, provider)
          : options?.model;
    const providerModel = provider === "codex"
      ? await resolveCodexModelForAttempt(configuredProviderModel ?? "")
      : configuredProviderModel;
    // pi on an Anthropic model (or one with no provider prefix, where pi may
    // pick Anthropic) uses a Claude account's token for that one attempt.
    if (provider === "pi") {
      const piProvider = splitPiModel(providerModel || PI_BEST_MODEL).provider;
      if (piProvider === null || piProvider === "anthropic") claudeAccount = pickClaudeAccount();
    }
    const providerOptions: RunClaudeOptions = { tier: effectiveTier, ...options, ...(tierOverride ? { tier: tierOverride } : {}), provider, model: providerModel, forgejoEnv: extraEnv, plannerCapabilityEnv, appendSystemPrompt, claudeAccount: claudeAccount?.id };

    // Notify caller which provider (and Claude account) is being used
    options?.onProviderUsed?.(provider, claudeAccount?.id);
    options?.onAttemptModelUsed?.(provider, providerModel || undefined);
    noteProviderUsed(provider, claudeAccount?.id);

    if (provider !== firstProvider) {
      log.info(`[provider-retry] Attempting provider "${provider}" after "${firstProvider}" was unavailable`);
    } else if (provider === "claude" && triedAccounts.size > 0) {
      log.info(`[provider-retry] Attempting Claude account "${claudeAccount!.id}" after ${[...triedAccounts].map((a) => `"${a}"`).join(", ")} was unavailable`);
    }

    try {
      const out = await runWithRetry(prompt, cwd, providerOptions);
      // A successful run proves *that provider's* (and Claude account's)
      // credentials are alive. The latch is per-provider and per-account, so
      // clear only the one that just succeeded (#2538).
      noteAgentAuthSuccess(provider, provider === "claude" ? claudeAccount?.id : undefined);
      return out;
    } catch (err) {
      lastErr = err;

      if (isShuttingDown()) throw err;

      // A cancelled run (cancelCurrentTask / cancelTaskByRunId) also surfaces as
      // ShutdownError while the service is up — never retry it on another provider.
      if (err instanceof ShutdownError) throw err;

      // Nothing spawned: the caller's own admission bound expired. Not a
      // provider failure, so never reselect or classify it as a rate limit.
      if (err instanceof AdmissionTimeoutError) throw err;

      if (err instanceof AgentMemoryLimitError) {
        throw err;
      }

      const account = provider === "claude" ? claudeAccount?.id : undefined;
      if (account && err instanceof AgentCliError && !err.account) err.account = account;

      // Check if this is a rate-limit error
      const errMsg = err instanceof Error ? err.message : String(err);
      if (err instanceof AgentCliError && UNSUPPORTED_MODEL_RE.test(errMsg)) {
        throw err;
      }

      // An expired Claude account: latch it and carry on with another
      // account, or — with none left on an unpinned run — another provider.
      // When the run fails here, rethrow *without* latching, so `reportError`
      // latches the account and raises the alert for the episode.
      if (account && err instanceof AgentCliError && isAgentAuthFailure(err)) {
        triedAccounts.add(account);
        const accountLeft = pickableClaudeAccounts({ tier: effectiveTier, exclude: triedAccounts }).length > 0;
        if (!accountLeft && (pinned || !reselect())) throw err;
        const onward = accountLeft ? "another account" : `provider "${nextProvider}"`;
        const alreadyExpired = isAgentAuthExpired("claude", account);
        if (noteAgentAuthFailure(errMsg, undefined, "claude", account)) {
          // Slack once per episode, not on the hourly re-alert.
          if (!alreadyExpired) {
            void slack.notify(`:warning: [claude-accounts] Claude account "${account}"'s credentials have expired — re-authenticate it: ${reauthInstruction("claude", account)}`);
          }
          log.error(`[${agentAuthFingerprint("claude", account)}] Claude account "${account}"'s credentials have expired — re-authenticate it: ${reauthInstruction("claude", account)}. Continuing on ${onward}. First failure: ${errMsg}`);
        } else {
          log.warn(`[claude-accounts] Claude account "${account}" auth expired (already alerted) — continuing on ${onward}`);
        }
        if (accountLeft) nextProvider = "claude";
        continue;
      }

      // A usage-limit message is an unambiguous rate limit; don't spend an
      // Ollama round-trip on it (and don't let the regex fallback, which has no
      // "hit your … limit" pattern, mis-classify it as a hard failure — #2590).
      const usageLimitKind = classifyUsageLimit(errMsg);
      const usageLimit = usageLimitKind !== null;
      // A *weekly* allowance does not come back in 5 minutes: without a printed
      // reset time, hold for an hour so reselection can route around it.
      const weekly = usageLimit && /\bweekly\b/i.test(errMsg);
      const fixedCooldownMs = usageLimitKind === "model" ? MODEL_TIER_RATE_LIMIT_COOLDOWN_MS : weekly ? 60 * 60 * 1000 : PROVIDER_RATE_LIMIT_COOLDOWN_MS;
      const holdUntil = usageLimit ? usageLimitHoldUntil(errMsg, Date.now(), fixedCooldownMs, localTimeZone()) : 0;

      // A model-specific limit exhausts one Claude tier on one account, not
      // the account: hold that tier down on that account only, and retry a
      // fable run once on opus on the same account — even when pinned, since
      // it stays on the same provider. Any other tier moves to another
      // account with the tier free before leaving the provider.
      if (usageLimitKind === "model" && provider === "claude") {
        markModelTierRateLimited("claude", fableAttempt ? "fable" : effectiveTier, holdUntil - Date.now(), account);
        if (fableAttempt) {
          log.warn(`[model-tier-circuit-breaker] Fable usage limit on provider "claude" account "${account}" — retrying on "opus"`);
          tierOverride = "opus";
          options?.onTierFallback?.("fable", "opus");
          sameAccount = account;
          nextProvider = provider;
          continue;
        }
        if (account) triedAccounts.add(account);
        nextProvider = "claude";
        continue;
      }

      // An account-wide limit holds that account alone; the run continues on
      // another account (pinned or not) before leaving the provider. The
      // Claude provider is held only once every account is.
      if (usageLimitKind === "account" && account) {
        log.warn(`[provider-circuit-breaker] Usage limit on Claude account "${account}" — holding it and trying another account`);
        markAccountRateLimited(account, holdUntil);
        triedAccounts.add(account);
        nextProvider = "claude";
        continue;
      }

      const rateLimitDetected = usageLimit || (await isRateLimitError(errMsg));

      const zeroTurnStartupFailure = err instanceof AgentCliError && err.numTurns === 0;

      // Anthropic rate limits are per organisation — per account here — so a
      // Claude rate limit on a known account holds that account alone and the
      // run tries another account first. Without an account, hold the provider.
      if (rateLimitDetected && account) {
        log.warn(`[provider-circuit-breaker] Rate limit on Claude account "${account}" — holding it and trying another account`);
        markAccountRateLimited(account, Date.now() + PROVIDER_RATE_LIMIT_COOLDOWN_MS, "rate-limit");
        triedAccounts.add(account);
        nextProvider = "claude";
        continue;
      }

      if (rateLimitDetected) {
        log.warn(`[provider-circuit-breaker] Rate limit detected for provider "${provider}" — marking as rate-limited`);
        markProviderRateLimited(provider, usageLimit ? holdUntil - Date.now() : undefined);
      } else if (!zeroTurnStartupFailure) {
        // Non-provider-unavailable error — rethrow immediately
        throw err;
      }

      if (pinned) throw err;
      if (!reselect()) throw err;
    }
  }

  // All providers exhausted or rate-limited before an attempt.
  if (lastErr) throw lastErr;
  if (!attemptedAny) throw new AllProvidersRateLimitedError();
  throw new AllProvidersRateLimitedError();
}
