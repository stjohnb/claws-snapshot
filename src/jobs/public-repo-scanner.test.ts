import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  LABELS: { priority: "Priority" },
  SELF_REPO: "St-John-Software/claws",
  isJobDisabledForRepo: vi.fn(() => false),
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

vi.mock("../smart-schedule.js", () => ({
  localDateString: vi.fn(() => "2026-06-11"),
}));

const { mockFs, mockGh, mockClaude, mockDb, mockOccurrence, mockGetModel, mockClassifyComplexity } =
  vi.hoisted(() => ({
    mockFs: {
      existsSync: vi.fn(),
    },
    mockGh: {
      listPublicReposIncludingArchived: vi.fn(),
    },
    mockClaude: {
      ensureClone: vi.fn(),
      withNewWorktree: vi.fn(),
      runClaude: vi.fn(),
      writeClawsMcpConfig: vi.fn(() => "/wt/mcp.json"),
      randomSuffix: vi.fn(() => "abc123"),
    },
    mockDb: {
      getLastProcessedTimestampsForJob: vi.fn(),
      markRepoProcessedDaily: vi.fn(),
      withTaskRecording: vi.fn(),
      updateTaskWorktree: vi.fn(),
      updateTaskModel: vi.fn(),
      updateTaskTokenUsage: vi.fn(),
      trackTaskTokens: vi.fn().mockReturnValue(vi.fn()),
      recordTaskComplete: vi.fn(),
    },
    mockOccurrence: {
      ensureAlertIssue: vi.fn(),
    },
    mockGetModel: vi.fn(() => "opus"),
    mockClassifyComplexity: vi.fn(async () => "sonnet"),
  }));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);
vi.mock("../occurrence-tracking.js", () => mockOccurrence);
vi.mock("../model-selector.js", () => ({ getModel: mockGetModel }));
vi.mock("../classify-complexity.js", () => ({ classifyComplexity: mockClassifyComplexity }));

import { run, buildPrompt } from "./public-repo-scanner.js";
import { reportError } from "../error-reporter.js";

function publicRepo(overrides: Record<string, unknown> = {}) {
  return {
    owner: "stjohnb",
    name: "demo",
    fullName: "stjohnb/demo",
    defaultBranch: "main",
    isArchived: false,
    ...overrides,
  };
}

const CLEAN_OUTPUT = '```json\n{ "findings": [] }\n```';
const FINDING_OUTPUT =
  '```json\n{ "findings": [ { "title": "AWS key committed", "location": "config.js:12", "kind": "AWS access key", "severity": "high", "detail": "Live AKIA… key in source" } ] }\n```';

describe("public-repo-scanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockClaude.ensureClone.mockResolvedValue("/home/testuser/.claws/repos/stjohnb/demo");
    // Pass-through wrappers that invoke their callbacks.
    mockClaude.withNewWorktree.mockImplementation(
      async (_repo: unknown, _branch: unknown, _ns: unknown, fn: (wt: string) => Promise<unknown>) =>
        fn("/wt"),
    );
    mockDb.withTaskRecording.mockImplementation(
      async (_n: unknown, _r: unknown, _i: unknown, _t: unknown, fn: (id: number) => Promise<unknown>) =>
        fn(1),
    );
    mockDb.getLastProcessedTimestampsForJob.mockReturnValue(new Map());
    mockOccurrence.ensureAlertIssue.mockResolvedValue({ outcome: "created", issueNumber: 1 });
  });

  it("files no alert when the repo is clean", async () => {
    mockGh.listPublicReposIncludingArchived.mockResolvedValue([publicRepo()]);
    mockClaude.runClaude.mockResolvedValue(CLEAN_OUTPUT);

    await run();

    expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    expect(mockClaude.writeClawsMcpConfig).not.toHaveBeenCalled();
    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
      "public-repo-scanner",
      "stjohnb/demo",
      "2026-06-11",
    );
  });

  it("files an alert against the repo itself for findings on a non-archived repo", async () => {
    mockGh.listPublicReposIncludingArchived.mockResolvedValue([publicRepo()]);
    mockClaude.runClaude.mockResolvedValue(FINDING_OUTPUT);

    await run();

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    const opts = mockOccurrence.ensureAlertIssue.mock.calls[0]![0];
    expect(opts.repo).toBe("stjohnb/demo");
    expect(opts.title).toBe("Alert: potential sensitive information in public repo");
    expect(opts.body).toContain("AWS access key");
  });

  it("routes findings on an archived repo to SELF_REPO with a repo-named title", async () => {
    mockGh.listPublicReposIncludingArchived.mockResolvedValue([
      publicRepo({ fullName: "stjohnb/old", name: "old", isArchived: true }),
    ]);
    mockClaude.ensureClone.mockResolvedValue("/home/testuser/.claws/repos/stjohnb/old");
    mockClaude.runClaude.mockResolvedValue(FINDING_OUTPUT);

    await run();

    expect(mockOccurrence.ensureAlertIssue).toHaveBeenCalledTimes(1);
    const opts = mockOccurrence.ensureAlertIssue.mock.calls[0]![0];
    expect(opts.repo).toBe("St-John-Software/claws");
    expect(opts.title).toBe("Alert: sensitive information in archived public repo stjohnb/old");
    expect(opts.body).toContain("unarchive");
  });

  it("does not file against SELF_REPO when an archived repo is clean", async () => {
    mockGh.listPublicReposIncludingArchived.mockResolvedValue([
      publicRepo({ fullName: "stjohnb/old", name: "old", isArchived: true }),
    ]);
    mockClaude.ensureClone.mockResolvedValue("/home/testuser/.claws/repos/stjohnb/old");
    mockClaude.runClaude.mockResolvedValue(CLEAN_OUTPUT);

    await run();

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
  });

  it("skips runClaude and ensureAlertIssue but still marks processed when repoDir absent after clone", async () => {
    mockGh.listPublicReposIncludingArchived.mockResolvedValue([publicRepo()]);
    mockFs.existsSync.mockReturnValue(false);

    await run();

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledWith(
      "public-repo-scanner",
      "stjohnb/demo",
      "2026-06-11",
    );
  });

  it("skips repos scanned within the rescan interval", async () => {
    mockGh.listPublicReposIncludingArchived.mockResolvedValue([publicRepo()]);
    mockDb.getLastProcessedTimestampsForJob.mockReturnValue(
      new Map([["stjohnb/demo", Date.now()]]),
    );

    await run();

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
  });

  it("handles malformed Claude JSON without throwing or filing", async () => {
    mockGh.listPublicReposIncludingArchived.mockResolvedValue([publicRepo()]);
    mockClaude.runClaude.mockResolvedValue("not json at all");

    await expect(run()).resolves.toBeUndefined();

    expect(mockOccurrence.ensureAlertIssue).not.toHaveBeenCalled();
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledTimes(1);
  });

  it("buildPrompt includes git ls-files guard to avoid untracked artifacts", () => {
    const prompt = buildPrompt("o/r", false);
    expect(prompt).toContain("git ls-files");
    expect(prompt).toContain(".mcp-claws.json");
  });

  it("calls reportError and still marks processed when processRepoInner throws", async () => {
    mockGh.listPublicReposIncludingArchived.mockResolvedValue([publicRepo()]);
    mockClaude.ensureClone.mockRejectedValue(new Error("network failure"));

    await run();

    expect(reportError).toHaveBeenCalledWith(
      "public-repo-scanner:process-repo",
      "stjohnb/demo",
      expect.any(Error),
    );
    expect(mockDb.markRepoProcessedDaily).toHaveBeenCalledTimes(1);
  });
});
