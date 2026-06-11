import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockFs, mockGh, mockClaude } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  mockGh: {
    getIssueState: vi.fn(),
    createPR: vi.fn(),
    searchPRs: vi.fn().mockResolvedValue([]),
    isRateLimited: vi.fn().mockReturnValue(false),
  },
  mockClaude: {
    ensureClone: vi.fn(),
    withNewWorktree: vi.fn(),
    pushBranch: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
    git: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => ({ markRepoProcessedDaily: vi.fn() }));
vi.mock("../smart-schedule.js", () => ({ localDateString: () => "2024-01-15" }));

import { run, parseAcceptedIdeas, removeIdeasFromContent, appendToPotential } from "./idea-reconciler.js";
import * as db from "../db.js";

// ── Unit tests for parsing ──

describe("parseAcceptedIdeas", () => {
  it("extracts ideas with issue refs from markdown content", () => {
    const content = [
      "# Features",
      "",
      "### Add dark mode (#123)",
      "",
      "Support dark theme across the app.",
      "",
      "### Add notifications (#456)",
      "",
      "Push notifications for mobile users.",
      "",
    ].join("\n");

    const ideas = parseAcceptedIdeas(content, "features.md");

    expect(ideas).toHaveLength(2);
    expect(ideas[0]).toMatchObject({
      title: "Add dark mode",
      issueNumber: 123,
      sourceFile: "features.md",
      startLine: 2,
      endLine: 6,
    });
    expect(ideas[1]).toMatchObject({
      title: "Add notifications",
      issueNumber: 456,
      sourceFile: "features.md",
      startLine: 6,
      endLine: 10,
    });
  });

  it("handles multiple ideas in a single file", () => {
    const content = [
      "# Performance",
      "",
      "### Cache API responses (#10)",
      "",
      "Add Redis caching.",
      "",
      "### Lazy load images (#20)",
      "",
      "Use intersection observer.",
      "",
      "### Minify assets (#30)",
      "",
      "Minify JS and CSS in production.",
      "",
    ].join("\n");

    const ideas = parseAcceptedIdeas(content, "performance.md");
    expect(ideas).toHaveLength(3);
    expect(ideas.map((i) => i.issueNumber)).toEqual([10, 20, 30]);
  });

  it("ignores headings without issue refs", () => {
    const content = [
      "# Features",
      "",
      "### Add dark mode",
      "",
      "No issue ref here.",
      "",
      "### Add notifications (#456)",
      "",
      "This one has a ref.",
      "",
    ].join("\n");

    const ideas = parseAcceptedIdeas(content, "features.md");
    expect(ideas).toHaveLength(1);
    expect(ideas[0].issueNumber).toBe(456);
  });

  it("handles idea at end of file without trailing newline", () => {
    const content = "# Features\n\n### Add dark mode (#123)\n\nDescription here.";
    const ideas = parseAcceptedIdeas(content, "features.md");
    expect(ideas).toHaveLength(1);
    expect(ideas[0].title).toBe("Add dark mode");
  });

  it("returns empty array when no ideas with refs exist", () => {
    const content = "# Features\n\n### Add dark mode\n\nNo ref.\n";
    const ideas = parseAcceptedIdeas(content, "features.md");
    expect(ideas).toHaveLength(0);
  });

  it("stops idea block at ## heading", () => {
    const content = [
      "# Features",
      "",
      "### Add dark mode (#123)",
      "",
      "Description.",
      "",
      "## Another Section",
      "",
      "Other content.",
    ].join("\n");

    const ideas = parseAcceptedIdeas(content, "features.md");
    expect(ideas).toHaveLength(1);
    expect(ideas[0].endLine).toBe(6);
  });

  it("stops idea block at untracked ### heading", () => {
    const content = [
      "# Features",
      "",
      "### Tracked idea (#123)",
      "",
      "Description",
      "",
      "### Some subsection without issue ref",
      "",
      "Important notes here",
      "",
      "### Another tracked idea (#456)",
      "",
      "More content.",
      "",
    ].join("\n");

    const ideas = parseAcceptedIdeas(content, "features.md");
    expect(ideas).toHaveLength(2);
    expect(ideas[0]).toMatchObject({
      issueNumber: 123,
      endLine: 6,
    });
    expect(ideas[0].block).not.toContain("Some subsection");
    expect(ideas[1]).toMatchObject({
      issueNumber: 456,
      startLine: 10,
    });
  });
});

// ── Unit tests for content manipulation ──

describe("removeIdeasFromContent", () => {
  it("removes specified ideas and cleans up whitespace", () => {
    const content = [
      "# Features",
      "",
      "### Keep this (#100)",
      "",
      "Stays in place.",
      "",
      "### Remove this (#200)",
      "",
      "Goes away.",
      "",
      "### Also keep (#300)",
      "",
      "Stays too.",
      "",
    ].join("\n");

    const ideas = parseAcceptedIdeas(content, "features.md");
    const toRemove = ideas.filter((i) => i.issueNumber === 200);
    const result = removeIdeasFromContent(content, toRemove);

    expect(result).toContain("### Keep this (#100)");
    expect(result).toContain("### Also keep (#300)");
    expect(result).not.toContain("### Remove this (#200)");
    expect(result).not.toContain("Goes away.");
  });

  it("removes multiple ideas from same file", () => {
    const content = [
      "# Features",
      "",
      "### A (#1)",
      "",
      "Desc A.",
      "",
      "### B (#2)",
      "",
      "Desc B.",
      "",
      "### C (#3)",
      "",
      "Desc C.",
      "",
    ].join("\n");

    const ideas = parseAcceptedIdeas(content, "f.md");
    const toRemove = ideas.filter((i) => i.issueNumber === 1 || i.issueNumber === 3);
    const result = removeIdeasFromContent(content, toRemove);

    expect(result).toContain("### B (#2)");
    expect(result).not.toContain("### A (#1)");
    expect(result).not.toContain("### C (#3)");
  });
});

describe("appendToPotential", () => {
  it("appends ideas with provenance note", () => {
    const existing = "# Potential Ideas\n";
    const ideas = [
      {
        title: "Add dark mode",
        issueNumber: 123,
        block: "\nSupport dark theme.\n",
        sourceFile: "features.md",
        startLine: 0,
        endLine: 3,
      },
    ];

    const result = appendToPotential(existing, ideas);

    expect(result).toContain("# Potential Ideas");
    expect(result).toContain("### Add dark mode");
    expect(result).toContain("Support dark theme.");
    expect(result).toContain("*Previously accepted as #123, closed without implementation.*");
  });

  it("appends multiple ideas", () => {
    const existing = "# Potential Ideas\n";
    const ideas = [
      {
        title: "Idea A",
        issueNumber: 10,
        block: "\nDesc A.\n",
        sourceFile: "f.md",
        startLine: 0,
        endLine: 3,
      },
      {
        title: "Idea B",
        issueNumber: 20,
        block: "\nDesc B.\n",
        sourceFile: "f.md",
        startLine: 0,
        endLine: 3,
      },
    ];

    const result = appendToPotential(existing, ideas);
    expect(result).toContain("### Idea A");
    expect(result).toContain("*Previously accepted as #10");
    expect(result).toContain("### Idea B");
    expect(result).toContain("*Previously accepted as #20");
  });
});

// ── Integration tests ──

describe("idea-reconciler run", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.isRateLimited.mockReturnValue(false);
    mockGh.searchPRs.mockResolvedValue([]);
    mockClaude.ensureClone.mockResolvedValue("/home/testuser/.claws/repos/test-org/test-repo");
    mockClaude.withNewWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/reconcile-wt"));
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockClaude.git.mockResolvedValue("");
    mockGh.createPR.mockResolvedValue(99);
  });

  function setupIdeasDir(focusAreaContent: string, potentialContent?: string) {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.includes("/repos/test-org/test-repo")) return true;
      if (p.endsWith("/ideas")) return true;
      if (p.includes("potential.md")) return !!potentialContent;
      return true;
    });
    mockFs.readdirSync.mockReturnValue(["features.md"]);
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("features.md")) return focusAreaContent;
      if (typeof p === "string" && p.includes("potential.md")) return potentialContent ?? "";
      return "";
    });
  }

  it("moves closed-without-implementation ideas to potential.md and creates PR", async () => {
    const content = [
      "# Features",
      "",
      "### Add dark mode (#123)",
      "",
      "Support dark theme.",
      "",
    ].join("\n");

    setupIdeasDir(content);
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "NOT_PLANNED" });
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    // Should write updated focus-area file
    expect(mockFs.writeFileSync).toHaveBeenCalled();

    // Should write potential.md with the moved idea
    const potentialWrite = mockFs.writeFileSync.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("potential.md"),
    );
    expect(potentialWrite).toBeDefined();
    expect(potentialWrite![1]).toContain("Add dark mode");
    expect(potentialWrite![1]).toContain("Previously accepted as #123");

    // Should create PR
    expect(mockGh.createPR).toHaveBeenCalledWith(
      "test-org/test-repo",
      "claws/ideas-reconcile-ab12",
      expect.stringContaining("Reconcile closed ideas"),
      expect.stringContaining("Add dark mode"),
    );

    // Should have used worktree
    expect(mockClaude.withNewWorktree).toHaveBeenCalled();
  });

  it("skips ideas whose issues are still open", async () => {
    const content = [
      "# Features",
      "",
      "### Add dark mode (#123)",
      "",
      "Support dark theme.",
      "",
    ].join("\n");

    setupIdeasDir(content);
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null });

    await run([repo]);

    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("skips ideas whose issues were closed as completed", async () => {
    const content = [
      "# Features",
      "",
      "### Add dark mode (#123)",
      "",
      "Support dark theme.",
      "",
    ].join("\n");

    setupIdeasDir(content);
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "COMPLETED" });

    await run([repo]);

    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("handles repos with no ideas directory", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("/repos/test-org/test-repo") && !p.includes("ideas")) return true;
      if (typeof p === "string" && p.endsWith("/ideas")) return false;
      return true;
    });

    await run([repo]);

    expect(mockFs.readdirSync).not.toHaveBeenCalled();
    expect(mockGh.getIssueState).not.toHaveBeenCalled();
  });

  it("does nothing when all ideas have open issues (no PR created)", async () => {
    const content = [
      "# Features",
      "",
      "### Idea A (#10)",
      "",
      "Desc A.",
      "",
      "### Idea B (#20)",
      "",
      "Desc B.",
      "",
    ].join("\n");

    setupIdeasDir(content);
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null });

    await run([repo]);

    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("treats issues closed with null stateReason as not implemented", async () => {
    const content = [
      "# Features",
      "",
      "### Add dark mode (#123)",
      "",
      "Support dark theme.",
      "",
    ].join("\n");

    setupIdeasDir(content);
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: null });
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    expect(mockClaude.withNewWorktree).toHaveBeenCalled();
    expect(mockGh.createPR).toHaveBeenCalled();
  });

  it("marks repo processed after run", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("/repos/test-org/test-repo") && !p.includes("ideas")) return true;
      if (typeof p === "string" && p.endsWith("/ideas")) return false;
      return true;
    });

    await run([repo]);

    expect(vi.mocked(db.markRepoProcessedDaily)).toHaveBeenCalledWith(
      "idea-reconciler", repo.fullName, "2024-01-15"
    );
  });

  it("skips repos without local clones", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockClaude.ensureClone).not.toHaveBeenCalled();
    expect(mockGh.getIssueState).not.toHaveBeenCalled();
  });

  it("skips individual ideas when getIssueState fails", async () => {
    const content = [
      "# Features",
      "",
      "### Idea A (#10)",
      "",
      "Desc A.",
      "",
      "### Idea B (#20)",
      "",
      "Desc B.",
      "",
    ].join("\n");

    setupIdeasDir(content);
    mockGh.getIssueState
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce({ state: "CLOSED", stateReason: "NOT_PLANNED" });
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    // Should still create PR for the successful idea
    expect(mockGh.createPR).toHaveBeenCalled();
    const prBody = mockGh.createPR.mock.calls[0][3] as string;
    expect(prBody).toContain("Idea B");
    expect(prBody).not.toContain("Idea A");
  });

  it("stops processing when rate limited", async () => {
    const content = [
      "# Features",
      "",
      "### Idea A (#10)",
      "",
      "Desc A.",
      "",
      "### Idea B (#20)",
      "",
      "Desc B.",
      "",
    ].join("\n");

    setupIdeasDir(content);
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "NOT_PLANNED" });
    // Become rate limited after first check
    mockGh.isRateLimited
      .mockReturnValueOnce(false) // run() entry check
      .mockReturnValueOnce(false) // first idea
      .mockReturnValueOnce(true); // second idea — stop

    await run([repo]);

    expect(mockGh.getIssueState).toHaveBeenCalledTimes(1);
  });

  it("preserves existing potential.md content when appending reconciled ideas", async () => {
    const content = [
      "# Features",
      "",
      "### Add dark mode (#123)",
      "",
      "Support dark theme.",
      "",
    ].join("\n");

    const existingPotential = [
      "# Potential Ideas",
      "",
      "### Existing idea",
      "",
      "This idea was already here.",
      "",
    ].join("\n");

    setupIdeasDir(content, existingPotential);
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "NOT_PLANNED" });
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    const potentialWrite = mockFs.writeFileSync.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("potential.md"),
    );
    expect(potentialWrite).toBeDefined();
    // Existing content should be preserved
    expect(potentialWrite![1]).toContain("# Potential Ideas");
    expect(potentialWrite![1]).toContain("### Existing idea");
    expect(potentialWrite![1]).toContain("This idea was already here.");
    // New idea should be appended
    expect(potentialWrite![1]).toContain("### Add dark mode");
    expect(potentialWrite![1]).toContain("Previously accepted as #123");
  });

  it("skips PR creation when git status shows no file changes after reconciliation", async () => {
    const content = [
      "# Features",
      "",
      "### Add dark mode (#123)",
      "",
      "Support dark theme.",
      "",
    ].join("\n");

    setupIdeasDir(content);
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "NOT_PLANNED" });
    // git status --porcelain returns empty (no actual changes) — default from beforeEach

    await run([repo]);

    expect(mockClaude.withNewWorktree).toHaveBeenCalled();
    // Should NOT commit or create a PR
    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("skips when an open reconciliation PR already exists", async () => {
    const content = [
      "# Features",
      "",
      "### Add dark mode (#123)",
      "",
      "Support dark theme.",
      "",
    ].join("\n");

    setupIdeasDir(content);
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "NOT_PLANNED" });
    mockGh.searchPRs.mockResolvedValue([{ number: 42, title: "[claws-ideas] Reconcile closed ideas for test-repo" }]);

    await run([repo]);

    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("cleans up worktree when pushBranch throws an error", async () => {
    const content = [
      "# Features",
      "",
      "### Add dark mode (#123)",
      "",
      "Support dark theme.",
      "",
    ].join("\n");

    setupIdeasDir(content);
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "NOT_PLANNED" });
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });
    mockClaude.pushBranch.mockRejectedValue(new Error("push failed"));

    // run() catches the error via reportError, so it won't throw
    await run([repo]);

    // withNewWorktree should have been called
    expect(mockClaude.withNewWorktree).toHaveBeenCalled();
    // PR should not have been created
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("handles ideas spanning multiple focus-area files", async () => {
    const featuresContent = [
      "# Features",
      "",
      "### Add dark mode (#123)",
      "",
      "Support dark theme.",
      "",
    ].join("\n");

    const performanceContent = [
      "# Performance",
      "",
      "### Cache API responses (#456)",
      "",
      "Add Redis caching.",
      "",
    ].join("\n");

    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.includes("/repos/test-org/test-repo")) return true;
      if (p.endsWith("/ideas")) return true;
      if (p.includes("potential.md")) return false;
      return true;
    });
    mockFs.readdirSync.mockReturnValue(["features.md", "performance.md"]);
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("features.md")) return featuresContent;
      if (typeof p === "string" && p.includes("performance.md")) return performanceContent;
      return "";
    });

    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "NOT_PLANNED" });
    mockClaude.git.mockImplementation((args: string[]) => {
      if (args.includes("--porcelain")) return Promise.resolve("M ideas/");
      return Promise.resolve("");
    });

    await run([repo]);

    // Should write both focus-area files
    const writeFileCalls = mockFs.writeFileSync.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(writeFileCalls.some((p: string) => p.includes("features.md"))).toBe(true);
    expect(writeFileCalls.some((p: string) => p.includes("performance.md"))).toBe(true);

    // Should write potential.md with both ideas
    const potentialWrite = mockFs.writeFileSync.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("potential.md"),
    );
    expect(potentialWrite).toBeDefined();
    expect(potentialWrite![1]).toContain("Add dark mode");
    expect(potentialWrite![1]).toContain("Cache API responses");

    // PR body should list both ideas
    expect(mockGh.createPR).toHaveBeenCalled();
    const prBody = mockGh.createPR.mock.calls[0][3] as string;
    expect(prBody).toContain("Add dark mode");
    expect(prBody).toContain("Cache API responses");
  });
});
