import { describe, it, expect } from "vitest";
import { lineDiff, type DiffOp } from "./blog-diff.js";

function ops(a: string, b: string): DiffOp[] {
  const d = lineDiff(a, b);
  if ("tooLarge" in d) throw new Error("unexpected tooLarge");
  return d.ops;
}

describe("lineDiff", () => {
  it("returns only same lines for identical input", () => {
    expect(ops("a\nb\nc", "a\nb\nc")).toEqual([
      { op: "same", text: "a" },
      { op: "same", text: "b" },
      { op: "same", text: "c" },
    ]);
    expect(ops("", "")).toEqual([]);
  });

  it("marks added lines", () => {
    expect(ops("a\nc", "a\nb\nc")).toEqual([
      { op: "same", text: "a" },
      { op: "add", text: "b" },
      { op: "same", text: "c" },
    ]);
    expect(ops("", "x\ny")).toEqual([
      { op: "add", text: "x" },
      { op: "add", text: "y" },
    ]);
  });

  it("marks deleted lines", () => {
    expect(ops("a\nb\nc", "a\nc")).toEqual([
      { op: "same", text: "a" },
      { op: "del", text: "b" },
      { op: "same", text: "c" },
    ]);
  });

  it("diffs mixed changes, keeping the longest common subsequence", () => {
    const d = ops("title: old\nkeep 1\nremove me\nkeep 2\nend", "title: new\nkeep 1\nkeep 2\nadded\nend");
    expect(d).toEqual([
      { op: "del", text: "title: old" },
      { op: "add", text: "title: new" },
      { op: "same", text: "keep 1" },
      { op: "del", text: "remove me" },
      { op: "same", text: "keep 2" },
      { op: "add", text: "added" },
      { op: "same", text: "end" },
    ]);
  });

  it("treats CRLF and LF line endings alike", () => {
    expect(ops("a\r\nb", "a\nb").every((o) => o.op === "same")).toBe(true);
  });

  it("skips inputs over the line cap", () => {
    const big = Array.from({ length: 1600 }, (_, i) => `line ${i}`).join("\n");
    expect(lineDiff(big, big + "\nmore")).toEqual({ tooLarge: true });
    expect(lineDiff("a\nb", "a\nc", 3)).toEqual({ tooLarge: true });
    expect("ops" in lineDiff("a\nb", "a\nc", 4)).toBe(true);
  });
});
