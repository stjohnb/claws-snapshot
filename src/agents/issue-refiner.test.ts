// All external dependencies — Claude, GitHub, and the database — are mocked via vi.mock().
// No real Claude calls are made; runClaude returns hardcoded strings so the tests verify
// the orchestration logic (prompt construction, marker parsing, GitHub interactions) in
// isolation from the actual model.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockIssue } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    clawsIgnore: "Claws Ignore",
    duplicate: "Duplicate",
    planFable: "Plan: Fable",
  },
  SELF_REPO: "test-org/test-repo",
  NAMEY_DB_URL: "",
  HOME_ASSISTANT_BASE_URL: "",
  HOME_ASSISTANT_TOKEN: "",
}));
vi.mock("../model-selector.js", () => ({ getModel: (tier: string = "sonnet") => tier, getReviewModel: (tier: string = "sonnet") => tier, getFallbackOrder: () => ["opencode"] }));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../timeout-handler.js", () => ({
  handleTimeoutIfApplicable: vi.fn().mockResolvedValue(undefined),
  getItemTimeoutMs: vi.fn().mockReturnValue(undefined),
}));

const { mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockGh: {
    getCommentReactions: vi.fn(),
    addReaction: vi.fn(),
    getIssueComments: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    commentOnIssue: vi.fn(),
    editIssueComment: vi.fn(),
    isClawsComment: (body: string) => /\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/.test(body) || body.includes("<!-- claws-automated -->"),
    stripClawsMarker: (body: string) => body.replace("<!-- claws-automated -->", "").replace("*— Automated by Claws —*", "").trim(),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    isAllowedActor: vi.fn().mockResolvedValue(true),
    getSelfLogin: vi.fn().mockResolvedValue("claws-bot"),
    getIssueBodyHtml: vi.fn().mockResolvedValue(""),
    listOpenIssues: vi.fn().mockResolvedValue([]),
    isItemSkipped: vi.fn().mockReturnValue(false),
  },
  mockClaude: {
    withNewWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
    writeClawsMcpConfig: vi.fn().mockReturnValue("/tmp/mock-mcp-config.json"),
    readRepoAgentDoc: vi.fn().mockReturnValue(undefined),
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

import {
  processIssue,
  processRefinement,
  processFollowUp,
  findUnreactedHumanComments,
  isCiUnrelatedIssue,
  parseDuplicateOf,
  stripDuplicateMarker,
  FABLE_MODEL,
} from "./issue-refiner.js";

describe("issue-refiner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaude.withNewWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockImplementation(async () => "## Plan\nDo the thing");
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockGh.addReaction.mockResolvedValue(undefined);
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockGh.editIssueComment.mockResolvedValue(undefined);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.isItemSkipped.mockReturnValue(false);
  });

  describe("processIssue", () => {
    it("happy path — new plan", async () => {
      const issue = mockIssue({ body: "Test issue body" });

      await processIssue(repo, issue);

      expect(mockClaude.withNewWorktree).toHaveBeenCalledWith(repo, "claws/plan-1-ab12", "issue-refiner", expect.any(Function));
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        expect.stringContaining("## Implementation Plan"),
        { agentName: "Planner" },
      );
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockDb.recordTaskStart).toHaveBeenCalledWith("issue-refiner", repo.fullName, issue.number, null);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
      expect(mockClaude.withNewWorktree).toHaveBeenCalled();
    });

    it("includes issue comments in fresh plan prompt", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 901, body: "## Claws Error Investigation Report\n\nRoot cause: missing null check", body_html: "", login: "claws-bot" },
      ]);

      await processIssue(repo, issue);

      // calls[0] is the main plan prompt
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Claws Error Investigation Report");
      expect(prompt).toContain("Root cause: missing null check");
    });

    it("empty output — logs warning but still adds Ready label", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude.mockResolvedValue("");

      await processIssue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("error handling — records task as failed and throws", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude.mockRejectedValue(new Error("claude error"));

      await expect(processIssue(repo, issue)).rejects.toThrow("claude error");

      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude error"), expect.any(Object));
      expect(mockClaude.withNewWorktree).toHaveBeenCalled();
    });

    it("processes issues with no body", async () => {
      const issue = mockIssue({ body: "" });

      await processIssue(repo, issue);

      expect(mockClaude.withNewWorktree).toHaveBeenCalled();
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        expect.stringContaining("## Implementation Plan"),
        { agentName: "Planner" },
      );
      // calls[0] is the main plan prompt
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("(No description provided)");
    });

    it("ci-unrelated issue — auto-adds Refined label after first plan", async () => {
      const issue = mockIssue({
        title: "[ci-unrelated] CI failures unrelated to PR changes",
        body: "CI failures detected",
      });

      await processIssue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Refined");
    });

    it("regular issue — does not auto-add Refined label", async () => {
      const issue = mockIssue({ body: "Test issue body" });

      await processIssue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Refined");
    });

    it("includes model selection instructions in prompt", async () => {
      const issue = mockIssue({ body: "Test issue body" });

      await processIssue(repo, issue);

      // calls[0] is the main plan prompt
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("**Recommended implementation model:**");
      expect(prompt).toMatch(/gh issue view|gh pr view/);
      expect(prompt).toContain("references other GitHub issues or PRs");
    });

    it("includes review model instructions in prompt", async () => {
      const issue = mockIssue({ body: "Test issue body" });

      await processIssue(repo, issue);

      // calls[0] is the main plan prompt
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("**Recommended review model:**");
    });

    it("includes image context in prompt when images are found", async () => {
      const issue = mockIssue({
        body: "Add this: ![design](https://example.com/design.png)",
      });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1001, body: "Comment with ![img](https://example.com/img2.png)", body_html: "", login: "commenter" },
      ]);
      mockProcessTextForImages.mockResolvedValueOnce("\n## Attached Images\n- .claws-images/img-1.png");

      await processIssue(repo, issue);

      expect(mockProcessTextForImages).toHaveBeenCalledWith(
        [issue.body, "Comment with ![img](https://example.com/img2.png)"],
        "/tmp/worktree",
        "test-org",
        { agentName: "Planner", issueNumber: issue.number, repo: repo.fullName },
        expect.any(Array),
      );
      // calls[0] is the main plan prompt
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("## Attached Images");
    });

    it("always uses opus model regardless of issue content", async () => {
      const issue = mockIssue({ body: "Test issue body" });

      await processIssue(repo, issue);

      expect(mockDb.updateTaskModel).toHaveBeenCalledWith(1, "opus");
    });

    it("uses Fable 5 when the issue has the Plan: Fable label", async () => {
      const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Plan: Fable" }] });
      await processIssue(repo, issue);
      expect(mockDb.updateTaskModel).toHaveBeenCalledWith(1, FABLE_MODEL);
    });
  });

  describe("processRefinement", () => {
    it("edits existing plan comment in-place", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please also handle edge case X", body_html: "", login: "reviewer" };

      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockProcessTextForImages).toHaveBeenCalledWith(
        [issue.body],
        "/tmp/worktree",
        "test-org",
        { agentName: "Planner", issueNumber: issue.number, repo: repo.fullName },
        expect.any(Array),
      );
      expect(mockGh.editIssueComment).toHaveBeenCalledWith(
        repo.fullName,
        501,
        expect.stringContaining("## Implementation Plan"),
        { agentName: "Planner" },
      );
      expect(mockGh.addReaction).toHaveBeenCalledWith(repo.fullName, 502, "+1");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("includes model selection instructions in refinement prompt", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      // calls[0] is the main refinement prompt
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("**Recommended implementation model:**");
      expect(prompt).toMatch(/gh issue view|gh pr view/);
      expect(prompt).toContain("references other GitHub issues or PRs");
    });

    it("includes review model instructions in refinement prompt", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      // calls[0] is the main refinement prompt
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("**Recommended review model:**");
    });

    it("extracts ### Response and posts as separate comment", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "What about edge case X?", body_html: "", login: "reviewer" };

      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockClaude.runClaude.mockResolvedValue(
        "Updated plan content\n\n### Response\nGreat question! Edge case X is handled by the null check on line 42.",
      );

      await processRefinement(repo, issue, [humanComment]);

      expect(mockGh.editIssueComment).toHaveBeenCalledWith(
        repo.fullName,
        501,
        "## Implementation Plan\n\nUpdated plan content\n\n*Models used: opus (provider: claude)*",
        { agentName: "Planner" },
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        "Great question! Edge case X is handled by the null check on line 42.",
        { agentName: "Planner" },
      );
    });

    it("skips empty ### Response section", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Looks good, just minor formatting", body_html: "", login: "reviewer" };

      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockClaude.runClaude.mockResolvedValue("Updated plan content\n\n### Response\n  \n");

      await processRefinement(repo, issue, [humanComment]);

      expect(mockGh.editIssueComment).toHaveBeenCalledWith(
        repo.fullName,
        501,
        "## Implementation Plan\n\nUpdated plan content\n\n*Models used: opus (provider: claude)*",
        { agentName: "Planner" },
      );
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("fallback — no plan comment found, posts fresh comment", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const humanComment = { id: 602, body: "Just a random comment", body_html: "", login: "someone" };

      // No plan comment in the list (simulating it was deleted)
      mockGh.getIssueComments.mockResolvedValue([humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockProcessTextForImages).toHaveBeenCalledWith(
        [issue.body, "Just a random comment"],
        "/tmp/worktree",
        "test-org",
        { agentName: "Planner", issueNumber: issue.number, repo: repo.fullName },
        expect.any(Array),
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        expect.stringContaining("## Implementation Plan"),
        { agentName: "Planner" },
      );
      expect(mockGh.editIssueComment).not.toHaveBeenCalled();
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("always uses opus model regardless of issue content", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockDb.updateTaskModel).toHaveBeenCalledWith(1, "opus");
    });

    it("uses Fable 5 when the issue has the Plan: Fable label", async () => {
      const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Plan: Fable" }] });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please re-plan with Fable", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockDb.updateTaskModel).toHaveBeenCalledWith(1, FABLE_MODEL);
    });
  });

  describe("processFollowUp", () => {
    it("responds to follow-up comments when issue has open PR", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Is everything healthy again?", body_html: "", login: "stjohnb" };

      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockClaude.runClaude.mockResolvedValue("Yes, everything looks healthy now.");

      await processFollowUp(repo, issue, 5, [humanComment]);

      expect(mockProcessTextForImages).toHaveBeenCalledWith(
        [issue.body],
        "/tmp/worktree",
        "test-org",
        { agentName: "Planner", issueNumber: issue.number, repo: repo.fullName },
        expect.any(Array),
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        "Yes, everything looks healthy now.",
        { agentName: "Planner" },
      );
      expect(mockGh.editIssueComment).not.toHaveBeenCalled();
      expect(mockGh.addReaction).toHaveBeenCalledWith(repo.fullName, 502, "+1");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });
  });

  describe("findUnreactedHumanComments", () => {
    it("returns comments without self reactions", async () => {
      const comments = [
        { id: 1, body: "Fix this please", body_html: "", login: "reviewer" },
        { id: 2, body: "Also this", body_html: "", login: "reviewer2" },
      ];
      mockGh.getCommentReactions.mockResolvedValue([]);

      const result = await findUnreactedHumanComments(repo.fullName, comments, "claws-bot[bot]");

      expect(result).toHaveLength(2);
    });

    it("excludes comments already reacted to by self", async () => {
      const comments = [
        { id: 1, body: "Fix this please", body_html: "", login: "reviewer" },
      ];
      mockGh.getCommentReactions.mockResolvedValue([
        { user: { login: "claws-bot[bot]" }, content: "+1" },
      ]);

      const result = await findUnreactedHumanComments(repo.fullName, comments, "claws-bot[bot]");

      expect(result).toHaveLength(0);
    });

    it("excludes Claws automated comments", async () => {
      const comments = [
        { id: 1, body: "*— Automated by Claws —*\n\nAutomated comment", body_html: "", login: "claws-bot" },
        { id: 2, body: "Human comment", body_html: "", login: "reviewer" },
      ];
      mockGh.getCommentReactions.mockResolvedValue([]);

      const result = await findUnreactedHumanComments(repo.fullName, comments, "claws-bot[bot]");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(2);
    });

    it("excludes bot comments", async () => {
      const comments = [
        { id: 1, body: "Bot comment", body_html: "", login: "dependabot[bot]" },
        { id: 2, body: "Human comment", body_html: "", login: "reviewer" },
      ];
      mockGh.getCommentReactions.mockResolvedValue([]);

      const result = await findUnreactedHumanComments(repo.fullName, comments, "claws-bot[bot]");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(2);
    });

    it("excludes comments from non-allowed actors", async () => {
      const comments = [
        { id: 1, body: "Random person's comment", body_html: "", login: "stranger" },
        { id: 2, body: "Allowed reviewer comment", body_html: "", login: "reviewer" },
      ];
      mockGh.isAllowedActor
        .mockResolvedValueOnce(false) // stranger
        .mockResolvedValueOnce(true); // reviewer
      mockGh.getCommentReactions.mockResolvedValue([]);

      const result = await findUnreactedHumanComments(repo.fullName, comments, "claws-bot[bot]");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(2);
    });
  });

  describe("isCiUnrelatedIssue", () => {
    it("returns true for ci-unrelated issues", () => {
      const issue = mockIssue({ title: "[ci-unrelated] CI failures unrelated to PR changes" });
      expect(isCiUnrelatedIssue(issue)).toBe(true);
    });

    it("returns false for regular issues", () => {
      const issue = mockIssue({ title: "Fix authentication bug" });
      expect(isCiUnrelatedIssue(issue)).toBe(false);
    });
  });

  describe("parseDuplicateOf", () => {
    it("returns the issue number when marker is present and allowed", () => {
      expect(parseDuplicateOf("some plan\n\nDUPLICATE_OF: #458", [458, 459])).toBe(458);
    });

    it("returns null for 'none'", () => {
      expect(parseDuplicateOf("plan\nDUPLICATE_OF: none", [458])).toBeNull();
    });

    it("returns null when marker missing", () => {
      expect(parseDuplicateOf("plan without marker", [458])).toBeNull();
    });

    it("returns null when number not in allowedNumbers (hallucination guard)", () => {
      expect(parseDuplicateOf("DUPLICATE_OF: #999", [458, 459])).toBeNull();
    });

    it("tolerates missing # prefix", () => {
      expect(parseDuplicateOf("DUPLICATE_OF: 458", [458])).toBe(458);
    });

    it("uses last occurrence when multiple markers present", () => {
      expect(parseDuplicateOf("DUPLICATE_OF: #458\nsome text\nDUPLICATE_OF: none", [458])).toBeNull();
      expect(parseDuplicateOf("DUPLICATE_OF: none\nsome text\nDUPLICATE_OF: #458", [458])).toBe(458);
    });
  });

  describe("stripDuplicateMarker", () => {
    it("removes DUPLICATE_OF line from output", () => {
      expect(stripDuplicateMarker("## Plan\nDo work\n\nDUPLICATE_OF: none")).toBe("## Plan\nDo work");
    });

    it("returns unchanged output when no marker present", () => {
      expect(stripDuplicateMarker("## Plan\nDo work")).toBe("## Plan\nDo work");
    });

    it("removes all DUPLICATE_OF lines when multiple are present", () => {
      expect(
        stripDuplicateMarker("## Plan\nDUPLICATE_OF: #458\nmore text\nDUPLICATE_OF: none")
      ).toBe("## Plan\nmore text");
    });
  });

  describe("processIssue — duplicate detection", () => {
    it("posts a minimal 'See #N' plan when Claude marks as duplicate", async () => {
      const current = mockIssue({ number: 459, title: "[k3s] CrashLoopBackOff: ns/foo" });
      const canonical = mockIssue({ number: 458, title: "[k3s] CrashLoopBackOff: ns/bar", body: "..." });
      mockGh.listOpenIssues.mockResolvedValue([current, canonical]);
      mockClaude.runClaude.mockImplementation(async (prompt: string) => {
        if (prompt.includes('Respond with ONLY one word')) return "sonnet";
        return "## Plan\nSee the canonical\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`\nDUPLICATE_OF: #458";
      });

      await processIssue(repo, current);

      const calls = mockGh.commentOnIssue.mock.calls;
      const planCall = calls.find((c: unknown[]) => c[1] === 459);
      expect(planCall).toBeDefined();
      expect(planCall![2]).toContain("## Implementation Plan");
      expect(planCall![2]).toContain("#458");
      expect(planCall![2]).toContain("CLAWS_DUPLICATE_OF: #458");
      expect(planCall![2]).not.toMatch(/\nDUPLICATE_OF:/);
      const backrefCall = calls.find((c: unknown[]) => c[1] === 458);
      expect(backrefCall).toBeDefined();
      expect(backrefCall![2]).toContain("#459");
      expect(mockGh.addLabel).toHaveBeenCalledWith("test-org/test-repo", 459, "Duplicate");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith("test-org/test-repo", 458, "Duplicate");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith("test-org/test-repo", 459, "Ready");
    });

    it("posts a normal plan when no duplicate is identified", async () => {
      const current = mockIssue({ number: 459 });
      const sibling = mockIssue({ number: 458 });
      mockGh.listOpenIssues.mockResolvedValue([current, sibling]);
      mockClaude.runClaude.mockImplementation(async (prompt: string) => {
        if (prompt.includes('Respond with ONLY one word')) return "sonnet";
        return "## Plan\nDo work\n\nDUPLICATE_OF: none";
      });

      await processIssue(repo, current);

      const planCall = mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => c[1] === 459);
      expect(planCall![2]).toContain("Do work");
      expect(planCall![2]).not.toContain("DUPLICATE_OF");
      expect(mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => c[1] === 458)).toBeUndefined();
      expect(mockGh.addLabel).not.toHaveBeenCalledWith("test-org/test-repo", 459, "Duplicate");
    });

    it("ignores DUPLICATE_OF of a higher-numbered issue (not in candidates)", async () => {
      const current = mockIssue({ number: 458 });
      const sibling = mockIssue({ number: 459 });
      mockGh.listOpenIssues.mockResolvedValue([current, sibling]);
      mockClaude.runClaude.mockImplementation(async (prompt: string) => {
        if (prompt.includes('Respond with ONLY one word')) return "sonnet";
        return "## Plan\nx\nDUPLICATE_OF: #459";
      });

      await processIssue(repo, current);

      const planCall = mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => c[1] === 458);
      expect(planCall).toBeDefined();
      expect(planCall![2]).not.toContain("duplicate");
      expect(mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => c[1] === 459)).toBeUndefined();
    });

    it("handles duplicate marker with no surrounding text (cleanedOutput is empty)", async () => {
      const current = mockIssue({ number: 459 });
      const canonical = mockIssue({ number: 458 });
      mockGh.listOpenIssues.mockResolvedValue([current, canonical]);
      mockClaude.runClaude.mockImplementation(async (prompt: string) => {
        if (prompt.includes('Respond with ONLY one word')) return "sonnet";
        return "DUPLICATE_OF: #458";
      });

      await processIssue(repo, current);

      const calls = mockGh.commentOnIssue.mock.calls;
      const planCall = calls.find((c: unknown[]) => c[1] === 459);
      expect(planCall).toBeDefined();
      expect(planCall![2]).toContain("#458");
      expect(planCall![2]).toContain("CLAWS_DUPLICATE_OF: #458");
      expect(planCall![2]).not.toMatch(/\nDUPLICATE_OF:/);
      const backrefCall = calls.find((c: unknown[]) => c[1] === 458);
      expect(backrefCall).toBeDefined();
      expect(mockGh.addLabel).toHaveBeenCalledWith("test-org/test-repo", 459, "Duplicate");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith("test-org/test-repo", 459, "Ready");
    });

    it("excludes clawsIgnore-labelled issues from candidates", async () => {
      const current = mockIssue({ number: 460 });
      const ignored = mockIssue({ number: 458, labels: [{ name: "Claws Ignore" }] });
      const valid = mockIssue({ number: 459 });
      mockGh.listOpenIssues.mockResolvedValue([current, ignored, valid]);
      mockClaude.runClaude.mockImplementation(async (prompt: string) => {
        if (prompt.includes("Respond with ONLY one word")) return "sonnet";
        expect(prompt).not.toContain("#458:");
        return "## Plan\nDo work\n\nDUPLICATE_OF: none";
      });

      await processIssue(repo, current);
    });

    it("excludes isItemSkipped issues from candidates", async () => {
      const current = mockIssue({ number: 460 });
      const skipped = mockIssue({ number: 458 });
      const valid = mockIssue({ number: 459 });
      mockGh.listOpenIssues.mockResolvedValue([current, skipped, valid]);
      mockGh.isItemSkipped.mockImplementation((_repo: string, n: number) => n === 458);
      mockClaude.runClaude.mockImplementation(async (prompt: string) => {
        if (prompt.includes("Respond with ONLY one word")) return "sonnet";
        expect(prompt).not.toContain("#458:");
        expect(prompt).toContain("#459:");
        return "## Plan\nDo work\n\nDUPLICATE_OF: none";
      });

      await processIssue(repo, current);
      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    });

    it("still posts plan if canonical back-reference fails", async () => {
      const current = mockIssue({ number: 459 });
      const canonical = mockIssue({ number: 458 });
      mockGh.listOpenIssues.mockResolvedValue([current, canonical]);
      mockClaude.runClaude.mockImplementation(async (prompt: string) => {
        if (prompt.includes('Respond with ONLY one word')) return "sonnet";
        return "## Plan\nx\nDUPLICATE_OF: #458";
      });
      mockGh.commentOnIssue.mockImplementation(async (_r: string, num: number) => {
        if (num === 458) throw new Error("gh failed");
      });

      await expect(processIssue(repo, current)).resolves.not.toThrow();
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith("test-org/test-repo", 459, expect.stringContaining("#458"), expect.any(Object));
    });
  });

  describe("planner prompt does not include prod-data context", () => {
    it("buildNewPlanPrompt via processIssue — excludes kubectl/namey/HA, keeps runner policy", async () => {
      const issue = mockIssue({ body: "Add a new feature" });
      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).not.toMatch(/kubectl/i);
      expect(prompt).not.toMatch(/namey_query/i);
      expect(prompt).not.toMatch(/Home Assistant/i);
      expect(prompt).toContain("self-hosted runners");
    });

    it("writeClawsMcpConfig called with includeNameyDb: false", async () => {
      const issue = mockIssue({ body: "Some issue" });
      await processIssue(repo, issue);

      expect(mockClaude.writeClawsMcpConfig).toHaveBeenCalledWith(
        expect.any(String),
        { includeNameyDb: false },
      );
    });

    it("processRefinement — writeClawsMcpConfig called with includeNameyDb: false", async () => {
      const issue = mockIssue({ body: "Some issue" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockClaude.writeClawsMcpConfig).toHaveBeenCalledWith(
        expect.any(String),
        { includeNameyDb: false },
      );
    });

    it("processFollowUp — writeClawsMcpConfig called with includeNameyDb: false", async () => {
      const issue = mockIssue({ body: "Some issue" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Is everything healthy again?", body_html: "", login: "stjohnb" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockClaude.runClaude.mockResolvedValue("Yes, everything looks healthy now.");

      await processFollowUp(repo, issue, 5, [humanComment]);

      expect(mockClaude.writeClawsMcpConfig).toHaveBeenCalledWith(
        expect.any(String),
        { includeNameyDb: false },
      );
    });

    it("buildNewPlanPrompt via processIssue — prompt includes external URL fetch instruction", async () => {
      const issue = mockIssue({ body: "Add a new feature" });
      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("use the WebFetch tool to retrieve their");
      expect(prompt).toContain("Use the WebSearch tool when you need to research");
      expect(prompt).toContain("gh run view");
      expect(prompt).toContain("ONE diagnosed root cause");
    });

    it("buildRefinementPrompt via processRefinement — prompt includes external URL fetch instruction", async () => {
      const issue = mockIssue({ body: "Fix a bug" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please also handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("use the WebFetch tool to retrieve their");
      expect(prompt).toContain("Use the WebSearch tool when you need to research");
      expect(prompt).toContain("gh run view");
      expect(prompt).toContain("ONE diagnosed root cause");
    });

    it("buildFollowUpPrompt via processFollowUp — prompt includes external URL fetch instruction", async () => {
      const issue = mockIssue({ body: "Fix a bug" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Is everything healthy again?", body_html: "", login: "stjohnb" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockClaude.runClaude.mockResolvedValue("Yes, everything looks healthy now.");

      await processFollowUp(repo, issue, 5, [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("use the WebFetch tool to retrieve their");
      expect(prompt).toContain("Use the WebSearch tool when you need to research");
      expect(prompt).toContain("gh run view");
      expect(prompt).toContain("ONE diagnosed root cause");
    });
  });
});
