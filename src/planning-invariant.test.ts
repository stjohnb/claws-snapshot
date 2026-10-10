/**
 * The Planning invariant (#clw_01M4EPRM9SYVGFG2BTZTMQEKDJ): an open issue with
 * a plan is in the board's Planning column only while a planner run is queued
 * or running for it.
 *
 * Two halves. A source scan pins every direct `Refined` removal left in the
 * implementer to a reason it cannot strand the issue. A table then drives each
 * hand-back helper against a simulated native lifecycle — the same
 * single-field semantics `db.addClawsIssueLabel` / `db.removeClawsIssueLabel`
 * apply, where removing the state an issue holds resets a planned issue to
 * `planning` — and places the result with the real `columnFor`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("./config.js", () => ({
  LABELS: {
    backlog: "Backlog",
    blocked: "Blocked",
    refined: "Refined",
    ready: "Ready",
    duplicate: "Duplicate",
    clawsIgnore: "Claws Ignore",
  },
}));
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("./db.js", () => ({ setShadowLifecycle: vi.fn(), setIssueBlockedReason: vi.fn() }));
vi.mock("./planned-prs.js", () => ({ resolveTrackerId: vi.fn().mockResolvedValue(null) }));
vi.mock("./imported-refs.js", () => ({ issueRefAliases: (_repo: string, ref: unknown) => [ref] }));

/** One simulated native issue: its lifecycle field, plain labels and state. */
const sim = vi.hoisted(() => ({
  lifecycle: "approved" as string,
  labels: new Set<string>(),
  closed: false,
}));

vi.mock("./github.js", async () => {
  const lifecycleMod = await vi.importActual<typeof import("./issue-lifecycle.js")>("./issue-lifecycle.js");
  return {
    isClawsComment: (body: string) => /\*— Automated by Claws/.test(body),
    getIssueComments: vi.fn(async () => []),
    commentOnIssue: vi.fn(async () => {}),
    getIssueState: vi.fn(async () => ({ state: sim.closed ? "CLOSED" : "OPEN", stateReason: null, labels: [] })),
    closeIssue: vi.fn(async () => { sim.closed = true; }),
    addLabel: vi.fn(async (_repo: string, _ref: unknown, label: string) => {
      const lifecycle = lifecycleMod.lifecycleForLabel(label);
      if (lifecycle) sim.lifecycle = lifecycle;
      else sim.labels.add(label);
    }),
    // A planned issue: removing the state it holds sends it to `planning`.
    removeLabel: vi.fn(async (_repo: string, _ref: unknown, label: string) => {
      const lifecycle = lifecycleMod.lifecycleForLabel(label);
      if (lifecycle) {
        if (sim.lifecycle === lifecycle) sim.lifecycle = "planning";
      } else {
        sim.labels.delete(label);
      }
      return true;
    }),
  };
});

import { columnFor } from "./issue-board.js";
import { labelForLifecycle } from "./issue-lifecycle.js";
import { parkAmbiguousCoverage, parkForHuman, returnToPlanReview, settleDuplicate, settleMergedSingleStep } from "./issue-handback.js";

const REPO = "org/repo";
const REF = "clw_01M4EPRM9SYVGFG2BTZTMQEKDJ";

/** Where the simulated issue lands on the board, with no flight and no planner. */
function column(): string {
  const state = labelForLifecycle(sim.lifecycle as never);
  return columnFor({
    labels: [...sim.labels, ...(state ? [state] : [])],
    closed: sim.closed,
    lifecycle: sim.lifecycle,
  });
}

beforeEach(() => {
  sim.lifecycle = "approved";
  sim.labels = new Set();
  sim.closed = false;
});

describe("implementer's direct `Refined` removals", () => {
  // Each remaining bare removal, and why it cannot leave the issue in Planning
  // with nothing queued.
  const ALLOWED: { anchor: RegExp; why: string }[] = [
    { anchor: /changed after its plan was written/, why: "stale plan: the dispatcher's hash check queues the re-plan" },
    { anchor: /closeIssueIfPlanComplete/, why: "the issue was just closed" },
    { anchor: /addLabel\(fullName, issue\.number, LABELS\.ready\)/, why: "Ready went on first" },
  ];

  it("names a destination on every other exit", () => {
    const lines = readFileSync(new URL("./agents/issue-worker.ts", import.meta.url), "utf8").split("\n");
    const removals = lines.flatMap((line, i) => /removeLabel\([^)]*LABELS\.refined/.test(line) ? [i] : []);
    expect(removals.length).toBeGreaterThan(0);
    for (const i of removals) {
      const context = lines.slice(Math.max(0, i - 15), i + 1).join("\n");
      const allowed = ALLOWED.find((a) => a.anchor.test(context));
      expect(allowed, `issue-worker.ts:${i + 1} removes Refined without naming where the issue goes — use issue-handback.ts`).toBeDefined();
    }
  });
});

describe("hand-back destinations never land a planned issue in Planning", () => {
  const cases: { name: string; from: string; act: () => Promise<unknown>; expected: string }[] = [
    { name: "PR opened / pushed / no step ready", from: "approved", act: () => returnToPlanReview(REPO, REF), expected: "awaiting-plan-review" },
    { name: "no-commit run", from: "approved", act: () => parkForHuman(REPO, REF, "no commits", "Implementer", { slug: "no-commit-1" }), expected: "blocked" },
    { name: "unmanaged step / target branch gone / stuck", from: "approved", act: () => parkForHuman(REPO, REF, "why", "Implementer", { slug: "x" }), expected: "blocked" },
    { name: "ambiguous or positional coverage", from: "approved", act: () => parkAmbiguousCoverage(REPO, REF, [54], []), expected: "blocked" },
    { name: "awaiting review, ambiguous coverage", from: "awaiting-plan-review", act: () => parkAmbiguousCoverage(REPO, REF, [54], []), expected: "blocked" },
    { name: "merged `Part of`, single step", from: "planning", act: () => settleMergedSingleStep(REPO, REF, [{ number: 28, body: `Part of #${REF}` }]), expected: "blocked" },
    { name: "merged `Closes`, single step", from: "planning", act: () => settleMergedSingleStep(REPO, REF, [{ number: 29, body: `Closes #${REF}` }]), expected: "done" },
    { name: "duplicate", from: "approved", act: () => settleDuplicate(REPO, { number: REF, labels: [{ name: "Duplicate" }] }, [{ body: "claws-duplicate-of:12" }]), expected: "done" },
    { name: "dispatcher backstop, current plan", from: "planning", act: () => returnToPlanReview(REPO, REF), expected: "awaiting-plan-review" },
  ];

  for (const c of cases) {
    it(`${c.name}: ${c.from} → ${c.expected}`, async () => {
      sim.lifecycle = c.from;
      await c.act();
      expect(column()).toBe(c.expected);
      expect(column()).not.toBe("planning");
    });
  }

  it("a bare Refined removal is exactly what used to land it in Planning", async () => {
    const gh = await import("./github.js");
    await gh.removeLabel(REPO, REF, "Refined");
    expect(column()).toBe("planning");
  });

  it("a parked Claws Ignore card keeps its column but is marked, not read as planned", () => {
    sim.lifecycle = "planning";
    sim.labels.add("Claws Ignore");
    // `columnFor` reads lifecycle labels only; `pages/board.ts` renders the Parked chip.
    expect(column()).toBe("planning");
  });
});
