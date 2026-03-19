import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    inReview: "In Review",
  },
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockGh } = vi.hoisted(() => ({
  mockGh: {
    listPRs: vi.fn(),
    getPRCheckStatus: vi.fn(),
    hasValidLGTM: vi.fn(),
    mergePR: vi.fn(),
    removeLabel: vi.fn(),
    getPRChangedFiles: vi.fn(),
    isRateLimited: vi.fn().mockReturnValue(false),
    isItemSkipped: vi.fn().mockReturnValue(false),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    populateQueueCache: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGh);

import { run } from "./auto-merger.js";
import { reportError } from "../error-reporter.js";
import * as log from "../log.js";

describe("auto-merger", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.getPRCheckStatus.mockResolvedValue("pending");
    mockGh.hasValidLGTM.mockResolvedValue(false);
    mockGh.mergePR.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.getPRChangedFiles.mockResolvedValue([]);
  });

  it("merges dependabot PR when checks pass", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await run([repo]);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
  });

  it("merges Claws PR when checks pass and LGTM is valid", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await run([repo]);

    expect(mockGh.hasValidLGTM).toHaveBeenCalledWith(repo.fullName, pr.number, "main");
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("skips Claws PR without valid LGTM", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.hasValidLGTM.mockResolvedValue(false);

    await run([repo]);

    expect(mockGh.hasValidLGTM).toHaveBeenCalledWith(repo.fullName, pr.number, "main");
    expect(mockGh.getPRCheckStatus).not.toHaveBeenCalled();
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips PR when checks are pending", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRCheckStatus.mockResolvedValue("pending");

    await run([repo]);

    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips PR when checks have failed", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRCheckStatus.mockResolvedValue("failing");

    await run([repo]);

    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      `[auto-merger] Checks failed for ${repo.fullName}#${pr.number}, skipping`,
    );
  });

  it("skips non-dependabot, non-claws PRs", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
    mockGh.listPRs.mockResolvedValue([pr]);

    await run([repo]);

    expect(mockGh.getPRCheckStatus).not.toHaveBeenCalled();
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("reports errors without crashing the loop", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });
    const pr = mockPR({ author: { login: "dependabot[bot]" } });

    mockGh.listPRs
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce([pr]);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith("auto-merger:list-prs", repo.fullName, expect.any(Error));
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo2.fullName, pr.number);
  });

  it("removes In Review label from source issue after merging Claws PR", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42-ab12" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await run([repo]);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 42, "In Review");
  });

  it("does not remove In Review label for Dependabot PRs", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" }, headRefName: "dependabot/npm/lodash-4.17.21" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await run([repo]);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("merges doc PR when no checks exist and files are doc-only", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md", "docs/api.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("none");

    await run([repo]);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges doc PR when checks are passing and files are doc-only", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md", "README.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await run([repo]);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("skips doc PR when checks are failing", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("failing");

    await run([repo]);

    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      `[auto-merger] Checks failed for ${repo.fullName}#${pr.number}, skipping`,
    );
  });

  it("skips doc PR when checks are pending", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("pending");

    await run([repo]);

    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips doc PR with non-doc file changes", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md", "src/index.ts"]);

    await run([repo]);

    expect(mockGh.getPRCheckStatus).not.toHaveBeenCalled();
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      `[auto-merger] Doc PR ${repo.fullName}#${pr.number} contains non-doc changes, skipping`,
    );
  });

  it("skips doc PR with empty changed files", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRChangedFiles.mockResolvedValue([]);

    await run([repo]);

    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("does not require LGTM for doc PRs", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("none");

    await run([repo]);

    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
  });
});
