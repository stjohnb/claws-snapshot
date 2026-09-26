// All external dependencies — Claude, GitHub, and the database — are mocked via vi.mock().
// No real Claude calls are made; runClaude returns hardcoded strings so the tests verify
// the orchestration logic (prompt construction, marker parsing, GitHub interactions) in
// isolation from the actual model.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mockRepo, mockIssue, mockPR } from "../test-helpers.js";

/** An open step PR as `listOpenPhasePRs` reports it. */
const openPhasePR = (number: number, over: Partial<{ repo: string; title: string; phase: number | null }> = {}) =>
  ({ repo: "test-org/test-repo", number, title: "Test PR", phase: 1, ...over });

const { mockIsForgejoRepo } = vi.hoisted(() => ({
  mockIsForgejoRepo: vi.fn((_fullName: string) => false),
}));

vi.mock("../config.js", () => ({
  issueUrl: (repo: string, n: unknown) => `https://github.com/${repo}/issues/${String(n)}`,
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    blocked: "Blocked",
    clawsIgnore: "Claws Ignore",
    duplicate: "Duplicate",
    planDeep: "Plan: Deep",
    automerge: "Automerge",
    autoRefine: "Claws Auto-Refine",
  },
  SELF_REPO: "test-org/test-repo",
  HOME_ASSISTANT_BASE_URL: "",
  HOME_ASSISTANT_TOKEN: "",
  HOME_ASSISTANT_CONFIG_REPO: "",
  isForgejoRepo: mockIsForgejoRepo,
  hasForgejoRepoForOwner: (_owner: string) => false,
  forgejoRepoUrl: (fullName: string) => `https://forgejo.test/${fullName}`,
}));
const mockProviderSelection = vi.hoisted(() => ({
  value: { provider: "claude", strictProvider: false, eligibleProviders: [{ provider: "claude", weight: 4 }] } as { provider: string; strictProvider: boolean; eligibleProviders: Array<{ provider: string; weight: number }>; overrideIgnoredReason?: string },
}));
// The per-issue model plan is exercised in model-plan.test.ts; here it
// resolves exactly like an issue with no cells, over the mocked selector.
const mockResolveModelPlanCell = vi.hoisted(() => vi.fn());
const mockSetSuggestedPlan = vi.hoisted(() => vi.fn());
vi.mock("../model-plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model-plan.js")>();
  const selector = await import("../model-selector.js") as any;
  mockResolveModelPlanCell.mockImplementation(async (_repo: string, _ref: unknown, phase: string, fallback: any = {}) => {
    const selection = selector.getProviderSelectionForItem(fallback.labels ?? [], { requiresMcp: fallback.requiresMcp });
    const tier = fallback.tier ?? ({ "plan": "fable", "plan-refine": "opus" } as Record<string, string>)[phase] ?? "sonnet";
    return { ...selection, tier, model: selector.getModel(tier, selection.provider), source: "default", tierSource: "default", providerSource: "default" };
  });
  mockSetSuggestedPlan.mockResolvedValue(undefined);
  return { ...actual, resolveModelPlanCell: mockResolveModelPlanCell, setSuggestedPlan: mockSetSuggestedPlan };
});

vi.mock("../model-selector.js", () => ({
  getModel: (tier: string = "sonnet", provider?: string) => (tier === "fable" && provider === "codex" ? "gpt-5.5" : tier),
  normalizeTier: (raw: string) => {
    const word = raw.trim().toLowerCase();
    if (word === "cheap") return "haiku";
    return ["fable", "opus", "sonnet", "haiku"].includes(word) ? word : null;
  },
  getDeepModel: (p: string) => (p === "codex" ? "gpt-5.5" : "fable"),
  getReviewModel: (tier: string = "sonnet") => tier,
  getProviderSelectionForItem: () => mockProviderSelection.value,
  getProviderOverride: () => undefined,
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../timeout-handler.js", () => ({
  handleTimeoutIfApplicable: vi.fn().mockResolvedValue(undefined),
  getItemTimeoutMs: vi.fn().mockReturnValue(undefined),
}));

// Every repo is monitored unless a test pauses one for a single call.
const mockIsRepoMonitored = vi.hoisted(() => vi.fn(() => true));
vi.mock("../repo-config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../repo-config.js")>(),
  isRepoMonitored: mockIsRepoMonitored,
}));

const mockSlackNotify = vi.hoisted(() => vi.fn());
vi.mock("../slack.js", () => ({ notify: mockSlackNotify }));

const { mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockGh: {
    getCommentReactions: vi.fn(),
    addReaction: vi.fn(),
    getIssueComments: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    commentOnIssue: vi.fn(),
    editIssueComment: vi.fn(),
    isClawsComment: (body: string) => /\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/.test(body) || body.includes("<!-- claws-automated -->"),
    stripClawsMarker: (body: string) => body.replace("<!-- claws-automated -->", "").replace("*— Automated by Claws —*", "").trim(),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    isAllowedActor: vi.fn().mockResolvedValue(true),
    getSelfLogin: vi.fn().mockResolvedValue("claws-bot"),
    getSelfLoginForRepo: vi.fn().mockResolvedValue("claws-bot"),
    getSelfLoginForIssue: vi.fn().mockResolvedValue("claws-bot"),
    getIssueTitleBody: vi.fn(),
    listOpenIssues: vi.fn().mockResolvedValue([]),
    isItemSkipped: vi.fn().mockReturnValue(false),
    listRepos: vi.fn().mockResolvedValue([]),
    isRepoListDegraded: vi.fn().mockReturnValue(false),
    transferIssue: vi.fn().mockResolvedValue("https://github.com/o/dst/issues/9"),
    getPRBody: vi.fn().mockResolvedValue(""),
    getPRChangedFiles: vi.fn().mockResolvedValue([]),
    getOpenPRForIssue: vi.fn().mockResolvedValue(null),
    listOpenPRsForIssue: vi.fn().mockResolvedValue([]),
    listMergedPRsForIssue: vi.fn().mockResolvedValue([]),
    listPRsCrossReferencingIssue: vi.fn().mockResolvedValue([]),
    getPRState: vi.fn().mockResolvedValue(null),
    getPRHeadSHA: vi.fn().mockResolvedValue("b7639207aaaa"),
  },
  mockClaude: {
    withNewWorktree: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
    writeClawsMcpConfig: vi.fn().mockReturnValue("/tmp/mock-mcp-config.json"),
    writeAgentMcpConfig: vi.fn().mockReturnValue("/tmp/mock-mcp-config.json"),
    readRepoAgentDoc: vi.fn().mockReturnValue(undefined),
    ensureScratchDir: vi.fn().mockReturnValue("/tmp/scratch"),
    TEXT_ONLY_DISALLOWED_TOOLS: [],
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    updateTaskModel: vi.fn(),
    updateTaskProvider: vi.fn(),
    updateTaskTokenUsage: vi.fn(),
    trackTaskTokens: vi.fn().mockReturnValue(vi.fn()),
    getLinkedNativeId: vi.fn().mockResolvedValue(undefined),
    getClawsIssue: vi.fn().mockResolvedValue(undefined),
    getIssuePlannedPRs: vi.fn().mockResolvedValue([]),
    replaceIssuePlannedPRs: vi.fn().mockResolvedValue([]),
    createShadowIssue: vi.fn().mockResolvedValue({ id: "clw_SHADOW", created: true }),
    linkIssuePlannedPR: vi.fn(),
    unlinkIssuePlannedPR: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
    withTaskRecording: vi.fn(async (jobName: string, repo: string, itemNumber: number, triggerLabel: string | null, fn: (taskId: number) => Promise<unknown>) => {
      const taskId = mockDb.recordTaskStart(jobName, repo, itemNumber, triggerLabel);
      try {
        return await fn(taskId);
      } catch (err) {
        mockDb.recordTaskFailed(taskId, String(err), { failureCategory: "unknown" });
        throw err;
      }
    }),
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

const mockListLinks = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("../issue-links.js", () => ({
  listLinks: mockListLinks,
  LINK_KIND_LABELS: { depends_on: "Depends on", blocks: "Blocks", relates_to: "Relates to" },
}));

const { mockFindIssuePreview, mockSyncPreviewsForIssue } = vi.hoisted(() => ({
  mockFindIssuePreview: vi.fn(),
  mockSyncPreviewsForIssue: vi.fn(),
}));
vi.mock("../issue-previews.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../issue-previews.js")>(),
  findIssuePreview: mockFindIssuePreview,
  syncPreviewsForIssue: mockSyncPreviewsForIssue,
}));

const mockLoadApprovedRequirements = vi.hoisted(() => vi.fn().mockResolvedValue({ status: "none" }));
vi.mock("../approved-requirements.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../approved-requirements.js")>(),
  loadApprovedRequirements: mockLoadApprovedRequirements,
}));

/** An approved requirements record as `loadApprovedRequirements` returns it. */
const approvedRecord = (over: Partial<{ version: number; requirement: string; acceptanceCriteria: string[] }> = {}) => ({
  version: 2,
  title: "Record title",
  kind: "feature" as const,
  context: "Record context.",
  requirement: "Record requirement.",
  acceptanceCriteria: ["Criterion one", "Criterion two"],
  outOfScope: ["Not this"],
  commentId: null,
  createdAt: "2026-09-24T00:00:00.000Z",
  approvedBy: "claws",
  approvedAt: "2026-09-24T01:00:00.000Z",
  ...over,
});

const mockProcessTextForImages = vi.hoisted(() => vi.fn().mockResolvedValue(""));
vi.mock("../images.js", () => ({
  processTextForImages: mockProcessTextForImages,
}));

import {
  processIssue,
  processRefinement,
  processFollowUp,
  findUnreactedHumanComments,
  isCiUnrelatedIssue,
  isAutoRefineIssue,
  stripLeadingPlanHeader,
  plannerToolDocs,
  issueReposSection,
  plannerAllowedRepos,
  renderPlanBody,
  PLAN_HEADER,
  PLAN_LENGTH_WARN_CHARS,
  PLAN_LENGTH_WARN_SENTINEL,
  PLAN_OCCURRENCES_MARKER,
  parsePlannedOccurrences,
  parseStepBackVerdict,
  splitStepBackOutput,
  STEP_BACK_HEADER,
  STEP_BACK_REVISED_MARKER,
  STEP_BACK_RECONSIDER_MARKER,
  hasStepBackReconsiderMarker,
  ESCALATION_REVIEW_HEADER,
  findUnreactedFeedbackAfterPlan,
  TRANSFERRED_FROM_MARKER,
  TRANSFER_HEADER,
  parseTransferredFrom,
  alreadyTransferredInto,
  selectTransferCandidates,
  buildManagedReposSection,
  buildDuplicateCandidatesSection,
  buildLinkedIssuesSection,
  issueContentHash,
  isConsolidatedAlertBody,
  parsePlanBodyHash,
  parsePlanLastCommentId,
  isPlanStaleForIssue,
  planMarkersFor,
  stripPlanMarkers,
  selectFeedbackCandidates,
  PLAN_BODY_HASH_MARKER,
  PLAN_LAST_COMMENT_MARKER,
  stripRefinedForPendingFeedback,
  PENDING_FEEDBACK_MARKER,
  isDegeneratePlanOutput,
  MIN_PLAN_CHARS_WITHOUT_MODEL_LINE,
  PLAN_RETRY_INSTRUCTION,
  REQUIREMENTS_UPGRADE_STALLED_MARKER,
  MAX_REQUIREMENTS_UPGRADE_ATTEMPTS,
} from "./issue-refiner.js";
import { __resetPostedCommentsForTests } from "../prompt-guard.js";
import { submitPlan, submitOutcome, submitStepBack } from "../planner-runs.js";
import * as log from "../log.js";

/** The planner run id baked into a mocked MCP config path (see beforeEach). */
function runIdOf(opts?: { mcpConfig?: string }): string {
  return opts?.mcpConfig?.match(/mcp-([0-9a-f-]{36})\.json$/)?.[1] ?? "";
}

/** A valid `claws_save_plan` payload for the default test repo. */
function planInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan: "### Requirement\nDo the thing.\n\n### Implementation\nChange src/x.ts.",
    prs: [{ repo: "test-org/test-repo", title: "Do the thing" }],
    implementation_model: "sonnet",
    review_model: "opus",
    ...overrides,
  };
}

/** Make every planner run save `input` through `claws_save_plan`, returning `finalMessage`. */
function mockSavedPlan(input: Record<string, unknown>, finalMessage = "Done."): void {
  mockClaude.runClaude.mockImplementation(async (_prompt: string, _cwd: string, opts?: { mcpConfig?: string }) => {
    const r = submitPlan(runIdOf(opts), input);
    if (!r.ok) throw new Error(r.error);
    return finalMessage;
  });
}

/** The `plannerRun` option of every planner MCP config written so far. */
function plannerRunsWritten(): Array<{ id: string; stage: string; offers?: string[] }> {
  return mockClaude.writeAgentMcpConfig.mock.calls
    .map((c: unknown[]) => (c[1] as { plannerRun?: { id: string; stage: string; offers?: string[] } } | undefined)?.plannerRun)
    .filter((r: unknown): r is { id: string; stage: string; offers?: string[] } => r !== undefined);
}

describe("issue-refiner", () => {
  const repo = mockRepo();

  /**
   * Make the mocked planner run report an outcome through `claws_report_outcome`
   * (the real planner-runs registry, reached through the run id in the MCP config
   * path) with `prose` as its explanation, while returning `prose` as its final
   * message. Pass `verdict: null` for "no tool call" — the final-message fallback.
   * The tool call must be accepted unless `rejectedWith` names (part of) the
   * error it is expected to fail with; a rejected call leaves no submission,
   * and a run with only rejected calls fails rather than falling back.
   */
  function mockPlannerRun(prose: string, verdict: Record<string, unknown> | null, rejectedWith?: string): void {
    mockClaude.runClaude.mockImplementation(async (prompt: string, _cwd: string, opts?: { mcpConfig?: string }) => {
      if (prompt.includes("Respond with ONLY one word")) return "sonnet";
      if (verdict !== null) {
        const { verdict: outcome, ...rest } = verdict;
        const result = submitOutcome(runIdOf(opts), { outcome, explanation: prose, ...rest });
        expect(result).toEqual(rejectedWith === undefined ? { ok: true } : { ok: false, error: expect.stringContaining(rejectedWith) });
      }
      return prose;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks only clears call history, not implementations set with
    // mockResolvedValue/mockImplementation — reset explicitly so a test that
    // overrides the loader can't leak its record into a later test (#3388 finding 8).
    mockLoadApprovedRequirements.mockReset();
    mockLoadApprovedRequirements.mockResolvedValue({ status: "none" });
    mockProviderSelection.value = { provider: "claude", strictProvider: false, eligibleProviders: [{ provider: "claude", weight: 4 }] };
    mockIsForgejoRepo.mockReset();
    mockIsForgejoRepo.mockReturnValue(false);
    mockClaude.withNewWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.writeAgentMcpConfig.mockImplementation((_wt: string, o?: { plannerRun?: { id: string } }) =>
      o?.plannerRun ? `/tmp/mcp-${o.plannerRun.id}.json` : "/tmp/mock-mcp-config.json");
    mockDb.getLinkedNativeId.mockResolvedValue(undefined);
    mockFindIssuePreview.mockResolvedValue(null);
    mockSyncPreviewsForIssue.mockResolvedValue(undefined);
    mockDb.getIssuePlannedPRs.mockResolvedValue([]);
    mockDb.replaceIssuePlannedPRs.mockResolvedValue([]);
    mockDb.createShadowIssue.mockResolvedValue({ id: "clw_SHADOW", created: true });
    mockClaude.runClaude.mockImplementation(async () => "## Plan\nDo the thing\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`");
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockGh.addReaction.mockResolvedValue(undefined);
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockGh.editIssueComment.mockResolvedValue(undefined);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.isItemSkipped.mockReturnValue(false);
    mockGh.listRepos.mockResolvedValue([]);
    mockGh.transferIssue.mockResolvedValue("https://github.com/o/dst/issues/9");
    mockGh.getPRBody.mockResolvedValue("");
    mockGh.getPRChangedFiles.mockResolvedValue([]);
    mockGh.getOpenPRForIssue.mockResolvedValue(null);
    // Default: the live read fails, so callers fall back to the issue snapshot the
    // test passed in — no test sees a spurious hash mismatch (#2524).
    mockGh.getIssueTitleBody.mockRejectedValue(new Error("no live read in tests"));
  });

  describe("processIssue", () => {
    it("happy path — new plan", async () => {
      const issue = mockIssue({ body: "Test issue body" });

      await processIssue(repo, issue);

      expect(mockClaude.withNewWorktree).toHaveBeenCalledWith(repo, "claws/plan-1-ab12", "issue-refiner", expect.any(Function));
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        expect.stringContaining("## Implementation Plan"),
        { agentName: "Planner" },
      );
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockDb.recordTaskStart).toHaveBeenCalledWith("issue-refiner", repo.fullName, issue.number, null);
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
      expect(mockClaude.withNewWorktree).toHaveBeenCalled();
    });

    it("appends the override-ignored reason to the Models used attribution", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockProviderSelection.value = {
        provider: "claude",
        strictProvider: false,
        eligibleProviders: [{ provider: "claude", weight: 4 }],
        overrideIgnoredReason: '"Use Codex" label ignored — test reason',
      };

      await processIssue(repo, issue);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        expect.stringContaining('*Models used: fable (provider: claude; "Use Codex" label ignored — test reason)*'),
        { agentName: "Planner" },
      );
    });

    it("gives the planner the issue's linked issues", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockListLinks.mockResolvedValueOnce([{
        id: "cll_1", kind: "depends_on", otherId: "clw_01M34WAJC9P3FM81NPT9N0CV9P", otherTitle: "Add update-claws.yml",
        otherState: "open", otherStateReason: null, otherLifecycle: "approved", releasedAt: null,
      }]);

      await processIssue(repo, issue);

      expect(mockListLinks).toHaveBeenCalledWith(repo.fullName, issue.number);
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("## Linked issues");
      expect(prompt).toContain("- depends on #clw_01M34WAJC9P3FM81NPT9N0CV9P — Add update-claws.yml (open, plan approved)");
    });

    it("includes issue comments in fresh plan prompt", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 901, body: "## Claws Error Investigation Report\n\nRoot cause: missing null check", body_html: "", login: "claws-bot" },
      ]);

      await processIssue(repo, issue);

      // calls[0] is the main plan prompt
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Claws Error Investigation Report");
      expect(prompt).toContain("Root cause: missing null check");
    });

    it("passes Claws-owned planner capabilities to fresh planning runs", async () => {
      const repo = mockRepo({ owner: "St-John-Software", name: "production-infra", fullName: "St-John-Software/production-infra" });
      const issue = mockIssue({ body: "Test issue body" });

      await processIssue(repo, issue);

      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String),
        "/tmp/worktree",
        expect.objectContaining({ plannerCapabilities: ["prod-infra"] }),
      );
    });

    it("empty output — logs warning but still adds Ready label", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude.mockResolvedValue("");

      await processIssue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("error handling — records task as failed and throws", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude.mockRejectedValue(new Error("claude error"));

      await expect(processIssue(repo, issue)).rejects.toThrow("claude error");

      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude error"), expect.any(Object));
      expect(mockClaude.withNewWorktree).toHaveBeenCalled();
    });

    it("processes issues with no body", async () => {
      const issue = mockIssue({ body: "" });

      await processIssue(repo, issue);

      expect(mockClaude.withNewWorktree).toHaveBeenCalled();
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        expect.stringContaining("## Implementation Plan"),
        { agentName: "Planner" },
      );
      // calls[0] is the main plan prompt
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("(No description provided)");
    });

    it("ci-unrelated issue — auto-adds Refined label after first plan", async () => {
      const issue = mockIssue({
        title: "[ci-unrelated] CI failures unrelated to PR changes",
        body: "CI failures detected",
      });

      await processIssue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Refined");
    });

    it("ci-unrelated issue — skips auto-Refined when every plan phase is already covered", async () => {
      // A fresh plan on an issue whose phase PRs already merged would otherwise be
      // handed to the implementer, whose all-covered guard strips `Refined` again (#2821).
      const issue = mockIssue({
        title: "[ci-unrelated] CI failures unrelated to PR changes",
        body: "CI failures detected",
      });
      mockGh.listMergedPRsForIssue.mockResolvedValue([{ number: 50, title: "fix ci" }]);

      await processIssue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Refined");
    });

    it("regular issue — does not auto-add Refined label", async () => {
      const issue = mockIssue({ body: "Test issue body" });

      await processIssue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Refined");
    });

    it("includes model selection instructions in prompt", async () => {
      const issue = mockIssue({ body: "Test issue body" });

      await processIssue(repo, issue);

      // calls[0] is the main plan prompt
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("`implementation_model` field of `claws_save_plan`");
      expect(prompt).toMatch(/gh issue view|gh pr view/);
      expect(prompt).toContain("references other issues or PRs");
    });

    it("includes the concise planning contract in prompt", async () => {
      const issue = mockIssue({ body: "Test issue body" });

      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("restate the requirement unambiguously");
      expect(prompt).toContain("### Requirement");
      expect(prompt).toContain("### Decisions");
      expect(prompt).toContain("### Implementation");
      expect(prompt).toContain("### Verification");
      expect(prompt).toContain("numbered");
      expect(prompt).toContain(PLAN_LENGTH_WARN_CHARS.toLocaleString());
      expect(prompt).not.toContain("line ranges");
    });

    it("plans against an approved requirements record without a Requirement section", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });

      await processIssue(repo, issue);

      expect(mockLoadApprovedRequirements).toHaveBeenCalledWith(repo.fullName, issue.number);
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("## Approved requirements (v2, approved 2026-09-24)");
      expect(prompt).toContain("1. Criterion one");
      expect(prompt).toContain("Record requirement.");
      expect(prompt).toContain("Test issue body");
      expect(prompt).not.toContain("### Requirement");
      expect(prompt).not.toContain("restate the requirement unambiguously");
      expect(prompt).toContain("### Decisions");
      expect(prompt).toContain("### Implementation");
      expect(prompt).toContain("### Verification");
      expect(prompt).toContain("must name the approved requirements version");
      expect(prompt).toContain(`If the work needs multiple PRs, put "### Decisions" before the first`);
    });

    it("stamps the plan hash against the approved record", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const record = approvedRecord();
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record });

      await processIssue(repo, issue);

      const posted = mockGh.commentOnIssue.mock.calls.map((c) => c[2] as string).find((b) => b.includes(PLAN_HEADER))!;
      expect(posted).toContain(`${PLAN_BODY_HASH_MARKER} ${issueContentHash(issue.title, issue.body, record)}`);
      expect(posted).not.toContain(`${PLAN_BODY_HASH_MARKER} ${issueContentHash(issue.title, issue.body)}`);
    });

    it("stamps body-only and posts a fresh-plan stall notice when the plan keeps a Requirement section despite an approved record (#3388 finding 8)", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const record = approvedRecord();
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record });
      mockClaude.runClaude.mockImplementation(async () => "## Plan\n\n### Requirement\n\nRestated anyway.\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`");

      await processIssue(repo, issue);

      const posted = mockGh.commentOnIssue.mock.calls.map((c) => c[2] as string).find((b) => b.includes(PLAN_HEADER))!;
      expect(posted).toContain(`${PLAN_BODY_HASH_MARKER} ${issueContentHash(issue.title, issue.body)}`);
      expect(posted).not.toContain(`${PLAN_BODY_HASH_MARKER} ${issueContentHash(issue.title, issue.body, record)}`);

      const notice = mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => (c[2] as string).includes(REQUIREMENTS_UPGRADE_STALLED_MARKER));
      expect(notice?.[2]).toContain(`${REQUIREMENTS_UPGRADE_STALLED_MARKER}: v2 attempts=1`);
      // A fresh plan has no earlier version to predate (#3388 finding 2).
      expect(notice?.[2]).not.toContain("predates");
      expect(notice?.[2]).toContain("kept a \"### Requirement\" section although the issue has an approved requirements record");

      // The notice must reference the plan comment already posted, not the other way round.
      const planCallIndex = mockGh.commentOnIssue.mock.calls.findIndex((c: unknown[]) => (c[2] as string).includes(PLAN_HEADER));
      const noticeCallIndex = mockGh.commentOnIssue.mock.calls.findIndex((c: unknown[]) => (c[2] as string).includes(REQUIREMENTS_UPGRADE_STALLED_MARKER));
      expect(planCallIndex).toBeLessThan(noticeCallIndex);
    });

    it("aborts the run rather than stamping a body-only hash when the requirements read fails", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "error" });

      await expect(processIssue(repo, issue)).rejects.toThrow(/Could not read the approved requirements/);

      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("drops the requirements writer's own comment from the prompt when an approved record exists", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 2001, body: "*— Automated by Claws —*\n\n## Requirements\n\n### Requirement\n\nSome unapproved v3 draft the writer just edited in place.", body_html: "", login: "claws-bot" },
      ]);

      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).not.toContain("unapproved v3 draft");
    });

    it("tells the planner to read the product docs first and cite the requirement served", async () => {
      const issue = mockIssue({ body: "Test issue body" });

      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("If `docs/PRODUCT.md` exists, read it first");
      expect(prompt).toContain("`docs/product/<area>.md#<heading>`");
      expect(prompt).toContain("`docs/PRODUCT.md#<heading>` when requirements are kept inline");
      expect(prompt).not.toContain("read it first (and any linked");
    });

    it("includes review model instructions in prompt", async () => {
      const issue = mockIssue({ body: "Test issue body" });

      await processIssue(repo, issue);

      // calls[0] is the main plan prompt
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("`review_model` field");
    });

    it("includes image context in prompt when images are found", async () => {
      const issue = mockIssue({
        body: "Add this: ![design](https://example.com/design.png)",
      });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1001, body: "Comment with ![img](https://example.com/img2.png)", body_html: "", login: "commenter" },
      ]);
      mockProcessTextForImages.mockResolvedValueOnce("\n## Attached Images\n- .claws-images/img-1.png");

      await processIssue(repo, issue);

      expect(mockProcessTextForImages).toHaveBeenCalledWith(
        [issue.body, "Comment with ![img](https://example.com/img2.png)"],
        "/tmp/worktree",
        repo,
        { agentName: "Planner", issueNumber: issue.number, repo: repo.fullName },
      );
      // calls[0] is the main plan prompt
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("## Attached Images");
    });

    it("plans on the fable tier with deep thinking by default, regardless of issue content", async () => {
      const issue = mockIssue({ body: "Test issue body" });

      await processIssue(repo, issue);

      expect(mockDb.updateTaskModel).toHaveBeenCalledWith(1, "fable");
      expect(mockResolveModelPlanCell).toHaveBeenCalledWith(repo.fullName, issue.number, "plan", expect.objectContaining({ labels: issue.labels }));
      expect(mockClaude.runClaude).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ tier: "fable", deepThinking: true }));
    });

    it("records the planner's model plan line as suggested cells", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude.mockResolvedValue(`plan body\n\n**Recommended implementation model:** \`sonnet\`\n**Recommended review model:** \`opus\`\n**Model plan:** \`implement=codex/haiku\``);

      await processIssue(repo, issue);

      expect(mockSetSuggestedPlan).toHaveBeenCalledWith(repo.fullName, issue.number, [{ phase: "implement", provider: "codex", tier: "haiku" }]);
    });

    it("drops a planner-suggested plan cell so the planner cannot steer its own next fresh plan", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude.mockResolvedValue(`plan body\n\n**Recommended implementation model:** \`sonnet\`\n**Recommended review model:** \`opus\`\n**Model plan:** \`plan=haiku\` \`review=opus\``);

      await processIssue(repo, issue);

      expect(mockSetSuggestedPlan).toHaveBeenCalledWith(repo.fullName, issue.number, [{ phase: "review", provider: null, tier: "opus" }]);
    });

    it("falls back to the recommendation lines for suggested cells when there is no model plan line", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude.mockResolvedValue(`plan body\n\n**Recommended implementation model:** \`sonnet\`\n**Recommended review model:** \`opus\``);

      await processIssue(repo, issue);

      expect(mockSetSuggestedPlan).toHaveBeenCalledWith(repo.fullName, issue.number, [
        { phase: "implement", provider: null, tier: "sonnet" },
        { phase: "review", provider: null, tier: "opus" },
      ]);
    });

    it("documents the optional model plan line in the planner prompt", async () => {
      await processIssue(repo, mockIssue({ body: "Test issue body" }));
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("**Model plan:**");
      expect(prompt).toContain("review-address");
    });

    it("uses the deep model when the issue has the Plan: Deep label", async () => {
      const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Plan: Deep" }] });
      await processIssue(repo, issue);
      expect(mockDb.updateTaskModel).toHaveBeenCalledWith(1, "fable");
    });

    it("follows a Plan: Deep issue onto the codex provider's deep model with deepThinking set", async () => {
      mockProviderSelection.value = { provider: "codex", strictProvider: true, eligibleProviders: [{ provider: "codex", weight: 2 }] };
      const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Plan: Deep" }] });

      await processIssue(repo, issue);

      expect(mockDb.updateTaskModel).toHaveBeenCalledWith(1, "gpt-5.5");
      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ provider: "codex", strictProvider: true, deepThinking: true }),
      );
    });

    it("posts exactly one plan header when runClaude output already starts with it", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude.mockResolvedValue(`${PLAN_HEADER}\n\nplan body\n\n**Recommended implementation model:** \`sonnet\`\n**Recommended review model:** \`sonnet\``);

      await processIssue(repo, issue);

      const body = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect((body.match(/## Implementation Plan/g) ?? []).length).toBe(1);
    });

    it("includes deep planning context in prompt when Plan: Deep label is present", async () => {
      const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Plan: Deep" }] });
      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("labelled for deep planning");
    });

    it("omits deep planning context on a Plan: Deep issue whose resolved tier is not fable", async () => {
      const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Plan: Deep" }] });
      mockResolveModelPlanCell.mockResolvedValueOnce({
        provider: "claude", strictProvider: false, eligibleProviders: [{ provider: "claude", weight: 4 }],
        tier: "opus", model: "opus", source: "explicit", tierSource: "explicit", providerSource: "default",
      });

      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).not.toContain("labelled for deep planning");
      expect(mockClaude.runClaude).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ tier: "opus", deepThinking: false }));
    });

    it("does not include deep planning context when Plan: Deep label is absent", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).not.toContain("labelled for deep planning");
    });

    it("does not warn for an ordinary plan", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude.mockImplementation(async () => "## Plan\n" + "x".repeat(12_000));

      await processIssue(repo, issue);

      const warned = mockGh.commentOnIssue.mock.calls.some(
        (c: unknown[]) => typeof c[2] === "string" && c[2].includes("[!WARNING]"),
      );
      expect(warned).toBe(false);
    });

    it("warns past the threshold", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude.mockImplementation(async () => "## Plan\n" + "x".repeat(PLAN_LENGTH_WARN_CHARS + 1_000));

      await processIssue(repo, issue);

      const warned = mockGh.commentOnIssue.mock.calls.some(
        (c: unknown[]) => typeof c[2] === "string" && c[2].includes("[!WARNING]"),
      );
      expect(warned).toBe(true);
    });
  });

  describe("processIssue — degenerate plan retry (#2948)", () => {
    const note = "The background poller finished. No change to the plan above.";
    // Kept under STEP_BACK_MIN_PLAN_CHARS so the step-back pass (a separate concern,
    // covered by its own describe block) does not add a third runClaude call here.
    const validPlan = "## Implementation Plan\n\n" + "x".repeat(200) + "\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`";

    it("retries once and posts the valid plan when the first attempt is degenerate", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude.mockResolvedValueOnce(note).mockResolvedValueOnce(validPlan);

      await processIssue(repo, issue);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
      expect(mockClaude.runClaude.mock.calls[1][0] as string).toContain(PLAN_RETRY_INSTRUCTION);
      const planCalls = mockGh.commentOnIssue.mock.calls.filter(
        (c: unknown[]) => typeof c[2] === "string" && (c[2] as string).includes(PLAN_HEADER),
      );
      expect(planCalls).toHaveLength(1);
      expect(planCalls[0][2]).toContain("x".repeat(200));
    });

    it("posts nothing when both attempts are degenerate", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude.mockResolvedValue(note);

      await processIssue(repo, issue);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
      const planCalls = mockGh.commentOnIssue.mock.calls.filter(
        (c: unknown[]) => typeof c[2] === "string" && (c[2] as string).includes(PLAN_HEADER),
      );
      expect(planCalls).toHaveLength(0);
      // The Ready label still lands so the dispatcher re-plans on a later tick.
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    });

    it("does not auto-apply Refined when both attempts are degenerate on an auto-refine issue", async () => {
      const issue = mockIssue({ title: "[ci-unrelated] Flaky test", body: "Test issue body" });
      mockClaude.runClaude.mockResolvedValue(note);

      await processIssue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Refined");
    });

    it("does not retry a legitimately short plan that carries the model recommendation line", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude.mockResolvedValue(
        "## Implementation Plan\n\nOne-line fix.\n\n**Recommended implementation model:** `cheap`\n**Recommended review model:** `sonnet`",
      );

      await processIssue(repo, issue);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        expect.stringContaining("One-line fix."),
        { agentName: "Planner" },
      );
    });

    it("prompt tells the planner never to run a background shell command", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      await processIssue(repo, issue);
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Never run a shell command in the background");
    });
  });

  describe("processRefinement", () => {
    it("edits existing plan comment in-place", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please also handle edge case X", body_html: "", login: "reviewer" };

      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockProcessTextForImages).toHaveBeenCalledWith(
        [issue.body, planComment.body, humanComment.body],
        "/tmp/worktree",
        repo,
        { agentName: "Planner", issueNumber: issue.number, repo: repo.fullName },
      );
      expect(mockGh.editIssueComment).toHaveBeenCalledWith(
        repo.fullName,
        501,
        expect.stringContaining("## Implementation Plan"),
        { agentName: "Planner" },
      );
      expect(mockGh.addReaction).toHaveBeenCalledWith(repo.fullName, 502, "+1");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("passes Claws-owned planner capabilities to refinement runs", async () => {
      const repo = mockRepo({ owner: "St-John-Software", name: "production-infra", fullName: "St-John-Software/production-infra" });
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please also handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String),
        "/tmp/worktree",
        expect.objectContaining({ plannerCapabilities: ["prod-infra"] }),
      );
    });

    it("carries the step-back reconsider marker forward when editing a held plan comment (#3091)", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = {
        id: 501,
        body: `*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here\n\n${STEP_BACK_RECONSIDER_MARKER}`,
        body_html: "",
        login: "claws-bot",
      };
      const humanComment = { id: 502, body: "Please also handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      const body = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect(body).toContain(STEP_BACK_RECONSIDER_MARKER);
    });

    it("carries the step-back reconsider marker forward through the empty-output re-stamp path (#3091)", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = {
        id: 501,
        body: `*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here\n\n${STEP_BACK_RECONSIDER_MARKER}`,
        body_html: "",
        login: "claws-bot",
      };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      const note = "The background poller finished. No change to the plan above.";
      mockClaude.runClaude.mockResolvedValue(note);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
      const body = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect(body.split(STEP_BACK_RECONSIDER_MARKER)).toHaveLength(2);
    });

    it("tells the refiner to cite the product requirement served", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please also handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("`docs/product/<area>.md#<heading>`");
      expect(prompt).not.toContain("read it first (and any linked");
    });

    it("tells the model to preserve the `### PR N:` headers of a multi-PR plan", async () => {
      // Dropping them re-bases phase accounting for PRs that already merged under
      // the old numbering, which strands the plan (#2821).
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = {
        id: 501,
        body: "*— Automated by Claws —*\n\n## Implementation Plan\n\n### PR 1: sops recipients\nAdd them.\n\n### PR 2: rekey secrets\nRekey.",
        body_html: "",
        login: "claws-bot",
      };
      const humanComment = { id: 502, body: "The age recipient is X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Output exactly 2 `### PR N:` headers");
      expect(prompt).toContain("- ### PR 1: sops recipients");
      expect(prompt).not.toContain("Prefer a single PR");
    });

    it("keeps the ordinary multi-PR guidance for a single-phase plan", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).not.toContain("`### PR N:` headers");
      expect(prompt).toContain("Prefer a single PR");
    });

    it("includes model selection instructions in refinement prompt", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      // calls[0] is the main refinement prompt
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("`implementation_model` field of `claws_save_plan`");
      expect(prompt).toMatch(/gh issue view|gh pr view/);
      expect(prompt).toContain("references other issues or PRs");
    });

    it("includes the concise planning contract in refinement prompt", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("restat");
      expect(prompt).toContain("unambiguous");
      expect(prompt).toContain("### Decisions");
      expect(prompt).toContain("### Implementation");
      expect(prompt).toContain("### Verification");
      expect(prompt).toContain("numbered");
      expect(prompt).toContain(PLAN_LENGTH_WARN_CHARS.toLocaleString());
      expect(prompt).not.toContain("line ranges");
    });

    it("refines against an approved requirements record without a Requirement section", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });

      await processRefinement(repo, issue, [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("## Approved requirements (v2");
      expect(prompt).not.toContain("### Requirement");
    });

    it("instructs removal of a legacy Requirement section when upgrading a pre-record plan (#3388 finding 1)", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = {
        id: 501,
        body: "*— Automated by Claws —*\n\n## Implementation Plan\n\n### Requirement\n\nOld restated requirement\n\n### Decisions\n\n1. Did a thing.",
        body_html: "",
        login: "claws-bot",
      };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });

      await processRefinement(repo, issue, [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("predates this approved requirements record");
      expect(prompt).toContain("Remove that section");
      expect(prompt).toContain("cite requirements v2");
    });

    it("does not add the legacy-section instruction when the previous plan has no Requirement heading", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });

      await processRefinement(repo, issue, [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).not.toContain("predates this approved requirements record");
    });

    it("aborts the run rather than stamping a body-only hash when the requirements read fails", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "error" });

      await expect(processRefinement(repo, issue, [humanComment])).rejects.toThrow(/Could not read the approved requirements/);

      expect(mockGh.editIssueComment).not.toHaveBeenCalled();
    });

    it("includes review model instructions in refinement prompt", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      // calls[0] is the main refinement prompt
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("`review_model` field");
    });

    it("posts the saved response as a separate reply comment", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "What about edge case X?", body_html: "", login: "reviewer" };

      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockSavedPlan(planInput({ plan: "Updated plan content", response: "Great question! Edge case X is handled by the null check on line 42." }));

      await processRefinement(repo, issue, [humanComment]);

      expect(mockGh.editIssueComment).toHaveBeenCalledWith(
        repo.fullName,
        501,
        expect.stringContaining("## Implementation Plan\n\nUpdated plan content"),
        { agentName: "Planner" },
      );
      const edited = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect(edited).toContain("*Models used: opus (provider: claude)*");
      expect(edited).not.toContain("Great question");
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        "Great question! Edge case X is handled by the null check on line 42.",
        { agentName: "Planner" },
      );
    });

    it("posts no reply when the saved plan has no response", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Looks good, just minor formatting", body_html: "", login: "reviewer" };

      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockSavedPlan(planInput({ plan: "Updated plan content" }));

      await processRefinement(repo, issue, [humanComment]);

      expect(mockGh.editIssueComment).toHaveBeenCalledWith(repo.fullName, 501, expect.stringContaining("Updated plan content"), { agentName: "Planner" });
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("no-feedback re-plan — does not post the response comment (#2558)", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };

      mockGh.getIssueComments.mockResolvedValue([planComment]);
      mockSavedPlan(planInput({ plan: "Updated plan content", response: "No specific feedback comments were left, so I re-verified the previous plan." }));

      await processRefinement(repo, issue, []);

      const edited = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect(edited).toContain("Updated plan content");
      expect(edited).not.toContain("No specific feedback");
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("stores the refined plan's PR list after editing the plan comment", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Split it in two", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockSavedPlan(planInput({
        plan: "### PR 1: Schema\nAdd the table.\n\n### PR 2: Readers\nUse it.",
        prs: [{ repo: "TEST-ORG/test-repo", title: "Schema" }, { repo: "test-org/test-repo", title: "Readers" }],
      }));

      await processRefinement(repo, issue, [humanComment]);

      expect(mockDb.replaceIssuePlannedPRs).toHaveBeenCalledWith("clw_SHADOW", [
        { repo: "test-org/test-repo", title: "Schema", dependsOn: null },
        { repo: "test-org/test-repo", title: "Readers", dependsOn: null },
      ]);
      expect(mockDb.replaceIssuePlannedPRs.mock.invocationCallOrder[0]).toBeGreaterThan(mockGh.editIssueComment.mock.invocationCallOrder[0]!);
    });

    it("lists the recorded PRs in the refinement prompt when a list is stored", async () => {
      const issue = mockIssue({ number: 7, body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\n### PR 1: Schema\nx\n\n### PR 2: Readers\ny", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Tweak step 2", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockDb.getLinkedNativeId.mockResolvedValue("clw_TRACKED");
      mockDb.getIssuePlannedPRs.mockResolvedValue([
        { position: 1, repo: "test-org/test-repo", title: "Schema", prNumber: 40 },
        { position: 2, repo: "test-org/test-repo", title: "Readers", prNumber: null },
      ]);
      mockGh.getPRState.mockResolvedValue("MERGED");

      await processRefinement(repo, issue, [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("PRs already recorded for this issue");
      expect(prompt).toContain("- 1. test-org/test-repo — Schema — independent — PR #40 (merged)");
      expect(prompt).toContain("- 2. test-org/test-repo — Readers — after 1 — no PR yet");
      expect(prompt).not.toContain("Already shipped and NOT to be re-planned");
    });

    it("no-feedback re-plan — prompt forbids a Response section", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };

      mockGh.getIssueComments.mockResolvedValue([planComment]);
      mockClaude.runClaude.mockResolvedValue(
        "Updated plan content\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`\n\n### Response\nNo specific feedback comments were left, so I re-verified the previous plan.",
      );

      await processRefinement(repo, issue, []);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).not.toContain("Also pass a reply to the feedback");
      expect(prompt).not.toContain("- `response`: your reply");
      expect(prompt).toContain("automatic re-verification pass");
    });

    it("falls back to the final message when the refiner never calls claws_save_plan", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockClaude.runClaude.mockResolvedValue("Fallback plan body\n\n**Recommended implementation model:** `sonnet`");

      await processRefinement(repo, issue, [humanComment]);

      expect(mockGh.editIssueComment).toHaveBeenCalledWith(repo.fullName, 501, expect.stringContaining("Fallback plan body"), { agentName: "Planner" });
      // No list saved: an existing one is cleared only when a tracker row already exists.
      expect(mockDb.createShadowIssue).not.toHaveBeenCalled();
    });

    it("clears a tracked issue's stored list when a fallback refinement changes the PR count", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\n### PR 1: A\na\n\n### PR 2: B\nb", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Make it one PR", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockDb.getLinkedNativeId.mockResolvedValue("clw_TRACKED");
      mockDb.getIssuePlannedPRs.mockResolvedValue([
        { position: 1, repo: "test-org/test-repo", title: "A", prNumber: null },
        { position: 2, repo: "test-org/test-repo", title: "B", prNumber: null },
      ]);
      mockClaude.runClaude.mockResolvedValue("Fallback plan body\n\n**Recommended implementation model:** `sonnet`");

      await processRefinement(repo, issue, [humanComment]);

      expect(mockDb.createShadowIssue).not.toHaveBeenCalled();
      expect(mockDb.replaceIssuePlannedPRs).toHaveBeenCalledWith("clw_TRACKED", []);
    });

    it("keeps a tracked issue's stored list and its links when a fallback refinement keeps the PR count", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\n### PR 1: A\na\n\n### PR 2: B\nb", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Tweak step 2", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockDb.getLinkedNativeId.mockResolvedValue("clw_TRACKED");
      mockDb.getIssuePlannedPRs.mockResolvedValue([
        { position: 1, repo: "test-org/test-repo", title: "A", prNumber: 40 },
        { position: 2, repo: "test-org/test-repo", title: "B", prNumber: null },
      ]);
      mockGh.getPRState.mockResolvedValue("MERGED");
      mockClaude.runClaude.mockResolvedValue("### PR 1: A\na\n\n### PR 2: B, tweaked\nb2\n\n**Recommended implementation model:** `sonnet`");

      await processRefinement(repo, issue, [humanComment]);

      expect(mockGh.editIssueComment).toHaveBeenCalledWith(repo.fullName, 501, expect.stringContaining("B, tweaked"), { agentName: "Planner" });
      expect(mockDb.replaceIssuePlannedPRs).not.toHaveBeenCalled();
    });

    it("splits a fallback refinement's ### Response off the plan and posts it as the reply", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockClaude.runClaude.mockResolvedValue("Fallback plan body\n\n**Recommended implementation model:** `sonnet`\n\n### Response\nEdge case X is now handled in step 2.");

      await processRefinement(repo, issue, [humanComment]);

      const planBody = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect(planBody).toContain("Fallback plan body");
      expect(planBody).not.toContain("### Response");
      expect(planBody).not.toContain("Edge case X is now handled");
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(repo.fullName, issue.number, "Edge case X is now handled in step 2.", { agentName: "Planner" });
    });

    it("drops an echoed CLAWS_TARGET_PR line from a fallback refinement", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here\n\nCLAWS_TARGET_PR: #77", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockClaude.runClaude.mockResolvedValue("Fallback plan body\n\n**Recommended implementation model:** `sonnet`\n\nCLAWS_TARGET_PR: #77");

      await processRefinement(repo, issue, [humanComment]);

      const planBody = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect(planBody).toContain("Fallback plan body");
      expect(planBody).not.toContain("CLAWS_TARGET_PR");
    });

    it("a short final message with no saved plan leaves the existing plan intact", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Just answering your question", body_html: "", login: "reviewer" };

      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockClaude.runClaude.mockResolvedValue("Just answering your question.");

      await processRefinement(repo, issue, [humanComment]);

      expect(mockGh.editIssueComment).toHaveBeenCalledWith(
        repo.fullName,
        501,
        expect.stringContaining("Original plan here"),
        { agentName: "Planner" },
      );
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("fallback — resolves the fresh plan against the plan phase, not plan-refine", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockGh.getIssueComments.mockResolvedValue([]);

      await processRefinement(repo, issue, []);

      expect(mockResolveModelPlanCell).toHaveBeenCalledWith(repo.fullName, issue.number, "plan", expect.anything());
      expect(mockResolveModelPlanCell).not.toHaveBeenCalledWith(repo.fullName, issue.number, "plan-refine", expect.anything());
    });

    it("fallback — no plan comment found, posts fresh comment", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const humanComment = { id: 602, body: "Just a random comment", body_html: "", login: "someone" };

      // No plan comment in the list (simulating it was deleted)
      mockGh.getIssueComments.mockResolvedValue([humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockProcessTextForImages).toHaveBeenCalledWith(
        [issue.body, "Just a random comment"],
        "/tmp/worktree",
        repo,
        { agentName: "Planner", issueNumber: issue.number, repo: repo.fullName },
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        expect.stringContaining("## Implementation Plan"),
        { agentName: "Planner" },
      );
      expect(mockGh.editIssueComment).not.toHaveBeenCalled();
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });

    it("always uses opus model regardless of issue content", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockDb.updateTaskModel).toHaveBeenCalledWith(1, "opus");
    });

    it("uses the deep model when the issue has the Plan: Deep label", async () => {
      const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Plan: Deep" }] });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please re-plan with the best model", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockDb.updateTaskModel).toHaveBeenCalledWith(1, "fable");
    });

    it("includes deep planning context in refinement prompt when Plan: Deep label is present", async () => {
      const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Plan: Deep" }] });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please re-plan with the best model", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("labelled for deep planning");
    });

    it("edited comment body has exactly one plan header when runClaude output starts with it", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please update", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockClaude.runClaude.mockResolvedValue(`${PLAN_HEADER}\n\nupdated plan body\n\n**Recommended implementation model:** \`sonnet\`\n**Recommended review model:** \`sonnet\``);

      await processRefinement(repo, issue, [humanComment]);

      const body = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect((body.match(/## Implementation Plan/g) ?? []).length).toBe(1);
    });

    it("warns when a refined plan exceeds the length soft limit", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockClaude.runClaude.mockResolvedValue("Updated plan content\n" + "x".repeat(PLAN_LENGTH_WARN_CHARS + 1_000));

      await processRefinement(repo, issue, [humanComment]);

      const warned = mockGh.commentOnIssue.mock.calls.some(
        (c: unknown[]) => typeof c[2] === "string" && c[2].includes("[!WARNING]"),
      );
      expect(warned).toBe(true);
    });

    it("does not repost the length warning when one already exists (#2558)", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      const warningComment = { id: 503, body: `*— Automated by Claws —*\n\n> [!WARNING]\n> This plan is ${(PLAN_LENGTH_WARN_CHARS + 1_000).toLocaleString()} characters — ${PLAN_LENGTH_WARN_SENTINEL}`, body_html: "", login: "claws-bot" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment, warningComment]);
      mockClaude.runClaude.mockResolvedValue("Updated plan content\n" + "x".repeat(PLAN_LENGTH_WARN_CHARS + 1_000));

      await processRefinement(repo, issue, [humanComment]);

      const warned = mockGh.commentOnIssue.mock.calls.some(
        (c: unknown[]) => typeof c[2] === "string" && c[2].includes("[!WARNING]"),
      );
      expect(warned).toBe(false);
    });

    it("prompt tells the planner never to run a background shell command", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Never run a shell command in the background");
    });
  });

  describe("processRefinement — degenerate plan retry (#2948)", () => {
    it("re-stamps the existing plan without overwriting it when both refinement attempts are degenerate", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      const note = "The background poller finished. No change to the plan above.";
      mockClaude.runClaude.mockResolvedValue(note);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
      expect(mockClaude.runClaude.mock.calls[1][0] as string).toContain(PLAN_RETRY_INSTRUCTION);
      const edited = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect(edited).toContain("Original plan here");
      expect(edited).not.toContain(note);
    });

    it("re-stamps a body-only plan body-only on a degenerate re-plan, even with a record now approved — it must stay stale so the next tick retries the real upgrade", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const bodyOnlyHash = issueContentHash(issue.title, "Test issue body");
      const planComment = {
        id: 501,
        body: `*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here\n\n${PLAN_BODY_HASH_MARKER} ${bodyOnlyHash}`,
        body_html: "",
        login: "claws-bot",
      };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });
      const note = "The background poller finished. No change to the plan above.";
      mockClaude.runClaude.mockResolvedValue(note);

      await processRefinement(repo, issue, [humanComment]);

      const edited = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect(edited).toContain(`${PLAN_BODY_HASH_MARKER} ${bodyOnlyHash}`);
      expect(edited).not.toContain(issueContentHash(issue.title, "Test issue body", approvedRecord()));
    });

    it("re-stamps with the record on a degenerate re-plan when the plan was already stamped against the current record", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const recordCoveringHash = issueContentHash(issue.title, "Test issue body", approvedRecord());
      const planComment = {
        id: 501,
        body: `*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here\n\n${PLAN_BODY_HASH_MARKER} ${recordCoveringHash}`,
        body_html: "",
        login: "claws-bot",
      };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });
      const note = "The background poller finished. No change to the plan above.";
      mockClaude.runClaude.mockResolvedValue(note);

      await processRefinement(repo, issue, [humanComment]);

      const edited = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect(edited).toContain(`${PLAN_BODY_HASH_MARKER} ${recordCoveringHash}`);
      // Already current — no stall to track, so no notice comment (#3388 finding 8).
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("preserves the existing stamp untouched on a degenerate re-plan when it matches neither the body-only nor the current record's hash (#3388 finding 2)", async () => {
      // Stamped against an earlier version of the record (or a body-only stamp whose
      // body has since also changed) — neither the current body-only hash nor the
      // current record's hash. Guessing "current" here would make a plan whose text
      // was never rewritten against the now-approved record look upgraded.
      const issue = mockIssue({ body: "Test issue body" });
      const staleRecordHash = issueContentHash(issue.title, "Test issue body", approvedRecord({ version: 1, requirement: "Old requirement text" }));
      const planComment = {
        id: 501,
        body: `*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here\n\n${PLAN_BODY_HASH_MARKER} ${staleRecordHash}`,
        body_html: "",
        login: "claws-bot",
      };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord({ version: 2 }) });
      const note = "The background poller finished. No change to the plan above.";
      mockClaude.runClaude.mockResolvedValue(note);

      await processRefinement(repo, issue, [humanComment]);

      const edited = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect(edited).toContain(`${PLAN_BODY_HASH_MARKER} ${staleRecordHash}`);
      expect(edited).not.toContain(issueContentHash(issue.title, "Test issue body", approvedRecord({ version: 2 })));
      expect(edited).not.toContain(issueContentHash(issue.title, "Test issue body"));
      // Counted as a stalled attempt, unlike the "already current" case above (#3388 finding 8).
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        expect.stringContaining(REQUIREMENTS_UPGRADE_STALLED_MARKER),
        { agentName: "Planner" },
      );
    });

    it("fresh-plan branch: retries once and posts the valid plan when the first attempt is degenerate", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const humanComment = { id: 602, body: "Just a random comment", body_html: "", login: "someone" };
      const note = "The background poller finished. No change to the plan above.";
      const validPlan = "## Implementation Plan\n\n" + "x".repeat(200) + "\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`";

      // No plan comment in the list (simulating it was deleted)
      mockGh.getIssueComments.mockResolvedValue([humanComment]);
      mockClaude.runClaude.mockResolvedValueOnce(note).mockResolvedValueOnce(validPlan);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
      expect(mockClaude.runClaude.mock.calls[1][0] as string).toContain(PLAN_RETRY_INSTRUCTION);
      // This path is plan-only: the prompt must not offer an outcome the run rejects,
      // and each attempt is its own planner run.
      const freshPrompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(freshPrompt).toContain("This pass cannot report an outcome.");
      expect(freshPrompt).not.toContain("claws_report_outcome` with `outcome: \"no_code_changes\"");
      expect(freshPrompt).not.toContain("claws_report_outcome` with `outcome: \"blocked\"");
      const runs = plannerRunsWritten();
      expect(runs).toHaveLength(2);
      expect(runs[0]!.id).not.toBe(runs[1]!.id);
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        expect.stringContaining("x".repeat(200)),
        { agentName: "Planner" },
      );
    });

    it("fresh-plan branch: posts nothing when both attempts are degenerate", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const humanComment = { id: 602, body: "Just a random comment", body_html: "", login: "someone" };
      const note = "The background poller finished. No change to the plan above.";

      mockGh.getIssueComments.mockResolvedValue([humanComment]);
      mockClaude.runClaude.mockResolvedValue(note);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
      const planCalls = mockGh.commentOnIssue.mock.calls.filter(
        (c: unknown[]) => typeof c[2] === "string" && (c[2] as string).includes(PLAN_HEADER),
      );
      expect(planCalls).toHaveLength(0);
    });
  });

  describe("processRefinement — requirements-upgrade stall cap (#3388 finding 1)", () => {
    const bodyOnlyPlanComment = (bodyOnlyHash: string) => ({
      id: 501,
      body: `*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here\n\n${PLAN_BODY_HASH_MARKER} ${bodyOnlyHash}`,
      body_html: "",
      login: "claws-bot",
    });

    it("posts a stall notice on the first body-only stall and keeps the plan stale", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const bodyOnlyHash = issueContentHash(issue.title, "Test issue body");
      const planComment = bodyOnlyPlanComment(bodyOnlyHash);
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });
      mockClaude.runClaude.mockResolvedValue("No change to the plan above.");

      await processRefinement(repo, issue, [humanComment]);

      const notice = mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => (c[2] as string).includes(REQUIREMENTS_UPGRADE_STALLED_MARKER));
      expect(notice?.[2]).toContain(`${REQUIREMENTS_UPGRADE_STALLED_MARKER}: v2 attempts=1`);
      expect(notice?.[2]).not.toContain("gave up");

      const planEdit = mockGh.editIssueComment.mock.calls.find((c: unknown[]) => (c[2] as string).includes("Original plan here"));
      expect(planEdit?.[2]).toContain(`${PLAN_BODY_HASH_MARKER} ${bodyOnlyHash}`);
    });

    it("edits the existing notice in place and increments the count on a repeat stall", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const bodyOnlyHash = issueContentHash(issue.title, "Test issue body");
      const planComment = bodyOnlyPlanComment(bodyOnlyHash);
      const noticeComment = {
        id: 503,
        body: `*— Automated by Claws · Planner —*\n\nThis issue's plan predates its approved requirements record (v2).\n\n${REQUIREMENTS_UPGRADE_STALLED_MARKER}: v2 attempts=1`,
        body_html: "",
        login: "claws-bot",
      };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment, noticeComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });
      mockClaude.runClaude.mockResolvedValue("No change to the plan above.");

      await processRefinement(repo, issue, [humanComment]);

      expect(mockGh.commentOnIssue).not.toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        expect.stringContaining(REQUIREMENTS_UPGRADE_STALLED_MARKER),
        expect.anything(),
      );
      const noticeEdit = mockGh.editIssueComment.mock.calls.find((c: unknown[]) => c[1] === noticeComment.id);
      expect(noticeEdit?.[2]).toContain(`${REQUIREMENTS_UPGRADE_STALLED_MARKER}: v2 attempts=2`);
    });

    it("gives up after MAX_REQUIREMENTS_UPGRADE_ATTEMPTS and stamps against the record without a rewrite", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const bodyOnlyHash = issueContentHash(issue.title, "Test issue body");
      const planComment = bodyOnlyPlanComment(bodyOnlyHash);
      const noticeComment = {
        id: 503,
        body: `*— Automated by Claws · Planner —*\n\nThis issue's plan predates its approved requirements record (v2).\n\n${REQUIREMENTS_UPGRADE_STALLED_MARKER}: v2 attempts=${MAX_REQUIREMENTS_UPGRADE_ATTEMPTS - 1}`,
        body_html: "",
        login: "claws-bot",
      };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment, noticeComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });
      mockClaude.runClaude.mockResolvedValue("No change to the plan above.");

      await processRefinement(repo, issue, [humanComment]);

      const noticeEdit = mockGh.editIssueComment.mock.calls.find((c: unknown[]) => c[1] === noticeComment.id);
      expect(noticeEdit?.[2]).toContain(`${REQUIREMENTS_UPGRADE_STALLED_MARKER}: v2 attempts=${MAX_REQUIREMENTS_UPGRADE_ATTEMPTS}`);
      expect(noticeEdit?.[2]).toContain("gave up");

      const planEdit = mockGh.editIssueComment.mock.calls.find((c: unknown[]) => (c[2] as string).includes("Original plan here"));
      expect(planEdit?.[2]).toContain(`${PLAN_BODY_HASH_MARKER} ${issueContentHash(issue.title, "Test issue body", approvedRecord())}`);
    });

    it("restarts the attempt count instead of continuing past the cap on the next stall after a give-up (#3388 finding 7)", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const bodyOnlyHash = issueContentHash(issue.title, "Test issue body");
      const planComment = bodyOnlyPlanComment(bodyOnlyHash);
      const noticeComment = {
        id: 503,
        body: `*— Automated by Claws · Planner —*\n\nClaws gave up automatically upgrading this plan against approved requirements v2 after ${MAX_REQUIREMENTS_UPGRADE_ATTEMPTS} attempts each produced no usable output.\n\n${REQUIREMENTS_UPGRADE_STALLED_MARKER}: v2 attempts=${MAX_REQUIREMENTS_UPGRADE_ATTEMPTS}`,
        body_html: "",
        login: "claws-bot",
      };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment, noticeComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });
      mockClaude.runClaude.mockResolvedValue("No change to the plan above.");

      await processRefinement(repo, issue, [humanComment]);

      const noticeEdit = mockGh.editIssueComment.mock.calls.find((c: unknown[]) => c[1] === noticeComment.id);
      expect(noticeEdit?.[2]).toContain(`${REQUIREMENTS_UPGRADE_STALLED_MARKER}: v2 attempts=1`);
      expect(noticeEdit?.[2]).not.toContain("gave up");
    });

    it("does not stamp the record when the refined output still has a Requirement section", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = {
        id: 501,
        body: "*— Automated by Claws —*\n\n## Implementation Plan\n\n### Requirement\n\nOld restated requirement\n\n### Decisions\n\n1. Did a thing.",
        body_html: "",
        login: "claws-bot",
      };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });
      const legacyOutput = "## Plan\n\n### Requirement\n\nOld restated requirement, still here.\n\n### Decisions\n\n1. Did a thing.\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`";
      mockClaude.runClaude.mockResolvedValueOnce(legacyOutput);

      await processRefinement(repo, issue, [humanComment]);

      const planEdit = mockGh.editIssueComment.mock.calls.find((c: unknown[]) => (c[2] as string).includes("### Requirement"));
      expect(planEdit?.[2]).toContain(issueContentHash(issue.title, "Test issue body"));
      expect(planEdit?.[2]).not.toContain(issueContentHash(issue.title, "Test issue body", approvedRecord()));

      const notice = mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => (c[2] as string).includes(REQUIREMENTS_UPGRADE_STALLED_MARKER));
      expect(notice?.[2]).toContain(`${REQUIREMENTS_UPGRADE_STALLED_MARKER}: v2 attempts=1`);
    });

    it("resets an existing stall notice to attempts=0 once the plan finally drops the Requirement section", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = {
        id: 501,
        body: "*— Automated by Claws —*\n\n## Implementation Plan\n\n### Requirement\n\nOld restated requirement\n\n### Decisions\n\n1. Did a thing.",
        body_html: "",
        login: "claws-bot",
      };
      const noticeComment = {
        id: 503,
        body: `*— Automated by Claws · Planner —*\n\nThis issue's plan predates its approved requirements record (v2).\n\n${REQUIREMENTS_UPGRADE_STALLED_MARKER}: v2 attempts=2`,
        body_html: "",
        login: "claws-bot",
      };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment, noticeComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });
      const upgradedOutput = "## Plan\n\nNo more Requirement section.\n\n### Decisions\n\n1. Did a thing.\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`";
      mockClaude.runClaude.mockResolvedValueOnce(upgradedOutput);

      await processRefinement(repo, issue, [humanComment]);

      const noticeEdit = mockGh.editIssueComment.mock.calls.find((c: unknown[]) => c[1] === noticeComment.id);
      expect(noticeEdit?.[2]).toContain(`${REQUIREMENTS_UPGRADE_STALLED_MARKER}: v2 attempts=0`);
      expect(noticeEdit?.[2]).toContain("no longer applies");
    });

    it("does not rewrite an already-reset (attempts=0) notice on a later successful plan (#3388 finding 4)", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = {
        id: 501,
        body: "*— Automated by Claws —*\n\n## Implementation Plan\n\n### Requirement\n\nOld restated requirement\n\n### Decisions\n\n1. Did a thing.",
        body_html: "",
        login: "claws-bot",
      };
      const noticeComment = {
        id: 503,
        body: `*— Automated by Claws · Planner —*\n\nThis plan was successfully upgraded to cite approved requirements v2 — the stalled-upgrade count above no longer applies.\n\n${REQUIREMENTS_UPGRADE_STALLED_MARKER}: v2 attempts=0`,
        body_html: "",
        login: "claws-bot",
      };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment, noticeComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });
      const upgradedOutput = "## Plan\n\nNo more Requirement section.\n\n### Decisions\n\n1. Did a thing.\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`";
      mockClaude.runClaude.mockResolvedValueOnce(upgradedOutput);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockGh.editIssueComment).not.toHaveBeenCalledWith(repo.fullName, noticeComment.id, expect.anything(), expect.anything());
    });

    it("posts no stall notice and stamps body-only when the refinement keeps a Requirement section but there is no approved record (#3388 finding 8)", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\n### Requirement\n\nOld restated requirement", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      // Default loader mock: { status: "none" } — no approved record, so requirementsStampFor
      // must short-circuit before even looking for a kept "### Requirement" section.
      const output = "## Plan\n\n### Requirement\n\nOld restated requirement, still here.\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`";
      mockClaude.runClaude.mockResolvedValueOnce(output);

      await processRefinement(repo, issue, [humanComment]);

      for (const call of [...mockGh.commentOnIssue.mock.calls, ...mockGh.editIssueComment.mock.calls]) {
        expect(call[2] as string).not.toContain(REQUIREMENTS_UPGRADE_STALLED_MARKER);
      }
      const planEdit = mockGh.editIssueComment.mock.calls.find((c: unknown[]) => (c[2] as string).includes("### Requirement"));
      expect(planEdit?.[2]).toContain(`${PLAN_BODY_HASH_MARKER} ${issueContentHash(issue.title, "Test issue body")}`);
    });

    it("never posts a stall notice for an issue with no approved record, even on a degenerate refinement (#3388 test finding 2)", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      // Default loader mock: { status: "none" } — no approved record.
      mockClaude.runClaude.mockResolvedValue("No change to the plan above.");

      await processRefinement(repo, issue, [humanComment]);

      for (const call of [...mockGh.commentOnIssue.mock.calls, ...mockGh.editIssueComment.mock.calls]) {
        expect(call[2] as string).not.toContain(REQUIREMENTS_UPGRADE_STALLED_MARKER);
      }
    });
  });

  describe("issue preview (#clw_01M39H5GCNYYFB3MQNJWY6JT8S)", () => {
    const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
    const humanComment = { id: 502, body: "Make it 5 mm taller", body_html: "", login: "reviewer" };
    const previewPR = () => mockPR({ number: 546, headRefName: `claws/preview-issue-1` });
    const previewPRPreview = () => ({ kind: "pr" as const, pr: previewPR() });

    it("tells the refining planner about an open preview and syncs it after editing the plan", async () => {
      mockFindIssuePreview.mockImplementation(async (r: string) => (r === repo.fullName ? previewPRPreview() : null));
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, mockIssue({ body: "Test issue body" }), [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("## Issue preview");
      expect(prompt).toContain(`PR ${repo.fullName}#546 on branch \`claws/preview-issue-1\` at head \`b7639207aaaa\``);
      expect(prompt).toContain("A change to plan prose alone never re-runs it.");
      expect(mockSyncPreviewsForIssue).toHaveBeenCalledWith(repo.fullName, 1, [repo.fullName]);
      expect(mockSyncPreviewsForIssue.mock.invocationCallOrder[0]).toBeGreaterThan(mockGh.editIssueComment.mock.invocationCallOrder[0]!);
    });

    it("omits the section when there is no preview", async () => {
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, mockIssue({ body: "Test issue body" }), [humanComment]);

      expect(mockClaude.runClaude.mock.calls[0][0]).not.toContain("## Issue preview");
    });

    it("includes the section in a fresh plan and syncs after posting it", async () => {
      mockFindIssuePreview.mockResolvedValue(previewPRPreview());

      await processIssue(repo, mockIssue({ body: "Test issue body" }));

      expect(mockClaude.runClaude.mock.calls[0][0]).toContain("## Issue preview");
      expect(mockSyncPreviewsForIssue).toHaveBeenCalledWith(repo.fullName, 1, [repo.fullName]);
    });

    it("includes the section on the refinement flow's fresh-plan path", async () => {
      mockFindIssuePreview.mockResolvedValue(previewPRPreview());
      mockGh.getIssueComments.mockResolvedValue([humanComment]);

      await processRefinement(repo, mockIssue({ body: "Test issue body" }), [humanComment]);

      expect(mockClaude.runClaude.mock.calls[0][0]).toContain("## Issue preview");
      expect(mockSyncPreviewsForIssue).toHaveBeenCalled();
    });

    it("a failed sync does not fail the run", async () => {
      mockSyncPreviewsForIssue.mockRejectedValue(new Error("boom"));
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, mockIssue({ body: "Test issue body" }), [humanComment]);

      expect(mockDb.recordTaskComplete).toHaveBeenCalled();
    });

    it("leaves the follow-up prompt unchanged", async () => {
      mockFindIssuePreview.mockResolvedValue(previewPRPreview());
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processFollowUp(repo, mockIssue(), [openPhasePR(5)], [humanComment]);

      expect(mockClaude.runClaude.mock.calls[0][0]).not.toContain("## Issue preview");
      expect(mockFindIssuePreview).not.toHaveBeenCalled();
    });
  });

  describe("processFollowUp", () => {
    it("passes Claws-owned fleet diagnostics to follow-up runs", async () => {
      const repo = mockRepo({ owner: "St-John-Software", name: "fleet-infra", fullName: "St-John-Software/fleet-infra" });
      const humanComment = { id: 502, body: "What do the logs show?", body_html: "", login: "stjohnb" };
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan", body_html: "", login: "claws-bot" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      await processFollowUp(repo, mockIssue(), [openPhasePR(1)], [humanComment]);
      expect(mockClaude.runClaude).toHaveBeenCalledWith(
        expect.any(String), "/tmp/worktree",
        expect.objectContaining({ plannerCapabilities: ["fleet-infra"] }),
      );
    });

    it("collects its answer via useOutputFile, not just the CLI's final message (#2948)", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Is this done?", body_html: "", login: "stjohnb" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processFollowUp(repo, issue, [openPhasePR(5)], [humanComment]);

      expect(mockClaude.runClaude).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ useOutputFile: true }));
    });

    it("answers on sonnet without deep thinking even on a Plan: Deep issue", async () => {
      const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Plan: Deep" }] });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Is this done?", body_html: "", login: "stjohnb" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processFollowUp(repo, issue, [openPhasePR(5)], [humanComment]);

      expect(mockResolveModelPlanCell).toHaveBeenCalledWith(repo.fullName, issue.number, "plan-refine", expect.objectContaining({ tier: "sonnet" }));
      expect(mockClaude.runClaude).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ tier: "sonnet", deepThinking: false }));
    });

    it("carries the approved requirements record into the follow-up prompt", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Is this done?", body_html: "", login: "stjohnb" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });

      await processFollowUp(repo, issue, [openPhasePR(5)], [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("## Approved requirements (v2");
    });

    it("degrades to a body-only prompt rather than aborting when the requirements read fails (#3388 test finding 3)", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Is this done?", body_html: "", login: "stjohnb" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "error" });

      await expect(processFollowUp(repo, issue, [openPhasePR(5)], [humanComment])).resolves.toBeUndefined();

      expect(mockClaude.runClaude).toHaveBeenCalled();
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).not.toContain("## Approved requirements");
    });

    it("responds to follow-up comments when issue has open PR", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Is everything healthy again?", body_html: "", login: "stjohnb" };

      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockClaude.runClaude.mockResolvedValue("Yes, everything looks healthy now.");

      await processFollowUp(repo, issue, [openPhasePR(5)], [humanComment]);

      expect(mockProcessTextForImages).toHaveBeenCalledWith(
        [issue.body, planComment.body, humanComment.body],
        "/tmp/worktree",
        repo,
        { agentName: "Planner", issueNumber: issue.number, repo: repo.fullName },
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        "Yes, everything looks healthy now.\n\n*Models used: sonnet (provider: claude)*",
        { agentName: "Planner" },
      );
      expect(mockGh.editIssueComment).not.toHaveBeenCalled();
      expect(mockGh.addReaction).toHaveBeenCalledWith(repo.fullName, 502, "+1");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, expect.any(Object));
    });
  });

  describe("stripRefinedForPendingFeedback", () => {
    const unreacted = [
      { id: 42, body: "please do X instead", body_html: "", login: "stjohnb" },
    ];

    it("removes the Refined label and posts a notice with the newest comment id", async () => {
      mockGh.getIssueComments.mockResolvedValue([]);

      await stripRefinedForPendingFeedback(repo.fullName, 7, unreacted, "Planner");

      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 7, "Refined");
      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
      const [, , body, opts] = mockGh.commentOnIssue.mock.calls[0];
      expect(body).toContain(`${PENDING_FEEDBACK_MARKER}: 42`);
      expect(opts).toEqual({ agentName: "Planner" });
    });

    it("does not post again when a notice for the same comment id already exists", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 999, body: `Already notified.\n\n${PENDING_FEEDBACK_MARKER}: 42`, body_html: "", login: "claws-bot" },
      ]);

      await stripRefinedForPendingFeedback(repo.fullName, 7, unreacted, "Planner");

      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 7, "Refined");
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("still posts when the existing marker carries an older comment id", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 999, body: `Already notified.\n\n${PENDING_FEEDBACK_MARKER}: 41`, body_html: "", login: "claws-bot" },
      ]);

      await stripRefinedForPendingFeedback(repo.fullName, 7, unreacted, "Planner");

      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
      const [, , body] = mockGh.commentOnIssue.mock.calls[0];
      expect(body).toContain(`${PENDING_FEEDBACK_MARKER}: 42`);
    });
  });

  describe("findUnreactedHumanComments", () => {
    it("returns comments without self reactions", async () => {
      const comments = [
        { id: 1, body: "Fix this please", body_html: "", login: "reviewer" },
        { id: 2, body: "Also this", body_html: "", login: "reviewer2" },
      ];
      mockGh.getCommentReactions.mockResolvedValue([]);

      const result = await findUnreactedHumanComments(repo.fullName, comments, "claws-bot[bot]", 1);

      expect(result).toHaveLength(2);
    });

    it("excludes comments already reacted to by self", async () => {
      const comments = [
        { id: 1, body: "Fix this please", body_html: "", login: "reviewer" },
      ];
      mockGh.getCommentReactions.mockResolvedValue([
        { user: { login: "claws-bot[bot]" }, content: "+1" },
      ]);

      const result = await findUnreactedHumanComments(repo.fullName, comments, "claws-bot[bot]", 1);

      expect(result).toHaveLength(0);
    });

    it("excludes Claws automated comments", async () => {
      const comments = [
        { id: 1, body: "*— Automated by Claws —*\n\nAutomated comment", body_html: "", login: "claws-bot" },
        { id: 2, body: "Human comment", body_html: "", login: "reviewer" },
      ];
      mockGh.getCommentReactions.mockResolvedValue([]);

      const result = await findUnreactedHumanComments(repo.fullName, comments, "claws-bot[bot]", 1);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(2);
    });

    it("excludes bot comments", async () => {
      const comments = [
        { id: 1, body: "Bot comment", body_html: "", login: "dependabot[bot]" },
        { id: 2, body: "Human comment", body_html: "", login: "reviewer" },
      ];
      mockGh.getCommentReactions.mockResolvedValue([]);

      const result = await findUnreactedHumanComments(repo.fullName, comments, "claws-bot[bot]", 1);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(2);
    });

    it("excludes comments from non-allowed actors", async () => {
      const comments = [
        { id: 1, body: "Random person's comment", body_html: "", login: "stranger" },
        { id: 2, body: "Allowed reviewer comment", body_html: "", login: "reviewer" },
      ];
      mockGh.isAllowedActor
        .mockResolvedValueOnce(false) // stranger
        .mockResolvedValueOnce(true); // reviewer
      mockGh.getCommentReactions.mockResolvedValue([]);

      const result = await findUnreactedHumanComments(repo.fullName, comments, "claws-bot[bot]", 1);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(2);
    });

    it("returns unreacted comments in input order with parallel fetches", async () => {
      const comments = [
        { id: 1, body: "Comment A", body_html: "", login: "reviewer" },
        { id: 2, body: "Comment B", body_html: "", login: "reviewer" },
        { id: 3, body: "Comment C", body_html: "", login: "reviewer" },
      ];
      mockGh.getCommentReactions
        .mockResolvedValueOnce([{ user: { login: "claws-bot[bot]" }, content: "+1" }]) // id:1 reacted
        .mockResolvedValueOnce([]) // id:2 unreacted
        .mockResolvedValueOnce([]); // id:3 unreacted

      const result = await findUnreactedHumanComments(repo.fullName, comments, "claws-bot[bot]", 1);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(2);
      expect(result[1].id).toBe(3);
    });

    it("treats a failed reaction fetch as unreacted (catch path)", async () => {
      const comments = [
        { id: 1, body: "Comment A", body_html: "", login: "reviewer" },
        { id: 2, body: "Comment B", body_html: "", login: "reviewer" },
      ];
      mockGh.getCommentReactions
        .mockRejectedValueOnce(new Error("network error")) // id:1 fails → unreacted
        .mockResolvedValueOnce([]); // id:2 unreacted

      const result = await findUnreactedHumanComments(repo.fullName, comments, "claws-bot[bot]", 1);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(1);
      expect(result[1].id).toBe(2);
    });
  });

  describe("isCiUnrelatedIssue", () => {
    it("returns true for ci-unrelated issues", () => {
      const issue = mockIssue({ title: "[ci-unrelated] CI failures unrelated to PR changes" });
      expect(isCiUnrelatedIssue(issue)).toBe(true);
    });

    it("returns false for regular issues", () => {
      const issue = mockIssue({ title: "Fix authentication bug" });
      expect(isCiUnrelatedIssue(issue)).toBe(false);
    });
  });

  describe("isAutoRefineIssue", () => {
    it("returns true for ci-unrelated issues", () => {
      const issue = mockIssue({ title: "[ci-unrelated] CI failures unrelated to PR changes" });
      expect(isAutoRefineIssue(issue)).toBe(true);
    });

    it("returns true for a plain issue carrying the Claws Auto-Refine label", () => {
      const issue = mockIssue({ title: "chore: add .mcp-claws.json to .gitignore", labels: [{ name: "Claws Auto-Refine" }] });
      expect(isAutoRefineIssue(issue)).toBe(true);
    });

    it("returns false for a plain issue carrying only the Automerge label", () => {
      const issue = mockIssue({ title: "chore: add .mcp-claws.json to .gitignore", labels: [{ name: "Automerge" }] });
      expect(isAutoRefineIssue(issue)).toBe(false);
    });

    it("returns false for a plain issue with no such label", () => {
      const issue = mockIssue({ title: "Fix authentication bug" });
      expect(isAutoRefineIssue(issue)).toBe(false);
    });
  });

  describe("plannerToolDocs", () => {
    it("describes all four outcomes when both candidate sections are present", () => {
      const docs = plannerToolDocs({ actingRepo: "o/r", duplicates: true, transfer: true, outcomes: true });
      expect(docs).toContain("claws_save_plan");
      expect(docs).toContain("`duplicate`, with `duplicate_of`");
      expect(docs).toContain("`transfer`, with `transfer_to`");
      expect(docs).toContain("`blocked`");
      expect(docs).toContain("`no_code_changes`");
      expect(docs).toContain("`repo` must be o/r");
    });

    it("omits duplicate and transfer when their sections were not injected", () => {
      const docs = plannerToolDocs({ actingRepo: "o/r", duplicates: false, transfer: false, outcomes: true });
      expect(docs).not.toContain("`duplicate`, with");
      expect(docs).not.toContain("`transfer`, with");
      expect(docs).toContain("`blocked`");
      expect(docs).toContain("`no_code_changes`");
    });

    it("offers no outcome at all to a plan-only pass", () => {
      const docs = plannerToolDocs({ actingRepo: "o/r", duplicates: true, transfer: true, outcomes: false });
      expect(docs).toContain("This pass cannot report an outcome.");
      expect(docs).not.toContain("claws_report_outcome —");
    });

    it("names the response field only when asked", () => {
      expect(plannerToolDocs({ actingRepo: "o/r", duplicates: false, transfer: false, outcomes: false, response: true })).toContain("`response`");
      expect(plannerToolDocs({ actingRepo: "o/r", duplicates: false, transfer: false, outcomes: false })).not.toContain("`response`");
    });

    it("lets a multi-repo issue's PRs name any of its repos", () => {
      expect(plannerToolDocs({ actingRepo: "o/a", duplicates: false, transfer: false, outcomes: false })).toContain("`repo` must be o/a;");
      const docs = plannerToolDocs({ actingRepo: "o/a", issueRepos: ["o/a", "o/b"], duplicates: false, transfer: false, outcomes: false });
      expect(docs).toContain("may be any of this issue's repositories: o/a, o/b");
      expect(docs).not.toContain("`repo` must be");
    });
  });

  describe("plannerAllowedRepos", () => {
    const NATIVE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

    it("drops an issue repo Claws does not manage, keeping the acting repo", async () => {
      mockDb.getClawsIssue.mockResolvedValueOnce({ repos: ["o/a", "o/b", "x/unmanaged"] });
      mockGh.listRepos.mockResolvedValueOnce([mockRepo({ fullName: "o/a" }), mockRepo({ fullName: "o/b" })]);
      expect(await plannerAllowedRepos("o/a", NATIVE)).toEqual(["o/a", "o/b"]);
    });

    it("drops a listed issue repo whose claws.json pauses it", async () => {
      mockDb.getClawsIssue.mockResolvedValueOnce({ repos: ["o/a", "o/b", "o/c"] });
      mockGh.listRepos.mockResolvedValueOnce(["o/a", "o/b", "o/c"].map((fullName) => mockRepo({ fullName })));
      // Checked in order: o/b (paused), then o/c. The acting repo is never checked.
      mockIsRepoMonitored.mockReturnValueOnce(false);
      expect(await plannerAllowedRepos("o/a", NATIVE)).toEqual(["o/a", "o/c"]);
      expect(mockIsRepoMonitored).toHaveBeenCalledWith("o/b");
    });

    it("leaves the issue's repos unfiltered when the listing is degraded", async () => {
      mockDb.getClawsIssue.mockResolvedValueOnce({ repos: ["o/a", "o/b"] });
      mockGh.listRepos.mockResolvedValueOnce([mockRepo({ fullName: "o/a" })]);
      mockGh.isRepoListDegraded.mockReturnValueOnce(true);
      expect(await plannerAllowedRepos("o/a", NATIVE)).toEqual(["o/a", "o/b"]);
    });

    it("is the acting repo alone for a forge issue", async () => {
      expect(await plannerAllowedRepos("o/a", 42)).toEqual(["o/a"]);
    });
  });

  describe("issueReposSection", () => {
    it("is empty for an issue with one repo", () => {
      expect(issueReposSection("o/a", ["o/a"])).toBe("");
    });

    it("lists a multi-repo issue's repos and names the primary", () => {
      const section = issueReposSection("o/a", ["o/a", "o/b"]);
      expect(section).toContain("This issue names several repositories: o/a, o/b.");
      expect(section).toContain("o/a is its primary repository");
      expect(section).toContain("in merge order");
    });

    // The step-back prompt and a GitHub-only owner's prompts have no
    // "Claws-managed repositories" section to point at.
    it("says how to read the other repos without relying on another section", () => {
      const section = issueReposSection("o/a", ["o/a", "o/b"]);
      expect(section).toContain("gh api repos/OWNER/NAME/contents/PATH");
      expect(section).toContain("$CLAWS_FORGEJO_BASE_URL/api/v1/repos/OWNER/NAME/raw/PATH");
      expect(section).not.toContain("Claws-managed repositories");
    });
  });

  describe("renderPlanBody", () => {
    const base = { kind: "plan" as const, plan: "Plan text", prs: [{ repo: "o/r", title: "t", dependsOn: null }], implementationModel: "haiku" as const, reviewModel: "opus" as const, targetPr: null, response: null };

    it("appends the two model lines", () => {
      expect(renderPlanBody(base)).toBe("Plan text\n\n**Recommended implementation model:** `haiku`\n**Recommended review model:** `opus`");
    });

    it("puts CLAWS_TARGET_PR on the last line when set", () => {
      const body = renderPlanBody({ ...base, targetPr: 12 });
      expect(body.split("\n").at(-1)).toBe("CLAWS_TARGET_PR: #12");
    });

    it("drops model and target lines the agent typed into the text itself", () => {
      const body = renderPlanBody({ ...base, plan: "Plan text\n**Recommended implementation model:** `opus`\nCLAWS_TARGET_PR: #99" });
      expect(body).not.toContain("`opus`\n**Recommended review");
      expect(body.match(/Recommended implementation model/g)).toHaveLength(1);
      expect(body).not.toContain("#99");
    });
  });

  describe("parseTransferredFrom", () => {
    it("extracts the owner/repo from a stamp", () => {
      expect(parseTransferredFrom("CLAWS_TRANSFERRED_FROM: test-org/test-repo#2215")).toBe("test-org/test-repo");
    });

    it("returns null when absent", () => {
      expect(parseTransferredFrom("no stamp here")).toBeNull();
    });

    it("extracts the owner/repo from a stamp naming a native issue id", () => {
      expect(
        parseTransferredFrom("CLAWS_TRANSFERRED_FROM: test-org/repo#clw_01JBQ5ZK3N8T4Q7M2V9XWR6HDA"),
      ).toBe("test-org/repo");
    });
  });

  describe("alreadyTransferredInto", () => {
    it("is true when a stamp names a DIFFERENT repo than the current one", () => {
      expect(alreadyTransferredInto("test-org/a", ["CLAWS_TRANSFERRED_FROM: test-org/b#1"])).toBe(true);
    });

    it("is false when the stamp names the CURRENT repo (failed-transfer retry)", () => {
      expect(alreadyTransferredInto("test-org/a", ["CLAWS_TRANSFERRED_FROM: test-org/a#1"])).toBe(false);
    });

    it("is false when no text carries a stamp", () => {
      expect(alreadyTransferredInto("test-org/a", ["just a normal comment"])).toBe(false);
    });

    it("fires the one-hop guard for a stamp naming a native issue id", () => {
      expect(
        alreadyTransferredInto("test-org/a", ["CLAWS_TRANSFERRED_FROM: test-org/b#clw_01JBQ5ZK3N8T4Q7M2V9XWR6HDA"]),
      ).toBe(true);
    });
  });

  describe("buildManagedReposSection (#3067)", () => {
    it("returns an empty string for a GitHub-only owner", () => {
      const current = mockRepo();
      const allRepos = [
        current,
        { owner: "test-org", name: "sibling", fullName: "test-org/sibling", defaultBranch: "main" },
      ];
      expect(buildManagedReposSection(current, allRepos)).toBe("");
    });

    it("lists same-owner repos on both forges with the companion-issue instructions", () => {
      const current = mockRepo();
      const allRepos = [
        current,
        { owner: "test-org", name: "sibling", fullName: "test-org/sibling", defaultBranch: "main" },
        { owner: "test-org", name: "forgejo", fullName: "test-org/forgejo", defaultBranch: "main", forge: "forgejo" as const },
        { owner: "other-org", name: "foreign", fullName: "other-org/foreign", defaultBranch: "main", forge: "forgejo" as const },
      ];
      const section = buildManagedReposSection(current, allRepos);
      expect(section).toContain("## Claws-managed repositories");
      expect(section).toContain("- test-org/forgejo (Forgejo)");
      expect(section).toContain("- test-org/sibling (GitHub)");
      expect(section).not.toContain("test-org/test-repo (");
      expect(section).not.toContain("other-org/foreign");
      expect(section).toContain('curl -sX POST');
      expect(section).toContain("$CLAWS_FORGEJO_READ_TOKEN");
      expect(section).not.toContain("$CLAWS_FORGEJO_TOKEN");
      expect(section).toContain("gh api repos/OWNER/NAME/contents/PATH");
      expect(section).toContain("$CLAWS_FORGEJO_BASE_URL/api/v1/repos/<owner>/<repo>/issues");
      expect(section).toContain("claws_create_issue");
      expect(section).toContain("gh issue create --repo");
    });

    it("is included in the new-plan prompt when the owner has a Forgejo repo", async () => {
      mockGh.listRepos.mockResolvedValue([
        { owner: "test-org", name: "test-repo", fullName: "test-org/test-repo", defaultBranch: "main" },
        { owner: "test-org", name: "forgejo", fullName: "test-org/forgejo", defaultBranch: "main", forge: "forgejo" },
      ]);
      await processIssue(repo, mockIssue({ body: "Needs a companion change" }));

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("## Claws-managed repositories");
      expect(prompt).toContain("- test-org/forgejo (Forgejo)");
    });
  });

  describe("forge-aware research instructions (#3067)", () => {
    it("tells a Forgejo-repo planner to read references through the Forgejo API", async () => {
      const forgejoRepo = mockRepo({ forge: "forgejo" });
      await processIssue(forgejoRepo, mockIssue({ body: "See #12" }));

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("$CLAWS_FORGEJO_BASE_URL/api/v1/repos/<owner>/<repo>/issues/<n>");
      expect(prompt).toContain("a bare `#123` refers to an issue or PR in this Forgejo repo");
    });

    it("does not claim bare #123 is a Forgejo reference for a GitHub repo", async () => {
      await processIssue(repo, mockIssue({ body: "See #12" }));

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("gh issue view <n>");
      expect(prompt).not.toContain("in this Forgejo repo");
    });

    it("passes forgejoAccessRepo to the planner run", async () => {
      await processIssue(repo, mockIssue({ body: "Add a feature" }));

      const opts = mockClaude.runClaude.mock.calls[0][2] as { forgejoAccessRepo?: string };
      expect(opts.forgejoAccessRepo).toBe(repo.fullName);
    });
  });

  describe("selectTransferCandidates", () => {
    it("excludes cross-owner repos and the current repo", () => {
      const current = mockRepo({ owner: "test-org", fullName: "test-org/test-repo" });
      const allRepos = [
        current,
        { owner: "test-org", name: "sibling", fullName: "test-org/sibling", defaultBranch: "main" },
        { owner: "other-org", name: "foreign", fullName: "other-org/foreign", defaultBranch: "main" },
      ];
      expect(selectTransferCandidates(current, allRepos)).toEqual(["test-org/sibling"]);
    });

    it("excludes Forgejo repos as targets — cross-forge transfer is impossible (#2650)", () => {
      const current = mockRepo({ owner: "test-org", fullName: "test-org/test-repo" });
      const allRepos = [
        current,
        { owner: "test-org", name: "sibling", fullName: "test-org/sibling", defaultBranch: "main" },
        { owner: "test-org", name: "migrated", fullName: "test-org/migrated", defaultBranch: "main" },
      ];
      mockIsForgejoRepo.mockImplementation((fullName: string) => fullName === "test-org/migrated");

      expect(selectTransferCandidates(current, allRepos)).toEqual(["test-org/sibling"]);
    });

    it("returns nothing when the source repo is on Forgejo — Gitea has no transfer API (#2650)", () => {
      const current = mockRepo({ owner: "test-org", fullName: "test-org/migrated" });
      const allRepos = [
        current,
        { owner: "test-org", name: "sibling", fullName: "test-org/sibling", defaultBranch: "main" },
      ];
      mockIsForgejoRepo.mockImplementation((fullName: string) => fullName === "test-org/migrated");

      expect(selectTransferCandidates(current, allRepos)).toEqual([]);
    });
  });

  describe("buildLinkedIssuesSection", () => {
    const ID = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    const link = { id: "cll_1", kind: "blocks" as const, otherId: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD", otherTitle: "Later work", otherState: "closed", otherStateReason: "completed", otherLifecycle: "ideas" as const, releasedAt: null };

    it("is empty for a forge issue with no links", () => {
      expect(buildLinkedIssuesSection("o/r", [], { canLink: false, outcomes: true, issueRef: 12 })).toBe("");
    });

    it("lists each link from this issue's side and, for a native issue, how to record a dependency", () => {
      const section = buildLinkedIssuesSection("o/r", [link], { canLink: true, outcomes: true, issueRef: ID });
      expect(section).toContain("- blocks #clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD — Later work (closed)");
      expect(section).toContain(`\`claws_link_issues\` (issue_id \`${ID}\`, kind \`depends_on\``);
      expect(section).toContain("then report `blocked`");
      expect(buildLinkedIssuesSection("o/r", [], { canLink: true, outcomes: false, issueRef: ID })).not.toContain("report `blocked`");
    });
  });

  describe("buildDuplicateCandidatesSection", () => {
    beforeEach(() => {
      __resetPostedCommentsForTests();
    });

    it("attributes the injection warning to the candidate issue, not the issue being refined", async () => {
      const candidate = mockIssue({ number: 236, title: "udev rule", body: "Ship a small override your rules file" });
      buildDuplicateCandidatesSection("test-org/test-repo", 239, [candidate]);

      // The defensive comment is posted fire-and-forget via a dynamic import of github.js;
      // flush pending microtasks so the awaited import + commentOnIssue settle.
      await new Promise((r) => setImmediate(r));

      const injectionComment = mockGh.commentOnIssue.mock.calls.find(
        (c: unknown[]) => typeof c[2] === "string" && (c[2] as string).includes("prompt injection detected"),
      );
      expect(injectionComment).toBeDefined();
      expect(injectionComment![1]).toBe(236);
    });

    it("truncates candidate bodies before guarding, so a match beyond the limit never reaches the model or triggers an alert", async () => {
      const candidate = mockIssue({ number: 236, title: "udev rule", body: "x".repeat(600) + "override your rules" });
      const section = buildDuplicateCandidatesSection("test-org/test-repo", 239, [candidate]);

      await new Promise((r) => setImmediate(r));

      expect(section).not.toContain("[content redacted");
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });
  });

  describe("stripLeadingPlanHeader", () => {
    it("strips a bare leading header", () => {
      expect(stripLeadingPlanHeader("## Implementation Plan")).toBe("");
    });

    it("strips header followed by content", () => {
      expect(stripLeadingPlanHeader("## Implementation Plan\n\nplan body")).toBe("plan body");
    });

    it("leaves '## Implementation Plan for X' untouched", () => {
      expect(stripLeadingPlanHeader("## Implementation Plan for Feature X\n\nbody")).toBe(
        "## Implementation Plan for Feature X\n\nbody",
      );
    });

    it("is a no-op when header is absent", () => {
      expect(stripLeadingPlanHeader("plan body without header")).toBe("plan body without header");
    });

    it("strips when output has leading whitespace before the header", () => {
      expect(stripLeadingPlanHeader("  ## Implementation Plan\n\ncontent")).toBe("content");
    });
  });

  describe("isDegeneratePlanOutput (#2948)", () => {
    it("flags the exact fleet-infra#1245 follow-up note as degenerate", () => {
      const note = [
        ``,
        ``,
        `## Implementation Plan`,
        ``,
        `The completed background command was the first polling attempt — its shell quoting was mangled, so it wrote no rows. Its replacement (\`/tmp/poll.sh\`) already supplied the \`pg_stat_activity\` samples used in the plan, and both pollers are now stopped. No change to the plan above.`,
        ``,
        `*Models used: opus (provider: claude)*`,
        ``,
        `CLAWS_PLAN_BODY_HASH: 1ed8552f…`,
        `CLAWS_PLAN_LAST_COMMENT: 0`,
      ].join("\n");
      expect(isDegeneratePlanOutput(note)).toBe(true);
    });

    it("flags empty and whitespace-only output as degenerate", () => {
      expect(isDegeneratePlanOutput("")).toBe(true);
      expect(isDegeneratePlanOutput("   \n  ")).toBe(true);
    });

    it("does not flag a short body that carries the model recommendation line", () => {
      const body = "x".repeat(180) + "\n\n**Recommended implementation model:** `sonnet`";
      expect(body.length).toBeLessThan(MIN_PLAN_CHARS_WITHOUT_MODEL_LINE);
      expect(isDegeneratePlanOutput(body)).toBe(false);
    });

    it("does not flag a long body even without the model recommendation line", () => {
      const body = "x".repeat(2_000);
      expect(isDegeneratePlanOutput(body)).toBe(false);
    });
  });

  describe("processIssue — no-code-changes verdict", () => {
    it("applies Claws Ignore label and posts explanation comment, does NOT add Ready", async () => {
      const issue = mockIssue({ number: 42, body: "Disk usage was already cleaned up." });
      mockPlannerRun("The underlying fix was already deployed in the last release.", { verdict: "no_code_changes" });

      await processIssue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Claws Ignore");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      const commentCall = mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => c[1] === 42);
      expect(commentCall).toBeDefined();
      expect(commentCall![2]).toContain("## Implementation Plan");
      expect(commentCall![2]).toContain("does **not** require any code change");
      expect(commentCall![2]).toContain("The underlying fix was already deployed");
      // A verdict suppresses the degenerate-plan retry, however short the prose is.
      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    });

    it("prompt tells the planner to report it through claws_report_outcome", async () => {
      const issue = mockIssue({ body: "Operational task only" });
      await processIssue(repo, issue);
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain(`claws_report_outcome\` with \`outcome: "no_code_changes"\``);
      expect(prompt).toContain(`claws_report_outcome\` with \`outcome: "blocked"\``);
      // With no candidates and no routing destinations, only the two section-free
      // outcomes may be offered — in the prompt and in the run's tool config.
      expect(prompt).toContain(plannerToolDocs({ actingRepo: repo.fullName, duplicates: false, transfer: false, outcomes: true }));
      expect(plannerRunsWritten()[0]).toMatchObject({ stage: "plan", offers: [] });
      const opts = mockClaude.runClaude.mock.calls[0][2] as { mcpConfig?: string; useOutputFile?: boolean; verdictFile?: unknown };
      expect(runIdOf(opts)).not.toBe("");
      expect(opts.useOutputFile).toBeUndefined();
      expect(opts.verdictFile).toBeUndefined();
    });

    it("posts the plan normally when the planner's prose says so but no outcome is reported", async () => {
      const issue = mockIssue({ number: 42, body: "Operational task only" });
      mockPlannerRun("## Plan\nNo code change is needed here, really.\n\n**Recommended implementation model:** `sonnet`", null);

      await processIssue(repo, issue);

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Claws Ignore");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    });
  });

  describe("processIssue — planner prose is never a verdict (#3155)", () => {
    it("posts a plan that discusses all four verdicts verbatim and triggers none of them", async () => {
      const current = mockIssue({ number: 459, title: "Planner verdict contract" });
      const canonical = mockIssue({ number: 458, title: "Earlier issue", body: "..." });
      mockGh.listOpenIssues.mockResolvedValue([current, canonical]);
      mockGh.listRepos.mockResolvedValue([
        { owner: "test-org", name: "test-repo", fullName: "test-org/test-repo", defaultBranch: "main" },
        { owner: "test-org", name: "other-repo", fullName: "test-org/other-repo", defaultBranch: "main" },
      ]);
      const planBody = [
        `## Implementation Plan`,
        ``,
        `The planner has four verdicts: duplicate, transfer, blocked and no-code-changes.`,
        `Inline, they are written as {"verdict":"duplicate","duplicate_of":458},`,
        `{"verdict":"transfer","transfer_to":"test-org/other-repo"}, {"verdict":"blocked"}`,
        `and {"verdict":"no_code_changes"}. The legacy marker lines were CLAWS_NO_CODE_CHANGES,`,
        `CLAWS_BLOCKED, CLAWS_TRANSFER_TO: test-org/other-repo and DUPLICATE_OF: #458.`,
        ``,
        "```json",
        `{"verdict":"duplicate","duplicate_of":458}`,
        "```",
        ``,
        `Every one of those must survive into the posted comment untouched.`,
        ``,
        `**Recommended implementation model:** \`opus\``,
        `**Recommended review model:** \`opus\``,
      ].join("\n");
      mockPlannerRun(planBody, null);

      await processIssue(repo, current);

      const planCall = mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => c[1] === 459);
      expect(planCall).toBeDefined();
      const body = planCall![2] as string;
      // Every verdict-shaped string the plan discusses survives verbatim.
      expect(body).toContain(`{"verdict":"duplicate","duplicate_of":458}`);
      expect(body).toContain(`{"verdict":"transfer","transfer_to":"test-org/other-repo"}`);
      expect(body).toContain(`{"verdict":"blocked"}`);
      expect(body).toContain(`{"verdict":"no_code_changes"}`);
      expect(body).toContain("CLAWS_NO_CODE_CHANGES,");
      expect(body).toContain("CLAWS_BLOCKED, CLAWS_TRANSFER_TO: test-org/other-repo and DUPLICATE_OF: #458.");
      expect(body).toContain("Every one of those must survive into the posted comment untouched.");
      // ...and none of them fired.
      expect(mockGh.transferIssue).not.toHaveBeenCalled();
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 459, "Duplicate");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 459, "Blocked");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 459, "Claws Ignore");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 459, "Ready");
      expect(mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => c[1] === 458)).toBeUndefined();
    });
  });

  describe("processIssue — planner tools", () => {
    const longText = "### Requirement\n" + "Detail. ".repeat(200);

    it("renders the saved plan with its model lines and target PR", async () => {
      const issue = mockIssue({ number: 42, body: "Test issue body" });
      mockSavedPlan(planInput({ plan: "## Implementation Plan\n\nShort plan", implementation_model: "haiku", review_model: "sonnet", target_pr: 77 }));

      await processIssue(repo, issue);

      // A tool submission is never degenerate, however short: no retry.
      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
      const body = mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => c[1] === 42)![2] as string;
      expect(body).toContain("## Implementation Plan\n\nShort plan\n\n**Recommended implementation model:** `haiku`\n**Recommended review model:** `sonnet`\n\nCLAWS_TARGET_PR: #77");
      expect(body).not.toContain("Done.");
    });

    it("stores the saved PR list after posting the plan", async () => {
      const issue = mockIssue({ number: 42, body: "Test issue body" });
      mockSavedPlan(planInput({ plan: "### PR 1: A\na\n\n### PR 2: B\nb", prs: [{ repo: "test-org/test-repo", title: "A" }, { repo: "test-org/test-repo", title: "B" }] }));

      await processIssue(repo, issue);

      expect(mockDb.createShadowIssue).toHaveBeenCalledWith(repo.fullName, 42, expect.objectContaining({ title: issue.title }));
      expect(mockDb.replaceIssuePlannedPRs).toHaveBeenCalledWith("clw_SHADOW", [
        { repo: "test-org/test-repo", title: "A", dependsOn: null },
        { repo: "test-org/test-repo", title: "B", dependsOn: null },
      ]);
      const posted = mockGh.commentOnIssue.mock.invocationCallOrder[0]!;
      expect(mockDb.replaceIssuePlannedPRs.mock.invocationCallOrder[0]).toBeGreaterThan(posted);
    });

    it("stores the step-back revision's PR list, not the original plan's", async () => {
      const issue = mockIssue({ number: 42, body: "Test issue body" });
      mockClaude.runClaude.mockImplementation(async (_p: string, _c: string, opts?: { mcpConfig?: string }) => {
        const runId = runIdOf(opts);
        const stage = plannerRunsWritten().find((r) => r.id === runId)!.stage;
        if (stage === "plan") {
          expect(submitPlan(runId, planInput({ plan: longText, prs: [{ repo: "test-org/test-repo", title: "Original" }] }))).toEqual({ ok: true });
        } else {
          expect(submitStepBack(runId, {
            verdict: "reconsider",
            critique: "Simpler to delete the module.",
            revised: planInput({ plan: "### PR 1: Delete\nx\n\n### PR 2: Clean up\ny", prs: [{ repo: "test-org/test-repo", title: "Delete" }, { repo: "test-org/test-repo", title: "Clean up" }] }),
          })).toEqual({ ok: true });
        }
        return "Done.";
      });

      await processIssue(repo, issue);

      expect(plannerRunsWritten().map((r) => r.stage)).toEqual(["plan", "step_back"]);
      const planBody = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(planBody).toContain("### PR 1: Delete");
      expect(planBody).toContain(STEP_BACK_RECONSIDER_MARKER);
      expect(mockGh.commentOnIssue.mock.calls[1][2] as string).toContain("Simpler to delete the module.");
      expect(mockDb.replaceIssuePlannedPRs).toHaveBeenCalledWith("clw_SHADOW", [
        { repo: "test-org/test-repo", title: "Delete", dependsOn: null },
        { repo: "test-org/test-repo", title: "Clean up", dependsOn: null },
      ]);
    });

    it("keeps the plan's list when the step-back verdict is sound", async () => {
      const issue = mockIssue({ number: 42, body: "Test issue body" });
      mockClaude.runClaude.mockImplementation(async (_p: string, _c: string, opts?: { mcpConfig?: string }) => {
        const runId = runIdOf(opts);
        const stage = plannerRunsWritten().find((r) => r.id === runId)!.stage;
        if (stage === "plan") submitPlan(runId, planInput({ plan: longText }));
        else submitStepBack(runId, { verdict: "sound" });
        return "Done.";
      });

      await processIssue(repo, issue);

      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
      expect(mockDb.replaceIssuePlannedPRs).toHaveBeenCalledWith("clw_SHADOW", [{ repo: "test-org/test-repo", title: "Do the thing", dependsOn: null }]);
    });

    it("keeps the plan and warns when the step-back verdict call was rejected, treating the text fallback as sound", async () => {
      const issue = mockIssue({ number: 42, body: "Test issue body" });
      mockClaude.runClaude.mockImplementation(async (_p: string, _c: string, opts?: { mcpConfig?: string }) => {
        const runId = runIdOf(opts);
        const stage = plannerRunsWritten().find((r) => r.id === runId)!.stage;
        if (stage === "plan") submitPlan(runId, planInput({ plan: longText }));
        else expect(submitStepBack(runId, { verdict: "sound", revised: planInput() }).ok).toBe(false);
        return "Done.";
      });

      await processIssue(repo, issue);

      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
      expect(mockDb.replaceIssuePlannedPRs).toHaveBeenCalledWith("clw_SHADOW", [{ repo: "test-org/test-repo", title: "Do the thing", dependsOn: null }]);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("every claws_step_back_verdict call was rejected (1, last:"));
    });

    it("falls back to the final message, with no stored list, when the planner never saves a plan", async () => {
      const issue = mockIssue({ number: 42, body: "Test issue body" });
      mockClaude.runClaude.mockResolvedValue("## Implementation Plan\n\nFinal-message plan\n\n**Recommended implementation model:** `sonnet`");

      await processIssue(repo, issue);

      const body = mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => c[1] === 42)![2] as string;
      expect(body).toContain("Final-message plan");
      // Nothing is stored — and no shadow is minted just to hold an empty list.
      expect(mockDb.createShadowIssue).not.toHaveBeenCalled();
      expect(mockDb.replaceIssuePlannedPRs).not.toHaveBeenCalled();
    });

    it("fails the run and posts nothing when every claws_save_plan call was rejected (#clw_01M3A42ZTGECAB11S0BZA6NG1A)", async () => {
      const issue = mockIssue({ number: 42, body: "Test issue body" });
      mockClaude.runClaude.mockImplementation(async (prompt: string, _cwd: string, opts?: { mcpConfig?: string }) => {
        if (prompt.includes("Respond with ONLY one word")) return "sonnet";
        // The planner tries twice and is refused both times, then complains.
        for (let i = 0; i < 2; i++) {
          expect(submitPlan(runIdOf(opts), planInput({ prs: [{ repo: "someone/else", title: "x" }] })).ok).toBe(false);
        }
        return "## Implementation Plan\n\nThe plan could not be saved: HTTP 400.\n\n**Recommended implementation model:** `sonnet`";
      });

      await expect(processIssue(repo, issue)).rejects.toThrow(/every planner tool call was rejected \(2 calls, last: .*someone\/else/);

      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockGh.addLabel).not.toHaveBeenCalled();
      expect(mockDb.replaceIssuePlannedPRs).not.toHaveBeenCalled();
      expect(vi.mocked(log.error)).toHaveBeenCalledWith(expect.stringContaining("refusing to publish the final message as a plan"));
    });

    it("clears a stale stored list whose PR count the new unsaved plan no longer matches, warning about dropped links", async () => {
      const issue = mockIssue({ number: 42, body: "Test issue body" });
      mockDb.getLinkedNativeId.mockResolvedValue("clw_TRACKED");
      mockDb.getIssuePlannedPRs.mockResolvedValue([
        { position: 1, repo: "test-org/test-repo", title: "A", prNumber: null },
        { position: 2, repo: "test-org/test-repo", title: "B", prNumber: 40 },
      ]);
      mockDb.replaceIssuePlannedPRs.mockResolvedValue([{ position: 2, repo: "test-org/test-repo", title: "B", prNumber: 40 }]);
      mockClaude.runClaude.mockResolvedValue("## Implementation Plan\n\nFinal-message plan\n\n**Recommended implementation model:** `sonnet`");

      await processIssue(repo, issue);

      expect(mockDb.replaceIssuePlannedPRs).toHaveBeenCalledWith("clw_TRACKED", []);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("test-org/test-repo#40"));
    });

    it("keeps a stored list the new unsaved plan still matches, so its links survive", async () => {
      const issue = mockIssue({ number: 42, body: "Test issue body" });
      mockDb.getLinkedNativeId.mockResolvedValue("clw_TRACKED");
      mockDb.getIssuePlannedPRs.mockResolvedValue([{ position: 1, repo: "test-org/test-repo", title: "A", prNumber: 40 }]);
      mockClaude.runClaude.mockResolvedValue("## Implementation Plan\n\nFinal-message plan\n\n**Recommended implementation model:** `sonnet`");

      await processIssue(repo, issue);

      expect(mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => c[1] === 42)![2]).toContain("Final-message plan");
      expect(mockDb.replaceIssuePlannedPRs).not.toHaveBeenCalled();
    });

    it("warns about a linked entry the saved list drops", async () => {
      const issue = mockIssue({ number: 42, body: "Test issue body" });
      mockDb.replaceIssuePlannedPRs.mockResolvedValue([{ position: 2, repo: "test-org/test-repo", title: "B", prNumber: 40 }]);
      mockSavedPlan(planInput());

      await processIssue(repo, issue);

      expect(mockDb.replaceIssuePlannedPRs).toHaveBeenCalledWith("clw_SHADOW", [{ repo: "test-org/test-repo", title: "Do the thing", dependsOn: null }]);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringMatching(/step 2 \(test-org\/test-repo#40, "B"\) is no longer in the plan's PR list/));
    });

    it.each([
      ["storing the list", () => mockDb.replaceIssuePlannedPRs.mockRejectedValue(new Error("db down"))],
      ["minting the shadow", () => mockDb.createShadowIssue.mockRejectedValue(new Error("db down"))],
    ])("still posts the plan and marks it Ready when %s fails", async (_label, fail) => {
      const issue = mockIssue({ number: 42, body: "Test issue body" });
      fail();
      mockSavedPlan(planInput());

      await expect(processIssue(repo, issue)).resolves.not.toThrow();

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(repo.fullName, 42, expect.stringContaining("Do the thing."), { agentName: "Planner" });
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 42, "Ready");
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("Could not store the planned-PR list"));
    });

    it("publishes nothing when the run saved a plan and then failed", async () => {
      const issue = mockIssue({ number: 42, body: "Test issue body" });
      mockClaude.runClaude.mockImplementation(async (_p: string, _c: string, opts?: { mcpConfig?: string }) => {
        expect(submitPlan(runIdOf(opts), planInput())).toEqual({ ok: true });
        throw new Error("Claude timed out");
      });

      await processIssue(repo, issue).catch(() => {});

      expect(mockGh.commentOnIssue).not.toHaveBeenCalledWith(repo.fullName, 42, expect.stringContaining(PLAN_HEADER), expect.anything());
      expect(mockDb.replaceIssuePlannedPRs).not.toHaveBeenCalled();
      expect(mockDb.createShadowIssue).not.toHaveBeenCalled();
    });

    it("rejects a PR in a repo outside the issue's and lets the agent retry", async () => {
      const issue = mockIssue({ number: 42, body: "Test issue body" });
      mockClaude.runClaude.mockImplementation(async (_p: string, _c: string, opts?: { mcpConfig?: string }) => {
        const runId = runIdOf(opts);
        const first = submitPlan(runId, planInput({ prs: [{ repo: "someone/else", title: "x" }] }));
        expect(first).toEqual({ ok: false, error: expect.stringContaining("test-org/test-repo") });
        expect(submitPlan(runId, planInput())).toEqual({ ok: true });
        return "Done.";
      });

      await processIssue(repo, issue);

      expect(mockDb.replaceIssuePlannedPRs).toHaveBeenCalledWith("clw_SHADOW", [{ repo: "test-org/test-repo", title: "Do the thing", dependsOn: null }]);
    });
  });

  describe("processIssue — blocked verdict", () => {
    it("applies Blocked, removes Ready and posts the planner's explanation", async () => {
      const issue = mockIssue({ number: 42, labels: [{ name: "Ready" }] });
      mockPlannerRun("Waiting on upstream release v2.0, which has not shipped as of today.", { verdict: "blocked" });

      await processIssue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 42, "Blocked");
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 42, "Ready");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 42, "Ready");
      const commentCall = mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => c[1] === 42);
      expect(commentCall![2]).toContain("blocked on an external precondition");
      expect(commentCall![2]).toContain("Waiting on upstream release v2.0");
      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    });
  });

  describe("processIssue — duplicate detection", () => {
    it("posts a minimal 'See #N' plan when the planner reports a duplicate verdict", async () => {
      const current = mockIssue({ number: 459, title: "[k3s] CrashLoopBackOff: ns/foo" });
      const canonical = mockIssue({ number: 458, title: "[k3s] CrashLoopBackOff: ns/bar", body: "..." });
      mockGh.listOpenIssues.mockResolvedValue([current, canonical]);
      mockPlannerRun("Same root cause as the earlier alert.", { verdict: "duplicate", duplicate_of: 458 });

      await processIssue(repo, current);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("`outcome: \"duplicate\"` and `duplicate_of`");
      const calls = mockGh.commentOnIssue.mock.calls;
      const planCall = calls.find((c: unknown[]) => c[1] === 459);
      expect(planCall).toBeDefined();
      expect(planCall![2]).toContain("## Implementation Plan");
      expect(planCall![2]).toContain("#458");
      expect(planCall![2]).toContain("CLAWS_DUPLICATE_OF: #458");
      // The prompt asks for a "why" paragraph, so it must reach the human.
      expect(planCall![2]).toContain("Same root cause as the earlier alert.");
      const backrefCall = calls.find((c: unknown[]) => c[1] === 458);
      expect(backrefCall).toBeDefined();
      expect(backrefCall![2]).toContain("#459");
      expect(mockGh.addLabel).toHaveBeenCalledWith("test-org/test-repo", 459, "Duplicate");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith("test-org/test-repo", 458, "Duplicate");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith("test-org/test-repo", 459, "Ready");
    });

    it("offers the duplicate verdict only when candidates were injected", async () => {
      const current = mockIssue({ number: 459 });
      const sibling = mockIssue({ number: 458 });
      mockGh.listOpenIssues.mockResolvedValue([current, sibling]);

      await processIssue(repo, current);
      expect(mockClaude.runClaude.mock.calls[0][0] as string).toContain("`duplicate`, with `duplicate_of`");
      expect(plannerRunsWritten()[0]!.offers).toEqual(["duplicate"]);

      vi.clearAllMocks();
      mockClaude.withNewWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
      mockClaude.runClaude.mockResolvedValue("## Plan\nDo the thing\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`");
      mockGh.listOpenIssues.mockResolvedValue([current]);

      await processIssue(repo, current);
      expect(mockClaude.runClaude.mock.calls[0][0] as string).not.toContain("`duplicate`, with `duplicate_of`");
      expect(plannerRunsWritten()[0]!.offers).toEqual([]);
    });

    it("posts a normal plan when no duplicate verdict is written", async () => {
      const current = mockIssue({ number: 459 });
      const sibling = mockIssue({ number: 458 });
      mockGh.listOpenIssues.mockResolvedValue([current, sibling]);
      mockPlannerRun("## Plan\nDo work\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`", null);

      await processIssue(repo, current);

      const planCall = mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => c[1] === 459);
      expect(planCall![2]).toContain("Do work");
      expect(mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => c[1] === 458)).toBeUndefined();
      expect(mockGh.addLabel).not.toHaveBeenCalledWith("test-org/test-repo", 459, "Duplicate");
    });

    it("refuses a duplicate verdict naming a higher-numbered issue (not in candidates), and a run with only that refused call fails", async () => {
      const current = mockIssue({ number: 458 });
      const sibling = mockIssue({ number: 459 });
      mockGh.listOpenIssues.mockResolvedValue([current, sibling]);
      mockPlannerRun("## Plan\nx\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`", { verdict: "duplicate", duplicate_of: 459 }, "the duplicate outcome is not available");

      // A refused call is not silence: the final message is not published as
      // a plan, and nothing is marked (#clw_01M3A42ZTGECAB11S0BZA6NG1A).
      await expect(processIssue(repo, current)).rejects.toThrow("every planner tool call was rejected");

      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockGh.addLabel).not.toHaveBeenCalledWith("test-org/test-repo", 458, "Duplicate");
    });

    it("rejects a duplicate outcome with no explanation, so nothing is marked", async () => {
      const current = mockIssue({ number: 459 });
      const canonical = mockIssue({ number: 458 });
      mockGh.listOpenIssues.mockResolvedValue([current, canonical]);
      const longPlan = "## Plan\n" + "x".repeat(1_600);
      mockClaude.runClaude.mockImplementation(async (_p: string, _c: string, opts?: { mcpConfig?: string }) => {
        expect(submitOutcome(runIdOf(opts), { outcome: "duplicate", duplicate_of: 458, explanation: "  " })).toEqual({ ok: false, error: expect.stringContaining("explanation") });
        return longPlan;
      });

      await expect(processIssue(repo, current)).rejects.toThrow("every planner tool call was rejected");

      expect(mockGh.addLabel).not.toHaveBeenCalledWith("test-org/test-repo", 459, "Duplicate");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith("test-org/test-repo", 459, "Ready");
    });

    it("excludes clawsIgnore-labelled issues from candidates", async () => {
      const current = mockIssue({ number: 460 });
      const ignored = mockIssue({ number: 458, labels: [{ name: "Claws Ignore" }] });
      const valid = mockIssue({ number: 459 });
      mockGh.listOpenIssues.mockResolvedValue([current, ignored, valid]);
      mockClaude.runClaude.mockImplementation(async (prompt: string) => {
        if (prompt.includes("Respond with ONLY one word")) return "sonnet";
        expect(prompt).not.toContain("#458:");
        return "## Plan\nDo work\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`";
      });

      await processIssue(repo, current);
    });

    it("excludes isItemSkipped issues from candidates", async () => {
      const current = mockIssue({ number: 460 });
      const skipped = mockIssue({ number: 458 });
      const valid = mockIssue({ number: 459 });
      mockGh.listOpenIssues.mockResolvedValue([current, skipped, valid]);
      mockGh.isItemSkipped.mockImplementation((_repo: string, n: number) => n === 458);
      mockClaude.runClaude.mockImplementation(async (prompt: string) => {
        if (prompt.includes("Respond with ONLY one word")) return "sonnet";
        expect(prompt).not.toContain("#458:");
        expect(prompt).toContain("#459:");
        return "## Plan\nDo work\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`";
      });

      await processIssue(repo, current);
      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    });

    it("still posts plan if canonical back-reference fails", async () => {
      const current = mockIssue({ number: 459 });
      const canonical = mockIssue({ number: 458 });
      mockGh.listOpenIssues.mockResolvedValue([current, canonical]);
      mockPlannerRun("## Plan\nx", { verdict: "duplicate", duplicate_of: 458 });
      mockGh.commentOnIssue.mockImplementation(async (_r: string, num: number) => {
        if (num === 458) throw new Error("gh failed");
      });

      await expect(processIssue(repo, current)).resolves.not.toThrow();
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith("test-org/test-repo", 459, expect.stringContaining("#458"), expect.any(Object));
    });
  });

  describe("processIssue — repository transfer", () => {
    afterEach(() => {
      delete process.env["CLAWS_PLANNER_TRANSFER"];
    });

    it("transfers the issue when the planner names an allowed destination", async () => {
      const issue = mockIssue({ number: 2215, labels: [{ name: "Ready" }] });
      mockGh.listRepos.mockResolvedValue([
        { owner: "test-org", name: "test-repo", fullName: "test-org/test-repo", defaultBranch: "main" },
        { owner: "test-org", name: "other-repo", fullName: "test-org/other-repo", defaultBranch: "main" },
      ]);
      mockPlannerRun("Belongs elsewhere.", { verdict: "transfer", transfer_to: "test-org/other-repo" });

      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("`outcome: \"transfer\"`, `transfer_to`");
      expect(mockGh.transferIssue).toHaveBeenCalledWith(repo.fullName, issue.number, "test-org/other-repo");
      const commentCall = mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => c[1] === issue.number);
      expect(commentCall).toBeDefined();
      const body = commentCall![2] as string;
      expect(body).not.toContain("## Implementation Plan");
      expect(body).toContain(TRANSFER_HEADER);
      expect(body).toContain(TRANSFERRED_FROM_MARKER);
      expect(body).toContain("Belongs elsewhere.");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockSlackNotify).not.toHaveBeenCalled();
    });

    it("neutralises a literal plan header inside the rationale", async () => {
      const issue = mockIssue({ number: 2215 });
      mockGh.listRepos.mockResolvedValue([
        { owner: "test-org", name: "other-repo", fullName: "test-org/other-repo", defaultBranch: "main" },
      ]);
      mockPlannerRun("This is entirely about other-repo, see its own ## Implementation Plan section.", { verdict: "transfer", transfer_to: "test-org/other-repo" });

      await processIssue(repo, issue);

      const commentCall = mockGh.commentOnIssue.mock.calls.find((c: unknown[]) => c[1] === issue.number);
      const body = commentCall![2] as string;
      expect(body).not.toContain("## Implementation Plan");
      expect(body).toContain("Implementation plan");
    });

    it("suppresses routing when a prior comment was stamped by a transfer INTO the current repo", async () => {
      const issue = mockIssue({ number: 2215 });
      mockGh.listRepos.mockResolvedValue([
        { owner: "test-org", name: "other-repo", fullName: "test-org/other-repo", defaultBranch: "main" },
      ]);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: `CLAWS_TRANSFERRED_FROM: other-org/other#3`, body_html: "", login: "claws-bot" },
      ]);

      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).not.toContain("## Repository Routing");
      expect(prompt).not.toContain("`transfer`, with `transfer_to`");
      expect(plannerRunsWritten()[0]!.offers).toEqual([]);
      expect(mockGh.transferIssue).not.toHaveBeenCalled();
    });

    it("does not suppress routing when the stamp names the CURRENT repo (failed-transfer retry)", async () => {
      const issue = mockIssue({ number: 2215 });
      mockGh.listRepos.mockResolvedValue([
        { owner: "test-org", name: "other-repo", fullName: "test-org/other-repo", defaultBranch: "main" },
      ]);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: `CLAWS_TRANSFERRED_FROM: ${repo.fullName}#2215`, body_html: "", login: "claws-bot" },
      ]);

      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("## Repository Routing");
      expect(prompt).toContain("`transfer`, with `transfer_to`");
      expect(plannerRunsWritten()[0]!.offers).toEqual(["transfer"]);
    });

    it("falls back to a failure comment and Claws Ignore when the transfer call rejects", async () => {
      const issue = mockIssue({ number: 2215 });
      mockGh.listRepos.mockResolvedValue([
        { owner: "test-org", name: "other-repo", fullName: "test-org/other-repo", defaultBranch: "main" },
      ]);
      mockPlannerRun("Belongs elsewhere.", { verdict: "transfer", transfer_to: "test-org/other-repo" });
      mockGh.transferIssue.mockRejectedValue(new Error("transfer failed"));

      await expect(processIssue(repo, issue)).resolves.not.toThrow();

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Claws Ignore");
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        expect.stringContaining("please move this issue manually"),
        expect.any(Object),
      );
    });

    it("omits the routing section entirely when CLAWS_PLANNER_TRANSFER=false", async () => {
      process.env["CLAWS_PLANNER_TRANSFER"] = "false";
      const issue = mockIssue({ number: 2215 });
      mockGh.listRepos.mockResolvedValue([
        { owner: "test-org", name: "other-repo", fullName: "test-org/other-repo", defaultBranch: "main" },
      ]);

      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).not.toContain("## Repository Routing");
      // The kill switch must reach the tool docs and the run's offers too, or the
      // model would be asked for a non-plan paragraph pointing at an absent section.
      expect(prompt).not.toContain("`transfer`, with `transfer_to`");
      expect(plannerRunsWritten()[0]!.offers).toEqual([]);
      expect(mockGh.transferIssue).not.toHaveBeenCalled();
    });
  });

  describe("planner prompt does not include prod-data context", () => {
    it("buildNewPlanPrompt via processIssue — excludes kubectl/HA, keeps runner policy", async () => {
      const issue = mockIssue({ body: "Add a new feature" });
      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).not.toMatch(/kubectl/i);
      expect(prompt).not.toMatch(/Home Assistant/i);
      expect(prompt).toContain("self-hosted runners");
    });

    it("writeAgentMcpConfig called with includeHomeAssistant: false", async () => {
      const issue = mockIssue({ body: "Some issue" });
      await processIssue(repo, issue);

      expect(mockClaude.writeAgentMcpConfig).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ includeHomeAssistant: false, fileSuffix: "plan" }),
      );
    });

    it("processRefinement — writeAgentMcpConfig called with includeHomeAssistant: false", async () => {
      const issue = mockIssue({ body: "Some issue" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      expect(mockClaude.writeAgentMcpConfig).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ includeHomeAssistant: false, fileSuffix: "refine" }),
      );
    });

    it("processFollowUp — writeAgentMcpConfig called with includeHomeAssistant: false", async () => {
      const issue = mockIssue({ body: "Some issue" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Is everything healthy again?", body_html: "", login: "stjohnb" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockClaude.runClaude.mockResolvedValue("Yes, everything looks healthy now.");

      await processFollowUp(repo, issue, [openPhasePR(5)], [humanComment]);

      expect(mockClaude.writeAgentMcpConfig).toHaveBeenCalledWith(
        expect.any(String),
        { includeHomeAssistant: false },
      );
    });

    it("buildNewPlanPrompt via processIssue — prompt includes external URL fetch instruction", async () => {
      const issue = mockIssue({ body: "Add a new feature" });
      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("use the WebFetch tool to retrieve their");
      expect(prompt).toContain("Use the WebSearch tool when you need to research");
      expect(prompt).toContain("gh run view");
      expect(prompt).toContain("ONE diagnosed root cause");
    });

    it("buildRefinementPrompt via processRefinement — prompt includes external URL fetch instruction", async () => {
      const issue = mockIssue({ body: "Fix a bug" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Please also handle edge case X", body_html: "", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

      await processRefinement(repo, issue, [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("use the WebFetch tool to retrieve their");
      expect(prompt).toContain("Use the WebSearch tool when you need to research");
      expect(prompt).toContain("gh run view");
      expect(prompt).toContain("ONE diagnosed root cause");
    });

    it("buildFollowUpPrompt via processFollowUp — prompt includes external URL fetch instruction", async () => {
      const issue = mockIssue({ body: "Fix a bug" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Is everything healthy again?", body_html: "", login: "stjohnb" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockClaude.runClaude.mockResolvedValue("Yes, everything looks healthy now.");
      mockGh.getPRBody.mockResolvedValueOnce("This PR fixes the widget.");
      mockGh.getPRChangedFiles.mockResolvedValueOnce(["src/widget.ts", "src/widget.test.ts"]);

      await processFollowUp(repo, issue, [openPhasePR(5, { title: "Fix the widget" })], [humanComment]);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("use the WebFetch tool to retrieve their");
      expect(prompt).toContain("Use the WebSearch tool when you need to research");
      expect(prompt).toContain("gh run view");
      expect(prompt).toContain("ONE diagnosed root cause");
      expect(prompt).toContain("Title: Fix the widget");
      expect(prompt).toContain("This PR fixes the widget.");
      expect(prompt).toContain("- src/widget.ts");
      expect(prompt).toContain("- src/widget.test.ts");
    });

    it("summarises every open step PR, each read from its own repo", async () => {
      const issue = mockIssue({ body: "Multi-repo work" });
      const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan", body_html: "", login: "claws-bot" };
      const humanComment = { id: 502, body: "Rename the flag in the API PR", body_html: "", login: "stjohnb" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockClaude.runClaude.mockResolvedValue("Noted.");
      mockGh.getPRBody.mockImplementation(async (r: string, n: number) => `body of ${r}#${n}`);
      mockGh.getPRChangedFiles.mockImplementation(async (r: string) => [r === "test-org/other-repo" ? "api/flag.ts" : "docs/flag.md"]);

      await processFollowUp(repo, issue, [
        openPhasePR(5, { title: "Docs for the flag", phase: 1 }),
        openPhasePR(9, { repo: "test-org/other-repo", title: "API for the flag", phase: 2 }),
      ], [humanComment]);

      expect(mockGh.getPRBody).toHaveBeenCalledWith("test-org/other-repo", 9);
      expect(mockGh.getPRChangedFiles).toHaveBeenCalledWith("test-org/test-repo", 5);
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("2 PRs implementing its steps are open: #5, test-org/other-repo#9");
      expect(prompt).toContain("Here is what PR test-org/other-repo#9 (plan step 2) actually contains:");
      expect(prompt).toContain("body of test-org/other-repo#9");
      expect(prompt).toContain("- api/flag.ts");
      expect(prompt).toContain("- docs/flag.md");
      expect(prompt).toContain("say which of those PRs each change applies to");
    });
  });
});

describe("findUnreactedFeedbackAfterPlan — hasEscalationReview", () => {
  const CLAWS = "*— Automated by Claws —*";
  const plan = { id: 1, body: `${CLAWS}\n\n${PLAN_HEADER}\n\nDo stuff`, body_html: "", login: "claws-bot" };
  const review = { id: 2, body: `${CLAWS}\n\n${ESCALATION_REVIEW_HEADER}\n\nESCALATION_VERDICT: hold`, body_html: "", login: "claws-bot" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.getCommentReactions.mockResolvedValue([]);
  });

  // Guards the literal used by escalation-reviewer.test.ts's issue-refiner mock.
  it("uses the expected header literal", () => {
    expect(ESCALATION_REVIEW_HEADER).toBe("## Escalation Review");
  });

  it("is false when no plan exists", async () => {
    mockGh.getIssueComments.mockResolvedValue([]);
    const result = await findUnreactedFeedbackAfterPlan("o/r", 1, "claws-bot");
    expect(result.hasEscalationReview).toBe(false);
  });

  it("is false when a plan exists but no review follows it", async () => {
    mockGh.getIssueComments.mockResolvedValue([plan]);
    const result = await findUnreactedFeedbackAfterPlan("o/r", 1, "claws-bot");
    expect(result).toMatchObject({ hasPlan: true, hasEscalationReview: false });
  });

  it("is true when a Claws review comment follows the plan", async () => {
    mockGh.getIssueComments.mockResolvedValue([plan, review]);
    const result = await findUnreactedFeedbackAfterPlan("o/r", 1, "claws-bot");
    expect(result.hasEscalationReview).toBe(true);
  });

  it("is false when the review precedes a newer plan — a re-plan invalidates it", async () => {
    mockGh.getIssueComments.mockResolvedValue([plan, review, { ...plan, id: 3 }]);
    const result = await findUnreactedFeedbackAfterPlan("o/r", 1, "claws-bot");
    expect(result.hasEscalationReview).toBe(false);
  });

  it("ignores a non-Claws comment quoting the review header", async () => {
    const human = { id: 4, body: `${ESCALATION_REVIEW_HEADER} — why did this hold?`, body_html: "", login: "stjohnb" };
    mockGh.getIssueComments.mockResolvedValue([plan, human]);
    const result = await findUnreactedFeedbackAfterPlan("o/r", 1, "claws-bot");
    expect(result.hasEscalationReview).toBe(false);
  });
});

describe("parsePlannedOccurrences", () => {
  it("returns the number from a plan body containing the marker", () => {
    expect(parsePlannedOccurrences(`## Implementation Plan\n\nDo stuff\n\n*Models used: opus*\n\n${PLAN_OCCURRENCES_MARKER} 3`)).toBe(3);
  });

  it("returns null when marker is absent", () => {
    expect(parsePlannedOccurrences("## Implementation Plan\n\nDo stuff\n\n*Models used: opus*")).toBeNull();
  });

  it("returns 1 for marker with value 1", () => {
    expect(parsePlannedOccurrences(`body\n\n${PLAN_OCCURRENCES_MARKER} 1`)).toBe(1);
  });
});

describe("occurrence marker in posted plan comments", () => {
  const OCCURRENCE_BODY = `Some alert body.\n\n---\n**First seen:** 2024-01-01T00:00:00.000Z\n**Last seen:** 2024-01-02T00:00:00.000Z\n**Occurrences:** 4`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaude.withNewWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockImplementation(async () => "## Plan\nDo the thing\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`");
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockGh.addReaction.mockResolvedValue(undefined);
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockGh.editIssueComment.mockResolvedValue(undefined);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.isItemSkipped.mockReturnValue(false);
  });

  const repo = { fullName: "test-org/test-repo", owner: "test-org", name: "test-repo", defaultBranch: "main", worktreeBase: "/tmp" };

  it("processIssue — appends CLAWS_PLAN_OCCURRENCES marker when issue body has tracking", async () => {
    const issue = { number: 1, title: "Alert", body: OCCURRENCE_BODY, labels: [], author: { login: "bot" }, state: "open", html_url: "" };

    await processIssue(repo, issue);

    const body = mockGh.commentOnIssue.mock.calls[0][2] as string;
    expect(body).toContain(`${PLAN_OCCURRENCES_MARKER} 4`);
  });

  it("processIssue — omits marker when issue body has no occurrence tracking", async () => {
    const issue = { number: 1, title: "Bug", body: "Just a plain description.", labels: [], author: { login: "human" }, state: "open", html_url: "" };

    await processIssue(repo, issue);

    const body = mockGh.commentOnIssue.mock.calls[0][2] as string;
    expect(body).not.toContain(PLAN_OCCURRENCES_MARKER);
  });

  it("processRefinement (edit path) — stamps updated marker with current occurrence count", async () => {
    const issue = { number: 2, title: "Alert recurrence", body: OCCURRENCE_BODY, labels: [], author: { login: "bot" }, state: "open", html_url: "" };
    const planComment = { id: 501, body: `*— Automated by Claws —*\n\n## Implementation Plan\n\nOld plan\n\n*Models used: opus (provider: claude)*\n\n${PLAN_OCCURRENCES_MARKER} 1`, body_html: "", login: "claws-bot" };
    const humanComment = { id: 502, body: "Please re-evaluate", body_html: "", login: "reviewer" };
    mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);

    await processRefinement(repo, issue, [humanComment]);

    const body = mockGh.editIssueComment.mock.calls[0][2] as string;
    expect(body).toContain(`${PLAN_OCCURRENCES_MARKER} 4`);
  });

  it("processRefinement (fresh-plan fallback) — stamps marker when no existing plan comment", async () => {
    const issue = { number: 3, title: "Alert recurrence", body: OCCURRENCE_BODY, labels: [], author: { login: "bot" }, state: "open", html_url: "" };
    // No plan comment returned — processRefinement takes the lastPlanIdx === -1 branch
    mockGh.getIssueComments.mockResolvedValue([]);

    await processRefinement(repo, issue, []);

    const body = mockGh.commentOnIssue.mock.calls[0][2] as string;
    expect(body).toContain(`${PLAN_OCCURRENCES_MARKER} 4`);
  });

  describe("parseStepBackVerdict", () => {
    it("parses sound", () => {
      expect(parseStepBackVerdict("STEP_BACK_VERDICT: sound")).toBe("sound");
    });

    it("parses reconsider with a following critique", () => {
      expect(parseStepBackVerdict("STEP_BACK_VERDICT: reconsider\n\nThe plan works around the symptom.")).toBe("reconsider");
    });

    it("is case-insensitive", () => {
      expect(parseStepBackVerdict("step_back_verdict: Reconsider")).toBe("reconsider");
    });

    it("returns null when the marker is absent", () => {
      expect(parseStepBackVerdict("Looks fine to me.")).toBeNull();
    });

    it("returns null when the text merely mentions the words", () => {
      expect(parseStepBackVerdict("We should reconsider whether this plan is sound.")).toBeNull();
    });
  });

  describe("splitStepBackOutput", () => {
    it("returns a null plan when the revised-plan marker is absent", () => {
      const { critique, revisedPlan } = splitStepBackOutput("STEP_BACK_VERDICT: reconsider\n\nThis works around the symptom.");
      expect(critique).toBe("This works around the symptom.");
      expect(revisedPlan).toBeNull();
    });

    it("splits critique and plan, stripping the verdict line", () => {
      const out = `STEP_BACK_VERDICT: reconsider\n\nThe root cause is elsewhere.\n\n${STEP_BACK_REVISED_MARKER}\n\nRevised plan body`;
      const { critique, revisedPlan } = splitStepBackOutput(out);
      expect(critique).toBe("The root cause is elsewhere.");
      expect(critique).not.toContain("STEP_BACK_VERDICT");
      expect(revisedPlan).toBe("Revised plan body");
    });
  });

  describe("processIssue — step back", () => {
    const longPlan = "x".repeat(2000);

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("uses the same Claws-owned grants for planning and step-back", async () => {
      const repo = mockRepo({ owner: "St-John-Software", name: "production-infra", fullName: "St-John-Software/production-infra" });
      mockClaude.runClaude.mockResolvedValueOnce(longPlan).mockResolvedValueOnce("STEP_BACK_VERDICT: sound");
      await processIssue(repo, mockIssue());
      expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
      for (const call of mockClaude.runClaude.mock.calls) {
        expect(call[2]).toEqual(expect.objectContaining({ plannerCapabilities: ["prod-infra"] }));
      }
    });

    it("posts the revised plan and a separate critique comment on reconsider", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude
        .mockResolvedValueOnce(longPlan)
        .mockResolvedValueOnce(`STEP_BACK_VERDICT: reconsider\n\nThe plan works around the symptom.\n\n${STEP_BACK_REVISED_MARKER}\n\nRevised plan body`);

      await processIssue(repo, issue);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(2);
      const planBody = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(planBody).toContain(PLAN_HEADER);
      expect(planBody).toContain("Revised plan body");
      expect(planBody).not.toContain("xxxx");
      const critiqueBody = mockGh.commentOnIssue.mock.calls[1][2] as string;
      expect(critiqueBody).toContain(STEP_BACK_HEADER);
      expect(critiqueBody).toContain("The plan works around the symptom.");
      expect(critiqueBody).not.toContain(PLAN_HEADER);
    });

    it("tells the step-back replacement plan to read the product docs first and cite the requirement served", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude
        .mockResolvedValueOnce(longPlan)
        .mockResolvedValueOnce(`STEP_BACK_VERDICT: reconsider\n\nThe plan works around the symptom.\n\n${STEP_BACK_REVISED_MARKER}\n\nRevised plan body`);

      await processIssue(repo, issue);

      const stepBackPrompt = mockClaude.runClaude.mock.calls[1][0] as string;
      expect(stepBackPrompt).toContain("If `docs/PRODUCT.md` exists, read it first");
      expect(stepBackPrompt).toContain("`docs/product/<area>.md#<heading>`");
      // The text-marker fallback the pass still parses is named in the prompt.
      expect(stepBackPrompt).toContain("STEP_BACK_VERDICT: reconsider");
      expect(stepBackPrompt).toContain(STEP_BACK_REVISED_MARKER);
    });

    it("keeps the original plan and posts nothing extra on sound", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude
        .mockResolvedValueOnce(longPlan)
        .mockResolvedValueOnce("STEP_BACK_VERDICT: sound");

      await processIssue(repo, issue);

      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
      expect(mockGh.commentOnIssue.mock.calls[0][2]).toContain(longPlan);
    });

    it("carries the approved requirements record into the step-back prompt, without a Requirement heading", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });
      mockClaude.runClaude
        .mockResolvedValueOnce(longPlan)
        .mockResolvedValueOnce("STEP_BACK_VERDICT: sound");

      await processIssue(repo, issue);

      const stepBackPrompt = mockClaude.runClaude.mock.calls[1][0] as string;
      expect(stepBackPrompt).toContain("## Approved requirements (v2");
      expect(stepBackPrompt).not.toContain("### Requirement");
    });

    it("keeps planner attribution when step-back critiques without a revised plan", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude.mockImplementation(async (_prompt: string, _cwd: string, opts: { onProviderUsed?: (provider: string) => void; onAttemptModelUsed?: (provider: string, model: string | undefined) => void }) => {
        if (mockClaude.runClaude.mock.calls.length === 1) {
          opts.onProviderUsed?.("claude");
          opts.onAttemptModelUsed?.("claude", "planner-model");
          return longPlan;
        }
        opts.onProviderUsed?.("codex");
        opts.onAttemptModelUsed?.("codex", "step-back-model");
        return "STEP_BACK_VERDICT: reconsider\n\nThis needs another look.";
      });

      await processIssue(repo, issue);

      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(2);
      const planBody = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(planBody).toContain(longPlan);
      expect(planBody).toContain("*Models used: planner-model (provider: claude)*");
      expect(planBody).not.toContain("step-back-model");
    });

    it("does not run the step-back pass when CLAWS_PLANNER_STEP_BACK=false", async () => {
      vi.stubEnv("CLAWS_PLANNER_STEP_BACK", "false");
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude.mockResolvedValueOnce(longPlan);

      await processIssue(repo, issue);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
      expect(mockGh.commentOnIssue.mock.calls[0][2]).toContain(longPlan);
    });

    it("keeps the original plan when the step-back call throws", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockClaude.runClaude
        .mockResolvedValueOnce(longPlan)
        .mockRejectedValueOnce(new Error("step-back boom"));

      await expect(processIssue(repo, issue)).resolves.not.toThrow();

      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
      expect(mockGh.commentOnIssue.mock.calls[0][2]).toContain(longPlan);
    });

    it("threads the codex-routed Plan: Deep provider into the step-back call, not a hardcoded claude pin", async () => {
      mockProviderSelection.value = { provider: "codex", strictProvider: true, eligibleProviders: [{ provider: "codex", weight: 2 }] };
      const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Plan: Deep" }] });
      mockClaude.runClaude
        .mockResolvedValueOnce(longPlan)
        .mockResolvedValueOnce("STEP_BACK_VERDICT: sound");

      await processIssue(repo, issue);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
      expect(mockClaude.runClaude).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ provider: "codex", strictProvider: true, deepThinking: true }),
      );
    });
  });

  describe("processIssue — step back gates auto-Refine (#3091)", () => {
    const longPlan = "x".repeat(2000);
    const autoRefineIssue = () => mockIssue({ body: "Test issue body", labels: [{ name: "Claws Auto-Refine" }] });

    beforeEach(() => {
      // This describe lives inside "occurrence marker in posted plan comments",
      // whose beforeEach doesn't reset listMergedPRsForIssue — an earlier test
      // elsewhere in the file leaves it stubbed with a non-empty result.
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("sound → auto-applies Refined and stamps no reconsider marker", async () => {
      mockClaude.runClaude
        .mockResolvedValueOnce(longPlan)
        .mockResolvedValueOnce("STEP_BACK_VERDICT: sound");

      await processIssue(repo, autoRefineIssue());

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
      const planBody = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(planBody).not.toContain(STEP_BACK_RECONSIDER_MARKER);
    });

    it("reconsider without a revised plan → withholds Refined, stamps the marker, and posts a withheld note", async () => {
      mockClaude.runClaude
        .mockResolvedValueOnce(longPlan)
        .mockResolvedValueOnce("STEP_BACK_VERDICT: reconsider\n\nThis needs another look.");

      await processIssue(repo, autoRefineIssue());

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 1, "Refined");
      const planBody = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(planBody).toContain(STEP_BACK_RECONSIDER_MARKER);
      const critiqueBody = mockGh.commentOnIssue.mock.calls[1][2] as string;
      expect(critiqueBody).toContain(STEP_BACK_HEADER);
      expect(critiqueBody).toContain("This needs another look.");
      expect(critiqueBody.toLowerCase()).toContain("refined");
    });

    it("reconsider with a revised plan → also withholds Refined; the revised plan carries the marker", async () => {
      mockClaude.runClaude
        .mockResolvedValueOnce(longPlan)
        .mockResolvedValueOnce(`STEP_BACK_VERDICT: reconsider\n\nThe plan works around the symptom.\n\n${STEP_BACK_REVISED_MARKER}\n\nRevised plan body`);

      await processIssue(repo, autoRefineIssue());

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 1, "Refined");
      const planBody = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(planBody).toContain("Revised plan body");
      expect(planBody).toContain(STEP_BACK_RECONSIDER_MARKER);
    });

    it("reconsider with an empty critique still posts a Step Back comment with fallback text", async () => {
      mockClaude.runClaude
        .mockResolvedValueOnce(longPlan)
        .mockResolvedValueOnce(`STEP_BACK_VERDICT: reconsider\n\n${STEP_BACK_REVISED_MARKER}\n\nRevised plan body`);

      await processIssue(repo, autoRefineIssue());

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 1, "Refined");
      const critiqueBody = mockGh.commentOnIssue.mock.calls[1][2] as string;
      expect(critiqueBody).toContain(STEP_BACK_HEADER);
      expect(critiqueBody).toContain("The step-back pass flagged this plan for reconsideration but gave no critique.");
    });

    it("CLAWS_PLANNER_STEP_BACK=false → Refined still auto-applied", async () => {
      vi.stubEnv("CLAWS_PLANNER_STEP_BACK", "false");
      mockClaude.runClaude.mockResolvedValueOnce(longPlan);

      await processIssue(repo, autoRefineIssue());

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("a plan too short for step-back to run → Refined still auto-applied", async () => {
      mockClaude.runClaude.mockResolvedValueOnce("## Plan\nShort plan\n\n**Recommended implementation model:** `sonnet`\n**Recommended review model:** `sonnet`");

      await processIssue(repo, autoRefineIssue());

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });
  });

  describe("hasStepBackReconsiderMarker (#3091)", () => {
    it("is true for a trailing block that has it alongside the hash/last-comment markers", () => {
      const stamped = `## Implementation Plan\n\nplan text${planMarkersFor({ title: "T", body: "B" }, 7, { stepBackReconsider: true })}`;
      expect(hasStepBackReconsiderMarker(stamped)).toBe(true);
    });

    it("is false when the marker appears only in the plan's prose", () => {
      const body = `## Implementation Plan\n\nThe plan stamps ${STEP_BACK_RECONSIDER_MARKER} at the end.\n\n${PLAN_BODY_HASH_MARKER} ${"a".repeat(64)}`;
      expect(hasStepBackReconsiderMarker(body)).toBe(false);
    });

    it("stripPlanMarkers removes it", () => {
      const stamped = `## Implementation Plan\n\nplan text${planMarkersFor({ title: "T", body: "B" }, 7, { stepBackReconsider: true })}`;
      expect(stripPlanMarkers(stamped)).toBe("## Implementation Plan\n\nplan text");
    });

    it("planMarkersFor without the option omits it", () => {
      expect(planMarkersFor({ title: "T", body: "B" }, 7)).not.toContain(STEP_BACK_RECONSIDER_MARKER);
    });
  });

  describe("stale-plan markers (#2524)", () => {
    const OCC_BLOCK = "\n\n---\n**First seen:** 2026-08-01T00:00:00Z\n**Last seen:** 2026-08-02T00:00:00Z\n**Occurrences:** 3";

    // Verbatim layout emitted by the fleet-infra/production-infra alert bridge (#3334).
    const BRIDGE_BODY = [
      "Alerts for `OWNER/REPO` are consolidated into this issue, one section per alertname.",
      "",
      "## Currently firing",
      "",
      "- Node Memory Available Low (warning)",
      "",
      "## Alerts",
      "",
      "### Node Memory Available Low",
      "",
      "| Field | Value |",
      "|-------|-------|",
      "| Severity | warning |",
      "| Status | firing |",
      "| First occurrence | 2026-09-23T09:55:00Z |",
      "| Last occurrence | 2026-09-23T10:00:00Z |",
      "| Occurrences | 3 |",
      "| Resolved | - |",
      "| Source | https://grafana.example/alert/1 |",
      "",
      "**Summary:** Node memory available is critically low.",
      "",
      "**Description:** Node worker-3 has 4.2% memory available.",
      "",
      "*Automatically managed by grafana-github-alerts. Closed when every alert above is resolved; reopened if an alert re-fires within 24 hours.*",
      "",
      "---",
      "**First seen:** 2026-09-23T10:00:00Z",
      "**Last seen:** 2026-09-23T10:00:00Z",
      "**Occurrences:** 3",
    ].join("\n");

    // Same alert, one firing/resolve delivery later: every volatile part changed, no section added/removed.
    const BRIDGE_BODY_VOLATILE_CHANGED = [
      "Alerts for `OWNER/REPO` are consolidated into this issue, one section per alertname.",
      "",
      "## Currently firing",
      "",
      "- none",
      "",
      "## Alerts",
      "",
      "### Node Memory Available Low",
      "",
      "| Field | Value |",
      "|-------|-------|",
      "| Severity | warning |",
      "| Status | resolved |",
      "| First occurrence | 2026-09-23T09:55:00Z |",
      "| Last occurrence | 2026-09-23T11:00:00Z |",
      "| Occurrences | 4 |",
      "| Resolved | 2026-09-23T11:05:00Z |",
      "| Source | https://grafana.example/alert/1 |",
      "",
      "**Summary:** Node memory available has recovered.",
      "",
      "**Description:** Node worker-3 has 4.2% memory available.",
      "",
      "*Automatically managed by grafana-github-alerts. Closed when every alert above is resolved; reopened if an alert re-fires within 24 hours.*",
      "",
      "---",
      "**First seen:** 2026-09-23T10:00:00Z",
      "**Last seen:** 2026-09-23T11:05:00Z",
      "**Occurrences:** 4",
    ].join("\n");

    // A second alertname section appears alongside the first.
    const BRIDGE_BODY_NEW_SECTION = [
      "Alerts for `OWNER/REPO` are consolidated into this issue, one section per alertname.",
      "",
      "## Currently firing",
      "",
      "- Node Memory Available Low (warning)",
      "- Disk Space Low (critical)",
      "",
      "## Alerts",
      "",
      "### Node Memory Available Low",
      "",
      "| Field | Value |",
      "|-------|-------|",
      "| Severity | warning |",
      "| Status | firing |",
      "| First occurrence | 2026-09-23T09:55:00Z |",
      "| Last occurrence | 2026-09-23T10:00:00Z |",
      "| Occurrences | 3 |",
      "| Resolved | - |",
      "| Source | https://grafana.example/alert/1 |",
      "",
      "**Summary:** Node memory available is critically low.",
      "",
      "**Description:** Node worker-3 has 4.2% memory available.",
      "",
      "### Disk Space Low",
      "",
      "| Field | Value |",
      "|-------|-------|",
      "| Severity | critical |",
      "| Status | firing |",
      "| First occurrence | 2026-09-23T10:30:00Z |",
      "| Last occurrence | 2026-09-23T10:30:00Z |",
      "| Occurrences | 1 |",
      "| Resolved | - |",
      "",
      "**Summary:** Disk space is critically low.",
      "",
      "**Description:** Volume /data is 96% full.",
      "",
      "*Automatically managed by grafana-github-alerts. Closed when every alert above is resolved; reopened if an alert re-fires within 24 hours.*",
      "",
      "---",
      "**First seen:** 2026-09-23T10:00:00Z",
      "**Last seen:** 2026-09-23T11:05:00Z",
      "**Occurrences:** 4",
    ].join("\n");

    // A human edits the intro line — not a volatile part, must count as a real edit.
    const BRIDGE_BODY_INTRO_EDIT = BRIDGE_BODY.replace(
      "Alerts for `OWNER/REPO` are consolidated into this issue, one section per alertname.",
      "Alerts for `OWNER/REPO` are consolidated into this issue, one section per alertname.\nHuman note: escalate to on-call after 3 occurrences.",
    );

    it("issueContentHash ignores the occurrence block", () => {
      expect(issueContentHash("T", "Body" + OCC_BLOCK)).toBe(issueContentHash("T", "Body"));
    });

    it("issueContentHash ignores CRLF and trailing-whitespace-only differences", () => {
      expect(issueContentHash("T", "line one\r\nline two   \r\n")).toBe(issueContentHash("T", "line one\nline two"));
    });

    it("issueContentHash changes on a real body edit and on a title edit", () => {
      const base = issueContentHash("T", "skip finder-cap");
      expect(issueContentHash("T", "finder-cap — no change")).not.toBe(base);
      expect(issueContentHash("Other title", "skip finder-cap")).not.toBe(base);
    });

    it("parsePlanBodyHash returns the LAST match so quoted prose cannot win", () => {
      const quoted = "a".repeat(64);
      const real = "b".repeat(64);
      const body = `The plan stamps CLAWS_PLAN_BODY_HASH: ${quoted} at the end.\n\nCLAWS_PLAN_BODY_HASH: ${real}`;
      expect(parsePlanBodyHash(body)).toBe(real);
    });

    it("parsePlanBodyHash and parsePlanLastCommentId return null when unstamped", () => {
      expect(parsePlanBodyHash("## Implementation Plan\n\nno markers")).toBeNull();
      expect(parsePlanLastCommentId("## Implementation Plan\n\nno markers")).toBeNull();
    });

    it("parsePlanLastCommentId returns the last match", () => {
      expect(parsePlanLastCommentId("CLAWS_PLAN_LAST_COMMENT: 1\nCLAWS_PLAN_LAST_COMMENT: 502")).toBe(502);
    });

    it("isPlanStaleForIssue is false for a legacy plan with no marker", () => {
      expect(isPlanStaleForIssue("## Implementation Plan\n\nold plan", "T", "totally different body")).toBe(false);
    });

    it("isPlanStaleForIssue is false for a Claws-maintained alert issue even when the hash differs", () => {
      // ensureAlertIssue rewrites these bodies every monitor tick — hash staleness
      // must never fire for them or ~11 monitors re-plan on every dispatcher tick.
      const plan = `${PLAN_BODY_HASH_MARKER} ${issueContentHash("T", "old live df output")}`;
      expect(isPlanStaleForIssue(plan, "T", "new live df output" + OCC_BLOCK)).toBe(false);
    });

    it("isPlanStaleForIssue is true on a genuine edit and false when unchanged", () => {
      const plan = `${PLAN_BODY_HASH_MARKER} ${issueContentHash("T", "skip finder-cap")}`;
      expect(isPlanStaleForIssue(plan, "T", "finder-cap — no change")).toBe(true);
      expect(isPlanStaleForIssue(plan, "T", "skip finder-cap")).toBe(false);
    });

    it("planMarkersFor stamps the hash, the comment fence and any occurrence count", () => {
      const markers = planMarkersFor({ title: "T", body: "Body" + OCC_BLOCK }, 502);
      expect(markers).toContain(`${PLAN_OCCURRENCES_MARKER} 3`);
      expect(markers).toContain(`${PLAN_BODY_HASH_MARKER} ${issueContentHash("T", "Body")}`);
      expect(markers).toContain(`${PLAN_LAST_COMMENT_MARKER} 502`);
    });

    it("issueContentHash with no approved record is unchanged from the title+body hash", () => {
      const legacy = createHash("sha256").update("T\n\nBody").digest("hex");
      expect(issueContentHash("T", "Body")).toBe(legacy);
      expect(issueContentHash("T", "Body", null)).toBe(legacy);
      expect(issueContentHash("T", "Body", undefined)).toBe(legacy);
    });

    it("issueContentHash covers the approved record's content", () => {
      const base = issueContentHash("T", "Body", approvedRecord());
      expect(base).not.toBe(issueContentHash("T", "Body"));
      expect(issueContentHash("T", "Body", approvedRecord())).toBe(base);
      expect(issueContentHash("T", "Body", approvedRecord({ requirement: "Changed." }))).not.toBe(base);
      expect(issueContentHash("T", "Body", approvedRecord({ acceptanceCriteria: ["Only one"] }))).not.toBe(base);
      expect(issueContentHash("T", "Body", approvedRecord({ version: 3 }))).not.toBe(base);
    });

    it("isPlanStaleForIssue is true when the approved record changes and the body does not", () => {
      const plan = `${PLAN_BODY_HASH_MARKER} ${issueContentHash("T", "Body", approvedRecord())}`;
      expect(isPlanStaleForIssue(plan, "T", "Body", approvedRecord())).toBe(false);
      expect(isPlanStaleForIssue(plan, "T", "Body", approvedRecord({ version: 3, requirement: "Re-approved." }))).toBe(true);
      // A body-only stamp is stale once the issue has an approved record.
      const bodyOnly = `${PLAN_BODY_HASH_MARKER} ${issueContentHash("T", "Body")}`;
      expect(isPlanStaleForIssue(bodyOnly, "T", "Body")).toBe(false);
      expect(isPlanStaleForIssue(bodyOnly, "T", "Body", approvedRecord())).toBe(true);
    });

    it("planMarkersFor stamps the hash of the approved record when given one", () => {
      const record = approvedRecord();
      expect(planMarkersFor({ title: "T", body: "Body", requirements: record }, 1))
        .toContain(`${PLAN_BODY_HASH_MARKER} ${issueContentHash("T", "Body", record)}`);
    });

    it("planMarkersFor stamps fence 0 when the run saw no comments (#2623)", () => {
      expect(planMarkersFor({ title: "T", body: "Body" }, 0)).toContain(`${PLAN_LAST_COMMENT_MARKER} 0`);
    });

    it("stripPlanMarkers removes a prior marker block so re-stamping does not duplicate it", () => {
      const stamped = `## Implementation Plan\n\nplan text${planMarkersFor({ title: "T", body: "B" + OCC_BLOCK }, 7)}`;
      const stripped = stripPlanMarkers(stamped);
      expect(stripped).toBe("## Implementation Plan\n\nplan text");
      expect(`${stripped}${planMarkersFor({ title: "T", body: "B" }, 8)}`).not.toContain("CLAWS_PLAN_LAST_COMMENT: 7");
    });

    it("stripPlanMarkers only strips the trailing block, not marker-shaped text quoted in plan prose", () => {
      const hashA = "a".repeat(64);
      const hashB = "b".repeat(64);
      const stamped = `## Implementation Plan\n\nThe plan stamps ${PLAN_BODY_HASH_MARKER} ${hashA} at the end.\n\n${PLAN_BODY_HASH_MARKER} ${hashB}`;
      expect(stripPlanMarkers(stamped)).toBe(
        `## Implementation Plan\n\nThe plan stamps ${PLAN_BODY_HASH_MARKER} ${hashA} at the end.`,
      );
    });

    describe("consolidated alert-bridge bodies (#3334)", () => {
      it("isConsolidatedAlertBody is true for the bridge fixture and false otherwise", () => {
        expect(isConsolidatedAlertBody(BRIDGE_BODY)).toBe(true);
        expect(isConsolidatedAlertBody("Body" + OCC_BLOCK)).toBe(false);
        expect(isConsolidatedAlertBody("just a plain issue body with no headings")).toBe(false);
      });

      it("issueContentHash is unchanged when only volatile parts change", () => {
        expect(issueContentHash("T", BRIDGE_BODY)).toBe(issueContentHash("T", BRIDGE_BODY_VOLATILE_CHANGED));
      });

      it("issueContentHash changes when a new alertname section is added", () => {
        expect(issueContentHash("T", BRIDGE_BODY)).not.toBe(issueContentHash("T", BRIDGE_BODY_NEW_SECTION));
      });

      it("issueContentHash changes when a human edits the intro", () => {
        expect(issueContentHash("T", BRIDGE_BODY)).not.toBe(issueContentHash("T", BRIDGE_BODY_INTRO_EDIT));
      });

      it("isPlanStaleForIssue is false for a routine firing/resolve and true for a new section", () => {
        const plan = `${PLAN_BODY_HASH_MARKER} ${issueContentHash("T", BRIDGE_BODY)}`;
        expect(isPlanStaleForIssue(plan, "T", BRIDGE_BODY_VOLATILE_CHANGED)).toBe(false);
        expect(isPlanStaleForIssue(plan, "T", BRIDGE_BODY_NEW_SECTION)).toBe(true);
      });

      it("a non-bridge body with a Status row still hashes differently when that row changes", () => {
        const before = "A plain issue.\n\n| Field | Value |\n|-------|-------|\n| Status | open |";
        const after = "A plain issue.\n\n| Field | Value |\n|-------|-------|\n| Status | closed |";
        expect(issueContentHash("T", before)).not.toBe(issueContentHash("T", after));
      });
    });
  });

  describe("selectFeedbackCandidates (#2524)", () => {
    const plan = (fence: number | null) => ({
      id: 500,
      body: `*— Automated by Claws —*\n\n## Implementation Plan\n\nplan${fence === null ? "" : `\n\n${PLAN_LAST_COMMENT_MARKER} ${fence}`}`,
      body_html: "",
      login: "claws-bot",
    });
    const comment = (id: number) => ({ id, body: `c${id}`, body_html: "", login: "reviewer" });

    it("includes a mid-flight comment that sits BEFORE the plan comment in thread order", () => {
      // The classic #2524 shape: the run stamped fence 100, comment 150 was posted
      // while the planner ran, so GitHub orders it before the plan comment (id 500).
      const comments = [comment(100), comment(150), plan(100)];
      expect(selectFeedbackCandidates(comments, 2).map((c) => c.id)).toEqual([150]);
    });

    it("still includes comments after the plan comment", () => {
      const comments = [comment(100), plan(100), comment(600)];
      expect(selectFeedbackCandidates(comments, 1).map((c) => c.id)).toEqual([600]);
    });

    it("never includes the plan comment itself", () => {
      const comments = [comment(100), plan(100)];
      expect(selectFeedbackCandidates(comments, 1).map((c) => c.id)).toEqual([]);
    });

    it("falls back to after-the-plan-only for a legacy plan with no fence", () => {
      const comments = [comment(100), comment(150), plan(null), comment(600)];
      expect(selectFeedbackCandidates(comments, 2).map((c) => c.id)).toEqual([600]);
    });

    it("fence 0 admits a comment posted before the plan comment (#2623)", () => {
      // Brand-new issue: the run snapshotted zero comments, so every comment on the
      // issue arrived after the snapshot even though GitHub orders 150 before the plan.
      const comments = [comment(150), plan(0), comment(600)];
      expect(selectFeedbackCandidates(comments, 1).map((c) => c.id)).toEqual([150, 600]);
    });
  });

  describe("processIssue — plan stamping (#2524)", () => {
    it("stamps the plan with the hash of the LIVE body, not the cached snapshot", async () => {
      // The dispatcher's issue list is 60 s cached; stamping that copy would leave
      // the hash permanently lagging and re-plan on every tick.
      const issue = mockIssue({ body: "stale cached body" });
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "live edited body" });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: "a human comment", body_html: "", login: "reviewer" },
      ]);

      await processIssue(repo, issue);

      const posted = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(posted).toContain(`${PLAN_BODY_HASH_MARKER} ${issueContentHash(issue.title, "live edited body")}`);
      expect(posted).not.toContain(issueContentHash(issue.title, "stale cached body"));
      expect(posted).toContain(`${PLAN_LAST_COMMENT_MARKER} 42`);
    });

    it("stamps fence 0 when the issue had no comments at snapshot time (#2623)", async () => {
      // Default mock: getIssueComments -> []. Without the stamp, a comment posted
      // while the planner ran is never seen as feedback (home-assistant-config#416).
      await processIssue(repo, mockIssue({}));
      const posted = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(posted).toContain(`${PLAN_LAST_COMMENT_MARKER} 0`);
    });

    it("plans against the live body, so a mid-run edit is what the model sees", async () => {
      const issue = mockIssue({ body: "stale cached body" });
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "live edited body" });

      await processIssue(repo, issue);

      expect(mockClaude.runClaude.mock.calls[0][0] as string).toContain("live edited body");
    });

    it("falls back to the snapshot when the live read fails", async () => {
      const issue = mockIssue({ body: "snapshot body" });
      mockGh.getIssueTitleBody.mockRejectedValue(new Error("gh down"));

      await processIssue(repo, issue);

      expect(mockGh.commentOnIssue.mock.calls[0][2] as string)
        .toContain(`${PLAN_BODY_HASH_MARKER} ${issueContentHash(issue.title, "snapshot body")}`);
    });
  });

  describe("processRefinement — plan re-stamping (#2524)", () => {
    const planComment = { id: 501, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOriginal plan here", body_html: "", login: "claws-bot" };
    const humanComment = { id: 502, body: "Please skip the finder-cap", body_html: "", login: "reviewer" };

    it("re-stamps markers on the edited plan comment", async () => {
      const issue = mockIssue({ body: "cached body" });
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "edited body" });

      await processRefinement(repo, issue, [humanComment]);

      const edited = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect(edited).toContain(`${PLAN_BODY_HASH_MARKER} ${issueContentHash(issue.title, "edited body")}`);
      expect(edited).toContain(`${PLAN_LAST_COMMENT_MARKER} 502`);
    });

    it("re-stamps even when the model returns nothing, so the dispatcher does not loop", async () => {
      const issue = mockIssue({ body: "cached body" });
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "edited body" });
      mockClaude.runClaude.mockResolvedValue("   ");

      await processRefinement(repo, issue, [humanComment]);

      const edited = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect(edited).toContain("Original plan here");
      expect(edited).toContain(`${PLAN_BODY_HASH_MARKER} ${issueContentHash(issue.title, "edited body")}`);
      // editIssueComment re-prepends the Claws header, so the body handed to it
      // must not still carry the old one.
      expect(edited).not.toContain("Automated by Claws");
    });

    it("does not duplicate markers when re-stamping an already-stamped plan", async () => {
      const issue = mockIssue({ body: "cached body" });
      const stamped = {
        ...planComment,
        body: `${planComment.body}\n\n${PLAN_BODY_HASH_MARKER} ${"a".repeat(64)}\n${PLAN_LAST_COMMENT_MARKER} 1`,
      };
      mockGh.getIssueComments.mockResolvedValue([stamped, humanComment]);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "edited body" });
      mockClaude.runClaude.mockResolvedValue("");

      await processRefinement(repo, issue, [humanComment]);

      const edited = mockGh.editIssueComment.mock.calls[0][2] as string;
      expect(edited.match(new RegExp(PLAN_BODY_HASH_MARKER, "g"))).toHaveLength(1);
      expect(edited.match(new RegExp(PLAN_LAST_COMMENT_MARKER, "g"))).toHaveLength(1);
      expect(edited).not.toContain("a".repeat(64));
    });

    it("stamps the fresh plan when no plan comment is found", async () => {
      const issue = mockIssue({ body: "cached body" });
      mockGh.getIssueComments.mockResolvedValue([humanComment]);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "edited body" });

      await processRefinement(repo, issue, [humanComment]);

      expect(mockGh.commentOnIssue.mock.calls[0][2] as string)
        .toContain(`${PLAN_BODY_HASH_MARKER} ${issueContentHash(issue.title, "edited body")}`);
    });
  });

});
