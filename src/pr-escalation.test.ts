import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGh, mockDb } = vi.hoisted(() => ({
  mockGh: { getPRBody: vi.fn(), removeLabel: vi.fn() },
  mockDb: { getClawsPr: vi.fn() },
}));
vi.mock("./github.js", () => mockGh);
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
    mockGh.getPRBody.mockResolvedValue("");
    mockGh.removeLabel.mockResolvedValue(true);
  });

  it("clears on the escalation prefix with no body section", async () => {
    mockDb.getClawsPr.mockResolvedValue({ manualActionReason: "review escalated: x" });
    expect(await clearEscalationManualAction("o/r", 1, "test")).toBe(true);
    expect(mockGh.removeLabel).toHaveBeenCalledWith("o/r", 1, "Manual Action");
  });

  it("keeps the generic reason", async () => {
    mockDb.getClawsPr.mockResolvedValue({ manualActionReason: "manual action" });
    expect(await clearEscalationManualAction("o/r", 1, "test")).toBe(false);
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("keeps when the body has a manual-action section", async () => {
    mockDb.getClawsPr.mockResolvedValue({ manualActionReason: "review escalated: x" });
    mockGh.getPRBody.mockResolvedValue("## ⚠️ Manual action required before merge\n\nDo a thing");
    expect(await clearEscalationManualAction("o/r", 1, "test")).toBe(false);
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
  });

  it("returns false when removeLabel fails", async () => {
    mockDb.getClawsPr.mockResolvedValue({ manualActionReason: "review escalated: x" });
    mockGh.removeLabel.mockResolvedValue(false);
    expect(await clearEscalationManualAction("o/r", 1, "test")).toBe(false);
  });
});
