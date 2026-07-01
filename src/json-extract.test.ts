import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLog = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));
vi.mock("./log.js", () => mockLog);

import { z } from "zod";
import { parseFirstValidJson, extractJsonCandidates, repairJsonEscapes } from "./json-extract.js";
import * as log from "./log.js";

const schema = z.object({ a: z.string() });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extractJsonCandidates", () => {
  it("extracts from fenced json block", () => {
    const output = '```json\n{"a":"hello"}\n```';
    const candidates = extractJsonCandidates(output);
    expect(candidates.some((c) => c.includes('"a"'))).toBe(true);
  });

  it("extracts from brace-balanced inline JSON", () => {
    const output = 'Here is the result: {"a":"world"}';
    const candidates = extractJsonCandidates(output);
    expect(candidates.some((c) => c.includes('"a"'))).toBe(true);
  });

  it("returns empty array when no JSON present", () => {
    expect(extractJsonCandidates("no json here")).toEqual([]);
  });
});

describe("parseFirstValidJson", () => {
  it("returns validated object from a fenced json block", () => {
    const output = '```json\n{"a":"hello"}\n```';
    const result = parseFirstValidJson(output, schema, "test");
    expect(result).toEqual({ a: "hello" });
  });

  it("returns validated object from brace-balanced candidate", () => {
    const output = 'Result: {"a":"world"}';
    const result = parseFirstValidJson(output, schema, "test");
    expect(result).toEqual({ a: "world" });
  });

  it("returns null and calls onFailure with empty array when no candidates", () => {
    const onFailure = vi.fn();
    const result = parseFirstValidJson("no json here", schema, "test", onFailure);
    expect(result).toBeNull();
    expect(onFailure).toHaveBeenCalledOnce();
    const [err, candidates] = onFailure.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("No JSON candidates found in Claude output");
    expect(candidates).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });

  it("returns null and calls onFailure with candidates when all fail schema", () => {
    const onFailure = vi.fn();
    const strictSchema = z.object({ a: z.string() }).strict();
    const output = '{"b":"wrong"}';
    const result = parseFirstValidJson(output, strictSchema, "test", onFailure);
    expect(result).toBeNull();
    expect(onFailure).toHaveBeenCalledOnce();
    const [err, candidates] = onFailure.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("returns null and calls onFailure when JSON is malformed", () => {
    const onFailure = vi.fn();
    const output = '{"a": bad json}';
    const result = parseFirstValidJson(output, schema, "test", onFailure);
    expect(result).toBeNull();
    expect(onFailure).toHaveBeenCalledOnce();
    const [, candidates] = onFailure.mock.calls[0];
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("picks the first schema-valid candidate when multiple exist", () => {
    const output = '```json\n{"a":"first"}\n```\n{"a":"second"}';
    const result = parseFirstValidJson(output, schema, "test");
    expect(result).toEqual({ a: "first" });
  });

  it("does not throw when onFailure is omitted", () => {
    expect(() => parseFirstValidJson("no json", schema, "test")).not.toThrow();
  });

  it("does not call onFailure mid-loop when one candidate fails schema but another succeeds", () => {
    const onFailure = vi.fn();
    const strictSchema = z.object({ a: z.string() }).strict();
    // Brace-balanced strategy picks up {"a":"ok"} first (it's earlier in the output),
    // then fence strategies pick up {"extra":"bad"} — but iteration order puts fence
    // first. So fence candidate fails strict schema, brace-balanced candidate succeeds.
    // onFailure must NOT be called because a valid candidate was found.
    const output = 'Earlier: {"a":"ok"}\n```json\n{"extra":"bad"}\n```';
    const result = parseFirstValidJson(output, strictSchema, "test", onFailure);
    expect(result).toEqual({ a: "ok" });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("recovers JSON with invalid escape sequences via repair fallback", () => {
    // Regression test for issue #1772: LLM emits \s (from a regex snippet) in
    // a string value. Runtime string contains literal \s which is invalid JSON.
    const output = '```json\n{"a":"regex \\s+ matcher"}\n```';
    const onFailure = vi.fn();
    const result = parseFirstValidJson(output, schema, "test", onFailure);
    // \s becomes s (backslash dropped)
    expect(result).toEqual({ a: "regex s+ matcher" });
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe("repairJsonEscapes", () => {
  it("is a no-op on valid JSON with valid escapes", () => {
    const input = '{"a":"line\\nbreak \\\\ slash \\" quote"}';
    expect(repairJsonEscapes(input)).toBe(input);
  });

  it("removes invalid escape backslash while leaving the following char", () => {
    // Runtime string: {"a":"ws.on\("error"\)"}
    // \( and \) are invalid JSON escapes
    const input = '{"a":"ws.on\\("error"\\)"}';
    const repaired = repairJsonEscapes(input);
    expect(repaired).toBe('{"a":"ws.on("error")"}');
  });

  it("preserves an escaped backslash followed by a non-escape char (avoids naive regex corruption)", () => {
    // Runtime string: {"a":"x\\s"} — literal \\s = escaped-backslash + s
    // The \\ is valid, the s should remain untouched after it
    const input = '{"a":"x\\\\s"}';
    const repaired = repairJsonEscapes(input);
    // \\ is valid so both chars are kept; s is then just a plain char
    expect(repaired).toBe('{"a":"x\\\\s"}');
  });

  it("does not touch backslashes outside string literals", () => {
    // Structural JSON has no backslashes; just verify structural chars pass through
    const input = '{"a":"hello","b":"world"}';
    expect(repairJsonEscapes(input)).toBe(input);
  });

  it("strips various invalid escape chars LLMs commonly emit", () => {
    // \s \. \_ \[ are all invalid JSON escapes
    const input = '{"a":"regex \\s+ and \\.* and \\_ and \\[0-9]"}';
    const repaired = repairJsonEscapes(input);
    expect(repaired).toBe('{"a":"regex s+ and .* and _ and [0-9]"}');
  });
});
