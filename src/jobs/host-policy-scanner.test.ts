import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";
import { HOST_POLICY_MARKDOWN } from "../host-policy.js";

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
    readdirSync: vi.fn((): string[] => []),
  },
  mockGh: {
    findIssueByExactTitle: vi.fn(),
    createIssue: vi.fn(),
    addLabel: vi.fn(),
  },
  mockClaude: {
    ensureClone: vi.fn(),
    repoDir: vi.fn((repo: { owner: string; name: string }) => `/home/testuser/.claws/repos/${repo.owner}/${repo.name}`),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);

import { run } from "./host-policy-scanner.js";

const ISSUE_TITLE = "chore: document the automation-host policy for agents";
const REPO_DIR = "/home/testuser/.claws/repos/test-org/test-repo";
const CLAUDE_MD = `${REPO_DIR}/CLAUDE.md`;
const AGENTS_MD = `${REPO_DIR}/AGENTS.md`;

const NON_COMPLIANT_AGENTS_MD = [
  "# My Repo",
  "",
  "## CI toolchain",
  "This repo's CI runs `npm run dev` and `sudo apt-get install` build deps on port 8080.",
].join("\n");

describe("host-policy-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.readdirSync.mockReturnValue([]);
    // By default the clone exists and AGENTS.md is fully compliant.
    mockFs.existsSync.mockImplementation((p: string) => p !== CLAUDE_MD);
    mockFs.readFileSync.mockReturnValue(HOST_POLICY_MARKDOWN);
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createIssue.mockResolvedValue(1);
    mockClaude.ensureClone.mockResolvedValue(REPO_DIR);
  });

  it("skips repos without local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockClaude.ensureClone).not.toHaveBeenCalled();
    expect(mockGh.findIssueByExactTitle).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("does nothing when AGENTS.md does not exist (deferred to claude-config-scanner)", async () => {
    mockFs.existsSync.mockImplementation((p: string) => p !== AGENTS_MD);

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("ignores a legacy CLAUDE.md — AGENTS.md is the only root instructions file", async () => {
    // A repo carrying a compliant CLAUDE.md alongside a non-compliant AGENTS.md is
    // still flagged: the scanner never opens CLAUDE.md.
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation((p: string) =>
      p === CLAUDE_MD ? HOST_POLICY_MARKDOWN : NON_COMPLIANT_AGENTS_MD,
    );

    await run([repo]);

    expect(mockFs.readFileSync).not.toHaveBeenCalledWith(CLAUDE_MD, "utf-8");
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      ISSUE_TITLE,
      expect.stringContaining("No host-policy section found in `AGENTS.md`"),
      [],
    );
  });

  it("stays quiet when the policy is in AGENTS.md", async () => {
    mockFs.readFileSync.mockImplementation((p: string) =>
      p === AGENTS_MD ? HOST_POLICY_MARKDOWN : NON_COMPLIANT_AGENTS_MD,
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("flags a repo whose AGENTS.md lacks the policy", async () => {
    mockFs.readFileSync.mockReturnValue(NON_COMPLIANT_AGENTS_MD);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      ISSUE_TITLE,
      expect.stringContaining("No host-policy section found in `AGENTS.md`"),
      [],
    );
  });

  it("tells the repo to add the policy to AGENTS.md, the only root instructions file", async () => {
    mockFs.readFileSync.mockReturnValue(NON_COMPLIANT_AGENTS_MD);

    await run([repo]);

    const body = mockGh.createIssue.mock.calls[0]![2] as string;
    expect(body).toContain("Add the following to `AGENTS.md`");
    expect(body).not.toContain("Add the following to `CLAUDE.md`");
  });

  it("does nothing when AGENTS.md is fully compliant", async () => {
    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("creates an issue when AGENTS.md is missing the host-policy section", async () => {
    mockFs.readFileSync.mockReturnValue(NON_COMPLIANT_AGENTS_MD);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      ISSUE_TITLE,
      expect.stringContaining("Automation host policy"),
      [],
    );
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      ISSUE_TITLE,
      expect.stringContaining("port 3000"),
      [],
    );
  });

  it("says no host-policy section was found when AGENTS.md has no such heading", async () => {
    mockFs.readFileSync.mockReturnValue(NON_COMPLIANT_AGENTS_MD);

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      ISSUE_TITLE,
      expect.stringContaining("No host-policy section found in `AGENTS.md`"),
      [],
    );
  });

  it("says which file was inspected when a host-policy section exists but is incomplete", async () => {
    mockFs.readFileSync.mockReturnValue(
      ["# My Repo", "", "## Automation host policy", "", "Do not run `npm run dev` here."].join("\n"),
    );

    await run([repo]);

    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      ISSUE_TITLE,
      expect.stringContaining("Inspected `AGENTS.md`"),
      [],
    );
  });

  it("does nothing when the policy is found in .claude/rules/agents.md instead of AGENTS.md", async () => {
    mockFs.readdirSync.mockReturnValue(["agents.md"]);
    mockFs.readFileSync.mockImplementation((p: string) =>
      p === `${REPO_DIR}/.claude/rules/agents.md` ? HOST_POLICY_MARKDOWN : NON_COMPLIANT_AGENTS_MD,
    );

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("skips when an open issue already exists", async () => {
    mockFs.readFileSync.mockReturnValue(NON_COMPLIANT_AGENTS_MD);
    mockGh.findIssueByExactTitle.mockResolvedValue({ number: 5, title: ISSUE_TITLE, labels: [] });

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });
});
