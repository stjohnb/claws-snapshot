/**
 * Canonical observability contract every St-John-Software repo declares: logs
 * (one JSON object per line on stdout, queryable in Loki with `| json`),
 * metrics, traces, latency budgets, where dashboards and alerts live, and what
 * each new route, DB query, background job or external call must add. This
 * module is the single source of truth for the documentation forms
 * (`OBSERVABILITY_CONTRACT_MARKDOWN` and the `LOGGING_CONTRACT_MARKDOWN` it
 * embeds, both verbatim in `docs/observability-contract.md` and the
 * `observability-contract-scanner` issue body), the prompt-injected form
 * (`OBSERVABILITY_CONTEXT`) and the compliance rules the scanner checks.
 * Zero-dependency leaf module — do not import anything here.
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
| \`component\` | subsystem or job name (e.g. \`reminder-monitor\`) |
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
 * `LOGGING_CONTRACT_MARKDOWN` without its `## Logging` heading: the block a
 * policy pastes under its own heading, and the text whose presence passes the
 * four logging rules.
 */
export const LOGGING_CONTRACT_BODY = LOGGING_CONTRACT_MARKDOWN.slice(`${LOGGING_CONTRACT_HEADING}\n\n`.length);

/** The line a repo with nothing to observe writes, on its own line, in place of the subsections. */
export const NO_TELEMETRY_SENTENCE = "This repo emits no runtime telemetry.";

/** Prefix of every fill-in line in `OBSERVABILITY_CONTRACT_MARKDOWN`; the `no-placeholders` rule fails while any remains. */
export const OBSERVABILITY_PLACEHOLDER = "TODO(observability):";

export const OBSERVABILITY_CONTRACT_HEADING = "## Observability";

/** Heading of the template section listing where existing code falls short; the `known-gaps` rule fails without one. */
export const KNOWN_GAPS_HEADING = "### Known gaps";

/** Prefix of a Known gaps list item the repo accepts, with its reason after the colon. */
export const ACCEPTED_GAP_PREFIX = "Accepted:";

/**
 * Starter template a repo pastes into `docs/observability.md` or `AGENTS.md`.
 * The logging block is `LOGGING_CONTRACT_BODY` under `### Logging`, behind a
 * placeholder line, so pasting it unchanged never passes `no-placeholders`: it
 * is a claim about what the code logs today, kept only when that is true.
 */
export const OBSERVABILITY_CONTRACT_MARKDOWN = `${OBSERVABILITY_CONTRACT_HEADING}

This is the repo's observability policy under the St-John-Software observability contract.
Replace each placeholder line below with this repo's answer, or with \`none\` and the reason.
Every statement below about current logging, metrics, traces, latency budgets and dashboards
must be true of this repo's code and config today; word a rule for future changes as a rule for
new changes, and list each place existing code falls short under Known gaps.
A repo with nothing to observe (a library, CLI or config-only repo) may instead replace the
subsections with one line reading exactly \`${NO_TELEMETRY_SENTENCE}\`

### Scope

${OBSERVABILITY_PLACEHOLDER} what runs and where (service, CronJob, static site, library, CLI), and which subsections below apply.

### Logging

${OBSERVABILITY_PLACEHOLDER} keep the block below only if this repo's code emits one JSON object per line on stdout today, and name the logger module; otherwise describe what it logs and list the shortfall under Known gaps.

${LOGGING_CONTRACT_BODY}

### Metrics

${OBSERVABILITY_PLACEHOLDER} the metrics endpoint or analytics tool, where its series are listed, and what scrapes it.

### Traces

${OBSERVABILITY_PLACEHOLDER} the tracing SDK and backend and the spans it records, or \`none\`.

### Latency budgets

${OBSERVABILITY_PLACEHOLDER} the p95 latency budget or SLO for each user-facing path, or the uptime target for a static site.

### Dashboards and alerts

${OBSERVABILITY_PLACEHOLDER} the repo and path where the dashboards and alert rules live, and which alerts notify someone.

### What every change adds

What a change must instrument when it adds:

- ${OBSERVABILITY_PLACEHOLDER} a new HTTP route: its access log line, request metric and latency budget.
- ${OBSERVABILITY_PLACEHOLDER} a new DB query: a log line or span with \`duration_ms\`.
- ${OBSERVABILITY_PLACEHOLDER} a new background job: start and finish log lines and a duration or failure metric.
- ${OBSERVABILITY_PLACEHOLDER} a new external call: a timed log line or span naming the target.

${KNOWN_GAPS_HEADING}

${OBSERVABILITY_PLACEHOLDER} list every place existing code falls short of the contract or of this policy's own per-change rules, one list item each, or write \`None.\`; start an accepted gap's item with \`${ACCEPTED_GAP_PREFIX} <reason>\`.`;

/**
 * The paragraph both `<observability>` prompt blocks carry: a policy's
 * current-behaviour claims are checked against the code, not taken on trust.
 */
export const POLICY_VERIFICATION_CONTEXT = `When this task declares, rewrites or reviews the repo's observability policy, verify every statement about current logging, metrics, traces, latency budgets, dashboards and alerts against this repo's code and config (the logger module, metrics endpoint, tracing SDK, and the dashboard and alert files in fleet-infra or production-infra read over the Forgejo API), and correct any claim the code does not support before merge. Word rules for future changes as rules for new changes, never as current behaviour. Keep a \`${KNOWN_GAPS_HEADING}\` section listing every place existing code falls short of the contract or of the policy's own per-change rules, one list item each, or \`None.\`; start an accepted gap's item with \`${ACCEPTED_GAP_PREFIX} <reason>\`. A review flags an unsupported claim and a missing Known gaps section.`;

/**
 * Fallback prompt block for planning, implementing and reviewing agents, used
 * only when the target repo declares no observability policy. Prefer
 * `observabilityContext(wtPath)` in `agent-context.ts`.
 */
export const OBSERVABILITY_CONTEXT = `<observability>
Only if this task writes log output in service code: emit one JSON object per line to stdout with a lowercase string \`level\` (trace/debug/info/warn/error/fatal), \`time\`, a short constant \`msg\`, and \`service\`/\`component\` fields. Put ids and values in snake_case fields, never interpolated into \`msg\`; log errors as an \`err\` object \`{ type, message, stack }\`; never log secrets, tokens or credentials. Never add a new bare \`console.log\` to service code — use the repo's shared logger (pino with \`formatters.level: (label) => ({ level: label })\`).
This repo has no observability policy, so treat a new HTTP route, DB query, background job or external call as needing a structured log line with \`duration_ms\` and ids, a metric where the repo has a metrics endpoint, and a stated latency budget in the PR; say in the PR that the repo has no observability policy.
${POLICY_VERIFICATION_CONTEXT}
</observability>`;

export interface LoggingRule {
  id: string;
  label: string;
  detect: RegExp;
}

export interface ObservabilityRule extends LoggingRule {
  /** `logging` rules are the original logging contract; `observability` rules are the sections it grew. */
  area: "logging" | "observability";
  /** When true the rule fails while `detect` matches, instead of while it does not. */
  failsWhenPresent?: boolean;
}

export const LOGGING_RULES: readonly ObservabilityRule[] = [
  {
    id: "json-stdout",
    label: "One JSON object per line on stdout",
    area: "logging",
    detect: /\bjson\b|\bstdout\b/i,
  },
  {
    id: "string-level",
    label: "Lowercase string `level` field",
    area: "logging",
    detect: /lowercase|\blevel\b/i,
  },
  {
    id: "error-object",
    label: "Errors logged as an `err` object with a stack",
    area: "logging",
    detect: /\berr\b|stack/i,
  },
  {
    id: "no-secrets",
    label: "No secrets, tokens or credentials in log output",
    area: "logging",
    detect: /secret|token|credential/i,
  },
];

export const OBSERVABILITY_RULES: readonly ObservabilityRule[] = [
  ...LOGGING_RULES,
  {
    id: "scope",
    label: "Scope: what runs where, and which sections apply",
    area: "observability",
    detect: /\bscope\b|deploy|\bruns? (as|on|in)\b/i,
  },
  {
    id: "metrics",
    label: "Metrics: endpoint or analytics, and what collects them",
    area: "observability",
    detect: /\bmetrics?\b|prometheus|analytics/i,
  },
  {
    id: "traces",
    label: "Traces: tracing SDK and backend, or none",
    area: "observability",
    detect: /\btrac(es|ing)\b|\bspans?\b|opentelemetry|otel/i,
  },
  {
    id: "latency-budgets",
    label: "Latency budgets, SLOs or uptime targets",
    area: "observability",
    detect: /latency|\bslos?\b|budget|uptime/i,
  },
  {
    id: "dashboards-alerts",
    label: "Where dashboards and alerts live",
    area: "observability",
    detect: /dashboard|alert|grafana/i,
  },
  {
    id: "per-change-instrumentation",
    label: "What a new route, DB query, background job or external call must add",
    area: "observability",
    detect: /instrument|new route|new quer|background job|external call/i,
  },
  {
    id: "known-gaps",
    label: "Known gaps: where existing code falls short of the contract, or None",
    area: "observability",
    detect: /known gaps/i,
  },
  {
    id: "no-placeholders",
    label: "No `TODO(observability)` placeholder lines left from the starter template",
    area: "observability",
    detect: /TODO\(observability\)/,
    failsWhenPresent: true,
  },
];

// Level >= 2 only: a level-1 heading is a document's title, and a typical
// Markdown doc has exactly one, so it never has a closing "same-or-higher"
// heading to bound it (see findSections) — treating it as a candidate
// section would swallow the entire rest of the file whenever the title
// happens to contain "logging" (e.g. a doc titled "# Logging"). A doc whose
// whole body is the policy is read with `wholeDocument` instead.
const LOGGING_SECTION_HEADING = /^(#{2,6})[ \t]*.*\b(logging|log format|log output)\b.*$/i;
const POLICY_SECTION_HEADING = /^(#{2,6})[ \t]*.*\b(observability|telemetry|monitoring|logging|log format|log output)\b.*$/i;
const ANY_HEADING = /^(#{1,6})[ \t]/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
// The opt-out counts only on a line of its own, so a doc can quote it mid-sentence without opting out.
const NO_TELEMETRY_LINE = /^[ \t]*This repo emits no runtime telemetry\.[ \t]*$/m;
const KNOWN_GAPS_SECTION_HEADING = /^(#{2,6})[ \t]*.*\bknown gaps\b.*$/i;
const TOP_LEVEL_LIST_ITEM = /^(?:[-*+]|\d+[.)])[ \t]+(.+)$/;
const ACCEPTED_ITEM = /^accepted[*_`]*\s*:/i;

export interface ObservabilityDocPath {
  path: string;
  /** The whole file is the policy, so no section heading is needed. */
  wholeDocument?: boolean;
}

/** Accepted policy locations, in priority order, checked by the scanner and `observabilityContext`. */
export const OBSERVABILITY_DOC_PATHS: readonly ObservabilityDocPath[] = [
  { path: "docs/observability.md", wholeDocument: true },
  { path: "AGENTS.md" },
  { path: "docs/logging.md" },
];

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

/** Every section under a heading matching `heading`, in order; headings inside fenced code are ignored. */
function findSections(text: string, heading: RegExp): string[] {
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  const sections: string[] = [];

  for (let start = 0; start < lines.length; start++) {
    if (fenced[start]) continue;
    const match = lines[start].match(heading);
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

/** The section missing the fewest rules, first on ties; null when none matches. */
function bestSection(sections: readonly string[], missing: (section: string) => readonly unknown[]): string | null {
  let best: { section: string; missing: number } | null = null;
  for (const section of sections) {
    const count = missing(section).length;
    if (best === null || count < best.missing) best = { section, missing: count };
  }
  return best?.section ?? null;
}

function ruleHolds(rule: ObservabilityRule, text: string): boolean {
  const hit = rule.detect.test(text);
  return rule.failsWhenPresent ? !hit : hit;
}

function rulesMissingFrom(section: string): readonly LoggingRule[] {
  return LOGGING_RULES.filter((r) => !ruleHolds(r, section));
}

function observabilityRulesMissingFrom(section: string): readonly ObservabilityRule[] {
  if (NO_TELEMETRY_LINE.test(section)) {
    // The no-telemetry sentence waives the subsections, not the Known gaps check.
    return OBSERVABILITY_RULES.filter((r) => (r.failsWhenPresent || r.id === "known-gaps") && !ruleHolds(r, section));
  }
  // The pasted logging block (under any heading) satisfies the four logging
  // keyword rules, and is cut before testing the observability rules: its
  // `trace` level name would otherwise pass `traces`.
  const hasLoggingBlock = section.includes(LOGGING_CONTRACT_BODY);
  const rest = hasLoggingBlock ? section.replace(LOGGING_CONTRACT_BODY, "") : section;
  return OBSERVABILITY_RULES.filter((r) =>
    r.area === "logging" ? !hasLoggingBlock && !ruleHolds(r, section) : !ruleHolds(r, rest),
  );
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
  return bestSection(findSections(text, LOGGING_SECTION_HEADING), rulesMissingFrom);
}

/**
 * Extracts the observability policy section the way `findLoggingSection` does,
 * but also accepting `observability`, `telemetry` and `monitoring` headings,
 * and ranking candidates by `OBSERVABILITY_RULES`. Null when no heading matches.
 */
export function findObservabilitySection(text: string): string | null {
  return bestSection(findSections(text, POLICY_SECTION_HEADING), observabilityRulesMissingFrom);
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

/**
 * Rules from OBSERVABILITY_RULES the document's policy does not cover. With
 * `wholeDocument` the whole text is the policy; otherwise it is the best
 * policy section, and a document with none misses every rule. A document
 * containing `OBSERVABILITY_CONTRACT_MARKDOWN` verbatim is checked only for
 * leftover placeholders. A policy holding `NO_TELEMETRY_SENTENCE` on its own
 * line opts out of every rule but `known-gaps` and `no-placeholders`, and one
 * containing `LOGGING_CONTRACT_BODY` passes the logging rules.
 */
export function missingObservabilityRules(
  text: string,
  opts: { wholeDocument?: boolean } = {},
): readonly ObservabilityRule[] {
  if (text.includes(OBSERVABILITY_CONTRACT_MARKDOWN)) {
    return OBSERVABILITY_RULES.filter((r) => r.failsWhenPresent && !ruleHolds(r, text));
  }
  const section = opts.wholeDocument ? text : findObservabilitySection(text);
  if (section === null) return OBSERVABILITY_RULES;
  const missing = observabilityRulesMissingFrom(section);
  if (opts.wholeDocument || NO_TELEMETRY_LINE.test(section)) return missing;
  // Logging rules met elsewhere in the same file (a verbatim block or a
  // separate `## Logging` section) count even when the best policy section
  // is the observability one.
  const loggingMissing = new Set(missingLoggingRules(text).map((r) => r.id));
  return missing.filter((r) => r.area !== "logging" || loggingMissing.has(r.id));
}

export interface KnownGap {
  text: string;
  /** The item starts with `Accepted:` (bold or code marks allowed), so no follow-up issue is filed for it. */
  accepted: boolean;
}

/**
 * The gaps a policy lists under its Known gaps heading (level 2–6, outside
 * fenced code, up to the next same-or-higher heading): one per unindented
 * top-level list item, continuation and nested lines ignored. An empty array
 * when the section lists none (`None.` or prose only); null when the policy
 * has no Known gaps heading.
 */
export function parseKnownGaps(policy: string): KnownGap[] | null {
  const sections = findSections(policy, KNOWN_GAPS_SECTION_HEADING);
  if (sections.length === 0) return null;
  const gaps: KnownGap[] = [];
  for (const section of sections) {
    const lines = section.split("\n").slice(1);
    const fenced = fencedLines(lines);
    let current: KnownGap | null = null;
    lines.forEach((line, i) => {
      if (fenced[i]) {
        current = null;
        return;
      }
      const match = line.match(TOP_LEVEL_LIST_ITEM);
      if (match) {
        const text = match[1]!.trim();
        current = { text, accepted: ACCEPTED_ITEM.test(text.replace(/^[*_`]+/, "")) };
        gaps.push(current);
        return;
      }
      // An indented, non-list line continues the item above.
      if (current && /^\s+[^\s\-*+\d]/.test(line)) {
        current.text += ` ${line.trim()}`;
      } else {
        current = null;
      }
    });
  }
  return gaps;
}
