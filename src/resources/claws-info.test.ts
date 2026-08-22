import { describe, it, expect } from "vitest";
import { CLAWS_AUTOMATION_DOC, CLAWS_AUTOMATION_DOC_PATH, SESSION_WORKFLOW_PROMPT } from "./claws-info.js";

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

  it("documents the pull-requests-only contribution convention", () => {
    expect(CLAWS_AUTOMATION_DOC).toContain("All changes land via pull request");
    expect(CLAWS_AUTOMATION_DOC).toContain("never commit or push directly to");
  });
});

describe("SESSION_WORKFLOW_PROMPT", () => {
  it("is non-empty", () => {
    expect(SESSION_WORKFLOW_PROMPT.length).toBeGreaterThan(0);
  });

  it("tells the session to follow the pipeline instead of the repo agents", () => {
    expect(SESSION_WORKFLOW_PROMPT).toContain("issue-refiner");
    expect(SESSION_WORKFLOW_PROMPT).toContain("issue-implementer");
    expect(SESSION_WORKFLOW_PROMPT).toContain("Refined");
  });

  it("contains no '=' character, since session argv is world-readable via /proc/<pid>/cmdline (#2138)", () => {
    expect(SESSION_WORKFLOW_PROMPT).not.toContain("=");
  });

  it("tells the session never to push directly to the default branch", () => {
    expect(SESSION_WORKFLOW_PROMPT).toContain("all changes land via pull request");
    expect(SESSION_WORKFLOW_PROMPT).toContain("Never commit or push directly to the default branch");
  });
});
