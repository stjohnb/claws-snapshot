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
  LABEL_SPECS: {
    "Refined": { color: "0075ca", description: "Issue is ready for claws to implement" },
  },
  SELF_REPO: "test-org/self-repo",
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
  },
  mockGh: {
    ensureAllLabels: vi.fn(),
    deleteStaleLabels: vi.fn(),
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
    mockGh.ensureAllLabels.mockResolvedValue(undefined);
    mockGh.deleteStaleLabels.mockResolvedValue(undefined);
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
});
