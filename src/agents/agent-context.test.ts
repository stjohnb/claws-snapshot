import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  HOME_ASSISTANT_BASE_URL: undefined,
  HOME_ASSISTANT_CONFIG_REPO: undefined,
}));

const { mockGh, mockGuardContent } = vi.hoisted(() => ({
  mockGh: {
    isClawsComment: vi.fn(),
    stripClawsMarker: vi.fn(),
  },
  mockGuardContent: vi.fn(),
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../prompt-guard.js", () => ({
  guardContent: mockGuardContent,
}));

import { formatIssueCommentsForPrompt } from "./agent-context.js";
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
