import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  SLACK_IDEAS_CHANNEL: "C0123456",
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

const { mockFs, mockGh, mockClaude, mockDb, mockSlack } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  mockGh: {
    listOpenIssues: vi.fn(),
    listPRs: vi.fn(),
    searchPRs: vi.fn(),
    createPR: vi.fn(),
  },
  mockClaude: {
    withNewWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    pushBranch: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    updateTaskModel: vi.fn(),
    updateTaskTokenUsage: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
    markRepoProcessedDaily: vi.fn(),
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
  mockSlack: {
    isSlackBotConfigured: vi.fn().mockReturnValue(true),
    postMessage: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);
vi.mock("../slack.js", () => mockSlack);
vi.mock("../smart-schedule.js", () => ({ localDateString: () => "2024-01-15" }));

import {
  run,
  parseSuggestions,
  loadExistingIdeas,
  loadFocusAreas,
  buildPrompt,
  isIdeaGenerationDisabled,
  parseFocusAreasFromOverview,
} from "./idea-suggester.js";
import { reportError } from "../error-reporter.js";

const validResponse = JSON.stringify({
  focusAreas: ["multiplayer", "community engagement"],
  ideas: {
    "multiplayer": [
      { title: "Add multiplayer mode", description: "Support online multiplayer...", score: 9 },
      { title: "Add leaderboard", description: "Track high scores across players...", score: 7 },
    ],
    "community engagement": [
      { title: "Reddit launch post", description: "Post to r/indiegaming...", score: 6 },
    ],
  },
});

const singleAreaResponse = JSON.stringify({
  focusAreas: ["user experience"],
  ideas: {
    "user experience": [
      { title: "Add dark mode", description: "Support dark theme...", score: 8 },
    ],
  },
});

const emptyResponse = JSON.stringify({
  focusAreas: ["some area"],
  ideas: {},
});

describe("idea-suggester", () => {
  const repo = mockRepo();
  let msgCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    msgCounter = 0;
    mockFs.existsSync.mockReturnValue(true);
    // Return false for pending ideas file check (getPendingIdeasPath)
    // Return false for focus-areas.md and overview.md so loadFocusAreas returns []
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.includes("pending-ideas")) return false;
      if (p.includes("focus-areas.md")) return false;
      if (p.includes("overview.md")) return false;
      return true;
    });
    mockFs.readdirSync.mockReturnValue([]);
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.searchPRs.mockResolvedValue([]);
    mockGh.createPR.mockResolvedValue(42);
    mockClaude.withNewWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${validResponse}\n\`\`\``);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockSlack.isSlackBotConfigured.mockReturnValue(true);
    mockSlack.postMessage.mockImplementation(() => {
      msgCounter++;
      return Promise.resolve(`170000000${msgCounter}`);
    });
  });

  it("skips repo without local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    // No idea posts or summary since all repos are skipped-no-clone
    expect(mockSlack.postMessage).not.toHaveBeenCalled();
    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
  });

  it("skips repo when Slack bot is not configured", async () => {
    mockSlack.isSlackBotConfigured.mockReturnValue(false);

    await run([repo]);

    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    expect(mockSlack.postMessage).not.toHaveBeenCalled();
  });

  it("skips repo when pending ideas file already exists", async () => {
    mockFs.existsSync.mockReturnValue(true); // both repo dir and pending file exist

    await run([repo]);

    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
  });

  it("posts ideas to Slack thread and writes pending file", async () => {
    await run([repo]);

    expect(mockClaude.withNewWorktree).toHaveBeenCalledTimes(1);

    // Header message posted first (no threadTs)
    expect(mockSlack.postMessage).toHaveBeenCalledWith(
      "C0123456",
      expect.stringContaining("New ideas for"),
    );

    // Each idea posted as thread reply (3 ideas in validResponse) + 1 summary
    expect(mockSlack.postMessage).toHaveBeenCalledTimes(5); // 1 header + 3 ideas + 1 summary

    // Each idea reply includes the thread timestamp (exclude last call which is summary)
    const calls = mockSlack.postMessage.mock.calls;
    for (let i = 1; i < calls.length - 1; i++) {
      expect(calls[i][2]).toBe("1700000001"); // threadTs from first call
    }

    // Pending ideas file written
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("pending-ideas"),
      { recursive: true },
    );
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("pending-ideas"),
      expect.stringContaining('"repo": "test-org/test-repo"'),
    );
  });

  it("idea thread replies include reaction instructions", async () => {
    await run([repo]);

    // Check that idea messages include reaction instructions
    const calls = mockSlack.postMessage.mock.calls;
    // Second call onwards are idea messages
    expect(calls[1][1]).toContain("✅ accept");
    expect(calls[1][1]).toContain("🤔 potential");
    expect(calls[1][1]).toContain("❌ reject");
  });

  it("pending file contains correct structure", async () => {
    await run([repo]);

    const writeCall = mockFs.writeFileSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("pending-ideas"),
    );
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall![1] as string);
    expect(written.repo).toBe("test-org/test-repo");
    expect(written.channel).toBe("C0123456");
    expect(written.threadTs).toBe("1700000001");
    expect(written.ideas).toHaveLength(3);
    expect(written.ideas[0].title).toBe("Add multiplayer mode");
    expect(written.ideas[0].focusArea).toBe("multiplayer");
  });

  it("no idea post when Claude returns empty ideas, but summary still posted", async () => {
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${emptyResponse}\n\`\`\``);

    await run([repo]);

    // Only the summary message is posted (no idea header/threads)
    expect(mockSlack.postMessage).toHaveBeenCalledTimes(1);
    expect(mockSlack.postMessage).toHaveBeenCalledWith(
      "C0123456",
      expect.stringContaining("no new suggestions"),
    );
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
  });

  it("existing ideas from ideas/ directory are passed to Claude prompt", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.includes("pending-ideas")) return false;
      if (p.includes("focus-areas.md")) return false;
      if (p.includes("overview.md")) return false;
      return true;
    });
    mockFs.readdirSync.mockReturnValue([
      { name: "overview.md", isDirectory: () => false },
    ]);
    mockFs.readFileSync.mockReturnValue("# Previous Ideas\n\n### Existing feature");

    await run([repo]);

    const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("Previous Ideas");
    expect(prompt).toContain("Existing feature");
  });

  it("handles Claude output parse failure gracefully", async () => {
    mockClaude.runClaude.mockResolvedValue("I couldn't analyze the repo, sorry!");

    await run([repo]);

    // Only the summary is posted (no idea threads)
    expect(mockSlack.postMessage).toHaveBeenCalledTimes(1);
    expect(mockSlack.postMessage).toHaveBeenCalledWith(
      "C0123456",
      expect.stringContaining("no new suggestions"),
    );
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
  });

  it("worktree cleaned up on success", async () => {
    await run([repo]);

    expect(mockClaude.withNewWorktree).toHaveBeenCalledTimes(1);
  });

  it("worktree cleaned up on error", async () => {
    mockClaude.runClaude.mockRejectedValue(new Error("claude crashed"));

    await run([repo]);

    expect(mockClaude.withNewWorktree).toHaveBeenCalledTimes(1);
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude crashed"), expect.any(Object));
  });

  it("error in one repo does not block others", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });

    mockClaude.runClaude
      .mockRejectedValueOnce(new Error("first repo error"))
      .mockResolvedValueOnce(`\`\`\`json\n${validResponse}\n\`\`\``);

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "idea-suggester:process-repo",
      repo.fullName,
      expect.any(Error),
    );
    // 1 header + 3 ideas for repo2 + 1 summary
    expect(mockSlack.postMessage).toHaveBeenCalledTimes(5);
  });

  it("marks repo processed after successful idea post", async () => {
    await run([repo]);

    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
      "idea-suggester",
      repo.fullName,
      "2024-01-15",
    );
  });

  it("marks repo processed when no suggestions returned", async () => {
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${emptyResponse}\n\`\`\``);

    await run([repo]);

    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
      "idea-suggester",
      repo.fullName,
      "2024-01-15",
    );
  });

  it("marks repo processed on error in run()", async () => {
    mockClaude.runClaude.mockRejectedValue(new Error("claude crashed"));

    await run([repo]);

    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
      "idea-suggester",
      repo.fullName,
      "2024-01-15",
    );
  });

  it("marks repo processed even when skipping due to no local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
      "idea-suggester", repo.fullName, "2024-01-15",
    );
  });

  it("marks repo processed even when skipping due to pending ideas", async () => {
    mockFs.existsSync.mockReturnValue(true); // both repo dir and pending file exist

    await run([repo]);

    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
      "idea-suggester", repo.fullName, "2024-01-15",
    );
  });

  it("single area response posts correct number of ideas", async () => {
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${singleAreaResponse}\n\`\`\``);

    await run([repo]);

    // 1 header + 1 idea + 1 summary
    expect(mockSlack.postMessage).toHaveBeenCalledTimes(3);
  });
  it("posts summary to Slack after processing all repos", async () => {
    await run([repo]);

    const lastCall = mockSlack.postMessage.mock.calls.at(-1);
    expect(lastCall![1]).toContain("Idea Suggester Summary");
    expect(lastCall![1]).toContain("1 repo received new ideas (3 total)");
  });

  it("summary excludes repos without local clones", async () => {
    const noCloneRepo = mockRepo({ name: "no-clone", fullName: "test-org/no-clone" });
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("no-clone")) return false;
      if (p.includes("pending-ideas")) return false;
      if (p.includes("focus-areas.md")) return false;
      if (p.includes("overview.md")) return false;
      return true;
    });

    await run([repo, noCloneRepo]);

    const lastCall = mockSlack.postMessage.mock.calls.at(-1);
    expect(lastCall![1]).toContain("1 repo scanned");
    expect(lastCall![1]).not.toContain("no-clone");
  });

  it("summary lists repos with no suggestions", async () => {
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${emptyResponse}\n\`\`\``);

    await run([repo]);

    const lastCall = mockSlack.postMessage.mock.calls.at(-1);
    expect(lastCall![1]).toContain("no new suggestions");
    expect(lastCall![1]).toContain("test-org/test-repo");
  });

  it("summary lists repos blocked by pending ideas", async () => {
    mockFs.existsSync.mockReturnValue(true); // repo dir and pending file both exist

    await run([repo]);

    const lastCall = mockSlack.postMessage.mock.calls.at(-1);
    expect(lastCall![1]).toContain("skipped (pending collection)");
    expect(lastCall![1]).toContain("test-org/test-repo");
  });

  it("no summary posted when Slack bot not configured", async () => {
    mockSlack.isSlackBotConfigured.mockReturnValue(false);

    await run([repo]);

    expect(mockSlack.postMessage).not.toHaveBeenCalled();
  });

  it("summary includes errors", async () => {
    mockClaude.runClaude.mockRejectedValue(new Error("claude down"));

    await run([repo]);

    const lastCall = mockSlack.postMessage.mock.calls.at(-1);
    expect(lastCall![1]).toContain("1 error");
    expect(lastCall![1]).toContain("test-org/test-repo");
  });

  it("caps ideas to 5, keeping highest-scored", async () => {
    const manyIdeasResponse = JSON.stringify({
      focusAreas: ["area1", "area2", "area3"],
      ideas: {
        "area1": [
          { title: "Low 1", description: "D", score: 1 },
          { title: "High 1", description: "D", score: 10 },
          { title: "Mid 1", description: "D", score: 5 },
        ],
        "area2": [
          { title: "High 2", description: "D", score: 9 },
          { title: "Low 2", description: "D", score: 2 },
        ],
        "area3": [
          { title: "High 3", description: "D", score: 8 },
          { title: "Mid 2", description: "D", score: 6 },
          { title: "Low 3", description: "D", score: 3 },
        ],
      },
    });
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${manyIdeasResponse}\n\`\`\``);

    await run([repo]);

    // 1 header + 5 ideas + 1 summary = 7
    expect(mockSlack.postMessage).toHaveBeenCalledTimes(7);

    const writeCall = mockFs.writeFileSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("pending-ideas"),
    );
    const written = JSON.parse(writeCall![1] as string);
    expect(written.ideas).toHaveLength(5);

    const titles = written.ideas.map((i: { title: string }) => i.title);
    expect(titles).toEqual(["High 1", "High 2", "High 3", "Mid 2", "Mid 1"]);
  });

  it("ideas without scores are ranked last", async () => {
    const mixedScoreResponse = JSON.stringify({
      focusAreas: ["area1", "area2"],
      ideas: {
        "area1": [
          { title: "No score 1", description: "D" },
          { title: "Scored high", description: "D", score: 9 },
          { title: "No score 2", description: "D", score: "bad" },
        ],
        "area2": [
          { title: "Scored mid", description: "D", score: 5 },
          { title: "Scored low", description: "D", score: 3 },
          { title: "No score 3", description: "D" },
        ],
      },
    });
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${mixedScoreResponse}\n\`\`\``);

    await run([repo]);

    // 1 header + 5 ideas + 1 summary = 7
    expect(mockSlack.postMessage).toHaveBeenCalledTimes(7);

    const writeCall = mockFs.writeFileSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("pending-ideas"),
    );
    const written = JSON.parse(writeCall![1] as string);
    expect(written.ideas).toHaveLength(5);

    const titles = written.ideas.map((i: { title: string }) => i.title);
    // Scored ideas first (descending), then unscored (score 0) in original order
    expect(titles).toEqual(["Scored high", "Scored mid", "Scored low", "No score 1", "No score 2"]);
  });
});

describe("parseSuggestions", () => {
  it("parses focusAreas and ideas from code fence", () => {
    const output = "Some text\n```json\n" + validResponse + "\n```\nMore text";
    const result = parseSuggestions(output);
    expect(result.focusAreas).toEqual(["multiplayer", "community engagement"]);
    expect(result.ideas["multiplayer"]).toHaveLength(2);
    expect(result.ideas["community engagement"]).toHaveLength(1);
    expect(result.ideas["multiplayer"][0].title).toBe("Add multiplayer mode");
  });

  it("parses raw JSON without code fence", () => {
    const result = parseSuggestions(validResponse);
    expect(result.focusAreas).toHaveLength(2);
    expect(Object.keys(result.ideas)).toHaveLength(2);
  });

  it("returns empty result for garbled output", () => {
    const result = parseSuggestions("This is not JSON at all");
    expect(result.focusAreas).toEqual([]);
    expect(result.ideas).toEqual({});
  });

  it("handles missing focusAreas key", () => {
    const output = JSON.stringify({
      ideas: { "area": [{ title: "T", description: "D" }] },
    });
    const result = parseSuggestions(`\`\`\`json\n${output}\n\`\`\``);
    expect(result.focusAreas).toEqual([]);
    expect(result.ideas["area"]).toHaveLength(1);
  });

  it("handles missing ideas key", () => {
    const output = JSON.stringify({
      focusAreas: ["area1", "area2"],
    });
    const result = parseSuggestions(`\`\`\`json\n${output}\n\`\`\``);
    expect(result.focusAreas).toEqual(["area1", "area2"]);
    expect(result.ideas).toEqual({});
  });

  it("filters non-string entries from focusAreas", () => {
    const output = JSON.stringify({
      focusAreas: ["valid", 42, null, "also valid", { obj: true }],
      ideas: {},
    });
    const result = parseSuggestions(`\`\`\`json\n${output}\n\`\`\``);
    expect(result.focusAreas).toEqual(["valid", "also valid"]);
  });

  it("filters invalid entries within each area's idea array", () => {
    const output = JSON.stringify({
      focusAreas: ["area1"],
      ideas: {
        "area1": [
          { title: "Valid", description: "Valid description" },
          { title: "Missing description" },
          { description: "Missing title" },
        ],
      },
    });
    const result = parseSuggestions(`\`\`\`json\n${output}\n\`\`\``);
    expect(result.ideas["area1"]).toHaveLength(1);
    expect(result.ideas["area1"][0].title).toBe("Valid");
  });

  it("discards areas with no valid entries", () => {
    const output = JSON.stringify({
      focusAreas: ["good", "bad"],
      ideas: {
        "good": [{ title: "T", description: "D" }],
        "bad": [{ title: "No desc" }],
      },
    });
    const result = parseSuggestions(`\`\`\`json\n${output}\n\`\`\``);
    expect(result.ideas["good"]).toHaveLength(1);
    expect(result.ideas["bad"]).toBeUndefined();
  });

  it("defaults missing or non-numeric scores to 0", () => {
    const output = JSON.stringify({
      focusAreas: ["area"],
      ideas: {
        "area": [
          { title: "Has score", description: "D", score: 7 },
          { title: "No score", description: "D" },
          { title: "String score", description: "D", score: "high" },
          { title: "Null score", description: "D", score: null },
        ],
      },
    });
    const result = parseSuggestions(`\`\`\`json\n${output}\n\`\`\``);
    expect(result.ideas["area"]).toHaveLength(4);
    expect(result.ideas["area"][0].score).toBe(7);
    expect(result.ideas["area"][1].score).toBe(0);
    expect(result.ideas["area"][2].score).toBe(0);
    expect(result.ideas["area"][3].score).toBe(0);
  });
});

describe("loadExistingIdeas", () => {
  it("returns empty string when ideas/ directory is missing", () => {
    mockFs.existsSync.mockReturnValue(false);

    const result = loadExistingIdeas("/some/repo");

    expect(result).toBe("");
  });

  it("reads .md files from ideas/ directory", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([
      { name: "overview.md", isDirectory: () => false },
      { name: "not-markdown.txt", isDirectory: () => false },
    ]);
    mockFs.readFileSync.mockReturnValue("# Some Ideas");

    const result = loadExistingIdeas("/some/repo");

    expect(result).toContain("overview.md");
    expect(result).toContain("# Some Ideas");
    // Should not have read the .txt file
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it("caps output at ~50KB", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([
      { name: "big.md", isDirectory: () => false },
    ]);
    mockFs.readFileSync.mockReturnValue("x".repeat(100_000));

    const result = loadExistingIdeas("/some/repo");

    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(55_000); // ~50KB + header overhead
  });
});

describe("buildPrompt", () => {
  it("includes existing ideas text", () => {
    const prompt = buildPrompt("org/repo", "# Previous\n### Old idea", [], []);
    expect(prompt).toContain("Previous");
    expect(prompt).toContain("Old idea");
    expect(prompt).toContain("Do NOT re-suggest");
  });

  it("handles no previous ideas", () => {
    const prompt = buildPrompt("org/repo", "", [], []);
    expect(prompt).toContain("No previous ideas exist");
  });

  it("includes open issue and PR titles", () => {
    const prompt = buildPrompt("org/repo", "", ["Bug fix needed"], ["refactor: Clean code"]);
    expect(prompt).toContain("Bug fix needed");
    expect(prompt).toContain("refactor: Clean code");
  });

  it("mentions focus areas and new JSON schema", () => {
    const prompt = buildPrompt("org/repo", "", [], []);
    expect(prompt).toContain("focus areas");
    expect(prompt).toContain('"focusAreas"');
    expect(prompt).toContain('"ideas"');
    expect(prompt).not.toContain("featureIdeas");
    expect(prompt).not.toContain("promotionStrategies");
  });

  it("includes resources section when resources are provided", () => {
    const prompt = buildPrompt("org/repo", "", [], [], "Some marketing tips");
    expect(prompt).toContain("<resources>");
    expect(prompt).toContain("Some marketing tips");
    expect(prompt).toContain("</resources>");
    expect(prompt).toContain("reference material may help inspire ideas");
  });

  it("omits resources section when resources is empty", () => {
    const prompt = buildPrompt("org/repo", "", [], [], "");
    expect(prompt).not.toContain("<resources>");
    expect(prompt).not.toContain("</resources>");
    expect(prompt).not.toContain("reference material");
  });

  it("omits resources section when resources is omitted", () => {
    const prompt = buildPrompt("org/repo", "", [], []);
    expect(prompt).not.toContain("<resources>");
    expect(prompt).not.toContain("</resources>");
  });

  it("includes declared focus areas when provided", () => {
    const prompt = buildPrompt("org/repo", "", [], [], "", ["Performance", "Security"]);
    expect(prompt).toContain("declared the following focus areas");
    expect(prompt).toContain("- Performance");
    expect(prompt).toContain("- Security");
    expect(prompt).toContain("up to 2 additional");
  });

  it("uses dynamic focus area discovery when no declared areas", () => {
    const prompt = buildPrompt("org/repo", "", [], [], "", []);
    expect(prompt).toContain("Identify 3-7 **focus areas**");
    expect(prompt).not.toContain("declared the following focus areas");
  });

  it("includes scoring instruction", () => {
    const prompt = buildPrompt("org/repo", "", [], []);
    expect(prompt).toContain("score from 1 to 10");
    expect(prompt).toContain('"score": 8');
  });
});

describe("isIdeaGenerationDisabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns disabled:false when overview.md does not exist", async () => {
    mockFs.existsSync.mockReturnValue(false);
    const result = await isIdeaGenerationDisabled("/some/repo", "org/repo");
    expect(result.disabled).toBe(false);
    expect(result.overviewContent).toBeNull();
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
  });

  it("returns disabled:false for empty file without calling Claude", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("");
    const result = await isIdeaGenerationDisabled("/some/repo", "org/repo");
    expect(result.disabled).toBe(false);
    expect(result.overviewContent).toBe("");
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
  });

  it("returns disabled:true when Claude assesses idea generation is disabled", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      "# Ideas\n\nIdea generation is currently disabled for this repository.\n",
    );
    mockClaude.runClaude.mockResolvedValue("yes");
    const result = await isIdeaGenerationDisabled("/some/repo", "org/repo");
    expect(result.disabled).toBe(true);
    expect(result.overviewContent).toContain("disabled");
  });

  it("returns disabled:false when Claude assesses idea generation is enabled", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      "# Ideas\n\nWe welcome new feature suggestions.\n",
    );
    mockClaude.runClaude.mockResolvedValue("no");
    const result = await isIdeaGenerationDisabled("/some/repo", "org/repo");
    expect(result.disabled).toBe(false);
    expect(result.overviewContent).toContain("welcome");
  });

  it("defaults to enabled when Claude call fails", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("# Ideas\n\nSome content.\n");
    mockClaude.runClaude.mockRejectedValue(new Error("API error"));
    const result = await isIdeaGenerationDisabled("/some/repo", "org/repo");
    expect(result.disabled).toBe(false);
    expect(result.overviewContent).toContain("Some content");
  });

  it("sends overview.md content to Claude for assessment", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("# Ideas\n\nWe don't want ideas right now.\n");
    mockClaude.runClaude.mockResolvedValue("yes");
    await isIdeaGenerationDisabled("/some/repo", "org/repo");
    expect(mockClaude.runClaude).toHaveBeenCalledWith(
      expect.stringContaining("We don't want ideas right now."),
      "/some/repo",
      expect.objectContaining({ model: expect.any(String) }),
    );
  });
});

describe("parseFocusAreasFromOverview", () => {
  it("returns empty array for content without Focus Areas section", () => {
    expect(parseFocusAreasFromOverview("# Ideas\n\nSome content\n")).toEqual([]);
  });

  it("parses bullet points under ## Focus Areas", () => {
    const content = "# Ideas\n\n## Focus Areas\n\n- Performance\n- Security\n";
    expect(parseFocusAreasFromOverview(content)).toEqual(["Performance", "Security"]);
  });

  it("stops at next ## heading", () => {
    const content = "## Focus Areas\n\n- Area 1\n\n## Other Section\n\n- Not an area\n";
    expect(parseFocusAreasFromOverview(content)).toEqual(["Area 1"]);
  });

  it("handles mixed content (disable directive + focus areas)", () => {
    const content = [
      "# Ideas",
      "",
      "Idea generation is currently disabled for this repository.",
      "",
      "## Focus Areas",
      "",
      "- Performance optimization",
      "- Developer onboarding",
      "",
    ].join("\n");
    expect(parseFocusAreasFromOverview(content)).toEqual([
      "Performance optimization",
      "Developer onboarding",
    ]);
  });

  it("ignores non-bullet content within the section", () => {
    const content = "## Focus Areas\n\nSome intro text.\n\n- Real area\n\nMore text.\n";
    expect(parseFocusAreasFromOverview(content)).toEqual(["Real area"]);
  });
});

describe("loadFocusAreas", () => {
  it("returns empty array when overview.md is missing", () => {
    mockFs.existsSync.mockReturnValue(false);
    expect(loadFocusAreas("/some/repo")).toEqual([]);
  });

  it("reads from overview.md Focus Areas section when present", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("# Ideas\n\n## Focus Areas\n\n- Performance\n- Security\n");
    expect(loadFocusAreas("/some/repo")).toEqual(["Performance", "Security"]);
  });

  it("returns empty array when overview.md has no Focus Areas section and no legacy file", () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.includes("focus-areas.md")) return false;
      return true; // overview.md exists
    });
    mockFs.readFileSync.mockReturnValue("# Ideas\n\nJust some notes.\n");
    expect(loadFocusAreas("/some/repo")).toEqual([]);
  });

  it("falls back to legacy focus-areas.md when overview.md has no Focus Areas section", () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.includes("focus-areas.md")) return true;
      if (p.includes("overview.md")) return true;
      return false;
    });
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (p.includes("overview.md")) return "# Ideas\n\nJust some notes.\n";
      if (p.includes("focus-areas.md")) return "- Performance\n- Security\n";
      return "";
    });
    expect(loadFocusAreas("/some/repo")).toEqual(["Performance", "Security"]);
  });

  it("falls back to legacy focus-areas.md when overview.md does not exist", () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.includes("overview.md")) return false;
      if (p.includes("focus-areas.md")) return true;
      return false;
    });
    mockFs.readFileSync.mockReturnValue("- Legacy Area 1\n* Legacy Area 2\n");
    expect(loadFocusAreas("/some/repo")).toEqual(["Legacy Area 1", "Legacy Area 2"]);
  });

  it("prefers overview.md Focus Areas over legacy file", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (p.includes("overview.md")) return "## Focus Areas\n\n- From Overview\n";
      if (p.includes("focus-areas.md")) return "- From Legacy\n";
      return "";
    });
    expect(loadFocusAreas("/some/repo")).toEqual(["From Overview"]);
  });

  it("uses pre-read overviewContent when provided", () => {
    vi.clearAllMocks();
    // Should not read from disk at all when content is provided
    const areas = loadFocusAreas("/some/repo", "## Focus Areas\n\n- Pre-read Area\n");
    expect(areas).toEqual(["Pre-read Area"]);
    expect(mockFs.existsSync).not.toHaveBeenCalled();
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
  });
});

describe("idea-suggester disabled integration", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSlack.isSlackBotConfigured.mockReturnValue(true);
  });

  it("skips repo when idea generation is disabled via overview.md", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.includes("overview.md")) return true;
      if (p.includes("pending-ideas")) return false;
      return true;
    });
    mockFs.readFileSync.mockReturnValue(
      "# Ideas\n\nIdea generation is currently disabled for this repository.\n",
    );
    mockClaude.runClaude.mockResolvedValue("yes");

    await run([repo]);

    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();

    // Summary should mention disabled
    const lastCall = mockSlack.postMessage.mock.calls.at(-1);
    expect(lastCall![1]).toContain("skipped (ideas disabled)");
    expect(lastCall![1]).toContain("test-org/test-repo");
  });
});
