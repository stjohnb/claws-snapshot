import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockIssue } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  SELF_REPO: "test-org/test-repo",
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
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
    hasPriorityLabel: vi.fn().mockReturnValue(false),
  },
  mockClaude: {
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
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
    mockClaude.createWorktree.mockResolvedValue("/tmp/worktree");
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue("Root cause: transient 502\n\nRELATED_ISSUES: none");
    mockClaude.removeWorktree.mockResolvedValue(undefined);
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

      const prompt = buildInvestigationPrompt(issue, details, []);

      expect(prompt).toContain("kwyjibo-bug-investigator:list-issues");
      expect(prompt).toContain("Error: gh issue list failed: 502");
      expect(prompt).toContain("docs/OVERVIEW.md");
      expect(prompt).toContain("Run verification commands");
    });

    it("includes other issues for cross-reference", () => {
      const issue = mockIssue({ number: 1, title: "[claws-error] test:fp", body: ERROR_BODY });
      const details = parseClawsError(ERROR_BODY);
      const other = mockIssue({ number: 5, title: "[claws-error] other:fp", body: "Other error" });

      const prompt = buildInvestigationPrompt(issue, details, [other]);

      expect(prompt).toContain("Other Open Error Issues");
      expect(prompt).toContain("#5");
      expect(prompt).toContain("other:fp");
    });

    it("maps fingerprint to source file path", () => {
      const issue = mockIssue({ number: 1, title: "[claws-error] kwyjibo-bug-investigator:list-issues", body: ERROR_BODY });
      const details = parseClawsError(ERROR_BODY);

      const prompt = buildInvestigationPrompt(issue, details, []);

      expect(prompt).toContain("src/jobs/kwyjibo-bug-investigator.ts");
    });

    it("instructs reading docs/OVERVIEW.md and linked docs", () => {
      const issue = mockIssue({ number: 1, body: ERROR_BODY });
      const details = parseClawsError(ERROR_BODY);

      const prompt = buildInvestigationPrompt(issue, details, []);

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

      expect(mockClaude.createWorktree).toHaveBeenCalledWith(selfRepo, "claws/investigate-error-10-ab12", "triage-claws-errors");
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        "test-org/test-repo",
        10,
        expect.stringContaining("## Claws Error Investigation Report"),
      );
      expect(mockDb.recordTaskStart).toHaveBeenCalledWith("triage-claws-errors", "test-org/test-repo", 10, null);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
      expect(mockClaude.removeWorktree).toHaveBeenCalled();
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
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
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

      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude error"));
      expect(reportError).toHaveBeenCalled();
      expect(mockClaude.removeWorktree).toHaveBeenCalled();
    });

    it("SELF_REPO not in repos list — returns without processing", async () => {
      const otherRepo = mockRepo({ fullName: "other-org/other-repo" });

      await run([otherRepo]);

      expect(mockGh.listOpenIssues).not.toHaveBeenCalled();
      expect(mockClaude.createWorktree).not.toHaveBeenCalled();
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

      expect(mockClaude.createWorktree).not.toHaveBeenCalled();
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
  });
});
