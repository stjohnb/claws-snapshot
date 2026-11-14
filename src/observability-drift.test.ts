import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({ WORK_DIR: "/tmp/claws-test", SELF_REPO: "St-John-Software/claws" }));
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./error-reporter.js", () => ({ reportError: vi.fn() }));
vi.mock("./claude.js", () => ({ repoDir: vi.fn(), ensureClone: vi.fn() }));
vi.mock("./github.js", () => ({}));
vi.mock("./claws-issues.js", () => ({}));

import {
  OBSERVABILITY_DRIFT_RULES,
  detectObservabilityDrift,
  infoDroppingLine,
  policyAlertReferences,
  policyPathTokens,
  type InfraClones,
  type ObservabilityDriftContext,
} from "./observability-drift.js";
import { NO_TELEMETRY_SENTENCE } from "./observability-contract.js";

const tmpDirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-drift-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function rule(id: string) {
  const r = OBSERVABILITY_DRIFT_RULES.find((x) => x.id === id);
  if (!r) throw new Error(`no rule ${id}`);
  return r;
}

function check(id: string, ctx: ObservabilityDriftContext) {
  return rule(id).check(ctx);
}

const LOGGING_POLICY = "# Observability\n\nLogs: one JSON object per line on stdout through `src/log.ts`.\n\n## Known gaps\n\nNone.\n";

describe("no-telemetry-service", () => {
  const policy = `## Observability\n\n${NO_TELEMETRY_SENTENCE}\n\n### Known gaps\n\nNone.\n`;

  it("fires when a no-telemetry repo ships a service", () => {
    const repoDir = fixture({ Dockerfile: "FROM node:22\n", "package.json": "{}" });
    const result = check("no-telemetry-service", { repoDir, policy, infra: null });
    expect(result).toEqual([expect.objectContaining({ rule: "no-telemetry-service", key: "Dockerfile", file: "Dockerfile" })]);
  });

  it("does not fire for a library", () => {
    const repoDir = fixture({ "package.json": JSON.stringify({ name: "lib" }) });
    expect(check("no-telemetry-service", { repoDir, policy, infra: null })).toEqual([]);
  });

  it("does not fire when the policy makes no no-telemetry claim", () => {
    const repoDir = fixture({ Dockerfile: "FROM node:22\n" });
    expect(check("no-telemetry-service", { repoDir, policy: LOGGING_POLICY, infra: null })).toEqual([]);
  });
});

describe("console-bypass", () => {
  const files = {
    "src/log.ts": "export const log = () => console.log('x');\n",
    "src/server.ts": "import x from 'y';\n\nconsole.log('a');\nconsole.error('b');\n",
    "src/server.test.ts": "console.log('t');\n",
    "src/tools/cli.ts": "console.log('cli');\n",
    "src/client/app.ts": "console.log('browser');\n",
    "scripts/deploy.ts": "console.log('s');\n",
  };

  it("reports one finding per file with its first line, exempting tests, the named logger and tool dirs", () => {
    const repoDir = fixture(files);
    const result = check("console-bypass", { repoDir, policy: LOGGING_POLICY, infra: null });
    expect(result).toEqual([
      expect.objectContaining({ rule: "console-bypass", key: "src/server.ts", file: "src/server.ts", line: 3 }),
    ]);
    expect((result as { message: string }[])[0]!.message).toContain("2 call(s)");
  });

  it("does not fire when the policy claims no JSON logging and names no logger", () => {
    const repoDir = fixture(files);
    const policy = "# Observability\n\nScope: a CLI that prints to the terminal.\n\n## Known gaps\n\nNone.\n";
    expect(check("console-bypass", { repoDir, policy, infra: null })).toEqual([]);
  });

  it("is suppressed by a Known gaps item naming the file and the rule", () => {
    const repoDir = fixture({ "src/log.ts": "", "src/server.ts": "console.log('a');\n" });
    const policy = LOGGING_POLICY.replace("None.", "- `src/server.ts` still logs with console (drift rule `console-bypass`).");
    const result = detectObservabilityDrift(repoDir, policy, null);
    expect(result.findings).toEqual([]);
    expect(result).toMatchObject({ suppressed: 1, excepted: 0 });
  });

  it("is suppressed by an accepted Known gaps item too", () => {
    const repoDir = fixture({ "src/log.ts": "", "src/server.ts": "console.log('a');\n" });
    const policy = LOGGING_POLICY.replace("None.", "- Accepted: `src/server.ts` prints its banner (`console-bypass`).");
    expect(detectObservabilityDrift(repoDir, policy, null).findings).toEqual([]);
  });

  it("is not suppressed by a Known gaps item naming only the file", () => {
    const repoDir = fixture({ "src/log.ts": "", "src/server.ts": "console.log('a');\n" });
    const policy = LOGGING_POLICY.replace("None.", "- `src/server.ts` still logs with console.");
    const result = detectObservabilityDrift(repoDir, policy, null);
    expect(result.findings).toMatchObject([{ rule: "console-bypass", key: "src/server.ts" }]);
    expect(result).toMatchObject({ suppressed: 0, excepted: 0 });
  });

  it("is suppressed by a scanner exception for the rule and file", () => {
    const repoDir = fixture({
      "src/log.ts": "",
      "src/server.ts": "console.log('a');\n",
      ".claws/contract-exceptions.yaml":
        "exceptions:\n  - contract: observability\n    rule: console-bypass\n    keys: [src/server.ts]\n    reason: Browser bundle entry, exempt here.\n",
    });
    const result = detectObservabilityDrift(repoDir, LOGGING_POLICY, null);
    expect(result.findings).toEqual([]);
    expect(result.excepted).toBe(1);
  });

  it("reports an invalid exceptions entry, which suppresses nothing", () => {
    const repoDir = fixture({
      "src/log.ts": "",
      "src/server.ts": "console.log('a');\n",
      ".claws/contract-exceptions.yaml":
        "exceptions:\n  - contract: observability\n    rule: console-bypas\n    keys: [src/server.ts]\n    reason: Browser bundle entry, exempt here.\n",
    });
    const result = detectObservabilityDrift(repoDir, LOGGING_POLICY, null);
    expect(result.findings.map((f) => [f.rule, f.key])).toEqual([
      ["console-bypass", "src/server.ts"],
      ["contract-exceptions", ".claws/contract-exceptions.yaml"],
    ]);
    expect(result.excepted).toBe(0);
  });
});

describe("named-path-missing", () => {
  it("flags a repo-local path that does not exist and passes one that does", () => {
    const repoDir = fixture({ "src/log.ts": "" });
    const policy = "Logs through `src/log.ts` and `src/metrics.ts`; queries look like `{app=\"x\"} | json`.";
    const infra: InfraClones = { fleetInfra: fixture({}), productionInfra: fixture({}) };
    const result = check("named-path-missing", { repoDir, policy, infra });
    expect(result).toEqual([expect.objectContaining({ rule: "named-path-missing", key: "src/metrics.ts" })]);
    expect((result as { message: string }[])[0]!.message).toContain("this repo, fleet-infra or production-infra");
  });

  it("resolves monitoring paths in the infra clones", () => {
    const repoDir = fixture({});
    const fleet = fixture({ "apps/monitoring/dashboards/x.yaml": "uid: x" });
    const prod = fixture({});
    const infra: InfraClones = { fleetInfra: fleet, productionInfra: prod };
    const policy =
      "Dashboard `apps/monitoring/dashboards/x.yaml`; prod board `infrastructure/prod/observability/dashboards/y.json`.";
    const result = check("named-path-missing", { repoDir, policy, infra });
    expect(result).toEqual([
      expect.objectContaining({ key: "infrastructure/prod/observability/dashboards/y.json" }),
    ]);
    expect((result as { message: string }[])[0]!.message).toContain("production-infra");
  });

  it("is unavailable when the clone a path needs is absent", () => {
    const repoDir = fixture({});
    const policy = "Dashboard `apps/monitoring/dashboards/x.yaml`.";
    expect(check("named-path-missing", { repoDir, policy, infra: null })).toEqual({ unavailable: expect.stringContaining("fleet-infra") });
    const prodOnly = fixture({});
    expect(check("named-path-missing", { repoDir, policy, infra: { fleetInfra: null, productionInfra: prodOnly } })).toEqual({
      unavailable: expect.stringContaining("fleet-infra"),
    });
  });

  it("resolves a repo-qualified non-prefix path in the named infra clone", () => {
    const repoDir = fixture({});
    const fleet = fixture({});
    const prod = fixture({ "apps/plausible/goals.sql": "" });
    const infra: InfraClones = { fleetInfra: fleet, productionInfra: prod };
    const policy = "Goals in production-infra `apps/plausible/goals.sql`; probes in fleet-infra `apps/gatus/config.yaml`.";
    const result = check("named-path-missing", { repoDir, policy, infra });
    expect(result).toEqual([expect.objectContaining({ key: "apps/gatus/config.yaml" })]);
    expect((result as { message: string }[])[0]!.message).toContain("fleet-infra");
  });

  it("still resolves an unqualified non-prefix path in this repo", () => {
    const repoDir = fixture({ "apps/x/a.yaml": "" });
    const infra: InfraClones = { fleetInfra: fixture({}), productionInfra: fixture({}) };
    expect(check("named-path-missing", { repoDir, policy: "See `apps/x/a.yaml`.", infra })).toEqual([]);
  });

  it("is unavailable when the clone a qualified path names is absent", () => {
    const repoDir = fixture({});
    const policy = "Probes in fleet-infra `apps/gatus/config.yaml`.";
    const infra: InfraClones = { fleetInfra: null, productionInfra: fixture({}) };
    expect(check("named-path-missing", { repoDir, policy, infra })).toEqual({ unavailable: expect.stringContaining("fleet-infra") });
  });

  it("finds unqualified infra paths, directories and globs in the infra clones", () => {
    const repoDir = fixture({});
    const fleet = fixture({ "apps/gatus/config.yaml": "" });
    const prod = fixture({
      "config/prod/observability/prometheus-rules.yaml": "",
      "apps/plausible/plausible-goals.sql": "",
      "apps/bonkus/prod/otel-config.yaml": "",
    });
    const infra: InfraClones = { fleetInfra: fleet, productionInfra: prod };
    const policy =
      "`apps/gatus/config.yaml` `config/prod/observability/prometheus-rules.yaml` `apps/plausible/plausible-goals.sql` `apps/plausible/` `apps/bonkus/prod/*.yaml`";
    expect(check("named-path-missing", { repoDir, policy, infra })).toEqual([]);
  });

  it("flags a missing directory or glob naming every repo checked", () => {
    const infra: InfraClones = { fleetInfra: fixture({}), productionInfra: fixture({ "apps/plausible/a.sql": "" }) };
    const result = check("named-path-missing", {
      repoDir: fixture({}),
      policy: "`apps/missing/` `apps/bonkus/prod/*.yaml` `apps/plausible/`",
      infra,
    }) as { key: string; message: string }[];
    expect(result.map((f) => f.key)).toEqual(["apps/missing/", "apps/bonkus/prod/*.yaml"]);
    expect(result[1]!.message).toContain("this repo, fleet-infra or production-infra");
  });

  it("resolves the repo-colon form only in the named clone", () => {
    const infra: InfraClones = { fleetInfra: fixture({ "apps/bonkus/prod/servicemonitor.yaml": "" }), productionInfra: fixture({}) };
    const result = check("named-path-missing", {
      repoDir: fixture({}),
      policy: "`production-infra:apps/bonkus/prod/servicemonitor.yaml`",
      infra,
    }) as { key: string; message: string }[];
    expect(result).toEqual([expect.objectContaining({ key: "apps/bonkus/prod/servicemonitor.yaml" })]);
    expect(result[0]!.message).toContain("production-infra");
  });

  it("is unavailable for an unqualified path missing locally with no clones, and passes one present locally", () => {
    expect(check("named-path-missing", { repoDir: fixture({}), policy: "`src/a.ts`", infra: null })).toEqual({
      unavailable: expect.stringContaining("fleet-infra"),
    });
    expect(check("named-path-missing", { repoDir: fixture({ "src/a.ts": "" }), policy: "`src/a.ts`", infra: null })).toEqual([]);
  });

  it("does not treat version-like last segments as paths", () => {
    expect(
      check("named-path-missing", { repoDir: fixture({}), policy: "UA `curl/8.6.0` and `Mozilla/5.0`", infra: null }),
    ).toEqual([]);
  });

  it("resolves a managed-repo prefix against that repo's clone", () => {
    const repoClones = new Map<string, string | null>([["claws", fixture({ "src/jobs/x.ts": "" })]]);
    const run = (policy: string) =>
      check("named-path-missing", { repoDir: fixture({}), policy, infra: null, repoClones }) as { key: string; message: string }[];
    expect(run("`claws:src/jobs/x.ts`")).toEqual([]);
    expect(run("`St-John-Software/claws:src/jobs/x.ts`")).toEqual([]);
    const missing = run("`claws:src/jobs/y.ts`");
    expect(missing).toEqual([expect.objectContaining({ key: "src/jobs/y.ts" })]);
    expect(missing[0]!.message).toContain("claws");
  });

  it("skips a prefix naming no managed repo and is unavailable for an absent clone", () => {
    const repoClones = new Map<string, string | null>([["claws", null]]);
    const run = (policy: string) => check("named-path-missing", { repoDir: fixture({}), policy, infra: null, repoClones });
    expect(run("`localhost:9090/x.json`")).toEqual([]);
    expect(run("`claws:src/a.ts`")).toEqual({ unavailable: expect.stringContaining("claws clone is absent") });
  });

  it("ignores a bare slash-less, extension-less token", () => {
    expect(check("named-path-missing", { repoDir: fixture({}), policy: "`lib/logging`", infra: null })).toEqual([]);
  });

  it("ignores placeholders, globs, absolute paths, fenced code and tokens without an extension", () => {
    expect(
      policyPathTokens(
        [
          "`apps/monitoring/dashboards/<name>.yaml` `src/*.ts` `/usr/share/x.conf` `src/jobs` `https://x.org/a.md` `./docs/a.md`",
          "```ts",
          "import x from `src/fenced.ts`;",
          "```",
        ].join("\n"),
      ),
    ).toEqual(["docs/a.md"]);
  });
});

describe("alert-reference-missing", () => {
  const policy = "The rule (uid `x-error-logs`) sets `claws_service: x-svc`, and `claws_alertname` label, `X error: <component>`.";

  it("collects uids and claws label values, skipping templated ones", () => {
    expect(policyAlertReferences(policy)).toEqual([
      { kind: "uid", value: "x-error-logs" },
      { kind: "label", value: "x-svc" },
    ]);
    expect(policyAlertReferences("Set the `claws_service` value its alert rules set.")).toEqual([]);
    expect(policyAlertReferences("Rules set `claws_service=\"x-svc\"`.")).toEqual([{ kind: "label", value: "x-svc" }]);
  });

  it("passes when every reference appears in a monitoring file", () => {
    const fleet = fixture({ "apps/monitoring/kube-prometheus-stack.yaml": "- uid: x-error-logs\n  labels:\n    claws_service: x-svc\n" });
    const prod = fixture({});
    expect(check("alert-reference-missing", { repoDir: fixture({}), policy, infra: { fleetInfra: fleet, productionInfra: prod } })).toEqual([]);
  });

  it("fires for a reference no monitoring file mentions", () => {
    const fleet = fixture({ "apps/monitoring/kube-prometheus-stack.yaml": "- uid: x-error-logs\n" });
    const prod = fixture({ "infrastructure/prod/observability/rules.yaml": "nothing" });
    // A file outside the monitoring dirs does not count.
    fs.writeFileSync(path.join(fleet, "README.md"), "x-svc");
    const result = check("alert-reference-missing", { repoDir: fixture({}), policy, infra: { fleetInfra: fleet, productionInfra: prod } });
    expect(result).toEqual([expect.objectContaining({ rule: "alert-reference-missing", key: "x-svc" })]);
  });

  it("is unavailable when a reference is missing and a clone is absent", () => {
    const fleet = fixture({ "apps/monitoring/a.yaml": "- uid: x-error-logs\n" });
    expect(check("alert-reference-missing", { repoDir: fixture({}), policy, infra: { fleetInfra: fleet, productionInfra: null } })).toEqual({
      unavailable: expect.stringContaining("production-infra"),
    });
  });

  it("does not fire, and needs no clone, when the policy names no references", () => {
    expect(check("alert-reference-missing", { repoDir: fixture({}), policy: "No alerts.", infra: null })).toEqual([]);
  });
});

describe("info-dropped", () => {
  const policy = "Every action logs one `info` line, and every `info` line reaches Loki.";

  it("fires on a config that sets LOG_LEVEL above info", () => {
    const repoDir = fixture({
      "k8s/deployment.yaml": "env:\n  - name: LOG_LEVEL\n    value: warn\n",
      ".env.production": "LOG_LEVEL=error\n",
      "config/app.json": "{\n  \"logging\": {\n    \"level\": \"error\"\n  }\n}\n",
    });
    const result = check("info-dropped", { repoDir, policy, infra: null }) as { key: string; line: number }[];
    expect(result.map((f) => [f.key, f.line]).sort()).toEqual([
      [".env.production", 1],
      ["config/app.json", 3],
      ["k8s/deployment.yaml", 2],
    ]);
  });

  it("ignores test and doc configs, info levels and non-log level keys", () => {
    const repoDir = fixture({
      "docs/example.yaml": "LOG_LEVEL: warn\n",
      "test/fixture.yaml": "LOG_LEVEL: warn\n",
      "config/app.yaml": "LOG_LEVEL: info\n",
      "alerts.yaml": "severity:\n  level: error\n",
    });
    expect(check("info-dropped", { repoDir, policy, infra: null })).toEqual([]);
  });

  it("does not fire when the policy makes no shipping claim", () => {
    const repoDir = fixture({ ".env": "LOG_LEVEL=warn\n" });
    expect(check("info-dropped", { repoDir, policy: "We log things.", infra: null })).toEqual([]);
  });

  it("finds the dropping line", () => {
    expect(infoDroppingLine("a: 1\nlogLevel: \"fatal\"\n")).toBe(2);
    expect(infoDroppingLine("LOG_LEVEL=debug\n")).toBeNull();
  });
});

describe("detectObservabilityDrift", () => {
  it("reports unavailable rules alongside findings from the rest", () => {
    const repoDir = fixture({ "src/log.ts": "", "src/server.ts": "console.log('a');\n" });
    const policy = `${LOGGING_POLICY}\nDashboard \`apps/monitoring/dashboards/x.yaml\`.\n`;
    const result = detectObservabilityDrift(repoDir, policy, null);
    expect(result.unavailable).toEqual([{ rule: "named-path-missing", reason: expect.stringContaining("fleet-infra") }]);
    expect(result.findings.map((f) => f.rule)).toEqual(["console-bypass"]);
  });

  it("suppresses a missing glob or dir token named in Known gaps", () => {
    const infra: InfraClones = { fleetInfra: fixture({}), productionInfra: fixture({}) };
    const policy = "# Obs\n\n### Known gaps\n\n- `apps/bonkus/prod/*.yaml` and `apps/missing/` are not written yet (`named-path-missing`).\n";
    const result = detectObservabilityDrift(fixture({}), policy, infra);
    expect(result.findings.filter((f) => f.rule === "named-path-missing")).toEqual([]);
  });
});

describe("Claws' own policy", () => {
  const repoDir = process.cwd();
  const policy = fs.readFileSync(path.join(repoDir, "docs/observability.md"), "utf-8");
  const ctx: ObservabilityDriftContext = { repoDir, policy, infra: null };

  it.each(["no-telemetry-service", "console-bypass", "info-dropped"])("has no %s drift", (id) => {
    expect(check(id, ctx)).toEqual([]);
  });

  it("names only repo-local paths that exist", () => {
    const local = policyPathTokens(policy).filter(
      (p) => !p.startsWith("apps/monitoring/") && !p.startsWith("infrastructure/prod/observability/"),
    );
    expect(local.length).toBeGreaterThan(0);
    expect(local.filter((p) => !fs.existsSync(path.join(repoDir, p)))).toEqual([]);
  });
});
