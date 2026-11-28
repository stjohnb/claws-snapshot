import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./log.js", () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));

const db = vi.hoisted(() => ({
  getIssueIdsAwaitingOperator: vi.fn(async (_ids: readonly string[]) => new Map<string, { position: number; title: string }>()),
  listPendingReapprovalIssueIds: vi.fn(async (_ids?: readonly string[]) => new Set<string>()),
  listOpenClawsPrs: vi.fn(async () => [] as any[]),
  listPostMergeActionPrs: vi.fn(async () => [] as any[]),
  listCiFixerGiveUpHeads: vi.fn(async (_rows: readonly any[]) => new Set<string>()),
}));
vi.mock("./db.js", () => db);

const github = vi.hoisted(() => ({
  listRepos: vi.fn(async () => [{ owner: "org", name: "repo", fullName: "org/repo" }]),
  listOpenIssues: vi.fn(async (_repo: string) => [] as any[]),
  isNativeIssue: (ref: unknown) => typeof ref === "string",
  awaitingImportReason: vi.fn((_repo: string, _item: { number: unknown }) => null as string | null),
}));
vi.mock("./github.js", () => github);

const clawsIssues = vi.hoisted(() => ({
  getOpenShadowStages: vi.fn(async () => new Map<string, { id: string; lifecycle: string; hasPlannedPrs: boolean }>()),
  getLatestRequirementsForOpenIssues: vi.fn(async () => new Map<string, any>()),
  getHeldWithoutWriterOpenIssueIds: vi.fn(async () => new Set<string>()),
  getRequirementsFeedbackPending: vi.fn(async (_latest: Map<string, any>) => new Set<string>()),
  listUnassignedOpenIssues: vi.fn(async () => [] as any[]),
}));
vi.mock("./claws-issues.js", () => clawsIssues);

const flight = vi.hoisted(() => ({
  flightKey: (repo: string, ref: unknown) => `${repo}\u0000${ref}`,
  loadBoardFlights: vi.fn(async (_cards: unknown[]) => new Map<string, { implementing: boolean; openPrs: any[] }>()),
}));
vi.mock("./issue-flight.js", () => flight);

const planned = vi.hoisted(() => ({
  manualWarningRow: (row: any) => row,
  loadManualActionWarnings: vi.fn(async (rows: readonly any[]) => new Map(rows.filter((r) => r.manualActionReason || r.issueId === "clw_OPSTEP").map((r) => [`${r.repo}#${r.prNumber}`, "Manual action before merge"]))),
}));
vi.mock("./planned-prs.js", () => planned);
// The claims filter is covered in awaiting-operator.test.ts; here it passes the SQL candidates through.
const sessionBackend = vi.hoisted(() => ({ listLive: vi.fn(async () => [] as Array<{ alive: boolean }>) }));
vi.mock("./session-backend.js", () => ({ getSessionBackend: () => sessionBackend }));
vi.mock("./awaiting-operator.js", () => ({ issuesAwaitingOperator: (ids: readonly string[]) => db.getIssueIdsAwaitingOperator(ids) }));
const queued = vi.hoisted(() => ({ issuesQueued: vi.fn(async (_ids: readonly string[]) => new Map<string, string>()) }));
vi.mock("./queued-issues.js", () => queued);

import { loadPrsOverview } from "./prs-overview.js";
import { clearNavCountsCache, loadOperatorAttentionCounts } from "./operator-attention.js";

const row = (over: Record<string, unknown>) => ({
  repo: "org/repo", prNumber: 1, issueId: "clw_A", headSha: "h", stage: "awaiting-merge", ciStatus: "passing", reviewVerdict: "clean",
  mergeApprovedBy: null, mergeApprovedAt: null, manualActionReason: null, title: "T", mergeSkipCode: null, mergeSkipReason: null, mergeSkipHead: null,
  updatedAt: "2026-01-01T00:00:00Z", ...over,
});

describe("loadPrsOverview", () => {
  beforeEach(() => {
    clearNavCountsCache();
    db.listOpenClawsPrs.mockResolvedValue([row({}), row({ prNumber: 2, manualActionReason: "Stacked PR: base" })]);
    db.listPostMergeActionPrs.mockResolvedValue([
      row({ prNumber: 3, stage: "merged", manualActionReason: "Manual action after merge: set secret" }),
      row({ repo: "gone/repo", prNumber: 4, stage: "merged", manualActionReason: "Manual action after merge: x" }),
    ]);
  });

  it("returns holds and counts equal to the nav count, ignoring merged rows", async () => {
    const o = (await loadPrsOverview())!;
    expect(o.open_prs).toHaveLength(2);
    expect(o.open_prs[1]).toMatchObject({ number: 2, hold_kind: "stacked", manual_action_reason: "Stacked PR: base" });
    expect(o).not.toHaveProperty("post_merge_actions");
    expect(o.counts).not.toHaveProperty("post_merge_actions");
    const nav = await loadOperatorAttentionCounts();
    expect(nav?.prs?.total).toBe(o.counts.open_prs);
    expect(nav?.prs?.attention).toBe(o.counts.needs_you);
  });

  it("filters by repo case-insensitively and returns null for an unknown repo", async () => {
    expect((await loadPrsOverview("ORG/Repo"))!.open_prs).toHaveLength(2);
    expect(await loadPrsOverview("x/y")).toBeNull();
  });
});
