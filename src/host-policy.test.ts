import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  HOST_EXECUTION_POLICY,
  HOST_POLICY_HEADING,
  HOST_POLICY_MARKDOWN,
  HOST_POLICY_RULES,
  findHostPolicySection,
  missingHostPolicyRules,
} from "./host-policy.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("HOST_EXECUTION_POLICY", () => {
  it("mentions port 3000 and playwright", () => {
    expect(HOST_EXECUTION_POLICY).toContain("3000");
    expect(HOST_EXECUTION_POLICY.toLowerCase()).toContain("playwright");
  });
});

describe("HOST_POLICY_MARKDOWN", () => {
  it("starts with the canonical heading", () => {
    expect(HOST_POLICY_MARKDOWN.startsWith(HOST_POLICY_HEADING)).toBe(true);
  });

  it("is self-consistent: satisfies every rule it documents", () => {
    expect(missingHostPolicyRules(HOST_POLICY_MARKDOWN)).toEqual([]);
  });
});

describe("findHostPolicySection", () => {
  it("returns null when no host-policy heading exists", () => {
    const text = [
      "# My Repo",
      "",
      "## CI toolchain",
      "Run `npm run dev` locally and `sudo apt-get install` deps.",
    ].join("\n");
    expect(findHostPolicySection(text)).toBeNull();
  });

  it("stops at the next same-or-higher-level heading", () => {
    const text = [
      "# My Repo",
      "",
      "## Automation host policy",
      "Do not start dev servers. No sudo/apt-get. Never kill a port you don't own.",
      "",
      "## Next section",
      "Unrelated content that mentions npm run dev and apt-get and port and kill.",
    ].join("\n");
    const section = findHostPolicySection(text);
    expect(section).toContain("Automation host policy");
    expect(section).not.toContain("Next section");
    expect(section).not.toContain("Unrelated content");
  });
});

describe("missingHostPolicyRules", () => {
  it("returns all rules missing when the mentions are outside any host-policy section", () => {
    const text = [
      "# My Repo",
      "",
      "## CI toolchain",
      "This repo's CI runs `npm run dev`, `sudo apt-get install` build deps, and manages",
      "processes on port 8080 without ever needing to kill anything.",
    ].join("\n");
    expect(missingHostPolicyRules(text)).toEqual(HOST_POLICY_RULES);
  });

  it("returns exactly the ports rule when the section omits it", () => {
    const text = [
      "## Automation host policy",
      "Do not start dev servers or other long-running processes (npm run dev, docker compose up).",
      "Do not install system packages: no sudo, no apt-get install, no playwright install.",
    ].join("\n");
    expect(missingHostPolicyRules(text)).toEqual([
      HOST_POLICY_RULES.find((r) => r.id === "ports"),
    ]);
  });

  it("returns no rules missing for a fully compliant section", () => {
    expect(missingHostPolicyRules(HOST_POLICY_MARKDOWN)).toEqual([]);
  });
});

describe("this repo's own AGENTS.md", () => {
  const agentsMd = readFileSync(join(repoRoot, "AGENTS.md"), "utf-8");

  it("documents every automation-host policy rule the scanner checks", () => {
    expect(missingHostPolicyRules(agentsMd)).toEqual([]);
  });

  it("contains the canonical policy block verbatim", () => {
    expect(agentsMd).toContain(HOST_POLICY_MARKDOWN);
  });
});
