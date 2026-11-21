import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLog } = vi.hoisted(() => ({ mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./log.js", () => mockLog);

const { mockGh, mockClawsIssues, mockRequirements } = vi.hoisted(() => ({
  mockGh: {
    getIssueComments: vi.fn(),
    editIssueComment: vi.fn(),
    isClawsComment: (body: string) => body.includes("Automated by Claws"),
    stripClawsMarker: (body: string) => body.replace(/\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/g, "").trim(),
  },
  mockClawsIssues: { editIssueTitle: vi.fn() },
  mockRequirements: { loadApprovedRequirements: vi.fn() },
}));
vi.mock("./github.js", () => mockGh);
vi.mock("./claws-issues.js", () => mockClawsIssues);
vi.mock("./approved-requirements.js", () => mockRequirements);
vi.mock("./agents/issue-refiner.js", async () => {
  const { createHash } = await import("node:crypto");
  return {
    PLAN_HEADER: "## Implementation Plan",
    PLAN_BODY_HASH_MARKER: "CLAWS_PLAN_BODY_HASH:",
    issueContentHash: (title: string, body: string, req: { version: number } | null) =>
      createHash("sha256").update(`${title}\n${body}\n${req ? req.version : ""}`).digest("hex"),
  };
});

import { createHash } from "node:crypto";
import { retitleKeepingPlanCurrent } from "./issue-retitle.js";

const REPO = "o/r";
const ID = "clw_1";
const BODY = "the body";
const hash = (title: string, version: number | null = null) =>
  createHash("sha256").update(`${title}\n${BODY}\n${version ?? ""}`).digest("hex");
const planComment = (stamp: string) => ({
  id: "clw_c1",
  body: `*— Automated by Claws · Planner —*\n\n## Implementation Plan\n\nDo it.\n\nCLAWS_PLAN_BODY_HASH: ${stamp}\nCLAWS_PLAN_LAST_COMMENT: 0`,
});

describe("retitleKeepingPlanCurrent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequirements.loadApprovedRequirements.mockResolvedValue({ status: "none" });
    mockGh.getIssueComments.mockResolvedValue([]);
  });

  it("renames and re-stamps a plan that was current for the old title", async () => {
    mockRequirements.loadApprovedRequirements.mockResolvedValue({ status: "approved", record: { version: 2 } });
    mockGh.getIssueComments.mockResolvedValue([planComment(hash("old", 2))]);

    expect(await retitleKeepingPlanCurrent(REPO, ID, "old", BODY, "new")).toBe(true);

    expect(mockClawsIssues.editIssueTitle).toHaveBeenCalledWith(ID, "new");
    expect(mockGh.editIssueComment).toHaveBeenCalledTimes(1);
    const [repo, commentId, body, opts] = mockGh.editIssueComment.mock.calls[0]!;
    expect([repo, commentId, opts]).toEqual([REPO, "clw_c1", { agentName: "Planner" }]);
    expect(body).toContain(`CLAWS_PLAN_BODY_HASH: ${hash("new", 2)}`);
    expect(body).not.toContain("Automated by Claws");
    expect(body).toContain("CLAWS_PLAN_LAST_COMMENT: 0");
  });

  it("renames but leaves a stale plan's stamp alone", async () => {
    mockGh.getIssueComments.mockResolvedValue([planComment(hash("something else"))]);

    expect(await retitleKeepingPlanCurrent(REPO, ID, "old", BODY, "new")).toBe(true);

    expect(mockClawsIssues.editIssueTitle).toHaveBeenCalledWith(ID, "new");
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
  });

  it("renames an issue with no plan", async () => {
    mockGh.getIssueComments.mockResolvedValue([{ id: "clw_c0", body: "a human comment" }]);

    expect(await retitleKeepingPlanCurrent(REPO, ID, "old", BODY, "new")).toBe(true);

    expect(mockClawsIssues.editIssueTitle).toHaveBeenCalledWith(ID, "new");
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
  });

  it("writes nothing when the approved requirements cannot be read", async () => {
    mockRequirements.loadApprovedRequirements.mockResolvedValue({ status: "error" });

    expect(await retitleKeepingPlanCurrent(REPO, ID, "old", BODY, "new")).toBe(false);

    expect(mockGh.getIssueComments).not.toHaveBeenCalled();
    expect(mockClawsIssues.editIssueTitle).not.toHaveBeenCalled();
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
  });

  it("logs a failed re-stamp at warn without throwing", async () => {
    mockGh.getIssueComments.mockResolvedValue([planComment(hash("old"))]);
    mockGh.editIssueComment.mockRejectedValue(new Error("db down"));

    expect(await retitleKeepingPlanCurrent(REPO, ID, "old", BODY, "new")).toBe(true);

    expect(mockClawsIssues.editIssueTitle).toHaveBeenCalledWith(ID, "new");
    expect(mockLog.warn).toHaveBeenCalledWith("plan hash re-stamp after retitle failed", expect.objectContaining({ issue: ID, error: "db down" }));
  });
});
