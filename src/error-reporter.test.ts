import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("./config.js", () => ({
  SELF_REPO: { owner: "test", name: "test-repo", fullName: "test/test-repo", defaultBranch: "main" },
  DASHBOARD_URL: "https://claws.example.com",
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

let mockGitHubDegraded = false;
vi.mock("./github-status.js", () => ({
  isGitHubDegraded: () => mockGitHubDegraded,
}));

vi.mock("./slack.js", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

import {
  reportError,
  reportTimeoutOnItem,
  reportMemoryLimitOnItem,
  reportFailedAttachments,
  __resetCooldownsForTests,
  __cooldownSizeForTests,
} from "./error-reporter.js";
import { AgentTimeoutError, AgentCliError, PushConflictError, AgentMemoryLimitError, AllProvidersRateLimitedError } from "./claude.js";
import { ShutdownError } from "./shutdown.js";
import * as gh from "./github.js";
import * as log from "./log.js";
import { __resetAgentAuthStateForTests } from "./agent-auth-state.js";

describe("reportError", () => {
  afterEach(() => {
    mockShuttingDown = false;
    mockGitHubDegraded = false;
    __resetAgentAuthStateForTests();
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

  it("downgrades a gh CLI error to warn when GitHub is degraded", async () => {
    mockGitHubDegraded = true;
    const err = new Error(
      "gh api repos/o/r/issues/1732/comments -H Accept: application/vnd.github.full+json failed: gh: Resource not accessible by integration (HTTP 403)",
    );

    await reportError("pr-reviewer:run", "o/r#1732", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("GitHub incident in progress — not reported"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("still reports the same gh CLI error when GitHub is not degraded", async () => {
    mockGitHubDegraded = false;
    const err = new Error(
      "gh api repos/o/r/issues/1732/comments -H Accept: application/vnd.github.full+json failed: gh: Resource not accessible by integration (HTTP 403)",
    );

    await reportError("pr-reviewer:run", "o/r#1732", err);

    expect(log.error).toHaveBeenCalled();
    expect(gh.createIssue).toHaveBeenCalled();
  });

  it("downgrades a forgejo API error to warn when GitHub is degraded", async () => {
    mockGitHubDegraded = true;
    const err = new Error("forgejo GET /repos/o/r/issues/1 failed: HTTP 502: bad gateway");

    await reportError("pr-reviewer:run", "o/r#1", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("GitHub incident in progress — not reported"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("still reports a non-CLI error while GitHub is degraded", async () => {
    mockGitHubDegraded = true;

    await reportError("some-job:non-cli", "o/r#1", new Error("boom"));

    expect(log.error).toHaveBeenCalled();
    expect(gh.createIssue).toHaveBeenCalled();
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

  it("downgrades AgentCliError with a weekly-limit message to warn", async () => {
    const err = new AgentCliError("You've hit your weekly limit · resets 2am (Europe/London)", 1, 4);

    await reportError("test:weekly-limit", "process-repo", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("test:weekly-limit"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("downgrades AgentCliError with a 5-hour-limit message to warn", async () => {
    const err = new AgentCliError("You’ve hit your 5-hour limit · resets 3pm", 1, 4);

    await reportError("test:5-hour-limit", "process-repo", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("test:5-hour-limit"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("downgrades AllProvidersRateLimitedError to warn", async () => {
    const err = new AllProvidersRateLimitedError();

    await reportError("test:all-providers-rate-limited", "process-repo", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("test:all-providers-rate-limited"));
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

  it("downgrades AgentCliError with a mid-response connection error to warn", async () => {
    const err = new AgentCliError("API Error: Connection closed mid-response. The response above may be incomplete.", 1, 5);

    await reportError("test:mid-response", "process-issue", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("transient API error — not reported"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("downgrades AgentCliError with a server-error mid-response message to warn", async () => {
    const err = new AgentCliError("API Error: Server error mid-response. The response above may be incomplete.", 1, 5);

    await reportError("test:mid-response", "process-issue", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("transient API error — not reported"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("downgrades AgentCliError with an OpenRouter 5xx message to warn", async () => {
    const err = new AgentCliError("OpenRouter API Error: 503 upstream unavailable", 1, 5);

    await reportError("test:openrouter-5xx", "process-issue", err);

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

  it("reports an unsupported Codex model as a permanent operator issue instead of downgrading it", async () => {
    const err = new AgentCliError(
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.1-codex-max\' model is not supported when using Codex with a ChatGPT account."}}',
      1,
      0,
      "codex",
    );

    await reportError("issue-refiner:plan", "St-John-Software/claws#2684", err);

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("agent-model-unsupported-codex"));
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("transient CLI init failure"));
    expect(gh.createIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("agent-model-unsupported-codex"),
      expect.anything(),
      expect.anything(),
    );
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

  it("downgrades a dropped IMAP connection to warn and skips GitHub issue creation", async () => {
    const err = Object.assign(new Error("Connection not available"), { code: "NoConnection" });

    await reportError("email-monitor:poll", "Email monitor IMAP connection failed", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("IMAP connection dropped — not reported"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("downgrades a ClosedAfterConnectTLS IMAP drop to warn and skips GitHub issue creation", async () => {
    const err = Object.assign(new Error("Unexpected close"), { code: "ClosedAfterConnectTLS" });

    await reportError("email-monitor:poll-tls", "Email monitor IMAP connection failed", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("IMAP connection dropped — not reported"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
  });

  it("still reports an Error whose code is not an IMAP drop code", async () => {
    const err = Object.assign(new Error("ENOTFOUND imap.gmail.com"), { code: "ENOTFOUND" });

    await reportError("email-monitor:poll-dns", "Email monitor IMAP connection failed", err);

    expect(log.error).toHaveBeenCalled();
    expect(gh.createIssue).toHaveBeenCalled();
  });

  it("alerts once for the first agent-auth failure and files a stable-fingerprint issue", async () => {
    const err = new AgentCliError("Failed to authenticate: OAuth session expired and could not be refreshed", 1, undefined, "claude");

    await reportError("issue-worker:run", "owner/repo#1", err);

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(gh.createIssue).toHaveBeenCalledTimes(1);
    const title = vi.mocked(gh.createIssue).mock.calls[0][1];
    expect(title).toBe("[claws-error] agent-auth-expired");
  });

  it("downgrades a subsequent agent-auth failure from a different fingerprint to warn with no further issue calls", async () => {
    const err = new AgentCliError("Failed to authenticate: OAuth session expired and could not be refreshed", 1, undefined, "claude");

    await reportError("issue-worker:run", "owner/repo#1", err);
    vi.mocked(gh.createIssue).mockClear();
    vi.mocked(gh.editIssue).mockClear();
    vi.mocked(log.error).mockClear();

    await reportError("issue-refiner:plan:run", "owner/repo#2", err);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("claude CLI auth expired — already alerted"));
    expect(log.error).not.toHaveBeenCalled();
    expect(gh.createIssue).not.toHaveBeenCalled();
    expect(gh.editIssue).not.toHaveBeenCalled();
  });

  it("alerts again after noteAgentAuthSuccess clears the latch", async () => {
    const { noteAgentAuthSuccess } = await import("./agent-auth-state.js");
    const err = new AgentCliError("Failed to authenticate: OAuth session expired and could not be refreshed", 1, undefined, "claude");

    await reportError("issue-worker:run", "owner/repo#1", err);
    noteAgentAuthSuccess();
    vi.mocked(gh.createIssue).mockClear();
    vi.mocked(log.error).mockClear();

    await reportError("issue-worker:run", "owner/repo#3", err);

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(gh.createIssue).toHaveBeenCalledTimes(1);
  });

  it("latches a non-claude provider under its own fingerprint, leaving claude's latch clear", async () => {
    const { isAgentAuthExpired } = await import("./agent-auth-state.js");
    // `authentication_error` is Anthropic's own API error-type string, but this
    // one came out of the opencode CLI — a claude re-auth cannot fix it, and
    // setting the claude latch would suppress a genuine claude outage alert (#2538).
    // numTurns 0 is what opencode actually reports on an error event (it never
    // got a turn) — the auth classification must outrank the 0-turn
    // "transient CLI init failure" downgrade.
    const err = new AgentCliError("authentication_error: OpenRouter rejected the key", 1, 0, "opencode");

    await reportError("issue-worker:run", "owner/repo#1", err);

    expect(isAgentAuthExpired("opencode")).toBe(true);
    expect(isAgentAuthExpired("claude")).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(gh.createIssue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gh.createIssue).mock.calls[0][1]).toBe("[claws-error] agent-auth-expired-opencode");
    // The issue body must point at the CLI the operator actually has to fix.
    expect(vi.mocked(gh.createIssue).mock.calls[0][2]).toContain("opencode auth login");
  });

  it("latches a codex auth failure separately from claude's, so neither suppresses the other", async () => {
    const { isAgentAuthExpired } = await import("./agent-auth-state.js");
    // A codex auth failure arrives as a `turn.failed` with no agent_message, so
    // runCodexOnce derives numTurns 0 — see the integration test below.
    const codexErr = new AgentCliError(
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
      1,
      0,
      "codex",
    );
    const claudeErr = new AgentCliError("Failed to authenticate: OAuth session expired", 1, 5, "claude");

    await reportError("issue-worker:run", "owner/repo#1", codexErr);
    expect(isAgentAuthExpired("codex")).toBe(true);
    expect(isAgentAuthExpired("claude")).toBe(false);

    // The claude failure is a fresh episode: it must still alert, under the
    // original bare fingerprint so pre-split issues keep matching.
    await reportError("issue-refiner:plan", "owner/repo#2", claudeErr);
    expect(isAgentAuthExpired("claude")).toBe(true);
    expect(gh.createIssue).toHaveBeenCalledTimes(2);
    expect(vi.mocked(gh.createIssue).mock.calls[0][1]).toBe("[claws-error] agent-auth-expired-codex");
    expect(vi.mocked(gh.createIssue).mock.calls[1][1]).toBe("[claws-error] agent-auth-expired");
  });

  it("escalates the real codex credential-expiry error (0 turns) instead of downgrading it to a transient init failure", async () => {
    const { processCodexOutput } = await import("./claude.js");
    const { isAgentAuthExpired } = await import("./agent-auth-state.js");

    // Verbatim shape of what `codex exec --json` emits when its refresh token
    // has been reused: a turn.failed with no preceding agent_message. Driving
    // the real processOutput keeps the derived numTurns honest rather than
    // hand-picking one that happens to dodge the 0-turn short-circuit.
    const stdout =
      JSON.stringify({
        type: "turn.failed",
        error: {
          message:
            "Your access token could not be refreshed because your refresh token was already used (refresh_token_reused). Please log out and sign in again.",
        },
      }) + "\n";

    let err: unknown;
    try {
      processCodexOutput(stdout, "", 1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentCliError);
    expect((err as AgentCliError).numTurns).toBe(0);

    await reportError("issue-worker:run", "owner/repo#1", err);

    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("transient CLI init failure"));
    expect(isAgentAuthExpired("codex")).toBe(true);
    expect(gh.createIssue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gh.createIssue).mock.calls[0][1]).toBe("[claws-error] agent-auth-expired-codex");
    expect(vi.mocked(gh.createIssue).mock.calls[0][2]).toContain("https://claws.example.com/reauth");
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
      { number: 99, title: "[claws-error] test:timeout-recur", labels: [] },
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

  it("sweeps cooldown entries older than the 30-minute window", async () => {
    __resetCooldownsForTests();
    const base = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);
    try {
      await reportError("test:sweep-a", "ctx", new Error("boom"));
      expect(__cooldownSizeForTests()).toBe(1);

      nowSpy.mockReturnValue(base + 31 * 60 * 1000);
      await reportError("test:sweep-b", "ctx", new Error("boom"));
      // sweep-a expired and was removed; only sweep-b remains
      expect(__cooldownSizeForTests()).toBe(1);

      // still inside sweep-b's own cooldown → suppressed, map unchanged
      vi.mocked(log.warn).mockClear();
      await reportError("test:sweep-b", "ctx", new Error("boom"));
      expect(__cooldownSizeForTests()).toBe(1);
      expect(vi.mocked(log.warn).mock.calls.some((c) => String(c[0]).includes("cooldown"))).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
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
