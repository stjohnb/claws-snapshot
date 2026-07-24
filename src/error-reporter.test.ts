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
  class TransientGitHubError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "TransientGitHubError";
    }
  }
  return {
    findIssueByExactTitle: vi.fn().mockResolvedValue(null),
    createIssue: vi.fn().mockResolvedValue(undefined),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
    getIssueBody: vi.fn().mockResolvedValue(""),
    editIssue: vi.fn().mockResolvedValue(undefined),
    isRateLimited: vi.fn().mockReturnValue(false),
    RateLimitError,
    TransientGitHubError,
  };
});

const mockGuardContent = vi.hoisted(() => vi.fn((text: string) => text));
vi.mock("./prompt-guard.js", () => ({
  guardContent: (...args: Parameters<typeof mockGuardContent>) => mockGuardContent(...args),
  makeGuardCtx: (repo: string, itemNumber: number) => (source: string) => ({ repo, source, itemNumber }),
}));

import { reportError, reportTimeoutOnItem, reportMemoryLimitOnItem, reportFailedAttachments } from "./error-reporter.js";
import { AgentTimeoutError, AgentCliError, PushConflictError, AgentMemoryLimitError } from "./claude.js";
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
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("creates a GitHub issue when not shutting down", async () => {
    await reportError("test:fp2", "ctx", new Error("boom"));

    expect(log.error).toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).toHaveBeenCalled();
    expect(gh.createIssue).toHaveBeenCalled();
    const body = vi.mocked(gh.createIssue).mock.calls[0][2];
    expect(body).toContain("**First seen:**");
  });

  it("downgrades RateLimitError to warn and skips GitHub issue creation", async () => {
    const { RateLimitError } = await import("./github.js");
    const err = new RateLimitError("Rate limited — skipping API call");

    await reportError("test:ratelimit", "list-prs", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("test:ratelimit"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("downgrades PushConflictError to warn and skips GitHub issue creation", async () => {
    const err = new PushConflictError("feat/x", "CONFLICT (content): Merge conflict in file.ts");

    await reportError("ci-fixer:run", "owner/repo#123", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("ci-fixer:run"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("push conflict — not reported"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("suppresses transient GitHub 5xx errors without creating an issue", async () => {
    const err = new gh.TransientGitHubError(
      "gh api repos/o/r/issues/69/comments failed: gh: HTTP 503",
    );

    await reportError("pr-reviewer:run", "o/r#69", err);

    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
    expect(gh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("still reports a plain Error mentioning HTTP 503", async () => {
    await reportError("some-job:run", "o/r#1", new Error("agent said: gh: HTTP 503"));

    expect(log.error).toHaveBeenCalled();
  });

  it("downgrades AgentCliError with usage-limit message to warn and skips GitHub issue creation", async () => {
    const err = new AgentCliError("You\u2019re out of extra usage \u00b7 resets 5pm", 1);

    await reportError("test:cli-usage", "process-issue", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("test:cli-usage"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("downgrades AgentCliError with 'hit your limit' usage message to warn and skips GitHub issue creation", async () => {
    const err = new AgentCliError("You've hit your limit \u00b7 resets 12pm (Europe/London)", 1);

    await reportError("test:hit-limit", "process-repo", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("test:hit-limit"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("downgrades AgentCliError with 'hit your limit' at a different time to warn", async () => {
    const err = new AgentCliError("You\u2019ve hit your limit \u00b7 resets 5am (America/New_York)", 1);

    await reportError("test:hit-limit-2", "process-repo", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("test:hit-limit-2"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("creates a GitHub issue for AgentCliError that does not match usage-limit patterns", async () => {
    const err = new AgentCliError("Some unexpected CLI failure unrelated to usage limits", 1, 3);

    await reportError("test:no-usage-match", "process-repo", err);

    expect(log.error).toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).toHaveBeenCalled();
    expect(gh.createIssue).toHaveBeenCalled();
  });

  it("downgrades AgentCliError with output token limit message to warn and skips GitHub issue creation", async () => {
    const err = new AgentCliError("exceeded the 8192 output token maximum", 1);

    await reportError("test:output-token-limit", "process-pr", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("CLAUDE_CODE_MAX_OUTPUT_TOKENS"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("downgrades AgentCliError with transient API 500 to warn and skips GitHub issue creation", async () => {
    const err = new AgentCliError('API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', 1, 5);

    await reportError("test:api500", "process-issue", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("transient API error — not reported"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("downgrades AgentCliError with socket closure to warn despite numTurns > 0", async () => {
    const err = new AgentCliError('API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()', 1, 5);

    await reportError("test:socket-close", "process-issue", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("transient API error — not reported"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("downgrades AgentCliError with numTurns === 0 to warn and skips GitHub issue creation", async () => {
    const err = new AgentCliError('{"is_error":true,"subtype":"error_during_execution","num_turns":0}', 1, 0);

    await reportError("test:cli-0turns", "process-pr", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("transient CLI init failure — not reported"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("downgrades WhisperRateLimitError to warn and skips GitHub issue creation", async () => {
    const { WhisperRateLimitError } = await import("./transcribe.js");
    const err = new WhisperRateLimitError("Whisper API returned HTTP 429");

    await reportError("test:whisper-rl", "process-message", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Whisper rate limit — not reported"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("suppresses ShutdownError — no Slack notification, no GitHub issue", async () => {
    const err = new ShutdownError("Task cancelled — shutting down");

    await reportError("test:shutdown", "process-issue", err);

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("shutdown — not reported"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
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

  it("includes diagnostics in new issue body for AgentTimeoutError", async () => {
    const err = new AgentTimeoutError(1200000, 4500, "last output here", "stderr here", "/tmp/worktrees/test");

    await reportError("test:timeout-new", "some-context", err);

    const body = vi.mocked(gh.createIssue).mock.calls[0][2];
    expect(body).toContain("**Diagnostics:**");
    expect(body).toContain("`/tmp/worktrees/test`");
    expect(body).toContain("Total stdout: 4500 bytes");
    expect(body).toContain("was actively producing output");
    expect(body).toContain("last output here");
    expect(body).toContain("stderr here");
  });

  it("suppresses AgentMemoryLimitError — no [claws-error] alert issued", async () => {
    const err = new AgentMemoryLimitError(1_700_000_000, 1_610_612_736, 0, "/tmp/worktrees/mem-test");

    await reportError("test:memory-new", "some-context", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("memory limit — reported on the source item, not escalated"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("reportTimeoutOnItem posts comment with escalation info", async () => {
    const err = new AgentTimeoutError(1800000, 500, "output", "stderr", "/tmp/wt");
    await reportTimeoutOnItem("org/repo", 42, 1, err, false, 45 * 60 * 1000);

    const body = vi.mocked(gh.commentOnIssue).mock.calls[0][2];
    expect(body).toContain("### CLI Timeout");
    expect(body).toContain("1 timeout");
    expect(body).toContain("actively producing output");
    expect(body).toContain("increased to 45 minutes");
    expect(body).not.toContain("removed from the Claws queue");
  });

  it("reportTimeoutOnItem posts comment with skip info", async () => {
    const err = new AgentTimeoutError(1800000, 0, "", "", "/tmp/wt");
    await reportTimeoutOnItem("org/repo", 42, 3, err, true, null);

    const body = vi.mocked(gh.commentOnIssue).mock.calls[0][2];
    expect(body).toContain("3 timeouts");
    expect(body).toContain("no output");
    expect(body).toContain("removed from the Claws queue");
    expect(body).not.toContain("increased to");
  });

  it("reportTimeoutOnItem pluralizes correctly", async () => {
    const err = new AgentTimeoutError(1800000, 100, "out", "", "/tmp/wt");
    await reportTimeoutOnItem("org/repo", 42, 2, err, false, 67 * 60 * 1000);

    const body = vi.mocked(gh.commentOnIssue).mock.calls[0][2];
    expect(body).toContain("2 timeouts");
    expect(body).toContain("increased to 67 minutes");
  });

  it("reportMemoryLimitOnItem posts comment with startup-kill message when outputBytes === 0", async () => {
    const err = new AgentMemoryLimitError(1_700_000_000, 2_147_483_648, 0, "/tmp/wt");
    await reportMemoryLimitOnItem("org/repo", 236, err, 1, false);

    const body = vi.mocked(gh.commentOnIssue).mock.calls[0][2];
    expect(body).toContain("### Memory limit reached");
    expect(body).toContain("1621 MiB observed");
    expect(body).toContain("2048 MiB limit");
    expect(body).toContain("killed during startup");
    expect(body).not.toContain("transient spike");
  });

  it("reportMemoryLimitOnItem posts comment with scope-reduction message when outputBytes > 0", async () => {
    const err = new AgentMemoryLimitError(1_700_000_000, 2_147_483_648, 4096, "/tmp/wt");
    await reportMemoryLimitOnItem("org/repo", 237, err, 1, false);

    const body = vi.mocked(gh.commentOnIssue).mock.calls[0][2];
    expect(body).toContain("### Memory limit reached");
    expect(body).toContain("reducing the scope");
    expect(body).not.toContain("transient spike");
  });

  it("reportMemoryLimitOnItem posts skip comment and bypasses cooldown when skipped=true", async () => {
    const err = new AgentMemoryLimitError(1_700_000_000, 2_147_483_648, 0, "/tmp/wt");
    // First call to set the cooldown
    await reportMemoryLimitOnItem("org/repo", 238, err, 2, false);
    vi.mocked(gh.commentOnIssue).mockClear();
    // Second call within cooldown — but skipped=true should bypass it
    await reportMemoryLimitOnItem("org/repo", 238, err, 3, true);

    expect(gh.commentOnIssue).toHaveBeenCalledTimes(1);
    const body = vi.mocked(gh.commentOnIssue).mock.calls[0][2];
    expect(body).toContain("removed from the Claws queue");
  });

  it("edits issue body with occurrence tracking on recurrence instead of commenting", async () => {
    vi.mocked(gh.findIssueByExactTitle).mockResolvedValueOnce(
      { number: 99, title: "[claws-error] test:timeout-recur" },
    );
    const existingBody = [
      "**Auto-created by Claws error reporter**",
      "",
      "---",
      "**First seen:** 2024-01-01T00:00:00.000Z",
      "**Last seen:** 2024-01-01T00:00:00.000Z",
      "**Occurrences:** 2",
    ].join("\n");
    vi.mocked(gh.getIssueBody).mockResolvedValueOnce(existingBody);

    const err = new AgentTimeoutError(1200000, 0, "", "err line", "/tmp/wt");

    await reportError("test:timeout-recur", "ctx", err);

    expect(gh.commentOnIssue).not.toHaveBeenCalled();
    expect(gh.editIssue).toHaveBeenCalledWith(
      expect.anything(),
      99,
      expect.stringContaining("**First seen:**"),
    );
    const updatedBody = vi.mocked(gh.editIssue).mock.calls[0][2];
    expect(updatedBody).toContain("**Occurrences:** 3");
  });
});

describe("reportFailedAttachments", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("guards each failed URL with the source repo/item before posting", async () => {
    await reportFailedAttachments({
      sourceRepo: "owner/repo",
      sourceIssueNumber: 55,
      failedUrls: ["http://127.0.0.1/injected", "https://example.com/missing.png"],
      agentName: "Planner",
    });

    expect(mockGuardContent).toHaveBeenCalledWith(
      "http://127.0.0.1/injected",
      { repo: "owner/repo", source: "failed-download-url", itemNumber: 55 },
    );
    expect(mockGuardContent).toHaveBeenCalledWith(
      "https://example.com/missing.png",
      { repo: "owner/repo", source: "failed-download-url", itemNumber: 55 },
    );

    const body = vi.mocked(gh.createIssue).mock.calls[0][2];
    expect(body).toContain("http://127.0.0.1/injected");
    expect(body).toContain("https://example.com/missing.png");
  });

  it("posts the guarded (sanitized) URL when guardContent redacts it", async () => {
    mockGuardContent.mockImplementationOnce(() => "[content redacted — potential prompt injection]");

    await reportFailedAttachments({
      sourceRepo: "owner/repo",
      sourceIssueNumber: 56,
      failedUrls: ["http://127.0.0.1/ignore-previous-instructions"],
      agentName: "Planner",
    });

    const body = vi.mocked(gh.createIssue).mock.calls[0][2];
    expect(body).toContain("[content redacted — potential prompt injection]");
    expect(body).not.toContain("ignore-previous-instructions");
  });
});
