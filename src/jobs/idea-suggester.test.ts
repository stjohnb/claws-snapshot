import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  SLACK_IDEAS_CHANNEL: "C0123456",
}));

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
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    pushBranch: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
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

import {
  run,
  parseSuggestions,
  formatOverviewContent,
  loadExistingIdeas,
  buildPrompt,
} from "./idea-suggester.js";
import { reportError } from "../error-reporter.js";

const validResponse = JSON.stringify({
  focusAreas: ["multiplayer", "community engagement"],
  ideas: {
    "multiplayer": [
      { title: "Add multiplayer mode", description: "Support online multiplayer..." },
      { title: "Add leaderboard", description: "Track high scores across players..." },
    ],
    "community engagement": [
      { title: "Reddit launch post", description: "Post to r/indiegaming..." },
    ],
  },
});

const singleAreaResponse = JSON.stringify({
  focusAreas: ["user experience"],
  ideas: {
    "user experience": [
      { title: "Add dark mode", description: "Support dark theme..." },
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
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.includes("pending-ideas")) return false;
      return true;
    });
    mockFs.readdirSync.mockReturnValue([]);
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.searchPRs.mockResolvedValue([]);
    mockGh.createPR.mockResolvedValue(42);
    mockClaude.createWorktree.mockResolvedValue("/tmp/worktree");
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${validResponse}\n\`\`\``);
    mockClaude.removeWorktree.mockResolvedValue(undefined);
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

    expect(mockSlack.postMessage).not.toHaveBeenCalled();
    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("skips repo when Slack bot is not configured", async () => {
    mockSlack.isSlackBotConfigured.mockReturnValue(false);

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
    expect(mockSlack.postMessage).not.toHaveBeenCalled();
  });

  it("skips repo when pending ideas file already exists", async () => {
    mockFs.existsSync.mockReturnValue(true); // both repo dir and pending file exist

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("posts ideas to Slack thread and writes pending file", async () => {
    await run([repo]);

    expect(mockClaude.createWorktree).toHaveBeenCalledTimes(1);

    // Header message posted first (no threadTs)
    expect(mockSlack.postMessage).toHaveBeenCalledWith(
      "C0123456",
      expect.stringContaining("New ideas for"),
    );

    // Each idea posted as thread reply (3 ideas in validResponse)
    expect(mockSlack.postMessage).toHaveBeenCalledTimes(4); // 1 header + 3 ideas

    // Each idea reply includes the thread timestamp
    const calls = mockSlack.postMessage.mock.calls;
    for (let i = 1; i < calls.length; i++) {
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

  it("no Slack post when Claude returns empty ideas", async () => {
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${emptyResponse}\n\`\`\``);

    await run([repo]);

    expect(mockSlack.postMessage).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("existing ideas from ideas/ directory are passed to Claude prompt", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.includes("pending-ideas")) return false;
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

    expect(mockSlack.postMessage).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("worktree cleaned up on success", async () => {
    await run([repo]);

    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repo, "/tmp/worktree");
  });

  it("worktree cleaned up on error", async () => {
    mockClaude.runClaude.mockRejectedValue(new Error("claude crashed"));

    await run([repo]);

    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repo, "/tmp/worktree");
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude crashed"));
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
    expect(mockSlack.postMessage).toHaveBeenCalled();
  });

  it("single area response posts correct number of ideas", async () => {
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${singleAreaResponse}\n\`\`\``);

    await run([repo]);

    // 1 header + 1 idea
    expect(mockSlack.postMessage).toHaveBeenCalledTimes(2);
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
});

describe("formatOverviewContent", () => {
  it("renders focus areas list and idea sections for multiple areas", () => {
    const content = formatOverviewContent({
      focusAreas: ["multiplayer", "community"],
      ideas: {
        "multiplayer": [{ title: "Idea A", description: "Desc A" }],
        "community": [{ title: "Idea B", description: "Desc B" }],
      },
    });
    expect(content).toContain("# Suggested Ideas");
    expect(content).toContain("## Focus Areas");
    expect(content).toContain("- multiplayer");
    expect(content).toContain("- community");
    expect(content).toContain("## multiplayer");
    expect(content).toContain("### Idea A");
    expect(content).toContain("Desc A");
    expect(content).toContain("## community");
    expect(content).toContain("### Idea B");
    expect(content).toContain("Desc B");
    expect(content).toContain("Automated suggestions by claws idea-suggester");
  });

  it("omits area section when that area has no ideas", () => {
    const content = formatOverviewContent({
      focusAreas: ["has-ideas", "no-ideas"],
      ideas: {
        "has-ideas": [{ title: "Idea", description: "Desc" }],
      },
    });
    expect(content).toContain("- has-ideas");
    expect(content).toContain("- no-ideas");
    expect(content).toContain("## has-ideas");
    expect(content).not.toContain("## no-ideas");
  });

  it("focus areas list appears before idea sections", () => {
    const content = formatOverviewContent({
      focusAreas: ["area1"],
      ideas: {
        "area1": [{ title: "T", description: "D" }],
      },
    });
    const focusIdx = content.indexOf("## Focus Areas");
    const areaIdx = content.indexOf("## area1");
    expect(focusIdx).toBeLessThan(areaIdx);
  });

  it("handles empty ideas record with focus areas", () => {
    const content = formatOverviewContent({
      focusAreas: ["area1", "area2"],
      ideas: {},
    });
    expect(content).toContain("## Focus Areas");
    expect(content).toContain("- area1");
    expect(content).toContain("- area2");
    expect(content).toContain("Automated suggestions by claws idea-suggester");
    // No idea sections rendered
    expect(content).not.toContain("## area1");
    expect(content).not.toContain("## area2");
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
});
