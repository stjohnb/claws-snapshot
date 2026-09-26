import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

/** Full names the config mock should treat as Forgejo-hosted; per-test opt-in. */
const mockForgejoRepos = vi.hoisted(() => new Set<string>());
/** Off by default so existing tests are time-independent; the window tests turn it on. */
const mockUpdateWindow = vi.hoisted(() => ({ enabled: false, start: "22:00", end: "07:00", timezone: "Europe/London" }));
vi.mock("../config.js", async () => ({
  isClawsIssueId: (await vi.importActual<typeof import("../issue-id.js")>("../issue-id.js")).isClawsIssueId,
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    manualAction: "Manual Action",
    automerge: "Automerge",
    needsLgtm: "Needs LGTM",
  },
  prUrl: (fullName: string, prNumber: number) =>
    mockForgejoRepos.has(fullName)
      ? `https://git.example.com/${fullName}/pulls/${prNumber}`
      : `https://github.com/${fullName}/pull/${prNumber}`,
  get THIRD_PARTY_UPDATE_WINDOW() {
    return mockUpdateWindow;
  },
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
    populateQueueCache: vi.fn(),
    removeQueueItem: vi.fn(),
    getPRReviewStatus: vi.fn(),
    getPRHeadSHA: vi.fn(),
    infraPathsIn: vi.fn((f: string[]) => f.filter((p) => /(?:^|\/)(?:tofu|terraform)\/|\.tfvars?$|\.tf$/.test(p))),
    getPRBody: vi.fn().mockResolvedValue(""),
    closeIssue: vi.fn(),
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
      nextPhase: null, lastMergedPhase: 0, dependencies: new Map(), readyPhases: [], blockedPhases: [], openPhases, markerMismatches: [],
    },
  };
}
const mockLoadPhaseState = vi.hoisted(() => vi.fn());
// Defaults to a single-PR plan: `finalizeMergedClawsPR` skips the phase read
// entirely for it, so most tests never need to touch this mock at all.
const mockPeekTotalPhases = vi.hoisted(() => vi.fn(async () => ({ totalPhases: 1, stored: null })));
vi.mock("../planned-prs.js", () => ({ loadIssuePhaseState: mockLoadPhaseState, peekTotalPhases: mockPeekTotalPhases }));

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

import { tryMerge, sweepRepo, isImagePinOnlyDiff, isApprovalExempt, checkAutoBumpDiff } from "./auto-merger.js";
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

/**
 * A PR approved for merge. The **Automerge** label is the only approval
 * auto-merger accepts (#3135), and its gate also needs a clean Claws review of
 * the current head — so this mocks that review alongside building the PR.
 *
 * Arms `getPRReviewStatus`/`getPRHeadSHA` as a side effect — call it *before*
 * arming either of those mocks yourself, or this clobbers them.
 */
function approvedPR(over: Parameters<typeof mockPR>[0] = {}): ReturnType<typeof mockPR> {
  mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc1234" });
  mockGh.getPRHeadSHA.mockResolvedValue(HEAD_SHA);
  return mockPR({ ...over, labels: [...(over.labels ?? []), { name: "Automerge" }] });
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

  describe("out-of-hours window for third-party updates", () => {
    beforeEach(() => {
      mockUpdateWindow.enabled = true;
      vi.useFakeTimers({ toFake: ["Date"] });
      // 14:00 BST — outside 22:00–07:00 Europe/London.
      vi.setSystemTime(new Date("2026-09-24T13:00:00Z"));
    });
    afterEach(() => {
      mockUpdateWindow.enabled = false;
      vi.useRealTimers();
    });

    it("does not merge a Dependabot PR outside the window, and posts no merge-block comment", async () => {
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ checkStatus: "passing" });

      expect(await tryMerge(repo, pr)).toBe(false);

      expect(mockGh.getPRMergeGate).not.toHaveBeenCalled();
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(mockGh.setMergeBlockReason).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("outside the out-of-hours window (22:00–07:00 Europe/London)"));
    });

    it("merges the same Dependabot PR inside the window", async () => {
      vi.setSystemTime(new Date("2026-09-24T22:30:00Z"));
      const pr = mockPR({ author: { login: "dependabot[bot]" } });
      mockMergeGate({ checkStatus: "passing" });

      await tryMerge(repo, pr);

      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    });

    it("still merges an auto-bump PR outside the window", async () => {
      const pr = autoBumpPR();
      mockMergeGate({ checkStatus: "passing" });

      await tryMerge(repo, pr);

      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    });
  });

  it("merges an Automerge Claws PR when checks pass", async () => {
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

  it("does not merge a green, cleanly-reviewed Claws PR that has no Automerge label (#3135)", async () => {
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
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — apply the Automerge label`,
    );
  });

  it("ignores a bare LGTM comment on an unapproved PR (#3135)", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42-ab12" });
    mockMergeGate({ checkStatus: "passing" });
    mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: "LGTM", body_html: "", login: "clawsstjohn[bot]" }]);

    expect(await tryMerge(repo, pr)).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — apply the Automerge label`,
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
  it("merges an Automerge PR on a settled head with no checks registered (#3051)", async () => {
    const pr = approvedPR({ headRefName: "claws/issue-42" });
    mockMergeGate({ checkStatus: "none" });
    mockGh.getPRChangedFiles.mockResolvedValue([".agents/issue-refiner.md"]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(true);
    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.carriedForwardCheckStatus).not.toHaveBeenCalled();
  });

  it("skips an Automerge PR with no checks when the head has not settled", async () => {
    const pr = approvedPR({ headRefName: "claws/issue-42" });
    mockMergeGate({ checkStatus: "none" });
    mockGh.getPRChangedFiles.mockResolvedValue([".agents/issue-refiner.md"]);
    mockGh.haveChecksSettled.mockResolvedValue({ settled: false, age: "30s" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
  });

  it("skips a PR with no Automerge label at the approval gate, before checked files matter", async () => {
    const pr = mockPR({ headRefName: "claws/issue-42" });
    mockMergeGate({ checkStatus: "none" });
    mockGh.getPRChangedFiles.mockResolvedValue([".agents/issue-refiner.md"]);

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — apply the Automerge label`,
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

  it("skips any PR with no Automerge label", async () => {
    const pr = mockPR({ author: { login: "someuser" }, headRefName: "feature-branch" });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — apply the Automerge label`,
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

  it("does not require Automerge for doc PRs", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockMergeGate({ checkStatus: "none" });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.getPRReviewStatus).not.toHaveBeenCalled();
  });

  it("requires Automerge on a doc PR carrying Needs LGTM (#3124)", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12", labels: [{ name: "Needs LGTM" }] });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockMergeGate({ checkStatus: "passing", labels: ["Needs LGTM"] });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — apply the Automerge label`,
    );
  });

  it("requires Automerge when Needs LGTM is only on the live labels (#3124)", async () => {
    const pr = mockPR({ headRefName: "claws/docs-ab12" });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockMergeGate({ checkStatus: "passing", labels: ["Needs LGTM"] });

    const result = await tryMerge(repo, pr);

    expect(result).toBe(false);
    expect(mockGh.mergePR).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — apply the Automerge label`,
    );
  });

  it("merges a Needs LGTM doc PR once a human applies Automerge (#3124)", async () => {
    const pr = approvedPR({ headRefName: "claws/docs-ab12", labels: [{ name: "Needs LGTM" }] });
    mockGh.getPRChangedFiles.mockResolvedValue(["docs/OVERVIEW.md"]);
    mockMergeGate({ checkStatus: "passing", labels: ["Needs LGTM"] });

    await tryMerge(repo, pr);

    expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
  });

  it("merges the same doc PR with no Needs LGTM label and no Automerge (#3124)", async () => {
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

  it("does not require Automerge for idea-collection PRs", async () => {
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

  it("merges auto-bump PR without Automerge when checks pass and files are deployment-only", async () => {
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

  it("requires Automerge for PR with auto-bump and major-update labels", async () => {
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
      `[auto-merger] ${repo.fullName}#${pr.number} skipped: not approved — apply the Automerge label`,
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

  describe("Automerge label", () => {
    it("merges a claws issue PR carrying Automerge when review is clean and reviewedCommit prefixes HEAD", async () => {
      const pr = mockPR({ headRefName: "claws/issue-42-ab12", labels: [{ name: "Automerge" }] });
      mockMergeGate({ checkStatus: "passing" });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
      expect(mockGh.removeQueueItem).toHaveBeenCalledWith(repo.fullName, pr.number);
    });

    it("merges a PR carrying both Automerge and Needs LGTM (#3124)", async () => {
      const pr = mockPR({
        headRefName: "claws/issue-42-ab12",
        labels: [{ name: "Automerge" }, { name: "Needs LGTM" }],
      });
      mockMergeGate({ checkStatus: "passing", labels: ["Automerge", "Needs LGTM"] });
      mockGh.getPRReviewStatus.mockResolvedValue({ status: "clean", issueCount: 0, reviewedCommit: "abc123" });
      mockGh.getPRHeadSHA.mockResolvedValue("abc1234567");

      const result = await tryMerge(repo, pr);

      expect(result).toBe(true);
      expect(mockGh.mergePR).toHaveBeenCalledWith(repo.fullName, pr.number, HEAD_SHA);
    });

    it.each(["issues", "escalated", "none"] as const)(
      "skips Automerge PR when review status is %s",
      async (status) => {
        const pr = mockPR({ headRefName: "claws/issue-42-ab12", labels: [{ name: "Automerge" }] });
        mockGh.getPRReviewStatus.mockResolvedValue({ status, issueCount: 0, reviewedCommit: status === "none" ? null : "abc123" });

        const result = await tryMerge(repo, pr);

        expect(result).toBe(false);
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
      expect(mockGh.mergePR).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("skipped: Manual Action"),
      );
    });
  });

  describe("infra (tofu/terraform) gate (#2275)", () => {
    it("does not merge an Automerge-labelled PR with a clean, fresh review that touches tofu files", async () => {
      const pr = mockPR({ headRefName: "claws/issue-42-ab12", labels: [{ name: "Automerge" }] });
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
    it("exempts a plain docs PR", () => {
      expect(isApprovalExempt(mockPR({ headRefName: "claws/docs-ab12" }), undefined)).toBe(true);
    });

    it("does not exempt a docs PR carrying Needs LGTM", () => {
      expect(isApprovalExempt(mockPR({ headRefName: "claws/docs-ab12", labels: [{ name: "Needs LGTM" }] }), undefined)).toBe(false);
    });

    it("does not exempt a docs PR whose live labels carry Needs LGTM", () => {
      expect(isApprovalExempt(mockPR({ headRefName: "claws/docs-ab12" }), ["Needs LGTM"])).toBe(false);
    });

    it("does not exempt an ideas-collection PR carrying Needs LGTM", () => {
      expect(isApprovalExempt(mockPR({ headRefName: "claws/ideas-collect-ab12", labels: [{ name: "Needs LGTM" }] }), undefined)).toBe(false);
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

  it("posts one comment when Automerge is set but the review is not clean", async () => {
    const pr = mockPR({ labels: [{ name: "Automerge" }] });
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

  it("does not report an Automerge PR whose review status is still none", async () => {
    const pr = mockPR({ labels: [{ name: "Automerge" }] });
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

    it("skips the phase read entirely for a single-PR plan", async () => {
      // Default `mockPeekTotalPhases` — totalPhases: 1 — so `finalizeMergedClawsPR`
      // never calls `loadIssuePhaseState` at all: the ordinary case costs no
      // forge read beyond the merge itself, restoring the pre-multi-PR behaviour.
      await tryMerge(repo, prFor(NATIVE));

      expect(mockLoadPhaseState).not.toHaveBeenCalled();
    });
  });

});
