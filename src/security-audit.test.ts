import { describe, expect, it } from "vitest";
import { SECURITY_AUDIT, buildSecurityAuditPrompt, parseSecurityAuditFindings } from "./security-audit.js";

const POLICY = { path: "docs/security.md", text: "## Security\n\n### Secrets\n\nSecrets come from SOPS.\n" };

describe("buildSecurityAuditPrompt", () => {
  const prompt = buildSecurityAuditPrompt(POLICY, "abc123", [{ text: "`a.ts` is known", accepted: false }], "some git log");

  it("is read-only and carries the policy and known gaps", () => {
    expect(prompt).toContain("read-only audit");
    expect(prompt).toContain("<policy>\n## Security");
    expect(prompt).toContain("<known_gaps>\n- `a.ts` is known");
  });

  it("ignores the git range", () => {
    expect(prompt).not.toContain("abc123");
    expect(prompt).not.toContain("some git log");
  });

  it("covers each audit area and the cross-repo read path", () => {
    for (const word of ["Secrets:", "Exposure and authentication", "Supply chain", "Lockfiles", "Scan gate", "Renovate", "NetworkPolicy", "$CLAWS_FORGEJO_READ_TOKEN", "never quote"]) {
      expect(prompt).toContain(word);
    }
    expect(prompt).toContain("40-hex SHA");
  });
});

describe("parseSecurityAuditFindings", () => {
  it("keys a local finding by its file", () => {
    const out = parseSecurityAuditFindings('```json\n{"findings":[{"file":"./ci.yml","line":3,"claim":"CI uses npm ci","evidence":"it runs npm install"}]}\n```');
    expect(out).toEqual([
      { rule: "security-audit", key: "ci.yml", file: "ci.yml", line: 3, message: "The policy says CI uses npm ci; the code shows it runs npm install." },
    ]);
  });

  it("stores a cross-repo finding with no file", () => {
    const out = parseSecurityAuditFindings(
      '```json\n{"findings":[{"repo":"St-John-Software/fleet-infra","file":"apps/x/ingress.yaml","line":5,"claim":"the ingress authenticates","evidence":"no middleware"}]}\n```',
    );
    expect(out).toHaveLength(1);
    expect(out![0]).not.toHaveProperty("file");
    expect(out![0]).not.toHaveProperty("line");
    expect(out![0]!.key).toBe("St-John-Software/fleet-infra:apps/x/ingress.yaml");
    expect(out![0]!.message.startsWith("`St-John-Software/fleet-infra:apps/x/ingress.yaml:5`: The policy says")).toBe(true);
  });

  it("returns null without a findings object", () => {
    expect(parseSecurityAuditFindings("all fine")).toBeNull();
  });
});

describe("SECURITY_AUDIT.readPolicy opt-out", () => {
  it("is registered with a two-day first-audit offset", () => {
    expect(SECURITY_AUDIT.firstAuditOffsetDays).toBe(2);
  });
});
