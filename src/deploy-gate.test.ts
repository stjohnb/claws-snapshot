import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGh, mockForgejo, mockPlanned, configs } = vi.hoisted(() => ({
  configs: new Map<string, { deployWorkflows: string[] }>(),
  mockGh: {
    getIssueComments: vi.fn(async (..._args: unknown[]): Promise<{ body: string; login: string }[]> => []),
    getIssueState: vi.fn(async (..._args: unknown[]) => ({ state: "OPEN", stateReason: null, labels: [] as string[] })),
    commentOnIssue: vi.fn(async (..._args: unknown[]) => undefined),
    getUpstreamPRStatus: vi.fn(),
    getDefaultBranch: vi.fn(async (..._args: unknown[]) => "main"),
  },
  mockForgejo: { listDefaultBranchWorkflowRuns: vi.fn() },
  mockPlanned: { loadIssuePhaseState: vi.fn() },
}));

vi.mock("./github.js", () => mockGh);
vi.mock("./forgejo.js", () => mockForgejo);
vi.mock("./planned-prs.js", () => mockPlanned);
vi.mock("./repo-config.js", () => ({ getRepoConfig: (name: string) => configs.get(name) ?? null }));
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./issue-handback.js", () => ({
  needsHumanMarker: (slug: string) => `claws-needs-human:${slug}`,
  hasNeedsHumanMarker: (comments: { body: string }[], slug: string) =>
    comments.some((c) => c.body.split("\n").some((l) => l.trim() === `claws-needs-human:${slug}`)),
}));

import * as log from "./log.js";
import type { Repo } from "./config.js";
import { clearDeployHoldNotices, deployGateBlock, noticeDeployHold } from "./deploy-gate.js";

const INFRA = "St-John-Software/production-infra";
const CLAWS = "St-John-Software/claws";
const REPO = { fullName: INFRA, defaultBranch: "main" } as Repo;
const ISSUE = { repo: INFRA, ref: "clw_01M6NVFJQH6227AXV2B7SP9CVA" };
const MERGED_AT = "2026-11-05T20:30:00Z";

/** Phase state where step 2 depends on step 1, which `pr` in `depRepo` covers as merged. */
function phaseState(opts: { depRepo?: string; pr?: number; depState?: "open" | "merged"; deps?: Map<number, number[]> } = {}) {
  return {
    totalPhases: 2,
    coverage: {
      dependencies: opts.deps ?? new Map([[1, []], [2, [1]]]),
      coveringPRs: new Map([[1, { number: opts.pr ?? 633, title: "step 1", state: opts.depState ?? "merged" }]]),
    },
    entries: [
      { position: 1, repo: opts.depRepo ?? INFRA, title: "step 1", prNumber: opts.pr ?? 633, dependsOn: [], kind: "pr", manualAction: null },
      { position: 2, repo: INFRA, title: "step 2", prNumber: 641, dependsOn: [1], kind: "pr", manualAction: null },
    ],
    trackerId: ISSUE.ref,
  };
}

const run = (runNumber: number, status: string, createdAt: string) => ({
  runNumber, status, createdAt, htmlUrl: `https://git.example/${INFRA}/actions/runs/${runNumber}`, headSha: "abc",
});

beforeEach(() => {
  vi.clearAllMocks();
  configs.clear();
  clearDeployHoldNotices();
  configs.set(INFRA, { deployWorkflows: ["tofu-apply.yml"] });
  mockPlanned.loadIssuePhaseState.mockResolvedValue(phaseState());
  mockGh.getUpstreamPRStatus.mockResolvedValue({ state: "closed", merged: true, mergedAt: MERGED_AT, title: "", url: "", updatedAt: MERGED_AT });
  mockForgejo.listDefaultBranchWorkflowRuns.mockResolvedValue([]);
});

const ROW = { prNumber: 641, phase: 2 };

describe("deployGateBlock", () => {
  it("holds as deploy-red when the newest tofu-apply run since step 1 merged failed (2026-11-05 replay)", async () => {
    mockForgejo.listDefaultBranchWorkflowRuns.mockResolvedValue([
      run(3754, "failure", "2026-11-05T20:31:00Z"),
      run(3750, "success", "2026-11-05T19:00:00Z"),
    ]);
    const block = await deployGateBlock(REPO, ROW, ISSUE);
    expect(block?.code).toBe("deploy-red");
    expect(block?.slug).toBe(`deploy-red-${INFRA}#641-tofu-apply.yml`);
    expect(block?.reason).toContain(`Step 2 depends on step 1 (\`${INFRA}#633\`), merged at ${MERGED_AT}`);
    expect(block?.reason).toContain("`tofu-apply.yml` failed on `main`");
    expect(block?.reason).toContain("actions/runs/3754");
    expect(mockForgejo.listDefaultBranchWorkflowRuns).toHaveBeenCalledWith(INFRA, "main", "tofu-apply.yml");
  });

  it("does not hold once a later run passes", async () => {
    mockForgejo.listDefaultBranchWorkflowRuns.mockResolvedValue([
      run(3760, "success", "2026-11-05T22:00:00Z"),
      run(3754, "failure", "2026-11-05T20:31:00Z"),
    ]);
    expect(await deployGateBlock(REPO, ROW, ISSUE)).toBeNull();
  });

  it("holds quietly as deploy-pending while the newest run after a failure is still running", async () => {
    mockForgejo.listDefaultBranchWorkflowRuns.mockResolvedValue([
      run(3760, "running", "2026-11-05T22:00:00Z"),
      run(3754, "failure", "2026-11-05T20:31:00Z"),
    ]);
    expect((await deployGateBlock(REPO, ROW, ISSUE))?.code).toBe("deploy-pending");
  });

  it("does not hold when no run started since the merge", async () => {
    mockForgejo.listDefaultBranchWorkflowRuns.mockResolvedValue([run(3700, "failure", "2026-11-05T19:00:00Z")]);
    expect(await deployGateBlock(REPO, ROW, ISSUE)).toBeNull();
  });

  it("does not fetch runs for a repo with no deployWorkflows", async () => {
    configs.set(INFRA, { deployWorkflows: [] });
    expect(await deployGateBlock(REPO, ROW, ISSUE)).toBeNull();
    expect(mockForgejo.listDefaultBranchWorkflowRuns).not.toHaveBeenCalled();
    expect(mockGh.getUpstreamPRStatus).not.toHaveBeenCalled();
  });

  it("lets the run before a cancelled newest run decide", async () => {
    mockForgejo.listDefaultBranchWorkflowRuns.mockResolvedValue([
      run(3761, "cancelled", "2026-11-05T22:30:00Z"),
      run(3754, "failure", "2026-11-05T20:31:00Z"),
    ]);
    expect((await deployGateBlock(REPO, ROW, ISSUE))?.slug).toBe(`deploy-red-${INFRA}#641-tofu-apply.yml`);
    mockForgejo.listDefaultBranchWorkflowRuns.mockResolvedValue([
      run(3761, "cancelled", "2026-11-05T22:30:00Z"),
      run(3760, "success", "2026-11-05T22:00:00Z"),
    ]);
    expect(await deployGateBlock(REPO, ROW, ISSUE)).toBeNull();
  });

  it("reads a cross-repo dependency's own repo config, PR and default branch", async () => {
    configs.set(INFRA, { deployWorkflows: [] });
    configs.set(CLAWS, { deployWorkflows: ["release.yml"] });
    mockPlanned.loadIssuePhaseState.mockResolvedValue(phaseState({ depRepo: CLAWS, pr: 400 }));
    mockGh.getDefaultBranch.mockResolvedValue("trunk");
    mockForgejo.listDefaultBranchWorkflowRuns.mockResolvedValue([run(99, "failure", "2026-11-05T21:00:00Z")]);
    const block = await deployGateBlock(REPO, ROW, ISSUE);
    expect(block?.code).toBe("deploy-red");
    expect(block?.reason).toContain(`\`${CLAWS}#400\``);
    expect(mockGh.getUpstreamPRStatus).toHaveBeenCalledWith(CLAWS, 400);
    expect(mockForgejo.listDefaultBranchWorkflowRuns).toHaveBeenCalledWith(CLAWS, "trunk", "release.yml");
  });

  it("walks dependencies transitively", async () => {
    mockPlanned.loadIssuePhaseState.mockResolvedValue(phaseState({ deps: new Map([[1, []], [2, [1]], [3, [2]]]) }));
    mockForgejo.listDefaultBranchWorkflowRuns.mockResolvedValue([run(3754, "failure", "2026-11-05T21:00:00Z")]);
    expect((await deployGateBlock(REPO, { prNumber: 650, phase: 3 }, ISSUE))?.code).toBe("deploy-red");
  });

  it("ignores a dependency that has not merged", async () => {
    mockPlanned.loadIssuePhaseState.mockResolvedValue(phaseState({ depState: "open" }));
    expect(await deployGateBlock(REPO, ROW, ISSUE)).toBeNull();
    expect(mockForgejo.listDefaultBranchWorkflowRuns).not.toHaveBeenCalled();
  });

  it("fails closed as deploy-pending on a Forgejo error, with a warning", async () => {
    mockForgejo.listDefaultBranchWorkflowRuns.mockRejectedValue(new Error("Forgejo 500"));
    expect((await deployGateBlock(REPO, ROW, ISSUE))?.code).toBe("deploy-pending");
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });

  it("returns null without a phase or an issue", async () => {
    expect(await deployGateBlock(REPO, { prNumber: 641, phase: null }, ISSUE)).toBeNull();
    expect(await deployGateBlock(REPO, ROW, null)).toBeNull();
    expect(mockPlanned.loadIssuePhaseState).not.toHaveBeenCalled();
  });
});

describe("noticeDeployHold", () => {
  const RED = { code: "deploy-red" as const, reason: "Step 2 depends on step 1 …", slug: `deploy-red-${INFRA}#641-tofu-apply.yml` };

  it("comments once on the issue with the reason and the needs-human marker, then dedupes in memory", async () => {
    await noticeDeployHold(ISSUE, INFRA, 641, RED);
    await noticeDeployHold(ISSUE, INFRA, 641, RED);
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(body).toContain("## Waiting on a red deploy");
    expect(body).toContain(RED.reason);
    expect(body).toContain(`claws-needs-human:${RED.slug}`);
    expect(vi.mocked(log.info)).toHaveBeenCalledTimes(1);
  });

  it("does not comment again when the marker is already on the issue", async () => {
    mockGh.getIssueComments.mockResolvedValue([{ body: `## Waiting on a red deploy\n\nclaws-needs-human:${RED.slug}`, login: "claws" }]);
    await noticeDeployHold(ISSUE, INFRA, 641, RED);
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("posts nothing for deploy-pending", async () => {
    await noticeDeployHold(ISSUE, INFRA, 641, { ...RED, code: "deploy-pending" });
    expect(mockGh.getIssueState).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });
});
