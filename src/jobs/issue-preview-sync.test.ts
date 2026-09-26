import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../error-reporter.js", () => ({ reportError: vi.fn() }));

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    getIssuePreviewSummaryUrl: vi.fn(() => null as string | null),
    isForgejoRepo: vi.fn(() => false),
  },
}));
vi.mock("../config.js", () => mockConfig);

const { mockGh, mockSync } = vi.hoisted(() => ({
  mockGh: {
    isRepoRateLimited: vi.fn((_repo: string) => false),
    listPRs: vi.fn(),
    isForkPR: (pr: { isCrossRepository?: boolean }) => pr.isCrossRepository === true,
    listBranchesByPrefix: vi.fn(),
  },
  mockSync: vi.fn(),
}));
vi.mock("../github.js", () => mockGh);
vi.mock("../issue-previews.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../issue-previews.js")>(),
  syncIssuePreview: mockSync,
}));

import { run } from "./issue-preview-sync.js";
import { reportError } from "../error-reporter.js";

const ID = "clw_01M3855REJ979V90Q4VY77NPNE";

function pr(number: number, headRefName: string, isCrossRepository = false) {
  return { number, headRefName, isCrossRepository, title: "t", baseRefName: "main", labels: [], author: { login: "x" } };
}

describe("issue-preview-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSync.mockResolvedValue(undefined);
    mockConfig.getIssuePreviewSummaryUrl.mockReturnValue(null);
    mockConfig.isForgejoRepo.mockReturnValue(false);
    mockGh.isRepoRateLimited.mockImplementation((_repo: string) => false);
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.listBranchesByPrefix.mockResolvedValue([]);
  });

  it("syncs only preview branches, skipping forks", async () => {
    mockGh.listPRs.mockResolvedValue([
      pr(1, "claws/issue-4-abcd"),
      pr(2, `claws/preview-issue-${ID}`),
      pr(3, "claws/preview-issue-17"),
      pr(4, "claws/preview-issue-18", true),
      pr(5, "claws/preview-issue-nope"),
    ]);
    await run([{ fullName: "o/r" } as never]);
    expect(mockSync.mock.calls.map((c) => [c[0], c[1], c[2].kind, c[2].pr.number])).toEqual([
      ["o/r", ID, "pr", 2],
      ["o/r", 17, "pr", 3],
    ]);
  });

  it("skips a rate-limited repo", async () => {
    mockGh.isRepoRateLimited.mockImplementation((repo: string) => repo === "o/limited");
    mockGh.listPRs.mockResolvedValue([pr(3, "claws/preview-issue-17")]);
    await run([{ fullName: "o/limited" } as never, { fullName: "o/r" } as never]);
    expect(mockGh.listPRs).toHaveBeenCalledTimes(1);
    expect(mockGh.listPRs).toHaveBeenCalledWith("o/r");
  });

  it("reports one PR's failure and carries on", async () => {
    mockGh.listPRs.mockResolvedValue([pr(2, "claws/preview-issue-16"), pr(3, "claws/preview-issue-17")]);
    mockSync.mockRejectedValueOnce(new Error("boom"));
    await run([{ fullName: "o/r" } as never]);
    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith("issue-preview-sync:pr", "o/r#2", expect.any(Error), { repo: "o/r" });
  });

  describe("PR-less branch previews", () => {
    beforeEach(() => {
      mockConfig.getIssuePreviewSummaryUrl.mockReturnValue("https://example.test/{issue}/{sha8}/preview-summary.json");
    });

    it("lists and syncs branches only when the template is set", async () => {
      mockGh.listBranchesByPrefix.mockResolvedValue([{ name: `claws/preview-issue-${ID}`, sha: "abc12345" }]);
      await run([{ fullName: "o/r" } as never]);
      expect(mockGh.listBranchesByPrefix).toHaveBeenCalledWith("o/r", "claws/preview-issue-");
      expect(mockSync).toHaveBeenCalledWith("o/r", ID, { kind: "branch", branch: `claws/preview-issue-${ID}`, headSha: "abc12345" });
    });

    it("never lists branches when no template is set", async () => {
      mockConfig.getIssuePreviewSummaryUrl.mockReturnValue(null);
      await run([{ fullName: "o/r" } as never]);
      expect(mockGh.listBranchesByPrefix).not.toHaveBeenCalled();
    });

    it("never lists branches for a Forgejo repo", async () => {
      mockConfig.isForgejoRepo.mockReturnValue(true);
      await run([{ fullName: "o/r" } as never]);
      expect(mockGh.listBranchesByPrefix).not.toHaveBeenCalled();
    });

    it("dedupes a branch that already has an open non-fork PR", async () => {
      const branch = `claws/preview-issue-${ID}`;
      mockGh.listPRs.mockResolvedValue([pr(9, branch)]);
      mockGh.listBranchesByPrefix.mockResolvedValue([{ name: branch, sha: "abc12345" }]);
      await run([{ fullName: "o/r" } as never]);
      expect(mockSync).toHaveBeenCalledTimes(1);
      expect(mockSync).toHaveBeenCalledWith("o/r", ID, { kind: "pr", pr: pr(9, branch) });
    });

    it("skips a branch with an unparsable suffix", async () => {
      mockGh.listBranchesByPrefix.mockResolvedValue([{ name: "claws/preview-issue-nope", sha: "abc12345" }]);
      await run([{ fullName: "o/r" } as never]);
      expect(mockSync).not.toHaveBeenCalled();
    });

    it("reports a branch listing failure under :repo", async () => {
      mockGh.listBranchesByPrefix.mockRejectedValue(new Error("boom"));
      await run([{ fullName: "o/r" } as never]);
      expect(reportError).toHaveBeenCalledWith("issue-preview-sync:repo", "o/r", expect.any(Error), { repo: "o/r" });
    });

    it("reports one branch's sync failure under :branch and carries on", async () => {
      mockGh.listBranchesByPrefix.mockResolvedValue([
        { name: `claws/preview-issue-${ID}`, sha: "abc12345" },
        { name: "claws/preview-issue-17", sha: "def67890" },
      ]);
      mockSync.mockRejectedValueOnce(new Error("boom"));
      await run([{ fullName: "o/r" } as never]);
      expect(mockSync).toHaveBeenCalledTimes(2);
      expect(reportError).toHaveBeenCalledWith("issue-preview-sync:branch", `o/r:claws/preview-issue-${ID}`, expect.any(Error), { repo: "o/r" });
    });
  });
});
