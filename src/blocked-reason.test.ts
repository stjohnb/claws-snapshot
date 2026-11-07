import { describe, it, expect } from "vitest";
import { AWAITING_OPERATOR_MARKER, dependencyParkReason, displayBlockedReason, isDependencyParkReason, plainBlockedReasonText } from "./blocked-reason.js";

describe("displayBlockedReason", () => {
  it("drops the marker line and trims", () => {
    expect(displayBlockedReason(`Do it\n\n${AWAITING_OPERATOR_MARKER}\n`)).toBe("Do it");
  });
  it("becomes empty for a marker-only reason", () => {
    expect(displayBlockedReason(AWAITING_OPERATOR_MARKER)).toBe("");
  });
});

describe("plainBlockedReasonText", () => {
  it("strips simple markdown and joins lines", () => {
    expect(plainBlockedReasonText(`## Plan\n- **Bold** and \`code\`\n* __two__\n${AWAITING_OPERATOR_MARKER}`)).toBe("Plan Bold and code two");
  });
  it("is empty for a marker-only reason", () => {
    expect(plainBlockedReasonText(AWAITING_OPERATOR_MARKER)).toBe("");
  });
});

describe("dependencyParkReason", () => {
  it("names one open dependency in the wording the link park has always used", () => {
    expect(dependencyParkReason([{ id: "clw_a", title: "First" }])).toBe("Depends on #clw_a — First, which is still open.");
  });
  it("lists several, joined with commas and a final and", () => {
    expect(dependencyParkReason([{ id: "clw_a", title: "One" }, { id: "clw_b", title: "Two" }]))
      .toBe("Depends on #clw_a — One and #clw_b — Two, which are still open.");
    expect(dependencyParkReason([{ id: "clw_a", title: "One" }, { id: "clw_b", title: "Two" }, { id: "clw_c", title: "Three" }]))
      .toBe("Depends on #clw_a — One, #clw_b — Two and #clw_c — Three, which are still open.");
  });
});

describe("isDependencyParkReason", () => {
  it("recognises the dependency reason and nothing else", () => {
    expect(isDependencyParkReason(dependencyParkReason([{ id: "clw_a", title: "First" }]))).toBe(true);
    expect(isDependencyParkReason("Waiting on `o/r#1` to merge")).toBe(false);
    expect(isDependencyParkReason("Needs the operator to rotate a key")).toBe(false);
  });
});
