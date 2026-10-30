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
  guardContent: async (...args: unknown[]) => mockGuardContent(...args),
}));
vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../claude.js", () => ({ readRepoAgentDoc: mockReadRepoAgentDoc }));
vi.mock("../log.js", () => mockLog);

import { formatIssueCommentsForPrompt, REVIEW_VERIFICATION_CONTEXT, FRONTEND_AESTHETICS_CONTEXT, frontendContext, observabilityContext, forgeContext, RUNNER_POLICY_CONTEXT, FAST_CHECKS_GUIDANCE, CI_FIXER_FAST_CHECKS_GUIDANCE, RUNNER_LABEL_POLICY, RUNNER_ENVIRONMENT_POLICY, loadRepoAgentDoc } from "./agent-context.js";
import type { Repo } from "../config.js";
import type { IssueComment } from "../github.js";
import { OBSERVABILITY_CONTEXT } from "../observability-contract.js";

function makeComment(login: string, body: string): IssueComment {
  return { id: 1, login, body, body_html: body };
}

const stubGuardCtx = (source: string) => ({ repo: "o/r", source, itemNumber: 1 });

describe("formatIssueCommentsForPrompt", () => {
  it("formats a self-authored Claws comment without guarding", async () => {
    const comment = makeComment("clawsbot", "## Implementation Plan\n<!-- claws-marker -->content");
    mockGh.isClawsComment.mockReturnValue(true);
    mockGh.stripClawsMarker.mockReturnValue("## Implementation Plan\ncontent");

    const lines = await formatIssueCommentsForPrompt([comment], "clawsbot", stubGuardCtx);

    expect(lines).toEqual([
      "---",
      "Comment by @clawsbot (automated by Claws):",
      "## Implementation Plan\ncontent",
      "",
    ]);
    expect(mockGuardContent).not.toHaveBeenCalled();
  });

  it("formats a human comment with guardContent applied", async () => {
    const comment = makeComment("human-user", "Please fix the bug");
    mockGh.isClawsComment.mockReturnValue(false);
    mockGh.stripClawsMarker.mockReturnValue("Please fix the bug");
    mockGuardContent.mockImplementation((text: string) => `GUARDED(${text})`);

    const lines = await formatIssueCommentsForPrompt([comment], "clawsbot", stubGuardCtx);

    expect(lines).toEqual([
      "---",
      "Comment by @human-user:",
      "GUARDED(Please fix the bug)",
      "",
    ]);
    expect(mockGuardContent).toHaveBeenCalledWith("Please fix the bug", { repo: "o/r", source: "issue-comment", itemNumber: 1 });
  });

  it("returns empty array for empty comments list", async () => {
    const lines = await formatIssueCommentsForPrompt([], "clawsbot", stubGuardCtx);
    expect(lines).toEqual([]);
  });

  it("passes 'issue-comment' as the guard source, not 'issue-body'", async () => {
    const comment = makeComment("user", "Some text");
    mockGh.isClawsComment.mockReturnValue(false);
    mockGh.stripClawsMarker.mockReturnValue("Some text");
    mockGuardContent.mockReturnValue("GUARDED(Some text)");

    await formatIssueCommentsForPrompt([comment], "clawsbot", stubGuardCtx);

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

describe("observabilityContext", () => {
  beforeEach(() => {
    mockFs.existsSync.mockReset();
    mockFs.readFileSync.mockReset();
  });

  it("points at docs/observability.md whenever it exists, since the whole file is the policy", () => {
    mockFs.existsSync.mockImplementation((p: string) => p === "/wt/docs/observability.md");
    mockFs.readFileSync.mockReturnValue("# Observability\n\nPrometheus on /metrics.");

    const ctx = observabilityContext("/wt");

    expect(ctx).toContain("<observability>");
    expect(ctx).toContain("`docs/observability.md`");
    expect(ctx).toContain("a review flags any such change that skips them");
    expect(ctx).not.toBe(OBSERVABILITY_CONTEXT);
  });

  it("prefers docs/observability.md over an AGENTS.md section", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("# Repo\n\n## Observability\n\nSee docs.");

    expect(observabilityContext("/wt")).toContain("`docs/observability.md`");
  });

  it("points at AGENTS.md when it has an Observability section", () => {
    mockFs.existsSync.mockImplementation((p: string) => p === "/wt/AGENTS.md");
    mockFs.readFileSync.mockReturnValue("# Repo\n\n## Observability\n\nMetrics on /metrics, alerts in Grafana.");

    expect(observabilityContext("/wt")).toContain("`AGENTS.md`");
  });

  it("points at AGENTS.md when it has a legacy logging section", () => {
    mockFs.existsSync.mockImplementation((p: string) => p === "/wt/AGENTS.md");
    mockFs.readFileSync.mockReturnValue("# Repo\n\n## Logging\n\nJSON lines on stdout.");

    expect(observabilityContext("/wt")).toContain("`AGENTS.md`");
  });

  it("points at docs/logging.md when it has a logging section", () => {
    mockFs.existsSync.mockImplementation((p: string) => p === "/wt/docs/logging.md");
    mockFs.readFileSync.mockReturnValue("# Logging\n\n## Log format\n\nJSON lines on stdout.");

    expect(observabilityContext("/wt")).toContain("`docs/logging.md`");
  });

  it("falls back to the contract block when AGENTS.md has no policy section", () => {
    mockFs.existsSync.mockImplementation((p: string) => p === "/wt/AGENTS.md");
    mockFs.readFileSync.mockReturnValue("# Repo\n\n## Build\n\nnpm test");

    expect(observabilityContext("/wt")).toBe(OBSERVABILITY_CONTEXT);
  });

  it("falls back to the contract block when the repo has no policy docs", () => {
    mockFs.existsSync.mockReturnValue(false);

    expect(observabilityContext("/wt")).toBe(OBSERVABILITY_CONTEXT);
  });

  it("asks both branches to verify policy claims against the code and keep Known gaps", () => {
    mockFs.existsSync.mockImplementation((p: string) => p === "/wt/docs/observability.md");
    mockFs.readFileSync.mockReturnValue("# Observability\n\nPrometheus on /metrics.");
    const pointer = observabilityContext("/wt");
    mockFs.existsSync.mockReturnValue(false);
    const fallback = observabilityContext("/wt");

    for (const ctx of [pointer, fallback]) {
      expect(ctx).toContain("verify every statement about current logging, metrics, traces, latency budgets, dashboards and alerts against this repo's code");
      expect(ctx).toContain("`### Known gaps`");
      expect(ctx).toContain("`Accepted: <reason>`");
      expect(ctx).toContain("A review flags an unsupported claim");
    }
  });
});

describe("forgeContext (#2650)", () => {
  const unmarkedRepo: Repo = { owner: "org", name: "repo", fullName: "org/repo", defaultBranch: "main" };
  const forgejoRepo: Repo = { ...unmarkedRepo, forge: "forgejo" };

  it("points every repo's agent at Forgejo and away from gh", () => {
    for (const repo of [forgejoRepo, unmarkedRepo]) {
      const ctx = forgeContext(repo);
      expect(ctx).toContain("https://forge.test/org/repo");
      expect(ctx).toContain("Do NOT use `gh`");
      expect(ctx).toContain(".forgejo/workflows/");
      expect(ctx).toContain("Claws manages no work on GitHub");
      expect(ctx).not.toContain("gh run view");
    }
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

describe("fast-checks guidance", () => {
  it.each([["FAST_CHECKS_GUIDANCE", FAST_CHECKS_GUIDANCE], ["CI_FIXER_FAST_CHECKS_GUIDANCE", CI_FIXER_FAST_CHECKS_GUIDANCE]])("%s matches the host policy", (_n, text) => {
    expect(text).not.toContain("type-check, lint");
    expect(text).toContain("allowScripts");
  });
});
