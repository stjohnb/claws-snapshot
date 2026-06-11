import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { mockRepo, mockIssue } from "../test-helpers.js";

const mockIsAgentDisabled = vi.hoisted(() => vi.fn().mockReturnValue(false));
vi.mock("../config.js", () => ({
  DB_PATH: ":memory:",
  SELF_REPO: "test-org/claws",
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    duplicate: "Duplicate",
    problematic: "Claws Problematic",
  },
  isAgentDisabled: mockIsAgentDisabled,
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
  isDispatchSkippable: vi.fn().mockReturnValue(false),
  hasPriorityLabel: vi.fn().mockReturnValue(false),
  getOpenPRForIssue: vi.fn().mockResolvedValue(null),
  getIssueComments: vi.fn().mockResolvedValue([]),
  listMergedPRsForIssue: vi.fn().mockResolvedValue([]),
  populateQueueCache: vi.fn(),
  removeLabel: vi.fn().mockResolvedValue(undefined),
  addLabel: vi.fn().mockResolvedValue(undefined),
  isRateLimited: vi.fn().mockReturnValue(false),
  isClawsComment: vi.fn().mockReturnValue(false),
  RateLimitError: class RateLimitError extends Error {},
  isAllowedActor: vi.fn().mockResolvedValue(true),
  isCiFailureAlertIssue: vi.fn().mockReturnValue(false),
  isCiAlertBotAuthor: vi.fn().mockReturnValue(false),
  searchIssues: vi.fn().mockResolvedValue([]),
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
  findUnreactedFeedbackAfterPlan: vi.fn().mockResolvedValue({ hasPlan: false, unreacted: [] }),
  PLAN_HEADER: "## Implementation Plan",
}));
vi.mock("../agents/issue-refiner.js", () => mockIssueRefiner);

vi.mock("../plan-parser.js", () => ({
  findPlanComment: vi.fn().mockReturnValue(null),
  parsePlan: vi.fn().mockReturnValue(null),
}));

vi.mock("./triage-claws-errors.js", () => ({
  extractFingerprint: vi.fn().mockReturnValue(null),
  REPORT_HEADER: "## Claws Error Investigation Report",
}));

vi.mock("./triage-kwyjibo-errors.js", () => ({
  extractGameId: vi.fn().mockReturnValue(null),
  REPORT_HEADER: "## Bug Investigation Report",
}));

import { run } from "./issue-dispatcher.js";
import { initDb, closeDb, clearAllWorkQueueForTests, listQueuedWork } from "../db.js";
import * as slack from "../slack.js";
import { AGENT_KINDS } from "../worker.js";

describe("issue-dispatcher", () => {
  const repo = mockRepo();

  beforeAll(() => {
    initDb();
  });

  afterAll(() => {
    closeDb();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllWorkQueueForTests();
    mockIsAgentDisabled.mockReturnValue(false);
    mockGh.isRateLimited.mockReturnValue(false);
    mockGh.isDispatchSkippable.mockReturnValue(false);
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

  it("dispatches a CI-failure alert issue and does not notify Slack", async () => {
    const issue = mockIssue({
      number: 354,
      title: "[main] Bump app version failed on main",
      author: { login: "app/github-actions" },
    });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(false);
    mockGh.isCiFailureAlertIssue.mockReturnValue(true);

    await run([repo]);

    const queued = listQueuedWork();
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
    mockGh.isCiFailureAlertIssue.mockReturnValue(true);

    await run([repo]);

    const queued = listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_WORKER && w.item_number === 355)).toBe(true);
    expect(slack.notify).not.toHaveBeenCalled();
  });

  it("skips and Slack-notifies an untrusted non-CI issue on first encounter", async () => {
    const issue = mockIssue({ number: 100 });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(false);
    mockGh.isCiFailureAlertIssue.mockReturnValue(false);
    mockDb.markUntrustedActorNotified.mockReturnValue(true);

    await run([repo]);

    expect(listQueuedWork()).toHaveLength(0);
    expect(slack.notify).toHaveBeenCalledOnce();
    expect(mockGh.createIssue).toHaveBeenCalledOnce();
    expect(mockGh.createIssue.mock.calls[0]![1]).toContain("disallowed-actor");
  });

  it("does not re-notify Slack for an already-notified untrusted issue", async () => {
    const issue = mockIssue({ number: 100 });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(false);
    mockGh.isCiFailureAlertIssue.mockReturnValue(false);
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
    mockGh.isCiFailureAlertIssue.mockReturnValue(true);

    await run([repo]);

    const queued = listQueuedWork();
    expect(queued.some((w) => w.kind === AGENT_KINDS.ISSUE_REFINER_PLAN && w.item_number === 412)).toBe(true);
    expect(slack.notify).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("silently skips a github-actions[bot] issue that is not a recognised CI alert", async () => {
    const issue = mockIssue({
      number: 500,
      title: "Weekly dependency digest",
      author: { login: "github-actions[bot]" },
    });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(false);
    mockGh.isCiFailureAlertIssue.mockReturnValue(false);
    mockGh.isCiAlertBotAuthor.mockReturnValue(true);

    await run([repo]);

    expect(listQueuedWork()).toHaveLength(0);
    expect(slack.notify).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
    expect(mockDb.markUntrustedActorNotified).not.toHaveBeenCalled();
  });

  it("still Slack-notifies and alerts a genuine non-bot disallowed actor", async () => {
    const issue = mockIssue({ number: 200, author: { login: "random-human" } });
    mockGh.listOpenIssues.mockResolvedValue([issue]);
    mockGh.isAllowedActor.mockResolvedValue(false);
    mockGh.isCiFailureAlertIssue.mockReturnValue(false);
    mockGh.isCiAlertBotAuthor.mockReturnValue(false);
    mockDb.markUntrustedActorNotified.mockReturnValue(true);

    await run([repo]);

    expect(slack.notify).toHaveBeenCalledOnce();
    expect(mockGh.createIssue).toHaveBeenCalledOnce();
  });
});
