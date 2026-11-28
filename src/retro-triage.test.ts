import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db.js", () => ({
  listFrictionRetrospectives: vi.fn(async () => []),
  getClawsIssue: vi.fn(async () => undefined),
  listClawsIssues: vi.fn(async () => []),
  listClawsPrsForIssue: vi.fn(async () => []),
}));

import * as db from "./db.js";
import { buildRetroOpeningMessage, loadRetroTriageContext, MAX_RETRO_FOLLOW_UPS, type RetroFollowUp } from "./retro-triage.js";

const PREV = "clw_01M7T99BSDSWG3FGYQ1JDD7B1F";
const CUR = "clw_01M8A81NZJHDAF4BD5QBF8YE6Y";

function issue(patch: Record<string, unknown>) {
  return {
    id: "clw_X", title: "t", body: "", state: "open", state_reason: null, created_at: "2026-11-20 00:00:00",
    closed_at: null, repos: ["St-John-Software/claws"], labels: [], dedupe_keys: [], importPending: false, kind: "issue",
    ...patch,
  } as never;
}

beforeEach(() => {
  vi.mocked(db.listFrictionRetrospectives).mockReset().mockResolvedValue([
    { issueId: CUR, triagedAt: "2026-11-25 05:00:00", noteCount: 40 },
    { issueId: PREV, triagedAt: "2026-11-11 05:00:00", noteCount: 30 },
  ]);
  vi.mocked(db.getClawsIssue).mockReset().mockImplementation(async (id: string) =>
    id === PREV ? issue({ id: PREV, title: "Fortnightly retrospective: old", state: "closed", created_at: "2026-11-11 05:00:00" })
    : id === CUR ? issue({ id: CUR, title: "Fortnightly retrospective: new", created_at: "2026-11-25 05:00:00" })
    : undefined);
  vi.mocked(db.listClawsIssues).mockReset().mockResolvedValue([]);
  vi.mocked(db.listClawsPrsForIssue).mockReset().mockResolvedValue([]);
});

describe("loadRetroTriageContext", () => {
  it("is null for an issue that is not a retrospective", async () => {
    expect(await loadRetroTriageContext("clw_01OTHER")).toBeNull();
    expect(db.listClawsIssues).not.toHaveBeenCalled();
  });

  it("has no previous retrospective for the first one", async () => {
    const ctx = await loadRetroTriageContext(PREV);
    // PREV is the older entry in the list above, so it has no previous one.
    expect(ctx).not.toBeNull();
    expect(ctx!.previous).toBeNull();
    expect(ctx!.previousFollowUps).toEqual([]);
  });

  it("matches follow-ups by a body mention created at or after the retrospective, and reads their PRs", async () => {
    vi.mocked(db.listClawsIssues).mockResolvedValue([
      issue({ id: "clw_B", title: "cold Rust shell", body: `From friction retrospective #${PREV.toLowerCase()}`, state: "closed", state_reason: "completed", closed_at: "2026-11-20 05:08:00", created_at: "2026-11-13 00:00:00" }),
      issue({ id: "clw_A", title: "task validate", body: `From friction retrospective #${PREV}`, created_at: "2026-11-12 00:00:00" }),
      issue({ id: "clw_C", title: "unrelated", body: "nothing here", created_at: "2026-11-12 00:00:00" }),
      issue({ id: "clw_D", title: "too early", body: `cites #${CUR}`, created_at: "2026-11-24 00:00:00" }),
      issue({ id: "clw_E", title: "from current", body: `From friction retrospective #${CUR} (notes 1, 2)`, created_at: "2026-11-25 06:00:00" }),
      issue({ id: CUR, title: "the retro itself", body: `mentions #${PREV}`, created_at: "2026-11-25 05:00:00" }),
    ]);
    vi.mocked(db.listClawsPrsForIssue).mockImplementation(async (id: string) =>
      id === "clw_B" ? [{ repo: "St-John-Software/fleet-infra", prNumber: 12, stage: "merged", updatedAt: "2026-11-20T05:07:00.000Z" }] as never : []);

    const ctx = (await loadRetroTriageContext(CUR))!;

    expect(vi.mocked(db.listClawsIssues).mock.calls[0]![0]).toMatchObject({ state: "all", range: { field: "created_at", from: new Date("2026-11-11T05:00:00Z") } });
    expect(ctx.previous).toEqual({ id: PREV, title: "Fortnightly retrospective: old", state: "closed", createdAt: "2026-11-11 05:00:00" });
    expect(ctx.previousFollowUps.map((f) => f.id)).toEqual(["clw_A", "clw_B"]);
    expect(ctx.previousFollowUps[1]!.prs).toEqual([{ ref: "St-John-Software/fleet-infra#12", stage: "merged", mergedAt: "2026-11-20T05:07:00.000Z" }]);
    expect(ctx.currentFollowUps.map((f) => f.id)).toEqual(["clw_E"]);
  });
});

function followUp(patch: Partial<RetroFollowUp>): RetroFollowUp {
  return { id: "clw_A", title: "Fix it", repos: ["org/a"], state: "open", stateReason: null, closedAt: null, prs: [], ...patch };
}

describe("buildRetroOpeningMessage", () => {
  const base = {
    issueId: CUR,
    title: "Fortnightly retrospective: new",
    context: {
      previous: { id: PREV, title: "Fortnightly retrospective: old", state: "closed", createdAt: "2026-11-11 05:00:00" },
      previousFollowUps: [
        followUp({ id: "clw_B", state: "closed", stateReason: "completed", closedAt: "2026-11-20 05:08:00", prs: [{ ref: "owner/repo#12", stage: "merged", mergedAt: "2026-11-20T05:07:00.000Z" }] }),
        followUp({ id: "clw_C" }),
      ],
      currentFollowUps: [],
    },
  };

  it("opens with the id, lists the previous retrospective's follow-ups and asks for the triage table", () => {
    const msg = buildRetroOpeningMessage(base);
    expect(msg.split("\n")[0]).toBe(`#${CUR}`);
    expect(msg).toContain("Previous retrospective");
    expect(msg).toContain(`#${PREV}: Fortnightly retrospective: old (closed, filed 2026-11-11 05:00 UTC)`);
    expect(msg).toContain("- #clw_B [org/a] Fix it: closed completed 2026-11-20 05:08 UTC; PRs: owner/repo#12 merged 2026-11-20 05:07 UTC");
    expect(msg).toContain("- #clw_C [org/a] Fix it: open; PRs: none");
    expect(msg).toContain("none yet");
    expect(msg).toContain("Do not edit files, push, comment");
    expect(msg).toContain("Proposal | Verdict (file / skip as solved / already tracked) | Overlapping issue or PR | Notes still live | Notes before the fix");
    expect(msg).toContain("wait for the operator's next message before filing anything");
    expect(msg).toContain(`From friction retrospective #${CUR} (notes …)`);
  });

  it("says when there is no previous retrospective", () => {
    const msg = buildRetroOpeningMessage({ ...base, context: { previous: null, previousFollowUps: [], currentFollowUps: [] } });
    expect(msg).toContain("none: this is the first");
  });

  it("lists at most 40 follow-ups and cuts long titles", () => {
    const many = Array.from({ length: MAX_RETRO_FOLLOW_UPS + 3 }, (_, i) => followUp({ id: `clw_${i}`, title: "y".repeat(300) }));
    const msg = buildRetroOpeningMessage({ ...base, context: { ...base.context, previousFollowUps: many } });
    expect(msg).toContain(`#clw_${MAX_RETRO_FOLLOW_UPS - 1} `);
    expect(msg).not.toContain(`#clw_${MAX_RETRO_FOLLOW_UPS} `);
    expect(msg).toContain("- and 3 more");
    expect(msg).toContain(`${"y".repeat(119)}…:`);
    expect(msg).not.toContain("y".repeat(120));
  });
});
