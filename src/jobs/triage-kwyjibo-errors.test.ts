import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockIssue } from "../test-helpers.js";

const mockConfig = vi.hoisted(() => ({
  KWYJIBO_BASE_URL: "https://kwyjibo.vercel.app",
  KWYJIBO_API_KEY: "test-api-key" as string | undefined,
}));
vi.mock("../config.js", () => mockConfig);
vi.mock("../model-selector.js", () => ({ getModel: (tier?: string) => tier ?? "sonnet" }));

const mockClassifyComplexity = vi.hoisted(() => vi.fn().mockResolvedValue("sonnet"));
vi.mock("../classify-complexity.js", () => ({ classifyComplexity: mockClassifyComplexity }));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const mockGetItemTimeoutMs = vi.hoisted(() => vi.fn().mockReturnValue(undefined));
const mockHandleTimeoutIfApplicable = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../timeout-handler.js", () => ({
  getItemTimeoutMs: mockGetItemTimeoutMs,
  handleTimeoutIfApplicable: mockHandleTimeoutIfApplicable,
}));

const { mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockGh: {
    listOpenIssues: vi.fn(),
    getIssueComments: vi.fn(),
    populateQueueCache: vi.fn(),
    commentOnIssue: vi.fn(),
    isRateLimited: vi.fn().mockReturnValue(false),
    isItemSkipped: vi.fn().mockReturnValue(false),
    isAllowedActor: vi.fn().mockResolvedValue(true),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    hasIgnoreLabel: vi.fn().mockReturnValue(false),
    getIssueBodyHtml: vi.fn().mockResolvedValue(""),
  },
  mockClaude: {
    withNewWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    updateTaskModel: vi.fn(),
    updateTaskTokenUsage: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
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

vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

const mockProcessTextForImages = vi.hoisted(() => vi.fn().mockResolvedValue(""));
vi.mock("../images.js", () => ({
  processTextForImages: mockProcessTextForImages,
}));

// Mock fs for reading debugging guide
const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: { existsSync: mockFs.existsSync, readFileSync: mockFs.readFileSync },
  existsSync: mockFs.existsSync,
  readFileSync: mockFs.readFileSync,
}));

// Mock global fetch for kwyjibo API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { run, extractGameId, buildInvestigationPrompt } from "./triage-kwyjibo-errors.js";
import { reportError } from "../error-reporter.js";

describe("triage-kwyjibo-errors", () => {
  const repo = mockRepo({ name: "kwyjibo", fullName: "test-org/kwyjibo" });

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.KWYJIBO_API_KEY = "test-api-key";
    mockClaude.withNewWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue("Root cause: database timeout");
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.populateQueueCache.mockReturnValue(undefined);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("# Debugging Guide\nFollow these steps...");
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("[]") });
  });

  describe("extractGameId", () => {
    it("extracts game ID from URL", () => {
      expect(extractGameId("Check https://kwyjibo.vercel.app/games/abcdef01-2345-6789-abcd-ef0123456789/play"))
        .toBe("abcdef01-2345-6789-abcd-ef0123456789");
    });

    it("extracts game ID from labeled field", () => {
      expect(extractGameId("game_id: abcdef01-2345-6789-abcd-ef0123456789\nSomething broke"))
        .toBe("abcdef01-2345-6789-abcd-ef0123456789");
    });

    it("extracts game ID from gameId field", () => {
      expect(extractGameId("gameId: abcdef01-2345-6789-abcd-ef0123456789"))
        .toBe("abcdef01-2345-6789-abcd-ef0123456789");
    });

    it("extracts bare UUID", () => {
      expect(extractGameId("The game abcdef01-2345-6789-abcd-ef0123456789 is broken"))
        .toBe("abcdef01-2345-6789-abcd-ef0123456789");
    });

    it("returns null when no game ID found", () => {
      expect(extractGameId("Something is broken but no game ID here")).toBeNull();
    });

    it("does not match UUID inside GitHub image attachment URL", () => {
      expect(extractGameId("Screenshot:\n![image](https://github.com/user-attachments/assets/4b40f8b8-9c43-4db2-989c-6c2177ab69ef)")).toBeNull();
    });

    it("extracts bare UUID when body also contains image URLs", () => {
      const body = [
        "![image](https://github.com/user-attachments/assets/4b40f8b8-9c43-4db2-989c-6c2177ab69ef)",
        "The game abcdef01-2345-6789-abcd-ef0123456789 is broken",
      ].join("\n");
      expect(extractGameId(body)).toBe("abcdef01-2345-6789-abcd-ef0123456789");
    });
  });

  describe("buildInvestigationPrompt", () => {
    it("includes all sections when data is available", () => {
      const issue = mockIssue({ body: "Game is stuck" });
      const debugData = {
        debugLogs: '[{"event":"test"}]',
        debugLogsFetchError: null,
        turns: '[{"turn":1}]',
        pgNetErrors: '[{"error":"timeout"}]',
        pgNetErrorsFetchError: null,
      };
      const prompt = buildInvestigationPrompt("test-org/test-repo", issue, debugData, "# Guide");

      expect(prompt).toContain("Bug Report");
      expect(prompt).toContain("Game is stuck");
      expect(prompt).toContain("Debugging Guide");
      expect(prompt).toContain("# Guide");
      expect(prompt).toContain("Debug Logs");
      expect(prompt).toContain("Turn Results");
      expect(prompt).toContain("pg_net Errors");
    });

    it("handles missing debug data gracefully", () => {
      const issue = mockIssue({ body: "Game is stuck" });
      const debugData = { debugLogs: null, debugLogsFetchError: null, turns: null, pgNetErrors: null, pgNetErrorsFetchError: null };
      const prompt = buildInvestigationPrompt("test-org/test-repo", issue, debugData, null);

      expect(prompt).toContain("Debug logs unavailable.");
      expect(prompt).not.toContain("Debugging Guide");
      expect(prompt).toContain("pg_net errors unavailable.");
    });

    it("shows fetch error when pg_net errors fetch fails with HTTP error", () => {
      const issue = mockIssue({ body: "Game is stuck" });
      const debugData = { debugLogs: null, debugLogsFetchError: null, turns: null, pgNetErrors: null, pgNetErrorsFetchError: "HTTP 500" };
      const prompt = buildInvestigationPrompt("test-org/test-repo", issue, debugData, null);

      expect(prompt).toContain("Failed to retrieve pg_net errors: HTTP 500");
    });

    it("shows network error when pg_net errors fetch throws", () => {
      const issue = mockIssue({ body: "Game is stuck" });
      const debugData = { debugLogs: null, debugLogsFetchError: null, turns: null, pgNetErrors: null, pgNetErrorsFetchError: "TypeError: fetch failed" };
      const prompt = buildInvestigationPrompt("test-org/test-repo", issue, debugData, null);

      expect(prompt).toContain("Failed to retrieve pg_net errors: TypeError: fetch failed");
    });

    it("shows network error when debug-logs fetch throws", () => {
      const issue = mockIssue({ body: "Game is stuck" });
      const debugData = { debugLogs: null, debugLogsFetchError: "TypeError: fetch failed", turns: null, pgNetErrors: null, pgNetErrorsFetchError: null };
      const prompt = buildInvestigationPrompt("test-org/test-repo", issue, debugData, null);

      expect(prompt).toContain("Failed to retrieve debug logs: TypeError: fetch failed");
    });

    it("includes pre-fetched data instruction", () => {
      const issue = mockIssue({ body: "Game is stuck" });
      const debugData = { debugLogs: null, debugLogsFetchError: null, turns: null, pgNetErrors: null, pgNetErrorsFetchError: null };
      const prompt = buildInvestigationPrompt("test-org/test-repo", issue, debugData, null);

      expect(prompt).toContain("Do not recommend manually retrieving any of this data.");
    });

    it("shows API key not configured when KWYJIBO_API_KEY is undefined", () => {
      mockConfig.KWYJIBO_API_KEY = undefined;
      const issue = mockIssue({ body: "Game is stuck" });
      const debugData = { debugLogs: null, debugLogsFetchError: null, turns: null, pgNetErrors: null, pgNetErrorsFetchError: null };
      const prompt = buildInvestigationPrompt("test-org/test-repo", issue, debugData, null);

      expect(prompt).toContain("API key not configured — debug logs could not be retrieved.");
      expect(prompt).toContain("API key not configured — pg_net errors could not be retrieved.");
    });
  });

  describe("run", () => {
    it("skips repos that are not kwyjibo", async () => {
      const otherRepo = mockRepo({ name: "namey", fullName: "test-org/namey" });

      await run([otherRepo]);

      expect(mockGh.listOpenIssues).not.toHaveBeenCalled();
      expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    });

    it("happy path — issue with game ID, fetches data, posts report", async () => {
      const issue = mockIssue({
        body: "Game abcdef01-2345-6789-abcd-ef0123456789 is stuck on turn 3",
      });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValueOnce([]);

      await run([repo]);

      expect(mockClaude.withNewWorktree).toHaveBeenCalledWith(repo, "claws/investigate-1-ab12", "triage-kwyjibo-errors", expect.any(Function));
      // Should have fetched debug data (3 API calls)
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://kwyjibo.vercel.app/api/games/abcdef01-2345-6789-abcd-ef0123456789/debug-logs",
        { headers: { "x-api-key": "test-api-key" } },
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        expect.stringContaining("## Bug Investigation Report"),
      );
      expect(mockDb.recordTaskStart).toHaveBeenCalledWith("triage-kwyjibo-errors", repo.fullName, issue.number, null);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("skips issues without game ID", async () => {
      const issue = mockIssue({
        body: "Something is wrong with the game but no ID provided",
      });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

      await run([repo]);

      // No game ID means the issue is skipped entirely
      expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("skips issues that already have an investigation report", async () => {
      const issue = mockIssue({
        body: "Game abcdef01-2345-6789-abcd-ef0123456789 broken",
      });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValueOnce([
        { id: 1, body: "## Bug Investigation Report\n\nSome previous report", login: "claws-bot" },
      ]);

      await run([repo]);

      expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
      expect(mockGh.populateQueueCache).toHaveBeenCalledWith(
        "needs-refinement", repo.fullName,
        expect.objectContaining({ number: issue.number }),
      );
    });

    it("populates queue cache for issues needing triage", async () => {
      const issue = mockIssue({
        body: "Game abcdef01-2345-6789-abcd-ef0123456789 broken",
      });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValueOnce([]);

      await run([repo]);

      expect(mockGh.populateQueueCache).toHaveBeenCalledWith(
        "needs-triage", repo.fullName,
        expect.objectContaining({ number: issue.number }),
      );
    });

    it("debug API failures — investigation proceeds with available data", async () => {
      const issue = mockIssue({
        body: "Game abcdef01-2345-6789-abcd-ef0123456789 broken",
      });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValueOnce([]);
      mockFetch.mockRejectedValue(new Error("network error"));

      await run([repo]);

      // Should still complete despite fetch failures
      expect(mockGh.commentOnIssue).toHaveBeenCalled();
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("empty Claude output — logs warning, no comment posted", async () => {
      const issue = mockIssue({
        body: "Game abcdef01-2345-6789-abcd-ef0123456789 broken",
      });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValueOnce([]);
      mockClaude.runClaude.mockResolvedValue("");

      await run([repo]);

      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("error handling — Claude throws, task recorded as failed, cleanup done", async () => {
      const issue = mockIssue({
        body: "Game abcdef01-2345-6789-abcd-ef0123456789 broken",
      });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValueOnce([]);
      mockClaude.runClaude.mockRejectedValue(new Error("claude error"));

      await run([repo]);

      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude error"), expect.any(Object));
      expect(reportError).toHaveBeenCalled();
    });

    it("calls handleTimeoutIfApplicable on error", async () => {
      const issue = mockIssue({
        body: "Game abcdef01-2345-6789-abcd-ef0123456789 broken",
      });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValueOnce([]);
      const err = new Error("timeout");
      mockClaude.runClaude.mockRejectedValue(err);

      await run([repo]);

      expect(mockHandleTimeoutIfApplicable).toHaveBeenCalledWith(
        "triage-kwyjibo-errors", repo.fullName, issue.number, err,
      );
    });

    it("uses classifyComplexity to pick model for investigation", async () => {
      const issue = mockIssue({
        body: "Game abcdef01-2345-6789-abcd-ef0123456789 is stuck",
      });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValueOnce([]);
      mockClassifyComplexity.mockResolvedValueOnce("opus");

      await run([repo]);

      expect(mockClassifyComplexity).toHaveBeenCalledWith(
        expect.stringContaining("Bug investigation"),
        "/tmp/worktree",
      );
      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String),
        "/tmp/worktree",
        expect.objectContaining({ model: "opus" }),
      );
    });

    it("debugging guide not found — proceeds without it", async () => {
      const issue = mockIssue({
        body: "Game abcdef01-2345-6789-abcd-ef0123456789 broken",
      });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValueOnce([]);
      mockFs.existsSync.mockReturnValue(false);

      await run([repo]);

      expect(mockGh.commentOnIssue).toHaveBeenCalled();
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("debug-logs HTTP 401 error is recorded in debugLogsFetchError", async () => {
      const issue = mockIssue({
        body: "Game abcdef01-2345-6789-abcd-ef0123456789 is stuck",
      });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValueOnce([]);
      // debug-logs returns 401, turns and pg_net succeed
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 401, text: () => Promise.resolve("") })
        .mockResolvedValue({ ok: true, text: () => Promise.resolve("[]") });

      await run([repo]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Failed to retrieve debug logs: HTTP 401");
    });

    it("debug-logs HTTP error is surfaced in prompt", () => {
      const issue = mockIssue({ body: "Game is stuck" });
      const debugData = {
        debugLogs: null,
        debugLogsFetchError: "HTTP 500",
        turns: null,
        pgNetErrors: null,
        pgNetErrorsFetchError: null,
      };
      const prompt = buildInvestigationPrompt("test-org/test-repo", issue, debugData, null);

      expect(prompt).toContain("Failed to retrieve debug logs: HTTP 500");
    });

    it("multiple issues — error on one does not stop others", async () => {
      const issue1 = mockIssue({ number: 1, body: "Game abcdef01-2345-6789-abcd-ef0123456789 broken" });
      const issue2 = mockIssue({ number: 2, body: "Game 12345678-1234-1234-1234-123456789abc broken" });

      mockGh.listOpenIssues.mockResolvedValueOnce([issue1, issue2]);

      mockGh.getIssueComments.mockResolvedValue([]);

      // First issue fails, second succeeds
      mockClaude.runClaude
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce("investigation for issue 2");

      await run([repo]);

      expect(mockClaude.withNewWorktree).toHaveBeenCalledTimes(2);
      expect(mockDb.recordTaskFailed).toHaveBeenCalledTimes(1);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledTimes(1);
    });

    it("includes image context in prompt when images are found", async () => {
      const issue = mockIssue({
        body: "Game abcdef01-2345-6789-abcd-ef0123456789 broken ![error](https://example.com/error.png)",
      });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValueOnce([]);
      mockProcessTextForImages.mockResolvedValueOnce("\n## Attached Images\n- .claws-images/img-1.png");

      await run([repo]);

      expect(mockProcessTextForImages).toHaveBeenCalledWith([issue.body], "/tmp/worktree", "test-org", { issueNumber: issue.number, repo: repo.fullName }, expect.any(Array));
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("## Attached Images");
    });
  });
});
