import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLog, mockDb, mockClawsIssues, mockReportError } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockDb: {
    listContractStatuses: vi.fn(async (): Promise<unknown[]> => []),
    listContractGapReconfirmations: vi.fn(async (): Promise<unknown[]> => []),
    saveContractGapReconfirmation: vi.fn(async () => {}),
    listOpenClawsIssuesByDedupeKey: vi.fn(async (_key: string): Promise<unknown[]> => []),
    readControllerStatus: vi.fn(async (_key: string): Promise<unknown> => null),
    writeControllerStatus: vi.fn(async () => {}),
  },
  mockClawsIssues: {
    CLAWS_NATIVE_LOGIN: "claws",
    primaryRepo: (r: { repos: string[] }) => r.repos[0] ?? "",
    findOpenIssueByDedupeKey: vi.fn(async (_repo: string, _key: string): Promise<unknown> => undefined),
    findRecentlyClosedIssueByDedupeKey: vi.fn(async (_repo: string, _key: string, _since: Date): Promise<unknown> => undefined),
    createIssue: vi.fn(async () => "clw_NEW"),
    editIssue: vi.fn(async () => {}),
    editIssueTitle: vi.fn(async () => {}),
    commentOnIssue: vi.fn(async () => "c1"),
    closeIssue: vi.fn(async () => {}),
  },
  mockReportError: vi.fn(async () => {}),
}));

vi.mock("../config.js", () => ({
  LABELS: { blocked: "Blocked" },
  DASHBOARD_URL: "https://claws.example",
  getRepoJobExclusions: () => [],
}));
vi.mock("../log.js", () => mockLog);
vi.mock("../db.js", () => mockDb);
vi.mock("../claws-issues.js", () => mockClawsIssues);
vi.mock("../error-reporter.js", () => ({ reportError: mockReportError }));
vi.mock("../claude.js", () => ({}));

import { run } from "./accepted-gaps-review.js";
import { gapKey } from "../contract-gap-review.js";
import type { Repo } from "../config.js";

const REPO = { fullName: "o/app" } as Repo;
const NOW = new Date("2026-11-11T12:00:00.000Z");
const CLAWS = "St-John-Software/claws";
const TITLE = "chore: review the fleet's accepted observability gaps";

function status(gaps: { text: string; state: string }[], contract = "observability") {
  return {
    contract, repo: "o/app", scannedAt: "2026-11-10T00:00:00.000Z",
    snapshot: { policy: { status: "complete", path: "docs/observability.md", missingRules: [] }, gaps, drift: [], driftUnavailable: [], audit: null },
  };
}

const ACCEPTED = { text: "Accepted: no traces, single process.", state: "accepted" };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.listContractStatuses.mockResolvedValue([status([ACCEPTED])]);
  mockDb.listContractGapReconfirmations.mockResolvedValue([]);
  mockDb.listOpenClawsIssuesByDedupeKey.mockResolvedValue([]);
  mockDb.readControllerStatus.mockResolvedValue(null);
  mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(undefined);
  mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(undefined);
});

/** Routes closed-issue lookups by key: the digest key vs the legacy per-repo keys. */
function closedByKey(map: Record<string, unknown>) {
  mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockImplementation(async (_repo, key) => map[key]);
}

describe("accepted-gaps-review", () => {
  it("files one Blocked digest in the claws repo", async () => {
    await run([REPO], NOW);
    expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
    expect(mockClawsIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({
      title: "chore: review the fleet's accepted observability gaps",
      repos: [CLAWS],
      primaryRepo: CLAWS,
      labels: ["Blocked"],
      blockedReason: expect.any(String),
      requirementsStage: false,
      autoPromote: false,
      source: "automation",
      dedupeKey: "accepted-gaps-review",
      body: expect.stringContaining("- o/app (observability): Accepted: no traces, single process. — waives: Traces"),
    }));
    expect((mockClawsIssues.createIssue.mock.calls[0] as unknown[])[0]).toHaveProperty("body", expect.stringContaining("https://claws.example/contracts/review"));
    expect(mockLog.info).toHaveBeenCalledWith("review finished", expect.objectContaining({ outcome: "filed", accepted: 1, changed: 1 }));
  });

  it("rewrites an open digest only when its body changed, and never files a second", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_OPEN", title: TITLE, body: "old" });
    await run([REPO], NOW);
    expect(mockClawsIssues.editIssue).toHaveBeenCalledWith("clw_OPEN", expect.stringContaining("no traces"));
    const body = (mockClawsIssues.editIssue.mock.calls[0] as unknown[])[1];
    mockClawsIssues.editIssue.mockClear();
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_OPEN", title: TITLE, body });
    await run([REPO], NOW);
    expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.editIssueTitle).not.toHaveBeenCalled();
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("retitles an open digest filed under the old title", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_OPEN", title: "chore: review the fleet's accepted contract gaps", body: "old" });
    await run([REPO], NOW);
    expect(mockClawsIssues.editIssueTitle).toHaveBeenCalledWith("clw_OPEN", TITLE);
    expect(mockLog.info).toHaveBeenCalledWith("accepted gaps review retitled", expect.objectContaining({ issue: "clw_OPEN", title: TITLE }));
    expect(mockClawsIssues.editIssue).toHaveBeenCalledWith("clw_OPEN", expect.stringContaining("https://pages.home.bstjohn.net/sentinel/docs/cve-exceptions/"));
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("lists no security gaps and reconfirms none", async () => {
    mockDb.listContractStatuses.mockResolvedValue([status([{ text: "Accepted: trivy DB fail-open.", state: "accepted" }], "security")]);
    closedByKey({ "accepted-gaps-review": { id: "clw_OLD", state_reason: "completed", closed_at: "2026-11-11 10:00:00" } });
    await run([REPO], NOW);
    expect(mockDb.saveContractGapReconfirmation).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith("review finished", expect.objectContaining({ accepted: 0 }));
  });

  it("files nothing within 91 days of a closed digest", async () => {
    closedByKey({ "accepted-gaps-review": { id: "clw_OLD", state_reason: "not_planned", closed_at: "2026-10-01 00:00:00" } });
    await run([REPO], NOW);
    expect(mockClawsIssues.findRecentlyClosedIssueByDedupeKey).toHaveBeenCalledWith(CLAWS, "accepted-gaps-review", new Date("2026-08-12T12:00:00.000Z"));
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("reconfirms every accepted gap once when the digest closed as completed", async () => {
    closedByKey({ "accepted-gaps-review": { id: "clw_OLD", state_reason: "completed", closed_at: "2026-11-11 10:00:00" } });
    await run([REPO], NOW);
    expect(mockDb.saveContractGapReconfirmation).toHaveBeenCalledWith("observability", "o/app", "2026-11-11T10:00:00.000Z", [gapKey(ACCEPTED.text)]);
    mockDb.saveContractGapReconfirmation.mockClear();
    mockDb.listContractGapReconfirmations.mockResolvedValue([
      { contract: "observability", repo: "o/app", reconfirmedAt: "2026-11-11T10:00:00.000Z", gapKeys: [gapKey(ACCEPTED.text)] },
    ]);
    await run([REPO], NOW);
    expect(mockDb.saveContractGapReconfirmation).not.toHaveBeenCalled();
  });

  it("does not reconfirm when the digest closed as not planned", async () => {
    closedByKey({ "accepted-gaps-review": { id: "clw_OLD", state_reason: "not_planned", closed_at: "2026-11-11 10:00:00" } });
    await run([REPO], NOW);
    expect(mockDb.saveContractGapReconfirmation).not.toHaveBeenCalled();
  });

  it("closes an open legacy per-repo review as not planned with a comment", async () => {
    mockDb.listOpenClawsIssuesByDedupeKey.mockImplementation(async (key) =>
      key === "security-accepted-gaps-review" ? [{ id: "clw_LEGACY", repos: ["o/app"] }] : []);
    await run([REPO], NOW);
    expect(mockClawsIssues.commentOnIssue).toHaveBeenCalledWith("o/app", "clw_LEGACY", expect.stringContaining("/contracts/review"), "claws");
    expect(mockClawsIssues.closeIssue).toHaveBeenCalledWith("o/app", "clw_LEGACY", "not_planned");
  });

  it("does not comment when the legacy close fails, and still files the digest", async () => {
    mockDb.listOpenClawsIssuesByDedupeKey.mockImplementation(async (key) =>
      key === "security-accepted-gaps-review" ? [{ id: "clw_LEGACY", repos: ["o/app"] }] : []);
    mockClawsIssues.closeIssue.mockRejectedValueOnce(new Error("boom"));
    await run([REPO], NOW);
    expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
    expect(mockReportError).toHaveBeenCalledWith("accepted-gaps-review:legacy-close", "accepted-gaps-review:legacy-close", expect.any(Error));
    expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
  });

  it("seeds a reconfirmation from a legacy review closed as completed", async () => {
    closedByKey({ "observability-accepted-gaps-review": { id: "clw_L", state_reason: "completed", closed_at: "2026-11-11 09:45:45", body: `- ${ACCEPTED.text}` } });
    await run([REPO], NOW);
    expect(mockClawsIssues.findRecentlyClosedIssueByDedupeKey).toHaveBeenCalledWith("o/app", "observability-accepted-gaps-review", new Date(0));
    expect(mockDb.saveContractGapReconfirmation).toHaveBeenCalledWith("observability", "o/app", "2026-11-11T09:45:45.000Z", [gapKey(ACCEPTED.text)]);
  });

  it("seeds only the gaps the legacy issue listed, and only once", async () => {
    const extra = { text: "Accepted: added later.", state: "accepted" };
    mockDb.listContractStatuses.mockResolvedValue([status([ACCEPTED, extra])]);
    closedByKey({ "observability-accepted-gaps-review": { id: "clw_L", state_reason: "completed", closed_at: "2026-11-11 09:45:45", body: `- ${ACCEPTED.text}` } });
    await run([REPO], NOW);
    expect(mockDb.saveContractGapReconfirmation).toHaveBeenCalledWith("observability", "o/app", "2026-11-11T09:45:45.000Z", [gapKey(ACCEPTED.text)]);
    expect(mockDb.writeControllerStatus).toHaveBeenCalledWith("accepted_gaps_legacy_seeded", expect.any(String));
    mockDb.saveContractGapReconfirmation.mockClear();
    mockDb.readControllerStatus.mockResolvedValue("done");
    await run([REPO], NOW);
    expect(mockDb.saveContractGapReconfirmation).not.toHaveBeenCalled();
  });

  it("seeds nothing from a legacy review closed as not planned", async () => {
    closedByKey({ "observability-accepted-gaps-review": { id: "clw_L", state_reason: "not_planned", closed_at: "2026-11-11 09:45:45" } });
    await run([REPO], NOW);
    expect(mockDb.saveContractGapReconfirmation).not.toHaveBeenCalled();
  });

  it("files nothing when no repo accepts a gap", async () => {
    mockDb.listContractStatuses.mockResolvedValue([status([{ text: "x", state: "unaccepted" }])]);
    await run([REPO], NOW);
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith("review finished", expect.objectContaining({ outcome: "none" }));
  });

  it("reports a failure", async () => {
    mockDb.listContractStatuses.mockRejectedValue(new Error("db down"));
    await run([REPO], NOW);
    expect(mockReportError).toHaveBeenCalledWith("accepted-gaps-review", "accepted-gaps-review", expect.any(Error));
  });
});
