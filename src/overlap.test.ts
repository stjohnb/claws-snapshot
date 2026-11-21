import { describe, it, expect } from "vitest";
import {
  OVERLAP_GIVE_WAY_MS,
  compareInFlightSteps,
  filterIgnoredPaths,
  formatSharedPaths,
  givesWay,
  holdersAhead,
  normaliseOverlapPath,
  overlapPathError,
  pathsOverlap,
  sharedPaths,
  type InFlightStep,
} from "./overlap.js";

function step(overrides: Partial<InFlightStep> = {}): InFlightStep {
  return {
    issueId: "clw_A",
    position: 1,
    prNumber: null,
    hasOpenPr: false,
    priority: false,
    planApprovedAtMs: 1000,
    paths: ["src/a.ts"],
    holds: true,
    ...overrides,
  };
}

describe("pathsOverlap", () => {
  it("matches the same file", () => {
    expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true);
  });

  it("matches a directory prefix either way round", () => {
    expect(pathsOverlap("src", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/a.ts", "src")).toBe(true);
    expect(pathsOverlap("design", "design/x/y.png")).toBe(true);
  });

  it("does not match a sibling that only shares a name prefix", () => {
    expect(pathsOverlap("a/b", "a/bc")).toBe(false);
    expect(pathsOverlap("a/bc", "a/b")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(pathsOverlap("src/A.ts", "src/a.ts")).toBe(false);
  });
});

describe("sharedPaths", () => {
  it("keeps the narrower path of each overlapping pair, deduplicated and sorted", () => {
    expect(sharedPaths(["src", "docs/a.md"], ["src/z.ts", "src/b.ts", "docs/a.md", "README.md"])).toEqual(["docs/a.md", "src/b.ts", "src/z.ts"]);
  });

  it("is empty when nothing overlaps", () => {
    expect(sharedPaths(["a/b"], ["a/bc"])).toEqual([]);
  });
});

describe("overlapPathError and normaliseOverlapPath", () => {
  it("accepts a repo-relative path", () => {
    expect(overlapPathError("src/overlap.ts")).toBeNull();
    expect(overlapPathError("docs/")).toBeNull();
  });

  it("rejects an absolute path, a .. segment, a glob, the root and an over-long path", () => {
    expect(overlapPathError("/src")).toMatch(/leading/);
    expect(overlapPathError("src/../x")).toMatch(/\.\./);
    expect(overlapPathError("src/*.ts")).toMatch(/glob/);
    expect(overlapPathError("./")).toMatch(/root/);
    expect(overlapPathError("")).toMatch(/empty/);
    expect(overlapPathError("a".repeat(301))).toMatch(/longer/);
    expect(overlapPathError("src\\a.ts")).toMatch(/separator/);
  });

  it("normalises ./, repeated and trailing slashes", () => {
    expect(normaliseOverlapPath("./src//jobs/")).toBe("src/jobs");
    expect(normaliseOverlapPath(" docs ")).toBe("docs");
  });
});

describe("filterIgnoredPaths", () => {
  it("drops paths equal to or under an ignore entry and keeps a directory containing one", () => {
    expect(filterIgnoredPaths(["package-lock.json", "docs/gen/a.md", "docs", "src/a.ts"], ["package-lock.json", "docs/gen"]))
      .toEqual(["docs", "src/a.ts"]);
  });

  it("does not treat an ignore entry as a name prefix", () => {
    expect(filterIgnoredPaths(["docs/generated.md"], ["docs/gen"])).toEqual(["docs/generated.md"]);
  });

  it("returns a copy unchanged with an empty ignore list", () => {
    expect(filterIgnoredPaths(["a"], [])).toEqual(["a"]);
  });
});

describe("compareInFlightSteps", () => {
  it("orders open PR, then Priority, then plan approval (null last), then issue, position and PR number", () => {
    const steps = [
      step({ issueId: "clw_Z", planApprovedAtMs: null }),
      step({ issueId: "clw_B", planApprovedAtMs: 500, position: 2 }),
      step({ issueId: "clw_B", planApprovedAtMs: 500, position: 1 }),
      step({ issueId: "clw_A", planApprovedAtMs: 500, position: 3 }),
      step({ issueId: "clw_P", priority: true, planApprovedAtMs: 9000 }),
      step({ issueId: "clw_O", hasOpenPr: true, prNumber: 7, planApprovedAtMs: 9999 }),
      step({ issueId: "clw_O", hasOpenPr: true, prNumber: 3, planApprovedAtMs: 9999 }),
    ];
    const sorted = [...steps].sort(compareInFlightSteps).map((s) => `${s.issueId}:${s.position}:${s.prNumber}`);
    expect(sorted).toEqual(["clw_O:1:3", "clw_O:1:7", "clw_P:1:null", "clw_A:3:null", "clw_B:1:null", "clw_B:2:null", "clw_Z:1:null"]);
  });

  it("is total: antisymmetric, and zero only for the same step", () => {
    const steps = [
      step(), step({ position: 2 }), step({ prNumber: 4, hasOpenPr: true }), step({ issueId: "clw_B" }),
      step({ priority: true }), step({ planApprovedAtMs: null }), step({ position: null }),
    ];
    for (const a of steps) {
      for (const b of steps) {
        const ab = compareInFlightSteps(a, b);
        const ba = compareInFlightSteps(b, a);
        expect(Math.sign(ab) + Math.sign(ba)).toBe(0);
        if (a !== b) expect(ab).not.toBe(0);
      }
    }
  });
});

describe("givesWay", () => {
  const nowMs = 10 * OVERLAP_GIVE_WAY_MS;

  it("holds while fresh, not stalled and not parked", () => {
    expect(givesWay({ stalled: false, lifecycle: "awaiting-plan-review", inFlightSinceMs: nowMs - 1000, nowMs })).toBe(false);
    expect(givesWay({ stalled: false, lifecycle: null, inFlightSinceMs: null, nowMs })).toBe(false);
  });

  it("gives way when stalled, Blocked, in Backlog, or in flight over 48 hours", () => {
    expect(givesWay({ stalled: true, lifecycle: null, inFlightSinceMs: nowMs, nowMs })).toBe(true);
    expect(givesWay({ stalled: false, lifecycle: "blocked", inFlightSinceMs: nowMs, nowMs })).toBe(true);
    expect(givesWay({ stalled: false, lifecycle: "backlog", inFlightSinceMs: nowMs, nowMs })).toBe(true);
    expect(givesWay({ stalled: false, lifecycle: null, inFlightSinceMs: nowMs - OVERLAP_GIVE_WAY_MS - 1, nowMs })).toBe(true);
    expect(givesWay({ stalled: false, lifecycle: null, inFlightSinceMs: nowMs - OVERLAP_GIVE_WAY_MS, nowMs })).toBe(false);
  });
});

describe("holdersAhead", () => {
  it("returns overlapping steps earlier in the order, with the shared paths", () => {
    const front = step({ issueId: "clw_A", hasOpenPr: true, prNumber: 1, paths: ["design"] });
    const middle = step({ issueId: "clw_B", hasOpenPr: true, prNumber: 2, paths: ["src/a.ts"], planApprovedAtMs: 2000 });
    const later = step({ issueId: "clw_C", hasOpenPr: true, prNumber: 3, paths: ["design/x.png", "src/a.ts"], planApprovedAtMs: 3000 });
    const all = [later, middle, front];
    expect(holdersAhead(later, all).map((h) => [h.step.prNumber, h.shared])).toEqual([[1, ["design/x.png"]], [2, ["src/a.ts"]]]);
    expect(holdersAhead(front, all)).toEqual([]);
  });

  it("never lets two steps hold each other", () => {
    const a = step({ issueId: "clw_A", hasOpenPr: true, prNumber: 1 });
    const b = step({ issueId: "clw_B", hasOpenPr: true, prNumber: 2 });
    expect(holdersAhead(a, [a, b]).length + holdersAhead(b, [a, b]).length).toBe(1);
  });

  it("skips a holder that gives way, and never holds a step with no paths", () => {
    const front = step({ issueId: "clw_A", hasOpenPr: true, prNumber: 1, holds: false });
    const later = step({ issueId: "clw_B", hasOpenPr: true, prNumber: 2 });
    expect(holdersAhead(later, [front, later])).toEqual([]);
    const pathless = step({ issueId: "clw_C", hasOpenPr: true, prNumber: 3, paths: [] });
    expect(holdersAhead(pathless, [step({ issueId: "clw_0", hasOpenPr: true, prNumber: 0 }), pathless])).toEqual([]);
  });
});

describe("formatSharedPaths", () => {
  it("lists up to three paths, then a count", () => {
    expect(formatSharedPaths(["a"])).toBe("a");
    expect(formatSharedPaths(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
  });
});
