import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockGh } = vi.hoisted(() => ({
  mockGh: {
    listPRsCrossReferencingIssue: vi.fn(),
    isAllowedActor: vi.fn(),
  },
}));

vi.mock("./github.js", () => mockGh);

import {
  parsePhaseMarker,
  referencesIssue,
  parsePhaseClaims,
  computePhaseCoverage,
  loadPhaseCoverage,
  PHASE_CLAIM_RE,
} from "./phase-coverage.js";

/** The real production-infra#1313 timeline that motivated #2594. */
const PRS_1313 = [
  { number: 1357, title: "fix(#1313): Provision the 50 GB volume + cutover workflow (1/4)", body: "## PR 1 of 4: Provision\n\nPart of #1313", state: "merged" as const },
  { number: 1400, title: "fix(#1313): Flip the PV and chart to the new 50 GB volume (2/4)", body: "## PR 2 of 4: Flip\n\nPart of #1313", state: "merged" as const },
  { number: 1402, title: "fix(#1313): Flip the PV and the chart … (2/4)", body: "## PR 2 of 4: Flip\n\nPart of #1313", state: "merged" as const },
  { number: 1410, title: "chore(#1313): disarm the retired 200 GB supabase_db volume (3/4)", body: "## PR 3 of 4: Disarm\n\nPart of #1313", state: "open" as const },
  { number: 1411, title: "chore(#1313): destroy the retired 200 GB supabase_db volume (4/4)", body: "## PR 4 of 4: Destroy\n\nCloses #1313", state: "open" as const },
  { number: 1416, title: "fix(#1313): Disarm the old volume (3/4)", body: "## PR 3 of 4: Disarm\n\nPart of #1313", state: "closed" as const },
  { number: 1405, title: "fix(#1313): accept postgres-data/ PGDATA layout", body: "Part of #1313", state: "merged" as const },
];

describe("parsePhaseMarker", () => {
  it("reads a trailing (N/M) title suffix", () => {
    expect(parsePhaseMarker("fix(#1313): Flip the PV (2/4)", "", 4)).toBe(2);
  });

  it("tolerates spaces around the slash", () => {
    expect(parsePhaseMarker("fix(#1): thing (3 / 4)", "", 4)).toBe(3);
  });

  it("falls back to a '## PR N of M:' body header", () => {
    expect(parsePhaseMarker("fix(#1313): Flip the PV", "## PR 2 of 4: Flip the PV\n\nPart of #1313", 4)).toBe(2);
  });

  it("returns null when the denominator does not match totalPhases", () => {
    expect(parsePhaseMarker("fix(#1313): Flip the PV (2/4)", "", 5)).toBeNull();
  });

  it("returns null when there is no marker at all", () => {
    expect(parsePhaseMarker("fix(#1313): accept PGDATA layout", "Part of #1313", 4)).toBeNull();
  });

  it("returns null for an out-of-range phase number", () => {
    expect(parsePhaseMarker("thing (0/4)", "", 4)).toBeNull();
  });

  it("ignores a (N/M) that is not at the end of the title", () => {
    expect(parsePhaseMarker("fix: bump ratio (16/9) in the player", "", 9)).toBeNull();
  });
});

describe("referencesIssue", () => {
  it("matches a #N in the title", () => {
    expect(referencesIssue({ title: "fix(#1313): thing", body: "" }, 1313)).toBe(true);
  });

  it("matches a closing keyword in the body", () => {
    expect(referencesIssue({ title: "thing", body: "Closes #1313" }, 1313)).toBe(true);
    expect(referencesIssue({ title: "thing", body: "Part of #1313" }, 1313)).toBe(true);
  });

  it("does not match a longer number with the same prefix", () => {
    expect(referencesIssue({ title: "fix(#13130): thing", body: "Part of #13131" }, 1313)).toBe(false);
  });

  it("does not match a shorter, unrelated issue number", () => {
    expect(referencesIssue({ title: "fix(#131): thing", body: "Part of #131" }, 1313)).toBe(false);
  });

  it("does not match a bare #N buried in the body with no keyword", () => {
    expect(referencesIssue({ title: "thing", body: "see also #1313" }, 1313)).toBe(false);
  });
});

describe("parsePhaseClaims", () => {
  const trustAll = async () => true;

  it("expands a comma list", async () => {
    const claims = await parsePhaseClaims([{ body: "claws-phase-done: 1,3", login: "stjohnb" }], trustAll, 4);
    expect([...claims].sort()).toEqual([1, 3]);
  });

  it("expands a hyphen range", async () => {
    const claims = await parsePhaseClaims([{ body: "claws-phase-done: 3-4", login: "stjohnb" }], trustAll, 4);
    expect([...claims].sort()).toEqual([3, 4]);
  });

  it("drops numbers outside 1..totalPhases", async () => {
    const claims = await parsePhaseClaims([{ body: "claws-phase-done: 1-9", login: "stjohnb" }], trustAll, 3);
    expect([...claims].sort()).toEqual([1, 2, 3]);
  });

  it("clamps an absurd hyphen range instead of looping over it", async () => {
    // A typo like `1-99999999999` used to be iterated in full before the
    // 1..totalPhases filter ran, hanging the whole process. This must return
    // immediately, so the test times out rather than passing slowly if it regresses.
    const claims = await parsePhaseClaims([{ body: "claws-phase-done: 1-99999999999", login: "stjohnb" }], trustAll, 3);
    expect([...claims].sort()).toEqual([1, 2, 3]);
  });

  it("ignores a reversed or below-range hyphen range", async () => {
    expect((await parsePhaseClaims([{ body: "claws-phase-done: 4-2", login: "stjohnb" }], trustAll, 4)).size).toBe(0);
    expect([...await parsePhaseClaims([{ body: "claws-phase-done: 0-2", login: "stjohnb" }], trustAll, 4)].sort()).toEqual([1, 2]);
  });

  it("ignores claims from untrusted logins", async () => {
    const claims = await parsePhaseClaims([{ body: "claws-phase-done: 1,2", login: "drive-by" }], async () => false, 4);
    expect(claims.size).toBe(0);
  });

  it("does not match the documentation placeholder", async () => {
    const claims = await parsePhaseClaims([{ body: "comment `claws-phase-done: <numbers>` to mark steps", login: "stjohnb" }], trustAll, 4);
    expect(claims.size).toBe(0);
    expect(PHASE_CLAIM_RE.test("claws-phase-done: <numbers>")).toBe(false);
  });
});

describe("computePhaseCoverage", () => {
  it("reproduces legacy behaviour when nothing else is present", () => {
    const c = computePhaseCoverage({ totalPhases: 4, legacyMergedPRs: [{ number: 901, title: "legacy 1" }], prs: [], issueNumber: 1313, claims: new Set() });
    expect([...c.covered]).toEqual([1]);
    expect(c.nextPhase).toBe(2);
    expect(c.lastMergedPhase).toBe(1);
    // Legacy merged PRs still name the phase they covered, so progress comments
    // and plan validation keep working when no marker is readable.
    expect(c.coveringPRs.get(1)).toEqual({ number: 901, title: "legacy 1", state: "merged" });
  });

  it("lets an explicit marker override the legacy positional guess", () => {
    const c = computePhaseCoverage({
      totalPhases: 4,
      legacyMergedPRs: [{ number: 901, title: "legacy 1" }],
      prs: [PRS_1313[0]],
      issueNumber: 1313,
      claims: new Set(),
    });
    expect(c.coveringPRs.get(1)?.number).toBe(1357);
  });

  it("does not let an open marker PR downgrade the merged PR a legacy entry names", () => {
    const c = computePhaseCoverage({
      totalPhases: 4,
      legacyMergedPRs: [{ number: 901, title: "legacy 1" }],
      // A stale duplicate branch re-marking phase 1 while still open.
      prs: [{ number: 950, title: "fix(#1313): Provision, take two (1/4)", body: "Part of #1313", state: "open" }],
      issueNumber: 1313,
      claims: new Set(),
    });
    expect(c.coveringPRs.get(1)).toEqual({ number: 901, title: "legacy 1", state: "merged" });
    expect(c.lastMergedPhase).toBe(1);
  });

  it("covers all four phases of production-infra#1313 (the #2594 regression)", () => {
    const c = computePhaseCoverage({ totalPhases: 4, legacyMergedPRs: [{ number: 901, title: "legacy 1" }], prs: PRS_1313, issueNumber: 1313, claims: new Set() });
    expect([...c.covered].sort()).toEqual([1, 2, 3, 4]);
    expect(c.nextPhase).toBeNull();
    expect(c.coveringPRs.get(3)).toEqual({ number: 1410, title: PRS_1313[3].title, state: "open" });
    expect(c.lastMergedPhase).toBe(2);
  });

  it("mid-timeline (only #1357 and the human #1400 merged) advances to phase 3, not 2", () => {
    const c = computePhaseCoverage({
      totalPhases: 4,
      legacyMergedPRs: [{ number: 901, title: "legacy 1" }],
      prs: [PRS_1313[0], PRS_1313[1]],
      issueNumber: 1313,
      claims: new Set(),
    });
    expect(c.nextPhase).toBe(3);
    expect(c.lastMergedPhase).toBe(2);
  });

  it("excludes closed-unmerged PRs so closing a bad duplicate reopens its phase", () => {
    const c = computePhaseCoverage({
      totalPhases: 4,
      legacyMergedPRs: [{ number: 901, title: "legacy 1" }, { number: 902, title: "legacy 2" }],
      prs: [PRS_1313[5]],
      issueNumber: 1313,
      claims: new Set(),
    });
    expect(c.covered.has(3)).toBe(false);
    expect(c.nextPhase).toBe(3);
  });

  it("prefers a merged covering PR over an open one for the same phase", () => {
    const c = computePhaseCoverage({
      totalPhases: 4,
      legacyMergedPRs: [],
      prs: [
        { number: 10, title: "fix(#5): a (2/4)", body: "Part of #5", state: "open" },
        { number: 11, title: "fix(#5): a (2/4)", body: "Part of #5", state: "merged" },
      ],
      issueNumber: 5,
      claims: new Set(),
    });
    expect(c.coveringPRs.get(2)?.number).toBe(11);
    expect(c.lastMergedPhase).toBe(2);
  });

  it("ignores PRs that do not reference the issue", () => {
    const c = computePhaseCoverage({
      totalPhases: 4,
      legacyMergedPRs: [],
      prs: [{ number: 99, title: "chore: unrelated (2/4)", body: "no reference", state: "merged" }],
      issueNumber: 1313,
      claims: new Set(),
    });
    expect(c.covered.size).toBe(0);
    expect(c.nextPhase).toBe(1);
  });

  it("honours claims for phases with no PR, leaving no covering PR", () => {
    const c = computePhaseCoverage({ totalPhases: 4, legacyMergedPRs: [{ number: 901, title: "legacy 1" }, { number: 902, title: "legacy 2" }], prs: [], issueNumber: 1313, claims: new Set([3, 4]) });
    expect(c.nextPhase).toBeNull();
    expect(c.coveringPRs.has(3)).toBe(false);
    expect(c.lastMergedPhase).toBe(2);
  });

  it("reports a phase covered only by an open PR as pending, so the next phase waits", () => {
    const c = computePhaseCoverage({
      totalPhases: 4,
      legacyMergedPRs: [{ number: 901, title: "legacy 1" }],
      prs: [PRS_1313[3]],
      issueNumber: 1313,
      claims: new Set([2]),
    });
    // Phase 3's only coverage is open PR #1410: nextPhase is 4, but starting it
    // would branch off a default branch without phase 3 in it.
    expect(c.nextPhase).toBe(4);
    expect(c.pendingPhases).toEqual([3]);
  });

  it("leaves pendingPhases empty when every earlier phase is merged or claimed", () => {
    const c = computePhaseCoverage({
      totalPhases: 4,
      legacyMergedPRs: [{ number: 901, title: "legacy 1" }],
      prs: [PRS_1313[1]],
      issueNumber: 1313,
      claims: new Set([3]),
    });
    expect(c.nextPhase).toBe(4);
    expect(c.pendingPhases).toEqual([]);
  });

  it("keeps a phase covered only by an open PR out of `done`", () => {
    const c = computePhaseCoverage({
      totalPhases: 4,
      legacyMergedPRs: [{ number: 901, title: "legacy 1" }, { number: 902, title: "legacy 2" }],
      // Phase 4 has an open PR carrying a valid (4/4) marker; phase 3 has none.
      prs: [{ number: 950, title: "fix(#1313): Final wiring (4/4)", body: "Part of #1313", state: "open" }],
      issueNumber: 1313,
      claims: new Set(),
    });
    expect(c.nextPhase).toBe(3);
    expect(c.covered.has(4)).toBe(true);
    // Phase 4 is not finished work — the phase-3 PR must not claim `Closes`.
    expect(c.done.has(4)).toBe(false);
    expect([...c.done].sort()).toEqual([1, 2]);
  });

  it("counts merged PRs and claims as done", () => {
    const c = computePhaseCoverage({
      totalPhases: 4,
      legacyMergedPRs: [{ number: 901, title: "legacy 1" }],
      prs: [PRS_1313[1]],
      issueNumber: 1313,
      claims: new Set([4]),
    });
    expect([...c.done].sort()).toEqual([1, 2, 4]);
  });

  it("leaves nextPhase at the lowest gap when coverage is non-contiguous", () => {
    const c = computePhaseCoverage({ totalPhases: 4, legacyMergedPRs: [{ number: 901, title: "legacy 1" }, { number: 902, title: "legacy 2" }], prs: [], issueNumber: 1313, claims: new Set([4]) });
    expect(c.nextPhase).toBe(3);
    expect(c.covered.has(4)).toBe(true);
  });

  describe("markerMismatches", () => {
    const merged = (title: string, state: "merged" | "open" = "merged", body = "Part of #1313") =>
      ({ number: 309, title, body, state }) as const;

    it("flags a merged (1/2) PR against a plan that now has one phase", () => {
      const c = computePhaseCoverage({
        totalPhases: 1,
        legacyMergedPRs: [],
        prs: [merged("feat(#1313): sops recipients (1/2)")],
        issueNumber: 1313,
        claims: new Set(),
      });
      expect(c.markerMismatches).toEqual([{ number: 309, title: "feat(#1313): sops recipients (1/2)", phase: 1, markerTotal: 2 }]);
    });

    it("flags a merged body-form `## PR 1 of 2` marker against a one-phase plan", () => {
      const c = computePhaseCoverage({
        totalPhases: 1,
        legacyMergedPRs: [],
        prs: [merged("feat(#1313): sops recipients", "merged", "## PR 1 of 2: recipients\n\nPart of #1313")],
        issueNumber: 1313,
        claims: new Set(),
      });
      expect(c.markerMismatches.map((m) => m.markerTotal)).toEqual([2]);
      expect(c.markerMismatches.map((m) => m.phase)).toEqual([1]);
    });

    it("does not flag a marker whose denominator matches the plan", () => {
      const c = computePhaseCoverage({
        totalPhases: 2,
        legacyMergedPRs: [],
        prs: [merged("feat(#1313): sops recipients (1/2)")],
        issueNumber: 1313,
        claims: new Set(),
      });
      expect(c.markerMismatches).toEqual([]);
    });

    it("does not flag a plan that grew phases since the marker was written", () => {
      const c = computePhaseCoverage({
        totalPhases: 3,
        legacyMergedPRs: [],
        prs: [merged("feat(#1313): sops recipients (1/2)")],
        issueNumber: 1313,
        claims: new Set(),
      });
      expect(c.markerMismatches).toEqual([]);
    });

    it("distinguishes two mismatched PRs sharing a markerTotal by phase", () => {
      const c = computePhaseCoverage({
        totalPhases: 1,
        legacyMergedPRs: [],
        prs: [
          { number: 309, title: "feat(#1313): sops recipients (1/2)", body: "Part of #1313", state: "merged" },
          { number: 310, title: "feat(#1313): sops rotation (2/2)", body: "Part of #1313", state: "merged" },
        ],
        issueNumber: 1313,
        claims: new Set(),
      });
      expect(c.markerMismatches).toEqual([
        { number: 309, title: "feat(#1313): sops recipients (1/2)", phase: 1, markerTotal: 2 },
        { number: 310, title: "feat(#1313): sops rotation (2/2)", phase: 2, markerTotal: 2 },
      ]);
    });

    it("does not flag an open PR — nothing has shipped against the old numbering", () => {
      const c = computePhaseCoverage({
        totalPhases: 1,
        legacyMergedPRs: [],
        prs: [merged("feat(#1313): sops recipients (1/2)", "open")],
        issueNumber: 1313,
        claims: new Set(),
      });
      expect(c.markerMismatches).toEqual([]);
    });
  });
});

describe("loadPhaseCoverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([]);
    mockGh.isAllowedActor.mockResolvedValue(true);
  });

  it("combines cross-referenced PRs with claim comments", async () => {
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue(
      PRS_1313.slice(0, 2).map((pr) => ({ ...pr, login: "someone" })),
    );
    const coverage = await loadPhaseCoverage("o/r", 1313, 4, [{ body: "claws-phase-done: 3,4", login: "stjohnb" }], [{ number: 1357, title: "legacy 1" }]);
    expect(coverage.nextPhase).toBeNull();
  });

  it("degrades to the legacy merged count when the timeline lookup throws", async () => {
    mockGh.listPRsCrossReferencingIssue.mockRejectedValue(new Error("boom"));
    const coverage = await loadPhaseCoverage("o/r", 1313, 4, [], [{ number: 1357, title: "legacy 1" }, { number: 1400, title: "legacy 2" }]);
    expect(coverage.nextPhase).toBe(3);
    expect(coverage.lastMergedPhase).toBe(2);
  });

  it("does not consult isAllowedActor for comments without a claim marker", async () => {
    await loadPhaseCoverage("o/r", 1313, 4, [{ body: "just a status update", login: "stjohnb" }], [{ number: 1357, title: "legacy 1" }]);
    expect(mockGh.isAllowedActor).not.toHaveBeenCalled();
  });
});
