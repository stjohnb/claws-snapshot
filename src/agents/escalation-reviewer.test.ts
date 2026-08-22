import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockIssue } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: { refined: "Refined", priority: "Priority" },
}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../log.js", () => mockLog);

const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../slack.js", () => ({ notify: mockNotify }));

const { mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockGh: {
    getIssueComments: vi.fn(),
    isClawsComment: vi.fn().mockReturnValue(true),
    hasPriorityLabel: vi.fn((labels: { name: string }[]) => labels.some((l) => l.name === "Priority")),
    // Mirrors the real implementation in github.ts — the author check depends on
    // it collapsing the `app/<slug>` and `<slug>[bot]` forms onto each other.
    normalizeBotLogin: vi.fn((login: string) =>
      login.startsWith("app/") ? `${login.slice("app/".length)}[bot]` : login,
    ),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
    addLabel: vi.fn().mockResolvedValue(undefined),
  },
  mockClaude: {
    ensureScratchDir: vi.fn().mockReturnValue("/tmp/scratch"),
    runClaude: vi.fn(),
    TEXT_ONLY_DISALLOWED_TOOLS: ["Edit"],
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(7),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
    trackTaskTokens: vi.fn().mockReturnValue(vi.fn()),
    withTaskRecording: vi.fn(async (
      jobName: string,
      repo: string,
      itemNumber: number,
      triggerLabel: string | null,
      fn: (taskId: number) => Promise<unknown>,
    ) => {
      const id = mockDb.recordTaskStart(jobName, repo, itemNumber, triggerLabel);
      try {
        return await fn(id);
      } catch (err) {
        mockDb.recordTaskFailed(id, String(err), { failureCategory: "unknown" });
        throw err;
      }
    }),
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

// Mocked to keep the planner's large dependency graph out of this test — only the
// two header constants are used, and they must match the real ones.
const PLAN_HEADER = "## Implementation Plan";
const ESCALATION_REVIEW_HEADER = "## Escalation Review";
vi.mock("./issue-refiner.js", () => ({
  PLAN_HEADER: "## Implementation Plan",
  ESCALATION_REVIEW_HEADER: "## Escalation Review",
}));

import { isEscalationCandidate, reviewPlanAndEscalate } from "./escalation-reviewer.js";

const SELF = "claws-bot";

function alertIssue(overrides: Partial<ReturnType<typeof mockIssue>> = {}) {
  return mockIssue({
    number: 971,
    title: "[k3s] Flux Kustomization NotReady: flux-system/infrastructure",
    body: "**Reason:** build failed",
    labels: [{ name: "Priority" }],
    author: { login: SELF },
    ...overrides,
  });
}

function planComment(body = `${PLAN_HEADER}\n\nChange one line in the manifest.`) {
  return { id: 1, body, body_html: "", login: SELF };
}

describe("escalation-reviewer", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.isClawsComment.mockReturnValue(true);
    mockGh.getIssueComments.mockResolvedValue([planComment()]);
    mockClaude.runClaude.mockResolvedValue(`{"verdict":"proceed","reason":"One-line manifest fix."}`);
  });

  describe("isEscalationCandidate", () => {
    it("accepts a self-authored [k3s] Priority alert", () => {
      expect(isEscalationCandidate(alertIssue(), SELF)).toBe(true);
    });

    it("accepts the gh-CLI `app/<slug>` author form against the REST `<slug>[bot]` self login", () => {
      expect(isEscalationCandidate(alertIssue({ author: { login: "app/claws-bot" } }), "claws-bot[bot]")).toBe(true);
    });

    it("rejects an issue authored by someone else", () => {
      expect(isEscalationCandidate(alertIssue({ author: { login: "attacker" } }), SELF)).toBe(false);
    });

    it("rejects an issue without the Priority label", () => {
      expect(isEscalationCandidate(alertIssue({ labels: [] }), SELF)).toBe(false);
    });

    it("rejects an issue whose title is not a [k3s] alert", () => {
      expect(isEscalationCandidate(alertIssue({ title: "Add a dark mode toggle" }), SELF)).toBe(false);
    });
  });

  describe("reviewPlanAndEscalate", () => {
    it("does nothing when no plan comment exists yet", async () => {
      mockGh.getIssueComments.mockResolvedValue([]);

      await reviewPlanAndEscalate(repo, alertIssue());

      expect(mockClaude.runClaude).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockGh.addLabel).not.toHaveBeenCalled();
    });

    it("applies Refined and notifies on a proceed verdict", async () => {
      await reviewPlanAndEscalate(repo, alertIssue());

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 971, "Refined");
      expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("Auto-refined"));
      const body = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(body).toContain(ESCALATION_REVIEW_HEADER);
      expect(body).toContain("ESCALATION_VERDICT: proceed");
      // A second "## Implementation Plan" comment would hijack plan lookup elsewhere.
      expect(body).not.toContain(PLAN_HEADER);
    });

    it("posts a comment but applies no label on a hold verdict", async () => {
      mockClaude.runClaude.mockResolvedValue(`{"verdict":"hold","reason":"Node hardware is down; nothing to implement."}`);

      await reviewPlanAndEscalate(repo, alertIssue());

      expect(mockGh.addLabel).not.toHaveBeenCalled();
      const body = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(body).toContain("ESCALATION_VERDICT: hold");
      expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("needs a human"));
    });

    it("posts a hold comment and applies no label when the reviewer call throws", async () => {
      mockClaude.runClaude.mockRejectedValue(new Error("claude exploded"));

      await reviewPlanAndEscalate(repo, alertIssue());

      expect(mockGh.addLabel).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
      const body = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(body).toContain("ESCALATION_VERDICT: hold");
      expect(body).toContain("automated risk assessment failed");
    });

    it("holds when the verdict JSON is unparseable", async () => {
      mockClaude.runClaude.mockResolvedValue("I could not decide.");

      await reviewPlanAndEscalate(repo, alertIssue());

      expect(mockGh.addLabel).not.toHaveBeenCalled();
      const body = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(body).toContain("ESCALATION_VERDICT: hold");
    });

    it("skips the label when Refined is already applied but still records the verdict", async () => {
      await reviewPlanAndEscalate(repo, alertIssue({ labels: [{ name: "Priority" }, { name: "Refined" }] }));

      expect(mockGh.addLabel).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    });
  });
});
