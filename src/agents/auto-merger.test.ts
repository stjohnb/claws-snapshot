import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";
import type * as db from "../db.js";

/** Full names the config mock should treat as Forgejo-hosted; per-test opt-in. */
const mockForgejoRepos = vi.hoisted(() => new Set<string>());
vi.mock("../config.js", async () => ({
  isClawsIssueId: (await vi.importActual<typeof import("../issue-id.js")>("../issue-id.js")).isClawsIssueId,
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    manualAction: "Manual Action",
    automerge: "Automerge",
    needsLgtm: "Needs LGTM",
    blocked: "Blocked",
  },
  prUrl: (fullName: string, prNumber: number) =>
    mockForgejoRepos.has(fullName)
      ? `https://git.example.com/${fullName}/pulls/${prNumber}`
      : `https://github.com/${fullName}/pull/${prNumber}`,
  isForgejoRepo: (fullName: string) => mockForgejoRepos.has(fullName),
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockGh } = vi.hoisted(() => ({
  mockGh: {
    getPRMergeGate: vi.fn(),
    listHeldWorkflowRuns: vi.fn().mockResolvedValue([]),
    haveChecksSettled: vi.fn(),
    carriedForwardCheckStatus: vi.fn(),
    mergePR: vi.fn(),
    removeLabel: vi.fn(),
    getPRChangedFiles: vi.fn(),
    getPRDiff: vi.fn(),
    getPRMergeableState: vi.fn(),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    hasIgnoreLabel: vi.fn().mockReturnValue(false),
    isParked: vi.fn().mockReturnValue(false),
    isDispatchSkippable: vi.fn().mockReturnValue(false),
    isForkPR: vi.fn().mockReturnValue(false),
    isDependabotPR: vi.fn().mockImplementation((pr: { author: { login: string } }) =>
      pr.author.login === "dependabot[bot]" || pr.author.login === "app/dependabot",
    ),
    normalizeBotLogin: (login: string) => (login.startsWith("app/") ? `${login.slice(4)}[bot]` : login),
    isAllowedHumanActor: vi.fn(async (login: string) => login === "stjohnb"),
    populateQueueCache: vi.fn(),
    removeQueueItem: vi.fn(),
    getPRReviewStatus: vi.fn(),
    getPRHeadSHA: vi.fn(),
    infraPathsIn: vi.fn((f: string[]) => f.filter((p) => /(?:^|\/)(?:tofu|terraform)\/|\.tfvars?$|\.tf$/.test(p))),
    getPRBody: vi.fn().mockResolvedValue(""),
    closeIssue: vi.fn(),
    addLabel: vi.fn(),
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
    listMergedPRsForIssue: vi.fn().mockResolvedValue([]),
    getTofuPlanEvidence: vi.fn().mockResolvedValue({ plan: null, state: "unavailable", detail: "no plan comment" }),
    isCiExemptPath: vi.fn((p: string) => p.startsWith("docs/") || p.endsWith(".md") || p === "LICENSE"),
  },
}));

vi.mock("../github.js", () => mockGh);

const { mockClawsIssues } = vi.hoisted(() => ({
  mockClawsIssues: {
    getIssue: vi.fn(),
    primaryRepo: (repos: readonly string[]) => [...repos].sort()[0] ?? "",
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
vi.mock("../worker.js", () => ({
  AGENT_KINDS: {
    CI_FIXER: "ci-fixer",
    CI_FIXER_CONFLICT: "ci-fixer:conflict",
    REVIEW_ADDRESSER: "review-addresser",
    PR_REVIEWER: "pr-reviewer",
  },
}));

import { tryMerge, sweepRepo, isImagePinOnlyDiff, isApprovalExempt, isIdleAwaitingHuman, checkAutoBumpDiff, AWAITING_OPERATOR_MARKER } from "./auto-merger.js";
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
  checkStatus: "passing" | "failing" | "pending" | "held" | "none";
  checksTotal: number;
  checksHeld: number;
}

/**
 * An auto-bump PR with an image-pin-only diff. Auto-bump is approval-exempt and
 * is the only category that still reaches the check carry-forward branch (#2929):
 * dependabot, docs, ideas-collection and **Automerge** PRs all merge outright on
 * check status "none".
 *
 * Arms `getPRChangedFiles`/`getPRDiff` as a side effect — call it *before* arming
 * either of those mocks yourself, or this clobbers them.
 */
function autoBumpPR(files: string[] = ["apps/bonkus/deployment.yaml"]): ReturnType<typeof mockPR> {
  mockGh.getPRChangedFiles.mockResolvedValue(files);
  mockGh.getPRDiff.mockResolvedValue(imagePinDiff(files));
  return mockPR({ headRefName: "automation/bump-bonkus-1.2.3", labels: [{ name: "auto-bump" }] });
}

/** The `claws_prs` rows `tryMerge` reads, by PR number. A PR with none reads a plain, unapproved row. */
const prRows = new Map<number, db.ClawsPrRecord>();
function prRow(prNumber: number, over: Partial<db.ClawsPrRecord> = {}): db.ClawsPrRecord {
  return {
    repo: "test-org/test-repo", prNumber, issueId: null, phase: null, headSha: null, observedAt: null,
    stage: "awaiting-review", ciStatus: null, mergeableState: null, reviewVerdict: null, reviewedSha: null,
    mergeApprovedBy: null, mergeApprovedAt: null, manualActionReason: null, needsHumanReview: false,
    ciBlockedReason: null, title: null, dispatchNote: null, dispatchNoteAt: null, createdAt: "", updatedAt: "", ...over,
  };
}
/** Merge `over` into PR `prNumber`'s row. */
function setRow(prNumber: number, over: Partial<db.ClawsPrRecord>): void {
  prRows.set(prNumber, { ...(prRows.get(prNumber) ?? prRow(prNumber)), ...over });
}

beforeEach(() => {
  prRows.clear();
  // A body one test sets must not decide whether the next one's issue closes.
  mockGh.getPRBody.mockResolvedValue("");
  mockDb.getClawsPr.mockImplementation(async (_repo: string, n: number) => prRows.get(n) ?? prRow(n));
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

  it("merges dependabot PR when checks pass", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges dependabot PR with app/ login format", async () => {
    const pr = mockPR({ author: { login: "app/dependabot" } });
    mockMergeGate({ checkStatus: "passing" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges dependabot PR when no checks exist (app/ format)", async () => {
    const pr = mockPR({ author: { login: "app/dependabot" } });
    mockMergeGate({ checkStatus: "none" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
  });

  it("merges dependabot PR when no checks exist (bot format)", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockMergeGate({ checkStatus: "none" });

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
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockDb.getClawsPr.mockResolvedValueOnce(null);
    mockMergeGate({ checkStatus: "passing" });

    expect(await tryMerge(repo, pr)).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(mockGh.getPRMergeGate).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(`[auto-merger] ${repo.fullName}#${pr.number} skipped: no claws_prs row`);
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
  // reaches the merge through **Automerge**, which is allowlisted on status=none in its
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
    );
  });

  it("merges an approved non-Claws branch with no checks registered", async () => {
    const pr = approvedPR({ headRefName: "feature/x" });
    mockMergeGate({ checkStatus: "none" });
    // A non-exempt path: **Automerge** alone carries status=none here.
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
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: checks failed`,
    );
  });

  it("blocks a PR whose runs are held for approval as held, not as failing CI", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockMergeGate({ checkStatus: "held", checksTotal: 3, checksHeld: 2 });

    expect(await tryMerge(repo, pr)).toBe(false);

    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: 2 workflow runs held for approval`,
    );
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("checks failed"));
  });

  it("reports a held approved PR's block reason as held for approval", async () => {
    const pr = approvedPR();
    mockMergeGate({ checkStatus: "held", checksTotal: 1, checksHeld: 1 });

    expect(await tryMerge(repo, pr)).toBe(false);

    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(mockGh.setMergeBlockReason).toHaveBeenCalledWith(repo.fullName, pr.number, expect.stringContaining("1 workflow run on the head commit is held for approval"));
    expect(mockGh.setMergeBlockReason).not.toHaveBeenCalledWith(repo.fullName, pr.number, expect.stringContaining("CI is failing"));
  });

  it.each(["none", "passing"] as const)(
    "blocks a Dependabot PR whose held run is missing from the rollup (rollup %s)",
    async (checkStatus) => {
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ checkStatus, checksTotal: checkStatus === "passing" ? 1 : 0, checksHeld: 0 });
      mockGh.listHeldWorkflowRuns.mockResolvedValueOnce([{ run_id: 9, workflow_name: "CI", conclusion: "action_required" }]);

      expect(await tryMerge(repo, pr)).toBe(false);

      expect(mockGh.listHeldWorkflowRuns).toHaveBeenCalledWith(repo.fullName, HEAD_SHA);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        `[auto-merger] ${repo.fullName}#${pr.number} skipped: 1 workflow run held for approval`,
      );
    },
  );

  it("fails closed when it cannot verify held workflow runs", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
    mockMergeGate({ checkStatus: "passing", checksTotal: 1, checksHeld: 0 });
    mockGh.listHeldWorkflowRuns.mockRejectedValueOnce(new Error("boom"));

    expect(await tryMerge(repo, pr)).toBe(false);

    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("could not verify held workflow runs"));
  });

  it("does not re-check held runs on Forgejo", async () => {
    mockForgejoRepos.add(repo.fullName);
    try {
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ checkStatus: "passing", checksTotal: 1, checksHeld: 0 });

      expect(await tryMerge(repo, pr)).toBe(true);

      expect(mockGh.listHeldWorkflowRuns).not.toHaveBeenCalled();
    } finally {
      mockForgejoRepos.delete(repo.fullName);
    }
  });

  it("skips fork PRs (cross-repository)", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" }, isCrossRepository: true });
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

  it("removes no label after merging a Dependabot PR", async () => {
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

  it("skips PRs whose row records a manual action", async () => {
    const pr = mockPR();
    setRow(pr.number, { manualActionReason: "manual action" });
    mockGh.isForkPR.mockReturnValue(false);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("skipped: manual action recorded (manual action)"),
    );
  });

  it("ignores a forge Manual Action label the row does not record", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" }, labels: [{ name: "Manual Action" }] });
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
    expect(log.warn).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: auto-bump PR diff is not an image-pin-only bump`,
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
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: auto-bump PR touches non-bump files`,
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
    );
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

  describe("merge approval", () => {
    describe("on an approval-exempt PR adds no review gate", () => {
      const noReview = { status: "none", issueCount: 0, reviewedCommit: null };

      it("merges an approved Dependabot PR with no review on passing CI", async () => {
        const pr = approvedPR({ author: { login: "dependabot[bot]" } });
        mockGh.getPRReviewStatus.mockResolvedValue(noReview);
        mockMergeGate({ checkStatus: "passing" });

        expect(await tryMerge(repo, pr)).toBe(true);
        expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      });

      it("merges an approved Dependabot PR with no review and no checks on a settled head", async () => {
        const pr = approvedPR({ author: { login: "dependabot[bot]" } });
        mockGh.getPRReviewStatus.mockResolvedValue(noReview);
        mockMergeGate({ checkStatus: "none" });

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
          author: { login: "renovate[bot]" },
          body: "| Package | Update | Change |\n|---|---|---|\n| ollama | minor | `0.11.0` -> `0.12.0` |",
        });
        mockGh.getPRReviewStatus.mockResolvedValue(noReview);
        mockGh.getPRChangedFiles.mockResolvedValue(["apps/ollama/deployment.yaml"]);
        mockMergeGate({ checkStatus: "passing" });

        expect(await tryMerge(repo, pr)).toBe(false);
        expect(mockGh.mergePR).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith(
          `[auto-merger] ${repo.fullName}#${pr.number} skipped: trusted Renovate update but review status=none`,
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
      );
    });

    it("merges an approved PR with check status none once checks have settled", async () => {
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

    it("skips an approved PR when a manual action is also recorded", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
      setRow(pr.number, { manualActionReason: "set prod secrets" });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.getPRReviewStatus).not.toHaveBeenCalled();
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("skipped: manual action recorded"),
      );
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

    afterEach(() => {
      mockForgejoRepos.delete(repo.fullName);
    });

    it.each(["stjohnb", "renovate[bot]", "app/renovate"])(
      "merges a minor update authored by %s with no merge approval",
      async (login) => {
        const pr = renovatePR({ author: { login } });

        expect(await tryMerge(repo, pr)).toBe(true);
        expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      },
    );

    it("merges a minor update authored by the Forgejo renovate account on a Forgejo repo", async () => {
      mockForgejoRepos.add(repo.fullName);
      const pr = renovatePR({ author: { login: "renovate" } });

      expect(await tryMerge(repo, pr)).toBe(true);
    });

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
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("skipped: not approved"));
    });

    it("says the update type is unknown when the body has no Renovate table", async () => {
      expect(await tryMerge(repo, renovatePR({ body: "Bumps ollama." }))).toBe(false);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("update type unknown (body has no Renovate table)"));
    });

    it("keeps the generic reason for a labelled major", async () => {
      expect(await tryMerge(repo, renovatePR({ labels: [{ name: "major-update" }] }))).toBe(false);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("skipped: not approved — approve the merge from the Claws dashboard"));
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
      ["the renovate account on a GitHub repo", { author: { login: "renovate" } }],
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
      );
    });

    it("does not merge when the clean review is for an older head", async () => {
      const pr = renovatePR();
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "deadbee" });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(log.info).toHaveBeenCalledWith(
        `[auto-merger] ${repo.fullName}#${pr.number} skipped: trusted Renovate update but clean review is stale`,
      );
    });

    it("does not accept check status none, unlike Dependabot", async () => {
      const pr = renovatePR();
      mockMergeGate({ checkStatus: "none" });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("does not merge one touching tofu files", async () => {
      const pr = renovatePR();
      mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("infrastructure changes require a human merge"));
    });

    it("does not merge one with a manual action recorded", async () => {
      const pr = renovatePR();
      setRow(pr.number, { manualActionReason: "rotate keys" });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("does not merge one whose row needs human review", async () => {
      const pr = renovatePR();
      setRow(pr.number, { needsHumanReview: true });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("skipped: not approved"));
    });

    it("never reads the Automerge label: a non-Renovate PR carrying it does not merge", async () => {
      const pr = renovatePR({ headRefName: "claws/issue-42-ab12", author: { login: "stjohnb" } });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("skipped: not approved"));
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
      );
    });

    // The gate sits after the approval branch, so it fires for every approval-exempt
    // category too — nothing else covers the "outranks every exemption" half.
    it("does not merge an approval-exempt dependabot PR touching tofu files", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRChangedFiles.mockResolvedValue(["tofu/main.tf"]);

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("infrastructure changes require a human merge"),
      );
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

  describe("no-op Tofu plan exception for trusted dependency PRs", () => {
    const PIN_FILES = ["tofu/versions.tf", "tofu/.terraform.lock.hcl"];
    const NOOP = { plan: { add: 0, change: 0, replace: 0, destroy: 0 }, state: "noop", detail: "no-op plan" };

    /** A Dependabot provider bump: pin-only diff, green CI, clean review of the current head. */
    function dependabotPinPR(over: Parameters<typeof mockPR>[0] = {}): ReturnType<typeof mockPR> {
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc1234" });
      mockGh.getPRHeadSHA.mockResolvedValue(HEAD_SHA);
      mockGh.getPRChangedFiles.mockResolvedValue(PIN_FILES);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getTofuPlanEvidence.mockResolvedValue(NOOP);
      return mockPR({ author: { login: "dependabot[bot]" }, headRefName: "dependabot/terraform/tofu/aws-6.67.0", ...over });
    }

    it("merges a pin-only Dependabot PR whose verified plan is a no-op", async () => {
      const pr = dependabotPinPR();

      expect(await tryMerge(repo, pr)).toBe(true);
      expect(mockGh.getTofuPlanEvidence).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("no-op Tofu plan verified for head abc1234"));
    });

    it("does not merge when the plan shows a change", async () => {
      const pr = dependabotPinPR();
      mockGh.getTofuPlanEvidence.mockResolvedValue({ plan: { add: 0, change: 1, replace: 0, destroy: 0 }, state: "changes", detail: "plan shows 1 change" });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("infrastructure plan shows 1 change, human merge required"));
    });

    it.each([
      ["the plan run failed", "Tofu Plan run is failure"],
      ["the plan comment is for an older head", "plan comment predates the run for this head"],
    ])("does not merge when %s", async (_what, detail) => {
      const pr = dependabotPinPR();
      mockGh.getTofuPlanEvidence.mockResolvedValue({ plan: NOOP.plan, state: "unavailable", detail });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining(`infrastructure plan not available for head abc1234 (${detail})`));
    });

    it.each([
      ["a .tf resource file", "tofu/main.tf"],
      ["a workflow", ".github/workflows/tofu-plan-on-pr.yml"],
    ])("does not merge a pin bump that also touches %s, without reading the plan", async (_what, extra) => {
      const pr = dependabotPinPR();
      mockGh.getPRChangedFiles.mockResolvedValue([...PIN_FILES, extra]);

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.getTofuPlanEvidence).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("infrastructure changes require a human merge"));
    });

    it("does not merge a human-authored pin-only PR, even when approved", async () => {
      const pr = approvedPR({ headRefName: "claws/issue-42-ab12" });
      mockGh.getPRChangedFiles.mockResolvedValue(PIN_FILES);
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getTofuPlanEvidence.mockResolvedValue(NOOP);

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.getTofuPlanEvidence).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("infrastructure changes require a human merge"));
    });

    it("does not merge a Renovate major provider bump", async () => {
      const pr = dependabotPinPR({
        author: { login: "renovate[bot]" },
        headRefName: "renovate/major-hashicorp-aws",
        title: "chore(deps): update terraform aws to v7",
        labels: [],
      });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.getTofuPlanEvidence).not.toHaveBeenCalled();
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("requires a clean review of the current head for Dependabot too", async () => {
      const pr = dependabotPinPR();
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "none", issueCount: 0, reviewedCommit: null });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("no-op infra plan but review status=none"));
    });

    it("does not accept status=none for a no-op plan PR", async () => {
      const pr = dependabotPinPR();
      mockMergeGate({ checkStatus: "none", checksTotal: 0 });

      expect(await tryMerge(repo, pr)).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
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

    it("does not merge when the live dispatch guard rejects labels re-read at merge time", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" }, labels: [{ name: "Claws Staging" }] });
      mockMergeGate({ labels: [], checkStatus: "passing" });
      mockGh.isDispatchSkippable.mockReturnValueOnce(true);

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.isDispatchSkippable).toHaveBeenCalledWith(repo.fullName, { number: pr.number, labels: [] });
      expect(mockGh.mergePR).not.toHaveBeenCalled();
    });

    it("does not merge when the live rollup reports a failing (cancelled) check", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ checkStatus: "failing", checksTotal: 2 });

      const result = await tryMerge(repo, pr);

      expect(result).toBe(false);
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        `[auto-merger] ${repo.fullName}#${pr.number} skipped: checks failed`,
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

  // pr-dispatcher calls isApprovalExempt directly to decide whether a PR is close
  // enough to merging that advisory nits should be left alone; a Needs LGTM PR
  // is not, so it is handled like any other human-gated PR there.
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

    it("does not exempt an ideas-collection or Dependabot PR whose row needs human review", async () => {
      expect(await isApprovalExempt(repo.fullName, mockPR({ headRefName: "claws/ideas-collect-ab12" }), prRow(1, { needsHumanReview: true }))).toBe(false);
      expect(await isApprovalExempt(repo.fullName, mockPR({ author: { login: "dependabot[bot]" } }), prRow(1, { needsHumanReview: true }))).toBe(false);
      expect(await isApprovalExempt(repo.fullName, mockPR({ author: { login: "dependabot[bot]" } }), prRow(1))).toBe(true);
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

    it("is false for an approval-exempt PR (dependabot)", async () => {
      const pr = mockPR({ headRefOid: "abc123", author: { login: "dependabot[bot]" } });
      const row = prRow(1, { stage: "awaiting-merge", reviewedSha: "abc123", headSha: "abc123" });
      expect(await isIdleAwaitingHuman(repo.fullName, pr, row)).toBe(false);
    });

    it("is false for a trusted non-major Renovate PR (approval-exempt)", async () => {
      const pr = mockPR({
        headRefOid: "abc123",
        headRefName: "renovate/some-dep-1.x",
        author: { login: "renovate[bot]" },
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
      });

      it("accepts an end-of-list append with the comma fix", async () => {
        const diff = [pin(), cfgSection([`-      "^v2026-08-27\\\\.2$"`, `+      "^v2026-08-27\\\\.2$",`, `+      ${NEW}`])].join("\n");
        await expect(run(diff)).resolves.toEqual({ ok: true });
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
        });

        it("accepts a mid-list swap with trailing commas on both lines", async () => {
          await expect(run([swapPin(), cfgSection([`-      ${OLD},`, `+      ${SWAPPED},`])].join("\n"))).resolves.toEqual(ok);
        });

        it("rejects swapping an unrelated entry", async () => {
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
    expect(mockGh.setMergeBlockReason).toHaveBeenCalledWith(repo.fullName, pr.number, expect.stringContaining("not clean"));
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
    expect(mockGh.setMergeBlockReason).toHaveBeenCalledWith(repo.fullName, pr.number, expect.stringContaining("set prod secrets"));

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

  it("does not report on a dependabot PR with failing checks", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" } });
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

  it("does not report an approved PR when it cannot verify held workflow runs", async () => {
    mockMergeGate({ checkStatus: "passing", checksTotal: 1, checksHeld: 0 });
    mockGh.listHeldWorkflowRuns.mockRejectedValueOnce(new Error("boom"));

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
        expect(body).toContain("Every PR of the plan has merged. Operator step 3 remains");
        expect(body).toContain("1. Import the repo on Forgejo.");
        expect(body).toContain("claws-phase-done: 3");
        expect(body).toContain(AWAITING_OPERATOR_MARKER);
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
