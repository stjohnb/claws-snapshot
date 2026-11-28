import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), { WORK_DIR: "/tmp/claws-test", SELF_REPO: "St-John-Software/claws" }));
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./error-reporter.js", () => ({ reportError: vi.fn() }));
vi.mock("./claude.js", () => ({ repoDir: vi.fn(), ensureClone: vi.fn() }));
vi.mock("./github.js", () => ({}));
vi.mock("./claws-issues.js", () => ({}));

import { BASELINE_SCANNER_SPECS } from "./jobs/baseline-scanners.js";
import { HOST_POLICY_MARKDOWN } from "./host-policy.js";
import { CREATE_REPO_FILE_PATHS } from "./claws-state-tools.js";
import {
  buildRepoSeed,
  CALLER_SEED_PATHS,
  SEED_KINDS,
  SEED_PATHS,
  staticObservabilityPolicy,
  staticSecurityPolicy,
  validateSeedTree,
  type RepoSeedInput,
} from "./repo-seed.js";
import { SEEDED_POLICY_MARKER } from "./seeded-policy.js";

const base: RepoSeedInput = { fullName: "St-John-Software/spotter", url: "https://git.example/St-John-Software/spotter", description: "Gym app" };

describe("buildRepoSeed", () => {
  it("seeds every seed path, and the static seed passes every baseline check", () => {
    const seed = buildRepoSeed(base);
    expect(Object.keys(seed.files).sort()).toEqual([...SEED_PATHS].sort());
    expect(seed.fallbacks).toEqual([]);
    expect(validateSeedTree(seed.files, base.fullName)).toEqual([]);
    expect(seed.files["AGENTS.md"]).toContain(HOST_POLICY_MARKDOWN);
    expect(JSON.parse(seed.files["claws.json"]!)).toMatchObject({ enabled: true, description: "Gym app", avatar: "docs/avatar.svg" });
    expect(seed.files["docs/avatar.svg"]).toContain(">S</text>");
    expect(seed.files["docs/observability.md"]).toContain(SEEDED_POLICY_MARKER);
    expect(seed.files["docs/security.md"]).toContain(SEEDED_POLICY_MARKER);
  });

  it.each(SEED_KINDS)("the static seed for kind %s passes every baseline check", (kind) => {
    const seed = buildRepoSeed({ ...base, kind });
    expect(seed.fallbacks).toEqual([]);
    expect(validateSeedTree(seed.files, base.fullName)).toEqual([]);
    expect(seed.files["docs/security.md"]).toContain("### Rules for new changes");
    expect(seed.files["AGENTS.md"]).toContain(`\`${kind}\``);
  });

  it("the purpose-free static policies pass for every kind, so the last fallback always holds", () => {
    for (const kind of [null, ...SEED_KINDS]) {
      const files = { ...buildRepoSeed(base).files, "docs/observability.md": staticObservabilityPolicy(), "docs/security.md": staticSecurityPolicy(kind) };
      expect(validateSeedTree(files, base.fullName)).toEqual([]);
    }
  });

  it("puts a purpose brief into AGENTS.md and the policies, with heading marks stripped", () => {
    const purpose = "## Overview\nA static web app deployed to k3s plus a native iOS app; no backend, all data on the device.";
    const seed = buildRepoSeed({ ...base, kind: "static-site", purpose, issue: { id: "clw_01M86FCQ926VHN9JS4KATWN4J7", title: "Build HR leaderboard" } });
    expect(seed.fallbacks).toEqual([]);
    expect(seed.files["AGENTS.md"]).toContain("## What this repo is for");
    expect(seed.files["AGENTS.md"]).not.toContain("## Overview");
    expect(seed.files["AGENTS.md"]).toContain("#clw_01M86FCQ926VHN9JS4KATWN4J7: Build HR leaderboard");
    expect(seed.files["docs/observability.md"]).toContain("Planned, not built yet: Overview");
    expect(seed.files["docs/security.md"]).toContain("Planned, not built yet:");
    expect(validateSeedTree(seed.files, base.fullName)).toEqual([]);
  });

  it("a purpose saying it ships a container image still yields a passing tree", () => {
    const seed = buildRepoSeed({ ...base, kind: "container-service", purpose: "An API that ships a container image to the home cluster." });
    expect(validateSeedTree(seed.files, base.fullName)).toEqual([]);
  });

  it("drops a purpose whose text fails a rule from that policy, and reports it", () => {
    const seed = buildRepoSeed({ ...base, purpose: "Dashboards live in `apps/monitoring/dashboards/spotter.yaml`." });
    expect(seed.files["docs/observability.md"]).toBe(staticObservabilityPolicy());
    expect(seed.fallbacks.map((f) => f.path)).toContain("docs/observability.md");
    expect(validateSeedTree(seed.files, base.fullName)).toEqual([]);
  });

  it("falls back from a caller policy left with a TODO(security) placeholder, naming the failed rules", () => {
    const callerPolicy = staticSecurityPolicy().replace(`> ${SEEDED_POLICY_MARKER}\n`, "").replace("None: the repository uses no secrets, tokens or credentials.", "TODO(security): which secrets");
    const seed = buildRepoSeed({ ...base, files: { "docs/security.md": callerPolicy } });
    expect(seed.files["docs/security.md"]).toBe(staticSecurityPolicy());
    const fallback = seed.fallbacks.find((f) => f.path === "docs/security.md");
    expect(fallback?.reasons.join("\n")).toContain("no-placeholders");
    expect(validateSeedTree(seed.files, base.fullName)).toEqual([]);
  });

  it("keeps a passing caller policy, inserting the seed note after its first heading", () => {
    const caller = "# Observability\n\nThis repo emits no runtime telemetry.\n\nThe iOS app will log through os_log only.\n\n### Known gaps\n\nNone.\n";
    const seed = buildRepoSeed({ ...base, files: { "docs/observability.md": caller } });
    expect(seed.fallbacks).toEqual([]);
    expect(seed.files["docs/observability.md"]).toBe(`# Observability\n\n> ${SEEDED_POLICY_MARKER}\n\nThis repo emits no runtime telemetry.\n\nThe iOS app will log through os_log only.\n\n### Known gaps\n\nNone.\n`);
  });

  it("uses a caller role document unless it is empty", () => {
    const seed = buildRepoSeed({ ...base, files: { ".agents/pr-reviewer.md": "---\nname: pr-reviewer\n---\nCheck offline support.\n", ".agents/issue-refiner.md": "  " } });
    expect(seed.files[".agents/pr-reviewer.md"]).toContain("Check offline support.");
    expect(seed.files[".agents/issue-refiner.md"]).toContain("name: issue-refiner");
    expect(seed.fallbacks).toEqual([{ path: ".agents/issue-refiner.md", reasons: ["file is empty"] }]);
  });

  it("validateSeedTree names the scanner a missing file trips", () => {
    const files = { ...buildRepoSeed(base).files };
    delete files[".agents/pr-reviewer.md"];
    expect(validateSeedTree(files).map((p) => p.reason).join("\n")).toContain("claude-config-scanner");
  });
});

it("claws_create_repo offers exactly the caller seed paths the server accepts", () => {
  expect([...CREATE_REPO_FILE_PATHS]).toEqual([...CALLER_SEED_PATHS]);
});

describe("BASELINE_SCANNER_SPECS", () => {
  it("lists every ScannerSpec a src/jobs module declares", async () => {
    const jobsDir = path.join(__dirname, "jobs");
    const declaring = fs.readdirSync(jobsDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "scanner-runner.ts")
      .filter((f) => /:\s*ScannerSpec\s*=/.test(fs.readFileSync(path.join(jobsDir, f), "utf-8")));
    expect(declaring.length).toBeGreaterThanOrEqual(11);
    for (const file of declaring) {
      const mod = (await import(/* @vite-ignore */ path.join(jobsDir, file))) as Record<string, unknown>;
      const specs = Object.values(mod).filter((v): v is { scan: unknown } => typeof v === "object" && v !== null && typeof (v as { scan?: unknown }).scan === "function");
      expect(specs.length, `${file} must export its ScannerSpec`).toBeGreaterThan(0);
      for (const spec of specs) expect(BASELINE_SCANNER_SPECS, `${file}'s ScannerSpec is missing from BASELINE_SCANNER_SPECS`).toContain(spec);
    }
  });
});
