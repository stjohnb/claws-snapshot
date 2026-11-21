import { describe, it, expect } from "vitest";
import { holdKindSlug } from "./hold-kind.js";

describe("holdKindSlug", () => {
  it.each([
    ["Held for re-approval: x", "reapproval"],
    ["review escalated: x", "escalation"],
    ["Stacked PR: x", "stacked"],
    ["CI re-run refused: x", "ci-rerun-refused"],
    ["Manual action after merge: x", "post-merge"],
    ["set the secret", "operator-step"],
  ])("%s -> %s", (reason, slug) => expect(holdKindSlug(reason)).toBe(slug));
});
