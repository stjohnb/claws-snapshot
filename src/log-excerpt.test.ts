import { describe, it, expect } from "vitest";
import { excerptLog, extractFailureKeyLines, FAILURE_KEY_LINE_MAX_CHARS, stripAnsi } from "./log-excerpt.js";

describe("excerptLog", () => {
  it("passes short input through untouched", () => {
    expect(excerptLog("hello world", 20_000)).toBe("hello world");
  });

  it("returns empty string unchanged", () => {
    expect(excerptLog("", 20_000)).toBe("");
  });

  it("keeps head and tail with a marker for long input", () => {
    const text = "x".repeat(25_000);
    const result = excerptLog(text, 20_000);
    expect(result.startsWith(text.slice(0, 10))).toBe(true);
    expect(result.endsWith(text.slice(-10))).toBe(true);
    expect(result).toContain("elided");
  });

  it("keeps a trailing ##[error] line in the final 100 chars", () => {
    const text = "pass\n".repeat(6000) + "##[error]Process completed with exit code 1.";
    const result = excerptLog(text, 20_000);
    expect(result).toContain("##[error]Process completed with exit code 1.");
  });
});

describe("stripAnsi", () => {
  it("removes SGR colour codes", () => {
    expect(stripAnsi("\x1b[33mwarning\x1b[0m")).toBe("warning");
  });

  it("removes OSC hyperlink sequences", () => {
    const text = "\x1b]8;;https://example.com\x1b\\link text\x1b]8;;\x1b\\";
    expect(stripAnsi(text)).toBe("link text");
  });

  it("leaves plain text and CRLF untouched", () => {
    expect(stripAnsi("plain text\r\nsecond line")).toBe("plain text\r\nsecond line");
  });
});

describe("extractFailureKeyLines (#clw_01M7TVFG3VATN1NZ4TS9KPJABG)", () => {
  it("keeps vitest failing test names and assertion errors under their headers", () => {
    const log = [
      `=== job 1 "test" (failure)`,
      `--- step 4 "npm test" (failure)`,
      ` ✓ src/ok.test.ts (12 tests) 40ms`,
      ` × src/auth.test.ts > login > rejects a bad token 12ms`,
      ` FAIL  src/auth.test.ts > login > rejects a bad token`,
      `AssertionError: expected 401 to be 403`,
      ` Test Files  1 failed | 1 passed (2)`,
      `##[error]Process completed with exit code 1.`,
    ].join("\n");
    expect(extractFailureKeyLines(log, 1_500)).toBe([
      `=== job 1 "test" (failure)`,
      `--- step 4 "npm test" (failure)`,
      ` × src/auth.test.ts > login > rejects a bad token 12ms`,
      ` FAIL  src/auth.test.ts > login > rejects a bad token`,
      `AssertionError: expected 401 to be 403`,
      `##[error]Process completed with exit code 1.`,
    ].join("\n"));
  });

  it("keeps cargo, go, pytest and TAP failures", () => {
    const cargo = "test parser::tests::empty ... FAILED\nthread 'parser::tests::empty' panicked at src/parser.rs:10:5:\ntest result: ok. 3 passed";
    expect(extractFailureKeyLines(cargo, 1_500)).toBe("test parser::tests::empty ... FAILED\nthread 'parser::tests::empty' panicked at src/parser.rs:10:5:");
    const rustc = "   Compiling foo v0.1.0\nerror[E0308]: mismatched types\n  --> src/lib.rs:3:5";
    expect(extractFailureKeyLines(rustc, 1_500)).toBe("error[E0308]: mismatched types");
    const go = "=== RUN   TestFetch\n--- FAIL: TestFetch (0.01s)\n    fetch_test.go:12: got 1, want 2\nok  \tother\t0.1s";
    expect(extractFailureKeyLines(go, 1_500)).toBe("--- FAIL: TestFetch (0.01s)");
    const pytest = "tests/test_a.py::test_one PASSED\ntests/test_a.py::test_two FAILED\nE   assert 1 == 2\nFAILED tests/test_a.py::test_two - assert 1 == 2";
    expect(extractFailureKeyLines(pytest, 1_500)).toBe("tests/test_a.py::test_two FAILED\nFAILED tests/test_a.py::test_two - assert 1 == 2");
    const tap = "TAP version 13\nok 1 - adds\nnot ok 2 - subtracts\n  ---\n1..2";
    expect(extractFailureKeyLines(tap, 1_500)).toBe("not ok 2 - subtracts");
  });

  it("matches upper-case tokens case-sensitively", () => {
    expect(extractFailureKeyLines("we may fail later\nfailed to read cache, retrying", 1_500)).toBe("");
    expect(extractFailureKeyLines("Exit Code 2", 1_500)).toBe("Exit Code 2");
  });

  it("returns \"\" when nothing matches, dropping bare headers", () => {
    expect(extractFailureKeyLines(`=== job 0 "lint" (failure)\n--- step 1 "lint" (failure)\nall good`, 1_500)).toBe("");
  });

  it("drops a step header with no failure line under it", () => {
    const log = `=== job 0 "ci" (failure)\n--- step 1 "a" (failure)\nnothing\n--- step 2 "b" (failure)\nerror: boom`;
    expect(extractFailureKeyLines(log, 1_500)).toBe(`=== job 0 "ci" (failure)\n--- step 2 "b" (failure)\nerror: boom`);
  });

  it("de-duplicates repeated lines and cuts long ones", () => {
    const long = `Error: ${"x".repeat(1_000)}`;
    const out = extractFailureKeyLines(`error: same\nerror: same\n${long}`, 1_500);
    const lines = out.split("\n");
    expect(lines[0]).toBe("error: same");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toHaveLength(FAILURE_KEY_LINE_MAX_CHARS);
  });

  it("keeps a failing test name from the middle of a 50,000-character log the excerpt elides", () => {
    const noise = "running something unremarkable\n".repeat(800);
    const log = `${noise} FAIL  src/deep/middle.test.ts > the hidden one\n${noise}`;
    expect(log.length).toBeGreaterThan(45_000);
    expect(excerptLog(log, 2_000)).not.toContain("the hidden one");
    expect(extractFailureKeyLines(log, 1_500)).toContain("src/deep/middle.test.ts > the hidden one");
  });

  it("over budget keeps the first and last lines with a count marker", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `error: failure number ${i}`);
    const out = extractFailureKeyLines(lines.join("\n"), 1_500);
    expect(out.length).toBeLessThanOrEqual(1_500);
    expect(out.startsWith("error: failure number 0\n")).toBe(true);
    expect(out.endsWith("error: failure number 199")).toBe(true);
    const marker = out.match(/… \[Claws elided (\d+) key lines\] …/);
    expect(marker).not.toBeNull();
    expect(out.split("\n").length - 1 + Number(marker![1])).toBe(200);
  });
});
