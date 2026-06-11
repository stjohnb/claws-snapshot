import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  LABELS: { priority: "Priority" },
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
    readdirSync: vi.fn(),
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

import { run } from "./issue-comment-spam-scanner.js";
import { reportError } from "../error-reporter.js";

const ISSUE_TITLE =
  "Alert: workflow comments on recurring failures instead of editing the issue body";

describe("issue-comment-spam-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);
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

  it("skips repos with no .github/workflows directory", async () => {
    mockFs.existsSync
      .mockReturnValueOnce(true) // repoDir
      .mockReturnValueOnce(false); // workflowsDir

    await run([repo]);

    expect(mockFs.readdirSync).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("flags workflow with both gh issue create and gh issue comment", async () => {
    mockFs.readdirSync.mockReturnValue(["notify.yml"]);
    mockFs.readFileSync.mockReturnValue(
      'name: Notify\nrun: |\n  gh issue create --title "$TITLE"\n  gh issue comment "$existing" --body "$body"\n',
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      ISSUE_TITLE,
      expect.stringContaining("notify.yml"),
      ["Priority"],
    );
  });

  it("does NOT flag workflow with only gh issue create", async () => {
    mockFs.readdirSync.mockReturnValue(["notify.yml"]);
    mockFs.readFileSync.mockReturnValue(
      'name: Notify\nrun: |\n  gh issue create --title "$TITLE"\n',
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does NOT flag workflow with only gh issue comment", async () => {
    mockFs.readdirSync.mockReturnValue(["notify.yml"]);
    mockFs.readFileSync.mockReturnValue(
      'name: Notify\nrun: |\n  gh issue comment "$existing" --body "$body"\n',
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does NOT flag gh issue close --comment recovery patterns", async () => {
    mockFs.readdirSync.mockReturnValue(["notify.yml"]);
    mockFs.readFileSync.mockReturnValue(
      'name: Notify\nrun: |\n  gh issue create --title "$TITLE"\n  gh issue close "$existing" --comment "Build recovered"\n',
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does NOT flag workflows already using gh issue edit (already migrated)", async () => {
    mockFs.readdirSync.mockReturnValue(["notify.yml"]);
    mockFs.readFileSync.mockReturnValue(
      'name: Notify\nrun: |\n  gh issue create --title "$TITLE"\n  gh issue comment "$existing" --body "$body"\n  gh issue edit "$existing" --body "$new_body"\n',
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("aggregates multiple violating files into one issue", async () => {
    mockFs.readdirSync.mockReturnValue(["notify.yml", "alert.yaml"]);
    mockFs.readFileSync.mockImplementation((p: unknown) => {
      if (typeof p === "string" && p.includes("notify.yml")) {
        return 'name: Notify\nrun: |\n  gh issue create --title "$TITLE"\n  gh issue comment "$existing" --body "$body"\n';
      }
      return 'name: Alert\nrun: |\n  gh issue create --title "$TITLE"\n  gh issue comment "$existing" --body "$body"\n';
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("notify.yml");
    expect(body).toContain("alert.yaml");
  });

  it("skips when matching open issue already exists", async () => {
    mockFs.readdirSync.mockReturnValue(["notify.yml"]);
    mockFs.readFileSync.mockReturnValue(
      'name: Notify\nrun: |\n  gh issue create --title "$TITLE"\n  gh issue comment "$existing" --body "$body"\n',
    );
    mockGh.searchIssues.mockResolvedValue([{ number: 42, title: ISSUE_TITLE }]);

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("reports errors per-repo without crashing the loop", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });

    mockFs.readdirSync.mockReturnValue(["notify.yml"]);
    mockFs.readFileSync.mockReturnValue(
      'name: Notify\nrun: |\n  gh issue create --title "$TITLE"\n  gh issue comment "$existing" --body "$body"\n',
    );
    mockGh.searchIssues
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce([]);

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "issue-comment-spam-scanner:process-repo",
      repo.fullName,
      expect.any(Error),
    );
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo2.fullName,
      expect.any(String),
      expect.any(String),
      ["Priority"],
    );
  });
});
