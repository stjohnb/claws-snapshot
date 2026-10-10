import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface MockMacRunner {
  name?: string;
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  labels: string[];
  enabled?: boolean;
}

// `CAPABILITIES` builds its Mac ssh:* entries once, at module-import time, so
// this must be the value MAC_RUNNERS has *when capabilities.ts first loads* —
// a later beforeEach mutation is too late to change which capability objects
// exist, though it still changes what a Mac's resolve() returns. Mirrors
// config.ts's DEFAULT_MAC_RUNNERS, except the second entry is disabled here
// so tests can cover a Mac hidden by its per-host toggle.
const mockConfig = vi.hoisted(() => ({
  HOME_ASSISTANT_BASE_URL: "",
  HOME_ASSISTANT_TOKEN: "",
  PROD_GRAFANA_URL: "https://grafana.example",
  PROD_GRAFANA_TOKEN: "",
  FLEET_GRAFANA_URL: "https://grafana.home.example",
  FLEET_GRAFANA_TOKEN: "",
  FORGEJO_TOKEN: "",
  FORGEJO_READ_TOKEN: "",
  FORGEJO_ADMIN_TOKEN: "",
  FORGEJO_BASE_URL: "https://git.example.test",
  FORGEJO_REPOS: [] as string[],
  isForgejoRepo: (n: string) => mockConfig.FORGEJO_REPOS.some((r) => r.toLowerCase() === n.toLowerCase()),
  OPENROUTER_API_KEY: "",
  OPENAI_API_KEY: "",
  GITHUB_APP_ID: 0,
  GITHUB_OWNER_APP_CREDENTIALS: {} as Record<string, { appId?: number; privateKeyPath?: string }>,
  PAGES_HOST: null as null | {
    endpoint: string;
    region: string;
    bucket: string;
    baseUrl: string;
    accessKeyId: string;
    secretAccessKey: string;
  },
  PRINT_SERVER: "",
  // Stand-in for config.ts's resolveLanHost with documentation-range addresses.
  resolveLanHost: <T extends { host: string; user?: string }>(target: T): T => {
    const aliases: Record<string, { host: string; user: string }> = {
      "brendans-macbook-pro": { host: "203.0.113.1", user: "brendan" },
      "brendans-macbook-pro-3": { host: "203.0.113.2", user: "brendanstjohn" },
    };
    const alias = aliases[target.host.toLowerCase().replace(/\.local\.?$/, "")];
    return alias ? { ...target, host: alias.host, user: target.user ?? alias.user } : target;
  },
  MAC_RUNNERS: [
    { name: "Brendans-MacBook-Pro", host: "brendans-macbook-pro.local", labels: ["macos", "tempo"] },
    { name: "Brendans-MacBook-Pro-3", host: "brendans-macbook-pro-3.local", user: "brendanstjohn", labels: ["macos", "xcode26"], enabled: false },
  ] as MockMacRunner[],
}));

const DEFAULT_TEST_MAC_RUNNERS = mockConfig.MAC_RUNNERS;

vi.mock("./config.js", () => mockConfig);

import {
  buildCapabilityEnvArgs,
  buildCapabilityPrompt,
  buildRequestableCapabilityPrompt,
  classifyLiveGrants,
  FIXED_AT_LAUNCH_REASON,
  resolveCapabilityEnv,
  capabilityEnvKeys,
  validCapabilityIds,
  availableCapabilities,
  isCapabilityAvailable,
  REPO_CAPABILITY_DEFAULTS,
  plannerCapabilitiesForRepo,
  reposForCapability,
  defaultCapabilitiesForRepo,
  withImplicitCapabilities,
  defaultProviderAuthCapabilities,
  isAgentLoginCapability,
  isRememberableCapability,
  CAPABILITIES,
  resolveHeadlessForgejoAccess,
  resolveHeadlessCrossRepoAccess,
  resolveHeadlessPlannerCapabilityAccess,
  liveGrantableCapabilities,
  isLiveRevocable,
  grantedEnvVars,
  capabilityLabel,
  CLAUDE_AUTH_CAPABILITY_ID,
  CROSS_REPO_CAPABILITY_ID,
  FORGEJO_CAPABILITY_ID,
  capabilityGroup,
  CAPABILITY_GROUPS,
  autoGrantedRepos,
} from "./capabilities.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The gated env keys across the whole registry.
const ALL_KEYS = [
  "HOME_ASSISTANT_BASE_URL",
  "HOME_ASSISTANT_TOKEN",
  "CLAWS_HOME_ASSISTANT_TOKEN",
  "CLAWS_PROD_GRAFANA_URL",
  "CLAWS_PROD_GRAFANA_TOKEN",
  "CLAWS_FLEET_GRAFANA_URL",
  "CLAWS_FLEET_GRAFANA_TOKEN",
  "CLAWS_FORGEJO_TOKEN",
  "CLAWS_FORGEJO_READ_TOKEN",
  "CLAWS_FORGEJO_BASE_URL",
  "CLAWS_FORGEJO_GIT_TOKEN",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "CLAWS_FORGEJO_ADMIN_TOKEN",
  "CLAWS_PAGES_S3_ENDPOINT",
  "CLAWS_PAGES_S3_REGION",
  "CLAWS_PAGES_S3_BUCKET",
  "CLAWS_PAGES_BASE_URL",
  "CLAWS_PAGES_S3_ACCESS_KEY_ID",
  "CLAWS_PAGES_S3_SECRET_ACCESS_KEY",
  "CLAWS_PAGES_PUBLISH",
  "CUPS_SERVER",
  "CLAWS_PRINT",
  "CLAWS_PRINT_SERVER",
];

// SENSITIVE_ENV_KEYS entries that are NOT owned by any capability.
const SENSITIVE_ONLY = [
  "OPENAI_API_KEY",
  "CLAWS_OPENROUTER_API_KEY",
  "OPENROUTER_API_KEY",
  "CLAWS_AUTH_TOKEN",
  "CLAWS_OIDC_CLIENT_SECRET",
  "CLAWS_SLACK_BOT_TOKEN",
  "CLAWS_SLACK_WEBHOOK",
  "CLAWS_SLACK_WEBHOOK_URL",
  "BRENDAN_SERVER_GMAIL_APP_PASSWORD",
  "CLAWS_SSH_PRIVATE_KEY",
  "CLAWS_KUBECONFIG",
  "CLAWS_PROD_KUBECONFIG",
  "KUBECONFIG",
  "CLAWS_CODEX_AUTH_JSON",
  "CLAWS_CLAUDE_SETTINGS_JSON",
  "CLAWS_SLACK_PROD_ALERTS_WEBHOOK",
];

// buildCapabilityEnvArgs appends one non-secret assignment (the MCP tool
// timeout). Every other `=` on argv would be a credential leak (#2138).
const MCP_TIMEOUT_ARG = "MCP_TOOL_TIMEOUT=300000";
const assignments = (args: string[]) => args.filter((a) => a.includes("=") && a !== MCP_TIMEOUT_ARG);

describe("capabilities", () => {
  beforeEach(() => {
    mockConfig.HOME_ASSISTANT_BASE_URL = "https://ha.example";
    mockConfig.HOME_ASSISTANT_TOKEN = "ha-token";
    mockConfig.PROD_GRAFANA_TOKEN = "";
    mockConfig.FLEET_GRAFANA_TOKEN = "";
    mockConfig.FORGEJO_TOKEN = "";
    mockConfig.FORGEJO_READ_TOKEN = "";
    mockConfig.FORGEJO_ADMIN_TOKEN = "";
    mockConfig.FORGEJO_BASE_URL = "https://git.example.test";
    mockConfig.FORGEJO_REPOS = [];
    mockConfig.OPENROUTER_API_KEY = "";
    mockConfig.GITHUB_APP_ID = 0;
    mockConfig.GITHUB_OWNER_APP_CREDENTIALS = {};
    mockConfig.MAC_RUNNERS = DEFAULT_TEST_MAC_RUNNERS;
    mockConfig.PAGES_HOST = null;
    mockConfig.PRINT_SERVER = "";
  });

  it("empty selection strips every gated key with -u and injects nothing", () => {
    const args = buildCapabilityEnvArgs([], null);
    expect(args[0]).toBe("env");
    expect(assignments(args)).toEqual([]);
    for (const key of ALL_KEYS) {
      const idx = args.indexOf(key);
      expect(idx).toBeGreaterThan(0);
      expect(args[idx - 1]).toBe("-u");
    }
  });

  // The core regression for #2138: a credential must never reach argv, which is
  // world-readable via /proc/<pid>/cmdline.
  it.each([[[]], [["home-assistant"]], [["home-assistant", "ssh:nas"]]])(
    "never puts a value on argv for selection %j",
    (selected: string[]) => {
      const args = buildCapabilityEnvArgs(selected, "/tmp/s.env");
      expect(args.every((a) => !a.includes("ha-token"))).toBe(true);
      expect(assignments(args)).toEqual([]);
    },
  );

  it("granting home-assistant sources the env file via a /bin/sh prelude", () => {
    const args = buildCapabilityEnvArgs(["home-assistant"], "/tmp/s.env");
    expect(args).toContain("/bin/sh");
    expect(args).toContain("-c");
    expect(args).toContain("claws-session");
    expect(args).toContain("/tmp/s.env");
    // The prelude sources, deletes, shifts, then execs the real command.
    expect(args[args.indexOf("-c") + 1]).toBe('. "$1"; rm -f "$1"; shift; exec "$@"');
    // $0 / $1 order matters: the file path must directly follow claws-session.
    expect(args[args.indexOf("claws-session") + 1]).toBe("/tmp/s.env");
  });

  it("sets MCP_TOOL_TIMEOUT so a long claws_wait_for_change is not aborted", () => {
    expect(buildCapabilityEnvArgs([], null)).toContain(MCP_TIMEOUT_ARG);
    // Assignments must precede the command for `env` to apply them.
    const args = buildCapabilityEnvArgs(["home-assistant"], "/tmp/s.env");
    expect(args.indexOf(MCP_TIMEOUT_ARG)).toBeLessThan(args.indexOf("/bin/sh"));
  });

  it("omits the /bin/sh prelude when there is no env file", () => {
    const args = buildCapabilityEnvArgs(["home-assistant"], null);
    expect(args).not.toContain("/bin/sh");
    expect(args).not.toContain("claws-session");
  });

  it("strips granted keys too — the file re-sets them, argv never grants", () => {
    const args = buildCapabilityEnvArgs(["home-assistant"], "/tmp/s.env");
    for (const key of ["HOME_ASSISTANT_BASE_URL", "HOME_ASSISTANT_TOKEN", "CLAWS_HOME_ASSISTANT_TOKEN"]) {
      const idx = args.indexOf(key);
      expect(idx).toBeGreaterThan(0);
      expect(args[idx - 1]).toBe("-u");
    }
  });

  it("resolveCapabilityEnv returns the three HA vars", () => {
    expect(resolveCapabilityEnv(["home-assistant"]).vars).toEqual({
      HOME_ASSISTANT_BASE_URL: "https://ha.example",
      HOME_ASSISTANT_TOKEN: "ha-token",
      CLAWS_HOME_ASSISTANT_TOKEN: "ha-token",
    });
  });

  it("drops a requested capability whose credentials are unavailable", () => {
    mockConfig.HOME_ASSISTANT_TOKEN = "";
    const { vars, stripKeys } = resolveCapabilityEnv(["home-assistant"]);
    expect(vars).toEqual({});
    expect(stripKeys).toContain("HOME_ASSISTANT_TOKEN");
  });

  it("validCapabilityIds rejects unknown ids and dedupes", () => {
    expect(validCapabilityIds(["bogus", "home-assistant", "home-assistant"])).toEqual([
      "home-assistant",
    ]);
  });

  it("availableCapabilities reflects configured credentials", () => {
    expect(availableCapabilities().map((c) => c.id)).toContain("home-assistant");
    mockConfig.HOME_ASSISTANT_TOKEN = "";
    expect(availableCapabilities().map((c) => c.id)).not.toContain("home-assistant");
  });

  it("offers no kubectl capability even with every credential configured (#clw_01M3EW1TJ5FPD17N8JQSHDJXAJ)", () => {
    mockConfig.FORGEJO_TOKEN = "fgj";
    mockConfig.FORGEJO_READ_TOKEN = "fgj-read";
    mockConfig.FORGEJO_ADMIN_TOKEN = "fgj-admin";
    mockConfig.OPENROUTER_API_KEY = "or-key";
    mockConfig.GITHUB_APP_ID = 123;
    const ids = availableCapabilities().map((c) => c.id);
    expect(ids).toContain("home-assistant");
    expect(ids).not.toContain("prod-infra");
    expect(ids).not.toContain("fleet-infra");
    expect(validCapabilityIds(["prod-infra", "fleet-infra", "home-assistant"])).toEqual(["home-assistant"]);
    expect(capabilityEnvKeys()).not.toContain("KUBECONFIG");
    expect(Object.keys(resolveCapabilityEnv(CAPABILITIES.map((c) => c.id)).vars)).not.toContain("KUBECONFIG");
  });

  it("cross-repo guidance tells the implementer to pass the plan's dedupeKey and accept a deduplicated reply", () => {
    const guidance = CAPABILITIES.find((c) => c.id === CROSS_REPO_CAPABILITY_ID)!.description;
    expect(guidance).toContain("dedupeKey");
    expect(guidance).toContain("deduplicated: true");
    expect(guidance).toContain("do not retry with a reworded title");
  });

  it("buildCapabilityPrompt([]) returns empty string", () => {
    expect(buildCapabilityPrompt([])).toBe("");
  });

  it("buildCapabilityPrompt names only granted capabilities", () => {
    const prompt = buildCapabilityPrompt(["home-assistant"]);
    expect(prompt).toContain("Home Assistant");
    expect(prompt).not.toContain("Namey");
    expect(prompt).not.toContain("Prod infra");
    expect(prompt).not.toContain("NOT granted");
  });

  it("empty selection strips all sensitive keys", () => {
    const args = buildCapabilityEnvArgs([], null);
    for (const key of SENSITIVE_ONLY) {
      const idx = args.indexOf(key);
      expect(idx).toBeGreaterThan(0);
      expect(args[idx - 1]).toBe("-u");
    }
  });

  it("sensitive keys are stripped even when a capability is granted", () => {
    const args = buildCapabilityEnvArgs(["home-assistant"], "/tmp/s.env");
    for (const key of SENSITIVE_ONLY) {
      const idx = args.indexOf(key);
      expect(idx).toBeGreaterThan(0);
      expect(args[idx - 1]).toBe("-u");
    }
    // The granted capability's value arrives via the sourced file, not argv.
    expect(resolveCapabilityEnv(["home-assistant"]).vars.HOME_ASSISTANT_TOKEN).toBe("ha-token");
  });

  it("no key is stripped twice", () => {
    const args = buildCapabilityEnvArgs([], null);
    for (const key of ["CLAWS_HOME_ASSISTANT_TOKEN", "CLAWS_AUTH_TOKEN"]) {
      expect(args.filter((a) => a === key).length).toBe(1);
    }
  });

  it("SSH host capabilities are always available", () => {
    const ids = availableCapabilities().map((c) => c.id);
    expect(ids).toContain("ssh:nas");
    expect(ids).toContain("ssh:proxmox");
    // 5 hardcoded aliases + the one enabled Mac from DEFAULT_TEST_MAC_RUNNERS
    // (the second is `enabled: false`).
    expect(ids.filter((id) => id.startsWith("ssh:")).length).toBe(6);
  });

  it("granting an SSH capability resolves no env vars", () => {
    expect(resolveCapabilityEnv(["ssh:nas"]).vars).toEqual({});
    expect(assignments(buildCapabilityEnvArgs(["ssh:nas"], null))).toEqual([]);
  });

  it("buildCapabilityPrompt names the granted SSH host", () => {
    const prompt = buildCapabilityPrompt(["ssh:nas"]);
    expect(prompt).toContain("SSH: nas");
    expect(prompt).toContain("NixOS NAS");
    expect(prompt).toContain("k3s-nas");
  });

  it("the retired ssh:k3s-nas capability is gone", () => {
    expect(availableCapabilities().map((c) => c.id)).not.toContain("ssh:k3s-nas");
    expect(isCapabilityAvailable("ssh:k3s-nas")).toBe(false);
  });
});

describe("browser capability", () => {
  it("is available and injects nothing", () => {
    expect(availableCapabilities().map((c) => c.id)).toContain("browser");
    expect(isCapabilityAvailable("browser")).toBe(true);
    expect(resolveCapabilityEnv(["browser"]).vars).toEqual({});
    expect(assignments(buildCapabilityEnvArgs(["browser"], null))).toEqual([]);
  });

  it("buildCapabilityPrompt mentions Playwright and eBay", () => {
    const prompt = buildCapabilityPrompt(["browser"]);
    expect(prompt).toContain("Playwright");
    expect(prompt).toContain("eBay");
  });

  it("reposForCapability('browser') returns no repos", () => {
    expect(reposForCapability("browser")).toEqual([]);
  });
});

describe("planner capabilities by repo", () => {
  it.each([
    ["fleet-infra", ["fleet-observability"]],
    ["bin-scraper", ["fleet-observability"]],
    ["claws", ["fleet-observability"]],
    ["production-infra", ["prod-observability"]],
    ["namey", ["prod-observability"]],
    ["bonkus", ["prod-observability"]],
  ])("grants %s only its associated cluster diagnostics", (repo, expected) => {
    const ids = plannerCapabilitiesForRepo(`St-John-Software/${repo}`);
    expect(ids).toEqual(expected);
  });

  it.each([
    "other/production-infra",
    "St-John-Software/unknown",
    "St-John-Software/nixos-config",
    "St-John-Software/home-assistant-config",
    "St-John-Software/ha-carlink",
    "__proto__",
  ])("grants no additional credentials to %s", (repo) => {
    expect(plannerCapabilitiesForRepo(repo)).toEqual([]);
  });

  it("looks up full repo names case-insensitively and returns an independent list", () => {
    const ids = plannerCapabilitiesForRepo("ST-JOHN-SOFTWARE/FLEET-INFRA");
    expect(ids).toEqual(["fleet-observability"]);
    ids.push("ssh:ryzen");
    expect(plannerCapabilitiesForRepo("St-John-Software/fleet-infra")).toEqual(["fleet-observability"]);
  });
});

describe("observability capabilities", () => {
  beforeEach(() => {
    mockConfig.PROD_GRAFANA_TOKEN = "";
    mockConfig.FLEET_GRAFANA_TOKEN = "";
  });
  afterEach(() => {
    mockConfig.PROD_GRAFANA_TOKEN = "";
    mockConfig.FLEET_GRAFANA_TOKEN = "";
  });

  it("is hidden while its token is unset", () => {
    const ids = availableCapabilities().map((c) => c.id);
    expect(ids).not.toContain("prod-observability");
    expect(ids).not.toContain("fleet-observability");
  });

  it("appears in the infra group once its token is set", () => {
    mockConfig.PROD_GRAFANA_TOKEN = "glsa_prod";
    const cap = availableCapabilities().find((c) => c.id === "prod-observability");
    expect(cap && capabilityGroup(cap)).toBe("infra");
    expect(availableCapabilities().map((c) => c.id)).not.toContain("fleet-observability");
  });

  it("injects URL and token when granted and strips them when not", () => {
    mockConfig.PROD_GRAFANA_TOKEN = "glsa_prod";
    mockConfig.FLEET_GRAFANA_TOKEN = "glsa_fleet";
    expect(resolveCapabilityEnv(["prod-observability"]).vars).toEqual({
      CLAWS_PROD_GRAFANA_URL: "https://grafana.example",
      CLAWS_PROD_GRAFANA_TOKEN: "glsa_prod",
    });
    const none = resolveCapabilityEnv([]);
    expect(none.stripKeys).toContain("CLAWS_PROD_GRAFANA_TOKEN");
    expect(none.stripKeys).toContain("CLAWS_FLEET_GRAFANA_TOKEN");
    expect(Object.keys(resolveCapabilityEnv(["prod-observability", "fleet-observability"]).vars).sort()).toEqual([
      "CLAWS_FLEET_GRAFANA_TOKEN",
      "CLAWS_FLEET_GRAFANA_URL",
      "CLAWS_PROD_GRAFANA_TOKEN",
      "CLAWS_PROD_GRAFANA_URL",
    ]);
  });

  it("adds a read-only sentence for headless planners and never leaks the token", () => {
    mockConfig.PROD_GRAFANA_TOKEN = "glsa_prod";
    const access = resolveHeadlessPlannerCapabilityAccess(["prod-observability"]);
    expect(access?.grantedIds).toEqual(["prod-observability"]);
    expect(access?.prompt).toContain("Bearer");
    expect(access?.prompt).toContain("read-only query endpoints");
    expect(access?.prompt).not.toContain("glsa_prod");
  });

  it("drops an unconfigured observability id from the headless grant", () => {
    expect(resolveHeadlessPlannerCapabilityAccess(["fleet-observability"])).toBeNull();
  });
});

describe("headless planner capability access", () => {
  afterEach(() => {
    mockConfig.FORGEJO_READ_TOKEN = "";
    mockConfig.FORGEJO_ADMIN_TOKEN = "";
    mockConfig.GITHUB_APP_ID = 0;
  });

  it("grants nothing for non-diagnostic capabilities; only observability is an unattended diagnostic one", () => {
    mockConfig.FORGEJO_READ_TOKEN = "read-token";
    mockConfig.FORGEJO_ADMIN_TOKEN = "admin-token";
    mockConfig.GITHUB_APP_ID = 123;
    expect(resolveHeadlessPlannerCapabilityAccess([
      "home-assistant",
      "ssh:ryzen",
      "browser",
      "cross-repo",
      "forgejo",
      "forgejo-admin",
      "github-auth",
      "fleet-infra",
      "prod-infra",
      "bogus",
    ])).toBeNull();
    expect(CAPABILITIES.filter((c) => c.headlessPlannerDiagnostic).map((c) => c.id)).toEqual([
      "prod-observability",
      "fleet-observability",
    ]);
  });
});

describe("forgejo capability (#2871)", () => {
  it("is unavailable with no token, even when a repo is Forgejo-hosted", () => {
    mockConfig.FORGEJO_REPOS = ["St-John-Software/perudo"];
    expect(isCapabilityAvailable("forgejo")).toBe(false);
    expect(availableCapabilities().map((c) => c.id)).not.toContain("forgejo");
    expect(validCapabilityIds(["forgejo"])).toEqual([]);
    expect(withImplicitCapabilities([], ["St-John-Software/perudo"])).toEqual(["cross-repo"]);
  });

  it("resolves the six expected env vars when configured", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    mockConfig.FORGEJO_REPOS = ["St-John-Software/perudo"];
    const { vars } = resolveCapabilityEnv(["forgejo"]);
    expect(vars).toEqual({
      CLAWS_FORGEJO_TOKEN: "tok",
      CLAWS_FORGEJO_BASE_URL: "https://git.example.test",
      CLAWS_FORGEJO_GIT_TOKEN: "tok",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.https://git.example.test.helper",
      GIT_CONFIG_VALUE_0: expect.stringContaining("$CLAWS_FORGEJO_GIT_TOKEN"),
    });
    // The value must never be pre-expanded — it must carry the literal `$`.
    expect(vars.GIT_CONFIG_VALUE_0).toContain("$CLAWS_FORGEJO_GIT_TOKEN");
  });

  it("strips a trailing slash from the base URL in both the var and the config key", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    mockConfig.FORGEJO_BASE_URL = "https://git.example.test/";
    mockConfig.FORGEJO_REPOS = ["St-John-Software/perudo"];
    const { vars } = resolveCapabilityEnv(["forgejo"]);
    expect(vars.CLAWS_FORGEJO_BASE_URL).toBe("https://git.example.test");
    expect(vars.GIT_CONFIG_KEY_0).toBe("credential.https://git.example.test.helper");
  });

  it("withImplicitCapabilities grants forgejo for a Forgejo-hosted repo", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    mockConfig.FORGEJO_REPOS = ["St-John-Software/perudo"];
    expect(withImplicitCapabilities([], ["St-John-Software/perudo"])).toContain("forgejo");
    expect(withImplicitCapabilities([], ["St-John-Software/perudo"])).toContain("cross-repo");
  });

  it("withImplicitCapabilities matches case-insensitively", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    mockConfig.FORGEJO_REPOS = ["St-John-Software/perudo"];
    expect(withImplicitCapabilities([], ["st-john-software/PERUDO"])).toContain("forgejo");
  });

  it("withImplicitCapabilities unions with an explicit selection, no duplicates", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    mockConfig.FORGEJO_REPOS = ["St-John-Software/perudo"];
    const ids = withImplicitCapabilities(["home-assistant"], ["owner/gh", "St-John-Software/perudo"]);
    expect(ids).toContain("home-assistant");
    expect(ids).toContain("forgejo");
    expect(ids).toContain("cross-repo");
    expect(ids.filter((id) => id === "forgejo").length).toBe(1);
    expect(ids.filter((id) => id === "cross-repo").length).toBe(1);
  });

  it("withImplicitCapabilities grants only cross-repo for a GitHub-only repo set", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    mockConfig.FORGEJO_REPOS = ["St-John-Software/perudo"];
    expect(withImplicitCapabilities([], ["owner/gh"])).not.toContain("forgejo");
    expect(withImplicitCapabilities([], [null])).not.toContain("forgejo");
    expect(withImplicitCapabilities([], ["owner/gh"])).toEqual(["cross-repo"]);
    expect(withImplicitCapabilities([], [null])).toEqual(["cross-repo"]);
  });

  it("buildCapabilityEnvArgs never puts the token or an assignment on argv", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    mockConfig.FORGEJO_REPOS = ["St-John-Software/perudo"];
    const args = buildCapabilityEnvArgs(["forgejo"], "/tmp/s.env");
    expect(args.every((a) => !a.includes("tok"))).toBe(true);
    expect(assignments(args)).toEqual([]);
  });

  it("the registry entry is marked implicit; non-cross-repo entries are not", () => {
    const forgejo = CAPABILITIES.find((c) => c.id === "forgejo");
    const crossRepo = CAPABILITIES.find((c) => c.id === "cross-repo");
    expect(forgejo?.implicit).toBe(true);
    expect(crossRepo?.implicit).toBe(true);
    for (const cap of CAPABILITIES) {
      if (cap.id === "forgejo" || cap.id === "cross-repo") continue;
      expect(cap.implicit).not.toBe(true);
    }
  });
});

describe("cross-repo capability (#3152)", () => {
  it("is implicit and available without a Forgejo read token", () => {
    mockConfig.FORGEJO_READ_TOKEN = "";
    expect(isCapabilityAvailable("cross-repo")).toBe(true);
    expect(resolveCapabilityEnv(["cross-repo"]).vars).toEqual({});
    expect(buildCapabilityPrompt(["cross-repo"])).toContain("Cross-repo (read + issues)");
  });

  it("resolves only the Forgejo read token and base URL when configured", () => {
    mockConfig.FORGEJO_READ_TOKEN = "read-tok";
    mockConfig.FORGEJO_BASE_URL = "https://git.example.test/";
    expect(resolveCapabilityEnv(["cross-repo"]).vars).toEqual({
      CLAWS_FORGEJO_READ_TOKEN: "read-tok",
      CLAWS_FORGEJO_BASE_URL: "https://git.example.test",
    });
    expect(resolveCapabilityEnv(["cross-repo"]).vars).not.toHaveProperty("CLAWS_FORGEJO_TOKEN");
    expect(resolveCapabilityEnv(["cross-repo"]).vars).not.toHaveProperty("CLAWS_FORGEJO_GIT_TOKEN");
    expect(resolveCapabilityEnv(["cross-repo"]).vars).not.toHaveProperty("GIT_CONFIG_COUNT");
  });

  it("has shared headless guidance without leaking token values", () => {
    mockConfig.FORGEJO_READ_TOKEN = "read-secret";
    const access = resolveHeadlessCrossRepoAccess()!;
    expect(access.env).toEqual({
      CLAWS_FORGEJO_READ_TOKEN: "read-secret",
      CLAWS_FORGEJO_BASE_URL: "https://git.example.test",
    });
    expect(access.prompt).toContain("## Cross-repo access");
    expect(access.prompt).toContain("gh api repos/OWNER/NAME/contents/DIR");
    expect(access.prompt).toContain("$CLAWS_FORGEJO_READ_TOKEN");
    expect(access.prompt).not.toContain("read-secret");
  });

  it("points cross-repo filing at claws_create_issue, keeping gh issue create as the documented fallback", () => {
    const access = resolveHeadlessCrossRepoAccess()!;
    expect(access.prompt).toContain("claws_create_issue");
    expect(access.prompt).toContain("gh issue create --repo OWNER/NAME");
    expect(access.prompt).toContain("every repo");
    expect(access.prompt).not.toContain("File a companion issue");
  });

  it("is not live-grantable", () => {
    expect(liveGrantableCapabilities([], "k8s-pod").map((c) => c.id)).not.toContain("cross-repo");
  });
});

describe("forgejo-admin capability (#2965)", () => {
  it("is unavailable with no admin token configured", () => {
    mockConfig.FORGEJO_ADMIN_TOKEN = "";
    expect(isCapabilityAvailable("forgejo-admin")).toBe(false);
    expect(validCapabilityIds(["forgejo-admin"])).toEqual([]);
    expect(availableCapabilities().map((c) => c.id)).not.toContain("forgejo-admin");
  });

  it("is available and resolves the admin token and base URL when configured", () => {
    mockConfig.FORGEJO_ADMIN_TOKEN = "admin-tok";
    mockConfig.FORGEJO_BASE_URL = "https://git.example.test";
    expect(isCapabilityAvailable("forgejo-admin")).toBe(true);
    expect(resolveCapabilityEnv(["forgejo-admin"]).vars).toEqual({
      CLAWS_FORGEJO_ADMIN_TOKEN: "admin-tok",
      CLAWS_FORGEJO_BASE_URL: "https://git.example.test",
    });
  });

  it("is not implicit, unlike forgejo", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    mockConfig.FORGEJO_ADMIN_TOKEN = "admin-tok";
    mockConfig.FORGEJO_REPOS = ["St-John-Software/perudo"];
    const ids = withImplicitCapabilities([], ["St-John-Software/perudo"]);
    expect(ids).toEqual(["cross-repo", "forgejo"]);
    expect(ids).not.toContain("forgejo-admin");
  });

  it("buildCapabilityEnvArgs never puts the admin token or an assignment on argv", () => {
    mockConfig.FORGEJO_ADMIN_TOKEN = "admin-tok";
    const args = buildCapabilityEnvArgs(["forgejo-admin"], "/tmp/s.env");
    expect(args.every((a) => !a.includes("admin-tok"))).toBe(true);
    expect(assignments(args)).toEqual([]);
  });

  it("granting only forgejo does not leak the admin token key, and buildCapabilityEnvArgs still strips it", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    mockConfig.FORGEJO_ADMIN_TOKEN = "admin-tok";
    mockConfig.FORGEJO_REPOS = ["St-John-Software/perudo"];
    expect(resolveCapabilityEnv(["forgejo"]).vars).not.toHaveProperty("CLAWS_FORGEJO_ADMIN_TOKEN");
    const args = buildCapabilityEnvArgs(["forgejo"], null);
    const idx = args.indexOf("CLAWS_FORGEJO_ADMIN_TOKEN");
    expect(idx).toBeGreaterThan(0);
    expect(args[idx - 1]).toBe("-u");
  });
});

// Descriptions are concatenated into sessionPromptText(), which for claude
// becomes a --append-system-prompt argv element; sessions.test.ts asserts no
// new-session argv element contains `=` except the #2138 MCP_TOOL_TIMEOUT
// guard. A capability whose label/description contains `=` would break that.
describe("capability registry text never contains '=' (#2138)", () => {
  it("no label or description contains an '=' character", () => {
    for (const cap of CAPABILITIES) {
      expect(cap.label).not.toContain("=");
      expect(cap.description).not.toContain("=");
    }
  });
});

describe("REPO_CAPABILITY_DEFAULTS / reposForCapability", () => {
  it("fleet-infra and production-infra default to observability plus their ssh:* hosts", () => {
    expect(REPO_CAPABILITY_DEFAULTS["St-John-Software/fleet-infra"]).toEqual(["fleet-observability", "ssh:k3s", "ssh:ryzen", "ssh:nas", "ssh:proxmox"]);
    expect(REPO_CAPABILITY_DEFAULTS["St-John-Software/production-infra"]).toEqual(["prod-observability", "ssh:ryzen"]);
  });

  it("observability defaults follow the planner repos; kubectl capabilities stay gone", () => {
    expect(REPO_CAPABILITY_DEFAULTS["St-John-Software/bin-scraper"]).toEqual(["fleet-observability"]);
    for (const repo of ["namey", "bonkus"]) {
      expect(REPO_CAPABILITY_DEFAULTS[`St-John-Software/${repo}`]).toEqual(["prod-observability"]);
    }
    expect(reposForCapability("prod-infra")).toEqual([]);
    expect(reposForCapability("fleet-infra")).toEqual([]);
  });

  it("reposForCapability('home-assistant') returns home-assistant-config and ha-carlink", () => {
    expect(reposForCapability("home-assistant")).toEqual([
      "St-John-Software/home-assistant-config",
      "St-John-Software/ha-carlink",
    ]);
  });

  it("the retired ssh:hetzner-actions-runner capability is gone", () => {
    expect(isCapabilityAvailable("ssh:hetzner-actions-runner")).toBe(false);
    expect(availableCapabilities().map((c) => c.id)).not.toContain("ssh:hetzner-actions-runner");
    expect(validCapabilityIds(["ssh:hetzner-actions-runner", "ssh:ryzen"])).toEqual(["ssh:ryzen"]);
  });

  it("the retired ssh:hetzner-beefy-actions capability is gone", () => {
    expect(isCapabilityAvailable("ssh:hetzner-beefy-actions")).toBe(false);
    expect(availableCapabilities().map((c) => c.id)).not.toContain("ssh:hetzner-beefy-actions");
    expect(validCapabilityIds(["ssh:hetzner-beefy-actions", "ssh:ryzen"])).toEqual(["ssh:ryzen"]);
  });

  it("reposForCapability('ssh:nas') returns fleet-infra and nixos-config", () => {
    expect(reposForCapability("ssh:nas")).toEqual([
      "St-John-Software/fleet-infra",
      "St-John-Software/nixos-config",
    ]);
  });

  it("nixos-config defaults cover its two live hosts", () => {
    expect(REPO_CAPABILITY_DEFAULTS["St-John-Software/nixos-config"]).toEqual([
      "ssh:nas",
      "ssh:ryzen",
    ]);
  });

  it("reposForCapability('ssh:ryzen') includes nixos-config", () => {
    expect(reposForCapability("ssh:ryzen")).toEqual([
      "St-John-Software/production-infra",
      "St-John-Software/fleet-infra",
      "St-John-Software/nixos-config",
    ]);
  });

  it("reposForCapability('ssh:hetzner-beefy-actions') returns nothing after retirement", () => {
    expect(reposForCapability("ssh:hetzner-beefy-actions")).toEqual([]);
  });

  it("fleet-infra defaults use ssh:nas, not the retired ssh:k3s-nas", () => {
    const ids = REPO_CAPABILITY_DEFAULTS["St-John-Software/fleet-infra"];
    expect(ids).toContain("ssh:nas");
    expect(ids).not.toContain("ssh:k3s-nas");
  });
});

describe("defaultCapabilitiesForRepo", () => {
  it("returns [] for null repo", () => {
    expect(defaultCapabilitiesForRepo(null)).toEqual([]);
  });

  it("returns [] for an unmapped repo", () => {
    expect(defaultCapabilitiesForRepo("St-John-Software/astro")).toEqual([]);
  });

  it("drops unavailable capabilities: home-assistant is dropped when HOME_ASSISTANT_TOKEN is unset", () => {
    mockConfig.HOME_ASSISTANT_TOKEN = "";
    expect(defaultCapabilitiesForRepo("St-John-Software/home-assistant-config")).toEqual(["ssh:homeassistant"]);
  });

  it("includes home-assistant once HOME_ASSISTANT_TOKEN is configured", () => {
    mockConfig.HOME_ASSISTANT_TOKEN = "tok";
    expect(defaultCapabilitiesForRepo("St-John-Software/home-assistant-config")).toEqual([
      "home-assistant",
      "ssh:homeassistant",
    ]);
  });
});

describe("github-auth repo defaults (#3131)", () => {
  beforeEach(() => {
    mockConfig.GITHUB_APP_ID = 123;
    mockConfig.FORGEJO_REPOS = ["St-John-Software/forge-only"];
  });

  afterEach(() => {
    mockConfig.GITHUB_APP_ID = 0;
    mockConfig.FORGEJO_REPOS = [];
  });

  it("pre-ticks github-auth for a GitHub-hosted repo, alongside its mapped defaults", () => {
    expect(defaultCapabilitiesForRepo("St-John-Software/astro")).toEqual(["github-auth"]);
    expect(defaultCapabilitiesForRepo("St-John-Software/nixos-config")).toEqual(["ssh:nas", "ssh:ryzen", "github-auth"]);
  });

  // defaultCapabilitiesForRepo takes no mode: a repo-zsh session's checkboxes are
  // seeded from this same repo default, so github-auth stays pre-ticked there too,
  // deliberately (#3136 decision 1) — unlike an agent login, a human repo-zsh shell
  // has no agent to request it mid-session. defaultProviderAuthCapabilities is the
  // mode-scoped default and must not itself supply github-auth for repo-zsh.
  it("does not add github-auth as a repo-zsh mode default", () => {
    expect(defaultProviderAuthCapabilities("claude", "repo-zsh")).not.toContain("github-auth");
    expect(defaultCapabilitiesForRepo("St-John-Software/astro")).toContain("github-auth");
  });

  it("pre-ticks github-auth for a Forgejo repo too, but not for no repo or when unavailable", () => {
    expect(defaultCapabilitiesForRepo("St-John-Software/forge-only")).toEqual(["github-auth"]);
    expect(defaultCapabilitiesForRepo(null)).toEqual([]);
    mockConfig.GITHUB_APP_ID = 0;
    expect(defaultCapabilitiesForRepo("St-John-Software/astro")).toEqual([]);
  });

  it("reposForCapability('github-auth') is every repo it is given", () => {
    expect(reposForCapability("github-auth", ["St-John-Software/astro", "St-John-Software/forge-only", "acme/app"]))
      .toEqual(["St-John-Software/astro", "St-John-Software/forge-only", "acme/app"]);
    expect(reposForCapability("github-auth")).toEqual([]);
  });
});

describe("provider-auth capabilities (#3026)", () => {
  const PROVIDER_AUTH = ["claude-auth", "codex-auth", "openrouter-auth", "pi-auth", "github-auth"];
  let codexHome: string;
  const savedEnv = { claude: process.env["CLAUDE_CODE_OAUTH_TOKEN"], codexHome: process.env["CODEX_HOME"] };

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "claws-codex-home-"));
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    process.env["CODEX_HOME"] = codexHome;
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-test";
    mockConfig.OPENROUTER_API_KEY = "or-key";
    mockConfig.GITHUB_APP_ID = 123;
    mockConfig.GITHUB_OWNER_APP_CREDENTIALS = {};
    mockConfig.HOME_ASSISTANT_TOKEN = "ha-token";
  });

  afterEach(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
    if (savedEnv.claude === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = savedEnv.claude;
    if (savedEnv.codexHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = savedEnv.codexHome;
  });

  it("are available when their source credential exists", () => {
    expect(validCapabilityIds(PROVIDER_AUTH)).toEqual(PROVIDER_AUTH);
  });

  it("drop out when their source credential is missing", () => {
    delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    fs.rmSync(path.join(codexHome, "auth.json"));
    mockConfig.OPENROUTER_API_KEY = "";
    mockConfig.GITHUB_APP_ID = 0;
    expect(validCapabilityIds(PROVIDER_AUTH)).toEqual([]);
    mockConfig.GITHUB_OWNER_APP_CREDENTIALS = { "St-John-Software": { appId: 9, privateKeyPath: "/k.pem" } };
    expect(validCapabilityIds(PROVIDER_AUTH)).toEqual(["github-auth"]);
  });

  it("offers pi-auth when any one pi credential source exists", () => {
    delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    mockConfig.OPENROUTER_API_KEY = "";
    expect(isCapabilityAvailable("pi-auth")).toBe(false);
    mockConfig.OPENAI_API_KEY = "sk-openai";
    expect(isCapabilityAvailable("pi-auth")).toBe(true);
    mockConfig.OPENAI_API_KEY = "";
  });

  it("own no env keys, so strip lists are unchanged and nothing is injected", () => {
    for (const id of PROVIDER_AUTH) {
      const cap = CAPABILITIES.find((c) => c.id === id)!;
      expect(cap.envKeys).toEqual([]);
      expect(cap.resolve()).toEqual({});
    }
    const { stripKeys } = resolveCapabilityEnv([]);
    expect(stripKeys).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(buildCapabilityEnvArgs([], null)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("carry their provider and appear in the capability prompt when granted", () => {
    expect(CAPABILITIES.find((c) => c.id === "claude-auth")?.provider).toBe("claude");
    expect(CAPABILITIES.find((c) => c.id === "codex-auth")?.provider).toBe("codex");
    expect(CAPABILITIES.find((c) => c.id === "openrouter-auth")?.provider).toBe("opencode");
    expect(CAPABILITIES.find((c) => c.id === "pi-auth")?.provider).toBe("pi");
    expect(CAPABILITIES.find((c) => c.id === "github-auth")?.provider).toBe("github");
    expect(buildCapabilityPrompt(["github-auth"])).toContain("GitHub (gh + git)");
  });

  it.each([
    ["claude", "worktree-claude", ["claude-auth"]],
    ["claude", "home-claude", ["claude-auth"]],
    ["codex", "repo-claude", ["codex-auth"]],
    ["opencode", "worktree-claude", ["openrouter-auth"]],
    ["pi", "repo-claude", ["pi-auth"]],
    ["claude", "multi-worktree-claude", ["claude-auth"]],
    ["claude", "repo-zsh", []],
    ["codex", "repo-zsh", []],
  ] as const)("defaultProviderAuthCapabilities(%s, %s) → %j", (provider, mode, expected) => {
    expect(defaultProviderAuthCapabilities(provider, mode)).toEqual(expected);
  });

  it("isAgentLoginCapability is true only for agent logins, not github-auth or repo capabilities", () => {
    expect(isAgentLoginCapability("claude-auth")).toBe(true);
    expect(isAgentLoginCapability("codex-auth")).toBe(true);
    expect(isAgentLoginCapability("openrouter-auth")).toBe(true);
    expect(isAgentLoginCapability("pi-auth")).toBe(true);
    expect(isAgentLoginCapability("github-auth")).toBe(false);
    expect(isAgentLoginCapability("home-assistant")).toBe(false);
    expect(isAgentLoginCapability("no-such-capability")).toBe(false);
  });

  it("isRememberableCapability is false for agent logins and cross-repo, true for forgejo/repo/github-auth capabilities", () => {
    expect(isRememberableCapability("claude-auth")).toBe(false);
    expect(isRememberableCapability(CROSS_REPO_CAPABILITY_ID)).toBe(false);
    expect(isRememberableCapability(FORGEJO_CAPABILITY_ID)).toBe(true);
    expect(isRememberableCapability("github-auth")).toBe(true);
    expect(isRememberableCapability("home-assistant")).toBe(true);
    expect(isRememberableCapability("no-such-capability")).toBe(true);
  });
});

describe("resolveHeadlessForgejoAccess (#3067)", () => {
  const capability = () => CAPABILITIES.find((c) => c.id === "forgejo")!;

  beforeEach(() => {
    mockConfig.FORGEJO_TOKEN = "";
    mockConfig.FORGEJO_BASE_URL = "https://git.example.test";
  });

  it("returns null when no Forgejo token is configured", () => {
    expect(resolveHeadlessForgejoAccess(true)).toBeNull();
    expect(resolveHeadlessForgejoAccess(false)).toBeNull();
  });

  it("returns the capability's resolved env", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    expect(resolveHeadlessForgejoAccess(true)!.env).toEqual(capability().resolve());
    expect(resolveHeadlessForgejoAccess(false)!.env).toEqual(capability().resolve());
  });

  it("uses the capability description verbatim for a Forgejo working repo", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    const { prompt } = resolveHeadlessForgejoAccess(true)!;
    expect(prompt.startsWith("## Forgejo access\n\n")).toBe(true);
    expect(prompt).toContain(capability().description);
  });

  it("uses cross-forge wording for a GitHub working repo", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    const { prompt } = resolveHeadlessForgejoAccess(false)!;
    expect(prompt.startsWith("## Forgejo access\n\n")).toBe(true);
    expect(prompt).not.toContain("This repository is hosted on Forgejo");
    expect(prompt).toContain("$CLAWS_FORGEJO_BASE_URL/api/v1");
    expect(prompt).toContain("Keep using `gh` for GitHub-hosted repos");
  });

  it("never puts the token value in the prompt", () => {
    mockConfig.FORGEJO_TOKEN = "fgj_secret_value";
    expect(resolveHeadlessForgejoAccess(true)!.prompt).not.toContain("fgj_secret_value");
    expect(resolveHeadlessForgejoAccess(false)!.prompt).not.toContain("fgj_secret_value");
  });

  it("leaves the forgejo capability description unchanged", () => {
    expect(capability().description).toBe(
      "This repository is hosted on Forgejo, not GitHub. The GitHub repo of the same name is a stale read-only push mirror: never use `gh` for its issues, PRs, checks, runs or comments. Read and write issues, PRs, labels and comments with curl against the Gitea-compatible API at $CLAWS_FORGEJO_BASE_URL/api/v1, sending the header 'Authorization: token '$CLAWS_FORGEJO_TOKEN — e.g. curl -sH \"Authorization: token $CLAWS_FORGEJO_TOKEN\" \"$CLAWS_FORGEJO_BASE_URL/api/v1/repos/OWNER/NAME/issues\". git fetch and git push against the Forgejo host are already authenticated in this shell via a credential helper, and `origin` already points at Forgejo — do not add a GitHub remote. CI runs on Forgejo Actions from workflows in .forgejo/workflows/, not .github/workflows/. Never print or commit the token.",
    );
  });
});

describe("liveGrantableCapabilities / grantedEnvVars (#3072)", () => {
  const savedClaude = process.env["CLAUDE_CODE_OAUTH_TOKEN"];

  beforeEach(() => {
    mockConfig.HOME_ASSISTANT_TOKEN = "ha-token";
    mockConfig.FORGEJO_TOKEN = "fgj";
    mockConfig.FORGEJO_ADMIN_TOKEN = "fgj-admin";
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-test";
  });

  afterEach(() => {
    mockConfig.FORGEJO_TOKEN = "";
    mockConfig.FORGEJO_ADMIN_TOKEN = "";
    if (savedClaude === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = savedClaude;
  });

  const ids = (granted: string[], backend: "k8s-pod") => liveGrantableCapabilities(granted, backend).map((c) => c.id);

  it("offers available, ungranted live-deliverable capabilities, including Forgejo but not cross-repo, agent-login or browser ones", () => {
    const pod = ids([], "k8s-pod");
    expect(pod).toEqual(expect.arrayContaining(["home-assistant", "forgejo", "forgejo-admin"]));
    for (const id of ["cross-repo", "browser", "claude-auth", "codex-auth", "openrouter-auth"]) {
      expect(pod).not.toContain(id);
    }
    expect(ids(["forgejo"], "k8s-pod")).not.toContain("forgejo");
  });

  it("offers github-auth while the GitHub App is configured and it is not yet granted (#3131)", () => {
    mockConfig.GITHUB_APP_ID = 123;
    expect(ids([], "k8s-pod")).toContain("github-auth");
    expect(ids(["github-auth"], "k8s-pod")).not.toContain("github-auth");
    mockConfig.GITHUB_APP_ID = 0;
    expect(ids([], "k8s-pod")).not.toContain("github-auth");
  });

  it("drops what is already granted and what is unconfigured", () => {
    mockConfig.HOME_ASSISTANT_TOKEN = "";
    const pod = ids(["ssh:nas"], "k8s-pod");
    expect(pod).not.toContain("ssh:nas");
    expect(pod).not.toContain("home-assistant");
    expect(pod).toContain("ssh:ryzen");
  });

  it("offers ssh:* until it is granted (#3322)", () => {
    expect(ids([], "k8s-pod")).toContain("ssh:nas");
    expect(ids(["ssh:nas"], "k8s-pod")).not.toContain("ssh:nas");
  });

  it("classifyLiveGrants gives every configured capability a held, grantable or fixed state (#3322)", () => {
    mockConfig.GITHUB_APP_ID = 123;
    mockConfig.HOME_ASSISTANT_TOKEN = "";
    const entries = classifyLiveGrants(["ssh:ryzen"], "k8s-pod");
    const state = (id: string) => entries.find((e) => e.cap.id === id);
    // cross-repo is a baseline, held even when the row's list lacks it, and
    // carries a reason explaining why it's always held (#3372).
    expect(state("cross-repo")).toEqual(expect.objectContaining({ state: "held", reason: "always granted" }));
    expect(state("ssh:ryzen")).toEqual(expect.objectContaining({ state: "held" }));
    expect(state("ssh:ryzen")!.reason).toBeUndefined();
    expect(state("claude-auth")).toBeDefined();
    for (const id of ["browser", "claude-auth", "codex-auth", "openrouter-auth"]) {
      const entry = state(id);
      if (!entry) continue; // unconfigured in this mock
      expect(entry).toEqual(expect.objectContaining({ state: "fixed", reason: FIXED_AT_LAUNCH_REASON }));
    }
    expect(state("github-auth")).toEqual(expect.objectContaining({ state: "grantable" }));
    expect(state("ssh:nas")).toEqual(expect.objectContaining({ state: "grantable" }));
    expect(state("forgejo-admin")).toEqual(expect.objectContaining({ state: "grantable" }));
    // Unconfigured capabilities are absent entirely.
    expect(state("home-assistant")).toBeUndefined();
    expect(entries.map((e) => e.cap.id)).not.toContain("ssh:brendans-macbook-pro-3");
    expect(liveGrantableCapabilities(["ssh:ryzen"], "k8s-pod").map((c) => c.id))
      .toEqual(entries.filter((e) => e.state === "grantable").map((e) => e.cap.id));
    mockConfig.GITHUB_APP_ID = 0;
  });

  it("grantedEnvVars merges every granted capability's vars", () => {
    expect(grantedEnvVars(["home-assistant", "forgejo-admin"])).toEqual(expect.objectContaining({
      HOME_ASSISTANT_TOKEN: "ha-token",
      CLAWS_FORGEJO_ADMIN_TOKEN: "fgj-admin",
    }));
    expect(grantedEnvVars(["home-assistant"])).toEqual({
      HOME_ASSISTANT_BASE_URL: mockConfig.HOME_ASSISTANT_BASE_URL,
      HOME_ASSISTANT_TOKEN: "ha-token",
      CLAWS_HOME_ASSISTANT_TOKEN: "ha-token",
    });
    expect(grantedEnvVars(["ssh:nas"])).toEqual({});
  });

  it("buildRequestableCapabilityPrompt lists requestable ids and labels one group per line, never descriptions or values", () => {
    const prompt = buildRequestableCapabilityPrompt(["home-assistant"], "k8s-pod");
    const lines = prompt.split("\n");
    expect(lines[0]).toBe("## Requestable capabilities");
    expect(lines[1]).toBe("");
    expect(lines[2]).toContain("claws_request_capability");
    expect(lines[2]).toContain("approve");
    // One line per non-empty group, in CAPABILITY_GROUPS order (forge, ssh — infra holds only the granted
    // home-assistant, and agent and tools are empty here), then the SSH lag note.
    expect(lines).toHaveLength(6);
    expect(lines[3]).toBe("Forge access: `forgejo` (Forgejo (git + API)), `forgejo-admin` (Forgejo admin (Actions secrets))");
    expect(lines[4]).toContain("SSH hosts: `ssh:nas` (SSH: nas)");
    expect(lines[4]).toContain("`ssh:brendans-macbook-pro` (SSH: Brendans-MacBook-Pro)");
    // The granted home-assistant is excluded; the disabled Mac never appears.
    expect(prompt).not.toContain("`home-assistant`");
    expect(prompt).not.toContain("Infrastructure:");
    expect(prompt).not.toContain("brendans-macbook-pro-3");
    expect(prompt).not.toContain("`browser`");
    for (const cap of CAPABILITIES) expect(prompt).not.toContain(cap.description);
    for (const secret of ["ha-token", "fgj"]) expect(prompt).not.toContain(secret);
    expect(lines[5]).toContain("about two minutes");
  });

  it("buildRequestableCapabilityPrompt offers ssh:* on k8s-pod with a short-lag retry note", () => {
    const prompt = buildRequestableCapabilityPrompt([], "k8s-pod");
    expect(prompt).toContain("SSH hosts: `ssh:nas` (SSH: nas)");
    expect(prompt.split("\n").at(-1)).toBe("An SSH host granted to this session becomes usable within about two minutes; if the first connection fails with permission denied, retry once.");
    const allSsh = liveGrantableCapabilities([], "k8s-pod").filter((c) => c.id.startsWith("ssh:")).map((c) => c.id);
    expect(buildRequestableCapabilityPrompt(allSsh, "k8s-pod")).not.toContain("about two minutes");
  });

  it("isLiveRevocable allows only ssh:* hosts", () => {
    expect(isLiveRevocable("ssh:nas")).toBe(true);
    for (const id of ["forgejo", "github-auth", "home-assistant", "cross-repo"]) expect(isLiveRevocable(id)).toBe(false);
  });

  it("buildRequestableCapabilityPrompt is empty when nothing is requestable", () => {
    const everything = liveGrantableCapabilities([], "k8s-pod").map((c) => c.id);
    expect(buildRequestableCapabilityPrompt(everything, "k8s-pod")).toBe("");
  });
});

describe("capabilityLabel (#3110)", () => {
  it("returns the registry label for a known id, including an ssh: id", () => {
    expect(capabilityLabel("home-assistant")).toBe("Home Assistant");
    expect(capabilityLabel("ssh:nas")).toBe("SSH: nas");
  });

  it("returns the label of a provider-auth capability even when its resolve() is null", () => {
    const saved = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    try {
      expect(isCapabilityAvailable(CLAUDE_AUTH_CAPABILITY_ID)).toBe(false);
      expect(capabilityLabel(CLAUDE_AUTH_CAPABILITY_ID)).toBe("Claude login");
    } finally {
      if (saved !== undefined) process.env["CLAUDE_CODE_OAUTH_TOKEN"] = saved;
    }
  });

  it("returns the id unchanged for an id not in the registry", () => {
    expect(capabilityLabel("no-such-capability")).toBe("no-such-capability");
  });
});

describe("capabilityGroup / CAPABILITY_GROUPS (#3138)", () => {
  it("has the fixed display order", () => {
    expect(CAPABILITY_GROUPS.map((g) => g.id)).toEqual(["agent", "forge", "infra", "ssh", "tools"]);
  });

  it("classifies one registered capability from each group", () => {
    expect(capabilityGroup(CAPABILITIES.find((c) => c.id === "claude-auth")!)).toBe("agent");
    expect(capabilityGroup(CAPABILITIES.find((c) => c.id === "forgejo")!)).toBe("forge");
    expect(capabilityGroup(CAPABILITIES.find((c) => c.id === "home-assistant")!)).toBe("infra");
    expect(capabilityGroup(CAPABILITIES.find((c) => c.id === "ssh:nas")!)).toBe("ssh");
    expect(capabilityGroup(CAPABILITIES.find((c) => c.id === "browser")!)).toBe("tools");
  });

  it("puts cross-repo in the forge group, beside github and forgejo (#3372)", () => {
    expect(capabilityGroup(CAPABILITIES.find((c) => c.id === "cross-repo")!)).toBe("forge");
  });

  it("falls back to ssh for an untagged ssh:* id, else tools", () => {
    const untaggedSsh = { id: "ssh:custom", label: "x", description: "d", envKeys: [], resolve: () => ({}) };
    const untagged = { id: "something-else", label: "x", description: "d", envKeys: [], resolve: () => ({}) };
    expect(capabilityGroup(untaggedSsh)).toBe("ssh");
    expect(capabilityGroup(untagged)).toBe("tools");
  });
});

describe("autoGrantedRepos (#3372)", () => {
  it("forces cross-repo for every session regardless of repos", () => {
    expect(autoGrantedRepos(CROSS_REPO_CAPABILITY_ID, [])).toBe("all");
    expect(autoGrantedRepos(CROSS_REPO_CAPABILITY_ID, ["owner/gh"])).toBe("all");
  });

  it("forces forgejo only for the Forgejo-hosted subset of the given repos", () => {
    mockConfig.FORGEJO_REPOS = ["owner/forgejo-repo"];
    expect(autoGrantedRepos(FORGEJO_CAPABILITY_ID, ["owner/gh", "owner/forgejo-repo"])).toEqual(["owner/forgejo-repo"]);
    expect(autoGrantedRepos(FORGEJO_CAPABILITY_ID, ["owner/gh"])).toEqual([]);
    mockConfig.FORGEJO_REPOS = [];
  });

  it("returns null for any other capability id", () => {
    expect(autoGrantedRepos("home-assistant", ["owner/gh"])).toBeNull();
    expect(autoGrantedRepos("forgejo-admin", ["owner/gh"])).toBeNull();
  });
});

describe("Mac runner SSH capabilities (#3138)", () => {
  const mac1 = () => CAPABILITIES.find((c) => c.id === "ssh:brendans-macbook-pro")!;
  const mac2 = () => CAPABILITIES.find((c) => c.id === "ssh:brendans-macbook-pro-3")!;

  it("derives ids and labels from MAC_RUNNERS (name lowercased, trailing .local stripped)", () => {
    expect(mac1().id).toBe("ssh:brendans-macbook-pro");
    expect(mac1().label).toBe("SSH: Brendans-MacBook-Pro");
    expect(mac2().id).toBe("ssh:brendans-macbook-pro-3");
    expect(mac2().label).toBe("SSH: Brendans-MacBook-Pro-3");
  });

  it("both classify into the ssh group", () => {
    expect(capabilityGroup(mac1())).toBe("ssh");
    expect(capabilityGroup(mac2())).toBe("ssh");
  });

  it("own no env keys, so ALL_KEYS/strip-list behaviour is unchanged", () => {
    expect(mac1().envKeys).toEqual([]);
    expect(mac2().envKeys).toEqual([]);
    const args = buildCapabilityEnvArgs([], null);
    for (const key of ALL_KEYS) {
      const idx = args.indexOf(key);
      expect(idx).toBeGreaterThan(0);
      expect(args[idx - 1]).toBe("-u");
    }
  });

  it("the Mac with enabled: false is absent from availableCapabilities()", () => {
    const ids = availableCapabilities().map((c) => c.id);
    expect(ids).toContain("ssh:brendans-macbook-pro");
    expect(ids).not.toContain("ssh:brendans-macbook-pro-3");
    expect(isCapabilityAvailable("ssh:brendans-macbook-pro-3")).toBe(false);
  });

  it("resolve() re-reads MAC_RUNNERS at call time, hiding a removed host without rebuilding the registry", () => {
    const saved = mockConfig.MAC_RUNNERS;
    mockConfig.MAC_RUNNERS = saved.filter((r) => r.host !== "brendans-macbook-pro.local");
    expect(isCapabilityAvailable("ssh:brendans-macbook-pro")).toBe(false);
    mockConfig.MAC_RUNNERS = saved;
    expect(isCapabilityAvailable("ssh:brendans-macbook-pro")).toBe(true);
  });

  it("description carries the exact ssh invocation, with user@ only when the runner sets one, and never a literal '=' (#2138)", () => {
    expect(mac1().description).toContain('ssh -o "StrictHostKeyChecking accept-new" brendan@203.0.113.1');
    expect(mac1().description).not.toContain("brendans-macbook-pro.local");
    expect(mac1().description).not.toContain(" -i ");
    expect(mac1().description).not.toContain(" -p ");
    expect(mac2().description).toContain('ssh -o "StrictHostKeyChecking accept-new" brendanstjohn@203.0.113.2');
    expect(mac2().description).not.toContain("brendans-macbook-pro-3.local");
    expect(mac2().description).toContain("labels: macos, xcode26");
    expect(mac2().description).toContain("mac-runner-waker");
    for (const cap of [mac1(), mac2()]) {
      expect(cap.label).not.toContain("=");
      expect(cap.description).not.toContain("=");
    }
  });

  it("includes -i and -p only when the runner config sets an identityFile/port", async () => {
    vi.resetModules();
    const savedRunners = mockConfig.MAC_RUNNERS;
    mockConfig.MAC_RUNNERS = [
      { name: "TestMac", host: "testmac.local", user: "op", port: 2222, identityFile: "/home/test/.ssh/mac_id", labels: ["macos"] },
    ];
    try {
      const fresh = await import("./capabilities.js");
      const cap = fresh.CAPABILITIES.find((c) => c.id === "ssh:testmac")!;
      expect(cap.description).toContain('ssh -o "StrictHostKeyChecking accept-new" -i /home/test/.ssh/mac_id -p 2222 op@testmac.local');
    } finally {
      mockConfig.MAC_RUNNERS = savedRunners;
      vi.resetModules();
    }
  });

  it("is absent from REPO_CAPABILITY_DEFAULTS and defaultCapabilitiesForRepo (#3138 decision 5)", () => {
    for (const ids of Object.values(REPO_CAPABILITY_DEFAULTS)) {
      expect(ids).not.toContain("ssh:brendans-macbook-pro");
      expect(ids).not.toContain("ssh:brendans-macbook-pro-3");
    }
    expect(defaultCapabilitiesForRepo("St-John-Software/nixos-config")).not.toContain("ssh:brendans-macbook-pro");
  });
});

describe("pages capability (#clw_01M3J52H0H9WSH3GTSY87ZY351)", () => {
  const HOST = {
    endpoint: "http://garage.default.svc.cluster.local:3900",
    region: "garage",
    bucket: "pages",
    baseUrl: "https://pages.home.bstjohn.net",
    accessKeyId: "GKpages",
    secretAccessKey: "pages-secret",
  };

  afterEach(() => {
    mockConfig.PAGES_HOST = null;
  });

  it("is unavailable while the pages host is not configured", () => {
    mockConfig.PAGES_HOST = null;
    expect(isCapabilityAvailable("pages")).toBe(false);
    expect(availableCapabilities().map((c) => c.id)).not.toContain("pages");
    expect(validCapabilityIds(["pages"])).toEqual([]);
    expect(grantedEnvVars(["pages"])).toEqual({});
  });

  it("grants the six pages vars plus the publish script path when configured", () => {
    mockConfig.PAGES_HOST = HOST;
    expect(isCapabilityAvailable("pages")).toBe(true);
    const vars = grantedEnvVars(["pages"]);
    expect(vars).toEqual({
      CLAWS_PAGES_S3_ENDPOINT: HOST.endpoint,
      CLAWS_PAGES_S3_REGION: "garage",
      CLAWS_PAGES_S3_BUCKET: "pages",
      CLAWS_PAGES_BASE_URL: HOST.baseUrl,
      CLAWS_PAGES_S3_ACCESS_KEY_ID: "GKpages",
      CLAWS_PAGES_S3_SECRET_ACCESS_KEY: "pages-secret",
      CLAWS_PAGES_PUBLISH: expect.stringMatching(/[\\/]tools[\\/]pages-publish\.js$/),
    });
    expect(path.isAbsolute(vars.CLAWS_PAGES_PUBLISH!)).toBe(true);
  });

  it("strips every pages key from a session that was not granted it, and keeps secrets off argv", () => {
    mockConfig.PAGES_HOST = HOST;
    const { vars, stripKeys } = resolveCapabilityEnv([]);
    expect(vars).toEqual({});
    for (const key of ["CLAWS_PAGES_S3_ENDPOINT", "CLAWS_PAGES_S3_ACCESS_KEY_ID", "CLAWS_PAGES_S3_SECRET_ACCESS_KEY", "CLAWS_PAGES_PUBLISH"]) {
      expect(stripKeys).toContain(key);
    }
    const args = buildCapabilityEnvArgs(["pages"], "/tmp/s.env");
    expect(args.every((a) => !a.includes("pages-secret") && !a.includes("GKpages"))).toBe(true);
  });

  it("is an opt-in tools capability, grantable live on both backends and never a planner grant", () => {
    mockConfig.PAGES_HOST = HOST;
    const cap = CAPABILITIES.find((c) => c.id === "pages")!;
    expect(capabilityGroup(cap)).toBe("tools");
    expect(cap.implicit).toBeUndefined();
    expect(cap.headlessPlannerDiagnostic).toBeUndefined();
    expect(cap.description).not.toContain("=");
    for (const ids of Object.values(REPO_CAPABILITY_DEFAULTS)) expect(ids).not.toContain("pages");
    expect(withImplicitCapabilities([], ["St-John-Software/claws"])).not.toContain("pages");
    expect(resolveHeadlessPlannerCapabilityAccess(["pages"])).toBeNull();
    expect(liveGrantableCapabilities([], "k8s-pod").map((c) => c.id)).toContain("pages");
    expect(liveGrantableCapabilities(["pages"], "k8s-pod").map((c) => c.id)).not.toContain("pages");
  });
});

describe("print capability (#clw_01M498X85G9KCWHAX28RHG0F7Y)", () => {
  const SERVER = "cups.default.svc.cluster.local:631";

  afterEach(() => {
    mockConfig.PRINT_SERVER = "";
  });

  it("is unavailable while the print server is not configured", () => {
    mockConfig.PRINT_SERVER = "";
    expect(isCapabilityAvailable("print")).toBe(false);
    expect(availableCapabilities().map((c) => c.id)).not.toContain("print");
    expect(validCapabilityIds(["print"])).toEqual([]);
    expect(grantedEnvVars(["print"])).toEqual({});
  });

  it("grants exactly CUPS_SERVER and the print wrapper path when configured", () => {
    mockConfig.PRINT_SERVER = SERVER;
    expect(isCapabilityAvailable("print")).toBe(true);
    const vars = grantedEnvVars(["print"]);
    expect(vars).toEqual({
      CUPS_SERVER: SERVER,
      CLAWS_PRINT: expect.stringMatching(/[\\/]tools[\\/]print\.js$/),
    });
    expect(path.isAbsolute(vars.CLAWS_PRINT!)).toBe(true);
  });

  it("strips both print keys from a session that was not granted it", () => {
    mockConfig.PRINT_SERVER = SERVER;
    const { vars, stripKeys } = resolveCapabilityEnv([]);
    expect(vars).toEqual({});
    expect(stripKeys).toContain("CUPS_SERVER");
    expect(stripKeys).toContain("CLAWS_PRINT");
    expect(stripKeys).toContain("CLAWS_PRINT_SERVER");
    const args = buildCapabilityEnvArgs([], null);
    for (const key of ["CUPS_SERVER", "CLAWS_PRINT", "CLAWS_PRINT_SERVER"]) expect(args[args.indexOf(key) - 1]).toBe("-u");
  });

  it("is an opt-in tools capability, grantable live on both backends and never a planner grant", () => {
    mockConfig.PRINT_SERVER = SERVER;
    const cap = CAPABILITIES.find((c) => c.id === "print")!;
    expect(capabilityGroup(cap)).toBe("tools");
    expect(cap.implicit).toBeUndefined();
    expect(cap.headlessPlannerDiagnostic).toBeUndefined();
    expect(cap.description).not.toContain("=");
    for (const text of ["laserjet", "envy", "LaserJet 4050", "HP Envy 6100e", "A4", "--fit", "--status", "panel"]) {
      expect(cap.description).toContain(text);
    }
    for (const ids of Object.values(REPO_CAPABILITY_DEFAULTS)) expect(ids).not.toContain("print");
    expect(withImplicitCapabilities([], ["St-John-Software/claws"])).not.toContain("print");
    expect(resolveHeadlessPlannerCapabilityAccess(["print"])).toBeNull();
    expect(liveGrantableCapabilities([], "k8s-pod").map((c) => c.id)).toContain("print");
    expect(liveGrantableCapabilities(["print"], "k8s-pod").map((c) => c.id)).not.toContain("print");
  });
});
