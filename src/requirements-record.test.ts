import { describe, it, expect } from "vitest";
import { REQUIREMENTS_HEADER, parseRequirementsFile, renderRequirementsComment, type RequirementsRecord } from "./requirements-record.js";
import { isRequirementsComment, isPlanComment } from "./marker-text.js";

const CLAWS_HEADER = "*— Automated by Claws · Requirements writer —*";

const RECORD: RequirementsRecord = {
  title: "Board shows stale ages",
  kind: "bug",
  context: "Cards show the age from creation.",
  requirement: "A card's age counts from when it entered its column.",
  acceptanceCriteria: ["Moving a card resets its age chip", "An unmoved card keeps its age"],
  outOfScope: [],
};

describe("renderRequirementsComment", () => {
  it("renders the header, kind and the four parts in order", () => {
    const text = renderRequirementsComment(RECORD);
    expect(text.startsWith(`${REQUIREMENTS_HEADER}\n`)).toBe(true);
    expect(text).toContain("**Title:** Board shows stale ages");
    expect(text).toContain("**Kind:** bug");
    const order = ["### Context", "### Requirement", "### Acceptance criteria", "### Out of scope"].map((h) => text.indexOf(h));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]))).toBe(true);
    expect(text).toContain("- Moving a card resets its age chip\n- An unmoved card keeps its age");
    expect(text).toContain("### Out of scope\n\n_None._");
  });
});

describe("isRequirementsComment", () => {
  it("needs both the header line and the Claws marker", () => {
    const body = `${CLAWS_HEADER}\n\n${renderRequirementsComment(RECORD)}`;
    expect(isRequirementsComment(body)).toBe(true);
    expect(isRequirementsComment(renderRequirementsComment(RECORD))).toBe(false);
    expect(isPlanComment(body)).toBe(false);
  });

  it("does not take a plan's ### Requirements heading for the record", () => {
    expect(isRequirementsComment(`${CLAWS_HEADER}\n\n## Implementation Plan\n\n### Requirements\n\nx`)).toBe(false);
  });
});

describe("parseRequirementsFile", () => {
  it("round-trips a saved record", () => {
    expect(parseRequirementsFile(JSON.stringify(RECORD))).toEqual(RECORD);
  });

  it("rejects text that is not JSON", () => {
    expect(() => parseRequirementsFile("not json")).toThrow(/not JSON/);
  });

  it("rejects a record with no acceptance criteria or an overlong title", () => {
    expect(() => parseRequirementsFile(JSON.stringify({ ...RECORD, acceptanceCriteria: [] }))).toThrow(/acceptanceCriteria/);
    expect(() => parseRequirementsFile(JSON.stringify({ ...RECORD, title: "x".repeat(121) }))).toThrow(/title/);
  });
});
