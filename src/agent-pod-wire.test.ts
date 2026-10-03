import { describe, it, expect } from "vitest";
import { decodeWire, encodeWire } from "./agent-pod-wire.js";

describe("agent-pod wire encoding", () => {
  it("round-trips plain JSON unchanged", () => {
    const value = { args: [7, "x", null, { a: [1, 2] }] };
    expect(encodeWire(value)).toBe(JSON.stringify(value));
    expect(decodeWire(encodeWire(value))).toEqual(value);
  });

  it("round-trips Maps, Dates and undefined arguments", () => {
    const since = new Date("2026-09-24T12:00:00Z");
    const decoded = decodeWire(encodeWire({ args: ["org/repo", undefined, since], result: new Map([["a", { n: 1 }]]) })) as {
      args: unknown[];
      result: Map<string, unknown>;
    };
    expect(decoded.args).toHaveLength(3);
    expect(decoded.args[1]).toBeUndefined();
    expect(decoded.args[2]).toEqual(since);
    expect(decoded.result).toEqual(new Map([["a", { n: 1 }]]));
  });

  it("drops an undefined result like JSON does", () => {
    expect(decodeWire(encodeWire({ result: undefined }))).toEqual({});
  });
});
