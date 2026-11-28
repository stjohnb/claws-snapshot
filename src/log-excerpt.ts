/** Elision marker inserted where the middle of a log was dropped. */
export const LOG_ELISION_MARKER = "… [Claws elided N characters of log] …";

// CSI sequences (e.g. `\x1b[33m` SGR colour codes) and OSC sequences (e.g. hyperlinks).
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Strips ANSI escape sequences (colour codes, hyperlinks) from log text so pattern
 *  matching sees the same text a human would in a terminal. `gh api .../logs` refuses to
 *  print a body containing raw escape sequences without `--allow-escape-sequences`, and
 *  Docker/buildx build output is colourised, so callers must pass that flag and then strip
 *  here before slicing or pattern-matching. Leaves `\r` and other control characters alone. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI_RE, "").replace(ANSI_OSC_RE, "");
}

export function excerptLog(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars < 10) return text.slice(-maxChars);

  const headLen = Math.floor(maxChars * 0.2);
  const head = text.slice(0, headLen);
  const droppedCount = text.length - maxChars;
  const marker = LOG_ELISION_MARKER.replace("N", String(droppedCount));
  const tailStart = text.length - (maxChars - headLen);
  const tail = text.slice(tailStart);

  return `${head}\n\n${marker}\n\n${tail}`;
}

/** Longest key line {@link extractFailureKeyLines} keeps; a longer one is cut. */
export const FAILURE_KEY_LINE_MAX_CHARS = 300;

/**
 * Tokens that mark a failure line in common test-runner and build output
 * (vitest/jest, cargo, go test, pytest, TAP, tsc, GitHub-style annotations).
 * A token with an upper-case letter matches case-sensitively, so `FAIL` does not
 * match "fail" in prose; an all-lower-case one matches any case.
 */
const FAILURE_KEY_TOKENS = [
  "FAIL", "FAILED", "--- FAIL:", "not ok", "✗", "×", "✘", "●",
  "Error:", "error:", "error[", "error TS", "AssertionError", "panicked at",
  "##[error]", "::error", "exit code", "exited with",
];

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FAILURE_KEY_CASE_SENSITIVE_RE = new RegExp(
  FAILURE_KEY_TOKENS.filter((t) => t !== t.toLowerCase()).map(escapeRegExp).join("|"),
);
const FAILURE_KEY_CASE_INSENSITIVE_RE = new RegExp(
  FAILURE_KEY_TOKENS.filter((t) => t === t.toLowerCase()).map(escapeRegExp).join("|"),
  "i",
);

/** Whether `line` is one of the `=== job` / `--- step` headers the job-log readers print. */
function isLogHeader(line: string): "job" | "step" | null {
  if (line.startsWith("=== job ")) return "job";
  if (line.startsWith("--- step ")) return "step";
  return null;
}

/**
 * The failure lines of a CI log — failing test names, assertion and compiler
 * errors, exit codes — in order and de-duplicated, under the `=== job` /
 * `--- step` headers they appeared beneath (a header with no failure line under
 * it is dropped). Each line is cut to {@link FAILURE_KEY_LINE_MAX_CHARS}. Over
 * `maxChars` it keeps the first 40% and last 60% of the lines with a count
 * marker between. Pure; "" when no line matches.
 */
export function extractFailureKeyLines(text: string, maxChars: number): string {
  const kept: Array<{ line: string; kind: "job" | "step" | "match" }> = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n|\r/)) {
    const trimmed = raw.trimEnd();
    if (!trimmed.trim()) continue;
    const header = isLogHeader(trimmed);
    if (!header && !FAILURE_KEY_CASE_SENSITIVE_RE.test(trimmed) && !FAILURE_KEY_CASE_INSENSITIVE_RE.test(trimmed)) continue;
    const line = trimmed.length > FAILURE_KEY_LINE_MAX_CHARS ? `${trimmed.slice(0, FAILURE_KEY_LINE_MAX_CHARS - 1)}…` : trimmed;
    if (header) {
      // A header with nothing under it is replaced by the next one of its rank or above.
      while (kept.length > 0 && kept[kept.length - 1].kind !== "match" && (header === "job" || kept[kept.length - 1].kind === "step")) kept.pop();
      kept.push({ line, kind: header });
      continue;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    kept.push({ line, kind: "match" });
  }
  while (kept.length > 0 && kept[kept.length - 1].kind !== "match") kept.pop();
  if (kept.length === 0) return "";

  const lines = kept.map((k) => k.line);
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;

  // Reserve room for the marker, then fill 40% of the rest from the top and 60% from the bottom.
  const markerFor = (n: number) => `… [Claws elided ${n} key lines] …`;
  const budget = Math.max(0, maxChars - markerFor(lines.length).length - 2);
  const head: string[] = [];
  let headLen = 0;
  for (const line of lines) {
    if (headLen + line.length + 1 > budget * 0.4) break;
    head.push(line);
    headLen += line.length + 1;
  }
  const tail: string[] = [];
  let tailLen = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (headLen + tailLen + lines[i].length + 1 > budget) break;
    tail.unshift(lines[i]);
    tailLen += lines[i].length + 1;
  }
  const elided = lines.length - head.length - tail.length;
  return [...head, markerFor(elided), ...tail].join("\n");
}
