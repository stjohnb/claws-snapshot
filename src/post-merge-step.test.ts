import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  getClawsPr: vi.fn(),
  getIssuePlannedPRs: vi.fn(),
  appendIssuePlannedPR: vi.fn(async (_id: string, entry: { repo: string; title: string }) => ({ position: 99, ...entry })),
  listPostMergeActionPrs: vi.fn(),
}));
vi.mock("./db.js", () => mockDb);

const HEADER = "*— Automated by Claws · Planner —*";
const mockGh = vi.hoisted(() => ({
  getIssueComments: vi.fn(),
  editIssueComment: vi.fn(async (..._args: unknown[]) => {}),
  isAllowedActor: vi.fn(async () => true),
  isClawsComment: vi.fn((body: string) => body.includes("*— Automated by Claws")),
  stripClawsMarker: vi.fn((body: string) => body.replace(/\*— Automated by Claws[^*]*—\*/g, "").trim()),
  getIssueState: vi.fn(async (..._args: unknown[]) => ({ state: "OPEN", stateReason: null as string | null, labels: [] as string[] })),
}));
vi.mock("./github.js", () => mockGh);

const mockClawsIssues = vi.hoisted(() => ({
  CLAWS_NATIVE_LOGIN: "claws",
  getIssue: vi.fn(),
  createIssue: vi.fn(async (..._args: unknown[]) => "clw_FOLLOWUP"),
  findOpenIssueByDedupeKey: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  primaryRepo: (issue: { repos: readonly string[] }) => [...issue.repos].sort()[0] ?? "",
}));
vi.mock("./claws-issues.js", () => mockClawsIssues);

const mockPrHold = vi.hoisted(() => ({
  issueRefForTracker: vi.fn(),
  clearPrHold: vi.fn(async (..._args: unknown[]) => true),
}));
vi.mock("./pr-hold.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pr-hold.js")>()),
  ...mockPrHold,
}));

const mockAddLink = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})));
vi.mock("./issue-links.js", () => ({ addLink: mockAddLink }));

vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import {
  CLAWS_ADDED_MARKER,
  addPostMergeBullet,
  followUpDedupeKey,
  migratePostMergeActions,
  postMergeBullet,
  recordPostMergeStep,
} from "./post-merge-step.js";
import { POST_MERGE_PREFIX } from "./hold-kind.js";
import { parsePlan, findManualActionsSection } from "./plan-parser.js";
import { parsePlanBodyHash } from "./marker-text.js";

const REPO = "org/app";
const ISSUE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
const HASH = "a".repeat(64);
const MARKERS = `CLAWS_PLAN_BODY_HASH: ${HASH}\nCLAWS_PLAN_LAST_COMMENT: clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDD`;
const ATTRIBUTION = "*Models used: opus (provider: claude)*";

function planBody(text: string): string {
  return `${HEADER}\n\n## Implementation Plan\n\n${text}\n\n${ATTRIBUTION}\n\n${MARKERS}`;
}

const SINGLE = "### What changes\nDo it in org/app.\n\n### Implementation\nChange the thing.";
const pr = (position: number, prNumber: number | null = null) =>
  ({ position, repo: REPO, title: `PR ${position}`, prNumber, dependsOn: null, kind: "pr", manualAction: null });
const manual = (position: number) =>
  ({ position, repo: REPO, title: "Manual actions (operator)", prNumber: null, dependsOn: null, kind: "manual", manualAction: null });

function arm(opts: { planned?: unknown[]; plan?: string; comments?: { body: string; login: string }[]; state?: string; issueId?: string | null } = {}): void {
  mockDb.getClawsPr.mockResolvedValue({ repo: REPO, prNumber: 7, issueId: opts.issueId === undefined ? ISSUE : opts.issueId, phase: 1 });
  mockClawsIssues.getIssue.mockResolvedValue({ id: ISSUE, state: opts.state ?? "open", kind: "issue", repos: [REPO] });
  mockPrHold.issueRefForTracker.mockResolvedValue({ repo: REPO, ref: ISSUE });
  mockDb.getIssuePlannedPRs.mockResolvedValue(opts.planned ?? [pr(1, 7)]);
  mockGh.getIssueComments.mockResolvedValue([
    { id: "clwc_PLAN", body: planBody(opts.plan ?? SINGLE), login: "claws" },
    ...(opts.comments ?? []),
  ]);
}

function editedBody(): string {
  expect(mockGh.editIssueComment).toHaveBeenCalledTimes(1);
  const [repo, id, body, opts] = mockGh.editIssueComment.mock.calls[0] as [string, string, string, Record<string, unknown>];
  expect([repo, id]).toEqual([REPO, "clwc_PLAN"]);
  expect(opts).toEqual({ agentName: "Planner", amendPlanVersion: true });
  return body;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGh.editIssueComment.mockImplementation(async () => {});
  mockDb.appendIssuePlannedPR.mockImplementation(async (_id: string, entry: { repo: string; title: string }) => ({ position: 99, ...entry }));
  mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(undefined);
});

describe("addPostMergeBullet", () => {
  it("appends a section before the attribution and keeps the markers verbatim", () => {
    const content = `## Implementation Plan\n\n${SINGLE}\n\n${ATTRIBUTION}\n\n${MARKERS}`;
    const out = addPostMergeBullet(content, postMergeBullet(REPO, 7, "Publish the DS record"));
    expect(out.endsWith(`${ATTRIBUTION}\n\n${MARKERS}`)).toBe(true);
    expect(out).toContain(`### Manual actions (operator)\n\n- After ${REPO}#7 merged: Publish the DS record ${CLAWS_ADDED_MARKER}\n\n${ATTRIBUTION}`);
    expect(parsePlanBodyHash(out)).toBe(HASH);
  });

  it("adds a bullet to an existing section, even one placed mid-plan", () => {
    const text = "### PR 1: A\na\n\n### Manual actions (operator) (after PR 1)\n- Import the repo\n\n### PR 2: B\nb";
    const out = addPostMergeBullet(`## Implementation Plan\n\n${text}\n\n${MARKERS}`, "- After x#1 merged: y");
    expect(out).toContain("- Import the repo\n- After x#1 merged: y\n\n### PR 2: B\nb");
    expect(parsePlan(out).totalPhases).toBe(2);
  });
});

describe("recordPostMergeStep", () => {
  it("is comment-only for a PR with no linked issue", async () => {
    arm({ issueId: null });
    expect(await recordPostMergeStep(REPO, 7, "Publish the DS record")).toBe("comment-only");
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("appends an operator step: plan section plus a stored manual entry, hash and markers kept", async () => {
    arm();
    expect(await recordPostMergeStep(REPO, 7, "Publish the DS record")).toBe("appended");

    const body = editedBody();
    expect(body).toContain(`- After ${REPO}#7 merged: Publish the DS record ${CLAWS_ADDED_MARKER}`);
    expect(body.endsWith(MARKERS)).toBe(true);
    expect(parsePlanBodyHash(body)).toBe(HASH);
    expect(findManualActionsSection(body)?.body).toContain("Publish the DS record");
    // The single-PR plan stays one PR section: the step is not a `### PR N:`.
    expect(parsePlan(body).totalPhases).toBe(1);
    expect(mockDb.appendIssuePlannedPR).toHaveBeenCalledWith(ISSUE, { repo: REPO, title: "Manual actions (operator)" });
  });

  it("adds a second note as a second bullet of the Claws-added step", async () => {
    const plan = `${SINGLE}\n\n### Manual actions (operator)\n\n${postMergeBullet("org/other", 3, "Rotate the token")}`;
    arm({ plan, planned: [pr(1, 7), pr(2, 3), manual(3)] });
    mockDb.getClawsPr.mockResolvedValue({ repo: REPO, prNumber: 7, issueId: ISSUE, phase: 1 });

    expect(await recordPostMergeStep(REPO, 7, "Publish the DS record")).toBe("merged-into-step");

    const body = editedBody();
    expect(body).toContain(`- After org/other#3 merged: Rotate the token ${CLAWS_ADDED_MARKER}\n- After ${REPO}#7 merged: Publish the DS record ${CLAWS_ADDED_MARKER}`);
    expect(mockDb.appendIssuePlannedPR).not.toHaveBeenCalled();
  });

  it("is a duplicate of a later unclaimed operator step the Planner wrote", async () => {
    arm({ plan: `${SINGLE}\n\n### Manual actions (operator)\n- Publish the DS record`, planned: [pr(1, 7), manual(2)] });
    expect(await recordPostMergeStep(REPO, 7, "Publish the DS record")).toBe("duplicate");
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
  });

  it("is a duplicate of a later PR step in a repo the note names", async () => {
    arm({ planned: [pr(1, 7), { ...pr(2), repo: "org/production-infra" }] });
    expect(await recordPostMergeStep(REPO, 7, "Set the value in production-infra")).toBe("duplicate");
  });

  it("is a duplicate when the plan already carries this PR's note", async () => {
    const plan = `${SINGLE}\n\n### Manual actions (operator)\n\n${postMergeBullet(REPO, 7, "Publish the DS record")}`;
    arm({ plan, planned: [pr(1, 7), manual(2)] });
    expect(await recordPostMergeStep(REPO, 7, "Publish the DS record")).toBe("duplicate");
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
  });

  it("files a Blocked follow-up issue when the operator step is already claimed done", async () => {
    const plan = `${SINGLE}\n\n### Manual actions (operator)\n\n${postMergeBullet("org/other", 3, "Rotate the token")}`;
    arm({ plan, planned: [pr(1, 7), manual(2)], comments: [{ body: "claws-phase-done: 2", login: "owner" }] });

    expect(await recordPostMergeStep(REPO, 7, "Publish the DS record. Then check it.")).toBe("follow-up-issue");

    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
    expect(mockClawsIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({
      title: `Operator step after ${REPO}#7 merged: Publish the DS record.`,
      labels: ["Blocked"],
      blockedReason: "Publish the DS record. Then check it.",
      repos: [REPO],
      dedupeKey: "post-merge-action-org-app-7",
    }));
    expect(mockAddLink).toHaveBeenCalledWith(REPO, "clw_FOLLOWUP", "relates_to", ISSUE, "claws");
  });

  it("files a follow-up issue when the linked issue is closed or has no stored step list", async () => {
    arm({ state: "closed" });
    expect(await recordPostMergeStep(REPO, 7, "Publish the DS record")).toBe("follow-up-issue");
    arm({ planned: [] });
    expect(await recordPostMergeStep(REPO, 7, "Publish the DS record")).toBe("follow-up-issue");
    expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(2);
  });

  it("files a follow-up issue when a shadow issue's record says open but the forge has closed it", async () => {
    arm();
    mockClawsIssues.getIssue.mockResolvedValue({ id: ISSUE, state: "open", kind: "shadow", repos: [REPO] });
    mockPrHold.issueRefForTracker.mockResolvedValue({ repo: REPO, ref: 42 });
    mockGh.getIssueState.mockResolvedValueOnce({ state: "CLOSED", stateReason: "completed", labels: [] });

    expect(await recordPostMergeStep(REPO, 7, "Publish the DS record")).toBe("follow-up-issue");
    expect(mockGh.getIssueState).toHaveBeenCalledWith(REPO, 42);
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
    expect(mockDb.appendIssuePlannedPR).not.toHaveBeenCalled();
    expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
  });

  it("appends the missing stored step when an earlier run put the bullet on the plan but failed to append", async () => {
    const plan = `${SINGLE}\n\n### Manual actions (operator)\n\n${postMergeBullet(REPO, 7, "Publish the DS record")}`;
    arm({ plan, planned: [pr(1, 7)] });
    expect(await recordPostMergeStep(REPO, 7, "Publish the DS record")).toBe("appended");
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
    expect(mockDb.appendIssuePlannedPR).toHaveBeenCalledWith(ISSUE, { repo: REPO, title: "Manual actions (operator)" });
  });

  it("does not file a second follow-up issue for the same PR", async () => {
    arm({ state: "closed" });
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_EXISTING" });
    expect(await recordPostMergeStep(REPO, 7, "Publish the DS record")).toBe("follow-up-issue");
    expect(mockClawsIssues.findOpenIssueByDedupeKey).toHaveBeenCalledWith(REPO, followUpDedupeKey(REPO, 7));
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });
});

describe("migratePostMergeActions", () => {
  const row = (prNumber: number, issueId: string | null) =>
    ({ repo: REPO, prNumber, issueId, phase: 1, manualActionReason: `${POST_MERGE_PREFIX} Publish the DS record` });

  it("converts a row with an open issue and clears it", async () => {
    arm();
    mockDb.listPostMergeActionPrs.mockResolvedValue([row(7, ISSUE)]);

    expect(await migratePostMergeActions()).toMatchObject({ candidates: 1, converted: 1, cleared: 1, failed: 0 });
    expect(editedBody()).toContain("Publish the DS record");
    expect(mockPrHold.clearPrHold).toHaveBeenCalledWith(REPO, 7, POST_MERGE_PREFIX);
  });

  it("converts two rows for one issue in turn: one stored operator step, two bullets", async () => {
    // A stateful fake of the plan comment and stored step list, with reads
    // that yield so unserialised conversions would interleave.
    const tick = () => new Promise((r) => setTimeout(r, 1));
    let body = planBody(SINGLE);
    const planned: unknown[] = [pr(1, 7), pr(2, 8)];
    mockClawsIssues.getIssue.mockResolvedValue({ id: ISSUE, state: "open", kind: "issue", repos: [REPO] });
    mockPrHold.issueRefForTracker.mockResolvedValue({ repo: REPO, ref: ISSUE });
    mockDb.getClawsPr.mockImplementation(async (_repo: string, n: number) => ({ repo: REPO, prNumber: n, issueId: ISSUE, phase: n - 6 }));
    mockDb.getIssuePlannedPRs.mockImplementation(async () => { await tick(); return [...planned]; });
    mockGh.getIssueComments.mockImplementation(async () => { await tick(); return [{ id: "clwc_PLAN", body, login: "claws" }]; });
    mockGh.editIssueComment.mockImplementation(async (...args: unknown[]) => { await tick(); body = `${HEADER}\n\n${args[2] as string}`; });
    mockDb.appendIssuePlannedPR.mockImplementation(async (_id: string, entry: { repo: string; title: string }) => {
      await tick();
      const e = { ...manual(planned.length + 1), ...entry };
      planned.push(e);
      return e;
    });
    mockDb.listPostMergeActionPrs.mockResolvedValue([row(7, ISSUE), { ...row(8, ISSUE), manualActionReason: `${POST_MERGE_PREFIX} Rotate the token` }]);

    expect(await migratePostMergeActions()).toMatchObject({ candidates: 2, converted: 2, cleared: 2, failed: 0 });
    expect(planned.filter((e) => (e as { kind: string }).kind === "manual")).toHaveLength(1);
    expect(body).toContain(`- After ${REPO}#7 merged: Publish the DS record`);
    expect(body).toContain(`- After ${REPO}#8 merged: Rotate the token`);
  });

  it("serialises concurrent recordPostMergeStep calls for one issue", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 1));
    let body = planBody(SINGLE);
    const planned: unknown[] = [pr(1, 7), { ...pr(2, 3), repo: "org/other" }];
    mockClawsIssues.getIssue.mockResolvedValue({ id: ISSUE, state: "open", kind: "issue", repos: [REPO] });
    mockPrHold.issueRefForTracker.mockResolvedValue({ repo: REPO, ref: ISSUE });
    mockDb.getClawsPr.mockImplementation(async (repo: string, n: number) => ({ repo, prNumber: n, issueId: ISSUE, phase: repo === REPO ? 1 : 2 }));
    mockDb.getIssuePlannedPRs.mockImplementation(async () => { await tick(); return [...planned]; });
    mockGh.getIssueComments.mockImplementation(async () => { await tick(); return [{ id: "clwc_PLAN", body, login: "claws" }]; });
    mockGh.editIssueComment.mockImplementation(async (...args: unknown[]) => { await tick(); body = `${HEADER}\n\n${args[2] as string}`; });
    mockDb.appendIssuePlannedPR.mockImplementation(async (_id: string, entry: { repo: string; title: string }) => {
      await tick();
      const e = { ...manual(planned.length + 1), ...entry };
      planned.push(e);
      return e;
    });

    const outcomes = await Promise.all([
      recordPostMergeStep(REPO, 7, "Publish the DS record"),
      recordPostMergeStep("org/other", 3, "Rotate the token"),
    ]);
    expect(outcomes).toEqual(["appended", "merged-into-step"]);
    expect(planned.filter((e) => (e as { kind: string }).kind === "manual")).toHaveLength(1);
    expect(body).toContain("Publish the DS record");
    expect(body).toContain("Rotate the token");
  });

  it("clears a row whose issue is closed, or that has none, without converting it", async () => {
    mockClawsIssues.getIssue.mockResolvedValue({ id: ISSUE, state: "closed", kind: "issue", repos: [REPO] });
    mockDb.listPostMergeActionPrs.mockResolvedValue([row(7, ISSUE), row(8, null)]);

    expect(await migratePostMergeActions()).toMatchObject({ candidates: 2, converted: 0, cleared: 2, failed: 0 });
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("keeps a row whose conversion fails, and never throws", async () => {
    arm();
    mockGh.getIssueComments.mockRejectedValue(new Error("forge down"));
    mockDb.listPostMergeActionPrs.mockResolvedValue([row(7, ISSUE)]);

    expect(await migratePostMergeActions()).toMatchObject({ converted: 0, cleared: 0, failed: 1 });
    expect(mockPrHold.clearPrHold).not.toHaveBeenCalled();

    mockDb.listPostMergeActionPrs.mockRejectedValue(new Error("db down"));
    expect(await migratePostMergeActions()).toMatchObject({ failed: 1 });
  });
});
