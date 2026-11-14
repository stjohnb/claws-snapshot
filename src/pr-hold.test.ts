import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockGh, mockHandback, mockClawsIssues, rows } = vi.hoisted(() => {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    mockDb: {
      getClawsPr: vi.fn(async (repo: string, n: number) => rows.get(`${repo}#${n}`) ?? undefined),
      upsertClawsPr: vi.fn(async (repo: string, n: number, patch: Record<string, unknown>) => {
        rows.set(`${repo}#${n}`, { ...(rows.get(`${repo}#${n}`) ?? {}), ...patch });
      }),
      getClawsIssue: vi.fn(),
      getIssuePlannedPRs: vi.fn(),
      getImportedIssueByNative: vi.fn(),
    },
    mockGh: {
      getIssueState: vi.fn(),
      getIssueComments: vi.fn(),
      commentOnIssue: vi.fn(async (..._args: unknown[]) => undefined),
      addLabel: vi.fn(async () => undefined),
    },
    mockHandback: { parkForHuman: vi.fn(async () => undefined) },
    mockClawsIssues: {
      getIssue: vi.fn(),
      primaryRepo: (issue: { repos: readonly string[] }) => [...issue.repos].sort()[0] ?? "",
    },
  };
});

vi.mock("./config.js", () => ({
  LABELS: { blocked: "Blocked" },
  isClawsIssueId: (ref: unknown) => typeof ref === "string" && /^clw_/i.test(ref),
}));
vi.mock("./db.js", () => mockDb);
vi.mock("./github.js", () => mockGh);
vi.mock("./claws-issues.js", () => mockClawsIssues);
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./issue-handback.js", async (importActual) => ({
  ...(await importActual<typeof import("./issue-handback.js")>()),
  parkForHuman: mockHandback.parkForHuman,
}));

import type { ClawsPrRecord } from "./db.js";
import {
  CI_RERUN_REFUSED_PREFIX,
  ESCALATION_REASON_PREFIX,
  POST_MERGE_PREFIX,
  REAPPROVAL_HOLD_PREFIX,
  STACKED_PREFIX,
  blockLinkedIssue,
  clearPrHold,
  holdForReapproval,
  isOperatorStepHold,
  isPostMergeAction,
  postMergeNoteDuplicatesPlan,
  postMergeActionResolution,
  operatorStepSlug,
  recordPostMergeAction,
  recordPrHold,
  releaseReapprovalHold,
  resetOperatorStepNotices,
  settleOperatorStepHold,
} from "./pr-hold.js";
import { needsHumanMarker } from "./issue-handback.js";

const REPO = "org/app";
const STEP = "Set the prod secret";
const HEAD = "abc123";

function readyRow(fields: Partial<ClawsPrRecord> = {}): ClawsPrRecord {
  return {
    repo: REPO, prNumber: 7, issueId: "clw_ISSUE", phase: 1, headSha: HEAD, observedAt: null,
    stage: "awaiting-merge", ciStatus: "passing", mergeableState: null, reviewVerdict: "clean", reviewedSha: HEAD,
    mergeApprovedBy: null, mergeApprovedAt: null, manualActionReason: STEP, needsHumanReview: false,
    ciBlockedReason: null, infraMergeApprovedBy: null, infraMergeApprovedAt: null, infraMergeApprovedSha: null, title: null, dispatchNote: null, dispatchNoteAt: null, createdAt: "", updatedAt: "",
    ...fields,
  };
}

const pr = { number: 7, headRefName: "claws/issue-clw_ISSUE-abcd", headRefOid: HEAD };

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  resetOperatorStepNotices();
  mockDb.getClawsIssue.mockResolvedValue({ kind: "native", repos: ["org/app"] });
  mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Refined"] });
  mockGh.getIssueComments.mockResolvedValue([]);
});

describe("hold kinds", () => {
  it("treats a reason with none of the self-clearing prefixes as an operator step", () => {
    expect(isOperatorStepHold(STEP)).toBe(true);
    expect(isOperatorStepHold("manual action")).toBe(true);
    for (const prefix of [REAPPROVAL_HOLD_PREFIX, ESCALATION_REASON_PREFIX, STACKED_PREFIX, CI_RERUN_REFUSED_PREFIX]) {
      expect(isOperatorStepHold(`${prefix} x`)).toBe(false);
    }
    expect(isOperatorStepHold(null)).toBe(false);
  });

  it("records a hold with no stage, and never overwrites a different kind", async () => {
    expect(await recordPrHold(REPO, 7, STEP)).toBe(true);
    expect(mockDb.upsertClawsPr).toHaveBeenCalledWith(REPO, 7, { manualActionReason: STEP });
    expect(await recordPrHold(REPO, 7, `${STACKED_PREFIX} targets x`)).toBe(false);
    expect(rows.get(`${REPO}#7`)?.manualActionReason).toBe(STEP);
    // The same kind is replaced.
    expect(await recordPrHold(REPO, 7, "Import the repo")).toBe(true);
    expect(rows.get(`${REPO}#7`)?.manualActionReason).toBe("Import the repo");
  });

  it("clears only its own prefix", async () => {
    rows.set(`${REPO}#7`, { manualActionReason: STEP });
    expect(await clearPrHold(REPO, 7, CI_RERUN_REFUSED_PREFIX)).toBe(false);
    expect(rows.get(`${REPO}#7`)?.manualActionReason).toBe(STEP);
    expect(await clearPrHold(REPO, 7)).toBe(true);
    expect(rows.get(`${REPO}#7`)?.manualActionReason).toBeNull();
    expect(await clearPrHold(REPO, 7)).toBe(false);
  });

  it("holds and releases a re-approval hold without touching an operator step", async () => {
    expect(await holdForReapproval(REPO, 7, "a design change", "org/app#1")).toBe(true);
    expect(await releaseReapprovalHold(REPO, 7)).toBe(true);
    rows.set(`${REPO}#7`, { manualActionReason: STEP });
    expect(await holdForReapproval(REPO, 7, "a design change", "org/app#1")).toBe(false);
    expect(await releaseReapprovalHold(REPO, 7)).toBe(false);
    expect(rows.get(`${REPO}#7`)?.manualActionReason).toBe(STEP);
  });
});

describe("post-merge manual actions", () => {
  it("is its own kind, never an operator step", () => {
    const reason = `${POST_MERGE_PREFIX} Publish the DS record`;
    expect(isPostMergeAction(reason)).toBe(true);
    expect(isOperatorStepHold(reason)).toBe(false);
    expect(isPostMergeAction(STEP)).toBe(false);
    expect(isPostMergeAction(null)).toBe(false);
  });

  it("records over any reason already on the row", async () => {
    rows.set(`${REPO}#7`, { manualActionReason: `${STACKED_PREFIX} targets x` });
    await recordPostMergeAction(REPO, 7, "Publish the DS record");
    expect(rows.get(`${REPO}#7`)?.manualActionReason).toBe(`${POST_MERGE_PREFIX} Publish the DS record`);
    expect(rows.get(`${REPO}#7`)?.stage).toBe("merged");
    // A later operator-step hold does not overwrite it.
    expect(await recordPrHold(REPO, 7, STEP)).toBe(false);
  });

  it("is lifted by clearPrHold", async () => {
    await recordPostMergeAction(REPO, 7, "Publish the DS record");
    expect(await clearPrHold(REPO, 7)).toBe(true);
    expect(rows.get(`${REPO}#7`)?.manualActionReason).toBeNull();
  });
});

describe("blockLinkedIssue", () => {
  it("parks a native issue in its primary repo", async () => {
    rows.set(`${REPO}#7`, { issueId: "clw_ISSUE" });
    mockDb.getClawsIssue.mockResolvedValue({ kind: "native", repos: ["org/zed", "org/app"] });
    expect(await blockLinkedIssue(REPO, 7, "why", "slug-1")).toBe(true);
    expect(mockHandback.parkForHuman).toHaveBeenCalledWith("org/app", "clw_ISSUE", "why", "PR Dispatcher", { slug: "slug-1" });
  });

  it("parks a shadow's forge issue", async () => {
    rows.set(`${REPO}#7`, { issueId: "clw_SHADOW" });
    mockDb.getClawsIssue.mockResolvedValue({ kind: "shadow", repos: [REPO] });
    mockDb.getImportedIssueByNative.mockResolvedValue({ repo: REPO, forgeNumber: 42 });
    expect(await blockLinkedIssue(REPO, 7, "why", "slug-1")).toBe(true);
    expect(mockHandback.parkForHuman).toHaveBeenCalledWith(REPO, 42, "why", "PR Dispatcher", { slug: "slug-1" });
  });

  it("falls back to the PR branch for a forge issue", async () => {
    expect(await blockLinkedIssue(REPO, 7, "why", "slug-1", { headRefName: "claws/issue-12-fix" })).toBe(true);
    expect(mockHandback.parkForHuman).toHaveBeenCalledWith(REPO, 12, "why", "PR Dispatcher", { slug: "slug-1" });
  });

  it("returns false for a PR with no linked issue", async () => {
    expect(await blockLinkedIssue(REPO, 7, "why", "slug-1", { headRefName: "renovate/x" })).toBe(false);
    expect(mockHandback.parkForHuman).not.toHaveBeenCalled();
  });
});

describe("settleOperatorStepHold", () => {
  const SLUG = operatorStepSlug(7, STEP);

  it("posts nothing while the PR is not ready to merge", async () => {
    await settleOperatorStepHold(REPO, pr, readyRow({ stage: "awaiting-review" }));
    await settleOperatorStepHold(REPO, pr, readyRow({ ciStatus: "failing" }));
    await settleOperatorStepHold(REPO, pr, readyRow({ reviewedSha: "old" }));
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.getIssueState).not.toHaveBeenCalled();
  });

  it("does nothing for a self-clearing hold", async () => {
    await settleOperatorStepHold(REPO, pr, readyRow({ manualActionReason: `${ESCALATION_REASON_PREFIX}x` }));
    expect(mockGh.getIssueState).not.toHaveBeenCalled();
  });

  it("tells the issue once, naming the PR and step, and never parks it (#clw_01M5220Y7EWQG1X0H3Y3T45J81)", async () => {
    await settleOperatorStepHold(REPO, pr, readyRow());
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      REPO, "clw_ISSUE", expect.stringContaining(STEP), { agentName: "PR Dispatcher" },
    );
    const body = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(body).toContain("## Waiting on an operator step");
    expect(body).toContain(`${REPO}#7`);
    expect(body).toContain("(step 1)");
    expect(body).toContain(needsHumanMarker(SLUG));
    expect(mockHandback.parkForHuman).not.toHaveBeenCalled();
    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(rows.get(`${REPO}#7`)).toBeUndefined();
  });

  it("posts nothing more on a later tick, or in a fresh process that finds the marker", async () => {
    await settleOperatorStepHold(REPO, pr, readyRow());
    vi.clearAllMocks();
    await settleOperatorStepHold(REPO, pr, readyRow());
    expect(mockGh.getIssueComments).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();

    resetOperatorStepNotices();
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Refined"] });
    mockGh.getIssueComments.mockResolvedValue([{ body: `## Waiting on an operator step\n\n${needsHumanMarker(SLUG)}` }]);
    await settleOperatorStepHold(REPO, pr, readyRow());
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("tells the issue once for each of two held PRs and never parks it", async () => {
    const pr8 = { ...pr, number: 8 };
    for (let tick = 0; tick < 2; tick++) {
      await settleOperatorStepHold(REPO, pr, readyRow());
      await settleOperatorStepHold(REPO, pr8, readyRow({ prNumber: 8, phase: 2, manualActionReason: "Cut over DNS" }));
    }
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(2);
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(REPO, "clw_ISSUE", expect.stringContaining(STEP), { agentName: "PR Dispatcher" });
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(REPO, "clw_ISSUE", expect.stringContaining("Cut over DNS"), { agentName: "PR Dispatcher" });
    expect(mockHandback.parkForHuman).not.toHaveBeenCalled();
    expect(mockGh.addLabel).not.toHaveBeenCalled();
  });

  it("keeps the hold when the issue is out of Blocked with the marker present", async () => {
    rows.set(`${REPO}#7`, { manualActionReason: STEP });
    mockGh.getIssueComments.mockResolvedValue([{ body: `## Needs a human\n\n${needsHumanMarker(SLUG)}` }]);
    await settleOperatorStepHold(REPO, pr, readyRow());
    expect(rows.get(`${REPO}#7`)?.manualActionReason).toBe(STEP);
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockDb.upsertClawsPr).not.toHaveBeenCalled();
  });

  it("tells the issue again for a different step on the same PR", async () => {
    mockGh.getIssueComments.mockResolvedValue([{ body: needsHumanMarker(SLUG) }]);
    await settleOperatorStepHold(REPO, pr, readyRow({ manualActionReason: "Import the repo" }));
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      REPO, "clw_ISSUE", expect.stringContaining(needsHumanMarker(operatorStepSlug(7, "Import the repo"))), { agentName: "PR Dispatcher" },
    );
    expect(operatorStepSlug(7, "Import the repo")).not.toBe(SLUG);
  });

  it("does nothing for a closed issue", async () => {
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "completed", labels: [] });
    await settleOperatorStepHold(REPO, pr, readyRow());
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockHandback.parkForHuman).not.toHaveBeenCalled();
  });
});

describe("postMergeNoteDuplicatesPlan", () => {
  const step = (position: number, repo: string, over: Record<string, unknown> = {}) =>
    ({ position, repo, title: `s${position}`, prNumber: null, dependsOn: null, kind: "pr", manualAction: null, ...over }) as never;

  it("matches a later PR step in a repo the note names", () => {
    const planned = [step(2, "org/claws", { prNumber: 373 }), step(3, "org/production-infra")];
    expect(postMergeNoteDuplicatesPlan("Set alertBridge.poll in production-infra's claws.json", "org/claws", 373, null, planned))
      .toMatchObject({ position: 3, kind: "pr" });
  });

  it("matches a short repo name case-insensitively and a full name", () => {
    const planned = [step(1, "org/nixos-config", { prNumber: 155 }), step(2, "org/home-assistant-config")];
    expect(postMergeNoteDuplicatesPlan("Merge the matching Home-Assistant-Config change", "org/nixos-config", 155, null, planned)).not.toBeNull();
    expect(postMergeNoteDuplicatesPlan("see org/home-assistant-config", "org/nixos-config", 155, null, planned)).not.toBeNull();
  });

  it("matches any later operator step, but not an earlier one", () => {
    const planned = [step(1, "org/a", { prNumber: 5 }), step(2, "org/a", { kind: "manual" })];
    expect(postMergeNoteDuplicatesPlan("do a thing", "org/a", 5, null, planned)).toMatchObject({ kind: "manual" });
    const before = [step(1, "org/a", { kind: "manual" }), step(2, "org/a", { prNumber: 5 })];
    expect(postMergeNoteDuplicatesPlan("do a thing", "org/a", 5, null, before)).toBeNull();
  });

  it("does not match with no later step, an unnamed repo, or its own repo", () => {
    const planned = [step(1, "org/a", { prNumber: 5 }), step(2, "org/b")];
    expect(postMergeNoteDuplicatesPlan("rerun in this repo", "org/a", 5, null, planned)).toBeNull();
    expect(postMergeNoteDuplicatesPlan("x", "org/b", 99, 2, [step(1, "org/a"), step(2, "org/b")])).toBeNull();
  });
});

describe("postMergeActionResolution", () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({ repo: "org/a", prNumber: 5, issueId: "clw_X", phase: 1, manualActionReason: `${POST_MERGE_PREFIX} do a thing`, ...over }) as never;

  beforeEach(() => { mockDb.getIssuePlannedPRs.mockReset(); mockClawsIssues.getIssue.mockReset(); });

  it("is null without an issue", async () => {
    expect(await postMergeActionResolution(row({ issueId: null }))).toBeNull();
  });

  it("reports a closed issue", async () => {
    mockClawsIssues.getIssue.mockResolvedValue({ state: "closed" });
    expect(await postMergeActionResolution(row())).toBe("issue-closed");
  });

  it("keeps an open issue with no later step", async () => {
    mockClawsIssues.getIssue.mockResolvedValue({ state: "open" });
    mockDb.getIssuePlannedPRs.mockResolvedValue([{ position: 1, repo: "org/a", title: "t", prNumber: 5, dependsOn: null, kind: "pr", manualAction: null }]);
    expect(await postMergeActionResolution(row())).toBeNull();
  });
});
