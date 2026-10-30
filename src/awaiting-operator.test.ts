import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const { mockGh, mockDb, mockClawsIssues } = vi.hoisted(() => ({
  mockGh: {
    isClawsComment: (body: string) => /\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/.test(body),
    isAllowedActor: vi.fn(async () => true),
    getIssueComments: vi.fn(async (): Promise<unknown[]> => []),
    getPRState: vi.fn(),
  },
  mockDb: {
    getIssueIdsAwaitingOperator: vi.fn(async (_ids: readonly string[]) => new Map<string, { position: number; title: string }>()),
    getIssuePlannedPRs: vi.fn(),
  },
  mockClawsIssues: { getIssue: vi.fn(), primaryRepo: (issue: { repos: readonly string[] }) => [...issue.repos].sort()[0] ?? "" },
}));
vi.mock("./github.js", () => mockGh);
vi.mock("./db.js", () => mockDb);
vi.mock("./claws-issues.js", () => mockClawsIssues);

import { issuesAwaitingOperator } from "./awaiting-operator.js";

const REPO = "test-org/test-repo";
const ID = "clw_01M4ZN75K7GK0G7AFZEHBNCWD5";
const step = { position: 2, title: "Manual actions (operator)" };
const pr = (position: number) => ({ position, repo: REPO, title: `Step ${position}`, prNumber: 40 + position, dependsOn: null, kind: "pr" as const, manualAction: null });
const manual = (position: number, title: string) => ({ position, repo: REPO, title, prNumber: null, dependsOn: null, kind: "manual" as const, manualAction: null });

describe("issuesAwaitingOperator (#clw_01M4ZN75K7GK0G7AFZEHBNCWD5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getIssueIdsAwaitingOperator.mockResolvedValue(new Map([[ID, step]]));
    mockClawsIssues.getIssue.mockResolvedValue({ id: ID, repos: [REPO] });
    mockDb.getIssuePlannedPRs.mockResolvedValue([pr(1), manual(2, step.title)]);
    mockGh.getIssueComments.mockResolvedValue([]);
  });

  it("keeps an issue whose manual step is still open, without reading PR state", async () => {
    expect(await issuesAwaitingOperator([ID])).toEqual(new Map([[ID, step]]));
    expect(mockGh.getIssueComments).toHaveBeenCalledWith(REPO, ID);
    expect(mockGh.getPRState).not.toHaveBeenCalled();
  });

  it("drops an issue whose manual step is claimed done", async () => {
    mockGh.getIssueComments.mockResolvedValue([{ body: "claws-phase-done: 2", login: "stjohnb" }]);
    expect(await issuesAwaitingOperator([ID])).toEqual(new Map());
  });

  it("keeps an issue on its lowest unclaimed manual step when only the first is claimed", async () => {
    mockDb.getIssuePlannedPRs.mockResolvedValue([pr(1), manual(2, "Import data"), manual(3, "Archive source")]);
    mockGh.getIssueComments.mockResolvedValue([{ body: "claws-phase-done: 2", login: "stjohnb" }]);
    expect(await issuesAwaitingOperator([ID])).toEqual(new Map([[ID, { position: 3, title: "Archive source" }]]));
  });

  it("keeps a candidate whose read fails", async () => {
    mockGh.getIssueComments.mockRejectedValue(new Error("forge down"));
    expect(await issuesAwaitingOperator([ID])).toEqual(new Map([[ID, step]]));
  });

  it("reads nothing further when the SQL returns no candidates", async () => {
    mockDb.getIssueIdsAwaitingOperator.mockResolvedValue(new Map());
    expect(await issuesAwaitingOperator([ID])).toEqual(new Map());
    expect(mockGh.getIssueComments).not.toHaveBeenCalled();
  });
});
