import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("./config.js", () => ({
  SELF_REPO: { owner: "test", name: "test-repo", fullName: "test/test-repo", defaultBranch: "main" },
}));

vi.mock("./log.js", () => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

let mockShuttingDown = false;
vi.mock("./shutdown.js", async () => {
  const actual = await vi.importActual<typeof import("./shutdown.js")>("./shutdown.js");
  return {
    ...actual,
    isShuttingDown: () => mockShuttingDown,
  };
});

vi.mock("./github.js", () => {
  class RateLimitError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "RateLimitError";
    }
  }
  return {
    searchIssues: vi.fn().mockResolvedValue([]),
    createIssue: vi.fn().mockResolvedValue(undefined),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
    isRateLimited: vi.fn().mockReturnValue(false),
    RateLimitError,
  };
});

import { reportError } from "./error-reporter.js";
import { ClaudeTimeoutError } from "./claude.js";
import { ShutdownError } from "./shutdown.js";
import * as gh from "./github.js";
import * as log from "./log.js";

describe("reportError", () => {
  afterEach(() => {
    mockShuttingDown = false;
    vi.clearAllMocks();
  });

  it("logs locally but skips GitHub issue creation during shutdown", async () => {
    mockShuttingDown = true;

    await reportError("test:fingerprint", "some-context", new Error("test error"));

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("test:fingerprint"));
    expect(gh.searchIssues).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("creates a GitHub issue when not shutting down", async () => {
    await reportError("test:fp2", "ctx", new Error("boom"));

    expect(log.error).toHaveBeenCalled();
    expect(gh.searchIssues).toHaveBeenCalled();
    expect(gh.createIssue).toHaveBeenCalled();
  });

  it("downgrades RateLimitError to warn and skips GitHub issue creation", async () => {
    const { RateLimitError } = await import("./github.js");
    const err = new RateLimitError("Rate limited — skipping API call");

    await reportError("test:ratelimit", "list-prs", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("test:ratelimit"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.searchIssues).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("suppresses ShutdownError — no Slack notification, no GitHub issue", async () => {
    const err = new ShutdownError("Task cancelled — shutting down");

    await reportError("test:shutdown", "process-issue", err);

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("shutdown — not reported"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.searchIssues).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("serializes plain objects with JSON.stringify instead of [object Object]", async () => {
    const plainObj = { reasonNode: "conflict", statusCode: 515 };

    await reportError("test:fp3", "stream errored out", plainObj);

    const body = vi.mocked(gh.createIssue).mock.calls[0][2];
    expect(body).toContain('"reasonNode": "conflict"');
    expect(body).toContain('"statusCode": 515');
    expect(body).not.toContain("[object Object]");
  });

  it("includes diagnostics in new issue body for ClaudeTimeoutError", async () => {
    const err = new ClaudeTimeoutError(1200000, 4500, "last output here", "stderr here", "/tmp/worktrees/test");

    await reportError("test:timeout-new", "some-context", err);

    const body = vi.mocked(gh.createIssue).mock.calls[0][2];
    expect(body).toContain("**Diagnostics:**");
    expect(body).toContain("`/tmp/worktrees/test`");
    expect(body).toContain("Total stdout: 4500 bytes");
    expect(body).toContain("was actively producing output");
    expect(body).toContain("last output here");
    expect(body).toContain("stderr here");
  });

  it("includes diagnostics in recurrence comment for ClaudeTimeoutError", async () => {
    vi.mocked(gh.searchIssues).mockResolvedValueOnce([
      { number: 99, title: "[claws-error] test:timeout-recur" } as any,
    ]);

    const err = new ClaudeTimeoutError(1200000, 0, "", "err line", "/tmp/wt");

    await reportError("test:timeout-recur", "ctx", err);

    const comment = vi.mocked(gh.commentOnIssue).mock.calls[0][2];
    expect(comment).toContain("**Diagnostics:**");
    expect(comment).toContain("Total stdout: 0 bytes");
    expect(comment).toContain("produced no output (likely stuck or waiting for input)");
    expect(comment).toContain("err line");
  });
});
