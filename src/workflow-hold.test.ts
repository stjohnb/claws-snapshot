import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockPR } from "./test-helpers.js";

const mocks = vi.hoisted(() => ({
  listHeldWorkflowRuns: vi.fn(),
  approveWorkflowRun: vi.fn(),
  isAllowedActor: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./log.js", () => ({ debug: vi.fn(), info: mocks.info, warn: mocks.warn, error: vi.fn() }));
vi.mock("./config.js", () => ({
  THIRD_PARTY_UPDATE_WINDOW: { enabled: false, start: "22:00", end: "07:00", timezone: "Europe/London" },
}));
vi.mock("./repo-config.js", () => ({ getRepoConfig: () => null }));
vi.mock("./github.js", () => ({
  isDependabotPR: (pr: { author: { login: string } }) =>
    pr.author.login === "dependabot[bot]" || pr.author.login === "app/dependabot",
  isForkPR: (pr: { isCrossRepository?: boolean }) => pr.isCrossRepository === true,
  normalizeBotLogin: (login: string) => (login.startsWith("app/") ? `${login.slice(4)}[bot]` : login),
  isAllowedHumanActor: mocks.isAllowedActor,
  listHeldWorkflowRuns: mocks.listHeldWorkflowRuns,
  approveWorkflowRun: mocks.approveWorkflowRun,
}));

import {
  approveHeldRuns,
  canClearActionRequiredHold,
  heldRunCount,
  observeHeldRuns,
  pruneHeldRunCounts,
  recordHeldRuns,
  resetHeldRunCountsForTests,
  resetRejectedHeldRunsForTests,
} from "./workflow-hold.js";
import type { Repo } from "./config.js";

const REPO = "St-John-Software/namey";
const repo = { owner: "St-John-Software", name: "namey", fullName: REPO } as Repo;

function heldRun(id: number) {
  return { run_id: id, workflow_name: `wf-${id}`, conclusion: "action_required", repo: REPO };
}

beforeEach(() => {
  resetRejectedHeldRunsForTests();
  resetHeldRunCountsForTests();
  mocks.listHeldWorkflowRuns.mockReset();
  mocks.approveWorkflowRun.mockReset().mockResolvedValue(undefined);
  mocks.isAllowedActor.mockReset().mockResolvedValue(false);
  mocks.info.mockReset();
  mocks.warn.mockReset();
});

describe("canClearActionRequiredHold", () => {
  const allowed = async (login: string) => login === "stjohnb";

  it("clears a same-repo Dependabot PR", async () => {
    const pr = mockPR({ author: { login: "app/dependabot" }, headRefName: "dependabot/npm_and_yarn/x-1.2.3" });
    expect(await canClearActionRequiredHold(REPO, pr, allowed)).toBe(true);
  });

  it("clears a same-repo renovate[bot] PR", async () => {
    const pr = mockPR({ author: { login: "app/renovate" }, headRefName: "renovate/x-1.x" });
    expect(await canClearActionRequiredHold(REPO, pr, allowed)).toBe(true);
  });

  it("clears a renovate/* branch authored by an allowed actor (PAT-run Renovate)", async () => {
    const pr = mockPR({ author: { login: "stjohnb" }, headRefName: "renovate/x-1.x" });
    expect(await canClearActionRequiredHold(REPO, pr, allowed)).toBe(true);
  });

  it("leaves a renovate/* branch authored by a non-allowed actor held", async () => {
    const pr = mockPR({ author: { login: "stranger" }, headRefName: "renovate/x-1.x" });
    expect(await canClearActionRequiredHold(REPO, pr, allowed)).toBe(false);
  });

  it("leaves a renovate/* branch authored by Claws' own account held", async () => {
    // The default checker is isAllowedHumanActor, which rejects Claws' own login.
    const pr = mockPR({ author: { login: "app/claws" }, headRefName: "renovate/x" });
    expect(await canClearActionRequiredHold(REPO, pr)).toBe(false);
    expect(mocks.isAllowedActor).toHaveBeenCalledWith("app/claws", REPO);
  });

  it("leaves a fork Dependabot PR held", async () => {
    const pr = mockPR({ author: { login: "dependabot[bot]" }, headRefName: "dependabot/npm/x", isCrossRepository: true });
    expect(await canClearActionRequiredHold(REPO, pr, allowed)).toBe(false);
  });

  it("leaves a fork renovate[bot] PR held", async () => {
    const pr = mockPR({ author: { login: "renovate[bot]" }, headRefName: "renovate/x", isCrossRepository: true });
    expect(await canClearActionRequiredHold(REPO, pr, allowed)).toBe(false);
  });

  it("leaves a human-authored Claws PR held", async () => {
    const pr = mockPR({ author: { login: "stjohnb" }, headRefName: "claws/issue-12-abcd" });
    expect(await canClearActionRequiredHold(REPO, pr, allowed)).toBe(false);
  });

  it("leaves a human push to a dependabot/* branch held", async () => {
    const pr = mockPR({ author: { login: "stjohnb" }, headRefName: "dependabot/npm/x" });
    expect(await canClearActionRequiredHold(REPO, pr, allowed)).toBe(false);
  });
});

describe("observeHeldRuns / approveHeldRuns", () => {
  const pr = mockPR({ number: 2027, author: { login: "app/dependabot" }, headRefName: "dependabot/npm/x", headRefOid: "abc123" });

  async function clear() {
    const runs = await observeHeldRuns(repo, pr);
    return runs === null ? null : approveHeldRuns(repo, pr, runs);
  }

  it("approves each held run once and logs one line per run", async () => {
    mocks.listHeldWorkflowRuns.mockResolvedValue([heldRun(11), heldRun(12)]);

    expect(await clear()).toEqual({ cleared: 2, rejected: 0 });
    expect(mocks.listHeldWorkflowRuns).toHaveBeenCalledWith(REPO, "abc123");
    expect(mocks.approveWorkflowRun.mock.calls).toEqual([[REPO, 11], [REPO, 12]]);
    expect(mocks.info).toHaveBeenCalledTimes(2);
    expect(mocks.info.mock.calls[0]![0]).toContain("11");
    expect(mocks.info.mock.calls[0]![0]).toContain(`${REPO}#2027`);
    expect(mocks.info.mock.calls[1]![0]).toContain("12");
  });

  it("does not retry a run whose approval GitHub rejected", async () => {
    mocks.listHeldWorkflowRuns.mockResolvedValue([heldRun(21)]);
    mocks.approveWorkflowRun.mockRejectedValueOnce(new Error("HTTP 403"));

    expect(await clear()).toEqual({ cleared: 0, rejected: 1 });
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("21"));

    expect(await clear()).toEqual({ cleared: 0, rejected: 0 });
    expect(mocks.approveWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it("skips a PR with no head SHA without calling GitHub", async () => {
    const noSha = mockPR({ author: { login: "app/dependabot" }, headRefName: "dependabot/npm/x" });
    expect(await observeHeldRuns(repo, noSha)).toBeNull();
    expect(mocks.listHeldWorkflowRuns).not.toHaveBeenCalled();
  });

  it("never throws when listing the held runs fails", async () => {
    mocks.listHeldWorkflowRuns.mockRejectedValue(new Error("boom"));
    expect(await observeHeldRuns(repo, pr)).toBeNull();
    expect(mocks.approveWorkflowRun).not.toHaveBeenCalled();
  });

  it("records the held count observed without approving anything", async () => {
    mocks.listHeldWorkflowRuns.mockResolvedValue([heldRun(11), heldRun(12)]);
    expect(await observeHeldRuns(repo, pr)).toHaveLength(2);
    expect(heldRunCount(REPO, "abc123")).toBe(2);
    expect(mocks.approveWorkflowRun).not.toHaveBeenCalled();
  });

  it("clears the recorded held count once every run is approved", async () => {
    mocks.listHeldWorkflowRuns.mockResolvedValue([heldRun(11), heldRun(12)]);
    await clear();
    expect(heldRunCount(REPO, "abc123")).toBeUndefined();
  });

  it("records the held count still outstanding after a rejected approval", async () => {
    mocks.listHeldWorkflowRuns.mockResolvedValue([heldRun(21), heldRun(22)]);
    mocks.approveWorkflowRun.mockImplementation((_repo: string, id: number) =>
      id === 21 ? Promise.reject(new Error("HTTP 403")) : Promise.resolve(undefined),
    );
    await clear();
    expect(heldRunCount(REPO, "abc123")).toBe(1);
  });

  it("leaves the recorded held count untouched when listing fails", async () => {
    mocks.listHeldWorkflowRuns.mockResolvedValueOnce([heldRun(31)]);
    mocks.approveWorkflowRun.mockRejectedValueOnce(new Error("HTTP 403"));
    await clear();
    expect(heldRunCount(REPO, "abc123")).toBe(1);

    mocks.listHeldWorkflowRuns.mockRejectedValueOnce(new Error("boom"));
    await clear();
    expect(heldRunCount(REPO, "abc123")).toBe(1);
  });
});

describe("pruneHeldRunCounts", () => {
  it("drops counts for heads that are no longer open, in that repo only", () => {
    recordHeldRuns(REPO, "live", 1);
    recordHeldRuns(REPO, "gone", 2);
    recordHeldRuns("St-John-Software/other", "gone", 3);
    pruneHeldRunCounts(REPO, new Set(["live"]));
    expect(heldRunCount(REPO, "live")).toBe(1);
    expect(heldRunCount(REPO, "gone")).toBeUndefined();
    expect(heldRunCount("St-John-Software/other", "gone")).toBe(3);
  });
});
