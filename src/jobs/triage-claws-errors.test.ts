import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockIssue } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  SELF_REPO: "test-org/test-repo",
}));
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
    populateQueueCache: vi.fn(),
    commentOnIssue: vi.fn(),
    closeIssue: vi.fn(),
    getIssueBody: vi.fn(),
    getIssueComments: vi.fn(),
    editIssueComment: vi.fn(),
    isItemSkipped: vi.fn().mockReturnValue(false),
    isAllowedActor: vi.fn().mockResolvedValue(true),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    hasIgnoreLabel: vi.fn().mockReturnValue(false),
  },
  mockClaude: {
    withNewWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
    writeClawsMcpConfig: vi.fn().mockReturnValue("/tmp/mock-mcp-config.json"),
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

import {
  run,
  parseClawsError,
  extractFingerprint,
  buildInvestigationPrompt,
  parseRelatedIssues,
  isReportTruncated,
  deduplicateByFingerprint,
  deduplicateByInvestigation,
} from "./triage-claws-errors.js";
import { reportError } from "../error-reporter.js";

const ERROR_BODY = [
  "**Auto-created by Claws error reporter**",
  "",
  "**Fingerprint:** `kwyjibo-bug-investigator:list-issues`",
  "**Context:** test-org/test-repo",
  "**Timestamp:** 2025-01-15T10:30:00.000Z",
  "",
  "```",
  "Error: gh issue list failed: 502",
  "    at listIssues (src/github.ts:120:5)",
  "```",
].join("\n");

describe("triage-claws-errors", () => {
  const selfRepo = mockRepo({ fullName: "test-org/test-repo" });

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaude.withNewWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue("Root cause: transient 502\n\nRELATED_ISSUES: none");
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.populateQueueCache.mockReturnValue(undefined);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockGh.closeIssue.mockResolvedValue(undefined);
    mockGh.getIssueBody.mockResolvedValue(ERROR_BODY);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.editIssueComment.mockResolvedValue(undefined);
  });

  describe("parseClawsError", () => {
    it("extracts all fields from well-formed body", () => {
      const result = parseClawsError(ERROR_BODY);
      expect(result.fingerprint).toBe("kwyjibo-bug-investigator:list-issues");
      expect(result.context).toBe("test-org/test-repo");
      expect(result.timestamp).toBe("2025-01-15T10:30:00.000Z");
      expect(result.errorText).toContain("Error: gh issue list failed: 502");
    });

    it("handles missing fields", () => {
      const result = parseClawsError("No structured content here");
      expect(result.fingerprint).toBe("");
      expect(result.context).toBe("");
      expect(result.timestamp).toBe("");
      expect(result.errorText).toBe("");
    });

    it("handles body with multiple code blocks", () => {
      const body = [
        "**Fingerprint:** `test:fp`",
        "**Context:** ctx",
        "**Timestamp:** 2025-01-01T00:00:00Z",
        "",
        "```",
        "first error block",
        "```",
        "",
        "```",
        "second block",
        "```",
      ].join("\n");
      const result = parseClawsError(body);
      expect(result.errorText).toBe("first error block");
    });
  });

  describe("extractFingerprint", () => {
    it("extracts fingerprint from [claws-error] title", () => {
      expect(extractFingerprint("[claws-error] kwyjibo-bug-investigator:list-issues"))
        .toBe("kwyjibo-bug-investigator:list-issues");
    });

    it("returns null for titles without the prefix", () => {
      expect(extractFingerprint("Some other issue title")).toBeNull();
    });

    it("handles whitespace variations", () => {
      expect(extractFingerprint("[claws-error]  some:fingerprint"))
        .toBe("some:fingerprint");
    });
  });

  describe("deduplicateByFingerprint", () => {
    it("returns all issues when each has unique fingerprint", async () => {
      const issues = [
        mockIssue({ number: 1, title: "[claws-error] fp-a" }),
        mockIssue({ number: 2, title: "[claws-error] fp-b" }),
      ];
      mockGh.listOpenIssues.mockResolvedValue(issues);

      const result = await deduplicateByFingerprint("test-org/test-repo", issues);
      expect(result).toHaveLength(2);
      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    it("closes higher-numbered duplicate, keeps lower-numbered", async () => {
      const issues = [
        mockIssue({ number: 5, title: "[claws-error] same-fp" }),
        mockIssue({ number: 3, title: "[claws-error] same-fp" }),
      ];
      mockGh.listOpenIssues.mockResolvedValue(issues);

      const result = await deduplicateByFingerprint("test-org/test-repo", issues);
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(3);
      expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 5, "not_planned");
    });

    it("only deduplicates within each fingerprint group", async () => {
      const issues = [
        mockIssue({ number: 1, title: "[claws-error] fp-a" }),
        mockIssue({ number: 2, title: "[claws-error] fp-a" }),
        mockIssue({ number: 3, title: "[claws-error] fp-b" }),
      ];
      mockGh.listOpenIssues.mockResolvedValue(issues);

      const result = await deduplicateByFingerprint("test-org/test-repo", issues);
      expect(result).toHaveLength(2);
      expect(result.map((i) => i.number).sort()).toEqual([1, 3]);
      expect(mockGh.closeIssue).toHaveBeenCalledTimes(1);
      expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 2, "not_planned");
    });

    it("closes issue when fingerprint matches existing Known Fingerprints", async () => {
      const newIssue = mockIssue({ number: 10, title: "[claws-error] known-fp" });
      const existingIssue = mockIssue({ number: 5, title: "[claws-error] other-fp" });

      // listOpenIssues returns both existing and new issues
      mockGh.listOpenIssues.mockResolvedValue([existingIssue, newIssue]);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 100, body: "### Known Fingerprints\n- `other-fp`\n- `known-fp`", login: "claws-bot" },
      ]);

      const result = await deduplicateByFingerprint("test-org/test-repo", [newIssue]);
      expect(result).toHaveLength(0);
      expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 10, "not_planned");
    });
  });

  describe("deduplicateByInvestigation", () => {
    it("closes related issues and adds fingerprints to canonical", async () => {
      const canonical = mockIssue({ number: 1, title: "[claws-error] fp-main" });
      const related = mockIssue({ number: 5, title: "[claws-error] fp-related" });

      mockGh.listOpenIssues.mockResolvedValue([related]);
      mockGh.getIssueComments.mockResolvedValue([]);

      await deduplicateByInvestigation("test-org/test-repo", canonical, [5]);

      expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 5, "not_planned");
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        "test-org/test-repo", 5,
        "Root cause identified as same as #1 during investigation. Closing as duplicate.",
      );
    });

    it("handles empty related issues list (no-op)", async () => {
      const canonical = mockIssue({ number: 1, title: "[claws-error] fp-main" });

      await deduplicateByInvestigation("test-org/test-repo", canonical, []);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    it("handles issues that are not found gracefully", async () => {
      const canonical = mockIssue({ number: 1, title: "[claws-error] fp-main" });
      mockGh.listOpenIssues.mockResolvedValue([]); // related issue not found

      await deduplicateByInvestigation("test-org/test-repo", canonical, [99]);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });
  });

  describe("buildInvestigationPrompt", () => {
    it("includes error details and verification instructions", () => {
      const issue = mockIssue({ number: 1, title: "[claws-error] test:fp", body: ERROR_BODY });
      const details = parseClawsError(ERROR_BODY);

      const prompt = buildInvestigationPrompt(issue, details, [], "owner/repo");

      expect(prompt).toContain("kwyjibo-bug-investigator:list-issues");
      expect(prompt).toContain("Error: gh issue list failed: 502");
      expect(prompt).toContain("docs/OVERVIEW.md");
      expect(prompt).toContain("Run verification commands");
    });

    it("includes other issues for cross-reference", () => {
      const issue = mockIssue({ number: 1, title: "[claws-error] test:fp", body: ERROR_BODY });
      const details = parseClawsError(ERROR_BODY);
      const other = mockIssue({ number: 5, title: "[claws-error] other:fp", body: "Other error" });

      const prompt = buildInvestigationPrompt(issue, details, [other], "owner/repo");

      expect(prompt).toContain("Other Open Error Issues");
      expect(prompt).toContain("#5");
      expect(prompt).toContain("other:fp");
    });

    it("maps fingerprint to source file path", () => {
      const issue = mockIssue({ number: 1, title: "[claws-error] kwyjibo-bug-investigator:list-issues", body: ERROR_BODY });
      const details = parseClawsError(ERROR_BODY);

      const prompt = buildInvestigationPrompt(issue, details, [], "owner/repo");

      expect(prompt).toContain("src/jobs/kwyjibo-bug-investigator.ts");
    });

    it("instructs reading docs/OVERVIEW.md and linked docs", () => {
      const issue = mockIssue({ number: 1, body: ERROR_BODY });
      const details = parseClawsError(ERROR_BODY);

      const prompt = buildInvestigationPrompt(issue, details, [], "owner/repo");

      expect(prompt).toContain("Read `docs/OVERVIEW.md` first");
      expect(prompt).toContain("follow and read any linked documents");
    });
  });

  describe("parseRelatedIssues", () => {
    it("parses RELATED_ISSUES line with numbers", () => {
      expect(parseRelatedIssues("Some report\n\nRELATED_ISSUES: 45, 67")).toEqual([45, 67]);
    });

    it("returns empty array for 'none'", () => {
      expect(parseRelatedIssues("Report\n\nRELATED_ISSUES: none")).toEqual([]);
    });

    it("returns empty array when line is missing", () => {
      expect(parseRelatedIssues("Report without the line")).toEqual([]);
    });

    it("handles single issue number", () => {
      expect(parseRelatedIssues("RELATED_ISSUES: 42")).toEqual([42]);
    });
  });

  describe("isReportTruncated", () => {
    it("returns false when RELATED_ISSUES has value 'none'", () => {
      expect(isReportTruncated("text\n\nRELATED_ISSUES: none")).toBe(false);
    });

    it("returns false when RELATED_ISSUES has issue numbers", () => {
      expect(isReportTruncated("text\n\nRELATED_ISSUES: 1, 2")).toBe(false);
    });

    it("returns true when RELATED_ISSUES marker is absent", () => {
      expect(isReportTruncated("text without marker")).toBe(true);
    });

    it("returns true when RELATED_ISSUES has no value", () => {
      expect(isReportTruncated("text\n\nRELATED_ISSUES:")).toBe(true);
    });

    it("returns true when RELATED_ISSUES has only whitespace", () => {
      expect(isReportTruncated("text\n\nRELATED_ISSUES:    ")).toBe(true);
    });
  });

  describe("run", () => {
    it("happy path — investigates and posts report", async () => {
      const issue = mockIssue({
        number: 10,
        title: "[claws-error] test:fp",
        body: ERROR_BODY,
      });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.getIssueComments.mockResolvedValue([]);

      await run([selfRepo]);

      expect(mockClaude.withNewWorktree).toHaveBeenCalledWith(selfRepo, "claws/investigate-error-10-ab12", "triage-claws-errors", expect.any(Function));
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        "test-org/test-repo",
        10,
        expect.stringContaining("## Claws Error Investigation Report"),
      );
      expect(mockDb.recordTaskStart).toHaveBeenCalledWith("triage-claws-errors", "test-org/test-repo", 10, null);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("phase 2 dedup — Claude identifies related issues, they get closed", async () => {
      const issue1 = mockIssue({
        number: 10,
        title: "[claws-error] fp-main",
        body: ERROR_BODY,
      });
      const issue2 = mockIssue({
        number: 15,
        title: "[claws-error] fp-related",
        body: ERROR_BODY,
      });

      // listOpenIssues returns both issues for initial listing and dedup calls
      mockGh.listOpenIssues
        .mockResolvedValueOnce([issue1, issue2])  // initial listing
        .mockResolvedValueOnce([issue1, issue2])  // deduplicateByFingerprint internal call
        .mockResolvedValueOnce([issue2]);          // deduplicateByInvestigation lookup

      mockGh.getIssueComments.mockResolvedValue([]);

      mockClaude.runClaude
        .mockResolvedValueOnce("Root cause found\n\nRELATED_ISSUES: 15")
        .mockResolvedValueOnce("Another report\n\nRELATED_ISSUES: none");

      await run([selfRepo]);

      // issue2 should be closed as duplicate by phase 2
      expect(mockGh.closeIssue).toHaveBeenCalledWith("test-org/test-repo", 15, "not_planned");
    });

    it("empty Claude output — logs warning", async () => {
      const issue = mockIssue({
        number: 10,
        title: "[claws-error] test:fp",
        body: ERROR_BODY,
      });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.getIssueComments.mockResolvedValue([]);
      mockClaude.runClaude.mockResolvedValue("");

      await run([selfRepo]);

      expect(mockGh.commentOnIssue).not.toHaveBeenCalledWith(
        "test-org/test-repo", 10, expect.stringContaining("Investigation Report"),
      );
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("Claude error — task marked failed, worktree cleaned up", async () => {
      const issue = mockIssue({
        number: 10,
        title: "[claws-error] test:fp",
        body: ERROR_BODY,
      });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.getIssueComments.mockResolvedValue([]);
      mockClaude.runClaude.mockRejectedValue(new Error("claude error"));

      await run([selfRepo]);

      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude error"), expect.any(Object));
      expect(reportError).toHaveBeenCalled();
    });

    it("calls handleTimeoutIfApplicable on error", async () => {
      const issue = mockIssue({
        number: 10,
        title: "[claws-error] test:fp",
        body: ERROR_BODY,
      });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.getIssueComments.mockResolvedValue([]);
      const err = new Error("timeout");
      mockClaude.runClaude.mockRejectedValue(err);

      await run([selfRepo]);

      expect(mockHandleTimeoutIfApplicable).toHaveBeenCalledWith(
        "triage-claws-errors", "test-org/test-repo", 10, err,
      );
    });

    it("SELF_REPO not in repos list — returns without processing", async () => {
      const otherRepo = mockRepo({ fullName: "other-org/other-repo" });

      await run([otherRepo]);

      expect(mockGh.listOpenIssues).not.toHaveBeenCalled();
      expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    });

    it("strips RELATED_ISSUES line from posted comment", async () => {
      const issue = mockIssue({
        number: 10,
        title: "[claws-error] test:fp",
        body: ERROR_BODY,
      });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.getIssueComments.mockResolvedValue([]);
      mockClaude.runClaude.mockResolvedValue("Investigation findings here\n\nRELATED_ISSUES: none");

      await run([selfRepo]);

      const commentCall = mockGh.commentOnIssue.mock.calls.find(
        (call: unknown[]) => (call[2] as string).includes("Investigation Report"),
      );
      expect(commentCall).toBeDefined();
      expect(commentCall![2]).not.toContain("RELATED_ISSUES");
    });

    it("skips issues that already have an investigation report", async () => {
      const issue = mockIssue({
        number: 10,
        title: "[claws-error] test:fp",
        body: ERROR_BODY,
      });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "## Claws Error Investigation Report\n\nPrevious report", login: "claws-bot" },
      ]);

      await run([selfRepo]);

      expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    });

    it("populates queue cache for uninvestigated issues", async () => {
      const issue = mockIssue({
        number: 10,
        title: "[claws-error] test:fp",
        body: ERROR_BODY,
      });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.getIssueComments.mockResolvedValue([]);

      await run([selfRepo]);

      expect(mockGh.populateQueueCache).toHaveBeenCalledWith(
        "needs-triage", "test-org/test-repo",
        expect.objectContaining({ number: 10 }),
      );
    });

    it("truncated output then succeeds on retry — posts report from retry", async () => {
      const issue = mockIssue({
        number: 10,
        title: "[claws-error] test:fp",
        body: ERROR_BODY,
      });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.getIssueComments.mockResolvedValue([]);
      mockClaude.runClaude
        .mockResolvedValueOnce("Partial output without marker")
        .mockResolvedValueOnce("Root cause: foo\n\nRELATED_ISSUES: none");

      await run([selfRepo]);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        "test-org/test-repo",
        10,
        expect.stringContaining("Root cause: foo"),
      );
      const commentBody = mockGh.commentOnIssue.mock.calls.find(
        (call: unknown[]) => (call[2] as string).includes("Root cause: foo"),
      )![2] as string;
      expect(commentBody).not.toContain("RELATED_ISSUES");
    });

    it("truncated twice — skips posting and records task complete", async () => {
      const issue = mockIssue({
        number: 10,
        title: "[claws-error] test:fp",
        body: ERROR_BODY,
      });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.getIssueComments.mockResolvedValue([]);
      mockClaude.runClaude.mockResolvedValue("Partial output without marker");

      await run([selfRepo]);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("uses classifyComplexity to pick model for investigation", async () => {
      const issue = mockIssue({
        number: 10,
        title: "[claws-error] test:fp",
        body: ERROR_BODY,
      });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.getIssueComments.mockResolvedValue([]);
      mockClassifyComplexity.mockResolvedValueOnce("opus");

      await run([selfRepo]);

      expect(mockClassifyComplexity).toHaveBeenCalledWith(
        expect.stringContaining("Claws internal error investigation"),
        "/tmp/worktree",
      );
      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String),
        "/tmp/worktree",
        expect.objectContaining({ model: "opus" }),
      );
    });

    it("skips issues from non-allowed actors", async () => {
      const issue = mockIssue({
        number: 10,
        title: "[claws-error] test:fp",
        body: ERROR_BODY,
        author: { login: "attacker" },
      });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.getIssueComments.mockResolvedValue([]);
      mockGh.isAllowedActor.mockResolvedValue(false);

      await run([selfRepo]);

      expect(mockGh.isAllowedActor).toHaveBeenCalledWith("attacker");
      expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    });
  });
});
