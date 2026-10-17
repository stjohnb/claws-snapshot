// A follow-up amendment end to end on a native issue: the real native store
// and database, with only Claude, the worktree and the forge-side PR reads
// mocked. issue-refiner.test.ts covers the same flow against a mocked façade;
// this pins that the in-place edit lands as a second plan version.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
  DASHBOARD_URL: "https://claws.example.invalid",
  WORK_DIR: "/tmp/claws-refiner-amendment-test",
  LABELS: { refined: "Refined", ready: "Ready", duplicate: "Duplicate", blocked: "Blocked", planDeep: "Plan: Deep" },
  SELF_REPO: "org/a",
  HOME_ASSISTANT_BASE_URL: "",
  HOME_ASSISTANT_TOKEN: "",
  HOME_ASSISTANT_CONFIG_REPO: "",
  isForgejoRepo: () => false,
  hasForgejoRepoForOwner: () => false,
  forgejoRepoUrl: (fullName: string) => `https://forgejo.test/${fullName}`,
  issueUrl: (repo: string, n: unknown) => `https://github.com/${repo}/issues/${String(n)}`,
  isAgentDisabled: () => false,
  getAutoPromotePolicy: () => ({}),
}));

vi.mock("../log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("../model-selector.js", () => ({
  getModel: (tier: string = "sonnet") => tier,
  normalizeTier: (raw: string) => (["fable", "opus", "sonnet", "haiku"].includes(raw.trim().toLowerCase()) ? raw.trim().toLowerCase() : null),
  getDeepModel: () => "fable",
  getReviewModel: (tier: string = "sonnet") => tier,
  getProviderSelectionForItem: () => ({ provider: "claude", strictProvider: false, eligibleProviders: [{ provider: "claude", weight: 4 }] }),
  getProviderOverride: () => undefined,
}));

vi.mock("../model-plan.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../model-plan.js")>(),
  resolveModelPlanCell: vi.fn(async (_repo: string, _ref: unknown, _phase: string, fallback: { tier?: string } = {}) => ({
    provider: "claude", strictProvider: false, eligibleProviders: [{ provider: "claude", weight: 4 }],
    tier: fallback.tier ?? "sonnet", model: fallback.tier ?? "sonnet", source: "default", tierSource: "default", providerSource: "default",
  })),
  setSuggestedPlan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../timeout-handler.js", () => ({ getItemTimeoutMs: () => undefined, handleTimeoutIfApplicable: vi.fn() }));
vi.mock("../images.js", () => ({ processTextForImages: vi.fn().mockResolvedValue("") }));
vi.mock("../reapproval.js", () => ({ startReapproval: vi.fn(), isReapprovalPending: vi.fn(async () => false) }));
vi.mock("../issue-previews.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../issue-previews.js")>(),
  findIssuePreview: vi.fn().mockResolvedValue(null),
  syncPreviewsForIssue: vi.fn().mockResolvedValue(undefined),
}));

const mockRunClaude = vi.hoisted(() => vi.fn());
vi.mock("../claude.js", () => ({
  withNewWorktree: async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"),
  runClaude: mockRunClaude,
  randomSuffix: () => "ab12",
  writeAgentMcpConfig: (_wt: string, o?: { plannerRun?: { id: string } }) => `/tmp/mcp-${o?.plannerRun?.id ?? "none"}.json`,
  readRepoAgentDoc: () => undefined,
  tierFallbackNote: (from: string) => `; fell back from ${from}`,
}));

// The façade, reduced to the native path the follow-up uses: comments, edits
// and reactions land in the real native store, carrying the Claws marker
// `github.ts` would add. The open PR's own reads stay off the forge.
vi.mock("../github.js", async () => {
  const claws = await import("../claws-issues.js");
  const markers = await import("../marker-text.js");
  const mark = (body: string, agentName?: string) => `*— Automated by Claws · ${agentName ?? "Claws"} —*\n\n${body}`;
  return {
    isClawsComment: markers.isClawsComment,
    stripClawsMarker: markers.stripClawsMarker,
    getIssueComments: async (_repo: string, ref: string) => await claws.getIssueComments(ref),
    getSelfLoginForIssue: async () => claws.CLAWS_NATIVE_LOGIN,
    getIssueTitleBody: async (_repo: string, ref: string) => await claws.getIssueTitleBody(ref),
    commentOnIssue: async (repo: string, ref: string, body: string, opts?: { agentName?: string }) => {
      await claws.commentOnIssue(repo, ref, mark(body, opts?.agentName), claws.CLAWS_NATIVE_LOGIN);
    },
    editIssueComment: async (_repo: string, commentId: string, body: string, opts?: { agentName?: string }) => {
      await claws.editIssueComment(commentId, mark(body, opts?.agentName));
    },
    addReaction: async (_repo: string, commentId: string, reaction: string) => {
      await claws.addReaction(commentId, claws.CLAWS_NATIVE_LOGIN, reaction);
    },
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    listRepos: async () => [],
    isRepoListDegraded: () => false,
    getPRBody: async () => "Implements step 1.",
    getPRChangedFiles: async () => ["src/x.ts"],
  };
});

import { initDb, closeDb, replaceIssuePlannedPRs, getIssuePlannedPRs } from "../db.js";
import * as claws from "../claws-issues.js";
import * as gh from "../github.js";
import { submitPlan, submitFollowupVerdict } from "../planner-runs.js";
import { processFollowUp } from "./issue-refiner.js";
import { mockRepo } from "../test-helpers.js";

const REPO = "org/a";
const repo = mockRepo({ owner: "org", name: "a", fullName: REPO });

function runIdOf(opts?: { mcpConfig?: string }): string {
  return opts?.mcpConfig?.match(/mcp-([0-9a-f-]{36})\.json$/)?.[1] ?? "";
}

beforeEach(async () => {
  await initDb();
  vi.clearAllMocks();
});

afterEach(async () => {
  await closeDb();
});

describe("follow-up plan amendment on a native issue", () => {
  it("edits the plan in place as a new version, keeps the PR list and posts the footer", async () => {
    const id = await claws.createIssue({ title: "Lockfile check", body: "Check the lockfile.", authorLogin: "stjohnb", repos: [REPO] });
    const planCommentId = await claws.commentOnIssue(REPO, id, "*— Automated by Claws · Planner —*\n\n## Implementation Plan\n\n### Implementation\nGrep the lockfile.\n\n*Models used: opus (provider: claude)*", claws.CLAWS_NATIVE_LOGIN);
    await replaceIssuePlannedPRs(id, [{ repo: REPO, title: "Lockfile check", dependsOn: null, kind: "pr", manualAction: null }]);
    const feedbackId = await claws.commentOnIssue(REPO, id, "Parse the lockfile instead of grepping it.", "stjohnb");
    const feedback = (await claws.getIssueComments(id)).find((c) => c.id === feedbackId)!;
    expect(await claws.listPlans(id)).toHaveLength(1);

    mockRunClaude.mockImplementation(async (_prompt: string, _cwd: string, opts?: { mcpConfig?: string }) => {
      const runId = runIdOf(opts);
      expect(submitPlan(runId, {
        plan: "### Implementation\nParse the lockfile with the JSON reader.",
        prs: [{ repo: REPO, title: "Lockfile check" }],
        implementation_model: "sonnet",
        review_model: "opus",
      })).toEqual({ ok: true });
      expect(submitFollowupVerdict(runId, { verdict: "plan_amendment", affected_prs: [{ repo: REPO, number: 5 }] })).toEqual({ ok: true });
      return "Switched step 1 to parsing the lockfile.";
    });

    const issue = { number: id, title: "Lockfile check", body: "Check the lockfile.", labels: [], author: { login: "stjohnb" } } as unknown as Parameters<typeof processFollowUp>[1];
    await processFollowUp(repo, issue, [{ repo: REPO, number: 5, title: "Lockfile check (1/1)", phase: 1 }], [feedback]);

    const plans = await claws.listPlans(id);
    expect(plans.map((p) => p.version)).toEqual([1, 2]);
    expect(plans[0]!.body).toContain("Grep the lockfile.");
    expect(plans[1]!.body).toContain("Parse the lockfile with the JSON reader.");
    expect(plans[1]!.commentId).toBe(planCommentId);

    expect((await getIssuePlannedPRs(id)).map((e) => [e.position, e.repo, e.kind])).toEqual([[1, REPO, "pr"]]);
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();

    const reply = (await claws.getIssueComments(id)).at(-1)!;
    expect(reply.body).toContain("Switched step 1 to parsing the lockfile.");
    expect(reply.body).toContain("Plan amended in place. Open PRs that must change to match: #5");
  });
});
