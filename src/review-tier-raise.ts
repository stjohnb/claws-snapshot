/**
 * Raising a planner-suggested lower-tier review to `opus` from the PR's own
 * diff (docs/model-selection.md, "Raising a suggested review"). Pure: the
 * reviewer reads `git diff --numstat --no-renames` and passes it in.
 */
import { filterIgnoredPaths } from "./overlap.js";

/** Lockfiles and other generated files whose lines never count. */
const EXCLUDED_BASENAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "flake.lock",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "go.sum",
  "Podfile.lock",
  "Package.resolved",
]);
const EXCLUDED_SUFFIXES: readonly string[] = [".min.js", ".min.css", ".map", ".snap"];
const EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set(["dist", "build", "vendor", "node_modules", "__snapshots__"]);

const DOC_EXTENSIONS: readonly string[] = [".md", ".mdx", ".txt", ".rst"];
const CONFIG_EXTENSIONS: readonly string[] = [".json", ".yaml", ".yml", ".toml", ".ini", ".env", ".properties", ".conf", ".cfg", ".tfvars"];
/** A config file outside these trees can be a config-value-only edit; CI workflows are code. */
const CONFIG_EXCLUDED_ROOTS: readonly string[] = [".forgejo/", ".github/"];
/** Most added lines a config-value-only file may carry. */
const MAX_CONFIG_VALUE_LINES = 10;

export interface NumstatRow {
  path: string;
  /** Null for a binary file (numstat prints `-`). */
  added: number | null;
  deleted: number | null;
}

export type ReviewRaiseKind = "lines" | "code" | "unmeasured";

export type ReviewRaiseDecision =
  | { raise: false; lines: number }
  | { raise: true; reason: string; kind: ReviewRaiseKind; lines: number | null };

/** Parse `git diff --numstat --no-renames` output. */
export function parseNumstat(numstat: string): NumstatRow[] {
  const rows: NumstatRow[] = [];
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [a, d, ...rest] = parts;
    const toCount = (v: string | undefined): number | null => (v === undefined || v === "-" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    rows.push({ path: rest.join("\t"), added: toCount(a), deleted: toCount(d) });
  }
  return rows;
}

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const lowerExt = (p: string): string => {
  const b = basename(p);
  const dot = b.lastIndexOf(".");
  return dot <= 0 ? (b.startsWith(".") ? b.toLowerCase() : "") : b.slice(dot).toLowerCase();
};

/** True for a lockfile, generated file or vendored path whose lines never count. */
export function isExcludedPath(p: string): boolean {
  if (EXCLUDED_BASENAMES.has(basename(p))) return true;
  const lower = p.toLowerCase();
  if (EXCLUDED_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  return p.split("/").slice(0, -1).some((seg) => EXCLUDED_SEGMENTS.has(seg));
}

/** True for a documentation file: a docs extension, or anything under `docs/`. */
export function isDocsPath(p: string): boolean {
  return p.startsWith("docs/") || DOC_EXTENSIONS.includes(lowerExt(p));
}

/** True for a config-value-only edit: a config file outside CI trees, equal added/deleted lines, at most 10 added. */
export function isConfigValueEdit(row: NumstatRow): boolean {
  if (row.added === null || row.deleted === null) return false;
  if (CONFIG_EXCLUDED_ROOTS.some((r) => row.path.startsWith(r))) return false;
  if (!CONFIG_EXTENSIONS.includes(lowerExt(row.path))) return false;
  return row.added === row.deleted && row.added <= MAX_CONFIG_VALUE_LINES;
}

/** Strip the `*` and newlines that would break the `*Models used: …*` note. */
function sanitizeReason(reason: string): string {
  return reason.replace(/[*\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Decide whether a planner-suggested `sonnet`/`haiku` review raises to `opus`.
 * `numstat` null means the diff could not be read, which raises. A threshold
 * of `0` (or less) never raises. Otherwise counted lines (added plus deleted,
 * excluding binary, lockfile, generated and `ignorePaths` files) over the
 * threshold raise; else any changed file that is neither docs nor a
 * config-value-only edit raises.
 */
export function decideReviewRaise(opts: { numstat: string | null; threshold: number; ignorePaths?: readonly string[] }): ReviewRaiseDecision {
  const { numstat, threshold, ignorePaths = [] } = opts;
  if (threshold <= 0) return { raise: false, lines: 0 };
  if (numstat === null) return { raise: true, reason: "diff could not be measured", kind: "unmeasured", lines: null };
  const all = parseNumstat(numstat).filter((r) => r.added !== null && r.deleted !== null && !isExcludedPath(r.path));
  const kept = new Set(filterIgnoredPaths(all.map((r) => r.path), ignorePaths));
  const rows = all.filter((r) => kept.has(r.path));
  const lines = rows.reduce((sum, r) => sum + (r.added ?? 0) + (r.deleted ?? 0), 0);
  if (lines > threshold) return { raise: true, reason: sanitizeReason(`${lines} lines changed`), kind: "lines", lines };
  const code = rows.filter((r) => !isDocsPath(r.path) && !isConfigValueEdit(r)).map((r) => r.path);
  if (code.length > 0) {
    const more = code.length - 1;
    const which = more > 0 ? `${code[0]} and ${more} more file${more === 1 ? "" : "s"}` : code[0]!;
    return { raise: true, reason: sanitizeReason(`changes code (${which})`), kind: "code", lines };
  }
  return { raise: false, lines };
}
