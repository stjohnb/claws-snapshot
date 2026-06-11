import { describe, it, expect } from "vitest";
import { isMultiStatement, ensureLimit } from "./sql-validation.js";

describe("isMultiStatement", () => {
  it("rejects semicolons followed by another statement", () => {
    expect(isMultiStatement("SELECT 1; DROP TABLE users")).toBe(true);
  });

  it("allows trailing semicolons with only whitespace after", () => {
    expect(isMultiStatement("SELECT 1;")).toBe(false);
    expect(isMultiStatement("SELECT 1;  ")).toBe(false);
  });

  it("allows semicolons inside single-quoted strings", () => {
    expect(isMultiStatement("SELECT * FROM t WHERE name = 'a;b'")).toBe(false);
  });

  it("allows queries with no semicolons", () => {
    expect(isMultiStatement("SELECT * FROM users")).toBe(false);
  });

  it("rejects queries with semicolons outside string literals", () => {
    expect(isMultiStatement("SELECT 'safe'; DELETE FROM t")).toBe(true);
  });

  it("strips comments before checking for semicolons", () => {
    // Semicolon hidden inside a block comment that also contains quote-like chars
    expect(isMultiStatement("SELECT 1 /* 'trick */ ; DROP TABLE users /* end' */")).toBe(true);
  });

  it("ignores semicolons inside line comments", () => {
    expect(isMultiStatement("SELECT 1 -- ; DROP TABLE users")).toBe(false);
  });

  it("handles -- inside string literal without false positive", () => {
    expect(isMultiStatement("SELECT * FROM t WHERE x = 'a -- b'")).toBe(false);
  });
});

describe("ensureLimit", () => {
  it("appends LIMIT 500 when no LIMIT present", () => {
    expect(ensureLimit("SELECT * FROM users")).toBe("SELECT * FROM users LIMIT 500");
  });

  it("strips trailing semicolon before appending LIMIT", () => {
    expect(ensureLimit("SELECT * FROM users;")).toBe("SELECT * FROM users LIMIT 500");
  });

  it("preserves existing LIMIT", () => {
    expect(ensureLimit("SELECT * FROM users LIMIT 10")).toBe("SELECT * FROM users LIMIT 10");
  });

  it("preserves existing lowercase limit", () => {
    expect(ensureLimit("SELECT * FROM users limit 50")).toBe("SELECT * FROM users limit 50");
  });

  it("strips trailing line comment before appending LIMIT", () => {
    const sql = "SELECT * FROM users -- LIMIT 1";
    expect(ensureLimit(sql)).toBe("SELECT * FROM users LIMIT 500");
  });

  it("ignores LIMIT hidden in a block comment", () => {
    const sql = "SELECT * FROM users /* LIMIT 1 */";
    // Block comments are closed, so appending after them is safe — PostgreSQL sees the LIMIT
    expect(ensureLimit(sql)).toBe("SELECT * FROM users /* LIMIT 1 */ LIMIT 500");
  });

  it("ignores LIMIT inside string literals", () => {
    const sql = "SELECT * FROM big_table WHERE note = 'see LIMIT 10 docs'";
    expect(ensureLimit(sql)).toBe("SELECT * FROM big_table WHERE note = 'see LIMIT 10 docs' LIMIT 500");
  });

  it("ignores LIMIT inside subqueries", () => {
    const sql = "SELECT * FROM big_table WHERE EXISTS (SELECT 1 LIMIT 1)";
    expect(ensureLimit(sql)).toBe("SELECT * FROM big_table WHERE EXISTS (SELECT 1 LIMIT 1) LIMIT 500");
  });

  it("detects outer LIMIT even with subqueries", () => {
    const sql = "SELECT * FROM big_table WHERE EXISTS (SELECT 1) LIMIT 20";
    expect(ensureLimit(sql)).toBe(sql);
  });

  it("caps LIMIT > 500 to 500", () => {
    expect(ensureLimit("SELECT * FROM big_table LIMIT 999999")).toBe("SELECT * FROM big_table LIMIT 500");
  });

  it("caps LIMIT 501 to 500", () => {
    expect(ensureLimit("SELECT * FROM users LIMIT 501")).toBe("SELECT * FROM users LIMIT 500");
  });

  it("preserves LIMIT exactly 500", () => {
    expect(ensureLimit("SELECT * FROM users LIMIT 500")).toBe("SELECT * FROM users LIMIT 500");
  });

  it("caps outer LIMIT > 500 while preserving subquery LIMIT", () => {
    const sql = "SELECT * FROM big_table WHERE EXISTS (SELECT 1 LIMIT 1) LIMIT 10000";
    expect(ensureLimit(sql)).toBe("SELECT * FROM big_table WHERE EXISTS (SELECT 1 LIMIT 1) LIMIT 500");
  });

  it("caps outer LIMIT when subquery has same value > 500", () => {
    const sql = "SELECT * FROM t WHERE EXISTS (SELECT 1 LIMIT 999) LIMIT 999";
    expect(ensureLimit(sql)).toBe("SELECT * FROM t WHERE EXISTS (SELECT 1 LIMIT 999) LIMIT 500");
  });

  it("handles -- inside string literal near real LIMIT", () => {
    const sql = "SELECT * FROM t WHERE x = 'a -- b' LIMIT 10";
    expect(ensureLimit(sql)).toBe(sql);
  });

  it("handles /* */ inside string literal near real LIMIT", () => {
    const sql = "SELECT * FROM t WHERE x = 'a /* b */' LIMIT 10";
    expect(ensureLimit(sql)).toBe(sql);
  });

  it("handles -- inside string literal without outer LIMIT", () => {
    const sql = "SELECT * FROM t WHERE note = 'has -- LIMIT 10'";
    expect(ensureLimit(sql)).toBe("SELECT * FROM t WHERE note = 'has -- LIMIT 10' LIMIT 500");
  });

  it("caps outer LIMIT when same over-limit value appears in a string literal", () => {
    const sql = "SELECT * FROM t WHERE note = 'LIMIT 999' LIMIT 999";
    expect(ensureLimit(sql)).toBe("SELECT * FROM t WHERE note = 'LIMIT 999' LIMIT 500");
  });

  it("caps outer LIMIT when trailing comment has same value", () => {
    const sql = "SELECT * FROM t LIMIT 999 -- see LIMIT 999";
    expect(ensureLimit(sql)).toBe("SELECT * FROM t LIMIT 500 -- see LIMIT 999");
  });

  it("caps outer LIMIT when block comment has same value", () => {
    const sql = "SELECT * FROM t LIMIT 999 /* LIMIT 999 */";
    expect(ensureLimit(sql)).toBe("SELECT * FROM t LIMIT 500 /* LIMIT 999 */");
  });

  it("caps LIMIT with value beyond Number.MAX_SAFE_INTEGER", () => {
    const sql = "SELECT * FROM t LIMIT 99999999999999999999";
    expect(ensureLimit(sql)).toBe("SELECT * FROM t LIMIT 500");
  });

  it("caps LIMIT with large digits in presence of subquery", () => {
    const sql = "SELECT * FROM t WHERE EXISTS (SELECT 1 LIMIT 1) LIMIT 99999999999999999999";
    expect(ensureLimit(sql)).toBe("SELECT * FROM t WHERE EXISTS (SELECT 1 LIMIT 1) LIMIT 500");
  });

  it("caps FETCH FIRST N ROWS ONLY when > 500", () => {
    const sql = "SELECT * FROM users FETCH FIRST 999 ROWS ONLY";
    expect(ensureLimit(sql)).toBe("SELECT * FROM users FETCH FIRST 500 ROWS ONLY");
  });

  it("preserves FETCH FIRST N ROWS ONLY when <= 500", () => {
    const sql = "SELECT * FROM users FETCH FIRST 100 ROWS ONLY";
    expect(ensureLimit(sql)).toBe(sql);
  });

  it("handles FETCH FIRST N ROW ONLY (singular)", () => {
    const sql = "SELECT * FROM users FETCH FIRST 999 ROW ONLY";
    expect(ensureLimit(sql)).toBe("SELECT * FROM users FETCH FIRST 500 ROW ONLY");
  });

  it("caps outer FETCH FIRST when subquery has same value > 500", () => {
    const sql = "SELECT * FROM (SELECT * FROM t FETCH FIRST 999 ROWS ONLY) s FETCH FIRST 999 ROWS ONLY";
    expect(ensureLimit(sql)).toBe("SELECT * FROM (SELECT * FROM t FETCH FIRST 999 ROWS ONLY) s FETCH FIRST 500 ROWS ONLY");
  });

  it("caps FETCH NEXT N ROWS ONLY when > 500", () => {
    const sql = "SELECT * FROM users FETCH NEXT 10000 ROWS ONLY";
    expect(ensureLimit(sql)).toBe("SELECT * FROM users FETCH FIRST 500 ROWS ONLY");
  });

  it("preserves FETCH NEXT N ROWS ONLY when <= 500", () => {
    const sql = "SELECT * FROM users FETCH NEXT 50 ROWS ONLY";
    expect(ensureLimit(sql)).toBe(sql);
  });

  it("caps outer FETCH FIRST when subquery uses FETCH NEXT with same value", () => {
    const sql = "SELECT * FROM (SELECT * FROM t FETCH NEXT 999 ROWS ONLY) s FETCH FIRST 999 ROWS ONLY";
    expect(ensureLimit(sql)).toBe("SELECT * FROM (SELECT * FROM t FETCH NEXT 999 ROWS ONLY) s FETCH FIRST 500 ROWS ONLY");
  });
});
