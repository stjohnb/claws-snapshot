import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockPR } from "../test-helpers.js";

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

vi.mock("../prompt-guard.js", () => ({
  guardContent: (t: string) => t,
  makeGuardCtx: () => () => ({}),
}));

const { mockGh } = vi.hoisted(() => ({
  mockGh: {
    listPRs: vi.fn(),
    getPRChangedFiles: vi.fn(),
    getBranchTipCommit: vi.fn(),
    pushEmptyCommit: vi.fn(),
    getIssueComments: vi.fn(),
    commentOnIssue: vi.fn(),
    isRateLimited: vi.fn().mockReturnValue(false),
    isDependabotPR: (p: { author: { login: string } }) => p.author.login === "dependabot[bot]",
    isForkPR: (p: { isCrossRepository?: boolean }) => p.isCrossRepository === true,
  },
}));

vi.mock("../github.js", () => mockGh);

import { run, isUnblockTargetPR, UNBLOCK_TARGETS, DECLINED_MARKER } from "./dependabot-tofu-unblocker.js";
import { reportError } from "../error-reporter.js";

const TARGET = UNBLOCK_TARGETS[0];

const dependabotPR = (overrides: Parameters<typeof mockPR>[0] = {}) =>
  mockPR({
    author: { login: "dependabot[bot]" },
    baseRefName: "main",
    headRefName: "dependabot/terraform/tofu/aws-6.62.0",
    isCrossRepository: false,
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockGh.isRateLimited.mockReturnValue(false);
  mockGh.getIssueComments.mockResolvedValue([]);
});

describe("isUnblockTargetPR", () => {
  it("matches a dependabot terraform PR in the target repo", () => {
    expect(isUnblockTargetPR(TARGET.repo, dependabotPR())).toBe(true);
  });

  it("does not match the wrong repo", () => {
    expect(isUnblockTargetPR("St-John-Software/other-repo", dependabotPR())).toBe(false);
  });

  it("does not match a non-dependabot author", () => {
    expect(isUnblockTargetPR(TARGET.repo, dependabotPR({ author: { login: "someone" } }))).toBe(false);
  });

  it("does not match a fork PR", () => {
    expect(isUnblockTargetPR(TARGET.repo, dependabotPR({ isCrossRepository: true }))).toBe(false);
  });

  it("does not match the wrong base branch", () => {
    expect(isUnblockTargetPR(TARGET.repo, dependabotPR({ baseRefName: "gh-pages" }))).toBe(false);
  });

  it("does not match the wrong branch prefix", () => {
    expect(isUnblockTargetPR(TARGET.repo, dependabotPR({ headRefName: "dependabot/npm_and_yarn/x" }))).toBe(false);
  });
});

describe("run", () => {
  it("pushes an empty commit for a confined PR", async () => {
    const pr = dependabotPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRChangedFiles.mockResolvedValue(["tofu/versions.tf", "tofu/.terraform.lock.hcl"]);
    const tip = { sha: "abc123", treeSha: "tree123", message: "chore(deps): bump hashicorp/aws" };
    mockGh.getBranchTipCommit.mockResolvedValue(tip);
    mockGh.pushEmptyCommit.mockResolvedValue("pushed");

    await run();

    expect(mockGh.pushEmptyCommit).toHaveBeenCalledTimes(1);
    expect(mockGh.pushEmptyCommit).toHaveBeenCalledWith(TARGET.repo, pr.headRefName, "ci: run tofu plan", tip);
  });

  it("does not push when the tip already carries the marker (single line)", async () => {
    const pr = dependabotPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRChangedFiles.mockResolvedValue(["tofu/versions.tf"]);
    mockGh.getBranchTipCommit.mockResolvedValue({ sha: "abc", treeSha: "tree", message: "ci: run tofu plan" });

    await run();

    expect(mockGh.pushEmptyCommit).not.toHaveBeenCalled();
  });

  it("does not push when the tip already carries the marker (multi-line body)", async () => {
    const pr = dependabotPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRChangedFiles.mockResolvedValue(["tofu/versions.tf"]);
    mockGh.getBranchTipCommit.mockResolvedValue({
      sha: "abc",
      treeSha: "tree",
      message: "ci: run tofu plan\n\nUnblocks the Tofu Plan gate for this PR.",
    });

    await run();

    expect(mockGh.pushEmptyCommit).not.toHaveBeenCalled();
  });

  it("does not fetch changed files or push for non-matching PRs", async () => {
    const prs = [
      dependabotPR({ author: { login: "someone-else" } }),
      dependabotPR({ isCrossRepository: true }),
      dependabotPR({ baseRefName: "gh-pages" }),
      dependabotPR({ headRefName: "dependabot/npm_and_yarn/x" }),
    ];
    mockGh.listPRs.mockResolvedValue(prs);

    await run();

    expect(mockGh.getPRChangedFiles).not.toHaveBeenCalled();
    expect(mockGh.pushEmptyCommit).not.toHaveBeenCalled();
  });

  it("declines and comments when the diff touches disallowed files, and does not double-comment", async () => {
    const pr = dependabotPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRChangedFiles.mockResolvedValue(["tofu/versions.tf", "tofu/zone.tf"]);

    await run();

    expect(mockGh.pushEmptyCommit).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.commentOnIssue.mock.calls[0][2]).toContain(DECLINED_MARKER);

    mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: `blah ${DECLINED_MARKER} blah`, body_html: "", login: "clawsstjohn[bot]" }]);
    mockGh.commentOnIssue.mockClear();

    await run();

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("does nothing when getPRChangedFiles returns an empty list", async () => {
    const pr = dependabotPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRChangedFiles.mockResolvedValue([]);

    await run();

    expect(mockGh.pushEmptyCommit).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("does not throw and does not reportError when pushEmptyCommit is not-fast-forward", async () => {
    const pr = dependabotPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRChangedFiles.mockResolvedValue(["tofu/versions.tf"]);
    mockGh.getBranchTipCommit.mockResolvedValue({ sha: "abc", treeSha: "tree", message: "bump" });
    mockGh.pushEmptyCommit.mockResolvedValue("not-fast-forward");

    await expect(run()).resolves.toBeUndefined();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("does not push and does not throw when getBranchTipCommit returns null", async () => {
    const pr = dependabotPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRChangedFiles.mockResolvedValue(["tofu/versions.tf"]);
    mockGh.getBranchTipCommit.mockResolvedValue(null);

    await expect(run()).resolves.toBeUndefined();
    expect(mockGh.pushEmptyCommit).not.toHaveBeenCalled();
  });
});
