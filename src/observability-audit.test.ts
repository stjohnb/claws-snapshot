import { describe, expect, it } from "vitest";
import { buildObservabilityAuditPrompt } from "./observability-audit.js";

const POLICY = { path: "docs/observability.md", text: "# Observability\n\nRules.\n" };

describe("buildObservabilityAuditPrompt", () => {
  it("lists the exceptions after the Known gaps with the never-report instruction", () => {
    const prompt = buildObservabilityAuditPrompt(POLICY, "abc", [{ text: "No DB durations.", accepted: false }], "log", [
      {
        contract: "observability",
        rule: "observability-audit",
        keys: ["src/db.ts", "src/pool.ts"],
        reason: "Queries run once at startup.",
        finding: "1a2b3c4d",
      },
    ]);
    const gapsEnd = prompt.indexOf("</known_gaps>");
    const block = prompt.indexOf("<exceptions>\n- rule `observability-audit`, finding `1a2b3c4d`, keys `src/db.ts`, `src/pool.ts`: Queries run once at startup.\n</exceptions>");
    expect(gapsEnd).toBeGreaterThan(0);
    expect(block).toBeGreaterThan(gapsEnd);
    expect(prompt).toContain("`.claws/contract-exceptions.yaml`");
    expect(prompt).toContain("Never report anything these cover.");
    expect(prompt).toContain("anything listed under Known gaps or covered by an exception");
  });

  it("writes None. when the repo has no exceptions", () => {
    expect(buildObservabilityAuditPrompt(POLICY, null, [], "", [])).toContain("<exceptions>\nNone.\n</exceptions>");
  });
});
