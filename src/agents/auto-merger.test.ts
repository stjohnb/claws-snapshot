import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

/** Full names the config mock should treat as Forgejo-hosted; per-test opt-in. */
const mockForgejoRepos = vi.hoisted(() => new Set<string>());
vi.mock("../config.js", () => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    inReview: "In Review",
    manualAction: "Manual Action",
    automerge: "Automerge",
  },
  prUrl: (fullName: string, prNumber: number) =>
    mockForgejoRepos.has(fullName)
      ? `https://git.example.com/${fullName}/pulls/${prNumber}`
      : `https://github.com/${fullName}/pull/${prNumber}`,
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockGh } = vi.hoisted(() => ({
  mockGh: {
    getPRMergeGate: vi.fn(),
    haveChecksSettled: vi.fn(),
    hasValidLGTM: vi.fn(),
    mergePR: vi.fn(),
    removeLabel: vi.fn(),
    getPRChangedFiles: vi.fn(),
    getPRDiff: vi.fn(),
    getPRMergeableState: vi.fn(),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    hasIgnoreLabel: vi.fn().mockReturnValue(false),
    isParked: vi.fn().mockReturnValue(false),
    isForkPR: vi.fn().mockReturnValue(false),
    isDependabotPR: vi.fn().mockImplementation((pr: { author: { login: string } }) =>
      pr.author.login === "dependabot[bot]" || pr.author.login === "app/dependabot",
    ),
    populateQueueCache: vi.fn(),
    removeQueueItem: vi.fn(),
    getPRReviewStatus: vi.fn(),
    getPRHeadSHA: vi.fn(),
    infraPathsIn: vi.fn((f: string[]) => f.filter((p) => /(?:^|\/)(?:tofu|terraform)\/|\.tfvars?$|\.tf$/.test(p))),
    getPRBody: vi.fn().mockResolvedValue(""),
    commentOnIssue: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGh);

const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../slack.js", () => ({ notify: mockNotify }));

import { tryMerge, isImagePinOnlyDiff } from "./auto-merger.js";
import * as log from "../log.js";

const HEAD_SHA = "abc1234def";

/** A synthetic image-pin-only unified diff for the given manifest paths. */
function imagePinDiff(files: string[], from = "v1.0.0", to = "v1.0.1"): string {
  return files.map((f) => [
    `diff --git a/${f} b/${f}`,
    `index 1111111..2222222 100644`,
    `--- a/${f}`,
    `+++ b/${f}`,
    `@@ -10,7 +10,7 @@ spec:`,
    `         - name: app`,
    `-          image: ghcr.io/st-john-software/app:${from}`,
    `+          image: ghcr.io/st-john-software/app:${to}`,
    `           imagePullPolicy: IfNotPresent`,
  ].join("\n")).join("\n");
}

interface MergeGate {
  state: string;
  headSha: string;
  labels: string[];
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checkStatus: "passing" | "failing" | "pending" | "none";
  checksTotal: number;
}

/** Set the live merge-gate read `tryMerge` performs immediately before merging. */
function mockMergeGate(over: Partial<MergeGate> = {}): void {
  mockGh.getPRMergeGate.mockResolvedValue({
    state: "OPEN",
    headSha: HEAD_SHA,
    labels: [],
    mergeable: "MERGEABLE",
    checkStatus: "pending",
    checksTotal: 1,
    ...over,
  });
}

describe("auto-merger", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockMergeGate({ checkStatus: "pending" });
    // Default: head commit is an hour old, so a "none" rollup means "no CI here".
    mockGh.haveChecksSettled.mockResolvedValue({ settled: true, age: "3600s" });
    mockGh.hasValidLGTM.mockResolvedValue(false);
    mockGh.mergePR.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.getPRChangedFiles.mockResolvedValue([]);
    mockGh.getPRDiff.mockResolvedValue("");
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.isForkPR.mockReturnValue(false);
    mockGh.getPRReviewStatus.mockResolvedValue({ status: "none", issueCount: 0, reviewedCommit: null });
    mockGh.getPRHeadSHA.mockResolvedValue("abc1234");
  });

  it("merges dependabot PR when checks pass", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
  });

  it("merges dependabot PR with app/ login format", async () => {
    const pr = mockPR({ author: { login: "app/dependabot" } });
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
  });

  it("merges dependabot PR when no checks exist (app/ format)", async () => {
    const pr = mockPR({ author: { login: "app/dependabot" } });
    mockMergeGate({ checkStatus: "none" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
  });

  it("merges dependabot PR when no checks exist (bot format)", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockMergeGate({ checkStatus: "none" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
  });

  it("merges Claws PR when checks pass and LGTM is valid", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.hasValidLGTM).toHaveBeenCalledWith(repo.fullName, pr.number, "main");
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("skips Claws PR without valid LGTM", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42" });
    mockGh.hasValidLGTM.mockResolvedValue(false);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.hasValidLGTM).toHaveBeenCalledWith(repo.fullName, pr.number, "main");
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips PR when checks are pending", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockMergeGate({ checkStatus: "pending" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips PR when checks have failed", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockMergeGate({ checkStatus: "failing" });

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
    mockMergeGate({ checkStatus: "passing" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("merges any PR with valid LGTM when checks pass", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.hasValidLGTM).toHaveBeenCalledWith(repo.fullName, pr.number, "main");
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("skips any PR without valid LGTM", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
    mockGh.hasValidLGTM.mockResolvedValue(false);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.hasValidLGTM).toHaveBeenCalledWith(repo.fullName, pr.number, "main");
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips LGTM PR when checks are failing", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockMergeGate({ checkStatus: "failing" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips LGTM PR when checks are pending", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockMergeGate({ checkStatus: "pending" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("does not merge LGTM PR when checks are 'none'", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockMergeGate({ checkStatus: "none" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("does not remove In Review label for non-claws-issue PRs", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "claws/improve-something" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("merges improve PR with valid LGTM when checks pass", async () => {
    const pr = mockPR({ headRefName: "claws/improve-performance" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.hasValidLGTM).toHaveBeenCalledWith(repo.fullName, pr.number, "main");
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("removes In Review label from source issue after merging Claws PR", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42-ab12" });
    mockGh.hasValidLGTM.mockResolvedValue(true);
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 42, "In Review");
  });

  it("does not remove In Review label for Dependabot PRs", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" }, headRefName: "dependabot/npm/lodash-4.17.21" });
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("merges doc PR when no checks exist and files are doc-only", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md", "docs/api.md"]);
    mockMergeGate({ checkStatus: "none" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges doc PR when checks are passing and files are doc-only", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md", "README.md"]);
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("skips doc PR when checks are failing", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockMergeGate({ checkStatus: "failing" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips doc PR when checks are pending", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockMergeGate({ checkStatus: "pending" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips doc PR with non-doc file changes", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md", "src/index.ts"]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
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
    mockMergeGate({ checkStatus: "none" });

    await tryMerge(repo, pr);

    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges idea-collection PR when checks pass and files are ideas-only", async () => {
    const pr = mockPR({ headRefName: "claws/ideas-collect-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["ideas/focus-areas.md", "ideas/potential.md"]);
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges idea-collection PR when no checks exist and files are ideas-only", async () => {
    const pr = mockPR({ headRefName: "claws/ideas-collect-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["ideas/focus-areas.md"]);
    mockMergeGate({ checkStatus: "none" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("skips idea-collection PR when checks are failing", async () => {
    const pr = mockPR({ headRefName: "claws/ideas-collect-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["ideas/focus-areas.md"]);
    mockMergeGate({ checkStatus: "failing" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips idea-collection PR when checks are pending", async () => {
    const pr = mockPR({ headRefName: "claws/ideas-collect-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["ideas/focus-areas.md"]);
    mockMergeGate({ checkStatus: "pending" });

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
    mockMergeGate({ checkStatus: "none" });

    await tryMerge(repo, pr);

    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("skips PR with merge conflicts", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockMergeGate({ checkStatus: "passing", mergeable: "CONFLICTING" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} has merge conflicts, skipping (ci-fixer will resolve)`,
    );
  });

  it("skips PR when mergeable state is UNKNOWN after retries", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockMergeGate({ checkStatus: "passing", mergeable: "UNKNOWN" });
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
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.mergePR.mockRejectedValue(new Error("GraphQL: Pull Request is not mergeable (mergePullRequest)"));

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} head moved or was not mergeable at merge time, skipping`,
    );
  });

  it("rethrows non-mergeable errors from mergePR", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockMergeGate({ checkStatus: "passing" });
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

  it("skips PRs carrying the Manual Action label", async () => {
    const pr = mockPR({ labels: [{ name: "Manual Action" }] });
    mockGh.isForkPR.mockReturnValue(false);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("skipped: Manual Action"),
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
    mockMergeGate({ checkStatus: "pending" });

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
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml"]);
    mockGh.getPRDiff.mockResolvedValue(imagePinDiff(["apps/bonkus/deployment.yaml"]));

    const result = await tryMerge(repo, pr);

    expect(result).toBe(true);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges auto-bump PR using the base/overlay layout (apps/<app>/base/deployment.yaml)", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-v2026-06-10.5",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/base/deployment.yaml"]);
    mockGh.getPRDiff.mockResolvedValue(imagePinDiff(["apps/bonkus/base/deployment.yaml"]));

    const result = await tryMerge(repo, pr);

    expect(result).toBe(true);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges auto-bump PR touching deployment, migrate-job, and cleanup cronjob files", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-v2026-06-15.4",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRChangedFiles.mockResolvedValue([
      "apps/bonkus/base/deployment.yaml",
      "apps/bonkus/prod/cleanup-test-data-cronjob.yaml",
      "apps/bonkus/prod/migrate-job.yaml",
    ]);
    mockGh.getPRDiff.mockResolvedValue(imagePinDiff([
      "apps/bonkus/base/deployment.yaml",
      "apps/bonkus/prod/cleanup-test-data-cronjob.yaml",
      "apps/bonkus/prod/migrate-job.yaml",
    ]));

    const result = await tryMerge(repo, pr);

    expect(result).toBe(true);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges auto-bump PR with the migrate/ directory layout (production-infra #1254)", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-v2026-08-13.1",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRChangedFiles.mockResolvedValue([
      "apps/bonkus/base/deployment.yaml",
      "apps/bonkus/migrate/migrate-job.yaml",
      "apps/bonkus/prod/cleanup-test-data-cronjob.yaml",
    ]);
    mockGh.getPRDiff.mockResolvedValue(imagePinDiff([
      "apps/bonkus/base/deployment.yaml",
      "apps/bonkus/migrate/migrate-job.yaml",
      "apps/bonkus/prod/cleanup-test-data-cronjob.yaml",
    ]));

    const result = await tryMerge(repo, pr);

    expect(result).toBe(true);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges auto-bump PR with cleanup cronjob beside the migrate job", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-namey-v2026-08-13.1",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRChangedFiles.mockResolvedValue([
      "apps/namey/deployment.yaml",
      "apps/namey/migrate/migrate-job.yaml",
      "apps/namey/migrate/cleanup-test-data-cronjob.yaml",
    ]);
    mockGh.getPRDiff.mockResolvedValue(imagePinDiff([
      "apps/namey/deployment.yaml",
      "apps/namey/migrate/migrate-job.yaml",
      "apps/namey/migrate/cleanup-test-data-cronjob.yaml",
    ]));

    const result = await tryMerge(repo, pr);

    expect(result).toBe(true);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges auto-bump PR touching an env-suffixed manifest (fleet-infra apps/claws/deployment-staging.yaml)", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-claws-staging",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/claws/deployment-staging.yaml"]);
    mockGh.getPRDiff.mockResolvedValue(imagePinDiff(["apps/claws/deployment-staging.yaml"]));

    const result = await tryMerge(repo, pr);

    expect(result).toBe(true);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges auto-bump PR outside the apps/ tree", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-claws-1.2.3",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRChangedFiles.mockResolvedValue(["clusters/home/claws/deployment.yaml"]);
    mockGh.getPRDiff.mockResolvedValue(imagePinDiff(["clusters/home/claws/deployment.yaml"]));

    const result = await tryMerge(repo, pr);

    expect(result).toBe(true);
    expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("skips auto-bump PR whose diff changes more than the image tag", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-1.2.3",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/claws/deployment-staging.yaml"]);
    const extraHunk = [
      `@@ -30,7 +30,7 @@ spec:`,
      `         - name: app`,
      `-          replicas: 1`,
      `+          replicas: 3`,
      `           imagePullPolicy: IfNotPresent`,
    ].join("\n");
    mockGh.getPRDiff.mockResolvedValue(`${imagePinDiff(["apps/claws/deployment-staging.yaml"])}\n${extraHunk}`);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      `[auto-merger] Auto-bump PR ${repo.fullName}#${pr.number} diff is not an image-pin-only bump, skipping`,
    );
  });

  it("skips auto-bump PR when the diff cannot be read", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-1.2.3",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/claws/deployment-staging.yaml"]);
    mockGh.getPRDiff.mockResolvedValue("");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("does not merge auto-bump PR when checks are not passing", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-1.2.3",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml"]);
    mockGh.getPRDiff.mockResolvedValue(imagePinDiff(["apps/bonkus/deployment.yaml"]));

    mockMergeGate({ checkStatus: "none" });
    let result = await tryMerge(repo, pr);
    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml"]);
    mockGh.getPRDiff.mockResolvedValue(imagePinDiff(["apps/bonkus/deployment.yaml"]));
    mockMergeGate({ checkStatus: "pending" });
    result = await tryMerge(repo, pr);
    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips auto-bump PR touching non-bump files", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-1.2.3",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml", "package.json"]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
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
    mockMergeGate({ checkStatus: "failing" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("skipped: checks status="),
    );
  });

  describe("Automerge label", () => {
    it("merges a claws issue PR carrying Automerge with no LGTM when review is clean and reviewedCommit prefixes HEAD", async () => {
      const pr = mockPR({ headRefName: "claws/issue-42-ab12", labels: [{ name: "Automerge" }] });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    });

    it.each(["issues", "escalated", "none"] as const)(
      "skips Automerge PR when review status is %s",
      async (status) => {
        const pr = mockPR({ headRefName: "claws/issue-42-ab12", labels: [{ name: "Automerge" }] });
        mockGh.getPRReviewStatus.mockResolvedValue({ status, issueCount: 0, reviewedCommit: status === "none" ? null : "abc123" });

        const result = await tryMerge(repo, pr);

        expect(result).toBe(false);
        expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
        expect(mockGh.mergePR).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith(
          `[auto-merger] ${repo.fullName}#${pr.number} skipped: Automerge but review status=${status}`,
        );
      },
    );

    it("skips Automerge PR when reviewedCommit does not prefix the head SHA (stale review)", async () => {
      const pr = mockPR({ headRefName: "claws/issue-42-ab12", labels: [{ name: "Automerge" }] });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "deadbee" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        `[auto-merger] ${repo.fullName}#${pr.number} skipped: Automerge but clean review is stale`,
      );
    });

    it("merges an Automerge PR with check status none once checks have settled", async () => {
      const pr = mockPR({ headRefName: "claws/issue-42-ab12", labels: [{ name: "Automerge" }] });
      mockMergeGate({ checkStatus: "none" });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");
      mockGh.haveChecksSettled.mockResolvedValue({ settled: true, age: "600s" });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    });

    it("does not merge an Automerge PR with check status none while checks have not settled", async () => {
      const pr = mockPR({ headRefName: "claws/issue-42-ab12", labels: [{ name: "Automerge" }] });
      mockMergeGate({ checkStatus: "none" });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");
      mockGh.haveChecksSettled.mockResolvedValue({ settled: false, age: "30s" });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("skips Automerge PR when Manual Action is also present", async () => {
      const pr = mockPR({
        headRefName: "claws/issue-42-ab12",
        labels: [{ name: "Automerge" }, { name: "Manual Action" }],
      });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.getPRReviewStatus).not.toHaveBeenCalled();
      expect(mockGh.hasValidLGTM).not.toHaveBeenCalled();
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("skipped: Manual Action"),
      );
    });
  });

  describe("infra (tofu/terraform) gate (#2275)", () => {
    it("does not merge an LGTM'd PR touching tofu files", async () => {
      const pr = mockPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
      mockGh.hasValidLGTM.mockResolvedValue(true);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("infrastructure changes require a human merge"),
      );
    });

    it("does not merge an Automerge-labelled PR with a clean, fresh review that touches tofu files", async () => {
      const pr = mockPR({ headRefName: "claws/issue-42-ab12", labels: [{ name: "Automerge" }] });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");
      mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("fails closed when getPRChangedFiles returns empty but the PR has known changed files", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" }, changedFiles: 3 });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRChangedFiles.mockResolvedValue([]);

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        `[auto-merger] ${repo.fullName}#${pr.number} skipped: could not read changed files`,
      );
    });

    it("fetches changed files at most once per tryMerge call (memoised)", async () => {
      const pr = mockPR({ headRefName: "claws/docs-ab12" });
      mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
      mockMergeGate({ checkStatus: "passing" });

      await tryMerge(repo, pr);

      expect(mockGh.getPRChangedFiles).toHaveBeenCalledTimes(1);
    });
  });

  describe("live merge gate (#2354)", () => {
    it("does not merge a dependabot PR with no checks when the head commit is seconds old", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ checkStatus: "none", checksTotal: 0 });
      mockGh.haveChecksSettled.mockResolvedValue({ settled: false, age: "30s" });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("waiting for CI to register"),
      );
    });

    it("merges a dependabot PR with no checks once the head commit has settled", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ checkStatus: "none", checksTotal: 0 });
      mockGh.haveChecksSettled.mockResolvedValue({ settled: true, age: "600s" });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    });

    it("checks the settle window against the live head SHA", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ checkStatus: "none", checksTotal: 0 });
      mockGh.haveChecksSettled.mockResolvedValue({ settled: false, age: "unknown" });

      const result = await tryMerge(repo, pr);

      expect(mockGh.haveChecksSettled).toHaveBeenCalledWith(repo.fullName, HEAD_SHA);
      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("does not merge when the Manual Action label appears after the PR list snapshot", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" }, labels: [] });
      mockMergeGate({ checkStatus: "passing", labels: ["Manual Action"] });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("Manual Action label present (live)"),
      );
    });

    it("does not merge when the live PR state is no longer OPEN", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ state: "CLOSED", checkStatus: "passing" });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("skipped: state=CLOSED"),
      );
    });

    it("does not merge when the live rollup reports a failing (cancelled) check", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ checkStatus: "failing", checksTotal: 2 });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        `[auto-merger] Checks failed for ${repo.fullName}#${pr.number}, skipping`,
      );
    });

    it("returns false without rethrowing when the head moved between evaluation and merge", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.mergePR.mockRejectedValue(
        new Error("Head branch was modified. Review and try the merge again."),
      );

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("head moved or was not mergeable at merge time"),
      );
    });
  });

  describe("post-merge manual action announcement", () => {
    it("comments and pings Slack when the merged body has a post-merge section", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue(
        "## Summary\nDid the thing.\n\n## 📋 Manual action required after merge\n\nPublish the DS record at the registrar",
      );

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        pr.number,
        expect.stringContaining("Publish the DS record at the registrar"),
        { agentName: "Auto Merger" },
      );
      expect(mockNotify).toHaveBeenCalledWith(
        expect.stringContaining("Publish the DS record at the registrar"),
      );
      expect(mockNotify).toHaveBeenCalledWith(
        expect.stringContaining(`https://github.com/${repo.fullName}/pull/${pr.number}`),
      );
    });

    it("links to the Forgejo PR, not github.com, for a Forgejo-hosted repo", async () => {
      mockForgejoRepos.add(repo.fullName);
      try {
        const pr = mockPR({ author: { login: "dependabot[bot]" } });
        mockMergeGate({ checkStatus: "passing" });
        mockGh.getPRBody.mockResolvedValue(
          "## 📋 Manual action required after merge\n\nPublish the DS record at the registrar",
        );

        expect(await tryMerge(repo, pr)).toBe(true);
        expect(mockNotify).toHaveBeenCalledWith(
          expect.stringContaining(`https://git.example.com/${repo.fullName}/pulls/${pr.number}`),
        );
        expect(mockNotify).not.toHaveBeenCalledWith(expect.stringContaining("github.com"));
      } finally {
        mockForgejoRepos.delete(repo.fullName);
      }
    });

    it("does not comment or ping Slack when the post-merge note is verification-only", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue(
        "## Summary\nDid the thing.\n\n## 📋 Manual action required after merge\n\nVerify the Grafana alert rules fire after Flux reconciles",
      );

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it("does not comment when the merged body has no post-merge section", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue("## Summary\nDid the thing.");

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it("does not throw and still reports success when getPRBody rejects", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockRejectedValue(new Error("boom"));

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });
  });

  describe("isImagePinOnlyDiff", () => {
    it("accepts the real fleet-infra deployment-staging.yaml bump diff", () => {
      const diff = [
        `diff --git a/apps/claws/deployment-staging.yaml b/apps/claws/deployment-staging.yaml`,
        `@@ -24,7 +24,7 @@ spec:`,
        `-          image: ghcr.io/st-john-software/claws:v2026-05-09.2`,
        `+          image: ghcr.io/st-john-software/claws:v2026-09-02.3`,
      ].join("\n");

      expect(isImagePinOnlyDiff(diff)).toBe(true);
    });

    it("accepts a two-hunk diff bumping the same image in an initContainer and a container", () => {
      const diff = [
        `diff --git a/apps/x/deployment.yaml b/apps/x/deployment.yaml`,
        `index 1111111..2222222 100644`,
        `--- a/apps/x/deployment.yaml`,
        `+++ b/apps/x/deployment.yaml`,
        `@@ -10,7 +10,7 @@ spec:`,
        `      initContainers:`,
        `        - name: init`,
        `-          image: ghcr.io/st-john-software/app:v1.0.0`,
        `+          image: ghcr.io/st-john-software/app:v1.0.1`,
        `           imagePullPolicy: IfNotPresent`,
        `@@ -20,7 +20,7 @@ spec:`,
        `      containers:`,
        `        - name: app`,
        `-          image: ghcr.io/st-john-software/app:v1.0.0`,
        `+          image: ghcr.io/st-john-software/app:v1.0.1`,
        `           imagePullPolicy: IfNotPresent`,
      ].join("\n");

      expect(isImagePinOnlyDiff(diff)).toBe(true);
    });

    it("accepts a digest bump", () => {
      const diff = [
        `diff --git a/apps/x/deployment.yaml b/apps/x/deployment.yaml`,
        `index 1111111..2222222 100644`,
        `--- a/apps/x/deployment.yaml`,
        `+++ b/apps/x/deployment.yaml`,
        `@@ -10,7 +10,7 @@ spec:`,
        `        - name: app`,
        `-          image: ghcr.io/st-john-software/app@sha256:${"a".repeat(64)}`,
        `+          image: ghcr.io/st-john-software/app@sha256:${"b".repeat(64)}`,
        `           imagePullPolicy: IfNotPresent`,
      ].join("\n");

      expect(isImagePinOnlyDiff(diff)).toBe(true);
    });

    it("accepts a newTag: bump", () => {
      const diff = [
        `diff --git a/apps/x/kustomization.yaml b/apps/x/kustomization.yaml`,
        `index 1111111..2222222 100644`,
        `--- a/apps/x/kustomization.yaml`,
        `+++ b/apps/x/kustomization.yaml`,
        `@@ -5,4 +5,4 @@ images:`,
        `  - name: app`,
        `    newName: ghcr.io/st-john-software/app`,
        `-    newTag: v1.0.0`,
        `+    newTag: v1.0.1`,
      ].join("\n");

      expect(isImagePinOnlyDiff(diff)).toBe(true);
    });

    it("rejects a diff adding a new file", () => {
      const diff = [
        `diff --git a/apps/x/new.yaml b/apps/x/new.yaml`,
        `new file mode 100644`,
        `index 0000000..1111111`,
        `--- /dev/null`,
        `+++ b/apps/x/new.yaml`,
        `@@ -0,0 +1,3 @@`,
        `+image: ghcr.io/st-john-software/app:v1.0.1`,
      ].join("\n");

      expect(isImagePinOnlyDiff(diff)).toBe(false);
    });

    it("rejects a diff deleting a file", () => {
      const diff = [
        `diff --git a/apps/x/old.yaml b/apps/x/old.yaml`,
        `deleted file mode 100644`,
        `index 1111111..0000000`,
        `--- a/apps/x/old.yaml`,
        `+++ /dev/null`,
        `@@ -1,3 +0,0 @@`,
        `-image: ghcr.io/st-john-software/app:v1.0.0`,
      ].join("\n");

      expect(isImagePinOnlyDiff(diff)).toBe(false);
    });

    it("rejects a renamed file", () => {
      const diff = [
        `diff --git a/apps/x/old.yaml b/apps/x/new.yaml`,
        `similarity index 100%`,
        `rename from apps/x/old.yaml`,
        `rename to apps/x/new.yaml`,
      ].join("\n");

      expect(isImagePinOnlyDiff(diff)).toBe(false);
    });

    it("rejects an empty diff", () => {
      expect(isImagePinOnlyDiff("")).toBe(false);
    });

    it("rejects an image name change", () => {
      const diff = [
        `diff --git a/apps/x/deployment.yaml b/apps/x/deployment.yaml`,
        `index 1111111..2222222 100644`,
        `--- a/apps/x/deployment.yaml`,
        `+++ b/apps/x/deployment.yaml`,
        `@@ -10,7 +10,7 @@ spec:`,
        `        - name: app`,
        `-          image: ghcr.io/a/app:v1.0.0`,
        `+          image: ghcr.io/b/app:v1.0.0`,
        `           imagePullPolicy: IfNotPresent`,
      ].join("\n");

      expect(isImagePinOnlyDiff(diff)).toBe(false);
    });

    it("rejects a removed image: line with no matching added line", () => {
      const diff = [
        `diff --git a/apps/x/deployment.yaml b/apps/x/deployment.yaml`,
        `index 1111111..2222222 100644`,
        `--- a/apps/x/deployment.yaml`,
        `+++ b/apps/x/deployment.yaml`,
        `@@ -10,6 +10,5 @@ spec:`,
        `        - name: app`,
        `-          image: ghcr.io/st-john-software/app:v1.0.0`,
        `-          imagePullPolicy: IfNotPresent`,
        `+          imagePullPolicy: Always`,
      ].join("\n");

      expect(isImagePinOnlyDiff(diff)).toBe(false);
    });
  });
});
