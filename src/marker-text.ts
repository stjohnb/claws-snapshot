/**
 * Asserted-vs-quoted marker text (#3154, subsuming #3046).
 *
 * Claws' control markers travel as plain text through agent output and issue
 * comments, so *documenting* a marker used to fire it: a plan explaining how a
 * human retires a step wrote the claim string with a digit and thereby claimed
 * the step, and a plan discussing the duplicate verdict had every sentence
 * naming it cut at the marker. A marker only counts when it is **asserted** —
 * never when it is quoted inside a fenced code block or a blockquote.
 *
 * Every marker parser routes through here rather than being anchored one at a
 * time. Two shapes are needed and one cannot be built from the other:
 * `stripQuotedRegions` blanks quoted text before *matching*, while
 * `removeUnquotedMarkerLines` must return the original text minus a marker
 * line, so it walks the lines itself.
 *
 * Deliberate boundaries:
 * - Indented (4-space) code blocks are NOT quoted. List continuation lines are
 *   routinely indented that far and blanking them would silently drop content.
 * - Inline code spans are NOT stripped. Line anchoring already defeats a
 *   mid-sentence mention, and tracking backticks across lines is fragile.
 * - An unclosed fence quotes everything to the end of the text. A swallowed
 *   verdict degrades to "no verdict"; a wrongly-honoured one corrupts pipeline
 *   state, so this is the safe direction.
 *
 * The header Claws stamps on its own comments lives here too, for the same
 * reason: `isClawsComment` is a pure string predicate every marker parser
 * needs, and reaching it through `github.ts` — whose import graph the tests of
 * those parsers stub out — is what pushed a dozen test files into hand-rolling
 * their own copy of it at their own fidelities.
 *
 * This module imports only the leaf `issue-id.ts` from the rest of Claws, so
 * any module can use it.
 */

import { COMMENT_REF_PATTERN } from "./issue-id.js";

/** Opens a fence: 0–3 leading spaces, then 3+ backticks or tildes (info string allowed). */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
/** Closes a fence: the same run of fence characters and nothing else on the line. */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/;
/** A blockquote line: 0–3 leading spaces, then `>`. */
const BLOCKQUOTE_RE = /^ {0,3}>/;

/**
 * Per-line "is this text quoted rather than asserted?" flags. Fence lines
 * themselves count as quoted, so a marker sitting on the opening fence line is
 * not honoured either.
 */
function quotedLineFlags(lines: string[]): boolean[] {
  const flags: boolean[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of lines) {
    if (fence) {
      flags.push(true);
      const close = line.match(FENCE_CLOSE_RE);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      continue;
    }
    const open = line.match(FENCE_OPEN_RE);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      flags.push(true);
      continue;
    }
    flags.push(BLOCKQUOTE_RE.test(line));
  }
  return flags;
}

/**
 * Blank every quoted line, keeping the line count so `^`/`m`-anchored patterns
 * and any offsets still line up. Use this before *matching* any marker.
 */
export function stripQuotedRegions(text: string): string {
  const lines = text.split("\n");
  const quoted = quotedLineFlags(lines);
  return lines.map((line, i) => (quoted[i] ? "" : line)).join("\n");
}

/**
 * Delete the lines matching `re` that are asserted, leaving quoted copies
 * intact. `re` must be a non-global, line-scoped pattern — it is tested against
 * one line at a time (e.g. `/^[ \t]*CLAWS_BLOCKED[ \t]*$/m`). A `g` flag would
 * make `lastIndex` carry between lines; `m` is harmless and lets the same
 * pattern be reused for whole-text matching.
 */
export function removeUnquotedMarkerLines(text: string, re: RegExp): string {
  const lines = text.split("\n");
  const quoted = quotedLineFlags(lines);
  return lines.filter((line, i) => quoted[i] || !re.test(line)).join("\n").trim();
}

// ── Claws' own comment header ──

/** Visible header prepended to every comment Claws posts so conversations read naturally. */
export const CLAWS_VISIBLE_HEADER = "*— Automated by Claws —*";

/** Previous visible header — kept for backward compatibility with old comments. */
const LEGACY_VISIBLE_HEADER = "*— Automated by CLAWS —*";

/**
 * Check whether a comment body was posted by Claws.
 *
 * Lives here rather than in `github.ts` so a test can use the real predicate:
 * every consumer of it (`plan-parser.ts`, `phase-coverage.ts`, the refiner)
 * reaches it through `github.ts`, whose import graph those tests stub out — and
 * a hand-rolled copy that misses the `· <agent name> ·` form silently makes
 * every plan comment invisible to the code under test.
 */
export function isClawsComment(body: string): boolean {
  // Detect via visible header (new comments) or legacy HTML marker (old comments)
  return (
    /\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/.test(body) ||
    body.includes("<!-- claws-automated -->")
  );
}

/** Strip the Claws marker and visible header (with optional agent name) from a comment body. */
export function stripClawsMarker(body: string): string {
  return body
    .replace("<!-- claws-automated -->", "") // backward compat
    .replace(/\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/g, "")
    .replace(LEGACY_VISIBLE_HEADER, "")
    .trim();
}

// ── Plan comments ──

/**
 * Re-stamp markers onto an existing plan body (drops any prior marker block first).
 * Strips only the trailing block, iterating from the end — a global content-wide
 * strip would also delete marker-shaped text quoted in the plan's own prose.
 */
export function stripPlanMarkers(planBody: string): string {
  const trailingMarker = new RegExp(`\\n*(?:CLAWS_PLAN_OCCURRENCES:\\s*\\d+|CLAWS_PLAN_BODY_HASH:\\s*[0-9a-f]{64}|CLAWS_PLAN_LAST_COMMENT:\\s*${COMMENT_REF_PATTERN}|CLAWS_PLAN_STEP_BACK:\\s*reconsider)\\s*$`);
  let body = planBody;
  for (let stripped = body.replace(trailingMarker, ""); stripped !== body; stripped = body.replace(trailingMarker, "")) {
    body = stripped;
  }
  return body.trimEnd();
}

/**
 * True for a Claws plan comment: the `## Implementation Plan` header in a
 * comment Claws posted — the rule `findPlanComment` applies, so a human
 * comment quoting the header is not a plan.
 */
export function isPlanComment(body: string): boolean {
  return body.includes("## Implementation Plan") && isClawsComment(body);
}

/**
 * True for the requirements writer's `## Requirements` comment. The header is
 * spelled out rather than imported from `requirements-record.ts` so this module
 * stays a leaf of `issue-id.ts` alone, and matched as a whole line so a plan's
 * `### Requirements` heading is not mistaken for it.
 */
export function isRequirementsComment(body: string): boolean {
  return /^## Requirements[ \t]*$/m.test(body) && isClawsComment(body);
}

/**
 * A plan comment's text as a plan version stores it: without the Claws header
 * and the trailing `CLAWS_PLAN_*` marker block, so a marker-only re-stamp
 * normalises to the same text as the plan it re-stamps.
 */
export function normalizePlanText(body: string): string {
  return stripPlanMarkers(stripClawsMarker(body)).trim();
}
