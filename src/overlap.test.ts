import { describe, it, expect } from "vitest";
import {
  OVERLAP_GIVE_WAY_MS,
  compareInFlightSteps,
  filterIgnoredPaths,
  formatSharedPaths,
  givesWay,
  holdersAhead,
  isSharedDocPath,
  normaliseOverlapPath,
  overlapPathError,
  pathsOverlap,
  resolveHolding,
  sharedDocPaths,
  sharedPaths,
  type InFlightStep,
} from "./overlap.js";

function step(overrides: Partial<InFlightStep> = {}): InFlightStep {
  return {
    issueId: "clw_A",
    position: 1,
    prNumber: null,
    hasOpenPr: false,
    running: overrides.hasOpenPr ?? false,
    ready: true,
    exempt: false,
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

describe("isSharedDocPath and sharedDocPaths", () => {
  it("treats Markdown under docs/ and AGENTS.md or README.md at any depth as shared docs", () => {
    expect(isSharedDocPath("docs/DESIGN.md")).toBe(true);
    expect(isSharedDocPath("docs/jobs/issue-dispatcher.md")).toBe(true);
    expect(isSharedDocPath("AGENTS.md")).toBe(true);
    expect(isSharedDocPath("README.md")).toBe(true);
    expect(isSharedDocPath("android/README.md")).toBe(true);
  });

  it("keeps code, workflows, fixtures, other Markdown and directory prefixes blocking", () => {
    expect(isSharedDocPath("docs")).toBe(false);
    expect(isSharedDocPath("docs/jobs")).toBe(false);
    expect(isSharedDocPath("docs/diagram.png")).toBe(false);
    expect(isSharedDocPath("CHANGELOG.md")).toBe(false);
    expect(isSharedDocPath("src/fixtures/a.md")).toBe(false);
    expect(isSharedDocPath(".forgejo/workflows/ci.yml")).toBe(false);
    expect(isSharedDocPath("src/NOT_README.md")).toBe(false);
  });

  it("sharedDocPaths lists only the shared docs both lists touch", () => {
    expect(sharedDocPaths(["docs", "src/a.ts", "AGENTS.md"], ["docs/ci-cd.md", "src/a.ts", "AGENTS.md"])).toEqual(["AGENTS.md", "docs/ci-cd.md"]);
  });
});

describe("holdersAhead and shared docs", () => {
  it("never holds on shared docs alone, and leaves them out of the shared list", () => {
    const front = step({ issueId: "clw_A", hasOpenPr: true, prNumber: 1, paths: ["docs/DESIGN.md", "README.md", "src/a.ts"] });
    const docsOnly = step({ issueId: "clw_B", paths: ["docs/DESIGN.md", "README.md"] });
    const mixed = step({ issueId: "clw_C", paths: ["docs/DESIGN.md", "src/a.ts"] });
    expect(holdersAhead(docsOnly, [front, docsOnly])).toEqual([]);
    expect(holdersAhead(mixed, [front, mixed]).map((h) => h.shared)).toEqual([["src/a.ts"]]);
  });

  it("still holds on a declared docs directory prefix", () => {
    const front = step({ issueId: "clw_A", hasOpenPr: true, prNumber: 1, paths: ["docs"] });
    const later = step({ issueId: "clw_B", paths: ["docs"] });
    expect(holdersAhead(later, [front, later]).map((h) => h.shared)).toEqual([["docs"]]);
  });
});

describe("resolveHolding", () => {
  const holding = (steps: InFlightStep[]) => resolveHolding(steps).map((s) => `${s.issueId}:${s.position}:${s.holds}`);

  it("lets a step that is itself held hold nothing, so a chain does not form: A open PR, B held, C free", () => {
    const a = step({ issueId: "clw_A", hasOpenPr: true, prNumber: 1, paths: ["src/x.kt"] });
    const b = step({ issueId: "clw_B", planApprovedAtMs: 1, paths: ["src/x.kt", "src/y.swift"] });
    const c = step({ issueId: "clw_C", planApprovedAtMs: 2, paths: ["src/y.swift"] });
    const resolved = resolveHolding([c, b, a]);
    expect(resolved.map((s) => `${s.issueId}:${s.holds}`)).toEqual(["clw_C:true", "clw_B:false", "clw_A:true"]);
    expect(holdersAhead(resolved[1]!, resolved).map((h) => h.step.issueId)).toEqual(["clw_A"]);
    expect(holdersAhead(resolved[0]!, resolved)).toEqual([]);
    expect(resolved[0]).not.toBe(c);
  });

  it("lets a step that is not ready hold nothing, however early its issue was approved", () => {
    const far = step({ issueId: "clw_A", position: 6, ready: false, planApprovedAtMs: 1, paths: ["train/loader.py"] });
    const later = step({ issueId: "clw_B", planApprovedAtMs: 9, paths: ["train/loader.py"] });
    const resolved = resolveHolding([far, later]);
    expect(resolved.map((s) => s.holds)).toEqual([false, true]);
    expect(holdersAhead(resolved[1]!, resolved)).toEqual([]);
  });

  it("lets an exempt ready step hold even when an earlier step shares its files", () => {
    const front = step({ issueId: "clw_A", hasOpenPr: true, prNumber: 1 });
    const exempt = step({ issueId: "clw_P", exempt: true });
    const later = step({ issueId: "clw_Z", planApprovedAtMs: 5000 });
    expect(holding([front, exempt, later])).toEqual(["clw_A:1:true", "clw_P:1:true", "clw_Z:1:false"]);
  });

  it("keeps a running step's give-way holds, and keeps a ready step that gives way from holding", () => {
    const stalled = step({ issueId: "clw_A", hasOpenPr: true, prNumber: 1, holds: false });
    const running = step({ issueId: "clw_B", running: true, planApprovedAtMs: 5000 });
    const gaveWay = step({ issueId: "clw_C", holds: false, planApprovedAtMs: 1, paths: ["src/z.ts"] });
    expect(holding([stalled, running, gaveWay])).toEqual(["clw_A:1:false", "clw_B:1:true", "clw_C:1:false"]);
  });

  it("orders a running step ahead of an earlier-approved waiting one, and never lets two steps hold each other", () => {
    const waiting = step({ issueId: "clw_A", planApprovedAtMs: 1 });
    const running = step({ issueId: "clw_B", running: true, planApprovedAtMs: 9000 });
    const resolved = resolveHolding([waiting, running]);
    expect(resolved.map((s) => s.holds)).toEqual([false, true]);
    expect(holdersAhead(resolved[0]!, resolved).map((h) => h.step.issueId)).toEqual(["clw_B"]);
    expect(holdersAhead(resolved[1]!, resolved)).toEqual([]);
  });
});

describe("formatSharedPaths", () => {
  it("lists up to three paths, then a count", () => {
    expect(formatSharedPaths(["a"])).toBe("a");
    expect(formatSharedPaths(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
  });
});
