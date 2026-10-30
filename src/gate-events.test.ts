import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import type { SqlDriver } from "./db-driver.js";
import type { ClawsPrRecord } from "./db.js";
import { CLAWS_EVENTS_DDL, getEventsSince, setGitHubEventsDriver } from "./github-events.js";
import {
  CLAWS_GATE_STATE_DDL,
  evaluatePrGates,
  isReadyToMerge,
  pruneGateState,
  setGateEventsDriver,
  setIssueAwaitingOperatorGates,
  setPrNeedsOperatorGate,
} from "./gate-events.js";
import * as log from "./log.js";

/** PGlite on the Postgres lane, else in-memory SQLite. */
async function openDriver(): Promise<SqlDriver> {
  if (process.env["CLAWS_TEST_PGLITE"] === "1") {
    const { createPgLiteDriver } = await import("./db-driver-pg.js");
    return await createPgLiteDriver();
  }
  const { createSqliteDriver } = await import("./db-driver.js");
  return createSqliteDriver(":memory:");
}

const ISSUE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

function readyRow(overrides: Partial<ClawsPrRecord> = {}): ClawsPrRecord {
  return {
    repo: "o/r",
    prNumber: 12,
    issueId: ISSUE,
    phase: null,
    headSha: HEAD,
    observedAt: null,
    stage: "awaiting-merge",
    ciStatus: "passing",
    mergeableState: null,
    reviewVerdict: "clean",
    reviewedSha: HEAD,
    mergeApprovedBy: null,
    mergeApprovedAt: null,
    manualActionReason: null,
    needsHumanReview: false,
    ciBlockedReason: null,
    infraMergeApprovedBy: null,
    infraMergeApprovedAt: null,
    infraMergeApprovedSha: null,
    title: null,
    dispatchNote: null,
    dispatchNoteAt: null,
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("gate-events", () => {
  let driver: SqlDriver;

  beforeEach(async () => {
    driver = await openDriver();
    await driver.exec(CLAWS_EVENTS_DDL);
    await driver.exec(CLAWS_GATE_STATE_DDL);
    setGitHubEventsDriver(driver);
    setGateEventsDriver(driver);
  });

  afterEach(async () => {
    setGateEventsDriver(null);
    setGitHubEventsDriver(null);
    await driver.close();
  });

  const events = (kind: string) => getEventsSince(0, { kinds: [kind as "pr-ready-to-merge"] });

  it("emits exactly one pr-ready-to-merge per transition into the ready state", async () => {
    for (let i = 0; i < 3; i++) await evaluatePrGates(readyRow());
    const once = await events("pr-ready-to-merge");
    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({ kind: "pr-ready-to-merge", repo: "o/r", number: 12, related: [ISSUE], detail: HEAD.slice(0, 12) });

    // CI goes pending, then green again: the PR left and re-entered the state.
    await evaluatePrGates(readyRow({ ciStatus: "pending" }));
    await evaluatePrGates(readyRow({ ciStatus: "pending" }));
    expect(await events("pr-ready-to-merge")).toHaveLength(1);
    await evaluatePrGates(readyRow());
    expect(await events("pr-ready-to-merge")).toHaveLength(2);
  });

  it("re-fires pr-ready-to-merge for a new clean head even without an inactive write in between", async () => {
    await evaluatePrGates(readyRow());
    const next = "fedcba9876543210fedcba9876543210fedcba98";
    await evaluatePrGates(readyRow({ headSha: next, reviewedSha: next }));
    expect((await events("pr-ready-to-merge")).map((e) => e.detail)).toEqual([HEAD.slice(0, 12), next.slice(0, 12)]);
  });

  it.each([
    ["an unreviewed head", { reviewedSha: "other" }],
    ["failing CI", { ciStatus: "failing" }],
    ["a blocking review", { reviewVerdict: "blocking" }],
    ["a manual action", { manualActionReason: "rotate the key" }],
    ["a CI block", { ciBlockedReason: "held runs" }],
    ["another stage", { stage: "awaiting-review" as const }],
  ])("is not ready to merge with %s", (_label, overrides) => {
    expect(isReadyToMerge(readyRow(overrides))).toBe(false);
  });

  it("treats a repo with no CI as green", () => {
    expect(isReadyToMerge(readyRow({ ciStatus: "none" }))).toBe(true);
  });

  it("emits one pr-needs-operator per detail per transition", async () => {
    const manual = readyRow({ stage: "awaiting-review", manualActionReason: "run the migration" });
    await evaluatePrGates(manual);
    await evaluatePrGates(manual);
    await evaluatePrGates(readyRow({ stage: "problematic", manualActionReason: "run the migration" }));
    await evaluatePrGates(readyRow({ stage: "problematic", manualActionReason: "run the migration" }));
    await setPrNeedsOperatorGate("o/r", 12, ISSUE, "infra", true);
    await setPrNeedsOperatorGate("o/r", 12, ISSUE, "infra", true);
    const got = await events("pr-needs-operator");
    expect(got.map((e) => e.detail)).toEqual(["manual-action", "problematic", "infra"]);
    for (const e of got) expect(e.related).toEqual([ISSUE]);

    // Cleared, then recorded again: a new transition.
    await evaluatePrGates(readyRow({ stage: "awaiting-review" }));
    await evaluatePrGates(manual);
    expect((await events("pr-needs-operator")).map((e) => e.detail)).toEqual(["manual-action", "problematic", "infra", "manual-action"]);
  });

  it("clears every gate, the infra one included, once the PR is merged or closed", async () => {
    await setPrNeedsOperatorGate("o/r", 12, ISSUE, "infra", true);
    await evaluatePrGates(readyRow({ stage: "closed" }));
    await setPrNeedsOperatorGate("o/r", 12, ISSUE, "infra", true);
    expect((await events("pr-needs-operator")).map((e) => e.detail)).toEqual(["infra", "infra"]);
  });

  it("is targetable by repo and by the PR's issue", async () => {
    await evaluatePrGates(readyRow());
    expect(await getEventsSince(0, { repo: "o/r", items: [ISSUE], kinds: [{ kind: "pr-ready-to-merge" }] })).toHaveLength(1);
    expect(await getEventsSince(0, { items: [12], kinds: ["pr-ready-to-merge"] })).toHaveLength(1);
    expect(await getEventsSince(0, { repo: "o/other", kinds: ["pr-ready-to-merge"] })).toHaveLength(0);
  });

  it("emits one issue-awaiting-operator per transition, with only the current detail active", async () => {
    await setIssueAwaitingOperatorGates("o/r", ISSUE, "requirements-review");
    await setIssueAwaitingOperatorGates("o/r", ISSUE, "requirements-review");
    await setIssueAwaitingOperatorGates("o/r", ISSUE, null);
    await setIssueAwaitingOperatorGates("o/r", ISSUE, "plan-review");
    await setIssueAwaitingOperatorGates("o/r", ISSUE, "plan-review");
    await setIssueAwaitingOperatorGates("o/r", ISSUE, "manual-step");
    const got = await getEventsSince(0, { items: [ISSUE], kinds: [{ kind: "issue-awaiting-operator" }] });
    expect(got.map((e) => e.detail)).toEqual(["requirements-review", "plan-review", "manual-step"]);
    expect(await getEventsSince(0, { kinds: [{ kind: "issue-awaiting-operator", detail: "plan-review" }] })).toHaveLength(1);
  });

  it("never throws, and logs, when the table is missing", async () => {
    await driver.exec("DROP TABLE claws_gate_state");
    await expect(evaluatePrGates(readyRow())).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it("prunes only inactive rows past retention", async () => {
    await setIssueAwaitingOperatorGates("o/r", ISSUE, "plan-review");
    expect(await pruneGateState()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Two inactive rows (requirements-review, manual-step); the active one stays.
    expect(await pruneGateState(0)).toBe(2);
  });
});
