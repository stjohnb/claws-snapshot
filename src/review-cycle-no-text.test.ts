/**
 * Guard: the PR review cycle decides from Claws' own `pr_reviews` records,
 * never by reading review-comment text (#clw_01M70EZTG10SVAGXHVFRBEHTD3). A
 * finding that merely quotes `review-result: clean` or a `<details>` tag once
 * changed what the cycle did; this test fails if a text read like that comes back.
 *
 * It scans the review-cycle sources for a `.includes` / `.test` / `.match` /
 * `.exec` call that uses a review marker — directly, or through a constant whose
 * value holds one. Writing a marker into a comment template is fine; reading one
 * back is not.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.dirname(new URL(import.meta.url).pathname);

/** The review markers, the archive tag and the addresser marker constant. */
const FORBIDDEN_TERMS = [
  "review-result",
  "review-addressed",
  "review-rebutted",
  "advisory-addressed",
  "Reviewed commit",
  "review-iteration",
  "<details",
  "ADDRESSER_COMMENT_MARKER",
];

/** A string/regex read: `x.includes(…)`, `re.test(…)`, `s.match(…)`, `s.matchAll(…)`, `re.exec(…)`. */
const READ_CALL = /\.(includes|test|match|matchAll|exec)\(/g;

interface ScanTarget {
  file: string;
  /** Scan only these top-level declarations; omitted = the whole file. */
  only?: string[];
  /** Top-level declarations skipped by name, each with the reason it is not a review-state read. */
  skip?: Record<string, string>;
}

const TARGETS: ScanTarget[] = [
  { file: "review-state.ts" },
  {
    file: "agents/pr-reviewer.ts",
    skip: {
      // Classifies the reviewer model's own raw output before it becomes a round;
      // no posted comment is read.
      isDeferredToCiReview: "model-output classifier",
    },
  },
  {
    file: "agents/review-addresser.ts",
    skip: {
      // Finds the addresser's own rolling comment so it is edited in place — a
      // comment writer; the round's state is on its `pr_reviews` row.
      postOrEditAddresserComment: "comment writer",
    },
  },
  { file: "agents/auto-merger.ts" },
  // Only the review functions: human-feedback collection (`getPRReviewNotes`,
  // human comment parsing) is out of scope.
  { file: "forgejo.ts", only: ["getPRReviewStatus", "getPRReviewComments"] },
];

/** A top-level declaration and the source lines it spans. */
interface Decl {
  name: string;
  startLine: number;
  lines: string[];
}

const DECL_START = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var)\s+(\w+)|class\s+(\w+))/;

/**
 * Split a module into its top-level declarations. Every declaration in these
 * files begins at column 0 and its body is indented, so a column-0 declaration
 * keyword starts the next one. Lines before the first declaration (imports)
 * form an unnamed `<module>` segment.
 */
function splitDeclarations(source: string): Decl[] {
  const decls: Decl[] = [{ name: "<module>", startLine: 1, lines: [] }];
  source.split("\n").forEach((line, i) => {
    const m = DECL_START.exec(line);
    if (m) decls.push({ name: m[1] ?? m[2] ?? m[3], startLine: i + 1, lines: [] });
    decls[decls.length - 1].lines.push(line);
  });
  return decls;
}

/** A line that is only a comment — JSDoc or `//` — whose prose may quote markers freely. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** Constants whose initializer holds a forbidden term, e.g. `const P = /review-result: clean/`. */
function markerConstants(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/^\s*(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(.+)$/gm)) {
    if (FORBIDDEN_TERMS.some((t) => m[2].includes(t))) names.push(m[1]);
  }
  return names;
}

interface Violation {
  file: string;
  line: number;
  decl: string;
  text: string;
}

/**
 * Every marker read in `source`: a read call whose line (receiver, method and
 * arguments) names a forbidden term or a constant holding one.
 */
function findMarkerReads(file: string, source: string, target: Omit<ScanTarget, "file"> = {}, extraTokens: string[] = []): Violation[] {
  const tokens = [...FORBIDDEN_TERMS, ...markerConstants(source), ...extraTokens];
  const out: Violation[] = [];
  for (const decl of splitDeclarations(source)) {
    if (target.only && !target.only.includes(decl.name)) continue;
    if (target.skip && decl.name in target.skip) continue;
    decl.lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      READ_CALL.lastIndex = 0;
      if (!READ_CALL.test(line)) return;
      if (tokens.some((t) => line.includes(t))) {
        out.push({ file, line: decl.startLine + i, decl: decl.name, text: line.trim() });
      }
    });
  }
  return out;
}

/** Marker constants exported from the shared modules the review cycle imports (`gh.X`). */
function sharedMarkerConstants(): string[] {
  return ["github.ts", "marker-text.ts"].flatMap((f) => {
    const p = path.join(SRC, f);
    return fs.existsSync(p) ? markerConstants(fs.readFileSync(p, "utf8")) : [];
  });
}

describe("review cycle reads no review-comment text", () => {
  const shared = sharedMarkerConstants();

  it.each(TARGETS.map((t) => [t.file, t] as const))("%s makes no marker read", (_file, target) => {
    const source = fs.readFileSync(path.join(SRC, target.file), "utf8");
    if (target.only) {
      const names = splitDeclarations(source).map((d) => d.name);
      for (const fn of target.only) expect(names, `${target.file} no longer declares ${fn}`).toContain(fn);
    }
    expect(findMarkerReads(target.file, source, target, shared)).toEqual([]);
  });

  describe("the scanner itself", () => {
    it("catches a direct marker read", () => {
      const src = [
        "export async function gate(body: string): Promise<boolean> {",
        '  return body.includes("review-result: clean");',
        "}",
      ].join("\n");
      expect(findMarkerReads("x.ts", src)).toEqual([
        { file: "x.ts", line: 2, decl: "gate", text: 'return body.includes("review-result: clean");' },
      ]);
    });

    it("catches a read through a constant holding a marker, and through a shared one", () => {
      const src = [
        "const CLEAN = /review-result: clean/;",
        "function a(body: string) {",
        "  return CLEAN.test(body);",
        "}",
        "function b(body: string) {",
        "  return body.includes(gh.ADVISORY_ADDRESSED_MARKER);",
        "}",
      ].join("\n");
      expect(findMarkerReads("x.ts", src, {}, ["ADVISORY_ADDRESSED_MARKER"]).map((v) => v.decl)).toEqual(["a", "b"]);
    });

    it("allows writing markers into templates, prose in comments, and named exclusions", () => {
      const src = [
        "// body.includes(\"review-result: clean\") was the old bug",
        "function write(sha: string) {",
        "  return `review-addressed: ${sha}\\n<details><summary>x</summary></details>`;",
        "}",
        "function finder(body: string) {",
        "  return body.includes(gh.ADDRESSER_COMMENT_MARKER);",
        "}",
        "function other(body: string) {",
        '  return body.includes("## PR Review");',
        "}",
      ].join("\n");
      expect(findMarkerReads("x.ts", src, { skip: { finder: "writer" } })).toEqual([]);
    });

    it("scans only the named declarations when `only` is given", () => {
      const src = [
        "export function humanFeedback(body: string) {",
        '  return body.includes("<details>");',
        "}",
        "export function reviewStatus(body: string) {",
        '  return body.includes("<details>");',
        "}",
      ].join("\n");
      expect(findMarkerReads("x.ts", src, { only: ["reviewStatus"] }).map((v) => v.decl)).toEqual(["reviewStatus"]);
    });
  });
});
