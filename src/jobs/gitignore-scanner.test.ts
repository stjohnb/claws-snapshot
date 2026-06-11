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

const { mockFs, mockGh, mockClaude } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
  mockGh: {
    searchIssues: vi.fn(),
    createIssue: vi.fn(),
  },
  mockClaude: {
    ensureClone: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);

import { run } from "./gitignore-scanner.js";

const ISSUE_TITLE = "chore: add .mcp-claws.json to .gitignore";

describe("gitignore-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(".mcp-claws.json\n");
    mockGh.searchIssues.mockResolvedValue([]);
    mockGh.createIssue.mockResolvedValue(1);
    mockClaude.ensureClone.mockResolvedValue("/home/testuser/.claws/repos/test-org/test-repo");
  });

  it("skips repos without local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockClaude.ensureClone).not.toHaveBeenCalled();
    expect(mockGh.searchIssues).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("creates issue when .mcp-claws.json is missing from gitignore", async () => {
    mockFs.readFileSync.mockReturnValue("node_modules/\n");

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      ISSUE_TITLE,
      expect.stringContaining(".mcp-claws.json"),
      [],
    );
  });

  it("creates issue when .gitignore does not exist", async () => {
    mockFs.existsSync.mockImplementation((p: string) => !p.endsWith(".gitignore"));

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalled();
  });

  it("skips when .mcp-claws.json entry is already present", async () => {
    mockFs.readFileSync.mockReturnValue("node_modules/\n.mcp-claws.json\n");

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips when an open issue already exists", async () => {
    mockFs.readFileSync.mockReturnValue("node_modules/\n");
    mockGh.searchIssues.mockResolvedValue([{ number: 5, title: ISSUE_TITLE }]);

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });
});
