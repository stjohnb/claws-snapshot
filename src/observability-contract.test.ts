import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  OBSERVABILITY_CONTEXT,
  KNOWN_GAPS_HEADING,
  LOGGING_CONTRACT_BODY,
  LOGGING_CONTRACT_HEADING,
  LOGGING_CONTRACT_MARKDOWN,
  LOGGING_RULES,
  NO_TELEMETRY_SENTENCE,
  OBSERVABILITY_CONTRACT_HEADING,
  OBSERVABILITY_CONTRACT_MARKDOWN,
  OBSERVABILITY_PLACEHOLDER,
  OBSERVABILITY_RULES,
  POLICY_VERIFICATION_CONTEXT,
  findLoggingSection,
  findObservabilitySection,
  missingLoggingRules,
  missingObservabilityRules,
  parseKnownGaps,
} from "./observability-contract.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("LOGGING_CONTRACT_MARKDOWN", () => {
  it("starts with the canonical heading", () => {
    expect(LOGGING_CONTRACT_MARKDOWN.startsWith(LOGGING_CONTRACT_HEADING)).toBe(true);
  });

  it("is self-consistent: satisfies every rule it documents", () => {
    expect(missingLoggingRules(LOGGING_CONTRACT_MARKDOWN)).toEqual([]);
  });

  it("documents every contract field and the numeric-level warning", () => {
    for (const field of [
      "`time`", "`level`", "`msg`", "`service`", "`component`", "`err`",
      "`request_id`", "`run_id`", "`repo`", "`issue`", "`pr`",
      "`http.method`", "`http.path`", "`http.status`", "`duration_ms`",
    ]) {
      expect(LOGGING_CONTRACT_MARKDOWN).toContain(field);
    }
    expect(LOGGING_CONTRACT_MARKDOWN).toContain("formatters: { level: (label) => ({ level: label }) }");
    expect(LOGGING_CONTRACT_MARKDOWN).toContain("pino.stdTimeFunctions.isoTime");
    expect(LOGGING_CONTRACT_MARKDOWN).toMatch(/numeric levels/);
  });

  it("contains no heading that would end its own section early", () => {
    const section = findLoggingSection(LOGGING_CONTRACT_MARKDOWN);
    expect(section).toBe(LOGGING_CONTRACT_MARKDOWN);
  });
});

describe("OBSERVABILITY_CONTEXT", () => {
  it("is wrapped in an <observability> block, keeps the logging rules and asks for per-change instrumentation", () => {
    expect(OBSERVABILITY_CONTEXT.startsWith("<observability>\nOnly if this task writes log output")).toBe(true);
    expect(OBSERVABILITY_CONTEXT.endsWith("</observability>")).toBe(true);
    expect(OBSERVABILITY_CONTEXT).toContain("new HTTP route, DB query, background job or external call");
    expect(OBSERVABILITY_CONTEXT).toContain("say in the PR that the repo has no observability policy");
  });

  it("carries the policy verification paragraph", () => {
    expect(OBSERVABILITY_CONTEXT).toContain(POLICY_VERIFICATION_CONTEXT);
    expect(POLICY_VERIFICATION_CONTEXT).toContain("against this repo's code and config");
    expect(POLICY_VERIFICATION_CONTEXT).toContain(KNOWN_GAPS_HEADING);
    expect(POLICY_VERIFICATION_CONTEXT).toContain("flags an unsupported claim");
  });
});

describe("findLoggingSection", () => {
  it("returns null when no logging heading exists", () => {
    const text = [
      "# My Repo",
      "",
      "## API",
      "Responses are JSON on stdout; pass a token and a lowercase level.",
    ].join("\n");
    expect(findLoggingSection(text)).toBeNull();
  });

  it("stops at the next same-or-higher-level heading", () => {
    const text = [
      "# My Repo",
      "",
      "## Logging",
      "One JSON line per record.",
      "",
      "## Next section",
      "Unrelated content mentioning stack and secret.",
    ].join("\n");
    const section = findLoggingSection(text);
    expect(section).toContain("## Logging");
    expect(section).not.toContain("Next section");
    expect(section).not.toContain("Unrelated content");
  });

  it("matches alternate heading wording", () => {
    expect(findLoggingSection("### Log format\nJSON")).toBe("### Log format\nJSON");
  });
});

describe("missingLoggingRules", () => {
  it("returns all rules missing when mentions are outside any logging section", () => {
    const text = [
      "# My Repo",
      "",
      "## API",
      "The API returns JSON on stdout, a lowercase level, an err stack, and never a secret token.",
    ].join("\n");
    expect(missingLoggingRules(text)).toEqual(LOGGING_RULES);
  });

  it("returns every rule for a logging heading that mentions none of them", () => {
    const text = ["## Logging", "", "We log things."].join("\n");
    expect(missingLoggingRules(text)).toEqual(LOGGING_RULES);
  });

  it("is compliant when an earlier heading merely mentions logging before the pasted contract", () => {
    const text = [
      "# Repo",
      "",
      "## Debugging and logging tips",
      "",
      "Some unrelated text about debugging the app.",
      "",
      LOGGING_CONTRACT_MARKDOWN,
    ].join("\n");
    expect(missingLoggingRules(text)).toEqual([]);
  });

  it("picks the most complete of several hand-written logging sections", () => {
    const text = [
      "# Repo",
      "",
      "## Debugging and logging tips",
      "Use the inspector.",
      "",
      "## Logging",
      "One JSON object per line on stdout with a lowercase string level; errors as an err object; no secrets.",
    ].join("\n");
    expect(missingLoggingRules(text)).toEqual([]);
    expect(findLoggingSection(text)).toContain("## Logging\n");
  });

  it("ignores headings inside fenced code blocks", () => {
    const text = [
      "# Repo",
      "",
      "## Logging",
      "One JSON object per line on stdout.",
      "```sh",
      "# enable logging",
      "export LOG_LEVEL=info",
      "```",
      "Lowercase string level; errors as an err object; no secrets.",
    ].join("\n");
    expect(missingLoggingRules(text)).toEqual([]);
    expect(findLoggingSection("```md\n## Logging\n```\nJSON on stdout.")).toBeNull();
  });

  it("returns exactly the no-secrets rule when the section omits it", () => {
    const text = [
      "## Logging",
      "One JSON object per line on stdout with a lowercase string level; errors as an err object.",
    ].join("\n");
    expect(missingLoggingRules(text)).toEqual([LOGGING_RULES.find((r) => r.id === "no-secrets")]);
  });

  it("does not let a level-1 title double as its own logging section", () => {
    const text = [
      "# Logging",
      "",
      "This doc explains our logging setup for the deploy pipeline.",
      "",
      "## Deployment",
      "",
      "Deploys authenticate with a bearer token against the registry. The service reads",
      "the config as json and prints the response.",
      "",
      "## Rotation",
      "",
      "Rotate the deploy token and check the level of access granted; on error the",
      "stack is printed.",
    ].join("\n");
    expect(findLoggingSection(text)).toBeNull();
    expect(missingLoggingRules(text)).toEqual(LOGGING_RULES);
  });
});

const ids = (rules: readonly { id: string }[]): string[] => rules.map((r) => r.id);
const OBSERVABILITY_AREA_IDS = OBSERVABILITY_RULES.filter((r) => r.area === "observability").map((r) => r.id);

describe("OBSERVABILITY_CONTRACT_MARKDOWN", () => {
  it("starts with the canonical heading", () => {
    expect(OBSERVABILITY_CONTRACT_MARKDOWN.startsWith(OBSERVABILITY_CONTRACT_HEADING)).toBe(true);
  });

  it("embeds the logging contract body under ### Logging behind a placeholder line", () => {
    expect(LOGGING_CONTRACT_MARKDOWN).toBe(`${LOGGING_CONTRACT_HEADING}\n\n${LOGGING_CONTRACT_BODY}`);
    const logging = OBSERVABILITY_CONTRACT_MARKDOWN.slice(OBSERVABILITY_CONTRACT_MARKDOWN.indexOf("\n### Logging\n"));
    const placeholderAt = logging.indexOf(OBSERVABILITY_PLACEHOLDER);
    expect(placeholderAt).toBeGreaterThan(0);
    expect(placeholderAt).toBeLessThan(logging.indexOf(LOGGING_CONTRACT_BODY));
    expect(logging).toContain("name the logger module");
  });

  it("does not let a verbatim paste of the logging block pass no-placeholders", () => {
    const logging = OBSERVABILITY_CONTRACT_MARKDOWN.slice(
      OBSERVABILITY_CONTRACT_MARKDOWN.indexOf("### Logging"),
      OBSERVABILITY_CONTRACT_MARKDOWN.indexOf("### Metrics"),
    );
    const filledElsewhere = OBSERVABILITY_CONTRACT_MARKDOWN
      .replace(logging, "\u0000")
      .replaceAll(`${OBSERVABILITY_PLACEHOLDER} `, "")
      .replace("\u0000", logging);
    expect(ids(missingObservabilityRules(filledElsewhere))).toEqual(["no-placeholders"]);
  });

  it("says current-behaviour statements must be true of the code", () => {
    expect(OBSERVABILITY_CONTRACT_MARKDOWN).toContain("must be true of this repo's code and config today");
  });

  it("has every contract subsection", () => {
    for (const heading of ["### Scope", "### Logging", "### Metrics", "### Traces", "### Latency budgets", "### Dashboards and alerts", "### What every change adds", KNOWN_GAPS_HEADING]) {
      expect(OBSERVABILITY_CONTRACT_MARKDOWN).toContain(`\n${heading}\n`);
    }
    for (const ask of ["HTTP route", "DB query", "background job", "external call"]) {
      expect(OBSERVABILITY_CONTRACT_MARKDOWN).toContain(ask);
    }
  });

  it("names the opt-out sentence without opting out itself", () => {
    expect(OBSERVABILITY_CONTRACT_MARKDOWN).toContain(NO_TELEMETRY_SENTENCE);
  });

  it("is self-consistent: the raw template misses only no-placeholders", () => {
    expect(ids(missingObservabilityRules(OBSERVABILITY_CONTRACT_MARKDOWN))).toEqual(["no-placeholders"]);
    expect(ids(missingObservabilityRules(`# Repo\n\n${OBSERVABILITY_CONTRACT_MARKDOWN}\n\n## Build\n`))).toEqual(["no-placeholders"]);
  });

  it("is self-consistent: the template with its placeholders filled in misses nothing", () => {
    const filled = OBSERVABILITY_CONTRACT_MARKDOWN.replaceAll(`${OBSERVABILITY_PLACEHOLDER} `, "");
    expect(missingObservabilityRules(filled)).toEqual([]);
    expect(missingObservabilityRules(filled, { wholeDocument: true })).toEqual([]);
  });

  it("is self-consistent: the template with its placeholder lines deleted misses nothing", () => {
    const stripped = OBSERVABILITY_CONTRACT_MARKDOWN.split("\n").filter((l) => !l.includes(OBSERVABILITY_PLACEHOLDER)).join("\n");
    expect(missingObservabilityRules(stripped)).toEqual([]);
  });

  it("contains no heading that would end its own section early", () => {
    expect(findObservabilitySection(OBSERVABILITY_CONTRACT_MARKDOWN)).toBe(OBSERVABILITY_CONTRACT_MARKDOWN);
  });
});

describe("missingObservabilityRules", () => {
  it("misses every rule when no policy section exists", () => {
    expect(missingObservabilityRules("# Repo\n\n## Build\n\nnpm test")).toEqual(OBSERVABILITY_RULES);
  });

  it("passes a section that holds the opt-out sentence on its own line and a Known gaps section", () => {
    const text = `# Repo\n\n## Observability\n\n${NO_TELEMETRY_SENTENCE}\n\n${KNOWN_GAPS_HEADING}\n\nNone.\n\n## Build\n`;
    expect(missingObservabilityRules(text)).toEqual([]);
  });

  it("still requires Known gaps under the opt-out sentence", () => {
    const text = `# Repo\n\n## Observability\n\n${NO_TELEMETRY_SENTENCE}\n\n## Build\n`;
    expect(ids(missingObservabilityRules(text))).toEqual(["known-gaps"]);
  });

  it("does not opt out when the sentence is only quoted mid-line", () => {
    const text = `## Observability\n\nA library would write \`${NO_TELEMETRY_SENTENCE}\` here.`;
    expect(missingObservabilityRules(text).length).toBeGreaterThan(1);
  });

  it("still fails no-placeholders for an opted-out section with a leftover placeholder", () => {
    const text = `## Observability\n\n${NO_TELEMETRY_SENTENCE}\n\n${OBSERVABILITY_PLACEHOLDER} fill me in`;
    expect(ids(missingObservabilityRules(text))).toEqual(["known-gaps", "no-placeholders"]);
  });

  it("flags a legacy logging section only for the observability rules", () => {
    const text = `# Repo\n\n${LOGGING_CONTRACT_MARKDOWN}\n\n## Build\n\nnpm test`;
    expect(ids(missingObservabilityRules(text))).toEqual(OBSERVABILITY_AREA_IDS.filter((id) => id !== "no-placeholders"));
  });

  it("flags a hand-written compliant logging section only for observability rules", () => {
    const text = "## Logging\n\nOne JSON object per line on stdout with a lowercase string level; errors as an err object; no secrets.";
    const missing = missingObservabilityRules(text);
    expect(missing.every((r) => r.area === "observability")).toBe(true);
    expect(ids(missing)).toContain("metrics");
  });

  it("reads the whole document in wholeDocument mode, title included", () => {
    const text = [
      "# Observability",
      "",
      "Scope: the API runs as one Deployment.",
      "",
      "Logs are one JSON object per line on stdout, lowercase level, err objects with a stack, no secrets.",
      "",
      "Metrics: Prometheus scrapes /metrics. Traces: none. Latency budget: p95 under 300 ms.",
      "Dashboards and alerts live in fleet-infra. A new route or background job must be instrumented.",
      "",
      "## Known gaps",
      "",
      "None.",
    ].join("\n");
    expect(missingObservabilityRules(text, { wholeDocument: true })).toEqual([]);
    // Without wholeDocument a level-1 title is never a section.
    expect(missingObservabilityRules(text)).toEqual(OBSERVABILITY_RULES);
  });

  it("flags a complete policy without a Known gaps section only for known-gaps", () => {
    const filled = OBSERVABILITY_CONTRACT_MARKDOWN.replaceAll(`${OBSERVABILITY_PLACEHOLDER} `, "");
    const withoutGaps = filled.slice(0, filled.indexOf(KNOWN_GAPS_HEADING)).replaceAll(/known gaps/gi, "shortfalls");
    expect(ids(missingObservabilityRules(withoutGaps))).toEqual(["known-gaps"]);
  });

  it("still cuts the logging block's trace level name before the traces rule", () => {
    const text = `## Observability\n\nScope: a Deployment. Metrics: none. Latency budget: none. No dashboards. New routes are instrumented. Known gaps: none.\n\n### Logging\n\n${LOGGING_CONTRACT_BODY}\n`;
    expect(ids(missingObservabilityRules(text))).toEqual(["traces"]);
  });

  it("accepts telemetry and monitoring headings", () => {
    expect(findObservabilitySection("## Telemetry\nmetrics")).toBe("## Telemetry\nmetrics");
    expect(findObservabilitySection("## Monitoring\nalerts")).toBe("## Monitoring\nalerts");
  });
});

describe("parseKnownGaps", () => {
  it("joins wrapped continuation lines into the item", () => {
    const gaps = parseKnownGaps("## Known gaps\n\n- first part,\n  second part.\n- other\n");
    expect(gaps?.map((g) => g.text)).toEqual(["first part, second part.", "other"]);
  });

  it("returns null without a Known gaps heading", () => {
    expect(parseKnownGaps("## Observability\n\nKnown gaps: none mentioned in prose.")).toBeNull();
  });

  it("ignores a Known gaps heading inside fenced code", () => {
    expect(parseKnownGaps("## Observability\n\n```md\n### Known gaps\n- a gap\n```\n")).toBeNull();
  });

  it("returns no gaps for None. or prose only", () => {
    expect(parseKnownGaps("### Known gaps\n\nNone.\n")).toEqual([]);
    expect(parseKnownGaps("### Known gaps\n\nThe code meets every rule today.\n\n### Next\n- not a gap")).toEqual([]);
  });

  it("parses accepted and unaccepted top-level items, ignoring nested and continuation lines", () => {
    const text = [
      "## Observability",
      "",
      "### Known gaps",
      "",
      "- `request_id` is never emitted.",
      "  It would need a request-scoped context.",
      "  - nested detail",
      "* Accepted: no tracing, the service is a single process.",
      "1. **Accepted:** no DB query durations, queries are trivial.",
      "2) `Accepted`: none here either.",
      "- No saturation metric.",
      "",
      "```md",
      "- fenced, not a gap",
      "```",
      "",
      "## Build",
      "- not a gap",
    ].join("\n");
    expect(parseKnownGaps(text)).toEqual([
      { text: "`request_id` is never emitted. It would need a request-scoped context.", accepted: false },
      { text: "Accepted: no tracing, the service is a single process.", accepted: true },
      { text: "**Accepted:** no DB query durations, queries are trivial.", accepted: true },
      { text: "`Accepted`: none here either.", accepted: true },
      { text: "No saturation metric.", accepted: false },
    ]);
  });
});

describe("docs/observability-contract.md", () => {
  const doc = readFileSync(join(repoRoot, "docs", "observability-contract.md"), "utf-8");

  it("contains the canonical observability template verbatim", () => {
    expect(doc).toContain(OBSERVABILITY_CONTRACT_MARKDOWN);
  });

  it("contains the canonical logging contract block verbatim", () => {
    expect(doc).toContain(LOGGING_CONTRACT_BODY);
  });

  it("documents the known-gaps rule and accepted gaps", () => {
    expect(doc).toContain("`known-gaps`");
    expect(doc).toContain("## Known gaps");
    expect(doc).toContain("`Accepted: <reason>`");
    expect(doc).toContain("`observability-known-gaps`");
    expect(doc).not.toContain("passes the logging rules\noutright");
  });
});

describe("docs/observability.md (Claws' own policy)", () => {
  const doc = readFileSync(join(repoRoot, "docs", "observability.md"), "utf-8");

  it("misses no contract rule as a whole-document policy", () => {
    expect(missingObservabilityRules(doc, { wholeDocument: true })).toEqual([]);
  });

  it("keeps the logging contract block verbatim", () => {
    expect(doc).toContain(LOGGING_CONTRACT_MARKDOWN);
  });

  it("lists its known gaps", () => {
    const gaps = parseKnownGaps(doc);
    expect(gaps).not.toBeNull();
    expect(gaps!.length).toBeGreaterThan(0);
  });
});
