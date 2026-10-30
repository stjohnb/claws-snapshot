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
  it("describes the agent pod and the local checks it can run", () => {
    expect(HOST_EXECUTION_POLICY.toLowerCase()).toContain("playwright");
    expect(HOST_EXECUTION_POLICY).toContain("6 GiB");
    expect(HOST_EXECUTION_POLICY).toContain("task validate");
    expect(HOST_EXECUTION_POLICY).toContain("nix develop");
  });

  it("names the image's tools and runs infra checks inside the flake devShell", () => {
    for (const tool of ["bash", "python3", "jq", "make/g++", "rg", "nix"]) {
      expect(HOST_EXECUTION_POLICY).toContain(tool);
    }
    expect(HOST_EXECUTION_POLICY).toContain("nix develop --command task validate");
    expect(HOST_EXECUTION_POLICY).toContain("never bare `task validate`");
    expect(HOST_EXECUTION_POLICY).toContain("allowScripts");
  });

  it("tells agents to run only the checks the repo defines", () => {
    expect(HOST_EXECUTION_POLICY).toContain("checks the repo itself defines");
    expect(HOST_EXECUTION_POLICY).not.toContain("type-check, lint, unit tests");
  });

  it("drops the old shared-host wording", () => {
    expect(HOST_EXECUTION_POLICY).not.toContain("5 GB");
    expect(HOST_EXECUTION_POLICY).not.toContain("80%");
    expect(HOST_EXECUTION_POLICY).not.toContain("runs the Claws service");
  });
});

describe("HOST_POLICY_MARKDOWN", () => {
  it("starts with the canonical heading", () => {
    expect(HOST_POLICY_MARKDOWN.startsWith(HOST_POLICY_HEADING)).toBe(true);
  });

  it("is self-consistent: satisfies every rule it documents", () => {
    expect(missingHostPolicyRules(HOST_POLICY_MARKDOWN)).toEqual([]);
  });

  it("leaves repos carrying the previous shared-host block compliant", () => {
    const previous = [
      HOST_POLICY_HEADING,
      "",
      "Claws agents work on a shared, resource-constrained automation host that also runs the",
      "Claws service itself. When working on this repo as an agent:",
      "",
      "- **Do not start dev servers or other long-running processes** (`npm run dev`, `npm start`,",
      "  `docker compose up`, watchers, tunnels). Verify with fast one-shot checks — type-check,",
      "  lint, unit tests — and let CI run anything that needs a live app or an end-to-end browser.",
      "- **Do not install system packages or browser binaries** on the host: no `sudo`, no",
      "  `apt-get install`, no `npx playwright install`, no `brew install`. If CI needs a tool,",
      "  add it to `flake.nix` in the same PR.",
      "- **Never kill a process or free a port you do not own.** `lsof -ti:PORT | xargs kill` and",
      "  `pkill -f node` will take down the Claws service, whose dashboard listens on port 3000.",
    ].join("\n");
    expect(missingHostPolicyRules(previous)).toEqual([]);
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
