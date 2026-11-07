import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { KNOWN_GAPS_HEADING } from "./observability-contract.js";
import {
  SECURITY_CONTEXT,
  SECURITY_CONTRACT_HEADING,
  SECURITY_CONTRACT_MARKDOWN,
  SECURITY_DOC_PATHS,
  SECURITY_GUIDANCE,
  SECURITY_PLACEHOLDER,
  SECURITY_POLICY_VERIFICATION_CONTEXT,
  SECURITY_RULES,
  VEX_JUSTIFICATIONS,
  detectRepoKind,
  findSecuritySection,
  missingSecurityRules,
  policyClaimsImagePublish,
  validateVexDocument,
  type RepoKind,
} from "./security-contract.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SUBSECTIONS = {
  scope: "### Scope\n\nThis repo ships a CLI that runs on developer machines.",
  vulnerabilities:
    "### Dependency and image vulnerabilities\n\nThis repo publishes no container image. Renovate and `npm audit` find vulnerable dependencies.",
  "accepted-findings":
    "### Accepted findings\n\nNone: no finding is accepted, so `.vex/` is empty.",
  secrets: "### Secrets\n\nThe CLI reads its API token from the environment; no secret is committed.",
  "supply-chain": "### Supply chain\n\nDependencies are pinned by the committed lockfile and bumped by Renovate.",
  exposure: "### Exposure and authentication\n\nNothing is reachable from a network; the CLI runs locally.",
  "known-gaps": `${KNOWN_GAPS_HEADING}\n\nNone.`,
} as const;

type SubsectionId = keyof typeof SUBSECTIONS;

function policy(overrides: Partial<Record<SubsectionId, string | null>> = {}): string {
  const parts = [SECURITY_CONTRACT_HEADING, "", "Our policy."];
  for (const [id, text] of Object.entries(SUBSECTIONS) as [SubsectionId, string][]) {
    const value = id in overrides ? overrides[id] : text;
    if (value !== null && value !== undefined) parts.push("", value);
  }
  return parts.join("\n");
}

const ids = (rules: readonly { id: string }[]) => rules.map((r) => r.id);

describe("SECURITY_CONTRACT_MARKDOWN", () => {
  it("starts with the canonical heading and has every subsection behind a placeholder", () => {
    expect(SECURITY_CONTRACT_MARKDOWN.startsWith(SECURITY_CONTRACT_HEADING)).toBe(true);
    for (const heading of ["### Scope", "### Dependency and image vulnerabilities", "### Accepted findings", "### Secrets", "### Supply chain", "### Exposure and authentication", KNOWN_GAPS_HEADING]) {
      expect(SECURITY_CONTRACT_MARKDOWN).toContain(heading);
    }
    expect(SECURITY_CONTRACT_MARKDOWN.split(SECURITY_PLACEHOLDER).length - 1).toBe(7);
  });

  it("fails every rule while pasted unchanged", () => {
    expect(ids(missingSecurityRules(SECURITY_CONTRACT_MARKDOWN))).toEqual(ids(SECURITY_RULES));
  });

  it("passes once every placeholder is filled", () => {
    const filled = SECURITY_CONTRACT_MARKDOWN.split("\n").map((line) => {
      if (!line.startsWith(SECURITY_PLACEHOLDER)) return line;
      return line.replace(SECURITY_PLACEHOLDER, "Answer:");
    }).join("\n");
    // The Known gaps answer still needs list items or None.
    const withGaps = filled.replace(/(### Known gaps\n\n)Answer:[^\n]*/, "$1None.");
    expect(missingSecurityRules(withGaps)).toEqual([]);
  });
});

describe("missingSecurityRules", () => {
  it("passes a complete config-only policy in AGENTS.md", () => {
    const agents = `# Repo\n\n## Build\n\nnpm ci\n\n${policy()}\n\n## Other\n\nText.`;
    expect(missingSecurityRules(agents)).toEqual([]);
  });

  it("misses every rule with no security section", () => {
    expect(ids(missingSecurityRules("# Repo\n\n## Build\n\nnpm ci"))).toEqual(ids(SECURITY_RULES));
  });

  it.each(Object.keys(SUBSECTIONS) as SubsectionId[])("fails only %s when that subsection is missing", (id) => {
    expect(ids(missingSecurityRules(policy({ [id]: null })))).toEqual([id]);
  });

  it("passes a reasoned not-applicable answer", () => {
    const text = policy({ exposure: "### Exposure and authentication\n\nDoes not apply: this repo is a library with no server." });
    expect(missingSecurityRules(text)).toEqual([]);
  });

  it.each([
    "None yet, TBD.",
    "Secrets: none yet, TBD.",
    "Some endpoints exist; none of them are reviewed yet.",
  ])("fails an unreasoned or mid-body not-applicable answer: %s", (body) => {
    expect(ids(missingSecurityRules(policy({ exposure: `### Exposure and authentication\n\n${body}` })))).toEqual(["exposure"]);
  });

  it("passes a not-applicable answer behind a list marker and emphasis", () => {
    const text = policy({ exposure: "### Exposure and authentication\n\n- **N/A**: this repo has no server at all." });
    expect(missingSecurityRules(text)).toEqual([]);
  });

  it("still requires the gate when one image is pushed and another is not", () => {
    const text = policy({
      scope: "### Scope\n\nShips a container image.",
      vulnerabilities:
        "### Dependency and image vulnerabilities\n\nRenovate keeps deps fresh. The image is pushed by release.yml. The debug image is not pushed.",
    });
    expect(ids(missingSecurityRules(text))).toEqual(["vulnerabilities"]);
  });

  it("detects registry and container publish wording", () => {
    expect(policyClaimsImagePublish("Release builds and pushes registry.home.bstjohn.net/claws:tag.")).toBe(true);
    expect(policyClaimsImagePublish("CI publishes the container to the registry.")).toBe(true);
  });

  it("does not take prose mentioning none as an empty Known gaps", () => {
    const text = policy({ "known-gaps": `${KNOWN_GAPS_HEADING}\n\nGaps exist but none are listed yet; see the audit.` });
    expect(ids(missingSecurityRules(text))).toEqual(["known-gaps"]);
  });

  it("fails a bare None. outside Known gaps", () => {
    expect(ids(missingSecurityRules(policy({ exposure: "### Exposure and authentication\n\nNone." })))).toEqual(["exposure"]);
  });

  it("fails an empty subsection and an empty Known gaps", () => {
    const text = policy({ secrets: "### Secrets\n", "known-gaps": `${KNOWN_GAPS_HEADING}\n` });
    expect(ids(missingSecurityRules(text))).toEqual(["secrets", "known-gaps"]);
  });

  it("passes Known gaps with list items", () => {
    const text = policy({ "known-gaps": `${KNOWN_GAPS_HEADING}\n\n- No lockfile yet.\n- Accepted: base image by tag.` });
    expect(missingSecurityRules(text)).toEqual([]);
  });

  it("fails a leftover placeholder", () => {
    const text = policy().replace("Our policy.", `${SECURITY_PLACEHOLDER} something`);
    expect(ids(missingSecurityRules(text))).toEqual(["no-placeholders"]);
  });

  it("fails an image claim without the gate wording", () => {
    const text = policy({ vulnerabilities: "### Dependency and image vulnerabilities\n\nThe release workflow publishes a container image. Renovate bumps dependencies." });
    expect(ids(missingSecurityRules(text))).toEqual(["vulnerabilities"]);
  });

  it("passes an image claim with the gate wording", () => {
    const text = policy({
      vulnerabilities:
        "### Dependency and image vulnerabilities\n\nThe release workflow publishes a container image. It scans the image with trivy before every push and blocks on fixable High or Critical findings not covered by `.vex/`.",
    });
    expect(missingSecurityRules(text)).toEqual([]);
  });

  it("passes gate wording that names the scan script by path", () => {
    const text = policy({
      vulnerabilities:
        "### Dependency and image vulnerabilities\n\nWe publish the container image; `scripts/ci/image-scan.sh` runs before every push and blocks High and Critical findings not in `.vex/`.",
    });
    expect(missingSecurityRules(text)).toEqual([]);
  });

  it("fails a bulleted image claim after an unrelated negation, without the gate wording", () => {
    const text = policy({
      vulnerabilities: "### Dependency and image vulnerabilities\n\n- No secrets in logs\n- release.yml pushes the container image to the registry\n- Renovate bumps dependencies",
    });
    expect(ids(missingSecurityRules(text, { wholeDocument: true }))).toEqual(["vulnerabilities"]);
  });

  it("fails an image claim made outside the vulnerabilities subsection", () => {
    const text = policy({
      scope: "### Scope\n\nWe ship a container image to the registry.",
      vulnerabilities: "### Dependency and image vulnerabilities\n\nRenovate keeps deps fresh.",
    });
    expect(ids(missingSecurityRules(text))).toEqual(["vulnerabilities"]);
  });

  it("checks a whole document without a ## Security heading", () => {
    const doc = policy().replace(`${SECURITY_CONTRACT_HEADING}\n`, "# Security policy\n");
    expect(missingSecurityRules(doc, { wholeDocument: true })).toEqual([]);
  });

  it("ignores headings inside fenced code", () => {
    const doc = `# Repo\n\n\`\`\`\n${policy()}\n\`\`\``;
    expect(ids(missingSecurityRules(doc))).toEqual(ids(SECURITY_RULES));
  });
});

describe("findSecuritySection", () => {
  it("prefers the most complete matching section", () => {
    const text = `# Repo\n\n## Security tips\n\nBe careful.\n\n${policy()}`;
    expect(findSecuritySection(text)).toBe(policy());
  });

  it("returns null without a security heading", () => {
    expect(findSecuritySection("# Repo\n\n## Build\n")).toBeNull();
  });
});

describe("policyClaimsImagePublish", () => {
  it.each([
    "The release workflow publishes a container image to the registry.",
    "release.yml pushes the image after the scan.",
    "The image is published by release.yml.",
    "- No secrets in logs\n- release.yml pushes the container image to the registry",
    "The release workflow, not a human, pushes the container image.",
    "Renovate does not bump the base image, and release.yml pushes the image to the registry.",
    "Without manual steps, CI publishes the container image.",
    "release.yml pushes registry.home.bstjohn.net/x/claws image.",
  ])("claims: %s", (text) => {
    expect(policyClaimsImagePublish(text)).toBe(true);
  });

  it.each([
    "This repo publishes no container image.",
    "Nothing here pushes an image.",
    "The repo does not publish a container image.",
    "Renovate keeps dependencies fresh.",
    "The image is not pushed anywhere.",
    "No image is published.",
  ])("does not claim: %s", (text) => {
    expect(policyClaimsImagePublish(text)).toBe(false);
  });
});

const VALID_VEX = {
  "@context": "https://openvex.dev/ns/v0.2.0",
  "@id": "https://git.home.bstjohn.net/St-John-Software/claws/.vex/CVE-2026-0001",
  author: "St-John-Software",
  timestamp: "2026-11-05T00:00:00Z",
  version: 1,
  statements: [
    {
      vulnerability: { name: "CVE-2026-0001" },
      products: [
        {
          "@id": "pkg:oci/claws?repository_url=registry.home.bstjohn.net/st-john-software/claws",
          subcomponents: [{ "@id": "pkg:golang/stdlib" }],
        },
      ],
      status: "not_affected",
      justification: "vulnerable_code_not_in_execute_path",
      impact_statement: "The vulnerable HTTP/2 server is never started; the binary is only a client.",
    },
  ],
};

function withStatement(patch: Record<string, unknown>): unknown {
  return { ...VALID_VEX, statements: [{ ...VALID_VEX.statements[0], ...patch }] };
}

describe("validateVexDocument", () => {
  it("accepts a valid not_affected statement", () => {
    expect(validateVexDocument(VALID_VEX)).toEqual([]);
  });

  it("knows the five OpenVEX justifications", () => {
    expect(VEX_JUSTIFICATIONS).toHaveLength(5);
  });

  it.each(["affected", "under_investigation", "fixed"])("rejects status %s", (status) => {
    expect(validateVexDocument(withStatement({ status }))).toEqual([
      `statements[0].status is "${status}"; only "not_affected" is allowed`,
    ]);
  });

  it("rejects a missing or unknown justification", () => {
    expect(validateVexDocument(withStatement({ justification: undefined }))).toEqual([
      "statements[0].justification is missing or not one of the five OpenVEX justifications",
    ]);
    expect(validateVexDocument(withStatement({ justification: "because" }))).toHaveLength(1);
  });

  it("rejects a missing or blank impact statement", () => {
    expect(validateVexDocument(withStatement({ impact_statement: undefined }))).toEqual([
      "statements[0].impact_statement is missing or empty",
    ]);
    expect(validateVexDocument(withStatement({ impact_statement: "   " }))).toHaveLength(1);
  });

  it("accepts a product identified only by identifiers", () => {
    expect(validateVexDocument(withStatement({ products: [{ identifiers: { purl: "pkg:oci/claws" } }] }))).toEqual([]);
  });

  it("rejects a document without statements, products or an OpenVEX context", () => {
    expect(validateVexDocument([])).toEqual(["document is not a JSON object"]);
    expect(validateVexDocument({ ...VALID_VEX, statements: [] })).toEqual(["statements is missing or empty"]);
    expect(validateVexDocument({ ...VALID_VEX, "@context": "https://example.com" })).toHaveLength(1);
    expect(validateVexDocument(withStatement({ products: [] }))).toEqual([
      "statements[0].products is missing, empty, or has a product without @id or identifiers",
    ]);
    expect(validateVexDocument(withStatement({ products: [{ identifiers: {} }] }))).toHaveLength(1);
    expect(validateVexDocument(withStatement({ vulnerability: {} }))).toEqual([
      "statements[0].vulnerability.name is missing",
    ]);
  });
});

describe("Claws' own .vex/", () => {
  const vexDir = join(repoRoot, ".vex");
  const files = fs.existsSync(vexDir) ? fs.readdirSync(vexDir).filter((f) => f.endsWith(".json")) : [];

  it("every statement file is valid OpenVEX not_affected", () => {
    for (const file of files) {
      const json: unknown = JSON.parse(fs.readFileSync(join(vexDir, file), "utf8"));
      expect({ file, errors: validateVexDocument(json) }).toEqual({ file, errors: [] });
    }
  });

  it("scripts/ci/image-scan.sh enforces the same checks", () => {
    const script = fs.readFileSync(join(repoRoot, "scripts", "ci", "image-scan.sh"), "utf8");
    for (const justification of VEX_JUSTIFICATIONS) expect(script).toContain(`"${justification}"`);
    for (const message of [
      "document is not a JSON object",
      "statements is missing or empty",
      ".vulnerability.name is missing",
      ".products is missing, empty, or has a product without @id or identifiers",
      '; only \\"not_affected\\" is allowed',
      ".justification is missing or not one of the five OpenVEX justifications",
      ".impact_statement is missing or empty",
    ]) {
      expect(script).toContain(message);
    }
    expect(script).not.toMatch(/^\s*set -[a-z]*x/m);
  });
});

describe("detectRepoKind", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function repo(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "security-kind-"));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(dirname(join(dir, rel)), { recursive: true });
      fs.writeFileSync(join(dir, rel), content);
    }
    return dir;
  }

  it.each<[Record<string, string>, RepoKind]>([
    [{ Dockerfile: "FROM x", "astro.config.mjs": "" }, "container-service"],
    [{ "app/Containerfile": "FROM x" }, "container-service"],
    [{ "apps/kustomization.yaml": "" }, "infra"],
    [{ "tofu/main.tf": "" }, "infra"],
    [{ "main.tf": "" }, "infra"],
    [{ "astro.config.mjs": "", "package.json": "{}" }, "static-site"],
    [{ "vite.config.ts": "" }, "static-site"],
    [{ "package.json": JSON.stringify({ bin: { x: "x.js" } }) }, "cli-or-library"],
    [{ "go.mod": "module x" }, "cli-or-library"],
    [{ "Cargo.toml": "" }, "cli-or-library"],
    [{ "board/board.kicad_pro": "" }, "firmware-or-hardware"],
    [{ "case.scad": "" }, "firmware-or-hardware"],
    [{ "platformio.ini": "" }, "firmware-or-hardware"],
    [{ "devices/heater.yaml": "esphome:\n  name: heater\n" }, "firmware-or-hardware"],
    [{ "README.md": "", "package.json": "{}" }, "config-only"],
    [{ ".forgejo/workflows/ci.yml": "run: docker push x" }, "config-only"],
    [{ "docs/Dockerfile.md": "", "README.md": "" }, "config-only"],
    [{ "Containerfile.txt": "" }, "config-only"],
    [{ "Dockerfile.dev": "FROM x" }, "container-service"],
  ])("%j is %s", (files, kind) => {
    expect(detectRepoKind(repo(files))).toBe(kind);
  });

  it("detects Claws as a container service", () => {
    expect(detectRepoKind(repoRoot)).toBe("container-service");
  });

  it("has 3–5 guidance bullets per kind", () => {
    for (const bullets of Object.values(SECURITY_GUIDANCE)) {
      expect(bullets.length).toBeGreaterThanOrEqual(3);
      expect(bullets.length).toBeLessThanOrEqual(5);
    }
    expect(SECURITY_GUIDANCE["container-service"].join(" ")).toContain(".vex/");
    expect(SECURITY_GUIDANCE.infra.join(" ")).toContain("exceptions.yaml");
  });
});

describe("SECURITY_CONTEXT", () => {
  it("is a <security> block carrying the verification paragraph", () => {
    expect(SECURITY_CONTEXT.startsWith("<security>\n")).toBe(true);
    expect(SECURITY_CONTEXT.endsWith("</security>")).toBe(true);
    expect(SECURITY_CONTEXT).toContain(SECURITY_POLICY_VERIFICATION_CONTEXT);
    expect(SECURITY_CONTEXT).toContain("Say in the PR that the repo has no security policy");
    expect(SECURITY_POLICY_VERIFICATION_CONTEXT).toContain(KNOWN_GAPS_HEADING);
    expect(SECURITY_POLICY_VERIFICATION_CONTEXT).toContain("Forgejo API");
    expect(SECURITY_POLICY_VERIFICATION_CONTEXT).toContain("flags an unsupported claim");
  });
});

describe("SECURITY_DOC_PATHS", () => {
  it("checks docs/security.md as a whole document, then AGENTS.md", () => {
    expect(SECURITY_DOC_PATHS).toEqual([{ path: "docs/security.md", wholeDocument: true }, { path: "AGENTS.md" }]);
  });
});

describe("docs/security-contract.md", () => {
  const doc = fs.readFileSync(join(repoRoot, "docs", "security-contract.md"), "utf-8");

  it("contains the starter template verbatim", () => {
    expect(doc).toContain(SECURITY_CONTRACT_MARKDOWN);
  });

  it("documents every rule and justification", () => {
    for (const rule of SECURITY_RULES) expect(doc).toContain(`\`${rule.id}\``);
    for (const justification of VEX_JUSTIFICATIONS) expect(doc).toContain(`\`${justification}\``);
    expect(doc).toContain("scripts/ci/image-scan.sh");
  });
});

describe("docs/security.md (Claws' own policy)", () => {
  const doc = fs.readFileSync(join(repoRoot, "docs", "security.md"), "utf-8");

  it("misses no contract rule as a whole-document policy", () => {
    expect(missingSecurityRules(doc, { wholeDocument: true })).toEqual([]);
  });

  it("claims the image push and states its gate", () => {
    expect(policyClaimsImagePublish(doc)).toBe(true);
    for (const claim of ["release.yml", "ci.yml", ".vex/", "package-lock.json", "Renovate", "SHA-pinned"]) {
      expect(doc).toContain(claim);
    }
  });
});
