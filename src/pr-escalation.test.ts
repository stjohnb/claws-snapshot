import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { getClawsPr: vi.fn(), upsertClawsPr: vi.fn() },
}));
vi.mock("./github.js", () => ({}));
vi.mock("./db.js", () => mockDb);
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import { summarizeFindings, escalationReason, clearEscalationManualAction } from "./pr-escalation.js";

describe("summarizeFindings", () => {
  it("skips marker lines and markdown lead-ins", () => {
    expect(summarizeFindings("severity: blocking\n\n## - Missing null check\nmore")).toBe("Missing null check");
  });
  it("truncates to 120 chars", () => {
    const out = summarizeFindings("x".repeat(300));
    expect(out).toHaveLength(120);
    expect(out.endsWith("…")).toBe(true);
  });
  it("returns empty when nothing usable", () => {
    expect(summarizeFindings("review-result: clean")).toBe("");
  });
});

describe("escalationReason", () => {
  it("builds the rebuttal reason", () => {
    expect(escalationReason("rebuttal", "bad")).toBe("review escalated: upheld blocking finding after implementer rebuttal — bad");
  });
  it("builds the round-cap reason", () => {
    expect(escalationReason("round-cap", "bad", 9)).toBe("review escalated: 9 review rounds without converging — bad");
  });
});

describe("clearEscalationManualAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.upsertClawsPr.mockResolvedValue(undefined);
  });

  it("lifts an escalation hold from the row, with no forge label", async () => {
    mockDb.getClawsPr.mockResolvedValue({ manualActionReason: "review escalated: x" });
    expect(await clearEscalationManualAction("o/r", 1, "test")).toBe(true);
    expect(mockDb.upsertClawsPr).toHaveBeenCalledWith("o/r", 1, { manualActionReason: null });
  });

  it.each(["manual action", "Set the prod secret", "Stacked PR: targets `x`", "CI re-run refused: run 9"])(
    "leaves a %s hold in place",
    async (reason) => {
      mockDb.getClawsPr.mockResolvedValue({ manualActionReason: reason });
      expect(await clearEscalationManualAction("o/r", 1, "test")).toBe(false);
      expect(mockDb.upsertClawsPr).not.toHaveBeenCalled();
    },
  );

  it("returns false when the row write fails", async () => {
    mockDb.getClawsPr.mockResolvedValue({ manualActionReason: "review escalated: x" });
    mockDb.upsertClawsPr.mockRejectedValue(new Error("down"));
    expect(await clearEscalationManualAction("o/r", 1, "test")).toBe(false);
  });
});
