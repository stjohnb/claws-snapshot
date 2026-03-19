import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockFs, mockGh, mockClaude, mockSlack, mockExecFile } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  mockGh: {
    createIssue: vi.fn(),
    createPR: vi.fn(),
  },
  mockClaude: {
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    pushBranch: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("cd34"),
  },
  mockSlack: {
    getReactions: vi.fn(),
    postMessage: vi.fn(),
    isSlackBotConfigured: vi.fn().mockReturnValue(true),
  },
  mockExecFile: vi.fn(),
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../slack.js", () => mockSlack);
vi.mock("node:util", () => ({
  promisify: () => mockExecFile,
}));

import { run, classifyReactions } from "./idea-collector.js";
import type { PendingIdeasFile } from "./idea-suggester.js";
import type { SlackReaction } from "../slack.js";

function makePendingFile(overrides: Partial<PendingIdeasFile> = {}): PendingIdeasFile {
  return {
    repo: "test-org/test-repo",
    channel: "C0123456",
    threadTs: "1710000000.000000",
    postedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    ideas: [
      {
        messageTs: "1710000000.000001",
        title: "Add dark mode",
        description: "Support dark theme...",
        focusArea: "user experience",
      },
      {
        messageTs: "1710000000.000002",
        title: "Add leaderboard",
        description: "Track high scores...",
        focusArea: "multiplayer",
      },
    ],
    ...overrides,
  };
}

describe("classifyReactions", () => {
  it("returns accepted for white_check_mark", () => {
    const reactions: SlackReaction[] = [
      { name: "white_check_mark", count: 1, users: ["U123"] },
    ];
    expect(classifyReactions(reactions)).toBe("accepted");
  });

  it("returns rejected for x", () => {
    const reactions: SlackReaction[] = [
      { name: "x", count: 1, users: ["U123"] },
    ];
    expect(classifyReactions(reactions)).toBe("rejected");
  });

  it("returns potential for thinking_face", () => {
    const reactions: SlackReaction[] = [
      { name: "thinking_face", count: 1, users: ["U123"] },
    ];
    expect(classifyReactions(reactions)).toBe("potential");
  });

  it("returns null for no matching reactions", () => {
    const reactions: SlackReaction[] = [
      { name: "thumbsup", count: 1, users: ["U123"] },
    ];
    expect(classifyReactions(reactions)).toBeNull();
  });

  it("returns null for empty reactions", () => {
    expect(classifyReactions([])).toBeNull();
  });

  it("uses priority: accepted > rejected > potential", () => {
    const reactions: SlackReaction[] = [
      { name: "thinking_face", count: 1, users: ["U456"] },
      { name: "white_check_mark", count: 1, users: ["U123"] },
      { name: "x", count: 1, users: ["U789"] },
    ];
    expect(classifyReactions(reactions)).toBe("accepted");
  });

  it("rejected takes priority over potential", () => {
    const reactions: SlackReaction[] = [
      { name: "thinking_face", count: 1, users: ["U456"] },
      { name: "x", count: 1, users: ["U789"] },
    ];
    expect(classifyReactions(reactions)).toBe("rejected");
  });
});

describe("idea-collector", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(["test-org-test-repo.json"]);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(makePendingFile()));
    mockGh.createIssue.mockResolvedValue(42);
    mockGh.createPR.mockResolvedValue(99);
    mockClaude.createWorktree.mockResolvedValue("/tmp/collect-wt");
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockSlack.postMessage.mockResolvedValue("ts-reply");
    mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("skips when no pending ideas directory exists", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockSlack.getReactions).not.toHaveBeenCalled();
  });

  it("skips when no JSON files in pending directory", async () => {
    mockFs.readdirSync.mockReturnValue([]);

    await run([repo]);

    expect(mockSlack.getReactions).not.toHaveBeenCalled();
  });

  it("skips repo not in repos list", async () => {
    const otherPending = makePendingFile({ repo: "other-org/other-repo" });
    mockFs.readFileSync.mockReturnValue(JSON.stringify(otherPending));

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
  });

  it("skips when not all ideas have reactions and <24h elapsed", async () => {
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([]); // no reaction on second idea

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("processes when all ideas have reactions", async () => {
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "x", count: 1, users: ["U1"] }]);
    // git status --porcelain returns non-empty (changes exist)
    mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve({ stdout: "M ideas/", stderr: "" });
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    await run([repo]);

    // Should create issue for accepted idea
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      "test-org/test-repo",
      "Add dark mode",
      "Support dark theme...",
      [],
    );

    // Should NOT create issue for rejected idea
    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);

    // Should create worktree, commit, push, create PR
    expect(mockClaude.createWorktree).toHaveBeenCalled();
    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockGh.createPR).toHaveBeenCalledWith(
      "test-org/test-repo",
      "claws/ideas-collect-cd34",
      "[claws-ideas] Collected idea responses for test-repo",
      expect.stringContaining("Collected Idea Responses"),
    );

    // Should delete pending file
    expect(mockFs.unlinkSync).toHaveBeenCalled();

    // Should post summary to Slack
    expect(mockSlack.postMessage).toHaveBeenCalledWith(
      "C0123456",
      expect.stringContaining("Collection complete"),
      "1710000000.000000",
    );
  });

  it("processes with timeout — unreacted ideas become potential", async () => {
    const oldPending = makePendingFile({
      postedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
    });
    mockFs.readFileSync.mockReturnValue(JSON.stringify(oldPending));
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([]); // no reaction — will become potential
    mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve({ stdout: "M ideas/", stderr: "" });
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    await run([repo]);

    // Should create issue only for accepted idea
    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);

    // Should write potential.md for unreacted idea
    const writeFileCalls = mockFs.writeFileSync.mock.calls;
    const potentialWrite = writeFileCalls.find((c: unknown[]) =>
      (c[0] as string).includes("potential.md"),
    );
    expect(potentialWrite).toBeDefined();
    expect(potentialWrite![1]).toContain("Add leaderboard");

    // Should still complete and delete pending file
    expect(mockFs.unlinkSync).toHaveBeenCalled();
  });

  it("handles createIssue failure gracefully", async () => {
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }]);
    mockGh.createIssue
      .mockRejectedValueOnce(new Error("GitHub error"))
      .mockResolvedValueOnce(43);
    mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve({ stdout: "M ideas/", stderr: "" });
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    await run([repo]);

    // Should still create second issue and complete the process
    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
    expect(mockFs.unlinkSync).toHaveBeenCalled();
  });

  it("creates correct ideas directory files for mixed reactions", async () => {
    const pending = makePendingFile({
      ideas: [
        { messageTs: "ts1", title: "Accepted idea", description: "Good idea", focusArea: "ux" },
        { messageTs: "ts2", title: "Potential idea", description: "Maybe later", focusArea: "ux" },
        { messageTs: "ts3", title: "Rejected idea", description: "Not useful", focusArea: "perf" },
      ],
    });
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (p.includes("pending-ideas")) return JSON.stringify(pending);
      return "";
    });
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.includes("pending-ideas") && p.endsWith(".json")) return true;
      if (p.endsWith("pending-ideas")) return true;
      // ideas files don't exist yet
      if (p.includes("ideas/")) return false;
      return true;
    });
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "thinking_face", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "x", count: 1, users: ["U1"] }]);
    mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve({ stdout: "M ideas/", stderr: "" });
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    await run([repo]);

    const writeFileCalls = mockFs.writeFileSync.mock.calls;

    // Check accepted idea goes to focus-area file
    const uxWrite = writeFileCalls.find((c: unknown[]) => (c[0] as string).includes("ux.md"));
    expect(uxWrite).toBeDefined();
    expect(uxWrite![1]).toContain("Accepted idea");

    // Check potential idea goes to potential.md
    const potentialWrite = writeFileCalls.find((c: unknown[]) =>
      (c[0] as string).includes("potential.md"),
    );
    expect(potentialWrite).toBeDefined();
    expect(potentialWrite![1]).toContain("Potential idea");

    // Check rejected idea goes to rejected.md
    const rejectedWrite = writeFileCalls.find((c: unknown[]) =>
      (c[0] as string).includes("rejected.md"),
    );
    expect(rejectedWrite).toBeDefined();
    expect(rejectedWrite![1]).toContain("Rejected idea");
  });

  it("worktree cleaned up after processing", async () => {
    mockSlack.getReactions.mockResolvedValue([
      { name: "white_check_mark", count: 1, users: ["U1"] },
    ]);
    mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve({ stdout: "M ideas/", stderr: "" });
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    await run([repo]);

    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repo, "/tmp/collect-wt");
  });

  it("PR body includes disposition table", async () => {
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "x", count: 1, users: ["U1"] }]);
    mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve({ stdout: "M ideas/", stderr: "" });
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    await run([repo]);

    const prBody = mockGh.createPR.mock.calls[0][3] as string;
    expect(prBody).toContain("Add dark mode");
    expect(prBody).toContain("✅ Accepted");
    expect(prBody).toContain("Add leaderboard");
    expect(prBody).toContain("❌ Rejected");
  });

  it("Slack summary includes correct counts", async () => {
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "thinking_face", count: 1, users: ["U1"] }]);
    mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve({ stdout: "M ideas/", stderr: "" });
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    await run([repo]);

    const summaryCall = mockSlack.postMessage.mock.calls[0];
    expect(summaryCall[1]).toContain("1 accepted");
    expect(summaryCall[1]).toContain("1 potential");
    expect(summaryCall[1]).toContain("0 rejected");
  });
});
