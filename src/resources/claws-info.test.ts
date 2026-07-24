import { describe, it, expect } from "vitest";
import { CLAWS_AUTOMATION_DOC, CLAWS_AUTOMATION_DOC_PATH } from "./claws-info.js";

describe("claws-info", () => {
  it("exports the correct doc path", () => {
    expect(CLAWS_AUTOMATION_DOC_PATH).toBe("docs/claws-automation.md");
  });

  it("contains all label display names", () => {
    expect(CLAWS_AUTOMATION_DOC).toContain("Refined");
    expect(CLAWS_AUTOMATION_DOC).toContain("Ready");
    expect(CLAWS_AUTOMATION_DOC).toContain("Priority");
    expect(CLAWS_AUTOMATION_DOC).toContain("In Review");
    expect(CLAWS_AUTOMATION_DOC).toContain("Claws Ignore");
    expect(CLAWS_AUTOMATION_DOC).toContain("Claws Problematic");
    expect(CLAWS_AUTOMATION_DOC).toContain("Duplicate");
    expect(CLAWS_AUTOMATION_DOC).toContain("Billing");
    expect(CLAWS_AUTOMATION_DOC).toContain("Plan: Fable");
  });

  it("contains do-not-edit guidance", () => {
    expect(CLAWS_AUTOMATION_DOC).toContain("do not edit it by hand");
  });
});
