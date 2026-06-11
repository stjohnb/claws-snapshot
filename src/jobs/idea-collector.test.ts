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

vi.mock("../db.js", () => ({}));
vi.mock("../model-selector.js", () => ({ getModel: () => "sonnet" }));

const { mockFs, mockGh, mockClaude, mockSlack } = vi.hoisted(() => ({
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
    searchIssues: vi.fn(),
  },
  mockClaude: {
    withNewWorktree: vi.fn(),
    pushBranch: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("cd34"),
    git: vi.fn(),
  },
  mockSlack: {
    getReactions: vi.fn(),
    postMessage: vi.fn(),
    isSlackBotConfigured: vi.fn().mockReturnValue(true),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../slack.js", () => mockSlack);

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
    mockGh.searchIssues.mockResolvedValue([]);
    mockClaude.withNewWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/collect-wt"));
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockClaude.git.mockResolvedValue("");
    mockSlack.postMessage.mockResolvedValue("ts-reply");
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

    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
  });

  it("skips when not all ideas have reactions and <24h elapsed", async () => {
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([]); // no reaction on second idea

    await run([repo]);

    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
  });

  it("processes when all ideas have reactions", async () => {
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "x", count: 1, users: ["U1"] }]);
    // git status --porcelain returns non-empty (changes exist)
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
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
    expect(mockClaude.withNewWorktree).toHaveBeenCalled();
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

  it("does not process when only unrecognized reactions exist even after timeout", async () => {
    const oldPending = makePendingFile({
      postedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    mockFs.readFileSync.mockReturnValue(JSON.stringify(oldPending));
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "thumbsup", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "heart", count: 1, users: ["U1"] }]);

    await run([repo]);

    // Unrecognized reactions produce null disposition — same as no reactions
    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
  });

  it("does not process when no reactions exist even after timeout", async () => {
    const oldPending = makePendingFile({
      postedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    mockFs.readFileSync.mockReturnValue(JSON.stringify(oldPending));
    mockSlack.getReactions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await run([repo]);

    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
  });

  it("gives up and processes after 7-day upper-bound when no reactions arrive", async () => {
    const veryOldPending = makePendingFile({
      postedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8 days ago
    });
    mockFs.readFileSync.mockReturnValue(JSON.stringify(veryOldPending));
    mockSlack.getReactions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    // Should process — all unreacted ideas become "potential"
    expect(mockClaude.withNewWorktree).toHaveBeenCalled();
    expect(mockFs.unlinkSync).toHaveBeenCalled();

    // All ideas should be written to potential.md
    const writeFileCalls = mockFs.writeFileSync.mock.calls;
    const potentialWrite = writeFileCalls.find((c: unknown[]) =>
      (c[0] as string).includes("potential.md"),
    );
    expect(potentialWrite).toBeDefined();
    expect(potentialWrite![1]).toContain("Add dark mode");
    expect(potentialWrite![1]).toContain("Add leaderboard");
  });

  it("processes with timeout — unreacted ideas become potential", async () => {
    const oldPending = makePendingFile({
      postedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
    });
    mockFs.readFileSync.mockReturnValue(JSON.stringify(oldPending));
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([]); // no reaction — will become potential
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
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
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
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
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
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

  it("sanitizes focus area names with slashes and special characters", async () => {
    const pending = makePendingFile({
      ideas: [
        { messageTs: "ts1", title: "Add CI checks", description: "Improve pipeline", focusArea: "CI/CD & Quality Assurance" },
      ],
    });
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (p.includes("pending-ideas")) return JSON.stringify(pending);
      return "";
    });
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.includes("pending-ideas")) return true;
      if (p.includes("ideas/")) return false;
      return true;
    });
    mockSlack.getReactions.mockResolvedValueOnce([
      { name: "white_check_mark", count: 1, users: ["U1"] },
    ]);
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    const writeFileCalls = mockFs.writeFileSync.mock.calls;
    const areaWrite = writeFileCalls.find((c: unknown[]) =>
      (c[0] as string).includes("ci-cd-quality-assurance.md"),
    );
    expect(areaWrite).toBeDefined();
    // Must NOT contain a path separator within the filename
    const filePath = areaWrite![0] as string;
    const fileName = filePath.split("/").pop()!;
    expect(fileName).toBe("ci-cd-quality-assurance.md");
  });

  it("worktree cleaned up after processing", async () => {
    mockSlack.getReactions.mockResolvedValue([
      { name: "white_check_mark", count: 1, users: ["U1"] },
    ]);
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    expect(mockClaude.withNewWorktree).toHaveBeenCalled();
  });

  it("PR body includes disposition table", async () => {
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "x", count: 1, users: ["U1"] }]);
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
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
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    const summaryCall = mockSlack.postMessage.mock.calls[0];
    expect(summaryCall[1]).toContain("1 accepted");
    expect(summaryCall[1]).toContain("1 potential");
    expect(summaryCall[1]).toContain("0 rejected");
  });

  it("skips issue creation when issue with same title already exists", async () => {
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "x", count: 1, users: ["U1"] }]);
    mockGh.searchIssues.mockResolvedValue([{ number: 99, title: "Add dark mode" }]);
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
    // Should reuse existing issue number in PR body
    const prBody = mockGh.createPR.mock.calls[0][3] as string;
    expect(prBody).toContain("#99");
  });

  it("scaffolds overview.md with focus areas when none declared", async () => {
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "x", count: 1, users: ["U1"] }]);
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("focus-areas.md")) return false;
      if (typeof p === "string" && p.includes("overview.md")) return false;
      return true;
    });
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    const writeFileCalls = mockFs.writeFileSync.mock.calls;
    // overview.md should be written with focus areas
    const overviewWrite = writeFileCalls.find((c: unknown[]) =>
      (c[0] as string).includes("overview.md"),
    );
    expect(overviewWrite).toBeDefined();
    expect(overviewWrite![1]).toContain("# Ideas");
    expect(overviewWrite![1]).toContain("## Focus Areas");
    expect(overviewWrite![1]).toContain("- user experience");
    expect(overviewWrite![1]).toContain("- multiplayer");

    // focus-areas.md should NOT be written
    const focusAreasWrite = writeFileCalls.find((c: unknown[]) =>
      (c[0] as string).includes("focus-areas.md"),
    );
    expect(focusAreasWrite).toBeUndefined();
  });

  it("does not overwrite overview.md when focus areas already declared", async () => {
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "x", count: 1, users: ["U1"] }]);
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("focus-areas.md")) return false;
      if (typeof p === "string" && p.includes("overview.md")) return true;
      return true;
    });
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("overview.md")) {
        return "# Ideas\n\n## Focus Areas\n\n- Existing area\n";
      }
      if (typeof p === "string" && p.includes("pending-ideas")) {
        return JSON.stringify(makePendingFile());
      }
      return "";
    });
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    const writeFileCalls = mockFs.writeFileSync.mock.calls;
    const overviewWrite = writeFileCalls.find((c: unknown[]) =>
      (c[0] as string).includes("overview.md"),
    );
    expect(overviewWrite).toBeUndefined();
  });

  it("appends focus areas to existing overview.md without section", async () => {
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "x", count: 1, users: ["U1"] }]);
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("focus-areas.md")) return false;
      if (typeof p === "string" && p.includes("overview.md")) return true;
      return true;
    });
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("overview.md")) {
        return "# Ideas\n\nThis repo tracks enhancement ideas.\n";
      }
      if (typeof p === "string" && p.includes("pending-ideas")) {
        return JSON.stringify(makePendingFile());
      }
      return "";
    });
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    const writeFileCalls = mockFs.writeFileSync.mock.calls;
    const overviewWrite = writeFileCalls.find((c: unknown[]) =>
      (c[0] as string).includes("overview.md"),
    );
    expect(overviewWrite).toBeDefined();
    // Should preserve existing content and append focus areas
    expect(overviewWrite![1]).toContain("This repo tracks enhancement ideas.");
    expect(overviewWrite![1]).toContain("## Focus Areas");
    expect(overviewWrite![1]).toContain("- user experience");
  });

  it("skips overview.md focus areas update when legacy focus-areas.md has areas", async () => {
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "x", count: 1, users: ["U1"] }]);
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("overview.md")) return false;
      if (typeof p === "string" && p.includes("focus-areas.md")) return true;
      return true;
    });
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("focus-areas.md")) return "- Existing legacy area\n";
      if (typeof p === "string" && p.includes("pending-ideas")) return JSON.stringify(makePendingFile());
      return "";
    });
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    const writeFileCalls = mockFs.writeFileSync.mock.calls;
    // overview.md should NOT be scaffolded since legacy file has focus areas
    const overviewWrite = writeFileCalls.find((c: unknown[]) =>
      (c[0] as string).includes("overview.md"),
    );
    expect(overviewWrite).toBeUndefined();
  });

  it("skips overview.md focus areas update when overview.md already has Focus Areas section", async () => {
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "x", count: 1, users: ["U1"] }]);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation((p: string) => {
      if ((p as string).includes("overview.md"))
        return "# Ideas\n\n## Focus Areas\n\n- Existing area\n";
      return JSON.stringify(makePendingFile());
    });
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    const writeFileCalls = mockFs.writeFileSync.mock.calls;
    const overviewWrite = writeFileCalls.find((c: unknown[]) =>
      (c[0] as string).includes("overview.md"),
    );
    // overview.md should NOT be updated since it already has focus areas
    expect(overviewWrite).toBeUndefined();
  });

  it("creates issue when searchIssues returns no exact title match", async () => {
    mockSlack.getReactions
      .mockResolvedValueOnce([{ name: "white_check_mark", count: 1, users: ["U1"] }])
      .mockResolvedValueOnce([{ name: "x", count: 1, users: ["U1"] }]);
    // Substring match but not exact — should still create
    mockGh.searchIssues.mockResolvedValue([{ number: 50, title: "Add dark mode toggle to settings" }]);
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      "test-org/test-repo",
      "Add dark mode",
      "Support dark theme...",
      [],
    );
  });
});
