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

import { firstSentenceOfStep, issuesAwaitingOperator, operatorStepReadyLine } from "./awaiting-operator.js";

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

describe("operatorStepReadyLine (#clw_01M6GWYR04FZRE5AK80P8TW02C)", () => {
  // The fleet-infra case: the plan's generic manual-actions heading, a numbered body.
  const FLEET_BODY = [
    "1. Publish the wall dashboards to the **kiosk** folder in Grafana. They read the new `wall` datasource.",
    "2. Point each kiosk at its dashboard URL.",
  ].join("\n");

  it("leads with the step's first sentence and leaves out the generic heading", () => {
    expect(operatorStepReadyLine(3, "Manual actions (operator)", FLEET_BODY))
      .toBe("Operator step 3 is ready: Publish the wall dashboards to the kiosk folder in Grafana.");
  });

  it("names a specific step title in parentheses", () => {
    expect(operatorStepReadyLine(2, "Rotate the registry token", "- Rotate the token in Vault."))
      .toBe("Operator step 2 is ready (Rotate the registry token): Rotate the token in Vault.");
  });

  it("treats every generic heading variant as no title", () => {
    for (const title of ["Manual action", "manual steps", "Manual cutover (operator)", "Manual step"]) {
      expect(operatorStepReadyLine(1, title, "Do it.")).toBe("Operator step 1 is ready: Do it.");
    }
  });

  it("is just the step number with no section text", () => {
    expect(operatorStepReadyLine(4, "Manual actions (operator)", null)).toBe("Operator step 4 is ready.");
    expect(operatorStepReadyLine(4, undefined, "  \n")).toBe("Operator step 4 is ready.");
  });
});

describe("firstSentenceOfStep", () => {
  it("flattens list markers, links and code", () => {
    expect(firstSentenceOfStep("- [ ] Import [the repo](https://x.invalid) with `forgejo import`. Then wait."))
      .toBe("Import the repo with forgejo import.");
  });

  it("keeps underscores inside an unticked identifier", () => {
    expect(firstSentenceOfStep("Set FOO_BAR_BAZ in prod.")).toBe("Set FOO_BAR_BAZ in prod.");
    expect(firstSentenceOfStep("Set _it_ now.")).toBe("Set it now.");
  });

  it("does not cut inside a dotted name", () => {
    expect(firstSentenceOfStep("Set FOO in config.json for prod! Then restart.")).toBe("Set FOO in config.json for prod!");
  });

  it("caps a long sentence at 160 characters", () => {
    const out = firstSentenceOfStep(`Do ${"x".repeat(300)}`)!;
    expect(out).toHaveLength(160);
    expect(out.endsWith("…")).toBe(true);
  });

  it("keeps a body with no sentence end whole", () => {
    expect(firstSentenceOfStep("Import the repo on Forgejo")).toBe("Import the repo on Forgejo");
  });
});
