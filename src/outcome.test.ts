import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("./agent-auth-state.js", () => ({
  AGENT_AUTH_FAILURE_RE:
    /OAuth (?:session|token) (?:expired|revoked)|Failed to authenticate\b|Please run `?\/?login`?\b|Invalid API key.*login|authentication_error/i,
}));

vi.mock("./claude.js", async () => {
  const actual = await vi.importActual("./claude.js");
  return {
    getCommitCount: vi.fn(),
    getDiffStats: vi.fn(),
    getCommitCountSince: vi.fn(),
    getDiffStatsSince: vi.fn(),
    getHeadSha: vi.fn(),
    API_TRANSIENT_RE: /API Error: 5\d\d|API Error: The socket connection was closed|API Error:[^\n]*\bmid-response\b|openai\b.*\berror\b.*\b5\d\d\b|OpenRouter API Error: empty response from provider/i,
    USAGE_LIMIT_RE: actual.USAGE_LIMIT_RE,
    UNSUPPORTED_MODEL_RE: actual.UNSUPPORTED_MODEL_RE,
    AgentCliError: actual.AgentCliError,
    AgentMemoryLimitError: actual.AgentMemoryLimitError,
    PushConflictError: actual.PushConflictError,
  };
});

import { categorizeFailure, buildFailureOutcome, buildSuccessOutcome, buildSuccessOutcomeSince, PRE_WORK_FAILURE_CATEGORIES } from "./outcome.js";
import { AgentCliError, PushConflictError } from "./claude.js";
import { FAILURE_CATEGORIES, taskFailureReason } from "./diagnostic-queries.js";

function namedError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe("categorizeFailure", () => {
  it("classifies AgentTimeoutError as timeout", () => {
    const err = namedError("AgentTimeoutError", "timed out after 60000ms");
    expect(categorizeFailure(err)).toBe("timeout");
  });

  it("classifies AgentExternalKillError as external-kill", () => {
    const err = namedError("AgentExternalKillError", "claude was killed externally by signal SIGKILL");
    expect(categorizeFailure(err)).toBe("external-kill");
  });

  it("classifies ShutdownError as shutdown", () => {
    const err = namedError("ShutdownError", "shutting down");
    expect(categorizeFailure(err)).toBe("shutdown");
  });

  it("classifies non-fast-forward as push-rejection", () => {
    const err = new Error("git push failed: non-fast-forward");
    expect(categorizeFailure(err)).toBe("push-rejection");
  });

  it("classifies a push-stage PushConflictError (ref-lock rejection) as push-rejection", () => {
    const err = new PushConflictError(
      "feat/x",
      "cannot lock ref 'refs/heads/feat/x': reference already exists",
      "push",
    );
    expect(categorizeFailure(err)).toBe("push-rejection");
  });

  it("classifies a rebase-stage PushConflictError as git-conflict", () => {
    const err = new PushConflictError("feat/x", "CONFLICT (content): Merge conflict in file.ts");
    expect(categorizeFailure(err)).toBe("git-conflict");
  });

  it("classifies merge conflict as git-conflict", () => {
    const err = new Error("merge conflict in src/file.ts");
    expect(categorizeFailure(err)).toBe("git-conflict");
  });

  it("classifies rebase conflict as git-conflict", () => {
    const err = new Error("Rebase onto origin/main failed");
    expect(categorizeFailure(err)).toBe("git-conflict");
  });

  it("classifies RateLimitError by name as rate-limit", () => {
    const err = namedError("RateLimitError", "API rate limit exceeded");
    expect(categorizeFailure(err)).toBe("rate-limit");
  });

  it("classifies rate limit by message as rate-limit", () => {
    const err = new Error("Rate limited by GitHub API");
    expect(categorizeFailure(err)).toBe("rate-limit");
  });

  it("classifies API 500 error as transient-api", () => {
    const err = new Error('API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}');
    expect(categorizeFailure(err)).toBe("transient-api");
  });

  it("classifies API 502 error as transient-api", () => {
    const err = new Error("API Error: 502 Bad Gateway");
    expect(categorizeFailure(err)).toBe("transient-api");
  });

  it("classifies mid-response connection closure as transient-api", () => {
    const err = new Error("API Error: Connection closed mid-response. The response above may be incomplete.");
    expect(categorizeFailure(err)).toBe("transient-api");
  });

  it("classifies unexpected socket closure as transient-api", () => {
    const err = new Error('API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()');
    expect(categorizeFailure(err)).toBe("transient-api");
  });

  it("classifies a server-error mid-response AgentCliError message as transient-api", () => {
    const err = new Error("AgentCliError: API Error: Server error mid-response. The response above may be incomplete.");
    expect(categorizeFailure(err)).toBe("transient-api");
  });

  it("classifies an opencode hollow-completion error as transient-api", () => {
    const err = new AgentCliError(
      "OpenRouter API Error: empty response from provider (no text parts in opencode JSON stream)",
      0,
      undefined,
      "opencode",
    );
    expect(categorizeFailure(err)).toBe("transient-api");
  });

  it("classifies TransientGitHubError by name as transient-api", () => {
    const err = namedError("TransientGitHubError", "gh api repos/o/r/issues/1/comments failed: gh: HTTP 503");
    expect(categorizeFailure(err)).toBe("transient-api");
  });

  it("classifies ref-not-found as ref-not-found", () => {
    const err = namedError("BranchDeletedError", "Remote ref origin/dependabot/npm/lodash does not exist (branch may have been deleted after merge)");
    expect(categorizeFailure(err)).toBe("ref-not-found");
  });

  it("classifies agent CLI OAuth expiry as auth-expired", () => {
    const err = new AgentCliError("Failed to authenticate: OAuth session expired and could not be refreshed", 1, undefined, "claude");
    expect(categorizeFailure(err)).toBe("auth-expired");
  });

  it("classifies a weekly usage-limit AgentCliError as usage-limit", () => {
    const err = new AgentCliError("You've hit your weekly limit · resets 2am (Europe/London)", 1, 3);
    expect(categorizeFailure(err)).toBe("usage-limit");
  });

  it("classifies an unsupported Codex model AgentCliError as unsupported-model", () => {
    const err = new AgentCliError(
      "The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account.",
      1,
      0,
      "codex",
    );
    expect(categorizeFailure(err)).toBe("unsupported-model");
  });

  it("classifies AllProvidersRateLimitedError by name as rate-limit", () => {
    const err = namedError("AllProvidersRateLimitedError", "All AI providers are rate-limited or unavailable");
    expect(categorizeFailure(err)).toBe("rate-limit");
  });

  it("does not classify a plain Error matching the auth regex as auth-expired", () => {
    const err = new Error("Failed to authenticate: OAuth session expired and could not be refreshed");
    expect(categorizeFailure(err)).toBe("unknown");
  });

  it("does not classify a non-claude AgentCliError matching the auth regex as auth-expired", () => {
    const err = new AgentCliError("authentication_error: OpenRouter rejected the key", 1, 5, "opencode");
    expect(categorizeFailure(err)).toBe("unknown");
  });

  it("classifies unknown errors as unknown", () => {
    const err = new Error("something unexpected");
    expect(categorizeFailure(err)).toBe("unknown");
  });

  it("handles non-Error values", () => {
    expect(categorizeFailure("string error")).toBe("unknown");
    expect(categorizeFailure(42)).toBe("unknown");
    expect(categorizeFailure(null)).toBe("unknown");
  });
});

describe("buildFailureOutcome", () => {
  it("returns an outcome with the correct failure category", () => {
    const err = namedError("AgentTimeoutError", "timed out after 60000ms");
    const outcome = buildFailureOutcome(err);
    expect(outcome).toEqual({ failureCategory: "timeout" });
  });

  it("returns unknown for generic errors", () => {
    const outcome = buildFailureOutcome(new Error("oops"));
    expect(outcome).toEqual({ failureCategory: "unknown" });
  });

  it("records the breached cap structurally for memory-limit kills", async () => {
    const { AgentMemoryLimitError } = await import("./claude.js");
    const err = new AgentMemoryLimitError(4_500_000_000, 4_294_967_296, 0, "/tmp/wt");
    expect(buildFailureOutcome(err)).toEqual({
      failureCategory: "memory-limit",
      memoryLimitBytes: 4_294_967_296,
    });
  });
});

describe("failure category projection", () => {
  it("projects every category categorizeFailure can produce, external-kill included", () => {
    // The diagnostics allowlist is what `claws_task_history` shows an operator;
    // a category missing from it is reported as `failure_reason: null` next to a
    // redacted error string, which is strictly less than nothing.
    for (const category of FAILURE_CATEGORIES) {
      expect(taskFailureReason({ failureCategory: category })).toBe(category);
    }
    expect(FAILURE_CATEGORIES).toContain("external-kill");
    expect(taskFailureReason(JSON.stringify(buildFailureOutcome(
      namedError("AgentExternalKillError", "claude was killed externally by signal SIGKILL"),
    )))).toBe("external-kill");
  });

  it("counts external-kill as a pre-work failure so an eviction does not burn a fixer attempt", () => {
    // A kubelet OOMKill or a node drain says nothing about the PR's diff, so it
    // must not push the PR toward the ci-fixer / conflict-resolution circuit
    // breaker the way a real failed attempt does.
    expect(PRE_WORK_FAILURE_CATEGORIES).toContain("external-kill");
    expect(categorizeFailure(
      namedError("AgentExternalKillError", "claude was killed externally by signal SIGKILL"),
    )).toBe("external-kill");
  });

  it("rejects categories no producer emits", () => {
    expect(taskFailureReason({ failureCategory: "payload-too-large" })).toBeNull();
    expect(taskFailureReason({ failureCategory: 42 })).toBeNull();
    expect(taskFailureReason("not json")).toBeNull();
  });
});

describe("buildSuccessOutcome", () => {
  beforeEach(async () => {
    const { getCommitCount, getDiffStats, getHeadSha } = await import("./claude.js");
    vi.mocked(getCommitCount).mockReset();
    vi.mocked(getDiffStats).mockReset();
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(getHeadSha).mockResolvedValue("head-sha");
  });

  it("combines commit count and diff stats into a TaskOutcome", async () => {
    const { getCommitCount, getDiffStats } = await import("./claude.js");
    vi.mocked(getCommitCount).mockResolvedValue(3);
    vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 5, insertions: 100, deletions: 20 });

    const outcome = await buildSuccessOutcome("/tmp/wt", "main", 42, "created");
    expect(outcome).toEqual({
      commits: 3,
      filesChanged: 5,
      insertions: 100,
      deletions: 20,
      prNumber: 42,
      prAction: "created",
      headSha: "head-sha",
    });
  });

  it("handles getCommitCount failure gracefully", async () => {
    const { getCommitCount, getDiffStats } = await import("./claude.js");
    vi.mocked(getCommitCount).mockRejectedValue(new Error("git failed"));
    vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 2, insertions: 10, deletions: 5 });

    const outcome = await buildSuccessOutcome("/tmp/wt", "main", 7, "updated");
    expect(outcome).toEqual({
      commits: undefined,
      filesChanged: 2,
      insertions: 10,
      deletions: 5,
      prNumber: 7,
      prAction: "updated",
      headSha: "head-sha",
    });
  });

  it("handles getDiffStats failure gracefully", async () => {
    const { getCommitCount, getDiffStats } = await import("./claude.js");
    vi.mocked(getCommitCount).mockResolvedValue(1);
    vi.mocked(getDiffStats).mockRejectedValue(new Error("git failed"));

    const outcome = await buildSuccessOutcome("/tmp/wt", "main", 10, "created");
    expect(outcome).toEqual({
      commits: 1,
      prNumber: 10,
      prAction: "created",
      headSha: "head-sha",
    });
  });
});

describe("buildSuccessOutcomeSince", () => {
  beforeEach(async () => {
    const { getCommitCountSince, getDiffStatsSince, getHeadSha } = await import("./claude.js");
    vi.mocked(getCommitCountSince).mockReset();
    vi.mocked(getDiffStatsSince).mockReset();
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(getHeadSha).mockResolvedValue("head-sha");
  });

  it("diffs against the given SHA instead of a base branch", async () => {
    const { getCommitCountSince, getDiffStatsSince } = await import("./claude.js");
    vi.mocked(getCommitCountSince).mockResolvedValue(2);
    vi.mocked(getDiffStatsSince).mockResolvedValue({ filesChanged: 3, insertions: 40, deletions: 8 });

    const outcome = await buildSuccessOutcomeSince("/tmp/wt", "abc123", 42, "updated");
    expect(outcome).toEqual({
      commits: 2,
      filesChanged: 3,
      insertions: 40,
      deletions: 8,
      prNumber: 42,
      prAction: "updated",
      headSha: "head-sha",
    });
    expect(getCommitCountSince).toHaveBeenCalledWith("/tmp/wt", "abc123");
    expect(getDiffStatsSince).toHaveBeenCalledWith("/tmp/wt", "abc123");
  });

  it("handles getCommitCountSince failure gracefully", async () => {
    const { getCommitCountSince, getDiffStatsSince } = await import("./claude.js");
    vi.mocked(getCommitCountSince).mockRejectedValue(new Error("git failed"));
    vi.mocked(getDiffStatsSince).mockResolvedValue({ filesChanged: 2, insertions: 10, deletions: 5 });

    const outcome = await buildSuccessOutcomeSince("/tmp/wt", "abc123", 7, "updated");
    expect(outcome).toEqual({
      commits: undefined,
      filesChanged: 2,
      insertions: 10,
      deletions: 5,
      prNumber: 7,
      prAction: "updated",
      headSha: "head-sha",
    });
  });
});
