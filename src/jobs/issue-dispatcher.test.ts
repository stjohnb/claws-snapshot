import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { mockRepo, mockIssue } from "../test-helpers.js";

const mockIsAgentDisabled = vi.hoisted(() => vi.fn().mockReturnValue(false));
// The importer is off by default so the existing tests keep today's
// in-place behaviour; the "import first" suite switches it on.
const mockIsJobDisabledForRepo = vi.hoisted(() => vi.fn().mockReturnValue(true));
vi.mock("../config.js", () => ({
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
  MAX_WORK_WORKERS: 2,
  MIN_WORK_WORKERS: 2,
  SELF_REPO: "test-org/claws",
  LABELS: {
    priority: "Priority",
    duplicate: "Duplicate",
    blocked: "Blocked",
    problematic: "Claws Problematic",
    clawsStaging: "Claws Staging",
  },
  isAgentDisabled: mockIsAgentDisabled,
  isJobDisabledForRepo: mockIsJobDisabledForRepo,
  shouldRunWorkPipeline: () => true,
  getAutoPromotePolicy: () => ({}),
  issueUrl: (repo: string, ref: string | number) => `https://claws.example.invalid/${repo}/issues/${ref}`,
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
  isIssueDispatchSkippable: vi.fn().mockReturnValue(false),
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
  setIssueLifecycle: vi.fn().mockResolvedValue(undefined),
  // The park records its reason with the move; seen here as the Blocked label it adds.
  blockIssue: vi.fn(async (repo: string, ref: unknown, _reason: string): Promise<void> => { await mockGh.addLabel(repo, ref, "Blocked"); }),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
  getIssueState: vi.fn().mockResolvedValue({ state: "OPEN", stateReason: null, labels: [] }),
  getIssueBody: vi.fn().mockResolvedValue(""),
  closeIssue: vi.fn().mockResolvedValue(undefined),
  listPRs: vi.fn().mockResolvedValue([]),
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
const mockDb = vi.hoisted(() => ({ markUntrustedActorNotified: vi.fn().mockReturnValue(true), listClawsPrsForIssue: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  // The real PR read, which a test can make fail once.
  mockDb.listClawsPrsForIssue.mockImplementation(actual.listClawsPrsForIssue);
  return { ...actual, markUntrustedActorNotified: mockDb.markUntrustedActorNotified, listClawsPrsForIssue: mockDb.listClawsPrsForIssue };
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
  findUnreactedFeedbackAfterPlan: vi.fn().mockResolvedValue({ hasPlan: false, unreacted: [], plannedOccurrences: null, hasEscalationReview: false, plannedBodyHash: null }),
  withdrawPlanApprovalForFeedback: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../plan-parser.js", async () => ({
  findPlanComment: vi.fn().mockReturnValue(null),
  parsePlan: vi.fn().mockReturnValue(null),
  duplicateOfFromPlan: (await vi.importActual<typeof import("../plan-parser.js")>("../plan-parser.js")).duplicateOfFromPlan,
  findManualActionsSection: vi.fn().mockReturnValue(null),
}));

const mockImporter = vi.hoisted(() => ({
  importNewIssues: vi.fn().mockResolvedValue(null),
}));
vi.mock("./issue-importer.js", () => mockImporter);

vi.mock("./triage-claws-errors.js", () => ({
  extractFingerprint: vi.fn().mockReturnValue(null),
  REPORT_HEADER: "## Claws Error Investigation Report",
}));

import * as log from "../log.js";
import { run } from "./issue-dispatcher.js";
import * as planParser from "../plan-parser.js";
import type { Issue } from "../github.js";
import type { ApprovedThrough } from "../issue-approval.js";
import { initDb, closeDb, clearAllWorkQueueForTests, listQueuedWork, createClawsIssue, setShadowLifecycle, setClawsIssueApprovedThrough, getLinkedNativeId, recordTaskStart, createClawsIssueLink, getClawsIssue, setClawsIssueState, addClawsIssueRequirementsVersion, addClawsIssueComment, createShadowIssue, promoteClawsIssue, replaceIssuePlannedPRs, linkIssuePlannedPR, upsertIssueReapproval, upsertClawsPr, enqueueWork, _rawDb } from "../db.js";
import * as slack from "../slack.js";
import { AGENT_KINDS, enqueue } from "../worker.js";

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

  /** Give forge issue `n` a shadow at `lifecycle`, approved through `through`. */
  async function inStage(n: number, lifecycle: "planning" | "awaiting-plan-review", through: ApprovedThrough = "requirements"): Promise<string> {
    const shadow = await createShadowIssue(repo.fullName, n, { title: `#${n}`, authorLogin: "someone" });
    await setShadowLifecycle(shadow!.id, lifecycle);
    if (through !== "none") await setClawsIssueApprovedThrough(shadow!.id, through, "test");
    return shadow!.id;
  }

  /** Forge issue `n`'s shadow record. */
  const stageOf = async (n: number) => getClawsIssue((await getLinkedNativeId(repo.fullName, n))!);

  /**
   * Forge issue `n`, Approved — a plan in Awaiting plan review approved
   * through Plan — with no feedback after the plan; its listing entry.
   */
  async function approvedIssue(n: number, overrides: Partial<Issue> = {}): Promise<Issue> {
    await inStage(n, "awaiting-plan-review", "plan");
    vi.mocked(planParser.findPlanComment).mockReturnValue("plan text");
    vi.mocked(planParser.parsePlan).mockReturnValue({ preamble: "", phases: [], totalPhases: 1 } as never);
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({ hasPlan: true, unreacted: [], plannedOccurrences: null, hasEscalationReview: false, plannedBodyHash: null });
    return mockIssue({ number: n, labels: [], ...overrides });
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
    mockIsJobDisabledForRepo.mockReturnValue(true);
    mockImporter.importNewIssues.mockResolvedValue(null);
    mockGh.isRateLimited.mockReturnValue(false);
    mockGh.isRepoRateLimited.mockReturnValue(false);
    mockGh.describeRateLimit.mockReturnValue(null);
    mockGh.isIssueDispatchSkippable.mockReturnValue(false);
    // clearAllMocks() clears calls but not implementations — reset the reads the
    // phase-coverage check makes, or one test's stubbed plan/PR list leaks
    // into the next.
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.setIssueLifecycle.mockResolvedValue(undefined);
    vi.mocked(planParser.findPlanComment).mockReturnValue(null);
    vi.mocked(planParser.parsePlan).mockReturnValue(null as never);
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({ hasPlan: false, unreacted: [], plannedOccurrences: null, hasEscalationReview: false, plannedBodyHash: null });
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([]);
    mockGh.listOpenPRsForIssue.mockResolvedValue([]);
    mockEscalationReviewer.isEscalationCandidate.mockReturnValue(false);
    mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(false);
    mockIssueRefiner.issueContentHash.mockReturnValue("hash-of-live-body");
    // Default: the live read fails, so callers fall back to the issue snapshot the
    // test passed in — no test sees a spurious hash mismatch (#2524).
    mockGh.getIssueTitleBody.mockRejectedValue(new Error("no live read in tests"));
  });

  // An old-build web pod still serving during a rollout writes gate state after the boot migration.
  it("sweeps gate state written after the boot migration into approved_through", async () => {
    const id = await inStage(9100, "awaiting-plan-review");
    await _rawDb().run(`UPDATE claws_issues SET lifecycle = 'approved' WHERE id = ?`, [id]);
    mockGh.listOpenIssues.mockResolvedValue([]);

    await run([repo]);

    expect(await getClawsIssue(id)).toMatchObject({ lifecycle: "awaiting-plan-review", approved_through: "plan" });
  });

  it("enqueues an approved issue without blocking on agent execution", async () => {
    // Regression test for #1155: dispatcher must enqueue and return without
    // running the agent inline. The work_queue + worker fibers handle
    // execution; the dispatcher only schedules.
    const issue = await approvedIssue(1);
    mockGh.listOpenIssues.mockResolvedValue([issue]);

    await run([repo]);

    // Agent must NOT be invoked directly by the dispatcher.
    expect(mockIssueWorker.processIssue).not.toHaveBeenCalled();
    expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 1)).toBe(true);
  });

  // The approval stays on while the implementer works, so Phase 1 must not
  // read it as a fresh "implement" on every tick.
  it("does not dispatch an approved issue whose implementer is already running", async () => {
    const issue = await approvedIssue(9002);
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    await recordTaskStart("issue-worker", repo.fullName, 9002, null);

    await run([repo]);

    expect(await listQueuedWork()).toHaveLength(0);
  });

  // A closed step PR leaves its step uncovered; the approval must not reopen it every tick.
  it("withdraws, and does not re-implement, an approval whose PR was closed without merging", async () => {
    const issue = await approvedIssue(9003);
    const tracker = (await getLinkedNativeId(repo.fullName, 9003))!;
    await _rawDb().run(`UPDATE claws_issues SET plan_approved_at = '2026-01-01 00:00:00' WHERE id = ?`, [tracker]);
    await upsertClawsPr(repo.fullName, 77, { stage: "closed", issueId: tracker });
    mockGh.listOpenIssues.mockResolvedValue([issue]);

    await run([repo]);

    expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER)).toBe(false);
    expect((await stageOf(9003))?.approved_through).toBe("requirements");

    // A fresh approval after the close dispatches again.
    await setClawsIssueApprovedThrough(tracker, "plan", "test");
    await _rawDb().run(`UPDATE claws_issues SET plan_approved_at = '2999-01-01 00:00:00' WHERE id = ?`, [tracker]);
    await run([repo]);
    expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 9003)).toBe(true);
  });

  it("dates the closed PR against the Plan approval, so approving Merge after it does not hide the close", async () => {
    const issue = await approvedIssue(9005);
    const tracker = (await getLinkedNativeId(repo.fullName, 9005))!;
    await _rawDb().run(`UPDATE claws_issues SET plan_approved_at = '2026-01-01 00:00:00' WHERE id = ?`, [tracker]);
    await upsertClawsPr(repo.fullName, 78, { stage: "closed", issueId: tracker });
    // Merge approved after the PR opened: approved_through_at moves, plan_approved_at does not.
    await setClawsIssueApprovedThrough(tracker, "merge", "test");
    await _rawDb().run(`UPDATE claws_issues SET approved_through_at = '2999-01-01 00:00:00' WHERE id = ?`, [tracker]);
    mockGh.listOpenIssues.mockResolvedValue([issue]);

    await run([repo]);

    expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 9005)).toBe(false);
    expect((await stageOf(9005))?.approved_through).toBe("requirements");
  });

  it("dispatches nothing, and says so, when the issue's PRs cannot be read", async () => {
    const issue = await approvedIssue(9006);
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockDb.listClawsPrsForIssue.mockRejectedValueOnce(new Error("db down"));

    await run([repo]);

    expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 9006)).toBe(false);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("could not read its PRs"));
    expect((await stageOf(9006))?.approved_through).toBe("plan");
  });

  it("does not implement an issue awaiting plan review below Plan", async () => {
    await inStage(3, "awaiting-plan-review", "requirements");
    vi.mocked(planParser.findPlanComment).mockReturnValue("plan text");
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({ hasPlan: true, unreacted: [], plannedOccurrences: null, hasEscalationReview: false, plannedBodyHash: null });
    mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 3, labels: [] })]);

    await run([repo]);

    expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER)).toBe(false);
  });

  // A pre-approval: approved through Plan before the plan exists. It plans,
  // and implements only once the plan is posted and in Awaiting plan review.
  it("plans, and does not implement, an issue pre-approved through Plan with no plan yet", async () => {
    await inStage(4, "planning", "plan");
    mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: 4, labels: [] })]);

    await run([repo]);

    const queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_PLAN && w.item_number === 4)).toBe(true);
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER)).toBe(false);
  });

  // docs/issue-tracker.md#links: an open "depends on" target holds the
  // implementer back without the planner having to spot it in prose.
  it("does not implement an approved native issue with an open dependency", async () => {
    const dependent = await createClawsIssue({ title: "Dependent", authorLogin: "stjohnb", repos: [repo.fullName], approvedThrough: "plan", approvedBy: "stjohnb" });
    const dependency = await createClawsIssue({ title: "Dependency", authorLogin: "stjohnb", repos: [repo.fullName] });
    await createClawsIssueLink({ sourceId: dependent, targetId: dependency, kind: "depends_on", createdBy: "x", actingId: dependent });
    vi.mocked(planParser.findPlanComment).mockReturnValue("plan text");
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({ hasPlan: true, unreacted: [], plannedOccurrences: null, hasEscalationReview: false, plannedBodyHash: null });
    mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: dependent, labels: [], lifecycle: "awaiting-plan-review", approvedThrough: "plan" })]);

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
    const dependent = await createClawsIssue({ title: "Dependent", authorLogin: "stjohnb", repos: [repo.fullName], labels: ["Blocked"], blockedReason: "Depends on Dependency" });
    const dependency = await createClawsIssue({ title: "Dependency", authorLogin: "stjohnb", repos: [repo.fullName] });
    await createClawsIssueLink({ sourceId: dependent, targetId: dependency, kind: "depends_on", createdBy: "x", actingId: dependent });
    await setClawsIssueState(dependency, "closed", "completed");

    await run([repo]);

    // No plan and no approved requirements: back to Ideas.
    expect((await getClawsIssue(dependent))?.lifecycle).toBe("ideas");
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(repo.fullName, dependent, expect.stringContaining(`#${dependency} — Dependency (closed as completed)`), { agentName: "Issue links" });
  });

  // docs/issue-tracker.md#backlog: a dated park is the one automated exit
  // from the Backlog. The date is cleared on the way out, so a second tick
  // selects nothing.
  it("brings a native issue back from the Backlog once its return date passes and queues its plan's verification", async () => {
    const parked = await createClawsIssue({ title: "Parked", authorLogin: "stjohnb", repos: [repo.fullName], labels: ["Backlog"] });
    const notYet = await createClawsIssue({ title: "Not yet", authorLogin: "stjohnb", repos: [repo.fullName], labels: ["Backlog"] });
    await _rawDb().run(`UPDATE claws_issues SET backlog_until = '2020-01-01' WHERE id = ?`, [parked]);
    await _rawDb().run(`UPDATE claws_issues SET backlog_until = '2999-01-01' WHERE id = ?`, [notYet]);
    vi.mocked(planParser.findPlanComment).mockReturnValue("plan text");

    await run([repo]);

    expect((await getClawsIssue(parked))?.lifecycle).toBe("planning");
    expect((await getClawsIssue(parked))?.backlog_until ?? null).toBeNull();
    expect((await getClawsIssue(notYet))?.lifecycle).toBe("backlog");
    const verifies = (await listQueuedWork()).filter((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_VERIFY);
    expect(verifies.map((w) => w.item_number)).toEqual([parked]);
  });

  it("staging mode only enqueues staging-labelled issues", async () => {
    const plain = mockIssue({ number: 10, labels: [] });
    const staging = mockIssue({ number: 11, labels: [{ name: "Claws Staging" }] });
    mockGh.listOpenIssues.mockResolvedValue([plain, staging]);
    mockGh.isIssueDispatchSkippable.mockImplementation((_repo: string, issue: { labels: { name: string }[] }) =>
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

  // Backlog is parked through `gh.isIssueDispatchSkippable` → `isParked` (#3293):
  // a backlog issue is never planned, while its neighbour is.
  it("does not plan a Backlog issue", async () => {
    const planning = mockIssue({ number: 20, labels: [] });
    const backlog = mockIssue({ number: 21, labels: [{ name: "Backlog" }] });
    mockGh.listOpenIssues.mockResolvedValue([planning, backlog]);
    await inPlanning(20);
    mockGh.isIssueDispatchSkippable.mockImplementation((_repo: string, issue: { labels: { name: string }[] }) =>
      issue.labels.some((l) => l.name === "Backlog"),
    );

    await run([repo]);

    const queued = await listQueuedWork();
    expect(queued.some((w) => w.item_number === 21)).toBe(false);
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_PLAN && w.item_number === 20)).toBe(true);
  });

  describe("import first (#clw_01M52GPG0E9DP8RQKW6ABH0X7R)", () => {
    beforeEach(() => {
      mockIsJobDisabledForRepo.mockImplementation((job: string) => job !== "issue-importer");
      // The real gate: a forge number waits for import while the importer is on.
      mockGh.isIssueDispatchSkippable.mockImplementation((_repo: string, issue: { number: string | number }) =>
        typeof issue.number === "number");
    });

    it("imports before listing, then works only the native copy", async () => {
      const native = await createClawsIssue({ title: "Imported", authorLogin: "claws", repos: [repo.fullName] });
      const order: string[] = [];
      mockImporter.importNewIssues.mockImplementation(async () => {
        order.push("import");
        return { repo: repo.fullName, imported: 1, failed: 0, skipped: 0 };
      });
      mockGh.listOpenIssues.mockImplementation(async () => {
        order.push("list");
        return [
          mockIssue({ number: 700, labels: [] }),
          mockIssue({ number: 701, labels: [] }),
          mockIssue({ number: native, labels: [], lifecycle: "ideas" }),
        ];
      });

      await run([repo]);

      expect(mockImporter.importNewIssues).toHaveBeenCalledWith(repo);
      expect(order.indexOf("import")).toBeLessThan(order.indexOf("list"));
      const queued = await listQueuedWork();
      expect(queued.filter((w) => w.item_number === 700 || w.item_number === 701)).toEqual([]);
      expect(queued.some((w) => w.kind === AGENT_KINDS.REQUIREMENTS_WRITE && w.item_number === native)).toBe(true);
      expect(mockGh.addLabel).not.toHaveBeenCalled();
      expect(mockGh.removeLabel).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      // No shadow was minted for the held forge issues.
      const shadows = await _rawDb().all(`SELECT forge_number FROM imported_issues WHERE repo = ?`, [repo.fullName]);
      expect(shadows).toEqual([]);
    });

    it("reports an import that throws and still dispatches the tick", async () => {
      const { reportError } = await import("../error-reporter.js");
      const native = await createClawsIssue({ title: "Native", authorLogin: "claws", repos: [repo.fullName] });
      mockImporter.importNewIssues.mockRejectedValue(new Error("forge down"));
      mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: native, labels: [], lifecycle: "ideas" })]);

      await run([repo]);

      expect(reportError).toHaveBeenCalledWith("issue-dispatcher:import", repo.fullName, expect.any(Error), { repo: repo.fullName });
      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.REQUIREMENTS_WRITE && w.item_number === native)).toBe(true);
    });

    it("does not import in a repo with the importer disabled", async () => {
      mockIsJobDisabledForRepo.mockReturnValue(true);
      mockGh.listOpenIssues.mockResolvedValue([]);

      await run([repo]);

      expect(mockImporter.importNewIssues).not.toHaveBeenCalled();
    });
  });

  describe("requirements writer", () => {
    const RECORD = { title: "T", kind: "feature" as const, context: "c", requirement: "r", acceptanceCriteria: ["a"], outOfScope: [] };
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

    // An alert inbox is never retitled by the writer, so it stays the inbox
    // (#clw_01M61M73EW1AMEZPD9V06YW18X).
    it("never writes requirements for an alert issue in Ideas and promotes it with no version, while a plain issue still gets the writer", async () => {
      const alert = await createClawsIssue({ title: "[Alert] production-infra alerts firing", authorLogin: "claws", repos: [repo.fullName], labels: ["alert"], source: "automation" });
      const plain = await createClawsIssue({ title: "Plain", authorLogin: "stjohnb", repos: [repo.fullName] });
      mockGh.listOpenIssues.mockResolvedValue([
        mockIssue({ number: alert, title: "[Alert] production-infra alerts firing", labels: [{ name: "alert" }], lifecycle: "ideas" }),
        mockIssue({ number: plain, labels: [], lifecycle: "ideas" }),
      ]);

      await run([repo]);

      const queued = await listQueuedWork();
      const kindsFor = (ref: string) => queued.filter((w) => w.item_number === ref).map((w) => w.kind);
      expect(kindsFor(alert)).not.toContain(AGENT_KINDS.REQUIREMENTS_WRITE);
      expect(kindsFor(alert)).not.toContain(AGENT_KINDS.REQUIREMENTS_REFINE);
      expect(kindsFor(plain)).toContain(AGENT_KINDS.REQUIREMENTS_WRITE);
      const promoted = await getClawsIssue(alert);
      expect(promoted).toMatchObject({ lifecycle: "planning", title: "[Alert] production-infra alerts firing" });
      expect(promoted?.approved_requirements_version ?? null).toBeNull();
      expect((await getClawsIssue(plain))?.lifecycle).toBe("ideas");
    });

    it("writes no requirements for an agent, automation or session issue and promotes it with none, while a dashboard issue still gets the writer", async () => {
      const skipped = await Promise.all((["agent", "automation", "session"] as const).map((source) =>
        createClawsIssue({ title: `From ${source}`, authorLogin: "claws", repos: [repo.fullName], source })));
      const held = await createClawsIssue({ title: "Held", authorLogin: "claws", repos: [repo.fullName], source: "agent", autoPromote: false });
      const human = await createClawsIssue({ title: "By hand", authorLogin: "stjohnb", repos: [repo.fullName], source: "dashboard" });
      mockGh.listOpenIssues.mockResolvedValue([...skipped, held, human].map((number) => mockIssue({ number, labels: [], lifecycle: "ideas" })));

      await run([repo]);

      const queued = await listQueuedWork();
      const kindsFor = (ref: string) => queued.filter((w) => w.item_number === ref).map((w) => w.kind);
      for (const id of [...skipped, held]) {
        expect(kindsFor(id)).not.toContain(AGENT_KINDS.REQUIREMENTS_WRITE);
        expect(kindsFor(id)).not.toContain(AGENT_KINDS.REQUIREMENTS_REFINE);
      }
      for (const id of skipped) {
        const promoted = await getClawsIssue(id);
        expect(promoted?.lifecycle).toBe("planning");
        expect(promoted?.approved_requirements_version ?? null).toBeNull();
      }
      expect((await getClawsIssue(held))?.lifecycle).toBe("ideas");
      expect(kindsFor(human)).toContain(AGENT_KINDS.REQUIREMENTS_WRITE);
      expect((await getClawsIssue(human))?.lifecycle).toBe("ideas");
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
      // Native issues: feedback is anchored on the stored version, with no
      // requirements comment to key off (#clw_01M3ETY39NX9K7377560D3NAT0).
      await addClawsIssueRequirementsVersion(commented, RECORD, null);
      await addClawsIssueRequirementsVersion(quiet, RECORD, null);
      const humanId = await addClawsIssueComment(commented, HUMAN.login, HUMAN.body);
      mockGh.listOpenIssues.mockResolvedValue([mockIssue({ number: commented, labels: [] }), mockIssue({ number: quiet, labels: [] })]);
      mockIssueRefiner.findUnreactedHumanComments.mockImplementation(async (_repo: string, after: unknown[]) => after);

      await run([repo]);

      const queued = await listQueuedWork();
      const kindsFor = (ref: string) => queued.filter((w) => w.item_number === ref).map((w) => w.kind);
      expect(kindsFor(commented)).toContain(AGENT_KINDS.REQUIREMENTS_REFINE);
      expect(kindsFor(commented)).not.toContain(AGENT_KINDS.REQUIREMENTS_WRITE);
      expect(kindsFor(quiet)).not.toContain(AGENT_KINDS.REQUIREMENTS_REFINE);
      expect(kindsFor(quiet)).not.toContain(AGENT_KINDS.REQUIREMENTS_WRITE);
      expect(mockIssueRefiner.findUnreactedHumanComments).toHaveBeenCalledWith(repo.fullName, [expect.objectContaining({ id: humanId, login: HUMAN.login, body: HUMAN.body })], "claws-bot", commented);
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
    mockGh.isIssueDispatchSkippable.mockReturnValue(true);

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

  it("dispatches an approved CI-failure alert issue to the worker and does not notify Slack", async () => {
    const issue = await approvedIssue(355, {
      title: "[main] Bump app version failed on main",
      author: { login: "app/github-actions" },
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
    expect(vi.mocked(slack.notify).mock.calls[0]![0]).toContain("to `allowedActors` in claws.json if a person");
    expect(mockGh.createIssue).toHaveBeenCalledOnce();
    expect(mockGh.createIssue.mock.calls[0]![1]).toContain("disallowed-actor");
    const body = String(mockGh.createIssue.mock.calls[0]![2]);
    expect(body).toContain("human trust boundary");
    expect(body).not.toContain("This is usually a missing exception");
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

  it("does not Slack-notify a second blocked item from an actor whose alert is already open", async () => {
    const issue = mockIssue({ number: 101, author: { login: "random-human" } });
    mockGh.listOpenIssues.mockImplementation(async (r: string) => r === "test-org/claws"
      ? [{ number: 7, title: "[disallowed-actor] @random-human is blocked from Claws automation", labels: [] }]
      : [issue]);
    mockGh.isAllowedActor.mockResolvedValue(false);
    mockGh.isCiAlertBotAuthor.mockReturnValue(false);
    mockDb.markUntrustedActorNotified.mockReturnValue(true);

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
    expect(slack.notify).not.toHaveBeenCalled();
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

  // The retired Claws Auto-Refine label: an issue is approved through Plan by
  // a person or by the automation that filed it, never by the dispatcher.
  it("writes no approval for a planned issue awaiting plan review", async () => {
    const issue = mockIssue({ number: 350, title: "chore: add .mcp-claws.json to .gitignore" });
    await inStage(350, "awaiting-plan-review", "requirements");
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
      hasPlan: true,
      unreacted: [],
      plannedOccurrences: null,
    });

    await run([repo]);

    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockGh.setIssueLifecycle).not.toHaveBeenCalled();
    expect((await stageOf(350))?.approved_through).toBe("requirements");
    expect(mockGh.populateQueueCacheFor).toHaveBeenCalledWith("ready", repo.fullName, issue, "issue");
    expect(await listQueuedWork()).toHaveLength(0);
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
    async function plannedIssue(number: number, body: string, plannedBodyHash: string | null) {
      await inStage(number, "awaiting-plan-review");
      // Awaiting plan review: a planned issue in Planning is the Planning
      // backstop's, covered on its own below.
      const issue = mockIssue({ number, body, labels: [] });
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

    it("moves the issue to Planning and enqueues ISSUE_REFINER_REPLAN when the uncached read confirms the mismatch", async () => {
      const issue = await plannedIssue(400, "finder-cap — no change", "hash-the-plan-was-written-against");
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(true);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "skip finder-cap" });
      mockIssueRefiner.issueContentHash.mockReturnValue("hash-of-live-body");

      await run([repo]);

      expect(mockGh.setIssueLifecycle).toHaveBeenCalledWith(repo.fullName, 400, "planning");
      expect(mockGh.removeLabel).not.toHaveBeenCalled();
      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 400)).toBe(true);
    });

    it("does not re-plan a non-consolidated alert-bridge issue whose forwarded body no longer matches the plan hash", async () => {
      // Footer-owned only: nothing strips this body's volatile fields, so #60's skip stays.
      const body = "Imported from org/repo#1\n\nNode worker-3 is low on memory.\n\n*Automatically managed by alert-issue-bridge.*";
      const issue = await plannedIssue(406, body, "hash-the-plan-was-written-against");
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(true);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body });

      await run([repo]);

      expect(mockGh.setIssueLifecycle).not.toHaveBeenCalled();
      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 406)).toBe(false);
    });

    describe("consolidated alert-bridge rollups (#clw_01M4ZN75K7GK0G7AFZEHBNCWD5)", () => {
      /** A fleet-infra rollup body: one section per alert, a firing-instances line, and the summed trailing total. */
      const rollup = (sections: string[], total: number, firing = "_None_") => [
        "Imported from St-John-Software/fleet-infra#1",
        "",
        "## Currently firing",
        "",
        firing,
        "",
        "## Alerts",
        "",
        ...sections.map((name) => [
          `### ${name}`,
          "",
          "| Field | Value |",
          "|---|---|",
          "| Severity | warning |",
          "| Status | resolved |",
          "| First occurrence | 2026-10-07T21:22:00Z |",
          "| Last occurrence | 2026-10-15T00:11:05Z |",
          "| Occurrences | 8 |",
          "| Resolved | 2026-10-15T10:34:00Z |",
          "| Source | http://grafana.example/view?orgId=1 |",
          "",
          "<!-- firing-instances: ba6ec64bd4cf857f -->",
          "",
          "**Summary:** …",
          "",
        ].join("\n")),
        "*Automatically managed by alert-issue-bridge. Closed when every alert above is resolved.*",
        "",
        "---",
        "**First seen:** 2026-10-07T21:22:00Z",
        "**Last seen:** 2026-10-15T10:34:00Z",
        `**Occurrences:** ${total}`,
      ].join("\n");

      it("occurrence guard only: does not re-plan a bridge-only update whose trailing total has doubled", async () => {
        const issue = await plannedIssue(410, rollup(["Workload CI Runner Evicted"], 99), "hash-the-plan-was-written-against");
        issue.labels.push({ name: "grafana-alert" });
        // The hash ignores the volatile fields, so the plan is current.
        mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(false);

        await run([repo]);

        expect(mockGh.setIssueLifecycle).not.toHaveBeenCalled();
        expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 410)).toBe(false);
      });

      it("re-plans when a new alert section appears, even with merged PRs", async () => {
        const issue = await plannedIssue(411, rollup(["Workload CI Runner Evicted"], 99), "hash-the-plan-was-written-against");
        issue.labels.push({ name: "grafana-alert" });
        const live = rollup(["Workload CI Runner Evicted", "Disk Space Low"], 100, "- Disk Space Low (warning)");
        mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(true);
        mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: live });
        mockGh.listMergedPRsForIssue.mockResolvedValue([{ number: 900 }]);

        await run([repo]);

        expect(mockGh.setIssueLifecycle).toHaveBeenCalledWith(repo.fullName, 411, "planning");
        expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 411)).toBe(true);
      });

      it("re-plans on a human edit", async () => {
        const issue = await plannedIssue(412, rollup(["Workload CI Runner Evicted"], 99), "hash-the-plan-was-written-against");
        issue.labels.push({ name: "grafana-alert" });
        const live = rollup(["Workload CI Runner Evicted"], 99).replace("Imported from St-John-Software/fleet-infra#1", "Imported from St-John-Software/fleet-infra#1\n\nEvictions are expected during node drains.");
        mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(true);
        mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: live });

        await run([repo]);

        expect(mockGh.setIssueLifecycle).toHaveBeenCalledWith(repo.fullName, 412, "planning");
        expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 412)).toBe(true);
      });
    });

    it("re-plans when only the approved requirements record changed", async () => {
      // Stamped against record v1; the issue now has v2 approved with different
      // text, and an unchanged body. The stub is stale only for the new record.
      const issue = await plannedIssue(407, "unchanged body", "hash-against-record-v1");
      mockApprovedRequirementsFromBatch.mockResolvedValueOnce({ status: "approved", record: { version: 2, requirement: "Re-approved" } });
      mockIssueRefiner.isPlanStaleForIssue.mockImplementation(
        (_plan: string, _title: string, _body: string, requirements?: { version: number } | null) => requirements?.version === 2,
      );
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "unchanged body" });

      await run([repo]);

      expect(mockApprovedRequirementsFromBatch).toHaveBeenCalledWith(repo.fullName, 407, expect.anything());
      expect(mockGh.setIssueLifecycle).toHaveBeenCalledWith(repo.fullName, 407, "planning");
      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 407)).toBe(true);
    });

    it("does not re-plan when the approved-requirements batch read fails — skips the check for the tick", async () => {
      const issue = await plannedIssue(409, "unchanged body", "hash-against-record-v1");
      mockLoadApprovedRequirementsForOpenIssues.mockRejectedValueOnce(new Error("db down"));
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(true);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "unchanged body" });

      await run([repo]);

      expect(mockApprovedRequirementsFromBatch).not.toHaveBeenCalled();
      expect(mockGh.setIssueLifecycle).not.toHaveBeenCalled();
    });

    it("does not read the approved record for an issue whose plan has no stamped hash", async () => {
      await plannedIssue(408, "body", null);

      await run([repo]);

      expect(mockApprovedRequirementsFromBatch).not.toHaveBeenCalledWith(repo.fullName, 408, expect.anything());
    });

    it("does not re-plan when the cached list looks stale but the uncached read matches", async () => {
      // allIssues is 60 s cached — a stale entry must not cost a planner run.
      const issue = await plannedIssue(401, "cached body", "hash-of-live-body");
      // Cached check (against issue.body) says stale; the confirming live check
      // (against the uncached read) says it matches — both go through the same
      // isPlanStaleForIssue helper now, so distinguish by call order.
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValueOnce(true).mockReturnValueOnce(false);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "live body" });

      await run([repo]);

      expect(mockGh.setIssueLifecycle).not.toHaveBeenCalled();
      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 401)).toBe(false);
    });

    it("does not re-plan a Claws-maintained alert issue on a hash mismatch — it falls through to the occurrence logic", async () => {
      // ensureAlertIssue rewrites these bodies every monitor tick; without this the
      // whole monitor fleet re-plans on every dispatcher tick.
      const issue = await plannedIssue(402, "disk at 80%" + OCC_BLOCK, "hash-the-plan-was-written-against");
      // Cached check says stale; the live check — same helper, real semantics would
      // exempt an occurrence-tracked body — says not stale, so this site no-ops and
      // the occurrence rule below is what actually queues the re-plan.
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValueOnce(true).mockReturnValueOnce(false);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "disk at 92%" + OCC_BLOCK });

      await run([repo]);

      expect(mockGh.setIssueLifecycle).not.toHaveBeenCalled();
      // The occurrence rule still governs it: 2 >= planned 1 * factor 2.
      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 402)).toBe(true);
    });

    it("does not re-plan a legacy plan carrying no stamped hash", async () => {
      await plannedIssue(403, "any body", null);
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(true);

      await run([repo]);

      expect(mockGh.getIssueTitleBody).not.toHaveBeenCalled();
      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 403)).toBe(false);
    });

    it("does not re-plan when the uncached read fails", async () => {
      await plannedIssue(404, "any body", "hash-the-plan-was-written-against");
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(true);
      mockGh.getIssueTitleBody.mockRejectedValue(new Error("gh down"));

      await run([repo]);

      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 404)).toBe(false);
    });

    it("does not re-plan a multi-PR continuation whose earlier phase already merged", async () => {
      // Between "PR 1 merged" and Phase 3's continuation the issue has no open PR,
      // so it lands here. Re-planning would discard the agreed multi-phase plan
      // Phase 3 is concurrently implementing against.
      const issue = await plannedIssue(406, "edited body", "hash-the-plan-was-written-against");
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(true);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "edited body" });
      mockGh.listMergedPRsForIssue.mockResolvedValue([{ number: 900 }]);

      await run([repo]);

      expect(mockGh.setIssueLifecycle).not.toHaveBeenCalled();
      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 406)).toBe(false);
    });

    it("lets the escalation review win over the hash check", async () => {
      // Same ordering rule as the occurrence trigger: the escalation reviewer must
      // get exactly one run per posted plan, or it is starved forever.
      const issue = await plannedIssue(405, "edited body", "hash-the-plan-was-written-against");
      mockIssueRefiner.isPlanStaleForIssue.mockReturnValue(true);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "edited body" });
      mockEscalationReviewer.isEscalationCandidate.mockReturnValue(true);

      await run([repo]);

      const queued = await listQueuedWork();
      expect(queued.some((w) => w.kind === AGENT_KINDS.ESCALATION_REVIEW && w.item_number === 405)).toBe(true);
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 405)).toBe(false);
    });
  });

  describe("Planning backstop (#clw_01M4EPRM9SYVGFG2BTZTMQEKDJ)", () => {
    /** A planned issue whose stored lifecycle reads Planning. */
    async function planningIssue(number: number, plannedBodyHash: string | null, labels: { name: string }[] = []) {
      await inStage(number, "planning");
      const issue = mockIssue({ number, labels });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
        hasPlan: true, unreacted: [], plannedOccurrences: 1, hasEscalationReview: false, plannedBodyHash,
      });
      return issue;
    }
    const queued = async (kind: string, number: number) =>
      (await listQueuedWork()).filter((w) => w.kind === kind && w.item_number === number).length;

    it("returns a planned issue with a current plan and no planner to plan review", async () => {
      await planningIssue(601, "hash-the-plan-was-written-against");

      await run([repo]);

      expect(mockGh.setIssueLifecycle).toHaveBeenCalledWith(repo.fullName, 601, "awaiting-plan-review");
      expect(await queued(AGENT_KINDS.ISSUE_REFINER_REPLAN, 601)).toBe(0);
    });

    it("re-plans an alert inbox with an untriaged section instead of returning it to plan review", async () => {
      const issue = await planningIssue(605, "hash-the-plan-was-written-against", [{ name: "grafana-alert" }]);
      const body = "## Alerts\n\n### Node Memory Low\n\n| Field | Value |\n|---|---|\n| Status | firing |\n";
      issue.body = body;
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body });

      await run([repo]);

      expect(mockGh.setIssueLifecycle).not.toHaveBeenCalled();
      expect(await queued(AGENT_KINDS.ISSUE_REFINER_REPLAN, 605)).toBe(1);
    });

    it("re-plans a planned issue with no stamped hash and no planner", async () => {
      await planningIssue(602, null);

      await run([repo]);

      expect(await queued(AGENT_KINDS.ISSUE_REFINER_REPLAN, 602)).toBe(1);
      expect(mockGh.setIssueLifecycle).not.toHaveBeenCalled();
    });

    it("leaves an issue alone while its planner is queued", async () => {
      await planningIssue(603, "hash-the-plan-was-written-against");
      await enqueue(AGENT_KINDS.ISSUE_REFINER_REPLAN, repo.fullName, 603);

      await run([repo]);

      expect(mockGh.setIssueLifecycle).not.toHaveBeenCalled();
      expect(await queued(AGENT_KINDS.ISSUE_REFINER_REPLAN, 603)).toBe(1);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("in Planning awaiting its re-plan"));
    });

    it("closes a Duplicate issue and never enqueues it", async () => {
      await planningIssue(604, null, [{ name: "Duplicate" }]);

      await run([repo]);

      expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, 604, "not_planned");
      expect((await listQueuedWork()).some((w) => w.item_number === 604)).toBe(false);
    });

    it("parks a single-step plan whose PR merged saying only `Part of`", async () => {
      await planningIssue(605, "hash-the-plan-was-written-against");
      mockGh.listMergedPRsForIssue.mockResolvedValue([{ number: 28, title: "fix: part", headRefName: "claws/issue-605-a", body: "Part of #605" }]);

      await run([repo]);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(repo.fullName, 605, expect.stringContaining("PR #28 merged without closing this issue"), expect.anything());
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 605, "Blocked");
      expect(mockGh.setIssueLifecycle).not.toHaveBeenCalled();
    });

    it("closes a single-step plan whose merged PR closes the issue", async () => {
      await planningIssue(606, "hash-the-plan-was-written-against");
      mockGh.listMergedPRsForIssue.mockResolvedValue([{ number: 29, title: "fix: all", headRefName: "claws/issue-606-a", body: "Closes #606" }]);

      await run([repo]);

      expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, 606, "completed");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 606, "Blocked");
    });

    it("logs a warning and still settles the next issue when settling one throws", async () => {
      const first = mockIssue({ number: 607, labels: [] });
      const second = mockIssue({ number: 608, labels: [] });
      await inStage(607, "planning");
      await inStage(608, "planning");
      mockGh.listOpenIssues.mockResolvedValue([first, second]);
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
        hasPlan: true, unreacted: [], plannedOccurrences: 1, hasEscalationReview: false, plannedBodyHash: "hash-the-plan-was-written-against",
      });
      mockGh.setIssueLifecycle.mockRejectedValueOnce(new Error("lifecycle write failed"));

      await run([repo]);

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Could not settle Planning issue"));
      expect(mockGh.setIssueLifecycle).toHaveBeenCalledWith(repo.fullName, 608, "awaiting-plan-review");
    });

    it("leaves an unapproved issue in Awaiting plan review alone", async () => {
      const issue = mockIssue({ number: 610, labels: [] });
      await inStage(610, "awaiting-plan-review");
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
        hasPlan: true, unreacted: [], plannedOccurrences: 1, hasEscalationReview: false, plannedBodyHash: "hash-the-plan-was-written-against",
      });

      await run([repo]);

      expect(mockGh.setIssueLifecycle).not.toHaveBeenCalled();
      expect(await listQueuedWork()).toHaveLength(0);
      expect(mockGh.populateQueueCacheFor).toHaveBeenCalledWith("ready", repo.fullName, issue, "issue");
    });

    it("settles a duplicate-verdict issue even when it has an open PR", async () => {
      const issue = mockIssue({ number: 609, labels: [] });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockGh.listOpenPRsForIssue.mockResolvedValue([{ number: 55, title: "fix: dup" }]);
      vi.mocked(planParser.findPlanComment).mockReturnValue("## Implementation Plan\n\nCLAWS_DUPLICATE_OF: #12");
      vi.mocked(planParser.parsePlan).mockReturnValue({ preamble: "", phases: [], totalPhases: 1 });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nCLAWS_DUPLICATE_OF: #12", login: "claws-bot", created_at: "2024-01-01T00:00:00Z" },
      ]);
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
        hasPlan: true, unreacted: [{ id: 2, body: "hi", login: "human" }], plannedOccurrences: 1, hasEscalationReview: false, plannedBodyHash: null,
      });

      await run([repo]);

      expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, 609, expect.anything());
      expect((await listQueuedWork()).some((w) => w.item_number === 609)).toBe(false);
    });
  });

  describe("multi-PR continuation (Phase 3)", () => {
    const multiPRPlan = { totalPhases: 3, phases: [] };

    /** Issue `number`, approved through Plan, with a three-step plan. */
    async function multiPRIssue(number: number) {
      await inStage(number, "awaiting-plan-review", "plan");
      const issue = mockIssue({ number, labels: [] });
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      vi.mocked(planParser.findPlanComment).mockReturnValue("plan text");
      vi.mocked(planParser.parsePlan).mockReturnValue(multiPRPlan as never);
      // A planned issue: Phase 2 must not queue a re-plan, which would hold
      // the continuation behind pending planner work.
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({ hasPlan: true, unreacted: [], plannedOccurrences: null, hasEscalationReview: false, plannedBodyHash: null });
      return issue;
    }

    const continued = async (number: number) =>
      (await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER_CONTINUE && w.item_number === number);

    it("continues an issue whose only covered phase came from a non-Claws PR", async () => {
      // The old gate was `listMergedPRsForIssue().length === 0 → skip`, which sees
      // `claws/issue-<N>-` branches only: an issue whose steps all shipped from
      // outside Claws was never continued at all (#2594).
      await multiPRIssue(501);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
        { number: 70, title: "fix(#501): step one (1/3)", body: "Part of #501", state: "merged" },
      ]);

      await run([repo]);

      expect(await continued(501)).toBe(true);
    });

    // Phase 3 continues only an issue in Awaiting plan review, so the Planning
    // backstop must move a mid-plan issue there rather than leave it stranded.
    it("returns a still-approved multi-step issue left in Planning to plan review, and continues it next tick", async () => {
      await multiPRIssue(507);
      const id = await getLinkedNativeId(repo.fullName, 507);
      await setShadowLifecycle(id!, "planning");
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({ hasPlan: true, unreacted: [], plannedOccurrences: null, hasEscalationReview: false, plannedBodyHash: "hash-the-plan-was-written-against" });
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
        { number: 75, title: "fix(#507): step one (1/3)", body: "Part of #507", state: "merged" },
      ]);
      mockGh.setIssueLifecycle.mockImplementation(async (_repo: string, _ref: unknown, lifecycle: string) => {
        await setShadowLifecycle(id!, lifecycle as "awaiting-plan-review");
      });

      await run([repo]);

      expect(mockGh.setIssueLifecycle).toHaveBeenCalledWith(repo.fullName, 507, "awaiting-plan-review");
      expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REPLAN && w.item_number === 507)).toBe(false);
      await run([repo]);
      expect(await continued(507)).toBe(true);
    });

    // docs/jobs/issue-dispatcher.md "Follow-up response": a design change
    // pending re-approval holds the whole plan, continuations included.
    it("neither continues nor implements an issue whose design change is pending re-approval", async () => {
      await multiPRIssue(505);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
        { number: 73, title: "fix(#505): step one (1/3)", body: "Part of #505", state: "merged" },
      ]);
      const shadow = await createShadowIssue(repo.fullName, 505, { title: "#505", authorLogin: "someone" });
      await upsertIssueReapproval({ issueId: shadow!.id, requirementsVersion: 2, planCommentId: null, prs: [], fates: [], sourceCommentIds: [] });

      await run([repo]);

      const queued = await listQueuedWork();
      expect(queued.some((w) => (w.kind === AGENT_KINDS.ISSUE_WORKER || w.kind === AGENT_KINDS.ISSUE_WORKER_CONTINUE) && w.item_number === 505)).toBe(false);
      expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining("#505: design change pending re-approval"));
      await _rawDb().run(`DELETE FROM claws_issue_reapprovals`);
    });

    // A Backlog return's verify run may still revise the plan; continuing
    // alongside it would race the revision.
    it("does not continue an issue whose planner work is still queued", async () => {
      await multiPRIssue(506);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
        { number: 74, title: "fix(#506): step one (1/3)", body: "Part of #506", state: "merged" },
      ]);
      await enqueueWork("issue-refiner:verify", repo.fullName, 506);

      await run([repo]);

      expect(await continued(506)).toBe(false);
    });

    it("does not continue an issue with no covered phase at all", async () => {
      await multiPRIssue(502);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([]);

      await run([repo]);

      expect(await continued(502)).toBe(false);
    });

    it("does not continue while a covered phase's PR is still open", async () => {
      await multiPRIssue(503);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
        { number: 71, title: "fix(#503): step one (1/3)", body: "Part of #503", state: "open" },
      ]);

      await run([repo]);

      expect(await continued(503)).toBe(false);
    });

    it("continues a parallel plan while a sibling phase's PR is still open", async () => {
      await multiPRIssue(504);
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

    // An operator-step hold gates only its own PR's merge: the issue is not
    // parked, and a ready step that does not depend on the held one starts
    // (#clw_01M5220Y7EWQG1X0H3Y3T45J81).
    it("continues a ready step while another step's PR waits on an operator-step hold", async () => {
      await multiPRIssue(507);
      vi.mocked(planParser.parsePlan).mockReturnValue({
        totalPhases: 3,
        phases: [
          { phaseNumber: 1, title: "a", description: "", dependsOn: null },
          { phaseNumber: 2, title: "b", description: "", dependsOn: [1] },
          { phaseNumber: 3, title: "c", description: "", dependsOn: [1] },
        ],
      } as never);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
        { number: 74, title: "fix(#507): step one (1/3)", body: "Part of #507", state: "merged" },
        { number: 75, title: "fix(#507): step two (2/3)", body: "Part of #507", state: "open" },
      ]);
      await upsertClawsPr(repo.fullName, 75, { phase: 2, stage: "awaiting-merge", ciStatus: "passing", manualActionReason: "Cut over after the install" });

      await run([repo]);

      expect(await continued(507)).toBe(true);
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 507, "Blocked");
    });

    describe("a stored list ending in a manual (operator) step", () => {
      async function awaitingOperator(number: number): Promise<void> {
        await multiPRIssue(number);
        const shadow = await createShadowIssue(repo.fullName, number, { title: `#${number}`, authorLogin: "someone" });
        await replaceIssuePlannedPRs(shadow!.id, [
          { repo: repo.fullName, title: "Move" },
          { repo: repo.fullName, title: "Cut over" },
          { repo: repo.fullName, title: "Manual actions (operator)", kind: "manual", dependsOn: [1, 2] },
        ]);
        await linkIssuePlannedPR(shadow!.id, 1, 80);
        await linkIssuePlannedPR(shadow!.id, 2, 81);
        mockGh.getPRState.mockResolvedValue("MERGED");
      }

      it("neither continues nor closes the issue while the operator step is open", async () => {
        await awaitingOperator(505);

        await run([repo]);

        expect(await continued(505)).toBe(false);
        expect(mockGh.closeIssue).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("#505: awaiting the operator on step 3"));
      });

      it("announces an operator step placed first, which no merge or worker task would", async () => {
        await multiPRIssue(508);
        const shadow = await createShadowIssue(repo.fullName, 508, { title: "#508", authorLogin: "someone" });
        await replaceIssuePlannedPRs(shadow!.id, [
          { repo: repo.fullName, title: "Manual actions (operator)", kind: "manual" },
          { repo: repo.fullName, title: "Cut over", dependsOn: [1] },
        ]);

        await run([repo]);

        expect(await continued(508)).toBe(false);
        expect(mockGh.blockIssue).toHaveBeenCalledWith(repo.fullName, 508, expect.stringContaining("claws-awaiting-operator"));
      });

      it("closes the issue on the tick after a trusted claws-phase-done claims the operator step", async () => {
        await awaitingOperator(506);
        mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: "claws-phase-done: 3", login: "stjohnb" }]);

        await run([repo]);

        expect(await continued(506)).toBe(false);
        expect(mockGh.commentOnIssue).toHaveBeenCalledWith(repo.fullName, 506, expect.stringContaining("All 3 steps of the plan have landed or been marked done"), { agentName: "Implementer" });
        expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, 506, "completed");
      });

      it("answers human feedback on an approved issue whose only open step is the operator's", async () => {
        await awaitingOperator(508);
        const comment = { id: 46, body: "change the approach for step 3", login: "human" };
        mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({ hasPlan: true, unreacted: [comment], plannedOccurrences: null, hasEscalationReview: false, plannedBodyHash: null });

        await run([repo]);

        expect(mockIssueRefiner.withdrawPlanApprovalForFeedback).toHaveBeenCalledWith(repo.fullName, 508, [comment], "Planner");
        expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REFINE && w.item_number === 508)).toBe(true);
        expect(await continued(508)).toBe(false);
      });
    });

    it("does not continue a multi-step issue whose approval was withdrawn", async () => {
      await multiPRIssue(509);
      await setClawsIssueApprovedThrough((await getLinkedNativeId(repo.fullName, 509))!, "requirements", "test");
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
        { number: 74, title: "fix(#509): step one (1/3)", body: "Part of #509", state: "merged" },
      ]);

      await run([repo]);

      expect(await continued(509)).toBe(false);
    });
  });

  describe("approved through Plan with unaddressed human feedback (#2772)", () => {
    /** Forge issue `n`, Approved, with `unreacted` after the plan. */
    async function approvedWithFeedback(n: number, unreacted: { id: number; body: string; login: string }[]): Promise<Issue> {
      const issue = await approvedIssue(n);
      mockGh.listOpenIssues.mockResolvedValue([issue]);
      mockIssueRefiner.findUnreactedFeedbackAfterPlan.mockResolvedValue({
        hasPlan: true,
        unreacted,
        plannedOccurrences: null,
        hasEscalationReview: false,
        plannedBodyHash: null,
      });
      return issue;
    }

    it("withdraws the Plan approval and enqueues a re-plan when there is no open PR", async () => {
      const comment = { id: 42, body: "please do X instead", login: "human" };
      await approvedWithFeedback(600, [comment]);

      await run([repo]);

      expect(mockIssueRefiner.withdrawPlanApprovalForFeedback).toHaveBeenCalledWith(
        repo.fullName, 600, [comment], "Planner",
      );
      // The withdrawal is the refiner's write; the dispatcher writes no label.
      expect(mockGh.removeLabel).not.toHaveBeenCalled();
      const queued = await listQueuedWork();
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_REFINE && w.item_number === 600)).toBe(true);
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 600)).toBe(false);
    });

    // An open PR covers its step, so the issue is under way: the feedback is a
    // follow-up on that PR and the approval stands.
    it("enqueues a follow-up, keeping the approval, when a PR is already open", async () => {
      const comment = { id: 43, body: "please do X instead", login: "human" };
      await approvedWithFeedback(601, [comment]);
      mockGh.listOpenPRsForIssue.mockResolvedValue([{ number: 9, title: "wip", headRefName: "claws/issue-601-abc" }]);

      await run([repo]);

      expect(mockIssueRefiner.withdrawPlanApprovalForFeedback).not.toHaveBeenCalled();
      expect((await stageOf(601))?.approved_through).toBe("plan");
      const queued = await listQueuedWork();
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_FOLLOWUP && w.item_number === 601)).toBe(true);
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 601)).toBe(false);
    });

    it("excludes a pure claws-phase-done claim from pending feedback", async () => {
      await approvedWithFeedback(604, [{ id: 44, body: "claws-phase-done: 1", login: "human" }]);

      await run([repo]);

      expect(mockIssueRefiner.withdrawPlanApprovalForFeedback).not.toHaveBeenCalled();
      const queued = await listQueuedWork();
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 604)).toBe(true);
    });

    it("still treats a claim comment with real feedback attached as pending feedback", async () => {
      const mixedComment = { id: 45, body: "claws-phase-done: 1 — also please rename X", login: "human" };
      await approvedWithFeedback(605, [mixedComment]);

      await run([repo]);

      expect(mockIssueRefiner.withdrawPlanApprovalForFeedback).toHaveBeenCalledWith(
        repo.fullName, 605, [mixedComment], "Planner",
      );
    });

    it("enqueues the worker as normal with no unaddressed feedback, writing no approval", async () => {
      await approvedWithFeedback(602, []);

      await run([repo]);

      expect(mockIssueRefiner.withdrawPlanApprovalForFeedback).not.toHaveBeenCalled();
      expect(mockGh.addLabel).not.toHaveBeenCalled();
      expect((await stageOf(602))?.approved_through).toBe("plan");
      const queued = await listQueuedWork();
      expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 602)).toBe(true);
    });
  });

  // The approval is one stored value, read on every tick: a multi-step plan
  // approved through Plan runs step after step with no approval write between.
  it("dispatches step 2 of a two-step plan approved through Plan after step 1 merges, with no approval write", async () => {
    const issue = await approvedIssue(620);
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    vi.mocked(planParser.parsePlan).mockReturnValue({
      totalPhases: 2,
      phases: [
        { phaseNumber: 1, title: "a", description: "", dependsOn: null },
        { phaseNumber: 2, title: "b", description: "", dependsOn: [1] },
      ],
    } as never);

    // Tick 1: nothing covered — Phase 1 dispatches step 1.
    await run([repo]);
    let queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 620)).toBe(true);
    await clearAllWorkQueueForTests();

    // Tick 2: step 1 merged — Phase 3 continues with step 2, Phase 1 stays off.
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
      { number: 80, title: "fix(#620): step one (1/2)", body: "Part of #620", state: "merged" },
    ]);
    await run([repo]);
    queued = await listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER_CONTINUE && w.item_number === 620)).toBe(true);
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 620)).toBe(false);

    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
    expect(mockGh.setIssueLifecycle).not.toHaveBeenCalled();
    const record = await stageOf(620);
    expect(record?.approved_through).toBe("plan");
    expect(record?.approved_through_by).toBe("test");
  });

  it("settles an approved single-step issue whose step merged while it stayed open", async () => {
    const issue = await approvedIssue(621);
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    const merged = { number: 81, title: "fix: all", headRefName: "claws/issue-621-a", body: "Closes #621" };
    mockGh.listMergedPRsForIssue.mockResolvedValue([merged]);
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([{ number: 81, title: "fix: all", body: "Closes #621", state: "merged" }]);

    await run([repo]);

    expect(mockGh.closeIssue).toHaveBeenCalledWith(repo.fullName, 621, "completed");
    expect((await listQueuedWork()).some((w) => w.item_number === 621)).toBe(false);
  });

  it("does not implement an approved single-step issue covered by an open target PR found only by its `Closes` reference (#3050)", async () => {
    const issue = await approvedIssue(622);
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([{ number: 82, title: "fix: target", body: "Closes #622", state: "open" }]);

    await run([repo]);

    expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 622)).toBe(false);
    expect(mockGh.closeIssue).not.toHaveBeenCalled();
  });

  it("does not implement an approved multi-step plan whose open PR has an unknown step (no ready phase)", async () => {
    const issue = await approvedIssue(623);
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    vi.mocked(planParser.parsePlan).mockReturnValue({
      totalPhases: 2,
      phases: [
        { phaseNumber: 1, title: "a", description: "", dependsOn: null },
        { phaseNumber: 2, title: "b", description: "", dependsOn: [1] },
      ],
    } as never);
    // An unmarked open branch PR on a multi-step plan: its step is unknown, so nothing is ready.
    mockGh.listOpenPRsForIssue.mockResolvedValue([{ number: 83, title: "fix: something", headRefName: "claws/issue-623-a", body: "" }]);

    await run([repo]);

    expect((await listQueuedWork()).some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 623)).toBe(false);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(expect.stringContaining(`Not implementing ${repo.fullName}#623: no plan phase is ready`));
  });

});
