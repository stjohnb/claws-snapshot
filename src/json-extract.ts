import { z } from "zod";
import * as log from "./log.js";

/**
 * Multi-strategy JSON extraction for LLM outputs that may contain backticks or
 * braces inside quoted string values.
 */
export function extractJsonCandidates(output: string): string[] {
  const candidates: string[] = [];

  // Strategy 1: greedy fence — handles bodies that contain ``` because we
  // anchor on the LAST closing fence in the output, not the first.
  const greedyFence = output.match(/```json\s*([\s\S]*)```/);
  if (greedyFence) candidates.push(greedyFence[1].trim());

  // Strategy 2: original non-greedy fence (fallback for trailing prose after
  // the fence that contains stray ```).
  const lazyFence = output.match(/```json\s*([\s\S]*?)```/);
  if (lazyFence) candidates.push(lazyFence[1].trim());

  // Strategy 3: brace-balanced extraction starting at the last '{' before the
  // first top-level key found in the output. Walks the string while respecting
  // JSON string escapes so embedded braces and backticks inside quoted values
  // don't throw off balance.
  const firstKeyIdx = output.search(/"[a-zA-Z_][a-zA-Z0-9_]*"\s*:/);
  if (firstKeyIdx !== -1) {
    let start = -1;
    for (let i = firstKeyIdx; i >= 0; i--) {
      if (output[i] === "{") { start = i; break; }
    }
    if (start !== -1) {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < output.length; i++) {
        const ch = output[i];
        if (escape) { escape = false; continue; }
        if (inString) {
          if (ch === "\\") { escape = true; continue; }
          if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            candidates.push(output.slice(start, i + 1));
            break;
          }
        }
      }
    }
  }

  return [...new Set(candidates)];
}

/**
 * Repair invalid JSON string escapes that LLMs commonly emit (e.g. \( \. \_ \s
 * from Markdown-escaped chars or regex snippets embedded in a string value).
 * Drops the backslash from any \X where X is not a legal JSON escape char,
 * leaving X as a literal. Valid escapes (\" \\ \/ \b \f \n \r \t \uXXXX) and
 * everything outside string literals are left untouched.
 */
export function repairJsonEscapes(input: string): string {
  const VALID = '"\\/bfnrtu';
  let out = "";
  let inString = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === "\\") {
      const next = input[i + 1];
      if (next !== undefined && VALID.includes(next)) {
        out += ch + next; // valid escape — copy both, skip next
        i++;
      }
      // else: invalid escape — drop the backslash, let `next` be copied normally
      continue;
    }
    out += ch;
    if (ch === '"') inString = false;
  }
  return out;
}

/**
 * Parse the first schema-valid JSON object from LLM output. Tries each candidate
 * from extractJsonCandidates(); returns the validated outer object, or null if
 * none parse. Callers apply any per-item validation to the returned object.
 */
export function parseFirstValidJson<T>(
  output: string,
  schema: z.ZodType<T>,
  logPrefix: string,
  onFailure?: (err: unknown, candidates: string[]) => void,
): T | null {
  const candidates = extractJsonCandidates(output);

  if (candidates.length === 0) {
    const err = new Error("No JSON candidates found in Claude output");
    log.warn(`[${logPrefix}] ${err.message}`);
    onFailure?.(err, []);
    return null;
  }

  let lastErr: unknown;
  for (const candidate of candidates) {
    for (const attempt of [candidate, repairJsonEscapes(candidate)]) {
      try {
        const result = schema.safeParse(JSON.parse(attempt));
        if (!result.success) {
          lastErr = new Error(`Schema validation failed: ${result.error.message}`);
          continue;
        }
        return result.data;
      } catch (err) {
        lastErr = err;
      }
    }
  }

  log.warn(`[${logPrefix}] Failed to parse JSON: ${lastErr}`);
  onFailure?.(lastErr, candidates);
  return null;
}
