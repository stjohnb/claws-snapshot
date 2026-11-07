import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockIssues } = vi.hoisted(() => ({
  mockDb: { listPostMergeActionPrs: vi.fn(), getIssuePlannedPRs: vi.fn(), getClawsPr: vi.fn(), upsertClawsPr: vi.fn() },
  mockIssues: { getIssue: vi.fn() },
}));
vi.mock("../db.js", () => mockDb);
vi.mock("../claws-issues.js", () => mockIssues);
vi.mock("../github.js", () => ({}));
vi.mock("../issue-handback.js", () => ({ hasNeedsHumanMarker: vi.fn(), needsHumanMarker: vi.fn(), parkForHuman: vi.fn() }));
vi.mock("../config.js", () => ({ isClawsIssueId: () => true, LABELS: {} }));
vi.mock("../log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import * as log from "../log.js";
import { run } from "./post-merge-action-sweeper.js";

const reason = "Manual action after merge: do it";
const row = (prNumber: number, issueId: string | null) => ({ repo: "org/a", prNumber, issueId, phase: 1, manualActionReason: reason });

describe("post-merge-action-sweeper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.getClawsPr.mockImplementation(async (_r: string, n: number) => row(n, "x"));
    mockDb.getIssuePlannedPRs.mockResolvedValue([{ position: 1, repo: "org/a", title: "t", prNumber: 1, dependsOn: null, kind: "pr", manualAction: null }]);
  });

  it("clears rows whose issue is closed and keeps open and unlinked ones", async () => {
    mockDb.listPostMergeActionPrs.mockResolvedValue([row(1, "clw_closed"), row(2, "clw_open"), row(3, null)]);
    mockIssues.getIssue.mockImplementation(async (id: string) => ({ state: id === "clw_closed" ? "closed" : "open" }));
    await run();
    expect(mockDb.upsertClawsPr).toHaveBeenCalledTimes(1);
    expect(mockDb.upsertClawsPr).toHaveBeenCalledWith("org/a", 1, { manualActionReason: null });
  });

  it("continues past a per-row failure", async () => {
    mockDb.listPostMergeActionPrs.mockResolvedValue([row(1, "clw_bad"), row(2, "clw_closed")]);
    mockIssues.getIssue.mockImplementation(async (id: string) => {
      if (id === "clw_bad") throw new Error("boom");
      return { state: "closed" };
    });
    await run();
    expect(mockDb.upsertClawsPr).toHaveBeenCalledWith("org/a", 2, { manualActionReason: null });
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ repo: "org/a", pr: 1 }), expect.any(Error));
  });

  it("logs start and finish lines with constant messages even when nothing is cleared", async () => {
    mockDb.listPostMergeActionPrs.mockResolvedValue([]);
    await run();
    expect(log.info).toHaveBeenCalledWith("[post-merge-action-sweeper] sweep started", { candidates: 0 });
    expect(log.info).toHaveBeenCalledWith(
      "[post-merge-action-sweeper] sweep finished",
      expect.objectContaining({ cleared: 0, duration_ms: expect.any(Number) }),
    );
    for (const call of [...vi.mocked(log.info).mock.calls, ...vi.mocked(log.warn).mock.calls]) {
      expect(String(call[0])).not.toContain("org/a");
    }
  });
});
