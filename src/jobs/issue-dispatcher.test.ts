import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { mockRepo, mockIssue } from "../test-helpers.js";

const mockIsAgentDisabled = vi.hoisted(() => vi.fn().mockReturnValue(false));
vi.mock("../config.js", () => ({
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
  MAX_WORK_WORKERS: 2,
  SELF_REPO: "test-org/claws",
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    duplicate: "Duplicate",
    problematic: "Claws Problematic",
    clawsStaging: "Claws Staging",
  },
  isAgentDisabled: mockIsAgentDisabled,
  isForgejoRepo: () => false,
  shouldRunWorkPipeline: () => true,
}));

vi.mock("../log.js", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    runContext: new AsyncLocalStorage(),
  };
});

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

vi.mock("../timeout-handler.js", () => ({
  handleTimeoutIfApplicable: vi.fn().mockResolvedValue(undefined),
}));

const mockGh = vi.hoisted(() => ({
  listOpenIssues: vi.fn().mockResolvedValue([]),
  getSelfLogin: vi.fn().mockResolvedValue("claws-bot"),
  getSelfLoginForRepo: vi.fn().mockResolvedValue("claws-bot"),
  getSelfLoginForIssue: vi.fn().mockResolvedValue("claws-bot"),
  isDispatchSkippable: vi.fn().mockReturnValue(false),
  hasPriorityLabel: vi.fn().mockReturnValue(false),
  getOpenPRForIssue: vi.fn().mockResolvedValue(null),
  listOpenPRsForIssue: vi.fn().mockResolvedValue([]),
  getPRState: vi.fn().mockResolvedValue("OPEN"),
  getIssueComments: vi.fn().mockResolvedValue([]),
  getIssueTitleBody: vi.fn(),
  listMergedPRsForIssue: vi.fn().mockResolvedValue([]),
  listPRsCrossReferencingIssue: vi.fn().mockResolvedValue([]),
  populateQueueCache: vi.fn(),
  populateQueueCacheFor: vi.fn(),
  removeLabel: vi.fn().mockResolvedValue(undefined),
  addLabel: vi.fn().mockResolvedValue(undefined),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
  isRateLimited: vi.fn().mockReturnValue(false),
  isRepoRateLimited: vi.fn().mockReturnValue(false),
  describeRateLimit: vi.fn().mockReturnValue(null),
  isClawsComment: vi.fn().mockReturnValue(false),
  RateLimitError: class RateLimitError extends Error {},
  isAllowedActor: vi.fn().mockResolvedValue(true),
  isCiAlertBotAuthor: vi.fn().mockReturnValue(false),
  isDependencyBotAuthor: vi.fn().mockReturnValue(false),
  findIssueByExactTitle: vi.fn().mockResolvedValue(null),
  createIssue: vi.fn().mockResolvedValue(1),
}));
vi.mock("../github.js", () => mockGh);

vi.mock("../slack.js", () => ({ notify: vi.fn() }));
const mockDb = vi.hoisted(() => ({ markUntrustedActorNotified: vi.fn().mockReturnValue(true) }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, markUntrustedActorNotified: mockDb.markUntrustedActorNotified };
});

const mockIssueWorker = vi.hoisted(() => ({
  processIssue: vi.fn().mockResolvedValue(undefined),
  checkAndContinue: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../agents/issue-worker.js", () => mockIssueWorker);

const mockIssueRefiner = vi.hoisted(() => ({
  processIssue: vi.fn().mockResolvedValue(undefined),
  processRefinement: vi.fn().mockResolvedValue(undefined),
  processFollowUp: vi.fn().mockResolvedValue(undefined),
  findUnreactedHumanComments: vi.fn().mockResolvedValue([]),
  isCiUnrelatedIssue: vi.fn().mockReturnValue(false),
  isAutoRefineIssue: vi.fn().mockReturnValue(false),
  hasStepBackReconsiderMarker: vi.fn().mockReturnValue(false),
  findUnreactedFeedbackAfterPlan: vi.fn().mockResolvedValue({ hasPlan: false, unreacted: [], plannedOccurrences: null, hasEscalationReview: false, plannedBodyHash: null }),
  stripRefinedForPendingFeedback: vi.fn().mockResolvedValue(undefined),
  PENDING_FEEDBACK_MARKER: "CLAWS_REFINED_PENDING_FEEDBACK",
  PLAN_HEADER: "## Implementation Plan",
  ESCALATION_REVIEW_HEADER: "## Escalation Review",
  PLAN_BODY_HASH_MARKER: "CLAWS_PLAN_BODY_HASH:",
  // Hash semantics are covered in issue-refiner.test.ts; here they are stubs so the
  // tests exercise the dispatcher's branching, not sha256.
  isPlanStaleForIssue: vi.fn().mockReturnValue(false),
  issueContentHash: vi.fn().mockReturnValue("hash-of-live-body"),
}));
vi.mock("../agents/issue-refiner.js", () => mockIssueRefiner);

const mockLoadApprovedRequirementsForOpenIssues = vi.hoisted(() => vi.fn().mockResolvedValue(new Map()));
const mockApprovedRequirementsFromBatch = vi.hoisted(() => vi.fn().mockResolvedValue({ status: "none" }));
vi.mock("../approved-requirements.js", () => ({
  loadApprovedRequirementsForOpenIssues: mockLoadApprovedRequirementsForOpenIssues,
  approvedRequirementsFromBatch: mockApprovedRequirementsFromBatch,
}));

const mockEscalationReviewer = vi.hoisted(() => ({
  isEscalationCandidate: vi.fn().mockReturnValue(false),
  reviewPlanAndEscalate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../agents/escalation-reviewer.js", () => mockEscalationReviewer);

vi.mock("../plan-parser.js", () => ({
  findPlanComment: vi.fn().mockReturnValue(null),
  parsePlan: vi.fn().mockReturnValue(null),
}));

vi.mock("./triage-claws-errors.js", () => ({
  extractFingerprint: vi.fn().mockReturnValue(null),
  REPORT_HEADER: "## Claws Error Investigation Report",
}));

import * as log from "../log.js";
import { run } from "./issue-dispatcher.js";
import * as planParser from "../plan-parser.js";
import { initDb, closeDb, clearAllWorkQueueForTests, listQueuedWork, createClawsIssue, createClawsIssueLink, getClawsIssue, setClawsIssueState, addClawsIssueRequirementsVersion, createShadowIssue, promoteClawsIssue, _rawDb } from "../db.js";
import * as slack from "../slack.js";
import { AGENT_KINDS } from "../worker.js";

describe("issue-dispatcher", () => {
  const repo = mockRepo();

  /**
   * Promote forge issue `n` to Planning through its shadow, the way a first
   * requirements version or a human would, so the planner gate lets it through.
   */
  async function inPlanning(n: number): Promise<void> {
    const shadow = await createShadowIssue(repo.fullName, n, { title: `#${n}`, authorLogin: "someone" });
    await promoteClawsIssue(shadow!.id, { version: null, approvedBy: "test", expectedLifecycle: "ideas" });
  }

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await clearAllWorkQueueForTests();
    // The dispatcher mints a shadow for every plan-less forge issue it sees;
    // drop them so one test's stage cannot leak into the next.
    await _rawDb().run(`DELETE FROM imported_issues`);
    await _rawDb().run(`DELETE FROM claws_issues WHERE kind = 'shadow'`);
    mockIsAgentDisabled.mockReturnValue(false);
    mockGh.isRateLimited.mockReturnValue(false);
    mockGh.isRepoRateLimited.mockReturnValue(false);
    mockGh.describeRateLimit.mockReturnValue(null);
    mockGh.isDispatchSkippable.mockReturnValue(false);
    // clearAllMocks() clears calls but not implementations — reset the reads the
    // auto-refine coverage gate makes, or one test's stubbed plan/PR list leaks
    // into the next.
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([]);
    mockGh.listOpenPRsForIssue.mockResolvedValue([]);
    mockEscalationReviewer.isEscalationCandidate.mockReturnValue(false);
    mockIssueRefiner.isAutoRefineIssue.mockReturnValue(false);
    mockIssueRefiner.hasStepBackReconsiderMarker.mockReturnValue(false);
    mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(false);
    mockIssueRefiner.issueContentHash.mockReturnValue("hash-of-live-body");
    // Default: the live read fails, so callers fall back to the issue snapshot the
    // test passed in — no test sees a spurious hash mismatch (#2524).
    mockGh.getIssueTitleBody.mockRejectedValue(new Error("no live read in tests"));
  });

  it("skips GitHub repos and logs while the breaker is open (#3221)", async () => {
    mockGh.isRateLimited.mockReturnValue(true);
    mockGh.isRepoRateLimited.mockReturnValue(true);
    mockGh.describeRateLimit.mockReturnValue("until 12:00:00Z (30m)");
    mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 1, labels: [{ name: "Refined" }] })]);

    await run([repo]);

    expect(mockGh.listOpenIssues).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("until 12:00:00Z (30m)"));
  });

  it("keeps dispatching Forgejo repos while the GitHub breaker is open (#3221)", async () => {
    const forgejoRepo = mockRepo({ owner: "test-org", name: "fj-repo", fullName: "test-org/fj-repo" });
    mockGh.isRateLimited.mockReturnValue(true);
    mockGh.isRepoRateLimited.mockImplementation((fullName: string) => fullName !== forgejoRepo.fullName);
    mockGh.describeRateLimit.mockReturnValue("until 12:00:00Z (30m)");
    const issue = mockIssue({ number: 1, labels: [{ name: "Refined" }] });
    mockGh.listOpenIssues.mockResolvedValue([issue]);

    await run([repo, forgejoRepo]);

    // Forgejo reads never touch GitHub's budget, so only the GitHub repo is skipped.
    expect(mockGh.listOpenIssues).toHaveBeenCalledTimes(1);
    expect(mockGh.listOpenIssues).toHaveBeenCalledWith(forgejoRepo.fullName);
    expect(await listQueuedWork()).not.toHaveLength(0);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("Skipping 1 GitHub repo(s)"));
  });

  it("enqueues a refined issue without blocking on agent execution", async () => {
    // Regression test for #1155: dispatcher must enqueue and return without
    // running the agent inline. The work_queue + worker fibers handle
    // execution; the dispatcher only schedules.
    const issue = mockIssue({ number: 1, labels: [{ name: "Refined" }] });
    mockGh.listOpenIssues.mockResolvedValue([issue]);

    await run([repo]);

    // Agent must NOT be invoked directly by the dispatcher.
    expect(mockIssueWorker.processIssue).not.toHaveBeenCalled();
  });

  // docs/issue-tracker.md#links: an open "depends on" target holds the
  // implementer back without the planner having to spot it in prose.
  it("does not implement a Refined native issue with an open dependency", async () => {
    const dependent = await createClawsIssue({ title: "Dependent", authorLogin: "stjohnb", repos: [repo.fullName], labels: ["Refined"] });
    const dependency = await createClawsIssue({ title: "Dependency", authorLogin: "stjohnb", repos: [repo.fullName] });
    await createClawsIssueLink({ sourceId: dependent, targetId: dependency, kind: "depends_on", createdBy: "x", actingId: dependent });
    mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: dependent, labels: [{ name: "Refined" }] })]);

    await run([repo]);

    let queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === dependent)).toBe(false);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining(`depends on open #${dependency}`));

    await setClawsIssueState(dependency, "closed", "completed");
    await run([repo]);
    queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === dependent)).toBe(true);
  });

  it("unparks a Blocked native issue once its dependency closes", async () => {
    const dependent = await createClawsIssue({ title: "Dependent", authorLogin: "stjohnb", repos: [repo.fullName], labels: ["Blocked"] });
    const dependency = await createClawsIssue({ title: "Dependency", authorLogin: "stjohnb", repos: [repo.fullName] });
    await createClawsIssueLink({ sourceId: dependent, targetId: dependency, kind: "depends_on", createdBy: "x", actingId: dependent });
    await setClawsIssueState(dependency, "closed", "completed");

    await run([repo]);

    // No plan and no approved requirements: back to Ideas.
    expect((await getClawsIssue(dependent))?.lifecycle).toBe("ideas");
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(repo.fullName, dependent, expect.stringContaining(`#${dependency} — Dependency (closed as completed)`), { agentName: "Issue links" });
  });

  it("staging mode only enqueues staging-labelled issues", async () => {
    const plain = mockIssue({ number: 10, labels: [] });
    const staging = mockIssue({ number: 11, labels: [{ name: "Claws Staging" }] });
    mockGh.listOpenIssues.mockResolvedValue([plain, staging]);
    mockGh.isDispatchSkippable.mockImplementation((_repo: string, issue: { labels: { name: string }[] }) =>
      !issue.labels.some((l) => l.name === "Claws Staging"),
    );
    await inPlanning(10);
    await inPlanning(11);

    await run([repo]);

    const queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_PLAN && w.item_number === 10)).toBe(false);
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_PLAN && w.item_number === 11)).toBe(true);
    expect(mockGh.populateQueueCacheFor).toHaveBeenCalledWith("needs-refinement", repo.fullName, staging, "issue");
    expect(mockGh.populateQueueCacheFor).not.toHaveBeenCalledWith("needs-refinement", repo.fullName, plain, "issue");
  });

  // Backlog is parked through `gh.isDispatchSkippable` → `isParked` (#3293):
  // a backlog issue is never planned, while its neighbour is.
  it("does not plan a Backlog issue", async () => {
    const planning = mockIssue({ number: 20, labels: [] });
    const backlog = mockIssue({ number: 21, labels: [{ name: "Backlog" }] });
    mockGh.listOpenIssues.mockResolvedValue([planning, backlog]);
    await inPlanning(20);
    mockGh.isDispatchSkippable.mockImplementation((_repo: string, issue: { labels: { name: string }[] }) =>
      issue.labels.some((l) => l.name === "Backlog"),
    );

    await run([repo]);

    const queued = await listQueuedWork();
    expect(queued.some((w) => w.item_number === 21)).toBe(false);
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_PLAN && w.item_number === 20)).toBe(true);
  });

  describe("requirements writer", () => {
    const RECORD = { title: "T", kind: "feature" as const, context: "c", requirement: "r", acceptanceCriteria: ["a"], outOfScope: [] };
    const REQ_COMMENT = { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PR1", login: "claws", body_html: "", body: "*— Automated by Claws · Requirements writer —*\n\n## Requirements\n\n**Title:** T" };
    const HUMAN = { id: "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PR2", login: "stjohnb", body_html: "", body: "Also cover phones" };

    // The promotion gate: an issue in Ideas gets the writer and never the planner.
    it("enqueues a write, and not the planner, for a forge issue in Ideas", async () => {
      mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 600, labels: [] })]);

      await run([repo]);

      const queued = await listQueuedWork();
      expect(queued.some((w) => w.kind === AGENT_KINDS.REQUIREMENTS_WRITE && w.item_number === 600)).toBe(true);
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_PLAN && w.item_number === 600)).toBe(false);
      // Its shadow was minted in Ideas, where a new issue starts.
      const shadow = await _rawDb().get(`SELECT c.lifecycle FROM imported_issues i JOIN claws_issues c ON c.id = i.native_id WHERE i.repo = ? AND i.forge_number = ?`, [repo.fullName, "600"]) as { lifecycle: string };
      expect(shadow.lifecycle).toBe("ideas");
    });

    it("never plans a native issue in Ideas, and plans one in Planning", async () => {
      const ideas = await createClawsIssue({ title: "Ideas", authorLogin: "stjohnb", repos: [repo.fullName] });
      const planning = await createClawsIssue({ title: "Planning", authorLogin: "stjohnb", repos: [repo.fullName] });
      await promoteClawsIssue(planning, { version: null, approvedBy: "stjohnb", expectedLifecycle: "ideas" });
      mockGh.listOpenIssues.mockResolvedValue([
        mockIssue({ number: ideas, labels: [], lifecycle: "ideas" }),
        mockIssue({ number: planning, labels: [], lifecycle: "planning" }),
      ]);

      await run([repo]);

      const queued = await listQueuedWork();
      const kindsFor = (ref: string) => queued.filter((w) => w.item_number === ref).map((w) => w.kind);
      expect(kindsFor(ideas)).toContain(AGENT_KINDS.REQUIREMENTS_WRITE);
      expect(kindsFor(ideas)).not.toContain(AGENT_KINDS.ISSUE_REFINER_PLAN);
      expect(kindsFor(planning)).toContain(AGENT_KINDS.ISSUE_REFINER_PLAN);
    });

    it("plans a forge issue that already has a plan whatever its shadow says", async () => {
      mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 603, labels: [] })]);
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValueOnce({ hasPlan: true, unreacted: [{ id: 9, body: "change it", login: "stjohnb", body_html: "" }], plannedOccurrences: null, hasEscalationReview: false, plannedBodyHash: null });

      await run([repo]);

      expect((await listQueuedWork()).map((w) => w.kind)).toContain(AGENT_KINDS.ISSUE_REFINER_REFINE);
    });

    it("enqueues a refine when a human commented on the record, and nothing when nobody did", async () => {
      const commented = await createClawsIssue({ title: "Commented", authorLogin: "stjohnb", repos: [repo.fullName] });
      const quiet = await createClawsIssue({ title: "Quiet", authorLogin: "stjohnb", repos: [repo.fullName] });
      await addClawsIssueRequirementsVersion(commented, RECORD, REQ_COMMENT.id);
      await addClawsIssueRequirementsVersion(quiet, RECORD, REQ_COMMENT.id);
      mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: commented, labels: [] }), mockIssue({ number: quiet, labels: [] })]);
      mockGh.getIssueComments.mockImplementation(async (_repo: string, ref: string) =>
        (ref === commented ? [REQ_COMMENT, HUMAN] : [REQ_COMMENT]));
      mockIssueRefiner.findUnreactedHumanComments.mockImplementation(async (_repo: string, after: unknown[]) => after);

      await run([repo]);

      const queued = await listQueuedWork();
      const kindsFor = (ref: string) => queued.filter((w) => w.item_number === ref).map((w) => w.kind);
      expect(kindsFor(commented)).toContain(AGENT_KINDS.REQUIREMENTS_REFINE);
      expect(kindsFor(commented)).not.toContain(AGENT_KINDS.REQUIREMENTS_WRITE);
      expect(kindsFor(quiet)).not.toContain(AGENT_KINDS.REQUIREMENTS_REFINE);
      expect(kindsFor(quiet)).not.toContain(AGENT_KINDS.REQUIREMENTS_WRITE);
      expect(mockIssueRefiner.findUnreactedHumanComments).toHaveBeenCalledWith(repo.fullName, [HUMAN], "claws-bot", commented);
      mockIssueRefiner.findUnreactedHumanComments.mockResolvedValue([]);
    });

    it("enqueues neither for an issue that already has a plan", async () => {
      mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 601, labels: [] })]);
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValueOnce({ hasPlan: true, unreacted: [], plannedOccurrences: null, hasEscalationReview: false, plannedBodyHash: null });

      await run([repo]);

      const kinds = (await listQueuedWork()).map((w) => w.kind);
      expect(kinds).not.toContain(AGENT_KINDS.REQUIREMENTS_WRITE);
      expect(kinds).not.toContain(AGENT_KINDS.REQUIREMENTS_REFINE);
    });

    it("skips the writer, but not the planner, when the requirements writer is disabled", async () => {
      mockIsAgentDisabled.mockImplementation((name: string) => name === "requirements-writer");
      mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 602, labels: [] })]);
      await inPlanning(602);

      await run([repo]);

      const kinds = (await listQueuedWork()).map((w) => w.kind);
      expect(kinds).not.toContain(AGENT_KINDS.REQUIREMENTS_WRITE);
      expect(kinds).toContain(AGENT_KINDS.ISSUE_REFINER_PLAN);
    });
  });

  it("does not enqueue unlabelled issues when a live activation flip disables the work pipeline", async () => {
    const issue = mockIssue({ number: 12, labels: [] });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isDispatchSkippable.mockReturnValue(true);

    await run([repo]);

    expect(await listQueuedWork()).toHaveLength(0);
    expect(mockGh.populateQueueCacheFor).not.toHaveBeenCalled();
  });

  it("dispatches a CI-failure alert issue and does not notify Slack", async () => {
    const issue = mockIssue({
      number: 354,
      title: "[main] Bump app version failed on main",
      author: { login: "app/github-actions" },
    });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(false);
    mockGh.isCiAlertBotAuthor.mockReturnValue(true);
    await inPlanning(354);

    await run([repo]);

    const queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_PLAN && w.item_number === 354)).toBe(true);
    expect(slack.notify).not.toHaveBeenCalled();
  });

  it("dispatches a refined CI-failure alert issue to the worker and does not notify Slack", async () => {
    const issue = mockIssue({
      number: 355,
      title: "[main] Bump app version failed on main",
      author: { login: "app/github-actions" },
      labels: [{ name: "Refined" }],
    });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(false);
    mockGh.isCiAlertBotAuthor.mockReturnValue(true);

    await run([repo]);

    const queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 355)).toBe(true);
    expect(slack.notify).not.toHaveBeenCalled();
  });

  it("skips and Slack-notifies an untrusted non-CI issue on first encounter", async () => {
    const issue = mockIssue({ number: 100 });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(false);
    mockGh.isCiAlertBotAuthor.mockReturnValue(false);
    mockDb.markUntrustedActorNotified.mockReturnValue(true);

    await run([repo]);

    expect(await listQueuedWork()).toHaveLength(0);
    expect(slack.notify).toHaveBeenCalledOnce();
    expect(mockGh.createIssue).toHaveBeenCalledOnce();
    expect(mockGh.createIssue.mock.calls[0]![1]).toContain("disallowed-actor");
  });

  it("does not re-notify Slack for an already-notified untrusted issue", async () => {
    const issue = mockIssue({ number: 100 });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(false);
    mockGh.isCiAlertBotAuthor.mockReturnValue(false);
    mockDb.markUntrustedActorNotified.mockReturnValue(false);

    await run([repo]);

    expect(slack.notify).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("dispatches a github-actions[bot] CI-alert issue with a non-[main] title", async () => {
    const issue = mockIssue({
      number: 412,
      title: "Lighthouse regression detected",
      author: { login: "app/github-actions" },
    });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(false);
    mockGh.isCiAlertBotAuthor.mockReturnValue(true);
    await inPlanning(412);

    await run([repo]);

    const queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_PLAN && w.item_number === 412)).toBe(true);
    expect(slack.notify).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("dispatches any github-actions[bot] issue regardless of title", async () => {
    const issue = mockIssue({
      number: 500,
      title: "Weekly dependency digest",
      author: { login: "github-actions[bot]" },
    });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(false);
    mockGh.isCiAlertBotAuthor.mockReturnValue(true);
    await inPlanning(500);

    await run([repo]);

    const queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_PLAN && w.item_number === 500)).toBe(true);
    expect(slack.notify).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
    expect(mockDb.markUntrustedActorNotified).not.toHaveBeenCalled();
  });

  it("still Slack-notifies and alerts a genuine non-bot disallowed actor", async () => {
    const issue = mockIssue({ number: 200, author: { login: "random-human" } });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(false);
    mockGh.isCiAlertBotAuthor.mockReturnValue(false);
    mockDb.markUntrustedActorNotified.mockReturnValue(true);

    await run([repo]);

    expect(slack.notify).toHaveBeenCalledOnce();
    expect(mockGh.createIssue).toHaveBeenCalledOnce();
  });

  it("silently skips a Renovate Dependency Dashboard issue with no Slack or alert", async () => {
    const issue = mockIssue({
      number: 329,
      title: "Dependency Dashboard",
      author: { login: "renovate" },
    });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(false);
    mockGh.isCiAlertBotAuthor.mockReturnValue(false);
    mockGh.isDependencyBotAuthor.mockReturnValue(true);

    await run([repo]);

    expect(await listQueuedWork()).toHaveLength(0);
    expect(mockGh.createIssue).not.toHaveBeenCalled();
    expect(mockDb.markUntrustedActorNotified).not.toHaveBeenCalled();
    expect(slack.notify).not.toHaveBeenCalled();
  });

  it("enqueues ISSUE_REFINER_REPLAN when occurrences >= planned * factor and no feedback", async () => {
    const occurrenceBody = `Alert body.\n\n---\n**First seen:** 2024-01-01T00:00:00.000Z\n**Last seen:** 2024-01-02T00:00:00.000Z\n**Occurrences:** 2`;
    const issue = mockIssue({ number: 300, body: occurrenceBody });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    // Plan exists, plannedOccurrences=1, no unreacted feedback
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
      hasPlan: true,
      unreacted: [],
      plannedOccurrences: 1,
    });

    await run([repo]);

    const queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 300)).toBe(true);
  });

  it("does not enqueue ISSUE_REFINER_REPLAN when current occurrences equals planned (no growth)", async () => {
    const occurrenceBody = `Alert body.\n\n---\n**First seen:** 2024-01-01T00:00:00.000Z\n**Last seen:** 2024-01-01T00:00:00.000Z\n**Occurrences:** 1`;
    const issue = mockIssue({ number: 301, body: occurrenceBody });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
      hasPlan: true,
      unreacted: [],
      plannedOccurrences: 1,
    });

    await run([repo]);

    const queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 301)).toBe(false);
  });

  it("applies Refined to a planned, non-stale, non-escalation issue that isAutoRefineIssue accepts", async () => {
    const issue = mockIssue({ number: 350, title: "chore: add .mcp-claws.json to .gitignore" });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
      hasPlan: true,
      unreacted: [],
      plannedOccurrences: null,
    });
    mockIssueRefiner.isAutoRefineIssue.mockReturnValue(true);

    await run([repo]);

    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 350, "Refined");
  });

  it("does not auto-apply Refined when every plan phase is already covered", async () => {
    // The implementer's all-covered guard would strip `Refined` seconds later and
    // the next tick would re-apply it — a relabel loop on an open issue (#2821).
    const issue = mockIssue({ number: 352, title: "chore: add .mcp-claws.json to .gitignore" });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 1, body: "## Implementation Plan\n\nDo the thing.", login: "claws-bot", created_at: "2024-01-01T00:00:00Z" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([{ number: 900, title: "fix (1/1)" }]);
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
      hasPlan: true,
      unreacted: [],
      plannedOccurrences: null,
    });
    mockIssueRefiner.isAutoRefineIssue.mockReturnValue(true);

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 352, "Refined");
  });

  it("does not auto-apply Refined to a single-phase issue already covered by an open target PR (#3050)", async () => {
    // A CLAWS_TARGET_PR implementation pushes to another issue's PR branch and
    // leaves no `claws/issue-<N>-` PR of its own, so the legacy merged-PR list
    // is empty; coverage instead comes from the open PR's `Closes #N` body.
    const issue = mockIssue({ number: 355, title: "[ci-unrelated] fix: yarn.lock truncated" });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 1, body: "## Implementation Plan\n\nDo the thing.\n\nCLAWS_TARGET_PR: #1959", login: "claws-bot", created_at: "2024-01-01T00:00:00Z" },
    ]);
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
      { number: 1959, title: "fix: resolve #1958 — thing", body: "Implements the fix.\n\nCloses #355", state: "open", login: "claws-bot" },
    ]);
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
      hasPlan: true,
      unreacted: [],
      plannedOccurrences: null,
    });
    mockIssueRefiner.isAutoRefineIssue.mockReturnValue(true);

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 355, "Refined");
  });

  it("does not auto-apply Refined when the plan comment carries a withheld step-back marker (#3091)", async () => {
    const issue = mockIssue({ number: 353, title: "chore: add .mcp-claws.json to .gitignore" });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    const planBody = "## Implementation Plan\n\nDo the thing.\n\nCLAWS_PLAN_STEP_BACK: reconsider";
    mockGh.getIssueComments.mockResolvedValue([
      { id: 1, body: planBody, login: "claws-bot", created_at: "2024-01-01T00:00:00Z" },
    ]);
    vi.mocked(planParser.findPlanComment).mockReturnValueOnce(planBody);
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
      hasPlan: true,
      unreacted: [],
      plannedOccurrences: null,
    });
    mockIssueRefiner.isAutoRefineIssue.mockReturnValue(true);
    mockIssueRefiner.hasStepBackReconsiderMarker.mockReturnValue(true);

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 353, "Refined");
    expect(mockGh.populateQueueCacheFor).toHaveBeenCalledWith("ready", repo.fullName, issue, "issue");
  });

  it("still auto-applies Refined when the plan has no withheld step-back marker", async () => {
    const issue = mockIssue({ number: 354, title: "chore: add .mcp-claws.json to .gitignore" });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    const planBody = "## Implementation Plan\n\nDo the thing.";
    mockGh.getIssueComments.mockResolvedValue([
      { id: 1, body: planBody, login: "claws-bot", created_at: "2024-01-01T00:00:00Z" },
    ]);
    vi.mocked(planParser.findPlanComment).mockReturnValueOnce(planBody);
    vi.mocked(planParser.parsePlan).mockReturnValueOnce({ preamble: "", phases: [], totalPhases: 1 });
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
      hasPlan: true,
      unreacted: [],
      plannedOccurrences: null,
    });
    mockIssueRefiner.isAutoRefineIssue.mockReturnValue(true);
    mockIssueRefiner.hasStepBackReconsiderMarker.mockReturnValue(false);

    await run([repo]);

    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 354, "Refined");
  });

  it("does not re-apply Refined when it is already present", async () => {
    const issue = mockIssue({ number: 351, title: "chore: add .mcp-claws.json to .gitignore", labels: [{ name: "Refined" }] });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
      hasPlan: true,
      unreacted: [],
      plannedOccurrences: null,
    });
    mockIssueRefiner.isAutoRefineIssue.mockReturnValue(true);

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 351, "Refined");
  });

  it("enqueues ISSUE_REFINER_REPLAN for legacy plan (plannedOccurrences=null) when occurrences >= 2", async () => {
    const occurrenceBody = `Alert body.\n\n---\n**First seen:** 2024-01-01T00:00:00.000Z\n**Last seen:** 2024-01-02T00:00:00.000Z\n**Occurrences:** 2`;
    const issue = mockIssue({ number: 302, body: occurrenceBody });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    // Legacy plan: no marker → plannedOccurrences is null, defaults to 1
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
      hasPlan: true,
      unreacted: [],
      plannedOccurrences: null,
    });

    await run([repo]);

    const queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 302)).toBe(true);
  });

  it("enqueues ESCALATION_REVIEW instead of a re-plan for a Priority monitor alert with no prior review", async () => {
    // These alert issues bump their occurrence count every monitor tick, so the
    // re-plan trigger is already satisfied. The escalation review must win anyway,
    // or it never runs.
    const occurrenceBody = `Alert body.\n\n---\n**First seen:** 2024-01-01T00:00:00.000Z\n**Last seen:** 2024-01-02T00:00:00.000Z\n**Occurrences:** 23`;
    const issue = mockIssue({ number: 303, title: "[k3s] Flux Kustomization NotReady: flux-system/infrastructure", body: occurrenceBody });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
      hasPlan: true,
      unreacted: [],
      plannedOccurrences: 1,
      hasEscalationReview: false,
    });
    mockEscalationReviewer.isEscalationCandidate.mockReturnValue(true);

    await run([repo]);

    const queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ESCALATION_REVIEW && w.item_number === 303)).toBe(true);
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 303)).toBe(false);
  });

  it("falls through to the re-plan path once an escalation review already exists", async () => {
    const occurrenceBody = `Alert body.\n\n---\n**First seen:** 2024-01-01T00:00:00.000Z\n**Last seen:** 2024-01-02T00:00:00.000Z\n**Occurrences:** 23`;
    const issue = mockIssue({ number: 304, title: "[k3s] Flux Kustomization NotReady: flux-system/infrastructure", body: occurrenceBody });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
      hasPlan: true,
      unreacted: [],
      plannedOccurrences: 1,
      hasEscalationReview: true,
    });
    mockEscalationReviewer.isEscalationCandidate.mockReturnValue(true);

    await run([repo]);

    const queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ESCALATION_REVIEW && w.item_number === 304)).toBe(false);
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 304)).toBe(true);
  });

  it("does not enqueue ESCALATION_REVIEW when the escalation-reviewer agent is disabled", async () => {
    const issue = mockIssue({ number: 305, title: "[k3s] Flux Kustomization NotReady: flux-system/infrastructure" });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
      hasPlan: true,
      unreacted: [],
      plannedOccurrences: 1,
      hasEscalationReview: false,
    });
    mockEscalationReviewer.isEscalationCandidate.mockReturnValue(true);
    mockIsAgentDisabled.mockImplementation((name: string) => name === "escalation-reviewer");

    await run([repo]);

    const queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ESCALATION_REVIEW)).toBe(false);
  });

  describe("stale-plan re-plan trigger (#2524)", () => {
    const OCC_BLOCK = "\n\n---\n**First seen:** 2024-01-01T00:00:00.000Z\n**Last seen:** 2024-01-02T00:00:00.000Z\n**Occurrences:** 2";

    /** An issue with a plan, no outstanding feedback, and the given stamped hash. */
    function plannedIssue(number: number, body: string, plannedBodyHash: string | null) {
      const issue = mockIssue({ number, body });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.isAllowedActor.mockResolvedValue(true);
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
        hasPlan: true,
        unreacted: [],
        plannedOccurrences: 1,
        hasEscalationReview: false,
        plannedBodyHash,
      });
      return issue;
    }

    it("strips Ready and enqueues ISSUE_REFINER_REPLAN when the uncached read confirms the mismatch", async () => {
      const issue = plannedIssue(400, "finder-cap — no change", "hash-the-plan-was-written-against");
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(true);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "skip finder-cap" });
      mockIssueRefiner.issueContentHash.mockReturnValue("hash-of-live-body");

      await run([repo]);

      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 400, "Ready");
      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 400)).toBe(true);
    });

    it("re-plans when only the approved requirements record changed", async () => {
      // Stamped against record v1; the issue now has v2 approved with different
      // text, and an unchanged body. The stub is stale only for the new record.
      const issue = plannedIssue(407, "unchanged body", "hash-against-record-v1");
      mockApprovedRequirementsFromBatch.mockResolvedValueOnce({ status: "approved", record: { version: 2, requirement: "Re-approved" } });
      mockIssueRefiner.isPlanStaleForIssue.mockImplementation(
        (_plan: string, _title: string, _body: string, requirements?: { version: number } | null) => requirements?.version === 2,
      );
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "unchanged body" });

      await run([repo]);

      expect(mockApprovedRequirementsFromBatch).toHaveBeenCalledWith(repo.fullName, 407, expect.anything());
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 407, "Ready");
      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 407)).toBe(true);
    });

    it("does not re-plan when the approved-requirements batch read fails — skips the check for the tick", async () => {
      const issue = plannedIssue(409, "unchanged body", "hash-against-record-v1");
      mockLoadApprovedRequirementsForOpenIssues.mockRejectedValueOnce(new Error("db down"));
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(true);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "unchanged body" });

      await run([repo]);

      expect(mockApprovedRequirementsFromBatch).not.toHaveBeenCalled();
      expect(mockGh.removeLabel).not.toHaveBeenCalledWith(repo.fullName, 409, "Ready");
    });

    it("does not read the approved record for an issue whose plan has no stamped hash", async () => {
      plannedIssue(408, "body", null);

      await run([repo]);

      expect(mockApprovedRequirementsFromBatch).not.toHaveBeenCalledWith(repo.fullName, 408, expect.anything());
    });

    it("does not re-plan when the cached list looks stale but the uncached read matches", async () => {
      // allIssues is 60 s cached — a stale entry must not cost a planner run.
      const issue = plannedIssue(401, "cached body", "hash-of-live-body");
      // Cached check (against issue.body) says stale; the confirming live check
      // (against the uncached read) says it matches — both go through the same
      // isPlanStaleForIssue helper now, so distinguish by call order.
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValueOnce(true).mockReturnValueOnce(false);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "live body" });

      await run([repo]);

      expect(mockGh.removeLabel).not.toHaveBeenCalledWith(repo.fullName, 401, "Ready");
      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 401)).toBe(false);
    });

    it("does not re-plan a Claws-maintained alert issue on a hash mismatch — it falls through to the occurrence logic", async () => {
      // ensureAlertIssue rewrites these bodies every monitor tick; without this the
      // whole monitor fleet re-plans on every dispatcher tick.
      const issue = plannedIssue(402, "disk at 80%" + OCC_BLOCK, "hash-the-plan-was-written-against");
      // Cached check says stale; the live check — same helper, real semantics would
      // exempt an occurrence-tracked body — says not stale, so this site no-ops and
      // the occurrence rule below is what actually queues the re-plan.
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValueOnce(true).mockReturnValueOnce(false);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "disk at 92%" + OCC_BLOCK });

      await run([repo]);

      expect(mockGh.removeLabel).not.toHaveBeenCalledWith(repo.fullName, 402, "Ready");
      // The occurrence rule still governs it: 2 >= planned 1 * factor 2.
      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 402)).toBe(true);
    });

    it("does not re-plan a legacy plan carrying no stamped hash", async () => {
      plannedIssue(403, "any body", null);
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(true);

      await run([repo]);

      expect(mockGh.getIssueTitleBody).not.toHaveBeenCalled();
      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 403)).toBe(false);
    });

    it("does not re-plan when the uncached read fails", async () => {
      plannedIssue(404, "any body", "hash-the-plan-was-written-against");
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(true);
      mockGh.getIssueTitleBody.mockRejectedValue(new Error("gh down"));

      await run([repo]);

      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 404)).toBe(false);
    });

    it("does not re-plan a multi-PR continuation whose earlier phase already merged", async () => {
      // Between "PR 1 merged" and Phase 3 re-applying `Refined`, the issue has no open
      // PR and no `Refined` label, so it lands here. Re-planning would discard the
      // agreed multi-phase plan Phase 3 is concurrently implementing against.
      const issue = plannedIssue(406, "edited body", "hash-the-plan-was-written-against");
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(true);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "edited body" });
      mockGh.listMergedPRsForIssue.mockResolvedValue([{ number: 900 }]);

      await run([repo]);

      expect(mockGh.removeLabel).not.toHaveBeenCalledWith(repo.fullName, 406, "Ready");
      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 406)).toBe(false);
    });

    it("lets the escalation review win over the hash check", async () => {
      // Same ordering rule as the occurrence trigger: the escalation reviewer must
      // get exactly one run per posted plan, or it is starved forever.
      const issue = plannedIssue(405, "edited body", "hash-the-plan-was-written-against");
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(true);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "edited body" });
      mockEscalationReviewer.isEscalationCandidate.mockReturnValue(true);

      await run([repo]);

      const queued = await listQueuedWork();
      expect(queued.some((w) => w.kind === AGENT_KINDS.ESCALATION_REVIEW && w.item_number === 405)).toBe(true);
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 405)).toBe(false);
    });
  });

  describe("multi-PR continuation (Phase 3)", () => {
    const multiPRPlan = { totalPhases: 3, phases: [] };

    function multiPRIssue(number: number) {
      const issue = mockIssue({ number, labels: [] });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      vi.mocked(planParser.findPlanComment).mockReturnValue("plan text");
      vi.mocked(planParser.parsePlan).mockReturnValue(multiPRPlan as never);
      return issue;
    }

    const continued = async (number: number) =>
      (await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER_CONTINUE && w.item_number === number);

    it("continues an issue whose only covered phase came from a non-Claws PR", async () => {
      // The old gate was `listMergedPRsForIssue().length === 0 → skip`, which sees
      // `claws/issue-<N>-` branches only: an issue whose steps all shipped from
      // outside Claws was never continued at all (#2594).
      multiPRIssue(501);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
        { number: 70, title: "fix(#501): step one (1/3)", body: "Part of #501", state: "merged" },
      ]);

      await run([repo]);

      expect(await continued(501)).toBe(true);
    });

    it("does not continue an issue with no covered phase at all", async () => {
      multiPRIssue(502);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([]);

      await run([repo]);

      expect(await continued(502)).toBe(false);
    });

    it("does not continue while a covered phase's PR is still open", async () => {
      multiPRIssue(503);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
        { number: 71, title: "fix(#503): step one (1/3)", body: "Part of #503", state: "open" },
      ]);

      await run([repo]);

      expect(await continued(503)).toBe(false);
    });

    it("continues a parallel plan while a sibling phase's PR is still open", async () => {
      multiPRIssue(504);
      // PR 2 is declared independent of PR 1, so it can start while PR 1 is open.
      vi.mocked(planParser.parsePlan).mockReturnValue({
        totalPhases: 3,
        phases: [
          { phaseNumber: 1, title: "a", description: "", dependsOn: null },
          { phaseNumber: 2, title: "b", description: "", dependsOn: [] },
          { phaseNumber: 3, title: "c", description: "", dependsOn: null },
        ],
      } as never);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
        { number: 72, title: "fix(#504): step one (1/3)", body: "Part of #504", state: "open" },
      ]);

      await run([repo]);

      expect(await continued(504)).toBe(true);
    });
  });

  describe("Refined with unaddressed human feedback (#2772)", () => {
    it("strips Refined and enqueues a re-plan when there is no open PR", async () => {
      const issue = mockIssue({ number: 600, labels: [{ name: "Refined" }] });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.isAllowedActor.mockResolvedValue(true);
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      const comment = { id: 42, body: "please do X instead", login: "human" };
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
        hasPlan: true,
        unreacted: [comment],
        plannedOccurrences: null,
        hasEscalationReview: false,
        plannedBodyHash: null,
      });

      await run([repo]);

      expect(mockIssueRefiner.stripRefinedForPendingFeedback).toHaveBeenCalledWith(
        repo.fullName, 600, [comment], "Planner",
      );
      const queued = await listQueuedWork();
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REFINE && w.item_number === 600)).toBe(true);
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 600)).toBe(false);
    });

    it("strips Refined and enqueues a follow-up when a PR is already open", async () => {
      const issue = mockIssue({ number: 601, labels: [{ name: "Refined" }] });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.isAllowedActor.mockResolvedValue(true);
      mockGh.listOpenPRsForIssue.mockResolvedValue([{ number: 9, title: "wip", headRefName: "claws/issue-601-abc" }]);
      const comment = { id: 43, body: "please do X instead", login: "human" };
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
        hasPlan: true,
        unreacted: [comment],
        plannedOccurrences: null,
        hasEscalationReview: false,
        plannedBodyHash: null,
      });

      await run([repo]);

      expect(mockIssueRefiner.stripRefinedForPendingFeedback).toHaveBeenCalledWith(
        repo.fullName, 601, [comment], "Planner",
      );
      const queued = await listQueuedWork();
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_FOLLOWUP && w.item_number === 601)).toBe(true);
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 601)).toBe(false);
    });

    it("excludes a pure claws-phase-done claim from pending feedback", async () => {
      const issue = mockIssue({ number: 604, labels: [{ name: "Refined" }] });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.isAllowedActor.mockResolvedValue(true);
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      const claimComment = { id: 44, body: "claws-phase-done: 1", login: "human" };
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
        hasPlan: true,
        unreacted: [claimComment],
        plannedOccurrences: null,
        hasEscalationReview: false,
        plannedBodyHash: null,
      });

      await run([repo]);

      expect(mockIssueRefiner.stripRefinedForPendingFeedback).not.toHaveBeenCalled();
      const queued = await listQueuedWork();
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 604)).toBe(true);
    });

    it("still treats a claim comment with real feedback attached as pending feedback", async () => {
      const issue = mockIssue({ number: 605, labels: [{ name: "Refined" }] });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.isAllowedActor.mockResolvedValue(true);
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      const mixedComment = { id: 45, body: "claws-phase-done: 1 — also please rename X", login: "human" };
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
        hasPlan: true,
        unreacted: [mixedComment],
        plannedOccurrences: null,
        hasEscalationReview: false,
        plannedBodyHash: null,
      });

      await run([repo]);

      expect(mockIssueRefiner.stripRefinedForPendingFeedback).toHaveBeenCalledWith(
        repo.fullName, 605, [mixedComment], "Planner",
      );
    });

    it("enqueues the worker as normal when Refined has no unaddressed feedback", async () => {
      const issue = mockIssue({ number: 602, labels: [{ name: "Refined" }] });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.isAllowedActor.mockResolvedValue(true);
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
        hasPlan: true,
        unreacted: [],
        plannedOccurrences: null,
        hasEscalationReview: false,
        plannedBodyHash: null,
      });

      await run([repo]);

      expect(mockIssueRefiner.stripRefinedForPendingFeedback).not.toHaveBeenCalled();
      const queued = await listQueuedWork();
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 602)).toBe(true);
    });

    it("enqueues the worker as normal when Refined precedes any plan", async () => {
      const issue = mockIssue({ number: 603, labels: [{ name: "Refined" }] });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.isAllowedActor.mockResolvedValue(true);
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
        hasPlan: false,
        unreacted: [],
        plannedOccurrences: null,
        hasEscalationReview: false,
        plannedBodyHash: null,
      });

      await run([repo]);

      expect(mockIssueRefiner.stripRefinedForPendingFeedback).not.toHaveBeenCalled();
      const queued = await listQueuedWork();
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 603)).toBe(true);
    });
  });

});
