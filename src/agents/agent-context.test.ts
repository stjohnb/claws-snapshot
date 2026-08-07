import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  HOME_ASSISTANT_BASE_URL: undefined,
  HOME_ASSISTANT_CONFIG_REPO: undefined,
}));

const { mockGh, mockGuardContent, mockFs } = vi.hoisted(() => ({
  mockGh: {
    isClawsComment: vi.fn(),
    stripClawsMarker: vi.fn(),
  },
  mockGuardContent: vi.fn(),
  mockFs: {
    existsSync: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../prompt-guard.js", () => ({
  guardContent: mockGuardContent,
}));
vi.mock("node:fs", () => ({ default: mockFs }));

import { formatIssueCommentsForPrompt, REVIEW_VERIFICATION_CONTEXT, FRONTEND_AESTHETICS_CONTEXT, frontendContext, RUNNER_POLICY_CONTEXT, RUNNER_LABEL_POLICY, RUNNER_ENVIRONMENT_POLICY } from "./agent-context.js";
import type { IssueComment } from "../github.js";

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
