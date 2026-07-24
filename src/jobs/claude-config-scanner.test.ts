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
  },
  mockGh: {
    findIssueByExactTitle: vi.fn(),
    createIssue: vi.fn(),
  },
  mockClaude: {
    ensureClone: vi.fn(),
    repoDir: vi.fn((repo: { owner: string; name: string }) => `/home/testuser/.claws/repos/${repo.owner}/${repo.name}`),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);

import { run } from "./claude-config-scanner.js";

describe("claude-config-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createIssue.mockResolvedValue(1);
    mockClaude.ensureClone.mockResolvedValue("/home/testuser/.claws/repos/test-org/test-repo");
  });

  it("skips repos without local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockClaude.ensureClone).not.toHaveBeenCalled();
    expect(mockGh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does not create issue when all four files are present", async () => {
    mockFs.existsSync.mockImplementation((p: string) => true);

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("creates issue listing only CLAUDE.md when only CLAUDE.md is missing", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if ((p as string).endsWith("CLAUDE.md")) return false;
      return true;
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toMatch(/- \[ \] `CLAUDE\.md`/);
    expect(body).not.toMatch(/- \[ \] .*issue-refiner/);
    expect(body).not.toMatch(/- \[ \] .*issue-implementer/);
    expect(body).not.toMatch(/- \[ \] .*pr-reviewer/);
  });

  it("creates issue listing only issue-refiner.md when only refiner is missing", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if ((p as string).endsWith("issue-refiner.md")) return false;
      return true;
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toMatch(/- \[ \] .*issue-refiner/);
    expect(body).not.toMatch(/- \[ \] .*issue-implementer/);
    expect(body).not.toMatch(/- \[ \] `CLAUDE\.md`/);
    expect(body).not.toMatch(/- \[ \] .*pr-reviewer/);
  });

  it("creates issue listing only issue-implementer.md when only implementer is missing", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if ((p as string).endsWith("issue-implementer.md")) return false;
      return true;
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toMatch(/- \[ \] .*issue-implementer/);
    expect(body).not.toMatch(/- \[ \] .*issue-refiner/);
    expect(body).not.toMatch(/- \[ \] `CLAUDE\.md`/);
    expect(body).not.toMatch(/- \[ \] .*pr-reviewer/);
  });

  it("creates issue listing only pr-reviewer.md when only reviewer is missing", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if ((p as string).endsWith("pr-reviewer.md")) return false;
      return true;
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toMatch(/- \[ \] .*pr-reviewer/);
    expect(body).not.toMatch(/- \[ \] .*issue-refiner/);
    expect(body).not.toMatch(/- \[ \] .*issue-implementer/);
    expect(body).not.toMatch(/- \[ \] `CLAUDE\.md`/);
  });

  it("creates issue listing all four files when all are missing", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if ((p as string).endsWith("CLAUDE.md")) return false;
      if ((p as string).endsWith("issue-refiner.md")) return false;
      if ((p as string).endsWith("issue-implementer.md")) return false;
      if ((p as string).endsWith("pr-reviewer.md")) return false;
      return true;
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toMatch(/- \[ \] `CLAUDE\.md`/);
    expect(body).toMatch(/- \[ \] .*issue-refiner/);
    expect(body).toMatch(/- \[ \] .*issue-implementer/);
    expect(body).toMatch(/- \[ \] .*pr-reviewer/);
  });

  it("skips issue creation when a matching open issue already exists", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if ((p as string).endsWith("CLAUDE.md")) return false;
      return true;
    });
    mockGh.findIssueByExactTitle.mockResolvedValue(
      { number: 42, title: "Alert: missing Claude agent configuration" },
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });
});
