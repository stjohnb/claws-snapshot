import type { TaskOutcome } from "./db.js";
import { getCommitCount, getDiffStats, API_TRANSIENT_RE, AgentCliError } from "./claude.js";
import { AGENT_AUTH_FAILURE_RE } from "./agent-auth-state.js";

export async function buildSuccessOutcome(
  wtPath: string,
  baseBranch: string,
  prNumber: number,
  prAction: NonNullable<TaskOutcome["prAction"]>,
): Promise<TaskOutcome> {
  const [commits, diffStats] = await Promise.all([
    getCommitCount(wtPath, baseBranch).catch(() => undefined),
    getDiffStats(wtPath, baseBranch).catch(() => undefined),
  ]);
  return { commits, ...diffStats, prNumber, prAction };
}

export function categorizeFailure(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AgentTimeoutError") return "timeout";
    if (err.name === "AgentMemoryLimitError") return "memory-limit";
    if (err.name === "ShutdownError") return "shutdown";
    if (err.name === "RateLimitError") return "rate-limit";
    if (err.name === "TransientGitHubError") return "transient-api";
    // Defensive fallback: createWorktreeFromBranchIfExists swallows BranchDeletedError
    // and returns undefined, so this is only reachable by direct createWorktreeFromBranch callers.
    if (err.name === "BranchDeletedError") return "ref-not-found";
  }
  const msg = String(err);
  if (msg.includes("non-fast-forward")) return "push-rejection";
  if (msg.includes("merge conflict") || msg.includes("Rebase onto origin/")) return "git-conflict";
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
  return { failureCategory: categorizeFailure(err) };
}
