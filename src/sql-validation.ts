/** SQL validation helpers for the namey_query MCP tool. */

/**
 * Single-pass tokenizer that identifies "real" character positions in SQL —
 * positions outside string literals, block comments, and line comments.
 *
 * Does not handle PostgreSQL's '' escape for embedded quotes (e.g. 'it''s')
 * — this can only produce false positives (rejecting valid queries), never false
 * negatives. The extended query protocol is the real single-statement guard.
 */
function buildRealPositions(sql: string): Set<number> {
  const real = new Set<number>();
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      i++;
      while (i < sql.length && sql[i] !== "'") i++;
      if (i < sql.length) i++;
    } else if (sql[i] === "/" && i + 1 < sql.length && sql[i + 1] === "*") {
      i += 2;
      while (i + 1 < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      if (i + 1 < sql.length) i += 2;
    } else if (sql[i] === "-" && i + 1 < sql.length && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
    } else {
      real.add(i);
      i++;
    }
  }
  return real;
}

/**
 * Strip string literals and SQL comments from SQL, respecting quoting context.
 * String literals are replaced with '' so surrounding SQL structure is preserved.
 */
function stripLiteralsAndComments(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      result += "''";
      i++;
      while (i < sql.length && sql[i] !== "'") i++;
      if (i < sql.length) i++;
    } else if (sql[i] === "/" && i + 1 < sql.length && sql[i + 1] === "*") {
      i += 2;
      while (i + 1 < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      if (i + 1 < sql.length) i += 2;
    } else if (sql[i] === "-" && i + 1 < sql.length && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
    } else {
      result += sql[i];
      i++;
    }
  }
  return result;
}

/** Strip balanced parenthesized expressions to isolate outermost SQL level. */
function stripParenthesized(sql: string): string {
  let result = sql;
  while (/\([^()]*\)/.test(result)) {
    result = result.replace(/\([^()]*\)/g, "");
  }
  return result;
}

/**
 * Strip trailing line comment from SQL, respecting string literal context.
 * Only strips a real `--` comment at the end of the string (not `--` inside quotes).
 * Uses its own inline string tracking because buildRealPositions excludes comment
 * start characters, and this function needs to find where `--` begins.
 */
function stripTrailingComment(sql: string): string {
  let inString = false;
  let trailingStart = -1;
  for (let i = 0; i < sql.length; i++) {
    if (inString) {
      if (sql[i] === "'") inString = false;
    } else if (sql[i] === "'") {
      inString = true;
    } else if (sql[i] === "-" && i + 1 < sql.length && sql[i + 1] === "-") {
      // Found a real -- outside a string. Check if it extends to end of string.
      let j = i + 2;
      while (j < sql.length && sql[j] !== "\n") j++;
      if (j >= sql.length || sql.slice(j).trim() === "") {
        trailingStart = i;
      }
      i = j;
    }
  }
  return trailingStart >= 0 ? sql.slice(0, trailingStart) : sql;
}

/**
 * Find the last occurrence of a LIMIT pattern in SQL that is NOT inside a
 * string literal, block comment, or line comment. Returns the match position
 * and length, or null if no real occurrence exists.
 */
function findLastRealLimitMatch(sql: string, limitPattern: string): { index: number; length: number } | null {
  const realPositions = buildRealPositions(sql);
  const pattern = new RegExp(`\\bLIMIT\\s+${limitPattern}\\b`, "gi");
  let last: { index: number; length: number } | null = null;
  let m;
  while ((m = pattern.exec(sql)) !== null) {
    if (realPositions.has(m.index)) {
      last = { index: m.index, length: m[0].length };
    }
  }
  return last;
}

/**
 * Find the last occurrence of a FETCH FIRST/NEXT N ROWS ONLY pattern in SQL
 * that is NOT inside a string literal, block comment, or line comment.
 * Returns the match position, length, and the captured "ROWS ONLY" suffix,
 * or null if no real occurrence exists.
 */
function findLastRealFetchMatch(sql: string, digits: string): { index: number; length: number; suffix: string } | null {
  const realPositions = buildRealPositions(sql);
  const pattern = new RegExp(`\\bFETCH\\s+(?:FIRST|NEXT)\\s+${digits}\\s+(ROWS?\\s+ONLY)\\b`, "gi");
  let last: { index: number; length: number; suffix: string } | null = null;
  let m;
  while ((m = pattern.exec(sql)) !== null) {
    if (realPositions.has(m.index)) {
      last = { index: m.index, length: m[0].length, suffix: m[1] };
    }
  }
  return last;
}

/**
 * Returns true if the query contains multiple statements (semicolons outside
 * single-quoted string literals and comments). Does not handle dollar-quoting —
 * the extended query protocol is the real single-statement guard.
 */
export function isMultiStatement(sql: string): boolean {
  return /;\s*\S/.test(stripLiteralsAndComments(sql));
}

/**
 * Ensures every query has an outer-level LIMIT capped at 500 rows.
 *
 * - No outer LIMIT → appends `LIMIT 500`.
 * - Outer LIMIT ≤ 500 → returns the query unchanged.
 * - Outer LIMIT > 500 → caps it to `LIMIT 500`.
 *
 * Also detects SQL:2008 `FETCH FIRST N ROWS ONLY` syntax and caps it.
 *
 * A single-pass tokenizer strips comments, string literals, and subqueries
 * before checking, so that `-- LIMIT 1`, `'LIMIT 10'`, and
 * `(SELECT 1 LIMIT 1)` can't bypass the check. Trailing line comments are
 * stripped (respecting string context) before appending so the LIMIT doesn't
 * land inside a comment.
 *
 * Note: `LIMIT ALL` is not recognized (the regex only matches numeric limits).
 * It will get `LIMIT 500` appended, producing invalid SQL (`LIMIT ALL LIMIT 500`).
 * This fails safely — PostgreSQL rejects the syntax — and `LIMIT ALL` is rare.
 */
export function ensureLimit(sql: string): string {
  const stripped = stripParenthesized(stripLiteralsAndComments(sql));

  // Also check for SQL:2008 FETCH FIRST/NEXT N ROWS ONLY syntax, which bypasses a LIMIT-only check.
  // PostgreSQL accepts both FIRST and NEXT as synonyms.
  // Not a security boundary (tool is read-only), but enforces the resource cap.
  const fetchMatch = stripped.match(/\bFETCH\s+(?:FIRST|NEXT)\s+(\d+)\s+ROWS?\s+ONLY\b/i);
  if (fetchMatch) {
    const fetchValue = parseInt(fetchMatch[1], 10);
    if (fetchValue <= 500) return sql;
    // Cap to 500 by replacing the last real occurrence (skipping subqueries/comments/strings).
    const rawDigits = fetchMatch[1];
    const digitPattern = Number.isSafeInteger(fetchValue) ? String(fetchValue) : rawDigits;
    const pos = findLastRealFetchMatch(sql, digitPattern);
    if (pos) {
      return sql.slice(0, pos.index) + `FETCH FIRST 500 ${pos.suffix}` + sql.slice(pos.index + pos.length);
    }
    // Fallback: couldn't locate — strip trailing comments and append LIMIT 500.
    return `${stripTrailingComment(sql).replace(/;\s*$/, "").trimEnd()} LIMIT 500`;
  }

  const match = stripped.match(/\bLIMIT\s+(\d+)/i);
  if (!match) {
    // No outer LIMIT or FETCH FIRST — strip trailing line comments and semicolons before appending
    return `${stripTrailingComment(sql).replace(/;\s*$/, "").trimEnd()} LIMIT 500`;
  }
  const value = parseInt(match[1], 10);
  if (value <= 500) return sql;
  // Outer LIMIT exceeds 500 — cap the last real occurrence (skipping comments/strings).
  // For values beyond Number.MAX_SAFE_INTEGER, parseInt loses precision and the regex
  // won't match the original digits. Use the raw digit string for the regex instead.
  const rawDigits = match[1];
  const limitPattern = Number.isSafeInteger(value) ? String(value) : rawDigits;
  const pos = findLastRealLimitMatch(sql, limitPattern);
  if (pos) {
    return sql.slice(0, pos.index) + "LIMIT 500" + sql.slice(pos.index + pos.length);
  }
  // Fallback: couldn't locate the LIMIT to cap — strip trailing comments and append LIMIT 500.
  return `${stripTrailingComment(sql).replace(/;\s*$/, "").trimEnd()} LIMIT 500`;
}
