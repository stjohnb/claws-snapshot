import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetIssue, mockCommentOnIssue, mockCloseIssue } = vi.hoisted(() => ({
  mockGetIssue: vi.fn(),
  mockCommentOnIssue: vi.fn(),
  mockCloseIssue: vi.fn(),
}));

vi.mock("./config.js", () => ({ SELF_REPO: "St-John-Software/claws" }));
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./claws-issues.js", () => ({ getIssue: mockGetIssue }));
vi.mock("./github.js", () => ({ commentOnIssue: mockCommentOnIssue, closeIssue: mockCloseIssue }));

import { closeRetiredShoppingTrackingIssue, RETIRED_SHOPPING_TRACKING_ISSUE } from "./shopping-tracking-retirement.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockCommentOnIssue.mockResolvedValue(undefined);
  mockCloseIssue.mockResolvedValue(undefined);
});

describe("closeRetiredShoppingTrackingIssue", () => {
  it("comments once with the per-repo pages and closes an open issue as completed", async () => {
    mockGetIssue.mockResolvedValue({ id: RETIRED_SHOPPING_TRACKING_ISSUE, state: "open" });

    await closeRetiredShoppingTrackingIssue();

    expect(mockGetIssue).toHaveBeenCalledWith("clw_01M34R5RF8KCQAY9KWT9NV0FYA");
    expect(mockCommentOnIssue).toHaveBeenCalledTimes(1);
    const [repo, ref, note] = mockCommentOnIssue.mock.calls[0]!;
    expect(repo).toBe("St-John-Software/claws");
    expect(ref).toBe("clw_01M34R5RF8KCQAY9KWT9NV0FYA");
    expect(note).toContain("https://pages.home.bstjohn.net/electronics/docs/main/");
    expect(note).toContain("https://pages.home.bstjohn.net/nixos-config/docs/main/");
    expect(note).toContain("https://pages.home.bstjohn.net/astro/docs/main/");
    expect(mockCloseIssue).toHaveBeenCalledTimes(1);
    expect(mockCloseIssue).toHaveBeenCalledWith("St-John-Software/claws", "clw_01M34R5RF8KCQAY9KWT9NV0FYA", "completed");
    expect(mockCommentOnIssue.mock.invocationCallOrder[0]!).toBeLessThan(mockCloseIssue.mock.invocationCallOrder[0]!);
  });

  it("leaves an already-closed issue alone", async () => {
    mockGetIssue.mockResolvedValue({ id: RETIRED_SHOPPING_TRACKING_ISSUE, state: "closed" });

    await closeRetiredShoppingTrackingIssue();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("does nothing when the issue is missing", async () => {
    mockGetIssue.mockResolvedValue(undefined);

    await closeRetiredShoppingTrackingIssue();

    expect(mockCommentOnIssue).not.toHaveBeenCalled();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });
});
