import { describe, it, expect, vi } from "vitest";
import { categorizeFailure, buildFailureOutcome, buildSuccessOutcome } from "./outcome.js";

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

  it("classifies ShutdownError as shutdown", () => {
    const err = namedError("ShutdownError", "shutting down");
    expect(categorizeFailure(err)).toBe("shutdown");
  });

  it("classifies non-fast-forward as push-rejection", () => {
    const err = new Error("git push failed: non-fast-forward");
    expect(categorizeFailure(err)).toBe("push-rejection");
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

  it("classifies OpenRouterClientError as payload-too-large", () => {
    const err = Object.assign(new Error("OpenRouter HTTP 400: maximum context length exceeded"), {
      name: "OpenRouterClientError",
    });
    expect(categorizeFailure(err)).toBe("payload-too-large");
  });

  it("classifies ref-not-found as ref-not-found", () => {
    const err = namedError("BranchDeletedError", "Remote ref origin/dependabot/npm/lodash does not exist (branch may have been deleted after merge)");
    expect(categorizeFailure(err)).toBe("ref-not-found");
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
});

vi.mock("./claude.js", () => ({
  getCommitCount: vi.fn(),
  getDiffStats: vi.fn(),
}));

describe("buildSuccessOutcome", () => {
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
    });
  });
});
