import { describe, it, expect } from "vitest";
import { linkedIssueRefFromPR } from "./issue-link.js";

const NATIVE_ID = "clw_01JBQ5ZK3N8T4Q7M2V9XWR6HDA";

describe("linkedIssueRefFromPR", () => {
  it("reads a numeric ref from the branch name", () => {
    expect(linkedIssueRefFromPR({ headRefName: "claws/issue-123-fix-thing", body: null })).toBe(123);
  });

  it("reads a native ref from the branch name", () => {
    expect(linkedIssueRefFromPR({ headRefName: `claws/issue-${NATIVE_ID}-fix-thing`, body: null })).toBe(NATIVE_ID);
  });

  it("prefers the branch over the body when both are present", () => {
    expect(
      linkedIssueRefFromPR({ headRefName: "claws/issue-123-fix-thing", body: "Closes #456" }),
    ).toBe(123);
  });

  it("falls back to a numeric ref in the body", () => {
    expect(linkedIssueRefFromPR({ headRefName: "some-other-branch", body: "Fixes #456" })).toBe(456);
  });

  it("falls back to a native ref in the body", () => {
    expect(
      linkedIssueRefFromPR({ headRefName: "some-other-branch", body: `Resolves #${NATIVE_ID}` }),
    ).toBe(NATIVE_ID);
  });

  it("recognises all four body keywords, case-insensitively", () => {
    for (const kw of ["closes", "Fixes", "RESOLVES", "part of"]) {
      expect(linkedIssueRefFromPR({ headRefName: "other", body: `${kw} #789` })).toBe(789);
    }
  });

  it("returns null when neither convention matches", () => {
    expect(linkedIssueRefFromPR({ headRefName: "some-other-branch", body: "no reference here" })).toBeNull();
  });

  it("returns null for a missing body", () => {
    expect(linkedIssueRefFromPR({ headRefName: "some-other-branch" })).toBeNull();
  });

  it("rejects a 27th trailing character on a native id (clw_<26>X boundary)", () => {
    expect(linkedIssueRefFromPR({ headRefName: "other", body: `Closes #${NATIVE_ID}X` })).toBeNull();
  });

  it("does not let a clw_<26>X body ref fall through to a shorter match", () => {
    // The boundary guard means clw_<26>X matches nothing at all, not a
    // truncated 26-character prefix of the 27-character string.
    const result = linkedIssueRefFromPR({ headRefName: "other", body: `Closes #${NATIVE_ID}X` });
    expect(result).not.toBe(NATIVE_ID);
  });
});
