import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockIssue, mockPR } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    inReview: "In Review",
    duplicate: "Duplicate",
    useCodex: "Use Codex",
    useClaude: "Use Claude",
    manualAction: "Manual Action",
    automerge: "Automerge",
  },
  HOME_ASSISTANT_BASE_URL: "",
  HOME_ASSISTANT_TOKEN: "",
  HOME_ASSISTANT_CONFIG_REPO: "",
  PROVIDER_FALLBACK_ORDER: ["claude"],
}));
vi.mock("../model-selector.js", () => ({ getModel: (tier?: string, provider?: string) => {
  if (provider === "codex") return "gpt-5.4";
  return tier ?? "opus";
}, getProviderSelectionForItem: () => ({ provider: "claude", strictProvider: false }) }));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../timeout-handler.js", () => ({
  handleTimeoutIfApplicable: vi.fn().mockResolvedValue(undefined),
  getItemTimeoutMs: vi.fn().mockReturnValue(undefined),
}));

const { mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockGh: {
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    createPR: vi.fn(),
    updatePR: vi.fn(),
    getPRBody: vi.fn(),
    getIssueComments: vi.fn(),
    listMergedPRsForIssue: vi.fn(),
    getOpenPRForIssue: vi.fn(),
    editIssueComment: vi.fn(),
    commentOnIssue: vi.fn(),
    isClawsComment: (body: string) => /\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/.test(body) || body.includes("<!-- claws-automated -->"),
    stripClawsMarker: (body: string) => body.replace("<!-- claws-automated -->", "").replace("*— Automated by Claws —*", "").trim(),
    isItemPrioritized: vi.fn().mockReturnValue(false),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    populateQueueCache: vi.fn(),
    getPRDiff: vi.fn(),
    getSelfLogin: vi.fn().mockResolvedValue("claws-bot"),
    getSelfLoginForRepo: vi.fn().mockResolvedValue("claws-bot"),
    getIssueBodyHtml: vi.fn().mockResolvedValue(""),
    getIssueTitleBody: vi.fn(),
    listDuplicateIssuesOf: vi.fn().mockResolvedValue([]),
    listPRsCrossReferencingIssue: vi.fn().mockResolvedValue([]),
    isAllowedActor: vi.fn().mockResolvedValue(true),
    getCommentReactions: vi.fn().mockResolvedValue([]),
    listPRs: vi.fn().mockResolvedValue([]),
    isForkPR: (pr: { isCrossRepository?: boolean }) => pr.isCrossRepository === true,
  },
  mockClaude: {
    withNewWorktree: vi.fn(),
    withExistingWorktree: vi.fn(),
    getHeadSha: vi.fn(),
    enqueue: vi.fn(),
    runClaude: vi.fn(),
    hasNewCommits: vi.fn(),
    pushBranch: vi.fn(),
    generatePRDescription: vi.fn(),
    regeneratePRDescription: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
    writeClawsMcpConfig: vi.fn().mockReturnValue("/tmp/mock-mcp-config.json"),
    writeAgentMcpConfig: vi.fn().mockReturnValue("/tmp/mock-mcp-config.json"),
    readRepoAgentDoc: vi.fn().mockReturnValue(undefined),
    getCommitCount: vi.fn().mockResolvedValue(1),
    getDiffStats: vi.fn().mockResolvedValue({ filesChanged: 1, insertions: 10, deletions: 5 }),
    getCommitCountSince: vi.fn().mockResolvedValue(1),
    getDiffStatsSince: vi.fn().mockResolvedValue({ filesChanged: 1, insertions: 10, deletions: 5 }),
    diagnoseNoCommits: vi.fn().mockResolvedValue(null),
    diagnoseNoCommitsSince: vi.fn().mockResolvedValue(null),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    updateTaskModel: vi.fn(),
    updateTaskProvider: vi.fn(),
    updateTaskTokenUsage: vi.fn(),
    trackTaskTokens: vi.fn().mockReturnValue(vi.fn()),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
    countRecentNoCommitCompletions: vi.fn().mockReturnValue(0),
    hasActiveWorkForPR: vi.fn().mockReturnValue(false),
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

const mockProcessTextForImages = vi.hoisted(() => vi.fn().mockResolvedValue(""));
vi.mock("../images.js", () => ({
  processTextForImages: mockProcessTextForImages,
}));

vi.mock("../plan-parser.js", async () => {
  const actual = await vi.importActual("../plan-parser.js");
  return actual;
});

// Partially mocked: the stale-plan gate is exactly the agreement between the real
// issueContentHash/isPlanStaleForIssue and the marker the planner stamps (#2524).
vi.mock("./issue-refiner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./issue-refiner.js")>()),
  PLAN_HEADER: "## Implementation Plan",
}));

import { processIssue, checkAndContinue, extractManualActionMarker, extractManualActionSection, extractPostMergeActionSection, extractTitleMarker, isVerificationOnlyAction, regenerateAndUpdatePRBody, STALE_PLAN_MARKER } from "./issue-worker.js";
import { issueContentHash, PLAN_BODY_HASH_MARKER } from "./issue-refiner.js";
import * as log from "../log.js";

describe("issue-worker", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaude.withNewWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
    mockClaude.withExistingWorktree.mockImplementation(async (_r: unknown, _b: unknown, _n: unknown, fn: (p: string) => Promise<unknown>) => fn("/tmp/worktree"));
    mockClaude.getHeadSha.mockReset();
    mockClaude.getHeadSha.mockResolvedValueOnce("sha-before").mockResolvedValue("sha-after");
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.getPRBody.mockResolvedValue("Existing PR body");
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runClaude.mockResolvedValue("implemented");
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockClaude.generatePRDescription.mockResolvedValue("## Summary\nFixed it");
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.createPR.mockResolvedValue(100);
    mockGh.updatePR.mockResolvedValue(undefined);
    mockGh.getIssueComments.mockResolvedValue([] as { id: number; body: string; body_html: string; login: string }[]);
    // Default: the live read fails, so callers fall back to the issue snapshot the
    // test passed in — no test sees a spurious hash mismatch (#2524).
    mockGh.getIssueTitleBody.mockRejectedValue(new Error("no live read in tests"));
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);
    mockGh.getOpenPRForIssue.mockResolvedValue(null);
    mockGh.editIssueComment.mockResolvedValue(undefined);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockGh.getPRDiff.mockResolvedValue("diff --git a/file.ts b/file.ts\n+some changes");
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockDb.countRecentNoCommitCompletions.mockReturnValue(0);
  });

  describe("extractManualActionMarker", () => {
    it("extracts a marker at the end of the description", () => {
      const result = extractManualActionMarker("## Summary\nFixed it\n\nMANUAL-ACTION: set the FOO_SECRET env var in prod");

      expect(result.manualAction).toBe("set the FOO_SECRET env var in prod");
      expect(result.body).toBe("## Summary\nFixed it");
      expect(result.timing).toBe("before");
    });

    it("extracts a marker placed before an attribution footer", () => {
      const description = "## Summary\nFixed it\nMANUAL-ACTION: set FOO\n\n---\n*attribution*";

      const result = extractManualActionMarker(description);

      expect(result.manualAction).toBe("set FOO");
      expect(result.body).toBe("## Summary\nFixed it\n\n---\n*attribution*");
    });

    it("returns null manualAction when no marker is present", () => {
      const description = "## Summary\nFixed it";

      const result = extractManualActionMarker(description);

      expect(result).toEqual({ body: description, manualAction: null, timing: "before" });
    });

    it("captures a lowercase/whitespace marker variant", () => {
      const result = extractManualActionMarker("## Summary\nFixed it\n\n  manual-action:  do X  ");

      expect(result.manualAction).toBe("do X");
      expect(result.body).toBe("## Summary\nFixed it");
    });

    it("marks a MANUAL-ACTION-AFTER-MERGE marker as after timing", () => {
      const result = extractManualActionMarker("## Summary\nFixed it\n\nMANUAL-ACTION-AFTER-MERGE: publish the DS record");

      expect(result.manualAction).toBe("publish the DS record");
      expect(result.timing).toBe("after");
    });

    it("marks a MANUAL-ACTION-BEFORE-MERGE marker as before timing", () => {
      const result = extractManualActionMarker("## Summary\nFixed it\n\nMANUAL-ACTION-BEFORE-MERGE: rotate the prod secret");

      expect(result.manualAction).toBe("rotate the prod secret");
      expect(result.timing).toBe("before");
    });

    it("drops a verification-only AFTER-MERGE note but still strips the marker line", () => {
      const result = extractManualActionMarker(
        "## Summary\nFixed it\n\nMANUAL-ACTION-AFTER-MERGE: Verify the new Gatus check and Grafana alert rules fire/clear correctly against the live authentik-worker deployment after Flux reconciles.",
      );

      expect(result.manualAction).toBeNull();
      expect(result.body).toBe("## Summary\nFixed it");
    });

    it("drops a monitoring-only note", () => {
      const result = extractManualActionMarker("## Summary\nFixed it\n\nMANUAL-ACTION-AFTER-MERGE: Monitor the dashboard for errors");

      expect(result.manualAction).toBeNull();
    });

    it("drops a verification-only BEFORE-MERGE note", () => {
      const result = extractManualActionMarker("## Summary\nFixed it\n\nMANUAL-ACTION-BEFORE-MERGE: Confirm the probe responds");

      expect(result.manualAction).toBeNull();
    });

    it("keeps a verification-opener note that carries a real follow-on action", () => {
      const result = extractManualActionMarker(
        "## Summary\nFixed it\n\nMANUAL-ACTION-AFTER-MERGE: Verify the deploy succeeded, then rotate the prod token",
      );

      expect(result.manualAction).toBe("Verify the deploy succeeded, then rotate the prod token");
    });
  });

  describe("isVerificationOnlyAction", () => {
    it("flags pure verification/observation notes", () => {
      expect(isVerificationOnlyAction("verify the alert fires")).toBe(true);
      expect(isVerificationOnlyAction("Please confirm the migration applied")).toBe(true);
      expect(isVerificationOnlyAction("keep an eye on error rates")).toBe(true);
    });

    it("does not flag notes with a real state-changing action", () => {
      expect(isVerificationOnlyAction("set the FOO_SECRET env var in prod")).toBe(false);
      expect(isVerificationOnlyAction("publish the DS record at the registrar")).toBe(false);
      expect(isVerificationOnlyAction("Ensure the secret is set in prod")).toBe(false);
    });
  });

  describe("extractTitleMarker", () => {
    it("extracts a subject at the start of the description and strips the line from body", () => {
      const result = extractTitleMarker("TITLE: add zod runtime validation to apiFetch\n\n## Summary\nFixed it");

      expect(result.title).toBe("add zod runtime validation to apiFetch");
      expect(result.body).toBe("## Summary\nFixed it");
    });

    it("returns null title when no marker is present", () => {
      const description = "## Summary\nFixed it";

      const result = extractTitleMarker(description);

      expect(result).toEqual({ body: description, title: null });
    });

    it("captures a lowercase/whitespace marker variant", () => {
      const result = extractTitleMarker("  title:  do X  \n\n## Summary\nFixed it");

      expect(result.title).toBe("do X");
      expect(result.body).toBe("## Summary\nFixed it");
    });

    it("strips a leading conventional-commit prefix from the captured subject", () => {
      const result = extractTitleMarker("TITLE: fix: add validation\n\n## Summary\nFixed it");

      expect(result.title).toBe("add validation");
      expect(result.body).toBe("## Summary\nFixed it");
    });
  });

  describe("extractManualActionSection", () => {
    it("extracts the section at the end of a PR body", () => {
      const body = "## Summary\nFixed it\n\nCloses #10\n\n## ⚠️ Manual action required before merge\n\nSet the FOO_SECRET env var in prod";

      const result = extractManualActionSection(body);

      expect(result).toBe("## ⚠️ Manual action required before merge\n\nSet the FOO_SECRET env var in prod");
    });

    it("stops before a trailing review-model line", () => {
      const body = "## Summary\nFixed it\n\n## ⚠️ Manual action required before merge\n\nSet FOO\n\nreview-model: opus";

      const result = extractManualActionSection(body);

      expect(result).toBe("## ⚠️ Manual action required before merge\n\nSet FOO");
    });

    it("returns null when no section is present", () => {
      const body = "## Summary\nFixed it\n\nCloses #10";

      expect(extractManualActionSection(body)).toBeNull();
    });

    it("returns only the pre-merge section when a post-merge section follows it", () => {
      const body = "## Summary\nFixed it\n\n## ⚠️ Manual action required before merge\n\nSet FOO\n\n## 📋 Manual action required after merge\n\nPublish the DS record";

      const result = extractManualActionSection(body);

      expect(result).toBe("## ⚠️ Manual action required before merge\n\nSet FOO");
    });
  });

  describe("extractPostMergeActionSection", () => {
    it("extracts the section at the end of a PR body", () => {
      const body = "## Summary\nFixed it\n\nCloses #10\n\n## 📋 Manual action required after merge\n\nPublish the DS record";

      const result = extractPostMergeActionSection(body);

      expect(result).toBe("## 📋 Manual action required after merge\n\nPublish the DS record");
    });

    it("stops before a trailing review-model line", () => {
      const body = "## Summary\nFixed it\n\n## 📋 Manual action required after merge\n\nPublish the DS record\n\nreview-model: opus";

      const result = extractPostMergeActionSection(body);

      expect(result).toBe("## 📋 Manual action required after merge\n\nPublish the DS record");
    });

    it("returns null when no section is present", () => {
      const body = "## Summary\nFixed it\n\nCloses #10";

      expect(extractPostMergeActionSection(body)).toBeNull();
    });

    it("returns null when only the pre-merge heading is present", () => {
      const body = "## Summary\nFixed it\n\n## ⚠️ Manual action required before merge\n\nSet FOO";

      expect(extractPostMergeActionSection(body)).toBeNull();
    });
  });

  describe("single-PR flow", () => {
    it("happy path — creates worktree, runs claude, pushes, creates PR", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockClaude.generatePRDescription.mockResolvedValue(
        "TITLE: add zod runtime validation to apiFetch\n\n## Summary\nFixed it",
      );

      await processIssue(repo, issue);

      expect(mockClaude.withNewWorktree).toHaveBeenCalled();
      expect(mockClaude.pushBranch).toHaveBeenCalled();
      expect(mockClaude.generatePRDescription).toHaveBeenCalled();
      expect(mockGh.createPR).toHaveBeenCalledWith(
        repo.fullName,
        expect.stringContaining("claws/issue-1"),
        expect.stringContaining("add zod runtime validation"),
        expect.stringContaining("Closes #1"),
      );
      const prBody = mockGh.createPR.mock.calls[0][3] as string;
      expect(prBody).not.toContain("TITLE:");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "In Review");
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 1, filesChanged: 1, insertions: 10, deletions: 5, prNumber: 100, prAction: "created" });
    });

    it("no commits — logs warning, no PR created, no In Review label, posts explanation comment", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockClaude.hasNewCommits.mockResolvedValue(false);

      await processIssue(repo, issue);

      expect(mockClaude.pushBranch).not.toHaveBeenCalled();
      expect(mockGh.createPR).not.toHaveBeenCalled();
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 1, "In Review");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 0 });
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.stringContaining("No changes produced"),
        { agentName: "Implementer" },
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.stringContaining("re-add the `Refined` label"),
        { agentName: "Implementer" },
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.not.stringContaining("**Diagnosis:**"),
        { agentName: "Implementer" },
      );
    });

    it("no commits — includes diagnosis in comment when diagnoseNoCommits returns a string", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockClaude.hasNewCommits.mockResolvedValue(false);
      mockClaude.diagnoseNoCommits.mockResolvedValue("Claude could not find the relevant file.");

      await processIssue(repo, issue);

      expect(mockClaude.diagnoseNoCommits).toHaveBeenCalledWith(
        expect.any(String), // wtPath
        repo.defaultBranch,
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.stringContaining("**Diagnosis:** Claude could not find the relevant file."),
        { agentName: "Implementer" },
      );
    });

    it("no commits — dedup: skips comment if no-commit marker already exists", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockClaude.hasNewCommits.mockResolvedValue(false);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "## No changes produced\n\nno-commit:1", login: "claws-bot" },
      ]);

      await processIssue(repo, issue);

      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockClaude.diagnoseNoCommits).not.toHaveBeenCalled();
    });

    it("error handling — records failed task and throws", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockClaude.runClaude.mockRejectedValue(new Error("claude error"));

      await expect(processIssue(repo, issue)).rejects.toThrow("claude error");

      expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude error"), expect.any(Object));
      expect(mockClaude.withNewWorktree).toHaveBeenCalled();
    });

    it("label management — removes Ready at start and Refined on success", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });

      await processIssue(repo, issue);

      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("prompt instructs Claude not to create PRs", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });

      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Do NOT create a pull request");
    });

    it("calls updatePR after createPR to ensure correct title and body", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });

      await processIssue(repo, issue);

      expect(mockGh.updatePR).toHaveBeenCalledWith(
        repo.fullName,
        100,
        expect.stringContaining("Closes #1"),
        expect.stringContaining("#1"),
      );
    });

    it("strips closing keywords from generated description", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockClaude.generatePRDescription.mockResolvedValue(
        "## Summary\nFixed the bug.\n\nCloses #1\n\n## Changes\n- Fixed stuff",
      );

      await processIssue(repo, issue);

      const prBody = mockGh.createPR.mock.calls[0][3] as string;
      // Should have exactly one "Closes #1" — the one buildPRBody appends, not from the description
      const closesCount = (prBody.match(/Closes #1/g) || []).length;
      expect(closesCount).toBe(1);
    });

    it("strips 'Fixes' and 'Resolves' keywords from generated description", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockClaude.generatePRDescription.mockResolvedValue(
        "## Summary\nResolved the issue.\n\nFixes #1\nResolves #1\n\n## Changes\n- Fixed stuff",
      );

      await processIssue(repo, issue);

      const prBody = mockGh.createPR.mock.calls[0][3] as string;
      expect(prBody).not.toMatch(/Fixes #1/i);
      expect(prBody).not.toMatch(/Resolves #1/i);
      expect(prBody).toContain("Closes #1");
    });

    it("strips past-tense closing keywords (closed, fixed, resolved)", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockClaude.generatePRDescription.mockResolvedValue(
        "## Summary\nDone.\n\nClosed #1\nFixed #1\nResolved #1\n\n## Changes\n- Stuff",
      );

      await processIssue(repo, issue);

      const prBody = mockGh.createPR.mock.calls[0][3] as string;
      expect(prBody).not.toMatch(/Closed #1/i);
      expect(prBody).not.toMatch(/Fixed #1/i);
      expect(prBody).not.toMatch(/Resolved #1/i);
      expect(prBody).toContain("Closes #1");
    });

    it("strips closing keywords with PR count suffix", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockClaude.generatePRDescription.mockResolvedValue(
        "## Summary\nDone.\n\nCloses #1 (PR 1 of 2)\n\n## Changes\n- Stuff",
      );

      await processIssue(repo, issue);

      const prBody = mockGh.createPR.mock.calls[0][3] as string;
      expect(prBody).not.toContain("PR 1 of 2");
      expect(prBody).toContain("Closes #1");
    });

    it("appends manual action note to PR body and applies the label", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockClaude.generatePRDescription.mockResolvedValue(
        "## Summary\nFixed the bug.\n\nMANUAL-ACTION-BEFORE-MERGE: set the FOO_SECRET env var in prod",
      );

      await processIssue(repo, issue);

      const prBody = mockGh.createPR.mock.calls[0][3] as string;
      expect(prBody).toContain("Manual action required before merge");
      expect(prBody).toContain("set the FOO_SECRET env var in prod");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 100, "Manual Action");
    });

    it("appends a post-merge note without applying the blocking label", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockClaude.generatePRDescription.mockResolvedValue(
        "## Summary\nFixed the bug.\n\nMANUAL-ACTION-AFTER-MERGE: publish the DS record at the registrar",
      );

      await processIssue(repo, issue);

      const prBody = mockGh.createPR.mock.calls[0][3] as string;
      expect(prBody).toContain("Manual action required after merge");
      expect(prBody).toContain("publish the DS record at the registrar");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 100, "Manual Action");
    });

    it("does not apply the manual action label when no marker is present", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockClaude.generatePRDescription.mockResolvedValue("## Summary\nFixed the bug.");

      await processIssue(repo, issue);

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 100, "Manual Action");
    });

    it("propagates Use Codex from the issue to the PR", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }, { name: "Use Codex" }] });

      await processIssue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 100, "Use Codex");
    });

    it("propagates Use Claude from the issue to the PR", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }, { name: "Use Claude" }] });

      await processIssue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 100, "Use Claude");
    });

    it("propagates both provider labels to preserve downstream conflict semantics", async () => {
      const issue = mockIssue({
        labels: [{ name: "Refined" }, { name: "Use Codex" }, { name: "Use Claude" }],
      });

      await processIssue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 100, "Use Codex");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 100, "Use Claude");
    });

    it("does not apply provider labels to the PR when the issue has neither override", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });

      await processIssue(repo, issue);

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 100, "Use Codex");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 100, "Use Claude");
    });

    it("strips closing keywords from the manual action note before it reaches the PR body", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockClaude.generatePRDescription.mockResolvedValue(
        "## Summary\nFixed the bug.\n\nMANUAL-ACTION: also fixes #123 by rotating the key",
      );

      await processIssue(repo, issue);

      const prBody = mockGh.createPR.mock.calls[0][3] as string;
      expect(prBody).not.toMatch(/fixes #123/i);
      expect(prBody).toContain("rotating the key");
    });

    it("uses recommended model from plan comment", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      const planWithModel = "*— Automated by Claws —*\n\n## Implementation Plan\n\nDo the thing.\n\n**Recommended implementation model:** `sonnet`";
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: planWithModel, login: "claws-bot" }]);

      await processIssue(repo, issue);

      const options = mockClaude.runClaude.mock.calls[0][2];
      expect(options.model).toBe("sonnet");
    });

    it("defaults to sonnet when plan has no model recommendation", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      const planNoModel = "*— Automated by Claws —*\n\n## Implementation Plan\n\nDo the thing.";
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: planNoModel, login: "claws-bot" }]);

      await processIssue(repo, issue);

      const options = mockClaude.runClaude.mock.calls[0][2];
      expect(options.model).toBe("sonnet");
    });

    it("uses config primary provider (PROVIDER_FALLBACK_ORDER[0])", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      const plan = "*— Automated by Claws —*\n\n## Implementation Plan\n\nDo the thing.\n\n**Recommended implementation model:** `opus`";
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: plan, login: "claws-bot" }]);

      await processIssue(repo, issue);

      const options = mockClaude.runClaude.mock.calls[0][2];
      expect(options.provider).toBe("claude");
      expect(options.model).toBe("opus");
    });

    it("appends review-model marker when plan recommends a review model", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      const planWithReviewModel = "*— Automated by Claws —*\n\n## Implementation Plan\n\nDo the thing.\n\n**Recommended review model:** `opus`";
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: planWithReviewModel, login: "claws-bot" }]);

      await processIssue(repo, issue);

      const prBody = mockGh.createPR.mock.calls[0][3] as string;
      expect(prBody).toContain("review-model: opus");
    });

    it("omits review-model marker when plan has no review model recommendation", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      const planNoReviewModel = "*— Automated by Claws —*\n\n## Implementation Plan\n\nDo the thing.";
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: planNoReviewModel, login: "claws-bot" }]);

      await processIssue(repo, issue);

      const prBody = mockGh.createPR.mock.calls[0][3] as string;
      expect(prBody).not.toContain("review-model:");
    });

    it("omits review-model marker when no plan comment exists (planText is falsy)", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([]);

      await processIssue(repo, issue);

      const prBody = mockGh.createPR.mock.calls[0][3] as string;
      expect(prBody).not.toContain("review-model:");
    });

    it("skips if open PR already exists", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getOpenPRForIssue.mockResolvedValue(
        mockPR({ number: 42, headRefName: "claws/issue-1-ab12" }),
      );

      await processIssue(repo, issue);

      expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
      expect(mockClaude.runClaude).not.toHaveBeenCalled();
      expect(mockGh.createPR).not.toHaveBeenCalled();
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("PR includes Closes for duplicate issues", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.listDuplicateIssuesOf.mockResolvedValue([{ number: 42 }]);

      await processIssue(repo, issue);

      const body = mockGh.createPR.mock.calls[0][3] as string;
      expect(body).toContain("Closes #1");
      expect(body).toContain("Closes #42");
    });
  });

  describe("multi-PR flow", () => {
    const multiPRPlan = [
      "*— Automated by Claws —*",
      "",
      "## Implementation Plan",
      "",
      "Preamble text.",
      "",
      "### PR 1: Add database schema",
      "Create tables.",
      "",
      "### PR 2: Implement API endpoints",
      "Build REST endpoints.",
      "",
      "### PR 3: Add frontend UI",
      "Wire up React components.",
    ].join("\n");

    it("creates first PR with phase title", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);

      await processIssue(repo, issue);

      expect(mockGh.createPR).toHaveBeenCalledWith(
        repo.fullName,
        expect.stringContaining("claws/issue-1"),
        "fix(#1): Add database schema (1/3)",
        expect.stringContaining("Part of #1"),
      );
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
    });

    it("calls updatePR with 'Part of' in multi-PR flow", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);

      await processIssue(repo, issue);

      expect(mockGh.updatePR).toHaveBeenCalledWith(
        repo.fullName,
        100,
        expect.stringContaining("Part of #1"),
        "fix(#1): Add database schema (1/3)",
      );
      // Should NOT contain "Closes" for non-final phase
      const body = mockGh.updatePR.mock.calls[0][2] as string;
      expect(body).not.toContain("Closes");
    });

    it("creates second PR after first is merged", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, title: "Add database schema", headRefName: "claws/issue-1-xxxx" }),
      ]);

      await processIssue(repo, issue);

      expect(mockGh.createPR).toHaveBeenCalledWith(
        repo.fullName,
        expect.stringContaining("claws/issue-1"),
        "fix(#1): Implement API endpoints (2/3)",
        expect.stringContaining("Part of #1"),
      );
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
    });

    it("creates final PR with Closes reference", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
        mockPR({ number: 51, headRefName: "claws/issue-1-bbbb" }),
      ]);

      await processIssue(repo, issue);

      expect(mockGh.createPR).toHaveBeenCalledWith(
        repo.fullName,
        expect.stringContaining("claws/issue-1"),
        "fix(#1): Add frontend UI (3/3)",
        expect.stringContaining("Closes #1"),
      );
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
    });

    it("final PR includes Closes for duplicate issues", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
        mockPR({ number: 51, headRefName: "claws/issue-1-bbbb" }),
      ]);
      mockGh.listDuplicateIssuesOf.mockResolvedValue([{ number: 42 }]);

      await processIssue(repo, issue);

      const body = mockGh.createPR.mock.calls[0][3] as string;
      expect(body).toContain("Closes #1");
      expect(body).toContain("Closes #42");
    });

    it("final PR with no duplicates only closes the canonical issue", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
        mockPR({ number: 51, headRefName: "claws/issue-1-bbbb" }),
      ]);
      mockGh.listDuplicateIssuesOf.mockResolvedValue([]);

      await processIssue(repo, issue);

      const body = mockGh.createPR.mock.calls[0][3] as string;
      expect(body).toContain("Closes #1");
      expect(body).not.toContain("Closes #42");
    });

    it("non-last phase PR does not include duplicate closes", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      mockGh.listDuplicateIssuesOf.mockResolvedValue([{ number: 42 }]);

      await processIssue(repo, issue);

      const body = mockGh.createPR.mock.calls[0][3] as string;
      expect(body).toContain("Part of #1");
      expect(body).not.toContain("Closes");
    });

    it("prompt instructs Claude not to create PRs", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);

      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Do NOT create a pull request");
    });

    it("includes phase-specific prompt content", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);

      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("PR 1 of 3");
      expect(prompt).toContain("Add database schema");
      expect(prompt).toContain("Do NOT implement changes from other phases");
    });

    it("prompt lists a claim-only earlier phase under Already Completed", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: multiPRPlan, login: "claws-bot" },
        { id: 2, body: "claws-phase-done: 1", login: "brendan" },
      ]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);

      await processIssue(repo, issue);

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("PR 2 of 3");
      expect(prompt).toContain("## Already Completed");
      expect(prompt).toContain("- Phase 1: claimed complete");
      expect(prompt).not.toContain("None yet — this is the first PR.");
    });

    it("no commits in multi-phase phase 1 — posts 're-add label' message (no auto-retry yet)", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      mockClaude.hasNewCommits.mockResolvedValue(false);

      await processIssue(repo, issue);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.stringContaining("re-add the `Refined` label"),
        { agentName: "Implementer" },
      );
      expect(mockGh.commentOnIssue).not.toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.stringContaining("retry this phase automatically"),
        expect.anything(),
      );
    });

    it("no commits in multi-phase phase 2 — posts 'retry automatically' message", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
      ]);
      mockClaude.hasNewCommits.mockResolvedValue(false);

      await processIssue(repo, issue);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.stringContaining("retry this phase automatically"),
        { agentName: "Implementer" },
      );
      expect(mockGh.commentOnIssue).not.toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.stringContaining("re-add the `Refined` label"),
        expect.anything(),
      );
    });

    it("no commits — dedup: skips comment if no-commit marker already exists (multi-phase)", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: multiPRPlan, login: "claws-bot" },
        { id: 2, body: "## No changes produced\n\nno-commit:2", login: "claws-bot" },
      ]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
      ]);
      mockClaude.hasNewCommits.mockResolvedValue(false);

      await processIssue(repo, issue);

      expect(mockGh.commentOnIssue).not.toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.stringContaining("No changes produced"),
        expect.anything(),
      );
    });

    it("waits when an earlier phase is covered only by an open PR", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      // A human's still-open PR covers phase 1: phase 2 would branch off a default
      // branch that lacks it, so nothing is implemented until #60 merges (#2594).
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
        { number: 60, title: "fix(#1): Add database schema (1/3)", body: "Part of #1", state: "open" },
      ]);

      await processIssue(repo, issue);

      expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
      expect(mockGh.createPR).not.toHaveBeenCalled();
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 0 });
    });

    it("does not add Closes when a later phase is covered only by an open PR", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
      ]);
      // Phase 3 already has an in-flight PR from a human. Phase 2 is the last
      // *uncovered* phase, but it is not the last phase to land — `Closes #1`
      // here would auto-close the issue while #60 is still open (#2594).
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
        { number: 60, title: "fix(#1): Add frontend UI (3/3)", body: "Part of #1", state: "open" },
      ]);

      await processIssue(repo, issue);

      const body = mockGh.createPR.mock.calls[0][3] as string;
      expect(body).toContain("Part of #1");
      expect(body).not.toContain("Closes");
    });

    it("adds Closes when the later phases already merged or were claimed", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: multiPRPlan, login: "claws-bot" },
        { id: 2, body: "claws-phase-done: 3", login: "stjohnb" },
      ]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
      ]);

      await processIssue(repo, issue);

      const body = mockGh.createPR.mock.calls[0][3] as string;
      expect(body).toContain("Closes #1");
    });

    it("phase overflow — more merged PRs than plan phases: removes Refined label, records complete, skips runClaude", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      // multiPRPlan has 3 phases; 4 merged PRs exceeds it, triggering the overflow guard
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
        mockPR({ number: 51, headRefName: "claws/issue-1-bbbb" }),
        mockPR({ number: 52, headRefName: "claws/issue-1-cccc" }),
        mockPR({ number: 53, headRefName: "claws/issue-1-dddd" }),
      ]);

      await processIssue(repo, issue);

      expect(mockClaude.runClaude).not.toHaveBeenCalled();
      expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 0 });
      expect(mockGh.createPR).not.toHaveBeenCalled();
    });

    describe("all-phases-covered notice (#2821)", () => {
      const singlePhasePlan = "*— Automated by Claws —*\n\n## Implementation Plan\n\nDo the thing.";

      it("explains the terminal state and applies Ready", async () => {
        const issue = mockIssue({ labels: [{ name: "Refined" }] });
        mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: singlePhasePlan, login: "claws-bot" }]);
        mockGh.listMergedPRsForIssue.mockResolvedValue([
          mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
        ]);

        await processIssue(repo, issue);

        const notice = mockGh.commentOnIssue.mock.calls.find(
          (c: unknown[]) => typeof c[2] === "string" && c[2].includes("CLAWS_ALL_PHASES_COVERED:1"),
        );
        expect(notice).toBeDefined();
        // Plan lookup takes the LAST comment carrying the header — the notice must not.
        expect(notice![2]).not.toContain("## Implementation Plan");
        expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Ready");
      });

      it("does not repeat the notice once the marker is present", async () => {
        const issue = mockIssue({ labels: [{ name: "Refined" }] });
        mockGh.getIssueComments.mockResolvedValue([
          { id: 1, body: singlePhasePlan, login: "claws-bot" },
          { id: 2, body: "*— Automated by Claws —*\n\n## All plan phases are already covered\n\nCLAWS_ALL_PHASES_COVERED:1", login: "claws-bot" },
        ]);
        mockGh.listMergedPRsForIssue.mockResolvedValue([
          mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
        ]);

        await processIssue(repo, issue);

        expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
        expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
      });

      it("names a merged PR whose marker outnumbers the plan's phases", async () => {
        const issue = mockIssue({ labels: [{ name: "Refined" }] });
        mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: singlePhasePlan, login: "claws-bot" }]);
        mockGh.listMergedPRsForIssue.mockResolvedValue([
          mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
        ]);
        mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
          { number: 309, title: "feat(#1): sops recipients (1/2)", body: "Part of #1", state: "merged" },
        ]);

        await processIssue(repo, issue);

        const notice = mockGh.commentOnIssue.mock.calls.find(
          (c: unknown[]) => typeof c[2] === "string" && c[2].includes("CLAWS_ALL_PHASES_COVERED:1"),
        );
        expect(notice![2]).toContain("Phase-count mismatch");
        expect(notice![2]).toContain("#309");
      });

      it("neutralises a PLAN_HEADER embedded in a mismatched PR's title", async () => {
        // PR titles come from any author; a title carrying the literal header would
        // make this notice the LAST comment containing it and hijack plan lookup.
        const issue = mockIssue({ labels: [{ name: "Refined" }] });
        mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: singlePhasePlan, login: "claws-bot" }]);
        mockGh.listMergedPRsForIssue.mockResolvedValue([
          mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
        ]);
        mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
          { number: 309, title: "fix: ## Implementation Plan cleanup (1/2)", body: "Part of #1", state: "merged" },
        ]);

        await processIssue(repo, issue);

        const notice = mockGh.commentOnIssue.mock.calls.find(
          (c: unknown[]) => typeof c[2] === "string" && c[2].includes("CLAWS_ALL_PHASES_COVERED:1"),
        );
        expect(notice).toBeDefined();
        expect(notice![2]).not.toContain("## Implementation Plan");
        expect(notice![2]).toContain("Implementation plan cleanup");
      });
    });
  });

  describe("checkAndContinue", () => {
    const multiPRPlan = [
      "*— Automated by Claws —*",
      "",
      "## Implementation Plan",
      "",
      "### PR 1: First change",
      "Do first thing.",
      "",
      "### PR 2: Second change",
      "Do second thing.",
    ].join("\n");

    it("does nothing if there is still an open PR", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(mockPR({ headRefName: "claws/issue-1-cd34" }));

      await checkAndContinue(repo, issue);

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("re-labels as Refined when PR merged and more phases remain", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);

      await checkAndContinue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("does not re-label when all phases are complete", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
        mockPR({ number: 51, headRefName: "claws/issue-1-bbbb" }),
      ]);

      await checkAndContinue(repo, issue);

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("does not re-label while an earlier phase's PR is still open", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);
      // `getOpenPRForIssue` only sees `claws/issue-<N>-` branches, so a human's
      // in-flight PR for phase 1 reaches here — advancing to phase 2 now would
      // build it on a base without phase 1 (#2594).
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
        { number: 60, title: "fix(#1): First change (1/2)", body: "Part of #1", state: "open" },
      ]);

      await checkAndContinue(repo, issue);

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("does not re-label when no-commit completions exceed threshold", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      mockDb.countRecentNoCommitCompletions.mockReturnValue(3);

      await checkAndContinue(repo, issue);

      expect(mockGh.addLabel).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.stringContaining("phase-stuck:2"),
        expect.any(Object),
      );
    });

    it("re-labels normally when no-commit count is below threshold", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      mockDb.countRecentNoCommitCompletions.mockReturnValue(2);

      await checkAndContinue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("deduplicates stuck comment using marker", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: multiPRPlan, login: "claws-bot" },
        { id: 2, body: "stuck\nphase-stuck:2", login: "claws-bot" },
      ]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      mockDb.countRecentNoCommitCompletions.mockReturnValue(3);

      await checkAndContinue(repo, issue);

      expect(mockGh.addLabel).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });
  });

  describe("phase progress comment", () => {
    const multiPRPlan = [
      "*— Automated by Claws —*",
      "",
      "## Implementation Plan",
      "",
      "Preamble text.",
      "",
      "### PR 1: Add database schema",
      "Create tables.",
      "",
      "### PR 2: Implement API endpoints",
      "Build REST endpoints.",
      "",
      "### PR 3: Add frontend UI",
      "Wire up React components.",
    ].join("\n");

    it("posts progress comment before implementing next phase", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, title: "Add database schema", headRefName: "claws/issue-1-xxxx" }),
      ]);

      await processIssue(repo, issue);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.stringContaining("phase-progress:1"),
        { agentName: "Implementer" },
      );
      expect(mockGh.editIssueComment).not.toHaveBeenCalled();
      expect(mockGh.createPR).toHaveBeenCalled();
    });

    it("skips progress comment if marker already exists in comments", async () => {
      const progressComment = "*— Automated by Claws —*\n\n## Phase Progress\n\nphase-progress:1";
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: multiPRPlan, login: "claws-bot" },
        { id: 43, body: progressComment, login: "claws-bot" },
      ]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-xxxx" }),
      ]);

      await processIssue(repo, issue);

      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    });

    it("progress comment failure does not block implementation", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-xxxx" }),
      ]);

      mockGh.commentOnIssue.mockRejectedValueOnce(new Error("API error"));

      await processIssue(repo, issue);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
      expect(mockGh.createPR).toHaveBeenCalled();
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("skips progress comment for first phase", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);

      await processIssue(repo, issue);

      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
    });

    it("progress comment contains merged PR numbers and titles", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, title: "Add database schema", headRefName: "claws/issue-1-xxxx" }),
        mockPR({ number: 51, title: "Implement API endpoints", headRefName: "claws/issue-1-yyyy" }),
      ]);

      await processIssue(repo, issue);

      const commentBody = mockGh.commentOnIssue.mock.calls[0][2] as string;
      expect(commentBody).toContain("- Phase 1: PR #50 (merged) — Add database schema");
      expect(commentBody).toContain("- Phase 2: PR #51 (merged) — Implement API endpoints");
      expect(commentBody).toContain("2/3");
      expect(commentBody).toContain("PR 3/3");
      expect(commentBody).toContain("claws-phase-done: <numbers>");
    });
  });

  describe("plan validation in checkAndContinue", () => {
    const multiPRPlan = [
      "*— Automated by Claws —*",
      "",
      "## Implementation Plan",
      "",
      "Preamble text.",
      "",
      "### PR 1: Add database schema",
      "Create tables.",
      "",
      "### PR 2: Implement API endpoints",
      "Build REST endpoints.",
    ].join("\n");

    it("skips validation for single-phase plans", async () => {
      const singlePlan = "*— Automated by Claws —*\n\n## Implementation Plan\n\nJust do the thing.";
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: singlePlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([]);

      await checkAndContinue(repo, issue);

      expect(mockGh.getPRDiff).not.toHaveBeenCalled();
      expect(mockClaude.enqueue).not.toHaveBeenCalled();
    });

    it("skips if plan already updated for current phase", async () => {
      const updatedPlan = multiPRPlan + "\n\nplan-updated-after-phase:1";
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: updatedPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);

      await checkAndContinue(repo, issue);

      expect(mockGh.getPRDiff).not.toHaveBeenCalled();
      expect(mockGh.editIssueComment).not.toHaveBeenCalled();
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("calls Claude and updates plan when deviations detected", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      mockClaude.runClaude.mockResolvedValue(
        "Updated preamble.\n\n### PR 1: Modified schema\nActually modified existing tables.\n\n### PR 2: Updated endpoints\nAdjusted for schema changes.",
      );

      await checkAndContinue(repo, issue);

      expect(mockGh.getPRDiff).toHaveBeenCalledWith(repo.fullName, 50);
      expect(mockClaude.runClaude).toHaveBeenCalled();
      expect(mockGh.editIssueComment).toHaveBeenCalledWith(
        repo.fullName,
        42,
        expect.stringContaining("### PR 1: Modified schema"),
        { agentName: "Planner" },
      );
      expect(mockGh.editIssueComment).toHaveBeenCalledWith(
        repo.fullName,
        42,
        expect.stringContaining("plan-updated-after-phase:1"),
        { agentName: "Planner" },
      );
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("writes marker but does not change plan content when Claude returns NO_CHANGES_NEEDED", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      mockClaude.runClaude.mockResolvedValue("NO_CHANGES_NEEDED");

      await checkAndContinue(repo, issue);

      expect(mockGh.getPRDiff).toHaveBeenCalledWith(repo.fullName, 50);
      // Marker should be written to prevent redundant Claude calls on re-entry
      expect(mockGh.editIssueComment).toHaveBeenCalledWith(
        repo.fullName,
        42,
        expect.stringContaining("plan-updated-after-phase:1"),
        { agentName: "Planner" },
      );
      // Original plan content should be preserved
      expect(mockGh.editIssueComment).toHaveBeenCalledWith(
        repo.fullName,
        42,
        expect.stringContaining("### PR 1: Add database schema"),
        { agentName: "Planner" },
      );
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("validation failure does not block phase advancement", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      mockGh.getPRDiff.mockResolvedValue("");

      await checkAndContinue(repo, issue);

      expect(mockClaude.enqueue).not.toHaveBeenCalled();
      expect(mockGh.editIssueComment).not.toHaveBeenCalled();
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("skips plan update when Claude returns malformed output without PR headers", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      mockClaude.runClaude.mockResolvedValue("Here is some arbitrary text that doesn't follow the expected format at all.");

      await checkAndContinue(repo, issue);

      expect(mockGh.getPRDiff).toHaveBeenCalledWith(repo.fullName, 50);
      expect(mockGh.editIssueComment).not.toHaveBeenCalled();
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("strips duplicate ## Implementation Plan header from Claude output", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      mockClaude.runClaude.mockResolvedValue(
        "## Implementation Plan\n\nUpdated preamble.\n\n### PR 1: Modified schema\nChanged.\n\n### PR 2: Updated endpoints\nAdjusted.",
      );

      await checkAndContinue(repo, issue);

      const editCall = mockGh.editIssueComment.mock.calls[0];
      const body = editCall[2] as string;
      // Should have exactly one ## Implementation Plan header, not two
      const headerCount = (body.match(/## Implementation Plan/g) || []).length;
      expect(headerCount).toBe(1);
    });

    it("validates phase 2 with multiple merged PRs and correct indexing", async () => {
      const threePhasePlan = [
        "*— Automated by Claws —*",
        "",
        "## Implementation Plan",
        "",
        "Preamble text.",
        "",
        "### PR 1: Add database schema",
        "Create tables.",
        "",
        "### PR 2: Implement API endpoints",
        "Build REST endpoints.",
        "",
        "### PR 3: Add frontend UI",
        "Wire up React components.",
      ].join("\n");

      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: threePhasePlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, title: "Add database schema", headRefName: "claws/issue-1-aaaa" }),
        mockPR({ number: 51, title: "Implement API endpoints", headRefName: "claws/issue-1-bbbb" }),
      ]);
      mockClaude.runClaude.mockResolvedValue("NO_CHANGES_NEEDED");

      await checkAndContinue(repo, issue);

      // Should fetch the diff for the last merged PR (#51), not the first
      expect(mockGh.getPRDiff).toHaveBeenCalledWith(repo.fullName, 51);
      // Validation prompt should reference phase 2
      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("Phase 2");
      expect(prompt).toContain("Implement API endpoints");
      // Should still advance to phase 3
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("still advances when validation throws", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      mockGh.getPRDiff.mockRejectedValue(new Error("network failure"));

      await checkAndContinue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("exits early when merged PR count exceeds plan phases", async () => {
      // 2-phase plan with 3 merged PRs: mergedPRs.length >= totalPhases (3 >= 2)
      // triggers the early return in checkAndContinue before validateAndUpdatePlan is called
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-aaaa" }),
        mockPR({ number: 51, headRefName: "claws/issue-1-bbbb" }),
        mockPR({ number: 52, headRefName: "claws/issue-1-cccc" }),
      ]);

      await checkAndContinue(repo, issue);

      // The mergedPRs.length >= totalPhases guard in checkAndContinue fires
      expect(mockClaude.enqueue).not.toHaveBeenCalled();
      expect(mockGh.editIssueComment).not.toHaveBeenCalled();
    });

    it("skips update when Claude returns wrong number of phases", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      // Claude returns only 1 phase instead of the expected 2
      mockClaude.runClaude.mockResolvedValue(
        "Updated preamble.\n\n### PR 1: Merged everything\nDid it all in one go.",
      );

      await checkAndContinue(repo, issue);

      expect(mockGh.editIssueComment).not.toHaveBeenCalled();
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });

    it("preserves model recommendation through plan rewrite", async () => {
      const planWithModel = multiPRPlan + "\n\n**Recommended implementation model:** `sonnet`";
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: planWithModel, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      mockClaude.runClaude.mockResolvedValue(
        "Updated preamble.\n\n### PR 1: Modified schema\nChanged.\n\n### PR 2: Updated endpoints\nAdjusted.",
      );

      await checkAndContinue(repo, issue);

      const editCall = mockGh.editIssueComment.mock.calls[0];
      const body = editCall[2] as string;
      expect(body).toContain("**Recommended implementation model:** `sonnet`");
      // Should have exactly one model recommendation line
      const modelLineCount = (body.match(/\*\*Recommended implementation model:\*\*/g) || []).length;
      expect(modelLineCount).toBe(1);
    });

    it("strips hallucinated model line from Claude response before appending original", async () => {
      const planWithModel = multiPRPlan + "\n\n**Recommended implementation model:** `sonnet`";
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: planWithModel, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      // Claude hallucinated a model recommendation in its response
      mockClaude.runClaude.mockResolvedValue(
        "Updated preamble.\n\n### PR 1: Modified schema\nChanged.\n\n### PR 2: Updated endpoints\nAdjusted.\n\n**Recommended implementation model:** `opus`",
      );

      await checkAndContinue(repo, issue);

      const editCall = mockGh.editIssueComment.mock.calls[0];
      const body = editCall[2] as string;
      // Should preserve the original model (sonnet), not the hallucinated one (opus)
      expect(body).toContain("**Recommended implementation model:** `sonnet`");
      const modelLineCount = (body.match(/\*\*Recommended implementation model:\*\*/g) || []).length;
      expect(modelLineCount).toBe(1);
    });

    it("strips provider line from Claude response during plan rewrite", async () => {
      const planWithProvider = multiPRPlan + "\n\n**Recommended implementation model:** `sonnet`\n**Recommended provider:** `codex`";
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: planWithProvider, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      mockClaude.runClaude.mockResolvedValue(
        "Updated preamble.\n\n### PR 1: Modified schema\nChanged.\n\n### PR 2: Updated endpoints\nAdjusted.",
      );

      await checkAndContinue(repo, issue);

      const editCall = mockGh.editIssueComment.mock.calls[0];
      const body = editCall[2] as string;
      // Provider line should not be preserved in updated plan
      expect(body).not.toContain("**Recommended provider:**");
      expect(body).toContain("**Recommended implementation model:** `sonnet`");
    });

    it("preserves attribution footer through plan rewrite", async () => {
      const planWithAttribution = multiPRPlan + "\n\n*Models used: claude-sonnet-4-5 (planner)*";
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: planWithAttribution, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      mockClaude.runClaude.mockResolvedValue(
        "Updated preamble.\n\n### PR 1: Modified schema\nChanged.\n\n### PR 2: Updated endpoints\nAdjusted.",
      );

      await checkAndContinue(repo, issue);

      const editCall = mockGh.editIssueComment.mock.calls[0];
      const body = editCall[2] as string;
      expect(body).toContain("*Models used: claude-sonnet-4-5 (planner)*");
      // Should have exactly one attribution line
      const attributionCount = (body.match(/\*Models used:/g) || []).length;
      expect(attributionCount).toBe(1);
    });

    it("still re-labels as Refined after validation regardless of outcome", async () => {
      const issue = mockIssue();
      mockGh.getOpenPRForIssue.mockResolvedValue(null);
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPRPlan, login: "claws-bot" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, headRefName: "claws/issue-1-ab12" }),
      ]);
      mockClaude.runClaude.mockResolvedValue("NO_CHANGES_NEEDED");

      await checkAndContinue(repo, issue);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });
  });

  it("includes image context in prompt when images are found", async () => {
    const issue = mockIssue({
      body: "Fix this: ![bug](https://example.com/bug.png)",
      labels: [{ name: "Refined" }],
    });
    mockGh.getIssueComments.mockResolvedValue([{ id: 100, body: "![comment img](https://example.com/comment.png)", login: "commenter" }]);
    mockProcessTextForImages.mockResolvedValueOnce("\n## Attached Images\n- .claws-images/img-1.png");

    await processIssue(repo, issue);

    expect(mockProcessTextForImages).toHaveBeenCalledWith(
      [issue.body, "![comment img](https://example.com/comment.png)"],
      "/tmp/worktree",
      repo,
      { repo: repo.fullName, issueNumber: issue.number, agentName: "Implementer" },
      expect.any(Array),
    );
    const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("## Attached Images");
  });
  describe("stale-plan gate (#2524)", () => {
    const OCC_BLOCK = "\n\n---\n**First seen:** 2026-08-01T00:00:00Z\n**Last seen:** 2026-08-02T00:00:00Z\n**Occurrences:** 3";

    /** A Claws plan comment stamped with the hash of `body`. */
    const stampedPlan = (title: string, body: string, id = 900) => ({
      id,
      body: `*— Automated by Claws —*\n\n## Implementation Plan\n\nDo the thing\n\n${PLAN_BODY_HASH_MARKER} ${issueContentHash(title, body)}`,
      body_html: "",
      login: "claws-bot",
    });

    it("removes Refined, posts exactly one notice and never starts a worktree when the issue was edited", async () => {
      const issue = mockIssue({ body: "skip finder-cap" });
      mockGh.getIssueComments.mockResolvedValue([stampedPlan(issue.title, "skip finder-cap")]);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "finder-cap — no change" });

      await processIssue(repo, issue);

      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Refined");
      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
      expect(mockGh.commentOnIssue.mock.calls[0][2]).toContain(STALE_PLAN_MARKER);
      expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    });

    it("the notice must not contain the plan header, which would hijack plan lookup", async () => {
      const issue = mockIssue({ body: "skip finder-cap" });
      mockGh.getIssueComments.mockResolvedValue([stampedPlan(issue.title, "skip finder-cap")]);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "edited" });

      await processIssue(repo, issue);

      expect(mockGh.commentOnIssue.mock.calls[0][2]).not.toContain("## Implementation Plan");
    });

    it("does not post a duplicate notice on a second run", async () => {
      const issue = mockIssue({ body: "skip finder-cap" });
      const notice = `${STALE_PLAN_MARKER}: ${issueContentHash(issue.title, "skip finder-cap")}`;
      mockGh.getIssueComments.mockResolvedValue([
        stampedPlan(issue.title, "skip finder-cap"),
        { id: 901, body: `*— Automated by Claws —*\n\nalready noticed\n\n${notice}`, body_html: "", login: "claws-bot" },
      ]);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "edited" });

      await processIssue(repo, issue);

      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Refined");
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    });

    it("posts a fresh notice for a second staleness event after an in-place re-plan", async () => {
      // ISSUE_REFINER_REPLAN edits the plan comment in place, so the notice from the
      // first event still sits right after it — only the stamped hash tells them apart.
      const issue = mockIssue({ body: "third revision" });
      mockGh.getIssueComments.mockResolvedValue([
        stampedPlan(issue.title, "second revision"),
        {
          id: 901,
          body: `*— Automated by Claws —*\n\nnotice for the first event\n\n${STALE_PLAN_MARKER}: ${issueContentHash(issue.title, "first revision")}`,
          body_html: "",
          login: "claws-bot",
        },
      ]);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "third revision" });

      await processIssue(repo, issue);

      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
      expect(mockGh.commentOnIssue.mock.calls[0][2]).toContain(
        `${STALE_PLAN_MARKER}: ${issueContentHash(issue.title, "second revision")}`,
      );
    });

    it("does not gate a multi-PR continuation phase on a stale hash", async () => {
      // checkAndContinue re-applies `Refined` to reach processIssue; phase 2+ follows an
      // already-agreed plan, so a body edit must not strand the merged phases.
      const issue = mockIssue({ body: "edited mid-implementation" });
      const phasedPlan = [
        "*— Automated by Claws —*",
        "",
        "## Implementation Plan",
        "",
        "Preamble text.",
        "",
        "### PR 1: Add database schema",
        "Create tables.",
        "",
        "### PR 2: Implement API endpoints",
        "Build REST endpoints.",
        "",
        `${PLAN_BODY_HASH_MARKER} ${issueContentHash(issue.title, "original body")}`,
      ].join("\n");
      mockGh.getIssueComments.mockResolvedValue([{ id: 900, body: phasedPlan, body_html: "", login: "claws-bot" }]);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "edited mid-implementation" });
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        mockPR({ number: 50, title: "Add database schema", headRefName: "claws/issue-1-aaaa" }),
      ]);

      await processIssue(repo, issue);

      expect(mockClaude.withNewWorktree).toHaveBeenCalled();
      expect(mockGh.createPR).toHaveBeenCalledWith(
        repo.fullName,
        expect.stringContaining("claws/issue-1"),
        "fix(#1): Implement API endpoints (2/2)",
        expect.anything(),
      );
      expect(mockGh.commentOnIssue).not.toHaveBeenCalledWith(
        repo.fullName, issue.number, expect.stringContaining(STALE_PLAN_MARKER), expect.anything(),
      );
    });

    it("proceeds normally when the stamped hash still matches the live issue", async () => {
      const issue = mockIssue({ body: "skip finder-cap" });
      mockGh.getIssueComments.mockResolvedValue([stampedPlan(issue.title, "skip finder-cap")]);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "skip finder-cap" });

      await processIssue(repo, issue);

      expect(mockClaude.withNewWorktree).toHaveBeenCalled();
      expect(mockGh.commentOnIssue).not.toHaveBeenCalledWith(
        repo.fullName, issue.number, expect.stringContaining(STALE_PLAN_MARKER), expect.anything(),
      );
    });

    it("proceeds normally for a legacy plan carrying no hash marker", async () => {
      const issue = mockIssue({ body: "anything at all" });
      mockGh.getIssueComments.mockResolvedValue([
        { id: 900, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nlegacy plan", body_html: "", login: "claws-bot" },
      ]);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "totally different now" });

      await processIssue(repo, issue);

      expect(mockClaude.withNewWorktree).toHaveBeenCalled();
    });

    it("proceeds normally for a Claws-maintained alert issue whose body changed", async () => {
      // ensureAlertIssue rewrites these bodies every tick; gating on the hash would
      // make every monitor issue permanently un-implementable.
      const issue = mockIssue({ body: "disk at 80%" + OCC_BLOCK });
      mockGh.getIssueComments.mockResolvedValue([stampedPlan(issue.title, "disk at 71%")]);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: "disk at 80%" + OCC_BLOCK });

      await processIssue(repo, issue);

      expect(mockClaude.withNewWorktree).toHaveBeenCalled();
    });

    it("proceeds normally when the live read fails", async () => {
      const issue = mockIssue({ body: "skip finder-cap" });
      mockGh.getIssueComments.mockResolvedValue([stampedPlan(issue.title, "something else")]);
      mockGh.getIssueTitleBody.mockRejectedValue(new Error("gh down"));

      await processIssue(repo, issue);

      expect(mockClaude.withNewWorktree).toHaveBeenCalled();
    });
  });

  describe("pending human feedback guard (#2772)", () => {
    it("removes Refined and never starts a worktree when a human comment after the plan is unreacted", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = {
        id: 900,
        body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nDo the thing",
        body_html: "",
        login: "claws-bot",
      };
      const humanComment = { id: 901, body: "please do X instead", body_html: "", login: "stjohnb" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: issue.body });

      await processIssue(repo, issue);

      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Refined");
      expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
      expect(mockGh.commentOnIssue.mock.calls[0][2]).toContain("CLAWS_REFINED_PENDING_FEEDBACK");
      expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
      expect(mockClaude.runClaude).not.toHaveBeenCalled();
    });

    // Multi-phase so a "claws-phase-done: 1" claim covers only phase 1, not the
    // whole plan — isolating the pending-feedback guard from the separate
    // "all phases already covered" guard, which also removes Refined.
    const multiPhasePlan = [
      "*— Automated by Claws —*",
      "",
      "## Implementation Plan",
      "",
      "Preamble text.",
      "",
      "### PR 1: Add database schema",
      "Create tables.",
      "",
      "### PR 2: Implement API endpoints",
      "Build REST endpoints.",
    ].join("\n");

    it("does not guard on a comment that is purely a claws-phase-done claim", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 900, body: multiPhasePlan, body_html: "", login: "claws-bot" };
      const claimComment = { id: 901, body: "claws-phase-done: 1", body_html: "", login: "stjohnb" };
      mockGh.getIssueComments.mockResolvedValue([planComment, claimComment]);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: issue.body });

      await processIssue(repo, issue);

      const pendingFeedbackNotice = mockGh.commentOnIssue.mock.calls.some(
        (c: unknown[]) => typeof c[2] === "string" && c[2].includes("CLAWS_REFINED_PENDING_FEEDBACK"),
      );
      expect(pendingFeedbackNotice).toBe(false);
      expect(mockClaude.withNewWorktree).toHaveBeenCalled();
    });

    it("still guards when a claws-phase-done claim carries real feedback alongside it", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      const planComment = { id: 900, body: multiPhasePlan, body_html: "", login: "claws-bot" };
      const mixedComment = { id: 901, body: "claws-phase-done: 1 — also please rename X", body_html: "", login: "stjohnb" };
      mockGh.getIssueComments.mockResolvedValue([planComment, mixedComment]);
      mockGh.getIssueTitleBody.mockResolvedValue({ title: issue.title, body: issue.body });

      await processIssue(repo, issue);

      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Refined");
      expect(mockGh.commentOnIssue.mock.calls[0][2]).toContain("CLAWS_REFINED_PENDING_FEEDBACK");
      expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    });
  });

  describe("target-PR mode (CLAWS_TARGET_PR)", () => {
    const plan = (marker = "CLAWS_TARGET_PR: #10") =>
      `*— Automated by Claws —*\n\n## Implementation Plan\n\nDo the thing.\n\n${marker}`;
    const targetPR = () => mockPR({ number: 10, headRefName: "claws/issue-5-abcd", baseRefName: "main" });

    beforeEach(() => {
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: plan(), login: "claws-bot" }]);
      mockGh.listPRs.mockResolvedValue([targetPR()]);
      // Earlier tests leave a stubbed value here and vi.clearAllMocks() does not
      // reset implementations — an inherited covering PR would mark every phase done.
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([]);
      mockDb.hasActiveWorkForPR.mockReturnValue(false);
    });

    it("pushes onto the target PR's branch instead of opening a stacked PR", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }] });

      await processIssue(repo, issue);

      expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
      expect(mockClaude.withExistingWorktree).toHaveBeenCalledWith(
        repo, "claws/issue-5-abcd", "issue-worker", expect.any(Function),
      );
      expect(mockGh.createPR).not.toHaveBeenCalled();
      expect(mockClaude.generatePRDescription).not.toHaveBeenCalled();
      expect(mockClaude.pushBranch).toHaveBeenCalledWith("/tmp/worktree", "claws/issue-5-abcd", repo.owner);
      expect(mockGh.updatePR).toHaveBeenCalledWith(
        repo.fullName, 10, "Existing PR body\n\nCloses #1",
      );
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "In Review");
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(
        1, { commits: 1, filesChanged: 1, insertions: 10, deletions: 5, prNumber: 10, prAction: "updated" },
      );
      // Stats must diff against the pre-run SHA, not origin/<defaultBranch> — the
      // target PR's branch is already far ahead of the default branch, so diffing
      // against the branch would count that whole PR instead of just this run.
      expect(mockClaude.getCommitCountSince).toHaveBeenCalledWith("/tmp/worktree", "sha-before");
      expect(mockClaude.getDiffStatsSince).toHaveBeenCalledWith("/tmp/worktree", "sha-before");
      expect(mockClaude.getCommitCount).not.toHaveBeenCalled();
      expect(mockClaude.getDiffStats).not.toHaveBeenCalled();
    });

    it("tells the implementer it is working on the target PR's branch", async () => {
      await processIssue(repo, mockIssue({ labels: [{ name: "Refined" }] }));

      const prompt = mockClaude.runClaude.mock.calls[0][0] as string;
      expect(prompt).toContain("head of open pull request #10");
      expect(prompt).toContain("claws/issue-5-abcd");
    });

    it("does not re-append Closes #N when the target PR body already has it", async () => {
      mockGh.getPRBody.mockResolvedValue("Existing body\n\nCloses #1");

      await processIssue(repo, mockIssue({ labels: [{ name: "Refined" }] }));

      expect(mockGh.updatePR).not.toHaveBeenCalled();
      expect(mockClaude.pushBranch).toHaveBeenCalled();
    });

    it("does not re-append a closing keyword when the target PR body already has a lowercase 'fixes #N'", async () => {
      mockGh.getPRBody.mockResolvedValue("Existing body\n\nfixes #1");

      await processIssue(repo, mockIssue({ labels: [{ name: "Refined" }] }));

      expect(mockGh.updatePR).not.toHaveBeenCalled();
      expect(mockClaude.pushBranch).toHaveBeenCalled();
    });

    it("skips the body edit rather than wiping the target PR body when getPRBody fails", async () => {
      mockGh.getPRBody.mockRejectedValue(new Error("rate limited"));

      await processIssue(repo, mockIssue({ labels: [{ name: "Refined" }] }));

      expect(mockGh.updatePR).not.toHaveBeenCalled();
      expect(mockClaude.pushBranch).toHaveBeenCalled();
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, 1, "In Review");
    });

    it("does not propagate Automerge to the target PR", async () => {
      const issue = mockIssue({ labels: [{ name: "Refined" }, { name: "Automerge" }] });

      await processIssue(repo, issue);

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, 10, "Automerge");
    });

    it("falls back to a normal PR when the target PR is not open", async () => {
      mockGh.listPRs.mockResolvedValue([]);

      await processIssue(repo, mockIssue({ labels: [{ name: "Refined" }] }));

      expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
      expect(mockGh.createPR).toHaveBeenCalled();
    });

    it("falls back to a normal PR when another agent is already pushing to the target PR's branch", async () => {
      mockDb.hasActiveWorkForPR.mockReturnValue(true);

      await processIssue(repo, mockIssue({ labels: [{ name: "Refined" }] }));

      expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
      expect(mockGh.createPR).toHaveBeenCalled();
      expect(mockDb.hasActiveWorkForPR).toHaveBeenCalledWith(
        repo.fullName,
        10,
        expect.arrayContaining(["pr-reviewer"]),
      );
    });

    it("falls back to a normal PR when the target PR is from a fork", async () => {
      mockGh.listPRs.mockResolvedValue([mockPR({ number: 10, headRefName: "claws/issue-5-abcd", isCrossRepository: true })]);

      await processIssue(repo, mockIssue({ labels: [{ name: "Refined" }] }));

      expect(mockGh.createPR).toHaveBeenCalled();
    });

    it("falls back to a normal PR when the target PR's base is not the default branch", async () => {
      mockGh.listPRs.mockResolvedValue([mockPR({ number: 10, headRefName: "claws/issue-5-abcd", baseRefName: "claws/other" })]);

      await processIssue(repo, mockIssue({ labels: [{ name: "Refined" }] }));

      expect(mockGh.createPR).toHaveBeenCalled();
    });

    it("falls back to a normal PR when the target PR's head is not a claws branch", async () => {
      mockGh.listPRs.mockResolvedValue([mockPR({ number: 10, headRefName: "feature-branch" })]);

      await processIssue(repo, mockIssue({ labels: [{ name: "Refined" }] }));

      expect(mockGh.createPR).toHaveBeenCalled();
    });

    it("ignores the marker on a multi-phase plan", async () => {
      const multi = [
        "*— Automated by Claws —*",
        "",
        "## Implementation Plan",
        "",
        "### PR 1: First",
        "Do A.",
        "",
        "### PR 2: Second",
        "Do B.",
        "",
        "CLAWS_TARGET_PR: #10",
      ].join("\n");
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: multi, login: "claws-bot" }]);

      await processIssue(repo, mockIssue({ labels: [{ name: "Refined" }] }));

      expect(mockClaude.withExistingWorktree).not.toHaveBeenCalled();
      expect(mockGh.createPR).toHaveBeenCalled();
    });

    it("treats an unchanged HEAD SHA as no commits produced", async () => {
      mockClaude.getHeadSha.mockReset();
      mockClaude.getHeadSha.mockResolvedValue("sha-unchanged");

      await processIssue(repo, mockIssue({ labels: [{ name: "Refined" }] }));

      expect(mockClaude.pushBranch).not.toHaveBeenCalled();
      expect(mockGh.updatePR).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName, 1, expect.stringContaining("No changes produced"), { agentName: "Implementer" },
      );
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 0 });
      // Diagnosis must diff against the pre-run SHA, not origin/<defaultBranch> —
      // same reasoning as the outcome stats above.
      expect(mockClaude.diagnoseNoCommitsSince).toHaveBeenCalledWith("/tmp/worktree", "sha-unchanged");
      expect(mockClaude.diagnoseNoCommits).not.toHaveBeenCalled();
    });

    it("records a skipped task when the target PR's branch is gone", async () => {
      mockClaude.withExistingWorktree.mockResolvedValue(null);

      await processIssue(repo, mockIssue({ labels: [{ name: "Refined" }] }));

      expect(mockClaude.runClaude).not.toHaveBeenCalled();
      expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1, { commits: 0 });
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, 1, "Refined");
    });
  });

});

describe("regenerateAndUpdatePRBody", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reassembles the phase header and closing keyword around the regenerated description", async () => {
    mockGh.getPRBody.mockResolvedValue("## PR 2 of 3: Phase\n\nold\n\nCloses #10");
    mockClaude.regeneratePRDescription.mockResolvedValue("## Summary\nNew");

    await regenerateAndUpdatePRBody(
      "/tmp/worktree",
      "test-org/test-repo",
      mockPR({ number: 7 }),
      "opus",
      "claude",
      "Updated with",
      "[test]",
    );

    expect(mockGh.updatePR).toHaveBeenCalledWith(
      "test-org/test-repo",
      7,
      "## PR 2 of 3: Phase\n\n## Summary\nNew\n\nCloses #10",
    );
  });

  it("appends the manual-action section last", async () => {
    mockGh.getPRBody.mockResolvedValue("## ⚠️ Manual action required before merge\n\nSet FOO");
    mockClaude.regeneratePRDescription.mockResolvedValue("## Summary\nNew");

    await regenerateAndUpdatePRBody(
      "/tmp/worktree",
      "test-org/test-repo",
      mockPR({ number: 7 }),
      "opus",
      "claude",
      "Updated with",
      "[test]",
    );

    expect(mockGh.updatePR).toHaveBeenCalledWith(
      "test-org/test-repo",
      7,
      "## Summary\nNew\n\n## ⚠️ Manual action required before merge\n\nSet FOO",
    );
  });

  it("carries forward both manual-action sections, pre-merge first", async () => {
    mockGh.getPRBody.mockResolvedValue(
      "## 📋 Manual action required after merge\n\nPublish the DS record\n\n## ⚠️ Manual action required before merge\n\nSet FOO",
    );
    mockClaude.regeneratePRDescription.mockResolvedValue("## Summary\nNew");

    await regenerateAndUpdatePRBody(
      "/tmp/worktree",
      "test-org/test-repo",
      mockPR({ number: 7 }),
      "opus",
      "claude",
      "Updated with",
      "[test]",
    );

    expect(mockGh.updatePR).toHaveBeenCalledWith(
      "test-org/test-repo",
      7,
      "## Summary\nNew\n\n## ⚠️ Manual action required before merge\n\nSet FOO\n\n## 📋 Manual action required after merge\n\nPublish the DS record",
    );
  });

  it("tolerates a failed getPRBody without throwing or updating the PR", async () => {
    mockGh.getPRBody.mockRejectedValue(new Error("boom"));
    mockClaude.regeneratePRDescription.mockResolvedValue("## Summary\nNew");

    await expect(
      regenerateAndUpdatePRBody(
        "/tmp/worktree",
        "test-org/test-repo",
        mockPR({ number: 7 }),
        "opus",
        "claude",
        "Updated with",
        "[test]",
      ),
    ).resolves.toBeUndefined();

    expect(mockGh.updatePR).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("[test]"));
  });



});
