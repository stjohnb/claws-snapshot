/**
 * Canonical structured-logging contract every St-John-Software service follows:
 * one JSON object per line on stdout, queryable in Loki with `| json`. This
 * module is the single source of truth for the documentation form
 * (`LOGGING_CONTRACT_MARKDOWN`, embedded verbatim in `docs/logging-conventions.md`
 * and in the `logging-conventions-scanner` issue body), the prompt-injected form
 * (`LOGGING_CONTEXT`) and the compliance rules the scanner checks. Zero-dependency
 * leaf module — do not import anything here.
 */

export const LOGGING_CONTRACT_HEADING = "## Logging";

export const LOGGING_CONTRACT_MARKDOWN = `${LOGGING_CONTRACT_HEADING}

This service follows the St-John-Software structured logging contract: one JSON object per
line on stdout, never to files. Loki parses it at query time with \`| json\`.

| Field | Rule |
|---|---|
| \`time\` | ISO 8601 UTC with milliseconds |
| \`level\` | lowercase **string**, one of \`trace debug info warn error fatal\`. Never numeric (pino's default numeric levels are not detected by Loki) |
| \`msg\` | short, constant message. Ids and values go in fields, never interpolated into the message |
| \`service\` | service name, matching the Kubernetes \`app\` label |
| \`component\` | subsystem or job name (e.g. \`ha-backup-monitor\`) |
| \`err\` | object \`{ type, message, stack }\` for errors. Never a bare string |
| correlation keys | \`request_id\`, \`run_id\`, \`repo\`, \`issue\`, \`pr\` when known |
| HTTP access lines | \`http.method\`, \`http.path\`, \`http.status\`, \`duration_ms\` |

- Keys are \`snake_case\`; durations end in \`_ms\`.
- No secrets, tokens or credentials in any field or message.
- Pretty-print only when stdout is a TTY (e.g. \`pino-pretty\` in dev). In containers always emit JSON.
- Shell scripts and CronJobs may use logfmt (\`level=info msg="..."\`) since JSON is awkward in
  shell. Loki parses both.
- Keep Loki labels low-cardinality: nothing in this contract becomes a Loki label; fields are
  parsed at query time with \`| json\` / \`| logfmt\`.
- Do not add direct \`console.*\` calls to service code; log through the shared logger module.

Reference Node implementation (pino):

\`\`\`ts
import pino from "pino";

export const logger = pino({
  base: { service: "my-service", component: "api" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  serializers: { err: pino.stdSerializers.err },
});
\`\`\`

The \`formatters.level\` line is required: without it pino emits numeric levels (\`"level":30\`),
which Loki does not detect.`;

/**
 * Prompt block for implementing agents, used only when the target repo does not
 * document logging itself. Prefer `loggingContext(wtPath)` in `agent-context.ts`.
 */
export const LOGGING_CONTEXT = `<logging>
Only if this task writes log output in service code: emit one JSON object per line to stdout with a lowercase string \`level\` (trace/debug/info/warn/error/fatal), \`time\`, a short constant \`msg\`, and \`service\`/\`component\` fields. Put ids and values in snake_case fields, never interpolated into \`msg\`; log errors as an \`err\` object \`{ type, message, stack }\`; never log secrets, tokens or credentials. Never add a new bare \`console.log\` to service code — use the repo's shared logger (pino with \`formatters.level: (label) => ({ level: label })\`).
</logging>`;

export interface LoggingRule {
  id: string;
  label: string;
  detect: RegExp;
}

export const LOGGING_RULES: readonly LoggingRule[] = [
  {
    id: "json-stdout",
    label: "One JSON object per line on stdout",
    detect: /\bjson\b|\bstdout\b/i,
  },
  {
    id: "string-level",
    label: "Lowercase string `level` field",
    detect: /lowercase|\blevel\b/i,
  },
  {
    id: "error-object",
    label: "Errors logged as an `err` object with a stack",
    detect: /\berr\b|stack/i,
  },
  {
    id: "no-secrets",
    label: "No secrets, tokens or credentials in log output",
    detect: /secret|token|credential/i,
  },
];

// Level >= 2 only: a level-1 heading is a document's title, and a typical
// Markdown doc has exactly one, so it never has a closing "same-or-higher"
// heading to bound it (see findLoggingSections) — treating it as a candidate
// section would swallow the entire rest of the file whenever the title
// happens to contain "logging" (e.g. a doc titled "# Logging").
const LOGGING_SECTION_HEADING = /^(#{2,6})[ \t]*.*\b(logging|log format|log output)\b.*$/i;
const ANY_HEADING = /^(#{1,6})[ \t]/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** Logging docs, in priority order, checked by both the scanner and `loggingContext`. */
export const LOGGING_DOC_PATHS: readonly string[] = ["AGENTS.md", "docs/logging.md"];

/** Per-line flag: true when the line is inside (or delimits) a fenced code block. */
function fencedLines(lines: readonly string[]): boolean[] {
  const fenced: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const match = line.match(FENCE);
    if (open === null) {
      if (match) {
        open = match[1];
        fenced.push(true);
      } else {
        fenced.push(false);
      }
    } else {
      fenced.push(true);
      if (match && match[1][0] === open[0] && match[1].length >= open.length && line.trim() === match[1]) {
        open = null;
      }
    }
  }
  return fenced;
}

/** Every logging section in the document, in order; headings inside fenced code are ignored. */
function findLoggingSections(text: string): string[] {
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  const sections: string[] = [];

  for (let start = 0; start < lines.length; start++) {
    if (fenced[start]) continue;
    const match = lines[start].match(LOGGING_SECTION_HEADING);
    if (!match) continue;
    const level = match[1].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (fenced[i]) continue;
      const headingMatch = lines[i].match(ANY_HEADING);
      if (headingMatch && headingMatch[1].length <= level) {
        end = i;
        break;
      }
    }
    sections.push(lines.slice(start, end).join("\n"));
  }
  return sections;
}

function rulesMissingFrom(section: string): readonly LoggingRule[] {
  return LOGGING_RULES.filter((r) => !r.detect.test(section));
}

/**
 * Extracts the logging section from an `AGENTS.md`-shaped document: from a
 * matching heading up to (exclusive) the next same-or-higher-level heading, or
 * end of file. Headings inside fenced code blocks are ignored, and when several
 * headings match (e.g. an earlier "Debugging and logging tips" before the real
 * `## Logging` block) the section covering the most contract rules wins, first
 * on ties. Returns null when no heading matches, so callers never test rule
 * regexes against the whole file (a repo can mention "json" or "token" in an
 * unrelated paragraph and still document no logging contract).
 */
export function findLoggingSection(text: string): string | null {
  let best: { section: string; missing: number } | null = null;
  for (const section of findLoggingSections(text)) {
    const missing = rulesMissingFrom(section).length;
    if (best === null || missing < best.missing) best = { section, missing };
  }
  return best?.section ?? null;
}

/**
 * Rules from LOGGING_RULES not covered by the document's logging section. A
 * document containing `LOGGING_CONTRACT_MARKDOWN` verbatim is compliant outright;
 * the heading scan is the fallback for repos that wrote their own section.
 */
export function missingLoggingRules(text: string): readonly LoggingRule[] {
  if (text.includes(LOGGING_CONTRACT_MARKDOWN)) return [];
  const section = findLoggingSection(text);
  if (!section) return LOGGING_RULES;
  return rulesMissingFrom(section);
}
