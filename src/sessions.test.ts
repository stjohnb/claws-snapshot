import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockClaude, mockLog, mockShutdown } = vi.hoisted(() => ({
  mockDb: {
    updateSessionSummary: vi.fn(),
    setManualSessionSummary: vi.fn(() => true),
    setSessionAgentStatus: vi.fn(() => true),
    getEndedSessions: vi.fn((): unknown[] => []),
    getPersistedSession: vi.fn(),
  },
  mockClaude: { runClaude: vi.fn() },
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockShutdown: { isShuttingDown: vi.fn(() => false), ShutdownError: class {} },
}));

vi.mock("./db.js", () => mockDb);
vi.mock("./claude.js", () => mockClaude);
vi.mock("./log.js", () => mockLog);
vi.mock("./shutdown.js", () => mockShutdown);
vi.mock("./config.js", () => ({
  BROWSER_CDP_ENDPOINT: "",
  WORK_DIR: "/home/test/.claws",
  OPENCODE_BEST_MODEL: "openrouter/test/model",
  PI_BEST_MODEL: "anthropic/claude-opus-5-5",
  OPENROUTER_API_KEY: "",
  PROD_GRAFANA_URL: "",
  PROD_GRAFANA_TOKEN: "",
  FLEET_GRAFANA_URL: "",
  FLEET_GRAFANA_TOKEN: "",
  HOME_ASSISTANT_BASE_URL: "https://ha.example",
  HOME_ASSISTANT_TOKEN: "ha-token",
  FORGEJO_ADMIN_TOKEN: "",
  FORGEJO_TOKEN: "forge-token",
  FORGEJO_READ_TOKEN: "forge-read-token",
  FORGEJO_BASE_URL: "https://git.example.test",
  FORGEJO_REPOS: ["owner/forge"],
  isForgejoRepo: (n: string) => n === "owner/forge",
}));

import { buildAgentArgv, summarizeSession, setSessionDescription, setSessionAgentStatusForSession, getEndedSession, listEndedSessions, isNumberOnlySummary, stripIssueRefs, SUMMARY_RETRY_INSTRUCTION, sessionPromptText } from "./sessions.js";
import type { SummarizableSession } from "./sessions.js";
import { BROWSER_CAPABILITY_ID } from "./capabilities.js";
import { READ_ONLY_DIAGNOSTIC_TOOLS, SESSION_ISSUE_WRITE_TOOLS } from "./claws-state-tools.js";

describe("buildAgentArgv", () => {
  it("builds claude argv from pre-prepared paths", () => {
    vi.clearAllMocks();
    expect(buildAgentArgv({
      provider: "claude", promptFile: "/prompt.md", uploadDir: "/up", mcpConfigPath: "/mcp.json", extra: ["--continue"], model: "opus",
    })).toEqual([
      "--dangerously-skip-permissions", "--model", "opus", "--append-system-prompt-file", "/prompt.md",
      "--add-dir", "/up", "--mcp-config", "/mcp.json", "--strict-mcp-config", "--continue",
    ]);
  });

  it("omits --add-dir and --mcp-config when their paths are null, but keeps --strict-mcp-config", () => {
    expect(buildAgentArgv({ provider: "claude", promptFile: null, uploadDir: null, mcpConfigPath: null, extra: [] }))
      .toEqual(["--dangerously-skip-permissions", "--strict-mcp-config"]);
  });

  it("builds a codex resume without --model", () => {
    expect(buildAgentArgv({ provider: "codex", promptFile: "/prompt.md", uploadDir: "/up", mcpConfigPath: null, extra: [], resume: true, model: "gpt" }))
      .toEqual(["resume", "--last", "--dangerously-bypass-approvals-and-sandbox", "--add-dir", "/up"]);
  });

  it("uses OPENCODE_BEST_MODEL for opencode when no model is chosen", () => {
    expect(buildAgentArgv({ provider: "opencode", promptFile: null, uploadDir: null, mcpConfigPath: null, extra: [], model: null }))
      .toEqual(["--model", "openrouter/test/model"]);
  });

  it("opencode resume uses --continue, honours the chosen model and drops --add-dir and extra", () => {
    expect(buildAgentArgv({ provider: "opencode", promptFile: null, uploadDir: "/up", mcpConfigPath: null, extra: ["--add-dir", "/e"], resume: true, model: "x/y" }))
      .toEqual(["--continue", "--model", "x/y"]);
  });

  it("builds pi argv with the default model", () => {
    expect(buildAgentArgv({ provider: "pi", promptFile: null, uploadDir: null, mcpConfigPath: null, extra: [], model: null }))
      .toEqual(["--no-approve", "--provider", "anthropic", "--model", "claude-opus-5-5"]);
  });
});

describe("summarizeSession — generate-once", () => {
  const ENOUGH_SCROLLBACK = "x".repeat(100);

  function makeSession(overrides: Partial<SummarizableSession> = {}): SummarizableSession {
    return {
      id: "sess-1",
      lastActivity: Date.now(),
      scrollback: ENOUGH_SCROLLBACK,
      alive: true,
      summary: null,
      summaryUpdatedAt: null,
      summaryManual: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockShutdown.isShuttingDown.mockReturnValue(false);
    mockClaude.runClaude.mockResolvedValue("Editing src/sessions.ts summarizer");
  });

  it("calls runClaude with provider=claude and persists the summary", async () => {
    const session = makeSession();

    await summarizeSession(session);

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    const [, , opts] = mockClaude.runClaude.mock.calls[0];
    expect(opts).toMatchObject({ provider: "claude" });
    expect(session.summary).toBe("Editing src/sessions.ts summarizer");
    expect(mockDb.updateSessionSummary).toHaveBeenCalledWith("sess-1", "Editing src/sessions.ts summarizer", expect.any(Number));
  });

  it("does not call runClaude again when a summary is already set (generate-once)", async () => {
    const session = makeSession({ summary: "Already summarized" });

    await summarizeSession(session);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(session.summary).toBe("Already summarized");
  });

  it("does not call runClaude and leaves summary null when scrollback is too short", async () => {
    const session = makeSession({ scrollback: "short" });

    await summarizeSession(session);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(session.summary).toBeNull();
    expect(mockDb.updateSessionSummary).not.toHaveBeenCalled();
  });

  it("re-summarizes an idle placeholder once there is newer activity", async () => {
    const session = makeSession({
      summary: "Idle at shell prompt",
      summaryUpdatedAt: 1000,
      lastActivity: 2000,
    });
    mockClaude.runClaude.mockResolvedValue("Editing sessions.ts summarizer");

    await summarizeSession(session);

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    expect(session.summary).toBe("Editing sessions.ts summarizer");
  });

  it("skips re-summarizing an idle placeholder when there is no newer activity", async () => {
    const session = makeSession({
      summary: "Idle at Claude prompt",
      summaryUpdatedAt: 2000,
      lastActivity: 2000,
    });

    await summarizeSession(session);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(session.summary).toBe("Idle at Claude prompt");
  });

  it("normalizes verbose idle agent output to the canonical string", async () => {
    const session = makeSession();
    mockClaude.runClaude.mockResolvedValue("Idle at Claude Code prompt in bonkus worktree");

    await summarizeSession(session);

    expect(session.summary).toBe("Idle at Claude prompt");
  });

  it("normalizes verbose idle shell output to the canonical string", async () => {
    const session = makeSession();
    mockClaude.runClaude.mockResolvedValue("Idle sitting at shell prompt in claws-wt repo");

    await summarizeSession(session);

    expect(session.summary).toBe("Idle at shell prompt");
  });

  it("never calls runClaude when the summary is manually pinned", async () => {
    const session = makeSession({ summaryManual: true });

    await summarizeSession(session);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
  });

  it("force overwrites an existing summary", async () => {
    const session = makeSession({ summary: "Already summarized" });
    mockClaude.runClaude.mockResolvedValue("Fresh forced summary");

    await summarizeSession(session, { force: true });

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    expect(session.summary).toBe("Fresh forced summary");
  });

  it("retries once and stores the retry when the summary identifies the work by number alone", async () => {
    const session = makeSession();
    mockClaude.runClaude
      .mockResolvedValueOnce("Reviewing PR #1234 comments")
      .mockResolvedValueOnce("Debugging websocket reconnect loop");

    await summarizeSession(session);

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
    expect(mockClaude.runClaude.mock.calls[1][0]).toContain(SUMMARY_RETRY_INSTRUCTION);
    expect(session.summary).toBe("Debugging websocket reconnect loop");
    expect(mockDb.updateSessionSummary).toHaveBeenCalledTimes(1);
    expect(mockDb.updateSessionSummary).toHaveBeenCalledWith("sess-1", "Debugging websocket reconnect loop", expect.any(Number));
  });

  it("does not retry when the number is extra detail alongside a real description", async () => {
    const session = makeSession();
    mockClaude.runClaude.mockResolvedValue("Merging PR #1566, adding secret, embedding dashboard widgets");

    await summarizeSession(session);

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    expect(session.summary).toBe("Merging PR #1566, adding secret, embedding dashboard widgets");
  });

  it("strips the reference when the retry is also number-only", async () => {
    const session = makeSession();
    mockClaude.runClaude.mockResolvedValue("Reviewing PR #1234 comments");

    await summarizeSession(session);

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
    expect(session.summary).toBe("Reviewing comments");
  });

  it("refreshes a persisted number-only summary once activity advances", async () => {
    const session = makeSession({
      summary: "Reviewing fleet-infra issue #1267 plan",
      summaryUpdatedAt: 1000,
      lastActivity: 2000,
    });
    mockClaude.runClaude.mockResolvedValue("Reviewing dashboard widget embed");

    await summarizeSession(session);

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    expect(session.summary).toBe("Reviewing dashboard widget embed");
  });

  it("keeps the more informative attempt when both are number-only", async () => {
    const session = makeSession();
    mockClaude.runClaude
      .mockResolvedValueOnce("Reviewing fleet-infra issue #1267 plan")
      .mockResolvedValueOnce("Working on #42");

    await summarizeSession(session);

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
    expect(session.summary).toBe("Reviewing fleet-infra plan");
  });

  it("falls back to a placeholder when both attempts are a bare reference with nothing left after stripping", async () => {
    const session = makeSession();
    mockClaude.runClaude.mockResolvedValue("PR #1234");

    await summarizeSession(session);

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
    expect(session.summary).toBe("Unspecified session activity");
    expect(mockDb.updateSessionSummary).toHaveBeenCalledWith("sess-1", "Unspecified session activity", expect.any(Number));
  });

  it("leaves the summary untouched when the retry call rejects", async () => {
    const session = makeSession();
    mockClaude.runClaude
      .mockResolvedValueOnce("Reviewing PR #1234 comments")
      .mockRejectedValueOnce(new Error("timed out"));

    await summarizeSession(session);

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
    expect(session.summary).toBeNull();
    expect(mockDb.updateSessionSummary).not.toHaveBeenCalled();
  });

  it("does not refresh a persisted number-only summary without newer activity", async () => {
    const session = makeSession({
      summary: "Reviewing fleet-infra issue #1267 plan",
      summaryUpdatedAt: 2000,
      lastActivity: 2000,
    });

    await summarizeSession(session);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(session.summary).toBe("Reviewing fleet-infra issue #1267 plan");
  });
});

describe("isNumberOnlySummary", () => {
  it.each([
    ["Working on #1234", true],
    ["Reviewing PR #1234 comments", true],
    ["Reviewing fleet-infra issue #1267 plan", true],
    ["Merging St-John-Software/claws#42", true],
    ["Merging St-John-Software/claws #42", true],
    ["Doing stuff for issue #1234 now", true],
    ["Working on #clw_01JBQ5ZK3N8T4Q7M2V9XWR6HDA", true],
    ["Fixing WebSocket reconnect loop", false],
    ["Merging PR #1566, adding secret, embedding dashboard widgets", false],
    ["Idle at shell prompt", false],
  ])("isNumberOnlySummary(%j) === %p", (summary, expected) => {
    expect(isNumberOnlySummary(summary)).toBe(expected);
  });

  it("strips issue/PR references and tidies punctuation", () => {
    expect(stripIssueRefs("Merging PR #1566, adding secret")).toBe("Merging, adding secret");
  });

  it("strips a native issue reference the same way", () => {
    expect(stripIssueRefs("Working on #clw_01JBQ5ZK3N8T4Q7M2V9XWR6HDA now")).toBe("Working on now");
  });

  it("keeps the numeric guard's own boundary for #123abc — unaffected by the wider native guard", () => {
    expect(stripIssueRefs("Debugging #123abc now")).toBe("Debugging abc now");
    expect(isNumberOnlySummary("Debugging #123abc now")).toBe(false);
  });
});

describe("setSessionDescription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok:false when the DB update affects no row", async () => {
    mockDb.setManualSessionSummary.mockReturnValue(false);

    const result = await setSessionDescription("does-not-exist", "A description");

    expect(result.ok).toBe(false);
  });

  it("pins a collapsed, trimmed description on the row", async () => {
    mockDb.setManualSessionSummary.mockReturnValue(true);

    const result = await setSessionDescription("abc123", "  Fixing   the\nbuild  ");

    expect(result).toEqual({ ok: true, description: "Fixing the build" });
    expect(mockDb.setManualSessionSummary).toHaveBeenCalledWith("abc123", "Fixing the build", expect.any(Number));
  });

  it("clears the pin for an empty description", async () => {
    mockDb.setManualSessionSummary.mockReturnValue(true);

    expect(await setSessionDescription("abc123", "   ")).toEqual({ ok: true, description: null });
    expect(mockDb.setManualSessionSummary).toHaveBeenCalledWith("abc123", null, null);
  });

  it("returns ok:false when the DB write throws", async () => {
    mockDb.setManualSessionSummary.mockImplementationOnce(() => { throw new Error("db down"); });
    expect(await setSessionDescription("abc123", "x")).toEqual({ ok: false, description: null });
  });
});

describe("setSessionAgentStatusForSession (#3083)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists the status with a timestamp and reports ok when the live row was updated", async () => {
    mockDb.setSessionAgentStatus.mockReturnValue(true);

    const result = await setSessionAgentStatusForSession("abc123", "monitoring");

    expect(result).toMatchObject({ ok: true, status: "monitoring" });
    expect(mockDb.setSessionAgentStatus).toHaveBeenCalledWith("abc123", "monitoring", result.updatedAt);
  });

  it("returns ok:false for an unknown or ended session", async () => {
    mockDb.setSessionAgentStatus.mockReturnValue(false);
    expect((await setSessionAgentStatusForSession("does-not-exist", "done")).ok).toBe(false);
  });

  it("returns ok:false when the DB write throws", async () => {
    mockDb.setSessionAgentStatus.mockImplementationOnce(() => { throw new Error("db down"); });
    expect((await setSessionAgentStatusForSession("abc123", "working")).ok).toBe(false);
  });
});

describe("getEndedSession", () => {
  it("returns undefined when there is no persisted row", async () => {
    mockDb.getPersistedSession.mockReturnValue(undefined);
    expect(await getEndedSession("nope")).toBeUndefined();
  });

  it("returns undefined when the row is still live (ended_at is null)", async () => {
    mockDb.getPersistedSession.mockReturnValue({
      id: "abcdef12", tmux_name: "claws-abcdef12", mode: "worktree-claude", repo: "org/a",
      cwd: "/w", worktree_path: "/w", extra_worktrees: null, capabilities: null,
      created_at: 1, summary: null, summary_updated_at: null,
      ended_at: null, resume_repos: JSON.stringify(["org/a"]),
    });
    expect(await getEndedSession("abcdef12")).toBeUndefined();
  });

  it("returns the mapped history record for an ended row", async () => {
    mockDb.getPersistedSession.mockReturnValue({
      id: "abcdef12", repo: "org/a", cwd: "/w", mode: "worktree-claude", provider: "codex", backend: "k8s-pod",
      created_at: 1, ended_at: 2, resume_repos: '["org/a","org/b"]', summary: "did stuff",
      summary_updated_at: 2, tmux_name: "claws-abcdef12", worktree_path: "/w", capabilities: null,
      exit_code: 2, last_output: "boom", startup_failure: null,
    });
    expect(await getEndedSession("abcdef12")).toEqual({
      id: "abcdef12", repo: "org/a", extraRepos: ["org/b"], cwd: "/w",
      provider: "codex", createdAt: 1, endedAt: 2, summary: "did stuff",
      mode: "worktree-claude", exitCode: 2, lastOutput: "boom", failureReason: null,
      resumable: true,
    });
  });

  it.each([null, "local-tmux"])("marks an ended host-tmux row (backend %j) as not resumable but keeps its history", async (backend) => {
    mockDb.getPersistedSession.mockReturnValue({
      id: "abcdef12", repo: "org/a", cwd: "/w", mode: "worktree-claude", provider: "claude", backend,
      created_at: 1, ended_at: 2, resume_repos: '["org/a"]', summary: "host work",
      summary_updated_at: 2, tmux_name: "claws-abcdef12", worktree_path: "/w", capabilities: null,
      exit_code: 0, last_output: "bye", startup_failure: null,
    });
    expect(await getEndedSession("abcdef12")).toMatchObject({
      id: "abcdef12", repo: "org/a", summary: "host work", createdAt: 1, endedAt: 2, lastOutput: "bye", resumable: false,
    });
  });

  it("names the session and issue that started an ended row", async () => {
    mockDb.getPersistedSession.mockReturnValue({
      id: "abcdef12", repo: null, cwd: "/home", mode: "home-claude", provider: "claude",
      created_at: 1, ended_at: 2, resume_repos: null, summary: null,
      summary_updated_at: null, tmux_name: "claws-abcdef12", worktree_path: null, capabilities: null,
      exit_code: null, last_output: null, startup_failure: null,
      spawned_by_session: "0123456789abcdef", spawned_for_issue: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE",
    });
    expect((await getEndedSession("abcdef12"))?.startedBy).toEqual({ session: "0123456789abcdef", issue: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE" });
  });
});

describe("listEndedSessions", () => {
  it("lists host-tmux rows as history that cannot be resumed, and pod rows as resumable", async () => {
    const row = (id: string, backend: string | null) => ({
      id, repo: "org/a", cwd: "/w", mode: "worktree-claude", provider: "claude", model: null, backend,
      created_at: 1, ended_at: 2, resume_repos: '["org/a","org/b"]', summary: `summary ${id}`,
      summary_updated_at: 2, tokens_used: null, cost_usd: null, last_context_tokens: null,
      usage_updated_at: null, exit_code: null,
    });
    mockDb.getEndedSessions.mockReturnValueOnce([row("aa", "k8s-pod"), row("bb", "local-tmux"), row("cc", null)]);

    const list = await listEndedSessions();

    expect(list.map((s) => [s.id, s.resumable])).toEqual([["aa", true], ["bb", false], ["cc", false]]);
    expect(list[1]).toMatchObject({ repo: "org/a", extraRepos: ["org/b"], summary: "summary bb", createdAt: 1, endedAt: 2, alive: false });
  });
});

describe("sessionPromptText", () => {
  it("tells a session about every write tool, and names no tool outside the two lists (#clw_01M3BWP83BQRXE06NWW1GKYT2S)", () => {
    const prompt = sessionPromptText([], "k8s-pod");
    for (const tool of SESSION_ISSUE_WRITE_TOOLS) expect(prompt).toContain(tool);
    for (const tool of READ_ONLY_DIAGNOSTIC_TOOLS) expect(prompt).toContain(tool);
    // The diagnostics/writes paragraph is built only from the two lists.
    const paragraph = prompt.split("\n\n").find((p) => p.startsWith("Claws runtime diagnostics"))!;
    const named = new Set(paragraph.match(/\bclaws_[a-z_]+/g));
    const known = new Set<string>([...READ_ONLY_DIAGNOSTIC_TOOLS, ...SESSION_ISSUE_WRITE_TOOLS]);
    for (const tool of named) expect(known).toContain(tool);
    // A browser session has no claws-state server, so it is told about none.
    const browser = sessionPromptText([BROWSER_CAPABILITY_ID]);
    for (const tool of SESSION_ISSUE_WRITE_TOOLS) expect(browser).not.toContain(tool);
  });

  it("tells an agent session that an upgrade notice means a restart picks up new tools", () => {
    expect(sessionPromptText([], "k8s-pod")).toContain("restarting the session picks up new tools");
    expect(sessionPromptText([BROWSER_CAPABILITY_ID])).not.toContain("Claws was upgraded");
  });

  it("appends a started session's brief as the prompt's last block, and nothing without one", () => {
    const plain = sessionPromptText([], "k8s-pod");
    expect(sessionPromptText([], "k8s-pod", null)).toBe(plain);
    expect(sessionPromptText([], "k8s-pod", "## Issue this session was started for")).toBe(`${plain}\n\n## Issue this session was started for`);
  });
});
