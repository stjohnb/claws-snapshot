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

const { mockGh } = vi.hoisted(() => ({
  mockGh: {
    getPRCheckStatus: vi.fn(),
    hasValidLGTM: vi.fn(),
    mergePR: vi.fn(),
    removeLabel: vi.fn(),
    getPRChangedFiles: vi.fn(),
    getPRMergeableState: vi.fn(),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    hasIgnoreLabel: vi.fn().mockReturnValue(false),
    isForkPR: vi.fn().mockReturnValue(false),
    isDependabotPR: vi.fn().mockImplementation((pr: { author: { login: string } }) =>
      pr.author.login === "dependabot[bot]" || pr.author.login === "app/dependabot",
    ),
    populateQueueCache: vi.fn(),
    removeQueueItem: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGh);

import { tryMerge } from "./auto-merger.js";
import * as log from "../log.js";

describe("auto-merger", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.getPRCheckStatus.mockResolvedValue("pending");
    mockGh.hasValidLGTM.mockResolvedValue(false);
    mockGh.mergePR.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.getPRChangedFiles.mockResolvedValue([]);
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.isForkPR.mockReturnValue(false);
  });

  it("merges dependabot PR when checks pass", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
  });

  it("merges dependabot PR with app/ login format", async () => {
    const pr = mockPR({ author: { login: "app/dependabot" } });
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
  });

  it("merges dependabot PR when no checks exist (app/ format)", async () => {
    const pr = mockPR({ author: { login: "app/dependabot" } });
    mockGh.getPRCheckStatus.mockResolvedValue("none");

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
  });

  it("merges dependabot PR when no checks exist (bot format)", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockGh.getPRCheckStatus.mockResolvedValue("none");

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
  });

  it("merges Claws PR when checks pass and LGTM is valid", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await tryMerge(repo, pr);

    expect(mockGh.hasValidLGTM).toHaveBeenCalledWith(repo.fullName, pr.number, "main");
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("skips Claws PR without valid LGTM", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42" });
    mockGh.hasValidLGTM.mockResolvedValue(false);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.hasValidLGTM).toHaveBeenCalledWith(repo.fullName, pr.number, "main");
    expect(mockGh.getPRCheckStatus).not.toHaveBeenCalled();
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips PR when checks are pending", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockGh.getPRCheckStatus.mockResolvedValue("pending");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips PR when checks have failed", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockGh.getPRCheckStatus.mockResolvedValue("failing");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      `[auto-merger] Checks failed for ${repo.fullName}#${pr.number}, skipping`,
    );
  });

  it("skips fork PRs (cross-repository)", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" }, isCrossRepository: true });
    mockGh.isForkPR.mockReturnValue(true);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("merges any PR with valid LGTM when checks pass", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await tryMerge(repo, pr);

    expect(mockGh.hasValidLGTM).toHaveBeenCalledWith(repo.fullName, pr.number, "main");
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("skips any PR without valid LGTM", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
    mockGh.hasValidLGTM.mockResolvedValue(false);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.hasValidLGTM).toHaveBeenCalledWith(repo.fullName, pr.number, "main");
    expect(mockGh.getPRCheckStatus).not.toHaveBeenCalled();
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips LGTM PR when checks are failing", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockGh.getPRCheckStatus.mockResolvedValue("failing");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips LGTM PR when checks are pending", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockGh.getPRCheckStatus.mockResolvedValue("pending");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("does not merge LGTM PR when checks are 'none'", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockGh.getPRCheckStatus.mockResolvedValue("none");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("does not remove In Review label for non-claws-issue PRs", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "claws/improve-something" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("merges improve PR with valid LGTM when checks pass", async () => {
    const pr = mockPR({ headRefName: "claws/improve-performance" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await tryMerge(repo, pr);

    expect(mockGh.hasValidLGTM).toHaveBeenCalledWith(repo.fullName, pr.number, "main");
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("removes In Review label from source issue after merging Claws PR", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42-ab12" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 42, "In Review");
  });

  it("does not remove In Review label for Dependabot PRs", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" }, headRefName: "dependabot/npm/lodash-4.17.21" });
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("merges doc PR when no checks exist and files are doc-only", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md", "docs/api.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("none");

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges doc PR when checks are passing and files are doc-only", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md", "README.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("skips doc PR when checks are failing", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("failing");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips doc PR when checks are pending", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("pending");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips doc PR with non-doc file changes", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md", "src/index.ts"]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.getPRCheckStatus).not.toHaveBeenCalled();
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips doc PR with empty changed files", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue([]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("does not require LGTM for doc PRs", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("none");

    await tryMerge(repo, pr);

    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges idea-collection PR when checks pass and files are ideas-only", async () => {
    const pr = mockPR({ headRefName: "claws/ideas-collect-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["ideas/focus-areas.md", "ideas/potential.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("passing");

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges idea-collection PR when no checks exist and files are ideas-only", async () => {
    const pr = mockPR({ headRefName: "claws/ideas-collect-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["ideas/focus-areas.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("none");

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("skips idea-collection PR when checks are failing", async () => {
    const pr = mockPR({ headRefName: "claws/ideas-collect-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["ideas/focus-areas.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("failing");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips idea-collection PR when checks are pending", async () => {
    const pr = mockPR({ headRefName: "claws/ideas-collect-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["ideas/focus-areas.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("pending");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips idea-collection PR with non-ideas file changes", async () => {
    const pr = mockPR({ headRefName: "claws/ideas-collect-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["ideas/focus-areas.md", "src/index.ts"]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips idea-collection PR with empty changed files", async () => {
    const pr = mockPR({ headRefName: "claws/ideas-collect-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue([]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("does not require LGTM for idea-collection PRs", async () => {
    const pr = mockPR({ headRefName: "claws/ideas-collect-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["ideas/potential.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("none");

    await tryMerge(repo, pr);

    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("skips PR with merge conflicts", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} has merge conflicts, skipping (ci-fixer will resolve)`,
    );
  });

  it("skips PR when mergeable state is UNKNOWN after retries", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.getPRMergeableState.mockResolvedValue("UNKNOWN");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} mergeable state still UNKNOWN after retries, skipping`,
    );
  });

  it("skips PR when mergePR throws not-mergeable error", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.mergePR.mockRejectedValue(new Error("GraphQL: Pull Request is not mergeable (mergePullRequest)"));

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} was not mergeable at merge time, skipping`,
    );
  });

  it("rethrows non-mergeable errors from mergePR", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.mergePR.mockRejectedValue(new Error("GraphQL: Some other unexpected error"));

    await expect(tryMerge(repo, pr)).rejects.toThrow("Some other unexpected error");
    expect(mockGh.removeQueueItem).not.toHaveBeenCalled();
  });

  it("logs reason when fork PR is skipped", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" }, isCrossRepository: true });
    mockGh.isForkPR.mockReturnValue(true);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: fork PR`,
    );
  });

  it("logs reason when PR is skipped due to missing LGTM", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
    mockGh.hasValidLGTM.mockResolvedValue(false);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: no valid LGTM`,
    );
  });

  it("logs reason when doc PR is skipped due to pending checks", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockGh.getPRCheckStatus.mockResolvedValue("pending");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: checks status=pending`,
    );
  });

  it("merges auto-bump PR without LGTM when checks pass and files are deployment-only", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-1.2.3",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml"]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(true);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges auto-bump PR using the base/overlay layout (apps/<app>/base/deployment.yaml)", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-v2026-06-10.5",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockGh.getPRCheckStatus.mockResolvedValue("passing");
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/base/deployment.yaml"]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(true);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("does not merge auto-bump PR when checks are not passing", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-1.2.3",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml"]);

    mockGh.getPRCheckStatus.mockResolvedValue("none");
    let result = await tryMerge(repo, pr);
    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml"]);
    mockGh.getPRCheckStatus.mockResolvedValue("pending");
    result = await tryMerge(repo, pr);
    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips auto-bump PR touching non-bump files", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-1.2.3",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml", "terraform/main.tf"]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(mockGh.getPRCheckStatus).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      `[auto-merger] Auto-bump PR ${repo.fullName}#${pr.number} touches non-bump files, skipping`,
    );
  });

  it("skips auto-bump PR with empty changed files", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-1.2.3",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockGh.getPRChangedFiles.mockResolvedValue([]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.getPRCheckStatus).not.toHaveBeenCalled();
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("requires LGTM for PR with auto-bump and major-update labels", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-2.0.0",
      labels: [{ name: "auto-bump" }, { name: "major-update" }],
    });
    mockGh.hasValidLGTM.mockResolvedValue(false);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.hasValidLGTM).toHaveBeenCalledWith(repo.fullName, pr.number, "main");
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("does not double-log skip reason when checks are failing", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockGh.getPRCheckStatus.mockResolvedValue("failing");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("skipped: checks status="),
    );
  });
});
