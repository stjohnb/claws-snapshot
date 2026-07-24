import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockIssue } from "../test-helpers.js";

const { LABELS, mockGh, mockRefiner, mockSlack, mockPlanParser, mockConfig } = vi.hoisted(() => ({
  LABELS: {
    refined: "Refined",
    manualAction: "Manual Action",
    duplicate: "Duplicate",
    clawsIgnore: "Claws Ignore",
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

import { run } from "./sequential-issue-processor.js";

describe("sequential-issue-processor", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("(c) is blocked (nothing acted) when an issue carries Manual Action", async () => {
    mockGh.listOpenIssues.mockResolvedValue([
      mockIssue({ number: 7, labels: [{ name: LABELS.manualAction }] }),
      mockIssue({ number: 8 }),
    ]);

    await run();

    expect(mockRefiner.prioritiseIssues).not.toHaveBeenCalled();
    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("(d) skips the opus call when no candidate has a plan", async () => {
    mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 9 })]);
    mockPlanParser.findPlanComment.mockReturnValue(null);

    await run();

    expect(mockRefiner.prioritiseIssues).not.toHaveBeenCalled();
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
});
