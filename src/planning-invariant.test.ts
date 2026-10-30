/**
 * The Planning invariant (#clw_01M4EPRM9SYVGFG2BTZTMQEKDJ): an open issue with
 * a plan is in the board's Planning column only while a planner run is queued
 * or running for it.
 *
 * Two halves. A source scan pins every direct move to `planning` left in the
 * implementer to a reason it cannot strand the issue. A table then drives each
 * hand-back helper against a simulated native issue — its stored lifecycle
 * and approval, written the way `gh.setIssueLifecycle` and `gh.blockIssue`
 * write them — and places the result with the real `columnFor`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("./config.js", () => ({
  LABELS: {
    backlog: "Backlog",
    blocked: "Blocked",
    duplicate: "Duplicate",
  },
}));
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("./db.js", () => ({}));
vi.mock("./imported-refs.js", () => ({ issueRefAliases: (_repo: string, ref: unknown) => [ref] }));

/** One simulated native issue: its lifecycle and approval fields, plain labels and state. */
const sim = vi.hoisted(() => ({
  lifecycle: "awaiting-plan-review" as string,
  approvedThrough: "plan" as string,
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
    setIssueLifecycle: vi.fn(async (_repo: string, _ref: unknown, lifecycle: string) => { sim.lifecycle = lifecycle; }),
    addLabel: vi.fn(async (_repo: string, _ref: unknown, label: string) => {
      const lifecycle = lifecycleMod.lifecycleForLabel(label);
      if (lifecycle) sim.lifecycle = lifecycle;
      else sim.labels.add(label);
    }),
    blockIssue: vi.fn(async () => { sim.lifecycle = "blocked"; }),
    removeLabel: vi.fn(async (_repo: string, _ref: unknown, label: string) => {
      sim.labels.delete(label);
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
    approvedThrough: sim.approvedThrough as never,
  });
}

beforeEach(() => {
  sim.lifecycle = "awaiting-plan-review";
  sim.approvedThrough = "plan";
  sim.labels = new Set();
  sim.closed = false;
});

describe("implementer's direct moves to Planning", () => {
  // Each remaining direct move, and why it cannot leave the issue in Planning
  // with nothing queued.
  const ALLOWED: { anchor: RegExp; why: string }[] = [
    { anchor: /changed after its plan was written/, why: "stale plan: the dispatcher's hash check queues the re-plan" },
  ];

  it("names a destination on every other exit", () => {
    const lines = readFileSync(new URL("./agents/issue-worker.ts", import.meta.url), "utf8").split("\n");
    const moves = lines.flatMap((line, i) => /setIssueLifecycle\([^)]*"planning"/.test(line) ? [i] : []);
    for (const i of moves) {
      const context = lines.slice(Math.max(0, i - 15), i + 1).join("\n");
      const allowed = ALLOWED.find((a) => a.anchor.test(context));
      expect(allowed, `issue-worker.ts:${i + 1} moves the issue to Planning without naming where it goes — use issue-handback.ts`).toBeDefined();
    }
  });
});

describe("hand-back destinations never land a planned issue in Planning", () => {
  /** Approved: a plan in Awaiting plan review, approved through Plan. */
  const APPROVED = { lifecycle: "awaiting-plan-review", approvedThrough: "plan" };
  const REVIEW = { lifecycle: "awaiting-plan-review", approvedThrough: "requirements" };
  const PLANNING = { lifecycle: "planning", approvedThrough: "requirements" };
  const cases: { name: string; from: { lifecycle: string; approvedThrough: string }; act: () => Promise<unknown>; expected: string }[] = [
    { name: "PR opened / pushed / no step ready", from: APPROVED, act: () => returnToPlanReview(REPO, REF), expected: "approved" },
    { name: "no-commit run", from: APPROVED, act: () => parkForHuman(REPO, REF, "no commits", "Implementer", { slug: "no-commit-1" }), expected: "blocked" },
    { name: "unmanaged step / target branch gone / stuck", from: APPROVED, act: () => parkForHuman(REPO, REF, "why", "Implementer", { slug: "x" }), expected: "blocked" },
    { name: "ambiguous or positional coverage", from: APPROVED, act: () => parkAmbiguousCoverage(REPO, REF, [54], []), expected: "blocked" },
    { name: "awaiting review, ambiguous coverage", from: REVIEW, act: () => parkAmbiguousCoverage(REPO, REF, [54], []), expected: "blocked" },
    { name: "merged `Part of`, single step", from: PLANNING, act: () => settleMergedSingleStep(REPO, REF, [{ number: 28, body: `Part of #${REF}` }]), expected: "blocked" },
    { name: "merged `Closes`, single step", from: PLANNING, act: () => settleMergedSingleStep(REPO, REF, [{ number: 29, body: `Closes #${REF}` }]), expected: "done" },
    { name: "duplicate", from: APPROVED, act: () => settleDuplicate(REPO, { number: REF, labels: [{ name: "Duplicate" }] }, [{ body: "claws-duplicate-of:12" }]), expected: "done" },
    { name: "dispatcher backstop, current plan", from: PLANNING, act: () => returnToPlanReview(REPO, REF), expected: "awaiting-plan-review" },
    { name: "dispatcher backstop, pre-approved plan", from: { lifecycle: "planning", approvedThrough: "plan" }, act: () => returnToPlanReview(REPO, REF), expected: "approved" },
  ];

  for (const c of cases) {
    it(`${c.name}: ${c.from.lifecycle} (${c.from.approvedThrough}) → ${c.expected}`, async () => {
      sim.lifecycle = c.from.lifecycle;
      sim.approvedThrough = c.from.approvedThrough;
      await c.act();
      expect(column()).toBe(c.expected);
      expect(column()).not.toBe("planning");
    });
  }

  it("a card carrying a non-lifecycle label keeps its column", () => {
    sim.lifecycle = "planning";
    sim.labels.add("Plan: Deep");
    // `columnFor` reads lifecycle labels only.
    expect(column()).toBe("planning");
  });
});
