import { describe, it, expect, beforeEach } from "vitest";
import {
  newUlid,
  newClawsIssueId,
  newClawsCommentId,
  isClawsIssueId,
  isClawsCommentId,
  canonicalIssueRef,
  canonicalCommentRef,
  parseIssueRef,
  sameIssueRef,
  compareIssueRefs,
  shortIssueRef,
  ISSUE_REF_PATTERN,
  resetIssueIdGeneratorForTest,
} from "./issue-id.js";

describe("newUlid", () => {
  beforeEach(() => {
    resetIssueIdGeneratorForTest();
  });

  it("produces 26 Crockford base32 characters", () => {
    expect(newUlid(1_700_000_000_000)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is strictly increasing within one millisecond", () => {
    const now = 1_700_000_000_000;
    const a = newUlid(now);
    const b = newUlid(now);
    const c = newUlid(now);

    expect(new Set([a, b, c]).size).toBe(3);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it("sorts a later timestamp after earlier ids", () => {
    const earlier = newUlid(1_700_000_000_000);
    const later = newUlid(1_700_000_000_001);

    expect(earlier < later).toBe(true);
  });

  it("keeps increasing when the clock steps backwards", () => {
    const first = newUlid(1_700_000_000_005);
    const backwards = newUlid(1_700_000_000_000);

    expect(first < backwards).toBe(true);
    // The timestamp prefix is held, not rewound.
    expect(backwards.slice(0, 10)).toBe(first.slice(0, 10));
  });

  it("encodes the timestamp in the leading characters", () => {
    const a = newUlid(0);
    expect(a.slice(0, 10)).toBe("0000000000");
  });
});

describe("id prefixes", () => {
  it("mints issue and comment ids from the same generator", () => {
    const issue = newClawsIssueId();
    const comment = newClawsCommentId();

    expect(issue).toMatch(/^clw_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(comment).toMatch(/^clwc_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isClawsIssueId(issue)).toBe(true);
    expect(isClawsCommentId(comment)).toBe(true);
  });

  it("does not confuse a comment id for an issue id", () => {
    const comment = newClawsCommentId();
    expect(isClawsIssueId(comment)).toBe(false);
    expect(isClawsCommentId(newClawsIssueId())).toBe(false);
  });
});

describe("predicates", () => {
  const id = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

  it("accepts any case", () => {
    expect(isClawsIssueId(id.toLowerCase())).toBe(true);
    expect(isClawsIssueId(id.toUpperCase())).toBe(true);
  });

  it("rejects numbers, short ids and non-Crockford letters", () => {
    expect(isClawsIssueId(123)).toBe(false);
    expect(isClawsIssueId("clw_01JBQ")).toBe(false);
    expect(isClawsIssueId("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDU")).toBe(false);
    expect(isClawsIssueId(undefined)).toBe(false);
  });
});

describe("canonicalIssueRef", () => {
  it("passes numbers through and converts digit strings", () => {
    expect(canonicalIssueRef(42)).toBe(42);
    expect(canonicalIssueRef("42")).toBe(42);
    expect(canonicalIssueRef(" 42 ")).toBe(42);
  });

  it("uppercases a native id's body and lowercases its prefix", () => {
    expect(canonicalIssueRef("CLW_01jbq7x4m2k8nv3tyrw9gz5pdc")).toBe("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
  });

  it("returns null for anything else", () => {
    expect(canonicalIssueRef("nonsense")).toBeNull();
    expect(canonicalIssueRef("")).toBeNull();
    expect(canonicalIssueRef(null)).toBeNull();
    expect(canonicalIssueRef(Number.NaN)).toBeNull();
  });

  it("canonicalises comment ids separately", () => {
    expect(canonicalCommentRef("clwc_01jbq7x4m2k8nv3tyrw9gz5pdc")).toBe("clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
    expect(canonicalCommentRef("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC")).toBeNull();
    expect(canonicalCommentRef("7")).toBe(7);
  });
});

describe("parseIssueRef", () => {
  it("tolerates a leading hash and whitespace", () => {
    expect(parseIssueRef(" #3215 ")).toBe(3215);
    expect(parseIssueRef("#clw_01jbq7x4m2k8nv3tyrw9gz5pdc")).toBe("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
    expect(parseIssueRef("#nope")).toBeNull();
  });
});

describe("sameIssueRef", () => {
  it("compares canonical forms", () => {
    expect(sameIssueRef(7, "7")).toBe(true);
    expect(sameIssueRef("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", "clw_01jbq7x4m2k8nv3tyrw9gz5pdc")).toBe(true);
    expect(sameIssueRef(7, 8)).toBe(false);
    expect(sameIssueRef(null, null)).toBe(false);
  });
});

describe("compareIssueRefs", () => {
  it("sorts forge numbers before native ids", () => {
    const refs = ["clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", 12, "clw_01AAQ7X4M2K8NV3TYRW9GZ5PDC", 3];
    expect([...refs].sort(compareIssueRefs)).toEqual([
      3,
      12,
      "clw_01AAQ7X4M2K8NV3TYRW9GZ5PDC",
      "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC",
    ]);
  });
});

describe("shortIssueRef", () => {
  it("keeps the last six characters of a native id, uppercased", () => {
    expect(shortIssueRef("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC")).toBe("clw_GZ5PDC");
  });

  it("canonicalises a lowercase native id before shortening", () => {
    expect(shortIssueRef("clw_01jbq7x4m2k8nv3tyrw9gz5pdc")).toBe("clw_GZ5PDC");
  });

  it("returns a forge issue number unchanged as a string", () => {
    expect(shortIssueRef(3303)).toBe("3303");
  });

  it("returns a non-ref string unchanged", () => {
    expect(shortIssueRef("nonsense")).toBe("nonsense");
  });

  it("returns an empty string for null or undefined", () => {
    expect(shortIssueRef(null)).toBe("");
    expect(shortIssueRef(undefined)).toBe("");
  });
});

describe("ISSUE_REF_PATTERN", () => {
  it("matches both ref shapes with and without the i flag", () => {
    for (const flags of ["g", "gi"]) {
      const re = new RegExp(`#(${ISSUE_REF_PATTERN})`, flags);
      const found = [...`Closes #123 and #clw_01jbq7x4m2k8nv3tyrw9gz5pdc`.matchAll(re)].map((m) => m[1]);
      expect(found).toEqual(["123", "clw_01jbq7x4m2k8nv3tyrw9gz5pdc"]);
    }
  });
});
