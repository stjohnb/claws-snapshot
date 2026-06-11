import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
  },
}));
vi.mock("../model-selector.js", () => ({ getModel: () => "sonnet" }));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

vi.mock("../timeout-handler.js", () => ({
  handleTimeoutIfApplicable: vi.fn().mockResolvedValue(undefined),
  getItemTimeoutMs: vi.fn().mockReturnValue(undefined),
}));

const { mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockGh: {
    listPRs: vi.fn(),
    getSelfLogin: vi.fn(),
    getIssueComments: vi.fn(),
    getCommentReactions: vi.fn(),
    addReaction: vi.fn(),
    getPRBody: vi.fn(),
    getPRHeadSHA: vi.fn(),
    getDeploymentUrl: vi.fn(),
    getIssueBody: vi.fn(),
    getPRChangedFiles: vi.fn(),
    commentOnIssue: vi.fn(),
    addLabel: vi.fn(),
    getLinkedIssueNumber: vi.fn(),
    isRateLimited: vi.fn().mockReturnValue(false),
    isItemSkipped: vi.fn().mockReturnValue(false),
    isAllowedActor: vi.fn().mockResolvedValue(true),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    hasIgnoreLabel: vi.fn().mockReturnValue(false),
    isForkPR: vi.fn().mockReturnValue(false),
    populateQueueCache: vi.fn(),
  },
  mockClaude: {
    withExistingWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    git: vi.fn(),
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

vi.mock("../github.js", () => ({ ...mockGh }));
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

import { run } from "./qa-phase.js";

describe("qa-phase", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.getSelfLogin.mockResolvedValue("claws-bot");
    mockGh.isForkPR.mockReturnValue(false);
  });

  it("skips gracefully when branch no longer exists (merged/closed)", async () => {
    const pr = mockPR({ headRefName: "dependabot/npm/lodash-4.0" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 500, body: "QA this", login: "someone" },
    ]);
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockGh.addReaction.mockResolvedValue(undefined);
    mockGh.getPRHeadSHA.mockResolvedValue("abc123");
    mockGh.getDeploymentUrl.mockResolvedValue("https://preview.example.com");
    mockClaude.withExistingWorktree.mockResolvedValue(null);

    await run([repo]);

    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, {
      commits: 0,
      prNumber: pr.number,
      prAction: "skipped",
    });
    expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
  });

  it("skips fork PRs (cross-repository)", async () => {
    const pr = mockPR({ headRefName: "feature/fork-attack", isCrossRepository: true });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.isForkPR.mockReturnValue(true);

    await run([repo]);

    expect(mockGh.getIssueComments).not.toHaveBeenCalled();
    expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });
});
