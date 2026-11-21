import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_EXCEPTIONS_PATH, readContractExceptions } from "./contract-exceptions.js";

const RULES = ["console-bypass", "named-path-missing", "observability-audit"];
const AUDIT = { auditRules: ["observability-audit"] };
const dirs: string[] = [];

function repo(yaml?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "contract-exceptions-"));
  dirs.push(dir);
  if (yaml !== undefined) {
    fs.mkdirSync(path.join(dir, ".claws"));
    fs.writeFileSync(path.join(dir, CONTRACT_EXCEPTIONS_PATH), yaml);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("readContractExceptions", () => {
  it("returns nothing for a missing or empty file", () => {
    expect(readContractExceptions(repo(), "observability", RULES)).toEqual({ exceptions: [], problems: [] });
    expect(readContractExceptions(repo(""), "observability", RULES)).toEqual({ exceptions: [], problems: [] });
  });

  it("reads the documented example", () => {
    const yaml = [
      "exceptions:",
      "  - contract: observability",
      "    rule: named-path-missing",
      "    keys:",
      "      - dist-server/main.js",
      "    reason: Gitignored build output, not a tracked file.",
    ].join("\n");
    expect(readContractExceptions(repo(yaml), "observability", RULES)).toEqual({
      exceptions: [
        {
          contract: "observability",
          rule: "named-path-missing",
          keys: ["dist-server/main.js"],
          reason: "Gitignored build output, not a tracked file.",
        },
      ],
      problems: [],
    });
  });

  it("keeps a pinned finding id, lowercased", () => {
    const yaml = [
      "exceptions:",
      "  - contract: observability",
      "    rule: observability-audit",
      "    keys: [src/db.ts]",
      "    finding: 1A2B3C4D",
      "    reason: The query runs once at startup.",
    ].join("\n");
    const { exceptions, problems } = readContractExceptions(repo(yaml), "observability", RULES, AUDIT);
    expect(problems).toEqual([]);
    expect(exceptions[0]!.finding).toBe("1a2b3c4d");
  });

  it("reports an unquoted all-digit finding as needing quotes", () => {
    const yaml = [
      "exceptions:",
      "  - contract: observability",
      "    rule: observability-audit",
      "    keys: [src/db.ts]",
      "    finding: 12345678",
      "    reason: The query runs once at startup.",
    ].join("\n");
    const { exceptions, problems } = readContractExceptions(repo(yaml), "observability", RULES, AUDIT);
    expect(exceptions).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("quoted string");
  });

  it("reports entries with no known contract only when reportUnowned is on", () => {
    const yaml = ["exceptions:", "  - contract: Observability", "    rule: console-bypass", "    keys: [a.ts]", "    reason: three whole words"].join("\n");
    expect(readContractExceptions(repo(yaml), "observability", RULES).problems).toHaveLength(1);
    expect(readContractExceptions(repo(yaml), "security", RULES, { reportUnowned: false }).problems).toEqual([]);
  });

  it("silently skips entries for the other contract", () => {
    const yaml = ["exceptions:", "  - contract: security", "    rule: vex", "    keys: []", "    reason: x"].join("\n");
    expect(readContractExceptions(repo(yaml), "observability", RULES)).toEqual({ exceptions: [], problems: [] });
  });

  it("reports an unparseable file or one without an exceptions list", () => {
    expect(readContractExceptions(repo("exceptions: [unclosed"), "observability", RULES).problems).toEqual([
      expect.stringContaining("the file is not valid YAML"),
    ]);
    expect(readContractExceptions(repo("- a\n- b\n"), "observability", RULES)).toEqual({
      exceptions: [],
      problems: ["the file has no top-level `exceptions` list"],
    });
  });

  it("drops and reports each invalid entry, keeping the valid ones", () => {
    const entry = (fields: string[]) => ["  - contract: observability", ...fields.map((f) => `    ${f}`)];
    const yaml = [
      "exceptions:",
      ...entry(["rule: console-bypass", "keys: [src/a.ts]", "reason: Browser code, exempt here."]),
      "  - contract: logging",
      "    rule: console-bypass",
      "    keys: [src/a.ts]",
      "    reason: Browser code, exempt here.",
      ...entry(["rule: no-such-rule", "keys: [src/a.ts]", "reason: Browser code, exempt here."]),
      ...entry(["rule: console-bypass", "keys: []", "reason: Browser code, exempt here."]),
      ...entry(["rule: console-bypass", "keys: [src/a.ts]", "reason: Not applicable"]),
      ...entry(["rule: observability-audit", "keys: [src/a.ts]", "reason: Browser code, exempt here."]),
      ...entry(["rule: console-bypass", "keys: [src/a.ts]", "finding: xyz", "reason: Browser code, exempt here."]),
      ...entry(["rule: console-bypass", "reason: Browser code, exempt here."]),
    ].join("\n");
    const { exceptions, problems } = readContractExceptions(repo(yaml), "observability", RULES, AUDIT);
    expect(exceptions.map((e) => e.keys)).toEqual([["src/a.ts"]]);
    expect(problems).toEqual([
      expect.stringMatching(/^entry 2 names unknown contract `logging`/),
      expect.stringMatching(/^entry 3 names rule `no-such-rule`, which is not one of the observability rules/),
      "entry 4 has no `keys`",
      "entry 5 needs a `reason` of at least 3 words",
      expect.stringMatching(/^entry 6 covers audit rule `observability-audit`, which needs the `finding` id/),
      expect.stringMatching(/^entry 7 has `finding` `xyz`/),
      expect.stringMatching(/^entry 8 needs string `contract`/),
    ]);
  });
});
