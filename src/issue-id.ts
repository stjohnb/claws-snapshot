/**
 * Identifiers for Claws-native issues and their comments (#3215).
 *
 * A leaf module by design — it imports `node:crypto` and nothing else — so
 * `config.ts`, `db.ts`, `github.ts` and every page can depend on it without a
 * cycle.
 *
 * Ids are monotonic ULIDs in Crockford base32 with a prefix: `clw_<26 chars>`
 * for an issue, `clwc_<26 chars>` for a comment. Two properties matter:
 *
 * - **Collision-free without a round trip.** A `MAX(number) + 1` allocation is
 *   unsafe on Postgres under READ COMMITTED without an explicit lock; minting
 *   the id in-process removes the read-then-write race entirely.
 * - **Sortable.** The 48-bit timestamp leads, and same-millisecond calls
 *   *increment* the random component rather than redrawing it, so ids minted by
 *   one process are strictly increasing. `ORDER BY id` is therefore exact
 *   creation order for comments (Claws runs a single pod; across restarts the
 *   order holds to clock accuracy).
 *
 * Refs are **case-insensitive on read, canonical on write**: a human typing
 * `#clw_01jbq…` in an issue body must resolve, but everything Claws generates
 * or stores is `clw_` + an uppercase body. Canonicalise at the entry point,
 * never mid-pipeline.
 */

import crypto from "node:crypto";

/** An issue reference: a forge issue number, or a Claws-native `clw_…` id. */
export type IssueRef = number | string;

/** A comment reference: a forge comment id, or a Claws-native `clwc_…` id. */
export type CommentRef = number | string;

/** Crockford base32 — no I, L, O or U, so a transcribed id cannot be ambiguous. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const ULID_LENGTH = 26;
const RANDOM_BYTES = 10;

/** The `clw_`/`clwc_` body, in either case. Kept in sync with {@link CROCKFORD}. */
const ULID_BODY = "[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}";

/**
 * An issue reference as it appears in prose: `1234` or `clw_01JBQ…`.
 *
 * Written out case-by-case rather than relying on an `i` flag, because callers
 * splice this into patterns that are compiled both ways (`closesIssue` is
 * case-insensitive; `extractRelatedNumbers` is not).
 */
export const ISSUE_REF_PATTERN = `(?:\\d+|[cC][lL][wW]_${ULID_BODY})`;

/** {@link ISSUE_REF_PATTERN} for comment ids — `4711` or `clwc_01JBQ…`. */
export const COMMENT_REF_PATTERN = `(?:\\d+|[cC][lL][wW][cC]_${ULID_BODY})`;

/**
 * What must NOT follow a native ref for it to be complete.
 *
 * The numeric half of {@link ISSUE_REF_PATTERN} uses `(?!\\d)`; a ULID ref
 * needs the wider alphanumeric guard, or `clw_<26>X` would match its first 26
 * characters and resolve to a different issue.
 */
export const ISSUE_REF_BOUNDARY = "(?![0-9A-Za-z])";

/**
 * {@link ISSUE_REF_PATTERN} with each alternative's own boundary guard baked
 * in: `(?!\d)` after a number, {@link ISSUE_REF_BOUNDARY} after a ULID.
 *
 * Prefer this over splicing one guard after the whole alternation. Doing that
 * widens the numeric half too, so `Closes #123abc` resolves to nothing where
 * it used to resolve to `123` — and the several places that match a ref in
 * prose then disagree with each other about the same body. The guards are
 * lookaheads, so a capture group wrapped around this still captures the ref
 * alone.
 */
export const ISSUE_REF_GUARDED = `(?:\\d+(?!\\d)|[cC][lL][wW]_${ULID_BODY}${ISSUE_REF_BOUNDARY})`;

// ── Generation ──

let lastTime = 0;
let lastRandom = new Uint8Array(RANDOM_BYTES);

function encodeCrockford(value: bigint, length: number): string {
  let out = "";
  let v = value;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return out;
}

/** Increment `lastRandom` as one big-endian integer, throwing on carry-out. */
function incrementRandom(): void {
  for (let i = lastRandom.length - 1; i >= 0; i--) {
    if (lastRandom[i] !== 0xff) {
      lastRandom[i]!++;
      return;
    }
    lastRandom[i] = 0;
  }
  // 2^80 ids inside one millisecond is not a thing that happens; if it somehow
  // did, wrapping would hand out a duplicate id, so fail loudly instead.
  throw new Error("issue-id: random component overflow");
}

/**
 * A monotonic ULID: 48-bit timestamp, 80-bit random, 26 Crockford characters.
 *
 * A `now` at or *before* the last one keeps the previous timestamp and bumps
 * the random component, so a clock that steps backwards cannot produce an id
 * that sorts before one already issued.
 */
export function newUlid(now: number = Date.now()): string {
  if (now > lastTime) {
    lastTime = now;
    lastRandom = new Uint8Array(crypto.randomBytes(RANDOM_BYTES));
  } else {
    incrementRandom();
  }
  let random = 0n;
  for (const byte of lastRandom) random = (random << 8n) | BigInt(byte);
  return encodeCrockford((BigInt(lastTime) << 80n) | random, ULID_LENGTH);
}

/** A fresh Claws-native issue id. */
export function newClawsIssueId(): string {
  return `clw_${newUlid()}`;
}

/** A fresh Claws-native issue-comment id. */
export function newClawsCommentId(): string {
  return `clwc_${newUlid()}`;
}

/** A fresh Claws-native issue-attachment id (#3289). */
export function newClawsAttachmentId(): string {
  return `cla_${newUlid()}`;
}

/** A new issue-link id: `cll_` plus a ULID (docs/issue-tracker.md#links). */
export function newClawsLinkId(): string {
  return `cll_${newUlid()}`;
}

// ── Predicates and canonicalisation ──

const ISSUE_ID_RE = new RegExp(`^[cC][lL][wW]_${ULID_BODY}$`);
const COMMENT_ID_RE = new RegExp(`^[cC][lL][wW][cC]_${ULID_BODY}$`);

/** True when `ref` is a Claws-native issue id, in any case. */
export function isClawsIssueId(ref: IssueRef | null | undefined): ref is string {
  return typeof ref === "string" && ISSUE_ID_RE.test(ref);
}

/** True when `ref` is a Claws-native comment id, in any case. */
export function isClawsCommentId(ref: CommentRef | null | undefined): ref is string {
  return typeof ref === "string" && COMMENT_ID_RE.test(ref);
}

/**
 * The canonical form of an issue reference, or null when it is not one.
 *
 * Numbers pass through; a digit-only string becomes a number (Postgres hands
 * back TEXT columns as strings, and `123 !== "123"` would break every forge
 * comparison); a native id becomes a lowercase `clw_` prefix with an uppercase
 * body.
 */
export function canonicalIssueRef(ref: IssueRef | null | undefined): IssueRef | null {
  if (typeof ref === "number") return Number.isFinite(ref) ? ref : null;
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (ISSUE_ID_RE.test(trimmed)) return `clw_${trimmed.slice(4).toUpperCase()}`;
  return null;
}

/** {@link canonicalIssueRef} for comment ids. */
export function canonicalCommentRef(ref: CommentRef | null | undefined): CommentRef | null {
  if (typeof ref === "number") return Number.isFinite(ref) ? ref : null;
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (COMMENT_ID_RE.test(trimmed)) return `clwc_${trimmed.slice(5).toUpperCase()}`;
  return null;
}

/**
 * Parse an issue reference out of user-supplied text — a form field, an MCP
 * argument, a URL segment — tolerating a leading `#` and surrounding space.
 */
export function parseIssueRef(text: string | null | undefined): IssueRef | null {
  if (typeof text !== "string") return null;
  return canonicalIssueRef(text.trim().replace(/^#/, ""));
}

/** True when two references name the same issue, whatever case they were written in. */
export function sameIssueRef(a: IssueRef | null | undefined, b: IssueRef | null | undefined): boolean {
  const left = canonicalIssueRef(a);
  const right = canonicalIssueRef(b);
  return left !== null && right !== null && left === right;
}

/**
 * Normalise an issue-reference column read back out of the database.
 *
 * The widened `item_number` / `issue_number` columns are TEXT so they can hold
 * a Claws-native `clw_…` id, and Postgres hands TEXT back as a string — so a
 * forge issue stored as 123 would read back as `"123"` and every `=== 123`
 * comparison in the pipeline would silently stop matching. Digit-only values
 * become numbers again; a native id stays the string it is.
 *
 * Lives here, not in `db.ts`: the MCP child process (`mcp-server.ts`) opens
 * its own driver and must apply exactly the same rule, and `db.ts` is far too
 * heavy for it to import.
 */
export function refFromColumn(v: unknown): IssueRef {
  if (typeof v === "number") return v;
  const s = String(v ?? "");
  return /^\d+$/.test(s) ? Number(s) : s;
}

/**
 * {@link refFromColumn} applied to the `item_number` of every row, in place.
 *
 * Deliberately narrowed to `item_number`, the only widened column anything
 * selects back out: `tasks.item_number` and `work_queue.item_number` are both
 * NOT NULL, so `refFromColumn` never sees a nullish value here. Two of the
 * other four widened columns *are* nullable — widen this helper only together
 * with a null-preserving `refFromColumn`, or a `NULL` would read back as the
 * ref `""`, which `hasItemRef` then reports as "no item" rather than "no
 * value".
 */
export function normalizeItemNumbers<T extends object>(rows: T[]): T[] {
  for (const row of rows) {
    if ("item_number" in row) {
      (row as Record<string, unknown>).item_number = refFromColumn((row as Record<string, unknown>).item_number);
    }
  }
  return rows;
}

/**
 * Sort comparator for issue references: forge numbers ascending first, then
 * native ids in creation order (which is their lexical order, by construction).
 */
export function compareIssueRefs(a: IssueRef, b: IssueRef): number {
  const aNum = typeof a === "number";
  const bNum = typeof b === "number";
  if (aNum && bNum) return (a as number) - (b as number);
  if (aNum) return -1;
  if (bNum) return 1;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * True when `ref` names an actual issue or PR.
 *
 * Repo-level work (the doc maintainer, the improvement identifier) is recorded
 * against the numeric sentinel `0`, which every "is there an item to link to?"
 * check used to spell `ref > 0`. A native id is always a real item.
 */
export function hasItemRef(ref: IssueRef): boolean {
  return typeof ref === "number" ? ref > 0 : ref.length > 0;
}

/**
 * The number of trailing body characters kept by {@link shortIssueRef}.
 *
 * The head of a native id is a 48-bit timestamp shared by every id minted in
 * the same period, so it never distinguishes two ids rendered next to each
 * other; the tail is the random component, which does.
 */
export const SHORT_ISSUE_ID_TAIL = 6;

/**
 * A short display form of an issue reference, for **visible text only**.
 *
 * A native id becomes `clw_` + its last {@link SHORT_ISSUE_ID_TAIL} body
 * characters, uppercased; a forge issue number (or anything else) passes
 * through unchanged as a string. Never use this for a link target, a form
 * value, a `data-*`/`id` attribute or a search query — only the full id is
 * safe to read back.
 */
export function shortIssueRef(ref: IssueRef | null | undefined): string {
  const canonical = canonicalIssueRef(ref);
  if (isClawsIssueId(canonical)) {
    return `clw_${canonical.slice(-SHORT_ISSUE_ID_TAIL)}`;
  }
  return String(ref ?? "");
}

/** Test-only: reset the generator so `now`-pinned tests start from a known state. */
export function resetIssueIdGeneratorForTest(): void {
  lastTime = 0;
  lastRandom = new Uint8Array(RANDOM_BYTES);
}
