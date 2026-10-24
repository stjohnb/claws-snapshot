import { describe, it, expect } from "vitest";
import { stripQuotedRegions, removeUnquotedMarkerLines, stripPlanMarkers, normalizePlanText, isPlanComment } from "./marker-text.js";

const MARKER_RE = /^[ \t]*CLAWS_BLOCKED[ \t]*$/;

describe("stripQuotedRegions", () => {
  it("leaves plain prose untouched", () => {
    expect(stripQuotedRegions("## Plan\nDo work\n\nCLAWS_BLOCKED")).toBe("## Plan\nDo work\n\nCLAWS_BLOCKED");
  });

  it("blanks a backtick-fenced block, fence lines included", () => {
    expect(stripQuotedRegions("before\n```\nCLAWS_BLOCKED\n```\nafter")).toBe("before\n\n\n\nafter");
  });

  it("blanks a tilde-fenced block", () => {
    expect(stripQuotedRegions("before\n~~~\nCLAWS_BLOCKED\n~~~\nafter")).toBe("before\n\n\n\nafter");
  });

  it("keeps a 4-backtick fence open across an inner 3-backtick line", () => {
    const text = "````\n```\nCLAWS_BLOCKED\n```\n````\nafter";
    expect(stripQuotedRegions(text)).toBe("\n\n\n\n\nafter");
  });

  it("does not close a fence on a line carrying an info string", () => {
    expect(stripQuotedRegions("```\ntext\n```js\nCLAWS_BLOCKED")).toBe("\n\n\n");
  });

  it("blanks blockquote lines", () => {
    expect(stripQuotedRegions("they wrote:\n> CLAWS_BLOCKED\nand stopped")).toBe("they wrote:\n\nand stopped");
  });

  it("treats an unclosed fence as quoting everything after it", () => {
    expect(stripQuotedRegions("intro\n```\nCLAWS_BLOCKED\nstill inside")).toBe("intro\n\n\n");
  });

  it("does not treat a 4-space indented block as quoted", () => {
    // List continuation lines are routinely indented this far; blanking them
    // would silently drop real plan content.
    expect(stripQuotedRegions("1. step\n    CLAWS_BLOCKED")).toBe("1. step\n    CLAWS_BLOCKED");
  });

  it("preserves the line count so anchored patterns still line up", () => {
    const text = "a\n```\nb\n```\nc";
    expect(stripQuotedRegions(text).split("\n").length).toBe(text.split("\n").length);
  });
});

describe("removeUnquotedMarkerLines", () => {
  it("deletes an asserted marker line and trims", () => {
    expect(removeUnquotedMarkerLines("Waiting on upstream.\n\nCLAWS_BLOCKED", MARKER_RE)).toBe("Waiting on upstream.");
  });

  it("leaves a fenced copy intact while deleting the asserted one", () => {
    const text = "Use:\n```\nCLAWS_BLOCKED\n```\nand then\nCLAWS_BLOCKED";
    expect(removeUnquotedMarkerLines(text, MARKER_RE)).toBe("Use:\n```\nCLAWS_BLOCKED\n```\nand then");
  });

  it("leaves a blockquoted copy intact", () => {
    expect(removeUnquotedMarkerLines("> CLAWS_BLOCKED", MARKER_RE)).toBe("> CLAWS_BLOCKED");
  });

  it("returns unchanged text when no marker is present", () => {
    expect(removeUnquotedMarkerLines("## Plan\nDo work", MARKER_RE)).toBe("## Plan\nDo work");
  });
});

describe("plan comment helpers", () => {
  const HASH = "b".repeat(64);
  const stamped = `*— Automated by Claws —*\n\n## Implementation Plan\n\nplan text\n\nCLAWS_PLAN_BODY_HASH: ${HASH}\nCLAWS_PLAN_LAST_COMMENT: clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC`;

  it("stripPlanMarkers drops only the trailing marker block", () => {
    expect(stripPlanMarkers(stamped)).toBe("*— Automated by Claws —*\n\n## Implementation Plan\n\nplan text");
    expect(stripPlanMarkers("prose CLAWS_PLAN_LAST_COMMENT: 5 inline\n\nmore")).toBe("prose CLAWS_PLAN_LAST_COMMENT: 5 inline\n\nmore");
  });

  it("normalizePlanText drops the header and the markers", () => {
    expect(normalizePlanText(stamped)).toBe("## Implementation Plan\n\nplan text");
  });

  it("isPlanComment needs both the plan header and the Claws marker", () => {
    expect(isPlanComment(stamped)).toBe(true);
    expect(isPlanComment("## Implementation Plan\n\nmine")).toBe(false);
    expect(isPlanComment("*— Automated by Claws —*\n\nA reply.")).toBe(false);
  });
});
