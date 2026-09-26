import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  delete process.env["CLAWS_GITHUB_OWNERS"];
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
        githubOwners: ["owner1"],
        selfRepo: "owner1/repo1",
      }),
    );

    const display = getConfigForDisplay();

    // Sensitive fields should be masked (last 4 chars visible)
    expect(display.slackWebhook).toBe("****cdef");
    expect(display.openaiApiKey).toBe("****8765");

    // Non-sensitive fields should be shown as-is
    expect(display.githubOwners).toEqual(["owner1"]);
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

  it("writeConfig reads, merges, and writes config.json correctly", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(
      cp,
      JSON.stringify({ selfRepo: "old/repo", logRetentionDays: 7 }),
    );

    writeConfig({ selfRepo: "new/repo", logRetentionDays: 30 });

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

    writeConfig({ slackWebhook: "", openaiApiKey: "", selfRepo: "new/repo" });

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

    writeConfig({ intervals: { issueWorkerMs: 120000 } });

    const written = JSON.parse(fs.readFileSync(cp, "utf-8"));
    expect(written.intervals.issueWorkerMs).toBe(120000);
    expect(written.intervals.ciFixerMs).toBe(600000); // preserved
  });

  it("writeConfig handles missing config.json gracefully", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    // Ensure config.json does not exist
    try { fs.unlinkSync(cp); } catch { /* ok */ }

    writeConfig({ selfRepo: "fresh/repo" });

    const written = JSON.parse(fs.readFileSync(cp, "utf-8"));
    expect(written.selfRepo).toBe("fresh/repo");
  });

  it("writeConfig creates config.json with mode 0o600", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    // Ensure config.json does not exist
    try { fs.unlinkSync(cp); } catch { /* ok */ }

    writeConfig({ selfRepo: "fresh/repo" });

    const stats = fs.statSync(cp);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("writeConfig tightens pre-existing config.json with loose permissions", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({ selfRepo: "old/repo" }), { mode: 0o644 });

    writeConfig({ logRetentionDays: 30 });

    const stats = fs.statSync(cp);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("removeConfigKeys creates config.json with mode 0o600", async () => {
    const { removeConfigKeys, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({ selfRepo: "repo", slackBotToken: "token", openaiApiKey: "key" }));

    removeConfigKeys(["slackBotToken"]);

    const stats = fs.statSync(cp);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("removeConfigKeys tightens pre-existing config.json with loose permissions", async () => {
    const { removeConfigKeys, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({ selfRepo: "repo", slackBotToken: "token" }), { mode: 0o644 });

    removeConfigKeys(["slackBotToken"]);

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

    writeConfig({ logRetentionDays: 30 });

    const written = JSON.parse(fs.readFileSync(cp, "utf-8"));
    expect(written.selfRepo).toBe("owner1/repo1");
    expect(written.logRetentionDays).toBe(30);
    expect(written).not.toHaveProperty("k3sMonitorEnabled");
    expect(written).not.toHaveProperty("prodK8sMonitorEnabled");
    expect(written).not.toHaveProperty("prodK8sKubeconfigRefresh");
    expect(written).not.toHaveProperty("issueTracker");
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

    config.writeConfig({ activationState: "verify-only" });

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

    config.writeConfig({ activationState: "staging" });

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

    config.writeConfig({ activationState: "staging" });

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

    config.writeConfig({ activationState: "active" });

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

  it("defaults the fable tier to each provider's best model, honouring overrides", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    mod.reloadConfig();

    expect(mod.CLAUDE_FABLE_MODEL).toBe("fable");
    expect(mod.CODEX_FABLE_MODEL).toBe(mod.CODEX_DEFAULT_MODEL);
    expect(mod.OPENCODE_FABLE_MODEL).toBe(mod.OPENCODE_BEST_MODEL);

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

    process.env["CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES"] = "not-a-number";
    try {
      mod.reloadConfig();
      expect(mod.CLAUDE_WORKER_MEMORY_MAX_BYTES).toBe(2_147_483_648);
    } finally {
      delete process.env["CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES"];
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

  it("defaults AI_PROVIDERS to Claude:Codex:OpenCode weights 4:2:1", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    mod.reloadConfig();

    expect(mod.AI_PROVIDERS).toEqual({
      claude: { enabled: true, weight: 4 },
      codex: { enabled: true, weight: 2 },
      opencode: { enabled: true, weight: 1 },
    });
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
      opencode: { enabled: true, weight: 1 },
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
    });
  });

  it("keeps invalid weights in config, warns, and leaves selector eligibility to model-selector", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ aiProviders: { claude: { enabled: true, weight: 0 }, codex: { enabled: true, weight: -1 }, opencode: { enabled: true, weight: 1 } } }),
    );

    mod.reloadConfig();

    expect(mod.AI_PROVIDERS.claude).toEqual({ enabled: true, weight: 0 });
    expect(mod.AI_PROVIDERS.codex).toEqual({ enabled: true, weight: -1 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("aiProviders.claude.weight"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("aiProviders.codex.weight"));
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
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("aiProviders.claude.weight"));
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

    mod.writeConfig({ aiProviders: { claude: { enabled: true, weight: 4 }, codex: { enabled: false, weight: 2 }, opencode: { enabled: false, weight: 1 } } });

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

    mod.writeConfig({ logRetentionDays: 99 });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("preserves prototype-property LAN targets: %s", async (key) => {
    const mod = await import("./config.js");
    const byHost = { host: `${key}.local`, user: "explicit" };
    const byName = { host: "unknown.local", name: key };
    expect(mod.resolveLanHost(byHost)).toBe(byHost);
    expect(mod.resolveLanHost(byName)).toBe(byName);
  });

  it("keeps concrete LAN addresses inside approved snapshot scrub files", async () => {
    const mod = await import("./config.js");
    const { buildEnvForGh } = await import("./github-app.js");
    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    mod.reloadConfig();

    const approvedPaths = ["src/config.ts", "src/jobs/runner-monitor.test.ts"];
    const pair = mod.PUBLIC_SNAPSHOTS.find((p) => p.source === "St-John-Software/claws");
    expect(pair?.scrubPaths).toEqual(expect.arrayContaining(approvedPaths));

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
  });

  it("preserves unknown LAN targets", async () => {
    const mod = await import("./config.js");
    expect(mod.resolveLanHost({ host: "unknown.local", user: "explicit" })).toEqual({ host: "unknown.local", user: "explicit" });
  });
});

describe("getIgnoredAdvisoriesForRepo", () => {
  it("merges '*' global list with per-repo list", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        dependabotIgnoredAdvisories: {
          "*": ["GHSA-aaaa-0000-0001"],
          "owner/repo": ["GHSA-bbbb-0000-0002"],
        },
      }),
    );

    mod.reloadConfig();
    const result = mod.getIgnoredAdvisoriesForRepo("owner/repo");

    expect(result).toEqual(new Set(["ghsa-aaaa-0000-0001", "ghsa-bbbb-0000-0002"]));
  });

  it("returns only global list when no repo-specific key", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        dependabotIgnoredAdvisories: {
          "*": ["GHSA-cccc-0000-0003"],
        },
      }),
    );

    mod.reloadConfig();
    const result = mod.getIgnoredAdvisoriesForRepo("owner/other-repo");

    expect(result).toEqual(new Set(["ghsa-cccc-0000-0003"]));
  });

  it("returns empty set when neither '*' nor repo key present", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    mod.reloadConfig();
    const result = mod.getIgnoredAdvisoriesForRepo("owner/repo");

    expect(result).toEqual(new Set());
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
    expect(mod.isForgejoRepo("St-John-Software/perudo")).toBe(false);
    expect(mod.isForgejoRepo("St-John-Software/claws")).toBe(false);
  });

  it("reads the repo list from the CLAWS_FORGEJO_REPOS emergency override, case-insensitively", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    process.env["CLAWS_FORGEJO_REPOS"] = "Owner/Migrated";
    mod.reloadConfig();

    expect(mod.isForgejoRepo("Owner/Migrated")).toBe(true);
    expect(mod.isForgejoRepo("owner/migrated")).toBe(true);
    expect(mod.isForgejoRepo("OWNER/MIGRATED")).toBe(true);
    expect(mod.isForgejoRepo("St-John-Software/perudo")).toBe(false);
  });

  it("lets CLAWS_FORGEJO_REPOS override the empty default, comma-split and trimmed", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    process.env["CLAWS_FORGEJO_REPOS"] = " owner/one , owner/two ";
    mod.reloadConfig();

    expect(mod.FORGEJO_REPOS).toEqual(["owner/one", "owner/two"]);
    expect(mod.isForgejoRepo("owner/from-file")).toBe(false);
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

  it("masks the read token in getConfigForDisplay (#3152)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ forgejoReadToken: "file-read" }));
    mod.reloadConfig();

    const display = mod.getConfigForDisplay();
    expect(display.forgejoReadToken).not.toBe("file-read");
    expect(display.forgejoReadToken).toMatch(/^\*\*\*\*/);
  });

  it("treats a discovered-but-unconfigured repo as a Forgejo repo, case-insensitively (#2885)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    mod.reloadConfig();
    expect(mod.isForgejoRepo("Owner/Discovered")).toBe(false);

    mod.registerDiscoveredForgejoRepos(["Owner/Discovered"]);
    expect(mod.isForgejoRepo("Owner/Discovered")).toBe(true);
    expect(mod.isForgejoRepo("owner/discovered")).toBe(true);

    mod.clearDiscoveredForgejoRepos();
    expect(mod.isForgejoRepo("Owner/Discovered")).toBe(false);
  });

  it("hasForgejoRepoForOwner matches discovered and override repos by owner, case-insensitively (#3067)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    process.env["CLAWS_FORGEJO_REPOS"] = "override-org/repo";
    mod.reloadConfig();
    expect(mod.hasForgejoRepoForOwner("Owner")).toBe(false);
    expect(mod.hasForgejoRepoForOwner("OVERRIDE-ORG")).toBe(true);

    mod.registerDiscoveredForgejoRepos(["Owner/Discovered"]);
    expect(mod.hasForgejoRepoForOwner("owner")).toBe(true);
    // Prefix match is on the full owner segment, not a substring.
    expect(mod.hasForgejoRepoForOwner("Own")).toBe(false);

    mod.clearDiscoveredForgejoRepos();
    delete process.env["CLAWS_FORGEJO_REPOS"];
  });

  it("never writes forgejoRepos to config.json (#2917)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    mod.reloadConfig();

    mod.registerDiscoveredForgejoRepos(["owner/unlisted"]);

    expect(JSON.parse(fs.readFileSync(mod.CONFIG_PATH, "utf-8")).forgejoRepos).toBeUndefined();
    expect(mod.isForgejoRepo("owner/unlisted")).toBe(true);

    mod.clearDiscoveredForgejoRepos();
  });

  it("routes web/issue/PR URLs to the forge that owns the repo (#2650)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    process.env["CLAWS_FORGEJO_REPOS"] = "owner/migrated";
    mod.reloadConfig();

    expect(mod.webUrlForRepo("owner/migrated")).toBe("https://git.home.bstjohn.net/owner/migrated");
    expect(mod.issueUrl("owner/migrated", 7)).toBe("https://git.home.bstjohn.net/owner/migrated/issues/7");
    // Forgejo pull requests live at /pulls/{n}, GitHub's at /pull/{n}.
    expect(mod.prUrl("owner/migrated", 7)).toBe("https://git.home.bstjohn.net/owner/migrated/pulls/7");

    expect(mod.webUrlForRepo("owner/stays")).toBe("https://github.com/owner/stays");
    expect(mod.issueUrl("owner/stays", 7)).toBe("https://github.com/owner/stays/issues/7");
    expect(mod.prUrl("owner/stays", 7)).toBe("https://github.com/owner/stays/pull/7");
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
      expect(mod.issueUrl("owner/repo", 7)).toBe("https://github.com/owner/repo/issues/7");

      setImportedRef("owner/repo", 7, NATIVE_ID);

      const dashboardIssueUrl = `${mod.DASHBOARD_URL?.replace(/\/+$/, "") ?? ""}/issues/${NATIVE_ID}`;
      expect(mod.issueUrl("owner/repo", 7)).toBe(dashboardIssueUrl);
      // The native id itself resolves the same way.
      expect(mod.issueUrl("owner/repo", NATIVE_ID)).toBe(dashboardIssueUrl);
      // forgeIssueUrl is deliberately unresolved — it never consults the index.
      expect(mod.forgeIssueUrl("owner/repo", 7)).toBe("https://github.com/owner/repo/issues/7");
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
    expect(parseOidcHostMap("claws.ext.bstjohn.net=https://auth.ext.bstjohn.net")).toEqual({
      "claws.ext.bstjohn.net": "https://auth.ext.bstjohn.net",
    });
  });

  it("parses multiple comma-separated pairs", async () => {
    const { parseOidcHostMap } = await import("./config.js");
    expect(
      parseOidcHostMap(
        "claws.ext.bstjohn.net=https://auth.ext.bstjohn.net,other.example=https://auth.other.example",
      ),
    ).toEqual({
      "claws.ext.bstjohn.net": "https://auth.ext.bstjohn.net",
      "other.example": "https://auth.other.example",
    });
  });

  it("normalises a scheme-prefixed, port-suffixed, uppercase key to a bare lowercase host", async () => {
    const { parseOidcHostMap } = await import("./config.js");
    expect(
      parseOidcHostMap("HTTPS://Claws.Ext.Bstjohn.Net:443=https://auth.ext.bstjohn.net"),
    ).toEqual({
      "claws.ext.bstjohn.net": "https://auth.ext.bstjohn.net",
    });
  });

  it("normalises a value with a trailing slash and path to its origin", async () => {
    const { parseOidcHostMap } = await import("./config.js");
    expect(
      parseOidcHostMap("claws.ext.bstjohn.net=https://auth.ext.bstjohn.net/some/path/"),
    ).toEqual({
      "claws.ext.bstjohn.net": "https://auth.ext.bstjohn.net",
    });
  });

  it("drops an entry with no '=' without throwing", async () => {
    const { parseOidcHostMap } = await import("./config.js");
    expect(parseOidcHostMap("claws.ext.bstjohn.net")).toEqual({});
  });

  it("drops an entry with an empty key without throwing", async () => {
    const { parseOidcHostMap } = await import("./config.js");
    expect(parseOidcHostMap("=https://auth.ext.bstjohn.net")).toEqual({});
  });

  it("drops an entry with a non-URL value without throwing", async () => {
    const { parseOidcHostMap } = await import("./config.js");
    expect(parseOidcHostMap("claws.ext.bstjohn.net=not-a-url")).toEqual({});
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

  it('unions the "*" list, the host repo entry and the repo file for ignored advisories', async () => {
    const mod = await import("./config.js");
    const repoConfig = await import("./repo-config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        dependabotIgnoredAdvisories: { "*": ["GHSA-GLOBAL"], "owner/repo": ["GHSA-HOST"] },
      }),
    );
    mod.reloadConfig();

    repoConfig.clearRepoConfigCache();
    await repoConfig.refreshRepoConfigs([{ fullName: "owner/repo" }], async () =>
      JSON.stringify({ dependabotIgnoredAdvisories: ["GHSA-REPO"] }),
    );

    expect(mod.getIgnoredAdvisoriesForRepo("owner/repo")).toEqual(
      new Set(["ghsa-global", "ghsa-host", "ghsa-repo"]),
    );
    expect(mod.getIgnoredAdvisoriesForRepo("owner/other")).toEqual(new Set(["ghsa-global"]));

    repoConfig.clearRepoConfigCache();
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

describe("parseSessionRuntimeEnv (#3026)", () => {
  it("defaults to local-tmux with the pod defaults when nothing is set", async () => {
    const { parseSessionRuntimeEnv } = await import("./config.js");
    const parsed = parseSessionRuntimeEnv({ KUBERNETES_SERVICE_HOST: "10.0.0.1" }, "v2026-09-14.1");
    expect(parsed.backend).toBe("local-tmux");
    expect(parsed.pod).toEqual({
      namespace: "claws-sessions",
      image: "ghcr.io/st-john-software/claws:v2026-09-14.1",
      imagePullSecrets: ["ghcr-pull"],
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

  it("accepts k8s-pod and throws on any other value", async () => {
    const { parseSessionRuntimeEnv } = await import("./config.js");
    expect(parseSessionRuntimeEnv({ CLAWS_SESSION_BACKEND: "k8s-pod" }, "v1").backend).toBe("k8s-pod");
    expect(parseSessionRuntimeEnv({ CLAWS_SESSION_BACKEND: "local-tmux" }, "v1").backend).toBe("local-tmux");
    expect(() => parseSessionRuntimeEnv({ CLAWS_SESSION_BACKEND: "k8s" }, "v1")).toThrow(/Invalid CLAWS_SESSION_BACKEND/);
    expect(() => parseSessionRuntimeEnv({ CLAWS_SESSION_BACKEND: "K8S-POD" }, "v1")).toThrow();
  });

  it("leaves the image empty on a dev build unless one is set explicitly", async () => {
    const { parseSessionRuntimeEnv } = await import("./config.js");
    expect(parseSessionRuntimeEnv({}, "dev").pod.image).toBe("");
    expect(parseSessionRuntimeEnv({ CLAWS_SESSION_IMAGE: "registry/claws:test" }, "dev").pod.image).toBe("registry/claws:test");
  });

  it("pins the default session image to the published version, and to empty on dev (#3057)", async () => {
    const { parseSessionRuntimeEnv } = await import("./config.js");
    expect(parseSessionRuntimeEnv({}, "v2026-09-14.8").pod.image).toBe("ghcr.io/st-john-software/claws:v2026-09-14.8");
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

  it("exports local-tmux when CLAWS_SESSION_BACKEND is unset", async () => {
    const mod = await import("./config.js");
    expect(mod.SESSION_BACKEND).toBe("local-tmux");
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
      ephemeralStorageLimit: "24Gi",
      homeSize: "20Gi",
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
      CLAWS_AGENT_POD_EPHEMERAL_STORAGE_LIMIT: "30Gi",
      CLAWS_AGENT_POD_HOME_SIZE: "25Gi",
    }, SESSION);
    expect(pod).toEqual({ cpuRequest: "1", memoryRequest: "3Gi", memoryLimit: "8Gi", ephemeralStorageLimit: "30Gi", homeSize: "25Gi" });
  });
});

describe("resolveThirdPartyUpdateWindow", () => {
  it("defaults to 22:00–07:00 Europe/London", async () => {
    const { resolveThirdPartyUpdateWindow } = await import("./config.js");
    expect(resolveThirdPartyUpdateWindow(undefined)).toEqual({ enabled: true, start: "22:00", end: "07:00", timezone: "Europe/London" });
  });

  it("keeps valid overrides and falls back per field on invalid ones", async () => {
    const { resolveThirdPartyUpdateWindow } = await import("./config.js");
    expect(resolveThirdPartyUpdateWindow({ enabled: false, start: "23:30", end: "6:00", timezone: "Not/AZone" }))
      .toEqual({ enabled: false, start: "23:30", end: "07:00", timezone: "Europe/London" });
  });
});
