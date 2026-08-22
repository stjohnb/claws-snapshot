import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockIssue } from "../test-helpers.js";

const { LABELS, mockGh, mockRefiner, mockSlack, mockPlanParser, mockConfig } = vi.hoisted(() => ({
  LABELS: {
    refined: "Refined",
    manualAction: "Manual Action",
    duplicate: "Duplicate",
    clawsIgnore: "Claws Ignore",
    ready: "Ready",
    priority: "Priority",
  },
  mockGh: {
    listRepos: vi.fn(),
    listOpenIssues: vi.fn(),
    isDispatchSkippable: vi.fn(),
    isRateLimited: vi.fn(),
    isAllowedActor: vi.fn(),
    isCiAlertBotAuthor: vi.fn(),
    getIssueComments: vi.fn(),
    getOpenPRForIssue: vi.fn(),
    addLabel: vi.fn(),
    ensureLabel: vi.fn(),
    closeIssue: vi.fn(),
    commentOnIssue: vi.fn(),
  },
  mockRefiner: {
    prioritiseIssues: vi.fn(),
  },
  mockSlack: {
    notify: vi.fn(),
  },
  mockPlanParser: {
    findPlanComment: vi.fn(),
  },
  mockConfig: {
    isJobDisabledForRepo: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../agents/issue-refiner.js", () => mockRefiner);
vi.mock("../slack.js", () => mockSlack);
vi.mock("../plan-parser.js", () => mockPlanParser);
vi.mock("../config.js", () => ({ ...mockConfig, LABELS }));
vi.mock("../log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../error-reporter.js", () => ({ reportError: vi.fn() }));

import { run, resetTriageCacheForTests } from "./sequential-issue-processor.js";

describe("sequential-issue-processor", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    resetTriageCacheForTests();
    mockConfig.isJobDisabledForRepo.mockReturnValue(false);
    mockGh.listRepos.mockResolvedValue([repo]);
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.isDispatchSkippable.mockReturnValue(false);
    mockGh.isRateLimited.mockReturnValue(false);
    mockGh.isAllowedActor.mockResolvedValue(true);
    mockGh.isCiAlertBotAuthor.mockReturnValue(false);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.getOpenPRForIssue.mockResolvedValue(null);
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.ensureLabel.mockResolvedValue(undefined);
    mockGh.closeIssue.mockResolvedValue(undefined);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockPlanParser.findPlanComment.mockReturnValue(null);
    mockRefiner.prioritiseIssues.mockResolvedValue(null);
  });

  it("(a) does nothing when no repos are opted in", async () => {
    mockConfig.isJobDisabledForRepo.mockReturnValue(true);

    await run();

    expect(mockGh.listOpenIssues).not.toHaveBeenCalled();
  });

  it("(b) waits (no prioritise / no label) when an issue already carries Refined", async () => {
    mockGh.listOpenIssues.mockResolvedValue([
      mockIssue({ number: 5, labels: [{ name: LABELS.refined }] }),
      mockIssue({ number: 6 }),
    ]);

    await run();

    expect(mockRefiner.prioritiseIssues).not.toHaveBeenCalled();
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  // #2356: a Manual Action issue is excluded from the candidate set instead of
  // halting the repo, so the rest of the backlog keeps moving.
  it("(c) keeps processing the backlog when another issue carries Manual Action", async () => {
    mockGh.listOpenIssues.mockResolvedValue([
      mockIssue({ number: 7, labels: [{ name: LABELS.manualAction }] }),
      mockIssue({ number: 8 }),
    ]);
    mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nfix it");
    mockRefiner.prioritiseIssues.mockResolvedValue([
      { number: 8, classification: "auto", reason: "mechanical fix" },
    ]);

    await run();

    // The paused issue is never even shown to the ranking pass.
    expect(mockRefiner.prioritiseIssues.mock.calls[0][1].map((c: { issue: { number: number } }) => c.issue.number)).toEqual([8]);
    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 8, LABELS.refined);
  });

  it("(d) still triages when no candidate has a plan, but refines nothing", async () => {
    mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 9 })]);
    mockPlanParser.findPlanComment.mockReturnValue(null);
    mockRefiner.prioritiseIssues.mockResolvedValue([
      { number: 9, classification: "auto", reason: "mechanical fix" },
    ]);

    await run();

    expect(mockRefiner.prioritiseIssues).toHaveBeenCalledTimes(1);
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("(e) auto-refines the top-ranked auto issue that has a plan and no open PR", async () => {
    mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 11 })]);
    mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nfix it");
    mockRefiner.prioritiseIssues.mockResolvedValue([
      { number: 11, classification: "auto", reason: "mechanical fix" },
    ]);

    await run();

    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 11, LABELS.refined);
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("(f) labels Manual Action and posts exactly one comment for a needs_human issue", async () => {
    mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 12 })]);
    mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nrisky");
    mockRefiner.prioritiseIssues.mockResolvedValue([
      { number: 12, classification: "needs_human", reason: "high blast radius" },
    ]);

    await run();

    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 12, LABELS.manualAction);
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockSlack.notify).toHaveBeenCalledTimes(1);
  });

  it("(g) selects by LLM priority order, not issue number: out_of_scope first, auto second", async () => {
    mockGh.listOpenIssues.mockResolvedValue([
      mockIssue({ number: 20 }),
      mockIssue({ number: 21 }),
    ]);
    mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nfix");
    // Model ranks the out-of-scope issue first, the auto one second.
    mockRefiner.prioritiseIssues.mockResolvedValue([
      { number: 20, classification: "out_of_scope", reason: "feature request" },
      { number: 21, classification: "auto", reason: "incident fix" },
    ]);

    await run();

    expect(mockGh.addLabel).toHaveBeenCalledTimes(1);
    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 21, LABELS.refined);
  });

  it("(h) waits when the top-ranked auto issue has no plan yet (a lower issue has the plan)", async () => {
    const issue30 = mockIssue({ number: 30 });
    const issue31 = mockIssue({ number: 31 });
    mockGh.listOpenIssues.mockResolvedValue([issue30, issue31]);
    // Only #31 has a plan; #30 (ranked first) does not.
    mockPlanParser.findPlanComment.mockImplementation(() => null);
    mockGh.getIssueComments.mockImplementation(async (_repo: string, num: number) =>
      num === 31 ? [{ body: "## Implementation Plan\nfix" }] : [],
    );
    mockPlanParser.findPlanComment.mockImplementation((comments: { body: string }[]) =>
      comments.length ? comments[0].body : null,
    );
    mockRefiner.prioritiseIssues.mockResolvedValue([
      { number: 30, classification: "auto", reason: "most pressing" },
      { number: 31, classification: "auto", reason: "next" },
    ]);

    await run();

    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("(i) labels + comments on a duplicate and never selects it", async () => {
    mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 40 }), mockIssue({ number: 41 })]);
    mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nfix");
    mockRefiner.prioritiseIssues.mockResolvedValue([
      { number: 41, classification: "duplicate", duplicateOf: 40, reason: "same root cause" },
      { number: 40, classification: "auto", reason: "canonical" },
    ]);

    await run();

    expect(mockGh.ensureLabel).toHaveBeenCalledWith(repo.fullName, LABELS.duplicate);
    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 41, LABELS.duplicate);
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName, 41, expect.stringContaining("CLAWS_DUPLICATE_OF: #40"), { agentName: "Auto-Process" },
    );
    // Both issues stay open; the canonical one is the one that gets refined.
    expect(mockGh.closeIssue).not.toHaveBeenCalled();
    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 40, LABELS.refined);
  });

  it("(j) ignores a duplicateOf pointing at a number not in this tick's candidates", async () => {
    mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 50 })]);
    mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nfix");
    mockRefiner.prioritiseIssues.mockResolvedValue([
      { number: 50, classification: "duplicate", duplicateOf: 999, reason: "hallucinated target" },
    ]);

    await run();

    expect(mockGh.ensureLabel).not.toHaveBeenCalled();
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("(k) comments then closes an obsolete issue as not planned", async () => {
    mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 60 })]);
    mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nfix");
    mockRefiner.prioritiseIssues.mockResolvedValue([
      { number: 60, classification: "obsolete", reason: "already fixed in main" },
    ]);

    await run();

    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName, 60, expect.stringContaining("no longer applicable"), { agentName: "Auto-Process" },
    );
    expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, 60, "not_planned");
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("(l) never auto-closes an obsolete issue that carries Priority", async () => {
    mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 61, labels: [{ name: LABELS.priority }] })]);
    mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nfix");
    mockRefiner.prioritiseIssues.mockResolvedValue([
      { number: 61, classification: "obsolete", reason: "probably stale" },
    ]);

    await run();

    expect(mockGh.closeIssue).not.toHaveBeenCalled();
  });

  it("(m) skips the opus call on a second tick with an unchanged backlog", async () => {
    mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 70, updatedAt: "2026-03-15T10:00:00Z" })]);
    mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nfix");
    mockRefiner.prioritiseIssues.mockResolvedValue([
      { number: 70, classification: "out_of_scope", reason: "feature request" },
    ]);

    await run();
    await run();

    expect(mockRefiner.prioritiseIssues).toHaveBeenCalledTimes(1);
  });
});
