import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  HOME_ASSISTANT_BASE_URL: undefined,
  HOME_ASSISTANT_CONFIG_REPO: undefined,
  forgejoRepoUrl: (fullName: string) => `https://forge.test/${fullName}`,
}));

const { mockGh, mockGuardContent, mockFs, mockReadRepoAgentDoc, mockLog } = vi.hoisted(() => ({
  mockReadRepoAgentDoc: vi.fn(),
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockGh: {
    isClawsComment: vi.fn(),
    stripClawsMarker: vi.fn(),
  },
  mockGuardContent: vi.fn(),
  mockFs: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../prompt-guard.js", () => ({
  guardContent: mockGuardContent,
}));
vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../claude.js", () => ({ readRepoAgentDoc: mockReadRepoAgentDoc }));
vi.mock("../log.js", () => mockLog);

import { formatIssueCommentsForPrompt, REVIEW_VERIFICATION_CONTEXT, FRONTEND_AESTHETICS_CONTEXT, frontendContext, LOGGING_CONTEXT, loggingContext, forgeContext, RUNNER_POLICY_CONTEXT, RUNNER_LABEL_POLICY, RUNNER_ENVIRONMENT_POLICY, loadRepoAgentDoc } from "./agent-context.js";
import type { Repo } from "../config.js";
import type { IssueComment } from "../github.js";
import { LOGGING_CONTRACT_MARKDOWN } from "../logging-contract.js";

function makeComment(login: string, body: string): IssueComment {
  return { id: 1, login, body, body_html: body };
}

const stubGuardCtx = (source: string) => ({ repo: "o/r", source, itemNumber: 1 });

describe("formatIssueCommentsForPrompt", () => {
  it("formats a self-authored Claws comment without guarding", () => {
    const comment = makeComment("clawsbot", "## Implementation Plan\n<!-- claws-marker -->content");
    mockGh.isClawsComment.mockReturnValue(true);
    mockGh.stripClawsMarker.mockReturnValue("## Implementation Plan\ncontent");

    const lines = formatIssueCommentsForPrompt([comment], "clawsbot", stubGuardCtx);

    expect(lines).toEqual([
      "---",
      "Comment by @clawsbot (automated by Claws):",
      "## Implementation Plan\ncontent",
      "",
    ]);
    expect(mockGuardContent).not.toHaveBeenCalled();
  });

  it("formats a human comment with guardContent applied", () => {
    const comment = makeComment("human-user", "Please fix the bug");
    mockGh.isClawsComment.mockReturnValue(false);
    mockGh.stripClawsMarker.mockReturnValue("Please fix the bug");
    mockGuardContent.mockImplementation((text: string) => `GUARDED(${text})`);

    const lines = formatIssueCommentsForPrompt([comment], "clawsbot", stubGuardCtx);

    expect(lines).toEqual([
      "---",
      "Comment by @human-user:",
      "GUARDED(Please fix the bug)",
      "",
    ]);
    expect(mockGuardContent).toHaveBeenCalledWith("Please fix the bug", { repo: "o/r", source: "issue-comment", itemNumber: 1 });
  });

  it("returns empty array for empty comments list", () => {
    const lines = formatIssueCommentsForPrompt([], "clawsbot", stubGuardCtx);
    expect(lines).toEqual([]);
  });

  it("passes 'issue-comment' as the guard source, not 'issue-body'", () => {
    const comment = makeComment("user", "Some text");
    mockGh.isClawsComment.mockReturnValue(false);
    mockGh.stripClawsMarker.mockReturnValue("Some text");
    mockGuardContent.mockReturnValue("GUARDED(Some text)");

    formatIssueCommentsForPrompt([comment], "clawsbot", stubGuardCtx);

    expect(mockGuardContent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ source: "issue-comment" }),
    );
  });
});

describe("REVIEW_VERIFICATION_CONTEXT", () => {
  it("instructs the reviewer to verify git facts before asserting them", () => {
    expect(REVIEW_VERIFICATION_CONTEXT).toContain("POST-CHANGE");
    expect(REVIEW_VERIFICATION_CONTEXT).toMatch(/already merged/i);
    expect(REVIEW_VERIFICATION_CONTEXT).toMatch(/read-only/i);
    expect(REVIEW_VERIFICATION_CONTEXT).toMatch(/verify/i);
    expect(REVIEW_VERIFICATION_CONTEXT).toMatch(/git/);
  });
});

describe("FRONTEND_AESTHETICS_CONTEXT", () => {
  it("points agents at the repo's own design guidelines and the generic-defaults fallback", () => {
    expect(FRONTEND_AESTHETICS_CONTEXT).toContain("docs/DESIGN.md");
    expect(FRONTEND_AESTHETICS_CONTEXT).toContain("Inter");
    expect(FRONTEND_AESTHETICS_CONTEXT).toContain("prefers-reduced-motion");
  });
});

describe("RUNNER_POLICY_CONTEXT", () => {
  it("concatenates the label policy and the environment policy, separated by a blank line", () => {
    expect(RUNNER_POLICY_CONTEXT).toBe(`${RUNNER_LABEL_POLICY}\n\n${RUNNER_ENVIRONMENT_POLICY}`);
  });
});

describe("frontendContext", () => {
  beforeEach(() => {
    mockFs.existsSync.mockReset();
  });

  it("returns a short pointer at the repo's design doc when one exists", () => {
    mockFs.existsSync.mockImplementation((p: string) => p === "/wt/docs/DESIGN.md");

    const ctx = frontendContext("/wt");

    expect(ctx).toContain("`docs/DESIGN.md` is authoritative");
    expect(ctx).not.toContain("Inter");
    expect(ctx.length).toBeLessThan(FRONTEND_AESTHETICS_CONTEXT.length);
  });

  it("names the first candidate that exists, in priority order", () => {
    mockFs.existsSync.mockImplementation((p: string) => p === "/wt/.claude/rules/frontend.md");

    expect(frontendContext("/wt")).toContain("`.claude/rules/frontend.md` is authoritative");
  });

  it("falls back to the full anti-slop block when the repo has no design doc", () => {
    mockFs.existsSync.mockReturnValue(false);

    expect(frontendContext("/wt")).toBe(FRONTEND_AESTHETICS_CONTEXT);
  });
});

describe("loggingContext", () => {
  beforeEach(() => {
    mockFs.existsSync.mockReset();
    mockFs.readFileSync.mockReset();
  });

  it("points at docs/logging.md when it has a logging section", () => {
    mockFs.existsSync.mockImplementation((p: string) => p === "/wt/docs/logging.md");
    mockFs.readFileSync.mockReturnValue("# Logging\n\n## Log format\n\nJSON lines on stdout.");

    const ctx = loggingContext("/wt");

    expect(ctx).toContain("`docs/logging.md`");
    expect(ctx.length).toBeLessThan(LOGGING_CONTEXT.length);
  });

  it("falls back to the contract block when docs/logging.md has no logging section", () => {
    mockFs.existsSync.mockImplementation((p: string) => p === "/wt/docs/logging.md");
    mockFs.readFileSync.mockReturnValue("# Docs\n\nSee elsewhere.");

    expect(loggingContext("/wt")).toBe(LOGGING_CONTEXT);
  });

  it("points at AGENTS.md when it has a logging section", () => {
    mockFs.existsSync.mockImplementation((p: string) => p === "/wt/AGENTS.md");
    mockFs.readFileSync.mockReturnValue("# Repo\n\n## Logging\n\nJSON lines on stdout.");

    expect(loggingContext("/wt")).toContain("`AGENTS.md`");
  });

  it("falls back to the contract block when AGENTS.md has no logging section", () => {
    mockFs.existsSync.mockImplementation((p: string) => p === "/wt/AGENTS.md");
    mockFs.readFileSync.mockReturnValue("# Repo\n\n## Build\n\nnpm test");

    expect(loggingContext("/wt")).toBe(LOGGING_CONTEXT);
  });

  it("points at AGENTS.md when it contains the canonical contract block inside a fence", () => {
    mockFs.existsSync.mockImplementation((p: string) => p === "/wt/AGENTS.md");
    mockFs.readFileSync.mockReturnValue(`# Repo\n\n\`\`\`\`markdown\n${LOGGING_CONTRACT_MARKDOWN}\n\`\`\`\`\n\n## Build\n\nnpm test`);

    expect(loggingContext("/wt")).toContain("`AGENTS.md`");
  });

  it("falls back to the contract block when the repo has no logging docs", () => {
    mockFs.existsSync.mockReturnValue(false);

    expect(loggingContext("/wt")).toBe(LOGGING_CONTEXT);
  });
});

describe("forgeContext (#2650)", () => {
  const githubRepo: Repo = { owner: "org", name: "repo", fullName: "org/repo", defaultBranch: "main" };
  const forgejoRepo: Repo = { ...githubRepo, forge: "forgejo" };

  it("is empty for a GitHub repo so call sites can append it unconditionally", () => {
    expect(forgeContext(githubRepo)).toBe("");
  });

  it("points a Forgejo repo's agent at Forgejo and away from gh", () => {
    const ctx = forgeContext(forgejoRepo);
    expect(ctx).toContain("https://forge.test/org/repo");
    expect(ctx).toContain("Do NOT use `gh`");
    expect(ctx).toContain(".forgejo/workflows/");
    expect(ctx).toContain("read-only push mirror");
  });
});

describe("loadRepoAgentDoc", () => {
  beforeEach(() => {
    mockReadRepoAgentDoc.mockReset();
    mockLog.info.mockReset();
    mockLog.warn.mockReset();
    mockLog.error.mockReset();
  });

  it("returns the role document body and logs which document the run loaded", () => {
    mockReadRepoAgentDoc.mockReturnValue("repo-specific review rules");

    const doc = loadRepoAgentDoc("/wt", "org/repo", "pr-reviewer");

    expect(doc).toBe("repo-specific review rules");
    expect(mockReadRepoAgentDoc).toHaveBeenCalledWith("/wt", "pr-reviewer");
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining(".agents/pr-reviewer.md"));
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it("warns without alerting when there is no usable role document", () => {
    mockReadRepoAgentDoc.mockReturnValue(undefined);

    const doc = loadRepoAgentDoc("/wt", "org/repo", "issue-refiner");

    expect(doc).toBeUndefined();
    const warning = mockLog.warn.mock.calls[0]![0] as string;
    expect(warning).toContain("org/repo");
    expect(warning).toContain(".agents/issue-refiner.md");
    // Missing and empty are indistinguishable to readRepoAgentDoc, so the wording says both.
    expect(warning).toContain("missing or empty");
    // claude-config-scanner owns the per-repo alert; a per-run report would spam forever.
    expect(mockLog.error).not.toHaveBeenCalled();
  });
});
