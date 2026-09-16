import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
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

const { mockFs, mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
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
    createPR: vi.fn(),
    findIssueByExactTitle: vi.fn(),
    createIssue: vi.fn(),
  },
  mockClaude: {
    withNewWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    pushBranch: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
    repoDir: vi.fn((repo: { owner: string; name: string }) => `/home/testuser/.claws/repos/${repo.owner}/${repo.name}`),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    updateTaskModel: vi.fn(),
    updateTaskTokenUsage: vi.fn(),
    trackTaskTokens: vi.fn().mockReturnValue(vi.fn()),
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

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

import {
  run,
  buildSummary,
  parseSuggestions,
  loadExistingIdeas,
  loadFocusAreas,
  buildPrompt,
  isIdeaGenerationDisabled,
  parseFocusAreasFromOverview,
  type ProcessResult,
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
      // Below MIN_IDEA_SCORE — never filed.
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    // Return false for focus-areas.md and overview.md so loadFocusAreas returns []
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.includes("focus-areas.md")) return false;
      if (p.includes("overview.md")) return false;
      return true;
    });
    mockFs.readdirSync.mockReturnValue([]);
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.createPR.mockResolvedValue(42);
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createIssue.mockResolvedValue(101);
    mockClaude.withNewWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${validResponse}\n\`\`\``);
    mockClaude.pushBranch.mockResolvedValue(undefined);
  });

  it("skips repo without local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("files a GitHub issue per idea", async () => {
    await run([repo]);

    expect(mockClaude.withNewWorktree).toHaveBeenCalledTimes(1);
    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      "test-org/test-repo",
      "Add multiplayer mode",
      expect.stringContaining("Focus area: multiplayer"),
      [],
    );
    const body = mockGh.createIssue.mock.calls[0][2] as string;
    expect(body).toContain("Support online multiplayer...");
    expect(body).toContain("idea-suggester (score 9/10)");
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
  });

  it("ideas below the score threshold are not filed", async () => {
    await run([repo]);

    const titles = mockGh.createIssue.mock.calls.map((c: unknown[]) => c[1]);
    expect(titles).toEqual(["Add multiplayer mode", "Add leaderboard"]);
    expect(titles).not.toContain("Reddit launch post");
  });

  it("skips filing when an open issue with the same title exists", async () => {
    mockGh.findIssueByExactTitle.mockImplementation(async (_repo: string, title: string) =>
      title === "Add multiplayer mode" ? { number: 7, title } : null,
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      "test-org/test-repo",
      "Add leaderboard",
      expect.any(String),
      [],
    );
  });

  it("caps filing at 3 ideas", async () => {
    const manyIdeasResponse = JSON.stringify({
      focusAreas: ["area1", "area2", "area3"],
      ideas: {
        "area1": [
          { title: "Low 1", description: "D", score: 1 },
          { title: "High 1", description: "D", score: 10 },
          { title: "Mid 1", description: "D", score: 7 },
        ],
        "area2": [
          { title: "High 2", description: "D", score: 9 },
          { title: "Low 2", description: "D", score: 2 },
        ],
        "area3": [
          { title: "High 3", description: "D", score: 8 },
          { title: "Mid 2", description: "D", score: 7 },
          { title: "Low 3", description: "D", score: 3 },
        ],
      },
    });
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${manyIdeasResponse}\n\`\`\``);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(3);
    const titles = mockGh.createIssue.mock.calls.map((c: unknown[]) => c[1]);
    expect(titles).toEqual(["High 1", "High 2", "High 3"]);
  });

  it("a createIssue failure does not abort the remaining ideas", async () => {
    mockGh.createIssue
      .mockRejectedValueOnce(new Error("422 validation failed"))
      .mockResolvedValueOnce(102);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
  });

  it("ideas without scores are not filed", async () => {
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
          { title: "No score 3", description: "D" },
        ],
      },
    });
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${mixedScoreResponse}\n\`\`\``);

    await run([repo]);

    const titles = mockGh.createIssue.mock.calls.map((c: unknown[]) => c[1]);
    expect(titles).toEqual(["Scored high"]);
  });

  it("single area response files its one idea", async () => {
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${singleAreaResponse}\n\`\`\``);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      "test-org/test-repo",
      "Add dark mode",
      expect.any(String),
      [],
    );
  });

  it("no issues filed when Claude returns empty ideas", async () => {
    mockClaude.runClaude.mockResolvedValue(`\`\`\`json\n${emptyResponse}\n\`\`\``);

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
  });

  it("existing ideas from ideas/ directory are passed to Claude prompt", async () => {
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

    expect(mockGh.createIssue).not.toHaveBeenCalled();
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
    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
    for (const call of mockGh.createIssue.mock.calls) {
      expect(call[0]).toBe("test-org/test-repo-2");
    }
  });
});

describe("buildSummary", () => {
  it("returns an empty string when every repo was skipped for no clone", () => {
    const results: ProcessResult[] = [
      { repo: "o/a", status: "skipped-no-clone" },
      { repo: "o/b", status: "skipped-no-clone" },
    ];
    expect(buildSummary(results)).toBe("");
  });

  it("counts filed issues and skipped duplicates", () => {
    const summary = buildSummary([
      { repo: "o/a", status: "filed", ideaCount: 2, duplicateCount: 1 },
      { repo: "o/b", status: "no-suggestions" },
      { repo: "o/c", status: "skipped-disabled" },
      { repo: "o/d", status: "error" },
      { repo: "o/e", status: "skipped-no-clone" },
    ]);

    expect(summary).toContain("4 repos scanned");
    expect(summary).toContain("2 issues created");
    expect(summary).toContain("1 duplicate skipped");
    expect(summary).toContain("no new suggestions: o/b");
    expect(summary).toContain("skipped (ideas disabled): o/c");
    expect(summary).toContain("1 error: o/d");
    expect(summary).not.toContain("o/e");
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
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createIssue.mockResolvedValue(101);
  });

  it("skips repo when idea generation is disabled via overview.md", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      "# Ideas\n\nIdea generation is currently disabled for this repository.\n",
    );
    mockClaude.runClaude.mockResolvedValue("yes");

    await run([repo]);

    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });
});
