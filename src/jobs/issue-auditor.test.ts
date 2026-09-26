import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockIssue } from "../test-helpers.js";

const mockConfig = vi.hoisted(() => ({
  isAgentDisabled: vi.fn().mockReturnValue(false),
  isJobDisabledForRepo: vi.fn().mockReturnValue(false),
}));

vi.mock("../config.js", async () => ({
  isClawsIssueId: (await vi.importActual<typeof import("../issue-id.js")>("../issue-id.js")).isClawsIssueId,
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    problematic: "Claws Problematic",
    manualAction: "Manual Action",
    needsLgtm: "Needs LGTM",
    billing: "Billing",
    automerge: "Automerge",
  },
  SELF_REPO: "org/claws",
  isAgentDisabled: mockConfig.isAgentDisabled,
  isJobDisabledForRepo: mockConfig.isJobDisabledForRepo,
}));

const mockAlerts = vi.hoisted(() => ({
  upsertAlertIssue: vi.fn(),
  closeAlertIssueIfResolved: vi.fn(),
}));
vi.mock("../occurrence-tracking.js", () => mockAlerts);

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
    listOpenIssues: vi.fn(),
    getSelfLogin: vi.fn(),
    getSelfLoginForRepo: vi.fn(),
    getSelfLoginForIssue: vi.fn(),
    getOpenPRForIssue: vi.fn(),
    getCommentReactions: vi.fn(),
    getIssueComments: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    closeIssue: vi.fn(),
    isClawsComment: (body: string) => /\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/.test(body) || body.includes("<!-- claws-automated -->"),
    isRateLimited: vi.fn().mockReturnValue(false),
    isItemSkipped: vi.fn().mockReturnValue(false),
    isAllowedActor: vi.fn().mockResolvedValue(true),
    hasIgnoreLabel: vi.fn().mockReturnValue(false),
    isParked: vi.fn().mockReturnValue(false),
    listMergedPRsForIssue: vi.fn(),
    listPRs: vi.fn(),
    invalidatePRList: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGh);
const mockDb = vi.hoisted(() => ({ markRepoProcessedDaily: vi.fn(), listClawsPrs: vi.fn() }));
vi.mock("../db.js", () => mockDb);
vi.mock("../smart-schedule.js", () => ({
  localDateString: () => "2024-01-15",
  withDailyRepoMarking: async (jobName: string, repoFullName: string, fn: () => Promise<unknown>, onError?: (err: unknown) => unknown) => {
    try {
      return await fn();
    } catch (err) {
      if (!onError) throw err;
      return onError(err);
    } finally {
      mockDb.markRepoProcessedDaily(jobName, repoFullName, "2024-01-15");
    }
  },
}));

vi.mock("./triage-claws-errors.js", () => ({
  extractFingerprint: vi.fn().mockReturnValue(null),
  REPORT_HEADER: "## Claws Error Investigation Report",
}));

const mockFindPlanComment = vi.hoisted(() => vi.fn());
const mockParsePlan = vi.hoisted(() => vi.fn());
vi.mock("../plan-parser.js", () => ({
  findPlanComment: mockFindPlanComment,
  parsePlan: mockParsePlan,
}));

const mockLoadStored = vi.hoisted(() => vi.fn());
const mockLoadPhaseState = vi.hoisted(() => vi.fn());
vi.mock("../planned-prs.js", () => ({
  loadStoredPlannedPRs: mockLoadStored,
  loadIssuePhaseState: mockLoadPhaseState,
}));

import { run, processRepo, classifyIssue, auditIssue, auditPrStore } from "./issue-auditor.js";
import { reportError } from "../error-reporter.js";
import * as db from "../db.js";
import { extractFingerprint } from "./triage-claws-errors.js";
import * as log from "../log.js";

describe("issue-auditor", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.getSelfLogin.mockResolvedValue("claws-bot[bot]");
    mockGh.getSelfLoginForRepo.mockResolvedValue("claws-bot[bot]");
    mockGh.getSelfLoginForIssue.mockResolvedValue("claws-bot[bot]");
    mockGh.getOpenPRForIssue.mockResolvedValue(null);
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.closeIssue.mockResolvedValue(undefined);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);
    mockGh.listPRs.mockResolvedValue([]);
    mockDb.listClawsPrs.mockResolvedValue([]);
    mockAlerts.upsertAlertIssue.mockResolvedValue("created");
    mockAlerts.closeAlertIssueIfResolved.mockResolvedValue(null);
    mockGh.isRateLimited.mockReturnValue(false);
    mockFindPlanComment.mockReturnValue(null);
    mockParsePlan.mockReturnValue({ preamble: "", phases: [], totalPhases: 0 });
    mockLoadStored.mockResolvedValue(null);
    vi.mocked(extractFingerprint).mockReturnValue(null);
  });

  it("skips issues with Refined label", async () => {
    const issue = mockIssue({ labels: [{ name: "Refined" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  // An open PR is read from the PR store, not a label: in-progress only
  // keeps the auditor from adding Ready.
  it("labels nothing for an in-progress issue", async () => {
    const issue = mockIssue();
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getOpenPRForIssue.mockResolvedValueOnce({ number: 10, headRefName: "claws/issue-1-ab12" });

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("skips [claws-error] issues without investigation report", async () => {
    const issue = mockIssue({ title: "[claws-error] something" });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    vi.mocked(extractFingerprint).mockReturnValue("something");
    mockGh.getIssueComments.mockResolvedValue([]);

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("skips issues with no plan (needs refinement)", async () => {
    const issue = mockIssue();
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([]);

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("skips issues with unreacted human feedback", async () => {
    const issue = mockIssue();
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "*— Automated by Claws —*\n\n## Implementation Plan\nDo something", login: "claws-bot[bot]" },
      { id: 101, body: "I think we should change the approach", login: "human-user" },
    ]);
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("adds Ready label when plan exists, all feedback addressed, label missing", async () => {
    const issue = mockIssue({ labels: [] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "*— Automated by Claws —*\n\n## Implementation Plan\nDo something", login: "claws-bot[bot]" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);

    const fixes = await processRepo(repo);

    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    expect(fixes).toHaveLength(1);
    expect(fixes).toContainEqual(expect.stringMatching(/added Ready to/));
  });

  // A backlog issue is parked (#3293): the auditor must not re-add Ready to a
  // planned one, or it would drift back onto the board's Awaiting plan review.
  it("skips a Backlog issue before classifying it, even with a plan", async () => {
    const issue = mockIssue({ labels: [{ name: "Backlog" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.isParked.mockImplementation((labels: { name: string }[]) => labels.some((l) => l.name === "Backlog"));
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "*— Automated by Claws —*\n\n## Implementation Plan\nDo something", login: "claws-bot[bot]" },
    ]);

    await run([repo]);

    expect(mockGh.getIssueComments).not.toHaveBeenCalled();
    expect(mockGh.addLabel).not.toHaveBeenCalled();
    mockGh.isParked.mockReturnValue(false);
  });

  it("does not add Ready when already present", async () => {
    const issue = mockIssue({ labels: [{ name: "Ready" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "*— Automated by Claws —*\n\n## Implementation Plan\nDo something", login: "claws-bot[bot]" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("adds Ready label for stuck multi-phase issues", async () => {
    const issue = mockIssue({ labels: [] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "*— Automated by Claws —*\n\n## Implementation Plan\n### PR 1: First\nDo first\n### PR 2: Second\nDo second", login: "claws-bot[bot]" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([
      { number: 20, title: "fix: First (1/2)", headRefName: "claws/issue-1-ab12" },
    ]);
    mockFindPlanComment.mockReturnValue("## Implementation Plan\n### PR 1: First\nDo first\n### PR 2: Second\nDo second");
    mockParsePlan.mockReturnValue({
      preamble: "",
      phases: [
        { phaseNumber: 1, title: "First", description: "Do first" },
        { phaseNumber: 2, title: "Second", description: "Do second" },
      ],
      totalPhases: 2,
    });

    const fixes = await processRepo(repo);

    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    expect(fixes).toContainEqual(expect.stringMatching(/stuck multi-phase/));
  });

  it("closes completed multi-phase issue via content-based phase matching", async () => {
    const issue = mockIssue({ labels: [] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "*— Automated by Claws —*\n\n## Implementation Plan\n### PR 1: First\nDo first\n### PR 2: Second\nDo second", login: "claws-bot[bot]" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([
      { number: 20, title: "fix: First (1/2)", headRefName: "claws/issue-1-ab12" },
      { number: 21, title: "fix: Second (2/2)", headRefName: "claws/issue-1-cd34" },
    ]);
    mockFindPlanComment.mockReturnValue("## Implementation Plan\n### PR 1: First\nDo first\n### PR 2: Second\nDo second");
    mockParsePlan.mockReturnValue({
      preamble: "",
      phases: [
        { phaseNumber: 1, title: "First", description: "Do first" },
        { phaseNumber: 2, title: "Second", description: "Do second" },
      ],
      totalPhases: 2,
    });

    const fixes = await processRepo(repo);

    expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, issue.number, "completed");
    expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    expect(fixes).toContainEqual(expect.stringMatching(/closed completed multi-phase/));
  });

  it("closes completed multi-phase issue with legacy ref-in-title PRs", async () => {
    const issue = mockIssue({ labels: [] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "*— Automated by Claws —*\n\n## Implementation Plan\n### PR 1: First\nDo first\n### PR 2: Second\nDo second", login: "claws-bot[bot]" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([
      { number: 20, title: "fix(#1): First (1/2)", headRefName: "claws/issue-1-ab12" },
      { number: 21, title: "fix(#1): Second (2/2)", headRefName: "claws/issue-1-cd34" },
    ]);
    mockFindPlanComment.mockReturnValue("## Implementation Plan\n### PR 1: First\nDo first\n### PR 2: Second\nDo second");
    mockParsePlan.mockReturnValue({
      preamble: "",
      phases: [
        { phaseNumber: 1, title: "First", description: "Do first" },
        { phaseNumber: 2, title: "Second", description: "Do second" },
      ],
      totalPhases: 2,
    });

    const fixes = await processRepo(repo);

    expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, issue.number, "completed");
    expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    expect(fixes).toContainEqual(expect.stringMatching(/closed completed multi-phase/));
  });

  it("closes completed multi-phase issue via fallback counting (no phase patterns in titles)", async () => {
    const issue = mockIssue({ labels: [] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "*— Automated by Claws —*\n\n## Implementation Plan\n### PR 1: First\nDo first\n### PR 2: Second\nDo second", login: "claws-bot[bot]" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([
      { number: 20, title: "fix: First phase", headRefName: "claws/issue-1-ab12" },
      { number: 21, title: "fix: Second phase", headRefName: "claws/issue-1-cd34" },
    ]);
    mockFindPlanComment.mockReturnValue("## Implementation Plan\n### PR 1: First\nDo first\n### PR 2: Second\nDo second");
    mockParsePlan.mockReturnValue({
      preamble: "",
      phases: [
        { phaseNumber: 1, title: "First", description: "Do first" },
        { phaseNumber: 2, title: "Second", description: "Do second" },
      ],
      totalPhases: 2,
    });

    const fixes = await processRepo(repo);

    expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, issue.number, "completed");
    expect(fixes).toContainEqual(expect.stringMatching(/closed completed multi-phase/));
  });

  it("classifies no-body issues as needs-refinement (not skipped)", async () => {
    const issue = mockIssue({ body: "" });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([]);

    await run([repo]);

    // No plan exists, so it's needs-refinement — no label added, no warning
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("returns the applied fixes", async () => {
    const issue = mockIssue({ labels: [] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "*— Automated by Claws —*\n\n## Implementation Plan\nDo something", login: "claws-bot[bot]" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);

    const fixes = await processRepo(repo);

    expect(fixes.length).toBeGreaterThan(0);
  });

  it("returns no fixes when everything is clean", async () => {
    mockGh.listOpenIssues.mockResolvedValueOnce([]);

    expect(await processRepo(repo)).toEqual([]);
  });

  it("marks repo processed after run", async () => {
    await run([repo]);
    expect(vi.mocked(db.markRepoProcessedDaily)).toHaveBeenCalledWith(
      "issue-auditor", repo.fullName, "2024-01-15"
    );
  });

  it("marks repo processed even when rate-limited", async () => {
    mockGh.isRateLimited.mockReturnValue(true);
    await processRepo(repo);
    expect(vi.mocked(db.markRepoProcessedDaily)).toHaveBeenCalledWith(
      "issue-auditor", repo.fullName, "2024-01-15",
    );
  });

  it("marks repo processed even when listOpenIssues throws", async () => {
    mockGh.listOpenIssues.mockRejectedValueOnce(new Error("API failure"));
    await processRepo(repo);
    expect(vi.mocked(db.markRepoProcessedDaily)).toHaveBeenCalledWith(
      "issue-auditor", repo.fullName, "2024-01-15",
    );
  });

  it("per-repo error isolation — failure on one repo does not block others", async () => {
    const repo1 = mockRepo({ fullName: "org/repo1", name: "repo1" });
    const repo2 = mockRepo({ fullName: "org/repo2", name: "repo2" });
    const issue2 = mockIssue({ labels: [] });

    mockGh.listOpenIssues
      .mockRejectedValueOnce(new Error("API failure"))
      .mockResolvedValueOnce([issue2]);

    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "*— Automated by Claws —*\n\n## Implementation Plan\nDo something", login: "claws-bot[bot]" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);

    await run([repo1, repo2]);

    expect(reportError).toHaveBeenCalledWith("issue-auditor:audit-repo", "org/repo1", expect.any(Error), { repo: "org/repo1" });
    expect(mockGh.addLabel).toHaveBeenCalledWith("org/repo2", issue2.number, "Ready");
  });

  describe("classifyIssue", () => {
    it("returns refined for issues with Refined label", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      expect(await classifyIssue(repo, issue)).toBe("refined");
    });

    it("returns in-progress for issues with open PR", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValueOnce({ number: 10 });
      expect(await classifyIssue(repo, issue)).toBe("in-progress");
    });

    it("returns needs-refinement for issues with no body", async () => {
      const issue = mockIssue({ body: "" });
      mockGh.getIssueComments.mockResolvedValue([]);
      expect(await classifyIssue(repo, issue)).toBe("needs-refinement");
    });

    it("returns needs-triage for claws-error without report", async () => {
      const issue = mockIssue({ title: "[claws-error] test" });
      vi.mocked(extractFingerprint).mockReturnValue("test");
      mockGh.getIssueComments.mockResolvedValue([]);
      expect(await classifyIssue(repo, issue)).toBe("needs-triage");
    });

    it("returns needs-refinement for issues with no plan", async () => {
      const issue = mockIssue();
      mockGh.getIssueComments.mockResolvedValue([]);
      expect(await classifyIssue(repo, issue)).toBe("needs-refinement");
    });

    it("returns ready when plan exists and no pending feedback", async () => {
      const issue = mockIssue();
      mockGh.getIssueComments.mockResolvedValue([
        { id: 100, body: "*— Automated by Claws —*\n\n## Implementation Plan\nDo something", login: "claws-bot[bot]" },
      ]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      expect(await classifyIssue(repo, issue)).toBe("ready");
    });

    it("returns needs-refinement for a mid-flight comment posted before the plan comment lands (#2524)", async () => {
      // Comment 150 landed while the planner was running, so GitHub orders it before
      // the plan comment (id 500) even though it was posted after the run started —
      // a raw "after the plan" slice would miss it and misclassify this as ready.
      const issue = mockIssue();
      mockGh.getIssueComments.mockResolvedValue([
        { id: 100, body: "earlier comment", login: "reviewer" },
        { id: 150, body: "human feedback mid-flight", login: "reviewer" },
        {
          id: 500,
          body: "*— Automated by Claws —*\n\n## Implementation Plan\nDo something\n\nCLAWS_PLAN_LAST_COMMENT: 100",
          login: "claws-bot[bot]",
        },
      ]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      expect(await classifyIssue(repo, issue)).toBe("needs-refinement");
    });
  });

  // A forge closes its own issues on `Closes #N`; a hand-merged PR leaves a
  // native issue open, so the auditor closes it (#3215).
  describe("native issue completion", () => {
    const NATIVE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    const PLAN_COMMENT = { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC", body: "*— Automated by Claws —*\n\n## Implementation Plan\nDo something", login: "claws" };

    it("closes a native issue whose claws/issue-<id> PR merged with Closes #<id>", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [] });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValue([PLAN_COMMENT]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        { number: 7, headRefName: `claws/issue-${NATIVE}-thing`, body: `Closes #${NATIVE.toLowerCase()}` },
      ]);

      expect(await classifyIssue(repo, issue)).toBe("done-native");

      await run([repo]);

      expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, NATIVE, "completed");
      expect(mockGh.removeLabel).not.toHaveBeenCalled();
    });

    it("leaves a native issue open when the merged PR does not close it", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [] });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValue([PLAN_COMMENT]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        { number: 7, headRefName: `claws/issue-${NATIVE}-thing`, body: `Part of #${NATIVE}` },
      ]);

      await run([repo]);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    it("does not close a forge issue on the same signal — the forge owns that", async () => {
      const issue = mockIssue({ number: 42, labels: [] });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValue([PLAN_COMMENT]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        { number: 7, headRefName: "claws/issue-42-thing", body: "Closes #42" },
      ]);

      await run([repo]);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    it("never fires while an open PR is in flight", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [] });
      mockGh.getOpenPRForIssue.mockResolvedValue({ number: 7 });
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        { number: 6, headRefName: `claws/issue-${NATIVE}-thing`, body: `Closes #${NATIVE}` },
      ]);

      expect(await classifyIssue(repo, issue)).toBe("in-progress");
    });

    it("never fires from needs-refinement — unaddressed feedback wins", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [] });
      mockGh.getIssueComments.mockResolvedValue([
        PLAN_COMMENT,
        { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDD", body: "please also do X", login: "stjohnb" },
      ]);
      mockGh.getCommentReactions.mockResolvedValue([]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        { number: 7, headRefName: `claws/issue-${NATIVE}-thing`, body: `Closes #${NATIVE}` },
      ]);

      expect(await classifyIssue(repo, issue)).toBe("needs-refinement");
    });

    it("never fires from stuck-multi-phase — the phase accounting owns that", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [] });
      mockGh.getIssueComments.mockResolvedValue([PLAN_COMMENT]);
      mockFindPlanComment.mockReturnValue("## Implementation Plan\nplan");
      mockParsePlan.mockReturnValue({ preamble: "", phases: ["a", "b", "c"], totalPhases: 3 });
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        { number: 7, title: "x (1/3)", headRefName: `claws/issue-${NATIVE}-thing`, body: `Closes #${NATIVE}` },
      ]);

      expect(await classifyIssue(repo, issue)).toBe("stuck-multi-phase");
    });

    it("never fires from ready — with no merged PR there is nothing to close on", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [] });
      mockGh.getIssueComments.mockResolvedValue([PLAN_COMMENT]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);

      expect(await classifyIssue(repo, issue)).toBe("ready");
    });

    it("auditIssue leaves a parked issue alone", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [{ name: "Blocked" }] });
      mockGh.isParked.mockReturnValueOnce(true);

      expect(await auditIssue(repo, issue)).toEqual([]);
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    // A PR closed unmerged: the daily audit puts the issue back in Awaiting plan review.
    it("auditIssue moves an issue with no open or merged PR back to Ready", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [] });
      mockGh.getIssueComments.mockResolvedValue([PLAN_COMMENT]);

      const fixes = await auditIssue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, NATIVE, "Ready");
      expect(mockGh.closeIssue).not.toHaveBeenCalled();
      expect(fixes).toEqual([`added Ready to ${repo.fullName}#${NATIVE}`]);
    });
  });

  // A multi-repo plan's step opens its PR in its own repo, which the issue
  // repo's branch-prefix lookups cannot see; the stored list's coverage can.
  describe("stored multi-repo PR list", () => {
    const NATIVE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    const PLAN_COMMENT = { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC", body: "*— Automated by Claws —*\n\n## Implementation Plan\nDo something", login: "claws" };
    const entries = [
      { position: 1, repo: "test-org/test-repo", title: "Primary step", prNumber: 5 },
      { position: 2, repo: "test-org/other-repo", title: "Other step", prNumber: 9 },
    ];
    const phaseState = (done: number[], openPhases: number[]) => ({
      totalPhases: 2,
      entries,
      trackerId: NATIVE,
      coverage: { totalPhases: 2, covered: new Set([...done, ...openPhases]), done: new Set(done), coveringPRs: new Map(), nextPhase: null, lastMergedPhase: 0, dependencies: new Map(), readyPhases: [], blockedPhases: [], openPhases, markerMismatches: [] },
    });

    beforeEach(() => {
      mockGh.getIssueComments.mockResolvedValue([PLAN_COMMENT]);
      mockLoadStored.mockResolvedValue({ trackerId: NATIVE, entries });
    });

    it("does not add Ready while a PR in another repo is open", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [] });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockLoadPhaseState.mockResolvedValue(phaseState([], [1]));

      expect(await classifyIssue(repo, issue)).toBe("in-progress");

      await run([repo]);

      expect(mockGh.removeLabel).not.toHaveBeenCalled();
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("is in progress when step 1 merged and step 2's PR is open in another repo", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [] });
      mockGh.listMergedPRsForIssue.mockResolvedValue([{ number: 5, title: "x (1/2)", body: "" }]);
      mockLoadPhaseState.mockResolvedValue(phaseState([1], [2]));

      expect(await classifyIssue(repo, issue)).toBe("in-progress");
    });

    // A parallel plan: step 2 is open while step 1 has not even started. The
    // lowest uncovered step is below the open one, so only `openPhases` sees it.
    it("is in progress with an open step above an uncovered one", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [] });
      mockLoadPhaseState.mockResolvedValue({ ...phaseState([], [2]), coverage: { ...phaseState([], [2]).coverage, nextPhase: 1, readyPhases: [1] } });

      expect(await classifyIssue(repo, issue)).toBe("in-progress");
    });

    it("is done when every step merged, even with nothing merged in the issue repo", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [] });
      mockLoadPhaseState.mockResolvedValue(phaseState([1, 2], []));

      expect(await classifyIssue(repo, issue)).toBe("done");
    });

    it("needs refinement, not done, when every step merged but a human comment is unanswered", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [] });
      mockGh.getIssueComments.mockResolvedValue([
        PLAN_COMMENT,
        { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDD", body: "this still doesn't work", login: "human" },
      ]);
      mockLoadPhaseState.mockResolvedValue(phaseState([1, 2], []));

      expect(await classifyIssue(repo, issue)).toBe("needs-refinement");
    });

    it("leaves a single-step stored list to the done-native check", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [] });
      mockLoadStored.mockResolvedValue({ trackerId: NATIVE, entries: [entries[0]] });
      mockLoadPhaseState.mockResolvedValue({ ...phaseState([1], []), totalPhases: 1, entries: [entries[0]] });
      // Merged, but its body never says it closes the issue.
      mockGh.listMergedPRsForIssue.mockResolvedValue([{ number: 5, title: "Primary step", body: "" }]);

      expect(await classifyIssue(repo, issue)).not.toMatch(/^done/);
    });

    it("skips the coverage load for a same-repo list with nothing merged", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [] });
      mockLoadStored.mockResolvedValue({ trackerId: NATIVE, entries: [entries[0], { ...entries[1], repo: "test-org/test-repo" }] });

      expect(await classifyIssue(repo, issue)).toBe("ready");
      expect(mockLoadPhaseState).not.toHaveBeenCalled();
    });

    it("is stuck between steps when only another repo's step has merged", async () => {
      const issue = mockIssue({ number: NATIVE, labels: [] });
      mockLoadPhaseState.mockResolvedValue(phaseState([2], []));

      expect(await classifyIssue(repo, issue)).toBe("stuck-multi-phase");
    });
  });

});

describe("issue-auditor — PR store comparison", () => {
  const repo = mockRepo();
  const row = (prNumber: number, overrides: Record<string, unknown> = {}) => ({
    repo: repo.fullName, prNumber, issueId: null, phase: null, headSha: null, observedAt: null,
    stage: "awaiting-review", ciStatus: null, mergeableState: null, reviewVerdict: null, reviewedSha: null,
    mergeApprovedBy: null, mergeApprovedAt: null, manualActionReason: null, needsHumanReview: false,
    ciBlockedReason: null, createdAt: "", updatedAt: "", ...overrides,
  });
  const pr = (number: number, labels: string[]) => ({ number, labels: labels.map((name) => ({ name })) });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAlerts.upsertAlertIssue.mockResolvedValue("created");
    mockAlerts.closeAlertIssueIfResolved.mockResolvedValue(null);
  });

  it("returns [] and closes the alert when every row agrees", async () => {
    mockGh.listPRs.mockResolvedValue([pr(1, ["Ready", "Priority"]), pr(2, [])]);
    mockDb.listClawsPrs.mockResolvedValue([row(1, { stage: "awaiting-merge" }), row(2)]);
    expect(await auditPrStore(repo)).toEqual([]);
    // The raw forge listing, never the façade's output, read past the cache.
    expect(mockGh.listPRs).toHaveBeenCalledWith(repo.fullName, { raw: true });
    expect(mockGh.invalidatePRList).toHaveBeenCalledWith(repo.fullName);
    expect(mockGh.invalidatePRList.mock.invocationCallOrder[0]).toBeLessThan(mockGh.listPRs.mock.invocationCallOrder[0]);
    expect(mockAlerts.closeAlertIssueIfResolved).toHaveBeenCalledWith(expect.objectContaining({
      repo: "org/claws", title: `[pr-store] claws_prs disagrees with PR labels in ${repo.fullName}`,
    }));
    expect(mockAlerts.upsertAlertIssue).not.toHaveBeenCalled();
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(`[issue-auditor] pr-store: ${repo.fullName} clean (2 PRs compared)`);
  });

  it("names the PR and field of each disagreement and keeps one alert issue", async () => {
    mockGh.listPRs.mockResolvedValue([pr(1, ["Automerge"]), pr(3, [])]);
    mockDb.listClawsPrs.mockResolvedValue([row(1, { stage: "awaiting-merge" })]);
    const fixes = await auditPrStore(repo);
    expect(fixes).toEqual([
      `pr-store: ${repo.fullName}#1 field=Ready row=present labels=absent`,
      `pr-store: ${repo.fullName}#1 field=Automerge row=absent labels=present`,
      `pr-store: ${repo.fullName}#3 field=missing-row row=row labels=none`,
    ]);
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(3);
    expect(mockAlerts.upsertAlertIssue).toHaveBeenCalledTimes(1);
    const body = mockAlerts.upsertAlertIssue.mock.calls[0][0].body as string;
    expect(body).toContain(`| ${repo.fullName}#1 | Ready | present | absent |`);
    expect(mockAlerts.closeAlertIssueIfResolved).not.toHaveBeenCalled();
  });

  it("processRepo includes the disagreements in its fixes", async () => {
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.isRateLimited.mockReturnValue(false);
    mockGh.listPRs.mockResolvedValue([pr(1, ["Ready"])]);
    mockDb.listClawsPrs.mockResolvedValue([row(1)]);
    expect(await processRepo(repo)).toEqual([`pr-store: ${repo.fullName}#1 field=Ready row=absent labels=present`]);
  });

  it("skips the comparison, closing any alert, where pr-dispatcher does not seed rows", async () => {
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.isRateLimited.mockReturnValue(false);
    mockGh.listPRs.mockResolvedValue([pr(1, ["Ready"])]);
    mockDb.listClawsPrs.mockResolvedValue([]);
    mockConfig.isJobDisabledForRepo.mockImplementation((job: string) => job === "pr-dispatcher");
    try {
      expect(await processRepo(repo)).toEqual([]);
      expect(mockDb.listClawsPrs).not.toHaveBeenCalled();
      expect(mockAlerts.upsertAlertIssue).not.toHaveBeenCalled();
      expect(mockAlerts.closeAlertIssueIfResolved).toHaveBeenCalledWith(expect.objectContaining({
        repo: "org/claws", title: `[pr-store] claws_prs disagrees with PR labels in ${repo.fullName}`,
      }));
    } finally {
      mockConfig.isJobDisabledForRepo.mockReturnValue(false);
    }
  });
});
