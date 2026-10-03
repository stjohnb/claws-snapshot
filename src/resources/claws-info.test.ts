import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { CLAWS_AUTOMATION_DOC, CLAWS_AUTOMATION_DOC_PATH, sessionWorkflowPrompt } from "./claws-info.js";
import { PHASE_CLAIM_RE } from "../phase-coverage.js";

// The no-gate-writes variant: see sessionWorkflowPrompt's JSDoc
// (#clw_01M3BWP83BQRXE06NWW1GKYT2S). A dedicated describe block below covers
// the gate-writes-available variant.
const SESSION_WORKFLOW_PROMPT = sessionWorkflowPrompt(false);

describe("claws-info", () => {
  it("exports the correct doc path", () => {
    expect(CLAWS_AUTOMATION_DOC_PATH).toBe("docs/claws-automation.md");
  });

  it("contains all label display names", () => {
    expect(CLAWS_AUTOMATION_DOC).toContain("Refined");
    expect(CLAWS_AUTOMATION_DOC).toContain("Ready");
    expect(CLAWS_AUTOMATION_DOC).toContain("Priority");
    expect(CLAWS_AUTOMATION_DOC).not.toContain("In Review");
    expect(CLAWS_AUTOMATION_DOC).toContain("Blocked");
    expect(CLAWS_AUTOMATION_DOC).toContain("Backlog");
    expect(CLAWS_AUTOMATION_DOC).toContain("Claws Ignore");
    expect(CLAWS_AUTOMATION_DOC).toContain("Claws Staging");
    expect(CLAWS_AUTOMATION_DOC).toContain("Claws Problematic");
    expect(CLAWS_AUTOMATION_DOC).toContain("Duplicate");
    expect(CLAWS_AUTOMATION_DOC).toContain("Billing");
    expect(CLAWS_AUTOMATION_DOC).toContain("Plan: Deep");
    expect(CLAWS_AUTOMATION_DOC).toContain("Use Codex");
    expect(CLAWS_AUTOMATION_DOC).toContain("Use Claude");
    expect(CLAWS_AUTOMATION_DOC).toContain("Use OpenCode");
  });

  it("contains do-not-edit guidance", () => {
    expect(CLAWS_AUTOMATION_DOC).toContain("do not edit it by hand");
  });

  it("documents where issues live", () => {
    expect(CLAWS_AUTOMATION_DOC).toContain("## Where issues live");
    expect(CLAWS_AUTOMATION_DOC).toContain("claws_create_issue");
    expect(CLAWS_AUTOMATION_DOC).toContain("#clw_…");
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

  it("documents Claws Staging as label-restricted staging execution, not approval", () => {
    expect(CLAWS_AUTOMATION_DOC).toContain("staging activation state's issue/PR pipeline");
    expect(CLAWS_AUTOMATION_DOC).toContain("does not approve a plan, review, CI gate, or merge");
  });

  it("matches the checked-in docs/claws-automation.md byte-for-byte", () => {
    const onDisk = fs.readFileSync(
      new URL("../../docs/claws-automation.md", import.meta.url),
      "utf8",
    );
    expect(onDisk).toBe(CLAWS_AUTOMATION_DOC);
  });

  it("documents the multi-repo primary repository rule", () => {
    expect(CLAWS_AUTOMATION_DOC).toContain("primary repository");
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
    expect(SESSION_WORKFLOW_PROMPT).toContain("file or update an issue in the Claws tracker describing the work");
    expect(SESSION_WORKFLOW_PROMPT).toContain("Do not write the implementation plan into the issue yourself and do not open a PR");
  });

  it("tells the session to file and comment through claws_create_issue / claws_comment_on_issue, falling back to gh only when unavailable", () => {
    expect(SESSION_WORKFLOW_PROMPT).toContain("claws_create_issue");
    expect(SESSION_WORKFLOW_PROMPT).toContain("claws_comment_on_issue");
    expect(SESSION_WORKFLOW_PROMPT).toContain("gh issue create");
  });

  it("makes monitoring and steering the default session role", () => {
    expect(SESSION_WORKFLOW_PROMPT).toContain("Default to monitoring and steering the existing Claws workflow");
    expect(SESSION_WORKFLOW_PROMPT).toContain("Watch the plan, PR, merge, and deployment flow");
  });

  it("contains no '=' character, since session argv is world-readable via /proc/<pid>/cmdline (#2138)", () => {
    expect(SESSION_WORKFLOW_PROMPT).not.toContain("=");
  });

  it("tells the session to report its state with claws_set_session_status (#3083)", () => {
    expect(SESSION_WORKFLOW_PROMPT).toContain("claws_set_session_status");
    for (const status of ["working", "monitoring", "waiting", "done"]) {
      expect(SESSION_WORKFLOW_PROMPT).toContain(`Set \`${status}\``);
    }
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

  it("tells the session to name every repo a multi-repo issue touches, not narrow to one", () => {
    expect(SESSION_WORKFLOW_PROMPT).toContain("naming every repository the work touches");
    expect(SESSION_WORKFLOW_PROMPT).not.toContain("exactly one repo");
    expect(SESSION_WORKFLOW_PROMPT).not.toContain("narrow");
  });

  it("omits the native-issue gate-write tools when the session has no scoped credential (#clw_01M3BWP83BQRXE06NWW1GKYT2S)", () => {
    expect(SESSION_WORKFLOW_PROMPT).not.toContain("claws_set_issue_label");
    expect(SESSION_WORKFLOW_PROMPT).not.toContain("claws_promote_issue");
    expect(SESSION_WORKFLOW_PROMPT).not.toContain("claws_set_issue_model_plan");
    expect(SESSION_WORKFLOW_PROMPT).not.toContain("claws_clear_pr_manual_action");
    expect(SESSION_WORKFLOW_PROMPT).not.toContain("claws_set_issue_state");
    expect(SESSION_WORKFLOW_PROMPT).not.toContain("claws_set_issue_repos");
    // Without the tools, adding a repo is still the operator's Repositories form.
    expect(SESSION_WORKFLOW_PROMPT).toContain("Repositories form");
  });
});

describe("sessionWorkflowPrompt(true) — a session with the gate-write tools", () => {
  const WITH_GATES = sessionWorkflowPrompt(true);

  it("names the native-issue gate-write tools", () => {
    expect(WITH_GATES).toContain("claws_set_issue_label");
    expect(WITH_GATES).toContain("claws_promote_issue");
    expect(WITH_GATES).toContain("claws_set_issue_model_plan");
    expect(WITH_GATES).toContain("claws_clear_pr_manual_action");
  });

  it("names the issue-page tools and no longer sends the user to the Repositories form (#clw_01M3KZW7Y4RVDPVZG22HG8ET1M)", () => {
    for (const tool of ["claws_set_issue_state", "claws_edit_issue", "claws_set_issue_repos", "claws_set_issue_column"]) {
      expect(WITH_GATES).toContain(tool);
    }
    expect(WITH_GATES).not.toContain("Repositories form");
  });

  it("still contains no '=' character (#2138)", () => {
    expect(WITH_GATES).not.toContain("=");
  });
});

describe("session prompt tracks docs/issue-tracker.md", () => {
  const doc = fs
    .readFileSync(new URL("../../docs/issue-tracker.md", import.meta.url), "utf8")
    .replace(/\s+/g, " ");

  const DOC_ANCHORS: Array<{ doc: string; prompt: string }> = [
    { doc: "the issue's *primary* repo is the alphabetically first of them", prompt: "alphabetically first" },
    { doc: "Each PR starts once every PR it depends on has merged", prompt: "the PRs it depends on have merged" },
    { doc: "gets a follow-up that names the PR it applies to rather than a re-plan", prompt: "gets a follow-up rather than a re-plan" },
    { doc: "the primary repo owns planning, the issue's labels and comments, and phase sequencing", prompt: "phase sequencing" },
  ];

  for (const { doc: docAnchor, prompt: promptAnchor } of DOC_ANCHORS) {
    it(`doc still says "${docAnchor}" and the prompt still says "${promptAnchor}"`, () => {
      expect(doc).toContain(docAnchor);
      expect(SESSION_WORKFLOW_PROMPT).toContain(promptAnchor);
    });
  }
});

describe("claim marker self-matching", () => {
  // The instruction text uses a `<numbers>` placeholder rather than digits, so
  // neither constant is itself parsed as a claim if it lands in a comment.
  it("does not match the session prompt or the synced doc", () => {
    expect(PHASE_CLAIM_RE.test(SESSION_WORKFLOW_PROMPT)).toBe(false);
    expect(PHASE_CLAIM_RE.test(CLAWS_AUTOMATION_DOC)).toBe(false);
  });
});
