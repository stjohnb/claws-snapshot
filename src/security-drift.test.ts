import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectSecurityDrift as detectSecurityDriftResult } from "./security-drift.js";
import { findingFingerprint } from "./contract-drift.js";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

const dirs: string[] = [];

function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "security-drift-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

/** The kept items only; the counts are asserted on `detectSecurityDriftResult` directly. */
const detectSecurityDrift = (repoDir: string, text: string) => detectSecurityDriftResult(repoDir, text).findings;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function policy(opts: { vuln?: string; supply?: string; gaps?: string } = {}): string {
  return [
    "## Security",
    "",
    "### Scope",
    "",
    "Ships a service.",
    "",
    "### Dependency and image vulnerabilities",
    "",
    opts.vuln ?? "Renovate opens dependency PRs.",
    "",
    "### Supply chain",
    "",
    opts.supply ?? "`package-lock.json` is committed.",
    "",
    "### Known gaps",
    "",
    opts.gaps ?? "None.",
    "",
  ].join("\n");
}

const IMAGE_CLAIM =
  "This repo publishes a container image and `release.yml` scans it before every push, failing on High or Critical findings not covered by `.vex/`.";
const NO_IMAGE = "This repo publishes no container image, so the image gate does not apply.";

const PUSH_WITHOUT_SCAN = "jobs:\n  release:\n    steps:\n      - run: docker build -t x .\n      - run: docker push x\n";
const PUSH_AFTER_SCAN =
  "jobs:\n  release:\n    steps:\n      - run: docker build -t x .\n      - run: scripts/ci/image-scan.sh x\n      - run: docker push x\n";

const VALID_VEX = JSON.stringify({
  "@context": "https://openvex.dev/ns/v0.2.0",
  statements: [
    {
      vulnerability: { name: "CVE-2026-0001" },
      products: [{ "@id": "pkg:oci/x" }],
      status: "not_affected",
      justification: "vulnerable_code_not_in_execute_path",
      impact_statement: "The vulnerable function is never called.",
    },
  ],
});

describe("detectSecurityDrift", () => {
  describe("image gate", () => {
    it("flags a push with no earlier scan when the policy claims an image", () => {
      const dir = repo({ ".forgejo/workflows/release.yml": PUSH_WITHOUT_SCAN });
      const drift = detectSecurityDrift(dir, policy({ vuln: IMAGE_CLAIM }));
      expect(drift).toHaveLength(1);
      expect(drift[0]).toMatchObject({ rule: "image-gate", file: ".forgejo/workflows/release.yml", line: 5 });
    });

    it("passes a push that follows a scan in the same file", () => {
      const dir = repo({ ".forgejo/workflows/release.yml": PUSH_AFTER_SCAN });
      expect(detectSecurityDrift(dir, policy({ vuln: IMAGE_CLAIM }))).toEqual([]);
    });

    it("does not count a scan mentioned only in a comment", () => {
      const dir = repo({
        ".forgejo/workflows/release.yml": "# trivy runs elsewhere\njobs:\n  r:\n    steps:\n      - uses: docker/build-push-action@" + SHA + "\n        with:\n          push: true\n",
      });
      expect(detectSecurityDrift(dir, policy({ vuln: IMAGE_CLAIM }))).toMatchObject([{ rule: "image-gate", line: 7 }]);
    });

    it("does not check workflows when the policy claims no image", () => {
      const dir = repo({ ".forgejo/workflows/release.yml": PUSH_WITHOUT_SCAN });
      expect(detectSecurityDrift(dir, policy()).filter((d) => d.rule === "image-gate")).toEqual([]);
    });
  });

  describe("undeclared image", () => {
    it("flags any push when the policy says there is no image", () => {
      const dir = repo({ ".forgejo/workflows/release.yml": PUSH_AFTER_SCAN });
      expect(detectSecurityDrift(dir, policy({ vuln: NO_IMAGE }))).toMatchObject([
        { rule: "undeclared-image", file: ".forgejo/workflows/release.yml", line: 6 },
      ]);
    });

    it("does not treat a bare registry hostname as a push", () => {
      const dir = repo({
        ".forgejo/workflows/ci.yml": "jobs:\n  t:\n    container: registry.home.bstjohn.net/st-john-software/ci:latest\n    steps:\n      - run: docker pull registry.home.bstjohn.net/x\n",
      });
      expect(detectSecurityDrift(dir, policy({ vuln: NO_IMAGE }))).toEqual([]);
    });

    it("does not fire when the policy says nothing about an image", () => {
      const dir = repo({ ".forgejo/workflows/release.yml": PUSH_WITHOUT_SCAN });
      expect(detectSecurityDrift(dir, policy())).toEqual([]);
    });
  });

  describe("SHA pinning", () => {
    const pinned = "Every CI action is SHA-pinned to a full commit.";
    const workflow = (ref: string) => `jobs:\n  t:\n    steps:\n      - uses: ${ref}\n`;

    it("flags a tag-pinned action when the Supply chain subsection claims SHA pinning", () => {
      const dir = repo({ ".forgejo/workflows/ci.yml": workflow("https://github.com/actions/checkout@v4") });
      expect(detectSecurityDrift(dir, policy({ supply: pinned }))).toMatchObject([
        { rule: "sha-pinning", file: ".forgejo/workflows/ci.yml", line: 4 },
      ]);
    });

    it("accepts the 'pinned to a commit SHA' wording", () => {
      const dir = repo({ ".forgejo/workflows/ci.yml": workflow("actions/checkout@v4") });
      expect(detectSecurityDrift(dir, policy({ supply: "Actions are pinned to a commit SHA." }))).toHaveLength(1);
    });

    it("passes SHA-pinned, local and docker:// actions", () => {
      const dir = repo({
        ".forgejo/workflows/ci.yml": `jobs:\n  t:\n    steps:\n      - uses: actions/checkout@${SHA} # v7\n      - uses: ./.github/actions/setup-nix\n      - uses: docker://alpine:3\n`,
      });
      expect(detectSecurityDrift(dir, policy({ supply: pinned }))).toEqual([]);
    });

    it("does not check pinning when the policy makes no SHA claim", () => {
      const dir = repo({ ".forgejo/workflows/ci.yml": workflow("actions/checkout@v4") });
      expect(detectSecurityDrift(dir, policy())).toEqual([]);
    });

    it("ignores a SHA claim outside the Supply chain subsection", () => {
      const dir = repo({ ".forgejo/workflows/ci.yml": workflow("actions/checkout@v4") });
      expect(detectSecurityDrift(dir, policy({ vuln: `Renovate scans. ${pinned}` }))).toEqual([]);
    });
  });

  describe("VEX", () => {
    it("flags an affected statement and invalid JSON", () => {
      const affected = JSON.parse(VALID_VEX) as { statements: Record<string, unknown>[] };
      affected.statements[0]!.status = "affected";
      const dir = repo({
        ".vex/CVE-1.json": JSON.stringify(affected),
        ".vex/CVE-2.json": "{ not json",
        ".vex/CVE-3.json": VALID_VEX,
      });
      const drift = detectSecurityDrift(dir, policy());
      expect(drift.map((d) => d.file)).toEqual([".vex/CVE-1.json", ".vex/CVE-2.json"]);
      expect(drift[0]!.message).toContain('"affected"');
      expect(drift[1]!.message).toContain("not valid JSON");
    });

    it("passes a repo with no .vex directory", () => {
      expect(detectSecurityDrift(repo({}), policy())).toEqual([]);
    });
  });

  it("drops an item a Known gaps item names by file and rule, accepted or not", () => {
    const dir = repo({
      ".forgejo/workflows/release.yml": PUSH_WITHOUT_SCAN,
      ".vex/bad.json": "{",
    });
    const gaps = "- `.forgejo/workflows/release.yml` pushes before scanning (`image-gate`).\n- Accepted: `.vex/bad.json` is a fixture (`vex`).";
    expect(detectSecurityDriftResult(dir, policy({ vuln: IMAGE_CLAIM, gaps }))).toEqual({
      findings: [],
      suppressed: 2,
      excepted: 0,
    });
  });

  it("drops an item a scanner exception covers, and still reports another rule's item on the file", () => {
    const dir = repo({
      ".forgejo/workflows/release.yml": PUSH_WITHOUT_SCAN.replace("    steps:\n", "    steps:\n      - uses: actions/checkout@v4\n"),
      ".claws/contract-exceptions.yaml": [
        "exceptions:",
        "  - contract: security",
        "    rule: image-gate",
        "    keys: [.forgejo/workflows/release.yml]",
        "    reason: Pushes a Helm chart, not an image.",
      ].join("\n"),
    });
    const result = detectSecurityDriftResult(dir, policy({ vuln: IMAGE_CLAIM, supply: "Actions are pinned to a commit SHA." }));
    expect(result.excepted).toBe(1);
    expect(result.findings).toMatchObject([{ rule: "sha-pinning", file: ".forgejo/workflows/release.yml" }]);
  });

  it("reports an invalid exceptions entry as an unsuppressible item and lets it suppress nothing", () => {
    const dir = repo({
      ".forgejo/workflows/release.yml": PUSH_WITHOUT_SCAN,
      ".claws/contract-exceptions.yaml": [
        "exceptions:",
        "  - contract: security",
        "    rule: image-gate",
        "    keys: [.forgejo/workflows/release.yml]",
        "    reason: chart",
      ].join("\n"),
    });
    const gaps = "- Accepted: `.claws/contract-exceptions.yaml` is being fixed (`contract-exceptions`).";
    const items = detectSecurityDrift(dir, policy({ vuln: IMAGE_CLAIM, gaps }));
    expect(items.map((i) => i.rule)).toEqual(["image-gate", "contract-exceptions"]);
    expect(items[1]).toMatchObject({ key: ".claws/contract-exceptions.yaml", file: ".claws/contract-exceptions.yaml" });
    expect(items[1]!.message).toContain("entry 1 needs a `reason` of at least 3 words");
  });

  it("matches a Known gaps item naming the file and the finding id", () => {
    const dir = repo({ ".vex/bad.json": "{" });
    const [item] = detectSecurityDrift(dir, policy());
    const gaps = `- \`.vex/bad.json\` is a fixture (finding \`${findingFingerprint(item!)}\`).`;
    expect(detectSecurityDriftResult(dir, policy({ gaps }))).toMatchObject({ findings: [], suppressed: 1 });
  });

  it("no longer drops an item a Known gaps item names by file only", () => {
    const dir = repo({
      ".forgejo/workflows/release.yml": PUSH_WITHOUT_SCAN,
      ".vex/bad.json": "{",
    });
    const gaps = "- `.forgejo/workflows/release.yml` pushes before scanning.\n- Accepted: `.vex/bad.json` is a fixture.";
    const result = detectSecurityDriftResult(dir, policy({ vuln: IMAGE_CLAIM, gaps }));
    expect(result.findings).toMatchObject([{ rule: "image-gate" }, { rule: "vex" }]);
    expect(result).toMatchObject({ suppressed: 0, excepted: 0 });
  });

  it("finds no drift in Claws' own policy", () => {
    const cwd = process.cwd();
    const text = fs.readFileSync(path.join(cwd, "docs", "security.md"), "utf-8");
    expect(detectSecurityDrift(cwd, text)).toEqual([]);
  });
});
