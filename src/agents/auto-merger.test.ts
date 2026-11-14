import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
    infraPathsIn: vi.fn((f: string[]) => f.filter((p) => /(?:^|\/)(?:tofu|terraform)\/|\.tfvars?$|\.tf$/.test(p) || /(?:^|\/)\.(?:github|forgejo)\/(?:workflows|actions)\/.*(?:tofu|terraform)/i.test(p))),
    getPRBody: vi.fn().mockResolvedValue(""),
    updatePR: vi.fn(async () => {}),
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
    getTofuPlanResourceEvidence: vi.fn().mockResolvedValue({ state: "unavailable", detail: "no plan comment" }),
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

const mockRecordPrMerged = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../gate-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gate-events.js")>()),
  recordPrMerged: mockRecordPrMerged,
}));

const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../slack.js", () => ({ notify: mockNotify }));
const mockDb = vi.hoisted(() => ({
  findLatestCompletedTaskForPrHead: vi.fn(),
  recordTaskEffectivenessEvent: vi.fn(),
  hasActiveWorkForPR: vi.fn(),
  getClawsPr: vi.fn(),
  setClawsPrMergeSkip: vi.fn(async () => {}),
  upsertClawsPr: vi.fn(async (..._args: unknown[]) => {}),
  getIssuePlannedPRs: vi.fn(),
  getApprovedDestroys: vi.fn(async (): Promise<db.IssueApprovedDestroys | null> => null),
}));
vi.mock("../db.js", () => mockDb);
const mockLinkedIssue = vi.hoisted(() => vi.fn());
const mockRecordPostMergeAction = vi.hoisted(() => vi.fn());
vi.mock("../pr-hold.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pr-hold.js")>()),
  linkedIssue: mockLinkedIssue,
  recordPostMergeAction: mockRecordPostMergeAction,
}));
const mockDeployGate = vi.hoisted(() => ({
  deployGateBlock: vi.fn(async (..._args: unknown[]): Promise<{ code: "deploy-red" | "deploy-pending"; reason: string; slug: string } | null> => null),
  noticeDeployHold: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("../deploy-gate.js", () => mockDeployGate);
const mockLoadInfraAck = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<unknown> => null));
vi.mock("../issue-infra-ack.js", () => ({ loadInfraAckForPr: mockLoadInfraAck }));
const mockIsPrHeldForReapproval = vi.hoisted(() => vi.fn());
vi.mock("../reapproval.js", () => ({ isPrHeldForReapproval: mockIsPrHeldForReapproval }));
const mockOccurrence = vi.hoisted(() => ({ closeAlertIssueIfResolved: vi.fn(async (_opts: { repo: string }) => null) }));
vi.mock("../occurrence-tracking.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../occurrence-tracking.js")>()),
  closeAlertIssueIfResolved: mockOccurrence.closeAlertIssueIfResolved,
}));
vi.mock("../worker.js", () => ({
  AGENT_KINDS: {
    CI_FIXER: "ci-fixer",
    CI_FIXER_CONFLICT: "ci-fixer:conflict",
    REVIEW_ADDRESSER: "review-addresser",
    PR_REVIEWER: "pr-reviewer",
  },
}));

import { attemptMerge, tryMerge, sweepRepo, isApprovalExempt, isIdleAwaitingHuman, clearGateVerdictCache, approvalHoldReason, AWAITING_OPERATOR_MARKER, finalizeMergedClawsPR, settleMergedPrState } from "./auto-merger.js";
import * as log from "../log.js";
import { deriveReviewStatus } from "../review-state.js";

const HEAD_SHA = "abc1234def";
const BASE_SHA = "b".repeat(40);

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
 * An auto-bump PR with a clean Claws review of its current head. Auto-bump is
 * approval-exempt and is the only category that still reaches the check
 * carry-forward branch (#2929): docs, ideas-collection and merge-approved PRs
 * all merge outright on check status "none". It needs no merge approval but,
 * like trusted Renovate, a clean review of the head (#clw_01M6ZYAQ1GZXRMTZSQP1V0XA4D).
 *
 * Arms `getPRChangedFiles`/`getPRReviewStatus` as a side effect — call it *before*
 * arming either of those mocks yourself, or this clobbers them.
 */
function autoBumpPR(files: string[] = ["apps/bonkus/deployment.yaml"], over: Parameters<typeof mockPR>[0] = {}): ReturnType<typeof mockPR> {
  mockGh.getPRChangedFiles.mockResolvedValue(files);
  mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc1234" });
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
  clearGateVerdictCache();
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
    mockDb.findLatestCompletedTaskForPrHead.mockResolvedValue(null);
    mockDb.recordTaskEffectivenessEvent.mockResolvedValue(undefined);
    mockGh.closeIssue.mockResolvedValue(undefined);
    mockClawsIssues.getIssue.mockResolvedValue(undefined);
    mockLoadPhaseState.mockResolvedValue(phaseState(1, [1], []));
    mockPeekTotalPhases.mockResolvedValue({ totalPhases: 1, stored: null });
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] });
  });

  it("records a pr-merged event with the linked issue after a successful merge", async () => {
    const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockRecordPrMerged).toHaveBeenCalledWith(repo.fullName, pr.number, expect.arrayContaining([42]));
  });

  it("records no pr-merged event when the head moved at merge time", async () => {
    const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
    mockMergeGate({ checkStatus: "passing" });
    mockGh.mergePR.mockRejectedValue(new Error("Head branch was modified. Review and try the merge again."));

    await tryMerge(repo, pr);

    expect(mockRecordPrMerged).not.toHaveBeenCalled();
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
    const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  describe("approved-destroys sync (#clw_01M70H3K4B7H0SNSAB5XJ8ZFCJ)", () => {
    const BLOCK = "<!-- claws-approved-destroys -->\n```tofu-approved-destroys\nroot: tofu\n";
    const consent = (addresses: string[]): db.IssueApprovedDestroys => ({
      destroys: addresses.map((address) => ({ position: 1, repo: repo.fullName, root: "tofu", address })),
      by: "op",
      at: "2026-11-09 10:00:00",
    });

    beforeEach(() => {
      mockDb.getApprovedDestroys.mockResolvedValue(null);
      mockDb.getIssuePlannedPRs.mockResolvedValue([{ position: 1, repo: repo.fullName, title: "t", prNumber: 77, dependsOn: null, kind: "pr", manualAction: null }]);
    });

    it("writes the block and adds the label before the gates when the Plan approval consented to destroys", async () => {
      const pr = approvedPR({ number: 77, headRefName: "claws/issue-42-abcd" });
      setRow(77, { issueId: "clw_1", phase: 1 });
      mockDb.getApprovedDestroys.mockResolvedValue(consent(["aws_route53_record.old"]));
      mockGh.getPRBody.mockResolvedValue("Desc\n\nCloses #42");
      mockMergeGate({ checkStatus: "pending" });

      await attemptMerge(repo, pr);

      expect(mockGh.updatePR).toHaveBeenCalledWith(repo.fullName, 77, expect.stringContaining(`${BLOCK}aws_route53_record.old\n\`\`\``));
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 77, "claws-approved-destroys");
      expect(mockGh.removeLabel).not.toHaveBeenCalledWith(repo.fullName, 77, "claws-approved-destroys");
    });

    it("removes the block and the label once the consent is withdrawn", async () => {
      const pr = approvedPR({ number: 77, headRefName: "claws/issue-42-abcd" });
      pr.labels.push({ name: "claws-approved-destroys" });
      setRow(77, { issueId: "clw_1", phase: 1 });
      mockGh.getPRBody.mockResolvedValue(`Desc\n\n${BLOCK}aws_route53_record.old\n\`\`\``);
      mockMergeGate({ checkStatus: "pending", labels: ["claws-approved-destroys"] });

      await attemptMerge(repo, pr);

      expect(mockGh.updatePR).toHaveBeenCalledWith(repo.fullName, 77, "Desc");
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 77, "claws-approved-destroys");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 77, "claws-approved-destroys");
    });

    it("re-toggles the label when the approved addresses change, so Tofu Plan re-runs", async () => {
      const pr = approvedPR({ number: 77, headRefName: "claws/issue-42-abcd" });
      pr.labels.push({ name: "claws-approved-destroys" });
      setRow(77, { issueId: "clw_1", phase: 1 });
      mockDb.getApprovedDestroys.mockResolvedValue(consent(["a.one", "a.two"]));
      mockGh.getPRBody.mockResolvedValue(`Desc\n\n${BLOCK}a.one\n\`\`\``);
      mockMergeGate({ checkStatus: "pending", labels: ["claws-approved-destroys"] });

      await attemptMerge(repo, pr);

      const removed = mockGh.removeLabel.mock.calls.findIndex((c) => c[2] === "claws-approved-destroys");
      const added = mockGh.addLabel.mock.calls.findIndex((c) => c[2] === "claws-approved-destroys");
      expect(removed).toBeGreaterThanOrEqual(0);
      expect(added).toBeGreaterThanOrEqual(0);
      expect(mockGh.removeLabel.mock.invocationCallOrder[removed]).toBeLessThan(mockGh.addLabel.mock.invocationCallOrder[added]!);
      expect(mockGh.updatePR).toHaveBeenCalledWith(repo.fullName, 77, expect.stringContaining("a.one\na.two\n```"));
    });

    it("does not merge on the CI result from before a sync that changed the block", async () => {
      const pr = approvedPR({ number: 77, headRefName: "claws/issue-42-abcd" });
      pr.labels.push({ name: "claws-approved-destroys" });
      setRow(77, { issueId: "clw_1", phase: 1 });
      mockGh.getPRBody.mockResolvedValue(`Desc\n\n${BLOCK}aws_route53_record.old\n\`\`\``);
      mockMergeGate({ checkStatus: "passing", labels: ["claws-approved-destroys"] });

      const result = await attemptMerge(repo, pr);

      expect(result).toMatchObject({ merged: false, code: "destroy-consent-sync" });
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 77, "claws-approved-destroys");
      expect(mockDb.setClawsPrMergeSkip).not.toHaveBeenCalledWith(repo.fullName, 77, expect.objectContaining({ code: "destroy-consent-sync" }));
    });

    it("strips a stale block from a PR held by a manual action", async () => {
      const pr = approvedPR({ number: 77, headRefName: "claws/issue-42-abcd" });
      pr.labels.push({ name: "claws-approved-destroys" });
      setRow(77, { issueId: "clw_1", phase: 1, manualActionReason: "set prod secrets" });
      mockGh.getPRBody.mockResolvedValue(`Desc\n\n${BLOCK}aws_route53_record.old\n\`\`\``);
      mockMergeGate({ checkStatus: "passing", labels: ["claws-approved-destroys"] });

      const result = await attemptMerge(repo, pr);

      expect(result).toMatchObject({ merged: false, code: "manual-action" });
      expect(mockGh.updatePR).toHaveBeenCalledWith(repo.fullName, 77, "Desc");
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 77, "claws-approved-destroys");
    });

    it("carries on to the gates when the sync fails", async () => {
      const pr = approvedPR({ number: 77, headRefName: "claws/issue-42-abcd" });
      setRow(77, { issueId: "clw_1", phase: 1 });
      mockDb.getApprovedDestroys.mockRejectedValue(new Error("db down"));
      mockMergeGate({ checkStatus: "passing" });

      await expect(attemptMerge(repo, pr)).resolves.toEqual({ merged: true });
    });
  });

  describe("attemptMerge (#clw_01M4XFRSGNP87QVW0N1W5KN0V4)", () => {
    it("merges a ready approved PR and attributes it to mergedBy", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
      mockMergeGate({ checkStatus: "passing" });
      mockDb.findLatestCompletedTaskForPrHead.mockResolvedValue({ id: 123 });

      await expect(attemptMerge(repo, pr, { mergedBy: "session:abc123" })).resolves.toEqual({ merged: true });

      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      expect(mockDb.recordTaskEffectivenessEvent).toHaveBeenCalledWith(expect.objectContaining({ details: { mergedBy: "session:abc123" } }));
      expect(mockDb.setClawsPrMergeSkip).toHaveBeenCalledWith(repo.fullName, pr.number, null);
    });

    it("refuses a held PR with manual-action and the reported reason", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
      setRow(pr.number, { manualActionReason: "set prod secrets" });
      mockMergeGate({ checkStatus: "passing" });

      const result = await attemptMerge(repo, pr, { mergedBy: "session:abc123" });

      expect(result).toMatchObject({ merged: false, code: "manual-action" });
      expect(result.merged === false && result.message).toContain("set prod secrets");
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("never reports the block on the PR with notify: false (#clw_01M5022YK7Z2V63775Y92B59P3)", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
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
      const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
      mockMergeGate({ checkStatus: "passing" });
      mockDb.hasActiveWorkForPR.mockResolvedValueOnce(true);

      await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: false, code: "other-work" });
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    // The other-work skip is decided before the merge gates, so it must not
    // overwrite the row's last gate skip (e.g. an operator `infra` block).
    it("does not persist an other-work skip on the row", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
      mockMergeGate({ checkStatus: "passing" });
      mockDb.hasActiveWorkForPR.mockResolvedValueOnce(true);
      mockDb.setClawsPrMergeSkip.mockClear();

      await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: false, code: "other-work" });
      expect(mockDb.setClawsPrMergeSkip).not.toHaveBeenCalled();
    });

    it("still reports merged when post-merge finalize throws", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
      mockMergeGate({ checkStatus: "passing" });
      mockDb.findLatestCompletedTaskForPrHead.mockResolvedValue({ id: 123 });
      mockPeekTotalPhases.mockRejectedValueOnce(new Error("boom"));

      await expect(attemptMerge(repo, pr, { mergedBy: "session:abc123" })).resolves.toEqual({ merged: true });
      expect(mockGh.mergePR).toHaveBeenCalled();
    });

    it("merges on a clean pr_reviews round of the full head, even when the review comment reads issues (#416)", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
      // The comment's clean marker sits after a quoted `<details>`, which the old
      // text parser stripped, reading `issues`. Status now comes from the row.
      mockGh.getIssueComments.mockResolvedValue([{
        id: 1, login: "claws", body: "*— Automated by Claws —*\n\n## PR Review\n1. the prose mentions a literal <details> tag\nReviewed commit: `abc1234`\nreview-result: clean\n</details>",
      }]);
      const row: db.PRReviewRecord = {
        id: 1, repo: repo.fullName, prNumber: pr.number, headSha: HEAD_SHA, reviewedSha: HEAD_SHA, baseSha: "b", verdict: "clean",
        mode: "full", iteration: 3, reviewerTaskId: 9, provider: "claude", model: "opus", findings: "1. the prose mentions a literal <details> tag",
        createdAt: "2026-11-01T00:00:00Z", addressedAt: null, addressedSha: null, rebutted: false, rebuttal: null, advisoryAddressedSha: null, recommendedModel: null, addresserSummary: null,
      };
      mockGh.getPRReviewStatus.mockImplementation(async () => deriveReviewStatus(row));
      mockMergeGate({ checkStatus: "passing" });

      await expect(attemptMerge(repo, pr)).resolves.toEqual({ merged: true });
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    });

    it("refuses red CI with checks-failed", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
      mockMergeGate({ checkStatus: "failing" });

      await expect(attemptMerge(repo, pr)).resolves.toEqual({ merged: false, code: "checks-failed", message: "CI is failing." });
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("refuses a stale review with review-stale", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "deadbee" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");
      mockMergeGate({ checkStatus: "passing" });

      await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: false, code: "review-stale" });
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("returns the log line when the block carries no reason", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.isDispatchSkippable.mockReturnValue(true);

      await expect(attemptMerge(repo, pr)).resolves.toEqual({
        merged: false,
        code: "dispatch-guard",
        message: "skipped: dispatch guard rejected live labels",
      });
    });

    it("refuses a settled head with no CI result with a reason naming the missing CI", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
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
      const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
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
    const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
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
    const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
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
    mockDb.getClawsPr.mockResolvedValue(null);
    mockMergeGate({ checkStatus: "passing" });

    expect(await tryMerge(repo, pr)).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    // Rejected off the DB row before any live forge read.
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
    const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
    mockMergeGate({ checkStatus: "none" });
    mockGh.getPRChangedFiles.mockResolvedValue([".agents/issue-refiner.md"]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(true);
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.carriedForwardCheckStatus).not.toHaveBeenCalled();
  });

  it("skips an approved PR with no checks when the head has not settled", async () => {
    const pr = approvedPR({ headRefName: "claws/issue-42-abcd" });
    mockMergeGate({ checkStatus: "none" });
    mockGh.getPRChangedFiles.mockResolvedValue([".agents/issue-refiner.md"]);
    mockGh.haveChecksSettled.mockResolvedValue({ settled: false, age: "30s" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips a PR with no merge approval at the approval gate, before checked files matter", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42-abcd" });
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

  it("does not merge auto-bump PR when checks are not passing", async () => {
    const pr = mockPR({
      headRefName: "automation/bump-bonkus-1.2.3",
      labels: [{ name: "dependencies" }, { name: "auto-bump" }],
    });
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml"]);
    mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc1234" });

    mockMergeGate({ checkStatus: "none" });
    let result = await tryMerge(repo, pr);
    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml"]);
    mockMergeGate({ checkStatus: "pending" });
    result = await tryMerge(repo, pr);
    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  // An auto-bump PR is approval-exempt whatever its diff: it merges on green CI
  // and a clean Claws review of its head (#clw_01M6ZYAQ1GZXRMTZSQP1V0XA4D).
  describe("auto-bump PR with any diff", () => {
    const branch = "automation/bump-bonkus-v2026-10-12.3";
    const labels = [{ name: "dependencies" }, { name: "auto-bump" }];
    const CFG = "infrastructure/prod/registry/config.json";
    const RUNNER = "clusters/my-cluster/privileged-infra/forgejo-runner/runner.yaml";

    /** An unapproved auto-bump PR changing `files`, with a clean review of the current head. */
    const cleanBump = (files: string[]) => {
      mockGh.getPRChangedFiles.mockResolvedValue(files);
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc1234" });
      mockGh.getPRHeadSHA.mockResolvedValue(HEAD_SHA);
      return mockPR({ headRefName: branch, labels });
    };

    beforeEach(() => {
      mockMergeGate({ checkStatus: "passing" });
    });

    it.each([
      ["edits the registry allowlist", ["apps/namey/deployment.yaml", CFG]],
      ["changes the image's registry host", ["apps/bonkus/deployment.yaml"]],
      ["bumps forgejo-runner-nix labels, volumes and annotations plus extra YAML lines", [RUNNER, "apps/other/configmap.yaml"]],
      ["touches a non-YAML file", ["apps/bonkus/deployment.yaml", "package.json"]],
    ])("merges without a merge approval when it %s", async (_what, files) => {
      const pr = cleanBump(files);

      expect(await tryMerge(repo, pr)).toBe(true);

      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      expect(mockGh.getPRDiff).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("is not merged on red CI", async () => {
      const pr = cleanBump(["apps/bonkus/deployment.yaml"]);
      mockMergeGate({ checkStatus: "failing" });

      expect(await tryMerge(repo, pr)).toBe(false);

      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("is not merged when the review found issues", async () => {
      const pr = cleanBump(["apps/bonkus/deployment.yaml"]);
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "issues", issueCount: 2, reviewedCommit: "abc1234" });

      const result = await attemptMerge(repo, pr);

      expect(result).toMatchObject({ merged: false, code: "review-not-clean" });
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("waits quietly while no review of the head has run", async () => {
      const pr = cleanBump(["apps/bonkus/deployment.yaml"]);
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "none", issueCount: 0, reviewedCommit: null });

      const result = await attemptMerge(repo, pr);

      expect(result).toMatchObject({ merged: false, code: "review-not-clean" });
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("is not merged when the clean review is of an older commit", async () => {
      const pr = cleanBump(["apps/bonkus/deployment.yaml"]);
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "0ld0ld0" });

      const result = await attemptMerge(repo, pr);

      expect(result).toMatchObject({ merged: false, code: "review-stale" });
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("is not merged without a merge approval when labelled major-update", async () => {
      mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml"]);
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc1234" });
      const pr = mockPR({ headRefName: branch, labels: [...labels, { name: "major-update" }] });

      const result = await attemptMerge(repo, pr);

      expect(result).toMatchObject({ merged: false, code: "not-approved" });
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

      it("merges an approved docs PR with no review and no checks on a settled head", async () => {
        const pr = approvedPR({ headRefName: "claws/docs-ab12" });
        mockGh.getPRReviewStatus.mockResolvedValue(noReview);
        mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
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

      it("still requires a clean review for an approved auto-bump PR", async () => {
        const pr = autoBumpPR();
        setRow(pr.number, { mergeApprovedAt: "2026-09-26T00:00:00Z", mergeApprovedBy: "oidc-sub-1" });
        mockGh.getPRReviewStatus.mockResolvedValue(noReview);
        mockMergeGate({ checkStatus: "passing" });

        expect(await tryMerge(repo, pr)).toBe(false);
        expect(mockGh.mergePR).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith(
          `[auto-merger] ${repo.fullName}#${pr.number} skipped: auto-bump image bump but review status=none`,
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

    // #clw_01M6P8ACN4YZA7CMTK0W112T0N: an unreported block still reaches the
    // web tier, through the persisted skip on the claws_prs row.
    it("persists an unreported infra block's skip on the row", async () => {
      const pr = renovatePR();
      mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);
      mockDb.setClawsPrMergeSkip.mockClear();

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.setMergeBlockReason).not.toHaveBeenCalled();
      expect(mockDb.setClawsPrMergeSkip).toHaveBeenCalledWith(repo.fullName, pr.number, expect.objectContaining({
        code: "infra",
        reason: expect.stringContaining("always need a human merge"),
        head: expect.any(String),
      }));
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

    describe("plan-stage infra acknowledgement (#clw_01M7096B0VFCVYAA2ED0ZRHFC2)", () => {
      const DECLARATION = {
        resources: [{ root: "tofu", address: "hcloud_server.web", actions: ["change"] }],
        workflow_files: [],
      };
      const ack = (state: "none" | "current" | "stale") => ({
        issueId: "clw_1", position: 1, declaration: DECLARATION, state,
        ack: state === "none" ? null : { by: "oidc-sub-1", at: "2026-11-01 00:00:00", hash: "h" },
      });
      const PIN_ONLY_DIFF = "diff --git a/tofu/versions.tf b/tofu/versions.tf\n--- a/tofu/versions.tf\n+++ b/tofu/versions.tf\n@@ -1 +1 @@\n-      version = \"6.66.0\"\n+      version = \"6.67.0\"\n";
      const TF_DIFF = "diff --git a/tofu/main.tf b/tofu/main.tf\n--- a/tofu/main.tf\n+++ b/tofu/main.tf\n@@ -1 +1 @@\n-  size = 1\n+  size = 2\n";

      function declaredInfraPR(state: "none" | "current" | "stale"): ReturnType<typeof mockPR> {
        const pr = approvedPR({ headRefName: "claws/issue-clw_1-ab12" });
        setRow(pr.number, { issueId: "clw_1" });
        mockMergeGate({ checkStatus: "passing" });
        mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);
        mockGh.getPRDiff.mockResolvedValue(TF_DIFF);
        mockLoadInfraAck.mockResolvedValue(ack(state));
        return pr;
      }

      afterEach(() => {
        mockLoadInfraAck.mockResolvedValue(null);
      });

      it("merges and labels a PR whose verified plan matches the acknowledged declaration", async () => {
        const pr = declaredInfraPR("current");
        mockGh.getTofuPlanResourceEvidence.mockResolvedValue({ state: "available", roots: [{ root: "tofu", resources: [{ address: "hcloud_server.web", kind: "change" }] }] });

        await expect(attemptMerge(repo, pr)).resolves.toEqual({ merged: true });
        expect(mockGh.getTofuPlanResourceEvidence).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
        expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "claws-ack-merge");
        expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("infra changes for head abc1234 match the acknowledgement by oidc-sub-1; merging"));
        expect(mockGh.commentOnIssue).toHaveBeenCalledWith(repo.fullName, pr.number, expect.stringContaining("Merged under the acknowledged infra changes"), expect.anything());
      });

      it("removes a stale claws-noop-merge label before an acknowledged merge", async () => {
        const pr = declaredInfraPR("current");
        pr.labels = [{ name: "claws-noop-merge" }] as typeof pr.labels;
        mockGh.getTofuPlanResourceEvidence.mockResolvedValue({ state: "available", roots: [{ root: "tofu", resources: [{ address: "hcloud_server.web", kind: "change" }] }] });

        await expect(attemptMerge(repo, pr)).resolves.toEqual({ merged: true });
        expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "claws-noop-merge");
        expect(mockGh.removeLabel.mock.invocationCallOrder[0]).toBeLessThan(mockGh.mergePR.mock.invocationCallOrder[0]);
        expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "claws-ack-merge");
      });

      it("refuses an acknowledged merge when a stale claws-noop-merge label cannot be removed", async () => {
        const pr = declaredInfraPR("current");
        pr.labels = [{ name: "claws-noop-merge" }] as typeof pr.labels;
        mockGh.getTofuPlanResourceEvidence.mockResolvedValue({ state: "available", roots: [{ root: "tofu", resources: [{ address: "hcloud_server.web", kind: "change" }] }] });
        mockGh.removeLabel.mockRejectedValueOnce(new Error("forge down"));

        await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: false, code: "error" });
        expect(mockGh.mergePR).not.toHaveBeenCalled();
        expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, pr.number, "claws-ack-merge");
      });

      it("blocks infra-undeclared with every unexpected change when the plan leaves the declaration", async () => {
        const pr = declaredInfraPR("current");
        mockGh.getTofuPlanResourceEvidence.mockResolvedValue({ state: "available", roots: [{ root: "tofu", resources: [
          { address: "hcloud_server.web", kind: "replace" },
          { address: "hcloud_network.main", kind: "add" },
        ] }] });

        const result = await attemptMerge(repo, pr);

        expect(result).toMatchObject({ merged: false, code: "infra-undeclared" });
        const message = (result as { message: string }).message;
        expect(message).toContain("The Tofu plan for head abc1234 has changes outside the acknowledged infra changes:");
        expect(message).toContain("- tofu: hcloud_server.web replace not declared (declared as change)");
        expect(message).toContain("- tofu: hcloud_network.main add not declared");
        expect(message).toContain("Approve infra merge from the board to merge anyway.");
        expect(mockGh.mergePR).not.toHaveBeenCalled();
        expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, pr.number, "claws-ack-merge");
        // Approved, so the block is reported on the PR.
        expect(mockGh.setMergeBlockReason).toHaveBeenCalledWith(repo.fullName, pr.number, message, "infra-undeclared");
      });

      it("falls through to today's hold, naming why the acknowledgement could not be checked, when resource evidence is unavailable", async () => {
        const pr = declaredInfraPR("current");
        mockGh.getTofuPlanResourceEvidence.mockResolvedValue({ state: "unavailable", detail: "plan comment has no resource list" });
        mockGh.getTofuPlanEvidence.mockResolvedValueOnce({ plan: { add: 0, change: 1, replace: 0, destroy: 0 }, state: "changes", detail: "plan shows 1 change" });

        const result = await attemptMerge(repo, pr);

        expect(result).toMatchObject({ merged: false, code: "infra-plan" });
        expect((result as { message: string }).message).toContain("The acknowledged infra changes could not be checked: plan comment has no resource list.");
        expect(mockGh.mergePR).not.toHaveBeenCalled();
        expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, pr.number, "claws-ack-merge");
      });

      it("keeps the plan-not-available hold log-only, with the resource-list detail, when neither evidence is available", async () => {
        const pr = declaredInfraPR("current");
        mockGh.getPRChangedFiles.mockResolvedValue(["tofu/versions.tf"]);
        mockGh.getPRDiff.mockResolvedValue(PIN_ONLY_DIFF);
        mockGh.getTofuPlanResourceEvidence.mockResolvedValue({ state: "unavailable", detail: "plan comment has no resource list" });
        mockGh.getTofuPlanEvidence.mockResolvedValueOnce({ plan: null, state: "unavailable", detail: "no plan comment" });

        await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: false, code: "infra-plan" });
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("infrastructure plan not available for head abc1234 (no plan comment; acknowledged resource list: plan comment has no resource list)"), "merge_skipped", expect.objectContaining({ mergeSkip: "infra-plan" }));
        expect(mockGh.setMergeBlockReason).not.toHaveBeenCalled();
        expect(mockGh.mergePR).not.toHaveBeenCalled();
      });

      it("still merges a verified zero-change plan through the no-op path when resource evidence is unavailable", async () => {
        const pr = declaredInfraPR("current");
        mockGh.getPRChangedFiles.mockResolvedValue(["tofu/versions.tf"]);
        mockGh.getPRDiff.mockResolvedValue(PIN_ONLY_DIFF);
        mockGh.getTofuPlanResourceEvidence.mockResolvedValue({ state: "unavailable", detail: "plan comment has no resource list" });
        mockGh.getTofuPlanEvidence.mockResolvedValueOnce({ plan: { add: 0, change: 0, replace: 0, destroy: 0 }, state: "noop", detail: "no-op plan" });

        await expect(attemptMerge(repo, pr)).resolves.toEqual({ merged: true });
        expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "claws-noop-merge");
        expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, pr.number, "claws-ack-merge");
        expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      });

      it("names a board approval that did not carry over in the infra-undeclared reason", async () => {
        const pr = declaredInfraPR("current");
        setRow(pr.number, { issueId: "clw_1", infraMergeApprovedBy: "oidc-sub-1", infraMergeApprovedAt: "2026-10-26T10:00:00Z", infraMergeApprovedSha: "0001112223" });
        mockGh.getTofuPlanResourceEvidence.mockResolvedValue({ state: "available", roots: [{ root: "tofu", resources: [{ address: "hcloud_network.main", kind: "add" }] }] });

        const result = await attemptMerge(repo, pr);

        expect(result).toMatchObject({ merged: false, code: "infra-undeclared" });
        const message = (result as { message: string }).message;
        expect(message).toContain("- tofu: hcloud_network.main add not declared");
        expect(message).toContain("Infra merge approval not carried over: approved plan for 0001112 was not recorded; approve the infra merge again from the board.");
        expect(message).not.toContain("to merge anyway");
      });

      it.each(["stale", "none"] as const)("falls back to today's hold with the plan-stage hint when the acknowledgement is %s", async (state) => {
        const pr = declaredInfraPR(state);
        mockGh.getTofuPlanEvidence.mockResolvedValueOnce({ plan: { add: 0, change: 1, replace: 0, destroy: 0 }, state: "changes", detail: "plan shows 1 change" });

        await expect(attemptMerge(repo, pr)).resolves.toEqual({
          merged: false,
          code: "infra-plan",
          message: "The Tofu plan for this head shows 1 change, so a human must merge it. Approve its infra changes on the issue, or approve this head from the board.",
        });
        expect(mockGh.getTofuPlanResourceEvidence).not.toHaveBeenCalled();
      });

      it("removes a stale claws-ack-merge label from a PR it does not merge under the acknowledgement", async () => {
        const pr = declaredInfraPR("stale");
        pr.labels = [{ name: "claws-ack-merge" }];
        mockGh.getTofuPlanEvidence.mockResolvedValueOnce({ plan: { add: 0, change: 1, replace: 0, destroy: 0 }, state: "changes", detail: "plan shows 1 change" });

        await attemptMerge(repo, pr);

        expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "claws-ack-merge");
      });
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
        mockGh.getTofuPlanEvidence.mockResolvedValueOnce({ plan: { add: 0, change: 1, replace: 0, destroy: 0 }, state: "changes", detail: "plan shows 1 change" });

        await expect(attemptMerge(repo, pr, { mergedBy: "session:abc123" })).resolves.toEqual({
          merged: false,
          code: "infra-plan",
          message: "The Tofu plan for this head shows 1 change, so a human must merge it.",
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
        expect((result as { message: string }).message).toBe("Infra merge approval not carried over: approved plan for 0001112 was not recorded; approve the infra merge again from the board.");
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
      ["a plain workflow", ".github/workflows/ci.yml"],
      ["a tofu workflow", ".github/workflows/tofu-plan-on-pr.yml"],
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

  describe("no-op Tofu plan exception for Forgejo provider bumps (any approved zero-change plan)", () => {
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
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("allowing a zero-change infra merge (plan-only)"));
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
      ["a plain workflow file", ["tofu/versions.tf", ".forgejo/workflows/ci.yml"], sec("tofu/versions.tf", "@@ -1 +1 @@\n-a\n+b") + sec(".forgejo/workflows/ci.yml", "@@ -1 +1 @@\n-a\n+b"), "changes workflow file .forgejo/workflows/ci.yml"],
      ["a tofu workflow edit", ["tofu/versions.tf", ".forgejo/workflows/tofu-apply.yml"], sec("tofu/versions.tf", "@@ -1 +1 @@\n-a\n+b") + sec(".forgejo/workflows/tofu-apply.yml", "@@ -1 +1 @@\n-a\n+b"), "non-version change in .forgejo/workflows/tofu-apply.yml"],
    ])("holds a diff with %s without reading the plan, naming the reason", async (_what, files, diff, reason) => {
      const pr = clawsBumpPR();
      mockGh.getPRChangedFiles.mockResolvedValue(files);
      mockGh.getPRDiff.mockResolvedValue(diff);

      await expect(attemptMerge(repo, pr)).resolves.toMatchObject({
        merged: false,
        code: "infra",
        message: expect.stringContaining(`always need a human merge. The zero-change plan exception does not apply: ${reason}.`),
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

  describe("zero-change plan exception for BAU infra PRs (#clw_01M7095Y5BKVV7WQ7078Z15GH7)", () => {
    const NOOP = { plan: { add: 0, change: 0, replace: 0, destroy: 0 }, state: "noop", detail: "no-op plan", resources: [], roots: [null] };
    const sec = (path: string, body: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}\n`;
    const TFTPL = "tofu/modules/hcloud-cluster/templates/_common_tailscale.sh.tftpl";
    const INSTALL_TOFU = ".github/actions/install-tofu/action.yml";
    // production-infra #527 / #708.
    const TFTPL_FILES = [TFTPL, "scripts/check-tailscale.sh"];
    const TFTPL_DIFF = sec(TFTPL, "@@ -1 +1 @@\n-TAILSCALE_VERSION=1.90.1\n+TAILSCALE_VERSION=1.90.2") + sec("scripts/check-tailscale.sh", "@@ -1 +1 @@\n-v=1.90.1\n+v=1.90.2");
    // production-infra #707.
    const TOOL_DIFF = sec(INSTALL_TOFU, "@@ -5,3 +5,3 @@\n   version:\n-    default: \"1.13.7\"\n+    default: \"1.13.8\"\n     required: false");

    function renovatePR(files: string[], diff: string): ReturnType<typeof mockPR> {
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc1234" });
      mockGh.getPRHeadSHA.mockResolvedValue(HEAD_SHA);
      mockGh.getPRChangedFiles.mockResolvedValue(files);
      mockGh.getPRDiff.mockResolvedValue(diff);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getTofuPlanEvidence.mockResolvedValue(NOOP);
      return mockPR({
        author: { login: "renovate" },
        headRefName: "renovate/tailscale-1.x",
        title: "chore(deps): update dependency tailscale to v1.90.2",
        body: "| Package | Update | Change |\n|---|---|---|\n| tailscale | patch | `1.90.1` -> `1.90.2` |",
        labels: [],
      });
    }

    it("merges a trusted Renovate template and script bump on a zero-change plan, labelled for the apply guard", async () => {
      const pr = renovatePR(TFTPL_FILES, TFTPL_DIFF);

      expect(await tryMerge(repo, pr)).toBe(true);
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "claws-noop-merge");
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("allowing a zero-change infra merge (plan-only)"));
    });

    it("merges an approved template PR on a zero-change plan", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-708-ab12" });
      mockGh.getPRChangedFiles.mockResolvedValue(TFTPL_FILES);
      mockGh.getPRDiff.mockResolvedValue(TFTPL_DIFF);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getTofuPlanEvidence.mockResolvedValue(NOOP);

      expect(await tryMerge(repo, pr)).toBe(true);
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "claws-noop-merge");
    });

    it("merges a trusted Renovate install-tofu version bump on a zero-change plan", async () => {
      const pr = renovatePR([INSTALL_TOFU], TOOL_DIFF);

      expect(await tryMerge(repo, pr)).toBe(true);
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "claws-noop-merge");
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("allowing a zero-change infra merge (tool-version-bump)"));
    });

    it("holds an approved, non-Renovate install-tofu version bump for a human", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-707-ab12" });
      mockGh.getPRChangedFiles.mockResolvedValue([INSTALL_TOFU]);
      mockGh.getPRDiff.mockResolvedValue(TOOL_DIFF);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getTofuPlanEvidence.mockResolvedValue(NOOP);

      await expect(attemptMerge(repo, pr)).resolves.toMatchObject({
        merged: false, code: "infra",
        message: expect.stringContaining("tofu tool version bump is only auto-merged for a trusted Renovate update"),
      });
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("holds a Renovate PR with any other edit to a tofu action", async () => {
      const pr = renovatePR([INSTALL_TOFU], sec(INSTALL_TOFU, "@@ -1 +1 @@\n-  run: tofu version\n+  run: tofu apply -auto-approve"));

      await expect(attemptMerge(repo, pr)).resolves.toMatchObject({
        merged: false, code: "infra", message: expect.stringContaining(`non-version change in ${INSTALL_TOFU}`),
      });
      expect(mockGh.getTofuPlanEvidence).not.toHaveBeenCalled();
    });

    it("holds an approval-exempt auto-bump infra PR even on a zero-change plan", async () => {
      const pr = autoBumpPR([TFTPL]);
      mockGh.getPRDiff.mockResolvedValue(TFTPL_DIFF);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getTofuPlanEvidence.mockResolvedValue(NOOP);

      await expect(attemptMerge(repo, pr)).resolves.toMatchObject({
        merged: false, code: "infra", message: expect.stringContaining("it covers only an approved PR or a trusted non-major Renovate update"),
      });
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });
  });

  describe("infra approval carried over across plan-neutral commits (#clw_01M7095Y5BKVV7WQ7078Z15GH7)", () => {
    const OLD = "b6e6701aaa";
    // production-infra #706's plan: 0 to add, 2 to change, 4 to replace.
    const RESOURCES = [
      { root: null, address: "hcloud_volume.postgres_data", action: "update" },
      { root: null, address: "module.cluster.hcloud_server.cluster", action: "delete+create" },
      { root: null, address: "module.cluster.hcloud_server.data", action: "delete+create" },
      { root: null, address: "module.cluster.hcloud_server_network.cluster", action: "delete+create" },
      { root: null, address: "module.cluster.hcloud_server_network.data", action: "delete+create" },
      { root: null, address: "module.cluster.terraform_data.rebuild_trigger", action: "update" },
    ];
    const PLAN = { add: 0, change: 2, replace: 4, destroy: 0 };
    const EVIDENCE = { plan: PLAN, state: "changes", detail: "plan shows 6 changes", resources: RESOURCES, roots: [null] };
    const fingerprint = (rs: typeof RESOURCES) => rs.map((r) => `- ${r.address} ${r.action}`).sort().join("\n");
    const FILES = ["tofu/k3s.tf"];
    const DIFF = "diff --git a/tofu/k3s.tf b/tofu/k3s.tf\n--- a/tofu/k3s.tf\n+++ b/tofu/k3s.tf\n@@ -1 +1 @@\n-k3s = \"v1.33.1\"\n+k3s = \"v1.33.2\"\n";
    const approvalRow = (evidence: object | null) => ({
      infraMergeApprovedBy: "oidc-sub-1", infraMergeApprovedAt: "2026-11-08T21:00:00Z", infraMergeApprovedSha: OLD,
      infraMergeApprovedEvidence: evidence === null ? null : JSON.stringify(evidence),
    });

    function movedPR(evidence: object | null = { fingerprint: fingerprint(RESOURCES), counts: PLAN, workflowDiff: "" }): ReturnType<typeof mockPR> {
      const pr = approvedPR({ headRefName: "renovate/k3s" });
      setRow(pr.number, approvalRow(evidence));
      mockGh.getPRChangedFiles.mockResolvedValue(FILES);
      mockGh.getPRDiff.mockResolvedValue(DIFF);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getTofuPlanEvidence.mockResolvedValue(EVIDENCE);
      return pr;
    }

    it("carries the approval to a new head with the same plan and no tofu workflow change, and merges", async () => {
      const pr = movedPR();

      await expect(attemptMerge(repo, pr)).resolves.toEqual({ merged: true });
      expect(mockDb.upsertClawsPr).toHaveBeenCalledWith(repo.fullName, pr.number, {
        infraMergeCarriedSha: HEAD_SHA, infraMergeCarriedNote: "same plan as b6e6701, no tofu workflow change",
      });
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("infra merge approval by oidc-sub-1 for b6e6701 carried over to abc1234"));
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, pr.number, "claws-noop-merge");
    });

    it("merges on a carried approval already recorded for this head", async () => {
      const pr = movedPR();
      setRow(pr.number, { infraMergeCarriedSha: HEAD_SHA, infraMergeCarriedNote: "same plan" });

      await expect(attemptMerge(repo, pr)).resolves.toEqual({ merged: true });
      expect(mockGh.getTofuPlanEvidence).not.toHaveBeenCalled();
    });

    it.each([
      ["the plan differs", () => {
        mockGh.getTofuPlanEvidence.mockResolvedValue({ ...EVIDENCE, resources: [...RESOURCES, { root: null, address: "hcloud_firewall.x", action: "delete" }] });
      }, "plan for abc1234 differs from the approved plan for b6e6701: now plans hcloud_firewall.x delete"],
      ["a tofu workflow changed", () => {
        mockGh.getPRChangedFiles.mockResolvedValue([...FILES, ".forgejo/workflows/tofu-apply.yml"]);
        mockGh.getPRDiff.mockResolvedValue(DIFF + "diff --git a/.forgejo/workflows/tofu-apply.yml b/.forgejo/workflows/tofu-apply.yml\n@@ -1 +1 @@\n-a\n+b\n");
      }, ".forgejo/workflows/tofu-apply.yml changed since b6e6701"],
      ["the new plan is unavailable", () => {
        mockGh.getTofuPlanEvidence.mockResolvedValue({ plan: PLAN, state: "unavailable", detail: "plan comment predates the head commit" });
      }, "plan for abc1234 not available (plan comment predates the head commit)"],
    ])("goes stale when %s, naming the rule", async (_what, arrange, reason) => {
      const pr = movedPR();
      arrange();

      await expect(attemptMerge(repo, pr)).resolves.toEqual({
        merged: false, code: "infra-approval-stale",
        message: `Infra merge approval not carried over: ${reason}; approve the infra merge again from the board.`,
      });
      expect(mockDb.upsertClawsPr).not.toHaveBeenCalled();
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("goes stale when the approval recorded no plan", async () => {
      const pr = movedPR(null);

      await expect(attemptMerge(repo, pr)).resolves.toMatchObject({
        merged: false, code: "infra-approval-stale",
        message: "Infra merge approval not carried over: approved plan for b6e6701 was not recorded; approve the infra merge again from the board.",
      });
    });

    it("still merges a stale approval's new head on a zero-change plan", async () => {
      const pr = movedPR();
      mockGh.getTofuPlanEvidence.mockResolvedValue({ plan: { add: 0, change: 0, replace: 0, destroy: 0 }, state: "noop", detail: "no-op plan", resources: [], roots: [null] });

      await expect(attemptMerge(repo, pr)).resolves.toEqual({ merged: true });
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "claws-noop-merge");
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
    it("comments and records the action, with no Slack line, when the merged body has a post-merge section", async () => {
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
      expect(mockNotify).not.toHaveBeenCalled();
      expect(mockRecordPostMergeAction).toHaveBeenCalledWith(repo.fullName, pr.number, "Publish the DS record at the registrar");
      expect(mockGh.commentOnIssue.mock.invocationCallOrder[0]).toBeLessThan(mockRecordPostMergeAction.mock.invocationCallOrder[0]!);
    });

    it("comments but does not record a note duplicating a later plan step", async () => {
      const pr = autoBumpPR();
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue(
        "## Summary\nx\n\n## 📋 Manual action required after merge\n\nSet alertBridge.poll in production-infra's claws.json",
      );
      mockDb.getClawsPr.mockResolvedValue(prRow(pr.number, { issueId: "clw_X", phase: 2 }));
      mockDb.getIssuePlannedPRs.mockResolvedValue([
        { position: 2, repo: repo.fullName, title: "a", prNumber: pr.number, dependsOn: null, kind: "pr", manualAction: null },
        { position: 3, repo: "org/production-infra", title: "b", prNumber: null, dependsOn: null, kind: "pr", manualAction: null },
      ]);

      expect(await tryMerge(repo, pr)).toBe(true);
      expect(mockGh.commentOnIssue).toHaveBeenCalled();
      expect(mockRecordPostMergeAction).not.toHaveBeenCalled();
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
      expect(mockRecordPostMergeAction).not.toHaveBeenCalled();
    });

    it("does not comment or record a standing (recurring or conditional) post-merge note", async () => {
      const pr = autoBumpPR();
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRBody.mockResolvedValue(
        "## Summary\nDid the thing.\n\n## 📋 Manual action required after merge\n\nRecompute the JWK thumbprints whenever a JWK provisioner is rotated",
      );

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockRecordPostMergeAction).not.toHaveBeenCalled();
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
    const branch = "automation/bump-bonkus-v2026-10-12.3";

    it("is true whatever the diff, without reading it", async () => {
      mockGh.getPRChangedFiles.mockResolvedValue(["apps/bonkus/deployment.yaml", "package.json"]);
      const pr = mockPR({ headRefName: branch, labels: [{ name: "auto-bump" }] });
      expect(await isApprovalExempt(repo.fullName, pr, prRow(1))).toBe(true);
      expect(mockGh.getPRDiff).not.toHaveBeenCalled();
      expect(mockGh.getPRChangedFiles).not.toHaveBeenCalled();
    });

    it("is false for a major-update bump", async () => {
      const pr = mockPR({ headRefName: branch, labels: [{ name: "auto-bump" }, { name: "major-update" }] });
      expect(await isApprovalExempt(repo.fullName, pr, prRow(1))).toBe(false);
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

  it("closes the retired auto-bump stall alert once per repo per process", async () => {
    const retireRepo = mockRepo({ name: "retire-repo", fullName: "test-org/retire-repo" });
    mockGh.listPRs.mockResolvedValue([]);

    await sweepRepo(retireRepo);
    await sweepRepo(retireRepo);

    const calls = mockOccurrence.closeAlertIssueIfResolved.mock.calls.filter(([opts]) => opts.repo === retireRepo.fullName);
    expect(calls).toEqual([[expect.objectContaining({
      repo: retireRepo.fullName,
      title: "Auto-bump PRs held by the structural merge gate",
      logPrefix: "auto-merger",
      force: true,
    })]]);
  });

  it("finishes the sweep when closing the retired stall alert fails", async () => {
    const retireRepo = mockRepo({ name: "retire-fail", fullName: "test-org/retire-fail" });
    mockGh.listPRs.mockResolvedValue([]);
    mockOccurrence.closeAlertIssueIfResolved.mockRejectedValueOnce(new Error("forge down"));

    await expect(sweepRepo(retireRepo)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("could not close the retired auto-bump stall alert"));
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
        // The generic "Manual actions (operator)" title is left out of the first line.
        expect(body).toContain("Operator step 3 is ready: Import the repo on Forgejo.");
        expect(body).not.toContain("Operator step 3 is ready (");
        expect(body).toContain("1. Import the repo on Forgejo.");
        expect(body).not.toContain("claws-phase-done: 3");
        expect(body).toContain("claws_mark_phase_done");
        expect(body).toContain(AWAITING_OPERATOR_MARKER);
        // The issue is parked in Blocked with the step as its reason (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK).
        expect(body).toContain("## Needs a human");
        expect(body).toContain("claws-needs-human:awaiting-operator-3");
        expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 77, "Blocked");
        expect(mockGh.blockIssue.mock.calls.at(-1)?.[2] ?? "").toMatch(/^Operator step 3 is ready: Import the repo on Forgejo\./);
        expect(mockNotify).not.toHaveBeenCalled();
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

    // A Forgejo UI merge past a failing gate (#clw_01M7AB0Y52QAYR0W1XRVY3BVEV):
    // `refreshPrStore` has no branch name, only the row's issueId.
    describe("a hand merge named by the row's issueId", () => {
      const handMerged = (issueId: string) => ({ number: 91, headRefName: "", body: undefined, issueId });

      it("closes a multi-step issue whose plan it completes", async () => {
        setPhaseState(2, [1, 2], []);

        await finalizeMergedClawsPR(repo, handMerged("77"), "hand-merge");

        expect(mockLoadPhaseState).toHaveBeenCalledWith(repo.fullName, 77, [], expect.anything());
        expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, 77, "completed");
      });

      it("settles a single-step issue its PR did not close", async () => {
        mockGh.getPRBody.mockResolvedValue("Part of #77");

        await finalizeMergedClawsPR(repo, handMerged("77"), "hand-merge");

        expect(mockGh.commentOnIssue).toHaveBeenCalledWith(repo.fullName, 77, expect.stringContaining("merged without closing this issue"), expect.anything());
        expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 77, "Blocked");
      });

      it("prefers the branch's issue over issueId", async () => {
        setPhaseState(2, [1, 2], []);

        await finalizeMergedClawsPR(repo, { ...handMerged("88"), headRefName: "claws/issue-77-ab12" }, "hand-merge");

        expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, 77, "completed");
        expect(mockGh.closeIssue).not.toHaveBeenCalledWith(repo.fullName, 88, expect.anything());
      });
    });
  });

  describe("settleMergedPrState (#clw_01M7AB0Y52QAYR0W1XRVY3BVEV)", () => {
    const claws = (body: string) => `*— Automated by Claws · Auto Merger —*\n\n${body}`;
    const MERGED = "### Merged\n\nThis PR has merged; the block above no longer applies.\n\nclaws-merge-status";

    it("clears the block state and marks the merge-status comment merged", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 5, body: claws("### Merge blocked\n\nCI is failing.\n\nclaws-merge-status"), body_html: "", login: "claws" },
      ]);

      await settleMergedPrState(repo.fullName, 91);

      expect(mockGh.setMergeBlockReason).toHaveBeenCalledWith(repo.fullName, 91, null);
      expect(mockDb.setClawsPrMergeSkip).toHaveBeenCalledWith(repo.fullName, 91, null);
      expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, 91);
      expect(mockGh.editIssueComment).toHaveBeenCalledWith(repo.fullName, 5, MERGED, { agentName: "Auto Merger" });
    });

    it("leaves an already-merged comment alone and posts none when there is no comment", async () => {
      mockGh.getIssueComments.mockResolvedValue([{ id: 5, body: claws(MERGED), body_html: "", login: "claws" }]);
      await settleMergedPrState(repo.fullName, 91);
      mockGh.getIssueComments.mockResolvedValue([]);
      await settleMergedPrState(repo.fullName, 92);

      expect(mockGh.editIssueComment).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("never throws when the comment read fails", async () => {
      mockGh.getIssueComments.mockRejectedValue(new Error("forge down"));

      await expect(settleMergedPrState(repo.fullName, 91)).resolves.toBeUndefined();
    });
  });

});

describe("red deploy on an earlier step (#clw_01M6RPD77S4VCG7068KVFN4GEF)", () => {
  const repo = mockRepo();
  const ISSUE = { repo: repo.fullName, ref: "clw_01M6NVFJQH6227AXV2B7SP9CVA" };
  const RED = {
    code: "deploy-red" as const,
    reason: "Step 2 depends on step 1 (`test-org/test-repo#633`), merged at 2026-11-05T20:30:00Z, and its deploy workflow `tofu-apply.yml` failed on `main` (run https://git.example.com/runs/3754). Claws will merge this PR once a later `tofu-apply.yml` run on `main` succeeds.",
    slug: "deploy-red-test-org/test-repo#641-tofu-apply.yml",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getPRChangedFiles.mockResolvedValue([]);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.isForkPR.mockReturnValue(false);
    mockGh.isDispatchSkippable.mockReturnValue(false);
    mockGh.mergePR.mockResolvedValue(undefined);
    mockDb.findLatestCompletedTaskForPrHead.mockResolvedValue(null);
    mockLinkedIssue.mockResolvedValue(ISSUE);
  });

  it("holds an otherwise-ready PR, reports the block on the PR and tells the issue, then merges once the deploy is green", async () => {
    const pr = approvedPR({ number: 641, headRefName: "claws/issue-clw_01M6NVFJQH6227AXV2B7SP9CVA-abcd" });
    setRow(pr.number, { phase: 2, issueId: ISSUE.ref });
    mockDeployGate.deployGateBlock.mockResolvedValueOnce(RED);

    const held = await attemptMerge(repo, pr);

    expect(held).toMatchObject({ merged: false, code: "deploy-red", message: RED.reason });
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(mockDeployGate.deployGateBlock).toHaveBeenCalledWith(repo, expect.objectContaining({ prNumber: 641, phase: 2 }), ISSUE);
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName, 641, expect.stringContaining("### Merge blocked"), { agentName: "Auto Merger" },
    );
    expect(mockGh.commentOnIssue.mock.calls[0]![2]).toContain("tofu-apply.yml");
    expect(mockDeployGate.noticeDeployHold).toHaveBeenCalledWith(ISSUE, repo.fullName, 641, RED);
    expect(mockDb.setClawsPrMergeSkip).toHaveBeenCalledWith(repo.fullName, 641, expect.objectContaining({ code: "deploy-red" }));
    // A hold, not a manual action: nothing parks the issue.
    expect(mockGh.blockIssue).not.toHaveBeenCalled();

    await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: true });
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, 641, HEAD_SHA);
  });

  it("holds quietly while the deploy is still running", async () => {
    const pr = approvedPR({ number: 641, headRefName: "claws/issue-clw_01M6NVFJQH6227AXV2B7SP9CVA-abcd" });
    setRow(pr.number, { phase: 2, issueId: ISSUE.ref });
    mockDeployGate.deployGateBlock.mockResolvedValueOnce({ code: "deploy-pending", reason: "still running", slug: "x" });

    await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: false, code: "deploy-pending" });
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockDeployGate.noticeDeployHold).not.toHaveBeenCalled();
  });

  it("is not consulted while CI is failing", async () => {
    const pr = approvedPR({ number: 641 });
    mockMergeGate({ checkStatus: "failing" });

    await expect(attemptMerge(repo, pr)).resolves.toMatchObject({ merged: false, code: "checks-failed" });
    expect(mockDeployGate.deployGateBlock).not.toHaveBeenCalled();
  });
});
