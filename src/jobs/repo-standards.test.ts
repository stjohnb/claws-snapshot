import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

const LEGACY_LABELS = vi.hoisted(() => new Set([
  "Needs Refinement",
  "Plan Produced",
  "Reviewed",
  "prod-report",
  "investigated",
  "claws-mergeable",
  "claws-error",
]));

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  LEGACY_LABELS,
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockFs, mockGh } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    rmSync: vi.fn(),
  },
  mockGh: {
    ensureAllLabels: vi.fn(),
    deleteStaleLabels: vi.fn(),
    isRateLimited: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);

import { run } from "./repo-standards.js";
import { reportError } from "../error-reporter.js";

describe("repo-standards", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([]);
    mockGh.ensureAllLabels.mockResolvedValue(undefined);
    mockGh.deleteStaleLabels.mockResolvedValue(undefined);
    mockGh.isRateLimited.mockReturnValue(false);
  });

  it("skips repos without local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockGh.ensureAllLabels).not.toHaveBeenCalled();
    expect(mockGh.deleteStaleLabels).not.toHaveBeenCalled();
  });

  it("syncs labels and deletes stale labels for repos with local clone", async () => {
    await run([repo]);

    expect(mockGh.ensureAllLabels).toHaveBeenCalledWith(repo.fullName);
    expect(mockGh.deleteStaleLabels).toHaveBeenCalledWith(repo.fullName, LEGACY_LABELS);
  });

  it("reports errors without crashing the loop", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });

    mockGh.ensureAllLabels
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce(undefined);

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "repo-standards:process-repo",
      repo.fullName,
      expect.any(Error),
    );
    expect(mockGh.ensureAllLabels).toHaveBeenCalledWith(repo2.fullName);
  });

  it("processes multiple repos", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });

    await run([repo, repo2]);

    expect(mockGh.ensureAllLabels).toHaveBeenCalledWith(repo.fullName);
    expect(mockGh.ensureAllLabels).toHaveBeenCalledWith(repo2.fullName);
    expect(mockGh.ensureAllLabels).toHaveBeenCalledTimes(2);
  });

  it("reports errors from deleteStaleLabels without crashing the loop", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });

    mockGh.deleteStaleLabels
      .mockRejectedValueOnce(new Error("label API error"))
      .mockResolvedValueOnce(undefined);

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "repo-standards:process-repo",
      repo.fullName,
      expect.any(Error),
    );
    expect(mockGh.ensureAllLabels).toHaveBeenCalledWith(repo2.fullName);
    expect(mockGh.deleteStaleLabels).toHaveBeenCalledWith(repo2.fullName, LEGACY_LABELS);
  });

  it("syncs labels the same way for SELF_REPO as for other repos", async () => {
    const selfRepo = mockRepo({ fullName: "test-org/self-repo", name: "self-repo" });

    await run([selfRepo]);

    expect(mockGh.ensureAllLabels).toHaveBeenCalledWith("test-org/self-repo");
    expect(mockGh.deleteStaleLabels).toHaveBeenCalledWith("test-org/self-repo", LEGACY_LABELS);
  });

  describe("stale repo cleanup", () => {
    it("removes stale repos not in active list", async () => {
      // repos dir has owner "test-org" with repos "active-repo" and "archived-repo"
      mockFs.readdirSync
        .mockReturnValueOnce(["test-org"])                       // owners in repos/
        .mockReturnValueOnce(["active-repo", "archived-repo"])   // repos under test-org/
        .mockReturnValueOnce(["active-repo", "archived-repo"]);  // remaining after cleanup (for owner cleanup check)

      const activeRepo = mockRepo({ owner: "test-org", name: "active-repo", fullName: "test-org/active-repo" });
      await run([activeRepo]);

      // Should remove archived-repo clone
      expect(mockFs.rmSync).toHaveBeenCalledWith(
        "/home/testuser/.claws/repos/test-org/archived-repo",
        { recursive: true, force: true },
      );
      // Should NOT remove active-repo clone
      expect(mockFs.rmSync).not.toHaveBeenCalledWith(
        "/home/testuser/.claws/repos/test-org/active-repo",
        expect.anything(),
      );
    });

    it("removes worktree directory and pending-ideas file for stale repos", async () => {
      mockFs.readdirSync
        .mockReturnValueOnce(["test-org"])
        .mockReturnValueOnce(["stale-repo"])
        .mockReturnValueOnce([]);  // owner dir now empty

      await run([repo]);

      // Worktree dir removal
      expect(mockFs.rmSync).toHaveBeenCalledWith(
        "/home/testuser/.claws/worktrees/test-org/stale-repo",
        { recursive: true, force: true },
      );
      // Pending-ideas file removal
      expect(mockFs.rmSync).toHaveBeenCalledWith(
        "/home/testuser/.claws/pending-ideas/test-org-stale-repo.json",
      );
    });

    it("removes empty owner directories after cleanup", async () => {
      mockFs.readdirSync
        .mockReturnValueOnce(["stale-org"])
        .mockReturnValueOnce(["stale-repo"])
        .mockReturnValueOnce([])   // repos/stale-org/ is empty
        .mockReturnValueOnce([]);  // worktrees/stale-org/ is empty

      await run([repo]);

      // Empty owner dirs should be cleaned up
      expect(mockFs.rmSync).toHaveBeenCalledWith(
        "/home/testuser/.claws/repos/stale-org",
        { recursive: true, force: true },
      );
      expect(mockFs.rmSync).toHaveBeenCalledWith(
        "/home/testuser/.claws/worktrees/stale-org",
        { recursive: true, force: true },
      );
    });

    it("skips cleanup when repos list is empty", async () => {
      await run([]);

      expect(mockFs.readdirSync).not.toHaveBeenCalled();
      expect(mockFs.rmSync).not.toHaveBeenCalled();
    });

    it("skips cleanup when rate limited", async () => {
      mockGh.isRateLimited.mockReturnValue(true);

      await run([repo]);

      expect(mockFs.readdirSync).not.toHaveBeenCalled();
      expect(mockFs.rmSync).not.toHaveBeenCalled();
    });

    it("reports cleanup errors without crashing", async () => {
      mockFs.readdirSync
        .mockReturnValueOnce(["test-org"])
        .mockReturnValueOnce(["stale-repo"])
        .mockReturnValueOnce([]);  // owner dir empty after

      mockFs.rmSync.mockImplementationOnce(() => {
        throw new Error("permission denied");
      });

      await run([repo]);

      expect(reportError).toHaveBeenCalledWith(
        "repo-standards:cleanup",
        "test-org/stale-repo (repos)",
        expect.any(Error),
      );
    });

    it("still runs cleanup even if label sync had errors", async () => {
      mockGh.ensureAllLabels.mockRejectedValue(new Error("API error"));

      mockFs.readdirSync
        .mockReturnValueOnce(["other-org"])
        .mockReturnValueOnce(["gone-repo"])
        .mockReturnValueOnce([]);

      await run([repo]);

      expect(mockFs.rmSync).toHaveBeenCalledWith(
        "/home/testuser/.claws/repos/other-org/gone-repo",
        { recursive: true, force: true },
      );
    });
  });
});
