import { describe, it, expect } from "vitest";
import { buildIssueOpeningMessage, buildPrOpeningMessage, buildPrSessionBrief, buildSessionBrief, buildStandaloneSessionBrief, MAX_SESSION_BRIEF_CHARS, MAX_SESSION_DESCRIPTION_LEN, issueSessionTitle, prSessionTitle, standaloneSessionTitle, parsePrSessionRef, prSessionRef, type PrSessionInput } from "./session-brief.js";
import { MAX_SESSION_INITIAL_PROMPT_CHARS } from "./session-initial-prompt.js";

const base = {
  issueId: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE",
  title: "Fix the widget",
  url: "https://claws.example/issues/clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE",
  body: "The widget is broken.",
  planBody: "## Implementation Plan\n\nFix it.",
  instructions: "Start with the failing test.",
  startedBy: "abc123",
};

describe("buildIssueOpeningMessage", () => {
  const input = { issueId: base.issueId, title: "  Fix the widget ", stageTitle: "In progress", repos: ["org/a", "org/b"], focus: null } as const;

  it("opens with the issue id, gathers context read-only and waits for the operator", () => {
    const msg = buildIssueOpeningMessage(input);
    expect(msg.split("\n")[0]).toBe("#clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE");
    expect(msg).toContain("Fix the widget (stage: In progress; repositories: org/a, org/b)");
    for (const tool of ["claws_get_issue", "claws_issue_links", "claws_task_history", "claws_open_prs", "claws_forgejo_job_logs", "blocked_reason"]) expect(msg).toContain(tool);
    expect(msg).toContain("Do not edit files, push, comment");
    expect(msg).not.toContain("Look into that first");
    expect(msg).toContain("wait for the operator's next message");
  });

  it("quotes a Blocked reason, truncated to 500 characters", () => {
    const msg = buildIssueOpeningMessage({ ...input, focus: { kind: "blocked", reason: "x".repeat(20_000) } });
    expect(msg).toContain(`recorded reason: "${"x".repeat(499)}…"`);
    expect(msg).toContain("Look into that first.");
    expect(msg.length).toBeLessThan(MAX_SESSION_INITIAL_PROMPT_CHARS);
  });

  it("says when a Blocked issue has no recorded reason", () => {
    expect(buildIssueOpeningMessage({ ...input, focus: { kind: "blocked", reason: null } })).toContain("no reason was recorded");
  });

  it("names a stalled PR, a manual-action hold and failed work", () => {
    expect(buildIssueOpeningMessage({ ...input, focus: { kind: "stalled-pr", repo: "org/a", number: 7, reason: "Claws gave up fixing its CI" } })).toContain("org/a#7 is stalled: Claws gave up fixing its CI");
    expect(buildIssueOpeningMessage({ ...input, focus: { kind: "manual-action", repo: "org/a", number: 7, reason: "needs a secret" } })).toContain('held for manual action (reason: "needs a secret")');
    expect(buildIssueOpeningMessage({ ...input, focus: { kind: "failed-work", job: "issue-worker", failureReason: null } })).toContain("issue-worker) failed (no category recorded)");
  });

  it("says an unassigned issue has no repository yet", () => {
    expect(buildIssueOpeningMessage({ ...input, repos: [] })).toContain("no repository yet");
  });
});

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

  it("says the operator started it from the issue page and that Claws sends the opening message", () => {
    const brief = buildSessionBrief({ ...base, instructions: null, startedBy: null, origin: "issue-page" });
    expect(brief).toContain("The operator started this session from the issue page for issue #clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE: Fix the widget");
    expect(brief).not.toContain("There is no opening message");
    expect(brief).toContain("Claws' own note naming this issue");
    expect(brief).toContain("untrusted data");
  });

  it("says the operator started it from the board when no session did", () => {
    const brief = buildSessionBrief({ ...base, instructions: null, startedBy: null });
    expect(brief).toContain("The operator started this session from the board for issue #clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE: Fix the widget");
    expect(brief).toContain("gather context as it says, then wait for the operator");
    expect(brief).toContain("started from the dashboard");
    expect(brief).toContain("Claws' own note naming this issue");
    expect(brief).not.toContain("Session `");
    expect(brief).not.toContain("Starting instructions");
    expect(brief).toContain("The widget is broken.");
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

describe("PR-started sessions", () => {
  const pr: PrSessionInput = {
    repo: "org/app",
    number: 42,
    title: "Fix the widget",
    branch: "claws/issue-42",
    url: "https://github.com/org/app/pull/42",
    issueId: "clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE",
    issueUrl: "https://claws.example/issues/clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE",
    focus: null,
  };

  it("briefs the PR's repo, number, title, branch, link and linked issue", () => {
    const brief = buildPrSessionBrief(pr);
    expect(brief).toContain("## Pull request this session was started for");
    expect(brief).toContain("from the PRs page for pull request org/app#42: Fix the widget");
    expect(brief).toContain("Branch: claws/issue-42");
    expect(brief).toContain("Link: https://github.com/org/app/pull/42");
    expect(brief).toContain("Linked Claws issue: #clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE (https://claws.example/issues/clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE)");
    expect(brief).toContain("branch is not checked out");
  });

  it("says when the PR has no linked issue", () => {
    const brief = buildPrSessionBrief({ ...pr, issueId: null, issueUrl: null });
    expect(brief).toContain("The pull request has no linked Claws issue.");
    expect(brief).not.toContain("Linked Claws issue:");
  });

  it("opens with the PR ref, gathers context read-only and waits, with no focus pointer for a healthy PR", () => {
    const msg = buildPrOpeningMessage(pr);
    expect(msg.split("\n")[0]).toBe("org/app#42");
    expect(msg).toContain("Fix the widget (https://github.com/org/app/pull/42)");
    expect(msg).toContain("Gather context about it read-only");
    expect(msg).toContain("Do not edit files, push, comment, label, merge");
    expect(msg).toContain("wait for the operator's next message before acting");
    expect(msg).not.toContain("likely subject");
  });

  it.each([
    [{ kind: "manual-action", reason: "Rotate the API key first" }, "pending manual-action hold", "Rotate the API key first"],
    [{ kind: "problematic" }, "problematic mark", null],
    [{ kind: "ci-fix-exhausted" }, "CI fixer has given up", null],
    [{ kind: "ci-blocked", reason: "billing" }, "blocked CI", "billing"],
    [{ kind: "ci-failing" }, "its failing CI", null],
    [{ kind: "ci-held" }, "held for approval", null],
  ] as const)("points at the %o focus", (focus, phrase, reason) => {
    const msg = buildPrOpeningMessage({ ...pr, focus });
    expect(msg).toContain("The likely subject of this session is");
    expect(msg).toContain(phrase);
    if (reason) expect(msg).toContain(reason);
    expect(msg).toContain("summarise the problem and what the operator could do");
  });

  it("keeps the opening message well under the initial-prompt cap with a long reason", () => {
    const msg = buildPrOpeningMessage({ ...pr, focus: { kind: "manual-action", reason: "x".repeat(20_000) } });
    expect(msg.length).toBeLessThan(MAX_SESSION_INITIAL_PROMPT_CHARS / 4);
  });

  it("round-trips the spawned_for_pr ref", () => {
    expect(prSessionRef("org/app", 42)).toBe("org/app#42");
    expect(parsePrSessionRef("org/app#42")).toEqual({ repo: "org/app", number: 42 });
    expect(parsePrSessionRef(null)).toBeNull();
    expect(parsePrSessionRef("org/app")).toBeNull();
    expect(parsePrSessionRef("org/app#x")).toBeNull();
  });
});

describe("standaloneSessionTitle", () => {
  it("prefers the explicit title, normalised and clamped", () => {
    expect(standaloneSessionTitle("  Debug  Loki\nOOM ", "ignored", "abcdef123")).toBe("Debug Loki OOM");
    const t = standaloneSessionTitle("x".repeat(300), "", "abcdef123");
    expect(t.length).toBe(MAX_SESSION_DESCRIPTION_LEN);
    expect(t.endsWith("…")).toBe(true);
  });
  it("derives from the first non-empty instruction line when the explicit title is blank", () => {
    expect(standaloneSessionTitle("  ", "\n\n## Fix the relay\n- more", "abcdef123")).toBe("Fix the relay");
    expect(standaloneSessionTitle(null, "- Wire it up", "abcdef123")).toBe("Wire it up");
  });
  it("falls back to the starting session id", () => {
    expect(standaloneSessionTitle(undefined, " \n ", "abcdef123456")).toBe("Started by session abcdef12");
  });
});

describe("issueSessionTitle / prSessionTitle", () => {
  it("formats issue and PR titles", () => {
    expect(issueSessionTitle("Fix  the\nbug")).toBe("Issue: Fix the bug");
    expect(prSessionTitle(7, "Add thing")).toBe("PR #7: Add thing");
  });
  it("truncates to the description limit with an ellipsis", () => {
    const t = issueSessionTitle("x".repeat(500))!;
    expect(t.length).toBe(MAX_SESSION_DESCRIPTION_LEN);
    expect(t.endsWith("…")).toBe(true);
  });
  it("returns null for a blank title", () => {
    expect(issueSessionTitle("  ")).toBeNull();
    expect(prSessionTitle(1, null)).toBeNull();
  });
});
