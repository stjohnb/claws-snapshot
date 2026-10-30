import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";
import type * as db from "../db.js";

vi.mock("../config.js", async () => ({
  isClawsIssueId: (await vi.importActual<typeof import("../issue-id.js")>("../issue-id.js")).isClawsIssueId,
  LABELS: {
    manualAction: "Manual Action",
    needsLgtm: "Needs LGTM",
    blocked: "Blocked",
  },
  prUrl: (fullName: string, prNumber: number) => `https://git.example.com/${fullName}/pulls/${prNumber}`,
  issueUrl: (fullName: string, ref: string | number) => `https://git.example.com/${fullName}/issues/${ref}`,
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
    carriedForwardCheckStatus: vi.fn(),
    repoExpectsCi: vi.fn(),
    mergePR: vi.fn(),
    removeLabel: vi.fn(),
    getPRChangedFiles: vi.fn(),
    getPRDiff: vi.fn(),
    listPRCommits: vi.fn(),
    listCompareChangedFiles: vi.fn(),
    getCommitDiff: vi.fn(),
    getPRMergeableState: vi.fn(),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    isParked: vi.fn().mockReturnValue(false),
    isDispatchSkippable: vi.fn().mockReturnValue(false),
    isForkPR: vi.fn().mockReturnValue(false),
    normalizeBotLogin: (login: string) => (login.startsWith("app/") ? `${login.slice(4)}[bot]` : login),
    isAllowedHumanActor: vi.fn(async (login: string) => login === "stjohnb"),
    populateQueueCache: vi.fn(),
    removeQueueItem: vi.fn(),
    getPRReviewStatus: vi.fn(),
    getPRHeadSHA: vi.fn(),
    listRepoTreePaths: vi.fn(),
    fetchRepoFileWithSha: vi.fn(),
    infraPathsIn: vi.fn((f: string[]) => f.filter((p) => /(?:^|\/)(?:tofu|terraform)\/|\.tfvars?$|\.tf$/.test(p))),
    getPRBody: vi.fn().mockResolvedValue(""),
    closeIssue: vi.fn(),
    addLabel: vi.fn(),
    ensureLabel: vi.fn(),
    // The park records its reason with the move; seen here as the Blocked label it adds.
    blockIssue: vi.fn(async (repo: string, ref: unknown, _reason: string): Promise<void> => { await mockGh.addLabel(repo, ref, "Blocked"); }),
    commentOnIssue: vi.fn(),
    getIssueComments: vi.fn().mockResolvedValue([]),
    editIssueComment: vi.fn(),
    isClawsComment: vi.fn((body: string) => body.includes("*— Automated by Claws")),
    stripClawsMarker: vi.fn((body: string) => body.replace(/\*— Automated by Claws[^*]*—\*/g, "").trim()),
    setMergeBlockReason: vi.fn(),
    listPRs: vi.fn(),
    invalidatePRList: vi.fn(),
    getOpenPRForIssue: vi.fn().mockResolvedValue(null),
    getIssueState: vi.fn().mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] }),
    getIssueBody: vi.fn().mockResolvedValue(""),
    listMergedPRsForIssue: vi.fn().mockResolvedValue([]),
    getTofuPlanEvidence: vi.fn().mockResolvedValue({ plan: null, state: "unavailable", detail: "no plan comment" }),
    isCiExemptPath: vi.fn((p: string) => p.startsWith("docs/") || p.endsWith(".md") || p === "LICENSE"),
  },
}));

vi.mock("../github.js", () => mockGh);

const { mockClawsIssues } = vi.hoisted(() => ({
  mockClawsIssues: {
    getIssue: vi.fn(),
    primaryRepo: (issue: { repos: readonly string[] }) => [...issue.repos].sort()[0] ?? "",
  },
}));
vi.mock("../claws-issues.js", () => mockClawsIssues);

/** Phase state for the merged PR's issue; defaults to a single-PR plan with nothing open. */
function phaseState(totalPhases: number, done: number[], openPhases: number[]) {
  return {
    totalPhases,
    entries: null,
    trackerId: null,
    coverage: {
      totalPhases, covered: new Set([...done, ...openPhases]), done: new Set(done), coveringPRs: new Map(),
      nextPhase: null, lastMergedPhase: 0, dependencies: new Map(), readyPhases: [], blockedPhases: [], openPhases, awaitingOperator: [] as number[], markerMismatches: [],
    },
  };
}
const mockLoadPhaseState = vi.hoisted(() => vi.fn());
// Defaults to a single-PR plan: `finalizeMergedClawsPR` skips the phase read
// entirely for it, so most tests never need to touch this mock at all.
const mockPeekTotalPhases = vi.hoisted(() => vi.fn(async () => ({ totalPhases: 1, stored: null })));
vi.mock("../planned-prs.js", async (importOriginal) => ({
  // The close-on-completion helper runs for real against the mocked forge.
  closeIssueIfPlanComplete: (await importOriginal<typeof import("../planned-prs.js")>()).closeIssueIfPlanComplete,
  loadIssuePhaseState: mockLoadPhaseState,
  peekTotalPhases: mockPeekTotalPhases,
}));

/** Arms both phase-state mocks together — the gate in front of the read and the read itself. */
function setPhaseState(totalPhases: number, done: number[], openPhases: number[]) {
  mockPeekTotalPhases.mockResolvedValue({ totalPhases, stored: null });
  mockLoadPhaseState.mockResolvedValue(phaseState(totalPhases, done, openPhases));
}

const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../slack.js", () => ({ notify: mockNotify }));
const mockDb = vi.hoisted(() => ({
  findLatestCompletedTaskForPrHead: vi.fn(),
  recordTaskEffectivenessEvent: vi.fn(),
  hasActiveWorkForPR: vi.fn(),
  getClawsPr: vi.fn(),
}));
vi.mock("../db.js", () => mockDb);
const mockLinkedIssue = vi.hoisted(() => vi.fn());
vi.mock("../pr-hold.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../pr-hold.js")>()), linkedIssue: mockLinkedIssue }));
const mockIsPrHeldForReapproval = vi.hoisted(() => vi.fn());
vi.mock("../reapproval.js", () => ({ isPrHeldForReapproval: mockIsPrHeldForReapproval }));
const mockStall = vi.hoisted(() => ({ recordSweep: vi.fn(), reconcileStallAlert: vi.fn() }));
vi.mock("./auto-bump-stall.js", () => mockStall);
vi.mock("../worker.js", () => ({
  AGENT_KINDS: {
    CI_FIXER: "ci-fixer",
    CI_FIXER_CONFLICT: "ci-fixer:conflict",
    REVIEW_ADDRESSER: "review-addresser",
    PR_REVIEWER: "pr-reviewer",
  },
}));

import { attemptMerge, tryMerge, sweepRepo, isImagePinOnlyDiff, isApprovalExempt, isIdleAwaitingHuman, checkAutoBumpDiff, autoBumpGateVerdict, clearAutoBumpGateCache, approvalHoldReason, AWAITING_OPERATOR_MARKER } from "./auto-merger.js";
import * as log from "../log.js";

const HEAD_SHA = "abc1234def";
const BASE_SHA = "b".repeat(40);

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

/** Arm the pin scan: the repo at the PR head holds exactly `files` (path → content). */
function mockRepoFiles(files: Record<string, string>): void {
  mockGh.listRepoTreePaths.mockResolvedValue(Object.keys(files));
  mockGh.fetchRepoFileWithSha.mockImplementation(async (_repo: string, path: string) =>
    path in files ? { content: files[path], sha: "s" } : null);
}

/**
 * The production-infra#32 shape: a registry-host migration, where both the image
 * name and its `# renovate: depName=` comment move from GHCR to registry.bstjohn.net.
 */
function registryHostBumpDiff(file = "apps/bonkus/deployment.yaml"): string {
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  return [
    `diff --git a/${file} b/${file}`,
    `index 1111111..2222222 100644`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -10,8 +10,8 @@ spec:`,
    `         - name: app`,
    `-          # renovate: depName=ghcr.io/st-john-software/bonkus`,
    `-          image: ghcr.io/st-john-software/bonkus:v2026-10-05.6@sha256:${digestA}`,
    `+          # renovate: depName=registry.bstjohn.net/st-john-software/bonkus`,
    `+          image: registry.bstjohn.net/st-john-software/bonkus:v2026-10-12.3@sha256:${digestB}`,
    `           imagePullPolicy: IfNotPresent`,
  ].join("\n");
}

interface MergeGate {
  state: string;
  headSha: string;
  baseSha: string;
  labels: string[];
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checkStatus: "passing" | "failing" | "pending" | "held" | "none";
  checksTotal: number;
  checksHeld: number;
}

/**
 * An auto-bump PR with an image-pin-only diff. Auto-bump is approval-exempt and
 * is the only category that still reaches the check carry-forward branch (#2929):
 * docs, ideas-collection and merge-approved PRs all merge outright on check
 * status "none". It is also the one approval-exempt category that needs neither a
 * merge approval nor a Claws review, so tests use it as the generic exempt PR.
 *
 * Arms `getPRChangedFiles`/`getPRDiff` as a side effect — call it *before* arming
 * either of those mocks yourself, or this clobbers them.
 */
function autoBumpPR(files: string[] = ["apps/bonkus/deployment.yaml"], over: Parameters<typeof mockPR>[0] = {}): ReturnType<typeof mockPR> {
  mockGh.getPRChangedFiles.mockResolvedValue(files);
  mockGh.getPRDiff.mockResolvedValue(imagePinDiff(files));
  const { labels = [], ...rest } = over;
  return mockPR({ headRefName: "automation/bump-bonkus-1.2.3", ...rest, labels: [{ name: "auto-bump" }, ...labels] });
}

/** The `claws_prs` rows `tryMerge` reads, by PR number. A PR with none reads a plain, unapproved row. */
const prRows = new Map<number, db.ClawsPrRecord>();
function prRow(prNumber: number, over: Partial<db.ClawsPrRecord> = {}): db.ClawsPrRecord {
  return {
    repo: "test-org/test-repo", prNumber, issueId: null, phase: null, headSha: null, observedAt: null,
    stage: "awaiting-review", ciStatus: null, mergeableState: null, reviewVerdict: null, reviewedSha: null,
    mergeApprovedBy: null, mergeApprovedAt: null, manualActionReason: null, needsHumanReview: false,
    ciBlockedReason: null, infraMergeApprovedBy: null, infraMergeApprovedAt: null, infraMergeApprovedSha: null, title: null, dispatchNote: null, dispatchNoteAt: null, createdAt: "", updatedAt: "", ...over,
  };
}
/** Merge `over` into PR `prNumber`'s row. */
function setRow(prNumber: number, over: Partial<db.ClawsPrRecord>): void {
  prRows.set(prNumber, { ...(prRows.get(prNumber) ?? prRow(prNumber)), ...over });
}

beforeEach(() => {
  prRows.clear();
  clearAutoBumpGateCache();
  // A body one test sets must not decide whether the next one's issue closes.
  mockGh.getPRBody.mockResolvedValue("");
  mockDb.getClawsPr.mockImplementation(async (_repo: string, n: number) => prRows.get(n) ?? prRow(n));
  mockLinkedIssue.mockResolvedValue(null);
  mockIsPrHeldForReapproval.mockResolvedValue(false);
});

/**
 * A PR approved for merge. The stored merge approval with a named approver is
 * the only approval auto-merger accepts (#3135, #3219), and its gate also needs
 * a clean Claws review of the current head — so this records a dashboard (OIDC)
 * approval on the row and mocks that review alongside building the PR.
 *
 * Arms `getPRReviewStatus`/`getPRHeadSHA` as a side effect — call it *before*
 * arming either of those mocks yourself, or this clobbers them.
 */
function approvedPR(over: Parameters<typeof mockPR>[0] = {}): ReturnType<typeof mockPR> {
  mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc1234" });
  mockGh.getPRHeadSHA.mockResolvedValue(HEAD_SHA);
  const pr = mockPR(over);
  setRow(pr.number, { mergeApprovedAt: "2026-09-26T00:00:00Z", mergeApprovedBy: "oidc-sub-1" });
  return pr;
}

/** Set the live merge-gate read `tryMerge` performs immediately before merging. */
function mockMergeGate(over: Partial<MergeGate> = {}): void {
  mockGh.getPRMergeGate.mockResolvedValue({
    state: "OPEN",
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    labels: [],
    mergeable: "MERGEABLE",
    checkStatus: "pending",
    checksTotal: 1,
    checksHeld: 0,
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
    mockGh.carriedForwardCheckStatus.mockResolvedValue("none");
    // Default: the repo has PR-reporting CI, so "none" on a settled head holds.
    mockGh.repoExpectsCi.mockResolvedValue(true);
    mockGh.mergePR.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.getPRChangedFiles.mockResolvedValue([]);
    mockGh.getPRDiff.mockResolvedValue("");
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.isForkPR.mockReturnValue(false);
    mockGh.isDispatchSkippable.mockReturnValue(false);
    mockGh.getPRReviewStatus.mockResolvedValue({ status: "none", issueCount: 0, reviewedCommit: null });
    mockGh.getPRHeadSHA.mockResolvedValue("abc1234");
    // A pin scan nobody armed fails loudly as `pin-scan-failed`.
    mockGh.listRepoTreePaths.mockRejectedValue(new Error("pin scan not mocked"));
    mockDb.findLatestCompletedTaskForPrHead.mockResolvedValue(null);
    mockDb.recordTaskEffectivenessEvent.mockResolvedValue(undefined);
    mockGh.closeIssue.mockResolvedValue(undefined);
    mockClawsIssues.getIssue.mockResolvedValue(undefined);
    mockLoadPhaseState.mockResolvedValue(phaseState(1, [1], []));
    mockPeekTotalPhases.mockResolvedValue({ totalPhases: 1, stored: null });
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
  });

  it("merges an approval-exempt auto-bump PR when checks pass", async () => {
    const pr = autoBumpPR();
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges an approval-exempt auto-bump PR when no checks exist in a repo with no PR CI", async () => {
    const pr = autoBumpPR();
    mockMergeGate({ checkStatus: "none" });
    mockGh.repoExpectsCi.mockResolvedValue(false);

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges an approved Claws PR when checks pass", async () => {
    const pr = approvedPR({ headRefName: "claws/issue-42" });
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  describe("attemptMerge (#clw_01M4XFRSGNP87QVW0N1W5KN0V4)", () => {
    it("merges a ready approved PR and attributes it to mergedBy", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42" });
      mockMergeGate({ checkStatus: "passing" });
      mockDb.findLatestCompletedTaskForPrHead.mockResolvedValue({ id: 123 });

      await expect(attemptMerge(repo, pr, { mergedBy: "session:abc123" })).resolves.toEqual({ merged: true });

      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      expect(mockDb.recordTaskEffectivenessEvent).toHaveBeenCalledWith(expect.objectContaining({ details: { mergedBy: "session:abc123" } }));
    });

    it("refuses a held PR with manual-action and the reported reason", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42" });
      setRow(pr.number, { manualActionReason: "set prod secrets" });
      mockMergeGate({ checkStatus: "passing" });

      const result = await attemptMerge(repo, pr, { mergedBy: "session:abc123" });

      expect(result).toMatchObject({ merged: false, code: "manual-action" });
      expect(result.merged === false && result.message).toContain("set prod secrets");
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("never reports the block on the PR with notify: false (#clw_01M5022YK7Z2V63775Y92B59P3)", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42" });
      setRow(pr.number, { manualActionReason: "set prod secrets" });
      mockMergeGate({ checkStatus: "passing" });

      const result = await attemptMerge(repo, pr, { mergedBy: "session:abc123", notify: false });

      expect(result).toMatchObject({ merged: false, code: "manual-action" });
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockGh.setMergeBlockReason).not.toHaveBeenCalled();

      await attemptMerge(repo, pr, { mergedBy: "session:abc123" });
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName, pr.number, expect.stringContaining("### Merge blocked"), { agentName: "Auto Merger" },
      );
    });

    it("refuses with other-work while a CI fixer or reviewer is active on the PR", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42" });
      mockMergeGate({ checkStatus: "passing" });
      mockDb.hasActiveWorkForPR.mockResolvedValueOnce(true);

      await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: false, code: "other-work" });
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("still reports merged when post-merge finalize throws", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42" });
      mockMergeGate({ checkStatus: "passing" });
      mockDb.findLatestCompletedTaskForPrHead.mockResolvedValue({ id: 123 });
      mockPeekTotalPhases.mockRejectedValueOnce(new Error("boom"));

      await expect(attemptMerge(repo, pr, { mergedBy: "session:abc123" })).resolves.toEqual({ merged: true });
      expect(mockGh.mergePR).toHaveBeenCalled();
    });

    it("refuses red CI with checks-failed", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42" });
      mockMergeGate({ checkStatus: "failing" });

      await expect(attemptMerge(repo, pr)).resolves.toEqual({ merged: false, code: "checks-failed", message: "CI is failing." });
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("refuses a stale review with review-stale", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42" });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "deadbee" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");
      mockMergeGate({ checkStatus: "passing" });

      await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: false, code: "review-stale" });
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("returns the log line when the block carries no reason", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42" });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.isDispatchSkippable.mockReturnValue(true);

      await expect(attemptMerge(repo, pr)).resolves.toEqual({
        merged: false,
        code: "dispatch-guard",
        message: "skipped: dispatch guard rejected live labels",
      });
    });

    it("refuses a settled head with no CI result with a reason naming the missing CI", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42" });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc1234" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234def0");
      mockGh.getPRChangedFiles.mockResolvedValue(["src/index.ts"]);
      mockMergeGate({ checkStatus: "none", headSha: "abc1234def0" });

      const result = await attemptMerge(repo, pr, { notify: false });

      expect(result).toMatchObject({ merged: false, code: "checks-missing" });
      expect((result as { message: string }).message).toContain("CI has not reported on head `abc1234`");
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("refuses an unsettled head with no CI result with a reason, without commenting", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42" });
      mockMergeGate({ checkStatus: "none", headSha: "abc1234def0" });
      mockGh.haveChecksSettled.mockResolvedValue({ settled: false, age: "10s" });

      await expect(attemptMerge(repo, pr)).resolves.toEqual({
        merged: false,
        code: "checks-pending",
        message: "CI has not reported on head `abc1234` yet — waiting for it to register.",
      });
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });
  });

  it("records merge effectiveness when a matching task exists", async () => {
    const pr = approvedPR({ headRefName: "claws/issue-42" });
    mockMergeGate({ checkStatus: "passing" });
    mockDb.findLatestCompletedTaskForPrHead.mockResolvedValue({ id: 123 });

    await expect(tryMerge(repo, pr)).resolves.toBe(true);

    expect(mockDb.findLatestCompletedTaskForPrHead).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockDb.recordTaskEffectivenessEvent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 123,
      source: "pr-merge",
      signal: "pr-merged",
      sourceSha: HEAD_SHA,
      score: null,
    }));
  });

  it("logs merge effectiveness DB failures but still reports a successful merge", async () => {
    const pr = approvedPR({ headRefName: "claws/issue-42" });
    mockMergeGate({ checkStatus: "passing" });
    mockDb.findLatestCompletedTaskForPrHead.mockRejectedValue(new Error("db offline"));

    await expect(tryMerge(repo, pr)).resolves.toBe(true);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("does not merge a green, cleanly-reviewed Claws PR that has no merge approval (#3135)", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42-ab12" });
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
    mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    // Unapproved is a log line, not a "Merge blocked" comment on the PR.
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — approve the merge from the Claws dashboard`,
      "merge_skipped",
      expect.anything(),
    );
  });

  it("does not merge a PR whose only approval is a forge-applied Automerge label (#3219)", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42-ab12", labels: [{ name: "Automerge" }] });
    mockMergeGate({ checkStatus: "passing", labels: ["Automerge"] });
    mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
    mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");

    expect(await tryMerge(repo, pr)).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — approve the merge from the Claws dashboard`,
      "merge_skipped",
      expect.anything(),
    );
  });

  it("does not merge on the legacy pre-cutover forge-label approval (#3219)", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42-ab12", labels: [{ name: "Automerge" }] });
    setRow(pr.number, { mergeApprovedAt: "2026-09-01T00:00:00Z", mergeApprovedBy: "forge-label" });
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
    mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");

    expect(await tryMerge(repo, pr)).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — approve the merge from the Claws dashboard`,
      "merge_skipped",
      expect.anything(),
    );
  });

  it.each(["oidc-sub-1", "dashboard", "session:abc", "label", "forge:alice"])(
    "merges a green, cleanly-reviewed PR approved by %s",
    async (by) => {
      const pr = mockPR({ headRefName: "claws/issue-42-ab12" });
      setRow(pr.number, { mergeApprovedAt: "2026-09-26T00:00:00Z", mergeApprovedBy: by });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");

      expect(await tryMerge(repo, pr)).toBe(true);
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    },
  );

  it("blocks a PR with no claws_prs row, even an approval-exempt one", async () => {
    const pr = autoBumpPR();
    mockDb.getClawsPr.mockResolvedValueOnce(null);
    mockMergeGate({ checkStatus: "passing" });

    expect(await tryMerge(repo, pr)).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(mockGh.getPRMergeGate).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(`[auto-merger] ${repo.fullName}#${pr.number} skipped: no claws_prs row`, "merge_skipped", expect.anything());
    expect(mockDb.getClawsPr).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("ignores a bare LGTM comment on an unapproved PR (#3135)", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42-ab12" });
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: "LGTM", body_html: "", login: "clawsstjohn[bot]" }]);

    expect(await tryMerge(repo, pr)).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — approve the merge from the Claws dashboard`,
      "merge_skipped",
      expect.anything(),
    );
  });

  it("merges an auto-bump PR when checks are absent but the status carries forward as passing", async () => {
    const pr = autoBumpPR();
    mockMergeGate({ checkStatus: "none" });
    mockGh.carriedForwardCheckStatus.mockResolvedValue("passing");

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges a production-infra auto-bump that swaps its prod registry allowlist entry, without approval", async () => {
    const CFG = "infrastructure/prod/registry/config.json";
    const files = ["apps/namey/deployment.yaml", CFG];
    const pr = autoBumpPR(files);
    mockGh.getPRDiff.mockResolvedValue([
      imagePinDiff(["apps/namey/deployment.yaml"], "v2026-10-13.3", "v2026-10-13.4"),
      `diff --git a/${CFG} b/${CFG}`,
      `--- a/${CFG}`,
      `+++ b/${CFG}`,
      `@@ -51,7 +51,7 @@`,
      `                 "^v2026-10-12\\\\.301$",`,
      `-                "^v2026-10-13\\\\.3$"`,
      `+                "^v2026-10-13\\\\.4$"`,
      `               ]`,
    ].join("\n"));
    mockMergeGate({ checkStatus: "passing" });

    expect(await tryMerge(repo, pr)).toBe(true);
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
  });

  it("skips an auto-bump PR when checks are absent and the status does not carry forward", async () => {
    const pr = autoBumpPR();
    mockMergeGate({ checkStatus: "none" });
    mockGh.carriedForwardCheckStatus.mockResolvedValue("none");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  // Since #3135 the #3051 shape — a human accepting "no checks" on an all-docs diff —
  // reaches the merge through a merge approval, which is allowlisted on status=none in its
  // own right. The CI-exempt disjunct no longer carries this case; see the auto-bump
  // test below for the one shape that still depends on it.
  it("merges an approved PR on a settled head with no checks registered (#3051)", async () => {
    const pr = approvedPR({ headRefName: "claws/issue-42" });
    mockMergeGate({ checkStatus: "none" });
    mockGh.getPRChangedFiles.mockResolvedValue([".agents/issue-refiner.md"]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(true);
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.carriedForwardCheckStatus).not.toHaveBeenCalled();
  });

  it("skips an approved PR with no checks when the head has not settled", async () => {
    const pr = approvedPR({ headRefName: "claws/issue-42" });
    mockMergeGate({ checkStatus: "none" });
    mockGh.getPRChangedFiles.mockResolvedValue([".agents/issue-refiner.md"]);
    mockGh.haveChecksSettled.mockResolvedValue({ settled: false, age: "30s" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips a PR with no merge approval at the approval gate, before checked files matter", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42" });
    mockMergeGate({ checkStatus: "none" });
    mockGh.getPRChangedFiles.mockResolvedValue([".agents/issue-refiner.md"]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — approve the merge from the Claws dashboard`,
      "merge_skipped",
      expect.anything(),
    );
  });

  it("merges an approved non-Claws branch with no checks registered", async () => {
    const pr = approvedPR({ headRefName: "feature/x" });
    mockMergeGate({ checkStatus: "none" });
    // A repo with no PR-reporting CI: a non-exempt path still merges on status=none.
    mockGh.repoExpectsCi.mockResolvedValue(false);
    mockGh.getPRChangedFiles.mockResolvedValue(["src/index.ts"]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(true);
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
  });

  // The one PR shape whose merge still turns on the CI-exempt disjunct: auto-bump is
  // the only approval-exempt category not separately allowlisted on status=none, and a
  // manifest under docs/ is both a .yaml and a CI-exempt path. Drop `ciExemptOnly` from
  // auto-merger.ts and this is the test that goes red.
  it("accepts status=none for an approval-exempt auto-bump PR whose manifests are all CI-exempt", async () => {
    const pr = autoBumpPR(["docs/examples/deployment.yaml"]);
    mockMergeGate({ checkStatus: "none" });
    mockGh.carriedForwardCheckStatus.mockResolvedValue("none");

    expect(await tryMerge(repo, pr)).toBe(true);
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.getPRReviewStatus).not.toHaveBeenCalled();
  });

  // `ciExemptOnly` is `files.every(isCiExemptPath)`: flip it to `some` and an auto-bump
  // PR carrying one docs/ manifest alongside a real one would merge with no CI at all.
  it("does not accept status=none for an auto-bump PR whose manifests are only partly CI-exempt", async () => {
    const pr = autoBumpPR(["docs/examples/deployment.yaml", "apps/bonkus/deployment.yaml"]);
    mockMergeGate({ checkStatus: "none" });
    mockGh.carriedForwardCheckStatus.mockResolvedValue("none");

    expect(await tryMerge(repo, pr)).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips PR when checks are pending", async () => {
    const pr = autoBumpPR();
    mockMergeGate({ checkStatus: "pending" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips PR when checks have failed", async () => {
    const pr = autoBumpPR();
    mockMergeGate({ checkStatus: "failing" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: checks failed`,
      "merge_skipped",
      expect.anything(),
    );
  });

  it("blocks a PR whose runs are held for approval as held, not as failing CI", async () => {
    const pr = autoBumpPR();
    mockMergeGate({ checkStatus: "held", checksTotal: 3, checksHeld: 2 });

    expect(await tryMerge(repo, pr)).toBe(false);

    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: 2 workflow runs held for approval`,
      "merge_skipped",
      expect.anything(),
    );
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("checks failed"), "merge_skipped", expect.anything());
  });

  it("reports a held approved PR's block reason as held for approval", async () => {
    const pr = approvedPR();
    mockMergeGate({ checkStatus: "held", checksTotal: 1, checksHeld: 1 });

    expect(await tryMerge(repo, pr)).toBe(false);

    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(mockGh.setMergeBlockReason).toHaveBeenCalledWith(repo.fullName, pr.number, expect.stringContaining("1 workflow run on the head commit is held for approval — not a CI failure. A human has to approve the runs."), expect.any(String));
    expect(mockGh.setMergeBlockReason).not.toHaveBeenCalledWith(repo.fullName, pr.number, expect.stringContaining("CI is failing"));
  });

  it("skips fork PRs (cross-repository)", async () => {
    const pr = autoBumpPR(undefined, { isCrossRepository: true });
    mockGh.isForkPR.mockReturnValue(true);
    mockMergeGate({ checkStatus: "passing" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("merges any approved PR when checks pass", async () => {
    const pr = approvedPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("skips any PR with no merge approval", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "feature-branch" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — approve the merge from the Claws dashboard`,
      "merge_skipped",
      expect.anything(),
    );
  });

  it("skips an approved PR when checks are failing", async () => {
    const pr = approvedPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
    mockMergeGate({ checkStatus: "failing" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips an approved PR when checks are pending", async () => {
    const pr = approvedPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
    mockMergeGate({ checkStatus: "pending" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("removes no label after merging a non-issue Claws PR", async () => {
    const pr = approvedPR({ author: { login: "someuser" }, headRefName: "claws/improve-something" });
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("merges an approved improve PR when checks pass", async () => {
    const pr = approvedPR({ headRefName: "claws/improve-performance" });
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("removes no label from the source issue after merging a Claws PR", async () => {
    const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
    mockMergeGate({ checkStatus: "passing" });
    // The ordinary single-step PR closes its issue; one that does not parks it (below).
    mockGh.getPRBody.mockResolvedValue("Closes #42");

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("removes no label after merging an auto-bump PR", async () => {
    const pr = autoBumpPR();
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

  it("does not require a merge approval for doc PRs", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockMergeGate({ checkStatus: "none" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.getPRReviewStatus).not.toHaveBeenCalled();
  });

  it("requires a merge approval on a doc PR whose row needs human review (#3124)", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12", labels: [{ name: "Needs LGTM" }] });
    setRow(pr.number, { needsHumanReview: true });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockMergeGate({ checkStatus: "passing", labels: ["Needs LGTM"] });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — approve the merge from the Claws dashboard`,
      "merge_skipped",
      expect.anything(),
    );
  });

  it("ignores a forge Needs LGTM label the row does not record", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12", labels: [{ name: "Needs LGTM" }] });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockMergeGate({ checkStatus: "passing", labels: ["Needs LGTM"] });

    expect(await tryMerge(repo, pr)).toBe(true);
  });

  it("merges a Needs LGTM doc PR once a human approves the merge (#3124)", async () => {
    const pr = approvedPR({ headRefName: "claws/docs-ab12", labels: [{ name: "Needs LGTM" }] });
    setRow(pr.number, { needsHumanReview: true });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockMergeGate({ checkStatus: "passing", labels: ["Needs LGTM"] });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
  });

  it("merges the same doc PR with no Needs LGTM label and no merge approval (#3124)", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
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

  it("does not require a merge approval for idea-collection PRs", async () => {
    const pr = mockPR({ headRefName: "claws/ideas-collect-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["ideas/potential.md"]);
    mockMergeGate({ checkStatus: "none" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.getPRReviewStatus).not.toHaveBeenCalled();
  });

  it("skips PR with merge conflicts", async () => {
    const pr = autoBumpPR();
    mockMergeGate({ checkStatus: "passing", mergeable: "CONFLICTING" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} has merge conflicts, skipping (ci-fixer will resolve)`,
      "merge_skipped",
      expect.anything(),
    );
  });

  it("skips PR when mergeable state is UNKNOWN after retries", async () => {
    const pr = autoBumpPR();
    mockMergeGate({ checkStatus: "passing", mergeable: "UNKNOWN" });
    mockGh.getPRMergeableState.mockResolvedValue("UNKNOWN");

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} mergeable state still UNKNOWN after retries, skipping`,
      "merge_skipped",
      expect.anything(),
    );
  });

  it("skips PR when mergePR throws not-mergeable error", async () => {
    const pr = autoBumpPR();
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.mergePR.mockRejectedValue(new Error("GraphQL: Pull Request is not mergeable (mergePullRequest)"));

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} head moved or was not mergeable at merge time, skipping`,
      "merge_skipped",
      expect.anything(),
    );
  });

  it("rethrows non-mergeable errors from mergePR", async () => {
    const pr = autoBumpPR();
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.mergePR.mockRejectedValue(new Error("GraphQL: Some other unexpected error"));

    await expect(tryMerge(repo, pr)).rejects.toThrow("Some other unexpected error");
    expect(mockGh.removeQueueItem).not.toHaveBeenCalled();
  });

  it("logs reason when fork PR is skipped", async () => {
    const pr = autoBumpPR(undefined, { isCrossRepository: true });
    mockGh.isForkPR.mockReturnValue(true);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: fork PR`,
      "merge_skipped",
      expect.anything(),
    );
  });

  it("skips PRs whose row records a manual action", async () => {
    const pr = mockPR();
    setRow(pr.number, { manualActionReason: "manual action" });
    mockGh.isForkPR.mockReturnValue(false);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("skipped: manual action recorded (manual action)"),
      "merge_skipped",
      expect.anything(),
    );
  });

  it("ignores a forge Manual Action label the row does not record", async () => {
    const pr = autoBumpPR(undefined, { labels: [{ name: "Manual Action" }] });
    mockMergeGate({ checkStatus: "passing", labels: ["Manual Action"] });

    expect(await tryMerge(repo, pr)).toBe(true);
  });

  it("logs reason when doc PR is skipped due to pending checks", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockMergeGate({ checkStatus: "pending" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: checks status=pending`,
      "merge_skipped",
      expect.anything(),
    );
  });

  it("merges auto-bump PR without a merge approval when checks pass and files are deployment-only", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-1.2.3",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml"]);
    mockGh.getPRDiff.mockResolvedValue(imagePinDiff(["apps/bonkus/deployment.yaml"]));

    const result = await tryMerge(repo, pr);

    expect(result).toBe(true);
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.getPRReviewStatus).not.toHaveBeenCalled();
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
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.getPRReviewStatus).not.toHaveBeenCalled();
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
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.getPRReviewStatus).not.toHaveBeenCalled();
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
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.getPRReviewStatus).not.toHaveBeenCalled();
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
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.getPRReviewStatus).not.toHaveBeenCalled();
  });

  it("merges auto-bump PR touching an env-suffixed manifest (fleet-infra apps/claws/deployment-staging.yaml)", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-claws",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/claws/deployment-staging.yaml"]);
    mockGh.getPRDiff.mockResolvedValue(imagePinDiff(["apps/claws/deployment-staging.yaml"]));

    const result = await tryMerge(repo, pr);

    expect(result).toBe(true);
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.getPRReviewStatus).not.toHaveBeenCalled();
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
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.getPRReviewStatus).not.toHaveBeenCalled();
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
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — auto-bump diff is not an image-pin-only bump; approve the merge from the Claws dashboard`,
      "merge_skipped",
      expect.anything(),
    );
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName, pr.number, expect.stringContaining("### Merge blocked"), { agentName: "Auto Merger" },
    );
    expect(mockGh.setMergeBlockReason).toHaveBeenCalledWith(repo.fullName, pr.number, expect.stringContaining("image-pin-only"), "auto-bump-gate");
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
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.setMergeBlockReason).not.toHaveBeenCalled();
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
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — auto-bump PR touches non-bump files; approve the merge from the Claws dashboard`,
      "merge_skipped",
      expect.anything(),
    );
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName, pr.number, expect.stringContaining("### Merge blocked"), { agentName: "Auto Merger" },
    );
    expect(mockGh.setMergeBlockReason).toHaveBeenCalledWith(repo.fullName, pr.number, expect.stringContaining("files other than YAML manifests"), expect.any(String));
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
    // An empty read may be transient, so the hold is log-only.
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — auto-bump PR has no readable changed files; approve the merge from the Claws dashboard`,
      "merge_skipped",
      expect.anything(),
    );
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.setMergeBlockReason).not.toHaveBeenCalled();
  });

  // A registry-host migration is not a routine bump: it loses the auto-bump
  // exemption but merges like any other PR once approved (#clw_01M4RV5WKJT5XQN89BKMN7X8RH).
  describe("auto-bump PR whose diff fails the image-pin-only gate", () => {
    const branch = "automation/bump-bonkus-v2026-10-12.3";
    const labels = [{ name: "dependencies" }, { name: "auto-bump" }];
    const file = "apps/bonkus/deployment.yaml";

    beforeEach(() => {
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRChangedFiles.mockResolvedValue([file]);
      mockGh.getPRDiff.mockResolvedValue(registryHostBumpDiff(file));
    });

    it("is not merged without a merge approval, and says why on the PR", async () => {
      const pr = mockPR({ headRefName: branch, labels });

      expect(await tryMerge(repo, pr)).toBe(false);

      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
      const body = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(body).toContain("### Merge blocked");
      expect(body).toContain("not an image-pin-only bump");
      expect(body).toContain("needs a merge approval");
      expect(mockGh.setMergeBlockReason).toHaveBeenCalledWith(repo.fullName, pr.number, expect.stringContaining("needs a merge approval"), expect.any(String));
    });

    it("is not merged as exempt when the listed head has a cached passing verdict but the live head fails", async () => {
      const pr = mockPR({ headRefOid: "stale-head", headRefName: branch, labels });
      mockGh.getPRDiff.mockResolvedValueOnce(imagePinDiff([file]));
      await autoBumpGateVerdict(repo.fullName, pr, { knownFiles: [file], refresh: true });
      mockMergeGate({ checkStatus: "passing", headSha: "live-head" });

      expect(await tryMerge(repo, pr)).toBe(false);

      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("does not repost an identical hold comment on the next cycle", async () => {
      const pr = mockPR({ headRefName: branch, labels });
      await tryMerge(repo, pr);
      const body = mockGh.commentOnIssue.mock.calls[0][2] as string;
      vi.clearAllMocks();
      mockMergeGate({ checkStatus: "passing" });
      mockGh.isForkPR.mockReturnValue(false);
      mockGh.isDispatchSkippable.mockReturnValue(false);
      mockGh.getPRChangedFiles.mockResolvedValue([file]);
      mockGh.getPRDiff.mockResolvedValue(registryHostBumpDiff(file));
      mockGh.getIssueComments.mockResolvedValue([{ id: 7, body: `*— Automated by Claws · Auto Merger —*\n\n${body}` }]);

      expect(await tryMerge(repo, pr)).toBe(false);

      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockGh.editIssueComment).not.toHaveBeenCalled();
      mockGh.getIssueComments.mockResolvedValue([]);
    });

    it("merges with a merge approval, a clean review of the current head and green checks", async () => {
      const pr = approvedPR({ headRefName: branch, labels });

      expect(await tryMerge(repo, pr)).toBe(true);

      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      expect(mockGh.getPRReviewStatus).toHaveBeenCalled();
    });

    it("is not merged when approved but no review of the current head has run", async () => {
      const pr = approvedPR({ headRefName: branch, labels });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "none", issueCount: 0, reviewedCommit: null });

      expect(await tryMerge(repo, pr)).toBe(false);

      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        `[auto-merger] ${repo.fullName}#${pr.number} skipped: merge approved but review status=none`,
        "merge_skipped",
        expect.anything(),
      );
    });

    it("is not merged when approved but the clean review is for an older commit", async () => {
      const pr = approvedPR({ headRefName: branch, labels });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "0ld0ld0" });

      expect(await tryMerge(repo, pr)).toBe(false);

      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        `[auto-merger] ${repo.fullName}#${pr.number} skipped: merge approved but clean review is stale`,
        "merge_skipped",
        expect.anything(),
      );
    });

    it("is not merged when approved but CI is failing", async () => {
      const pr = approvedPR({ headRefName: branch, labels });
      mockMergeGate({ checkStatus: "failing" });

      expect(await tryMerge(repo, pr)).toBe(false);

      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });
  });

  it("requires a merge approval for PR with auto-bump and major-update labels", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-2.0.0",
      labels: [{ name: "auto-bump" }, { name: "major-update" }],
    });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    // The reason matters: the merge gate is `pending` here, so without this the test
    // would stay green if isAutoBumpPR's major-update guard were deleted outright.
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — approve the merge from the Claws dashboard`,
      "merge_skipped",
      expect.anything(),
    );
  });

  it("does not double-log skip reason when checks are failing", async () => {
    const pr = autoBumpPR();
    mockMergeGate({ checkStatus: "failing" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("skipped: checks status="),
      "merge_skipped",
      expect.anything(),
    );
  });

  describe("merge approval", () => {
    describe("on an approval-exempt PR adds no review gate", () => {
      const noReview = { status: "none", issueCount: 0, reviewedCommit: null };

      /** An auto-bump PR that also carries a stored merge approval. */
      const approvedAutoBump = () => {
        const pr = autoBumpPR();
        setRow(pr.number, { mergeApprovedAt: "2026-09-26T00:00:00Z", mergeApprovedBy: "oidc-sub-1" });
        return pr;
      };

      it("merges an approved auto-bump PR with no review on passing CI", async () => {
        const pr = approvedAutoBump();
        mockGh.getPRReviewStatus.mockResolvedValue(noReview);
        mockMergeGate({ checkStatus: "passing" });

        expect(await tryMerge(repo, pr)).toBe(true);
        expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      });

      it("merges an approved auto-bump PR with no review and no checks on a settled head", async () => {
        const pr = approvedAutoBump();
        mockGh.getPRReviewStatus.mockResolvedValue(noReview);
        mockMergeGate({ checkStatus: "none" });
        mockGh.repoExpectsCi.mockResolvedValue(false);

        expect(await tryMerge(repo, pr)).toBe(true);
      });

      it("merges an approved docs PR with no review", async () => {
        const pr = approvedPR({ headRefName: "claws/docs-ab12" });
        mockGh.getPRReviewStatus.mockResolvedValue(noReview);
        mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
        mockMergeGate({ checkStatus: "passing" });

        expect(await tryMerge(repo, pr)).toBe(true);
      });

      it("still requires a clean review for an approved trusted Renovate PR", async () => {
        const pr = approvedPR({
          title: "chore(deps): update ollama/ollama to v0.12.0",
          headRefName: "renovate/ollama-ollama-0.x",
          author: { login: "renovate" },
          body: "| Package | Update | Change |\n|---|---|---|\n| ollama | minor | `0.11.0` -> `0.12.0` |",
        });
        mockGh.getPRReviewStatus.mockResolvedValue(noReview);
        mockGh.getPRChangedFiles.mockResolvedValue(["apps/ollama/deployment.yaml"]);
        mockMergeGate({ checkStatus: "passing" });

        expect(await tryMerge(repo, pr)).toBe(false);
        expect(mockGh.mergePR).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith(
          `[auto-merger] ${repo.fullName}#${pr.number} skipped: trusted Renovate update but review status=none`,
          "merge_skipped",
          expect.anything(),
        );
      });

      it("still requires a clean review for an approved non-exempt PR", async () => {
        const pr = approvedPR({ author: { login: "someuser" }, headRefName: "feature-branch" });
        mockGh.getPRReviewStatus.mockResolvedValue(noReview);
        mockMergeGate({ checkStatus: "passing" });

        expect(await tryMerge(repo, pr)).toBe(false);
        expect(mockGh.mergePR).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith(
          `[auto-merger] ${repo.fullName}#${pr.number} skipped: merge approved but review status=none`,
          "merge_skipped",
          expect.anything(),
        );
      });
    });

    it("merges an approved claws issue PR when review is clean and reviewedCommit prefixes HEAD", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    });

    it("merges an approved PR whose row also needs human review (#3124)", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
      setRow(pr.number, { needsHumanReview: true });
      mockMergeGate({ checkStatus: "passing", labels: ["Automerge", "Needs LGTM"] });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    });

    it.each(["issues", "escalated", "none"] as const)(
      "skips approved PR when review status is %s",
      async (status) => {
        const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
        mockGh.getPRReviewStatus.mockResolvedValue({ status, issueCount: 0, reviewedCommit: status === "none" ? null : "abc123" });

        const result = await tryMerge(repo, pr);

        expect(result).toBe(false);
        expect(mockGh.mergePR).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith(
          `[auto-merger] ${repo.fullName}#${pr.number} skipped: merge approved but review status=${status}`,
          "merge_skipped",
          expect.anything(),
        );
      },
    );

    it("skips approved PR when reviewedCommit does not prefix the head SHA (stale review)", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "deadbee" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        `[auto-merger] ${repo.fullName}#${pr.number} skipped: merge approved but clean review is stale`,
        "merge_skipped",
        expect.anything(),
      );
    });

    it("merges an approved PR with check status none once checks have settled in a repo with no PR CI", async () => {
      mockGh.repoExpectsCi.mockResolvedValue(false);
      const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
      mockMergeGate({ checkStatus: "none" });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");
      mockGh.haveChecksSettled.mockResolvedValue({ settled: true, age: "600s" });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    });

    it("does not merge an approved PR with check status none while checks have not settled", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
      mockMergeGate({ checkStatus: "none" });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");
      mockGh.haveChecksSettled.mockResolvedValue({ settled: false, age: "30s" });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    describe("no CI result on the head (#clw_01M50MY5NZYBNSG5X0FZYXVVGS)", () => {
      const sha7 = HEAD_SHA.slice(0, 7);
      const cleanApproved = () => {
        mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
        mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");
        mockGh.getPRChangedFiles.mockResolvedValue(["src/index.ts"]);
        return approvedPR({ headRefName: "claws/issue-42-ab12" });
      };

      it("holds a settled head with zero checks and no carry-forward, reporting checks-missing", async () => {
        const pr = cleanApproved();
        mockMergeGate({ checkStatus: "none", checksTotal: 0 });

        const result = await attemptMerge(repo, pr);

        expect(result).toMatchObject({ merged: false, code: "checks-missing" });
        expect((result as { message: string }).message).toContain("CI has not reported");
        expect(mockGh.carriedForwardCheckStatus).toHaveBeenCalledWith(repo.fullName, pr.number);
        expect(mockGh.setMergeBlockReason).toHaveBeenCalledWith(repo.fullName, pr.number, expect.stringContaining(`CI has not reported on head \`${sha7}\``), "checks-missing");
        expect(mockGh.mergePR).not.toHaveBeenCalled();
      });

      it("holds an unsettled head with zero checks quietly as checks-pending", async () => {
        const pr = cleanApproved();
        mockMergeGate({ checkStatus: "none", checksTotal: 0 });
        mockGh.haveChecksSettled.mockResolvedValue({ settled: false, age: "30s" });

        await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: false, code: "checks-pending" });
        expect(mockGh.setMergeBlockReason).not.toHaveBeenCalled();
        expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
        expect(mockGh.mergePR).not.toHaveBeenCalled();
      });

      it("merges when an earlier commit's passing status carries forward", async () => {
        const pr = cleanApproved();
        mockMergeGate({ checkStatus: "none", checksTotal: 0 });
        mockGh.carriedForwardCheckStatus.mockResolvedValue("passing");

        expect(await tryMerge(repo, pr)).toBe(true);
        expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      });

      it("merges when every status on the head is a success", async () => {
        const pr = cleanApproved();
        mockMergeGate({ checkStatus: "passing", checksTotal: 2 });

        expect(await tryMerge(repo, pr)).toBe(true);
        expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      });

      it("does not merge while statuses on the head are pending", async () => {
        const pr = cleanApproved();
        mockMergeGate({ checkStatus: "pending", checksTotal: 2 });

        await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: false, code: "checks-pending" });
        expect(mockGh.mergePR).not.toHaveBeenCalled();
      });

      it("merges on status=none in a repo with no PR-reporting CI", async () => {
        const pr = cleanApproved();
        mockMergeGate({ checkStatus: "none", checksTotal: 0 });
        mockGh.repoExpectsCi.mockResolvedValue(false);

        expect(await tryMerge(repo, pr)).toBe(true);
        expect(mockGh.carriedForwardCheckStatus).not.toHaveBeenCalled();
      });

      it("merges an all-docs diff on status=none even though the repo has CI", async () => {
        const pr = cleanApproved();
        mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md", "README.md"]);
        mockMergeGate({ checkStatus: "none", checksTotal: 0 });

        expect(await tryMerge(repo, pr)).toBe(true);
        expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      });

      it("does not merge an exempt auto-bump PR on status=none when the repo has CI", async () => {
        const pr = autoBumpPR();
        mockMergeGate({ checkStatus: "none", checksTotal: 0 });

        await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: false, code: "checks-missing" });
        expect(mockGh.mergePR).not.toHaveBeenCalled();
      });
    });

    it("skips an approved PR when a manual action is also recorded", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
      setRow(pr.number, { manualActionReason: "set prod secrets" });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.getPRReviewStatus).not.toHaveBeenCalled();
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("skipped: manual action recorded"),
        "merge_skipped",
        expect.anything(),
      );
    });

    // A stacked hold refused behind an operator step is lost when the step is
    // lifted, so the base is checked directly.
    it("does not merge an approved, unheld Claws PR stacked on another branch", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-ab12", baseRefName: "claws/issue-41-cd34" });
      mockMergeGate({ checkStatus: "passing" });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("skipped: stacked on claws/issue-41-cd34"), "merge_skipped", expect.anything());
    });

    // Likewise a re-approval hold refused behind an operator step.
    it("does not merge an approved, unheld PR a design change would close or rework", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
      mockMergeGate({ checkStatus: "passing" });
      mockLinkedIssue.mockResolvedValue({ repo: repo.fullName, ref: 42 });
      mockIsPrHeldForReapproval.mockResolvedValue(true);

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(mockIsPrHeldForReapproval).toHaveBeenCalledWith(repo.fullName, 42, repo.fullName, pr.number);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("held by the design change on"), "merge_skipped", expect.objectContaining({ mergeSkip: "reapproval-hold" }));
    });

    it("merges a PR the pending design change keeps", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
      mockMergeGate({ checkStatus: "passing" });
      mockLinkedIssue.mockResolvedValue({ repo: repo.fullName, ref: 42 });

      expect(await tryMerge(repo, pr)).toBe(true);
    });
  });

  describe("trusted Renovate updates", () => {
    const MINOR_BODY = [
      "This PR contains the following updates:",
      "",
      "| Package | Update | Change |",
      "|---|---|---|",
      "| [ollama/ollama](https://github.com/ollama/ollama) | minor | `0.11.0` -> `0.12.0` |",
      "",
      "---",
    ].join("\n");

    /** A minor Renovate PR with a clean review of its current head, passing CI and no infra. */
    function renovatePR(over: Parameters<typeof mockPR>[0] = {}): ReturnType<typeof mockPR> {
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc1234" });
      mockGh.getPRHeadSHA.mockResolvedValue(HEAD_SHA);
      mockGh.getPRChangedFiles.mockResolvedValue(["apps/ollama/deployment.yaml"]);
      mockMergeGate({ checkStatus: "passing" });
      return mockPR({
        title: "chore(deps): update ollama/ollama to v0.12.0",
        headRefName: "renovate/ollama-ollama-0.x",
        author: { login: "stjohnb" },
        body: MINOR_BODY,
        labels: [{ name: "Automerge" }],
        ...over,
      });
    }

    it.each(["stjohnb", "renovate"])(
      "merges a minor update authored by %s with no merge approval",
      async (login) => {
        const pr = renovatePR({ author: { login } });

        expect(await tryMerge(repo, pr)).toBe(true);
        expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      },
    );

    it("merges a trusted Renovate PR passing every gate at 14:00 Europe/London", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-09-24T13:00:00Z"));
        const pr = renovatePR();

        expect(await tryMerge(repo, pr)).toBe(true);
        expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each<[string, Parameters<typeof mockPR>[0]]>([
      ["a major-update label", { labels: [{ name: "major-update" }] }],
      ["a major row in the body's Update column", { body: MINOR_BODY.replace("| minor |", "| major |") }],
      ["a body with no update table", { body: "Bumps ollama." }],
      ["a (major) title", { title: "chore(deps): update ollama/ollama to v1 (major)" }],
      ["a renovate/major- branch", { headRefName: "renovate/major-ollama-ollama" }],
    ])("does not merge a Renovate PR with %s", async (_what, over) => {
      const pr = renovatePR(over);

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("skipped: not approved"), "merge_skipped", expect.anything());
    });

    it("says the update type is unknown when the body has no Renovate table", async () => {
      expect(await tryMerge(repo, renovatePR({ body: "Bumps ollama." }))).toBe(false);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("update type unknown (body has no Renovate table)"), "merge_skipped", expect.objectContaining({ mergeSkip: "not-approved" }));
    });

    it("keeps the generic reason for a labelled major", async () => {
      expect(await tryMerge(repo, renovatePR({ labels: [{ name: "major-update" }] }))).toBe(false);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("skipped: not approved — approve the merge from the Claws dashboard"), "merge_skipped", expect.anything());
    });

    it("merges when a Claws summary precedes Renovate's minor table", async () => {
      const pr = renovatePR({ body: "## Summary\nLockfile.\n\n---\n*— CI fixed with: sonnet (provider: claude) —*\n\n" + MINOR_BODY });
      expect(await tryMerge(repo, pr)).toBe(true);
    });

    it.each<[string, Parameters<typeof mockPR>[0]]>([
      ["Claws' own login", { author: { login: "claws-bot[bot]" } }],
      ["an unlisted login", { author: { login: "stranger" } }],
      ["a fork", { isCrossRepository: true }],
      ["a non-renovate/ branch", { headRefName: "deps/ollama" }],
      ["the Renovate GitHub App", { author: { login: "renovate[bot]" } }],
      ["the Renovate GitHub App in app/ form", { author: { login: "app/renovate" } }],
    ])("does not treat a PR from %s as a trusted Renovate update", async (_what, over) => {
      const pr = renovatePR(over);
      if (over?.isCrossRepository) mockGh.isForkPR.mockReturnValue(true);

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(await isApprovalExempt(repo.fullName, pr, prRow(pr.number))).toBe(false);
    });

    it.each(["issues", "escalated", "none"] as const)("does not merge when the review is %s", async (status) => {
      const pr = renovatePR();
      mockGh.getPRReviewStatus.mockResolvedValue({ status, issueCount: 0, reviewedCommit: "abc1234" });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        `[auto-merger] ${repo.fullName}#${pr.number} skipped: trusted Renovate update but review status=${status}`,
        "merge_skipped",
        expect.anything(),
      );
    });

    it("does not merge when the clean review is for an older head", async () => {
      const pr = renovatePR();
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "deadbee" });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(log.info).toHaveBeenCalledWith(
        `[auto-merger] ${repo.fullName}#${pr.number} skipped: trusted Renovate update but clean review is stale`,
        "merge_skipped",
        expect.anything(),
      );
    });

    it("does not accept check status none", async () => {
      const pr = renovatePR();
      mockMergeGate({ checkStatus: "none" });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("does not merge one touching tofu files", async () => {
      const pr = renovatePR();
      mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("infrastructure changes require a human merge"), "merge_skipped", expect.objectContaining({ mergeSkip: "infra" }));
    });

    it("does not merge one with a manual action recorded", async () => {
      const pr = renovatePR();
      setRow(pr.number, { manualActionReason: "rotate keys" });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("does not merge an approved PR with an operator-step hold, and says how to finish the step", async () => {
      const pr = renovatePR();
      setRow(pr.number, { manualActionReason: "rotate keys", mergeApprovedAt: "2026-10-13T00:00:00Z", mergeApprovedBy: "dashboard" });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      const report = mockGh.commentOnIssue.mock.calls.map((c) => c[2] as string).find((b) => b.includes("Merge blocked"));
      expect(report).toContain("out of **Blocked**");
      expect(report).not.toContain("restores the label");
    });

    it("does not merge one whose row needs human review", async () => {
      const pr = renovatePR();
      setRow(pr.number, { needsHumanReview: true });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("skipped: not approved"), "merge_skipped", expect.anything());
    });

    it("never reads the Automerge label: a non-Renovate PR carrying it does not merge", async () => {
      const pr = renovatePR({ headRefName: "claws/issue-42-ab12", author: { login: "stjohnb" } });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("skipped: not approved"), "merge_skipped", expect.anything());
    });
  });

  describe("infra (tofu/terraform) gate (#2275)", () => {
    it("does not merge an approved PR with a clean, fresh review that touches tofu files", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");
      mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("infrastructure changes require a human merge"),
        "merge_skipped",
        expect.objectContaining({ mergeSkip: "infra" }),
      );
    });

    // The gate sits after the approval branch, so it fires for every approval-exempt
    // category too — nothing else covers the "outranks every exemption" half.
    it("does not merge an approval-exempt auto-bump PR touching tofu files", async () => {
      const pr = autoBumpPR(["tofu/k8s/deployment.yaml"]);
      mockMergeGate({ checkStatus: "passing" });
      expect(await isApprovalExempt(repo.fullName, pr, prRow(pr.number))).toBe(true);

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("infrastructure changes require a human merge"),
        "merge_skipped",
        expect.objectContaining({ mergeSkip: "infra" }),
      );
    });

    describe("session infra-merge capability (#clw_01M54GYV05ZCZWKEEMAJTE9Q3X)", () => {
      it("still refuses a tofu PR from tryMerge, which never passes infraMergeBy", async () => {
        const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
        mockMergeGate({ checkStatus: "passing" });
        mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);

        expect(await tryMerge(repo, pr)).toBe(false);
        expect(mockGh.mergePR).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith(expect.any(String), "merge_skipped", expect.objectContaining({ mergeSkip: "infra" }));
      });

      it("refuses a tofu PR from attemptMerge without infraMergeBy", async () => {
        const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
        mockMergeGate({ checkStatus: "passing" });
        mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);
        mockGh.getPRDiff.mockResolvedValue("diff --git a/tofu/main.tf b/tofu/main.tf\n--- a/tofu/main.tf\n+++ b/tofu/main.tf\n@@ -1 +1 @@\n-  size = 1\n+  size = 2\n");

        await expect(attemptMerge(repo, pr, { mergedBy: "session:abc123" })).resolves.toEqual({
          merged: false,
          code: "infra",
          message: "Infrastructure changes (tofu/main.tf) always need a human merge. The no-op plan exception does not apply: non-comment change in tofu/main.tf.",
        });
      });

      it("merges an approved, clean, green tofu PR with infraMergeBy and answers its infra paths", async () => {
        const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
        mockMergeGate({ checkStatus: "passing" });
        mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf", "README.md"]);
        mockDb.findLatestCompletedTaskForPrHead.mockResolvedValue({ id: 123 });

        await expect(attemptMerge(repo, pr, { mergedBy: "session:abc123", infraMergeBy: "abc123" }))
          .resolves.toEqual({ merged: true, infraPaths: ["tofu/main.tf"] });
        expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
        expect(mockGh.getTofuPlanEvidence).not.toHaveBeenCalled();
        expect(mockDb.recordTaskEffectivenessEvent).toHaveBeenCalledWith(expect.objectContaining({
          details: { mergedBy: "session:abc123", infraMergeCapability: true },
        }));
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("counted as the human merge by abc123 under the infra-merge capability"));
      });

      it("still refuses with infraMergeBy on a stale review", async () => {
        const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
        mockGh.getPRHeadSHA.mockResolvedValue("fff0000000");
        mockMergeGate({ checkStatus: "passing" });
        mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);

        await expect(attemptMerge(repo, pr, { infraMergeBy: "abc123" })).resolves.toMatchObject({ merged: false, code: "review-stale" });
        expect(mockGh.mergePR).not.toHaveBeenCalled();
      });

      it("still refuses with infraMergeBy when CI fails", async () => {
        const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
        mockMergeGate({ checkStatus: "failing" });
        mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);

        await expect(attemptMerge(repo, pr, { infraMergeBy: "abc123" })).resolves.toEqual({ merged: false, code: "checks-failed", message: "CI is failing." });
        expect(mockGh.mergePR).not.toHaveBeenCalled();
      });

      it("still refuses with infraMergeBy on a merge conflict", async () => {
        const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
        mockMergeGate({ checkStatus: "passing", mergeable: "CONFLICTING" });
        mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);

        await expect(attemptMerge(repo, pr, { infraMergeBy: "abc123" })).resolves.toMatchObject({ merged: false, code: "conflict" });
        expect(mockGh.mergePR).not.toHaveBeenCalled();
      });

      it("still refuses with infraMergeBy on a recorded manual action", async () => {
        const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
        setRow(pr.number, { manualActionReason: "apply by hand" });
        mockMergeGate({ checkStatus: "passing" });
        mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);

        await expect(attemptMerge(repo, pr, { infraMergeBy: "abc123" })).resolves.toMatchObject({ merged: false, code: "manual-action" });
        expect(mockGh.mergePR).not.toHaveBeenCalled();
      });

      it("requires a clean review of an approval-exempt auto-bump tofu PR with infraMergeBy", async () => {
        const pr = autoBumpPR(["tofu/k8s/deployment.yaml"]);
        mockMergeGate({ checkStatus: "passing" });
        mockGh.getPRReviewStatus.mockResolvedValue({ status: "issues", issueCount: 1, reviewedCommit: "abc1234" });

        await expect(attemptMerge(repo, pr, { infraMergeBy: "abc123" })).resolves.toMatchObject({ merged: false, code: "review-not-clean" });
        expect(mockGh.mergePR).not.toHaveBeenCalled();
      });
    });

    describe("board infra merge approval (#clw_01M5WBG6JZ8P3PCYVCQ3PS9BBS)", () => {
      const BOARD = { infraMergeApprovedBy: "oidc-sub-1", infraMergeApprovedAt: "2026-10-26T10:00:00Z" };

      it("merges from the sweep with an approval for the current head, recording the approver", async () => {
        const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
        setRow(pr.number, { ...BOARD, infraMergeApprovedSha: HEAD_SHA });
        mockMergeGate({ checkStatus: "passing" });
        mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);
        mockDb.findLatestCompletedTaskForPrHead.mockResolvedValue({ id: 123 });

        await expect(attemptMerge(repo, pr)).resolves.toEqual({ merged: true });
        expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
        expect(mockDb.recordTaskEffectivenessEvent).toHaveBeenCalledWith(expect.objectContaining({
          details: { mergedBy: "auto-merger", infraMergeApprovedBy: "oidc-sub-1" },
        }));
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("counted as the human merge by the board approval by oidc-sub-1"));
      });

      it("blocks as infra-approval-stale when the head moved since the approval", async () => {
        const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
        setRow(pr.number, { ...BOARD, infraMergeApprovedSha: "0001112223" });
        mockMergeGate({ checkStatus: "passing" });
        mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);

        const result = await attemptMerge(repo, pr);
        expect(result).toMatchObject({ merged: false, code: "infra-approval-stale" });
        expect((result as { message: string }).message).toContain("approved by oidc-sub-1 for 0001112, but the head is now abc1234");
        expect(mockGh.mergePR).not.toHaveBeenCalled();
      });

      it("still refuses with only the ordinary merge approval set", async () => {
        const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
        mockMergeGate({ checkStatus: "passing" });
        mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);

        expect(await tryMerge(repo, pr)).toBe(false);
        expect(mockGh.mergePR).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith(expect.any(String), "merge_skipped", expect.objectContaining({ mergeSkip: "infra" }));
      });

      it("still needs a clean review of the head and green CI with a current approval", async () => {
        const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
        setRow(pr.number, { ...BOARD, infraMergeApprovedSha: HEAD_SHA });
        mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);
        mockMergeGate({ checkStatus: "failing" });
        await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: false, code: "checks-failed" });
        mockMergeGate({ checkStatus: "passing" });
        mockGh.getPRReviewStatus.mockResolvedValue({ status: "issues", issueCount: 1, reviewedCommit: "abc1234" });
        await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: false, code: "review-not-clean" });
        expect(mockGh.mergePR).not.toHaveBeenCalled();
      });
    });

    it("fails closed when getPRChangedFiles returns empty but the PR has known changed files", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-ab12", changedFiles: 3 });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRChangedFiles.mockResolvedValue([]);

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        `[auto-merger] ${repo.fullName}#${pr.number} skipped: could not read changed files`,
        "merge_skipped",
        expect.anything(),
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

  describe("no-op Tofu plan exception: pin-only diff", () => {
    const PIN_FILES = ["tofu/versions.tf", "tofu/.terraform.lock.hcl"];
    const NOOP = { plan: { add: 0, change: 0, replace: 0, destroy: 0 }, state: "noop", detail: "no-op plan" };
    const sec = (path: string, body: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}\n`;
    const PIN_DIFF = sec("tofu/versions.tf", "@@ -1 +1 @@\n-      version = \"6.66.0\"\n+      version = \"6.67.0\"")
      + sec("tofu/.terraform.lock.hcl", "@@ -1 +1 @@\n-  version = \"6.66.0\"\n+  version = \"6.67.0\"");

    /** A pin-only provider bump with green CI and a clean review of the current head. The
     *  exception applies to any author; the Renovate author only makes the PR approval-exempt. */
    function renovatePinPR(over: Parameters<typeof mockPR>[0] = {}): ReturnType<typeof mockPR> {
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc1234" });
      mockGh.getPRHeadSHA.mockResolvedValue(HEAD_SHA);
      mockGh.getPRChangedFiles.mockResolvedValue(PIN_FILES);
      mockGh.getPRDiff.mockResolvedValue(PIN_DIFF);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getTofuPlanEvidence.mockResolvedValue(NOOP);
      return mockPR({
        author: { login: "renovate" },
        headRefName: "renovate/hashicorp-aws-6.x",
        title: "chore(deps): update terraform aws to v6.67.0",
        body: "| Package | Update | Change |\n|---|---|---|\n| aws | minor | `6.66.0` -> `6.67.0` |",
        labels: [],
        ...over,
      });
    }

    it("merges a pin-only Renovate PR whose verified plan is a no-op", async () => {
      const pr = renovatePinPR();

      expect(await tryMerge(repo, pr)).toBe(true);
      expect(mockGh.getTofuPlanEvidence).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("no-op Tofu plan verified for head abc1234"));
    });

    it("does not merge when the plan shows a change", async () => {
      const pr = renovatePinPR();
      mockGh.getTofuPlanEvidence.mockResolvedValue({ plan: { add: 0, change: 1, replace: 0, destroy: 0 }, state: "changes", detail: "plan shows 1 change" });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("infrastructure plan shows 1 change, human merge required"), "merge_skipped", expect.objectContaining({ mergeSkip: "infra-plan" }));
    });

    it.each([
      ["the plan run failed", "Tofu Plan run is failure"],
      ["the plan comment is for an older head", "plan comment predates the run for this head"],
    ])("does not merge when %s", async (_what, detail) => {
      const pr = renovatePinPR();
      mockGh.getTofuPlanEvidence.mockResolvedValue({ plan: NOOP.plan, state: "unavailable", detail });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining(`infrastructure plan not available for head abc1234 (${detail})`), "merge_skipped", expect.objectContaining({ mergeSkip: "infra-plan" }));
    });

    it.each([
      ["a .tf resource file", "tofu/main.tf"],
      ["a workflow", ".github/workflows/tofu-plan-on-pr.yml"],
    ])("does not merge a pin bump that also touches %s, without reading the plan", async (_what, extra) => {
      const pr = renovatePinPR();
      mockGh.getPRChangedFiles.mockResolvedValue([...PIN_FILES, extra]);

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.getTofuPlanEvidence).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("infrastructure changes require a human merge"), "merge_skipped", expect.objectContaining({ mergeSkip: "infra" }));
    });

    it("does not treat a major Renovate bump as approval-exempt", async () => {
      const pr = renovatePinPR({
        author: { login: "renovate" },
        headRefName: "renovate/major-hashicorp-aws",
        title: "chore(deps): update terraform aws to v7",
        labels: [],
      });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(log.info).toHaveBeenCalledWith(expect.anything(), "merge_skipped", expect.objectContaining({ mergeSkip: "not-approved" }));
      expect(mockGh.getTofuPlanEvidence).not.toHaveBeenCalled();
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("does not accept status=none for a no-op plan PR", async () => {
      const pr = renovatePinPR();
      mockMergeGate({ checkStatus: "none", checksTotal: 0 });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });
  });

  describe("no-op Tofu plan exception for Forgejo provider bumps", () => {
    const NOOP = { plan: { add: 0, change: 0, replace: 0, destroy: 0 }, state: "noop", detail: "no-op plan" };
    const FILES = ["tofu/versions.tf", "tofu/data-server.tf", "docs/supabase.md"];
    const sec = (path: string, body: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}\n`;
    const BUMP_DIFF = sec("tofu/versions.tf", "@@ -1 +1 @@\n-      version = \"1.69.0\"\n+      version = \"1.70.0\"")
      + sec("tofu/data-server.tf", "@@ -1 +1 @@\n-# hcloud 1.69.0\n+# hcloud 1.70.0")
      + sec("docs/supabase.md", "@@ -1 +1 @@\n-1.69.0\n+1.70.0");

    /** A Claws-authored, approved provider bump with green CI, a clean review and a no-op plan. */
    function clawsBumpPR(): ReturnType<typeof mockPR> {
      const pr = approvedPR({ headRefName: "claws/issue-121-ab12", author: { login: "claws-implementer" } });
      mockGh.getPRChangedFiles.mockResolvedValue(FILES);
      mockGh.getPRDiff.mockResolvedValue(BUMP_DIFF);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getTofuPlanEvidence.mockResolvedValue(NOOP);
      return pr;
    }

    it("merges a Claws-authored provider bump, labelling it for the apply guard first", async () => {
      const pr = clawsBumpPR();

      expect(await tryMerge(repo, pr)).toBe(true);
      expect(mockGh.ensureLabel).toHaveBeenCalledWith(repo.fullName, "claws-noop-merge", expect.objectContaining({ color: "5319e7" }));
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "claws-noop-merge");
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      expect(mockGh.addLabel.mock.invocationCallOrder[0]).toBeLessThan(mockGh.mergePR.mock.invocationCallOrder[0]!);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("allowing a no-op provider bump merge"));
    });

    it("removes a stale claws-noop-merge label when the plan shows changes", async () => {
      const pr = clawsBumpPR();
      pr.labels = [{ name: "claws-noop-merge" }];
      mockGh.getTofuPlanEvidence.mockResolvedValue({ plan: { add: 0, change: 1, replace: 0, destroy: 0 }, state: "changes", detail: "changes" });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "claws-noop-merge");
    });

    it("removes the claws-noop-merge label when the merge is rejected after labelling", async () => {
      const pr = clawsBumpPR();
      mockGh.mergePR.mockRejectedValue(new Error("Pull Request is not mergeable"));

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "claws-noop-merge");
    });

    it("does not merge without a merge approval", async () => {
      const pr = clawsBumpPR();
      setRow(pr.number, { mergeApprovedAt: null, mergeApprovedBy: null });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, pr.number, "claws-noop-merge");
    });

    it("does not merge when CI is failing", async () => {
      const pr = clawsBumpPR();
      mockMergeGate({ checkStatus: "failing" });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("does not merge without a clean review of the head", async () => {
      const pr = clawsBumpPR();
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "issues", issueCount: 1, reviewedCommit: "abc1234" });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it.each([
      ["unavailable", { plan: NOOP.plan, state: "unavailable", detail: "plan comment predates the head commit" }, "infrastructure plan not available"],
      ["changes", { plan: { add: 0, change: 0, replace: 1, destroy: 0 }, state: "changes", detail: "plan shows 1 change" }, "infrastructure plan shows 1 change"],
    ])("does not merge when the plan evidence is %s", async (_state, evidence, message) => {
      const pr = clawsBumpPR();
      mockGh.getTofuPlanEvidence.mockResolvedValue(evidence);

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining(message), "merge_skipped", expect.objectContaining({ mergeSkip: "infra-plan" }));
    });

    it.each([
      ["a non-comment .tf change", ["tofu/versions.tf", "tofu/data-server.tf"], sec("tofu/versions.tf", "@@ -1 +1 @@\n-a\n+b") + sec("tofu/data-server.tf", "@@ -1 +1 @@\n-  size = 1\n+  size = 2"), "non-comment change in tofu/data-server.tf"],
      ["a workflow file", ["tofu/versions.tf", ".forgejo/workflows/tofu-apply.yml"], sec("tofu/versions.tf", "@@ -1 +1 @@\n-a\n+b") + sec(".forgejo/workflows/tofu-apply.yml", "@@ -1 +1 @@\n-a\n+b"), "changes workflow file .forgejo/workflows/tofu-apply.yml"],
    ])("holds a diff with %s without reading the plan, naming the reason", async (_what, files, diff, reason) => {
      const pr = clawsBumpPR();
      mockGh.getPRChangedFiles.mockResolvedValue(files);
      mockGh.getPRDiff.mockResolvedValue(diff);

      await expect(attemptMerge(repo, pr)).resolves.toMatchObject({
        merged: false,
        code: "infra",
        message: expect.stringContaining(`always need a human merge. The no-op plan exception does not apply: ${reason}.`),
      });
      expect(mockGh.getTofuPlanEvidence).not.toHaveBeenCalled();
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("skips the merge when the PR cannot be labelled for the apply guard", async () => {
      const pr = clawsBumpPR();
      mockGh.addLabel.mockRejectedValueOnce(new Error("label could not be resolved"));

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("could not label the PR for the no-op apply guard"), "merge_skipped", expect.objectContaining({ mergeSkip: "error" }));
    });
  });

  describe("live merge gate (#2354)", () => {
    it("does not merge an exempt PR with no checks when the head commit is seconds old", async () => {
      const pr = autoBumpPR();
      mockMergeGate({ checkStatus: "none", checksTotal: 0 });
      mockGh.haveChecksSettled.mockResolvedValue({ settled: false, age: "30s" });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("waiting for CI to register"),
        "merge_skipped",
        expect.objectContaining({ mergeSkip: "checks-pending" }),
      );
    });

    it("merges an exempt PR with no checks once the head commit has settled in a repo with no PR CI", async () => {
      mockGh.repoExpectsCi.mockResolvedValue(false);
      const pr = autoBumpPR();
      mockMergeGate({ checkStatus: "none", checksTotal: 0 });
      mockGh.haveChecksSettled.mockResolvedValue({ settled: true, age: "600s" });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    });

    it("checks the settle window against the live head SHA", async () => {
      const pr = autoBumpPR();
      mockMergeGate({ checkStatus: "none", checksTotal: 0 });
      mockGh.haveChecksSettled.mockResolvedValue({ settled: false, age: "unknown" });

      const result = await tryMerge(repo, pr);

      expect(mockGh.haveChecksSettled).toHaveBeenCalledWith(repo.fullName, HEAD_SHA);
      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("does not merge when the live PR state is no longer OPEN", async () => {
      const pr = autoBumpPR();
      mockMergeGate({ state: "CLOSED", checkStatus: "passing" });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("skipped: state=CLOSED"),
        "merge_skipped",
        expect.anything(),
      );
    });

    it("does not merge when the live dispatch guard rejects labels re-read at merge time", async () => {
      const pr = autoBumpPR(undefined, { labels: [{ name: "Claws Staging" }] });
      mockMergeGate({ labels: [], checkStatus: "passing" });
      mockGh.isDispatchSkippable.mockReturnValueOnce(true);

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.isDispatchSkippable).toHaveBeenCalledWith(repo.fullName, { number: pr.number, labels: [] });
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("does not merge when the live rollup reports a failing (cancelled) check", async () => {
      const pr = autoBumpPR();
      mockMergeGate({ checkStatus: "failing", checksTotal: 2 });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        `[auto-merger] ${repo.fullName}#${pr.number} skipped: checks failed`,
        "merge_skipped",
        expect.anything(),
      );
    });

    it("returns false without rethrowing when the head moved between evaluation and merge", async () => {
      const pr = autoBumpPR();
      mockMergeGate({ checkStatus: "passing" });
      mockGh.mergePR.mockRejectedValue(
        new Error("Head branch was modified. Review and try the merge again."),
      );

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("head moved or was not mergeable at merge time"),
        "merge_skipped",
        expect.objectContaining({ mergeSkip: "head-moved" }),
      );
    });
  });

  describe("post-merge manual action announcement", () => {
    it("comments and pings Slack when the merged body has a post-merge section", async () => {
      const pr = autoBumpPR();
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
        expect.stringContaining(`https://git.example.com/${repo.fullName}/pulls/${pr.number}`),
      );
      expect(mockNotify).not.toHaveBeenCalledWith(expect.stringContaining("github.com"));
    });

    it("does not comment or ping Slack when the post-merge note is verification-only", async () => {
      const pr = autoBumpPR();
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
      const pr = autoBumpPR();
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue("## Summary\nDid the thing.");

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it("does not throw and still reports success when getPRBody rejects", async () => {
      const pr = autoBumpPR();
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockRejectedValue(new Error("boom"));

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });
  });

  describe("image-scan snapshot and prune PRs (#clw_01M61EFZ6ZZM8FWGN2PAH3KNZB)", () => {
    const SCANNED = "a".repeat(40);
    const PRUNE_BODY = `Prunes unused exceptions.\n\nimage-scan-scanned-commit: ${SCANNED}\n`;
    const snapshotPR = (files = ["security/image-scan/advisories.json"]) => {
      mockGh.getPRChangedFiles.mockResolvedValue(files);
      return mockPR({ number: 296, headRefName: "automation/image-scan-advisories", labels: [{ name: "auto-bump" }] });
    };
    const prunePR = (body = PRUNE_BODY) => {
      mockGh.getPRChangedFiles.mockResolvedValue(["security/image-scan/exceptions.yaml"]);
      return mockPR({ number: 516, headRefName: "automation/image-scan-exceptions-prune", labels: [{ name: "ci" }], body });
    };
    const cleanReview = () => {
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc1234" });
      mockGh.getPRHeadSHA.mockResolvedValue(HEAD_SHA);
    };

    beforeEach(() => {
      mockMergeGate({ checkStatus: "passing" });
      mockGh.listPRCommits.mockResolvedValue([{ sha: "c".repeat(40), parents: [SCANNED], subject: "chore: prune unused exceptions" }]);
      mockGh.listCompareChangedFiles.mockResolvedValue({ totalCommits: 1, commits: [{ sha: "d".repeat(40), files: ["docs/README.md"] }] });
      mockGh.getCommitDiff.mockResolvedValue("");
    });

    it("merges a snapshot-only refresh on green CI and a clean review with no merge approval", async () => {
      const pr = snapshotPR();
      cleanReview();
      expect(await isApprovalExempt(repo.fullName, pr, prRow(pr.number))).toBe(true);
      expect(await tryMerge(repo, pr)).toBe(true);
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    });

    it("holds an exempt snapshot refresh until its head has a clean review", async () => {
      const pr = snapshotPR();
      expect(await tryMerge(repo, pr)).toBe(false);
      expect(log.info).toHaveBeenCalledWith(
        `[auto-merger] ${repo.fullName}#${pr.number} skipped: image-scan snapshot refresh but review status=none`,
        "merge_skipped",
        expect.anything(),
      );
    });

    it("holds a snapshot PR that changes another file, naming it", async () => {
      const pr = snapshotPR(["security/image-scan/advisories.json", "README.md"]);
      cleanReview();
      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — snapshot PR changes files other than security/image-scan/advisories.json: README.md; approve the merge from the Claws dashboard`,
        "merge_skipped",
        expect.objectContaining({ mergeSkip: "image-scan-gate" }),
      );
      expect(mockGh.setMergeBlockReason).toHaveBeenCalledWith(repo.fullName, pr.number, expect.stringContaining("README.md"), "image-scan-gate");
      expect(await approvalHoldReason(repo.fullName, pr)).toBe(
        "snapshot PR changes files other than security/image-scan/advisories.json: README.md",
      );
    });

    it("merges a clean prune with no merge approval", async () => {
      const pr = prunePR();
      cleanReview();
      expect(await tryMerge(repo, pr)).toBe(true);
      expect(mockGh.listCompareChangedFiles).toHaveBeenCalledWith(repo.fullName, SCANNED, BASE_SHA);
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    });

    it("holds a prune carrying a merge commit, and merges it once approved", async () => {
      mockGh.listPRCommits.mockResolvedValue([
        { sha: "c".repeat(40), parents: [SCANNED], subject: "chore: prune unused exceptions" },
        { sha: "e".repeat(40), parents: ["c".repeat(40), BASE_SHA], subject: "Merge branch 'main'" },
      ]);
      const pr = prunePR();
      cleanReview();
      expect(await tryMerge(repo, pr)).toBe(false);
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("skipped: not approved — prune PR carries a conflict-resolution merge"),
        "merge_skipped",
        expect.objectContaining({ mergeSkip: "image-scan-gate" }),
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName, pr.number, expect.stringContaining("prune PR carries a conflict-resolution merge"), { agentName: "Auto Merger" },
      );
      expect(await approvalHoldReason(repo.fullName, pr)).toBe("prune PR carries a conflict-resolution merge");

      setRow(pr.number, { mergeApprovedAt: "2026-10-28T00:00:00Z", mergeApprovedBy: "oidc-sub-1" });
      expect(await tryMerge(repo, pr)).toBe(true);
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    });

    it("holds a prune whose scan predates a newTag: change under apps/ on main", async () => {
      mockGh.listCompareChangedFiles.mockResolvedValue({ totalCommits: 1, commits: [{ sha: "f".repeat(40), files: ["apps/web/kustomization.yaml"] }] });
      mockGh.getCommitDiff.mockResolvedValue([
        "diff --git a/apps/web/kustomization.yaml b/apps/web/kustomization.yaml",
        "--- a/apps/web/kustomization.yaml",
        "+++ b/apps/web/kustomization.yaml",
        "@@ -5,1 +5,1 @@",
        "-    newTag: v1",
        "+    newTag: v2",
      ].join("\n"));
      const pr = prunePR();
      cleanReview();
      expect(await tryMerge(repo, pr)).toBe(false);
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("skipped: not approved — prune scan predates image-pin changes on main (apps/web/kustomization.yaml)"),
        "merge_skipped",
        expect.objectContaining({ mergeSkip: "image-scan-gate" }),
      );
    });

    it("holds a prune that records no scanned commit", async () => {
      const pr = prunePR("Prunes unused exceptions.");
      cleanReview();
      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(await approvalHoldReason(repo.fullName, pr)).toBe("prune PR records no scanned commit");
      expect(await isApprovalExempt(repo.fullName, pr, prRow(pr.number))).toBe(false);
    });

    it("keeps an unverifiable prune log-only", async () => {
      mockGh.listCompareChangedFiles.mockRejectedValue(new Error("forgejo 502"));
      const pr = prunePR();
      cleanReview();
      expect(await tryMerge(repo, pr)).toBe(false);
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("could not verify main's image pins since the scanned commit"),
        "merge_skipped",
        expect.objectContaining({ mergeSkip: "image-scan-gate" }),
      );
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });
  });

  // pr-dispatcher calls isApprovalExempt directly to decide whether a PR is close
  // enough to merging that advisory nits should be left alone; a Needs LGTM PR
  // is not, so it is handled like any other human-gated PR there.
  describe("isApprovalExempt for auto-bump PRs", () => {
    const bump = () => mockPR({ headRefName: "automation/bump-bonkus-v2026-10-12.3", labels: [{ name: "auto-bump" }] });

    it("is false for a registry-host change", async () => {
      mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml"]);
      mockGh.getPRDiff.mockResolvedValue(registryHostBumpDiff());
      expect(await isApprovalExempt(repo.fullName, bump(), prRow(1))).toBe(false);
    });

    it("is true for a same-registry pin bump", async () => {
      mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml"]);
      mockGh.getPRDiff.mockResolvedValue(imagePinDiff(["apps/bonkus/deployment.yaml"]));
      expect(await isApprovalExempt(repo.fullName, bump(), prRow(1))).toBe(true);
    });

    it("leaves an unapproved registry-host bump idle awaiting a human once its head is reviewed clean", async () => {
      mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml"]);
      mockGh.getPRDiff.mockResolvedValue(registryHostBumpDiff());
      const pr = mockPR({ headRefOid: "abc123", headRefName: "automation/bump-bonkus-v2026-10-12.3", labels: [{ name: "auto-bump" }] });
      const row = prRow(1, { stage: "awaiting-merge", reviewedSha: "abc123", headSha: "abc123", reviewVerdict: "clean" });
      expect(await isIdleAwaitingHuman(repo.fullName, pr, row)).toBe(true);
    });
  });

  describe("autoBumpGateVerdict", () => {
    it("reuses the cached verdict for the same head and recomputes on refresh", async () => {
      const pr = mockPR({ headRefOid: "abc123", headRefName: "automation/bump-bonkus-1.2.3", labels: [{ name: "auto-bump" }] });
      mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml"]);
      mockGh.getPRDiff.mockResolvedValue(registryHostBumpDiff());
      expect(await autoBumpGateVerdict(repo.fullName, pr)).toEqual({ ok: false, reason: "not-image-pin-only" });

      mockGh.getPRDiff.mockResolvedValue(imagePinDiff(["apps/bonkus/deployment.yaml"]));
      expect(await autoBumpGateVerdict(repo.fullName, pr)).toEqual({ ok: false, reason: "not-image-pin-only" });
      expect(mockGh.getPRDiff).toHaveBeenCalledTimes(1);

      expect(await autoBumpGateVerdict(repo.fullName, pr, { refresh: true })).toEqual({ ok: true });
      expect(await autoBumpGateVerdict(repo.fullName, pr)).toEqual({ ok: true });
      expect(mockGh.getPRDiff).toHaveBeenCalledTimes(2);
    });

    it("never caches a PR with no head SHA", async () => {
      const pr = mockPR({ headRefName: "automation/bump-bonkus-1.2.3", labels: [{ name: "auto-bump" }] });
      mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml"]);
      mockGh.getPRDiff.mockResolvedValue(imagePinDiff(["apps/bonkus/deployment.yaml"]));
      await autoBumpGateVerdict(repo.fullName, pr);
      await autoBumpGateVerdict(repo.fullName, pr);
      expect(mockGh.getPRDiff).toHaveBeenCalledTimes(2);
    });
  });

  describe("isApprovalExempt and Needs LGTM (#3124)", () => {
    it("exempts a plain docs PR", async () => {
      expect(await isApprovalExempt(repo.fullName, mockPR({ headRefName: "claws/docs-ab12" }), undefined)).toBe(true);
    });

    it("does not exempt a docs PR whose row needs human review", async () => {
      expect(await isApprovalExempt(repo.fullName, mockPR({ headRefName: "claws/docs-ab12" }), prRow(1, { needsHumanReview: true }))).toBe(false);
    });

    it("still exempts a docs PR carrying only a forge Needs LGTM label", async () => {
      expect(await isApprovalExempt(repo.fullName, mockPR({ headRefName: "claws/docs-ab12", labels: [{ name: "Needs LGTM" }] }), prRow(1))).toBe(true);
    });

    it("does not exempt an ideas-collection PR whose row needs human review", async () => {
      expect(await isApprovalExempt(repo.fullName, mockPR({ headRefName: "claws/ideas-collect-ab12" }), prRow(1, { needsHumanReview: true }))).toBe(false);
      expect(await isApprovalExempt(repo.fullName, mockPR({ headRefName: "claws/ideas-collect-ab12" }), prRow(1))).toBe(true);
    });

    it("does not exempt a Dependabot PR", async () => {
      expect(await isApprovalExempt(repo.fullName, mockPR({ author: { login: "dependabot[bot]" }, headRefName: "dependabot/npm/lodash-4.17.21" }), prRow(1))).toBe(false);
    });
  });

  // A PR waiting only on a human: reviewed clean at its current head, not
  // merge-approved, not approval-exempt (issue clw_01M3F9340HHVH185YR16PXVKWK).
  describe("isIdleAwaitingHuman", () => {
    it("is true for a reviewed head awaiting merge with no approval", async () => {
      const pr = mockPR({ headRefOid: "abc123" });
      const row = prRow(1, { stage: "awaiting-merge", reviewedSha: "abc123", headSha: "abc123" });
      expect(await isIdleAwaitingHuman(repo.fullName, pr, row)).toBe(true);
    });

    it("is false when the head has moved past the reviewed commit", async () => {
      const pr = mockPR({ headRefOid: "def456" });
      const row = prRow(1, { stage: "awaiting-merge", reviewedSha: "abc123", headSha: "abc123" });
      expect(await isIdleAwaitingHuman(repo.fullName, pr, row)).toBe(false);
    });

    it("is false when the PR carries a merge approval", async () => {
      const pr = mockPR({ headRefOid: "abc123" });
      const row = prRow(1, {
        stage: "awaiting-merge", reviewedSha: "abc123", headSha: "abc123",
        mergeApprovedAt: "2026-09-27T00:00:00Z", mergeApprovedBy: "dashboard",
      });
      expect(await isIdleAwaitingHuman(repo.fullName, pr, row)).toBe(false);
    });

    it("is false for an approval-exempt PR (auto-bump)", async () => {
      const pr = autoBumpPR(undefined, { headRefOid: "abc123" });
      const row = prRow(1, { stage: "awaiting-merge", reviewedSha: "abc123", headSha: "abc123" });
      expect(await isIdleAwaitingHuman(repo.fullName, pr, row)).toBe(false);
    });

    it("is false for a trusted non-major Renovate PR (approval-exempt)", async () => {
      const pr = mockPR({
        headRefOid: "abc123",
        headRefName: "renovate/some-dep-1.x",
        author: { login: "renovate" },
        body: [
          "This PR contains the following updates:",
          "",
          "| Package | Update | Change |",
          "|---|---|---|",
          "| [some/dep](https://github.com/some/dep) | minor | `0.11.0` -> `0.12.0` |",
          "",
          "---",
        ].join("\n"),
        labels: [],
      });
      const row = prRow(1, { stage: "awaiting-merge", reviewedSha: "abc123", headSha: "abc123" });
      expect(await isIdleAwaitingHuman(repo.fullName, pr, row)).toBe(false);
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

    it("accepts an env-var value: re-pin of the same image", () => {
      const diff = [
        `diff --git a/apps/x/sts.yaml b/apps/x/sts.yaml`,
        `--- a/apps/x/sts.yaml`,
        `+++ b/apps/x/sts.yaml`,
        `@@ -10,7 +10,7 @@`,
        `-              value: ghcr.io/a/app:v1`,
        `+              value: ghcr.io/a/app:v2`,
      ].join("\n");

      expect(isImagePinOnlyDiff(diff)).toBe(true);
    });

    it("rejects a host:port value: change", () => {
      const diff = [
        `diff --git a/apps/x/sts.yaml b/apps/x/sts.yaml`,
        `--- a/apps/x/sts.yaml`,
        `+++ b/apps/x/sts.yaml`,
        `@@ -10,7 +10,7 @@`,
        `-              value: redis:6379`,
        `+              value: redis:6380`,
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

  describe("checkAutoBumpDiff", () => {
    it("accepts an image-pin-only diff over all-YAML files", async () => {
      const files = ["apps/bonkus/deployment.yaml"];
      mockGh.getPRChangedFiles.mockResolvedValue(files);
      mockGh.getPRDiff.mockResolvedValue(imagePinDiff(files));

      await expect(checkAutoBumpDiff(repo.fullName, 1)).resolves.toEqual({ ok: true });
    });

    it("rejects a non-YAML file without reading the diff", async () => {
      mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml", "package.json"]);

      await expect(checkAutoBumpDiff(repo.fullName, 1)).resolves.toEqual({ ok: false, reason: "non-bump-files" });
      expect(mockGh.getPRDiff).not.toHaveBeenCalled();
    });

    it("rejects a diff that changes more than the image pin", async () => {
      const files = ["apps/bonkus/deployment.yaml"];
      mockGh.getPRChangedFiles.mockResolvedValue(files);
      mockGh.getPRDiff.mockResolvedValue([
        imagePinDiff(files),
        `@@ -30,7 +30,7 @@ spec:`,
        `-          replicas: 1`,
        `+          replicas: 3`,
      ].join("\n"));

      await expect(checkAutoBumpDiff(repo.fullName, 1)).resolves.toEqual({ ok: false, reason: "not-image-pin-only" });
    });

    it("uses knownFiles instead of a second getPRChangedFiles call", async () => {
      const files = ["apps/bonkus/deployment.yaml"];
      mockGh.getPRDiff.mockResolvedValue(imagePinDiff(files));

      await expect(checkAutoBumpDiff(repo.fullName, 1, files)).resolves.toEqual({ ok: true });
      expect(mockGh.getPRChangedFiles).not.toHaveBeenCalled();
    });

    describe("Claws bump with the session-image env re-pin", () => {
      const CFG = "apps/registry/config.json";
      const PREPULL = "clusters/my-cluster/claws-prepull/deployment.yaml";
      const STS = "clusters/my-cluster/claws/statefulset.yaml";
      const IMG = "registry.home.bstjohn.net/st-john-software/claws";
      const FROM = "v2026-10-10.3";
      const TO = "v2026-10-12.2";
      const section = (path: string, hunks: string[][]) => [
        `diff --git a/${path} b/${path}`,
        `index 1111111..2222222 100644`,
        `--- a/${path}`,
        `+++ b/${path}`,
        ...hunks.flatMap((h) => [`@@ -10,7 +10,7 @@`, ...h]),
      ].join("\n");
      const imageHunk = [`-          image: ${IMG}:${FROM}`, `+          image: ${IMG}:${TO}`];
      const envHunk = (rm: string, ad: string) => [`             - name: CLAWS_SESSION_IMAGE`, `-              value: ${rm}`, `+              value: ${ad}`];
      const envPin = envHunk(`${IMG}:${FROM}`, `${IMG}:${TO}`);
      const cfg = (to = TO.replace(".", "\\\\.")) => section(CFG, [[`-                "^v2026-10-10\\\\.3$"`, `+                "^${to}$"`]]);
      const run = async (diff: string, files: string[]) => {
        mockGh.getPRDiff.mockResolvedValue(diff);
        return checkAutoBumpDiff(repo.fullName, 1, files);
      };
      const stsWith = (hunk: string[]) => section(STS, [hunk]);

      it("accepts the real three-file Claws bump", async () => {
        const diff = [section(PREPULL, [imageHunk]), section(STS, [imageHunk, envPin]), cfg()].join("\n");
        await expect(run(diff, [PREPULL, STS, CFG])).resolves.toEqual({ ok: true });
      });

      it("accepts an env-value re-pin to a new digest", async () => {
        const digest = `sha256:${"a".repeat(64)}`;
        const diff = stsWith(envHunk(`${IMG}:${FROM}`, `${IMG}:${FROM}@${digest}`));
        await expect(run(diff, [STS])).resolves.toEqual({ ok: true });
      });

      it("accepts a value-only re-pin plus an allowlist swap to that tag", async () => {
        const diff = [stsWith(envPin), cfg()].join("\n");
        await expect(run(diff, [STS, CFG])).resolves.toEqual({ ok: true });
      });

      it("rejects an allowlist swap to a tag nothing bumps to", async () => {
        const diff = [stsWith(envPin), cfg("v2026-10-13\\\\.1")].join("\n");
        await expect(run(diff, [STS, CFG])).resolves.toEqual({ ok: false, reason: "non-bump-files" });
      });

      it.each([
        ["plain string", "registry-pull,ghcr-pull", "registry-pull"],
        ["number", "3", "4"],
        ["URL", "https://claws.home.bstjohn.net:3000", "https://claws.home.bstjohn.net:3001"],
        ["host:port", "redis:6379", "redis:6380"],
        ["different image name", `${IMG}:${FROM}`, `${IMG}-session:${TO}`],
        ["different registry host", `${IMG}:${FROM}`, `ghcr.io/st-john-software/claws:${TO}`],
        ["unpinned", `${IMG}:${FROM}`, IMG],
      ])("rejects a %s value change", async (_n, rm, ad) => {
        await expect(run(stsWith(envHunk(rm, ad)), [STS])).resolves.toEqual({ ok: false, reason: "not-image-pin-only" });
      });
    });

    describe("registry allowlist append", () => {
      const CFG = "apps/registry/config.json";
      const MANIFEST = "clusters/my-cluster/claws/statefulset.yaml";
      const files = [MANIFEST, CFG];
      const pin = (from = "v2026-10-08.3", to = "v2026-10-08.4") => imagePinDiff([MANIFEST], from, to);
      const cfgSection = (body: string[]) => [
        `diff --git a/${CFG} b/${CFG}`,
        `index 1111111..2222222 100644`,
        `--- a/${CFG}`,
        `+++ b/${CFG}`,
        `@@ -5,7 +5,8 @@`,
        ...body,
      ].join("\n");
      const run = async (diff: string, f: string[] = files) => {
        mockGh.getPRDiff.mockResolvedValue(diff);
        return checkAutoBumpDiff(repo.fullName, 1, f);
      };
      const NEW = '"^v2026-10-08\\\\.4$"';

      it("accepts a pin rewrite plus a mid-list allowlist append", async () => {
        const diff = [pin(), cfgSection([`       "^v2026-08-27\\\\.2$",`, `+      ${NEW},`, `       "^v2026-08-28\\\\.1$"`])].join("\n");
        await expect(run(diff)).resolves.toEqual({ ok: true });
        expect(mockGh.listRepoTreePaths).not.toHaveBeenCalled();
      });

      it("accepts an end-of-list append with the comma fix", async () => {
        const diff = [pin(), cfgSection([`-      "^v2026-08-27\\\\.2$"`, `+      "^v2026-08-27\\\\.2$",`, `+      ${NEW}`])].join("\n");
        await expect(run(diff)).resolves.toEqual({ ok: true });
        expect(mockGh.listRepoTreePaths).not.toHaveBeenCalled();
      });

      it.each([
        ["an entry is removed", [`-      "^v2026-08-27\\\\.2$",`, `+      ${'"^v2026-10-08\\\\.4$"'}`]],
        ["an unanchored pattern", [`+      "v2026-10-08\\\\.4",`]],
        ["a different tag", [`+      "^v2026-10-09\\\\.1$",`]],
        ["two entries", [`+      ${'"^v2026-10-08\\\\.4$"'},`, `+      ${'"^v2026-10-08\\\\.4$"'},`]],
        ["another key", [`-  "gcDelay": "1h"`, `+  "gcDelay": "2h"`]],
      ])("rejects %s", async (_n, body) => {
        await expect(run([pin(), cfgSection(body)].join("\n"))).resolves.toEqual({ ok: false, reason: "non-bump-files" });
      });

      describe("tag swap", () => {
        const swapPin = () => pin("v2026-10-09.2", "v2026-10-09.6");
        const OLD = '"^v2026-10-09\\\\.2$"';
        const SWAPPED = '"^v2026-10-09\\\\.6$"';
        const ok = { ok: true };
        const bad = { ok: false, reason: "non-bump-files" };

        it("accepts an end-of-list swap of the outgoing tag for the bumped-to tag", async () => {
          await expect(run([swapPin(), cfgSection([`-      ${OLD}`, `+      ${SWAPPED}`])].join("\n"))).resolves.toEqual(ok);
          expect(mockGh.listRepoTreePaths).not.toHaveBeenCalled();
        });

        it("accepts a mid-list swap with trailing commas on both lines", async () => {
          await expect(run([swapPin(), cfgSection([`-      ${OLD},`, `+      ${SWAPPED},`])].join("\n"))).resolves.toEqual(ok);
          expect(mockGh.listRepoTreePaths).not.toHaveBeenCalled();
        });

        it("rejects swapping an unrelated entry", async () => {
          mockRepoFiles({ "apps/other/deployment.yaml": "          image: ghcr.io/st-john-software/other:v2026-08-27.2\n" });
          const body = [`-      "^v2026-08-27\\\\.2$"`, `+      ${SWAPPED}`];
          await expect(run([swapPin(), cfgSection(body)].join("\n"))).resolves.toEqual(bad);
        });

        it("rejects swapping to a tag no manifest bumps to", async () => {
          const body = [`-      ${OLD}`, `+      "^v2026-10-09\\\\.7$"`];
          await expect(run([swapPin(), cfgSection(body)].join("\n"))).resolves.toEqual(bad);
        });

        it("rejects two removed and two added entries", async () => {
          const body = [`-      ${OLD},`, `-      ${SWAPPED}`, `+      ${SWAPPED},`, `+      ${OLD}`];
          await expect(run([swapPin(), cfgSection(body)].join("\n"))).resolves.toEqual(bad);
        });

        it("rejects one removed outgoing entry and two added entries", async () => {
          const body = [`-      ${OLD}`, `+      ${SWAPPED},`, `+      "^v2026-10-09\\\\.6$"`];
          await expect(run([swapPin(), cfgSection(body)].join("\n"))).resolves.toEqual(bad);
        });

        it("rejects a swap that changes the trailing-comma state", async () => {
          await expect(run([swapPin(), cfgSection([`-      ${OLD}`, `+      ${SWAPPED},`])].join("\n"))).resolves.toEqual(bad);
        });
      });

      it("rejects another non-manifest file without reading the diff", async () => {
        mockGh.getPRDiff.mockClear();
        await expect(checkAutoBumpDiff(repo.fullName, 1, [...files, "package.json"])).resolves.toEqual({ ok: false, reason: "non-bump-files" });
        expect(mockGh.getPRDiff).not.toHaveBeenCalled();
      });

      it("rejects the allowlist alone with no manifests", async () => {
        const diff = cfgSection([`+      ${NEW},`]).replace(/^/, "");
        await expect(run(diff, [CFG])).resolves.toEqual({ ok: false, reason: "not-image-pin-only" });
      });

      it("rejects a registry host change even with a valid append", async () => {
        const hostChange = [
          `diff --git a/${MANIFEST} b/${MANIFEST}`,
          `--- a/${MANIFEST}`,
          `+++ b/${MANIFEST}`,
          `@@ -10,7 +10,7 @@`,
          `-          image: ghcr.io/st-john-software/claws:v1`,
          `+          image: registry.home.bstjohn.net/st-john-software/claws:v2`,
        ].join("\n");
        const diff = [hostChange, cfgSection([`+      "^v2\\\\.0$",`])].join("\n");
        await expect(run(diff)).resolves.toEqual({ ok: false, reason: "not-image-pin-only" });
      });
    });

    // production-infra's own-app bumps also edit the prod registry allowlist
    // (#clw_01M4TK4C1E6VHMC09T13HDCBHJ); the hunks are copied from #43, #37 and #36.
    describe("production-infra prod registry allowlist", () => {
      const CFG = "infrastructure/prod/registry/config.json";
      const MANIFEST = "apps/namey/deployment.yaml";
      const files = [MANIFEST, CFG];
      const cfgSection = (body: string[], path = CFG) => [
        `diff --git a/${path} b/${path}`,
        `index 718931b..7c5b61d 100644`,
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -49,8 +49,8 @@`,
        `             {`,
        `               "patterns": [`,
        `                 "^latest$",`,
        ...body,
        `               ]`,
        `             },`,
      ].join("\n");
      const run = async (diff: string, f: string[] = files) => {
        mockGh.getPRDiff.mockResolvedValue(diff);
        return checkAutoBumpDiff(repo.fullName, 1, f);
      };
      const ok = { ok: true };
      const bad = { ok: false, reason: "non-bump-files" };

      it("accepts an end-of-list swap (#43)", async () => {
        const diff = [imagePinDiff([MANIFEST], "v2026-10-13.3", "v2026-10-13.4"), cfgSection([
          `                 "^v2026-10-12\\\\.3$",`,
          `                 "^v2026-10-12\\\\.301$",`,
          `-                "^v2026-10-13\\\\.3$"`,
          `+                "^v2026-10-13\\\\.4$"`,
        ])].join("\n");
        await expect(run(diff)).resolves.toEqual(ok);
        expect(mockGh.listRepoTreePaths).not.toHaveBeenCalled();
      });

      it("accepts a pure removal of the outgoing tag when the new tag is shared (production-infra #86)", async () => {
        const diff = [imagePinDiff([MANIFEST], "v2026-10-15.1", "v2026-10-16.3"), cfgSection([
          `                 "^v2026-10-12\\\\.301$",`,
          `-                "^v2026-10-15\\\\.1$",`,
          `                 "^v2026-10-16\\\\.3$"`,
        ])].join("\n");
        await expect(run(diff)).resolves.toEqual(ok);
        expect(mockGh.listRepoTreePaths).not.toHaveBeenCalled();
      });

      it("accepts an end-of-list removal with the comma fix", async () => {
        const diff = [imagePinDiff([MANIFEST], "v2026-10-15.1", "v2026-10-12.301"), cfgSection([
          `-                "^v2026-10-12\\\\.301$",`,
          `+                "^v2026-10-12\\\\.301$"`,
          `-                "^v2026-10-15\\\\.1$"`,
        ])].join("\n");
        await expect(run(diff)).resolves.toEqual(ok);
        expect(mockGh.listRepoTreePaths).not.toHaveBeenCalled();
      });

      it("rejects a pure removal of a non-outgoing tag", async () => {
        mockRepoFiles({ "apps/other/kustomization.yaml": "    newTag: v2026-10-12.301\n" });
        const diff = [imagePinDiff([MANIFEST], "v2026-10-15.1", "v2026-10-16.3"), cfgSection([
          `-                "^v2026-10-12\\\\.301$",`,
          `                 "^v2026-10-16\\\\.3$"`,
        ])].join("\n");
        await expect(run(diff)).resolves.toEqual(bad);
      });

      it("rejects a removal that also drops an extra comma line", async () => {
        const diff = [imagePinDiff([MANIFEST], "v2026-10-15.1", "v2026-10-16.3"), cfgSection([
          `-                "^v2026-10-15\\\\.1$",`,
          `-                "^v2026-10-12\\\\.301$",`,
          `+                "^v2026-10-12\\\\.301$"`,
        ])].join("\n");
        await expect(run(diff)).resolves.toEqual(bad);
      });

      it("accepts a non-adjacent swap within one hunk (#37)", async () => {
        const diff = [imagePinDiff([MANIFEST], "v2026-10-12.3", "v2026-10-13.1"), cfgSection([
          `-                "^v2026-10-12\\\\.3$",`,
          `                 "^v2026-10-12\\\\.301$",`,
          `+                "^v2026-10-13\\\\.1$",`,
          `                 "^v2026-10-13\\\\.4$"`,
        ])].join("\n");
        await expect(run(diff)).resolves.toEqual(ok);
        expect(mockGh.listRepoTreePaths).not.toHaveBeenCalled();
      });

      it("accepts a mid-list removal plus the last entry's comma fix (#36)", async () => {
        const diff = [imagePinDiff([MANIFEST], "v2026-10-12.1", "v2026-10-13.2"), cfgSection([
          `-                "^v2026-10-12\\\\.1$",`,
          `                 "^v2026-10-12\\\\.3$",`,
          `-                "^v2026-10-12\\\\.301$"`,
          `+                "^v2026-10-12\\\\.301$",`,
          `+                "^v2026-10-13\\\\.2$"`,
        ])].join("\n");
        await expect(run(diff)).resolves.toEqual(ok);
        expect(mockGh.listRepoTreePaths).not.toHaveBeenCalled();
      });

      it("rejects a removed entry that is not the outgoing tag", async () => {
        mockRepoFiles({ "apps/other/deployment.yaml": "          image: registry.bstjohn.net/st-john-software/other:v2026-10-12.1\n" });
        const diff = [imagePinDiff([MANIFEST], "v2026-10-12.301", "v2026-10-13.2"), cfgSection([
          `-                "^v2026-10-12\\\\.1$",`,
          `                 "^v2026-10-12\\\\.3$",`,
          `-                "^v2026-10-12\\\\.301$"`,
          `+                "^v2026-10-12\\\\.301$",`,
          `+                "^v2026-10-13\\\\.2$"`,
        ])].join("\n");
        await expect(run(diff)).resolves.toEqual(bad);
      });

      it("rejects two net additions", async () => {
        const diff = [imagePinDiff([MANIFEST], "v2026-10-12.1", "v2026-10-13.2"), cfgSection([
          `-                "^v2026-10-12\\\\.1$",`,
          `+                "^v2026-10-13\\\\.2$",`,
          `+                "^v2026-10-13\\\\.3$",`,
        ])].join("\n");
        await expect(run(diff)).resolves.toEqual(bad);
      });

      it("rejects a swap that drops a comma-terminated line", async () => {
        const diff = [imagePinDiff([MANIFEST], "v2026-10-12.1", "v2026-10-13.2"), cfgSection([
          `-                "^v2026-10-12\\\\.1$",`,
          `-                "^v2026-10-12\\\\.301$",`,
          `+                "^v2026-10-12\\\\.301$"`,
          `+                "^v2026-10-13\\\\.2$"`,
        ])].join("\n");
        await expect(run(diff)).resolves.toEqual(bad);
      });

      // production-infra #475 (#clw_01M64CQ46A14535D86H148D6C2): a stale `.3`
      // entry no manifest pins is pruned alongside the outgoing-tag swap.
      describe("stale-tag prune", () => {
        const pin475 = () => imagePinDiff([MANIFEST], "v2026-10-29.4", "v2026-10-29.13");
        const body475 = [
          `-                "^v2026-10-29\\\\.2$",`,
          `-                "^v2026-10-29\\\\.3$",`,
          `-                "^v2026-10-29\\\\.4$"`,
          `+                "^v2026-10-29\\\\.13$",`,
          `+                "^v2026-10-29\\\\.2$"`,
        ];
        const repoAtHead = (extra: Record<string, string> = {}) => mockRepoFiles({
          [MANIFEST]: "          image: ghcr.io/st-john-software/app:v2026-10-29.13\n",
          "apps/bonkus/kustomization.yaml": "    newTag: v2026-10-29.2\n",
          "infrastructure/prod/registry/config.json": "{}",
          ...extra,
        });

        it("accepts the #475 diff when the pruned tag is pinned by no manifest", async () => {
          repoAtHead();
          await expect(run([pin475(), cfgSection(body475)].join("\n"))).resolves.toEqual(ok);
          expect(mockGh.listRepoTreePaths).toHaveBeenCalledWith(repo.fullName, "abc1234");
          // Only YAML files are read.
          expect(mockGh.fetchRepoFileWithSha).not.toHaveBeenCalledWith(repo.fullName, "infrastructure/prod/registry/config.json", "abc1234");
        });

        it("scans the head SHA it is given instead of reading it", async () => {
          repoAtHead();
          mockGh.getPRDiff.mockResolvedValue([pin475(), cfgSection(body475)].join("\n"));
          await expect(checkAutoBumpDiff(repo.fullName, 1, files, "feedface")).resolves.toEqual(ok);
          expect(mockGh.listRepoTreePaths).toHaveBeenCalledWith(repo.fullName, "feedface");
          expect(mockGh.getPRHeadSHA).not.toHaveBeenCalled();
        });

        it("rejects the #475 diff when another manifest still pins the pruned tag", async () => {
          repoAtHead({ "apps/other/deployment.yaml": "        - image: ghcr.io/st-john-software/other:v2026-10-29.3\n" });
          await expect(run([pin475(), cfgSection(body475)].join("\n"))).resolves.toEqual(bad);
        });

        it("rejects the #475 prune plus a second added entry without scanning", async () => {
          const body = [...body475.slice(0, 3), `+                "^v2026-10-29\\\\.14$",`, ...body475.slice(3)];
          await expect(run([pin475(), cfgSection(body)].join("\n"))).resolves.toEqual(bad);
          expect(mockGh.listRepoTreePaths).not.toHaveBeenCalled();
        });

        it("accepts a pure removal of a stale tag and the outgoing tag", async () => {
          repoAtHead();
          const diff = [pin475(), cfgSection([
            `-                "^v2026-10-29\\\\.3$",`,
            `-                "^v2026-10-29\\\\.4$",`,
            `                 "^v2026-10-29\\\\.13$"`,
          ])].join("\n");
          await expect(run(diff)).resolves.toEqual(ok);
        });

        it("rejects a removed regex entry without scanning", async () => {
          const diff = [pin475(), cfgSection([
            `-                "^v2026-.*$",`,
            `-                "^v2026-10-29\\\\.4$"`,
            `+                "^v2026-10-29\\\\.13$"`,
          ])].join("\n");
          await expect(run(diff)).resolves.toEqual(bad);
          expect(mockGh.listRepoTreePaths).not.toHaveBeenCalled();
        });

        it("fails closed as pin-scan-failed when a YAML file cannot be read", async () => {
          repoAtHead();
          mockGh.fetchRepoFileWithSha.mockResolvedValue(null);
          await expect(run([pin475(), cfgSection(body475)].join("\n"))).resolves.toEqual({ ok: false, reason: "pin-scan-failed" });
        });

        it("never caches a pin-scan-failed verdict", async () => {
          clearAutoBumpGateCache();
          const pr = autoBumpPR(files, { number: 475, headRefOid: "deadbeef" });
          mockGh.getPRDiff.mockResolvedValue([pin475(), cfgSection(body475)].join("\n"));
          mockGh.listRepoTreePaths.mockRejectedValueOnce(new Error("forge down"));
          await expect(autoBumpGateVerdict(repo.fullName, pr)).resolves.toEqual({ ok: false, reason: "pin-scan-failed" });
          repoAtHead();
          await expect(autoBumpGateVerdict(repo.fullName, pr)).resolves.toEqual(ok);
          expect(mockGh.listRepoTreePaths).toHaveBeenCalledTimes(2);
          expect(mockGh.listRepoTreePaths).toHaveBeenLastCalledWith(repo.fullName, "deadbeef");
        });

        it("merges the #475 PR without an approval once checks are green", async () => {
          clearAutoBumpGateCache();
          const pr = autoBumpPR(files, { number: 476 });
          mockGh.getPRDiff.mockResolvedValue([pin475(), cfgSection(body475)].join("\n"));
          repoAtHead();
          mockMergeGate({ checkStatus: "passing" });
          mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: HEAD_SHA });
          await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: true });
          expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
          expect(mockGh.listRepoTreePaths).toHaveBeenCalledWith(repo.fullName, HEAD_SHA);
        });
      });

      it("rejects a registry config at any other path", async () => {
        const other = "infrastructure/staging/registry/config.json";
        mockGh.getPRDiff.mockClear();
        await expect(checkAutoBumpDiff(repo.fullName, 1, [MANIFEST, other])).resolves.toEqual(bad);
        expect(mockGh.getPRDiff).not.toHaveBeenCalled();
      });
    });
  });
});

describe("merge-block reporting (#2971)", () => {
  const repo = mockRepo();
  const claws = (body: string) => `*— Automated by Claws · Auto Merger —*\n\n${body}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMergeGate({ checkStatus: "passing" });
    mockGh.haveChecksSettled.mockResolvedValue({ settled: true, age: "3600s" });
    mockGh.carriedForwardCheckStatus.mockResolvedValue("none");
    mockGh.getPRChangedFiles.mockResolvedValue([]);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.isForkPR.mockReturnValue(false);
    mockGh.isDispatchSkippable.mockReturnValue(false);
    mockGh.getPRReviewStatus.mockResolvedValue({ status: "none", issueCount: 0, reviewedCommit: null });
    mockGh.getPRHeadSHA.mockResolvedValue("abc1234");
    mockDb.findLatestCompletedTaskForPrHead.mockResolvedValue(null);
  });

  it("posts one comment when the merge is approved but the review is not clean", async () => {
    const pr = approvedPR();
    mockGh.getPRReviewStatus.mockResolvedValue({ status: "issues", issueCount: 2, reviewedCommit: "abc1234" });

    expect(await tryMerge(repo, pr)).toBe(false);

    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    const [, number, body, opts] = mockGh.commentOnIssue.mock.calls[0];
    expect(number).toBe(pr.number);
    expect(body).toContain("### Merge blocked");
    expect(body).toContain("not clean");
    expect(body).toContain("claws-merge-status");
    expect(opts).toEqual({ agentName: "Auto Merger" });
    expect(mockGh.setMergeBlockReason).toHaveBeenCalledWith(repo.fullName, pr.number, expect.stringContaining("not clean"), expect.any(String));
  });

  it("does not report an approved PR whose review status is still none", async () => {
    const pr = approvedPR();
    mockGh.getPRReviewStatus.mockResolvedValue({ status: "none", issueCount: 0, reviewedCommit: null });

    expect(await tryMerge(repo, pr)).toBe(false);

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.setMergeBlockReason).not.toHaveBeenCalled();
  });

  it("posts one comment when an approved PR has failing checks", async () => {
    const pr = approvedPR();
    mockMergeGate({ checkStatus: "failing" });

    await tryMerge(repo, pr);

    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.commentOnIssue.mock.calls[0][2]).toContain("CI is failing");
  });

  it("leaves an identical existing status comment alone", async () => {
    const pr = approvedPR();
    mockMergeGate({ checkStatus: "failing" });
    const body = [
      "### Merge blocked",
      "",
      "CI is failing.",
      "",
      "Claws re-checks this every few minutes; this comment is edited in place.",
      "",
      "claws-merge-status",
    ].join("\n");
    mockGh.getIssueComments.mockResolvedValue([{ id: 5, body: claws(body), body_html: "", login: "claws" }]);

    await tryMerge(repo, pr);

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
  });

  it("edits an existing status comment whose reason changed", async () => {
    const pr = approvedPR();
    mockMergeGate({ checkStatus: "failing" });
    mockGh.getIssueComments.mockResolvedValue([
      { id: 5, body: claws("### Merge blocked\n\nCI status is `pending`.\n\nclaws-merge-status"), body_html: "", login: "claws" },
    ]);

    await tryMerge(repo, pr);

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.editIssueComment).toHaveBeenCalledWith(
      repo.fullName, 5, expect.stringContaining("CI is failing"), { agentName: "Auto Merger" },
    );
  });

  it("reports a recorded manual action on an approved PR once, then leaves the comment alone", async () => {
    const pr = approvedPR();
    setRow(pr.number, { manualActionReason: "set prod secrets" });

    expect(await tryMerge(repo, pr)).toBe(false);

    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.commentOnIssue.mock.calls[0][2] as string;
    expect(body).toContain("### Merge blocked");
    expect(body).toContain("set prod secrets");
    expect(body).toContain("claws_clear_pr_manual_action");
    expect(body).toContain("claws-merge-status");
    expect(mockGh.setMergeBlockReason).toHaveBeenCalledWith(repo.fullName, pr.number, expect.stringContaining("set prod secrets"), expect.any(String));

    // The next sweep finds the identical comment and posts nothing new.
    mockGh.commentOnIssue.mockClear();
    mockGh.getIssueComments.mockResolvedValue([{ id: 5, body: claws(body), body_html: "", login: "claws" }]);
    expect(await tryMerge(repo, pr)).toBe(false);
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
  });

  it("does not report a recorded manual action on an unapproved PR", async () => {
    const pr = mockPR();
    setRow(pr.number, { manualActionReason: "set prod secrets" });

    expect(await tryMerge(repo, pr)).toBe(false);

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.setMergeBlockReason).not.toHaveBeenCalled();
  });

  it("does not report on an unapproved exempt PR with failing checks", async () => {
    const pr = autoBumpPR();
    mockMergeGate({ checkStatus: "failing" });

    await tryMerge(repo, pr);

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.setMergeBlockReason).not.toHaveBeenCalled();
  });

  it("does not report when the PR is not approved", async () => {
    await tryMerge(repo, mockPR());

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.getIssueComments).not.toHaveBeenCalled();
  });

  it("does not report while an approved PR is waiting for checks to register", async () => {
    mockMergeGate({ checkStatus: "none" });
    mockGh.haveChecksSettled.mockResolvedValue({ settled: false, age: "10s" });

    await tryMerge(repo, approvedPR());

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.setMergeBlockReason).not.toHaveBeenCalled();
  });

  it("clears the recorded reason after a successful merge", async () => {
    const pr = approvedPR();

    expect(await tryMerge(repo, pr)).toBe(true);

    expect(mockGh.setMergeBlockReason).toHaveBeenCalledWith(repo.fullName, pr.number, null);
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("a reporting failure does not abort tryMerge", async () => {
    mockMergeGate({ checkStatus: "failing" });
    mockGh.getIssueComments.mockRejectedValue(new Error("boom"));

    await expect(tryMerge(repo, approvedPR())).resolves.toBe(false);
  });
});

describe("sweepRepo", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockMergeGate({ checkStatus: "passing" });
    mockGh.haveChecksSettled.mockResolvedValue({ settled: true, age: "3600s" });
    mockGh.getPRChangedFiles.mockResolvedValue([]);
    mockGh.isForkPR.mockReturnValue(false);
    mockGh.isDispatchSkippable.mockReturnValue(false);
    mockGh.mergePR.mockResolvedValue(undefined);
    // vi.clearAllMocks() clears call history, not implementations — without these the
    // sweep tests would inherit the *clean* review `approvedPR()` left on the mocks in
    // the previous describe block and could merge for the wrong reason. Resetting to
    // the restrictive default is why every sweep test expecting a merge calls
    // `approvedPR()` itself.
    mockGh.getPRReviewStatus.mockResolvedValue({ status: "none", issueCount: 0, reviewedCommit: null });
    mockGh.getPRHeadSHA.mockResolvedValue("abc1234");
    mockDb.hasActiveWorkForPR.mockResolvedValue(false);
    mockDb.findLatestCompletedTaskForPrHead.mockResolvedValue(null);
    mockClawsIssues.getIssue.mockResolvedValue(undefined);
    mockGh.getOpenPRForIssue.mockResolvedValue(null);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);
    mockLoadPhaseState.mockResolvedValue(phaseState(1, [1], []));
    mockPeekTotalPhases.mockResolvedValue({ totalPhases: 1, stored: null });
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
  });

  it("invalidates the PR list before listing", async () => {
    mockGh.listPRs.mockResolvedValue([]);

    await sweepRepo(repo);

    expect(mockGh.invalidatePRList).toHaveBeenCalledWith(repo.fullName);
    expect(mockGh.listPRs).toHaveBeenCalledWith(repo.fullName);
  });

  it("skips PRs with active agent work", async () => {
    mockGh.listPRs.mockResolvedValue([mockPR({ number: 1 })]);
    mockDb.hasActiveWorkForPR.mockResolvedValue(true);

    await sweepRepo(repo);

    expect(mockDb.hasActiveWorkForPR).toHaveBeenCalledWith(
      repo.fullName, 1, ["ci-fixer", "ci-fixer:conflict", "review-addresser", "pr-reviewer"],
    );
    expect(mockGh.getPRMergeGate).not.toHaveBeenCalled();
  });

  it("feeds the auto-bump PRs it judged to the stalled auto-bump alert", async () => {
    const bump = autoBumpPR(["apps/bonkus/deployment.yaml", "package.json"], { number: 7, title: "Bump bonkus" });
    mockGh.listPRs.mockResolvedValue([bump, mockPR({ number: 8 })]);

    await sweepRepo(repo);

    expect(mockStall.recordSweep).toHaveBeenCalledWith(
      repo.fullName,
      [{ number: 7, title: "Bump bonkus", refusal: expect.objectContaining({ code: "auto-bump-gate", autoBumpReason: "non-bump-files" }) }],
      [7, 8],
      expect.any(Number),
    );
    expect(mockStall.reconcileStallAlert).toHaveBeenCalledWith(repo.fullName, mockStall.recordSweep.mock.calls[0][3]);
  });

  it("skips PRs rejected by the central dispatch guard", async () => {
    mockGh.listPRs.mockResolvedValue([mockPR({ number: 43 })]);
    mockGh.isDispatchSkippable.mockReturnValue(true);

    await sweepRepo(repo);

    expect(mockDb.hasActiveWorkForPR).not.toHaveBeenCalled();
    expect(mockGh.getPRMergeGate).not.toHaveBeenCalled();
  });

  it("keeps sweeping after one PR throws", async () => {
    mockGh.listPRs.mockResolvedValue([approvedPR({ number: 1 }), approvedPR({ number: 2 })]);
    mockGh.getPRMergeGate
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ state: "OPEN", headSha: HEAD_SHA, labels: [], mergeable: "MERGEABLE", checkStatus: "passing", checksTotal: 1 });

    await sweepRepo(repo);

    expect(mockGh.mergePR).toHaveBeenCalledTimes(1);
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, 2, HEAD_SHA);
  });

  it("does not sweep the same repo twice concurrently", async () => {
    let release!: (prs: ReturnType<typeof mockPR>[]) => void;
    mockGh.listPRs.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));

    const first = sweepRepo(repo);
    await sweepRepo(repo);
    release([]);
    await first;

    expect(mockGh.listPRs).toHaveBeenCalledTimes(1);

    mockGh.listPRs.mockResolvedValue([]);
    await sweepRepo(repo);
    expect(mockGh.listPRs).toHaveBeenCalledTimes(2);
  });

  // `claws_recent_job_logs` redacts free text, so skips and sweeps carry
  // structured reasons (#clw_01M4TK4C1E6VHMC09T13HDCBHJ).
  describe("diagnostic logging", () => {
    const sweepDone = (counts: { openPrCount: number; mergedCount: number; skippedCount: number }) => [
      expect.stringContaining(`sweep of ${repo.fullName} done`),
      "merge_sweep_done",
      { repo: repo.fullName, ...counts },
    ];

    it("logs a summary for a sweep that found nothing", async () => {
      mockGh.listPRs.mockResolvedValue([]);

      await sweepRepo(repo);

      expect(log.info).toHaveBeenCalledWith(...sweepDone({ openPrCount: 0, mergedCount: 0, skippedCount: 0 }));
    });

    it("logs each skipped PR with its repo, number and reason code", async () => {
      mockGh.listPRs.mockResolvedValue([mockPR({ number: 7 }), mockPR({ number: 8 }), mockPR({ number: 9 })]);
      mockGh.isDispatchSkippable.mockImplementation((_repo: string, pr: { number: number }) => pr.number === 7);
      mockDb.hasActiveWorkForPR.mockImplementation(async (_repo: string, n: number) => n === 8);

      await sweepRepo(repo);

      expect(log.info).toHaveBeenCalledWith(expect.any(String), "merge_skipped", { repo: repo.fullName, pr: 7, mergeSkip: "dispatch-guard" });
      expect(log.info).toHaveBeenCalledWith(expect.any(String), "merge_skipped", { repo: repo.fullName, pr: 8, mergeSkip: "other-work" });
      expect(log.info).toHaveBeenCalledWith(expect.any(String), "merge_skipped", { repo: repo.fullName, pr: 9, mergeSkip: "not-approved" });
      expect(log.info).toHaveBeenCalledWith(...sweepDone({ openPrCount: 3, mergedCount: 0, skippedCount: 3 }));
    });

    it("counts merges and thrown errors", async () => {
      mockGh.listPRs.mockResolvedValue([approvedPR({ number: 1 }), approvedPR({ number: 2 })]);
      mockGh.getPRMergeGate
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ state: "OPEN", headSha: HEAD_SHA, labels: [], mergeable: "MERGEABLE", checkStatus: "passing", checksTotal: 1 });

      await sweepRepo(repo);

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("tryMerge failed"), "merge_skipped", { repo: repo.fullName, pr: 1, mergeSkip: "error" });
      expect(log.info).toHaveBeenCalledWith(...sweepDone({ openPrCount: 2, mergedCount: 1, skippedCount: 1 }));
    });
  });

  // A human merging a claws/issue-… PR directly on the forge is closed out by
  // the PR dispatcher's store refresh, so the sweep reads no issues at all.
  it("reads no issues and finalizes nothing when no PR is open", async () => {
    mockGh.listPRs.mockResolvedValue([]);

    await sweepRepo(repo);

    expect(mockClawsIssues.getIssue).not.toHaveBeenCalled();
    expect(mockGh.listMergedPRsForIssue).not.toHaveBeenCalled();
    expect(mockGh.closeIssue).not.toHaveBeenCalled();
  });

  // GitHub auto-closes its own issues on `Closes #N`; a native id means nothing
  // to either forge, so the merger closes it itself (#3215).
  describe("native issue auto-close", () => {
    const NATIVE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    const OTHER = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD";

    function nativeIssue(over: Record<string, unknown> = {}) {
      return {
        id: NATIVE, state: "open", kind: "issue", repos: [repo.fullName], labels: [], title: "T", body: "",
        author_login: "claws", state_reason: null, created_at: "", updated_at: "", closed_at: null,
        ...over,
      };
    }

    /** An approved PR on the branch Claws names for `ref`. */
    function prFor(ref: string) {
      return approvedPR({ headRefName: `claws/issue-${ref}-ab12` });
    }

    it("closes the native issues a merged PR says it closes", async () => {
      const pr = prFor(NATIVE);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue(`Closes #${NATIVE.toLowerCase()}\nAlso resolves #${OTHER}`);
      mockClawsIssues.getIssue.mockImplementation(async (ref: string) => nativeIssue({ id: ref }));

      await tryMerge(repo, pr);

      expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, NATIVE, "completed");
      expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, OTHER, "completed");
    });

    it("re-reads the PR body rather than trusting the sweep's cached copy", async () => {
      const pr = approvedPR({ headRefName: `claws/issue-${NATIVE}-ab12`, body: `Closes #${OTHER}` });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue(`Closes #${NATIVE}`);
      mockClawsIssues.getIssue.mockImplementation(async (ref: string) => nativeIssue({ id: ref }));

      await tryMerge(repo, pr);

      expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, NATIVE, "completed");
      expect(mockGh.closeIssue).toHaveBeenCalledTimes(1);
    });

    it("honours past-tense keywords and ignores closing keywords in quoted regions", async () => {
      const pr = prFor(NATIVE);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue(["Fixed #" + NATIVE, "", "```", "Closes #" + OTHER, "```"].join("\n"));
      mockClawsIssues.getIssue.mockImplementation(async (ref: string) => nativeIssue({ id: ref }));

      await tryMerge(repo, pr);

      expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, NATIVE, "completed");
      expect(mockGh.closeIssue).not.toHaveBeenCalledWith(repo.fullName, OTHER, "completed");
    });

    it("leaves forge issue numbers alone — the forge closes those", async () => {
      const pr = prFor("42");
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue("Closes #42");

      await tryMerge(repo, pr);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    it("leaves another repo's native issue open", async () => {
      const pr = prFor(NATIVE);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue(`Closes #${NATIVE}`);
      mockClawsIssues.getIssue.mockResolvedValue(nativeIssue({ repos: ["other/repo"] }));

      await tryMerge(repo, pr);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    it("leaves an unassigned native issue open", async () => {
      const pr = prFor(NATIVE);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue(`Closes #${NATIVE}`);
      mockClawsIssues.getIssue.mockResolvedValue(nativeIssue({ repos: [] }));

      await tryMerge(repo, pr);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    // A multi-repo plan's last PR carries the `Closes`, whichever of the
    // issue's repos it lands in — here not the primary one.
    it("closes a multi-repo native issue from a non-primary repo", async () => {
      const pr = prFor(NATIVE);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue(`Closes #${NATIVE}`);
      mockClawsIssues.getIssue.mockResolvedValue(nativeIssue({ repos: ["0-primary/repo", repo.fullName] }));

      await tryMerge(repo, pr);

      expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, NATIVE, "completed");
    });

    // A shadow stands for an issue that is still live on a forge (#3246):
    // closing it would hide the row without touching the issue the PR closes.
    it("leaves a shadow of a live forge issue open", async () => {
      const pr = prFor(NATIVE);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue(`Closes #${NATIVE}`);
      mockClawsIssues.getIssue.mockResolvedValue(nativeIssue({ kind: "shadow" }));

      await tryMerge(repo, pr);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    it("skips an already-closed native issue", async () => {
      const pr = prFor(NATIVE);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue(`Closes #${NATIVE}`);
      mockClawsIssues.getIssue.mockResolvedValue(nativeIssue({ state: "closed" }));

      await tryMerge(repo, pr);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    it("does not fail the merge when closing a native issue throws", async () => {
      const pr = prFor(NATIVE);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue(`Closes #${NATIVE}`);
      mockClawsIssues.getIssue.mockResolvedValue(nativeIssue());
      mockGh.closeIssue.mockRejectedValue(new Error("gone"));

      expect(await tryMerge(repo, pr)).toBe(true);
    });
  });

  // A parallel plan's steps can merge in any order, and only a step opened when
  // every other one had landed carries `Closes`.
  describe("multi-PR completion", () => {
    const NATIVE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    const OTHER_REPO = "test-org/zz-other";
    const record = {
      id: NATIVE, state: "open", kind: "issue", repos: [OTHER_REPO, repo.fullName], labels: [], title: "T", body: "",
      author_login: "claws", state_reason: null, created_at: "", updated_at: "", closed_at: null,
    };
    const prFor = (ref: string | number) => approvedPR({ headRefName: `claws/issue-${ref}-ab12` });

    beforeEach(() => {
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue(`Part of #${NATIVE}`);
      mockClawsIssues.getIssue.mockResolvedValue(record);
      mockGh.getIssueComments.mockResolvedValue([]);
    });

    it("leaves the issue open while a sibling step's PR is open", async () => {
      setPhaseState(2, [2], [1]);

      await tryMerge(repo, prFor(NATIVE));

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    it("closes the issue from its primary repo when the last step merges, in either order", async () => {
      // Step 1 merges last here: it was opened while step 2 was still open, so it
      // carries no `Closes`, yet it completes the plan.
      setPhaseState(2, [1, 2], []);
      const pr = prFor(NATIVE);

      await tryMerge(repo, pr);

      // A multi-repo native issue lives under its alphabetically first repo. The
      // just-merged PR itself is always seeded into `mergedPRs`, so a stale
      // dedicated read or cross-reference scan can never still call it open.
      expect(mockLoadPhaseState).toHaveBeenCalledWith(repo.fullName, NATIVE, [], expect.objectContaining({
        mergedPRs: [{ number: pr.number, title: pr.title, body: pr.body }],
      }));
      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(repo.fullName, NATIVE, expect.stringContaining("All 2 steps of the plan have landed or been marked done"), { agentName: "Implementer" });
      expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, NATIVE, "completed");
    });

    it("closes a forge issue in the PR's repo", async () => {
      setPhaseState(3, [1, 2, 3], []);
      const pr = prFor(77);

      await tryMerge(repo, pr);

      expect(mockLoadPhaseState).toHaveBeenCalledWith(repo.fullName, 77, [], expect.objectContaining({
        mergedPRs: [{ number: pr.number, title: pr.title, body: pr.body }],
      }));
      expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, 77, "completed");
    });

    it("does not close or comment on an issue that is already closed", async () => {
      setPhaseState(2, [1, 2], []);
      mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "completed", labels: [] });

      await tryMerge(repo, prFor(77));

      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    it("does not close the issue when the phase state cannot be read", async () => {
      mockPeekTotalPhases.mockResolvedValue({ totalPhases: 2, stored: null });
      mockLoadPhaseState.mockRejectedValue(new Error("forge down"));

      expect(await tryMerge(repo, prFor(NATIVE))).toBe(true);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    describe("a plan ending in a manual step", () => {
      const PLAN = "*— Automated by Claws —*\n\n## Implementation Plan\n\n### PR 1: Move\nm\n\n### PR 2: Cut over\nc\n\n### Manual actions (operator)\n1. Import the repo on Forgejo.";
      const awaiting = () => {
        const state = phaseState(3, [1, 2], []);
        return {
          ...state,
          entries: [
            { position: 1, repo: repo.fullName, title: "Move", prNumber: 1, dependsOn: null, kind: "pr", manualAction: null },
            { position: 2, repo: repo.fullName, title: "Cut over", prNumber: 2, dependsOn: null, kind: "pr", manualAction: null },
            { position: 3, repo: repo.fullName, title: "Manual actions (operator)", prNumber: null, dependsOn: [1, 2], kind: "manual", manualAction: null },
          ],
          coverage: { ...state.coverage, nextPhase: 3, awaitingOperator: [3] },
        };
      };

      beforeEach(() => {
        mockPeekTotalPhases.mockResolvedValue({ totalPhases: 3, stored: null });
        mockLoadPhaseState.mockResolvedValue(awaiting());
      });

      it("leaves the issue open and posts the operator step once", async () => {
        mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: PLAN, login: "claws" }]);

        await tryMerge(repo, prFor(77));

        expect(mockGh.closeIssue).not.toHaveBeenCalled();
        expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
        const [issueRepo, ref, body] = mockGh.commentOnIssue.mock.calls[0];
        expect([issueRepo, ref]).toEqual([repo.fullName, 77]);
        expect(body).toContain("Every step operator step 3 follows has landed. Operator step 3 remains");
        expect(body).toContain("1. Import the repo on Forgejo.");
        expect(body).toContain("claws-phase-done: 3");
        expect(body).toContain(AWAITING_OPERATOR_MARKER);
        // The issue is parked in Blocked with the step as its reason (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK).
        expect(body).toContain("## Needs a human");
        expect(body).toContain("claws-needs-human:awaiting-operator-3");
        expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 77, "Blocked");
        expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("operator step 3"));
      });

      it("does not post again when the issue already carries the marker", async () => {
        mockGh.getIssueComments.mockResolvedValue([
          { id: 1, body: PLAN, login: "claws" },
          { id: 2, body: `Every PR of the plan has merged.\n\n${AWAITING_OPERATOR_MARKER}\n\n*— Automated by Claws —*`, login: "claws" },
        ]);

        await tryMerge(repo, prFor(77));

        expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
        expect(mockNotify).not.toHaveBeenCalledWith(expect.stringContaining("operator step"));
      });

      it("says nothing while a PR step is still open", async () => {
        const state = awaiting();
        mockLoadPhaseState.mockResolvedValue({ ...state, coverage: { ...state.coverage, done: new Set([1]), awaitingOperator: [] } });

        await tryMerge(repo, prFor(77));

        expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      });
    });

    it("parks a single-step issue for a human when its merged PR says only `Part of` (#clw_01M4EPRM9SYVGFG2BTZTMQEKDJ)", async () => {
      mockGh.getPRBody.mockResolvedValue("Part of #77");

      await tryMerge(repo, prFor(77));

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(repo.fullName, 77, expect.stringContaining("merged without closing this issue"), expect.anything());
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 77, "Blocked");
    });

    it("leaves a single-step issue its merged PR closes to the forge", async () => {
      mockGh.getPRBody.mockResolvedValue("Closes #77");

      await tryMerge(repo, prFor(77));

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 77, "Blocked");
      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    it("does nothing when the single-step issue is already closed", async () => {
      mockGh.getPRBody.mockResolvedValue("Part of #77");
      mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "COMPLETED", labels: [] });

      await tryMerge(repo, prFor(77));

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 77, "Blocked");
    });

    it("skips the phase read entirely for a single-PR plan", async () => {
      // Default `mockPeekTotalPhases` — totalPhases: 1 — so `finalizeMergedClawsPR`
      // never calls `loadIssuePhaseState` at all: the ordinary case costs no
      // forge read beyond the merge itself, restoring the pre-multi-PR behaviour.
      await tryMerge(repo, prFor(NATIVE));

      expect(mockLoadPhaseState).not.toHaveBeenCalled();
    });
  });

});
