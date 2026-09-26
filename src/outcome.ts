import type { TaskOutcome } from "./db.js";
import { getCommitCount, getDiffStats, getCommitCountSince, getDiffStatsSince, getHeadSha, API_TRANSIENT_RE, AgentCliError, AgentMemoryLimitError, USAGE_LIMIT_RE, UNSUPPORTED_MODEL_RE, PushConflictError } from "./claude.js";
import { AGENT_AUTH_FAILURE_RE } from "./agent-auth-state.js";
import type { FailureCategory } from "./diagnostic-queries.js";

export async function buildSuccessOutcome(
  wtPath: string,
  baseBranch: string,
  prNumber: number,
  prAction: NonNullable<TaskOutcome["prAction"]>,
): Promise<TaskOutcome> {
  const [commits, diffStats, headSha] = await Promise.all([
    getCommitCount(wtPath, baseBranch).catch(() => undefined),
    getDiffStats(wtPath, baseBranch).catch(() => undefined),
    getHeadSha(wtPath).catch(() => undefined),
  ]);
  return { commits, ...diffStats, prNumber, prAction, headSha };
}

/**
 * Like buildSuccessOutcome, but diffs against a specific SHA instead of
 * origin/<baseBranch> — for target-PR mode, where the worktree is already far
 * ahead of the base branch from the existing PR's commits.
 */
export async function buildSuccessOutcomeSince(
  wtPath: string,
  sha: string,
  prNumber: number,
  prAction: NonNullable<TaskOutcome["prAction"]>,
): Promise<TaskOutcome> {
  const [commits, diffStats, headSha] = await Promise.all([
    getCommitCountSince(wtPath, sha).catch(() => undefined),
    getDiffStatsSince(wtPath, sha).catch(() => undefined),
    getHeadSha(wtPath).catch(() => undefined),
  ]);
  return { commits, ...diffStats, prNumber, prAction, headSha };
}

/** The returned union is the one `diagnostic-queries.ts` projects through to the
 *  `claws_task_history` MCP tool, so a new category must be added to
 *  `FAILURE_CATEGORIES` there or this stops compiling. */
export function categorizeFailure(err: unknown): FailureCategory {
  if (err instanceof Error) {
    if (err.name === "AgentTimeoutError") return "timeout";
    if (err.name === "AgentMemoryLimitError") return "memory-limit";
    if (err.name === "AgentExternalKillError") return "external-kill";
    if (err.name === "ShutdownError") return "shutdown";
    if (err.name === "RateLimitError") return "rate-limit";
    if (err.name === "AllProvidersRateLimitedError") return "rate-limit";
    if (err.name === "TransientGitHubError") return "transient-api";
    // Defensive fallback: createWorktreeFromBranchIfExists swallows BranchDeletedError
    // and returns undefined, so this is only reachable by direct createWorktreeFromBranch callers.
    if (err.name === "BranchDeletedError") return "ref-not-found";
    // Push-stage conflicts are push rejections; rebase/merge-stage ones are
    // git conflicts. Classify by the typed stage, not the rendered message.
    if (err instanceof PushConflictError) {
      return err.stage === "push" ? "push-rejection" : "git-conflict";
    }
  }
  const msg = String(err);
  if (msg.includes("non-fast-forward")) return "push-rejection";
  if (msg.includes("merge conflict") || msg.includes("Rebase onto origin/")) return "git-conflict";
  if (err instanceof AgentCliError && USAGE_LIMIT_RE.test(msg)) return "usage-limit";
  if (err instanceof AgentCliError && UNSUPPORTED_MODEL_RE.test(msg)) return "unsupported-model";
  if (msg.includes("Rate limited") || msg.includes("rate limit")) return "rate-limit";
  if (API_TRANSIENT_RE.test(msg)) return "transient-api";
  // Scoped to `provider === "claude"`: AGENT_AUTH_FAILURE_RE is deliberately
  // broad and can match codex/opencode failures that aren't credential issues.
  if (err instanceof AgentCliError && err.provider === "claude" && AGENT_AUTH_FAILURE_RE.test(msg)) {
    return "auth-expired";
  }
  return "unknown";
}

export function buildFailureOutcome(err: unknown): TaskOutcome {
  const failureCategory = categorizeFailure(err);
  // Record the cap structurally as well as in the rendered message: the
  // same-cap strike count in countRecentMemoryLimits() would otherwise have to
  // scrape it back out of `tasks.error`, and fail closed (never auto-skipping)
  // the moment AgentMemoryLimitError's wording changes.
  if (err instanceof AgentMemoryLimitError) {
    return { failureCategory, memoryLimitBytes: err.limitBytes };
  }
  return { failureCategory };
}

/**
 * Failure categories where the task died before the agent could change the branch:
 * every provider was rate-limited or usage-limited, a GitHub API call was transiently
 * unavailable, the agent CLI's credentials had expired, Claws was shutting down, or
 * the CLI tree was killed from outside Claws (a kubelet OOMKill, an eviction, a node
 * drain — `external-kill`, which is about the pod, never about the diff).
 * None of these is evidence about the PR's diff, so they must not consume the CI-fix
 * or conflict-resolution budgets (#2977).
 */
export const PRE_WORK_FAILURE_CATEGORIES = [
  "rate-limit",
  "usage-limit",
  "transient-api",
  "auth-expired",
  "shutdown",
  "external-kill",
] as const;

/** The same list as a SQL literal list for use inside `IN (...)`. */
export const PRE_WORK_FAILURE_CATEGORIES_SQL = PRE_WORK_FAILURE_CATEGORIES
  .map((c) => `'${c}'`).join(", ");
