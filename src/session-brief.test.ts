import { describe, it, expect } from "vitest";
import { buildSessionBrief, buildStandaloneSessionBrief, MAX_SESSION_BRIEF_CHARS } from "./session-brief.js";

const base = {
  issueId: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE",
  title: "Fix the widget",
  url: "https://claws.example/issues/clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE",
  body: "The widget is broken.",
  planBody: "## Implementation Plan\n\nFix it.",
  instructions: "Start with the failing test.",
  startedBy: "abc123",
};

describe("buildSessionBrief", () => {
  it("names the issue and the starting session, and carries the instructions, body and plan", () => {
    const brief = buildSessionBrief(base);
    expect(brief).toContain("Session `abc123` started this session for issue #clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE: Fix the widget");
    expect(brief).toContain(`Dashboard: ${base.url}`);
    expect(brief).toContain("Wait for the operator's first message");
    expect(brief).toContain("untrusted data");
    expect(brief).toContain("Start with the failing test.");
    expect(brief).toContain("The widget is broken.");
    expect(brief).toContain("## Implementation Plan");
    expect(brief.indexOf("Start with the failing test.")).toBeLessThan(brief.indexOf("The widget is broken."));
  });

  it("omits the instructions and plan sections when there are none", () => {
    const brief = buildSessionBrief({ ...base, instructions: "  ", planBody: null });
    expect(brief).not.toContain("Starting instructions");
    expect(brief).not.toContain("Latest plan");
  });

  it("truncates a long issue with a marker, keeping the instructions", () => {
    const brief = buildSessionBrief({ ...base, body: "x".repeat(50_000) });
    expect(brief.length).toBe(MAX_SESSION_BRIEF_CHARS);
    expect(brief).toContain("Start with the failing test.");
    expect(brief.endsWith("[… brief truncated: read the full issue with claws_get_issue]")).toBe(true);
  });
});

describe("buildStandaloneSessionBrief", () => {
  it("carries the instructions as untrusted data and no issue text", () => {
    const brief = buildStandaloneSessionBrief({ instructions: "Wire the transceiver.", startedBy: "abc123" });
    expect(brief).toContain("Session `abc123` started this session; it is not attached to a Claws issue");
    expect(brief).toContain("Wait for the operator's first message");
    expect(brief).toContain("untrusted data");
    expect(brief).toContain("Wire the transceiver.");
    expect(brief).not.toContain("### Issue body");
    expect(brief).not.toContain("### Latest plan");
    expect(brief).not.toContain("Dashboard:");
  });

  it("says none were given for empty instructions", () => {
    expect(buildStandaloneSessionBrief({ instructions: "  ", startedBy: "abc123" })).toContain("(none given)");
  });

  it("truncates an over-long brief", () => {
    expect(buildStandaloneSessionBrief({ instructions: "x".repeat(50_000), startedBy: "abc123" }).length).toBe(MAX_SESSION_BRIEF_CHARS);
  });
});
