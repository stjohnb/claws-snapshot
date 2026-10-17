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
    readFileSync: vi.fn(),
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
    // Default layout is the compliant one: AGENTS.md and the role docs exist, and the
    // legacy CLAUDE.md is gone.
    mockFs.existsSync.mockImplementation((p: string) => !(p as string).endsWith("CLAUDE.md"));
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

  it("does not create issue when AGENTS.md and canonical role files are present", async () => {
    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("creates issue listing root instructions when AGENTS.md does not exist", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if ((p as string).endsWith("CLAUDE.md") || (p as string).endsWith("AGENTS.md")) return false;
      return true;
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toMatch(/- \[ \] `AGENTS\.md` at the repo root/);
    expect(body).not.toMatch(/- \[ \] .*issue-refiner/);
    expect(body).not.toMatch(/- \[ \] .*issue-implementer/);
    expect(body).not.toMatch(/- \[ \] .*pr-reviewer/);
  });

  it("creates issue listing only issue-refiner.md when it is missing", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if ((p as string).endsWith("issue-refiner.md")) return false;
      return true;
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toMatch(/- \[ \] Add `\.agents\/issue-refiner\.md`/);
    expect(body).not.toMatch(/- \[ \] .*issue-implementer/);
    expect(body).not.toMatch(/- \[ \] `AGENTS\.md` at the repo root/);
    expect(body).not.toMatch(/- \[ \] .*pr-reviewer/);
  });

  it("creates issue listing only issue-implementer.md when it is missing", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if ((p as string).endsWith("issue-implementer.md")) return false;
      return true;
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toMatch(/- \[ \] Add `\.agents\/issue-implementer\.md`/);
    expect(body).not.toMatch(/- \[ \] .*issue-refiner/);
    expect(body).not.toMatch(/- \[ \] `AGENTS\.md` at the repo root/);
    expect(body).not.toMatch(/- \[ \] .*pr-reviewer/);
  });

  it("creates issue listing only pr-reviewer.md when it is missing", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if ((p as string).endsWith("pr-reviewer.md")) return false;
      return true;
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toMatch(/- \[ \] Add `\.agents\/pr-reviewer\.md`/);
    expect(body).not.toMatch(/- \[ \] .*issue-refiner/);
    expect(body).not.toMatch(/- \[ \] .*issue-implementer/);
    expect(body).not.toMatch(/- \[ \] `AGENTS\.md` at the repo root/);
  });

  it("reports a repo with only .claude/agents role docs as missing", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if ((p as string).includes("/.agents/")) return false;
      return true;
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toMatch(/- \[ \] Add `\.agents\/issue-refiner\.md`/);
    expect(body).toMatch(/- \[ \] Add `\.agents\/issue-implementer\.md`/);
    expect(body).toMatch(/- \[ \] Add `\.agents\/pr-reviewer\.md`/);
    expect(body).not.toMatch(/`AGENTS\.md` at the repo root/);
    expect(body).not.toMatch(/\.claude\/agents/);
  });

  it("creates issue listing all four entries when all are missing", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if ((p as string).endsWith("CLAUDE.md") || (p as string).endsWith("AGENTS.md")) return false;
      if ((p as string).endsWith("issue-refiner.md")) return false;
      if ((p as string).endsWith("issue-implementer.md")) return false;
      if ((p as string).endsWith("pr-reviewer.md")) return false;
      return true;
    });

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toMatch(/- \[ \] `AGENTS\.md` at the repo root/);
    expect(body).toMatch(/- \[ \] Add `\.agents\/issue-refiner\.md`/);
    expect(body).toMatch(/- \[ \] Add `\.agents\/issue-implementer\.md`/);
    expect(body).toMatch(/- \[ \] Add `\.agents\/pr-reviewer\.md`/);
  });

  it("asks for AGENTS.md and deletion when only CLAUDE.md exists", async () => {
    mockFs.existsSync.mockImplementation((p: string) => !(p as string).endsWith("AGENTS.md"));

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toMatch(/- \[ \] `AGENTS\.md` at the repo root/);
    expect(body).toMatch(/- \[ \] `CLAUDE\.md` still exists/);
  });

  it("flags a CLAUDE.md that is only the @AGENTS.md include", async () => {
    mockFs.existsSync.mockReturnValue(true);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toMatch(/- \[ \] `CLAUDE\.md` still exists/);
    expect(body).not.toMatch(/- \[ \] `AGENTS\.md` at the repo root/);
  });

  it("never reads CLAUDE.md — its mere existence is the finding", async () => {
    mockFs.existsSync.mockReturnValue(true);

    await run([repo]);

    expect(mockFs.readFileSync).not.toHaveBeenCalled();
  });

  it("does not offer CLAUDE.md in the recommended layout", async () => {
    mockFs.existsSync.mockReturnValue(true);

    await run([repo]);

    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toMatch(/├── AGENTS\.md/);
    expect(body).not.toMatch(/├── CLAUDE\.md/);
  });

  it("skips issue creation when a matching open issue already exists", async () => {
    mockFs.existsSync.mockImplementation((p: string) => {
      if ((p as string).endsWith("CLAUDE.md") || (p as string).endsWith("AGENTS.md")) return false;
      return true;
    });
    mockGh.findIssueByExactTitle.mockResolvedValue(
      { number: 42, title: "Alert: missing Claude agent configuration", labels: [] },
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });
});
