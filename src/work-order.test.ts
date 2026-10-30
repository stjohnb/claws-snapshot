import { describe, it, expect } from "vitest";
import { AGENT_KINDS, STAGE_RANK, UNKNOWN_STAGE_RANK, stageRankOf, stageRankSql } from "./work-order.js";

describe("work-order", () => {
  it("ranks every AGENT_KINDS value", () => {
    for (const kind of Object.values(AGENT_KINDS)) {
      expect(Object.hasOwn(STAGE_RANK, kind), `${kind} needs a stage rank`).toBe(true);
    }
  });

  it("orders stages nearest to merge first", () => {
    const order = [
      AGENT_KINDS.AUTO_MERGER_SWEEP,
      AGENT_KINDS.CI_FIXER,
      AGENT_KINDS.REVIEW_ADDRESSER,
      AGENT_KINDS.PR_REVIEWER,
      AGENT_KINDS.ISSUE_WORKER_CONTINUE,
      AGENT_KINDS.ISSUE_WORKER,
      AGENT_KINDS.ISSUE_REFINER_REFINE,
      AGENT_KINDS.ISSUE_REFINER_PLAN,
    ].map(stageRankOf);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
  });

  it("ranks unknown kinds last", () => {
    expect(stageRankOf("no-such-kind")).toBe(UNKNOWN_STAGE_RANK);
    expect(stageRankOf("constructor")).toBe(UNKNOWN_STAGE_RANK);
  });

  it("renders a CASE over every kind with no placeholders", () => {
    const sql = stageRankSql();
    for (const kind of Object.values(AGENT_KINDS)) expect(sql).toContain(`WHEN '${kind}' THEN ${STAGE_RANK[kind]}`);
    expect(sql.startsWith("CASE kind ")).toBe(true);
    expect(sql.endsWith(`ELSE ${UNKNOWN_STAGE_RANK} END`)).toBe(true);
    expect(sql).not.toContain("?");
    expect(stageRankSql("w.kind").startsWith("CASE w.kind ")).toBe(true);
  });
});
