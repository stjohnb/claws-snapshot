import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockIssue } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    inReview: "In Review",
  },
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../slack.js", () => ({
  notify: mockNotify,
}));

const { mockGh } = vi.hoisted(() => ({
  mockGh: {
    listOpenIssues: vi.fn(),
    getSelfLogin: vi.fn(),
    getOpenPRForIssue: vi.fn(),
    getCommentReactions: vi.fn(),
    getIssueComments: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    isClawsComment: (body: string) => body.includes("<!-- claws-automated -->"),
    isRateLimited: vi.fn().mockReturnValue(false),
    listMergedPRsForIssue: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGh);

vi.mock("./triage-kwyjibo-errors.js", () => ({
  extractGameId: vi.fn().mockReturnValue(null),
  REPORT_HEADER: "## Bug Investigation Report",
}));

vi.mock("./triage-claws-errors.js", () => ({
  extractFingerprint: vi.fn().mockReturnValue(null),
  REPORT_HEADER: "## Claws Error Investigation Report",
}));

const mockFindPlanComment = vi.hoisted(() => vi.fn());
const mockParsePlan = vi.hoisted(() => vi.fn());
vi.mock("../plan-parser.js", () => ({
  findPlanComment: mockFindPlanComment,
  parsePlan: mockParsePlan,
}));

import { run, classifyIssue } from "./issue-auditor.js";
import { reportError } from "../error-reporter.js";
import { extractGameId } from "./triage-kwyjibo-errors.js";
import { extractFingerprint } from "./triage-claws-errors.js";
import * as log from "../log.js";

describe("issue-auditor", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.getSelfLogin.mockResolvedValue("claws-bot[bot]");
    mockGh.getOpenPRForIssue.mockResolvedValue(null);
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);
    mockFindPlanComment.mockReturnValue(null);
    mockParsePlan.mockReturnValue({ preamble: "", phases: [], totalPhases: 0 });
    vi.mocked(extractGameId).mockReturnValue(null);
    vi.mocked(extractFingerprint).mockReturnValue(null);
  });

  it("skips issues with Refined label", async () => {
    const issue = mockIssue({ labels: [{ name: "Refined" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("adds In Review label for in-progress issues missing it", async () => {
    const issue = mockIssue();
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getOpenPRForIssue.mockResolvedValueOnce({ number: 10, headRefName: "claws/issue-1-ab12" });

    await run([repo]);

    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "In Review");
  });

  it("skips [claws-error] issues without investigation report", async () => {
    const issue = mockIssue({ title: "[claws-error] something" });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    vi.mocked(extractFingerprint).mockReturnValue("something");
    mockGh.getIssueComments.mockResolvedValue([]);

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("skips game-ID issues without investigation report", async () => {
    const issue = mockIssue({ body: "game id: 12345678-1234-1234-1234-123456789abc" });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    vi.mocked(extractGameId).mockReturnValue("12345678-1234-1234-1234-123456789abc");
    mockGh.getIssueComments.mockResolvedValue([]);

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("skips issues with no plan (needs refinement)", async () => {
    const issue = mockIssue();
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([]);

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("skips issues with unreacted human feedback", async () => {
    const issue = mockIssue();
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "<!-- claws-automated -->\n## Implementation Plan\nDo something", login: "claws-bot[bot]" },
      { id: 101, body: "I think we should change the approach", login: "human-user" },
    ]);
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("adds Ready label when plan exists, all feedback addressed, label missing", async () => {
    const issue = mockIssue({ labels: [] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "<!-- claws-automated -->\n## Implementation Plan\nDo something", login: "claws-bot[bot]" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);

    await run([repo]);

    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("fixed 1 issue"));
  });

  it("does not add Ready when already present", async () => {
    const issue = mockIssue({ labels: [{ name: "Ready" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "<!-- claws-automated -->\n## Implementation Plan\nDo something", login: "claws-bot[bot]" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("adds Ready label for stuck multi-phase issues", async () => {
    const issue = mockIssue({ labels: [] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "<!-- claws-automated -->\n## Implementation Plan\n### PR 1: First\nDo first\n### PR 2: Second\nDo second", login: "claws-bot[bot]" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([
      { number: 20, title: "fix(#1): First (1/2)", headRefName: "claws/issue-1-ab12" },
    ]);
    mockFindPlanComment.mockReturnValue("## Implementation Plan\n### PR 1: First\nDo first\n### PR 2: Second\nDo second");
    mockParsePlan.mockReturnValue({
      preamble: "",
      phases: [
        { phaseNumber: 1, title: "First", description: "Do first" },
        { phaseNumber: 2, title: "Second", description: "Do second" },
      ],
      totalPhases: 2,
    });

    await run([repo]);

    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("stuck multi-phase"));
  });

  it("classifies no-body issues as needs-refinement (not skipped)", async () => {
    const issue = mockIssue({ body: "" });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([]);

    await run([repo]);

    // No plan exists, so it's needs-refinement — no label added, no warning
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("sends Slack notification when fixes are made", async () => {
    const issue = mockIssue({ labels: [] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "<!-- claws-automated -->\n## Implementation Plan\nDo something", login: "claws-bot[bot]" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);

    await run([repo]);

    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("Issue auditor"));
  });

  it("no Slack notification when everything is clean", async () => {
    mockGh.listOpenIssues.mockResolvedValueOnce([]);

    await run([repo]);

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("removes stale In Review label from non-in-progress issues", async () => {
    const issue = mockIssue({ labels: [{ name: "In Review" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "<!-- claws-automated -->\n## Implementation Plan\nDo something", login: "claws-bot[bot]" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);

    await run([repo]);

    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "In Review");
  });

  it("per-repo error isolation — failure on one repo does not block others", async () => {
    const repo1 = mockRepo({ fullName: "org/repo1", name: "repo1" });
    const repo2 = mockRepo({ fullName: "org/repo2", name: "repo2" });
    const issue2 = mockIssue({ labels: [] });

    mockGh.listOpenIssues
      .mockRejectedValueOnce(new Error("API failure"))
      .mockResolvedValueOnce([issue2]);

    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "<!-- claws-automated -->\n## Implementation Plan\nDo something", login: "claws-bot[bot]" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);

    await run([repo1, repo2]);

    expect(reportError).toHaveBeenCalledWith("issue-auditor:audit-repo", "org/repo1", expect.any(Error));
    expect(mockGh.addLabel).toHaveBeenCalledWith("org/repo2", issue2.number, "Ready");
  });

  describe("classifyIssue", () => {
    it("returns refined for issues with Refined label", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      expect(await classifyIssue(repo, issue)).toBe("refined");
    });

    it("returns in-progress for issues with open PR", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValueOnce({ number: 10 });
      expect(await classifyIssue(repo, issue)).toBe("in-progress");
    });

    it("returns needs-refinement for issues with no body", async () => {
      const issue = mockIssue({ body: "" });
      mockGh.getIssueComments.mockResolvedValue([]);
      expect(await classifyIssue(repo, issue)).toBe("needs-refinement");
    });

    it("returns needs-triage for claws-error without report", async () => {
      const issue = mockIssue({ title: "[claws-error] test" });
      vi.mocked(extractFingerprint).mockReturnValue("test");
      mockGh.getIssueComments.mockResolvedValue([]);
      expect(await classifyIssue(repo, issue)).toBe("needs-triage");
    });

    it("returns needs-refinement for issues with no plan", async () => {
      const issue = mockIssue();
      mockGh.getIssueComments.mockResolvedValue([]);
      expect(await classifyIssue(repo, issue)).toBe("needs-refinement");
    });

    it("returns ready when plan exists and no pending feedback", async () => {
      const issue = mockIssue();
      mockGh.getIssueComments.mockResolvedValue([
        { id: 100, body: "<!-- claws-automated -->\n## Implementation Plan\nDo something", login: "claws-bot[bot]" },
      ]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      expect(await classifyIssue(repo, issue)).toBe("ready");
    });
  });
});
