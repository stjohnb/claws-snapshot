import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  HOME_ASSISTANT_CONFIG_REPO: "",
  IMPROVEMENT_IDENTIFIER_MODEL: "openrouter/z-ai/glm-5.3",
}));
vi.mock("../model-selector.js", () => ({ getModel: (tier?: string) => tier ?? "sonnet" }));

vi.mock("../home-assistant.js", () => ({
  isHomeAssistantConfigRepo: (fullName: string) => fullName === "St-John-Software/home-assistant-config",
  homeAssistantMcpAvailable: () => false,
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockFs, mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
  },
  mockGh: {
    listOpenIssues: vi.fn(),
    listPRs: vi.fn(),
    findOpenPRsByTitle: vi.fn(),
    findIssueByExactTitle: vi.fn(),
    createPR: vi.fn(),
    createIssue: vi.fn(),
    isRepoPrivate: vi.fn().mockResolvedValue(false),
  },
  mockClaude: {
    withNewWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    hasNewCommits: vi.fn(),
    pushBranch: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
    writeClawsMcpConfig: vi.fn().mockReturnValue("/tmp/mock-mcp-config.json"),
    writeAgentMcpConfig: vi.fn().mockReturnValue("/tmp/mock-mcp-config.json"),
    getCommitCount: vi.fn().mockResolvedValue(1),
    getDiffStats: vi.fn().mockResolvedValue({ filesChanged: 1, insertions: 10, deletions: 5 }),
    repoDir: vi.fn((repo: { owner: string; name: string }) => `/home/testuser/.claws/repos/${repo.owner}/${repo.name}`),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    updateTaskModel: vi.fn(),
    updateTaskTokenUsage: vi.fn(),
    trackTaskTokens: vi.fn().mockReturnValue(vi.fn()),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
    markRepoProcessedDaily: vi.fn(),
    countRecentTasksForJobRepo: vi.fn().mockReturnValue(0),
    withTaskRecording: vi.fn(async (jobName: string, repo: string, itemNumber: number, triggerLabel: string | null, fn: (taskId: number) => Promise<unknown>) => {
      const taskId = mockDb.recordTaskStart(jobName, repo, itemNumber, triggerLabel);
      try {
        return await fn(taskId);
      } catch (err) {
        mockDb.recordTaskFailed(taskId, String(err), { failureCategory: "unknown" });
        throw err;
      }
    }),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);
vi.mock("../smart-schedule.js", () => ({
  localDateString: () => "2024-01-15",
  withDailyRepoMarking: async (jobName: string, repoFullName: string, fn: () => Promise<unknown>, onError?: (err: unknown) => unknown) => {
    try {
      return await fn();
    } catch (err) {
      if (!onError) throw err;
      return onError(err);
    } finally {
      mockDb.markRepoProcessedDaily(jobName, repoFullName, "2024-01-15");
    }
  },
}));

import { run, parseReviewOutput, buildPrompt, filterImportantImprovements } from "./improvement-identifier.js";
import { reportError } from "../error-reporter.js";

const validResponse = JSON.stringify({
  securityFindings: [],
  improvements: [
    { severity: "high", title: "Consolidate duplicate validation logic", body: "Files `src/a.ts` and `src/b.ts` both validate..." },
    { severity: "high", title: "Remove unused helper function", body: "`src/utils.ts:42` exports `formatDate` which is never imported..." },
  ],
});

const emptyResponse = JSON.stringify({ securityFindings: [], improvements: [] });

const improvementIssues = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    number: 100 + i,
    title: `Open improvement ${i}`,
    body: `Body\n\n---\n*Automated improvement suggestion by claws improvement-identifier*`,
    labels: [],
    author: { login: "claws" },
  }));

describe("improvement-identifier", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.findOpenPRsByTitle.mockResolvedValue([]);
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createPR.mockResolvedValue(42);
    mockGh.createIssue.mockResolvedValue(42);
    mockClaude.withNewWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${validResponse}\n\`\`\``);
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
  });

  it("skips repo without local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockGh.listOpenIssues).not.toHaveBeenCalled();
    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
  });

  it("skips analysis when an open security issue and a full improvement backlog exist", async () => {
    mockGh.listOpenIssues.mockResolvedValue([
      { number: 1, title: "security: Existing finding", body: "", labels: [], author: { login: "claws" } },
      ...improvementIssues(5),
    ]);

    await run([repo]);

    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockGh.createPR).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("runs analysis but skips improvement filing when the improvement backlog is full", async () => {
    mockGh.listOpenIssues.mockResolvedValue(improvementIssues(5));

    await run([repo]);

    // Analysis still runs (to harvest any security findings)
    expect(mockClaude.withNewWorktree).toHaveBeenCalledTimes(1);
    expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    // But no improvement issues created
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("files improvements when the open improvement backlog is below the limit", async () => {
    mockGh.listOpenIssues.mockResolvedValue(improvementIssues(2));

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
  });

  it("ignores open issues without the improvement footer when sizing the backlog", async () => {
    mockGh.listOpenIssues.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({
        number: 200 + i,
        title: `Unrelated issue ${i}`,
        body: "unrelated",
        labels: [],
        author: { login: "someone" },
      })),
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
  });

  it("creates PRs from Claude suggestions", async () => {
    await run([repo]);

    // Analysis worktree only — no implementation worktrees
    expect(mockClaude.withNewWorktree).toHaveBeenCalledTimes(1);
    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Consolidate duplicate validation logic",
      expect.stringContaining("Files `src/a.ts` and `src/b.ts`"),
      [],
    );
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Remove unused helper function",
      expect.stringContaining("`src/utils.ts:42`"),
      [],
    );
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("runs analysis on opencode with the configured OpenRouter model", async () => {
    mockClaude.runClaude.mockResolvedValue('```json\n{"securityFindings":[],"improvements":[]}\n```');
    await run([repo]);
    expect(mockClaude.runClaude.mock.calls[0][2]).toEqual(expect.objectContaining({
      provider: "opencode", model: "openrouter/z-ai/glm-5.3", agent: "plan", tier: "sonnet",
    }));
    expect(mockClaude.runClaude.mock.calls[0][2].strictProvider).toBeUndefined();
  });

  it("no PRs created when Claude finds nothing", async () => {
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${emptyResponse}\n\`\`\``);

    await run([repo]);

    expect(mockGh.createPR).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
    // Only the analysis worktree
    expect(mockClaude.withNewWorktree).toHaveBeenCalledTimes(1);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
  });

  it("dedup skips improvements with matching open issues", async () => {
    mockGh.findIssueByExactTitle
      .mockResolvedValueOnce({ number: 5, title: "Consolidate duplicate validation logic" })
      .mockResolvedValueOnce(null);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Remove unused helper function",
      expect.any(String),
      [],
    );
  });

  it("dedup skips improvements with matching open PRs", async () => {
    mockGh.findOpenPRsByTitle
      .mockResolvedValueOnce([{ number: 10, title: "Consolidate duplicate validation logic" }])
      .mockResolvedValueOnce([]);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Remove unused helper function",
      expect.any(String),
      [],
    );
  });

  it("files an improvement when only a partially-matching open issue exists", async () => {
    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Consolidate duplicate validation logic",
      expect.any(String),
      [],
    );
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Remove unused helper function",
      expect.any(String),
      [],
    );
  });

  it("files an improvement when an open PR only partially matches the title", async () => {
    mockGh.findOpenPRsByTitle.mockResolvedValue([{ number: 10, title: "refactor: Consolidate duplicate validation logic" }]);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Consolidate duplicate validation logic",
      expect.any(String),
      [],
    );
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "Remove unused helper function",
      expect.any(String),
      [],
    );
  });

  it("issue body includes traceability footer", async () => {
    mockClaude.runClaude.mockResolvedValue(
      `\`\`\`json\n${JSON.stringify({ securityFindings: [], improvements: [{ severity: "high", title: "Test", body: "Test body" }] })}\n\`\`\``,
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      expect.stringContaining("Automated improvement suggestion"),
      [],
    );
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("no labels applied to improvement issues", async () => {
    await run([repo]);

    // createIssue receives [] as the 4th arg
    for (const call of mockGh.createIssue.mock.calls) {
      expect(call[3]).toEqual([]);
    }
  });

  it("analysis worktree is cleaned up before implementation begins", async () => {
    const worktreeOrder: string[] = [];
    mockClaude.withNewWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => {
      worktreeOrder.push("create");
      const result = await fn("/tmp/worktree");
      worktreeOrder.push("remove");
      return result;
    });

    await run([repo]);

    // Only the analysis worktree — no implementation worktrees
    expect(worktreeOrder).toHaveLength(2);
    expect(worktreeOrder).toEqual(["create", "remove"]);
  });

  it("error in one improvement does not block others", async () => {
    // Analysis returns 2 improvements; first createIssue fails, second succeeds
    mockClaude.runClaude.mockResolvedValueOnce(`\`\`\`json\n${validResponse}\n\`\`\``);
    mockGh.createIssue.mockRejectedValueOnce(new Error("create failed")).mockResolvedValueOnce(44);

    await run([repo]);

    // First fails, second should still succeed
    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(
      "improvement-identifier:create-improvement-issue",
      expect.stringContaining("Consolidate"),
      expect.any(Error),
    );
  });

  it("fetches both issue and PR titles for prompt context", async () => {
    mockGh.listOpenIssues.mockResolvedValue([{ number: 1, title: "Fix bug" }]);
    mockGh.listPRs.mockResolvedValue([{ number: 2, title: "refactor: Improve X", headRefName: "claws/some-other-branch" }]);

    await run([repo]);

    // The analysis runClaude call should include both issue and PR titles
    const analysisPrompt = mockClaude.runClaude.mock.calls[0][0] as string;
    expect(analysisPrompt).toContain("Fix bug");
    expect(analysisPrompt).toContain("refactor: Improve X");
  });

  it("handles Claude output parse failure gracefully", async () => {
    mockClaude.runClaude.mockResolvedValue("I couldn't analyze the repo, sorry!");

    await run([repo]);

    expect(mockGh.createPR).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
  });

  it("cleans up analysis worktree on error", async () => {
    mockClaude.runClaude.mockRejectedValue(new Error("claude crashed"));

    await run([repo]);

    expect(mockClaude.withNewWorktree).toHaveBeenCalledTimes(1);
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude crashed"), expect.any(Object));
  });

  it("reports errors without crashing the loop", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });

    mockClaude.runClaude
      .mockRejectedValueOnce(new Error("first repo error"))
      .mockResolvedValueOnce(`\`\`\`json\n${validResponse}\n\`\`\``);

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "improvement-identifier:process-repo",
      repo.fullName,
      expect.any(Error),
    );
    // Second repo should still be processed — improvements filed as issues
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo2.fullName,
      expect.any(String),
      expect.any(String),
      [],
    );
  });

  it("marks repo processed after successful implementation run", async () => {
    await run([repo]);

    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
      "improvement-identifier",
      repo.fullName,
      "2024-01-15",
    );
  });

  it("marks repo processed when no improvements found", async () => {
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${emptyResponse}\n\`\`\``);

    await run([repo]);

    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
      "improvement-identifier",
      repo.fullName,
      "2024-01-15",
    );
  });

  it("marks repo processed on error in run()", async () => {
    mockClaude.runClaude.mockRejectedValue(new Error("claude crashed"));

    await run([repo]);

    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
      "improvement-identifier",
      repo.fullName,
      "2024-01-15",
    );
  });

  it("marks repo processed even when skipping due to a full improvement backlog", async () => {
    mockGh.listOpenIssues.mockResolvedValue(improvementIssues(5));

    await run([repo]);

    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
      "improvement-identifier", repo.fullName, "2024-01-15",
    );
  });

  it("marks repo processed even when skipping due to no local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
      "improvement-identifier", repo.fullName, "2024-01-15",
    );
  });

  it("drops improvements that are not high severity", async () => {
    const response = JSON.stringify({
      securityFindings: [],
      improvements: [
        { severity: "high", title: "High severity fix", body: "Body high" },
        { severity: "low", title: "Low severity idea", body: "Body low" },
        { title: "Untagged idea", body: "Body untagged" },
      ],
    });
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${response}\n\`\`\``);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "High severity fix",
      expect.any(String),
      [],
    );
  });

  it("caps improvements at MAX_IMPROVEMENTS_PER_RUN", async () => {
    const manyImprovements = JSON.stringify({
      securityFindings: [],
      improvements: [
        { severity: "high", title: "Improvement 1", body: "Body 1" },
        { severity: "high", title: "Improvement 2", body: "Body 2" },
        { severity: "high", title: "Improvement 3", body: "Body 3" },
        { severity: "high", title: "Improvement 4", body: "Body 4" },
        { severity: "high", title: "Improvement 5", body: "Body 5" },
        { severity: "high", title: "Improvement 6", body: "Body 6" },
        { severity: "high", title: "Improvement 7", body: "Body 7" },
        { severity: "high", title: "Improvement 8", body: "Body 8" },
        { severity: "high", title: "Improvement 9", body: "Body 9" },
        { severity: "high", title: "Improvement 10", body: "Body 10" },
        { severity: "high", title: "Improvement 11", body: "Body 11" },
        { severity: "high", title: "Improvement 12", body: "Body 12" },
      ],
    });
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${manyImprovements}\n\`\`\``);

    await run([repo]);

    // Max 2 issues created
    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
  });

  // --- Unified flow tests ---

  it("analysis returns security findings and improvements → files issues, skips improvement implementation", async () => {
    const response = JSON.stringify({
      securityFindings: [
        { title: "Inject risk in exec", body: "File src/exec.ts:10 passes user input..." },
        { title: "Hardcoded token", body: "src/config.ts:5 has token abc123..." },
      ],
      improvements: [
        { severity: "high", title: "Remove dead code", body: "src/util.ts:30 is unused" },
      ],
    });
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${response}\n\`\`\``);

    await run([repo]);

    // Security issues filed
    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "security: Inject risk in exec",
      expect.stringContaining("src/exec.ts:10"),
      [],
    );
    // Improvement implementation skipped (security priority)
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("analysis returns only security findings → issues filed, no PRs", async () => {
    const response = JSON.stringify({
      securityFindings: [
        { title: "SQL injection in query", body: "src/db.ts:42 passes unsanitized input" },
      ],
      improvements: [],
    });
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${response}\n\`\`\``);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "security: SQL injection in query",
      expect.stringContaining("src/db.ts:42"),
      [],
    );
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("existingSecurityIssue → no createIssue for security, but improvements still filed as issues", async () => {
    mockGh.listOpenIssues.mockResolvedValue([
      { number: 1, title: "security: Pre-existing issue" },
    ]);
    const response = JSON.stringify({
      securityFindings: [{ title: "New finding", body: "Details..." }],
      improvements: [
        { severity: "high", title: "Consolidate duplicate validation logic", body: "Files src/a.ts..." },
        { severity: "high", title: "Remove unused helper function", body: "src/utils.ts:42..." },
      ],
    });
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${response}\n\`\`\``);

    await run([repo]);

    // Improvements filed as issues since no security findings were filed this tick
    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("security issue body includes security footer", async () => {
    const response = JSON.stringify({
      securityFindings: [{ title: "Test finding", body: "Test body" }],
      improvements: [],
    });
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${response}\n\`\`\``);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "security: Test finding",
      "Test body\n\n---\n*Automated security review by claws improvement-identifier*",
      [],
    );
  });

  it("parse failure invokes reportError with improvement-identifier:parse-findings tag", async () => {
    // Structurally complete (brace-balanced) but schema-invalid JSON — a genuine
    // parser/schema bug, not a truncation, so it must still be reported.
    mockClaude.runClaude.mockResolvedValue('```json\n{ "securityFindings": "not-an-array" }\n```');

    await run([repo]);

    expect(reportError).toHaveBeenCalledWith(
      "improvement-identifier:parse-findings",
      expect.stringContaining(repo.fullName),
      expect.any(Error),
    );
    expect(mockGh.createIssue).not.toHaveBeenCalled();
    expect(mockGh.createPR).not.toHaveBeenCalled();
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalled();
  });

  it("truncated output (no closing fence) does NOT invoke reportError", async () => {
    // Mid-string truncation, no closing ``` fence — the real max-tokens case.
    mockClaude.runClaude.mockResolvedValue(
      '```json\n{ "securityFindings": [ { "title": "x", "body": "unterminated and cut off here',
    );

    await run([repo]);

    expect(reportError).not.toHaveBeenCalledWith(
      "improvement-identifier:parse-findings",
      expect.anything(),
      expect.anything(),
    );
    expect(mockGh.createIssue).not.toHaveBeenCalled();
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalled();
  });

  it("truncated output ending in a closing fence (embedded code block masks truncation) does NOT invoke reportError", async () => {
    // Regression test for issue #1810: the outer JSON object never closes, but the
    // output happens to end in ``` because generation was cut off right after an
    // inner fenced code snippet embedded in a `body` string.
    mockClaude.runClaude.mockResolvedValue(
      '```json\n{ "improvements": [ { "title": "x", "body": "See ```js\\ncode\\n```',
    );

    await run([repo]);

    expect(reportError).not.toHaveBeenCalledWith(
      "improvement-identifier:parse-findings",
      expect.anything(),
      expect.anything(),
    );
    expect(mockGh.createIssue).not.toHaveBeenCalled();
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalled();
  });

  it("caps security findings at MAX_FINDINGS_PER_RUN (5)", async () => {
    const manyFindings = JSON.stringify({
      securityFindings: [
        { title: "Finding 1", body: "Body 1" },
        { title: "Finding 2", body: "Body 2" },
        { title: "Finding 3", body: "Body 3" },
        { title: "Finding 4", body: "Body 4" },
        { title: "Finding 5", body: "Body 5" },
        { title: "Finding 6", body: "Body 6" },
        { title: "Finding 7", body: "Body 7" },
      ],
      improvements: [],
    });
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${manyFindings}\n\`\`\``);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(5);
  });

  it("error in one security finding does not block others", async () => {
    const response = JSON.stringify({
      securityFindings: [
        { title: "Finding 1", body: "Body 1" },
        { title: "Finding 2", body: "Body 2" },
      ],
      improvements: [],
    });
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${response}\n\`\`\``);
    mockGh.createIssue
      .mockRejectedValueOnce(new Error("create failed"))
      .mockResolvedValueOnce(99);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(
      "improvement-identifier:create-security-issue",
      expect.stringContaining("Finding 1"),
      expect.any(Error),
    );
  });

  it("dedup skips security findings with matching open issues", async () => {
    const response = JSON.stringify({
      securityFindings: [
        { title: "Finding 1", body: "Body 1" },
        { title: "Finding 2", body: "Body 2" },
      ],
      improvements: [],
    });
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${response}\n\`\`\``);
    mockGh.findIssueByExactTitle
      .mockResolvedValueOnce({ number: 5, title: "security: Finding 1" })
      .mockResolvedValueOnce(null);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "security: Finding 2",
      expect.any(String),
      [],
    );
    // One finding filed → improvements skipped
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });
});

describe("parseReviewOutput", () => {
  const validOutput = JSON.stringify({
    securityFindings: [
      { title: "Sanitize user input in command builder", body: "File `src/exec.ts:42` passes user-supplied strings..." },
    ],
    improvements: [
      { title: "Consolidate duplicate validation logic", body: "Files `src/a.ts` and `src/b.ts` both validate..." },
    ],
  });

  it("parses JSON from code fence", () => {
    const output = "Some text\n```json\n" + validOutput + "\n```\nMore text";
    const result = parseReviewOutput(output);
    expect(result.securityFindings).toHaveLength(1);
    expect(result.securityFindings[0].title).toBe("Sanitize user input in command builder");
    expect(result.improvements).toHaveLength(1);
    expect(result.improvements[0].title).toBe("Consolidate duplicate validation logic");
  });

  it("parses raw JSON without code fence", () => {
    const result = parseReviewOutput(validOutput);
    expect(result.securityFindings).toHaveLength(1);
    expect(result.improvements).toHaveLength(1);
  });

  it("returns empty arrays for garbled output", () => {
    const result = parseReviewOutput("This is not JSON at all");
    expect(result).toEqual({ securityFindings: [], improvements: [] });
  });

  it("invokes onFailure when output contains no JSON candidates", () => {
    const onFailure = vi.fn();
    const result = parseReviewOutput("This is not JSON at all", onFailure);
    expect(result).toEqual({ securityFindings: [], improvements: [] });
    expect(onFailure).toHaveBeenCalledWith(expect.any(Error), []);
  });

  it("returns empty arrays for invalid JSON structure", () => {
    const result = parseReviewOutput('```json\n{"not_the_right_keys": []}\n```');
    expect(result).toEqual({ securityFindings: [], improvements: [] });
  });

  it("filters out items with missing fields from both arrays", () => {
    const output = JSON.stringify({
      securityFindings: [
        { title: "Valid security", body: "Valid body" },
        { title: "Missing body" },
        { body: "Missing title" },
      ],
      improvements: [
        { title: "Valid improvement", body: "Valid body" },
        { body: "No title here" },
      ],
    });
    const result = parseReviewOutput(`\`\`\`json\n${output}\n\`\`\``);
    expect(result.securityFindings).toHaveLength(1);
    expect(result.securityFindings[0].title).toBe("Valid security");
    expect(result.improvements).toHaveLength(1);
    expect(result.improvements[0].title).toBe("Valid improvement");
  });

  it("accepts empty arrays for either field", () => {
    const result = parseReviewOutput(JSON.stringify({ securityFindings: [], improvements: [] }));
    expect(result).toEqual({ securityFindings: [], improvements: [] });
  });

  it("parses JSON whose body contains triple backticks", () => {
    const tricky = {
      securityFindings: [{ title: "X", body: "Use ```js\nfoo()\n``` instead" }],
      improvements: [],
    };
    const output = "```json\n" + JSON.stringify(tricky) + "\n```";
    const result = parseReviewOutput(output);
    expect(result.securityFindings).toHaveLength(1);
    expect(result.securityFindings[0].body).toContain("```js");
  });

  it("falls back to brace-balanced extraction when fence is malformed", () => {
    const finding = { title: "Y", body: "Embed ```bash\nrm -rf /\n``` here" };
    const output = `Here is my analysis:\n{ "securityFindings": [${JSON.stringify(finding)}], "improvements": [] }\nDone.`;
    const result = parseReviewOutput(output);
    expect(result.securityFindings).toHaveLength(1);
    expect(result.securityFindings[0].title).toBe("Y");
    expect(result.securityFindings[0].body).toContain("```bash");
  });

  it("invokes onFailure when all candidates fail to parse", () => {
    const broken = "```json\n{ \"securityFindings\": [ { \"title\": \"x\", \"body\": \"unterminated\n```";
    const onFailure = vi.fn();
    const result = parseReviewOutput(broken, onFailure);
    expect(result).toEqual({ securityFindings: [], improvements: [] });
    expect(onFailure).toHaveBeenCalledWith(
      expect.any(Error),
      expect.arrayContaining([expect.any(String)]),
    );
  });
});

describe("buildPrompt", () => {
  it("includes private-repo guideline when isPrivate is true", () => {
    const prompt = buildPrompt("o/r", [], [], true);
    expect(prompt).toContain("This repository is PRIVATE");
    expect(prompt).toContain("do NOT recommend gating self-hosted");
    expect(prompt).toContain("only invited collaborators");
    expect(prompt).toContain("NOT as anonymous attacker input");
  });

  it("does not include private-repo guideline when isPrivate is false", () => {
    const prompt = buildPrompt("o/r", [], [], false);
    expect(prompt).not.toContain("This repository is PRIVATE");
    expect(prompt).not.toContain("only invited collaborators");
  });

  it("includes conditional Web/SEO structured-data guidance", () => {
    const prompt = buildPrompt("o/r", [], [], false);
    expect(prompt).toContain("Web / SEO improvements");
    expect(prompt).toContain("application/ld+json");
    expect(prompt).toContain("ProfilePage");
  });

  it("raises the improvement bar and requires a severity tag", () => {
    const prompt = buildPrompt("o/r", [], [], false);
    expect(prompt).toContain("Do NOT report any of the following, ever");
    expect(prompt).toContain('"severity": "high"');
  });
});

describe("filterImportantImprovements", () => {
  const item = (severity: string | undefined) => ({ title: "t", body: "b", severity });

  it("keeps items tagged high, case-insensitively and trimmed", () => {
    const items = [item("high"), item("HIGH"), item(" high ")];
    expect(filterImportantImprovements(items)).toHaveLength(3);
  });

  it("drops items not tagged high", () => {
    const items = [item("medium"), item("low"), item(undefined), item("critical")];
    expect(filterImportantImprovements(items)).toHaveLength(0);
  });
});
