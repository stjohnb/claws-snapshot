import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { CLAWS_AUTOMATION_DOC, CLAWS_AUTOMATION_DOC_PATH, SESSION_WORKFLOW_PROMPT } from "./claws-info.js";
import { PHASE_CLAIM_RE } from "../phase-coverage.js";

describe("claws-info", () => {
  it("exports the correct doc path", () => {
    expect(CLAWS_AUTOMATION_DOC_PATH).toBe("docs/claws-automation.md");
  });

  it("contains all label display names", () => {
    expect(CLAWS_AUTOMATION_DOC).toContain("Refined");
    expect(CLAWS_AUTOMATION_DOC).toContain("Ready");
    expect(CLAWS_AUTOMATION_DOC).toContain("Priority");
    expect(CLAWS_AUTOMATION_DOC).toContain("In Review");
    expect(CLAWS_AUTOMATION_DOC).toContain("Blocked");
    expect(CLAWS_AUTOMATION_DOC).toContain("Claws Ignore");
    expect(CLAWS_AUTOMATION_DOC).toContain("Claws Problematic");
    expect(CLAWS_AUTOMATION_DOC).toContain("Duplicate");
    expect(CLAWS_AUTOMATION_DOC).toContain("Billing");
    expect(CLAWS_AUTOMATION_DOC).toContain("Plan: Deep");
    expect(CLAWS_AUTOMATION_DOC).toContain("Use Codex");
    expect(CLAWS_AUTOMATION_DOC).toContain("Use Claude");
  });

  it("contains do-not-edit guidance", () => {
    expect(CLAWS_AUTOMATION_DOC).toContain("do not edit it by hand");
  });

  it("documents the pull-requests-only contribution convention", () => {
    expect(CLAWS_AUTOMATION_DOC).toContain("All changes land via pull request");
    expect(CLAWS_AUTOMATION_DOC).toContain("never commit or push directly to");
  });

  it("documents the multi-PR phase markers and the claim comment", () => {
    expect(CLAWS_AUTOMATION_DOC).toContain("## Multi-PR issues");
    expect(CLAWS_AUTOMATION_DOC).toContain("claws-phase-done");
    expect(CLAWS_AUTOMATION_DOC).toContain("## PR N of M");
  });

  it("distinguishes Refined (triggers implementation) from Ready (awaits a human)", () => {
    expect(CLAWS_AUTOMATION_DOC).toContain("### Refined vs Ready");
    expect(CLAWS_AUTOMATION_DOC).toContain("the only label that makes Claws implement an issue and open a PR");
  });

  it("matches the checked-in docs/claws-automation.md byte-for-byte", () => {
    const onDisk = fs.readFileSync(
      new URL("../../docs/claws-automation.md", import.meta.url),
      "utf8",
    );
    expect(onDisk).toBe(CLAWS_AUTOMATION_DOC);
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

  it("tells the session to let Claws plan and implement normal repo work", () => {
    expect(SESSION_WORKFLOW_PROMPT).toContain("file or update a GitHub issue describing the work");
    expect(SESSION_WORKFLOW_PROMPT).toContain("Do not write the implementation plan into the issue yourself and do not open a PR");
  });

  it("makes monitoring and steering the default session role", () => {
    expect(SESSION_WORKFLOW_PROMPT).toContain("Default to monitoring and steering the existing Claws workflow");
    expect(SESSION_WORKFLOW_PROMPT).toContain("Watch the plan, PR, merge, and deployment flow");
  });

  it("contains no '=' character, since session argv is world-readable via /proc/<pid>/cmdline (#2138)", () => {
    expect(SESSION_WORKFLOW_PROMPT).not.toContain("=");
  });

  it("preserves the manual exception path and the multi-PR marker guidance", () => {
    expect(SESSION_WORKFLOW_PROMPT).toContain("Exception: if the user explicitly asks for a change here and now");
    expect(SESSION_WORKFLOW_PROMPT).toContain("## Multi-PR issues");
    expect(SESSION_WORKFLOW_PROMPT).toContain("claws-phase-done");
    expect(SESSION_WORKFLOW_PROMPT).toContain("claws_issue_phases");
  });

  it("tells the session never to push directly to the default branch", () => {
    expect(SESSION_WORKFLOW_PROMPT).toContain("all changes land via pull request");
    expect(SESSION_WORKFLOW_PROMPT).toContain("Never commit or push directly to the default branch");
  });

  it("tells the session that Ready does not trigger a PR", () => {
    expect(SESSION_WORKFLOW_PROMPT).toContain("**Refined** and **Ready** are not the same thing");
    expect(SESSION_WORKFLOW_PROMPT).toContain("will never produce a PR on its own");
  });

  it("points the session at the /ship skill for end-to-end shipping requests", () => {
    expect(SESSION_WORKFLOW_PROMPT).toContain("/ship");
  });
});

describe("claim marker self-matching", () => {
  // The instruction text uses a `<numbers>` placeholder rather than digits, so
  // neither constant is itself parsed as a claim if it lands in a comment.
  it("does not match the session prompt or the synced doc", () => {
    expect(PHASE_CLAIM_RE.test(SESSION_WORKFLOW_PROMPT)).toBe(false);
    expect(PHASE_CLAIM_RE.test(CLAWS_AUTOMATION_DOC)).toBe(false);
  });
});
