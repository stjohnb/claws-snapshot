import type { TaskOutcome } from "./db.js";
import { getCommitCount, getDiffStats } from "./claude.js";

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
    if (err.name === "OpenRouterClientError") return "payload-too-large";
  }
  const msg = String(err);
  if (msg.includes("non-fast-forward")) return "push-rejection";
  if (msg.includes("merge conflict") || msg.includes("Rebase onto origin/")) return "git-conflict";
  if (msg.includes("Rate limited") || msg.includes("rate limit")) return "rate-limit";
  if (msg.includes("API Error: 5")) return "transient-api";
  return "unknown";
}

export function buildFailureOutcome(err: unknown): TaskOutcome {
  return { failureCategory: categorizeFailure(err) };
}
