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
    isClawsComment: vi.fn((body: string) => /\*— Automated by Claws/.test(body)),
  },
}));

vi.mock("./github.js", () => mockGh);

// Only what `imported-refs.ts` needs — the alias index itself stays real, since
// the point of these cases is that `loadPhaseCoverage` hands the aliases down.
vi.mock("./db.js", () => ({ recordImportedIssue: vi.fn(async () => true), listImportedIssues: vi.fn(async () => []) }));

import { recordImport, resetImportedRefsForTest } from "./imported-refs.js";
import {
  parsePhaseMarker,
  referencesIssue,
  closesIssue,
  extractClosedIssueRefs,
  parsePhaseClaims,
  computePhaseCoverage,
  finishCoverage,
  loadPhaseCoverage,
  isPhaseClaimOnly,
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

  it("reads a title with no issue ref, ref carried in the body instead", () => {
    expect(parsePhaseMarker("fix: Flip the PV (2/4)", "Part of #1313", 4)).toBe(2);
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

  it("matches a title with no issue ref via the body's 'Part of' keyword", () => {
    expect(referencesIssue({ title: "fix: thing (2/4)", body: "Part of #1313" }, 1313)).toBe(true);
  });
});

describe("closesIssue", () => {
  it("matches 'Fixes #N'", () => {
    expect(closesIssue("Fixes #1960", 1960)).toBe(true);
  });

  it("matches 'resolved #N'", () => {
    expect(closesIssue("This is resolved #1960", 1960)).toBe(true);
  });

  it("matches lowercase 'closes #N'", () => {
    expect(closesIssue("closes #1960", 1960)).toBe(true);
  });

  it("does not match 'owner/repo#N'", () => {
    expect(closesIssue("Closes owner/repo#1960", 1960)).toBe(false);
  });

  it("does not match a bare reference with no closing keyword", () => {
    expect(closesIssue("Part of #1960", 1960)).toBe(false);
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

  // #3154: a marker only counts when it is asserted, never when it is quoted or
  // described. Every case below is a real shape seen on whyrr#21, where two bot
  // comments *explaining how a human retires step 3* claimed step 3 themselves.
  it("ignores a claim inside a fenced code block", async () => {
    const body = "To retire step 3, comment on this issue:\n\n```\nclaws-phase-done: 3\n```\n";
    expect((await parsePhaseClaims([{ body, login: "stjohnb" }], trustAll, 3)).size).toBe(0);
  });

  it("ignores a claim inside a blockquote", async () => {
    const body = "They asked me to post:\n\n> claws-phase-done: 3\n";
    expect((await parsePhaseClaims([{ body, login: "stjohnb" }], trustAll, 3)).size).toBe(0);
  });

  it("ignores a claim mentioned mid-sentence in prose", async () => {
    const body = "Step 3 is human-only. It is retired by a `claws-phase-done: 3` comment on this issue, not by a PR.";
    expect((await parsePhaseClaims([{ body, login: "stjohnb" }], trustAll, 3)).size).toBe(0);
  });

  it("ignores a claim in a comment carrying the Automated by Claws footer", async () => {
    const body = "*— Automated by Claws · Planner —*\n\nclaws-phase-done: 3\n";
    expect((await parsePhaseClaims([{ body, login: "clawsstjohn" }], trustAll, 3)).size).toBe(0);
  });

  it("still honours a bare line-anchored claim from an allowed actor", async () => {
    const claims = await parsePhaseClaims([{ body: "claws-phase-done: 3\n", login: "stjohnb" }], trustAll, 3);
    expect([...claims]).toEqual([3]);
  });

  it("still honours a claim that carries feedback after the step number", async () => {
    const body = "claws-phase-done: 1 — also please rename X";
    expect([...await parsePhaseClaims([{ body, login: "stjohnb" }], trustAll, 3)]).toEqual([1]);
    expect(isPhaseClaimOnly(body)).toBe(false);
  });

  it("reads the whyrr#21 comment pair as claiming nothing", async () => {
    // Reconstructed: the bodies on the live issue were hand-edited to a <n>
    // placeholder after the incident, so they cannot be re-fetched.
    const operatorInstructions = [
      "Step 3 is one-time Apple Developer setup a bot cannot do. To retire it:",
      "",
      "```",
      "claws-phase-done: 3",
      "```",
    ].join("\n");
    const planComment = [
      "*— Automated by Claws · Planner —*",
      "",
      "## Implementation Plan",
      "",
      "8. Step 3 is human-only. It is retired by a `claws-phase-done: 3` comment naming step 3.",
    ].join("\n");
    const claims = await parsePhaseClaims(
      [{ body: operatorInstructions, login: "clawsstjohn" }, { body: planComment, login: "clawsstjohn" }],
      trustAll,
      3,
    );
    expect(claims.has(3)).toBe(false);
    expect(claims.size).toBe(0);
  });
});

describe("isPhaseClaimOnly", () => {
  it("is true for a bare claim and false when feedback rides along", () => {
    expect(isPhaseClaimOnly("claws-phase-done: 1")).toBe(true);
    expect(isPhaseClaimOnly("claws-phase-done: 1 — also please rename X")).toBe(false);
  });

  it("is false for a quoted claim, so the comment still reaches the planner as feedback", () => {
    expect(isPhaseClaimOnly("> claws-phase-done: 1")).toBe(false);
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

  it("covers a phase from a new-shape PR title with no issue ref, via the body", () => {
    const c = computePhaseCoverage({
      totalPhases: 4,
      legacyMergedPRs: [],
      prs: [
        { number: 2000, title: "fix: Final wiring (4/4)", body: "## PR 4 of 4: Final wiring\n\nCloses #1313", state: "merged" },
      ],
      issueNumber: 1313,
      claims: new Set(),
    });
    expect(c.covered.has(4)).toBe(true);
    expect(c.coveringPRs.get(4)).toEqual({ number: 2000, title: "fix: Final wiring (4/4)", state: "merged" });
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

  it("reports a phase covered only by an open PR as open, so the next phase waits", () => {
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
    expect(c.openPhases).toEqual([3]);
    expect(c.readyPhases).toEqual([]);
  });

  it("makes the next phase ready when every earlier phase is merged or claimed", () => {
    const c = computePhaseCoverage({
      totalPhases: 4,
      legacyMergedPRs: [{ number: 901, title: "legacy 1" }],
      prs: [PRS_1313[1]],
      issueNumber: 1313,
      claims: new Set([3]),
    });
    expect(c.nextPhase).toBe(4);
    expect(c.openPhases).toEqual([]);
    expect(c.readyPhases).toEqual([4]);
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

  it("uses legacy PR markers rather than API order for perudo#307", () => {
    const c = computePhaseCoverage({
      totalPhases: 2,
      legacyMergedPRs: [
        {
          number: 309,
          title: "fix(#307): Move deploy + infra onto Forgejo Actions and delete the GitHub copies (2/2)",
          body: "## PR 2 of 2: Move\n\nPart of #307",
        },
        {
          number: 308,
          title: "fix(#307): Add the Forgejo OIDC provider reference and dual-trust the three IAM roles (1/2)",
          body: "## PR 1 of 2: Add\n\nPart of #307",
        },
      ],
      prs: [],
      issueNumber: 307,
      claims: new Set(),
    });
    expect(c.coveringPRs.get(1)?.number).toBe(308);
    expect(c.coveringPRs.get(2)?.number).toBe(309);
    expect(c.nextPhase).toBeNull();
    expect(c.lastMergedPhase).toBe(2);
    expect([...c.done].sort()).toEqual([1, 2]);
  });

  it("uses a body-only marker on a legacy PR", () => {
    const c = computePhaseCoverage({
      totalPhases: 2,
      legacyMergedPRs: [{ number: 309, title: "fix(#307): Move deploy", body: "## PR 2 of 2: Move\n\nPart of #307" }],
      prs: [],
      issueNumber: 307,
      claims: new Set(),
    });
    expect(c.coveringPRs.get(2)).toEqual({ number: 309, title: "fix(#307): Move deploy", state: "merged" });
    expect(c.covered.has(1)).toBe(false);
    expect(c.nextPhase).toBe(1);
  });

  it("fills unmarked legacy PRs into the lowest remaining slots after marked ones", () => {
    const c = computePhaseCoverage({
      totalPhases: 3,
      legacyMergedPRs: [
        { number: 5, title: "chore: unmarked" },
        { number: 4, title: "fix(#9): b (2/3)" },
      ],
      prs: [],
      issueNumber: 9,
      claims: new Set(),
    });
    expect(c.coveringPRs.get(1)?.number).toBe(5);
    expect(c.coveringPRs.get(2)?.number).toBe(4);
    expect(c.covered.has(3)).toBe(false);
    expect(c.nextPhase).toBe(3);
  });

  it("fills unmarked legacy PRs in PR-number order regardless of input order", () => {
    const c = computePhaseCoverage({
      totalPhases: 2,
      legacyMergedPRs: [
        { number: 902, title: "legacy 2" },
        { number: 901, title: "legacy 1" },
      ],
      prs: [],
      issueNumber: 1313,
      claims: new Set(),
    });
    expect(c.coveringPRs.get(1)?.number).toBe(901);
    expect(c.coveringPRs.get(2)?.number).toBe(902);
  });

  it("does not let a stale open PR displace a legacy PR placed by its own marker", () => {
    const c = computePhaseCoverage({
      totalPhases: 2,
      legacyMergedPRs: [{ number: 308, title: "fix(#307): a (1/2)", body: "Part of #307" }],
      prs: [{ number: 400, title: "fix(#307): a, take two (1/2)", body: "Part of #307", state: "open" }],
      issueNumber: 307,
      claims: new Set(),
    });
    expect(c.coveringPRs.get(1)).toEqual({ number: 308, title: "fix(#307): a (1/2)", state: "merged" });
  });

  it("reports stale phase markers from legacy PRs and dedupes timeline copies", () => {
    const c = computePhaseCoverage({
      totalPhases: 1,
      legacyMergedPRs: [{ number: 309, title: "fix(#1313): x (2/3)", body: "Part of #1313" }],
      prs: [],
      issueNumber: 1313,
      claims: new Set(),
    });
    expect(c.markerMismatches).toEqual([{ number: 309, title: "fix(#1313): x (2/3)", phase: 2, markerTotal: 3 }]);

    const deduped = computePhaseCoverage({
      totalPhases: 1,
      legacyMergedPRs: [{ number: 309, title: "fix(#1313): x (2/3)", body: "Part of #1313" }],
      prs: [{ number: 309, title: "fix(#1313): x (2/3)", body: "Part of #1313", state: "merged" }],
      issueNumber: 1313,
      claims: new Set(),
    });
    expect(deduped.markerMismatches).toEqual([{ number: 309, title: "fix(#1313): x (2/3)", phase: 2, markerTotal: 3 }]);
  });

  it("keeps the first duplicate legacy marker and leaves the duplicate phase uncovered", () => {
    const c = computePhaseCoverage({
      totalPhases: 2,
      legacyMergedPRs: [
        { number: 308, title: "fix(#307): a (1/2)", body: "Part of #307" },
        { number: 309, title: "fix(#307): a, retry (1/2)", body: "Part of #307" },
      ],
      prs: [],
      issueNumber: 307,
      claims: new Set(),
    });
    expect(c.coveringPRs.get(1)?.number).toBe(308);
    expect(c.covered.has(2)).toBe(false);
    expect(c.nextPhase).toBe(2);
  });

  describe("single-phase target-PR coverage (#3050)", () => {
    it("covers phase 1 via an open unmarked PR that closes the issue", () => {
      const c = computePhaseCoverage({
        totalPhases: 1,
        legacyMergedPRs: [],
        prs: [{ number: 1959, title: "fix: resolve #1958 — thing", body: "Implements the fix.\n\nCloses #1960", state: "open" }],
        issueNumber: 1960,
        claims: new Set(),
      });
      expect(c.nextPhase).toBeNull();
      expect(c.covered.has(1)).toBe(true);
      expect(c.coveringPRs.get(1)).toEqual({ number: 1959, state: "open", title: "fix: resolve #1958 — thing" });
      expect(c.done.size).toBe(0);
      expect(c.openPhases).toEqual([1]);
    });

    it("does not cover phase 1 once the target PR is closed unmerged", () => {
      const c = computePhaseCoverage({
        totalPhases: 1,
        legacyMergedPRs: [],
        prs: [{ number: 1959, title: "fix: resolve #1958 — thing", body: "Closes #1960", state: "closed" }],
        issueNumber: 1960,
        claims: new Set(),
      });
      expect(c.nextPhase).toBe(1);
    });

    it("does not apply the rule to a merged target PR with no legacy entry", () => {
      const c = computePhaseCoverage({
        totalPhases: 1,
        legacyMergedPRs: [],
        prs: [{ number: 1959, title: "fix: resolve #1958 — thing", body: "Closes #1960", state: "merged" }],
        issueNumber: 1960,
        claims: new Set(),
      });
      expect(c.nextPhase).toBe(1);
    });

    it("does not cover a 'Part of #N' body with no closing keyword", () => {
      const c = computePhaseCoverage({
        totalPhases: 1,
        legacyMergedPRs: [],
        prs: [{ number: 1959, title: "fix: thing", body: "Part of #1960", state: "open" }],
        issueNumber: 1960,
        claims: new Set(),
      });
      expect(c.nextPhase).toBe(1);
    });

    it("does not cover when the body closes a longer issue number", () => {
      const c = computePhaseCoverage({
        totalPhases: 1,
        legacyMergedPRs: [],
        prs: [{ number: 1959, title: "fix: thing", body: "Closes #19600", state: "open" }],
        issueNumber: 1960,
        claims: new Set(),
      });
      expect(c.nextPhase).toBe(1);
    });

    it("does not apply the rule to a multi-phase plan", () => {
      const c = computePhaseCoverage({
        totalPhases: 2,
        legacyMergedPRs: [],
        prs: [{ number: 1959, title: "fix: thing", body: "Closes #1960", state: "open" }],
        issueNumber: 1960,
        claims: new Set(),
      });
      expect(c.nextPhase).toBe(1);
      expect(c.covered.size).toBe(0);
    });

    it("keeps a legacy merged entry for phase 1 over an open closing PR", () => {
      const c = computePhaseCoverage({
        totalPhases: 1,
        legacyMergedPRs: [{ number: 1900, title: "fix(#1960): the actual fix" }],
        prs: [{ number: 1959, title: "fix: thing", body: "Closes #1960", state: "open" }],
        issueNumber: 1960,
        claims: new Set(),
      });
      expect(c.coveringPRs.get(1)).toEqual({ number: 1900, title: "fix(#1960): the actual fix", state: "merged" });
      expect(c.done.has(1)).toBe(true);
    });
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

describe("phase readiness", () => {
  const set = (...n: number[]) => new Set(n);

  it("reproduces the sequential gate with no dependency information", () => {
    // Every covered/done combination over three phases.
    for (let mask = 0; mask < 27; mask++) {
      const covered = new Set<number>();
      const done = new Set<number>();
      for (let n = 1; n <= 3; n++) {
        const state = Math.floor(mask / 3 ** (n - 1)) % 3; // 0 uncovered, 1 open, 2 done
        if (state > 0) covered.add(n);
        if (state === 2) done.add(n);
      }
      const c = finishCoverage(3, covered, done, done);
      // Ready only when every phase below the lowest uncovered one has landed.
      const next = c.nextPhase;
      const expected = next !== null && [...Array(next - 1).keys()].every((i) => done.has(i + 1)) ? [next] : [];
      expect(c.readyPhases).toEqual(expected);
    }
  });

  it("defaults each phase to depending on the previous one", () => {
    const c = finishCoverage(3, set(), set(), set());
    expect([...c.dependencies]).toEqual([[1, []], [2, [1]], [3, [2]]]);
    expect(c.readyPhases).toEqual([1]);
    expect(c.blockedPhases).toEqual([2, 3]);
  });

  it("makes independent phases ready while a sibling PR is open", () => {
    const c = finishCoverage(3, set(1), set(), set(), [null, [], [1]]);
    expect(c.openPhases).toEqual([1]);
    expect(c.readyPhases).toEqual([2]);
    expect(c.blockedPhases).toEqual([3]);
    // The legacy fields are untouched by dependencies.
    expect(c.nextPhase).toBe(2);
  });

  it("requires every phase in the transitive closure to be done", () => {
    // 3 → 2 → 1; phase 2 claimed done but phase 1 is only open.
    const blocked = finishCoverage(3, set(1, 2), set(2), set(), [null, [1], [2]]);
    expect(blocked.readyPhases).toEqual([]);
    expect(blocked.blockedPhases).toEqual([3]);
    expect(blocked.openPhases).toEqual([1]);

    const ready = finishCoverage(3, set(1, 2), set(1, 2), set(1, 2), [null, [1], [2]]);
    expect(ready.readyPhases).toEqual([3]);
  });

  it("ignores a declared dependency that does not name a lower phase", () => {
    const c = finishCoverage(3, set(), set(), set(), [[1], [2, 3], [3, 1]]);
    expect([...c.dependencies]).toEqual([[1, []], [2, []], [3, [1]]]);
    expect(c.readyPhases).toEqual([1, 2]);
  });

  it("threads dependsOn through computePhaseCoverage", () => {
    const c = computePhaseCoverage({
      totalPhases: 2,
      legacyMergedPRs: [],
      prs: [{ number: 5, title: "fix(#9): step one (1/2)", body: "Part of #9", state: "open" }],
      issueNumber: 9,
      claims: new Set(),
      dependsOn: [null, []],
    });
    expect(c.openPhases).toEqual([1]);
    expect(c.readyPhases).toEqual([2]);
  });
});

describe("loadPhaseCoverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    resetImportedRefsForTest();
  });

  it("counts a pre-import PR that only references the forge number", async () => {
    // `listPRsCrossReferencingIssue` fans out over the aliases to find these;
    // without the same alias set reaching `referencesIssue`, `computePhaseCoverage`
    // discarded every one of them one line later (#3245).
    const native = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    await recordImport("o/r", 1313, native);
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue(
      PRS_1313.slice(0, 2).map((pr) => ({ ...pr, login: "someone" })),
    );

    const coverage = await loadPhaseCoverage("o/r", native, 4, [], []);

    expect(coverage.nextPhase).toBe(3);
    expect(coverage.lastMergedPhase).toBe(2);
  });

  it("counts a pre-import open PR that closes the forge number on a single-phase plan", async () => {
    const native = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    await recordImport("o/r", 1313, native);
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
      { number: 1500, title: "fix: the thing", body: "Closes #1313", state: "open" as const, login: "stjohnb" },
    ]);

    const coverage = await loadPhaseCoverage("o/r", native, 1, [], []);

    expect(coverage.covered.has(1)).toBe(true);
    expect(coverage.coveringPRs.get(1)).toEqual({ number: 1500, title: "fix: the thing", state: "open" });
  });

  it("still ignores a PR referencing an unrelated issue after an import", async () => {
    const native = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    await recordImport("o/r", 1313, native);
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
      { number: 1600, title: "fix(#99): other (1/4)", body: "Part of #99", state: "merged" as const, login: "someone" },
    ]);

    const coverage = await loadPhaseCoverage("o/r", native, 4, [], []);

    expect(coverage.nextPhase).toBe(1);
    expect(coverage.lastMergedPhase).toBe(0);
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

describe("extractClosedIssueRefs", () => {
  const NATIVE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

  it("returns every closed reference in body order, de-duplicated", () => {
    expect(extractClosedIssueRefs(`Closes #12\n\nFixes #34\n\nResolves #12`)).toEqual([12, 34]);
  });

  it("canonicalises a lower-cased native id", () => {
    expect(extractClosedIssueRefs(`Closes #${NATIVE.toLowerCase()}`)).toEqual([NATIVE]);
  });

  it("does not read a longer id as a shorter one", () => {
    expect(extractClosedIssueRefs(`Closes #${NATIVE}X`)).toEqual([]);
    expect(extractClosedIssueRefs("Closes #1000001")).toEqual([1000001]);
  });

  it("ignores closing keywords inside quoted regions", () => {
    expect(extractClosedIssueRefs("```\nCloses #12\n```\n\n> Closes #34")).toEqual([]);
  });

  it("is what closesIssue answers from, for both ref shapes", () => {
    expect(closesIssue(`Closes #${NATIVE.toLowerCase()}`, NATIVE)).toBe(true);
    expect(closesIssue(`Closes #${NATIVE}`, NATIVE.toLowerCase())).toBe(true);
    expect(closesIssue("Closes #12", 12)).toBe(true);
    expect(closesIssue("Closes #12", NATIVE)).toBe(false);
    expect(closesIssue("```\nCloses #12\n```", 12)).toBe(false);
  });

  it("matches a native reference from referencesIssue too", () => {
    expect(referencesIssue({ title: `fix(#${NATIVE.toLowerCase()}): x`, body: "" }, NATIVE)).toBe(true);
  });

  it("matches a native reference via the body when the title carries no ref", () => {
    expect(referencesIssue({ title: "fix: x", body: `Closes #${NATIVE}` }, NATIVE)).toBe(true);
  });
});
