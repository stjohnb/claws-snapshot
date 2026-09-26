import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  LOGGING_CONTEXT,
  LOGGING_CONTRACT_HEADING,
  LOGGING_CONTRACT_MARKDOWN,
  LOGGING_RULES,
  findLoggingSection,
  missingLoggingRules,
} from "./logging-contract.js";

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

describe("LOGGING_CONTEXT", () => {
  it("is wrapped in a <logging> block and leads with the conditional qualifier", () => {
    expect(LOGGING_CONTEXT.startsWith("<logging>\nOnly if this task writes log output")).toBe(true);
    expect(LOGGING_CONTEXT.endsWith("</logging>")).toBe(true);
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

describe("docs/logging-conventions.md", () => {
  const doc = readFileSync(join(repoRoot, "docs", "logging-conventions.md"), "utf-8");

  it("contains the canonical contract block verbatim", () => {
    expect(doc).toContain(LOGGING_CONTRACT_MARKDOWN);
  });
});
